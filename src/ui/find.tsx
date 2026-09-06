/**
 * @module
 * Finding a word in the conversation you are looking at.
 *
 * Deliberately not the browser's own Ctrl+F. That searches the *rendered* page,
 * which here means it also searches the rail, the dock, the tool arguments
 * folded shut and the code block that is currently folded away — and it cannot
 * tell you "message 3 of 11", which is the only number that helps when you are
 * looking for something you said an hour ago.
 *
 * State lives in module signals rather than in the page, because the shortcut
 * that opens it is global and the bar it opens belongs to whichever transcript
 * is on screen. Neither engine's page owns it.
 */
import { signal, type VNode } from "aio/air";
import { IconChevron, IconSearch, IconX } from "./icons.tsx";

const open = signal(false);
const query = signal("");
/** Which match is current, as an index into whatever the page matched. */
const index = signal(0);

export const findOpen = (): boolean => open.get();
export const findQuery = (): string => query.get();
export const findIndex = (): number => index.get();

export function openFind(): void {
  open.set(true);
}

export function closeFind(): void {
  open.set(false);
  query.set("");
  index.set(0);
}

/** Move to the next or previous match, wrapping. Wrapping is right here and
 *  wrong in the project list: a search has a natural cycle, and "next" with
 *  nowhere to go is a dead key. */
export function stepFind(by: number, total: number): void {
  if (total === 0) return;
  index.set(((index.peek() + by) % total + total) % total);
}

/** The bar itself. `total` is how many messages the page matched — it is the
 *  page that knows what a "match" is, not this. */
export function FindBar(props: { total: number }): VNode | null {
  if (!open.get()) return null;
  const q = query.get();
  const at = props.total === 0 ? 0 : index.get() + 1;

  return (
    <div class="find">
      <span class="find__icon">{IconSearch({ size: 14 })}</span>
      <input
        class="find__input"
        type="text"
        value={q}
        placeholder="Find in this conversation…"
        aria-label="Find in this conversation"
        autoComplete="off"
        spellcheck={false}
        // Focused as soon as it exists: the bar appears because somebody
        // pressed a key asking for it, so the caret belongs here and nowhere
        // else.
        ref={(el: HTMLElement | null) => el?.focus()}
        onInput={(e) => {
          query.set((e.target as HTMLInputElement).value);
          index.set(0);
        }}
        onKeyDown={(e: KeyboardEvent) => {
          if (e.key === "Escape") {
            e.preventDefault();
            closeFind();
          } else if (e.key === "Enter") {
            e.preventDefault();
            stepFind(e.shiftKey ? -1 : 1, props.total);
          }
        }}
      />
      <span class="find__count">
        {
          /* Never "": see the note in TreePage — an empty text child renders
          to no node, and the reconciler loses its place. */
        }
        {q.trim() === "" ? "\u00a0" : `${at} / ${props.total}`}
      </span>
      <button
        type="button"
        class="btn btn--ghost btn--sm btn--icon"
        aria-label="Previous match"
        title="Previous match — Shift+Enter"
        disabled={props.total === 0}
        onClick={() => stepFind(-1, props.total)}
      >
        <span style={{ transform: "rotate(-90deg)", display: "flex" }}>
          {IconChevron({ size: 13 })}
        </span>
      </button>
      <button
        type="button"
        class="btn btn--ghost btn--sm btn--icon"
        aria-label="Next match"
        title="Next match — Enter"
        disabled={props.total === 0}
        onClick={() => stepFind(1, props.total)}
      >
        <span style={{ transform: "rotate(90deg)", display: "flex" }}>
          {IconChevron({ size: 13 })}
        </span>
      </button>
      <button
        type="button"
        class="btn btn--ghost btn--sm btn--icon"
        aria-label="Close find"
        title="Close — Esc"
        onClick={closeFind}
      >
        {IconX({ size: 13 })}
      </button>
    </div>
  );
}
