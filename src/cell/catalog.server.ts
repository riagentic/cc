/**
 * @module
 * Server-side reads for everything Claude Code keeps *outside* the live
 * session: its background sessions, the project's files, and the configuration
 * on disk that decides what a session can do.
 *
 * Separate from `claude.server.ts` on purpose. That module owns one long-lived
 * child process and the protocol spoken to it; this one owns the filesystem and
 * short-lived `claude` subcommands. Nothing here touches the running session, so
 * nothing here can wedge it.
 *
 * Every read is best-effort by design: these are other programs' files, written
 * by a CLI that is upgraded independently of this app. A field that moved is a
 * missing value, never a thrown page.
 */
import { join } from "@std/path";
import type {
  DaemonInfo,
  HookInfo,
  Job,
  JobEvent,
  JobState,
  McpInfo,
  PluginInfo,
  Scope,
  SkillInfo,
  TreeNode,
} from "../type/claude.ts";
import { homeDir } from "./claude.server.ts";
import { makeTargets, type Manifests, noManifests } from "../lib/launch.ts";

/* ── small readers ───────────────────────────────────────────────────────── */

/** Parse a JSON file, or `null`. The file belonging to another program is the
 *  normal case for everything in this module — absent is not an error. */
async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await Deno.readTextFile(path));
  } catch {
    return null;
  }
}

/**
 * JSON with comments and trailing commas made plain JSON: `//` and `/* *\/`
 * comments dropped, a comma before `}` or `]` dropped, strings untouched.
 *
 * Deno reads `deno.json` this way too — a commented one is ordinary, and
 * `deno.jsonc` is commented by name — so a strict parse found no tasks in
 * either and the project's Dev button never appeared. Pure, one pass.
 */
export function stripJsonc(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"') {
      // A string, copied whole — a `//` inside a URL is not a comment.
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? text.length : end + 2;
    } else if (c === ",") {
      // Trailing: only whitespace and comments stand between it and a close.
      const next = text[skipBlank(text, i + 1)];
      if (next !== "}" && next !== "]") out += c;
      i++;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/** The index of the next character that is neither whitespace nor inside a
 *  comment — what a comma is followed by, for {@link stripJsonc}. */
function skipBlank(text: string, from: number): number {
  let i = from;
  while (i < text.length) {
    if (/\s/.test(text[i])) i++;
    else if (text.startsWith("//", i)) {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (text.startsWith("/*", i)) {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? text.length : end + 2;
    } else break;
  }
  return i;
}

async function readJsonc(path: string): Promise<unknown> {
  try {
    return JSON.parse(stripJsonc(await Deno.readTextFile(path)));
  } catch {
    return null;
  }
}

const obj = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v)
    ? v as Record<string, unknown>
    : {};

const str = (v: unknown): string => typeof v === "string" ? v : "";
const num = (v: unknown): number =>
  typeof v === "number" && isFinite(v) ? v : 0;

/** An ISO timestamp or an epoch number, both of which the CLI writes, to ms. */
function time(v: unknown): number {
  if (typeof v === "number") return isFinite(v) ? v : 0;
  if (typeof v !== "string") return 0;
  const t = Date.parse(v);
  return isNaN(t) ? 0 : t;
}

/* ── background sessions (jobs) ──────────────────────────────────────────── */

/** How much of a job's timeline is worth carrying into the UI. It is a
 *  progress log, not a transcript — the transcript is what `attach` is for. */
const MAX_TIMELINE = 40;

/** How much of one entry's text to carry. Each entry embeds whatever the job
 *  said at that point, which for a long answer is tens of kilobytes — and this
 *  is state, broadcast to every connected client on every poll. The page shows
 *  a single line of it; the rest is what `claude attach` is for. */
const MAX_ENTRY_TEXT = 600;

const JOB_STATES = new Set<JobState>([
  "working",
  "blocked",
  "done",
  "failed",
  "stopped",
]);

const jobState = (v: unknown): JobState =>
  JOB_STATES.has(str(v) as JobState) ? str(v) as JobState : "unknown";

/** `["--model", "opus", …]` → `"opus"`. The CLI stores the flags it would
 *  respawn a job with, which is the only place a job records its model. */
function flagValue(flags: unknown, name: string): string | null {
  const list = Array.isArray(flags) ? flags.map(str) : [];
  const i = list.indexOf(name);
  return i >= 0 && i + 1 < list.length ? list[i + 1] : null;
}

/** How much of the end of a timeline file to read. Each entry embeds the text
 *  the job produced, so a long-running job's timeline reaches megabytes — and
 *  this is read on a poll. The tail is the part anybody wants. */
const TIMELINE_TAIL = 256 * 1024;

/** The last few entries of a job's `timeline.jsonl`, oldest last.
 *
 *  Read from the end, which is why the *first* line is the one that may be a
 *  fragment: a tail read lands mid-line far more often than not. It is dropped
 *  by the same parse guard that handles a line still being written. */
async function jobTimeline(dir: string): Promise<JobEvent[]> {
  let text: string;
  try {
    const path = join(dir, "timeline.jsonl");
    const stat = await Deno.stat(path);
    if (stat.size <= TIMELINE_TAIL) {
      text = await Deno.readTextFile(path);
    } else {
      const f = await Deno.open(path);
      try {
        await f.seek(stat.size - TIMELINE_TAIL, Deno.SeekMode.Start);
        const buf = new Uint8Array(TIMELINE_TAIL);
        let read = 0;
        while (read < buf.length) {
          const n = await f.read(buf.subarray(read));
          if (n === null) break;
          read += n;
        }
        text = new TextDecoder().decode(buf.subarray(0, read));
      } finally {
        f.close();
      }
    }
  } catch {
    return [];
  }
  const out: JobEvent[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      continue; // the fragment a tail read starts on, or a line mid-write
    }
    const e = obj(raw);
    out.push({
      at: time(e.at),
      state: jobState(e.state),
      detail: str(e.detail),
      text: str(e.text).slice(0, MAX_ENTRY_TEXT),
    });
  }
  return out.slice(-MAX_TIMELINE);
}

/**
 * Every background session the CLI knows about.
 *
 * Read from `~/.claude/jobs/*` rather than by shelling out to `claude agents
 * --json`: this runs on a poll, and spawning a CLI process every few seconds to
 * learn what four JSON files already say is a cost with nothing bought. The
 * subcommands are still what *acts* on a job — see {@link jobAction}.
 */
export async function listJobs(known?: DaemonInfo): Promise<Job[]> {
  const root = join(homeDir(), ".claude", "jobs");
  const out: Job[] = [];
  // Read once for the whole listing: staleness is a fact about the service,
  // not about each job, and asking per job would stat the same pid N times.
  // A caller that has just read it passes it in, rather than reading twice.
  const daemon = known ?? await readDaemon();
  let entries: Deno.DirEntry[];
  try {
    entries = await Array.fromAsync(Deno.readDir(root));
  } catch {
    return []; // no background session has ever been started
  }

  for (const e of entries) {
    if (!e.isDirectory) continue;
    const dir = join(root, e.name);
    const s = obj(await readJson(join(dir, "state.json")));
    if (Object.keys(s).length === 0) continue;

    // `block.questions` is how a job records that it stopped to ask something.
    // Without it a blocked job shows a reason and no question, which is the
    // half of the story that cannot be acted on.
    const questions = (Array.isArray(obj(s.block).questions)
      ? obj(s.block).questions as unknown[]
      : [])
      .map((q) =>
        str(obj(q).question)
      )
      .filter(Boolean);

    const intent = str(s.intent);
    out.push({
      id: str(s.daemonShort) || e.name,
      sessionId: str(s.sessionId) || null,
      // A job names itself once it has done enough to know what it is doing;
      // until then its prompt is the only name there is.
      name: str(s.name) || intent || e.name,
      intent,
      state: jobState(s.state),
      detail: str(s.detail),
      needs: str(s.needs),
      questions,
      cwd: str(s.cwd),
      model: flagValue(s.respawnFlags, "--model"),
      tokens: num(s.tokens),
      inFlight: {
        tasks: num(obj(s.inFlight).tasks),
        queued: num(obj(s.inFlight).queued),
      },
      cliVersion: str(s.cliVersion) || null,
      createdAt: time(s.createdAt),
      updatedAt: time(s.updatedAt),
      timeline: await jobTimeline(dir),
      worktree: str(s.worktreePath) || null,
      // A job that says it is working or waiting, with no service alive to be
      // running it. Deliberately narrow: it is not "the daemon does not list
      // it" — the roster only names live *workers*, and a blocked job is not
      // one — it is "there is no service at all", which is provable from one
      // pid and is the exact condition under which `claude rm` refuses.
      stale: !daemon.running &&
        (jobState(s.state) === "working" || jobState(s.state) === "blocked"),
    });
  }
  // Freshest first: a job that moved a second ago is the one being watched.
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

/* ── how a project is run ─────────────────────────────────────────────────── */

/**
 * Read what a project's manifests say about running it.
 *
 * Four cheap file reads, none of which is required to exist. Everything that
 * decides what the buttons offer is in `lib/launch.ts`, which is pure — this
 * only gathers.
 */
export async function readManifests(root: string): Promise<Manifests> {
  const found = noManifests();

  for (const name of ["deno.json", "deno.jsonc"]) {
    const cfg = obj(await readJsonc(join(root, name)));
    const tasks = obj(cfg.tasks);
    if (Object.keys(tasks).length > 0) {
      found.denoTasks = Object.keys(tasks);
      break;
    }
  }

  const pkg = obj(await readJson(join(root, "package.json")));
  found.npmScripts = Object.keys(obj(pkg.scripts));

  found.cargo = await Deno.stat(join(root, "Cargo.toml"))
    .then((st) => st.isFile).catch(() => false);

  for (const name of ["Makefile", "makefile", "GNUmakefile"]) {
    const text = await Deno.readTextFile(join(root, name)).catch(() => null);
    if (text !== null) {
      // Bounded: a generated Makefile can be enormous, and only the first few
      // hundred lines ever hold the targets a person types.
      found.makeTargets = makeTargets(text.slice(0, 64 * 1024));
      break;
    }
  }

  return found;
}

/* ── the background service ──────────────────────────────────────────────── */

/**
 * Is a process alive, without disturbing it?
 *
 * `/proc` on Linux: a directory lookup, exact, and with no signal sent to
 * somebody else's supervisor. Everywhere else, `SIGCONT` — which a running
 * process ignores and a dead one answers with `NotFound`. On a platform where
 * neither works the answer is `true`, because claiming a service is dead when
 * we cannot tell would turn "I do not know" into a wrong instruction.
 */
async function pidAlive(pid: number): Promise<boolean> {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (Deno.build.os === "linux") {
    return await Deno.stat(`/proc/${pid}`).then(() => true).catch(() => false);
  }
  try {
    Deno.kill(pid, "SIGCONT");
    return true;
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return false;
    // PermissionDenied means it exists and belongs to somebody else.
    return true;
  }
}

/**
 * What the background service's own roster says, and whether the process it
 * names is still there.
 *
 * The roster is the daemon's file, not ours: it is read, never written. A
 * supervisor that exited leaves its pid behind — which is exactly the state
 * that makes `claude stop` and `claude rm` fail, so the stale pid is the
 * signal rather than a nuisance.
 */
export async function readDaemon(): Promise<DaemonInfo> {
  const roster = obj(
    await readJson(join(homeDir(), ".claude", "daemon", "roster.json")),
  );
  const pid = num(roster.supervisorPid);
  const workers = Object.keys(obj(roster.workers));
  return {
    pid,
    updatedAt: time(roster.updatedAt),
    workers,
    running: pid > 0 ? await pidAlive(pid) : false,
  };
}

/**
 * Delete this app's — and the CLI's — record of a background session.
 *
 * The escape hatch for a job the CLI will not remove. `claude rm` confirms the
 * kill through the daemon, so when no daemon is running it refuses, and a job
 * whose daemon died months ago can never be removed by any command. That is
 * the state this exists for, and the caller is expected to have checked it.
 *
 * What it removes is `~/.claude/jobs/<id>` and nothing else. The conversation
 * lives in `~/.claude/projects`, and a worktree lives wherever git put it —
 * both survive, and the worktree path is returned so the caller can say so
 * rather than leave it as a surprise.
 */
export async function forgetJob(
  id: string,
): Promise<{ error: string | null; worktree: string | null }> {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) {
    return { error: `Not a job id: ${id}`, worktree: null };
  }
  const dir = join(homeDir(), ".claude", "jobs", id);
  // Read before removing, so the answer can name what was left behind.
  const state = obj(await readJson(join(dir, "state.json")));
  const worktree = str(state.worktreePath) || null;
  try {
    await Deno.remove(dir, { recursive: true });
    return { error: null, worktree };
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) {
      // Already gone. The caller wanted it gone; it is gone.
      return { error: null, worktree };
    }
    return {
      error: e instanceof Error ? e.message : String(e),
      worktree,
    };
  }
}

/** What a job can be told to do, and the subcommand that does it. `attach` is
 *  absent on purpose — it takes over a terminal, which this app does not have. */
const JOB_ACTIONS = {
  stop: "stop", // keeps the conversation; `attach` reopens it
  remove: "rm", // deletes it, and its worktree when that is safe
  respawn: "respawn", // restart under the current CLI version
} as const;

export type JobAction = keyof typeof JOB_ACTIONS;

/** Run one of the CLI's job subcommands. Returns `null` on success, or the
 *  reason it failed — which the UI shows rather than silently doing nothing. */
export async function jobAction(
  id: string,
  action: JobAction,
): Promise<string | null> {
  const sub = JOB_ACTIONS[action];
  if (!sub) return `Unknown action: ${action}`;
  // The id comes from a directory name we read ourselves, but it is still
  // interpolated into an argv, so it is checked rather than trusted.
  if (!/^[A-Za-z0-9_-]+$/.test(id)) return `Not a job id: ${id}`;

  const bin = Deno.env.get("CLAUDE_BIN") ?? "claude";
  try {
    const out = await new Deno.Command(bin, {
      args: [sub, id],
      stdout: "piped",
      stderr: "piped",
    }).output();
    if (out.success) return null;
    const err = new TextDecoder().decode(out.stderr).trim();
    return err || `claude ${sub} ${id} exited ${out.code}`;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

/* ── project tree ────────────────────────────────────────────────────────── */

/** Directories never worth walking into. Not a `.gitignore` parser — that is a
 *  spec of its own — but the handful that would otherwise dominate every repo
 *  and cost thousands of `stat` calls to say nothing. */
const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  ".venv",
  "venv",
  "__pycache__",
  "target",
  "dist",
  "build",
  ".next",
  ".cache",
  "vendor",
]);

/** Entries per directory, and total entries in one read. A generated folder can
 *  hold a hundred thousand files, and a file panel that tries to list them all
 *  hangs the render rather than being useful. */
const MAX_PER_DIR = 500;
const MAX_NODES = 4_000;

/**
 * The project tree as a flat, depth-tagged list — the shape a virtualised list
 * renders directly, and the shape that makes "expanded" a property of the
 * request rather than of a mutable tree the client has to keep in sync.
 *
 * Only `open` directories are descended into, so the cost of the panel is the
 * cost of what the user actually opened.
 */
export async function readTree(
  root: string,
  open: readonly string[],
): Promise<TreeNode[]> {
  const opened = new Set(open);
  const out: TreeNode[] = [];

  async function walk(dir: string, depth: number): Promise<void> {
    if (out.length >= MAX_NODES) return;
    let entries: Deno.DirEntry[];
    try {
      entries = await Array.fromAsync(Deno.readDir(dir));
    } catch {
      return; // unreadable directory — show the parent, skip the contents
    }
    // Directories first, then files, each alphabetical: the order every file
    // browser uses, and the one that makes a deep tree scannable.
    entries.sort((a, b) =>
      a.isDirectory === b.isDirectory
        ? a.name.localeCompare(b.name)
        : a.isDirectory
        ? -1
        : 1
    );

    for (const e of entries.slice(0, MAX_PER_DIR)) {
      if (out.length >= MAX_NODES) return;
      // Symlinks are not followed: a link back up the tree is an infinite walk,
      // and `readTree` has no cycle memory to catch it with.
      if (e.isSymlink) continue;
      if (e.isDirectory && SKIP_DIRS.has(e.name)) continue;

      const path = join(dir, e.name);
      const isOpen = e.isDirectory && opened.has(path);
      const stat = e.isFile ? await Deno.stat(path).catch(() => null) : null;

      out.push({
        path,
        name: e.name,
        dir: e.isDirectory,
        bytes: stat?.size ?? null,
        depth,
        open: isOpen,
      });
      if (isOpen) await walk(path, depth + 1);
    }
  }

  await walk(root, 0);
  return out;
}

/** How much of a file the preview pane will take. Enough to read a source file,
 *  bounded so opening a 400MB log does not become the app's memory footprint. */
const MAX_PREVIEW = 200_000;

/** A file's text for the preview pane, or the reason it cannot be shown. */
export async function readFilePreview(
  path: string,
): Promise<{ text: string; bytes: number; truncated: boolean; error: string }> {
  const empty = { text: "", bytes: 0, truncated: false };
  const stat = await Deno.stat(path).catch(() => null);
  if (!stat?.isFile) return { ...empty, error: "Not a file." };
  try {
    // Read only the preview window, never the whole file — the size is known
    // from the stat, so a multi-GB log costs MAX_PREVIEW bytes, not its length.
    const file = await Deno.open(path, { read: true });
    let slice: Uint8Array;
    try {
      const buf = new Uint8Array(Math.min(stat.size, MAX_PREVIEW));
      let n = 0;
      while (n < buf.length) {
        const read = await file.read(buf.subarray(n));
        if (read === null) break;
        n += read;
      }
      slice = buf.subarray(0, n);
    } finally {
      file.close();
    }
    const truncated = stat.size > slice.length;
    // A cut multi-byte character at the window edge is truncation, not binary:
    // drop the partial sequence so `fatal` below judges only whole characters.
    if (truncated) {
      let end = slice.length;
      while (end > 0 && (slice[end - 1] & 0b1100_0000) === 0b1000_0000) end--;
      if (end > 0 && (slice[end - 1] & 0b1100_0000) === 0b1100_0000) end--;
      slice = slice.subarray(0, end);
    }
    // `fatal` so binary is *reported* as binary rather than rendered as a page
    // of replacement glyphs that looks like a decoding bug in this app.
    const text = new TextDecoder("utf-8", { fatal: true }).decode(slice);
    return { text, bytes: stat.size, truncated, error: "" };
  } catch (e) {
    if (e instanceof TypeError) {
      return { ...empty, bytes: stat.size, error: "Binary file." };
    }
    return { ...empty, bytes: stat.size, error: "Could not read this file." };
  }
}

/* ── configuration on disk ───────────────────────────────────────────────── */

/** The `name: value` front-matter a skill or command file opens with. Deliberately
 *  minimal: the only field either page shows is `description`, and a full YAML
 *  parser for one string would be a dependency bought for nothing. */
function frontMatter(text: string): Record<string, string> {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return {};
  const out: Record<string, string> = {};
  for (const line of m[1].split("\n")) {
    const kv = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (kv) out[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

/** The first line that is neither front-matter nor a heading — what a file
 *  without a `description:` is about. */
function firstProse(text: string): string {
  const body = text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
  for (const line of body.split("\n")) {
    const t = line.trim();
    if (t && !t.startsWith("#")) return t;
  }
  return "";
}

async function describe(path: string): Promise<string> {
  try {
    // Only the head is read: a description lives in the first few lines, and a
    // skill's reference material can run to megabytes.
    const f = await Deno.open(path);
    let n = 0;
    const buf = new Uint8Array(4_000);
    try {
      n = await f.read(buf) ?? 0;
    } finally {
      // Closed on a failed read too: a skills folder is scanned on every
      // project switch, and each leaked handle stays open for the app's life.
      f.close();
    }
    const text = new TextDecoder().decode(buf.subarray(0, n));
    return frontMatter(text).description || firstProse(text);
  } catch {
    return "";
  }
}

/**
 * Skills live as `<dir>/<name>/SKILL.md`; commands as `<dir>/<name>.md`.
 *
 * The entry's own type is deliberately *not* consulted. Keeping skills in a
 * repository and symlinking them into `~/.claude/skills` is an ordinary setup,
 * and `readDir` reports such an entry as `isSymlink` with `isDirectory: false` —
 * so a check on the entry type found nothing at all on a machine whose skills
 * were all linked. `stat` follows the link and answers the only question that
 * matters: is there a definition file at the end of this name.
 *
 * (The tree walker in this same module skips symlinks for the opposite and
 * equally deliberate reason: that walk is unbounded and a link up the tree is
 * an infinite one. This one is a single level with a fixed filename.)
 */
async function scanDefinitions(
  dir: string,
  scope: Scope,
  kind: "skill" | "command",
): Promise<SkillInfo[]> {
  const out: SkillInfo[] = [];
  let entries: Deno.DirEntry[];
  try {
    entries = await Array.fromAsync(Deno.readDir(dir));
  } catch {
    return [];
  }
  for (const e of entries) {
    const path = kind === "skill"
      ? join(dir, e.name, "SKILL.md")
      : join(dir, e.name);
    if (kind === "command" && !e.name.endsWith(".md")) continue;
    const stat = await Deno.stat(path).catch(() => null);
    if (!stat?.isFile) continue;
    out.push({
      name: kind === "skill" ? e.name : e.name.slice(0, -3),
      scope,
      description: await describe(path),
      path,
    });
  }
  return out;
}

/** Skills and commands from both scopes. The project's own shadow the user's,
 *  which is what the CLI does — showing both under one name would claim two
 *  definitions are active when only one is. */
export async function scanDefinitionDirs(
  projectPath: string,
  kind: "skill" | "command",
): Promise<SkillInfo[]> {
  const sub = kind === "skill" ? "skills" : "commands";
  const user = await scanDefinitions(
    join(homeDir(), ".claude", sub),
    "user",
    kind,
  );
  // No project, no project scope — see `inProject`.
  const project = projectPath
    ? await scanDefinitions(join(projectPath, ".claude", sub), "project", kind)
    : [];
  const byName = new Map(user.map((d) => [d.name, d]));
  for (const d of project) byName.set(d.name, d);
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** The settings files the CLI reads, nearest last — the same precedence it
 *  applies, so the list reads in the order that decides who wins. */
const settingsFiles = (projectPath: string): [string, Scope][] => [
  [join(homeDir(), ".claude", "settings.json"), "user"],
  ...inProject(projectPath, [
    [".claude", "settings.json"],
    [".claude", "settings.local.json"],
  ]),
];

/**
 * A project's own files, or none when there is no project.
 *
 * `join("", ".mcp.json")` is `.mcp.json` — relative, so resolved against the
 * APP's working directory. With nothing selected, the pages listed whatever
 * configuration the app happened to be launched beside, labelled "project".
 */
const inProject = (
  projectPath: string,
  files: string[][],
): [string, Scope][] =>
  projectPath
    ? files.map((parts) => [join(projectPath, ...parts), "project"])
    : [];

/**
 * What the CLI itself is configured to do for this project.
 *
 * A new project should start where a terminal in that directory would start —
 * not on this app's own opinion — so its settings are seeded from the same
 * files the CLI reads, nearest scope winning. Anything the files do not say is
 * left to the caller's default rather than invented here.
 */
export async function readCliDefaults(
  projectPath: string,
): Promise<{ model: string; effort: string; permissionMode: string }> {
  const out = { model: "", effort: "", permissionMode: "" };
  for (const [path] of settingsFiles(projectPath)) {
    const doc = obj(await readJson(path));
    // `model` and `effortLevel` are the CLI's own spellings; the permission
    // default lives one level down, under `permissions`.
    if (str(doc.model)) out.model = str(doc.model);
    if (str(doc.effortLevel)) out.effort = str(doc.effortLevel);
    const mode = str(obj(doc.permissions).defaultMode);
    if (mode) out.permissionMode = mode;
  }
  return out;
}

/** Every hook configured for this project, across settings files.
 *
 *  Hooks are the one piece of configuration that runs arbitrary commands on the
 *  user's machine on the model's behalf, so "what is installed, and from where"
 *  is worth a page of its own rather than a line in a summary. */
export async function scanHooks(projectPath: string): Promise<HookInfo[]> {
  const out: HookInfo[] = [];
  for (const [path, scope] of settingsFiles(projectPath)) {
    const hooks = obj(obj(await readJson(path)).hooks);
    for (const [event, raw] of Object.entries(hooks)) {
      for (const entry of Array.isArray(raw) ? raw : []) {
        const e = obj(entry);
        const list = Array.isArray(e.hooks) ? e.hooks : [];
        for (const h of list) {
          out.push({
            event,
            matcher: str(e.matcher),
            type: str(obj(h).type) || "command",
            command: str(obj(h).command),
            scope,
            path,
          });
        }
      }
    }
  }
  return out;
}

/** Installed plugins, joined to whether settings has them switched on. */
export async function scanPlugins(): Promise<PluginInfo[]> {
  const root = join(homeDir(), ".claude");
  const installed = obj(
    obj(await readJson(join(root, "plugins", "installed_plugins.json")))
      .plugins,
  );
  const enabled = obj(
    obj(await readJson(join(root, "settings.json")))
      .enabledPlugins,
  );

  const out: PluginInfo[] = [];
  for (const [key, raw] of Object.entries(installed)) {
    // The key is `<plugin>@<marketplace>`; the value is one entry per scope it
    // is installed at.
    const at = key.lastIndexOf("@");
    const name = at > 0 ? key.slice(0, at) : key;
    const marketplace = at > 0 ? key.slice(at + 1) : "";
    for (const entry of Array.isArray(raw) ? raw : []) {
      const e = obj(entry);
      out.push({
        name,
        marketplace,
        version: str(e.version),
        scope: str(e.scope) || "user",
        enabled: enabled[key] === true,
        installedAt: time(e.installedAt),
        loaded: false, // the cell fills this from the running session
      });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** MCP servers as configured, across the files the CLI reads them from. */
export async function scanMcp(projectPath: string): Promise<McpInfo[]> {
  const sources: [string, Scope][] = [
    [join(homeDir(), ".claude.json"), "user"],
    [join(homeDir(), ".claude", "settings.json"), "user"],
    ...inProject(projectPath, [
      [".mcp.json"],
      [".claude", "settings.json"],
      [".claude", "settings.local.json"],
    ]),
  ];
  const byName = new Map<string, McpInfo>();

  for (const [path, scope] of sources) {
    const doc = obj(await readJson(path));
    // `~/.claude.json` also keys servers by project path — THIS project's
    // entry only. Merging every project's made a server configured for one
    // codebase show as available in all of them, which the CLI never does.
    const scopes = [obj(doc.mcpServers)];
    if (projectPath) {
      scopes.push(obj(obj(obj(doc.projects)[projectPath]).mcpServers));
    }
    for (const servers of scopes) {
      for (const [name, raw] of Object.entries(servers)) {
        const s = obj(raw);
        const url = str(s.url);
        byName.set(name, {
          name,
          transport: str(s.type) || (url ? "http" : "stdio"),
          target: url ||
            [str(s.command), ...(Array.isArray(s.args) ? s.args.map(str) : [])]
              .join(" ").trim(),
          scope,
          path,
          status: "",
        });
      }
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}
