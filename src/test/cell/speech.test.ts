/**
 * Reading the conversation aloud.
 *
 * The rules worth pinning are the ones about staying quiet: an app that talks
 * when it was not asked to, or that carries on talking after being switched
 * off, is one people switch off permanently.
 */
import { testCell } from "aio/testing";
import { assertEquals } from "@std/assert";
import { sexOf, speech } from "../../cell/speech.ts";
import type { SpeechConfig } from "../../type/speech.ts";

/** The cell's own defaults with a few fields moved. `t.init` wants a whole
 *  config, and spelling all six out in every test hides which one the test is
 *  actually about. */
const cfg = (over: Partial<SpeechConfig> = {}): SpeechConfig => ({
  enabled: false,
  baseUrl: "",
  voiceOut: "af_heart",
  voiceIn: "am_michael",
  readMine: true,
  speed: 1,
  language: "",
  onAtStart: false,
  ...over,
});

/** Voice output switched on, pointed at a server. The state everything below
 *  the master switch is about — and `cfg()` above is deliberately NOT this,
 *  because the shipped default is off and no test should quietly assume
 *  otherwise. */
const setUp = (over: Partial<SpeechConfig> = {}): SpeechConfig =>
  cfg({ enabled: true, baseUrl: "http://x", ...over });

testCell(speech, "without a server it says so rather than pretending", (t) => {
  // Switched on, nowhere to send it: the error is about the missing server,
  // which is the only thing left to fix.
  t.init({ config: cfg({ enabled: true }) });
  t.send.on();
  t.expect.state((s) => s.status === "error");
  t.expect.state((s) => (s.error ?? "").includes("Settings"));
  // A dismissable error, not a dead end — and back to OFF, because off is
  // what this feature defaults to.
  t.send.dismissError();
  t.expect.state((s) => s.status === "off" && s.error === null);
});

testCell(
  speech,
  "it starts quiet, and only starts talking if asked to",
  (t) => {
    // The default: configured server, but nobody said "read to me".
    t.init({ config: setUp() });
    t.send.wake();
    t.expect.state((s) => s.status === "off");

    // Asked for, in Settings, on purpose.
    t.send.setOnAtStart(true);
    t.send.wake();
    t.expect.state((s) => s.status === "idle");
  },
);

testCell(speech, "starting on cannot outlive the server it needs", (t) => {
  // The setting says start reading; there is nothing to read with. Silence is
  // the honest answer, not an error banner on every launch.
  t.init({ config: cfg({ enabled: true, onAtStart: true }) });
  t.send.wake();
  t.expect.state((s) => s.status === "off" && s.error === null);
});

testCell(speech, "switching on is just switching on", (t) => {
  // Which messages count as already-read is the page's business now, kept per
  // conversation. One marker in here for every conversation is what made the
  // first line of every new chat go missing.
  t.init({ config: setUp() });
  t.send.on();
  t.expect.state((s) => s.status === "idle" && s.error === null);
});

testCell(
  speech,
  "two readings at once, and only the second one ends it",
  (t) => {
    // Your message and the reply to it overlap: the second is dispatched while
    // the first is still playing. With a flag instead of a count, the first to
    // finish declared silence while the speakers were still going.
    t.init({ config: setUp(), status: "idle" });
    t.send.began("what you said", 0);
    t.send.began("what came back", 0);
    t.expect.state((s) => s.busy === 2 && s.status === "speaking");
    t.send.ended("", 0, false);
    t.expect.state((s) => s.busy === 1 && s.status === "speaking");
    t.send.ended("", 0, false);
    t.expect.state((s) =>
      s.busy === 0 && s.status === "idle" && s.saying === ""
    );
  },
);

testCell(speech, "switched off, nothing can talk it back on", (t) => {
  // `began` arrives from an orchestrator that started before the switch was
  // flipped. It must not resurrect the speaker.
  t.init({ status: "off" });
  t.send.began("late arrival", 0);
  t.expect.state((s) => s.status === "off" && s.busy === 0);
  t.send.ended("", 0, false);
  t.expect.state((s) => s.status === "off");
});

testCell(speech, "a failure is reported once, at the end", (t) => {
  t.init({ config: setUp(), status: "idle" });
  t.send.began("hello", 0);
  t.send.ended("the speakers refused it", 0, false);
  t.expect.state((s) => s.status === "error");
  t.expect.state((s) => s.error === "the speakers refused it");
});

testCell(speech, "the pace cannot leave the range a voice can do", (t) => {
  t.init();
  t.send.setSpeed(1.25);
  t.expect.state((s) => s.config.speed === 1.25);
  // A config from a future version, or a slider that got away.
  t.send.setSpeed(40);
  t.expect.state((s) => s.config.speed === 2);
  t.send.setSpeed(0);
  t.expect.state((s) => s.config.speed === 0.5);
  t.send.setSpeed(NaN);
  t.expect.state((s) => s.config.speed === 1);
});

testCell(speech, "the two voices stay two, and cannot be blanked", (t) => {
  t.init();
  t.expect.state((s) => s.config.voiceOut !== s.config.voiceIn);
  t.send.setVoiceOut("bf_emma");
  t.expect.state((s) => s.config.voiceOut === "bf_emma");
  // An empty select value is not a voice. Keeping the old one is the only
  // behaviour that leaves the feature working.
  t.send.setVoiceIn("");
  t.expect.state((s) => s.config.voiceIn === "am_michael");
});

testCell(speech, "switches are switches, whatever the page sends", (t) => {
  t.init();
  t.send.setReadMine("yes" as unknown as boolean);
  t.expect.state((s) => s.config.readMine === false);
  t.send.setReadMine(true);
  t.expect.state((s) => s.config.readMine === true);
  t.send.setOnAtStart(1 as unknown as boolean);
  t.expect.state((s) => s.config.onAtStart === false);
});

testCell(speech, "the address is adopted only when something answers", (t) => {
  t.init();
  t.send.found("http://127.0.0.1:8880", false, []);
  t.expect.state((s) => s.reachable === false && s.config.baseUrl === "");
  t.send.found("http://127.0.0.1:8880", true, [{
    id: "af_heart",
    grade: "A",
    name: "",
  }]);
  t.expect.state((s) => s.reachable === true);
  t.expect.state((s) => s.config.baseUrl === "http://127.0.0.1:8880");
  t.expect.state((s) => s.voices.length === 1);
});

testCell(
  speech,
  "a server that answers with no voices does not blank the list",
  (t) => {
    // A restart mid-probe, or a model still loading. Emptying the picker would
    // make every voice unselectable until the next successful probe.
    t.init({ voices: [{ id: "af_heart", grade: "A", name: "" }] });
    t.send.found("http://x", true, []);
    t.expect.state((s) => s.voices.length === 1);
  },
);

testCell(
  speech,
  "one message is one reading, however many windows ask",
  async (t) => {
    // Every connected client renders, and each one decided independently that
    // this reply was new. Two windows open meant everything read twice, and
    // nothing in either page could see the other.
    t.init({ config: setUp(), status: "idle" });
    await t.send.say("All green.", "claude", "msg_a");
    t.expect.state((s) => s.said.length === 1 && s.said[0] === "msg_a");
    // The second window, a moment later, asking for the same message.
    await t.send.say("All green.", "claude", "msg_a");
    t.expect.state((s) => s.said.length === 1);
    // A different message is a different reading.
    await t.send.say("And pushed.", "claude", "msg_b");
    t.expect.state((s) => s.said.length === 2);
  },
);

testCell(speech, "the list of what was read cannot grow forever", async (t) => {
  t.init({ config: setUp(), status: "idle" });
  for (let i = 0; i < 120; i++) await t.send.say("hello", "claude", `m${i}`);
  // Capped, and it is the RECENT ones that are kept — those are the only ones
  // a duplicate could ever arrive within.
  t.expect.state((s) => s.said.length === 50);
  t.expect.state((s) => s.said[s.said.length - 1] === "m119");
});

testCell(speech, "switching on again forgets what the last stint read", (t) => {
  // The backlog is skipped by the marker, not by this list — and a transcript
  // that was cleared and rebuilt can hand back an id that was used before.
  t.init({ config: setUp(), said: ["msg_a"] });
  t.send.on();
  t.expect.state((s) => s.said.length === 0);
});

testCell(
  speech,
  "pointing it at a different engine repairs the voices",
  (t) => {
    // `af_heart` means nothing to a server whose voices are called F1 and M1.
    // Left alone, every sentence came back 400 with nothing on screen to say
    // why — the feature simply stopped working and looked like it had broken.
    t.init({ config: setUp() });
    t.send.found("http://x", true, [
      { id: "F1", grade: "", name: "" },
      { id: "M1", grade: "", name: "" },
    ]);
    t.expect.state((s) => s.config.voiceOut === "F1");
    t.expect.state((s) => s.config.voiceIn === "M1");
    // Still two different voices, which is the whole point of having two.
    t.expect.state((s) => s.config.voiceOut !== s.config.voiceIn);
  },
);

testCell(speech, "a voice the server still has is left alone", (t) => {
  t.init({ config: setUp({ voiceOut: "bf_emma" }) });
  t.send.found("http://x", true, [
    { id: "bf_emma", grade: "B-", name: "" },
    { id: "am_michael", grade: "C+", name: "" },
  ]);
  t.expect.state((s) => s.config.voiceOut === "bf_emma");
  t.expect.state((s) => s.config.voiceIn === "am_michael");
});

testCell(
  speech,
  "a server with exactly one voice does not crash the pair",
  (t) => {
    t.init({ config: setUp() });
    t.send.found("http://x", true, [{ id: "only", grade: "", name: "" }]);
    t.expect.state((s) => s.config.voiceOut === "only");
    t.expect.state((s) => s.config.voiceIn === "only");
  },
);

testCell(speech, "the language is a code or it is nothing", (t) => {
  t.init();
  t.expect.state((s) => s.config.language === ""); // let the server decide
  t.send.setLanguage("  CS  ");
  t.expect.state((s) => s.config.language === "cs");
  t.send.setLanguage(7 as unknown as string);
  t.expect.state((s) => s.config.language === "cs"); // unchanged, not blanked
  t.send.setLanguage("");
  t.expect.state((s) => s.config.language === "");
});

Deno.test("sexOf — both engines say it in the name", () => {
  for (const id of ["af_heart", "bf_emma", "F1", "F5"]) {
    assertEquals(sexOf(id), "f", id);
  }
  for (const id of ["am_michael", "bm_george", "M1", "M5"]) {
    assertEquals(sexOf(id), "m", id);
  }
  // A voice from some future server, or a blend saved by hand. No guess is
  // the honest answer, and the caller falls back to "any other one".
  for (const id of ["ef_dora", "zm_yunjian", "custom", ""]) {
    assertEquals(sexOf(id), "", id);
  }
});

testCell(
  speech,
  "repair reaches for the best voice, not the first alphabetically",
  (t) => {
    // Coming back from another engine. Alphabetical order landed on `af_alloy`,
    // a C, over `af_heart` — the only A the model card gives out.
    t.init({
      config: setUp({ voiceOut: "F1", voiceIn: "M1" }),
    });
    t.send.found("http://x", true, [
      { id: "af_alloy", grade: "C", name: "" },
      { id: "af_heart", grade: "A", name: "" },
      { id: "am_michael", grade: "C+", name: "" },
    ]);
    t.expect.state((s) => s.config.voiceOut === "af_heart");
    t.expect.state((s) => s.config.voiceIn === "am_michael");
  },
);

testCell(
  speech,
  "a server of voices this app has never heard of still works",
  (t) => {
    // None of them are on the shortlist and none of the names say a sex. It has
    // to land on something usable rather than on nothing.
    t.init({
      config: setUp({ voiceOut: "gone", voiceIn: "gone" }),
    });
    t.send.found("http://x", true, [
      { id: "vox_a", grade: "", name: "" },
      { id: "vox_b", grade: "", name: "" },
    ]);
    t.expect.state((s) => s.config.voiceOut === "vox_a");
    t.expect.state((s) => s.config.voiceIn === "vox_b");
  },
);

testCell(
  speech,
  "a server that names its voices is believed over our own table",
  (t) => {
    // Piper has 136 voices across 57 languages and is the only thing that knows
    // `cs_CZ` is Czech. It sends a label; Kokoro repeats the id, which is not a
    // label and must not become one.
    t.init({ config: setUp() });
    t.send.found("http://x", true, [
      {
        id: "cs_CZ-kasandra-medium",
        grade: "",
        name: "Kasandra — Czech · medium",
      },
      { id: "af_heart", grade: "A", name: "" },
    ]);
    t.expect.state((s) => s.voices[0].name === "Kasandra — Czech · medium");
    t.expect.state((s) => s.voices[1].name === "");
  },
);

testCell(
  speech,
  "an engine sorted by language does not land on Arabic",
  (t) => {
    // Piper's ids sort by language code, so the first one alphabetically is
    // `ar_JO-kareem-medium`. Landing there because it sorted first is not a
    // default, it is an accident.
    t.init({
      config: setUp({ voiceOut: "F1", voiceIn: "M1" }),
    });
    t.send.found("http://x", true, [
      { id: "ar_JO-kareem-medium", grade: "", name: "Kareem — Arabic" },
      { id: "en_US-lessac-high", grade: "", name: "Lessac — English" },
      { id: "en_US-ryan-high", grade: "", name: "Ryan — English" },
      { id: "ne_NP-chitwan-medium", grade: "", name: "Chitwan — Nepali" },
    ]);
    t.expect.state((s) => s.config.voiceOut === "en_US-lessac-high");
    t.expect.state((s) => s.config.voiceIn === "en_US-ryan-high");
  },
);

/**
 * The master switch.
 *
 * Reading aloud needs a speech server, and a speech server holds a voice model
 * in memory — on this machine, in the same graphics memory the language models
 * want. So "off" here has to mean nothing is contacted at all, not merely that
 * nothing is played: a probe is enough to make a server that loads on demand
 * load, and a feature nobody switched on must not cost anybody a gigabyte.
 */
testCell(speech, "voice output is off until somebody asks for it", (t) => {
  // The shipped default, spelled out: even with a server saved and "start
  // reading" set, the switch is what decides.
  t.init({ config: cfg({ baseUrl: "http://x", onAtStart: true }) });
  t.send.wake();
  t.expect.state((s) => s.status === "off" && s.error === null);
  // And it cannot be talked on from anywhere else either.
  t.send.on();
  t.expect.state((s) => s.status === "off");
});

testCell(speech, "while it is off, nothing is contacted", async (t) => {
  const real = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = ((...args: Parameters<typeof fetch>) => {
    calls++;
    return real(...args);
  }) as typeof fetch;
  try {
    t.init({ config: cfg({ baseUrl: "http://x" }) });
    // The three things that reach for a server, in the three places a page can
    // ask for them: looking for one, previewing a voice, reading a message.
    await t.send.find();
    await t.send.preview("af_heart");
    await t.send.say("All green.", "claude", "msg_a");
    assertEquals(calls, 0);
    t.expect.state((s) => s.reachable === false && s.voices.length === 0);
  } finally {
    globalThis.fetch = real;
  }
});

testCell(
  speech,
  "switching it off stops the speakers and forgets the server's list",
  async (t) => {
    t.init({
      config: setUp(),
      status: "speaking",
      busy: 2,
      saying: "half a sentence",
      voices: [{ id: "af_heart", grade: "A", name: "" }],
      reachable: true,
      said: ["msg_a"],
    });
    await t.send.setEnabled(false);
    t.expect.state((s) => s.status === "off" && s.busy === 0);
    t.expect.state((s) => s.saying === "");
    // The list belonged to a server this app is no longer talking to. Showing
    // it beside a switch that is off is a claim about a machine nobody asked.
    t.expect.state((s) => s.voices.length === 0 && s.reachable === false);
  },
);

testCell(speech, "being switched off does not lose the setup", async (t) => {
  t.init({ config: setUp({ voiceOut: "bf_emma", speed: 1.25 }) });
  await t.send.setEnabled(false);
  await t.send.setEnabled(true);
  // Which server and which voice are a different question from whether the
  // feature is wanted — answering the second must not erase the first.
  t.expect.state((s) => s.config.baseUrl === "http://x");
  t.expect.state((s) => s.config.voiceOut === "bf_emma");
  t.expect.state((s) => s.config.speed === 1.25);
  t.expect.state((s) => s.config.enabled === true);
});

testCell(
  speech,
  "a reading from before Stop cannot end the one after it",
  async (t) => {
    // Stop zeroes the count, but the reading it stopped still ends a moment
    // later. Its `ended` used to take the NEXT reading's count to zero and
    // call the speaker idle while it was talking.
    t.init({ config: setUp(), status: "idle" });
    t.send.began("stopped halfway", 0);
    await t.send.hush();
    t.expect.state((s) => s.busy === 0 && s.gen === 1);
    t.send.began("the next reply", 1);
    t.send.ended("", 0, false); // the stopped one, late
    t.expect.state((s) => s.busy === 1 && s.status === "speaking");
    // A late `began` from the old stint cannot count itself in either.
    t.send.began("queued before Stop", 0);
    t.expect.state((s) => s.busy === 1);
    t.send.ended("", 1, false);
    t.expect.state((s) => s.busy === 0 && s.status === "idle");
  },
);

testCell(
  speech,
  "switching off makes every reading in flight stale",
  async (t) => {
    t.init({ config: setUp(), status: "speaking", busy: 1 });
    await t.send.off();
    t.send.ended("the speakers refused it", 0, false);
    t.expect.state((s) => s.status === "off" && s.error === null);
  },
);

testCell(
  speech,
  "a server that is not there pauses reading until it is looked for",
  async (t) => {
    // Every line of every reply used to knock on the closed port and log its
    // own copy of the refusal.
    t.init({ config: setUp(), status: "idle" });
    t.send.began("hello", 0);
    t.send.ended("No voice server is answering", 0, true);
    t.expect.state((s) => s.down === true && s.status === "error");
    // Paused: handed over (so it is not read later) but never sent.
    await t.send.say("And another.", "claude", "msg_b");
    t.expect.state((s) => s.said.includes("msg_b") && s.busy === 0);
    // A Find that gets an answer resumes it…
    t.send.found("http://x", true, []);
    t.expect.state((s) => s.down === false);
    // …and so does switching the speaker on again.
    t.init({ config: setUp(), down: true });
    t.send.on();
    t.expect.state((s) => s.down === false && s.status === "idle");
  },
);

testCell(speech, "dismissing an error puts the speaker back on", (t) => {
  // It was on — only a speaker that is on can fail to read. Dismissing used
  // to decide on/off from the "at start" setting, which switched it off.
  t.init({
    config: setUp(),
    status: "error",
    error: "the speakers refused it",
  });
  t.send.dismissError();
  t.expect.state((s) => s.status === "idle" && s.error === null);
});
