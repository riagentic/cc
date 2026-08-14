import { assertEquals } from "@std/assert";
import {
  ago,
  baseName,
  bytes,
  clock,
  duration,
  oneLine,
  pct,
  tailPath,
  tildePath,
  tokens,
  usd,
} from "../../lib/format.ts";

Deno.test("bytes — rounds by unit, never shows a bare number", () => {
  assertEquals(bytes(0), "0 B");
  assertEquals(bytes(-5), "0 B");
  assertEquals(bytes(812), "812 B");
  assertEquals(bytes(1024), "1.0 KB");
  assertEquals(bytes(12_698), "12.4 KB");
  assertEquals(bytes(1_363_148), "1.3 MB");
  assertEquals(bytes(Number.NaN), "0 B");
});

Deno.test("tokens — compact at every magnitude", () => {
  assertEquals(tokens(0), "0");
  assertEquals(tokens(842), "842");
  assertEquals(tokens(1_200), "1.2k");
  assertEquals(tokens(24_018), "24k");
  assertEquals(tokens(1_310_000), "1.31M");
});

Deno.test("duration — seconds, minutes, hours", () => {
  assertEquals(duration(0), "0.0s");
  assertEquals(duration(-1), "0.0s");
  assertEquals(duration(812), "0.8s");
  assertEquals(duration(12_400), "12.4s");
  assertEquals(duration(187_000), "3m 07s");
  assertEquals(duration(3_840_000), "1h 04m");
});

Deno.test("pct — clamps and survives a zero window", () => {
  assertEquals(pct(50, 200), 25);
  assertEquals(pct(300, 200), 100);
  assertEquals(pct(-1, 200), 0);
  assertEquals(pct(10, 0), 0);
});

Deno.test("usd — more precision when the number is small", () => {
  assertEquals(usd(0), "$0.00");
  assertEquals(usd(0.0064), "$0.0064");
  assertEquals(usd(1.5), "$1.50");
});

Deno.test("ago — thresholds", () => {
  const now = 1_000_000_000;
  assertEquals(ago(now, now), "just now");
  assertEquals(ago(now - 12_000, now), "12s ago");
  assertEquals(ago(now - 240_000, now), "4m ago");
  assertEquals(ago(now - 7_200_000, now), "2h ago");
  assertEquals(ago(now + 5_000, now), "just now"); // clock skew is not negative time
  // A timestamp that is not one prints as absent, never as "NaN ago" — the
  // same refusal every other formatter here makes.
  assertEquals(ago(NaN, now), "—");
  assertEquals(ago(now, NaN), "—");
});

Deno.test("clock — zero-padded local time", () => {
  const at = new Date(2026, 0, 2, 4, 5, 6).getTime();
  assertEquals(clock(at), "04:05:06");
  assertEquals(clock(NaN), "--:--:--");
  // A finite number can still be outside representable time: every value past
  // ±8.64e15 makes an Invalid Date, and those printed "NaN:NaN:NaN" — reachable
  // from any timestamp the CLI puts on the wire.
  assertEquals(clock(Number.MAX_SAFE_INTEGER), "--:--:--");
  assertEquals(clock(8.64e15 + 1), "--:--:--");
  assertEquals(clock(-8.64e15 - 1), "--:--:--");
  assertEquals(clock(Infinity), "--:--:--");
});

Deno.test("tailPath — keeps the end, where the file name is", () => {
  // A path that fits is untouched.
  assertEquals(tailPath("/a/b/note.txt", 90), "/a/b/note.txt");
  // …and one that does not keeps its tail, cut at a segment boundary.
  assertEquals(tailPath("/a/b/c/note.txt", 10), "\u2026/note.txt");
  const long = `/tmp/${"deep/".repeat(40)}note.txt`;
  const cut = tailPath(long, 40);
  assertEquals(cut.length <= 40, true);
  assertEquals(cut.endsWith("note.txt"), true);
  assertEquals(cut.startsWith("\u2026"), true);
  // No segment boundary anywhere near the cut: take the characters anyway.
  assertEquals(tailPath("x".repeat(50), 10).length, 10);
});

Deno.test("oneLine — collapses whitespace and caps with an ellipsis", () => {
  assertEquals(oneLine("  a\n\n  b  "), "a b");
  assertEquals(oneLine("abcdef", 4), "abc…");
  assertEquals(oneLine("abcd", 4), "abcd");
});

Deno.test("baseName — trailing slashes and root", () => {
  assertEquals(baseName("/home/dev/code/cc"), "cc");
  assertEquals(baseName("/home/dev/code/cc/"), "cc");
  assertEquals(baseName("/"), "/");
  assertEquals(baseName("cc"), "cc");
});

Deno.test("tildePath — only collapses a real home prefix", () => {
  assertEquals(tildePath("/home/dev/code/cc", "/home/dev"), "~/code/cc");
  assertEquals(tildePath("/opt/app", "/home/dev"), "/opt/app");
  assertEquals(tildePath("/opt/app", null), "/opt/app");
  assertEquals(tildePath("/opt/app", "/"), "/opt/app"); // "/" is not a home
});
