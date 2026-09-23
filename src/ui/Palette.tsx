/**
 * @module
 * The command palette.
 *
 * It reads `commands.ts`, so it cannot list something that does not work. It
 * is the answer to "where is that button" — in an app with three panels,
 * fifteen pages and two engines, the fastest path to any of them should be the
 * name of the thing you want, typed.
 *
 * Deliberately not a router: a command runs and the overlay closes. Nothing in
 * here holds state that outlives the keystroke.
 */
import { onMount, useLocal, useRef, type VNode } from "aio/air";
import { type Command, commands } from "./commands.ts";
import { matchesAll, Overlay, useSelectedInView } from "./parts.tsx";
import { IconSearch } from "./icons.tsx";

/**
 * Rank matches so typing a couple of letters lands on the obvious thing.
 *
 * Three tiers, and nothing cleverer: a label that starts with what you typed,
 * then a label that contains it, then a match found only in the hidden aliases.
 * Fuzzy subsequence scoring is fun to write and impossible to predict, and a
 * palette you cannot predict is one you stop trusting after the first time it
 * runs the wrong thing.
 */
function rank(c: Command, q: string): number {
  const label = c.label.toLowerCase();
  if (label.startsWith(q)) return 0;
  if (label.includes(q)) return 1;
  return 2;
}

export function CommandPalette(props: { onClose: () => void }): VNode {
  const [query, setQuery] = useLocal("");
  const [sel, setSel] = useLocal(0);
  const input = useRef<HTMLInputElement>(null!);

  const all = commands();
  const q = query.trim().toLowerCase();
  const hits =
    (q
      ? all.filter((c) => matchesAll(query, c.label, c.hint, c.group, c.alias))
      : all)
      .slice()
      .sort((a, b) => (q ? rank(a, q) - rank(b, q) : 0));

  // Clamped rather than reset: filtering down to fewer rows than the cursor
  // index must not leave Enter pointing at nothing.
  const index = Math.min(sel, Math.max(0, hits.length - 1));
  const list = useRef<HTMLDivElement | null>(null);
  const moved = useSelectedInView(list, index);

  onMount(() => {
    input.current?.focus();
  });

  const run = (c: Command | undefined) => {
    if (!c) return;
    props.onClose();
    c.run();
  };

  const onKey = (e: KeyboardEvent) => {
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) moved();
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSel(Math.min(index + 1, hits.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSel(Math.max(index - 1, 0));
    } else if (e.key === "Home") {
      e.preventDefault();
      setSel(0);
    } else if (e.key === "End") {
      e.preventDefault();
      setSel(hits.length - 1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      run(hits[index]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      props.onClose();
    }
  };

  // Group headings are printed when the group *changes*, so the list stays one
  // scrollable column: a palette split into sections cannot be walked with one
  // arrow key without the cursor jumping over headings.
  let last = "";

  return (
    <Overlay onClose={props.onClose} label="Command palette">
      <div class="pal">
        <div class="pal__search">
          <span class="pal__icon">{IconSearch({ size: 15 })}</span>
          <input
            ref={input}
            class="pal__input"
            type="text"
            value={query}
            placeholder="Type a command, a project, a page…"
            aria-label="Command palette"
            autoComplete="off"
            spellcheck={false}
            onInput={(e) => {
              setQuery((e.target as HTMLInputElement).value);
              setSel(0);
            }}
            onKeyDown={onKey}
          />
          <kbd class="kbd">Esc</kbd>
        </div>

        <div class="pal__list" role="listbox" ref={list}>
          {hits.length === 0 && (
            <div class="pal__none" key="none">
              Nothing matches <strong>{query}</strong>.
            </div>
          )}
          {hits.map((c, i) => {
            const head = c.group !== last ? c.group : "";
            last = c.group;
            return (
              <div key={c.id}>
                {head && <div class="pal__group">{head}</div>}
                <button
                  type="button"
                  role="option"
                  aria-selected={i === index}
                  class={"pal__row" + (i === index ? " selected" : "") +
                    (c.danger ? " pal__row--danger" : "")}
                  // Pointer and keyboard agree on one cursor: hovering moves
                  // the selection, so Enter always runs what is highlighted.
                  onMouseEnter={() => setSel(i)}
                  onClick={() => run(c)}
                >
                  <span class="pal__rowicon">{c.icon}</span>
                  <span class="truncate">
                    <span class="pal__label">{c.label}</span>
                    {c.hint && <span class="pal__hint">{c.hint}</span>}
                  </span>
                </button>
              </div>
            );
          })}
        </div>

        <div class="pal__foot">
          <span>
            <kbd class="kbd">↑</kbd> <kbd class="kbd">↓</kbd> to move
          </span>
          <span>
            <kbd class="kbd">↵</kbd> to run
          </span>
        </div>
      </div>
    </Overlay>
  );
}
