/**
 * @module
 * Pure readers over the Claude Code `stream-json` protocol.
 *
 * Everything the app knows about a session is derived here, so the interesting
 * logic is testable without spawning a process. Nothing in this file touches
 * aio, Deno, or the DOM.
 */
import type {
  Block,
  ModelOption,
  PermissionRequest,
  PermissionSuggestion,
  Usage,
} from "../type/claude.ts";
import { oneLine, tailPath } from "./format.ts";

/** A raw line from the CLI. Deliberately loose — the protocol grows. */
export type Evt = Record<string, unknown>;

/** Models offered in the picker. `contextWindow` is only the fallback: the
 *  live value reported by the CLI always wins (see {@link contextWindowOf}). */
export const MODELS: ModelOption[] = [
  {
    id: "opus",
    label: "Opus",
    hint: "Deepest reasoning",
    contextWindow: 200_000,
  },
  {
    id: "sonnet",
    label: "Sonnet",
    hint: "Balanced default",
    contextWindow: 200_000,
  },
  {
    id: "fable",
    label: "Fable",
    hint: "Newest frontier",
    contextWindow: 200_000,
  },
  {
    id: "haiku",
    label: "Haiku",
    hint: "Fastest, cheapest",
    contextWindow: 200_000,
  },
];

export const PERMISSION_MODES: { id: string; label: string; hint: string }[] = [
  { id: "default", label: "Ask", hint: "Prompt before every sensitive action" },
  {
    id: "manual",
    label: "Ask always",
    // Not literally every call: the CLI still clears what it considers harmless
    // on its own (an `echo` runs, a `Write` asks — measured against 2.1.232).
    hint: "Edits and anything consequential wait for you",
  },
  {
    id: "acceptEdits",
    label: "Accept edits",
    hint: "File edits auto-approved",
  },
  { id: "plan", label: "Plan", hint: "Research and plan, never modify" },
  { id: "dontAsk", label: "Don't ask", hint: "Skip prompts, keep guardrails" },
  {
    id: "bypassPermissions",
    label: "Bypass",
    hint: "No checks — trusted sandboxes only",
  },
];

/** Tools that spawn a sub-agent rather than doing the work inline. */
const AGENT_TOOLS = new Set(["Task", "Agent", "Workflow"]);

export const isAgentTool = (name: string): boolean => AGENT_TOOLS.has(name);

const str = (v: unknown): string | null =>
  typeof v === "string" && v.length > 0 ? v : null;
const num = (v: unknown): number => (typeof v === "number" ? v : 0);
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v)
    ? v as Record<string, unknown>
    : {};
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** Parse one NDJSON line; `null` for blank lines and non-JSON noise. */
export function parseLine(line: string): Evt | null {
  const t = line.trim();
  if (!t.startsWith("{")) return null;
  try {
    const v = JSON.parse(t);
    return v && typeof v === "object" ? v as Evt : null;
  } catch {
    return null;
  }
}

/** The `usage` block of an assistant message or a result, normalized. */
export function usageOf(raw: unknown, fallbackWindow: number): Usage {
  const u = obj(raw);
  return {
    input: num(u.input_tokens),
    output: num(u.output_tokens),
    cacheRead: num(u.cache_read_input_tokens),
    cacheCreate: num(u.cache_creation_input_tokens),
    contextWindow: fallbackWindow,
  };
}

/** Context actually occupied by the last request — everything the model had to
 *  read, plus what it wrote. Cache reads count: they are still in the window. */
export const contextUsed = (u: Usage): number =>
  u.input + u.cacheRead + u.cacheCreate + u.output;

/** What `modelUsage` reports for one model id, matching a full id against an
 *  alias in either direction (`haiku` ↔ `claude-haiku-4-5-20251001`) and against
 *  the `canonicalModel` each entry carries. `0` when it says nothing. */
function windowFor(models: Record<string, unknown>, id: string): number {
  return Math.max(
    0,
    ...Object.entries(models)
      .filter(([key, entry]) =>
        key === id || id.includes(key) || key.includes(id) ||
        str(obj(entry).canonicalModel) === id
      )
      .map(([, entry]) => num(obj(entry).contextWindow)),
  );
}

/**
 * The real context window, straight from the CLI's `modelUsage` map when it
 * reports one (it knows about 1M-context variants we would otherwise guess).
 *
 * `model` is the session's own, and it is asked for first: `modelUsage` covers
 * every model the turn touched, so a sub-agent handed a different one appears
 * beside the main conversation — and taking the largest window in the map let a
 * 1M sub-agent widen the meter for a 200k transcript, under-reporting exactly
 * the pressure it exists to show. The largest is still the answer when the
 * session's model is not in the map at all.
 */
export function contextWindowOf(
  result: Evt,
  fallback: number,
  model: string | null = null,
): number {
  const models = obj(result.modelUsage);
  const own = model === null ? 0 : windowFor(models, model);
  if (own > 0) return own;
  const best = Math.max(
    0,
    ...Object.values(models).map((entry) => num(obj(entry).contextWindow)),
  );
  return best > 0 ? best : fallback;
}

/** The long-context variant of a model wears its window in its id:
 *  `claude-opus-5[1m]`. Before the first result there is nothing else to read it
 *  from, and guessing 200k made a 1M session look 5× fuller than it was. */
const LONG_CONTEXT = /\[1m\]/i;

/** Fallback window for a model id, used until the CLI reports the real one. */
export function fallbackWindow(model: string | null): number {
  if (model && LONG_CONTEXT.test(model)) return 1_000_000;
  const hit = MODELS.find((m) => model?.includes(m.id));
  return hit ? hit.contextWindow : 200_000;
}

/** Turn one `assistant`/`user` message payload into renderable blocks. */
export function blocksOf(message: unknown): Block[] {
  const out: Block[] = [];
  for (const raw of arr(obj(message).content)) {
    const b = obj(raw);
    const type = str(b.type);
    if (type === "text") {
      const text = str(b.text);
      if (text) out.push({ kind: "text", text });
    } else if (type === "thinking") {
      const text = str(b.thinking);
      if (text) out.push({ kind: "thinking", text });
    } else if (type === "tool_use") {
      out.push({
        kind: "tool",
        id: str(b.id) ?? "",
        name: str(b.name) ?? "tool",
        input: obj(b.input),
      });
    } else if (type === "tool_result") {
      out.push({
        kind: "result",
        id: str(b.tool_use_id) ?? "",
        ok: b.is_error !== true,
        text: resultText(b.content),
      });
    }
  }
  return out;
}

/** `tool_result.content` is a string or a content-block array. Flatten both. */
export function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  return arr(content)
    .map((c) => str(obj(c).text) ?? "")
    .filter(Boolean)
    .join("\n");
}

/* ── control channel ──────────────────────────────────────────────────────── */

/**
 * Prefixes for the two control requests this app issues.
 *
 * The CLI answers *every* control request with the same `{subtype:"success"}`
 * envelope and echoes the request id back (verified against 2.1.232), so the id
 * is the only thing that says which request an answer belongs to. Reading them
 * as interchangeable meant a session came up already believing it had been
 * interrupted, and the first failed turn was reported as "interrupted" with its
 * error swallowed.
 */
export const HANDSHAKE_PREFIX = "cc-init-";
export const INTERRUPT_PREFIX = "cc-interrupt-";

/** The request id the CLI echoed on a successful `control_response`. */
function ackId(evt: Evt): string | null {
  if (evt.type !== "control_response") return null;
  const res = obj(evt.response);
  return str(res.subtype) === "success" ? str(res.request_id) : null;
}

/**
 * True for the CLI's reply to the `initialize` handshake — the first proof that
 * the process is up and listening.
 *
 * `system/init` is *not* that proof: the CLI holds it back until a first turn
 * actually starts, so a session that waited for it read "Starting…" for as long
 * as nobody typed — on a process that was answering perfectly.
 */
export const isHandshakeAck = (evt: Evt): boolean =>
  ackId(evt)?.startsWith(HANDSHAKE_PREFIX) === true;

/** True only for the CLI's acknowledgement of an interrupt *we* requested. */
export const isInterruptAck = (evt: Evt): boolean =>
  ackId(evt)?.startsWith(INTERRUPT_PREFIX) === true;

/* ── permissions ──────────────────────────────────────────────────────────── */

/**
 * A `can_use_tool` control request → the prompt the user answers.
 *
 * `null` for any other control request. The CLI *blocks* on these: it holds the
 * tool call until a `control_response` quotes the request id back, which is why
 * every field needed to decide is lifted out here rather than left in the raw
 * event.
 */
export function permissionOf(evt: Evt): PermissionRequest | null {
  if (evt.type !== "control_request") return null;
  const req = obj(evt.request);
  if (str(req.subtype) !== "can_use_tool") return null;
  const id = str(evt.request_id);
  if (!id) return null;
  const tool = str(req.tool_name) ?? "tool";
  const input = obj(req.input);
  return {
    id,
    toolUseId: str(req.tool_use_id),
    tool,
    title: str(req.display_name) ?? tool,
    description: str(req.description) ?? toolTitle(tool, input),
    input,
    reason: str(req.decision_reason) ?? "",
    reasonType: str(req.decision_reason_type) ?? "",
    suggestions: arr(req.permission_suggestions).map(suggestionOf),
    parentToolUseId: str(evt.parent_tool_use_id),
    askedAt: Date.now(),
    status: "pending",
    decidedAt: null,
    appliedSuggestion: null,
  };
}

/** Where a permission change is written. Named plainly: "localSettings" is not
 *  something a user should have to decode while a turn is blocked. */
const SCOPE: Record<string, string> = {
  session: "this session",
  localSettings: "this project, permanently",
  projectSettings: "this project, shared with the team",
  userSettings: "every project, permanently",
};

/** Label one permission suggestion. The payload is echoed back untouched — we
 *  name it for the user, we never rewrite it. */
export function suggestionOf(raw: unknown): PermissionSuggestion {
  const s = obj(raw);
  const scope = SCOPE[str(s.destination) ?? ""] ?? "this session";
  switch (str(s.type)) {
    case "setMode":
      return {
        label: `Switch permission mode to ${str(s.mode) ?? "?"} for ${scope}`,
        raw: s,
      };
    case "addDirectories": {
      const dirs = arr(s.directories).filter((d): d is string =>
        typeof d === "string"
      );
      return {
        label: `Allow ${dirs.join(", ") || "these directories"} for ${scope}`,
        raw: s,
      };
    }
    case "addRules": {
      // A rule is narrower than its tool name — `Bash(curl -s https://…)`, not
      // "all Bash". Saying "always allow Bash" would overstate what is being
      // agreed to, which is the one thing a permission dialog must never do.
      const rules = arr(s.rules).map((r) => {
        const rule = obj(r);
        const name = str(rule.toolName) ?? "tool";
        const content = str(rule.ruleContent);
        return content ? `${name}(${oneLine(content, 60)})` : name;
      });
      return {
        label: `Always allow ${
          rules.join(", ") || "this call"
        }, saved to ${scope}`,
        raw: s,
      };
    }
    default:
      return { label: `Apply the CLI's suggestion for ${scope}`, raw: s };
  }
}

/* ── sub-agent results ────────────────────────────────────────────────────── */

/** What a sub-agent's tool result really carries, once the CLI's internal
 *  bookkeeping is separated from the answer the agent wrote. */
export type AgentResult = {
  /** The agent's own text, or "" for a bare launch receipt. */
  text: string;
  tokens: number | null;
  toolUses: number | null;
  durationMs: number | null;
  /** True for "Async agent launched successfully" — a receipt, not a result. */
  launchReceipt: boolean;
};

const USAGE_BLOCK = /<usage>([\s\S]*?)<\/usage>/;
const META_LINE =
  /^(agentId:|output_file:|The agent is working in the background|Do NOT Read or tail|Do not duplicate this agent)/;

/**
 * Split a `Task`/`Agent` tool result into the agent's answer and its metrics.
 *
 * The CLI mixes both into one string and explicitly tells the model never to
 * quote the bookkeeping. Showing that blob as "what the sub-agent returned"
 * buries the answer, so it is parsed once, here.
 */
export function agentResultOf(raw: string): AgentResult {
  const text = typeof raw === "string" ? raw : "";
  const usage = USAGE_BLOCK.exec(text);
  const metrics = usage ? usage[1] : "";
  const numberAfter = (key: string): number | null => {
    const m = new RegExp(`${key}:\\s*(\\d+)`).exec(metrics);
    return m ? Number(m[1]) : null;
  };
  const body = text
    .replace(USAGE_BLOCK, "")
    .split("\n")
    .filter((line) => !META_LINE.test(line.trim()))
    .join("\n")
    .trim();
  const launchReceipt = /agent launched successfully/i.test(text);
  return {
    text: launchReceipt ? "" : body,
    tokens: numberAfter("subagent_tokens") ?? numberAfter("total_tokens"),
    toolUses: numberAfter("tool_uses"),
    durationMs: numberAfter("duration_ms"),
    launchReceipt,
  };
}

/** A short, human title for a tool call — the thing worth reading in a list. */
export function toolTitle(
  name: string,
  input: Record<string, unknown>,
): string {
  const path = str(input.file_path) ?? str(input.path);
  const first = str(input.description) ?? str(input.command) ?? path ??
    str(input.pattern) ?? str(input.query) ?? str(input.prompt) ??
    str(input.url) ?? str(input.skill);
  if (!first) return name;
  // A path keeps its tail: "…/scratchpad/probe/note.txt" says which file was
  // read, where the first 90 characters of it say only which machine.
  return first === path ? tailPath(first, 90) : oneLine(first, 90);
}

/** The secondary line under a tool title — what the title left out. */
export function toolDetail(
  name: string,
  input: Record<string, unknown>,
): string {
  if (isAgentTool(name)) {
    const type = str(input.subagent_type) ?? str(input.agentType) ?? "general";
    return `${type} · ${oneLine(str(input.prompt) ?? "", 100)}`.trim();
  }
  const keys = Object.keys(input).filter((k) => k !== "description");
  if (keys.length === 0) return "";
  return oneLine(
    keys.map((k) => `${k}=${preview(k, input[k])}`).join("  "),
    140,
  );
}

/** One input value, short. Paths keep their tail for the same reason titles
 *  do — `file_path=/home/dev/code/gen/…` names no file. */
const preview = (key: string, v: unknown): string => {
  if (typeof v === "string") {
    return /path|file/i.test(key) ? tailPath(v, 40) : oneLine(v, 40);
  }
  if (v === null || v === undefined) return "—";
  if (typeof v === "object") return Array.isArray(v) ? `[${v.length}]` : "{…}";
  return String(v);
};
