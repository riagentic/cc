/**
 * The session's async edges, against a real spawned stub CLI.
 *
 * Every test here is a race a user can start with two clicks: switching project
 * while a process spawns, Restart then Enter, removing a project whose process
 * is still talking. Each pins where the writes land and how many `claude`
 * processes exist afterwards — the two things that go silently wrong.
 */
import { assert, assertEquals } from "@std/assert";
import { bootCells } from "aio/testing";
import { session, sessionOf } from "../../cell/session.ts";
import { workspace } from "../../cell/workspace.ts";

/** Records its argv, answers the handshake, then lives until stdin closes. */
const stub = (argvFile: string) =>
  `#!/usr/bin/env bash
echo "$@" >> ${argvFile}
read -r line
id=\${line#*'"request_id":"'}
id=\${id%%'"'*}
printf '{"type":"control_response","response":{"subtype":"success","request_id":"%s"}}\\n' "$id"
while IFS= read -r line; do :; done
`;

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Two projects, `a` selected, and a stub CLI no other test shares. */
async function rig() {
  const tmp = await Deno.makeTempDir({ prefix: "cc-race-" });
  const bin = `${tmp}/claude-stub`;
  const argvFile = `${tmp}/argv`;
  await Deno.writeTextFile(bin, stub(argvFile));
  await Deno.chmod(bin, 0o755);
  await Deno.mkdir(`${tmp}/a`);
  await Deno.mkdir(`${tmp}/b`);
  const previous = Deno.env.get("CLAUDE_BIN");
  Deno.env.set("CLAUDE_BIN", bin);

  const h = await bootCells([workspace, session]);
  await delay(0);
  await h.settle();
  await workspace.addProject(`${tmp}/a`);
  const a = workspace.activeId;
  await workspace.addProject(`${tmp}/b`);
  const b = workspace.activeId;
  await workspace.select(a);
  await h.settle();

  /** Stub processes alive right now — `-1` where there is no `pgrep`. */
  const alive = async (): Promise<number> => {
    const out = await new Deno.Command("pgrep", {
      args: ["-f", bin],
      stdout: "piped",
      stderr: "null",
    }).output().catch(() => null);
    if (!out) return -1;
    return new TextDecoder().decode(out.stdout).trim().split("\n")
      .filter(Boolean).length;
  };
  /** The argv of every session spawned — not the app's `--version` probe. */
  const argv = async (): Promise<string[]> =>
    (await Deno.readTextFile(argvFile).catch(() => "")).split("\n")
      .filter((l) => l.startsWith("-p "));

  return {
    h,
    a,
    b,
    alive,
    argv,
    async done() {
      await session.stopAll();
      await h.settle();
      await h.settle();
      h.dispose();
      if (previous === undefined) Deno.env.delete("CLAUDE_BIN");
      else Deno.env.set("CLAUDE_BIN", previous);
      await Deno.remove(tmp, { recursive: true }).catch(() => {});
    },
  };
}

/** Wait (bounded) for a condition the app reaches asynchronously. */
async function until(ok: () => boolean, ms = 2_000): Promise<void> {
  const end = Date.now() + ms;
  while (!ok() && Date.now() < end) await delay(0);
}

const texts = (key: string): string[] =>
  sessionOf(key).messages.flatMap((m) =>
    m.blocks.flatMap((b) => b.kind === "text" ? [b.text] : [])
  );

Deno.test("a switch while the process spawns leaves the message and pid with their project", async () => {
  const t = await rig();
  try {
    const sent = session.send("for A");
    // The spawn is under way for A…
    await until(() => sessionOf(t.a).status === "starting");
    // …and the user moves to B before it has finished.
    await session.switchTo(t.b);
    await sent;
    await t.h.settle();

    assertEquals(texts(t.a), ["for A"]);
    assertEquals(texts(t.b), []);
    assert(sessionOf(t.a).pid !== null, "A's pid went elsewhere");
    assertEquals(sessionOf(t.b).pid, null);
  } finally {
    await t.done();
  }
});

Deno.test("the first message after a restart keeps the transcript and resumes the CLI session", async () => {
  const t = await rig();
  try {
    // A restored conversation: a transcript, a CLI session id to resume, and
    // no process (what `offlineAgain` leaves at boot).
    await session.ingest(
      {
        type: "system",
        subtype: "init",
        session_id: "sess-before",
      },
      undefined,
      t.a,
    );
    await session.ingest(
      {
        type: "assistant",
        message: { id: "m-old", content: [{ type: "text", text: "earlier" }] },
      },
      undefined,
      t.a,
    );
    assertEquals(sessionOf(t.a).pid, null);

    await session.send("and now");
    await t.h.settle();

    assertEquals(texts(t.a), ["earlier", "and now"]);
    // The stub writes its argv once it is running, which is after the spawn
    // has returned — wait for it rather than race it.
    const end = Date.now() + 2_000;
    while ((await t.argv()).length === 0 && Date.now() < end) await delay(10);
    const args = await t.argv();
    assertEquals(args.length, 1);
    assert(args[0].includes("--resume sess-before"), args[0]);
  } finally {
    await t.done();
  }
});

Deno.test("Restart then Enter spawns one process, not two", async () => {
  const t = await rig();
  try {
    // Both dispatched before either has spawned — two clicks, one frame.
    const restart = session.start();
    const enter = session.send("hello");
    await Promise.all([restart, enter]);
    await t.h.settle();
    // Long enough for a second spawn, had there been one, to write its argv.
    await delay(300);

    assertEquals((await t.argv()).length, 1, "spawned more than once");
    const n = await t.alive();
    if (n >= 0) assertEquals(n, 1, "a second claude is running");
    assertEquals(texts(t.a), ["hello"]);

    await session.stop();
    await delay(100);
    if (n >= 0) assertEquals(await t.alive(), 0, "a claude outlived stop");
  } finally {
    await t.done();
  }
});

Deno.test("a released conversation is not brought back by its process's last words", async () => {
  const t = await rig();
  try {
    await session.ingest(
      {
        type: "assistant",
        message: { id: "m-b", content: [{ type: "text", text: "b" }] },
      },
      undefined,
      t.b,
    );
    assert(t.b in session.parked);
    const token = sessionOf(t.b).startToken;

    await session.release([t.b]);
    assert(!(t.b in session.parked));

    // The dying process still reports, carrying the token it was started with.
    await session.delta("text", "late", token, t.b);
    await session.ingest(
      {
        type: "assistant",
        message: { id: "m-late", content: [{ type: "text", text: "late" }] },
      },
      token,
      t.b,
    );
    await session.exited(143, "", token, t.b);
    await t.h.settle();

    assert(!(t.b in session.parked), "the record was resurrected");
  } finally {
    await t.done();
  }
});
