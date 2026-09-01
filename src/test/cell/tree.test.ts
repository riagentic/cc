/**
 * Tree — the project's files, and the session's footprint over them.
 *
 * Two things are worth pinning: the walk stays inside what was asked for (only
 * expanded directories, no symlink follow, generated folders skipped), and the
 * touch overlay reports what the session actually did rather than what a
 * filesystem watcher would see.
 */
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { bootCells } from "aio/testing";
import { readFilePreview, readTree } from "../../cell/catalog.server.ts";
import { touchedPaths, tree } from "../../cell/tree.ts";
import { session } from "../../cell/session.ts";
import { workspace } from "../../cell/workspace.ts";

/** A small project on disk. */
async function fixture(): Promise<string> {
  const root = await Deno.makeTempDir();
  await Deno.mkdir(join(root, "src", "deep"), { recursive: true });
  await Deno.mkdir(join(root, "node_modules", "pkg"), { recursive: true });
  await Deno.mkdir(join(root, ".git"), { recursive: true });
  await Deno.writeTextFile(join(root, "README.md"), "# hi\n");
  await Deno.writeTextFile(
    join(root, "src", "app.ts"),
    "export const a = 1;\n",
  );
  await Deno.writeTextFile(join(root, "src", "deep", "x.ts"), "// deep\n");
  await Deno.writeTextFile(join(root, "node_modules", "pkg", "i.js"), "x\n");
  await Deno.writeTextFile(join(root, ".git", "HEAD"), "ref: x\n");
  return root;
}

Deno.test("only expanded directories are walked", async () => {
  const root = await fixture();
  try {
    const closed = await readTree(root, []);
    // `src` is listed, its contents are not: the cost of the panel is the cost
    // of what the user opened.
    assert(closed.some((n) => n.name === "src" && n.dir && !n.open));
    assertEquals(closed.some((n) => n.name === "app.ts"), false);

    const open = await readTree(root, [join(root, "src")]);
    assert(open.some((n) => n.name === "app.ts" && n.depth === 1));
    // One level, not all of them — `deep` is listed but not descended into.
    assert(open.some((n) => n.name === "deep" && n.dir));
    assertEquals(open.some((n) => n.name === "x.ts"), false);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("generated and VCS directories never appear", async () => {
  const root = await fixture();
  try {
    const nodes = await readTree(root, [root]);
    // Not a .gitignore parser — just the handful that would otherwise dominate
    // every repo and cost thousands of stats to say nothing.
    assertEquals(nodes.some((n) => n.name === "node_modules"), false);
    assertEquals(nodes.some((n) => n.name === ".git"), false);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("directories sort before files, each alphabetically", async () => {
  const root = await fixture();
  try {
    const nodes = await readTree(root, []);
    const names = nodes.map((n) => n.name);
    assertEquals(names, ["src", "README.md"]);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("a symlink is never followed", async () => {
  const root = await Deno.makeTempDir();
  try {
    await Deno.mkdir(join(root, "real"));
    await Deno.writeTextFile(join(root, "real", "f.txt"), "x");
    // A link pointing back up its own tree is an infinite walk, and `readTree`
    // has no cycle memory to catch it with.
    await Deno.symlink(root, join(root, "loop"));
    const nodes = await readTree(root, [root, join(root, "loop")]);
    assertEquals(nodes.some((n) => n.name === "loop"), false);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("a file preview reports its own size, and refuses binary", async () => {
  const root = await Deno.makeTempDir();
  try {
    const text = join(root, "a.ts");
    await Deno.writeTextFile(text, "const a = 1;\n");
    const ok = await readFilePreview(text);
    assertEquals(ok.error, "");
    assertEquals(ok.text, "const a = 1;\n");
    assertEquals(ok.bytes, 13);
    assertEquals(ok.truncated, false);

    // Invalid UTF-8. Rendering it would fill the pane with replacement glyphs,
    // which reads as a decoding bug in this app rather than as a binary file.
    const bin = join(root, "b.bin");
    await Deno.writeFile(bin, new Uint8Array([0xff, 0xfe, 0x00, 0x80]));
    const binary = await readFilePreview(bin);
    assertEquals(binary.error, "Binary file.");
    assertEquals(binary.text, "");
    assertEquals(binary.bytes, 4);

    const missing = await readFilePreview(join(root, "nope"));
    assertEquals(missing.error, "Not a file.");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("a large file is truncated and says so", async () => {
  const root = await Deno.makeTempDir();
  try {
    const big = join(root, "big.txt");
    await Deno.writeTextFile(big, "x".repeat(250_000));
    const p = await readFilePreview(big);
    assertEquals(p.truncated, true);
    // The *reported* size is the file's, not the slice's: a pane that says
    // 200 KB for a 250 KB file has quietly lied about the thing on screen.
    assertEquals(p.bytes, 250_000);
    assertEquals(p.text.length, 200_000);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("an unreadable directory yields nothing rather than throwing", async () => {
  // A directory that does not exist is the same case as one we cannot read:
  // show the parent, skip the contents, never take the page down.
  assertEquals(await readTree("/definitely/not/here", []), []);
});

/* ── the cell ─────────────────────────────────────────────────────────────── */

Deno.test("the cell expands, collapses and previews", async () => {
  const h = await bootCells([workspace, session, tree]);
  await new Promise((r) => setTimeout(r, 0));
  await h.settle();
  const root = await fixture();
  try {
    await workspace.addProject(root);
    await tree.refresh();
    assertEquals(tree.root, root);
    assert(tree.nodes.some((n) => n.name === "src"));
    assertEquals(tree.nodes.some((n) => n.name === "app.ts"), false);

    await tree.toggle(join(root, "src"));
    assert(tree.open.includes(join(root, "src")));
    assert(tree.nodes.some((n) => n.name === "app.ts"));

    // Collapsing drops the whole subtree, not just the folder itself —
    // re-opening a folder to find three levels still expanded is a surprise.
    await tree.toggle(join(root, "src", "deep"));
    assert(tree.open.includes(join(root, "src", "deep")));
    await tree.toggle(join(root, "src"));
    assertEquals(tree.open, []);

    await tree.toggle(join(root, "src"));
    await tree.select(join(root, "src", "app.ts"));
    assertEquals(tree.preview.text, "export const a = 1;\n");
    assertEquals(tree.preview.error, "");

    // Selecting the same file again closes it.
    await tree.select(join(root, "src", "app.ts"));
    assertEquals(tree.selected, "");
    assertEquals(tree.preview.text, "");
  } finally {
    h.dispose();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("switching project drops the other one's expansion and preview", async () => {
  const h = await bootCells([workspace, session, tree]);
  await new Promise((r) => setTimeout(r, 0));
  await h.settle();
  const a = await fixture();
  const b = await fixture();
  try {
    await workspace.addProject(a);
    await tree.refresh();
    await tree.toggle(join(a, "src"));
    await tree.select(join(a, "README.md"));
    assert(tree.open.length > 0);
    assertEquals(tree.selected, join(a, "README.md"));

    await workspace.addProject(b);
    await tree.refresh();
    assertEquals(tree.root, b);
    // Both named paths under a directory that is no longer the subject.
    assertEquals(tree.open, []);
    assertEquals(tree.selected, "");
    assert(tree.nodes.every((n) => n.path.startsWith(b)));
  } finally {
    h.dispose();
    await Deno.remove(a, { recursive: true });
    await Deno.remove(b, { recursive: true });
  }
});

Deno.test("the touch overlay reports the session's own file calls", async () => {
  const h = await bootCells([workspace, session, tree]);
  try {
    session.ingest({
      type: "assistant",
      message: {
        id: "m1",
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "t1",
            name: "Read",
            input: { file_path: "/p/a.ts" },
          },
          {
            type: "tool_use",
            id: "t2",
            name: "Read",
            input: { file_path: "/p/b.ts" },
          },
          {
            type: "tool_use",
            id: "t3",
            name: "Edit",
            input: { file_path: "/p/b.ts" },
          },
        ],
      },
    } as never);
    await h.settle();

    const touched = touchedPaths();
    assertEquals(touched.get("/p/a.ts"), "read");
    // Written beats read: a file the model read and *then* edited is one it
    // changed, and that is the fact worth surfacing.
    assertEquals(touched.get("/p/b.ts"), "written");
    // A tool that names no file is not a touch.
    assertEquals(touched.has("/p/c.ts"), false);
  } finally {
    h.dispose();
  }
});
