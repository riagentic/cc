/**
 * @module
 * Handing finished messages to the speaker.
 *
 * The counterpart to `heard.ts`, and it lives at the root of the app for the
 * same reason: what gets read aloud is decided by the *active* conversation,
 * whichever page happens to be on screen, and a hook inside one page would go
 * quiet the moment you looked at the tree.
 */
import { afterRender } from "aio/air";
import { speech } from "../cell/speech.ts";
import {
  fromClaude,
  fromLocal,
  type Said,
  startAt,
  toHandOver,
  type Watched,
} from "../lib/aloud.ts";
import { view } from "../cell/session.ts";
import { activeIsLocal, localChat } from "../cell/local.ts";
import { activeSessionKey, workspace } from "../cell/workspace.ts";

/**
 * How far the speaker has got, in each conversation separately.
 *
 * Per conversation, and that is the fix to a real bug: one marker for all of
 * them meant the marker from the chat you just left was nowhere to be found in
 * the chat you just opened, and the guard against reciting an old transcript
 * decided the whole thing — including the line you had just typed — was
 * already read. The first message of every new chat went silently missing.
 *
 * Module-local, like the send-loop's own guard in `heard.ts`, and for the
 * identical reason: a cell is the right place to KEEP a fact and the wrong
 * place to check one against, because the check happens now and a dispatch
 * lands a render later. Every window keeps its own; the cell refuses a message
 * id it has already spoken, which is what stops two windows reading the same
 * reply twice.
 */
const handed = new Map<string, Watched>();

/**
 * Start reading, from here on.
 *
 * Both the speaker button and the palette go through this rather than calling
 * the cell directly, because "on" means two things: the cell starts allowing
 * speech, and every conversation's history stops counting as news. Forgetting
 * the markers is what makes the next paragraph below mark them afresh.
 */
export function startReading(): void {
  handed.clear();
  void speech.on();
}

/** Stop reading, and stop mid-word if it is talking. */
export function stopReading(): void {
  handed.clear();
  void speech.off();
}

/**
 * Read new, finished messages out.
 *
 * Everything is read HERE, in the render body — never inside the effect.
 * A component subscribes only to what its render body touches, so an effect
 * that reads a cell subscribes to nothing and runs exactly once. The
 * transcript would grow, the cell would hold it, and the effect meant to
 * notice would never run again. (Both the terminal and the transcription had
 * this same bug, for this same reason; it is the one mistake this codebase
 * makes twice.)
 *
 * While the speaker is off, nothing but its own switch is read — so an app
 * with speech turned off does not re-render on every token of every reply.
 */
export function useSpokenText(): void {
  const on = speech.status !== "off";
  const readMine = speech.config.readMine;

  let msgs: Said[] = [];
  let working = false;
  let where = "";
  if (on) {
    if (activeIsLocal()) {
      const chat = localChat(workspace.activeId);
      msgs = fromLocal(chat.messages);
      working = chat.status === "working";
      where = `local:${workspace.activeId}`;
    } else {
      msgs = fromClaude(view().messages);
      working = view().status === "working";
      where = `claude:${activeSessionKey()}`;
    }
  }

  afterRender(() => {
    if (!on) return;
    // Keyed by conversation, so the chat you just left cannot mark the chat
    // you just opened as already read.
    const from = startAt(handed.get(where), msgs);
    const { speak, mark } = toHandOver(msgs, from, from, working);
    // Written before anything async, and that is the whole guard: a streaming
    // reply causes dozens of renders, and any marker that only moved when a
    // dispatch committed would let every one of them say it again.
    handed.set(where, { mark, count: msgs.length });
    for (const m of speak) {
      if (m.role === "user" && !readMine) continue;
      // The id travels with it: this map stops a burst of renders in THIS
      // window, and the id stops a second window.
      void speech.say(m.text, m.role === "user" ? "you" : "claude", m.id);
    }
  });
}
