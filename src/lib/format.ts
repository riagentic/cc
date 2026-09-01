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
  let text = i === 0 ? String(Math.round(v)) : v.toFixed(v < 100 ? 1 : 0);
  // Rounding can carry the value into a unit it was never promoted to:
  // 1 048 575 bytes is 1023.999 KB, which prints as `1024 KB` — a size that
  // does not exist. Promote once more and show the unit that does.
  if (Number(text) >= KB && i < UNITS.length - 1) {
    v /= KB;
    i++;
    text = v.toFixed(1);
  }
  return `${text} ${UNITS[i]}`;
}

/** Compact token counts: `842`, `12.4k`, `1.31M`.
 *
 *  Each tier re-checks its own rounding: 999 999 tokens is 999.999k, which
 *  prints as `1000k` — a figure this scale exists to avoid. */
export function tokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n < 1_000) {
    const whole = Math.round(n);
    return whole < 1_000 ? String(whole) : "1.0k";
  }
  if (n < 1_000_000) {
    const text = (n / 1_000).toFixed(n < 10_000 ? 1 : 0);
    if (Number(text) < 1_000) return `${text}k`;
  }
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

/** `in 40s`, `in 12m`, `in 4h`, `in 2d` — and `now` once the moment has passed.
 *
 *  The mirror of {@link ago}, and not expressible as it: a usage window that
 *  resets at 5am is a *future* time, and reading it through a past-tense
 *  formatter printed "just now" for something four hours away. */
export function until(at: number, now: number): string {
  if (!Number.isFinite(at) || !Number.isFinite(now) || at <= 0) return "—";
  const d = at - now;
  if (d <= 0) return "now";
  if (d < 60_000) return `in ${Math.max(1, Math.floor(d / 1000))}s`;
  if (d < 3_600_000) return `in ${Math.floor(d / 60_000)}m`;
  if (d < 86_400_000) return `in ${Math.floor(d / 3_600_000)}h`;
  return `in ${Math.floor(d / 86_400_000)}d`;
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

/**
 * Cut to `max` *code points*, never UTF-16 units.
 *
 * `"😀".slice(0, 1)` is half a surrogate pair, and a lone surrogate renders as
 * the replacement glyph — so the one character a truncated preview costs you was
 * being turned into a visible defect. Emoji and non-BMP scripts are ordinary in
 * a tool title or a commit message; this is not an edge case.
 */
const cutTo = (text: string, max: number): string[] =>
  Array.from(text).slice(0, Math.max(0, max));

/** Single-line preview of arbitrary text, collapsed and hard-capped.
 *
 *  The cap is on the *result*: an ellipsis that pushed the output past `max`
 *  would defeat the one thing a caller asks of this function. */
export function oneLine(text: string, max = 120): string {
  const flat = String(text ?? "").replace(/\s+/g, " ").trim();
  const chars = Array.from(flat);
  if (chars.length <= max) return flat;
  if (max <= 1) return max <= 0 ? "" : "…";
  return `${cutTo(flat, max - 1).join("")}…`;
}

/**
 * Shorten a path from the left: `…/scratchpad/probe/note.txt`.
 *
 * A path is read from the right — the file is the point, the directories above
 * it are context. Capping the tail the way {@link oneLine} does turned every
 * long path into the same prefix and hid the one thing worth reading.
 */
export function tailPath(path: string, max = 90): string {
  const flat = String(path ?? "").replace(/\s+/g, " ").trim();
  const chars = Array.from(flat);
  if (chars.length <= max) return flat;
  if (max <= 1) return max <= 0 ? "" : "…";
  // Code points, not UTF-16 units — the same surrogate-splitting reason as
  // {@link oneLine}, and a path is exactly where an emoji-named folder lives.
  const tail = chars.slice(chars.length - (max - 1));
  // Prefer starting at a segment boundary, when one is close enough that the
  // ellipsis does not swallow a whole extra directory to get there.
  const slash = tail.indexOf("/");
  const from = slash >= 0 && slash < 20 ? slash : 0;
  return `…${tail.slice(from).join("")}`;
}

/** Last path segment — the name we show for a project directory. */
export function baseName(path: string): string {
  const raw = String(path ?? "");
  const trimmed = raw.replace(/[/\\]+$/, "");
  // Nothing but separators (`/`, `//`, `\\`): the root is its own name, and
  // echoing the input back showed a project called `//`.
  if (trimmed === "") return "/";
  const i = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return (i >= 0 ? trimmed.slice(i + 1) : trimmed) || "/";
}

/**
 * `/home/dev/code/cc` → `~/code/cc`, so a header never wraps on a long path.
 *
 * The prefix must end on a segment boundary. A raw `startsWith` turned
 * `/home/dev-tools/proj` into `~-tools/proj` under `$HOME=/home/dev` — a path
 * that is not under home at all, displayed as though it were, under a name that
 * does not exist. Any sibling directory sharing a prefix with home hit this.
 */
export function tildePath(path: string, home: string | null): string {
  if (!home || home.length <= 1) return path;
  const root = home.replace(/[/\\]+$/, "") || home;
  if (path === root) return "~";
  if (path.startsWith(`${root}/`) || path.startsWith(`${root}\\`)) {
    return `~${path.slice(root.length)}`;
  }
  return path;
}

const pad = (n: number): string => String(n).padStart(2, "0");
