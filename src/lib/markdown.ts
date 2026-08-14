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
  | { t: "link"; href: string; v: Inline[] };

export type Block =
  | { t: "p"; v: Inline[] }
  | { t: "h"; level: number; v: Inline[] }
  | { t: "pre"; lang: string; v: string }
  | { t: "list"; ordered: boolean; items: Inline[][] }
  | { t: "quote"; v: Inline[] }
  | { t: "hr" };

/** Schemes a link may use. Anything else (`javascript:`, `data:`, …) loses its
 *  href and renders as plain text — a dropped link beats an executable one. */
const SAFE_SCHEME = /^(https?:|mailto:|#|\/|\.\/|\.\.\/)/i;

const H = /^(#{1,6})\s+(.*)$/;
const UL = /^\s*[-*+]\s+(.*)$/;
const OL = /^\s*\d+[.)]\s+(.*)$/;
const HR = /^\s*([-*_])(\s*\1){2,}\s*$/;
const QUOTE = /^\s*>\s?(.*)$/;
const FENCE = /^\s*```(.*)$/;

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
      const items: Inline[][] = [];
      while (i < lines.length) {
        const m = ordered ? OL.exec(lines[i]) : UL.exec(lines[i]);
        if (!m) break;
        items.push(parseInline(m[1]));
        i++;
      }
      out.push({ t: "list", ordered, items });
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

/** Inline spans. Code wins over emphasis, so `` `a * b` `` stays literal. */
export function parseInline(src: string): Inline[] {
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
      const end = src.indexOf("`", i + 1);
      if (end > i + 1) {
        flush();
        out.push({ t: "code", v: src.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }

    if (c === "*" && src[i + 1] === "*") {
      const end = src.indexOf("**", i + 2);
      if (end > i + 2) {
        flush();
        out.push({ t: "strong", v: parseInline(src.slice(i + 2, end)) });
        i = end + 2;
        continue;
      }
    }

    if (c === "*" || c === "_") {
      const end = src.indexOf(c, i + 1);
      if (end > i + 1 && src[i + 1] !== c) {
        flush();
        out.push({ t: "em", v: parseInline(src.slice(i + 1, end)) });
        i = end + 1;
        continue;
      }
    }

    if (c === "[") {
      const close = src.indexOf("]", i + 1);
      if (close > i && src[close + 1] === "(") {
        const paren = src.indexOf(")", close + 2);
        if (paren > close) {
          const href = safeHref(src.slice(close + 2, paren).trim());
          const label = parseInline(src.slice(i + 1, close));
          flush();
          if (href) out.push({ t: "link", href, v: label });
          else out.push(...label); // unsafe scheme: keep the words, drop the link
          i = paren + 1;
          continue;
        }
      }
    }

    buf += c;
    i++;
  }

  flush();
  return out;
}

/** `null` for anything not on the allow-list. */
export function safeHref(href: string): string | null {
  if (!href) return null;
  // Strip control characters and whitespace first: `java\nscript:alert(1)`
  // is a real bypass against a naive prefix test.
  const clean = href.replace(/[\u0000-\u0020]/g, "");
  return SAFE_SCHEME.test(clean) ? clean : null;
}
