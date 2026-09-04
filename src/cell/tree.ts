/**
 * @module
 * Tree — the active project's files, and what this session has done to them.
 *
 * A file browser on its own would be the least interesting panel in this app;
 * every editor has one. What makes it worth a tab is the overlay: every path
 * the running session has read or written is marked, live, from the tool calls
 * it actually made. "Which files has it touched" is the first question anybody
 * asks about an agent working in their repo, and until now the only way to
 * answer it was to scroll the transcript.
 *
 * The tree is a flat, depth-tagged list and only expanded directories are
 * walked, so the panel costs what the user opened and nothing more.
 */
import { cell, log, type MethodDraftMeta, schedule } from "aio";
import type { Touch, TreeNode } from "../type/claude.ts";
import { view } from "./session.ts";
import { activeProject } from "./workspace.ts";

/* ── plain helpers ────────────────────────────────────────────────────────────
 *
 * Same reason as in `jobs.ts` and `workspace.ts`: a nested same-cell call runs
 * against *committed* state, so `toggle` writing `open` and then dispatching
 * `refresh` would have the re-read use the expansion set from *before* the
 * toggle — a folder that refuses to open on the first click. A plain function
 * takes the draft.
 */

/** Re-read the tree for the active project into the draft.
 *
 *  The walk is I/O, so another switch can land while it runs. The project it
 *  was *of* is therefore checked again before the result is kept: a slower read
 *  of the project you just left must never overwrite the one you are on. */
async function read(s: TreeState): Promise<void> {
  const project = activeProject();
  if (!project) {
    s.root = "";
    s.nodes = [];
    s.error = null;
    return;
  }
  if (project.path !== s.root) {
    s.open = [];
    s.selected = "";
    s.preview = { ...NO_PREVIEW };
  }
  s.root = project.path;
  s.loading = true;
  try {
    const io = await import("./catalog.server.ts");
    const nodes = await io.readTree(project.path, s.open);
    // What git thinks changed, gathered with the tree rather than after it:
    // both describe the same moment, and a file list where the marks are one
    // walk behind the names is worse than one with no marks.
    const claude = await import("./claude.server.ts");
    const changed = await claude.gitChanged(project.path);
    // `activeProject()` is a live read of another cell, which is the point —
    // it answers "is this still the project on screen *now*".
    if (activeProject()?.path !== project.path) return;
    s.nodes = nodes;
    s.modified = changed.modified;
    s.untracked = changed.untracked;
    s.scannedAt = Date.now();
    s.error = null;
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    s.error = reason;
    log.warn("tree", "read failed", { error: reason });
  } finally {
    s.loading = false;
  }
}

type TreeState = {
  /** The directory the current listing is of. Kept so a project switch is
   *  detectable: a tree of the old project under the new one's name is the
   *  kind of quiet lie this app exists to avoid. */
  root: string;
  nodes: TreeNode[];
  /** Absolute paths git reports as changed, and as not yet tracked. Two lists
   *  because they mean different things to somebody deciding what to review:
   *  one has a previous version to compare against and the other does not. */
  modified: string[];
  untracked: string[];
  /** Absolute paths of the expanded directories. The client sends these back,
   *  which is what keeps the server free of per-connection tree state. */
  open: string[];
  /** The file being previewed, or `""`. */
  selected: string;
  preview: { text: string; bytes: number; truncated: boolean; error: string };
  /**
   * The committed version of the previewed file, or `""` when there is not one
   * — not a repository, never committed, or simply unchanged.
   *
   * Read alongside the preview rather than on demand: the question "what did I
   * change here" is asked about the file you have just opened, and a second
   * round trip to answer it would make the diff arrive after the reader had
   * already started reading the wrong thing.
   */
  previewHead: string;
  loading: boolean;
  scannedAt: number;
  error: string | null;
};

const NO_PREVIEW = { text: "", bytes: 0, truncated: false, error: "" };

export const tree = cell("tree", {
  // The expanded set could be persisted, but the paths it names may not exist
  // next run — and restoring a tree that half-fails to open is worse than
  // opening at the root.
  persist: "none",

  // Live reads and incremental commits, like the session cell and for the same
  // reason: two of these can be in flight at once — a project switch while a
  // deep folder is still being walked — and under snapshot isolation the second
  // one's commit is *refused*, leaving the panel showing the project you just
  // left. Here each write publishes as it happens and the staleness guard in
  // `read` decides which result is the right one.
  transaction: false,

  state: {
    root: "",
    nodes: [] as TreeNode[],
    /** Absolute paths git reports as changed, and as not yet tracked. Two
     *  lists because they mean different things to somebody deciding what to
     *  review: one has a previous version to compare against. */
    modified: [] as string[],
    untracked: [] as string[],
    open: [] as string[],
    selected: "",
    preview: { ...NO_PREVIEW },
    previewHead: "",
    loading: false,
    scannedAt: 0,
    error: null as string | null,
  },

  onInit() {
    // The first read has to be scheduled here, not left to the first project
    // *change*: on a normal boot the persisted project is already the right
    // one, so nothing changes and nothing would ever trigger a read — the Tree
    // page opened empty on every launch that did not switch project. The
    // macrotask is the usual one: the cell's runtime is not up during `onInit`.
    setTimeout(() => void tree.reproject(), 0); // aiol-ok
  },

  methods: {
    /** Re-read the tree for the active project.
     *
     *  Switching project resets the expanded set and the preview: they name
     *  paths under a directory that is no longer the subject. */
    async refresh(s: TreeState) {
      await read(s);
    },

    /**
     * The project changed — re-read, shortly.
     *
     * Debounced rather than immediate because switching project is something
     * users do in bursts (three tabs to find the right one), and each switch
     * would otherwise start a full walk that the next one makes pointless.
     * Same schedule id, so only the last one survives.
     */
    reproject(s: TreeState & Partial<MethodDraftMeta>) {
      s.$do?.(schedule.after("tree-reproject", 60, tree.refresh.action()));
    },

    /** Expand or collapse a directory, then re-read.
     *
     *  Collapsing drops the whole subtree from `open`, not just the directory
     *  itself: re-opening a folder and finding three levels still expanded from
     *  ten minutes ago is a small surprise, and keeping the descendants around
     *  would also make them walk again the moment the parent reopened. */
    async toggle(s: TreeState, path: string) {
      const openSet = new Set(s.open);
      if (openSet.has(path)) {
        s.open = s.open.filter((p) => p !== path && !p.startsWith(`${path}/`));
      } else {
        s.open = [...s.open, path];
      }
      await read(s);
    },

    /** Open a file in the preview pane, or close it by selecting it again. */
    async select(s: TreeState, path: string) {
      if (s.selected === path) {
        s.selected = "";
        s.preview = { ...NO_PREVIEW };
        return;
      }
      s.selected = path;
      s.preview = { ...NO_PREVIEW };
      s.previewHead = "";
      try {
        const io = await import("./catalog.server.ts");
        const read = await io.readFilePreview(path);
        // The committed version too, but only for a file git says has changed:
        // asking for every file would spawn a subprocess per click, and for an
        // unchanged file the answer is a diff with nothing in it.
        //
        // aiol-ok: `modified` is read deliberately after the await. It is the
        // current answer that matters — a refresh that landed while the file
        // was being read knows better than the list this method entered with.
        const claude = await import("./claude.server.ts");
        // aiol-ok: read after the await on purpose — see above.
        const head = s.modified.includes(path)
          ? await claude.gitFileAtHead(path)
          : null;
        // Re-checked after the await: the user can click another file while a
        // big one is being read, and the slower answer must not overwrite it.
        // aiol-ok: that re-read is the point
        if (s.selected === path) {
          s.preview = read;
          s.previewHead = head ?? "";
        }
      } catch (e) {
        // aiol-ok: the same deliberate re-read as above
        if (s.selected === path) {
          s.preview = {
            ...NO_PREVIEW,
            error: e instanceof Error ? e.message : String(e),
          };
          s.previewHead = "";
        }
      }
    },
  },
});

/** Tool inputs that name a file, and whether using them counts as a write.
 *
 *  Read from the calls the session made rather than from a filesystem watcher:
 *  a watcher would also report the user's own editor, the build, and git — none
 *  of which is what this overlay claims. */
const FILE_TOOLS: Record<string, boolean> = {
  Read: false,
  NotebookEdit: true,
  Edit: true,
  Write: true,
};

/**
 * Every path this session has read or written, newest verdict winning.
 *
 * Written beats read: a file the model read and then edited is one it *changed*,
 * and that is the fact worth surfacing.
 */
export function touchedPaths(): Map<string, Touch> {
  const out = new Map<string, Touch>();
  for (const run of view().tools) {
    const writes = FILE_TOOLS[run.name];
    if (writes === undefined) continue;
    const path = run.input.file_path ?? run.input.notebook_path;
    if (typeof path !== "string" || !path) continue;
    if (writes) out.set(path, "written");
    else if (!out.has(path)) out.set(path, "read");
  }
  return out;
}

/** What git says about one file: "modified", "new", or "" for neither. Read by
 *  the row, so the page never has to hold two sets of its own. */
export const gitMark = (path: string): string =>
  tree.modified.includes(path)
    ? "modified"
    : tree.untracked.includes(path)
    ? "new"
    : "";
