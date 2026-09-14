/**
 * @module
 * The matcher behind the agent's `edit` tool: find the one place a model
 * meant, even when it copied it imperfectly.
 *
 * Small models copy code badly in exactly four ways — indentation off by a
 * level, trailing spaces, typographic quotes, and escaped newlines where real
 * ones belong — and an exact-match-only edit turns each into a failed round.
 * So the match is tried as written, then through progressively looser
 * readings of the same lines (the chain opencode and Cline converged on),
 * and a reading counts only if it finds exactly ONE place.
 *
 * What is deliberately missing is any *similarity* match ("the first and last
 * lines agree and the middle is 70% alike"). Every strategy here matches the
 * same lines with the same words; none lets a model's guess at the middle of a
 * block overwrite what is really there. An edit that cannot be placed exactly
 * fails with a reason, and the model re-reads.
 */

export type Replaced =
  | {
    ok: true;
    content: string;
    /** How many places changed — more than one only with `all`. */
    count: number;
    /** Which reading found it; `exact` unless the model's copy was off. */
    strategy: string;
    /** 1-based line where the first change starts, in the new content. */
    line: number;
  }
  | { ok: false; error: string };

type Span = { start: number; end: number };

/** Our `read` numbers lines as `N\t`; models paste that prefix back. Other
 *  harnesses use `N: ` and `N→`. Stripped only when EVERY non-blank line has
 *  one — a single numbered line in real code is left alone. */
export function stripLineNumbers(text: string): string {
  const lines = text.split("\n");
  const re = /^\s*\d+(?:\t|: |→|\| )/;
  const body = lines.filter((l) => l.trim() !== "");
  if (body.length === 0 || !body.every((l) => re.test(l))) return text;
  return lines.map((l) => l.replace(re, "")).join("\n");
}

const lineStarts = (text: string): number[] => {
  const out = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") out.push(i + 1);
  return out;
};

/** Every exact occurrence, non-overlapping. */
function exactSpans(hay: string, needle: string): Span[] {
  const out: Span[] = [];
  if (!needle) return out;
  for (let i = hay.indexOf(needle); i !== -1;) {
    out.push({ start: i, end: i + needle.length });
    i = hay.indexOf(needle, i + needle.length);
  }
  return out;
}

/** Windows of whole lines whose lines equal `needle`'s under `key`. The span
 *  covers the file's own text for those lines — and the newline after them
 *  when the needle ended in one, so a replacement that also ends in one
 *  does not leave a blank line behind. */
function lineSpans(
  hay: string,
  needle: string,
  key: (lines: string[]) => string[],
): Span[] {
  const eol = needle.endsWith("\n");
  const want = key(needle.replace(/\n$/, "").split("\n"));
  const lines = hay.split("\n");
  const starts = lineStarts(hay);
  const out: Span[] = [];
  const n = want.length;
  if (n === 0 || want.every((l) => l === "")) return out;
  for (let i = 0; i + n <= lines.length; i++) {
    const got = key(lines.slice(i, i + n));
    if (got.every((l, j) => l === want[j])) {
      let end = starts[i + n - 1] + lines[i + n - 1].length;
      if (eol && hay[end] === "\n") end++;
      out.push({ start: starts[i], end });
      i += n - 1; // non-overlapping
    }
  }
  return out;
}

const trimEach = (ls: string[]) => ls.map((l) => l.trim());
const squashEach = (ls: string[]) =>
  ls.map((l) => l.trim().replace(/\s+/g, " "));
const indentOf = (l: string) => /^[ \t]*/.exec(l)![0];
/** Lines with their common indentation removed — so a block copied one
 *  level too shallow or too deep still reads as the same block. */
const dedentEach = (ls: string[]) => {
  const body = ls.filter((l) => l.trim() !== "");
  const min = body.length
    ? Math.min(...body.map((l) => indentOf(l).length))
    : 0;
  return ls.map((l) => l.trim() === "" ? "" : l.slice(min).trimEnd());
};

/** Typographic quotes to straight ones — a one-to-one character map, so an
 *  index into the mapped text is an index into the original. */
const straightQuotes = (s: string) =>
  s.replace(/[‘’‚‛]/g, "'").replace(
    /[“”„‟]/g,
    '"',
  );

/** A model that double-escaped its JSON sends `\n` where a newline belongs. */
const unescape = (s: string) =>
  s.replace(
    /\\(n|t|r|"|'|`|\\|\$)/g,
    (_m, c: string) =>
      c === "n" ? "\n" : c === "t" ? "\t" : c === "r" ? "\r" : c,
  );

type Strategy = {
  name: string;
  find: (hay: string, needle: string) => Span[];
  /** Shape the replacement to the reading that matched: re-indent it the
   *  way the file indents, unescape it the way the needle was unescaped. */
  adapt?: (replacement: string, needle: string, matched: string) => string;
};

const reindented = (r: string, n: string, m: string) => reindent(m, n, r);

const STRATEGIES: Strategy[] = [
  { name: "exact", find: exactSpans },
  {
    name: "trailing whitespace",
    find: (h, n) => lineSpans(h, n, (ls) => ls.map((l) => l.trimEnd())),
  },
  {
    name: "indentation",
    find: (h, n) => lineSpans(h, n, dedentEach),
    adapt: reindented,
  },
  {
    name: "whitespace",
    find: (h, n) => lineSpans(h, n, squashEach),
    adapt: reindented,
  },
  {
    name: "quotes",
    find: (h, n) => exactSpans(straightQuotes(h), straightQuotes(n)),
  },
  {
    name: "escapes",
    find: (h, n) => {
      const u = unescape(n);
      if (u === n) return [];
      const exact = exactSpans(h, u);
      return exact.length ? exact : lineSpans(h, u, trimEach);
    },
    // The same over-escaping is in the new half — written by the same hand.
    adapt: (r) => unescape(r),
  },
  {
    name: "surrounding blank lines",
    find: (h, n) => (n.trim() === n ? [] : exactSpans(h, n.trim())),
    // The blank lines the match ignored are not the model's to add back.
    adapt: (r, n) => {
      const lead = /^\s*/.exec(n)![0];
      const trail = /\s*$/.exec(n)![0];
      let out = lead && r.startsWith(lead) ? r.slice(lead.length) : r;
      if (trail && out.endsWith(trail)) {
        out = out.slice(0, out.length - trail.length);
      }
      return out;
    },
  },
];

/**
 * Re-indent `replacement` the way the file indents the block it replaces.
 *
 * The model's `old_string` said the block starts with indentation A; the file
 * says B. Every replacement line that starts with A gets B instead — which is
 * exactly the change a person makes when pasting a block one level off.
 */
function reindent(
  matched: string,
  oldStr: string,
  replacement: string,
): string {
  const first = (s: string) => s.split("\n").find((l) => l.trim() !== "") ?? "";
  const have = indentOf(first(oldStr));
  const want = indentOf(first(matched));
  if (have === want) return replacement;
  return replacement.split("\n").map((l) =>
    l.trim() === ""
      ? l
      : l.startsWith(have)
      ? want + l.slice(have.length)
      : have === ""
      ? want + l
      : l
  ).join("\n");
}

/**
 * Replace `oldStr` with `newStr` in `content`.
 *
 * Line endings are the file's: the match runs on LF, and a CRLF file is
 * written back as CRLF, so a model that only ever writes `\n` can still edit
 * a Windows file without converting every line of it.
 */
export function replaceIn(
  content: string,
  oldStr: string,
  newStr: string,
  all = false,
): Replaced {
  const crlf = content.includes("\r\n");
  const hay = crlf ? content.replace(/\r\n/g, "\n") : content;
  const lf = (s: string) => s.replace(/\r\n/g, "\n");
  let oldText = lf(oldStr);
  let newText = lf(newStr);
  // Numbered lines pasted back from a read: strip from both halves, but only
  // when the old half was numbered — a new half that happens to be numbered
  // on its own is somebody's real content.
  const unnumbered = stripLineNumbers(oldText);
  if (unnumbered !== oldText) {
    oldText = unnumbered;
    newText = stripLineNumbers(newText);
  }
  if (oldText === "") {
    return {
      ok: false,
      error: "old_string is empty. To create a new file use write; to add" +
        " to one, include the line you are inserting next to.",
    };
  }
  if (oldText === newText) {
    return {
      ok: false,
      error: "old_string and new_string are identical — nothing to change.",
    };
  }

  for (const s of STRATEGIES) {
    const spans = s.find(hay, oldText);
    if (spans.length === 0) continue;
    if (spans.length > 1 && !all) {
      return {
        ok: false,
        error: `old_string matches ${spans.length} places. Include more` +
          ` surrounding lines to make it unique, or set replace_all to` +
          ` replace every one.`,
      };
    }
    // Right to left, so earlier spans keep their offsets.
    let out = hay;
    for (const sp of [...spans].reverse()) {
      const matched = hay.slice(sp.start, sp.end);
      const text = s.adapt ? s.adapt(newText, oldText, matched) : newText;
      out = out.slice(0, sp.start) + text + out.slice(sp.end);
    }
    const line = hay.slice(0, spans[0].start).split("\n").length;
    return {
      ok: true,
      content: crlf ? out.replace(/\n/g, "\r\n") : out,
      count: spans.length,
      strategy: s.name,
      line,
    };
  }
  return {
    ok: false,
    error: "old_string was not found in the file." + nearMiss(hay, oldText) +
      " Copy it exactly from a fresh read (whitespace included, without the" +
      " line-number prefix) — the file may also have changed since you read" +
      " it.",
  };
}

/**
 * Where an old_string that matched nowhere comes closest: the longest run of
 * its lines found in the file, and the first line after that run that differs.
 *
 * "Not found" alone costs a full re-read. A live session built an old_string
 * out of two near-identical methods it had just written — six lines right,
 * one line (`const hh = …`) that only the other method had — and read a
 * 257-line file to find that one line. `""` when not even a first line is
 * there to anchor on.
 */
export function nearMiss(hay: string, oldText: string): string {
  const want = oldText.split("\n").map((l) => l.trim());
  const have = hay.split("\n");
  const cut = (t: string) => t.length > 100 ? t.slice(0, 100) + "…" : t;
  let best = { at: -1, run: 0 };
  for (let i = 0; i < have.length; i++) {
    let run = 0;
    while (
      run < want.length && i + run < have.length &&
      have[i + run].trim() === want[run]
    ) run++;
    // Blank lines match everywhere; a run that is nothing but them anchors
    // nothing.
    if (want.slice(0, run).every((l) => l === "")) continue;
    if (run > best.run) best = { at: i, run };
  }
  if (best.at < 0 || best.run >= want.length) return "";
  const line = best.at + best.run;
  const theirs = have[line];
  return ` Its first ${best.run} line${best.run === 1 ? "" : "s"} match the` +
    ` file at line ${best.at + 1}; line ${best.run + 1} of old_string is` +
    ` \`${cut(want[best.run])}\`, where the file has ${
      theirs === undefined ? "nothing more" : `\`${cut(theirs.trim())}\``
    }.`;
}

/** A few numbered lines around `line`, for the report an edit sends back:
 *  enough for the model to see its change landed where it meant, without
 *  spending a round re-reading the file. */
export function snippet(
  content: string,
  line: number,
  span: number,
  context = 2,
  maxLines = 14,
): string {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const from = Math.max(1, line - context);
  const to = Math.min(
    lines.length,
    line + span - 1 + context,
    from + maxLines - 1,
  );
  const out: string[] = [];
  for (let n = from; n <= to; n++) {
    out.push(`${n}\t${lines[n - 1].slice(0, 300)}`);
  }
  return out.join("\n");
}
