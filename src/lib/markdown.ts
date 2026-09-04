/**
 * @module
 * A small, safe Markdown parser for the subset a coding agent actually writes:
 * headings, paragraphs, fenced code, lists, blockquotes, rules, and inline
 * bold / italic / code / links.
 *
 * It produces an AST, never an HTML string — the renderer turns it into AIR
 * nodes, so text is escaped by construction and there is no raw-HTML path to
 * abuse. Link schemes are checked here, at the only place they enter.
 */

export type Inline =
  | { t: "text"; v: string }
  | { t: "code"; v: string }
  | { t: "strong"; v: Inline[] }
  | { t: "em"; v: Inline[] }
  | { t: "del"; v: Inline[] }
  | { t: "link"; href: string; v: Inline[] };

/** Column alignment, from the `---:` / `:---:` markers in a table's rule row. */
export type Align = "left" | "center" | "right";

export type Block =
  | { t: "p"; v: Inline[] }
  | { t: "h"; level: number; v: Inline[] }
  | { t: "pre"; lang: string; v: string }
  | {
    t: "list";
    ordered: boolean;
    items: Inline[][];
    /**
     * Per item: `true` for `- [x]`, `false` for `- [ ]`, `null` for a plain
     * bullet. A parallel array rather than a richer item type, so every
     * existing reader of `items` keeps working unchanged.
     *
     * Worth having because a checklist is how an agent reports a plan, and
     * rendering `[x]` as two brackets and an x throws away the one thing the
     * reader is scanning for: which of these is done.
     */
    checks: (boolean | null)[];
  }
  | { t: "quote"; v: Inline[] }
  | { t: "table"; head: Inline[][]; rows: Inline[][][]; align: Align[] }
  | { t: "hr" };

/**
 * Schemes a link may use. Anything else (`javascript:`, `data:`, …) loses its
 * href and renders as plain text — a dropped link beats an executable one.
 *
 * The bare `/` branch is deliberately `\/(?![/\\])`: `//evil.com/x` and
 * `/\evil.com` *look* like same-origin paths and are not — a browser resolves
 * both to `https://evil.com/`. Model output that renders as a local-looking
 * link and navigates off-site is exactly the shape this allow-list exists to
 * stop, so the two-separator forms are excluded.
 */
const SAFE_SCHEME = /^(https?:|mailto:|#|\/(?![/\\])|\.\/|\.\.\/)/i;

const H = /^(#{1,6})\s+(.*)$/;
const UL = /^\s*[-*+]\s+(.*)$/;
const OL = /^\s*\d+[.)]\s+(.*)$/;
const HR = /^\s*([-*_])(\s*\1){2,}\s*$/;
const QUOTE = /^\s*>\s?(.*)$/;
const FENCE = /^\s*```(.*)$/;
/** A table row is any line with a `|` that is not a fence or a rule. */
const ROW = /\|/;
/** The rule row under the header: `| --- | :---: | ---: |`. */
const RULE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

/** Parse a Markdown document into blocks. Never throws: anything unrecognised
 *  survives as a paragraph, which is the honest fallback for agent output. */
export function parseMarkdown(src: string): Block[] {
  const lines = String(src ?? "").replace(/\r\n?/g, "\n").split("\n");
  const out: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim() === "") {
      i++;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence) {
      const lang = fence[1].trim();
      const body: string[] = [];
      i++;
      while (i < lines.length && !FENCE.test(lines[i])) body.push(lines[i++]);
      i++; // closing fence (or end of input — an unclosed fence still renders)
      out.push({ t: "pre", lang, v: body.join("\n") });
      continue;
    }

    if (HR.test(line)) {
      out.push({ t: "hr" });
      i++;
      continue;
    }

    const heading = H.exec(line);
    if (heading) {
      out.push({
        t: "h",
        level: heading[1].length,
        v: parseInline(heading[2]),
      });
      i++;
      continue;
    }

    if (QUOTE.test(line)) {
      const body: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i])) {
        body.push(QUOTE.exec(lines[i++])![1]);
      }
      out.push({ t: "quote", v: parseInline(body.join(" ")) });
      continue;
    }

    if (UL.test(line) || OL.test(line)) {
      const ordered = !UL.test(line) && OL.test(line);
      const checks: (boolean | null)[] = [];
      const items: Inline[][] = [];
      while (i < lines.length) {
        // A thematic break also matches the bullet pattern (`* * *` is a valid
        // `UL` line), and the continuation loop tested only `UL`/`OL` — so a
        // rule *inside* a list was swallowed as a bullet and its characters
        // lost: `- a`/`* * *`/`- b` rendered three items, the middle one empty.
        // The rule ends the list, exactly as it does when one is not open.
        if (HR.test(lines[i])) break;
        const m = ordered ? OL.exec(lines[i]) : UL.exec(lines[i]);
        if (!m) break;
        // A task marker, if this item opens with one. Only at the very start,
        // and only with the space after it that the syntax requires — so a
        // sentence that happens to begin "[x] is undefined" stays a sentence.
        const task = /^\[([ xX])\]\s+(.*)$/.exec(m[1]);
        checks.push(task ? task[1].toLowerCase() === "x" : null);
        items.push(parseInline(task ? task[2] : m[1]));
        i++;
      }
      out.push({ t: "list", ordered, items, checks });
      continue;
    }

    // Tables. A pipe table is a header line, a rule row, then body rows — and
    // it is the shape a coding agent reaches for constantly (every comparison,
    // every options matrix). Without this they fell through to the paragraph
    // branch and rendered as a wall of pipes.
    if (ROW.test(line) && i + 1 < lines.length && RULE.test(lines[i + 1])) {
      const align = cells(lines[i + 1]).map(alignOf);
      const head = cells(line).map((c) => parseInline(c));
      i += 2;
      const rows: Inline[][][] = [];
      while (
        i < lines.length && lines[i].trim() !== "" && ROW.test(lines[i]) &&
        !RULE.test(lines[i])
      ) {
        rows.push(cells(lines[i++]).map((c) => parseInline(c)));
      }
      out.push({ t: "table", head, rows, align });
      continue;
    }

    // Paragraph: consecutive non-blank lines that start nothing else.
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() !== "" && !starts(lines[i])) {
      para.push(lines[i++].trim());
    }
    if (para.length === 0) para.push(lines[i++].trim()); // never stall
    out.push({ t: "p", v: parseInline(para.join(" ")) });
  }

  return out;
}

const starts = (line: string): boolean =>
  FENCE.test(line) || HR.test(line) || H.test(line) || QUOTE.test(line) ||
  UL.test(line) || OL.test(line);

/** Split one table line into cell texts, dropping the optional outer pipes.
 *  An escaped `\|` is content, not a separator — it is how a table holds a
 *  shell pipeline, which is exactly what a coding agent puts in one. */
function cells(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  const out: string[] = [];
  let buf = "";
  for (let i = 0; i < trimmed.length; i++) {
    const c = trimmed[i];
    if (c === "\\" && trimmed[i + 1] === "|") {
      buf += "|";
      i++;
    } else if (c === "|") {
      out.push(buf.trim());
      buf = "";
    } else buf += c;
  }
  out.push(buf.trim());
  return out;
}

const alignOf = (spec: string): Align => {
  const s = spec.trim();
  if (s.startsWith(":") && s.endsWith(":")) return "center";
  if (s.endsWith(":")) return "right";
  return "left";
};

/**
 * Inline spans. Code wins over emphasis, so `` `a * b` `` stays literal.
 *
 * `linkify` turns a bare URL in prose into a link. It is off inside a link's
 * own label, where a second link would nest one `<a>` inside another.
 */

/**
 * Does this inline-code span look like a path worth offering to open?
 *
 * Deliberately narrow. Model output is full of `--flag`, `npm run x` and
 * `Foo/Bar` generics, and a code span that turns into a button on hover is a
 * promise: press this and the file opens. A promise that fails half the time
 * is worse than no button, so the test asks for a separator, a real-looking
 * file name, and no whitespace — and refuses anything that reads like a
 * command.
 *
 * The `:12` suffix an agent writes to point at a line is recognised and
 * stripped: it is not part of the file name, and leaving it on is how you get
 * "no such file: src/app.ts:12".
 */
export function pathish(text: string): { path: string; line: number } | null {
  const raw = text.trim();
  if (raw === "" || raw.length > 240) return null;
  if (/\s/.test(raw)) return null;

  // A trailing :line or :line:column, as every compiler and grep writes it.
  const at = raw.match(/^(.*?):(\d+)(?::\d+)?$/);
  const path = at ? at[1] : raw;
  const line = at ? Number(at[2]) : 0;

  if (!path.includes("/")) return null;
  // A URL is a link, not a path — `parseInline` already made it one if it was
  // written plainly, and a code span holding one should stay quoted text.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) return null;
  // Not every slash is a path separator: "and/or", "24/7", "Result<T/E>".
  if (/[<>|*?"]/.test(path)) return null;

  const name = path.slice(path.lastIndexOf("/") + 1);
  const absolute = path.startsWith("/") || path.startsWith("~/") ||
    path.startsWith("./") || path.startsWith("../");
  // A bare `a/b` needs to look like a file — an extension, or a leading dot —
  // before it earns a button. An absolute path is already unambiguous.
  const looksLikeFile = /\.[A-Za-z0-9]{1,12}$/.test(name) ||
    name.startsWith(".");
  if (!absolute && !looksLikeFile) return null;
  if (name === "") return null;

  return { path, line };
}

export function parseInline(src: string, linkify = true): Inline[] {
  const out: Inline[] = [];
  let buf = "";
  let i = 0;

  const flush = () => {
    if (buf) {
      out.push({ t: "text", v: buf });
      buf = "";
    }
  };

  while (i < src.length) {
    const c = src[i];

    if (c === "\\" && i + 1 < src.length) {
      buf += src[i + 1];
      i += 2;
      continue;
    }

    if (c === "`") {
      // A run of N backticks is closed by the next run of exactly N. Matching a
      // single tick meant ``` ``a`` ``` — the standard way to write code that
      // itself contains a backtick — came out as three pieces with the ticks
      // showing, which is precisely the text an agent uses to quote code.
      let open = 0;
      while (src[i + open] === "`") open++;
      const close = closingRun(src, i + open, open);
      if (close !== -1) {
        flush();
        out.push({ t: "code", v: src.slice(i + open, close) });
        i = close + open;
        continue;
      }
    }

    // `~~struck~~`. Before the emphasis rules, and requiring the doubled form:
    // a single tilde is a home directory far more often than it is emphasis,
    // and `~/code/app` written mid-sentence must survive intact.
    if (c === "~" && src[i + 1] === "~") {
      const end = src.indexOf("~~", i + 2);
      if (end > i + 2) {
        flush();
        out.push({ t: "del", v: parseInline(src.slice(i + 2, end), linkify) });
        i = end + 2;
        continue;
      }
    }

    if (c === "*" && src[i + 1] === "*") {
      const end = src.indexOf("**", i + 2);
      if (end > i + 2) {
        flush();
        out.push({
          t: "strong",
          v: parseInline(src.slice(i + 2, end), linkify),
        });
        i = end + 2;
        continue;
      }
    }

    if (c === "*" || c === "_") {
      const end = src.indexOf(c, i + 1);
      // `_` never opens emphasis inside a word. Without this, every
      // `snake_case_name` an agent writes came out as `snake`+italic+`name`,
      // and identifiers are most of what this parser renders. `*` keeps its
      // intra-word behaviour, which is what CommonMark says too.
      const intraWord = c === "_" &&
        (isWordChar(src[i - 1]) || isWordChar(src[end + 1]));
      if (end > i + 1 && src[i + 1] !== c && !intraWord) {
        flush();
        out.push({ t: "em", v: parseInline(src.slice(i + 1, end), linkify) });
        i = end + 1;
        continue;
      }
    }

    if (c === "[") {
      const close = src.indexOf("]", i + 1);
      if (close > i && src[close + 1] === "(") {
        // Balanced, not first-`)`: a URL may contain parentheses, and
        // Wikipedia-style links (`…/Foo_(bar)`) were truncated at the inner one,
        // leaving a broken href and a stray `)` in the prose.
        const paren = closingParen(src, close + 2);
        if (paren > close) {
          const href = safeHref(src.slice(close + 2, paren).trim());
          const label = parseInline(src.slice(i + 1, close), false);
          flush();
          if (href) out.push({ t: "link", href, v: label });
          else out.push(...label); // unsafe scheme: keep the words, drop the link
          i = paren + 1;
          continue;
        }
      }
    }

    // A bare URL, last: every markup form above starts with a character a URL
    // cannot, so this only ever sees prose. Not after a word character —
    // `shttps://x` is a typo, not an address.
    if (
      linkify && (c === "h" || c === "H" || c === "w" || c === "W") &&
      !isWordChar(src[i - 1])
    ) {
      const hit = autolinkAt(src, i);
      if (hit) {
        flush();
        out.push({
          t: "link",
          href: hit.href,
          v: [{ t: "text", v: hit.text }],
        });
        i = hit.end;
        continue;
      }
    }

    buf += c;
    i++;
  }

  flush();
  return out;
}

/** Where a bare URL stops. Whitespace, and the characters that wrap one in
 *  prose or markup rather than belong to it. */
const URL_STOP = /[\s<>`"'\u00a0]/;

/**
 * A bare URL in running text, if one starts at `i`.
 *
 * Agents print addresses constantly — a docs page, a status page, a PR — and
 * Markdown links only what someone wrapped in `[…](…)`. Everything else
 * rendered as dead text, so the one thing anyone wants to do with a URL
 * (open it) meant selecting and copying it by hand.
 *
 * Code spans and fenced code never reach here: they are taken by the parser
 * before this runs, so a URL inside a code sample stays a code sample.
 */
function autolinkAt(
  src: string,
  i: number,
): { href: string; text: string; end: number } | null {
  const head = src.slice(i, i + 8).toLowerCase();
  if (
    !head.startsWith("http://") && !head.startsWith("https://") &&
    !head.startsWith("www.")
  ) return null;

  let end = i;
  while (end < src.length && !URL_STOP.test(src[end])) end++;
  let text = src.slice(i, end);

  // Trailing punctuation belongs to the sentence, not to the address:
  // "see https://x.dev." is a URL and a full stop. A closing bracket is kept
  // only when the URL opened one — `…/Foo_(bar)` is a real Wikipedia address,
  // while `(see https://x.dev)` is prose in parentheses.
  for (;;) {
    const last = text[text.length - 1];
    if (last === undefined) break;
    if (".,;:!?".includes(last)) {
      text = text.slice(0, -1);
      continue;
    }
    const open = last === ")"
      ? "("
      : last === "]"
      ? "["
      : last === "}"
      ? "{"
      : "";
    if (open && count(text, last) > count(text, open)) {
      text = text.slice(0, -1);
      continue;
    }
    break;
  }

  // `www.x.dev` is an address without a scheme. https is the only reasonable
  // guess — never http, which would silently downgrade the connection.
  const href = text.toLowerCase().startsWith("www.") ? `https://${text}` : text;
  // A scheme with nothing behind it is not an address.
  if (!/^https?:\/\/[^/\s]+\./i.test(href)) return null;
  return { href, text, end: i + text.length };
}

const count = (s: string, ch: string): number => s.split(ch).length - 1;

/** The index of the next run of exactly `n` backticks at or after `from`, or
 *  `-1`. A longer run is not a closer — it belongs to a different span. */
function closingRun(src: string, from: number, n: number): number {
  for (let j = from; j < src.length; j++) {
    if (src[j] !== "`") continue;
    let run = 0;
    while (src[j + run] === "`") run++;
    if (run === n) return j;
    j += run - 1;
  }
  return -1;
}

/** The index of the `)` that closes the `(` before `from`, counting nesting.
 *  `-1` when the link target is never closed. */
function closingParen(src: string, from: number): number {
  let depth = 0;
  for (let j = from; j < src.length; j++) {
    const ch = src[j];
    if (ch === "\\") {
      j++;
      continue;
    }
    if (ch === "(") depth++;
    else if (ch === ")") {
      if (depth === 0) return j;
      depth--;
    }
  }
  return -1;
}

const isWordChar = (c: string | undefined): boolean =>
  c !== undefined && /[A-Za-z0-9]/.test(c);

/** `null` for anything not on the allow-list. */
export function safeHref(href: string): string | null {
  if (!href) return null;
  // Strip control characters and whitespace first: `java\nscript:alert(1)`
  // is a real bypass against a naive prefix test.
  const clean = href.replace(/[\u0000-\u0020]/g, "");
  return SAFE_SCHEME.test(clean) ? clean : null;
}
