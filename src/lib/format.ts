/**
 * @module
 * Pure formatters. No aio imports, no I/O — safe on both sides of the bridge
 * and directly unit-testable.
 */

const KB = 1024;
const UNITS = ["B", "KB", "MB", "GB", "TB"] as const;

/** Human byte size: `0 B`, `812 B`, `12.4 KB`, `1.3 MB`. */
export function bytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  let v = n;
  let i = 0;
  while (v >= KB && i < UNITS.length - 1) {
    v /= KB;
    i++;
  }
  // One decimal below 100 — `12.4 KB` carries information that `12 KB` loses,
  // while `145 KB` does not need `145.3`.
  return `${i === 0 ? Math.round(v) : v.toFixed(v < 100 ? 1 : 0)} ${UNITS[i]}`;
}

/** Compact token counts: `842`, `12.4k`, `1.31M`. */
export function tokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n < 1_000) return String(Math.round(n));
  if (n < 1_000_000) return `${(n / 1_000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

/** Stopwatch text for a live turn: `0.8s`, `12.4s`, `3m 07s`, `1h 04m`. */
export function duration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0.0s";
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const s = Math.floor(ms / 1000);
  if (s < 3600) return `${Math.floor(s / 60)}m ${pad(s % 60)}s`;
  return `${Math.floor(s / 3600)}h ${pad(Math.floor((s % 3600) / 60))}m`;
}

/** Wall-clock `14:03:22`, for timeline rows. `--:--:--` for a timestamp that
 *  is not one — every other formatter here refuses to print `NaN`, and a row
 *  with a broken clock still has something worth reading beside it.
 *
 *  The check is on the `Date`, not on the number: `Number.isFinite` passes for
 *  values past the end of representable time (`MAX_SAFE_INTEGER` is one), and
 *  those printed `NaN:NaN:NaN` — the one output this was written to prevent. */
export function clock(at: number): string {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return "--:--:--";
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** `just now`, `12s ago`, `4m ago`, `2h ago`, `3d ago`. */
export function ago(at: number, now: number): string {
  if (!Number.isFinite(at) || !Number.isFinite(now)) return "—";
  const d = Math.max(0, now - at);
  if (d < 3_000) return "just now";
  if (d < 60_000) return `${Math.floor(d / 1000)}s ago`;
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m ago`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h ago`;
  return `${Math.floor(d / 86_400_000)}d ago`;
}

/** USD with the precision a per-turn cost actually needs. */
export function usd(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "$0.00";
  return n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
}

/** Percent 0–100, clamped, one decimal below 10%. */
export function pct(part: number, whole: number): number {
  if (!Number.isFinite(part) || !Number.isFinite(whole) || whole <= 0) return 0;
  return Math.min(100, Math.max(0, (part / whole) * 100));
}

/** Single-line preview of arbitrary text, collapsed and hard-capped. */
export function oneLine(text: string, max = 120): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * Shorten a path from the left: `…/scratchpad/probe/note.txt`.
 *
 * A path is read from the right — the file is the point, the directories above
 * it are context. Capping the tail the way {@link oneLine} does turned every
 * long path into the same prefix and hid the one thing worth reading.
 */
export function tailPath(path: string, max = 90): string {
  const flat = path.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const cut = flat.length - (max - 1);
  // Prefer starting at a segment boundary, when one is close enough that the
  // ellipsis does not swallow a whole extra directory to get there.
  const slash = flat.indexOf("/", cut);
  const from = slash >= 0 && slash - cut < 20 ? slash : cut;
  return `…${flat.slice(from)}`;
}

/** Last path segment — the name we show for a project directory. */
export function baseName(path: string): string {
  const trimmed = path.replace(/[/\\]+$/, "");
  const i = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return (i >= 0 ? trimmed.slice(i + 1) : trimmed) || path || "/";
}

/** `/home/dev/code/cc` → `~/code/cc`, so a header never wraps on a long path. */
export function tildePath(path: string, home: string | null): string {
  if (home && home.length > 1 && path.startsWith(home)) {
    return `~${path.slice(home.length)}`;
  }
  return path;
}

const pad = (n: number): string => String(n).padStart(2, "0");
