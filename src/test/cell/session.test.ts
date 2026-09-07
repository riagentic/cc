/**
 * The protocol reducer, driven with real `stream-json` events (CLI 2.1.226).
 *
 * `ingest` is the whole session model — everything the UI shows is derived from
 * what these events put into state — so it is tested event by event, without
 * spawning a process.
 */
import { assertEquals } from "@std/assert";
import { testCell } from "aio/testing";
import { session } from "../../cell/session.ts";
import {
  blank,
  offlineAgain,
  type ProjectSession,
} from "../../cell/session-reduce.ts";

const SESSION = "441e5bea-4547-42f1-9a5c-11d495c662ff";

const init = {
  type: "system",
  subtype: "init",
  cwd: "/home/dev/code/cc",
  session_id: SESSION,
  model: "claude-sonnet-5",
  tools: ["Task", "Bash", "Read"],
  agents: ["Explore"],
  skills: ["run"],
  slash_commands: ["init", "run"],
  mcp_servers: [{ name: "drive", status: "needs-auth" }],
  permissionMode: "acceptEdits",
  claude_code_version: "2.1.226",
  output_style: "default",
  memory_paths: { auto: "/home/dev/.claude/projects/x/memory/" },
};

const toolUse = (id: string, name: string, input: Record<string, unknown>) => ({
  type: "assistant",
  message: {
    id: `msg_${id}`,
    model: "claude-sonnet-5",
    content: [{ type: "tool_use", id, name, input }],
    usage: {
      input_tokens: 2,
      cache_read_input_tokens: 24_018,
      output_tokens: 10,
    },
  },
  parent_tool_use_id: null,
});

const toolResult = (id: string, content: string, isError = false) => ({
  type: "user",
  message: {
    content: [{
      type: "tool_result",
      tool_use_id: id,
      content,
      is_error: isError,
    }],
  },
});

testCell(
  session,
  "init populates the session identity and capabilities",
  (t) => {
    t.send.ingest(init);
    t.expect.state((s) => s.sessionId === SESSION);
    t.expect.state((s) => s.resumeId === SESSION);
    t.expect.state((s) => s.cwd === "/home/dev/code/cc");
    t.expect.state((s) => s.model === "claude-sonnet-5");
    t.expect.state((s) => s.meta.version === "2.1.226");
    t.expect.state((s) => s.meta.tools.length === 3);
    t.expect.state((s) => s.meta.mcp[0].name === "drive");
    t.expect.state((s) => s.meta.memoryPaths.length === 1);
  },
);

testCell(
  session,
  "init only flips 'starting' to 'ready', never a live turn",
  (t) => {
    t.send.ingest({ type: "system", subtype: "status", status: "requesting" });
    t.expect.state((s) => s.status === "working");
    t.send.ingest(init);
    t.expect.state((s) => s.status === "working"); // a mid-turn re-init must not lie
  },
);

testCell(
  session,
  "assistant blocks of one message merge into one turn",
  (t) => {
    t.send.ingest({
      type: "assistant",
      message: {
        id: "msg_1",
        content: [{ type: "thinking", thinking: "hm" }],
        usage: { input_tokens: 1 },
      },
    });
    t.send.ingest({
      type: "assistant",
      message: { id: "msg_1", content: [{ type: "text", text: "Hello" }] },
    });
    t.expect.state((s) => s.messages.length === 1);
    t.expect.state((s) => s.messages[0].blocks.length === 2);
    t.expect.state((s) => s.messages[0].role === "assistant");
  },
);

testCell(session, "a tool call opens a run and its result closes it", (t) => {
  t.send.ingest(
    toolUse("toolu_01", "Bash", { command: "ls -la", description: "List" }),
  );
  t.expect.state((s) => s.tools.length === 1);
  t.expect.state((s) => s.tools[0].kind === "tool");
  t.expect.state((s) => s.tools[0].title === "List");
  t.expect.state((s) => s.tools[0].endedAt === null);

  t.send.ingest(toolResult("toolu_01", "total 4"));
  t.expect.state((s) => s.tools[0].endedAt !== null);
  t.expect.state((s) => s.tools[0].ok === true);
  t.expect.state((s) => s.tools[0].output === "total 4");
});

testCell(
  session,
  "a failed tool result is recorded as failed, not just done",
  (t) => {
    t.send.ingest(toolUse("toolu_02", "Bash", { command: "boom" }));
    t.send.ingest(toolResult("toolu_02", "<tool_use_error>Blocked", true));
    t.expect.state((s) => s.tools[0].ok === false);
  },
);

testCell(
  session,
  "tool results never appear as user turns in the transcript",
  (t) => {
    t.send.ingest(toolUse("toolu_03", "Read", { file_path: "/a.ts" }));
    t.send.ingest(toolResult("toolu_03", "contents"));
    t.expect.state((s) => s.messages.every((m) => m.role === "assistant"));
  },
);

testCell(session, "Task calls are classified as sub-agents", (t) => {
  t.send.ingest(
    toolUse("toolu_04", "Task", {
      subagent_type: "Explore",
      prompt: "find it",
    }),
  );
  t.expect.state((s) => s.tools[0].kind === "agent");
  t.expect.state((s) => s.tools[0].detail.startsWith("Explore ·"));
});

testCell(
  session,
  "an async sub-agent stays running past its launch receipt",
  (t) => {
    // Captured shape: the CLI acks an async Agent call in ~10ms with "agent
    // launched successfully", then the agent works for another 20 seconds.
    t.send.ingest(
      toolUse("toolu_ag", "Agent", {
        subagent_type: "Explore",
        description: "Summarize src/lib",
      }),
    );
    t.send.ingest({
      type: "system",
      subtype: "task_started",
      task_id: "aff0556",
      tool_use_id: "toolu_ag",
      description: "Summarize src/lib",
      task_type: "local_agent",
    });
    t.send.ingest(toolResult("toolu_ag", "Async agent launched successfully"));

    t.expect.state((s) => s.tools[0].endedAt === null); // still working
    t.expect.state((s) => s.tools[0].taskId === "aff0556");
    // The receipt is the CLI's internal bookkeeping, not the agent's answer —
    // showing it as "what the sub-agent returned" buried the real result.
    t.expect.state((s) => s.tools[0].output === null);

    t.send.ingest({
      type: "system",
      subtype: "task_updated",
      task_id: "aff0556",
      patch: { status: "completed", end_time: 1_786_262_870_720 },
    });
    t.expect.state((s) => s.tools[0].endedAt === 1_786_262_870_720);
    t.expect.state((s) => s.tools[0].ok === true);
  },
);

testCell(
  session,
  "a synchronous tool still closes on its own result",
  (t) => {
    t.send.ingest(toolUse("toolu_sync", "Read", { file_path: "/a.ts" }));
    t.send.ingest(toolResult("toolu_sync", "contents"));
    t.expect.state((s) => s.tools[0].endedAt !== null);
    t.expect.state((s) => s.tools[0].taskId === null);
  },
);

testCell(session, "background tasks: started, updated, and reconciled", (t) => {
  t.send.ingest({
    type: "system",
    subtype: "task_started",
    task_id: "b7i7x1vxp",
    tool_use_id: "toolu_05",
    description: "Sleep 20s",
    task_type: "local_bash",
  });
  t.expect.state((s) => s.tasks.length === 1);
  t.expect.state((s) => s.tasks[0].status === "running");

  t.send.ingest({
    type: "system",
    subtype: "task_updated",
    task_id: "b7i7x1vxp",
    patch: { status: "killed", end_time: 1_786_261_018_840 },
  });
  t.expect.state((s) => s.tasks[0].status === "killed");
  t.expect.state((s) => s.tasks[0].endedAt === 1_786_261_018_840);
});

testCell(
  session,
  "an emptied background list ends tasks we never saw finish",
  (t) => {
    t.send.ingest({
      type: "system",
      subtype: "task_started",
      task_id: "ghost",
      description: "Orphan",
      task_type: "local_bash",
    });
    t.send.ingest({
      type: "system",
      subtype: "background_tasks_changed",
      tasks: [],
    });
    t.expect.state((s) => s.tasks[0].status === "completed");
    t.expect.state((s) => s.tasks[0].endedAt !== null);
  },
);

testCell(
  session,
  "the real outcome corrects the guess the empty list made",
  (t) => {
    // Captured order (2.1.232): the CLI drops the task from
    // `background_tasks_changed` *before* it says how the task ended. Absence
    // only means "gone", so the list infers "completed" — and the call that
    // launched it was then stuck showing a green "done" for a task that failed.
    t.send.ingest(toolUse("toolu_bg", "Bash", { command: "make build" }));
    t.send.ingest({
      type: "system",
      subtype: "task_started",
      task_id: "bfe0ivaf0",
      tool_use_id: "toolu_bg",
      description: "make build",
      task_type: "local_bash",
    });
    t.send.ingest({
      type: "system",
      subtype: "background_tasks_changed",
      tasks: [],
    });
    t.expect.state((s) => s.tools[0].endedAt !== null);
    t.expect.state((s) => s.tools[0].ok === true); // the guess

    t.send.ingest({
      type: "system",
      subtype: "task_updated",
      task_id: "bfe0ivaf0",
      patch: { status: "failed", end_time: 1_786_675_025_697 },
    });
    t.expect.state((s) => s.tasks[0].status === "failed");
    t.expect.state((s) => s.tools[0].ok === false);
    // …and the sharper end time the correction carried, too.
    t.expect.state((s) => s.tools[0].endedAt === 1_786_675_025_697);
    // One close line on the timeline, from the first close — not two.
    t.expect.state((s) =>
      s.activity.filter((a) => a.label === "Bash completed").length === 1
    );
    t.expect.state((s) => !s.activity.some((a) => a.label === "Bash failed"));
  },
);

testCell(
  session,
  "result closes the turn and takes the real context window",
  (t) => {
    t.send.ingest({ type: "system", subtype: "status", status: "requesting" });
    t.send.ingest({
      type: "result",
      subtype: "success",
      is_error: false,
      session_id: SESSION,
      duration_ms: 1_875,
      num_turns: 1,
      total_cost_usd: 0.0643,
      usage: {
        input_tokens: 2,
        cache_creation_input_tokens: 9_399,
        cache_read_input_tokens: 24_018,
        output_tokens: 10,
      },
      modelUsage: { "claude-sonnet-5": { contextWindow: 1_000_000 } },
    });
    t.expect.state((s) => s.status === "ready");
    t.expect.state((s) => s.turns === 1);
    t.expect.state((s) => s.lastTurnMs === 1_875);
    t.expect.state((s) => s.turnStartedAt === null);
    t.expect.state((s) => s.usage.contextWindow === 1_000_000);
    t.expect.state((s) => Math.abs(s.cost - 0.0643) < 1e-9);
  },
);

testCell(
  session,
  "an interrupted turn is not a failure — the session stays usable",
  (t) => {
    t.send.ingest({ type: "system", subtype: "status", status: "requesting" });
    // The CLI acknowledges the interrupt on its control channel…
    t.send.ingest({
      type: "control_response",
      response: { subtype: "success", request_id: "cc-interrupt-1" },
    });
    t.expect.state((s) => s.interrupting === true);
    // …and then reports the aborted turn as an error, which it is not.
    t.send.ingest({
      type: "result",
      is_error: true,
      result: "aborted",
      usage: {},
    });
    t.expect.state((s) => s.status === "ready");
    t.expect.state((s) => s.error === null);
    t.expect.state((s) => s.interrupting === false);
  },
);

testCell(
  session,
  "an interrupted turn keeps the context that was already measured",
  (t) => {
    // Measured on a real turn…
    t.send.ingest({
      type: "result",
      is_error: false,
      usage: {
        input_tokens: 18,
        cache_creation_input_tokens: 7_585,
        cache_read_input_tokens: 45_715,
        output_tokens: 166,
      },
      modelUsage: { "claude-haiku-4-5": { contextWindow: 200_000 } },
    });
    t.expect.state((s) => s.usage.cacheRead === 45_715);
    // …and the aborted turn that follows reports nothing at all (2.1.232).
    // Taking that for zero emptied the meter the moment Stop was pressed.
    t.send.ingest({ type: "result", is_error: true, result: "aborted" });
    t.expect.state((s) => s.usage.cacheRead === 45_715);
    t.expect.state((s) => s.usage.contextWindow === 200_000);
  },
);

testCell(
  session,
  "the startup handshake's ack is not an interrupt",
  (t) => {
    // The CLI answers `initialize` with the same success envelope an interrupt
    // gets (2.1.232), so only the id it echoes tells them apart. Taking this
    // one for an interrupt started every session already "interrupting", and
    // the first failed turn was then reported as one instead of as an error.
    t.send.ingest({
      type: "control_response",
      response: { subtype: "success", request_id: "cc-init-4242" },
    });
    t.expect.state((s) => s.interrupting === false);
    t.expect.state((s) => s.activity.length === 0);

    t.send.ingest({
      type: "result",
      is_error: true,
      result: "boom",
      usage: {},
    });
    t.expect.state((s) => s.error === "boom");
  },
);

testCell(
  session,
  "one tool_use id is one run, however often the CLI re-sends it",
  (t) => {
    t.send.ingest(toolUse("toolu_dup", "Bash", { command: "ls" }));
    t.send.ingest(toolUse("toolu_dup", "Bash", { command: "ls" }));
    t.expect.state((s) => s.tools.length === 1);
    // …and the result still lands on the one run, not on a twin behind it.
    t.send.ingest(toolResult("toolu_dup", "a\nb"));
    t.expect.state((s) => s.tools[0].endedAt !== null);
    t.expect.state((s) => s.tools[0].output === "a\nb");
  },
);

testCell(
  session,
  "interrupt is a no-op unless a turn is actually running",
  async (t) => {
    await t.send.interrupt();
    t.expect.state((s) => s.interrupting === false);
    t.expect.state((s) => s.error === null); // no process, but nothing was asked
  },
);

testCell(session, "a failed turn leaves the session ready, not broken", (t) => {
  t.send.ingest({
    type: "result",
    is_error: true,
    result: "overloaded",
    usage: {},
  });
  t.expect.state((s) => s.status === "ready"); // the process is still alive
  t.expect.state((s) => s.error === "overloaded"); // …and the reason is visible
});

testCell(session, "permission denials are surfaced, never swallowed", (t) => {
  t.send.ingest({
    type: "result",
    is_error: false,
    usage: {},
    permission_denials: [
      {
        tool_name: "Write",
        tool_use_id: "toolu_x",
        tool_input: { file_path: "/a.txt" },
      },
    ],
  });
  t.expect.state((s) => s.status === "ready"); // the turn itself succeeded
  t.expect.state((s) => (s.error ?? "").includes("blocked"));
  t.expect.state((s) => (s.error ?? "").includes("Write"));
  t.expect.state((s) => (s.error ?? "").includes("Allowed directories"));
  t.expect.state((s) =>
    s.activity.some((a) => a.label.startsWith("Permission denied"))
  );
});

testCell(
  session,
  "a denial quotes the CLI's own reason when the tool result carries one",
  (t) => {
    // The blocked Bash call and its error output arrive first…
    t.send.ingest({
      type: "assistant",
      message: {
        id: "msg_d",
        content: [{
          type: "tool_use",
          id: "toolu_blocked",
          name: "Bash",
          input: { command: "echo hi > /tmp/x" },
        }],
      },
    });
    t.send.ingest({
      type: "user",
      message: {
        content: [{
          type: "tool_result",
          tool_use_id: "toolu_blocked",
          is_error: true,
          content:
            "Output redirection to '/tmp/x' was blocked. For security, Claude Code may only write to files in the allowed working directories for this session: '/home/dev/p'.",
        }],
      },
    });
    // …and only then the result that reports the denial.
    t.send.ingest({
      type: "result",
      is_error: false,
      usage: {},
      permission_denials: [{ tool_name: "Bash", tool_use_id: "toolu_blocked" }],
    });
    t.expect.state((s) =>
      (s.error ?? "").includes("allowed working directories")
    );
    t.expect.state((s) => (s.error ?? "").includes("/home/dev/p"));
  },
);

testCell(session, "a clean result reports no denial", (t) => {
  t.send.ingest({
    type: "result",
    is_error: false,
    usage: {},
    permission_denials: [],
  });
  t.expect.state((s) => s.error === null);
});

testCell(session, "rate limit info is kept as milliseconds", (t) => {
  t.send.ingest({
    type: "rate_limit_event",
    rate_limit_info: {
      status: "allowed_warning",
      rateLimitType: "seven_day",
      utilization: 0.5,
      resetsAt: 1_786_676_400,
    },
  });
  t.expect.state((s) => s.rateLimit?.utilization === 0.5);
  t.expect.state((s) => s.rateLimit?.resetsAt === 1_786_676_400_000);
});

testCell(
  session,
  "streaming deltas accumulate then yield to the real block",
  (t) => {
    t.send.delta("text", "Hel");
    t.send.delta("text", "lo");
    t.expect.state((s) => s.streaming?.text === "Hello");
    t.send.delta("thinking", "hm");
    t.expect.state((s) => s.streaming?.kind === "thinking");
    t.expect.state((s) => s.streaming?.text === "hm"); // a new kind starts fresh

    t.send.ingest({
      type: "assistant",
      message: { id: "msg_9", content: [{ type: "text", text: "Hello" }] },
    });
    t.expect.state((s) => s.streaming === null);
  },
);

testCell(
  session,
  "unknown and malformed events are ignored, never fatal",
  (t) => {
    t.send.ingest({
      type: "control_response",
      response: { subtype: "success" },
    });
    t.send.ingest({ type: "brand_new_event_type" });
    t.send.ingest({ type: "assistant" });
    t.send.ingest({
      type: "system",
      subtype: "task_updated",
      task_id: "nope",
      patch: {},
    });
    t.expect.state((s) => s.messages.length === 0);
    t.expect.state((s) => s.tools.length === 0);
    t.expect.state((s) => s.tasks.length === 0);
  },
);

testCell(
  session,
  "clearTranscript empties the view but keeps the session",
  (t) => {
    t.send.ingest(init);
    t.send.ingest({
      type: "assistant",
      message: { id: "msg_1", content: [{ type: "text", text: "hi" }] },
    });
    t.send.clearTranscript();
    t.expect.state((s) => s.messages.length === 0);
    t.expect.state((s) => s.sessionId === SESSION);
  },
);

/**
 * Methods the fuzzer must not call, and why.
 *
 * `armFolderWatch` starts the repeating folder poll. It emits a
 * `schedule.every` effect, `testCell` owns no clock to fire one on, and the
 * executor rightly refuses it — so a fuzz run that happened to pick this key
 * failed on the effect rather than on any invariant. With 32 keys and 120
 * picks that is all but certain, which is why this test failed 5 runs out of 5
 * once the dice fell that way.
 *
 * Excluding it loses nothing this test was ever measuring: it is called once
 * at boot, takes no arguments, writes no state, and has no invariant to break.
 * Everything else is still fuzzed.
 */
const BOOT_ONLY = new Set(["armFolderWatch"]);

testCell(session, "random action fuzzing keeps every invariant", (t) => {
  t.init();
  // `t.randomActions` would include the boot-only method above. This is the
  // same loop with that one held back: a random key, no payload, and whatever
  // state the last one left — a guard refusing the transition is the designed
  // outcome, not a fault.
  // deno-lint-ignore no-explicit-any
  const keys: string[] = ((session as any).__aio?.actionKeys ?? [])
    .filter((k: string) => !BOOT_ONLY.has(k));
  for (let i = 0; i < 120; i++) {
    const key = keys[Math.floor(Math.random() * keys.length)];
    // deno-lint-ignore no-explicit-any
    try {
      void (t.send as any)[key]?.();
    } catch { /* this IS the fuzzer */ }
  }
  t.expect.invariant((s) =>
    Array.isArray(s.messages) && s.messages.length <= 400
  );
  t.expect.invariant((s) => Array.isArray(s.tools) && s.tools.length <= 300);
  t.expect.invariant((s) =>
    Array.isArray(s.activity) && s.activity.length <= 400
  );
  t.expect.invariant((s) => s.usage.contextWindow > 0);
  t.expect.invariant((s) => s.cost >= 0);
});

testCell(
  session,
  "a superseded process cannot bury the session that replaced it",
  (t) => {
    t.init();
    // Restart bumps the token; the OLD process then reports its exit. Before
    // the guard this flipped the fresh session to "offline" and Restart
    // appeared to kill the app.
    t.send.ingest({ type: "system", subtype: "status", status: "requesting" });
    t.expect.state((s) => s.status === "working");

    const stale = t.getState().startToken - 1;
    t.send.exited(0, "", stale);
    t.expect.state((s) => s.status === "working"); // untouched

    // …while the current process's exit is still honoured.
    t.send.exited(0, "", t.getState().startToken);
    t.expect.state((s) => s.status === "offline");
  },
);

testCell(session, "late events from a replaced process are dropped", (t) => {
  t.init();
  const stale = t.getState().startToken - 1;
  t.send.ingest({
    type: "assistant",
    message: {
      id: "ghost",
      content: [{ type: "text", text: "from the past" }],
    },
  }, stale);
  t.expect.state((s) => s.messages.length === 0);
  t.send.delta("text", "ghost text", stale);
  t.expect.state((s) => s.streaming === null);
});

/* ── permissions ──────────────────────────────────────────────────────────── */
//
// The CLI *blocks* on `can_use_tool` — an unanswered request is a hung turn, so
// these shapes are captured verbatim from 2.1.226 rather than paraphrased.

const canUseTool = (id: string, toolUseId: string) => ({
  type: "control_request",
  request_id: id,
  request: {
    subtype: "can_use_tool",
    tool_name: "Write",
    display_name: "Write",
    input: { file_path: "/tmp/x.txt", content: "hello" },
    description: "/tmp/x.txt",
    permission_suggestions: [
      { type: "addDirectories", directories: ["/tmp"], destination: "session" },
    ],
    decision_reason: "Path is outside allowed working directories",
    decision_reason_type: "workingDir",
    tool_use_id: toolUseId,
  },
});

testCell(
  session,
  "a permission request becomes a prompt and marks its tool call",
  (t) => {
    t.send.ingest(toolUse("toolu_p1", "Write", { file_path: "/tmp/x.txt" }));
    t.send.ingest(canUseTool("req-1", "toolu_p1"));

    t.expect.state((s) => s.permissions.length === 1);
    t.expect.state((s) => s.permissions[0].status === "pending");
    t.expect.state((s) => s.permissions[0].tool === "Write");
    t.expect.state((s) => s.permissions[0].reasonType === "workingDir");
    t.expect.state((s) => s.permissions[0].suggestions.length === 1);
    t.expect.state((s) =>
      s.permissions[0].suggestions[0].label.includes("/tmp")
    );
    // The call itself is held, not running: the clock must not tick on it.
    t.expect.state((s) => s.tools[0].permissionId === "req-1");
    t.expect.state((s) => s.activity.some((a) => a.channel === "permission"));
  },
);

testCell(session, "the same request arriving twice is one prompt", (t) => {
  t.send.ingest(toolUse("toolu_p2", "Write", { file_path: "/tmp/x.txt" }));
  t.send.ingest(canUseTool("req-2", "toolu_p2"));
  t.send.ingest(canUseTool("req-2", "toolu_p2"));
  t.expect.state((s) => s.permissions.length === 1);
});

testCell(session, "a withdrawn request stops asking", (t) => {
  t.send.ingest(toolUse("toolu_p3", "Write", { file_path: "/tmp/x.txt" }));
  t.send.ingest(canUseTool("req-3", "toolu_p3"));
  t.send.ingest({ type: "control_cancel_request", request_id: "req-3" });
  t.expect.state((s) => s.permissions[0].status === "cancelled");
  t.expect.state((s) => s.tools[0].permissionId === null);
});

testCell(session, "a dead process cannot leave a prompt pending", (t) => {
  t.init();
  t.send.ingest(toolUse("toolu_p4", "Write", { file_path: "/tmp/x.txt" }));
  t.send.ingest(canUseTool("req-4", "toolu_p4"));
  t.send.exited(1, "boom", t.getState().startToken);
  t.expect.state((s) => s.permissions[0].status === "cancelled");
  t.expect.state((s) => s.tools[0].permissionId === null);
});

/* ── teardown ─────────────────────────────────────────────────────────────── */
//
// Nothing that was in flight can finish once the process is gone. Leaving a run
// open kept its stopwatch ticking, the rail badge lit and the agent count above
// zero on a session that had ended — a spinner for work nobody was doing.

testCell(session, "stopping closes the work that was in flight", async (t) => {
  t.init();
  t.send.ingest(toolUse("toolu_open", "Bash", { command: "sleep 900" }));
  t.send.ingest(
    toolUse("toolu_agent", "Task", { subagent_type: "Explore", prompt: "map" }),
  );
  t.send.ingest({
    type: "system",
    subtype: "task_started",
    task_id: "t-open",
    tool_use_id: "toolu_agent",
    description: "map",
    task_type: "local_agent",
  });
  t.expect.state((s) => s.tools.every((r) => r.endedAt === null));

  await t.send.stop();

  t.expect.state((s) => s.status === "offline");
  t.expect.state((s) => s.tools.every((r) => r.endedAt !== null));
  // `ok` stays null: cut off is neither success nor failure, and the UI says so
  // rather than rounding a killed call up to "done".
  t.expect.state((s) => s.tools.every((r) => r.ok === null));
  t.expect.state((s) => s.tasks[0].status === "stopped");
  t.expect.state((s) => s.tasks[0].endedAt !== null);
  t.expect.state((s) => s.activity.some((a) => a.label === "2 calls cut off"));
  t.expect.state((s) => s.interrupting === false);
});

testCell(session, "a crash closes it too, and keeps the reason", (t) => {
  t.init();
  // A turn in flight, so the exit below is a crash and not the tail of a Stop
  // the user asked for — `exited` reads an already-offline session as the latter.
  t.send.ingest({ type: "system", subtype: "status", status: "requesting" });
  t.send.ingest(toolUse("toolu_crash", "Bash", { command: "sleep 900" }));
  t.send.exited(1, "out of memory", t.getState().startToken);
  t.expect.state((s) => s.status === "error");
  t.expect.state((s) => s.error === "out of memory");
  t.expect.state((s) => s.tools[0].endedAt !== null);
  t.expect.state((s) => s.tools[0].ok === null);
});

testCell(session, "a CLI-side denial is reported, never swallowed", (t) => {
  t.send.ingest(toolUse("toolu_p5", "Bash", { command: "curl example.com" }));
  t.send.ingest({
    type: "system",
    subtype: "permission_denied",
    tool_name: "Bash",
    tool_use_id: "toolu_p5",
    decision_reason_type: "subcommandResults",
    message: "The following part requires approval: curl example.com",
  });
  t.expect.state((s) =>
    s.activity.some((a) =>
      a.channel === "permission" && a.label.startsWith("Blocked")
    )
  );
});

/* ── accounting ───────────────────────────────────────────────────────────── */

const resultEvt = (cost: number, window = 1_000_000) => ({
  type: "result",
  subtype: "success",
  is_error: false,
  duration_ms: 1_000,
  num_turns: 1,
  total_cost_usd: cost,
  session_id: SESSION,
  usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 300 },
  modelUsage: { "claude-sonnet-5": { contextWindow: window } },
});

testCell(
  session,
  "cost is the CLI's running total, not a sum of its reports",
  (t) => {
    // One user turn ends in several results when sub-agents wake the model
    // again, and each carries the session total to date. Adding them up turned
    // a $0.06 session into $0.79.
    t.send.ingest(resultEvt(0.05));
    t.send.ingest(resultEvt(0.056));
    t.send.ingest(resultEvt(0.06));
    t.expect.state((s) => Math.abs(s.cost - 0.06) < 1e-9);
  },
);

testCell(
  session,
  "a mid-turn re-init keeps the measured context window",
  (t) => {
    t.send.ingest(resultEvt(0.01, 1_000_000));
    t.expect.state((s) => s.usage.contextWindow === 1_000_000);
    t.send.ingest(init); // the CLI re-inits after every result
    t.expect.state((s) => s.usage.contextWindow === 1_000_000);
  },
);

testCell(session, "a sub-agent's usage never moves the session meter", (t) => {
  t.send.ingest(resultEvt(0.01));
  const before = t.getState().usage.cacheRead;
  t.send.ingest({
    type: "assistant",
    parent_tool_use_id: "toolu_parent",
    message: {
      id: "msg_sub",
      content: [{ type: "text", text: "RED" }],
      usage: { input_tokens: 1, cache_read_input_tokens: 9 },
    },
  });
  t.expect.state((s) => s.usage.cacheRead === before);
});

testCell(session, "one message id is one transcript row", (t) => {
  // The CLI re-uses a message id across events, and sub-agent messages land in
  // between. Two rows sharing an id made the renderer drop one — a message the
  // user never saw.
  t.send.ingest({
    type: "assistant",
    message: { id: "msg_x", content: [{ type: "text", text: "one" }] },
  });
  t.send.ingest({
    type: "assistant",
    parent_tool_use_id: "toolu_sub",
    message: { id: "msg_sub", content: [{ type: "text", text: "from agent" }] },
  });
  t.send.ingest({
    type: "assistant",
    message: { id: "msg_x", content: [{ type: "text", text: "two" }] },
  });
  t.expect.state((s) => s.messages.length === 2);
  t.expect.state((s) => new Set(s.messages.map((m) => m.id)).size === 2);
  t.expect.state((s) => s.messages[0].blocks.length === 2);
});

testCell(
  session,
  "a sub-agent reports what it returned, not its receipt",
  (t) => {
    t.send.ingest(
      toolUse("toolu_ag2", "Agent", {
        subagent_type: "general-purpose",
        description: "Read hello.py",
      }),
    );
    t.send.ingest(
      toolResult(
        "toolu_ag2",
        'The file contains:\n\n```python\nprint("hi")\n```\n' +
          "agentId: a1b2c3 (use SendMessage with to: 'a1b2c3' to continue this agent)\n" +
          "<usage>subagent_tokens: 16918\ntool_uses: 2\nduration_ms: 6522</usage>",
      ),
    );
    t.expect.state((s) =>
      s.tools[0].output?.startsWith("The file contains:") === true
    );
    t.expect.state((s) => s.tools[0].output?.includes("agentId") === false);
    t.expect.state((s) => s.tools[0].agent?.tokens === 16918);
    t.expect.state((s) => s.tools[0].agent?.toolUses === 2);
    t.expect.state((s) => s.tools[0].agent?.durationMs === 6522);
    t.expect.state((s) => s.tools[0].agent?.type === "general-purpose");
  },
);

testCell(
  session,
  "a background sub-agent's answer arrives with its notification",
  (t) => {
    t.send.ingest(
      toolUse("toolu_ag3", "Agent", { description: "Reply RED" }),
    );
    t.send.ingest({
      type: "system",
      subtype: "task_started",
      task_id: "task-red",
      tool_use_id: "toolu_ag3",
      description: "Reply RED",
      subagent_type: "general-purpose",
      prompt: "Reply with the single word RED.",
      task_type: "local_agent",
    });
    t.send.ingest(
      toolResult("toolu_ag3", "Async agent launched successfully."),
    );
    t.expect.state((s) => s.tools[0].agent?.prompt?.includes("RED") === true);
    t.expect.state((s) => s.tools[0].output === null); // no answer yet

    t.send.ingest({
      type: "system",
      subtype: "task_notification",
      task_id: "task-red",
      tool_use_id: "toolu_ag3",
      status: "completed",
      summary: "RED",
      usage: { total_tokens: 10_911, tool_uses: 0, duration_ms: 1_388 },
    });
    t.expect.state((s) => s.tools[0].output === "RED");
    t.expect.state((s) => s.tools[0].agent?.tokens === 10_911);
    t.expect.state((s) => s.tools[0].endedAt !== null);
    t.expect.state((s) => s.tools[0].ok === true);
  },
);

/* ── limits, queueing and live thinking ───────────────────────────────────── */

testCell(
  session,
  "every usage window is kept, fullest first — not just the headline one",
  (t) => {
    // Captured shape (CLI 2.1.248): the headline names one window while
    // `unifiedWindows` carries them all. A session comfortable on five_hour can
    // be at 99% of seven_day, which is the figure that stops the next turn.
    t.send.ingest({
      type: "rate_limit_event",
      rate_limit_info: {
        status: "allowed_warning",
        rateLimitType: "seven_day",
        utilization: 0.99,
        resetsAt: 1_787_886_000,
        isUsingOverage: false,
        unifiedWindows: {
          five_hour: { utilization: 0.08, resetsAt: 1_787_881_200 },
          seven_day: { utilization: 0.99, resetsAt: 1_787_886_000 },
        },
      },
    });
    t.expect.state((s) => s.rateLimit?.windows.length === 2);
    // Sorted by pressure, so the first is always the one about to bite.
    t.expect.state((s) => s.rateLimit?.windows[0].name === "seven_day");
    t.expect.state((s) => s.rateLimit?.windows[0].utilization === 0.99);
    // Seconds on the wire, milliseconds in state — a reset time is useless in
    // the wrong unit.
    t.expect.state((s) =>
      s.rateLimit?.windows[0].resetsAt === 1_787_886_000_000
    );
    t.expect.state((s) => s.rateLimit?.overage === false);
  },
);

testCell(session, "an older event with no window map still reads", (t) => {
  t.send.ingest({
    type: "rate_limit_event",
    rate_limit_info: {
      status: "allowed",
      rateLimitType: "five_hour",
      utilization: 0.2,
    },
  });
  t.expect.state((s) => s.rateLimit?.windows.length === 0);
  t.expect.state((s) => s.rateLimit?.utilization === 0.2);
  t.expect.state((s) => s.rateLimit?.resetsAt === 0);
});

testCell(session, "queued turns are reported, not just promised", (t) => {
  // The composer tells the user a turn sent now will be queued. Until this, the
  // app had no idea how many the CLI was holding.
  t.send.ingest({ ...resultEvt(0.01), queued_turn_count: 2 });
  t.expect.state((s) => s.queuedTurns === 2);
  t.send.ingest({ ...resultEvt(0.02), queued_turn_count: 0 });
  t.expect.state((s) => s.queuedTurns === 0);
});

testCell(
  session,
  "the thinking estimate moves during a turn and is cleared by its result",
  (t) => {
    // Every other figure on screen is frozen until the turn lands, so a long
    // think and a hang looked identical.
    t.send.ingest({
      type: "system",
      subtype: "thinking_tokens",
      estimated_tokens: 4,
      estimated_tokens_delta: 4,
    });
    t.expect.state((s) => s.thinkingTokens === 4);
    t.send.ingest({
      type: "system",
      subtype: "thinking_tokens",
      estimated_tokens: 176,
      estimated_tokens_delta: 172,
    });
    t.expect.state((s) => s.thinkingTokens === 176);
    // It belongs to the turn that just ended.
    t.send.ingest(resultEvt(0.01));
    t.expect.state((s) => s.thinkingTokens === 0);
  },
);

testCell(
  session,
  "a refused sub-agent is reported, not silently worked around",
  (t) => {
    // Captured shape (CLI 2.1.248). A delegation turned down for a depth,
    // concurrency or budget limit produces no agent, no error and no row —
    // the model just carries on without the help it asked for.
    t.send.ingest({
      ...resultEvt(0.01),
      subagent_stats: {
        spawned: 1,
        completed: 0,
        failed: 0,
        killed: { parent: 0, user: 0, system: 0 },
        refused: { depth_limit: 0, concurrency_limit: 2, budget: 1 },
      },
    });
    t.expect.state((s) => s.agentStats?.refused === 3);
    t.expect.state((s) => s.agentStats?.refusedBy.length === 2);
    t.expect.state((s) => (s.error ?? "").includes("refused"));
    t.expect.state((s) => (s.error ?? "").includes("concurrency limit"));
    t.expect.state((s) =>
      s.activity.some((a) => a.label === "Sub-agents refused")
    );
  },
);

testCell(session, "a clean turn reports its outcome without alarming", (t) => {
  t.send.ingest({
    ...resultEvt(0.01),
    terminal_reason: "completed",
    stop_reason: "end_turn",
    ttft_ms: 5_493,
    subagent_stats: {
      spawned: 1,
      completed: 1,
      failed: 0,
      killed: { parent: 0, user: 0, system: 0 },
      refused: { depth_limit: 0, concurrency_limit: 0, budget: 0 },
    },
  });
  t.expect.state((s) => s.turnEnd?.reason === "completed");
  t.expect.state((s) => s.turnEnd?.stopReason === "end_turn");
  t.expect.state((s) => s.turnEnd?.ttftMs === 5_493);
  t.expect.state((s) => s.agentStats?.refused === 0);
  t.expect.state((s) => s.error === null); // nothing to warn about
});

testCell(
  session,
  "plugins the CLI loaded are part of what a session can do",
  (t) => {
    t.send.ingest({
      ...init,
      plugins: [{ name: "rust-analyzer-lsp", version: "1.0.0", path: "/x" }],
    });
    t.expect.state((s) => s.meta.plugins.length === 1);
    t.expect.state((s) => s.meta.plugins[0].name === "rust-analyzer-lsp");
    t.expect.state((s) => s.meta.plugins[0].version === "1.0.0");
    // Absent is empty, never undefined.
    t.send.ingest(init);
    t.expect.state((s) => s.meta.plugins.length === 0);
  },
);

testCell(session, "retry re-sends the last thing you said", async (t) => {
  t.init();
  // No CLI on this path: the spawn fails, which is what makes the turn end in
  // an error — the state retry exists for.
  const previous = Deno.env.get("CLAUDE_BIN");
  Deno.env.set("CLAUDE_BIN", "/nonexistent/claude-binary");
  try {
    await t.send.send("the question");
    t.expect.state((s) => s.messages.length === 1);

    await t.send.retry();
    // The same words, again — a second user message, not a replay of the turn.
    t.expect.state((s) => s.messages.length === 2);
    t.expect.state((s) =>
      s.messages.every((m) =>
        m.blocks.some((b) => b.kind === "text" && b.text === "the question")
      )
    );
  } finally {
    if (previous === undefined) Deno.env.delete("CLAUDE_BIN");
    else Deno.env.set("CLAUDE_BIN", previous);
  }
});

testCell(session, "retry with nothing to retry does nothing", async (t) => {
  t.init();
  await t.send.retry();
  t.expect.state((s) => s.messages.length === 0);
});

Deno.test("offlineAgain — a restored conversation does not pretend to be running", () => {
  // What comes back from disk is a transcript. The process that made it died
  // when the app closed, so every claim about that process has to be dropped
  // or the app is lying about itself: a spinner for a turn that ended hours
  // ago, an Allow button wired to a pid that is gone.
  const dead = {
    ...blank(),
    status: "working" as const,
    pid: 4242,
    startedAt: 1,
    streaming: { kind: "text" as const, text: "half a senten" },
    // Only its presence matters here — this test is about it being dropped,
    // not about its shape.
    permissions: [{ id: "p1" }] as unknown as ProjectSession["permissions"],
    interrupting: true,
    turnStartedAt: 1,
    queuedTurns: 3,
    thinkingTokens: 900,
    error: "something from last time",
    cleared: [{
      id: "old",
      role: "user" as const,
      blocks: [],
      at: 1,
      parentToolUseId: null,
    }],
    messages: [{
      id: "m1",
      role: "user" as const,
      blocks: [],
      at: 1,
      parentToolUseId: null,
    }],
    tools: [{
      id: "t1",
      name: "Bash",
      kind: "tool" as const,
      title: "ls",
      detail: "",
      input: {},
      startedAt: 5,
      endedAt: null,
      ok: null,
      output: null,
      parentToolUseId: null,
      taskId: null,
      agent: null,
      permissionId: null,
    }],
  };
  offlineAgain(dead);

  assertEquals(dead.status, "offline");
  assertEquals(dead.pid, null);
  assertEquals(dead.streaming, null);
  assertEquals(dead.permissions, []); // nobody can answer these now
  assertEquals(dead.interrupting, false);
  assertEquals(dead.queuedTurns, 0);
  assertEquals(dead.thinkingTokens, 0);
  assertEquals(dead.error, null);
  // The undo for a clear is for the moment right after pressing it, not for
  // merging a transcript from another day into a live one.
  assertEquals(dead.cleared, []);
  // The transcript itself is the whole point — it survives untouched.
  assertEquals(dead.messages.length, 1);
  // A tool call stops spinning, but is not accused of failing: `ok` stays
  // null, which is "nobody knows how that finished", because nobody does.
  assertEquals(dead.tools[0].endedAt, 5);
  assertEquals(dead.tools[0].ok, null);
});
