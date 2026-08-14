/**
 * @module
 * The main page: the conversation with Claude Code, plus the composer.
 *
 * Assistant prose renders as Markdown, thinking is folded into a quiet block,
 * and every tool call becomes a chip you can open in place — so the transcript
 * stays readable while nothing is hidden.
 */
import { afterRender, onMount, useLocal, useRef, type VNode } from "aio/air";
import { Markdown } from "./Markdown.tsx";
import { highlight } from "../lib/highlight.ts";
import { session } from "../cell/session.ts";
import { workspace } from "../cell/workspace.ts";
import type { Block, Message } from "../type/claude.ts";
import { clock, duration, oneLine } from "../lib/format.ts";
import { Banner, Empty } from "./parts.tsx";
import {
  IconChevron,
  IconLogo,
  IconSend,
  IconStop,
  IconUser,
  toolIcon,
} from "./icons.tsx";

export function ChatPage(): VNode {
  return (
    <div class="page">
      <Thread />
      <Composer />
    </div>
  );
}

/* ── thread ───────────────────────────────────────────────────────────────── */

function Thread(): VNode {
  const ref = useRef<HTMLDivElement>(null!);
  const stick = useRef(true);

  const onScroll = () => {
    const el = ref.current;
    if (!el) return;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 140;
  };

  // Follow the conversation only while the reader is already at the bottom —
  // yanking the view down while someone reads back is the classic chat bug.
  afterRender(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  });

  const messages = session.messages;

  return (
    <div class="chat" ref={ref} onScroll={onScroll}>
      <div class="thread">
        {session.error && (
          <Banner onDismiss={() => session.dismissError()}>
            {session.error}
          </Banner>
        )}
        {workspace.cliMissing && (
          <Banner tone="warn">
            The <code>claude</code>{" "}
            CLI was not found on PATH. Install Claude Code, or point{" "}
            <code>CLAUDE_BIN</code> at the binary, then start a session.
          </Banner>
        )}

        {messages.length === 0 && !session.streaming
          ? <Welcome />
          : messages.map((m) => <MessageRow key={m.id} message={m} />)}

        {session.streaming && <Streaming />}
      </div>
    </div>
  );
}

function Welcome(): VNode {
  const suggestions = [
    "Explain this codebase's architecture",
    "What changed on this branch?",
    "Find and fix the failing test",
  ];
  return (
    <div style={{ paddingTop: "8vh" }}>
      <Empty
        icon={IconLogo({ size: 22 })}
        title="Ultimate control over Claude Code"
        hint="Every turn runs in the project below, in one long-lived session — context, tools and MCP servers are paid for once."
      >
        <div
          class="tags"
          style={{ justifyContent: "center", marginTop: "6px" }}
        >
          {suggestions.map((s) => (
            <button
              key={s}
              type="button"
              class="btn btn--sm"
              onClick={() => session.send(s)}
            >
              {s}
            </button>
          ))}
        </div>
      </Empty>
    </div>
  );
}

function MessageRow(props: { message: Message }): VNode {
  const m = props.message;
  const isUser = m.role === "user";
  return (
    <article class="msg">
      <div class={`msg__avatar msg__avatar--${m.role}`}>
        {isUser ? IconUser({ size: 15 }) : IconLogo({ size: 15 })}
      </div>
      <div class="msg__body">
        <div class="msg__who">
          {isUser ? "You" : "Claude"}
          {m.parentToolUseId && " · sub-agent"}
          <span style={{ color: "var(--ink-dim)", fontWeight: 500 }}>
            {"  "}
            {clock(m.at)}
          </span>
        </div>
        {m.blocks.map((b, i) => <BlockView key={`${m.id}-${i}`} block={b} />)}
      </div>
    </article>
  );
}

function BlockView(props: { block: Block }): VNode | null {
  const b = props.block;
  if (b.kind === "text") {
    return (
      <div class="bubble">
        <Markdown source={b.text} />
      </div>
    );
  }
  if (b.kind === "thinking") return <Thinking text={b.text} />;
  if (b.kind === "tool") {
    return <ToolChip id={b.id} name={b.name} input={b.input} />;
  }
  return null;
}

function Thinking(props: { text: string }): VNode {
  const [open, setOpen] = useLocal(false);
  const preview = oneLine(props.text, 130);
  return (
    <button
      type="button"
      class="think"
      style={{
        textAlign: "left",
        width: "100%",
        cursor: "pointer",
        font: "inherit",
      }}
      aria-expanded={open}
      onClick={() => setOpen(!open)}
    >
      <div class="think__k">
        Thinking
        <span
          style={{
            display: "inline-flex",
            transform: open ? "rotate(90deg)" : "none",
            transition: "transform .15s",
          }}
        >
          {IconChevron({ size: 11 })}
        </span>
      </div>
      {open ? props.text : preview}
    </button>
  );
}

/** A tool call in the transcript: name, one-line summary, and — on click — the
 *  full input and whatever it returned. */
function ToolChip(
  props: { id: string; name: string; input: Record<string, unknown> },
): VNode {
  const [open, setOpen] = useLocal(false);
  const run = session.tools.find((t) => t.id === props.id);
  const running = run !== undefined && run.endedAt === null;
  const failed = run?.ok === false;
  // A call held at a permission prompt is not "running" — nothing is happening
  // until the user answers, and a ticking clock said the opposite.
  const waiting = run?.permissionId !== null && run?.permissionId !== undefined;
  // …and a run that ended with no outcome was cut off with the session: a bare
  // duration there would read as a call that completed.
  const timing = waiting
    ? "needs approval"
    : running
    ? "running…"
    : run?.endedAt
    ? run.ok === null ? "cut off" : duration(run.endedAt - run.startedAt)
    : "";

  return (
    <div>
      <button
        type="button"
        class="toolchip"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span
          class="toolchip__icon"
          style={failed
            ? { color: "var(--danger)" }
            : running
            ? { color: "var(--accent)" }
            : {}}
        >
          {toolIcon(props.name, 14)}
        </span>
        <span class="truncate">
          <span class="toolchip__name">{props.name}</span>{" "}
          <span class="toolchip__title">{run?.title ?? ""}</span>
        </span>
        <span
          class="mono"
          style={{
            color: waiting ? "var(--warn)" : "var(--ink-dim)",
            fontSize: "11px",
          }}
        >
          {timing}
        </span>
      </button>
      {open && (
        <div style={{ marginTop: "6px", display: "grid", gap: "6px" }}>
          <div class="code">
            {highlight(JSON.stringify(props.input, null, 2), "json").map((
              t,
              n,
            ) =>
              t.kind === "plain"
                ? t.text
                : <span key={n} class={`tok tok--${t.kind}`}>{t.text}</span>
            )}
          </div>
          {run?.output && <div class="code">{run.output}</div>}
        </div>
      )}
    </div>
  );
}

/** The block being written right now — coalesced at ~10 Hz upstream, so this
 *  reads as smooth streaming without a dispatch per token. */
function Streaming(): VNode | null {
  const s = session.streaming;
  if (!s) return null;
  return (
    <article class="msg">
      <div class="msg__avatar msg__avatar--assistant">
        {IconLogo({ size: 15 })}
      </div>
      <div class="msg__body">
        <div class="msg__who">Claude</div>
        {s.kind === "thinking"
          ? (
            <div class="think">
              <div class="think__k">Thinking</div>
              {s.text}
              <span class="caret" />
            </div>
          )
          : (
            <div class="bubble">
              {s.text}
              <span class="caret" />
            </div>
          )}
      </div>
    </article>
  );
}

/* ── composer ─────────────────────────────────────────────────────────────── */

function Composer(): VNode {
  const ref = useRef<HTMLTextAreaElement>(null!);
  const [hasText, setHasText] = useLocal(false);
  const working = session.status === "working";

  onMount(() => ref.current?.focus());

  const resize = () => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 260)}px`;
  };

  const submit = () => {
    const el = ref.current;
    if (!el) return;
    const text = el.value;
    if (!text.trim()) return;
    el.value = "";
    setHasText(false);
    resize();
    void session.send(text);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "Enter") return;
    if (e.shiftKey) return; // Shift+Enter is a newline, always
    e.preventDefault();
    submit();
  };

  return (
    <div class="composer">
      <div class="composer__inner">
        <textarea
          ref={ref}
          rows={1}
          placeholder={working
            ? "Claude is working — your next turn will be queued…"
            : "Ask Claude Code to build, explain or fix something…"}
          aria-label="Message Claude Code"
          onInput={() => {
            setHasText((ref.current?.value.trim().length ?? 0) > 0);
            resize();
          }}
          onKeyDown={onKeyDown}
        />
        <div class="composer__bar">
          <span class="composer__hint">
            <span class="kbd">Enter</span> to send ·{" "}
            <span class="kbd">Shift</span>+<span class="kbd">Enter</span>{" "}
            for a new line
          </span>
          {working && (
            <button
              type="button"
              class="btn btn--sm btn--danger"
              onClick={() => session.interrupt()}
              title="Stop the current turn — the session stays alive"
            >
              {IconStop({ size: 13 })} Stop
            </button>
          )}
          <button
            type="button"
            class="btn btn--primary btn--sm"
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
