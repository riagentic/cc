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
import { cell, log } from "aio";
import type { StoredProject } from "./storage.server.ts";

/* ── plain helper ─────────────────────────────────────────────────────────────
 *
 * Same reason as in the other cells: a nested same-cell call runs as its own
 * transaction against *committed* state, so a delete that dispatched `refresh`
 * could land its result either side of its own writes.
 */

/** Walk `~/.claude` into the draft. */
async function scan(s: StorageState): Promise<void> {
  s.loading = true;
  try {
    const io = await import("./storage.server.ts");
    const report = await io.scanStorage();
    s.totalBytes = report.totalBytes;
    s.projects = report.projects;
    s.extras = report.extras;
    s.scannedAt = report.scannedAt;
    s.error = null;
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    s.error = reason;
    log.warn("storage", "scan failed", { error: reason });
  } finally {
    s.loading = false;
  }
}

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
    async refresh(s: StorageState) {
      await scan(s);
    },

    /**
     * Delete one project's stored history.
     *
     * The server re-checks every precondition rather than trusting what this
     * page last measured: a scan is a snapshot, and the folder may have come
     * back — remounted, re-cloned — between the scan and the click.
     */
    async remove(s: StorageState, dir: string, path: string) {
      s.busyDir = dir;
      s.error = null;
      try {
        const io = await import("./storage.server.ts");
        const refused = await io.deleteProjectHistory(dir, path);
        if (refused) {
          s.error = refused;
          log.warn("storage", "delete refused", { dir, reason: refused });
        }
      } catch (e) {
        s.error = e instanceof Error ? e.message : String(e);
      } finally {
        s.busyDir = "";
      }
      // Re-measured in this transaction, not by dispatching `refresh` again.
      await scan(s);
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
