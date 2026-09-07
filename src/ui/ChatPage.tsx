/**
 * @module
 * The main page: the conversation with Claude Code, plus the composer.
 *
 * Assistant prose renders as Markdown, thinking is folded into a quiet block,
 * and every tool call becomes a chip you can open in place — so the transcript
 * stays readable while nothing is hidden.
 */
import { go } from "./go.ts";
import { Mic } from "./Mic.tsx";
import { Speaker } from "./Speaker.tsx";
import { ClearChat } from "./ClearChat.tsx";
import {
  afterRender,
  onCleanup,
  onMount,
  useLocal,
  useRef,
  type VNode,
} from "aio/air";
import { Markdown } from "./Markdown.tsx";
import { highlight, langOfFile } from "../lib/highlight.ts";
import { session, view } from "../cell/session.ts";
import { activeSessionKey, workspace } from "../cell/workspace.ts";
import { tree } from "../cell/tree.ts";
import type { Block, Message, TurnCost } from "../type/claude.ts";
import {
  dayLabel,
  differentDay,
  duration,
  oneLine,
  perSecond,
  tokens,
  usd,
} from "../lib/format.ts";
import { Banner, Elapsed, Empty } from "./parts.tsx";
import { lastSpeed } from "../cell/session.ts";
import { JumpToLatest, MsgMeta, useStickToBottom } from "./thread.tsx";
import { FindBar, findIndex, findQuery } from "./find.tsx";
import { hits } from "../lib/transcript.ts";
import { DiffView, isEdit } from "./Diff.tsx";
import { BrowseButton } from "./AddProject.tsx";
import { slashHits, SlashMenu, slashToken } from "./SlashMenu.tsx";
import {
  dropDraft,
  fillComposer,
  loadDraft,
  saveDraft,
  swapDraft,
} from "./compose.ts";
import {
  IconChevron,
  IconLogo,
  IconSend,
  IconStop,
  IconTree,
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
  const scroll = useStickToBottom(view().messages.length);
  const messages = view().messages;
  // Which messages the find bar matched, in order. Computed here because it is
  // the page that knows what a message's text is; the bar only counts and
  // steps.
  const q = findQuery();
  const found = q.trim() === ""
    ? []
    : messages.filter((m) => hits(textOf(m), q)).map((m) => m.id);
  const current = found.length > 0
    ? found[Math.min(findIndex(), found.length - 1)]
    : "";

  // Bring the current match into view — centred, not scrolled to the edge,
  // because a match at the very bottom of the pane has no context above it.
  afterRender(() => {
    if (current === "") return;
    const el = scroll.ref.current?.querySelector<HTMLElement>(
      `[data-msg="${CSS.escape(current)}"]`,
    );
    el?.scrollIntoView({ block: "center", behavior: "smooth" });
  });

  return (
    // The wrapper is what the jump button is positioned against. It cannot be
    // the scrolling element itself: an absolutely-positioned child of a
    // scroll container scrolls away with the content, which is precisely the
    // thing the button exists to undo.
    <div class="chatwrap">
      <div class="chat" ref={scroll.ref} onScroll={scroll.onScroll}>
        {
          /* One array with the nulls filtered out, not a run of `cond &&`
            beside a keyed list: a falsy conditional still renders an UNKEYED
            child, and a list with some keys and some not reconciles the
            unkeyed ones by position — which is how a banner ends up wearing a
            message's DOM node. */
        }
        <div class="thread">
          {[
            view().error
              ? (
                <Banner key="error" onDismiss={() => session.dismissError()}>
                  {view().error}
                  {
                    /* The commonest reason a turn dies is an API overload, and
                      the only useful response to one is to send the same thing
                      again. Making the reader scroll up, select their own
                      words and retype them is the app failing twice. */
                  }
                  {view().status !== "working" &&
                    view().messages.some((m) => m.role === "user") && (
                    <button
                      type="button"
                      class="btn btn--sm"
                      style={{ marginLeft: "10px" }}
                      title="Send your last message again — the session keeps its context"
                      onClick={() => void session.retry()}
                    >
                      Try again
                    </button>
                  )}
                </Banner>
              )
              : null,
            workspace.cliMissing
              ? (
                <Banner key="cli" tone="warn">
                  The <code>claude</code>{" "}
                  CLI was not found on PATH. Install Claude Code, or point{" "}
                  <code>CLAUDE_BIN</code> at the binary, then start a session.
                </Banner>
              )
              : null,
            messages.length === 0 && !view().streaming
              ? <Welcome key="welcome" />
              : null,
            // A divider wherever the conversation crosses midnight. One
            // session routinely spans several days, and without this a reply
            // from Tuesday sits flush against a question from Thursday.
            ...messages.flatMap((m, n) => {
              const row = (
                <MessageRow
                  key={m.id}
                  message={m}
                  hit={m.id === current
                    ? "current"
                    : found.includes(m.id)
                    ? "yes"
                    : ""}
                />
              );
              const before = messages[n - 1];
              return before && differentDay(before.at, m.at)
                ? [
                  <div key={`day-${m.id}`} class="daymark">
                    <span>{dayLabel(m.at, Date.now())}</span>
                  </div>,
                  row,
                ]
                : [row];
            }),
            view().streaming ? <Streaming key="streaming" /> : null,
          ].filter(Boolean)}
        </div>
      </div>

      <FindBar total={found.length} />
      <JumpToLatest
        away={scroll.away}
        behind={scroll.behind}
        onClick={scroll.toBottom}
      />
    </div>
  );
}

function Welcome(): VNode {
  const project = workspace.projects.find((p) => p.id === workspace.activeId);

  // Nothing to talk about yet. The first thing this app needs is a folder, and
  // the first screen somebody sees should be about getting one rather than
  // about a conversation they cannot have — three suggested prompts with no
  // project to run them in is an empty promise.
  if (workspace.projects.length === 0) {
    return (
      <div style={{ paddingTop: "8vh" }}>
        <Empty
          icon={IconLogo({ size: 22 })}
          title="Point it at a codebase"
          hint="Claude Code runs inside a project directory, and so does everything here. Pick one and the session starts in it."
        >
          <div
            class="tags"
            style={{ justifyContent: "center", marginTop: "10px" }}
          >
            <BrowseButton
              label="Choose a folder"
              onPick={(picked: string) => void workspace.addProject(picked)}
            />
          </div>
        </Empty>
      </div>
    );
  }
  // Suggestions that fit what is actually in front of the model. A fixed list
  // is decoration; "what changed on this branch" is a real first question when
  // the tree is dirty and a useless one when it is clean.
  const suggestions = [
    project?.dirty
      ? "What changed in the working tree, and is any of it half-finished?"
      : "Explain this codebase's architecture",
    project?.branch && project.branch !== "main" && project.branch !== "master"
      ? `What does the ${project.branch} branch do that main does not?`
      : "What would you change first about this code?",
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
          {
            /* Put in the box rather than sent. A suggestion that starts a paid
              turn on one click is a suggestion people learn not to touch —
              and the first thing anybody wants to do with one is edit it. */
          }
          {suggestions.map((sug) => (
            <button
              key={sug}
              type="button"
              class="btn btn--sm"
              title="Put this in the message box"
              onClick={() => fillComposer(sug)}
            >
              {sug}
            </button>
          ))}
        </div>
      </Empty>
    </div>
  );
}

/** The plain text of a message — what Copy puts on the clipboard, and what
 *  Edit puts back in the box. Tool calls and thinking are left out: neither is
 *  something a person wants pasted into an issue. */
const textOf = (m: Message): string =>
  m.blocks.filter((b) => b.kind === "text").map((b) => b.text).join("\n\n");

function MessageRow(
  props: { message: Message; hit?: string },
): VNode {
  const m = props.message;
  const isUser = m.role === "user";
  const text = textOf(m);
  return (
    <article
      class={"msg" + (props.hit === "current"
        ? " msg--found"
        : props.hit === "yes"
        ? " msg--hit"
        : "")}
      data-msg={m.id}
    >
      <div class={`msg__avatar msg__avatar--${m.role}`}>
        {isUser ? IconUser({ size: 15 }) : IconLogo({ size: 15 })}
      </div>
      <div class="msg__body">
        <div class="msg__who" key="who">
          {isUser ? "You" : "Claude"}
          {
            /* A span rather than a bare conditional: the text node would come
              and go, changing this row's child count. */
          }
          <span>{m.parentToolUseId ? " · sub-agent" : ""}</span>
          {
            /* The byline carries the actions rather than a control floating
              over the text: something that overlaps the words covers the thing
              you are trying to read, and this row is already empty. */
          }
          <MsgMeta at={m.at} text={text} editable={isUser} />
        </div>
        {m.blocks.map((b, i) => <BlockView key={`${m.id}-${i}`} block={b} />)}
        {
          /* Always rendered: a receipt that comes and goes changes this row's
            child count, and the reconciler pairs the survivors by position. */
        }
        <div key="turn">{m.turn ? <TurnFooter turn={m.turn} /> : null}</div>
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
  // Only an absolute path: a tool's `file_path` is absolute by contract, and
  // selecting a relative one would silently pick nothing.
  const file = typeof props.input.file_path === "string" &&
      props.input.file_path.startsWith("/")
    ? props.input.file_path
    : "";
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
        // A stable accessible name. Without one, the announced name is the
        // whole chip — including a duration that ticks — so it changes every
        // second while the call runs, and no screen reader or test can
        // address the same control twice.
        aria-label={`${props.name} call`}
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
      {
        /* A call that names a file gets a way to that file. The transcript
          says what was done; the tree says what it looks like now, and going
          between them meant copying a path out of one and into the other. */
      }
      {file !== "" && (
        <button
          type="button"
          class="toolchip__open"
          title={`Show ${file} in the tree`}
          aria-label="Show in tree"
          onClick={() => {
            void tree.select(file);
            go("/tree");
          }}
        >
          {IconTree({ size: 12 })} in tree
        </button>
      )}
      {open && (
        <div style={{ marginTop: "6px", display: "grid", gap: "6px" }}>
          {
            /* An edit is shown as what it changes. The raw input is two walls
              of escaped string with the difference somewhere inside them, and
              "which lines changed" is the only question anybody is asking of
              an Edit call. */
          }
          <ToolInput input={props.input} />
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
        <div class="msg__who" key="who">Claude</div>
        {s.kind === "thinking"
          ? (
            <div class="think" key="body">
              <div class="think__k">Thinking</div>
              {s.text}
              <span class="caret" />
            </div>
          )
          : (
            <div class="bubble" key="body">
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
  const speed = lastSpeed();
  // The slash-command menu. `null` means the box does not hold a command
  // token, which is almost always — so almost always this costs one regex.
  const [token, setToken] = useLocal<string | null>(null);
  const [pick, setPick] = useLocal(0);
  const hits = token === null ? [] : slashHits(token);
  const at = Math.min(pick, Math.max(0, hits.length - 1));

  /** Put the chosen command in the box, with the space that follows it. */
  const complete = (name: string) => {
    const el = ref.current;
    if (!el) return;
    el.value = `/${name} `;
    setToken(null);
    setHasText(true);
    resize();
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  };

  // Derived from the transcript rather than kept in a local list: these *are*
  // the turns this session sent, so the history survives switching pages and
  // can never drift from what is on screen.
  const history = view().messages
    .filter((m) => m.role === "user" && m.parentToolUseId === null)
    .map((m) =>
      m.blocks.filter((b) => b.kind === "text").map((b) => b.text).join("\n")
    )
    .filter((t) => t.trim() !== "");

  // Which conversation this box belongs to. The PANE, not the project: a
  // project can hold several chats, they share this one textarea, and keying
  // by project meant switching between two of them swapped nothing — the
  // half-written message stayed on screen, now aimed at the other one.
  const where = activeSessionKey();
  const shownFor = useRef(where);

  onMount(() => {
    const el = ref.current;
    if (!el) return;
    // Whatever was left here last time. The composer is unmounted every time
    // you look at Settings or the tree, so "still in the box" is only true
    // while you stay on this page — without this, walking away lost it.
    const kept = loadDraft(where);
    if (kept !== "") {
      el.value = kept;
      setHasText(kept.trim().length > 0);
      resize();
    }
    el.focus();
  });

  // Leaving the page at all: keep it. Read from the element rather than from
  // state, because the element is the only thing that has the current text —
  // that is the whole reason this box is uncontrolled.
  onCleanup(() => saveDraft(shownFor.current, ref.current?.value ?? ""));

  // Switching conversation while the composer stays on screen.
  afterRender(() => {
    const el = ref.current;
    if (!el || shownFor.current === where) return;
    el.value = swapDraft(shownFor.current, where, el.value);
    shownFor.current = where;
    setHasText(el.value.trim().length > 0);
    setRecall(-1);
    resize();
  });

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
    dropDraft(where);
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

    // The command menu owns the arrows, Tab, Enter and Escape while it is up.
    // Everything below only sees a keystroke the menu did not want.
    if (hits.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setPick(Math.min(at + 1, hits.length - 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setPick(Math.max(at - 1, 0));
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setToken(null);
        return;
      }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
        if (e.isComposing || e.keyCode === 229) return;
        e.preventDefault();
        complete(hits[at].name);
        return;
      }
    }

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
    // Ctrl+Enter sends too. Plenty of chat apps make it the *only* way to
    // send, so people arrive with the habit — and here it can never be wrong:
    // there is nothing else it could mean in a message box.
    if (e.shiftKey && !(e.ctrlKey || e.metaKey)) return; // Shift+Enter: newline
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
      <SlashMenu
        hits={hits}
        index={at}
        onPick={complete}
        onHover={setPick}
      />
      <div class="composer__inner">
        <textarea
          ref={ref}
          rows={1}
          placeholder={working
            ? "Claude is working — your next turn will be queued…"
            : "Ask Claude Code to build, explain or fix something…"}
          aria-label="Message Claude Code"
          onInput={() => {
            const value = ref.current?.value ?? "";
            setHasText(value.trim().length > 0);
            const next = slashToken(value);
            if (next !== token) {
              setToken(next);
              setPick(0);
            }
            // Typing is editing a draft, not still walking the history.
            if (recall !== -1) setRecall(-1);
            resize();
          }}
          onKeyDown={onKeyDown}
        />
        <div class="composer__bar">
          <Mic key="mic" />
          <Speaker key="speaker" />
          <ClearChat key="clear" />
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
                key="working"
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
              <span key="idle" class="composer__hint">
                <span class="kbd">Enter</span> to send ·{" "}
                <span class="kbd">Shift</span>+<span class="kbd">Enter</span>
                {" "}
                for a new line
                {
                  /* Each optional part lives inside a wrapper that is always
                    rendered. A conditional sibling among static text changes
                    the child COUNT when it flips, and the reconciler pairs
                    the survivors up by position — which is how a hint about
                    the last turn ended up wearing the keyboard hint's node. */
                }
                <span>
                  {history.length > 0
                    ? (
                      <>
                        {" · "}
                        <span class="kbd">↑</span> for the last turn
                      </>
                    )
                    : null}
                </span>
                {
                  /* How fast the last turn actually went. Over the whole turn,
                    tools and API waits included — which is what "slow" means to
                    the person who waited, and the only figure that would have
                    told them the 529 retry was upstream. */
                }
                <span
                  title={speed === null
                    ? undefined
                    : "Output tokens per second over the whole of the last turn — tool calls and API waits included."}
                  style={{ color: "var(--ink-dim)" }}
                >
                  {speed === null
                    ? ""
                    : ` · ${
                      speed >= 10 ? Math.round(speed) : speed.toFixed(1)
                    } tok/s`}
                </span>
              </span>
            )}
          {working
            ? (
              <button
                key="stop"
                type="button"
                class="btn btn--sm btn--danger"
                onClick={() => session.interrupt()}
                title="Stop the current turn — the session stays alive"
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

/**
 * A tool call's input, shown as the thing it actually is.
 *
 * Three of the tools carry text a person reads rather than an object a machine
 * consumes, and rendering those as pretty-printed JSON — escaped newlines and
 * all — is the difference between "I can see what it will do" and "I could
 * work out what it will do". Everything else falls through to the JSON, which
 * is still the honest rendering of a structure.
 */
function ToolInput(props: { input: Record<string, unknown> }): VNode {
  const input = props.input;

  if (isEdit(input)) {
    const view = (
      <DiffView
        before={String(input.old_string)}
        after={String(input.new_string)}
      />
    );
    // `DiffView` answers `null` for an edit too large to diff — a fallback,
    // not an error, and the raw JSON below is what it falls back to.
    if (view !== null) return view;
  }

  // A new file: its contents, coloured as whatever the extension says it is.
  if (
    typeof input.content === "string" && typeof input.file_path === "string"
  ) {
    return <Code text={input.content} lang={langOfFile(input.file_path)} />;
  }

  // A command: the command, as a shell would see it. Escaped inside JSON it is
  // unreadable and — worse — uncopyable.
  if (typeof input.command === "string") {
    return <Code text={input.command} lang="bash" />;
  }

  return <Code text={JSON.stringify(input, null, 2)} lang="json" />;
}

/** A block of coloured text. The one place in this file that turns tokens into
 *  spans, so the three branches above cannot render differently. */
function Code(props: { text: string; lang: string }): VNode {
  return (
    <div class="code">
      {highlight(props.text, props.lang).map((t, n) =>
        t.kind === "plain"
          ? t.text
          : <span key={n} class={`tok tok--${t.kind}`}>{t.text}</span>
      )}
    </div>
  );
}

/**
 * What the turn this message ended actually took.
 *
 * Quiet, one line, under the answer it belongs to. Every figure is the CLI's
 * own: the duration it reported, the output tokens it counted, and the
 * difference between two session totals — which is the only per-turn cost
 * there is. A figure the CLI did not report is left out rather than guessed.
 */
function TurnFooter(props: { turn: TurnCost }): VNode {
  const t = props.turn;
  const speed = perSecond(t.tokens, t.ms);
  return (
    <div class="turnfoot">
      <span>{duration(t.ms)}</span>
      {t.tokens > 0 && <span>{tokens(t.tokens)} out</span>}
      {speed !== null && (
        <span>{speed >= 10 ? Math.round(speed) : speed.toFixed(1)} tok/s</span>
      )}
      {t.usd > 0 && <span>{usd(t.usd)}</span>}
    </div>
  );
}
