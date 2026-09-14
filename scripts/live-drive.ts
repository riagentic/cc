/**
 * Manual live drive (not a test): runs the local agent against a REAL server
 * and model, and prints the transcript and what the turn learned. The way to
 * see how a given model copes before trusting it with a project.
 *
 *   deno task live <engine> <baseUrl> <model> [mode] [task]
 *   deno task live lmstudio http://localhost:1234 google/gemma-3-12b
 *
 * Without LIVE_DIR it works on a throwaway project with a planted bug and a
 * failing test (and deletes it after). Options, as environment variables:
 *   LIVE_DIR=/path   an existing project — use mode `read` unless it is scratch
 *   LIVE_CTX=8192    budget against a smaller window than the server has
 * Several turns: separate them with "||" in the task.
 *
 * Commands run in "Don't ask" mode — sandboxed where bubblewrap works.
 */
import { bootCells } from "aio/testing";
import { local, localChat, localConfig } from "../src/cell/local.ts";
import { workspace } from "../src/cell/workspace.ts";
import type { LocalEngine, LocalMode } from "../src/type/local.ts";

const [engine, baseUrl, model, mode = "agent", task] = Deno.args;
const h = await bootCells([workspace, local]);
// LIVE_DIR drives an existing project (read mode only, please); otherwise a
// throwaway one with a planted bug.
const given = Deno.env.get("LIVE_DIR");
const dir = given ?? await Deno.makeTempDir({ prefix: "cc-live-" });
if (!given) {
  await Deno.writeTextFile(
    `${dir}/calc.ts`,
    `/** Small arithmetic helpers. */\nexport function add(a: number, b: number): number {\n  return a - b;\n}\n\nexport function mul(a: number, b: number): number {\n  return a * b;\n}\n`,
  );
}
if (!given) {
  await Deno.writeTextFile(
    `${dir}/calc.test.ts`,
    `import { add, mul } from "./calc.ts";\n\nDeno.test("add", () => {\n  if (add(2, 3) !== 5) throw new Error("add(2, 3) should be 5, got " + add(2, 3));\n});\n\nDeno.test("mul", () => {\n  if (mul(2, 3) !== 6) throw new Error("mul is broken");\n});\n`,
  );
}
if (!given) {
  await Deno.writeTextFile(
    `${dir}/README.md`,
    "# calc\n\nRun tests with `deno test`.\n",
  );
}
try {
  const id = await workspace.addProject(dir);
  if (id === null) throw new Error(`could not add ${dir} as a project`);
  await local.setEngine(id, engine as LocalEngine);
  await local.setBaseUrl(id, baseUrl);
  await local.refreshModels(id);
  await local.setModel(id, model);
  await local.setMode(id, mode as LocalMode);
  // LIVE_CTX budgets against a smaller window than the server has — the way
  // to watch compaction on a model loaded roomy.
  const ctx = Number(Deno.env.get("LIVE_CTX"));
  if (ctx) await local.setCtx(id, ctx);
  await local.setPermission(id, "dontAsk");
  const t0 = Date.now();
  // Several turns, separated by "||", for watching a conversation compact.
  for (
    const turn of (task ??
      "The tests in this project fail. Find the bug, fix it, and run the tests to prove it.")
      .split("||")
  ) await local.send(turn.trim(), id);
  const chat = localChat(id);
  for (const m of chat.messages) {
    const calls = m.toolCalls?.map((c) => `${c.name} ${c.args}`).join(" | ");
    console.log(
      `\n[${m.role}${m.toolName ? ":" + m.toolName : ""}${
        m.stubbed ? " stubbed" : ""
      }${m.evicted ? " evicted" : ""}] ${m.text.slice(0, 600)}${
        calls ? `\n  calls: ${calls.slice(0, 400)}` : ""
      }`,
    );
  }
  console.log("\n---");
  console.log({
    ms: Date.now() - t0,
    ctx: localConfig(id).ctx,
    toolsOk: chat.toolsOk,
    tokRatio: chat.tokRatio,
    used: chat.usedTokens,
    error: chat.error,
    todos: chat.todos,
    changed: chat.changed,
    summary: chat.summary.slice(0, 300),
  });
  if (!given) {
    console.log("calc.ts now:\n" + await Deno.readTextFile(`${dir}/calc.ts`));
  }
} finally {
  h.dispose();
  if (!given) await Deno.remove(dir, { recursive: true });
}
