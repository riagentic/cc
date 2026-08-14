/**
 * @module
 * Renders the Markdown AST to AIR nodes — never to an HTML string, so every
 * piece of model output is escaped by construction.
 */
import type { VNode } from "aio/air";
import { type Block, type Inline, parseMarkdown } from "../lib/markdown.ts";
import { highlight } from "../lib/highlight.ts";

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
    case "pre":
      return (
        <pre key={i} class="md__pre">
          {b.lang && <span class="md__lang">{b.lang}</span>}
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
