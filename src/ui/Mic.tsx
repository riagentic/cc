/**
 * @module
 * The microphone control: what it hears, and what it is doing with it.
 */
import { type VNode } from "aio/air";
import { voice, voiceKey, voiceReady } from "../cell/voice.ts";
import { IconMic } from "./icons.tsx";

/** How the held key reads on screen. `ControlRight` is not a phrase. */
export function keyLabel(code: string): string {
  if (code === "ControlRight") return "Right Ctrl";
  if (code === "ControlLeft") return "Left Ctrl";
  if (code === "AltRight") return "Right Alt";
  if (code === "AltLeft") return "Left Alt";
  if (code === "ShiftRight") return "Right Shift";
  if (code === "ContextMenu") return "Menu";
  if (code.startsWith("Key")) return code.slice(3);
  return code;
}

/**
 * A button that is mostly an indicator.
 *
 * Clicking it does nothing on purpose: push-to-talk is a HELD key, and a
 * click-to-start button would be a second, different way to record with a
 * different way of stopping. It is here to say the feature exists, which key
 * runs it, and — while you speak — that the microphone can actually hear you.
 * A meter that never moves is the fastest way to discover a muted input.
 */
export function Mic(_props: { key?: string } = {}): VNode {
  const on = voiceReady();
  const status = voice.status;
  const level = voice.level;
  const hint = !on
    ? "Set up a speech server in Settings to talk to this"
    : status === "recording"
    ? "Listening — let go to send"
    : status === "transcribing"
    ? "Working out what you said…"
    : status === "queued"
    ? "Waiting for the reply to finish, then sending"
    : status === "error"
    ? voice.error ?? "Speech failed"
    : `Hold ${keyLabel(voiceKey())} and speak`;

  return (
    <span
      class={`mic mic--${status}`}
      title={hint}
      aria-label={hint}
      hidden={!on}
    >
      <span class="mic__icon">{IconMic({ size: 14 })}</span>
      {
        /* The meter fills the ring behind the icon. Scaled, not sized: a
          transform is composited, and this updates many times a second while
          a page is otherwise busy streaming a reply. */
      }
      <span
        class="mic__level"
        style={{ transform: `scale(${(0.25 + level * 0.75).toFixed(3)})` }}
      />
    </span>
  );
}
