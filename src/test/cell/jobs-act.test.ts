/**
 * `jobs.act` — the only place the app *acts* on a background session. The CLI
 * owns these jobs, so what is worth pinning is the argv that reaches it, and
 * that a refusal comes back as an error on the page instead of silence.
 */
import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { bootCells } from "aio/testing";
import { jobs } from "../../cell/jobs.ts";

/** A stub `claude` that records its argv and exits as told, under a scratch
 *  HOME so the real `~/.claude/jobs` is never read by the rescan. */
async function withStubCli(
  exitCode: number,
  stderr: string,
  run: (argvFile: string) => Promise<void>,
): Promise<void> {
  const home = await Deno.makeTempDir();
  await Deno.mkdir(join(home, ".claude", "jobs"), { recursive: true });
  const argvFile = join(home, "argv");
  const bin = join(home, "claude-stub");
  await Deno.writeTextFile(
    bin,
    `#!/usr/bin/env bash\necho "$@" >> ${argvFile}\n` +
      (stderr ? `echo "${stderr}" >&2\n` : "") + `exit ${exitCode}\n`,
  );
  await Deno.chmod(bin, 0o755);

  const beforeHome = Deno.env.get("HOME");
  const beforeBin = Deno.env.get("CLAUDE_BIN");
  Deno.env.set("HOME", home);
  Deno.env.set("CLAUDE_BIN", bin);
  const booted = await bootCells([jobs]);
  try {
    await run(argvFile);
  } finally {
    booted.dispose();
    if (beforeHome === undefined) Deno.env.delete("HOME");
    else Deno.env.set("HOME", beforeHome);
    if (beforeBin === undefined) Deno.env.delete("CLAUDE_BIN");
    else Deno.env.set("CLAUDE_BIN", beforeBin);
    await Deno.remove(home, { recursive: true });
  }
}

Deno.test("stop and respawn reach the CLI as its own subcommands", async () => {
  await withStubCli(0, "", async (argvFile) => {
    await jobs.act("abc12345", "stop");
    await jobs.act("abc12345", "respawn");
    const argv = (await Deno.readTextFile(argvFile)).trim().split("\n");
    assertEquals(argv, ["stop abc12345", "respawn abc12345"]);
    assertEquals(jobs.error, null);
    assertEquals(jobs.busyId, "");
  });
});

Deno.test("remove maps to `rm` and closes the detail it deleted", async () => {
  await withStubCli(0, "", async (argvFile) => {
    jobs.select("abc12345");
    assertEquals(jobs.selectedId, "abc12345");
    await jobs.act("abc12345", "remove");
    assertEquals((await Deno.readTextFile(argvFile)).trim(), "rm abc12345");
    assertEquals(jobs.selectedId, "");
  });
});

Deno.test("a refusal surfaces as the CLI's own words, not silence", async () => {
  await withStubCli(1, "job is still attached", async () => {
    await jobs.act("abc12345", "stop");
    assertEquals(jobs.error, "job is still attached");
    assertEquals(jobs.busyId, "");
  });
});

Deno.test("an id that is not a directory name never reaches an argv", async () => {
  await withStubCli(0, "", async (argvFile) => {
    await jobs.act("abc; rm -rf /", "stop");
    assertEquals(jobs.error, "Not a job id: abc; rm -rf /");
    const recorded = await Deno.readTextFile(argvFile).catch(() => "");
    assertEquals(recorded, "");
  });
});
