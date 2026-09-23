/**
 * @module
 * Storage — where Claude Code's disk usage actually goes, and what of it is
 * safe to reclaim.
 *
 * Scanned on demand, not on a timer: it walks every transcript on the machine,
 * and a maintenance page that quietly reads a gigabyte in the background every
 * few seconds would be worse than the problem it reports on.
 *
 * Nothing here deletes anything on its own. Every removal is a button, with the
 * size and the folder it belonged to shown next to it — the trigger for "this
 * project is gone" is a *momentary observation about a filesystem*, and an
 * unplugged drive looks exactly like a deleted directory.
 */
import { cell, log, type MethodDraftMeta } from "aio";
import type { StoredProject } from "./storage.server.ts";

/* ── plain helper ─────────────────────────────────────────────────────────────
 *
 * Same reason as in the other cells: a nested same-cell call runs as its own
 * transaction against *committed* state, so a delete that dispatched `refresh`
 * could land its result either side of its own writes.
 */

/**
 * Walk `~/.claude` into the draft.
 *
 * `outcome` is what the caller has to say once the walk is done — a refused
 * delete — so a clean scan does not wipe the one message explaining why the
 * row is still there.
 */
async function scan(s: Draft, outcome: string | null = null): Promise<void> {
  // Published now: a transactional method's writes are otherwise invisible
  // until it returns, and a spinner that appears when the work is over is no
  // spinner at all.
  s.loading = true;
  s.$commit?.();
  try {
    const io = await import("./storage.server.ts");
    const report = await io.scanStorage();
    s.totalBytes = report.totalBytes;
    s.projects = report.projects;
    s.extras = report.extras;
    s.scannedAt = report.scannedAt;
    s.error = outcome;
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    s.error = outcome ?? reason;
    log.warn("storage", "scan failed", { error: reason });
  } finally {
    s.loading = false;
  }
}

/**
 * Deletions running right now, by directory. Module state, not the cell's
 * `busyDir`: a second click lands before the first one's write has reached
 * anybody, so the field cannot be what refuses it.
 */
const DELETING = new Set<string>();

type Draft = StorageState & Partial<MethodDraftMeta<StorageState>>;

type StorageState = {
  totalBytes: number;
  projects: StoredProject[];
  extras: { name: string; bytes: number }[];
  scannedAt: number;
  loading: boolean;
  /** The directory a deletion is running against. */
  busyDir: string;
  error: string | null;
};

export const storage = cell("storage", {
  // Measured from disk in a second; storing it would only let the app disagree
  // with the filesystem it is reporting on.
  persist: "none",

  transaction: true,

  state: {
    totalBytes: 0,
    projects: [] as StoredProject[],
    extras: [] as { name: string; bytes: number }[],
    scannedAt: 0,
    loading: false,
    busyDir: "",
    error: null as string | null,
  },

  methods: {
    /** Walk `~/.claude` and report what is there. */
    async refresh(s: Draft) {
      await scan(s);
    },

    /**
     * Delete one project's stored history.
     *
     * The server re-derives every precondition rather than trusting what
     * this page last measured — including which folder the history belongs
     * to, which is why the page's `path` is not passed on. A scan is a
     * snapshot, and the folder may have come back — remounted, re-cloned —
     * between the scan and the click.
     */
    async remove(s: Draft, dir: unknown, _path: unknown = undefined) {
      if (typeof dir !== "string" || dir === "" || DELETING.has(dir)) return;
      DELETING.add(dir);
      s.busyDir = dir;
      s.error = null;
      s.$commit?.();
      let refused: string | null = null;
      try {
        try {
          const io = await import("./storage.server.ts");
          refused = await io.deleteProjectHistory(dir);
          if (refused) {
            log.warn("storage", "delete refused", { dir, reason: refused });
          }
        } catch (e) {
          refused = e instanceof Error ? e.message : String(e);
        }
        // Re-measured in this transaction, not by dispatching `refresh` again
        // — and carrying the refusal through, so the rescan does not clear it.
        s.busyDir = "";
        await scan(s, refused);
      } finally {
        // Held until the row is gone from the list, so a click on it in the
        // meantime is not a second delete of something already deleted.
        DELETING.delete(dir);
      }
    },
  },
});

/** History whose project folder is genuinely gone — the only rows this page
 *  offers to delete. `exists: null` means we could not tell, and is excluded on
 *  purpose: "unknown" is not "gone". */
export const stale = (): StoredProject[] =>
  storage.projects.filter((p) => p.exists === false);

/** Bytes those rows hold. */
export const staleBytes = (): number =>
  stale().reduce((n, p) => n + p.bytes, 0);
