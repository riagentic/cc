/**
 * The agent account, as arguments: who the command runs as, in what
 * environment, and in which scope — the parts that decide whether anything of
 * the user's crosses over, and whether what it starts can be found again.
 */
import { assert, assertEquals } from "@std/assert";
import {
  type Account,
  accountArgv,
  accountCtlArgv,
  accountEnv,
  displayOfXauth,
  parsePasswd,
  unitName,
  validAccountName,
} from "../../lib/account.ts";

const agent: Account = {
  user: "cc-agent",
  uid: 1002,
  home: "/home/cc-agent",
  display: ":90",
};

Deno.test("a command runs as the account, from an empty environment, in a named scope", () => {
  const argv = accountArgv(agent, "cc-k-1-1", "deno task check", "/tmp/t");
  assertEquals(argv.slice(0, 4), ["-n", "-u", "cc-agent", "--"]);
  assertEquals(argv.slice(4, 6), ["env", "-i"]);
  const at = argv.indexOf("systemd-run");
  assert(at > 0, argv.join(" "));
  assertEquals(argv.slice(at), [
    "systemd-run",
    "--user",
    "--scope",
    "--quiet",
    "--collect",
    "--unit=cc-k-1-1",
    "bash",
    "-c",
    "deno task check",
  ]);
  // Nothing but the account's own variables between `env -i` and the scope.
  const vars = argv.slice(6, at).map((v) => v.slice(0, v.indexOf("=")));
  assertEquals(vars.sort(), Object.keys(accountEnv(agent, "/tmp/t")).sort());
});

Deno.test("the account's environment is its own: home, runtime dir, its screen — no secrets, no user display", () => {
  const env = accountEnv(agent, "/tmp/t");
  assertEquals(env.HOME, "/home/cc-agent");
  assertEquals(env.XDG_RUNTIME_DIR, "/run/user/1002");
  assertEquals(env.DBUS_SESSION_BUS_ADDRESS, "unix:path=/run/user/1002/bus");
  assertEquals(env.DISPLAY, ":90");
  assertEquals(env.XAUTHORITY, "/home/cc-agent/.Xauthority");
  assertEquals(env.TMPDIR, "/tmp/t");
  // Tools it installs for itself are found by the next command.
  for (const bin of [".local/bin", ".deno/bin", ".cargo/bin"]) {
    assert(env.PATH.includes(`/home/cc-agent/${bin}`), env.PATH);
  }
  assert(!Object.keys(env).some((k) => /TOKEN|KEY|SECRET/.test(k)));
  const headless = accountEnv({ ...agent, display: null }, "/tmp/t");
  assertEquals(headless.DISPLAY, undefined);
  assertEquals(headless.XAUTHORITY, undefined);
});

Deno.test("systemctl goes to the account's own manager", () => {
  assertEquals(accountCtlArgv(agent, ["is-active", "u.scope"]), [
    "-n",
    "-u",
    "cc-agent",
    "--",
    "env",
    "-i",
    "XDG_RUNTIME_DIR=/run/user/1002",
    "DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1002/bus",
    "systemctl",
    "--user",
    "is-active",
    "u.scope",
  ]);
});

Deno.test("scope names are ones systemd accepts, whatever the conversation key", () => {
  for (const key of ["3f1c-uuid-like", "k/../x y", ""]) {
    const u = unitName(key, 4242, 7);
    assert(/^cc-[A-Za-z0-9_-]{1,16}-4242-7$/.test(u), u);
  }
});

Deno.test("only a plain login name is an account — never root", () => {
  assert(validAccountName("cc-agent"));
  for (const bad of ["root", "", "a b", "../x", "Agent", "-x"]) {
    assert(!validAccountName(bad), bad);
  }
});

Deno.test("passwd and xauth lines are read, junk is not", () => {
  assertEquals(
    parsePasswd("cc-agent:x:1002:1002::/home/cc-agent:/bin/bash\n"),
    { user: "cc-agent", uid: 1002, home: "/home/cc-agent" },
  );
  assertEquals(parsePasswd("root:x:0:0:root:/root:/bin/bash"), null);
  assertEquals(parsePasswd("garbage"), null);
  assertEquals(
    displayOfXauth("box/unix:90  MIT-MAGIC-COOKIE-1  0badc0de\n"),
    ":90",
  );
  assertEquals(displayOfXauth(""), null);
});
