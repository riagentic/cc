/**
 * @module
 * The pure core of the local agent: prompt, tool schemas, token budgeting,
 * context packing, wire hygiene and OpenAI-style stream accumulation. Nothing
 * in this file touches aio, Deno, or the network — it is all functions over
 * values, so the part of the agent that must be *right* is the part that is
 * trivially testable.
 *
 * One rule runs through all of it: **the window decides.** A model with 8k
 * of context gets a terse prompt, small tool results and early compaction; a
 * model with 1M gets the full working method, large reads and a history it
 * almost never has to fold. Nothing here assumes a size — every constant is a
 * fraction of the window it is spending.
 */
import type {
  LocalConfig,
  LocalMode,
  LocalMsg,
  LocalPermission,
  LocalTodo,
  LocalToolCall,
  PromptEnv,
} from "../type/local.ts";

/* ── permission ───────────────────────────────────────────────────────────── */

/** The modes the picker offers, worded the way the Claude side words its own —
 *  the app should not have two vocabularies for one idea. */
export const LOCAL_PERMISSIONS: {
  id: LocalPermission;
  label: string;
  hint: string;
}[] = [
  {
    id: "ask",
    label: "Ask every time",
    hint: "See each command before it runs",
  },
  {
    id: "dontAsk",
    label: "Don't ask",
    hint: "Runs commands unasked in a sandbox — destructive ones are refused",
  },
  { id: "bypass", label: "Bypass", hint: "No checks at all. Anything runs." },
];

/**
 * A project's permission mode, including one configured before there were
 * three of them.
 *
 * Anything unrecognised reads as `ask`: a junk value from a persisted file, a
 * hand-edited config or a future version must fail *closed*, because the value
 * decides whether a shell command runs without anyone seeing it.
 */
export function permissionOf(cfg: LocalConfig | undefined): LocalPermission {
  const p = cfg?.permission;
  if (p === "bypass" || p === "dontAsk" || p === "ask") return p;
  // The two-valued field this replaced. "always" meant exactly today's bypass.
  return cfg?.shApproval === "always" ? "bypass" : "ask";
}

/**
 * Why a shell command is too dangerous to run unwatched, or `null` if nothing
 * matched.
 *
 * This is the guardrail behind "Don't ask": no prompts, but no quiet damage
 * either. It is a *deny-list over words*, which cannot be complete — a
 * determined model can obfuscate any of these — so it is not the boundary on
 * its own: in "Don't ask" the command also runs in a sandbox that cannot write
 * outside the project where one is available. The list is what stops damage
 * *inside* it — a working tree deleted, a branch pushed.
 *
 * The whole string is scanned, not just its first word: `ls && rm -rf .` is an
 * `rm`, and so is `x=1; sudo rm` — and so is the script handed to `bash -c`
 * or `eval`, which is read the same way.
 *
 * Over-refusing is NOT free, though: every refusal is a round the model spends
 * finding another way, and a live session lost one to `npm ls -g` being read
 * as an install. So a rule names the verb that does the damage, not the tool
 * that has one; and inside the sandbox, where the kernel already refuses every
 * write outside the project and its /tmp, the rules about the rest of the
 * machine (system installs, services, disks, other users' powers) step aside
 * — there they fail on their own, with an error that says so. What stays
 * refused in the box is what the box does not stop: losing the project's own
 * work, publishing it, running a download unseen, root-equivalent sockets
 * (docker), and the power button, which a desktop session's bus reaches.
 */
export function destructiveReason(
  cmd: string,
  sandboxed = false,
  /** The project's real path: a delete spelled absolute inside it is still
   *  inside it. */
  root = "",
): string | null {
  const text = String(cmd ?? "");
  // Lower-cased and with separators normalised to spaces, so `;rm`, `&&rm`,
  // `|rm`, `$(rm` and a newline all present the word the same way.
  const flat = ` ${text.toLowerCase().replace(/[;&|()<>{}`\n\r\t]+/g, " ")} `;
  const has = (word: string) => flat.includes(` ${word} `);
  const hasAny = (...words: string[]) => words.some(has);

  // A script passed as a string is still a script: `bash -c 'rm -rf .'` and
  // `eval "git push"` are read as the commands they are.
  const inner =
    /\b(?:(?:ba|z|da|k)?sh\s+(?:-[a-z]+\s+)*-[a-z]*c|eval)\s+(['"])([\s\S]*?)\1/g;
  for (const m of text.matchAll(inner)) {
    const why = destructiveReason(m[2], sandboxed, root);
    if (why !== null) return why;
  }

  // The machine outside the project. In the sandbox none of these can reach
  // it — no new privileges, a read-only system, a private /dev — so there
  // they are the kernel's to refuse, not a round of the model's.
  if (!sandboxed) {
    if (hasAny("sudo", "doas", "su", "pkexec")) {
      return "it asks for another user's powers (sudo/su)";
    }
  }
  if (
    hasAny("rm", "rmdir", "shred", "unlink", "truncate") &&
    !(sandboxed && deletesInsideOnly(text, root))
  ) {
    // Said so the model can act on it: the refusal names the one shape that
    // is allowed, instead of leaving it to guess that none is.
    return "it deletes or truncates outside this project (rm/shred/truncate)" +
      " — deleting a path inside the project, or under /tmp, is fine";
  }
  // `-exec` runs a command whose words are in this same string, so an
  // `-exec rm` is already an `rm` above — `find … -exec grep -l x {} +` is a
  // search, and refusing it cost as much as refusing grep.
  if (/\s-delete\b/.test(flat)) {
    return "it deletes what it finds (find -delete) — to delete, name the" +
      " paths with rm instead";
  }
  if (
    !sandboxed && hasAny("dd", "mkfs", "fdisk", "parted", "sfdisk", "wipefs")
  ) {
    return "it writes to a disk directly (dd/mkfs/fdisk)";
  }
  // The power button is on the session bus, which the sandbox does not cut
  // off — so this one holds everywhere. In the sandbox a command has its own
  // process namespace: `kill` can only reach what that same command started.
  if (
    hasAny("reboot", "shutdown", "halt", "poweroff") ||
    /\b(systemctl|loginctl)\s+(?:-\S+\s+)*(reboot|poweroff|halt|suspend|hibernate|hybrid-sleep|suspend-then-hibernate|kexec|terminate-\w+|kill-\w+)\b/
      .test(flat) ||
    (!sandboxed && hasAny("kill", "killall", "pkill"))
  ) {
    return "it kills processes or the machine (kill/reboot)";
  }
  if (!sandboxed) {
    // Changing a service or a schedule, not looking at one: `systemctl
    // status`, `crontab -l` and `launchctl list` are how a problem is found.
    if (
      /\bsystemctl\s+(?:-\S+\s+)*(start|stop|restart|reload|try-restart|reload-or-restart|enable|disable|reenable|mask|unmask|kill|edit|set-property|daemon-reload|isolate|link|revert|preset)\b/
        .test(flat) ||
      (has("crontab") && !/\scrontab\s+-l\b/.test(flat)) ||
      /\blaunchctl\s+(load|unload|bootstrap|bootout|enable|disable|kickstart|remove|submit)\b/
        .test(flat)
    ) {
      return "it changes system services or scheduled jobs (systemctl/crontab)";
    }
    // Installing or removing, not listing: `npm ls -g`, `apt list
    // --installed` and `pip list --user` change nothing.
    const pkgVerb =
      /(?:^|\s)(install|in|i|add|remove|rm|uninstall|un|purge|upgrade|update|up|dist-upgrade|full-upgrade|autoremove|link|unlink|-s\w*|-r\w*|-u\w*)(?=\s|$)/;
    const after = (tool: string) => {
      const at = flat.search(new RegExp(`\\s${tool}\\s`));
      return at < 0 ? "" : flat.slice(at + tool.length + 1);
    };
    if (
      ["apt", "apt-get", "dnf", "yum", "pacman", "zypper"].some((t) =>
        has(t) && pkgVerb.test(after(t))
      ) ||
      (["npm", "pnpm", "yarn"].some((t) => has(t) && pkgVerb.test(after(t))) &&
        /\s(-g|--global)\b/.test(flat)) ||
      (has("yarn") && /\syarn\s+global\s+(add|remove|upgrade)\b/.test(flat)) ||
      (has("pip") && /\spip\s+(install|uninstall)\b/.test(flat) &&
        /--user\b|--break-system-packages/.test(flat))
    ) {
      return "it installs software system-wide (apt / npm -g / pip --user)";
    }
    if (hasAny("chown", "chmod", "chgrp") && /\s-r\b/i.test(flat)) {
      return "it rewrites ownership or permissions in bulk (chown/chmod -R)";
    }
  }
  if (/\bgit\b/.test(flat)) {
    if (
      /\bgit\s+reset\b[^\n]*--hard/.test(flat) ||
      /\bgit\s+clean\b[^\n]*\s-[a-z]*[fdx]/.test(flat) ||
      /\bgit\s+checkout\b[^\n]*\s--\s/.test(flat) ||
      /\bgit\s+checkout\b[^\n]*\s\.(\s|$)/.test(flat) ||
      /\bgit\s+restore\b/.test(flat) ||
      /\bgit\s+stash\s+(drop|clear)\b/.test(flat)
    ) {
      return "it throws away uncommitted work (git reset --hard / clean -f)";
    }
    if (/\bgit\s+push\b/.test(flat)) {
      return "it publishes to a remote (git push)";
    }
    // `-d` refuses an unmerged branch, so it loses nothing; `-D` (or `-d`
    // with `--force`) is the one that does. Case matters: read the original.
    if (
      /\bgit\s+branch\b[^\n]*\s(-D\b|-[a-zA-Z]*D[a-zA-Z]*\b)/.test(text) ||
      (/\bgit\s+branch\b[^\n]*\s(-d|--delete)\b/.test(text) &&
        /\s(-f|--force)\b/.test(text))
    ) {
      return "it deletes a branch (git branch -D)";
    }
  }
  // A download piped into an interpreter is somebody else's code running as
  // you, which no amount of reading the command tells you the contents of.
  if (
    /\b(curl|wget)\b/.test(flat) &&
    /\|\s*(sh|bash|zsh|python\d?|node|deno)\b/.test(text.toLowerCase())
  ) {
    return "it pipes a download straight into a shell";
  }
  if (
    /\b(npm|pnpm|yarn|deno|cargo|gh)\b/.test(flat) && /\bpublish\b/.test(flat)
  ) {
    return "it publishes a package (npm/deno publish)";
  }
  // The subcommand, not the word: `docker run --rm image` cleans up after
  // itself and is the most common way to run one.
  if (
    /\b(docker|podman)\s+(?:(?:container|image|volume|network|system|builder|buildx)\s+)?(rm|rmi|prune)\b/
      .test(flat) ||
    /\b(docker|podman)[\s-]compose\b[^\n]*\sdown\b[^\n]*\s(-v|--volumes)\b/
      .test(flat)
  ) {
    return "it removes containers, images or volumes (docker rm/prune)";
  }
  if (/:\s*\(\s*\)\s*\{/.test(text)) return "it looks like a fork bomb";
  return null;
}

/* ── leaving the sandbox without asking ──────────────────────────────────── */

/** One simple command's program, its first argument (`git status`), and
 *  its words. */
export type CommandHead = { prog: string; sub: string; words: string[] };

/**
 * The programs a shell command runs, one per simple command — or `null` when
 * the command holds something whose effect cannot be read off its words:
 * command substitution, process substitution, a here-document, a write
 * redirect to anything but /dev/null, or a script handed to a shell or eval.
 */
export function commandHeads(cmd: string): CommandHead[] | null {
  const text = String(cmd ?? "");
  if (/\$\(|`|<\(|>\(|<</.test(text)) return null;
  // Writes: every `>` must be `2>&1`, `>&2`, or aimed at /dev/null.
  const bare = text.replace(/\d?>&\d/g, "").replace(
    /\d?>>?\s*\/dev\/null/g,
    "",
  );
  if (/>/.test(bare)) return null;
  const heads: CommandHead[] = [];
  for (const seg of bare.split(/&&|\|\||[;|\n&]/)) {
    const words = seg.trim().split(/\s+/).filter(Boolean);
    unwrap(words);
    if (words.length === 0) continue;
    const prog = words[0].replace(/^.*\//, "");
    if (
      /^(ba|z|da|k)?sh$|^eval$|^exec$|^xargs$|^env$|^sudo$|^doas$/.test(prog)
    ) {
      return null;
    }
    heads.push({
      prog,
      sub: words.find((w, i) => i > 0 && !w.startsWith("-")) ?? "",
      words,
    });
  }
  return heads;
}

/**
 * Take off what only changes HOW a program runs, in place: variable
 * assignments, `timeout [opts] N`, `nice [-n N]`, `nohup`, `time`. What is
 * left starts with the program itself — `timeout 90 deno task dev` is
 * `deno task dev`, which is what the rules below are about.
 */
function unwrap(words: string[]): void {
  for (let moved = true; moved && words.length;) {
    moved = false;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) {
      words.shift();
      moved = true;
    } else if (/^(nohup|time|command)$/.test(words[0])) {
      words.shift();
      moved = true;
    } else if (words[0] === "timeout" || words[0] === "nice") {
      const tool = words.shift();
      while (words.length && words[0].startsWith("-")) {
        const flag = words.shift()!;
        // `-k 5`, `-s KILL`, `-n 10`: the flag's value is its own word.
        if (/^-(k|s|n)$/.test(flag)) words.shift();
      }
      if (tool === "timeout" && /^\d+(\.\d+)?[smhd]?$/.test(words[0] ?? "")) {
        words.shift();
      }
      moved = true;
    }
  }
}

/** Programs that only look — at processes, files, the app manager. Outside
 *  the sandbox is the only place a program started outside it can be seen
 *  from (the box has its own process and runtime namespaces), and looking at
 *  it costs nothing. */
const LOOKS: ReadonlySet<string> = new Set([
  "cd",
  "true",
  "echo",
  "printf",
  "sleep",
  "date",
  "pwd",
  "test",
  "[",
  "ps",
  "pgrep",
  "pidof",
  "jobs",
  "ss",
  "lsof",
  "free",
  "uptime",
  "uname",
  "id",
  "whoami",
  "which",
  "cat",
  "head",
  "tail",
  "grep",
  "wc",
  "ls",
  "stat",
  "file",
  "readlink",
  "du",
  "df",
  "journalctl",
  "find",
]);
/** Subcommands that, by the conventions of command-line tools, only report:
 *  `git status`, `docker logs`, `kubectl describe`, `pm2 list`, an app
 *  manager's `status` or `logs`. Not `get` (`go get` installs), not `version`
 *  (`npm version` bumps one). */
const LOOK_VERBS: ReadonlySet<string> = new Set([
  "status",
  "logs",
  "log",
  "ps",
  "list",
  "ls",
  "help",
  "info",
  "inspect",
  "show",
  "describe",
  "top",
  "errors",
  "instances",
  "doctor",
  "state",
]);
/** Programs whose first word names code to run — a script, a task, a
 *  package — so no subcommand of theirs is known to only look. */
const RUNS_WHAT_IT_NAMES =
  /^(python\d*(\.\d+)?|node|deno|bun|bunx|ruby|perl|php|java|npx|pnpx|npm|pnpm|yarn|make|just|task|rake|gradle|gradlew|mvn|ant|invoke|cargo|go|dotnet|uv|poetry|pipenv|tsx|ts-node)$/;

/** Does this simple command only report, whatever the program? */
function reportsOnly(h: CommandHead, words: string[]): boolean {
  if (RUNS_WHAT_IT_NAMES.test(h.prog)) return false;
  const args = words.slice(1);
  if (
    args.length > 0 && args.every((w) => /^(--help|-h|--version|-V)$/.test(w))
  ) {
    return true;
  }
  return LOOK_VERBS.has(h.sub);
}
/** Places a look must not reach even outside: what the sandbox hides —
 *  `.claude*` included, which holds every conversation's transcript. */
const SECRET_PLACES =
  /\.ssh\b|\.gnupg|\.aws\b|\.azure|\.kube|\.docker\b|\.password-store|\.netrc|\.git-credentials|\.npmrc|\.pypirc|keyrings|\.claude|\.config\/(gcloud|gh|op)\b|_history\b|\.Xauthority/;

/** `find` flags that run, delete or write something rather than print. */
const FIND_ACTS = /\s-(exec|execdir|ok|okdir|delete|fprint0?|fprintf|fls)\b/;

/** Where the shell expands a look's words, for the checks below. */
export type LookEnv = {
  home?: string;
  vars?: Record<string, string>;
  /** Directories that are this conversation's own even where they sit in a
   *  hidden place: its job logs live under the app's data directory, and a
   *  live session was asked for approval to `cat` the log path it had just
   *  been handed. */
  own?: readonly string[];
  /** Directories no look may reach apart from `own`: where every other
   *  conversation's scratch is. */
  hidden?: readonly string[];
};

/**
 * May this outside-the-sandbox request run without asking?
 *
 * Yes when every program in it only looks (and nothing it names is a place
 * the sandbox hides), or is one the user allowed outside for this chat — and,
 * either way, nothing in it is destructive. A live session needed seven
 * approvals to start one app and see that it was running: `am start`, then
 * `am stop`, `am instances`, `ps aux`, `cat` of the app's log — each one a
 * look, or the same program the user had already said yes to.
 *
 * A look is judged on what the shell will hand the program: quotes and
 * backslashes taken out (`.s''sh` is `.ssh`), `~` and the few variables whose
 * value is known here put in. Any other variable can point anywhere, so a look
 * that uses one is asked about. A recursive look over the home directory or
 * above it reaches every place the sandbox hides, and is asked about too.
 */
export function mayLeaveUnasked(
  cmd: string,
  allowed: readonly string[] = [],
  env: LookEnv = {},
): boolean {
  const heads = commandHeads(cmd);
  if (heads === null || heads.length === 0) return false;
  if (destructiveReason(cmd) !== null) return false;
  const home = (env.home ?? "").replace(/\/+$/, "");
  const vars: Record<string, string> = { ...(env.vars ?? {}) };
  if (home) vars.HOME = home;
  let unknownVar = false;
  const seen = String(cmd)
    .replace(/['"\\]/g, "")
    .replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g, (_m, name: string) => {
      if (name in vars) return vars[name];
      unknownVar = true;
      return "";
    })
    .replace(/(^|[\s=:])~(?=\/|\s|$)/g, (_m, pre: string) => {
      if (!home) unknownVar = true;
      return pre + home;
    });
  const mine = (env.own ?? []).filter((d) => d.length > 1).reduce(
    (t, d) => t.split(d.replace(/\/+$/, "") + "/").join("/OWN/"),
    seen,
  );
  const lookable = !unknownVar && !/\$/.test(seen) &&
    !SECRET_PLACES.test(mine) && !/\.\.\//.test(mine) &&
    !(env.hidden ?? []).some((d) => d.length > 1 && mine.includes(d));
  const broad = sweepsHome(seen, home);
  const looks = (h: CommandHead) =>
    lookable && !broad &&
    ((LOOKS.has(h.prog) && !(h.prog === "find" && FIND_ACTS.test(seen))) ||
      reportsOnly(h, h.words));
  return heads.every((h) => looks(h) || allowed.includes(h.prog));
}

/** Does a recursive look (`find`, `grep -r`, `du`, `ls -R`) start at the home
 *  directory or above it — where every hidden place is in reach? */
function sweepsHome(text: string, home: string): boolean {
  const tops = new Set(["/", "/home", "/root", "/Users"]);
  if (home) tops.add(home);
  for (const seg of text.split(/&&|\|\||[;|\n&]/)) {
    const words = seg.trim().split(/\s+/).filter(Boolean);
    unwrap(words);
    const prog = (words[0] ?? "").replace(/^.*\//, "");
    const recursive = prog === "find" || prog === "du" ||
      ((prog === "grep" || prog === "ls") &&
        words.some((w) =>
          /^-[A-Za-z]*[rR]|^--(recursive|dereference-recursive)$/.test(w)
        )) ||
      prog === "rg";
    if (!recursive) continue;
    const places = words.slice(1).filter((w) => w.startsWith("/"));
    if (places.some((w) => tops.has(w.replace(/\/+$/, "") || "/"))) return true;
  }
  return false;
}

/**
 * Advice given instead of running a command whose shape wastes the turn, in
 * any permission mode — `null` for everything else. Each shape cost a live
 * session minutes:
 *  - a program that never exits, run in the foreground (`deno task dev`,
 *    `npm run dev`, `am dev`): it only waits for its timeout — 90 s and 120 s
 *    in one session — while `background: true` returns its first output in
 *    seconds and keeps the log;
 *  - in the sandbox only, a program left running with `&`, `nohup` or
 *    `setsid` in a command that is not a background job: the sandbox ends
 *    with the command. Anywhere else what a command leaves running is kept
 *    as a job, so `cmd > log 2>&1 &` is an honest way to start something;
 *  - a recursive search from `/` or the home directory without a depth: 37 s,
 *    69 s and 120 s in one session, and a sweep through other people's files.
 */
export function commandAdvice(
  cmd: string,
  background: boolean,
  /** The command runs in the sandbox, which ends with it. */
  boxed = true,
): string | null {
  // Only the shell's own words: a here-document's body and quoted strings are
  // data — a URL's `?a=1&b=2`, a README that says `npm run dev`.
  const text = String(cmd ?? "")
    .replace(/<<-?\s*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?\n\s*\2(?=\s|$)/g, " ")
    .replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, "''");
  const segs = text.split(/&&|\|\||[;|\n]/);
  if (!background) {
    // Outside the sandbox, whatever stands before a lone `&` is left running
    // on purpose and kept as a job: only the part in the foreground can wait.
    const fore = boxed
      ? segs
      : segs.map((seg) =>
        seg.replace(/\d?>&\d?|&>>?|\|&/g, " ").split("&").at(-1) ?? ""
      );
    for (const seg of fore) {
      const words = seg.replace(/&\s*$/, "").trim().split(/\s+/).filter(
        Boolean,
      );
      unwrap(words);
      const named = foreverName(words);
      if (named) {
        return `\`${named}\` keeps running until it is stopped, so run in the` +
          ` foreground it only waits for its timeout and is killed. Run it` +
          ` with background: true instead — its first output comes back in` +
          ` seconds, its log stays readable, and "stop-job <id>" ends it.` +
          (boxed
            ? ` To show an app to the user, add outside_sandbox: true.`
            : "");
      }
    }
    if (!boxed) return wideSearch(segs);
    // `&` that is not `&&`, `>&`, `&>` or `|&`: a program left behind.
    const bare = text.replace(/&&|\d?>&\d?|&>>?|\|&/g, " ");
    if (
      (/&/.test(bare) || /(^|[\s;&|(])(nohup|setsid|disown)\b/.test(text)) &&
      !/(^|[\s;&|])wait\b/.test(text)
    ) {
      return "a program left running with &, nohup or setsid is killed when" +
        " this command returns — the sandbox ends with the command. Run" +
        " it with background: true instead (and outside_sandbox: true to show" +
        " an app to the user); its log stays readable and stop-job ends it.";
    }
  }
  return wideSearch(segs);
}

/** A recursive search from `/` or the home directory without a depth. */
function wideSearch(segs: string[]): string | null {
  for (const seg of segs) {
    const words = seg.trim().split(/\s+/).filter(Boolean);
    unwrap(words);
    const prog = (words[0] ?? "").replace(/^.*\//, "");
    const from = words.slice(1).filter((w) => !w.startsWith("-"));
    const wide = (w: string) =>
      /^(\/|~\/?|\$HOME\/?|\$\{HOME\}\/?|\/home\/?)$/.test(w);
    const deep = prog === "find" && wide(from[0] ?? "") &&
      !words.some((w) => /^-maxdepth$/.test(w));
    const greps = (prog === "grep" || prog === "rg") &&
      (prog === "rg" || words.some((w) => /^-[A-Za-z]*[rR]/.test(w))) &&
      from.some(wide);
    if (deep || greps) {
      return "that searches the whole disk or home directory, which takes" +
        " minutes and is killed at the timeout. Search where the thing can" +
        " be — the project, a folder a tool or its error named, or add" +
        " -maxdepth 3 — or ask the tool itself where it keeps it.";
    }
  }
  return null;
}

/**
 * What a command's output says went wrong, as one comparable line — or `null`
 * when it passed. The first error line, with its positions taken out so the
 * same error after an edit that moved it is still the same error; failing
 * that, a non-zero exit.
 *
 * `deno check … | head; echo "EXIT: $?"` exits 0 whatever it found, which is
 * how a live session ran its type-check eleven times — so the words decide,
 * not the shell's own exit.
 */
export function failureMark(output: string): string | null {
  const lines = String(output ?? "").split("\n");
  const hit = lines.find((l) =>
    (/\berror\b|\[ERROR\]|\bTS\d{4}\b|✖|\bFAILED\b|panicked at/.test(l) ||
      /^error/i.test(l.trim())) &&
    !/\b0 errors?\b|\bno errors?\b|errors?: 0\b/i.test(l)
  );
  if (hit !== undefined) {
    return hit.replace(/:\d+(:\d+)?/g, "").replace(/\s+/g, " ").trim()
      .slice(0, 160);
  }
  const code = /\[exit ([1-9]\d*)\]|\bEXIT: ([1-9]\d*)/.exec(output)?.slice(1)
    .find(Boolean);
  return code ? `exit ${code}` : null;
}

/** A test file, by the conventions of every common ecosystem: a `test`,
 *  `tests`, `spec` or `__tests__` folder, or a `.test.` / `.spec.` / `_test.`
 *  / `test_` name. */
export function isTestPath(path: string): boolean {
  const p = String(path ?? "").replace(/\\/g, "/");
  const name = p.slice(p.lastIndexOf("/") + 1);
  return /(^|\/)(tests?|specs?|__tests__)\//i.test(p) ||
    /[._-](test|spec)s?\.[a-z0-9]+$/i.test(name) ||
    /^test_.+\.[a-z0-9]+$/i.test(name);
}

/** Does this shell command run a test suite? `deno test`, `npm test`,
 *  `cargo test`, `go test ./...`, `deno task test`, `pytest`, `vitest`… — not
 *  the shell's own `test -f x`, and not a folder that happens to be named
 *  `test16`. */
export function runsTests(cmd: string): boolean {
  for (const seg of String(cmd ?? "").split(/&&|\|\||[;|\n&]/)) {
    const words = seg.trim().split(/\s+/).filter(Boolean);
    unwrap(words);
    const prog = (words[0] ?? "").replace(/^.*\//, "");
    // The runner itself, or through a launcher (`npx vitest`, `uv run pytest`).
    if (
      words.some((w) =>
        /^(pytest|py\.test|jest|vitest|mocha|ava|rspec|phpunit|ctest|tox|nox)$/
          .test(w.replace(/^.*\//, ""))
      )
    ) {
      return true;
    }
    if (prog === "test" || prog === "[") continue;
    if (words.slice(1).some((w) => /^(test|tests|test:[\w:-]+)$/.test(w))) {
      return true;
    }
    if (/^python3?$/.test(prog) && words.includes("unittest")) return true;
  }
  return false;
}

/** The name of a program that never exits on its own, or `""`. */
function foreverName(words: string[]): string {
  // Only the program loses its path: `find /home/dev` is not `find dev`.
  const [a = "", b = "", c = ""] = words.map((w, i) =>
    i === 0 ? w.replace(/^.*\//, "") : w
  );
  const serve = /^(dev|start|serve|watch|preview)$/;
  if (a === "deno" && b === "task" && serve.test(c)) return `deno task ${c}`;
  // Any tool's server verb: `vite dev`, `astro dev`, `wrangler dev`, `hugo
  // server`, `manage.py runserver`, an app manager's `dev`.
  if (
    /^(dev|serve|server|runserver|watch)$/.test(b) &&
    !/^(git|npm|pnpm|yarn|bun)$/.test(a)
  ) {
    return `${a} ${b}`;
  }
  if (words.includes("--watch")) return `${a} … --watch`;
  if (/^(uvicorn|gunicorn|hypercorn|daphne)$/.test(a)) return a;
  if (words.slice(1, 3).includes("runserver")) return `${a} … runserver`;
  if (a === "flask" && b === "run") return "flask run";
  if (/^(npm|pnpm|yarn|bun)$/.test(a)) {
    if (b === "run" && serve.test(c)) return `${a} run ${c}`;
    if (serve.test(b) && !(a === "npm" && b === "watch")) return `${a} ${b}`;
  }
  if (
    /^(npx|bunx|pnpx)$/.test(a) &&
    /^(vite|nodemon|live-server|http-server)$/.test(b)
  ) {
    return `${a} ${b}`;
  }
  if (
    /^(vite|nodemon|live-server|http-server|electron)$/.test(a) &&
    !/^(build|--version|-v|--help)$/.test(b)
  ) return a;
  if (/^python3?$/.test(a) && b === "-m" && c === "http.server") {
    return "python -m http.server";
  }
  return "";
}

/** The programs "allow this outside for this chat" remembers for a command:
 *  the ones that are not already free to look. `[]` when the command cannot
 *  be read, so nothing is remembered on its behalf. */
export function programsToAllow(cmd: string): string[] {
  const heads = commandHeads(cmd) ?? [];
  return [...new Set(heads.map((h) => h.prog).filter((p) => !LOOKS.has(p)))];
}

/**
 * Does every delete in this command stay inside the sandbox's own world — the
 * project it is working in, or the conversation's `/tmp`?
 *
 * In the sandbox those two are the only writable places there are, so the
 * kernel already refuses everything else; this decides what the *word list*
 * still refuses on top. It used to be `/tmp` alone, and the cost of that was
 * measured on a live session: an agent that had written `_probe.test.ts` to
 * try something out could not delete it again, re-scaffolding a directory was
 * impossible, and "rm is refused" arrived with no hint that anything was
 * allowed. An agent that cannot tidy up leaves its litter in the answer.
 *
 * Still no, because these are the shapes that cost work rather than clean it:
 *  - a delete that is not the start of a simple command (`xargs rm`,
 *    `find … -delete`) — the operands are not visible here,
 *  - `..`, `~` or `$…` in an operand — a path this cannot judge,
 *  - an absolute path that is not under the project or `/tmp/`,
 *  - an operand that is only dots and stars (`.`, `*`, `./*`) — the working
 *    tree itself, which is not housekeeping.
 */
function deletesInsideOnly(text: string, root = ""): boolean {
  const DEL = new Set(["rm", "rmdir", "unlink", "shred", "truncate"]);
  const home = root.replace(/\/+$/, "");
  /** One operand of a delete: a path this command may be trusted with. */
  const ok = (w: string): boolean => {
    const p = w.replace(/^(['"])(.*)\1$/, "$2");
    if (p.includes("..") || p.includes("~") || p.includes("$")) return false;
    // The whole tree, spelled any of the ways a shell spells it.
    if (/^[.*/]+$/.test(p)) return false;
    // Relative: inside the sandbox this cannot leave the project.
    if (!p.startsWith("/")) return true;
    // Absolute, and below the project: the same file a relative path names.
    // A live session could not delete its own `src/_tcheck.ts` spelled whole,
    // told in the same breath that deleting inside the project is fine.
    if (home.length > 1 && p.startsWith(home + "/")) {
      const rest = p.slice(home.length + 1);
      return rest !== "" && !/^[.*/]+$/.test(rest);
    }
    return /^\/tmp\/[^\s]+$/.test(p);
  };
  let any = false;
  for (const seg of text.split(/[;&|()`\n]+|\$\(/)) {
    const words = seg.trim().split(/\s+/).filter(Boolean);
    if (words.slice(1).some((w) => DEL.has(w))) return false;
    if (!DEL.has(words[0] ?? "")) continue;
    any = true;
    const operands = words.slice(1).filter((w) => !w.startsWith("-"));
    if (operands.length === 0 || !operands.every(ok)) return false;
  }
  return any;
}

/* ── token arithmetic ─────────────────────────────────────────────────────── */

/** Estimated tokens for a string. Chars/4 is the standard rough cut for
 *  English-and-code; +4 covers per-message wrapping. The packer multiplies it
 *  by the ratio the server's own counts taught it — see {@link calibrate} —
 *  so a tokenizer that spends more per character is learned, not guessed. */
export const estTokens = (text: string): number =>
  Math.ceil(text.length / 4) + 4;

/**
 * Update the tokens-per-estimate ratio from what the server actually counted.
 *
 * Chars/4 is off by 15% for code and by 2× for Czech or Chinese, and the
 * packer budgets with it — so every request that reports `prompt_tokens`
 * teaches the next one. Floored at 0.75 because a server that reports only
 * the *uncached* part of a prompt would otherwise teach the packer that a
 * window holds far more than it does; overflowing is the failure that costs.
 */
export function calibrate(
  prev: number | undefined,
  reported: number | null,
  estimated: number,
): number | undefined {
  if (reported === null || reported <= 0 || estimated < 300) return prev;
  const r = reported / estimated;
  const next = prev === undefined ? r : prev * 0.5 + r * 0.5;
  return Math.min(3, Math.max(0.75, next));
}

/** Output headroom reserved out of the window: about a seventh, clamped so a
 *  4k model keeps a real answer's worth and a 1M model does not set aside
 *  more than a long file edit needs. Reasoning models spend it on thinking
 *  first, which is why it is not smaller. */
export const outputReserve = (ctx: number): number =>
  Math.min(Math.max(Math.floor(ctx * 0.15), 1_024), 32_768);

/** `max_tokens` for one request: whatever the window has left after the
 *  prompt, capped. Sent on every request because a server told nothing will
 *  generate until the window is full — and llama.cpp with context shift on
 *  will keep generating past that, forever, if a model starts to loop. */
export const maxOutput = (ctx: number, promptTokens: number): number =>
  Math.max(256, Math.min(ctx - promptTokens - 64, 32_768));

/** How much room the window gives. The prompt, the result sizes and the
 *  compaction pace all key off this one answer. */
export type Tier = "tiny" | "small" | "roomy";
export const tierOf = (ctx: number): Tier =>
  ctx < 16_000 ? "tiny" : ctx < 64_000 ? "small" : "roomy";

/** Characters one tool result may carry: about 8% of the window. An 8k model
 *  gets ~2.6k characters (it cannot afford more and still think), a 128k one
 *  ~40k — a whole file, in one read, instead of six narrow ones. */
export const toolBudget = (ctx: number): number =>
  Math.round(Math.min(Math.max(ctx * 0.08, 600), 25_000) * 4);

/** Ollama models that run on ollama.com rather than this machine: the
 *  conversation leaves the computer, their window is the remote one, and
 *  nothing about them is ever "loaded" here. */
export const isCloudModel = (model: string): boolean =>
  /(:|-)cloud$/i.test(model.trim());

/* ── prompt ───────────────────────────────────────────────────────────────── */

/**
 * The working method, in three sizes. The rules are the universal ones every
 * serious harness converged on — explore before acting, search don't invent,
 * smallest change, verify, recover rather than repeat, self-check — and the
 * sizes exist because on an 8k model every line here is paid on every request.
 */
const METHOD: Record<Tier, string> = {
  tiny: `Work: name the frameworks in the task; any you cannot quote docs` +
    ` for, read its docs BEFORE writing code (see Docs above) → look first` +
    ` (grep, then read ranges; never guess file` +
    ` contents) → smallest change (read before edit) → quick check with sh,` +
    ` then run it (new tests only if asked) →` +
    ` brief answer. Never repeat a failed call unchanged. Run and create with` +
    ` the project's own commands; do what was asked (running it too, if` +
    ` asked) before extras. Stay in the project; nothing destructive unless` +
    ` asked.`,
  small: `How to work: if the user names a command or page to start with,` +
    ` quoted or not ("start with make help"), run or read it first. Then name what the task is built on (the frameworks` +
    ` and tools it mentions, and what this project already uses). For each,` +
    ` ask whether you could write it correctly from memory — a name you` +
    ` cannot quote documentation for is a name you do not know, whatever it` +
    ` resembles. Read its docs before writing any code: the <env> Docs line` +
    ` says where and which page to start on, and a vendored framework keeps` +
    ` them inside the dependency — the entry page, then only the page for the` +
    ` step you are on. Never learn one by experiment while its` +
    ` documentation sits unread; if there is none and you still cannot tell,` +
    ` ask.\n` +
    `Then, straight at the goal: explore (read the code involved; search,` +
    ` never invent an API) → plan (todo for 3+ steps) → the smallest correct` +
    ` change, in the project's style → verify fast and early (type-check or` +
    ` build after the first files; once clean, run it, then existing tests) →` +
    ` if it fails, read the error (it may name the fix) and fix the cause; never repeat a failed` +
    ` call unchanged → finish with what changed and how it was verified. A` +
    ` test broken only because your change replaced what it covered is` +
    ` rewritten or deleted at once. New tests only when asked or clearly` +
    ` expected, few, on plain logic; what needs test machinery you must learn` +
    ` is checked by running it instead.\n` +
    `Rules: use read/grep/glob/edit/write, not sh with cat/grep/sed/echo.` +
    ` Read a file before editing it; old_string is copied exactly, without` +
    ` line numbers. Old tool output may be elided later: note key facts in` +
    ` your replies. If you say you will call a tool, call it. Stay inside the` +
    ` project; nothing destructive unless asked. Use the project's and` +
    ` framework's own commands to create and run things (a release build is` +
    ` not how to run an app); never redo their work by hand. What was asked` +
    ` — including running it, if asked — comes before extras. Ask one precise` +
    ` question if critical information is missing.`,
  roomy: `How to work — straight at the goal: build what was asked, check it` +
    ` fast, run it, report.\n` +
    `1. Know what you are building on, before you build. If the user names a` +
    ` command or page to start with, quoted or not ("start with make help"), run` +
    ` or read that first. Name the frameworks` +
    ` and tools the task mentions and the ones this project uses. Could you` +
    ` write each correctly from memory, or are you guessing from the name? One` +
    ` you cannot quote a doc page for is one you do not know — private` +
    ` frameworks are not in your training data. Read its documentation BEFORE` +
    ` writing any code: the <env> Docs line names where (a vendored framework` +
    ` keeps docs in the dependency, e.g. dep/<name>/docs/, often with an entry` +
    ` page for agents). Read that entry page, then only the page for the step` +
    ` you are on. Never learn a framework by experiment, or from its source,` +
    ` while its docs sit unread. No docs anywhere and still unsure: ask one` +
    ` question.\n` +
    `2. Explore the code: read the relevant code, types and patterns. Never` +
    ` assume an API — search (grep/glob) or read it; never invent one.\n` +
    `3. Plan: for 3+ steps keep a short todo (one step in_progress).\n` +
    `4. Change: the smallest correct change, in the project's conventions. No` +
    ` unrelated refactors.\n` +
    `5. Verify fast and early: after the first files, run the quickest check` +
    ` (type-check or build); once it passes, run the thing and see what it` +
    ` does, then the existing tests. A test that fails only because your` +
    ` change replaced what it covered (a template's example) is rewritten or` +
    ` deleted in one step, not debugged. New tests only when asked or clearly` +
    ` expected: few, on plain logic with plain inputs. What would need test` +
    ` machinery you must first learn (fake clocks, mocks, a harness's source)` +
    ` is checked by running the thing instead. Tool output is the only source` +
    ` of truth; tests serve the task, never become it.\n` +
    `6. Recover: read the whole error — when it names a fix, try that first —` +
    ` make one targeted fix, check again. Never repeat a failed call` +
    ` unchanged; if an approach keeps failing, change it.\n` +
    `7. Finish: re-read the request, confirm it is covered, reply briefly —` +
    ` what changed, how it was verified, any risk.\n` +
    `Rules:\n` +
    `- Files: read/grep/glob/ls/edit/write, not sh with cat, grep, find, sed` +
    ` or echo. sh is for builds, tests, git and programs.\n` +
    `- Read a file before editing; copy old_string exactly from the read,` +
    ` without line numbers, with enough lines to be unique.\n` +
    `- Load only what the step needs: grep, then read the matching range.` +
    ` Independent calls can share a reply.\n` +
    `- Old tool output may be elided: note the facts you will need in your` +
    ` replies. If you say you will call a tool, call it.\n` +
    `- Stay inside the project. Nothing destructive or irreversible (deleting,` +
    ` git reset/push, system installs) unless asked for exactly that. Never` +
    ` borrow files or binaries from outside the project (other projects,` +
    ` backups): set things up the way its docs say, or ask.\n` +
    `- Create and run with the project's and framework's own commands and the` +
    ` options the task needs (the target platform, say); a release build is` +
    ` not how to run an app, and never redo their work by hand.\n` +
    `- Asked to run or show the result? Do it as soon as it can run, before` +
    ` extras.\n` +
    `- Ambiguous and a wrong guess is costly: ask one precise question.`,
};

/** The user can write while the agent works — a correction, a question, a
 *  "stop". Those arrive as user messages in the middle of a task, and a model
 *  not told what they are treats them as a new task or ignores them. */
const STEERING: Record<Tier, string> = {
  tiny: `The user may write while you work: a correction changes the plan, a` +
    ` question gets a short answer before you go on, "stop" means stop and` +
    ` say what was done.`,
  small: `The user may send messages while you work (marked as sent during` +
    ` the task). Read them before continuing: a correction changes what you` +
    ` do next; a question gets a short answer, then carry on; if they say` +
    ` stop or change their mind, stop and say briefly what was done.`,
  roomy: `Messages from the user can arrive while you work; they are marked` +
    ` as sent during the task. Deal with them before your next step: a` +
    ` correction or new detail changes the plan (update todo); a question` +
    ` gets a short, direct answer and then you carry on with the task; if` +
    ` they tell you to stop or that they changed their mind, stop at once` +
    ` and summarize what was done and what was left.`,
};

/**
 * The sandbox's rules, told before the first command instead of learned by
 * trial and error — one session spent forty rounds finding out that `/tmp`
 * was wiped and background processes died, and the rules are fixed and known.
 */
function sandboxRules(net: boolean, tier: Tier): string {
  const lines = [
    `Commands run in a sandbox: writable are the project, /tmp (kept for this` +
    ` conversation) and download caches; your home directory is read-only.`,
    net
      ? `The network is available.`
      : `There is no network (downloads and installs fail).`,
    `There is no display: no window can open here, whatever you try.`,
    `Reading works everywhere here — outside_sandbox is never needed just` +
    ` to read or inspect a file.`,
    `For anything the sandbox blocks (a download, a GUI app, writing outside` +
    ` the project), call sh with outside_sandbox: true — the user is asked` +
    ` to approve that one command. To run an app for the user to see, use` +
    ` outside_sandbox: true with background: true right away; do not try to` +
    ` find or start a display yourself.`,
    `What runs outside is invisible from inside: check on it (ps, logs, its` +
    ` status) with outside_sandbox: true too — a command that only looks` +
    ` runs there without asking.`,
  ];
  if (tier !== "tiny") {
    lines.push(
      `A program that must keep running (a server, an app) needs background:` +
        ` true; its output goes to /tmp/job-<id>.log.`,
    );
  }
  return lines.join(" ");
}

/**
 * The agent account's rules — facts, not a box. The account is an ordinary
 * user of the machine, so the one thing worth saying is that it is one: tools
 * install into its home, apps keep their data where they always do, and what
 * starts keeps running. The walls at its edge are the machine owner's, and
 * this app does not claim to know which ones they put up.
 */
function accountRules(
  a: { user: string; home: string; display: string | null },
): string {
  return [
    `Commands run as the Linux user ${a.user} (home ${a.home}) — an account` +
    ` of your own, not a sandbox: install what you need into that home` +
    ` (there is no sudo), and programs keep their files where they normally do.`,
    `A program a command starts keeps running after the command returns and` +
    ` is listed as a job ("jobs", "stop-job <id>"); background: true gives` +
    ` you its first output right away. When the user asked to see it running,` +
    ` leave it running when you finish — a guide's closing "stop" step is for` +
    ` runs nobody asked to see; clearing the conversation stops it.`,
    a.display
      ? `Windows open on the user's screen: DISPLAY=${a.display} is already` +
        ` set, so start GUI apps the normal way. It is the only screen the` +
        ` user watches: a tool that reports a window went to any other display` +
        ` (a nested or virtual one) has hidden it — tell that tool to use the` +
        ` current DISPLAY.`
      : `There is no display: a GUI app cannot open a window here.`,
    `Outside this account some things are closed on purpose (other users'` +
    ` files, some local ports): take another route, do not work around it.`,
  ].join(" ");
}

/** Read-only mode's own short method: it can only look, so the whole job is
 *  looking well and answering precisely. */
const READ_METHOD: Record<Tier, string> = {
  tiny: `You can read and search but not change anything. Look first (grep,` +
    ` then read ranges); never guess. Answer with file:line references.`,
  small:
    `You are read-only: you can list, find, read and search, never change` +
    ` anything. Explore before answering (glob/grep, then read the matching` +
    ` range); never invent an API or a file's content. Answer precisely, with` +
    ` file:line references. Note key facts in replies — old tool output may` +
    ` be elided. If you say you will call a tool, call it.`,
  roomy:
    `You are read-only: you can list, find, read and search, never change` +
    ` anything.\n` +
    `How to work: explore before answering — search broadly (glob, grep),` +
    ` then read only the ranges that matter; follow the code, types and tests` +
    ` rather than assuming. Never invent an API, a behaviour or a file's` +
    ` content: if you have not read it, say so or go and read it. Calls that` +
    ` do not depend on each other can go in one reply. Note the facts you` +
    ` will need in your replies — old tool output may be elided later. If you` +
    ` say you will call a tool, call it. Before answering, re-read the` +
    ` question and check the answer covers it. Answer precisely, with` +
    ` file:line references, and say what you could not verify.`,
};

/**
 * The whole system prompt: who, how to work, where, and what came before.
 *
 * Built once per conversation and changed only when the summary does — the
 * environment is gathered once, the task list and loop notes ride on the
 * *newest* message instead (see {@link packContext}) — so every request of a
 * turn shares one byte-identical prefix, and a local server reuses its cache
 * of it instead of re-reading 50k tokens each round.
 */
export function systemPrompt(
  mode: LocalMode,
  ctx: number,
  env: PromptEnv,
  summary = "",
  textTools = false,
): string {
  const tier = tierOf(ctx);
  const parts: string[] = [];
  if (mode === "chat") {
    parts.push(
      `You are a helpful coding assistant. The user's project is at` +
        ` ${env.cwd}, but in this mode you have no tools: answer from the` +
        ` conversation and what you know, and say plainly when you are not` +
        ` sure rather than guessing. Be direct and brief.`,
    );
  } else {
    parts.push(
      `You are a careful coding agent working in the project at ${env.cwd}.` +
        ` You act through tools; paths are relative to the project root.` +
        ` Be direct and brief; never restate tool output the user already saw.`,
    );
    parts.push(mode === "read" ? READ_METHOD[tier] : METHOD[tier]);
    parts.push(STEERING[tier]);
    if (mode === "agent" && env.account) {
      parts.push(accountRules(env.account));
    } else if (mode === "agent" && env.sandbox) {
      parts.push(sandboxRules(env.sandbox.net, tier));
    }
    if (textTools) parts.push(textToolManual(mode, ctx));
  }
  const facts = [
    env.date ? `Date: ${env.date}` : "",
    env.platform ? `OS: ${env.platform}` : "",
    env.git ? `Git: ${env.git}` : "",
  ].filter(Boolean).join(" · ");
  const lines = [
    facts,
    env.tree ? `Project top level: ${env.tree}` : "",
    env.toolchain && mode !== "chat"
      ? `Build and test with: ${env.toolchain}`
      : "",
    env.docs && mode !== "chat"
      ? `Docs: ${env.docs} — read the relevant ones before using a framework` +
        ` or tool`
      : "",
  ].filter(Boolean);
  if (lines.length) parts.push(`<env>\n${lines.join("\n")}\n</env>`);
  if (env.instructions?.text) {
    parts.push(
      `<project-instructions from="${env.instructions.path}">\n` +
        `${env.instructions.text}\n</project-instructions>\n` +
        `Follow the project instructions above; the user's requests win where` +
        ` they conflict.`,
    );
  }
  if (summary) {
    parts.push(
      `<summary>\nEarlier conversation, summarized (the original messages` +
        ` are no longer visible${
          mode === "chat" ? "" : "; history searches them word for word"
        }):\n${summary}\n</summary>`,
    );
  }
  return parts.join("\n\n");
}

/* ── tools ────────────────────────────────────────────────────────────────── */

type ToolSpec = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

const P = (
  props: Record<string, unknown>,
  required: string[],
) => ({ type: "object", properties: props, required });

/** The tool set. Terse on purpose — schemas ride along on every request.
 *  `read`/`grep`/`glob` before the writers: weaker models copy the order they
 *  see, and every writer does less damage when the reading has already
 *  happened. `edit` is the small-change tool and `write` the whole-file one.
 *  `todo` is the agent's plan: one call replaces it, and it is re-sent with
 *  every request so it survives compaction. */
const ALL_TOOLS: ToolSpec[] = [
  {
    type: "function",
    function: {
      name: "ls",
      description: "List a directory (default: the project root).",
      parameters: P({ path: { type: "string" } }, []),
    },
  },
  {
    type: "function",
    function: {
      name: "glob",
      description:
        "Find files by name pattern, e.g. src/**/*.ts. Returns matching paths.",
      parameters: P({
        pattern: { type: "string" },
        path: { type: "string", description: "directory to search from" },
      }, ["pattern"]),
    },
  },
  {
    type: "function",
    function: {
      name: "read",
      description: "Read a text file; lines come back numbered. For large" +
        " files pass offset (first line, 1-based) and limit (line count).",
      parameters: P({
        path: { type: "string" },
        offset: { type: "number" },
        limit: { type: "number" },
      }, ["path"]),
    },
  },
  {
    type: "function",
    function: {
      name: "grep",
      description: "Search file contents with a regular expression; returns" +
        " path:line: text for each hit.",
      parameters: P({
        pattern: { type: "string" },
        path: { type: "string", description: "file or directory to search" },
        include: { type: "string", description: "file name filter, e.g. *.ts" },
      }, ["pattern"]),
    },
  },
  {
    type: "function",
    function: {
      name: "history",
      description: "Search this project's earlier conversations and the parts" +
        " of this one no longer in view — for past work the user mentions, or" +
        " a detail lost to the summary. No query lists the conversations; id" +
        " reads one message whole.",
      parameters: P({
        query: { type: "string", description: 'words, or "a phrase"' },
        conversation: {
          type: "string",
          description: 'only this one: "this", or a tag from the results',
        },
        id: { type: "string", description: "a message id from the results" },
      }, []),
    },
  },
  {
    type: "function",
    function: {
      name: "edit",
      description: "Replace text in a file you have read. old_string must" +
        " match the file (copied from read, without line numbers) and be" +
        " unique unless replace_all is true.",
      parameters: P({
        path: { type: "string" },
        old_string: { type: "string" },
        new_string: { type: "string" },
        replace_all: { type: "boolean" },
      }, ["path", "old_string", "new_string"]),
    },
  },
  {
    type: "function",
    function: {
      name: "write",
      description: "Create a file, or overwrite one you have read. Prefer" +
        " edit for changing an existing file.",
      parameters: P({
        path: { type: "string" },
        content: { type: "string" },
      }, ["path", "content"]),
    },
  },
  {
    type: "function",
    function: {
      name: "todo",
      description: "Replace your task list (use it for work with 3+ steps)." +
        " Exactly one item in_progress; mark an item completed only once it" +
        " is done and verified.",
      parameters: P({
        items: {
          type: "array",
          items: {
            type: "object",
            properties: {
              content: { type: "string" },
              status: {
                type: "string",
                enum: ["pending", "in_progress", "completed"],
              },
            },
            required: ["content", "status"],
          },
        },
      }, ["items"]),
    },
  },
  {
    type: "function",
    function: {
      name: "sh",
      description: "Run a bash command; it already starts in the project" +
        " root (no cd needed — pass dir to run one level down instead)." +
        " Returns output and exit code. For builds," +
        " tests, git and other programs — not for reading, searching or" +
        " editing files. For a server or app that must keep running, set" +
        " background: true: its first output comes back at once; then read" +
        ' its log and stop it with the command "stop-job <id>".',
      parameters: P({
        cmd: { type: "string" },
        dir: {
          type: "string",
          description:
            "run in this folder of the project instead of its root, e.g. an" +
            " app you just scaffolded",
        },
        timeout: {
          type: "number",
          description: "seconds, default 120, max 600",
        },
        background: { type: "boolean" },
        outside_sandbox: {
          type: "boolean",
          description: "run outside the sandbox — the user is asked first",
        },
      }, ["cmd"]),
    },
  },
];

/** Every tool that exists, in one place — so a refusal can name the real ones
 *  instead of only saying no. A model that invented `list_files` corrects
 *  itself from this list; without it, it invents another one. */
export const TOOL_NAMES: string[] = ALL_TOOLS.map((t) => t.function.name);

/** Tools that change nothing — safe to run side by side, and safe in
 *  read-only mode. `todo` is here because it touches no file: it is the
 *  agent's plan, and planning is as useful to a reader as to a writer. */
const READ_TOOLS = ["ls", "glob", "read", "grep", "history", "todo"];

/** Tool names a mode may execute. The single source of truth — the executor
 *  gates on this same list, so the schema sent and the act allowed can never
 *  disagree. */
export const allowedTools = (mode: LocalMode): string[] =>
  mode === "agent"
    ? ["ls", "glob", "read", "grep", "history", "edit", "write", "todo", "sh"]
    : mode === "read"
    ? READ_TOOLS
    : [];

/**
 * The schemas that go on the wire.
 *
 * Sized to the window, because they are not free: the nine schemas are about
 * 920 tokens of JSON, which is 9% of a 10k window spent before the user's first
 * word — more than the whole working method costs. On the smallest windows two
 * of them earn less than they cost: `history` (searching past conversations is
 * a luxury when the present one barely fits) and `todo` (a plan nobody has room
 * to carry). Pass the window to have them dropped there.
 */
export const toolSpecs = (mode: LocalMode, ctx?: number): ToolSpec[] => {
  const lean = ctx !== undefined && tierOf(ctx) === "tiny";
  return ALL_TOOLS.filter((t) =>
    allowedTools(mode).includes(t.function.name) &&
    !(lean && LUXURY_TOOLS.includes(t.function.name))
  );
};

/** Worth their schema on a big window, not on a tiny one. */
const LUXURY_TOOLS = ["history", "todo"];

/** Whether a round of calls can run side by side: only when none of them
 *  changes anything. Two edits of one file run together would each read the
 *  same original and the second write would silently undo the first. */
export const parallelSafe = (names: string[]): boolean =>
  names.length > 1 &&
  names.every((n) => READ_TOOLS.includes(n) && n !== "todo");

/**
 * The tools, described in words, for a model whose server cannot pass them
 * natively — llama.cpp without Jinja templating, a model LM Studio or Ollama
 * says was not trained for tool use. The model is taught the `<tool_call>`
 * format Hermes and Qwen already know, and `recoverToolCalls` reads it back.
 * Slower and less sure than native calls, and far better than a chat box.
 */
export function textToolManual(mode: LocalMode, ctx?: number): string {
  const lines = toolSpecs(mode, ctx).map(({ function: f }) => {
    const props = (f.parameters.properties ?? {}) as Record<string, unknown>;
    const req = (f.parameters.required ?? []) as string[];
    const params = Object.keys(props).map((k) => req.includes(k) ? k : `${k}?`)
      .join(", ");
    return `- ${f.name}(${params}): ${f.description}`;
  });
  return `Tools. To call one, reply with a block exactly like this, and` +
    ` nothing after your last block:\n` +
    `<tool_call>{"name": "read", "arguments": {"path": "src/main.ts"}}` +
    `</tool_call>\n` +
    `Results come back in the next message inside <tool_result>. Never` +
    ` write a result yourself. When the work is done, answer without any` +
    ` block.\n${lines.join("\n")}`;
}

/**
 * Give every tool call an id.
 *
 * The protocol pairs a result to its call by id, and plenty of servers stream
 * tool calls without one. Every result then comes back tagged `""` — which is
 * indistinguishable from every other result the moment the model asks for two
 * things at once, and rejected outright by some chat templates. A positional
 * id is stable inside the turn, which is the only place it means anything.
 */
export const withCallIds = (
  calls: LocalToolCall[],
  round: number,
): LocalToolCall[] =>
  calls.map((c, i) => c.id ? c : { ...c, id: `call_${round}_${i}` });

/** Tools whose answer does not change unless something else changes it. An
 *  identical repeat of one of these in the same turn is answered from the
 *  first call rather than run again. */
export const REPEATABLE: ReadonlySet<string> = new Set([
  "ls",
  "glob",
  "read",
  "grep",
]);

/* ── keeping a weak model on track ────────────────────────────────────────── */

/** One call as loop detection sees it. */
export type SeenCall = { name: string; args: string; failed: boolean };

/**
 * The verdict on a turn that keeps repeating itself: what to tell the model,
 * or `null` when the recent calls still look like progress.
 *
 * Two shapes, both the ones every stuck small model produces: the same call
 * three times in a row (any tool — `sh` re-run with nothing changed in between
 * is as stuck as a re-read), and the same call *failing* twice in a row. Naming
 * the behaviour and the two exits breaks loops a bare "identical call" note
 * never did. The caller escalates: a second verdict in one turn takes the
 * tools away for a round.
 */
export function loopVerdict(recent: SeenCall[]): string | null {
  const key = (c: SeenCall) => `${c.name}\u0000${c.args}`;
  const n = recent.length;
  if (n >= 3) {
    const last = recent.slice(-3);
    if (new Set(last.map(key)).size === 1) {
      return `You have made the same ${last[0].name} call three times in a` +
        ` row and nothing changed in between, so the result will not change` +
        ` either. Change the call (another path, a narrower range, a` +
        ` different approach) or stop calling tools and answer with what you` +
        ` have.`;
    }
  }
  if (n >= 2) {
    const [a, b] = recent.slice(-2);
    if (a.failed && b.failed && key(a) === key(b)) {
      return `That ${a.name} call failed twice with the same arguments.` +
        ` Read the error, then fix the cause or try a different approach —` +
        ` repeating it will fail again.`;
    }
  }
  return null;
}

/**
 * Is this message, sent while the agent works, a request to stop?
 *
 * Only an unmistakable opening counts — "stop", "cancel", "never mind", "I
 * changed my mind". Then the current step is cut short at once rather than
 * waiting for a two-minute test run to finish; the message itself still goes
 * to the model, which says what it had done. "Don't stop" and "wait, also…"
 * are not stops: they arrive at the next step like any other message.
 */
export const isStopIntent = (text: string): boolean =>
  /^\s*(stop|cancel|abort|halt|enough|forget it|never ?mind|nevermind|i('ve| have)? changed my mind|scratch that)\b/i
    .test(text);

/** What an empty tool result becomes. A tool that returns "" is invisible to
 *  the model — some servers trim blank `tool` messages entirely, and the next
 *  round then has a dangling call it cannot explain, which reads to a small
 *  model as licence to invent an answer or re-run the call in a loop. */
export const emptyResult = (name: string): string =>
  `(Tool ${name} completed with no output.)`;

/**
 * Did the model stop in the middle of saying what it would do next?
 *
 * "Let me check the config file." — and the reply ends, no call made. The
 * commonest way a small model abandons a task, and the one a single nudge
 * reliably fixes. Read from the last sentence only, and never when it is
 * handing back to the user ("let me know…").
 */
export function wantsToContinue(text: string): boolean {
  // Code and tag blocks are not the sentence that says what comes next.
  const prose = text.replace(/```[\s\S]*?(```|$)/g, "")
    .replace(/<(\w+)>[\s\S]*?(<\/\1>|$)/g, "").trim();
  const tail = prose.slice(-300);
  if (!tail) return false;
  if (/let me know|feel free|hope this helps|anything else/i.test(tail)) {
    return false;
  }
  const last = tail.split(/(?<=[.!?])\s+/).slice(-2).join(" ");
  // A colon only counts where the reply itself ends — before a code block it
  // introduces the block, and the block is the answer.
  return /:\s*$/.test(text) ||
    /\b(let me|let's|i will|i'll|i am going to|i'm going to|i need to|next,? i('ll| will)|now,? i('ll| will))\s+[a-z]/i
      .test(last);
}

/**
 * Has the stream degenerated into repeating itself?
 *
 * The signature failure of a small or heavily quantized model: the same line
 * or paragraph, again and again, until the window is full. It is caught when
 * the tail of the text is one block (4 to 400 characters) repeated at least
 * five times over at least 1,200 characters — long enough that a legitimate
 * table or list of similar lines does not trip it.
 */
export function isRunaway(text: string): boolean {
  const tail = text.slice(-4_000);
  const n = tail.length;
  if (n < 1_200) return false;
  for (let p = 4; p <= 400; p++) {
    const unit = tail.slice(n - p);
    let reps = 1;
    while (
      (reps + 1) * p <= n &&
      tail.slice(n - (reps + 1) * p, n - reps * p) === unit
    ) reps++;
    if (reps >= 5 && reps * p >= 1_200) return true;
  }
  return false;
}

/* ── thinking ─────────────────────────────────────────────────────────────── */

const THINK_TAGS = "think|thinking|reasoning|thought";

/**
 * Split a reply into what the model said and what it thought.
 *
 * Reasoning models on servers that do not separate it write their thinking
 * into the content between `<think>` tags — sometimes with the opening tag
 * already eaten by the chat template, sometimes cut off before the closing
 * one. None of it is the answer: it is not shown as the reply, not stored as
 * it, and never sent back — on the next request it would be thousands of
 * tokens of stale reasoning read again at every round.
 */
export function splitThink(
  raw: string,
  streaming = false,
): { text: string; thinking: string } {
  let text = raw;
  const thoughts: string[] = [];
  const pair = new RegExp(`<(${THINK_TAGS})>([\\s\\S]*?)<\\/\\1>`, "gi");
  text = text.replace(pair, (_m, _t, body: string) => {
    thoughts.push(body.trim());
    return "";
  });
  // A closing tag with no opening one: the template ate the opener, and
  // everything before the close was thinking.
  const close = new RegExp(`^([\\s\\S]*?)<\\/(${THINK_TAGS})>`, "i").exec(text);
  if (close) {
    thoughts.push(close[1].trim());
    text = text.slice(close[0].length);
  }
  // An opening tag with no close: still thinking (or cut off while it was).
  const open = new RegExp(`<(${THINK_TAGS})>([\\s\\S]*)$`, "i").exec(text);
  if (open) {
    thoughts.push(open[2].trim());
    text = text.slice(0, open.index);
  }
  // Mid-stream, a tag arriving in pieces: hold back a trailing fragment that
  // could still become `<think>`, rather than flash it on screen.
  if (streaming) {
    const frag = /<\/?[a-z]*$/i.exec(text);
    if (
      frag &&
      THINK_TAGS.split("|").some((t) =>
        `<${t}>`.startsWith(frag[0].toLowerCase()) ||
        `</${t}>`.startsWith(frag[0].toLowerCase())
      )
    ) text = text.slice(0, frag.index);
  }
  return {
    text: text.replace(/^\s+/, ""),
    thinking: thoughts.filter(Boolean).join("\n\n"),
  };
}

/* ── errors ───────────────────────────────────────────────────────────────── */

/** The server refused the request because of the tools in it: llama.cpp
 *  without Jinja templating, an Ollama model with no tool support. Not a dead
 *  end — the agent switches to describing the tools in words. */
export const isNoToolSupport = (raw: string): boolean =>
  /--jinja|does not support tools|tools? (are|is) not supported|tool_call_incompatible|unsupported.{0,20}tool/i
    .test(raw);

/**
 * Turn a server's own error into something the reader can act on.
 *
 * Pure and tiny on purpose: an error message is part of the product, and the
 * raw `HTTP 500 — {"error":{...}}` a local server produces is not one a user
 * can do anything with.
 */
export const explainError = (
  raw: string,
  server?: { baseUrl?: string; engine?: string; found?: string | null },
): string => {
  if (isNoToolSupport(raw)) {
    return "This server refuses requests that carry tools, and describing" +
      " them in words did not work either. Switch the mode to Chat, or load" +
      " a model trained for tool use (llama.cpp: start it without" +
      " --no-jinja; older builds need --jinja).";
  }
  if (isUnreachable(raw)) {
    const at = server?.baseUrl ? ` at ${server.baseUrl}` : "";
    // The saved address is deliberately NOT corrected here: a hand-typed
    // address is a choice, and silently repointing a project at a different
    // server is how you end up talking to the wrong one. The app looks, says
    // what it found, and leaves the switch to a button.
    const found = server?.found && server.found !== server.baseUrl
      ? ` A ${server.engine ?? "local"} server IS answering at ${server.found}.`
      : ` Check that the server is running, and that its address matches` +
        ` the one set in Settings.`;
    return `Nothing answered${at}.${found}`;
  }
  if (isOverflow(raw)) {
    return "The conversation no longer fits this model's context window," +
      " even after compacting it. Load the model with a larger context, or" +
      " Clear and start again with a narrower request.";
  }
  return raw;
};

/**
 * The server is not there — as opposed to there and unhappy.
 *
 * Every runtime spells it differently and none of them spell it for a reader:
 * Deno's `fetch` says "error sending request for url (…)" and, wrapped, the
 * bare "fetch failed" that started this.
 */
export const isUnreachable = (raw: string): boolean =>
  /fetch failed|error sending request|connection refused|econnrefused|connect error|network error|client error \(SendRequest\)/i
    .test(raw);

/** Was this server error the window overflowing? Every engine spells it
 *  differently: llama.cpp's `exceed_context_size_error`, LM Studio's "context
 *  the overflows", the OpenAI-style "maximum context length". */
export const isOverflow = (raw: string): boolean =>
  /context.{0,20}(length|size|window)|prompt.{0,10}too long|maximum context|exceeds?.{0,30}context|exceed_context_size|context the overflows|too many tokens|n_ctx/i
    .test(raw);

/**
 * The numbers in an overflow error, when the server gave them: the window it
 * actually has and how big the prompt was. Either one lets the retry pack to
 * the truth instead of guessing tighter.
 */
export function overflowFacts(
  raw: string,
): { ctx?: number; prompt?: number } {
  const num = (re: RegExp) => {
    const m = re.exec(raw);
    const n = m ? Number(m[1]) : NaN;
    return Number.isFinite(n) && n > 0 ? n : undefined;
  };
  return {
    ctx: num(/"n_ctx"\s*:\s*(\d+)/) ??
      num(/context length of only (\d+)/i) ??
      num(/maximum context length is (\d+)/i) ??
      num(/context size (?:is |of )?\(?(\d+)/i) ??
      num(/context (?:window|length) (?:is |of )?(\d+)/i),
    prompt: num(/"n_prompt_tokens"\s*:\s*(\d+)/) ??
      num(/keep the first (\d+) tokens/i) ??
      num(/prompt (?:has|is|of) (\d+) tokens/i) ??
      num(/requested (\d+) tokens/i) ??
      num(/\((\d+) tokens?\) exceeds/i),
  };
}

/* ── clipping ─────────────────────────────────────────────────────────────── */

export const CLIP_MARK = "\n[…truncated — narrow the call for more]\n";

/**
 * The first of this app's own shortening notes found in `text`, or `null`.
 *
 * A model copies what it sees, and what it sees of an old write, a folded
 * result or a clipped one is a shortened copy with a note in it. A live session
 * rewrote a test file from its own earlier `write` as it saw it — 200
 * characters and "[…2804 more characters: your call was sent whole…]" — and a
 * 154-line file became 5 lines of junk, reported as "Overwrote (5 lines)". The
 * patterns carry their numbers, so source code that merely builds these notes
 * (this file) does not match.
 */
export function harnessNoteIn(text: string): string | null {
  const notes = [
    /\[…\d+ more characters: your call was sent whole[^\]]*\]/,
    /— result elided to save room; call again if needed\]/,
    /\[… \d+ characters not kept …\]/,
  ];
  for (const re of notes) {
    const m = re.exec(text);
    if (m) return m[0];
  }
  return text.includes(CLIP_MARK.trim()) ? CLIP_MARK.trim() : null;
}

/** Head-and-tail clip for tool output. The head carries the answer most of the
 *  time; the tail carries the error, which is always at the end. `head` is
 *  the share kept from the front — command output keeps more of its tail. */
export function clip(text: string, maxChars: number, head = 0.8): string {
  if (text.length <= maxChars) return text;
  const h = Math.floor(maxChars * head);
  const tail = maxChars - h;
  return text.slice(0, h) + CLIP_MARK + text.slice(text.length - tail);
}

/**
 * Gate on a model-supplied regex before it is ever compiled and run.
 *
 * V8 regexes are synchronous and backtracking: `(a+)+b` is measurably
 * exponential (over a second at 28 characters), so an input-size cap alone is
 * no defence — one bad pattern wedges the whole single-threaded process, with
 * no Stop and no recovery. Refused here, conservatively: no backreferences,
 * no quantifier applied to a group that itself contains a quantifier or an
 * alternation, bounded length and quantifier count. False negatives cost the
 * model a retry with simpler syntax; a false positive would cost the machine.
 */
export function safePattern(pattern: string): boolean {
  if (pattern.length > 128) return false;
  if (/\\[1-9]/.test(pattern)) return false; // backreferences
  const quantifiers = pattern.match(/[*+{?]/g)?.length ?? 0;
  if (quantifiers > 8) return false;
  // Scan for a quantified group whose body contains a quantifier, an
  // alternation, or another group — the catastrophic shapes, at ANY nesting
  // depth (((a+))+ is as bad as (a+)+, and a lint that only reads one level
  // was bypassed by exactly that). Escapes are skipped; character classes
  // are opaque (parens inside [] are literals).
  const starts: number[] = [];
  let inClass = false;
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "\\") {
      i++;
      continue;
    }
    if (inClass) {
      if (ch === "]") inClass = false;
      continue;
    }
    if (ch === "[") inClass = true;
    else if (ch === "(") starts.push(i);
    else if (ch === ")") {
      const open = starts.pop();
      if (open === undefined) return false; // unbalanced — refuse here
      const next = pattern[i + 1];
      if (next === "*" || next === "+" || next === "{" || next === "?") {
        const body = pattern.slice(open + 1, i);
        // Escaped chars in the body are literals — blank them first.
        const bare = body.replace(/\\./g, "");
        if (/[*+{|(]/.test(bare)) return false;
      }
    }
  }
  return true;
}

/**
 * What an old tool result shrinks to once the window needs its room: which
 * call it answered, so the model knows what it no longer has and can simply
 * make the call again. Deterministic — the same row stubs to the same bytes
 * every request, which keeps the server's prompt cache valid.
 */
export const stubOf = (m: LocalMsg, call?: LocalToolCall): string => {
  const what = call
    ? `${call.name} ${
      call.args.length > 100 ? call.args.slice(0, 100) + "…" : call.args
    }`
    : m.toolName ?? "tool";
  return `[${what} — result elided to save room; call again if needed]`;
};

/* ── what a conversation keeps ────────────────────────────────────────────── */

/** Characters of stored text a folded, stubbed or evicted tool row keeps — for
 *  the reader who expands it. The model never sees that shortened copy. */
const KEPT_WHEN_FOLDED = 1_200;

/** Live tool output one conversation may keep IN ITS STORE, in characters: a
 *  quarter of the window, never more than ~64k tokens. Past it, the oldest
 *  results are folded — shortened in the saved chat, not in what the model is
 *  sent. It used to be both: a live session at 76k of a 218k window had 71 of
 *  its 95 results reduced to one-line stubs, every doc page it had read among
 *  them, and read its own cell.ts five times and one doc three. */
export const storeBudget = (ctx: number): number =>
  Math.min(Math.floor(ctx * 0.25), 65_536) * 4;

/**
 * Tool rows to stub so a conversation's live tool output fits its store
 * budget — oldest first, down to 60% of it (the same hysteresis as packing,
 * so it happens rarely and in one batch, and the prompt prefix stays put
 * between batches). The newest result is never on the list.
 *
 * Why at all: every conversation is persisted and broadcast whole. Tool
 * output is 80% of it — measured at 4 MB of a 5 MB store after two days —
 * and on a 1M-token model nothing else would ever fold it.
 */
export function storeStubs(msgs: LocalMsg[], budgetChars: number): string[] {
  const live = msgs.filter((m) =>
    m.role === "tool" && !m.stubbed && !m.evicted && !m.folded
  );
  let total = live.reduce((n, m) => n + m.text.length, 0);
  if (total <= budgetChars || live.length < 2) return [];
  const target = budgetChars * COMPACT_TARGET;
  const out: string[] = [];
  for (const m of live.slice(0, -1)) {
    if (total <= target) break;
    out.push(m.id);
    total -= m.text.length;
  }
  return out;
}

/**
 * What a folded tool row keeps of its text — and a text that is already that,
 * unchanged. The shortened copy is longer than the limit (the note in the
 * middle adds to it), so without this every later pass folded the fold again,
 * and handed THAT to whoever was keeping the whole text: a live session was
 * sent head and tail of its `deno.json` with "[… 30 characters not kept …]"
 * where thirty lines had been, asked for it three times, was told each time
 * the result "above" was current, and was cut off for repeating itself.
 */
export const foldedText = (text: string): string => {
  const head = Math.floor(KEPT_WHEN_FOLDED * 0.7);
  if (text.length <= KEPT_WHEN_FOLDED) return text;
  if (/^\n\[… \d+ characters not kept …\]\n/.test(text.slice(head))) {
    return text;
  }
  return text.slice(0, head) +
    `\n[… ${text.length - KEPT_WHEN_FOLDED} characters not kept …]\n` +
    text.slice(text.length - Math.floor(KEPT_WHEN_FOLDED * 0.3));
};

/* ── packing ──────────────────────────────────────────────────────────────── */

/** One OpenAI-shaped wire message. */
export type WireMsg = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: {
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }[];
  tool_call_id?: string;
};

export type PackInput = {
  msgs: LocalMsg[];
  ctx: number;
  mode: LocalMode;
  /** The whole system prompt, from {@link systemPrompt}. */
  system: string;
  /** Send tool schemas natively (`tools`), or as words in the prompt with
   *  calls and results carried as text. */
  native: boolean;
  /** Tokens per estimated token, learned from the server — {@link calibrate}. */
  ratio?: number;
  /** A note for the model at the newest edge: its task list, a loop verdict.
   *  Rides on the last message so the prefix before it never changes. */
  note?: string;
  /** The whole text of a row whose stored copy was folded, when it is still
   *  held — see `LocalMsg.folded`. */
  fullOf?: (m: LocalMsg) => string | undefined;
};

export type Packed = {
  wire: WireMsg[];
  /** Rows to mark evicted — the caller folds them into the summary and
   *  repacks. */
  evict: string[];
  /** Tool rows to mark stubbed from now on. Sticky, so the next request packs
   *  them the same way and the cached prefix stays valid. */
  stub: string[];
  /** Estimated prompt tokens, calibrated. */
  tokens: number;
  /** The same, uncalibrated — what {@link calibrate} compares the server's
   *  count against. */
  raw: number;
};

/** Once packing has to make room, it makes this much: down to 60% of the
 *  budget, not just under it. Compacting a little every round would re-cut
 *  the prompt — and re-run the summarizer — on every single request; a real
 *  cut buys dozens of rounds of stable prefix. */
const COMPACT_TARGET = 0.6;
/** The newest tool output kept whole when stubbing, as a share of budget. */
const PROTECT_SHARE = 0.25;

/**
 * Fit the conversation into the window.
 *
 * Budget = ctx − output reserve − system prompt − tool schemas − note. If the
 * conversation fits, it is sent exactly as last time: stubs and evictions are
 * *sticky* (flags on the rows), so consecutive requests share their prefix
 * and the server's prompt cache does the heavy lifting. Only when it does not
 * fit is room made, down to {@link COMPACT_TARGET}, cheapest first:
 *
 *  1. old tool results become one-line stubs — the newest quarter of the
 *     budget's worth of tool output is protected;
 *  2. whole exchanges are evicted, oldest first, for the caller to fold into
 *     the rolling summary. The user's newest request and the newest exchange
 *     are never evicted: losing the task is worse than overflowing.
 *
 * Any single row bigger than half the budget (a pasted log, a huge answer) is
 * clipped head-and-tail in the wire, so one message can never make the whole
 * conversation unsendable.
 */
export function packContext(input: PackInput): Packed {
  const { msgs, ctx, mode, system, native, note } = input;
  const ratio = input.ratio ?? 1;
  const est = (s: string) => Math.ceil(estTokens(s) * ratio);
  const schemaText = native && mode !== "chat"
    ? JSON.stringify(toolSpecs(mode, ctx))
    : "";
  const fixedRaw = estTokens(system) +
    (schemaText ? estTokens(schemaText) : 0) +
    (note ? estTokens(note) : 0);
  const fixed = Math.ceil(fixedRaw * ratio);
  const budget = Math.max(ctx - outputReserve(ctx) - fixed, 512);
  const rowCap = Math.max(Math.floor((budget * 0.5 * 4) / ratio), 2_000);
  const argCap = Math.max(Math.floor(rowCap / 4), 300);

  const live = msgs.filter((m) => !m.evicted);
  const calls = new Map<string, LocalToolCall>();
  for (const m of live) for (const c of m.toolCalls ?? []) calls.set(c.id, c);

  const newest = newestBodies(live);
  const stubbed = new Set(live.filter((m) => m.stubbed).map((m) => m.id));
  // A folded row goes out whole while its text is held; without it (after a
  // restart) it goes out as the stub it always was — never as the shortened
  // stored copy, which would read as the real output.
  const textOf = (m: LocalMsg): string => {
    if (m.role !== "tool") return clip(m.text, rowCap, 0.6);
    if (stubbed.has(m.id)) return stubOf(m, calls.get(m.toolCallId ?? ""));
    if (m.folded) {
      const full = input.fullOf?.(m);
      return full === undefined
        ? stubOf(m, calls.get(m.toolCallId ?? ""))
        : clip(full, rowCap, 0.6);
    }
    return clip(m.text, rowCap, 0.6);
  };
  const costOf = (m: LocalMsg): number =>
    est(textOf(m)) +
    (m.toolCalls ?? []).reduce(
      (n, c) => n + est(c.name + wireArgs(c.args, argCap, newest.has(c.id))),
      0,
    );

  const cost = live.map(costOf);
  let total = cost.reduce((a, b) => a + b, 0);
  const newStubs: string[] = [];
  const evictIds: string[] = [];

  if (total > budget) {
    const target = Math.floor(budget * COMPACT_TARGET);
    // 0. A result that a later, identical call has already answered again is
    //    worth nothing: same tool, same arguments, and the newer one is what
    //    the model is working from. Stubbing those first costs nothing at all,
    //    where stubbing by age always costs something.
    const newest = new Map<string, string>();
    for (const m of live) {
      const c = m.role === "tool" ? calls.get(m.toolCallId ?? "") : undefined;
      if (c) newest.set(`${c.name}\n${c.args}`, m.id);
    }
    for (let i = 0; i < live.length && total > target; i++) {
      const m = live[i];
      if (m.role !== "tool" || stubbed.has(m.id)) continue;
      const c = calls.get(m.toolCallId ?? "");
      if (!c || newest.get(`${c.name}\n${c.args}`) === m.id) continue;
      stubbed.add(m.id);
      newStubs.push(m.id);
      const cost1 = costOf(m);
      total -= cost[i] - cost1;
      cost[i] = cost1;
    }
    // 1. Stub old tool output, protecting the newest quarter-budget of it
    //    (and always the very newest result, whatever its size).
    const protectedIds = new Set<string>();
    let kept = 0;
    for (let i = live.length - 1; i >= 0; i--) {
      const m = live[i];
      if (m.role !== "tool" || stubbed.has(m.id)) continue;
      if (protectedIds.size > 0 && kept + cost[i] > budget * PROTECT_SHARE) {
        break;
      }
      kept += cost[i];
      protectedIds.add(m.id);
    }
    for (let i = 0; i < live.length && total > target; i++) {
      const m = live[i];
      if (m.role !== "tool" || stubbed.has(m.id) || protectedIds.has(m.id)) {
        continue;
      }
      stubbed.add(m.id);
      newStubs.push(m.id);
      const c = costOf(m);
      total -= cost[i] - c;
      cost[i] = c;
    }
    // 2. Evict whole exchanges, oldest first. An exchange is a user row, or
    //    an assistant row with the tool rows that answer it — a tool row is
    //    never sent without its call.
    if (total > target) {
      const groups: number[][] = [];
      for (let i = 0; i < live.length; i++) {
        if (live[i].role === "tool" && groups.length) {
          groups[groups.length - 1].push(i);
        } else groups.push([i]);
      }
      // Two rows are never evicted: the newest message, and the newest one
      // that is not mid-task steering — the request that set this work going.
      // With only the first protected, one "also fix the test" made the task
      // itself an ordinary candidate, and losing the task is the one thing
      // compaction must never do.
      let lastUser = -1;
      let lastTask = -1;
      for (let i = live.length - 1; i >= 0; i--) {
        if (live[i].role !== "user") continue;
        if (lastUser < 0) lastUser = i;
        if (!live[i].steer) {
          lastTask = i;
          break;
        }
      }
      const gone = new Set<number>();
      for (let g = 0; g < groups.length - 1 && total > target; g++) {
        if (groups[g].includes(lastUser) || groups[g].includes(lastTask)) {
          continue;
        }
        for (const i of groups[g]) {
          gone.add(i);
          total -= cost[i];
          evictIds.push(live[i].id);
        }
      }
      if (gone.size) {
        const keep = live.filter((_, i) => !gone.has(i));
        live.splice(0, live.length, ...keep);
      }
    }
  }

  const wire: WireMsg[] = [{ role: "system", content: system }];
  for (const m of live) {
    wire.push(toWire(m, textOf(m), native, argCap, newest));
  }
  const tidy = tidyWire(wire);
  if (note) attachNote(tidy, note);
  const raw = tidy.reduce((n, w) => n + estTokens(w.content), 0) +
    (schemaText ? estTokens(schemaText) : 0) +
    tidy.reduce(
      (n, w) =>
        n +
        (w.tool_calls ?? []).reduce(
          (k, c) => k + estTokens(c.function.name + c.function.arguments),
          0,
        ),
      0,
    );
  return {
    wire: tidy,
    evict: evictIds,
    stub: newStubs,
    tokens: Math.ceil(raw * ratio),
    raw,
  };
}

/** One transcript row on the wire. In text mode the protocol is words: a
 *  call is its `<tool_call>` block in the assistant's content, and a result
 *  is a user message — the one role every chat template accepts. */
function toWire(
  m: LocalMsg,
  text: string,
  native: boolean,
  argCap: number,
  newest: ReadonlySet<string>,
): WireMsg {
  if (m.role === "tool") {
    return native
      ? { role: "tool", content: text, tool_call_id: m.toolCallId ?? "" }
      : {
        role: "user",
        content: `<tool_result name="${m.toolName ?? "tool"}">\n${text}\n` +
          `</tool_result>`,
      };
  }
  if (m.role === "assistant" && m.toolCalls?.length) {
    if (!native) {
      const blocks = m.toolCalls.map((c) =>
        `<tool_call>{"name": ${JSON.stringify(c.name)}, "arguments": ${
          wireArgs(c.args, argCap, newest.has(c.id))
        }}</tool_call>`
      ).join("\n");
      return {
        role: "assistant",
        content: [text, blocks].filter(Boolean).join("\n"),
      };
    }
    return {
      role: "assistant",
      content: text,
      tool_calls: m.toolCalls.map((c) => ({
        id: c.id,
        type: "function" as const,
        function: {
          name: c.name,
          arguments: wireArgs(c.args, argCap, newest.has(c.id)),
        },
      })),
    };
  }
  if (m.role === "user" && m.steer) {
    return {
      role: "user",
      content: `(Sent by the user while you were working — read it before` +
        ` your next step.)\n${text}`,
    };
  }
  return { role: m.role, content: text };
}

/**
 * A past call's arguments as they go back on the wire: always valid JSON, and
 * no string in them longer than `cap`.
 *
 * Valid, because llama.cpp parses the arguments of every call in the history
 * to render its template — one call a model cut off mid-JSON, kept verbatim,
 * made every later request in the conversation fail with HTTP 500. Short,
 * because a `write` of a 200 KB file is in the history for as long as the
 * exchange is: on an 8k model that one row is the whole window, and the model
 * does not need its own file content back — the file is on disk to re-read.
 */
/** Arguments that carry a file's own text. Once the call has run, the file on
 *  disk IS that text — keeping it in every later request pays for the same
 *  bytes again each round, and a `write` of 3 kB is a third of a 10k window. */
const BODY_KEYS = new Set(["content", "new_string", "old_string", "text"]);
/** What is left of one of those, so the model can still see which change it
 *  made without being handed the whole file back. */
const BODY_CAP = 200;

export function wireArgs(args: string, cap: number, whole = false): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(args || "{}");
  } catch {
    return JSON.stringify({ unparsed: clip(String(args), 200) });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return JSON.stringify({ value: parsed });
  }
  const body = whole ? cap : Math.min(cap, BODY_CAP);
  const carries = Object.entries(parsed as Record<string, unknown>).some(
    ([k, v]) => BODY_KEYS.has(k) && typeof v === "string" && v.length > body,
  );
  if (args.length <= cap && !carries) return args;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    const lim = BODY_KEYS.has(k) ? body : cap;
    // The note says WHO shortened it, because the model reads this back as its
    // own words. "elided" alone cost a live session four rounds: it saw its own
    // 139-line write come back cut at 200 characters, wrote "the writes are
    // getting corrupted — something is truncating my content", wrote the file a
    // second time, then read it back to find it had been right all along.
    out[k] = typeof v === "string" && v.length > lim
      ? v.slice(0, lim) +
        `\n[…${v.length - lim} more characters: your call was sent whole and` +
        ` the file has all of it — this copy is shortened to save room]`
      : v;
  }
  return JSON.stringify(out);
}

/**
 * The calls whose file text goes back whole (up to the argument cap): for each
 * path, its newest `write` and every `edit` after it — or, with no write in
 * view, its newest edit.
 *
 * That is what the model is working from. Cut to 200 characters, its own
 * latest change is gone from view the moment it is made, and two live sessions
 * answered that the same way — "my writes keep getting elided", a read-back
 * after every write (seven in one task), and, once the loop guard counted
 * those, a turn cut short. Newest-change-only was not enough either: a live
 * session wrote a 257-line cell, fixed one line of it with an edit, and the
 * edit, being newer, took the file out of view — it then wrote tests against
 * methods the cell did not have. The write plus the edits since reads as the
 * file. Older changes stay shortened: a newer write replaced what they said.
 */
export function newestBodies(msgs: readonly LocalMsg[]): Set<string> {
  const byPath = new Map<string, { fromWrite: boolean; ids: string[] }>();
  for (const m of msgs) {
    for (const c of m.toolCalls ?? []) {
      if (c.name !== "write" && c.name !== "edit") continue;
      let path: unknown;
      try {
        path = (JSON.parse(c.args) as { path?: unknown }).path;
      } catch { /* torn arguments carry no path to keep */ }
      if (typeof path !== "string") continue;
      const chain = byPath.get(path);
      if (c.name === "edit" && chain?.fromWrite) chain.ids.push(c.id);
      else byPath.set(path, { fromWrite: c.name === "write", ids: [c.id] });
    }
  }
  return new Set([...byPath.values()].flatMap((c) => c.ids));
}

/** A tool-call id every chat template accepts: nine letters and digits.
 *  Mistral's templates refuse anything else ("Tool call IDs should be
 *  alphanumeric strings with length 9"), and no template refuses these.
 *  Derived from the original, so it is the same on every request. */
export function wireId(id: string): string {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  let out = "";
  let x = h >>> 0;
  for (let i = 0; i < 9; i++) {
    out += "abcdefghijklmnopqrstuvwxyz0123456789"[x % 36];
    x = Math.floor(x / 36) + (i + 1) * 7919 + id.length;
  }
  return out;
}

/**
 * Make a message list every chat template will accept.
 *
 * The transcript is a record of what happened — a turn that failed before any
 * reply, a turn stopped mid-call, a model switched mid-conversation — and not
 * every record is a valid prompt. Gemma and Mistral templates throw on two
 * user messages in a row; OpenAI-shaped servers reject a tool call with no
 * result, or a result with no call; some templates want exactly one system
 * message, first. So: one system message; consecutive user messages merged;
 * a missing result filled in with what happened; an orphan result dropped;
 * the first message after the system prompt a user one.
 */
export function tidyWire(wire: WireMsg[]): WireMsg[] {
  const system = wire.filter((w) => w.role === "system").map((w) => w.content)
    .join("\n\n");
  const out: WireMsg[] = [{ role: "system", content: system }];
  let pending: string[] = [];
  const flush = () => {
    for (const id of pending) {
      out.push({
        role: "tool",
        content: "(Not run — the turn ended before this call ran.)",
        tool_call_id: id,
      });
    }
    pending = [];
  };
  for (const w of wire) {
    if (w.role === "system") continue;
    if (w.role === "tool") {
      const id = wireId(w.tool_call_id ?? "");
      if (!pending.includes(id)) continue; // orphan
      pending = pending.filter((p) => p !== id);
      out.push({ ...w, tool_call_id: id });
      continue;
    }
    flush();
    const prev = out[out.length - 1];
    if (w.role === "assistant" && !w.tool_calls?.length && !w.content.trim()) {
      continue; // an empty reply says nothing, and some templates choke on it
    }
    if (prev.role === "user" && w.role === "user") {
      prev.content += "\n\n" + w.content;
      continue;
    }
    if (
      prev.role === "assistant" && w.role === "assistant" &&
      !prev.tool_calls?.length && !w.tool_calls?.length
    ) {
      prev.content += "\n\n" + w.content;
      continue;
    }
    const copy: WireMsg = { ...w };
    if (w.tool_calls?.length) {
      copy.tool_calls = w.tool_calls.map((c) => ({ ...c, id: wireId(c.id) }));
      pending = copy.tool_calls.map((c) => c.id);
    }
    out.push(copy);
  }
  flush();
  if (out.length > 1 && out[1].role !== "user") {
    out.splice(1, 0, {
      role: "user",
      content: "(Continuing an earlier conversation — see the summary.)",
    });
  }
  return out;
}

/** Put a note to the model on the newest message: appended to the last user
 *  or tool message, or a user message of its own after a reply. Tagged, so it
 *  is not mistaken for something the user typed. */
function attachNote(wire: WireMsg[], note: string): void {
  // Said who it is from, because it often arrives as a user message: a live
  // session told "that file changed on disk" wrote "the user's message says
  // files were updated" and went back over everything it had read.
  // "The app running you" read, to a model building an app, as that app: a
  // live session answered two notes with "spurious — I'm the agent, not the
  // app". Named as the harness, and as neither of the other two.
  const text = `<system-note from="the harness running this conversation —` +
    ` not the user, not the app you are working on">\n${note}\n</system-note>`;
  const last = wire[wire.length - 1];
  if (last.role === "user" || last.role === "tool") {
    last.content += `\n\n${text}`;
  } else wire.push({ role: "user", content: text });
}

/* ── todos ────────────────────────────────────────────────────────────────── */

/** What models write as a status, mapped onto ours. */
const STATUS: Record<string, LocalTodo["status"]> = {
  pending: "pending",
  todo: "pending",
  open: "pending",
  not_started: "pending",
  notstarted: "pending",
  in_progress: "in_progress",
  inprogress: "in_progress",
  "in-progress": "in_progress",
  doing: "in_progress",
  active: "in_progress",
  started: "in_progress",
  current: "in_progress",
  completed: "completed",
  complete: "completed",
  done: "completed",
  finished: "completed",
};

/** Validate and normalize a model-supplied task list. Junk is dropped, not
 *  fatal — a todo list is the one tool where a partial result is strictly
 *  better than an error round spent on it. A bare list of strings is a list
 *  of pending tasks. */
export function parseTodos(raw: unknown): LocalTodo[] {
  if (!Array.isArray(raw)) return [];
  const out: LocalTodo[] = [];
  for (const item of raw.slice(0, 50)) {
    if (typeof item === "string") {
      if (item.trim()) out.push({ content: item.trim(), status: "pending" });
      continue;
    }
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    const text = r.content ?? r.task ?? r.text ?? r.title ?? r.description ??
      r.step;
    const content = typeof text === "string" ? text.trim().slice(0, 300) : "";
    const s = String(r.status ?? r.state ?? "").trim().toLowerCase();
    if (content) out.push({ content, status: STATUS[s] ?? "pending" });
  }
  return out;
}

/** The task list as the model sees it on every request — only while there is
 *  still something on it to do. Checkbox glyphs are token-cheap and every
 *  model reads them. */
export function todoNote(todos: LocalTodo[] | undefined): string {
  if (!todos?.length || todos.every((t) => t.status === "completed")) return "";
  const mark = (s: LocalTodo["status"]) =>
    s === "completed" ? "[x]" : s === "in_progress" ? "[~]" : "[ ]";
  return "Your task list:\n" +
    todos.map((t) => `${mark(t.status)} ${t.content}`).join("\n");
}

/* ── summary ──────────────────────────────────────────────────────────────── */

/**
 * The prompt asking the model to fold dropped rows into the rolling summary.
 *
 * An anchored template rather than free prose — the shape opencode and
 * Claude Code both arrived at: a small model's "summary" drops exactly the
 * facts the next round needs (a path, an error string), and a named section
 * per kind of fact survives the next compaction intact. `words` scales with
 * the window: a 1M model can carry a long memory, an 8k one cannot.
 */
export const summarizePrompt = (
  prev: string,
  dropped: string,
  words = 150,
): string =>
  `You are compacting the history of a coding session so the work can` +
  ` continue without it. Do not continue the conversation or answer anything` +
  ` in it. Output only the summary, in the conversation's language, as terse` +
  ` bullets under these headings (keep every heading, even if empty):\n` +
  `## Goal\n## Key facts (exact paths, names, commands, errors, decisions)\n` +
  `## Done\n## Next\n` +
  `Merge the previous summary with the dropped messages; where they` +
  ` conflict, the dropped messages are newer and win. At most ${words}` +
  ` words.\n\n<previous-summary>\n${prev || "(none)"}\n</previous-summary>` +
  `\n\n<dropped>\n${dropped}\n</dropped>`;

/* ── streaming ────────────────────────────────────────────────────────────── */

/** What one streamed completion accumulates into. */
export type StreamAcc = {
  text: string;
  /** Reasoning the server sent separately (`reasoning_content`, Ollama's
   *  `reasoning`) — shown while it streams, never stored or sent back. */
  thinking: string;
  toolCalls: LocalToolCall[];
  finish: string | null;
  /** Prompt tokens as the server reported them, when it did. */
  promptTokens: number | null;
  /**
   * Completion tokens as the server reported them.
   *
   * `null` when it did not — which is common, and is why the speed figure this
   * feeds is absent rather than estimated.
   */
  completionTokens: number | null;
};

export const newAcc = (): StreamAcc => ({
  text: "",
  thinking: "",
  toolCalls: [],
  finish: null,
  promptTokens: null,
  completionTokens: null,
});

/** Ceilings on what one streamed reply may accumulate. The stream comes from
 *  a server the user pointed at — a value off the wire is never trusted to
 *  size an allocation or to grow state without bound. */
const MAX_ACC_TEXT = 4_000_000;
const MAX_ACC_THINKING = 1_000_000;
const MAX_ACC_TOOL_CALLS = 32;
const MAX_ACC_TOOL_NAME = 256;
const MAX_ACC_TOOL_ARGS = 1_000_000;

/**
 * Fold one parsed SSE chunk (`data: {...}` payload of a chat completion) into
 * the accumulator. Tolerant by construction: a malformed chunk changes
 * nothing, because the stream belongs to another program.
 */
export function foldChunk(acc: StreamAcc, chunk: unknown): StreamAcc {
  if (!chunk || typeof chunk !== "object") return acc;
  const c = chunk as Record<string, unknown>;
  const usage = c.usage as Record<string, unknown> | undefined;
  if (usage && typeof usage.prompt_tokens === "number") {
    acc.promptTokens = usage.prompt_tokens;
  }
  if (usage && typeof usage.completion_tokens === "number") {
    acc.completionTokens = usage.completion_tokens;
  }
  const choice = Array.isArray(c.choices)
    ? c.choices[0] as Record<string, unknown> | undefined
    : undefined;
  if (!choice) return acc;
  if (typeof choice.finish_reason === "string") {
    acc.finish = choice.finish_reason;
  }
  const delta = choice.delta as Record<string, unknown> | undefined;
  if (!delta) return acc;
  if (typeof delta.content === "string" && acc.text.length < MAX_ACC_TEXT) {
    acc.text += delta.content;
  }
  const thought = delta.reasoning_content ?? delta.reasoning;
  if (typeof thought === "string" && acc.thinking.length < MAX_ACC_THINKING) {
    acc.thinking += thought;
  }
  if (Array.isArray(delta.tool_calls)) {
    for (const raw of delta.tool_calls) {
      const tc = raw as Record<string, unknown>;
      // The index sizes an array — an `index: 1e9` (or Infinity) from a
      // hostile server must not become a billion allocations or a spin.
      const i = typeof tc.index === "number" && Number.isInteger(tc.index) &&
          tc.index >= 0 && tc.index < MAX_ACC_TOOL_CALLS
        ? tc.index
        : 0;
      while (acc.toolCalls.length <= i) {
        acc.toolCalls.push({ id: "", name: "", args: "" });
      }
      const slot = acc.toolCalls[i];
      if (typeof tc.id === "string") slot.id = slot.id || tc.id;
      const fn = tc.function as Record<string, unknown> | undefined;
      if (fn) {
        // Same stance as text above: wire values grow state, so they stop at
        // a ceiling instead of trusting the server to stop.
        if (
          typeof fn.name === "string" && slot.name.length < MAX_ACC_TOOL_NAME
        ) {
          slot.name += fn.name;
        }
        // Some servers send the arguments as an object, whole, instead of a
        // streamed string. Same content; only the spelling differs.
        const a = fn.arguments && typeof fn.arguments === "object"
          ? JSON.stringify(fn.arguments)
          : fn.arguments;
        if (typeof a === "string" && slot.args.length < MAX_ACC_TOOL_ARGS) {
          slot.args += a;
        }
      }
    }
  }
  return acc;
}
