/**
 * Storage — what Claude Code has on disk, and the guards on deleting any of it.
 *
 * The tests that matter here are the refusals. This is the only code in the app
 * that removes another program's data, the data is the record of real work, and
 * there is no undo — so every precondition is pinned, including the ones that
 * would only fire on a machine in an unusual state.
 */
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { bootCells } from "aio/testing";
import {
  deleteProjectHistory,
  scanStorage,
} from "../../cell/storage.server.ts";
import { stale, staleBytes, storage } from "../../cell/storage.ts";

/** A scratch `~/.claude` with a projects tree in it. */
async function withHome(
  fn: (home: string) => Promise<void>,
): Promise<void> {
  const home = await Deno.makeTempDir();
  const before = Deno.env.get("HOME");
  Deno.env.set("HOME", home);
  try {
    await fn(home);
  } finally {
    if (before === undefined) Deno.env.delete("HOME");
    else Deno.env.set("HOME", before);
    await Deno.remove(home, { recursive: true });
  }
}

/** Write a transcript that records `cwd` the way the CLI does. */
async function transcript(dir: string, id: string, cwd: string, pad = 0) {
  await Deno.mkdir(dir, { recursive: true });
  const lines = [
    JSON.stringify({ type: "summary", sessionId: id }),
    JSON.stringify({ type: "user", cwd, sessionId: id }),
    "x".repeat(pad),
  ];
  await Deno.writeTextFile(join(dir, `${id}.jsonl`), lines.join("\n") + "\n");
}

const ID_A = "aaaaaaaa-1111-2222-3333-444444444444";
const ID_B = "bbbbbbbb-1111-2222-3333-444444444444";

Deno.test("a project's path is read from its transcript, never from the name", async () => {
  await withHome(async (home) => {
    const real = join(home, "code", "risoto-aio");
    await Deno.mkdir(real, { recursive: true });
    // The directory name is a lossy slug: `-code-risoto-aio` decodes just as
    // well to `/code/risoto/aio`, which does not exist. Reading the name back
    // is what would call a live project dead.
    const dir = join(home, ".claude", "projects", "-code-risoto-aio");
    await transcript(dir, ID_A, real);

    const [p] = (await scanStorage()).projects;
    assertEquals(p.path, real);
    assertEquals(p.exists, true);
    assertEquals(p.sessions, 1);
  });
});

Deno.test("a history with no recorded cwd is 'unknown', never 'gone'", async () => {
  await withHome(async (home) => {
    const dir = join(home, ".claude", "projects", "-somewhere-else");
    await Deno.mkdir(dir, { recursive: true });
    await Deno.writeTextFile(
      join(dir, `${ID_A}.jsonl`),
      '{"type":"summary"}\n',
    );

    const [p] = (await scanStorage()).projects;
    // Nothing says which folder this belongs to. Treating that as "gone" is
    // how a naive cleanup deletes something it never identified.
    assertEquals(p.exists, null);
    assertEquals(p.path, "");

    const refused = await deleteProjectHistory(p.dir, p.path);
    assert(refused !== null);
    assert(refused!.includes("cannot be identified"));
    assertEquals((await scanStorage()).projects.length, 1); // still there
  });
});

Deno.test("history for a folder that still exists is refused", async () => {
  await withHome(async (home) => {
    const real = join(home, "code", "alive");
    await Deno.mkdir(real, { recursive: true });
    const dir = join(home, ".claude", "projects", "-code-alive");
    await transcript(dir, ID_A, real);

    const refused = await deleteProjectHistory(dir, real);
    assert(refused !== null);
    assert(refused!.includes("is not stale"));
    assertEquals((await scanStorage()).projects.length, 1);
  });
});

Deno.test("nothing outside ~/.claude/projects can be deleted", async () => {
  await withHome(async (home) => {
    const elsewhere = join(home, "important");
    await Deno.mkdir(elsewhere, { recursive: true });
    await Deno.writeTextFile(join(elsewhere, "keep.txt"), "precious");

    const refused = await deleteProjectHistory(elsewhere, "/gone");
    assert(refused !== null);
    assert(refused!.includes("not part of Claude Code"));
    assertEquals(
      await Deno.stat(join(elsewhere, "keep.txt")).then(() => true),
      true,
    );
  });
});

Deno.test("stale history is deleted with its file-history, and nothing else", async () => {
  await withHome(async (home) => {
    const deleted = join(home, "code", "deleted");
    const alive = join(home, "code", "alive");
    await Deno.mkdir(alive, { recursive: true });

    const goneDir = join(home, ".claude", "projects", "-code-deleted");
    const liveDir = join(home, ".claude", "projects", "-code-alive");
    await transcript(goneDir, ID_A, deleted, 4096);
    await transcript(liveDir, ID_B, alive);

    const history = join(home, ".claude", "file-history");
    await Deno.mkdir(join(history, ID_A), { recursive: true });
    await Deno.mkdir(join(history, ID_B), { recursive: true });

    const before = await scanStorage();
    assertEquals(before.projects.length, 2);
    const target = before.projects.find((p) => p.path === deleted)!;
    assertEquals(target.exists, false);
    assert(target.bytes > 4000);

    assertEquals(await deleteProjectHistory(target.dir, target.path), null);

    const after = await scanStorage();
    assertEquals(after.projects.length, 1);
    assertEquals(after.projects[0].path, alive);
    // The dead session's file-history goes with it; the live one's stays.
    assertEquals(await Deno.stat(join(history, ID_A)).catch(() => null), null);
    assert(await Deno.stat(join(history, ID_B)).then(() => true));
  });
});

Deno.test("the cell reports only what it can prove is stale", async () => {
  await withHome(async (home) => {
    const alive = join(home, "code", "alive");
    await Deno.mkdir(alive, { recursive: true });
    await transcript(
      join(home, ".claude", "projects", "-code-alive"),
      ID_A,
      alive,
    );
    await transcript(
      join(home, ".claude", "projects", "-code-deleted"),
      ID_B,
      join(home, "code", "deleted"),
    );
    // A third with no cwd at all: unknown, and excluded from the reclaimable
    // set even though it is not known to exist either.
    const blind = join(home, ".claude", "projects", "-code-blind");
    await Deno.mkdir(blind, { recursive: true });
    await Deno.writeTextFile(join(blind, "x.jsonl"), "{}\n");

    const h = await bootCells([storage]);
    try {
      await storage.refresh();
      assertEquals(storage.projects.length, 3);
      assertEquals(stale().length, 1);
      assertEquals(stale()[0].path, join(home, "code", "deleted"));
      assert(staleBytes() > 0);
    } finally {
      h.dispose();
    }
  });
});
