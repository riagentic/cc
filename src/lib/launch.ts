/**
 * @module
 * What "run this project" means, for this project.
 *
 * "Start it in developer mode" is a different command in every ecosystem, and
 * guessing wrong is worse than not offering the button: a command that does
 * nothing, or does something else, teaches people not to trust the control.
 * So the answer is *read* off the project — from the files that already say
 * how it is run — and when nothing says, the button is not offered.
 *
 * Pure: this takes what was found on disk and returns commands. Reading the
 * disk is `catalog.server.ts`'s job, and testing this needs no filesystem.
 */

/** What a project's manifests say about running it. */
export type Manifests = {
  /** Task names from `deno.json` / `deno.jsonc`. */
  denoTasks: string[];
  /** Script names from `package.json`. */
  npmScripts: string[];
  /** True when the project has a `Cargo.toml`. */
  cargo: boolean;
  /** Target names from a `Makefile`. */
  makeTargets: string[];
};

export const noManifests = (): Manifests => ({
  denoTasks: [],
  npmScripts: [],
  cargo: false,
  makeTargets: [],
});

/** One way to start the project. */
export type Launch = {
  /** The shell command, exactly as it will be typed. */
  command: string;
  /** What names it in the interface. */
  title: string;
  /** Where the answer came from, so a reader can check it. */
  from: string;
};

/**
 * The two launches, in the order of preference below — or `null` for either
 * when the project does not say.
 *
 * The order is not arbitrary: a project with both a `deno.json` and a
 * `package.json` is a Deno project with npm dependencies far more often than
 * the reverse, and the manifest that defines a *task* is the one that means
 * it. Within each manifest the names are the conventional ones and nothing is
 * invented — a project with no `dev` script does not get `npm run dev`.
 */
export function launches(
  m: Manifests,
): { dev: Launch | null; prod: Launch | null } {
  const has = (list: string[], name: string) => list.includes(name);

  const dev: Launch | null = has(m.denoTasks, "dev")
    ? { command: "deno task dev", title: "dev", from: "deno.json" }
    : has(m.npmScripts, "dev")
    ? { command: "npm run dev", title: "dev", from: "package.json" }
    : has(m.makeTargets, "dev")
    ? { command: "make dev", title: "dev", from: "Makefile" }
    : m.cargo
    ? { command: "cargo run", title: "dev", from: "Cargo.toml" }
    : null;

  // Production is the deliberately conservative one. "start" means run the
  // thing that was built; a project that only knows how to *build* is not
  // offered a run button, because building and running are different acts and
  // one of them takes minutes.
  const prod: Launch | null = has(m.denoTasks, "start")
    ? { command: "deno task start", title: "production", from: "deno.json" }
    : has(m.npmScripts, "start")
    ? { command: "npm start", title: "production", from: "package.json" }
    : has(m.makeTargets, "start")
    ? { command: "make start", title: "production", from: "Makefile" }
    : m.cargo
    ? {
      command: "cargo run --release",
      title: "production",
      from: "Cargo.toml",
    }
    : null;

  return { dev, prod };
}

/**
 * Target names from a Makefile.
 *
 * Deliberately shallow: a line that starts at column zero, names something
 * without spaces or `$`, and is followed by a colon. That is a target as
 * people write them; it is not a Make parser, and it does not try to be —
 * pattern rules, variables and includes are all correctly ignored rather than
 * half-understood.
 */
export function makeTargets(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split("\n")) {
    const m = /^([A-Za-z0-9][A-Za-z0-9._-]*)\s*:(?!=)/.exec(line);
    if (m) out.push(m[1]);
  }
  return [...new Set(out)];
}
