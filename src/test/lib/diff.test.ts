/**
 * The line diff behind the edit view.
 *
 * What matters here is that it never lies about a change and never hangs. The
 * table is O(lines²), which is right for an Edit — whose `old_string` is a
 * handful of lines by construction — and would be wrong for a whole file, so
 * the bound is part of the contract rather than an implementation detail.
 */
import { assert, assertEquals } from "@std/assert";
import {
  collapse,
  diffLines,
  diffStat,
  MAX_DIFF_LINES,
} from "../../lib/diff.ts";

Deno.test("a changed line reads as one gone and one arrived", () => {
  const d = diffLines("a\nb\nc", "a\nB\nc");
  assert(d !== null);
  assertEquals(d.map((l) => l.kind), ["same", "del", "add", "same"]);
  assertEquals(d[1].text, "b");
  assertEquals(d[2].text, "B");
  assertEquals(diffStat(d), { added: 1, removed: 1 });
});

Deno.test("identical text produces no changes at all", () => {
  const d = diffLines("one\ntwo", "one\ntwo");
  assert(d !== null);
  assertEquals(diffStat(d), { added: 0, removed: 0 });
});

Deno.test("a trailing newline is not a changed line", () => {
  // A file that ends in a newline would otherwise always show a phantom empty
  // last line, on every edit, for every file.
  const d = diffLines("a\nb\n", "a\nb\n");
  assert(d !== null);
  assertEquals(diffStat(d), { added: 0, removed: 0 });
});

Deno.test("insertions and deletions at the ends are found", () => {
  const added = diffLines("b", "a\nb\nc");
  assert(added !== null);
  assertEquals(diffStat(added), { added: 2, removed: 0 });

  const removed = diffLines("a\nb\nc", "b");
  assert(removed !== null);
  assertEquals(diffStat(removed), { added: 0, removed: 2 });
});

Deno.test("something too big to diff answers nothing, not nonsense", () => {
  const huge = Array.from({ length: MAX_DIFF_LINES + 1 }, (_, n) => `l${n}`)
    .join("\n");
  assertEquals(diffLines(huge, huge + "\nmore"), null);
  assertEquals(diffLines("a", huge), null);
});

Deno.test("collapse keeps context and counts what it hid", () => {
  const before = Array.from({ length: 30 }, (_, n) => `line ${n}`).join("\n");
  const after = before.replace("line 15", "LINE 15");
  const d = diffLines(before, after);
  assert(d !== null);

  const shown = collapse(d, 2);
  // Three lines either side of the change, plus the two changed ones, plus
  // one marker at each end for what was dropped.
  assertEquals(shown.filter((l) => l.kind === "gap").length, 2);
  assert(shown.length < d.length, "it actually collapsed something");
  const gap = shown.find((l) => l.kind === "gap");
  assert(gap && /\d+ unchanged lines/.test(gap.text), gap?.text);
  // Nothing that changed is ever hidden.
  assertEquals(
    shown.filter((l) => l.kind === "add" || l.kind === "del").length,
    2,
  );
});
