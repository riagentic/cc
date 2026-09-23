/**
 * One conversation per project, running concurrently.
 *
 * The rules worth pinning are the ones a user would notice being broken:
 * switching project shows that project's transcript and not the other's; a
 * background project's events land in *its* record rather than over the one on
 * screen; and settings follow the codebase rather than the app.
 */
import { assert, assertEquals } from "@std/assert";
import { bootCells } from "aio/testing";
import {
  backgroundApprovals,
  busyProjects,
  session,
  sessionOf,
  view,
} from "../../cell/session.ts";
import { activeSettings, workspace } from "../../cell/workspace.ts";

/** Two projects, both known, with `a` selected. */
async function twoProjects() {
  const h = await bootCells([workspace, session]);
  await new Promise((r) => setTimeout(r, 0));
  await h.settle();
  const tmp = await Deno.makeTempDir();
  await Deno.mkdir(`${tmp}/a`);
  await Deno.mkdir(`${tmp}/b`);
  await workspace.addProject(`${tmp}/a`);
  const a = workspace.activeId;
  await workspace.addProject(`${tmp}/b`);
  const b = workspace.activeId;
  await workspace.select(a);
  await h.settle();
  return {
    h,
    a,
    b,
    tmp,
    async done() {
      await h.settle();
      h.dispose();
      await Deno.remove(tmp, { recursive: true });
    },
  };
}

const say = (text: string) => ({
  type: "assistant",
  message: {
    id: `m-${text}`,
    role: "assistant",
    content: [{ type: "text", text }],
  },
});

Deno.test("each project keeps its own transcript", async () => {
  const t = await twoProjects();
  try {
    await session.ingest(say("hello from A"), undefined, t.a);
    await session.ingest(say("hello from B"), undefined, t.b);

    // A is on screen: it sees its own message and only its own.
    assertEquals(workspace.activeId, t.a);
    assertEquals(view().messages.length, 1);
    assert(JSON.stringify(view().messages).includes("hello from A"));
    assert(!JSON.stringify(view().messages).includes("hello from B"));

    await workspace.select(t.b);
    await t.h.settle();
    assertEquals(view().messages.length, 1);
    assert(JSON.stringify(view().messages).includes("hello from B"));

    // And switching back does not cost A its conversation.
    await workspace.select(t.a);
    await t.h.settle();
    assert(JSON.stringify(view().messages).includes("hello from A"));
  } finally {
    await t.done();
  }
});

Deno.test("the top level comes to hold the project you selected", async () => {
  const t = await twoProjects();
  try {
    // `view()` resolves by key, so the transcript is right either way — which
    // is exactly why this needs asserting on its own. Without it the swap could
    // silently never happen (it did not, for a while) and every screen would
    // still look correct while the invariant the cell documents was false.
    await workspace.select(t.b);
    await t.h.settle();
    assertEquals(session.activeKey, t.b);
    assert(t.a in session.parked);
    assert(!(t.b in session.parked));

    await workspace.select(t.a);
    await t.h.settle();
    assertEquals(session.activeKey, t.a);
    assert(t.b in session.parked);
    assert(!(t.a in session.parked));
  } finally {
    await t.done();
  }
});

Deno.test("a background project's events never reach the one on screen", async () => {
  const t = await twoProjects();
  try {
    // Twenty events for the project nobody is looking at.
    for (let i = 0; i < 20; i++) {
      await session.ingest(say(`b-${i}`), undefined, t.b);
    }
    assertEquals(view().messages.length, 0);
    assertEquals(sessionOf(t.b).messages.length, 20);
  } finally {
    await t.done();
  }
});

Deno.test("a turn running in another project is reported, not hidden", async () => {
  const t = await twoProjects();
  try {
    await session.ingest(
      {
        type: "system",
        subtype: "init",
        cwd: `${t.tmp}/b`,
        session_id: "11111111-2222-3333-4444-555555555555",
        model: "claude-sonnet-5",
        tools: [],
        agents: [],
        skills: [],
        slash_commands: [],
        mcp_servers: [],
        permissionMode: "acceptEdits",
        claude_code_version: "2.1.251",
        memory_paths: {},
      },
      undefined,
      t.b,
    );
    await session.delta("text", "thinking hard", undefined, t.b);

    // `delta` marks the session working — for B, and only for B.
    assertEquals(sessionOf(t.b).status, "working");
    assertEquals(view().status, "offline");
    // The dock reads this to light B's tab while you are looking at A.
    assertEquals(busyProjects(), [t.b]);
  } finally {
    await t.done();
  }
});

Deno.test("an approval waiting in another project is surfaced", async () => {
  const t = await twoProjects();
  try {
    await session.ingest(
      {
        type: "control_request",
        request_id: "req_1",
        request: {
          subtype: "can_use_tool",
          tool_name: "Bash",
          input: { command: "rm -rf /" },
        },
      },
      undefined,
      t.b,
    );

    // Nothing on screen — the prompt renders for the active project only, so
    // without this the CLI in B would wait until it gave up and denied.
    assertEquals(view().permissions.length, 0);
    const waiting = backgroundApprovals();
    assertEquals(waiting.length, 1);
    assertEquals(waiting[0].id, t.b);
    assertEquals(waiting[0].count, 1);
  } finally {
    await t.done();
  }
});

Deno.test("settings resolve to the project on screen", async () => {
  const t = await twoProjects();
  try {
    await workspace.setModel("opus");
    assertEquals(activeSettings().model, "opus");

    await workspace.select(t.b);
    await t.h.settle();
    await workspace.setModel("haiku");
    assertEquals(activeSettings().model, "haiku");

    await workspace.select(t.a);
    await t.h.settle();
    // A is still on Opus: a model chosen in one codebase does not follow you.
    assertEquals(activeSettings().model, "opus");
  } finally {
    await t.done();
  }
});

Deno.test("an empty effort survives; an empty model does not", async () => {
  const h = await bootCells([workspace, session]);
  await new Promise((r) => setTimeout(r, 0));
  await h.settle();
  const dir = await Deno.makeTempDir();
  try {
    await workspace.addProject(dir);

    // `""` is a REAL value for effort — it means "leave the CLI's own setting
    // alone" — so the fallback must be `??` and not `||`. With `||` a user who
    // deliberately chose Default would silently get the seed instead, which is
    // the one flag whose whole purpose is not to override anything.
    await workspace.setEffort("");
    assertEquals(activeSettings().effort, "");

    await workspace.setEffort("xhigh");
    assertEquals(activeSettings().effort, "xhigh");

    // Model has no such empty meaning: it reaches the argv as `--model <x>`,
    // so an empty one must never get there. Every path yields a real id.
    const s = activeSettings();
    assert(typeof s.model === "string" && s.model.length > 0);
    assert(typeof s.permissionMode === "string" && s.permissionMode.length > 0);
    assert(Array.isArray(s.allowedDirs));
  } finally {
    await h.settle();
    h.dispose();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a new project starts where the CLI is configured to start", async () => {
  const h = await bootCells([workspace, session]);
  await new Promise((r) => setTimeout(r, 0));
  await h.settle();
  const dir = await Deno.makeTempDir();
  try {
    // The CLI's own spellings, in the project's own settings file.
    await Deno.mkdir(`${dir}/.claude`);
    await Deno.writeTextFile(
      `${dir}/.claude/settings.json`,
      JSON.stringify({
        model: "opus",
        effortLevel: "low",
        permissions: { defaultMode: "plan" },
      }),
    );
    await workspace.addProject(dir);

    const p = workspace.projects.find((x) => x.path === dir)!;
    assertEquals(p.model, "opus");
    assertEquals(p.effort, "low");
    assertEquals(p.permissionMode, "plan");
    // Never inherited from a settings file: an extra directory and a permission
    // bypass are grants this app's user makes here, deliberately.
    assertEquals(p.allowedDirs, []);
    assertEquals(p.skipPermissions, false);
  } finally {
    await h.settle();
    h.dispose();
    await Deno.remove(dir, { recursive: true });
  }
});

/* ── closing a session ────────────────────────────────────────────────────── */

Deno.test("a background project's session can be closed without switching", async () => {
  const t = await twoProjects();
  try {
    // Give B something to close, and a conversation worth keeping.
    await session.ingest(say("work in B"), undefined, t.b);
    await session.ingest(
      {
        type: "control_request",
        request_id: "req_x",
        request: {
          subtype: "can_use_tool",
          tool_name: "Bash",
          input: { command: "ls" },
        },
      },
      undefined,
      t.b,
    );
    assertEquals(sessionOf(t.b).permissions.length, 1);

    // A is on screen throughout: closing B must not disturb it, and must not
    // require going there and back.
    assertEquals(workspace.activeId, t.a);
    await session.stop(t.b);
    assertEquals(workspace.activeId, t.a);

    const b = sessionOf(t.b);
    assertEquals(b.status, "offline");
    assertEquals(b.pid, null);
    // The conversation survives. The CLI keeps its own copy too, so `resumeId`
    // stays valid — throwing it away on a mis-click is the expensive mistake.
    assert(JSON.stringify(b.messages).includes("work in B"));
    // A prompt nobody can answer any more is not left pending.
    assertEquals(b.permissions.filter((r) => r.status === "pending").length, 0);
    assertEquals(backgroundApprovals().length, 0);
  } finally {
    await t.done();
  }
});

Deno.test("a session whose working directory is deleted is closed", async () => {
  // A real spawned process in a real directory, which is then deleted under it.
  // Nothing announces that — a running `claude` has no idea the ground it is
  // standing on is gone — so this is exactly the state the watchdog exists for,
  // and the only honest way to test it is to create it.
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
  const h = await bootCells([workspace, session]);
  const doomed = `${home}/doomed`;
  await Deno.mkdir(doomed);
  try {
    await new Promise((r) => setTimeout(r, 0));
    await h.settle();
    await workspace.addProject(doomed);
    await session.start();
    for (let i = 0; i < 100 && session.status === "starting"; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    assertEquals(session.status, "ready");
    const pid = session.pid;
    assert(pid !== null);
    assertEquals(session.cwd, doomed);

    // The folder goes. The process does not notice, and neither would the app.
    await Deno.remove(doomed, { recursive: true });
    await session.watchFolders();

    assertEquals(session.status, "offline");
    assertEquals(session.pid, null);
    // Not a bare "it stopped": the reason is the whole value of noticing.
    assert((session.error ?? "").includes(doomed));
    assert((session.error ?? "").toLowerCase().includes("gone"));

    // And the process is actually gone, not just forgotten about.
    for (let i = 0; i < 100 && alive(pid); i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    assertEquals(alive(pid), false);
  } finally {
    await h.settle();
    h.dispose();
    if (previous === undefined) Deno.env.delete("CLAUDE_BIN");
    else Deno.env.set("CLAUDE_BIN", previous);
    await Deno.remove(home, { recursive: true }).catch(() => {});
  }
});

/** Is this pid still a process? `kill -0` asks without sending anything. */
function alive(pid: number): boolean {
  try {
    Deno.kill(pid, "SIGCONT");
    return true;
  } catch {
    return false;
  }
}

/* ── switching must never be silently lost ────────────────────────────────── */

Deno.test("the last tab clicked is the one you land on", async () => {
  const t = await twoProjects();
  try {
    // Two clicks in quick succession, neither awaited before the next — which
    // is what a real double-click on the dock produces. `select` used to await
    // a git probe before finishing, so the second click read a selection pinned
    // at entry and either no-opped or lost the race: you clicked B and stayed
    // on A, with nothing anywhere saying why.
    // `a` is the one currently selected, so the FIRST click has real work to do
    // and the second is the one at risk. Ordering matters to this test: with
    // both clicks aimed away from the current selection, the old shape happened
    // to land correctly and the bug hid.
    const results = await Promise.allSettled([
      workspace.select(t.b),
      workspace.select(t.a),
    ]);
    assert(results.every((r) => r.status === "fulfilled"));
    // The last one clicked wins. Under the old shape the second click read a
    // selection pinned at entry — still `a` — decided it was already there, and
    // returned without doing anything: you clicked `a` and stayed on `b`.
    assertEquals(workspace.activeId, t.a);
    await t.h.settle();
    assertEquals(session.activeKey, t.a);
  } finally {
    await t.done();
  }
});

Deno.test("a switch survives the project list changing under it", async () => {
  const t = await twoProjects();
  try {
    // Everything that re-probes the list — the Refresh button, a failed spawn,
    // the folder watchdog — used to be able to refuse the transaction the click
    // was riding in, taking the selection with it.
    for (let i = 0; i < 12; i++) {
      const want = i % 2 === 0 ? t.b : t.a;
      const r = await Promise.allSettled([
        workspace.select(want),
        workspace.refreshProjects(),
        workspace.refreshGit(),
      ]);
      assert(
        r[0].status === "fulfilled",
        "a click must never be refused by other work",
      );
      assertEquals(workspace.activeId, want);
    }
  } finally {
    await t.done();
  }
});

Deno.test("removing a project takes its process at once, and its engine config and loops once the undo lapses", async () => {
  const { bootCells } = await import("aio/testing");
  const { local, localConfig } = await import("../../cell/local.ts");
  const { loops } = await import("../../cell/loops.ts");
  const h = await bootCells([workspace, session, local, loops]);
  const dir = await Deno.makeTempDir();
  const keep = await Deno.makeTempDir();
  try {
    await workspace.addProject(keep);
    const keepId = workspace.activeId;
    await workspace.addProject(dir);
    const id = workspace.activeId;

    // Give the doomed project all three kinds of per-project state.
    await local.setEngine(id, "ollama");
    await loops.add("check the build", 60);
    const mine = loops.loops.filter((l) => l.projectId === id).length;
    assertEquals(mine, 1);
    assertEquals(localConfig(id).engine, "ollama");

    workspace.removeProject(id);
    // The three cells are told asynchronously, on purpose — a slow teardown
    // must not hold up the click — so settle before reading them.
    await h.settle();

    assertEquals(workspace.projects.length, 1);
    assertEquals(workspace.activeId, keepId);
    // Stored state waits while the removal can still be undone: Undo brings
    // the project back with its engine and its loops, not without them.
    assertEquals(localConfig(id).engine, "ollama");
    assertEquals(loops.loops.some((l) => l.projectId === id), true);

    // Accepted — the undo offer dropped — and now it all goes.
    workspace.clearForgotten();
    await h.settle();
    // Engine configuration is PERSISTED, so leaving it behind meant every
    // project ever removed stayed in the stored state forever.
    assertEquals(local.configs[id], undefined);
    // A loop names the project it fires into. One whose project is gone can
    // never run and is on no page, because the loops page lists the active
    // project's loops only.
    assertEquals(loops.loops.some((l) => l.projectId === id), false);
    // …and nothing of the removed project's conversation is parked.
    assertEquals(session.parked[id], undefined);
  } finally {
    await h.settle();
    h.dispose();
    await Deno.remove(dir, { recursive: true });
    await Deno.remove(keep, { recursive: true });
  }
});

Deno.test("the leftover sweep drops state keyed by a project that is not there", async () => {
  const { bootCells } = await import("aio/testing");
  const { local, strayConfigs } = await import("../../cell/local.ts");
  const { pruneUnknown } = await import("../../cell/workspace.ts");
  const { loops } = await import("../../cell/loops.ts");
  const h = await bootCells([workspace, session, local, loops]);
  const dir = await Deno.makeTempDir();
  try {
    await workspace.addProject(dir);
    const real = workspace.activeId;
    // State under an id no project has — written by an older build, orphaned
    // by a crash, or typed at the control plane. It is only findable by
    // comparing the two lists, which is what the sweep does.
    await local.setEngine("ghost-project", "ollama");
    await local.setEngine(real, "lmstudio");
    assertEquals(local.configs["ghost-project"] !== undefined, true);
    assertEquals(strayConfigs(), ["ghost-project"]);

    // Deliberately NOT run at boot: at boot the project list is a moving
    // target — loaded, then the launch directory added, then whatever the user
    // types into a window that is already up — and every automatic placement
    // of this sweep deleted the settings of a project that had just been made.
    pruneUnknown();
    await h.settle();

    assertEquals(local.configs["ghost-project"], undefined);
    // …and a project that is really there keeps its configuration.
    assertEquals(local.configs[real]?.engine, "lmstudio");
    assertEquals(strayConfigs(), []);
  } finally {
    await h.settle();
    h.dispose();
    await Deno.remove(dir, { recursive: true });
  }
});
