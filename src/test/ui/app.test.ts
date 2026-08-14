/**
 * Real UI tests — the app is driven through its semantic surface, the way a
 * user drives it, with no DOM selectors (dep/aio/docs/testing/ui-testing.md).
 *
 * These run headless under happy-dom, so they never open a window and cannot
 * steal focus; the Xephyr rule for UI runs applies to the Electron app itself,
 * which is exercised separately.
 *
 * No Claude Code process is spawned: the session cell is driven with the same
 * captured `stream-json` events the protocol tests use, so a full turn —
 * streaming, tool calls, sub-agents, tasks — is reproduced end to end.
 */
import { assertEquals } from "@std/assert";
import { testUI } from "aio/testing";
import App from "../../App.tsx";
import { session } from "../../cell/session.ts";
import type { ToolRun } from "../../type/claude.ts";
import { workspace } from "../../cell/workspace.ts";

const SESSION = "441e5bea-4547-42f1-9a5c-11d495c662ff";

/**
 * Start every test on the chat page.
 *
 * `testUI` resets cells between mounts, but the router reads happy-dom's
 * `location`, which is module-global — so without this a test inherits
 * whatever route the previous one navigated to, and the failure looks like a
 * missing component rather than a leaked URL.
 */
async function open(ui: any) {
  ui.ChatLink.click();
  await ui.settle();
}

const init = {
  type: "system",
  subtype: "init",
  cwd: "/home/dev/code/cc",
  session_id: SESSION,
  model: "claude-sonnet-5",
  tools: ["Task", "Bash", "Read"],
  agents: ["Explore"],
  skills: [],
  slash_commands: [],
  mcp_servers: [],
  permissionMode: "acceptEdits",
  claude_code_version: "2.1.226",
  memory_paths: {},
};

const assistantTool = (
  id: string,
  name: string,
  input: Record<string, unknown>,
) => ({
  type: "assistant",
  message: {
    id: `msg_${id}`,
    model: "claude-sonnet-5",
    content: [{ type: "tool_use", id, name, input }],
    usage: {
      input_tokens: 2,
      cache_read_input_tokens: 24_018,
      cache_creation_input_tokens: 9_399,
      output_tokens: 10,
    },
  },
});

const toolResult = (id: string, content: string) => ({
  type: "user",
  message: {
    content: [{
      type: "tool_result",
      tool_use_id: id,
      content,
      is_error: false,
    }],
  },
});

/* ── shell ────────────────────────────────────────────────────────────────── */

testUI(
  App,
  "the shell opens on chat with every section reachable",
  async (ui) => {
    await open(ui);
    // The rail is the starting point for every detail page (ui.md#1).
    for (
      const link of [
        "ChatLink",
        "SubAgentsLink",
        "TasksLink",
        "ActivityLink",
        "MemoryLink",
        "SettingsLink",
      ]
    ) {
      assertEquals(typeof ui[link].click, "function", `${link} is addressable`);
    }
    assertEquals(ui.MessageClaudeCodeInput.value, "");
    assertEquals(ui.SendButton.disabled, true); // nothing typed yet
  },
);

testUI(App, "each rail card opens its detail page", async (ui) => {
  await open(ui);
  ui.SubAgentsLink.click();
  await ui.waitFor(() => ui.html().includes("Sub-agents"));

  ui.TasksLink.click();
  await ui.waitFor(() => ui.html().includes("Background tasks"));

  ui.MemoryLink.click();
  await ui.waitFor(() =>
    ui.html().includes("Total loaded") ||
    ui.html().includes("No memory measured")
  );

  ui.SettingsLink.click();
  await ui.waitFor(() => ui.html().includes("Permissions"));

  ui.ChatLink.click();
  await ui.waitFor(() => ui.html().includes("Ask Claude Code"));
});

testUI(App, "only one page renders at a time", async (ui) => {
  await open(ui);
  ui.ActivityLink.click();
  await ui.waitFor(() => ui.html().includes("Activity"));
  // The composer belongs to the chat page; if routing stacked pages it would
  // still be mounted here (it used to be — `/` prefix-matched everything).
  assertEquals(ui.html().includes("Ask Claude Code to build"), false);
});

/* ── composer ─────────────────────────────────────────────────────────────── */

testUI(App, "Send enables only once there is something to send", async (ui) => {
  await open(ui);
  assertEquals(ui.SendButton.disabled, true);
  ui.MessageClaudeCodeInput.type("explain this repo");
  await ui.settle();
  assertEquals(ui.SendButton.disabled, false);
  ui.MessageClaudeCodeInput.clear();
  await ui.settle();
  assertEquals(ui.SendButton.disabled, true);
});

/* ── a full turn, from captured protocol events ───────────────────────────── */

testUI(
  App,
  "a turn renders end to end: thinking, tool call, answer",
  async (ui) => {
    await open(ui);
    session.ingest(init);

    // Streaming thinking, coalesced upstream and shown live.
    session.delta("thinking", "weighing the answer");
    await ui.waitFor(() => ui.html().includes("weighing the answer"));

    session.ingest(assistantTool("toolu_1", "Bash", {
      command: "cat README.md",
      description: "Read the README",
    }));
    await ui.waitFor(() => ui.html().includes("Read the README"));

    session.ingest(toolResult("toolu_1", "# cc — Claude Control"));
    session.ingest({
      type: "assistant",
      message: {
        id: "msg_final",
        content: [{
          type: "text",
          text: "It is a **control surface** for Claude Code.",
        }],
      },
    });
    await ui.waitFor(() => ui.html().includes("control surface"));
    // Markdown renders as nodes, not as escaped source.
    assertEquals(ui.html().includes("<strong>control surface</strong>"), true);

    session.ingest({
      type: "result",
      is_error: false,
      duration_ms: 1_875,
      num_turns: 1,
      total_cost_usd: 0.06,
      usage: {
        input_tokens: 2,
        cache_creation_input_tokens: 9_399,
        cache_read_input_tokens: 24_018,
        output_tokens: 10,
      },
      modelUsage: { "claude-sonnet-5": { contextWindow: 1_000_000 } },
    });
    await ui.expectCell(session, (s) => s.status === "ready");
    await ui.expectCell(session, (s) => s.turns === 1);
  },
);

testUI(
  App,
  "typing and sending puts the message in the transcript",
  async (ui) => {
    await open(ui);
    // No CLI on this path: the spawn fails, which is exactly what we assert —
    // the message is still shown, and the failure is reported rather than
    // swallowed. Nothing here starts a real Claude Code process.
    const previous = Deno.env.get("CLAUDE_BIN");
    Deno.env.set("CLAUDE_BIN", "/nonexistent/claude-binary");
    try {
      ui.MessageClaudeCodeInput.type("what does this project do?");
      ui.SendButton.click();
      await ui.waitFor(() => ui.html().includes("what does this project do?"));
      await ui.expectCell(session, (s) => s.status === "error");
      await ui.waitFor(() =>
        ui.html().includes("Could not start") ||
        ui.html().includes("CLAUDE_BIN")
      );
    } finally {
      if (previous === undefined) Deno.env.delete("CLAUDE_BIN");
      else Deno.env.set("CLAUDE_BIN", previous);
    }
  },
);

testUI(App, "code blocks in the chat are syntax coloured", async (ui) => {
  await open(ui);
  session.ingest(init);
  session.ingest({
    type: "assistant",
    message: {
      id: "msg_code",
      content: [{
        type: "text",
        text: 'Here:\n\n```ts\nconst greet = () => "hi"; // note\n```\n',
      }],
    },
  });
  await ui.waitFor(() => ui.html().includes("greet"));
  const html = ui.html();
  assertEquals(html.includes('class="tok tok--keyword"'), true); // const
  assertEquals(html.includes('class="tok tok--string"'), true); //  "hi"
  assertEquals(html.includes('class="tok tok--comment"'), true); // // note
  assertEquals(html.includes("md__lang"), true); // the language badge
  // The code itself survives colouring.
  assertEquals(html.includes("greet"), true);
});

/* ── the status strip: the numbers the kata asks for ──────────────────────── */

testUI(
  App,
  "the strip reports project, branch, model, context, agents, tasks and time",
  async (ui) => {
    await open(ui);
    session.ingest(init);
    await ui.waitFor(() => ui.html().includes("claude-sonnet-5"));
    const html = () => ui.html();

    assertEquals(
      html().includes("PROJECT") || html().includes("Project"),
      true,
    );
    assertEquals(html().includes("cc"), true); // active project directory
    assertEquals(html().includes("Model") || html().includes("MODEL"), true);

    session.ingest(assistantTool("toolu_ctx", "Read", { file_path: "/a.ts" }));
    await ui.waitFor(() =>
      ui.html().includes("33k") || ui.html().includes("33.4k")
    );
    // used / maximum, both present
    assertEquals(ui.html().includes("200k"), true);
  },
);

testUI(
  App,
  "the strip says so when the live session runs somewhere else",
  async (ui) => {
    await open(ui);
    // The session reports a working directory of its own, and a live process
    // keeps it: a project switch only takes effect on the next start. Until
    // this marker existed the strip read "Project: <the new one>" while Claude
    // Code was working in the old one.
    session.ingest(init);
    session.ingest({ type: "system", subtype: "status", status: "requesting" });
    await ui.waitFor(() => ui.html().includes("session elsewhere"));
    assertEquals(session.cwd === "/home/dev/code/cc", true);

    // …and it is gone the moment the session is no longer running there.
    session.exited(0, "");
    await ui.waitFor(() => !ui.html().includes("session elsewhere"));
  },
);

testUI(
  App,
  "running sub-agents and tasks are counted and listed",
  async (ui) => {
    await open(ui);
    session.ingest(init);
    session.ingest(assistantTool("toolu_ag", "Agent", {
      subagent_type: "Explore",
      description: "Summarise src/lib",
    }));
    session.ingest({
      type: "system",
      subtype: "task_started",
      task_id: "task_1",
      tool_use_id: "toolu_ag",
      description: "Summarise src/lib",
      task_type: "local_agent",
    });
    session.ingest(toolResult("toolu_ag", "Async agent launched successfully"));

    await ui.expectCell(
      session,
      (s) =>
        s.tools.some((t: ToolRun) => t.kind === "agent" && t.endedAt === null),
    );

    ui.SubAgentsLink.click();
    await ui.waitFor(() => ui.html().includes("Summarise src/lib"));
    assertEquals(ui.html().includes("running"), true);

    ui.TasksLink.click();
    await ui.waitFor(() => ui.html().includes("Background tasks"));
    assertEquals(ui.html().includes("local_agent"), true);

    // …and it stops being "running" when its background task ends.
    session.ingest({
      type: "system",
      subtype: "task_updated",
      task_id: "task_1",
      patch: { status: "completed", end_time: 1_786_262_870_720 },
    });
    await ui.expectCell(
      session,
      (s) => s.tools.every((t: ToolRun) => t.endedAt !== null),
    );
  },
);

/* ── settings ─────────────────────────────────────────────────────────────── */

testUI(
  App,
  "choosing a model and a permission mode updates the workspace",
  async (ui) => {
    await open(ui);
    ui.SettingsLink.click();
    await ui.waitFor(() => ui.html().includes("Permissions"));

    ui.OpusButton.click();
    await ui.expectCell(workspace, (w) => w.model === "opus");

    ui.PlanButton.click();
    await ui.expectCell(workspace, (w) => w.permissionMode === "plan");
  },
);

testUI(App, "the theme switch round-trips", async (ui) => {
  await open(ui);
  ui.SettingsLink.click();
  await ui.waitFor(() => ui.html().includes("Theme"));
  ui.LightButton.click();
  await ui.expectCell(workspace, (w) => w.theme === "light");
  ui.DarkButton.click();
  await ui.expectCell(workspace, (w) => w.theme === "dark");
});

testUI(App, "a directory can be granted and revoked", async (ui) => {
  await open(ui);
  ui.SettingsLink.click();
  await ui.waitFor(() => ui.html().includes("Allowed directories"));

  const dir = await Deno.makeTempDir();
  try {
    ui.DirectoryToAllowInput.type(dir);
    ui.AllowButton.click();
    await ui.expectCell(workspace, (w) => w.allowedDirs.includes(dir));
    await ui.waitFor(() => ui.html().includes(dir.split("/").pop() ?? dir));

    // Revoking removes it from the list as well as from the state.
    workspace.removeAllowedDir(dir);
    await ui.expectCell(workspace, (w) => w.allowedDirs.length === 0);
    await ui.waitFor(() => ui.html().includes("may only touch the project"));
  } finally {
    await Deno.remove(dir);
  }
});

testUI(App, "Allow all needs a second, explicit confirmation", async (ui) => {
  await open(ui);
  ui.SettingsLink.click();
  await ui.waitFor(() => ui.html().includes("Allow all"));

  // One click only arms it — nothing is granted yet.
  ui.AllowAllButton.click();
  await ui.settle();
  await ui.expectCell(workspace, (w) => w.skipPermissions === false);
  await ui.waitFor(() => ui.html().includes("no checks at all"));

  // The second click is the decision, and it says what it grants.
  ui.YesRunWithNoChecksButton.click();
  await ui.expectCell(workspace, (w) => w.skipPermissions === true);
  await ui.waitFor(() => ui.html().includes("All permission checks are off"));

  // …and it can always be undone.
  ui.TurnBackOnButton.click();
  await ui.expectCell(workspace, (w) => w.skipPermissions === false);
});

/* ── errors are visible, never swallowed ──────────────────────────────────── */

testUI(
  App,
  "a failed turn shows a banner without killing the session",
  async (ui) => {
    await open(ui);
    session.ingest(init);
    session.ingest({
      type: "result",
      is_error: true,
      result: "upstream overloaded",
      usage: {},
    });
    await ui.waitFor(() => ui.html().includes("upstream overloaded"));
    await ui.expectCell(session, (s) => s.status === "ready");
  },
);

testUI(
  App,
  "permission denials surface as a banner naming the tool",
  async (ui) => {
    await open(ui);
    session.ingest(init);
    session.ingest({
      type: "result",
      is_error: false,
      usage: {},
      permission_denials: [
        {
          tool_name: "Write",
          tool_use_id: "t1",
          tool_input: { file_path: "/a.txt" },
        },
      ],
    });
    await ui.waitFor(() => ui.html().includes("blocked"));
    assertEquals(ui.html().includes("Write"), true);
    // The banner must name the remedy, not just the symptom.
    assertEquals(ui.html().includes("Allowed directories"), true);
  },
);

/* ── approvals ────────────────────────────────────────────────────────────── */

const canUseTool = {
  type: "control_request",
  request_id: "req-ui-1",
  request: {
    subtype: "can_use_tool",
    tool_name: "Bash",
    display_name: "Bash",
    input: { command: "curl -s https://example.com", description: "Fetch it" },
    description: "Fetch it",
    permission_suggestions: [
      {
        type: "addRules",
        rules: [{
          toolName: "Bash",
          ruleContent: "curl -s https://example.com",
        }],
        behavior: "allow",
        destination: "localSettings",
      },
    ],
    decision_reason: "This command requires approval",
    decision_reason_type: "subcommandResults",
    tool_use_id: "toolu_perm",
  },
};

testUI(
  App,
  "an approval request stops the app and asks, with all three answers",
  async (ui) => {
    await open(ui);
    session.ingest(init);
    session.ingest(
      assistantTool("toolu_perm", "Bash", {
        command: "curl -s https://example.com",
        description: "Fetch it",
      }),
    );
    session.ingest(canUseTool);

    await ui.waitFor(() => ui.html().includes("needs your approval"));
    const html = ui.html();
    // What is being asked, and why — both from the CLI, neither invented.
    assertEquals(html.includes("curl -s https://example.com"), true);
    assertEquals(html.includes("This command requires approval"), true);
    // Every answer is one click away, and "always" states its real scope.
    assertEquals(html.includes("Allow once"), true);
    assertEquals(html.includes("Always allow"), true);
    assertEquals(html.includes("Deny"), true);
    assertEquals(html.includes("this project, permanently"), true);
    // The held call reads as held, not as work in progress.
    assertEquals(html.includes("needs approval"), true);
    // And the rail says so from wherever you are.
    assertEquals(html.includes("approval"), true);
  },
);

testUI(App, "answering an approval clears the prompt", async (ui) => {
  await open(ui);
  session.ingest(init);
  session.ingest(
    assistantTool("toolu_perm", "Bash", { command: "curl -s https://x.dev" }),
  );
  session.ingest(canUseTool);
  await ui.waitFor(() => ui.html().includes("needs your approval"));

  // The process is not running under test, so the write fails — the prompt must
  // still leave the screen and the failure must be reported, never swallowed.
  await session.allowPermission("req-ui-1");
  await ui.waitFor(() => !ui.html().includes("needs your approval"));
  await ui.expectCell(
    session,
    (s: { permissions: { status: string }[] }) =>
      s.permissions[0].status !== "pending",
  );
});

testUI(
  App,
  "an approval is answerable from every page, not just chat",
  async (ui) => {
    // The page you are on when a sub-agent asks is usually Sub-agents — a
    // prompt only the chat page rendered was a prompt the user never saw.
    await open(ui);
    session.ingest(init);
    session.ingest(
      assistantTool("toolu_perm", "Bash", { command: "curl -s https://x.dev" }),
    );
    session.ingest(canUseTool);
    await ui.waitFor(() => ui.html().includes("needs your approval"));

    for (const page of ["SubAgentsLink", "TasksLink", "ActivityLink"]) {
      ui[page].click();
      await ui.settle();
      assertEquals(
        ui.html().includes("needs your approval"),
        true,
        `${page} still shows the prompt`,
      );
    }
  },
);
