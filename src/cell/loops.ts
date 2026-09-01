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
import type { Loop } from "../type/claude.ts";
import { oneLine } from "../lib/format.ts";
import { session, view } from "./session.ts";
import { workspace } from "./workspace.ts";

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
     * One pass: settle whatever finished, then fire whatever is due.
     *
     * Both halves are here rather than in an event handler because a loop's run
     * ends when the *session* goes idle, and there is no turn-ended signal to
     * subscribe to — the session cell is a reducer over a process stream, not a
     * bus. A tick that reads "is a turn in flight now" answers the same question
     * and cannot get stuck waiting for an event that was missed.
     */
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

    async tick(s: LoopsState) {
      const now = Date.now();
      const idle = view().status !== "working";

      // Settle first: an open run belongs to the turn that has now finished,
      // and closing it before firing keeps one loop to at most one open run.
      if (idle) {
        for (const l of s.loops) {
          const run = l.runs[0];
          if (run && run.ok === null) {
            run.endedAt = now;
            run.ok = view().status !== "error";
            run.summary = lastAnswer() || run.summary;
          }
        }
      }

      const activeId = workspace.activeId;
      for (const l of s.loops) {
        if (l.paused || l.nextAt === 0 || l.nextAt > now) continue;
        // Not this project, or a turn is in flight: the loop is not skipped,
        // it is simply due again at the next interval. A loop that fired the
        // moment you switched back would deliver a prompt aimed at a session
        // that has since moved on.
        if (l.projectId !== activeId || !idle) {
          l.nextAt = now + l.everySec * 1_000;
          continue;
        }
        l.nextAt = now + l.everySec * 1_000;
        l.runs.unshift({
          at: now,
          endedAt: null,
          ok: null,
          summary: oneLine(l.prompt, 90),
        });
        if (l.runs.length > MAX_RUNS) l.runs.length = MAX_RUNS;
        log.info("loops", "firing", { id: l.id, everySec: l.everySec });
        await session.send(l.prompt);
      }
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

/** The last thing the assistant said, for a run's summary line. */
function lastAnswer(): string {
  for (let i = view().messages.length - 1; i >= 0; i--) {
    const m = view().messages[i];
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
