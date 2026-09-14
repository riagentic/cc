/**
 * @module
 * Server-only IO for the local engines: the OpenAI-compatible HTTP calls and
 * the tool executors the agent loop runs. Dynamically imported by `local.ts`,
 * same contract as the other `.server.ts` modules — nothing here may be
 * reached from the client graph (dep/aio/docs/build/imports.md).
 *
 * What is actually enforced here, stated honestly:
 *  - a tool call is executed only if its *name* is allowed for the mode — the
 *    model's opinion of what it may do is never the authority;
 *  - the filesystem tools resolve every path inside the project directory,
 *    symlinks included — `inside()` resolves the real path before judging it;
 *  - an existing file is only overwritten by a conversation that has read it,
 *    and never after it changed on disk since — and every file a turn changes
 *    is kept as it was, so the turn can be undone;
 *  - `sh` exists only in agent mode. In "Don't ask" it runs in a bubblewrap
 *    sandbox where one is available: the filesystem read-only except the
 *    project, /tmp and tool caches, credential stores hidden, secrets taken
 *    out of its environment. Otherwise it runs with the user's own
 *    privileges, and what is bounded is its blast radius on the machine: a
 *    wall-clock cap, an output cap enforced *while reading*, its own process
 *    group so the whole tree dies together, and the turn's abort signal.
 */
import { log } from "aio";
import { basename, dirname, join, normalize, relative } from "@std/path";
import {
  allowedTools,
  clip,
  emptyResult,
  harnessNoteIn,
  isCloudModel,
  isUnreachable,
  mayLeaveUnasked,
  parseTodos,
  safePattern,
  tierOf,
  TOOL_NAMES,
  toolBudget,
} from "../lib/agent.ts";
import type { LookEnv, WireMsg } from "../lib/agent.ts";
import { replaceIn, snippet } from "../lib/replace.ts";
import {
  type Account,
  accountArgv,
  accountCtlArgv,
  displayOfXauth,
  parsePasswd,
  unitName,
  validAccountName,
} from "../lib/account.ts";
import {
  type HistRow,
  mergeRows,
  readHistoryRow,
  type Recall,
  searchHistory,
} from "../lib/history.ts";
import type {
  EngineProbe,
  LocalEngine,
  LocalMode,
  LocalMsg,
  LocalPermission,
  PromptEnv,
} from "../type/local.ts";

/* ── HTTP ─────────────────────────────────────────────────────────────────── */

/** Models the server offers. `/v1/models` is common to all three engines;
 *  Ollama additionally serves its native `/api/tags`, used as the fallback
 *  for versions that predate its OpenAI surface. */
export async function listModels(
  baseUrl: string,
  timeoutMs = 5_000,
  cancel?: AbortSignal,
): Promise<string[]> {
  const base = baseUrl.replace(/\/+$/, "");
  const deadline = () =>
    cancel
      ? AbortSignal.any([cancel, AbortSignal.timeout(timeoutMs)])
      : AbortSignal.timeout(timeoutMs);
  try {
    const r = await fetch(`${base}/v1/models`, { signal: deadline() });
    if (r.ok) {
      const body = await r.json();
      const data = Array.isArray(body?.data) ? body.data : [];
      const ids = data
        .map((m: unknown) => (m as Record<string, unknown>)?.id)
        .filter((id: unknown): id is string => typeof id === "string");
      if (ids.length) return ids;
    } else {
      await r.body?.cancel();
    }
  } catch { /* fall through to the native listing */ }
  const r = await fetch(`${base}/api/tags`, { signal: deadline() });
  if (!r.ok) {
    await r.body?.cancel();
    throw new Error(`Model listing failed: HTTP ${r.status}`);
  }
  const body = await r.json();
  const models = Array.isArray(body?.models) ? body.models : [];
  return models
    .map((m: unknown) => (m as Record<string, unknown>)?.name)
    .filter((n: unknown): n is string => typeof n === "string");
}

/* ── detection ────────────────────────────────────────────────────────────── */

/** Where each engine serves by default. Mirrors `DEFAULT_URLS` in the cell —
 *  the cell may not import this module eagerly, so the table is repeated here
 *  rather than making the client graph depend on a server module. */
const PORTS: Record<LocalEngine, string> = {
  lmstudio: "http://localhost:1234",
  ollama: "http://localhost:11434",
  llamacpp: "http://localhost:8080",
};

/**
 * Where each engine is *also* commonly found, in preference order.
 *
 * LM Studio and Ollama own their ports and are almost never moved. llama.cpp
 * is the opposite: `llama-server` defaults to 8080, which is the single most
 * contested port on a developer's machine, so moving it is the normal case
 * rather than the exotic one — and the addresses people move it to are few and
 * predictable. A short curated list, not a port sweep.
 */
const ALSO: Record<LocalEngine, string[]> = {
  lmstudio: [],
  ollama: [],
  llamacpp: ["http://localhost:18080", "http://localhost:8081"],
};

/** A probe is a question about a port that is either open or not. Two seconds
 *  is generous for a loopback answer and short enough that looking for three
 *  engines the user runs none of costs a blink. */
const PROBE_MS = 2_000;

/** The scan in flight, so it can be cut short. A probe of three ports must not
 *  outlive the app that asked for it. */
let SCAN: AbortController | null = null;

/** Abort any scan in flight. Safe to call when there is none. */
export function cancelScan(): void {
  SCAN?.abort();
  SCAN = null;
}

/**
 * Ask all three default addresses what they are serving, at once.
 *
 * This is the whole "no manual setup" story: the ports are fixed by the
 * engines themselves, a listening server answers `/v1/models` in milliseconds,
 * and one that is not running refuses the connection immediately. Nothing here
 * guesses — an engine is reported reachable only because it replied.
 */
export async function detectEngines(
  /** The calling method's own abort — the app closing, or the method being
   *  cancelled. */
  cancel?: AbortSignal,
  /** Addresses somebody has actually configured, on top of the defaults — a
   *  server on a port somebody chose is found as readily as one on the
   *  default. */
  extra: { engine: LocalEngine; baseUrl: string }[] = [],
): Promise<EngineProbe[]> {
  cancelScan(); // one scan at a time; a newer question supersedes an older one
  const ctrl = new AbortController();
  SCAN = ctrl;
  const onCancel = () => ctrl.abort();
  if (cancel?.aborted) ctrl.abort();
  cancel?.addEventListener("abort", onCancel, { once: true });
  const engines = Object.keys(PORTS) as LocalEngine[];
  try {
    return await Promise.all(engines.map(async (engine) => {
      const candidates = [
        PORTS[engine],
        ...extra.filter((e) => e.engine === engine).map((e) => e.baseUrl),
        ...ALSO[engine],
      ]
        .map((u) => String(u ?? "").trim().replace(/\/+$/, ""))
        .filter((u, i, all) => u !== "" && all.indexOf(u) === i);

      // A GUESSED address has to prove what it is: `/v1/models` is served by
      // half the things a developer runs. The default and an address somebody
      // configured are exempt — those are not guesses.
      const guessed = new Set(ALSO[engine]);
      const answered = await Promise.all(
        candidates.map(async (baseUrl) => {
          try {
            const models = await listModels(baseUrl, PROBE_MS, ctrl.signal);
            if (
              guessed.has(baseUrl) &&
              !await isEngine(engine, baseUrl, ctrl.signal)
            ) {
              return null;
            }
            return { baseUrl, models };
          } catch {
            return null;
          }
        }),
      );
      const hit = answered.find((a) => a !== null);
      if (hit) {
        const tools = await probeTools(engine, hit.baseUrl, ctrl.signal);
        return {
          engine,
          baseUrl: hit.baseUrl,
          reachable: true,
          models: hit.models,
          tools,
        };
      }
      return {
        engine,
        baseUrl: candidates[0] ?? PORTS[engine],
        reachable: false,
        models: [],
        tools: null,
      };
    }));
  } finally {
    cancel?.removeEventListener("abort", onCancel);
    if (SCAN === ctrl) SCAN = null;
  }
}

/** What an OLD llama.cpp called "started without `--jinja`" — the fallback
 *  answer, used only when the server does not state its capabilities. */
const NO_TOOLS_FORMAT = "Content-only";

/**
 * Will this server take tool calls natively — for this model, where the
 * answer depends on the model?
 *
 *  - **llama.cpp** decides once, at startup, for everything it serves, and
 *    says so on `/props`.
 *  - **LM Studio** lists `capabilities: ["tool_use"]` per model in its own
 *    `/api/v0/models` — absent for a model not trained for tools (Gemma 3,
 *    whose template silently drops them).
 *  - **Ollama** lists `capabilities` per model on `/api/show`; a model
 *    without `tools` is refused with HTTP 400.
 *
 * `null` when the question has no answer here — then the first request finds
 * out. `false` does not end anything: the agent describes the tools in words.
 */
export async function probeTools(
  engine: LocalEngine,
  baseUrl: string,
  cancel?: AbortSignal,
  model?: string,
): Promise<boolean | null> {
  const base = baseUrl.replace(/\/+$/, "");
  if (engine === "lmstudio") {
    if (!model) return null;
    const body = await json(`${base}/api/v0/models`, undefined, cancel);
    const data = Array.isArray(body?.data)
      ? body.data as Record<string, unknown>[]
      : [];
    // An LM Studio that reports capabilities for nothing is too old to be
    // asked — its silence about one model means nothing.
    if (!data.some((m) => Array.isArray(m.capabilities))) return null;
    const row = data.find((m) => m.id === model);
    if (!row) return null;
    return Array.isArray(row.capabilities) &&
      row.capabilities.includes("tool_use");
  }
  if (engine === "ollama") {
    if (!model) return null;
    const shown = await json(`${base}/api/show`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model }),
    }, cancel);
    const caps = shown?.capabilities;
    return Array.isArray(caps) ? caps.includes("tools") : null;
  }
  const props = await json(`${base}/props`, undefined, cancel);
  if (!props) return null;
  // A current build answers the question itself, about the template it has
  // actually loaded.
  const caps = props.chat_template_caps as Record<string, unknown> | undefined;
  if (caps && typeof caps === "object") {
    const said = caps.supports_tools ?? caps.supports_tool_calls;
    if (typeof said === "boolean") return said;
  }
  // Older builds have no such block, and the chat format is all there is.
  const gen = props.default_generation_settings as
    | Record<string, unknown>
    | undefined;
  const params = gen?.params as Record<string, unknown> | undefined;
  const fmt = params?.chat_format ?? gen?.chat_format ?? props.chat_format;
  if (typeof fmt !== "string") return null;
  return fmt !== NO_TOOLS_FORMAT;
}

/** Does the thing answering at this address actually look like this engine?
 *  Only asked of *guessed* addresses; llama.cpp identifies itself on `/props`
 *  with fields nothing else serves. */
async function isEngine(
  engine: LocalEngine,
  baseUrl: string,
  cancel?: AbortSignal,
): Promise<boolean> {
  if (engine !== "llamacpp") return true;
  const props = await json(
    `${baseUrl.replace(/\/+$/, "")}/props`,
    undefined,
    cancel,
  );
  if (!props) return false;
  return "chat_template_caps" in props ||
    "default_generation_settings" in props ||
    "model_path" in props;
}

const asInt = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) && n >= 1_024 ? Math.floor(n) : null;
};

/** Fetch JSON, or null. Every detection probe is best-effort: a server that
 *  does not serve the endpoint is the normal case, not an error to report. */
async function json(
  url: string,
  init?: RequestInit,
  cancel?: AbortSignal,
  timeoutMs = PROBE_MS,
): Promise<Record<string, unknown> | null> {
  try {
    const r = await fetch(url, {
      ...init,
      signal: cancel
        ? AbortSignal.any([cancel, AbortSignal.timeout(timeoutMs)])
        : AbortSignal.timeout(timeoutMs),
    });
    if (!r.ok) {
      await r.body?.cancel();
      return null;
    }
    const body = await r.json();
    return body && typeof body === "object"
      ? body as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

/**
 * The window the server will actually run `model` at, and whether that is
 * known for sure.
 *
 *  - **llama.cpp**: `/props`. The per-slot `n_ctx` wins over the total — with
 *    `--parallel 4` each request gets a quarter, and that quarter is what a
 *    request over it is refused against.
 *  - **LM Studio**: `/api/v0/models`, `loaded_context_length` once the model
 *    is loaded. Before that the length is NOT the model's maximum — LM Studio
 *    loads with its own default, often 4k — so it is reported unsure, and the
 *    turn loads the model first and asks again (`warmUp`).
 *  - **Ollama**: `/api/ps` has the length a loaded model runs at. Its
 *    OpenAI-compatible endpoint cannot change it and silently cuts the front
 *    off a longer prompt — the system prompt first — so budgeting against the
 *    model's trained maximum would be the worst possible guess. Unloaded is
 *    unsure, as for LM Studio. Cloud models run remotely at their trained
 *    length, which `/api/show` reports.
 */
export async function probeWindow(
  engine: LocalEngine,
  baseUrl: string,
  model: string,
  cancel?: AbortSignal,
): Promise<{ ctx: number; sure: boolean } | null> {
  const base = baseUrl.replace(/\/+$/, "");
  if (engine === "llamacpp") {
    const props = await json(`${base}/props`, undefined, cancel);
    if (!props) return null;
    const gen = props.default_generation_settings as
      | Record<string, unknown>
      | undefined;
    const found = [
      asInt(gen?.n_ctx),
      asInt((gen?.params as Record<string, unknown> | undefined)?.n_ctx),
      asInt(props.n_ctx),
    ].filter((n): n is number => n !== null);
    return found.length ? { ctx: Math.min(...found), sure: true } : null;
  }
  if (engine === "ollama") {
    if (!model) return null;
    const trained = async () => {
      const shown = await json(`${base}/api/show`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model }),
      }, cancel);
      const info = shown?.model_info as Record<string, unknown> | undefined;
      for (const [k, v] of Object.entries(info ?? {})) {
        if (k.endsWith(".context_length")) {
          const n = asInt(v);
          if (n !== null) return n;
        }
      }
      return null;
    };
    if (isCloudModel(model)) {
      const n = await trained();
      return n === null ? null : { ctx: n, sure: true };
    }
    const ps = await json(`${base}/api/ps`, undefined, cancel);
    const rows = Array.isArray(ps?.models)
      ? ps.models as Record<string, unknown>[]
      : [];
    const row = rows.find((m) => m.name === model || m.model === model);
    if (row) {
      const loaded = asInt(row.context_length);
      if (loaded !== null) return { ctx: loaded, sure: true };
      // Loaded, on an Ollama too old to say at what length: its default was
      // 4k for years, and guessing low only costs room, never the prompt.
      const n = await trained();
      return { ctx: Math.min(n ?? 4_096, 4_096), sure: true };
    }
    const n = await trained();
    return n === null ? null : { ctx: Math.min(n, 4_096), sure: false };
  }
  const body = await json(`${base}/api/v0/models`, undefined, cancel);
  const data = Array.isArray(body?.data) ? body.data : [];
  const row = data.find((m: unknown) =>
    (m as Record<string, unknown>)?.id === model
  ) as Record<string, unknown> | undefined;
  if (!row) return null;
  const loaded = asInt(row.loaded_context_length);
  if (loaded !== null) return { ctx: loaded, sure: true };
  const max = asInt(row.max_context_length);
  return max === null ? null : { ctx: max, sure: row.state === "loaded" };
}

/** {@link probeWindow}'s number, for the callers that only budget. */
export async function probeContext(
  engine: LocalEngine,
  baseUrl: string,
  model: string,
): Promise<number | null> {
  return (await probeWindow(engine, baseUrl, model))?.ctx ?? null;
}

/**
 * Get the model into memory before the first real request, so the window it
 * loads at can be read instead of guessed.
 *
 * The load happens either way — the first request would pay for it — so
 * paying for it one tiny request early costs nothing but the round trip, and
 * buys packing against the true window from the very first round. LM Studio
 * loads on any completion; Ollama loads on a generate with no prompt.
 */
export async function warmUp(
  engine: LocalEngine,
  baseUrl: string,
  model: string,
  cancel: AbortSignal,
): Promise<void> {
  const base = baseUrl.replace(/\/+$/, "");
  // Loading a big model from disk takes a while; ten minutes is a hung
  // server, not a slow one.
  const signal = AbortSignal.any([cancel, AbortSignal.timeout(600_000)]);
  try {
    const r = engine === "ollama"
      ? await fetch(`${base}/api/generate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model }),
        signal,
      })
      : await fetch(`${base}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: "." }],
          max_tokens: 1,
          stream: false,
        }),
        signal,
      });
    await r.body?.cancel();
  } catch { /* best effort: the real request says what is wrong */ }
}

export type ChatRequest = {
  baseUrl: string;
  model: string;
  messages: WireMsg[];
  tools: unknown[];
  signal: AbortSignal;
  /** Cap on the reply, in tokens — see `maxOutput`. */
  maxTokens?: number;
  /** Cap on the model's thinking before its answer, in tokens — sent only to
   *  a server that honours it (see `thinkBudget`). */
  thinkBudget?: number;
  /** Called with each SSE `data:` payload, already JSON-parsed. */
  onChunk: (chunk: unknown) => void;
};

/** Silence after the first chunk — not slow tokens, *nothing* — for this
 *  long fails the turn with a reason. */
const STREAM_IDLE_MS = () => tunable("CC_STREAM_IDLE_MS", 120_000);
/** The wait for the FIRST chunk is longer, and has to be: a local server
 *  loads the model and reads the whole prompt before it says a word, and at
 *  a few hundred thousand tokens of prompt that is minutes of honest work. */
const STREAM_FIRST_MS = () => tunable("CC_STREAM_FIRST_MS", 900_000);
/**
 * How long one stretch of work may go on before the agent has to answer with
 * what it has.
 *
 * Rounds alone are no bound: a thousand cheap calls are twelve seconds against
 * a stub and most of a working day against a real 7B. Twenty minutes is long
 * enough for a real build-and-test cycle and short enough that a model walking
 * in circles gives the machine back.
 */
export const turnMs = (): number => tunable("CC_TURN_MS", 20 * 60_000);

/** A watchdog nobody can wait a real minute for in a test is a watchdog with
 *  no test — these are env-tunable for exactly that reason, defaults
 *  unchanged in real runs. */
/**
 * Tokens of thinking a reply may spend before it has to act — or `undefined`
 * for no cap (`CC_THINK_BUDGET=0`; a number there is a fixed cap).
 *
 * The server's generation speed was never the bottleneck: a live session ran
 * at 79 tokens/s with every prompt served from cache, and still spent most of
 * twenty minutes waiting on replies of 7,000–10,000 thinking tokens — two
 * minutes each — working a timer's arithmetic through in its head instead of
 * running the thing. llama.cpp ends the thinking at the budget and the reply
 * carries on from there.
 *
 * The cap is TIME, spelled in tokens. A fixed 4,096 was a minute for that
 * model and four for a dense 27B writing 17 tokens/s — test2's slowest steps
 * were 207 and 214 seconds of thought. So once the server has said how fast
 * this model writes (see `replyTimings`), the budget is what it writes in
 * `CC_THINK_SECONDS` (60), between 1,024 and 4,096 tokens.
 */
export function thinkBudget(baseUrl = "", model = ""): number | undefined {
  const raw = Deno.env.get("CC_THINK_BUDGET");
  if (raw === undefined || raw.trim() === "") {
    return budgetFor(WRITE_RATE.get(rateKey(baseUrl, model)), THINK_SECONDS());
  }
  const v = Number(raw);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : undefined;
}

const THINK_MIN = 1_024;
const THINK_MAX = 4_096;
const THINK_SECONDS = () => tunable("CC_THINK_SECONDS", 60);

/** A budget from a writing speed: `seconds` of it, clamped. No speed yet →
 *  the ceiling, as before the speed was known. Pure. */
export function budgetFor(
  tokPerSec: number | undefined,
  seconds: number,
): number {
  if (!tokPerSec || !Number.isFinite(tokPerSec) || tokPerSec <= 0) {
    return THINK_MAX;
  }
  return Math.max(
    THINK_MIN,
    Math.min(THINK_MAX, Math.round(tokPerSec * seconds)),
  );
}

/** llama.cpp's own account of one reply, from the stream's last chunk. */
export type ReplyTimings = {
  /** Prompt tokens served from the cache — not read again. */
  cached: number;
  /** Prompt tokens read, and how long that took. */
  read: number;
  readMs: number;
  /** Tokens written (thinking included), and how long that took. */
  wrote: number;
  writeMs: number;
};

/** The `timings` object llama.cpp puts on a completion, or null for a chunk
 *  without one (every other chunk, and every other engine). Pure. */
export function replyTimings(chunk: unknown): ReplyTimings | null {
  const t = (chunk as { timings?: unknown } | null)?.timings;
  if (!t || typeof t !== "object") return null;
  const n = (k: string) => {
    const v = Number((t as Record<string, unknown>)[k]);
    return Number.isFinite(v) && v > 0 ? v : 0;
  };
  return {
    cached: n("cache_n"),
    read: n("prompt_n"),
    readMs: n("prompt_ms"),
    wrote: n("predicted_n"),
    writeMs: n("predicted_ms"),
  };
}

/** The last measured writing speed per server and model, tokens/s. Process
 *  bookkeeping, like `RUNNING`: a restart measures again on its first reply. */
const WRITE_RATE = new Map<string, number>();
const rateKey = (baseUrl: string, model: string) =>
  `${baseUrl.replace(/\/+$/, "")} ${model}`;

/** The writing speed a turn's clock (`turnMs`) is set for. */
const CLOCK_RATE = 60;

/**
 * How many times longer than `turnMs` this model's turn may run: the speed
 * the clock is set for over the model's measured one, between 1 and 4.
 *
 * The clock is there to end a turn getting nowhere, and "nowhere" is a count
 * of rounds, not of minutes. On the wall clock a dense 27B at 17 tokens/s
 * gets a quarter of the rounds a 79 tokens/s model does: test2 was cut at 45
 * minutes, still progressing, before it had run anything once. Nothing is
 * measured yet → 1, the clock as it was.
 */
export function turnStretch(baseUrl = "", model = ""): number {
  return stretchFor(WRITE_RATE.get(rateKey(baseUrl, model)));
}

/** Pure half of `turnStretch`. */
export function stretchFor(tokPerSec: number | undefined): number {
  if (!tokPerSec || !Number.isFinite(tokPerSec) || tokPerSec <= 0) return 1;
  return Math.min(4, Math.max(1, CLOCK_RATE / tokPerSec));
}

/** Too few tokens say nothing about speed: a one-word reply is mostly the
 *  time to its first token. */
const RATE_MIN_TOKENS = 64;

/**
 * Keep the speed, and say where the reply's time went: reading the prompt,
 * or writing. A reply that reads most of a long prompt again when the
 * previous one was cached means the prompt's beginning changed — the one
 * cost that grows with the conversation — and only this line shows it.
 */
function noteTimings(req: ChatRequest, t: ReplyTimings): void {
  if (t.wrote >= RATE_MIN_TOKENS && t.writeMs > 0) {
    WRITE_RATE.set(
      rateKey(req.baseUrl, req.model),
      t.wrote / (t.writeMs / 1000),
    );
  }
  const perSec = (n: number, ms: number) =>
    ms > 0 ? Math.round(n / (ms / 1000)) : 0;
  log.info("local", "reply timings", {
    cached: t.cached,
    read: t.read,
    readSec: Math.round(t.readMs / 100) / 10,
    readPerSec: perSec(t.read, t.readMs),
    wrote: t.wrote,
    writeSec: Math.round(t.writeMs / 100) / 10,
    writePerSec: perSec(t.wrote, t.writeMs),
  });
}

function tunable(name: string, fallback: number): number {
  const v = Number(Deno.env.get(name));
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

/** The partial-line carry between chunks. SSE frames are short; a "stream"
 *  that sends megabytes with no newline is not SSE. */
const MAX_SSE_CARRY = 1_048_576;

/**
 * One streamed chat completion. Chunks go to `onChunk` as they arrive; the
 * accumulation lives in `lib/agent.ts` so this function stays transport only.
 *
 * A request that dies *before its first chunk* is retried once, after a
 * beat: a local server that was mid-model-swap or briefly out of file
 * descriptors refuses the connection and then answers, and a request with
 * no output yet cannot have been seen by the model — so the resend is safe.
 * Silence is not retried: a server that said nothing for fifteen minutes
 * will say nothing for fifteen more.
 */
export async function chatStream(req: ChatRequest): Promise<void> {
  for (let attempt = 0;; attempt++) {
    let sawChunk = false;
    const seen: (chunk: unknown) => void = (chunk) => {
      sawChunk = true;
      req.onChunk(chunk);
    };
    try {
      await chatStreamOnce(req, seen);
      return;
    } catch (e) {
      if (attempt > 0 || sawChunk || req.signal.aborted) throw e;
      const why = e instanceof Error ? e.message : String(e);
      // 502/503 are what a local server answers with while it is mid-reload
      // or mid-model-swap — transient, and safe to retry while nothing was
      // emitted. A 4xx is the server's considered answer.
      const transient = isUnreachable(why) || /\bHTTP 50[23]\b/.test(why);
      if (!transient) throw e;
      log.warn("local", "stream failed before any output — retrying once", {
        error: why,
      });
      await new Promise((r) => setTimeout(r, 400));
    }
  }
}

async function chatStreamOnce(
  req: ChatRequest,
  onChunk: (chunk: unknown) => void,
): Promise<void> {
  const base = req.baseUrl.replace(/\/+$/, "");
  const silent = () => new Error("The server went silent mid-stream.");
  const watchdog = new AbortController();
  let idleTimer = setTimeout(() => watchdog.abort(silent()), STREAM_FIRST_MS());
  const alive = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => watchdog.abort(silent()), STREAM_IDLE_MS());
  };
  try {
    const r = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: AbortSignal.any([req.signal, watchdog.signal]),
      body: JSON.stringify({
        model: req.model,
        messages: req.messages,
        stream: true,
        // Usage on the final chunk — the measured prompt size is what the
        // packer calibrates its estimates against.
        stream_options: { include_usage: true },
        ...(req.maxTokens ? { max_tokens: req.maxTokens } : {}),
        ...(req.thinkBudget
          ? {
            thinking_budget_tokens: req.thinkBudget,
            reasoning_budget_message: "\n\n(Thinking budget used up: act" +
              " now on what you have — run something, or answer.)\n",
          }
          : {}),
        ...(req.tools.length ? { tools: req.tools } : {}),
      }),
    });
    if (!r.ok || !r.body) {
      const detail = r.body ? clip(await r.text(), 400) : "";
      throw new Error(`HTTP ${r.status}${detail ? ` — ${detail}` : ""}`);
    }

    const decoder = new TextDecoder();
    let buf = "";
    let sse = false;
    let timings: ReplyTimings | null = null;
    const handle = (data: string) => {
      if (!data || data === "[DONE]") return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(data);
      } catch {
        return; // a torn frame from another program — skip, never throw
      }
      // LM Studio and llama.cpp report a failure that happens after the
      // headers went out as an `error` object in the stream. Folded as a
      // chunk it would change nothing, and the turn would end with an empty
      // reply and no reason.
      const err = (parsed as Record<string, unknown>)?.error;
      if (err) {
        const msg = typeof err === "string" ? err : String(
          (err as Record<string, unknown>).message ?? JSON.stringify(err),
        );
        throw new Error(`The server reported an error: ${clip(msg, 400)}`);
      }
      timings = replyTimings(parsed) ?? timings;
      onChunk(parsed);
    };
    // Lines that were not SSE, kept while no `data:` line has been seen — in
    // case the whole body is one plain JSON reply (see below).
    let plain = "";
    for await (const bytes of r.body) {
      alive();
      buf += decoder.decode(bytes, { stream: true });
      if (buf.length > MAX_SSE_CARRY || plain.length > MAX_SSE_CARRY) {
        throw new Error("The server sent an over-long unterminated frame.");
      }
      // SSE events are newline-delimited; a chunk boundary can split one.
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (line.startsWith("data:")) {
          sse = true;
          handle(line.slice(5).trim());
        } else if (!sse) plain += line + "\n";
      }
    }
    // Some servers answer `stream: true` with one plain JSON completion. The
    // same reply, in another shape: fold it as a single chunk.
    const body = plain + buf;
    if (!sse && body.trim().startsWith("{")) {
      let whole: Record<string, unknown> | null = null;
      try {
        whole = JSON.parse(body);
      } catch { /* not JSON either — nothing to fold */ }
      if (whole?.error) handle(JSON.stringify(whole));
      const choice = Array.isArray(whole?.choices)
        ? (whole.choices as Record<string, unknown>[])[0]
        : undefined;
      if (choice?.message) {
        onChunk({
          choices: [{
            delta: choice.message,
            finish_reason: choice.finish_reason ?? "stop",
          }],
          usage: whole?.usage,
        });
      }
      timings = replyTimings(whole) ?? timings;
    }
    if (timings) noteTimings(req, timings);
  } finally {
    clearTimeout(idleTimer);
  }
}

/* ── run registry ─────────────────────────────────────────────────────────── */

/** The in-flight run per CONVERSATION — process bookkeeping, inherently
 *  mutable, and deliberately here rather than in cell state: an
 *  AbortController is not a value. Keyed by pane, not by project, because a
 *  project holds several chats and they are allowed to think at once. */
const RUNNING = new Map<string, AbortController>();

/** A Stop that arrived before the turn had registered its run — between the
 *  page showing "working" and `beginRun`. Without it that Stop found nothing
 *  to abort, and the turn started anyway. Consumed by the next `beginRun`,
 *  dropped by `endRun`, so it can never cut a LATER turn short. */
const STOP_EARLY = new Set<string>();

export function beginRun(key: string): AbortSignal {
  RUNNING.get(key)?.abort();
  const ctrl = new AbortController();
  RUNNING.set(key, ctrl);
  if (STOP_EARLY.delete(key)) ctrl.abort();
  return ctrl.signal;
}

/** Close out one run — but only the run that owns `signal`. Without the
 *  check, a superseded loop's `finally` would delete its *replacement's*
 *  controller and Stop would silently stop nothing. */
export function endRun(key: string, signal: AbortSignal): void {
  if (RUNNING.get(key)?.signal === signal) RUNNING.delete(key);
  STOP_EARLY.delete(key);
}

/** Stop one conversation's run. Safe when idle. `early`: a turn is known to
 *  be starting, so a Stop that finds no run yet is kept for it — and only
 *  then; one recorded with no turn coming would cut the NEXT turn short. */
/** Ends the run, and says whether there was one to end — a "working" flag with
 *  no run behind it is a lost write or a throw in the turn's prologue, and the
 *  Stop button is what has to clean it up. */
export function stopRun(key: string, early = false): boolean {
  const run = RUNNING.get(key);
  if (run) run.abort();
  else if (early) STOP_EARLY.add(key);
  RUNNING.delete(key);
  // A turn parked on a decision has to come down with it, or Stop would leave
  // the loop waiting for an answer to a question nobody can see any more.
  answerApproval(key, false);
  return run !== undefined;
}

/* ── command approvals ────────────────────────────────────────────────────── */

/** The resolver for a turn parked on "may I run this command". A promise is
 *  not a value; the *question* is state (the page renders it from the chat
 *  record) and this is only the wire the answer travels back along. */
const ASKING = new Map<
  string,
  { call: string; done: (allowed: boolean) => void }
>();

/** Park until the user answers, or until the turn is aborted (which counts as
 *  a refusal — a stopped turn must never go on to run the command).
 *
 *  `call` is the id of the call being asked about: a batch of commands runs one
 *  at a time with no model round-trip between them, so two questions can follow
 *  each other inside a single second, and an answer must belong to the one it
 *  was clicked on. */
export function awaitApproval(
  key: string,
  signal: AbortSignal,
  call: string,
): Promise<boolean> {
  answerApproval(key, false); // supersede any earlier question
  if (signal.aborted) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    const done = (allowed: boolean) => {
      signal.removeEventListener("abort", onAbort);
      ASKING.delete(key);
      resolve(allowed);
    };
    const onAbort = () => done(false);
    signal.addEventListener("abort", onAbort, { once: true });
    ASKING.set(key, { call, done });
  });
}

/** Answer the question, if the one outstanding is the one being answered. A
 *  click meant for a command that has already been dealt with is dropped, not
 *  applied to whatever came next. Without a `call` — an abort, a supersede,
 *  a Clear — whatever is outstanding is refused. */
export function answerApproval(
  key: string,
  allowed: boolean,
  call?: string,
): void {
  const asking = ASKING.get(key);
  if (!asking) return;
  if (call !== undefined && asking.call !== call) {
    log.info("local", "a stale approval click was ignored", { key });
    return;
  }
  ASKING.delete(key);
  asking.done(allowed);
}

/* ── the project, as the system prompt describes it ───────────────────────── */

/** Files a project keeps its instructions for agents in, in preference
 *  order — the conventions opencode and Claude Code read. The first one found
 *  wins; they do not stack. */
const INSTRUCTION_FILES = ["AGENTS.md", "CLAUDE.md", "CONTEXT.md"];

/**
 * Everything the system prompt says about the project: date, OS, git state,
 * top-level entries, and the project's own instructions for agents — each
 * sized to the window. Gathered once per conversation (see `local.ts`), so
 * none of it costs a request, and all of it is best-effort: a missing git or
 * an unreadable file leaves that line out, never the turn.
 */
/** Folder names that hold a project's — or a dependency's — documentation. */
const DOC_DIRS = new Set(["docs", "doc", "documentation"]);

/**
 * The page to start on, best first.
 *
 * A folder of two hundred pages is not an answer to "how does this framework
 * work" — and the good ones ship the answer: `ai.md` is written for models,
 * `content.md` is an index by question, `AGENTS.md` is the verbs for driving
 * the app. A live session was told `Docs: dep/aio/docs/` and nothing more; it
 * never opened `ai.md`, which begins "Read these first, in this order", and
 * spent its turn reverse-engineering the source instead.
 */
const DOC_ENTRIES = [
  "ai.md",
  "AGENTS.md",
  "content.md",
  "README.md",
  "index.md",
];

/** The first entry page inside `dir`, or "" — one `stat` each, five at most. */
async function docEntry(dir: string): Promise<string> {
  for (const name of DOC_ENTRIES) {
    const ok = await Deno.stat(join(dir, name)).then(
      (s) => s.isFile,
      () => false,
    );
    if (ok) return name;
  }
  return "";
}

/**
 * Where the documentation is, four levels deep at most: `docs/`,
 * `dep/aio/docs/`, `app/dep/aio/docs/`. A model that is not told the docs
 * exist reverse-engineers the framework's source instead — one live session
 * spent its first minutes grepping aio's internals with `dep/aio/docs` right
 * there. Vendored dependencies are often symlinks, so those are followed;
 * the walk is bounded so a huge tree costs nothing.
 */
export async function docsOf(cwd: string, max: number): Promise<string> {
  const found: string[] = [];
  let seen = 0;
  // Level by level, so the project's own docs/ is found before anything a
  // dependency buries four folders down — and the bound falls on the far end.
  let level: { dir: string; rel: string }[] = [{ dir: cwd, rel: "" }];
  for (
    let depth = 1;
    depth <= 4 && level.length && found.length < max;
    depth++
  ) {
    const next: { dir: string; rel: string }[] = [];
    for (const { dir, rel } of level) {
      let entries: Deno.DirEntry[] = [];
      try {
        for await (const e of Deno.readDir(dir)) entries.push(e);
      } catch {
        continue;
      }
      entries = entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const e of entries) {
        if (found.length >= max || ++seen > 800) return found.join(", ");
        if (SKIP.has(e.name) || e.name.startsWith(".")) continue;
        const path = join(dir, e.name);
        const isDir = e.isDirectory ||
          (e.isSymlink &&
            (await Deno.stat(path).then((st) => st.isDirectory, () => false)));
        if (!isDir) continue;
        const here = rel ? `${rel}/${e.name}` : e.name;
        if (DOC_DIRS.has(e.name.toLowerCase())) {
          const entry = await docEntry(path);
          found.push(entry ? `${here}/ (start: ${entry})` : `${here}/`);
        } else next.push({ dir: path, rel: here });
      }
    }
    level = next;
  }
  return found.join(", ");
}

/**
 * The documentation of a framework this project VENDORS, if it ships any.
 *
 * Only a declared dependency counts — a private framework nobody's training
 * data has heard of is exactly the case where a model guesses from the file
 * extension and builds the wrong thing. A project's own `docs/` folder is not
 * this: the model can read the code beside it.
 */
export async function frameworkDocs(
  cwd: string,
  /** Look again rather than trust the cache — for a turn that has just run a
   *  command, which may have been the `am create` that put the framework
   *  there. */
  fresh = false,
): Promise<{ rel: string; entry: string } | null> {
  const root = await Deno.realPath(cwd).catch(() => cwd);
  for (const d of await projectDeps(root, fresh)) {
    for (const name of DOC_DIRS) {
      const dir = join(d.real, name);
      const ok = await Deno.stat(dir).then((st) => st.isDirectory, () => false);
      if (!ok) continue;
      return { rel: join(d.rel, name), entry: await docEntry(dir) };
    }
  }
  return null;
}

export async function projectEnv(cwd: string, ctx: number): Promise<PromptEnv> {
  const tier = tierOf(ctx);
  const env: PromptEnv = {
    cwd,
    date: new Date().toISOString().slice(0, 10),
    platform: Deno.build.os,
  };
  try {
    const run = async (args: string[]) => {
      const out = await new Deno.Command("git", {
        args: ["-C", cwd, ...args],
        stdin: "null",
        stdout: "piped",
        stderr: "null",
        signal: AbortSignal.timeout(3_000),
      }).output();
      return out.success ? new TextDecoder().decode(out.stdout).trim() : null;
    };
    const branch = await run(["rev-parse", "--abbrev-ref", "HEAD"]);
    if (branch !== null) {
      const status = await run(["status", "--porcelain"]);
      const dirty = status ? status.split("\n").filter(Boolean).length : 0;
      env.git = `branch ${branch}, ${
        dirty ? `${dirty} uncommitted change${dirty === 1 ? "" : "s"}` : "clean"
      }`;
    }
  } catch { /* no git on this machine — nothing to say */ }
  try {
    const entries: string[] = [];
    for await (const e of Deno.readDir(cwd)) {
      if (
        SKIP.has(e.name) || (e.name.startsWith(".") && e.name !== ".github")
      ) {
        continue;
      }
      entries.push(e.isDirectory ? `${e.name}/` : e.name);
    }
    const cap = tier === "tiny" ? 20 : tier === "small" ? 40 : 80;
    entries.sort((a, b) =>
      Number(b.endsWith("/")) - Number(a.endsWith("/")) || a.localeCompare(b)
    );
    env.tree = entries.slice(0, cap).join(" ") +
      (entries.length > cap ? ` …(+${entries.length - cap})` : "");
  } catch { /* unreadable root — the model can still ls */ }
  // Only set when there is something: state is persisted, and an
  // `undefined` field makes aio refuse the WHOLE save ("state contains a
  // value JSON cannot round-trip") — every change after it stayed in memory.
  const toolchain = await toolchainOf(cwd);
  if (toolchain) env.toolchain = toolchain;
  const docs = await docsOf(cwd, tier === "tiny" ? 2 : 5);
  if (docs) env.docs = docs;
  const room = tier === "tiny" ? 1_500 : tier === "small" ? 6_000 : 24_000;
  for (const name of INSTRUCTION_FILES) {
    try {
      const path = await inside(cwd, name);
      const { text } = await readCapped(path);
      if (!text.trim()) continue;
      env.instructions = {
        path: name,
        text: text.length > room
          ? text.slice(0, room) +
            `\n[…${name} continues — read it for the rest]`
          : text.trim(),
      };
      break;
    } catch { /* not there — try the next name */ }
  }
  // No instructions written for agents: the start of the README is the next
  // best thing — it is where "how to run the tests" usually lives. Not on a
  // tiny window, where it would cost more than it tells.
  if (!env.instructions && tier !== "tiny") {
    try {
      const { text } = await readCapped(await inside(cwd, "README.md"));
      const cut = tier === "small" ? 1_200 : 4_000;
      if (text.trim()) {
        env.instructions = {
          path: "README.md (start)",
          text: text.length > cut ? text.slice(0, cut) + "\n[…]" : text.trim(),
        };
      }
    } catch { /* no README — nothing to add */ }
  }
  return env;
}

/**
 * How the project builds and tests, from the manifests at its root — the
 * question a model otherwise answers by guessing, and a model that guesses
 * `npm test` in a Deno project spends its turn rewriting the tests for Node.
 */
async function toolchainOf(cwd: string): Promise<string> {
  const read = async (name: string) => {
    try {
      return (await readCapped(await inside(cwd, name))).text;
    } catch {
      return null;
    }
  };
  const keysOf = (text: string | null, field: string): string[] => {
    try {
      const obj = JSON.parse(
        (text ?? "").replace(/^\s*\/\/.*$/gm, ""), // deno.jsonc comments
      )?.[field];
      return obj && typeof obj === "object"
        ? Object.keys(obj).slice(0, 10)
        : [];
    } catch {
      return [];
    }
  };
  const has = async (name: string) =>
    (await Deno.stat(join(cwd, name)).catch(() => null)) !== null;
  const out: string[] = [];
  const deno = (await read("deno.json")) ?? (await read("deno.jsonc"));
  if (deno !== null) {
    const tasks = keysOf(deno, "tasks");
    out.push(
      `deno${
        tasks.length ? ` (deno task: ${tasks.join(", ")})` : " (deno test)"
      }`,
    );
  }
  const pkg = await read("package.json");
  if (pkg !== null) {
    const pm = await has("pnpm-lock.yaml")
      ? "pnpm"
      : await has("yarn.lock")
      ? "yarn"
      : (await has("bun.lockb") || await has("bun.lock"))
      ? "bun"
      : "npm";
    const scripts = keysOf(pkg, "scripts");
    out.push(`${pm}${scripts.length ? ` (run: ${scripts.join(", ")})` : ""}`);
  }
  if (await has("Cargo.toml")) out.push("cargo (build, test)");
  if (await has("go.mod")) out.push("go (build, test)");
  if (await has("pyproject.toml") || await has("requirements.txt")) {
    out.push("python" + (await has("pytest.ini") ? " (pytest)" : ""));
  }
  const make = await read("Makefile");
  if (make !== null) {
    const targets = [...make.matchAll(/^([a-zA-Z0-9_-]+):(?!=)/gm)].map((m) =>
      m[1]
    ).slice(0, 8);
    out.push(
      `make${targets.length ? ` (targets: ${targets.join(", ")})` : ""}`,
    );
  }
  return out.join(" · ");
}

/* ── tools ────────────────────────────────────────────────────────────────── */

/** Command wall-clock, by default and at most. A local agent's `sh` is for
 *  builds and tests, not servers — but a real test suite takes minutes, and a
 *  60s cap killed exactly the verification the prompt asks for. */
const SH_DEFAULT_MS = () => tunable("CC_SH_TIMEOUT_MS", 120_000);
const SH_MAX_MS = 600_000;
/** Bytes of command output kept per stream. Enforced while reading — a
 *  `yes`-style firehose costs this much memory, not everything until the
 *  timeout. */
const SH_MAX_BYTES = 262_144;

/**
 * The command, with limits the kernel enforces rather than the timeout.
 *
 * A timeout stops a command that is slow; it does nothing about one that is
 * multiplying. `-u` is the ceiling on tasks, which is what a fork bomb runs
 * into — and it has to be measured, not chosen: Linux counts that limit against
 * every thread the *user* already has, and a desktop session is eight thousand
 * threads before this app starts. A fixed 4096 refused to `fork` for an honest
 * `env` on the machine this was written on.
 *
 * Deliberately NOT `-v`: virtual memory is reserved wildly by honest runtimes
 * (a JVM, Deno, any allocator that randomises its address space), and a limit
 * there breaks real work while barely touching real memory use.
 *
 * **And deliberately not `-f` any more.** It was here to stop a runaway from
 * filling the disk, at a 2 GB ceiling per file. What it actually stopped was
 * every `deno check` and `deno test` on this machine: `ulimit -f` is a cap on
 * any file the process writes AT ALL, and Deno's shared caches are already far
 * above it — measured here, `~/.cache/deno/v8_code_cache_v2` is 8.5 GB and
 * `dep_analysis_cache_v2` is 5.1 GB. Touching one costs the process a SIGXFSZ,
 * so the agent's only way to verify its own work died with "File size limit
 * exceeded (core dumped)" and exit 153. One live session spent thirty-five
 * rounds proving that was not its code, then gave up and hand-checked the
 * arithmetic in bun.
 *
 * The protection was weak anyway: the cap is PER FILE, so a runaway fills the
 * disk with two hundred files under it and the limit never fires. The real
 * walls are the sandbox (nothing outside the project is writable) and the
 * output cap (nothing huge reaches the model). `CC_SH_MAX_FILE_KB` still works
 * for anyone who wants the ceiling back; it is simply off unless asked for.
 *
 * Every limit is `|| true`: a shell that will not lower one must still run the
 * command.
 */
function bounded(cmd: string, headroom: number | null): string {
  const procs = headroom === null
    ? ""
    : `ulimit -u ${headroom} 2>/dev/null || true\n`;
  const kb = tunable("CC_SH_MAX_FILE_KB", 0);
  const files = kb > 0 ? `ulimit -f ${kb} 2>/dev/null || true\n` : "";
  return `${procs}${files}${cmd}`;
}

/** Threads this user has right now, cached — it moves slowly, and the answer
 *  costs a few hundred small reads. `null` when /proc did not say (another
 *  platform, a hidden proc): then there is no task ceiling, because a wrong
 *  one breaks honest commands. */
let TASKS: { at: number; n: number } | null = null;
async function taskHeadroom(): Promise<number | null> {
  if (!TASKS || Date.now() - TASKS.at > 30_000) {
    const uid = Deno.uid();
    if (uid === null) return null;
    let n = 0;
    try {
      for await (const e of Deno.readDir("/proc")) {
        if (!/^\d+$/.test(e.name)) continue;
        const st = await Deno.readTextFile(`/proc/${e.name}/status`)
          .catch(() => "");
        if (!st) continue;
        const mine = new RegExp(`^Uid:\\s+${uid}\\b`, "m").test(st);
        if (!mine) continue;
        n += Number(/^Threads:\s+(\d+)/m.exec(st)?.[1] ?? 1);
      }
    } catch {
      return null;
    }
    if (n === 0) return null;
    TASKS = { at: Date.now(), n };
  }
  // A quarter more than is already running, and never less than two thousand:
  // a build's worth of compilers fits, a bomb does not.
  return TASKS.n + Math.max(2_000, Math.round(TASKS.n / 4));
}

const MAX_LS_ENTRIES = 300;
const MAX_GREP_HITS = 100;
/** Files one grep call may open. The hit cap bounds output; this bounds the
 *  walk itself, so a huge tree cannot turn one call into minutes of IO. */
const MAX_GREP_FILES = 3_000;
/** Total bytes of file text one grep call may hold before it is handed to
 *  the worker — the real ceiling on a pathological tree. */
const MAX_GREP_TOTAL_BYTES = 48 * 1_048_576;
const MAX_READ_LINES = 2_000;
/** A line longer than this is cut: one minified line must not be the whole
 *  result. */
const MAX_LINE_CHARS = 2_000;
/** Bytes read from any file by `read`/`grep`. The same guard the preview pane
 *  carries: a file's size must never become the app's memory footprint
 *  because a model asked about it. */
const MAX_FILE_BYTES = 2 * 1_048_576;
/** A regex is only ever run against this much of one line. */
const MAX_LINE_SCAN = 1_000;
/** Wall-clock a model-supplied regex gets, across the whole grep, before its
 *  worker is terminated. */
const GREP_DEADLINE_MS = () => tunable("CC_GREP_DEADLINE_MS", 2_000);
/** Originals kept for undo: per file, and per conversation. A file bigger
 *  than this is changed without a copy, and the undo says so. */
const MAX_UNDO_FILE = 4 * 1_048_576;
const MAX_UNDO_TOTAL = 32 * 1_048_576;

/** Directories no search or listing walks into — same set the tree scanner
 *  skips, for the same reason. */
const SKIP = new Set([
  ".git",
  "node_modules",
  ".venv",
  "venv",
  "__pycache__",
  "target",
  "dist",
  "build",
  ".next",
  ".cache",
]);

/**
 * Directory names a walk should not enter in this project: the fixed SKIP
 * set, hidden directories, and every plain name the root `.gitignore` lists
 * (`dist/`, `/build`, `coverage`). What ripgrep does by default, roughly —
 * a model searching a repo wants its source, not its build output, and at 8k
 * of context one listing of `.aio/` or `dist/` is the whole window.
 * Patterns with wildcards are left alone: guessing at them could hide source.
 */
async function walkSkip(root: string): Promise<(name: string) => boolean> {
  const ignored = new Set<string>();
  try {
    const text = (await readCapped(join(root, ".gitignore"))).text;
    for (const raw of text.split("\n")) {
      const line = raw.trim().replace(/^\//, "").replace(/\/$/, "");
      if (
        line && !line.startsWith("#") && !line.startsWith("!") &&
        /^[\w.-]+$/.test(line)
      ) {
        ignored.add(line);
      }
    }
  } catch { /* no .gitignore — the fixed set only */ }
  return (name) =>
    SKIP.has(name) || ignored.has(name) ||
    (name.startsWith(".") && name !== ".github");
}

/**
 * Resolve `p` inside `cwd`, or throw. Every filesystem tool funnels through
 * here — the one place the boundary is enforced. Judged on *real* paths:
 * the deepest existing ancestor is `Deno.realPath`ed first, so a symlink
 * pointing out of the project is caught even though the lexical path looks
 * inside.
 *
 * `forRead` lets a READ follow a link that lives inside the project to a
 * target outside it — `dep/aio → ~/.local/lib/aio-versions/…` is how a
 * project vendors its framework, and the model has to be able to read it
 * (it did so through `sh cat $(readlink -f …)` anyway, after four refused
 * attempts). A path that is outside the project as written is still refused,
 * credential stores are refused whatever the route, and nothing is ever
 * WRITTEN through such a link.
 */
async function inside(
  cwd: string,
  p: string,
  forRead = false,
  /** This conversation's scratch directory, which the sandbox shows as `/tmp`.
   *  Passed by the read-only tools so that the file a background job writes —
   *  the one the model is TOLD to read, `/tmp/job-1.log` — is the same file
   *  from outside the box as from inside it. */
  convTmp = "",
): Promise<string> {
  // Only the conversation's own directory, and never through `..` — by the name
  // it has outside the box (checked first, since that name can itself begin
  // with /tmp), which is how a job run outside the sandbox names its log: a live
  // session told "read it with: cat /home/…/tmp/job-1.log" was refused three
  // times as "outside the project"…
  if (
    convTmp !== "" && forRead && p.startsWith(convTmp + "/") &&
    !p.slice(convTmp.length).includes("..")
  ) {
    return p;
  }
  // …or by the name the sandbox gives it (only the sandbox renames /tmp: an
  // account's temp is a real folder under it, by its real name).
  if (
    convTmp !== "" && forRead && p.startsWith("/tmp/") &&
    convTmp.startsWith(tmpRoot() + "/") &&
    !p.slice(5).includes("..") && p.length > 5
  ) {
    return join(convTmp, p.slice(5));
  }
  const root = await Deno.realPath(cwd);
  const lexical = normalize(p.startsWith("/") ? p : join(cwd, p || "."));
  const within = (a: string, base: string) =>
    a === base || a.startsWith(base + "/");
  let existing = lexical;
  let tail = "";
  for (;;) {
    let real: string;
    try {
      real = await Deno.realPath(existing);
    } catch {
      const parent = dirname(existing);
      if (parent === existing) {
        throw new Error(`Path is outside the project: ${p}`);
      }
      tail = tail
        ? join(existing.slice(parent.length + 1), tail)
        : existing.slice(parent.length + 1);
      existing = parent;
      continue;
    }
    const abs = tail ? join(real, tail) : real;
    if (within(abs, root)) return abs;
    const written = within(lexical, normalize(cwd)) || within(lexical, root);
    if (!written) {
      // Written as an absolute path, but landing in a dependency this project
      // declares: the same bytes the in-project spelling reads, so refusing it
      // teaches nothing except that spellings are a guessing game. A live
      // session, refused `clock/dep/aio/...`, went for
      // `/home/dev/.local/lib/aio-versions/...` next and was refused again.
      if (forRead && !isSecret(abs) && await declaredDep(root, abs)) return abs;
      throw new Error(
        `Path is outside the project: ${p} — the project is ${root}; use a` +
          ` path inside it.`,
      );
    }
    if (forRead && !isSecret(abs)) {
      if (!isPrivateArea(abs)) return abs;
      // Private by its path, but the project's own configuration says this is
      // part of how it is built. See `declaredDeps`.
      if (await declaredDep(root, abs)) return abs;
    }
    // Writing into a framework the project depends on is the one refusal a
    // model has to be told the way round: a live session hit a bug in it and
    // went to patch the framework's own export list.
    const framework = !forRead && await declaredDep(root, abs);
    throw new Error(
      `${p} is a link that leads outside the project (to ${abs}) — ` +
        (forRead
          ? "that location is private and cannot be read."
          : framework
          ? "it is the framework this project depends on, shared by every" +
            " app on that version, and it is not yours to change. Work" +
            " around the problem in your own code (another API, a simpler" +
            " approach), or tell the user what in the framework blocks you."
          : "reading through it is fine, writing through it is not."),
    );
  }
}

/**
 * Is `abs` inside something this project's own configuration points at?
 *
 * The case this exists for, measured on a live session: an aio app keeps its
 * framework at `dep/aio`, a symlink into `~/.local/lib/aio-versions/<version>`,
 * and `deno.json` says so — `"aio": "./dep/aio/mod.ts"`. The framework's docs
 * and source are exactly what has to be read to write against it. But the
 * target has a dotted component under `$HOME`, so `isPrivateArea` called it
 * private and refused all of it: one agent spent twenty minutes and 88 rounds
 * guessing a testing API whose documentation was one `read` away, and fifteen
 * refusals went by with nobody able to see which paths they were.
 *
 * An import map is the project saying "this path is part of me". Nobody's
 * import map points at `~/.ssh`, which is what keeps this narrow: only the
 * links the project itself names, and `isSecret` still applies inside them —
 * a declared dependency's `.env` is as off-limits as anyone else's.
 */
async function declaredDep(root: string, abs: string): Promise<boolean> {
  const under = (deps: DepLink[]) =>
    deps.some((d) => abs === d.real || abs.startsWith(d.real + "/"));
  // A miss is checked again against the disk before it becomes a refusal. The
  // cache is only a speed-up for the yes: a live session listed its empty
  // folder, ran `am create pomodoro`, and had `pomodoro/dep/aio/docs` refused
  // six times over the next ten seconds, because the walk it was refused by
  // was taken before the app existed. It fell back to `sh cat | head`, and
  // read the framework's docs in 150-line slices from then on.
  return under(await projectDeps(root)) ||
    under(await projectDeps(root, true));
}

/**
 * Every dependency link this project declares, from every config inside it.
 *
 * Not just the root's: `am create clock` scaffolds `clock/` with its own
 * `deno.json` and its own `clock/dep/aio`, one level below the folder the
 * conversation opened, and reading only the root's config refused exactly the
 * app the agent had been told to build.
 *
 * Bounded and cheap: three levels, the usual skip set, and symlinks are never
 * entered — past a link we would be reading the dependency's own imports, which
 * declare nothing about this project.
 */
async function projectDeps(root: string, fresh = false): Promise<DepLink[]> {
  const hit = PROJECT_DEPS.get(root);
  if (!fresh && hit && Date.now() - hit.at < DEP_TTL_MS) return hit.roots;
  const out = new Map<string, DepLink>();
  const walk = async (dir: string, depth: number): Promise<void> => {
    for (const d of await depRoots(dir, fresh)) {
      const under = dir.slice(root.length + 1);
      const rel = under ? join(under, d.rel) : d.rel;
      // Two apps in one project can vendor the SAME framework directory, and
      // then one name for it is enough — the shortest, which is the one nearest
      // the project root and the one a search is most likely to want.
      const had = out.get(d.real);
      if (!had || rel.length < had.rel.length) {
        out.set(d.real, { rel, real: d.real });
      }
    }
    if (depth >= 3) return;
    let entries: Deno.DirEntry[] = [];
    try {
      entries = [...await Array.fromAsync(Deno.readDir(dir))];
    } catch {
      return;
    }
    for (const e of entries) {
      // `isDirectory` is false for a symlink, which is exactly the stop wanted.
      if (!e.isDirectory || e.name.startsWith(".") || SKIP.has(e.name)) {
        continue;
      }
      await walk(join(dir, e.name), depth + 1);
    }
  };
  await walk(root, 0);
  const list = [...out.values()];
  PROJECT_DEPS.set(root, { at: Date.now(), roots: list });
  return list;
}

const PROJECT_DEPS = new Map<string, { at: number; roots: DepLink[] }>();

/**
 * What to add to a search that found nothing, when the project vendors code a
 * root-level walk does not enter.
 *
 * A walk from the project root stops at a symlink, and it should: `**​/*.ts`
 * there is a question about this project, not about the forty thousand lines
 * behind `dep/aio`. But a model asking "where is `onMount` used" gets "No
 * matches" and no idea why — one live session answered that by running
 * `sh grep -rn` five times with the same pattern, which skips symlinks too, so
 * it learned nothing five times over. One line at the only moment it matters.
 */
async function depHint(root: string): Promise<string> {
  const links = await projectDeps(root);
  if (links.length === 0) return "";
  const named = links.slice(0, 2).map((d) => `path="${d.rel}"`).join(" or ");
  return ` (${
    links.map((d) => d.rel).slice(0, 2).join(", ")
  } is a dependency and is not searched from the project root — pass ${named}` +
    ` to search it.)`;
}

/**
 * The ways this project's dependencies are written in a tool call — how the
 * project spells each (`app/dep/aio`) and where it really is — for noticing a
 * turn that keeps looking inside one.
 */
export async function dependencyMarks(
  cwd: string,
  fresh = false,
): Promise<string[]> {
  const root = await Deno.realPath(cwd).catch(() => cwd);
  return (await projectDeps(root, fresh)).flatMap((d) => [d.rel, d.real]);
}

/** Cached per project for a few seconds: this runs on every path a tool
 *  touches, and an import map changes about once a release. */
const DEP_ROOTS = new Map<string, { at: number; roots: DepLink[] }>();
const DEP_TTL_MS = 30_000;

/** A dependency reached through a link the project declares: where the project
 *  spells it (`dep/aio`) and where it really is. */
type DepLink = { rel: string; real: string };

/**
 * The real directories behind the relative entries of `<root>/deno.json`'s
 * import map.
 *
 * Only the LINKS matter here: an import that resolves to a plain path inside
 * the project needs no exception, and one that leaves the project does so
 * through a symlink somewhere along the way (`dep/aio`). So each relative
 * import is walked from its own path up to the project root, and any ancestor
 * that is a symlink contributes its target.
 */
async function depRoots(root: string, fresh = false): Promise<DepLink[]> {
  const hit = DEP_ROOTS.get(root);
  if (!fresh && hit && Date.now() - hit.at < DEP_TTL_MS) return hit.roots;
  const roots = new Map<string, DepLink>();
  try {
    let text = "";
    for (const name of ["deno.json", "deno.jsonc"]) {
      text = await Deno.readTextFile(join(root, name)).catch(() => "");
      if (text !== "") break;
    }
    // jsonc: line comments only, which is all the format is used for here.
    const parsed = JSON.parse(
      text.replace(/^\s*\/\/.*$/gm, ""),
    ) as { imports?: Record<string, unknown> };
    for (const value of Object.values(parsed.imports ?? {})) {
      if (typeof value !== "string" || !value.startsWith(".")) continue;
      let at = normalize(join(root, value));
      // Up the chain, stopping at the project itself: the symlink is the
      // boundary crossing, and its target is what has to become readable.
      while (at.startsWith(root + "/")) {
        const link = await Deno.lstat(at).then((s) => s.isSymlink).catch(
          () => false,
        );
        if (link) {
          const real = await Deno.realPath(at).catch(() => "");
          if (real !== "") {
            roots.set(real, { rel: at.slice(root.length + 1), real });
          }
        }
        at = dirname(at);
      }
    }
  } catch {
    /* no config, or one this app cannot read: no exceptions granted */
  }
  const list = [...roots.values()];
  DEP_ROOTS.set(root, { at: Date.now(), roots: list });
  return list;
}

/** Places no tool reads, whatever path leads there: the same credential
 *  stores the sandbox hides, this app's own data, and the places apps keep
 *  their tokens (`~/.config`, flatpak's `~/.var`) — a link planted in a
 *  cloned repo must not become a way to read them. */
function isSecret(abs: string): boolean {
  if (SECRET_NAMES.test(basename(abs))) return true;
  const home = Deno.env.get("HOME") ?? "";
  if (!home) return false;
  return [...HIDDEN_DIRS, ...HIDDEN_FILES, ".config", ".var"].some((d) => {
    const p = join(home, d);
    return abs === p || abs.startsWith(p + "/");
  });
}

/**
 * Places a link out of the project may not lead, even for reading.
 *
 * A link out is allowed on purpose — `dep/aio` pointing at a live checkout of
 * the framework is how this very project is meant to be read, and refusing it
 * would send the agent to guess instead of to the docs. What is refused is the
 * shape that is never a dependency: the home directory itself (one `grep` over
 * it is a search for every secret the user owns), anything hidden inside it,
 * the system root, and the kernel's own trees.
 */
function isPrivateArea(abs: string): boolean {
  const home = Deno.env.get("HOME") ?? "";
  if (abs === "/" || (home && abs === home)) return true;
  if (/^\/(proc|sys|dev|root|boot)(\/|$)/.test(abs)) return true;
  if (home && abs.startsWith(home + "/")) {
    // A dotted component anywhere under it: config, caches, credentials, mail.
    return abs.slice(home.length + 1).split("/").some((part) =>
      part.startsWith(".")
    );
  }
  return false;
}

/** Files that are credentials by their name alone. This applies only where a
 *  path has already left the project — a link out of it, another checkout,
 *  another user's home — because reading another project's `.env` is how one
 *  conversation's transcript ends up holding a key that belongs to a different
 *  piece of work entirely. Inside the project the agent reads what the project
 *  contains; that is the job. */
const SECRET_NAMES =
  /^(\.env(\..+)?|\.netrc|\.npmrc|\.pypirc|\.git-credentials|credentials|id_[a-z0-9]+|.*\.pem|.*\.p12|.*\.pfx|.*\.kdbx|.*\.key)$/i;

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown, d: number): number =>
  typeof v === "number" && Number.isFinite(v) ? v : d;

/** The bounded read every text-consuming tool shares: at most
 *  `MAX_FILE_BYTES`, never the whole file. */
async function readCapped(
  path: string,
): Promise<{ text: string; truncated: boolean; binary: boolean }> {
  const stat = await Deno.stat(path);
  if (!stat.isFile) throw new Error("Not a file.");
  const file = await Deno.open(path, { read: true });
  try {
    const buf = new Uint8Array(Math.min(stat.size, MAX_FILE_BYTES));
    let n = 0;
    while (n < buf.length) {
      const read = await file.read(buf.subarray(n));
      if (read === null) break;
      n += read;
    }
    const bytes = buf.subarray(0, n);
    return {
      text: new TextDecoder().decode(bytes),
      truncated: stat.size > n,
      binary: looksBinary(bytes),
    };
  } finally {
    file.close();
  }
}

/** A NUL byte, or mostly unprintable bytes, in the first 4 KB — the same test
 *  git and opencode use. Decoded as text, a binary file is noise the model
 *  then tries to reason about. */
function looksBinary(bytes: Uint8Array): boolean {
  const head = bytes.subarray(0, 4_096);
  let odd = 0;
  for (const b of head) {
    if (b === 0) return true;
    if (b < 9 || (b > 13 && b < 32)) odd++;
  }
  return head.length > 0 && odd / head.length > 0.3;
}

/** The project-relative spelling of a path, for everything shown to the
 *  model: shorter, and the spelling it should use back. */
const rel = (root: string, abs: string): string => relative(root, abs) || ".";

/** How to spell paths found under `base` — which may sit behind a link that
 *  leads out of the project. Then the spelling keeps the link (`dep/aio/src/
 *  x.ts`), because that is the path the model can use again; the resolved
 *  one (`../../.local/lib/…`) would be refused as outside. */
const spellFrom =
  (root: string, base: string, shown: string) => (abs: string): string =>
    abs === root || abs.startsWith(root + "/")
      ? rel(root, abs)
      : join(shown || ".", relative(base, abs));

/** "Did you mean" for a path that is not there: names in the same directory
 *  that contain, or are contained in, the one asked for — and failing that,
 *  the same file name nearby.
 *
 *  A path inside a dependency the project declares (`app/dep/aio/docs/…`) is
 *  answered from inside that dependency and spelled the way the project
 *  spells it. It used to be neither: a live session asking for
 *  `pomodoro/dep/aio/docs/ui/air.md` was offered
 *  `../../../.local/lib/aio-versions/v1.0.0-beta/docs/ui/air-reference.md`,
 *  and asking twice for `docs/state/cell-testing.md` got no hint at all,
 *  because the name search started at the project root and never crosses a
 *  link — while the file sat at `docs/testing/cell-testing.md`. */
async function suggest(abs: string, root: string): Promise<string> {
  const near = await nearPaths(abs, root);
  return near.length ? ` Did you mean: ${near.join(", ")}?` : "";
}

/** The candidates behind "did you mean", nearest first, at most five — each
 *  spelled the way the model can use it again (a folder ends in "/"). */
export async function nearPaths(abs: string, root: string): Promise<string[]> {
  const dep = (await projectDeps(root)).find((d) =>
    abs === d.real || abs.startsWith(d.real + "/")
  );
  const base = dep?.real ?? root;
  const spell = (p: string): string =>
    dep ? join(dep.rel, relative(dep.real, p)) : rel(root, p);
  const want = basename(abs).toLowerCase();
  const dir = dirname(abs);
  const near: string[] = [];
  try {
    for await (const e of Deno.readDir(dir)) {
      const name = e.name.toLowerCase();
      const stem = want.replace(/\.[^.]*$/, "");
      if (
        name.includes(stem) || (stem.includes(name.replace(/\.[^.]*$/, "")) &&
          name.length > 2)
      ) {
        near.push(spell(join(dir, e.name)) + (e.isDirectory ? "/" : ""));
      }
      if (near.length >= 5) break;
    }
  } catch { /* the directory is missing too */ }
  // Neighbouring folders, by a shared start of name: a live session asked for
  // `docs/testing/cells.md` and was offered `docs/state/cells.md`, while
  // `docs/testing/cell-testing.md` was what it wanted. Four letters in common
  // is the bar, so `cell` finds `cell-testing` and nothing finds everything.
  const stemOf = (n: string) => n.toLowerCase().replace(/\.[^.]*$/, "");
  const wantStem = stemOf(want);
  const shared = (n: string) => {
    let i = 0;
    while (i < n.length && i < wantStem.length && n[i] === wantStem[i]) i++;
    return i;
  };
  const up = dirname(dir);
  if (
    near.length < 5 && wantStem.length >= 4 &&
    (up === base || up.startsWith(base + "/"))
  ) {
    const around = [dir];
    try {
      for await (const e of Deno.readDir(up)) {
        if (e.isDirectory && join(up, e.name) !== dir) {
          around.push(join(up, e.name));
        }
      }
    } catch { /* no parent to look in */ }
    for (const at of around) {
      try {
        for await (const e of Deno.readDir(at)) {
          if (near.length >= 5) break;
          const p = spell(join(at, e.name)) + (e.isDirectory ? "/" : "");
          if (!near.includes(p) && shared(stemOf(e.name)) >= 4) near.push(p);
        }
      } catch { /* unreadable — skip it */ }
    }
  }
  // Nothing beside it: the same name elsewhere — the model asked for
  // `src/cell.ts` while the file is `aio-test/src/cell.ts`, and four reads
  // failed with nothing to go on. Searched outward from where it was asked
  // for, so the nearest match comes first and a large tree is not walked from
  // the top when the answer is next door.
  if (near.length === 0) {
    const name = basename(abs);
    // The same name in a folder above first: those are never reached by the
    // walk below while a subtree already holds five. A live session asked for
    // `dep/aio/src/mod.ts`, was offered five `src/*/mod.ts` — never the
    // framework's own `dep/aio/mod.ts` — decided the export it wanted did not
    // exist, and deleted a correct import.
    for (let at = dirname(dirname(abs));; at = dirname(at)) {
      if (at !== base && !at.startsWith(base + "/")) break;
      const p = join(at, name);
      if (await Deno.stat(p).then((st) => st.isFile, () => false)) {
        near.push(spell(p));
      }
      if (at === base || near.length >= 5) break;
    }
    const skip = await walkSkip(root);
    const walked = new Set<string>();
    let seen = 0;
    const walk = async (at: string, depth: number): Promise<void> => {
      if (depth > 8 || near.length >= 5 || seen > 4_000 || walked.has(at)) {
        return;
      }
      walked.add(at);
      try {
        for await (const e of Deno.readDir(at)) {
          if (near.length >= 5 || ++seen > 4_000) return;
          if (e.isSymlink) continue;
          const p = join(at, e.name);
          if (e.isDirectory) {
            if (!skip(e.name)) await walk(p, depth + 1);
          } else if (e.name === name) near.push(spell(p));
        }
      } catch { /* unreadable, or not there — skip it */ }
    };
    for (let at = dirname(abs);; at = dirname(at)) {
      if (at !== base && !at.startsWith(base + "/")) break;
      await walk(at, 0);
      if (near.length > 0 || at === base) break;
    }
    // Still nothing, and the path was spelled as if the file were the
    // project's own: it may be the framework's. A live session asked for
    // `pomodoro/src/adapters/air.ts` — the file is
    // `pomodoro/dep/aio/src/adapters/air.ts` — and got no hint, because the
    // walk above never enters a link. Hits whose trailing folders match what
    // was asked come first: a framework has many `air.ts`.
    if (near.length === 0 && !dep) {
      const asked = relative(root, abs).split("/");
      const score = (p: string) => {
        const got = p.split("/");
        let n = 0;
        while (
          n < asked.length && n < got.length &&
          asked[asked.length - 1 - n] === got[got.length - 1 - n]
        ) n++;
        return n;
      };
      const hits: string[] = [];
      const deps = await projectDeps(root);
      // The cheap, exact case first: the same trailing path inside a dep.
      for (const d of deps) {
        for (let k = asked.length - 1; k >= 1 && hits.length === 0; k--) {
          const p = join(d.real, ...asked.slice(-k));
          if (await Deno.stat(p).then((st) => st.isFile, () => false)) {
            hits.push(join(d.rel, ...asked.slice(-k)));
          }
        }
      }
      for (const d of hits.length ? [] : deps) {
        const found: string[] = [];
        seen = 0;
        const inDep = async (at: string, depth: number): Promise<void> => {
          if (depth > 8 || found.length >= 20 || seen > 4_000) return;
          try {
            for await (const e of Deno.readDir(at)) {
              if (found.length >= 20 || ++seen > 4_000) return;
              if (e.isSymlink) continue;
              const p = join(at, e.name);
              if (e.isDirectory) {
                if (!SKIP.has(e.name) && !e.name.startsWith(".")) {
                  await inDep(p, depth + 1);
                }
              } else if (e.name === name) {
                found.push(join(d.rel, relative(d.real, p)));
              }
            }
          } catch { /* unreadable — skip it */ }
        };
        await inDep(d.real, 0);
        hits.push(...found);
      }
      near.push(...hits.sort((a, b) => score(b) - score(a)).slice(0, 5));
    }
  }
  return near;
}

/* ── per-conversation file state: freshness and undo ──────────────────────── */

type FileMark = { mtime: number; size: number };

/** What each conversation last saw of each file — read or written by it. The
 *  basis of "read before you overwrite" and "it changed since you read it". */
const SEEN = new Map<string, Map<string, FileMark>>();
/** The last turn's originals: path → content before the turn first changed
 *  it (`null` = the turn created it; `false` = too big to keep). */
const UNDO = new Map<string, Map<string, string | null | false>>();

/** When each of a conversation's foreground commands ran, and what it was — so
 *  "it changed since you read it" can say WHO changed it. Newest last, capped. */
const SH_RUNS = new Map<
  string,
  { start: number; end: number; cmd: string }[]
>();
const MAX_SH_RUNS = 64;

/** The command of this conversation that was running when a file got the
 *  modification time `mtime` — a foreground run or a background job — or
 *  `null` when none was. A second of slack either side: filesystems round
 *  timestamps, and a child can still be flushing as the shell returns. */
function commandAt(key: string, mtime: number): string | null {
  const SLACK = 1_000;
  const runs = [...(SH_RUNS.get(key) ?? [])];
  for (const j of JOBS.get(dirName(key))?.values() ?? []) {
    runs.push({
      start: j.started,
      end: j.code === undefined
        ? Number.POSITIVE_INFINITY
        : j.ended ?? j.started,
      cmd: j.cmd,
    });
  }
  const hit = runs
    .filter((r) => mtime >= r.start - SLACK && mtime <= r.end + SLACK)
    .sort((a, b) => b.start - a.start)[0];
  return hit ? hit.cmd : null;
}

const markOf = async (path: string): Promise<FileMark | null> => {
  try {
    const s = await Deno.stat(path);
    return { mtime: s.mtime?.getTime() ?? 0, size: s.size };
  } catch {
    return null;
  }
};

async function remember(key: string | undefined, path: string): Promise<void> {
  if (!key) return;
  const mark = await markOf(path);
  if (!mark) return;
  if (!SEEN.has(key)) SEEN.set(key, new Map());
  SEEN.get(key)!.set(path, mark);
}

/**
 * May this conversation change `path`, which exists? It must have read it —
 * and the file must still be what it read.
 *
 * The first rule is what stops a model overwriting a file it has never seen
 * with what it imagines is in it. The second catches the file the user, a
 * formatter or an earlier `sh` changed since the read: an edit computed
 * against the old content lands on the new one, and whatever changed is lost.
 */
async function mayChange(
  key: string | undefined,
  path: string,
  shown: string,
  tool: "write" | "edit",
): Promise<void> {
  if (!key) return;
  const now = await markOf(path);
  if (!now) return; // does not exist — creating is always allowed
  const seen = SEEN.get(key)?.get(path);
  if (!seen) {
    if (tool === "write") {
      // Most often a file the model's own scaffold command just made — said
      // so, because "you have not read it" about a file it knows it created
      // reads as the harness being wrong.
      const by = commandAt(key, now.mtime);
      throw new Error(
        `${shown} already exists and you have not read it` +
          (by === null
            ? ""
            : ` — your own command created it: \`${
              clip(by.replace(/\s+/g, " "), 120)
            }\``) +
          `. Read it first (then prefer edit for changes), so nothing in it is` +
          ` lost.`,
      );
    }
    return; // edit proves what it knows by matching old_string exactly
  }
  if (seen.mtime !== now.mtime || seen.size !== now.size) {
    // Who did it decides what the model does next. Told only "it changed", a
    // live session decided "the user updated files on disk, I have been
    // reading stale versions" and re-read eight files over fifty seconds —
    // when the change was its own `cp` from a minute before.
    const by = commandAt(key, now.mtime);
    throw new Error(
      `${shown} changed on disk since you last read it` +
        (by === null
          ? ` — not while any command of yours was running, so the user or` +
            ` another program changed it.`
          : ` — your own command changed it: \`${
            clip(by.replace(/\s+/g, " "), 160)
          }\`. Nothing else is implied: other files you read are as you saw` +
            ` them unless that command touched them too.`) +
        ` Read ${shown} again before changing it.`,
    );
  }
}

/** Keep a file's content before this turn first changes it. */
async function keepOriginal(key: string | undefined, path: string) {
  if (!key) return;
  if (!UNDO.has(key)) UNDO.set(key, new Map());
  const kept = UNDO.get(key)!;
  if (kept.has(path)) return; // the turn's FIRST version is the original
  let total = 0;
  for (const v of kept.values()) if (typeof v === "string") total += v.length;
  try {
    const s = await Deno.stat(path);
    if (s.size > MAX_UNDO_FILE || total + s.size > MAX_UNDO_TOTAL) {
      kept.set(path, false);
      return;
    }
    kept.set(path, await Deno.readTextFile(path));
  } catch {
    kept.set(path, null); // did not exist: undo means delete
  }
}

/** A new turn: the previous turn's originals are no longer the undo. */
export function beginUndo(key: string): void {
  UNDO.delete(key);
}

/** How many files the last turn changed through edit/write. */
export const changedCount = (key: string): number => UNDO.get(key)?.size ?? 0;

/**
 * Put back every file the last turn changed through edit/write: rewrite the
 * originals, delete the files it created. Changes made through `sh` are not
 * covered — the report says so, because an undo that silently misses some of
 * the damage is worse than one that names its limits.
 */
export async function undoChanges(key: string): Promise<string> {
  const kept = UNDO.get(key);
  if (!kept?.size) return "Nothing to undo.";
  let restored = 0;
  let removed = 0;
  const lost: string[] = [];
  for (const [path, original] of kept) {
    try {
      if (original === false) lost.push(basename(path));
      else if (original === null) {
        const s = await Deno.lstat(path).catch(() => null);
        if (s?.isFile) {
          await Deno.remove(path);
          removed++;
        }
      } else {
        await Deno.writeTextFile(path, original);
        restored++;
      }
    } catch {
      lost.push(basename(path));
    }
    SEEN.get(key)?.delete(path);
  }
  UNDO.delete(key);
  log.info("local", "turn undone", { restored, removed, lost: lost.length });
  const parts = [
    restored ? `restored ${restored} file${restored === 1 ? "" : "s"}` : "",
    removed ? `removed ${removed} new file${removed === 1 ? "" : "s"}` : "",
    lost.length ? `could not restore ${lost.join(", ")}` : "",
  ].filter(Boolean);
  return `Undid the last turn's file changes: ${parts.join("; ")}.` +
    ` Changes made by shell commands are not undone.`;
}

/**
 * The whole text of tool results whose stored copy was folded — what the model
 * is still sent. Held in this process only: the saved chat stays small, and
 * after a restart a folded row goes back to being a stub.
 */
const FULL = new Map<string, Map<string, string>>();

/** Hold the whole text of a folded row. */
export function keepFull(key: string, row: string, text: string): void {
  if (!FULL.has(key)) FULL.set(key, new Map());
  FULL.get(key)!.set(row, text);
}

/** The whole text of a folded row, while it is held. */
export function fullText(key: string, row: string): string | undefined {
  return FULL.get(key)?.get(row);
}

/** Let go of rows the model no longer sees — stubbed or evicted by packing,
 *  or gone from the transcript. `keep`: the ids still in it. */
export function dropFull(
  key: string,
  gone: Iterable<string>,
  keep?: ReadonlySet<string>,
): void {
  const held = FULL.get(key);
  if (!held) return;
  for (const id of gone) held.delete(id);
  if (keep) {
    for (const id of [...held.keys()]) if (!keep.has(id)) held.delete(id);
  }
  if (held.size === 0) FULL.delete(key);
}

/** Forget a conversation's file state — Clear and removal both call this.
 *  Its background jobs stop and its temp goes with it. */
export function forgetFiles(key: string): void {
  SEEN.delete(key);
  WENT_OUTSIDE.delete(key);
  FULL.delete(key);
  SH_RUNS.delete(key);
  UNDO.delete(key);
  stopJobs(key);
  void dropConvDirs(key);
}

/* ── the tools themselves ─────────────────────────────────────────────────── */

/** What an executor gets besides its arguments. */
type Ctx = {
  cwd: string;
  signal?: AbortSignal;
  /** The conversation — file state is kept per conversation. */
  key?: string;
  /** Characters the result may take (from the window). */
  budget: number;
  permission: LocalPermission;
  /** Sandboxed commands may use the network (the conversation's setting). */
  net: boolean;
  /** The user approved THIS command to run outside the sandbox. */
  outside: boolean;
  /** What `history` searches besides the saved files — see `Recall`. */
  recall?: Recall;
};

async function ls(args: Record<string, unknown>, c: Ctx) {
  const dir = await inside(
    c.cwd,
    str(args.path),
    true,
    convTmpPath(c.key ?? "default"),
  );
  // Said the way read and grep say it. test15 listed `dep/aio/docs` from the
  // folder above the app and was answered with a raw `readdir` error.
  const info = await Deno.stat(dir).catch(() => null);
  if (!info) {
    const root = await Deno.realPath(c.cwd);
    const shown = str(args.path) || ".";
    throw new Error(`Not found: ${shown}.${await suggest(dir, root)}`);
  }
  if (!info.isDirectory) {
    throw new Error(`${str(args.path)} is a file — use read to open it.`);
  }
  const out: string[] = [];
  let more = 0;
  for await (const e of Deno.readDir(dir)) {
    if (out.length >= MAX_LS_ENTRIES) {
      more++;
      continue;
    }
    // A symlink to a directory is a directory to whoever has to walk it. The
    // trailing slash is the only thing in this listing that says "you can `ls`
    // this" — without it `dep/aio`, the framework, read as a file, and the next
    // move was a `read` that answered "is a directory — use ls".
    const isDir = e.isDirectory ||
      (e.isSymlink &&
        await Deno.stat(join(dir, e.name)).then(
          (s) => s.isDirectory,
          () => false,
        ));
    out.push(isDir ? e.name + "/" : e.name);
  }
  out.sort((a, b) =>
    Number(b.endsWith("/")) - Number(a.endsWith("/")) || a.localeCompare(b)
  );
  return (out.join("\n") || "(empty)") +
    (more ? `\n…${more} more entries` : "");
}

/** Glob — a name-pattern search over the tree, for the question `ls` answers
 *  badly ("where are the test files?"). A bounded directory walk rather than a
 *  glob library: the SKIP set keeps it out of the expensive directories, and
 *  a model-supplied pattern is one more input never trusted to run unbounded. */
const MAX_GLOB_HITS = 300;

async function glob(args: Record<string, unknown>, c: Ctx) {
  let pattern = str(args.pattern);
  if (!pattern) throw new Error("No pattern given.");
  const root = await Deno.realPath(c.cwd);
  let base = await inside(
    c.cwd,
    str(args.path),
    true,
    convTmpPath(c.key ?? "default"),
  );
  // A pattern given as an absolute path inside the project is the same
  // question asked relative to it.
  if (pattern.startsWith(root + "/")) pattern = pattern.slice(root.length + 1);
  const re = globRegex(pattern);
  const out: string[] = [];
  const skip = await walkSkip(root);
  // A pattern whose leading segments are plain names says where to start, and
  // starting there is the only way one can reach through the project's own
  // dependency link: the walk below does not cross a symlink, and should not —
  // `**/*.ts` from the project root is a question about this project, not about
  // the forty thousand lines of framework behind `dep/aio`. Asked directly
  // (`dep/aio/docs/**/*.md`), that same tree is exactly what was wanted, and
  // answering "No files matched" for documentation that is plainly there sends
  // a model off to guess the API instead. Measured: one live session did.
  let seed = "";
  let shown = str(args.path);
  if (!shown) {
    const segs = pattern.split("/");
    const wild = segs.findIndex((s) => /[*?{[]/.test(s));
    const lit = (wild === -1 ? segs.slice(0, -1) : segs.slice(0, wild))
      .join("/");
    if (lit) {
      // Through `inside`, so this reaches a dependency and nothing else.
      const at = await inside(c.cwd, lit, true, convTmpPath(c.key ?? "default"))
        .catch(() => "");
      const dir = at !== "" &&
        await Deno.stat(at).then((s) => s.isDirectory, () => false);
      if (dir) {
        base = at;
        seed = lit;
        shown = lit;
      }
    }
  }
  const spell = spellFrom(root, base, shown);

  const enter = (r: string): boolean => {
    if (re.fixed.length === 0) return true;
    const segs = r ? r.split("/") : [];
    if (segs.length > re.fixed.length) return true;
    return re.fixed[segs.length - 1].test(segs[segs.length - 1]);
  };

  async function walk(dir: string, r: string): Promise<void> {
    if (out.length >= MAX_GLOB_HITS) return;
    for await (const e of Deno.readDir(dir)) {
      if (out.length >= MAX_GLOB_HITS) return;
      if (c.signal?.aborted) throw new Error("Stopped.");
      if (e.isSymlink) continue; // a symlink can point anywhere
      const sub = r ? `${r}/${e.name}` : e.name;
      if (e.isDirectory) {
        if (!skip(e.name) && enter(sub)) await walk(join(dir, e.name), sub);
      } else if (re.file.test(sub)) {
        out.push(spell(join(dir, e.name)));
      }
    }
  }

  await walk(base, seed);
  return out.length
    ? out.sort().join("\n") +
      (out.length >= MAX_GLOB_HITS ? "\n…more matches elided" : "")
    : "No files matched." + (shown ? "" : await depHint(root));
}

/** Compile a glob pattern to the regexes and fixed prefix a tree walk needs.
 *  `**` spans separators, `*` stops at them, `?` is one character, `{a,b}` is
 *  either — the dialect every model writes. */
function globRegex(pattern: string): { file: RegExp; fixed: RegExp[] } {
  let file = "";
  let fixed: RegExp[] = [];
  let wild = false;
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "*" || ch === "?" || ch === "{") {
      if (!wild) fixed = fixedLiteral(pattern.slice(0, i));
      wild = true;
    }
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        while (pattern[i + 1] === "*") i++;
        if (pattern[i + 1] === "/") i++;
        file += "(?:.*/)?";
        // `**` at the very end means everything below.
        if (i === pattern.length - 1) file += ".*";
      } else {
        file += "[^/]*";
      }
    } else if (ch === "?") {
      file += "[^/]";
    } else if (ch === "{") {
      const close = pattern.indexOf("}", i);
      if (close === -1) {
        file += "\\{";
        continue;
      }
      const alts = pattern.slice(i + 1, close).split(",").map((a) =>
        a.replace(/[\\^$.|+()[\]{}*?]/g, "\\$&")
      );
      file += `(?:${alts.join("|")})`;
      i = close;
    } else if ("\\^$.|+()[]}".includes(ch)) {
      file += "\\" + ch;
    } else {
      file += ch;
    }
  }
  if (!wild) fixed = fixedLiteral(pattern);
  // A bare name pattern (`*.ts`, no slash) matches at any depth — what
  // everybody means by it, and what every other tool does.
  const anywhere = !pattern.includes("/") ? "(?:.*/)?" : "";
  return {
    file: new RegExp(`^${anywhere}${file}$`),
    fixed: anywhere ? [] : fixed,
  };
}

/** The literal segments a walk may prune on. */
function fixedLiteral(head: string): RegExp[] {
  const segs = head.split("/").filter((s) => s !== "");
  // The last segment may be half a name (`src/comp` + `*`): not a directory.
  if (!head.endsWith("/")) segs.pop();
  return segs.map((s) =>
    new RegExp("^" + s.replace(/[\\^$.|+()[\]{}]/g, "\\$&") + "$")
  );
}

async function read(
  args: Record<string, unknown>,
  c: Ctx,
): Promise<string> {
  const shown = str(args.path);
  if (!shown) throw new Error("No path given.");
  const root = await Deno.realPath(c.cwd);
  const path = await inside(
    c.cwd,
    shown,
    true,
    convTmpPath(c.key ?? "default"),
  );
  const info = await Deno.stat(path).catch(() => null);
  if (!info) {
    const near = await nearPaths(path, root);
    const only = near.length === 1 ? near[0] : "";
    // One file of the very name asked for, in another folder: a mistyped
    // path, and reading it is the whole fix. A hint is not — a live session
    // asked for `pomo/src/App.tsx` five times running, was told "Did you mean:
    // pomodoro/src/App.tsx?" five times, and lost its turn to the loop guard.
    if (
      only && !only.endsWith("/") && args.resolved !== true &&
      basename(only).toLowerCase() === basename(path).toLowerCase()
    ) {
      const body = await read({ ...args, path: only, resolved: true }, c)
        .catch(() => null);
      if (body !== null) {
        return `(${shown} does not exist — this is ${only}, the only file of` +
          ` that name nearby. Use ${only} from now on.)\n${body}`;
      }
    }
    throw new Error(
      `File not found: ${shown}.${
        near.length ? ` Did you mean: ${near.join(", ")}?` : ""
      }`,
    );
  }
  if (info.isDirectory) {
    throw new Error(`${shown} is a directory — use ls to list it.`);
  }
  const { text, truncated, binary } = await readCapped(path);
  if (binary) {
    return `${shown} is a binary file (${info.size} bytes) — not shown.`;
  }
  await remember(c.key, path);
  const lines = text.split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  // 1-based, like every harness a model learned from: offset is the first
  // line shown. Zero is read as one — the same line either way.
  const first = Math.max(1, Math.floor(num(args.offset, 1)));
  const want = Math.min(
    MAX_READ_LINES,
    Math.max(1, Math.floor(num(args.limit, MAX_READ_LINES))),
  );
  if (first > lines.length && lines.length > 0) {
    return `${shown} has ${lines.length} lines; offset ${first} is past the` +
      ` end.`;
  }
  // Fill the window's budget line by line, so the result is always whole
  // lines with a precise place to continue from — never a clip mark in the
  // middle of the code the model is about to edit.
  const out: string[] = [];
  let used = 0;
  let last = first - 1;
  for (let n = first; n <= Math.min(lines.length, first + want - 1); n++) {
    let line = lines[n - 1];
    if (line.length > MAX_LINE_CHARS) {
      line = line.slice(0, MAX_LINE_CHARS) + " …[line truncated]";
    }
    const row = `${n}\t${line}`;
    if (used + row.length + 1 > c.budget - 200 && out.length > 0) break;
    out.push(row);
    used += row.length + 1;
    last = n;
  }
  const total = lines.length;
  const tail = last < total
    ? `\n(Showing lines ${first}-${last} of ${total}${
      truncated ? "+" : ""
    }. Use offset=${last + 1} to continue.)`
    : truncated
    ? `\n(File continues past the ${MAX_FILE_BYTES}-byte read window.)`
    : first > 1
    ? `\n(End of file — ${total} lines.)`
    : "";
  return (out.join("\n") || "(empty file)") + tail;
}

async function grep(args: Record<string, unknown>, c: Ctx) {
  const root = await Deno.realPath(c.cwd);
  const start = await inside(
    c.cwd,
    str(args.path),
    true,
    convTmpPath(c.key ?? "default"),
  );
  if (!safePattern(str(args.pattern))) {
    return "Error: that pattern is too complex to run safely — " +
      "use simpler syntax or literal text.";
  }
  const include = str(args.include).trim();
  const only = include ? globRegex(include.replace(/^\*\*\//, "")).file : null;
  const skip = await walkSkip(root);
  const spell = spellFrom(root, start, str(args.path));
  // Collect the candidate lines (bounded IO), then hand the actual matching to
  // a worker under a deadline: a regex cannot be interrupted on its own thread,
  // so the only real bound is a disposable worker the parent can terminate.
  const docs: { path: string; lines: string[] }[] = [];
  let scanned = 0;
  let totalBytes = 0;
  let budgetHit = false;
  const collect = async (path: string): Promise<void> => {
    if (c.signal?.aborted) throw new Error("Stopped.");
    if (scanned >= MAX_GREP_FILES || totalBytes >= MAX_GREP_TOTAL_BYTES) return;
    const r = spell(path);
    if (only && !only.test(relative(start, path) || basename(path))) return;
    scanned++;
    try {
      const got = await readCapped(path);
      if (got.binary) return;
      totalBytes += got.text.length;
      if (totalBytes >= MAX_GREP_TOTAL_BYTES) budgetHit = true;
      docs.push({ path: r, lines: got.text.split("\n") });
    } catch { /* unreadable — not what grep is for */ }
  };
  async function walk(dir: string): Promise<void> {
    for await (const e of Deno.readDir(dir)) {
      if (scanned >= MAX_GREP_FILES || totalBytes >= MAX_GREP_TOTAL_BYTES) {
        return;
      }
      if (c.signal?.aborted) throw new Error("Stopped.");
      if (e.isSymlink) continue; // a symlink can point anywhere
      const p = join(dir, e.name);
      if (e.isDirectory) {
        if (!skip(e.name)) await walk(p);
      } else if (e.isFile) {
        await collect(p);
      }
    }
  }
  // Said the way read says it: the path as the model spelled it, and where
  // the file might be. The raw `stat` error named the resolved host path
  // behind a dependency link, with no hint — a live session tried the same
  // wrong path twice in one reply.
  const info = await Deno.stat(start).catch(() => null);
  if (!info) {
    const shown = str(args.path) || ".";
    throw new Error(`Not found: ${shown}.${await suggest(start, root)}`);
  }
  if (info.isFile) await collect(start);
  else await walk(start);

  const result = await matchInWorker(str(args.pattern), docs, c.signal);
  if (result === "timeout") {
    return "Error: that search took too long and was stopped — " +
      "use simpler syntax or a narrower path.";
  }
  if (result === "stopped") return "Stopped.";
  if (result === "failed") {
    return "Error: the search could not run — try again or use literal text.";
  }
  if (result === null) return "Error: that is not a valid regular expression.";
  const shaped = shapeHits(result, c.budget);
  // One line about what is missing, not three: every reason it could be
  // incomplete, said once, with the one thing to do about it.
  const why = [
    shaped.left > 0
      ? `${shaped.left} more hit${shaped.left === 1 ? "" : "s"} did not fit`
      : "",
    result.length >= MAX_GREP_HITS
      ? `the search stopped at ${MAX_GREP_HITS} hits`
      : "",
    budgetHit ? "the search stopped at its size budget" : "",
    scanned >= MAX_GREP_FILES
      ? `the search stopped after ${MAX_GREP_FILES} files`
      : "",
  ].filter(Boolean);
  const note = why.length
    ? `\n…${why.join("; ")} — narrow the pattern, the path or include`
    : "";
  if (result.length === 0) {
    // Nothing here, and the project may keep the answer in a dependency this
    // walk deliberately did not enter.
    return "No matches." + note + (str(args.path) ? "" : await depHint(root));
  }
  return shaped.text + note;
}

/**
 * Hits, grouped under the file they are in, and stopped at the budget.
 *
 * A flat `path:line: text` per hit pays for the path again on every line — the
 * same thirty characters, a hundred times — and the clip that came afterwards
 * then threw away the middle of the list without saying it had. Grouped, the
 * file is named once, and what did not fit is counted in the answer instead of
 * disappearing from it.
 */
function shapeHits(
  lines: string[],
  budget: number,
): { text: string; left: number } {
  const groups = new Map<string, string[]>();
  for (const line of lines) {
    const cut = line.indexOf(":");
    const file = cut < 0 ? "(unknown)" : line.slice(0, cut);
    const rest = cut < 0 ? line : line.slice(cut + 1);
    const had = groups.get(file);
    if (had) had.push(rest);
    else groups.set(file, [rest]);
  }
  // Room for the notes the caller adds after this.
  const room = Math.max(budget - 300, 400);
  const out: string[] = [];
  let used = 0;
  let shown = 0;
  let full = false;
  for (const [file, hits] of groups) {
    if (used + file.length + 2 > room) break;
    out.push(`${file}:`);
    used += file.length + 2;
    for (const hit of hits) {
      if (used + hit.length + 3 > room) {
        full = true;
        break;
      }
      out.push(`  ${hit}`);
      used += hit.length + 3;
      shown++;
    }
    if (full) break;
  }
  return { text: out.join("\n"), left: lines.length - shown };
}

/**
 * Run the pattern over the collected docs in a worker, bounded by a deadline
 * and by the turn's Stop. The worker is always terminated — on success,
 * timeout or abort — so a pathological match cannot outlive this call. A
 * dedicated worker rather than aio's `blocking()` pool: the whole point is
 * `terminate()`, and a wedged *pooled* worker could not be reclaimed.
 */
function matchInWorker(
  pattern: string,
  docs: { path: string; lines: string[] }[],
  signal?: AbortSignal,
): Promise<string[] | "timeout" | "stopped" | "failed" | null> {
  return new Promise((resolve) => {
    const worker = new Worker(
      new URL("./grep-worker.ts", import.meta.url).href,
      { type: "module" },
    );
    let settled = false;
    const done = (
      v: string[] | "timeout" | "stopped" | "failed" | null,
    ) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      worker.terminate();
      resolve(v);
    };
    const timer = setTimeout(() => done("timeout"), GREP_DEADLINE_MS());
    const onAbort = () => done("stopped");
    if (signal?.aborted) return done("stopped");
    signal?.addEventListener("abort", onAbort, { once: true });
    worker.onmessage = (e: MessageEvent) => {
      done(e.data?.ok ? e.data.hits as string[] : null);
    };
    worker.onerror = (ev: Event) => {
      log.error("local", "grep worker failed to run", {
        error: (ev as ErrorEvent).message ?? String(ev),
      });
      done("failed");
    };
    worker.postMessage({
      pattern,
      docs,
      maxHits: MAX_GREP_HITS,
      lineScan: MAX_LINE_SCAN,
    });
  });
}

/** A path the model may write through: inside the project, and not a
 *  symlink — `inside` realpaths the deepest *existing* ancestor, so a dangling
 *  symlink as the final component would survive it and be followed out. */
async function writable(c: Ctx, shown: string): Promise<string> {
  const path = await inside(c.cwd, shown);
  const lst = await Deno.lstat(path).catch(() => null);
  if (lst?.isSymlink) {
    throw new Error(`Refusing to write through a symlink: ${shown}`);
  }
  if (lst?.isDirectory) throw new Error(`${shown} is a directory.`);
  return path;
}

/**
 * Refuse a change that carries one of this app's shortening notes — text the
 * model copied from a shortened view instead of writing out. A file that
 * already holds that exact text (a transcript, a fixture) may keep it.
 */
async function noCopiedNote(
  text: string,
  existing: string | null,
  field: string,
  known?: string,
): Promise<void> {
  const note = harnessNoteIn(text);
  if (note === null) return;
  const had = known ??
    (existing ? await Deno.readTextFile(existing).catch(() => "") : "");
  if (had.includes(note)) return;
  throw new Error(
    `Not written: ${field} contains "${
      clip(note, 90)
    }" — a note this app puts` +
      ` in SHORTENED copies of earlier output, so what you sent is a copy of a` +
      ` shortened view, not the real text. Nothing was changed. Write the` +
      ` whole content out (read the source again if you need it).`,
  );
}

async function write(args: Record<string, unknown>, c: Ctx) {
  const shown = str(args.path);
  if (!shown) throw new Error("No path given.");
  const path = await writable(c, shown);
  await mayChange(c.key, path, shown, "write");
  // Content sent as an object is a JSON file written by a model that forgot
  // to stringify it — writing "" instead would empty the file.
  const content = typeof args.content === "string"
    ? args.content
    : args.content === undefined
    ? ""
    : JSON.stringify(args.content, null, 2);
  const existed = (await markOf(path)) !== null;
  await noCopiedNote(content, existed ? path : null, "content");
  await keepOriginal(c.key, path);
  await Deno.mkdir(dirname(path), { recursive: true });
  await Deno.writeTextFile(path, content);
  await remember(c.key, path);
  const lines = content.split("\n").length;
  return `${existed ? "Overwrote" : "Created"} ${shown} (${lines} line${
    lines === 1 ? "" : "s"
  }).`;
}

/**
 * Edit — replace text in a file. The small-change tool, and the one a model
 * should reach for first. The matching is `lib/replace.ts`: exact first, then
 * readings that forgive the ways small models copy badly (indentation,
 * trailing spaces, quotes, escapes) — but always exactly one place, unless
 * `replace_all` says every place. The report shows the changed lines, so the
 * model can see its edit landed without spending a round re-reading.
 */
async function edit(args: Record<string, unknown>, c: Ctx) {
  const shown = str(args.path);
  if (!shown) throw new Error("No path given.");
  const path = await writable(c, shown);
  const oldStr = str(args.old_string);
  const newStr = str(args.new_string);
  const exists = (await markOf(path)) !== null;
  if (!exists) {
    // An empty old_string on a missing file is "create it" in the harnesses
    // models learned from.
    if (oldStr === "") {
      return await write({ path: shown, content: newStr }, c);
    }
    const root = await Deno.realPath(c.cwd);
    throw new Error(`File not found: ${shown}.${await suggest(path, root)}`);
  }
  await mayChange(c.key, path, shown, "edit");
  const before = await Deno.readTextFile(path);
  await noCopiedNote(newStr, null, "new_string", before);
  const done = replaceIn(before, oldStr, newStr, args.replace_all === true);
  if (!done.ok) {
    // An old_string written from memory of a file never read is a guess, and
    // the fix is the read, not another guess — a live session guessed a line
    // of a scaffolded app.ts it had never opened.
    const unread = c.key !== undefined && !SEEN.get(c.key)?.has(path);
    throw new Error(
      done.error +
        (unread
          ? ` You have not read ${shown} in this conversation: read it, then` +
            ` copy old_string from what it shows.`
          : ""),
    );
  }
  await keepOriginal(c.key, path);
  await Deno.writeTextFile(path, done.content);
  await remember(c.key, path);
  const note = done.strategy === "exact"
    ? ""
    : ` (matched ignoring ${done.strategy} — check the result)`;
  const count = done.count > 1 ? ` in ${done.count} places` : "";
  const span = newStr.replace(/\r\n/g, "\n").split("\n").length;
  return `Edited ${shown}${count}${note}. Now:\n` +
    snippet(done.content, done.line, span);
}

/** The model's plan. Validated here; the conversation's copy is kept by the
 *  cell (it renders it, persists it and re-sends it), so this only has to
 *  say what it understood. */
function todo(args: Record<string, unknown>) {
  const items = parseTodos(args.items);
  if (!items.length) return "Task list cleared.";
  const done = items.filter((t) => t.status === "completed").length;
  const doing = items.filter((t) => t.status === "in_progress").length;
  return `Task list updated: ${items.length} items, ${done} done.` +
    (doing > 1
      ? " More than one is in_progress — finish one step before starting" +
        " the next."
      : "");
}

/* ── the sandbox ──────────────────────────────────────────────────────────── */

/** Environment variables that look like credentials. A command the user did
 *  not see must not be able to `env` a token into a transcript — least of all
 *  one headed to a cloud model. */
const SECRET_ENV =
  /KEY|TOKEN|SECRET|PASSW|CREDENTIAL|AUTH|COOKIE|SESSION|PRIVATE|^AWS_|^AZURE_|^GCP_|^GOOGLE_APPLICATION|^GH_|^GITHUB_|^NPM_|^HF_|^ANTHROPIC|^OPENAI|^CLAUDE/i;

export function scrubbedEnv(
  env: Record<string, string> = Deno.env.toObject(),
): Record<string, string> {
  const out = Object.fromEntries(
    Object.entries(env).filter(([k]) => !SECRET_ENV.test(k)),
  );
  // This app's own package binaries are not the project's: started from its
  // repo by a task runner, cc had `…/cc/node_modules/.bin` first on PATH, and
  // a live session's `which electron` answered with cc's own Electron. A
  // project's runner puts its own `.bin` back when it runs a script.
  if (out.PATH !== undefined) {
    out.PATH = out.PATH.split(":")
      .filter((d) => d !== "" && !/\/node_modules\/\.bin\/?$/.test(d))
      .join(":");
  }
  return out;
}

/** Directories under $HOME a sandboxed command may not see at all, and files
 *  it may not read: credential stores, browser profiles, shell histories, and
 *  this app's own data (the transcripts of every other conversation). */
const HIDDEN_DIRS = [
  ".ssh",
  ".gnupg",
  ".aws",
  ".azure",
  ".kube",
  ".docker",
  ".password-store",
  ".mozilla",
  ".claude",
  ".claude-control",
  ".config/gcloud",
  ".config/gh",
  ".config/google-chrome",
  ".config/chromium",
  ".config/BraveSoftware",
  ".local/share/keyrings",
  ".pki",
  ".thunderbird",
  ".var",
  ".config/op",
  ".config/Slack",
  ".config/discord",
  ".config/Signal",
];
const HIDDEN_FILES = [
  // The keys to the user's own screen: with these a command inside the box
  // could open a window on the real display, read the clipboard, or watch
  // what is typed — the one wall the box is most obviously supposed to be.
  ".Xauthority",
  ".ICEauthority",
  ".netrc",
  ".git-credentials",
  // The file, not the folder: hiding all of `.config/git` would take the
  // user's own name and email with it, and a commit made in the box would
  // then be signed by nobody.
  ".config/git/credentials",
  ".npmrc",
  ".pypirc",
  ".bash_history",
  ".zsh_history",
  ".python_history",
];
/** Caches a build or test legitimately writes — regenerable by definition, so
 *  letting a sandboxed command write them costs nothing worth protecting.
 *  Download caches only: directories holding tools the user RUNS (`~/.deno/
 *  bin`, `~/.rustup`, `~/.cargo/bin`) stay read-only, or an unattended
 *  command could replace the compiler every other project uses. */
const CACHE_DIRS = [
  ".cache",
  ".npm",
  ".bun/install/cache",
  ".cargo/registry",
  ".cargo/git",
  "go/pkg/mod",
  ".m2/repository",
  ".local/share/pnpm",
];

let BWRAP: Promise<boolean> | null = null;

/** Whether bubblewrap is installed AND works here — unprivileged user
 *  namespaces can be switched off, and then it is installed and useless.
 *  Asked once per process. */
export function sandboxAvailable(): Promise<boolean> {
  if (Deno.build.os !== "linux") return Promise.resolve(false);
  BWRAP ??= new Deno.Command("bwrap", {
    args: [
      "--ro-bind",
      "/",
      "/",
      "--dev",
      "/dev",
      "--unshare-pid",
      "--unshare-net",
      "true",
    ],
    stdin: "null",
    stdout: "null",
    stderr: "null",
    signal: AbortSignal.timeout(5_000),
  }).output().then((o) => o.success).catch(() => false);
  return BWRAP;
}

/* ── the agent account ────────────────────────────────────────────────────── */

/** Run a short helper; never throws. */
async function quiet(
  cmd: string,
  args: string[],
  timeoutMs = 10_000,
): Promise<{ ok: boolean; out: string }> {
  try {
    const o = await new Deno.Command(cmd, {
      args,
      stdin: "null",
      stdout: "piped",
      stderr: "null",
      signal: AbortSignal.timeout(timeoutMs),
    }).output();
    return { ok: o.success, out: new TextDecoder().decode(o.stdout) };
  } catch {
    return { ok: false, out: "" };
  }
}

let ACCOUNT: { at: number; got: Promise<Account | null> } | null = null;
/** Looked up again after this long: setting the account up (or taking it
 *  down) must not need an app restart. */
const ACCOUNT_TTL_MS = 30_000;

/**
 * The account commands run as, when the machine has one — `null` otherwise.
 *
 * `CC_AGENT_USER` names it (default `cc-agent`; `off` for none). It counts only
 * when this app may become it without a password, its user manager is up (a
 * scope needs it) and ACLs can be set (the conversation's temp is shared with
 * it). `CC_AGENT_DISPLAY` names its screen; otherwise the one in its own
 * `xauth list`, if an X server is really there.
 */
export function agentAccount(): Promise<Account | null> {
  if (Deno.build.os !== "linux") return Promise.resolve(null);
  if (!ACCOUNT || Date.now() - ACCOUNT.at > ACCOUNT_TTL_MS) {
    ACCOUNT = { at: Date.now(), got: findAccount() };
  }
  return ACCOUNT.got;
}

async function findAccount(): Promise<Account | null> {
  const name = Deno.env.get("CC_AGENT_USER") ?? "cc-agent";
  if (!validAccountName(name)) return null;
  const pw = await quiet("getent", ["passwd", name]);
  const p = pw.ok ? parsePasswd(pw.out) : null;
  if (!p || p.uid === Deno.uid()) return null;
  // One sudo answers the rest: allowed without a password, a user manager to
  // hold scopes, and the screen its own X authority names.
  const probe = await quiet("sudo", [
    "-n",
    "-H",
    "-u",
    name,
    "--",
    "sh",
    "-c",
    `test -S /run/user/${p.uid}/bus && command -v systemd-run >/dev/null &&` +
    // Its own file by name, without locking: an inherited XAUTHORITY would
    // point at this app's user's, and xauth waits 20 s on a lock it may not take.
    ` { xauth -i -f '${p.home}/.Xauthority' list 2>/dev/null; true; }`,
  ]);
  if (!probe.ok || !(await quiet("setfacl", ["--version"])).ok) return null;
  const asked = Deno.env.get("CC_AGENT_DISPLAY");
  let display = asked !== undefined
    ? (/^:\d+$/.test(asked) ? asked : null)
    : displayOfXauth(probe.out);
  // A display nobody serves is worse than none: every GUI start would wait on
  // it and fail with a message that blames the app.
  if (
    display &&
    !await Deno.stat(`/tmp/.X11-unix/X${display.slice(1)}`).then(
      () => true,
      () => false,
    )
  ) display = null;
  return { ...p, display };
}

const ACCOUNT_DIRS = new Map<string, { at: number; ok: Promise<boolean> }>();

/**
 * The account a project's commands run as: the agent account, when there is
 * one and it can write the project — `null` for a project it cannot reach.
 *
 * Where the project lives is the choice, made once by whoever put it there: a
 * project in the account's reach is the agent's to run as itself; the user's
 * own projects (under a home the account cannot enter) keep the old rules.
 * The permission mode only decides who is asked.
 */
export async function projectAccount(cwd: string): Promise<Account | null> {
  const a = await agentAccount();
  if (!a) return null;
  const root = await Deno.realPath(cwd).catch(() => null);
  if (!root) return null;
  const k = `${a.user}\u0000${root}`;
  let hit = ACCOUNT_DIRS.get(k);
  if (!hit || Date.now() - hit.at > ACCOUNT_TTL_MS) {
    hit = { at: Date.now(), ok: reachable(a, root) };
    ACCOUNT_DIRS.set(k, hit);
  }
  return await hit.ok ? a : null;
}

async function reachable(a: Account, root: string): Promise<boolean> {
  // Given to the account on purpose, not merely writable by it: a folder it
  // owns, or one shared with it by name. `/tmp` and every other world-writable
  // folder is writable by everyone, and says nothing about whose project it is.
  const st = await Deno.stat(root).catch(() => null);
  if (!st?.isDirectory) return false;
  const mine = st.uid === a.uid;
  if (!mine) {
    const acl = await quiet("getfacl", ["-cp", root]);
    const named = new RegExp(`^user:(${a.user}|${a.uid}):.w`, "m");
    if (!acl.ok || !named.test(acl.out)) return false;
  }
  const ok = (await quiet("sudo", [
    "-n",
    "-u",
    a.user,
    "--",
    "test",
    "-w",
    root,
    "-a",
    "-x",
    root,
  ])).ok;
  if (!ok) return false;
  // Both sides must keep reaching what the other makes in it: the file tools
  // run as this app's user, commands as the account. On a folder the account
  // owns, it shares it (and all it makes there from now on) with this app's
  // user — best effort, and nothing to do where the setup script already has.
  if (mine) {
    const me = Deno.uid();
    await quiet("sudo", [
      "-n",
      "-u",
      a.user,
      "--",
      "setfacl",
      "-m",
      `u:${me}:rwx,d:u:${me}:rwx,d:u:${a.uid}:rwx`,
      root,
    ]);
  }
  return true;
}

/** `systemctl --user …` as the account. */
function accountCtl(
  a: Account,
  args: string[],
): Promise<{ ok: boolean; out: string }> {
  return quiet("sudo", accountCtlArgv(a, args));
}

/** Is anything still running in the scope? */
async function scopeActive(a: Account, unit: string): Promise<boolean> {
  const r = await accountCtl(a, ["is-active", `${unit}.scope`]);
  return /^(active|activating|deactivating)\b/.test(r.out.trim());
}

let UNITS = 0;

/** Each conversation's temp when it runs as the account: under `/tmp`, where
 *  the account can reach (this app's own temp is in a home it cannot enter),
 *  with a random name, 0700 and an ACL for exactly the account. */
const ACCOUNT_TMP = new Map<string, string>();

async function accountTmp(key: string, a: Account): Promise<string> {
  const k = dirName(key);
  const have = ACCOUNT_TMP.get(k);
  if (have && await Deno.stat(have).then((s) => s.isDirectory, () => false)) {
    return have;
  }
  const p = await Deno.makeTempDir({ prefix: `cc-agent-${k.slice(0, 12)}-` });
  const me = Deno.uid();
  await quiet("setfacl", [
    "-m",
    `u:${a.uid}:rwx,d:u:${a.uid}:rwx,d:u:${me}:rwx`,
    p,
  ]);
  ACCOUNT_TMP.set(k, p);
  return p;
}

/* ── a conversation's own temp ────────────────────────────────────────────── */

/** This app's id — its home is `~/.claude-control` (dep/aio/docs/persistence/
 *  where-files-live.md). */
const APP_ID = "claude-control";

/** Root of every conversation's temp: inside the app's own home, mode 0700 —
 *  never the shared `/tmp`, which every user on the machine can list.
 *
 *  The home is computed by aio's own rule (`AIO_APPS_DIR/<id>`, else
 *  `~/.<id>`) rather than imported: `aio/server` pulls the whole runtime in
 *  with it, and loading that from a cell's server module broke other cells'
 *  actions in the UI harness. `CC_TMP_ROOT` points it elsewhere for tests. */
const tmpRoot = (): string => {
  const override = Deno.env.get("CC_TMP_ROOT");
  if (override) return override;
  const apps = Deno.env.get("AIO_APPS_DIR");
  const home = Deno.env.get("HOME") ?? "/tmp";
  return join(apps ? join(apps, APP_ID) : join(home, `.${APP_ID}`), "tmp");
};

/** A key as a directory name: conversation keys are UUIDs, but nothing from
 *  outside becomes a path without being checked. */
const dirName = (key: string): string =>
  /^[A-Za-z0-9_-]{1,80}$/.test(key) ? key : `k${wireIdOf(key)}`;
const wireIdOf = (key: string): string => {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) {
    h = Math.imul(h ^ key.charCodeAt(i), 16777619);
  }
  return (h >>> 0).toString(36);
};

let SWEPT = false;

/**
 * One conversation's temp: `tmp/` (the sandbox's `/tmp`, and `TMPDIR`
 * outside it) and `run/` (the sandbox's `XDG_RUNTIME_DIR`). Kept for the
 * life of the conversation, so a file made in one command is there in the
 * next — a fresh `/tmp` per command cost one session forty rounds of
 * restarting an app to look at a screenshot it had just taken.
 */
/** Where this conversation's scratch lives, without creating anything — the
 *  read tools ask on every path and must not make directories to answer. */
function convTmpPath(key: string): string {
  return ACCOUNT_TMP.get(dirName(key)) ?? join(tmpRoot(), dirName(key), "tmp");
}

/** What the shell will expand a look's words to, outside the sandbox: the
 *  home directory, the plain variables whose values are no secret, and this
 *  conversation's own scratch — see `mayLeaveUnasked`. */
export function lookEnv(key: string): LookEnv {
  const env = scrubbedEnv();
  const vars = Object.fromEntries(
    ["USER", "LOGNAME", "PWD", "XDG_RUNTIME_DIR", "SHELL", "LANG"]
      .filter((k) => env[k] !== undefined).map((k) => [k, env[k]]),
  );
  return {
    home: Deno.env.get("HOME") ?? "",
    vars: { ...vars, TMPDIR: convTmpPath(key) },
    own: [convTmpPath(key)],
    hidden: [tmpRoot()],
  };
}

async function convDirs(key: string): Promise<{ tmp: string; run: string }> {
  const base = join(tmpRoot(), dirName(key));
  const tmp = join(base, "tmp");
  const run = join(base, "run");
  await Deno.mkdir(tmp, { recursive: true, mode: 0o700 });
  await Deno.mkdir(run, { recursive: true, mode: 0o700 });
  await Deno.chmod(base, 0o700).catch(() => {});
  if (!SWEPT) {
    SWEPT = true;
    void sweepTmp();
    void reapJobs();
  }
  return { tmp, run };
}

/** Temp left by conversations untouched for a week — deleted, closed, or
 *  from an app that crashed before its Clear could. */
async function sweepTmp(): Promise<void> {
  const cutoff = Date.now() - 7 * 86_400_000;
  try {
    for await (const e of Deno.readDir(tmpRoot())) {
      if (!e.isDirectory) continue;
      const p = join(tmpRoot(), e.name);
      const st = await Deno.stat(p).catch(() => null);
      if (st?.mtime && st.mtime.getTime() < cutoff && !JOBS.has(e.name)) {
        await Deno.remove(p, { recursive: true }).catch(() => {});
      }
    }
  } catch { /* no temp yet */ }
}

/** Drop a conversation's temp — Clear and removal. */
async function dropConvDirs(key: string): Promise<void> {
  const p = join(tmpRoot(), dirName(key));
  if (p.startsWith(tmpRoot() + "/")) {
    await Deno.remove(p, { recursive: true }).catch(() => {});
  }
  const shared = ACCOUNT_TMP.get(dirName(key));
  if (shared) {
    ACCOUNT_TMP.delete(dirName(key));
    // What the account made there with a mode of its own may be closed to this
    // app — the account removes the rest.
    await Deno.remove(shared, { recursive: true }).catch(async () => {
      const a = await agentAccount();
      if (a) {
        await quiet("sudo", [
          "-n",
          "-u",
          a.user,
          "--",
          "rm",
          "-rf",
          "--",
          shared,
        ]);
      }
      await Deno.remove(shared, { recursive: true }).catch(() => {});
    });
  }
}

/* ── background jobs ──────────────────────────────────────────────────────── */

type Job = {
  id: number;
  pid: number;
  cmd: string;
  /** Where its output goes, on the host. */
  log: string;
  /** …and how the model names that file (`/tmp/job-1.log` in the sandbox). */
  shown: string;
  started: number;
  /** Set when it exits on its own. */
  code?: number;
  /** …and when that was. */
  ended?: number;
  /** Run as the agent account, in this scope. Signals go through the
   *  account's own manager: this app may not signal its processes. */
  scope?: { account: Account; unit: string };
  /** The exit of its first process, while what that started runs on. */
  first?: number;
};

/** Programs a conversation left running on purpose — a dev server, the app
 *  under test. Per conversation; stopped by `stop-job`, the Stop jobs button,
 *  Clear, removing the project, or the app exiting. */
const JOBS = new Map<string, Map<number, Job>>();
const MAX_JOBS = 4;
/** Output kept per job. A chatty server must not fill the disk. */
const JOB_LOG_BYTES = 8 * 1_048_576;

/** Background programs of a conversation still running. */
export const runningJobs = (key: string): number =>
  [...(JOBS.get(dirName(key))?.values() ?? [])].filter((j) =>
    j.code === undefined
  ).length;

/** A background job nobody stopped. Twelve hours is past the end of any
 *  session it belonged to, and a dev server nobody is watching is only a port
 *  held and a fan spinning. */
const JOB_MAX_MS = 12 * 3_600_000;

function killJob(j: Job): void {
  if (j.scope) {
    const { account, unit } = j.scope;
    void accountCtl(account, ["kill", "--signal=SIGTERM", `${unit}.scope`]);
    // A scope's name is never reused, so the hard kill is always safe.
    setTimeout(() => {
      if (j.code !== undefined) return;
      void accountCtl(account, ["kill", "--signal=SIGKILL", `${unit}.scope`]);
    }, 2_000);
    return;
  }
  try {
    Deno.kill(-j.pid, "SIGTERM");
  } catch { /* already gone */ }
  // SIGKILL only if the polite one was not enough: pids are reused, and a
  // kill aimed at a number that now belongs to someone else is a bug that
  // looks like a mystery.
  setTimeout(() => {
    if (j.code !== undefined) return;
    try {
      Deno.kill(-j.pid, "SIGKILL");
    } catch { /* gone */ }
  }, 2_000);
}

/** Stop one job, or all of a conversation's. */
export function stopJobs(key: string, id?: number): number {
  const jobs = JOBS.get(dirName(key));
  if (!jobs) return 0;
  let n = 0;
  for (const j of jobs.values()) {
    if (id !== undefined && j.id !== id) continue;
    if (j.code === undefined) {
      killJob(j);
      n++;
    }
    jobs.delete(j.id);
  }
  if (jobs.size === 0) JOBS.delete(dirName(key));
  void noteJobs(key);
  releaseExitGuardIfIdle();
  return n;
}

/** Every job of every conversation — the app is going down. */
export function stopAllJobs(): void {
  for (const key of [...JOBS.keys()]) stopJobs(key);
}

/** Jobs that have outstayed `JOB_MAX_MS`, and job notes that no longer
 *  describe anything. Called on the app's own five-minute heartbeat. */
export function sweepJobs(): number {
  let n = 0;
  for (const [k, jobs] of JOBS) {
    for (const j of jobs.values()) {
      if (j.code !== undefined || Date.now() - j.started < JOB_MAX_MS) continue;
      log.warn("local", "background job hit its age limit — stopping it", {
        id: j.id,
        cmd: clip(j.cmd, 80),
      });
      killJob(j);
      jobs.delete(j.id);
      n++;
    }
    if (jobs.size === 0) JOBS.delete(k);
    void noteJobs(k);
  }
  releaseExitGuardIfIdle();
  return n;
}

/* ── jobs across a crash ───────────────────────────────────────────────────
 *
 * A job is the one thing this app can leave behind: it is started on purpose
 * to outlive the command that made it. Stopping them on the way out is the
 * exit guard below; surviving a kill -9 of the app itself is what the notes
 * are for. Each conversation's live jobs are written next to its temp, with
 * the kernel's own start time for every pid — after a reboot that number has
 * been handed to someone else, and a start time that does not match is how we
 * know not to kill them.
 */

type JobNote = {
  pid: number;
  boot: number;
  cmd: string;
  /** An account job: its scope, stopped through the account's manager. */
  unit?: string;
  user?: string;
  uid?: number;
};
type JobFile = { app: { pid: number; boot: number }; jobs: JobNote[] };

/** The kernel's start time for a pid — its identity, as far as reuse goes. */
async function procStart(pid: number): Promise<number | null> {
  const stat = await Deno.readTextFile(`/proc/${pid}/stat`).catch(() => null);
  if (!stat) return null;
  // Fields after the program's own name, which may itself contain spaces.
  const after = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  const v = Number(after[19]);
  return Number.isFinite(v) ? v : null;
}

/** Live (not zombie) processes in a process group. `[]` where there is no
 *  /proc to ask. */
async function groupMembers(pgid: number): Promise<number[]> {
  const found: number[] = [];
  try {
    for await (const e of Deno.readDir("/proc")) {
      if (!/^\d+$/.test(e.name)) continue;
      const stat = await Deno.readTextFile(`/proc/${e.name}/stat`)
        .catch(() => "");
      const f = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      if (f[0] !== "Z" && Number(f[2]) === pgid) found.push(Number(e.name));
    }
  } catch { /* no /proc */ }
  return found;
}

/** A job's first process may be gone while what it started runs on — `am
 *  start`, `docker compose up -d`, `cmd &`. Still running is anything left in
 *  its scope, or in its process group. */
async function jobAlive(j: Job): Promise<boolean> {
  if (j.scope) return await scopeActive(j.scope.account, j.scope.unit);
  return (await groupMembers(j.pid)).length > 0;
}

function endJob(key: string, j: Job, code: number): void {
  if (j.code !== undefined) return;
  j.code = code;
  j.ended = Date.now();
  void noteJobs(key);
  releaseExitGuardIfIdle();
}

/** Watch a job whose first process has exited until the rest has too. */
function followJob(key: string, j: Job): void {
  const tick = async () => {
    if (j.code !== undefined) return;
    if (await jobAlive(j)) setTimeout(tick, 3_000);
    else endJob(key, j, j.first ?? 0);
  };
  setTimeout(tick, 3_000);
}

let APP_BOOT: number | null = null;

/** Write down (or erase) what this conversation has running. */
async function noteJobs(key: string): Promise<void> {
  const file = join(tmpRoot(), dirName(key), "run", "jobs.json");
  const live = [...(JOBS.get(dirName(key))?.values() ?? [])].filter((j) =>
    j.code === undefined
  );
  if (live.length === 0) {
    await Deno.remove(file).catch(() => {});
    return;
  }
  APP_BOOT ??= await procStart(Deno.pid);
  const out: JobFile = {
    app: { pid: Deno.pid, boot: APP_BOOT ?? 0 },
    jobs: await Promise.all(live.map(async (j): Promise<JobNote> => {
      if (j.scope) {
        return {
          pid: 0,
          boot: 0,
          cmd: clip(j.cmd, 200),
          unit: j.scope.unit,
          user: j.scope.account.user,
          uid: j.scope.account.uid,
        };
      }
      // The first process may be gone: any live member names the group.
      const pid = await procStart(j.pid) !== null
        ? j.pid
        : (await groupMembers(j.pid))[0] ?? j.pid;
      return { pid, boot: (await procStart(pid)) ?? 0, cmd: clip(j.cmd, 200) };
    })),
  };
  await Deno.writeTextFile(file, JSON.stringify(out), { mode: 0o600 })
    .catch(() => {});
}

/** Jobs written down by an app that is gone — killed at boot, so a crash can
 *  never leave a dev server running for days. An app still alive keeps its
 *  own: two instances of cc share this root. */
async function reapJobs(): Promise<void> {
  for await (const e of Deno.readDir(tmpRoot())) {
    if (!e.isDirectory || JOBS.has(e.name)) continue;
    const file = join(tmpRoot(), e.name, "run", "jobs.json");
    const text = await Deno.readTextFile(file).catch(() => null);
    if (text === null) continue;
    let got: JobFile | null = null;
    try {
      got = JSON.parse(text) as JobFile;
    } catch { /* half-written by a crash: nothing to trust in it */ }
    if (!got?.jobs?.length) {
      await Deno.remove(file).catch(() => {});
      continue;
    }
    if (await procStart(got.app.pid) === got.app.boot && got.app.boot > 0) {
      continue; // another live instance of this app owns them
    }
    for (const j of got.jobs) {
      if (j.unit && j.user && j.uid && validAccountName(j.user)) {
        // A scope name is never reused: stopping it cannot hit a stranger.
        await accountCtl(
          { user: j.user, uid: j.uid, home: "", display: null },
          ["stop", `${j.unit}.scope`],
        );
        log.warn("local", "stopped a job left behind by an earlier run", {
          unit: j.unit,
          cmd: j.cmd,
        });
        continue;
      }
      if (await procStart(j.pid) !== j.boot || j.boot === 0) continue;
      const stat = await Deno.readTextFile(`/proc/${j.pid}/stat`)
        .catch(() => "");
      const group = Number(
        stat.slice(stat.lastIndexOf(")") + 2).split(" ")[2] ?? j.pid,
      ) || j.pid;
      try {
        Deno.kill(-group, "SIGTERM");
        log.warn("local", "stopped a job left behind by an earlier run", {
          pid: j.pid,
          cmd: j.cmd,
        });
      } catch { /* gone between the check and the signal */ }
    }
    await Deno.remove(file).catch(() => {});
  }
}

/* ── the way out ──────────────────────────────────────────────────────────── */

let guard: { sigint: () => void; sigterm: () => void } | null = null;

/** No async on the way out of the process: the group, at once. */
const onUnload = () => {
  for (const jobs of JOBS.values()) {
    for (const j of jobs.values()) {
      if (j.code !== undefined) continue;
      try {
        if (j.scope) {
          new Deno.Command("sudo", {
            args: accountCtlArgv(j.scope.account, [
              "kill",
              "--signal=SIGKILL",
              `${j.scope.unit}.scope`,
            ]),
            stdin: "null",
            stdout: "null",
            stderr: "null",
          }).outputSync();
        } else Deno.kill(-j.pid, "SIGKILL");
      } catch { /* gone */ }
    }
  }
};

/** Held while any job is running, and only then: taking over SIGINT means
 *  nothing else will handle it, so it is given back as soon as there is
 *  nothing to protect. */
function installExitGuard(): void {
  if (guard) return;
  const bye = (code: number) => () => {
    stopAllJobs();
    onUnload();
    Deno.exit(code);
  };
  guard = { sigint: bye(130), sigterm: bye(143) };
  try {
    Deno.addSignalListener("SIGINT", guard.sigint);
    Deno.addSignalListener("SIGTERM", guard.sigterm);
  } catch { /* no signals on this platform */ }
  globalThis.addEventListener("unload", onUnload);
}

function releaseExitGuardIfIdle(): void {
  if (!guard) return;
  for (const jobs of JOBS.values()) {
    for (const j of jobs.values()) if (j.code === undefined) return;
  }
  try {
    Deno.removeSignalListener("SIGINT", guard.sigint);
    Deno.removeSignalListener("SIGTERM", guard.sigterm);
  } catch { /* never registered */ }
  globalThis.removeEventListener("unload", onUnload);
  guard = null;
}

/** Copy a stream to a file, keeping at most `cap` bytes and draining the
 *  rest so the program never blocks on a full pipe. */
async function pump(
  stream: ReadableStream<Uint8Array>,
  file: Deno.FsFile,
  written: { n: number },
): Promise<void> {
  try {
    for await (const chunk of stream) {
      if (written.n >= JOB_LOG_BYTES) continue;
      const take = chunk.subarray(0, JOB_LOG_BYTES - written.n);
      written.n += take.length;
      await file.write(take);
    }
  } catch { /* the program ended */ }
}

async function startJob(
  key: string,
  cmd: string,
  spawn: Omit<Deno.CommandOptions, "stdin" | "stdout" | "stderr">,
  tmp: string,
  boxed: boolean,
  signal?: AbortSignal,
  net = false,
  /** Run outside while this conversation's other commands are boxed. */
  besideBox = false,
  /** Run as the agent account, in this scope. */
  scope?: Job["scope"],
): Promise<string> {
  const k = dirName(key);
  const jobs = JOBS.get(k) ?? new Map<number, Job>();
  const live = [...jobs.values()].filter((j) => j.code === undefined);
  if (live.length >= MAX_JOBS) {
    throw new Error(
      `${MAX_JOBS} background jobs are already running (${
        live.map((j) => j.id).join(", ")
      }). Stop one with "stop-job <id>" first.`,
    );
  }
  const id = Math.max(0, ...jobs.keys()) + 1;
  const logPath = join(tmp, `job-${id}.log`);
  const shown = boxed ? `/tmp/job-${id}.log` : logPath;
  const file = await Deno.open(logPath, {
    write: true,
    create: true,
    truncate: true,
    // Readable by the account through its folder's ACL, whose mask is this
    // mode's group bits.
    mode: scope ? 0o640 : 0o600,
  });
  let child: Deno.ChildProcess;
  try {
    child = new Deno.Command("setsid", {
      ...spawn,
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
  } catch (e) {
    // The log file is open: nothing started, so nothing will ever close it.
    file.close();
    throw e;
  }
  const job: Job = {
    id,
    pid: child.pid,
    cmd,
    log: logPath,
    shown,
    started: Date.now(),
    scope,
  };
  jobs.set(id, job);
  JOBS.set(k, jobs);
  // From here on the app owes this program an ending — on the way out, and
  // after a crash, through the note.
  installExitGuard();
  void noteJobs(key);
  const written = { n: 0 };
  void Promise.all([
    pump(child.stdout, file, written),
    pump(child.stderr, file, written),
  ]).finally(() => file.close());
  void child.status.then(async (st) => {
    // What it started may run on: the job is over when that is too.
    if (job.code === undefined && !boxed && await jobAlive(job)) {
      job.first = st.code;
      followJob(key, job);
    } else endJob(key, job, st.code);
  }).catch(() => {});
  log.info("local", "background job started", {
    id,
    sandboxed: boxed,
    account: scope !== undefined,
  });
  // Long enough for a server to print its "listening on …" or to fail at
  // once — the two things the model needs to know right away. Stop does not
  // wait it out.
  for (
    let i = 0;
    i < 30 && job.code === undefined && signal?.aborted !== true;
    i++
  ) {
    await new Promise((r) => setTimeout(r, 100));
  }
  const first = await Deno.readTextFile(logPath).catch(() => "");
  const state = job.code === undefined
    ? `Started in the background as job ${id}.`
    : `Job ${id} already exited (code ${job.code}).`;
  // Boxed, a program runs where nobody can see it: no display for a window,
  // and its own network namespace, so a server in it is unreachable from the
  // user's browser. Said with the job, not left for its log: a live session
  // told "just run it" started the app in the box, where it could never have
  // been shown.
  // The other side of that wall: a program started OUTSIDE the box cannot be
  // seen from inside it — the box has its own /run/user, where an app manager
  // like aio keeps the sockets `am instances` and `am status` look for. A live
  // session asked the box, got `[]`, decided the app had died, and started a
  // second one.
  const outsideNote = !besideBox
    ? ""
    : `\n[outside the sandbox: commands you run inside it cannot see this` +
      ` program or what it registers (process lists, app managers, its` +
      ` sockets) — check on it with outside_sandbox: true as well.]`;
  // "Nobody but you" was the old wording, and it was wrong: without the
  // network each sandboxed command has a network of its own, so the model's
  // next `curl localhost:<port>` cannot reach this job either. A live session
  // curled three times, refused each time, before it believed the note.
  const boxedNote = boxed
    ? sandboxHit(first, net) ||
      `\n[sandbox: no window can open here${
          net
            ? ""
            : `, and this job has a network of its own — its ports cannot be` +
              ` reached by the user, nor by your other commands (curl gets` +
              ` "connection refused"); its log is how to see it`
        }. To run an app for the user to see, start it again with` +
        ` outside_sandbox: true and background: true — that is the step the` +
        ` user asked for, not an extra.]`
    : "";
  // A deadline on a program the user is meant to look at closes it under
  // them: a live session started the app with `timeout 599`.
  const deadline =
    /(?:^|[\s;&|(])timeout\s+(?:-\S+\s+(?:\S+\s+)?)*(\d+(?:\.\d+)?[smhd]?)\b/
      .exec(cmd)?.[1];
  const deadlineNote = besideBox && deadline
    ? `\n[timeout ${deadline} will close this program by itself — for an app` +
      ` the user is to check, start it without timeout; stop-job ends it.]`
    : "";
  return `${state} First output:\n${
    clip(stripAnsi(first).trim() || "(nothing yet)", 1_500, 0.3)
  }${boxedNote}${outsideNote}${deadlineNote}\nIts output keeps going to ${shown} — read it with: cat ${shown}.` +
    ` Stop it with the command "stop-job ${id}". It keeps running until` +
    ` stopped or until the conversation is cleared.`;
}

/** A command's output as it is read: kept up to `cap` for the result, and —
 *  once the command has returned but left something running — sent on to
 *  that job's log instead, so the program never writes into a closed pipe. */
type Tap = {
  done: Promise<void>;
  text: () => string;
  truncated: () => boolean;
  toLog: (file: Deno.FsFile, written: { n: number }) => void;
  cancel: () => void;
};

function tap(stream: ReadableStream<Uint8Array>, cap: number): Tap {
  const reader = stream.getReader();
  const kept: Uint8Array[] = [];
  let size = 0;
  let cut = false;
  const route: { sink: ((b: Uint8Array) => Promise<void>) | null } = {
    sink: null,
  };
  const done = (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done || !value) break;
        if (route.sink) {
          await route.sink(value);
          continue;
        }
        if (size < cap) {
          const take = value.subarray(0, cap - size);
          kept.push(take);
          size += take.length;
          cut = cut || take.length < value.length;
        } else cut = true;
      }
    } catch { /* cancelled, or the program ended */ }
  })();
  return {
    done,
    text: () => {
      const all = new Uint8Array(size);
      let off = 0;
      for (const c of kept) {
        all.set(c, off);
        off += c.length;
      }
      return new TextDecoder().decode(all);
    },
    truncated: () => cut,
    toLog: (file, written) => {
      route.sink = async (b) => {
        if (written.n >= JOB_LOG_BYTES) return;
        const take = b.subarray(0, JOB_LOG_BYTES - written.n);
        written.n += take.length;
        await file.write(take).catch(() => {});
      };
    },
    cancel: () => void reader.cancel().catch(() => {}),
  };
}

/**
 * What a finished command left running, taken on as a job: listed by `jobs`,
 * ended by `stop-job`, Clear and the app's exit — instead of killed the moment
 * the command returned, which is what every command's processes used to get.
 *
 * Killing them was the tidy answer and the wrong one: `am start`, `docker
 * compose up -d`, `npm run dev &` all return while the thing they started is
 * the point. A live session watched its app die after every start and spent
 * four minutes finding out why. `null` when there is no room for another job.
 */
async function adoptJob(
  key: string,
  cmd: string,
  pid: number,
  scope: Job["scope"],
  tmp: string,
  taps: Tap[],
): Promise<string | null> {
  const k = dirName(key);
  const jobs = JOBS.get(k) ?? new Map<number, Job>();
  if (
    [...jobs.values()].filter((j) => j.code === undefined).length >= MAX_JOBS
  ) {
    return null;
  }
  const id = Math.max(0, ...jobs.keys()) + 1;
  const logPath = join(tmp, `job-${id}.log`);
  const file = await Deno.open(logPath, {
    write: true,
    create: true,
    truncate: true,
    mode: scope ? 0o640 : 0o600,
  }).catch(() => null);
  if (!file) return null;
  const written = { n: 0 };
  for (const t of taps) t.toLog(file, written);
  void Promise.all(taps.map((t) => t.done)).finally(() => file.close());
  const job: Job = {
    id,
    pid,
    cmd,
    log: logPath,
    shown: logPath,
    started: Date.now(),
    scope,
    first: 0,
  };
  jobs.set(id, job);
  JOBS.set(k, jobs);
  installExitGuard();
  void noteJobs(key);
  followJob(key, job);
  log.info("local", "a command left a program running — kept as a job", {
    id,
    account: scope !== undefined,
  });
  return `\n[still running: this command left a program running, which keeps` +
    ` going now that the command has returned. It is job ${id} — "jobs"` +
    ` lists it, its further output goes to ${logPath}, "stop-job ${id}" ends` +
    ` it, and clearing the conversation stops it.]`;
}

/** `jobs` and `stop-job <id|all>` — the commands for the jobs above, handled
 *  here rather than by a shell that cannot see them. */
function jobCommand(key: string, cmd: string): string | null {
  const t = cmd.trim();
  if (/^jobs$/.test(t)) {
    const jobs = [...(JOBS.get(dirName(key))?.values() ?? [])];
    return jobs.length
      ? jobs.map((j) =>
        `job ${j.id}: ${
          j.code === undefined ? "running" : `exited (${j.code})`
        } — ${clip(j.cmd, 120)} — log ${j.shown}`
      ).join("\n")
      : "No background jobs.";
  }
  const m = /^stop-job\s+(all|\d+)$/.exec(t);
  if (!m) return null;
  const n = stopJobs(key, m[1] === "all" ? undefined : Number(m[1]));
  return n ? `Stopped ${n} job${n === 1 ? "" : "s"}.` : "No such running job.";
}

/* ── the sandbox, as bubblewrap arguments ─────────────────────────────────── */

/**
 * The bubblewrap arguments for one command in `cwd`.
 *
 *  - the whole filesystem read-only; the project, download caches and the
 *    conversation's own `/tmp` and `/run/user/<uid>` writable;
 *  - credential stores and this app's data hidden;
 *  - its own process namespace;
 *  - **no network** unless the conversation allows it. Not only to keep a
 *    project from being uploaded somewhere: the X server listens on an
 *    *abstract* socket, which lives in the network namespace — a sandbox that
 *    shares the network can screenshot the whole desktop, and one session's
 *    model did, OCR and all. The session bus and keyring live in
 *    `/run/user/<uid>`, which is replaced here by the conversation's own.
 */
async function sandboxArgs(
  cwd: string,
  dirs: { tmp: string; run: string },
  net: boolean,
  /** Where the command starts. The whole project is bound writable either way;
   *  this only decides which directory it wakes up in, so `dir` on a command
   *  means the same thing inside the sandbox as outside it. */
  at = cwd,
): Promise<string[]> {
  const home = Deno.env.get("HOME") ?? "";
  const exists = async (p: string, dir: boolean) => {
    try {
      const s = await Deno.stat(p);
      return dir ? s.isDirectory : s.isFile;
    } catch {
      return false;
    }
  };
  const args = [
    "--ro-bind",
    "/",
    "/",
    "--dev",
    "/dev",
    "--proc",
    "/proc",
    "--bind",
    dirs.tmp,
    "/tmp",
  ];
  const runtime = `/run/user/${Deno.uid() ?? 0}`;
  if (await exists(runtime, true)) args.push("--bind", dirs.run, runtime);
  if (home) {
    for (const d of CACHE_DIRS) {
      const p = join(home, d);
      if (await exists(p, true)) args.push("--bind", p, p);
    }
    for (const d of HIDDEN_DIRS) {
      const p = join(home, d);
      if (await exists(p, true)) args.push("--tmpfs", p);
    }
    for (const f of HIDDEN_FILES) {
      const p = join(home, f);
      if (await exists(p, false)) args.push("--ro-bind", "/dev/null", p);
    }
  }
  // Last, so a project that lives under a hidden or read-only directory is
  // writable all the same.
  args.push(
    "--bind",
    cwd,
    cwd,
    "--chdir",
    at,
    "--unshare-pid",
    ...(net ? [] : ["--unshare-net"]),
    "--die-with-parent",
  );
  return args;
}

async function sh(args: Record<string, unknown>, c: Ctx) {
  const cmd = str(args.cmd);
  if (!cmd) throw new Error("Empty command.");
  const key = c.key ?? "default";
  const handled = jobCommand(key, cmd);
  if (handled !== null) return handled;
  // Seconds, as the schema says — but a value only a model thinking in
  // milliseconds would send is read as milliseconds.
  const asked = num(args.timeout, 0);
  const limit = asked > 0
    ? Math.min(asked > 600 ? asked : asked * 1_000, SH_MAX_MS)
    : SH_DEFAULT_MS();
  const root = await Deno.realPath(c.cwd);
  // A project the agent account can reach runs as that account, in every
  // permission mode: it is a whole machine of the agent's own, so there is no
  // box to put round it and nothing to leave. The mode only decides asking.
  const account = await projectAccount(root);
  // Otherwise unattended means sandboxed, unless the user just approved this
  // one command to run outside it (the cell asked; the model cannot say so).
  const unattended = c.permission === "dontAsk" && !c.outside;
  const boxed = !account && unattended && await sandboxAvailable();
  if (!account && !boxed && c.permission === "dontAsk") WENT_OUTSIDE.add(key);
  // The command may name the directory to run in. Worth its own argument
  // because the alternative is what a live session actually did: 131 of its
  // 134 commands began `cd analog-clock &&`, the app it had just scaffolded
  // being one level down. Resolved through `inside`, so this is not a way out
  // of the project — and the sandbox still binds the project, not the subdir.
  const where = str(args.dir);
  let cwd = root;
  if (where) {
    const at = await inside(c.cwd, where);
    const isDir = await Deno.stat(at).then((st) => st.isDirectory, () => false);
    if (!isDir) {
      throw new Error(
        `dir "${where}" is not a directory in this project — run from the` +
          ` project root, or name a folder that exists.`,
      );
    }
    cwd = at;
  }
  const dirs = await convDirs(key);
  const tmp = account ? await accountTmp(key, account) : dirs.tmp;
  // Log that a command ran and how big it was, never its text: a model (or a
  // prompt injected into one) could be steered to `echo $SECRET`, and a log
  // line is a place that outlives the turn.
  log.info("local", "sh ran", {
    chars: cmd.length,
    sandboxed: boxed,
    account: account !== null,
  });
  const unit = account ? unitName(dirName(key), Deno.pid, ++UNITS) : "";
  // `setsid` makes the shell a process-group leader: a timeout or Stop takes
  // its whole tree. As the account, the scope is what holds the tree — and the
  // account's own task limit replaces the per-user ulimit, which counts this
  // app's user, not the account.
  const headroom = account ? null : await taskHeadroom();
  const argv = account
    ? [
      "sudo",
      ...accountArgv(
        account,
        unit,
        bounded(cmd, null),
        tmp,
        Deno.env.get("LANG"),
      ),
    ]
    : boxed
    ? [
      "bwrap",
      ...await sandboxArgs(root, dirs, c.net, cwd),
      "bash",
      "-c",
      bounded(cmd, headroom),
    ]
    : ["bash", "-c", bounded(cmd, headroom)];
  // No colour: escape codes are noise a model pays for by the token and then
  // tries to read. Every common tool honours one of these.
  const plain: Record<string, string> = {
    NO_COLOR: "1",
    FORCE_COLOR: "0",
    CLICOLOR: "0",
    TERM: "dumb",
  };
  const env: Record<string, string> = account
    // sudo starts from nothing anyway; the account's environment is built
    // whole in its arguments, and not one variable of this app's crosses.
    ? { PATH: "/usr/bin:/bin" }
    : boxed
    ? {
      ...scrubbedEnv(),
      ...plain,
      TMPDIR: "/tmp",
      XDG_RUNTIME_DIR: `/run/user/${Deno.uid() ?? 0}`,
    }
    // Approved by the user, or Bypass: still scrubbed. "I allow this command"
    // is not "and put every token I have on the wire" — one `env` in a command
    // that read plausibly would send the lot to the model, and into the saved
    // transcript. A command that genuinely needs a secret is one for the user
    // to run in their own shell.
    : { ...scrubbedEnv(), ...plain, TMPDIR: dirs.tmp };
  if (boxed) {
    // Nothing to reach them with — and no reason to look.
    for (const k of ["DISPLAY", "WAYLAND_DISPLAY", "XAUTHORITY"]) delete env[k];
  }
  const spawn = { args: argv, cwd, clearEnv: true, env };
  const scope = account ? { account, unit } : undefined;

  if (args.background === true) {
    // In the sandbox a job is its own process namespace, and the namespace
    // ends when its first process does — so a command that starts something
    // and returns (`am start`, `docker compose up -d`, `npm run dev &`) took
    // what it started down with it. The job's shell stays, holding the
    // namespace open until `stop-job`.
    const held = boxed
      ? {
        ...spawn,
        args: [
          ...argv.slice(0, -1),
          bounded(
            `${cmd}\n__cc=$?\necho "[the command returned $__cc; anything it` +
              ` started keeps running in this job until stop-job]"\nexec sleep infinity`,
            headroom,
          ),
        ],
      }
      : spawn;
    return await startJob(
      key,
      cmd,
      held,
      tmp,
      boxed,
      c.signal,
      c.net,
      !account && c.permission === "dontAsk" && c.outside === true &&
        await sandboxAvailable(),
      scope,
    );
  }

  const run = { start: Date.now(), end: Number.POSITIVE_INFINITY, cmd };
  const runs = SH_RUNS.get(key) ?? [];
  runs.push(run);
  if (runs.length > MAX_SH_RUNS) runs.splice(0, runs.length - MAX_SH_RUNS);
  SH_RUNS.set(key, runs);
  const child = new Deno.Command("setsid", {
    ...spawn,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const out = tap(child.stdout, SH_MAX_BYTES);
  const err = tap(child.stderr, SH_MAX_BYTES);

  let timedOut = false;
  let exited = false;
  let kept = false;
  const killTree = () => {
    if (account) {
      // sudo is root's and the rest is the account's: neither is this app's
      // to signal. The scope takes all of it.
      void accountCtl(account, ["kill", "--signal=SIGKILL", `${unit}.scope`]);
      return;
    }
    try {
      Deno.kill(-child.pid, "SIGKILL");
    } catch { /* already gone */ }
  };
  const timer = setTimeout(() => {
    timedOut = true;
    log.warn("local", "sh timed out — killing its process group", {
      chars: cmd.length,
      afterMs: limit,
    });
    killTree();
  }, limit);
  const onAbort = () => {
    killTree();
    // Stopped while the scope was still being made: the kill found nothing.
    if (account) setTimeout(() => exited || killTree(), 1_000);
  };
  c.signal?.addEventListener("abort", onAbort, { once: true });
  // An abort that landed while the process was being spawned fires no event.
  if (c.signal?.aborted) onAbort();

  try {
    const status = await child.status;
    exited = true;
    // The command's own last words are in the pipes; a program it left
    // running may hold them open for its whole life, so not waited on long.
    const drained = await settles(Promise.all([out.done, err.done]), 300);
    let left = "";
    const cut = timedOut || c.signal?.aborted === true;
    if (!cut && !boxed) {
      const alive = () =>
        account
          ? scopeActive(account, unit)
          : groupMembers(child.pid).then((m) => m.length > 0);
      // A child still on its way out is not a program left running.
      if (await alive() && (await delay(150), await alive())) {
        const adopted = await adoptJob(key, cmd, child.pid, scope, tmp, [
          out,
          err,
        ]);
        if (adopted !== null) {
          kept = true;
          left = adopted;
        } else {
          killTree();
          left = `\n[this command left a program running, and ${MAX_JOBS}` +
            ` jobs are already running, so it was stopped — "stop-job <id>"` +
            ` one first]`;
        }
      }
    }
    if (!kept) {
      // Held open by something outside the group (a daemon that made its own
      // session): what was read is the result.
      if (!drained) {
        out.cancel();
        err.cancel();
      }
      await Promise.all([out.done, err.done]);
    }
    // …and whatever colour a tool emits anyway is taken out.
    const text = foldInstallNoise(stripAnsi(
      out.text() + (out.text() && err.text() ? "\n" : "") + err.text(),
    ));
    const trunc = out.truncated() || err.truncated()
      ? "\n[output truncated]"
      : "";
    const secs = limit < 10_000
      ? String(Math.round(limit / 100) / 10)
      : String(Math.round(limit / 1000));
    const fate = timedOut
      ? `\n[killed after ${secs}s — pass a larger timeout, or run it with` +
        ` background: true if it is meant to keep running]`
      : status.success
      ? ""
      : `\n[exit ${status.code}]`;
    const hit = (boxed ? sandboxHit(text, c.net) : "") + limitHit(text) +
      (boxed && WENT_OUTSIDE.has(key) && mayLeaveUnasked(cmd, [], lookEnv(key))
        ? BLIND_NOTE
        : "");
    // Command output keeps more of its end: the error, the failing test and
    // the summary line are all at the bottom. Room is left for the notes
    // after it, so the executor's own clip does not cut through them.
    const shown = clip(text || "(no output)", c.budget - 400, 0.4);
    // What did not fit is kept, not dropped: a 200-line test run cut to the
    // window is exactly the case where the answer is in the part that went,
    // and grepping a file costs one call instead of running it all again.
    const spill = shown.length < text.length
      ? await keepFullOutput(tmp, boxed, text, account !== null)
      : "";
    return shown + trunc + fate + hit + left + spill;
  } finally {
    run.end = Date.now();
    clearTimeout(timer);
    c.signal?.removeEventListener("abort", onAbort);
    if (!kept && !account) killTree();
    else if (!exited) killTree();
    // A read that threw leaves `child.status` unawaited, and an unawaited
    // child is a resource this process holds until it exits.
    void child.status.catch(() => {});
  }
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Whether `p` settles within `ms` — without leaving a timer behind. */
async function settles(p: Promise<unknown>, ms: number): Promise<boolean> {
  let t: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<false>((r) => {
    t = setTimeout(() => r(false), ms);
  });
  try {
    return await Promise.race([p.then(() => true as const), late]);
  } finally {
    clearTimeout(t);
  }
}

/** Output too long for the window, written where the model can go back to it.
 *  Best effort: if the file cannot be written, the result simply says less. */
let SH_LOG = 0;
async function keepFullOutput(
  tmp: string,
  boxed: boolean,
  text: string,
  shared = false,
): Promise<string> {
  const name = `sh-${++SH_LOG}.log`;
  try {
    await Deno.writeTextFile(join(tmp, name), text, {
      mode: shared ? 0o640 : 0o600,
    });
  } catch {
    return "";
  }
  const where = boxed ? `/tmp/${name}` : join(tmp, name);
  return `\n[the whole output (${text.length} characters) is in ${where} —` +
    ` grep it rather than running this again]`;
}

/** The kernel's own refusals read as gibberish ("File size limit exceeded",
 *  "fork: Resource temporarily unavailable"). Said plainly, they are something
 *  the model can work with instead of retrying. */
function limitHit(text: string): string {
  if (/file size limit exceeded/i.test(text)) {
    const kb = tunable("CC_SH_MAX_FILE_KB", 0);
    // Only reachable when somebody asked for the ceiling (see `bounded`), and
    // then the note has to name it — a bare SIGXFSZ from a type-checker looks
    // like a compiler bug, which is exactly how it was read for thirty-five
    // rounds before the limit came off by default.
    return kb > 0
      ? `\n[CC_SH_MAX_FILE_KB caps every file this command writes at ${
        Math.round(kb / 1_048_576)
      } GB, and something here went past it — including, on many machines, a` +
        ` shared build cache that is already larger than the cap. Raise or` +
        ` unset CC_SH_MAX_FILE_KB, or write less]`
      : "\n[something here hit a file-size limit set outside this app]";
  }
  if (/fork: (retry: )?resource temporarily unavailable/i.test(text)) {
    return "\n[that command tried to start far more processes than anything" +
      " here needs, and was capped — run it with less parallelism]";
  }
  return "";
}

/** Conversations that have run something outside the sandbox. */
const WENT_OUTSIDE = new Set<string>();

/** Said under a look taken from inside the box, once something has been
 *  started outside it. A live session asked the sandbox `am instances`, got
 *  `[]` and `"status":"stopped"` for an app the user was looking at, and spent
 *  seven minutes starting it again. */
const BLIND_NOTE = "\n[sandbox: this ran inside the sandbox, which has its" +
  " own processes and its own /run/user — it cannot see anything you started" +
  ' outside it, so an empty or "stopped" answer here says nothing about' +
  " that. Run the same look with outside_sandbox: true; a command that only" +
  " looks goes without asking.]";

/** When a sandboxed command failed the way the sandbox makes things fail, say
 *  which wall it hit and the way round it — once, in the result. */
function sandboxHit(text: string, net: boolean): string {
  const walls: string[] = [];
  if (/read-only file system/i.test(text)) {
    walls.push("only the project, /tmp and download caches are writable");
  }
  if (
    !net &&
    /could not resolve|name or service not known|network is unreachable|temporary failure in name resolution|connection refused|failed to fetch|getaddrinfo|ENOTFOUND|EAI_AGAIN/i
      .test(text)
  ) walls.push("there is no network");
  const display = /cannot open display|no display|\$DISPLAY|wayland|X server/i
    .test(text);
  if (display) {
    walls.push(
      "there is no display, so no window can ever open here — to show a GUI" +
        " app to the user, run it with outside_sandbox: true and background:" +
        " true; that is the step the user asked for, not an extra",
    );
  }
  // Ending every wall with "the user is asked first" read as a reason not to:
  // a live session was told three times to run the app outside and kept
  // running it in the box. For the display, the way out is said above.
  return walls.length
    ? `\n[sandbox: ${walls.join("; ")}.${
      display && walls.length === 1
        ? ""
        : " If this command needs more, call sh again with" +
          " outside_sandbox: true — the user approves that command."
    }]`
    : "";
}

/**
 * Runs of package-manager bookkeeping lines — `Initialize immer@10.2.0`,
 * `Download https://jsr.io/…` — folded into one line.
 *
 * A cold `deno check` put twenty of them ahead of the type errors a live
 * session was waiting for; it learned to append `| grep -v Initialize` to every
 * later check. Four or more in a row fold; the count stays, the names go.
 */
export function foldInstallNoise(text: string): string {
  const noise = /^(Initialize|Download|Downloading|Resolving|Fetching) \S+$/;
  const out: string[] = [];
  let run: string[] = [];
  const flush = () => {
    if (run.length >= 4) {
      out.push(`[${run.length} package download/initialize lines]`);
    } else out.push(...run);
    run = [];
  };
  for (const line of text.split("\n")) {
    if (noise.test(line.trim())) run.push(line);
    else {
      flush();
      out.push(line);
    }
  }
  flush();
  return out.join("\n");
}

/** Terminal escape sequences (colour, cursor movement) out of tool output. */
export const stripAnsi = (text: string): string =>
  // The escape character is the whole point of this pattern.
  // deno-lint-ignore no-control-regex
  text.replace(/\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*(\x07|\x1b\\)/g, "");

/** The result a call gets when Stop came first. It still needs one: every
 *  call in the transcript is answered, or the next request is malformed. */
export const STOPPED_RESULT = "Not run: the user pressed Stop.";

const EXECUTORS: Record<
  string,
  (args: Record<string, unknown>, c: Ctx) => Promise<string> | string
> = { ls, glob, read, grep, history, edit, write, todo, sh };

export type RunOpts = {
  signal?: AbortSignal;
  /** The conversation the call belongs to. */
  key?: string;
  /** The model's window — sizes the result. */
  ctx?: number;
  permission?: LocalPermission;
  /** Sandboxed commands may use the network. Off unless the user allowed it. */
  net?: boolean;
  /** The user approved this one call to run outside the sandbox. */
  outside?: boolean;
  /** For `history`: the rows only the cell can see. */
  recall?: Recall;
};

/**
 * Execute one tool call. The gate is by mode and name — never by trusting the
 * request — and every result is sized here to the window, so an oversized
 * output cannot reach the packer in the first place.
 */
export async function runTool(
  mode: LocalMode,
  cwd: string,
  name: string,
  rawArgs: string,
  opts: RunOpts = {},
): Promise<string> {
  if (!allowedTools(mode).includes(name)) {
    // Refusals go back to the model, so they are written for the model: a
    // "no" it cannot act on is answered by inventing another wrong name.
    const usable = allowedTools(mode);
    const offer = usable.length
      ? ` Use one of: ${usable.join(", ")}.`
      : ` There are no tools in this mode — answer in words.`;
    log.warn("local", "tool refused by mode", { tool: name, mode });
    return TOOL_NAMES.includes(name)
      ? `Error: "${name}" is not available in ${mode} mode.${offer}`
      : `Error: there is no tool called "${name}".${offer}`;
  }
  let args: Record<string, unknown>;
  try {
    const parsed: unknown = rawArgs.trim() ? JSON.parse(rawArgs) : {};
    args = parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    // Almost always a reply cut off at the output limit mid-argument, which
    // the model cannot see from its own side.
    return `Error: the arguments were not valid JSON — they may have been cut` +
      ` off. Send the call again with smaller arguments.`;
  }
  // Stopped between the model asking and this call's turn to run (the calls
  // before it in the same reply took the time): nothing starts after Stop.
  if (opts.signal?.aborted) return STOPPED_RESULT;
  const budget = toolBudget(opts.ctx ?? 32_768);
  try {
    const result = await EXECUTORS[name](args, {
      cwd,
      signal: opts.signal,
      key: opts.key,
      budget,
      permission: opts.permission ?? "ask",
      net: opts.net ?? false,
      outside: opts.outside ?? false,
      recall: opts.recall,
    });
    return clip(result === "" ? emptyResult(name) : result, budget);
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    // A refused boundary is worth a trace — a confused model or an attempted
    // escape, and those want different reactions from whoever reads the log.
    //
    // What is never written here is the path. The model wrote that string, and
    // model-authored text does not belong in this app's log: it is where a
    // prompt injection would try to plant a line, and a refused path can carry
    // a secret in its own name. `kind` is this app's own word for what
    // happened, from a closed set of two.
    const kind = why.includes("symlink") || why.includes("is a link that leads")
      ? "link"
      : why.includes("outside the project")
      ? "outside"
      : "";
    if (kind !== "") {
      log.warn("local", "path refused at the project boundary", {
        tool: name,
        kind,
      });
    }
    return `Error: ${why}`;
  }
}

/* ── saved history ────────────────────────────────────────────────────────── */

/** Where conversations go when they leave the app's state: the app's home,
 *  0700, beside its temp — never anywhere another user can list. */
const historyRoot = (): string => {
  const override = Deno.env.get("CC_HISTORY_ROOT");
  if (override) return override;
  const apps = Deno.env.get("AIO_APPS_DIR");
  const home = Deno.env.get("HOME") ?? "/tmp";
  return join(apps ? join(apps, APP_ID) : join(home, `.${APP_ID}`), "history");
};

/** One saved file per conversation stays under this; past it the oldest half
 *  goes. A conversation that long has said everything twice. */
const SAVED_MAX_BYTES = 16 * 1024 * 1024;
/** What one search may read — the newest files first. */
const SEARCH_MAX_BYTES = 64 * 1024 * 1024;

/** A project's folder: its path hashed, so no path is ever a file name, and
 *  a search reads only the one project it was asked about. */
async function projectDir(cwd: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(cwd),
  );
  const hex = [...new Uint8Array(digest)].slice(0, 8)
    .map((b) => b.toString(16).padStart(2, "0")).join("");
  return join(historyRoot(), hex);
}

async function ensureDir(dir: string): Promise<void> {
  await Deno.mkdir(dir, { recursive: true, mode: 0o700 });
  await Deno.chmod(historyRoot(), 0o700).catch(() => {});
}

/** A message as history keeps it: what was said and done, not the flags. */
export const histRow = (conv: string, m: LocalMsg): HistRow => ({
  conv,
  id: m.id,
  role: m.role,
  text: m.text,
  ...(m.toolName ? { toolName: m.toolName } : {}),
  ...(m.toolCalls?.length
    ? {
      calls: m.toolCalls.map((c) => `${c.name} ${clip(c.args, 300)}`).join(
        " | ",
      ),
    }
    : {}),
  at: m.at ?? 0,
});

/** Writes to one file, in order — two appends racing would interleave. */
const SAVING = new Map<string, Promise<void>>();

function inOrder(file: string, job: () => Promise<void>): Promise<boolean> {
  const next = (SAVING.get(file) ?? Promise.resolve()).then(job).then(
    () => true,
    (e) => {
      log.warn("local", "could not save history", { error: String(e) });
      return false;
    },
  );
  const tail = next.then(() => {});
  SAVING.set(file, tail);
  void tail.then(() => {
    if (SAVING.get(file) === tail) SAVING.delete(file);
  });
  return next;
}

/**
 * Save rows that are leaving the conversation — pushed out by the cap, taken
 * by Clear, or folded to a stub (saved whole first). Append-only; a row saved
 * twice is merged on read. Never throws: history is a record, and a full disk
 * must not break the turn that is writing it. True when the rows are on disk
 * — a caller about to delete its own copy must ask.
 */
export function saveRows(
  key: string,
  cwd: string,
  rows: LocalMsg[],
): Promise<boolean> {
  if (rows.length === 0) return Promise.resolve(true);
  if (!cwd) return Promise.resolve(false);
  const lines = rows.map((m) => JSON.stringify(histRow(key, m))).join("\n") +
    "\n";
  return projectDir(cwd).then((dir) => {
    const file = join(dir, `${dirName(key)}.jsonl`);
    return inOrder(file, async () => {
      await ensureDir(dir);
      await Deno.writeTextFile(file, lines, { append: true, mode: 0o600 });
      const size = (await Deno.stat(file)).size;
      if (size > SAVED_MAX_BYTES) await keepNewest(file, SAVED_MAX_BYTES / 2);
    });
  });
}

/** Cut a saved file down to its newest `bytes`, at a line boundary. */
async function keepNewest(file: string, bytes: number): Promise<void> {
  const all = await Deno.readFile(file);
  let from = Math.max(0, all.length - bytes);
  while (from < all.length && all[from - 1] !== 10 && from > 0) from++;
  const tmp = `${file}.${crypto.randomUUID()}.tmp`;
  await Deno.writeFile(tmp, all.subarray(from), { mode: 0o600 });
  await Deno.rename(tmp, file);
}

const parkedFile = (key: string) =>
  join(historyRoot(), "parked", `${dirName(key)}.json`);

/**
 * Put a whole conversation on disk, so the app's state stops carrying it.
 * Written to a temp name and renamed: a crash mid-write leaves the old file
 * or the new one, never half of one. True when it is safely there.
 */
export async function parkRows(
  key: string,
  cwd: string,
  messages: LocalMsg[],
): Promise<boolean> {
  const file = parkedFile(key);
  try {
    await ensureDir(dirname(file));
    const tmp = `${file}.${crypto.randomUUID()}.tmp`;
    await Deno.writeTextFile(
      tmp,
      JSON.stringify({ v: 1, key, cwd, at: Date.now(), messages }),
      { mode: 0o600 },
    );
    await Deno.rename(tmp, file);
    return true;
  } catch (e) {
    log.warn("local", "could not park a conversation", { error: String(e) });
    return false;
  }
}

/**
 * A parked conversation's messages, or why not.
 *
 * `quarantine` (bringing the chat back): a file that exists but cannot be read
 * is renamed aside rather than left where the next park would overwrite it —
 * it may be the only copy there is, and a person can still recover it.
 */
export async function unparkRows(
  key: string,
  quarantine = false,
): Promise<{ rows: LocalMsg[] } | { why: string }> {
  const file = parkedFile(key);
  let text: string;
  try {
    text = await Deno.readTextFile(file);
  } catch {
    return { why: "its saved file is missing" };
  }
  try {
    const data = JSON.parse(text);
    if (Array.isArray(data?.messages)) {
      return { rows: data.messages as LocalMsg[] };
    }
  } catch { /* handled below */ }
  if (!quarantine) return { why: "its saved file is damaged" };
  const aside = `${file}.unreadable-${Date.now()}`;
  await Deno.rename(file, aside).catch(() => {});
  return { why: `its saved file is damaged (kept as ${aside})` };
}

export async function dropParked(key: string): Promise<void> {
  await Deno.remove(parkedFile(key)).catch(() => {});
}

/** Everything saved for one project: its conversations' saved files, newest
 *  first up to the read budget, and the parked conversations named. */
async function savedHistory(cwd: string, parked: string[]): Promise<HistRow[]> {
  const rows: HistRow[] = [];
  const dir = await projectDir(cwd);
  const files: { path: string; size: number; mtime: number }[] = [];
  try {
    for await (const e of Deno.readDir(dir)) {
      if (!e.isFile || !e.name.endsWith(".jsonl")) continue;
      const path = join(dir, e.name);
      const st = await Deno.stat(path).catch(() => null);
      if (st) {
        files.push({ path, size: st.size, mtime: st.mtime?.getTime() ?? 0 });
      }
    }
  } catch { /* nothing saved for this project yet */ }
  files.sort((a, b) => b.mtime - a.mtime);
  let read = 0;
  for (const f of files) {
    if (read + f.size > SEARCH_MAX_BYTES) break;
    read += f.size;
    const text = await Deno.readTextFile(f.path).catch(() => "");
    for (const line of text.split("\n")) {
      if (!line) continue;
      try {
        const r = JSON.parse(line) as HistRow;
        if (typeof r?.id === "string" && typeof r.text === "string") {
          rows.push(r);
        }
      } catch { /* a line cut by a crash — the rest are whole */ }
    }
  }
  for (const key of parked) {
    const got = await unparkRows(key);
    if ("rows" in got) { for (const m of got.rows) rows.push(histRow(key, m)); }
  }
  return rows;
}

/** The `history` tool: search, list, or open one message. Read-only, and
 *  confined to the project the conversation works in. */
async function history(args: Record<string, unknown>, c: Ctx) {
  const recall = c.recall ?? { self: c.key ?? "", rows: [], parked: [] };
  const all = mergeRows([
    ...await savedHistory(c.cwd, recall.parked),
    ...recall.rows,
  ]);
  const opts = {
    self: recall.self,
    budget: c.budget,
    conversation: str(args.conversation) || undefined,
  };
  const id = str(args.id);
  return id
    ? readHistoryRow(all, id, opts)
    : searchHistory(all, str(args.query), opts);
}
