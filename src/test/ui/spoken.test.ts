/**
 * Reading the conversation aloud, driven the way a person drives it.
 *
 * These exist for one bug in particular. A component subscribes only to what
 * its render body touches, so a hook that reads the transcript inside its
 * effect subscribes to nothing, runs once, and never runs again — the messages
 * arrive, the cell holds them, and the speaker stays silent. This codebase has
 * shipped that exact bug twice (the terminal, then the transcription), and a
 * cell test cannot see it: it is a fact about rendering, not about state.
 *
 * The server address points at a closed port on purpose. Everything up to the
 * moment of speaking is exercised; nothing spawns a player or makes a sound.
 */
import { assertEquals } from "@std/assert";
import { testUI } from "aio/testing";
import App from "../../App.tsx";
import { session } from "../../cell/session.ts";
import { speech } from "../../cell/speech.ts";
import { pickable } from "../../ui/SpeechPanel.tsx";

/**
 * Nothing listens here, and the refusal is instant.
 *
 * Which is why these tests watch `said` rather than `saying`: `saying` is set
 * when a reading starts and cleared when it ends, and against a closed port
 * those two happen in the same tick. `said` is the cell's record of every
 * message id it accepted for reading, so it says exactly what went out and in
 * what order — which is the only question these tests are asking.
 */
const NOWHERE = "http://127.0.0.1:9";

const SESSION = "441e5bea-4547-42f1-9a5c-11d495c662ff";

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

const reply = (id: string, text: string) => ({
  type: "assistant",
  message: { id, content: [{ type: "text", text }] },
});

/** The turn is over. Until this arrives the last message is still being
 *  written, and a half-written sentence must not be read out — so every test
 *  that expects to HEAR something has to end its turn, exactly as the real
 *  thing does. */
const turnOver = { type: "result", is_error: false, usage: {} };

// deno-lint-ignore no-explicit-any
async function open(ui: any) {
  ui.ProjectLink.click();
  await ui.settle();
}

testUI(App, "the speaker is not offered until there is one", async (ui) => {
  await open(ui);
  // Two gates, and the button waits for both. Voice output is off as shipped,
  // and a control nobody can use is worse than no control: it reads as a
  // broken feature rather than an absent one.
  assertEquals(ui.present("ReadAloudButton"), false);

  speech.setBaseUrl(NOWHERE);
  await ui.settle();
  // A server, but the feature is still switched off — still nothing offered.
  assertEquals(ui.present("ReadAloudButton"), false);

  await speech.setEnabled(true);
  await ui.settle();
  assertEquals(ui.present("ReadAloudButton"), true);
  // Offered, and still off. Nothing about having a server means "start
  // talking".
  assertEquals(speech.status, "off");
});

testUI(App, "switching on does not recite the backlog", async (ui) => {
  await open(ui);
  speech.setBaseUrl(NOWHERE);
  await speech.setEnabled(true);
  session.ingest(init);
  session.ingest(reply("msg_old", "This was said before you switched me on."));
  await ui.settle();

  ui.ReadAloudButton.click();
  await ui.settle();
  assertEquals(speech.status, "idle");
  // The transcript on screen is not news. It is marked read, not read out.
  assertEquals(speech.said, []);
  assertEquals(speech.saying, "");
});

testUI(App, "a reply that arrives after that IS read out", async (ui) => {
  await open(ui);
  speech.setBaseUrl(NOWHERE);
  await speech.setEnabled(true);
  session.ingest(init);
  await ui.settle();
  ui.ReadAloudButton.click();
  await ui.settle();

  session.ingest(reply("msg_new", "The tests are green."));
  session.ingest(turnOver);
  // The assertion this whole file exists for: it only passes if the hook re-ran
  // when the transcript changed. Read the transcript inside the effect instead
  // of in the render body and this is the line that goes red.
  await ui.waitFor(() => speech.said.includes("msg_new"));
  // And the words really went out — as far as a closed port, which is as far
  // as a test should ever take them.
  await ui.waitFor(() => (speech.error ?? "").length > 0);
});

testUI(App, "a reply with nothing to say is not spoken at all", async (ui) => {
  await open(ui);
  speech.setBaseUrl(NOWHERE);
  await speech.setEnabled(true);
  session.ingest(init);
  await ui.settle();
  ui.ReadAloudButton.click();
  await ui.settle();

  // All fence, no prose. Read literally this is forty seconds of punctuation;
  // the right amount of it to say out loud is none, and the marker still has
  // to move or every later render examines this message again.
  session.ingest(reply("msg_code", "```ts\nconst a = 1;\nexport { a };\n```"));
  session.ingest(turnOver);
  await ui.settle();
  // Nothing was sent, so nothing could fail. This is the difference between
  // "skipped it" and "tried and could not".
  assertEquals(speech.error, null);
  assertEquals(speech.status, "idle");
});

testUI(App, "switching off stops it and offers to start again", async (ui) => {
  await open(ui);
  speech.setBaseUrl(NOWHERE);
  await speech.setEnabled(true);
  session.ingest(init);
  await ui.settle();
  ui.ReadAloudButton.click();
  await ui.settle();

  ui.ReadAloudButton.click();
  await ui.waitFor(() => speech.status === "off");
  assertEquals(speech.saying, "");

  // A reply arriving now is not read, because nobody is listening — and the
  // proof is that nothing even tried to reach the server.
  session.ingest(reply("msg_after", "Nobody asked for this one."));
  session.ingest(turnOver);
  await ui.settle();
  assertEquals(speech.error, null);
  assertEquals(speech.status, "off");
});

Deno.test("the voice picker offers what the server has, not what it hoped for", () => {
  // Supertonic's ten. None of Kokoro's shortlist is here, and offering it
  // anyway is how switching engine used to break every sentence.
  const st = ["F1", "F2", "M1", "M2", "M9"];
  const a = pickable(st, "F1");
  assertEquals(a.best, ["F1", "F2", "M1", "M2"]);
  assertEquals(a.rest, ["M9"]);

  // Kokoro's, graded order first and the rest behind.
  const ko = ["am_michael", "af_heart", "zf_xiaoxiao"];
  const b = pickable(ko, "af_heart");
  assertEquals(b.best, ["af_heart", "am_michael"]);
  assertEquals(b.rest, ["zf_xiaoxiao"]);

  // Not probed yet: the current value has to be there or the select renders
  // blank and cannot be changed back to anything.
  assertEquals(pickable([], "af_heart"), { best: ["af_heart"], rest: [] });
});
