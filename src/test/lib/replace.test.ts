/**
 * The matcher behind `edit`: every reading of the model's `old_string` must
 * find exactly one place, and none may let a guess at a block's middle
 * overwrite what is really there.
 */
import { assert, assertEquals } from "@std/assert";
import {
  nearMiss,
  replaceIn,
  snippet,
  stripLineNumbers,
} from "../../lib/replace.ts";

const ok = (r: ReturnType<typeof replaceIn>) => {
  if (!r.ok) throw new Error(r.error);
  return r;
};

const FILE = [
  "function greet(name) {",
  "    const msg = `hi ${name}`;",
  "    console.log(msg);",
  "    return msg;",
  "}",
  "",
].join("\n");

Deno.test("exact first, and exactly one place", () => {
  const r = ok(replaceIn(FILE, "return msg;", "return msg.trim();"));
  assertEquals(r.strategy, "exact");
  assertEquals(r.line, 4);
  assert(r.content.includes("    return msg.trim();"));
  const two = replaceIn("a\na\n", "a", "b");
  assert(!two.ok && two.error.includes("2 places"));
  // …unless every place is what was asked for.
  assertEquals(ok(replaceIn("a\na\n", "a", "b", true)).content, "b\nb\n");
});

Deno.test("indentation off by a level still lands — re-indented like the file", () => {
  const r = ok(replaceIn(
    FILE,
    "const msg = `hi ${name}`;\nconsole.log(msg);",
    "const msg = `hello ${name}`;\nconsole.info(msg);",
  ));
  assertEquals(r.strategy, "indentation");
  assert(
    r.content.includes(
      "    const msg = `hello ${name}`;\n    console.info(msg);",
    ),
    r.content,
  );
});

Deno.test("trailing spaces, quotes and escapes are forgiven", () => {
  const spaced = "let a = 1;   \nlet b = 2;\n";
  assertEquals(
    ok(replaceIn(spaced, "let a = 1;\nlet b = 2;\n", "let c = 3;\n")).content,
    "let c = 3;\n",
  );
  const quoted = 'say("hi");\n';
  assertEquals(
    ok(replaceIn(quoted, "say(“hi”);", 'say("bye");')).content,
    'say("bye");\n',
  );
  // Double-escaped by the model: `\n` where a newline belongs, in both halves.
  const escaped = ok(replaceIn("a();\nb();\n", "a();\\nb();", "c();\\nd();"));
  assertEquals(escaped.content, "c();\nd();\n");
});

Deno.test("line numbers pasted from a read are stripped", () => {
  assertEquals(stripLineNumbers("12\tfoo\n13\tbar"), "foo\nbar");
  // One numbered-looking line in real code is left alone.
  assertEquals(stripLineNumbers("1: x\nplain"), "1: x\nplain");
  const r = ok(replaceIn(FILE, "4\t    return msg;", "4\t    return null;"));
  assert(r.content.includes("    return null;"));
});

Deno.test("a CRLF file stays CRLF", () => {
  const win = "one\r\ntwo\r\nthree\r\n";
  assertEquals(
    ok(replaceIn(win, "two\nthree", "2\n3")).content,
    "one\r\n2\r\n3\r\n",
  );
});

Deno.test("no similarity guessing: a wrong middle is not a match", () => {
  const r = replaceIn(
    FILE,
    "function greet(name) {\n    const msg = 'something else';\n    return msg;\n}",
    "function greet() {}",
  );
  assert(!r.ok && r.error.includes("not found"), r.ok ? "matched" : r.error);
  assert(!replaceIn(FILE, "", "x").ok, "empty old_string");
  assert(!replaceIn(FILE, "return msg;", "return msg;").ok, "no-op");
});

Deno.test("a line-based match does not leave a blank line behind", () => {
  // …and the file's indentation is kept.
  const r = ok(replaceIn("a\n  b  \nc\n", "b\n", "B\n"));
  assertEquals(r.content, "a\n  B\nc\n");
});

Deno.test("snippet shows the changed lines, numbered, with context", () => {
  const s = snippet("a\nb\nc\nd\ne\nf\n", 3, 1);
  assertEquals(s, "1\ta\n2\tb\n3\tc\n4\td\n5\te");
});

Deno.test("a miss says where it came closest, so no re-read is needed", () => {
  // A live session copied six right lines and one line from a sibling method
  // it had just written, and re-read 257 lines to find the difference.
  const file = [
    "    formatRemaining(s) {",
    "      const total = Math.round(s.remaining / 1000);",
    "      const mins = Math.floor(total / 60);",
    "      const mm = mins % 60;",
    "      return `${mm}`;",
    "    },",
  ].join("\n");
  const old = [
    "      const total = Math.round(s.remaining / 1000);",
    "      const mins = Math.floor(total / 60);",
    "      const hh = Math.floor(mins / 60);",
    "      const mm = mins % 60;",
  ].join("\n");
  const r = replaceIn(file, old, "x");
  assert(!r.ok);
  if (r.ok) return;
  assert(r.error.includes("first 2 lines match the file at line 2"), r.error);
  assert(r.error.includes("`const hh = Math.floor(mins / 60);`"), r.error);
  assert(r.error.includes("`const mm = mins % 60;`"), r.error);
  // Nothing to anchor on: nothing invented.
  assertEquals(nearMiss(file, "no such line\nat all"), "");
});

Deno.test("line endings are kept per line, not decided for the whole file", () => {
  // One CRLF line in a Unix file used to turn every line into CRLF.
  const mixed = "a\nb\r\nc\nd\n";
  const r = replaceIn(mixed, "c\n", "C1\nC2\n");
  assert(r.ok);
  assertEquals(r.content, "a\nb\r\nC1\nC2\nd\n");

  // An edit on a CRLF line writes CRLF, and leaves the LF lines alone.
  const r2 = replaceIn(mixed, "b\n", "B1\nB2\n");
  assert(r2.ok);
  assertEquals(r2.content, "a\nB1\r\nB2\r\nc\nd\n");

  // A whole-CRLF file stays whole-CRLF.
  const r3 = replaceIn("x\r\ny\r\nz", "y", "Y1\nY2");
  assert(r3.ok);
  assertEquals(r3.content, "x\r\nY1\r\nY2\r\nz");
});
