/**
 * Every worker this app spawns with `new Worker(new URL("./x.ts",
 * import.meta.url))` must be declared in deno.json `compile.include`, or it is
 * invisible to `deno compile`: the source is not a static import, so the
 * bundler cannot trace it, and the binary ships without it — green on the build
 * box (the file is still on disk), `Module not found` in the user's hands.
 *
 * aio's own `worker-includes.test.ts` guards the framework's workers but scans
 * only the framework tree, so an app's worker gets no coverage from it. This is
 * that guard for cc — it enumerates the app's `new Worker(new URL(...))` sites
 * and asserts each is in `compile.include`.
 */
import { assert, assertEquals } from "@std/assert";
import { fromFileUrl, join, normalize } from "@std/path";

/** Every `.ts`/`.tsx` file under a directory, recursively. No @std/fs so the
 *  test adds no dependency. */
async function* sources(dir: string): AsyncGenerator<string> {
  for await (const e of Deno.readDir(dir)) {
    // The `test/` tree spawns no real workers, and this file names the very
    // pattern it hunts for — scanning it would match its own documentation.
    if (e.name === "test") continue;
    const p = join(dir, e.name);
    if (e.isDirectory) yield* sources(p);
    else if (e.isFile && /\.tsx?$/.test(e.name)) yield p;
  }
}

const ROOT = fromFileUrl(new URL("../../..", import.meta.url));
const SRC = join(ROOT, "src");

/** Worker sites: `new Worker(new URL("<path>", import.meta.url) …)`. */
const WORKER =
  /new Worker\(\s*new URL\(\s*["']([^"']+)["']\s*,\s*import\.meta\.url/g;

Deno.test("every app Worker is declared in deno.json compile.include", async () => {
  const cfg = JSON.parse(await Deno.readTextFile(join(ROOT, "deno.json")));
  const declared: string[] = cfg?.compile?.include ?? [];
  const declaredAbs = new Set(
    declared.map((p: string) => normalize(join(ROOT, p))),
  );

  const found: string[] = [];
  for await (const path of sources(SRC)) {
    const text = await Deno.readTextFile(path);
    for (const m of text.matchAll(WORKER)) {
      // Resolve the worker path relative to the file that spawns it.
      found.push(normalize(join(path, "..", m[1])));
    }
  }

  // There is at least the grep worker — if this drops to zero the regex is
  // stale, not the app safe.
  assert(found.length >= 1, "no Worker sites found — has the pattern changed?");
  for (const abs of found) {
    assertEquals(
      declaredAbs.has(abs),
      true,
      `${abs} is spawned as a Worker but not in deno.json compile.include — ` +
        `it will be missing from the compiled binary`,
    );
  }
});
