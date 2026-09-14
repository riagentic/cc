/**
 * @module
 * The parts both transcripts share.
 *
 * There are two conversations in this app — the Claude Code session and the
 * local engine — and they are deliberately separate everywhere it counts:
 * different protocols, different cells, different types. What they are not
 * allowed to differ in is *how it feels to read one*. Scrolling, the way back
 * to the bottom, the byline, the copy button: those live here, once, so a
 * habit learned on one works on the other.
 */
import { afterRender, useLocal, useRef, type VNode } from "aio/air";
import { clock } from "../lib/format.ts";
import { Copy } from "./parts.tsx";
import { fillComposer } from "./compose.ts";
import { IconChevron, IconPencil } from "./icons.tsx";

/** How close to the bottom still counts as "following along", in px. Roughly
 *  one message: far enough that a half-scrolled reader is left alone, near
 *  enough that a small nudge does not strand them. */
const STICK_PX = 140;

/**
 * Follow a growing transcript, but only for a reader who is already at the
 * bottom of it.
 *
 * Two representations of one fact, on purpose. The ref is what the scroll
 * handler reads — it fires on every wheel notch, and a render per notch would
 * be a stutter. The signal is what the button reads, and it only changes when
 * the threshold is actually crossed.
 */
export function useStickToBottom(count = 0): {
  ref: { current: HTMLDivElement | null };
  away: boolean;
  /** How many messages have arrived since the reader scrolled away. `0` while
   *  they are at the bottom, where "new" has no meaning. */
  behind: number;
  onScroll: () => void;
  toBottom: () => void;
} {
  const ref = useRef<HTMLDivElement | null>(null);
  const stick = useRef(true);
  const [away, setAway] = useLocal(false);
  // What the transcript held when the reader last had the bottom in view.
  // Kept in a ref: it changes on every message, and a render per message
  // arriving is the cost this whole hook exists to avoid.
  const mark = useRef(count);
  if (!away) mark.current = count;
  const behind = away ? Math.max(0, count - mark.current) : 0;

  const onScroll = () => {
    const el = ref.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <
      STICK_PX;
    stick.current = atBottom;
    if (atBottom === away) setAway(!atBottom);
  };

  afterRender(() => {
    const el = ref.current;
    if (!el || !stick.current) return;
    // Instantly, and every render. A transcript that is being written to grows
    // a few pixels at a time, and anything that animates the follow is a view
    // that chases the bottom without reaching it.
    el.scrollTop = el.scrollHeight;
    // Once more after the frame, because the height at this moment is the
    // height BEFORE the browser has laid out what was just added — a long
    // code block or a table finishes measuring after this callback, and
    // without the second pass the view stops a screenful short of the end.
    // Guarded because this same effect runs under the test DOM, which has no
    // frames to wait for: an afterRender that throws is an afterRender that
    // stopped doing its job at the line above.
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => {
        if (stick.current && ref.current) {
          ref.current.scrollTop = ref.current.scrollHeight;
        }
      });
    }
  });

  return {
    ref,
    away,
    behind,
    onScroll,
    toBottom: () => {
      const el = ref.current;
      if (!el) return;
      stick.current = true;
      setAway(false);
      el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    },
  };
}

/**
 * The way back to the newest message.
 *
 * Reading back through a transcript that is still growing is the one moment a
 * chat can lose you: new text arrives below the fold and nothing says so. This
 * exists only while there is somewhere to go.
 */
export function JumpToLatest(
  props: { away: boolean; behind?: number; onClick: () => void },
): VNode | null {
  if (!props.away) return null;
  const behind = props.behind ?? 0;
  return (
    <button
      type="button"
      class={"jump" + (behind > 0 ? " jump--new" : "")}
      onClick={props.onClick}
      // A stable name: the count is in the label a sighted reader sees, and a
      // name that changes with it is a control no test can address twice.
      aria-label="Jump to the latest message"
      title="Jump to the latest message"
    >
      <span style={{ transform: "rotate(90deg)", display: "inline-flex" }}>
        {IconChevron({ size: 13 })}
      </span>
      {behind > 0
        ? `${behind} new message${behind === 1 ? "" : "s"}`
        : "Latest"}
    </button>
  );
}

/**
 * The quiet half of a message byline: when it arrived, and what you can do
 * with it.
 *
 * Both are invisible until the pointer is on the message. A transcript is for
 * reading, and a row of buttons on every paragraph is a row of buttons nobody
 * reads past. The time can be pinned on in the appearance settings.
 *
 * `onEdit` is offered only for something the reader wrote: putting the model's
 * words in your own message box is a different act, and one nobody asked for.
 */
export function MsgMeta(
  props: { at: number; text: string; editable?: boolean },
): VNode {
  // Always exactly two children, and always the same two. A conditional
  // sibling changes the child COUNT when it flips, and the reconciler pairs
  // the survivors up by position — which desyncs a byline the moment a
  // streaming message goes from empty to having text.
  const empty = props.text.trim() === "";
  return (
    <>
      <span class="msg__time" title={new Date(props.at).toLocaleString()}>
        {clock(props.at)}
      </span>
      <span class="msg__acts" hidden={empty}>
        {empty ? null : <Copy text={props.text} label="Copy" />}
        {empty || !props.editable ? null : (
          <button
            type="button"
            class="btn btn--sm btn--ghost"
            title="Put this turn back in the box to edit and send again"
            onClick={() => fillComposer(props.text)}
          >
            {IconPencil({ size: 12 })} Edit
          </button>
        )}
      </span>
    </>
  );
}
