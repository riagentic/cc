/**
 * Loops — a prompt on a schedule.
 *
 * The rules worth pinning are the ones that make a loop safe to leave running:
 * it never fires into a project it does not belong to, it never fires into a
 * turn already in flight, and pausing it means the schedule itself stops rather
 * than a flag getting checked somewhere later. Each of those is the difference
 * between a standing check and a pile of prompts the user never typed.
 *
 * `bootCells` rather than `testCell`: a loop reads the active project from
 * `workspace` and the turn state from `session`, and the schedule effect it
 * arms only fires on the standalone runtime's virtual clock.
 */
import { assert, assertEquals } from "@std/assert";
import { bootCells } from "aio/testing";
import { loops, MIN_EVERY_SEC, projectLoops } from "../../cell/loops.ts";
import { session } from "../../cell/session.ts";
import { workspace } from "../../cell/workspace.ts";

/**
 * Wait for boot to be genuinely finished.
 *
 * `workspace.onInit` queues `bootstrap` on a macrotask — it has to, because the
 * cell's runtime is not up during `onInit` — so `settle()` alone returns before
 * that dispatch has even been made. Yielding first lets it start; settling then
 * waits for it. Without both, the test's `addProject` races bootstrap's, and
 * under snapshot isolation the loser is refused rather than merged.
 */
async function settled(h: { settle: () => Promise<void> }): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
  await h.settle();
}

/** Boot the three cells a loop touches, with one temp project selected. */
async function withLoops(
  run: (
    h: { advance: (ms: number) => Promise<void> },
    dir: string,
  ) => Promise<void>,
): Promise<void> {
  const h = await bootCells([workspace, session, loops]);
  await settled(h);
  const dir = await Deno.makeTempDir();
  try {
    await workspace.addProject(dir);
    await run(h, dir);
  } finally {
    h.dispose();
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("a loop needs a prompt and a project", async () => {
  await withLoops(async () => {
    await loops.add("   ", 60);
    assertEquals(loops.loops.length, 0);
    assert(loops.error !== null);

    await loops.add("run the tests", 300);
    assertEquals(loops.loops.length, 1);
    assertEquals(loops.loops[0].everySec, 300);
    assertEquals(loops.error, null);
  });
});

Deno.test("an interval below the floor is clamped, not refused", async () => {
  await withLoops(async () => {
    // A user typing `5` means "as often as you can". Refusing the row would be
    // a worse answer than honouring the floor — a turn takes longer than this.
    await loops.add("check CI", 5);
    assertEquals(loops.loops[0].everySec, MIN_EVERY_SEC);
  });
});

Deno.test("pausing stops the schedule; resuming re-arms it from now", async () => {
  await withLoops(async () => {
    await loops.add("watch the build", 60);
    const id = loops.loops[0].id;

    await loops.toggle(id);
    assertEquals(loops.loops[0].paused, true);
    // `nextAt: 0` rather than a flag consulted later: "paused" is a fact about
    // the schedule, so nothing downstream has to remember to check twice.
    assertEquals(loops.loops[0].nextAt, 0);

    await loops.toggle(id);
    assertEquals(loops.loops[0].paused, false);
    // Re-armed from *now* — otherwise a loop paused over lunch fires the
    // instant it resumes, once for every interval it slept through.
    assert(loops.loops[0].nextAt > Date.now());
  });
});

Deno.test("Run now arms an armed loop and leaves a paused one alone", async () => {
  await withLoops(async () => {
    await loops.add("deploy", 3_600);
    const id = loops.loops[0].id;

    await loops.toggle(id);
    await loops.runNow(id);
    assertEquals(loops.loops[0].nextAt, 0);

    await loops.toggle(id);
    await loops.runNow(id);
    assert(loops.loops[0].nextAt <= Date.now());
  });
});

Deno.test("editing a loop keeps its identity and its history", async () => {
  await withLoops(async () => {
    await loops.add("old prompt", 60);
    const id = loops.loops[0].id;

    await loops.update(id, "new prompt", 120);
    assertEquals(loops.loops[0].id, id);
    assertEquals(loops.loops[0].prompt, "new prompt");
    assertEquals(loops.loops[0].everySec, 120);
  });
});

Deno.test("removing a loop leaves the others alone", async () => {
  await withLoops(async () => {
    await loops.add("one", 60);
    await loops.add("two", 60);
    await loops.remove(loops.loops[0].id);
    assertEquals(loops.loops.length, 1);
    assertEquals(loops.loops[0].prompt, "two");
  });
});

Deno.test("a loop that is not due fires nothing", async () => {
  await withLoops(async () => {
    await loops.add("later", 3_600);
    await loops.tick();
    assertEquals(loops.loops[0].runs.length, 0);
  });
});

Deno.test("a loop belongs to exactly one project and fires into no other", async () => {
  const h = await bootCells([workspace, session, loops]);
  await settled(h);
  const a = await Deno.makeTempDir();
  const b = await Deno.makeTempDir();
  try {
    await workspace.addProject(a);
    const idA = workspace.activeId;
    await loops.add("for A", 60);

    await workspace.addProject(b);
    const idB = workspace.activeId;
    await loops.add("for B", 60);

    assertEquals(loops.loops.length, 2);
    // `projectLoops` is what the page renders: only the ones that can fire
    // here. A loop for another project is not hidden because it is
    // unimportant — showing it would misreport what is scheduled.
    assertEquals(projectLoops().map((l) => l.prompt), ["for B"]);

    // Due, but for the other project: the tick re-arms it and sends nothing.
    const forA = loops.loops.find((l) => l.projectId === idA)!;
    await loops.update(forA.id, forA.prompt, 60);
    await loops.runNow(forA.id);
    await loops.tick();

    assertEquals(
      loops.loops.find((l) => l.projectId === idA)!.runs.length,
      0,
    );
    assert(idA !== idB);
  } finally {
    h.dispose();
    await Deno.remove(a, { recursive: true });
    await Deno.remove(b, { recursive: true });
  }
});
