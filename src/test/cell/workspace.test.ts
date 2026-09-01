/**
 * Workspace — the settings that outlive a session. These methods are the only
 * place an invalid model or permission mode could reach the CLI's argv, so the
 * validation is what is worth pinning.
 */
import { assertEquals } from "@std/assert";
import { testCell } from "aio/testing";
import { workspace } from "../../cell/workspace.ts";

/** The active project's allowed directories — where a grant now lives. */
const allowed = (
  s: { projects: { id: string; allowedDirs: string[] }[]; activeId: string },
): string[] => s.projects.find((p) => p.id === s.activeId)?.allowedDirs ?? [];

testCell(
  workspace,
  "setModel accepts known ids and rejects anything else",
  (t) => {
    t.send.setModel("opus");
    t.expect.state((s) => s.defaults.model === "opus");
    t.send.setModel("definitely-not-a-model");
    // Unchanged, never passed through — this is the only place an invalid
    // model could reach the CLI's argv.
    t.expect.state((s) => s.defaults.model === "opus");
    t.send.setModel("haiku");
    t.expect.state((s) => s.defaults.model === "haiku");
  },
);

testCell(workspace, "setPermissionMode is likewise closed", (t) => {
  t.send.setPermissionMode("plan");
  t.expect.state((s) => s.defaults.permissionMode === "plan");
  t.send.setPermissionMode("rm -rf /");
  t.expect.state((s) => s.defaults.permissionMode === "plan");
});

testCell(
  workspace,
  "settings belong to the project, and do not follow you to the next one",
  async (t) => {
    t.init();
    const tmp = await Deno.makeTempDir();
    try {
      await Deno.mkdir(`${tmp}/a`);
      await Deno.mkdir(`${tmp}/b`);
      await t.send.addProject(`${tmp}/a`);
      t.send.setModel("opus");
      t.send.setPermissionMode("plan");
      t.send.setSkipPermissions(true);

      await t.send.addProject(`${tmp}/b`);
      t.send.setModel("haiku");
      t.send.setSkipPermissions(false);

      const a = t.getState().projects.find((p) => p.path === `${tmp}/a`)!;
      const b = t.getState().projects.find((p) => p.path === `${tmp}/b`)!;
      assertEquals(a.model, "opus");
      assertEquals(b.model, "haiku");
      // The one that matters most: a bypass chosen for one codebase must not
      // silently arrive at the next one.
      assertEquals(a.skipPermissions, true);
      assertEquals(b.skipPermissions, false);
      // B was added while A's mode was current, so it inherits it as a seed —
      // and changing B afterwards must not reach back into A.
      assertEquals(a.permissionMode, "plan");
    } finally {
      await Deno.remove(tmp, { recursive: true });
    }
  },
);

testCell(
  workspace,
  "removing the active project selects another",
  async (t) => {
    t.init();
    const a = await Deno.makeTempDir();
    const b = await Deno.makeTempDir();
    try {
      await t.send.addProject(a);
      await t.send.addProject(b);
      t.expect.state((s) => s.projects.length === 2);
      const active = t.getState().activeId;

      t.send.removeProject(active);
      t.expect.state((s) => s.projects.length === 1);
      // The selection must land on a project that still exists — a dangling
      // activeId would leave the app pointed at nothing with no way back.
      t.expect.state((s) => s.activeId === s.projects[0].id);
    } finally {
      await Deno.remove(a);
      await Deno.remove(b);
    }
  },
);

testCell(
  workspace,
  "removing the last project leaves no selection, not a stale id",
  (t) => {
    t.init();
    t.send.removeProject("nope"); // removing something absent is a no-op
    t.expect.state((s) => s.projects.length === 0);
    t.expect.state((s) => s.activeId === "");
  },
);

testCell(workspace, "setTheme round-trips all three states", (t) => {
  for (const theme of ["dark", "light", "system"] as const) {
    t.send.setTheme(theme);
    t.expect.state((s) => s.theme === theme);
  }
});

testCell(
  workspace,
  "an empty path is rejected with a message, not silently",
  async (t) => {
    t.init();
    await t.send.addProject("   ");
    t.expect.state((s) => s.projects.length === 0);
    t.expect.state((s) => s.error !== null);
    t.send.dismissError();
    t.expect.state((s) => s.error === null);
  },
);

testCell(workspace, "a path that is not a directory is refused", async (t) => {
  t.init();
  await t.send.addProject("/definitely/not/a/real/directory");
  t.expect.state((s) => s.projects.length === 0);
  t.expect.state((s) => (s.error ?? "").includes("Not a directory"));
});

testCell(
  workspace,
  "adding a real directory selects it, and re-adding is idempotent",
  async (t) => {
    t.init();
    const dir = await Deno.makeTempDir();
    try {
      await t.send.addProject(dir);
      t.expect.state((s) => s.projects.length === 1);
      t.expect.state((s) => s.activeId === s.projects[0].id);
      t.expect.state((s) => s.error === null);

      await t.send.addProject(`${dir}/`); // trailing slash is the same project
      t.expect.state((s) => s.projects.length === 1);
    } finally {
      await Deno.remove(dir);
    }
  },
);

testCell(
  workspace,
  "a typed path resolves like the command-line one, dashes included",
  async (t) => {
    t.init();
    const cwd = Deno.cwd();
    // Relative and `~` forms are what a person types; the field rejected both
    // outright while `cc ./sub` on the command line accepted them.
    await t.send.addProject("./src");
    t.expect.state((s) => s.projects.some((p) => p.path === `${cwd}/src`));

    // …and a path starting with a dash is a bad path, not "no path given".
    // Resolving it through the argv parser answered "the launch directory",
    // which quietly added the app's own cwd instead of reporting the typo.
    await t.send.addProject("-oops");
    t.expect.state((s) => !s.projects.some((p) => p.path === cwd));
    t.expect.state((s) => (s.error ?? "").includes("-oops"));

    // A directory is granted to a project, so one has to be selected. The
    // launch directory was added by `t.init()`'s bootstrap.
    await t.send.addAllowedDir("-oops");
    t.expect.state((s) => !allowed(s).includes(cwd));
    t.expect.state((s) => (s.error ?? "").includes("-oops"));

    // The same relative form, allowed rather than added.
    await t.send.addAllowedDir("./src");
    t.expect.state((s) => allowed(s).includes(`${cwd}/src`));
  },
);

testCell(workspace, "random action fuzzing keeps the settings valid", (t) => {
  t.init();
  t.randomActions(120);
  t.expect.invariant((s) =>
    typeof s.defaults.model === "string" && s.defaults.model.length > 0
  );
  t.expect.invariant((s) => Array.isArray(s.projects));
  t.expect.invariant((s) =>
    s.activeId === "" || s.projects.some((p) => p.id === s.activeId)
  );
});

testCell(
  workspace,
  "allowed directories: real ones stick, typos are refused",
  async (t) => {
    t.init();
    const dir = await Deno.makeTempDir();
    try {
      await t.send.addProject(dir); // a grant needs a project to belong to
      await t.send.addAllowedDir(dir);
      t.expect.state((s) => allowed(s).includes(dir));

      await t.send.addAllowedDir(`${dir}/`); // trailing slash is the same folder
      t.expect.state((s) => allowed(s).length === 1);

      await t.send.addAllowedDir("/definitely/not/here");
      t.expect.state((s) => allowed(s).length === 1);
      t.expect.state((s) => (s.error ?? "").includes("Not a directory"));

      t.send.removeAllowedDir(dir);
      t.expect.state((s) => allowed(s).length === 0);
    } finally {
      await Deno.remove(dir);
    }
  },
);

testCell(
  workspace,
  "Allow all is off by default and toggles both ways",
  (t) => {
    t.init();
    t.expect.state((s) => s.defaults.skipPermissions === false);
    t.send.setSkipPermissions(true);
    t.expect.state((s) => s.defaults.skipPermissions === true);
    t.send.setSkipPermissions(false);
    t.expect.state((s) => s.defaults.skipPermissions === false);
  },
);

testCell(
  workspace,
  "a project whose folder is deleted is marked gone, not left to fail at spawn",
  async (t) => {
    t.init();
    const dir = await Deno.makeTempDir();
    await t.send.addProject(dir);
    t.expect.state((s) => s.projects[0].missing === false);

    // The folder goes away underneath a persisted project — deleted, renamed,
    // unmounted. Until this was checked, the only symptom was "Could not start"
    // with nothing on screen to act on.
    await Deno.remove(dir);
    await t.send.refreshProjects();
    t.expect.state((s) => s.projects[0].missing === true);
    // The branch goes with it: a stale branch on a folder that is gone is a
    // second claim that is no longer true.
    t.expect.state((s) => s.projects[0].branch === null);
  },
);

testCell(
  workspace,
  "the only project is still removable when its folder is gone",
  async (t) => {
    t.init();
    const dir = await Deno.makeTempDir();
    await t.send.addProject(dir);
    await Deno.remove(dir);
    await t.send.refreshProjects();

    // This was the dead end: one project, its folder deleted. It could not be
    // started (no directory) and the UI hid the remove control unless a second
    // project existed — so there was no way out of the app's own error.
    const id = t.getState().projects[0].id;
    t.send.removeProject(id);
    t.expect.state((s) => s.projects.length === 0);
    t.expect.state((s) => s.activeId === "");
  },
);

testCell(
  workspace,
  "removing the active project prefers one that still exists",
  async (t) => {
    t.init();
    // Order matters: the dead project is first in the list, so a plain
    // `projects[0]` fallback would select it and move the same dead end along.
    const gone = await Deno.makeTempDir();
    const real = await Deno.makeTempDir();
    const active = await Deno.makeTempDir();
    try {
      await t.send.addProject(gone);
      await t.send.addProject(real);
      await t.send.addProject(active);
      await Deno.remove(gone);
      await t.send.refreshProjects();
      t.expect.state((s) => s.projects.length === 3);

      t.send.removeProject(t.getState().activeId);
      t.expect.state((s) => s.projects.length === 2);
      t.expect.state((s) => s.projects[0].missing === true);
      t.expect.state((s) => s.activeId === s.projects[1].id);
    } finally {
      await Deno.remove(real);
      await Deno.remove(active);
    }
  },
);

testCell(workspace, "setEffort is closed over the CLI's own values", (t) => {
  t.init();
  t.expect.state((s) => s.defaults.effort === ""); // the CLI's setting, untouched
  t.send.setEffort("xhigh");
  t.expect.state((s) => s.defaults.effort === "xhigh");
  // The CLI validates this flag and warns on an unknown value; the picker must
  // never be the thing that produces one.
  t.send.setEffort("turbo");
  t.expect.state((s) => s.defaults.effort === "xhigh");
  t.send.setEffort("");
  t.expect.state((s) => s.defaults.effort === "");
});
