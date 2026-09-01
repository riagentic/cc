/**
 * @module
 * Workspace — which project Claude Code runs in, and how. Persisted: these are
 * the choices a user makes once and expects to find again after a restart.
 *
 * The persisted half is the reason this cell probes the disk on boot: a project
 * remembered from last week is a *claim* about a directory, and directories are
 * deleted, renamed and unmounted between runs. A claim that is no longer true is
 * marked as such here rather than left to fail at spawn time with "Could not
 * start" and nothing to act on.
 */
import { cell, log, type MethodDraftMeta, schedule } from "aio";
import type {
  PermissionMode,
  Project,
  ProjectSettings,
} from "../type/claude.ts";
import { baseName } from "../lib/format.ts";
import { EFFORTS, MODELS, PERMISSION_MODES } from "../lib/stream.ts";

export type Theme = "system" | "dark" | "light";

type WorkspaceState = {
  projects: Project[];
  /** Empty string = nothing selected. A persisted field declared `null` drifts
   *  from its stored shape on every save, so the empty value is a real one. */
  activeId: string;
  /**
   * The seed a *new* project's settings start from, before the CLI's own
   * configuration for that directory is layered on top.
   *
   * How Claude Code runs is a per-project fact — see {@link ProjectSettings} —
   * so these are not "the current settings" and nothing reads them to decide
   * how to spawn. They exist so that adding a project produces sensible values
   * rather than empty ones, and so that projects remembered from before the
   * settings moved onto them have somewhere to inherit from.
   */
  defaults: ProjectSettings;
  /** Theme stays global: it is a fact about this window, not about a codebase. */
  theme: Theme;
  home: string;
  cliVersion: string;
  cliMissing: boolean;
  error: string | null;
};

/** What a project falls back to before anything has configured it. */
const FALLBACK: ProjectSettings = {
  model: "sonnet",
  permissionMode: "acceptEdits",
  effort: "",
  allowedDirs: [],
  skipPermissions: false,
};

/** A path as typed: trimmed, and without the trailing separator that would make
 *  `/srv/app` and `/srv/app/` two different projects. `/` keeps its slash. */
const tidy = (path: string): string =>
  path.trim().replace(/[/\\]+$/, "") || path.trim();

/* ── plain helpers ────────────────────────────────────────────────────────────
 *
 * Shared work lives here rather than in a method one method calls from another.
 * A nested same-cell call runs as its own transaction against *committed* state,
 * so it cannot see the write its caller is halfway through making — `bootstrap`
 * adding a project and then asking `refreshGit` about it read the list from
 * before the add. Plain functions take the draft and see it as it is.
 */

/** Re-read what the disk says about one project: does it still exist, and what
 *  branch is it on. Both are facts about *now*, not about when it was added. */
async function probe(s: WorkspaceState, id: string): Promise<void> {
  const io = await import("./claude.server.ts");
  const found = s.projects.find((p) => p.id === id);
  if (!found) return;
  const path = found.path;

  const exists = await io.isDirectory(path);
  const git = exists ? await io.gitInfo(path) : { branch: null, dirty: false };

  // Re-found after the awaits: the list can be edited while git runs.
  const target = s.projects.find((p) => p.id === id);
  if (!target) return;
  // Same reason as in `probeAll`: an unchanged value written anyway is a write,
  // and these two passes overlap whenever a switch lands during boot.
  if (target.missing !== !exists) target.missing = !exists;
  if (target.branch !== git.branch) target.branch = git.branch;
  if (target.dirty !== git.dirty) target.dirty = git.dirty;
  if (!exists) {
    log.warn("workspace", "project directory is gone", { path });
  }
}

/**
 * Existence for every project, git for the active one only.
 *
 * A `stat` per project is nothing; `git branch` + `git status` per project is
 * two subprocesses each, and only the active project's branch is ever shown.
 *
 * Gathered in full before the first write, for the reason spelled out on
 * {@link applyAddProject}: this runs during boot, and a write here followed by
 * an awaited `probe` made the whole pass one pinned transaction that a
 * concurrent add would abort — taking the honesty check for every *other*
 * project down with it.
 */
async function probeAll(s: WorkspaceState): Promise<void> {
  const io = await import("./claude.server.ts");
  const targets = s.projects.map((p) => ({ id: p.id, path: p.path }));
  const activeId = s.activeId;

  // ── gather ──
  const checks = await Promise.all(
    targets.map(async (t) => [t.id, await io.isDirectory(t.path)] as const),
  );
  const gone = new Map(checks);
  const active = targets.find((t) => t.id === activeId);
  const git = active && gone.get(activeId)
    ? await io.gitInfo(active.path)
    : null;

  // ── write ──
  for (const p of s.projects) {
    const exists = gone.get(p.id);
    if (exists === undefined) continue; // added while we were gathering
    // Written only when it actually changes. Every path that re-checks the disk
    // computes the same answer, so an unconditional assignment is a *write* of
    // an unchanged value — which is still a write, and still collides with the
    // other pass that just made it. Almost every probe finds nothing new.
    if (p.missing !== !exists) p.missing = !exists;
    if (!exists) {
      log.warn("workspace", "project directory is gone", { path: p.path });
    }
  }
  if (git && activeId) {
    const target = s.projects.find((p) => p.id === activeId);
    if (target) {
      if (target.branch !== git.branch) target.branch = git.branch;
      if (target.dirty !== git.dirty) target.dirty = git.dirty;
    }
  }
}

/**
 * Add a directory as a project and select it, or just select it when it is
 * already there. `false` when the path is not a usable directory.
 *
 * **Gather, then write.** Every filesystem answer this needs is collected
 * before the first write to `s`, and nothing is awaited after it. Interleaving
 * them made the whole call one transaction whose reads are pinned to entry, so
 * an add that landed while boot's own add was in flight was *refused* — and
 * the two race by construction, because `bootstrap` adds the launch directory
 * on a macrotask after the window is already on screen with an Add field in it.
 * Silently losing the project a user just typed is not an acceptable answer to
 * a race this app creates itself.
 */
async function applyAddProject(
  s: WorkspaceState,
  path: string,
): Promise<boolean> {
  const io = await import("./claude.server.ts");
  const typed = tidy(path);
  if (!typed) {
    s.error = "Enter a project directory.";
    log.warn("workspace", "empty project path rejected", {});
    return false;
  }
  const clean = io.resolvePath(typed);

  // ── gather ──
  const exists = await io.isDirectory(clean);
  const git = exists ? await io.gitInfo(clean) : { branch: null, dirty: false };
  // Where a terminal opened in this directory would start. Gathered here with
  // everything else, before the first write.
  const cli = exists
    ? await (await import("./catalog.server.ts")).readCliDefaults(clean)
    : { model: "", effort: "", permissionMode: "" };

  // ── write ──
  if (!exists) {
    s.error = `Not a directory: ${clean}`;
    log.warn("workspace", "project path is not a directory", { path: clean });
    return false;
  }
  s.error = null;

  // The list is read *here*, after the awaits, not before them: whichever add
  // committed while this one was gathering is part of the answer to "is this
  // project already known".
  const existing = s.projects.find((p) => p.path === clean);
  if (existing) {
    if (existing.branch !== git.branch) existing.branch = git.branch;
    if (existing.dirty !== git.dirty) existing.dirty = git.dirty;
    if (existing.missing) existing.missing = false;
    s.activeId = existing.id;
    return true;
  }
  const id = crypto.randomUUID();
  s.projects.push({
    id,
    path: clean,
    name: baseName(clean),
    branch: git.branch,
    dirty: git.dirty,
    missing: false,
    addedAt: Date.now(),
    // Layered: this app's seed, then whatever the CLI is configured to do for
    // this directory. Only values the settings files actually name win, so a
    // project with no configuration of its own inherits the seed rather than
    // an empty string that would reach the argv as `--model ""`.
    ...settingsFor(s.defaults, cli),
  });
  s.activeId = id;
  return true;
}

/** Merge what the CLI says about a directory over the app's seed, taking only
 *  values that are both present and ones we would accept from the UI. */
function settingsFor(
  seed: ProjectSettings,
  cli: { model: string; effort: string; permissionMode: string },
): ProjectSettings {
  return {
    model: MODELS.some((m) => m.id === cli.model) ? cli.model : seed.model,
    effort: EFFORTS.some((e) => e.id === cli.effort) ? cli.effort : seed.effort,
    permissionMode: PERMISSION_MODES.some((m) => m.id === cli.permissionMode)
      ? cli.permissionMode as PermissionMode
      : seed.permissionMode,
    // Never inherited from the CLI: an extra directory and a permission bypass
    // are grants this app's user makes here, deliberately, per project.
    allowedDirs: [...seed.allowedDirs],
    skipPermissions: seed.skipPermissions,
  };
}

/** The active project, as a draft that can be written to. `null` when nothing
 *  is selected — every setter is a no-op then rather than writing into space. */
const activeDraft = (s: WorkspaceState): Project | null =>
  s.projects.find((p) => p.id === s.activeId) ?? null;

/**
 * Tell the panels that read the project's *contents* — the file tree and the
 * configuration catalog — that they are now about somewhere else.
 *
 * Dynamic imports, so the dependency runs one way statically: both of those
 * cells read `activeProject()` from here. Fire-and-forget, because a slow disk
 * must not hold up the switch itself, and each cell reports its own failure on
 * its own page.
 *
 * `reproject`, not `refresh`: it is debounced, so clicking through three
 * projects to find the right one starts one walk of the last of them rather
 * than three walks of all of them. The session swap is not debounced — it is a
 * pure move between two slots, and the transcript must land immediately.
 */
function reprojected(id: string): void {
  // The conversation first: it is the thing on screen. `view()` resolves by key
  // so nothing renders the wrong transcript while this is in flight, but the
  // top level must still come to hold the project you are looking at.
  void import("./session.ts").then((m) => m.session.switchTo(id)).catch((e) => {
    log.warn("workspace", "could not switch the session", {
      error: e instanceof Error ? e.message : String(e),
    });
  });
  void import("./tree.ts").then((m) => m.tree.reproject()).catch(() => {});
  void import("./catalog.ts").then((m) => m.catalog.reproject()).catch(
    () => {},
  );
}

export const workspace = cell("workspace", {
  state: {
    projects: [] as Project[],
    activeId: "",
    defaults: { ...FALLBACK } as ProjectSettings,
    theme: "system" as Theme,
    home: "",
    cliVersion: "",
    cliMissing: false,
    error: null as string | null,
  },

  // Everything here is a user choice worth surviving a restart. `error` is not:
  // a stale error banner on boot is a lie about the current state.
  persist: { exclude: ["error"] },

  /**
   * v1 kept `model`, `permissionMode`, `effort`, `allowedDirs` and
   * `skipPermissions` at the top level: one set of settings for the whole app.
   * They belong to a project now.
   *
   * Without this, aio refuses to boot on any stored state written before the
   * move — which is every existing install. The old values are not discarded:
   * they become the seed for new projects *and* are written onto every stored
   * project that has none of its own, so an upgrade lands on exactly the
   * configuration the user last chose, now attached to each of their codebases.
   */
  version: 2,
  onMigrate(state, from) {
    if (from >= 2) return state;
    const old = state as unknown as Record<string, unknown>;
    const seed: ProjectSettings = {
      model: typeof old.model === "string" && old.model
        ? old.model
        : FALLBACK.model,
      permissionMode:
        typeof old.permissionMode === "string" && old.permissionMode
          ? old.permissionMode as PermissionMode
          : FALLBACK.permissionMode,
      // `??`: `""` is a real choice here ("leave the CLI's own effort alone"),
      // and `||` would silently upgrade it to something else.
      effort: typeof old.effort === "string" ? old.effort : FALLBACK.effort,
      allowedDirs: Array.isArray(old.allowedDirs)
        ? old.allowedDirs.filter((d): d is string => typeof d === "string")
        : [],
      skipPermissions: old.skipPermissions === true,
    };
    // The old top-level keys are DROPPED, not spread through. Carrying them
    // meant the migrated state still had five fields the shape no longer
    // declares, so they were persisted again and the very next boot refused
    // with the identical error — a migration that runs forever and fixes
    // nothing.
    const {
      model: _m,
      permissionMode: _p,
      effort: _e,
      allowedDirs: _a,
      skipPermissions: _s,
      ...rest
    } = old;
    return {
      ...(rest as unknown as typeof state),
      defaults: seed,
      projects: (state.projects ?? []).map((p) => ({ ...seed, ...p })),
    };
  },

  // Snapshot isolation (alpha52's default — dep/aio/docs/state/transactional-methods.md),
  // stated rather than inherited: these
  // methods shell out to git and stat the filesystem between writes, and a
  // half-added project must never be visible.
  transaction: true,

  // `onInit` runs *during* the boot sequence, before this cell's runtime can
  // accept a dispatch — so the discovery pass is queued for the next macrotask,
  // when the app is genuinely up. Calling it inline throws INIT_ERROR.
  onInit() {
    // A plain macrotask on purpose: `schedule.after`
    // (dep/aio/docs/state/scheduling.md) dispatches through this cell's
    // runtime, which is precisely what is not up yet.
    // Hook contract: dep/aio/docs/state/lifecycle.md#oninit-and-ondestroy.
    setTimeout(() => void workspace.bootstrap(), 0); // aiol-ok
  },

  methods: {
    /** Discover the environment once at boot: home, CLI version, whether every
     *  remembered project still exists, and — on a first run — the directory the
     *  app was launched from as project #1. */
    async bootstrap(s: WorkspaceState) {
      const io = await import("./claude.server.ts");
      s.home = io.homeDir();
      const version = await io.version();
      s.cliVersion = version ?? "";
      s.cliMissing = version === null;
      if (version === null) {
        log.error(
          "workspace",
          "Claude Code CLI not found — set CLAUDE_BIN or install it",
          {},
        );
      } else {
        log.info("workspace", "Claude Code CLI found", { version });
      }

      // The three steps below are *dispatched*, not inlined, and that is the
      // whole point: each stats the disk and shells out to git, and one
      // transaction spanning all of it is pinned to the state at entry — so a
      // user touching the project list while the app was still booting aborted
      // the entire boot with a conflict. A nested dispatch is a fresh, short
      // transaction that sees the previous step's committed result, which is
      // exactly what an orchestrator wants. (`aiol` flags the shape generically;
      // here the "stale read" it warns about is the behaviour being avoided.)

      // Every remembered path is re-checked before anything is selected: the
      // stored list is from the last run, and a folder that has since been
      // deleted must be visibly gone rather than silently unstartable.
      await workspace.refreshProjects(); // aiol-ok: orchestration, see above

      // A folder given on the command line is an explicit instruction: honour
      // it every boot, not only on a first run, and make it the active project.
      // With no argument this is the launch directory, which is what a desktop
      // launcher gives us.
      const requested = io.projectArg();
      if (requested.explicit || workspace.projects.length === 0) {
        await workspace.addProject(requested.path); // aiol-ok: orchestration
      }

      await workspace.selectUsable(); // aiol-ok: orchestration
    },

    /** Point the app at a project that is actually there.
     *
     *  Booting onto a folder that has been deleted opens the app on an error
     *  nobody asked for, when another perfectly good project is sitting in the
     *  same list. Only ever moves *away* from a missing project. */
    async selectUsable(s: WorkspaceState) {
      const active = s.projects.find((p) => p.id === s.activeId);
      if (active && !active.missing) return;
      const usable = s.projects.find((p) => !p.missing);
      if (!usable || usable.id === s.activeId) return;
      s.activeId = usable.id;
      await probe(s, usable.id);
      reprojected(usable.id);
    },

    /** Add a project directory (idempotent — re-adding just selects it).
     *
     *  `~/code/x` and `./sub` are resolved the same way the command-line
     *  argument is: a path typed into the field and a path passed on launch mean
     *  the same thing, and the field used to reject both outright. */
    async addProject(s: WorkspaceState, path: string) {
      if (await applyAddProject(s, path)) reprojected(s.activeId); // aiol-ok
    },

    /**
     * Drop every project whose folder is gone.
     *
     * A button, not a timer. Absence is a momentary observation about a
     * filesystem — an unmounted drive, a stopped container, a home that has not
     * been unlocked all look exactly like a deleted directory — so this is the
     * user saying "yes, those are really gone", which is the only signal that
     * can tell the difference.
     *
     * Only this app's own row is removed. Claude Code's transcripts for those
     * folders are its data, not ours, and are deleted from Storage with their
     * size in front of you.
     */
    removeMissingProjects(s: WorkspaceState) {
      const doomed = s.projects.filter((p) => p.missing).map((p) => p.id);
      if (doomed.length === 0) return;
      s.projects = s.projects.filter((p) => !p.missing);
      log.info("workspace", "removed projects whose folder is gone", {
        count: doomed.length,
      });
      if (doomed.includes(s.activeId)) {
        s.activeId = s.projects[0]?.id ?? "";
        reprojected(s.activeId); // aiol-ok: read of the line above, by design
      }
    },

    removeProject(s: WorkspaceState, id: string) {
      s.projects = s.projects.filter((p) => p.id !== id);
      if (s.activeId === id) {
        // Prefer a project that is actually there — selecting another dead one
        // would just move the same dead end along the list.
        s.activeId = (s.projects.find((p) =>
          !p.missing
        ) ?? s.projects[0])?.id ??
          "";
        reprojected(s.activeId); // aiol-ok: read of the line above, by design
      }
    },

    /**
     * Switch project.
     *
     * Deliberately synchronous, and the ONLY thing it writes is `activeId`.
     *
     * It used to `await probe(...)` before finishing — which made the whole
     * click one long transaction whose reads are pinned at entry, so anything
     * else that committed a change to `projects` while git was running (the
     * Refresh button, a failed spawn, the folder watchdog, a second click)
     * refused the commit and took the selection down with it. A click that is
     * silently rolled back is indistinguishable from a click that never
     * registered, which is exactly what "switching sometimes does nothing"
     * looks like from the outside.
     *
     * Re-reading the project's branch is a *refresh*, not part of switching, so
     * it is deferred to its own short transaction that runs after this commits.
     */
    select(
      s: WorkspaceState & Partial<MethodDraftMeta>,
      id: string,
    ) {
      if (!s.projects.some((p) => p.id === id) || s.activeId === id) return;
      s.activeId = id;
      reprojected(id);
      s.$do?.(schedule.next("probe-active", workspace.refreshGit.action()));
    },

    /** Re-read git and existence for the active project. */
    async refreshGit(s: WorkspaceState) {
      await probe(s, s.activeId);
    },

    /** Re-check every remembered project against the disk. Called from the
     *  Settings page, and whenever a spawn fails on a missing directory — the
     *  list is where the remedy is, so it must be honest by the time you get
     *  there. */
    async refreshProjects(s: WorkspaceState) {
      await probeAll(s);
    },

    /* Every setter below writes to the ACTIVE PROJECT, and to the seed for the
       next one. Two codebases rarely want the same model or the same permission
       mode, and a setting that silently followed you between them is how a
       bypass chosen for a sandbox ends up pointed at production. */

    setModel(s: WorkspaceState, model: string) {
      if (!MODELS.some((m) => m.id === model)) return;
      s.defaults.model = model;
      const p = activeDraft(s);
      if (p) p.model = model;
    },

    setEffort(s: WorkspaceState, effort: string) {
      if (!EFFORTS.some((e) => e.id === effort)) return;
      s.defaults.effort = effort;
      const p = activeDraft(s);
      if (p) p.effort = effort;
    },

    setPermissionMode(s: WorkspaceState, mode: string) {
      if (!PERMISSION_MODES.some((m) => m.id === mode)) return;
      s.defaults.permissionMode = mode as PermissionMode;
      const p = activeDraft(s);
      if (p) p.permissionMode = mode as PermissionMode;
    },

    setTheme(s: WorkspaceState, theme: Theme) {
      s.theme = theme;
    },

    /** Grant Claude Code another directory. Verified to exist before it is
     *  stored — a typo'd path would otherwise fail the whole spawn. */
    async addAllowedDir(s: WorkspaceState, path: string) {
      const io = await import("./claude.server.ts");
      const clean = tidy(path);
      if (!clean) {
        s.error = "Enter a directory to allow.";
        return;
      }
      const resolved = io.resolvePath(clean);
      if (!await io.isDirectory(resolved)) {
        s.error = `Not a directory: ${resolved}`;
        log.warn("workspace", "allowed dir is not a directory", {
          path: resolved,
        });
        return;
      }
      s.error = null;
      const p = activeDraft(s);
      if (!p) {
        s.error = "Pick a project first — a directory is granted to one.";
        return;
      }
      if (!p.allowedDirs.includes(resolved)) p.allowedDirs.push(resolved);
    },

    removeAllowedDir(s: WorkspaceState, path: string) {
      const p = activeDraft(s);
      if (p) p.allowedDirs = p.allowedDirs.filter((d) => d !== path);
    },

    /** Turn every permission check off (`--dangerously-skip-permissions`).
     *  Logged at warn on the way in: this is the one setting that lets the
     *  agent act anywhere on the machine. */
    setSkipPermissions(s: WorkspaceState, on: boolean) {
      s.defaults.skipPermissions = on;
      const p = activeDraft(s);
      if (p) p.skipPermissions = on;
      if (on) {
        // Named, because this is per project now: "permissions off" is a fact
        // about one codebase, and a log line that did not say which one would
        // be the least useful line in the file.
        log.warn("workspace", "permission checks disabled for new sessions", {
          project: p?.path ?? "(no project)",
        });
      } else {
        log.info("workspace", "permission checks re-enabled", {
          project: p?.path ?? "(no project)",
        });
      }
    },

    dismissError(s: WorkspaceState) {
      s.error = null;
    },
  },
});

/** The active project, or `null` — never store what you can derive.
 *
 *  A plain accessor rather than a `selectors:` entry on purpose: bound
 *  selectors are a server-side surface, while this reads the cell's reactive
 *  getters and so auto-tracks in the UI too. One definition, both sides. */
export const activeProject = (): Project | null =>
  workspace.projects.find((p) => p.id === workspace.activeId) ?? null;

/**
 * How Claude Code should be run for the project on screen.
 *
 * Falls back to the seed when nothing is selected, and — the reason this is a
 * function rather than a field read — when a project was remembered from before
 * settings moved onto projects. Such a row has no `model` of its own, and
 * spawning with `undefined` would reach the argv as the string `"undefined"`.
 */
export const activeSettings = (): ProjectSettings => {
  const p = activeProject();
  if (!p) return workspace.defaults;
  return {
    model: p.model || workspace.defaults.model,
    permissionMode: p.permissionMode || workspace.defaults.permissionMode,
    // `??`, not `||`: `""` is a real value here — it means "leave the CLI's own
    // effort setting alone" — and `||` would replace it with the seed.
    effort: p.effort ?? workspace.defaults.effort,
    allowedDirs: p.allowedDirs ?? [],
    skipPermissions: p.skipPermissions ?? false,
  };
};
