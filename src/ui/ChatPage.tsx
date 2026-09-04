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
import { session, view } from "../cell/session.ts";
import { workspace } from "../cell/workspace.ts";
import type { Block, Message } from "../type/claude.ts";
import { clock, duration, oneLine } from "../lib/format.ts";
import { Banner, Elapsed, Empty } from "./parts.tsx";
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

  const messages = view().messages;

  return (
    <div class="chat" ref={ref} onScroll={onScroll}>
      <div class="thread">
        {view().error && (
          <Banner onDismiss={() => session.dismissError()}>
            {view().error}
          </Banner>
        )}
        {workspace.cliMissing && (
          <Banner tone="warn">
            The <code>claude</code>{" "}
            CLI was not found on PATH. Install Claude Code, or point{" "}
            <code>CLAUDE_BIN</code> at the binary, then start a session.
          </Banner>
        )}

        {messages.length === 0 && !view().streaming
          ? <Welcome />
          : messages.map((m) => <MessageRow key={m.id} message={m} />)}

        {view().streaming && <Streaming />}
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
  const run = view().tools.find((t) => t.id === props.id);
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
  const s = view().streaming;
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
  // How far back through the sent turns the user has walked. `-1` is "not
  // browsing" — the draft in the box is their own.
  const [recall, setRecall] = useLocal(-1);
  const working = view().status === "working";

  // Derived from the transcript rather than kept in a local list: these *are*
  // the turns this session sent, so the history survives switching pages and
  // can never drift from what is on screen.
  const history = view().messages
    .filter((m) => m.role === "user" && m.parentToolUseId === null)
    .map((m) =>
      m.blocks.filter((b) => b.kind === "text").map((b) => b.text).join("\n")
    )
    .filter((t) => t.trim() !== "");

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
    setRecall(-1);
    resize();
    void session.send(text);
  };

  /** Walk the sent turns. `step` is +1 for older, -1 for newer. */
  const browse = (step: number) => {
    const el = ref.current;
    if (!el || history.length === 0) return false;
    const next = recall + step;
    if (next < -1 || next >= history.length) return false;
    setRecall(next);
    el.value = next === -1 ? "" : history[history.length - 1 - next];
    setHasText(el.value.trim().length > 0);
    resize();
    // Caret to the end: the point of recalling a turn is to edit its tail.
    const end = el.value.length;
    el.setSelectionRange(end, end);
    return true;
  };

  const onKeyDown = (e: KeyboardEvent) => {
    const el = ref.current;

    // Recall a previous turn — but only from an empty box, or while already
    // walking the history. Stealing Up from someone editing a paragraph would
    // destroy the draft they are in the middle of writing.
    if ((e.key === "ArrowUp" || e.key === "ArrowDown") && !e.shiftKey) {
      const browsing = recall !== -1;
      const empty = (el?.value ?? "") === "";
      if ((browsing || empty) && browse(e.key === "ArrowUp" ? 1 : -1)) {
        e.preventDefault();
      }
      return;
    }
    if (e.key === "Escape" && recall !== -1) {
      e.preventDefault();
      browse(-1 - recall); // back to the empty draft
      return;
    }

    if (e.key !== "Enter") return;
    if (e.shiftKey) return; // Shift+Enter is a newline, always
    // Mid-composition Enter belongs to the input method, not to us: for anyone
    // typing Japanese, Chinese or Korean, sending here fires on the keystroke
    // that *accepts a candidate* and posts a half-finished sentence.
    // `keyCode === 229` is the same signal from browsers that predate
    // `isComposing`.
    if (e.isComposing || e.keyCode === 229) return;
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
            // Typing is editing a draft, not still walking the history.
            if (recall !== -1) setRecall(-1);
            resize();
          }}
          onKeyDown={onKeyDown}
        />
        <div class="composer__bar">
          {
            /* A turn in flight gets the clock, not just the word "working".
              The CLI goes silent while the API makes it retry — a 529 costs
              minutes with nothing on the wire — and a static "Claude is
              working" through three of those is indistinguishable from a dead
              app. The strip has carried this figure all along; this is where
              the eyes are while waiting. */
          }
          {working
            ? (
              <span
                class="composer__hint"
                title="Time since this turn was sent. The CLI says nothing while the API retries, so a long wait here is usually upstream, not a hang."
              >
                Working{" "}
                <Elapsed startedAt={view().turnStartedAt} fallbackMs={0} />
                {view().queuedTurns > 0 &&
                  ` · ${view().queuedTurns} turn${
                    view().queuedTurns === 1 ? "" : "s"
                  } queued behind it`}
              </span>
            )
            : (
              <span class="composer__hint">
                <span class="kbd">Enter</span> to send ·{" "}
                <span class="kbd">Shift</span>+<span class="kbd">Enter</span>
                {" "}
                for a new line
                {history.length > 0 && (
                  <>
                    {" · "}
                    <span class="kbd">↑</span> for the last turn
                  </>
                )}
              </span>
            )}
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
