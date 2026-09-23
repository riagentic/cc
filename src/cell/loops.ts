/**
 * @module
 * Loops — a prompt re-sent on an interval, the way `/loop` works inside the
 * CLI, except owned here.
 *
 * That difference is the whole point. A loop set up *inside* a session lives in
 * that session's head: it is invisible between runs, it cannot be paused
 * without saying so in prose, and it dies with the process. A loop owned by the
 * app is a row you can see, pause, edit and delete, and it is still there
 * tomorrow.
 *
 * Two rules keep a loop from being a surprise:
 *
 *  - it fires only into the project it was made for, so switching project does
 *    not redirect somebody's five-minute CI check at unrelated code;
 *  - it never fires into a turn that is already running. A loop that queued
 *    behind a long turn would pile up prompts the user never typed, and the
 *    next tick is a few seconds away in any case.
 */
import { cell, log, type MethodDraftMeta, schedule } from "aio";
import type { Loop, Status } from "../type/claude.ts";
import { oneLine } from "../lib/format.ts";
import { session, sessionOf } from "./session.ts";
import { activeSessionKey, workspace } from "./workspace.ts";

/** How often due loops are checked. Not the resolution a loop is *set* at —
 *  that is `everySec` — just how sharply the due moment is noticed. */
const TICK_MS = 5_000;

/** The shortest interval a loop may be set to. A prompt is a turn, and a turn
 *  costs money and takes longer than this; anything faster would queue on
 *  itself forever. */
export const MIN_EVERY_SEC = 30;

/** Runs kept per loop. Enough to see a pattern, bounded because this is
 *  persisted and every run carries text. */
const MAX_RUNS = 40;

type LoopsState = {
  loops: Loop[];
  error: string | null;
};

/** The next due time for a loop from now. `0` for a paused one, which is what
 *  makes "paused" a fact about the schedule rather than a flag checked later. */
const nextFrom = (l: Pick<Loop, "paused" | "everySec">, now: number): number =>
  l.paused ? 0 : now + l.everySec * 1_000;

/**
 * Which conversation each loop's open run was sent into, by loop id.
 *
 * A run is settled when THAT conversation goes idle — not when whatever is on
 * screen does. Module state because it lives exactly as long as the process
 * the prompt went to: after a restart there is no turn left to wait for, and
 * the project's own first conversation (its id) is the honest fallback.
 */
const SENT_TO = new Map<string, string>();

/** What a tick needs to know about the world, as plain values. */
export type TickWorld = {
  now: number;
  /** The project on screen — a loop fires only into its own. */
  activeId: string;
  /** The conversation on screen, which is where a prompt goes. */
  activeKey: string;
  statusOf: (key: string) => Status;
  answerOf: (key: string) => string;
  /** Where a loop's open run went; see {@link SENT_TO}. */
  sentTo: (loop: Loop) => string;
};

/** What a tick decided. Applied by {@link loops.claim}; decided by
 *  {@link planTick}, which is pure. */
export type TickPlan = {
  settle: { id: string; ok: boolean; summary: string }[];
  /** Due, but not now: moved on by one interval. */
  defer: string[];
  /** The one loop to fire, or `null`. */
  fire: string | null;
};

/**
 * One tick's decisions, without touching anything.
 *
 * Each open run is settled against the conversation it was SENT to. Then at
 * most one due loop fires — into the conversation on screen, only if it is
 * idle, and only if it belongs to the project on screen. A second loop due in
 * the same tick waits an interval: it would otherwise be sent into the turn
 * the first one has just started, which is exactly the pile-up rule 2 of the
 * module comment forbids.
 */
export function planTick(list: Loop[], w: TickWorld): TickPlan {
  const plan: TickPlan = { settle: [], defer: [], fire: null };
  for (const l of list) {
    const run = l.runs[0];
    if (!run || run.ok !== null) continue;
    const key = w.sentTo(l);
    const status = w.statusOf(key);
    if (status === "working") continue;
    plan.settle.push({
      id: l.id,
      ok: status !== "error",
      summary: w.answerOf(key) || run.summary,
    });
  }
  // Busy counts a run this very tick is leaving open, too: its turn has not
  // ended just because the settle pass passed it by.
  let busy = w.statusOf(w.activeKey) === "working";
  const settled = new Set(plan.settle.map((d) => d.id));
  for (const l of list) {
    if (l.paused || l.nextAt === 0 || l.nextAt > w.now) continue;
    // Not this project, or a turn is in flight: the loop is not skipped, it is
    // simply due again at the next interval. A loop that fired the moment you
    // switched back would deliver a prompt aimed at a session that has since
    // moved on. Its own last run still open — in another conversation of the
    // project — counts as in flight: one loop, at most one open run.
    const open = l.runs[0]?.ok === null && !settled.has(l.id);
    if (l.projectId !== w.activeId || busy || open) {
      plan.defer.push(l.id);
      continue;
    }
    plan.fire = l.id;
    busy = true;
  }
  return plan;
}

export const loops = cell("loops", {
  // A loop is a standing instruction. Losing it on restart would make it the
  // one kind of automation you have to remember to set up again.
  persist: { exclude: ["error"] },

  // Snapshot isolation: a tick awaits `session.send` between writes, and a
  // half-recorded run must never be visible.
  transaction: true,

  state: {
    loops: [] as Loop[],
    error: null as string | null,
  },

  onInit() {
    // The runtime is not up during `onInit` — same constraint as the other
    // cells that schedule from boot.
    setTimeout(() => void loops.arm(), 0); // aiol-ok
  },

  methods: {
    /**
     * Drop every loop belonging to a project that is no longer in the list.
     *
     * A loop names the project it fires into and never fires anywhere else, so
     * one whose project is gone is a row that can never run again — and,
     * because the page only ever shows the *active* project's loops, one
     * nobody can see in order to delete it. It is persisted, so it would
     * outlive the app as well.
     */
    forgetProjects(s: LoopsState, ids: string[]) {
      const before = s.loops.length;
      s.loops = s.loops.filter((l) => !ids.includes(l.projectId));
      if (s.loops.length !== before) {
        log.info("loops", "dropped loops for removed projects", {
          count: before - s.loops.length,
        });
      }
    },

    /** The same collection, run against the whole project list — for rows
     *  written before `forgetProjects` existed, or orphaned by a crash. The
     *  list is read here rather than passed in, for the reason spelled out on
     *  `local.pruneUnknown`: a snapshot taken by the caller is already stale. */
    pruneUnknown(s: LoopsState) {
      // Same guard as `local.pruneUnknown`: an empty list is "not settled
      // yet", and sweeping against it would delete every loop on the machine.
      if (workspace.projects.length === 0) return;
      const known = new Set(workspace.projects.map((p) => p.id));
      const before = s.loops.length;
      s.loops = s.loops.filter((l) => known.has(l.projectId));
      if (s.loops.length !== before) {
        log.info("loops", "dropped loops for unknown projects", {
          count: before - s.loops.length,
        });
      }
    },

    /**
     * Start the tick, once.
     *
     * Kept out of {@link tick} deliberately: re-arming `every` from inside its
     * own tick replaces the timer on every pass, so the interval restarts
     * continuously and a due loop's deadline drifts by however long the tick
     * before it took.
     *
     * `Partial<MethodDraftMeta>` is what puts `$do` — the effect channel — on
     * the draft (dep/aio/docs/state/methods.md#running-effects).
     */
    arm(s: LoopsState & Partial<MethodDraftMeta>) {
      s.$do?.(schedule.every("loops-tick", TICK_MS, loops.tick.action(), {
        skipIfRunning: true,
      }));
    },

    /**
     * One pass: settle whatever finished, then fire whatever is due.
     *
     * Both halves are here rather than in an event handler because a loop's run
     * ends when the *session* goes idle, and there is no turn-ended signal to
     * subscribe to — the session cell is a reducer over a process stream, not a
     * bus. A tick that reads "is a turn in flight now" answers the same question
     * and cannot get stuck waiting for an event that was missed.
     *
     * An orchestrator: the decisions are recorded by the sync {@link claim},
     * and only then is the prompt sent. Sending from inside one transaction
     * put a prompt on the wire and THEN had the commit refused — the run and
     * the new due time were discarded with it, so the same prompt fired again
     * on the next tick.
     */
    async tick(_s: LoopsState) {
      const fired = await loops.claim(); // aiol-ok: orchestration, see above
      if (fired === null) return;
      log.info("loops", "firing", { id: fired.id });
      await session.send(fired.prompt);
    },

    /** The write half of {@link tick}: apply one {@link planTick}, and say
     *  which prompt to send. Sync, so it commits whole before anything goes
     *  out. */
    claim(s: LoopsState): { id: string; prompt: string } | null {
      const now = Date.now();
      const plan = planTick(s.loops, {
        now,
        activeId: workspace.activeId,
        activeKey: activeSessionKey(),
        statusOf: (key) => sessionOf(key).status,
        answerOf: lastAnswer,
        sentTo: (l) => SENT_TO.get(l.id) ?? l.projectId,
      });
      for (const done of plan.settle) {
        const run = s.loops.find((l) => l.id === done.id)?.runs[0];
        if (!run) continue;
        run.endedAt = now;
        run.ok = done.ok;
        run.summary = done.summary;
        SENT_TO.delete(done.id);
      }
      for (const id of plan.defer) {
        const l = s.loops.find((x) => x.id === id);
        if (l) l.nextAt = now + l.everySec * 1_000;
      }
      const l = plan.fire === null
        ? undefined
        : s.loops.find((x) => x.id === plan.fire);
      if (!l) return null;
      l.nextAt = now + l.everySec * 1_000;
      l.runs.unshift({
        at: now,
        endedAt: null,
        ok: null,
        summary: oneLine(l.prompt, 90),
      });
      if (l.runs.length > MAX_RUNS) l.runs.length = MAX_RUNS;
      SENT_TO.set(l.id, activeSessionKey());
      return { id: l.id, prompt: l.prompt };
    },

    /** Add a loop for the active project. */
    add(s: LoopsState, prompt: string, everySec: number) {
      const body = typeof prompt === "string" ? prompt.trim() : "";
      if (!body) {
        s.error = "Enter a prompt to run.";
        return;
      }
      if (!workspace.activeId) {
        s.error = "Pick a project first — a loop belongs to one.";
        return;
      }
      // Clamped rather than rejected: a user typing `5` means "as often as you
      // can", and refusing the row is a worse answer than honouring the floor.
      const every = Math.max(
        MIN_EVERY_SEC,
        Math.round(Number(everySec) || 0) || MIN_EVERY_SEC,
      );
      s.error = null;
      s.loops.push({
        id: crypto.randomUUID(),
        prompt: body,
        everySec: every,
        paused: false,
        projectId: workspace.activeId,
        createdAt: Date.now(),
        nextAt: Date.now() + every * 1_000,
        runs: [],
      });
    },

    /** Pause or resume. A resumed loop starts its interval from now rather than
     *  firing immediately for every tick it missed while paused. */
    toggle(s: LoopsState, id: string) {
      const l = s.loops.find((x) => x.id === id);
      if (!l) return;
      l.paused = !l.paused;
      l.nextAt = nextFrom(l, Date.now());
    },

    /** Run one now, without disturbing its schedule beyond the next interval. */
    runNow(s: LoopsState, id: string) {
      const l = s.loops.find((x) => x.id === id);
      if (l && !l.paused) l.nextAt = Date.now();
    },

    remove(s: LoopsState, id: string) {
      s.loops = s.loops.filter((l) => l.id !== id);
    },

    /** Edit an existing loop in place, keeping its history. */
    update(s: LoopsState, id: string, prompt: string, everySec: number) {
      const l = s.loops.find((x) => x.id === id);
      if (!l) return;
      const body = typeof prompt === "string" ? prompt.trim() : "";
      if (body) l.prompt = body;
      l.everySec = Math.max(
        MIN_EVERY_SEC,
        Math.round(Number(everySec) || 0) || l.everySec,
      );
      l.nextAt = nextFrom(l, Date.now());
      s.error = null;
    },
  },
});

/** The last thing the assistant said in one conversation, for a run's summary
 *  line. */
function lastAnswer(key: string): string {
  const messages = sessionOf(key).messages;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "assistant") continue;
    const text = m.blocks
      .filter((b) => b.kind === "text")
      .map((b) => b.kind === "text" ? b.text : "")
      .join(" ");
    if (text.trim()) return oneLine(text, 90);
  }
  return "";
}

/** Loops belonging to the project on screen. A loop for another project is not
 *  hidden because it is unimportant — it is hidden because it cannot fire here,
 *  and showing it beside ones that can would misreport what is scheduled. */
export const projectLoops = (): Loop[] =>
  loops.loops.filter((l) => l.projectId === workspace.activeId);

/** Loops that are armed for this project — what the rail counts. */
export const activeLoops = (): Loop[] =>
  projectLoops().filter((l) => !l.paused);
