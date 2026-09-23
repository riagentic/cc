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
import type { DaemonInfo, Job } from "../type/claude.ts";
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

/**
 * The CLI's refusal, corrected when we know more than it said.
 *
 * `claude stop` and `claude rm` answer a missing background service with "the
 * background service may be restarting. Try again in a moment." That is true
 * of a service that is coming back and false of one that exited weeks ago —
 * and following the advice is exactly what somebody does, several times, before
 * giving up. When the roster shows no live supervisor, the app knows better and
 * says so.
 *
 * Pure, and exported, because the wording is the whole point of it.
 */
export function explainRefusal(
  failed: string,
  serviceRunning: boolean,
): string {
  if (serviceRunning || !/background service/i.test(failed)) return failed;
  return `${failed.replace(/\s*Try again in a moment\.?/i, "").trim()} ` +
    "It is not restarting: it exited, and nothing starts it again on its own. " +
    "Removing the record is the only thing that works from here.";
}

/** Re-read every background session into the draft. */
async function scan(s: JobsState): Promise<void> {
  try {
    const io = await import("./catalog.server.ts");
    // The roster once, handed to the listing: it needs the same answer to
    // mark stale jobs, and reading it twice could give two.
    const daemon = await io.readDaemon();
    const found = await io.listJobs(daemon);
    // Compared the same way the list is: this is polled every few seconds and
    // an unconditional write would broadcast the whole cell for a value that
    // changes when a daemon starts or stops, which is roughly never.
    if (JSON.stringify(daemon) !== JSON.stringify(s.daemon)) s.daemon = daemon;
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
  /**
   * The background service, as its own roster describes it.
   *
   * On the page because it explains the one failure users cannot otherwise
   * make sense of: with no service running, `claude stop` and `claude rm`
   * cannot confirm their work and refuse — so a job sits there, "waiting for
   * you", and no button removes it.
   */
  daemon: DaemonInfo;
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
    daemon: {
      running: false,
      pid: 0,
      updatedAt: 0,
      workers: [] as string[],
    } as DaemonInfo,
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
      let failed: string | null = null;
      try {
        const io = await import("./catalog.server.ts");
        failed = await io.jobAction(id, action);
        if (failed) {
          log.warn("jobs", "action failed", { id, action, error: failed });
        } else {
          log.info("jobs", "action sent", { id, action });
          // A removed job has no detail left to show. Cleared unconditionally:
          // the only selection this could be is the row that was just deleted.
          if (action === "remove") s.selectedId = "";
        }
      } catch (e) {
        failed = e instanceof Error ? e.message : String(e);
      } finally {
        s.busyId = "";
      }
      // The list is re-read *in this transaction*, not by dispatching `refresh`
      // again: a nested call would run against committed state and could land
      // its result either side of the writes above.
      await scan(s);
      // Written after the rescan, which clears the error field on a clean
      // listing — an action's failure must outlive the refresh it triggers,
      // or the page shows nothing where a refusal belongs.
      //
      // …and translated when we know better than the message does. The CLI
      // says "the background service may be restarting. Try again in a
      // moment." for a service that exited weeks ago and is not coming back on
      // its own — so "try again in a moment" is advice that never works, and
      // following it is exactly what a user does before giving up.
      // aiol-ok: `daemon` is read after the rescan on purpose — the rescan
      // just refreshed it, and it is that fresh answer the message depends on.
      if (failed) s.error = explainRefusal(failed, s.daemon.running); // aiol-ok
    },

    /**
     * Delete the app's and the CLI's record of a job, without the CLI.
     *
     * The escape hatch, and the only thing that works in the state that
     * produced it: `claude rm` confirms the removal *through* the background
     * service, so with none running it refuses — and a job whose daemon exited
     * weeks ago can be removed by no command at all. It sits in the list
     * saying "waiting for you" forever.
     *
     * Deliberately a different verb from `remove`. This one does not ask the
     * CLI, does not stop anything, and does not touch a worktree; it deletes
     * `~/.claude/jobs/<id>`, which is the record. The conversation is in
     * `~/.claude/projects` and stays there. The UI says all of that before
     * offering it.
     */
    async forget(s: JobsState, id: string) {
      if (typeof id !== "string" || id === "") return;
      s.busyId = id;
      s.error = null;
      let failed: string | null = null;
      let worktree: string | null = null;
      try {
        const io = await import("./catalog.server.ts");
        const done = await io.forgetJob(id);
        failed = done.error;
        worktree = done.worktree;
        if (failed === null) {
          log.info("jobs", "forgot a job record", { id, worktree });
        } else {
          log.warn("jobs", "could not forget a job", { id, error: failed });
        }
      } catch (e) {
        failed = e instanceof Error ? e.message : String(e);
      } finally {
        s.busyId = "";
      }
      if (failed === null) s.selectedId = "";
      await scan(s);
      s.error = failed ??
        (worktree
          // Not an error — a fact that would otherwise be discovered as a
          // stray directory months later.
          ? `Removed the job record. Its worktree is still at ${worktree}.`
          : null);
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

/** Jobs whose claim can no longer be acted on: they say they are working or
 *  waiting, and there is no background service alive to be doing it. */
export const staleJobs = (): Job[] => jobs.jobs.filter((j) => j.stale);

/**
 * Whether the CLI's own stop/remove can work at all right now.
 *
 * Both confirm through the background service. With none running they refuse
 * with "the background service may be restarting" — which is misleading when
 * it exited weeks ago and is not restarting at all.
 */
export const cliCanRemove = (): boolean => jobs.daemon.running;
