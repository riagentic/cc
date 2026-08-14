/**
 * The protocol readers, tested against payloads captured from a real
 * `claude --output-format stream-json` run (CLI 2.1.226) — not from memory.
 */
import { assertEquals } from "@std/assert";
import {
  blocksOf,
  contextUsed,
  contextWindowOf,
  fallbackWindow,
  INTERRUPT_PREFIX,
  isAgentTool,
  isInterruptAck,
  parseLine,
  resultText,
  toolDetail,
  toolTitle,
  usageOf,
} from "../../lib/stream.ts";

Deno.test("parseLine — JSON only, noise is dropped rather than thrown", () => {
  assertEquals(parseLine(`{"type":"system"}`), { type: "system" });
  assertEquals(parseLine(""), null);
  assertEquals(parseLine("connecting to ws://…"), null);
  assertEquals(parseLine(`{"type":"sys`), null); // truncated tail
  assertEquals(parseLine("[1,2]"), null); // valid JSON, wrong shape
});

Deno.test("blocksOf — text, thinking and tool_use from one assistant message", () => {
  const message = {
    content: [
      { type: "thinking", thinking: "considering", signature: "sig" },
      { type: "text", text: "Hello" },
      { type: "text", text: "" }, // empty blocks carry nothing
      {
        type: "tool_use",
        id: "toolu_01",
        name: "Bash",
        input: { command: "ls -la", description: "List files" },
      },
    ],
  };
  assertEquals(blocksOf(message), [
    { kind: "thinking", text: "considering" },
    { kind: "text", text: "Hello" },
    {
      kind: "tool",
      id: "toolu_01",
      name: "Bash",
      input: { command: "ls -la", description: "List files" },
    },
  ]);
});

Deno.test("blocksOf — tool_result, both success and error", () => {
  assertEquals(
    blocksOf({
      content: [{
        type: "tool_result",
        tool_use_id: "toolu_01",
        content: "total 4",
      }],
    }),
    [{ kind: "result", id: "toolu_01", ok: true, text: "total 4" }],
  );
  assertEquals(
    blocksOf({
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_02",
          content: "boom",
          is_error: true,
        },
      ],
    }),
    [{ kind: "result", id: "toolu_02", ok: false, text: "boom" }],
  );
});

Deno.test("blocksOf — malformed input yields no blocks, never throws", () => {
  assertEquals(blocksOf(undefined), []);
  assertEquals(blocksOf({ content: "not an array" }), []);
  assertEquals(blocksOf({ content: [null, 7, { type: "mystery" }] }), []);
});

Deno.test("resultText — string form and content-block form", () => {
  assertEquals(resultText("plain"), "plain");
  assertEquals(
    resultText([{ type: "text", text: "a" }, { type: "image" }, {
      type: "text",
      text: "b",
    }]),
    "a\nb",
  );
  assertEquals(resultText(undefined), "");
});

Deno.test("usageOf + contextUsed — cache reads occupy the window", () => {
  const usage = usageOf({
    input_tokens: 2,
    cache_creation_input_tokens: 9_399,
    cache_read_input_tokens: 24_018,
    output_tokens: 10,
  }, 200_000);
  assertEquals(usage, {
    input: 2,
    output: 10,
    cacheRead: 24_018,
    cacheCreate: 9_399,
    contextWindow: 200_000,
  });
  assertEquals(contextUsed(usage), 33_429);
});

Deno.test("contextWindowOf — the CLI's own number wins over the fallback", () => {
  const result = {
    modelUsage: {
      "claude-haiku-4-5-20251001": { contextWindow: 200_000 },
      "claude-sonnet-5": { contextWindow: 1_000_000 },
    },
  };
  assertEquals(contextWindowOf(result, 200_000), 1_000_000);
  assertEquals(contextWindowOf({}, 200_000), 200_000);
  assertEquals(contextWindowOf({ modelUsage: "junk" }, 12_345), 12_345);

  // …but the session's own model is the window the transcript is filling. The
  // map covers every model the turn touched, so the sonnet row above belongs to
  // a sub-agent, and taking it widened the meter for a 200k conversation.
  const haiku = "claude-haiku-4-5-20251001";
  assertEquals(contextWindowOf(result, 999, haiku), 200_000);
  // The alias matches the full id it names, in either direction…
  assertEquals(contextWindowOf(result, 999, "haiku"), 200_000);
  // …as does the `canonicalModel` each entry carries.
  assertEquals(
    contextWindowOf(
      {
        modelUsage: {
          "srv/model-x": {
            contextWindow: 400_000,
            canonicalModel: "claude-fable-5",
          },
        },
      },
      999,
      "claude-fable-5",
    ),
    400_000,
  );
  // A model the map says nothing about falls back to the largest it does report.
  assertEquals(contextWindowOf(result, 999, "claude-opus-5"), 1_000_000);
});

Deno.test("fallbackWindow — matches on the alias inside a full model id", () => {
  assertEquals(fallbackWindow("claude-sonnet-5"), 200_000);
  assertEquals(fallbackWindow(null), 200_000);
  assertEquals(fallbackWindow("something-unknown"), 200_000);
  // The long-context variant says so in its id, and that suffix is the only
  // thing to read it from until the first result reports a real figure.
  assertEquals(fallbackWindow("claude-opus-5[1m]"), 1_000_000);
  assertEquals(fallbackWindow("claude-sonnet-5[1M]"), 1_000_000);
});

Deno.test("isAgentTool — only the delegating tools", () => {
  assertEquals(isAgentTool("Task"), true);
  assertEquals(isAgentTool("Agent"), true);
  assertEquals(isAgentTool("Bash"), false);
  assertEquals(isAgentTool("TaskCreate"), false); // a task tool, not a sub-agent
});

Deno.test("toolTitle — the most human field available, falling back to the name", () => {
  assertEquals(
    toolTitle("Bash", { description: "List files", command: "ls" }),
    "List files",
  );
  assertEquals(toolTitle("Bash", { command: "ls -la" }), "ls -la");
  assertEquals(toolTitle("Read", { file_path: "/a/b.ts" }), "/a/b.ts");
  assertEquals(toolTitle("Mystery", {}), "Mystery");
});

Deno.test("toolTitle — a long path keeps the file, not the machine", () => {
  const deep = `/tmp/claude-1000/-home-dev-code-gen-cc/${
    "x".repeat(60)
  }/probe/note.txt`;
  const title = toolTitle("Read", { file_path: deep });
  assertEquals(title.length <= 90, true);
  assertEquals(title.endsWith("/probe/note.txt"), true);
  // The same rule inside the detail line, where the cap is tighter.
  const detail = toolDetail("Read", { file_path: deep });
  assertEquals(detail.includes("note.txt"), true);
});

Deno.test("toolDetail — sub-agents name their type, tools summarise their input", () => {
  assertEquals(
    toolDetail("Task", { subagent_type: "Explore", prompt: "find the bug" }),
    "Explore · find the bug",
  );
  assertEquals(
    toolDetail("Read", { file_path: "/a/b.ts" }),
    "file_path=/a/b.ts",
  );
  assertEquals(toolDetail("Bash", { description: "only a description" }), "");
});

Deno.test("isInterruptAck — the id says which request the CLI just answered", () => {
  // Captured from 2.1.232: the `initialize` handshake is acknowledged with the
  // exact envelope an interrupt gets, and only the echoed id separates them.
  const handshake = {
    type: "control_response",
    response: {
      subtype: "success",
      request_id: "cc-init-1234",
      response: { commands: [], output_style: "default" },
    },
  };
  assertEquals(isInterruptAck(handshake), false);
  assertEquals(
    isInterruptAck({
      type: "control_response",
      response: { subtype: "success", request_id: `${INTERRUPT_PREFIX}1` },
    }),
    true,
  );
  // A refused interrupt is not an acknowledged one.
  assertEquals(
    isInterruptAck({
      type: "control_response",
      response: { subtype: "error", request_id: `${INTERRUPT_PREFIX}1` },
    }),
    false,
  );
  assertEquals(isInterruptAck({ type: "result" }), false);
  assertEquals(isInterruptAck({ type: "control_response" }), false);
});
