/**
 * The protocol reducer layer: pure functions from one decoded CLI event to
 * mutations on a single {@link ProjectSession} draft. Nothing here knows about
 * the cell, which project is on screen, or any IO — `session.ts` owns that and
 * dispatches into this module. Kept separate so the reducers can be imported
 * and tested on a bare ProjectSession without booting a cell.
 */
import { log } from "aio";
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
  arr,
  blocksOf,
  contextUsed as contextUsedOf,
  contextWindowOf,
  type Evt,
  fallbackWindow,
  isAgentTool,
  isSynthetic,
  num,
  obj,
  permissionOf,
  str,
  toolDetail,
  toolTitle,
  usageOf,
} from "../lib/stream.ts";
import { oneLine } from "../lib/format.ts";

/** Ring-buffer caps. A control surface shows the recent past; unbounded growth
 *  would turn every broadcast into a full-state resend. */
export const MAX_MESSAGES = 400;
const MAX_TOOLS = 300;
const MAX_ACTIVITY = 400;
const MAX_OUTPUT = 4_000;
const MAX_PERMISSIONS = 60;

export const EMPTY_META: SessionMeta = {
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

export const EMPTY_USAGE: Usage = {
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
export type ProjectSession = {
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
  /**
   * What the last "clear the transcript" took away, kept once so the decision
   * can be taken back.
   *
   * Cleared as soon as anything new arrives: the undo is for the moment right
   * after pressing the button, not for merging a week-old transcript into a
   * live one.
   */
  cleared: Message[];
  turnStartedAt: number | null;
  lastTurnMs: number;
  /** Output tokens the last completed turn produced. Paired with
   *  `lastTurnMs`, this is the only honest way to say how fast the model is
   *  going: a rate computed from a turn still in flight is a rate over a
   *  denominator that keeps growing. */
  lastTurnOutput: number;
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

/** A conversation that has not started. */
export const blank = (): ProjectSession => ({
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
  cleared: [],
  turnStartedAt: null,
  lastTurnMs: 0,
  lastTurnOutput: 0,
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

/* ── event handlers ───────────────────────────────────────────────────────── */

/** A control request from the CLI. Today that is only `can_use_tool`, and the
 *  CLI is *blocked* until the user answers it. */
export function controlRequest(s: ProjectSession, evt: Evt) {
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
export function clearPermissionFlag(s: ProjectSession, id: string) {
  const run = s.tools.find((t) => t.permissionId === id);
  if (run) run.permissionId = null;
}

/** The answer could not be delivered — the process died mid-prompt. Say so:
 *  a prompt that silently stays pending is the hang this app exists to end. */
export function failPermission(s: ProjectSession, id: string, e: unknown) {
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

export function system(s: ProjectSession, evt: Evt) {
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

export function assistant(s: ProjectSession, evt: Evt) {
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
  //
  // A synthetic message is skipped for the same reason one more time over: the
  // CLI writes it itself, stamps `<synthetic>` where the model goes and zeroes
  // where the tokens go. Reading it left the strip reporting `<synthetic>` as
  // the session's model — nothing the user picked could change that label
  // afterwards — and dropped a used context back to 0 on a limit notice.
  if (parent === null && !isSynthetic(message)) {
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
    // A new message ends the window in which the last clear can be undone —
    // and lets go of the transcript it was holding.
    s.cleared = [];
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
export function closeOpenWork(s: ProjectSession, why: string) {
  const now = Date.now();
  const cut = cutOff(s, () => now);
  if (cut > 0) {
    note(s, "session", `${cut} call${cut > 1 ? "s" : ""} cut off`, why);
  }
}

/**
 * End every open call and running task, and say how many calls that was.
 *
 * `endOf` picks the end time from when the thing started — "now" for a process
 * that just died, the start itself for one that died while the app was closed
 * (nobody knows when). No outcome is invented either way: `ok` stays null and
 * a task is "stopped", never "completed".
 */
function cutOff(s: ProjectSession, endOf: (startedAt: number) => number) {
  let cut = 0;
  for (const run of s.tools) {
    if (run.endedAt !== null) continue;
    run.endedAt = endOf(run.startedAt);
    run.permissionId = null;
    cut++;
  }
  for (const task of s.tasks) {
    if (task.status !== "running") continue;
    task.status = "stopped";
    task.endedAt ??= endOf(task.startedAt);
  }
  return cut;
}

export function userEvent(s: ProjectSession, evt: Evt) {
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

export function result(s: ProjectSession, evt: Evt) {
  s.status = "ready";
  s.turns += 1;
  s.turnStartedAt = null;
  s.streaming = null;
  s.lastTurnMs = num(evt.duration_ms);
  // `total_cost_usd` is the session total to date, not this result's slice —
  // and one user turn produces several results (each sub-agent finishing wakes
  // the model again). Summing them reported a $0.06 session as $0.79. Take the
  // highest figure the CLI has reported: monotonic, and never behind.
  const before = s.cost;
  s.cost = Math.max(s.cost, num(evt.total_cost_usd));

  // Attach what this turn took to the message it ended. A transcript is read
  // backwards, and "that answer took four minutes" is only useful next to the
  // answer it is about — a single "last turn" figure is useless the moment
  // anything else happens.
  const last = s.messages[s.messages.length - 1];
  if (last && last.role === "assistant") {
    last.turn = {
      ms: num(evt.duration_ms),
      tokens: usageOf(evt.usage, 0).output,
      // The difference between two session totals is the only per-turn cost
      // the CLI offers. Clamped at zero: the total is monotonic, so a negative
      // difference would be a report about a total that went backwards.
      usd: Math.max(0, s.cost - before),
    };
  }
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
  // The turn's own output, before the line below may discard `measured`
  // wholesale: an aborted turn reports nothing, and nothing is not a speed.
  if (measured.output > 0) s.lastTurnOutput = measured.output;
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

export function rateLimit(s: ProjectSession, evt: Evt) {
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

/**
 * Forget the process, keep the conversation.
 *
 * What a resumed start (and a send that has to start one first) needs: the
 * transcript is the user's record of the work and the CLI is handed the same
 * session back, so only the claims about the old process go.
 */
export function resetProcess(s: ProjectSession) {
  s.pid = null;
  s.sessionId = null;
  s.streaming = null;
  s.turnStartedAt = null;
  s.interrupting = false;
  s.queuedTurns = 0;
  s.thinkingTokens = 0;
  s.error = null;
  // startToken is deliberately NOT reset — it is the identity of the current
  // start, and resetting it would let a superseded callback match again.
}

/** Forget the process AND the conversation — a start with a blank context. */
export function reset(s: ProjectSession) {
  resetProcess(s);
  s.messages = [];
  s.tools = [];
  s.tasks = [];
  s.permissions = [];
  s.activity = [];
  s.usage = { ...EMPTY_USAGE };
  s.meta = { ...EMPTY_META };
  s.cost = 0;
  s.turns = 0;
  s.lastTurnMs = 0;
  s.lastTurnOutput = 0;
  s.turnEnd = null;
  s.agentStats = null;
  s.rateLimit = null;
}

export function upsertTask(s: ProjectSession, task: BackgroundTask) {
  const existing = s.tasks.find((t) => t.id === task.id);
  if (existing) Object.assign(existing, task);
  else s.tasks.push(task);
  cap(s.tasks, MAX_TOOLS);
}

export function note(
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
export function cap<T>(list: T[], max: number) {
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
export function cancelPending(s: ProjectSession, why: string) {
  for (const p of s.permissions) {
    if (p.status !== "pending") continue;
    p.status = "cancelled";
    p.decidedAt = Date.now();
    clearPermissionFlag(s, p.id);
    note(s, "permission", `Approval cancelled · ${p.tool}`, why);
  }
}

/** `0` is a real answer for a count, so absence has to stay distinguishable. */
const numOrNull = (v: unknown): number | null =>
  typeof v === "number" ? v : null;
const strings = (v: unknown): string[] =>
  arr(v).filter((x): x is string => typeof x === "string");

/**
 * Make a restored conversation honest about the fact that it is not running.
 *
 * The transcript survives a restart; the process does not. Everything below is
 * a claim about a program that no longer exists — a pid, a turn in flight, an
 * approval prompt waiting for an answer nobody can give — and restoring any of
 * it would be the app lying about its own state: a spinner for a turn that
 * ended when the app closed, an Allow button wired to a dead process.
 *
 * One function, applied to the record on screen and to every parked one, so
 * "what does not survive a restart" is defined once.
 */
export function offlineAgain(p: ProjectSession): void {
  p.status = "offline";
  p.pid = null;
  p.startedAt = null;
  // A half-written sentence from a process that has stopped writing.
  p.streaming = null;
  // Nobody can answer these now, and a prompt that cannot be answered blocks
  // the composer forever.
  p.permissions = [];
  p.interrupting = false;
  p.turnStartedAt = null;
  p.queuedTurns = 0;
  p.thinkingTokens = 0;
  // A tool call or task cannot still be running, whatever it said last. Given
  // an end so it stops spinning, but NOT given an outcome: `ok` stays null,
  // which is "nobody knows how that finished" — because nobody does.
  cutOff(p, (startedAt) => startedAt);
  // The prompts went above, so no call may still point at one — a dangling id
  // renders as "waiting for you" on a call nobody can answer.
  for (const t of p.tools) t.permissionId = null;
  // The undo for a clear is for the moment right after pressing the button.
  // Across a restart it is a week-old transcript waiting to be merged into a
  // live one, which is not what the button promised.
  p.cleared = [];
  p.error = null;
}

/* ── what goes to disk ────────────────────────────────────────────────────── */

/**
 * A tool call's arguments, with every string cut to the size a result is cut
 * to — for the stored copy only.
 *
 * A `Write` carries the whole file it writes, and the store is written on every
 * debounce window of a streaming turn: uncapped, one large write sat in the
 * snapshot twice (the message block and the run) for the life of the session.
 * On screen the input stays whole. Returns the same object when nothing needed
 * cutting, so an unchanged call costs no allocation.
 */
export function capInput<T>(v: T, max = MAX_OUTPUT): T {
  if (typeof v === "string") {
    return (v.length > max ? `${v.slice(0, max)}…` : v) as T;
  }
  if (Array.isArray(v)) {
    const out = v.map((x) => capInput(x, max));
    return (out.some((x, i) => x !== v[i]) ? out : v) as T;
  }
  if (v && typeof v === "object") {
    const src = v as Record<string, unknown>;
    let out: Record<string, unknown> | null = null;
    for (const [k, x] of Object.entries(src)) {
      const c = capInput(x, max);
      if (c !== x) (out ??= { ...src })[k] = c;
    }
    return (out ?? v) as T;
  }
  return v;
}

/** A tool block with its input capped; every other block as it is. */
const blockForDisk = (b: Block): Block =>
  b.kind === "tool" ? withInput(b, capInput(b.input)) : b;

/** `x` with `input` replaced — or `x` itself when the input did not change. */
const withInput = <X extends { input: Record<string, unknown> }>(
  x: X,
  input: Record<string, unknown>,
): X => input === x.input ? x : { ...x, input };

/** Map a list, returning the SAME list when no element changed. */
const mapSame = <X>(xs: X[], f: (x: X) => X): X[] => {
  const out = xs.map(f);
  return out.some((x, i) => x !== xs[i]) ? out : xs;
};

/**
 * One conversation as it is written to disk: the half-written sentence dropped
 * (nothing can finish it after a restart — {@link offlineAgain} would clear it
 * anyway) and tool inputs capped. Pure: the committed state is frozen, so this
 * builds a copy wherever it changes anything and shares the rest.
 */
export function forDisk<P extends ProjectSession>(p: P): P {
  return {
    ...p,
    streaming: null,
    tools: mapSame(p.tools, (t) => withInput(t, capInput(t.input))),
    messages: mapSame(
      p.messages,
      (m) => {
        const blocks = mapSame(m.blocks, blockForDisk);
        return blocks === m.blocks ? m : { ...m, blocks };
      },
    ),
  };
}
