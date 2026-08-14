/**
 * @module
 * Every exported type in the app. Zero dependencies — types flow down only.
 *
 * The shapes here mirror what the Claude Code CLI actually emits on
 * `--output-format stream-json` (verified against 2.1.226), narrowed to the
 * plain, JSON-serializable data that crosses the bridge to the browser.
 */

/** Where a session is in its lifecycle. Drives every status affordance. */
export type Status =
  | "offline" // no process
  | "starting" // spawned, waiting for `system/init`
  | "ready" // idle, accepting input
  | "working" // a turn is in flight
  | "error"; // exited non-zero / failed to spawn

/** One rendered piece of an assistant turn. */
export type Block =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "tool"; id: string; name: string; input: Record<string, unknown> }
  | { kind: "result"; id: string; ok: boolean; text: string };

export type Role = "user" | "assistant";

export type Message = {
  id: string;
  role: Role;
  blocks: Block[];
  at: number;
  /** Set when the message came from inside a sub-agent. */
  parentToolUseId: string | null;
};

/** What a sub-agent was asked to do, and what it cost — reported by the CLI on
 *  `task_started` and `task_notification`, not guessed from the tool input. */
export type AgentInfo = {
  /** `subagent_type`: which agent definition is running. */
  type: string | null;
  /** The full prompt the sub-agent was given. */
  prompt: string | null;
  /** Tokens the sub-agent spent, once its task reports them. */
  tokens: number | null;
  /** How many tools it used. */
  toolUses: number | null;
  /** The CLI's own duration for the agent, which starts before our clock. */
  durationMs: number | null;
};

/** A tool invocation — the unit behind both the agent list and the timeline. */
export type ToolRun = {
  id: string;
  name: string;
  /** `Task`/`Agent` calls are sub-agents; everything else is a tool call. */
  kind: "agent" | "tool";
  title: string;
  detail: string;
  input: Record<string, unknown>;
  startedAt: number;
  endedAt: number | null;
  ok: boolean | null;
  /** What the call returned, cleaned of the CLI's internal launch metadata. */
  output: string | null;
  parentToolUseId: string | null;
  /**
   * Set when this call was launched as a CLI background task. An *async*
   * sub-agent returns "agent launched successfully" within milliseconds and
   * then works for minutes, so its tool call's lifetime is not its own — the
   * task it is joined to is what says when it really finished.
   */
  taskId: string | null;
  /** Sub-agent facts. `null` for ordinary tool calls. */
  agent: AgentInfo | null;
  /** Set while the CLI is blocked asking the user to approve this call. */
  permissionId: string | null;
};

/** One change to the session's permissions the CLI offers to make — "switch to
 *  acceptEdits", "add /tmp to the allowed directories". Passed straight back on
 *  approval, so its payload stays opaque to us. */
export type PermissionSuggestion = {
  /** A short human label built from the payload — what the user is agreeing to. */
  label: string;
  /** The CLI's own suggestion object, echoed back verbatim when accepted. */
  raw: Record<string, unknown>;
};

/**
 * A tool call the CLI is holding until the user decides.
 *
 * The CLI blocks on this: no answer means the turn stalls until it gives up and
 * denies. Every request therefore reaches the UI, and every one is answered.
 */
export type PermissionRequest = {
  /** The control request id — what the answer must quote. */
  id: string;
  toolUseId: string | null;
  tool: string;
  title: string;
  /** One line describing the call, from the CLI. */
  description: string;
  input: Record<string, unknown>;
  /** Why approval is needed ("Path is outside allowed working directories"). */
  reason: string;
  reasonType: string;
  suggestions: PermissionSuggestion[];
  /** The sub-agent that asked, when the call came from inside one. */
  parentToolUseId: string | null;
  askedAt: number;
  status: "pending" | "allowed" | "denied" | "cancelled";
  decidedAt: number | null;
  /** Set when the decision also applied a suggestion ("always allow"). */
  appliedSuggestion: string | null;
};

/** A CLI background task (`run_in_background`, background agents). */
export type BackgroundTask = {
  id: string;
  type: string;
  description: string;
  status: "running" | "completed" | "failed" | "killed" | "stopped";
  toolUseId: string | null;
  startedAt: number;
  endedAt: number | null;
  outputFile: string | null;
};

/** One line of the live activity timeline. */
export type ActivityItem = {
  id: string;
  at: number;
  channel:
    | "session"
    | "model"
    | "tool"
    | "agent"
    | "task"
    | "permission"
    | "error";
  label: string;
  detail: string;
};

/** Token accounting for the most recent request, plus the window it fits in. */
export type Usage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreate: number;
  contextWindow: number;
};

/** What `system/init` tells us about the session's capabilities. */
export type SessionMeta = {
  version: string | null;
  permissionMode: string | null;
  outputStyle: string | null;
  tools: string[];
  agents: string[];
  skills: string[];
  commands: string[];
  mcp: { name: string; status: string }[];
  memoryPaths: string[];
};

export type RateLimit = {
  status: string;
  type: string;
  utilization: number;
  resetsAt: number;
};

export type MemoryFile = {
  path: string;
  label: string;
  scope: "user" | "project" | "session";
  bytes: number;
  modifiedAt: number | null;
};

export type Project = {
  id: string;
  path: string;
  name: string;
  branch: string | null;
  dirty: boolean;
  addedAt: number;
};

export type ModelOption = {
  id: string;
  label: string;
  hint: string;
  contextWindow: number;
};

export type PermissionMode =
  | "default"
  | "manual"
  | "acceptEdits"
  | "auto"
  | "plan"
  | "dontAsk"
  | "bypassPermissions";
