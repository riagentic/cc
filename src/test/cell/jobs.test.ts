/**
 * Jobs — the reader for Claude Code's background sessions.
 *
 * These files belong to another program, written by a CLI that is upgraded
 * independently of this app, so the tests are about *tolerance*: a missing
 * field, a truncated line, a state nobody has heard of. The one thing that must
 * never happen is the page failing to render because a job's JSON moved on.
 */
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { listJobs } from "../../cell/catalog.server.ts";
import { blockedJobs, jobs } from "../../cell/jobs.ts";
import { testCell } from "aio/testing";

/** A jobs root at a temp `HOME`, so the real `~/.claude/jobs` is never read. */
async function withJobsHome(
  write: (root: string) => Promise<void>,
  run: () => Promise<void>,
): Promise<void> {
  const home = await Deno.makeTempDir();
  const root = join(home, ".claude", "jobs");
  await Deno.mkdir(root, { recursive: true });
  await write(root);
  const before = Deno.env.get("HOME");
  Deno.env.set("HOME", home);
  try {
    await run();
  } finally {
    if (before === undefined) Deno.env.delete("HOME");
    else Deno.env.set("HOME", before);
    await Deno.remove(home, { recursive: true });
  }
}

const job = (extra: Record<string, unknown>) =>
  JSON.stringify({
    state: "working",
    detail: "doing the thing",
    tokens: 42,
    inFlight: { tasks: 1, queued: 0 },
    intent: "fix the tests",
    name: "fix the tests",
    sessionId: "11111111-2222-3333-4444-555555555555",
    daemonShort: "abc12345",
    cliVersion: "2.1.251",
    cwd: "/home/dev/code/x",
    createdAt: "2026-08-30T10:00:00.000Z",
    updatedAt: "2026-08-30T10:05:00.000Z",
    ...extra,
  });

Deno.test("a background session is read with its state, model and timing", async () => {
  await withJobsHome(
    async (root) => {
      await Deno.mkdir(join(root, "abc12345"));
      await Deno.writeTextFile(
        join(root, "abc12345", "state.json"),
        job({ respawnFlags: ["--agent", "claude", "--model", "opus"] }),
      );
    },
    async () => {
      const [j] = await listJobs();
      assertEquals(j.id, "abc12345");
      assertEquals(j.state, "working");
      assertEquals(j.tokens, 42);
      assertEquals(j.inFlight.tasks, 1);
      // The model lives only in the flags the CLI would respawn it with.
      assertEquals(j.model, "opus");
      // ISO strings, not epoch numbers — both shapes appear in these files.
      assertEquals(j.createdAt, Date.parse("2026-08-30T10:00:00.000Z"));
    },
  );
});

Deno.test("a blocked job surfaces what it is waiting for", async () => {
  await withJobsHome(
    async (root) => {
      await Deno.mkdir(join(root, "blocked01"));
      await Deno.writeTextFile(
        join(root, "blocked01", "state.json"),
        job({
          state: "blocked",
          daemonShort: "blocked01",
          needs: "confirm the migration",
          block: {
            questions: [
              { question: "Drop the old column?" },
              { question: "Backfill first?" },
            ],
          },
        }),
      );
    },
    async () => {
      const [j] = await listJobs();
      assertEquals(j.state, "blocked");
      assertEquals(j.needs, "confirm the migration");
      // Without the questions a blocked job shows a reason and nothing to act
      // on, which is the half of the story that cannot be answered.
      assertEquals(j.questions, ["Drop the old column?", "Backfill first?"]);
    },
  );
});

Deno.test("a state nobody has heard of is 'unknown', not a crash", async () => {
  await withJobsHome(
    async (root) => {
      await Deno.mkdir(join(root, "future01"));
      await Deno.writeTextFile(
        join(root, "future01", "state.json"),
        job({ state: "hibernating", daemonShort: "future01" }),
      );
    },
    async () => {
      const [j] = await listJobs();
      // The CLI is upgraded independently of this app. A state it invents next
      // month must render as a row, not throw the page away.
      assertEquals(j.state, "unknown");
    },
  );
});

Deno.test("a half-written timeline line is skipped, not fatal", async () => {
  await withJobsHome(
    async (root) => {
      await Deno.mkdir(join(root, "partial1"));
      await Deno.writeTextFile(
        join(root, "partial1", "state.json"),
        job({ daemonShort: "partial1" }),
      );
      await Deno.writeTextFile(
        join(root, "partial1", "timeline.jsonl"),
        [
          '{"at":"2026-08-30T10:01:00.000Z","state":"working","detail":"one","text":"a"}',
          '{"at":"2026-08-30T10:02:00.000Z","state":"working","detail":"two","text":"b"}',
          '{"at":"2026-08-30T10:03:00.000Z","state":"work', // still being written
        ].join("\n"),
      );
    },
    async () => {
      const [j] = await listJobs();
      assertEquals(j.timeline.length, 2);
      // Oldest last: the page reverses it, and the order has to be the file's.
      assertEquals(j.timeline[1].detail, "two");
    },
  );
});

Deno.test("a timeline entry's text is capped", async () => {
  await withJobsHome(
    async (root) => {
      await Deno.mkdir(join(root, "chatty01"));
      await Deno.writeTextFile(
        join(root, "chatty01", "state.json"),
        job({ daemonShort: "chatty01" }),
      );
      await Deno.writeTextFile(
        join(root, "chatty01", "timeline.jsonl"),
        JSON.stringify({
          at: "2026-08-30T10:01:00.000Z",
          state: "done",
          detail: "finished",
          text: "x".repeat(50_000),
        }) + "\n",
      );
    },
    async () => {
      const [j] = await listJobs();
      // This is state, broadcast to every client on every poll, and the page
      // shows one line of it. A job that wrote an essay must not become the
      // app's network cost.
      assert(j.timeline[0].text.length <= 600);
      assertEquals(j.timeline[0].detail, "finished");
    },
  );
});

Deno.test("a directory with no state.json is not a job", async () => {
  await withJobsHome(
    async (root) => {
      await Deno.mkdir(join(root, "empty001"));
      // `pins.json` sits beside the job directories and is not one of them.
      await Deno.writeTextFile(join(root, "pins.json"), "[]");
    },
    async () => assertEquals(await listJobs(), []),
  );
});

Deno.test("no jobs directory at all is an empty list, not an error", async () => {
  const home = await Deno.makeTempDir();
  const before = Deno.env.get("HOME");
  Deno.env.set("HOME", home);
  try {
    assertEquals(await listJobs(), []);
  } finally {
    if (before === undefined) Deno.env.delete("HOME");
    else Deno.env.set("HOME", before);
    await Deno.remove(home, { recursive: true });
  }
});

testCell(jobs, "selecting the same job twice closes it", (t) => {
  t.send.select("abc");
  t.expect.state((s) => s.selectedId === "abc");
  t.send.select("abc");
  t.expect.state((s) => s.selectedId === "");
});

Deno.test("blockedJobs is the set that needs a human", () => {
  // A pure read over whatever the cell holds — the rail badge is built on it,
  // and a badge that counts the wrong jobs is worse than no badge.
  const all = jobs.jobs;
  assert(blockedJobs().every((j) => j.state === "blocked"));
  assert(blockedJobs().length <= all.length);
});
