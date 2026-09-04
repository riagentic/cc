/**
 * Exporting a conversation.
 *
 * The two exporters have one job that is easy to get subtly wrong: a file
 * somebody keeps must contain the work, not just the answers. So the tool
 * calls are in it, thinking is not, and the whole thing says which project it
 * came from.
 */
import { assert, assertEquals } from "@std/assert";
import {
  hits,
  localTranscriptMarkdown,
  transcriptMarkdown,
} from "../../lib/transcript.ts";
import type { Message } from "../../type/claude.ts";
import type { LocalMsg } from "../../type/local.ts";

const at = Date.parse("2026-01-02T10:11:00Z");

Deno.test("a transcript carries the work, not only the answer", () => {
  const messages: Message[] = [
    {
      id: "1",
      role: "user",
      at,
      parentToolUseId: null,
      blocks: [{ kind: "text", text: "what changed?" }],
    },
    {
      id: "2",
      role: "assistant",
      at,
      parentToolUseId: null,
      blocks: [
        { kind: "thinking", text: "long private reasoning" },
        {
          kind: "tool",
          id: "t1",
          name: "Bash",
          input: { command: "git diff" },
        },
        { kind: "text", text: "One file." },
      ],
    },
  ];
  const md = transcriptMarkdown("cc", messages);

  assert(md.startsWith("# cc\n"), "it says what it is");
  assert(md.includes("what changed?"));
  assert(md.includes("One file."));
  // The call is part of the record — an answer without the work behind it is
  // half of what somebody exports a conversation to show.
  assert(md.includes("**Bash**"));
  assert(md.includes('"command": "git diff"'));
  // Thinking is the model's scratch paper, and enormous.
  assertEquals(md.includes("long private reasoning"), false);
});

Deno.test("a sub-agent's turn is labelled as one", () => {
  const md = transcriptMarkdown("cc", [{
    id: "1",
    role: "assistant",
    at,
    parentToolUseId: "toolu_9",
    blocks: [{ kind: "text", text: "found it" }],
  }]);
  assert(md.includes("sub-agent"), md);
});

Deno.test("a message with nothing in it is left out entirely", () => {
  const md = transcriptMarkdown("cc", [{
    id: "1",
    role: "assistant",
    at,
    parentToolUseId: null,
    blocks: [{ kind: "thinking", text: "only thinking" }],
  }]);
  // A heading with no body under it is a heading that says nothing.
  assertEquals(md.trim(), "# cc");
});

Deno.test("the local exporter keeps tool calls and their results", () => {
  const messages: LocalMsg[] = [
    { id: "1", role: "user", text: "list the files", at },
    {
      id: "2",
      role: "assistant",
      text: "",
      at,
      toolCalls: [{ id: "c1", name: "ls", args: '{"path":"."}' }],
    },
    {
      id: "3",
      role: "tool",
      text: "a.ts\nb.ts",
      at,
      toolCallId: "c1",
      toolName: "ls",
    },
  ];
  const md = localTranscriptMarkdown("ollama-test", messages);
  assert(md.includes("# ollama-test"));
  assert(md.includes("**ls**"));
  assert(md.includes("Tool · ls"));
  assert(md.includes("a.ts"));
});

Deno.test("find matches whole words and fragments, and never nothing", () => {
  assertEquals(hits("The quick brown fox", "QUICK"), true);
  assertEquals(hits("The quick brown fox", "own f"), true);
  assertEquals(hits("The quick brown fox", "cat"), false);
  // An empty query matches nothing rather than everything — otherwise opening
  // the bar would report every message as a hit.
  assertEquals(hits("anything", ""), false);
  assertEquals(hits("anything", "   "), false);
});
