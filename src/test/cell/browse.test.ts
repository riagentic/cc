/**
 * The folder picker's state.
 *
 * The interesting cases are all about *not* losing the user's place: a folder
 * that cannot be read must leave the listing they were looking at alone, and
 * the path arithmetic has to agree with the filesystem at the root, where "up"
 * stops.
 */
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { bootCells } from "aio/testing";
import { browse, crumbs, parentOf, visibleEntries } from "../../cell/browse.ts";

Deno.test("parentOf stops at the root instead of walking past it", () => {
  assertEquals(parentOf("/home/dev/code"), "/home/dev");
  assertEquals(parentOf("/home"), "/");
  assertEquals(parentOf("/"), null);
  assertEquals(parentOf(""), null);
  // A trailing slash is the same folder, not a different one.
  assertEquals(parentOf("/home/dev/"), "/home");
});

Deno.test("crumbs name every ancestor, root first", () => {
  assertEquals(crumbs("/a/b"), [
    { name: "/", path: "/" },
    { name: "a", path: "/a" },
    { name: "b", path: "/a/b" },
  ]);
});

Deno.test("browse — lists folders only, marks repositories", async () => {
  const root = await Deno.makeTempDir();
  const h = await bootCells([browse]);
  try {
    await Deno.mkdir(join(root, "beta"));
    await Deno.mkdir(join(root, "Alpha"));
    await Deno.mkdir(join(root, ".hidden"));
    await Deno.mkdir(join(root, "repo", ".git"), { recursive: true });
    await Deno.writeTextFile(join(root, "notes.md"), "not a folder");

    await browse.go(root);
    const names = browse.entries.map((e) => e.name);
    // A file is never offered: this picker exists to choose a project.
    assertEquals(names.includes("notes.md"), false);
    // Case-insensitive order, so "Alpha" is not exiled above everything.
    assertEquals(names, [".hidden", "Alpha", "beta", "repo"]);
    assertEquals(browse.entries.find((e) => e.name === "repo")?.git, true);
    assertEquals(browse.entries.find((e) => e.name === "beta")?.git, false);

    // Dot-folders are in the state and out of the view until asked for.
    assertEquals(visibleEntries().map((e) => e.name), [
      "Alpha",
      "beta",
      "repo",
    ]);
    await browse.toggleHidden();
    assertEquals(visibleEntries().length, 4);
  } finally {
    h.dispose();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("browse — numbered folders sort like numbers", async () => {
  const root = await Deno.makeTempDir();
  const h = await bootCells([browse]);
  try {
    for (const n of ["v1", "v2", "v10"]) await Deno.mkdir(join(root, n));
    await browse.go(root);
    assertEquals(browse.entries.map((e) => e.name), ["v1", "v2", "v10"]);
  } finally {
    h.dispose();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("browse — a folder that cannot be read keeps you where you are", async () => {
  const root = await Deno.makeTempDir();
  const h = await bootCells([browse]);
  try {
    await Deno.mkdir(join(root, "real"));
    await browse.go(root);
    assertEquals(browse.cwd, root);

    await browse.go(join(root, "nope"));
    assert(browse.error !== null, "the failure is reported");
    assertEquals(browse.cwd, root, "and the listing is not thrown away");
    assertEquals(browse.entries.length, 1);

    browse.dismissError();
    assertEquals(browse.error, null);
  } finally {
    h.dispose();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("browse — up stops at the root, and go ignores nonsense", async () => {
  const h = await bootCells([browse]);
  try {
    await browse.go("/");
    await browse.up();
    assertEquals(browse.cwd, "/", "there is nowhere above the root");

    // The control plane can call a method with anything at all.
    await browse.go(undefined as unknown as string);
    assertEquals(browse.cwd, "/");
    await browse.go(42 as unknown as string);
    assertEquals(browse.cwd, "/");
  } finally {
    h.dispose();
  }
});
