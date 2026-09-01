# cc — Claude Control

A desktop control surface for [Claude Code](https://claude.com/claude-code):
chat, live monitoring, background work, and settings — across every project you
work in — built on [aio](https://github.com/riagentic/aio).

**Every project is its own everything.** Its own conversation, its own
long-lived `claude` process, its own model, effort, permission mode and allowed
directories — all remembered. They run _concurrently_: a turn you start in one
codebase keeps working while you read another, and lands in that project's
transcript rather than over the one on screen. Within a project the process is
long-lived, so its context, tools and MCP servers are paid for once and every
turn continues the same conversation.

## The shell

Three columns, split by how often you use them:

- **Left — projects.** One vertical tab per project: its name, its branch,
  whether it has uncommitted work, whether the folder is still there — and what
  its own session is doing. A dot for a live one, a ring when it has stopped to
  ask you something. That is the whole signal for a turn that finished, or
  blocked, in a project you are not looking at. Hovering a tab with a live
  session reveals a **×** that ends it, without switching there first — the
  conversation is kept, and Resume brings its context back.
- **Middle — the page**, under the live status strip.
- **Right — sections.** The thing you click constantly, on the side the pointer
  already rests.

## Settings belong to the project

Two codebases rarely want the same answer. The one you are shipping wants Opus
and an approval prompt on every write; the scratch repo wants Haiku and no
prompts at all. So **model, effort, permission mode, allowed directories and
Allow-all are per project**, and persisted with it.

A new project is seeded from what the CLI itself is configured to do in that
directory — the `model`, `effortLevel` and `permissions.defaultMode` in the
settings files Claude Code reads — so it starts where a terminal opened there
would start. After that it is its own. Nothing follows you between projects,
which is what stops a `bypassPermissions` chosen for a sandbox arriving at
production.

Theme stays global: it is a fact about the window, not about a codebase.

## What it shows

**Session**

| Page           | What it is for                                                                          |
| -------------- | --------------------------------------------------------------------------------------- |
| **Chat**       | The conversation, with streaming text, folded thinking, and every tool call inline      |
| **Sub-agents** | Each delegation — its prompt, the tools it is running now, tokens, and what it returned |
| **Tasks**      | The CLI's background tasks, plus every tool call with its input and output              |
| **Activity**   | One timeline of session, model, tool, agent and task events                             |

**Background** — work that outlives the turn that started it

| Page      | What it is for                                                                      |
| --------- | ----------------------------------------------------------------------------------- |
| **Jobs**  | Every `claude --bg` background session: what it is doing, and what it is waiting on |
| **Loops** | A prompt re-sent on an interval — a standing check you can see, pause and edit      |

**Project**

| Page       | What it is for                                                              |
| ---------- | --------------------------------------------------------------------------- |
| **Tree**   | The project's files, with every one this session read or wrote marked on it |
| **Memory** | Every `CLAUDE.md` and memory file in play, measured on disk, by scope       |

**Capabilities** — what the session can do, and where each piece comes from

| Page         | What it is for                                                                    |
| ------------ | --------------------------------------------------------------------------------- |
| **Skills**   | Every skill, its description, and the file behind it                              |
| **Commands** | Slash commands, by scope                                                          |
| **MCP**      | Servers as configured, joined to whether the session actually reached them        |
| **Plugins**  | Installed, enabled and loaded — three different states                            |
| **Hooks**    | Every command that runs automatically on this machine, and which file declares it |
| **Settings** | Project, model, effort, permission mode, theme, and what the session reports      |

The status strip above every page carries the live figures: project, git branch,
model, **context used against the real window**, running sub-agents, running
tasks, the current turn's elapsed time, session cost, queued turns, the live
thinking-token estimate while a turn is in flight, and — once a usage window
gets tight — how full it is.

Assistant prose renders as Markdown, including **tables**, with syntax-highlit
code blocks you can copy in one click. The composer takes <kbd>↑</kbd> to recall
a previous turn.

## Running it

`cc` is a desktop app: Electron is the default client and the default build
target.

```sh
deno task dev                       # the Electron window
deno task dev --client=browser      # same app in a browser tab
deno task dev --client=server-only  # headless — drive it with `deno task am`

deno task compile                   # → dist/claude-control-x86_64.AppImage
deno task build                     # every target in deno.json build.targets
deno task install:electron          # only if the binary is missing
```

`cc` shells out to the `claude` binary, so it needs a real process host — the
browser and Electron clients both talk to the local aio server that owns the
session. Set `CLAUDE_BIN` if the CLI is not on `PATH`.

```sh
deno task test             # cell + protocol tests
deno task check            # type-check src/
deno task lint             # aiol, the project linter
deno task fmt
deno task am state         # inspect the running app's state (dev builds only)
```

> `am`'s control plane is a dev-build surface. A compiled AppImage runs over a
> Unix socket with no TCP port, so `am status` sees it but `am state` does not.

> **Cloned this repo?** The framework link, `.env`, and `node_modules` are
> gitignored — run `am fix` once (after installing `am` via the aio install
> script), then `deno task dev` works.

## How it works

The CLI runs in stream-json mode over stdin/stdout, one process per session.
Turns are written to its stdin as NDJSON; its events are read from stdout and
reduced into cell state:

```
claude (stdin/stdout NDJSON)
  -> cell/claude.server.ts   spawn, stream, interrupt, git, memory (server only)
  -> cell/session.ts         the protocol reducer — everything the UI shows
  -> ui/*                    AIR components reading cell state reactively
```

Five things the protocol makes subtle, all handled deliberately:

- **A session is ready before it says so.** The CLI emits `system/init` only
  when a first turn begins, so readiness is taken from its answer to the
  `initialize` control handshake — the earliest proof the process is listening.
  Waiting on `init` left a healthy session reading "Starting…" until someone
  typed. Memory is measured on start for the same reason: it is a fact about the
  project, not about a turn.
- **A background task is reported gone before it is explained.** The task drops
  out of `background_tasks_changed` first, and only then does `task_updated` say
  whether it completed, failed or was killed. Absence alone is not an outcome,
  so the later word corrects the earlier guess — otherwise a failed task left
  the call that launched it showing a green "done".
- **Streaming** is coalesced at ~10 Hz rather than dispatched per token, so the
  render loop never sits on the critical path of the model's output.
- **An async sub-agent** acks its launch in milliseconds and then works for
  minutes. Its run is joined to the CLI background task it spawned, so it stays
  reported as running until that task actually ends, and its real answer is
  taken from the task notification rather than from that launch receipt.
- **One user turn ends in several `result` events** — each sub-agent that
  finishes wakes the model again — and every one carries the _session_ cost to
  date and is followed by a fresh `init`. Cost is therefore taken, not summed,
  and a re-init never overwrites the context window already measured.

`Stop` sends a real `interrupt` control request: the turn ends, the session and
its context survive. Ending the session ends the **process**: stdin is closed,
then `SIGTERM`, then `SIGKILL`, and the same teardown runs on app exit — a
`claude` is never left behind holding a session nothing can see.

## When a project folder disappears

Nothing tells a running `claude` that the directory it is working in has been
deleted, renamed or unmounted. Left alone it holds a process, a context and a
token bill for a codebase that no longer exists, and every tool call it makes
fails in a way that reads like the model being confused rather than the folder
being gone.

So every running session's working directory is re-checked on a timer. One that
has vanished has its session closed — process ended, reason stated — and its
project is marked **gone** in the dock and the Projects list, which is where the
remedy is.

## Background sessions, and loops

`claude --bg` detaches a whole session: it keeps working after the terminal that
started it is gone. That is a different thing from a background _task_, which is
one tool call inside the session this app drives — so they get separate pages.

The failure **Jobs** exists for is a job that went **blocked**: waiting on a
human answer, costing nothing, finishing never, and discoverable only by
remembering it exists. Blocked jobs sort first, carry the loudest badge, and
show the question they are actually holding on. Stop, respawn and remove run the
CLI's own subcommands; answering a job means `claude attach <id>`, because a
background session is a conversation and this app drives a different one.

A **loop** is a prompt cc re-sends on an interval, the way `/loop` does inside
the CLI — except owned here, so it survives the turn that created it, is visible
between runs, and pauses without ending the session. Two rules keep it from
being a surprise: it fires only into the project it was made for, and never into
a turn that is already running.

## The tree

A file browser is the least interesting panel this app could have. What earns it
a tab is the overlay: every file the running session has **read** or **written**
is marked, live, from the tool calls it actually made. Only expanded directories
are walked, so the panel costs what you opened.

## What is measured, and what is not

Projects are persisted, so a stored path is a claim about last week. Every one
is re-checked against the disk on boot: a folder that has been deleted, renamed
or unmounted is marked **gone**, the app boots onto one that is still there, and
the row says what to do about it instead of failing at spawn with "Could not
start".

Usage limits come from the CLI's own `rate_limit_event`, every window it reports
(`five_hour`, `seven_day`, …) with the time each one resets — not just the
single figure it chooses to headline, which can read 0% while another window is
nearly full.

## Permissions

When Claude Code needs approval it asks, and `cc` answers — the app registers
itself as the CLI's permission prompt (`--permission-prompt-tool stdio`), so a
call that needs a decision arrives as a `can_use_tool` control request and the
CLI **blocks** until the answer goes back.

The prompt appears above the composer with the tool, the exact input, the CLI's
own reason, and three answers:

| Answer           | What it does                                                              |
| ---------------- | ------------------------------------------------------------------------- |
| **Allow once**   | Runs this call, this time                                                 |
| **Always allow** | Also applies the change the CLI suggested — the card names its real scope |
| **Deny…**        | Refuses it, with an optional reason the model reads as the tool's error   |

Every decision is kept: the Tasks page lists what was allowed and refused, and
the Activity timeline carries each one. While a prompt is up, the rail, the
status strip and the tool chip all say so — a blocked turn is never silent.

> Without this the CLI has nobody to ask, so it denies the call itself and the
> model narrates a request that never reaches the screen. That is what "the
> sub-agents started and never finished" was.

Effort (`--effort`) is set in Settings too, from **Low** to **Max**. The default
passes no flag at all, so whatever you have configured for the CLI itself still
applies. Like the model and the permission mode, it takes effect on the **next**
session.

Two ways to grant more up front, in Settings:

- **Allowed directories** — passed through as `--add-dir`. The narrow fix, and
  the right one for "the build writes to `/tmp`".
- **Allow all** — runs the CLI with `--dangerously-skip-permissions`: no checks
  at all, anywhere this user account can reach. It takes two clicks, and while
  it is on the status strip carries a permanent red marker so it can never be
  something you forgot you left enabled.

Both apply to the **next** session — use Restart after changing them.

State lives in `src/cell/`, pure helpers in `src/lib/`, types in `src/type/`, UI
in `src/ui/`, entry in `src/app.ts`.
