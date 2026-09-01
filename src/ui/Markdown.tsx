/**
 * @module
 * Renders the Markdown AST to AIR nodes — never to an HTML string, so every
 * piece of model output is escaped by construction.
 */
import type { VNode } from "aio/air";
import { type Block, type Inline, parseMarkdown } from "../lib/markdown.ts";
import { highlight } from "../lib/highlight.ts";
import { Copy } from "./parts.tsx";

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
      return (
        <pre key={i} class="md__pre">
          {b.lang && <span class="md__lang">{b.lang}</span>}
          <span class="md__copy">
            <Copy text={b.v} />
          </span>
          <code>
            {highlight(b.v, b.lang).map((t, n) =>
              t.kind === "plain"
                ? t.text
                : <span key={n} class={`tok tok--${t.kind}`}>{t.text}</span>
            )}
          </code>
        </pre>
      );
    case "list":
      return b.ordered
        ? (
          <ol key={i} class="md__list">
            {b.items.map((item, n) => <li key={n}>{item.map(renderInline)}
            </li>)}
          </ol>
        )
        : (
          <ul key={i} class="md__list">
            {b.items.map((item, n) => <li key={n}>{item.map(renderInline)}
            </li>)}
          </ul>
        );
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
      return <code key={i} class="md__code">{n.v}</code>;
    case "strong":
      return <strong key={i}>{n.v.map(renderInline)}</strong>;
    case "em":
      return <em key={i}>{n.v.map(renderInline)}</em>;
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
