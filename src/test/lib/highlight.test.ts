/**
 * The highlighter's one hard invariant: it may recolour code, never alter it.
 * Everything else is presentation.
 */
import { assertEquals } from "@std/assert";
import { canHighlight, highlight, type Token } from "../../lib/highlight.ts";

const text = (tokens: Token[]) => tokens.map((t) => t.text).join("");
const kinds = (src: string, lang: string) =>
  highlight(src, lang).filter((t) => t.kind !== "plain").map((t) => t.kind);

Deno.test("lossless — the tokens always reassemble the input exactly", () => {
  const samples: [string, string][] = [
    ["const x = 1; // note", "ts"],
    ['{"a": [1, true, null], "b": "x"}', "json"],
    ["#!/bin/bash\nset -e\necho 'hi' # done", "bash"],
    ["/* block */ fn(`tpl ${x}`)", "ts"],
    ["", "ts"],
    ["  \n\t weird ¬ unicode ✓ ", ""],
    ["unterminated 'string", "ts"],
    ["/* unterminated block", "ts"],
    ["0x1f 3.14 1_000", "ts"],
  ];
  for (const [src, lang] of samples) {
    assertEquals(text(highlight(src, lang)), src, `lossless for: ${src}`);
  }
});

Deno.test("typescript — keywords, strings, comments and calls are separated", () => {
  const t = highlight('const greet = () => { return "hi"; } // done', "ts");
  const k = t.filter((x) => x.kind !== "plain");
  assertEquals(k.some((x) => x.kind === "keyword" && x.text === "const"), true);
  assertEquals(
    k.some((x) => x.kind === "keyword" && x.text === "return"),
    true,
  );
  assertEquals(k.some((x) => x.kind === "string" && x.text === '"hi"'), true);
  assertEquals(
    k.some((x) => x.kind === "comment" && x.text === "// done"),
    true,
  );
});

Deno.test("json — keys are properties, values keep their own kinds", () => {
  const t = highlight('{"count": 12, "ok": true}', "json");
  // The token keeps its quotes — losslessness requires it.
  assertEquals(
    t.some((x) => x.kind === "property" && x.text === '"count"'),
    true,
  );
  assertEquals(t.some((x) => x.kind === "string" && x.text === '"ok"'), false);
  assertEquals(t.some((x) => x.kind === "number" && x.text === "12"), true);
  assertEquals(t.some((x) => x.kind === "literal" && x.text === "true"), true);
  // JSON has no keywords — "true" must not be coloured as one.
  assertEquals(t.some((x) => x.kind === "keyword"), false);
});

Deno.test("shell — '#' comments, and '//' is not a comment", () => {
  assertEquals(kinds("echo hi # note", "bash").includes("comment"), true);
  assertEquals(kinds("ls //srv", "bash").includes("comment"), false);
});

Deno.test("an unknown language still highlights, and is declared unknown", () => {
  assertEquals(canHighlight("ts"), true);
  assertEquals(canHighlight(""), true);
  assertEquals(canHighlight("brainfuck"), false);
  // …but it must still not corrupt the source.
  assertEquals(text(highlight("x = 1 # hm", "brainfuck")), "x = 1 # hm");
});

Deno.test("a string containing comment markers stays one string", () => {
  const t = highlight('const s = "// not a comment";', "ts");
  assertEquals(t.some((x) => x.kind === "comment"), false);
  assertEquals(
    t.some((x) => x.kind === "string" && x.text === '"// not a comment"'),
    true,
  );
});

Deno.test("an escaped quote does not end the string", () => {
  const src = 'const s = "a\\"b"; const t = 1;';
  const t = highlight(src, "ts");
  assertEquals(text(t), src);
  assertEquals(
    t.some((x) => x.kind === "string" && x.text === '"a\\"b"'),
    true,
  );
});
