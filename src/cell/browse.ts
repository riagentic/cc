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
import { cell, log, type MethodDraftMeta } from "aio";
import type { DirEntry } from "./claude.server.ts";
import { parentOf } from "../lib/format.ts";

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

type Draft = BrowseState & Partial<MethodDraftMeta<BrowseState>>;

/** The parent of a path — one definition, shared with the workspace. */
export { parentOf };

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
 * Which read is the newest. Module state, so every call sees it the moment it
 * is taken — a field would be a dispatch behind, and two clicks land inside
 * one listing.
 */
let latest = 0;

/**
 * Read a folder into the draft.
 *
 * A plain function taking the draft, not a method the other methods call: a
 * nested same-cell call runs as its own transaction against *committed* state,
 * so `up` calling `go` would leave two writes that cannot see each other. The
 * rest of this app makes the same choice for the same reason.
 *
 * Only the newest read writes. A slow folder clicked first and a fast one
 * clicked second finish in the wrong order, and the first must not put you
 * back where you left.
 */
async function load(s: Draft, path: string): Promise<void> {
  const mine = ++latest;
  // Published now, not at the end of the method: a transactional method's
  // writes are otherwise invisible until it returns, and a spinner that
  // appears only once the listing is back is no spinner at all.
  s.loading = true;
  s.$commit?.();
  const io = await import("./claude.server.ts");
  const found = await io.listDirs(path);
  if (mine !== latest) return;
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
    async go(s: Draft, path: unknown) {
      if (typeof path !== "string" || path === "") return;
      await load(s, path);
    },

    /** Up one level. A no-op at the root rather than an error — there is
     *  simply nowhere further up, and the button is already disabled. */
    async up(s: Draft) {
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
    async openNear(s: Draft, near: unknown) {
      const io = await import("./claude.server.ts");
      const from = typeof near === "string" && near !== ""
        ? parentOf(io.resolvePath(near)) ?? io.homeDir()
        : io.homeDir();
      await load(s, from);
    },

    async toggleHidden(s: BrowseState) {
      s.hidden = !s.hidden;
    },

    async refresh(s: Draft) {
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
