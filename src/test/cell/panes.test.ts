/**
 * Panes — the conversations and shells that live inside one project.
 *
 * Two rules here are load-bearing and easy to break by accident:
 *  1. the first conversation's pane id IS the project id, so a project saved
 *     before panes existed keeps its history instead of opening empty;
 *  2. the last conversation cannot be closed, because the Chat page would then
 *     have nothing to show and no honest way to get anything back.
 */
import { assertEquals } from "@std/assert";
import { testCell } from "aio/testing";
import { workspace } from "../../cell/workspace.ts";

testCell(workspace, "a new project already has one conversation", async (t) => {
  t.init();
  const dir = await Deno.makeTempDir();
  try {
    await t.send.addProject(dir);
    const id = t.getState().activeId;
    await t.send.addPane(id, "console"); // touches `panes`, which is lazy

    const list = t.getState().panes[id];
    assertEquals(list[0].kind, "session");
    // The identity rule. If this ever drifts, every project in every existing
    // install silently loses its conversation on the next launch.
    assertEquals(list[0].id, id);
  } finally {
    await Deno.remove(dir);
  }
});

testCell(
  workspace,
  "panes are numbered per kind, not per project",
  async (t) => {
    t.init();
    const dir = await Deno.makeTempDir();
    try {
      await t.send.addProject(dir);
      const id = t.getState().activeId;
      await t.send.addPane(id, "console");
      await t.send.addPane(id, "session");
      await t.send.addPane(id, "console");

      const titles = t.getState().panes[id].map((p) => p.title);
      // The first shell is "Console", not "Console 1" — a lone thing does not
      // need a number, and the second one arriving is what makes it ambiguous.
      assertEquals(titles, ["Chat", "Console", "Chat 2", "Console 2"]);
    } finally {
      await Deno.remove(dir);
    }
  },
);

testCell(workspace, "adding a pane shows it", async (t) => {
  t.init();
  const dir = await Deno.makeTempDir();
  try {
    await t.send.addProject(dir);
    const id = t.getState().activeId;
    const pane = await t.send.addPane(id, "session");
    assertEquals(t.getState().activePane[id], pane);
  } finally {
    await Deno.remove(dir);
  }
});

testCell(workspace, "an unknown project or kind adds nothing", async (t) => {
  t.init();
  const dir = await Deno.makeTempDir();
  try {
    await t.send.addProject(dir);
    const id = t.getState().activeId;
    assertEquals(await t.send.addPane(id, "spreadsheet"), "");
    assertEquals(await t.send.addPane("no-such-project", "console"), "");
    assertEquals(t.getState().panes[id] ?? [], []);
  } finally {
    await Deno.remove(dir);
  }
});

testCell(workspace, "the last conversation cannot be closed", async (t) => {
  t.init();
  const dir = await Deno.makeTempDir();
  try {
    await t.send.addProject(dir);
    const id = t.getState().activeId;
    const second = await t.send.addPane(id, "session");
    const shell = await t.send.addPane(id, "console");

    t.send.removePane(second);
    assertEquals(t.getState().panes[id].length, 2);

    // Shells are all closable: an empty Console page can offer to open one.
    t.send.removePane(shell);
    assertEquals(t.getState().panes[id].map((p) => p.kind), ["session"]);

    // And now the refusal.
    t.send.removePane(id);
    assertEquals(t.getState().panes[id].length, 1);
  } finally {
    await Deno.remove(dir);
  }
});

testCell(
  workspace,
  "closing what you are looking at lands somewhere",
  async (t) => {
    t.init();
    const dir = await Deno.makeTempDir();
    try {
      await t.send.addProject(dir);
      const id = t.getState().activeId;
      const a = await t.send.addPane(id, "console");
      const b = await t.send.addPane(id, "console");
      assertEquals(t.getState().activePane[id], b);

      // Closing the last row falls back to its neighbour, not to nothing — a
      // dangling activePane is a blank page with no way out.
      t.send.removePane(b);
      assertEquals(t.getState().activePane[id], a);

      t.send.removePane(a);
      assertEquals(t.getState().activePane[id], id);
    } finally {
      await Deno.remove(dir);
    }
  },
);

testCell(workspace, "selecting a pane also selects its project", async (t) => {
  t.init();
  const a = await Deno.makeTempDir();
  const b = await Deno.makeTempDir();
  try {
    await t.send.addProject(a);
    const first = t.getState().activeId;
    const pane = await t.send.addPane(first, "console");

    await t.send.addProject(b);
    assertEquals(t.getState().activeId !== first, true);

    // Clicking a child row is a way of choosing its parent too.
    t.send.selectPane(pane);
    assertEquals(t.getState().activeId, first);
    assertEquals(t.getState().activePane[first], pane);
  } finally {
    await Deno.remove(a);
    await Deno.remove(b);
  }
});

testCell(workspace, "renaming trims, caps, and refuses empty", async (t) => {
  t.init();
  const dir = await Deno.makeTempDir();
  try {
    await t.send.addProject(dir);
    const id = t.getState().activeId;
    const pane = await t.send.addPane(id, "console");
    const title = () =>
      t.getState().panes[id].find((p) => p.id === pane)!.title;

    t.send.renamePane(pane, "  build watch  ");
    assertEquals(title(), "build watch");

    // A long name is cut rather than refused: the row has a fixed width
    // whatever it says, so there is nothing to gain by rejecting it.
    t.send.renamePane(pane, "x".repeat(80));
    assertEquals(title(), "x".repeat(40));

    // Blank is not a name. The old one stays.
    t.send.renamePane(pane, "   ");
    assertEquals(title(), "x".repeat(40));
  } finally {
    await Deno.remove(dir);
  }
});

testCell(
  workspace,
  "a removed project keeps its panes for the undo",
  async (t) => {
    t.init();
    const dir = await Deno.makeTempDir();
    try {
      await t.send.addProject(dir);
      const id = t.getState().activeId;
      await t.send.addPane(id, "console");

      t.send.removeProject(id);
      // Still there: `forgotten` is an undo, and a project brought back should
      // come back with its conversations rather than as a bare tab. The sweep
      // that collects unreachable ones is deliberately NOT part of removal —
      // see `prunePanes`.
      assertEquals(t.getState().panes[id].length, 2);

      t.send.undoForget();
      assertEquals(t.getState().projects.length, 1);
      assertEquals(t.getState().panes[id].length, 2);
    } finally {
      await Deno.remove(dir);
    }
  },
);

testCell(workspace, "panes nothing can reach are swept", async (t) => {
  t.init();
  const a = await Deno.makeTempDir();
  const b = await Deno.makeTempDir();
  try {
    await t.send.addProject(a);
    const gone = t.getState().activeId;
    await t.send.addPane(gone, "console");
    await t.send.addProject(b);
    const kept = t.getState().activeId;
    await t.send.addPane(kept, "console"); // `panes` is filled in lazily

    t.send.removeProject(gone);
    t.send.clearForgotten(); // nothing can reach those panes any more
    t.send.prunePanes();

    assertEquals(t.getState().panes[gone], undefined);
    assertEquals(t.getState().activePane[gone], undefined);
    // And the sweep leaves the living alone.
    assertEquals(t.getState().panes[kept] !== undefined, true);
  } finally {
    await Deno.remove(a);
    await Deno.remove(b);
  }
});

testCell(
  workspace,
  "the sweep does nothing before the list has settled",
  async (t) => {
    t.init();
    // An empty project list means the workspace has not settled, not that there
    // are no projects — boot adds them one dispatch at a time, and a sweep that
    // landed in that gap would delete every pane on the machine.
    const dir = await Deno.makeTempDir();
    try {
      await t.send.addProject(dir);
      const id = t.getState().activeId;
      await t.send.addPane(id, "console");
      t.send.removeProject(id);
      t.send.clearForgotten();
      // No projects left at all: the sweep must decline rather than tidy.
      t.send.prunePanes();
      assertEquals(t.getState().panes[id].length, 2);
    } finally {
      await Deno.remove(dir);
    }
  },
);

testCell(
  workspace,
  "a project nobody has opened can still be selected",
  async (t) => {
    t.init();
    const a = await Deno.makeTempDir();
    const b = await Deno.makeTempDir();
    try {
      await t.send.addProject(a);
      await t.send.addProject(b);
      const second = t.getState().activeId;
      const first = t.getState().projects.find((p) => p.id !== second)!.id;
      // Nothing has written panes for either: the record appears when a second
      // conversation is added, and neither has one. But the dock still draws a
      // row for each, under the project's own id — see `panesOf`.
      assertEquals(t.getState().panes[first], undefined);

      t.send.selectPane(first);
      // It must select. Doing nothing here is what made keyboard walking the
      // dock stop dead at the first project nobody had opened.
      assertEquals(t.getState().activeId, first);
      assertEquals(t.getState().activePane[first], first);
      assertEquals(t.getState().panes[first]?.[0].id, first);
    } finally {
      await Deno.remove(a);
      await Deno.remove(b);
    }
  },
);

testCell(
  workspace,
  "selecting something that is not a pane does nothing",
  (t) => {
    t.init();
    t.send.selectPane("not-a-pane-or-a-project");
    assertEquals(t.getState().activeId, "");
    assertEquals(Object.keys(t.getState().panes).length, 0);
  },
);

testCell(workspace, "adding a pane is also choosing its project", async (t) => {
  t.init();
  const a = await Deno.makeTempDir();
  const b = await Deno.makeTempDir();
  try {
    await t.send.addProject(a);
    const first = t.getState().activeId;
    await t.send.addProject(b);
    const second = t.getState().activeId;
    assertEquals(second !== first, true);

    // The dock's "+" buttons sit on every project's row, not just the active
    // one. Without this the pane went to the project you clicked and you went
    // on looking at the other — and everything that acts on "the pane you are
    // on" then acted on the wrong one.
    const pane = await t.send.addPane(first, "console");
    assertEquals(t.getState().activeId, first);
    assertEquals(t.getState().activePane[first], pane);
  } finally {
    await Deno.remove(a);
    await Deno.remove(b);
  }
});
