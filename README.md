# cc — Claude Control

A desktop app for working with [Claude Code](https://claude.com/claude-code)
across many projects at once, with local models (LM Studio, Ollama, llama.cpp)
as a second engine. Built on [aio](https://github.com/riagentic/aio).

> **Status: v0.2, early and unfinished.** Built and tried on one Linux machine
> only. Expect rough edges, breaking changes and no support.

## What it does

- **Projects side by side** — each with its own conversations, `claude` process,
  model, effort, permission mode and allowed directories. A turn in one keeps
  running while you read another.
- **Approvals in the window** — the CLI's permission prompts show the exact tool
  call; allow once, always, or deny with a reason.
- **Watch the session** — context use, sub-agents, background jobs, loops,
  memory files, skills, MCP servers, hooks, storage, CPU/GPU gauges.
- **Consoles** — real shells on a pseudo-terminal (a small Rust host ships in
  the binary), plus run buttons taken from the project's own manifests.
- **Local agent** — tools for reading, searching, editing and running commands,
  sized to whatever context window the server has. Commands can run in a
  bubblewrap sandbox, or as a separate Linux user
  ([examples/cc-agent](examples/cc-agent/setup.sh)).
- **Voice** — push-to-talk (Whisper) and read-aloud (Kokoro, Supertonic or
  Piper); both off until you turn them on and point them at your own server.

## Honest limits

- **Linux only in practice.** Sandboxing, the separate-user mode, the terminal
  host and the GPU gauges are Linux-specific. macOS and Windows are untested.
- **Tied to Claude Code's streaming JSON interface.** A CLI update can break
  things until cc catches up.
- **Local models are the weak part.** On one 48 GB machine, a fast small model
  finished a simple app in ~16 minutes with many mistakes; a slower 27B model
  was more careful but ran out of patience before finishing. The harness helps,
  it does not make a small model smart.
- **Tests:** about 500. Two of them fail now and then on timing.
- Voice needs a speech server you run yourself; nothing is bundled.

## Run it

Needs [Deno](https://deno.com) 2.x, the `claude` CLI on `PATH` (or
`CLAUDE_BIN`), and aio's `am`:

```sh
curl -fsSL https://raw.githubusercontent.com/riagentic/aio/main/install.sh | sh
git clone <this repo> cc && cd cc
am fix                   # links the pinned aio version, installs what is missing
deno task dev            # Electron window
deno task dev ~/code/x   # …opened on that project
deno task compile        # → dist/claude-control-x86_64.AppImage
deno task test           # tests
deno task check          # type-check
```

## Read more

- [docs/guide.md](docs/guide.md) — every feature, shortcut and setting
- [docs/how-it-works.md](docs/how-it-works.md) — the local agent's design and
  its safety boundaries

## License

[MIT](LICENSE)
