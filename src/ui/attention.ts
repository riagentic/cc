/**
 * @module
 * Telling you a turn finished while you were somewhere else.
 *
 * A turn can take minutes — the API stalls, a test suite runs — and the honest
 * response to that is to go and do something else. Which means the app has to
 * be able to get your attention back, and it has exactly two ways to do it
 * without being obnoxious: the window title, and a short sound nobody has to
 * turn off because it only plays when the window is not focused.
 *
 * The sound is synthesised rather than shipped as a file. A two-tone chime is
 * eight lines of WebAudio, and an audio asset would have to be loaded — which
 * this app's content-security policy forbids, for good reasons that are not
 * worth relaxing over a beep.
 */
import { afterRender, useRef } from "aio/air";
import { prefs } from "../cell/prefs.ts";

/** The title when nothing is happening. Also the app's name, so this is the
 *  one place that spells it. */
const IDLE_TITLE = "Claude Control";

/** Two notes, a fifth apart, at a volume that reads as "done" rather than
 *  "alarm". Fails silently everywhere audio is unavailable — a browser that
 *  has not been interacted with, a test environment, a machine with no sound
 *  card. A chime that throws would be worse than no chime. */
function chime(): void {
  try {
    const Ctor = (globalThis as {
      AudioContext?: typeof AudioContext;
      webkitAudioContext?: typeof AudioContext;
    }).AudioContext ??
      (globalThis as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!Ctor) return;
    const ctx = new Ctor();
    const at = ctx.currentTime;
    for (const [i, hz] of [660, 990].entries()) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = hz;
      // A short attack and a long tail: a square-edged envelope clicks, and a
      // click is the part people report as unpleasant.
      const start = at + i * 0.12;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.12, start + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.35);
      osc.connect(gain).connect(ctx.destination);
      osc.start(start);
      osc.stop(start + 0.4);
    }
    // Let the tail finish, then let go of the context: browsers cap how many
    // a page may hold open, and this runs once per finished turn forever.
    setTimeout(() => void ctx.close().catch(() => {}), 900);
  } catch {
    // Deliberately nothing. See above.
  }
}

/**
 * Keep the window title in step with the turn, and chime when one finishes
 * out of sight.
 *
 * `working` is whatever the page in front of you means by busy — the Claude
 * session or the local engine — so this hook does not need to know which
 * engine is running. `label` is what to name in the title, usually the
 * project.
 */
export function useAttention(working: boolean, label: string): void {
  const was = useRef(false);

  afterRender(() => {
    if (typeof document === "undefined") return;

    const title = working
      ? `● ${label || IDLE_TITLE} — working`
      : label
      ? `${label} — ${IDLE_TITLE}`
      : IDLE_TITLE;
    if (document.title !== title) document.title = title;

    const finished = was.current && !working;
    was.current = working;
    if (!finished) return;
    // Only when you are not looking. A sound for something you can already see
    // happening is noise, and this is the one setting people would otherwise
    // turn off within a minute and never turn back on.
    const focused = typeof document.hasFocus === "function"
      ? document.hasFocus()
      : true;
    if (prefs.sounds && !focused) chime();
  });
}
