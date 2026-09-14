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
 *  - `read`  — a read-only agent: list, find, read, search; nothing that writes.
 *  - `agent` — the full loop, including editing and writing files, keeping a
 *    task list, and running commands.
 */
export type LocalMode = "chat" | "read" | "agent";

/** One tool invocation the model asked for. `args` is the raw JSON string the
 *  model produced — parsed (and judged) at execution time, not before. */
export type LocalToolCall = {
  id: string;
  name: string;
  args: string;
};

/** One step of the agent's own task list — set by the `todo` tool, shown
 *  beside the transcript, and re-sent to the model with every request so a
 *  plan survives compaction. */
export type LocalTodo = {
  content: string;
  status: "pending" | "in_progress" | "completed";
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
  /** For `tool` rows: true once packing replaced the result with a one-line
   *  stub. Sticky, like `evicted` — a row packed the same way every request
   *  keeps the server's cached prompt prefix valid. */
  stubbed?: boolean;
  /** For `tool` rows: the STORED text was shortened to keep the saved chat
   *  small. Not the model's loss: while this process holds the whole text,
   *  the model is sent all of it, and only packing — the window — decides
   *  what it stops seeing. */
  folded?: boolean;
  /** For `user` rows: sent while the agent was working, and delivered into
   *  the running task at its next step. The model is told so. */
  steer?: boolean;
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
   * True once a human typed the server address by hand.
   *
   * The same contract as {@link LocalConfig.ctxManual}: the app looks for a
   * server and adopts what it finds, but it never moves an address somebody
   * chose. Silently repointing a project at a different server is how you end
   * up talking to the wrong model and never knowing — so a hand-set address
   * that has gone dead produces an offer, not a switch.
   */
  urlManual?: boolean;
  /**
   * What the agent may do without being asked — the local half of Claude
   * Code's permission modes, and named to read the same way.
   *
   * This is the boundary for `sh`. The file tools resolve every path inside
   * the project — symlinks included — but a shell command reaches wherever
   * its user can. So the control is the one Claude Code gets: the command, in
   * full, before it runs, with somebody deciding — unless somebody has said
   * not to be asked, and then a guardrail and (where bubblewrap works) a
   * sandbox stand in for them.
   */
  permission?: LocalPermission;
  /** Sandboxed commands may use the network. Off by default — see
   *  `local.setSandboxNet`. */
  sandboxNet?: boolean;
  /** Programs the user allowed to run outside the sandbox in this chat
   *  without asking again ("Run it, and allow `am` outside"). Cleared when
   *  the permission mode changes. */
  outsideAllowed?: string[];
  /** The mode "Auto-approve" was switched on over, and goes back to when it
   *  is switched off. Set only while the permission is `bypass`. */
  beforeAutoApprove?: LocalPermission;
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
 *                model can act on. The rest run with credentials scrubbed
 *                from their environment and, where bubblewrap works, in a
 *                sandbox that can write only the project. No prompts, and no
 *                quiet damage.
 *  - `bypass`  — no checks at all. Whatever the model writes, runs.
 */
export type LocalPermission = "ask" | "dontAsk" | "bypass";

/** What the system prompt says about the machine and the project. Gathered
 *  by the server side once per conversation (not per request), so the prompt
 *  prefix stays byte-identical and the server can keep reusing its cache of
 *  it. */
export type PromptEnv = {
  cwd: string;
  /** e.g. "2026-09-11" */
  date?: string;
  platform?: string;
  /** e.g. "branch main, 3 uncommitted changes" */
  git?: string;
  /** Top-level entries of the project, already capped. */
  tree?: string;
  /** How the project builds and tests, read from its manifests — e.g.
   *  "deno (tasks: test, check) · make (targets: build)". */
  toolchain?: string;
  /** Documentation folders near the root (docs/, dep/<name>/docs/ …),
   *  already capped — so "read the docs first" has somewhere to point. */
  docs?: string;
  /** AGENTS.md / CLAUDE.md content, already capped to the window. */
  instructions?: { path: string; text: string } | null;
  /** Set when `sh` runs sandboxed ("Don't ask" with bubblewrap): the rules
   *  of the box, told up front instead of found out by trial and error. */
  sandbox?: { net: boolean } | null;
  /** Set when `sh` runs as the agent account: who it is, and its screen. */
  account?: { user: string; home: string; display: string | null } | null;
};

/** One conversation. Persisted with its transcript; everything about the
 *  live process is scrubbed on restore (`local.ts` `onRestore`). */
export type LocalChat = {
  messages: LocalMsg[];
  status: "idle" | "working";
  /** Streaming text of the reply being produced right now. */
  streaming: string;
  /** The tail of what a reasoning model is thinking right now — shown while
   *  it thinks, so a minute of reasoning does not look like a hung server.
   *  Live only: never stored with the reply, never sent back. */
  thinking?: string;
  /**
   * Whether this server and model take tool calls natively.
   *
   * `null` until anybody asked. `false` does not mean the agent cannot work:
   * the tools are then described in words and calls read back from the reply
   * (the "text protocol") — slower and less sure, but any model can do it.
   * `false` comes from llama.cpp with Jinja templating off, from a model LM
   * Studio or Ollama reports as not trained for tools, or from a server that
   * refused a request because of its tools. Live, not persisted.
   */
  toolsOk: boolean | null;
  /** Server tokens per estimated token, learned from the `prompt_tokens`
   *  each reply reports — the packer's correction for this model's
   *  tokenizer. Absent until a reply reported a count. */
  tokRatio?: number;
  /**
   * The environment block of the system prompt, gathered once and reused —
   * project instructions, top-level files, git state, date.
   *
   * Kept rather than re-read each turn because the system prompt is the start
   * of every request's prefix: a new top-level file changing it would make a
   * local server re-read the whole conversation. Refreshed when compaction
   * changes the prompt anyway, and when it is older than a few hours.
   */
  env?: { data: PromptEnv; at: number; ctx: number; v?: number };
  /** Rolling summary standing in for evicted rows, injected as context. */
  summary: string;
  /** Prompt tokens the last request actually carried (est. if unreported). */
  usedTokens: number;
  /** When the turn on screen started, or `0` when none is running. Drives the
   *  same working clock the Claude side has — a turn that has been going for
   *  four minutes and one that started two seconds ago look identical
   *  otherwise, and only one of them is a reason to worry. */
  startedAt: number;
  /** How long the last turn took, and how many tokens it produced — `0` for
   *  either when the server did not say. Together they are a speed; apart they
   *  are nothing, which is why neither is shown alone. */
  lastMs: number;
  lastTokens: number;
  models: string[];
  error: string | null;
  /** The command the agent is waiting to be allowed to run, if any. The turn
   *  is blocked on it: nothing is spent and nothing happens until it is
   *  answered. */
  pending: PendingCommand | null;
  /** The agent's current task list, as the `todo` tool last set it. Kept with
   *  the conversation, and re-sent with every request while anything on it is
   *  unfinished — so a plan survives compaction and a "continue" next turn. */
  todos: LocalTodo[];
  /** Files the last turn changed through edit/write, and how many — the
   *  count behind the "undo" offer. The originals live in the server process
   *  (`local.server.ts`), so the offer does not survive a restart. */
  changed?: number;
  /** Background programs this conversation left running (`sh` with
   *  `background`) — the count behind the "stop" chip. */
  jobs?: number;
  /** Messages written while the agent was working, waiting to be delivered
   *  into the task at its next step. */
  queued?: { id: string; text: string; at: number }[];
  /** On disk, not in state: an idle conversation nobody is looking at. Its
   *  messages come back when it is opened or written to. `null`: here. */
  parked?: { rows: number; at: number } | null;
  /** Earlier messages that left this chat (the row cap, Clear) — saved to
   *  disk, searchable by the agent's `history` tool. */
  archived?: number;
};

/** One `sh` call held for a decision. */
export type PendingCommand = {
  /** The tool call id — so a stale answer cannot allow a different command. */
  id: string;
  cmd: string;
  at: number;
  /** In "Don't ask": the model asked to run this outside the sandbox. */
  outside?: boolean;
  /** It keeps running in the background after the command returns. */
  background?: boolean;
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
