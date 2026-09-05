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
 *  - the filesystem tools (`ls`, `read`, `grep`, `write`) resolve every path
 *    inside the project directory, symlinks included — `inside()` resolves the
 *    real path before judging it;
 *  - `sh` is NOT confined. It exists only in agent mode, which the user arms
 *    through an explicit confirmation, and it runs with the user's own
 *    privileges — the same grant `--dangerously-skip-permissions` is on the
 *    Claude side. What is bounded is its blast radius on the machine: a
 *    wall-clock cap, an output cap enforced *while reading* (never buffered
 *    unbounded), its own process group so the whole tree dies together, and
 *    the turn's abort signal so Stop stops it.
 */
import { log } from "aio";
import { dirname, join, normalize } from "@std/path";
import { allowedTools, clip, safePattern, TOOL_NAMES } from "../lib/agent.ts";
import type { WireMsg } from "../lib/agent.ts";
import type { EngineProbe, LocalEngine, LocalMode } from "../type/local.ts";

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
 * predictable.
 *
 * This is a short, curated list, not a port sweep. Knocking on every port of
 * the machine to find a chat server would be both slow and a rude thing for an
 * app to do unasked; the address a user has actually configured is passed in
 * separately and is always tried.
 */
const ALSO: Record<LocalEngine, string[]> = {
  // LM Studio and Ollama own their ports and are effectively never moved, so
  // there is nothing to guess and guessing could only find somebody else's
  // server.
  lmstudio: [],
  ollama: [],
  llamacpp: ["http://localhost:18080", "http://localhost:8081"],
};

/** A probe is a question about a port that is either open or not. Two seconds
 *  is generous for a loopback answer and short enough that looking for three
 *  engines the user runs none of costs a blink. */
const PROBE_MS = 2_000;

/**
 * Ask all three default addresses what they are serving, at once.
 *
 * This is the whole "no manual setup" story: the ports are fixed by the
 * engines themselves, a listening server answers `/v1/models` in milliseconds,
 * and one that is not running refuses the connection immediately. Nothing here
 * guesses — an engine is reported reachable only because it replied.
 */
/** The scan in flight, so it can be cut short. A probe of three ports must not
 *  outlive the app that asked for it — on shutdown there is nobody left to tell
 *  the answer to, and the requests would keep a process alive to say it. */
let SCAN: AbortController | null = null;

/** Abort any scan in flight. Safe to call when there is none. */
export function cancelScan(): void {
  SCAN?.abort();
  SCAN = null;
}

export async function detectEngines(
  /** The calling method's own abort — the app closing, or the method being
   *  cancelled. Without it a scan outlives whatever asked for it by up to two
   *  seconds, which is long enough to matter to a shutdown and long enough for
   *  a test harness to give up waiting for the app to go quiet. */
  cancel?: AbortSignal,
  /**
   * Addresses somebody has actually configured, on top of the defaults.
   *
   * A scan that only ever knocks on the default port can only ever find a
   * server on the default port — so a llama.cpp moved to another one (the
   * usual reason being that something else already owns 8080) was invisible
   * to detection, and every panel that reads the scan said "not scanned yet"
   * about a server that was running the whole time. The address the project
   * is pointed at is the one address the app can be sure is worth trying.
   */
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
      // The default first — it is the likeliest and it is what an unreachable
      // result should name — then whatever anyone has configured for this
      // engine. First one that answers wins; there is no sense in reporting a
      // second address for a switch that offers one row per engine.
      const candidates = [
        PORTS[engine],
        ...extra.filter((e) => e.engine === engine).map((e) => e.baseUrl),
        ...ALSO[engine],
      ]
        .map((u) => String(u ?? "").trim().replace(/\/+$/, ""))
        .filter((u, i, all) => u !== "" && all.indexOf(u) === i);

      // All at once, then the first that answered in preference order: a
      // closed port refuses immediately, so the cost of asking three is the
      // cost of asking one, and the whole scan still finishes in a blink.
      //
      // A GUESSED address has to prove what it is. An OpenAI-compatible
      // `/v1/models` is served by half the things a developer runs — this
      // machine has an unrelated app on one of the ports llama.cpp is commonly
      // moved to — and adopting one of those as the project's engine would be
      // a worse failure than not finding the server at all. The default and an
      // address somebody configured are exempt: those are not guesses.
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
        // Asked here, while the port is known to be open, so the switch can
        // say "running, but it cannot use tools" BEFORE it is picked.
        const tools = await probeTools(engine, hit.baseUrl, ctrl.signal);
        return {
          engine,
          baseUrl: hit.baseUrl,
          reachable: true,
          models: hit.models,
          tools,
        };
      }
      // Unreachable is reported against the DEFAULT, not the last thing tried:
      // that is the address the user is asked about and the one the config
      // falls back to.
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

/**
 * What an OLD llama.cpp called "started without `--jinja`".
 *
 * Without a Jinja template the server had nothing to render tool schemas
 * with, so it refused any request carrying `tools` outright — HTTP 500,
 * `tools param requires --jinja flag` — while chatting perfectly, which is why
 * it looked like the app being at fault rather than a launch flag.
 *
 * On a current build this string means nothing of the sort: templating is on
 * unless `--no-jinja` says otherwise, and `chat_format` here is only what the
 * server's *default* (tool-free) request would use. Reading it as a verdict
 * declared a perfectly capable server tool-less and sent the user off to add a
 * flag their build does not have — so it is now the fallback, not the answer.
 */
const NO_TOOLS_FORMAT = "Content-only";

/**
 * Will this server accept tool calls at all?
 *
 * Only llama.cpp can be asked ahead of time, and only llama.cpp needs to be:
 * it decides once, at startup, for every model it serves. LM Studio and
 * Ollama decide per model when the request arrives, so there is no honest
 * answer to give here and `null` is returned rather than a guess.
 */
export async function probeTools(
  engine: LocalEngine,
  baseUrl: string,
  cancel?: AbortSignal,
): Promise<boolean | null> {
  if (engine !== "llamacpp") return null;
  const props = await json(
    `${baseUrl.replace(/\/+$/, "")}/props`,
    undefined,
    cancel,
  );
  if (!props) return null;
  // A current build answers the question itself, about the template it has
  // actually loaded. Measured beats inferred: this is the server saying yes,
  // not the app deducing it from a setting that means something else.
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

/**
 * Does the thing answering at this address actually look like this engine?
 *
 * Only asked of *guessed* addresses (see the scan). llama.cpp is the only
 * engine with guesses, and it identifies itself on `/props` — the same endpoint
 * the tool probe already reads — with fields nothing else serves.
 */
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
): Promise<Record<string, unknown> | null> {
  try {
    const r = await fetch(url, {
      ...init,
      signal: cancel
        ? AbortSignal.any([cancel, AbortSignal.timeout(PROBE_MS)])
        : AbortSignal.timeout(PROBE_MS),
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
 * The context length the server actually runs `model` at, or null.
 *
 * Each engine tells the truth somewhere different, and none of them in the
 * OpenAI-compatible surface — which is exactly why this used to be a number
 * the user had to look up and type:
 *
 *  - **llama.cpp** serves `/props`, whose `n_ctx` is the window the binary was
 *    started with. That is the one that matters: it is a launch flag, not a
 *    property of the file.
 *  - **Ollama** answers `POST /api/show` with `model_info`, in which the key
 *    is architecture-scoped (`llama.context_length`, `qwen2.context_length`),
 *    so it is found by suffix rather than by name.
 *  - **LM Studio** serves its own `/api/v0/models`, which carries both the
 *    model's maximum and the length it is *loaded* at — the loaded one wins,
 *    because that is the request that will be refused.
 */
export async function probeContext(
  engine: LocalEngine,
  baseUrl: string,
  model: string,
): Promise<number | null> {
  const base = baseUrl.replace(/\/+$/, "");
  if (engine === "llamacpp") {
    const props = await json(`${base}/props`);
    if (!props) return null;
    const gen = props.default_generation_settings as
      | Record<string, unknown>
      | undefined;
    return asInt(props.n_ctx) ?? asInt(gen?.n_ctx) ??
      asInt((gen?.params as Record<string, unknown> | undefined)?.n_ctx);
  }
  if (engine === "ollama") {
    if (!model) return null;
    const shown = await json(`${base}/api/show`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model }),
    });
    const info = shown?.model_info as Record<string, unknown> | undefined;
    if (!info) return null;
    for (const [k, v] of Object.entries(info)) {
      if (k.endsWith(".context_length")) {
        const n = asInt(v);
        if (n !== null) return n;
      }
    }
    return null;
  }
  // LM Studio.
  const body = await json(`${base}/api/v0/models`);
  const data = Array.isArray(body?.data) ? body.data : [];
  const row = data.find((m: unknown) =>
    (m as Record<string, unknown>)?.id === model
  ) as Record<string, unknown> | undefined;
  if (!row) return null;
  return asInt(row.loaded_context_length) ?? asInt(row.max_context_length);
}

export type ChatRequest = {
  baseUrl: string;
  model: string;
  messages: WireMsg[];
  tools: unknown[];
  signal: AbortSignal;
  /** Called with each SSE `data:` payload, already JSON-parsed. */
  onChunk: (chunk: unknown) => void;
};

/** A stalled stream is a hang the user cannot diagnose: the server accepted
 *  the request and then went quiet. Two minutes with no chunk at all — not
 *  slow tokens, *silence* — and the turn is failed with a reason. */
const STREAM_IDLE_MS = () => tunable("CC_STREAM_IDLE_MS", 120_000);

/** A watchdog nobody can wait a real minute for in a test is a watchdog with
 *  no test — these two are env-tunable for exactly that reason, defaults
 *  unchanged in real runs. */
function tunable(name: string, fallback: number): number {
  const v = Number(Deno.env.get(name));
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

/** The partial-line carry between chunks. SSE frames are short; a "stream"
 *  that sends megabytes with no newline is not SSE, and buffering it forever
 *  is the OOM class the file tools already refuse. */
const MAX_SSE_CARRY = 1_048_576;

/**
 * One streamed chat completion. Chunks go to `onChunk` as they arrive; the
 * accumulation lives in `lib/agent.ts` so this function stays transport only.
 */
export async function chatStream(req: ChatRequest): Promise<void> {
  const base = req.baseUrl.replace(/\/+$/, "");
  // The turn's own signal, plus a watchdog that fires only on silence.
  const watchdog = new AbortController();
  let idleTimer = setTimeout(
    () => watchdog.abort(new Error("The server went silent mid-stream.")),
    STREAM_IDLE_MS(),
  );
  const alive = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(
      () => watchdog.abort(new Error("The server went silent mid-stream.")),
      STREAM_IDLE_MS(),
    );
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
        // Usage on the final chunk, where the server supports asking for it —
        // the measured prompt size beats any estimate.
        stream_options: { include_usage: true },
        ...(req.tools.length ? { tools: req.tools } : {}),
      }),
    });
    if (!r.ok || !r.body) {
      const detail = r.body ? clip(await r.text(), 400) : "";
      throw new Error(`HTTP ${r.status}${detail ? ` — ${detail}` : ""}`);
    }

    const decoder = new TextDecoder();
    let buf = "";
    for await (const bytes of r.body) {
      alive();
      buf += decoder.decode(bytes, { stream: true });
      if (buf.length > MAX_SSE_CARRY) {
        throw new Error("The server sent an over-long unterminated frame.");
      }
      // SSE events are newline-delimited; a chunk boundary can split one.
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        const data = line.startsWith("data:") ? line.slice(5).trim() : "";
        if (!data || data === "[DONE]") continue;
        try {
          req.onChunk(JSON.parse(data));
        } catch { /* a torn frame from another program — skip, never throw */ }
      }
    }
  } finally {
    clearTimeout(idleTimer);
  }
}

/* ── run registry ─────────────────────────────────────────────────────────── */

/** The in-flight run per CONVERSATION — process bookkeeping, inherently
 *  mutable, and deliberately here rather than in cell state: an
 *  AbortController is not a value.
 *
 *  Keyed by pane, not by project, because a project holds several chats and
 *  they are allowed to think at the same time. Starting a run cancels the
 *  previous one for the same conversation, and only that one. */
const RUNNING = new Map<string, AbortController>();

export function beginRun(key: string): AbortSignal {
  RUNNING.get(key)?.abort();
  const ctrl = new AbortController();
  RUNNING.set(key, ctrl);
  return ctrl.signal;
}

/** Close out one run — but only the run that owns `signal`. Without the
 *  check, a superseded loop's `finally` would delete its *replacement's*
 *  controller and Stop would silently stop nothing. */
export function endRun(key: string, signal: AbortSignal): void {
  if (RUNNING.get(key)?.signal === signal) RUNNING.delete(key);
}

/** Stop one conversation's run, if it has one in flight. Safe when idle. */
export function stopRun(key: string): void {
  RUNNING.get(key)?.abort();
  RUNNING.delete(key);
  // A turn parked on a decision has to come down with it, or Stop would leave
  // the loop waiting for an answer to a question nobody can see any more.
  answerApproval(key, false);
}

/* ── command approvals ────────────────────────────────────────────────────── */

/**
 * The resolver for a turn parked on "may I run this command".
 *
 * Here rather than in cell state for the same reason as {@link RUNNING}: a
 * promise is not a value. The *question* is state — the page renders it from
 * the chat record — and this is only the wire the answer travels back along.
 */
const ASKING = new Map<string, (allowed: boolean) => void>();

/** Park until the user answers, or until the turn is aborted (which counts as
 *  a refusal — a stopped turn must never go on to run the command). */
export function awaitApproval(
  key: string,
  signal: AbortSignal,
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
    ASKING.set(key, done);
  });
}

/** Answer the question, if one is outstanding. Safe to call when none is. */
export function answerApproval(key: string, allowed: boolean): void {
  const resolve = ASKING.get(key);
  if (!resolve) return;
  ASKING.delete(key);
  resolve(allowed);
}

/* ── tools ────────────────────────────────────────────────────────────────── */

/** Output cap per tool result, in characters — roughly 1.5k tokens. The agent
 *  is told about the clip marker and can narrow the call. */
const MAX_TOOL_CHARS = 6_000;
/** Command wall-clock cap. A local agent's `sh` is for builds and tests, not
 *  for servers; anything longer holds the whole turn hostage. */
const SH_TIMEOUT_MS = () => tunable("CC_SH_TIMEOUT_MS", 60_000);
/** Bytes of command output kept per stream. Enforced while reading — a
 *  `yes`-style firehose costs this much memory, not everything until the
 *  timeout. */
const SH_MAX_BYTES = 262_144;
const MAX_LS_ENTRIES = 200;
const MAX_GREP_HITS = 60;
/** Files one grep call may open. The hit cap bounds output; this bounds the
 *  walk itself, so a huge tree cannot turn one call into minutes of IO. */
const MAX_GREP_FILES = 2_000;
/** Total bytes of file text one grep call may hold in the parent before it is
 *  handed to the worker. Per-file (512KB) × file-count (2000) is a ~1GB worst
 *  case; this is the real ceiling, so a pathological tree spikes tens of MB,
 *  not a gigabyte. */
const MAX_GREP_TOTAL_BYTES = 48 * 1_048_576;
const MAX_READ_LINES = 400;
/** Bytes read from any file by `read`/`grep`. The same guard the preview pane
 *  carries (`catalog.server.ts`): a file's size must never become the app's
 *  memory footprint because a model asked about it. */
const MAX_FILE_BYTES = 524_288;
/** A regex is only ever run against this much of one line. */
const MAX_LINE_SCAN = 1_000;
/** Wall-clock a model-supplied regex gets, across the whole grep, before its
 *  worker is terminated. `safePattern` rejects the obvious bombs cheaply;
 *  this is the guarantee for everything else — no pattern can outlast it. */
const GREP_DEADLINE_MS = () => tunable("CC_GREP_DEADLINE_MS", 2_000);

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
]);

/**
 * Resolve `p` inside `cwd`, or throw. Every filesystem tool funnels through
 * here — the one place the boundary is enforced. Judged on *real* paths:
 * the deepest existing ancestor is `Deno.realPath`ed first, so a symlink
 * pointing out of the project is caught even though the lexical path looks
 * inside (`dep/aio → ~/.local/...` is exactly that shape).
 */
async function inside(cwd: string, p: string): Promise<string> {
  const root = await Deno.realPath(cwd);
  const lexical = normalize(p.startsWith("/") ? p : join(cwd, p || "."));
  // Walk up to the deepest existing ancestor, resolve it for real, then
  // re-attach the not-yet-existing tail (a `write` may create it).
  let existing = lexical;
  let tail = "";
  for (;;) {
    try {
      const real = await Deno.realPath(existing);
      const abs = tail ? join(real, tail) : real;
      if (abs !== root && !abs.startsWith(root + "/")) {
        throw new Error(`Path is outside the project: ${p}`);
      }
      return abs;
    } catch (e) {
      if (e instanceof Error && e.message.startsWith("Path is outside")) {
        throw e;
      }
      const parent = dirname(existing);
      if (parent === existing) {
        throw new Error(`Path is outside the project: ${p}`);
      }
      tail = tail
        ? join(existing.slice(parent.length + 1), tail)
        : existing.slice(parent.length + 1);
      existing = parent;
    }
  }
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown, d: number): number =>
  typeof v === "number" && Number.isFinite(v) ? v : d;

/** The bounded read every text-consuming tool shares: at most
 *  `MAX_FILE_BYTES`, never the whole file. */
async function readCapped(
  path: string,
): Promise<{ text: string; truncated: boolean }> {
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
    return {
      text: new TextDecoder().decode(buf.subarray(0, n)),
      truncated: stat.size > n,
    };
  } finally {
    file.close();
  }
}

async function ls(cwd: string, args: Record<string, unknown>) {
  const dir = await inside(cwd, str(args.path));
  const out: string[] = [];
  for await (const e of Deno.readDir(dir)) {
    out.push(e.isDirectory ? e.name + "/" : e.name);
    if (out.length >= MAX_LS_ENTRIES) {
      out.push("…more entries elided");
      break;
    }
  }
  return out.sort().join("\n") || "(empty)";
}

async function read(cwd: string, args: Record<string, unknown>) {
  const path = await inside(cwd, str(args.path));
  const offset = Math.max(0, Math.floor(num(args.offset, 0)));
  const limit = Math.min(
    MAX_READ_LINES,
    Math.max(1, Math.floor(num(args.limit, MAX_READ_LINES))),
  );
  const { text, truncated } = await readCapped(path);
  const lines = text.split("\n");
  const slice = lines.slice(offset, offset + limit);
  const numbered = slice
    .map((l, i) => `${offset + i + 1}\t${l}`)
    .join("\n");
  const more = offset + limit < lines.length
    ? `\n…${lines.length - offset - limit} more lines`
    : truncated
    ? `\n…file continues past the ${MAX_FILE_BYTES}-byte read window`
    : "";
  return numbered + more;
}

async function grep(
  cwd: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
) {
  const root = await inside(cwd, str(args.path));
  // Cheap fast-reject for the obvious catastrophic shapes — saves spinning a
  // worker for a pattern we already know is bad, and gives a precise message.
  if (!safePattern(str(args.pattern))) {
    return "Error: that pattern is too complex to run safely — " +
      "use simpler syntax or literal text.";
  }
  // Collect the candidate lines (bounded IO), then hand the actual matching to
  // a worker under a deadline: a regex cannot be interrupted on its own thread,
  // so the only real bound is a disposable worker the parent can terminate.
  const docs: { path: string; lines: string[] }[] = [];
  let scanned = 0;
  let totalBytes = 0;
  let budgetHit = false;
  const collect = async (path: string): Promise<void> => {
    if (signal?.aborted) throw new Error("Stopped.");
    if (scanned >= MAX_GREP_FILES || totalBytes >= MAX_GREP_TOTAL_BYTES) return;
    scanned++;
    try {
      const text = (await readCapped(path)).text;
      totalBytes += text.length;
      // Set the moment the budget is crossed — the walk's own guard returns
      // before collect is called again, so this cannot wait for a next call.
      if (totalBytes >= MAX_GREP_TOTAL_BYTES) budgetHit = true;
      docs.push({ path, lines: text.split("\n") });
    } catch { /* binary or unreadable — not what grep is for */ }
  };
  async function walk(dir: string): Promise<void> {
    for await (const e of Deno.readDir(dir)) {
      if (scanned > MAX_GREP_FILES || totalBytes >= MAX_GREP_TOTAL_BYTES) {
        return;
      }
      if (signal?.aborted) throw new Error("Stopped.");
      if (e.isSymlink) continue; // a symlink can point anywhere
      const p = join(dir, e.name);
      if (e.isDirectory) {
        if (!SKIP.has(e.name)) await walk(p);
      } else if (e.isFile) {
        await collect(p);
      }
    }
  }
  const info = await Deno.stat(root);
  if (info.isFile) await collect(root);
  else await walk(root);

  const result = await matchInWorker(
    str(args.pattern),
    docs,
    signal,
  );
  if (result === "timeout") {
    return "Error: that search took too long and was stopped — " +
      "use simpler syntax or a narrower path.";
  }
  if (result === "stopped") return "Stopped.";
  if (result === "failed") {
    return "Error: the search could not run — try again or use literal text.";
  }
  if (result === null) return "Error: that is not a valid regular expression.";
  const elided = result.length >= MAX_GREP_HITS
    ? "\n…more hits elided"
    : budgetHit
    ? "\n…search stopped at the size budget — narrow the path"
    : scanned > MAX_GREP_FILES
    ? `\n…search stopped after ${MAX_GREP_FILES} files — narrow the path`
    : "";
  return result.length ? result.join("\n") + elided : "No matches." + elided;
}

/**
 * Run the pattern over the collected docs in a worker, bounded by a deadline
 * and by the turn's Stop. Returns the hits, or a sentinel: `"timeout"` when
 * the deadline fired, `"stopped"` on abort, `null` when the regex would not
 * compile. The worker is always terminated — on success, timeout or abort —
 * so a pathological match cannot outlive this call.
 *
 * A dedicated worker rather than aio's `blocking()` pool (dep/aio
 * docs/basics/api-reference.md): the whole point is `terminate()`, and a
 * synchronous regex wedged on a *pooled* worker would poison that slot with no
 * way to reclaim it. A disposable worker is the thing you are allowed to throw
 * away.
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

async function write(cwd: string, args: Record<string, unknown>) {
  const path = await inside(cwd, str(args.path));
  // `inside` realpaths the deepest *existing* ancestor — a dangling symlink
  // as the final component survives that check, and writeTextFile would then
  // follow it out of the project. Refused by looking at the link itself.
  const lst = await Deno.lstat(path).catch(() => null);
  if (lst?.isSymlink) {
    throw new Error(`Refusing to write through a symlink: ${str(args.path)}`);
  }
  const content = str(args.content);
  await Deno.mkdir(dirname(path), { recursive: true }).catch(() => {});
  await Deno.writeTextFile(path, content);
  return `Wrote ${content.length} chars to ${path}`;
}

/** Read a stream keeping only the first `cap` bytes; the rest is drained and
 *  dropped so the child never blocks on a full pipe. `killed` unblocks the
 *  read: an escaped grandchild (`setsid … &` from inside the command) can hold
 *  the pipe open long after the shell is dead, and without the cancel this
 *  await — and the whole turn — would wait out that child's entire life. */
async function drainCapped(
  stream: ReadableStream<Uint8Array>,
  cap: number,
  killed: AbortSignal,
): Promise<{ text: string; truncated: boolean }> {
  const reader = stream.getReader();
  const cancel = () => void reader.cancel().catch(() => {});
  if (killed.aborted) cancel();
  killed.addEventListener("abort", cancel, { once: true });
  const kept: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      if (size < cap) {
        const take = value.subarray(0, cap - size);
        kept.push(take);
        size += take.length;
        truncated = truncated || take.length < value.length;
      } else {
        truncated = true;
      }
    }
  } finally {
    killed.removeEventListener("abort", cancel);
  }
  const all = new Uint8Array(size);
  let off = 0;
  for (const c of kept) {
    all.set(c, off);
    off += c.length;
  }
  return { text: new TextDecoder().decode(all), truncated };
}

async function sh(
  cwd: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
) {
  const cmd = str(args.cmd);
  if (!cmd) throw new Error("Empty command.");
  // Log that a command ran and how big it was, never its text: a model (or a
  // prompt injected into one) could be steered to `echo $SECRET`, and a log
  // line is a place that outlives the turn. The full command is on screen in
  // the transcript for the user who wants it.
  log.info("local", "sh ran", { chars: cmd.length });
  // `setsid` makes the shell a process-group leader, so the kill below takes
  // its whole tree — a `deno task dev` started by the model must not outlive
  // the turn that started it.
  const child = new Deno.Command("setsid", {
    args: ["bash", "-c", cmd],
    cwd,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).spawn();

  // One controller answers every way this command can be forced down —
  // timeout, the turn's Stop, and cleanup — and it also cancels the pipe
  // reads, because a command can leave a grandchild in a *new* session
  // (`setsid … &`) that survives the group kill holding our pipes open.
  const killed = new AbortController();
  let timedOut = false;
  const killTree = () => {
    try {
      Deno.kill(-child.pid, "SIGKILL");
    } catch { /* already gone */ }
    killed.abort();
  };
  const shTimeout = SH_TIMEOUT_MS();
  const timer = setTimeout(() => {
    timedOut = true;
    log.warn("local", "sh timed out — killing its process group", {
      chars: cmd.length,
      afterMs: shTimeout,
    });
    killTree();
  }, shTimeout);
  const onAbort = () => killTree();
  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    const [out, err, status] = await Promise.all([
      drainCapped(child.stdout, SH_MAX_BYTES, killed.signal),
      drainCapped(child.stderr, SH_MAX_BYTES, killed.signal),
      child.status,
    ]);
    const text = out.text + err.text;
    const cut = out.truncated || err.truncated ? "\n[output truncated]" : "";
    const fate = timedOut
      ? `\n[killed after ${shTimeout / 1000}s]`
      : status.success
      ? ""
      : `\n[exit ${status.code}]`;
    return (text || "(no output)") + cut + fate;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
    killTree();
  }
}

const EXECUTORS: Record<
  string,
  (
    cwd: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<string>
> = { ls, read, grep, write, sh };

/**
 * Execute one tool call. The gate is by mode and name — never by trusting the
 * request — and every result is clipped here, so an oversized output cannot
 * reach the packer in the first place. `signal` is the turn's abort: Stop
 * must stop a running command, not just the next network call.
 */
export async function runTool(
  mode: LocalMode,
  cwd: string,
  name: string,
  rawArgs: string,
  signal?: AbortSignal,
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
  try {
    return clip(await EXECUTORS[name](cwd, args, signal), MAX_TOOL_CHARS);
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    // A refused boundary is worth a trace — it is either a confused model or
    // an attempted escape, and both deserve to be visible in the log.
    if (why.includes("outside the project") || why.includes("symlink")) {
      // The reason, not the attempted path: the path is model-authored and a
      // log line outlives the turn.
      log.warn("local", "path refused at the project boundary", { tool: name });
    }
    // The error goes back to the *model* — it is part of the loop, and a
    // precise message is what lets it correct the call.
    return `Error: ${why}`;
  }
}
