/**
 * @module
 * The pure core of the local agent: prompt, tool schemas, token budgeting,
 * context packing and OpenAI-style stream accumulation. Nothing in this file
 * touches aio, Deno, or the network — it is all functions over values, so the
 * part of the agent that must be *right* is the part that is trivially
 * testable.
 *
 * Context frugality is the design constraint throughout: local models often
 * run with 64k or less, so the system prompt is short, the tool schemas are
 * terse, tool results are clipped at the source, and packing evicts the
 * cheapest tokens first (old tool output, then old turns behind a summary).
 */
import type {
  LocalConfig,
  LocalMode,
  LocalMsg,
  LocalPermission,
  LocalToolCall,
} from "../type/local.ts";

/* ── permission ───────────────────────────────────────────────────────────── */

/** The modes the picker offers, worded the way the Claude side words its own —
 *  the app should not have two vocabularies for one idea. */
export const LOCAL_PERMISSIONS: {
  id: LocalPermission;
  label: string;
  hint: string;
}[] = [
  {
    id: "ask",
    label: "Ask every time",
    hint: "See each command before it runs",
  },
  {
    id: "dontAsk",
    label: "Don't ask",
    hint: "Runs commands unasked — destructive ones are still refused",
  },
  { id: "bypass", label: "Bypass", hint: "No checks at all. Anything runs." },
];

/**
 * A project's permission mode, including one configured before there were
 * three of them.
 *
 * Anything unrecognised reads as `ask`: a junk value from a persisted file, a
 * hand-edited config or a future version must fail *closed*, because the value
 * decides whether a shell command runs without anyone seeing it.
 */
export function permissionOf(cfg: LocalConfig | undefined): LocalPermission {
  const p = cfg?.permission;
  if (p === "bypass" || p === "dontAsk" || p === "ask") return p;
  // The two-valued field this replaced. "always" meant exactly today's bypass.
  return cfg?.shApproval === "always" ? "bypass" : "ask";
}

/**
 * Why a shell command is too dangerous to run unwatched, or `null` if nothing
 * matched.
 *
 * This is the guardrail behind "Don't ask": no prompts, but no quiet damage
 * either. It is a *deny-list over words*, which cannot be complete — a
 * determined model can obfuscate any of these — so it is not a sandbox and is
 * never described as one. It is the difference between an agent that tidies a
 * build directory unasked and one that deletes a working tree unasked, and
 * that difference is worth having even though the list has a floor.
 *
 * The whole string is scanned, not just its first word: `ls && rm -rf .` is an
 * `rm`, and so is `x=1; sudo rm`. Over-refusing is the safe direction — the
 * answer goes back to the model as words, and the user can pick Bypass.
 */
export function destructiveReason(cmd: string): string | null {
  const text = String(cmd ?? "");
  // Lower-cased and with separators normalised to spaces, so `;rm`, `&&rm`,
  // `|rm`, `$(rm` and a newline all present the word the same way.
  const flat = ` ${text.toLowerCase().replace(/[;&|()<>{}`\n\r\t]+/g, " ")} `;
  const has = (word: string) => flat.includes(` ${word} `);
  const hasAny = (...words: string[]) => words.some(has);

  if (hasAny("sudo", "doas", "su", "pkexec")) {
    return "it asks for another user's powers (sudo/su)";
  }
  if (hasAny("rm", "rmdir", "shred", "unlink", "truncate")) {
    return "it deletes or truncates files (rm/shred/truncate)";
  }
  if (/\s-delete\b/.test(flat) || /\bfind\b[^\n]*\s-exec\b/.test(flat)) {
    return "it deletes what it finds (find -delete/-exec)";
  }
  if (hasAny("dd", "mkfs", "fdisk", "parted", "sfdisk", "wipefs")) {
    return "it writes to a disk directly (dd/mkfs/fdisk)";
  }
  if (
    hasAny("kill", "killall", "pkill", "reboot", "shutdown", "halt", "poweroff")
  ) {
    return "it kills processes or the machine (kill/reboot)";
  }
  if (hasAny("chown", "chmod", "chgrp") && /\s-r\b/i.test(flat)) {
    return "it rewrites ownership or permissions in bulk (chown/chmod -R)";
  }
  if (/\bgit\b/.test(flat)) {
    if (
      /\bgit\s+reset\b[^\n]*--hard/.test(flat) ||
      /\bgit\s+clean\b[^\n]*\s-[a-z]*[fdx]/.test(flat) ||
      /\bgit\s+checkout\b[^\n]*\s--\s/.test(flat) ||
      /\bgit\s+restore\b/.test(flat)
    ) {
      return "it throws away uncommitted work (git reset --hard / clean -f)";
    }
    if (/\bgit\s+push\b/.test(flat)) {
      return "it publishes to a remote (git push)";
    }
    if (/\bgit\s+branch\b[^\n]*\s-d\b/i.test(flat)) {
      return "it deletes a branch (git branch -D)";
    }
  }
  // A download piped into an interpreter is somebody else's code running as
  // you, which no amount of reading the command tells you the contents of.
  if (
    /\b(curl|wget)\b/.test(flat) &&
    /\|\s*(sh|bash|zsh|python\d?|node|deno)\b/.test(text.toLowerCase())
  ) {
    return "it pipes a download straight into a shell";
  }
  if (
    /\b(npm|pnpm|yarn|deno|cargo|gh)\b/.test(flat) && /\bpublish\b/.test(flat)
  ) {
    return "it publishes a package (npm/deno publish)";
  }
  if (hasAny("docker", "podman") && /\b(rm|rmi|prune)\b/.test(flat)) {
    return "it removes containers or images (docker rm/prune)";
  }
  if (/:\s*\(\s*\)\s*\{/.test(text)) return "it looks like a fork bomb";
  return null;
}

/* ── token arithmetic ─────────────────────────────────────────────────────── */

/** Estimated tokens for a string. Chars/4 is the standard rough cut for
 *  English-and-code; +4 covers per-message wrapping. Estimation only ever
 *  feeds *budgeting*, so erring slightly high is the safe direction. */
export const estTokens = (text: string): number =>
  Math.ceil(text.length / 4) + 4;

/** Output headroom reserved out of the window: an eighth, clamped so a 64k
 *  model keeps a real answer's worth and a 1M model does not waste 128k. */
export const outputReserve = (ctx: number): number =>
  Math.min(Math.max(Math.floor(ctx / 8), 512), 4_096);

/* ── prompt ───────────────────────────────────────────────────────────────── */

/** The whole system prompt. Kept under ~150 tokens on purpose: on a 64k model
 *  every line here is paid on every request of every turn. */
export function systemPrompt(mode: LocalMode, cwd: string): string {
  const base = `You are a coding agent working in ${cwd}.` +
    ` Be direct and brief; never restate tool output the user already saw.`;
  if (mode === "chat") return base + ` You have no tools; answer from context.`;
  const shared = ` Use tools to look before answering; prefer targeted reads` +
    ` (grep, then read with offset/limit) over reading whole files.` +
    ` Tool output is truncated at the marker; re-call with a narrower range` +
    ` if you need more.`;
  if (mode === "read") {
    return base + shared + ` You are read-only: you cannot change anything.`;
  }
  return base + shared +
    ` Make changes with write; verify them (build/tests via sh) before` +
    ` declaring done.`;
}

/* ── tools ────────────────────────────────────────────────────────────────── */

type ToolSpec = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

const P = (
  props: Record<string, { type: string; description?: string }>,
  required: string[],
) => ({ type: "object", properties: props, required });

/** Five small tools, terse on purpose — schemas ride along on every request.
 *  `read` before `write`: weaker models copy the order they see. */
const ALL_TOOLS: ToolSpec[] = [
  {
    type: "function",
    function: {
      name: "ls",
      description: "List a directory (relative to the project).",
      parameters: P({ path: { type: "string" } }, []),
    },
  },
  {
    type: "function",
    function: {
      name: "read",
      description: "Read a file. Use offset/limit (lines) for large files.",
      parameters: P({
        path: { type: "string" },
        offset: { type: "number" },
        limit: { type: "number" },
      }, ["path"]),
    },
  },
  {
    type: "function",
    function: {
      name: "grep",
      description: "Search file contents for a regex; returns file:line hits.",
      parameters: P({
        pattern: { type: "string" },
        path: { type: "string", description: "subtree to search" },
      }, ["pattern"]),
    },
  },
  {
    type: "function",
    function: {
      name: "write",
      description: "Write a whole file (creates directories).",
      parameters: P({
        path: { type: "string" },
        content: { type: "string" },
      }, ["path", "content"]),
    },
  },
  {
    type: "function",
    function: {
      name: "sh",
      description: "Run a shell command in the project; returns stdout+stderr.",
      parameters: P({ cmd: { type: "string" } }, ["cmd"]),
    },
  },
];

/** Tool names a mode may execute. The single source of truth — the executor
 *  gates on this same list, so the schema sent and the act allowed can never
 *  disagree. */
/** Every tool that exists, in one place — so a refusal can name the real ones
 *  instead of only saying no. A model that invented `list_files` corrects
 *  itself from this list; without it, it invents another one. */
export const TOOL_NAMES: string[] = ALL_TOOLS.map((t) => t.function.name);

export const allowedTools = (mode: LocalMode): string[] =>
  mode === "agent"
    ? ["ls", "read", "grep", "write", "sh"]
    : mode === "read"
    ? ["ls", "read", "grep"]
    : [];

export const toolSpecs = (mode: LocalMode): ToolSpec[] =>
  ALL_TOOLS.filter((t) => allowedTools(mode).includes(t.function.name));

/**
 * Give every tool call an id.
 *
 * The protocol pairs a result to its call by id, and plenty of servers stream
 * tool calls without one. Every result then comes back tagged `""` — which is
 * indistinguishable from every other result the moment the model asks for two
 * things at once, and rejected outright by some chat templates. A positional
 * id is stable inside the turn, which is the only place it means anything.
 */
export const withCallIds = (
  calls: LocalToolCall[],
  round: number,
): LocalToolCall[] =>
  calls.map((c, i) => c.id ? c : { ...c, id: `call_${round}_${i}` });

/** Tools whose answer does not change unless something else changes it. An
 *  identical repeat of one of these in the same turn is a model that has lost
 *  the thread, and re-running it spends a round to learn nothing. */
export const REPEATABLE: ReadonlySet<string> = new Set(["ls", "read", "grep"]);

/* ── errors ───────────────────────────────────────────────────────────────── */

/** The one server error that names its own fix. llama.cpp without `--jinja`
 *  refuses every request carrying tools, so the symptom is "chat works, the
 *  agent does not" — with a raw HTTP 500 as the only clue. */
export const isNoToolSupport = (raw: string): boolean =>
  raw.includes("--jinja");

/**
 * Turn a server's own error into something the reader can act on.
 *
 * Pure and tiny on purpose: an error message is part of the product, and the
 * raw `HTTP 500 — {"error":{...}}` a local server produces is not one a user
 * can do anything with.
 */
export const explainError = (
  raw: string,
  server?: { baseUrl?: string; engine?: string; found?: string | null },
): string => {
  if (isNoToolSupport(raw)) {
    return "This llama.cpp server has the Jinja templating that tool calls " +
      "need turned off, so Read-only and Agent modes cannot work against it — " +
      "only Chat. Current builds have it on unless --no-jinja was passed; an " +
      "older one needs --jinja (llama-server --jinja -m your-model.gguf). " +
      "Restart it, then send again.";
  }
  if (isUnreachable(raw)) {
    const at = server?.baseUrl ? ` at ${server.baseUrl}` : "";
    // The saved address is deliberately NOT corrected here: a hand-typed
    // address is a choice, and silently repointing a project at a different
    // server is how you end up talking to the wrong one. The app looks, says
    // what it found, and leaves the switch to a button.
    const found = server?.found && server.found !== server.baseUrl
      ? ` A ${server.engine ?? "local"} server IS answering at ${server.found}.`
      : ` Check that the server is running, and that its address matches` +
        ` the one set in Settings.`;
    return `Nothing answered${at}.${found}`;
  }
  return raw;
};

/**
 * The server is not there — as opposed to there and unhappy.
 *
 * Every runtime spells it differently and none of them spell it for a reader:
 * Deno's `fetch` says "error sending request for url (…)" and, wrapped, the
 * bare "fetch failed" that started this. A saved address that has gone dead is
 * the commonest local-engine failure there is — a server moved to another port,
 * or simply not started yet — and "fetch failed" is the least useful sentence
 * it could produce.
 */
export const isUnreachable = (raw: string): boolean =>
  /fetch failed|error sending request|connection refused|econnrefused|connect error|network error|client error \(SendRequest\)/i
    .test(raw);

/* ── clipping ─────────────────────────────────────────────────────────────── */

export const CLIP_MARK = "\n[…truncated — narrow the call for more]\n";

/** Head-and-tail clip for tool output. The head carries the answer most of the
 *  time; the tail carries the error, which is always at the end. */
export function clip(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const head = Math.floor(maxChars * 0.8);
  const tail = maxChars - head;
  return text.slice(0, head) + CLIP_MARK + text.slice(text.length - tail);
}

/**
 * Gate on a model-supplied regex before it is ever compiled and run.
 *
 * V8 regexes are synchronous and backtracking: `(a+)+b` is measurably
 * exponential (over a second at 28 characters), so an input-size cap alone is
 * no defence — one bad pattern wedges the whole single-threaded process, with
 * no Stop and no recovery. Refused here, conservatively: no backreferences,
 * no quantifier applied to a group that itself contains a quantifier or an
 * alternation, bounded length and quantifier count. False negatives cost the
 * model a retry with simpler syntax; a false positive would cost the machine.
 */
export function safePattern(pattern: string): boolean {
  if (pattern.length > 128) return false;
  if (/\\[1-9]/.test(pattern)) return false; // backreferences
  const quantifiers = pattern.match(/[*+{?]/g)?.length ?? 0;
  if (quantifiers > 8) return false;
  // Scan for a quantified group whose body contains a quantifier, an
  // alternation, or another group — the catastrophic shapes, at ANY nesting
  // depth (((a+))+ is as bad as (a+)+, and a lint that only reads one level
  // was bypassed by exactly that). Escapes are skipped; character classes
  // are opaque (parens inside [] are literals).
  const starts: number[] = [];
  let inClass = false;
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "\\") {
      i++;
      continue;
    }
    if (inClass) {
      if (ch === "]") inClass = false;
      continue;
    }
    if (ch === "[") inClass = true;
    else if (ch === "(") starts.push(i);
    else if (ch === ")") {
      const open = starts.pop();
      if (open === undefined) return false; // unbalanced — let RegExp refuse it? refuse here
      const next = pattern[i + 1];
      if (next === "*" || next === "+" || next === "{" || next === "?") {
        const body = pattern.slice(open + 1, i);
        // Escaped chars in the body are literals — blank them first.
        const bare = body.replace(/\\./g, "");
        if (/[*+{|(]/.test(bare)) return false;
      }
    }
  }
  return true;
}

/** What an evicted tool result shrinks to in context: enough to know the call
 *  happened and what it was about, at ~10 tokens. */
export const stubOf = (m: LocalMsg): string =>
  `[${m.toolName ?? "tool"} result elided]`;

/* ── packing ──────────────────────────────────────────────────────────────── */

/** One OpenAI-shaped wire message. */
export type WireMsg = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: {
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }[];
  tool_call_id?: string;
};

export type Packed = {
  wire: WireMsg[];
  /** ids of transcript rows that no longer fit and must be marked evicted —
   *  the caller summarizes them into `summary` for the next request. */
  evict: string[];
  /** estimated prompt tokens of `wire`. */
  tokens: number;
};

const toWire = (m: LocalMsg, stubbed: boolean): WireMsg =>
  m.role === "tool"
    ? {
      role: "tool",
      content: stubbed ? stubOf(m) : m.text,
      tool_call_id: m.toolCallId ?? "",
    }
    : {
      role: m.role,
      content: m.text,
      ...(m.toolCalls?.length
        ? {
          tool_calls: m.toolCalls.map((c) => ({
            id: c.id,
            type: "function" as const,
            function: { name: c.name, arguments: c.args },
          })),
        }
        : {}),
    };

/**
 * Fit the conversation into the window.
 *
 * Budget = ctx − output reserve − fixed parts (system prompt, tool schemas,
 * summary). Then, newest first, keep rows until the budget is spent — with two
 * cheapening passes before anything is lost outright:
 *
 *  1. tool results outside the last `FRESH` rows are sent as one-line stubs
 *     (the model already acted on them; their bulk is the cheapest to shed);
 *  2. rows that still do not fit are dropped and reported in `evict`, to be
 *     folded into the rolling summary by the caller.
 *
 * An assistant row whose tool calls have results inside the kept window is
 * never dropped alone — OpenAI-shaped servers reject a `tool` message whose
 * call is missing, so eviction happens at whole-exchange granularity.
 */
export function packContext(
  msgs: LocalMsg[],
  cfg: Pick<LocalConfig, "ctx" | "mode">,
  summary: string,
  cwd: string,
): Packed {
  const FRESH = 6;
  const sys = systemPrompt(cfg.mode, cwd);
  const schemaCost = estTokens(JSON.stringify(toolSpecs(cfg.mode)));
  const fixed = estTokens(sys) + schemaCost +
    (summary ? estTokens(summary) : 0);
  const budget = cfg.ctx - outputReserve(cfg.ctx) - fixed;

  const live = msgs.filter((m) => !m.evicted);

  // Pass 1: cost per row, with older tool results priced as stubs.
  const cost = live.map((m, i) => {
    const stubbed = m.role === "tool" && i < live.length - FRESH;
    return {
      m,
      stubbed,
      t: stubbed ? estTokens(stubOf(m)) : estTokens(m.text) +
        (m.toolCalls ?? []).reduce(
          (n, c) => n + estTokens(c.name + c.args),
          0,
        ),
    };
  });

  // Pass 2: keep from the newest backwards. The cut lands on an exchange
  // boundary: never keep a tool row whose assistant call fell off.
  let spent = 0;
  let cut = 0; // first kept index
  for (let i = cost.length - 1; i >= 0; i--) {
    if (spent + cost[i].t > budget) {
      cut = i + 1;
      break;
    }
    spent += cost[i].t;
  }
  while (cut < cost.length && cost[cut].m.role === "tool") {
    spent -= cost[cut].t;
    cut++;
  }
  if (cut >= cost.length && cost.length > 0) {
    // Over budget even for the newest exchange: send it anyway — the server's
    // own context error is more honest than an empty conversation.
    cut = cost.length - 1;
    while (cut > 0 && cost[cut].m.role === "tool") cut--;
    spent = cost.slice(cut).reduce((n, c) => n + c.t, 0);
  }

  const evict = cost.slice(0, cut).map((c) => c.m.id);
  const wire: WireMsg[] = [{ role: "system", content: sys }];
  if (summary || evict.length) {
    wire.push({
      role: "system",
      content: summary || "[earlier conversation elided]",
    });
  }
  for (const c of cost.slice(cut)) wire.push(toWire(c.m, c.stubbed));

  return { wire, evict, tokens: fixed + spent };
}

/** The prompt asking the model to fold dropped rows into the rolling summary.
 *  Small in, small out: input is clipped by the caller, output is capped. */
export const summarizePrompt = (prev: string, dropped: string): string =>
  `Update this running summary of an ongoing coding session so the work can` +
  ` continue without the original text. Keep every fact still needed (paths,` +
  ` decisions, open problems), drop everything else. Reply with the summary` +
  ` only, under 120 words.\n\nSummary so far:\n${prev || "(none)"}\n\n` +
  `Newly dropped conversation:\n${dropped}`;

/* ── streaming ────────────────────────────────────────────────────────────── */

/** What one streamed completion accumulates into. */
export type StreamAcc = {
  text: string;
  toolCalls: LocalToolCall[];
  finish: string | null;
  /** Prompt tokens as the server reported them, when it did. */
  promptTokens: number | null;
  /**
   * Completion tokens as the server reported them.
   *
   * `null` when it did not — which is common, and is why the speed figure this
   * feeds is absent rather than estimated. A tokens-per-second number computed
   * from a character count would be wrong by whatever the tokeniser happens to
   * do with this model's vocabulary, and wrong in a way nobody could see.
   */
  completionTokens: number | null;
};

export const newAcc = (): StreamAcc => ({
  text: "",
  toolCalls: [],
  finish: null,
  promptTokens: null,
  completionTokens: null,
});

/** Ceilings on what one streamed reply may accumulate. The stream comes from
 *  a server the user pointed at — a value off the wire is never trusted to
 *  size an allocation or to grow state without bound. */
const MAX_ACC_TEXT = 4_000_000;
const MAX_ACC_TOOL_CALLS = 32;
const MAX_ACC_TOOL_NAME = 256;
const MAX_ACC_TOOL_ARGS = 1_000_000;

/**
 * Fold one parsed SSE chunk (`data: {...}` payload of a chat completion) into
 * the accumulator. Tolerant by construction: a malformed chunk changes
 * nothing, because the stream belongs to another program.
 */
export function foldChunk(acc: StreamAcc, chunk: unknown): StreamAcc {
  if (!chunk || typeof chunk !== "object") return acc;
  const c = chunk as Record<string, unknown>;
  const usage = c.usage as Record<string, unknown> | undefined;
  if (usage && typeof usage.prompt_tokens === "number") {
    acc.promptTokens = usage.prompt_tokens;
  }
  if (usage && typeof usage.completion_tokens === "number") {
    acc.completionTokens = usage.completion_tokens;
  }
  const choice = Array.isArray(c.choices)
    ? c.choices[0] as Record<string, unknown> | undefined
    : undefined;
  if (!choice) return acc;
  if (typeof choice.finish_reason === "string") {
    acc.finish = choice.finish_reason;
  }
  const delta = choice.delta as Record<string, unknown> | undefined;
  if (!delta) return acc;
  if (typeof delta.content === "string" && acc.text.length < MAX_ACC_TEXT) {
    acc.text += delta.content;
  }
  if (Array.isArray(delta.tool_calls)) {
    for (const raw of delta.tool_calls) {
      const tc = raw as Record<string, unknown>;
      // The index sizes an array — an `index: 1e9` (or Infinity) from a
      // hostile server must not become a billion allocations or a spin.
      const i = typeof tc.index === "number" && Number.isInteger(tc.index) &&
          tc.index >= 0 && tc.index < MAX_ACC_TOOL_CALLS
        ? tc.index
        : 0;
      while (acc.toolCalls.length <= i) {
        acc.toolCalls.push({ id: "", name: "", args: "" });
      }
      const slot = acc.toolCalls[i];
      if (typeof tc.id === "string") slot.id = slot.id || tc.id;
      const fn = tc.function as Record<string, unknown> | undefined;
      if (fn) {
        // Same stance as text above: wire values grow state, so they stop at
        // a ceiling instead of trusting the server to stop.
        if (
          typeof fn.name === "string" && slot.name.length < MAX_ACC_TOOL_NAME
        ) {
          slot.name += fn.name;
        }
        if (
          typeof fn.arguments === "string" &&
          slot.args.length < MAX_ACC_TOOL_ARGS
        ) {
          slot.args += fn.arguments;
        }
      }
    }
  }
  return acc;
}
