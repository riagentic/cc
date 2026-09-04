/**
 * @module
 * What an edit actually changes, drawn as a diff.
 *
 * The Edit tool sends `old_string` and `new_string`, and both used to be shown
 * as raw JSON: two walls of escaped text with the difference somewhere inside
 * them. Somebody approving an edit — or reading back what one did — is asking
 * a single question, and it is not "what is in this file".
 *
 * Colour is not the only signal: every line carries a `+` or `-` too, because
 * a red line and a green line are the same line to a good fraction of readers.
 */
import type { VNode } from "aio/air";
import { collapse, diffLines, diffStat } from "../lib/diff.ts";

/** Whether this tool call is an edit this component can draw. */
export const isEdit = (input: Record<string, unknown>): boolean =>
  typeof input.old_string === "string" && typeof input.new_string === "string";

export function DiffView(
  props: { before: string; after: string },
): VNode | null {
  const lines = diffLines(props.before, props.after);
  // Too big to diff: the caller falls back to showing the raw input, which is
  // exactly what it did before this existed.
  if (lines === null) return null;
  const stat = diffStat(lines);

  return (
    <div class="diff">
      <div class="diff__stat">
        <span class="diff__plus">+{stat.added}</span>
        <span class="diff__minus">−{stat.removed}</span>
      </div>
      <pre class="diff__body">
        {collapse(lines).map((l, n) =>
          l.kind === "gap"
            ? <div key={n} class="diff__gap">{l.text}</div>
            : (
              <div key={n} class={`diff__line diff__line--${l.kind}`}>
                <span class="diff__sign">
                  {l.kind === "add" ? "+" : l.kind === "del" ? "−" : " "}
                </span>
                {l.text === "" ? " " : l.text}
              </div>
            )
        )}
      </pre>
    </div>
  );
}
