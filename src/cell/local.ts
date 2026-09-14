/**
 * @module
 * The local-engine cell: per-project engine choice, and the agent loop for
 * LM Studio, Ollama and llama.cpp server.
 *
 * Isolation is the first design rule here. This cell touches nothing
 * Claude-specific: it reads `workspace` only for project identity (id, path),
 * keeps its own config and transcript keyed by project id, and every
 * Claude-facing module keys off `engineOf(id) === "claude"` — so a project on
 * a local engine simply routes around the CLI integration, and switching back
 * finds it exactly as it was.
 *
 * The loop itself is the standard tool-call cycle (ask → act → feed results
 * back → repeat), built to be context-frugal: packing, budgeting and
 * summarization live as pure functions in `lib/agent.ts`, and every request
 * is packed against the model's *own* window, so the same loop works at 64k
 * as at 1M.
 */
import { cell, log, type MethodDraftMeta, schedule } from "aio";
import {
  allowedTools,
  calibrate,
  clip,
  commandAdvice,
  destructiveReason,
  explainError,
  failureMark,
  foldChunk,
  foldedText,
  isNoToolSupport,
  isOverflow,
  isRunaway,
  isStopIntent,
  isTestPath,
  isUnreachable,
  LOCAL_PERMISSIONS,
  loopVerdict,
  maxOutput,
  mayLeaveUnasked,
  newAcc,
  overflowFacts,
  packContext,
  parallelSafe,
  parseTodos,
  permissionOf,
  programsToAllow,
  REPEATABLE,
  runsTests,
  type SeenCall,
  splitThink,
  storeBudget,
  storeStubs,
  summarizePrompt,
  systemPrompt,
  tierOf,
  todoNote,
  TOOL_NAMES,
  toolSpecs,
  wantsToContinue,
  withCallIds,
} from "../lib/agent.ts";
import {
  looksLikeCall,
  normalizeCall,
  recoverToolCalls,
} from "../lib/toolcall.ts";
import type {
  Engine,
  EngineProbe,
  LocalChat,
  LocalConfig,
  LocalEngine,
  LocalMode,
  LocalMsg,
  LocalPermission,
  LocalToolCall,
} from "../type/local.ts";
import {
  activeSessionKey,
  panesOf,
  projectOfPane,
  workspace,
} from "./workspace.ts";
import { perSecond } from "../lib/format.ts";
import type { HistRow, Recall } from "../lib/history.ts";

/** Tool-call rounds one user turn may take. A local model that has not
 *  converged after this many acts is looping, not working.
 *
 *  Exported so its tests can be written against the limit rather than against
 *  a number copied out of it — the two drifted apart once already, and a test
 *  that hard-codes a cap fails for the one reason that is not a bug. */
export const MAX_ROUNDS = 1024;
/** The same call, this many times in one turn, is a loop — even with other
 *  calls in between (`read a` → `ls` → `read a` → `ls` …), which is how a
 *  small model loops most often. */
export const MAX_SAME_CALL = 4;

/** Loop verdicts in one turn before it ends: the second and third pause the
 *  tools for a round, the fourth takes them away. */
export const MAX_VERDICTS = 4;
/** Calls from one reply that are actually run. A model that asks for hundreds
 *  in one breath is guessing, and running them all costs minutes and floods
 *  the window; the rest are named back to it instead. */
export const MAX_CALLS_PER_REPLY = 12;
/** Stretches of work in one turn. Each needs a message the user typed while
 *  the last one ran, so this is high — it only has to be finite. */
export const MAX_PASSES = 8;
/** Transcript cap, same stance as the Claude session: a control surface shows
 *  the recent past. Exported for the same reason as above. */
export const MAX_LOCAL_MESSAGES = 400;

/** Where each engine serves by default. */
export const DEFAULT_URLS: Record<LocalEngine, string> = {
  lmstudio: "http://localhost:1234",
  ollama: "http://localhost:11434",
  llamacpp: "http://localhost:8080",
};

const DEFAULT_CTX = 32_768;

const blankConfig = (): LocalConfig => ({
  engine: "claude",
  baseUrl: "",
  model: "",
  mode: "chat",
  ctx: DEFAULT_CTX,
});

const blankChat = (): LocalChat => ({
  messages: [],
  status: "idle",
  streaming: "",
  thinking: "",
  summary: "",
  usedTokens: 0,
  startedAt: 0,
  lastMs: 0,
  lastTokens: 0,
  models: [],
  error: null,
  pending: null,
  toolsOk: null,
  todos: [],
});

type LocalState = {
  /** Per-project engine configuration. The persisted part. */
  configs: Record<string, LocalConfig>;
  /** Per-project conversation. Live state of a running process, not a
   *  document — so not persisted, same stance as the Claude session cell. */
  chats: Record<string, LocalChat>;
  /**
   * Per project: what the last Clear took away, kept once.
   *
   * Not persisted — the same stance as the conversations themselves. An undo
   * offer that survives a restart is an offer nobody asked for about a
   * decision they made last week.
   */
  cleared: Record<string, LocalMsg[]>;
  /**
   * What answered on each engine's default port, last time anyone looked.
   *
   * A fact about the machine right now, not about a project — one scan serves
   * every project — and worthless after a restart, so it is not persisted.
   */
  detected: EngineProbe[];
  /** A scan is in flight. The UI says "looking…" rather than "none found",
   *  which is the same words for two very different situations. */
  detecting: boolean;
  /** When the last scan finished, so the panel can say how fresh it is. */
  detectedAt: number;
  /** Whether "Don't ask" commands get a bubblewrap sandbox on this machine —
   *  `null` until asked. A fact about the machine, not persisted. */
  sandbox: boolean | null;
  /** The account each conversation's commands run as (see
   *  `projectAccount`), by pane id — `null` for none. Not persisted: a fact
   *  about the machine and where the project is, asked again after a restart. */
  accounts: Record<string, string | null>;
};

/**
 * Every id below is a *pane* id — one conversation, with settings of its own.
 *
 * Both halves are scoped to the conversation, not the project. A chat is
 * obviously its own: three chats in a folder are three transcripts. The
 * settings are less obviously so, and it matters more — one chat on a big
 * local model for reasoning and another on a small fast one for edits, in the
 * same folder at the same time, is a normal way to work and was impossible
 * while a project had a single engine.
 *
 * What a new conversation starts with is the question that answers the
 * objection. It inherits — see {@link inherited} — so choosing an engine once
 * still holds for every chat you open afterwards, and changing one chat's
 * engine no longer changes every other chat's.
 *
 * `projectOfPane` is still used for the things that really are the project's:
 * the directory a turn runs in, and which projects' settings to forget.
 */
const projectOf = (id: string): string => projectOfPane(id) || id;

/**
 * The settings a brand-new conversation opens with.
 *
 * The project's other chats, newest first, then the record under the project's
 * own id — which is where every config lived before conversations had their
 * own, and which is still the first chat's key. So an upgrade keeps its
 * engine, and a second chat opened afterwards inherits it rather than arriving
 * blank and asking to be configured again.
 */
function inherited(s: LocalState, id: string): LocalConfig {
  const pid = projectOf(id);
  const siblings = panesOf(pid)
    .filter((p) => p.kind === "session" && p.id !== id)
    .map((p) => s.configs[p.id])
    .filter((c): c is LocalConfig => c !== undefined);
  const from = siblings[siblings.length - 1] ?? s.configs[pid];
  // A copy, not a reference: two conversations sharing one settings object is
  // the very thing this is here to end.
  if (from) return { ...from };
  // A project with no chats yet starts in "Ask" — unless the user's most
  // recent conversation anywhere ran in "Don't ask", which is then the choice
  // they keep making: a live session opened a new project, started in Ask,
  // and had its first command wait for a click. Only that mode travels: it is
  // the sandboxed one, and Bypass is chosen per project or not at all.
  const recent = Object.entries(s.chats)
    .map(([key, c]) => ({
      at: c.messages[c.messages.length - 1]?.at ?? 0,
      cfg: s.configs[key],
    }))
    .filter((r) => r.at > 0 && r.cfg !== undefined)
    .sort((a, b) => b.at - a.at)[0];
  const blank = blankConfig();
  return recent && permissionOf(recent.cfg) === "dontAsk"
    ? { ...blank, permission: "dontAsk" }
    : blank;
}

/**
 * Messages written while a turn works, per conversation — the turn's own
 * queue, kept here rather than in cell state.
 *
 * Two methods touch it at once by nature (the running `send` and the `send`
 * that queues), and a list both write through the live draft came back with
 * a `null` in it and the message lost. A synchronous module-local list has no
 * such race; the cell holds a copy (`LocalChat.queued`) only for the page.
 */
const QUEUED = new Map<string, { id: string; text: string; at: number }[]>();
const queuedOf = (id: string) => (QUEUED.get(id) ?? []).map((q) => ({ ...q }));

/**
 * Conversations whose turn was ended by the user, not by a word they typed —
 * the Stop button, Clear, a switch of model. Typed "stop" cuts the step and
 * the model answers it; the button means NOW, and nothing more is sent.
 * Module-local and synchronous for the same reason as `QUEUED`.
 */
const HALTED = new Set<string>();

/** The turn that owns each conversation right now. `status: "working"` with
 *  no owner is a stuck flag, and Stop clears it instead of waiting on
 *  nothing. A turn that lost ownership (Clear, then a new message, while it
 *  was still winding down) must not write its ending over its successor. */
const ACTIVE = new Map<string, symbol>();

/** When each conversation was last opened — a parked chat brought back to be
 *  read is not idle, however old its last message. */
const TOUCHED = new Map<string, number>();

/** Unparks in flight, so a page render and a send asking at once read the
 *  file once. */
const UNPARKING = new Map<string, Promise<boolean>>();

/** Idle this long, and not on screen: the conversation goes to disk. */
export const PARK_AFTER_MS = 10 * 60_000;

/** What the gathered project facts contain. Bumped when a fact is added (2:
 *  the docs folders), so a chat that gathered them before is refreshed on
 *  its next turn instead of up to six hours later. */
const ENV_VERSION = 2;

const cfgAt = (s: LocalState, id: string): LocalConfig =>
  s.configs[id] ??= inherited(s, id);
const chatAt = (s: LocalState, id: string): LocalChat =>
  s.chats[id] ??= blankChat();

const msg = (
  role: LocalMsg["role"],
  text: string,
  extra: Partial<LocalMsg> = {},
): LocalMsg => ({
  id: crypto.randomUUID(),
  role,
  text,
  at: Date.now(),
  ...extra,
});

/** One act, as a key: the same tool with the same arguments is the same act,
 *  whatever else happened in between. */
const callKey = (c: { name: string; args: string }): string =>
  `${c.name}\n${c.args}`;

/** Looks inside a dependency, after the work has started and with no change
 *  since, that earn "stop digging and decide". */
export const DIG_LIMIT = 8;

/** Changed files, with no command run since, that earn "check now". */
export const CHECK_AFTER_FILES = 3;

/** Rounds with tools after every task-list item is done that earn "report to
 *  the user now". */
export const DONE_ROUNDS = 6;

/** Failures in a row of one command, with changes between, that earn "step
 *  back". */
export const STUCK_AFTER_FAILS = 4;

/** Rounds, or minutes, of test work with no passing run that earn "tests
 *  serve the task" — and twice that, "stop". Whichever comes first: a fast
 *  model spends rounds, a slow one minutes. */
export const TEST_STRETCH_ROUNDS = 10;
export const TEST_STRETCH_MS = 5 * 60_000;

/** The tools that change a file through the harness — the ones whose success
 *  means a check run again is a new question. */
const MUTATES: ReadonlySet<string> = new Set(["write", "edit"]);

/** A span of work, said the way a person would say it. */
const spanWords = (ms: number): string =>
  ms >= 60_000
    ? `${Math.round(ms / 60_000)} minutes of work`
    : `${Math.max(1, Math.round(ms / 1000))} seconds of work`;

export const local = cell("local", {
  /**
   * The conversations are kept too, for the same reason the Claude ones are:
   * losing a chat to a restart loses the only copy of it on this machine.
   *
   * `cleared` is deliberately NOT here. It is the undo for the moment right
   * after pressing Clear; across a restart it is a week-old transcript waiting
   * to be merged into a live one, which is not what the button offered.
   */
  persist: { include: ["configs", "chats"] },

  /** Nothing here was mid-turn since the app closed, whatever it last wrote. */
  onRestore(s: LocalState) {
    for (const key of Object.keys(s.chats)) {
      const chat = s.chats[key];
      chat.status = "idle";
      // Half a sentence from a model that stopped generating.
      chat.streaming = "";
      chat.thinking = "";
      // Chats saved before the task list existed have none — and the page
      // reads its length.
      if (!Array.isArray(chat.todos)) chat.todos = [];
      // The originals behind "undo" lived in the process that just ended —
      // and so did its background jobs and any message waiting for a turn.
      chat.changed = 0;
      chat.jobs = 0;
      chat.queued = [];
      // Keep only what the model can still use — see `fold` — and the whole
      // of what that shortens in the saved record.
      saveRows(key, fold(chat, s.configs[key]?.ctx ?? DEFAULT_CTX), chat);
      // An environment saved with an empty field in it would block every
      // save after it; it is gathered again on the next turn anyway.
      if (chat.env) chat.env = JSON.parse(JSON.stringify(chat.env));
      // Nobody can answer this now, and an unanswered command blocks the turn
      // — and with it the composer — forever.
      chat.pending = null;
      chat.startedAt = 0;
      chat.error = null;
      // A fact about a running server, not about this conversation. The fix
      // for it is to restart that server, so re-asking is the honest default.
      chat.toolsOk = null;
    }
  },

  // The loop streams: every await inside `send` is followed by writes the
  // window must see as they happen, not at commit.
  transaction: false,

  // A turn is long by nature: a local model loads, reads a big prompt and
  // works through dozens of tool rounds — minutes, routinely. Without this
  // the framework stopped waiting at 30 s and the caller's `send` rejected
  // mid-turn, while the turn itself carried on (dep/aio/docs/state/
  // methods.md, "How long may an async method run?"). Stop still stops it.
  long: ["send"],

  /** Nothing this cell started may outlive it: the turn in flight, and the
   *  port scan. A scan has nobody to answer to once the app is going down, and
   *  its requests would hold the process open to say so. */
  onDestroy() {
    void import("./local.server.ts").then((io) => {
      io.cancelScan();
      // A server the agent left running must not outlive the app.
      io.stopAllJobs();
    }).catch(() => {});
  },

  state: {
    configs: {} as Record<string, LocalConfig>,
    chats: {} as Record<string, LocalChat>,
    cleared: {} as Record<string, LocalMsg[]>,
    detected: [] as EngineProbe[],
    detecting: false,
    detectedAt: 0,
    sandbox: null as boolean | null,
    accounts: {} as Record<string, string | null>,
  },

  methods: {
    /** Pick what runs this project. Choosing a local engine fills in its
     *  default URL (unless one was already set by hand); choosing Claude
     *  changes nothing else — the local config stays for the switch back. */
    setEngine(
      s: LocalState & Partial<MethodDraftMeta>,
      key: string,
      engine: Engine,
    ) {
      if (!["claude", "lmstudio", "ollama", "llamacpp"].includes(engine)) {
        return;
      }
      const cfg = cfgAt(s, key);
      const wasDefault = !cfg.baseUrl ||
        Object.values(DEFAULT_URLS).includes(cfg.baseUrl);
      cfg.engine = engine;
      if (engine !== "claude" && wasDefault) {
        // Prefer the address the scan actually got an answer from. It is the
        // documented default in every normal case, and the difference matters
        // exactly when it is not — a server moved to another port answers the
        // scan, so picking that engine lands on a working address rather than
        // on a hint the user then has to correct by hand.
        const found = s.detected.find((d) =>
          d.engine === engine && d.reachable
        );
        cfg.baseUrl = found?.baseUrl ?? DEFAULT_URLS[engine as LocalEngine];
      }
      // A model the scan already saw beats an empty picker: choosing an engine
      // should leave the project ready to talk, not ready to be configured.
      if (engine !== "claude") {
        const found = s.detected.find((d) => d.engine === engine);
        if (found?.models.length) {
          chatAt(s, key).models = found.models;
          if (!found.models.includes(cfg.model)) cfg.model = found.models[0];
        }
        // The scan already asked whether that server can use tools; carrying
        // the answer over means the warning is on screen the moment the
        // engine is picked, not one round trip later.
        chatAt(s, key).toolsOk = found?.reachable ? found.tools ?? null : null;
      }
      // Whoever was answering is not the one being asked any more.
      s.$do?.(schedule.next(`local-switch:${key}`, local.switched.action(key)));
      log.info("local", "engine set", { project: projectOf(key), engine });
      // …and then go and look, rather than trusting a scan that may be stale
      // or may never have run. Picking an engine is exactly the moment the
      // question "where is it?" has an answer worth having, and the finder
      // only adopts what it can prove answered.
      if (engine !== "claude") {
        s.$do?.(schedule.next(
          `local-find:${key}`,
          local.findServer.action(key),
        ));
      }
    },

    /**
     * Look for this project's engine and adopt whatever answered.
     *
     * The scan knocks on the engine's default port, the addresses it is
     * commonly moved to, and every address this workspace already points at.
     * What it must never do is move an address somebody typed — see
     * `urlManual`. A dead hand-set address gets an offer in the chat banner
     * instead, which is a click rather than a surprise.
     */
    async findServer(s: LocalState, key: string) {
      // Before the await: which engine this project is on is the question the
      // scan is being run to answer, and it must not change under it.
      const engine = cfgAt(s, key).engine;
      if (engine === "claude") return;
      await local.detect(true); // aiol-ok: orchestration
      await local.adoptFound(key); // aiol-ok: orchestration
    },

    /** The sync half of {@link findServer}: point the project at the address
     *  the scan got an answer from, and carry over what it learned there. */
    adoptFound(s: LocalState, key: string) {
      const cfg = cfgAt(s, key);
      if (cfg.engine === "claude" || cfg.urlManual) return;
      const found = s.detected.find((d) =>
        d.engine === cfg.engine && d.reachable
      );
      if (!found) return;
      if (cfg.baseUrl !== found.baseUrl) {
        cfg.baseUrl = found.baseUrl;
        log.info("local", "adopted the address that answered", {
          key,
          baseUrl: found.baseUrl,
        });
      }
      const chat = chatAt(s, key);
      chat.models = found.models;
      chat.toolsOk = found.tools ?? null;
      if (found.models.length && !found.models.includes(cfg.model)) {
        cfg.model = found.models[0];
      }
      chat.error = null;
    },

    setBaseUrl(
      s: LocalState & Partial<MethodDraftMeta>,
      key: string,
      url: string,
    ) {
      if (url && !/^https?:\/\//.test(url)) {
        // Refusing silently would look like a saved value that "does not
        // work" — say why nothing changed.
        chatAt(s, key).error =
          `Not a server address: "${url}" — it needs to start with http(s)://`;
        return;
      }
      cfgAt(s, key).baseUrl = url.replace(/\/+$/, "");
      // Typed by a human — the finder stops moving it from here on. Clearing
      // the field hands it back: an empty address is not a choice.
      cfgAt(s, key).urlManual = url.trim() !== "";
      chatAt(s, key).error = null;
      // Pointing at a different server is the same act as picking a different
      // engine: the reply coming from the old address is not the one wanted.
      s.$do?.(schedule.next(`local-switch:${key}`, local.switched.action(key)));
    },

    /**
     * Pick the model. Synchronous, and it stays synchronous: a caller that
     * sets a model and immediately sends a turn must find the model already
     * there, so the window probe that follows is *scheduled*, not awaited.
     * (Making this async once was enough to make `setModel(); send()` race and
     * answer "pick a model first".)
     */
    setModel(
      s: LocalState & Partial<MethodDraftMeta>,
      key: string,
      model: string,
    ) {
      const changed = cfgAt(s, key).model !== model;
      cfgAt(s, key).model = model;
      if (changed) {
        // Facts about the old model: whether it takes tools natively, and how
        // its tokenizer counts. Both are asked again, not inherited.
        const chat = chatAt(s, key);
        chat.toolsOk = null;
        delete chat.tokRatio;
        s.$do?.(
          schedule.next(`local-tools:${key}`, local.autoTools.action(key)),
        );
      }
      // A reply already coming from the previous model is not the one that was
      // asked for. Dispatched rather than awaited, because this method must
      // stay synchronous — see above.
      s.$do?.(schedule.next(`local-switch:${key}`, local.switched.action(key)));
      // Each model in a server can be loaded at a different window, so the
      // number to budget against is a property of the *pair*. Re-read on the
      // next tick, keyed by project so two of them cannot cancel each other.
      s.$do?.(schedule.next(
        `local-ctx:${key}`,
        // `true` = leave a hand-typed window alone. Switching model must
        // re-read the server, never quietly discard an override.
        local.autoCtx.action(key, true),
      ));
    },

    setMode(s: LocalState, key: string, mode: LocalMode) {
      if (!["chat", "read", "agent"].includes(mode)) return;
      cfgAt(s, key).mode = mode;
    },

    /** The window to budget against. Clamped to sane bounds rather than
     *  rejected: the difference between 64k and 65_536 is not worth an
     *  error state. */
    setCtx(s: LocalState, key: string, ctx: number) {
      if (!Number.isFinite(ctx)) return;
      const cfg = cfgAt(s, key);
      cfg.ctx = Math.min(2_000_000, Math.max(4_096, Math.floor(ctx)));
      // Typed by a human — detection stops overwriting it from here on.
      cfg.ctxManual = true;
    },

    /**
     * Re-read the model list from the server.
     *
     * Orchestrator only — see {@link detect} for why nothing here holds a
     * draft across the await.
     */
    async refreshModels(_s: LocalState, key: string) {
      const cfg = local.configs[key];
      if (!cfg || cfg.engine === "claude" || !cfg.baseUrl) return;
      const baseUrl = cfg.baseUrl;
      try {
        const io = await import("./local.server.ts");
        const models = await io.listModels(baseUrl);
        await local.applyModels(key, models); // aiol-ok: orchestration
      } catch (e) {
        const why = `Cannot reach ${baseUrl}: ${
          e instanceof Error ? e.message : String(e)
        }`;
        await local.modelsFailed(key, why); // aiol-ok: orchestration
        log.warn("local", "model listing failed", { key, error: why });
      }
    },

    /** The sync halves of {@link refreshModels}. */
    applyModels(s: LocalState, key: string, models: string[]) {
      const c = chatAt(s, key);
      c.models = models;
      c.error = null;
      // A picked model that is gone is worth replacing with a real one.
      const p = cfgAt(s, key);
      if (!models.includes(p.model)) p.model = models[0] ?? "";
    },

    modelsFailed(s: LocalState, key: string, why: string) {
      chatAt(s, key).error = why;
    },

    /**
     * Everything a project needs from its server, in order: the model list,
     * then the window the chosen model is actually loaded at.
     *
     * Two dispatches rather than one method with two awaits — see the note in
     * `refreshModels`. Each is a short transaction that sees the previous
     * one's committed result, which is what an orchestrator wants and what a
     * single long method cannot give.
     */
    async syncEngine(_s: LocalState, key: string) {
      await local.refreshModels(key); // aiol-ok: orchestration, see above
      await local.autoCtx(key, true); // aiol-ok: orchestration
      await local.autoTools(key); // aiol-ok: orchestration
    },

    /**
     * Ask the server whether it will accept tool calls at all.
     *
     * The missing half of "detects everything without manual settings": a
     * llama.cpp with Jinja templating off serves models, answers chats, and
     * refuses every tool request — so Read-only and Agent modes fail with a
     * raw HTTP 500 and the app looks broken. Asked once per engine/address,
     * up front, so the UI can name the launch flag instead.
     *
     * Orchestrator only, like {@link detect} — see the note there.
     */
    async autoTools(
      s: LocalState & Partial<MethodDraftMeta>,
      key: string,
    ) {
      const cfg = local.configs[key];
      if (!cfg || cfg.engine === "claude" || !cfg.baseUrl) return;
      const engine = cfg.engine as LocalEngine;
      const { baseUrl, model } = cfg;
      try {
        const io = await import("./local.server.ts");
        // The method's own abort, threaded to the socket: a probe must not
        // outlive the app, or the harness waiting for it to go quiet.
        const ok = await io.probeTools(engine, baseUrl, s.$signal, model);
        await local.applyTools(key, engine, baseUrl, ok); // aiol-ok
      } catch { /* best effort: a failed turn still says the same thing */ }
    },

    /** Store the answer — if the project is still asking the same question.
     *  Engine and address can both change while a probe is in flight, and an
     *  answer about one server says nothing about another. */
    applyTools(
      s: LocalState,
      key: string,
      engine: string,
      baseUrl: string,
      ok: boolean | null,
    ) {
      const cfg = s.configs[key];
      if (!cfg || cfg.engine !== engine || cfg.baseUrl !== baseUrl) return;
      chatAt(s, key).toolsOk = ok;
    },

    /**
     * Re-read the context window from the server. Also the undo for a typed
     * value: `keepManual: false` hands the field back to detection.
     *
     * Orchestrator only, like {@link detect} and {@link refreshModels}.
     */
    async autoCtx(_s: LocalState, key: string, keepManual = false) {
      // Taken from the method's RETURN value, not re-read from the cell. On a
      // browser client the patch from `clearManualCtx` may not have arrived
      // yet, and a re-read would see the old `ctxManual: true` and bail out of
      // the very detection this call exists to restart.
      const cfg = keepManual
        ? local.configs[key]
        : await local.clearManualCtx(key);
      if (!cfg || cfg.engine === "claude" || cfg.ctxManual || !cfg.baseUrl) {
        return;
      }
      const engine = cfg.engine as LocalEngine;
      const { baseUrl, model } = cfg;
      try {
        const io = await import("./local.server.ts");
        const ctx = await io.probeContext(engine, baseUrl, model);
        if (ctx === null) return;
        await local.applyCtx(key, engine, model, ctx); // aiol-ok
      } catch { /* best effort: the typed default still works */ }
    },

    /** Hand the context window back to detection, and answer with the config
     *  as it is AFTER that — see the caller. */
    clearManualCtx(s: LocalState, key: string): LocalConfig {
      const cfg = cfgAt(s, key);
      cfg.ctxManual = false;
      return { ...cfg };
    },

    /**
     * Store a detected window — if it is still the answer to the question that
     * was asked. Engine and model can both change while a probe is in flight,
     * and a window measured for one model is wrong for another.
     */
    applyCtx(
      s: LocalState,
      key: string,
      engine: string,
      model: string,
      ctx: number,
    ) {
      const cfg = s.configs[key];
      if (
        !cfg || cfg.engine !== engine || cfg.model !== model || cfg.ctxManual
      ) return;
      const clamped = Math.min(2_000_000, Math.max(4_096, ctx));
      if (cfg.ctx === clamped) return;
      cfg.ctx = clamped;
      log.info("local", "context window detected", { key, ctx: clamped });
    },

    /**
     * Let go of projects that are no longer in the list.
     *
     * `configs` is persisted, so without this every project ever removed left
     * its engine, address and model behind forever — and a running turn for
     * one of them would have kept going. Both are ended here.
     */
    async forgetProjects(_s: LocalState, ids: string[]) {
      const io = await import("./local.server.ts");
      // A project can hold several conversations, and each one runs under its
      // own pane id. Stopping the project id alone would leave the other
      // turns talking to a server for a project that is gone.
      const keys = ids.flatMap((id) => [id, ...panesOf(id).map((p) => p.id)]);
      for (const key of keys) {
        HALTED.add(key);
        io.stopRun(key);
        // A turn still winding down must not recreate the chat it belonged
        // to: from here on it writes to a throwaway (see `here` in `send`).
        ACTIVE.delete(key);
        io.forgetFiles(key);
      }
      await local.dropProjects(keys); // aiol-ok: orchestration, see `detect`
    },

    /**
     * A conversation's tab was closed.
     *
     * Everything held for it is let go — the turn in flight, its background
     * programs, its undo history, its temp directory, its settings and its
     * transcript in state. What was said goes to the saved history on the way
     * out, so `history` can still find it: closing a tab is not deleting the
     * past, and the tab is one click, with no confirmation behind it.
     */
    async closeChat(_s: LocalState, key: string) {
      HALTED.add(key);
      const io = await import("./local.server.ts");
      io.stopRun(key);
      // A turn still winding down writes to a throwaway from here on.
      ACTIVE.delete(key);
      io.forgetFiles(key);
      await local.dropProjects([key]); // aiol-ok: orchestration, see `detect`
    },

    /** Forget every conversation's settings and transcript under these keys. */
    dropProjects(s: LocalState, keys: string[]) {
      for (const key of keys) {
        retire(s, key);
        delete s.configs[key];
        delete s.chats[key];
      }
    },

    /**
     * Drop stored settings and transcripts that nothing can reach any more.
     *
     * The garbage collector for the persisted half. Removals go through
     * `forgetProjects`, but state written before that existed — or under a key
     * no project ever had — is only findable by comparing the two lists, which
     * is what this does, once, when the workspace is settled.
     *
     * The project list is read HERE, not passed in. A caller that snapshots the
     * ids and dispatches this deletes the settings of any project added
     * between the two — which is not hypothetical: boot adds the folder named
     * on the command line while its own sweep is queued behind it.
     */
    pruneUnknown(s: LocalState) {
      // An EMPTY project list means the workspace has not settled, not that
      // there are no projects — boot adds them one dispatch at a time, and a
      // sweep that lands in the gap would delete every stored engine, address
      // and model on the machine. Nothing to compare against is a reason to do
      // nothing, and the next boot with a real list collects the same garbage.
      if (workspace.projects.length === 0) return;

      // Reachable: a project's own id — which is also its first conversation's
      // key, and where every config lived before conversations had their own —
      // or the id of a pane that still exists.
      const reachable = new Set<string>(workspace.projects.map((p) => p.id));
      for (const list of Object.values(workspace.panes)) {
        for (const pane of list) reachable.add(pane.id);
      }
      // Only sweep a key that resolves to NOTHING. A key belonging to some
      // project we simply have not materialised panes for yet is not garbage,
      // and deleting it would take a conversation out from under whoever is
      // reading it — `panes` is filled in lazily, so absence proves nothing.
      const gone = (key: string) =>
        !reachable.has(key) && projectOfPane(key) === "";

      const staleConfigs = Object.keys(s.configs).filter(gone);
      const staleChats = Object.keys(s.chats).filter(gone);
      if (staleConfigs.length === 0 && staleChats.length === 0) return;
      for (const id of staleConfigs) delete s.configs[id];
      for (const id of staleChats) {
        retire(s, id);
        delete s.chats[id];
      }
      log.info("local", "dropped settings nothing could reach", {
        configs: staleConfigs.length,
        chats: staleChats.length,
      });
    },

    /**
     * Look for local servers on the three default ports.
     *
     * **This method never writes.** It orchestrates three short sync methods
     * around the scan instead, and that is the whole point: a draft held
     * across an await in a non-transactional cell republishes the state the
     * method ENTERED with. A scan started when Settings opens takes up to two
     * seconds, during which the user switches project, picks an engine, types
     * an address — and the late write put all of that back. It cost this
     * project three sessions of "a flaky test"; it is a real bug, and the
     * shape that avoids it is the one `workspace.bootstrap` already uses.
     *
     * `force` is the Scan button, which exists to ask again after starting a
     * server. Otherwise once is enough — and it is deliberately not run at
     * boot: an app that probes three ports the moment it starts is doing
     * something the user did not ask for.
     */
    async detect(
      s: LocalState & Partial<MethodDraftMeta>,
      force = false,
    ) {
      if (local.detecting || (!force && local.detectedAt > 0)) return;
      // Read before any await, not after: this is the list of addresses to
      // knock on, and gathering it first is what keeps the scan's question
      // fixed for the length of the scan.
      const configured = Object.values(s.configs)
        .filter((c) => c.engine !== "claude" && c.baseUrl)
        .map((c) => ({
          engine: c.engine as LocalEngine,
          baseUrl: c.baseUrl,
        }));
      await local.beginScan(); // aiol-ok: orchestration, see above
      try {
        const io = await import("./local.server.ts");
        // The method's own abort, threaded all the way to the sockets. Three
        // loopback probes are quick when a server answers and two seconds when
        // nothing does — long enough that a shutdown, or a harness waiting for
        // the app to go quiet, should not have to sit through it.
        // `configured` was gathered above: every address this workspace points
        // at, so a server on a port somebody chose is found as readily as one
        // on the default.
        const found = await io.detectEngines(s.$signal, configured);
        await local.endScan(found); // aiol-ok: orchestration
        log.info("local", "engine scan", {
          reachable: found.filter((f) => f.reachable).map((f) => f.engine),
        });
      } catch (e) {
        await local.endScan(null); // aiol-ok: orchestration
        log.warn("local", "engine scan failed", {
          error: e instanceof Error ? e.message : String(e),
        });
      }
    },

    /** Find out, once, whether commands can be sandboxed here. Orchestrator
     *  only — the answer is stored by a sync method, like every probe here. */
    async checkSandbox(_s: LocalState) {
      if (local.sandbox !== null) return;
      const io = await import("./local.server.ts");
      await local.setSandbox(await io.sandboxAvailable()); // aiol-ok: orchestration
    },

    setSandbox(s: LocalState, ok: boolean) {
      s.sandbox = ok;
    },

    /** Find out which account a conversation's commands run as. Orchestrator
     *  only — stored by {@link setAccount}. */
    async checkAccount(_s: LocalState, id: string) {
      const io = await import("./local.server.ts");
      const a = await io.projectAccount(cwdOf(id)).catch(() => null);
      await local.setAccount(id, a?.user ?? null); // aiol-ok: orchestration
    },

    setAccount(s: LocalState, id: string, user: string | null) {
      if (s.accounts[id] !== user) s.accounts[id] = user;
    },

    /** Sync halves of {@link detect}. Each is one short transaction with no
     *  await in it, so neither can publish a stale root. */
    beginScan(s: LocalState) {
      s.detecting = true;
    },

    endScan(s: LocalState, found: EngineProbe[] | null) {
      s.detecting = false;
      if (!found) return;
      s.detected = found;
      s.detectedAt = Date.now();
    },

    /**
     * One user turn: the whole agent loop, from packing to the final answer.
     *
     * Before the first request the turn learns what it is talking to: the
     * window the model is really loaded at (loading it first if it is not),
     * whether it takes tools natively, and the project it works in. Then the
     * standard cycle — pack, ask, act, feed results back — with the guards a
     * small model needs: calls repaired and recovered from text, loops named
     * and then cut off, a model that stops mid-intent nudged on, a stream that
     * degenerates into repetition stopped, an overflow answered by packing to
     * what the server said it has.
     *
     * Every write goes through `chatAt(s, id)` freshly — nested drafts do not
     * survive an await in a non-transactional method, only the root `s` stays
     * live, and a stale reference loses the write silently
     * (dep/aio/docs/state/methods.md; reported in dep/aio/feedback/cc.md).
     */
    async send(
      s: LocalState & Partial<MethodDraftMeta>,
      text: string,
      key?: string,
      /** False when the message was not taken — no model chosen, wrong engine,
       *  nothing but spaces. The composer puts it back rather than losing what
       *  somebody typed. */
    ): Promise<boolean> {
      const id = key ?? activeSessionKey();
      // Config is read once into plain values — it is not written below.
      const cfg = { ...cfgAt(s, id) };
      // The project's directory, not the pane's — `id` is one conversation,
      // and every conversation in a project works in the same folder.
      const owner = projectOf(id);
      const cwd = workspace.projects.find((p) => p.id === owner)?.path ?? "";
      if (cfg.engine === "claude" || !text.trim()) return false;
      // A parked conversation comes back before anything is added to it —
      // and the turn starts as a fresh call, so nothing here holds state
      // from before the messages returned.
      if (s.chats[id]?.parked) {
        // Unreadable or not, it is no longer parked afterwards — a failure
        // leaves a note in the chat, which this turn then carries on from.
        await local.unpark(id); // aiol-ok: orchestration
        return await local.send(text, id); // aiol-ok: orchestration
      }
      /** This turn's claim on the conversation — see `ACTIVE`. */
      const claim = Symbol(id);
      // Already working: this is steering, not a new turn. It waits in the
      // queue and is delivered into the running task at its next step — or,
      // when it says "stop", the task is cut short now and the message starts
      // the next turn (see the end of this method).
      if (chatAt(s, id).status === "working") {
        QUEUED.set(id, [...queuedOf(id), {
          id: crypto.randomUUID(),
          text,
          at: Date.now(),
        }]);
        await local.setQueued(id); // aiol-ok: orchestration
        if (isStopIntent(text)) {
          const io = await import("./local.server.ts");
          io.stopRun(id, ACTIVE.has(id));
        }
        return true;
      }
      if (!cfg.model) {
        chatAt(s, id).error =
          "Pick a model first (refresh the list if it is empty).";
        return false;
      }

      {
        const c = chatAt(s, id);
        HALTED.delete(id);
        ACTIVE.set(id, claim);
        c.status = "working";
        c.startedAt = Date.now();
        c.error = null;
        c.changed = 0;
        // Saying something new ends the window in which the last Clear can be
        // undone — and lets go of the transcript it was holding.
        delete s.cleared[id];
        // Anything a failed turn left in the queue is put in first, in the
        // order it was written — after the new message it would read as the
        // newest thing said, which it is not.
        for (const q of queuedOf(id)) {
          c.messages.push(msg("user", q.text, { steer: true }));
        }
        QUEUED.delete(id);
        c.queued = [];
        c.messages.push(msg("user", text));
        cap(id, c);
      }

      /** The chat this turn writes to — or a throwaway, once Clear has taken
       *  the conversation away from it. A turn winding down after Clear used
       *  to push its last tool results and "*(stopped)*" into the new, empty
       *  chat (which also made Undo refuse), and a compaction cut short wrote
       *  the cleared rows into the new chat's summary. */
      const orphan = blankChat();
      const here = (): LocalChat =>
        ACTIVE.get(id) === claim ? chatAt(s, id) : orphan;

      const io = await import("./local.server.ts");
      // `let`: a "stop" typed mid-task ends this run's signal, and the same
      // turn carries on under a fresh one to answer it (see the end).
      let signal = io.beginRun(id);
      io.beginUndo(id);
      const engine = cfg.engine as LocalEngine;
      const { baseUrl, model } = cfg;
      /** Live reads of what the user can change mid-turn. */
      const live = () => cfgAt(s, id);

      /** Everything one turn remembers across its rounds and retries. */
      const turn = {
        round: 0,
        recent: [] as SeenCall[],
        verdicts: 0,
        /** Every call of this whole turn, counted. `recent` forgets after
         *  twelve and is emptied on every verdict — an alternating loop lives
         *  exactly in what it forgets. Never cleared. */
        tally: new Map<string, number>(),
        /** The calls that came back refused, and what they said. A wall is not
         *  a circle: repeating a call the harness has already said no to is a
         *  model that has not been told WHY, and the answer is the reason,
         *  said once — not the loss of its turn. */
        wall: new Map<string, string>(),
        walled: new Set<string>(),
        /** How long a stretch of work may go on, and when this one is over.
         *  Reset for a new stretch, which only a message the user typed can
         *  start. */
        budgetMs: io.turnMs(),
        /**
         * The furthest the clock can ever be pushed, and how much work buys.
         *
         * A flat wall cuts a turn that is finishing and a turn that is going in
         * circles at the same minute. One live session was cut at twenty
         * minutes with the app nearly built; the loop guards, not the clock, are
         * what a circle should die of. So each new file it touches buys a few
         * minutes more, up to a hard ceiling — and a turn that touches nothing
         * still ends exactly when it used to.
         */
        hardUntil: Date.now() + io.turnMs() * 3,
        grantMs: Math.round(io.turnMs() / 4),
        /** Files touched as of the last round, so "a new one" is measurable. */
        touchedAt: 0,
        /** How much the work bought, so the cut can say the honest number. */
        granted: 0,
        /** When this stretch of work began — what `until` is measured from
         *  when a slow model's clock is stretched (see `turnStretch`). */
        since: Date.now(),
        until: Date.now() + io.turnMs(),
        passes: 0,
        /** Why the turn was cut short, in the user's words — "" when the model
         *  finished by itself. Said out loud in the transcript, because a
         *  banner is gone by the next message and the answer above it would
         *  otherwise read as a complete one. */
        cut: "",
        /** The turn must end: the next request offers no tools, and so does
         *  every one after it. */
        forceAnswer: false,
        /** A loop was named twice: the next request — that one only — offers
         *  no tools. A pause, not the end: a live session told to stop
         *  repeating a read answered "Let me confirm the path with ls.", and
         *  with the tools gone for good that sentence was its last. */
        pause: false,
        /** One-shot note for the next request: a nudge or a verdict. */
        note: "",
        nudges: 0,
        /** Reminders of the call format, for a model that got it wrong. */
        formats: 0,
        continued: 0,
        /** A command ran this turn — so "you changed things and checked
         *  nothing" is not said to a turn that did check. */
        ranCommand: false,
        /** That has been said once; saying it twice is nagging. */
        verified: false,
        /** Files changed since the last command — and how often "check now"
         *  has been said for this stretch of them. */
        unchecked: new Set<string>(),
        checkNudges: 0,
        /** Has this turn changed a file yet — and how many looks inside a
         *  dependency since the last change, and has "decide" been said. */
        changedOnce: false,
        depLooks: 0,
        depNudged: false,
        /** Per command: what each failure in a row said — and the commands
         *  "step back" has been said about. */
        fails: new Map<string, string[]>(),
        stuckNudged: new Set<string>(),
        /** A stretch of test work — writing tests, running them — that has
         *  not yet reached a passing run: when it began, its rounds, and how
         *  firmly it has been called out (0, 1, 2). */
        tests: { open: false, since: 0, rounds: 0, said: 0 },
        /** Has anything under the vendored framework's docs been opened this
         *  turn — and has the "read them first" reminder been given once? A
         *  private framework is not in any model's training data, and a `.ts`
         *  file says nothing about the framework above it. */
        studied: false,
        docsNudged: false,
        /** Rounds with tools since every item on the task list was done. */
        doneRounds: 0,
        emptyRetried: false,
        runawayRetried: false,
        /** The window the server said it has, when an overflow told us. */
        ctxCap: Number.POSITIVE_INFINITY,
        lastRaw: 0,
        /** Completion tokens across every round — the speed is over the
         *  whole turn, so its token count has to be too. */
        tokens: 0,
      };
      const ctxNow = () => Math.min(live().ctx, turn.ctxCap);

      /** The vendored framework's documentation, if this project has one —
       *  `null` for an ordinary project. Looked up at the start of the turn,
       *  and again after a command while it is still `null`: the turn that
       *  runs `am create` is the turn whose framework did not exist when it
       *  began, and it is exactly the one that most needs the reminder. */
      let docs = await io.frameworkDocs(cwdOf(id, here()));
      /** How this project's dependencies are spelled in a call, found with
       *  the docs and refreshed with them. */
      let depMarks = await io.dependencyMarks(cwdOf(id, here()));

      /** Identical read-only calls in one turn, answered once — by pointing
       *  at the earlier result while it is still in view, or by repeating it
       *  when compaction has hidden it. Anything that writes clears this. */
      const seen = new Map<string, { result: string; row: string }>();

      /** Say what the turn is doing while there is nothing else to show. */
      const status = (words: string) => {
        here().thinking = words;
      };

      /** Deliver what the user wrote while the turn was working — into the
       *  transcript, marked, so the next request carries it. True when there
       *  was something. */
      const drain = (): boolean => {
        const texts = queuedOf(id).map((q) => q.text);
        if (texts.length === 0) return false;
        QUEUED.delete(id);
        here().queued = [];
        for (const text of texts) {
          here().messages.push(msg("user", text, { steer: true }));
        }
        cap(id, here());
        return true;
      };

      // 1. The window, for sure. A model that is not loaded yet is loaded
      //    now — the first request would pay for that anyway — so the very
      //    first pack is against the length it really runs at.
      if (!live().ctxManual) {
        try {
          let w = await io.probeWindow(engine, baseUrl, model, signal);
          if (w && !w.sure) {
            status("Loading the model…");
            await io.warmUp(engine, baseUrl, model, signal);
            w = (await io.probeWindow(engine, baseUrl, model, signal)) ?? w;
          }
          if (w) await local.applyCtx(id, engine, model, w.ctx); // aiol-ok: orchestration
        } catch { /* best effort: the configured window still works */ }
        status("");
      }

      // 2. Native tools or words. Asked once per model; `false` switches the
      //    turn to the text protocol rather than to failure.
      if (live().mode !== "chat" && here().toolsOk === null) {
        try {
          const ok = await io.probeTools(engine, baseUrl, signal, model);
          if (ok !== null) here().toolsOk = ok;
        } catch { /* the first request finds out */ }
      }

      // Whether "Don't ask" commands are sandboxed here — the prompt tells the
      // model the rules of the box up front when they are.
      const boxed = await io.sandboxAvailable().catch(() => false);
      // …or whether they run as the agent account, which has no box at all.
      const account = await io.projectAccount(cwd).catch(() => null);
      if (local.accounts[id] !== (account?.user ?? null)) {
        await local.setAccount(id, account?.user ?? null); // aiol-ok: orchestration
      }

      // 3. The project, once per conversation — see `LocalChat.env`.
      const refreshEnv = async () => {
        const data = await io.projectEnv(cwd, ctxNow());
        here().env = {
          // Through JSON on purpose: this is persisted, and one `undefined`
          // anywhere in it makes aio refuse the whole save.
          data: JSON.parse(JSON.stringify(data)),
          at: Date.now(),
          ctx: ctxNow(),
          v: ENV_VERSION,
        };
      };
      {
        const env = here().env;
        if (
          !env || env.v !== ENV_VERSION ||
          Date.now() - env.at > 6 * 3_600_000 ||
          tierOf(env.ctx) !== tierOf(ctxNow())
        ) {
          // Before the turn's try/finally: a throw here would leave the chat
          // "working" with nothing to end it.
          await refreshEnv().catch((e) =>
            log.warn("local", "project facts unavailable", {
              key: id,
              error: String(e),
            })
          );
        }
      }

      /** Run one call: approval first (the one act this agent cannot
       *  confine), then the answer-cache, then the executor. */
      const execOne = async (call: LocalToolCall): Promise<string> => {
        const gate = await approveCommand(s, io, id, call, signal);
        if (gate.refusal !== null) return gate.refusal;
        const k = `${call.name}\u0000${call.args}`;
        const before = REPEATABLE.has(call.name) ? seen.get(k) : undefined;
        if (before) {
          const row = here().messages.find((m) => m.id === before.row);
          const inView = row && !row.stubbed && !row.evicted &&
            (!row.folded || io.fullText(id, row.id) !== undefined);
          return inView
            ? `(Same as your earlier identical ${call.name} call — that result` +
              ` is above and still current. Use it, or change the call.)`
            : `${before.result}\n\n[Identical to an earlier call in this turn` +
              ` — the same result, not run again.]`;
        }
        return await io.runTool(live().mode, cwd, call.name, call.args, {
          signal,
          key: id,
          ctx: ctxNow(),
          permission: permissionOf(live()),
          net: live().sandboxNet === true,
          outside: gate.outside,
          recall: call.name === "history"
            ? recallOf(s, io, id, cwd)
            : undefined,
        });
      };

      /** The rounds of one turn. Re-entered after an overflow or a switch to
       *  the text protocol: the transcript already holds everything, so a
       *  retry continues the turn rather than repeating it. */
      const runLoop = async (): Promise<void> => {
        while (turn.round < MAX_ROUNDS) {
          // Stopped between rounds (during a tool, a probe, the compaction):
          // no new request goes out.
          if (signal.aborted) throw new Error("Stopped.");
          const round = turn.round++;
          // What the user wrote since the last step goes in before this one.
          drain();
          // Mode is re-read every round: dropping from agent to read-only
          // mid-turn is a security action, and it must bite on the next call.
          const mode = live().mode;
          const ctx = ctxNow();
          const native = here().toolsOk !== false;
          // Out of time. Checked between rounds, not mid-reply: a reply that
          // is already coming is worth having. A slow model's clock runs
          // longer, by its measured speed — the same rounds, not the same
          // minutes.
          const stretch = io.turnStretch(baseUrl, model);
          if (
            !turn.forceAnswer &&
            Date.now() - turn.since > (turn.until - turn.since) * stretch
          ) {
            turn.forceAnswer = true;
            turn.cut = spanWords((turn.budgetMs + turn.granted) * stretch);
            log.info("local", "turn out of time", { key: id, round });
          }
          const lastRound = round === MAX_ROUNDS - 1;
          const paused = turn.pause && !turn.forceAnswer && !lastRound;
          turn.pause = false;
          const noTools = mode === "chat" || lastRound || turn.forceAnswer ||
            paused;

          const notes = [todoNote(here().todos), turn.note];
          if (lastRound) {
            turn.cut = `${MAX_ROUNDS} tool rounds`;
            here().error = `Reached the ${MAX_ROUNDS}-round tool limit` +
              ` for one turn — this answer was written without tools.`;
          }
          if (paused && mode !== "chat") {
            // Not "answer now": told that, a live session read the pause as
            // the user's word and replied "You've asked me to stop".
            notes.push(
              "The harness running this conversation has paused your tools for" +
                " this one reply, because the last steps went round in a" +
                " circle. The user has not asked you to stop. In two or three" +
                " lines, say what is wrong and the different step you will take" +
                " next; tools come back right after this reply.",
            );
          } else if (noTools && mode !== "chat") {
            notes.push(
              "Tools are off for this reply. Do not call any: answer now with" +
                " what you have — what was done, what is left, and any risk.",
            );
          }
          turn.note = "";
          const note = notes.filter(Boolean).join("\n\n");

          // Pack — and fold anything that fell off into the rolling summary
          // *before* the request: the model must never just lose the past.
          const pack = () =>
            packContext({
              msgs: here().messages,
              ctx,
              mode,
              system: systemPrompt(
                mode,
                ctx,
                {
                  ...(here().env?.data ?? { cwd }),
                  sandbox:
                    !account && boxed && permissionOf(live()) === "dontAsk"
                      ? { net: live().sandboxNet === true }
                      : null,
                  account: account
                    ? {
                      user: account.user,
                      home: account.home,
                      display: account.display,
                    }
                    : null,
                },
                here().summary,
                !native && mode !== "chat",
              ),
              native,
              ratio: here().tokRatio,
              note,
              fullOf: (m) => io.fullText(id, m.id),
            });
          let packed = pack();
          for (
            let fold = 0;
            packed.evict.length || packed.stub.length;
            fold++
          ) {
            const evict = new Set(packed.evict);
            const stub = new Set(packed.stub);
            const dropped: LocalMsg[] = [];
            const whole: LocalMsg[] = [];
            for (const m of here().messages) {
              if (evict.has(m.id)) {
                dropped.push({ ...m });
                m.evicted = true;
                if (m.role === "tool") {
                  const kept = foldedText(m.text);
                  if (kept !== m.text) whole.push({ ...m });
                  m.text = kept;
                }
              } else if (stub.has(m.id)) {
                m.stubbed = true;
                const kept = foldedText(m.text);
                if (kept !== m.text) whole.push({ ...m });
                m.text = kept;
              }
            }
            saveRows(id, whole, here());
            io.dropFull(id, [...evict, ...stub]);
            if (dropped.length === 0 || fold > 0) {
              if (dropped.length) {
                here().summary = appendLines(
                  here().summary,
                  mechanicalSummary(dropped),
                );
              }
              packed = pack();
              break;
            }
            status("Compacting the conversation…");
            try {
              here().summary = await summarize(
                io,
                cfg,
                ctx,
                signal,
                here().summary,
                dropped,
              );
            } catch (e) {
              // Stopped mid-summary: the rows are already out of view, so
              // the plain list of what they held goes in — never nothing.
              here().summary = appendLines(
                here().summary,
                mechanicalSummary(dropped),
              );
              throw e;
            }
            // The prompt changes here anyway — the moment to bring the
            // project facts up to date at no extra cost to the cache.
            await refreshEnv();
            status("");
            packed = pack();
          }
          turn.lastRaw = packed.raw;

          const acc = newAcc();
          here().streaming = "";
          // Coalesce the on-screen update to ~11 fps rather than writing on
          // every token: each write re-renders the reply through the Markdown
          // parser and patches the full string over IPC.
          let lastPaint = 0;
          let checked = 0;
          let runaway = false;
          const cut = new AbortController();
          // The turn's own signal is relayed into this round's controller
          // rather than composed with it: `AbortSignal.any` makes the composite
          // a dependent of the source for as long as the source lives, and a
          // turn can run a thousand rounds. One listener, removed below.
          const relay = () => cut.abort(signal.reason);
          signal.addEventListener("abort", relay, { once: true });
          if (signal.aborted) cut.abort(signal.reason);
          try {
            await io.chatStream({
              baseUrl,
              model,
              messages: packed.wire,
              tools: noTools || !native ? [] : toolSpecs(mode, ctx),
              signal: cut.signal,
              maxTokens: maxOutput(ctx, packed.tokens),
              // llama.cpp honours a per-request thinking budget; the other
              // engines' OpenAI endpoints are not sent a field they do not know.
              // Sized to this model's measured speed — see `thinkBudget`.
              thinkBudget: live().engine === "llamacpp"
                ? io.thinkBudget(baseUrl, model)
                : undefined,
              onChunk: (chunk) => {
                foldChunk(acc, chunk);
                const size = acc.text.length + acc.thinking.length;
                if (size - checked > 1_500) {
                  checked = size;
                  if (isRunaway(acc.text) || isRunaway(acc.thinking)) {
                    runaway = true;
                    cut.abort();
                  }
                }
                const now = Date.now();
                if (now - lastPaint >= 90) {
                  lastPaint = now;
                  const view = splitThink(acc.text, true);
                  const c = here();
                  c.streaming = view.text;
                  c.thinking = (acc.thinking || view.thinking).slice(-600);
                }
              },
            });
          } catch (e) {
            if (!runaway || signal.aborted) throw e;
          } finally {
            signal.removeEventListener("abort", relay);
          }
          {
            const c = here();
            c.usedTokens = acc.promptTokens ?? packed.tokens;
            const ratio = calibrate(c.tokRatio, acc.promptTokens, packed.raw);
            if (ratio !== undefined) c.tokRatio = ratio;
            // Only when the server reported a completion count — a speed
            // computed from characters would be wrong by a tokenizer.
            if (acc.completionTokens !== null && c.startedAt > 0) {
              turn.tokens += acc.completionTokens;
              c.lastMs = Date.now() - c.startedAt;
              c.lastTokens = turn.tokens;
            }
            c.streaming = "";
            c.thinking = "";
          }

          const said = splitThink(acc.text).text;
          if (runaway) {
            if (!turn.runawayRetried) {
              turn.runawayRetried = true;
              turn.note = "Your last reply started repeating the same text" +
                " over and over, and was stopped. Continue with a different," +
                " shorter reply.";
              log.warn("local", "runaway repetition — retrying once", {
                key: id,
              });
              continue;
            }
            here().messages.push(msg("assistant", clip(said, 2_000)));
            cap(id, here());
            here().error = "The model kept repeating itself and was" +
              " stopped. Try again, or a different model.";
            break;
          }

          // Calls: native ones, or — when there are none — the ones a model
          // wrote into its reply as text. Either way in our vocabulary.
          const truncated = acc.finish === "length";
          let reply = said;
          let raw = acc.toolCalls.filter((c) => c.name);
          if (raw.length === 0 && mode !== "chat") {
            const found = recoverToolCalls(said, TOOL_NAMES);
            if (found.calls.length) {
              raw = found.calls.map((c) => ({ id: "", ...c }));
              reply = found.text;
            }
          }
          const asked = withCallIds(
            raw.map((c) => normalizeCall(c, TOOL_NAMES, truncated)),
            round,
          );
          // One reply, a sane number of acts. Two hundred `sh` calls in one
          // breath is a guess, not a plan: the first few run, the rest are
          // named back so the model can ask again for the ones it still wants.
          const calls = asked.slice(0, MAX_CALLS_PER_REPLY);
          if (asked.length > calls.length) {
            turn.note = `You asked for ${asked.length} calls at once; the` +
              ` first ${calls.length} ran and the rest were dropped. Work in` +
              ` small steps: look at these results, then ask for what you` +
              ` still need.`;
            log.info("local", "call fan-out trimmed", {
              key: id,
              asked: asked.length,
            });
          }

          if (calls.length && paused && mode !== "chat") {
            // Called during the pause: nothing runs, and the tools come back —
            // the repeat tally, not this reply, is what ends a real circle.
            if (reply.trim()) {
              here().messages.push(msg("assistant", reply));
              cap(id, here());
            }
            turn.note = "Tools were off for that reply, so its calls did not" +
              " run. They are on again. Do not repeat the call that was going" +
              " round: change it, take another approach, or answer.";
            continue;
          }
          if (calls.length && noTools && mode !== "chat") {
            // Asked to stop calling and called anyway: the loop is not going
            // to break by itself. Keep what it said; end the turn honestly.
            if (reply.trim()) {
              here().messages.push(msg("assistant", reply));
              cap(id, here());
            }
            if (!lastRound) {
              here().error = "The model kept repeating the same calls" +
                " and was stopped. Rephrase the request, or try another model.";
            }
            break;
          }

          if (calls.length === 0) {
            // It tried to call something and got the format wrong: not an
            // answer — the model is waiting for a result that will not come.
            // One precise reminder of the format is the whole fix.
            if (
              mode !== "chat" && !noTools && turn.formats < 2 &&
              looksLikeCall(said, TOOL_NAMES)
            ) {
              turn.formats++;
              if (reply.trim()) {
                here().messages.push(msg("assistant", reply));
                cap(id, here());
              }
              turn.note = native
                ? "Your last reply wrote a tool call as text, and it could not" +
                  " be read. Call the tool through the tool-calling interface."
                : "Your last reply tried to call a tool in a format that could" +
                  " not be read. Write exactly one block per call, like:\n" +
                  '<tool_call>{"name": "read", "arguments": {"path": "a.ts"}}' +
                  "</tool_call>";
              continue;
            }
            if (!reply.trim() && !truncated) {
              if (!turn.emptyRetried) {
                turn.emptyRetried = true;
                turn.note = "Your last reply was empty. Continue: answer the" +
                  " user, or call a tool.";
                continue;
              }
              here().error = "The model returned an empty reply.";
              break;
            }
            here().messages.push(msg("assistant", reply));
            cap(id, here());
            // The user wrote while this reply was being written: answer that
            // before calling the turn done.
            if (drain()) continue;
            // The pause is over and the model said what it would do next:
            // that step, with tools. An answer during the pause stays the
            // answer.
            if (paused && wantsToContinue(reply)) {
              turn.note = "Tools are on again. Take the step you just" +
                " described — not the call that was repeating.";
              continue;
            }
            const tools = mode !== "chat" && !noTools;
            if (truncated && tools && turn.continued < 1) {
              turn.continued++;
              turn.note = "Your reply was cut off by the output limit." +
                " Continue exactly where it stopped — no recap.";
              continue;
            }
            if (tools && turn.nudges < 2 && wantsToContinue(reply)) {
              turn.nudges++;
              turn.note = "Continue: if you meant to use a tool, call it now;" +
                " otherwise give your final answer.";
              continue;
            }
            // Code written against a framework whose documentation was never
            // opened. Said once, at the moment it stops being theoretical —
            // something has already been changed — because a model cannot know
            // that `aio` is not a package it half-remembers: the name looks
            // ordinary, the files are `.ts`, and nothing about either says "you
            // have never seen this API". One live session spent its turn
            // reverse-engineering the source of a framework whose own docs
            // begin "Read these first, in this order".
            if (
              tools && docs !== null && !turn.studied && !turn.docsNudged &&
              (here().changed ?? 0) > 0
            ) {
              turn.docsNudged = true;
              turn.note =
                `You are writing code against the framework in ${
                  docs.rel.replace(/\/docs$/, "")
                } and have not opened its documentation. Read ${docs.rel}/${
                  docs.entry || "README.md"
                } now${
                  docs.entry === "ai.md" ? " — it is written for you" : ""
                }, then the page for what you are building, and correct what you` +
                ` have already written to match. It is a private framework:` +
                ` nothing you remember about a similarly named one applies.`;
              continue;
            }
            // Files changed and nothing run: the turn is about to hand back
            // work nobody has checked. Asked once, and only where there is
            // something to run it with — "verify what you changed" is the rule
            // most often skipped, and the cheapest one to enforce here.
            const touched = here().changed ?? 0;
            if (
              tools && !turn.verified && touched > 0 && !turn.ranCommand &&
              here().env?.data?.toolchain
            ) {
              turn.verified = true;
              turn.note =
                `You changed ${touched} file${
                  touched === 1 ? "" : "s"
                } and have not run anything to check them. Run the project's own` +
                ` check or test command with sh (see the toolchain above), read` +
                ` what it says, and fix what you broke — then answer. If there` +
                ` is genuinely nothing to run, say so in one line.`;
              continue;
            }
            // A reply stopped by the output limit ends mid-sentence, and
            // nothing on screen says so — it just reads as a model that lost
            // its train of thought.
            if (truncated && !lastRound) {
              here().error =
                "The reply hit the model's output limit and stopped" +
                " mid-sentence. Ask for less at a time, or load the model with" +
                " a larger context.";
            }
            break;
          }

          here().messages.push(
            msg("assistant", reply, { toolCalls: calls }),
          );
          // Every push is followed by a cap: a cap applied at only some of
          // them lets the transcript sit over its limit forever.
          cap(id, here());

          // Calls that change nothing run side by side; anything that writes
          // or runs a command goes one at a time, in order.
          const results = parallelSafe(calls.map((c) => c.name))
            ? await Promise.all(calls.map(execOne))
            : [];
          for (let i = 0; i < calls.length; i++) {
            const call = calls[i];
            // After Stop, the rest of a batch is answered, not run: a stopped
            // turn that goes on editing files has not stopped.
            const result = results[i] ??
              (signal.aborted ? io.STOPPED_RESULT : await execOne(call));
            const failed = /^Error:/.test(result);
            const row = msg("tool", result, {
              toolCallId: call.id,
              toolName: call.name,
            });
            here().messages.push(row);
            turn.recent.push({ name: call.name, args: call.args, failed });
            if (isTestWork(call)) {
              if (!turn.tests.open) {
                turn.tests = {
                  open: true,
                  since: Date.now(),
                  rounds: 0,
                  said: 0,
                };
              }
              if (
                call.name === "sh" && !failed && failureMark(result) === null
              ) {
                turn.tests.open = false;
              }
            }
            if (call.name === "sh") {
              trackFailure(turn, call.args, result);
              turn.ranCommand = true;
              turn.unchecked.clear();
              turn.checkNudges = 0;
              if (docs === null && !failed) {
                docs = await io.frameworkDocs(cwdOf(id, here()), true);
                depMarks = await io.dependencyMarks(cwdOf(id, here()), true);
              }
            }
            // Reading, searching or listing anything under the framework's own
            // documentation counts as having looked it up — including through
            // sh, which is still reading.
            if (docs && call.args.includes(docs.rel)) turn.studied = true;
            // A change that landed makes every check new again. Edit, run the
            // tests, edit, run the tests is how work is done, not a circle —
            // and counting it as one cut a live session twice in one task, at
            // its fourth `deno task test` and then at its fourth read-back of
            // the file it was fixing, with a real edit before every one. The
            // writes themselves keep their count: the same write again and
            // again, with a check between, is still the circle it looks like.
            if (
              !MUTATES.has(call.name) &&
              depMarks.some((d) => d !== "" && call.args.includes(d))
            ) turn.depLooks++;
            if (!failed && MUTATES.has(call.name)) {
              turn.changedOnce = true;
              turn.depLooks = 0;
              turn.depNudged = false;
              try {
                const path = JSON.parse(call.args).path;
                if (typeof path === "string") turn.unchecked.add(path);
              } catch { /* the executor already refused torn arguments */ }
              for (const key of [...turn.tally.keys()]) {
                if (!MUTATES.has(key.slice(0, key.indexOf("\n")))) {
                  turn.tally.delete(key);
                }
              }
            }
            turn.tally.set(
              callKey(call),
              (turn.tally.get(callKey(call)) ?? 0) + 1,
            );
            if (failed) turn.wall.set(callKey(call), result);
            else turn.wall.delete(callKey(call));
            const k = `${call.name}\u0000${call.args}`;
            if (REPEATABLE.has(call.name)) {
              if (!failed && !seen.has(k)) seen.set(k, { result, row: row.id });
            } else if (call.name !== "todo") {
              // A write, edit or command changes what every read would say.
              seen.clear();
            }
            if (call.name === "todo" && !failed) {
              try {
                here().todos = parseTodos(JSON.parse(call.args).items);
              } catch { /* the executor already said what was wrong */ }
            }
          }
          cap(id, here());
          // What folding shortens is saved whole first: the model can still
          // look it up word for word with `history`.
          saveRows(
            id,
            fold(here(), ctx, (row, text) => io.keepFull(id, row, text)),
            here(),
          );
          io.dropFull(id, [], new Set(here().messages.map((m) => m.id)));
          if (turn.recent.length > 12) {
            turn.recent.splice(0, turn.recent.length - 12);
          }
          here().changed = io.changedCount(id);
          // Work buys time. `changed` counts DISTINCT files, so rewriting the
          // same one in a circle buys nothing, and neither does a command that
          // merely exits zero — this cannot be talked up, only earned.
          const touched = here().changed ?? 0;
          if (touched > turn.touchedAt) {
            turn.touchedAt = touched;
            const next = Math.min(turn.until + turn.grantMs, turn.hardUntil);
            turn.granted += next - turn.until;
            turn.until = next;
          }
          here().jobs = io.runningJobs(id);

          // Check early. The "you changed files and ran nothing" note below
          // comes only as the turn ends — a live session wrote a cell, a UI,
          // an entry file, a stylesheet and four versions of a test file over
          // six minutes before running anything, and met 49 type errors at
          // once, every one of them about an API it had invented at the start.
          //
          // Said twice at most per stretch, the second time without room for
          // "later": told at three files, a live session answered "I'll write
          // the remaining components, then type-check everything together"
          // and wrote four more first.
          const due = turn.checkNudges === 0
            ? CHECK_AFTER_FILES
            : CHECK_AFTER_FILES * 2;
          if (
            turn.checkNudges < 2 && turn.unchecked.size >= due &&
            !turn.forceAnswer
          ) {
            turn.checkNudges++;
            const n = turn.unchecked.size;
            turn.note = also(
              turn.note,
              turn.checkNudges === 1
                ? `You have changed ${n} files without running anything. Run` +
                  ` the quickest check now — type-check or build — before` +
                  ` writing more: a wrong assumption found now is one fix, found` +
                  ` later it is in every file.`
                : `${n} files changed and still nothing run. Your next call is` +
                  ` the type-check or build — not another file.`,
            );
          }

          // Digging. Reading a framework before writing against it is the
          // method; reading it round after round once the work has started is
          // a turn that has stopped building. A live session met a bug in the
          // framework and spent sixteen rounds inside its source — including
          // a try at patching it — before working round it in one line.
          if (
            turn.changedOnce && !turn.depNudged &&
            turn.depLooks >= DIG_LIMIT && !turn.forceAnswer
          ) {
            turn.depNudged = true;
            turn.note = also(
              turn.note,
              `You have looked inside a dependency ${turn.depLooks}` +
                ` times since you last changed your own code. Stop digging and` +
                ` decide: work around the problem in your code with what you` +
                ` already know (another API, a simpler approach) and run it` +
                ` again — or tell the user exactly what blocks you.`,
            );
          }

          // Stuck on one check. The dig limit does not see this shape: every
          // edit resets it. A live session ran the same type-check eleven
          // times, each fix exposing the next error, and at the eighth run was
          // back at an error it had had four runs before — building by hand a
          // type the framework would have inferred, from a cast it made early.
          const stuck = stuckOn(turn);
          if (stuck && !turn.forceAnswer) turn.note = also(turn.note, stuck);

          // Done, and still going. A live session ticked off its last task and
          // polished for six more minutes — contrast, spacing, restarts — and
          // never told the user the app was ready.
          const todos = here().todos ?? [];
          if (todos.length && todos.every((t) => t.status === "completed")) {
            turn.doneRounds++;
            if (turn.doneRounds === DONE_ROUNDS && !turn.forceAnswer) {
              turn.note = also(
                turn.note,
                `Every item on your task list has been done for` +
                  ` ${DONE_ROUNDS} rounds. Unless something is still broken,` +
                  ` stop and report to the user now: what works, how to run` +
                  ` it, and anything left.`,
              );
            }
          } else turn.doneRounds = 0;

          // Tests that have become the task. A live session had the program
          // written and type-clean at 7.6 minutes and then spent twenty on
          // tests: a template's test broken by replacing what it covered, then
          // a fake clock learned from the test harness's own source, each
          // attempt a two-minute think. No single check failed four times in a
          // row, so nothing above saw it; rounds and minutes do.
          if (turn.tests.open) {
            turn.tests.rounds++;
            const t = turn.tests;
            const mins = (Date.now() - t.since) / 60_000;
            const level = t.rounds >= TEST_STRETCH_ROUNDS * 2 ||
                mins * 60_000 >= TEST_STRETCH_MS * 2
              ? 2
              : t.rounds >= TEST_STRETCH_ROUNDS ||
                  mins * 60_000 >= TEST_STRETCH_MS
              ? 1
              : 0;
            if (level > t.said && !turn.forceAnswer) {
              t.said = level;
              const spent = `${t.rounds} rounds (${
                Math.max(1, Math.round(mins))
              } min)`;
              turn.note = also(
                turn.note,
                level === 1
                  ? `You have spent ${spent} on tests without a passing run.` +
                    ` Unless making these tests pass is the task itself: if you` +
                    ` have not run the program yet, run it now and see whether it` +
                    ` works. Keep the tests that pass; rewrite each failing one on` +
                    ` plain logic, or delete it, in one step — do not learn test` +
                    ` machinery (fake clocks, mocks, a harness's source) to save` +
                    ` it. Say in your answer which tests you dropped.`
                  : `${spent} on tests and still no passing run. Unless the` +
                    ` tests are the task: stop working on them now — delete or` +
                    ` skip the failing ones, confirm the program itself runs, and` +
                    ` finish.`,
              );
            }
          }

          // A loop, named once; named twice or three times, the tools go away
          // for one round; named a fourth time, the turn is over.
          const verdict = loopVerdict(turn.recent);
          if (verdict) {
            turn.verdicts++;
            turn.note = also(turn.note, verdict);
            if (turn.verdicts >= MAX_VERDICTS) {
              turn.forceAnswer = true;
              turn.cut = `going round in circles ${turn.verdicts} times`;
            } else if (turn.verdicts >= 2) turn.pause = true;
            turn.recent = [];
            log.info("local", "loop verdict", {
              key: id,
              count: turn.verdicts,
            });
          }
          // The other shape of a loop: the same act again and again with other
          // acts in between, so nothing is ever three in a row. The count is
          // over the whole turn, so this catches it however wide the circle.
          // Walked into the same wall twice: the harness has already refused
          // this exact call, and a second identical try means the reason never
          // landed. Put it in front of the model once, with the call named,
          // rather than letting the loop cut take the turn away four tries
          // later — which is what happened to a live session that asked for a
          // framework file it was not allowed to read: four refusals, one lost
          // turn, and a model that never saw a way forward.
          const walled = [...turn.tally.entries()].find(([k, n]) =>
            n >= 2 && turn.wall.has(k) && !turn.walled.has(k)
          );
          if (walled && !turn.forceAnswer) {
            const [key, times] = walled;
            turn.walled.add(key);
            const why = (turn.wall.get(key) ?? "").split("\n")[0].slice(0, 220);
            turn.note = also(
              turn.note,
              `\`${
                key.split("\n")[0]
              }\` with those exact arguments has now failed ${times} times:` +
                ` ${why} Another identical try fails the same way — change the` +
                ` arguments, use a different tool, or say what is in the way.`,
            );
            log.info("local", "same call walled", {
              key: id,
              call: key.split("\n")[0],
              times,
            });
          }
          const over = [...turn.tally.entries()]
            .find(([, n]) => n >= MAX_SAME_CALL);
          if (over && !turn.forceAnswer) {
            turn.forceAnswer = true;
            turn.cut = `the same ${over[0].split("\n")[0]} call` +
              ` ${over[1]} times`;
            const refused = turn.wall.get(over[0]);
            turn.note =
              `You have made the same ${over[0].split("\n")[0]} call ${
                over[1]
              } times in this turn, going round in a circle.` +
              (refused
                // Carried into the note, because the next thing said to this
                // model is "continue" and without the reason it walks straight
                // back into the same wall.
                ? ` Every one of them failed the same way: ${
                  refused.split("\n")[0].slice(0, 220)
                }`
                : "") +
              ` Stop calling tools and say what you found, what you did, and` +
              ` what is still in the way.`;
            log.info("local", "repeat tally tripped", {
              key: id,
              call: over[0].split("\n")[0],
              times: over[1],
            });
          }
        }
        // Cut short, not finished: said in the transcript, where it stays.
        if (turn.cut && here().messages.length > 0) {
          here().messages.push(
            msg(
              "assistant",
              `*(stopped after ${turn.cut} — ask me to` +
                ` continue, or say what to do differently)*`,
            ),
          );
          cap(id, here());
          turn.cut = "";
        }
      };

      try {
        // One pass per stretch of work. A message that arrives too late for
        // the stretch it was written during — after the final answer, or the
        // "stop" that cut it short — is answered by another pass of this same
        // turn: a second `send` started from here would still see this one
        // working, and queue itself behind it forever.
        for (;;) {
          try {
            for (let attempt = 0;; attempt++) {
              try {
                await runLoop();
                break;
              } catch (e) {
                if (signal.aborted) throw e;
                const raw = e instanceof Error ? e.message : String(e);
                const mode = live().mode;
                // The window overflowing is the one failure a retry can
                // answer — with what the server just said about itself: the
                // size it really has, or how badly the estimate missed.
                if (isOverflow(raw) && attempt < 2) {
                  const facts = overflowFacts(raw);
                  if (facts.ctx) turn.ctxCap = Math.min(turn.ctxCap, facts.ctx);
                  const c = here();
                  const learned = facts.prompt && turn.lastRaw
                    ? facts.prompt / turn.lastRaw
                    : (c.tokRatio ?? 1) * 1.3;
                  c.tokRatio = Math.min(
                    3,
                    Math.max(learned, (c.tokRatio ?? 1) * 1.1),
                  );
                  log.warn(
                    "local",
                    "context overflow — repacking and retrying",
                    {
                      key: id,
                      ctx: facts.ctx ?? null,
                    },
                  );
                  continue;
                }
                // Refused because of the tools in the request: describe them
                // in words instead, and carry on.
                if (
                  isNoToolSupport(raw) && mode !== "chat" &&
                  here().toolsOk !== false
                ) {
                  here().toolsOk = false;
                  log.info("local", "native tools refused — text protocol", {
                    key: id,
                  });
                  continue;
                }
                throw e;
              }
            }
          } catch (e) {
            if (!signal.aborted) throw e;
            // Only into a conversation that still exists: an abort can also
            // mean `clear()`, and the marker must not resurrect a wiped chat.
            if (here().messages.length > 0) {
              // The button stops everything: what was typed meanwhile is kept
              // where it was said, unanswered, rather than lost or acted on.
              if (HALTED.has(id)) drain();
              here().messages.push(msg("assistant", "*(stopped)*"));
              cap(id, here());
            }
          }
          // Anything still waiting — a "stop", a late correction — is the
          // next pass, and the model answers it. Unless the user pressed
          // Stop (or cleared, or switched model): then nothing more is sent.
          if (
            HALTED.has(id) || queuedOf(id).length === 0 ||
            here().messages.length === 0
          ) {
            break;
          }
          // Enough stretches. What is still waiting is put in the transcript
          // where it was said — unanswered, and visibly so — rather than
          // starting a ninth one.
          if (++turn.passes >= MAX_PASSES) {
            drain();
            here().messages.push(
              msg(
                "assistant",
                "*(stopped: too many messages in one turn — send this again" +
                  " and I will pick it up)*",
              ),
            );
            cap(id, here());
            break;
          }
          io.endRun(id, signal);
          signal = io.beginRun(id);
          // A new stretch of work, for something the user typed just now: its
          // own rounds and its own clock. What it does NOT get is a clean slate
          // on the loop tally — a circle the model was walking before the
          // interruption is the same circle after it.
          turn.round = 0;
          // A new stretch of work: the clock and what it can be pushed to both
          // start over, because only a message the user typed gets here.
          turn.since = Date.now();
          turn.until = Date.now() + turn.budgetMs;
          turn.hardUntil = Date.now() + turn.budgetMs * 3;
          turn.granted = 0;
          turn.touchedAt = here().changed ?? 0;
          turn.note = "";
          turn.forceAnswer = false;
          turn.pause = false;
          turn.recent = [];
        }
      } catch (e) {
        const raw = e instanceof Error ? e.message : String(e);
        // aiol-ok: live reads, deliberately — the address this turn actually
        // failed against and the scan's newest answer are both facts about
        // NOW, and this cell publishes as it goes (transaction: false).
        const now = cfgAt(s, id);
        here().error = explainError(raw, {
          baseUrl: now.baseUrl,
          engine: now.engine,
          // aiol-ok: the scan's newest answer, on purpose
          found: s.detected.find((d) =>
            d.engine === now.engine && d.reachable
          )?.baseUrl ?? null,
        });
        log.error("local", "turn failed", { key: id, error: raw });
        // A dead address is the one failure the app can answer by itself:
        // look, and the banner offers whatever answered.
        if (isUnreachable(raw)) void local.detect(); // aiol-ok: orchestration
      } finally {
        io.endRun(id, signal); // only this run's own registration
        // A newer turn took the conversation over: its state is not ours to
        // end. Only the owner closes the turn.
        if (ACTIVE.get(id) === claim) {
          HALTED.delete(id);
          ACTIVE.delete(id);
          const c = chatAt(s, id);
          c.status = "idle";
          c.startedAt = 0;
          c.streaming = "";
          c.thinking = "";
          c.changed = io.changedCount(id);
          // A question outlives nothing: the turn that asked it is over.
          c.pending = null;
          c.jobs = io.runningJobs(id);
          // A failed turn leaves its queue for the user to see and resend.
          c.queued = queuedOf(id);
        }
      }
      // The message was taken and answered — whatever the answer was.
      return true;
    },

    /** Take back a message still waiting to be delivered into the task. */
    unqueue(s: LocalState, key: string, queuedId: string) {
      QUEUED.set(key, queuedOf(key).filter((q) => q.id !== queuedId));
      if (s.chats[key]) s.chats[key].queued = queuedOf(key);
    },

    /** The page's copy of the queue — see `QUEUED`. */
    /** Show what is waiting. The list is read here, not passed in: a list read
     *  before the await that leads here can name a message the running turn has
     *  already delivered, and the chip would then point at a message that is
     *  sitting in the transcript. */
    setQueued(s: LocalState, key: string) {
      if (s.chats[key]) {
        s.chats[key].queued = queuedOf(key).map((q) => ({ ...q }));
      }
    },

    /** Stop the conversation's background programs — the button beside the
     *  composer, for a server the agent left running. */
    async stopBackground(_s: LocalState, key?: string) {
      const id = key ?? activeSessionKey();
      const io = await import("./local.server.ts");
      io.stopJobs(id);
      await local.setBackgroundCount(id, io.runningJobs(id)); // aiol-ok: orchestration
    },

    setBackgroundCount(s: LocalState, key: string, n: number) {
      if (s.chats[key]) s.chats[key].jobs = n;
    },

    /** Let sandboxed commands in this conversation use the network. Off by
     *  default: with the network come the internet AND the display (the X
     *  server's abstract socket lives in the network namespace). */
    setSandboxNet(s: LocalState, key: string, on: boolean) {
      cfgAt(s, key).sandboxNet = on === true;
    },

    /**
     * Put back the files the last turn changed through edit and write.
     *
     * The agent's changes are the user's to keep — this is the button that
     * makes that true. A note goes into the conversation, so the model knows
     * on the next turn that the work it remembers doing is gone.
     */
    async undoChanges(s: LocalState, key?: string) {
      const id = key ?? activeSessionKey();
      if (chatAt(s, id).status === "working") return;
      const io = await import("./local.server.ts");
      const report = await io.undoChanges(id);
      const c = chatAt(s, id);
      c.changed = 0;
      c.messages.push(msg("user", `(${report})`));
      cap(id, c);
    },

    /**
     * Answer the held command.
     *
     * `always` is per project and persists with it — the same shape as
     * Allow-all on the Claude side, and deliberately not a global switch: a
     * scratch repo saying yes to everything must not speak for the one you
     * ship.
     */
    async answer(
      s: LocalState,
      key: string,
      allowed: boolean,
      always = false,
      /** Which command is being answered — the page sends the id it drew the
       *  card from, so a click that lands after the card has moved on to the
       *  next command does nothing instead of allowing it. */
      call?: string,
    ) {
      const chat = chatAt(s, key);
      if (!chat.pending) return;
      if (call !== undefined && chat.pending.id !== call) return;
      // "…and stop asking" promotes to the *guarded* mode, not to Bypass.
      // The old two-valued field had nowhere else to go; now there is a mode
      // that means what the button says — stop interrupting me — without also
      // meaning "and delete whatever you like".
      // Outside the sandbox in "Don't ask" the mode is already that, so the
      // button means what it says there: stop asking about THIS program. A
      // live session asked seven times to start and look at one app.
      if (allowed && always) {
        const cfg = cfgAt(s, key);
        if (chat.pending.outside && permissionOf(cfg) === "dontAsk") {
          cfg.outsideAllowed = [
            ...new Set([
              ...(cfg.outsideAllowed ?? []),
              ...programsToAllow(chat.pending.cmd),
            ]),
          ];
        } else cfg.permission = "dontAsk";
      }
      chat.pending = null;
      const io = await import("./local.server.ts");
      io.answerApproval(key, allowed, call);
    },

    /** The question, and its withdrawal — sync, so neither rides on the long
     *  `send` draft. `pending` is what the page renders the prompt from, so a
     *  lost write here is a turn parked on a question nobody can see. */
    askCommand(
      s: LocalState,
      key: string,
      id: string,
      cmd: string,
      outside = false,
      background = false,
    ) {
      chatAt(s, key).pending = { id, cmd, at: Date.now(), outside, background };
    },

    clearPending(s: LocalState, key: string) {
      chatAt(s, key).pending = null;
    },

    /**
     * How much the agent may do on its own.
     *
     * Closed over the three real modes, and anything else lands on `ask`: this
     * value decides whether a shell command runs with nobody looking, so a
     * junk value from the control plane has to fail closed.
     */
    setPermission(s: LocalState, key: string, mode: string) {
      const known = LOCAL_PERMISSIONS.some((p) => p.id === mode);
      const next = (known ? mode : "ask") as LocalPermission;
      // What was allowed outside was allowed under the old mode.
      if (cfgAt(s, key).permission !== next) {
        delete cfgAt(s, key).outsideAllowed;
      }
      cfgAt(s, key).permission = next;
      // Chosen by name in Settings: there is nothing for "Auto-approve" to go
      // back to any more.
      delete cfgAt(s, key).beforeAutoApprove;
      // The field this replaced is left behind rather than carried forward: a
      // stale "always" outliving a switch back to Ask would be read by
      // `permissionOf` on the next boot as Bypass.
      delete cfgAt(s, key).shApproval;
      log.info("local", "permission set", { key, mode: next });
    },

    /**
     * "Auto-approve": every command runs, nothing is asked — Bypass, from the
     * strip. Switched off, the mode it was switched on over comes back, so a
     * chat that ran in "Don't ask" is not dropped to asking every time. A
     * question already on screen is answered yes: that is what the box says.
     */
    autoApprove(s: LocalState, key: string, on: boolean) {
      const cfg = cfgAt(s, key);
      const now = permissionOf(cfg);
      if (on === (now === "bypass")) return;
      if (on) {
        cfg.beforeAutoApprove = now;
        cfg.permission = "bypass";
      } else {
        cfg.permission = cfg.beforeAutoApprove ?? "ask";
        delete cfg.beforeAutoApprove;
      }
      delete cfg.outsideAllowed;
      delete cfg.shApproval;
      const chat = chatAt(s, key);
      if (on && chat.pending) {
        const call = chat.pending.id;
        chat.pending = null;
        void import("./local.server.ts").then((io) =>
          io.answerApproval(key, true, call)
        );
      }
      log.info("local", "auto-approve set", { key, on });
    },

    /** Abort the in-flight turn. The loop's own catch writes the outcome. */
    /**
     * Changing who answers ends the answer already coming.
     *
     * Switching engine or model mid-turn used to leave the old turn running
     * against the old server, holding `status: "working"` — which disables the
     * composer — while the strip above it claimed a different engine was
     * selected. It cleared itself eventually, when the abandoned request timed
     * out about two minutes later. Two minutes of an app that refuses to be
     * typed into, having just been told to change, is indistinguishable from a
     * broken one; the reasonable response is to restart it, which is what
     * happened.
     *
     * A reply from the engine you just switched away from is not wanted, so it
     * is not waited for.
     */
    async switched(s: LocalState, key: string) {
      if (chatAt(s, key).status !== "working") return;
      HALTED.add(key);
      const io = await import("./local.server.ts");
      io.stopRun(key, ACTIVE.has(key));
    },

    /**
     * The Stop button. Ends the turn now — the request, the command, the
     * question it is waiting on — and sends nothing more, even with messages
     * queued. A "working" flag with no turn behind it (a crash, a lost write)
     * is cleared on the spot: Stop must always give the composer back.
     */
    async stop(s: LocalState, key?: string) {
      const id = key ?? activeSessionKey();
      const chat = chatAt(s, id);
      if (chat.status !== "working") return;
      if (!ACTIVE.has(id)) {
        chat.status = "idle";
        chat.startedAt = 0;
        chat.streaming = "";
        chat.thinking = "";
        chat.pending = null;
        return;
      }
      HALTED.add(id);
      const io = await import("./local.server.ts");
      // Nothing was running: the flag outlived its turn (a throw in the
      // prologue, a lost write). Stop gives the composer back either way.
      if (!io.stopRun(id, true)) {
        const c = chatAt(s, id);
        c.status = "idle";
        c.startedAt = 0;
        c.streaming = "";
        c.thinking = "";
        c.pending = null;
      }
    },

    /** Wipe the conversation (and its summary). Config stays. A running turn
     *  is aborted first — resetting `status` under a live loop would admit a
     *  second concurrent one. */
    /**
     * Start again on a blank slate.
     *
     * What was there is kept — once, and only for this project — so the
     * decision can be taken back. A conversation is not persisted anywhere
     * else in this app, which makes an unrecoverable Clear the most expensive
     * button on the page.
     */
    async clear(s: LocalState, key?: string) {
      const id = key ?? activeSessionKey();
      const io = await import("./local.server.ts");
      if (chatAt(s, id).status === "working") {
        HALTED.add(id);
        io.stopRun(id, ACTIVE.has(id));
        // The turn loses the conversation now, not when it finishes winding
        // down: whatever it still writes goes to a throwaway (see `here`).
        ACTIVE.delete(id);
      }
      // What this conversation read and changed is about a transcript that is
      // gone: a fresh one starts with no reads to vouch for an overwrite —
      // and nothing typed for the old task is delivered into a new one.
      io.forgetFiles(id);
      QUEUED.delete(id);
      // Snapshotted, not referenced — and copied element by element, each
      // message *and* its tool calls.
      //
      // The line below REPLACES `s.chats[id]`, and a draft reference taken
      // before that points into an object the runtime has since retired. It
      // refuses the read rather than let it quietly resolve (cell-impl.ts
      // `throwStaleCapture`), so Clear failed outright and the undo it was
      // saving never arrived. `workspace.forget` documents the same trap for
      // the same reason.
      const before = chatAt(s, id).messages.map((m) => ({
        ...m,
        toolCalls: m.toolCalls?.map((c) => ({ ...c })),
      }));
      // Read after the await on purpose: these two take the CURRENT row, which
      // is the point. A value captured earlier would describe the conversation
      // as it was when Clear was pressed, not as it is now.
      // aio-ok
      const cwd = cwdOf(id, s.chats[id]);
      const wasParked = !!s.chats[id]?.parked; // aio-ok
      s.chats[id] = blankChat();
      if (before.length > 0) s.cleared[id] = before;
      // Off the screen, not out of the record: what was cleared stays
      // searchable by the agent's `history`, like everything else said.
      saveRows(id, before, undefined, cwd);
      if (wasParked) archiveParked(id, cwd);
    },

    /** Put back what the last clear took away. Refused once anything new has
     *  been said: this is an undo for the moment right after, not a merge. */
    undoClear(s: LocalState, key?: string) {
      const id = key ?? activeSessionKey();
      const kept = s.cleared[id] ?? [];
      const chat = chatAt(s, id);
      if (kept.length === 0 || chat.messages.length > 0) return;
      chat.messages = kept;
      delete s.cleared[id];
    },

    /**
     * Move idle conversations out of the app's state and onto disk.
     *
     * Every conversation used to ride in state — serialized on every save,
     * 3.6 MB of it measured on a working machine, nearly all of it chats
     * nobody had opened that day. Parked, a chat costs one small marker; it
     * comes back whole the moment it is opened or written to (`unpark`).
     *
     * An orchestrator: it reads, writes the files, and hands each result to a
     * sync method that checks nothing moved in the meantime.
     */
    async parkIdle(s: LocalState, idleMs = PARK_AFTER_MS) {
      const visible = activeSessionKey();
      const now = Date.now();
      // Only the keys here: copying the rows is the slow part, and it happens
      // after the first await, one chat at a time — the synchronous start of
      // a method has a 5 ms budget, and 3 MB of chats do not fit in it.
      const todo: string[] = [];
      for (const [key, c] of Object.entries(s.chats)) {
        if (
          key === visible || c.parked || c.status === "working" ||
          c.pending || (c.queued?.length ?? 0) > 0 ||
          c.messages.length === 0 || ACTIVE.has(key) || QUEUED.has(key)
        ) continue;
        const last = Math.max(
          c.messages[c.messages.length - 1]?.at ?? 0,
          TOUCHED.get(key) ?? 0,
        );
        if (now - last < idleMs) continue;
        todo.push(key);
      }
      if (todo.length === 0) return;
      const io = await import("./local.server.ts");
      let parked = 0;
      for (const key of todo) {
        // aiol-ok: a live read, deliberately — the chat as it is NOW is what
        // goes to disk, and `markParked` refuses if it moves after this.
        const c = local.chats[key];
        if (!c || c.parked || c.messages.length === 0) continue;
        const rows = JSON.parse(JSON.stringify(c.messages)) as LocalMsg[];
        if (!await io.parkRows(key, cwdOf(key, c), rows)) continue;
        const last = rows[rows.length - 1];
        // aiol-ok: orchestration
        if (await local.markParked(key, rows.length, last.id)) parked++;
      }
      if (parked) log.info("local", "parked idle conversations", { parked });
    },

    /** The machine's side of housekeeping: background programs nobody stopped.
     *  A dev server the model started this morning is, by the evening, a port
     *  held and a fan spinning for no one. */
    async sweepJobs(_s: LocalState) {
      const io = await import("./local.server.ts");
      const stopped = io.sweepJobs();
      if (stopped) {
        log.info("local", "stopped stale background jobs", {
          stopped,
        });
      }
    },

    /** The state half of parking — only if the chat is exactly as it was
     *  written to disk, idle, and still not on screen. */
    markParked(s: LocalState, key: string, rows: number, lastId: string) {
      const c = s.chats[key];
      if (
        !c || c.parked || c.status === "working" || c.pending ||
        key === activeSessionKey() || c.messages.length !== rows ||
        c.messages[rows - 1]?.id !== lastId
      ) return false;
      c.messages = [];
      c.parked = { rows, at: Date.now() };
      return true;
    },

    /** Bring a parked conversation back into state. Safe to call on one that
     *  is not parked, and from several places at once. False when its saved
     *  messages could not be read (the chat says so). */
    async unpark(s: LocalState, key: string): Promise<boolean> {
      TOUCHED.set(key, Date.now());
      if (!s.chats[key]?.parked) return true;
      let job = UNPARKING.get(key);
      if (!job) {
        job = import("./local.server.ts")
          .then((io) => io.unparkRows(key, true))
          .then((got) =>
            local.restoreParked( // aiol-ok: orchestration
              key,
              "rows" in got ? got.rows : null,
              "why" in got ? got.why : "",
            )
          )
          .then((ok) => ok !== false)
          .finally(() => UNPARKING.delete(key));
        UNPARKING.set(key, job);
      }
      return await job;
    },

    restoreParked(
      s: LocalState,
      key: string,
      rows: LocalMsg[] | null,
      why = "",
    ): boolean {
      const c = s.chats[key];
      if (!c?.parked) return true;
      c.parked = null;
      if (rows === null) {
        // Said in the chat itself — to the user, and to the model on the next
        // turn — never pretended away as a chat that was always empty. A
        // banner alone would be cleared by the very next message.
        c.messages.push(msg(
          "user",
          `(This conversation's earlier messages could not be read back —` +
            ` ${why || "unknown reason"}. What came before is not in view.)`,
        ));
        log.warn("local", "a parked conversation could not be read", {
          key,
          why,
        });
        return false;
      }
      // Nothing is written to a parked chat — but if something ever were, it
      // is newer than the file, so it goes after.
      c.messages = [...rows, ...c.messages];
      return true;
    },
  },
});

/**
 * Hold an `sh` call until the user answers — or let it straight through.
 *
 * Returns `null` when the call may proceed, and the tool *result* to feed back
 * when it may not: a refusal is part of the conversation, not an error. The
 * model reads it and picks something else, exactly as it does on the Claude
 * side.
 */
/** What the approval step decided: a refusal to hand back to the model, or
 *  a go — and whether the go is the user's approval to run this one command
 *  outside the sandbox. */
type Gate = { refusal: string | null; outside: boolean };

async function approveCommand(
  s: LocalState,
  io: typeof import("./local.server.ts"),
  id: string,
  call: { id: string; name: string; args: string },
  signal: AbortSignal,
): Promise<Gate> {
  const pass: Gate = { refusal: null, outside: false };
  if (call.name !== "sh") return pass;
  // The mode gate comes first, always. Asking about a call the executor is
  // going to refuse anyway would park the turn on a question whose only honest
  // answer changes nothing — and in read-only mode there is no `sh` to allow.
  if (!allowedTools(cfgAt(s, id).mode).includes(call.name)) return pass;
  const permission = permissionOf(cfgAt(s, id));
  let cmd = "";
  let wantsOut = false;
  let background = false;
  try {
    const parsed = JSON.parse(call.args || "{}");
    cmd = typeof parsed?.cmd === "string" ? parsed.cmd : "";
    wantsOut = parsed?.outside_sandbox === true;
    background = parsed?.background === true;
  } catch { /* unparseable arguments are the executor's to reject */ }
  if (!cmd) return pass;
  // Listing or stopping the conversation's own background jobs touches
  // nothing else; asking about it would be noise.
  if (/^\s*(jobs|stop-job\s+(all|\d+))\s*$/.test(cmd)) return pass;
  // As the agent account nothing is boxed and there is no "outside" to ask
  // for: the project is in the account's reach, and the account is the wall.
  const account = await io.projectAccount(cwdOf(id)).catch(() => null);
  const boxed = !account && permission === "dontAsk" && !wantsOut &&
    await io.sandboxAvailable();
  // A shape that only wastes the turn is answered before anyone is asked and
  // in every mode: a user approving `deno task dev` would approve two minutes
  // of waiting for its timeout.
  const advice = commandAdvice(cmd, background, boxed);
  if (advice !== null) {
    log.info("local", "command answered with advice", { key: id });
    return { refusal: `Error: not run — ${advice}`, outside: false };
  }
  if (permission === "bypass") return { refusal: null, outside: true };
  // "Don't ask" as the account: everything runs. What a command can reach is
  // decided by the account's rights, which a disguised command cannot change —
  // unlike a reading of its words.
  if (account && permission === "dontAsk") return pass;

  // "Don't ask" is not "anything goes": nobody is watching, so the commands
  // whose damage cannot be undone by reading the transcript afterwards are
  // refused instead of run — and, where bubblewrap works, everything else
  // runs in the sandbox. The refusal is written for the model — a precise no
  // is what makes it try something else — and it names the way to ask.
  if (permission === "dontAsk") {
    const boxed = await io.sandboxAvailable();
    // No box, no unattended commands. Without bubblewrap the only thing
    // between "don't ask" and the user's home directory is a reading of the
    // command's words, and words are easy to disguise: `\rm -rf ~`,
    // `X=rm; $X -rf ~`, `python -c shutil.rmtree(...)`, an eval of base64.
    // This mode then behaves as Ask — slower, and still there tomorrow.
    if (!boxed) {
      log.info("local", "no sandbox here — asking instead of running", {
        key: id,
      });
    } else if (!wantsOut) {
      const why = destructiveReason(cmd, boxed, cwdOf(id));
      if (why === null) return pass;
      log.info("local", "command refused by the guardrail", {
        key: id,
        why,
      });
      return {
        refusal: `Error: refused without asking — ${why}. This conversation` +
          ` runs in "Don't ask" mode, which runs ordinary commands but not` +
          ` destructive ones. Do it a way that destroys nothing — or, if it` +
          ` really is needed, call sh again with outside_sandbox: true and` +
          ` the user is asked to approve this one command.`,
        outside: false,
      };
    } // Otherwise the model asked to leave the sandbox. A command that only
    // looks, or runs only programs the user already allowed outside, goes;
    // anything else is the one command the user is asked about in this mode.
    else if (
      mayLeaveUnasked(cmd, cfgAt(s, id).outsideAllowed, io.lookEnv(id))
    ) {
      log.info("local", "left the sandbox unasked", { key: id });
      return { refusal: null, outside: true };
    }
  }

  // Through sync methods, not this draft: `send` is the longest method in the
  // app and `pending` is what the page renders the prompt from. A write lost
  // to the draft hazard here is a turn parked forever on a question nobody can
  // see — see the note on `local.detect`.
  await local.askCommand(
    id,
    call.id,
    cmd,
    permission === "dontAsk" && wantsOut,
    background,
  ); // aiol-ok: orchestration
  const allowed = await io.awaitApproval(id, signal, call.id);
  await local.clearPending(id); // aiol-ok: orchestration
  if (allowed) return { refusal: null, outside: true };
  log.info("local", "command refused", { key: id, chars: cmd.length });
  return {
    refusal: signal.aborted
      ? "Stopped."
      : "Error: the user did not allow that command to run. Explain what it" +
        " would have done, or try something that does not need it.",
    outside: false,
  };
}

/**
 * Keep a conversation's STORED tool output small.
 *
 * Every conversation is persisted and broadcast whole, and tool output is most
 * of it. Past the store budget the oldest results are folded: the saved row
 * keeps only the head and tail of its text, and the whole of it goes to the
 * saved history — and, through `keep`, to the running process, which goes on
 * sending it to the model. What the model stops seeing is packing's decision,
 * made against the window, not this one.
 */
function fold(
  chat: LocalChat,
  ctx: number,
  keep?: (row: string, text: string) => void,
): LocalMsg[] {
  const ids = new Set(storeStubs(chat.messages, storeBudget(ctx)));
  const whole: LocalMsg[] = [];
  for (const m of chat.messages) {
    if (ids.has(m.id)) m.folded = true;
    if (m.role === "tool" && (m.folded || m.stubbed || m.evicted)) {
      const kept = foldedText(m.text);
      if (kept !== m.text) {
        whole.push({ ...m });
        // Only the text it had before its first fold is the whole text:
        // what is kept for the model is never overwritten with a stored copy.
        if (
          m.folded && !m.stubbed && !m.evicted && keep &&
          ids.has(m.id)
        ) keep(m.id, m.text);
        m.text = kept;
      }
    }
  }
  return whole;
}

/** Keep a chat under its row limit. What goes is saved to disk first: the
 *  app's state stays small, and the past stays searchable (`history`).
 *
 *  Takes the chat rather than looking it up: every write inside a turn goes
 *  through the turn's own claim (`here()`), and a lookup here would be the one
 *  way back into a conversation the turn no longer owns — re-creating a chat
 *  that Clear or a removed project had just taken away. */
function cap(id: string, c: LocalChat): void {
  if (c.messages.length <= MAX_LOCAL_MESSAGES) return;
  const gone = c.messages.splice(0, c.messages.length - MAX_LOCAL_MESSAGES);
  c.archived = (c.archived ?? 0) + gone.length;
  saveRows(id, gone, c);
}

/** The folder a conversation works in — from the workspace, or, for one
 *  whose project is already gone, from what its last turn recorded. */
function cwdOf(id: string, chat?: LocalChat): string {
  const owner = projectOf(id);
  return workspace.projects.find((p) => p.id === owner)?.path ??
    chat?.env?.data?.cwd ?? "";
}

/** Writing a test file, or running a test suite. */
function isTestWork(call: { name: string; args: string }): boolean {
  try {
    const a = JSON.parse(call.args);
    if (MUTATES.has(call.name)) return isTestPath(String(a.path ?? ""));
    if (call.name === "sh") return runsTests(String(a.cmd ?? ""));
  } catch { /* torn arguments did nothing */ }
  return false;
}

/** Remember what a command's run said: a pass forgets its failures, a
 *  failure joins the row of them. */
function trackFailure(
  turn: { fails: Map<string, string[]> },
  args: string,
  result: string,
): void {
  let cmd = "";
  try {
    cmd = String(JSON.parse(args).cmd ?? "");
  } catch { /* torn arguments ran nothing */ }
  const key = cmd.replace(/\s+/g, " ").trim();
  if (!key || /^Error: (not run|refused)/.test(result)) return;
  const mark = failureMark(result);
  if (mark === null) turn.fails.delete(key);
  else turn.fails.set(key, [...(turn.fails.get(key) ?? []), mark]);
}

/** "Step back", once per command: when an error seen earlier in a row of
 *  failures is back, or the row has grown long. `""` when neither. */
/**
 * One more thing for the next request to say, after what is already queued.
 *
 * The checks after a round used to each overwrite the one slot, so the last
 * to fire was the only one heard: a live session got "that read failed twice
 * with the same arguments" replaced, in the same round, by a note about the
 * same read. Kept in firing order; the same text twice is said once.
 */
export const also = (queued: string, next: string): string =>
  !queued ? next : queued.includes(next) ? queued : `${queued}\n\n${next}`;

function stuckOn(
  turn: { fails: Map<string, string[]>; stuckNudged: Set<string> },
): string {
  for (const [cmd, marks] of turn.fails) {
    if (turn.stuckNudged.has(cmd) || marks.length < 3) continue;
    const last = marks[marks.length - 1];
    const before = marks.slice(0, -2).lastIndexOf(last);
    const circled = before >= 0;
    if (!circled && marks.length < STUCK_AFTER_FAILS) continue;
    turn.stuckNudged.add(cmd);
    const shown = cmd.length > 80 ? cmd.slice(0, 77) + "…" : cmd;
    return (circled
      ? `\`${shown}\` is failing with an error you already had ${
        marks.length - 1 - before
      } runs ago: the changes since went in a circle.`
      : `\`${shown}\` has failed ${marks.length} times in a row, each fix` +
        ` uncovering the next error.`) +
      ` Step back before the next edit: undo the workaround you have been` +
      ` building up (casts, hand-written types, copies of a dependency's` +
      ` internals) and write it the plain way the docs' own examples do, or` +
      ` take a simpler approach. If a dependency really does not allow it, say` +
      ` so.`;
  }
  return "";
}

/** Hand rows to disk. Copied NOW — they are draft values that the next write
 *  may retire — and written in the background, in order per conversation. */
function saveRows(
  id: string,
  rows: LocalMsg[],
  chat?: LocalChat,
  cwd = cwdOf(id, chat),
): void {
  if (rows.length === 0) return;
  const copy = JSON.parse(JSON.stringify(rows)) as LocalMsg[];
  void import("./local.server.ts").then((io) => io.saveRows(id, cwd, copy));
}

/**
 * What `history` may search beyond the saved files: this project's
 * conversations still in state. From this one, only what the model can no
 * longer see — the rest is already in front of it. Never another project's.
 */
function recallOf(
  s: LocalState,
  io: typeof import("./local.server.ts"),
  self: string,
  cwd: string,
): Recall {
  const pid = projectOf(self);
  const keys = new Set<string>([
    pid,
    ...panesOf(pid).filter((p) => p.kind === "session").map((p) => p.id),
  ]);
  // A closed chat of this project is still in state until swept.
  for (const [k, c] of Object.entries(s.chats)) {
    if (c.env?.data?.cwd === cwd) keys.add(k);
  }
  const rows: HistRow[] = [];
  const parked: string[] = [];
  for (const k of keys) {
    const c = s.chats[k];
    if (!c) continue;
    if (c.parked) {
      parked.push(k);
      continue;
    }
    for (const m of c.messages) {
      if (k === self && !m.evicted && !m.stubbed && !m.folded) continue;
      rows.push(io.histRow(k, m));
    }
  }
  return { self, rows, parked };
}

/** A conversation leaving state for good (its project removed, its pane long
 *  closed): what it said is kept in the saved record. */
function retire(s: LocalState, id: string): void {
  const c = s.chats[id];
  if (!c) return;
  const cwd = cwdOf(id, c);
  saveRows(id, c.messages, c, cwd);
  if (c.parked) archiveParked(id, cwd);
}

/** A parked conversation that is being deleted: its rows go to the saved
 *  record rather than with it. */
function archiveParked(id: string, cwd: string): void {
  void import("./local.server.ts").then(async (io) => {
    const got = await io.unparkRows(id);
    // The parked file goes only once its rows are safely in the record: it
    // may be the conversation's only copy.
    if ("rows" in got && await io.saveRows(id, cwd, got.rows)) {
      await io.dropParked(id);
    }
  });
}

/**
 * One extra completion that folds dropped rows into the rolling summary.
 *
 * Sized to the window at both ends: what it reads (a third of the window) and
 * how long a memory it may keep (a few hundred words on a small model, a page
 * on a big one). Its own failure never breaks the turn — a mechanical list of
 * what was asked and done stands in for it, which loses the reasoning but
 * keeps every path and command.
 */
async function summarize(
  io: typeof import("./local.server.ts"),
  cfg: LocalConfig,
  ctx: number,
  signal: AbortSignal,
  prev: string,
  dropped: LocalMsg[],
): Promise<string> {
  const tier = tierOf(ctx);
  const words = tier === "tiny" ? 120 : tier === "small" ? 250 : 600;
  const perRow = Math.min(Math.max(Math.floor(ctx * 0.08), 300), 4_000);
  const room = Math.min(Math.max(Math.floor(ctx * 1.2), 3_000), 120_000);
  const text = dropped.map((m) =>
    m.role === "tool"
      ? `[${m.toolName ?? "tool"} result]: ${clip(m.text, perRow, 0.6)}`
      : `${m.role}: ${clip(m.text, perRow, 0.6)}${
        m.toolCalls?.length
          ? "\n" + m.toolCalls.map((c) =>
            `[called ${c.name} ${clip(c.args, 200)}]`
          )
            .join("\n")
          : ""
      }`
  ).join("\n");
  try {
    const acc = newAcc();
    await io.chatStream({
      baseUrl: cfg.baseUrl,
      model: cfg.model,
      messages: [{
        role: "user",
        content: summarizePrompt(prev, clip(text, room, 0.3), words),
      }],
      tools: [],
      signal,
      // Room for a reasoning model to think before it writes the summary.
      maxTokens: Math.min(words * 2 + 4_096, Math.floor(ctx * 0.4)),
      onChunk: (chunk) => foldChunk(acc, chunk),
    });
    const out = splitThink(acc.text).text.trim();
    if (out) return clip(out, words * 9, 0.7);
  } catch (e) {
    if (signal.aborted) throw e;
  }
  return appendLines(prev, mechanicalSummary(dropped));
}

/** What dropped rows amount to without a model to summarize them: the
 *  requests, and the calls with their paths. Deterministic, and never empty
 *  of the facts the next round is most likely to need. */
function mechanicalSummary(dropped: LocalMsg[]): string {
  const lines: string[] = [];
  for (const m of dropped) {
    if (m.role === "user") lines.push(`- user asked: ${clip(m.text, 160)}`);
    for (const c of m.toolCalls ?? []) {
      let what = "";
      try {
        const a = JSON.parse(c.args);
        what = String(a.path ?? a.pattern ?? a.cmd ?? "").slice(0, 120);
      } catch { /* unparseable — the name alone */ }
      lines.push(`- ${c.name}${what ? ` ${what}` : ""}`);
    }
  }
  return lines.slice(-40).join("\n");
}

/** Add lines to a summary, keeping it bounded from the old end. */
function appendLines(prev: string, more: string): string {
  const all = [prev, more].filter(Boolean).join("\n");
  return all.length > 6_000 ? "…\n" + all.slice(-6_000) : all;
}

/* ── reads ────────────────────────────────────────────────────────────────── */

const EMPTY_CONFIG = blankConfig();
const EMPTY_CHAT = blankChat();

export const localConfig = (key: string): LocalConfig =>
  local.configs[key] ?? EMPTY_CONFIG;

export const localChat = (key: string): LocalChat =>
  local.chats[key] ?? EMPTY_CHAT;

/**
 * Every conversation in a project.
 *
 * The dock's dot answers a question about the *project* — "is anything here
 * working, is anything here waiting for me?" — and a project can hold several
 * chats. Asking only the first one would hide a second conversation stopped on
 * a permission prompt, which is the exact case the dot exists for.
 */
export const localChatsOf = (projectId: string): LocalChat[] => {
  const panes = panesOf(projectId).filter((p) => p.kind === "session");
  return panes.length === 0
    ? [local.chats[projectId] ?? EMPTY_CHAT]
    : panes.map((p) => local.chats[p.id] ?? EMPTY_CHAT);
};

/** What runs this project. The one question every Claude-facing module asks. */
export const engineOf = (key: string): Engine => localConfig(key).engine;

/** Is the *active* project on a local engine? The routing question. */
/** Is the conversation on screen answered by a local engine? A project can
 *  hold a Claude chat and a local one at once, so this is a question about the
 *  chat, never about the project. */
export const activeIsLocal = (): boolean =>
  engineOf(activeSessionKey()) !== "claude";

/**
 * Stored engine settings whose project is not in the list any more.
 *
 * The number behind the "forget leftovers" button. Zero for anyone whose app
 * has only ever removed projects through the app itself — {@link
 * local.forgetProjects} is exact — so the button appears only when there is
 * something to press it for.
 */
export const strayConfigs = (): string[] => {
  const known = new Set(workspace.projects.map((p) => p.id));
  return Object.keys(local.configs).filter((id) => !known.has(id));
};

/** What the last scan found on each engine's default port. */
export const detectedEngines = (): EngineProbe[] => local.detected;

/** Just the ones that answered — what the engine switch marks as available. */
export const reachableEngines = (): LocalEngine[] =>
  local.detected.filter((d) => d.reachable).map((d) => d.engine);

/**
 * How fast the local model's last turn produced text, in tokens a second — or
 * `null` when the server did not report enough to say.
 *
 * The same contract as the Claude side's `lastSpeed`: over the whole turn,
 * tool calls and waiting included, because that is what "slow" means to the
 * person who waited.
 */
export const speedOf = (
  turn: { lastMs: number; lastTokens: number },
): number | null => perSecond(turn.lastTokens, turn.lastMs);

export const localSpeed = (key?: string): number | null =>
  speedOf(localChat(key ?? activeSessionKey()));
