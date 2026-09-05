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
  clip,
  destructiveReason,
  explainError,
  foldChunk,
  isNoToolSupport,
  isUnreachable,
  LOCAL_PERMISSIONS,
  newAcc,
  packContext,
  permissionOf,
  REPEATABLE,
  summarizePrompt,
  toolSpecs,
  withCallIds,
} from "../lib/agent.ts";
import type {
  Engine,
  EngineProbe,
  LocalChat,
  LocalConfig,
  LocalEngine,
  LocalMode,
  LocalMsg,
  LocalPermission,
} from "../type/local.ts";
import { panesOf, projectOfPane, workspace } from "./workspace.ts";
import { perSecond } from "../lib/format.ts";

/** Tool-call rounds one user turn may take. A local model that has not
 *  converged after this many acts is looping, not working.
 *
 *  Exported so its tests can be written against the limit rather than against
 *  a number copied out of it — the two drifted apart once already, and a test
 *  that hard-codes a cap fails for the one reason that is not a bug. */
export const MAX_ROUNDS = 1024;
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
  summary: "",
  usedTokens: 0,
  startedAt: 0,
  lastMs: 0,
  lastTokens: 0,
  models: [],
  error: null,
  pending: null,
  toolsOk: null,
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
};

/**
 * Every id below is a *pane* id — one conversation.
 *
 * The two halves of a local project are scoped differently on purpose. A
 * conversation belongs to its pane: a project with three chats has three, and
 * closing one must not take the others with it. The engine, address and model
 * belong to the *project*: they describe one server on this machine, and
 * making the user pick llama.cpp again for every new chat in the same folder
 * would be tedious for no gain.
 *
 * `projectOfPane` maps one to the other, and returns the id unchanged for the
 * first conversation — whose pane id IS the project id.
 */
const projectOf = (id: string): string => projectOfPane(id) || id;
const cfgAt = (s: LocalState, id: string): LocalConfig =>
  s.configs[projectOf(id)] ??= blankConfig();
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

export const local = cell("local", {
  persist: { include: ["configs"] },

  // The loop streams: every await inside `send` is followed by writes the
  // window must see as they happen, not at commit.
  transaction: false,

  /** Nothing this cell started may outlive it: the turn in flight, and the
   *  port scan. A scan has nobody to answer to once the app is going down, and
   *  its requests would hold the process open to say so. */
  onDestroy() {
    void import("./local.server.ts").then((io) => io.cancelScan()).catch(
      () => {},
    );
  },

  state: {
    configs: {} as Record<string, LocalConfig>,
    chats: {} as Record<string, LocalChat>,
    cleared: {} as Record<string, LocalMsg[]>,
    detected: [] as EngineProbe[],
    detecting: false,
    detectedAt: 0,
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

    setBaseUrl(s: LocalState, key: string, url: string) {
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
      cfgAt(s, key).model = model;
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
      const cfg = local.configs[projectOf(key)];
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
      const cfg = local.configs[projectOf(key)];
      if (!cfg || cfg.engine === "claude" || !cfg.baseUrl) return;
      const engine = cfg.engine as LocalEngine;
      const { baseUrl } = cfg;
      try {
        const io = await import("./local.server.ts");
        // The method's own abort, threaded to the socket: a probe must not
        // outlive the app, or the harness waiting for it to go quiet.
        const ok = await io.probeTools(engine, baseUrl, s.$signal);
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
      const cfg = s.configs[projectOf(key)];
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
        ? local.configs[projectOf(key)]
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
      const cfg = s.configs[projectOf(key)];
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
      for (const key of keys) io.stopRun(key);
      await local.dropProjects(keys); // aiol-ok: orchestration, see `detect`
    },

    dropProjects(s: LocalState, keys: string[]) {
      for (const key of keys) {
        delete s.configs[key];
        delete s.chats[key];
      }
    },

    /**
     * Drop stored configuration for anything that is not a known project.
     *
     * The garbage collector for the persisted half. Removals go through
     * `forgetProjects`, but state written before that existed — or under a key
     * no project ever had — is only findable by comparing the two lists, which
     * is what this does, once, when the workspace is settled.
     *
     * The project list is read HERE, not passed in. A caller that snapshots the
     * ids and dispatches this deletes the configuration of any project added
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
      const known = new Set(workspace.projects.map((p) => p.id));
      const stale = Object.keys(s.configs).filter((id) => !known.has(id));
      // Conversations are keyed by pane, so they are swept against the panes
      // — but only when the pane resolves to *some* project. An id that
      // resolves to nothing is not proof of garbage: `panes` is filled in
      // lazily, and a chat deleted here would be a conversation deleted from
      // under someone who is reading it. Configuration is persisted and can
      // afford to be strict; a chat is not, and cannot.
      const orphans = Object.keys(s.chats).filter((key) => {
        const owner = projectOfPane(key);
        return owner !== "" && !known.has(owner);
      });
      if (stale.length === 0 && orphans.length === 0) return;
      for (const id of stale) delete s.configs[id];
      for (const key of [...stale, ...orphans]) delete s.chats[key];
      log.info("local", "dropped config for unknown projects", {
        count: stale.length,
        chats: orphans.length,
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

    /** One user turn: the whole agent loop, from packing to the final text.
     *
     *  Every write goes through `chatAt(s, id)` freshly — nested drafts do not
     *  survive an await in a non-transactional method, only the root `s` stays
     *  live, and a stale reference loses the write silently
     *  (dep/aio/docs/state/methods.md; reported in dep/aio/feedback/cc.md). */
    async send(s: LocalState, text: string, key?: string) {
      const id = key ?? workspace.activeId;
      // Config is read once into plain values — it is not written below.
      const cfg = { ...cfgAt(s, id) };
      // The project's directory, not the pane's — `id` is one conversation,
      // and every conversation in a project works in the same folder.
      const owner = projectOf(id);
      const cwd = workspace.projects.find((p) => p.id === owner)?.path ?? "";
      if (cfg.engine === "claude" || !text.trim()) return;
      if (chatAt(s, id).status === "working") return; // one turn at a time
      if (!cfg.model) {
        chatAt(s, id).error =
          "Pick a model first (refresh the list if it is empty).";
        return;
      }

      {
        const c = chatAt(s, id);
        c.status = "working";
        c.startedAt = Date.now();
        c.error = null;
        // Saying something new ends the window in which the last Clear can be
        // undone — and lets go of the transcript it was holding.
        delete s.cleared[id];
        c.messages.push(msg("user", text));
        cap(c.messages);
      }

      const io = await import("./local.server.ts");
      const signal = io.beginRun(id);
      // Identical read-only calls, answered once. A model that has lost the
      // thread repeats the same `ls` until the round limit runs out; the
      // answer does not change, so the round buys nothing. Anything that
      // writes clears this — after a write or a command, the same read is a
      // different question.
      const seen = new Map<string, string>();
      try {
        for (let round = 0; round < MAX_ROUNDS; round++) {
          // Mode is re-read every round, not snapshotted with the rest of the
          // config: dropping from agent to read-only mid-turn is a security
          // action, and it must bite on the very next call.
          const mode = cfgAt(s, id).mode;
          // Pack, and fold anything that fell off into the rolling summary
          // *before* the request — the model must never just lose the past.
          let packed = packContext(
            chatAt(s, id).messages,
            { ctx: cfg.ctx, mode },
            chatAt(s, id).summary,
            cwd,
          );
          if (packed.evict.length) {
            const dropped = chatAt(s, id).messages
              .filter((m) => packed.evict.includes(m.id))
              .map((m) => `${m.role}: ${clip(m.text, 500)}`)
              .join("\n");
            for (const m of chatAt(s, id).messages) {
              if (packed.evict.includes(m.id)) m.evicted = true;
            }
            const summary = await summarize(
              io,
              cfg,
              signal,
              chatAt(s, id).summary,
              dropped,
            );
            chatAt(s, id).summary = summary;
            packed = packContext(
              chatAt(s, id).messages,
              { ctx: cfg.ctx, mode },
              summary,
              cwd,
            );
          }

          // The last round asks for words, not another call. Running out of
          // rounds used to end the turn with an error and no answer, which is
          // the worst of both: the work was done and thrown away. A model one
          // call short of an answer almost always has what it needs already.
          const lastRound = round === MAX_ROUNDS - 1;
          if (lastRound) {
            chatAt(s, id).error = `Reached the ${MAX_ROUNDS}-round tool limit` +
              ` for one turn — this answer was written without tools.`;
          }

          const acc = newAcc();
          chatAt(s, id).streaming = "";
          // Coalesce the on-screen update to ~11 fps rather than writing on
          // every token: each write re-renders the whole reply through the
          // Markdown parser and patches the full string over IPC, so per-chunk
          // updates are O(n²) in the reply length. The Claude path throttles
          // the same traffic for the same reason (claude.server.ts DELTA_FLUSH).
          let lastPaint = 0;
          await io.chatStream({
            baseUrl: cfg.baseUrl,
            model: cfg.model,
            messages: packed.wire,
            tools: lastRound ? [] : toolSpecs(mode),
            signal,
            onChunk: (chunk) => {
              foldChunk(acc, chunk);
              const now = Date.now();
              if (now - lastPaint >= 90) {
                lastPaint = now;
                chatAt(s, id).streaming = acc.text;
              }
            },
          });
          {
            const c = chatAt(s, id);
            c.usedTokens = acc.promptTokens ?? packed.tokens;
            // Only when the server reported a completion count. Dividing a
            // character count by seconds would produce a plausible-looking
            // number that is wrong by whatever this model's tokeniser does.
            if (acc.completionTokens !== null && c.startedAt > 0) {
              c.lastMs = Date.now() - c.startedAt;
              c.lastTokens = acc.completionTokens;
            }
            // The complete reply goes into the pushed message below; the live
            // streaming buffer is cleared (the last throttled paint may be a
            // few tokens short, and the message is the source of truth).
            c.streaming = "";
          }

          // On the last round no tools were offered, so none are run — a
          // server that sends them anyway does not get to spend a round the
          // turn no longer has.
          const calls = lastRound ? [] : withCallIds(
            acc.toolCalls.filter((c) => c.name),
            round,
          );
          if (calls.length === 0) {
            // A reply stopped by the output limit ends mid-sentence, and
            // nothing on screen says so — it just reads as a model that lost
            // its train of thought.
            if (acc.finish === "length" && !lastRound) {
              chatAt(s, id).error =
                "The reply hit the model's output limit and stopped" +
                " mid-sentence. Ask for less at a time, or raise the limit" +
                " on the server.";
            }
            chatAt(s, id).messages.push(msg("assistant", acc.text));
            cap(chatAt(s, id).messages);
            break;
          }

          chatAt(s, id).messages.push(
            msg("assistant", acc.text, { toolCalls: calls }),
          );
          // Capped here as well as after the tool results below. Every push
          // has to be followed by one: a cap applied at only some of them lets
          // the transcript sit one row over its limit forever, which is how a
          // bound stops being a bound.
          cap(chatAt(s, id).messages);
          for (const call of calls) {
            // A command is the one act this agent cannot confine to the
            // project, so it is the one act that asks. Everything else — list,
            // read, search, write — resolves its path inside the project
            // directory and needs no permission beyond the mode.
            const held = await approveCommand(s, io, id, call, signal);
            if (held !== null) {
              chatAt(s, id).messages.push(msg("tool", held, {
                toolCallId: call.id,
                toolName: call.name,
              }));
              continue;
            }
            const key = `${call.name}\u0000${call.args}`;
            const already = REPEATABLE.has(call.name)
              ? seen.get(key)
              : undefined;
            let result: string;
            if (already !== undefined) {
              result = `${already}\n\n[Identical to an earlier call in this` +
                ` turn — the same result, not run again. Use it, or try` +
                ` something different.]`;
            } else {
              result = await io.runTool(
                cfgAt(s, id).mode, // live — see the round-top comment
                cwd,
                call.name,
                call.args,
                signal,
              );
              if (REPEATABLE.has(call.name)) seen.set(key, result);
              // A write or a command changes what every read would say.
              else seen.clear();
            }
            chatAt(s, id).messages.push(msg("tool", result, {
              toolCallId: call.id,
              toolName: call.name,
            }));
          }
          cap(chatAt(s, id).messages);
        }
      } catch (e) {
        if (signal.aborted) {
          // Only into a conversation that still exists: an abort can also
          // mean `clear()`, and the marker must not resurrect a wiped chat.
          if (chatAt(s, id).messages.length > 0) {
            chatAt(s, id).messages.push(msg("assistant", "*(stopped)*"));
            cap(chatAt(s, id).messages);
          }
        } else {
          const raw = e instanceof Error ? e.message : String(e);
          const c = chatAt(s, id);
          // A server that refuses tools has just answered the question
          // `autoTools` asks — record it, so the page keeps saying so after
          // the error is dismissed.
          if (isNoToolSupport(raw)) c.toolsOk = false;
          // The scan's answer is part of the error message: when the saved
          // address is dead and this engine is answering somewhere else, the
          // app already knows where, and saying so is the difference between a
          // dead end and one click.
          // aiol-ok: live reads, deliberately — the address this turn actually
          // failed against and the scan's newest answer are both facts about
          // NOW, and this cell publishes as it goes (transaction: false).
          const cfg = cfgAt(s, id);
          c.error = explainError(raw, {
            baseUrl: cfg.baseUrl,
            engine: cfg.engine,
            // aiol-ok: the scan's newest answer, on purpose
            found: s.detected.find((d) =>
              d.engine === cfg.engine && d.reachable
            )?.baseUrl ?? null,
          });
          log.error("local", "turn failed", { key: id, error: raw });
          // A dead address is the one failure the app can answer by itself:
          // look, and the banner offers whatever answered. Without this the
          // offer only appeared if somebody had already opened Settings and
          // pressed Scan — which is the trip the offer exists to save.
          if (isUnreachable(raw)) void local.detect(); // aiol-ok: orchestration
        }
      } finally {
        io.endRun(id, signal); // only this run's own registration
        const c = chatAt(s, id);
        c.status = "idle";
        c.startedAt = 0;
        c.streaming = "";
        // A question outlives nothing: the turn that asked it is over.
        c.pending = null;
      }
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
    ) {
      const chat = chatAt(s, key);
      if (!chat.pending) return;
      // "…and stop asking" promotes to the *guarded* mode, not to Bypass.
      // The old two-valued field had nowhere else to go; now there is a mode
      // that means what the button says — stop interrupting me — without also
      // meaning "and delete whatever you like".
      if (allowed && always) cfgAt(s, key).permission = "dontAsk";
      chat.pending = null;
      const io = await import("./local.server.ts");
      io.answerApproval(key, allowed);
    },

    /** The question, and its withdrawal — sync, so neither rides on the long
     *  `send` draft. `pending` is what the page renders the prompt from, so a
     *  lost write here is a turn parked on a question nobody can see. */
    askCommand(s: LocalState, key: string, id: string, cmd: string) {
      chatAt(s, key).pending = { id, cmd, at: Date.now() };
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
      cfgAt(s, key).permission = next;
      // The field this replaced is left behind rather than carried forward: a
      // stale "always" outliving a switch back to Ask would be read by
      // `permissionOf` on the next boot as Bypass.
      delete cfgAt(s, key).shApproval;
      log.info("local", "permission set", { key, mode: next });
    },

    /** Abort the in-flight turn. The loop's own catch writes the outcome. */
    async stop(s: LocalState, key?: string) {
      const id = key ?? workspace.activeId;
      if (chatAt(s, id).status !== "working") return;
      const io = await import("./local.server.ts");
      io.stopRun(id);
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
      const id = key ?? workspace.activeId;
      if (chatAt(s, id).status === "working") {
        const io = await import("./local.server.ts");
        io.stopRun(id);
      }
      const before = chatAt(s, id).messages;
      s.chats[id] = blankChat();
      if (before.length > 0) s.cleared[id] = before;
    },

    /** Put back what the last clear took away. Refused once anything new has
     *  been said: this is an undo for the moment right after, not a merge. */
    undoClear(s: LocalState, key?: string) {
      const id = key ?? workspace.activeId;
      const kept = s.cleared[id] ?? [];
      const chat = chatAt(s, id);
      if (kept.length === 0 || chat.messages.length > 0) return;
      chat.messages = kept;
      delete s.cleared[id];
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
async function approveCommand(
  s: LocalState,
  io: typeof import("./local.server.ts"),
  id: string,
  call: { id: string; name: string; args: string },
  signal: AbortSignal,
): Promise<string | null> {
  if (call.name !== "sh") return null;
  // The mode gate comes first, always. Asking about a call the executor is
  // going to refuse anyway would park the turn on a question whose only honest
  // answer changes nothing — and in read-only mode there is no `sh` to allow.
  if (!allowedTools(cfgAt(s, id).mode).includes(call.name)) return null;
  const permission = permissionOf(cfgAt(s, id));
  if (permission === "bypass") return null;
  let cmd = "";
  try {
    const parsed = JSON.parse(call.args || "{}");
    cmd = typeof parsed?.cmd === "string" ? parsed.cmd : "";
  } catch { /* unparseable arguments are the executor's to reject */ }
  if (!cmd) return null;

  // "Don't ask" is not "anything goes": nobody is watching, so the commands
  // whose damage cannot be undone by reading the transcript afterwards are
  // refused instead of run. The refusal is written for the model — it is in
  // the loop, and a precise no is what makes it try something else — and it
  // names the mode that would have allowed it, so the *user* reading the
  // transcript knows exactly which switch to move.
  if (permission === "dontAsk") {
    const why = destructiveReason(cmd);
    if (why === null) return null;
    log.info("local", "command refused by the guardrail", {
      key: id,
      why,
    });
    return `Error: refused without asking — ${why}. This project runs in` +
      ` "Don't ask" mode, which runs ordinary commands but not destructive` +
      ` ones. Do it a way that does not destroy anything, or tell the user to` +
      ` switch to Ask (to approve it once) or Bypass (to turn checks off).`;
  }

  // Through sync methods, not this draft: `send` is the longest method in the
  // app and `pending` is what the page renders the prompt from. A write lost
  // to the draft hazard here is a turn parked forever on a question nobody can
  // see — see the note on `local.detect`.
  await local.askCommand(id, call.id, cmd); // aiol-ok: orchestration
  const allowed = await io.awaitApproval(id, signal);
  await local.clearPending(id); // aiol-ok: orchestration
  if (allowed) return null;
  log.info("local", "command refused", { key: id, chars: cmd.length });
  return signal.aborted
    ? "Stopped."
    : "Error: the user did not allow that command to run. " +
      "Explain what it would have done, or try something that does not need a shell.";
}

function cap(list: LocalMsg[]): void {
  if (list.length > MAX_LOCAL_MESSAGES) {
    list.splice(0, list.length - MAX_LOCAL_MESSAGES);
  }
}

/** One small extra completion that folds dropped rows into the summary. Its
 *  own failure must never break the turn — the stub line is the fallback. */
async function summarize(
  io: typeof import("./local.server.ts"),
  cfg: LocalConfig,
  signal: AbortSignal,
  prev: string,
  dropped: string,
): Promise<string> {
  try {
    const acc = newAcc();
    await io.chatStream({
      baseUrl: cfg.baseUrl,
      model: cfg.model,
      messages: [{
        role: "user",
        content: summarizePrompt(prev, clip(dropped, 4_000)),
      }],
      tools: [],
      signal,
      onChunk: (chunk) => foldChunk(acc, chunk),
    });
    return clip(acc.text.trim(), 1_200) || prev;
  } catch {
    return (prev ? prev + " " : "") + "[earlier details dropped]";
  }
}

/* ── reads ────────────────────────────────────────────────────────────────── */

const EMPTY_CONFIG = blankConfig();
const EMPTY_CHAT = blankChat();

export const localConfig = (key: string): LocalConfig =>
  local.configs[projectOf(key)] ?? EMPTY_CONFIG;

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
export const activeIsLocal = (): boolean =>
  engineOf(workspace.activeId) !== "claude";

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
  speedOf(localChat(key ?? workspace.activeId));
