/**
 * @module
 * Hold a key, say a sentence, let go.
 *
 * A hook of its own rather than another entry in the shortcut table, because
 * every shortcut in that table fires on keydown and is done. This one is a
 * pair: the press opens the microphone and the release closes it, and the
 * release is the half that must never be missed.
 */
import { log } from "aio";
import { onCleanup, onMount } from "aio/air";
import { voice, voiceKey, voiceReady } from "../cell/voice.ts";

/**
 * Where a press of the talk key has got to.
 *
 *  - `idle`: the key is up.
 *  - `holding`: down, and the microphone is open because of it.
 *  - `dropped`: down, but not recording — refused because voice is off, or
 *    cancelled because another key joined it. Its release is silent: the
 *    press was already dealt with.
 */
export type Press = "idle" | "holding" | "dropped";

/** What one key event asks the hook to do. */
export type KeyAct = "start" | "stop" | "cancel" | "refuse" | "stray" | null;

/** A key event, reduced to the three facts the decision needs. */
export type KeyEvt = {
  kind: "down" | "up" | "blur";
  code: string;
  repeat: boolean;
};

/**
 * The whole of push-to-talk as one pure step: where the press is, what just
 * happened, and whether voice is usable — to where it is now and what to do.
 *
 * Pure so the rules are pinned by a test rather than by holding keys:
 *
 *  - A key repeat is never a press, and is checked FIRST. Checked after the
 *    "is voice on" test, every repeat of a held Right-Ctrl — thirty a second —
 *    logged its own "speech is switched off".
 *  - Another key going down during a hold cancels it. Right-Ctrl is also half
 *    of every right-hand Ctrl shortcut, and the recording of one was a second
 *    of key clicks that whisper wrote up as a sentence and auto-send sent.
 *  - A refused or cancelled press releases silently.
 */
export function onKey(
  press: Press,
  e: KeyEvt,
  key: string,
  ready: boolean,
): { press: Press; act: KeyAct } {
  if (e.kind === "blur") {
    return { press: "idle", act: press === "holding" ? "stop" : null };
  }
  if (e.code !== key) {
    return e.kind === "down" && press === "holding"
      ? { press: "dropped", act: "cancel" }
      : { press, act: null };
  }
  if (e.kind === "up") {
    if (press === "holding") return { press: "idle", act: "stop" };
    return { press: "idle", act: press === "dropped" ? null : "stray" };
  }
  // A held key repeats. Only the first press is a press.
  if (e.repeat || press === "holding") return { press, act: null };
  return ready
    ? { press: "holding", act: "start" }
    : { press: "dropped", act: "refuse" };
}

/**
 * Said once per run, not once per press.
 *
 * The key is Right-Ctrl, which people press for other reasons all day; with
 * voice switched off — the default — every one of those presses is "refused".
 * Once is enough to explain a key that does nothing.
 */
let refusalSaid = false;

/**
 * Install push-to-talk on the window.
 *
 * `code`, not `key`: the default is the RIGHT Ctrl specifically, and `key`
 * reports both of them as "Control". A bare modifier is also the one kind of
 * key that sends nothing to a focused terminal, so this can be taken globally
 * without costing the Console anything — which is not true of any letter.
 */
export function usePushToTalk(): void {
  onMount(() => {
    const win = typeof window === "undefined" ? null : window;
    if (!win) return;

    // Whether THIS hook opened the microphone. Without it a key released after
    // the window regained focus would close a recording it never started.
    let press: Press = "idle";

    const act = (a: KeyAct) => {
      if (a === "start") void voice.start();
      else if (a === "stop") void voice.stop();
      else if (a === "cancel") void voice.cancel();
      else if (a === "refuse" && !refusalSaid) {
        refusalSaid = true;
        log.warn(
          "voice",
          voice.config.enabled === true
            ? "key held, but no speech server is set up"
            : "key held, but speech is switched off in Settings",
        );
      } else if (a === "stray") {
        // The press that opened this was not seen — the window did not have
        // focus for it, or something swallowed it. Reported rather than
        // ignored, because the symptom is a key that "did nothing" and there
        // is otherwise no trace of it at all.
        log.warn("voice", "key released without a press being seen");
      }
    };

    const step = (e: KeyEvt) => {
      const next = onKey(press, e, voiceKey(), voiceReady());
      press = next.press;
      act(next.act);
    };
    const down = (e: KeyboardEvent) =>
      step({ kind: "down", code: e.code, repeat: e.repeat });
    const up = (e: KeyboardEvent) =>
      step({ kind: "up", code: e.code, repeat: e.repeat });

    // The keyup that never comes.
    //
    // Alt-tab away mid-sentence and the release lands in another window; the
    // microphone would stay open until something else happened to close it.
    // Losing focus ends the recording, which is also the honest behaviour: a
    // window that is not in front has no business listening.
    const lost = () => step({ kind: "blur", code: "", repeat: false });

    win.addEventListener("keydown", down);
    win.addEventListener("keyup", up);
    win.addEventListener("blur", lost);
    onCleanup(() => {
      win.removeEventListener("keydown", down);
      win.removeEventListener("keyup", up);
      win.removeEventListener("blur", lost);
      // Never leave the microphone open because a page went away.
      if (press === "holding") void voice.stop();
    });
  });
}
