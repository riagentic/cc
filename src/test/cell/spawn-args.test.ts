/**
 * The argv handed to the Claude Code CLI.
 *
 * This is the one place a permission decision becomes a real flag on a real
 * process, so it is asserted directly rather than inferred from behaviour.
 */
import { assertEquals } from "@std/assert";
import { buildArgs } from "../../cell/claude.server.ts";

const base = { cwd: "/p", model: "sonnet", permissionMode: "acceptEdits" };

Deno.test("the default: a permission mode, no bypass, no extra dirs", () => {
  const a = buildArgs(base);
  assertEquals(a.includes("--permission-mode"), true);
  assertEquals(a[a.indexOf("--permission-mode") + 1], "acceptEdits");
  assertEquals(a.includes("--dangerously-skip-permissions"), false);
  assertEquals(a.includes("--add-dir"), false);
});

Deno.test("allowed directories become one --add-dir each", () => {
  const a = buildArgs({ ...base, allowedDirs: ["/tmp", "/srv/x"] });
  const dirs = a.reduce<string[]>(
    (acc, v, i) => (a[i - 1] === "--add-dir" ? [...acc, v] : acc),
    [],
  );
  assertEquals(dirs, ["/tmp", "/srv/x"]);
});

Deno.test("Allow all replaces the permission mode rather than joining it", () => {
  const a = buildArgs({ ...base, skipPermissions: true });
  assertEquals(a.includes("--dangerously-skip-permissions"), true);
  // Passing both would be contradictory — the mode must be gone.
  assertEquals(a.includes("--permission-mode"), false);
});

Deno.test("Allow all still honours --add-dir and --resume", () => {
  const a = buildArgs({
    ...base,
    skipPermissions: true,
    allowedDirs: ["/tmp"],
    resume: "sess-1",
  });
  assertEquals(a.includes("--dangerously-skip-permissions"), true);
  assertEquals(a[a.indexOf("--add-dir") + 1], "/tmp");
  assertEquals(a[a.indexOf("--resume") + 1], "sess-1");
});

Deno.test("the stream-json contract is always present", () => {
  const a = buildArgs(base);
  for (const flag of ["-p", "--input-format", "--output-format", "--verbose"]) {
    assertEquals(a.includes(flag), true, `missing ${flag}`);
  }
  assertEquals(a[a.indexOf("--output-format") + 1], "stream-json");
});

Deno.test("--effort is passed only when chosen", () => {
  const base = {
    cwd: "/p",
    model: "sonnet",
    permissionMode: "acceptEdits",
  };
  // The default is "leave the CLI's own setting alone" — passing a value the
  // user never picked would silently override what they configured elsewhere.
  assertEquals(buildArgs(base).includes("--effort"), false);
  assertEquals(buildArgs({ ...base, effort: "" }).includes("--effort"), false);

  const high = buildArgs({ ...base, effort: "high" });
  assertEquals(high.includes("--effort"), true);
  assertEquals(high[high.indexOf("--effort") + 1], "high");
});
