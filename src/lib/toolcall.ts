/**
 * @module
 * Making a weak model's tool calls land.
 *
 * A local model has been trained on somebody else's harness. It asks for
 * `read_file` with `file_path`, `bash` with `command`, `TodoWrite` with
 * `todos` — or it writes the call into its reply as text, because the server's
 * chat template has no tool format for it. Every one of those is a call the
 * model *meant*, and refusing it costs a round that a small model often does
 * not recover from. So the names and keys other harnesses use are mapped onto
 * ours, a call written as text is recovered from the reply, and arguments that
 * are almost JSON are repaired — all here, pure, before the executor judges
 * the result exactly as strictly as before.
 *
 * What this never does is invent intent. An unknown name stays unknown (the
 * refusal lists the real ones); a call written inside prose is not executed
 * (see {@link recoverToolCalls}); JSON cut off by the output limit is not
 * "repaired" into a shorter command than the one the model was writing.
 */

/** Other harnesses' tool names, squashed (lower case, letters and digits
 *  only), mapped to ours. Claude Code, opencode, Aider, Cursor, Cline, Codex
 *  and the OpenAI cookbook between them cover what local models reach for. */
const NAME_ALIASES: Record<string, string> = {
  // sh
  bash: "sh",
  shell: "sh",
  run: "sh",
  runcommand: "sh",
  runshellcommand: "sh",
  runterminalcmd: "sh",
  runterminalcommand: "sh",
  shellcommand: "sh",
  bashcommand: "sh",
  execute: "sh",
  executecommand: "sh",
  exec: "sh",
  execcommand: "sh",
  terminal: "sh",
  command: "sh",
  localshell: "sh",
  // history
  searchhistory: "history",
  conversationsearch: "history",
  searchconversations: "history",
  pastconversations: "history",
  chathistory: "history",
  recall: "history",
  memorysearch: "history",
  // read
  readfile: "read",
  readtextfile: "read",
  view: "read",
  viewfile: "read",
  cat: "read",
  open: "read",
  openfile: "read",
  fileread: "read",
  getfile: "read",
  getfilecontents: "read",
  // write
  writefile: "write",
  writetofile: "write",
  createfile: "write",
  create: "write",
  savefile: "write",
  filewrite: "write",
  newfile: "write",
  // edit
  editfile: "edit",
  fileedit: "edit",
  strreplace: "edit",
  strreplaceeditor: "edit",
  strreplacebasededittool: "edit",
  replace: "edit",
  replaceinfile: "edit",
  searchreplace: "edit",
  searchandreplace: "edit",
  applyedit: "edit",
  modifyfile: "edit",
  updatefile: "edit",
  // ls
  list: "ls",
  listdir: "ls",
  listdirectory: "ls",
  listfiles: "ls",
  listfolder: "ls",
  readdir: "ls",
  dir: "ls",
  // grep
  search: "grep",
  grepsearch: "grep",
  searchfiles: "grep",
  searchcode: "grep",
  codesearch: "grep",
  searchtext: "grep",
  textsearch: "grep",
  searchcontent: "grep",
  findinfiles: "grep",
  ripgrep: "grep",
  rg: "grep",
  // glob
  find: "glob",
  findfiles: "glob",
  findfile: "glob",
  filesearch: "glob",
  globsearch: "glob",
  searchfilenames: "glob",
  // todo
  todowrite: "todo",
  todolist: "todo",
  todos: "todo",
  writetodos: "todo",
  updatetodos: "todo",
  settodos: "todo",
  tasklist: "todo",
  updateplan: "todo",
};

/**
 * Our name for a tool name a model produced, or the name unchanged when it
 * means nothing we know — the executor's refusal then lists the real ones.
 *
 * Namespaces are dropped first (`functions.read`, `default_api:read`), then
 * case, then separators: `Read`, `read_file` and `ReadFile` are one intent.
 */
export function canonicalName(raw: string, known: readonly string[]): string {
  const bare = String(raw ?? "").trim().replace(/^.*[.:/]/, "");
  const low = bare.toLowerCase();
  if (known.includes(low)) return low;
  const alias = NAME_ALIASES[low.replace(/[^a-z0-9]/g, "")];
  return alias && known.includes(alias) ? alias : String(raw ?? "").trim();
}

/** Key spellings for "the file", across harnesses. */
const PATH_KEYS = [
  "file_path",
  "filePath",
  "filepath",
  "file",
  "filename",
  "fileName",
  "target_file",
  "targetFile",
  "relative_path",
  "relativePath",
  "absolute_path",
  "absolutePath",
  "target",
];
/** …and for "the directory". */
const DIR_KEYS = ["dir", "directory", "folder", "cwd", "root", "dir_path"];

/** Per tool: canonical key → the other spellings it arrives as. */
const ARG_ALIASES: Record<string, Record<string, string[]>> = {
  ls: { path: [...DIR_KEYS, ...PATH_KEYS] },
  glob: {
    pattern: ["glob", "query", "name", "file_pattern", "filePattern"],
    path: DIR_KEYS,
  },
  read: {
    path: PATH_KEYS,
    offset: ["start_line", "startLine", "line_start", "line", "start", "from"],
    limit: ["lines", "count", "max_lines", "maxLines", "num_lines"],
  },
  history: {
    query: ["q", "search", "text", "term", "terms", "keywords", "pattern"],
    conversation: ["conv", "chat", "session", "conversation_id"],
    id: ["message_id", "messageId", "row"],
  },
  grep: {
    pattern: ["query", "regex", "search", "q", "text", "term", "keyword"],
    path: [...DIR_KEYS, ...PATH_KEYS],
    include: ["glob", "file_pattern", "filePattern", "files", "filter"],
  },
  edit: {
    path: PATH_KEYS,
    old_string: [
      "oldString",
      "old_str",
      "oldStr",
      "old_text",
      "oldText",
      "old",
      "search",
      "find",
      "original",
    ],
    new_string: [
      "newString",
      "new_str",
      "newStr",
      "new_text",
      "newText",
      "new",
      "replace",
      "replacement",
      "updated",
    ],
    replace_all: ["replaceAll", "all", "global"],
  },
  write: {
    path: PATH_KEYS,
    content: [
      "text",
      "contents",
      "file_text",
      "fileText",
      "file_content",
      "fileContent",
      "data",
      "body",
      "code",
    ],
  },
  todo: { items: ["todos", "tasks", "list", "plan", "steps"] },
  sh: {
    cmd: ["command", "commands", "script", "bash", "shell", "code", "input"],
    timeout: ["timeout_ms", "timeoutMs", "time_limit"],
  },
};

/** The one field a bare string argument can only mean. */
const MAIN_KEY: Record<string, string> = {
  ls: "path",
  read: "path",
  write: "path",
  edit: "path",
  glob: "pattern",
  grep: "pattern",
  sh: "cmd",
};

/**
 * Rename other harnesses' argument keys to ours, and coerce the handful of
 * shapes that are unambiguous: numbers sent as strings, `"true"`, a command
 * sent as a list, a line range sent as start and end. A key we already have
 * is never overwritten — the model's own use of our spelling wins.
 */
export function canonicalArgs(
  name: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...args };
  for (const [key, spellings] of Object.entries(ARG_ALIASES[name] ?? {})) {
    if (out[key] !== undefined) continue;
    const hit = spellings.find((k) => out[k] !== undefined);
    if (hit !== undefined) {
      out[key] = out[hit];
      delete out[hit];
    }
  }
  const asNum = (v: unknown) =>
    typeof v === "string" && /^\s*-?\d+(\.\d+)?\s*$/.test(v) ? Number(v) : v;
  if (name === "read") {
    out.offset = asNum(out.offset);
    out.limit = asNum(out.limit);
    // A range sent as start and end — the other common spelling of a slice.
    const end = asNum(out.end_line ?? out.endLine ?? out.line_end ?? out.to);
    if (
      out.limit === undefined && typeof end === "number" &&
      typeof out.offset === "number" && end >= out.offset
    ) {
      out.limit = end - out.offset + 1;
    }
  }
  if (name === "sh") {
    // Claude Code's spellings of the same two switches.
    if (out.background === undefined && out.run_in_background !== undefined) {
      out.background = out.run_in_background === true ||
        out.run_in_background === "true";
      delete out.run_in_background;
    }
    if (out.outside_sandbox === undefined) {
      if (out.dangerouslyDisableSandbox !== undefined) {
        out.outside_sandbox = out.dangerouslyDisableSandbox === true ||
          out.dangerouslyDisableSandbox === "true";
        delete out.dangerouslyDisableSandbox;
      } else if (out.sandbox === false || out.sandbox === "false") {
        out.outside_sandbox = true;
        delete out.sandbox;
      }
    }
    if (typeof out.background === "string") {
      out.background = out.background.trim().toLowerCase() === "true";
    }
    if (typeof out.outside_sandbox === "string") {
      out.outside_sandbox = out.outside_sandbox.trim().toLowerCase() === "true";
    }
    if (Array.isArray(out.cmd)) {
      // A list of commands is a sequence; `&&` stops at the first failure,
      // which is what someone listing steps means.
      out.cmd = out.cmd.filter((c) => typeof c === "string").join(" && ");
    }
    out.timeout = asNum(out.timeout);
  }
  if (name === "edit" && typeof out.replace_all === "string") {
    out.replace_all = out.replace_all.trim().toLowerCase() === "true";
  }
  if (name === "todo" && typeof out.items === "string") {
    // Double-encoded — the list as a JSON string inside the JSON.
    try {
      out.items = JSON.parse(out.items);
    } catch { /* left for the executor to reject */ }
  }
  return out;
}

/* ── JSON the model almost wrote ──────────────────────────────────────────── */

/** Escape raw control characters inside string literals — a newline typed
 *  straight into `"content": "…"` is the commonest reason a `write` call is
 *  not JSON. Everything outside strings is left alone. */
function escapeInStrings(text: string): string {
  let out = "";
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (ch === "\\") {
        out += ch + (text[i + 1] ?? "");
        i++;
        continue;
      }
      if (ch === '"') inStr = false;
      else if (ch === "\n") {
        out += "\\n";
        continue;
      } else if (ch === "\r") {
        out += "\\r";
        continue;
      } else if (ch === "\t") {
        out += "\\t";
        continue;
      }
    } else if (ch === '"') inStr = true;
    out += ch;
  }
  return out;
}

const tryParse = (text: string): { ok: true; value: unknown } | null => {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return null;
  }
};

/**
 * Parse a tool call's arguments, repairing what is safe to repair.
 *
 * `truncated` is the reply having hit the output limit. Then the arguments
 * are exactly as long as the model got to write, and closing them would run
 * a *shorter* command or write a *shorter* file than the one intended — so
 * that case is never repaired; the executor says the call was cut off, and
 * the model sends it again smaller.
 */
export function parseArgs(
  raw: string,
  truncated = false,
): { ok: true; args: Record<string, unknown> | string } | { ok: false } {
  const text = String(raw ?? "").trim();
  if (text === "") return { ok: true, args: {} };
  const shape = (v: unknown): Record<string, unknown> | string | null =>
    v && typeof v === "object" && !Array.isArray(v)
      ? v as Record<string, unknown>
      : typeof v === "string"
      ? v
      : null;

  const direct = tryParse(text);
  if (direct) {
    // Double-encoded: the arguments object as a JSON string.
    if (typeof direct.value === "string") {
      const inner = tryParse(direct.value);
      const obj = inner ? shape(inner.value) : null;
      if (obj !== null) return { ok: true, args: obj };
    }
    const obj = shape(direct.value);
    return obj === null ? { ok: false } : { ok: true, args: obj };
  }
  if (truncated) return { ok: false };

  let fixed = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  fixed = escapeInStrings(fixed).replace(/,\s*([}\]])/g, "$1");
  for (
    const tail of ["", "}", '"}', "]}", '"]}', "}}", '"}}', "]}}", '"]}}']
  ) {
    const got = tryParse(fixed + tail);
    const obj = got ? shape(got.value) : null;
    if (obj !== null && typeof obj === "object") return { ok: true, args: obj };
  }
  // Python-style dicts from models that learned tool calls from Python —
  // only when there is no double quote at all to be confused with.
  if (!fixed.includes('"') && fixed.startsWith("{")) {
    const got = tryParse(
      fixed.replace(/'/g, '"').replace(/\bTrue\b/g, "true").replace(
        /\bFalse\b/g,
        "false",
      ).replace(/\bNone\b/g, "null"),
    );
    const obj = got ? shape(got.value) : null;
    if (obj !== null && typeof obj === "object") return { ok: true, args: obj };
  }
  return { ok: false };
}

/**
 * One call, in our vocabulary: canonical name, canonical keys, arguments
 * re-serialized as clean JSON. Arguments that cannot be parsed are left as
 * they came, so the executor's own error — which says the call may have been
 * cut off — is the one the model reads.
 */
export function normalizeCall<T extends { name: string; args: string }>(
  call: T,
  known: readonly string[],
  truncated = false,
): T {
  const name = canonicalName(call.name, known);
  const parsed = parseArgs(call.args, truncated);
  if (!parsed.ok) return { ...call, name };
  const obj = typeof parsed.args === "string"
    ? MAIN_KEY[name] ? { [MAIN_KEY[name]]: parsed.args } : {}
    : parsed.args;
  return { ...call, name, args: JSON.stringify(canonicalArgs(name, obj)) };
}

/* ── calls written as text ────────────────────────────────────────────────── */

export type TextCall = { name: string; args: string };

/** Pull `{name, arguments}` out of the object shapes models write a call as:
 *  Hermes/Qwen `{name, arguments}`, OpenAI `{type, function: {…}}`, Llama
 *  `{name, parameters}`, and the `tool`/`input`/`args` variants. */
function callFromObject(v: unknown, known: readonly string[]): TextCall | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const fn = o.function && typeof o.function === "object"
    ? o.function as Record<string, unknown>
    : o;
  const rawName = fn.name ?? o.tool ?? o.tool_name ?? o.name;
  if (typeof rawName !== "string") return null;
  const name = canonicalName(rawName, known);
  if (!known.includes(name)) return null;
  const a = fn.arguments ?? fn.parameters ?? fn.args ?? fn.input ?? o.args ??
    o.arguments ?? o.parameters ?? o.input ?? {};
  return { name, args: typeof a === "string" ? a : JSON.stringify(a) };
}

/** Every call in a JSON blob: one object, or a list of them. */
function callsFromJson(text: string, known: readonly string[]): TextCall[] {
  const direct = tryParse(text.trim());
  let value: unknown = direct?.value;
  if (!direct) {
    const repaired = parseArgs(text);
    value = repaired.ok ? repaired.args : undefined;
  }
  if (Array.isArray(value)) {
    return value.map((v) => callFromObject(v, known)).filter(
      (c): c is TextCall => c !== null,
    );
  }
  const one = callFromObject(value, known);
  return one ? [one] : [];
}

/** Qwen3-Coder / GLM XML: `<function=NAME><parameter=K>V</parameter>…`. */
function callsFromFunctionXml(
  body: string,
  known: readonly string[],
): TextCall[] {
  const out: TextCall[] = [];
  const fnRe = /<function=([^>\s]+)>([\s\S]*?)(?:<\/function>|$)/g;
  for (const m of body.matchAll(fnRe)) {
    const name = canonicalName(m[1], known);
    if (!known.includes(name)) continue;
    // Values stay the strings they were written as. Parsing them as JSON
    // would turn the content of a `package.json` being written into an
    // object — and an empty file. The few typed fields (a line offset, a
    // flag, a todo list) are coerced by `canonicalArgs`, which knows which.
    const args: Record<string, unknown> = {};
    const pRe =
      /<parameter=([^>\s]+)>([\s\S]*?)(?:<\/parameter>|(?=<parameter=)|$)/g;
    for (const p of m[2].matchAll(pRe)) {
      args[p[1]] = p[2].replace(/^\n/, "").replace(/\n$/, "");
    }
    out.push({ name, args: JSON.stringify(args) });
  }
  return out;
}

/** GLM-4.5: `NAME<arg_key>k</arg_key><arg_value>v</arg_value>…`. */
function callsFromArgKeys(body: string, known: readonly string[]): TextCall[] {
  const m = /^\s*([\w.:-]+)\s*((?:<arg_key>[\s\S]*?<\/arg_value>\s*)*)$/.exec(
    body,
  );
  if (!m) return [];
  const name = canonicalName(m[1], known);
  if (!known.includes(name)) return [];
  const args: Record<string, unknown> = {};
  const re =
    /<arg_key>([\s\S]*?)<\/arg_key>\s*<arg_value>([\s\S]*?)<\/arg_value>/g;
  // Strings, for the reason given in `callsFromFunctionXml`.
  for (const p of m[2].matchAll(re)) args[p[1].trim()] = p[2];
  return [{ name, args: JSON.stringify(args) }];
}

/** The body of one tagged block, in whichever dialect it was written. */
function callsFromBlock(body: string, known: readonly string[]): TextCall[] {
  if (body.includes("<function=")) return callsFromFunctionXml(body, known);
  if (body.includes("<arg_key>")) return callsFromArgKeys(body, known);
  return callsFromJson(body, known);
}

/** Tagged formats: the tag says "this is a call", so no prose guard is
 *  needed — nobody writes these tags while explaining something. The closing
 *  tag is optional: a model often stops generating right after the object. */
const TAGGED: RegExp[] = [
  /<tool_call>([\s\S]*?)(?:<\/tool_call>|$)/g,
  /<\|tool_call\|>([\s\S]*?)(?:<\|\/tool_call\|>|<\|end\|>|$)/g,
  /\[TOOL_REQUEST\]([\s\S]*?)(?:\[END_TOOL_REQUEST\]|$)/g,
  /<\|python_tag\|>([\s\S]*?)(?:<\|eom_id\|>|<\|eot_id\|>|$)/g,
];

/** One `<tool>body</tool>` call: a JSON object is the arguments, a list is a
 *  todo list, anything else is the tool's one obvious field. */
function callFromTag(name: string, body: string): TextCall | null {
  const parsed = tryParse(body);
  if (parsed && Array.isArray(parsed.value)) {
    return name === "todo"
      ? { name, args: JSON.stringify({ items: parsed.value }) }
      : null;
  }
  if (parsed && parsed.value && typeof parsed.value === "object") {
    return { name, args: JSON.stringify(parsed.value) };
  }
  const key = MAIN_KEY[name];
  return key && body ? { name, args: JSON.stringify({ [key]: body }) } : null;
}

/**
 * Did the model TRY to call a tool and get the format wrong?
 *
 * A reply that mentions the machinery of a call — the wrapper tags, a JSON
 * object naming a real tool — but from which nothing could be recovered. Not
 * a final answer: the model believes it asked for something and is waiting.
 * Worth one precise reminder of the format, which is the whole fix.
 */
export function looksLikeCall(text: string, known: readonly string[]): boolean {
  if (
    /<tool_call|<function[=\s]|\[TOOL_(CALLS|REQUEST)\]|<\|tool_call\|>/i.test(
      text,
    )
  ) {
    return true;
  }
  const names = known.map((k) => k.replace(/\W/g, "")).join("|");
  return new RegExp(`"(name|tool)"\\s*:\\s*"(${names})"`).test(text) ||
    new RegExp(`<(${names})>`).test(text);
}

/** Find the last balanced `{…}` or `[…]` that ends the text (whitespace
 *  after it allowed), respecting strings. `null` when the text does not end
 *  in one. */
function trailingJson(text: string): { start: number; json: string } | null {
  const end = text.trimEnd();
  const close = end[end.length - 1];
  if (close !== "}" && close !== "]") return null;
  const open = close === "}" ? "{" : "[";
  let depth = 0;
  let inStr = false;
  for (let i = end.length - 1; i >= 0; i--) {
    const ch = end[i];
    if (inStr) {
      if (ch === '"' && end[i - 1] !== "\\") inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === close) depth++;
    else if (ch === open) {
      depth--;
      if (depth === 0) return { start: i, json: end.slice(i) };
    }
  }
  return null;
}

/**
 * Recover the tool calls a model wrote into its reply as text, and the reply
 * with them taken out.
 *
 * Two kinds of evidence count. A tagged block — `<tool_call>`, `[TOOL_CALLS]`,
 * `<function=…>`, LM Studio's `[TOOL_REQUEST]` — is a call by construction.
 * Untagged JSON is trusted only when it ENDS the reply: a model explaining a
 * call writes prose after the example, a model making one stops. That guard
 * (the one openclaude arrived at) is what keeps a code sample in an answer
 * from being executed. Only known tool names are recovered, ever.
 */
export function recoverToolCalls(
  text: string,
  known: readonly string[],
): { calls: TextCall[]; text: string } {
  if (!known.length || !text) return { calls: [], text };
  let rest = text;
  const calls: TextCall[] = [];
  for (const re of TAGGED) {
    rest = rest.replace(re, (_m, body: string) => {
      const found = callsFromBlock(body, known);
      calls.push(...found);
      return found.length ? "" : _m;
    });
  }
  // Mistral: `[TOOL_CALLS][{…}]` or `[TOOL_CALLS]name[ARGS]{…}`.
  rest = rest.replace(
    /\[TOOL_CALLS\]\s*(?:([\w.:-]+)\s*\[ARGS\]\s*)?([\s\S]*)$/,
    (m, nm: string | undefined, body: string) => {
      const found = nm
        ? (() => {
          const name = canonicalName(nm, known);
          return known.includes(name) ? [{ name, args: body.trim() }] : [];
        })()
        : callsFromJson(body, known);
      calls.push(...found);
      return found.length ? "" : m;
    },
  );
  // A tag named after the tool — `<read>{"path":"a"}</read>`, `<todo>[…]
  // </todo>`, `<sh>npm test</sh>`. Small models invent this shape when they
  // were told a tool's name but not the format; the tag IS the tool name, so
  // it is as unambiguous as any wrapper.
  if (calls.length === 0) {
    const re = new RegExp(
      `<(${
        known.map((k) => k.replace(/\W/g, "")).join("|")
      })>([\\s\\S]*?)</\\1>`,
      "g",
    );
    rest = rest.replace(re, (m, name: string, body: string) => {
      const call = callFromTag(name, body.trim());
      if (!call) return m;
      calls.push(call);
      return "";
    });
  }
  // Bare `<function=…>` without the wrapper — Qwen3-Coder does this too.
  if (calls.length === 0 && /<function=[^>]+>/.test(rest)) {
    const found = callsFromFunctionXml(rest, known);
    if (found.length) {
      calls.push(...found);
      rest = rest.replace(/<function=[^>]+>[\s\S]*?(?:<\/function>|$)/g, "");
    }
  }
  if (calls.length === 0) {
    // Untagged JSON, only as the very end of the reply: a fenced block or a
    // bare object/list.
    const fence =
      /```(?:json|tool_call|tool_code|javascript)?\s*\n?([\s\S]*?)```\s*$/i
        .exec(rest);
    if (fence) {
      const found = callsFromJson(fence[1], known);
      if (found.length) {
        calls.push(...found);
        rest = rest.slice(0, fence.index);
      }
    } else {
      const tail = trailingJson(rest);
      if (tail) {
        const found = callsFromJson(tail.json, known);
        if (found.length) {
          calls.push(...found);
          rest = rest.slice(0, tail.start);
        }
      }
    }
  }
  // A call written twice in one reply is one intent.
  const seen = new Set<string>();
  const unique = calls.filter((c) => {
    const k = `${c.name}\u0000${c.args}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return { calls: unique, text: unique.length ? rest.trim() : text };
}
