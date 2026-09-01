/**
 * @module
 * What Claude Code has stored on this machine, and what of it is reclaimable.
 *
 * This exists because the question "why is `~/.claude` 1.3 GB?" had no answer
 * anywhere. Measured here rather than guessed: a directory under
 * `~/.claude/projects` is named after a *slug* of the project path with every
 * separator replaced by a dash, which is **not reversible** — `-a-b-c` is both
 * `/a/b/c` and `/a/b-c`. Reading the slug back gets the wrong answer often
 * enough to matter: on the machine this was written against, a naive decode
 * called four live projects dead, together holding 380 MB of transcripts that a
 * "clean up dead projects" button would have destroyed.
 *
 * The transcripts themselves record their own `cwd`, so that is what is read.
 * Nothing here infers a path from a name.
 */
import { log } from "aio";
import { join } from "@std/path";
import { homeDir } from "./claude.server.ts";

/** One project's stored history, as it exists on disk. */
export type StoredProject = {
  /** The real working directory, read from inside a transcript. `""` when no
   *  transcript would say — the one case this refuses to guess about. */
  path: string;
  /** The directory under `~/.claude/projects`. */
  dir: string;
  bytes: number;
  sessions: number;
  /** Newest transcript mtime, epoch ms. */
  usedAt: number;
  /** Does the project folder still exist? `null` when `path` is unknown, which
   *  is not the same as "gone" and must never be treated as such. */
  exists: boolean | null;
};

export type StorageReport = {
  totalBytes: number;
  projects: StoredProject[];
  /** Other things the CLI keeps, for the "where did it go" breakdown. */
  extras: { name: string; bytes: number }[];
  scannedAt: number;
};

/** How far into a transcript to look for the `cwd` it records. It appears
 *  within the first few lines; a bounded read keeps this cheap over hundreds of
 *  files, some of which are hundreds of megabytes. */
const CWD_SCAN_LINES = 60;
const CWD_SCAN_BYTES = 64 * 1024;

/** The working directory a transcript was recorded in, or `""`. */
async function cwdOf(file: string): Promise<string> {
  let text: string;
  try {
    const f = await Deno.open(file);
    try {
      const buf = new Uint8Array(CWD_SCAN_BYTES);
      const n = await f.read(buf) ?? 0;
      text = new TextDecoder().decode(buf.subarray(0, n));
    } finally {
      f.close();
    }
  } catch {
    return "";
  }
  let seen = 0;
  for (const line of text.split("\n")) {
    if (++seen > CWD_SCAN_LINES) break;
    if (!line.includes('"cwd"')) continue;
    try {
      const o = JSON.parse(line);
      const cwd = o?.cwd;
      if (typeof cwd === "string" && cwd) return cwd;
    } catch {
      // A line still being written, or the last one truncated by the read cap.
    }
  }
  return "";
}

/** Bytes in a directory tree. Symlinks are counted, never followed. */
async function treeBytes(dir: string): Promise<number> {
  let total = 0;
  let entries: Deno.DirEntry[];
  try {
    entries = await Array.fromAsync(Deno.readDir(dir));
  } catch {
    return 0;
  }
  for (const e of entries) {
    if (e.isSymlink) continue;
    const path = join(dir, e.name);
    if (e.isDirectory) total += await treeBytes(path);
    else {
      const st = await Deno.stat(path).catch(() => null);
      total += st?.size ?? 0;
    }
  }
  return total;
}

/** Everything Claude Code is storing, by project. */
export async function scanStorage(): Promise<StorageReport> {
  const root = join(homeDir(), ".claude");
  const projectsRoot = join(root, "projects");
  const projects: StoredProject[] = [];

  let dirs: Deno.DirEntry[] = [];
  try {
    dirs = await Array.fromAsync(Deno.readDir(projectsRoot));
  } catch {
    // No history at all is a perfectly good answer.
  }

  for (const d of dirs) {
    if (!d.isDirectory) continue;
    const dir = join(projectsRoot, d.name);
    let files: Deno.DirEntry[];
    try {
      files = await Array.fromAsync(Deno.readDir(dir));
    } catch {
      continue;
    }
    const transcripts = files.filter((f) =>
      f.isFile && f.name.endsWith(".jsonl")
    );

    let usedAt = 0;
    for (const f of transcripts) {
      const st = await Deno.stat(join(dir, f.name)).catch(() => null);
      const t = st?.mtime?.getTime() ?? 0;
      if (t > usedAt) usedAt = t;
    }

    // The path comes from inside the newest transcript, never from the name.
    const newest = transcripts
      .map((f) => f.name)
      .sort()
      .reverse();
    let path = "";
    for (const name of newest) {
      path = await cwdOf(join(dir, name));
      if (path) break;
    }

    projects.push({
      path,
      dir,
      bytes: await treeBytes(dir),
      sessions: transcripts.length,
      usedAt,
      exists: path ? await isDir(path) : null,
    });
  }

  const extras: { name: string; bytes: number }[] = [];
  for (const name of ["file-history", "shell-snapshots", "tasks", "todos"]) {
    const bytes = await treeBytes(join(root, name));
    if (bytes > 0) extras.push({ name, bytes });
  }

  projects.sort((a, b) => b.bytes - a.bytes);
  return {
    totalBytes: projects.reduce((n, p) => n + p.bytes, 0) +
      extras.reduce((n, e) => n + e.bytes, 0),
    projects,
    extras,
    scannedAt: Date.now(),
  };
}

const isDir = async (path: string): Promise<boolean> =>
  (await Deno.stat(path).catch(() => null))?.isDirectory === true;

/**
 * Delete one project's stored history.
 *
 * Refuses unless every one of these holds, because this removes the record of
 * real work and there is no undo for it:
 *
 *  - the directory is under `~/.claude/projects` (checked after resolving, so a
 *    `..` in a name cannot walk out),
 *  - the project's own folder is genuinely absent right now, and
 *  - we know what that folder *is* — a directory whose `cwd` could not be read
 *    is "unknown", which is not "gone".
 *
 * Returns the reason it refused, or `null` on success.
 */
export async function deleteProjectHistory(
  dir: string,
  expectedPath: string,
): Promise<string | null> {
  const projectsRoot = join(homeDir(), ".claude", "projects");
  const resolved = await Deno.realPath(dir).catch(() => "");
  if (!resolved || !resolved.startsWith(`${projectsRoot}/`)) {
    return "That directory is not part of Claude Code's project history.";
  }
  if (!expectedPath) {
    return "This history does not say which folder it belongs to — refusing " +
      "to delete something that cannot be identified.";
  }
  if (await isDir(expectedPath)) {
    return `${expectedPath} exists — its history is not stale.`;
  }

  // The sessions this history holds, so their file-history goes with it rather
  // than being left behind keyed to transcripts that no longer exist.
  const sessions: string[] = [];
  try {
    for await (const f of Deno.readDir(resolved)) {
      if (f.isFile && f.name.endsWith(".jsonl")) {
        sessions.push(f.name.slice(0, -6));
      }
    }
  } catch { /* nothing to enumerate */ }

  try {
    await Deno.remove(resolved, { recursive: true });
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }

  const history = join(homeDir(), ".claude", "file-history");
  for (const id of sessions) {
    // Session ids are uuids; anything else is not ours to remove.
    if (!/^[0-9a-f-]{36}$/i.test(id)) continue;
    await Deno.remove(join(history, id), { recursive: true }).catch(() => {});
  }
  log.info("storage", "deleted stale project history", {
    path: expectedPath,
    sessions: sessions.length,
  });
  return null;
}
