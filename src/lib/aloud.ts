/**
 * @module
 * Turning a transcript into something worth listening to.
 *
 * Everything here is a pure function of text, because the hard part of reading
 * a chat aloud is not the audio — it is deciding what is *prose*. A reply is
 * Markdown written to be looked at: fences, tables, paths, URLs, bullet
 * glyphs. Read literally it becomes "backtick src slash cell slash speech dot
 * t s backtick", which is not a sentence anybody wants in their ears.
 */

/** One line of a conversation, in the only shape this module needs. Both
 *  engines' messages flatten to it. */
export type Said = {
  id: string;
  role: "user" | "assistant";
  text: string;
};

/**
 * The longest single reading, in characters.
 *
 * Roughly two and a half minutes of speech. A cap has to exist — an agent's
 * answer can run to thousands of words, and a speaker you cannot get a word in
 * past is worse than one that stops early. Cut at a sentence, never mid-word.
 */
export const MAX_CHARS = 2000;

/**
 * Markdown in, prose out.
 *
 * Order matters and is the whole design: blocks are removed before spans, so a
 * fence full of asterisks never reaches the emphasis rule, and links lose
 * their target before bare URLs are hunted.
 *
 * Every pattern here is linear — no nested quantifier, nothing that can back
 * off exponentially. The input is a model's reply, which is to say text this
 * app did not write and cannot bound.
 */
export function speakable(md: string): string {
  if (typeof md !== "string" || md === "") return "";
  let s = md;

  // ── blocks, removed whole ────────────────────────────────────────────────
  // Fenced code. Read aloud it is punctuation; skipped, the sentence either
  // side still makes sense — which is exactly how a person reads it.
  s = s.replace(/```[\s\S]*?```/g, " ");
  s = s.replace(/~~~[\s\S]*?~~~/g, " ");
  // An unterminated fence: the reply is still streaming, or the model forgot.
  // Everything after it is code until proven otherwise.
  s = s.replace(/```[\s\S]*$/, " ");
  // Tables. Column by column they are a list of pipes.
  s = s.replace(/^[ \t]*\|.*$/gm, "");
  // Rules, and the underline style of heading.
  s = s.replace(/^[ \t]*([-*_=])\1{2,}[ \t]*$/gm, "");
  // Raw HTML tags, which Markdown allows and nobody wants pronounced.
  s = s.replace(/<[^<>]{0,400}>/g, " ");

  // ── line starts ──────────────────────────────────────────────────────────
  s = s.replace(/^[ \t]*#{1,6}[ \t]+/gm, ""); // headings
  s = s.replace(/^[ \t]*>[ \t]?/gm, ""); // quotes
  s = s.replace(/^[ \t]*[-*+][ \t]+/gm, ""); // bullets
  s = s.replace(/^[ \t]*\d{1,3}[.)][ \t]+/gm, ""); // numbered
  s = s.replace(/^[ \t]*\[[ xX]\][ \t]+/gm, ""); // task boxes

  // ── spans ────────────────────────────────────────────────────────────────
  s = s.replace(/!\[[^\]]{0,300}\]\([^)]{0,2000}\)/g, " "); // images: gone
  s = s.replace(/\[([^\]]{0,300})\]\([^)]{0,2000}\)/g, "$1"); // links: the words
  // Bare addresses. "h t t p s colon slash slash" is never the useful part.
  s = s.replace(/\bhttps?:\/\/\S+/gi, " ");
  s = s.replace(/`([^`]{0,400})`/g, "$1"); // inline code: keep the word
  s = s.replace(/[*_]{1,3}([^*_\n]{1,400})[*_]{1,3}/g, "$1"); // emphasis
  s = s.replace(/~~([^~\n]{1,400})~~/g, "$1"); // strikethrough

  // Pictographs. Kokoro pronounces some of them, in a voice that is trying its
  // best, and the result is never what the emoji meant.
  s = s.replace(/\p{Extended_Pictographic}/gu, " ");
  s = s.replace(/[\u{1F3FB}-\u{1F3FF}\u{FE0F}\u{200D}]/gu, "");

  // ── whitespace ───────────────────────────────────────────────────────────
  // A blank line is a pause worth keeping; three are not.
  s = s.replace(/[ \t]+/g, " ");
  s = s.replace(/ ?\n ?/g, "\n");
  s = s.replace(/\n{3,}/g, "\n\n");
  return s.trim();
}

/**
 * Cut to length at a sentence boundary.
 *
 * Mid-word is the one place it must never stop: a voice that trails off in the
 * middle of "configur—" sounds like the app crashed, which is a worse thing to
 * believe than "that answer was long".
 */
export function clip(text: string, max = MAX_CHARS): string {
  if (text.length <= max) return text;
  const head = text.slice(0, max);
  // The last sentence that finished inside the budget. Searched from the end
  // of a fixed-length string, so the cost is bounded by `max`, not by input.
  const end = Math.max(
    head.lastIndexOf(". "),
    head.lastIndexOf("! "),
    head.lastIndexOf("? "),
    head.lastIndexOf(".\n"),
    head.lastIndexOf("\n\n"),
  );
  // No sentence ended in two thousand characters — one enormous run-on. Fall
  // back to the last space, which at least keeps the word whole.
  const at = end > max / 4 ? end + 1 : head.lastIndexOf(" ");
  return (at > 0 ? head.slice(0, at) : head).trim();
}

/**
 * What is finished and has not been read out yet.
 *
 * Two rules, and both exist because of what the alternatives do:
 *
 *  - Claude's last message is only *settled* once the turn is over or another
 *    follows it. Speaking the one still being written means reading half a
 *    sentence and then reading it again with its other half. Yours is settled
 *    the instant it appears — you finished it, and waiting for the reply to
 *    start before reading your own words back defeats the point of reading
 *    them back at all.
 *
 *  - When the marker is not in the transcript at all — you switched project,
 *    or history was replaced — nothing is spoken and the marker moves to the
 *    end. The alternative is an app that reads a whole conversation aloud
 *    from the top because you clicked a different tab.
 */
export function nextToSpeak(
  msgs: Said[],
  spokenId: string,
  working: boolean,
): { speak: Said[]; mark: string } {
  const none = { speak: [] as Said[], mark: spokenId };
  if (!Array.isArray(msgs) || msgs.length === 0) return none;

  const last = msgs[msgs.length - 1].id;
  const at = msgs.findIndex((m) => m.id === spokenId);
  if (spokenId !== "" && at === -1) return { speak: [], mark: last };

  const rest = msgs.slice(at + 1);
  // Only the LAST message can still be being written, and only if it is
  // Claude's. Yours was finished the moment you pressed send, so it is read
  // straight away rather than waiting for a reply to appear behind it — which
  // is what "read it back as I send it" has to mean.
  const tail = rest[rest.length - 1];
  const unsettled = working && tail !== undefined && tail.role === "assistant";
  const settled = unsettled ? rest.slice(0, -1) : rest;
  if (settled.length === 0) return none;

  // The marker advances over everything settled, including the messages that
  // turned out to have nothing sayable in them. They are finished too, and a
  // marker that stuck on a tool-only message would re-examine it forever.
  const mark = settled[settled.length - 1].id;
  const speak = settled
    .map((m) => ({ ...m, text: clip(speakable(m.text)) }))
    .filter((m) => m.text !== "");
  return { speak, mark };
}

/** How far one conversation has been read, and how long it was at the time. */
export type Watched = { mark: string; count: number };

/**
 * Where to start reading a conversation, given how far it has been read.
 *
 * Three cases, and the middle one is a real bug this ends.
 *
 *  - **Never watched** (`seen` is undefined): everything in it is history, so
 *    start at the END. Opening a conversation from this morning must not
 *    recite this morning.
 *
 *  - **Watched, and the marker is gone from a transcript that got SHORTER**:
 *    it was cleared and is being rebuilt, so start at the BEGINNING —
 *    what is there now arrived after we started listening. There used to be
 *    one marker for all conversations, so this case also covered "you opened a
 *    new chat", and it did the opposite: the marker from the chat you left was
 *    not in the new one, the whole thing counted as history, and the first
 *    line you typed went silently missing. Conversations are keyed separately
 *    now, so a new chat is simply one nobody has watched — and an empty one
 *    has no history for its first message to hide behind.
 *
 *  - **Watched, and the marker is gone from a transcript that did NOT get
 *    shorter**: it ran off the front of a capped list. Start at the END; the
 *    alternative is re-reading everything still on screen.
 */
export function startAt(seen: Watched | undefined, msgs: Said[]): string {
  const last = msgs.length === 0 ? "" : msgs[msgs.length - 1].id;
  if (seen === undefined) return last;
  if (seen.mark === "" || msgs.some((m) => m.id === seen.mark)) {
    return seen.mark;
  }
  return msgs.length < seen.count ? "" : last;
}

/**
 * A Claude Code transcript, flattened to the lines worth hearing.
 *
 * Text blocks only. Thinking is not addressed to you, a tool call is a chip
 * you click, and a tool *result* is a wall of file contents — reading any of
 * the three aloud turns a two-sentence answer into four minutes of machinery.
 *
 * Sub-agent messages are dropped for the same reason: they are a conversation
 * between two programs that happens to be visible, and they arrive interleaved
 * with the one you are actually in.
 */
export function fromClaude(
  msgs: {
    id: string;
    role: "user" | "assistant";
    blocks: { kind: string; text?: string }[];
    parentToolUseId: string | null;
  }[],
): Said[] {
  return msgs
    .filter((m) => m.parentToolUseId === null)
    .map((m) => ({
      id: m.id,
      role: m.role,
      text: m.blocks
        .filter((b) => b.kind === "text")
        .map((b) => b.text ?? "")
        .join("\n\n"),
    }));
}

/** A local-engine transcript, flattened the same way. `tool` rows are its
 *  spelling of a tool result, and are dropped for the same reason. */
export function fromLocal(
  msgs: { id: string; role: "user" | "assistant" | "tool"; text: string }[],
): Said[] {
  return msgs
    .filter((m) => m.role !== "tool")
    .map((m) => ({
      id: m.id,
      role: m.role as "user" | "assistant",
      text: m.text,
    }));
}

/**
 * How much text to ask for at once, in characters.
 *
 * Small enough that the first words start almost immediately, big enough that
 * the model still sees whole sentences and gets the intonation right. A voice
 * given one clause at a time reads like a list.
 */
export const CHUNK_CHARS = 320;

/**
 * How much to ask for in the FIRST piece.
 *
 * Smaller, because the first piece is the only one anybody waits for. Measured
 * on Supertonic, which makes whole files at about three times real time: 320
 * characters is six seconds of silence to start with, 110 is two. Every piece
 * after it is made while the one before is still playing, so their size costs
 * nothing and the bigger budget buys better intonation.
 */
export const FIRST_CHARS = 110;

/**
 * Break a reading into pieces that can be spoken one after another.
 *
 * The reason is latency, and on some engines it is the difference between a
 * feature and a broken one. Kokoro streams samples as it makes them, so a long
 * reply starts in 65 ms either way. Supertonic and Piper hand back a whole
 * file: measured here, 775 characters was fifteen seconds of silence before a
 * single word — which is not "slow", it is indistinguishable from "it did not
 * read it", which is exactly how it was reported.
 *
 * Split on sentence ends, never mid-word, and only break a sentence that is
 * longer than the budget all by itself. Blank lines are kept as breaks because
 * a paragraph boundary is a real pause.
 */
export function intoChunks(
  text: string,
  max = CHUNK_CHARS,
  first = FIRST_CHARS,
): string[] {
  const clean = text.trim();
  if (clean === "") return [];
  if (clean.length <= first) return [clean];

  // Sentence ends, plus paragraph breaks. Linear, and deliberately simple: a
  // decimal point or an abbreviation splitting early costs a small pause, and
  // nothing else.
  const parts = clean
    .split(/(?<=[.!?…])\s+|\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p !== "");

  const out: string[] = [];
  let held = "";
  // The budget opens small and widens once the first piece is out of the door.
  const budget = () => (out.length === 0 ? first : max);
  const push = () => {
    if (held !== "") out.push(held);
    held = "";
  };

  for (const part of parts) {
    if (held !== "" && held.length + 1 + part.length > budget()) push();
    if (part.length > budget()) {
      // One sentence longer than the whole budget. Break it at spaces rather
      // than mid-word; a voice cut inside "configur—" sounds like a crash.
      push();
      let rest = part;
      while (rest.length > budget()) {
        const room = budget();
        const at = rest.lastIndexOf(" ", room);
        const cut = at > room / 2 ? at : room;
        out.push(rest.slice(0, cut).trim());
        rest = rest.slice(cut).trim();
      }
      held = rest;
      continue;
    }
    held = held === "" ? part : `${held} ${part}`;
  }
  push();
  return out.filter((p) => p !== "");
}

/** The samples inside a WAV, and the rate they were made at — `null` when
 *  the file does not say. */
export type Pcm = { pcm: Uint8Array; rate: number | null };

/**
 * The samples inside a WAV, without its header.
 *
 * Needed because several of these readings are played through ONE player, and
 * a server that only hands back whole files would otherwise put a 44-byte
 * header in the middle of the audio — which is a click, and then whatever the
 * header's bytes sound like.
 *
 * The `data` chunk is searched for rather than assumed to be at offset 44: it
 * usually is, and a file carrying a `LIST` or `fact` chunk first is still a
 * valid WAV that nothing else would play wrong.
 *
 * The rate comes back with it, read from `fmt `. Stripping the header throws
 * away the one field that says how fast to play what is left, and a player
 * told the wrong rate plays a voice at the wrong pitch — which sounds like a
 * bad model rather than a bad number.
 */
export function pcmFromWav(bytes: Uint8Array): Pcm {
  const ascii = (at: number) =>
    String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]);
  if (bytes.length < 12 || ascii(0) !== "RIFF" || ascii(8) !== "WAVE") {
    // Not a WAV at all. Raw samples are what the caller wanted anyway, so
    // handing them straight back is the useful answer rather than an error.
    return { pcm: bytes, rate: null };
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let rate: number | null = null;
  let at = 12;
  while (at + 8 <= bytes.length) {
    const id = ascii(at);
    const size = view.getUint32(at + 4, true);
    const body = at + 8;
    if (id === "fmt " && body + 8 <= bytes.length) {
      const hz = view.getUint32(body + 4, true);
      rate = hz > 0 ? hz : null;
    }
    if (id === "data") {
      return {
        pcm: bytes.subarray(body, Math.min(bytes.length, body + size)),
        rate,
      };
    }
    // Chunks are word-aligned; an odd length carries a pad byte.
    at = body + size + (size % 2);
  }
  return { pcm: bytes.subarray(Math.min(44, bytes.length)), rate };
}
