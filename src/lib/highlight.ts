/**
 * @module
 * A small, dependency-free syntax highlighter for the languages a coding agent
 * actually pastes back: TypeScript/JavaScript and friends, JSON, shell, and
 * anything C-like it does not recognise.
 *
 * It returns *tokens*, never HTML — the renderer turns them into AIR nodes, so
 * highlighted code is escaped by construction exactly like plain code is.
 *
 * One lexer covers every supported language, parameterised by a keyword set and
 * a comment style. That is deliberate: a per-language grammar would be an order
 * of magnitude more code for output nobody reads more closely than "strings are
 * green, keywords are blue".
 */

export type TokenKind =
  | "plain"
  | "comment"
  | "string"
  | "number"
  | "keyword"
  | "literal"
  | "function"
  | "property"
  | "operator";

export type Token = { kind: TokenKind; text: string };

const JS_KEYWORDS = new Set(
  ("abstract as async await break case catch class const continue declare default delete do else enum export " +
    "extends finally for from function get if implements import in instanceof interface keyof let new of " +
    "private protected public readonly return satisfies set static super switch this throw try type typeof " +
    "var void while yield")
    .split(" "),
);

const SHELL_KEYWORDS = new Set(
  ("if then else elif fi for while do done case esac in function return export local readonly set unset " +
    "cd echo exit source sudo trap shift eval exec")
    .split(" "),
);

const LITERALS = new Set([
  "true",
  "false",
  "null",
  "undefined",
  "NaN",
  "Infinity",
]);

type Dialect = {
  keywords: Set<string>;
  line: string[]; // line-comment markers
  block: boolean; // supports /* … */
  hash: boolean; // '#' starts a comment
};

const DIALECTS: Record<string, Dialect> = {
  js: { keywords: JS_KEYWORDS, line: ["//"], block: true, hash: false },
  json: { keywords: new Set(), line: [], block: false, hash: false },
  shell: { keywords: SHELL_KEYWORDS, line: [], block: false, hash: true },
  generic: { keywords: JS_KEYWORDS, line: ["//"], block: true, hash: true },
};

const ALIASES: Record<string, keyof typeof DIALECTS> = {
  ts: "js",
  tsx: "js",
  typescript: "js",
  js: "js",
  jsx: "js",
  javascript: "js",
  mjs: "js",
  json: "json",
  jsonc: "json",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  shell: "shell",
  console: "shell",
  py: "generic",
  python: "generic",
  rb: "generic",
  ruby: "generic",
  go: "generic",
  rust: "generic",
  rs: "generic",
  java: "generic",
  c: "generic",
  cpp: "generic",
  h: "generic",
  css: "generic",
  yaml: "generic",
  yml: "generic",
  toml: "generic",
};

/** True when we have a dialect for this fence language (or none was given). */
export const canHighlight = (lang: string): boolean =>
  lang === "" || ALIASES[lang.toLowerCase()] !== undefined;

const dialectFor = (lang: string): Dialect =>
  DIALECTS[ALIASES[lang.toLowerCase()] ?? "generic"];

const isIdentStart = (c: string) => /[A-Za-z_$]/.test(c);
const isIdent = (c: string) => /[A-Za-z0-9_$]/.test(c);
const isDigit = (c: string) => /[0-9]/.test(c);
const OPERATORS = "+-*/%=<>!&|^~?:.,;()[]{}";

/**
 * Tokenize `src`. Never throws and never loses a character: concatenating every
 * token's text reproduces the input exactly, which is what makes it safe to
 * render as the code block itself.
 */
export function highlight(src: string, lang = ""): Token[] {
  // A fence language we have no dialect for is rendered plain. `canHighlight`
  // existed to say this and nothing consulted it, so every unknown language got
  // the JS-plus-`#`-comments `generic` dialect: a Markdown block had its
  // `# Heading` greyed out as a comment, and an HTML line went grey from the
  // first `#` onward. Wrong colour is worse than no colour.
  if (!canHighlight(lang)) return src ? [{ kind: "plain", text: src }] : [];
  const d = dialectFor(lang);
  const out: Token[] = [];
  let plain = "";
  let i = 0;

  const flush = () => {
    if (plain) {
      out.push({ kind: "plain", text: plain });
      plain = "";
    }
  };
  const push = (kind: TokenKind, text: string) => {
    flush();
    out.push({ kind, text });
  };

  while (i < src.length) {
    const c = src[i];
    const rest = src.slice(i);

    // comments
    if (d.hash && c === "#") {
      const end = src.indexOf("\n", i);
      const stop = end === -1 ? src.length : end;
      push("comment", src.slice(i, stop));
      i = stop;
      continue;
    }
    const line = d.line.find((m) => rest.startsWith(m));
    if (line) {
      const end = src.indexOf("\n", i);
      const stop = end === -1 ? src.length : end;
      push("comment", src.slice(i, stop));
      i = stop;
      continue;
    }
    if (d.block && rest.startsWith("/*")) {
      const end = src.indexOf("*/", i + 2);
      const stop = end === -1 ? src.length : end + 2;
      push("comment", src.slice(i, stop));
      i = stop;
      continue;
    }

    // strings (and template literals)
    if (c === '"' || c === "'" || c === "`") {
      // Quotes end at the line break; backticks do not, because a template
      // literal is genuinely multi-line. Without the boundary, one apostrophe in
      // a comment or a word (`it's`) painted every following line as a string
      // until the next quote — two lines of code the wrong colour, from one
      // character. A regex literal holding a quote did the same.
      const multiline = c === "`";
      let j = i + 1;
      while (j < src.length) {
        if (src[j] === "\\") j += 2;
        else if (src[j] === c) {
          j++;
          break;
        } else if (!multiline && src[j] === "\n") break;
        else j++;
      }
      const end = Math.min(j, src.length);
      // A quoted key ("count":) is a property, not a value. Without this, JSON
      // keys and string values share one colour and the shape of an object is
      // much harder to scan.
      let after = end;
      while (after < src.length && /\s/.test(src[after])) after++;
      push(src[after] === ":" ? "property" : "string", src.slice(i, end));
      i = end;
      continue;
    }

    // numbers
    if (isDigit(c) || (c === "." && isDigit(src[i + 1] ?? ""))) {
      let j = i;
      while (j < src.length && /[0-9a-fA-FxXbBoO._]/.test(src[j])) j++;
      push("number", src.slice(i, j));
      i = j;
      continue;
    }

    // identifiers → keyword / literal / function call / object property
    if (isIdentStart(c)) {
      let j = i;
      while (j < src.length && isIdent(src[j])) j++;
      const word = src.slice(i, j);
      let after = j;
      while (after < src.length && /\s/.test(src[after])) after++;

      if (d.keywords.has(word)) push("keyword", word);
      else if (LITERALS.has(word)) push("literal", word);
      else if (src[after] === "(") push("function", word);
      else if (src[after] === ":") push("property", word);
      else plain += word;
      i = j;
      continue;
    }

    if (OPERATORS.includes(c)) {
      push("operator", c);
      i++;
      continue;
    }

    plain += c;
    i++;
  }

  flush();
  return out;
}

/**
 * The fence language for a file, from its extension.
 *
 * Lives here rather than in the one page that first needed it: three surfaces
 * now guess a language from a file name — the tree's preview, a Write tool
 * call, and an edit — and three copies of this table would drift the first
 * time somebody added a language to one of them.
 *
 * The highlighter answers "I have no dialect for this" by rendering plain, so
 * an unknown extension costs nothing and a wrong guess would cost colour on
 * the wrong tokens.
 */
const LANGS: Record<string, string> = {
  ts: "ts",
  tsx: "ts",
  mts: "ts",
  js: "js",
  jsx: "js",
  mjs: "js",
  cjs: "js",
  json: "json",
  jsonc: "json",
  md: "md",
  markdown: "md",
  css: "css",
  html: "html",
  htm: "html",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  py: "python",
  rs: "rust",
  go: "go",
  toml: "toml",
  yml: "yaml",
  yaml: "yaml",
  sql: "sql",
  c: "c",
  h: "c",
};

export const langOfFile = (name: string): string => {
  const base = name.slice(name.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? LANGS[base.slice(dot + 1).toLowerCase()] ?? "" : "";
};
