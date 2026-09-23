/**
 * What removing a project, or closing one of its tabs, lets go of — and what
 * it keeps for the undo.
 *
 * Real processes where the claim is about processes: a stub `claude` and a
 * real shell on a real PTY. "The release was dispatched" is not the fact that
 * matters; "the process is gone" is, and only a process can show it.
 */
import { assert, assertEquals } from "@std/assert";
import { bootCells, testCell } from "aio/testing";
import {
  type Forgotten,
  keepForgotten,
  restoreOrder,
  workspace,
} from "../../cell/workspace.ts";
import { session } from "../../cell/session.ts";
import { consoleCell, terminalsOf } from "../../cell/console.ts";
import { loops } from "../../cell/loops.ts";
import type { Project } from "../../type/claude.ts";

/* ── the undo keeps the user's order ─────────────────────────────────────── */

const proj = (id: string): Project => ({
  id,
  path: `/p/${id}`,
  name: id,
  branch: null,
  dirty: false,
  missing: false,
  addedAt: 0,
  launch: { dev: null, prod: null },
  model: "sonnet",
  permissionMode: "acceptEdits",
  effort: "",
  allowedDirs: [],
  skipPermissions: false,
});
const gone = (id: string, formerIndex: number): Forgotten => ({
  ...proj(id),
  formerIndex,
});

Deno.test("undo puts every project back where it stood", () => {
  // List was a b c d e. Removed c (index 2), then a and e together (0 and 3
  // of what was left). The buffer is newest removal first, list order within.
  const now = [proj("b"), proj("d")];
  const buffer = [gone("a", 0), gone("e", 3), gone("c", 2)];
  const back = restoreOrder(now, buffer);
  assertEquals(back.projects.map((p) => p.id), ["a", "b", "c", "d", "e"]);
  assertEquals(back.skipped, []);
  // The bookkeeping field does not leak into the list.
  assertEquals("formerIndex" in back.projects[0], false);
});

Deno.test("undo skips a folder that was added again by hand", () => {
  const again = { ...proj("x"), path: "/p/a" };
  const back = restoreOrder([again], [gone("a", 0)]);
  assertEquals(back.projects.map((p) => p.id), ["x"]);
  assertEquals(back.skipped, ["a"]);
});

Deno.test("the undo buffer says what fell off its end", () => {
  const before = [gone("b", 0), gone("c", 0)];
  const r = keepForgotten([gone("a", 0)], before, 2);
  assertEquals(r.kept.map((p) => p.id), ["a", "b"]);
  assertEquals(r.dropped.map((p) => p.id), ["c"]);
});

testCell(workspace, "a user's order survives remove and undo", async (t) => {
  t.init();
  const dirs = await Promise.all([1, 2, 3].map(() => Deno.makeTempDir()));
  try {
    for (const d of dirs) await t.send.addProject(d);
    const [a, b, c] = t.getState().projects.map((p) => p.id);
    // Not the order they were added in: the undo used to re-sort by that.
    t.send.moveProject(c, 0);
    assertEquals(t.getState().projects.map((p) => p.id), [c, a, b]);

    t.send.removeProject(a);
    t.send.undoForget();
    assertEquals(t.getState().projects.map((p) => p.id), [c, a, b]);
  } finally {
    for (const d of dirs) await Deno.remove(d, { recursive: true });
  }
});

/* ── stored leftovers wait for the undo to lapse ──────────────────────────── */

async function settled(h: { settle: () => Promise<void> }): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
  await h.settle();
}

Deno.test("a removed project's loops survive until the undo is dropped", async () => {
  const h = await bootCells([workspace, session, loops]);
  await settled(h);
  const a = await Deno.makeTempDir();
  const b = await Deno.makeTempDir();
  try {
    await workspace.addProject(a);
    await workspace.addProject(b);
    const idB = workspace.activeId;
    await loops.add("check CI", 300);
    assertEquals(loops.loops.length, 1);

    await workspace.removeProject(idB);
    await settled(h);
    // Undo must bring the project back WITH its loop.
    assertEquals(loops.loops.length, 1);
    await workspace.undoForget();
    await settled(h);
    assertEquals(loops.loops.length, 1);

    // Accepted: now it goes.
    await workspace.removeProject(idB);
    await workspace.clearForgotten();
    await settled(h);
    assertEquals(loops.loops.length, 0);
  } finally {
    await h.settle();
    h.dispose();
    await Deno.remove(a, { recursive: true });
    await Deno.remove(b, { recursive: true });
  }
});

/* ── running processes end at once ────────────────────────────────────────── */

/** Is this pid still a process? */
function alive(pid: number): boolean {
  try {
    Deno.kill(pid, "SIGCONT");
    return true;
  } catch {
    return false;
  }
}

async function until(ok: () => boolean, ms = 3_000): Promise<boolean> {
  for (let waited = 0; waited < ms && !ok(); waited += 20) {
    await new Promise((r) => setTimeout(r, 20));
  }
  return ok();
}

/** A `claude` that answers the handshake and then sits there, like the real
 *  one between turns. */
async function withStubClaude(
  run: (home: string) => Promise<void>,
): Promise<void> {
  const home = await Deno.makeTempDir();
  const bin = `${home}/claude-stub`;
  await Deno.writeTextFile(
    bin,
    `#!/usr/bin/env bash
if [ "$1" = "--version" ]; then echo "2.1.232 (stub)"; exit 0; fi
read -r line
id=\${line#*'"request_id":"'}
id=\${id%%'"'*}
printf '{"type":"control_response","response":{"subtype":"success","request_id":"%s"}}\\n' "$id"
cat > /dev/null
`,
  );
  await Deno.chmod(bin, 0o755);
  const previous = Deno.env.get("CLAUDE_BIN");
  Deno.env.set("CLAUDE_BIN", bin);
  try {
    await run(home);
  } finally {
    if (previous === undefined) Deno.env.delete("CLAUDE_BIN");
    else Deno.env.set("CLAUDE_BIN", previous);
    await Deno.remove(home, { recursive: true }).catch(() => {});
  }
}

/** Start the conversation on screen and answer with its pid. */
async function startHere(): Promise<number> {
  await session.start();
  await until(() => session.status !== "starting");
  assertEquals(session.status, "ready");
  const pid = session.pid;
  assert(pid !== null);
  return pid;
}

Deno.test("removing a project ends the claude of EVERY chat it had", async () => {
  await withStubClaude(async (home) => {
    const h = await bootCells([workspace, session]);
    const dir = `${home}/proj`;
    await Deno.mkdir(dir);
    try {
      await settled(h);
      await workspace.addProject(dir);
      const id = workspace.activeId;
      // A second chat, on screen: its process runs under the PANE's id, and
      // the release used to name only the project's.
      await workspace.addPane(id, "session");
      await settled(h);
      const pid = await startHere();

      await workspace.removeProject(id);
      await settled(h);
      assert(await until(() => !alive(pid)), "the second chat's claude lives");
    } finally {
      await h.settle();
      h.dispose();
    }
  });
});

Deno.test("closing a chat tab ends its claude", async () => {
  await withStubClaude(async (home) => {
    const h = await bootCells([workspace, session]);
    const dir = `${home}/proj`;
    await Deno.mkdir(dir);
    try {
      await settled(h);
      await workspace.addProject(dir);
      const id = workspace.activeId;
      const pane = await workspace.addPane(id, "session");
      await settled(h);
      const pid = await startHere();

      await workspace.removePane(pane);
      await settled(h);
      assert(await until(() => !alive(pid)), "the closed chat's claude lives");
    } finally {
      await h.settle();
      h.dispose();
    }
  });
});

/** A real shell on a real PTY, from the host in the source tree. */
async function withShell(run: () => Promise<void>): Promise<void> {
  const host = new URL("../../../native/pty/bin/cc-pty", import.meta.url);
  const keep = { pty: Deno.env.get("CC_PTY"), shell: Deno.env.get("SHELL") };
  Deno.env.set("CC_PTY", host.pathname);
  Deno.env.set("SHELL", "/bin/sh");
  try {
    await run();
  } finally {
    if (keep.pty === undefined) Deno.env.delete("CC_PTY");
    else Deno.env.set("CC_PTY", keep.pty);
    if (keep.shell === undefined) Deno.env.delete("SHELL");
    else Deno.env.set("SHELL", keep.shell);
  }
}

Deno.test("removing a project ends its shells", async () => {
  await withShell(async () => {
    const h = await bootCells([workspace, session, consoleCell]);
    const dir = await Deno.makeTempDir();
    try {
      await settled(h);
      await workspace.addProject(dir);
      const id = workspace.activeId;
      const pane = await workspace.addPane(id, "console");
      await consoleCell.open(pane, id);
      assert(await until(() => consoleCell.terms[pane]?.status === "live"));

      await workspace.removeProject(id);
      await settled(h);
      assert(await until(() => terminalsOf(id).length === 0));
    } finally {
      await h.settle();
      h.dispose();
      await Deno.remove(dir, { recursive: true });
    }
  });
});

Deno.test("End stops the shell and keeps the tab", async () => {
  await withShell(async () => {
    const h = await bootCells([workspace, session, consoleCell]);
    const dir = await Deno.makeTempDir();
    try {
      await settled(h);
      await workspace.addProject(dir);
      const id = workspace.activeId;
      const pane = await workspace.addPane(id, "console");
      await consoleCell.open(pane, id);
      assert(await until(() => consoleCell.terms[pane]?.status === "live"));

      await consoleCell.stop(pane);
      // Long enough for the host's exit to have come back and been ignored.
      await new Promise((r) => setTimeout(r, 300));
      await settled(h);
      assertEquals(consoleCell.terms[pane]?.status, "exited");
      assert(workspace.panes[id].some((p) => p.id === pane));
    } finally {
      await h.settle();
      h.dispose();
      await Deno.remove(dir, { recursive: true });
    }
  });
});
