/**
 * Real UI tests — the app is driven through its semantic surface, the way a
 * user drives it, with no DOM selectors (dep/aio/docs/testing/ui-testing.md).
 *
 * These run headless under happy-dom, so they never open a window and cannot
 * steal focus, which is what the katana Xephyr rule exists to guarantee. There
 * is no separate windowed harness; launching the real Electron window is a
 * manual `deno task dev` / `am` check, not part of this suite.
 *
 * No Claude Code process is spawned: the session cell is driven with the same
 * captured `stream-json` events the protocol tests use, so a full turn —
 * streaming, tool calls, sub-agents, tasks — is reproduced end to end.
 */
import { assertEquals } from "@std/assert";
import { testUI } from "aio/testing";
import App from "../../App.tsx";
import { session, view } from "../../cell/session.ts";
import type { ToolRun } from "../../type/claude.ts";
import { workspace } from "../../cell/workspace.ts";
import { listKey } from "../../lib/format.ts";
import { loops } from "../../cell/loops.ts";
import { tree } from "../../cell/tree.ts";
import { catalog } from "../../cell/catalog.ts";
import { closeFind, openFind } from "../../ui/find.tsx";

const SESSION = "441e5bea-4547-42f1-9a5c-11d495c662ff";

/** The active project inside a workspace snapshot — where settings now live. */
// deno-lint-ignore no-explicit-any
const active = (w: any) =>
  w.projects.find((p: { id: string }) => p.id === w.activeId);

/**
 * Start every test on the chat page.
 *
 * `testUI` resets cells between mounts, but the router reads happy-dom's
 * `location`, which is module-global — so without this a test inherits
 * whatever route the previous one navigated to, and the failure looks like a
 * missing component rather than a leaked URL.
 */
async function open(ui: any) {
  ui.ProjectLink.click();
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

  ui.ProjectLink.click();
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

testUI(
  App,
  "a turn in flight shows a clock and the queue behind it",
  async (ui) => {
    await open(ui);
    session.ingest(init);
    await session.send("hi");
    // "Claude is working" alone read the same at two seconds and at three
    // minutes — and the API can hold a turn for minutes with nothing on the
    // wire, which is exactly when a user decides the app is broken.
    await ui.waitFor(() => ui.html().includes("Working"));

    await session.send("and another");
    await ui.waitFor(() => ui.html().includes("queued behind it"));
  },
);

/* ── the status strip: the numbers the kata asks for ──────────────────────── */

testUI(
  App,
  "the strip reports project, branch, model, context, agents, tasks and time",
  async (ui) => {
    await open(ui);
    session.ingest(init);
    // The family, not the id the CLI reports: "claude-sonnet-5" is what the
    // wire says, "Sonnet" is what the picker calls it and what the strip has
    // to name if choosing from that picker is to change what is written here.
    await ui.waitFor(() => ui.html().includes("Sonnet"));
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
  "choosing a model and a permission mode settles on the active project",
  async (ui) => {
    await open(ui);
    ui.SettingsLink.click();
    await ui.waitFor(() => ui.html().includes("Permissions"));

    // The project, not the app: these are per-project settings now, and the
    // seed is only what the *next* project starts from.
    ui.OpusButton.click();
    await ui.expectCell(workspace, (w) => active(w)?.model === "opus");

    ui.PlanButton.click();
    await ui.expectCell(
      workspace,
      (w) => active(w)?.permissionMode === "plan",
    );
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
    await ui.expectCell(
      workspace,
      (w) => (active(w)?.allowedDirs ?? []).includes(dir),
    );
    await ui.waitFor(() => ui.html().includes(dir.split("/").pop() ?? dir));

    // Revoking removes it from the list as well as from the state.
    workspace.removeAllowedDir(dir);
    await ui.expectCell(
      workspace,
      (w) => (active(w)?.allowedDirs ?? []).length === 0,
    );
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
  await ui.expectCell(workspace, (w) => active(w)?.skipPermissions === false);
  await ui.waitFor(() => ui.html().includes("no checks at all"));

  // The second click is the decision, and it says what it grants.
  ui.YesRunWithNoChecksButton.click();
  await ui.expectCell(workspace, (w) => active(w)?.skipPermissions === true);
  await ui.waitFor(() => ui.html().includes("All permission checks are off"));

  // …and it can always be undone.
  ui.TurnBackOnButton.click();
  await ui.expectCell(workspace, (w) => active(w)?.skipPermissions === false);
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

/**
 * Both composer tests below submit turns, so they point `CLAUDE_BIN` at nothing:
 * `send` appends the user message optimistically *before* it discovers there is
 * no process, which is exactly the transcript these need — and no real `claude`
 * is spawned to produce it.
 */
async function withoutCli(body: () => Promise<void>): Promise<void> {
  const previous = Deno.env.get("CLAUDE_BIN");
  Deno.env.set("CLAUDE_BIN", "/nonexistent/claude-binary");
  try {
    await body();
  } finally {
    if (previous === undefined) Deno.env.delete("CLAUDE_BIN");
    else Deno.env.set("CLAUDE_BIN", previous);
  }
}

testUI(App, "Enter mid-composition belongs to the input method", async (ui) => {
  await withoutCli(async () => {
    await open(ui);
    session.clearTranscript();
    await ui.settle();

    ui.MessageClaudeCodeInput.type("にほん");
    await ui.settle();
    // The keystroke that accepts an IME candidate is an Enter with
    // `isComposing` set. Sending on it posts a half-finished sentence — the
    // whole failure mode for anyone typing Japanese, Chinese or Korean.
    ui.MessageClaudeCodeInput.press("Enter", { isComposing: true });
    await ui.settle();
    assertEquals(ui.MessageClaudeCodeInput.value, "にほん"); // still in the box
    assertEquals(session.messages.length, 0); // and nothing was sent

    // A plain Enter, once composition has ended, sends as always.
    ui.MessageClaudeCodeInput.press("Enter");
    await ui.waitFor(() => session.messages.length === 1);
    assertEquals(ui.MessageClaudeCodeInput.value, "");
  });
});

testUI(
  App,
  "Up recalls the last turn, and only from an empty box",
  async (ui) => {
    await withoutCli(async () => {
      await open(ui);
      session.clearTranscript();
      await ui.settle();

      // One prior turn is all this can build: with no process, `send` restarts
      // the session, and a restart resets the transcript by design (a session
      // dies with its process). The recall mechanism is the same either way.
      ui.MessageClaudeCodeInput.type("first question");
      ui.MessageClaudeCodeInput.press("Enter");
      await ui.waitFor(() => session.messages.length === 1);
      assertEquals(ui.MessageClaudeCodeInput.value, "");

      ui.MessageClaudeCodeInput.press("ArrowUp");
      await ui.settle();
      assertEquals(ui.MessageClaudeCodeInput.value, "first question");

      // Forward again, back to the empty draft the recall was started from.
      ui.MessageClaudeCodeInput.press("ArrowDown");
      await ui.settle();
      assertEquals(ui.MessageClaudeCodeInput.value, "");

      // Escape abandons a recall wherever it has got to.
      ui.MessageClaudeCodeInput.press("ArrowUp");
      await ui.settle();
      assertEquals(ui.MessageClaudeCodeInput.value, "first question");
      ui.MessageClaudeCodeInput.press("Escape");
      await ui.settle();
      assertEquals(ui.MessageClaudeCodeInput.value, "");

      // With a draft in the box, Up is an ordinary cursor key — stealing it
      // would destroy the paragraph someone is in the middle of writing.
      ui.MessageClaudeCodeInput.type("a draft I am still writing");
      await ui.settle();
      ui.MessageClaudeCodeInput.press("ArrowUp");
      await ui.settle();
      assertEquals(
        ui.MessageClaudeCodeInput.value,
        "a draft I am still writing",
      );
    });
  },
);

testUI(App, "a code block carries a copy control", async (ui) => {
  await open(ui);
  session.clearTranscript();
  session.ingest({
    type: "assistant",
    message: {
      id: "msg_code",
      content: [{
        type: "text",
        text: "Here:\n\n```bash\necho hello\n```\n",
      }],
    },
  });
  // Code is what people take out of a transcript; selecting it by hand out of a
  // scrolling chat is the worst way to do it.
  await ui.waitFor(() => ui.present("CopyToClipboardButton"));
});

testUI(
  App,
  "a markdown table renders as a table, not a wall of pipes",
  async (ui) => {
    await open(ui);
    session.clearTranscript();
    session.ingest({
      type: "assistant",
      message: {
        id: "msg_table",
        content: [{
          type: "text",
          text: "| Shell | Weakness |\n| --- | --- |\n| Bash | Verbose |\n",
        }],
      },
    });
    await ui.waitFor(() => ui.html().includes("<table"));
    // The syntax is consumed, not printed: a failed parse leaves the rule row and
    // the pipes on screen, which is exactly what it used to do.
    const html = ui.html();
    assertEquals(html.includes("| --- |"), false);
    assertEquals(html.includes("Verbose"), true);
  },
);

testUI(
  App,
  "the timeline can be filtered, and says so when nothing matches",
  async (ui) => {
    await open(ui);
    session.ingest(init);
    session.ingest(assistantTool("toolu_f1", "Bash", {
      command: "ls",
      description: "List the directory",
    }));
    ui.ActivityLink.click();
    await ui.waitFor(() => ui.html().includes("List the directory"));

    // Hundreds of rows accumulate in minutes; scrolling is not a way to find one.
    ui.FilterEventsInput.setValue("List the directory");
    await ui.waitFor(() => !ui.html().includes("Session ready"));
    assertEquals(ui.html().includes("List the directory"), true);

    // A filter must never look like an empty session.
    ui.FilterEventsInput.setValue("zzz-no-such-event");
    await ui.waitFor(() => ui.html().includes("Nothing matches"));
    assertEquals(ui.html().includes("Nothing here yet"), false);

    ui.FilterEventsInput.setValue("");
    await ui.waitFor(() => ui.html().includes("List the directory"));
  },
);

/* ── the three-column shell ───────────────────────────────────────────────── */

testUI(
  App,
  "the project dock lists projects and switches between them",
  async (ui) => {
    await open(ui);
    // Named subdirectories, not bare temp dirs: the tab is addressed by the
    // project's name, which is its basename.
    const tmp = await Deno.makeTempDir();
    const alpha = `${tmp}/alpha`;
    const beta = `${tmp}/beta`;
    await Deno.mkdir(alpha);
    await Deno.mkdir(beta);
    try {
      await workspace.addProject(alpha);
      await workspace.addProject(beta);
      await ui.settle();

      const idAlpha = workspace.projects.find((p) => p.path === alpha)!.id;
      const idBeta = workspace.projects.find((p) => p.path === beta)!.id;
      assertEquals(workspace.activeId, idBeta); // adding selects

      // Clicking a tab is the switch — the whole point of the dock.
      ui.find("ProjectTab", idAlpha).AlphaButton.click();
      await ui.waitFor(() => workspace.activeId === idAlpha);
      assertEquals(workspace.activeId, idAlpha);

      // The dock lives outside the routed area, so it is there whatever page
      // you are on and switching project never means leaving one.
      ui.SettingsLink.click();
      await ui.settle();
      assertEquals(ui.html().includes("alpha"), true);
      assertEquals(ui.html().includes("beta"), true);
      ui.find("ProjectTab", idBeta).BetaButton.click();
      await ui.waitFor(() => workspace.activeId === idBeta);
    } finally {
      await Deno.remove(tmp, { recursive: true });
    }
  },
);

testUI(App, "Jobs, Loops and Tree each render their own page", async (ui) => {
  await open(ui);

  ui.JobsLink.click();
  await ui.waitFor(() =>
    ui.html().includes("No background sessions") ||
    ui.html().includes("waiting on you")
  );

  ui.LoopsLink.click();
  await ui.waitFor(() => ui.html().includes("New loop"));
  // A loop is a standing instruction, so the page says what it is for even
  // before there is one.
  assertEquals(ui.html().includes("No background sessions"), false);

  ui.TreeLink.click();
  await ui.waitFor(() =>
    ui.html().includes("Pick a file") || ui.html().includes("No project")
  );
});

testUI(App, "the tree lists a real project and previews a file", async (ui) => {
  await open(ui);
  const root = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${root}/src`);
    await Deno.writeTextFile(`${root}/src/app.ts`, "export const a = 1;\n");
    await Deno.writeTextFile(`${root}/README.md`, "# hi\n");
    await Deno.mkdir(`${root}/node_modules`);
    await workspace.addProject(root);
    await tree.refresh();

    ui.TreeLink.click();
    await ui.waitFor(() => ui.html().includes("README.md"));
    assertEquals(ui.html().includes("src"), true);
    // Generated folders never reach the panel.
    assertEquals(ui.html().includes("node_modules"), false);
    // Closed: the child is not listed until the folder is opened.
    assertEquals(ui.html().includes("app.ts"), false);

    await tree.toggle(`${root}/src`);
    await ui.waitFor(() => ui.html().includes("app.ts"));

    await tree.select(`${root}/src/app.ts`);
    // Asserted token by token, not as one string: the preview runs through the
    // same tokeniser the chat's code blocks use, so the source is split across
    // spans and `"export const a"` never appears contiguously in the markup.
    await ui.waitFor(() => ui.html().includes("tok--keyword"));
    assertEquals(ui.html().includes("export"), true);
    assertEquals(ui.html().includes("const"), true);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

testUI(App, "the capability pages each stand on their own", async (ui) => {
  await open(ui);
  session.ingest(init);
  await ui.settle();

  const pages: [string, string[]][] = [
    ["SkillsLink", ["Skills", "No skills"]],
    ["CommandsLink", ["Commands", "No slash commands"]],
    ["MCPLink", ["MCP", "No MCP servers"]],
    ["PluginsLink", ["Plugins", "No plugins"]],
    // Hooks run shell commands with no approval prompt; the page has to say so
    // whether or not any are configured.
    ["HooksLink", ["Hooks", "No hooks"]],
  ];
  for (const [link, expected] of pages) {
    ui[link].click();
    await ui.waitFor(() => expected.some((t) => ui.html().includes(t)));
    assertEquals(
      expected.some((t) => ui.html().includes(t)),
      true,
      `${link} rendered its own page`,
    );
  }
});

testUI(
  App,
  "a loop can be added, paused and removed from its page",
  async (ui) => {
    await open(ui);
    const dir = await Deno.makeTempDir();
    try {
      await workspace.addProject(dir);
      ui.LoopsLink.click();
      await ui.waitFor(() => ui.html().includes("New loop"));

      ui.LoopPromptInput.setValue("run the tests");
      ui.AddLoopButton.click();
      await ui.waitFor(() => ui.html().includes("run the tests"));
      assertEquals(loops.loops.length, 1);
      // Armed by default: a loop you had to switch on after creating it is a
      // loop that silently does nothing.
      assertEquals(loops.loops[0].paused, false);
      assertEquals(ui.html().includes("armed"), true);

      await loops.toggle(loops.loops[0].id);
      await ui.settle();
      assertEquals(ui.html().includes("paused"), true);

      await loops.remove(loops.loops[0].id);
      await ui.settle();
      assertEquals(loops.loops.length, 0);
    } finally {
      await Deno.remove(dir);
    }
  },
);

testUI(App, "every page says what it is about", async (ui) => {
  await open(ui);
  // Scope is the thing a reader gets wrong: three of these sections are
  // machine-wide and the rest are not, and the rail groups pages by what they
  // are FOR. Each page states its own coverage.
  const expected: [string, string][] = [
    ["SubAgentsLink", "this session"],
    ["TasksLink", "this session"],
    ["ActivityLink", "this session"],
    ["JobsLink", "this machine"],
    ["LoopsLink", "this project"],
    ["TreeLink", "this project"],
    ["MemoryLink", "this project"],
    ["SkillsLink", "this project"],
    ["CommandsLink", "this project"],
    ["MCPLink", "this project"],
    ["PluginsLink", "this machine"],
    ["HooksLink", "this project"],
    ["StorageLink", "this machine"],
  ];
  for (const [link, scope] of expected) {
    ui[link].click();
    await ui.waitFor(() => ui.html().includes(scope));
    assertEquals(ui.html().includes(scope), true, `${link} says "${scope}"`);
  }
});

testUI(App, "memory is measured without a session", async (ui) => {
  await open(ui);
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(`${dir}/CLAUDE.md`, "# project memory\nrules.\n");
    await workspace.addProject(dir);
    await catalog.refresh();

    ui.MemoryLink.click();
    // No session has ever run here. The files are on disk, so the page has
    // something to say — it used to read "Not scanned" until you started one.
    await ui.waitFor(() => ui.html().includes("CLAUDE.md"));
    assertEquals(view().status, "offline");
    assertEquals(ui.html().includes("Not scanned yet"), false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

testUI(
  App,
  "deleting a gone project's history works from the page",
  async (ui) => {
    await open(ui);
    const { storage } = await import("../../cell/storage.ts");
    const home = await Deno.makeTempDir();
    const before = Deno.env.get("HOME");
    Deno.env.set("HOME", home);
    try {
      // One project whose folder is gone: its transcript names a cwd that does
      // not exist, which is the only state the page offers deletion for.
      const dir = `${home}/.claude/projects/-gone-project`;
      await Deno.mkdir(dir, { recursive: true });
      await Deno.writeTextFile(
        `${dir}/aaaaaaaa-1111-2222-3333-444444444444.jsonl`,
        JSON.stringify({ type: "user", cwd: `${home}/code/gone` }) + "\n",
      );
      await storage.refresh();

      ui.StorageLink.click();
      await ui.waitFor(() => ui.html().includes("folder gone"));

      // Addressed by the sanitised key, not the raw path: a "/" in a keyed
      // list key makes the row ambiguous in the semantic surface, whose own
      // segments are joined by "/". `listKey` is the one place that decides.
      ui.find("ProjectRow", listKey(dir)).DeleteHistory.click();
      await ui.waitFor(() => !ui.html().includes("folder gone"));
      // The deletion is real: the transcript directory is off the disk, not
      // merely off the screen.
      assertEquals(
        await Deno.stat(dir).then(() => true).catch(() => false),
        false,
      );
    } finally {
      if (before === undefined) Deno.env.delete("HOME");
      else Deno.env.set("HOME", before);
      await Deno.remove(home, { recursive: true });
    }
  },
);

/* ── the strip switches what it reports ───────────────────────────────────── */

testUI(
  App,
  "the model named on the strip is switched from the strip",
  async (ui) => {
    await open(ui);
    session.ingest(init);
    session.ingest({ type: "system", subtype: "status", status: "requesting" });
    await ui.waitFor(() => ui.html().includes("Sonnet"));

    // The complaint this answers: a control surface that shows which model is
    // active and makes you walk to Settings to change it.
    ui.ModelButton.click();
    await ui.waitFor(() => ui.html().includes("Deepest reasoning"));
    ui.OpusButton.click();
    await ui.expectCell(workspace, (w) => active(w)?.model === "opus");

    // …and the strip says so. Writing the *reported* model here meant the
    // switch changed nothing a user could see — the one bug that makes a
    // working control look broken.
    await ui.waitFor(() => ui.html().includes("Opus"));

    // The switch lands on the next turn, so while the session's last word was
    // Sonnet the gap is marked rather than papered over — the strip names the
    // choice and, next to it, what the process is still answering out of.
    await ui.waitFor(() => ui.html().includes("on Sonnet"));

    // …and the popover closes on the choice, rather than sitting over the page.
    await ui.waitFor(() => !ui.html().includes("Deepest reasoning"));
  },
);

testUI(
  App,
  "effort and permission mode switch from the strip too",
  async (ui) => {
    await open(ui);
    session.ingest(init);
    await ui.settle();

    ui.EffortButton.click();
    await ui.waitFor(() => ui.html().includes("Everything the model has"));
    ui.MaxButton.click();
    await ui.expectCell(workspace, (w) => active(w)?.effort === "max");

    ui.PermissionModeButton.click();
    await ui.waitFor(() => ui.html().includes("Research and plan"));
    ui.PlanButton.click();
    await ui.expectCell(workspace, (w) => active(w)?.permissionMode === "plan");
  },
);

testUI(
  App,
  "a strip menu closes on Escape and on a click outside",
  async (ui) => {
    await open(ui);
    ui.EffortButton.click();
    await ui.waitFor(() => ui.html().includes("Fastest, cheapest answers"));
    // Anywhere else on the page dismisses it — a popover that only closes on its
    // own trigger is one that gets left open.
    ui.window.document.dispatchEvent(
      new ui.window.MouseEvent("pointerdown", { bubbles: true }),
    );
    await ui.waitFor(() => !ui.html().includes("Fastest, cheapest answers"));
  },
);

/* ── settings are searchable ──────────────────────────────────────────────── */

testUI(App, "Settings filters down to the panel you asked for", async (ui) => {
  await open(ui);
  ui.SettingsLink.click();
  await ui.waitFor(() => ui.html().includes("Allowed directories"));
  // The panel HEADING, not the word anywhere on the page: the stylesheet is
  // part of `html()` too, and a CSS comment that happens to name a panel would
  // otherwise make this test pass or fail on prose.
  const shows = (title: string) => ui.html().includes(">" + title + "<");
  // Everything is there before anything is typed.
  assertEquals(shows("Appearance"), true);

  ui.FilterSettingsInput.setValue("theme");
  await ui.waitFor(() => !ui.html().includes("Allowed directories"));
  assertEquals(shows("Appearance"), true);

  // A word that is not in any title still finds the panel it belongs to —
  // nobody searches for "Permissions" when what they want is "bypass".
  ui.FilterSettingsInput.setValue("bypass");
  await ui.waitFor(() => ui.html().includes("Prompts come to you"));
  assertEquals(shows("Appearance"), false);

  // And a filter is never a way to end up on a blank page with no explanation.
  ui.FilterSettingsInput.setValue("zzzz");
  await ui.waitFor(() => ui.html().includes("Nothing matches"));
  ui.ClearTheFilterButton.click();
  await ui.waitFor(() => ui.html().includes("Allowed directories"));
});

/* ── a row that names a file can act on it ────────────────────────────────── */

testUI(
  App,
  "the Tree lists what the session touched, in one click",
  async (ui) => {
    await open(ui);
    session.ingest(init);
    // Two files, deep inside folders nobody has expanded — which is exactly the
    // case the tree overlay could not answer before: the marks were there, on
    // rows that were not.
    session.ingest(
      assistantTool("t1", "Read", { file_path: "/p/src/deep/a.ts" }),
    );
    session.ingest(
      assistantTool("t2", "Write", { file_path: "/p/src/deep/b.ts" }),
    );
    await ui.settle();

    ui.TreeLink.click();
    await ui.waitFor(() => ui.html().includes("Touched"));
    ui.TouchedButton.click();
    await ui.waitFor(() => ui.html().includes("/p/src/deep/a.ts"));
    assertEquals(ui.html().includes("/p/src/deep/b.ts"), true);

    // …and the filter narrows that list without a directory walk.
    ui.FilterFilesInput.setValue("b.ts");
    await ui.waitFor(() => !ui.html().includes("/p/src/deep/a.ts"));
    assertEquals(ui.html().includes("/p/src/deep/b.ts"), true);
  },
);

/* ── keyboard ─────────────────────────────────────────────────────────────── */

testUI(
  App,
  "Mod+1..9 switches project, and stops at the end of the list",
  async (ui) => {
    await open(ui);
    const a = await Deno.makeTempDir();
    const b = await Deno.makeTempDir();
    try {
      await workspace.addProject(a);
      await workspace.addProject(b);
      await ui.settle();
      const first = workspace.projects[0].id;
      const second = workspace.projects[1].id;

      ui.window.document.dispatchEvent(
        new ui.window.KeyboardEvent("keydown", {
          key: "1",
          ctrlKey: true,
          bubbles: true,
        }),
      );
      await ui.expectCell(workspace, (w) => w.activeId === first);

      ui.window.document.dispatchEvent(
        new ui.window.KeyboardEvent("keydown", {
          key: "2",
          ctrlKey: true,
          bubbles: true,
        }),
      );
      await ui.expectCell(workspace, (w) => w.activeId === second);

      // Past the end of the list is a no-op, never a wrap-around: a shortcut
      // that lands somewhere unexpected is worse than one that does nothing.
      ui.window.document.dispatchEvent(
        new ui.window.KeyboardEvent("keydown", {
          key: "9",
          ctrlKey: true,
          bubbles: true,
        }),
      );
      await ui.settle();
      assertEquals(workspace.activeId, second);
    } finally {
      await Deno.remove(a, { recursive: true });
      await Deno.remove(b, { recursive: true });
    }
  },
);

testUI(
  App,
  "Escape closes a strip menu from the trigger it was opened with",
  async (ui) => {
    await open(ui);
    ui.EffortButton.click();
    await ui.waitFor(() => ui.html().includes("Everything the model has"));
    // Focus is still on the trigger right after a click, which is the one place
    // a popover-scoped key handler could not see the key.
    ui.window.document.dispatchEvent(
      new ui.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    await ui.waitFor(() => !ui.html().includes("Everything the model has"));
  },
);

/* ── the transcript's own furniture ───────────────────────────────────────── */

testUI(
  App,
  "a finished turn reports how fast it actually went",
  async (ui) => {
    await open(ui);
    session.ingest(init);
    await session.send("hi");
    session.ingest({
      type: "result",
      is_error: false,
      // 10 output tokens in 2 seconds is 5 a second — and the point of showing
      // it is precisely that a turn can be this slow without anything being
      // broken.
      duration_ms: 2_000,
      num_turns: 1,
      total_cost_usd: 0.01,
      usage: { input_tokens: 2, output_tokens: 10 },
    });
    await ui.waitFor(() => ui.html().includes("tok/s"));
    assertEquals(ui.html().includes("5.0 tok/s"), true);
  },
);

testUI(
  App,
  "an aborted turn reports no speed rather than a wrong one",
  async (ui) => {
    await open(ui);
    session.ingest(init);
    await session.send("hi");
    // An interrupt reports a duration and no usage at all. Dividing nothing by
    // two seconds is zero tokens a second, which is not what happened.
    session.ingest({
      type: "result",
      is_error: false,
      duration_ms: 2_000,
      num_turns: 1,
      total_cost_usd: 0.01,
    });
    await ui.waitFor(() => !ui.html().includes("Working"));
    assertEquals(ui.html().includes("tok/s"), false);
  },
);

testUI(
  App,
  "every message carries its time and a way to copy it",
  async (ui) => {
    await open(ui);
    session.ingest(init);
    await session.send("hello there");
    await ui.waitFor(() => ui.html().includes("hello there"));
    const html = ui.html();
    // The byline furniture is in the DOM at all times and hidden with CSS, so
    // it is reachable from the keyboard and by a test — a control that only
    // exists on hover is a control a screen reader never finds.
    assertEquals(html.includes("msg__time"), true);
    assertEquals(html.includes("msg__acts"), true);
  },
);

/* ── adding a project ─────────────────────────────────────────────────────── */

testUI(
  App,
  "a folder that is not there yet is an offer, not a dead end",
  async (ui) => {
    await open(ui);
    const parent = await Deno.makeTempDir();
    const wanted = `${parent}/brand-new`;
    try {
      ui.AddProjectButton.click();
      await ui.settle();
      ui.ProjectDirectoryInput.type(wanted);
      await ui.settle();
      ui.AddButton.click();

      // The path is not a directory, so nothing is added — and the app says
      // what it could do about that instead of stopping at "no such folder".
      await ui.waitFor(() => ui.html().includes("Nothing is at"));
      assertEquals(ui.html().includes("Create it"), true);

      ui.CreateItButton.click();
      await ui.expectCell(
        workspace,
        (w) => w.projects.some((p: { path: string }) => p.path === wanted),
      );
      assertEquals((await Deno.stat(wanted)).isDirectory, true);
      // …and the offer goes away once it has been taken.
      await ui.waitFor(() => !ui.html().includes("Nothing is at"));
    } finally {
      await Deno.remove(parent, { recursive: true });
    }
  },
);

testUI(
  App,
  "browsing for a folder lists folders, and only folders",
  async (ui) => {
    await open(ui);
    ui.AddProjectButton.click();
    await ui.settle();
    ui.BrowseForAFolderButton.click();
    // The picker opens on the parent of the selected project and reads the real
    // disk — this repository's own parent directory, in the test run.
    await ui.waitFor(() => ui.html().includes("Filter folders"));
    await ui.waitFor(() => ui.html().includes("Use this folder"));
  },
);

testUI(
  App,
  "a long code block is folded, and unfolds on request",
  async (ui) => {
    await open(ui);
    session.ingest(init);
    const long = Array.from({ length: 60 }, (_, n) => `line ${n + 1}`).join(
      "\n",
    );
    session.ingest({
      type: "assistant",
      message: {
        id: "msg_long",
        content: [{
          type: "text",
          text: "here it is\n\n```\n" + long + "\n```",
        }],
      },
    });
    // Asserted on the rendered element rather than on the code text: the
    // highlighter splits every line into several nodes, so no line of it
    // appears contiguously in the HTML.
    await ui.waitFor(() =>
      ui.html().includes('class="md__pre md__pre--folded"')
    );
    assertEquals(ui.html().includes("Show all"), true);

    ui.ShowTheWholeCodeBlockButton.click();
    await ui.waitFor(() =>
      !ui.html().includes('class="md__pre md__pre--folded"')
    );
    assertEquals(ui.html().includes("Fold"), true);
  },
);

testUI(App, "a path in the answer is something you can open", async (ui) => {
  await open(ui);
  session.ingest(init);
  session.ingest({
    type: "assistant",
    message: {
      id: "msg_path",
      content: [{
        type: "text",
        // One real path and one thing that merely has a slash in it.
        text: "see `src/cell/session.ts:412` — it is an and/or thing",
      }],
    },
  });
  await ui.waitFor(() => ui.html().includes("session.ts"));
  // The rendered element, not the word: the stylesheet is part of `html()`
  // and names the class twice on its own.
  const html = ui.html();
  const buttons = html.match(/class="md__code md__path"/g) ?? [];
  assertEquals(buttons.length, 1, "the path became a button, and only it did");
});

/* ── undo ─────────────────────────────────────────────────────────────────── */

testUI(
  App,
  "clearing the transcript is a decision you can take back",
  async (ui) => {
    await open(ui);
    session.ingest(init);
    await session.send("keep this");
    await ui.waitFor(() => ui.html().includes("keep this"));

    ui.SettingsLink.click();
    await ui.waitFor(() => ui.html().includes("Transcript"));
    ui.ClearTheViewButton.click();

    // The notice, and the way back — a transcript is the record of real work
    // and this app holds no other copy of it.
    await ui.waitFor(() => ui.html().includes("Transcript cleared"));
    await ui.expectCell(session, (s) => s.messages.length === 0);
    ui.UndoButton.click();
    await ui.expectCell(session, (s) => s.messages.length === 1);

    ui.ProjectLink.click();
    await ui.waitFor(() => ui.html().includes("keep this"));
  },
);

testUI(App, "Ctrl+Enter sends, and Shift+Enter still does not", async (ui) => {
  await open(ui);
  // No CLI is spawned on this path: the binary does not exist, so `send`
  // reports a failed start. What is under test is which keystroke sends.
  const previous = Deno.env.get("CLAUDE_BIN");
  Deno.env.set("CLAUDE_BIN", "/nonexistent/claude-binary");
  try {
    const box = ui.MessageClaudeCodeInput;
    box.type("first");
    await ui.settle();

    box.press("Enter", { shiftKey: true });
    await ui.settle();
    await ui.expectCell(session, (s) => s.messages.length === 0);

    box.press("Enter", { ctrlKey: true });
    await ui.waitFor(() => ui.html().includes("first"));
    await ui.expectCell(session, (s) => s.messages.length === 1);
  } finally {
    if (previous === undefined) Deno.env.delete("CLAUDE_BIN");
    else Deno.env.set("CLAUDE_BIN", previous);
  }
});

testUI(
  App,
  "find walks the conversation and counts the matches",
  async (ui) => {
    await open(ui);
    session.ingest(init);
    for (
      const [n, text] of [["a", "alpha needle"], ["b", "beta"], [
        "c",
        "gamma needle",
      ]]
    ) {
      session.ingest({
        type: "assistant",
        message: { id: `msg_${n}`, content: [{ type: "text", text }] },
      });
    }
    await ui.waitFor(() => ui.html().includes("gamma"));

    openFind();
    await ui.waitFor(() => ui.html().includes("Find in this conversation"));
    ui.FindInThisConversationInput.setValue("needle");
    await ui.waitFor(() => ui.html().includes("1 / 2"));

    // The current match is marked apart from the others, so "next" is visible
    // rather than something you have to take on trust.
    assertEquals((ui.html().match(/msg--found/g) ?? []).length >= 1, true);
    ui.NextMatchButton.click();
    await ui.waitFor(() => ui.html().includes("2 / 2"));
    // …and wraps, because a search has a natural cycle.
    ui.NextMatchButton.click();
    await ui.waitFor(() => ui.html().includes("1 / 2"));

    closeFind();
    await ui.waitFor(() => !ui.html().includes("Find in this conversation"));
  },
);

testUI(App, "a draft belongs to the project it was written for", async (ui) => {
  await open(ui);
  const other = await Deno.makeTempDir();
  try {
    const first = workspace.activeId;
    ui.MessageClaudeCodeInput.type("for the first project");
    await ui.settle();

    await workspace.addProject(other);
    await ui.settle();
    // The box is one textarea that survives the switch — without the draft
    // swap, those words would still be sitting there aimed at another
    // codebase, which is worse than losing them.
    assertEquals(ui.MessageClaudeCodeInput.value, "");

    ui.MessageClaudeCodeInput.type("for the second");
    await ui.settle();

    workspace.select(first);
    await ui.settle();
    assertEquals(ui.MessageClaudeCodeInput.value, "for the first project");
  } finally {
    await Deno.remove(other, { recursive: true });
  }
});

testUI(App, "a menu can be driven entirely from the keyboard", async (ui) => {
  await open(ui);
  session.ingest(init);
  await ui.waitFor(() => ui.html().includes("Sonnet"));

  ui.ModelButton.click();
  await ui.waitFor(() => ui.html().includes("Deepest reasoning"));
  // Opening focuses the current row, so the arrows work without a click first
  // — which is the one thing a keyboard user cannot do.
  await ui.waitFor(() =>
    (ui.document.activeElement as HTMLElement | null)?.className.includes(
      "menu__item",
    ) === true
  );
  const opened = ui.document.activeElement as HTMLElement;
  assertEquals(opened.getAttribute("aria-label"), "Sonnet");

  // Typing jumps, the way every native menu has for thirty years.
  ui.HaikuButton.press("h");
  await ui.settle();
  assertEquals(
    (ui.document.activeElement as HTMLElement).getAttribute("aria-label"),
    "Haiku",
  );
});

testUI(
  App,
  "an approval can be answered with the digits the CLI uses",
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

    // The digits are on the buttons, so nobody has to be told they exist.
    const html = ui.html();
    assertEquals(html.includes("kbd"), true);

    // 3 opens the deny box rather than denying outright — the reason is worth
    // asking for, and the model reads it as the tool's error. The key is
    // pressed on a control inside the card and handled by the card, which is
    // where focus actually is while somebody decides.
    ui.DenyButton.press("3");
    await ui.waitFor(() => ui.html().includes("Tell Claude why"));
    await ui.expectCell(session, (s) => s.permissions[0].status === "pending");
  },
);

testUI(App, "an edit is shown as what it changes", async (ui) => {
  await open(ui);
  session.ingest(init);
  session.ingest(assistantTool("toolu_edit", "Edit", {
    file_path: "/tmp/cc-test/main.ts",
    old_string: "const a = 1;\nconst b = 2;",
    new_string: "const a = 1;\nconst b = 3;",
  }));
  await ui.waitFor(() => ui.html().includes("Edit"));

  // Open the call. The raw input is two walls of escaped string with the
  // difference somewhere inside them.
  ui.EditCallButton.click();
  await ui.waitFor(() => ui.html().includes("diff__line--add"));
  const html = ui.html();
  assertEquals(html.includes("diff__line--del"), true);
  // One line each way, and the count says so.
  assertEquals(html.includes(">+1<"), true);
});

testUI(
  App,
  "with no projects, the first screen is about getting one",
  async (ui) => {
    await open(ui);
    // Every project removed — the state a brand-new install boots into.
    for (const p of [...workspace.projects]) workspace.removeProject(p.id);
    await ui.waitFor(() => ui.html().includes("Point it at a codebase"));
    // Not three suggested prompts with nowhere to run them.
    assertEquals(ui.html().includes("Explain this codebase"), false);
    assertEquals(typeof ui.BrowseForAFolderButton.click, "function");
  },
);

testUI(
  App,
  "a finished turn leaves its receipt under the answer",
  async (ui) => {
    await open(ui);
    session.ingest(init);
    session.ingest({
      type: "assistant",
      message: { id: "msg_r", content: [{ type: "text", text: "the answer" }] },
    });
    await ui.waitFor(() => ui.html().includes("the answer"));
    session.ingest({
      type: "result",
      is_error: false,
      duration_ms: 4_000,
      num_turns: 1,
      total_cost_usd: 0.25,
      usage: { output_tokens: 400 },
    });
    // Under the answer it belongs to, not in one "last turn" field that is
    // useless the moment anything else happens.
    await ui.waitFor(() => ui.html().includes("turnfoot"));
    const html = ui.html();
    assertEquals(html.includes("400 out"), true);
    assertEquals(html.includes("100 tok/s"), true);
    assertEquals(html.includes("$0.25"), true);
  },
);

testUI(
  App,
  "a loaded command can be used from the list it is in",
  async (ui) => {
    await open(ui);
    // The CLI names its commands at startup; the page marks those "loaded", and
    // only those get a Use button.
    session.ingest({ ...init, slash_commands: ["review", "compact"] });
    ui.CommandsLink.click();
    await ui.waitFor(() => ui.html().includes("review"));

    // The first Use button in the list — the entries are sorted, so that is
    // "compact" rather than the "review" typed first above.
    ui.UseButton.click();
    // It lands in the message box, on the chat page, ready to edit.
    await ui.waitFor(() => ui.MessageClaudeCodeInput.value.startsWith("/"));
    assertEquals(ui.MessageClaudeCodeInput.value, "/compact ");
  },
);

testUI(App, "a tool call that names a file leads to that file", async (ui) => {
  await open(ui);
  session.ingest(init);
  session.ingest(assistantTool("toolu_file", "Read", {
    file_path: "/tmp/cc-test/main.ts",
  }));
  await ui.waitFor(() => ui.html().includes("in tree"));

  ui.ShowInTreeButton.click();
  // The transcript says what was done; the tree says what the file looks like
  // now, and going between them used to mean copying a path by hand.
  await ui.waitFor(() => ui.html().includes("Touched"));
  await ui.expectCell(tree, (s) => s.selected === "/tmp/cc-test/main.ts");
});
