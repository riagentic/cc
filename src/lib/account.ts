/**
 * @module
 * The agent account: a separate Linux user the local agent's commands run as.
 *
 * Why an account and not a tighter box: an app the agent builds keeps data in
 * its own `~/.<app>`, a toolchain installs into `~/.deno`, an app manager
 * keeps sockets in `/run/user/<uid>` — a read-only-home sandbox fights every
 * one of those, and the agent spends its turn on the walls. A user account is
 * a whole, ordinary machine for the agent; the walls sit at its edge (the
 * user's home, sudo, localhost, the user's screen), and those are set up once
 * by the machine's owner (see `examples/cc-agent/setup.sh`), not by this app.
 *
 * Nothing here knows any tool the agent might use. Pure: argv and names only —
 * the IO is in `local.server.ts`.
 */

export type Account = {
  user: string;
  uid: number;
  home: string;
  /** Its own X display (`:90`), or null when it has none. */
  display: string | null;
};

/** Programs a user installs for themselves land in one of these. Listed
 *  whether or not they exist yet: a tool installed by one command must be on
 *  PATH for the next. */
const HOME_BINS = [
  ".local/bin",
  "bin",
  ".deno/bin",
  ".cargo/bin",
  "go/bin",
  ".bun/bin",
  ".npm-global/bin",
];
const SYSTEM_PATH =
  "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

/** The account's environment, from nothing — not one variable of the user's
 *  own crosses over (tokens, their display, their session bus). */
export function accountEnv(
  a: Account,
  tmp: string,
  lang = "C.UTF-8",
): Record<string, string> {
  const run = `/run/user/${a.uid}`;
  return {
    HOME: a.home,
    USER: a.user,
    LOGNAME: a.user,
    SHELL: "/bin/bash",
    LANG: lang,
    PATH: [...HOME_BINS.map((d) => `${a.home}/${d}`), SYSTEM_PATH].join(":"),
    XDG_RUNTIME_DIR: run,
    DBUS_SESSION_BUS_ADDRESS: `unix:path=${run}/bus`,
    TMPDIR: tmp,
    ...(a.display
      ? { DISPLAY: a.display, XAUTHORITY: `${a.home}/.Xauthority` }
      : {}),
    // No colour: escape codes are noise a model pays for by the token.
    NO_COLOR: "1",
    FORCE_COLOR: "0",
    CLICOLOR: "0",
    TERM: "dumb",
  };
}

/** `env -i K=V…` — the prefix that switches to exactly that environment. */
const envArgs = (vars: Record<string, string>): string[] => [
  "env",
  "-i",
  ...Object.entries(vars).map(([k, v]) => `${k}=${v}`),
];

/**
 * sudo's arguments for one command as the account, in a systemd scope of its
 * own user manager named `unit`.
 *
 * The scope is the point: every process the command starts is in it, however
 * it detaches (`&`, `nohup`, `setsid`, a daemon's double fork). So "is
 * anything still running?" has a true answer (`systemctl --user is-active`),
 * and stopping is one call that misses nothing. The account's slice limits
 * (memory, tasks) apply to it as well.
 */
export function accountArgv(
  a: Account,
  unit: string,
  cmd: string,
  tmp: string,
  lang?: string,
): string[] {
  return [
    "-n",
    "-u",
    a.user,
    "--",
    ...envArgs(accountEnv(a, tmp, lang)),
    "systemd-run",
    "--user",
    "--scope",
    "--quiet",
    "--collect",
    `--unit=${unit}`,
    "bash",
    "-c",
    cmd,
  ];
}

/** sudo's arguments for `systemctl --user …` in the account's manager. */
export function accountCtlArgv(a: Account, args: string[]): string[] {
  const run = `/run/user/${a.uid}`;
  return [
    "-n",
    "-u",
    a.user,
    "--",
    "env",
    "-i",
    `XDG_RUNTIME_DIR=${run}`,
    `DBUS_SESSION_BUS_ADDRESS=unix:path=${run}/bus`,
    "systemctl",
    "--user",
    ...args,
  ];
}

/** A scope name systemd accepts, unique to this app process and this
 *  conversation: `cc-<conv>-<pid>-<n>`. */
export function unitName(conv: string, pid: number, n: number): string {
  const c = conv.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 16) || "x";
  return `cc-${c}-${pid}-${n}`;
}

/** An account name worth trying: a plain login name, not root. */
export const validAccountName = (name: string): boolean =>
  /^[a-z_][a-z0-9_-]{0,31}$/.test(name) && name !== "root";

/** One `getent passwd` line → uid and home, or null. */
export function parsePasswd(
  line: string,
): { user: string; uid: number; home: string } | null {
  const f = line.trim().split(":");
  if (f.length < 7) return null;
  const uid = Number(f[2]);
  if (!Number.isInteger(uid) || uid <= 0 || !f[5].startsWith("/")) return null;
  return { user: f[0], uid, home: f[5] };
}

/** The display in the account's own `xauth list` — the first local one. */
export function displayOfXauth(list: string): string | null {
  const m = /\/unix(:\d+)(?:\.\d+)?\s/.exec(list);
  return m ? m[1] : null;
}
