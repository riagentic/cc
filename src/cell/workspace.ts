/**
 * @module
 * Workspace — which project Claude Code runs in, and how. Persisted: these are
 * the choices a user makes once and expects to find again after a restart.
 */
import { cell, log } from "aio";
import type { PermissionMode, Project } from "../type/claude.ts";
import { baseName } from "../lib/format.ts";
import { MODELS, PERMISSION_MODES } from "../lib/stream.ts";

export type Theme = "system" | "dark" | "light";

type WorkspaceState = {
  projects: Project[];
  /** Empty string = nothing selected. A persisted field declared `null` drifts
   *  from its stored shape on every save, so the empty value is a real one. */
  activeId: string;
  model: string;
  permissionMode: PermissionMode;
  theme: Theme;
  home: string;
  cliVersion: string;
  cliMissing: boolean;
  /** Extra folders Claude Code may read and write, beyond the project itself
   *  (`--add-dir`). The narrow alternative to switching permissions off. */
  allowedDirs: string[];
  /** Run the CLI with `--dangerously-skip-permissions`: no checks at all. */
  skipPermissions: boolean;
  error: string | null;
};

/** A path as typed: trimmed, and without the trailing separator that would make
 *  `/srv/app` and `/srv/app/` two different projects. `/` keeps its slash. */
const tidy = (path: string): string =>
  path.trim().replace(/[/\\]+$/, "") || path.trim();

export const workspace = cell("workspace", {
  state: {
    projects: [] as Project[],
    activeId: "",
    model: "sonnet",
    permissionMode: "acceptEdits" as PermissionMode,
    theme: "system" as Theme,
    home: "",
    cliVersion: "",
    cliMissing: false,
    allowedDirs: [] as string[],
    skipPermissions: false,
    error: null as string | null,
  },

  // Everything here is a user choice worth surviving a restart. `error` is not:
  // a stale error banner on boot is a lie about the current state.
  persist: { exclude: ["error"] },

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
    /** Discover the environment once at boot: home, CLI version, and — on a
     *  first run — the directory the app was launched from as project #1. */
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

      // A folder given on the command line is an explicit instruction: honour
      // it every boot, not only on a first run, and make it the active project.
      // With no argument this is the launch directory, which is what a desktop
      // launcher gives us.
      const requested = io.projectArg();
      if (requested.explicit || s.projects.length === 0) {
        await workspace.addProject(requested.path);
      } else {
        await workspace.refreshGit();
      }
    },

    /** Add a project directory (idempotent — re-adding just selects it).
     *
     *  `~/code/x` and `./sub` are resolved the same way the command-line
     *  argument is: a path typed into the field and a path passed on launch mean
     *  the same thing, and the field used to reject both outright. */
    async addProject(s: WorkspaceState, path: string) {
      const io = await import("./claude.server.ts");
      const typed = tidy(path);
      if (!typed) {
        s.error = "Enter a project directory.";
        log.warn("workspace", "empty project path rejected", {});
        return;
      }
      const clean = io.resolvePath(typed);
      if (!await io.isDirectory(clean)) {
        s.error = `Not a directory: ${clean}`;
        log.warn("workspace", "project path is not a directory", {
          path: clean,
        });
        return;
      }
      s.error = null;

      const existing = s.projects.find((p) => p.path === clean);
      if (existing) {
        s.activeId = existing.id;
        await workspace.refreshGit();
        return;
      }
      const git = await io.gitInfo(clean);
      s.projects.push({
        id: crypto.randomUUID(),
        path: clean,
        name: baseName(clean),
        branch: git.branch,
        dirty: git.dirty,
        addedAt: Date.now(),
      });
      s.activeId = s.projects[s.projects.length - 1].id;
    },

    removeProject(s: WorkspaceState, id: string) {
      s.projects = s.projects.filter((p) => p.id !== id);
      if (s.activeId === id) s.activeId = s.projects[0]?.id ?? "";
    },

    async select(s: WorkspaceState, id: string) {
      if (!s.projects.some((p) => p.id === id) || s.activeId === id) return;
      s.activeId = id;
      await workspace.refreshGit();
    },

    /** Re-read git for the active project — cheap, and the branch is a fact
     *  about *now*, not about when the project was added. */
    async refreshGit(s: WorkspaceState) {
      const project = s.projects.find((p) => p.id === s.activeId);
      if (!project) return;
      const io = await import("./claude.server.ts");
      const git = await io.gitInfo(project.path);
      const target = s.projects.find((p) => p.id === project.id);
      if (!target) return;
      target.branch = git.branch;
      target.dirty = git.dirty;
    },

    setModel(s: WorkspaceState, model: string) {
      if (MODELS.some((m) => m.id === model)) s.model = model;
    },

    setPermissionMode(s: WorkspaceState, mode: string) {
      if (PERMISSION_MODES.some((m) => m.id === mode)) {
        s.permissionMode = mode as PermissionMode;
      }
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
      if (!s.allowedDirs.includes(resolved)) s.allowedDirs.push(resolved);
    },

    removeAllowedDir(s: WorkspaceState, path: string) {
      s.allowedDirs = s.allowedDirs.filter((d) => d !== path);
    },

    /** Turn every permission check off (`--dangerously-skip-permissions`).
     *  Logged at warn on the way in: this is the one setting that lets the
     *  agent act anywhere on the machine. */
    setSkipPermissions(s: WorkspaceState, on: boolean) {
      s.skipPermissions = on;
      if (on) {
        log.warn(
          "workspace",
          "permission checks disabled for new sessions",
          {},
        );
      } else {
        log.info("workspace", "permission checks re-enabled", {});
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
