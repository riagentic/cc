/**
 * @module
 * The conversation page for a project on a local engine (LM Studio, Ollama,
 * llama.cpp server) — the local twin of ChatPage, sharing the design system
 * and Markdown renderer but none of the Claude session machinery.
 *
 * The strip above the thread carries what a small-context model lives and
 * dies by: which model, which mode, and how full the window is.
 */
import {
  afterRender,
  onCleanup,
  onMount,
  useLocal,
  useRef,
  type VNode,
} from "aio/air";
import { Mic } from "./Mic.tsx";
import { Speaker } from "./Speaker.tsx";
import { ClearChat } from "./ClearChat.tsx";
import { Markdown } from "./Markdown.tsx";
import { JumpToLatest, MsgMeta, useStickToBottom } from "./thread.tsx";
import { FindBar, findIndex, findQuery, useScrollToMatch } from "./find.tsx";
import { hits } from "../lib/transcript.ts";
import {
  dropDraft,
  fitComposer,
  loadDraft,
  saveDraft,
  swapDraft,
} from "./compose.ts";
import { BranchStat, ContextStat, EngineStat, ProjectStat } from "./strip.tsx";
import {
  DEFAULT_URLS,
  detectedEngines,
  local,
  localChat,
  localConfig,
  localSpeed,
} from "../cell/local.ts";
import {
  capabilityOf,
  isCloudModel,
  LOCAL_CAPABILITIES,
  LOCAL_PACES,
  LOCAL_RUN_AS,
  paceOf,
  permissionOf,
  programsToAllow,
  runAsOf,
} from "../lib/agent.ts";
import { activeSessionKey, workspace } from "../cell/workspace.ts";
import { modelLabel, tailPath, tokens } from "../lib/format.ts";
import {
  Banner,
  Choice,
  Elapsed,
  Empty,
  Menu,
  Pill,
  Segmented,
  Stat,
  Toggle,
} from "./parts.tsx";
import {
  IconAlert,
  IconCheck,
  IconChevron,
  IconLogo,
  IconModel,
  IconRefresh,
  IconSend,
  IconShield,
  IconStop,
  IconUser,
  toolIcon,
} from "./icons.tsx";
import type { LocalMode, LocalMsg, LocalTodo } from "../type/local.ts";

export const ENGINE_NAMES: Record<string, string> = {
  claude: "Claude",
  lmstudio: "LM Studio",
  ollama: "Ollama",
  llamacpp: "llama.cpp",
};

/**
 * The same names, short enough to sit on a dock row beside a title.
 *
 * A word beats a drawing here. Four engine logos told apart at 11px is a
 * puzzle — the two llama-based ones are the same handful of grey pixels at
 * that size — and the whole job of this label is to be read without effort.
 */
export const ENGINE_TAGS: Record<string, string> = {
  claude: "claude",
  lmstudio: "lm studio",
  ollama: "ollama",
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
  const id = activeSessionKey();
  const cfg = localConfig(id);
  const chat = localChat(id);
  // Same scrolling contract as the Claude thread, from the same code — and the
  // same find bar, over the same kind of match.
  const scroll = useStickToBottom(chat.messages.length);
  const q = findQuery();
  const found = q.trim() === ""
    ? []
    : chat.messages.filter((m) => hits(m.text, q)).map((m) => m.id);
  const current = found.length > 0
    ? found[Math.min(findIndex(), found.length - 1)]
    : "";

  // A conversation parked on disk (idle, not on screen) comes back the moment
  // it is looked at. Safe to ask on every render: it is a no-op once back.
  afterRender(() => {
    if (chat.parked) void local.unpark(id);
  });

  useScrollToMatch(scroll.ref, current);

  return (
    <div class="page">
      <LocalStrip />
      <div class="chatwrap">
        <div class="chat" ref={scroll.ref} onScroll={scroll.onScroll}>
          <div class="thread">
            {
              /* Every direct child keyed, the absent ones included. A falsy
                `{cond && …}` still contributes a child — an UNKEYED one — and
                a list holding both kinds reconciles by position, which is how
                a message ends up wearing its neighbour's body. */
            }
            <NoToolsBanner key="notools" />
            {chat.error
              ? (
                <Banner key="err" tone="warn">
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
              )
              : <span key="err" hidden />}
            {chat.parked
              ? (
                <div key="parked" class="thread__note" aria-live="polite">
                  Opening this conversation…
                </div>
              )
              : <span key="parked" hidden />}
            {(chat.archived ?? 0) > 0 && !chat.parked
              ? (
                <div key="archived" class="thread__note">
                  {chat.archived} earlier{" "}
                  {chat.archived === 1 ? "message is" : "messages are"}{" "}
                  saved outside this view. Ask the agent about them — it can
                  search them.
                </div>
              )
              : <span key="archived" hidden />}
            {chat.messages.length === 0 && !chat.streaming && !chat.parked
              ? (
                <Empty
                  key="empty"
                  icon={IconLogo({ size: 20 })}
                  title={`${ENGINE_NAMES[cfg.engine] ?? cfg.engine} · ${
                    modelLabel(cfg.model) || "no model"
                  }`}
                  hint={!cfg.model
                    ? "Refresh the model list above, or check the server address in Settings."
                    : isCloudModel(cfg.model)
                    ? "This model runs in Ollama's cloud — the conversation, and every file the agent reads, leave this machine."
                    : cfg.mode !== "chat" && cfg.ctx < 16_000
                    ? `The model is loaded with a ${
                      tokens(cfg.ctx)
                    }-token window: the agent works, but has to forget quickly. Load it with more for better results — Ollama: OLLAMA_CONTEXT_LENGTH=32768; LM Studio: a larger Context Length; llama.cpp: -c 32768.`
                    : /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])([:/]|$)/
                        .test(cfg.baseUrl)
                    ? "Everything runs on your machine. Pick a mode above and say what you need."
                    : `Conversations go to ${cfg.baseUrl}. Pick a mode above and say what you need.`}
                />
              )
              : chat.messages.map((m) => (
                <Row
                  key={m.id}
                  m={m}
                  hit={m.id === current
                    ? "current"
                    : found.includes(m.id)
                    ? "yes"
                    : ""}
                />
              ))}
            {chat.streaming || chat.thinking
              ? (
                <article key="streaming" class="msg">
                  <div class="msg__avatar msg__avatar--assistant">
                    {IconLogo({ size: 15 })}
                  </div>
                  <div class="msg__body">
                    <div key="who" class="msg__who" title={cfg.model}>
                      {modelLabel(cfg.model) || "model"}
                    </div>
                    {
                      /* What a reasoning model is thinking, while it thinks —
                        the tail only, dimmed. A minute of silence reads as a
                        hung server; a minute of visible reasoning does not. */
                    }
                    {chat.thinking && !chat.streaming
                      ? (
                        <div key="thinking" class="thinking" aria-live="polite">
                          {chat.thinking}
                        </div>
                      )
                      : <span key="thinking" hidden />}
                    {chat.streaming
                      ? (
                        <div key="bubble" class="bubble">
                          <Markdown source={chat.streaming} />
                        </div>
                      )
                      : <span key="bubble" hidden />}
                  </div>
                </article>
              )
              : <span key="streaming" hidden />}
          </div>
        </div>
        <FindBar total={found.length} />
        <JumpToLatest
          away={scroll.away}
          behind={scroll.behind}
          onClick={scroll.toBottom}
        />
      </div>
      <TodoPanel todos={chat.todos} busy={chat.status === "working"} />
      <QueuedMessages />
      <CommandPrompt />
      <LocalComposer />
    </div>
  );
}

/** The agent's own task list, when it is keeping one. Compact on purpose: a
 *  plan is a working document, not a page — it sits above the composer so it
 *  reads as "what the agent is doing now" rather than as a message. The
 *  in-progress row carries a spinner because it is the one row that moves. */
function TodoPanel(
  props: { todos?: LocalTodo[]; busy: boolean },
): VNode | null {
  // A chat saved before the task list existed has none at all.
  const todos = props.todos ?? [];
  if (todos.length === 0) return null;
  const done = todos.filter((t) => t.status === "completed").length;
  // A finished plan, once the turn is over, is history — the transcript
  // already says what was done.
  if (done === todos.length && !props.busy) return null;
  return (
    <div
      class="todopanel"
      aria-label={`Task list, ${done} of ${todos.length} done`}
    >
      {todos.map((t, i) => (
        <div
          // By position: two steps may share their wording.
          key={`${i}`}
          class="todopanel__row"
          data-status={t.status}
        >
          {t.status === "completed"
            ? IconCheck({ size: 13 })
            : t.status === "in_progress"
            ? <span class="spin">{IconRefresh({ size: 13 })}</span>
            : <span class="todopanel__open" />}
          <span class={t.status === "completed" ? "todopanel__done" : ""}>
            {t.content}
          </span>
        </div>
      ))}
    </div>
  );
}

/**
 * What the user wrote while the agent works, waiting for its next step.
 *
 * Shown so a message typed mid-task is visibly *somewhere* — not lost, not
 * yet read — and can be taken back until it is delivered.
 */
function QueuedMessages(): VNode | null {
  const id = activeSessionKey();
  const queued = localChat(id).queued ?? [];
  if (queued.length === 0) return null;
  return (
    <div class="queued" aria-label="Messages waiting for the next step">
      {queued.map((q) => (
        <div key={q.id} class="queued__row">
          <span class="queued__tag">next step</span>
          <span class="queued__text">{q.text}</span>
          <button
            type="button"
            class="btn btn--ghost btn--sm btn--icon"
            aria-label="Take back this message"
            title="Take back — it has not been read yet"
            onClick={() => void local.unqueue(id, q.id)}
          >
            ×
          </button>
        </div>
      ))}
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
  const id = activeSessionKey();
  const pending = localChat(id).pending;
  const card = useRef<HTMLElement>(null!);
  // Same contract as the Claude prompt: the CARD takes focus when it appears,
  // never a button. A blocked turn a keyboard user has to Tab across the page
  // to reach is a blocked turn — and focusing "Run it" would arm Enter to say
  // yes, which is the one thing an approval must never do.
  //
  // On each NEW question, not on mount: this component is always mounted and
  // renders nothing until a command waits, so a mount-time focus found no
  // card and the one that later appeared was never focused.
  const focused = useRef("");
  const pendingId = pending?.id ?? "";
  afterRender(() => {
    if (pendingId === focused.current) return;
    focused.current = pendingId;
    if (pendingId !== "") card.current?.focus();
  });
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
            {pending.outside
              ? "Run a command outside the sandbox"
              : "Run a command"} in{" "}
            {workspace.projects.find((p) => p.id === id)?.name ??
              "this project"}
            {pending.background ? ", in the background?" : "?"}
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
              {pending.outside
                ? "The model asked to leave the sandbox for this one command: it would run as you, with your network, your display and your files — nothing held back. Other commands stay sandboxed."
                : "It runs as you, with your own permissions. The project directory is where it starts, not a wall around it — every other tool here is confined to it, this one cannot be."}
              {pending.background &&
                " It keeps running after the command returns, until it is stopped or this conversation is cleared."}
            </span>
          </div>
          <div class="perm__actions">
            <button
              type="button"
              class="btn btn--sm btn--primary"
              onClick={() => void local.answer(id, true, false, pending.id)}
            >
              Run it
            </button>
            {(() => {
              // In "Don't ask" a command is only asked about when it runs
              // unconfined — outside the box, or with no box at all — and
              // "always" then allows these programs in this chat, not a mode
              // change. The label says so, matching `local.answer`.
              const byProgram = pending.outside ||
                permissionOf(localConfig(id)) === "dontAsk";
              const progs = byProgram ? programsToAllow(pending.cmd) : [];
              return byProgram
                ? progs.length > 0 && (
                  <button
                    type="button"
                    class="btn btn--sm"
                    title="Later commands in this conversation that run only these programs leave the sandbox without asking. Destructive ones are still refused. Changing the permission mode forgets it."
                    onClick={() =>
                      void local.answer(id, true, true, pending.id)}
                  >
                    Run it, and allow {progs.join(", ")}
                    {pending.outside ? " outside" : ""}
                  </button>
                )
                : (
                  <button
                    type="button"
                    class="btn btn--sm"
                    title="Stop asking in this conversation — commands then run in a sandbox where one is available, and destructive ones are still refused. The strip above and Settings both put it back."
                    onClick={() =>
                      void local.answer(id, true, true, pending.id)}
                  >
                    Run it, and stop asking
                  </button>
                );
            })()}
            <button
              type="button"
              class="btn btn--sm btn--danger"
              onClick={() => void local.answer(id, false, false, pending.id)}
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
  const id = activeSessionKey();
  const cfg = localConfig(id);
  const chat = localChat(id);

  return (
    <div class="strip">
      {
        /* Project, branch, engine, model — the same four, in the same places,
          as the Claude strip. This row used to lead with the engine, so
          switching a project onto a local model moved every control on it. */
      }
      <ProjectStat />
      <BranchStat />
      <EngineStat />

      <Stat label="Model" clamp>
        {IconModel({ size: 14 })}
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
        <button
          type="button"
          class="btn btn--ghost btn--sm btn--icon"
          aria-label="Refresh models"
          title="Re-read the model list from the server"
          onClick={() => void local.syncEngine(id)}
        >
          {IconRefresh({ size: 13 })}
        </button>
        {chat.toolsOk === false && cfg.mode !== "chat" && (
          <span title="This model takes no native tool calls — the agent describes its tools in words instead, which works but is less reliable">
            <Pill tone="warn">{IconAlert({ size: 11 })} tools as text</Pill>
          </span>
        )}
        {isCloudModel(cfg.model) && (
          <span title="Runs in Ollama's cloud: the conversation and every file the agent reads leave this machine">
            <Pill tone="warn">cloud</Pill>
          </span>
        )}
      </Stat>

      {
        /* Mode sits where Effort sits on the Claude strip, and Permissions
          where Permissions sits. Neither means the same thing on both sides —
          but "what may it do" is asked in the same place either way. */
      }
      <Stat label="Mode">
        <Segmented
          value={cfg.mode}
          options={MODES}
          onChange={(v) => local.setMode(id, v)}
        />
      </Stat>

      {
        /* How thoroughly a turn works, beside what it may work ON. It belongs
          on the row and not only in Settings: pace is the setting a turn in
          progress makes you want — "this is taking forever" — and the loop
          re-reads it every round. */
      }
      {cfg.mode !== "chat" && (
        <Stat label="Pace">
          <Segmented
            value={paceOf(cfg)}
            options={LOCAL_PACES.map((p) => ({ id: p.id, label: p.label }))}
            onChange={(v) => local.setPace(id, v)}
          />
        </Stat>
      )}

      {
        /* Agent mode is one click: what it may do without asking is the
          checkbox beside it, not a second confirmation of the first click. */
      }
      {cfg.mode === "agent" && (
        <Stat label="Permissions">
          <AutoApprove id={id} />
          <PermissionBadge id={id} />
          <AccountBadge id={id} />
        </Stat>
      )}

      <ContextStat
        used={chat.usedTokens}
        max={cfg.ctx}
        measured={false}
        title={`Estimated context use against the ${
          tokens(cfg.ctx)
        }-token window set in Settings`}
      />
    </div>
  );
}

/**
 * "Auto-approve": the agent runs every command without asking — no approval
 * cards, no sandbox, no refusals. Off, it goes back to the mode it was on.
 */
function AutoApprove(props: { id: string }): VNode {
  const on = capabilityOf(localConfig(props.id)) === "all";
  return (
    <label
      class={"check" + (on ? " check--on" : "")}
      title={on
        ? "Every command runs as you, with no approval and no checks. Untick to be asked again."
        : "Run every command without asking — no approvals, no sandbox, no checks"}
    >
      <input
        type="checkbox"
        checked={on}
        onChange={(e: Event) =>
          local.autoApprove(
            props.id,
            (e.currentTarget as HTMLInputElement).checked,
          )}
      />
      Auto-approve
    </label>
  );
}

/**
 * What the agent may do without being asked, and the way back to being asked.
 *
 * The point of a badge that names what is switched off is that the switch is
 * where you read about it — so both unasked modes are a button, not a label.
 */
function PermissionBadge(props: { id: string }): VNode | null {
  const cap = capabilityOf(localConfig(props.id));
  if (cap === "read") {
    return (
      <span title="Read-only — no edits, no shell">
        <Pill>read only</Pill>
      </span>
    );
  }
  if (cap === "write") {
    return (
      <span title="Can edit files; shell tools are off">
        <Pill tone="warn">can write files</Pill>
      </span>
    );
  }
  // Allow all is said by the ticked Auto-approve box beside this.
  if (cap === "all") return null;
  return (
    <button
      type="button"
      class="btn btn--ghost btn--sm"
      title={local.sandbox === false
        ? "Execute: commands run unasked; destructive ones refused (no sandbox). Click for Write (no shell)."
        : "Execute: sandboxed commands unasked; destructive ones refused. Click for Write (no shell)."}
      onClick={() => local.setCapability(props.id, "write")}
    >
      <Pill tone="warn">
        {IconAlert({ size: 11 })} runs commands unasked
      </Pill>
    </button>
  );
}

/** Conversations whose account has been asked about — module-local, so a
 *  render never asks twice. */
const ACCOUNT_ASKED = new Set<string>();

/** Which Linux user the commands run as, when it is not you. */
function AccountBadge(props: { id: string }): VNode | null {
  if (!ACCOUNT_ASKED.has(props.id)) {
    ACCOUNT_ASKED.add(props.id);
    void local.checkAccount(props.id);
  }
  const user = local.accounts[props.id];
  if (!user) return null;
  return (
    <span
      title={`Commands run as the Linux user ${user}, not as you — in its own home, with its own apps. This project is within its reach.`}
    >
      <Pill tone="ok">as {user}</Pill>
    </span>
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
  const id = activeSessionKey();
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
 * The model takes no tool calls natively — and the agent works anyway.
 *
 * A llama.cpp with Jinja templating off, or a model LM Studio or Ollama
 * reports as not trained for tools, refuses (or silently drops) the tools in a
 * request. The agent then describes them in words and reads the calls back
 * from the reply: every model can do it, none do it as reliably as a native
 * call. So this says what is happening and what would make it better — and
 * for llama.cpp, where the fix is one launch flag, names the flag.
 *
 * Only in the modes that use tools: in Chat it would be a warning about
 * something that is not happening.
 */
function NoToolsBanner(): VNode | null {
  const id = activeSessionKey();
  const chat = localChat(id);
  const cfg = localConfig(id);
  if (chat.toolsOk !== false || cfg.mode === "chat") return null;
  const cmd = "llama-server --jinja -m your-model.gguf";
  return (
    <Banner>
      This model does not take tool calls natively, so the agent describes its
      tools in words and reads the calls back from the reply. It works, but a
      model trained for tool use is faster and more reliable.
      {cfg.engine === "llamacpp" && (
        <>
          {" "}On llama.cpp this usually means Jinja templating is off — current
          builds have it on unless <code>--no-jinja</code>{" "}
          was passed; older ones need{" "}
          <code
            class="perm__cmd"
            style={{ display: "inline", padding: "1px 5px" }}
          >
            {cmd}
          </code>{" "}
          <button
            type="button"
            class="btn btn--ghost btn--sm"
            title="Copy the command"
            onClick={() => void navigator.clipboard?.writeText(cmd)}
          >
            Copy
          </button>
        </>
      )}{" "}
      <button
        type="button"
        class="btn btn--sm"
        title="Ask the server again"
        onClick={() => void local.autoTools(id)}
      >
        Check again
      </button>
    </Banner>
  );
}

/* ── thread ───────────────────────────────────────────────────────────────── */

function Row(props: { m: LocalMsg; hit?: string }): VNode {
  const m = props.m;
  if (m.role === "tool") return <ToolResult m={m} />;
  const user = m.role === "user";
  return (
    <article
      class={"msg" + (props.hit === "current"
        ? " msg--found"
        : props.hit === "yes"
        ? " msg--hit"
        : "")}
      data-msg={m.id}
      style={m.evicted ? { opacity: 0.55 } : undefined}
      title={m.evicted
        ? "No longer in the model's context — folded into the running summary"
        : undefined}
    >
      <div class={`msg__avatar msg__avatar--${user ? "user" : "assistant"}`}>
        {user ? IconUser({ size: 15 }) : IconLogo({ size: 15 })}
      </div>
      <div class="msg__body">
        <div class="msg__who" key="who">
          {user ? "You" : "Model"}
          <MsgMeta at={m.at} text={m.text} editable={user} />
        </div>
        {
          /* Keyed like its siblings, the absent case included — a bare
            `cond && …` child is unkeyed, and mixed keys reconcile by position. */
        }
        {m.text.trim() !== ""
          ? (
            <div key="bubble" class="bubble">
              {user ? m.text : <Markdown source={m.text} />}
            </div>
          )
          : <span key="bubble" hidden />}
        {
          /* One keyed child for the calls, present or not: a bare
            `toolCalls?.map` is an unkeyed `undefined` on every message
            without calls — the "mixed keyed and unkeyed children" warning on
            every user row. `display: contents` keeps the chips' layout. */
        }
        {m.toolCalls?.length
          ? (
            <div key="calls" style={{ display: "contents" }}>
              {m.toolCalls.map((c) => (
                <div
                  key={c.id || c.name}
                  class="toolchip"
                  style={{ cursor: "auto" }}
                >
                  <span class="toolchip__icon">{toolIcon(c.name, 14)}</span>
                  <span class="truncate">
                    <span class="toolchip__name">{c.name}</span>{" "}
                    <span class="toolchip__title">
                      {c.args.length > 120
                        ? c.args.slice(0, 120) + "…"
                        : c.args}
                    </span>
                  </span>
                </div>
              ))}
            </div>
          )
          : <span key="calls" hidden />}
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
  const id = activeSessionKey();
  const chat = localChat(id);
  const busy = chat.status === "working";
  const speed = localSpeed(id);

  // While a turn runs, sending does not wait: the message is queued and
  // delivered into the running task at its next step — a correction, a
  // question, or "stop" (which cuts the step short at once).
  const submit = () => {
    const el = ref.current;
    if (!el) return;
    const text = el.value;
    if (!text.trim()) return;
    el.value = "";
    dropDraft(id);
    setHasText(false);
    fitComposer(el);
    void local.send(text, id).then((taken) => {
      // Refused before it started — no model chosen, the wrong engine. What
      // somebody typed is theirs: it goes back in the box, not nowhere.
      if (taken !== false) return;
      saveDraft(id, text);
      const box = ref.current;
      if (box && box.value === "") {
        box.value = text;
        setHasText(true);
        fitComposer(box);
      }
    });
  };

  // Same contract as the Claude composer, from the same store: a draft belongs
  // to the CONVERSATION it was written for, it comes back when you return to
  // that conversation, and it survives looking at another page — this textarea
  // is unmounted every time you do.
  const shownFor = useRef(id);

  onMount(() => {
    const el = ref.current;
    if (!el) return;
    const kept = loadDraft(id);
    if (kept === "") return;
    el.value = kept;
    setHasText(kept.trim().length > 0);
    fitComposer(el);
  });

  onCleanup(() => saveDraft(shownFor.current, ref.current?.value ?? ""));

  afterRender(() => {
    const el = ref.current;
    if (!el || shownFor.current === id) return;
    el.value = swapDraft(shownFor.current, id, el.value);
    shownFor.current = id;
    setHasText(el.value.trim().length > 0);
    fitComposer(el);
  });

  return (
    <div class="composer">
      <div class="composer__inner">
        <span class="composer__prompt" aria-hidden="true">&gt;</span>
        <textarea
          ref={ref}
          rows={1}
          placeholder={busy
            ? "Add to the running task — a correction, a question, or “stop”…"
            : "Message the local model…"}
          aria-label="Message the local model"
          onInput={() => {
            setHasText((ref.current?.value.trim().length ?? 0) > 0);
            fitComposer(ref.current);
          }}
          onKeyDown={(e: KeyboardEvent) => {
            if (e.key !== "Enter") return;
            // Ctrl+Enter sends too — the habit people arrive with from every
            // other chat app, and unambiguous in a message box.
            if (e.shiftKey && !(e.ctrlKey || e.metaKey)) return;
            if (e.isComposing || e.keyCode === 229) return; // IME accept
            e.preventDefault();
            submit();
          }}
        />
        <div class="composer__bar">
          <Mic key="mic" />
          <Speaker key="speaker" />
          <ClearChat key="clear" />
          {
            /* The agent's file changes are the user's to keep. After a turn
              that edited or wrote files, one click puts every one of them
              back — the originals were kept as the turn made them. */
          }
          {!busy && (chat.changed ?? 0) > 0
            ? (
              <button
                key="undo"
                type="button"
                class="btn btn--ghost btn--sm"
                title="Put back every file the last turn changed with edit or write (changes made by shell commands are not undone)"
                onClick={() => void local.undoChanges(id)}
              >
                Undo {chat.changed} file change{chat.changed === 1 ? "" : "s"}
              </button>
            )
            : <span key="undo" hidden />}
          {(chat.jobs ?? 0) > 0
            ? (
              <button
                key="jobs"
                type="button"
                class="btn btn--ghost btn--sm"
                title="Programs the agent left running in the background (a server, the app under test). Stop them all."
                onClick={() => void local.stopBackground(id)}
              >
                {IconStop({ size: 12 })} {chat.jobs} running
              </button>
            )
            : <span key="jobs" hidden />}
          {
            /* The same two states as the Claude composer: a clock while a turn
              runs, and what the last one cost in time when it is over. A local
              model on a busy GPU can take minutes, and "the model is working"
              reads identically at two seconds and at four minutes. */
          }
          {busy
            ? (
              <span
                key="working"
                class="composer__hint"
                title="Time since this turn was sent."
              >
                Working <Elapsed startedAt={chat.startedAt} fallbackMs={0} />
              </span>
            )
            : (
              <span key="idle" class="composer__hint">
                <span class="kbd">Enter</span> to send ·{" "}
                <span class="kbd">Shift</span>+<span class="kbd">Enter</span>
                {" "}
                for a new line
                {speed !== null && (
                  <span
                    title="Tokens a second over the whole of the last turn, as the server reported it."
                    style={{ color: "var(--ink-dim)" }}
                  >
                    {" · "}
                    {speed >= 10 ? Math.round(speed) : speed.toFixed(1)} tok/s
                  </span>
                )}
              </span>
            )}
          {busy
            ? (
              <button
                key="stop"
                type="button"
                class="btn btn--sm btn--danger"
                onClick={() => void local.stop(id)}
                title="Stop now: the reply, the command, everything. Nothing more is sent — what you typed meanwhile stays in the chat."
              >
                {IconStop({ size: 13 })} Stop
              </button>
            )
            : <span key="stop" hidden />}
          <button
            key="send"
            type="button"
            // A stable hook, not styling: push-to-talk sends by clicking this
            // button rather than by repeating what it does. The page keeps one
            // definition of "send", and a disabled button correctly refuses —
            // speaking while a turn is already running should queue nothing.
            class="btn btn--primary btn--sm composer__send"
            disabled={!hasText}
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
  const id = activeSessionKey();
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
    // Whether "Don't ask" gets a sandbox here — asked once, answered in the
    // permission hint below.
    void local.checkSandbox();
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
          {cfg.mode !== "chat" && (
            <>
              <span class="field__label" style={{ marginTop: "10px" }}>
                Pace
              </span>
              <Segmented
                value={paceOf(cfg)}
                options={LOCAL_PACES.map((p) => ({
                  id: p.id,
                  label: p.label,
                }))}
                onChange={(v) => local.setPace(id, v)}
              />
              <span class="field__hint">
                Draft: something that runs, very fast. Normal: checked and still
                quick. Quality: thorough (slower).
              </span>
              <span class="field__label" style={{ marginTop: "10px" }}>
                Run as
              </span>
              <Segmented
                value={runAsOf(cfg)}
                options={LOCAL_RUN_AS.map((p) => ({
                  id: p.id,
                  label: p.label,
                }))}
                onChange={(v) => local.setRunAs(id, v)}
              />
              <span class="field__hint">
                {local.accounts[id]
                  ? `Shell runs as ${local.accounts[id]}.`
                  : runAsOf(cfg) === "agent"
                  ? "No agent account can reach this project, and cc-agent is a wall, not a preference — commands are refused until you pick You."
                  : "Shell runs as you for this project."}
              </span>
              <span class="field__label" style={{ marginTop: "10px" }}>
                Permissions
              </span>
              <Segmented
                value={capabilityOf(cfg)}
                options={LOCAL_CAPABILITIES.map((p) => ({
                  id: p.id,
                  label: p.label,
                }))}
                onChange={(v) => local.setCapability(id, v)}
              />
              {capabilityOf(cfg) === "execute" && local.sandbox === true && (
                <Toggle
                  label="Sandboxed commands may use the network"
                  hint="Off: no downloads, no internet — and no access to your screen. On: downloads work, but the X display becomes reachable too. Either way the model can ask to run one command outside the sandbox."
                  checked={cfg.sandboxNet === true}
                  onChange={(on) => local.setSandboxNet(id, on)}
                />
              )}
              <span class="field__hint">
                <b>Read</b> lists and searches only. <b>Write</b>{" "}
                can edit files. <b>Execute</b>{" "}
                also runs commands with a sandbox and a destructive deny-list.
                {" "}
                <b>Allow all</b>{" "}
                turns every check off. File tools stay inside the project.
                Prefer <b>Run as → cc-agent</b> when that account is set up.
                {local.sandbox === false
                  ? " No bubblewrap here — Execute still refuses destructive commands by word list."
                  : ""}
              </span>
            </>
          )}

          <span class="field__hint" style={{ marginTop: "10px" }}>
            {cfg.ctxManual
              ? "Set by hand — packing, eviction and the meter all budget against this number."
              : "Read from the server — re-read whenever the model changes and at the start of every turn. Type a value to override it."}
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
