/**
 * `cc <folder>` — the working project folder taken from the command line.
 *
 * The parsing is the part worth pinning: aio's own flags travel in the same
 * argv, and under Electron the child process is relaunched with more of them,
 * so "the first argument" is not good enough — it must be the first
 * *positional* one.
 */
import { assertEquals } from "@std/assert";
import { projectArg } from "../../cell/claude.server.ts";

const cwd = Deno.cwd();
const home = Deno.env.get("HOME") ?? "/";

Deno.test("no argument — the launch directory, marked as not explicit", () => {
  assertEquals(projectArg([]), { path: cwd, explicit: false });
  assertEquals(projectArg(["--client=electron", "--expose"]), {
    path: cwd,
    explicit: false,
  });
});

Deno.test("the first positional argument wins, whatever the flags do", () => {
  assertEquals(projectArg(["/srv/app"]), { path: "/srv/app", explicit: true });
  assertEquals(projectArg(["--client=electron", "/srv/app"]), {
    path: "/srv/app",
    explicit: true,
  });
  assertEquals(projectArg(["/srv/app", "--expose"]), {
    path: "/srv/app",
    explicit: true,
  });
  assertEquals(projectArg(["/first", "/second"]), {
    path: "/first",
    explicit: true,
  });
});

Deno.test("relative and ~ paths resolve to absolute ones", () => {
  assertEquals(projectArg(["~/code/x"]).path, `${home}/code/x`);
  assertEquals(projectArg(["./sub"]).path, `${cwd}/sub`);
  assertEquals(projectArg(["sub"]).path, `${cwd}/sub`);
});

Deno.test("an empty argument is not a folder", () => {
  assertEquals(projectArg([""]).explicit, false);
});
