/**
 * @module
 * What a status light means, decided in one place.
 *
 * Every dot in this app answers the same question — "is anything happening
 * here, and does it want me?" — so they share one vocabulary and one set of
 * colours. A light that is always on says nothing, which is what the old dot
 * did: it meant "this shell exists", and every shell exists.
 *
 * Four states, in order of how much they ask of you:
 *
 *   idle      grey    nothing is there. No shell, no session, no engine.
 *   ready     blue    it is alive and waiting for you. A prompt. An idle chat.
 *   busy      green   work is happening right now. This one pulses.
 *   attention amber   it is stopped, waiting for an answer only you can give.
 *
 * `attention` outranks `busy` deliberately: a turn parked on a permission
 * prompt is not working, however long it has been open, and the difference
 * matters more than any other on this list.
 */
import type { LocalChat } from "../type/local.ts";
import type { Status } from "../type/claude.ts";
import type { Terminal } from "../cell/console.ts";

export type Pulse = "idle" | "ready" | "busy" | "attention";

/**
 * A shell's light.
 *
 * `busy` comes from the terminal itself (the foreground process group), not
 * from watching output, so a silent `sleep 30` is green and a shell that just
 * printed a screenful and stopped is blue.
 *
 * Nothing here is time-dependent, and that is deliberate. A first version kept
 * the light on for a moment after the last output, to cover the handover
 * between two commands in a pipeline — and the light then stayed on, because
 * the app has no reason to re-render at the instant a deadline passes.
 * Nothing changes for it to notice. The wait it needed lives in the host now,
 * where there is already a loop with a clock, and reaches this as an ordinary
 * change of state.
 */
export const consolePulse = (t: Terminal): Pulse => {
  if (t.status === "off" || t.status === "exited") return "idle";
  if (t.status === "starting") return "ready";
  return t.busy ? "busy" : "ready";
};

/** A Claude conversation's light. `holds` is how many permission requests are
 *  waiting for an answer. */
export const claudePulse = (status: Status, holds: number): Pulse => {
  if (holds > 0) return "attention";
  if (status === "working" || status === "starting") return "busy";
  if (status === "ready") return "ready";
  // "offline" and "error" both mean there is nothing running to watch.
  return "idle";
};

/** A local conversation's light. A local chat has no process to be "offline":
 *  it is idle until it has an engine to talk to. */
export const localPulse = (chat: LocalChat, configured: boolean): Pulse => {
  if (chat.pending) return "attention";
  if (chat.status === "working") return "busy";
  return configured ? "ready" : "idle";
};

/** The strongest light in a set — what a project's own dot should show for the
 *  panes inside it. Attention first, because it is the one that needs a
 *  person. */
export const strongest = (all: Pulse[]): Pulse => {
  if (all.includes("attention")) return "attention";
  if (all.includes("busy")) return "busy";
  if (all.includes("ready")) return "ready";
  return "idle";
};

/** What to tell someone hovering over the light. */
export const pulseTitle = (p: Pulse, what: "shell" | "chat"): string => {
  const thing = what === "shell" ? "shell" : "conversation";
  if (p === "attention") return "Waiting for your answer";
  if (p === "busy") {
    return what === "shell" ? "Running something now" : "Working now";
  }
  if (p === "ready") {
    return what === "shell" ? "At a prompt, nothing running" : `Idle ${thing}`;
  }
  return what === "shell" ? "No shell running" : "Not started";
};
