/**
 * Switching model on a session that is already running, driven through a real
 * spawned process.
 *
 * The picker used to write a preference and nothing more, so a live `claude`
 * went on answering out of the model it was spawned with. The failure was
 * invisible until it mattered most: once a model's usage limit is reached every
 * further turn comes back as the same limit notice, and changing the model —
 * what the notice itself tells you to do — appeared to do nothing.
 *
 * What the CLI actually offers is a `set_model` control request, applied from
 * the next turn on with the conversation intact (2.1.259). These tests pin the
 * frame that goes out, the state that follows it, and what happens when the
 * CLI says no.
 */
import { assertEquals } from "@std/assert";
import { bootCells } from "aio/testing";
import { session } from "../../cell/session.ts";
import { workspace } from "../../cell/workspace.ts";

/** Everything the stubs share: answer `--version`, then log every frame that
 *  arrives and reply to control requests the way the CLI does. */
const PREAMBLE =
  `if [ "$1" = "--version" ]; then echo "2.1.259 (stub)"; exit 0; fi
`;

const READER = (setModelReply: string) =>
  `while IFS= read -r line; do
  printf '%s\\n' "$line" >> "$CC_FRAMES"
  case "$line" in
    *'"control_request"'*)
      id=\${line#*'"request_id":"'}
      id=\${id%%'"'*}
      case "$line" in
        *set_model*) ${setModelReply} ;;
        *) printf '{"type":"control_response","response":{"subtype":"success","request_id":"%s"}}\\n' "$id" ;;
      esac
      ;;
  esac
done
`;

/** Accepts the switch, as the CLI does when nothing objects. */
const STUB = `#!/usr/bin/env bash
${PREAMBLE}${
  READER(
    `printf '{"type":"control_response","response":{"subtype":"success","request_id":"%s"}}\\n' "$id"`,
  )
}`;

/** Refuses it. The CLI answers a rejected control request with the same echoed
 *  id under `subtype:"error"` — the envelope a success-only reader ignores. */
const REFUSING_STUB = `#!/usr/bin/env bash
${PREAMBLE}${
  READER(
    `printf '{"type":"control_response","response":{"subtype":"error","request_id":"%s","error":"set_model: not allowed here"}}\\n' "$id"`,
  )
}`;

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Point the app at a stub CLI in a scratch project, run `body`, clean up. */
async function withStub(
  script: string,
  body: (frames: () => Promise<string[]>) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir();
  const bin = `${dir}/claude-stub`;
  const log = `${dir}/frames.jsonl`;
  await Deno.writeTextFile(bin, script);
  await Deno.writeTextFile(log, "");
  await Deno.chmod(bin, 0o755);

  const previousBin = Deno.env.get("CLAUDE_BIN");
  const previousLog = Deno.env.get("CC_FRAMES");
  Deno.env.set("CLAUDE_BIN", bin);
  Deno.env.set("CC_FRAMES", log);
  const booted = await bootCells([workspace, session]);
  try {
    // Let the cell's own boot pass add the launch directory before pointing the
    // session somewhere else, so these tests race nothing.
    for (let i = 0; i < 100 && workspace.projects.length === 0; i++) {
      await delay(20);
    }
    await workspace.addProject(dir);
    await body(async () =>
      (await Deno.readTextFile(log)).split("\n").filter(Boolean)
    );
  } finally {
    await booted.settle();
    booted.dispose();
    if (previousBin === undefined) Deno.env.delete("CLAUDE_BIN");
    else Deno.env.set("CLAUDE_BIN", previousBin);
    if (previousLog === undefined) Deno.env.delete("CC_FRAMES");
    else Deno.env.set("CC_FRAMES", previousLog);
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

/** Wait for the stub to have written a frame the predicate likes. */
async function untilFrame(
  frames: () => Promise<string[]>,
  match: (line: string) => boolean,
): Promise<string | null> {
  for (let i = 0; i < 100; i++) {
    const hit = (await frames()).find(match);
    if (hit) return hit;
    await delay(20);
  }
  return null;
}

Deno.test("the model is switched on the running session, not the next one", () =>
  withStub(STUB, async (frames) => {
    await workspace.setModel("sonnet");
    await session.start();
    for (let i = 0; i < 100 && session.status === "starting"; i++) {
      await delay(20);
    }
    assertEquals(session.status, "ready");
    assertEquals(session.model, "sonnet");
    const pid = session.pid;

    await session.useModel("opus");

    // The frame the CLI needs, on the session that is already up.
    const frame = await untilFrame(frames, (l) => l.includes("set_model"));
    assertEquals(frame !== null, true);
    assertEquals(JSON.parse(frame!).request.model, "opus");

    // No restart: the process, the conversation and its context all survive —
    // which is the whole reason this is a control request and not a respawn.
    assertEquals(session.pid, pid);
    assertEquals(session.model, "opus");
    // …and the preference for the next session moved with it.
    assertEquals(workspace.defaults.model, "opus");
    assertEquals(session.error, null);
    // The CLI's own acknowledgement, which arrives after the frame goes out.
    for (
      let i = 0;
      i < 100 &&
      !session.activity.some((a) => a.label === "Model switch accepted");
      i++
    ) await delay(20);
    assertEquals(
      session.activity.some((a) => a.label === "Model switch accepted"),
      true,
    );

    await session.stop();
  }));

Deno.test("a refused switch is reported, not swallowed", () =>
  withStub(REFUSING_STUB, async (frames) => {
    await session.start();
    for (let i = 0; i < 100 && session.status === "starting"; i++) {
      await delay(20);
    }
    assertEquals(session.status, "ready");

    await session.useModel("haiku");
    assertEquals(
      await untilFrame(frames, (l) => l.includes("set_model")) !==
        null,
      true,
    );

    for (let i = 0; i < 100 && session.error === null; i++) await delay(20);
    // The strip names the model the user chose, so a refusal that left no
    // trace would be the same silent lie the switch was added to end.
    assertEquals(session.error?.includes("not allowed here"), true);
    assertEquals(
      session.activity.some((a) => a.label === "Model switch refused"),
      true,
    );

    await session.stop();
  }));

Deno.test("with nothing running, the switch is a preference and no more", () =>
  withStub(STUB, async (frames) => {
    assertEquals(session.pid, null);

    await session.useModel("haiku");
    assertEquals(workspace.defaults.model, "haiku");
    // Nothing was spawned to be told — and nothing pretends a session is on it.
    assertEquals(session.pid, null);
    assertEquals(session.model, null);
    assertEquals((await frames()).length, 0);

    // A model the picker does not offer changes nothing at all.
    await session.useModel("gpt-4");
    assertEquals(workspace.defaults.model, "haiku");
  }));
