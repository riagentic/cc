/**
 * @module
 * A conversation, as Markdown.
 *
 * Two things want this and neither should invent its own: "copy the whole
 * thing" and "save it to a file". They must agree, because the difference
 * would only ever show up in somebody's bug report six weeks later.
 *
 * The format is plain Markdown with a heading per turn — readable as text,
 * pasteable into an issue, and diffable. Tool calls are included as fenced
 * JSON: an answer without the work behind it is half the record, and the whole
 * point of exporting one of these is to show somebody what actually happened.
 */
import type { Block, Message } from "../type/claude.ts";
import type { LocalMsg } from "../type/local.ts";
import { clock } from "./format.ts";

/** One assistant/user turn as Markdown. Thinking is left out: it is the
 *  model's scratch paper, it is enormous, and it is not what anybody is
 *  exporting a conversation to show. */
function blockMd(b: Block): string {
  if (b.kind === "text") return b.text;
  if (b.kind === "tool") {
    const args = JSON.stringify(b.input, null, 2);
    return `**${b.name}**\n\n\`\`\`json\n${args}\n\`\`\``;
  }
  return "";
}

/** A heading that says who and when, in the local timezone the reader is in. */
const head = (who: string, at: number): string => `### ${who} · ${clock(at)}`;

/**
 * The Claude Code transcript.
 *
 * `title` is whatever names the conversation — the project, usually. A file
 * with no first line saying what it is becomes an unopenable mystery three
 * months later.
 */
export function transcriptMarkdown(
  title: string,
  messages: Message[],
): string {
  const out: string[] = [`# ${title}`, ""];
  for (const m of messages) {
    const body = m.blocks.map(blockMd).filter((t) => t !== "").join("\n\n");
    if (body === "") continue;
    out.push(
      head(
        m.role === "user"
          ? "You"
          : m.parentToolUseId
          ? "Claude · sub-agent"
          : "Claude",
        m.at,
      ),
    );
    out.push("", body, "");
  }
  return out.join("\n").trimEnd() + "\n";
}

/** The same, for a local engine's conversation. Its message shape is
 *  deliberately unrelated to the Claude one, so this is a second function
 *  rather than a generic that would have to know about both. */
export function localTranscriptMarkdown(
  title: string,
  messages: LocalMsg[],
): string {
  const out: string[] = [`# ${title}`, ""];
  for (const m of messages) {
    const who = m.role === "user"
      ? "You"
      : m.role === "tool"
      ? `Tool · ${m.toolName ?? "result"}`
      : "Model";
    const calls = (m.toolCalls ?? []).map((c) =>
      `**${c.name}**\n\n\`\`\`json\n${c.args}\n\`\`\``
    );
    const body = [m.text.trim(), ...calls].filter((t) => t !== "").join("\n\n");
    if (body === "") continue;
    out.push(head(who, m.at), "", body, "");
  }
  return out.join("\n").trimEnd() + "\n";
}

/**
 * Does this message match what somebody typed into the find bar?
 *
 * Case-insensitive substring, and nothing cleverer. A transcript search that
 * tokenises or fuzzy-matches finds things the reader did not ask for, and the
 * question being asked here is always "where did I see that word".
 */
export const hits = (text: string, query: string): boolean => {
  const q = query.trim().toLowerCase();
  return q !== "" && text.toLowerCase().includes(q);
};
