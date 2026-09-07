/**
 * Unsent words, and where they go when you look at something else.
 *
 * The composer is one uncontrolled textarea shared by every conversation, and
 * it is unmounted whenever you leave the page. Both of those are the reason
 * this store exists, and both were places a half-written message used to be
 * lost — or worse, kept and shown against the wrong conversation.
 */
import { assertEquals } from "@std/assert";
import { testUI } from "aio/testing";
import App from "../../App.tsx";
import {
  dropDraft,
  loadDraft,
  saveDraft,
  swapDraft,
} from "../../ui/compose.ts";

Deno.test("drafts — kept per conversation, not per project", () => {
  // The bug. A project holds several chats; they share one textarea. Keyed by
  // project, switching between two of them swapped nothing, so the words
  // written for one stayed on screen aimed at the other.
  saveDraft("chat-1", "rewrite the grep worker");
  saveDraft("chat-2", "what does aloud.ts do");
  assertEquals(loadDraft("chat-1"), "rewrite the grep worker");
  assertEquals(loadDraft("chat-2"), "what does aloud.ts do");
  dropDraft("chat-1");
  dropDraft("chat-2");
});

Deno.test("drafts — a conversation with nothing in it hands back nothing", () => {
  assertEquals(loadDraft("never-seen"), "");
  // An empty draft is deleted rather than stored: "nothing" is the default,
  // and a map of empty strings is a leak that answers questions it need not.
  saveDraft("blank", "   \n  ");
  assertEquals(loadDraft("blank"), "");
  saveDraft("blank", "something");
  saveDraft("blank", "");
  assertEquals(loadDraft("blank"), "");
});

Deno.test("drafts — swapping moves one aside and brings the other back", () => {
  saveDraft("b", "the older thought");
  const nowShowing = swapDraft("a", "b", "the newer thought");
  assertEquals(nowShowing, "the older thought");
  assertEquals(loadDraft("a"), "the newer thought");
  // Swapping to where you already are changes nothing at all.
  assertEquals(swapDraft("b", "b", "mid-sentence"), "mid-sentence");
  dropDraft("a");
  dropDraft("b");
});

Deno.test("drafts — sending forgets it, and an unsaved key is refused", () => {
  saveDraft("sent", "run the tests");
  dropDraft("sent");
  assertEquals(loadDraft("sent"), "");
  // No conversation, nowhere to put it. Storing under "" would hand the same
  // words to whichever page next asked with no key.
  saveDraft("", "orphan");
  assertEquals(loadDraft(""), "");
});

/* ── driven the way a person drives it ────────────────────────────────────── */

// deno-lint-ignore no-explicit-any
async function chat(ui: any) {
  ui.ProjectLink.click();
  await ui.settle();
}

testUI(
  App,
  "a half-written message survives looking at something else",
  async (ui) => {
    await chat(ui);
    await ui.MessageClaudeCodeInput.type("do not lose this");
    assertEquals(ui.MessageClaudeCodeInput.value, "do not lose this");

    // The composer is UNMOUNTED here — this is not a hidden page, the textarea
    // is destroyed. Anything held only in the DOM is gone.
    ui.TreeLink.click();
    await ui.settle();
    assertEquals(ui.present("MessageClaudeCodeInput"), false);

    ui.ProjectLink.click();
    await ui.settle();
    assertEquals(ui.MessageClaudeCodeInput.value, "do not lose this");
  },
);

testUI(App, "sending it means there is nothing to come back to", async (ui) => {
  await chat(ui);
  await ui.MessageClaudeCodeInput.type("this one gets sent");
  ui.SendButton.click();
  await ui.settle();

  ui.SettingsLink.click();
  await ui.settle();
  ui.ProjectLink.click();
  await ui.settle();
  // A sent message is not a draft. Bringing it back would put the same words
  // in the box a second time, which reads as "it did not send".
  assertEquals(ui.MessageClaudeCodeInput.value, "");
});
