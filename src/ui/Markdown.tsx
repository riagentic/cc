/**
 * @module
 * Renders the Markdown AST to AIR nodes — never to an HTML string, so every
 * piece of model output is escaped by construction.
 */
import { useLocal, type VNode } from "aio/air";
import {
  type Block,
  type Inline,
  parseMarkdown,
  pathish,
} from "../lib/markdown.ts";
import { highlight } from "../lib/highlight.ts";
import { Copy } from "./parts.tsx";
import { workspace } from "../cell/workspace.ts";
import { showToast } from "./toast.tsx";

export function Markdown(props: { source: string }): VNode {
  return <div class="md">{parseMarkdown(props.source).map(renderBlock)}</div>;
}

function renderBlock(b: Block, i: number): VNode {
  switch (b.t) {
    case "h": {
      const size = [1.35, 1.2, 1.08, 1, 0.95, 0.9][b.level - 1] ?? 1;
      return (
        <div
          key={i}
          class="md__h"
          role="heading"
          aria-level={b.level}
          style={{ fontSize: `${size}em` }}
        >
          {b.v.map(renderInline)}
        </div>
      );
    }
    // Code is the thing people take out of a transcript most often, and
    // selecting it by hand out of a scrolling chat is the worst way to do it —
    // hence the copy control pinned to the block.
    case "pre":
      return <CodeBlock key={i} lang={b.lang} code={b.v} />;
    case "list": {
      // A task list loses its bullet: the box IS the marker, and a bullet
      // beside a checkbox is two markers for one item.
      const item = (content: Inline[], n: number) => {
        const done = b.checks[n];
        return (
          <li key={n} class={done === null ? undefined : "md__task"}>
            {done !== null && (
              <span
                class={"md__box" + (done ? " on" : "")}
                aria-hidden="true"
              >
                {done ? "✓" : ""}
              </span>
            )}
            {content.map(renderInline)}
          </li>
        );
      };
      return b.ordered
        ? (
          <ol key={i} class="md__list">
            {b.items.map(item)}
          </ol>
        )
        : (
          <ul
            key={i}
            class={"md__list" +
              (b.checks.every((c) => c !== null) && b.checks.length > 0
                ? " md__list--tasks"
                : "")}
          >
            {b.items.map(item)}
          </ul>
        );
    }
    case "quote":
      return (
        <blockquote key={i} class="md__quote">
          {b.v.map(renderInline)}
        </blockquote>
      );
    case "table":
      return (
        // Wrapped, and the wrapper is what scrolls: a wide table inside a chat
        // column must not push the whole page sideways.
        <div key={i} class="md__tablewrap">
          <table class="md__table">
            <thead>
              <tr>
                {b.head.map((cell, n) => (
                  <th key={n} style={{ textAlign: b.align[n] ?? "left" }}>
                    {cell.map(renderInline)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {b.rows.map((row, r) => (
                <tr key={r}>
                  {row.map((cell, n) => (
                    <td key={n} style={{ textAlign: b.align[n] ?? "left" }}>
                      {cell.map(renderInline)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "hr":
      return <hr key={i} class="md__hr" />;
    case "p":
      return <p key={i} class="md__p">{b.v.map(renderInline)}</p>;
  }
}

function renderInline(n: Inline, i: number): VNode | string {
  switch (n.t) {
    case "text":
      return n.v;
    case "code":
      return <InlineCode key={i} text={n.v} />;
    case "strong":
      return <strong key={i}>{n.v.map(renderInline)}</strong>;
    case "em":
      return <em key={i}>{n.v.map(renderInline)}</em>;
    case "del":
      return <del key={i}>{n.v.map(renderInline)}</del>;
    case "link":
      return (
        <a
          key={i}
          class="md__a"
          href={n.href}
          target="_blank"
          rel="noopener noreferrer"
        >
          {n.v.map(renderInline)}
        </a>
      );
  }
}

/**
 * Inline code — and, when it names a file, a way to open it.
 *
 * Agents write paths constantly, and every one of them is a small dead end:
 * you read `src/cell/session.ts:412`, and then you go and find it yourself. A
 * code span that looks like a path becomes a button, and the line number the
 * agent wrote is kept out of the path it opens.
 *
 * Everything that does not pass the test in `pathish` stays exactly what it
 * was: quoted text. A button that fails to open half of what it offers would
 * be worse than no button at all.
 */
function InlineCode(props: { text: string }): VNode {
  const found = pathish(props.text);
  if (found === null) return <code class="md__code">{props.text}</code>;
  return (
    <button
      type="button"
      class="md__code md__path"
      title={`Open ${found.path}${
        found.line > 0 ? ` (line ${found.line})` : ""
      }`}
      onClick={async () => {
        // Reported here rather than in the Settings banner: this button can be
        // anywhere in a transcript, and a message about it that appears on
        // another page is a message nobody reads.
        const why = await workspace.openPath(found.path);
        if (why !== null) showToast({ text: why, tone: "danger" });
      }}
    >
      {props.text}
    </button>
  );
}

/** Longer than this and a code block is folded on arrival. Chosen to be about
 *  a screenful: the point is that a 400-line file dumped into the answer must
 *  not bury the sentence after it. */
const FOLD_LINES = 24;

/**
 * A fenced code block: language, copy, and a fold for the long ones.
 *
 * The fold is the whole reason this is a component. An agent that reads a file
 * and shows it to you puts hundreds of lines in the middle of a conversation,
 * and the reply underneath — the part written for you — ends up below the
 * fold of your own scroll. Folding keeps the shape of the answer readable and
 * gives back every line on one press.
 */
function CodeBlock(props: { lang: string; code: string }): VNode {
  // Copy always takes the WHOLE block, folded or not: what lands on the
  // clipboard must be the code, not the part of it currently on screen.
  const lines = props.code.split("\n");
  const long = lines.length > FOLD_LINES;
  const [open, setOpen] = useLocal(false);
  const shown = long && !open
    ? lines.slice(0, FOLD_LINES).join("\n")
    : props.code;
  // A stable accessible name. The visible label carries a live line count, and
  // a name that changes with the number is a name no screen-reader user — and
  // no test — can address twice.
  const name = open ? "Fold this code block" : "Show the whole code block";

  return (
    <pre class={"md__pre" + (long && !open ? " md__pre--folded" : "")}>
      {props.lang && <span class="md__lang">{props.lang}</span>}
      <span class="md__copy">
        <Copy text={props.code} />
      </span>
      <code>
        {highlight(shown, props.lang).map((t, n) =>
          t.kind === "plain"
            ? t.text
            : <span key={n} class={`tok tok--${t.kind}`}>{t.text}</span>
        )}
      </code>
      {long && (
        <button
          type="button"
          class="md__more"
          aria-label={name}
          onClick={() => setOpen(!open)}
        >
          {open
            ? `Fold ${lines.length} lines`
            : `Show all ${lines.length} lines`}
        </button>
      )}
    </pre>
  );
}
