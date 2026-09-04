/**
 * The local agent loop against a real HTTP server speaking the OpenAI chat
 * protocol — streamed SSE, tool calls, the lot. The stub is scripted per test:
 * each request pops the next canned completion, which is exactly how a
 * conversation with a real llama.cpp/Ollama/LM Studio server unfolds.
 */
import { assert, assertEquals } from "@std/assert";
import { bootCells } from "aio/testing";
import { engineOf, local, localChat, localConfig } from "../../cell/local.ts";
import { workspace } from "../../cell/workspace.ts";

type Scripted = {
  text?: string;
  toolCalls?: { id: string; name: string; args: string }[];
  /** Override the final `finish_reason` — "length" is a reply the server cut
   *  off at the output limit, which reads as a model that trailed off. */
  finish?: string;
};

/** SSE body for one scripted completion, split into several chunks the way a
 *  real server streams them. */
function sse(s: Scripted): string {
  const chunks: unknown[] = [];
  for (const piece of (s.text ?? "").match(/.{1,5}/gs) ?? []) {
    chunks.push({ choices: [{ delta: { content: piece } }] });
  }
  (s.toolCalls ?? []).forEach((c, i) => {
    chunks.push({
      choices: [{
        delta: {
          tool_calls: [{
            index: i,
            id: c.id,
            function: { name: c.name, arguments: "" },
          }],
        },
      }],
    });
    chunks.push({
      choices: [{
        delta: {
          tool_calls: [{ index: i, function: { arguments: c.args } }],
        },
      }],
    });
  });
  chunks.push({
    choices: [{
      delta: {},
      finish_reason: s.finish ?? (s.toolCalls?.length ? "tool_calls" : "stop"),
    }],
  });
  chunks.push({ choices: [], usage: { prompt_tokens: 42 } });
  return chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") +
    "data: [DONE]\n\n";
}

/** A scratch project on a scripted engine; hands back the project id and the
 *  requests the server saw. */
async function withEngine(
  script: Scripted[],
  run: (id: string, requests: unknown[]) => Promise<void>,
): Promise<void> {
  const requests: unknown[] = [];
  const queue = [...script];
  const server = Deno.serve(
    { port: 0, onListen: () => {} },
    async (req) => {
      const url = new URL(req.url);
      if (url.pathname === "/v1/models") {
        return Response.json({ data: [{ id: "test-model" }] });
      }
      if (url.pathname === "/v1/chat/completions") {
        requests.push(await req.json());
        const next = queue.shift() ?? { text: "(script exhausted)" };
        return new Response(sse(next), {
          headers: { "content-type": "text/event-stream" },
        });
      }
      return new Response("not found", { status: 404 });
    },
  );

  const h = await bootCells([workspace, local]);
  const dir = await Deno.makeTempDir();
  try {
    // Added by path and resolved by path: `activeId` can lag when boot's own
    // bootstrap dispatches race the test's addProject.
    let id = "";
    for (let tries = 0; tries < 3 && !id; tries++) {
      await workspace.addProject(dir);
      id = workspace.projects.find((p) => p.path === dir)?.id ?? "";
    }
    if (!id) throw new Error("test project never landed in the workspace");
    // Awaited, all three: a dispatch that has not committed is invisible to
    // the next one, so firing these side by side let `refreshModels` read the
    // engine as "claude" and return early.
    //
    // Retried, and the retry is the point of this comment.
    //
    // These are three AWAITED dispatches, the last of which is asserted, and
    // the config still comes back at its initial values about one run in five:
    // engine "claude", no address, no model — every write gone, not reordered.
    // A sync method's write cannot be lost to an await, so what lands in the
    // middle is a RESET, and the only thing that resets these cells is the
    // harness. The whole suite shares one process, and a previous file's boot
    // or teardown finishing late is enough.
    //
    // This is setup, not the thing under test. Retrying the arrangement is
    // honest; leaving every test that uses this helper flaky is not. The
    // message below is what a real regression would look like.
    for (let attempt = 0; attempt < 3; attempt++) {
      await local.setEngine(id, "llamacpp");
      await local.setBaseUrl(id, `http://localhost:${server.addr.port}`);
      await local.refreshModels(id);
      if (localConfig(id).model === "test-model") break;
    }
    assertEquals(
      localConfig(id).model,
      "test-model",
      `engine setup never landed: ${JSON.stringify(localConfig(id))}`,
    );
    await run(id, requests);
  } finally {
    h.dispose();
    await server.shutdown();
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("chat mode: a streamed reply lands as one assistant message", async () => {
  await withEngine([{ text: "Hello from the stub." }], async (id, requests) => {
    await local.setMode(id, "chat");
    await local.send("hi", id);
    const chat = localChat(id);
    assertEquals(chat.status, "idle");
    assertEquals(chat.error, null);
    const last = chat.messages[chat.messages.length - 1];
    assertEquals(last.role, "assistant");
    assertEquals(last.text, "Hello from the stub.");
    assertEquals(chat.usedTokens, 42); // measured, not estimated
    // Chat mode sends no tool schemas — they would be paid-for noise.
    const req = requests[0] as { tools?: unknown[] };
    assertEquals(req.tools, undefined);
  });
});

Deno.test("agent mode: a tool call executes for real and feeds back", async () => {
  await withEngine([
    {
      toolCalls: [{
        id: "c1",
        name: "read",
        args: JSON.stringify({ path: "notes.txt" }),
      }],
    },
    { text: "The file says: hello-from-disk" },
  ], async (id, requests) => {
    const dir = workspace.projects.find((p) => p.id === id)!.path;
    await Deno.writeTextFile(`${dir}/notes.txt`, "hello-from-disk\n");
    await local.setMode(id, "agent");
    await local.send("what is in notes.txt?", id);

    const chat = localChat(id);
    assertEquals(chat.error, null);
    const roles = chat.messages.map((m) => m.role);
    assertEquals(roles, ["user", "assistant", "tool", "assistant"]);
    assert(chat.messages[2].text.includes("hello-from-disk"));
    assertEquals(chat.messages[3].text, "The file says: hello-from-disk");
    // The second request carried the tool result back to the model.
    const second = requests[1] as { messages: { role: string }[] };
    assertEquals(second.messages.some((m) => m.role === "tool"), true);
  });
});

Deno.test("read-only mode refuses a write, in words the model can act on", async () => {
  await withEngine([
    {
      toolCalls: [{
        id: "c1",
        name: "write",
        args: JSON.stringify({ path: "hack.txt", content: "x" }),
      }],
    },
    { text: "Understood, I cannot write." },
  ], async (id) => {
    const dir = workspace.projects.find((p) => p.id === id)!.path;
    await local.setMode(id, "read");
    await local.send("write something", id);

    const chat = localChat(id);
    const toolMsg = chat.messages.find((m) => m.role === "tool")!;
    assert(toolMsg.text.includes("not available in read mode"));
    // And nothing touched the disk.
    assertEquals(
      await Deno.stat(`${dir}/hack.txt`).then(() => true).catch(() => false),
      false,
    );
  });
});

Deno.test("a path outside the project is refused at the boundary", async () => {
  await withEngine([
    {
      toolCalls: [{
        id: "c1",
        name: "read",
        args: JSON.stringify({ path: "../../etc/passwd" }),
      }],
    },
    { text: "ok" },
  ], async (id) => {
    await local.setMode(id, "agent");
    await local.send("read that", id);
    const toolMsg = localChat(id).messages.find((m) => m.role === "tool")!;
    assert(toolMsg.text.includes("outside the project"));
  });
});

Deno.test("a project on the Claude engine never reaches the local loop", async () => {
  await withEngine(
    [{ text: "should never be requested" }],
    async (id, requests) => {
      await local.setEngine(id, "claude");
      assertEquals(engineOf(id), "claude");
      await local.send("hi", id);
      assertEquals(localChat(id).messages.length, 0);
      assertEquals(requests.length, 0);
    },
  );
});

Deno.test("an unreachable server becomes an error on the page, not a hang", async () => {
  const h = await bootCells([workspace, local]);
  const dir = await Deno.makeTempDir();
  try {
    await workspace.addProject(dir);
    const id = workspace.activeId;
    await local.setEngine(id, "ollama");
    await local.setBaseUrl(id, "http://localhost:1"); // nothing listens here
    await local.setModel(id, "some-model");
    await local.send("hi", id);
    const chat = localChat(id);
    assertEquals(chat.status, "idle");
    assert(chat.error !== null);
  } finally {
    h.dispose();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("engine config is closed: junk names and URLs never land", async () => {
  const h = await bootCells([workspace, local]);
  const dir = await Deno.makeTempDir();
  try {
    await workspace.addProject(dir);
    const id = workspace.activeId;
    await local.setEngine(id, "gpt-cloud" as never);
    assertEquals(engineOf(id), "claude");
    await local.setEngine(id, "ollama");
    await local.setBaseUrl(id, "not a url");
    assertEquals(localConfig(id).baseUrl, "http://localhost:11434");
    await local.setCtx(id, 7);
    assertEquals(localConfig(id).ctx, 4_096); // clamped, not rejected
  } finally {
    h.dispose();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a symlink out of the project is caught, even in read mode", async () => {
  await withEngine([
    {
      toolCalls: [{
        id: "c1",
        name: "read",
        args: JSON.stringify({ path: "escape/passwd" }),
      }],
    },
    { text: "ok" },
  ], async (id) => {
    const dir = workspace.projects.find((p) => p.id === id)!.path;
    // The exact shape this repo itself has: a symlink inside pointing out.
    await Deno.symlink("/etc", `${dir}/escape`);
    await local.setMode(id, "read");
    await local.send("read that", id);
    const toolMsg = localChat(id).messages.find((m) => m.role === "tool")!;
    assert(toolMsg.text.includes("outside the project"), toolMsg.text);
  });
});

Deno.test("sh runs for real: output, exit code, and a hard output cap", async () => {
  await withEngine([
    {
      toolCalls: [{
        id: "c1",
        name: "sh",
        args: JSON.stringify({ cmd: "echo hello-sh; exit 3" }),
      }],
    },
    { text: "ran it" },
    {
      toolCalls: [{
        id: "c2",
        name: "sh",
        args: JSON.stringify({ cmd: "head -c 400000 /dev/zero | tr '\\0' x" }),
      }],
    },
    { text: "flooded" },
  ], async (id) => {
    await local.setMode(id, "agent");
    await local.setPermission(id, "bypass"); // approvals have tests of their own
    await local.send("run echo", id);
    const first = localChat(id).messages.find((m) => m.role === "tool")!;
    assert(first.text.includes("hello-sh"), first.text);
    assert(first.text.includes("[exit 3]"), first.text);

    await local.send("flood me", id);
    const tools = localChat(id).messages.filter((m) => m.role === "tool");
    const flood = tools[tools.length - 1];
    // Capped while reading, then clipped for the packer — a firehose comes
    // back as a bounded page, never a buffered gigabyte.
    assert(flood.text.length < 7_000, `len ${flood.text.length}`);
    assert(flood.text.includes("truncated"), flood.text.slice(-200));
  });
});

Deno.test("a runaway model hits the round cap and says so", async () => {
  // A model that never stops calling. The cap holds, the reader is told, and
  // the calls from the final round — for which no tools were offered — are
  // not run: the turn has no rounds left to spend on them.
  const always = Array.from({ length: 24 }, (_, i) => ({
    toolCalls: [{ id: `r${i}`, name: "ls", args: "{}" }],
  }));
  await withEngine(always, async (id, requests) => {
    await local.setMode(id, "read");
    await local.send("loop forever", id);
    const chat = localChat(id);
    assertEquals(chat.status, "idle");
    assert(chat.error?.includes("tool limit"), chat.error ?? "(null)");
    assertEquals(requests.length, 24);
    assertEquals((requests[23] as { tools?: unknown[] }).tools, undefined);
    assertEquals(chat.messages.filter((m) => m.role === "tool").length, 23);
  });
});

Deno.test("an invalid regex comes back as words, not a crash", async () => {
  await withEngine([
    {
      toolCalls: [{
        id: "c1",
        name: "grep",
        args: JSON.stringify({ pattern: "([" }),
      }],
    },
    { text: "ok" },
  ], async (id) => {
    await local.setMode(id, "read");
    await local.send("grep that", id);
    const toolMsg = localChat(id).messages.find((m) => m.role === "tool")!;
    assert(toolMsg.text.includes("not a valid regular expression"));
  });
});

Deno.test("overflow folds old turns into the summary and marks them evicted", async () => {
  const big = "lorem ipsum dolor sit amet ".repeat(600); // ~4k tokens
  await withEngine([
    { text: "first answer. " + big },
    { text: "A compact summary of what happened so far." }, // the summarize call
    { text: "second answer" },
  ], async (id) => {
    await local.setMode(id, "chat");
    await local.setCtx(id, 4_096); // the floor — forces packing to evict
    await local.send(big, id);
    await local.send("and now?", id);
    const chat = localChat(id);
    assertEquals(chat.error, null);
    assert(chat.summary.includes("compact summary"), chat.summary);
    assert(chat.messages.some((m) => m.evicted), "nothing marked evicted");
    // The evicted rows are still on screen — the user's history is not the
    // model's context.
    assertEquals(chat.messages[0].text, big);
  });
});

Deno.test("stop aborts a stream that will never end", async () => {
  const server = Deno.serve({ port: 0, onListen: () => {} }, (req) => {
    if (new URL(req.url).pathname === "/v1/models") {
      return Response.json({ data: [{ id: "m" }] });
    }
    // A stream that says one word and then stalls forever.
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode(
          'data: {"choices":[{"delta":{"content":"thinking"}}]}\n\n',
        ));
        // …and never closes.
      },
    });
    return new Response(body, {
      headers: { "content-type": "text/event-stream" },
    });
  });
  const h = await bootCells([workspace, local]);
  const dir = await Deno.makeTempDir();
  try {
    // Added by path and resolved by path: `activeId` can lag when boot's own
    // bootstrap dispatches race the test's addProject.
    let id = "";
    for (let tries = 0; tries < 3 && !id; tries++) {
      await workspace.addProject(dir);
      id = workspace.projects.find((p) => p.path === dir)?.id ?? "";
    }
    if (!id) throw new Error("test project never landed in the workspace");
    await local.setEngine(id, "llamacpp");
    await local.setBaseUrl(id, `http://localhost:${server.addr.port}`);
    await local.setModel(id, "m");
    const turn = local.send("hang me", id);
    // Give the stream time to open and deliver its one chunk.
    await new Promise((r) => setTimeout(r, 300));
    await local.stop(id);
    await turn;
    const chat = localChat(id);
    assertEquals(chat.status, "idle");
    assert(
      chat.messages.some((m) => m.text.includes("(stopped)")),
      "no stopped marker",
    );
  } finally {
    h.dispose();
    await server.shutdown();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a junk base URL fails out loud", async () => {
  const h = await bootCells([workspace, local]);
  const dir = await Deno.makeTempDir();
  try {
    await workspace.addProject(dir);
    const id = workspace.activeId;
    await local.setEngine(id, "ollama");
    await local.setBaseUrl(id, "not a url");
    assertEquals(localConfig(id).baseUrl, "http://localhost:11434");
    assert(localChat(id).error?.includes("Not a server address"));
  } finally {
    h.dispose();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a catastrophic regex is refused before it can wedge the process", async () => {
  await withEngine([
    {
      toolCalls: [{
        id: "c1",
        name: "grep",
        args: JSON.stringify({ pattern: "(a+)+b" }),
      }],
    },
    { text: "ok" },
  ], async (id) => {
    await local.setMode(id, "read");
    const before = Date.now();
    await local.send("grep the bomb", id);
    assert(Date.now() - before < 5_000, "took too long — pattern ran?");
    const toolMsg = localChat(id).messages.find((m) => m.role === "tool")!;
    assert(toolMsg.text.includes("too complex"), toolMsg.text);
  });
});

Deno.test("write refuses a dangling symlink pointing out of the project", async () => {
  const outside = await Deno.makeTempDir();
  await withEngine([
    {
      toolCalls: [{
        id: "c1",
        name: "write",
        args: JSON.stringify({ path: "sneaky", content: "escaped!" }),
      }],
    },
    { text: "ok" },
  ], async (id) => {
    const dir = workspace.projects.find((p) => p.id === id)!.path;
    // Dangling: the target does not exist, so realPath cannot judge it — the
    // write itself would create the file *outside* the project.
    await Deno.symlink(`${outside}/escaped.txt`, `${dir}/sneaky`);
    await local.setMode(id, "agent");
    await local.send("write it", id);
    const toolMsg = localChat(id).messages.find((m) => m.role === "tool")!;
    assert(toolMsg.text.includes("symlink"), toolMsg.text);
    assertEquals(
      await Deno.stat(`${outside}/escaped.txt`).then(() => true).catch(() =>
        false
      ),
      false,
      "the write escaped",
    );
  }).finally(() => Deno.remove(outside, { recursive: true }));
});

Deno.test("a command that escapes its process group cannot hang the turn", async () => {
  Deno.env.set("CC_SH_TIMEOUT_MS", "500");
  try {
    await withEngine([
      {
        toolCalls: [{
          id: "c1",
          name: "sh",
          // The worst measured shape: a child in a NEW session survives the
          // group kill and keeps our stdout pipe open for 30 more seconds.
          args: JSON.stringify({ cmd: "setsid sleep 30 & sleep 30" }),
        }],
      },
      { text: "survived" },
    ], async (id) => {
      await local.setMode(id, "agent");
      await local.setPermission(id, "bypass");
      const before = Date.now();
      await local.send("hang me", id);
      const elapsed = Date.now() - before;
      assert(elapsed < 10_000, `turn took ${elapsed}ms — pipe held hostage`);
      const toolMsg = localChat(id).messages.find((m) => m.role === "tool")!;
      assert(toolMsg.text.includes("[killed after 0.5s]"), toolMsg.text);
      assertEquals(localChat(id).status, "idle");
    });
  } finally {
    Deno.env.delete("CC_SH_TIMEOUT_MS");
  }
});

Deno.test("a server that goes silent mid-stream fails the turn with a reason", async () => {
  Deno.env.set("CC_STREAM_IDLE_MS", "300");
  const server = Deno.serve({ port: 0, onListen: () => {} }, (req) => {
    if (new URL(req.url).pathname === "/v1/models") {
      return Response.json({ data: [{ id: "m" }] });
    }
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode(
          'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
        ));
        // …then silence, forever.
      },
    });
    return new Response(body, {
      headers: { "content-type": "text/event-stream" },
    });
  });
  const h = await bootCells([workspace, local]);
  const dir = await Deno.makeTempDir();
  try {
    await workspace.addProject(dir);
    const id = workspace.activeId;
    await local.setEngine(id, "llamacpp");
    await local.setBaseUrl(id, `http://localhost:${server.addr.port}`);
    await local.setModel(id, "m");
    const before = Date.now();
    await local.send("hello", id);
    assert(Date.now() - before < 5_000, "watchdog never fired");
    const chat = localChat(id);
    assertEquals(chat.status, "idle");
    assert(chat.error !== null && /silent/i.test(chat.error), chat.error ?? "");
  } finally {
    Deno.env.delete("CC_STREAM_IDLE_MS");
    h.dispose();
    await server.shutdown();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("grep finds real matches through the worker", async () => {
  await withEngine([
    {
      toolCalls: [{
        id: "c1",
        name: "grep",
        args: JSON.stringify({ pattern: "needle" }),
      }],
    },
    { text: "found it" },
  ], async (id) => {
    const dir = workspace.projects.find((p) => p.id === id)!.path;
    await Deno.writeTextFile(`${dir}/a.txt`, "hay\nthe needle is here\nhay\n");
    await Deno.writeTextFile(`${dir}/b.txt`, "nothing\n");
    await local.setMode(id, "read");
    await local.send("grep needle", id);
    const toolMsg = localChat(id).messages.find((m) => m.role === "tool")!;
    assert(toolMsg.text.includes("a.txt:2"), toolMsg.text);
    assert(toolMsg.text.includes("needle is here"), toolMsg.text);
  });
});

Deno.test("a polynomial pattern that slips the static gate is killed by the deadline", async () => {
  // `.*.*.*.*.*.*.*x` passes safePattern (no group, 7 quantifiers) but is
  // degree-7 backtracking — exactly the round-24 hole. The worker deadline is
  // the guarantee the heuristic cannot give.
  const { safePattern } = await import("../../lib/agent.ts");
  assertEquals(safePattern(".*.*.*.*.*.*.*x"), true); // slips the static gate
  Deno.env.set("CC_GREP_DEADLINE_MS", "400");
  try {
    await withEngine([
      {
        toolCalls: [{
          id: "c1",
          name: "grep",
          args: JSON.stringify({ pattern: ".*.*.*.*.*.*.*x" }),
        }],
      },
      { text: "ok" },
    ], async (id) => {
      const dir = workspace.projects.find((p) => p.id === id)!.path;
      // A long non-matching line is what makes the backtracking bite.
      await Deno.writeTextFile(`${dir}/big.txt`, "a".repeat(400) + "\n");
      await local.setMode(id, "read");
      const before = Date.now();
      await local.send("grep the bomb", id);
      const elapsed = Date.now() - before;
      assert(elapsed < 5_000, `turn took ${elapsed}ms — regex was not bounded`);
      const toolMsg = localChat(id).messages.find((m) => m.role === "tool")!;
      assert(toolMsg.text.includes("took too long"), toolMsg.text);
      assertEquals(localChat(id).status, "idle");
    });
  } finally {
    Deno.env.delete("CC_GREP_DEADLINE_MS");
  }
});

Deno.test("grep stops at an aggregate size budget, not just per-file", async () => {
  Deno.env.set("CC_GREP_DEADLINE_MS", "2000");
  try {
    await withEngine([
      {
        toolCalls: [{
          id: "c1",
          name: "grep",
          args: JSON.stringify({ pattern: "zzz-no-match" }),
        }],
      },
      { text: "ok" },
    ], async (id) => {
      const dir = workspace.projects.find((p) => p.id === id)!.path;
      // Enough files, each near the per-file cap, to blow past the 48MB
      // aggregate budget — the parent must stop collecting, not accumulate all.
      const big = "x".repeat(500_000) + "\n";
      for (let i = 0; i < 120; i++) {
        await Deno.writeTextFile(`${dir}/f${i}.txt`, big);
      }
      await local.setMode(id, "read");
      const before = Date.now();
      await local.send("grep everything", id);
      assert(Date.now() - before < 8_000, "took too long — no budget");
      const toolMsg = localChat(id).messages.find((m) => m.role === "tool")!;
      assert(toolMsg.text.includes("size budget"), toolMsg.text);
      assertEquals(localChat(id).status, "idle");
    });
  } finally {
    Deno.env.delete("CC_GREP_DEADLINE_MS");
  }
});

/* ── detection ────────────────────────────────────────────────────────────── */

/**
 * The context window is the one number a small-context agent lives or dies by,
 * and it used to be a value the user had to look up in a launch flag and type.
 * Each engine reports it somewhere different and none of them in the
 * OpenAI-compatible surface, so each shape gets its own test against a stub
 * that answers exactly the way that engine does.
 */
Deno.test("the context window is read from each engine's own endpoint", async () => {
  const io = await import("../../cell/local.server.ts");
  const server = Deno.serve({ port: 0, onListen: () => {} }, async (req) => {
    const url = new URL(req.url);
    // llama.cpp: the window is a launch flag, reported on /props.
    if (url.pathname === "/props") {
      return Response.json({
        default_generation_settings: { n_ctx: 65_536 },
      });
    }
    // Ollama: architecture-scoped key inside model_info.
    if (url.pathname === "/api/show") {
      const body = await req.json();
      return Response.json({
        model_info: {
          "qwen2.context_length": body.model === "big" ? 131_072 : 8_192,
        },
      });
    }
    // LM Studio: its own listing, with the loaded length beside the maximum.
    if (url.pathname === "/api/v0/models") {
      return Response.json({
        data: [
          {
            id: "loaded",
            max_context_length: 262_144,
            loaded_context_length: 16_384,
          },
          { id: "cold", max_context_length: 32_768 },
        ],
      });
    }
    return new Response("not found", { status: 404 });
  });
  const base = `http://localhost:${server.addr.port}`;
  try {
    assertEquals(await io.probeContext("llamacpp", base, "any"), 65_536);
    assertEquals(await io.probeContext("ollama", base, "big"), 131_072);
    assertEquals(await io.probeContext("ollama", base, "small"), 8_192);
    // The length it is LOADED at, not the maximum it could take — the loaded
    // one is what a request over it is refused against.
    assertEquals(await io.probeContext("lmstudio", base, "loaded"), 16_384);
    assertEquals(await io.probeContext("lmstudio", base, "cold"), 32_768);
    // A model the server does not have is not an error, and not a guess.
    assertEquals(await io.probeContext("lmstudio", base, "absent"), null);
  } finally {
    await server.shutdown();
  }
});

Deno.test("a server that says nothing about its window leaves the setting alone", async () => {
  const io = await import("../../cell/local.server.ts");
  const server = Deno.serve(
    { port: 0, onListen: () => {} },
    () => new Response("not found", { status: 404 }),
  );
  const base = `http://localhost:${server.addr.port}`;
  try {
    assertEquals(await io.probeContext("llamacpp", base, "m"), null);
    assertEquals(await io.probeContext("ollama", base, "m"), null);
    assertEquals(await io.probeContext("lmstudio", base, "m"), null);
    // Nothing listening at all is the same answer, not a thrown error: a scan
    // of three ports must survive all three being closed.
    assertEquals(
      await io.probeContext("llamacpp", "http://localhost:1", "m"),
      null,
    );
  } finally {
    await server.shutdown();
  }
});

Deno.test("detection never invents a server", async () => {
  const io = await import("../../cell/local.server.ts");
  const found = await io.detectEngines();
  // All three engines are always reported — the switch lists them either way,
  // and "not running" is an answer the user needs as much as "running".
  assertEquals(found.length, 3);
  assertEquals(
    found.map((f) => f.engine).sort(),
    ["llamacpp", "lmstudio", "ollama"],
  );
  for (const f of found) {
    // Reachable is only ever claimed on the strength of a reply, and an
    // unreachable engine offers no models.
    if (!f.reachable) assertEquals(f.models.length, 0);
    assertEquals(f.baseUrl.startsWith("http://localhost:"), true);
  }
});

Deno.test("a typed context window is never overwritten by detection", async () => {
  const h = await bootCells([workspace, local]);
  const dir = await Deno.makeTempDir();
  const server = Deno.serve(
    { port: 0, onListen: () => {} },
    (req) =>
      new URL(req.url).pathname === "/props"
        ? Response.json({ n_ctx: 65_536 })
        : new Response("not found", { status: 404 }),
  );
  try {
    await workspace.addProject(dir);
    const id = workspace.activeId;
    await local.setEngine(id, "llamacpp");
    await local.setBaseUrl(id, `http://localhost:${server.addr.port}`);

    // Detection fills it in when nobody has said otherwise…
    await local.autoCtx(id);
    assertEquals(localConfig(id).ctx, 65_536);

    // …and stops the moment a human types one.
    await local.setCtx(id, 8_192);
    assertEquals(localConfig(id).ctxManual, true);
    await local.autoCtx(id, true); // the follow-up a model switch schedules
    assertEquals(localConfig(id).ctx, 8_192);

    // "Detect" hands the field back.
    await local.autoCtx(id);
    assertEquals(localConfig(id).ctxManual, false);
    assertEquals(localConfig(id).ctx, 65_536);
  } finally {
    h.dispose();
    await server.shutdown();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("picking an engine adopts what the scan already found", async () => {
  const h = await bootCells([workspace, local]);
  const dir = await Deno.makeTempDir();
  try {
    await workspace.addProject(dir);
    const id = workspace.activeId;
    // Stand in for a completed scan. `detect()` itself talks to fixed ports,
    // which is not a thing a test may assume anything about.
    await local.detect();
    const seen = local.detected.find((d) => d.reachable);
    await local.setEngine(id, "ollama");
    const cfg = localConfig(id);
    // Whatever the scan said, the engine lands on a usable address — the one
    // that answered if there was one, the documented default otherwise.
    assertEquals(cfg.engine, "ollama");
    assertEquals(cfg.baseUrl.startsWith("http://localhost:"), true);
    if (seen?.engine === "ollama" && seen.models.length > 0) {
      // …and on a model, so the project is ready to talk rather than ready to
      // be configured.
      assertEquals(seen.models.includes(cfg.model), true);
    }
  } finally {
    h.dispose();
    await Deno.remove(dir, { recursive: true });
  }
});

/* ── command approvals ────────────────────────────────────────────────────── */

/**
 * `sh` is the one tool here that cannot be confined to the project directory —
 * every other one resolves its paths inside it, symlinks included. So it is
 * bounded the honest way instead: the exact command, before it runs, with
 * somebody deciding. These pin that the turn really *blocks* on the answer,
 * because a prompt the loop races past is worse than no prompt at all.
 */
Deno.test("a command is held until it is allowed, and the turn waits", async () => {
  await withEngine([
    {
      toolCalls: [{
        id: "c1",
        name: "sh",
        args: JSON.stringify({ cmd: "echo held-then-run" }),
      }],
    },
    { text: "done" },
  ], async (id) => {
    await local.setMode(id, "agent");
    const turn = local.send("run it", id);

    // The question appears, verbatim, and nothing has run.
    await waitFor(
      () => localChat(id).pending !== null,
      4_000,
      () =>
        JSON.stringify({
          status: localChat(id).status,
          error: localChat(id).error,
          cfg: localConfig(id),
          roles: localChat(id).messages.map((m) => m.role),
        }),
    );
    assertEquals(localChat(id).pending?.cmd, "echo held-then-run");
    assertEquals(localChat(id).messages.some((m) => m.role === "tool"), false);
    assertEquals(localChat(id).status, "working");

    await local.answer(id, true);
    await turn;

    const toolMsg = localChat(id).messages.find((m) => m.role === "tool")!;
    assert(toolMsg.text.includes("held-then-run"), toolMsg.text);
    // Answering does not silently grant everything after it.
    assertEquals(localConfig(id).permission, undefined);
    assertEquals(localChat(id).pending, null);
  });
});

Deno.test("a refused command never runs, and the model is told why", async () => {
  await withEngine([
    {
      toolCalls: [{
        id: "c1",
        name: "sh",
        args: JSON.stringify({ cmd: "rm -rf /" }),
      }],
    },
    { text: "understood" },
  ], async (id) => {
    await local.setMode(id, "agent");
    const turn = local.send("go", id);
    await waitFor(() => localChat(id).pending !== null);
    await local.answer(id, false);
    await turn;

    const toolMsg = localChat(id).messages.find((m) => m.role === "tool")!;
    // A refusal is part of the conversation, not an error: the model reads it
    // and picks something else.
    assert(toolMsg.text.includes("did not allow"), toolMsg.text);
    assertEquals(localChat(id).status, "idle");
    assertEquals(localChat(id).pending, null);
  });
});

Deno.test("stop counts as a refusal — a stopped turn never runs the command", async () => {
  await withEngine([
    {
      toolCalls: [{
        id: "c1",
        name: "sh",
        args: JSON.stringify({ cmd: "echo must-not-run" }),
      }],
    },
    { text: "…" },
  ], async (id) => {
    await local.setMode(id, "agent");
    const turn = local.send("go", id);
    await waitFor(() => localChat(id).pending !== null);
    // The turn is parked on a question. Stopping it must bring the question
    // down with it, or the loop waits forever for an answer to something
    // nobody can see any more.
    await local.stop(id);
    await turn;
    assertEquals(localChat(id).status, "idle");
    assertEquals(localChat(id).pending, null);
    const ran = localChat(id).messages.some((m) =>
      m.role === "tool" && m.text.includes("must-not-run")
    );
    assertEquals(ran, false);
  });
});

Deno.test('"stop asking" applies to the project, and can be taken back', async () => {
  await withEngine([
    {
      toolCalls: [{
        id: "c1",
        name: "sh",
        args: JSON.stringify({ cmd: "echo first" }),
      }],
    },
    {
      toolCalls: [{
        id: "c2",
        name: "sh",
        args: JSON.stringify({ cmd: "echo second" }),
      }],
    },
    { text: "done" },
  ], async (id) => {
    await local.setMode(id, "agent");
    const turn = local.send("go", id);
    await waitFor(() => localChat(id).pending !== null);
    await local.answer(id, true, true);
    await turn;

    // "…and stop asking" lands on the guarded mode, not on Bypass: the button
    // says stop interrupting me, not "and delete whatever you like".
    assertEquals(localConfig(id).permission, "dontAsk");
    // The second command in the same turn ran without a second question.
    const outputs = localChat(id).messages.filter((m) => m.role === "tool");
    assertEquals(outputs.length, 2);
    assert(outputs[1].text.includes("second"), outputs[1].text);

    // …and it is one click back to being asked.
    await local.setPermission(id, "ask");
    assertEquals(localConfig(id).permission, "ask");
    // A junk value from the control plane fails closed, never open.
    await local.setPermission(id, "whatever" as never);
    assertEquals(localConfig(id).permission, "ask");
  });
});

Deno.test("read-only mode never reaches the question, because it has no sh", async () => {
  await withEngine([
    {
      toolCalls: [{
        id: "c1",
        name: "sh",
        args: JSON.stringify({ cmd: "echo nope" }),
      }],
    },
    { text: "ok" },
  ], async (id) => {
    await local.setMode(id, "read");
    await local.send("go", id);
    const toolMsg = localChat(id).messages.find((m) => m.role === "tool")!;
    // Refused by the mode gate, before anything is asked — the prompt is the
    // second line of defence, not the first.
    assert(toolMsg.text.includes("not available in read mode"), toolMsg.text);
    assertEquals(localChat(id).pending, null);
  });
});

/** Poll until `check` holds. The turn under test is deliberately parked, so
 *  there is nothing to await — only a state change to watch for. */
async function waitFor(
  check: () => boolean,
  ms = 4_000,
  describe: () => string = () => "",
): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`waitFor timed out ${describe()}`);
}

Deno.test("a llama.cpp server without --jinja is recognised before a turn fails", async () => {
  // On an OLD build `chat_format: "Content-only"` was its own name for
  // "started without --jinja": it served models and answered chats, then
  // refused every request carrying tools with an HTTP 500 — so Read-only and
  // Agent modes failed and the app looked broken. One GET settles it.
  const io = await import("../../cell/local.server.ts");
  const noTools = Deno.serve(
    { port: 0, onListen: () => {} },
    (req) =>
      new URL(req.url).pathname === "/props"
        ? Response.json({
          n_ctx: 65_536,
          default_generation_settings: {
            params: { chat_format: "Content-only" },
          },
        })
        : new Response("not found", { status: 404 }),
  );
  const withTools = Deno.serve(
    { port: 0, onListen: () => {} },
    (req) =>
      new URL(req.url).pathname === "/props"
        ? Response.json({
          n_ctx: 65_536,
          default_generation_settings: {
            params: { chat_format: "Hermes 2 Pro" },
          },
        })
        : new Response("not found", { status: 404 }),
  );
  const a = `http://localhost:${noTools.addr.port}`;
  const b = `http://localhost:${withTools.addr.port}`;
  try {
    assertEquals(await io.probeTools("llamacpp", a), false);
    assertEquals(await io.probeTools("llamacpp", b), true);
    // The other two engines decide it per model, at request time. There is no
    // honest answer to give ahead of time, so none is invented.
    assertEquals(await io.probeTools("ollama", b), null);
    assertEquals(await io.probeTools("lmstudio", b), null);
    // A server that says nothing, and a port with nothing on it, are both
    // "unknown" — never "broken".
    assertEquals(await io.probeTools("llamacpp", "http://localhost:1"), null);
  } finally {
    await noTools.shutdown();
    await withTools.shutdown();
  }
});

Deno.test("a tool call with no id still gets paired with its result", async () => {
  // Plenty of servers stream tool calls without an id. Every result then goes
  // back tagged "", which is the same tag as every other result the moment
  // two calls are made at once — and some chat templates refuse it outright.
  await withEngine([
    {
      toolCalls: [
        { id: "", name: "ls", args: "{}" },
        { id: "", name: "ls", args: '{"path":"."}' },
      ],
    },
    { text: "Two listings, two answers." },
  ], async (id, requests) => {
    await local.setMode(id, "read");
    await local.send("look twice", id);

    const second = requests[1] as {
      messages: {
        role: string;
        tool_call_id?: string;
        tool_calls?: { id: string }[];
      }[];
    };
    const asked = second.messages.find((m) => m.tool_calls)?.tool_calls ?? [];
    const answered = second.messages.filter((m) => m.role === "tool");
    assertEquals(asked.length, 2);
    assertEquals(answered.length, 2);
    // Every id is real, and the two are not the same id.
    assert(asked.every((c) => c.id.length > 0));
    assertEquals(new Set(asked.map((c) => c.id)).size, 2);
    // …and each result names the call it answers.
    assertEquals(
      answered.map((m) => m.tool_call_id).sort(),
      asked.map((c) => c.id).sort(),
    );
  });
});

Deno.test("the same read twice in one turn is answered once", async () => {
  await withEngine([
    { toolCalls: [{ id: "a", name: "ls", args: "{}" }] },
    { toolCalls: [{ id: "b", name: "ls", args: "{}" }] },
    { text: "Done." },
  ], async (id) => {
    await local.setMode(id, "read");
    await local.send("list it", id);
    const tools = localChat(id).messages.filter((m) => m.role === "tool");
    assertEquals(tools.length, 2);
    // The first is the real listing; the second says so rather than spending
    // a round to produce the identical bytes again.
    assertEquals(tools[0].text.includes("Identical to an earlier call"), false);
    assertEquals(tools[1].text.includes("Identical to an earlier call"), true);
  });
});

Deno.test("a write makes the same read a new question again", async () => {
  await withEngine([
    { toolCalls: [{ id: "a", name: "ls", args: "{}" }] },
    {
      toolCalls: [{
        id: "b",
        name: "write",
        args: '{"path":"n.txt","content":"x"}',
      }],
    },
    { toolCalls: [{ id: "c", name: "ls", args: "{}" }] },
    { text: "Made it." },
  ], async (id) => {
    await local.setMode(id, "agent");
    await local.send("make a file", id);
    const tools = localChat(id).messages.filter((m) => m.role === "tool");
    assertEquals(tools.length, 3);
    // The listing AFTER the write is run for real — it has a new file in it.
    assertEquals(tools[2].text.includes("Identical to an earlier call"), false);
    assertEquals(tools[2].text.includes("n.txt"), true);
  });
});

Deno.test("running out of tool rounds still ends in an answer", async () => {
  // Twenty-three rounds that keep calling, then the round limit: the last
  // request carries no tools, so the model has to say something. Ending a
  // turn with an error and no answer throws away all the work it just did.
  const script: Scripted[] = [];
  for (let i = 0; i < 23; i++) {
    script.push({
      toolCalls: [{ id: `t${i}`, name: "ls", args: `{"path":"${i}"}` }],
    });
  }
  script.push({ text: "I have looked enough; here is the answer." });
  await withEngine(script, async (id, requests) => {
    await local.setMode(id, "read");
    await local.send("go", id);
    const chat = localChat(id);
    const last = chat.messages[chat.messages.length - 1];
    assertEquals(last.role, "assistant");
    assertEquals(last.text, "I have looked enough; here is the answer.");
    // The last request asked for words: no schemas on the wire.
    const final = requests[requests.length - 1] as { tools?: unknown[] };
    assertEquals(final.tools, undefined);
    // …and the reader is told the limit was reached, rather than it being
    // passed off as a normal answer.
    assert(chat.error?.includes("tool limit"), chat.error ?? "no notice");
  });
});

Deno.test("a reply cut off at the output limit says so", async () => {
  await withEngine([
    { text: "I was about to say", finish: "length" },
  ], async (id) => {
    await local.setMode(id, "chat");
    await local.send("tell me everything", id);
    const chat = localChat(id);
    // The text is kept — a truncated answer is still an answer.
    assertEquals(
      chat.messages[chat.messages.length - 1].text,
      "I was about to say",
    );
    assert(chat.error?.includes("output limit"), chat.error ?? "no notice");
  });
});

Deno.test("a refusal names the tools that do exist", async () => {
  const io = await import("../../cell/local.server.ts");
  const cwd = await Deno.makeTempDir();
  try {
    // An invented name: the model corrects itself from the list, and without
    // one it invents another.
    const made = await io.runTool("read", cwd, "list_files", "{}");
    assert(made.includes("no tool called"), made);
    assert(made.includes("ls"), made);
    // A real tool in the wrong mode is a different sentence, and says which
    // tools this mode does have.
    const wrong = await io.runTool("read", cwd, "write", "{}");
    assert(wrong.includes("not available in read mode"), wrong);
    assert(wrong.includes("grep"), wrong);
    // Chat mode has none at all, and says that instead of listing nothing.
    const none = await io.runTool("chat", cwd, "ls", "{}");
    assert(none.includes("answer in words"), none);
    // Arguments cut off mid-JSON are the usual cause, and are named as such.
    const torn = await io.runTool("read", cwd, "read", '{"path":"a');
    assert(torn.includes("cut off"), torn);
  } finally {
    await Deno.remove(cwd, { recursive: true });
  }
});

Deno.test('"Don\'t ask" runs ordinary commands and refuses destructive ones', async () => {
  await withEngine([
    {
      toolCalls: [{
        id: "c1",
        name: "sh",
        args: JSON.stringify({ cmd: "echo hello" }),
      }],
    },
    {
      toolCalls: [{
        id: "c2",
        name: "sh",
        args: JSON.stringify({ cmd: "rm -rf src" }),
      }],
    },
    { text: "understood" },
  ], async (id) => {
    await local.setMode(id, "agent");
    await local.setPermission(id, "dontAsk");

    await local.send("go", id);

    // No prompt was ever raised: the whole point of the mode is that nobody is
    // interrupted.
    assertEquals(localChat(id).pending, null);
    const outputs = localChat(id).messages.filter((m) => m.role === "tool");
    assertEquals(outputs.length, 2);
    // The ordinary one ran…
    assert(outputs[0].text.includes("hello"), outputs[0].text);
    // …and the one that deletes did not. The refusal is written for the model,
    // and it names the mode that would have allowed it — so the transcript
    // tells the *user* which switch to move, too.
    assert(outputs[1].text.startsWith("Error: refused"), outputs[1].text);
    assert(outputs[1].text.includes("deletes"), outputs[1].text);
    assert(outputs[1].text.includes("Bypass"), outputs[1].text);
  });
});

Deno.test("Bypass runs what Don't ask refuses", async () => {
  await withEngine([
    {
      toolCalls: [{
        id: "c1",
        name: "sh",
        args: JSON.stringify({ cmd: "rm -f gone.txt && echo removed" }),
      }],
    },
    { text: "done" },
  ], async (id) => {
    await local.setMode(id, "agent");
    await local.setPermission(id, "bypass");

    await local.send("go", id);

    assertEquals(localChat(id).pending, null);
    const outputs = localChat(id).messages.filter((m) => m.role === "tool");
    assertEquals(outputs.length, 1);
    // No checks means no checks — that is the whole difference between the two
    // unasked modes, and it has to be real or the switch is theatre.
    assert(outputs[0].text.includes("removed"), outputs[0].text);
  });
});

Deno.test("a current llama.cpp is believed over the old heuristic", async () => {
  // Templating is on by default now (`--no-jinja` turns it off), and the
  // server reports what its loaded template can actually do. The old signal
  // did not keep up: `chat_format` here describes the server's *default*,
  // tool-free request, so reading it as a verdict called a perfectly capable
  // server tool-less and sent the user to add a flag their build has not got.
  const io = await import("../../cell/local.server.ts");
  const modern = Deno.serve(
    { port: 0, onListen: () => {} },
    (req) =>
      new URL(req.url).pathname === "/props"
        ? Response.json({
          n_ctx: 65_536,
          // Both at once — exactly what a current llama-server answers.
          chat_template_caps: {
            supports_tools: true,
            supports_tool_calls: true,
          },
          default_generation_settings: {
            params: { chat_format: "Content-only" },
          },
        })
        : new Response("not found", { status: 404 }),
  );
  // …and the same server with templating actually off still says so.
  const off = Deno.serve(
    { port: 0, onListen: () => {} },
    (req) =>
      new URL(req.url).pathname === "/props"
        ? Response.json({
          chat_template_caps: { supports_tools: false },
          default_generation_settings: {
            params: { chat_format: "Content-only" },
          },
        })
        : new Response("not found", { status: 404 }),
  );
  const a = `http://localhost:${modern.addr.port}`;
  const b = `http://localhost:${off.addr.port}`;
  try {
    assertEquals(await io.probeTools("llamacpp", a), true);
    assertEquals(await io.probeTools("llamacpp", b), false);
  } finally {
    await modern.shutdown();
    await off.shutdown();
  }
});

Deno.test("the scan finds a server on an address somebody chose", async () => {
  // A scan that only knocks on the default port can only find a server on the
  // default port. llama.cpp on 18080 — the usual reason being that something
  // else already owns 8080 — was invisible: every panel said "not scanned yet"
  // about a server that was running the whole time, and the chat said only
  // "fetch failed".
  const io = await import("../../cell/local.server.ts");
  const server = Deno.serve({ port: 0, onListen: () => {} }, (req) => {
    const p = new URL(req.url).pathname;
    if (p === "/v1/models") {
      return Response.json({ data: [{ id: "qwen-on-a-chosen-port" }] });
    }
    if (p === "/props") {
      return Response.json({ chat_template_caps: { supports_tools: true } });
    }
    return new Response("not found", { status: 404 });
  });
  const chosen = `http://localhost:${server.addr.port}`;
  try {
    // Nothing is on the defaults in this test environment's sense — what
    // matters is that the chosen address is probed at all, and wins.
    const found = await io.detectEngines(undefined, [
      { engine: "llamacpp", baseUrl: chosen },
    ]);
    const llama = found.find((f) => f.engine === "llamacpp");
    assertEquals(llama?.reachable, true);
    assertEquals(llama?.baseUrl, chosen);
    assertEquals(llama?.models, ["qwen-on-a-chosen-port"]);
    assertEquals(llama?.tools, true);

    // A trailing slash is the same address, not a second one.
    const again = await io.detectEngines(undefined, [
      { engine: "llamacpp", baseUrl: `${chosen}/` },
    ]);
    assertEquals(again.find((f) => f.engine === "llamacpp")?.baseUrl, chosen);
  } finally {
    await server.shutdown();
  }
});

Deno.test("picking an engine goes looking, and never moves a typed address", async () => {
  // The complaint this answers: "cc originally looked for 8080, so I moved the
  // server to 8080 — now it checks 18080". Picking an engine is the moment the
  // question "where is it?" is worth asking, and the app can answer it.
  const io = await import("../../cell/local.server.ts");
  const server = Deno.serve({ port: 0, onListen: () => {} }, (req) => {
    const p = new URL(req.url).pathname;
    if (p === "/v1/models") {
      return Response.json({ data: [{ id: "found-me" }] });
    }
    if (p === "/props") return Response.json({ chat_template_caps: {} });
    return new Response("not found", { status: 404 });
  });
  const chosen = `http://localhost:${server.addr.port}`;
  try {
    // An address nobody typed is the app's to correct…
    const auto = await io.detectEngines(undefined, [
      { engine: "llamacpp", baseUrl: chosen },
    ]);
    assertEquals(auto.find((f) => f.engine === "llamacpp")?.baseUrl, chosen);
  } finally {
    await server.shutdown();
  }
});

Deno.test("a hand-typed address is never moved by the finder", async () => {
  await withEngine([{ text: "hi" }], async (id) => {
    // Typing marks it. From then on the app may say a different server is
    // answering — the banner offers a button — but it must not switch by
    // itself: a project silently repointed at another model is the one
    // failure a chat app cannot recover from, because it looks like success.
    await local.setBaseUrl(id, "http://localhost:18080");
    assertEquals(localConfig(id).urlManual, true);
    const typed = localConfig(id).baseUrl;

    await local.adoptFound(id);
    assertEquals(localConfig(id).baseUrl, typed);

    // Clearing the field hands the choice back to the app.
    await local.setBaseUrl(id, "");
    assertEquals(localConfig(id).urlManual, false);
  });
});

Deno.test("a guessed port has to prove it is the engine", async () => {
  // Half of what a developer runs answers `/v1/models`, and one of the ports
  // llama.cpp is commonly moved to had an unrelated app on it on the machine
  // this was written on. Adopting that as the project's engine would be worse
  // than not finding the server at all — the chat would go somewhere nobody
  // chose and look like it worked.
  const io = await import("../../cell/local.server.ts");
  const impostor = Deno.serve({ port: 0, onListen: () => {} }, (req) => {
    const p = new URL(req.url).pathname;
    // Speaks the OpenAI shape, but is not llama.cpp: no /props identity.
    if (p === "/v1/models") {
      return Response.json({ data: [{ id: "not-llama" }] });
    }
    return new Response("not found", { status: 404 });
  });
  const real = Deno.serve({ port: 0, onListen: () => {} }, (req) => {
    const p = new URL(req.url).pathname;
    if (p === "/v1/models") {
      return Response.json({ data: [{ id: "real-llama" }] });
    }
    if (p === "/props") {
      return Response.json({ chat_template_caps: { supports_tools: true } });
    }
    return new Response("not found", { status: 404 });
  });
  try {
    // As a CONFIGURED address the impostor is taken at face value — somebody
    // typed it, and second-guessing a deliberate choice is not the app's job.
    const asked = await io.detectEngines(undefined, [{
      engine: "llamacpp",
      baseUrl: `http://localhost:${impostor.addr.port}`,
    }]);
    assertEquals(asked.find((f) => f.engine === "llamacpp")?.models, [
      "not-llama",
    ]);

    // A real one, also configured, is found with its tool answer intact.
    const good = await io.detectEngines(undefined, [{
      engine: "llamacpp",
      baseUrl: `http://localhost:${real.addr.port}`,
    }]);
    const hit = good.find((f) => f.engine === "llamacpp");
    assertEquals(hit?.models, ["real-llama"]);
    assertEquals(hit?.tools, true);
  } finally {
    await impostor.shutdown();
    await real.shutdown();
  }
});
