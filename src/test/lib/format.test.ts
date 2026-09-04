import { assertEquals } from "@std/assert";
import { REDACTED_ACTIONS } from "../../cell/redact.ts";
import {
  ago,
  baseName,
  bytes,
  clock,
  dayLabel,
  differentDay,
  duration,
  listKey,
  modelLabel,
  oneLine,
  pct,
  perSecond,
  stateShape,
  tailPath,
  tildePath,
  tokens,
  until,
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

Deno.test("rounding never invents a unit it did not advance to", () => {
  // 1 048 575 bytes is 1023.999 KB, and one decimal makes that `1024 KB` — a
  // size that does not exist. The same carry applies at every boundary.
  assertEquals(bytes(1024 * 1024 - 1), "1.0 MB");
  assertEquals(bytes(1024 * 1024 * 1024 - 1), "1.0 GB");
  assertEquals(bytes(1023.5), "1.0 KB");
  assertEquals(tokens(999_999), "1.00M");
  assertEquals(tokens(999.5), "1.0k");
  // …and the ordinary cases are unchanged.
  assertEquals(bytes(812), "812 B");
  assertEquals(bytes(12_698), "12.4 KB");
  assertEquals(tokens(842), "842");
  assertEquals(tokens(12_400), "12k");
});

Deno.test("tildePath — the home prefix must end on a segment boundary", () => {
  // `/home/dev-tools` is not under `/home/dev`, and a raw prefix test rendered
  // it as `~-tools` — a path that does not exist, shown as though it did.
  assertEquals(
    tildePath("/home/dev-tools/proj", "/home/dev"),
    "/home/dev-tools/proj",
  );
  assertEquals(
    tildePath("/Users/alice/code", "/Users/al"),
    "/Users/alice/code",
  );
  assertEquals(tildePath("/home/dev/code", "/home/dev"), "~/code");
  assertEquals(tildePath("/home/dev", "/home/dev"), "~");
  assertEquals(tildePath("/home/dev/code", "/home/dev/"), "~/code");
  assertEquals(tildePath("/srv/app", "/home/dev"), "/srv/app");
  assertEquals(tildePath("/srv/app", null), "/srv/app");
});

Deno.test("truncation cuts on a character, never inside one", () => {
  // Slicing by UTF-16 unit lands between the halves of a surrogate pair, and a
  // lone surrogate is the `�` a reader actually sees.
  const lone = (s: string) =>
    Array.from(s).some((ch) => {
      const c = ch.codePointAt(0) ?? 0;
      return c >= 0xd800 && c <= 0xdfff;
    });
  const emoji = "😀".repeat(20);
  assertEquals(lone(oneLine(emoji, 10)), false);
  assertEquals(Array.from(oneLine(emoji, 10)).length <= 10, true);
  assertEquals(lone(tailPath(`/x/${emoji}/end.txt`, 30)), false);
  assertEquals(tailPath(`/x/${emoji}/end.txt`, 30).endsWith("/end.txt"), true);
  // The cap is a cap even when it leaves no room for the ellipsis.
  assertEquals(oneLine("abc", 0), "");
  assertEquals(oneLine("abc", 1), "…");
});

Deno.test("baseName — a path of nothing but separators is the root", () => {
  assertEquals(baseName("/"), "/");
  assertEquals(baseName("//"), "/");
  assertEquals(baseName("///"), "/");
  assertEquals(baseName("/a/b"), "b");
  assertEquals(baseName("/a/b/"), "b");
});

Deno.test("until — a future moment, which `ago` cannot express", () => {
  const now = 1_000_000_000;
  assertEquals(until(now + 40_000, now), "in 40s");
  assertEquals(until(now + 12 * 60_000, now), "in 12m");
  assertEquals(until(now + 4 * 3_600_000, now), "in 4h");
  assertEquals(until(now + 2 * 86_400_000, now), "in 2d");
  // Past, or not a time at all.
  assertEquals(until(now - 1, now), "now");
  assertEquals(until(0, now), "—");
  assertEquals(until(NaN, now), "—");
});

Deno.test("stateShape logs sizes, never content", () => {
  const shape = stateShape({
    messages: [{ text: "a private transcript line" }],
    config: { a: 1, b: 2 },
    count: 7,
  });
  assertEquals(shape, { messages: 1, config: 2, count: 1 });
  assertEquals(JSON.stringify(shape).includes("private"), false);
  assertEquals(stateShape(null), {});
  assertEquals(stateShape("nope"), {});
});

Deno.test("the redaction list covers every content-bearing cell, by prefix", () => {
  // session/local (transcripts), jobs (other sessions' prompts + output),
  // tree (file preview contents) — everything that can hold user or model
  // text. Metadata-only cells (catalog, storage, workspace) are deliberately
  // absent. Prefix form so a new method cannot silently leak.
  for (const cell of ["session", "local", "jobs", "tree"]) {
    assertEquals(REDACTED_ACTIONS.includes(`${cell}:*`), true, cell);
  }
  assertEquals(REDACTED_ACTIONS.every((p) => p.endsWith(":*")), true);
});

Deno.test("listKey removes every character the semantic surface parses", () => {
  // `Parent/Component[key]:Element` — so `/`, `[`, `]` and `:` all have to go,
  // or the address cannot be parsed back to the row it names.
  assertEquals(listKey("/home/dev/x"), "·home·dev·x");
  assertEquals(listKey("db:main"), "db·main");
  assertEquals(listKey("a[0]"), "a·0·");
  assertEquals(listKey("plain-name"), "plain-name");
  // Identity survives: two different rows stay two different keys.
  assertEquals(listKey("/a/b") === listKey("/a/c"), false);
});

Deno.test("modelLabel — a GGUF path is a name, not eighty characters of directory", () => {
  assertEquals(
    modelLabel(
      "/home/dev/.lmstudio/models/unsloth/Qwen3.8-Flash-Next-GGUF/Qwen3.8-Flash-Next-UD-Q4_K_XL-00001-of-00004.gguf",
    ),
    "Qwen3.8-Flash-Next-UD-Q4_K_XL",
  );
  assertEquals(modelLabel("/models/llama-3-8b.gguf"), "llama-3-8b");
  // Ollama and LM Studio already answer with names — untouched, or the label
  // would differ from every other place the model is written down.
  assertEquals(modelLabel("qwen3:8b"), "qwen3:8b");
  assertEquals(
    modelLabel("unsloth/deepseek-v4-flash-0731"),
    "unsloth/deepseek-v4-flash-0731",
  );
  assertEquals(modelLabel(""), "");
  // Never shortens to nothing.
  assertEquals(modelLabel("/a/.gguf"), "/a/.gguf");
});

Deno.test("a day is named the way a person would say it", () => {
  const now = new Date(2026, 1, 14, 12, 0).getTime();
  const at = (days: number, h = 12) =>
    new Date(2026, 1, 14 - days, h).getTime();

  assertEquals(dayLabel(at(0), now), "Today");
  assertEquals(dayLabel(at(1), now), "Yesterday");
  // Just after midnight is still yesterday, not "22 hours ago".
  assertEquals(dayLabel(at(1, 23), now), "Yesterday");
  // Inside the week, the weekday says more than the date.
  assertEquals(dayLabel(at(3), now), "Wednesday");
  // Past it, the date.
  assertEquals(dayLabel(at(20), now).includes("Jan"), true);
});

Deno.test("two times on the same day are the same day", () => {
  const morning = new Date(2026, 1, 14, 1, 0).getTime();
  const night = new Date(2026, 1, 14, 23, 59).getTime();
  const nextDay = new Date(2026, 1, 15, 0, 1).getTime();
  assertEquals(differentDay(morning, night), false);
  // …and one minute later is not, even though it is two minutes away.
  assertEquals(differentDay(night, nextDay), true);
});

Deno.test("a rate needs a real numerator and a real denominator", () => {
  assertEquals(perSecond(0, 4000), null);
  assertEquals(perSecond(200, 0), null);
  assertEquals(perSecond(200, 100), null, "too short to be a measurement");
  assertEquals(perSecond(200, 4000), 50);
});
