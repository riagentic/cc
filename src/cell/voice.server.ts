/**
 * @module
 * The microphone, and the model that turns it into words. Server-only.
 *
 * Audio is captured HERE rather than in the page, and that is the main design
 * decision in this file. The browser could do it — `getUserMedia` exists — but
 * it costs an Electron permission handler, a codec (WebM/Opus) and a resample
 * before anything can be sent anywhere. `parecord` hands over exactly what
 * whisper wants, 16 kHz mono signed 16-bit, with none of those steps and none
 * of their failure modes. The level meter falls out of the same bytes.
 */
import { log } from "aio";
import { isLanguage } from "../lib/languages.ts";
import { complaint, lastLine, serial } from "../lib/sound.ts";

/** What whisper is trained on. Anything else has to be resampled, and this is
 *  free to ask for at the source. */
const RATE = 16_000;
const CHANNELS = 1;
const BYTES_PER_SAMPLE = 2;

/**
 * The longest single utterance, in seconds.
 *
 * A held key that is never released — the window lost focus at the wrong
 * moment, a keyup went missing — must not record until the disk fills. Two
 * minutes is far longer than anything anyone dictates in one breath, and the
 * cap is a backstop rather than a limit anyone should meet.
 */
const MAX_SECONDS = 120;
const MAX_BYTES = RATE * CHANNELS * BYTES_PER_SAMPLE * MAX_SECONDS;

/** Below this, a recording is treated as "nothing was said" rather than sent.
 *  Whisper answers silence with confident invented sentences, and a fumbled
 *  key press must not put words in your mouth. */
const MIN_BYTES = RATE * CHANNELS * BYTES_PER_SAMPLE * 0.25;

/**
 * Below this loudness, on the meter's own scale, nothing was said.
 *
 * About −56 dBFS: under a quiet room, far under the quietest speech. The
 * press it catches is Right-Ctrl held for a shortcut, or a microphone that is
 * muted — both a second or more of near-silence, both long enough to pass
 * `MIN_BYTES`, and both turned by whisper into a confident sentence nobody
 * said, which auto-send then sent.
 */
const MIN_PEAK = 0.04;

export type CaptureOpts = {
  /** The input to record from, or "" for the system default. */
  device: string;
};

export type CaptureEvents = {
  /** Loudness of the last chunk, 0…1, for the meter. */
  onLevel: (level: number) => void;
  /** The recording hit its length cap and the recorder was closed. The key
   *  is presumably still held — the owner should stop the turn now rather
   *  than sit in "recording" with nothing coming in. */
  onFull: () => void;
};

type Capture = {
  child: Deno.ChildProcess;
  chunks: Uint8Array[];
  bytes: number;
  done: Promise<void>;
  stopped: boolean;
  /** The loudest thing heard. Zero means the microphone produced silence —
   *  which is a different failure from "the model made nothing of it", and
   *  the two are indistinguishable without it. */
  peak: number;
  startedAt: number;
  /** Everything the recorder said on stderr. Read the whole time — an unread
   *  pipe can fill and stall it — and the only explanation there is when the
   *  microphone produced nothing: a device that does not exist, no sound
   *  server, a busy input. */
  grumbles: Promise<string>;
};

let current: Capture | null = null;

/**
 * Start and stop, strictly in order.
 *
 * Both are async and both are driven by a key: down and up can be a tenth of a
 * second apart, while `start` is still awaiting a dynamic import and a spawn.
 * Unserialised, a quick press ran `stop` FIRST — it found no recorder, called
 * the press too short, and threw the audio away; then `start` finished and
 * left a recorder running that nobody owned. The next press cleaned that up,
 * which is why it looked like every other attempt worked.
 *
 * Chaining them makes a short press a short RECORDING rather than a lost one,
 * and makes an orphaned recorder impossible rather than unlikely.
 */
const inOrder = serial();

/** Is the microphone open right now? */
export const capturing = (): boolean => current !== null;

/**
 * Start recording.
 *
 * Raw PCM on stdout rather than a WAV file: the header is 44 bytes this
 * module can write itself, and taking the samples as they arrive is what makes
 * a level meter possible at all. A file would only be readable once it was
 * finished.
 */
export function startCapture(
  opts: CaptureOpts,
  events: CaptureEvents,
): Promise<void> {
  return inOrder(() => reallyStart(opts, events));
}

async function reallyStart(
  opts: CaptureOpts,
  events: CaptureEvents,
): Promise<void> {
  // Belt and braces: the chain should mean there is never one of these left,
  // and if there is, it is a bug worth not compounding.
  if (current) await reallyStop().catch(() => {});

  const child = new Deno.Command("parecord", {
    args: [
      "--raw",
      `--rate=${RATE}`,
      `--channels=${CHANNELS}`,
      "--format=s16le",
      // Small buffers, so the meter moves while you speak rather than in
      // half-second steps.
      "--latency-msec=50",
      // Omitted entirely when empty: `--device=` with nothing after it is an
      // error, not a way of saying "the default".
      ...(opts.device ? [`--device=${opts.device}`] : []),
    ],
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).spawn();

  const cap: Capture = {
    child,
    chunks: [],
    bytes: 0,
    stopped: false,
    done: Promise.resolve(),
    peak: 0,
    startedAt: Date.now(),
    grumbles: new Response(child.stderr).text().catch(() => ""),
  };
  cap.done = drain(cap, events);
  current = cap;
  log.info("voice", "listening");
}

/** Read until the recorder is closed, keeping the samples and reporting how
 *  loud they were. */
async function drain(cap: Capture, events: CaptureEvents): Promise<void> {
  const reader = cap.child.stdout.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done || value === undefined) break;
      if (cap.bytes + value.length > MAX_BYTES) {
        log.warn("voice", "recording hit its cap, stopping", {
          seconds: MAX_SECONDS,
        });
        // Closed HERE, not at the keyup that may never come: left running, the
        // recorder blocks on a pipe nobody reads, and the mic sits in
        // "recording" with nothing coming in and nothing said about it.
        try {
          cap.child.kill("SIGTERM");
        } catch { /* already gone */ }
        events.onFull();
        break;
      }
      cap.chunks.push(value);
      cap.bytes += value.length;
      const level = rms(value);
      if (level > cap.peak) cap.peak = level;
      events.onLevel(level);
    }
  } catch (e) {
    if (!cap.stopped) {
      log.warn("voice", "microphone read failed", {
        error: e instanceof Error ? e.message : String(e),
      });
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Loudness of a block of signed 16-bit samples, 0…1.
 *
 * Root mean square, then a square root to open out the bottom of the range:
 * speech sits low in linear terms, and a meter that only twitches for shouting
 * tells you nothing about whether you are being heard.
 */
function rms(pcm: Uint8Array): number {
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const n = Math.floor(pcm.byteLength / 2);
  if (n === 0) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const s = view.getInt16(i * 2, true) / 32768;
    sum += s * s;
  }
  return Math.min(1, Math.sqrt(Math.sqrt(sum / n)));
}

/**
 * Stop, and hand back what was said as a WAV — or `null` when that was too
 * short to be speech.
 */
export function stopCapture(): Promise<Uint8Array | null> {
  return inOrder(() => reallyStop());
}

async function reallyStop(): Promise<Uint8Array | null> {
  const cap = current;
  current = null;
  if (!cap) return null;

  cap.stopped = true;
  try {
    cap.child.kill("SIGTERM");
  } catch { /* already gone */ }
  await cap.done;
  const status = await cap.child.status.catch(() => null);

  const seconds = +(cap.bytes / (RATE * CHANNELS * BYTES_PER_SAMPLE)).toFixed(
    2,
  );
  const heldFor = +((Date.now() - cap.startedAt) / 1000).toFixed(2);
  if (cap.bytes < MIN_BYTES) {
    // Too little audio, and there are two very different reasons. The
    // recorder saying why it stopped is the one that is a failure — a mic
    // that is not there — and it is the only place that reason exists.
    // Ended by our SIGTERM, `parecord` exits cleanly; exiting in failure on
    // its own is what a missing device or sound server looks like.
    const why = lastLine(await cap.grumbles);
    const failed = status !== null && !status.success && status.signal === null;
    if (failed && why !== "") {
      throw new Error(`The microphone did not start: ${why.slice(0, 200)}`);
    }
    log.info("voice", "too short to be speech, discarded", {
      seconds,
      heldFor,
    });
    return null;
  }
  if (cap.peak < MIN_PEAK) {
    // Held, but nothing was said into it — a shortcut, or a muted input.
    // Never transcribed: whisper answers silence with invented words.
    log.info("voice", "only silence, discarded", {
      seconds,
      peak: +cap.peak.toFixed(3),
      muted: cap.peak === 0,
    });
    return null;
  }
  // How much of the key-held time actually became audio, and how loud it got.
  // A recording that captured a fraction of what you held the key for means
  // the recorder was still starting up; a peak near zero means it was open and
  // heard nothing. Those are different problems and this is the line that
  // tells them apart.
  log.info("voice", "recorded", {
    seconds,
    heldFor,
    peak: +cap.peak.toFixed(3),
  });
  return wav(cap.chunks, cap.bytes);
}

/**
 * Wrap raw PCM in the 44-byte header that makes it a WAV.
 *
 * Written by hand because it is fourteen fields and no library: a dependency
 * for this would be more code to audit than the thing it replaces.
 */
function wav(chunks: Uint8Array[], bytes: number): Uint8Array {
  const out = new Uint8Array(44 + bytes);
  const view = new DataView(out.buffer);
  const ascii = (at: number, s: string) => {
    for (let i = 0; i < s.length; i++) out[at + i] = s.charCodeAt(i);
  };
  const byteRate = RATE * CHANNELS * BYTES_PER_SAMPLE;

  ascii(0, "RIFF");
  view.setUint32(4, 36 + bytes, true); // everything after this field
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true); // PCM header length
  view.setUint16(20, 1, true); // 1 = uncompressed PCM
  view.setUint16(22, CHANNELS, true);
  view.setUint32(24, RATE, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, CHANNELS * BYTES_PER_SAMPLE, true); // block align
  view.setUint16(34, BYTES_PER_SAMPLE * 8, true);
  ascii(36, "data");
  view.setUint32(40, bytes, true);

  let at = 44;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/**
 * What was said: one question to whisper, and more only when its answer
 * landed in a language you never speak.
 */
export async function transcribe(
  wavBytes: Uint8Array,
  opts: {
    baseUrl: string;
    language: string;
    translate: boolean;
    /** The languages you actually speak. Empty means "trust detection". */
    spoken: string[];
  },
  signal: AbortSignal,
): Promise<string> {
  const heard = await listen(wavBytes, opts, opts.language, signal);

  // A language was pinned, or you never said which ones you speak. Either way
  // there is nothing to check the answer against.
  if (opts.language !== "" || opts.spoken.length === 0) return heard.text;
  if (opts.spoken.some((code) => isLanguage(code, heard.language))) {
    return heard.text;
  }

  /*
   * Detection landed outside the languages you speak, so ask again properly.
   *
   * This is the "it hears Czech as Polish" fix, and it works because whisper
   * is not merely wrong, it is UNSURE. Measured on one Czech clip, pinning
   * each language and taking the mean word probability:
   *
   *   cs 0.913   sk 0.896   pl 0.785   ru 0.652   en 0.641
   *
   * Detection has to commit on the first few words, which for a short spoken
   * instruction is all of them, and Czech, Slovak and Polish are neighbours.
   * Transcribing is a much easier question than identifying, so asking it
   * once per language you actually speak and keeping the most confident
   * answer is both cheap and decisive.
   *
   * It costs nothing on the common path: this only runs when detection has
   * already gone somewhere you never speak.
   */
  //
  // Settled, not all-or-nothing: one language failing to answer must not
  // throw away the answer already in hand, nor the ones that did arrive.
  const tries = await Promise.allSettled(
    opts.spoken.map((code) => listen(wavBytes, opts, code, signal)),
  );
  const best = mostConfident(answered(tries));
  if (!best) return heard.text;
  log.info("voice", "that was not a language you speak — asked again", {
    detected: heard.language,
    confidence: +heard.confidence.toFixed(3),
    chose: best.language,
    instead: +best.confidence.toFixed(3),
  });
  return best.text;
}

/** One answer from the speech server, and how sure it was. */
export type Heard = { text: string; language: string; confidence: number };

/** The answers that arrived, out of several asked for at once. */
export const answered = (tries: PromiseSettledResult<Heard>[]): Heard[] =>
  tries.flatMap((t) => t.status === "fulfilled" ? [t.value] : []);

/**
 * The most confident of several answers, or `null` if none said anything.
 *
 * Pure, and separate, because "which of these is right" is the whole of the
 * language fix and the one part of it worth pinning in a test.
 */
export function mostConfident(tries: Heard[]): Heard | null {
  let best: Heard | null = null;
  for (const t of tries) {
    if (t.text === "") continue;
    if (best === null || t.confidence > best.confidence) best = t;
  }
  return best;
}

/**
 * Ask whisper.cpp's server what was said, in one particular language.
 *
 * `/inference`, which is whisper-server's own route. The OpenAI-compatible
 * path that llama.cpp and LM Studio answer on is NOT served here — measured,
 * against a build from source: it returns 404. Worth writing down, because
 * "they all speak OpenAI" is true of the text servers and led straight to the
 * wrong guess for this one.
 */
async function listen(
  wavBytes: Uint8Array,
  opts: { baseUrl: string; translate: boolean },
  language: string,
  signal: AbortSignal,
): Promise<Heard> {
  const form = new FormData();
  form.append(
    "file",
    new Blob([wavBytes as BufferSource], { type: "audio/wav" }),
    "speech.wav",
  );
  // `verbose_json`, not `json`, and the extra it carries is the point: the
  // language it decided on, and a probability per word. Plain `json` answers
  // with the text alone, so an answer in the wrong language was
  // indistinguishable from one in the right language.
  form.append("response_format", "verbose_json");
  // Temperature 0: a sampled decode invents plausible words where a confident
  // one would have said nothing, and this is dictation, not prose generation.
  form.append("temperature", "0");
  // Beam search, not greedy. Greedy takes the single likeliest word at each
  // step and cannot back out of a bad start; on a hard clip it loops or
  // gives up, and whisper then retries at rising temperatures, slowly.
  // Measured, 20 requests per row, on a Czech clip with the language pinned:
  // greedy 13/20 garbage loops at 1031 ms; beam of 5, none, at 243 ms. On
  // plain English the beam costs 14 ms. What OpenAI's own CLI defaults to.
  form.append("beam_size", "5");
  // ALWAYS sent. Leave it out and whisper-server falls back to its own
  // default, which is `en` — not "detect", but "this is English". Measured
  // on a Czech sentence, 20 requests: with the field absent, every answer
  // came back as an English translation; with `auto`, Czech. "" here means
  // let the model decide, and `auto` is how the server spells that.
  form.append("language", language === "" ? "auto" : language);
  form.append("translate", opts.translate ? "true" : "false");
  // NO `prompt`, and this is the line this feature's reliability hangs on.
  //
  // A first version sent the project's name and branch as whisper's initial
  // prompt, so it would spell them right. Measured against large-v3 on one
  // fixed clip of clear speech, 20 requests each: with no prompt, 0 empty
  // answers; with that prompt, 9; with a neutral one-line prompt, 10; with
  // the single word "cc", 13. Turning off the model's silence gate
  // (`no_speech_thold`) did not help, and turning off its temperature retry
  // (`temperature_inc=0`) made it 20 of 20 — so with a prompt the greedy
  // decode produced nothing EVERY time, and the answers that did arrive were
  // the random-temperature retry getting lucky. That is the whole of "it
  // works sometimes": a coin the model tossed on every sentence.
  //
  // Half your dictation lost, to spell a branch name. Not a trade.

  const url = `${opts.baseUrl.replace(/\/+$/, "")}/inference`;
  const at = Date.now();
  const res = await fetch(url, { method: "POST", body: form, signal });
  // What it said, not only its status — and read, which closes the body.
  if (!res.ok) throw new Error(await complaint(res));
  // Read as text, then parse. A 200 carrying something that is not the shape
  // we expect — an error object, an empty body, a truncated stream — used to
  // become `""` here and travel on as "the model made no words of that",
  // which is the same sentence this app says for a genuinely silent
  // recording. They are not the same thing and only one of them is normal.
  const raw = await res.text();
  let body: WhisperAnswer;
  try {
    body = JSON.parse(raw) as WhisperAnswer;
  } catch {
    log.warn("voice", "the speech server sent something that is not JSON", {
      ms: Date.now() - at,
      body: raw.slice(0, 200),
    });
    return { text: "", language: "", confidence: 0 };
  }
  const text = (body.text ?? "").trim();
  if (text === "") {
    // The fact that has been missing: what came back, and how fast. An answer
    // faster than the model can actually run is an answer it did not run for.
    log.warn("voice", "the speech server returned no text", {
      ms: Date.now() - at,
      sentBytes: wavBytes.length,
      language: language === "" ? "auto" : language,
      translate: opts.translate,
      body: raw.slice(0, 200),
    });
  }
  return { text, language: body.language ?? "", confidence: sureness(body) };
}

type WhisperAnswer = {
  text?: string;
  language?: string;
  segments?: { words?: { probability?: number }[] }[];
};

/**
 * How sure the model was, 0…1 — the mean probability of the words it wrote.
 *
 * Crude on purpose. It is only ever used to compare two answers about the SAME
 * audio, where the wrong language reliably scores lower because the model is
 * forcing sounds into words that do not fit them. An answer with no
 * per-word figures scores zero, which correctly loses to one that has them.
 */
function sureness(body: WhisperAnswer): number {
  const probs: number[] = [];
  for (const seg of body.segments ?? []) {
    for (const w of seg.words ?? []) {
      if (typeof w.probability === "number") probs.push(w.probability);
    }
  }
  if (probs.length === 0) return 0;
  return probs.reduce((a, b) => a + b, 0) / probs.length;
}

/**
 * The microphones this machine can offer, best guess first.
 *
 * Monitors are left out: they are the sound going OUT of the machine, and a
 * dictation feature that offers to record your speakers is offering a mistake.
 * "" means "whatever the system default is", which is the right answer for
 * most people and the wrong one for anybody whose default is a digital input
 * that no microphone is plugged into — which is exactly the case that made
 * this feature look broken.
 */
export async function inputs(): Promise<{ id: string; label: string }[]> {
  try {
    const out = await new Deno.Command("pactl", {
      args: ["list", "short", "sources"],
      stdout: "piped",
      stderr: "null",
    }).output();
    if (!out.success) return [];
    return new TextDecoder().decode(out.stdout)
      .split("\n")
      .map((line) => line.split("\t")[1] ?? "")
      .filter((name) => name !== "" && !name.endsWith(".monitor"))
      .map((name) => ({ id: name, label: readable(name) }));
  } catch {
    return [];
  }
}

/** `alsa_input.usb-046d_0825_8C0D0260-02.mono-fallback` is not a name anyone
 *  should have to read. */
function readable(name: string): string {
  const bits = name.replace(/^alsa_input\./, "").split(".");
  const head = (bits[0] ?? name)
    .replace(/^usb-/, "")
    .replace(/_[0-9A-F]{6,}/g, "")
    .replace(/[_-]+/g, " ")
    .trim();
  const tail = (bits[1] ?? "").replace(/[_-]+/g, " ").trim();
  const label = tail && !head.includes(tail) ? `${head} · ${tail}` : head;
  return label.length > 46 ? label.slice(0, 45) + "…" : label;
}

/** Is a speech server answering at this address? Same shape as the local
 *  engines' probe, and used the same way — to fill the address in for you. */
export async function probe(baseUrl: string): Promise<boolean> {
  try {
    // `/health` — whisper-server has no model list to ask for, and posting a
    // file just to find out whether it is there would be a transcription per
    // probe.
    const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/health`, {
      signal: AbortSignal.timeout(700),
    });
    return res.ok;
  } catch {
    return false;
  }
}
