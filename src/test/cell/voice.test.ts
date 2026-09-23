/**
 * Push to talk.
 *
 * The rules worth pinning are the ones about NOT acting: a brushed key must
 * not put words in your mouth, a held key must not restart the recording on
 * every repeat, and — before any of that — a feature that is switched off
 * must not quietly be half-on.
 */
import { assertEquals } from "@std/assert";
import { testCell } from "aio/testing";
import { voice, voiceReady } from "../../cell/voice.ts";
import {
  answered,
  type Heard,
  mostConfident,
  transcribe,
} from "../../cell/voice.server.ts";

testCell(voice, "off by default, and off means nothing happens", (t) => {
  // The GPU whisper would hold is VRAM taken from the model this app exists
  // to run, so the feature starts switched off — and a dispatch that reaches
  // the cell anyway meets the same answer as the held key: silence.
  t.init();
  t.expect.state((s) => s.config.enabled === false);
  t.expect.state((_s) => voiceReady() === false);
  t.send.start();
  t.expect.state((s) => s.status === "off" && s.error === null);
  // A config without the field — saved before the switch existed — is off
  // too: "not set" must mean the default, never the feature.
  t.send.setEnabled("yes" as unknown as boolean);
  t.expect.state((s) => s.config.enabled === false);
});

testCell(voice, "enabling is what makes the key mean anything", (t) => {
  t.init();
  t.send.setEnabled(true);
  t.expect.state((s) => s.config.enabled === true);
  // …but an enabled feature with no server is still not ready — the address
  // is the other half of ready, and the panel says which half is missing.
  // (Asserted on the config itself, not on `voiceReady()`: the harness runs
  // these predicates against a draft view, and a live-cell read here would
  // be testing the harness's commit timing instead of the rule.)
  t.expect.state((s) => s.config.baseUrl === "");
  t.send.setBaseUrl("http://127.0.0.1:8910");
  t.expect.state(
    (s) => s.config.enabled === true && s.config.baseUrl !== "",
  );
  // And switching it off again parks everything: a recording in flight is
  // stopped, not "finishes this one last sentence".
  t.send.setEnabled(false);
  t.expect.state((s) => s.config.enabled === false);
  t.expect.state((_s) => voiceReady() === false);
});

testCell(
  voice,
  "without a server it says so rather than pretending",
  async (t) => {
    t.init();
    t.send.setEnabled(true);
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
  t.send.settled("", "", 0);
  t.expect.state((s) => s.status === "off");
  t.expect.state((s) => s.text === "" && s.turn === 0);
});

testCell(voice, "the same sentence twice is two turns", (t) => {
  t.init();
  t.send.settled("run the tests", "", 0);
  t.expect.state((s) => s.text === "run the tests" && s.turn === 1);
  t.send.taken();
  // Said again: the text is identical, so only the counter can tell the page
  // that something new happened. Without it the second one looks like the
  // first still sitting there.
  t.send.settled("run the tests", "", 0);
  t.expect.state((s) => s.turn === 2);
});

testCell(voice, "a failure is reported, not swallowed", (t) => {
  t.init({ status: "transcribing" });
  t.send.settled("", "the speech server answered 500", 0);
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
  t.send.thinking(0);
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

testCell(
  voice,
  "a press with nothing in it does not wipe the error before it",
  (t) => {
    // The microphone failed to open: status "error", saying why. The release
    // that follows finds no recording and discards — and used to go through
    // `settled("", "")`, which set "off" and logged "the model made no words",
    // so a broken mic looked, one release later, like a working one.
    t.init({ status: "error", error: "no such device", take: 1 });
    t.send.discarded(1);
    t.expect.state((s) => s.status === "error" && s.error === "no such device");
    // A brushed key, though, is just over.
    t.init({ status: "recording", take: 2, level: 0.3 });
    t.send.discarded(2);
    t.expect.state((s) => s.status === "off" && s.level === 0);
    t.expect.state((s) => s.turn === 0 && s.text === "");
  },
);

testCell(
  voice,
  "a second press is not ended by the first one's words",
  (t) => {
    // Press, release — transcribing — press again before the model answers.
    // The first turn's ending used to set "off" under the open microphone.
    t.init({ status: "recording", take: 2 });
    t.send.settled("first sentence", "", 1);
    // The words are still yours, and still handed over…
    t.expect.state((s) => s.text === "first sentence" && s.turn === 1);
    // …but the state belongs to the press that is recording now.
    t.expect.state((s) => s.status === "recording");
    // Nor can its late "transcribing" or its failure land on it.
    t.send.thinking(1);
    t.send.settled("", "the speech server answered 500", 1);
    t.send.discarded(1);
    t.expect.state((s) => s.status === "recording" && s.error === null);
    // The current press's own ending still works.
    t.send.settled("second", "", 2);
    t.expect.state((s) => s.status === "off" && s.turn === 2);
  },
);

testCell(voice, "every press is a new take", async (t) => {
  t.init({
    config: { ...t.state.config, enabled: true, baseUrl: "http://127.0.0.1:9" },
  });
  const before = t.state.take;
  // Capture fails or works depending on the machine — the take moves either
  // way, because the press happened.
  await t.send.start();
  t.expect.state((s) => s.take === before + 1);
  await t.send.cancel();
  t.expect.state((s) => s.status !== "recording" && s.turn === 0);
});

Deno.test("answered — a retry that failed does not sink the ones that worked", () => {
  const good: Heard = {
    text: "Testy jsou zelené",
    language: "czech",
    confidence: 0.9,
  };
  const out = answered([
    { status: "rejected", reason: new Error("the speech server answered 500") },
    { status: "fulfilled", value: good },
  ]);
  assertEquals(out, [good]);
  assertEquals(answered([{ status: "rejected", reason: "x" }]), []);
});

Deno.test("transcribe — one language failing keeps the answer in hand", async () => {
  // Detection says Polish; you speak Czech and Slovak; the Slovak retry fails.
  // Promise.all threw the lot away — including a perfectly good first answer.
  const server = Deno.serve({ port: 0, onListen() {} }, async (req) => {
    const form = await req.formData();
    const lang = String(form.get("language"));
    if (lang === "sk") return new Response("busy", { status: 500 });
    const body = lang === "cs"
      ? {
        text: "Testy jsou zelené",
        language: "czech",
        segments: [{ words: [{ probability: 0.9 }] }],
      }
      : {
        text: "Testy są zielone",
        language: "polish",
        segments: [{ words: [{ probability: 0.5 }] }],
      };
    return Response.json(body);
  });
  try {
    const url = `http://127.0.0.1:${server.addr.port}`;
    const text = await transcribe(new Uint8Array(44), {
      baseUrl: url,
      language: "",
      translate: false,
      spoken: ["cs", "sk"],
    }, AbortSignal.timeout(5000));
    assertEquals(text, "Testy jsou zelené");
  } finally {
    await server.shutdown();
  }
});
