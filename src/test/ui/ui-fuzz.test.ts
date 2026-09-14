// Randomized UI fuzz: random protocol events interleaved with random
// navigation, checking after every step that the app still renders. The kata's
// baseline is "no blank screen, no errors" — this is that, driven by a stream
// nobody hand-picked.
import { assert } from "@std/assert";
import { testUI } from "aio/testing";
import App from "../../App.tsx";
import { session } from "../../cell/session.ts";

/** Long enough to interleave navigation with every event shape; the seed is
 *  fixed so a failure reproduces, and `FUZZ_SEED=n` walks a different stream. */
const STEPS = 80;

let seed = Number(Deno.env.get("FUZZ_SEED") ?? 314_159);
const rnd = () =>
  (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const pick = <T>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)];

const IDS = ["toolu_1", "toolu_2", "toolu_3", "", "toolu_4"];
const WEIRD = [null, undefined, 0, -1, "", "x".repeat(300), [], {}, true];

const event = () =>
  pick([
    {
      type: "system",
      subtype: pick([
        "init",
        "status",
        "task_started",
        "task_updated",
        "task_notification",
        "background_tasks_changed",
        "permission_denied",
        "thinking_tokens",
      ]),
      session_id: "s-1",
      cwd: pick(["/tmp/x", null]),
      model: pick(["claude-opus-5[1m]", "claude-haiku-4-5", null]),
      tools: pick([["Bash", "Read"], null]),
      memory_paths: pick([{ auto: "/tmp/m/" }, {}]),
      status: pick(["requesting", "running", "completed", "failed", null]),
      task_id: pick(["t1", "t2"]),
      tool_use_id: pick(IDS),
      patch: pick([{ status: "failed", end_time: 1_786_675_025_697 }, {}]),
      tasks: pick([[{ task_id: "t1" }], []]),
      description: pick(WEIRD),
      summary: pick(WEIRD),
      subagent_type: pick(["Explore", null]),
      prompt: pick(WEIRD),
      usage: pick([{ total_tokens: 12, tool_uses: 2, duration_ms: 30 }, {}]),
      tool_name: pick(["Bash", null]),
      message: pick(WEIRD),
    },
    {
      type: "assistant",
      parent_tool_use_id: pick([null, "toolu_1"]),
      message: {
        id: pick(["msg_1", "msg_2", "msg_3"]),
        model: "claude-haiku-4-5",
        content: pick([
          [{ type: "text", text: pick(["# h\n\n- a\n- b", "`x`", ""]) }],
          [{ type: "thinking", thinking: "hmm" }],
          [{
            type: "tool_use",
            id: pick(IDS),
            name: pick(["Bash", "Task", "Read", "Unknown"]),
            input: pick([{ command: "ls" }, { file_path: "/a/b/c.ts" }, {}]),
          }],
          [],
        ]),
        usage: { input_tokens: 3, output_tokens: 4 },
      },
    },
    {
      type: "user",
      message: {
        content: [{
          type: "tool_result",
          tool_use_id: pick(IDS),
          content: pick(["done", [{ type: "text", text: "ok" }], null]),
          is_error: pick([true, false]),
        }],
      },
    },
    {
      type: "result",
      subtype: pick(["success", "error_during_execution"]),
      is_error: pick([true, false]),
      duration_ms: 1200,
      num_turns: 2,
      total_cost_usd: 0.01,
      session_id: "s-1",
      usage: pick([{ input_tokens: 9, output_tokens: 3 }, {}]),
      modelUsage: pick([{ m: { contextWindow: 1_000_000 } }, {}]),
      permission_denials: pick([[], [{
        tool_name: "Write",
        tool_use_id: "toolu_1",
        tool_input: {},
      }]]),
    },
    {
      type: "control_request",
      request_id: pick(["req-1", "req-2"]),
      request: {
        subtype: "can_use_tool",
        tool_name: "Bash",
        input: { command: "rm -rf /tmp/x" },
        permission_suggestions: [{
          type: "addRules",
          rules: [{
            toolName: "Bash",
            ruleContent: "rm:*",
          }],
        }],
      },
    },
    { type: "control_cancel_request", request_id: pick(["req-1", "req-2"]) },
    {
      type: "rate_limit_event",
      rate_limit_info: {
        status: "allowed_warning",
        resetsAt: 1_786_676_400,
        rateLimitType: "seven_day",
        utilization: 0.8,
      },
    },
  ]) as Record<string, unknown>;

/**
 * The renderer's own complaints, collected while the walk runs.
 *
 * Two of them are never cosmetic. A desync means the diff wrote one row's node
 * into another row's slot — how a shared element object (one icon built once
 * and placed in every row) shows up. An afterRender that throws is an effect
 * that stopped at the line before, which is how the transcript quietly stopped
 * following its own tail. Both were live here and neither failed a test.
 *
 * Colour findings are deliberately NOT asserted on: the framework's walk reads
 * computed values from the test DOM, whose custom-property cascade answers with
 * the last declaration in the sheet regardless of selectors, so it reports
 * pairs this app never paints. `contrast.test.ts` measures the real grid.
 */
const LOUD = [
  "child reconciler desynced",
  "afterRender callback error",
  "onMount callback error",
];

const watchWarnings = (): { seen: string[]; stop: () => void } => {
  const seen: string[] = [];
  const real = console.warn;
  const realError = console.error;
  const look = (args: unknown[]) => {
    const text = args.map(String).join(" ");
    if (LOUD.some((l) => text.includes(l))) seen.push(text.split("\n")[0]);
  };
  console.warn = (...args: unknown[]) => {
    look(args);
    real(...args);
  };
  console.error = (...args: unknown[]) => {
    look(args);
    realError(...args);
  };
  return {
    seen,
    stop: () => {
      console.warn = real;
      console.error = realError;
    },
  };
};

testUI(App, "ui fuzz: the app never renders blank", async (ui: any) => {
  const warnings = watchWarnings();
  // Every destination in the rail. A page added without being walked here is a
  // page whose first blank render nobody notices.
  const links = [
    "ProjectLink",
    "SubAgentsLink",
    "TasksLink",
    "ActivityLink",
    "JobsLink",
    "LoopsLink",
    "TreeLink",
    "MemoryLink",
    "SkillsLink",
    "CommandsLink",
    "MCPLink",
    "PluginsLink",
    "HooksLink",
    "StorageLink",
    "SettingsLink",
  ];
  try {
    ui.ProjectLink.click();
    await ui.settle();

    for (let step = 0; step < STEPS; step++) {
      if (rnd() < 0.25) {
        const name = pick(links);
        ui[name].click();
        await ui.settle();
      } else {
        session.ingest(event());
        await ui.settle();
      }
      const html = ui.html();
      // The shell is always there: rail, strip, and a page under them.
      assert(html.includes("Claude Control"), `rail gone at step ${step}`);
      assert(html.length > 2_000, `page collapsed at step ${step}`);
      assert(!/undefined|NaN/.test(html), `rendered NaN/undefined at ${step}`);
      assert(
        warnings.seen.length === 0,
        `the renderer complained at step ${step}:\n  ${
          warnings.seen.join("\n  ")
        }`,
      );
    }
  } finally {
    warnings.stop();
  }
});
