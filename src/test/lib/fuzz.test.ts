/**
 * Randomized invariant fuzz over the pure libs.
 *
 * Every module here states a contract in its own docblock — the markdown parser
 * never throws and never silently drops text, the highlighter reproduces its
 * input exactly, the formatters are total. Those promises are what makes it safe
 * to render model output directly, and they are checked here against input
 * nobody wrote by hand: this is where `clock(MAX_SAFE_INTEGER)` was caught
 * printing `NaN:NaN:NaN`.
 *
 * Deterministic by default — the seed is fixed, so a failure reproduces — and
 * `FUZZ_SEED=n deno test` walks a different path when hunting for more.
 */
import { assert, assertEquals } from "@std/assert";
import {
  type Block,
  type Inline,
  parseInline,
  parseMarkdown,
  safeHref,
} from "../../lib/markdown.ts";
import { highlight } from "../../lib/highlight.ts";
import {
  ago,
  bytes,
  clock,
  duration,
  oneLine,
  tailPath,
  tokens,
  usd,
} from "../../lib/format.ts";
import {
  agentResultOf,
  blocksOf,
  contextWindowOf,
  permissionOf,
  resultText,
  toolDetail,
  toolTitle,
  usageOf,
} from "../../lib/stream.ts";

const ITERATIONS = 2_000;

let seed = Number(Deno.env.get("FUZZ_SEED") ?? 987_654_321);
const rnd = () =>
  (seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648) / 2_147_483_648;
const pick = <T>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)];
const int = (n: number) => Math.floor(rnd() * n);

/** Fragments chosen to collide with every branch of the markdown grammar. */
const FRAGS = [
  "#",
  "##",
  "###### ",
  "# heading",
  "```",
  "```ts",
  "```json",
  "~~~",
  "- item",
  "* item",
  "+ item",
  "1. item",
  "12) item",
  "> quote",
  ">",
  "---",
  "***",
  "___",
  "- - -",
  "**bold**",
  "**unclosed",
  "*em*",
  "_em_",
  "__both__",
  "****",
  "`code`",
  "`unclosed",
  "``",
  "[label](https://x.y)",
  "[label](javascript:alert(1))",
  "[label](",
  "[label]()",
  "[a](b",
  "\\*escaped\\*",
  "\\",
  "text",
  "  indented",
  "\t",
  "",
  " ",
  "a*b_c`d[e](f)g",
  "😀 unicode ✓",
  "<script>alert(1)</script>",
  "|table|cell|",
  "1.",
  "-",
  "*",
];

/** …and the shapes a highlighter trips over: unterminated everything. */
const CODE = [
  "const x = 1;",
  '"key": "value",',
  "# comment",
  "// comment",
  "/* block",
  "*/",
  "`template ${x}`",
  "'unterminated",
  '"esc \\" inside"',
  "0x1f 1e10 .5 1_000",
  "fn(a, b)",
  "obj.prop",
  "if (true) {}",
  "\\",
  "",
  "\n",
  "😀",
  "a".repeat(50),
];

const lines = (xs: string[], max: number) =>
  Array.from({ length: 1 + int(max) }, () => pick(xs)).join("\n");

/** Every inline node's text, concatenated — nothing may vanish on the way. */
const inlineText = (xs: Inline[]): string =>
  xs.map((x) => x.t === "text" || x.t === "code" ? x.v : inlineText(x.v)).join(
    "",
  );

const blockText = (b: Block): string => {
  switch (b.t) {
    case "pre":
      return b.v;
    case "hr":
      return "";
    case "list":
      return b.items.map(inlineText).join("");
    default:
      return inlineText(b.v);
  }
};

/** The source with its own syntax removed — what the tree still has to carry. */
const visible = (src: string): string =>
  src
    // An unsafe href is deliberately dropped ("keep the words, drop the link"),
    // so what sits between `](` and `)` is not promised to survive.
    .replace(/\]\([^)]*\)?/g, "]")
    .replace(/```[^\n]*/g, "")
    // A rule carries no text at all — and it has to go before the list marker
    // below, which would otherwise eat the first dash of "- - -".
    .replace(/^\s*([-*_])(\s*\1){2,}\s*$/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*\d+[.)]\s+/gm, "")
    .replace(/^\s*#{1,6}\s+/gm, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/[*_`\\[\]()]/g, "")
    .replace(/\s+/g, "");

Deno.test("markdown parses anything, and keeps every visible character", () => {
  for (let i = 0; i < ITERATIONS; i++) {
    const src = lines(FRAGS, 12);
    const blocks = parseMarkdown(src);
    for (const b of blocks) {
      if (b.t === "h") assert(b.level >= 1 && b.level <= 6, `level ${b.level}`);
      if (b.t === "list") assert(Array.isArray(b.items));
    }
    const kept = blocks.map(blockText).join("").replace(/\s+/g, "");
    for (const ch of new Set(visible(src))) {
      assert(
        kept.includes(ch),
        `lost ${JSON.stringify(ch)} from ${JSON.stringify(src)}`,
      );
    }
  }
});

Deno.test("no href outside the allow-list ever becomes a link", () => {
  // Including the ones that only look unsafe after control characters are
  // stripped — `java\nscript:` is a real bypass against a naive prefix test.
  for (
    const href of [
      "javascript:alert(1)",
      "JavaScript:alert(1)",
      "java\nscript:alert(1)",
      "java\tscript:alert(1)",
      " javascript:alert(1)",
      "data:text/html,<script>",
      "vbscript:x",
      "file:///etc/passwd",
    ]
  ) {
    assertEquals(safeHref(href), null, href);
    for (const node of parseInline(`[click](${href})`)) {
      assert(node.t !== "link", `${href} became a link`);
    }
  }
  for (
    const href of ["https://a.b", "http://a.b", "mailto:a@b.c", "#x", "/x"]
  ) {
    assert(safeHref(href) !== null, href);
  }
});

Deno.test("highlighting never loses a character", () => {
  for (let i = 0; i < ITERATIONS; i++) {
    const src = lines(CODE, 8);
    const lang = pick(["", "ts", "json", "bash", "python", "nope", "JSON"]);
    const out = highlight(src, lang);
    assertEquals(out.map((t) => t.text).join(""), src, `at ${lang}`);
    for (const t of out) assert(t.text.length > 0, "empty token");
  }
});

Deno.test("every formatter is total", () => {
  const NUMS = [
    0,
    -0,
    1,
    -1,
    0.5,
    999,
    1_024,
    1e6,
    1e12,
    -1e12,
    NaN,
    Infinity,
    -Infinity,
    Number.MAX_SAFE_INTEGER,
    8.64e15 + 1, // one millisecond past representable time
    1e-9,
  ];
  for (const n of NUMS) {
    for (const f of [bytes, tokens, duration, usd]) {
      const out = f(n);
      assert(
        !/NaN|Infinity|undefined/.test(out),
        `${f.name}(${n}) = ${out}`,
      );
    }
    assert(!/NaN/.test(clock(n)), `clock(${n}) = ${clock(n)}`);
    assert(!/NaN/.test(ago(n, 0)), `ago(${n}) = ${ago(n, 0)}`);
  }
  for (let i = 0; i < ITERATIONS; i++) {
    const max = 1 + int(40);
    const s = Array.from(
      { length: int(120) },
      () => pick(["a", " ", "\n", "\t", "😀", "…", "/"]),
    ).join("");
    // The cap is a cap, whichever end the text is kept from.
    assert(oneLine(s, max).length <= max, `oneLine ${max}`);
    assert(tailPath(s, max).length <= max, `tailPath ${max}`);
    assert(!/\n/.test(`${oneLine(s, max)}${tailPath(s, max)}`), "newline leak");
  }
});

Deno.test("the protocol readers are total over hostile payloads", () => {
  const WEIRD = [
    null,
    undefined,
    0,
    -1,
    "",
    "x".repeat(500),
    [],
    {},
    true,
    { nested: { deep: [1, 2, 3] } },
  ];
  for (let i = 0; i < ITERATIONS; i++) {
    const evt: Record<string, unknown> = {
      type: pick(["assistant", "user", "result", "control_request", "?"]),
      message: pick([
        { content: pick([[{ type: "text", text: pick(WEIRD) }], null, "s"]) },
        ...WEIRD,
      ]),
      usage: pick([
        { input_tokens: pick(WEIRD), output_tokens: pick(WEIRD) },
        ...WEIRD,
      ]),
      modelUsage: pick([{ m: { contextWindow: pick(WEIRD) } }, ...WEIRD]),
      request: pick([
        {
          subtype: "can_use_tool",
          tool_name: pick(WEIRD),
          input: pick(WEIRD),
          permission_suggestions: pick([[{ type: "addRules" }], ...WEIRD]),
        },
        ...WEIRD,
      ]),
      request_id: pick(WEIRD),
      content: pick(WEIRD),
    };
    blocksOf(evt.message);
    usageOf(evt.usage, 200_000);
    contextWindowOf(evt, 200_000);
    permissionOf(evt);
    resultText(evt.content);
    agentResultOf(pick(["", "agent launched successfully", "x".repeat(300)]));

    // The two readers with a length promise: a title and a detail line are
    // rendered into a fixed row, so neither may run past its cap.
    const input = pick([
      { command: pick(WEIRD), file_path: pick(WEIRD) },
      { a: pick(WEIRD), path: pick(WEIRD) },
      {},
    ]) as Record<string, unknown>;
    assert(toolTitle(pick(["Bash", "", "Task"]), input).length <= 90);
    assert(toolDetail("Bash", input).length <= 140);
  }
});
