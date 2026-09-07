/**
 * @module
 * Words that were spoken, put where they can be read before they are sent.
 */
import { afterRender } from "aio/air";
import { voice } from "../cell/voice.ts";
import { appendToComposer } from "./compose.ts";

/**
 * Move a finished transcription into the composer.
 *
 * Appended, never sent. Speech recognition is wrong often enough about names,
 * paths and flags that a person has to see it first — and "wrong instruction,
 * already running" is a considerably worse outcome than "wrong instruction,
 * sitting in a box".
 *
 * Appended rather than replacing, so speaking after typing adds to what you
 * were writing instead of throwing it away.
 */
export function useHeardText(): void {
  // Read HERE, in the render body of whatever called this — not inside the
  // effect below.
  //
  // A component subscribes only to what its render body touches. An effect
  // that reads a cell subscribes to nothing, so it runs once and then never
  // again, however much the value changes. The transcription arrived, the cell
  // held it, and the effect that was supposed to notice never ran a second
  // time. (The terminal had the identical bug, for the identical reason.)
  //
  // `turn` is also what makes two identical sentences two events rather than
  // one: saying "run the tests" twice should type it twice, and only a counter
  // can tell those apart.
  const turn = voice.turn;
  const text = voice.text;
  afterRender(() => {
    if (turn === 0 || text === "") return;
    if (!appendToComposer(text)) {
      // Nowhere to put it. The words are kept — the next render on a page with
      // a composer will place them — but silence here is what makes voice feel
      // broken, so it is named.
      voice.notSent("Heard you, but this page has nowhere to type.");
      return;
    }
    voice.taken();
    if (voice.config.autoSend) sendIt();
  });
}

/**
 * Press the composer's own Send button.
 *
 * Clicked rather than reimplemented: each page already knows what sending
 * means for it — one talks to a session, the other to a local model, and both
 * clear the draft on the way. Repeating that here would be two more copies to
 * keep in step.
 *
 * It also inherits the button's own judgement for free. Send is disabled while
 * a turn is running and while there is nothing to send, so speaking over a
 * reply queues nothing instead of interrupting it.
 *
 * After the render, so the value is in the box before anything reads it back.
 */
/**
 * Send as soon as sending is possible.
 *
 * Not "try once and give up". Send is disabled for as long as a reply is
 * running, and with auto-send on that covers most of the moments you would
 * want to speak again — so a single attempt meant the second thing you said
 * did nothing, which is exactly how this felt: works, then does not.
 *
 * So it waits for the button, and keeps waiting. Polling rather than anything
 * cleverer because the thing being waited for is a DOM attribute on a button
 * another component owns, and a poll is a line of code with no way to leak a
 * subscription.
 *
 * It gives up if the words stop being the words it queued — you edited them,
 * or sent them yourself. Whatever is in the box then is yours, not this
 * function's to send.
 */
let waiting: ReturnType<typeof setInterval> | null = null;

function sendIt(): void {
  if (typeof document === "undefined") return;
  const box = () =>
    document.querySelector<HTMLTextAreaElement>(".composer textarea");
  const btn = () =>
    document.querySelector<HTMLButtonElement>(".composer .composer__send");

  const queued = box()?.value ?? "";
  if (queued === "") return;
  if (waiting !== null) clearInterval(waiting);

  let announced = false;
  // Three minutes. Long enough for any reply worth waiting behind, short
  // enough that a forgotten one cannot outlive the conversation it belongs to.
  let left = 3 * 60 * 1000 / 120;

  const tick = () => {
    const b = btn();
    const current = box()?.value ?? "";
    // Somebody else dealt with it — sent, cleared, or rewritten.
    if (current !== queued) return stop();
    if (b && !b.disabled) {
      b.click();
      // Back to plain idle — only if this ever said "queued"; otherwise the
      // cell is already idle and there is nothing to undo.
      if (announced) voice.sent();
      return stop();
    }
    if (--left <= 0) {
      voice.notSent("Heard you — press Enter, this is taking a while.");
      return stop();
    }
    // Said once, not every tick, and only after the first attempt has actually
    // failed: an instant "queued" on the happy path would be a flicker.
    if (!announced) {
      announced = true;
      voice.queued();
    }
  };
  const stop = () => {
    if (waiting !== null) clearInterval(waiting);
    waiting = null;
  };
  waiting = setInterval(tick, 120);
  tick();
}
