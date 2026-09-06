/**
 * @module
 * The Console: a real terminal, in the app.
 *
 * The shell on the other end is a real process on a kernel pseudo-terminal
 * (see `cell/pty.server.ts` and `native/pty`), so everything a terminal can do
 * works here — `vim`, `htop`, `git rebase -i`, tab completion, `Ctrl-C`,
 * colours, and `claude attach` for a background session that stopped to ask
 * something.
 *
 * The emulator is xterm.js, which is what VS Code uses. That is a deliberate
 * choice over writing one: "fully working" for a terminal means the alternate
 * screen buffer, scroll regions, every SGR attribute, wide characters,
 * combining marks, mouse reporting and bracketed paste — a decade of edge cases
 * that stay invisible until the day somebody runs the program that needs them.
 *
 * This component owns three things and nothing else: the emulator's lifetime,
 * the palette it draws in, and the loop that moves bytes between it and the
 * cell.
 */
import { worksInTerminal } from "./commands.ts";
import { afterRender, onCleanup, onMount, useRef, type VNode } from "aio/air";
// Vendored, not imported from npm.
//
// In development aio rewrites a bare npm specifier to a CDN URL, which this
// app's content-security policy blocks — correctly: an app that fetches its
// terminal emulator from the internet at runtime is an app that stops working
// on a train. `deno task vendor:xterm` writes the file next door, and it is
// committed. Vendoring also settles the CommonJS shape once, at bundle time,
// rather than differently in each of the two bundlers that load this app.
import { FitAddon, Terminal } from "./vendor/xterm.js";

import {
  activeTerminalId,
  consoleCell,
  terminalById,
} from "../cell/console.ts";
import { activePane, activeProject, workspace } from "../cell/workspace.ts";
import { prefs } from "../cell/prefs.ts";
import { Banner, Empty } from "./parts.tsx";
import { PageHead } from "./RunViews.tsx";
import { IconPlay, IconPower, IconTerminal } from "./icons.tsx";
import { BrowseButton } from "./AddProject.tsx";

/**
 * What the terminal has already drawn, per project, kept outside the component.
 *
 * Leaving the page destroys the emulator; coming back has to redraw what was
 * there, or the shell appears to have forgotten its own scrollback. The cell
 * cannot hold this — its queue is drained as it is consumed, which is what
 * keeps it bounded — so the *drawn* copy lives here, in the window, for as long
 * as the window does.
 */
const drawn = new Map<string, { text: string; upTo: number }>();

/** How much redraw history is kept. Enough to fill a tall window several times
 *  over; past that the oldest goes, exactly as scrollback always has. */
const MAX_REDRAW = 256 * 1024;

/**
 * Read one CSS custom property off the document.
 *
 * The terminal draws on a canvas, so it inherits nothing — every colour has to
 * be handed over as a value, and they have to be *this* app's values or the
 * Console becomes the one panel that ignores the theme.
 */
function token(name: string, fallback: string): string {
  if (typeof document === "undefined") return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name);
  return v.trim() || fallback;
}

/** The terminal palette, from the app's own tokens. */
function palette() {
  return {
    background: token("--panel", "#11141c"),
    foreground: token("--ink", "#e9edf6"),
    cursor: token("--accent", "#e07a58"),
    cursorAccent: token("--panel", "#11141c"),
    selectionBackground: token("--accent-soft", "rgba(224,122,88,.3)"),
    black: token("--panel-2", "#161a24"),
    red: token("--danger", "#f6685e"),
    green: token("--ok", "#46c46b"),
    yellow: token("--warn", "#e3b341"),
    blue: token("--info", "#63a4ff"),
    magenta: token("--violet", "#a982f5"),
    cyan: "#4fd6c8",
    white: token("--ink-soft", "#99a3b8"),
    brightBlack: token("--ink-dim", "#6b7589"),
    brightRed: token("--danger", "#f6685e"),
    brightGreen: token("--ok", "#46c46b"),
    brightYellow: token("--warn", "#e3b341"),
    brightBlue: token("--info", "#63a4ff"),
    brightMagenta: token("--violet", "#a982f5"),
    brightCyan: "#7ee8dd",
    brightWhite: token("--ink", "#e9edf6"),
  };
}

export function ConsolePage(): VNode {
  const project = activeProject();
  // The pane on screen when it is a shell; otherwise this project's newest one.
  // Looking at a conversation does not change which shell the Console shows.
  const pane = activePane();
  const id = pane?.kind === "console" ? pane.id : activeTerminalId();
  const term = terminalById(id);

  if (!project) {
    return (
      <div class="page">
        <div class="page__body">
          <Empty
            icon={IconTerminal({ size: 20 })}
            title="A shell runs inside a project"
            hint="Pick a folder and the terminal opens in it, with your own shell, your prompt and your tools."
          >
            <div class="tags" style={{ justifyContent: "center" }}>
              <BrowseButton
                label="Choose a folder"
                onPick={(picked: string) => void workspace.addProject(picked)}
              />
            </div>
          </Empty>
        </div>
      </div>
    );
  }

  // No shell in this project yet. The page offers one rather than showing an
  // empty box: a terminal that has to be summoned from a different column is a
  // terminal people stop using.
  if (id === "") {
    return (
      <div class="page">
        <div class="page__body">
          <Empty
            icon={IconTerminal({ size: 20 })}
            title="No shell open here"
            hint={`A console runs in ${project.path}, with your own shell and your own prompt.`}
          >
            <button
              type="button"
              class="btn btn--primary btn--sm"
              onClick={async () => {
                const made = await workspace.addPane(project.id, "console");
                if (made) await consoleCell.open(made, project.id);
              }}
            >
              {IconPlay({ size: 13 })} Open a console
            </button>
          </Empty>
        </div>
      </div>
    );
  }

  return (
    <div class="page">
      <PageHead
        scope="project"
        title={pane?.kind === "console" ? pane.title : "Console"}
        sub={term.status === "live"
          ? `${term.shell} · ${term.cols}×${term.rows}`
          : term.status === "exited"
          ? `exited ${term.exitCode ?? 0}`
          : "not started"}
        actions={
          <>
            {term.status === "live"
              ? (
                <button
                  key="end"
                  type="button"
                  class="btn btn--sm"
                  title="End this shell — its children go with it, the way closing a terminal window ends them"
                  onClick={() => void consoleCell.stop(id)}
                >
                  {IconPower({ size: 13 })} End
                </button>
              )
              : (
                <button
                  key="end"
                  type="button"
                  class="btn btn--sm btn--primary"
                  onClick={() => void consoleCell.start(id)}
                >
                  {IconPlay({ size: 13 })}{" "}
                  {term.status === "exited" ? "Start again" : "Start"}
                </button>
              )}
          </>
        }
      />
      <div class="page__body console__body">
        {
          /* Always rendered: a banner that comes and goes changes this row's
            child count, and the reconciler pairs the survivors by position. */
        }
        <div key="error">
          {term.error ? <Banner tone="warn">{term.error}</Banner> : null}
        </div>
        <TerminalView key={id} terminalId={id} />
      </div>
    </div>
  );
}

/**
 * The emulator, and the loop that feeds it.
 *
 * Keyed by project, so switching project tears this down and builds a new one —
 * two projects' shells must never share a screen, and the alternative (one
 * emulator, cleared and refilled) is the kind of thing that shows the wrong
 * scrollback exactly once, in front of somebody.
 */
function TerminalView(props: { terminalId: string }): VNode {
  // Read during RENDER, not only in the effect below.
  //
  // AIR subscribes a component to whatever its render body reads. This one
  // returns a single empty div, so without touching the queue here it would
  // subscribe to nothing, never re-render, and the effect that draws output
  // would run exactly once — a terminal that connects, says nothing, and looks
  // broken. Which is precisely what it did.
  const state = terminalById(props.terminalId);
  const pending = state.out.length;
  const base = state.base;

  const host = useRef<HTMLDivElement | null>(null);
  // deno-lint-ignore no-explicit-any
  const term = useRef<any>(null);
  // The absolute index this view has drawn up to. Compared against the cell's
  // own index, which is how a missed chunk becomes *detectable* rather than a
  // silent gap in somebody's build output.
  const upTo = useRef(0);

  onMount(() => {
    const el = host.current;
    if (!el) return;

    const t = new Terminal({
      allowProposedApi: true,
      // The window's own zoom already scales everything; a second scale here
      // would compound with it.
      fontSize: 13,
      fontFamily:
        'ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace',
      lineHeight: 1.2,
      cursorBlink: true,
      // A real terminal's worth. The redraw buffer above is separate and much
      // smaller, because it only has to survive leaving the page.
      scrollback: 10_000,
      theme: palette(),
      macOptionIsMeta: true,
    });
    // Let the app's own navigation through.
    //
    // A focused terminal takes every keystroke, which is what a terminal is
    // for — but it meant that clicking into a shell disabled moving around the
    // app until you clicked back out. Returning `false` tells xterm to neither
    // handle the event nor call `preventDefault` on it, so it carries on
    // bubbling to the window and the ordinary shortcut fires.
    //
    // Which chords those are is decided in one place, beside the shortcuts
    // themselves, so a key cannot be listed in help as working everywhere and
    // then be swallowed here. Everything else still belongs to the shell.
    t.attachCustomKeyEventHandler((e: KeyboardEvent) =>
      !(e.type === "keydown" && worksInTerminal(e))
    );

    const f = new FitAddon();
    t.loadAddon(f);
    t.open(el);
    term.current = t;

    // Redraw whatever this project's terminal had on screen before the page was
    // left. Written straight in, escape sequences and all — it is the same byte
    // stream, so it reconstructs the same screen.
    const seen = drawn.get(props.terminalId);
    if (seen) {
      t.write(seen.text);
      upTo.current = seen.upTo;
    }

    // Keystrokes. Everything: printable characters, arrows, Ctrl-C as the byte
    // 0x03, a pasted block, an escape sequence from a mouse click. None of it
    // is interpreted here — that is the shell's job, and second-guessing it is
    // how a terminal ends up not being one.
    const typed = t.onData((data: string) => {
      void consoleCell.send(props.terminalId, data);
    });

    // Size. The kernel raises SIGWINCH from the resize, which is how a
    // full-screen program learns to redraw itself.
    const measure = () => {
      // A terminal that has been disposed answers `rows` and `cols` by
      // reaching into a core that is no longer there, and the throw comes out
      // of whatever called this — a resize observer, a window listener — where
      // there is nobody to catch it. Guarding only `fit()` was not enough: the
      // uncaught "reading 'dimensions'" in the logs is the line BELOW it.
      //
      // It happens on an ordinary move between two shells: the old view is
      // torn down while its observers still have a callback in flight.
      if (term.current !== t) return;
      try {
        f.fit();
        void consoleCell.resize(props.terminalId, t.rows, t.cols);
      } catch { /* not laid out yet, or gone */ }
    };
    measure();
    // …and again once the browser has actually laid the panel out. The first
    // measurement happens inside the same frame the element was added in, so
    // it sees whatever width the box had before the grid settled — which came
    // out as a 70-column terminal in an 80-column panel, with the shell told
    // the wrong size and every full-screen program wrapping early.
    requestAnimationFrame(() => {
      if (term.current === t) measure();
    });

    const win = el.ownerDocument.defaultView;
    const onResize = () => measure();
    win?.addEventListener("resize", onResize);
    // The window is not the only thing that changes this element's size: so
    // does collapsing a side panel, or changing the density.
    const ro = typeof ResizeObserver === "function"
      ? new ResizeObserver(() => measure())
      : null;
    ro?.observe(el);

    // Start it if it has never run, or has ended, or is a tab that came back
    // from a previous launch with no shell behind it. Coming back to a live
    // one simply reattaches — `start` refuses a terminal that is already
    // running, so this is safe to ask for on every mount.
    const status = terminalById(props.terminalId).status;
    if (status === "off" || status === "exited") {
      void consoleCell.start(props.terminalId, t.rows, t.cols);
    }
    void consoleCell.watch(props.terminalId);
    t.focus();

    onCleanup(() => {
      // Cleared FIRST. Everything that might still fire — an observer callback
      // already queued, a listener mid-flight — checks this to decide whether
      // the terminal it closed over is still the live one.
      term.current = null;
      typed.dispose();
      win?.removeEventListener("resize", onResize);
      ro?.disconnect();
      void consoleCell.unwatch(props.terminalId);
      t.dispose();
    });
  });

  // Drain whatever the cell is holding, every render. The cell keeps output in
  // an indexed list precisely so this can start from where it stopped rather
  // than from whatever happened to be the latest value.
  afterRender(() => {
    const t = term.current;
    if (!t) return;
    // The two values read during render, so this effect and the subscription
    // above can never disagree about which chunks are on the page.
    if (pending === 0) return;
    const state = terminalById(props.terminalId);

    if (upTo.current < state.base) {
      // Output was discarded while nobody was watching. Said out loud: a build
      // whose middle is missing, presented seamlessly, is worse than one that
      // admits the gap.
      const lost = state.base - upTo.current;
      t.write(
        "\r\n\x1b[38;5;244m-- " + lost +
          " chunks of output were dropped while the Console was closed --\x1b[0m\r\n",
      );
      upTo.current = state.base;
    }
    const from = Math.max(0, upTo.current - state.base);
    const text = state.out.slice(from).join("");
    if (text !== "") t.write(text);

    const next = state.base + state.out.length;
    upTo.current = next;
    // Tell the server it is safe to let go — and, while this page is open, that
    // it may keep reading. This acknowledgement is what makes the pipeline
    // lossless rather than best-effort.
    void consoleCell.ack(props.terminalId, next);

    // Keep a copy for the next time this page is opened.
    const seen = drawn.get(props.terminalId) ?? { text: "", upTo: 0 };
    seen.text = (seen.text + text).slice(-MAX_REDRAW);
    seen.upTo = next;
    drawn.set(props.terminalId, seen);
  });

  // The palette follows the theme. Read here so the effect re-runs when either
  // changes: a terminal whose colours lag a theme switch by one navigation is
  // the kind of thing nobody reports and everybody notices.
  afterRender(() => {
    const t = term.current;
    if (!t) return;
    void prefs.accent;
    void workspace.theme;
    t.options.theme = palette();
  });

  // `data-at` is the drain position, written so the rendered output actually
  // depends on what was read above — an attribute nobody looks at, and the
  // difference between a subscription and a promise of one.
  return <div class="console" ref={host} data-at={`${base}+${pending}`} />;
}
