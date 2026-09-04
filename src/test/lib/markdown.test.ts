/**
 * The Markdown parser, tested on the shapes a coding agent actually produces.
 *
 * Two of these are security tests and the rest are "the text the model wrote is
 * the text the reader sees" — which for a transcript viewer is the whole job.
 */
import { assertEquals } from "@std/assert";
import {
  type Block,
  type Inline,
  parseInline,
  parseMarkdown,
  safeHref,
} from "../../lib/markdown.ts";

const kinds = (src: string): string[] => parseMarkdown(src).map((b) => b.t);
const items = (b: Block): unknown => (b as { items?: unknown }).items;

Deno.test("safeHref — only schemes that cannot execute or leave the origin", () => {
  assertEquals(safeHref("https://example.com/a"), "https://example.com/a");
  assertEquals(safeHref("http://example.com"), "http://example.com");
  assertEquals(safeHref("mailto:a@b.c"), "mailto:a@b.c");
  assertEquals(safeHref("#anchor"), "#anchor");
  assertEquals(safeHref("/local/path"), "/local/path");
  assertEquals(safeHref("./rel"), "./rel");

  assertEquals(safeHref("javascript:alert(1)"), null);
  assertEquals(safeHref("data:text/html,<script>"), null);
  // Control characters are stripped before the test, so the classic split
  // bypass cannot smuggle a scheme past a naive prefix check.
  assertEquals(safeHref("java\nscript:alert(1)"), null);
  assertEquals(safeHref("  javascript:alert(1)"), null);
  assertEquals(safeHref(""), null);

  // Protocol-relative: these *look* like same-origin paths and are not — a
  // browser resolves both against the current scheme and lands on evil.com.
  assertEquals(safeHref("//evil.com/x"), null);
  assertEquals(safeHref("/\\evil.com"), null);
});

Deno.test("a thematic break ends a list instead of becoming a bullet", () => {
  // `* * *` matches the bullet pattern too, and the list's continuation loop
  // used to test only for bullets — so the rule was eaten as an empty item and
  // its characters disappeared from the document.
  assertEquals(kinds("- a\n* * *\n- b"), ["list", "hr", "list"]);
  assertEquals(items(parseMarkdown("- a\n* * *\n- b")[0]), [[{
    t: "text",
    v: "a",
  }]]);
  assertEquals(items(parseMarkdown("- a\n* * *\n- b")[2]), [[{
    t: "text",
    v: "b",
  }]]);
  assertEquals(kinds("- a\n- - -\n- b"), ["list", "hr", "list"]);
  // …and an ordinary list is still exactly one list.
  assertEquals(kinds("- a\n- b\n- c"), ["list"]);
  assertEquals(kinds("1. a\n2. b"), ["list"]);
});

Deno.test("emphasis — `_` never opens inside a word", () => {
  // Identifiers are most of what this parser renders; `snake_case_name` coming
  // out as snake + italic + name was the commonest wrong render in the app.
  assertEquals(parseInline("snake_case_word"), [{
    t: "text",
    v: "snake_case_word",
  }]);
  assertEquals(parseInline("a_b_c"), [{ t: "text", v: "a_b_c" }]);
  // Standalone underscores still mean emphasis.
  assertEquals(parseInline("_yes_"), [{
    t: "em",
    v: [{ t: "text", v: "yes" }],
  }]);
  // `*` keeps its intra-word behaviour, as CommonMark says.
  assertEquals(parseInline("a*b*c"), [
    { t: "text", v: "a" },
    { t: "em", v: [{ t: "text", v: "b" }] },
    { t: "text", v: "c" },
  ]);
});

Deno.test("code spans close on a run of the same length", () => {
  assertEquals(parseInline("`x`"), [{ t: "code", v: "x" }]);
  // The standard way to quote code containing a backtick.
  assertEquals(parseInline("``code``"), [{ t: "code", v: "code" }]);
  assertEquals(parseInline("``a ` b``"), [{ t: "code", v: "a ` b" }]);
  // An unclosed run stays literal rather than swallowing the rest of the line.
  assertEquals(parseInline("`unclosed"), [{ t: "text", v: "`unclosed" }]);
});

Deno.test("link targets count nested parentheses", () => {
  assertEquals(parseInline("[x](https://a.b/c)"), [{
    t: "link",
    href: "https://a.b/c",
    v: [{ t: "text", v: "x" }],
  }]);
  // Truncating at the first `)` left a broken href and a stray `)` in the prose.
  assertEquals(parseInline("[x](https://a.b/c(1))"), [{
    t: "link",
    href: "https://a.b/c(1)",
    v: [{ t: "text", v: "x" }],
  }]);
  // An unsafe scheme keeps the words and drops the link.
  assertEquals(parseInline("[x](javascript:alert(1))"), [{
    t: "text",
    v: "x",
  }]);
});

Deno.test("parseMarkdown — the ordinary shapes still parse", () => {
  assertEquals(kinds("# h\n\npara\n\n```ts\ncode\n```\n\n> q\n\n---"), [
    "h",
    "p",
    "pre",
    "quote",
    "hr",
  ]);
  // An unclosed fence still renders, rather than eating the document.
  assertEquals(kinds("```ts\ncode"), ["pre"]);
  assertEquals(parseMarkdown(""), []);
});

Deno.test("pipe tables — the shape an agent reaches for constantly", () => {
  const src = "| a | b |\n| --- | ---: |\n| 1 | 2 |\n| 3 | 4 |";
  const [table] = parseMarkdown(src);
  assertEquals(table.t, "table");
  const t = table as Extract<Block, { t: "table" }>;
  assertEquals(t.head, [[{ t: "text", v: "a" }], [{ t: "text", v: "b" }]]);
  assertEquals(t.rows.length, 2);
  assertEquals(t.rows[1], [[{ t: "text", v: "3" }], [{ t: "text", v: "4" }]]);
  // Alignment comes from the rule row's colons.
  assertEquals(t.align, ["left", "right"]);
  assertEquals(
    (parseMarkdown("| a | b |\n| :-: | :-- |\n| 1 | 2 |")[0] as typeof t).align,
    ["center", "left"],
  );

  // Cells carry inline markup, and an escaped pipe is content — which is how a
  // table holds the shell pipeline an agent just ran.
  const rich = parseMarkdown(
    "| cmd | note |\n| --- | --- |\n| `ls \\| wc` | **many** |",
  )[0] as typeof t;
  assertEquals(rich.rows[0][0], [{ t: "code", v: "ls | wc" }]);
  assertEquals(rich.rows[0][1], [{
    t: "strong",
    v: [{ t: "text", v: "many" }],
  }]);

  // Outer pipes are optional, and the table ends at a blank line.
  assertEquals(parseMarkdown("a | b\n--- | ---\n1 | 2").map((b) => b.t), [
    "table",
  ]);
  assertEquals(
    parseMarkdown("| a |\n| --- |\n| 1 |\n\nafter").map((b) => b.t),
    ["table", "p"],
  );
  // A lone pipe in prose is still prose.
  assertEquals(parseMarkdown("a | b").map((b) => b.t), ["p"]);
});

Deno.test("a bare URL in prose becomes a link", () => {
  // The complaint this answers: an agent prints an address and the one thing
  // anyone wants to do with it — open it — needed a select-and-copy.
  const [p] = parseMarkdown("see https://status.claude.com for updates");
  assertEquals(p.t, "p");
  const link = (p as { v: Inline[] }).v.find((n) => n.t === "link");
  assertEquals(link?.t === "link" && link.href, "https://status.claude.com");

  // Trailing punctuation is the sentence's, not the address's.
  const [q] = parseMarkdown("docs at https://example.dev/a.");
  const l2 = (q as { v: Inline[] }).v.find((n) => n.t === "link");
  assertEquals(l2?.t === "link" && l2.href, "https://example.dev/a");

  // …but a bracket the URL opened is part of it.
  const [w] = parseMarkdown("https://en.wikipedia.org/wiki/Foo_(bar) is it");
  const l3 = (w as { v: Inline[] }).v.find((n) => n.t === "link");
  assertEquals(
    l3?.t === "link" && l3.href,
    "https://en.wikipedia.org/wiki/Foo_(bar)",
  );

  // Wrapped in prose parentheses, the closer is prose.
  const [b] = parseMarkdown("(see https://example.dev/x) ok");
  const l4 = (b as { v: Inline[] }).v.find((n) => n.t === "link");
  assertEquals(l4?.t === "link" && l4.href, "https://example.dev/x");

  // A scheme-less host still links, over https — never a silent downgrade.
  const [c] = parseMarkdown("try www.example.dev now");
  const l5 = (c as { v: Inline[] }).v.find((n) => n.t === "link");
  assertEquals(l5?.t === "link" && l5.href, "https://www.example.dev");
});

Deno.test("autolinking never touches code, labels or half-addresses", () => {
  // Code is code: a URL in a sample must stay quotable text.
  const [p] = parseMarkdown("run `curl https://example.dev/x` first");
  const inCode = (p as { v: Inline[] }).v.some((n) => n.t === "link");
  assertEquals(inCode, false);

  const [f] = parseMarkdown("```\nhttps://example.dev\n```");
  assertEquals(f.t, "pre");

  // A written link keeps exactly one <a>: an autolinked label would nest one
  // anchor inside another, which no browser renders sanely.
  const [m] = parseMarkdown("[https://example.dev](https://example.dev)");
  const outer = (m as { v: Inline[] }).v[0];
  assertEquals(outer.t, "link");
  assertEquals(
    outer.t === "link" && outer.v.every((n) => n.t === "text"),
    true,
  );

  // Not an address, and not a typo turned into one.
  for (const text of ["https:// nothing", "shttps://example.dev", "http://x"]) {
    const [q] = parseMarkdown(text);
    assertEquals(
      (q as { v: Inline[] }).v.some((n) => n.t === "link"),
      false,
      text,
    );
  }
});
