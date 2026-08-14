/**
 * Workspace — the settings that outlive a session. These methods are the only
 * place an invalid model or permission mode could reach the CLI's argv, so the
 * validation is what is worth pinning.
 */
import { testCell } from "aio/testing";
import { workspace } from "../../cell/workspace.ts";

testCell(
  workspace,
  "setModel accepts known ids and rejects anything else",
  (t) => {
    t.send.setModel("opus");
    t.expect.state((s) => s.model === "opus");
    t.send.setModel("definitely-not-a-model");
    t.expect.state((s) => s.model === "opus"); // unchanged, never passed through
    t.send.setModel("haiku");
    t.expect.state((s) => s.model === "haiku");
  },
);

testCell(workspace, "setPermissionMode is likewise closed", (t) => {
  t.send.setPermissionMode("plan");
  t.expect.state((s) => s.permissionMode === "plan");
  t.send.setPermissionMode("rm -rf /");
  t.expect.state((s) => s.permissionMode === "plan");
});

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

    await t.send.addAllowedDir("-oops");
    t.expect.state((s) => !s.allowedDirs.includes(cwd));
    t.expect.state((s) => (s.error ?? "").includes("-oops"));

    // The same relative form, allowed rather than added.
    await t.send.addAllowedDir("./src");
    t.expect.state((s) => s.allowedDirs.includes(`${cwd}/src`));
  },
);

testCell(workspace, "random action fuzzing keeps the settings valid", (t) => {
  t.init();
  t.randomActions(120);
  t.expect.invariant((s) => typeof s.model === "string" && s.model.length > 0);
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
      await t.send.addAllowedDir(dir);
      t.expect.state((s) => s.allowedDirs.includes(dir));

      await t.send.addAllowedDir(`${dir}/`); // trailing slash is the same folder
      t.expect.state((s) => s.allowedDirs.length === 1);

      await t.send.addAllowedDir("/definitely/not/here");
      t.expect.state((s) => s.allowedDirs.length === 1);
      t.expect.state((s) => (s.error ?? "").includes("Not a directory"));

      t.send.removeAllowedDir(dir);
      t.expect.state((s) => s.allowedDirs.length === 0);
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
    t.expect.state((s) => s.skipPermissions === false);
    t.send.setSkipPermissions(true);
    t.expect.state((s) => s.skipPermissions === true);
    t.send.setSkipPermissions(false);
    t.expect.state((s) => s.skipPermissions === false);
  },
);
