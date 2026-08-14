/**
 * Startup readiness, driven through a real spawned process.
 *
 * The CLI emits `system/init` only when a first turn begins (verified against
 * 2.1.232) — so a session that waited for it to call itself ready sat at
 * "Starting…" indefinitely on a process that was answering fine. What the CLI
 * *does* answer immediately is the `initialize` handshake, and that is the
 * signal under test here: spawn, handshake, ready, with no turn in between.
 */
import { assertEquals } from "@std/assert";
import { bootCells } from "aio/testing";
import { session } from "../../cell/session.ts";
import { workspace } from "../../cell/workspace.ts";

/** The handshake half of the stub, shared by both stand-ins below. */
const HANDSHAKE =
  `if [ "$1" = "--version" ]; then echo "2.1.232 (stub)"; exit 0; fi
read -r line
id=\${line#*'"request_id":"'}
id=\${id%%'"'*}
printf '{"type":"control_response","response":{"subtype":"success","request_id":"%s"}}\\n' "$id"
`;

/** A stand-in for the CLI that behaves exactly as 2.1.232 does at startup:
 *  it answers the control handshake, echoing the request id back, and sends
 *  nothing else until its stdin closes. */
const STUB = `#!/usr/bin/env bash
${HANDSHAKE}cat > /dev/null
`;

/** The same, mid-turn: closing stdin does not end it, it keeps emitting the
 *  frames of the turn it was answering, and it only dies on the signal. That is
 *  what Stop actually meets (measured against 2.1.232, which exits 143). */
const BUSY_STUB = `#!/usr/bin/env bash
${HANDSHAKE}( sleep 0.4
  printf '{"type":"result","is_error":true,"subtype":"error_during_execution","result":"aborted","usage":{}}\\n'
) &
while true; do sleep 0.2; done
`;

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Point the app at a stub CLI in a scratch project, run `body`, clean up. */
async function withStub(
  script: string,
  body: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir();
  const bin = `${dir}/claude-stub`;
  await Deno.writeTextFile(bin, script);
  await Deno.chmod(bin, 0o755);

  const previous = Deno.env.get("CLAUDE_BIN");
  Deno.env.set("CLAUDE_BIN", bin);
  const booted = await bootCells([workspace, session]);
  try {
    // The cell's own boot pass adds the launch directory; let it land before
    // pointing the session somewhere else, so these tests race nothing.
    for (let i = 0; i < 100 && workspace.projects.length === 0; i++) {
      await delay(20);
    }
    await workspace.addProject(dir);
    await body(dir);
  } finally {
    booted.dispose();
    if (previous === undefined) Deno.env.delete("CLAUDE_BIN");
    else Deno.env.set("CLAUDE_BIN", previous);
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

Deno.test("a CLI that answers the handshake is ready before any turn", () =>
  withStub(STUB, async (dir) => {
    await session.start();

    for (let i = 0; i < 100 && session.status === "starting"; i++) {
      await delay(20);
    }
    assertEquals(session.status, "ready");
    assertEquals(session.cwd, dir);
    assertEquals(session.pid !== null, true);
    // The handshake says the process is up; it says nothing about a turn.
    assertEquals(session.interrupting, false);
    assertEquals(session.turns, 0);

    // A turn sent while one is running is queued by the CLI, so the clock in
    // the strip must stay on the turn actually in flight.
    await session.send("first");
    const startedAt = session.turnStartedAt;
    assertEquals(typeof startedAt, "number");
    await delay(15);
    await session.send("second, while the first is still running");
    assertEquals(session.turnStartedAt, startedAt);
    assertEquals(session.messages.length, 2);

    await session.stop();
    assertEquals(session.status, "offline");
    assertEquals(session.turnStartedAt, null);
  }));

Deno.test("memory is measured on start, not on a first turn", () =>
  withStub(STUB, async (dir) => {
    await Deno.writeTextFile(`${dir}/CLAUDE.md`, "# project memory\nrules.\n");
    await session.start();
    for (let i = 0; i < 100 && session.status === "starting"; i++) {
      await delay(20);
    }
    assertEquals(session.status, "ready");

    // The only trigger used to be `system/init`, which the CLI holds back until
    // a turn begins — so a running session's Memory page read "Not scanned"
    // until somebody typed. Nothing is sent here on purpose.
    for (let i = 0; i < 100 && session.memory.length === 0; i++) {
      await delay(20);
    }
    assertEquals(session.turns, 0);
    assertEquals(session.messages.length, 0);
    assertEquals(
      session.memory.some((f) => f.path === `${dir}/CLAUDE.md`),
      true,
    );
    assertEquals(session.memoryScannedAt !== null, true);

    // Pacing holds back a repeat of the same measurement, never a new one: the
    // project is what the figure is about, so a different one is taken at once.
    const first = session.memoryScannedAt;
    await session.scanMemory(false);
    assertEquals(session.memoryScannedAt, first); // same project, paced
    const other = await Deno.makeTempDir();
    try {
      await Deno.writeTextFile(`${other}/CLAUDE.md`, "# elsewhere\n");
      await workspace.addProject(other);
      await session.start();
      for (let i = 0; i < 100 && session.status === "starting"; i++) {
        await delay(20);
      }
      for (
        let i = 0;
        i < 100 && !session.memory.some((f) => f.path === `${other}/CLAUDE.md`);
        i++
      ) {
        await delay(20);
      }
      assertEquals(
        session.memory.some((f) => f.path === `${other}/CLAUDE.md`),
        true,
      );
      assertEquals(
        session.memory.some((f) => f.path === `${dir}/CLAUDE.md`),
        false,
      );
    } finally {
      await session.stop();
      await Deno.remove(other, { recursive: true }).catch(() => {});
    }
  }));

Deno.test("Stop mid-turn is not a crash", () =>
  withStub(BUSY_STUB, async () => {
    await session.start();
    for (let i = 0; i < 100 && session.status === "starting"; i++) {
      await delay(20);
    }
    assertEquals(session.status, "ready");
    await session.send("something long");
    assertEquals(session.status, "working");

    // Stop meets a process that ignores the closed stdin, keeps emitting the
    // frames of the turn it was answering, and only dies on the signal. None of
    // that belongs to this session any more: it must not land as a failed turn,
    // and the signal must not be reported as "Exited (code 143)".
    await session.stop();
    assertEquals(session.status, "offline");
    assertEquals(session.error, null);

    await delay(300); // …and nothing arrives late to contradict it
    assertEquals(session.status, "offline");
    assertEquals(session.error, null);
    assertEquals(session.pid, null);
  }));
