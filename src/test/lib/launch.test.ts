/**
 * What "run this project" resolves to.
 *
 * The rule this file exists to hold is *do not guess*: a run button that runs
 * the wrong command, or a command that is not there, teaches people not to
 * trust the control. So every case below is either "the project said so" or
 * "there is no button".
 */
import { assertEquals } from "@std/assert";
import { launches, makeTargets, noManifests } from "../../lib/launch.ts";

Deno.test("a project with nothing to say gets no buttons", () => {
  const { dev, prod } = launches(noManifests());
  assertEquals(dev, null);
  assertEquals(prod, null);
});

Deno.test("a deno task is preferred over an npm script", () => {
  // A repository with both is a Deno project with npm dependencies far more
  // often than the reverse, and the manifest that defines a *task* is the one
  // that means it.
  const { dev } = launches({
    ...noManifests(),
    denoTasks: ["dev", "test"],
    npmScripts: ["dev"],
  });
  assertEquals(dev?.command, "deno task dev");
  assertEquals(dev?.from, "deno.json");
});

Deno.test("nothing is invented for a manifest that lacks the script", () => {
  // A package.json with only "build" does not get `npm run dev`.
  const { dev, prod } = launches({
    ...noManifests(),
    npmScripts: ["build", "lint"],
  });
  assertEquals(dev, null);
  assertEquals(prod, null);
});

Deno.test("production means run, never build", () => {
  // A project that only knows how to build is not offered a run button:
  // building and running are different acts, and one of them takes minutes.
  const built = launches({ ...noManifests(), denoTasks: ["dev", "build"] });
  assertEquals(built.dev?.command, "deno task dev");
  assertEquals(built.prod, null);

  const runnable = launches({ ...noManifests(), denoTasks: ["start"] });
  assertEquals(runnable.prod?.command, "deno task start");
});

Deno.test("cargo is the fallback, and knows both its modes", () => {
  const { dev, prod } = launches({ ...noManifests(), cargo: true });
  assertEquals(dev?.command, "cargo run");
  assertEquals(prod?.command, "cargo run --release");
});

Deno.test("a Makefile is read for targets, not parsed", () => {
  const text = [
    "# a comment",
    "CFLAGS := -O2",
    "dev: deps",
    "\t@echo running",
    "start:",
    "\t./app",
    "%.o: %.c",
    "\t$(CC) -c $<",
    ".PHONY: dev start",
  ].join("\n");
  const targets = makeTargets(text);
  assertEquals(targets.includes("dev"), true);
  assertEquals(targets.includes("start"), true);
  // A variable assignment is not a target, and neither is a pattern rule.
  assertEquals(targets.includes("CFLAGS"), false);
  assertEquals(targets.includes("%.o"), false);
  // `.PHONY` starts with a dot, which the pattern excludes on purpose: it is
  // a directive, and offering to run it would be nonsense.
  assertEquals(targets.includes(".PHONY"), false);
});
