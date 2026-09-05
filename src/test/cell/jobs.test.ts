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
import { forgetJob, listJobs, readDaemon } from "../../cell/catalog.server.ts";
import { blockedJobs, explainRefusal, jobs } from "../../cell/jobs.ts";
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

/* ── the state the CLI cannot get out of ──────────────────────────────────── */

/** Write a daemon roster naming `pid` as the supervisor. */
async function withRoster(home: string, pid: number): Promise<void> {
  const dir = join(home, ".claude", "daemon");
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(
    join(dir, "roster.json"),
    JSON.stringify({ proto: 1, supervisorPid: pid, updatedAt: 1, workers: {} }),
  );
}

Deno.test("a job is a leftover when nothing is running it", async () => {
  await withJobsHome(async (root) => {
    await Deno.mkdir(join(root, "aaa1"));
    await Deno.writeTextFile(
      join(root, "aaa1", "state.json"),
      job({ state: "blocked", daemonShort: "aaa1", needs: "an answer" }),
    );
    await Deno.mkdir(join(root, "bbb2"));
    await Deno.writeTextFile(
      join(root, "bbb2", "state.json"),
      job({ state: "done", daemonShort: "bbb2" }),
    );
    // A supervisor pid that cannot be alive: pid 1 is init, so use one that is
    // certainly free at the top of the pid space.
    await withRoster(join(root, "..", ".."), 4_194_303);
  }, async () => {
    const found = await listJobs();
    const blocked = found.find((j) => j.id === "aaa1");
    const done = found.find((j) => j.id === "bbb2");
    assert(blocked && done);
    // The claim is stale — nothing is running it, so nothing will answer.
    assertEquals(blocked.stale, true);
    // …but a job that already finished is not a leftover. It is finished.
    assertEquals(done.stale, false);
  });
});

Deno.test("a live service means no job is a leftover", async () => {
  await withJobsHome(async (root) => {
    await Deno.mkdir(join(root, "ccc3"));
    await Deno.writeTextFile(
      join(root, "ccc3", "state.json"),
      job({ state: "blocked", daemonShort: "ccc3" }),
    );
    // This very process: certainly alive.
    await withRoster(join(root, "..", ".."), Deno.pid);
  }, async () => {
    const found = await listJobs();
    assertEquals(found[0].stale, false);
  });
});

Deno.test("no roster at all is not a running service", async () => {
  await withJobsHome(async (root) => {
    await Deno.mkdir(join(root, "ddd4"));
    await Deno.writeTextFile(
      join(root, "ddd4", "state.json"),
      job({ state: "working", daemonShort: "ddd4" }),
    );
  }, async () => {
    const daemon = await readDaemon();
    assertEquals(daemon.running, false);
    assertEquals(daemon.pid, 0);
    const found = await listJobs();
    assertEquals(found[0].stale, true);
  });
});

Deno.test("forgetting a job removes its record and nothing else", async () => {
  await withJobsHome(async (root) => {
    await Deno.mkdir(join(root, "eee5"));
    await Deno.writeTextFile(
      join(root, "eee5", "state.json"),
      job({
        state: "blocked",
        daemonShort: "eee5",
        worktreePath: "/tmp/some-worktree",
      }),
    );
    await Deno.writeTextFile(join(root, "eee5", "timeline.jsonl"), "{}\n");
  }, async () => {
    const done = await forgetJob("eee5");
    assertEquals(done.error, null);
    // The worktree is reported rather than deleted: it is the user's code, and
    // a record removed without the CLI cannot clean one up safely.
    assertEquals(done.worktree, "/tmp/some-worktree");
    assertEquals((await listJobs()).length, 0);
  });
});

Deno.test("forgetting is idempotent, and refuses a made-up id", async () => {
  await withJobsHome(async () => {}, async () => {
    // Already gone is the outcome the caller wanted.
    assertEquals((await forgetJob("nothere")).error, null);
    // An id that is not an id never becomes a path.
    const bad = await forgetJob("../../../etc");
    assert(bad.error !== null && bad.error.includes("Not a job id"));
  });
});

Deno.test("a refusal about the service is corrected, not repeated", () => {
  // The CLI's own words, verified against 2.1.261. It advises waiting for a
  // restart that will not happen, because nothing restarts the service on its
  // own — and following that advice is what a user does before giving up.
  const cliSaid = "couldn't remove 6c6ad404 — the background service may be " +
    "restarting. Try again in a moment.";

  const corrected = explainRefusal(cliSaid, false);
  assert(!corrected.includes("Try again in a moment"), corrected);
  assert(corrected.includes("Removing the record"), corrected);
  // The part that names what failed is kept: the reader still needs it.
  assert(corrected.includes("couldn't remove 6c6ad404"), corrected);

  // With a service actually running, the CLI's advice is sound and is left
  // alone — this app does not rewrite messages it cannot improve.
  assertEquals(explainRefusal(cliSaid, true), cliSaid);
  // And a refusal about something else is never touched.
  const other = "couldn't remove 6c6ad404 — the worktree has unpushed commits";
  assertEquals(explainRefusal(other, false), other);
});
