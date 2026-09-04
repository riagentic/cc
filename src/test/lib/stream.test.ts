/**
 * The protocol readers, tested against payloads captured from a real
 * `claude --output-format stream-json` run (CLI 2.1.226) — not from memory.
 */
import { assertEquals } from "@std/assert";
import {
  agentResultOf,
  blocksOf,
  contextUsed,
  contextWindowOf,
  controlError,
  fallbackWindow,
  INTERRUPT_PREFIX,
  isAgentTool,
  isInterruptAck,
  isModelAck,
  isSynthetic,
  MODEL_PREFIX,
  modelOf,
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
  // A model the map says nothing about keeps the caller's fallback, which was
  // read from that same model id. Borrowing another model's number would let a
  // sub-agent's window stand in for the session's — the over-statement below.
  assertEquals(contextWindowOf(result, 999, "claude-opus-5"), 999);
  // With no model to attribute the turn to, the largest reported window is the
  // only guess available, and still beats a bare default.
  assertEquals(contextWindowOf(result, 999), 1_000_000);

  // A sub-agent on the long-context variant of the *same* model must not widen
  // the meter: `claude-sonnet-5[1m]` contains `claude-sonnet-5`, so a loose
  // match alone reported a 1M window for a 200k conversation.
  const withLong = {
    modelUsage: {
      "claude-sonnet-5": { contextWindow: 200_000 },
      "claude-sonnet-5[1m]": { contextWindow: 1_000_000 },
    },
  };
  assertEquals(contextWindowOf(withLong, 999, "claude-sonnet-5"), 200_000);
  // …and the long-context session still reads its own, larger window.
  assertEquals(
    contextWindowOf(withLong, 999, "claude-sonnet-5[1m]"),
    1_000_000,
  );
  // The alias, too: `sonnet` must not pick up the `[1m]` row.
  assertEquals(contextWindowOf(withLong, 999, "sonnet"), 200_000);
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

Deno.test("agentResultOf — a receipt is how a result opens, not a phrase it contains", () => {
  // An agent reporting *on* async launches quoted the phrase, and the whole
  // answer was thrown away as a launch receipt.
  const prose =
    'I audited the launcher.\n"Async agent launched successfully" ' +
    "is printed before the work starts.\nUse task_completed instead.";
  assertEquals(agentResultOf(prose).launchReceipt, false);
  assertEquals(agentResultOf(prose).text, prose);

  const receipt = "Async agent launched successfully. (internal metadata)\n" +
    "agentId: abc\noutput_file: /tmp/x";
  assertEquals(agentResultOf(receipt).launchReceipt, true);
  assertEquals(agentResultOf(receipt).text, "");
});

Deno.test("agentResultOf — bookkeeping is trimmed from the tail, not the middle", () => {
  // The CLI appends its metadata after the answer. Matching those shapes
  // anywhere deleted a line out of the middle of an agent's own prose.
  const body = "Summary:\nagentId: is a field you should set\ndone";
  assertEquals(agentResultOf(body).text, body);
  assertEquals(
    agentResultOf("answer\nagentId: abc\noutput_file: /x").text,
    "answer",
  );

  // Every usage block is stripped, not only the first — a result can quote
  // another agent's, and the leftover rendered as the answer itself.
  assertEquals(
    agentResultOf("answer\n<usage>tool_uses: 3</usage>\nmore\n<usage>x</usage>")
      .text,
    "answer\n\nmore",
  );

  // The metric lookup is anchored: unanchored, `tool_uses` matched
  // `subagent_tool_uses` first and reported another agent's figure.
  assertEquals(
    agentResultOf("<usage>subagent_tool_uses: 7\ntool_uses: 2</usage>")
      .toolUses,
    2,
  );
  assertEquals(
    agentResultOf("<usage>total_duration_ms: 9000\nduration_ms: 12</usage>")
      .durationMs,
    12,
  );
});

Deno.test("resultText — a bare-string content array is a real shape", () => {
  // Some MCP servers send one; reading only the block shape lost the output
  // entirely, which reads as a tool that returned nothing.
  assertEquals(resultText(["hello", "world"]), "hello\nworld");
  assertEquals(resultText([{ type: "text", text: "a" }]), "a");
  assertEquals(resultText("plain"), "plain");
  assertEquals(resultText(null), "");
});

Deno.test("toolDetail — no separator with nothing on the other side", () => {
  assertEquals(toolDetail("Task", {}), "general");
  assertEquals(
    toolDetail("Task", { subagent_type: "x", prompt: "do it" }),
    "x · do it",
  );
  // `profile` is not a path, and left-truncating it hid its beginning.
  assertEquals(
    toolDetail("X", { profile: `/very/long/${"a".repeat(60)}/end` }).startsWith(
      "profile=/very",
    ),
    true,
  );
});

Deno.test("modelOf — the picker's family behind the id the CLI reports", () => {
  // The two vocabularies that have to meet: `--model haiku` goes out, a full
  // id comes back. Comparing them raw called every session mismatched, and
  // printing the raw one put an id nobody chose where a choice belongs.
  assertEquals(modelOf("claude-haiku-4-5-20251001")?.id, "haiku");
  assertEquals(modelOf("haiku")?.id, "haiku");
  assertEquals(modelOf("claude-opus-5[1m]")?.id, "opus");
  assertEquals(modelOf("<synthetic>"), null);
  assertEquals(modelOf(null), null);
});

Deno.test("isSynthetic — a message the CLI wrote itself measures nothing", () => {
  // 2.1.259 stamps its own messages — a limit notice, an interrupt, "No
  // response requested" — with this sentinel where the model goes.
  assertEquals(isSynthetic({ model: "<synthetic>", usage: {} }), true);
  assertEquals(isSynthetic({ model: "claude-sonnet-5" }), false);
  assertEquals(isSynthetic({}), false);
  assertEquals(isSynthetic(null), false);
});

Deno.test("controlError — a refused request is not a silent one", () => {
  const refused = {
    type: "control_response",
    response: {
      subtype: "error",
      request_id: `${MODEL_PREFIX}1`,
      error: "set_model: model must be a string",
    },
  };
  assertEquals(controlError(refused)?.id, `${MODEL_PREFIX}1`);
  assertEquals(
    controlError(refused)?.error,
    "set_model: model must be a string",
  );
  assertEquals(isModelAck(refused), false);
  // Success is not an error, and an error carries no ack.
  const ok = {
    type: "control_response",
    response: { subtype: "success", request_id: `${MODEL_PREFIX}2` },
  };
  assertEquals(controlError(ok), null);
  assertEquals(isModelAck(ok), true);
  assertEquals(isInterruptAck(ok), false);
  assertEquals(controlError({ type: "result" }), null);
});
