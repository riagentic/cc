/**
 * The engine switch through the real UI: a project moved to a local engine
 * gets the local conversation and loses the Claude chrome; moved back, the
 * Claude page returns untouched. This is the isolation contract, tested at
 * the surface where a regression would actually hurt.
 */
import { assertEquals } from "@std/assert";
import { testUI } from "aio/testing";
import App from "../../App.tsx";
import { local, localChat, localConfig } from "../../cell/local.ts";
import { workspace } from "../../cell/workspace.ts";

async function withProject(
  ui: { settle: () => Promise<void> },
  run: (id: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir();
  try {
    await workspace.addProject(dir);
    await ui.settle();
    await run(workspace.activeId);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

testUI(
  App,
  "switching engines swaps the chat page and the rail",
  async (ui) => {
    ui.ChatLink.click();
    await ui.settle();
    await withProject(ui, async (id) => {
      // Claude engine: the Claude composer and the full rail.
      assertEquals(ui.html().includes("Message Claude Code"), true);
      assertEquals(ui.html().includes("Sub-agents"), true);

      await local.setEngine(id, "ollama");
      await ui.settle();

      // Local engine: the local composer, no Claude-only cards.
      assertEquals(ui.html().includes("Message the local model"), true);
      assertEquals(ui.html().includes("Sub-agents"), false);
      assertEquals(ui.html().includes("Jobs"), false);
      assertEquals(ui.html().includes("MCP"), false);

      // Tree and Settings survive — they are about the project, not the CLI.
      assertEquals(typeof ui.TreeLink.click, "function");
      assertEquals(typeof ui.SettingsLink.click, "function");

      // And back: the Claude page returns, nothing about it was touched.
      await local.setEngine(id, "claude");
      await ui.settle();
      assertEquals(ui.html().includes("Message the local model"), false);
      assertEquals(ui.html().includes("Sub-agents"), true);
    });
  },
);

testUI(
  App,
  "the local page carries model, mode and the context meter",
  async (ui) => {
    ui.ChatLink.click();
    await ui.settle();
    await withProject(ui, async (id) => {
      await local.setEngine(id, "llamacpp");
      await local.setModel(id, "qwen-test");
      await ui.settle();

      assertEquals(ui.html().includes("llama.cpp"), true);
      assertEquals(ui.html().includes("qwen-test"), true);
      // The three modes are offered.
      for (const label of ["Chat", "Read-only", "Agent"]) {
        assertEquals(ui.html().includes(label), true, label);
      }
      // The meter budgets against the configured window.
      assertEquals(ui.html().includes("Context"), true);

      await local.setMode(id, "agent");
      await ui.settle();
      assertEquals(localChat(id).status, "idle");
    });
  },
);

testUI(App, "engine settings appear in Settings, per project", async (ui) => {
  ui.SettingsLink.click();
  await ui.settle();
  await withProject(ui, async (id) => {
    assertEquals(ui.html().includes("Engine"), true);
    await local.setEngine(id, "lmstudio");
    await ui.settle();
    // Address and window inputs exist only for a local engine…
    assertEquals(ui.html().includes("Server address"), true);
    assertEquals(ui.html().includes("Context window"), true);
    // …and the Claude-only panels are gone while it is active.
    assertEquals(ui.html().includes("Allowed directories"), false);

    await local.setEngine(id, "claude");
    await ui.settle();
    assertEquals(ui.html().includes("Allowed directories"), true);
  });
});

testUI(
  App,
  "a project parked on a Claude page falls back to local chat on switch",
  async (ui) => {
    ui.SubAgentsLink.click();
    await ui.settle();
    await withProject(ui, async (id) => {
      await local.setEngine(id, "ollama");
      await ui.settle();
      // The page whose rail card just disappeared must not keep rendering —
      // the local conversation takes the route over.
      assertEquals(ui.html().includes("Message the local model"), true);

      await local.setEngine(id, "claude");
      await ui.settle();
      assertEquals(ui.html().includes("Message the local model"), false);
    });
  },
);

testUI(
  App,
  "agent mode arms and asks before it is granted",
  async (ui) => {
    ui.ChatLink.click();
    await ui.settle();
    await withProject(ui, async (id) => {
      await local.setEngine(id, "llamacpp");
      await ui.settle();

      ui.AgentButton.click(); // the segmented option arms, nothing more
      await ui.settle();
      assertEquals(localConfig(id).mode, "chat");
      assertEquals(ui.html().includes("ask to run commands"), true);

      ui.EnableAgentModeButton.click();
      await ui.settle();
      assertEquals(localConfig(id).mode, "agent");
      // Agent mode writes files by itself and ASKS before a command — the
      // strip says which of those two it is, because they are very different
      // grants and only one of them can reach outside the project.
      assertEquals(ui.html().includes("can write files"), true);
      assertEquals(ui.html().includes("commands run unasked"), false);
    });
  },
);

testUI(App, "the engine panel reports the scan as it finishes", async (ui) => {
  ui.SettingsLink.click();
  await ui.settle();
  await withProject(ui, async () => {
    // Opening the panel IS the request to scan, so it starts one on mount.
    await local.detect(true);
    await ui.settle();

    // Whatever the machine is running, the panel must stop saying "not looked
    // for" the moment a scan lands. This is the reactivity the panel lives on:
    // it reads the local cell, so a write to it has to re-render the panel.
    assertEquals(ui.html().includes("have not been looked for"), false);
  });
});

testUI(
  App,
  "a local project waiting on a command says so from anywhere",
  async (ui) => {
    ui.ChatLink.click();
    await ui.settle();
    const other = await Deno.makeTempDir();
    await withProject(ui, async (id) => {
      await local.setEngine(id, "llamacpp");
      await ui.settle();
      // A held command, as the agent loop would set it.
      await local.askCommand(id, "c1", "rm -rf build");
      await ui.settle();
      assertEquals(ui.html().includes("rm -rf build"), true);

      // Look somewhere else. The prompt goes with the project — and the app
      // has to say the turn is still stopped, because nothing there moves
      // until it is answered.
      await workspace.addProject(other);
      await ui.settle();
      assertEquals(ui.html().includes("rm -rf build"), false);
      assertEquals(ui.html().includes("Nothing moves there"), true);

      // …and answering it clears both.
      await local.answer(id, false);
      await ui.settle();
      assertEquals(ui.html().includes("Nothing moves there"), false);
    });
    await Deno.remove(other, { recursive: true });
  },
);

testUI(
  App,
  "a server that cannot run tools says so, and says how to fix it",
  async (ui) => {
    ui.ChatLink.click();
    await ui.settle();
    await withProject(ui, async (id) => {
      await local.setEngine(id, "llamacpp");
      await ui.settle();
      // Nothing is claimed before anybody asked.
      assertEquals(ui.html().includes("--jinja"), false);

      // The probe's answer, as `autoTools` would store it.
      await local.applyTools(id, "llamacpp", localConfig(id).baseUrl, false);
      await ui.settle();

      // The launch flag is named — that is the whole point. A raw HTTP 500
      // from the server is not something a reader can act on.
      assertEquals(ui.html().includes("--jinja"), true);
      assertEquals(ui.html().includes("only Chat"), true);

      // …and it goes away the moment the server can, without a reload.
      await local.applyTools(id, "llamacpp", localConfig(id).baseUrl, true);
      await ui.settle();
      assertEquals(ui.html().includes("--jinja"), false);
    });
  },
);

testUI(
  App,
  "an answer about one server never lands on another",
  async (ui) => {
    ui.ChatLink.click();
    await ui.settle();
    await withProject(ui, async (id) => {
      await local.setEngine(id, "llamacpp");
      await ui.settle();
      // A probe of the address the project USED to have, arriving late.
      await local.applyTools(id, "llamacpp", "http://localhost:9999", false);
      await ui.settle();
      assertEquals(ui.html().includes("--jinja"), false);
    });
  },
);
