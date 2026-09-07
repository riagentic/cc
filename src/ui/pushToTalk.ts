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
    let holding = false;

    const down = (e: KeyboardEvent) => {
      if (e.code !== voiceKey()) return;
      if (!voiceReady()) {
        log.warn("voice", "key held, but no speech server is set up");
        return;
      }
      // A held key repeats. Only the first press is a press.
      if (e.repeat || holding) return;
      holding = true;
      void voice.start();
    };

    const up = (e: KeyboardEvent) => {
      if (e.code !== voiceKey()) return;
      if (!holding) {
        // The press that opened this was not seen — the window did not have
        // focus for it, or something swallowed it. Reported rather than
        // ignored, because the symptom is a key that "did nothing" and there
        // is otherwise no trace of it at all.
        log.warn("voice", "key released without a press being seen");
        return;
      }
      holding = false;
      void voice.stop();
    };

    // The keyup that never comes.
    //
    // Alt-tab away mid-sentence and the release lands in another window; the
    // microphone would stay open until something else happened to close it.
    // Losing focus ends the recording, which is also the honest behaviour: a
    // window that is not in front has no business listening.
    const lost = () => {
      if (!holding) return;
      holding = false;
      void voice.stop();
    };

    win.addEventListener("keydown", down);
    win.addEventListener("keyup", up);
    win.addEventListener("blur", lost);
    onCleanup(() => {
      win.removeEventListener("keydown", down);
      win.removeEventListener("keyup", up);
      win.removeEventListener("blur", lost);
      // Never leave the microphone open because a page went away.
      if (holding) void voice.stop();
    });
  });
}
