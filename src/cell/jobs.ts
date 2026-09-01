/**
 * @module
 * Jobs — Claude Code's *background sessions*, the ones `claude --bg` detaches
 * and `claude agents` lists.
 *
 * A job is not a {@link BackgroundTask}: a task is one tool call inside the
 * session this app is driving, and it dies with it. A job is a whole separate
 * conversation with its own directory, model and lifetime, still working after
 * every terminal that ever saw it has closed. The failure mode this page exists
 * for is a job that went `blocked` — waiting on a human answer, burning nothing,
 * finishing never, and visible nowhere unless somebody goes looking.
 *
 * Polled from disk rather than pushed: these sessions belong to other processes
 * and there is nothing to subscribe to.
 */
import { cell, log, type MethodDraftMeta, schedule } from "aio";
import type { Job } from "../type/claude.ts";
import type { JobAction } from "./catalog.server.ts";

/** Poll cadence. Fast enough that a job changing state is noticed while the
 *  user is still looking at it; slow enough that four `stat`s and a tail read
 *  per job stay invisible. */
const POLL_MS = 5_000;

/* ── plain helpers ────────────────────────────────────────────────────────────
 *
 * Shared work lives here rather than in a method another method calls. A nested
 * same-cell call runs as its own transaction against *committed* state, so it
 * cannot see the write its caller is halfway through — a plain function takes
 * the draft and sees it exactly as it is.
 */

/** Re-read every background session into the draft. */
async function scan(s: JobsState): Promise<void> {
  try {
    const io = await import("./catalog.server.ts");
    const found = await io.listJobs();
    // Written only when something actually moved. This runs every few seconds
    // and the value is large — four jobs carry four capped timelines — so an
    // unconditional assignment made every poll a full-state broadcast and a
    // re-render of the whole window, for a list that changes maybe once an
    // hour. `scannedAt` is deliberately left alone too: bumping it would dirty
    // the cell just as effectively as the list itself.
    if (JSON.stringify(found) !== JSON.stringify(s.jobs)) {
      s.jobs = found;
      s.scannedAt = Date.now();
    }
    if (s.error !== null) s.error = null;
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    s.error = reason;
    log.warn("jobs", "scan failed", { error: reason });
  }
}

type JobsState = {
  jobs: Job[];
  /** The job whose detail is open, by id. Empty when the list is showing. */
  selectedId: string;
  scannedAt: number;
  /** A job id an action is running against — the row's buttons go quiet. */
  busyId: string;
  error: string | null;
};

export const jobs = cell("jobs", {
  // Read from disk on every poll: persisting a copy would only let the app
  // disagree with the CLI about what it is running.
  persist: "none",

  state: {
    jobs: [] as Job[],
    selectedId: "",
    scannedAt: 0,
    busyId: "",
    error: null as string | null,
  },

  onInit() {
    // Same reason as `workspace.bootstrap`: the cell's runtime is not up yet
    // during `onInit`, so the first scan is queued for the next macrotask.
    setTimeout(() => void jobs.arm(), 0); // aiol-ok
  },

  methods: {
    /**
     * Start the poll, and take the first reading.
     *
     * Separate from {@link refresh} so the schedule is armed *once*. Re-arming
     * `every` from inside its own tick replaces the timer on every pass — the
     * interval silently restarts, and the Refresh button on the page would
     * quietly reset the poll clock too.
     *
     * `Partial<MethodDraftMeta>` is what puts `$do` — the effect channel — on
     * the draft (dep/aio/docs/state/methods.md#running-effects).
     */
    async arm(s: JobsState & Partial<MethodDraftMeta>) {
      // `skipIfRunning` because the read is I/O over an unknown number of jobs:
      // without it a slow disk stacks polls on top of each other.
      s.$do?.(schedule.every("jobs-poll", POLL_MS, jobs.refresh.action(), {
        skipIfRunning: true,
      }));
      await scan(s);
    },

    /** Re-read every background session. Also what the poll fires. */
    async refresh(s: JobsState) {
      await scan(s);
    },

    /** Open one job's detail, or close it with `""`. */
    select(s: JobsState, id: string) {
      s.selectedId = s.selectedId === id ? "" : id;
    },

    /**
     * Stop, remove or respawn a background session.
     *
     * The list is re-read afterwards rather than edited in place: the CLI owns
     * these, and guessing that `stop` worked would put the app's idea of the
     * job ahead of the CLI's — the exact drift this app exists to remove.
     */
    async act(s: JobsState, id: string, action: JobAction) {
      s.busyId = id;
      s.error = null;
      try {
        const io = await import("./catalog.server.ts");
        const failed = await io.jobAction(id, action);
        if (failed) {
          s.error = failed;
          log.warn("jobs", "action failed", { id, action, error: failed });
        } else {
          log.info("jobs", "action sent", { id, action });
          // A removed job has no detail left to show. Cleared unconditionally:
          // the only selection this could be is the row that was just deleted.
          if (action === "remove") s.selectedId = "";
        }
      } catch (e) {
        s.error = e instanceof Error ? e.message : String(e);
      } finally {
        s.busyId = "";
      }
      // The list is re-read *in this transaction*, not by dispatching `refresh`
      // again: a nested call would run against committed state and could land
      // its result either side of the writes above.
      await scan(s);
    },
  },
});

/** The job whose detail is open, or `null`. */
export const selectedJob = (): Job | null =>
  jobs.jobs.find((j) => j.id === jobs.selectedId) ?? null;

/** Jobs still doing something — the count the rail badge carries. */
export const activeJobs = (): Job[] =>
  jobs.jobs.filter((j) => j.state === "working");

/** Jobs stopped waiting for a human. These are the ones worth interrupting the
 *  user for: nothing moves them until somebody answers. */
export const blockedJobs = (): Job[] =>
  jobs.jobs.filter((j) => j.state === "blocked");
