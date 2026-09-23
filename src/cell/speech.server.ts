/**
 * @module
 * The voice that reads the conversation back. Server-only.
 *
 * The mirror image of `voice.server.ts`, and built the same way and for the
 * same reasons: the audio device is talked to by a small process on this
 * machine, not by the page. `paplay` takes raw samples on stdin, which means
 * the reply can be *played while it is still being made* — the server streams
 * PCM, the pipe carries it straight to the speakers, and the first words are
 * out in a fraction of a second instead of after the whole paragraph has been
 * synthesised. Doing this in the renderer would mean an `<audio>` element, a
 * container format, Electron's autoplay policy and no way to stop a buffer
 * that has already been handed to the browser.
 */
import { log } from "aio";
import { intoChunks, type Pcm, pcmFromWav } from "../lib/aloud.ts";
import { complaint, lastLine, refusal, serial } from "../lib/sound.ts";

/** What to assume a server's raw samples are, when it does not say.
 *
 *  Asking for `pcm` gets bare samples with no header, so both ends have to
 *  agree on the rate by hand — and get it right, because the only symptom of
 *  getting it wrong is a voice at the wrong pitch and speed, which sounds like
 *  a bad model rather than a bad number. Kokoro is 24 kHz and says nothing;
 *  Piper is 22.05 and says so. */
const RATE = 24_000;
const CHANNELS = 1;

/**
 * The longest a single reading may take, start to finish.
 *
 * Generous, because this covers *playback* as well as synthesis — the pipe is
 * open for as long as the speakers are busy. It is a backstop against a server
 * that accepted the request and then stopped sending, which would otherwise
 * hold the queue shut forever.
 */
const MAX_MS = 10 * 60 * 1000;

export type SayOpts = {
  baseUrl: string;
  voice: string;
  /** 0.5…2, where 1 is the voice's own pace. */
  speed: number;
  /** Which language this is, or "" to let the server decide. Sent as `lang`,
   *  which the servers that do not want it ignore. */
  language: string;
};

/**
 * What a given speech server turned out to be, learned by asking it once.
 *
 * There are two shapes of these and the app should not have to be told which
 * one it is looking at, because being told is a setting, and a setting is a
 * thing to get wrong. Both differences are discoverable:
 *
 *  - `model` is REQUIRED and validated. Kokoro wants "kokoro"; Supertonic
 *    refuses that outright — 400, `unknown_model` — and wants
 *    "supertonic-3". It says so on its health route; Kokoro lists its names
 *    on the OpenAI one.
 *  - `rate` is what those samples are, in Hz, when it will stream them. Piper
 *    is 22.05 kHz against Kokoro's 24, and playing one at the other's rate is
 *    a voice at the wrong pitch — which sounds like a bad model, not a bad
 *    number, so it is worth asking rather than assuming.
 *  - `raw` is whether it will stream bare samples. Kokoro will, which is what
 *    lets a reply start playing before it has finished being made. Supertonic
 *    answers `pcm` with a 400 and does whole WAV files only.
 */
type Server = { model: string; raw: boolean; rate: number };

const known = new Map<string, Server>();

/** Names that say nothing about who is answering — OpenAI's own, which these
 *  servers accept as aliases out of politeness. */
const STOCK = ["tts-1", "tts-1-hd", "gpt-4o-mini-tts"];

async function learn(base: string, signal: AbortSignal): Promise<Server> {
  const had = known.get(base);
  if (had) return had;
  // Supertonic names the model it loaded right here. Kokoro's health says only
  // that it is alive, and lists its names on the OpenAI route — where the
  // interesting one is whichever is not a stock alias.
  const health = await json<{ model?: string; sample_rate?: number }>(
    `${base}/v1/health`,
    signal,
  );
  const models = health?.model
    ? null
    : await json<{ data?: { id?: string }[] }>(`${base}/v1/models`, signal);
  const server = identify(health, models);
  // Remembered only when something actually answered. Supertonic's health is
  // a 503 for as long as its model is loading, and a guess cached then was a
  // wrong model name for the rest of the run — every sentence a 400, and
  // nothing but restarting the app would make it ask again.
  if (health === null && models === null) {
    log.info("speech", "voice server said nothing about itself — guessing", {
      model: server.model,
      url: base,
    });
    return server;
  }
  known.set(base, server);
  log.info("speech", "voice server identified", {
    model: server.model,
    rate: server.rate,
    url: base,
  });
  return server;
}

/**
 * What a server is, from what its health and model routes said.
 *
 * Pure, and separate, so "which answer wins" is pinned by a test rather than
 * rediscovered with a server that is half-loaded.
 */
export function identify(
  health: { model?: string; sample_rate?: number } | null,
  models: { data?: { id?: string }[] } | null,
): Server {
  const listed = models?.data
    ?.map((m) => String(m.id ?? "")).filter((id) => id !== "") ?? [];
  const model = health?.model ??
    listed.find((id) => !STOCK.includes(id)) ??
    listed[0] ??
    // Nothing would say. "kokoro" is the likelier guess and a wrong one costs
    // one 400 that the log will name.
    "kokoro";
  const rate = typeof health?.sample_rate === "number" && health.sample_rate > 0
    ? health.sample_rate
    : RATE;
  return { model, raw: true, rate };
}

/**
 * Did the server turn down raw samples, as opposed to anything else?
 *
 * Only this one refusal is worth a second request in the other shape, and only
 * this one is remembered. Any other failure — a model still loading, a voice
 * it does not have, a server restarting — used to switch streaming off for the
 * rest of the run, and a Kokoro that hiccupped once then made every reply wait
 * for the whole file. Supertonic's answer is a 400 naming `response_format`;
 * a validating server's is a 422 naming the same field.
 */
export const refusesRaw = (status: number, said: string): boolean =>
  [400, 415, 422].includes(status) && /format|pcm/i.test(said);

/**
 * The reading happening right now, if any.
 *
 * Claimed the moment a reading starts, before it has a player: most of a
 * reading's first second is asking the server who it is and waiting for the
 * first piece, and a Stop pressed then must find something to stop. `child`
 * is null until the player exists.
 */
let playing: {
  child: Deno.ChildProcess | null;
  abort: AbortController;
} | null = null;

/**
 * One reading at a time, in the order asked for.
 *
 * Same chain as the recorder, for a sharper reason: two `paplay` processes on
 * one sink do not take turns, they play *over each other*. Your own message
 * and the reply to it, simultaneously, is not a feature anyone would ask for.
 */
const inOrder = serial();

/**
 * Which era of speech we are in.
 *
 * Bumped by `silence()`. Anything queued behind the current reading checks
 * this before it starts, so switching the speaker off drops the backlog
 * instead of working through it — "stop" that finishes the queue first is not
 * stop.
 */
let epoch = 0;

/** Read `text` aloud. Resolves when the last sample has been played. */
export function say(text: string, opts: SayOpts): Promise<void> {
  const mine = epoch;
  return inOrder(async () => {
    if (mine !== epoch) return; // silenced while this waited its turn
    await reallySay(text, opts, mine);
  });
}

/**
 * Nothing is there to ask — no server on that port, or no such host.
 *
 * Its own kind of failure because it is the one that repeats: every message
 * after it would fail the same way, and the cell pauses reading on this one
 * rather than logging the same refusal for every line of every reply.
 */
export class Unreachable extends Error {
  override name = "Unreachable";
}

/** One request for speech, in whichever shape this server accepts. */
async function ask(
  base: string,
  text: string,
  opts: SayOpts,
  server: Server,
  raw: boolean,
  signal: AbortSignal,
): Promise<Response> {
  try {
    return await request(base, text, opts, server, raw, signal);
  } catch (e) {
    // `fetch` rejects with a TypeError for exactly one thing: it never got an
    // answer. An abort is a Stop, and stays one.
    if (e instanceof TypeError && !signal.aborted) {
      throw new Unreachable(
        `No voice server is answering at ${base} — start it, then switch the speaker on again.`,
      );
    }
    throw e;
  }
}

function request(
  base: string,
  text: string,
  opts: SayOpts,
  server: Server,
  raw: boolean,
  signal: AbortSignal,
): Promise<Response> {
  return fetch(`${base}/v1/audio/speech`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      // The OpenAI speech shape, which is what makes this swappable: any
      // server answering this route can be pointed at instead.
      model: server.model,
      input: text,
      voice: opts.voice,
      // Raw samples where they are on offer. Nothing has to decode them, and
      // a container header would have to be complete before playback could
      // start — the one thing streaming cannot promise.
      response_format: raw ? "pcm" : "wav",
      speed: opts.speed,
      stream: raw,
      // Only when one was chosen. A server told nothing picks for itself;
      // told "en" about a Czech sentence, it reads Czech with an English
      // mouth — the same trap whisper's own `language` default set.
      ...(opts.language === "" ? {} : { lang: opts.language }),
    }),
    signal,
  });
}

async function reallySay(
  text: string,
  opts: SayOpts,
  mine: number,
): Promise<void> {
  const pieces = intoChunks(text);
  if (pieces.length === 0) return;
  const abort = new AbortController();
  // Claimed before the first await — see `playing`.
  const me = { child: null as Deno.ChildProcess | null, abort };
  playing = me;
  const at = Date.now();
  const base = opts.baseUrl.replace(/\/+$/, "");
  const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(MAX_MS)]);
  /** Still wanted: not silenced since this reading was asked for. */
  const wanted = () => mine === epoch && !abort.signal.aborted;
  const release = () => {
    if (playing === me) playing = null;
  };

  const server = await learn(base, signal);

  /** One piece of speech as bare samples, in whichever shape this server
   *  offers. Throws what the server said, so a refusal explains itself. */
  const fetchPiece = async (piece: string): Promise<Pcm> => {
    let res = await ask(base, piece, opts, server, server.raw, signal);
    if (!res.ok && server.raw) {
      const said = await res.text().catch(() => "");
      if (!refusesRaw(res.status, said)) {
        throw new Error(refusal(res.status, said));
      }
      // Not a failure — a server that only does whole files. Asked once, then
      // remembered, so this costs one refused request per server per run.
      log.info("speech", "this server does not stream raw samples", {
        status: res.status,
      });
      server.raw = false;
      res = await ask(base, piece, opts, server, false, signal);
    }
    if (!res.ok) throw new Error(await complaint(res));
    const body = new Uint8Array(await res.arrayBuffer());
    return server.raw ? { pcm: body, rate: server.rate } : pcmFromWav(body);
  };

  // The first piece BEFORE the player, so a server that is not there cannot
  // leave a `paplay` holding the sound device open with nothing to play.
  let first: Pcm;
  try {
    first = await fetchPiece(pieces[0]);
  } catch (e) {
    release();
    // Stopped while asking is a stop, not a failure to report.
    if (!wanted()) return;
    throw e;
  }
  // Checked again: Stop pressed while the first piece was being made has to
  // mean no sound at all, not the first sentence and then silence.
  if (!wanted()) {
    release();
    return;
  }

  // ONE player for the whole reading, fed piece by piece.
  //
  // Always `--raw`, whatever the server hands back, because several pieces go
  // into this one process and a WAV header arriving in the middle of the audio
  // is a click followed by whatever its bytes sound like. The rate is the
  // server's own, asked for rather than assumed — or the file's own, for a
  // server that sends whole files and says in each one how fast it is.
  const child = new Deno.Command("paplay", {
    args: [
      "--raw",
      `--rate=${first.rate ?? server.rate}`,
      `--channels=${CHANNELS}`,
      "--format=s16le",
      // Named, so this shows up as the app in a volume mixer rather than as a
      // second anonymous "paplay" next to the recorder.
      "--client-name=cc",
      "--stream-name=Reading aloud",
    ],
    stdin: "piped",
    stdout: "null",
    stderr: "piped",
  }).spawn();
  me.child = child;

  // Drained rather than ignored: an unread pipe can fill and stall the child,
  // and `paplay`'s complaint about a missing sink is the one line that
  // explains a feature that looks like it did nothing.
  const grumbles = new Response(child.stderr).text().catch(() => "");

  const sink = child.stdin.getWriter();
  let stopped = false;
  let failure = "";
  try {
    // Writing BLOCKS once the player's buffer is full, which is the whole
    // trick: the next piece is fetched while the current one is playing, so
    // after the first there is nothing left to wait for.
    await sink.write(first.pcm);
    for (const piece of pieces.slice(1)) {
      await sink.write((await fetchPiece(piece)).pcm);
    }
  } catch (e) {
    // Two very different things end up here and they must not read the same.
    // Being switched off mid-sentence is normal and silent; a server that
    // stopped answering halfway through a long reply is a failure, and used
    // to be reported as neither.
    if (abort.signal.aborted) stopped = true;
    else failure = e instanceof Error ? e.message : String(e);
  }
  try {
    await sink.close();
  } catch { /* the player is already gone */ }
  const status = await child.status.catch(() => null);
  release();
  // Stopped near the end lands HERE rather than in the catch above: every
  // piece was already written, and only the player's exit says so. `paplay`
  // traps SIGTERM and exits 0, but one killed before its handler is up dies
  // of the signal — and a Stop is still a Stop, not "could not play".
  stopped ||= abort.signal.aborted;

  if (failure !== "") throw new Error(failure);
  if (!stopped && status && !status.success) {
    const why = lastLine(await grumbles);
    log.warn("speech", "could not play the audio", {
      code: status.code,
      why: why.slice(0, 200),
    });
    throw new Error(why === "" ? "the speakers refused it" : why);
  }
  log.info("speech", stopped ? "stopped mid-sentence" : "read aloud", {
    ms: Date.now() - at,
    chars: text.length,
    pieces: pieces.length,
    voice: opts.voice,
    language: opts.language === "" ? "server's choice" : opts.language,
  });
}

/**
 * Stop now, and drop whatever was queued behind it.
 *
 * Both halves matter. Killing the player alone would leave the next sentence
 * to start a moment later, which from the outside is a speaker that ignores
 * being switched off.
 */
export function silence(): void {
  epoch++;
  const now = playing;
  playing = null;
  if (!now) return;
  now.abort.abort();
  try {
    now.child?.kill("SIGTERM");
  } catch { /* already gone */ }
}

/**
 * The voices this server offers.
 *
 * Asked of the server rather than hardcoded, so a voice added upstream — or a
 * blended one saved by hand — shows up without the app being rebuilt. The
 * grades come from the model card and are passed through as they are: `af_
 * bella` being an A- and `am_santa` a D- is exactly the sort of thing a
 * picker should be honest about.
 */
export async function voices(
  baseUrl: string,
): Promise<{ id: string; grade: string; name: string }[]> {
  const base = baseUrl.replace(/\/+$/, "");
  // Two spellings, because there are two servers. Kokoro answers the OpenAI
  // route with grades from its model card; Supertonic has no such route and
  // lists its ten built-in styles under its own. Asked in that order and the
  // first answer wins, so neither has to be configured.
  const openai = await json<
    { voices?: { id?: string; name?: string; overall_grade?: string }[] }
  >(
    `${base}/v1/audio/voices`,
  );
  if (openai?.voices?.length) {
    return openai.voices
      .map((v) => {
        const id = String(v.id ?? "");
        const name = String(v.name ?? "");
        return {
          id,
          grade: v.overall_grade ?? "",
          // A label, but only when the server actually wrote one. Kokoro
          // repeats the id here; Piper — 136 voices across 57 languages, and
          // the only thing that knows what `cs_CZ` is called — sends
          // "Kasandra — Czech (Czech Republic) · medium".
          name: name === "" || name === id ? "" : name,
        };
      })
      .filter((v) => v.id !== "");
  }
  const styles = await json<{ styles?: { name?: string }[] }>(
    `${base}/v1/styles`,
  );
  return (styles?.styles ?? [])
    .map((v) => ({ id: String(v.name ?? ""), grade: "", name: "" }))
    .filter((v) => v.id !== "");
}

/** A GET that answers with parsed JSON, or `null` for anything that did not
 *  work — a 404, a refused connection, a body that is not JSON. Every caller
 *  here is asking "is it this shape?" and none of them want a throw. */
async function json<T>(
  url: string,
  signal?: AbortSignal,
): Promise<T | null> {
  const limit = AbortSignal.timeout(4000);
  try {
    const res = await fetch(url, {
      signal: signal ? AbortSignal.any([signal, limit]) : limit,
    });
    if (!res.ok) {
      await res.body?.cancel();
      return null;
    }
    return await res.json() as T;
  } catch {
    return null;
  }
}

/**
 * Is a speech server answering here?
 *
 * Both spellings of "are you alive", for the same reason as the voice list:
 * Kokoro serves `/health`, Supertonic `/v1/health`, and which one you are
 * running is not a thing this app should make you tell it.
 */
export async function probe(
  baseUrl: string,
  fresh: boolean,
): Promise<boolean> {
  const base = baseUrl.replace(/\/+$/, "");
  // Looking again ON PURPOSE means the answer may have changed. Somebody
  // stopping one server and starting another on the same port is exactly what
  // the Find button is pressed after, and a remembered model name from the old
  // one would 400 every sentence with nothing to explain it. A picker that
  // refreshes its list on focus is not that, and must not cost the next
  // reading a round of questions.
  if (fresh) known.delete(base);
  for (const path of ["/health", "/v1/health"]) {
    try {
      const res = await fetch(`${base}${path}`, {
        signal: AbortSignal.timeout(900),
      });
      await res.body?.cancel();
      if (res.ok) return true;
    } catch { /* try the other spelling */ }
  }
  return false;
}
