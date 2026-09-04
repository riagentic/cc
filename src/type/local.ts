/**
 * @module
 * Types for the local-engine integration (LM Studio, Ollama, llama.cpp
 * server). Deliberately independent of `type/claude.ts`: the two integrations
 * share UI parts, never types, so a change on either side cannot reach the
 * other.
 */

/** A backend that serves an OpenAI-compatible chat API on localhost. */
export type LocalEngine = "lmstudio" | "ollama" | "llamacpp";

/** What runs the project's conversation: the Claude Code CLI, or one of the
 *  local engines. Everything Claude-specific keys off exactly `"claude"`. */
export type Engine = "claude" | LocalEngine;

/**
 * What the model is allowed to do.
 *  - `chat`  — words only, no tools.
 *  - `read`  — a read-only agent: list, read, search; nothing that writes.
 *  - `agent` — the full loop, including writing files and running commands.
 */
export type LocalMode = "chat" | "read" | "agent";

/** One tool invocation the model asked for. `args` is the raw JSON string the
 *  model produced — parsed (and judged) at execution time, not before. */
export type LocalToolCall = {
  id: string;
  name: string;
  args: string;
};

/** One transcript entry. `tool` rows carry the result of the call they answer;
 *  assistant rows may carry the calls they made alongside (or instead of)
 *  text. */
export type LocalMsg = {
  id: string;
  role: "user" | "assistant" | "tool";
  text: string;
  at: number;
  toolCalls?: LocalToolCall[];
  /** For `tool` rows: which call this answers, and its tool's name. */
  toolCallId?: string;
  toolName?: string;
  /** True once compaction dropped this row from what the model sees. The row
   *  stays on screen — the *user's* history is not the model's context. */
  evicted?: boolean;
};

/** Per-project engine configuration. Persisted. */
export type LocalConfig = {
  engine: Engine;
  baseUrl: string;
  model: string;
  mode: LocalMode;
  /** Context window to budget against, in tokens. The truth lives in the
   *  server; this is the number the packer must respect. */
  ctx: number;
  /**
   * True once a human typed the context window by hand.
   *
   * Detection reads the real window out of the server for every engine, and
   * overwriting a number the user deliberately set would make that field
   * unusable — so detection fills it only while this is false. Turning it back
   * off is the "detect again" button.
   */
  ctxManual?: boolean;
  /**
   * What the agent may do without being asked — the local half of Claude
   * Code's permission modes, and named to read the same way.
   *
   * This is the honest boundary for `sh`. The file tools resolve every path
   * inside the project — symlinks included — but a shell command cannot be
   * confined that way without pretending to a sandbox this app does not have.
   * So the control is the same one Claude Code gets: the command, in full,
   * before it runs, with somebody deciding — unless somebody has said not to
   * be asked, and then a guardrail stands in for them.
   */
  /**
   * True once a human typed the server address by hand.
   *
   * The same contract as {@link LocalConfig.ctxManual}: the app looks for a
   * server and adopts what it finds, but it never moves an address somebody
   * chose. Silently repointing a project at a different server is how you end
   * up talking to the wrong model and never knowing — so a hand-set address
   * that has gone dead produces an offer, not a switch.
   */
  urlManual?: boolean;
  permission?: LocalPermission;
  /** What this field was called when it had two values. Read once, for a
   *  project configured before the third one existed; never written. */
  shApproval?: "ask" | "always";
};

/**
 * How much the local agent may do on its own.
 *
 *  - `ask`     — every command is held until the user answers. The default.
 *  - `dontAsk` — commands run unasked, except the ones that destroy, escalate
 *                or reach outside the machine: those are refused, in words the
 *                model can act on. No prompts, and no quiet damage.
 *  - `bypass`  — no checks at all. Whatever the model writes, runs.
 */
export type LocalPermission = "ask" | "dontAsk" | "bypass";

/** One project's local conversation. Not persisted — same stance as the
 *  Claude session: a transcript is a record of a live process. */
export type LocalChat = {
  messages: LocalMsg[];
  status: "idle" | "working";
  /** Streaming text of the reply being produced right now. */
  streaming: string;
  /**
   * Whether this project's server will accept tool calls at all.
   *
   * `null` until anybody asked, and `null` stays the answer for a server that
   * cannot be asked cheaply. `false` is the case worth saying out loud: a
   * llama.cpp with its Jinja templating off (`--no-jinja` now, or an older
   * build never given `--jinja`) refuses every request that carries tools, so
   * Read-only and Agent modes cannot work against it — only Chat.
   * Live, not persisted: it is a fact about a running server, and the fix is
   * to restart that server.
   */
  toolsOk: boolean | null;
  /** Rolling summary standing in for evicted rows, injected as context. */
  summary: string;
  /** Prompt tokens the last request actually carried (est. if unreported). */
  usedTokens: number;
  models: string[];
  error: string | null;
  /** The command the agent is waiting to be allowed to run, if any. The turn
   *  is blocked on it: nothing is spent and nothing happens until it is
   *  answered. */
  pending: PendingCommand | null;
};

/** One `sh` call held for a decision. */
export type PendingCommand = {
  /** The tool call id — so a stale answer cannot allow a different command. */
  id: string;
  cmd: string;
  at: number;
};

/**
 * What one engine's default address answered when it was probed.
 *
 * The app looks for all three at once rather than asking the user which one
 * they run: a local server either answers on its port or it does not, and that
 * is a question a program can settle for itself. `models` is what it offered,
 * so picking an engine from a detection result never needs a second round trip.
 */
export type EngineProbe = {
  engine: LocalEngine;
  baseUrl: string;
  reachable: boolean;
  models: string[];
  /**
   * Whether the server would accept tool calls. `null` when the question has
   * no cheap answer for this engine — LM Studio and Ollama decide it per
   * model at request time, llama.cpp decides it once, at startup.
   */
  tools?: boolean | null;
};
