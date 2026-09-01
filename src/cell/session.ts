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
 *
 * **One conversation per project.** Each project owns a `claude` process and a
 * transcript of its own, and they run concurrently — a turn started in one
 * project keeps working while you read another, which is the whole point of
 * being able to switch. The record for the project on screen sits at the top
 * level of this cell; every other project's sits in {@link SessionState.parked}.
 * A record is in exactly one of those two places, never both, and `at()` is the
 * only thing that decides which.
 */
import { cell, log, type MethodDraftMeta, schedule } from "aio";
import type {
  ActivityItem,
  AgentStats,
  BackgroundTask,
  Block,
  Message,
  PermissionRequest,
  RateLimit,
  SessionMeta,
  Status,
  ToolRun,
  TurnEnd,
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
import { activeProject, activeSettings, workspace } from "./workspace.ts";

/** Ring-buffer caps. A control surface shows the recent past; unbounded growth
 *  would turn every broadcast into a full-state resend. */
const MAX_MESSAGES = 400;
const MAX_TOOLS = 300;
const MAX_ACTIVITY = 400;
const MAX_OUTPUT = 4_000;
const MAX_PERMISSIONS = 60;

/** How often a running session's working directory is re-checked. Long enough
 *  to be free, short enough that a deleted folder is noticed while the user is
 *  still wondering why nothing works. */
const FOLDER_WATCH_MS = 20_000;

const EMPTY_META: SessionMeta = {
  version: null,
  permissionMode: null,
  outputStyle: null,
  tools: [],
  agents: [],
  skills: [],
  commands: [],
  mcp: [],
  plugins: [],
  memoryPaths: [],
};

const EMPTY_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheCreate: 0,
  contextWindow: 200_000,
};

/**
 * Everything the app knows about ONE project's conversation.
 *
 * The field list is the single source of truth for what gets swapped when the
 * user changes project: {@link blank} builds it, and the swap derives its keys
 * from that, so a field added here is carried automatically rather than being
 * silently left behind on the project you switched away from.
 */
type ProjectSession = {
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
  /** How the last turn ended, straight from the result event. */
  turnEnd: TurnEnd | null;
  /** What became of the sub-agents the last turn asked for. */
  agentStats: AgentStats | null;
  /** Turns the CLI is holding behind the one in flight, as it reports them.
   *  The composer promises a turn sent now will be queued; this is the count
   *  that promise was hiding. */
  queuedTurns: number;
  /** The CLI's running estimate of tokens spent thinking in the current turn.
   *  It is the only figure that moves *during* a long think — every other
   *  number on screen waits for the turn to finish. */
  thinkingTokens: number;
  /** Incremented on every start. Callbacks carry the token they were created
   *  with, so a superseded process cannot write over its replacement. */
  startToken: number;
  meta: SessionMeta;
  rateLimit: RateLimit | null;
  error: string | null;
};

type SessionState = ProjectSession & {
  /** The project whose session is the one at the top level. */
  activeKey: string;
  /** Every *other* project's session, by project id. */
  parked: Record<string, ProjectSession>;
};

/** A conversation that has not started. */
const blank = (): ProjectSession => ({
  status: "offline",
  sessionId: null,
  resumeId: null,
  cwd: null,
  model: null,
  pid: null,
  startedAt: null,
  messages: [],
  streaming: null,
  tools: [],
  tasks: [],
  permissions: [],
  activity: [],
  usage: { ...EMPTY_USAGE },
  cost: 0,
  turns: 0,
  turnStartedAt: null,
  lastTurnMs: 0,
  interrupting: false,
  turnEnd: null,
  agentStats: null,
  queuedTurns: 0,
  thinkingTokens: 0,
  startToken: 0,
  meta: { ...EMPTY_META },
  rateLimit: null,
  error: null,
});

/** The fields one conversation owns — derived from {@link blank}, so the swap
 *  can never fall behind the shape it is swapping. */
const FIELDS = Object.keys(blank()) as (keyof ProjectSession)[];

/** Copy the top-level record out, so it can be parked. */
function lift(s: SessionState): ProjectSession {
  const out = {} as Record<string, unknown>;
  for (const k of FIELDS) out[k] = s[k];
  return out as ProjectSession;
}

/** Move a parked record back to the top level. */
function place(s: SessionState, p: ProjectSession): void {
  for (const k of FIELDS) (s as Record<string, unknown>)[k] = p[k];
}

/**
 * The record for one project, wherever it currently lives.
 *
 * This is what makes a background project's events land somewhere real: a turn
 * finishing in a project you are not looking at reduces into its parked record
 * and its rail badge goes out, rather than being written over the conversation
 * on screen.
 */
function at(s: SessionState, key: string): ProjectSession {
  // The top level starts unclaimed, and the first project to need it takes it.
  // Without this the very first event of a session would open a *parked* record
  // for the project on screen, and the conversation would render as empty while
  // filling up out of sight.
  if (!s.activeKey) {
    s.activeKey = key;
    return s;
  }
  if (key === s.activeKey) return s;
  return s.parked[key] ??= blank();
}

/**
 * Bring another project's conversation to the top level.
 *
 * A plain function, not a method another method calls: a nested same-cell
 * dispatch is *queued*, so `start` would have gone on to reset and spawn
 * against the record it was trying to switch away from, and the swap would land
 * afterwards and throw the new session's own state away.
 */
function applySwitch(s: SessionState, key: string): void {
  if (key === s.activeKey) return;
  // Park the outgoing one first — `place` overwrites the top level, so reading
  // it afterwards would read the incoming record.
  if (s.activeKey) s.parked[s.activeKey] = lift(s);
  const next = s.parked[key];
  delete s.parked[key];
  place(s, next ?? blank());
  s.activeKey = key;
}

/**
 * End one project's session and publish that it is over.
 *
 * A plain helper because both callers need it applied to *this* draft: `stop`
 * from a button, and the folder watchdog from a poll that may be closing a
 * project nobody is looking at.
 */
async function endSession(
  s: SessionState,
  key: string,
  why: string,
  error: string,
): Promise<void> {
  const cur = at(s, key);
  // The process being ended is no longer this session's, so nothing it says on
  // the way out may write here — bump the identity first and every one of its
  // callbacks is ignored as superseded.
  //
  // Without this, Stop mid-turn read as a crash: closing stdin does not end the
  // CLI while it is answering (measured against 2.1.232), so the frames still in
  // flight landed as a *failed turn*, and the SIGTERM that follows came back as
  // exit 143 — "Exited (code 143)" in red, for a button the user pressed on
  // purpose.
  cur.startToken += 1;
  // Published before the teardown is awaited, not after: ending the process
  // takes up to a second and a half, and the session is over the moment the
  // button is pressed — nothing more will be read from it or written to it.
  cur.status = "offline";
  cur.turnStartedAt = null;
  cur.streaming = null;
  cur.interrupting = false;
  cur.pid = null;
  if (error) cur.error = error;
  cancelPending(cur, why);
  closeOpenWork(cur, why);
  note(cur, "session", "Session stopped", error);

  const io = await import("./claude.server.ts");
  await io.stop(key);
}

/** Which project a call with no key of its own is about: the one on screen.
 *
 *  Every process callback supplies its own key, because a background project's
 *  events must not follow the selection. This is only for the calls a *user*
 *  makes — send, stop, interrupt, answer an approval — which are always about
 *  what they are looking at. */
const currentKey = (s: SessionState): string =>
  workspace.activeId || s.activeKey;

export const session = cell("session", {
  persist: "none",

  // `activeKey` ends in "Key" and is not a secret — it is a project id the
  // client already has. Declared rather than excluded, because the UI reads it,
  // and a boot-time warning nobody can act on is how real warnings come to be
  // ignored.
  visible: { publicFields: ["activeKey"] },

  // The session owns a real OS process, so shutting the cell down has to end
  // it. Best-effort by contract — the framework calls this without awaiting —
  // which is why `claude.server.ts` also guards the signal and unload paths
  // itself; between them, no exit route leaves a `claude` running.
  onInit() {
    // The runtime is not up during `onInit`, so the watchdog arms itself on the
    // next macrotask — the same constraint every other cell here works around.
    setTimeout(() => void session.watchFolders(), 0); // aiol-ok
  },

  onDestroy() {
    // Every project's process, not just the one on screen — there are now as
    // many as there are projects you have started.
    void import("./claude.server.ts").then((io) => io.stopAll()).catch(
      () => {},
    );
  },

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
    turnEnd: null as TurnEnd | null,
    agentStats: null as AgentStats | null,
    queuedTurns: 0,
    thinkingTokens: 0,
    startToken: 0,
    meta: { ...EMPTY_META },
    rateLimit: null as RateLimit | null,
    error: null as string | null,

    activeKey: "",
    parked: {} as Record<string, ProjectSession>,
  },

  methods: {
    /* ── lifecycle ─────────────────────────────────────────────────────── */

    /**
     * Bring another project's conversation to the top level.
     *
     * Nothing is started or stopped: the process you switch away from keeps
     * running, keeps streaming, and keeps reducing into its parked record. The
     * only thing that moves is which record the top level holds.
     */
    switchTo(s: SessionState, key: string) {
      applySwitch(s, key);
    },

    /** Start (or restart) the session for the active project. `resume` hands
     *  the CLI its previous session id, so the model keeps everything it knew;
     *  the CLI replays none of it on the wire, so the transcript here starts
     *  empty and fills from the next turn on (measured against 2.1.232). */
    async start(s: SessionState, resume = false) {
      const project = activeProject();
      // The switch normally arrives from `workspace.select`; doing it here too
      // makes `start()` correct when it is the first thing that happens, which
      // is what boot and every test do. Applied directly rather than
      // dispatched — see `applySwitch`.
      if (project) applySwitch(s, project.id);
      if (!project) {
        s.error = "Add a project directory first — Settings → Projects.";
        s.status = "error";
        return;
      }
      // A persisted project is a claim about a directory, and directories go
      // away between runs. Spawning into one that is gone failed with a bare
      // "Could not start" and left the user with nothing to act on, while the
      // remedy — pick another project, or remove this one — was one page away
      // and unlabelled. Say which folder, and say what to do about it.
      if (project.missing) {
        s.error =
          `The project folder is gone: ${project.path} — pick another project ` +
          `in Settings, or remove it from the list.`;
        s.status = "error";
        log.error("session", "project directory is missing", {
          path: project.path,
        });
        note(s, "error", "Project folder is gone", project.path);
        return;
      }
      const key = project.id;
      const settings = activeSettings();
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
      s.model = settings.model;
      s.startedAt = Date.now();
      s.resumeId = resumeId;
      note(s, "session", "Starting session", `${project.path} · ${s.model}`);

      const io = await import("./claude.server.ts");
      try {
        const { pid } = await io.start(key, {
          cwd: project.path,
          model: settings.model,
          permissionMode: settings.permissionMode,
          allowedDirs: [...settings.allowedDirs],
          skipPermissions: settings.skipPermissions,
          effort: settings.effort,
          resume: resumeId,
        }, {
          // These four are *process callbacks*, not nested calls: they are
          // stored now and invoked later, from the stdout reader, long after
          // this method has returned. Each one has to be its own dispatch —
          // that is what a reducer fed by a live stream is. `aiol` sees only the
          // lexical nesting, and this cell is `transaction: false` besides, so
          // there is no pinned snapshot for them to read stale.
          // Every callback carries the project it belongs to. Without it a
          // background project's events would reduce into whatever happens to
          // be on screen when they arrive.
          onEvent: (evt) => {
            void session.ingest(evt as Evt, token, key); // aiol-ok: callback
            // `system/init` is the only place the CLI names the session's own
            // memory directories, and it re-emits after every result — so this
            // is the cheap memory-only pass, paced inside the catalog, not the
            // whole configuration walk.
            if (evt.type === "system" && evt.subtype === "init") {
              void import("./catalog.ts").then((m) =>
                // aiol-ok: callback
                m.catalog.refreshMemory(false)
              );
            }
          },
          onDelta: (kind, text) => {
            void session.delta(kind, text, token, key); // aiol-ok: callback
          },
          onExit: (code, detail) => {
            void session.exited(code, detail, token, key); // aiol-ok: callback
          },
        });
        s.pid = pid;
      } catch (e) {
        s.status = "error";
        s.error = e instanceof Error ? e.message : String(e);
        log.error("session", "could not start Claude Code", {
          cwd: project.path,
          model: settings.model,
          error: s.error, // aiol-ok: written two lines above
        });
        // aiol-ok: live read of a value written one line above, by design
        note(s, "error", "Could not start", s.error);
        // The commonest cause is a folder that has been deleted since it was
        // remembered. Re-checking here is what makes the Projects list honest by
        // the time the user gets to it — otherwise the row that just failed
        // still looks perfectly fine.
        void workspace.refreshProjects();
      }
    },

    /**
     * End a project's session. Defaults to the one on screen.
     *
     * `key` is what lets the dock close a *background* project's session
     * without switching to it first — switching to a session in order to end it
     * would mean the last thing you did before closing it was disturb whatever
     * you were actually reading.
     *
     * The transcript stays. The CLI keeps its own on disk too, so `resumeId`
     * remains valid and Resume brings the context back; throwing the
     * conversation away on a mis-click would be the expensive mistake here.
     */
    async stop(s: SessionState, key?: string) {
      const project = key ?? currentKey(s);
      await endSession(s, project, "the session was stopped", "");
    },

    /**
     * Close any session whose project folder has gone.
     *
     * Polled, because a deleted directory produces no event — nothing tells a
     * running `claude` that the ground it is standing on is gone. Left alone it
     * keeps a process, a context and a token bill alive for a codebase that no
     * longer exists, and every tool call it makes fails in a way that reads like
     * the model being confused rather than the folder being deleted.
     *
     * Only sessions with a live process are checked: a `stat` per running
     * session is nothing, and a project nobody has started has nothing to close.
     */
    async watchFolders(s: SessionState & Partial<MethodDraftMeta>) {
      s.$do?.(schedule.every(
        "session-folders",
        FOLDER_WATCH_MS,
        session
          .watchFolders.action(),
        { skipIfRunning: true },
      ));

      // Read before the first await, so the list is one consistent view of what
      // was running when the tick began rather than a mix of before and after.
      const live: { key: string; cwd: string }[] = [];
      for (const key of [s.activeKey, ...Object.keys(s.parked)]) {
        if (!key) continue;
        const rec = at(s, key);
        if (rec.pid !== null && rec.cwd) live.push({ key, cwd: rec.cwd });
      }
      if (live.length === 0) return;

      const io = await import("./claude.server.ts");

      // Gathered first, then acted on: the stats are I/O and the records may be
      // parked or unparked by a project switch while they run.
      const gone = (await Promise.all(
        live.map(async (l) => await io.isDirectory(l.cwd) ? null : l),
      )).filter((l) => l !== null);

      for (const l of gone) {
        log.warn("session", "working directory is gone — closing session", {
          cwd: l.cwd,
        });
        await endSession(
          s,
          l.key,
          "its project folder was deleted",
          `The folder is gone: ${l.cwd}`,
        );
      }
      // The Projects list is where the remedy is, so it has to be honest by the
      // time the user gets there.
      if (gone.length > 0) void workspace.refreshProjects();
    },

    /** Reported by the process watcher — never called from the UI.
     *
     *  `key` is the project whose process ended, which need not be the one on
     *  screen: a background session can exit while you are reading another. */
    exited(
      s: SessionState,
      code: number,
      detail: string,
      token?: number,
      key?: string,
    ) {
      const p = at(s, key ?? currentKey(s));
      if (token !== undefined && token !== p.startToken) return; // superseded
      p.pid = null;
      p.turnStartedAt = null;
      p.streaming = null;
      p.interrupting = false;
      cancelPending(p, "the session ended");
      closeOpenWork(p, "the session ended");
      if (code === 0 || p.status === "offline") {
        p.status = "offline";
        note(p, "session", "Session ended", "");
        return;
      }
      p.status = "error";
      p.error = detail || `Claude Code exited with code ${code}.`;
      log.error("session", "Claude Code exited", { code, detail, key });
      note(p, "error", `Exited (code ${code})`, oneLine(p.error, 160));
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

      // Sent while a turn is already in flight: the CLI will queue it, and the
      // count is corrected by the next result either way.
      //
      // The live read is the point — the reducer has been running throughout
      // the awaits above, and "is a turn in flight *now*" is the only question
      // worth asking here. aiol-ok: deliberate live read
      if (s.status === "working") s.queuedTurns += 1;
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
        await io.send(currentKey(s), body); // aiol-ok: the key is not state
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
        await io.interrupt(currentKey(s)); // aiol-ok: the key is not state
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
      key?: string,
    ) {
      const cur = at(s, key ?? currentKey(s));
      if (token !== undefined && token !== cur.startToken) return; // superseded
      if (typeof text !== "string" || text.length === 0) return;
      if (cur.status !== "working") cur.status = "working";
      cur.streaming = cur.streaming && cur.streaming.kind === kind
        ? { kind, text: cur.streaming.text + text }
        : { kind, text };
    },

    /* ── the protocol reducer ──────────────────────────────────────────── */

    /** One decoded CLI event → state. Sync and allocation-light: this runs on
     *  every line the model produces. */
    /**
     * One decoded protocol event, reduced into the project it came from.
     *
     * `key` is that project. It is not optional in spirit — every process
     * callback supplies it — but it defaults to the project on screen so a test
     * driving a single session need not invent one.
     */
    ingest(s: SessionState, evt: Evt, token?: number, key?: string) {
      const cur = at(s, key ?? currentKey(s));
      // A late line from a process we already replaced belongs to nobody.
      if (token !== undefined && token !== cur.startToken) return;
      // The wire is not ours: a truncated line, a future event shape, or a
      // missing payload must never take the session down with it.
      if (!evt || typeof evt !== "object") return;
      switch (evt.type) {
        case "system":
          return system(cur, evt);
        case "assistant":
          return assistant(cur, evt);
        case "user":
          return userEvent(cur, evt);
        case "result":
          return result(cur, evt);
        case "rate_limit_event":
          return rateLimit(cur, evt);
        case "control_request":
          return controlRequest(cur, evt);
        case "control_cancel_request": {
          // The CLI gave up waiting (or the turn was interrupted). The prompt is
          // dead — leaving it on screen would invite an answer nobody reads.
          const id = str(evt.request_id);
          const req = cur.permissions.find((r) => r.id === id);
          if (req && req.status === "pending") {
            req.status = "cancelled";
            req.decidedAt = Date.now();
            clearPermissionFlag(cur, req.id);
            note(cur, "permission", "Approval withdrawn", req.description);
          }
          return;
        }
        case "control_response":
          // Which request an answer belongs to is read from the id it echoes —
          // every control response carries the same success envelope, and
          // taking the handshake's for an interrupt started every session as
          // though one were already in flight.
          if (isHandshakeAck(evt) && cur.status === "starting") {
            // The CLI holds `system/init` back until a first turn begins, so
            // this reply is the only "the process is up" there is at startup.
            // Waiting for init left a healthy session reading "Starting…"
            // until somebody typed — the exact silence this app exists to end.
            cur.status = "ready";
            note(cur, "session", "Session ready", cur.model ?? "");
          }
          // Deriving the interrupt flag from the CLI's own reply — not just
          // from our optimistic request — means a request the CLI never
          // honoured cannot silently mask a real failure.
          if (isInterruptAck(evt)) {
            cur.interrupting = true;
            note(cur, "session", "Interrupt acknowledged", "");
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
        await io.allowTool(currentKey(s), id, { ...req.input }, suggestions);
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
        await io.denyTool(currentKey(s), id, message);
      } catch (e) {
        failPermission(s, id, e);
      }
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
/**
 * The conversation on screen.
 *
 * Every read in the UI goes through this rather than through the cell's fields
 * directly. The top level *is* the active project's record almost always — but
 * the swap that makes it so is dispatched when the project changes, so for the
 * tick in between, the fields at the top level still describe the project you
 * just left. Resolving by key instead of trusting position means a switch can
 * never flash the wrong transcript.
 */
export const view = (): ProjectSession => {
  const key = workspace.activeId;
  // No project at all: the top level is the only conversation there is.
  if (!key || key === session.activeKey) return session;
  return session.parked[key] ?? EMPTY_SESSION;
};

/** What a project with no conversation yet looks like. Shared and never
 *  written to — it stands in for "nothing has happened here". */
const EMPTY_SESSION: ProjectSession = blank();

/** One project's conversation, wherever it lives. Used by the dock, which has
 *  to report every project's session, not just the one on screen. */
export const sessionOf = (projectId: string): ProjectSession =>
  projectId === session.activeKey || !session.activeKey
    ? session
    : session.parked[projectId] ?? EMPTY_SESSION;

/** Projects with a conversation that is doing something right now. */
export const busyProjects = (): string[] =>
  workspace.projects
    .map((p) => p.id)
    .filter((id) => sessionOf(id).status === "working");

/** Approvals waiting in a project that is NOT on screen.
 *
 *  The CLI is blocked on each of them, and the prompt only renders for the
 *  project you are looking at — so without this, switching away from a session
 *  mid-approval would leave it stalled with nothing anywhere saying so. */
export const backgroundApprovals = (): { id: string; count: number }[] =>
  workspace.projects
    .filter((p) => p.id !== workspace.activeId)
    .map((p) => ({
      id: p.id,
      count: sessionOf(p.id).permissions.filter((r) => r.status === "pending")
        .length,
    }))
    .filter((x) => x.count > 0);

export const agentRuns = (): ToolRun[] =>
  view().tools.filter((t) => t.kind === "agent");

/** Tool calls that are not sub-agents. */
export const toolRuns = (): ToolRun[] =>
  view().tools.filter((t) => t.kind === "tool");

export const runningAgents = (): ToolRun[] =>
  view().tools.filter((t) => t.kind === "agent" && t.endedAt === null);

export const runningTools = (): ToolRun[] =>
  view().tools.filter((t) => t.kind === "tool" && t.endedAt === null);

export const runningTasks = (): BackgroundTask[] =>
  view().tasks.filter((t) => t.status === "running");

/** Approval prompts the CLI is blocked on, oldest first — answer order is the
 *  order they were asked in. */
export const pendingPermissions = (): PermissionRequest[] =>
  view().permissions.filter((p) => p.status === "pending");

/** Prompts already answered, newest first — the audit trail of what was let
 *  through and what was refused. */
export const decidedPermissions = (): PermissionRequest[] =>
  view().permissions.filter((p) => p.status !== "pending").slice().reverse();

/** Tool calls a sub-agent made, in order — what that agent is *doing*. */
export const agentSteps = (agentToolUseId: string): ToolRun[] =>
  view().tools.filter((t) => t.parentToolUseId === agentToolUseId);

/** Everything in flight that the CLI calls a task: background tasks plus the
 *  tool calls currently executing. */
export const busyTaskCount = (): number =>
  runningTasks().length + runningTools().length;

/** Tokens occupying the context window after the most recent request. Cache
 *  reads count — they are still resident in the window. */
export const contextUsed = (): number => contextUsedOf(view().usage);

export const contextWindow = (): number =>
  view().usage.contextWindow || 200_000;

/* ── event handlers ───────────────────────────────────────────────────────── */

/** A control request from the CLI. Today that is only `can_use_tool`, and the
 *  CLI is *blocked* until the user answers it. */
function controlRequest(s: ProjectSession, evt: Evt) {
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
function clearPermissionFlag(s: ProjectSession, id: string) {
  const run = s.tools.find((t) => t.permissionId === id);
  if (run) run.permissionId = null;
}

/** The answer could not be delivered — the process died mid-prompt. Say so:
 *  a prompt that silently stays pending is the hang this app exists to end. */
function failPermission(s: ProjectSession, id: string, e: unknown) {
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

function system(s: ProjectSession, evt: Evt) {
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
        plugins: arr(evt.plugins).map((x) => ({
          name: str(obj(x).name) ?? "plugin",
          version: str(obj(x).version) ?? "",
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
    case "thinking_tokens": {
      // Emitted continuously while the model reasons. Everything else on screen
      // is frozen until the turn lands, so without this a five-minute think
      // looked identical to a hang.
      s.thinkingTokens = num(evt.estimated_tokens);
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

function assistant(s: ProjectSession, evt: Evt) {
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
  s: ProjectSession,
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
function denialReason(s: ProjectSession, denials: unknown[]): string | null {
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
function closeRunFor(s: ProjectSession, task: BackgroundTask) {
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
function closeOpenWork(s: ProjectSession, why: string) {
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

function userEvent(s: ProjectSession, evt: Evt) {
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

function result(s: ProjectSession, evt: Evt) {
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
  // The CLI queues a turn sent while one is running and says how many it holds.
  // The composer already promised the queueing; this is what makes the promise
  // checkable instead of a claim the user has to trust.
  s.queuedTurns = num(evt.queued_turn_count);
  // The estimate belongs to the turn that just ended.
  s.thinkingTokens = 0;
  s.turnEnd = {
    reason: str(evt.terminal_reason) ?? "",
    stopReason: str(evt.stop_reason) ?? "",
    ttftMs: num(evt.ttft_ms),
  };
  recordAgentStats(s, evt);

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

/**
 * What the turn's sub-agents actually did — and, above all, what it was refused.
 *
 * A delegation turned down for a depth, concurrency or budget limit produces no
 * agent, no error and no row on any page: the model simply carries on without
 * the help it asked for, and the user watches it work around a gap nobody
 * mentioned. The CLI does say so, once, in this block. So does a sub-agent that
 * failed or was killed.
 */
function recordAgentStats(s: ProjectSession, evt: Evt) {
  const raw = obj(evt.subagent_stats);
  if (Object.keys(raw).length === 0) return;
  const refusedBy = Object.entries(obj(raw.refused))
    .map(([reason, n]) => ({ reason, count: num(n) }))
    .filter((r) => r.count > 0);
  const killed = Object.values(obj(raw.killed)).reduce<number>(
    (t, n) => t + num(n),
    0,
  );
  const stats: AgentStats = {
    spawned: num(raw.spawned),
    completed: num(raw.completed),
    failed: num(raw.failed),
    refused: refusedBy.reduce((t, r) => t + r.count, 0),
    killed,
    refusedBy,
  };
  s.agentStats = stats;

  if (stats.refused > 0) {
    const why = stats.refusedBy
      .map((r) => `${r.count} on the ${r.reason.replace(/_/g, " ")}`)
      .join(", ");
    const message =
      `${stats.refused} sub-agent request${stats.refused > 1 ? "s" : ""} ` +
      `${
        stats.refused > 1 ? "were" : "was"
      } refused (${why}). Claude carried ` +
      `on without them.`;
    s.error = message;
    log.warn("session", "sub-agent requests refused", {
      refused: stats.refused,
      by: stats.refusedBy,
    });
    note(s, "error", "Sub-agents refused", message);
  }
  if (stats.failed > 0 || stats.killed > 0) {
    note(
      s,
      "agent",
      "Sub-agents did not finish",
      `${stats.failed} failed · ${stats.killed} killed`,
    );
  }
}

function rateLimit(s: ProjectSession, evt: Evt) {
  const info = obj(evt.rate_limit_info);
  // `unifiedWindows` carries every window at once. The headline `rateLimitType`
  // names only the one the CLI chose to lead with, and a session that is fine
  // on the five-hour window can be at 99% of the seven-day one — the figure
  // that actually decides whether the next turn runs.
  const windows = Object.entries(obj(info.unifiedWindows))
    .map(([name, raw]) => ({
      name,
      utilization: num(obj(raw).utilization),
      resetsAt: num(obj(raw).resetsAt) * 1000,
    }))
    .sort((a, b) => b.utilization - a.utilization);
  s.rateLimit = {
    status: str(info.status) ?? "unknown",
    type: str(info.rateLimitType) ?? "",
    utilization: num(info.utilization),
    resetsAt: num(info.resetsAt) * 1000,
    overage: info.isUsingOverage === true,
    windows,
  };
}

/* ── helpers ──────────────────────────────────────────────────────────────── */

function reset(s: ProjectSession) {
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
  s.turnEnd = null;
  s.agentStats = null;
  s.queuedTurns = 0;
  s.thinkingTokens = 0;
  // startToken is deliberately NOT reset — it is the identity of the current
  // start, and resetting it would let a superseded callback match again.
  s.rateLimit = null;
  s.sessionId = null;
  s.pid = null;
  s.error = null;
}

function upsertTask(s: ProjectSession, task: BackgroundTask) {
  const existing = s.tasks.find((t) => t.id === task.id);
  if (existing) Object.assign(existing, task);
  else s.tasks.push(task);
  cap(s.tasks, MAX_TOOLS);
}

function note(
  s: ProjectSession,
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
function cancelPending(s: ProjectSession, why: string) {
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
