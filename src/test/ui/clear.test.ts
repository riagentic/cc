/**
 * Emptying the conversation from the page it is on.
 *
 * The action already existed in Settings and in the palette, which is to say
 * it existed for people who already knew it existed. These pin the button
 * beside the transcript it empties, and the undo attached to it.
 */
import { assertEquals } from "@std/assert";
import { testUI } from "aio/testing";
import App from "../../App.tsx";
import { session, view } from "../../cell/session.ts";

const init = {
  type: "system",
  subtype: "init",
  cwd: "/home/dev/code/cc",
  session_id: "441e5bea-4547-42f1-9a5c-11d495c662ff",
  model: "claude-sonnet-5",
  tools: [],
  agents: [],
  skills: [],
  slash_commands: [],
  mcp_servers: [],
  permissionMode: "acceptEdits",
  claude_code_version: "2.1.226",
  memory_paths: {},
};

const reply = (id: string, text: string) => ({
  type: "assistant",
  message: { id, content: [{ type: "text", text }] },
});

testUI(
  App,
  "clear is offered beside the transcript, and refuses an empty one",
  async (ui) => {
    ui.ProjectLink.click();
    await ui.settle();
    session.clearTranscript();
    await ui.settle();

    // Disabled rather than hidden: a control that comes and goes is one you have
    // to hunt for, and "nothing to clear" is worth saying by being unpressable.
    assertEquals(ui.present("ClearTheConversationButton"), true);
    assertEquals(ui.ClearTheConversationButton.disabled, true);

    session.ingest(init);
    session.ingest(reply("msg_1", "All green."));
    await ui.settle();
    assertEquals(ui.ClearTheConversationButton.disabled, false);
  },
);

testUI(App, "clearing empties the view, and can be taken back", async (ui) => {
  ui.ProjectLink.click();
  await ui.settle();
  session.ingest(init);
  session.ingest(reply("msg_1", "This was said."));
  await ui.waitFor(() => view().messages.length > 0);

  ui.ClearTheConversationButton.click();
  await ui.waitFor(() => view().messages.length === 0);

  // The undo is the point: Clear sits next to the message box, and a
  // destructive button one slip away from Send needs a way back.
  session.undoClear();
  await ui.waitFor(() => view().messages.length === 1);
  assertEquals(ui.html().includes("This was said."), true);
});
