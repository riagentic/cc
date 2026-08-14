/**
 * @module
 * Session — the live Claude Code process, projected into state the UI can read.
 *
 * Every field here is either read straight off the protocol or derived from it;
 * nothing is invented. What the CLI cannot tell us (a context window before the
 * first result, a branch, memory on disk) is measured elsewhere and labelled as
 * such, never guessed silently.
 *
 * Not persisted: a session dies with its process, and a restored transcript
 * next to a dead process is a lie. Use Resume to pick a real one back up.
 */
import { cell, log } from "aio";
import type {
  ActivityItem,
  BackgroundTask,
  Block,
  MemoryFile,
  Message,
  PermissionRequest,
  RateLimit,
  SessionMeta,
  Status,
  ToolRun,
  Usage,
} from "../type/claude.ts";
import {
  agentResultOf,
  blocksOf,
  contextUsed as contextUsedOf,
  contextWindowOf,
  type Evt,
  fallbackWindow,
  isAgentTool,
  isHandshakeAck,
  isInterruptAck,
  permissionOf,
  toolDetail,
  toolTitle,
  usageOf,
} from "../lib/stream.ts";
import { oneLine } from "../lib/format.ts";
import { activeProject, workspace } from "./workspace.ts";

/** Ring-buffer caps. A control surface shows the recent past; unbounded growth
 *  would turn every broadcast into a full-state resend. */
const MAX_MESSAGES = 400;
const MAX_TOOLS = 300;
const MAX_ACTIVITY = 400;
const MAX_OUTPUT = 4_000;
const MAX_PERMISSIONS = 60;

/** How stale an automatic memory measurement may be before it is taken again.
 *  The Rescan button never waits — this only paces the automatic passes. */
const RESCAN_MS = 15_000;

/** What a memory measurement was taken over: the project, plus the session
 *  memory directories the CLI reported. When this changes the figure on screen
 *  is about somewhere else, so the pacing above must not hold the new one back —
 *  switching project used to show the previous one's files for 15 seconds. */
const memoryScanKey = (path: string, dirs: readonly string[]): string =>
  [path, ...dirs].join("\n");

const EMPTY_META: SessionMeta = {
  version: null,
  permissionMode: null,
  outputStyle: null,
  tools: [],
  agents: [],
  skills: [],
  commands: [],
  mcp: [],
  memoryPaths: [],
};

const EMPTY_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheCreate: 0,
  contextWindow: 200_000,
};

type SessionState = {
  status: Status;
  sessionId: string | null;
  resumeId: string | null;
  cwd: string | null;
  model: string | null;
  pid: number | null;
  startedAt: number | null;
  messages: Message[];
  streaming: { kind: "text" | "thinking"; text: string } | null;
  tools: ToolRun[];
  tasks: BackgroundTask[];
  /** Approval prompts, newest last — pending ones block the CLI. */
  permissions: PermissionRequest[];
  activity: ActivityItem[];
  usage: Usage;
  cost: number;
  turns: number;
  turnStartedAt: number | null;
  lastTurnMs: number;
  /** An interrupt was asked for and the CLI has not reported the turn yet. */
  interrupting: boolean;
  /** Incremented on every start. Callbacks carry the token they were created
   *  with, so a superseded process cannot write over its replacement. */
  startToken: number;
  meta: SessionMeta;
  rateLimit: RateLimit | null;
  memory: MemoryFile[];
  memoryScannedAt: number | null;
  /** What the measurement above was taken over ({@link memoryScanKey}). */
  memoryScanKey: string;
  error: string | null;
};

export const session = cell("session", {
  persist: "none",

  // Live reads + incremental commits, deliberately (alpha52's transactional
  // default is the wrong isolation here — dep/aio/docs/state/transactional-methods.md).
  // This cell's async methods run *while*
  // `ingest` — a sync reducer fed by the process — commits on every line the
  // model produces. Under snapshot isolation, `start`/`send` would read a
  // frozen view and their array appends would collide with the reducer's; here
  // every write publishes as it happens, which is what a live session is.
  transaction: false,

  state: {
    status: "offline" as Status,
    sessionId: null as string | null,
    resumeId: null as string | null,
    cwd: null as string | null,
    model: null as string | null,
    pid: null as number | null,
    startedAt: null as number | null,
    messages: [] as Message[],
    streaming: null as { kind: "text" | "thinking"; text: string } | null,
    tools: [] as ToolRun[],
    tasks: [] as BackgroundTask[],
    permissions: [] as PermissionRequest[],
    activity: [] as ActivityItem[],
    usage: { ...EMPTY_USAGE },
    cost: 0,
    turns: 0,
    turnStartedAt: null as number | null,
    lastTurnMs: 0,
    interrupting: false,
    startToken: 0,
    meta: { ...EMPTY_META },
    rateLimit: null as RateLimit | null,
    memory: [] as MemoryFile[],
    memoryScannedAt: null as number | null,
    memoryScanKey: "",
    error: null as string | null,
  },

  methods: {
    /* ── lifecycle ─────────────────────────────────────────────────────── */

    /** Start (or restart) the session for the active project. `resume` hands
     *  the CLI its previous session id, so the model keeps everything it knew;
     *  the CLI replays none of it on the wire, so the transcript here starts
     *  empty and fills from the next turn on (measured against 2.1.232). */
    async start(s: SessionState, resume = false) {
      const project = activeProject();
      if (!project) {
        s.error = "Add a project directory first.";
        s.status = "error";
        return;
      }
      const resumeId = resume ? s.resumeId : null;

      // Restarting kills the previous process, and its exit callback arrives
      // *after* this one has published "starting" — which used to flip the
      // fresh session straight to "offline". Every callback now carries the
      // token of the start that created it, and a stale one is ignored.
      const token = s.startToken + 1;

      reset(s);
      s.startToken = token;
      s.status = "starting";
      s.cwd = project.path;
      s.model = workspace.model;
      s.startedAt = Date.now();
      s.resumeId = resumeId;
      note(s, "session", "Starting session", `${project.path} · ${s.model}`);

      const io = await import("./claude.server.ts");
      try {
        const { pid } = await io.start({
          cwd: project.path,
          model: workspace.model,
          permissionMode: workspace.permissionMode,
          allowedDirs: [...workspace.allowedDirs],
          skipPermissions: workspace.skipPermissions,
          resume: resumeId,
        }, {
          onEvent: (evt) => {
            void session.ingest(evt as Evt, token);
            if (evt.type === "system" && evt.subtype === "init") {
              void session.scanMemory(false);
            }
          },
          onDelta: (kind, text) => void session.delta(kind, text, token),
          onExit: (code, detail) => void session.exited(code, detail, token),
        });
        s.pid = pid;
        // Memory is a fact about the project, not about a turn — and the only
        // event that used to trigger the measurement (`system/init`) is held
        // back by the CLI until a first turn begins. Waiting for it left a
        // running session's Memory page reading "Not scanned" until somebody
        // typed. The `init` pass still follows, to pick up the session memory
        // directory that only that event names.
        void session.scanMemory(false);
      } catch (e) {
        s.status = "error";
        s.error = e instanceof Error ? e.message : String(e);
        log.error("session", "could not start Claude Code", {
          cwd: project.path,
          model: workspace.model,
          error: s.error, // aiol-ok: written two lines above
        });
        // aiol-ok: live read of a value written one line above, by design
        note(s, "error", "Could not start", s.error);
      }
    },

    /** End the session. The CLI keeps the transcript on disk, so `resumeId`
     *  stays valid and Resume brings it back. */
    async stop(s: SessionState) {
      // The process being ended is no longer this session's, so nothing it says
      // on the way out may write here — bump the identity first and every one
      // of its callbacks is ignored as superseded.
      //
      // Without this, Stop mid-turn read as a crash: closing stdin does not end
      // the CLI while it is answering (measured against 2.1.232), so the frames
      // still in flight landed as a *failed turn*, and the SIGTERM that follows
      // came back as exit 143 — "Exited (code 143)" in red, for a button the
      // user pressed on purpose.
      s.startToken += 1;
      // Published before the teardown is awaited, not after: ending the process
      // takes up to a second and a half, and the session is over the moment the
      // button is pressed — nothing more will be read from it or written to it.
      s.status = "offline";
      s.turnStartedAt = null;
      s.streaming = null;
      s.interrupting = false;
      s.pid = null;
      cancelPending(s, "the session was stopped");
      closeOpenWork(s, "the session was stopped");
      note(s, "session", "Session stopped", "");

      const io = await import("./claude.server.ts");
      await io.stop();
    },

    /** Reported by the process watcher — never called from the UI. */
    exited(s: SessionState, code: number, detail: string, token?: number) {
      if (token !== undefined && token !== s.startToken) return; // superseded
      s.pid = null;
      s.turnStartedAt = null;
      s.streaming = null;
      s.interrupting = false;
      cancelPending(s, "the session ended");
      closeOpenWork(s, "the session ended");
      if (code === 0 || s.status === "offline") {
        s.status = "offline";
        note(s, "session", "Session ended", "");
        return;
      }
      s.status = "error";
      s.error = detail || `Claude Code exited with code ${code}.`;
      log.error("session", "Claude Code exited", { code, detail });
      note(s, "error", `Exited (code ${code})`, oneLine(s.error, 160));
    },

    /* ── turns ─────────────────────────────────────────────────────────── */

    /** Send a turn. Optimistic by design: the message is in the transcript
     *  before the process has seen it, and a failure says so loudly. */
    async send(s: SessionState, text: string) {
      const body = typeof text === "string" ? text.trim() : "";
      if (!body) return;
      // Send-starts-the-session: the composer is always live. Only a *dead
      // process* justifies a restart — a turn that failed leaves the session
      // perfectly usable, and restarting it would silently discard its context.
      if (s.pid === null) await session.start();

      s.messages.push({
        id: `local-${crypto.randomUUID()}`,
        role: "user",
        blocks: [{ kind: "text", text: body }],
        at: Date.now(),
        parentToolUseId: null,
      });
      // The live read is the point — the reducer may have appended while
      // `start()` was awaited, and the cap must apply to the real list.
      cap(s.messages, MAX_MESSAGES); // aiol-ok

      // The spawn above failed and already reported *why* ("…Set CLAUDE_BIN if
      // it is not on PATH"). Carrying on would call `io.send`, fail with the
      // generic "No session is running." and overwrite the one message that
      // tells the user what to do. Keep the message, keep the cause, stop here.
      if (s.pid === null) { // aiol-ok: re-read after start(), deliberately
        s.status = "error";
        s.turnStartedAt = null;
        return;
      }

      s.status = "working";
      // A turn sent while one is running is queued by the CLI and answered
      // after it (verified against 2.1.232), so the clock in the strip belongs
      // to the turn actually in flight — restarting it here reported a
      // three-minute turn as having just begun.
      s.turnStartedAt ??= Date.now();
      s.streaming = null;
      s.error = null;
      s.interrupting = false;
      note(s, "session", "Turn sent", oneLine(body, 120));

      const io = await import("./claude.server.ts");
      try {
        await io.send(body);
      } catch (e) {
        s.status = "error";
        s.turnStartedAt = null;
        s.error = e instanceof Error ? e.message : String(e);
        log.error("session", "send failed", { error: s.error }); // aiol-ok
        note(s, "error", "Send failed", s.error); // aiol-ok: just written
      }
    },

    /** Stop the current turn, keeping the session alive. */
    async interrupt(s: SessionState) {
      if (s.status !== "working") return;
      s.interrupting = true;
      const io = await import("./claude.server.ts");
      try {
        await io.interrupt();
        note(s, "session", "Interrupt requested", "");
      } catch (e) {
        s.interrupting = false;
        s.error = e instanceof Error ? e.message : String(e);
        log.error("session", "interrupt failed", { error: s.error }); // aiol-ok
      }
    },

    /** Coalesced streaming text for the block being written right now. */
    delta(
      s: SessionState,
      kind: "text" | "thinking",
      text: string,
      token?: number,
    ) {
      if (token !== undefined && token !== s.startToken) return; // superseded
      if (typeof text !== "string" || text.length === 0) return;
      if (s.status !== "working") s.status = "working";
      s.streaming = s.streaming && s.streaming.kind === kind
        ? { kind, text: s.streaming.text + text }
        : { kind, text };
    },

    /* ── the protocol reducer ──────────────────────────────────────────── */

    /** One decoded CLI event → state. Sync and allocation-light: this runs on
     *  every line the model produces. */
    ingest(s: SessionState, evt: Evt, token?: number) {
      // A late line from a process we already replaced belongs to nobody.
      if (token !== undefined && token !== s.startToken) return;
      // The wire is not ours: a truncated line, a future event shape, or a
      // missing payload must never take the session down with it.
      if (!evt || typeof evt !== "object") return;
      switch (evt.type) {
        case "system":
          return system(s, evt);
        case "assistant":
          return assistant(s, evt);
        case "user":
          return userEvent(s, evt);
        case "result":
          return result(s, evt);
        case "rate_limit_event":
          return rateLimit(s, evt);
        case "control_request":
          return controlRequest(s, evt);
        case "control_cancel_request": {
          // The CLI gave up waiting (or the turn was interrupted). The prompt is
          // dead — leaving it on screen would invite an answer nobody reads.
          const id = str(evt.request_id);
          const p = s.permissions.find((r) => r.id === id);
          if (p && p.status === "pending") {
            p.status = "cancelled";
            p.decidedAt = Date.now();
            clearPermissionFlag(s, p.id);
            note(s, "permission", "Approval withdrawn", p.description);
          }
          return;
        }
        case "control_response":
          // Which request an answer belongs to is read from the id it echoes —
          // every control response carries the same success envelope, and
          // taking the handshake's for an interrupt started every session as
          // though one were already in flight.
          if (isHandshakeAck(evt) && s.status === "starting") {
            // The CLI holds `system/init` back until a first turn begins, so
            // this reply is the only "the process is up" there is at startup.
            // Waiting for init left a healthy session reading "Starting…"
            // until somebody typed — the exact silence this app exists to end.
            s.status = "ready";
            note(s, "session", "Session ready", s.model ?? "");
          }
          // Deriving the interrupt flag from the CLI's own reply — not just
          // from our optimistic request — means a request the CLI never
          // honoured cannot silently mask a real failure.
          if (isInterruptAck(evt)) {
            s.interrupting = true;
            note(s, "session", "Interrupt acknowledged", "");
          }
          return;
      }
    },

    /* ── permissions ───────────────────────────────────────────────────── */

    /**
     * Approve a held tool call. `always` also applies the change the CLI
     * suggested (accept edits, add the directory), so the same prompt does not
     * come back on the next call.
     */
    async allowPermission(s: SessionState, id: string, always = false) {
      const req = s.permissions.find((p) => p.id === id);
      if (!req || req.status !== "pending") return;
      const suggestions = always
        ? req.suggestions.map((x) => ({ ...x.raw }))
        : [];
      req.status = "allowed";
      req.decidedAt = Date.now();
      req.appliedSuggestion = always ? req.suggestions[0]?.label ?? null : null;
      clearPermissionFlag(s, id);
      note(
        s,
        "permission",
        always ? `Allowed always · ${req.tool}` : `Allowed · ${req.tool}`,
        req.description,
      );

      const io = await import("./claude.server.ts");
      try {
        await io.allowTool(id, { ...req.input }, suggestions);
      } catch (e) {
        failPermission(s, id, e);
      }
    },

    /** Refuse a held tool call. The reason is handed to the model verbatim. */
    async denyPermission(s: SessionState, id: string, reason = "") {
      const req = s.permissions.find((p) => p.id === id);
      if (!req || req.status !== "pending") return;
      const message = reason.trim() ||
        "The user declined this action in Claude Control.";
      req.status = "denied";
      req.decidedAt = Date.now();
      clearPermissionFlag(s, id);
      note(s, "permission", `Denied · ${req.tool}`, req.description);

      const io = await import("./claude.server.ts");
      try {
        await io.denyTool(id, message);
      } catch (e) {
        failPermission(s, id, e);
      }
    },

    /* ── memory ────────────────────────────────────────────────────────── */

    /**
     * Measure what Claude Code loads as memory for this project.
     *
     * `force` is a user pressing Rescan. The automatic passes — one on start,
     * one on every `system/init` — pass `false`, because the CLI re-emits `init`
     * after every result inside a turn, and a three-sub-agent turn would
     * otherwise walk the memory tree four times over for a figure that had not
     * moved. Pacing only ever holds back a repeat of the *same* measurement:
     * a new project or a newly reported memory directory is taken at once.
     */
    async scanMemory(s: SessionState, force = true) {
      const path = s.cwd ?? activeProject()?.path;
      if (!path) return;
      const key = memoryScanKey(path, session.meta.memoryPaths);
      const scannedAt = s.memoryScannedAt;
      const fresh = scannedAt !== null && Date.now() - scannedAt < RESCAN_MS;
      if (!force && fresh && s.memoryScanKey === key) return;

      const io = await import("./claude.server.ts");
      const files = await io.scanMemory(path, [...session.meta.memoryPaths]);
      s.memory = files;
      s.memoryScannedAt = Date.now();
      s.memoryScanKey = key;
    },

    clearTranscript(s: SessionState) {
      s.messages = [];
      s.streaming = null;
      note(
        s,
        "session",
        "Transcript cleared",
        "view only — the model still remembers",
      );
    },

    dismissError(s: SessionState) {
      s.error = null;
    },
  },
});

/* ── derived reads ────────────────────────────────────────────────────────── */
//
// Plain accessors, not `selectors:` — bound selectors are a server-side
// surface, while these read the cell's reactive getters and so auto-track in
// the UI as well. One definition, both sides of the bridge.

/** Every sub-agent this session has spawned, newest last. */
export const agentRuns = (): ToolRun[] =>
  session.tools.filter((t) => t.kind === "agent");

/** Tool calls that are not sub-agents. */
export const toolRuns = (): ToolRun[] =>
  session.tools.filter((t) => t.kind === "tool");

export const runningAgents = (): ToolRun[] =>
  session.tools.filter((t) => t.kind === "agent" && t.endedAt === null);

export const runningTools = (): ToolRun[] =>
  session.tools.filter((t) => t.kind === "tool" && t.endedAt === null);

export const runningTasks = (): BackgroundTask[] =>
  session.tasks.filter((t) => t.status === "running");

/** Approval prompts the CLI is blocked on, oldest first — answer order is the
 *  order they were asked in. */
export const pendingPermissions = (): PermissionRequest[] =>
  session.permissions.filter((p) => p.status === "pending");

/** Prompts already answered, newest first — the audit trail of what was let
 *  through and what was refused. */
export const decidedPermissions = (): PermissionRequest[] =>
  session.permissions.filter((p) => p.status !== "pending").slice().reverse();

/** Tool calls a sub-agent made, in order — what that agent is *doing*. */
export const agentSteps = (agentToolUseId: string): ToolRun[] =>
  session.tools.filter((t) => t.parentToolUseId === agentToolUseId);

/** Everything in flight that the CLI calls a task: background tasks plus the
 *  tool calls currently executing. */
export const busyTaskCount = (): number =>
  runningTasks().length + runningTools().length;

export const memoryBytes = (): number =>
  session.memory.reduce((n, f) => n + f.bytes, 0);

/** Tokens occupying the context window after the most recent request. Cache
 *  reads count — they are still resident in the window. */
export const contextUsed = (): number => contextUsedOf(session.usage);

export const contextWindow = (): number =>
  session.usage.contextWindow || 200_000;

/* ── event handlers ───────────────────────────────────────────────────────── */

/** A control request from the CLI. Today that is only `can_use_tool`, and the
 *  CLI is *blocked* until the user answers it. */
function controlRequest(s: SessionState, evt: Evt) {
  const req = permissionOf(evt);
  if (!req) return;
  if (s.permissions.some((p) => p.id === req.id)) return; // re-sent, not new

  // The tool call is already in the transcript — mark it so the chip says
  // "waiting for you" instead of counting seconds as if it were working.
  const run = req.toolUseId === null
    ? undefined
    : s.tools.find((t) => t.id === req.toolUseId);
  if (run) {
    run.permissionId = req.id;
    req.parentToolUseId ??= run.parentToolUseId;
  }

  s.permissions.push(req);
  cap(s.permissions, MAX_PERMISSIONS);
  note(
    s,
    "permission",
    `Approval needed · ${req.tool}`,
    req.reason || req.description,
  );
  log.info("session", "permission requested", {
    tool: req.tool,
    reason: req.reasonType,
  });
}

/** Drop the "waiting" flag from whatever call this prompt was holding. */
function clearPermissionFlag(s: SessionState, id: string) {
  const run = s.tools.find((t) => t.permissionId === id);
  if (run) run.permissionId = null;
}

/** The answer could not be delivered — the process died mid-prompt. Say so:
 *  a prompt that silently stays pending is the hang this app exists to end. */
function failPermission(s: SessionState, id: string, e: unknown) {
  const req = s.permissions.find((p) => p.id === id);
  if (req) {
    req.status = "cancelled";
    req.decidedAt = Date.now();
  }
  const detail = e instanceof Error ? e.message : String(e);
  s.error = `Could not send the permission decision: ${detail}`;
  log.error("session", "permission response failed", { error: detail });
  note(s, "error", "Permission decision lost", detail);
}

function system(s: SessionState, evt: Evt) {
  switch (evt.subtype) {
    case "init": {
      s.sessionId = str(evt.session_id);
      s.resumeId = str(evt.session_id) ?? s.resumeId;
      s.cwd = str(evt.cwd) ?? s.cwd;
      s.model = str(evt.model) ?? s.model;
      s.meta = {
        version: str(evt.claude_code_version),
        permissionMode: str(evt.permissionMode),
        outputStyle: str(evt.output_style),
        tools: strings(evt.tools),
        agents: strings(evt.agents),
        skills: strings(evt.skills),
        commands: strings(evt.slash_commands),
        mcp: arr(evt.mcp_servers).map((m) => ({
          name: str(obj(m).name) ?? "server",
          status: str(obj(m).status) ?? "unknown",
        })),
        memoryPaths: Object.values(obj(evt.memory_paths))
          .filter((v): v is string => typeof v === "string"),
      };
      // The CLI re-emits `init` after every result inside one user turn (an
      // async sub-agent finishing wakes the model again). Overwriting the
      // window each time threw away the real figure the last result reported —
      // a 1M-context session kept snapping back to the 200k default. Only fill
      // it in while it is still the untouched default.
      if (s.turns === 0) s.usage.contextWindow = fallbackWindow(s.model);
      if (s.status === "starting") {
        s.status = "ready";
        note(
          s,
          "session",
          "Session ready",
          `${s.meta.tools.length} tools · ${s.model ?? "?"}`,
        );
      }
      return;
    }
    case "status": {
      if (str(evt.status) === "requesting" && s.status !== "working") {
        s.status = "working";
        if (s.turnStartedAt === null) s.turnStartedAt = Date.now();
      }
      return;
    }
    case "task_started": {
      const id = str(evt.task_id);
      if (!id) return;
      const toolUseId = str(evt.tool_use_id);
      upsertTask(s, {
        id,
        type: str(evt.task_type) ?? "task",
        description: str(evt.description) ?? "Background task",
        status: "running",
        toolUseId,
        startedAt: Date.now(),
        endedAt: null,
        outputFile: null,
      });
      // Join the task to the call that launched it. If the launch ack already
      // "finished" that call, reopen it — the work is only just beginning.
      const run = s.tools.find((t) => t.id === toolUseId);
      if (run) {
        run.taskId = id;
        run.endedAt = null;
        run.ok = null;
        // `task_started` is the only place the CLI states the sub-agent's type
        // and its full prompt for *every* agent shape, background or not.
        if (run.agent) {
          run.agent.type = str(evt.subagent_type) ?? run.agent.type;
          run.agent.prompt = str(evt.prompt) ?? run.agent.prompt;
        }
      }
      note(s, "task", "Task started", str(evt.description) ?? id);
      return;
    }
    case "permission_denied": {
      // The CLI refused a call on its own (a mode that never asks, or an answer
      // that arrived too late). Invisible otherwise: the model quietly retries
      // or gives up, and the user is left watching nothing happen.
      const toolUseId = str(evt.tool_use_id);
      const run = toolUseId === null
        ? undefined
        : s.tools.find((t) => t.id === toolUseId);
      if (run) run.permissionId = null;
      const tool = str(evt.tool_name) ?? "tool";
      const why = str(evt.message) ?? "";
      note(s, "permission", `Blocked · ${tool}`, oneLine(why, 200));
      log.warn("session", "tool blocked by permissions", { tool, reason: why });
      return;
    }
    case "task_updated": {
      const id = str(evt.task_id);
      const patch = obj(evt.patch);
      const task = s.tasks.find((t) => t.id === id);
      if (!task) return;
      const status = str(patch.status);
      if (status) task.status = status as BackgroundTask["status"];
      const end = num(patch.end_time);
      if (end > 0) task.endedAt = end;
      else if (task.status !== "running" && task.endedAt === null) {
        task.endedAt = Date.now();
      }
      if (task.status !== "running") closeRunFor(s, task);
      return;
    }
    case "task_notification": {
      const task = s.tasks.find((t) => t.id === str(evt.task_id));
      if (!task) return;
      task.outputFile = str(evt.output_file);
      const status = str(evt.status);
      const summary = str(evt.summary);

      // This is where a *background* sub-agent's answer arrives. Its tool result
      // was only a launch receipt, so without this the sub-agent page showed
      // internal metadata where the result belongs.
      const run = s.tools.find((t) => t.taskId === task.id);
      if (run) {
        if (summary && !run.output) run.output = summary.slice(0, MAX_OUTPUT);
        const usage = obj(evt.usage);
        if (run.agent) {
          run.agent.tokens = num(usage.total_tokens) || run.agent.tokens;
          run.agent.toolUses = numOrNull(usage.tool_uses) ?? run.agent.toolUses;
          run.agent.durationMs = num(usage.duration_ms) || run.agent.durationMs;
        }
      }

      if (status && status !== "running") {
        task.status = status as BackgroundTask["status"];
        task.endedAt ??= Date.now();
        closeRunFor(s, task);
      }
      note(
        s,
        "task",
        `Task ${status ?? "updated"}`,
        summary ?? task.description,
      );
      return;
    }
    case "background_tasks_changed": {
      // Authoritative running set: anything no longer listed has finished, even
      // if we never saw its `task_updated`.
      const running = new Set(
        arr(evt.tasks).map((t) => str(obj(t).task_id)).filter(Boolean),
      );
      for (const t of s.tasks) {
        if (t.status === "running" && !running.has(t.id)) {
          t.status = "completed";
          t.endedAt ??= Date.now();
          closeRunFor(s, t);
        }
      }
      return;
    }
  }
}

function assistant(s: SessionState, evt: Evt) {
  const message = obj(evt.message);
  const id = str(message.id) ?? str(evt.uuid) ?? crypto.randomUUID();
  const parent = str(evt.parent_tool_use_id);
  const blocks = blocksOf(message);
  if (blocks.length === 0) return;

  // Only the main thread's stream is "the" stream: a sub-agent's text arrives
  // on the same channel but belongs under its agent, not in the live bubble.
  if (parent === null) s.streaming = null;

  // A sub-agent runs its own context, and its `usage` is *its* window, not the
  // session's. Taking it made the context meter jump to a 16k sub-agent and
  // back on every delegation. Main-thread messages only.
  if (parent === null) {
    s.model = str(message.model) ?? s.model;
    const usage = obj(message.usage);
    if (Object.keys(usage).length > 0) {
      s.usage = usageOf(usage, s.usage.contextWindow);
    }
  }

  // The CLI splits one message across several events and re-uses its id, and
  // with sub-agents interleaving, the twin is rarely the last row. Matching on
  // the id alone kept the transcript's ids unique — two rows sharing a key made
  // the renderer drop one, which is a message that never appeared.
  const twin = findById(s.messages, id);
  if (twin && twin.role === "assistant") {
    twin.blocks.push(...blocks);
  } else {
    s.messages.push({
      id,
      role: "assistant",
      blocks,
      at: Date.now(),
      parentToolUseId: parent,
    });
    cap(s.messages, MAX_MESSAGES);
  }

  for (const b of blocks) {
    if (b.kind !== "tool") continue;
    openTool(s, b, parent);
  }
}

function openTool(
  s: SessionState,
  b: Block & { kind: "tool" },
  parent: string | null,
) {
  // One tool_use id is one run, the same rule the transcript keeps for message
  // ids. Every later lookup — its result, the task it launched, the approval it
  // is held on — matches by id and finds the first, so a twin would sit in the
  // list for the rest of the session, running and empty, under a duplicate key.
  if (b.id && s.tools.some((t) => t.id === b.id)) return;

  const kind = isAgentTool(b.name) ? "agent" : "tool";
  const run: ToolRun = {
    id: b.id,
    name: b.name,
    kind,
    title: toolTitle(b.name, b.input),
    detail: toolDetail(b.name, b.input),
    input: b.input,
    startedAt: Date.now(),
    endedAt: null,
    ok: null,
    output: null,
    parentToolUseId: parent,
    taskId: null,
    agent: kind === "agent"
      ? {
        type: str(b.input.subagent_type) ?? str(b.input.agentType),
        prompt: str(b.input.prompt),
        tokens: null,
        toolUses: null,
        durationMs: null,
      }
      : null,
    permissionId: null,
  };
  s.tools.push(run);
  cap(s.tools, MAX_TOOLS);
  note(
    s,
    kind,
    kind === "agent" ? "Sub-agent started" : `${b.name} started`,
    run.title,
  );
}

/** The CLI's own explanation for a denial, taken from the failed tool result
 *  it belongs to. `null` when we never saw one. */
function denialReason(s: SessionState, denials: unknown[]): string | null {
  for (const d of denials) {
    const id = str(obj(d).tool_use_id);
    const run = id === null ? undefined : s.tools.find((t) => t.id === id);
    const text = run?.output ?? "";
    if (text.includes("allowed working directories")) return oneLine(text, 220);
  }
  return null;
}

/**
 * A background task ended — so did the call that launched it.
 *
 * Called again whenever the task's status changes, and the later word wins:
 * `background_tasks_changed` only knows a task is *gone* and infers "completed",
 * while the real outcome follows a beat later in `task_updated` (measured
 * against 2.1.232, which sends the empty list first). Closing once left a failed
 * task's call sitting in the list as a green "done", contradicting the task row
 * right above it. The timeline still gets one line, from the first close.
 */
function closeRunFor(s: SessionState, task: BackgroundTask) {
  const run = s.tools.find((t) => t.taskId === task.id);
  if (!run) return;
  const first = run.endedAt === null;
  run.endedAt = task.endedAt ?? run.endedAt ?? Date.now();
  run.ok = task.status === "completed";
  if (!first) return;
  note(
    s,
    run.kind,
    `${run.kind === "agent" ? "Sub-agent" : run.name} ${task.status}`,
    run.title,
  );
}

/**
 * The process is gone, so nothing still open can ever finish.
 *
 * `ok` is left `null` — a call killed in flight neither succeeded nor failed,
 * and the UI reads that third state as "cut off". Leaving the work open instead
 * kept every stopwatch ticking, the rail badges lit and the agent count above
 * zero on a session that had ended: the lying spinner this app exists to end.
 */
function closeOpenWork(s: SessionState, why: string) {
  const at = Date.now();
  let cut = 0;
  for (const run of s.tools) {
    if (run.endedAt !== null) continue;
    run.endedAt = at;
    run.permissionId = null;
    cut++;
  }
  for (const task of s.tasks) {
    if (task.status !== "running") continue;
    // "stopped", not "completed": the CLI never reported an outcome for it.
    task.status = "stopped";
    task.endedAt ??= at;
  }
  if (cut > 0) {
    note(s, "session", `${cut} call${cut > 1 ? "s" : ""} cut off`, why);
  }
}

function userEvent(s: SessionState, evt: Evt) {
  // `user` events on the wire are tool results echoed back. They belong to the
  // tool run that produced them, not to the transcript as a user turn.
  for (const b of blocksOf(obj(evt.message))) {
    if (b.kind !== "result") continue;
    const run = s.tools.find((t) => t.id === b.id);
    if (!run) continue;

    // A sub-agent's result carries the CLI's own bookkeeping — an agent id, an
    // output path, a usage block, and a paragraph telling the model never to
    // quote any of it. The answer is what the user came to read; the numbers
    // belong on the agent, not in the middle of its prose.
    if (run.kind === "agent") {
      const parsed = agentResultOf(b.text);
      run.output = parsed.launchReceipt
        ? run.output
        : parsed.text.slice(0, MAX_OUTPUT);
      if (run.agent) {
        run.agent.tokens = parsed.tokens ?? run.agent.tokens;
        run.agent.toolUses = parsed.toolUses ?? run.agent.toolUses;
        run.agent.durationMs = parsed.durationMs ?? run.agent.durationMs;
      }
    } else {
      run.output = b.text.slice(0, MAX_OUTPUT);
    }

    // An async launch ("agent launched successfully") is a receipt, not a
    // result: the run is joined to a background task that is still going, and
    // closing it here would report a 20-minute agent as having taken 12ms.
    const task = run.taskId === null
      ? undefined
      : s.tasks.find((t) => t.id === run.taskId);
    if (task && task.status === "running") continue;
    // Its task already closed it — keep the richer output, skip a second
    // "finished" line on the timeline.
    if (run.endedAt !== null) continue;

    run.endedAt = Date.now();
    run.ok = b.ok;
    run.permissionId = null;
    note(
      s,
      run.kind,
      `${run.kind === "agent" ? "Sub-agent" : run.name} ${
        b.ok ? "finished" : "failed"
      }`,
      oneLine(run.output || b.text || run.title, 160),
    );
  }
}

function result(s: SessionState, evt: Evt) {
  s.status = "ready";
  s.turns += 1;
  s.turnStartedAt = null;
  s.streaming = null;
  s.lastTurnMs = num(evt.duration_ms);
  // `total_cost_usd` is the session total to date, not this result's slice —
  // and one user turn produces several results (each sub-agent finishing wakes
  // the model again). Summing them reported a $0.06 session as $0.79. Take the
  // highest figure the CLI has reported: monotonic, and never behind.
  s.cost = Math.max(s.cost, num(evt.total_cost_usd));
  s.sessionId = str(evt.session_id) ?? s.sessionId;
  s.resumeId = s.sessionId;

  const window = contextWindowOf(evt, fallbackWindow(s.model), s.model);
  // An aborted turn reports no usage at all. Reading that as a measurement of
  // zero emptied the context meter the moment Stop was pressed — the tokens are
  // still resident in the window; the CLI simply had nothing to say about them.
  // Keep the last real figure, and take the window it now reports either way.
  const measured = usageOf(evt.usage, window);
  s.usage = contextUsedOf(measured) > 0
    ? measured
    : { ...s.usage, contextWindow: window };

  // A turn can fail without the session being broken — the process is still
  // there with its context intact. Only a dead process is `status: "error"`, so
  // the next message continues the conversation instead of silently restarting
  // it. An interrupt the user asked for is not a failure at all.
  if (evt.is_error === true) {
    if (s.interrupting) {
      s.interrupting = false;
      note(s, "session", "Turn interrupted", "the session is still running");
      return;
    }
    s.error = str(evt.result) ?? str(evt.api_error_status) ??
      "The turn failed.";
    log.error("session", "turn failed", { reason: s.error });
    note(s, "error", "Turn failed", oneLine(s.error, 160));
    return;
  }
  s.interrupting = false;

  // Permission denials are reported on the result and are otherwise invisible:
  // the CLI refuses the tool and carries on, so without this the user watches
  // Claude quietly fail to do things and is told nothing.
  const denials = arr(evt.permission_denials);
  if (denials.length > 0) {
    const names = [
      ...new Set(denials.map((d) => str(obj(d).tool_name) ?? "tool")),
    ];
    for (const d of denials) {
      const o = obj(d);
      note(
        s,
        "error",
        `Permission denied · ${str(o.tool_name) ?? "tool"}`,
        oneLine(JSON.stringify(o.tool_input ?? {}), 160),
      );
    }
    // The denial payload says *what* was refused but never *why*. The failed
    // tool result does ("may only write to files in the allowed working
    // directories for this session: '…'") and we already captured it — so
    // quote the CLI instead of guessing, and name the remedy that matches.
    const reason = denialReason(s, denials);
    const n = denials.length;
    const what = `${n} action${n > 1 ? "s" : ""} (${names.join(", ")}) ${
      n > 1 ? "were" : "was"
    } blocked.`;
    const fix =
      "Add the folder under Settings → Allowed directories, or switch on Allow all.";
    s.error = reason ? `${what} ${reason} ${fix}` : `${what} ${fix}`;
    log.warn("session", "permission denied", {
      count: n,
      tools: names,
      reason,
    });
    return;
  }

  note(
    s,
    "model",
    "Turn complete",
    `${(s.lastTurnMs / 1000).toFixed(1)}s · ${num(evt.num_turns)} steps`,
  );
}

function rateLimit(s: SessionState, evt: Evt) {
  const info = obj(evt.rate_limit_info);
  s.rateLimit = {
    status: str(info.status) ?? "unknown",
    type: str(info.rateLimitType) ?? "",
    utilization: num(info.utilization),
    resetsAt: num(info.resetsAt) * 1000,
  };
}

/* ── helpers ──────────────────────────────────────────────────────────────── */

function reset(s: SessionState) {
  s.messages = [];
  s.tools = [];
  s.tasks = [];
  s.permissions = [];
  s.activity = [];
  s.streaming = null;
  s.usage = { ...EMPTY_USAGE };
  s.meta = { ...EMPTY_META };
  s.cost = 0;
  s.turns = 0;
  s.lastTurnMs = 0;
  s.turnStartedAt = null;
  s.interrupting = false;
  // startToken is deliberately NOT reset — it is the identity of the current
  // start, and resetting it would let a superseded callback match again.
  s.rateLimit = null;
  s.sessionId = null;
  s.pid = null;
  s.error = null;
}

function upsertTask(s: SessionState, task: BackgroundTask) {
  const existing = s.tasks.find((t) => t.id === task.id);
  if (existing) Object.assign(existing, task);
  else s.tasks.push(task);
  cap(s.tasks, MAX_TOOLS);
}

function note(
  s: SessionState,
  channel: ActivityItem["channel"],
  label: string,
  detail: string,
) {
  s.activity.push({
    id: crypto.randomUUID(),
    at: Date.now(),
    channel,
    label,
    detail,
  });
  cap(s.activity, MAX_ACTIVITY);
}

/** Keep the newest `max` entries, in place. */
function cap<T>(list: T[], max: number) {
  if (list.length > max) list.splice(0, list.length - max);
}

/** The transcript row with this id, searching from the end — the twin of a
 *  split message is always recent, and the list can be 400 long. */
function findById(messages: Message[], id: string): Message | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].id === id) return messages[i];
  }
  return undefined;
}

/** Nothing can answer a prompt once the process is gone — say so rather than
 *  leaving buttons that write to a closed pipe. */
function cancelPending(s: SessionState, why: string) {
  for (const p of s.permissions) {
    if (p.status !== "pending") continue;
    p.status = "cancelled";
    p.decidedAt = Date.now();
    clearPermissionFlag(s, p.id);
    note(s, "permission", `Approval cancelled · ${p.tool}`, why);
  }
}

const str = (v: unknown): string | null =>
  typeof v === "string" && v.length > 0 ? v : null;
const num = (v: unknown): number => (typeof v === "number" ? v : 0);
/** `0` is a real answer for a count, so absence has to stay distinguishable. */
const numOrNull = (v: unknown): number | null =>
  typeof v === "number" ? v : null;
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v)
    ? v as Record<string, unknown>
    : {};
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const strings = (v: unknown): string[] =>
  arr(v).filter((x): x is string => typeof x === "string");
