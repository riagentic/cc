# cc — Claude Control

A desktop control surface for [Claude Code](https://claude.com/claude-code):
chat, live monitoring, and settings for one project at a time, built on
[aio](https://github.com/riagentic/aio).

One long-lived `claude` process backs the whole app, so a session's context,
tools and MCP servers are paid for once and every turn continues the same
conversation.

## What it shows

| Page           | What it is for                                                                          |
| -------------- | --------------------------------------------------------------------------------------- |
| **Chat**       | The conversation, with streaming text, folded thinking, and every tool call inline      |
| **Sub-agents** | Each delegation — its prompt, the tools it is running now, tokens, and what it returned |
| **Tasks**      | The CLI's background tasks, plus every tool call with its input and output              |
| **Activity**   | One timeline of session, model, tool, agent and task events                             |
| **Memory**     | Every `CLAUDE.md` and memory file in play, measured on disk, by scope                   |
| **Settings**   | Project, model, permission mode, theme, and everything the session reports about itself |

The status strip above every page carries the live figures: project, git branch,
model, **context used against the real window**, running sub-agents, running
tasks, the current turn's elapsed time, and session cost.

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
its context survive.

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
