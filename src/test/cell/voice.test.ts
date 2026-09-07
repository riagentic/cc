/**
 * Push to talk.
 *
 * The rules worth pinning are the ones about NOT acting: a brushed key must
 * not put words in your mouth, and a held key must not restart the recording
 * on every repeat.
 */
import { assertEquals } from "@std/assert";
import { testCell } from "aio/testing";
import { voice } from "../../cell/voice.ts";
import { mostConfident } from "../../cell/voice.server.ts";

testCell(
  voice,
  "without a server it says so rather than pretending",
  async (t) => {
    t.init();
    await t.send.start();
    t.expect.state((s) => s.status === "error");
    t.expect.state((s) => (s.error ?? "").includes("Settings"));
    // And the error is dismissable back to a usable state, not a dead end.
    t.send.dismissError();
    t.expect.state((s) => s.status === "off" && s.error === null);
  },
);

testCell(voice, "silence is not transcribed", (t) => {
  // Whisper answers silence with confident invented sentences. A key brushed
  // by accident must therefore produce NOTHING — not an empty string that
  // still counts as a turn, and certainly not a guess.
  t.init({ status: "transcribing" });
  t.send.settled("", "");
  t.expect.state((s) => s.status === "off");
  t.expect.state((s) => s.text === "" && s.turn === 0);
});

testCell(voice, "the same sentence twice is two turns", (t) => {
  t.init();
  t.send.settled("run the tests", "");
  t.expect.state((s) => s.text === "run the tests" && s.turn === 1);
  t.send.taken();
  // Said again: the text is identical, so only the counter can tell the page
  // that something new happened. Without it the second one looks like the
  // first still sitting there.
  t.send.settled("run the tests", "");
  t.expect.state((s) => s.turn === 2);
});

testCell(voice, "a failure is reported, not swallowed", (t) => {
  t.init({ status: "transcribing" });
  t.send.settled("", "the speech server answered 500");
  t.expect.state((s) => s.status === "error");
  t.expect.state((s) => s.error === "the speech server answered 500");
  // And it does not leave stale words behind to be pasted later.
  t.expect.state((s) => s.text === "");
});

testCell(voice, "the meter only moves while recording", (t) => {
  t.init({ status: "recording" });
  t.send.hearing(0.5);
  t.expect.state((s) => s.level === 0.5);
  // Out of range is clamped rather than trusted — it drives a transform.
  t.send.hearing(9);
  t.expect.state((s) => s.level === 1);
  t.send.hearing(-1);
  t.expect.state((s) => s.level === 0);
  // A late chunk arriving after the key was released must not light the meter
  // back up under a "transcribing" label.
  t.send.thinking();
  t.send.hearing(0.8);
  t.expect.state((s) => s.level === 0);
});

testCell(voice, "settings are cleaned up, not taken as typed", (t) => {
  t.init();
  t.send.setBaseUrl("  http://127.0.0.1:8910/  ");
  t.expect.state((s) => s.config.baseUrl === "http://127.0.0.1:8910");
  t.send.setLanguage("  CS  ");
  t.expect.state((s) => s.config.language === "cs");
  // "" is a real answer: let the model detect it.
  t.send.setLanguage("");
  t.expect.state((s) => s.config.language === "");
  // An empty key would leave no way to talk at all, so it is refused.
  t.send.setKey("");
  t.expect.state((s) => s.config.key === "ControlRight");
  t.send.setKey("AltRight");
  t.expect.state((s) => s.config.key === "AltRight");
});

testCell(voice, "letting go sends, unless told otherwise", (t) => {
  t.init();
  // On by default. Saying a thing and having it happen is the point; a
  // misheard instruction to a chat is corrected by saying the next one, which
  // is not the same as a misheard command in a shell — and voice never reaches
  // a shell.
  t.expect.state((s) => s.config.autoSend === true);
  t.send.setAutoSend(false);
  t.expect.state((s) => s.config.autoSend === false);
  t.send.setAutoSend(true);
  t.expect.state((s) => s.config.autoSend === true);
});

testCell(voice, "when it cannot send, it says so", (t) => {
  // The failure people actually meet: auto-send is on, a reply is already
  // running, Send is therefore disabled, and clicking a disabled button is
  // silent. The words are in the box and the app does nothing and explains
  // nothing — which reads as "voice is unreliable" rather than "wait a moment".
  t.init();
  t.send.notSent("Heard you — press Enter to send, the last reply is running.");
  t.expect.state((s) => s.status === "error");
  t.expect.state((s) => (s.error ?? "").includes("press Enter"));

  // And speaking again clears it rather than leaving a stale complaint.
  t.send.dismissError();
  t.expect.state((s) => s.status === "off" && s.error === null);
});

testCell(
  voice,
  "words that were sent leave the cell idle, not 'no words'",
  (t) => {
    // The page used to call `settled("", "")` after clicking Send. That path
    // exists for a recording the model made nothing of, and it logs so — which
    // put a phantom "the model made no words" in the log after EVERY successful
    // sentence, right behind the real "heard". `sent` is the honest ending.
    t.init({ status: "queued", turn: 3, text: "", error: "stale" });
    t.send.sent();
    t.expect.state((s) => s.status === "off" && s.error === null);
    t.expect.state((s) => s.turn === 3); // nothing new was heard
  },
);

testCell(voice, "translation is a choice, and the default is not to", (t) => {
  // whisper-server's own default language is `en` — "this IS English", not
  // "detect" — so a Czech sentence came back translated. Writing down what
  // was said, in the language it was said in, is the default here; English
  // is something you turn on.
  t.init();
  t.expect.state((s) => s.config.translate === false);
  t.send.setTranslate(true);
  t.expect.state((s) => s.config.translate === true);
  t.send.setTranslate("yes" as unknown as boolean); // anything not `true` is off
  t.expect.state((s) => s.config.translate === false);
});

testCell(voice, "the languages you speak are a short, clean list", (t) => {
  t.init();
  t.expect.state((s) => s.config.spoken.length === 0); // trust detection
  t.send.setSpoken(["  CS ", "en", "cs"]);
  // Tidied and deduplicated: each entry costs a second request whenever
  // detection goes astray, so a duplicate is a wasted one.
  t.expect.state((s) => s.config.spoken.join(",") === "cs,en");
  // Capped. Nobody switches between six languages mid-sentence, and every one
  // past the first is another request on the rescue path.
  t.send.setSpoken(["a", "b", "c", "d", "e", "f", "g"]);
  t.expect.state((s) => s.config.spoken.length === 5);
  // Junk is ignored rather than stored.
  t.send.setSpoken(["cs", 7 as unknown as string, ""]);
  t.expect.state((s) => s.config.spoken.join(",") === "cs");
  t.send.setSpoken("cs" as unknown as string[]);
  t.expect.state((s) => s.config.spoken.join(",") === "cs"); // unchanged
});

Deno.test("mostConfident — the answer the model actually believed", () => {
  // The measured shape of the Czech-heard-as-Polish problem: pinning each
  // language and taking the mean word probability separates them cleanly.
  //   cs 0.913   sk 0.896   pl 0.785   ru 0.652   en 0.641
  const tries = [
    { text: "Testy są zelenie", language: "polish", confidence: 0.785 },
    { text: "Testy jsou zelené", language: "czech", confidence: 0.913 },
    { text: "Tests are green", language: "english", confidence: 0.641 },
  ];
  assertEquals(mostConfident(tries)?.language, "czech");

  // An answer with no words is not an answer, however sure it claims to be.
  assertEquals(
    mostConfident([
      { text: "", language: "russian", confidence: 0.99 },
      { text: "Testy jsou zelené", language: "czech", confidence: 0.4 },
    ])?.language,
    "czech",
  );
  // Nothing said at all: the caller keeps what it already had.
  assertEquals(mostConfident([]), null);
  assertEquals(
    mostConfident([{ text: "", language: "czech", confidence: 1 }]),
    null,
  );
  // A tie keeps the first, so the order the languages were listed in is the
  // tiebreak rather than something arbitrary.
  assertEquals(
    mostConfident([
      { text: "a", language: "czech", confidence: 0.8 },
      { text: "b", language: "slovak", confidence: 0.8 },
    ])?.language,
    "czech",
  );
});
