/**
 * @module
 * Emptying the conversation on screen.
 */
import { type VNode } from "aio/air";
import { session, view } from "../cell/session.ts";
import { activeIsLocal, local, localChat } from "../cell/local.ts";
import { activeSessionKey } from "../cell/workspace.ts";
import { showToast } from "./toast.tsx";
import { IconTrash } from "./icons.tsx";

/**
 * Clear, with the undo attached to it.
 *
 * The action already existed in Settings and in the palette — which is to say
 * it existed for people who already knew it existed. It belongs next to the
 * conversation it empties.
 *
 * Disabled on an empty transcript rather than hidden: a control that comes and
 * goes is one you have to hunt for, and "nothing to clear" is worth saying by
 * being unpressable.
 *
 * One component for both engines because the promise differs and the gesture
 * does not: clearing the Claude view empties what you can see while the CLI
 * keeps its own memory of the conversation, and clearing a local chat really
 * is a blank slate — the model is sent what is on screen and nothing else.
 */
export function ClearChat(_props: { key?: string } = {}): VNode {
  const isLocal = activeIsLocal();
  // The open chat, not the project: a project holds several conversations,
  // and the project id names only the first of them.
  const key = activeSessionKey();
  const empty = isLocal
    ? localChat(key).messages.length === 0
    : view().messages.length === 0;

  const hint = empty
    ? "Nothing to clear"
    : isLocal
    ? "Empty this conversation — the model is sent what is on screen, so this really is a blank slate"
    : "Empty the view. The CLI keeps its own memory of the conversation";

  return (
    <button
      type="button"
      class="mic clear"
      title={hint}
      aria-label="Clear the conversation"
      disabled={empty}
      onClick={() => {
        if (isLocal) {
          void local.clear(key);
          showToast({
            text: "Conversation cleared.",
            action: { label: "Undo", run: () => void local.undoClear(key) },
          });
          return;
        }
        session.clearTranscript();
        showToast({
          text: "Transcript cleared. The CLI still remembers the conversation.",
          action: { label: "Undo", run: () => session.undoClear() },
        });
      }}
    >
      <span class="mic__icon">{IconTrash({ size: 14 })}</span>
    </button>
  );
}
