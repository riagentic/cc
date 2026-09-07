/**
 * Turning a transcript into something worth listening to.
 *
 * These are the tests that decide whether the feature is pleasant or
 * unbearable. A speaker that reads Markdown literally — fences, pipes, URLs —
 * is not a worse version of this feature, it is one nobody switches on twice.
 */
import { assertEquals } from "@std/assert";
import {
  CHUNK_CHARS,
  clip,
  FIRST_CHARS,
  fromClaude,
  fromLocal,
  furtherOn,
  intoChunks,
  MAX_CHARS,
  nextToSpeak,
  pcmFromWav,
  type Said,
  startAt,
  toHandOver,
  type Watched,
} from "../../lib/aloud.ts";
import { speakable } from "../../lib/aloud.ts";

Deno.test("speakable — code is skipped, not pronounced", () => {
  assertEquals(
    speakable("Here you go:\n\n```ts\nconst a = `x`;\n```\n\nThat is all."),
    "Here you go:\n\nThat is all.",
  );
  // Tildes are a fence too.
  assertEquals(speakable("a\n~~~\nnoise\n~~~\nb"), "a\n\nb");
  // Still streaming: the fence never closed, and everything after it is code
  // until proven otherwise. Reading it out is the failure mode this prevents.
  assertEquals(speakable("Done.\n```sh\nrm -rf /"), "Done.");
});

Deno.test("speakable — inline code keeps its word, tables lose theirs", () => {
  // A path or a flag inside backticks is usually the point of the sentence.
  assertEquals(speakable("Open `voice.ts` next."), "Open voice.ts next.");
  // A table read column by column is a list of pipes.
  assertEquals(
    speakable("Results:\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\nDone."),
    "Results:\n\nDone.",
  );
});

Deno.test("speakable — links keep the words and drop the address", () => {
  assertEquals(
    speakable("See [the docs](https://x.dev/a?b=1)."),
    "See the docs.",
  );
  assertEquals(speakable("Grab it at https://x.dev/a now."), "Grab it at now.");
  // An image has nothing to say at all.
  assertEquals(speakable("![a chart](x.png) Done."), "Done.");
});

Deno.test("speakable — the marks around prose go, the prose stays", () => {
  assertEquals(
    speakable("## Heading\n\n**bold** and *thin*"),
    "Heading\n\nbold and thin",
  );
  assertEquals(speakable("- one\n- two\n\n1. three"), "one\ntwo\n\nthree");
  assertEquals(speakable("- [x] done\n- [ ] not"), "done\nnot");
  assertEquals(speakable("> quoted\n\n---\n\nafter"), "quoted\n\nafter");
  assertEquals(speakable("~~gone~~ here"), "gone here");
});

Deno.test("speakable — emoji are not read out", () => {
  // The model writes them constantly and the voice makes a real attempt at
  // some of them, which is never what the emoji meant.
  assertEquals(speakable("Done ✅ shipped 🚀"), "Done shipped");
  assertEquals(speakable("👍🏽 ok"), "ok");
});

Deno.test("speakable — degenerate input is still linear and still safe", () => {
  assertEquals(speakable(""), "");
  assertEquals(speakable(null as unknown as string), "");
  // A thousand unmatched asterisks: the patterns here have no nested
  // quantifier, so this returns rather than hanging. The point is that it
  // finishes at all.
  const nasty = "*".repeat(5000) + "\n" + "[".repeat(5000);
  assertEquals(typeof speakable(nasty), "string");
});

Deno.test("clip — long answers stop at a sentence, never mid-word", () => {
  const short = "One sentence.";
  assertEquals(clip(short), short);

  const long = "This is a sentence. ".repeat(300); // well past the cap
  const cut = clip(long);
  assertEquals(cut.length <= MAX_CHARS, true);
  // It ends where a sentence ended.
  assertEquals(cut.endsWith("."), true);

  // One enormous run-on with no sentence in it: fall back to a word boundary
  // rather than slicing through the middle of "configur—".
  const runOn = "word ".repeat(1000);
  const cut2 = clip(runOn);
  assertEquals(cut2.endsWith("word"), true);
});

const msg = (id: string, role: "user" | "assistant", text: string): Said => ({
  id,
  role,
  text,
});

Deno.test("nextToSpeak — the message still being written is left alone", () => {
  const msgs = [msg("a", "user", "hello"), msg("b", "assistant", "hi the")];
  // The turn is running, so `b` is half a sentence. Reading it now would read
  // it again, in full, a second later.
  const mid = nextToSpeak(msgs, "", true);
  assertEquals(mid.speak.map((m) => m.id), ["a"]);
  assertEquals(mid.mark, "a");

  // Turn over: the rest is settled.
  const done = nextToSpeak(msgs, "a", false);
  assertEquals(done.speak.map((m) => m.id), ["b"]);
  assertEquals(done.mark, "b");
});

Deno.test("nextToSpeak — nothing is said twice", () => {
  const msgs = [msg("a", "user", "hello"), msg("b", "assistant", "hi")];
  assertEquals(nextToSpeak(msgs, "b", false).speak, []);
  assertEquals(nextToSpeak(msgs, "b", false).mark, "b");
});

Deno.test("nextToSpeak — a transcript it does not recognise is not recited", () => {
  // Switched project, or history was replaced. The marker is nowhere in this
  // list, and the wrong answer here is to start at the top and read an
  // afternoon of conversation aloud.
  const msgs = [msg("x", "user", "one"), msg("y", "assistant", "two")];
  const out = nextToSpeak(msgs, "gone", false);
  assertEquals(out.speak, []);
  assertEquals(out.mark, "y");
});

Deno.test("nextToSpeak — a message with nothing sayable still moves the marker", () => {
  // `b` is a tool call and a fence: settled, finished, and silent. If the
  // marker stuck on it, every later render would examine it again forever.
  const msgs = [
    msg("a", "user", "go"),
    msg("b", "assistant", "```sh\nls\n```"),
    msg("c", "assistant", "Done."),
  ];
  const out = nextToSpeak(msgs, "a", false);
  assertEquals(out.speak.map((m) => m.id), ["c"]);
  assertEquals(out.mark, "c");
});

Deno.test("nextToSpeak — an empty transcript says nothing and moves nothing", () => {
  assertEquals(nextToSpeak([], "", false), { speak: [], mark: "" });
});

Deno.test("fromClaude — prose only, and none of the sub-agents'", () => {
  const out = fromClaude([
    {
      id: "1",
      role: "assistant",
      parentToolUseId: null,
      blocks: [
        { kind: "thinking", text: "hmm" },
        { kind: "text", text: "Here." },
        { kind: "tool" },
        { kind: "result", text: "1000 lines of file" },
      ],
    },
    // A conversation between two programs that happens to be visible.
    {
      id: "2",
      role: "assistant",
      parentToolUseId: "tool_1",
      blocks: [{ kind: "text", text: "sub-agent chatter" }],
    },
  ]);
  assertEquals(out, [{ id: "1", role: "assistant", text: "Here." }]);
});

Deno.test("fromLocal — tool rows are results, not speech", () => {
  const out = fromLocal([
    { id: "1", role: "user", text: "go" },
    { id: "2", role: "tool", text: "1000 lines of file" },
    { id: "3", role: "assistant", text: "Done." },
  ]);
  assertEquals(out.map((m) => m.id), ["1", "3"]);
});

Deno.test("nextToSpeak — your own message is read the moment you send it", () => {
  // Sent, and the reply has not started. Yours is finished — you wrote it —
  // so it goes to the speaker now rather than waiting for Claude to say
  // something behind it. Waiting was the old rule and it made reading your own
  // words back useless: you heard them after the answer had already begun.
  const justSent = [msg("u1", "user", "run the tests")];
  const out = nextToSpeak(justSent, "", true);
  assertEquals(out.speak.map((m) => m.id), ["u1"]);
  assertEquals(out.mark, "u1");

  // Claude's, mid-turn, is the one that has to wait.
  const answering = [...justSent, msg("a1", "assistant", "Running th")];
  assertEquals(nextToSpeak(answering, "u1", true).speak, []);
  // ...until the turn ends.
  assertEquals(
    nextToSpeak(answering, "u1", false).speak.map((m) => m.id),
    ["a1"],
  );
});

Deno.test("toHandOver — a marker that has not committed yet is not a second reading", () => {
  // THE bug. `speech.mark()` is a dispatch: it lands a render or more later,
  // and a streaming reply causes dozens of renders in that window. Each one
  // used to read the un-moved cell marker, decide nothing had been said yet,
  // and say it again — twice for your sentence, three times for the reply,
  // the count depending on how fast the tokens arrived.
  const msgs = [
    msg("u1", "user", "run the tests"),
    msg("a1", "assistant", "All green."),
  ];

  // First render: both are settled, both go out, the local marker moves.
  const first = toHandOver(msgs, "", "", false);
  assertEquals(first.speak.map((m) => m.id), ["u1", "a1"]);
  assertEquals(first.mark, "a1");

  // Every render until the dispatch commits: the CELL marker is still "".
  for (let i = 0; i < 30; i++) {
    const again = toHandOver(msgs, "", first.mark, false);
    assertEquals(again.speak, [], `render ${i} said it again`);
  }

  // And once it commits, still nothing new.
  assertEquals(toHandOver(msgs, "a1", "a1", false).speak, []);
});

Deno.test("furtherOn — the marker that is actually ahead wins", () => {
  const msgs = [
    msg("a", "user", "one"),
    msg("b", "assistant", "two"),
    msg("c", "user", "three"),
  ];
  assertEquals(furtherOn(msgs, "a", "c"), "c");
  assertEquals(furtherOn(msgs, "c", "a"), "c");
  // A marker from another conversation is behind any real one, so switching
  // project cannot make a stale local marker suppress the recovery.
  assertEquals(furtherOn(msgs, "gone", "b"), "b");
  assertEquals(furtherOn(msgs, "b", "gone"), "b");
  // Neither is here: the cell's is returned, and `nextToSpeak` recovers.
  assertEquals(furtherOn(msgs, "x", "y"), "y");
});

Deno.test("startAt — a new chat reads its first line", () => {
  // THE bug, reported as "new chat, first input line is not read". A chat
  // nobody has watched, with nothing in it yet: its first message is news, not
  // backlog. There is no end to start at, so it starts at the beginning.
  assertEquals(startAt(undefined, []), "");

  // And once that message is there, it is what gets spoken.
  const fresh = [msg("u1", "user", "run the tests")];
  const out = nextToSpeak(fresh, startAt(undefined, []), true);
  assertEquals(out.speak.map((m) => m.id), ["u1"]);
});

Deno.test("startAt — an old chat you open is not recited", () => {
  // The other half, and the reason the rule above cannot simply be "read
  // everything you have not read". Opening this morning's conversation must
  // not read this morning out.
  const old = [
    msg("a", "user", "one"),
    msg("b", "assistant", "two"),
    msg("c", "user", "three"),
  ];
  assertEquals(startAt(undefined, old), "c");
  assertEquals(nextToSpeak(old, startAt(undefined, old), false).speak, []);
});

Deno.test("startAt — a cleared transcript is read again, a trimmed one is not", () => {
  const before: Watched = { mark: "m20", count: 20 };

  // Cleared: the marker is gone AND the list got shorter. What is there now
  // arrived after we started listening, so it is news.
  const afterClear = [msg("m21", "user", "starting over")];
  assertEquals(startAt(before, afterClear), "");

  // Trimmed: the marker ran off the front of a capped list, which did not get
  // shorter. Starting over would re-read everything still on screen.
  const trimmed = Array.from(
    { length: 20 },
    (_, i) => msg(`m${i + 30}`, "assistant", "x"),
  );
  assertEquals(startAt(before, trimmed), "m49");

  // Still there: nothing clever happens.
  const same = [msg("m19", "user", "a"), msg("m20", "assistant", "b")];
  assertEquals(startAt(before, same), "m20");
});

Deno.test("intoChunks — the first piece is the only one anybody waits for", () => {
  const long = "This is a sentence. ".repeat(40);
  const out = intoChunks(long);
  // Small first, wider after: measured on an engine that makes whole files at
  // about three times real time, 320 characters is six seconds of silence to
  // begin with and 110 is two.
  assertEquals(out[0].length <= FIRST_CHARS, true);
  assertEquals(out.slice(1).every((c) => c.length <= CHUNK_CHARS), true);
  // Nothing lost and nothing invented.
  assertEquals(out.join(" ").replace(/\s+/g, " "), long.trim());
});

Deno.test("intoChunks — short text is one piece, and empty is none", () => {
  assertEquals(intoChunks("Shall I push it?"), ["Shall I push it?"]);
  assertEquals(intoChunks("   "), []);
  assertEquals(intoChunks(""), []);
});

Deno.test("intoChunks — a sentence longer than the budget breaks at a space", () => {
  // No sentence end anywhere in it: the fallback has to keep words whole,
  // because a voice cut inside "configur—" sounds like the app crashed.
  const runOn = "word ".repeat(200).trim();
  const out = intoChunks(runOn);
  assertEquals(out.length > 1, true);
  assertEquals(out.every((c) => !c.startsWith(" ") && !c.endsWith(" ")), true);
  assertEquals(out.every((c) => c.split(" ").every((w) => w === "word")), true);
});

Deno.test("intoChunks — paragraph breaks are real pauses", () => {
  const out = intoChunks("First thought.\n\nSecond thought.", 200, 20);
  assertEquals(out, ["First thought.", "Second thought."]);
});

Deno.test("pcmFromWav — the header never reaches the speakers", () => {
  // Several pieces go into ONE player, so a header arriving mid-audio is a
  // click followed by whatever its bytes sound like.
  const samples = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
  const wav = new Uint8Array(44 + samples.length);
  const view = new DataView(wav.buffer);
  const put = (at: number, s: string) => {
    for (let i = 0; i < s.length; i++) wav[at + i] = s.charCodeAt(i);
  };
  put(0, "RIFF");
  view.setUint32(4, 36 + samples.length, true);
  put(8, "WAVE");
  put(12, "fmt ");
  view.setUint32(16, 16, true);
  put(36, "data");
  view.setUint32(40, samples.length, true);
  wav.set(samples, 44);
  assertEquals([...pcmFromWav(wav)], [...samples]);

  // Raw samples that were never a WAV come back untouched — which is what the
  // caller wanted anyway, so it is the useful answer rather than an error.
  assertEquals([...pcmFromWav(samples)], [...samples]);
  assertEquals([...pcmFromWav(new Uint8Array(0))], []);
});

Deno.test("pcmFromWav — a chunk before the data one does not shift the audio", () => {
  // `data` is searched for, not assumed to sit at offset 44. A file carrying
  // a LIST or fact chunk first is still a valid WAV.
  const samples = new Uint8Array([9, 8, 7, 6]);
  const wav = new Uint8Array(12 + 8 + 4 + 8 + samples.length);
  const view = new DataView(wav.buffer);
  const put = (at: number, s: string) => {
    for (let i = 0; i < s.length; i++) wav[at + i] = s.charCodeAt(i);
  };
  put(0, "RIFF");
  put(8, "WAVE");
  put(12, "LIST");
  view.setUint32(16, 4, true); // a four-byte chunk in the way
  put(24, "data");
  view.setUint32(28, samples.length, true);
  wav.set(samples, 32);
  assertEquals([...pcmFromWav(wav)], [...samples]);
});
