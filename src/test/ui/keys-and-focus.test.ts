/**
 * Keys that must stop where they land, state that must not outlive the thing
 * it was about, and focus and scroll that move only when asked.
 *
 * Each test pins a bug that shipped: an Escape in a small field that also ran
 * the app's own Escape (and stopped the turn), a no-undo Delete that stayed
 * armed on the next job, an "Allow all" confirm that followed you to another
 * project, and a find bar that stole the caret and shook the pane on every
 * streamed token.
 */
import { assert, assertEquals } from "@std/assert";
import { testUI } from "aio/testing";
import App from "../../App.tsx";
import { session, view } from "../../cell/session.ts";
import { jobs } from "../../cell/jobs.ts";
import { workspace } from "../../cell/workspace.ts";
import { closeFind, openFind } from "../../ui/find.tsx";
import { filterTree } from "../../ui/TreePage.tsx";
import type { Job, TreeNode } from "../../type/claude.ts";

// deno-lint-ignore no-explicit-any
type UI = any;

const SESSION = "5b0e7c1a-2f7d-4d51-9a54-6f1c8e3a9d10";

const init = {
  type: "system",
  subtype: "init",
  cwd: "/home/dev/code/cc",
  session_id: SESSION,
  model: "claude-sonnet-5",
  tools: ["Bash"],
  agents: [],
  skills: [],
  slash_commands: [],
  mcp_servers: [],
  permissionMode: "acceptEdits",
  claude_code_version: "2.1.226",
  memory_paths: {},
};

const canUseTool = {
  type: "control_request",
  request_id: "req-keys-1",
  request: {
    subtype: "can_use_tool",
    tool_name: "Bash",
    display_name: "Bash",
    input: { command: "curl -s https://example.com", description: "Fetch it" },
    description: "Fetch it",
    permission_suggestions: [],
    decision_reason: "This command requires approval",
    decision_reason_type: "subcommandResults",
    tool_use_id: "toolu_keys",
  },
};

/** Every test starts on the chat page — the router's location is global. */
async function open(ui: UI) {
  ui.ProjectLink.click();
  await ui.settle();
}

/** Escape, pressed in `el`, bubbling the way a real keystroke does. */
function escapeIn(ui: UI, el: Element) {
  el.dispatchEvent(
    new ui.window.KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    }),
  );
}

const q = (ui: UI, sel: string): HTMLElement | null =>
  ui.document.querySelector(sel);

/** A turn in flight, so a stray global Escape would have something to stop. */
async function working(ui: UI) {
  session.ingest(init);
  await session.send("hi");
  await ui.waitFor(() => view().status === "working");
}

/* ── Escape in a field stops in the field ─────────────────────────────────── */

testUI(
  App,
  "Escape in the deny-reason field backs out without stopping the turn",
  async (ui) => {
    await open(ui);
    await working(ui);
    session.ingest(canUseTool);
    await ui.waitFor(() => ui.html().includes("needs your approval"));

    ui.DenyButton.click();
    await ui.waitFor(() =>
      q(ui, 'input[aria-label="Reason for denying"]') !== null
    );
    escapeIn(ui, q(ui, 'input[aria-label="Reason for denying"]')!);
    await ui.settle();

    assertEquals(q(ui, 'input[aria-label="Reason for denying"]'), null);
    assertEquals(view().status, "working");
    assertEquals(view().interrupting, false, "the turn was not stopped");
  },
);

testUI(
  App,
  "Escape in the dock's add-project field only closes the field",
  async (ui) => {
    await open(ui);
    await working(ui);
    ui.AddProjectButton.click();
    await ui.waitFor(() =>
      q(ui, '.dock input[aria-label="Project directory"]') !== null
    );
    escapeIn(ui, q(ui, '.dock input[aria-label="Project directory"]')!);
    await ui.settle();

    assertEquals(q(ui, '.dock input[aria-label="Project directory"]'), null);
    assertEquals(view().interrupting, false, "the turn was not stopped");
  },
);

testUI(
  App,
  "Escape in Settings' add-project field stays in Settings",
  async (ui) => {
    await open(ui);
    ui.SettingsLink.click();
    await ui.waitFor(() => ui.window.location.pathname === "/settings");
    ui.document.querySelectorAll("button").forEach(
      (b: HTMLButtonElement) => {
        if (b.textContent?.trim() === "Add") b.click();
      },
    );
    await ui.waitFor(() =>
      q(ui, '.page input[aria-label="Project directory"]') !== null
    );
    escapeIn(ui, q(ui, '.page input[aria-label="Project directory"]')!);
    await ui.settle();

    assertEquals(q(ui, '.page input[aria-label="Project directory"]'), null);
    assertEquals(ui.window.location.pathname, "/settings");
  },
);

testUI(
  App,
  "Escape while naming a new folder keeps the folder picker open",
  async (ui) => {
    await open(ui);
    ui.AddProjectButton.click();
    await ui.settle();
    ui.BrowseForAFolderButton.click();
    await ui.waitFor(() => ui.html().includes("Filter folders"));
    ui.NewButton.click();
    await ui.waitFor(() =>
      q(ui, 'input[aria-label="New folder name"]') !== null
    );
    escapeIn(ui, q(ui, 'input[aria-label="New folder name"]')!);
    await ui.settle();

    assertEquals(q(ui, 'input[aria-label="New folder name"]'), null);
    assert(ui.html().includes("Filter folders"), "the picker stayed open");
  },
);

/* ── armed state belongs to what it was armed for ─────────────────────────── */

const job = (id: string, name: string): Job => ({
  id,
  sessionId: null,
  name,
  intent: `do ${name}`,
  state: "done",
  detail: "",
  needs: "",
  questions: [],
  cwd: "/tmp",
  model: null,
  tokens: 0,
  inFlight: { tasks: 0, queued: 0 },
  cliVersion: null,
  createdAt: 1,
  updatedAt: 1,
  timeline: [],
  worktree: null,
  stale: false,
} as unknown as Job);

testUI(
  App,
  "a Delete armed on one job is not armed on the next",
  async (ui) => {
    await open(ui);
    ui.JobsLink.click();
    await ui.waitFor(() => ui.window.location.pathname === "/jobs");
    await ui.settle();
    ui.seed({
      jobs: { jobs: [job("a1", "Alpha job"), job("b2", "Beta job")] },
    });
    jobs.select("a1");
    await ui.waitFor(() =>
      q(ui, 'button[aria-label="Remove Alpha job"]') !== null
    );

    q(ui, 'button[aria-label="Remove Alpha job"]')!.click();
    await ui.waitFor(() => ui.html().includes("Delete this conversation"));

    jobs.select("b2");
    await ui.waitFor(() =>
      q(ui, 'button[aria-label="Remove Beta job"]') !== null
    );
    assertEquals(
      ui.html().includes("Delete this conversation"),
      false,
      "the other job's Delete came up armed",
    );
  },
);

testUI(
  App,
  "an Allow all confirm armed in one project is not armed in another",
  async (ui) => {
    await open(ui);
    const other = await Deno.makeTempDir();
    try {
      const first = workspace.activeId;
      ui.SettingsLink.click();
      await ui.waitFor(() => ui.html().includes("Allow all"));
      ui.AllowAllButton.click();
      await ui.waitFor(() => ui.html().includes("no checks at all"));

      await workspace.addProject(other);
      await ui.waitFor(() => workspace.activeId !== first);
      await ui.settle();
      assertEquals(
        ui.html().includes("no checks at all"),
        false,
        "the confirm followed us to another project",
      );
    } finally {
      await Deno.remove(other, { recursive: true });
    }
  },
);

/* ── the find bar: focus once, scroll on a move ───────────────────────────── */

const say = (n: string, text: string) =>
  session.ingest({
    type: "assistant",
    message: { id: `msg_${n}`, content: [{ type: "text", text }] },
  });

testUI(
  App,
  "the find bar does not take the caret back from the message box",
  async (ui) => {
    await open(ui);
    session.ingest(init);
    say("a", "alpha needle");
    await ui.waitFor(() => ui.html().includes("alpha"));

    openFind();
    await ui.waitFor(() => q(ui, ".find__input") !== null);
    assertEquals(ui.document.activeElement, q(ui, ".find__input"));

    ui.FindInThisConversationInput.setValue("needle");
    await ui.waitFor(() => ui.html().includes("1 / 1"));

    const box = q(ui, ".composer textarea")!;
    box.focus();
    // The bar re-renders while it is open — each new match changes its count,
    // and a streamed reply re-renders the page ten times a second.
    for (const n of ["b", "c", "d"]) {
      say(n, `more needle ${n}`);
      await ui.settle();
    }
    await ui.waitFor(() => ui.html().includes("1 / 4"));
    assertEquals(ui.document.activeElement, box, "the find bar took focus");
    closeFind();
  },
);

testUI(
  App,
  "the current match is scrolled to when it moves, not on every render",
  async (ui) => {
    await open(ui);
    session.ingest(init);
    say("a", "alpha needle");
    say("b", "beta needle");
    await ui.waitFor(() => ui.html().includes("beta"));

    let scrolls = 0;
    const proto = ui.window.HTMLElement.prototype;
    const was = proto.scrollIntoView;
    proto.scrollIntoView = function () {
      if ((this as HTMLElement).hasAttribute("data-msg")) scrolls++;
    };
    try {
      openFind();
      await ui.waitFor(() => q(ui, ".find__input") !== null);
      ui.FindInThisConversationInput.setValue("needle");
      await ui.waitFor(() => ui.html().includes("1 / 2"));
      await ui.settle();
      assertEquals(scrolls, 1, "one scroll to the first match");

      for (const n of ["c", "d", "e"]) {
        say(n, `unrelated ${n}`);
        await ui.settle();
      }
      assertEquals(scrolls, 1, "renders alone do not scroll");

      ui.NextMatchButton.click();
      await ui.waitFor(() => ui.html().includes("2 / 2"));
      await ui.settle();
      assertEquals(scrolls, 2, "moving the match scrolls once");
    } finally {
      proto.scrollIntoView = was;
      closeFind();
    }
  },
);

/* ── the tree filter ──────────────────────────────────────────────────────── */

const node = (path: string, dir: boolean): TreeNode => ({
  path,
  name: path.slice(path.lastIndexOf("/") + 1),
  dir,
  bytes: dir ? null : 1,
  depth: path.split("/").length - 3,
  open: dir,
});

Deno.test("the tree filter keeps a match and every folder on its way", () => {
  const nodes = [
    node("/p/src", true),
    node("/p/src/ui", true),
    node("/p/src/ui/Button.tsx", false),
    node("/p/src/lib", true),
    node("/p/src/lib/util.ts", false),
    node("/p/docs", true),
    node("/p/docs/readme.md", false),
  ];
  assertEquals(
    filterTree(nodes, "button").map((n) => n.path),
    ["/p/src", "/p/src/ui", "/p/src/ui/Button.tsx"],
  );
  // A folder whose own name matches stays, with nothing under it required.
  assertEquals(filterTree(nodes, "docs").map((n) => n.path), ["/p/docs"]);
  // A folder is not "on the way" to a folder that matches — only to a file.
  assertEquals(filterTree(nodes, "ui").map((n) => n.path), ["/p/src/ui"]);
  assertEquals(filterTree(nodes, "  "), nodes);
  assertEquals(filterTree(nodes, "nothing-like-it"), []);
});

Deno.test("the tree filter is linear, not a scan per folder", () => {
  // 200 folders of 100 files: the per-folder scan did 20 000 × 200 checks.
  const nodes: TreeNode[] = [];
  for (let d = 0; d < 200; d++) {
    nodes.push(node(`/p/d${d}`, true));
    for (let f = 0; f < 100; f++) nodes.push(node(`/p/d${d}/f${f}.ts`, false));
  }
  const t0 = performance.now();
  const hit = filterTree(nodes, "f99.ts");
  const ms = performance.now() - t0;
  assertEquals(hit.length, 400);
  assert(ms < 250, `filtering 20 200 rows took ${ms.toFixed(0)} ms`);
});
