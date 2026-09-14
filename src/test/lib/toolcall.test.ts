/**
 * Making a weak model's tool calls land: other harnesses' names and keys,
 * almost-JSON, and calls written into the reply as text. The properties that
 * matter are the two halves of one promise — every call the model meant is
 * understood, and nothing it did not mean is ever executed.
 */
import { assertEquals } from "@std/assert";
import {
  canonicalArgs,
  canonicalName,
  normalizeCall,
  parseArgs,
  recoverToolCalls,
} from "../../lib/toolcall.ts";
import { TOOL_NAMES } from "../../lib/agent.ts";

Deno.test("canonicalName — other harnesses' names are one intent", () => {
  const cases: [string, string][] = [
    ["read", "read"],
    ["Read", "read"],
    ["read_file", "read"],
    ["ReadFile", "read"],
    ["functions.read", "read"],
    ["default_api:read_file", "read"],
    ["Bash", "sh"],
    ["run_terminal_cmd", "sh"],
    ["TodoWrite", "todo"],
    ["str_replace_editor", "edit"],
    ["list_dir", "ls"],
    ["search_files", "grep"],
    ["find_files", "glob"],
  ];
  for (const [raw, want] of cases) {
    assertEquals(canonicalName(raw, TOOL_NAMES), want, raw);
  }
  // An unknown name stays unknown — the refusal lists the real ones.
  assertEquals(canonicalName("teleport", TOOL_NAMES), "teleport");
  // An alias to a tool the list does not know is not an alias.
  assertEquals(canonicalName("bash", ["read"]), "bash");
});

Deno.test("canonicalArgs — other harnesses' keys, and the unambiguous coercions", () => {
  assertEquals(canonicalArgs("read", { file_path: "a.ts", offset: "10" }), {
    path: "a.ts",
    offset: 10,
    limit: undefined,
  });
  // A line range as start and end.
  assertEquals(
    canonicalArgs("read", { path: "a", start_line: 5, end_line: 9 }).limit,
    5,
  );
  assertEquals(
    canonicalArgs("edit", {
      filePath: "a",
      oldString: "x",
      newString: "y",
      replaceAll: "true",
    }),
    { path: "a", old_string: "x", new_string: "y", replace_all: true },
  );
  assertEquals(
    canonicalArgs("sh", { command: ["npm ci", "npm test"] }).cmd,
    "npm ci && npm test",
  );
  assertEquals(
    canonicalArgs("todo", { todos: '[{"content":"a","status":"pending"}]' })
      .items,
    [{ content: "a", status: "pending" }],
  );
  // Our own spelling always wins over an alias sent beside it.
  assertEquals(
    canonicalArgs("read", { path: "mine", file_path: "theirs" }).path,
    "mine",
  );
});

Deno.test("parseArgs — repairs what is safe, refuses what is cut off", () => {
  assertEquals(parseArgs(""), { ok: true, args: {} });
  assertEquals(parseArgs('{"path":"a"}'), { ok: true, args: { path: "a" } });
  // Double-encoded.
  assertEquals(parseArgs(JSON.stringify('{"path":"a"}')), {
    ok: true,
    args: { path: "a" },
  });
  // A raw newline typed into a string — the commonest broken write.
  assertEquals(parseArgs('{"path":"a","content":"line1\nline2"}'), {
    ok: true,
    args: { path: "a", content: "line1\nline2" },
  });
  // Trailing comma, and a fence around the lot.
  assertEquals(parseArgs('```json\n{"path":"a",}\n```'), {
    ok: true,
    args: { path: "a" },
  });
  // A missing final brace is closed — unless the reply hit the output limit,
  // when "closing" it would run a shorter command than the one intended.
  assertEquals(parseArgs('{"cmd":"ls"'), { ok: true, args: { cmd: "ls" } });
  assertEquals(parseArgs('{"cmd":"rm -rf buil', true), { ok: false });
  // Python-style, from models that learned calls from Python.
  assertEquals(parseArgs("{'path': 'a', 'x': True}"), {
    ok: true,
    args: { path: "a", x: true },
  });
  // A bare string is kept as a string for normalizeCall to place.
  assertEquals(parseArgs('"src/a.ts"'), { ok: true, args: "src/a.ts" });
  assertEquals(parseArgs("garbage"), { ok: false });
});

Deno.test("normalizeCall — one call, in our vocabulary", () => {
  const c = normalizeCall(
    { id: "1", name: "Bash", args: '{"command":"ls -la"}' },
    TOOL_NAMES,
  );
  assertEquals(c, { id: "1", name: "sh", args: '{"cmd":"ls -la"}' });
  // A bare string goes to the tool's one obvious field.
  assertEquals(
    normalizeCall({ id: "2", name: "read", args: '"a.ts"' }, TOOL_NAMES).args,
    '{"path":"a.ts"}',
  );
  // Unparseable arguments are left for the executor's own error.
  assertEquals(
    normalizeCall({ id: "3", name: "read", args: "{{{" }, TOOL_NAMES).args,
    "{{{",
  );
});

Deno.test("recoverToolCalls — the tagged dialects local models write", () => {
  const hermes = recoverToolCalls(
    'Let me look.\n<tool_call>{"name": "read", "arguments": {"path": "a.ts"}}</tool_call>',
    TOOL_NAMES,
  );
  assertEquals(hermes.calls, [{ name: "read", args: '{"path":"a.ts"}' }]);
  assertEquals(hermes.text, "Let me look.");

  // Unclosed — the model stopped right after the object.
  assertEquals(
    recoverToolCalls('<tool_call>{"name":"ls","arguments":{}}', TOOL_NAMES)
      .calls[0].name,
    "ls",
  );

  // Qwen3-Coder XML.
  const qwen = recoverToolCalls(
    "<tool_call>\n<function=write>\n<parameter=path>\npkg.json\n</parameter>\n" +
      '<parameter=content>\n{"a": 1}\n</parameter>\n</function>\n</tool_call>',
    TOOL_NAMES,
  );
  // Values stay strings: the JSON being WRITTEN is content, not arguments.
  assertEquals(JSON.parse(qwen.calls[0].args), {
    path: "pkg.json",
    content: '{"a": 1}',
  });

  // GLM arg keys.
  const glm = recoverToolCalls(
    "<tool_call>grep<arg_key>pattern</arg_key><arg_value>TODO</arg_value></tool_call>",
    TOOL_NAMES,
  );
  assertEquals(glm.calls, [{ name: "grep", args: '{"pattern":"TODO"}' }]);

  // LM Studio's own format, and Mistral's.
  assertEquals(
    recoverToolCalls(
      '[TOOL_REQUEST]{"name":"glob","arguments":{"pattern":"*.ts"}}[END_TOOL_REQUEST]',
      TOOL_NAMES,
    ).calls[0].name,
    "glob",
  );
  assertEquals(
    recoverToolCalls(
      '[TOOL_CALLS][{"name":"ls","arguments":{"path":"src"}}]',
      TOOL_NAMES,
    ).calls,
    [{ name: "ls", args: '{"path":"src"}' }],
  );

  // Several blocks in one reply, and the same one twice is one intent.
  const many = recoverToolCalls(
    '<tool_call>{"name":"read","arguments":{"path":"a"}}</tool_call>' +
      '<tool_call>{"name":"read","arguments":{"path":"b"}}</tool_call>' +
      '<tool_call>{"name":"read","arguments":{"path":"a"}}</tool_call>',
    TOOL_NAMES,
  );
  assertEquals(many.calls.length, 2);
});

Deno.test("recoverToolCalls — untagged JSON only when it ends the reply", () => {
  // A model making a call stops after it.
  const fenced = recoverToolCalls(
    'I will list the files.\n```json\n{"name": "ls", "arguments": {"path": "."}}\n```',
    TOOL_NAMES,
  );
  assertEquals(fenced.calls.length, 1);
  assertEquals(fenced.text, "I will list the files.");
  const bare = recoverToolCalls(
    '{"name": "read", "parameters": {"path": "x"}}',
    TOOL_NAMES,
  );
  assertEquals(bare.calls, [{ name: "read", args: '{"path":"x"}' }]);

  // A model EXPLAINING a call writes prose after it — never executed.
  const example = recoverToolCalls(
    'You could call:\n```json\n{"name": "sh", "arguments": {"cmd": "rm -rf ."}}\n```\nbut I would not.',
    TOOL_NAMES,
  );
  assertEquals(example.calls, []);
  // JSON that is not a call to a known tool is just JSON.
  assertEquals(
    recoverToolCalls('{"name": "my-app", "version": "1.0.0"}', TOOL_NAMES)
      .calls,
    [],
  );
  assertEquals(
    recoverToolCalls(
      '<tool_call>{"name":"teleport","arguments":{}}</tool_call>',
      TOOL_NAMES,
    )
      .calls,
    [],
  );
  // Plain prose is untouched.
  const plain = recoverToolCalls("The answer is 42.", TOOL_NAMES);
  assertEquals(plain, { calls: [], text: "The answer is 42." });
});

Deno.test("Claude Code's spellings of background and leaving the sandbox are ours", () => {
  assertEquals(
    canonicalArgs("sh", {
      command: "npm run dev",
      run_in_background: true,
      dangerouslyDisableSandbox: "true",
    }),
    {
      cmd: "npm run dev",
      background: true,
      outside_sandbox: true,
      timeout: undefined,
    },
  );
  assertEquals(
    canonicalArgs("sh", { cmd: "x", sandbox: false }).outside_sandbox,
    true,
  );
  assertEquals(canonicalArgs("sh", { cmd: "x" }).outside_sandbox, undefined);
});
