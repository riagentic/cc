/**
 * Catalog — the configuration that decides what a session can do.
 *
 * Every reader here parses another program's files, so the tests are mostly
 * about the join: a name the session loaded, a file on disk, and the four ways
 * those two can disagree. Getting that wrong means either claiming a capability
 * the session does not have, or hiding a hook somebody just wrote.
 */
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { bootCells } from "aio/testing";
import {
  scanDefinitionDirs,
  scanHooks,
  scanMcp,
  scanPlugins,
} from "../../cell/catalog.server.ts";
import {
  catalog,
  mcpEntries,
  memoryBytes,
  skillEntries,
} from "../../cell/catalog.ts";
import { session } from "../../cell/session.ts";
import { workspace } from "../../cell/workspace.ts";

/** Run `fn` with `HOME` pointed at a scratch directory. */
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

/**
 * Wait for boot to be genuinely finished before a test acts.
 *
 * `workspace.onInit` queues `bootstrap` on a macrotask — it has to, because the
 * cell's runtime is not up during `onInit` — so `settle()` alone returns before
 * that dispatch has even been made. Without yielding first, bootstrap's own
 * `addProject` can land *after* the test's and move `activeId` off the project
 * the test just set up, which reads as a flaky assertion about skills.
 */
async function settled(h: { settle: () => Promise<void> }): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
  await h.settle();
}

const write = async (path: string, text: string) => {
  await Deno.mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
  await Deno.writeTextFile(path, text);
};

Deno.test("a skill's description comes from its front matter", async () => {
  await withHome(async (home) => {
    const project = await Deno.makeTempDir();
    try {
      await write(
        join(home, ".claude", "skills", "deploy", "SKILL.md"),
        "---\nname: deploy\ndescription: Ship it to production\n---\n\n# Deploy\n",
      );
      const [s] = await scanDefinitionDirs(project, "skill");
      assertEquals(s.name, "deploy");
      assertEquals(s.description, "Ship it to production");
      assertEquals(s.scope, "user");
      await Deno.remove(project, { recursive: true });
    } catch (e) {
      await Deno.remove(project, { recursive: true }).catch(() => {});
      throw e;
    }
  });
});

Deno.test("a definition with no description falls back to its first prose line", async () => {
  await withHome(async (home) => {
    const project = await Deno.makeTempDir();
    await write(
      join(home, ".claude", "commands", "ship.md"),
      "# Ship\n\nPush the current branch and open a PR.\n",
    );
    const [c] = await scanDefinitionDirs(project, "command");
    assertEquals(c.name, "ship");
    // Not the heading — a heading repeats the name and says nothing new.
    assertEquals(c.description, "Push the current branch and open a PR.");
    await Deno.remove(project, { recursive: true });
  });
});

Deno.test("a project definition shadows the user one of the same name", async () => {
  await withHome(async (home) => {
    const project = await Deno.makeTempDir();
    await write(
      join(home, ".claude", "skills", "review", "SKILL.md"),
      "---\ndescription: the user one\n---\n",
    );
    await write(
      join(project, ".claude", "skills", "review", "SKILL.md"),
      "---\ndescription: the project one\n---\n",
    );
    const found = await scanDefinitionDirs(project, "skill");
    // One name, one active definition — the CLI's own precedence. Listing both
    // would claim two are in play when only one can be.
    assertEquals(found.length, 1);
    assertEquals(found[0].description, "the project one");
    assertEquals(found[0].scope, "project");
    await Deno.remove(project, { recursive: true });
  });
});

Deno.test("a symlinked skill is found, not skipped", async () => {
  await withHome(async (home) => {
    const project = await Deno.makeTempDir();
    const elsewhere = await Deno.makeTempDir();
    try {
      // Keeping skills in a repo and linking them into ~/.claude/skills is an
      // ordinary setup, and `readDir` reports such an entry as a symlink with
      // `isDirectory: false` — so a check on the entry type found *nothing at
      // all* on a machine whose skills were all linked. Caught by running the
      // real app, not by the suite, which is why it is now in the suite.
      await write(
        join(elsewhere, "linked", "SKILL.md"),
        "---\ndescription: lives in a repo\n---\n",
      );
      await Deno.mkdir(join(home, ".claude", "skills"), { recursive: true });
      await Deno.symlink(
        join(elsewhere, "linked"),
        join(home, ".claude", "skills", "linked"),
      );

      const [s] = await scanDefinitionDirs(project, "skill");
      assertEquals(s.name, "linked");
      assertEquals(s.description, "lives in a repo");
    } finally {
      await Deno.remove(project, { recursive: true });
      await Deno.remove(elsewhere, { recursive: true });
    }
  });
});

Deno.test("a symlinked command file is found too", async () => {
  await withHome(async (home) => {
    const project = await Deno.makeTempDir();
    const elsewhere = await Deno.makeTempDir();
    try {
      await write(join(elsewhere, "ship.md"), "Push and open a PR.\n");
      await Deno.mkdir(join(home, ".claude", "commands"), { recursive: true });
      await Deno.symlink(
        join(elsewhere, "ship.md"),
        join(home, ".claude", "commands", "ship.md"),
      );

      const [c] = await scanDefinitionDirs(project, "command");
      assertEquals(c.name, "ship");
      assertEquals(c.description, "Push and open a PR.");
    } finally {
      await Deno.remove(project, { recursive: true });
      await Deno.remove(elsewhere, { recursive: true });
    }
  });
});

Deno.test("hooks are read from every settings file, with their scope", async () => {
  await withHome(async (home) => {
    const project = await Deno.makeTempDir();
    await write(
      join(home, ".claude", "settings.json"),
      JSON.stringify({
        hooks: {
          PreToolUse: [{
            matcher: "Bash",
            hooks: [{ type: "command", command: "echo user" }],
          }],
        },
      }),
    );
    await write(
      join(project, ".claude", "settings.local.json"),
      JSON.stringify({
        hooks: {
          Stop: [{ hooks: [{ type: "command", command: "echo done" }] }],
        },
      }),
    );
    const hooks = await scanHooks(project);
    assertEquals(hooks.length, 2);
    assertEquals(hooks[0].event, "PreToolUse");
    assertEquals(hooks[0].matcher, "Bash");
    assertEquals(hooks[0].scope, "user");
    assertEquals(hooks[1].event, "Stop");
    // No matcher means every tool, which the page has to be able to say.
    assertEquals(hooks[1].matcher, "");
    assertEquals(hooks[1].scope, "project");
    await Deno.remove(project, { recursive: true });
  });
});

Deno.test("MCP servers are read from .mcp.json and settings alike", async () => {
  await withHome(async () => {
    const project = await Deno.makeTempDir();
    await write(
      join(project, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          fs: { command: "npx", args: ["-y", "@mcp/fs"] },
          docs: { type: "http", url: "https://example.com/mcp" },
        },
      }),
    );
    const servers = await scanMcp(project);
    assertEquals(servers.map((s) => s.name), ["docs", "fs"]);
    const fs = servers.find((s) => s.name === "fs")!;
    assertEquals(fs.transport, "stdio");
    assertEquals(fs.target, "npx -y @mcp/fs");
    const docs = servers.find((s) => s.name === "docs")!;
    assertEquals(docs.transport, "http");
    assertEquals(docs.target, "https://example.com/mcp");
    // Configured says nothing about reachable — that only comes from a running
    // session, and an empty status is how this reader admits it does not know.
    assertEquals(fs.status, "");
    await Deno.remove(project, { recursive: true });
  });
});

Deno.test("installed plugins carry whether settings has them switched on", async () => {
  await withHome(async (home) => {
    await write(
      join(home, ".claude", "plugins", "installed_plugins.json"),
      JSON.stringify({
        version: 2,
        plugins: {
          "lsp@official": [{
            scope: "user",
            version: "1.0.0",
            installedAt: "2026-06-16T07:09:23.449Z",
          }],
          "old@official": [{ scope: "user", version: "0.1.0" }],
        },
      }),
    );
    await write(
      join(home, ".claude", "settings.json"),
      JSON.stringify({ enabledPlugins: { "lsp@official": true } }),
    );
    const plugins = await scanPlugins();
    assertEquals(plugins.map((p) => p.name), ["lsp", "old"]);
    const lsp = plugins[0];
    assertEquals(lsp.marketplace, "official");
    assertEquals(lsp.enabled, true);
    assertEquals(lsp.installedAt, Date.parse("2026-06-16T07:09:23.449Z"));
    // Installed and enabled are different states, and an installed-but-off
    // plugin looks identical to a broken one unless they are told apart.
    assertEquals(plugins[1].enabled, false);
  });
});

Deno.test("nothing configured is an empty list, never an error", async () => {
  await withHome(async () => {
    const project = await Deno.makeTempDir();
    assertEquals(await scanHooks(project), []);
    assertEquals(await scanMcp(project), []);
    assertEquals(await scanPlugins(), []);
    assertEquals(await scanDefinitionDirs(project, "skill"), []);
    await Deno.remove(project, { recursive: true });
  });
});

Deno.test("malformed JSON is ignored, not fatal", async () => {
  await withHome(async (home) => {
    const project = await Deno.makeTempDir();
    // These are other programs' files, hand-edited by users. A stray comma must
    // cost the page one row, not the whole page.
    await write(join(home, ".claude", "settings.json"), "{ not json ");
    await write(join(project, ".mcp.json"), "]]]");
    assertEquals(await scanHooks(project), []);
    assertEquals(await scanMcp(project), []);
    assert(Array.isArray(await scanPlugins()));
    await Deno.remove(project, { recursive: true });
  });
});

/* ── the cell, and the join with a running session ────────────────────────── */

Deno.test("the cell scans the active project", async () => {
  await withHome(async (home) => {
    const project = await Deno.makeTempDir();
    const h = await bootCells([workspace, session, catalog]);
    await settled(h);
    try {
      await write(
        join(project, ".claude", "skills", "local", "SKILL.md"),
        "---\ndescription: project only\n---\n",
      );
      await write(
        join(home, ".claude", "settings.json"),
        JSON.stringify({
          hooks: {
            Stop: [{ hooks: [{ type: "command", command: "notify" }] }],
          },
        }),
      );
      await workspace.addProject(project);
      await catalog.refresh();

      assertEquals(catalog.root, project);
      assertEquals(catalog.skills.map((s) => s.name), ["local"]);
      assertEquals(catalog.hooks.length, 1);
      assertEquals(catalog.error, null);
    } finally {
      h.dispose();
      await Deno.remove(project, { recursive: true });
    }
  });
});

Deno.test("a skill on disk that the session did not load says so", async () => {
  await withHome(async (home) => {
    const project = await Deno.makeTempDir();
    const h = await bootCells([workspace, session, catalog]);
    await settled(h);
    try {
      await write(
        join(home, ".claude", "skills", "onlyfile", "SKILL.md"),
        "---\ndescription: written after the session started\n---\n",
      );
      await workspace.addProject(project);
      await catalog.refresh();

      const [entry] = skillEntries();
      assertEquals(entry.name, "onlyfile");
      // Claiming it as loaded would promise a capability this turn does not
      // have; hiding it would hide a skill the user just wrote.
      assertEquals(entry.live, false);
      assertEquals(entry.description, "written after the session started");
    } finally {
      h.dispose();
      await Deno.remove(project, { recursive: true });
    }
  });
});

Deno.test("a capability the session loaded with no file behind it is a built-in", async () => {
  await withHome(async () => {
    const project = await Deno.makeTempDir();
    const h = await bootCells([workspace, session, catalog]);
    await settled(h);
    try {
      await workspace.addProject(project);
      await catalog.refresh();
      session.ingest({
        type: "system",
        subtype: "init",
        cwd: project,
        session_id: "00000000-0000-0000-0000-000000000000",
        model: "claude-sonnet-5",
        tools: [],
        agents: [],
        skills: ["loop", "acme:deploy"],
        slash_commands: [],
        mcp_servers: [{ name: "fs", status: "connected" }],
        permissionMode: "acceptEdits",
        claude_code_version: "2.1.251",
        memory_paths: {},
      } as never);
      await h.settle();

      const entries = skillEntries();
      const loop = entries.find((e) => e.name === "loop")!;
      // Built into the CLI: named by the session, no file to point at.
      assertEquals(loop.live, true);
      assertEquals(loop.scope, "builtin");
      // A plugin's contribution is named `plugin:skill` and its files sit
      // outside the scopes this app scans.
      const deploy = entries.find((e) => e.name === "acme:deploy")!;
      assertEquals(deploy.scope, "plugin");

      // A server the session reports but no scanned file declares is still
      // real — it came from --mcp-config, or a settings file we do not read.
      const fs = mcpEntries().find((m) => m.name === "fs")!;
      assertEquals(fs.status, "connected");
    } finally {
      h.dispose();
      await Deno.remove(project, { recursive: true });
    }
  });
});

/* ── memory ───────────────────────────────────────────────────────────────── */

Deno.test("memory is measured for a project you merely selected", async () => {
  await withHome(async (home) => {
    const project = await Deno.makeTempDir();
    const h = await bootCells([workspace, session, catalog]);
    await settled(h);
    try {
      await write(join(home, ".claude", "CLAUDE.md"), "# user memory\n");
      await write(join(project, "CLAUDE.md"), "# project memory\nrules.\n");
      await workspace.addProject(project);
      await catalog.refresh();

      // No session has ever been started here. Memory is a fact about the
      // project's files, and used to need a running process to say anything —
      // so selecting a project showed "Not scanned" beside a CLAUDE.md that
      // was sitting right there on disk.
      assertEquals(session.status, "offline");
      assert(catalog.memory.some((f) => f.path === join(project, "CLAUDE.md")));
      assert(
        catalog.memory.some((f) =>
          f.path === join(home, ".claude", "CLAUDE.md")
        ),
      );
      assert(catalog.memoryScannedAt !== null);
      assert(memoryBytes() > 0);
    } finally {
      h.dispose();
      await Deno.remove(project, { recursive: true });
    }
  });
});

Deno.test("switching project re-measures at once, but a repeat is paced", async () => {
  await withHome(async () => {
    const a = await Deno.makeTempDir();
    const b = await Deno.makeTempDir();
    const h = await bootCells([workspace, session, catalog]);
    await settled(h);
    try {
      await write(join(a, "CLAUDE.md"), "# a\n");
      await write(join(b, "CLAUDE.md"), "# b\n");
      await workspace.addProject(a);
      await catalog.refresh();
      assert(catalog.memory.some((f) => f.path === join(a, "CLAUDE.md")));

      // Pacing holds back a repeat of the *same* measurement and nothing else.
      const first = catalog.memoryScannedAt;
      await catalog.refreshMemory(false);
      assertEquals(catalog.memoryScannedAt, first);

      await workspace.addProject(b);
      await catalog.refresh();
      // A different project is a different question, so it is answered now
      // rather than after the pacing interval — showing the previous project's
      // files under this one's name is the failure being prevented.
      assert(catalog.memory.some((f) => f.path === join(b, "CLAUDE.md")));
      assertEquals(
        catalog.memory.some((f) => f.path === join(a, "CLAUDE.md")),
        false,
      );
    } finally {
      h.dispose();
      await Deno.remove(a, { recursive: true });
      await Deno.remove(b, { recursive: true });
    }
  });
});

Deno.test("Rescan never waits for the pacing interval", async () => {
  await withHome(async () => {
    const project = await Deno.makeTempDir();
    const h = await bootCells([workspace, session, catalog]);
    await settled(h);
    try {
      await workspace.addProject(project);
      await catalog.refresh();
      const before = catalog.memory.length;

      await write(join(project, "CLAUDE.md"), "# written just now\n");
      // The button is the user saying "I know something changed".
      await catalog.refreshMemory();
      assertEquals(catalog.memory.length, before + 1);
    } finally {
      h.dispose();
      await Deno.remove(project, { recursive: true });
    }
  });
});
