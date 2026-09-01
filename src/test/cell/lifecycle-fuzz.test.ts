// Randomized lifecycle fuzz: start / stop / send / interrupt / rescan in random
// order against a real spawned stub CLI, checking after every step the things
// that must be true of a session no matter what order the user clicks in.
//
//  • at most one CLI process is alive — a second would silently double cost
//  • offline means offline: nothing left running, nothing left pending
//  • every ring buffer stays inside its cap
//  • no step throws, and no process is left behind at the end
import { assert, assertEquals } from "@std/assert";
import { bootCells } from "aio/testing";
import { session } from "../../cell/session.ts";
import { catalog } from "../../cell/catalog.ts";
import { workspace } from "../../cell/workspace.ts";

const MARKER = "cc-fuzz-stub-42";
const STUB = `#!/usr/bin/env bash
# ${MARKER}
if [ "$1" = "--version" ]; then echo "2.1.232 (stub)"; exit 0; fi
read -r line
id=\${line#*'"request_id":"'}
id=\${id%%'"'*}
printf '{"type":"control_response","response":{"subtype":"success","request_id":"%s"}}\\n' "$id"
while IFS= read -r line; do
  case "$line" in
    *'"subtype":"interrupt"'*)
      id=\${line#*'"request_id":"'}; id=\${id%%'"'*}
      printf '{"type":"control_response","response":{"subtype":"success","request_id":"%s"}}\\n' "$id"
      printf '{"type":"result","is_error":true,"subtype":"error_during_execution","usage":{}}\\n' ;;
    *'"type":"user"'*)
      printf '{"type":"assistant","message":{"id":"msg_%s","model":"claude-haiku-4-5","content":[{"type":"tool_use","id":"toolu_%s","name":"Bash","input":{"command":"sleep 1"}}],"usage":{"input_tokens":3,"output_tokens":4}},"parent_tool_use_id":null}\\n' "$RANDOM" "$RANDOM"
      printf '{"type":"system","subtype":"init","session_id":"s-1","cwd":"%s","model":"claude-haiku-4-5","memory_paths":{}}\\n' "$PWD" ;;
  esac
done
`;

/** Enough churn to interleave every pair of actions; the seed is fixed so a
 *  failure reproduces, and `FUZZ_SEED=n` walks a different order. */
const STEPS = 40;

let seed = Number(Deno.env.get("FUZZ_SEED") ?? 20_260_814);
const rnd = () =>
  (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const pick = <T>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)];
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** How many stub CLIs are alive right now — `-1` where `pgrep` is not, which
 *  skips the process count rather than failing over a missing tool. */
async function liveStubs(): Promise<number> {
  const out = await new Deno.Command("pgrep", {
    args: ["-fa", MARKER],
    stdout: "piped",
    stderr: "null",
  }).output().catch(() => null);
  if (!out) return -1;
  return new TextDecoder().decode(out.stdout)
    .split("\n")
    .filter((l) => l.includes("claude-stub") && !l.includes("pgrep"))
    .length;
}

Deno.test("lifecycle fuzz: one process, and offline means offline", async () => {
  const dir = await Deno.makeTempDir();
  const bin = `${dir}/claude-stub`;
  await Deno.writeTextFile(bin, STUB);
  await Deno.chmod(bin, 0o755);
  const previous = Deno.env.get("CLAUDE_BIN");
  Deno.env.set("CLAUDE_BIN", bin);
  const booted = await bootCells([workspace, session, catalog]);

  const steps: string[] = [];
  try {
    for (let i = 0; i < 100 && workspace.projects.length === 0; i++) {
      await delay(20);
    }
    await workspace.addProject(dir);

    for (let step = 0; step < STEPS; step++) {
      const action = pick([
        "start",
        "start",
        "send",
        "send",
        "send",
        "stop",
        "interrupt",
        "rescan",
        "resume",
        "clear",
      ]);
      steps.push(action);
      switch (action) {
        case "start":
          await session.start();
          break;
        case "resume":
          await session.start(true);
          break;
        case "send":
          await session.send(`turn ${step}`);
          break;
        case "stop":
          await session.stop();
          break;
        case "interrupt":
          await session.interrupt();
          break;
        case "rescan":
          // Memory belongs to the project, not the session, so a rescan is the
          // catalog's job now — but it stays in this fuzz because it is still a
          // button a user can hit at any point in a session's life.
          await catalog.refreshMemory();
          break;
        case "clear":
          session.clearTranscript();
          break;
      }
      await delay(pick([0, 5, 30, 80]));

      // Never two CLIs: the app is a control surface for one session, and a
      // leaked process would keep answering — and keep costing.
      const alive = await liveStubs();
      assert(alive <= 1, `${alive} stub CLIs alive after ${steps.join(",")}`);

      if (session.status === "offline") {
        assertEquals(session.pid, null, `pid after ${steps.join(",")}`);
        assertEquals(session.interrupting, false);
        assertEquals(
          session.tools.filter((t) => t.endedAt === null).length,
          0,
          `open runs while offline after ${steps.join(",")}`,
        );
        assertEquals(
          session.tasks.filter((t) => t.status === "running").length,
          0,
          `running tasks while offline after ${steps.join(",")}`,
        );
        assertEquals(
          session.permissions.filter((p) => p.status === "pending").length,
          0,
        );
        assertEquals(session.streaming, null);
        assertEquals(session.turnStartedAt, null);
      }
      // Ring buffers are the only thing standing between a long session and a
      // full-state resend on every line.
      assert(session.messages.length <= 400, "messages cap");
      assert(session.tools.length <= 300, "tools cap");
      assert(session.activity.length <= 400, "activity cap");
      // Ids are keys: a duplicate makes the renderer drop a row.
      const ids = session.tools.map((t) => t.id);
      assertEquals(new Set(ids).size, ids.length, "duplicate tool id");
    }

    await session.stop();
    await delay(150);
    assert(await liveStubs() <= 0, "a CLI outlived the session");
  } finally {
    booted.dispose();
    if (previous === undefined) Deno.env.delete("CLAUDE_BIN");
    else Deno.env.set("CLAUDE_BIN", previous);
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});
