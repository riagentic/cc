/**
 * The local agent loop against a real HTTP server speaking the OpenAI chat
 * protocol — streamed SSE, tool calls, the lot. The stub is scripted per test:
 * each request pops the next canned completion, which is exactly how a
 * conversation with a real llama.cpp/Ollama/LM Studio server unfolds.
 */
import { assert, assertEquals } from "@std/assert";
import { bootCells } from "aio/testing";
import {
  also,
  engineOf,
  local,
  localChat,
  localConfig,
  MAX_CALLS_PER_REPLY,
  MAX_LOCAL_MESSAGES,
  MAX_ROUNDS,
  PARK_AFTER_MS,
  speedOf,
} from "../../cell/local.ts";
import { workspace } from "../../cell/workspace.ts";
import { mayLeaveUnasked, permissionOf, toolBudget } from "../../lib/agent.ts";

// Conversation temp and saved history go to throwaway roots, not the real
// app home.
Deno.env.set("CC_TMP_ROOT", await Deno.makeTempDir({ prefix: "cc-tmp-" }));
Deno.env.set(
  "CC_HISTORY_ROOT",
  await Deno.makeTempDir({ prefix: "cc-history-" }),
);

type Scripted = {
  text?: string;
  /** Reasoning, streamed the way LM Studio and llama.cpp send it. */
  reasoning?: string;
  /** Answer with this HTTP status and body instead of a stream. */
  status?: number;
  /** Wait this long before answering — time for a test to act mid-turn. */
  delayMs?: number;
  body?: string;
  toolCalls?: { id: string; name: string; args: string }[];
  /** Override the final `finish_reason` — "length" is a reply the server cut
   *  off at the output limit, which reads as a model that trailed off. */
  finish?: string;
  /** llama.cpp's `timings`, sent on the last chunk. */
  timings?: Record<string, number>;
};

/** SSE body for one scripted completion, split into several chunks the way a
 *  real server streams them. */
function sse(s: Scripted): string {
  const chunks: unknown[] = [];
  for (const piece of (s.reasoning ?? "").match(/.{1,5}/gs) ?? []) {
    chunks.push({ choices: [{ delta: { reasoning_content: piece } }] });
  }
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
  chunks.push({
    choices: [],
    usage: { prompt_tokens: 42 },
    ...(s.timings ? { timings: s.timings } : {}),
  });
  return chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") +
    "data: [DONE]\n\n";
}

/** A scratch project on a scripted engine; hands back the project id and the
 *  requests the server saw. */
async function withEngine(
  script: Scripted[],
  run: (id: string, requests: unknown[]) => Promise<void>,
  /** Extra endpoints — `/props` and friends — for tests that need the
   *  server to say something about itself. */
  routes?: (url: URL) => Response | null,
): Promise<void> {
  const requests: unknown[] = [];
  const queue = [...script];
  const server = Deno.serve(
    { port: 0, onListen: () => {} },
    async (req) => {
      const url = new URL(req.url);
      const extra = routes?.(url);
      if (extra) return extra;
      if (url.pathname === "/v1/models") {
        return Response.json({ data: [{ id: "test-model" }] });
      }
      if (url.pathname === "/v1/chat/completions") {
        requests.push(await req.json());
        const next = queue.shift() ?? { text: "(script exhausted)" };
        if (next.delayMs) {
          await new Promise((r) => setTimeout(r, next.delayMs));
        }
        if (next.status) {
          return new Response(next.body ?? "", { status: next.status });
        }
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

Deno.test("a link in the project may be read through, never written through", async () => {
  // `dep/aio → ~/.local/lib/aio-versions/…` is how a project vendors its
  // framework: the model has to read it, and did so with `sh cat` after four
  // refused reads. Writing through the link stays refused, and so does any
  // route into a credential store.
  const outside = await Deno.makeTempDir();
  await Deno.writeTextFile(`${outside}/lib.ts`, "export const x = 1;");
  await withEngine([
    {
      toolCalls: [
        { id: "r", name: "read", args: '{"path":"dep/lib.ts"}' },
        { id: "k", name: "read", args: '{"path":"keys/id_rsa"}' },
      ],
    },
    {
      toolCalls: [{
        id: "w",
        name: "write",
        args: JSON.stringify({ path: "dep/evil.ts", content: "x" }),
      }],
    },
    { text: "ok" },
  ], async (id) => {
    const dir = workspace.projects.find((p) => p.id === id)!.path;
    await Deno.symlink(outside, `${dir}/dep`);
    await Deno.symlink(`${Deno.env.get("HOME")}/.ssh`, `${dir}/keys`);
    await local.setMode(id, "agent");
    await local.send("read the vendored lib", id);
    const [read, key, wrote] = localChat(id).messages.filter((m) =>
      m.role === "tool"
    );
    assert(read.text.includes("export const x = 1;"), read.text);
    assert(key.text.includes("private"), key.text);
    assert(wrote.text.includes("writing through it is not"), wrote.text);
    assertEquals(await Deno.stat(`${outside}/evil.ts`).catch(() => null), null);
  }).finally(() => Deno.remove(outside, { recursive: true }));
});

Deno.test("a link out may not reach another project's secrets, or a home", async () => {
  // The vendored-dependency link above is the case that must keep working.
  // These are the ones that must not: a `.env` belonging to different work
  // (one conversation's transcript must not end up holding another's keys),
  // and the home directory itself, where a single grep is a search for every
  // secret the user owns.
  const other = await Deno.makeTempDir();
  await Deno.writeTextFile(`${other}/.env`, "OTHER_PROJECT_KEY=nope\n");
  await withEngine([
    {
      toolCalls: [
        { id: "e", name: "read", args: '{"path":"sibling/.env"}' },
        { id: "h", name: "grep", args: '{"pattern":"KEY","path":"home"}' },
        { id: "o", name: "read", args: '{"path":".env"}' },
      ],
    },
    { text: "ok" },
  ], async (id) => {
    const dir = workspace.projects.find((p) => p.id === id)!.path;
    await Deno.symlink(other, `${dir}/sibling`);
    await Deno.symlink(Deno.env.get("HOME")!, `${dir}/home`);
    await Deno.writeTextFile(`${dir}/.env`, "MY_OWN_KEY=fine\n");
    await local.setMode(id, "read");
    await local.send("look around", id);
    const [env, home, mine] = localChat(id).messages.filter((m) =>
      m.role === "tool"
    );
    assert(env.text.includes("private"), env.text);
    assert(!env.text.includes("OTHER_PROJECT_KEY"), env.text);
    assert(home.text.includes("private"), home.text);
    // …while the project's own .env is the project's own business.
    assert(mine.text.includes("MY_OWN_KEY=fine"), mine.text);
  }).finally(() => Deno.remove(other, { recursive: true }));
});

Deno.test(
  "the framework a project declares is readable, dotted home or not",
  async () => {
    // The shape every aio app really has: `dep/aio` is a symlink into
    // `~/.local/lib/aio-versions/<version>`, and `deno.json` names it. That
    // target has a dotted component under $HOME, so the private-area rule
    // refused all of it — docs, source, example tests. Measured on a live
    // session: twenty minutes and 88 rounds spent guessing a testing API whose
    // documentation was one read away, with fifteen refusals in the log.
    //
    // The test links into a dotted directory under the real $HOME on purpose.
    // A temp dir would pass while the thing users actually have keeps failing,
    // which is exactly how this got shipped.
    const base = `${Deno.env.get("HOME")}/.cc-boundary-test-${
      crypto.randomUUID().slice(0, 8)
    }`;
    const store = `${base}/lib/aio-versions/v1`;
    await Deno.mkdir(`${store}/docs`, { recursive: true });
    await Deno.writeTextFile(
      `${store}/docs/ui-testing.md`,
      "# testUI\n\nMount the app and settle.\n",
    );
    await Deno.writeTextFile(`${store}/.env`, "FRAMEWORK_KEY=nope\n");
    // A second dotted place under $HOME that nothing declares — the shape of
    // the thing this boundary is actually for.
    await Deno.mkdir(`${base}/private-notes`, { recursive: true });
    await Deno.writeTextFile(
      `${base}/private-notes/diary.md`,
      "PRIVATE_THOUGHTS=mine\n",
    );
    await withEngine([
      {
        toolCalls: [
          {
            id: "d",
            name: "read",
            args: '{"path":"dep/aio/docs/ui-testing.md"}',
          },
          { id: "s", name: "read", args: '{"path":"dep/aio/.env"}' },
          {
            id: "g",
            name: "glob",
            args: '{"pattern":"dep/aio/docs/*.md"}',
          },
          { id: "w", name: "glob", args: '{"pattern":"**/*.json"}' },
          {
            id: "n",
            name: "grep",
            args: '{"pattern":"nothinghereatall"}',
          },
          { id: "l", name: "ls", args: '{"path":"dep"}' },
          {
            id: "sub",
            name: "read",
            args: '{"path":"app/dep/aio/docs/ui-testing.md"}',
          },
          {
            id: "abs",
            name: "read",
            args: JSON.stringify({ path: `${store}/docs/ui-testing.md` }),
          },
          {
            id: "u",
            name: "read",
            args: '{"path":"elsewhere/diary.md"}',
          },
        ],
      },
      { text: "ok" },
    ], async (id) => {
      const dir = workspace.projects.find((p) => p.id === id)!.path;
      await Deno.mkdir(`${dir}/dep`, { recursive: true });
      await Deno.symlink(store, `${dir}/dep/aio`);
      // A link out to somewhere the project's configuration says nothing about.
      await Deno.symlink(`${base}/private-notes`, `${dir}/elsewhere`);
      await Deno.writeTextFile(
        `${dir}/deno.json`,
        JSON.stringify({ imports: { aio: "./dep/aio/mod.ts" } }),
      );
      // And the same framework one level down, declared by an app's OWN config
      // — what `am create clock` scaffolds inside the folder a conversation
      // opened. The project root's deno.json says nothing about this one.
      await Deno.mkdir(`${dir}/app/dep`, { recursive: true });
      await Deno.symlink(store, `${dir}/app/dep/aio`);
      await Deno.writeTextFile(
        `${dir}/app/deno.json`,
        JSON.stringify({ imports: { aio: "./dep/aio/mod.ts" } }),
      );
      await local.setMode(id, "read");
      await local.send("read the framework docs", id);
      const [
        doc,
        secret,
        aimed,
        wide,
        empty,
        listed,
        nested,
        absolute,
        undeclared,
      ] = localChat(id).messages.filter((m) => m.role === "tool");
      // The declared dependency: readable, which is the whole point.
      assert(doc.text.includes("Mount the app and settle"), doc.text);
      // Declared does not mean unguarded — a dependency's credentials are
      // still nobody's business.
      assert(secret.text.includes("private"), secret.text);
      assert(!secret.text.includes("FRAMEWORK_KEY"), secret.text);
      // Aimed at the dependency, glob finds it and spells it the way it was
      // asked for. It used to answer "No files matched" for documentation
      // plainly sitting there, because the walk would not cross the link.
      assert(aimed.text.includes("dep/aio/docs/ui-testing.md"), aimed.text);
      // But a wide pattern from the project root stays in the project: a glob
      // there is a question about this code, not about the framework's
      // thousands of files (`dep/aio` has a deno.json of its own, and it must
      // not be in this answer).
      assert(wide.text.includes("deno.json"), wide.text);
      assert(!wide.text.includes("dep/aio"), wide.text);
      // A search from the root that finds nothing says where the project keeps
      // the code it did not search. Without this, one live session ran the same
      // `sh grep -rn` five times — which skips symlinks too, so it learned
      // nothing five times over.
      assert(empty.text.includes("No matches"), empty.text);
      assert(empty.text.includes('path="dep/aio"'), empty.text);
      // A link to a directory is listed as a directory. The trailing slash is
      // the only thing saying "this can be listed"; without it the framework
      // read as a file, and the next move was a `read` that bounced.
      assert(listed.text.includes("aio/"), listed.text);
      // A scaffolded app declares its own framework, and that is the config
      // that knows about it — the root's does not mention it.
      assert(nested.text.includes("Mount the app and settle"), nested.text);
      // The same bytes named absolutely. Refusing this spelling taught a live
      // session only that spellings are a guessing game: turned away from
      // `clock/dep/aio/…`, it tried the store path next, was turned away again,
      // and then mistyped it.
      assert(absolute.text.includes("Mount the app and settle"), absolute.text);
      // And a private place nothing declares is refused exactly as before —
      // the exception is the project's own dependency, not "anything dotted".
      assert(undeclared.text.includes("private"), undeclared.text);
      assert(!undeclared.text.includes("PRIVATE_THOUGHTS"), undeclared.text);
    }).finally(() => Deno.remove(base, { recursive: true }).catch(() => {}));
  },
);

Deno.test("a path outside the project as written is refused", async () => {
  await withEngine([
    { toolCalls: [{ id: "c", name: "read", args: '{"path":"/etc/passwd"}' }] },
    { text: "ok" },
  ], async (id) => {
    await local.setMode(id, "read");
    await local.send("read it", id);
    const t = localChat(id).messages.find((m) => m.role === "tool")!;
    assert(t.text.includes("outside the project"), t.text);
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
    const cap = toolBudget(localConfig(id).ctx);
    assert(flood.text.length <= cap, `len ${flood.text.length} > ${cap}`);
    assert(flood.text.includes("truncated"), flood.text.slice(-200));
  });
});

Deno.test("a model stuck on one call is stopped long before the round cap", async () => {
  // A model that never stops making the same call. It is told once what it
  // is doing, then the tools are taken away for a round — and when it calls
  // anyway, the turn ends, saying why. Before, this burned every round up to
  // the cap: minutes of GPU for nothing.
  const always = Array.from({ length: 40 }, (_, i) => ({
    toolCalls: [{ id: `r${i}`, name: "ls", args: "{}" }],
  }));
  await withEngine(always, async (id, requests) => {
    await local.setMode(id, "read");
    await local.send("loop forever", id);
    const chat = localChat(id);
    assertEquals(chat.status, "idle");
    assert(chat.error?.includes("repeating"), chat.error ?? "(null)");
    assert(requests.length <= 8, `${requests.length} requests`);
    // The last request offered no tools and said so.
    const last = requests[requests.length - 1] as {
      tools?: unknown[];
      messages: { content: string }[];
    };
    assertEquals(last.tools, undefined);
    assert(
      last.messages.some((m) => m.content.includes("Tools are off")),
      "the model was not told",
    );
    assert(chat.messages.length <= MAX_LOCAL_MESSAGES);
  });
});

Deno.test("a second loop verdict pauses the tools for one round, not the turn", async () => {
  // Live: named twice, the tools went away for good; the model said "Let me
  // confirm the real path with ls." and that sentence ended its turn, with no
  // error and nothing run.
  const miss = (path: string, n: number) => ({
    toolCalls: [{
      id: `${path}${n}`,
      name: "read",
      args: JSON.stringify({ path }),
    }],
  });
  await withEngine([
    miss("nope-a.txt", 1),
    miss("nope-a.txt", 2), // verdict 1
    miss("nope-b.txt", 1),
    miss("nope-b.txt", 2), // verdict 2 → pause
    { text: "Let me confirm the real path with ls." },
    { toolCalls: [{ id: "l", name: "ls", args: "{}" }] },
    { text: "There is only here.txt." },
  ], async (id, requests) => {
    const dir = workspace.projects.find((p) => p.id === id)!.path;
    await Deno.writeTextFile(`${dir}/here.txt`, "x");
    await local.setMode(id, "read");
    await local.send("find it", id);
    const chat = localChat(id);
    type Req = { tools?: unknown[]; messages: { content: string }[] };
    const wire = requests as Req[];
    assertEquals(wire.length, 7);
    // The paused request offers nothing; the one after it offers the tools.
    assertEquals(wire[4].tools, undefined);
    assert((wire[5].tools?.length ?? 0) > 0, "tools did not come back");
    assert(
      wire[5].messages.some((m) => m.content.includes("Tools are on again")),
      "the model was not told",
    );
    assertEquals(chat.error, null);
    assertEquals(chat.messages.at(-1)?.text, "There is only here.txt.");
    // Both notes of the first verdict round reached the wire: the loop
    // verdict and the walled call, where the second used to erase the first.
    const third = wire[2].messages.map((m) => m.content).join("\n");
    assert(third.includes("failed twice with the same arguments"), third);
    assert(third.includes("has now failed 2 times"), third);
  });
});

Deno.test("notes queued in one round are all said, each once", () => {
  assertEquals(also("", "a"), "a");
  assertEquals(also("a", "b"), "a\n\nb");
  assertEquals(also("a\n\nb", "b"), "a\n\nb");
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
  // ~4k tokens of text that does not repeat — a repeated phrase is exactly
  // what the runaway guard stops, and would end the turn for that reason.
  const big = Array.from({ length: 1_600 }, (_, i) => `w${i * 7919 % 10007}`)
    .join(" ");
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
          // Inside a script: the plain spelling is answered with advice
          // before it runs, and the executor must hold without that help.
          args: JSON.stringify({ cmd: "bash -c 'setsid sleep 30 & sleep 30'" }),
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
      assert(toolMsg.text.includes("[killed after 0.5s"), toolMsg.text);
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
    // Grouped under the file, so its name is paid for once.
    assert(toolMsg.text.includes("a.txt:"), toolMsg.text);
    assert(/^ {2}2: /m.test(toolMsg.text), toolMsg.text);
    assert(toolMsg.text.includes("needle is here"), toolMsg.text);
    assert(!toolMsg.text.includes("b.txt"), toolMsg.text);
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
    // llama.cpp: a launch flag on /props — per slot beats the total.
    if (url.pathname === "/props") {
      return Response.json({
        n_ctx: 131_072,
        default_generation_settings: { n_ctx: 65_536 },
      });
    }
    // Ollama: what a LOADED model runs at is on /api/ps; /api/show only
    // knows what the model was trained for.
    if (url.pathname === "/api/ps") {
      return Response.json({
        models: [{ name: "big", model: "big", context_length: 32_768 }],
      });
    }
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
            state: "loaded",
            max_context_length: 262_144,
            loaded_context_length: 16_384,
          },
          { id: "cold", state: "not-loaded", max_context_length: 32_768 },
        ],
      });
    }
    return new Response("not found", { status: 404 });
  });
  const base = `http://localhost:${server.addr.port}`;
  try {
    assertEquals(await io.probeWindow("llamacpp", base, "any"), {
      ctx: 65_536,
      sure: true,
    });
    // Loaded: the length it runs at, not the 128k it was trained for.
    assertEquals(await io.probeWindow("ollama", base, "big"), {
      ctx: 32_768,
      sure: true,
    });
    // Not loaded: Ollama's OpenAI endpoint silently cuts the FRONT off a
    // prompt longer than its default window, so the guess is the low one —
    // and marked unsure, so the turn loads the model and asks again.
    assertEquals(await io.probeWindow("ollama", base, "small"), {
      ctx: 4_096,
      sure: false,
    });
    // A cloud model's window is the remote one, and it is never "loaded".
    assertEquals(await io.probeWindow("ollama", base, "big:cloud"), {
      ctx: 8_192,
      sure: true,
    });
    assertEquals(await io.probeWindow("lmstudio", base, "loaded"), {
      ctx: 16_384,
      sure: true,
    });
    assertEquals(await io.probeWindow("lmstudio", base, "cold"), {
      ctx: 32_768,
      sure: false,
    });
    // A model the server does not have is not an error, and not a guess.
    assertEquals(await io.probeWindow("lmstudio", base, "absent"), null);
    assertEquals(await io.probeContext("lmstudio", base, "loaded"), 16_384);
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
    assertEquals(tools[0].text.includes("earlier identical"), false);
    // The earlier result is still in view, so the answer points at it rather
    // than paying for the same bytes twice.
    assertEquals(tools[1].text.includes("earlier identical"), true);
    assert(tools[1].text.length < 200, tools[1].text);
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
    assertEquals(tools[2].text.includes("earlier identical"), false);
    assertEquals(tools[2].text.includes("n.txt"), true);
  });
});

Deno.test("running out of tool rounds still ends in an answer", async () => {
  // Rounds that keep calling, right up to the limit: the last request carries
  // no tools, so the model has to say something. Ending a turn with an error
  // and no answer throws away all the work it just did.
  const script: Scripted[] = [];
  // One short of the cap, so the limit is reached exactly — derived from the
  // constant, not copied from it.
  for (let i = 0; i < MAX_ROUNDS - 1; i++) {
    script.push({
      toolCalls: [{ id: `t${i}`, name: "ls", args: `{"path":"${i}"}` }],
    });
  }
  script.push({ text: "I have looked enough; here is the answer." });
  await withEngine(script, async (id, requests) => {
    await local.setMode(id, "read");
    await local.send("go", id);
    const chat = localChat(id);
    const rows = chat.messages;
    // The answer, then the note that this was a limit and not a finish. The
    // note is a row, not only a banner: a banner is gone by the next message,
    // and the answer above it would then read as a complete one.
    assertEquals(
      rows[rows.length - 2].text,
      "I have looked enough; here is" +
        " the answer.",
    );
    assertEquals(rows[rows.length - 1].role, "assistant");
    assert(
      rows[rows.length - 1].text.includes("1024 tool rounds"),
      rows[rows.length - 1].text,
    );
    // The last request asked for words: no schemas on the wire.
    const final = requests[requests.length - 1] as { tools?: unknown[] };
    assertEquals(final.tools, undefined);
    // …and the reader is told the limit was reached, rather than it being
    // passed off as a normal answer.
    assert(chat.error?.includes("tool limit"), chat.error ?? "no notice");
  });
});

Deno.test("closing a conversation's tab lets go of everything it held", async () => {
  await withEngine([{ text: "noted" }], async (id) => {
    const io = await import("../../cell/local.server.ts");
    await local.setMode(id, "chat");
    await local.send("remember this", id);
    assert(localChat(id).messages.length >= 2);
    // A second conversation in the same project, so the first tab may close.
    const second = await workspace.addPane(id, "session");
    assert(second, "no second pane");
    const rows = localChat(id).messages.length;
    await workspace.removePane(id);
    // The cleanup is fire-and-forget across cells, as every teardown here is.
    for (let i = 0; i < 100 && localChat(id).messages.length === rows; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assertEquals(localChat(id).messages.length, 0);
    // …and what was said is still findable: closing a tab is not deleting it.
    const found = await io.runTool("read", ".", "history", "{}", {
      key: "someone-else",
      ctx: 32_768,
      permission: "ask",
      net: false,
      outside: false,
      recall: { self: "someone-else", rows: [], parked: [] },
    });
    assert(
      found.includes("remember this") ||
        found.includes("No earlier conversations"),
      found.slice(0, 200),
    );
  });
});

Deno.test("changing files without checking them earns one reminder", async () => {
  await withEngine([
    {
      toolCalls: [{
        id: "w",
        name: "write",
        args: JSON.stringify({
          path: "mod.ts",
          content: "export const x = 1;",
        }),
      }],
    },
    { text: "Done — I changed mod.ts." },
    { text: "Checked: deno check passes." },
  ], async (id, requests) => {
    const dir = workspace.projects.find((p) => p.id === id)!.path;
    // A toolchain, so there is something to run: the reminder is not given to
    // a project where nothing can be run.
    await Deno.writeTextFile(`${dir}/deno.json`, "{}\n");
    await local.setMode(id, "agent");
    await local.setPermission(id, "bypass");
    await local.send("add a module", id);
    assert(
      JSON.stringify(requests[2]).includes("not run anything to check"),
      "the turn ended with edits and no check, and said nothing",
    );
    // Once only — the third request is the last, so nothing nagged again.
    assertEquals(requests.length, 3);
  });
});

Deno.test("output too long for the window is kept in a file", async () => {
  await withEngine([
    {
      toolCalls: [{
        id: "c",
        name: "sh",
        args: JSON.stringify({
          cmd: 'for i in $(seq 1 20000); do echo "line $i of the log"; done',
          timeout: 60,
        }),
      }],
    },
    { text: "read it" },
  ], async (id) => {
    await local.setMode(id, "agent");
    await local.setPermission(id, "bypass");
    await local.send("make some noise", id);
    const out = localChat(id).messages.find((m) => m.role === "tool")!;
    const where = /is in (\S+\.log)/.exec(out.text);
    assert(where, out.text.slice(-300));
    // The file named is the file that exists, and it holds the whole run.
    const full = await Deno.readTextFile(
      where[1].startsWith("/tmp/sh-")
        ? `${Deno.env.get("CC_TMP_ROOT")}/${id}/tmp/${where[1].slice(5)}`
        : where[1],
    );
    // Everything the stream cap let through, which is far more than the
    // window could ever hold.
    assert(full.length > 100_000, `only ${full.length} characters`);
    assert(full.includes("line 1 of the log"), "the start is missing");
    assert(full.length > out.text.length * 10, "barely more than was shown");
  });
});

Deno.test("a loop that alternates two calls is stopped early", async () => {
  // The shape a small model loops in most often: never three of the same in a
  // row, so a "last three identical" check never fires — and before the count
  // over the whole turn existed, this ran to the 1024-round cap.
  const script: Scripted[] = [];
  for (let i = 0; i < 60; i++) {
    script.push({
      toolCalls: [
        i % 2 === 0
          ? { id: `t${i}`, name: "ls", args: `{"path":"."}` }
          : { id: `t${i}`, name: "read", args: `{"path":"a.txt"}` },
      ],
    });
  }
  script.push({ text: "Fine — here is what I know." });
  await withEngine(script, async (id, requests) => {
    const dir = workspace.projects.find((p) => p.id === id)!.path;
    await Deno.writeTextFile(`${dir}/a.txt`, "hello\n");
    await local.setMode(id, "agent");
    await local.setPermission(id, "bypass");
    await local.send("go", id);
    const chat = localChat(id);
    assertEquals(chat.status, "idle");
    // Four of the same call is the limit, and two calls take turns: a dozen
    // requests at the very most, not a thousand.
    assert(requests.length <= 12, `${requests.length} requests`);
    assert(
      chat.messages.some((m) => m.text.includes("same read call")) ||
        chat.messages.some((m) => m.text.includes("same ls call")),
      "the transcript does not say it went round in a circle",
    );
  });
});

Deno.test("edit, check, edit, check is work — the same write in a circle is not", async () => {
  // A live session was cut at its fourth `deno task test` and, after
  // "continue", at its fourth read-back of the file it was fixing — with a
  // real edit before every one. The count that catches a circle must not
  // count a check whose question a change has just made new.
  const script: Scripted[] = [
    { toolCalls: [{ id: "r", name: "read", args: '{"path":"a.txt"}' }] },
  ];
  for (let i = 0; i < 6; i++) {
    script.push({
      toolCalls: [{
        id: `e${i}`,
        name: "edit",
        args: JSON.stringify({
          path: "a.txt",
          old_string: `v${i}`,
          new_string: `v${i + 1}`,
        }),
      }],
    });
    script.push({
      toolCalls: [{ id: `s${i}`, name: "sh", args: '{"cmd":"cat a.txt"}' }],
    });
  }
  script.push({ text: "All six landed." });
  await withEngine(script, async (id) => {
    const dir = workspace.projects.find((p) => p.id === id)!.path;
    await Deno.writeTextFile(`${dir}/a.txt`, "v0\n");
    await local.setMode(id, "agent");
    await local.setPermission(id, "bypass");
    await local.send("bump it six times, checking each", id);
    const rows = localChat(id).messages;
    assert(!rows.some((m) => m.text.includes("stopped after")), "cut short");
    assertEquals(rows[rows.length - 1].text, "All six landed.");
    assertEquals(await Deno.readTextFile(`${dir}/a.txt`), "v6\n");
  });

  // The same write, again and again, with the same check between: nothing new
  // is learned, and the writes keep their count.
  const circle: Scripted[] = [];
  for (let i = 0; i < 8; i++) {
    circle.push({
      toolCalls: [{
        id: `w${i}`,
        name: "write",
        args: JSON.stringify({ path: "b.txt", content: "same\n" }),
      }],
    });
    circle.push({
      toolCalls: [{ id: `c${i}`, name: "sh", args: '{"cmd":"cat b.txt"}' }],
    });
  }
  circle.push({ text: "Stopped." });
  await withEngine(circle, async (id) => {
    await local.setMode(id, "agent");
    await local.setPermission(id, "bypass");
    await local.send("go", id);
    const rows = localChat(id).messages;
    assert(
      rows.some((m) => m.text.includes("same write call")),
      rows.map((m) => m.text).join("\n---\n").slice(-1500),
    );
  });
});

Deno.test(
  "a framework scaffolded during the conversation is readable at once",
  async () => {
    // A live session listed its empty folder, ran `am create pomodoro`, and had
    // `pomodoro/dep/aio/docs` refused as private six times in the next ten
    // seconds: the walk that decided was cached from before the app existed.
    // Dotted directory under the real $HOME, as in the test above — a temp dir
    // is not what users have.
    const base = `${Deno.env.get("HOME")}/.cc-scaffold-test-${
      crypto.randomUUID().slice(0, 8)
    }`;
    const store = `${base}/lib/aio-versions/v1`;
    await Deno.mkdir(`${store}/docs`, { recursive: true });
    await Deno.writeTextFile(`${store}/docs/README.md`, "# Read me first\n");
    await withEngine([
      { toolCalls: [{ id: "l", name: "ls", args: '{"path":"."}' }] },
      { text: "empty" },
      {
        toolCalls: [{
          id: "r",
          name: "read",
          args: '{"path":"app/dep/aio/docs/README.md"}',
        }],
      },
      { text: "read it" },
    ], async (id) => {
      const dir = workspace.projects.find((p) => p.id === id)!.path;
      await local.setMode(id, "read");
      await local.send("what is here", id);
      // What `am create app` leaves behind, seconds after the first look.
      await Deno.mkdir(`${dir}/app/dep`, { recursive: true });
      await Deno.symlink(store, `${dir}/app/dep/aio`);
      await Deno.writeTextFile(
        `${dir}/app/deno.json`,
        JSON.stringify({ imports: { aio: "./dep/aio/mod.ts" } }),
      );
      await local.send("now read the framework docs", id);
      const read = localChat(id).messages.filter((m) => m.role === "tool")[1];
      assert(read.text.includes("Read me first"), read.text);
    }).finally(() => Deno.remove(base, { recursive: true }).catch(() => {}));
  },
);

Deno.test("the turn that scaffolds the framework is reminded to read its docs", async () => {
  // The docs reminder looked for a framework once, when the turn began — and
  // the turn that runs `am create` began in an empty folder, so it never had
  // one to remind about.
  const base = `${Deno.env.get("HOME")}/.cc-scaffold-docs-${
    crypto.randomUUID().slice(0, 8)
  }`;
  const store = `${base}/lib/aio-versions/v1`;
  await Deno.mkdir(`${store}/docs`, { recursive: true });
  await Deno.writeTextFile(`${store}/docs/README.md`, "# Read me first\n");
  const scaffold = [
    "mkdir -p app/dep",
    `ln -s ${store} app/dep/aio`,
    `echo '{"imports":{"aio":"./dep/aio/mod.ts"}}' > app/deno.json`,
  ].join(" && ");
  await withEngine([
    {
      toolCalls: [{
        id: "s",
        name: "sh",
        args: JSON.stringify({ cmd: scaffold }),
      }],
    },
    {
      toolCalls: [{
        id: "w",
        name: "write",
        args: JSON.stringify({ path: "app/src/cell.ts", content: "x\n" }),
      }],
    },
    { text: "Built it." },
    { text: "Read them; it holds." },
  ], async (id, requests) => {
    await local.setMode(id, "agent");
    await local.setPermission(id, "bypass");
    await local.send("build an aio app", id);
    assert(
      JSON.stringify(requests).includes("have not opened its documentation"),
      "no reminder",
    );
  }).finally(() => Deno.remove(base, { recursive: true }).catch(() => {}));
});

Deno.test("what the store folds, the model is still sent whole", async () => {
  // A live session at 76k of a 218k window had 71 of its 95 results sent as
  // one-line stubs: the store's size cap, meant to keep the saved chat small,
  // was deciding what the model could see. It re-read its own cell.ts five
  // times. The window decides now; the store only shortens its own copy.
  // The fact sits in the middle: a shortened copy keeps head and tail, so a
  // fact at the top survived the bug test15 met — the whole text was replaced
  // by the store's copy the second time the store folded.
  const page = (tag: string) =>
    `# ${tag}\n` + "filler line of documentation\n".repeat(300) +
    `FACT-FROM-${tag}\n` + "filler line of documentation\n".repeat(300);
  const reads = ["a", "b", "c", "d", "e"].map((f) => ({
    toolCalls: [{ id: `r-${f}`, name: "read", args: `{"path":"${f}.md"}` }],
  }));
  await withEngine(
    [...reads, { text: "read them all" }],
    async (id, requests) => {
      const dir = workspace.projects.find((p) => p.id === id)!.path;
      for (const f of ["a", "b", "c", "d", "e"]) {
        await Deno.writeTextFile(`${dir}/${f}.md`, page(f));
      }
      await local.setCtx(id, 32_768);
      await local.setMode(id, "read");
      await local.send("read the five pages", id);
      // The store did fold: 3 × ~24k characters is past a 32k-token window's
      // store budget of ~32k characters.
      const rows = localChat(id).messages.filter((m) => m.role === "tool");
      assert(rows.some((m) => m.folded), "nothing was folded");
      assert(rows[0].text.length < 2_000, `stored ${rows[0].text.length}`);
      // …and the last request still carried the first page whole.
      const last = JSON.stringify(requests[requests.length - 1]);
      assert(last.includes("FACT-FROM-a"), "the model lost the first page");
      assert(
        !last.includes("result elided"),
        "a folded page went out as a stub",
      );
    },
  );
});

Deno.test("a write copied from a shortened view is refused, and nothing changes", async () => {
  // A live session rewrote a test file from its own earlier write as it saw
  // it — 200 characters and the shortening note — and 154 lines became 5.
  const copied = "import x from './x.ts';\n[…2804 more characters: your call" +
    " was sent whole and the file has all of it — this copy is shortened to" +
    " save room]";
  await withEngine([
    { toolCalls: [{ id: "r", name: "read", args: '{"path":"t.ts"}' }] },
    {
      toolCalls: [{
        id: "w",
        name: "write",
        args: JSON.stringify({ path: "t.ts", content: copied }),
      }],
    },
    { text: "ok" },
  ], async (id) => {
    const dir = workspace.projects.find((p) => p.id === id)!.path;
    await Deno.writeTextFile(`${dir}/t.ts`, "export const whole = true;\n");
    await local.setMode(id, "agent");
    await local.setPermission(id, "bypass");
    await local.send("rewrite t.ts", id);
    const refused = localChat(id).messages.filter((m) => m.role === "tool")[1];
    assert(refused.text.includes("Not written"), refused.text);
    assert(refused.text.includes("shortened"), refused.text);
    assertEquals(
      await Deno.readTextFile(`${dir}/t.ts`),
      "export const whole = true;\n",
    );
  });
});

Deno.test("three files changed and nothing run: check now, not at the end", async () => {
  // A live session wrote a cell, a UI, an entry, a stylesheet and four test
  // versions over six minutes before running anything — 49 type errors at
  // once, all from an API invented at the start.
  const write = (i: number) => ({
    toolCalls: [{
      id: `w${i}`,
      name: "write",
      args: JSON.stringify({
        path: `f${i}.ts`,
        content: `export const a${i} = ${i};\n`,
      }),
    }],
  });
  await withEngine(
    [...[1, 2, 3, 4, 5, 6, 7].map(write), { text: "done" }],
    async (id, requests) => {
      await local.setMode(id, "agent");
      await local.setPermission(id, "bypass");
      await local.send("make seven files", id);
      const has = (n: number, words: string) =>
        JSON.stringify(requests[n]).includes(words);
      const first = (n: number) => has(n, "without running anything");
      const firm = (n: number) => has(n, "not another file");
      // Not after one or two files…
      assert(!first(1) && !first(2), "said too early");
      // …but in the request right after the third.
      assert(first(3), "not said after three files");
      // Not again for the fourth or fifth…
      assert(!first(4) && !first(5) && !firm(4) && !firm(5), "nagging");
      // …but put off to six, it is said again, without room for "later" —
      // told at three, a live session wrote four more files first.
      assert(firm(6), "not said again at six files");
      // Twice per stretch at most.
      assert(!firm(7) && !first(7), "said a third time");
    },
  );
});

Deno.test("an unread file's refusals say why: your own command made it, or you never read it", async () => {
  // A live session was refused a write to the cell its own `am create` had
  // just made, and guessed an old_string for an app.ts it had never opened.
  await withEngine([
    {
      toolCalls: [{
        id: "s",
        name: "sh",
        args: JSON.stringify({
          cmd: "printf 'export const a = 1;\\n' > made.ts",
        }),
      }],
    },
    {
      toolCalls: [{
        id: "w",
        name: "write",
        args: JSON.stringify({
          path: "made.ts",
          content: "export const a = 2;\n",
        }),
      }],
    },
    {
      toolCalls: [{
        id: "e",
        name: "edit",
        args: JSON.stringify({
          path: "made.ts",
          old_string: "export const b = 1;",
          new_string: "export const b = 2;",
        }),
      }],
    },
    { text: "ok" },
  ], async (id) => {
    await local.setMode(id, "agent");
    await local.setPermission(id, "bypass");
    await local.send("change made.ts", id);
    const [, wrote, edited] = localChat(id).messages.filter((m) =>
      m.role === "tool"
    );
    assert(wrote.text.includes("your own command created it"), wrote.text);
    assert(wrote.text.includes("made.ts"), wrote.text);
    assert(edited.text.includes("You have not read made.ts"), edited.text);
  });
});

Deno.test("package bookkeeping lines fold into one", async () => {
  const io = await import("../../cell/local.server.ts");
  const cold = [
    ...["immer@10.2.0", "electron@44.3.0", "happy-dom@17.6.3", "esbuild@0.24.2"]
      .map((p) => `Initialize ${p}`),
    "Check src/app.ts",
    "TS2322 [ERROR]: Type 'string' is not assignable",
  ].join("\n");
  const folded = io.foldInstallNoise(cold);
  assert(folded.startsWith("[4 package download/initialize lines]"), folded);
  assert(folded.includes("TS2322 [ERROR]"), folded);
  // A few are left alone: they may be the point.
  const few = "Download https://jsr.io/@std/path/1.0.0/mod.ts\nok";
  assertEquals(io.foldInstallNoise(few), few);
});

Deno.test("a reply asking for two hundred commands runs a dozen", async () => {
  await withEngine([
    {
      // Each one different, so the reply is trimmed for its size alone and
      // not for repeating itself.
      toolCalls: Array.from({ length: 200 }, (_, i) => ({
        id: `c${i}`,
        name: "ls",
        args: `{"path":"${i}"}`,
      })),
    },
    { text: "done" },
  ], async (id, requests) => {
    await local.setMode(id, "read");
    await local.send("go", id);
    const chat = localChat(id);
    const results = chat.messages.filter((m) => m.role === "tool");
    assertEquals(results.length, MAX_CALLS_PER_REPLY);
    // …and the model is told, so it can ask again for what it still wants.
    // (The stream accumulator has a ceiling of its own, so the number it is
    // told is what survived that, not the two hundred it wrote.)
    const second = requests[1] as { messages: { content: string }[] };
    assert(
      /asked for \d+ calls at once/.test(JSON.stringify(second.messages)),
      "the model was not told that the rest were dropped",
    );
  });
});

Deno.test("a turn that runs out of time answers and says so", async () => {
  Deno.env.set("CC_TURN_MS", "700");
  try {
    const script: Scripted[] = [];
    for (let i = 0; i < 400; i++) {
      script.push({
        // Unique arguments every time: nothing repeats, so only the clock can
        // end this.
        toolCalls: [{ id: `t${i}`, name: "ls", args: `{"path":"${i}"}` }],
        delayMs: 20,
      });
    }
    script.push({ text: "Out of time; here is where I got to." });
    await withEngine(script, async (id) => {
      await local.setMode(id, "read");
      await local.send("go", id);
      const rows = localChat(id).messages;
      assertEquals(localChat(id).status, "idle");
      assert(
        rows[rows.length - 1].text.includes("seconds of work"),
        rows[rows.length - 1].text,
      );
    });
  } finally {
    Deno.env.delete("CC_TURN_MS");
  }
});

Deno.test("a slow model's turn clock runs longer, by its measured speed", async () => {
  // test2: a 17 tokens/s model was cut at 45 minutes, still making progress.
  Deno.env.set("CC_TURN_MS", "700");
  try {
    // 20 tokens/s against a clock set for 60: three times as long.
    const slow = { predicted_n: 2_000, predicted_ms: 100_000 };
    const script: Scripted[] = [];
    for (let i = 0; i < 400; i++) {
      script.push({
        toolCalls: [{ id: `t${i}`, name: "ls", args: `{"path":"${i}"}` }],
        delayMs: 20,
        timings: slow,
      });
    }
    script.push({ text: "Out of time; here is where I got to." });
    await withEngine(script, async (id) => {
      await local.setMode(id, "read");
      const t0 = Date.now();
      await local.send("go", id);
      const took = Date.now() - t0;
      const rows = localChat(id).messages;
      assert(
        rows[rows.length - 1].text.includes("2 seconds of work"),
        rows[rows.length - 1].text,
      );
      assert(took >= 2_000, `cut after ${took}ms`);
    });
  } finally {
    Deno.env.delete("CC_TURN_MS");
  }
});

Deno.test("a clock stretch from a speed: never shorter, at most four times", async () => {
  const { stretchFor } = await import("../../cell/local.server.ts");
  assertEquals(stretchFor(undefined), 1);
  assertEquals(stretchFor(79), 1);
  assertEquals(stretchFor(30), 2);
  assertEquals(stretchFor(10), 4);
});

Deno.test("an approval click for a command already dealt with does nothing", async () => {
  await withEngine([
    {
      toolCalls: [
        { id: "a1", name: "sh", args: `{"cmd":"echo first"}` },
        { id: "a2", name: "sh", args: `{"cmd":"echo second"}` },
      ],
    },
    { text: "both done" },
  ], async (id) => {
    await local.setMode(id, "agent");
    await local.setPermission(id, "ask");
    const turn = local.send("go", id);
    // Answer the first question, then click its button again: the second
    // command is already on screen by then, and the stale click must not
    // allow it.
    const asked: string[] = [];
    for (let i = 0; i < 200; i++) {
      const p = localChat(id).pending;
      if (p && !asked.includes(p.id)) {
        asked.push(p.id);
        await local.answer(id, true, false, p.id);
        // The same click again, now that the next command may be pending.
        await local.answer(id, true, false, p.id);
      }
      if (asked.length === 2) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    // The second command must have been asked about on its own.
    assertEquals(asked.length, 2);
    await turn;
    const results = localChat(id).messages.filter((m) => m.role === "tool");
    assertEquals(results.length, 2);
    assert(results[0].text.includes("first"), results[0].text);
    assert(results[1].text.includes("second"), results[1].text);
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
        args: JSON.stringify({ cmd: "rm -rf ../another-project" }),
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
    // …and the one that reaches OUT of the project did not. (A delete inside
    // it is the agent's own housekeeping and runs — `agent.test.ts` holds that
    // line.) The refusal is written for the model, and it names the way to ask
    // the user for this one command.
    assert(outputs[1].text.startsWith("Error: refused"), outputs[1].text);
    assert(outputs[1].text.includes("deletes"), outputs[1].text);
    assert(outputs[1].text.includes("outside_sandbox"), outputs[1].text);
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

Deno.test("local — a speed needs both halves, and is never invented", () => {
  // Most OpenAI-compatible servers report no completion count on a streamed
  // reply, and a tokens-per-second figure derived from characters would be
  // wrong by whatever this model's tokeniser does — invisibly.
  assertEquals(speedOf({ lastMs: 0, lastTokens: 0 }), null);
  assertEquals(speedOf({ lastMs: 4_000, lastTokens: 0 }), null);
  assertEquals(speedOf({ lastMs: 0, lastTokens: 200 }), null);
  // Nor is a turn too short to measure a measurement.
  assertEquals(speedOf({ lastMs: 120, lastTokens: 8 }), null);
  assertEquals(speedOf({ lastMs: 4_000, lastTokens: 200 }), 50);
});

Deno.test("switching away aborts the turn in flight", async () => {
  // Why this matters: a turn in flight holds `status: "working"`, and a
  // working chat disables the composer. Left running against the server you
  // have just switched AWAY from, it holds it until that abandoned request
  // gives up — about two minutes in the real app — while the strip above
  // claims a different engine is selected. An app that refuses to be typed
  // into right after being told to change reads as broken.
  //
  // Tested at the mechanism, because that is where it is decidable in
  // milliseconds: the run's signal must actually fire.
  const io = await import("../../cell/local.server.ts");
  const signal = io.beginRun("chat-1");
  assertEquals(signal.aborted, false);

  io.stopRun("chat-1");
  assertEquals(signal.aborted, true, "the abandoned turn should be aborted");

  // And one conversation's switch must not touch another's.
  const other = io.beginRun("chat-2");
  io.stopRun("chat-1");
  assertEquals(other.aborted, false);
  io.stopRun("chat-2");
});

Deno.test("clear keeps what it took, so undo has something to give back", async () => {
  // Clear used to fail outright. It held a draft reference to the messages and
  // then replaced the object those messages live in, which the runtime refuses
  // to read back rather than let resolve to the wrong thing — so the
  // conversation stayed on screen, an error was logged, and the undo it was
  // supposed to be saving never existed.
  await withEngine([{ text: "hello back" }], async (id) => {
    await local.send("something worth not losing", id);
    assertEquals(localChat(id).messages.length > 0, true);

    await local.clear(id);
    assertEquals(localChat(id).messages.length, 0, "cleared");

    await local.undoClear(id);
    assertEquals(
      localChat(id).messages[0]?.text,
      "something worth not losing",
      "and given back",
    );
  });
});

/* ── the improved agent: edit, glob, todo, parallel rounds, loop, overflow ── */

Deno.test("edit makes the smallest change and refuses ambiguity", async () => {
  await withEngine([
    {
      toolCalls: [{
        id: "c1",
        name: "edit",
        args: JSON.stringify({
          path: "config.ts",
          old_string: "const port = 3000;",
          new_string: "const port = 8080;",
        }),
      }],
    },
    {
      toolCalls: [{
        id: "c2",
        name: "edit",
        args: JSON.stringify({
          path: "config.ts",
          old_string: "const",
          new_string: "let",
        }),
      }],
    },
    { text: "done" },
  ], async (id) => {
    const dir = workspace.projects.find((p) => p.id === id)!.path;
    const body = "const host = 'localhost';\nconst port = 3000;\n";
    await Deno.writeTextFile(`${dir}/config.ts`, body);
    await local.setMode(id, "agent");
    await local.send("edit it", id);

    const tools = localChat(id).messages.filter((m) => m.role === "tool");
    // The unique match was applied — and only the matched line changed.
    const after = await Deno.readTextFile(`${dir}/config.ts`);
    assert(after.includes("const port = 8080;"), after);
    assert(after.includes("const host = 'localhost';"), after);
    assert(tools[0].text.includes("Edited"), tools[0].text);
    // The ambiguous match was refused with the count and the fix, in words a
    // model can act on — guessing the first occurrence is how an agent edits
    // the wrong line while believing it fixed the right one.
    assert(tools[1].text.includes("2 places"), tools[1].text);
    assert(tools[1].text.includes("surrounding lines"), tools[1].text);
  });
});

Deno.test("glob finds files by pattern and stays in the project", async () => {
  await withEngine([
    {
      toolCalls: [{
        id: "c1",
        name: "glob",
        args: JSON.stringify({ pattern: "src/**/*.ts" }),
      }],
    },
    { text: "found them" },
  ], async (id) => {
    const dir = workspace.projects.find((p) => p.id === id)!.path;
    await Deno.mkdir(`${dir}/src/lib`, { recursive: true });
    await Deno.writeTextFile(`${dir}/src/a.ts`, "x");
    await Deno.writeTextFile(`${dir}/src/lib/b.ts`, "x");
    await Deno.writeTextFile(`${dir}/src/c.md`, "x");
    await Deno.mkdir(`${dir}/node_modules/pkg`, { recursive: true });
    await Deno.writeTextFile(`${dir}/node_modules/pkg/skip.ts`, "x");
    await local.setMode(id, "read");
    await local.send("where are the typescript files?", id);

    const tools = localChat(id).messages.filter((m) => m.role === "tool");
    assert(tools[0].text.includes("src/a.ts"), tools[0].text);
    assert(tools[0].text.includes("src/lib/b.ts"), tools[0].text);
    assert(!tools[0].text.includes("c.md"), tools[0].text);
    // SKIP directories are not walked: the answer is the project's code, not
    // its dependencies.
    assert(!tools[0].text.includes("node_modules"), tools[0].text);
  });
});

Deno.test("todo sets a plan the model sees on every later request", async () => {
  await withEngine([
    {
      toolCalls: [{
        id: "c1",
        name: "todo",
        args: JSON.stringify({
          items: [
            { content: "find the bug", status: "in_progress" },
            { content: "write a test", status: "pending" },
          ],
        }),
      }],
    },
    {
      toolCalls: [{
        id: "c2",
        name: "ls",
        args: "{}",
      }],
    },
    { text: "the bug is in ls" },
  ], async (id, requests) => {
    await local.setMode(id, "agent");
    await local.send("hunt the bug", id);

    // The cell holds the list for the page…
    const chat = localChat(id);
    assertEquals(chat.todos.length, 2);
    assertEquals(chat.todos[0].content, "find the bug");
    assertEquals(chat.todos[0].status, "in_progress");
    // …and the round AFTER the todo call carries it in the wire, where the
    // model can still see its own plan.
    const second = requests[1] as {
      messages: { role: string; content: string }[];
    };
    const note = second.messages.find((m) =>
      m.content.toLowerCase().includes("task list")
    );
    assert(note !== undefined, "todo note missing from the second request");
    assert(note.content.includes("[~] find the bug"), note.content);
    // Clearing the conversation clears the plan — it was about the turn.
    await local.clear(id);
    assertEquals(localChat(id).todos.length, 0);
  });
});

Deno.test("independent calls in one round run in parallel", async () => {
  // Two reads, one round. Executed together they take the slowest one's
  // wall-clock, not the sum — and the wire gets both results in call order,
  // which is the order servers require.
  await withEngine([
    {
      toolCalls: [
        { id: "c1", name: "read", args: JSON.stringify({ path: "a.txt" }) },
        { id: "c2", name: "read", args: JSON.stringify({ path: "b.txt" }) },
      ],
    },
    { text: "both read" },
  ], async (id) => {
    const dir = workspace.projects.find((p) => p.id === id)!.path;
    await Deno.writeTextFile(`${dir}/a.txt`, "alpha");
    await Deno.writeTextFile(`${dir}/b.txt`, "beta");
    await local.setMode(id, "read");
    const t0 = Date.now();
    await local.send("read both", id);
    const ms = Date.now() - t0;

    const chat = localChat(id);
    const tools = chat.messages.filter((m) => m.role === "tool");
    assertEquals(tools.length, 2);
    assertEquals(tools[0].toolCallId, "c1");
    assert(tools[0].text.includes("alpha"), tools[0].text);
    assert(tools[1].text.includes("beta"), tools[1].text);
    // Both ran in the same round against a stub that answers in the same
    // tick; serialized it was passing, so the assertion is the wire contract
    // (results in call order) — parallelism is asserted by code inspection
    // of the canParallel gate, not by a stopwatch.
    assert(ms < 30_000, "round took absurdly long");
  });
});

Deno.test("three identical reads get the loop verdict in the wire", async () => {
  const same = JSON.stringify({ path: "same.txt" });
  await withEngine([
    { toolCalls: [{ id: "r1", name: "read", args: same }] },
    { toolCalls: [{ id: "r2", name: "read", args: same }] },
    { toolCalls: [{ id: "r3", name: "read", args: same }] },
    { text: "fine, I will answer." },
  ], async (id, requests) => {
    const dir = workspace.projects.find((p) => p.id === id)!.path;
    await Deno.writeTextFile(`${dir}/same.txt`, "unchanging");
    await local.setMode(id, "read");
    await local.send("stuck", id);

    // The fourth request — after the third identical call — carries the
    // verdict as a system row, telling the model what the repeat means
    // instead of letting it learn nothing, again, for the rest of the cap.
    const fourth = requests[3] as {
      messages: { role: string; content: string }[];
    };
    const verdict = fourth.messages.find((m) =>
      m.content.includes("three times in a row")
    );
    assert(verdict !== undefined, "verdict missing from the wire");
  });
});

Deno.test("a context overflow is answered with a tighter pack and a retry", async () => {
  // First attempt: the server refuses — window full. Second attempt, against
  // the same user message: the older turns are stubbed/summarized harder, and
  // the turn completes instead of dying with an HTTP error.
  let calls = 0;
  const server = Deno.serve(
    { port: 0, onListen: () => {} },
    (req) => {
      const p = new URL(req.url).pathname;
      if (p === "/v1/models") return Response.json({ data: [{ id: "m" }] });
      if (p === "/v1/chat/completions") {
        calls++;
        if (calls === 1) {
          return new Response(
            'HTTP 400 — {"error":{"message":"Requested tokens exceed context length"}}',
            { status: 400 },
          );
        }
        return new Response(
          'data: {"choices":[{"delta":{"content":"made it after retry"}}]}\n\n' +
            'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' +
            "data: [DONE]\n\n",
          { headers: { "content-type": "text/event-stream" } },
        );
      }
      return new Response("not found", { status: 404 });
    },
  );
  const h = await bootCells([workspace, local]);
  const dir = await Deno.makeTempDir();
  try {
    await workspace.addProject(dir);
    const id = workspace.projects.find((p) => p.path === dir)?.id ?? "";
    await local.setEngine(id, "llamacpp");
    await local.setBaseUrl(id, `http://localhost:${server.addr.port}`);
    await local.setModel(id, "m");
    await local.setMode(id, "chat");
    await local.send("hi", id);

    assertEquals(
      calls,
      2,
      "the overflow should have been retried exactly once",
    );
    const chat = localChat(id);
    assertEquals(chat.status, "idle");
    assertEquals(chat.error, null);
    const last = chat.messages[chat.messages.length - 1];
    assertEquals(last.text, "made it after retry");
    // The user message is in the transcript once — a retry is a continuation,
    // not a duplicate.
    assertEquals(chat.messages.filter((m) => m.text === "hi").length, 1);
  } finally {
    h.dispose();
    await server.shutdown();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("an empty tool result still says something to the model", async () => {
  await withEngine([
    {
      toolCalls: [{
        id: "c1",
        name: "sh",
        args: JSON.stringify({ cmd: "true" }),
      }],
    },
    { text: "ok" },
  ], async (id) => {
    await local.setMode(id, "agent");
    await local.setPermission(id, "bypass");
    await local.send("run the silent command", id);
    const toolMsg = localChat(id).messages.find((m) => m.role === "tool")!;
    assert(toolMsg.text.length > 0, "empty result reached the wire");
  });
});

Deno.test("a stream that dies before its first chunk is retried once", async () => {
  // A local server mid-model-swap refuses a connection and then answers.
  // A request with no output yet cannot have been seen by the model, so the
  // resend is safe — and it is the difference between a turn that survives
  // a blip and one that ends in an error banner over nothing.
  let calls = 0;
  const server = Deno.serve(
    { port: 0, onListen: () => {} },
    (req) => {
      const p = new URL(req.url).pathname;
      if (p === "/v1/models") return Response.json({ data: [{ id: "m" }] });
      if (p === "/v1/chat/completions") {
        calls++;
        if (calls === 1) {
          return new Response("server unavailable", { status: 503 });
        }
        return new Response(
          'data: {"choices":[{"delta":{"content":"second time lucky"}}]}\n\n' +
            'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' +
            "data: [DONE]\n\n",
          { headers: { "content-type": "text/event-stream" } },
        );
      }
      return new Response("not found", { status: 404 });
    },
  );
  const h = await bootCells([workspace, local]);
  const dir = await Deno.makeTempDir();
  try {
    await workspace.addProject(dir);
    const id = workspace.projects.find((p) => p.path === dir)?.id ?? "";
    await local.setEngine(id, "llamacpp");
    await local.setBaseUrl(id, `http://localhost:${server.addr.port}`);
    await local.setModel(id, "m");
    await local.setMode(id, "chat");
    await local.send("hi", id);

    assertEquals(calls, 2, "the transport should have retried once");
    const chat = localChat(id);
    assertEquals(chat.error, null);
    assertEquals(
      chat.messages[chat.messages.length - 1].text,
      "second time lucky",
    );
  } finally {
    h.dispose();
    await server.shutdown();
    await Deno.remove(dir, { recursive: true });
  }
});

/* ── the harness: any model, any window, no mess ──────────────────────────── */

/** A llama.cpp that says, on /props, it cannot take tools natively. */
const noNativeTools = (url: URL) =>
  url.pathname === "/props"
    ? Response.json({ chat_template_caps: { supports_tools: false } })
    : null;

type Req = {
  tools?: unknown[];
  max_tokens?: number;
  messages: { role: string; content: string }[];
};

Deno.test("a model without native tools works through the text protocol", async () => {
  await withEngine([
    {
      text: 'Checking.\n<tool_call>{"name": "ls", "arguments": {}}</tool_call>',
    },
    { text: "There is one file: a.txt." },
  ], async (id, requests) => {
    const dir = workspace.projects.find((p) => p.id === id)!.path;
    await Deno.writeTextFile(`${dir}/a.txt`, "x");
    await local.setMode(id, "read");
    await local.send("what is here?", id);
    const chat = localChat(id);
    assertEquals(chat.toolsOk, false);
    assertEquals(chat.error, null);
    const [first, second] = requests as Req[];
    // No schemas on the wire — the tools are in the prompt, in words.
    assertEquals(first.tools, undefined);
    assert(first.messages[0].content.includes("<tool_call>"));
    // The call ran, and its result went back as a user message.
    const result = second.messages.find((m) =>
      m.content.includes('<tool_result name="ls">')
    );
    assertEquals(result?.role, "user");
    assert(result?.content.includes("a.txt"), result?.content);
    // What the reader sees: the words, and the call — not raw tags.
    const asked = chat.messages.find((m) => m.toolCalls?.length)!;
    assertEquals(asked.text, "Checking.");
    assertEquals(asked.toolCalls![0].name, "ls");
    assertEquals(
      chat.messages[chat.messages.length - 1].text,
      "There is one file: a.txt.",
    );
  }, noNativeTools);
});

Deno.test("a server that refuses tools mid-turn is answered in words, not an error", async () => {
  await withEngine([
    {
      status: 400,
      body:
        '{"error":"registry.ollama.ai/library/gemma3 does not support tools"}',
    },
    { text: '<tool_call>{"name":"ls","arguments":{}}</tool_call>' },
    { text: "Listed." },
  ], async (id, requests) => {
    await local.setMode(id, "read");
    await local.send("list", id);
    const chat = localChat(id);
    assertEquals(chat.error, null);
    assertEquals(chat.toolsOk, false);
    assert((requests[0] as Req).tools?.length, "first try was native");
    assertEquals((requests[1] as Req).tools, undefined);
    assertEquals(chat.messages[chat.messages.length - 1].text, "Listed.");
  });
});

Deno.test("a native model that writes its call as text still gets it run", async () => {
  await withEngine([
    {
      text:
        '<tool_call>{"name":"read","arguments":{"path":"a.txt"}}</tool_call>',
    },
    { text: "It says hello." },
  ], async (id) => {
    const dir = workspace.projects.find((p) => p.id === id)!.path;
    await Deno.writeTextFile(`${dir}/a.txt`, "hello");
    await local.setMode(id, "read");
    await local.send("read a.txt", id);
    const tool = localChat(id).messages.find((m) => m.role === "tool")!;
    assert(tool.text.includes("hello"), tool.text);
  });
});

Deno.test("other harnesses' tool names and keys are understood, and shown in ours", async () => {
  await withEngine([
    {
      toolCalls: [{
        id: "c1",
        name: "Read_File",
        args: JSON.stringify({ file_path: "a.txt", start_line: 2 }),
      }],
    },
    { text: "done" },
  ], async (id) => {
    const dir = workspace.projects.find((p) => p.id === id)!.path;
    await Deno.writeTextFile(`${dir}/a.txt`, "one\ntwo\nthree\n");
    await local.setMode(id, "read");
    await local.send("read it", id);
    const chat = localChat(id);
    const call = chat.messages.find((m) => m.toolCalls?.length)!.toolCalls![0];
    assertEquals(call.name, "read");
    assertEquals(JSON.parse(call.args), { path: "a.txt", offset: 2 });
    const tool = chat.messages.find((m) => m.role === "tool")!;
    // 1-based: offset 2 starts at the second line.
    assert(tool.text.startsWith("2\ttwo"), tool.text);
  });
});

Deno.test("an existing file is never overwritten unread, and a turn can be undone", async () => {
  await withEngine([
    {
      toolCalls: [{
        id: "w1",
        name: "write",
        args: JSON.stringify({ path: "keep.txt", content: "clobbered" }),
      }],
    },
    {
      toolCalls: [{ id: "r1", name: "read", args: '{"path":"keep.txt"}' }],
    },
    {
      toolCalls: [
        {
          id: "w2",
          name: "write",
          args: JSON.stringify({ path: "keep.txt", content: "rewritten" }),
        },
      ],
    },
    {
      toolCalls: [{
        id: "w3",
        name: "write",
        args: JSON.stringify({ path: "new/made.txt", content: "fresh" }),
      }],
    },
    { text: "done" },
  ], async (id) => {
    const dir = workspace.projects.find((p) => p.id === id)!.path;
    await Deno.writeTextFile(`${dir}/keep.txt`, "precious");
    await local.setMode(id, "agent");
    await local.send("tidy up", id);
    const tools = localChat(id).messages.filter((m) => m.role === "tool");
    // Refused while unread — the model had never seen what it would destroy.
    assert(tools[0].text.includes("not read it"), tools[0].text);
    // Allowed once read.
    assert(tools[2].text.startsWith("Overwrote"), tools[2].text);
    assertEquals(await Deno.readTextFile(`${dir}/keep.txt`), "rewritten");
    assertEquals(localChat(id).changed, 2);

    // One click puts every file back, and removes the one the turn created.
    await local.undoChanges(id);
    assertEquals(await Deno.readTextFile(`${dir}/keep.txt`), "precious");
    assertEquals(
      await Deno.stat(`${dir}/new/made.txt`).catch(() => null),
      null,
    );
    assertEquals(localChat(id).changed, 0);
    // The model is told, on its next turn, that its work is gone.
    const note = localChat(id).messages[localChat(id).messages.length - 1];
    assertEquals(note.role, "user");
    assert(note.text.includes("restored 1 file"), note.text);
  });
});

Deno.test("an edit of a file changed on disk since it was read is refused", async () => {
  let dir = "";
  let asked = 0;
  // Somebody else changes the file between the read and the edit — a
  // formatter, the user, another tool: here, just before the model's second
  // reply (the edit) arrives.
  const meddle = (url: URL) => {
    if (url.pathname === "/v1/chat/completions" && ++asked === 2) {
      Deno.writeTextFileSync(`${dir}/f.ts`, "const a = 1;\n// user note\n");
    }
    return null;
  };
  await withEngine([
    { toolCalls: [{ id: "r", name: "read", args: '{"path":"f.ts"}' }] },
    {
      toolCalls: [{
        id: "e",
        name: "edit",
        args: JSON.stringify({
          path: "f.ts",
          old_string: "const a = 1;",
          new_string: "const a = 2;",
        }),
      }],
    },
    { text: "ok" },
  ], async (id) => {
    dir = workspace.projects.find((p) => p.id === id)!.path;
    await Deno.writeTextFile(`${dir}/f.ts`, "const a = 1;\n");
    await local.setMode(id, "agent");
    await local.send("bump a", id);
    const tools = localChat(id).messages.filter((m) => m.role === "tool");
    assert(tools[1].text.includes("changed on disk"), tools[1].text);
    // And it says it was not the model: no command of its was running.
    assert(
      tools[1].text.includes("the user or another program"),
      tools[1].text,
    );
    // The user's line survived.
    assert((await Deno.readTextFile(`${dir}/f.ts`)).includes("user note"));
  }, meddle);
});

Deno.test("a file the model's own command changed is named as its own doing", async () => {
  // Told only "it changed on disk", a live session concluded "the user
  // updated files, I have been reading stale versions" and re-read eight
  // files — after its own `cp` had replaced the one it went to write.
  await withEngine([
    { toolCalls: [{ id: "r", name: "read", args: '{"path":"f.ts"}' }] },
    {
      toolCalls: [{
        id: "c",
        name: "sh",
        args: JSON.stringify({ cmd: "sleep 0.05; cp template.ts f.ts" }),
      }],
    },
    {
      toolCalls: [{
        id: "w",
        name: "write",
        args: JSON.stringify({
          path: "f.ts",
          content: "export const a = 2;\n",
        }),
      }],
    },
    { text: "ok" },
  ], async (id) => {
    const dir = workspace.projects.find((p) => p.id === id)!.path;
    await Deno.writeTextFile(`${dir}/f.ts`, "export const a = 1;\n");
    await Deno.writeTextFile(`${dir}/template.ts`, "// from the template\n");
    await local.setMode(id, "agent");
    await local.setPermission(id, "bypass");
    await local.send("replace f.ts", id);
    const refused = localChat(id).messages.filter((m) => m.role === "tool")[2];
    assert(refused.text.includes("your own command"), refused.text);
    assert(refused.text.includes("cp template.ts f.ts"), refused.text);
    assert(!refused.text.includes("the user or another"), refused.text);
  });
});

Deno.test("two edits of one file in one round both land", async () => {
  await withEngine([
    { toolCalls: [{ id: "r", name: "read", args: '{"path":"f.ts"}' }] },
    {
      toolCalls: [
        {
          id: "e1",
          name: "edit",
          args: JSON.stringify({
            path: "f.ts",
            old_string: "a = 1",
            new_string: "a = 10",
          }),
        },
        {
          id: "e2",
          name: "edit",
          args: JSON.stringify({
            path: "f.ts",
            old_string: "b = 2",
            new_string: "b = 20",
          }),
        },
      ],
    },
    { text: "both" },
  ], async (id) => {
    const dir = workspace.projects.find((p) => p.id === id)!.path;
    await Deno.writeTextFile(`${dir}/f.ts`, "let a = 1;\nlet b = 2;\n");
    await local.setMode(id, "agent");
    await local.send("bump both", id);
    // Run side by side, each would have read the original and the second
    // write would have undone the first.
    assertEquals(
      await Deno.readTextFile(`${dir}/f.ts`),
      "let a = 10;\nlet b = 20;\n",
    );
  });
});

Deno.test("a model that stops at 'let me…' is nudged on, once it has tools", async () => {
  await withEngine([
    { text: "I will look at the files first. Let me list them." },
    { toolCalls: [{ id: "l", name: "ls", args: "{}" }] },
    { text: "Nothing interesting here." },
  ], async (id, requests) => {
    await local.setMode(id, "read");
    await local.send("what is in here?", id);
    assertEquals(requests.length, 3);
    const second = requests[1] as Req;
    assert(
      second.messages.some((m) => m.content.includes("call it now")),
      "no nudge",
    );
    const chat = localChat(id);
    assertEquals(
      chat.messages[chat.messages.length - 1].text,
      "Nothing interesting here.",
    );
  });
});

Deno.test("an empty reply is asked for again, once", async () => {
  await withEngine([
    { text: "" },
    { text: "Here you go." },
  ], async (id, requests) => {
    await local.setMode(id, "read");
    await local.send("hello", id);
    assertEquals(requests.length, 2);
    const chat = localChat(id);
    assertEquals(chat.error, null);
    // The empty reply left no empty bubble behind.
    assertEquals(chat.messages.filter((m) => m.role === "assistant").length, 1);
  });
});

Deno.test("a reply that degenerates into repetition is stopped and retried", async () => {
  await withEngine([
    { text: "Sure. " + "I will fix it now. ".repeat(400) },
    { text: "Fixed: the typo on line 3." },
  ], async (id, requests) => {
    await local.setMode(id, "chat");
    await local.send("fix the typo", id);
    assertEquals(requests.length, 2);
    const second = requests[1] as Req;
    assert(second.messages.some((m) => m.content.includes("repeating")));
    const chat = localChat(id);
    assertEquals(
      chat.messages[chat.messages.length - 1].text,
      "Fixed: the typo on line 3.",
    );
  });
});

Deno.test("a reasoning model's thinking is never stored as its answer, nor sent back", async () => {
  await withEngine([
    { reasoning: "The user wants a greeting.", text: "Hello!" },
    { text: "<think>they asked again</think>Hello again!" },
  ], async (id, requests) => {
    await local.setMode(id, "chat");
    await local.send("hi", id);
    await local.send("hi again", id);
    const chat = localChat(id);
    const said = chat.messages.filter((m) => m.role === "assistant").map((m) =>
      m.text
    );
    assertEquals(said, ["Hello!", "Hello again!"]);
    assertEquals(chat.thinking, "");
    // The second request carries the first answer, not the first thinking.
    const second = requests[1] as Req;
    assert(!JSON.stringify(second.messages).includes("wants a greeting"));
  });
});

Deno.test("every request caps its reply to what the window has left", async () => {
  await withEngine([{ text: "ok" }], async (id, requests) => {
    await local.setMode(id, "chat");
    await local.send("hi", id);
    const first = requests[0] as Req;
    assert(typeof first.max_tokens === "number" && first.max_tokens > 256);
    assert(first.max_tokens! <= localConfig(id).ctx);
  });
});

Deno.test("an overflow that names the real window is retried against it", async () => {
  await withEngine([
    {
      status: 400,
      body:
        '{"error":{"type":"exceed_context_size_error","n_prompt_tokens":9000,"n_ctx":4096}}',
    },
    { text: "fits now" },
  ], async (id, requests) => {
    await local.setMode(id, "chat");
    await local.send("x".repeat(20_000), id);
    const chat = localChat(id);
    assertEquals(chat.error, null);
    assertEquals(chat.messages[chat.messages.length - 1].text, "fits now");
    // The retry was packed for 4096, whatever the setting said.
    const retry = requests[1] as Req;
    assert(retry.max_tokens! < 4_096, `max_tokens ${retry.max_tokens}`);
    assert(JSON.stringify(retry.messages).length < 4_096 * 4, "not repacked");
  });
});

Deno.test("the project's own instructions and layout reach the model", async () => {
  await withEngine([{ text: "noted" }], async (id, requests) => {
    const dir = workspace.projects.find((p) => p.id === id)!.path;
    await Deno.writeTextFile(
      `${dir}/AGENTS.md`,
      "Always use tabs in this repo.",
    );
    await Deno.mkdir(`${dir}/src`);
    await local.setMode(id, "read");
    await local.send("hi", id);
    const sys = (requests[0] as Req).messages[0].content;
    assert(sys.includes("Always use tabs in this repo."), sys);
    assert(sys.includes("src/"), sys);
  });
});

Deno.test("a cold model is loaded before the first pack, and its real window used", async () => {
  // Cold on the first look; loaded on every look after the warm-up.
  let looks = 0;
  const routes = (url: URL) => {
    if (url.pathname !== "/api/v0/models") return null;
    const loaded = ++looks > 1;
    return Response.json({
      data: [
        loaded
          ? {
            id: "test-model",
            state: "loaded",
            max_context_length: 131_072,
            loaded_context_length: 8_192,
          }
          : {
            id: "test-model",
            state: "not-loaded",
            max_context_length: 131_072,
          },
      ],
    });
  };
  await withEngine([
    // The warm-up — a one-token request that loads the model.
    { text: "." },
    { text: "answered at the real window" },
  ], async (id, requests) => {
    await local.setEngine(id, "lmstudio");
    await local.setMode(id, "chat");
    looks = 0; // whatever setEngine's own probes asked, the turn looks afresh
    await local.send("hi", id);
    assertEquals((requests[0] as Req & { max_tokens: number }).max_tokens, 1);
    assertEquals(localConfig(id).ctx, 8_192);
  }, routes);
});

Deno.test('"Don\'t ask" runs commands in a sandbox: the project writable, the rest not', async () => {
  const io = await import("../../cell/local.server.ts");
  if (!await io.sandboxAvailable()) {
    console.warn("bubblewrap unavailable here — sandbox test skipped");
    return;
  }
  const home = Deno.env.get("HOME")!;
  const probe = `${home}/.cc-sandbox-probe-${crypto.randomUUID()}`;
  Deno.env.set("CC_TEST_SECRET_TOKEN", "hunter2");
  try {
    await withEngine([
      {
        toolCalls: [{
          id: "s",
          name: "sh",
          args: JSON.stringify({
            cmd: `echo in > inside.txt; echo out > ${probe}; ` +
              `echo "tok=$CC_TEST_SECRET_TOKEN"; ls ~/.ssh 2>&1 | wc -l`,
          }),
        }],
      },
      { text: "done" },
    ], async (id) => {
      const dir = workspace.projects.find((p) => p.id === id)!.path;
      await local.setMode(id, "agent");
      await local.setPermission(id, "dontAsk");
      await local.send("try it", id);
      const out = localChat(id).messages.find((m) => m.role === "tool")!.text;
      assertEquals(await Deno.readTextFile(`${dir}/inside.txt`), "in\n");
      assertEquals(await Deno.stat(probe).catch(() => null), null, out);
      assert(out.includes("Read-only file system"), out);
      // Credentials are not in its environment.
      assert(out.includes("tok=\n") || out.includes("tok=\r"), out);
      assert(!out.includes("hunter2"), out);
    });
  } finally {
    Deno.env.delete("CC_TEST_SECRET_TOKEN");
    await Deno.remove(probe).catch(() => {});
  }
});

/* ── steering, jobs, and the sandbox's walls ──────────────────────────────── */

/** Wait until `cond` holds (or give up after `ms`). */
async function until(cond: () => boolean, ms = 5_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) {
    await new Promise((r) => setTimeout(r, 10));
  }
}

Deno.test("a message sent while the agent works is delivered at its next step", async () => {
  await withEngine([
    { delayMs: 400, toolCalls: [{ id: "l", name: "ls", args: "{}" }] },
    { text: "Using yarn then, as you said. Done." },
  ], async (id, requests) => {
    await local.setMode(id, "read");
    const turn = local.send("set up the project", id);
    await until(() => requests.length === 1);
    // Typed mid-task — it must neither start a second turn nor be lost.
    await local.send("actually, use yarn, not npm", id);
    assertEquals(localChat(id).queued?.length, 1);
    await turn;
    const second = requests[1] as Req;
    const steer = second.messages.find((m) => m.content.includes("use yarn"));
    assert(steer, "the correction never reached the model");
    assert(steer.content.includes("while you were working"), steer.content);
    assertEquals(requests.length, 2, "a second turn was started");
    assertEquals(localChat(id).queued?.length ?? 0, 0);
    const shown = localChat(id).messages.find((m) =>
      m.text.includes("use yarn")
    );
    assertEquals(shown?.steer, true);
  });
});

Deno.test('"stop" while it works cuts the step short and is answered next', async () => {
  await withEngine([
    // A slow step — a long generation, a two-minute test run.
    { delayMs: 3_000, text: "still going…" },
    { text: "Stopped. I had only looked around; nothing was changed." },
  ], async (id, requests) => {
    await local.setMode(id, "read");
    const t0 = Date.now();
    const turn = local.send("refactor everything", id);
    await until(() => requests.length === 1);
    await local.send("I changed my mind, stop", id);
    await turn;

    await until(() => localChat(id).status === "idle" && requests.length === 2);
    await until(() => localChat(id).status === "idle");
    assert(Date.now() - t0 < 2_900, "waited for the slow step to finish");
    const texts = localChat(id).messages.map((m) => m.text);
    assert(texts.includes("*(stopped)*"), texts.join(" | "));
    assert(texts.includes("I changed my mind, stop"), texts.join(" | "));
    assertEquals(
      texts[texts.length - 1],
      "Stopped. I had only looked around; nothing was changed.",
    );
  });
});

Deno.test("a background job keeps running between commands, and stops on request", async () => {
  await withEngine([
    {
      toolCalls: [{
        id: "b",
        name: "sh",
        args: JSON.stringify({
          cmd: "echo server-up; sleep 30",
          background: true,
        }),
      }],
    },
    { toolCalls: [{ id: "j", name: "sh", args: '{"cmd":"jobs"}' }] },
    { toolCalls: [{ id: "s", name: "sh", args: '{"cmd":"stop-job 1"}' }] },
    { text: "done" },
  ], async (id) => {
    await local.setMode(id, "agent");
    await local.setPermission(id, "bypass");
    await local.send("start the server", id);
    const [started, listed, stopped] = localChat(id).messages.filter((m) =>
      m.role === "tool"
    );
    assert(started.text.includes("background as job 1"), started.text);
    assert(started.text.includes("server-up"), started.text);
    assert(listed.text.includes("job 1: running"), listed.text);
    assert(stopped.text.includes("Stopped 1 job"), stopped.text);
    assertEquals(localChat(id).jobs, 0);
  });
});

Deno.test("Clear stops a conversation's background jobs", async () => {
  await withEngine([
    {
      toolCalls: [{
        id: "b",
        name: "sh",
        args: JSON.stringify({ cmd: "sleep 30", background: true }),
      }],
    },
    { text: "left it running" },
  ], async (id) => {
    const io = await import("../../cell/local.server.ts");
    await local.setMode(id, "agent");
    await local.setPermission(id, "bypass");
    await local.send("run it", id);
    assertEquals(io.runningJobs(id), 1);
    assertEquals(localChat(id).jobs, 1);
    await local.clear(id);
    assertEquals(io.runningJobs(id), 0);
  });
});

Deno.test("what a command leaves running is kept as a job, not killed — and Clear stops it", async () => {
  // Unique enough to find with pgrep, and nothing else runs it.
  const marker = "sleep 3017";
  await withEngine([
    {
      toolCalls: [{
        id: "a",
        name: "sh",
        // Holds the pipe: its output must go on to the job's log.
        args: JSON.stringify({ cmd: `${marker} & echo started` }),
      }],
    },
    { toolCalls: [{ id: "j", name: "sh", args: '{"cmd":"jobs"}' }] },
    { toolCalls: [{ id: "q", name: "sh", args: '{"cmd":"echo quick"}' }] },
    { text: "left it running" },
  ], async (id) => {
    const io = await import("../../cell/local.server.ts");
    await local.setMode(id, "agent");
    await local.setPermission(id, "bypass");
    await local.send("start it", id);
    const [started, listed, quick] = localChat(id).messages.filter((m) =>
      m.role === "tool"
    );
    assert(started.text.includes("started"), started.text);
    assert(started.text.includes("It is job 1"), started.text);
    assert(listed.text.includes("job 1: running"), listed.text);
    // A command that leaves nothing behind is not a job.
    assert(!quick.text.includes("still running"), quick.text);
    assertEquals(io.runningJobs(id), 1);
    const alive = async () =>
      (await new Deno.Command("pgrep", { args: ["-f", marker] }).output())
        .success;
    assert(await alive(), "the program was killed when the command returned");
    await local.clear(id);
    assertEquals(io.runningJobs(id), 0);
    for (let i = 0; i < 30 && await alive(); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    assert(
      !await alive(),
      "Clear did not stop it: " + new TextDecoder().decode(
        (await new Deno.Command("pgrep", { args: ["-af", marker] }).output())
          .stdout,
      ),
    );
  });
});

Deno.test("the sandbox keeps /tmp for the conversation, and has no network and no screen", async () => {
  const io = await import("../../cell/local.server.ts");
  if (!await io.sandboxAvailable()) {
    console.warn("bubblewrap unavailable here — sandbox test skipped");
    return;
  }
  // A listener on this machine: reachable from here, not from the box.
  const probe = Deno.serve(
    { port: 0, onListen: () => {} },
    () => new Response("x"),
  );
  const port = probe.addr.port;
  try {
    await withEngine([
      {
        toolCalls: [{
          id: "a",
          name: "sh",
          args: '{"cmd":"echo kept > /tmp/note"}',
        }],
      },
      { toolCalls: [{ id: "b", name: "sh", args: '{"cmd":"cat /tmp/note"}' }] },
      {
        toolCalls: [{
          id: "c",
          name: "sh",
          args: JSON.stringify({
            cmd:
              `(exec 3<>/dev/tcp/127.0.0.1/${port}) 2>/dev/null && echo NET` +
              ` || echo NONET; echo "display=[$DISPLAY]"; echo "tmpdir=$TMPDIR"`,
          }),
        }],
      },
      { text: "done" },
    ], async (id) => {
      await local.setMode(id, "agent");
      await local.setPermission(id, "dontAsk");
      await local.send("check the box", id);
      const [, kept, walls] = localChat(id).messages.filter((m) =>
        m.role === "tool"
      );
      assert(kept.text.includes("kept"), kept.text);
      assert(walls.text.includes("NONET"), walls.text);
      assert(walls.text.includes("display=[]"), walls.text);
      assert(walls.text.includes("tmpdir=/tmp"), walls.text);
      // …and none of it is in the shared /tmp.
      assertEquals(await Deno.stat("/tmp/note").catch(() => null), null);
    });
  } finally {
    await probe.shutdown();
  }
});

Deno.test("leaving the sandbox is asked about — and only that one command", async () => {
  const io = await import("../../cell/local.server.ts");
  if (!await io.sandboxAvailable()) return;
  await withEngine([
    {
      toolCalls: [{
        id: "o",
        name: "sh",
        args: JSON.stringify({
          cmd: 'echo "display=[$DISPLAY]"',
          dangerouslyDisableSandbox: true, // Claude Code's spelling
        }),
      }],
    },
    { text: "ran it" },
  ], async (id) => {
    await local.setMode(id, "agent");
    await local.setPermission(id, "dontAsk");
    const turn = local.send("open the app", id);
    await until(() => localChat(id).pending !== null);
    assertEquals(localChat(id).pending?.outside, true);
    await local.answer(id, true);
    await turn;
    const out = localChat(id).messages.find((m) => m.role === "tool")!;
    // Outside the box it had the real environment.
    assertEquals(out.text.includes("display=[]"), !Deno.env.get("DISPLAY"));
  });
});

Deno.test("outside the sandbox: looks go unasked, and one yes covers a program for the chat", async () => {
  const io = await import("../../cell/local.server.ts");
  if (!await io.sandboxAvailable()) return;
  const out = (id: string, cmd: string) => ({
    toolCalls: [{
      id,
      name: "sh",
      args: JSON.stringify({ cmd, outside_sandbox: true }),
    }],
  });
  await withEngine([
    out("look", "ps -o pid= -p 1 2>/dev/null | wc -l"),
    out("first", "deno --version 2>&1 | head -1"),
    out("again", "deno --version 2>&1 | head -1"),
    { text: "done" },
  ], async (id) => {
    await local.setMode(id, "agent");
    await local.setPermission(id, "dontAsk");
    let asked = 0;
    const turn = local.send("start it and look", id);
    // Only `deno` is asked about, once; "allow outside" is the answer.
    await until(() => localChat(id).pending !== null);
    asked++;
    assert(
      localChat(id).pending!.cmd.startsWith("deno"),
      localChat(id).pending!.cmd,
    );
    await local.answer(id, true, true, localChat(id).pending!.id);
    await until(() =>
      localChat(id).pending !== null || localChat(id).status === "idle"
    );
    if (localChat(id).pending) asked++;
    await turn;
    assertEquals(asked, 1);
    assertEquals(localConfig(id).outsideAllowed, ["deno"]);
    assertEquals(localConfig(id).permission, "dontAsk");
    const rows = localChat(id).messages.filter((m) => m.role === "tool");
    assert(
      rows.every((m) => !m.text.startsWith("Error")),
      rows.map((m) => m.text).join("\n"),
    );
    // A new mode forgets it.
    await local.setPermission(id, "ask");
    assertEquals(localConfig(id).outsideAllowed, undefined);
  });
});

Deno.test("a look from inside the box, after something ran outside, says the box is blind", async () => {
  // test12: `am instances` in the sandbox said [] and `am status` "stopped"
  // for an app the user was looking at; seven minutes went to restarting it.
  const io = await import("../../cell/local.server.ts");
  if (!await io.sandboxAvailable()) return;
  await withEngine([
    {
      toolCalls: [{
        id: "out",
        name: "sh",
        args: JSON.stringify({ cmd: "true", outside_sandbox: true }),
      }],
    },
    { toolCalls: [{ id: "in", name: "sh", args: '{"cmd":"ps -e | wc -l"}' }] },
    { text: "done" },
  ], async (id) => {
    await local.setMode(id, "agent");
    await local.setPermission(id, "dontAsk");
    await local.send("start it, then look", id);
    const [, look] = localChat(id).messages.filter((m) => m.role === "tool");
    assert(look.text.includes("cannot see anything you started"), look.text);
  });
});

Deno.test("a new project starts in Don't ask when the last conversation did", async () => {
  // test12 opened a new project in Ask, and its first command sat waiting
  // for a click, though every run before it was Don't ask.
  await withEngine([{ text: "ok" }], async (id) => {
    await local.setMode(id, "agent");
    await local.setPermission(id, "dontAsk");
    await local.send("hello", id);
    const dir2 = await Deno.makeTempDir();
    try {
      await workspace.addProject(dir2);
      const id2 = workspace.projects.find((p) => p.path === dir2)!.id;
      await local.setMode(id2, "agent");
      assertEquals(localConfig(id2).permission, "dontAsk");
      // Bypass does not travel.
      await local.setPermission(id, "bypass");
      await local.send("again", id);
      const dir3 = await Deno.makeTempDir();
      try {
        await workspace.addProject(dir3);
        const id3 = workspace.projects.find((p) => p.path === dir3)!.id;
        await local.setMode(id3, "agent");
        assertEquals(permissionOf(localConfig(id3)), "ask");
      } finally {
        await Deno.remove(dir3, { recursive: true });
      }
    } finally {
      await Deno.remove(dir2, { recursive: true });
    }
  });
});

Deno.test("the framework: not patched, not dug through forever, and its pages found by a near name", async () => {
  const base = `${Deno.env.get("HOME")}/.cc-dig-test-${
    crypto.randomUUID().slice(0, 8)
  }`;
  const store = `${base}/lib/aio-versions/v1`;
  await Deno.mkdir(`${store}/docs/testing`, { recursive: true });
  await Deno.mkdir(`${store}/docs/state`, { recursive: true });
  await Deno.mkdir(`${store}/src`, { recursive: true });
  await Deno.writeTextFile(`${store}/docs/testing/cell-testing.md`, "# t\n");
  await Deno.writeTextFile(`${store}/docs/state/cells.md`, "# c\n");
  await Deno.writeTextFile(`${store}/src/air.ts`, "export {};\n");
  const script: Scripted[] = [
    {
      toolCalls: [{
        id: "w",
        name: "write",
        args: JSON.stringify({ path: "app/src/cell.ts", content: "x\n" }),
      }],
    },
    {
      toolCalls: [{
        id: "near",
        name: "read",
        args: '{"path":"app/dep/aio/docs/testing/cells.md"}',
      }],
    },
    {
      toolCalls: [{
        id: "patch",
        name: "edit",
        args: JSON.stringify({
          path: "app/dep/aio/src/air.ts",
          old_string: "export {};",
          new_string: "export { self };",
        }),
      }],
    },
  ];
  // Eight more looks inside it, each a different call.
  for (let i = 0; i < 8; i++) {
    script.push({
      toolCalls: [{
        id: `g${i}`,
        name: "grep",
        args: JSON.stringify({ pattern: `self${i}`, path: "app/dep/aio/src" }),
      }],
    });
  }
  script.push({ text: "worked round it" });
  await withEngine(script, async (id, requests) => {
    const dir = workspace.projects.find((p) =>
      p.path.length > 0 && p.id === id
    )!.path;
    await Deno.mkdir(`${dir}/app/dep`, { recursive: true });
    await Deno.symlink(store, `${dir}/app/dep/aio`);
    await Deno.writeTextFile(
      `${dir}/app/deno.json`,
      JSON.stringify({ imports: { aio: "./dep/aio/mod.ts" } }),
    );
    await local.setMode(id, "agent");
    await local.setPermission(id, "bypass");
    await local.send("build it", id);
    const [, near, patch] = localChat(id).messages.filter((m) =>
      m.role === "tool"
    );
    // A near name in the folder beside it, not only the same name elsewhere.
    assert(
      near.text.includes("app/dep/aio/docs/testing/cell-testing.md"),
      near.text,
    );
    // Not patched, and told the way round.
    assert(patch.text.includes("not yours to change"), patch.text);
    assertEquals(
      await Deno.readTextFile(`${store}/src/air.ts`),
      "export {};\n",
    );
    // Eight looks after a change: decide.
    const said = requests.map((r) =>
      JSON.stringify(r).includes("Stop digging")
    );
    assert(said.some(Boolean), "never told to stop digging");
    assertEquals(said.filter(Boolean).length, 1, "told more than once");
  }).finally(() => Deno.remove(base, { recursive: true }).catch(() => {}));
});

Deno.test("no credential ever reaches a command, approved or not", async () => {
  Deno.env.set("CC_TEST_FAKE_API_KEY", "sk-must-never-appear");
  Deno.env.set("CC_TEST_PLAIN", "ordinary");
  try {
    await withEngine([
      {
        toolCalls: [{
          id: "e",
          name: "sh",
          args: JSON.stringify({ cmd: "env | grep CC_TEST_ || true" }),
        }],
      },
      { text: "done" },
    ], async (id) => {
      await local.setMode(id, "agent");
      await local.setPermission(id, "bypass");
      await local.send("show me the environment", id);
      const out = localChat(id).messages.find((m) => m.role === "tool")!;
      // "I allow this command" is not "and hand over every token I have":
      // the output goes into the transcript, onto disk, and to the model.
      assert(!out.text.includes("sk-must-never-appear"), out.text);
      assert(out.text.includes("ordinary"), out.text);
    });
  } finally {
    Deno.env.delete("CC_TEST_FAKE_API_KEY");
    Deno.env.delete("CC_TEST_PLAIN");
  }
});

Deno.test("without a sandbox, Don't ask asks", async () => {
  // The mode's whole promise is that nobody has to watch. Take the box away
  // and the promise rests on reading the command's words — which is not a
  // boundary at all (`\\rm -rf ~`, `X=rm; $X -rf ~`, an eval of base64).
  const io = await import("../../cell/local.server.ts");
  await withEngine([
    {
      toolCalls: [{
        id: "s",
        name: "sh",
        args: JSON.stringify({ cmd: "echo plain-and-harmless" }),
      }],
    },
    { text: "ran it" },
  ], async (id) => {
    await local.setMode(id, "agent");
    await local.setPermission(id, "dontAsk");
    const turn = local.send("run something ordinary", id);
    if (await io.sandboxAvailable()) {
      // Boxed: an ordinary command runs unattended, as the mode promises.
      await turn;
      assertEquals(localChat(id).pending, null);
    } else {
      await until(() => localChat(id).pending !== null);
      // Asked as a plain command, not as "it wants to leave the sandbox" —
      // there is no sandbox here to leave.
      assertEquals(localChat(id).pending?.outside, false);
      await local.answer(id, true, false, localChat(id).pending!.id);
      await turn;
    }
    const out = localChat(id).messages.find((m) => m.role === "tool")!;
    assert(out.text.includes("plain-and-harmless"), out.text);
  });
});

Deno.test("a missing file suggests the same name elsewhere in the project", async () => {
  await withEngine([
    { toolCalls: [{ id: "r", name: "read", args: '{"path":"src/cell.ts"}' }] },
    { text: "ok" },
  ], async (id) => {
    const dir = workspace.projects.find((p) => p.id === id)!.path;
    await Deno.mkdir(`${dir}/app/src`, { recursive: true });
    await Deno.mkdir(`${dir}/old/src`, { recursive: true });
    await Deno.writeTextFile(`${dir}/app/src/cell.ts`, "x");
    await Deno.writeTextFile(`${dir}/old/src/cell.ts`, "y");
    await local.setMode(id, "read");
    await local.send("read the cell", id);
    const t = localChat(id).messages.find((m) => m.role === "tool")!;
    // Two of them: which one is the model's to say.
    assert(t.text.includes("Did you mean:"), t.text);
    assert(t.text.includes("app/src/cell.ts"), t.text);
    assert(t.text.includes("old/src/cell.ts"), t.text);
  });
});

Deno.test("a mistyped folder with one file of that name is read, and says so", async () => {
  // A live session asked for `pomo/src/App.tsx` five times, was told "Did you
  // mean: pomodoro/src/App.tsx?" five times, and lost its turn to the loop
  // guard. One file of the very name asked for is not a question.
  const typo = JSON.stringify({ path: "pomo/src/App.tsx" });
  await withEngine([
    { toolCalls: [{ id: "r1", name: "read", args: typo }] },
    { text: "ok" },
  ], async (id) => {
    const dir = workspace.projects.find((p) => p.id === id)!.path;
    await Deno.mkdir(`${dir}/pomodoro/src`, { recursive: true });
    await Deno.writeTextFile(`${dir}/pomodoro/src/App.tsx`, "export {};\n");
    await Deno.writeTextFile(`${dir}/pomodoro/src/app.ts`, "run();\n");
    await local.setMode(id, "read");
    await local.send("read the ui", id);
    const t = localChat(id).messages.find((m) => m.role === "tool")!;
    assert(t.text.includes("1\texport {};"), t.text);
    assert(t.text.includes("pomo/src/App.tsx does not exist"), t.text);
    assert(t.text.includes("Use pomodoro/src/App.tsx from now on"), t.text);
    assert(!t.text.startsWith("Error"), t.text);
  });
});

Deno.test("a missing framework page is looked for inside the framework", async () => {
  // A live session was offered `../../../.local/lib/aio-versions/…` for a
  // near miss, and nothing at all — twice — for a page that sat one folder
  // over, because the name search began at the project root and never
  // crosses a link. Dotted dir under the real $HOME: what users have.
  const base = `${Deno.env.get("HOME")}/.cc-suggest-test-${
    crypto.randomUUID().slice(0, 8)
  }`;
  const store = `${base}/lib/aio-versions/v1`;
  await Deno.mkdir(`${store}/docs/testing`, { recursive: true });
  await Deno.mkdir(`${store}/docs/state`, { recursive: true });
  await Deno.mkdir(`${store}/docs/ui`, { recursive: true });
  await Deno.writeTextFile(`${store}/docs/testing/cell-testing.md`, "# t\n");
  await Deno.writeTextFile(`${store}/docs/ui/air-reference.md`, "# air\n");
  await Deno.mkdir(`${store}/src/adapters`, { recursive: true });
  await Deno.writeTextFile(`${store}/src/adapters/air.ts`, "export {};\n");
  await Deno.writeTextFile(`${store}/src/air.ts`, "export {};\n");
  await Deno.writeTextFile(`${store}/mod.ts`, "export {};\n");
  // Five `mod.ts` one level down, as aio has: a subtree walk fills the list
  // with them before it ever looks at the folder above.
  for (const sub of ["db", "diagnostics", "extras", "sync", "ui"]) {
    await Deno.mkdir(`${store}/src/${sub}`, { recursive: true });
    await Deno.writeTextFile(`${store}/src/${sub}/mod.ts`, "export {};\n");
  }
  await withEngine([
    {
      toolCalls: [
        {
          id: "a",
          name: "read",
          args: '{"path":"app/dep/aio/docs/state/cell-testing.md"}',
        },
        {
          id: "b",
          name: "read",
          args: '{"path":"app/dep/aio/docs/ui/air.md"}',
        },
        // Spelled as if it were the app's own file.
        { id: "c", name: "read", args: '{"path":"app/src/adapters/air.ts"}' },
        // ls of the framework's docs from the folder above the app.
        { id: "e", name: "ls", args: '{"path":"dep/aio/docs"}' },
        // grep on a file one folder off: the entry point is at the root.
        {
          id: "d",
          name: "grep",
          args: '{"pattern":"self","path":"app/dep/aio/src/mod.ts"}',
        },
      ],
    },
    { text: "ok" },
  ], async (id) => {
    const dir = workspace.projects.find((p) => p.id === id)!.path;
    await Deno.mkdir(`${dir}/app/dep`, { recursive: true });
    await Deno.symlink(store, `${dir}/app/dep/aio`);
    await Deno.writeTextFile(
      `${dir}/app/deno.json`,
      JSON.stringify({ imports: { aio: "./dep/aio/mod.ts" } }),
    );
    await local.setMode(id, "read");
    await local.send("read the testing docs", id);
    const [moved, near, own, listed, grepped] = localChat(id).messages.filter((
      m,
    ) => m.role === "tool");
    assert(
      grepped.text.includes("Not found: app/dep/aio/src/mod.ts"),
      grepped.text,
    );
    assert(
      grepped.text.includes("Did you mean: app/dep/aio/mod.ts,"),
      grepped.text,
    );
    assert(listed.text.includes("Not found: dep/aio/docs"), listed.text);
    assert(!listed.text.includes("os error"), listed.text);
    // The only file of that name where it was meant: read, not asked about.
    assert(
      own.text.includes("this is app/dep/aio/src/adapters/air.ts"),
      own.text,
    );
    assert(
      moved.text.includes("this is app/dep/aio/docs/testing/cell-testing.md"),
      moved.text,
    );
    assert(
      near.text.includes("app/dep/aio/docs/ui/air-reference.md"),
      near.text,
    );
    for (const t of [moved, near, grepped]) {
      assert(!t.text.includes(".local"), t.text);
    }
  }).finally(() => Deno.remove(base, { recursive: true }).catch(() => {}));
});

/** Paths to every `undefined` in a value — what aio refuses to persist. */
function undefinedPaths(v: unknown, at = "$"): string[] {
  if (v === undefined) return [at];
  if (!v || typeof v !== "object") return [];
  return Object.entries(v as Record<string, unknown>).flatMap(([k, x]) =>
    undefinedPaths(x, `${at}.${k}`)
  );
}

Deno.test("a conversation's state is always persistable — no undefined anywhere", async () => {
  // A project with no manifests had `env.toolchain: undefined`, and aio then
  // refused to save the local cell at all: every change stayed in memory.
  await withEngine([
    { toolCalls: [{ id: "l", name: "ls", args: "{}" }] },
    { text: "done" },
  ], async (id) => {
    await local.setMode(id, "read");
    await local.send("look", id);
    assertEquals(undefinedPaths(localChat(id)), []);
    assertEquals(undefinedPaths(localConfig(id)), []);
  });
});

Deno.test("a sandboxed background job keeps what its command started", async () => {
  const io = await import("../../cell/local.server.ts");
  if (!await io.sandboxAvailable()) return;
  await withEngine([
    {
      toolCalls: [{
        id: "b",
        name: "sh",
        // Starts something and returns at once — `am start`'s shape.
        args: JSON.stringify({
          cmd: "(sleep 30 &); echo launched",
          background: true,
        }),
      }],
    },
    { text: "ok" },
  ], async (id) => {
    await local.setMode(id, "agent");
    await local.setPermission(id, "dontAsk");
    await local.send("start it", id);
    const t = localChat(id).messages.find((m) => m.role === "tool")!;
    assert(t.text.includes("Started in the background as job 1"), t.text);
    assert(t.text.includes("launched"), t.text);
    // …and it says where it runs: a live session told "just run it" started
    // the app in the box, where no window can ever open.
    assert(t.text.includes("no window can open"), t.text);
    assert(
      t.text.includes("outside_sandbox: true and background: true"),
      t.text,
    );
    // The job stays up after its command returned…
    await new Promise((r) => setTimeout(r, 300));
    assertEquals(io.runningJobs(id), 1);
    io.stopJobs(id);
    assertEquals(io.runningJobs(id), 0);
  });
});

/** The same path in another conversation's temp. */
const other = (log: string) =>
  log.replace(/\/outside-[^/]+\//, "/someone-else/");

Deno.test("a job run outside the box: its log is readable where it says, and the box is told it cannot see it", async () => {
  // A live session was told "read it with: cat /home/…/tmp/job-1.log" and was
  // refused three times as "outside the project"; it asked the sandbox
  // `am instances`, got [], and started a second copy of a running app.
  const io = await import("../../cell/local.server.ts");
  const cwd = await Deno.makeTempDir();
  const key = `outside-${crypto.randomUUID().slice(0, 8)}`;
  try {
    const started = await io.runTool(
      "agent",
      cwd,
      "sh",
      JSON.stringify({
        cmd: "echo launched-outside; timeout 30 sleep 30",
        background: true,
      }),
      { key, permission: "dontAsk", outside: true, ctx: 32_768 },
    );
    const log = /read it with: cat (\S+)\./.exec(started)?.[1] ?? "";
    assert(log.includes(key) && log.endsWith("job-1.log"), started);
    // `cat` of that log, outside, is a look: test13 was asked about it,
    // because the app's data directory counted as a hidden place.
    assert(
      mayLeaveUnasked(`cat ${log} | tail -40`, [], io.lookEnv(key)),
      io.lookEnv(key).own?.join(),
    );
    assert(!mayLeaveUnasked(`cat ${other(log)}`, [], io.lookEnv(key)));
    const read = await io.runTool(
      "agent",
      cwd,
      "read",
      JSON.stringify({ path: log }),
      { key, permission: "dontAsk", ctx: 32_768 },
    );
    assert(read.includes("launched-outside"), read);
    // Somebody else's conversation temp stays out of reach.
    const refused = await io.runTool(
      "agent",
      cwd,
      "read",
      JSON.stringify({ path: other(log) }),
      { key, permission: "dontAsk", ctx: 32_768 },
    );
    assert(refused.startsWith("Error"), refused);
    if (await io.sandboxAvailable()) {
      assert(
        started.includes("commands you run inside it cannot see"),
        started,
      );
      // An app the user is to check is not started on a deadline.
      assert(started.includes("timeout 30 will close this program"), started);
    }
  } finally {
    io.stopJobs(key);
    io.forgetFiles(key);
    await Deno.remove(cwd, { recursive: true });
  }
});

Deno.test("a job in the box is said to be unreachable, by the user and by the next command", async () => {
  // test13 curled a server in a boxed job three times, "connection refused"
  // each time: the note said "nobody but you can see this program", and
  // each boxed command has a network of its own.
  const io = await import("../../cell/local.server.ts");
  if (!await io.sandboxAvailable()) return;
  const cwd = await Deno.makeTempDir();
  const key = `boxjob-${crypto.randomUUID().slice(0, 8)}`;
  try {
    const started = await io.runTool(
      "agent",
      cwd,
      "sh",
      JSON.stringify({ cmd: "echo up", background: true }),
      { key, permission: "dontAsk", ctx: 32_768 },
    );
    assert(!started.includes("nobody but you"), started);
    assert(started.includes("nor by your other commands"), started);
    assert(started.includes("the step the user asked for"), started);
  } finally {
    io.stopJobs(key);
    io.forgetFiles(key);
    await Deno.remove(cwd, { recursive: true });
  }
});

Deno.test("a command's PATH carries no package bin of this app's own", () => {
  // test13: `which electron` in the sandbox answered with cc's own Electron,
  // because cc was started by a task runner from its repo.
  return import("../../cell/local.server.ts").then((io) => {
    const env = io.scrubbedEnv({
      PATH: "/home/u/code/cc/node_modules/.bin:/home/u/.deno/bin:/usr/bin",
      HOME: "/home/u",
    });
    assertEquals(env.PATH, "/home/u/.deno/bin:/usr/bin");
    assertEquals(env.HOME, "/home/u");
  });
});

Deno.test("a wasted command shape is answered before anyone is asked", async () => {
  await withEngine([
    {
      toolCalls: [{
        id: "dev",
        name: "sh",
        args: JSON.stringify({
          cmd: "timeout 90 deno task dev --client=electron 2>&1 | head -40",
        }),
      }],
    },
    { text: "ok, in the background then" },
  ], async (id) => {
    await local.setMode(id, "agent");
    await local.setPermission(id, "ask");
    const turn = local.send("run it", id);
    let asked = false;
    await until(() => {
      if (localChat(id).pending) asked = true;
      return localChat(id).pending !== null ||
        localChat(id).status === "idle";
    });
    if (localChat(id).pending) {
      await local.answer(id, false, false, localChat(id).pending!.id);
    }
    await turn;
    assertEquals(asked, false, "asked the user to approve a wait");
    const t = localChat(id).messages.find((m) => m.role === "tool")!;
    assert(t.text.startsWith("Error: not run — `deno task dev`"), t.text);
  });
});

Deno.test("the same check failing again and again earns one step-back note", async () => {
  // test13: one type-check ran eleven times, each fix exposing the next
  // error, and at the eighth it was back at an error from four runs before.
  const check =
    'cd . && printf "Check src/cell.ts\\n%s\\nEXIT: 1\\n" "$(cat err.txt)"';
  const round = (i: number, err: string) => [
    {
      toolCalls: [{
        id: `w${i}`,
        name: "write",
        args: JSON.stringify({ path: "err.txt", content: err }),
      }],
    },
    {
      toolCalls: [{
        id: `c${i}`,
        name: "sh",
        args: JSON.stringify({ cmd: check }),
      }],
    },
  ];
  await withEngine([
    ...round(0, "TS2322 [ERROR]: Type 'A' is not assignable to 'B'."),
    ...round(1, "TS2339 [ERROR]: Property '$do' does not exist."),
    ...round(2, "TS2339 [ERROR]: Property '$call' does not exist."),
    ...round(3, "TS2322 [ERROR]: Type 'A' is not assignable to 'B'."),
    ...round(4, "TS2304 [ERROR]: Cannot find name 'Draft'."),
    ...round(5, "TS2304 [ERROR]: Cannot find name 'Draft'."),
    { text: "stepped back" },
  ], async (id, requests) => {
    await local.setMode(id, "agent");
    await local.setPermission(id, "bypass");
    await local.send("fix the types", id);
    const said = requests.map((r) => JSON.stringify(r).includes("Step back"));
    const first = said.indexOf(true);
    // Said after the fourth run — the error from the first is back — and once.
    assert(first > 0, "never told to step back");
    assert(
      JSON.stringify(requests[first]).includes("an error you already had"),
      JSON.stringify(requests[first]).slice(-800),
    );
    assertEquals(said.filter(Boolean).length, 1, "told more than once");
    assertEquals(first, 8, "not said right after the fourth run");
  });
});

Deno.test("tests that have become the task are called out once", async () => {
  // test16: the program was type-clean at 7.6 minutes; twenty more went to
  // tests nobody asked for, with no single check failing four times in a row.
  const round = (i: number) => [
    {
      toolCalls: [{
        id: `w${i}`,
        name: "write",
        args: JSON.stringify({
          path: "tests/timer.test.ts",
          content: `// attempt ${i}\n`,
        }),
      }],
    },
    {
      toolCalls: [{
        id: `t${i}`,
        name: "sh",
        // A different failure each time: not the stuck-check shape.
        args: JSON.stringify({
          cmd: `echo "FAILED | 0 passed | ${
            i + 1
          } failed"; echo npm test; exit 1`,
        }),
      }],
    },
  ];
  const script = [];
  for (let i = 0; i < 11; i++) script.push(...round(i));
  script.push({ text: "dropped the failing tests" });
  await withEngine(script, async (id, requests) => {
    await local.setMode(id, "agent");
    await local.setPermission(id, "bypass");
    await local.send("make a timer", id);
    const said = requests.map((r) =>
      JSON.stringify(r).includes("on tests without a passing run")
    );
    assert(said.some(Boolean), "never told");
    assertEquals(said.filter(Boolean).length, 1, "told more than once");
    // After the tenth round of test work, not before.
    assertEquals(said.indexOf(true), 10);
  });
});

Deno.test("a passing test run ends the stretch", async () => {
  const script = [];
  for (let i = 0; i < 12; i++) {
    script.push({
      toolCalls: [{
        id: `w${i}`,
        name: "write",
        args: JSON.stringify({ path: "a.test.ts", content: `// ${i}\n` }),
      }],
    });
    if (i % 3 === 2) {
      script.push({
        toolCalls: [{
          id: `t${i}`,
          name: "sh",
          args: JSON.stringify({
            cmd: 'echo "ok | 3 passed | 0 failed" # npm test',
          }),
        }],
      });
    }
  }
  script.push({ text: "done" });
  await withEngine(script, async (id, requests) => {
    await local.setMode(id, "agent");
    await local.setPermission(id, "bypass");
    await local.send("add tests", id);
    assert(
      !JSON.stringify(requests).includes("on tests without a passing run"),
      "a passing suite was called a stretch",
    );
  });
});

Deno.test("llama.cpp is sent a thinking budget; nothing else is", async () => {
  // test16 waited two minutes each on replies of 7,000–10,000 thinking tokens.
  await withEngine(
    [{ text: "hi" }, { text: "hi again" }],
    async (id, requests) => {
      await local.setMode(id, "chat");
      await local.send("hello", id);
      const body = requests[requests.length - 1] as Record<string, unknown>;
      assertEquals(localConfig(id).engine, "llamacpp");
      assertEquals(body.thinking_budget_tokens, 4_096);
      Deno.env.set("CC_THINK_BUDGET", "0");
      try {
        await local.send("again", id);
        const off = requests[requests.length - 1] as Record<string, unknown>;
        assertEquals(off.thinking_budget_tokens, undefined);
      } finally {
        Deno.env.delete("CC_THINK_BUDGET");
      }
    },
  );
});

Deno.test("the thinking budget is a minute of this model's own writing speed", async () => {
  // test2: a dense 27B at 17 tokens/s took four minutes to think 4,096 tokens.
  const slow = {
    cache_n: 900,
    prompt_n: 100,
    prompt_ms: 400,
    predicted_n: 2_000,
    predicted_ms: 100_000,
  };
  await withEngine(
    [{ text: "hi", timings: slow }, { text: "hi again" }],
    async (id, requests) => {
      await local.setMode(id, "chat");
      await local.send("hello", id);
      // Nothing measured yet: the ceiling.
      assertEquals(
        (requests[0] as Record<string, unknown>).thinking_budget_tokens,
        4_096,
      );
      await local.send("again", id);
      // 20 tokens/s × 60 s.
      assertEquals(
        (requests[1] as Record<string, unknown>).thinking_budget_tokens,
        1_200,
      );
    },
  );
});

Deno.test("a budget from a speed: a minute of it, never under 1,024 or over 4,096", async () => {
  const { budgetFor } = await import("../../cell/local.server.ts");
  assertEquals(budgetFor(undefined, 60), 4_096);
  assertEquals(budgetFor(0, 60), 4_096);
  assertEquals(budgetFor(17, 60), 1_024);
  assertEquals(budgetFor(30, 60), 1_800);
  assertEquals(budgetFor(79, 60), 4_096);
});

Deno.test("llama.cpp's timings are read from the chunk that has them, and only that one", async () => {
  const { replyTimings } = await import("../../cell/local.server.ts");
  assertEquals(replyTimings({ choices: [] }), null);
  assertEquals(replyTimings(null), null);
  assertEquals(
    replyTimings({
      timings: {
        cache_n: 5,
        prompt_n: 2,
        prompt_ms: 10,
        predicted_n: 7,
        predicted_ms: "x",
      },
    }),
    { cached: 5, read: 2, readMs: 10, wrote: 7, writeMs: 0 },
  );
});

/* ── the Stop button ──────────────────────────────────────────────────────── */

Deno.test("the Stop button sends nothing more, and keeps what was typed meanwhile", async () => {
  await withEngine([
    { delayMs: 3_000, text: "still going…" },
    { text: "must never be asked for" },
  ], async (id, requests) => {
    await local.setMode(id, "read");
    const turn = local.send("refactor everything", id);
    await until(() => requests.length === 1);
    await local.send("and rename the module too", id);
    assertEquals(localChat(id).queued?.length, 1);
    await local.stop(id);
    await turn;
    await new Promise((r) => setTimeout(r, 100));
    assertEquals(requests.length, 1, "Stop sent another request");
    const chat = localChat(id);
    assertEquals(chat.status, "idle");
    assertEquals(chat.queued?.length ?? 0, 0);
    const texts = chat.messages.map((m) => m.text);
    // Said, kept where it was said, and not acted on.
    const typed = chat.messages.find((m) => m.text.includes("rename the"));
    assertEquals(typed?.steer, true);
    assertEquals(texts[texts.length - 1], "*(stopped)*");
  });
});

Deno.test("after Stop, the rest of a batch of calls is answered, not run", async () => {
  await withEngine([
    {
      toolCalls: [
        { id: "a", name: "sh", args: JSON.stringify({ cmd: "sleep 3" }) },
        {
          id: "b",
          name: "write",
          args: JSON.stringify({ path: "late.txt", content: "no" }),
        },
      ],
    },
    { text: "must never be asked for" },
  ], async (id, requests) => {
    const dir = workspace.projects.find((p) => p.id === id)!.path;
    await local.setMode(id, "agent");
    await local.setPermission(id, "bypass");
    const t0 = Date.now();
    const turn = local.send("do both", id);
    await until(() =>
      localChat(id).messages.some((m) => m.toolCalls?.length === 2)
    );
    await new Promise((r) => setTimeout(r, 200));
    await local.stop(id);
    await turn;
    assert(Date.now() - t0 < 2_800, "the command was not killed");
    assertEquals(requests.length, 1);
    const wrote = await Deno.stat(`${dir}/late.txt`).then(
      () => true,
      () => false,
    );
    assertEquals(wrote, false, "a write ran after Stop");
    const results = localChat(id).messages.filter((m) => m.role === "tool");
    // Every call is still answered — the next request needs a result for each.
    assertEquals(results.length, 2);
    assert(results[1].text.includes("Stop"), results[1].text);
  });
});

Deno.test("a Stop that lands before the run registers still stops it", async () => {
  const io = await import("../../cell/local.server.ts");
  // Without a turn known to be starting, nothing is kept for later.
  io.stopRun("early-stop");
  const clean = io.beginRun("early-stop");
  assertEquals(clean.aborted, false, "a Stop with no turn poisoned the next");
  io.endRun("early-stop", clean);
  io.stopRun("early-stop", true);
  assert(io.beginRun("early-stop").aborted, "the early Stop was lost");
  // Consumed: the next turn starts clean.
  const next = io.beginRun("early-stop");
  assertEquals(next.aborted, false);
  io.endRun("early-stop", next);
  // And one that is never consumed dies with its turn, not the next one.
  io.stopRun("early-stop", true);
  io.endRun("early-stop", next);
  assertEquals(io.beginRun("early-stop").aborted, false);
});

/* ── saved history ────────────────────────────────────────────────────────── */

Deno.test("what Clear takes off the screen, history can still find", async () => {
  await withEngine([
    { text: "Noted: the codeword is PELICAN-42." },
    {
      toolCalls: [{
        id: "h",
        name: "history",
        args: JSON.stringify({ query: "codeword" }),
      }],
    },
    { text: "It was PELICAN-42." },
  ], async (id) => {
    await local.setMode(id, "read");
    await local.send("remember the codeword PELICAN-42", id);
    await local.clear(id);
    assertEquals(localChat(id).messages.length, 0);
    // The save runs in the background; give it its moment.
    await new Promise((r) => setTimeout(r, 200));
    await local.send("what was the codeword?", id);
    const result = localChat(id).messages.find((m) => m.role === "tool");
    assert(result?.text.includes("PELICAN-42"), result?.text);
  });
});

Deno.test("history never searches another project's conversations", async () => {
  const io = await import("../../cell/local.server.ts");
  await io.saveRows("elsewhere-key", "/some/other/project", [{
    id: "x1",
    role: "user",
    text: "the secret of the other project is OSPREY-7",
    at: Date.now(),
  }]);
  await withEngine([
    {
      toolCalls: [{
        id: "h",
        name: "history",
        args: JSON.stringify({ query: "OSPREY" }),
      }],
    },
    { text: "Nothing found." },
  ], async (id) => {
    await local.setMode(id, "read");
    await local.send("search for osprey", id);
    const result = localChat(id).messages.find((m) => m.role === "tool");
    assert(result, "no history call ran");
    assert(!result.text.includes("OSPREY-7"), result.text);
  });
});

Deno.test("an idle chat off screen parks on disk, and comes back whole", async () => {
  await withEngine([
    { text: "Hello — noted." },
    { text: "Still here." },
  ], async (id) => {
    await local.setMode(id, "chat");
    await local.send("first words", id);
    const before = localChat(id).messages.map((m) => m.text);
    // Another project takes the screen; this chat is now off it.
    const other = await Deno.makeTempDir();
    try {
      await workspace.addProject(other);
      await until(() => workspace.activeId !== id);
      assert(PARK_AFTER_MS > 0);
      await local.parkIdle(0);
      assertEquals(localChat(id).messages.length, 0);
      assertEquals(localChat(id).parked?.rows, before.length);

      await local.unpark(id);
      assertEquals(localChat(id).parked, null);
      assertEquals(localChat(id).messages.map((m) => m.text), before);

      // Parked again — and written to: it comes back first, in order.
      await local.parkIdle(0);
      assert(localChat(id).parked, "did not park the second time");
      await local.send("second words", id);
      const texts = localChat(id).messages.map((m) => m.text);
      assertEquals(texts.slice(0, before.length), before);
      assertEquals(texts.slice(before.length), ["second words", "Still here."]);
    } finally {
      await Deno.remove(other, { recursive: true });
    }
  });
});

Deno.test("the chat on screen, or one in use, is never parked", async () => {
  await withEngine([{ text: "hi" }], async (id) => {
    await local.setMode(id, "chat");
    await local.send("hello", id);
    await until(() => workspace.activeId === id);
    await local.parkIdle(0);
    assertEquals(localChat(id).parked ?? null, null);
    assertEquals(localChat(id).messages.length, 2);
  });
});

/* ── a turn winding down after Clear (found in review) ────────────────────── */

Deno.test("Clear during a command: the old turn writes nothing into the new chat", async () => {
  await withEngine([
    {
      toolCalls: [
        { id: "a", name: "sh", args: JSON.stringify({ cmd: "sleep 3" }) },
        { id: "b", name: "ls", args: "{}" },
      ],
    },
    { text: "never" },
  ], async (id) => {
    await local.setMode(id, "agent");
    await local.setPermission(id, "bypass");
    const turn = local.send("do it", id);
    await until(() =>
      localChat(id).messages.some((m) => m.toolCalls?.length === 2)
    );
    await new Promise((r) => setTimeout(r, 200));
    await local.clear(id);
    await turn;
    await new Promise((r) => setTimeout(r, 100));
    assertEquals(localChat(id).messages.map((m) => m.text), []);
    // …which is also what lets Undo work.
    await local.undoClear(id);
    assert(localChat(id).messages.length > 0, "Undo brought nothing back");
  });
});

Deno.test("Clear during compaction: the new chat starts with no summary", async () => {
  const big = Array.from({ length: 1_600 }, (_, i) => `w${i * 7919 % 10007}`)
    .join(" ");
  await withEngine([
    { text: "first answer. " + big },
    { delayMs: 2_000, text: "A compact summary." }, // the summarize call
    { text: "second answer" },
  ], async (id, requests) => {
    await local.setMode(id, "chat");
    await local.setCtx(id, 4_096);
    await local.send(big, id);
    const turn = local.send("and now?", id);
    await until(() => requests.length === 2);
    await new Promise((r) => setTimeout(r, 200));
    await local.clear(id);
    await turn;
    assertEquals(localChat(id).summary, "");
    assertEquals(localChat(id).messages.length, 0);
  });
});

Deno.test("a stop typed after the turn ended does not kill the next turn", async () => {
  await withEngine([{ text: "one" }, { text: "two" }], async (id, requests) => {
    await local.setMode(id, "chat");
    await local.send("first", id);
    const io = await import("../../cell/local.server.ts");
    io.stopRun(id); // no turn is starting: nothing may be kept for later
    await local.send("second", id);
    assertEquals(requests.length, 2, "the next turn was stopped unasked");
    assertEquals(localChat(id).messages.at(-1)?.text, "two");
  });
});

Deno.test("an unreadable parked chat is kept aside, said so, and never overwritten", async () => {
  await withEngine([{ text: "Hello" }, { text: "reply2" }], async (id) => {
    await local.setMode(id, "chat");
    await local.send("first words ORIGINAL", id);
    const other = await Deno.makeTempDir();
    try {
      await workspace.addProject(other);
      await until(() => workspace.activeId !== id);
      await local.parkIdle(0);
      assert(localChat(id).parked, "did not park");
      const root = Deno.env.get("CC_HISTORY_ROOT")!;
      const name = [...Deno.readDirSync(`${root}/parked`)]
        .map((e) => e.name).find((n) => n.startsWith(id));
      const file = `${root}/parked/${name}`;
      Deno.writeTextFileSync(file, "{ damaged");
      await local.send("second", id);
      const texts = localChat(id).messages.map((m) => m.text);
      // Said in the chat, before the new message, and the turn carried on.
      assert(texts[0].includes("could not be read back"), texts.join(" | "));
      assertEquals(texts.slice(1), ["second", "reply2"]);
      // The damaged file was moved aside, not left to be overwritten.
      const kept = [...Deno.readDirSync(`${root}/parked`)]
        .map((e) => e.name).filter((n) =>
          n.startsWith(`${id}.json.unreadable`)
        );
      assertEquals(kept.length, 1);
    } finally {
      await Deno.remove(other, { recursive: true });
    }
  });
});

Deno.test("docs folders are found nearest first, through linked dependencies", async () => {
  const io = await import("../../cell/local.server.ts");
  const root = await Deno.makeTempDir();
  const lib = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${root}/docs`);
    await Deno.mkdir(`${root}/node_modules/x/docs`, { recursive: true });
    await Deno.mkdir(`${root}/app/dep`, { recursive: true });
    await Deno.mkdir(`${lib}/docs`);
    // A vendored framework is a symlink, as `dep/aio` is.
    await Deno.symlink(lib, `${root}/app/dep/fw`);
    assertEquals(
      await io.docsOf(root, 5),
      "docs/, app/dep/fw/docs/",
    );
    assertEquals(await io.docsOf(root, 1), "docs/");
  } finally {
    await Deno.remove(root, { recursive: true });
    await Deno.remove(lib, { recursive: true });
  }
});

Deno.test(
  "a call refused twice is answered with the reason, not a lost turn",
  async () => {
    // A wall is not a circle. A live session asked for a framework file it was
    // not allowed to read, four times, and the loop guard took its whole turn
    // away — while the one thing that would have moved it on, the reason, was
    // never put in front of it. Twice is enough to know the message did not
    // land; the turn goes on.
    await withEngine([
      {
        toolCalls: [{ id: "a", name: "read", args: '{"path":"/etc/shadow"}' }],
      },
      {
        toolCalls: [{ id: "b", name: "read", args: '{"path":"/etc/shadow"}' }],
      },
      { text: "That one is out of bounds — here is what I did instead." },
    ], async (id, requests) => {
      await local.setMode(id, "read");
      await local.send("read the shadow file", id);
      const rows = localChat(id).messages;
      // Not cut: the model gets to finish, and the answer is its own.
      assert(
        !rows.some((m) => /^\*\(stopped/.test(m.text)),
        rows.map((m) => m.text).join(" | "),
      );
      assert(
        rows[rows.length - 1].text.includes("out of bounds"),
        rows[rows.length - 1].text,
      );
      // The third request carries the reason, with the call named and the
      // refusal quoted — not a scolding about going in circles.
      const sent = JSON.stringify(requests[requests.length - 1]);
      assert(sent.includes("has now failed 2 times"), sent.slice(-600));
      assert(sent.includes("outside the project"), sent.slice(-600));
    });
  },
);

Deno.test("a command can name the folder it runs in", async () => {
  // An app scaffolded one level down is the normal case, and without this the
  // model pays for `cd <dir> &&` on every command it ever runs — 131 of 134 in
  // one live session. The sandbox still binds the whole project; `dir` only
  // decides where the command wakes up, so it cannot become a way out.
  await withEngine([
    {
      toolCalls: [
        { id: "a", name: "sh", args: '{"cmd":"pwd","dir":"app"}' },
        { id: "b", name: "sh", args: '{"cmd":"pwd","dir":"nope"}' },
        { id: "c", name: "sh", args: '{"cmd":"pwd","dir":"../.."}' },
      ],
    },
    { text: "done" },
  ], async (id) => {
    const dir = workspace.projects.find((p) => p.id === id)!.path;
    await Deno.mkdir(`${dir}/app`);
    await local.setMode(id, "agent");
    await local.setPermission(id, "bypass"); // approvals have tests of their own
    await local.send("where are we", id);
    const [there, missing, out] = localChat(id).messages.filter((m) =>
      m.role === "tool"
    );
    assert(there.text.trimEnd().endsWith("/app"), there.text);
    assert(missing.text.includes("is not a directory"), missing.text);
    assert(out.text.includes("outside the project"), out.text);
  });
});

Deno.test("work buys time; going in circles does not", async () => {
  // A flat wall cut a live session at twenty minutes with the app nearly
  // built. The clock is for turns that are getting nowhere — and a turn that is
  // getting nowhere is one that touches no new file, which is measurable.
  Deno.env.set("CC_TURN_MS", "900");
  try {
    // Each round writes a NEW file: the clock is pushed every time, so this
    // turn gets much further than 900ms of rounds would allow.
    const working: Scripted[] = [];
    for (let i = 0; i < 12; i++) {
      working.push({
        toolCalls: [{
          id: `w${i}`,
          name: "write",
          args: JSON.stringify({ path: `f${i}.txt`, content: `${i}\n` }),
        }],
        delayMs: 120,
      });
    }
    working.push({ text: "Built it." });
    await withEngine(working, async (id) => {
      await local.setMode(id, "agent");
      await local.setPermission(id, "bypass");
      await local.send("write twelve files", id);
      const rows = localChat(id).messages;
      // It finished on its own terms: no cut marker, and its own words last.
      assert(
        !rows.some((m) => /^\*\(stopped/.test(m.text)),
        rows.map((m) => m.text.slice(0, 40)).join(" | "),
      );
      assertEquals(rows[rows.length - 1].text, "Built it.");
      assertEquals(localChat(id).changed, 12);
    });

    // The same clock, the same delays, but every round only READS — nothing is
    // ever touched, so nothing is bought and the wall arrives.
    const circling: Scripted[] = [];
    for (let i = 0; i < 12; i++) {
      circling.push({
        toolCalls: [{ id: `c${i}`, name: "ls", args: `{"path":"${i}"}` }],
        delayMs: 120,
      });
    }
    circling.push({ text: "Still nowhere." });
    await withEngine(circling, async (id) => {
      await local.setMode(id, "read");
      await local.send("look around forever", id);
      const rows = localChat(id).messages;
      assert(
        rows.some((m) => /^\*\(stopped after/.test(m.text)),
        rows.map((m) => m.text.slice(0, 40)).join(" | "),
      );
    });
  } finally {
    Deno.env.delete("CC_TURN_MS");
  }
});

Deno.test("the log a background job writes is readable by the name it was given", async () => {
  // `sh` with background: true tells the model "its output goes to
  // /tmp/job-<id>.log", and inside the sandbox that is exactly where it is. The
  // read tool runs outside the sandbox, where that name means the machine's
  // /tmp — so the one file the model was told to read answered "Path is outside
  // the project". Seen live, on a job the agent had just started.
  await withEngine([
    {
      toolCalls: [{
        id: "j",
        name: "sh",
        args: JSON.stringify({
          cmd: "echo started; sleep 30",
          background: true,
        }),
      }],
    },
    {
      toolCalls: [{ id: "r", name: "read", args: '{"path":"/tmp/job-1.log"}' }],
    },
    // …and nothing else in /tmp is on offer: the mapping is this conversation's
    // own scratch, not the machine's.
    {
      toolCalls: [{
        id: "o",
        name: "read",
        args: '{"path":"/tmp/../etc/hostname"}',
      }],
    },
    { text: "read it" },
  ], async (id) => {
    await local.setMode(id, "agent");
    await local.setPermission(id, "bypass");
    await local.send("start it and read the log", id);
    const rows = localChat(id).messages.filter((m) => m.role === "tool");
    const [started, log, escape] = rows;
    assert(started.text.includes("job 1"), started.text);
    assert(log.text.includes("started"), log.text);
    assert(escape.text.startsWith("Error:"), escape.text);
    await local.stop(id);
  });
});

Deno.test("writing against a vendored framework without reading it gets one nudge", async () => {
  // A private framework is not in any model's training data, and nothing about
  // `aio` announces that: the name looks like a package, the files are `.ts`.
  // Two live sessions guessed an API and spent their turns proving the guess
  // wrong. The rule is in the prompt; this is the part that checks.
  const store = `${Deno.env.get("HOME")}/.cc-fw-test-${
    crypto.randomUUID().slice(0, 8)
  }`;
  await Deno.mkdir(`${store}/docs`, { recursive: true });
  await Deno.writeTextFile(`${store}/docs/ai.md`, "# aio for AI agents\n");
  try {
    await withEngine([
      {
        toolCalls: [{
          id: "w",
          name: "write",
          args: JSON.stringify({ path: "src/app.ts", content: "guessed()\n" }),
        }],
      },
      { text: "done" },
    ], async (id, requests) => {
      const dir = workspace.projects.find((p) => p.id === id)!.path;
      await Deno.mkdir(`${dir}/dep`, { recursive: true });
      await Deno.symlink(store, `${dir}/dep/aio`);
      await Deno.writeTextFile(
        `${dir}/deno.json`,
        JSON.stringify({ imports: { aio: "./dep/aio/mod.ts" } }),
      );
      await local.setMode(id, "agent");
      await local.setPermission(id, "bypass");
      await local.send("build an aio app", id);
      // The reminder names the page written for agents, and says the thing a
      // model cannot work out for itself.
      // Any request after the first change: the note rides the next one.
      const all = requests.map((r) => JSON.stringify(r)).join("\n");
      assert(all.includes("dep/aio/docs/ai.md"), all.slice(-600));
      assert(all.includes("private framework"), all.slice(-600));
    });

    // …and a turn that DID open the docs is not lectured about them.
    await withEngine([
      {
        toolCalls: [{
          id: "r",
          name: "read",
          args: '{"path":"dep/aio/docs/ai.md"}',
        }],
      },
      {
        toolCalls: [{
          id: "w",
          name: "write",
          args: JSON.stringify({ path: "src/app.ts", content: "learned()\n" }),
        }],
      },
      { text: "done" },
    ], async (id, requests) => {
      const dir = workspace.projects.find((p) => p.id === id)!.path;
      await Deno.mkdir(`${dir}/dep`, { recursive: true });
      await Deno.symlink(store, `${dir}/dep/aio`);
      await Deno.writeTextFile(
        `${dir}/deno.json`,
        JSON.stringify({ imports: { aio: "./dep/aio/mod.ts" } }),
      );
      await local.setMode(id, "agent");
      await local.setPermission(id, "bypass");
      await local.send("build an aio app", id);
      const all = requests.map((r) => JSON.stringify(r)).join("\n");
      assert(
        !all.includes("have not opened its documentation"),
        all.slice(-400),
      );
    });
  } finally {
    await Deno.remove(store, { recursive: true }).catch(() => {});
  }
});
