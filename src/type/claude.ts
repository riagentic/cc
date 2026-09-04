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
  | "starting" // spawned, waiting for the CLI to answer the `initialize`
  //            // handshake — *not* `system/init`, which the CLI holds back
  //            // until a first turn begins (see `isHandshakeAck`)
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
  /**
   * What the turn this message ended cost, attached when the CLI reports the
   * result.
   *
   * On the message rather than in one "last turn" field, because a transcript
   * is read backwards: "that answer took four minutes and eighty cents" is
   * only useful next to the answer it is about. Absent on every message that
   * did not end a turn, which is most of them.
   */
  turn?: TurnCost;
};

/** What one turn took. Every figure comes from the CLI's own result event. */
export type TurnCost = {
  ms: number;
  /** Output tokens the turn produced, as reported. `0` when it did not say. */
  tokens: number;
  /** Dollars for this turn — the difference between two session totals, which
   *  is the only per-turn figure the CLI makes available. */
  usd: number;
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
  /** Plugins the CLI loaded for this session — they add tools, agents and
   *  commands, so "what can this session do" is incomplete without them. */
  plugins: { name: string; version: string }[];
  memoryPaths: string[];
};

/** How the last turn actually ended, as the CLI reports it.
 *
 *  `terminalReason` is the field that distinguishes "finished answering" from
 *  "ran out of output tokens" and "stopped by a budget" — outcomes that look
 *  identical on screen and mean very different things about whether the answer
 *  is complete. */
export type TurnEnd = {
  /** `completed`, or whatever else stopped it. */
  reason: string;
  /** The model's own stop reason (`end_turn`, `max_tokens`, `tool_use`, …). */
  stopReason: string;
  /** Time to first token, in ms. `0` when the CLI did not report one. */
  ttftMs: number;
};

/** What became of the sub-agents a turn asked for.
 *
 *  `refused` and `killed` are the reason this is kept: a delegation turned down
 *  for a depth, concurrency or budget limit produces no agent, no error and no
 *  row anywhere — the model simply narrates around the help it never got. */
export type AgentStats = {
  spawned: number;
  completed: number;
  failed: number;
  refused: number;
  killed: number;
  /** Why refusals happened, for the ones that did. */
  refusedBy: { reason: string; count: number }[];
};

/** One usage window the CLI reports — `five_hour`, `seven_day`, … */
export type RateWindow = {
  name: string;
  /** 0–1, as the CLI sends it. */
  utilization: number;
  /** Epoch ms, or 0 when the CLI did not say. */
  resetsAt: number;
};

export type RateLimit = {
  status: string;
  type: string;
  utilization: number;
  resetsAt: number;
  /** The plan's usage is being billed past the included allowance. */
  overage: boolean;
  /** Every window the CLI reported, fullest first. The single `type` above is
   *  only the one it chose to headline; a session can be comfortable on the
   *  five-hour window and out of room on the seven-day one, and showing one
   *  figure hid whichever was about to stop the work. */
  windows: RateWindow[];
};

export type MemoryFile = {
  path: string;
  label: string;
  scope: "user" | "project" | "session";
  bytes: number;
  modifiedAt: number | null;
};

/**
 * How Claude Code is run for one project.
 *
 * Per project, not per app. Two codebases rarely want the same answer: the one
 * you are shipping wants Opus and an approval prompt on every write; the
 * scratch repo wants Haiku and no prompts at all. A single global setting means
 * every switch is followed by re-picking the model, and forgetting to is how a
 * `bypassPermissions` chosen for a sandbox ends up pointed at production.
 *
 * Seeded from what the CLI itself is configured to do (see `readCliDefaults`)
 * so a new project starts where the terminal would, then persisted on its own.
 */
export type ProjectSettings = {
  model: string;
  permissionMode: PermissionMode;
  /** `--effort`. `""` means "do not pass the flag at all". */
  effort: string;
  /** Extra folders this project's session may touch (`--add-dir`). */
  allowedDirs: string[];
  /** `--dangerously-skip-permissions` for this project's session only. */
  skipPermissions: boolean;
};

export type Project = ProjectSettings & {
  id: string;
  path: string;
  name: string;
  branch: string | null;
  dirty: boolean;
  /** The directory is no longer on disk. Projects are persisted, so a stored
   *  path is a claim about last week — deleted, renamed and unmounted folders
   *  all land here, and the UI offers the remedy instead of failing at spawn. */
  missing: boolean;
  addedAt: number;
};

export type ModelOption = {
  id: string;
  label: string;
  hint: string;
  contextWindow: number;
};

/** The modes the picker offers, and the only values `setPermissionMode` lets
 *  through — the list is `PERMISSION_MODES` in `lib/stream.ts`, and this union
 *  is kept identical to it. It used to carry an extra `"auto"` that the guard
 *  rejected unconditionally: a type that admitted a value the runtime could
 *  never hold. (`auto` is the CLI's own newer spelling of `default`, and
 *  `default` is what it reports back on `system/init` either way.) */
export type PermissionMode =
  | "default"
  | "manual"
  | "acceptEdits"
  | "plan"
  | "dontAsk"
  | "bypassPermissions";

/* ── background sessions (jobs) ───────────────────────────────────────────────
 *
 * `claude --bg` detaches a whole session: it keeps working after the terminal
 * that started it is gone, and `claude agents` lists them. That is a different
 * thing from a {@link BackgroundTask}, which is one tool call inside *this*
 * session — a job owns its own conversation, its own cwd and its own model.
 *
 * The CLI keeps each one under `~/.claude/jobs/<short-id>/`, which is where
 * these are read from: `state.json` for what it is doing now, `timeline.jsonl`
 * for how it got there.
 */

/** What a background session is doing. `blocked` is the one that matters — it
 *  is waiting on a human and will wait forever unless somebody looks. */
export type JobState =
  | "working"
  | "blocked"
  | "done"
  | "failed"
  | "stopped"
  | "unknown";

/** One entry from a job's `timeline.jsonl` — what it said, and when. */
export type JobEvent = {
  at: number;
  state: JobState;
  detail: string;
  text: string;
};

export type Job = {
  /** The short id `claude attach|stop|rm|respawn` takes. */
  id: string;
  /** The full session UUID, for `claude --resume`. */
  sessionId: string | null;
  /** The CLI's own name for the job, or the intent it was started with. */
  name: string;
  /** The prompt that started it. */
  intent: string;
  state: JobState;
  /** The job's one-line summary of where it is. */
  detail: string;
  /** What it is waiting for, when it is `blocked`. The whole reason this page
   *  exists: a blocked job is invisible until somebody goes looking for it. */
  needs: string;
  /** Questions it is holding a human on, when it asked structured ones. */
  questions: string[];
  cwd: string;
  model: string | null;
  tokens: number;
  /** Tool calls and queued turns it has in flight right now. */
  inFlight: { tasks: number; queued: number };
  cliVersion: string | null;
  createdAt: number;
  updatedAt: number;
  /** Newest last. Capped — a long job's timeline is not a transcript. */
  timeline: JobEvent[];
};

/* ── loops ───────────────────────────────────────────────────────────────────
 *
 * A prompt cc re-sends on an interval, the way `/loop` does inside the CLI —
 * except owned here, so it survives the turn that created it, is visible
 * between runs, and can be paused without ending the session.
 */

/** A loop's run history entry. `ok` is `null` while the run is in flight. */
export type LoopRun = {
  at: number;
  endedAt: number | null;
  ok: boolean | null;
  /** The first line of what came back, for the history list. */
  summary: string;
};

export type Loop = {
  id: string;
  /** What to send. */
  prompt: string;
  /** Seconds between runs. */
  everySec: number;
  /** Paused loops keep their history and their schedule, and fire nothing. */
  paused: boolean;
  /** The project this loop belongs to — a loop is about a codebase, and firing
   *  one against whatever project happens to be open would be a surprise. */
  projectId: string;
  createdAt: number;
  /** Epoch ms of the next due fire, or 0 when paused. */
  nextAt: number;
  /** Newest first, capped. */
  runs: LoopRun[];
};

/* ── project tree ────────────────────────────────────────────────────────── */

/** One entry in the project file tree. Directories carry their children only
 *  once expanded — walking a whole repo up front is a lot of `stat` for a panel
 *  most of which is never opened. */
export type TreeNode = {
  /** Absolute path — the identity, since two directories can share a name. */
  path: string;
  name: string;
  dir: boolean;
  /** `null` for directories and for anything that could not be measured. */
  bytes: number | null;
  /** Depth below the project root, so a flat list can render as a tree. */
  depth: number;
  /** The directory is expanded and its children follow it in the list. */
  open: boolean;
};

/** What this session has done to a file: the one thing a plain file browser
 *  cannot say, and the reason the tree is worth having here rather than in an
 *  editor. Derived from the session's own tool calls, live — it is not stored
 *  on the node, because the tree is re-read on demand and the calls are not. */
export type Touch = "read" | "written";

/* ── configuration on disk ───────────────────────────────────────────────── */

/** Where a piece of configuration came from. Precedence runs right to left:
 *  a project skill shadows a user one of the same name. */
export type Scope = "builtin" | "user" | "project" | "plugin";

/** A skill (`.claude/skills/<name>/SKILL.md`) or a slash command
 *  (`.claude/commands/<name>.md`). Same shape, two directories. */
export type SkillInfo = {
  name: string;
  scope: Scope;
  description: string;
  /** Absolute path to the defining file, or `""` for a built-in the CLI only
   *  names in `system/init`. */
  path: string;
};

/** An installed plugin, from `~/.claude/plugins/installed_plugins.json`. */
export type PluginInfo = {
  name: string;
  marketplace: string;
  version: string;
  scope: string;
  /** `enabledPlugins` in settings — an installed plugin can be switched off. */
  enabled: boolean;
  installedAt: number;
  /** Loaded by the *running* session, as `system/init` reported it. Installed
   *  and loaded are different questions, and only the second one affects a turn. */
  loaded: boolean;
};

/** One configured hook, from a settings file. */
export type HookInfo = {
  /** `PreToolUse`, `Stop`, … */
  event: string;
  /** The tool pattern it fires for, or `""` for every one. */
  matcher: string;
  /** `command` for a shell hook, or whatever type the entry declares. */
  type: string;
  /** The command line it runs. */
  command: string;
  scope: Scope;
  /** The settings file it is declared in. */
  path: string;
};

/** An MCP server as configured on disk, joined to what the session reports. */
export type McpInfo = {
  name: string;
  /** `stdio`, `http`, `sse` — how the CLI reaches it. */
  transport: string;
  /** The command or URL, for the detail row. */
  target: string;
  scope: Scope;
  path: string;
  /** `connected`, `failed`, … from `system/init`, or `""` when the running
   *  session says nothing about it — configured is not the same as reachable. */
  status: string;
};
