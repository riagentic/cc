/**
 * @module
 * The Console: one real shell per project, and the pipe that carries it.
 *
 * The terminal itself is a `native/pty` host holding a kernel PTY; this cell is
 * the part that has to get bytes across the bridge to a browser without
 * dropping them and without letting a runaway command eat the window.
 *
 * # How the bytes travel
 *
 * Output is an append-only list of chunks with an index, not a growing string
 * and not a single "latest chunk" field. A string would re-send the whole
 * scrollback on every patch; a latest-chunk field would lose everything the
 * renderer did not happen to observe, and a state sync is allowed to coalesce.
 * An indexed list is the only shape that is cheap to append to *and* impossible
 * to silently skip: the page writes from where it left off, and knows when it
 * was left behind because the index says so.
 *
 * # Why it cannot fill memory
 *
 * While somebody is looking, the page acknowledges what it has drawn and the
 * reader waits when the queue is deep — the pipe fills, the host stops reading
 * the PTY, and the kernel blocks the shell. That is exactly what happens to a
 * real terminal that cannot keep up, and it is why `yes | head` ends.
 *
 * While nobody is looking, the shell keeps running — a build does not stop
 * because you switched tabs — and the oldest output is discarded past a cap,
 * the way scrollback has always worked. The page says so on its way back in
 * rather than pretending it has the whole story.
 */
import { cell, log } from "aio";
import { panesOf, projectOfPane, workspace } from "./workspace.ts";

/** Chunks kept for a session nobody is watching. Past this the oldest go, and
 *  the page is told how many. A few thousand chunks is minutes of a chatty
 *  build and a fraction of a megabyte. */
const MAX_UNWATCHED = 2_000;

/** Queue depth at which the reader waits for the page to catch up. Deep enough
 *  that ordinary output never stalls, shallow enough that a runaway command is
 *  throttled within a frame or two. */
const BACKPRESSURE_AT = 96;

export type TerminalStatus = "off" | "starting" | "live" | "exited";

export type Terminal = {
  /** Which project this shell belongs to. A terminal is not a floating window:
   *  it was opened in a directory, for a codebase, and it stays with it. */
  projectId: string;
  /** What the tab calls it — "Console", "Console 2", "dev", "production". */
  title: string;
  /** The command this terminal was opened to run, when it was opened to run
   *  one rather than to be typed into. Kept so a finished launcher can say what
   *  it ran, and be started again. */
  command: string;
  /** When it was created, so the list keeps the order they were made in. */
  createdAt: number;
  status: TerminalStatus;
  /** What the shell exited with, once it has. */
  exitCode: number | null;
  /** Why it could not start, in a sentence. */
  error: string | null;
  /** Where the shell was started, and what it is. */
  cwd: string;
  shell: string;
  /** Output the page has not acknowledged yet, oldest first. */
  out: string[];
  /** The absolute index of `out[0]`. Rises as chunks are acknowledged, or
   *  discarded while nobody was watching. */
  base: number;
  /** Chunks thrown away because nobody was reading. Non-zero means the page is
   *  missing output, and it says so rather than showing a seamless lie. */
  lost: number;
  /** How many pages are showing this terminal. Zero means "keep it running,
   *  but do not hold output for a reader who is not there". */
  watchers: number;
  /** The size the page last reported. Kept so a restart opens at the size the
   *  window actually is. */
  rows: number;
  cols: number;
  /**
   * Which run of this terminal is current.
   *
   * Starting one ends whatever was there, and the old host's exit callback
   * arrives *after* the new one has published "live" — which flipped the fresh
   * terminal straight to "exited" and left a working shell looking dead. Every
   * callback carries the number it was made with, and a stale one writes
   * nothing. The session cell solves the identical problem the identical way.
   */
  run: number;
  /**
   * A command is holding the terminal's foreground right now.
   *
   * Reported by the host from `tcgetpgrp`, not guessed from output: a shell
   * sitting at a prompt is NOT busy however much it printed a moment ago, and
   * `sleep 30` IS busy though it prints nothing at all. This is the difference
   * between a light that means something and a light that is always on.
   */
  busy: boolean;
  /**
   * What is running, as the kernel names it: the executable alone, no path and
   * no arguments. Empty when nothing is.
   *
   * The tab shows this, and it is why the name comes from the kernel rather
   * than from the command line the user typed. A tab reading `deno run -A
   * --unstable-kv src/app.ts` is a tab nobody can read, and cutting that back
   * down to `deno` is guessing at something already known exactly.
   */
  running: string;
};

const blank = (projectId = "", title = "Console"): Terminal => ({
  projectId,
  title,
  command: "",
  createdAt: Date.now(),
  status: "off",
  busy: false,
  running: "",
  exitCode: null,
  error: null,
  cwd: "",
  shell: "",
  out: [],
  base: 0,
  lost: 0,
  watchers: 0,
  rows: 24,
  cols: 80,
  run: 0,
});

type ConsoleState = {
  /**
   * Every terminal in the app, by its own id.
   *
   * Flat rather than nested under a project, because a terminal's identity is
   * its own: it is addressed by id from the dock, from a route and from `am`,
   * and a nested shape would make every one of those a two-part lookup that
   * can disagree with itself.
   */
  terms: Record<string, Terminal>;
  /** Which terminal each project is showing. */
  active: Record<string, string>;
};

/* ── plain helpers ────────────────────────────────────────────────────────────
 *
 * The same reason as everywhere else in this app: a nested same-cell call runs
 * as its own transaction against committed state, so a method that called
 * another could not see the write it was halfway through making.
 */

/**
 * The terminal for an id, created on first use.
 *
 * Only the two methods that *own* a terminal use this — `open` and `start`.
 * Everything else uses `peek`, because a record created by a watcher is a
 * record with no project behind it, and `startAt` then cannot find the
 * directory to spawn in: it returns quietly and the tab sits at "not started"
 * with a button that does nothing. That is exactly what happened.
 */
function at(s: ConsoleState, id: string): Terminal {
  return (s.terms[id] ??= blank());
}

/** The terminal for an id, or `null`. For everything that observes one rather
 *  than owning it. */
function peek(s: ConsoleState, id: string): Terminal | null {
  return s.terms[id] ?? null;
}

/**
 * Open the shell for a terminal that already has a record.
 *
 * A plain function taking the draft, like every other shared step in this app:
 * a nested same-cell call would run as its own transaction against committed
 * state and could not see the record its caller has just written.
 */
async function startAt(s: ConsoleState, id: string): Promise<void> {
  const term = s.terms[id];
  if (!term) return;
  const project = workspace.projects.find((p) => p.id === term.projectId);
  if (!project) return;
  // Two starts for one terminal, and the second kills the first: `open` in
  // `pty.server` closes any session already under the key. It happens for
  // real — the dock opens a launcher's terminal and the page it navigates to
  // asks for a start of its own, milliseconds apart. The status field cannot
  // be the guard, because each caller writes it into its OWN draft and
  // neither sees the other's until it commits. This set is module state, so
  // both see it immediately.
  if (STARTING.has(id)) return;
  STARTING.add(id);
  try {
    await startNow(s, id, term, project.path);
  } finally {
    STARTING.delete(id);
  }
}

/** Starts held open right now — see `startAt`. */
const STARTING = new Set<string>();

/**
 * Run numbers come from here, not from the terminal record.
 *
 * The token exists so a dead run's callbacks cannot write into its
 * replacement. Taken as `term.run + 1` it failed at exactly the moment it was
 * needed: two drafts of the same record both read 0 and both produced 1, and
 * the old host's exit then matched the new run and marked a running shell
 * "exited". A counter in module scope cannot hand out the same number twice.
 */
let RUNS = 0;

async function startNow(
  s: ConsoleState,
  id: string,
  term: Terminal,
  cwd: string,
): Promise<void> {
  const run = (term.run = ++RUNS);
  term.status = "starting";
  term.busy = false;
  term.running = "";
  term.error = null;
  term.exitCode = null;
  term.out = [];
  term.base = 0;
  term.lost = 0;

  const io = await import("./pty.server.ts");
  let started: { shell: string };
  try {
    started = await io.open(id, {
      // `null` means "the user's own shell". Which one that is can only be
      // decided on the server — `Deno.env` does not exist in a browser, and a
      // cell runs in both.
      shell: null,
      args: [],
      cwd,
      rows: term.rows,
      cols: term.cols,
      env: {
        TERM: "xterm-256color",
        COLORTERM: "truecolor",
        // So a script can tell, and so a `claude` started in here does not
        // mistake this for one of its own pipes.
        CC_CONSOLE: "1",
      },
      // A launcher runs its command as the first thing typed at the prompt, so
      // it appears in the shell's own history and can be re-run with Up — and
      // so the prompt survives it, with the failure still on screen. The host
      // holds it until the shell speaks; see `Session.typeWhenReady`.
      typeWhenReady: term.command === "" ? "" : term.command + "\n",
    }, {
      onData: (text) => consoleCell.push(id, text, run),
      onExit: (code) => consoleCell.ended(id, code, run),
      onBusy: (busy, name) => consoleCell.setBusy(id, busy, name, run),
      isBehind: () => queueDepth(id) >= BACKPRESSURE_AT,
    });
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    const live = s.terms[id];
    if (live && live.run === run) {
      live.status = "off";
      live.error = why;
    }
    log.warn("console", "could not start a terminal", { id, error: why });
    return;
  }

  const live = s.terms[id];
  // Superseded while the host was starting: another start has already taken
  // over this terminal, and this one's writes belong to a run nobody is
  // watching.
  if (!live || live.run !== run) return;
  live.status = "live";
  live.cwd = cwd;
  live.shell = started.shell;
}

/**
 * Tell the dock a shell's tab has gone.
 *
 * Fire-and-forget across cells, the same shape the workspace uses to tell the
 * session cell about a project change: the console cell owns terminals and the
 * workspace owns panes, and neither should be waiting on the other to finish.
 */
function closedPane(id: string): void {
  void import("./workspace.ts").then((m) => m.workspace.removePane(id)).catch(
    (e) => {
      log.warn("console", "could not close the tab of a finished shell", {
        error: e instanceof Error ? e.message : String(e),
      });
    },
  );
}

/** A project's terminals, oldest first — the order the tab lists them in. */
export const terminalsOf = (projectId: string): [string, Terminal][] =>
  Object.entries(consoleCell.terms)
    .filter(([, t]) => t.projectId === projectId)
    .sort((a, b) => a[1].createdAt - b[1].createdAt);

export const consoleCell = cell("console", {
  // A terminal is a running process. Persisting a copy of its output would
  // restore a screenful of a shell that is no longer there.
  persist: "none",

  // Live reads and incremental commits, like the session cell and for the same
  // reason: `push` is a sync reducer fed by a process, and it runs while the
  // async methods around it are suspended. Snapshot isolation would refuse
  // half of them.
  transaction: false,

  state: {
    terms: {} as Record<string, Terminal>,
    active: {} as Record<string, string>,
  },

  onDestroy() {
    // Every shell, not just the one on screen. Killing the host closes the
    // master side, and the kernel hangs up the session — the same thing that
    // happens when a terminal window closes.
    void import("./pty.server.ts").then((io) => io.closeAll()).catch(() => {});
  },

  methods: {
    /**
     * Make a terminal for a project, and start it.
     *
     * A project may have several. They are separate shells in the same
     * directory — which is what a second terminal window has always been — and
     * a build running in one does not stop because you typed in another.
     *
     * `command`, when given, is run instead of leaving the shell at a prompt.
     * The shell stays afterwards, so a launcher that fails leaves its error on
     * screen with a prompt under it rather than closing over the evidence.
     */
    async open(
      s: ConsoleState,
      id: string,
      projectId: string,
      opts?: { title?: string; command?: string; rows?: number; cols?: number },
    ): Promise<string> {
      if (typeof id !== "string" || id === "") return "";
      const pid = projectId || workspace.activeId;
      if (!pid) return "";
      const project = workspace.projects.find((p) => p.id === pid);
      if (!project) return "";

      // The id comes from the caller because it is a *pane* id: the dock makes
      // the pane, and the terminal is what fills it. One identifier for both,
      // so nothing has to map between two.
      // `||`, not `??`: an empty title is "no title", the same as a missing
      // one. Callers pass "" rather than `undefined` because these arguments
      // cross a JSON wire, and `??` would have let that empty string through
      // as the tab's name.
      const term = blank(pid, opts?.title || "Console");
      term.command = opts?.command ?? "";
      if (opts?.rows) term.rows = Math.trunc(opts.rows);
      if (opts?.cols) term.cols = Math.trunc(opts.cols);
      s.terms[id] = term;
      s.active[pid] = id;
      await startAt(s, id);
      return id;
    },

    /**
     * Start, or start again, the terminal with this id.
     *
     * A terminal that is already starting or running is left alone: the page
     * asks for a start the moment it mounts, and the dock asks for one when it
     * makes the pane — two requests for the same shell, milliseconds apart, and
     * the second used to kill the first.
     */
    async start(s: ConsoleState, id: string, rows?: number, cols?: number) {
      if (typeof id !== "string" || id === "") return;
      // A pane with no terminal behind it. Panes are remembered across
      // restarts and shells are not — a running process is not a document —
      // so every console tab comes back on the next launch with nothing behind
      // it, and this is what puts a shell back into it.
      if (!s.terms[id]) {
        const pane = panesOf().find((p) => p.id === id) ??
          Object.values(workspace.panes).flat().find((p) => p.id === id);
        const pid = projectOfPane(id);
        if (!pane || pid === "") return;
        const back = blank(pid, pane.title);
        // A launcher's tab remembers what it runs, so "Start again" after a
        // restart runs `deno task dev` rather than opening a bare prompt under
        // a heading that says `dev`.
        back.command = pane.command ?? "";
        s.terms[id] = back;
      }
      const term = s.terms[id];
      // A record whose project went missing — from an older build, or a
      // watcher that got there first. Repaired rather than refused: the pane
      // knows which project it belongs to.
      if (term.projectId === "") {
        const pid = projectOfPane(id);
        if (pid === "") return;
        term.projectId = pid;
      }
      if (term.status === "live" || term.status === "starting") return;
      if (typeof rows === "number" && rows > 0) term.rows = Math.trunc(rows);
      if (typeof cols === "number" && cols > 0) term.cols = Math.trunc(cols);
      await startAt(s, id);
    },

    /** Show this terminal in its project's Console page. */
    select(s: ConsoleState, id: string) {
      const term = s.terms[id];
      if (!term) return;
      s.active[term.projectId] = id;
    },

    /**
     * End a terminal and forget it.
     *
     * Separate from `stop`, which leaves the record so the page can say what
     * happened. This is the tab being closed.
     */
    async remove(_s: ConsoleState, id: string) {
      // Orchestrator only. A draft held across an await republishes the state
      // this method ENTERED with, and killing a shell takes long enough for
      // real output — from the *other* terminals — to arrive in the gap and be
      // thrown away. So: end the shell here, forget it in a sync method.
      const io = await import("./pty.server.ts");
      await io.close(id);
      await consoleCell.forget(id); // aiol-ok: orchestration, after the close
    },

    /** The write half of {@link remove}. */
    forget(s: ConsoleState, id: string) {
      const term = s.terms[id];
      if (!term) return;
      const pid = term.projectId;
      delete s.terms[id];
      if (s.active[pid] === id) {
        // Fall back to another of the project's terminals, newest first, so
        // closing one does not land the reader on an empty page.
        const next = Object.entries(s.terms)
          .filter(([, t]) => t.projectId === pid)
          .sort((a, b) => b[1].createdAt - a[1].createdAt)[0];
        if (next) s.active[pid] = next[0];
        else delete s.active[pid];
      }
    },

    /**
     * Output arrived.
     *
     * Sync, and called straight from the reader — the same shape as the Claude
     * session's `ingest`, for the same reason: it is a reducer over a process's
     * output, and putting a scheduler between the two would only add latency to
     * a terminal.
     */
    push(s: ConsoleState, key: string, text: string, run?: number) {
      if (typeof text !== "string" || text === "") return;
      const term = peek(s, key);
      if (!term) return;
      // Output from a host that has been replaced. Dropping it is the point:
      // it belongs to a screen nobody is looking at any more.
      if (typeof run === "number" && run !== term.run) return;
      term.out.push(text);
      // Nobody watching: keep the shell running, keep the newest, and count
      // what went — which is what scrollback has always done.
      if (term.watchers === 0 && term.out.length > MAX_UNWATCHED) {
        const drop = term.out.length - MAX_UNWATCHED;
        term.out.splice(0, drop);
        term.base += drop;
        term.lost += drop;
      }
    },

    /**
     * A command took the terminal's foreground, or gave it back.
     *
     * The whole of "is something happening in here". It comes from the host,
     * which asks the terminal itself (`tcgetpgrp`), so it is right for a
     * command that prints nothing and right for a shell that has just printed
     * a screenful and gone quiet.
     */
    setBusy(
      s: ConsoleState,
      key: string,
      busy: boolean,
      name: string,
      run?: number,
    ) {
      const term = peek(s, key);
      if (!term) return;
      if (typeof run === "number" && run !== term.run) return;
      term.busy = busy === true;
      term.running = busy === true && typeof name === "string" ? name : "";
    },

    /** The page has drawn everything up to `upTo` (an absolute index). */
    ack(s: ConsoleState, key: string, upTo: number) {
      if (typeof upTo !== "number" || !Number.isFinite(upTo)) return;
      const term = peek(s, key);
      if (!term) return;
      const drop = Math.min(term.out.length, Math.trunc(upTo) - term.base);
      if (drop <= 0) return;
      term.out.splice(0, drop);
      term.base += drop;
    },

    /** The shell finished. */
    /**
     * The shell finished — and the tab goes with it.
     *
     * This is what closing a terminal window has always meant: `exit` and
     * `Ctrl-D` end the session, and the window that was showing it is done.
     * Leaving a dead tab behind with a "Start again" button made every shell
     * you had ever opened accumulate in the dock.
     *
     * A launcher is not a special case, because a launcher does not run
     * INSTEAD of the shell — its command is typed at the prompt, so a
     * `deno task dev` that fails leaves the shell alive with its error on
     * screen. Only ending the shell ends the tab, and that is always something
     * a person asked for.
     */
    ended(s: ConsoleState, key: string, code: number, run?: number) {
      const term = peek(s, key);
      if (!term) return;
      if (typeof run === "number" && run !== term.run) return;
      term.status = "exited";
      term.exitCode = typeof code === "number" ? code : 0;
      // A shell that has gone is not busy, whatever it was doing when it went.
      term.busy = false;
      term.running = "";
      delete s.terms[key];
      const pid = term.projectId;
      if (s.active[pid] === key) delete s.active[pid];
      closedPane(key); // aiol-ok: orchestration, after the write
    },

    /** A page is showing this terminal, or has stopped. */
    watch(s: ConsoleState, key: string) {
      const term = peek(s, key);
      if (term) term.watchers += 1;
    },
    unwatch(s: ConsoleState, key: string) {
      const term = peek(s, key);
      if (term) term.watchers = Math.max(0, term.watchers - 1);
    },

    /** Keystrokes. */
    async send(s: ConsoleState, key: string, text: string) {
      if (typeof text !== "string" || text === "") return;
      if (peek(s, key)?.status !== "live") return;
      const io = await import("./pty.server.ts");
      await io.write(key, text);
    },

    /** The window changed shape. */
    async resize(s: ConsoleState, key: string, rows: number, cols: number) {
      if (typeof rows !== "number" || typeof cols !== "number") return;
      const term = peek(s, key);
      if (!term) return;
      const r = Math.max(1, Math.trunc(rows));
      const c = Math.max(1, Math.trunc(cols));
      if (term.rows === r && term.cols === c) return;
      term.rows = r;
      term.cols = c;
      if (term.status !== "live") return;
      const io = await import("./pty.server.ts");
      await io.resize(key, r, c);
    },

    /** End the shell. The record stays, so the page can say what happened. */
    async stop(s: ConsoleState, key: string) {
      const io = await import("./pty.server.ts");
      await io.close(key);
      const term = peek(s, key);
      if (!term) return;
      if (term.status === "live" || term.status === "starting") {
        term.status = "exited";
        term.exitCode ??= 0;
      }
    },

    /** Forget a finished terminal's output, without starting another. */
    clear(s: ConsoleState, key: string) {
      const term = peek(s, key);
      if (!term) return;
      term.out = [];
      term.base += 0;
      term.lost = 0;
    },
  },
});

/** How many chunks are waiting for the page. Read by the reader loop to decide
 *  whether to wait — see the module comment. */
function queueDepth(key: string): number {
  return consoleCell.terms[key]?.out.length ?? 0;
}

/** One terminal by id, or a blank one. Never `undefined`, so the page has
 *  nothing to guard. */
export const terminalById = (id: string): Terminal =>
  consoleCell.terms[id] ?? blank();

/** Which terminal a project is showing, or `""` when it has none. */
export const activeTerminalId = (projectId?: string): string => {
  const pid = projectId ?? workspace.activeId;
  const chosen = consoleCell.active[pid];
  if (chosen && consoleCell.terms[chosen]) return chosen;
  // Nothing chosen, or the chosen one was closed: the newest is the sensible
  // answer, and "" is honest when there are none.
  const mine = terminalsOf(pid);
  return mine.length > 0 ? mine[mine.length - 1][0] : "";
};

/** The terminal a project is showing. */
export const terminal = (projectId?: string): Terminal =>
  terminalById(activeTerminalId(projectId));

/* There were two more selectors here — "is any shell open" and "is any shell
   busy" — for the rail's Console card. The card is gone: a project can hold as
   many shells as it likes and each has its own row in the dock, with its own
   light and the name of what it is running, so a single card summarising them
   was answering a question the list already answers better. The per-pane
   `consolePulse` is what asks now. */
