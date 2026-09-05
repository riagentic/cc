/**
 * @module
 * Real terminals, owned by the server.
 *
 * The shell is a real process on a real pseudo-terminal — not an emulation of
 * one. That is the whole requirement: a terminal that cannot run `vim`, `htop`,
 * `git rebase -i` or `claude attach` is not a terminal, it is a command box,
 * and the difference shows up within a minute of using it.
 *
 * Deno cannot open a PTY and must not `fork` (it is multithreaded, and the
 * window between `fork` and `exec` admits only async-signal-safe calls), so the
 * fork happens in `native/pty` — a small Rust program that does nothing else —
 * and the two sides speak frames over a pipe. See that file for the protocol.
 *
 * Back-pressure is the other reason this module exists. A command like
 * `yes` produces megabytes a second; a terminal that buffered all of it would
 * take the window down. Nothing here reads from the host while the consumer is
 * behind — the pipe fills, the host stops reading the PTY, and the kernel
 * blocks the shell. That is exactly what happens to a real terminal emulator
 * that cannot keep up, and it is why `yes | head` terminates.
 */
import { log } from "aio";
import { homeDir } from "./claude.server.ts";
import { join } from "@std/path";

/* ── frames ───────────────────────────────────────────────────────────────── */

const IN_DATA = 0;
const IN_RESIZE = 1;
const OUT_DATA = 0;
const OUT_EXITED = 1;

/** One frame: a type byte, a big-endian length, the payload. */
function frame(kind: number, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(5 + body.length);
  out[0] = kind;
  new DataView(out.buffer).setUint32(1, body.length);
  out.set(body, 5);
  return out;
}

/* ── finding the host binary ──────────────────────────────────────────────── */

/** Where a shipped copy is unpacked to. Versioned, so an upgraded app does not
 *  keep running the previous release's host out of a cache. */
const hostPath = (): string =>
  join(homeDir(), ".claude-control", "bin", `cc-pty-${HOST_VERSION}`);

/** Bumped whenever the protocol or the host changes in a way the app depends
 *  on. It is in the unpacked file's name, so the two can never disagree. */
const HOST_VERSION = "1";

/** The binary as it sits in the source tree, for `deno task dev`. */
const devHost = new URL("../../native/pty/bin/cc-pty", import.meta.url);

/**
 * The in-flight resolution, not the result.
 *
 * Memoising the *promise* is what makes this safe to call twice at once — and
 * it is called twice at once, every time: the dock opens a terminal and the
 * page that appears immediately asks it to start. Two concurrent first calls
 * both found the host missing, both unpacked it, and the second landed on a
 * binary the first had already spawned: `Text file busy`. Found by opening a
 * console in the running app.
 */
let resolving: Promise<string> | null = null;

/**
 * The path to a runnable PTY host, unpacking the shipped copy if needed.
 *
 * `CC_PTY` overrides everything, which is how you test a host you just built
 * without reinstalling the app.
 */
export function resolveHost(): Promise<string> {
  return (resolving ??= findHost());
}

async function findHost(): Promise<string> {
  const override = Deno.env.get("CC_PTY");
  if (override && await isRunnable(override)) return override;

  // Unpacked already?
  const unpacked = hostPath();
  if (await isRunnable(unpacked)) return unpacked;

  // In the source tree — the dev path, and the source of the shipped copy.
  const fromSource = await Deno.readFile(devHost).catch(() => null);
  if (fromSource) {
    // Copied out rather than run in place: inside a compiled binary the source
    // path is a virtual file with no mode bits and nothing to exec.
    const dir = join(homeDir(), ".claude-control", "bin");
    await Deno.mkdir(dir, { recursive: true }).catch(() => {});
    // Written beside, then renamed into place. Writing *over* a binary that is
    // currently executing fails with ETXTBSY; a rename replaces the directory
    // entry and leaves the running copy alone, which is how every package
    // manager on this platform replaces a running program.
    const temp = `${unpacked}.${crypto.randomUUID().slice(0, 8)}`;
    await Deno.writeFile(temp, fromSource, { mode: 0o755 });
    await Deno.chmod(temp, 0o755).catch(() => {});
    await Deno.rename(temp, unpacked);
    return unpacked;
  }

  throw new Error(
    "The terminal host is missing. Build it with `deno task pty`, " +
      "or point CC_PTY at a copy.",
  );
}

async function isRunnable(path: string): Promise<boolean> {
  const stat = await Deno.stat(path).catch(() => null);
  return stat?.isFile === true;
}

/* ── which shell ──────────────────────────────────────────────────────────── */

/**
 * The user's shell, and the arguments that make it interactive.
 *
 * Decided here rather than in the cell because `Deno.env` is server-only, and
 * a cell reaches the browser: reading it there blanks the page at load. The
 * shell is `$SHELL` because that is the one the user configured, with their
 * prompt, their aliases and their PATH — anything else is a terminal that
 * behaves differently from every other terminal on their machine.
 */
export function defaultShell(): { shell: string; args: string[] } {
  const shell = Deno.env.get("SHELL") || "/bin/bash";
  const name = shell.slice(shell.lastIndexOf("/") + 1);
  // `-l` reads the login profile, which is where PATH usually comes from on a
  // desktop session that did not inherit one. fish takes neither flag the same
  // way and is interactive by default when given a terminal.
  const args = name === "fish" ? [] : ["-i", "-l"];
  return { shell, args };
}

/* ── sessions ─────────────────────────────────────────────────────────────── */

/** How long output is gathered before it is handed over.
 *
 *  A terminal that dispatched every read would send hundreds of updates a
 *  second for a `cat`; one that waited longer than a frame would feel slow to
 *  type into. Twelve milliseconds is under one frame at 60Hz and coalesces a
 *  burst into a single update. */
const COALESCE_MS = 12;

/** …or this much output, whichever comes first. A screenful is a few kilobytes;
 *  past this there is nothing to gain by waiting. */
const COALESCE_BYTES = 32 * 1024;

/** How long to wait when the consumer is behind, before asking again. One
 *  frame: long enough to be a real pause, short enough to be invisible. */
const BEHIND_MS = 16;

/** What a caller gets told about a session, as it happens. */
export type PtyEvents = {
  /** Decoded output. Never partial UTF-8: the decoder streams. */
  onData: (text: string) => void;
  /** The shell finished. `code` is what a shell would report. */
  onExit: (code: number) => void;
  /**
   * Is the consumer behind?
   *
   * Asked before every read. While it answers `true` this side waits, the pipe
   * from the host fills, the host stops reading the terminal, and the kernel
   * blocks the shell — which is precisely what happens to a real terminal
   * emulator that cannot keep up, and the reason `yes | head` terminates
   * instead of filling a disk.
   */
  isBehind: () => boolean;
};

type Session = {
  child: Deno.ChildProcess;
  writer: WritableStreamDefaultWriter<Uint8Array>;
  /** Set once the process is gone, so a late write is a no-op rather than a
   *  rejected promise nobody is waiting on. */
  closed: boolean;
  /**
   * A command to type as soon as the shell speaks, then cleared.
   *
   * NOT written when the host starts. A shell sets up its terminal modes with
   * `TCSAFLUSH`, which DISCARDS whatever is already waiting in the input queue
   * — so a command written before the first prompt appears is silently eaten,
   * and the launcher opens a shell that just sits there. Waiting for the first
   * byte out is waiting for the shell to be listening.
   */
  typeWhenReady: string;
};

const live = new Map<string, Session>();

/** Sessions currently open, by key. */
export const liveTerminals = (): string[] => [...live.keys()];

/**
 * Start a shell on its own terminal.
 *
 * `key` is the caller's handle — one per project, in this app. Starting a
 * second one under the same key ends the first: two shells writing to one
 * screen is not a feature anybody asked for.
 */
export async function open(
  key: string,
  opts: {
    /** The shell to run, or `null` for the user's own — see `defaultShell`. */
    shell: string | null;
    args: string[];
    cwd: string;
    rows: number;
    cols: number;
    env: Record<string, string>;
    /** Typed at the first prompt, if given — see `Session.typeWhenReady`. */
    typeWhenReady?: string;
  },
  events: PtyEvents,
): Promise<{ shell: string }> {
  await close(key);

  const chosen = opts.shell
    ? { shell: opts.shell, args: opts.args }
    : defaultShell();
  const bin = await resolveHost();
  const args = [
    "--rows",
    String(Math.max(1, Math.trunc(opts.rows))),
    "--cols",
    String(Math.max(1, Math.trunc(opts.cols))),
    "--cwd",
    opts.cwd,
  ];
  for (const [k, v] of Object.entries(opts.env)) {
    args.push("--env", `${k}=${v}`);
  }
  args.push("--", chosen.shell, ...chosen.args);

  const child = new Deno.Command(bin, {
    args,
    stdin: "piped",
    stdout: "piped",
    // The host says nothing on stderr unless it is dying; letting it through
    // puts that in the app's log rather than nowhere.
    stderr: "inherit",
  }).spawn();

  const session: Session = {
    child,
    writer: child.stdin.getWriter(),
    closed: false,
    typeWhenReady: opts.typeWhenReady ?? "",
  };
  live.set(key, session);
  log.info("pty", "terminal opened", {
    key,
    shell: chosen.shell,
    cwd: opts.cwd,
  });

  void pump(key, session, child.stdout, events);
  // Returned rather than assumed: the caller shows which shell it got, and
  // "whatever $SHELL said" is only knowable here.
  return { shell: chosen.shell };
}

/**
 * Read frames until the shell is gone.
 *
 * The reader is deliberately sequential — one `read`, one delivery, then the
 * next `read`. That is what turns a slow consumer into back-pressure instead of
 * a growing buffer.
 */
async function pump(
  key: string,
  session: Session,
  stdout: ReadableStream<Uint8Array>,
  events: PtyEvents,
): Promise<void> {
  const reader = stdout.getReader();
  // Streaming, so a multi-byte character split across two reads is not turned
  // into two replacement characters — which is what a naive decode does to
  // every box-drawing character in `htop`.
  const decode = new TextDecoder("utf-8");
  let buf = new Uint8Array(0);
  let exit: number | null = null;

  // Gathered, then handed over in one piece — see COALESCE_MS.
  //
  // A trailing timer rather than a check after each read: the loop spends most
  // of its life blocked in `read()`, so anything that only flushes *while*
  // reading leaves the last few bytes of a quiet burst sitting there until the
  // next output arrives. A prompt that appears only after the next keystroke
  // reads as a hang, and it is the exact bug this shape avoids.
  let pending = "";
  let timer: ReturnType<typeof setTimeout> | null = null;
  const flush = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (pending === "") return;
    const text = pending;
    pending = "";
    events.onData(text);
  };
  const soon = () => {
    if (timer === null) timer = setTimeout(flush, COALESCE_MS);
  };

  try {
    while (true) {
      // Wait while the page is behind. This is the whole back-pressure story:
      // not reading is what fills the pipe.
      while (events.isBehind()) {
        flush();
        await new Promise((r) => setTimeout(r, BEHIND_MS));
      }
      const { value, done } = await reader.read();
      if (done) break;
      const next = new Uint8Array(buf.length + value.length);
      next.set(buf);
      next.set(value, buf.length);
      buf = next;

      while (buf.length >= 5) {
        const len = new DataView(buf.buffer, buf.byteOffset).getUint32(1);
        if (buf.length < 5 + len) break;
        const kind = buf[0];
        const body = buf.subarray(5, 5 + len);
        if (kind === OUT_DATA) {
          if (session.typeWhenReady !== "") {
            // The shell has spoken, so it is past its `TCSAFLUSH` and reading.
            const cmd = session.typeWhenReady;
            session.typeWhenReady = "";
            void write(key, cmd);
          }
          pending += decode.decode(body, { stream: true });
          if (pending.length >= COALESCE_BYTES) flush();
          else soon();
        } else if (kind === OUT_EXITED) {
          exit = new DataView(body.buffer, body.byteOffset).getInt32(0);
        }
        buf = buf.slice(5 + len);
      }
    }
  } catch (e) {
    log.warn("pty", "terminal read failed", {
      key,
      error: e instanceof Error ? e.message : String(e),
    });
  } finally {
    // Everything still held: the coalescer's buffer, then whatever the decoder
    // was carrying, so a truncated last character is not silently dropped.
    const tail = decode.decode();
    if (tail) pending += tail;
    flush();
    session.closed = true;
    live.delete(key);
    log.info("pty", "terminal closed", { key, code: exit ?? 0 });
    events.onExit(exit ?? 0);
  }
}

/** Send keystrokes. Silently ignored for a session that has ended — the UI
 *  finds out from `onExit`, and a rejected promise here would be noise. */
export async function write(key: string, text: string): Promise<void> {
  const session = live.get(key);
  if (!session || session.closed) return;
  try {
    await session.writer.write(frame(IN_DATA, new TextEncoder().encode(text)));
  } catch {
    session.closed = true;
  }
}

/** Tell the terminal how big it is. The kernel raises `SIGWINCH` from here, so
 *  a full-screen program redraws itself. */
export async function resize(
  key: string,
  rows: number,
  cols: number,
): Promise<void> {
  const session = live.get(key);
  if (!session || session.closed) return;
  const body = new Uint8Array(4);
  const view = new DataView(body.buffer);
  view.setUint16(0, Math.max(1, Math.min(9999, Math.trunc(rows))));
  view.setUint16(2, Math.max(1, Math.min(9999, Math.trunc(cols))));
  try {
    await session.writer.write(frame(IN_RESIZE, body));
  } catch {
    session.closed = true;
  }
}

/**
 * End a session.
 *
 * By killing the host, not the shell: the host holds the master side, and
 * closing it is what makes the kernel hang up the session — the same thing that
 * happens when a terminal window closes. The shell gets `SIGHUP`, its children
 * get whatever it decides to send them, and nothing is left behind.
 */
export async function close(key: string): Promise<void> {
  const session = live.get(key);
  if (!session) return;
  live.delete(key);
  session.closed = true;
  try {
    await session.writer.close();
  } catch { /* already gone */ }
  try {
    session.child.kill("SIGTERM");
  } catch { /* already gone */ }
  // Reaped so the process table stays clean; the result is not interesting.
  void session.child.status.catch(() => {});
}

/** End every session. Called when the app is going down. */
export async function closeAll(): Promise<void> {
  for (const key of [...live.keys()]) await close(key);
}
