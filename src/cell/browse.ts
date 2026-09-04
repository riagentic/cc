/**
 * @module
 * The folder picker's state — one directory at a time, with the list of what
 * is inside it.
 *
 * A picker rather than a native dialog on purpose. Electron's file dialog is
 * not reachable from this app's renderer (the aio bridge exposes no such
 * verb), but the better reason is that a dialog is a dead end for everything
 * this app is good at: it cannot be filtered by typing, it cannot mark which
 * folders are repositories, it cannot be driven by `am trigger`, and it cannot
 * be tested. This can.
 *
 * Not persisted. Where you were browsing last week is not a preference; the
 * picker opens on somewhere useful instead — see `openNear`.
 */
import { cell, log } from "aio";
import type { DirEntry } from "./claude.server.ts";

type BrowseState = {
  /** The folder being shown. Empty before the picker has ever opened. */
  cwd: string;
  entries: DirEntry[];
  loading: boolean;
  error: string | null;
  /** Show dot-folders. Off by default — a home directory has forty of them and
   *  none is a project. */
  hidden: boolean;
};

/** The parent of a path, or `null` at the root. String work, not disk work:
 *  the picker needs it on every render. */
export const parentOf = (path: string): string | null => {
  if (path === "" || path === "/") return null;
  const cut = path.replace(/\/+$/, "").lastIndexOf("/");
  if (cut < 0) return null;
  return cut === 0 ? "/" : path.slice(0, cut);
};

/** The path as breadcrumbs: every ancestor, root first. */
export const crumbs = (path: string): { name: string; path: string }[] => {
  const out: { name: string; path: string }[] = [];
  let at: string | null = path;
  while (at !== null) {
    out.unshift({
      name: at === "/" ? "/" : at.slice(at.lastIndexOf("/") + 1),
      path: at,
    });
    at = parentOf(at);
  }
  return out;
};

/**
 * Read a folder into the draft.
 *
 * A plain function taking the draft, not a method the other methods call: a
 * nested same-cell call runs as its own transaction against *committed* state,
 * so `up` calling `go` would leave two writes that cannot see each other. The
 * rest of this app makes the same choice for the same reason.
 */
async function load(s: BrowseState, path: string): Promise<void> {
  s.loading = true;
  const io = await import("./claude.server.ts");
  const found = await io.listDirs(path);
  s.loading = false;
  if (found.error !== null) {
    s.error = found.error;
    log.warn("browse", "could not read a folder", {
      path: found.path,
      error: found.error,
    });
    return;
  }
  s.error = null;
  s.cwd = found.path;
  s.entries = found.entries;
}

export const browse = cell("browse", {
  state: {
    cwd: "",
    entries: [] as DirEntry[],
    loading: false,
    error: null as string | null,
    hidden: false,
  },

  // Reads the disk between writes, and two of these overlap whenever somebody
  // clicks faster than a directory listing comes back.
  transaction: true,

  methods: {
    /**
     * Show a folder.
     *
     * A path that cannot be read is reported *in place*: the listing you were
     * looking at stays on screen, with the reason underneath. Emptying the
     * list and jumping somewhere else would take away the one thing that makes
     * the error recoverable — knowing where you were.
     */
    async go(s: BrowseState, path: unknown) {
      if (typeof path !== "string" || path === "") return;
      await load(s, path);
    },

    /** Up one level. A no-op at the root rather than an error — there is
     *  simply nowhere further up, and the button is already disabled. */
    async up(s: BrowseState) {
      const parent = parentOf(s.cwd);
      if (parent === null) return;
      await load(s, parent);
    },

    /**
     * Open the picker somewhere useful.
     *
     * `near` is where the caller thinks the user is working — the project
     * they have selected, usually. Its *parent* is the right place to land: a
     * person adding a second project almost always keeps it beside the first,
     * and starting inside one project means going up before doing anything.
     */
    async openNear(s: BrowseState, near: unknown) {
      const io = await import("./claude.server.ts");
      const from = typeof near === "string" && near !== ""
        ? parentOf(io.resolvePath(near)) ?? io.homeDir()
        : io.homeDir();
      await load(s, from);
    },

    async toggleHidden(s: BrowseState) {
      s.hidden = !s.hidden;
    },

    async refresh(s: BrowseState) {
      if (s.cwd !== "") await load(s, s.cwd);
    },

    dismissError(s: BrowseState) {
      s.error = null;
    },
  },
});

/** What the picker should show: the entries, minus the dot-folders unless
 *  asked. Derived rather than stored — the toggle must not need a re-read. */
export const visibleEntries = (): DirEntry[] =>
  browse.hidden ? browse.entries : browse.entries.filter((e) => !e.hidden);
