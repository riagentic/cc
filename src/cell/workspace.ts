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
  Pane,
  PermissionMode,
  Project,
  ProjectSettings,
} from "../type/claude.ts";
import { baseName } from "../lib/format.ts";
import { EFFORTS, MODELS, PERMISSION_MODES } from "../lib/stream.ts";
import { launches } from "../lib/launch.ts";

/**
 * The palette. `contrast` is a fourth choice rather than a toggle on top of
 * dark: it is a different set of values for the same tokens (harder edges,
 * more separation, no colour carrying meaning on its own), and expressing it
 * as a modifier would mean every token needing two definitions.
 */
export type Theme = "system" | "dark" | "light" | "contrast";

/** The palettes, in the order the picker offers them. Also the guard: a value
 *  that is not one of these is not a palette, whatever the control plane says. */
export const THEMES: { id: Theme; label: string; hint: string }[] = [
  { id: "system", label: "System", hint: "Follows your OS setting" },
  { id: "dark", label: "Dark", hint: "The default" },
  { id: "light", label: "Light", hint: "For a bright room" },
  {
    id: "contrast",
    label: "High contrast",
    hint: "Harder edges, stronger text",
  },
];

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
  /** Forget a project by itself once its folder is really gone. See the state
   *  declaration on the cell for what "really" means here. */
  autoForget: boolean;
  /** This session's undo buffer for removed projects. */
  forgotten: Project[];
  /**
   * What each project has open: its conversations and its shells, in the order
   * they were made.
   *
   * On the workspace rather than on the `Project` because a pane is not a
   * setting — it is not seeded from the CLI, not copied to a new project, and
   * not part of what "this project is configured like this" means.
   */
  panes: Record<string, Pane[]>;
  /** Which pane each project is showing. */
  activePane: Record<string, string>;
  /**
   * The folder the last add could not find, resolved.
   *
   * A field rather than something parsed back out of `error`: the offer to
   * create it has to name a real path, and reconstructing one from a sentence
   * is how a "Create it" button ends up making a directory called
   * "Not a directory: /home/x". Empty when the last add did not fail this way.
   */
  absentPath: string;
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
 *  `/srv/app` and `/srv/app/` two different projects. `/` keeps its slash.
 *
 *  `unknown`, not `string`: these paths arrive from the control plane, where the
 *  type signature is a promise nobody enforces — `am dispatch workspace:addProject`
 *  with no argument hands the method `undefined`, and a method that throws on
 *  the way in leaves the caller with a stack trace instead of the sentence that
 *  says what to type. Anything that is not a string is no path at all, and both
 *  callers already answer the empty string with exactly that sentence. */
const tidy = (path: unknown): string =>
  typeof path === "string"
    ? path.trim().replace(/[/\\]+$/, "") || path.trim()
    : "";

/* ── plain helpers ────────────────────────────────────────────────────────────
 *
 * Shared work lives here rather than in a method one method calls from another.
 * A nested same-cell call runs as its own transaction against *committed* state,
 * so it cannot see the write its caller is halfway through making — `bootstrap`
 * adding a project and then asking `refreshGit` about it read the list from
 * before the add. Plain functions take the draft and see it as it is.
 */

/**
 * Every project has at least one conversation.
 *
 * The first one's pane id is the *project* id, deliberately: that is the key
 * the session cell has always used, so a project remembered from before panes
 * existed keeps its conversation instead of silently starting a new one.
 */
function ensurePanes(s: WorkspaceState, projectId: string): Pane[] {
  const list = (s.panes[projectId] ??= []);
  if (!list.some((p) => p.kind === "session")) {
    list.unshift({
      id: projectId,
      kind: "session",
      title: "Chat",
      createdAt: Date.now(),
    });
  }
  s.activePane[projectId] ??= list[0].id;
  return list;
}

/**
 * The state as it is NOW, for a cell whose reads are otherwise pinned at method
 * entry.
 *
 * Every function below re-reads the disk and then compares what it found with
 * what the list says. Two of those passes overlap by construction — boot runs
 * one, the 20-second folder watch runs another, the Refresh button a third —
 * and under snapshot isolation the second one to commit is REFUSED, with
 * "`missing` was changed by another action while this method awaited". Which
 * means the honesty check for every project fails because another honesty
 * check just succeeded.
 *
 * `$live` is the sanctioned way out: reads through it are current by
 * construction so they never count as stale, and writes still join the atomic
 * commit (dep/aio/docs/state/transactional-methods.md §4).
 */
type Draft = WorkspaceState & Partial<MethodDraftMeta<WorkspaceState>>;
const now = (s: Draft): WorkspaceState => s.$live ?? s;

/** Re-read what the disk says about one project: does it still exist, and what
 *  branch is it on. Both are facts about *now*, not about when it was added. */
async function probe(s: Draft, id: string): Promise<void> {
  const io = await import("./claude.server.ts");
  const found = s.projects.find((p) => p.id === id);
  if (!found) return;
  const path = found.path;

  const exists = await io.isDirectory(path);
  const git = exists ? await io.gitInfo(path) : { branch: null, dirty: false };
  // Re-read on every probe. A `dev` task added five minutes ago should make the
  // button appear, not wait for somebody to guess that Refresh is the answer.
  const run = exists
    ? launches(await (await import("./catalog.server.ts")).readManifests(path))
    : { dev: null, prod: null };

  // Re-found after the awaits, in CURRENT state: the list can be edited while
  // git runs, and another probe may have written the same answer already.
  const target = now(s).projects.find((p) => p.id === id);
  if (!target) return;
  // Same reason as in `probeAll`: an unchanged value written anyway is a write,
  // and these two passes overlap whenever a switch lands during boot.
  if (target.missing !== !exists) {
    target.missing = !exists;
    // Warn on the *transition* to missing, not on every probe: a project the
    // user was told is gone and chose to keep would otherwise log a warning
    // every 20 seconds, forever.
    if (!exists) log.warn("workspace", "project directory is gone", { path });
  }
  if (target.branch !== git.branch) target.branch = git.branch;
  if (target.dirty !== git.dirty) target.dirty = git.dirty;
  // Compared before writing, like everything else here: this runs every twenty
  // seconds, and an unchanged value written anyway is a full-state broadcast.
  if (JSON.stringify(target.launch) !== JSON.stringify(run)) {
    target.launch = run;
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
async function probeAll(s: Draft): Promise<void> {
  const io = await import("./claude.server.ts");
  const targets = s.projects.map((p) => ({ id: p.id, path: p.path }));
  const activeId = s.activeId;

  const autoForget = s.autoForget;

  // ── gather ──
  const checks = await Promise.all(
    targets.map(async (t) => [t.id, await io.isDirectory(t.path)] as const),
  );
  const gone = new Map(checks);
  // For the ones that are not there, is their *parent* still there? That is
  // the whole difference between "this folder was deleted" and "the disk it
  // lived on is not mounted" — and it is the only question that makes
  // forgetting a project safe to do without asking.
  const parents = new Map(
    await Promise.all(
      targets
        .filter((t) => gone.get(t.id) === false)
        .map(async (t) =>
          [t.id, await io.isDirectory(parentOf(t.path))] as const
        ),
    ),
  );
  const active = targets.find((t) => t.id === activeId);
  const git = active && gone.get(activeId)
    ? await io.gitInfo(active.path)
    : null;
  // What each project says starts it. For EVERY project, not just the active
  // one: the dock draws these buttons on every tab, and a button that only
  // appears after you have clicked the tab is a button you never learn about.
  // Four small file reads per project, on a pass that already stats each one.
  const catalog = await import("./catalog.server.ts");
  const runs = new Map(
    await Promise.all(
      targets.map(async (t) =>
        [
          t.id,
          gone.get(t.id)
            ? launches(await catalog.readManifests(t.path))
            : { dev: null, prod: null },
        ] as const
      ),
    ),
  );

  // ── write ──
  //
  // Every write below goes through `$live`. Reads on a transactional method
  // are pinned at entry, and this function awaits the disk three times before
  // it writes — long enough that another action routinely touches `error` in
  // between, which the commit guard then refuses. Found by the fuzzer, twice.
  const live = now(s);
  for (const p of live.projects) {
    const exists = gone.get(p.id);
    if (exists === undefined) continue; // added while we were gathering
    // Compared before writing, like everything else on this pass: it runs
    // every twenty seconds, and an unchanged value written anyway is a
    // full-state broadcast to every client.
    const run = runs.get(p.id);
    if (run && JSON.stringify(p.launch) !== JSON.stringify(run)) {
      p.launch = run;
    }
    // Written only when it actually changes. Every path that re-checks the disk
    // computes the same answer, so an unconditional assignment is a *write* of
    // an unchanged value — which is still a write, and still collides with the
    // other pass that just made it. Almost every probe finds nothing new.
    // Warn on the transition to missing only — an already-missing project the
    // user kept must not re-warn on every probe (see `probeOne`).
    if (p.missing !== !exists) {
      p.missing = !exists;
      if (!exists) {
        log.warn("workspace", "project directory is gone", { path: p.path });
      }
    }
  }
  if (autoForget) {
    const doomed = live.projects.filter((p) =>
      gone.get(p.id) === false && parents.get(p.id) === true
    );
    if (doomed.length > 0) forget(live, doomed.map((p) => p.id));
  }
  if (git && activeId) {
    const target = live.projects.find((p) => p.id === activeId);
    if (target) {
      if (target.branch !== git.branch) target.branch = git.branch;
      if (target.dirty !== git.dirty) target.dirty = git.dirty;
    }
  }
}

/** The directory one level up. Lexical on purpose: it is asked about a path
 *  that no longer exists, so there is nothing to resolve. */
function parentOf(path: string): string {
  const cut = path.replace(/[/\\]+$/, "").lastIndexOf("/");
  return cut > 0 ? path.slice(0, cut) : "/";
}

/**
 * Remove projects, keeping them where the user can get them back.
 *
 * Every removal in this cell goes through here — the sweep, the button on a
 * tab, "Remove gone" — so there is exactly one place that decides what happens
 * to the selection afterwards, and exactly one undo buffer. Removing a project
 * never touches the folder or Claude Code's transcripts for it; it forgets a
 * row, which is why one click is enough and a confirmation would be theatre.
 */
/**
 * Drop the panes of projects nothing can reach any more.
 *
 * Panes outlive a removal on purpose: `forgotten` is an undo, and a project
 * brought back should come back with its conversations rather than as a bare
 * tab. But `forgotten` is capped and is not persisted, so a project that falls
 * off it — or that was removed in an earlier run — leaves its panes behind
 * with nothing able to reach them, in state that IS persisted.
 *
 * Which is why this is a sweep and not part of `forget`. Doing it there put a
 * read of `panes` into the read set of the long disk-walking pass that calls
 * it, and that read then collided with anything else touching panes — a
 * refused commit, and a project that was not removed after all. It failed one
 * run in eight before the two were separated. A removal should not depend on
 * the garbage collector's reads.
 */
function prunePanes(s: WorkspaceState): number {
  const reachable = new Set([
    ...s.projects.map((p) => p.id),
    ...s.forgotten.map((p) => p.id),
  ]);
  let dropped = 0;
  for (const id of Object.keys(s.panes)) {
    if (reachable.has(id)) continue;
    delete s.panes[id];
    delete s.activePane[id];
    dropped += 1;
  }
  return dropped;
}

function forget(s: WorkspaceState, ids: string[]): void {
  // Snapshotted, not referenced. `s.projects` is overwritten two lines down,
  // and a live draft reference taken before that silently resolves to the NEW
  // array — which the runtime refuses outright rather than let it read as a
  // project that is still there (cell-impl.ts `throwStaleCapture`).
  const doomed = s.projects.filter((p) => ids.includes(p.id)).map((p) => ({
    ...p,
    allowedDirs: [...p.allowedDirs],
  }));
  if (doomed.length === 0) return;
  // Newest first, and capped: this is an undo, not a history.
  s.forgotten = [...doomed, ...s.forgotten].slice(0, 20);
  s.projects = s.projects.filter((p) => !ids.includes(p.id));
  log.info("workspace", "projects forgotten", {
    count: doomed.length,
    paths: doomed.map((p) => p.path),
  });
  released(doomed.map((p) => p.id));
  if (ids.includes(s.activeId)) {
    // Prefer a project that is actually there — moving to another dead one
    // would just carry the dead end along the list.
    s.activeId = (s.projects.find((p) => !p.missing) ?? s.projects[0])?.id ??
      "";
    reprojected(s.activeId);
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
  s: Draft,
  path: string,
): Promise<string | null> {
  const io = await import("./claude.server.ts");
  const typed = tidy(path);
  if (!typed) {
    // Through `$live` like every other write here: the dynamic import above is
    // an await, so this draft's reads are already pinned to before it.
    now(s).error = "Enter a project directory.";
    now(s).absentPath = "";
    log.warn("workspace", "empty project path rejected", {});
    return null;
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
  // What the project says starts it. Read here with everything else, so the
  // buttons are right the moment the tab appears rather than after a refresh.
  const run = exists
    ? launches(
      await (await import("./catalog.server.ts")).readManifests(clean),
    )
    : { dev: null, prod: null };

  // ── write ──
  //
  // Every write below goes through `$live`. Reads on a transactional method
  // are pinned at entry, and this function awaits the disk three times before
  // it writes — long enough that another action routinely touches `error` in
  // between, which the commit guard then refuses. Found by the fuzzer, twice.
  const live0 = now(s);
  if (!exists) {
    live0.error = `There is no folder at ${clean}.`;
    // Named, so the page can offer to make it. A path somebody typed that does
    // not exist yet is nearly always a project they are about to start, and
    // "no such directory" with no way forward is the least useful answer to
    // that.
    live0.absentPath = clean;
    log.warn("workspace", "project path is not a directory", { path: clean });
    return null;
  }
  live0.error = null;
  live0.absentPath = "";

  // The list is read *here*, after the awaits, not before them: whichever add
  // committed while this one was gathering is part of the answer to "is this
  // project already known".
  //
  // …and through `$live`, for the same reason `probe` does. Reading the pinned
  // draft after an await is what the transaction guard refuses at commit time
  // — "s.projects was changed by another action while this method awaited" —
  // and these adds race by construction: boot adds the launch directory on a
  // macrotask, with an Add field already on screen. Gather-then-write kept the
  // *awaits* out of the write phase; it did not make the read current, so the
  // second of two concurrent adds was still refused. `$live` reads are current
  // by construction and its writes still join the atomic commit.
  const live = now(s);
  const existing = live.projects.find((p) => p.path === clean);
  if (existing) {
    if (existing.branch !== git.branch) existing.branch = git.branch;
    if (existing.dirty !== git.dirty) existing.dirty = git.dirty;
    if (existing.missing) existing.missing = false;
    live.activeId = existing.id;
    return existing.id;
  }
  const id = crypto.randomUUID();
  live.projects.push({
    id,
    path: clean,
    name: baseName(clean),
    branch: git.branch,
    dirty: git.dirty,
    missing: false,
    addedAt: Date.now(),
    launch: run,
    // Layered: this app's seed, then whatever the CLI is configured to do for
    // this directory. Only values the settings files actually name win, so a
    // project with no configuration of its own inherits the seed rather than
    // an empty string that would reach the argv as `--model ""`.
    ...settingsFor(live.defaults, cli),
  });
  live.activeId = id;
  return id;
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
/**
 * A project has left the list — tell every cell that keeps state keyed by it.
 *
 * Three separate leaks, all of them found by looking at a running app's state
 * rather than at the code: a removed project's `claude` kept running with
 * nothing left that could reach it; its local-engine configuration stayed in
 * persisted state forever; and its loops became rows that could never fire and
 * were not shown on any page, because the loops page only lists the *active*
 * project's.
 *
 * Fire-and-forget, and dynamic, for the same reason as {@link reprojected}: the
 * dependency runs one way statically, and a slow teardown must not hold up the
 * click.
 */
function released(ids: string[]): void {
  if (ids.length === 0) return;
  void import("./session.ts").then((m) => m.session.release(ids)).catch((e) => {
    log.warn("workspace", "could not end a removed project's session", {
      error: e instanceof Error ? e.message : String(e),
    });
  });
  void import("./local.ts").then((m) => m.local.forgetProjects(ids)).catch(
    () => {},
  );
  void import("./loops.ts").then((m) => m.loops.forgetProjects(ids)).catch(
    () => {},
  );
}

/**
 * One conversation has been closed — the same courtesy as {@link released}
 * gives a removed project, for a single tab.
 *
 * Closing a tab used to leave everything the conversation held: its background
 * programs still running, its undo history and its temp directory still there,
 * its engine settings and its transcript waiting in persisted state for
 * somebody to press the prune button on the Settings page. What was said is
 * written to the saved history first — closing a tab is not deleting the past.
 */
function paneReleased(id: string): void {
  void import("./local.ts").then((m) => m.local.closeChat(id)).catch(() => {});
}

/**
 * The same sweep, over the whole list — for state written before
 * {@link released} existed, and anything a crash orphaned.
 *
 * **Not run at boot, and that is the point.** The sweep asks "is this id still
 * a project", and at boot the answer is a moving target: the list is loaded,
 * then the launch directory is added, then a user who is already looking at
 * the window adds one of their own. Every placement of an automatic sweep in
 * that sequence deleted the configuration of a project that had just been
 * created — measured, repeatedly, as a test that failed one run in five.
 *
 * So it is a button instead. Removals going forward are exact ({@link
 * released}); this is for the leftovers, run by somebody who can see the list
 * it is being compared against.
 */
export function pruneUnknown(): void {
  void workspace.prunePanes();
  void import("./local.ts").then((m) => m.local.pruneUnknown()).catch(() => {});
  void import("./loops.ts").then((m) => m.loops.pruneUnknown()).catch(() => {});
}

/**
 * Which conversation a project is showing, read off the DRAFT.
 *
 * The selector version of this reads the committed cell, which is a render
 * behind while a method is still writing — and this is called immediately
 * after `activePane` is set, to tell the session cell which record to bring to
 * the top. A render behind here would switch to the previous conversation.
 */
function sessionKeyIn(s: WorkspaceState, projectId: string): string {
  const list = s.panes[projectId] ?? [];
  const chosen = s.activePane[projectId];
  const pane = list.find((p) => p.id === chosen);
  if (pane?.kind === "session") return pane.id;
  // Either a shell is showing, or there are no panes yet: the project's first
  // conversation is the answer, and its id is the project's own.
  return list.find((p) => p.kind === "session")?.id ?? projectId;
}

function reprojected(id: string, sessionKey = id): void {
  // The conversation first: it is the thing on screen. `view()` resolves by key
  // so nothing renders the wrong transcript while this is in flight, but the
  // top level must still come to hold the conversation you are looking at.
  void import("./session.ts").then((m) => m.session.switchTo(sessionKey)).catch(
    (e) => {
      log.warn("workspace", "could not switch the session", {
        error: e instanceof Error ? e.message : String(e),
      });
    },
  );
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
    /** See the type above — the path a "create it" offer would act on. */
    absentPath: "",
    /**
     * Drop a project's tab by itself once its folder is really gone.
     *
     * On by default, because a tab for a directory that no longer exists is a
     * dead row you cannot click and have to tidy up by hand — and the app
     * already knows. What makes it safe is the *test*, not the timer: a
     * project is forgotten only when its parent directory is still there
     * (see `vanished`), so an unmounted drive or a locked home keeps every
     * project it holds. And it is undoable — see `forgotten`.
     */
    autoForget: true,
    /**
     * Projects removed since the app started — by the sweep above, or by the
     * user clicking remove. The undo buffer, so removing a tab is a decision
     * you can take back rather than one you have to retype a path to reverse.
     *
     * Not persisted: an undo offer that survives a restart is an offer nobody
     * asked for about a decision they made last week.
     */
    forgotten: [] as Project[],
    /** What each project has open — see the type above. */
    panes: {} as Record<string, Pane[]>,
    /** Which pane each project is showing. */
    activePane: {} as Record<string, string>,
  },

  // Everything here is a user choice worth surviving a restart. `error` is not:
  // a stale error banner on boot is a lie about the current state. Neither is
  // `forgotten`: it is this session's undo buffer.
  persist: { exclude: ["error", "forgotten", "absentPath"] },

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
  version: 4,
  onMigrate(state, from) {
    // v4 gave every project a `launch` — what its own manifests say starts it.
    // A stored project has none, and aio refuses to boot on a shape it does
    // not recognise, so it is filled in here with "the project does not say".
    // The next probe reads the manifests and replaces it, seconds later.
    if (from >= 3) {
      const old = state as unknown as { projects?: unknown[] };
      return {
        ...(state as unknown as Record<string, unknown>),
        projects: (old.projects ?? []).map((p) => ({
          launch: { dev: null, prod: null },
          ...(p as Record<string, unknown>),
        })),
      } as typeof state;
    }
    // v3 added `autoForget` (and the unpersisted `forgotten`). Stored state
    // from v2 simply has no such key, and aio refuses to boot on a shape it
    // does not recognise — so it is filled in here rather than left to the
    // first write to discover.
    if (from >= 2) {
      const old = state as unknown as { projects?: unknown[] };
      return {
        autoForget: true,
        ...(state as unknown as Record<string, unknown>),
        projects: (old.projects ?? []).map((p) => ({
          launch: { dev: null, prod: null },
          ...(p as Record<string, unknown>),
        })),
      } as typeof state;
    }
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
      autoForget: true,
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
    async bootstrap(_s: WorkspaceState) {
      const io = await import("./claude.server.ts");
      const version = await io.version();
      // Written through a SYNC method, not through this method's own draft.
      // Boot is the longest-running method in the app — a CLI version probe, a
      // stat per project, git — and a draft held across all of that publishes
      // the state boot ENTERED with when it finally commits, which is an empty
      // project list. A project the user adds while the window is already up
      // and booting simply disappeared. (The same shape as `local.detect`; see
      // its note.)
      await workspace.setEnvironment(io.homeDir(), version); // aiol-ok

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

    /** What boot learned about the machine. Sync, so it commits on its own
     *  rather than riding on the end of the longest method in the app. */
    setEnvironment(s: WorkspaceState, home: string, version: string | null) {
      s.home = home;
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

    /** Add a project directory (idempotent — re-adding just selects it), and
     *  answer with its id — `null` if the path was refused.
     *
     *  The id is returned rather than looked up afterwards because the caller
     *  may be a browser: a reply crosses the bridge, a list read right after
     *  the call may still be the list from before it.
     *
     *  `~/code/x` and `./sub` are resolved the same way the command-line
     *  argument is: a path typed into the field and a path passed on launch mean
     *  the same thing, and the field used to reject both outright. */
    async addProject(s: WorkspaceState, path: string): Promise<string | null> {
      const id = await applyAddProject(s, path);
      if (id !== null) reprojected(s.activeId); // aiol-ok
      return id;
    },

    /**
     * Make the folder, then add it.
     *
     * The offer that follows a failed add. Deliberately a separate method
     * rather than a flag on `addProject`: creating a directory is a change to
     * the user's disk, and it happens because somebody read the path in the
     * message and pressed the button — never as a side effect of a typo.
     */
    async createProject(s: Draft, path: unknown): Promise<string | null> {
      const wanted = tidy(path);
      if (!wanted) {
        // `$live` even here, with no await in front of it: an async method
        // commits in a later microtask whatever it does, so its reads are
        // pinned from the moment it is entered. The fuzzer proved it.
        const why = "Enter a project directory.";
        now(s).error = why;
        return why;
      }
      const io = await import("./claude.server.ts");
      const failed = await io.makeDir(wanted);
      if (failed !== null) {
        // Through `$live`: reads here are pinned at method entry, and making a
        // directory takes long enough that another action routinely writes
        // `error` in between — which the commit guard then refuses. The
        // fuzzer found this one.
        const why = `Could not create it: ${failed}`;
        now(s).error = why;
        log.warn("workspace", "could not create a project folder", {
          path: wanted,
          error: failed,
        });
        return why;
      }
      log.info("workspace", "created a project folder", { path: wanted });
      // The outcome is RETURNED, not left for the caller to read off the cell.
      // A caller in the browser reads state that the patch for this method may
      // not have reached yet, so it would be reading the previous answer; the
      // return value crosses the bridge with the call.
      if (await applyAddProject(s, wanted) !== null) {
        reprojected(now(s).activeId); // aiol-ok
      }
      return null;
    },

    /**
     * Move a project to another position in the list.
     *
     * The order is the user's, not the order they happened to add things in:
     * it decides which tab Ctrl+1 reaches, and the tabs somebody uses every
     * day belong at the top. Persisted with everything else here, because an
     * order that resets on restart is not an order.
     *
     * Both arguments are checked rather than trusted — this is reachable from
     * the control plane, where an index is whatever the caller typed.
     */
    moveProject(s: WorkspaceState, id: unknown, to: unknown) {
      if (typeof id !== "string" || typeof to !== "number") return;
      const from = s.projects.findIndex((p) => p.id === id);
      if (from < 0) return;
      // Clamped, not rejected: a drag to the end of the list is a real
      // gesture, and it arrives as an index one past the last row.
      const target = Math.max(
        0,
        Math.min(s.projects.length - 1, Math.trunc(to)),
      );
      if (target === from) return;
      const [moved] = s.projects.splice(from, 1);
      s.projects.splice(target, 0, moved);
    },

    /**
     * Add a conversation or a shell to a project, and show it.
     *
     * Returns the new pane's id, which is also the session key or the terminal
     * id — one identifier, so nothing has to map between two.
     */
    addPane(
      s: WorkspaceState,
      projectId: unknown,
      kind: unknown,
      // Minted by the caller when the thing the pane points at has to exist
      // first — see the dock's `openConsole`.
      id?: unknown,
      /** For a launcher's console: what it runs. See `Pane.command`. */
      command?: unknown,
    ): string {
      if (kind !== "session" && kind !== "console") return "";
      const pid = typeof projectId === "string" && projectId
        ? projectId
        : s.activeId;
      if (!s.projects.some((p) => p.id === pid)) return "";

      const list = ensurePanes(s, pid);
      const nth = list.filter((p) => p.kind === kind).length + 1;
      const pane: Pane = {
        // The first session keeps the project id (see `ensurePanes`); every
        // other pane gets one of its own.
        id: typeof id === "string" && id !== "" ? id : crypto.randomUUID(),
        kind,
        title: kind === "session"
          ? `Chat ${nth}`
          : nth === 1
          ? "Console"
          : `Console ${nth}`,
        createdAt: Date.now(),
      };
      // Set, never assigned `undefined`. `panes` is persisted, and JSON has no
      // `undefined` — a key written with that value comes back missing, which
      // the persist check calls out as state that would reload WRONG. An
      // optional field that is absent is the same thing said in a way that
      // survives a round trip.
      if (typeof command === "string" && command !== "") {
        pane.command = command;
      }
      list.push(pane);
      s.activePane[pid] = pane.id;
      // Adding to a project is choosing it, exactly as clicking one of its
      // rows is — `selectPane` has always done this. Without it the dock's "+"
      // buttons put a conversation in one project while you went on looking at
      // another, and anything that acts on "the pane you are on" acted on the
      // wrong one.
      s.activeId = pid;
      if (kind === "session") {
        // A new conversation is empty until something switches to it — the
        // session cell keeps one record at the top level and parks the rest.
        reprojected(pid, pane.id); // aiol-ok: orchestration, after the write
      }
      return pane.id;
    },

    /** Show a pane. The project it belongs to becomes the active one, because
     *  clicking a child row is a way of choosing its parent too. */
    selectPane(s: WorkspaceState, id: unknown) {
      if (typeof id !== "string" || id === "") return;
      for (const [pid, list] of Object.entries(s.panes)) {
        if (!list.some((p) => p.id === id)) continue;
        s.activePane[pid] = id;
        // The session cell is told which conversation to bring to the top even
        // when the project has not changed — switching between two chats in
        // one project is the whole point of a pane.
        reprojected(pid, sessionKeyIn(s, pid)); // aiol-ok: after the write
        s.activeId = pid;
        return;
      }
      // Not a pane on record — but that does not mean it is not a pane.
      //
      // `panes` is written lazily: a project nobody has opened a second
      // conversation in has no record at all, and `panesOf` reports its single
      // conversation under the PROJECT's id, which is what that conversation's
      // id has always been. So the dock offers a row this loop cannot find,
      // and selecting it did nothing at all — which is how keyboard walking
      // the dock stopped dead at the first untouched project.
      if (!s.projects.some((p) => p.id === id)) return;
      ensurePanes(s, id);
      s.activePane[id] = id;
      reprojected(id, sessionKeyIn(s, id)); // aiol-ok: after the write
      s.activeId = id;
    },

    /**
     * Close a pane.
     *
     * The last conversation cannot be closed: a project with no conversation
     * is a project whose Chat page has nothing to show and no way to get one
     * back. Shells can all be closed — an empty Console page offers to open
     * one, which a Chat page cannot honestly do.
     */
    removePane(s: WorkspaceState, id: unknown) {
      if (typeof id !== "string") return;
      for (const [pid, list] of Object.entries(s.panes)) {
        const at = list.findIndex((p) => p.id === id);
        if (at < 0) continue;
        if (
          list[at].kind === "session" &&
          list.filter((p) => p.kind === "session").length === 1
        ) return;
        list.splice(at, 1);
        if (s.activePane[pid] === id) {
          s.activePane[pid] = (list[at] ?? list[at - 1] ?? list[0])?.id ?? "";
        }
        paneReleased(id);
        return;
      }
    },

    /** Rename a pane. Long names are cut rather than refused: a title is a
     *  label, and the tab has a fixed width whatever it says. */
    renamePane(s: WorkspaceState, id: unknown, title: unknown) {
      if (typeof id !== "string" || typeof title !== "string") return;
      const clean = title.trim().slice(0, 40);
      if (clean === "") return;
      for (const list of Object.values(s.panes)) {
        const pane = list.find((p) => p.id === id);
        if (pane) {
          pane.title = clean;
          return;
        }
      }
    },

    /** The panes half of the leftovers sweep — see {@link prunePanes} and the
     *  button in Settings that runs it. */
    prunePanes(s: WorkspaceState) {
      // Same reason as the local cell's sweep: an EMPTY project list means the
      // workspace has not settled, not that there are no projects.
      if (s.projects.length === 0) return;
      const dropped = prunePanes(s);
      if (dropped > 0) {
        log.info("workspace", "dropped panes for unknown projects", {
          dropped,
        });
      }
    },

    /** Drop the offer to create a folder — the user typed something else, or
     *  changed their mind. */
    forgetAbsent(s: WorkspaceState) {
      s.absentPath = "";
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
      forget(s, s.projects.filter((p) => p.missing).map((p) => p.id)); // aiol-ok
    },

    removeProject(s: WorkspaceState, id: string) {
      forget(s, [id]); // aiol-ok: `forget` owns the re-selection, by design
    },

    /**
     * Put back everything removed since the app started.
     *
     * The reason a tab can be closed with one click. Order is restored too —
     * a project goes back where it was, not onto the end — because the dock is
     * a list people navigate by position.
     */
    undoForget(s: WorkspaceState) {
      if (s.forgotten.length === 0) return;
      const back = [...s.forgotten].reverse();
      s.forgotten = [];
      const known = new Set(s.projects.map((p) => p.path));
      for (const p of back) {
        if (known.has(p.path)) continue;
        known.add(p.path);
        s.projects.push(p);
      }
      s.projects.sort((a, b) => a.addedAt - b.addedAt);
      if (!s.projects.some((p) => p.id === s.activeId)) {
        s.activeId = (s.projects.find((p) =>
          !p.missing
        ) ?? s.projects[0])?.id ??
          "";
        reprojected(s.activeId); // aiol-ok: read of the line above, by design
      }
      log.info("workspace", "forgotten projects restored", {
        count: back.length,
      });
    },

    /** Stop offering the undo — the removals are accepted. */
    clearForgotten(s: WorkspaceState) {
      s.forgotten = [];
    },

    /**
     * Open a file with the desktop's own opener.
     *
     * On `workspace` because it is the cell that already owns the process side
     * of the app, and because every page that needs it — Skills, Commands,
     * Hooks, MCP, Memory, Tree — reads a different cell. A failure lands in the
     * same error banner as everything else here rather than in a console.
     */
    /**
     * Hand a path to the desktop to open.
     *
     * The reason is *returned* as well as stored: the callers are spread
     * across the app — a row in the tree, a path inside an answer — and the
     * error banner is on the Settings page. A caller that is nowhere near a
     * banner can say so where the click happened.
     */
    async openPath(s: WorkspaceState, path: string): Promise<string | null> {
      const io = await import("./claude.server.ts");
      const why = await io.openPath(path);
      s.error = why;
      return why;
    },

    /** Whether a project whose folder is really gone drops out by itself. */
    setAutoForget(s: WorkspaceState, on: boolean) {
      s.autoForget = on === true;
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
      reprojected(id, sessionKeyIn(s, id));
      s.$do?.(schedule.next("probe-active", workspace.refreshGit.action()));
    },

    /** Re-read git and existence for the active project. */
    async refreshGit(s: Draft) {
      await probe(s, s.activeId);
    },

    /** Re-check every remembered project against the disk. Called from the
     *  Settings page, and whenever a spawn fails on a missing directory — the
     *  list is where the remedy is, so it must be honest by the time you get
     *  there. */
    async refreshProjects(s: Draft) {
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

    setTheme(s: WorkspaceState, theme: string) {
      // Guarded, like every other setter here. This one arrives from the
      // control plane too, and a palette that is not a palette reaches CSS as
      // an attribute nothing matches — leaving the window in whichever theme
      // the media query happens to pick, with a stored value nothing can undo.
      if (!THEMES.some((t) => t.id === theme)) return;
      s.theme = theme as Theme;
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

    /**
     * Save an exported transcript, and answer with the path it landed on.
     *
     * The answer is returned rather than written to state for the same reason
     * `createProject` returns its outcome: the caller is a button in a
     * transcript, and reading a cell straight after dispatching to it reads
     * the previous answer on a browser client.
     */
    async saveExport(
      s: Draft,
      name: unknown,
      text: unknown,
    ): Promise<{ path: string | null; error: string | null }> {
      if (typeof name !== "string" || typeof text !== "string") {
        return { path: null, error: "Nothing to save." };
      }
      const io = await import("./claude.server.ts");
      const done = await io.writeExport(name, text);
      if (done.error !== null) {
        now(s).error = `Could not save it: ${done.error}`;
        log.warn("workspace", "could not write an export", {
          error: done.error,
        });
      } else {
        log.info("workspace", "wrote an export", { path: done.path });
      }
      return done;
    },

    dismissError(s: WorkspaceState) {
      s.error = null;
      // The offer to create a folder belongs to the message that named it.
      // Leaving it behind would be an orphan button about a path nothing on
      // screen still mentions.
      s.absentPath = "";
    },
  },
});

/** The active project, or `null` — never store what you can derive.
 *
 *  A plain accessor rather than a `selectors:` entry on purpose: bound
 *  selectors are a server-side surface, while this reads the cell's reactive
 *  getters and so auto-tracks in the UI too. One definition, both sides. */
/** Projects removed since the app started, newest first — the undo offer. */
export const forgottenProjects = (): Project[] => workspace.forgotten;

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

/** A project's panes, with its first conversation guaranteed. Read-only: the
 *  `ensurePanes` that creates one lives in a method, because a selector that
 *  writes is a selector that fires on render. */
export const panesOf = (projectId?: string): Pane[] => {
  const pid = projectId ?? workspace.activeId;
  const list = workspace.panes[pid] ?? [];
  // A project from before panes existed, or one whose panes have not been
  // written yet, still has exactly one conversation — under the project's own
  // id, which is the key the session cell has always used.
  if (!list.some((p) => p.kind === "session") && pid) {
    return [
      { id: pid, kind: "session", title: "Chat", createdAt: 0 },
      ...list,
    ];
  }
  return list;
};

/** The pane a project is showing, or its first. */
export const activePane = (projectId?: string): Pane | null => {
  const pid = projectId ?? workspace.activeId;
  const list = panesOf(pid);
  if (list.length === 0) return null;
  const chosen = workspace.activePane[pid];
  return list.find((p) => p.id === chosen) ?? list[0];
};

/**
 * The session key the Chat page is showing.
 *
 * The active pane when it is a conversation; otherwise the project's first
 * one — looking at a shell does not change which conversation Chat is about.
 */
export const activeSessionKey = (projectId?: string): string => {
  const pid = projectId ?? workspace.activeId;
  const pane = activePane(pid);
  if (pane?.kind === "session") return pane.id;
  return panesOf(pid).find((p) => p.kind === "session")?.id ?? pid;
};

/** Which project a pane belongs to, or `""`. Used by the session cell, which
 *  is handed a key and has to find the directory to spawn in. */
export const projectOfPane = (paneId: string): string => {
  for (const [pid, list] of Object.entries(workspace.panes)) {
    if (list.some((p) => p.id === paneId)) return pid;
  }
  // The first conversation's id IS the project id — see `ensurePanes`.
  return workspace.projects.some((p) => p.id === paneId) ? paneId : "";
};
