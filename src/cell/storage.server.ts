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
import { homeDir, isDirectory } from "./claude.server.ts";

/** One project's stored history, as it exists on disk. */
export type StoredProject = {
  /** The real working directory, read from inside the newest transcript that
   *  records one. `""` when none would say — the one case this refuses to
   *  guess about. */
  path: string;
  /** The directory under `~/.claude/projects`. */
  dir: string;
  bytes: number;
  sessions: number;
  /** Newest transcript mtime, epoch ms. */
  usedAt: number;
  /** Does the project folder still exist? `null` when no transcript names
   *  one, which is not the same as "gone" and must never be treated as such.
   *  `false` only when EVERY folder its transcripts name is gone — see
   *  {@link verdict}. */
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

/**
 * Does a history's project still exist? Pure, over what its transcripts say:
 * `null` when none of them names a folder.
 *
 * One slug can hold transcripts recorded in more than one folder — the slug
 * is lossy, so `/a/b-c` and `/a/b/c` share one — and the history is only
 * stale when every one of them is gone. Deciding from a single transcript
 * called a live project dead whenever the one it happened to read named the
 * other folder.
 */
export function verdict(
  found: { cwd: string; exists: boolean }[],
): boolean | null {
  if (found.length === 0) return null;
  return found.some((f) => f.exists);
}

/** A history directory's transcripts, newest first by modification time. */
async function transcriptsOf(
  dir: string,
): Promise<{ name: string; mtime: number }[]> {
  let files: Deno.DirEntry[];
  try {
    files = await Array.fromAsync(Deno.readDir(dir));
  } catch {
    return [];
  }
  const out: { name: string; mtime: number }[] = [];
  for (const f of files) {
    if (!f.isFile || !f.name.endsWith(".jsonl")) continue;
    const st = await Deno.stat(join(dir, f.name)).catch(() => null);
    out.push({ name: f.name, mtime: st?.mtime?.getTime() ?? 0 });
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

/**
 * Every folder a history's transcripts name, newest first, each with whether
 * it is still there. Read from inside the files, never from the name.
 */
async function foldersOf(
  dir: string,
  transcripts: { name: string }[],
): Promise<{ cwd: string; exists: boolean }[]> {
  const seen = new Set<string>();
  const out: { cwd: string; exists: boolean }[] = [];
  for (const t of transcripts) {
    const cwd = await cwdOf(join(dir, t.name));
    if (!cwd || seen.has(cwd)) continue;
    seen.add(cwd);
    out.push({ cwd, exists: await isDirectory(cwd) });
  }
  return out;
}

/** `~/.claude/projects`, resolved — so a `~/.claude` that is itself a symlink
 *  (dotfiles kept in a repository) still contains what it contains. */
async function projectsRootOf(): Promise<string> {
  const lexical = join(homeDir(), ".claude", "projects");
  return await Deno.realPath(lexical).catch(() => lexical);
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
    // Newest by modification time — a name is a session uuid, and sorting
    // those found a random transcript rather than the latest one.
    const transcripts = await transcriptsOf(dir);
    const folders = await foldersOf(dir, transcripts);
    projects.push({
      path: folders[0]?.cwd ?? "",
      dir,
      bytes: await treeBytes(dir),
      sessions: transcripts.length,
      usedAt: transcripts[0]?.mtime ?? 0,
      exists: verdict(folders),
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

/**
 * Delete one project's stored history.
 *
 * Refuses unless every one of these holds, because this removes the record of
 * real work and there is no undo for it:
 *
 *  - the directory is under `~/.claude/projects` (checked after resolving, so a
 *    `..` in a name cannot walk out),
 *  - we know what its folders *are* — a history whose `cwd` could not be read
 *    is "unknown", which is not "gone", and
 *  - every folder its transcripts name is genuinely absent right now.
 *
 * All of it is re-derived HERE, from the disk, at the moment of deleting. The
 * page's idea of which folder this belongs to is a snapshot from the last
 * scan and is not trusted: the folder may have come back since, or another
 * transcript may have arrived naming one that exists.
 *
 * Returns the reason it refused, or `null` on success.
 */
export async function deleteProjectHistory(
  dir: string,
): Promise<string | null> {
  const projectsRoot = await projectsRootOf();
  const resolved = await Deno.realPath(dir).catch(() => "");
  if (!resolved || !resolved.startsWith(`${projectsRoot}/`)) {
    return "That directory is not part of Claude Code's project history.";
  }
  const folders = await foldersOf(resolved, await transcriptsOf(resolved));
  const exists = verdict(folders);
  if (exists === null) {
    return "This history does not say which folder it belongs to — refusing " +
      "to delete something that cannot be identified.";
  }
  if (exists) {
    const live = folders.find((f) => f.exists)?.cwd ?? "";
    return `${live} exists — its history is not stale.`;
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
    paths: folders.map((f) => f.cwd),
    sessions: sessions.length,
  });
  return null;
}
