/**
 * The reducer layer on a bare ProjectSession — no cell, no boot, no process.
 * These exist to pin the property the extraction bought: protocol behaviour is
 * testable as plain functions, so a reducer bug can be reproduced in three
 * lines instead of a booted session.
 */
import { assertEquals } from "@std/assert";
import type { Evt } from "../../lib/stream.ts";
import {
  assistant,
  blank,
  cap,
  rateLimit,
  reset,
  result,
  system,
} from "../../cell/session-reduce.ts";

const INIT: Evt = {
  type: "system",
  subtype: "init",
  cwd: "/home/dev/code/x",
  session_id: "11111111-2222-3333-4444-555555555555",
  model: "claude-sonnet-5",
  tools: ["Task", "Bash", "Read"],
  agents: ["Explore"],
  skills: [],
  slash_commands: [],
  mcp_servers: [],
  permissionMode: "acceptEdits",
  claude_code_version: "2.1.226",
  memory_paths: {},
} as unknown as Evt;

Deno.test("init fills identity, meta and the fallback window", () => {
  const s = blank();
  s.status = "starting";
  system(s, INIT);
  assertEquals(s.model, "claude-sonnet-5");
  assertEquals(s.cwd, "/home/dev/code/x");
  assertEquals(s.sessionId, "11111111-2222-3333-4444-555555555555");
  assertEquals(s.meta.tools, ["Task", "Bash", "Read"]);
  assertEquals(s.status, "ready");
  assertEquals(s.usage.contextWindow > 0, true);
});

Deno.test("a re-emitted init mid-conversation keeps the measured window", () => {
  const s = blank();
  system(s, INIT);
  s.turns = 3;
  s.usage.contextWindow = 1_000_000; // reported by a result
  system(s, INIT);
  assertEquals(s.usage.contextWindow, 1_000_000);
});

Deno.test("a result closes the turn and books cost and timing", () => {
  const s = blank();
  system(s, INIT);
  s.status = "working";
  s.turnStartedAt = Date.now() - 1000;
  result(s, {
    type: "result",
    subtype: "success",
    is_error: false,
    duration_ms: 1234,
    total_cost_usd: 0.05,
    usage: { input_tokens: 10, output_tokens: 20 },
  } as unknown as Evt);
  assertEquals(s.status !== "working", true);
  assertEquals(s.turnStartedAt, null);
  assertEquals(s.turns, 1);
  assertEquals(s.cost > 0, true);
});

Deno.test("rate limit events land without a turn in flight", () => {
  const s = blank();
  rateLimit(s, {
    type: "rate_limit_event",
    rate_limit: { status: "allowed_warning", unifiedRateLimit: {} },
  } as unknown as Evt);
  // Tolerance is the contract: an unknown payload may be ignored, but it must
  // never corrupt the record it was reduced into.
  assertEquals(s.error, null);
  assertEquals(s.messages.length, 0);
});

Deno.test("reset clears the conversation but keeps the start token", () => {
  const s = blank();
  system(s, INIT);
  s.startToken = 7;
  s.cost = 1;
  reset(s);
  assertEquals(s.messages.length, 0);
  assertEquals(s.cost, 0);
  assertEquals(s.sessionId, null);
  assertEquals(s.startToken, 7);
});

Deno.test("cap keeps the newest entries, in place", () => {
  const list = [1, 2, 3, 4, 5];
  cap(list, 2);
  assertEquals(list, [4, 5]);
});

/** What the CLI itself writes when there is nothing to ask a model: a
 *  usage-limit notice, an interrupt, "No response requested". The `model` is a
 *  sentinel and the `usage` counts nothing (2.1.259). */
const SYNTHETIC: Evt = {
  type: "assistant",
  message: {
    id: "msg_synthetic",
    model: "<synthetic>",
    content: [{
      type: "text",
      text: "You've reached your Fable limit. Switch to another model…",
    }],
    usage: { input_tokens: 0, output_tokens: 0 },
  },
} as unknown as Evt;

Deno.test("a synthetic message is transcribed but measures nothing", () => {
  const s = blank();
  system(s, INIT);
  s.turns = 2;
  s.usage = { ...s.usage, input: 120, output: 40, cacheRead: 33_000 };

  assistant(s, SYNTHETIC);

  // It is a real message and belongs on screen…
  assertEquals(s.messages.length, 1);
  // …but it names no model and counts no tokens, and taking either is how the
  // strip came to report `<synthetic>` as the session's model — a label no
  // model change could budge — and how a limit notice reset a used context
  // back to 0/200k.
  assertEquals(s.model, "claude-sonnet-5");
  assertEquals(s.usage.input, 120);
  assertEquals(s.usage.cacheRead, 33_000);
});
