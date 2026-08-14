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
 * The session runs as ONE long-lived `claude -p --input-format stream-json`
 * process: every turn reuses it, so context, tools and MCP servers are paid
 * for once. Turns are written to stdin as NDJSON, events read from stdout.
 */
import { log } from "aio";
// Pure, dependency-free readers over the same protocol — one parser and one
// interrupt-id spelling for both sides of the bridge, both covered by tests.
import {
  HANDSHAKE_PREFIX,
  INTERRUPT_PREFIX,
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
};

type Session = {
  child: Deno.ChildProcess;
  stdin: WritableStreamDefaultWriter<Uint8Array>;
  pid: number;
  closed: boolean;
};

/** At most one session at a time — the app is a control surface for one
 *  project, and a second process would silently double every token cost. */
let live: Session | null = null;

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
export async function start(
  opts: StartOptions,
  hooks: Hooks,
): Promise<{ pid: number }> {
  await stop();

  const stat = await Deno.stat(opts.cwd).catch(() => null);
  if (!stat?.isDirectory) {
    throw new Error(`Project directory not found: ${opts.cwd}`);
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
    child,
    stdin: child.stdin.getWriter(),
    pid: child.pid,
    closed: false,
  };
  live = session;

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
  await write({
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
    if (live === session) live = null;
    session.closed = true;
    hooks.onExit(status.code, stderrTail.trim());
  })();

  return { pid: session.pid };
}

/** Queue a user turn. The CLI accepts input at any time; a turn sent while one
 *  is running is queued by the CLI itself rather than dropped. */
export async function send(text: string): Promise<void> {
  await write({
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
  requestId: string,
  input: Record<string, unknown>,
  updatedPermissions: unknown[] = [],
): Promise<void> {
  await write({
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
  requestId: string,
  message: string,
): Promise<void> {
  await write({
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
export async function interrupt(): Promise<void> {
  await write({
    type: "control_request",
    request_id: `${INTERRUPT_PREFIX}${++interrupts}`,
    request: { subtype: "interrupt" },
  });
}

/** End the session. Closing stdin is the graceful path; SIGTERM is the floor
 *  so a wedged child can never outlive the app. */
export async function stop(): Promise<void> {
  const session = live;
  if (!session || session.closed) {
    live = null;
    return;
  }
  session.closed = true;
  live = null;
  await session.stdin.close().catch(() => {});
  const ended = await Promise.race([
    session.child.status.then(() => true).catch(() => true),
    delay(1_500).then(() => false),
  ]);
  if (!ended) {
    try {
      session.child.kill("SIGTERM");
    } catch (e) {
      log.debug("claude", "kill after graceful close failed", {
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
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

async function write(frame: unknown): Promise<void> {
  const session = live;
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
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const cut = buf.lastIndexOf("\n");
      if (cut >= 0) {
        onChunk(buf.slice(0, cut + 1));
        buf = buf.slice(cut + 1);
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

const delay = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));
