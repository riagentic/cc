/**
 * @module
 * The speaker control: whether the app reads the conversation back, and
 * whether it is doing so right now.
 */
import { type VNode } from "aio/air";
import { speech, speechReady } from "../cell/speech.ts";
import { startReading, stopReading } from "./spoken.ts";
import { IconSpeaker, IconSpeakerOff } from "./icons.tsx";

/**
 * A real button, unlike the microphone beside it.
 *
 * The microphone is an indicator because push-to-talk is a held key with
 * nothing to click. This is the opposite: reading aloud has no natural
 * gesture, it has to be switched on, and it has to be switchable OFF in one
 * jab while it is mid-sentence — which is the moment you most want it to be a
 * button and not a menu three clicks deep.
 *
 * Switching off also stops what is playing. Any other reading of "off" is a
 * speaker that ignores being turned off, which people click twice and then
 * distrust.
 */
export function Speaker(_props: { key?: string } = {}): VNode {
  const ready = speechReady();
  const status = speech.status;
  const on = status !== "off";

  const hint = !ready
    ? "Set up a speech server in Settings to have replies read aloud"
    : status === "speaking"
    ? `Reading aloud — click to stop. ${speech.saying}`
    : status === "error"
    ? speech.error ?? "Reading aloud failed"
    : on
    ? "Reading replies aloud — click to switch off"
    : "Read replies aloud";

  return (
    <button
      type="button"
      class={`mic speaker speaker--${status}`}
      title={hint}
      // Stable, while the tooltip changes. A toggle's accessible NAME is what
      // it does, not what it is doing — a button that renames itself every
      // time it is pressed is one a screen-reader user cannot learn, and one
      // no test can address twice. The state travels in `aria-pressed`.
      aria-label="Read aloud"
      aria-pressed={on}
      hidden={!ready}
      // Through these rather than the cell directly: "on" also means every
      // conversation's history stops counting as news, and that bookkeeping
      // lives with the hook that reads it.
      onClick={() => (on ? stopReading() : startReading())}
    >
      <span class="mic__icon">
        {on ? IconSpeaker({ size: 14 }) : IconSpeakerOff({ size: 14 })}
      </span>
      {
        /* The same ring the microphone uses for its meter, driven here by
          state rather than by loudness — one visual vocabulary for the two
          controls that sit next to each other. */
      }
      <span class="mic__level" />
    </button>
  );
}
