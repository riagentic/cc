/**
 * @module
 * Completing a slash command as it is typed.
 *
 * The session already knows every command it accepts — the CLI names them in
 * `system/init`, and the catalog finds the files behind them — and until now
 * that list was only readable on a page you had to navigate to. Typing `/` in
 * the composer is the moment somebody wants it.
 *
 * Deliberately prefix-matched and only at the very start of the box. A command
 * is the first thing in a message or it is not a command at all, and a fuzzy
 * match on a control that completes into a *prompt somebody is about to send*
 * would be a way to run the wrong thing.
 */
import type { VNode } from "aio/air";
import { view } from "../cell/session.ts";
import { catalog } from "../cell/catalog.ts";

/** One offer: the command, and whatever the app knows about it. */
export type SlashHit = { name: string; hint: string };

/**
 * The token being typed, or `null` when the box does not hold one.
 *
 * `/` must be the first character and there must be no space yet: after a
 * space the user is writing arguments, and a menu over the words they are
 * typing is a menu in the way.
 */
export function slashToken(value: string): string | null {
  const m = /^\/([A-Za-z0-9:_-]*)$/.exec(value);
  return m ? m[1] : null;
}

/**
 * Commands matching `token`, best first.
 *
 * The CLI's own list leads, because it is what the running session will
 * actually accept; the catalog fills in a description for the ones it found on
 * disk. A command the CLI did not name is not offered at all — completing to
 * something the session will refuse is worse than not completing.
 */
export function slashHits(token: string): SlashHit[] {
  const described = new Map(
    catalog.commands.map((c) => [c.name.replace(/^\//, ""), c.description]),
  );
  const q = token.toLowerCase();
  return view().meta.commands
    .map((raw) => raw.replace(/^\//, ""))
    .filter((name) => name.toLowerCase().startsWith(q))
    .sort((a, b) => a.localeCompare(b))
    .slice(0, 8)
    .map((name) => ({ name, hint: described.get(name) ?? "" }));
}

/** The popover itself, drawn above the composer. */
export function SlashMenu(
  props: {
    hits: SlashHit[];
    index: number;
    onPick: (name: string) => void;
    onHover: (i: number) => void;
  },
): VNode | null {
  if (props.hits.length === 0) return null;
  return (
    <div class="slash" role="listbox" aria-label="Slash commands">
      {props.hits.map((h, i) => (
        <button
          key={h.name}
          type="button"
          role="option"
          aria-selected={i === props.index}
          class={"slash__row" + (i === props.index ? " selected" : "")}
          onMouseEnter={() => props.onHover(i)}
          // `mousedown`, not `click`: the composer loses focus on mousedown,
          // and a blur handler that closes the menu would take the row out
          // from under the pointer before the click ever landed.
          onMouseDown={(e: MouseEvent) => {
            e.preventDefault();
            props.onPick(h.name);
          }}
        >
          <span class="slash__name">/{h.name}</span>
          {h.hint && <span class="slash__hint truncate">{h.hint}</span>}
        </button>
      ))}
    </div>
  );
}
