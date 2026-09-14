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
  controlError,
  type Evt,
  fallbackWindow,
  isAgentTool,
  isHandshakeAck,
  isInterruptAck,
  isModelAck,
  MODEL_PREFIX,
  MODELS,
  permissionOf,
  toolDetail,
  toolTitle,
  usageOf,
} from "../lib/stream.ts";
import { oneLine, perSecond } from "../lib/format.ts";
import {
  assistant,
  blank,
  cancelPending,
  cap,
  clearPermissionFlag,
  closeOpenWork,
  controlRequest,
  EMPTY_META,
  EMPTY_USAGE,
  failPermission,
  MAX_MESSAGES,
  note,
  offlineAgain,
  type ProjectSession,
  rateLimit,
  reset,
  result,
  str,
  system,
  userEvent,
} from "./session-reduce.ts";

import {
  activeProject,
  activeSessionKey,
  activeSettings,
  panesOf,
  projectOfPane,
  workspace,
} from "./workspace.ts";

/** How often a running session's working directory is re-checked. Long enough
 *  to be free, short enough that a deleted folder is noticed while the user is
 *  still wondering why nothing works. */
const FOLDER_WATCH_MS = 20_000;

type SessionState = ProjectSession & {
  /** The project whose session is the one at the top level. */
  activeKey: string;
  /** Every *other* project's session, by project id. */
  parked: Record<string, ProjectSession>;
};

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
  activeSessionKey() || s.activeKey;

export const session = cell("session", {
  /**
   * The conversations are kept; the process is not.
   *
   * This was `"none"` on the reasoning that a transcript is a record of a live
   * process. Half right, and the wrong half is the half a person cares about:
   * the process is indeed gone at the next launch, but the CONVERSATION is
   * work — decisions, explanations, the reason a file looks the way it does —
   * and losing it to a restart is losing the only copy on this machine.
   *
   * So everything is persisted and `onRestore` puts back the truth about the
   * process, once, at boot. The transcript is bounded already: 400 messages a
   * conversation, and a tool's output capped where it is read (`MAX_RESULT` in
   * lib/stream.ts), which is what keeps this a few megabytes rather than a few
   * hundred.
   */
  persist: "all",

  /** Nothing here ran a program since the app closed. {@link offlineAgain}
   *  says what that costs, and is applied to the conversation on screen and to
   *  every parked one alike. */
  onRestore(s: SessionState) {
    offlineAgain(s);
    for (const key of Object.keys(s.parked)) offlineAgain(s.parked[key]);
  },

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
    // Arming is all boot does: the first folder check then lands one poll
    // interval later, which is the check's own resolution anyway.
    setTimeout(() => void session.armFolderWatch(), 0); // aiol-ok
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
    cleared: [] as Message[],
    turnStartedAt: null as number | null,
    lastTurnMs: 0,
    lastTurnOutput: 0,
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
      // The conversation being started is the one on screen — which is a pane
      // now, not a project: a project can hold several, and starting one must
      // not restart another.
      const key = currentKey(s);
      const project = activeProject();
      // The switch normally arrives from `workspace.select`; doing it here too
      // makes `start()` correct when it is the first thing that happens, which
      // is what boot and every test do. Applied directly rather than
      // dispatched — see `applySwitch`.
      if (project) applySwitch(s, key);
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
     * A project is no longer in the list: end its session and let go of it.
     *
     * Removing a project used to leave its `claude` running with nothing left
     * that could reach it — the exact failure the folder watchdog exists to
     * prevent, arrived at through the remove button instead of through a
     * deleted directory. A process this app started is this app's to end.
     *
     * The parked transcript goes too. It is in-memory only, it belongs to a
     * project the user has just said they do not want listed, and an undo that
     * brings the row back does not owe them the conversation.
     */
    async release(s: SessionState, keys: string[]) {
      // Nothing to release is not an error — and a control-plane call with the
      // argument left off must not reject on a `for…of undefined`.
      if (!Array.isArray(keys)) return;
      for (const key of keys) {
        await endSession(s, key, "the project was removed", "");
        delete s.parked[key];
      }
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
    /** Start the folder watch, once. Kept out of {@link watchFolders}
     *  deliberately — re-arming `every` from inside its own tick replaces the
     *  timer on every pass, which aio rightly warns about ("set dynamically
     *  twice") and which drifts the deadline by however long a tick took.
     *  Same split as `jobs.arm`/`loops.arm`. */
    armFolderWatch(s: SessionState & Partial<MethodDraftMeta>) {
      s.$do?.(schedule.every(
        "session-folders",
        FOLDER_WATCH_MS,
        session.watchFolders.action(),
        { skipIfRunning: true },
      ));
    },

    async watchFolders(s: SessionState) {
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

    /* ── what the session runs on ──────────────────────────────────────── */

    /**
     * Switch model — on the session that is *running*, not only the next one.
     *
     * The picker used to write a preference and nothing else, so a live session
     * kept answering out of the model it was spawned with. That is invisible
     * right up to the moment it matters most: a session whose model has hit its
     * usage limit answers every further turn with the same limit notice, and
     * changing the model — the one thing the notice itself tells you to do —
     * appeared to do nothing at all.
     *
     * The CLI's `set_model` control request applies from the next turn on and
     * keeps the conversation, its context and its tool state, so this is a
     * switch rather than a restart. Both halves are done here, in one place, so
     * the preference the next session starts with and the model this one is on
     * cannot drift apart.
     */
    async useModel(s: SessionState, model: string) {
      // Closed over the picker's own list, like `workspace.setModel` — a model
      // id from anywhere else is not a model this app offers.
      if (!MODELS.some((m) => m.id === model)) return;
      // Read before either await: whether there is a process to tell is a
      // question about now, not about after the preference has committed.
      const live = s.pid !== null;
      // Optimistic, and corrected by the CLI either way: the next assistant
      // message names the model it actually answered from, and a refusal is
      // reduced in `control_response` below.
      if (live) {
        s.model = model;
        note(s, "session", "Model switched", model);
      }
      // The preference is what the *next* session is spawned with, and it has
      // to hold whether or not there was a process to tell.
      await workspace.setModel(model);
      if (!live) return;

      const io = await import("./claude.server.ts");
      try {
        await io.setModel(currentKey(s), model); // aiol-ok: the key is not state
      } catch (e) {
        s.error = e instanceof Error ? e.message : String(e);
        log.error("session", "model switch failed", { model, error: s.error }); // aiol-ok
        note(s, "error", "Model switch failed", s.error); // aiol-ok: just written
      }
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

      // A new message ends the window in which the last clear can be undone —
      // and lets go of the transcript it was holding.
      s.cleared = [];
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
    ingest(
      s: SessionState,
      evt: Evt,
      // The defaults are spelled out rather than left as `?`: the runtime reads
      // "this call is complete" from the signature's own defaults, and a `?`
      // alone made every two-argument call look like a call missing its rest.
      token: number | undefined = undefined,
      key: string | undefined = undefined,
    ) {
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
          if (isModelAck(evt)) {
            note(cur, "session", "Model switch accepted", cur.model ?? "");
          }
          // A refused switch has to be visible, or the strip would go on
          // naming a model the session is not on — the same silent lie the
          // switch was added to end.
          {
            const failed = controlError(evt);
            if (failed?.id.startsWith(MODEL_PREFIX)) {
              cur.error = `The model switch was refused: ${failed.error}`;
              log.error("session", "model switch refused", {
                error: failed.error,
              });
              note(cur, "error", "Model switch refused", failed.error);
            }
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

    /**
     * Empty the transcript on screen. The CLI keeps its own memory.
     *
     * What was cleared is kept, once, so this is a decision that can be taken
     * back. A transcript is the record of real work and there is no other copy
     * of it in this app — a button that destroys one with no way back is a
     * button people are right to be afraid of.
     */
    clearTranscript(s: SessionState) {
      const cur = at(s, currentKey(s));
      if (cur.messages.length > 0) cur.cleared = cur.messages;
      cur.messages = [];
      cur.streaming = null;
      note(
        s,
        "session",
        "Transcript cleared",
        "view only — the model still remembers",
      );
    },

    /** Put back what the last clear took away. A no-op once anything new has
     *  arrived: the undo is for the moment right after, not for merging a
     *  week-old transcript into a live one. */
    undoClear(s: SessionState) {
      const cur = at(s, currentKey(s));
      if (cur.cleared.length === 0 || cur.messages.length > 0) return;
      cur.messages = cur.cleared;
      cur.cleared = [];
    },

    /**
     * Send the last thing you said, again.
     *
     * The turn that failed is not retried — its text is. The CLI keeps its own
     * context, so re-sending the prompt continues the same conversation rather
     * than replaying anything, and an API overload (the usual reason a turn
     * dies) leaves nothing else to undo.
     *
     * Refused while a turn is running: "again" would mean queueing a duplicate
     * behind the one that is already working.
     */
    async retry(s: SessionState) {
      const cur = at(s, currentKey(s));
      if (cur.status === "working") return;
      const last = [...cur.messages].reverse().find((m) =>
        m.role === "user" && m.parentToolUseId === null
      );
      const text = last?.blocks
        .filter((b) => b.kind === "text")
        .map((b) => b.text)
        .join("\n")
        .trim();
      if (!text) return;
      cur.error = null;
      await session.send(text);
    },

    /**
     * End every project's process, not just the one on screen.
     *
     * The transcripts stay — a stopped session is a process that is gone, not
     * a conversation that was deleted, and Resume brings its context back.
     * There are as many processes as there are projects you have started, and
     * the only other way to end them all is to quit the app.
     */
    async stopAll(s: SessionState) {
      const keys = [s.activeKey, ...Object.keys(s.parked)].filter(Boolean);
      for (const key of keys) {
        // `endSession` publishes "offline" before awaiting the teardown, so
        // the list goes quiet immediately rather than one project at a time.
        await endSession(s, key, "stopped every session", "");
      }
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
  const key = activeSessionKey();
  // No project at all: the top level is the only conversation there is.
  if (!key || key === session.activeKey) return session;
  return session.parked[key] ?? EMPTY_SESSION;
};

/** What a project with no conversation yet looks like. Shared and never
 *  written to — it stands in for "nothing has happened here". */
const EMPTY_SESSION: ProjectSession = blank();

/** One conversation, wherever it lives. Takes a *pane* id — which for a
 *  project's first conversation is the project's own id, so every existing
 *  caller keeps working. */
export const sessionOf = (key: string): ProjectSession =>
  key === session.activeKey || !session.activeKey
    ? session
    : session.parked[key] ?? EMPTY_SESSION;

/** Every conversation a project has, by pane id. */
export const sessionsOf = (projectId: string): string[] =>
  panesOf(projectId).filter((p) => p.kind === "session").map((p) => p.id);

/** Projects with *any* conversation doing something right now. The dock marks
 *  a project, not one of its tabs, so one busy conversation lights the tab. */
export const busyProjects = (): string[] =>
  workspace.projects
    .map((p) => p.id)
    .filter((id) =>
      sessionsOf(id).some((k) => sessionOf(k).status === "working")
    );

/** Approvals waiting in a project that is NOT on screen.
 *
 *  The CLI is blocked on each of them, and the prompt only renders for the
 *  project you are looking at — so without this, switching away from a session
 *  mid-approval would leave it stalled with nothing anywhere saying so. */
export const backgroundApprovals = (): { id: string; count: number }[] => {
  const showing = activeSessionKey();
  return workspace.projects
    .map((p) => ({
      id: p.id,
      // Every conversation the project has, except the one on screen — a
      // second chat in the *same* project can be blocked just as invisibly as
      // one in another project.
      count: sessionsOf(p.id)
        .filter((k) => k !== showing)
        .reduce(
          (n, k) =>
            n +
            sessionOf(k).permissions.filter((r) => r.status === "pending")
              .length,
          0,
        ),
    }))
    .filter((x) => x.count > 0);
};

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
/**
 * How fast the last turn produced text, in output tokens per second — or
 * `null` when there is nothing honest to divide.
 *
 * Over the whole turn, deliberately, including the time the model spent
 * running tools and waiting on the API. That is the number a person is
 * actually feeling. A "pure decode speed" would be larger, truer to the
 * hardware, and a worse answer to "why is this slow".
 */
export const lastSpeed = (): number | null =>
  perSecond(view().lastTurnOutput, view().lastTurnMs);

export const contextUsed = (): number => contextUsedOf(view().usage);

export const contextWindow = (): number =>
  view().usage.contextWindow || 200_000;
