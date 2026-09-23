/**
 * @module
 * Server-only half: the Claude Code process, the filesystem, git.
 *
 * The `.server.ts` suffix plus a *dynamic* import from the cell is the whole
 * boundary — the build marks these imports external, so none of this reaches
 * the browser bundle, and cell methods run on the server so the import only
 * ever executes there (dep/aio/docs/build/imports.md §2, and the
 * dep/aio/examples/disk app for the same shape end to end).
 *
 * A session is ONE long-lived `claude -p --input-format stream-json` process:
 * every turn reuses it, so context, tools and MCP servers are paid for once.
 * Turns are written to stdin as NDJSON, events read from stdout.
 *
 * There is one such process **per project**, held in a registry keyed by the
 * project id, because a project's conversation is the thing a user switches
 * between — and a switch that stopped the turn you left running would make the
 * switch itself the expensive operation. Every function here therefore takes
 * the key of the session it acts on; nothing addresses "the" session.
 */
import { log } from "aio";
// Pure, dependency-free readers over the same protocol — one parser and one
// interrupt-id spelling for both sides of the bridge, both covered by tests.
import {
  HANDSHAKE_PREFIX,
  INTERRUPT_PREFIX,
  MODEL_PREFIX,
  parseLine,
} from "../lib/stream.ts";

/** Join path segments and normalise away `.`, `..` and duplicate separators.
 *  Hand-rolled rather than pulled from `@std/path`: this module is reachable
 *  from the client graph, and one import fewer there is one fewer thing the
 *  validator has to take on trust. */
function join(...parts: string[]): string {
  const raw = parts.filter(Boolean).join("/");
  const absolute = raw.startsWith("/");
  const out: string[] = [];
  for (const seg of raw.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === ".." && out.length > 0 && out[out.length - 1] !== "..") {
      out.pop();
    } else out.push(seg);
  }
  return (absolute ? "/" : "") + out.join("/");
}

/** Callbacks into the cell. Deliberately narrow — this module owns no state
 *  the UI can see, and never reaches into the cell itself. */
export type Hooks = {
  /** One decoded protocol event (everything except `stream_event`). */
  onEvent: (evt: Record<string, unknown>) => void;
  /** Coalesced streaming text for the in-flight message (~10 Hz, not per token). */
  onDelta: (kind: "text" | "thinking", text: string) => void;
  /** The process ended — `code` is the exit status, `detail` the tail of stderr. */
  onExit: (code: number, detail: string) => void;
};

export type StartOptions = {
  cwd: string;
  model: string;
  permissionMode: string;
  /** Extra directories the CLI may touch (`--add-dir`). */
  allowedDirs?: string[];
  /** `--dangerously-skip-permissions`: no checks at all, anywhere. */
  skipPermissions?: boolean;
  /** Resume a previous CLI session id instead of starting a fresh one. */
  resume?: string | null;
  /** `--effort`: how hard the model works before answering. `""` leaves the
   *  CLI's own setting alone rather than overriding it. */
  effort?: string;
};

type Session = {
  /** The project this process belongs to. */
  key: string;
  child: Deno.ChildProcess;
  stdin: WritableStreamDefaultWriter<Uint8Array>;
  pid: number;
  closed: boolean;
};

/**
 * Every live session, by project id.
 *
 * At most one per project — a second process for the same project would
 * silently double that project's token cost, which is the invariant `start`
 * enforces by stopping the incumbent first. Across projects, concurrency is the
 * point: a turn running in one project keeps running while you read another.
 */
const live = new Map<string, Session>();

/**
 * The tail of each conversation's start/stop queue.
 *
 * `start` awaits the incumbent's teardown before it spawns, so two starts for
 * one conversation arriving together (Restart, then Enter) both saw no process,
 * both spawned, and the second `live.set` orphaned the first — a `claude` with
 * no entry anything could stop. A `stop` racing a spawn had the same hole the
 * other way round: it found nothing to stop, and the spawn landed after it.
 * Every start and stop for one key now runs after the one before it.
 */
const queues = new Map<string, Promise<void>>();

/** Run `fn` once every earlier start/stop for `key` has settled. */
function serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const run = (queues.get(key) ?? Promise.resolve()).then(fn);
  const tail = run.then(() => {}, () => {});
  queues.set(key, tail);
  void tail.then(() => {
    if (queues.get(key) === tail) queues.delete(key);
  });
  return run;
}

const enc = new TextEncoder();
const DELTA_FLUSH_MS = 90;
const STDERR_KEEP = 4_000;

/**
 * The permission channel. `stdio` is the CLI's name for "ask the client that
 * owns my stdin" — verified against 2.1.226: with it the CLI emits
 * `control_request`/`can_use_tool` and blocks; without it, anything needing
 * approval is denied outright.
 */
const PERMISSION_PROMPT_TOOL = "stdio";

/**
 * The exact argv handed to the CLI. Extracted from `start` so the decisions in
 * it — which permission flag, how many `--add-dir` — can be asserted directly
 * instead of inferred from a spawned process.
 */
export function buildArgs(opts: StartOptions): string[] {
  const args = [
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--include-partial-messages",
    "--forward-subagent-text",
    "--verbose",
    "--model",
    opts.model,
  ];

  // `--dangerously-skip-permissions` turns every check off, so pairing it with
  // a `--permission-mode` would be contradictory: pass one or the other.
  if (opts.skipPermissions) {
    args.push("--dangerously-skip-permissions");
  } else {
    args.push("--permission-mode", opts.permissionMode);
    // THE flag that makes this app usable. Without it the CLI has no one to ask,
    // so every call needing approval is auto-denied and the model narrates a
    // request the user is never shown — which reads exactly like a hang
    // ("the sub-agents never finished"). With it, the CLI sends a
    // `can_use_tool` control request and waits for our answer.
    args.push("--permission-prompt-tool", PERMISSION_PROMPT_TOOL);
  }

  // Each extra directory is a separate `--add-dir` value. This is the narrow
  // alternative to switching permissions off: the CLI refuses to touch paths
  // outside its working directory, which is what "denied" almost always means.
  for (const dir of opts.allowedDirs ?? []) args.push("--add-dir", dir);

  // Only when chosen: passing a value the user did not pick would override
  // whatever they configured for the CLI itself.
  if (opts.effort) args.push("--effort", opts.effort);

  if (opts.resume) args.push("--resume", opts.resume);
  return args;
}

/**
 * Spawn the session. Resolves once the process exists; the session is marked
 * ready when the CLI answers the `initialize` handshake below — `system/init`
 * is not that signal, since the CLI holds it back until a first turn begins.
 * Throws with an actionable message when the CLI is missing or the directory
 * is not usable, rather than leaving a dead "starting" state behind.
 */
export function start(
  key: string,
  opts: StartOptions,
  hooks: Hooks,
): Promise<{ pid: number }> {
  return serial(key, () => spawn(key, opts, hooks));
}

async function spawn(
  key: string,
  opts: StartOptions,
  hooks: Hooks,
): Promise<{ pid: number }> {
  // This project's incumbent only. Other projects' sessions are untouched —
  // that is what makes switching free. Already inside the queue, so the
  // unqueued teardown — the queued one would wait for this very call.
  await teardown(key);

  const stat = await Deno.stat(opts.cwd).catch(() => null);
  if (!stat?.isDirectory) {
    // Named remedy, not just a fact: this is what a user sees when a project
    // they added weeks ago has since been deleted or unmounted.
    throw new Error(
      `The project folder is gone: ${opts.cwd} — pick another project in ` +
        `Settings, or remove it from the list.`,
    );
  }

  const args = buildArgs(opts);

  log.info("claude", "starting session", {
    cwd: opts.cwd,
    model: opts.model,
    permissions: opts.skipPermissions
      ? "SKIPPED (dangerous)"
      : opts.permissionMode,
    allowedDirs: opts.allowedDirs ?? [],
  });

  let child: Deno.ChildProcess;
  try {
    child = new Deno.Command(claudeBin(), {
      args,
      cwd: opts.cwd,
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
  } catch (e) {
    throw new Error(
      `Could not start the Claude Code CLI (${
        e instanceof Error ? e.message : String(e)
      }). Set CLAUDE_BIN if it is not on PATH.`,
    );
  }

  const session: Session = {
    key,
    child,
    stdin: child.stdin.getWriter(),
    pid: child.pid,
    closed: false,
  };
  live.set(key, session);
  installExitGuard();

  let stderrTail = "";
  const readErr = pump(child.stderr, (chunk) => {
    stderrTail = (stderrTail + chunk).slice(-STDERR_KEEP);
  });
  const readOut = readEvents(child.stdout, session, hooks);

  // The SDK handshake: it announces a client that speaks the control protocol,
  // and the reply carries what the session can do. Sent before the first turn
  // so the CLI never has to guess whether anyone is listening — and its answer
  // is what marks the session ready, since the CLI holds `system/init` back
  // until a first turn begins.
  await write(key, {
    type: "control_request",
    request_id: `${HANDSHAKE_PREFIX}${session.pid}`,
    request: { subtype: "initialize", hooks: {} },
  }).catch((e) => {
    log.warn("claude", "initialize handshake failed", {
      error: e instanceof Error ? e.message : String(e),
    });
  });

  // Fire-and-forget: the process outlives this call by design.
  (async () => {
    const status = await child.status.catch(() => ({ code: -1 }));
    await Promise.allSettled([readOut, readErr]);
    // Identity, not key: a restart of the same project has already replaced the
    // entry, and deleting it here would drop the *new* session from the
    // registry — leaving a running process nothing could stop.
    if (live.get(key) === session) {
      live.delete(key);
      releaseExitGuardIfIdle();
    }
    session.closed = true;
    hooks.onExit(status.code, stderrTail.trim());
  })();

  return { pid: session.pid };
}

/** Queue a user turn. The CLI accepts input at any time; a turn sent while one
 *  is running is queued by the CLI itself rather than dropped. */
export async function send(key: string, text: string): Promise<void> {
  await write(key, {
    type: "user",
    message: { role: "user", content: [{ type: "text", text }] },
  });
}

/**
 * Answer a `can_use_tool` request: run the call, optionally with an edited
 * input and with permission changes the CLI suggested ("always allow").
 *
 * The CLI is blocked on this line — every request the app shows the user is
 * answered here or by {@link denyTool}, and nothing else unblocks it.
 */
export async function allowTool(
  key: string,
  requestId: string,
  input: Record<string, unknown>,
  updatedPermissions: unknown[] = [],
): Promise<void> {
  await write(key, {
    type: "control_response",
    response: {
      subtype: "success",
      request_id: requestId,
      response: updatedPermissions.length > 0
        ? { behavior: "allow", updatedInput: input, updatedPermissions }
        : { behavior: "allow", updatedInput: input },
    },
  });
}

/** Refuse a `can_use_tool` request. `message` reaches the model as the tool's
 *  error, so it is the user's own words about why, not a generic refusal. */
export async function denyTool(
  key: string,
  requestId: string,
  message: string,
): Promise<void> {
  await write(key, {
    type: "control_response",
    response: {
      subtype: "success",
      request_id: requestId,
      response: { behavior: "deny", message },
    },
  });
}

let interrupts = 0;

/** Stop the current turn without losing the session (verified against 2.1.226:
 *  the CLI answers with a `control_response` and keeps accepting turns).
 *
 *  The id carries {@link INTERRUPT_PREFIX} and a counter rather than a clock:
 *  the prefix is how the reducer tells this ack apart from the handshake's, and
 *  a counter cannot collide the way two interrupts in one millisecond can. */
export async function interrupt(key: string): Promise<void> {
  await write(key, {
    type: "control_request",
    request_id: `${INTERRUPT_PREFIX}${++interrupts}`,
    request: { subtype: "interrupt" },
  });
}

let modelSwitches = 0;

/**
 * Point the *running* session at another model.
 *
 * The CLI takes this on the control channel and applies it from the next turn
 * on, keeping the conversation, its context and its tool state (`set_model`,
 * verified against 2.1.259). A restart would keep none of the three, which is
 * why changing the model used to mean "changing what the next session will be"
 * — and why a session that had exhausted one model's usage limit went on
 * answering out of that same model.
 */
export async function setModel(key: string, model: string): Promise<void> {
  await write(key, {
    type: "control_request",
    request_id: `${MODEL_PREFIX}${++modelSwitches}`,
    request: { subtype: "set_model", model },
  });
}

/** How long each stage of the teardown gets before the next one is tried. */
const CLOSE_GRACE_MS = 1_500;
const SIGNAL_GRACE_MS = 1_500;

/**
 * End the session, and make sure it is actually ended.
 *
 * Three stages, escalating: close stdin (the CLI's own graceful exit), then
 * SIGTERM, then SIGKILL. The last one is not paranoia — it is the only stage
 * that cannot be ignored, and without it `stop()` returned after 1.5 s
 * reporting success while the child ran on: a `claude` still holding a model
 * session, invisible to the app, one more of them after every restart.
 */
export function stop(key: string): Promise<void> {
  return serial(key, () => teardown(key));
}

async function teardown(key: string): Promise<void> {
  const session = live.get(key);
  if (!session) return releaseExitGuardIfIdle();
  live.delete(key);
  // `closed` is not "exited": the stdout reader sets it when the stream ends,
  // and a process can close stdout and live on. Returning on it left exactly
  // that process running — so the escalation below always runs, and a child
  // that really has gone passes every stage at once.
  session.closed = true;

  await session.stdin.close().catch(() => {});
  if (await settled(session, CLOSE_GRACE_MS)) return releaseExitGuardIfIdle();

  signal(session, "SIGTERM");
  if (await settled(session, SIGNAL_GRACE_MS)) return releaseExitGuardIfIdle();

  // The floor. Nothing survives this, which is the point.
  log.warn("claude", "session ignored SIGTERM — killing", { pid: session.pid });
  signal(session, "SIGKILL");
  await settled(session, SIGNAL_GRACE_MS);
  releaseExitGuardIfIdle();
}

/** End every session. What app shutdown needs, and the only caller that should
 *  ever address them all at once. */
export async function stopAll(): Promise<void> {
  // A start still queued has no `live` entry yet, and must be ended too.
  const keys = new Set([...live.keys(), ...queues.keys()]);
  await Promise.allSettled([...keys].map((key) => stop(key)));
}

/** True once the child has exited, or `false` if `ms` passes first. The timer
 *  is cleared either way — left running, every clean exit held the event loop
 *  open for the rest of the grace period. */
async function settled(session: Session, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      session.child.status.then(() => true).catch(() => true),
      new Promise<boolean>((r) => timer = setTimeout(() => r(false), ms)),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function signal(session: Session, sig: "SIGTERM" | "SIGKILL") {
  try {
    session.child.kill(sig);
  } catch (e) {
    // Already gone is the common case and not a problem; anything else is.
    log.debug("claude", `${sig} failed`, {
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

/* ── exit guard ──────────────────────────────────────────────────────────────
 *
 * The child is a real process and outlives this one unless something ends it.
 * `claude` does exit when its stdin closes, so a hard-killed app is survivable —
 * but that is the CLI being well behaved, not the app being correct, and it
 * covers none of the paths where the app *can* clean up after itself.
 *
 * Installed only while a session is live, and removed with it.
 *
 * No signal handlers. SIGINT/SIGTERM belong to aio, which runs every cell's
 * `onDestroy` (the session's calls `stopAll`) and then flushes the final state
 * to disk before it exits. A handler here that ended in its own `Deno.exit`
 * raced that flush — the first to finish took the process down through the
 * other's write (dep/aio/src/server/shutdown.ts, "Whose shutdown a
 * process-wide exit has to wait for"). What is left is the one thing aio cannot
 * do for us: a synchronous SIGKILL on the way out, for any child still alive.
 */

let guarded = false;

/** Last resort on a normal exit: `unload` cannot await, so this is a bare
 *  synchronous kill rather than the graceful sequence above. */
const onUnload = () => {
  for (const session of live.values()) {
    if (!session.closed) signal(session, "SIGKILL");
  }
};

function installExitGuard() {
  if (guarded) return;
  globalThis.addEventListener("unload", onUnload);
  guarded = true;
}

/** The guard exists to protect running children, so it is released only once
 *  the last one is gone — not when any single session ends. */
function releaseExitGuardIfIdle() {
  if (!guarded || live.size > 0) return;
  globalThis.removeEventListener("unload", onUnload);
  guarded = false;
}

/* ── environment ─────────────────────────────────────────────────────────── */

export const homeDir = (): string =>
  Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE") ?? "/";

export const cwd = (): string => Deno.cwd();

/**
 * The working project folder: the first positional CLI argument if there is
 * one, else the directory the app was launched from.
 *
 * Flags are skipped rather than assumed absent — aio's own options (`--client`,
 * `--expose`, …) arrive in the same argv, and under Electron the child process
 * is re-launched with more of them.
 */
export function projectArg(
  argv: string[] = Deno.args,
): { path: string; explicit: boolean } {
  const positional = argv.find((a) => !a.startsWith("-"));
  return positional && positional.length > 0
    ? { path: resolvePath(positional), explicit: true }
    : { path: cwd(), explicit: false };
}

/** Absolute path, with `~` and relative forms resolved against the real cwd.
 *
 *  Exported because a path typed into a field needs exactly this and nothing
 *  else: {@link projectArg} was doing double duty as the resolver, and it
 *  answers "no folder given" — the launch directory — for anything starting with
 *  a dash, so a typo'd path silently granted the app's own working directory. */
export function resolvePath(path: string): string {
  const expanded = path.startsWith("~/")
    ? join(homeDir(), path.slice(2))
    : path;
  return expanded.startsWith("/") ? expanded : join(cwd(), expanded);
}

/** The CLI binary. Overridable so a non-PATH install still works. */
const claudeBin = (): string => Deno.env.get("CLAUDE_BIN") ?? "claude";

/** CLI version string, or `null` when the binary cannot be reached. */
export async function version(): Promise<string | null> {
  const out = await run(claudeBin(), ["--version"], undefined, 5_000);
  return out?.trim().split(/\s+/)[0] ?? null;
}

/**
 * Hand a file to whatever the desktop opens it with.
 *
 * The pages that list skills, commands, hooks, MCP servers and memory files all
 * name the file behind each row, and naming it was as far as they went — the
 * next thing anyone wants is to look at it, and the app knew the path and made
 * you copy it out by eye. This is that step.
 *
 * What it will not do:
 *  - run a shell. The opener and the path are separate argv entries, so a path
 *    containing a quote, a space or a `;` is a path, never syntax;
 *  - open something that is not there. A missing file is reported, not handed
 *    to the desktop to fail at silently;
 *  - decide what "open" means. That is the user's own file association, which
 *    is the whole reason this is one line and not an editor integration.
 */
export async function openPath(path: unknown): Promise<string | null> {
  // `unknown`, not `string`: this is reachable from the control plane, where a
  // missing argument arrives as `undefined` and the parameter type is a promise
  // nobody enforces. The answer is the sentence this function already returns
  // for a bad path — a thrown TypeError would be the same refusal, reported as
  // a crash.
  if (typeof path !== "string" || !path.startsWith("/")) {
    return "Not an absolute path.";
  }
  const stat = await Deno.stat(path).catch(() => null);
  if (!stat) return `No longer on disk: ${path}`;
  const opener = Deno.build.os === "darwin"
    ? "open"
    : Deno.build.os === "windows"
    ? "explorer"
    : "xdg-open";
  try {
    const child = new Deno.Command(opener, {
      args: [path],
      stdin: "null",
      stdout: "null",
      stderr: "piped",
    }).spawn();
    // Not awaited to completion: an opener that launches an editor stays alive
    // for as long as the editor does, and the click must not. `unref` lets this
    // process exit with a viewer still open.
    child.stderr.cancel().catch(() => {});
    child.unref();
    log.info("workspace", "opened a file with the desktop opener", { opener });
    return null;
  } catch (e) {
    // `explorer` exits non-zero on success, and a Linux box with no
    // xdg-utils has no opener at all — both are worth saying out loud rather
    // than leaving as a button that does nothing.
    return `Could not open it: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/** One folder, as the picker shows it. */
export type DirEntry = {
  name: string;
  path: string;
  /** A repository — the thing somebody adding a project is almost always
   *  looking for, so it is worth a mark of its own. */
  git: boolean;
  hidden: boolean;
};

/**
 * The subdirectories of `path`, sorted the way a person reads them.
 *
 * Directories only: this exists to choose a project, and a list of files would
 * be a thousand rows of things that cannot be picked. Repositories are marked
 * rather than filtered — a project is often the parent of several, and
 * sometimes a plain folder with no git in it at all.
 *
 * Unreadable entries are skipped rather than thrown: a home directory
 * routinely contains one folder the user cannot enter, and one `EACCES` must
 * not empty the whole list.
 */
export async function listDirs(
  path: string,
): Promise<{ path: string; entries: DirEntry[]; error: string | null }> {
  const dir = resolvePath(path);
  const entries: DirEntry[] = [];
  try {
    for await (const e of Deno.readDir(dir)) {
      // A symlink to a directory is a directory as far as this is concerned —
      // `~/code` being a link to another disk is completely ordinary, and
      // `isDirectory` is false for the link itself.
      const isDir = e.isDirectory ||
        (e.isSymlink && await isDirectory(join(dir, e.name)));
      if (!isDir) continue;
      const full = join(dir, e.name);
      entries.push({
        name: e.name,
        path: full,
        git: await isDirectory(join(full, ".git")),
        hidden: e.name.startsWith("."),
      });
    }
  } catch (e) {
    return {
      path: dir,
      entries: [],
      error: e instanceof Deno.errors.NotFound
        ? "That folder does not exist."
        : e instanceof Deno.errors.PermissionDenied
        ? "You do not have permission to read that folder."
        : e instanceof Error
        ? e.message
        : String(e),
    };
  }
  // Case-insensitive, and numbers in order: "v2" before "v10", which is what
  // anybody with versioned folders expects and what a plain sort gets wrong.
  entries.sort((a, b) =>
    a.name.localeCompare(b.name, undefined, {
      sensitivity: "base",
      numeric: true,
    })
  );
  return { path: dir, entries, error: null };
}

/**
 * Create a directory, and everything above it that is missing.
 *
 * Returns the reason it could not be created, or `null` on success — including
 * for a directory that was already there, which is the outcome the caller
 * wanted either way.
 */
export async function makeDir(path: string): Promise<string | null> {
  const dir = resolvePath(path);
  try {
    await Deno.mkdir(dir, { recursive: true });
    return null;
  } catch (e) {
    if (e instanceof Deno.errors.AlreadyExists) return null;
    return e instanceof Error ? e.message : String(e);
  }
}

/**
 * Write an exported file into the app's own directory, and answer with where
 * it went.
 *
 * The app's directory, not the project's: an export is a copy made for a
 * person, and dropping untracked Markdown into somebody's repository is the
 * kind of helpfulness that ends up in a commit by accident. `~/.claude-control`
 * is already where this app keeps its things.
 *
 * The name is sanitised rather than trusted — it is built from a project name,
 * which is a directory name, which can contain anything a filesystem allows.
 */
export async function writeExport(
  name: string,
  text: string,
): Promise<{ path: string | null; error: string | null }> {
  const safe = name.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") ||
    "transcript";
  const dir = join(homeDir(), ".claude-control", "exports");
  const path = join(dir, safe);
  try {
    await Deno.mkdir(dir, { recursive: true });
    await Deno.writeTextFile(path, text);
    return { path, error: null };
  } catch (e) {
    return { path: null, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Which files in a repository git considers changed.
 *
 * Returned as absolute paths, so a caller comparing against a tree of absolute
 * paths does no string surgery of its own. Modified and untracked are kept
 * apart because they mean different things to a reader deciding what to
 * review: one has a previous version to diff against and the other does not.
 *
 * Empty for anything that is not a repository — not an error. A project
 * without git is ordinary, and this is decoration on a file list.
 */
export async function gitChanged(
  path: string,
): Promise<{ modified: string[]; untracked: string[] }> {
  // Porcelain output is relative to the REPOSITORY ROOT, not to the directory
  // git was run in — and a project is very often a subdirectory of its repo,
  // or a plain folder inside somebody's home that happens to be under one. So
  // the root is asked for first; joining against the project path produced
  // confident absolute paths to files that do not exist.
  const top = await run("git", ["rev-parse", "--show-toplevel"], path);
  if (top === null) return { modified: [], untracked: [] };
  const root = top.trim();
  // git answers with the REAL path, and a project opened through a symlink
  // (`~/code` → `/mnt/data/code`) is compared against a tree of lexical ones.
  // So the answer is mapped back under the path the project was opened by.
  const real = await Deno.realPath(path).catch(() => path);
  const shown = (abs: string): string =>
    abs === real
      ? path
      : abs.startsWith(real + "/")
      ? path.replace(/\/+$/, "") + abs.slice(real.length)
      : abs;
  // `-uall`, because git collapses an untracked directory to its own name by
  // default — a whole new folder arrived as one entry called "inner/", and
  // every file inside it went unmarked. A file list wants files. Ignored paths
  // are still excluded, so the usual node_modules is not walked.
  const out = await run(
    "git",
    ["status", "--porcelain=v1", "-z", "-uall"],
    path,
  );
  if (out === null) return { modified: [], untracked: [] };
  const modified: string[] = [];
  const untracked: string[] = [];
  for (const { code, name } of parsePorcelainZ(out)) {
    (code === "??" ? untracked : modified).push(shown(join(root, name)));
  }
  return { modified, untracked };
}

/**
 * `git status --porcelain=v1 -z`, as `{ code, name }` per changed path.
 *
 * `-z` because a path with a space in it is normal and a path with a NEWLINE
 * in it is legal; the line-based format quotes those, and parsing quotes is
 * how you end up with a file called "\"weird name\"".
 *
 * A rename or copy is TWO fields — `R  new\0old\0` — and only the first has a
 * status code. Read as entries of their own, the old path lost its first
 * three characters to a "code" and was marked as a changed file that does
 * not exist. The new name is the one a file list shows; the old is skipped.
 */
export function parsePorcelainZ(out: string): { code: string; name: string }[] {
  const fields = out.split("\0");
  const found: { code: string; name: string }[] = [];
  for (let i = 0; i < fields.length; i++) {
    const entry = fields[i];
    if (entry.length < 4) continue;
    const code = entry.slice(0, 2);
    found.push({ code, name: entry.slice(3) });
    if (/[RC]/.test(code)) i++;
  }
  return found;
}

/**
 * The committed version of a file, or `null` when there is not one.
 *
 * `null` covers every "there is nothing to compare against" case at once: not
 * a repository, never committed, deleted from the index. The caller shows the
 * file plainly in all of them, which is the right answer to all of them.
 */
export async function gitFileAtHead(path: string): Promise<string | null> {
  const cut = path.lastIndexOf("/");
  const dir = path.slice(0, cut) || "/";
  const top = await run("git", ["rev-parse", "--show-toplevel"], dir);
  if (top === null) return null;
  const root = top.trim();
  // Compared real to real: git's root is resolved, and the path came from a
  // tree that may have been opened through a symlink. The folder is resolved
  // rather than the file, which may have been deleted since.
  const realDir = await Deno.realPath(dir).catch(() => null);
  if (realDir === null) return null;
  const file = `${realDir === "/" ? "" : realDir}/${path.slice(cut + 1)}`;
  if (!file.startsWith(root + "/")) return null;
  const rel = file.slice(root.length + 1);
  // One `HEAD:<path>` argument — git's name for a blob, with the path taken
  // relative to the root. It starts with `HEAD`, so no file name can be read
  // as an option, and it is not a pathspec, so none can be read as a
  // revision either. (A `--` here would turn it INTO a pathspec.)
  return await run("git", ["show", `HEAD:${rel}`], root);
}

export async function isDirectory(path: string): Promise<boolean> {
  const stat = await Deno.stat(path).catch(() => null);
  return stat?.isDirectory === true;
}

/** Current branch and whether the tree is dirty. Both `null`/`false` outside a
 *  repository — not an error, just a project without git. */
export async function gitInfo(
  path: string,
): Promise<{ branch: string | null; dirty: boolean }> {
  // `branch --show-current` rather than `rev-parse --abbrev-ref HEAD`: the
  // latter fails outright on a repository with no commits yet, so a freshly
  // initialised project reported "no branch" when it plainly had one.
  const branch = await run("git", ["branch", "--show-current"], path);
  if (branch === null) return { branch: null, dirty: false };
  const status = await run("git", ["status", "--porcelain"], path);
  return { branch: branch.trim() || null, dirty: (status ?? "").trim() !== "" };
}

/* ── memory ──────────────────────────────────────────────────────────────── */

export type ScannedMemory = {
  path: string;
  label: string;
  scope: "user" | "project" | "session";
  bytes: number;
  modifiedAt: number | null;
};

/**
 * Everything Claude Code loads as memory for this project: the user's global
 * `CLAUDE.md`, the project's own memory files, and the per-session memory
 * directory the CLI reports in `system/init`.
 */
export async function scanMemory(
  projectPath: string,
  sessionMemoryDirs: string[],
): Promise<ScannedMemory[]> {
  const home = homeDir();
  const out: ScannedMemory[] = [];

  const candidates: [string, "user" | "project"][] = [
    [join(home, ".claude", "CLAUDE.md"), "user"],
    [join(projectPath, "CLAUDE.md"), "project"],
    [join(projectPath, ".claude", "CLAUDE.md"), "project"],
    [join(projectPath, "CLAUDE.local.md"), "project"],
  ];
  for (const [path, scope] of candidates) {
    const file = await statFile(path, scope, labelFor(path, home));
    if (file) out.push(file);
  }
  for (const dir of sessionMemoryDirs) {
    out.push(...await scanDir(dir, "session", home));
  }
  return out.sort((a, b) => b.bytes - a.bytes);
}

async function scanDir(
  dir: string,
  scope: "user" | "project" | "session",
  home: string,
  depth = 0,
): Promise<ScannedMemory[]> {
  if (depth > 3) return [];
  const out: ScannedMemory[] = [];
  try {
    for await (const e of Deno.readDir(dir)) {
      const path = join(dir, e.name);
      if (e.isSymlink) continue;
      if (e.isDirectory) {
        out.push(...await scanDir(path, scope, home, depth + 1));
      } else if (e.isFile) {
        const file = await statFile(path, scope, labelFor(path, home));
        if (file) out.push(file);
      }
    }
  } catch { /* absent or unreadable — an empty memory dir is not an error */ }
  return out;
}

async function statFile(
  path: string,
  scope: "user" | "project" | "session",
  label: string,
): Promise<ScannedMemory | null> {
  const stat = await Deno.stat(path).catch(() => null);
  if (!stat?.isFile) return null;
  return {
    path,
    label,
    scope,
    bytes: stat.size,
    modifiedAt: stat.mtime?.getTime() ?? null,
  };
}

const labelFor = (path: string, home: string): string =>
  path.startsWith(home) ? `~${path.slice(home.length)}` : path;

/* ── plumbing ────────────────────────────────────────────────────────────── */

async function write(key: string, frame: unknown): Promise<void> {
  const session = live.get(key);
  if (!session || session.closed) throw new Error("No session is running.");
  await session.stdin.write(enc.encode(`${JSON.stringify(frame)}\n`));
}

/**
 * Read stdout as NDJSON. `stream_event` deltas are coalesced into a buffer and
 * flushed on a timer — a per-token dispatch would put the whole render loop on
 * the critical path of the model's output.
 */
async function readEvents(
  stdout: ReadableStream<Uint8Array>,
  session: Session,
  hooks: Hooks,
): Promise<void> {
  let pending: { kind: "text" | "thinking"; text: string } | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const flush = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (pending) {
      hooks.onDelta(pending.kind, pending.text);
      pending = null;
    }
  };
  const push = (kind: "text" | "thinking", text: string) => {
    if (!text) return;
    pending = pending && pending.kind === kind
      ? { kind, text: pending.text + text }
      : { kind, text };
    if (timer === null) timer = setTimeout(flush, DELTA_FLUSH_MS);
  };

  await pump(stdout, (chunk) => {
    for (const line of chunk.split("\n")) {
      // A truncated tail is noise, never a reason to drop the stream.
      const evt = parseLine(line);
      if (!evt) continue;
      if (evt.type === "stream_event") {
        // Partial text from inside a sub-agent belongs to that agent, not to
        // the live bubble at the bottom of the chat. Its finished message still
        // arrives as a normal `assistant` event and is filed under its parent.
        if (evt.parent_tool_use_id) continue;
        const delta = asObject(asObject(evt.event).delta);
        if (delta.type === "text_delta") push("text", String(delta.text ?? ""));
        else if (delta.type === "thinking_delta") {
          push("thinking", String(delta.thinking ?? ""));
        }
        continue;
      }
      flush(); // ordering: a completed block always lands before the next event
      hooks.onEvent(evt);
    }
  });
  flush();
  session.closed = true;
}

/** Decode a byte stream to text and hand over whole lines (final chunk included). */
async function pump(
  stream: ReadableStream<Uint8Array>,
  onChunk: (text: string) => void,
): Promise<void> {
  // A single frame with no newline is bounded only by what the CLI emits;
  // this is the ceiling past which we stop believing it is a line at all, so
  // a wedged or hostile producer cannot grow the buffer without limit.
  const MAX_LINE = 16 * 1_048_576;
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      // Only the new text can hold the new line end: searching the whole
      // buffer re-read a long unterminated line once per chunk.
      const cut = text.lastIndexOf("\n");
      if (cut >= 0) {
        onChunk(buf + text.slice(0, cut + 1));
        buf = text.slice(cut + 1);
      } else if ((buf += text).length > MAX_LINE) {
        // No newline in 16MB: flush what we have as a line and reset, rather
        // than hold a growing buffer for a terminator that is not coming.
        onChunk(buf + "\n");
        buf = "";
      }
    }
  } catch (e) {
    // Expected when the process is torn down mid-read; anything else is a real
    // transport fault and must not vanish silently.
    log.warn("claude", "stream read ended", {
      error: e instanceof Error ? e.message : String(e),
    });
  } finally {
    reader.releaseLock();
  }
  if (buf) onChunk(`${buf}\n`);
}

const asObject = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" ? v as Record<string, unknown> : {};

/** Run a short command, returning stdout — or `null` if it fails at all. */
async function run(
  bin: string,
  args: string[],
  cwd?: string,
  timeoutMs = 10_000,
): Promise<string | null> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const out = await new Deno.Command(bin, {
      args,
      cwd,
      stdout: "piped",
      stderr: "null",
      signal: ctl.signal,
    }).output();
    return out.success ? new TextDecoder().decode(out.stdout) : null;
  } catch (e) {
    // `null` is a real answer here ("no git", "no CLI"), but the reason is
    // still worth a line — a missing binary looks identical to a timeout.
    log.debug("claude", "subprocess failed", {
      bin,
      error: e instanceof Error ? e.message : String(e),
    });
    return null;
  } finally {
    clearTimeout(timer);
  }
}
