/**
 * @module
 * The conversation page for a project on a local engine (LM Studio, Ollama,
 * llama.cpp server) — the local twin of ChatPage, sharing the design system
 * and Markdown renderer but none of the Claude session machinery.
 *
 * The strip above the thread carries what a small-context model lives and
 * dies by: which model, which mode, and how full the window is.
 */
import { afterRender, onMount, useLocal, useRef, type VNode } from "aio/air";
import { Markdown } from "./Markdown.tsx";
import {
  DEFAULT_URLS,
  detectedEngines,
  local,
  localChat,
  localConfig,
} from "../cell/local.ts";
import { LOCAL_PERMISSIONS, permissionOf } from "../lib/agent.ts";
import { workspace } from "../cell/workspace.ts";
import type { LocalMode, LocalMsg } from "../type/local.ts";
import { clock, modelLabel, tailPath, tokens } from "../lib/format.ts";
import {
  Banner,
  Choice,
  Empty,
  Menu,
  Meter,
  Pill,
  Segmented,
} from "./parts.tsx";
import {
  IconAlert,
  IconChevron,
  IconLogo,
  IconRefresh,
  IconSend,
  IconShield,
  IconStop,
  IconUser,
  toolIcon,
} from "./icons.tsx";

export const ENGINE_NAMES: Record<string, string> = {
  lmstudio: "LM Studio",
  ollama: "Ollama",
  llamacpp: "llama.cpp",
};

/** One row of a model menu: the readable name, with the id it stands for
 *  underneath. A GGUF path is unreadable as a label and still the only way to
 *  tell two quantisations of the same model apart — so it is shown as the
 *  hint rather than dropped. */
const modelOption = (m: string) => {
  const label = modelLabel(m);
  return { id: m, label, hint: label === m ? undefined : tailPath(m, 54) };
};

const MODES: { id: LocalMode; label: string }[] = [
  { id: "chat", label: "Chat" },
  { id: "read", label: "Read-only" },
  { id: "agent", label: "Agent" },
];

/** The engine switch's options, Claude Code included — switching back is the
 *  same control as switching away, and hiding it here would strand a project
 *  on a local engine with no way home but Settings. */
const ENGINE_OPTIONS = [
  { id: "claude", label: "Claude Code", hint: "The CLI, with every feature" },
  { id: "lmstudio", label: "LM Studio", hint: "Local · not detected" },
  { id: "ollama", label: "Ollama", hint: "Local · not detected" },
  { id: "llamacpp", label: "llama.cpp", hint: "Local · not detected" },
] as const;

export function LocalChatPage(): VNode {
  const id = workspace.activeId;
  const cfg = localConfig(id);
  const chat = localChat(id);
  const ref = useRef<HTMLDivElement>(null!);
  const stick = useRef(true);

  // Follow the stream only while the reader is already at the bottom — same
  // contract as the Claude thread.
  afterRender(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  });
  const onScroll = () => {
    const el = ref.current;
    if (!el) return;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 140;
  };

  return (
    <div class="page">
      <LocalStrip />
      <div class="chat" ref={ref} onScroll={onScroll}>
        <div class="thread">
          <NoToolsBanner />
          {chat.error && (
            <Banner tone="warn">
              {chat.error}
              {
                /* An error a reader can act on, from the page they are already
                  on. A saved address that has gone dead is the commonest local
                  failure there is, and the scan usually already knows where the
                  server actually is — so the fix is a button, not a trip to
                  Settings to retype a port. */
              }
              <UnreachableFix />
            </Banner>
          )}
          {chat.messages.length === 0 && !chat.streaming
            ? (
              <Empty
                icon={IconLogo({ size: 20 })}
                title={`${ENGINE_NAMES[cfg.engine] ?? cfg.engine} · ${
                  modelLabel(cfg.model) || "no model"
                }`}
                hint={!cfg.model
                  ? "Refresh the model list above, or check the server address in Settings."
                  : /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])([:/]|$)/
                      .test(cfg.baseUrl)
                  ? "Everything runs on your machine. Pick a mode above and say what you need."
                  : `Conversations go to ${cfg.baseUrl}. Pick a mode above and say what you need.`}
              />
            )
            : chat.messages.map((m) => <Row key={m.id} m={m} />)}
          {chat.streaming && (
            <article class="msg">
              <div class="msg__avatar msg__avatar--assistant">
                {IconLogo({ size: 15 })}
              </div>
              <div class="msg__body">
                <div class="msg__who" title={cfg.model}>
                  {modelLabel(cfg.model) || "model"}
                </div>
                <div class="bubble">
                  <Markdown source={chat.streaming} />
                </div>
              </div>
            </article>
          )}
        </div>
      </div>
      <CommandPrompt />
      <LocalComposer />
    </div>
  );
}

/* ── the one thing that asks ──────────────────────────────────────────────── */

/**
 * The held command, above the composer.
 *
 * `sh` is the only tool here that cannot be confined to the project directory:
 * the file tools resolve every path inside it, symlinks included, and a shell
 * command cannot be bounded that way without claiming a sandbox this app does
 * not have. So it is bounded the honest way instead — the exact command, in
 * full, before it runs, with somebody deciding.
 *
 * Placed here rather than inline in the transcript for the same reason as the
 * Claude prompt: the turn is *blocked*, and a question that scrolls away is a
 * conversation that has quietly stopped.
 */
function CommandPrompt(): VNode | null {
  const id = workspace.activeId;
  const pending = localChat(id).pending;
  const card = useRef<HTMLElement>(null!);
  // Same contract as the Claude prompt: the CARD takes focus when it appears,
  // never a button. A blocked turn a keyboard user has to Tab across the page
  // to reach is a blocked turn — and focusing "Run it" would arm Enter to say
  // yes, which is the one thing an approval must never do.
  onMount(() => card.current?.focus());
  if (!pending) return null;

  return (
    <div class="perm__queue">
      <section
        ref={card}
        class="perm"
        role="alertdialog"
        tabIndex={-1}
        aria-label="Approve running a command"
      >
        <div class="perm__head">
          <span class="perm__icon">{IconShield({ size: 15 })}</span>
          <span class="perm__title">
            Run a command in{" "}
            {workspace.projects.find((p) => p.id === id)?.name ??
              "this project"}?
          </span>
          <span style={{ flex: 1 }} />
          <span class="perm__wait">the turn is waiting</span>
        </div>
        <div class="perm__body">
          {
            /* Verbatim, wrapped, never truncated: the whole reason to ask is
              that the reader can see exactly what would run. */
          }
          <pre class="perm__cmd">{pending.cmd}</pre>
          <div class="perm__why">
            {IconAlert({ size: 13 })}
            <span>
              It runs as you, with your own permissions. The project directory
              is where it starts, not a wall around it — every other tool here
              is confined to it, this one cannot be.
            </span>
          </div>
          <div class="perm__actions">
            <button
              type="button"
              class="btn btn--sm btn--primary"
              onClick={() => void local.answer(id, true)}
            >
              Run it
            </button>
            <button
              type="button"
              class="btn btn--sm"
              title="Stop asking for this project — destructive commands are still refused. The strip above and Settings both put it back."
              onClick={() => void local.answer(id, true, true)}
            >
              Run it, and stop asking
            </button>
            <button
              type="button"
              class="btn btn--sm btn--danger"
              onClick={() => void local.answer(id, false)}
            >
              Refuse
            </button>
            <span style={{ flex: 1 }} />
            <span class="perm__hint">
              Refusing tells the model why, so it can try another way.
            </span>
          </div>
        </div>
      </section>
    </div>
  );
}

/* ── strip ────────────────────────────────────────────────────────────────── */

/** Model, mode and window pressure — small on purpose: it must never cost
 *  more attention than the conversation under it. */
function LocalStrip(): VNode {
  const id = workspace.activeId;
  const cfg = localConfig(id);
  const chat = localChat(id);
  // Agent mode arms and asks, like Allow-all on the Claude side: it lets the
  // model run arbitrary commands as you, and that grant persists with the
  // project — one accidental click must not be how it happens.
  const [armAgent, setArmAgent] = useLocal(false);

  return (
    <div
      style={{
        display: "flex",
        gap: "10px",
        alignItems: "center",
        flexWrap: "wrap",
        padding: "10px 22px",
        borderBottom: "1px solid var(--line)",
      }}
    >
      {
        /* Both switchers live here rather than only in Settings. Engine and
          model are the two choices a local session is actually steered by —
          the wrong one is discovered mid-conversation, and the fix belongs
          where the discovery happens. Switching back to Claude Code from here
          keeps this conversation exactly as it is. */
      }
      <Menu
        label="Engine"
        value={cfg.engine}
        title="What runs this project"
        onOpen={() => void local.detect()}
        options={ENGINE_OPTIONS.map((e) => ({
          id: e.id,
          label: e.label,
          hint: e.id === "claude"
            ? e.hint
            : detectedEngines().find((d) => d.engine === e.id)?.reachable
            ? "Running now"
            : e.hint,
          trailing: e.id !== "claude" &&
              detectedEngines().find((d) => d.engine === e.id)?.reachable
            ? <span class="dot dot--ready" />
            : null,
        }))}
        // Chained, not fired side by side. A dispatch that has not committed
        // is not visible to the next one, so `syncEngine` could read the
        // engine the project was on a moment ago and refresh nothing.
        onChange={(v) =>
          void local.setEngine(id, v).then(() =>
            v === "claude" ? undefined : local.syncEngine(id)
          )}
      />

      {
        /* Held at its natural width up to a cap: the model name is the one
          value on this strip that is read rather than glanced at, and a flex
          row will happily ellipse it while leaving empty space to its right. */
      }
      <span
        class="modelmenu"
        style={{ flex: "none", width: "max-content", maxWidth: "24em" }}
      >
        <Menu
          label="Model"
          value={cfg.model}
          title="Model this conversation runs on"
          trigger={
            <span class="truncate" title={cfg.model}>
              {modelLabel(cfg.model) || "no model"}
            </span>
          }
          options={(chat.models.length
            ? chat.models
            : [cfg.model].filter(Boolean))
            .map(modelOption)}
          onChange={(m) => void local.setModel(id, m)}
          footer={chat.models.length === 0
            ? "No models listed — check the server address in Settings."
            : `${chat.models.length} loaded on the server`}
        />
      </span>
      <button
        type="button"
        class="btn btn--ghost btn--sm btn--icon"
        aria-label="Refresh models"
        title="Re-read the model list from the server"
        onClick={() => void local.syncEngine(id)}
      >
        {IconRefresh({ size: 13 })}
      </button>

      {chat.toolsOk === false && (
        <span title="This server refuses tool calls — only Chat can work until it is restarted with Jinja templating on">
          <Pill tone="danger">{IconAlert({ size: 11 })} no tools</Pill>
        </span>
      )}

      <Segmented
        value={cfg.mode}
        options={MODES}
        onChange={(v) => {
          if (v === "agent" && cfg.mode !== "agent") {
            setArmAgent(true);
            return;
          }
          setArmAgent(false);
          local.setMode(id, v);
        }}
      />
      {armAgent && (
        <span style={{ display: "flex", gap: "6px", alignItems: "center" }}>
          <span class="field__hint">
            Agent mode lets the model write files in this project, and ask to
            run commands. Every command is shown in full before it runs.
          </span>
          <button
            type="button"
            class="btn btn--sm btn--danger"
            onClick={() => {
              setArmAgent(false);
              local.setMode(id, "agent");
            }}
          >
            Enable agent mode
          </button>
        </span>
      )}
      {cfg.mode === "agent" && (() => {
        const perm = permissionOf(cfg);
        if (perm === "ask") {
          return (
            <span title="Writes files itself; asks before running a command">
              <Pill tone="warn">can write files</Pill>
            </span>
          );
        }
        // Both unasked modes get a one-click way back to being asked — the
        // point of a badge that says what is switched off is that the switch
        // is where you read about it.
        return (
          <button
            type="button"
            class="btn btn--ghost btn--sm"
            title={perm === "bypass"
              ? "Every command runs, with no checks at all. Click to be asked again."
              : "Commands run without asking; destructive ones are refused. Click to be asked again."}
            onClick={() => local.setPermission(id, "ask")}
          >
            <Pill tone={perm === "bypass" ? "danger" : "warn"}>
              {IconAlert({ size: 11 })}{" "}
              {perm === "bypass" ? "no checks" : "runs commands unasked"}
            </Pill>
          </button>
        );
      })()}

      <span
        style={{ marginLeft: "auto", minWidth: "170px" }}
        title={`Estimated context use against the ${
          tokens(cfg.ctx)
        }-token window set in Settings`}
      >
        <span class="field__hint">
          Context {tokens(chat.usedTokens)} / {tokens(cfg.ctx)}
        </span>
        <Meter value={chat.usedTokens} max={cfg.ctx} />
      </span>
    </div>
  );
}

/**
 * The one-click half of an "nothing answered there" error.
 *
 * Offers the address the scan found for this engine when it differs from the
 * configured one; offers the scan itself when nothing has looked yet. Renders
 * nothing at all when the configured address is the one that answers — then the
 * error is about something else and a button would be a wrong guess.
 */
function UnreachableFix(): VNode | null {
  const id = workspace.activeId;
  const cfg = localConfig(id);
  const found =
    detectedEngines().find((d) => d.engine === cfg.engine && d.reachable)
      ?.baseUrl ?? null;
  if (found === cfg.baseUrl) return null;

  return (
    <span style={{ marginLeft: "8px", display: "inline-flex", gap: "6px" }}>
      {found
        ? (
          <button
            type="button"
            class="btn btn--sm"
            title={`Point this project at ${found}`}
            onClick={() => {
              local.setBaseUrl(id, found);
              void local.refreshModels(id);
            }}
          >
            Use {found}
          </button>
        )
        : (
          <button
            type="button"
            class="btn btn--sm"
            title="Look for a local server on the usual ports"
            disabled={local.detecting}
            onClick={() => void local.detect()}
          >
            {local.detecting ? "Looking…" : "Scan for servers"}
          </button>
        )}
    </span>
  );
}

/**
 * The server can chat but cannot run tools.
 *
 * Only llama.cpp reaches this, and only when its Jinja templating is off: it
 * then serves models, answers chats, and refuses every request carrying tool
 * schemas. Left unexplained the app looks half-broken — the agent "does
 * nothing" — when the fix is one launch flag. So it is named, in full, with
 * the command to copy.
 *
 * Which flag depends on the build: templating is ON by default now (and
 * `--no-jinja` is what turns it off), while an older `llama-server` needed
 * `--jinja` to turn it on. Both are named, because the app cannot tell from
 * here which one the user is running.
 */
function NoToolsBanner(): VNode | null {
  const id = workspace.activeId;
  const chat = localChat(id);
  const cfg = localConfig(id);
  if (chat.toolsOk !== false) return null;
  const cmd = "llama-server --jinja -m your-model.gguf";
  return (
    <Banner tone="warn">
      This llama.cpp server has the Jinja templating that tool calls need turned
      off, so Read-only and Agent modes cannot work against it — only Chat.
      Current builds have it on unless <code>--no-jinja</code>{" "}
      was passed; an older one needs <code>--jinja</code>:{" "}
      <code class="perm__cmd" style={{ display: "inline", padding: "1px 5px" }}>
        {cmd}
      </code>{" "}
      <button
        type="button"
        class="btn btn--ghost btn--sm"
        title="Copy the command"
        onClick={() => void navigator.clipboard?.writeText(cmd)}
      >
        Copy
      </button>{" "}
      <button
        type="button"
        class="btn btn--sm"
        title="Ask the server again — after restarting it"
        onClick={() => void local.autoTools(id)}
      >
        Check again
      </button>
      {cfg.mode !== "chat" && " Until then, switch the mode to Chat."}
    </Banner>
  );
}

/* ── thread ───────────────────────────────────────────────────────────────── */

function Row(props: { m: LocalMsg }): VNode {
  const m = props.m;
  if (m.role === "tool") return <ToolResult m={m} />;
  const user = m.role === "user";
  return (
    <article
      class="msg"
      style={m.evicted ? { opacity: 0.55 } : undefined}
      title={m.evicted
        ? "No longer in the model's context — folded into the running summary"
        : undefined}
    >
      <div class={`msg__avatar msg__avatar--${user ? "user" : "assistant"}`}>
        {user ? IconUser({ size: 15 }) : IconLogo({ size: 15 })}
      </div>
      <div class="msg__body">
        <div class="msg__who">
          {user ? "You" : "Model"}
          <span style={{ color: "var(--ink-dim)", fontWeight: 500 }}>
            {"  "}
            {clock(m.at)}
          </span>
        </div>
        {m.text.trim() !== "" && (
          <div class="bubble">
            {user ? m.text : <Markdown source={m.text} />}
          </div>
        )}
        {m.toolCalls?.map((c) => (
          <div key={c.id || c.name} class="toolchip" style={{ cursor: "auto" }}>
            <span class="toolchip__icon">{toolIcon(c.name, 14)}</span>
            <span class="truncate">
              <span class="toolchip__name">{c.name}</span>{" "}
              <span class="toolchip__title">
                {c.args.length > 120 ? c.args.slice(0, 120) + "…" : c.args}
              </span>
            </span>
          </div>
        ))}
      </div>
    </article>
  );
}

/** A tool result, folded — the model needed it; the reader mostly does not. */
function ToolResult(props: { m: LocalMsg }): VNode {
  const [open, setOpen] = useLocal(false);
  const m = props.m;
  return (
    <div style={m.evicted ? { opacity: 0.55 } : undefined}>
      <button
        type="button"
        class="toolchip"
        aria-expanded={open}
        aria-label={`${m.toolName ?? "tool"} result`}
        onClick={() => setOpen(!open)}
      >
        <span class="toolchip__icon">
          <span
            style={{
              display: "inline-block",
              transform: open ? "rotate(90deg)" : "none",
            }}
          >
            {IconChevron({ size: 12 })}
          </span>
        </span>
        <span class="truncate">
          <span class="toolchip__name">{m.toolName ?? "tool"}</span>{" "}
          <span class="toolchip__title">result · {m.text.length} chars</span>
        </span>
      </button>
      {open && <div class="code">{m.text}</div>}
    </div>
  );
}

/* ── composer ─────────────────────────────────────────────────────────────── */

function LocalComposer(): VNode {
  const ref = useRef<HTMLTextAreaElement>(null!);
  const [hasText, setHasText] = useLocal(false);
  const id = workspace.activeId;
  const chat = localChat(id);
  const busy = chat.status === "working";

  const submit = () => {
    const el = ref.current;
    if (!el || busy) return;
    const text = el.value;
    if (!text.trim()) return;
    el.value = "";
    setHasText(false);
    void local.send(text, id);
  };

  return (
    <div class="composer">
      <div class="composer__inner">
        <textarea
          ref={ref}
          rows={1}
          placeholder={busy
            ? "The model is working…"
            : "Message the local model…"}
          aria-label="Message the local model"
          onInput={() =>
            setHasText((ref.current?.value.trim().length ?? 0) > 0)}
          onKeyDown={(e: KeyboardEvent) => {
            if (e.key !== "Enter" || e.shiftKey) return;
            if (e.isComposing || e.keyCode === 229) return; // IME accept
            e.preventDefault();
            submit();
          }}
        />
        <div class="composer__bar">
          <span class="composer__hint">
            <span class="kbd">Enter</span> to send ·{" "}
            <span class="kbd">Shift</span>+<span class="kbd">Enter</span>{" "}
            for a new line
          </span>
          {busy && (
            <button
              type="button"
              class="btn btn--sm btn--danger"
              onClick={() => void local.stop(id)}
              title="Abort the current turn"
            >
              {IconStop({ size: 13 })} Stop
            </button>
          )}
          <button
            type="button"
            class="btn btn--primary btn--sm"
            disabled={!hasText || busy}
            onClick={submit}
          >
            {IconSend({ size: 14 })} Send
          </button>
        </div>
      </div>
    </div>
  );
}

/* ── settings panel (rendered by SettingsPage) ────────────────────────────── */

/** The engine switch, in Settings with the other per-project choices. Lives in
 *  this module so SettingsPage's only knowledge of local engines is one
 *  component name. */
export function EnginePanel(): VNode {
  const id = workspace.activeId;
  const cfg = localConfig(id);
  const chat = localChat(id);
  const found = detectedEngines();
  const live = found.filter((d) => d.reachable);
  // Opening this panel *is* the request to know what is running. Scanning here
  // rather than at boot keeps the app from touching three ports nobody asked
  // about, and still means the switch below is already answered when you
  // arrive at it.
  onMount(() => {
    void local.detect();
    // The scan only knows the three default ports; a server moved to another
    // one is still this project's server, and the same question applies.
    if (cfg.engine !== "claude") void local.autoTools(id);
  });

  return (
    <div class="field">
      <NoToolsBanner />
      {
        /* What the scan found, said once. Without this the switch below is
          four names and no way to know which of them is actually running —
          which is exactly the "configure it and hope" the scan removes. */
      }
      <div style={{ display: "flex", alignItems: "flex-start", gap: "10px" }}>
        <span class="field__hint" style={{ flex: 1 }}>
          {local.detecting
            ? "Looking for local servers…"
            : local.detectedAt === 0
            ? "Local servers have not been looked for yet."
            : live.length === 0
            ? "No local server answered on the default ports — start LM Studio, Ollama or llama.cpp, then scan again."
            : `Found ${
              live.map((d) =>
                `${ENGINE_NAMES[d.engine]} (${d.models.length} model${
                  d.models.length === 1 ? "" : "s"
                })`
              ).join(", ")
            }. Picking one fills in its address, its models and its context window.`}
        </span>
        <button
          type="button"
          class="btn btn--ghost btn--sm"
          title="Look again on the three default ports"
          disabled={local.detecting}
          onClick={() => void local.detect(true)}
        >
          {IconRefresh({ size: 13 })}
          {local.detecting ? "Looking…" : "Scan"}
        </button>
      </div>

      <div class="choices" style={{ marginTop: "8px" }}>
        {ENGINE_OPTIONS.map((e) => {
          const probe = found.find((d) => d.engine === e.id);
          return (
            <Choice
              key={e.id}
              name={e.label}
              label={
                <span
                  style={{
                    display: "inline-flex",
                    gap: "8px",
                    alignItems: "center",
                  }}
                >
                  {e.label}
                  {e.id !== "claude" && probe?.reachable && (
                    <Pill tone="ok">
                      running · {probe.models.length}{" "}
                      model{probe.models.length ===
                          1
                        ? ""
                        : "s"}
                    </Pill>
                  )}
                  {
                    /* Said BEFORE it is picked: a server that cannot run
                      tools is a chat box, and that is worth knowing while
                      choosing rather than after the first failed turn. */
                  }
                  {probe?.reachable && probe.tools === false && (
                    <span title="Jinja templating is off on this server (--no-jinja, or an older build without --jinja): it refuses tool calls, so only Chat mode works">
                      <Pill tone="danger">no tools</Pill>
                    </span>
                  )}
                </span>
              }
              hint={e.id === "claude"
                ? "Sub-agents, tasks, jobs, permissions — the full CLI"
                : probe?.reachable
                ? probe.tools === false
                  ? `${probe.baseUrl} — its Jinja templating is off, so only Chat works; restart without --no-jinja (older builds: with --jinja)`
                  : probe.baseUrl
                : local.detectedAt === 0
                ? "Not scanned yet"
                : `Nothing answered on ${DEFAULT_URLS[e.id]}`}
              selected={cfg.engine === e.id}
              onSelect={() =>
                void local.setEngine(id, e.id).then(() =>
                  e.id === "claude" ? undefined : local.syncEngine(id)
                )}
            />
          );
        })}
      </div>

      <span class="field__hint" style={{ marginTop: "8px" }}>
        Local engines run entirely on this machine through their
        OpenAI-compatible servers. Claude Code features — sub-agents, tasks,
        jobs, permissions — apply only while the engine is Claude Code; each
        engine's conversation and settings are kept separately, so switching
        back loses nothing.
      </span>

      {cfg.engine !== "claude" && (
        <>
          <span class="field__label" style={{ marginTop: "10px" }}>
            Model
          </span>
          {
            /* The list, switchable, in Settings too. A settings page that
              shows which model is active and cannot change it is the exact
              shape of "for show" — every value named here is editable here. */
          }
          <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
            <Menu
              label="Model"
              value={cfg.model}
              trigger={
                <span class="truncate" title={cfg.model}>
                  {modelLabel(cfg.model) || "no model"}
                </span>
              }
              options={(chat.models.length
                ? chat.models
                : [cfg.model].filter(Boolean)).map(modelOption)}
              onChange={(m) => void local.setModel(id, m)}
              footer={chat.models.length === 0
                ? "Nothing listed — check the address below, then Refresh."
                : undefined}
            />
            <button
              type="button"
              class="btn btn--ghost btn--sm"
              title="Re-read the model list from the server"
              onClick={() => void local.syncEngine(id)}
            >
              {IconRefresh({ size: 13 })} Refresh
            </button>
          </div>

          <span class="field__label" style={{ marginTop: "10px" }}>
            Server address
          </span>
          <input
            class="input"
            type="text"
            aria-label="Engine server address"
            value={cfg.baseUrl}
            placeholder={DEFAULT_URLS[cfg.engine as keyof typeof DEFAULT_URLS]}
            onChange={(e: Event) =>
              void local.setBaseUrl(id, (e.target as HTMLInputElement).value)
                .then(() => local.syncEngine(id))}
          />
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "8px",
              marginTop: "10px",
            }}
          >
            <span class="field__label" style={{ flex: 1 }}>
              Context window (tokens)
            </span>
            {cfg.ctxManual
              ? (
                <button
                  type="button"
                  class="btn btn--ghost btn--sm"
                  title="Go back to the window the server reports"
                  onClick={() => void local.autoCtx(id)}
                >
                  Detect
                </button>
              )
              : <Pill tone="ok">detected</Pill>}
          </div>
          <input
            class="input"
            type="number"
            aria-label="Context window tokens"
            value={String(cfg.ctx)}
            onChange={(e: Event) =>
              local.setCtx(id, Number((e.target as HTMLInputElement).value))}
          />
          {cfg.mode === "agent" && (
            <>
              <span class="field__label" style={{ marginTop: "10px" }}>
                Running commands
              </span>
              <Segmented
                value={permissionOf(cfg)}
                options={LOCAL_PERMISSIONS.map((p) => ({
                  id: p.id,
                  label: p.label,
                }))}
                onChange={(v) => local.setPermission(id, v)}
              />
              <span class="field__hint">
                The file tools are confined to the project — every path they
                resolve, symlinks included, has to be inside it. A shell command
                cannot be bounded that way, so it is bounded by you instead.
                <b>Ask</b> shows the exact command before it runs.{" "}
                <b>Don't ask</b>{" "}
                runs ordinary commands and refuses the ones that cannot be
                undone — deleting, publishing,{" "}
                <code>sudo</code>, piping a download into a shell. That is a
                list of known-dangerous words, not a sandbox: it stops an
                accident, not a determined model. <b>Bypass</b>{" "}
                turns the list off. Every command is still capped at 60 seconds
                and killed with its whole process tree when the turn ends.
              </span>
            </>
          )}

          <span class="field__hint" style={{ marginTop: "10px" }}>
            {cfg.ctxManual
              ? "Set by hand — packing, eviction and the meter all budget against this number."
              : "Read from the server, and re-read whenever the model changes. Type a value to override it."}
            {chat.models.length > 0 &&
              ` ${chat.models.length} model${
                chat.models.length === 1 ? "" : "s"
              } available.`}
          </span>
        </>
      )}
    </div>
  );
}
