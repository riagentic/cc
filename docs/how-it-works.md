# How the local agent works

The agent that runs a project on **LM Studio, Ollama or llama.cpp** instead of
Claude Code. Code: `src/cell/local.ts` (the loop), `src/cell/local.server.ts`
(tools, server calls, sandbox), `src/lib/agent.ts` (prompt, packing, guards),
`src/lib/toolcall.ts` (call repair), `src/lib/replace.ts` (edit matching).

## 🔁 The loop

1. You ask.
2. The agent **packs** what fits into the model's memory (its _context window_ —
   how much text it can see at once).
3. The model answers, or asks for a **tool**: `ls` `glob` `read` `grep` `edit`
   `write` `todo` `sh`.
4. The agent runs the tool — safely — and hands back the result.
5. Repeat until the model gives a final answer.

**And it always ends.** A stretch of work stops at the first of: the model's own
final answer, **20 minutes**, **1024 tool rounds**, the **same call four times**
in one turn (however many others came in between), or Stop. Whichever it is, the
last reply is asked for **without tools** — so the turn ends in an answer, with
what was found and what is left — and a line in the transcript says it was cut
short, because a banner is gone by the next message. One reply may ask for at
most **12** calls; more than that is a guess, and the extra are named back to
the model instead of run.

Before the first request of a turn the agent learns what it is talking to: the
window the model is _really_ loaded at (loading a cold model first), whether it
takes tools natively, and the project it works in.

## ⏱️ Pace: Draft / Normal / Quality

How thoroughly one turn works — orthogonal to tools and permissions.

| Pace        | Intent                         | Rounds | Wall   | Verify nudge | Docs nudge |
| ----------- | ------------------------------ | ------ | ------ | ------------ | ---------- |
| **Draft**   | Something that runs, very fast | 48     | 4 min  | no           | no         |
| **Normal**  | Decent quality, still quick    | 160    | 10 min | yes          | no         |
| **Quality** | Today's full thorough pass     | 1024   | 20 min | yes          | yes        |

The wall-clock column is a _share_ of the turn budget, not a second clock: the
tunable `CC_TURN_MS` (twenty minutes by default) stays the whole of Quality, and
Draft and Normal take a fifth and a half of whatever it is set to.

Draft always uses the terse working method. Normal uses a lighter method on
large windows. Quality keeps the window-sized method unchanged. Sticky packing,
loop detection and tool repair stay on in every pace — those make Quality faster
without cutting corners.

## 🛡️ Capabilities & run-as

- **Read → Write → Execute → Allow all** replace per-command shell prompts.
  Execute is today's sandboxed "Don't ask"; Allow all is Bypass.
- **Run as:** Auto / cc-agent / You — explicit switch over the old ACL-only auto
  pick.

## 🧭 Main principles

- 📏 **The window decides everything.** 8k → short instructions, small results,
  early folding. 1M → full working method, big results, almost no folding. No
  fixed sizes: prompt tier, tool-result size (~8% of window), output reserve and
  compaction are all fractions of the window.
- 🔌 **Any model works.** Native tool calls where the model supports them; for
  models that do not, tools are described in words and calls are read back from
  the reply (the `<tool_call>` _text protocol_).
- 🧠 **Look → plan → act → check.** The universal working rules are in the
  prompt, in three sizes: explore first, search don't invent, plan (todo),
  smallest change, match the project, verify, recover instead of repeating,
  self-check before finishing. One of them is enforced rather than asked: a turn
  that changed files and ran nothing gets one reminder to run the project's own
  check before it answers.
- 🛟 **Catch how small models fail.** Wrong tool names, broken JSON, loops, "let
  me…" then silence, empty replies, runaway repetition — each is caught and
  answered with one precise note.
- ⚡ **Don't make the server re-read.** Every request starts with the same bytes
  (sticky packing, notes on the newest message only), so the server reuses its
  prompt cache — the biggest speed win on local hardware.
- 🛡️ **Never hurt your data.** Read before overwrite, "changed on disk" checks,
  one-click Undo of a turn's file changes, a sandbox for unattended commands,
  credentials hidden, cloud models flagged.

## 🧩 The mix, and why

### From opencode 🟦

- **Forgiving edit matching** — indentation, trailing spaces, curly quotes,
  escaped newlines. Small models copy code badly.
- **Loop detection** — the same call three times means stuck.
- **Anchored summary template** for folded history (Goal / Key facts / Done /
  Next) — keeps exact paths and error strings.
- **Read with line numbers and "continue at line X"** — fewer wasted rounds.

### From openclaude 🟧

- **Recovering tool calls written as text** — `<tool_call>`, Qwen/GLM XML,
  Mistral `[TOOL_CALLS]`, LM Studio `[TOOL_REQUEST]`, fenced JSON.
- **Prose guard** — JSON that is only an _example_ in a reply is never run.
- **Stripping `<think>`** — reasoning is never stored as the answer or sent
  back.
- **Continue nudge and empty-reply retry** — weak models stall mid-task.
- **bubblewrap sandbox** idea — unattended commands cannot escape the project.

### From Hermes 🟪

- **Nested instruction files** — an `AGENTS.md`/`CLAUDE.md` in a subdirectory is
  loaded when a tool first enters that directory, and appended to the **tool
  result** (never the system prompt), so a monorepo's per-package rules arrive
  without breaking the cached prompt prefix. Deduped by content.
- **Full tool-result hygiene** — one pass over every result strips ESC/CSI/OSC
  sequences, bare control characters, invisible plane-14 Unicode TAG chars (an
  ASCII-smuggling channel), and flattens `\r` overwrite spoofing to newlines.
  The pass is linear in the text: string escapes are bounded by the byte that
  could start their terminator, because the obvious lazy scan is quadratic on
  openers that never get one — and this runs over text somebody else wrote.
- **Call-cycle detection** — an `A,B,A,B,…` loop with identical results, which
  resets the "same call three times" streak on every alternation, is named as a
  cycle instead of running to the budget.
- **Boundary-aware think scrubbing** — an unterminated `thinking` only opens a
  block at a line boundary, so prose that merely mentions the tag is not eaten.
- **Non-code verify skip** — a turn that only touched `.md`/`LICENSE`/docs has
  nothing to run, so "you changed files and ran nothing" never fires on prose.

### Our own 🟩

- **The real window, from the server** — llama.cpp `/props` (per slot), LM
  Studio `loaded_context_length`, Ollama `/api/ps`; a cold model is loaded
  first. Both others guess, and Ollama silently cuts the front off a prompt
  longer than its loaded window.
- **Sticky, batched compaction** — old results become one-line stubs, then old
  turns fold into the summary, down to 60% of the budget in one go. The cached
  prefix stays valid between batches.
- **Learned token counting** — the server's `prompt_tokens` calibrates the
  chars/4 estimate, so "window full" errors stop.
- **Other agents' vocabulary accepted** — `read_file`, `bash`, `TodoWrite`,
  `file_path`, `command`, `oldString`… — models learned those names.
- **Wire hygiene** — merged user messages, filled-in missing results, valid JSON
  in history, 9-character call ids: Gemma, Mistral and llama.cpp stop rejecting
  real transcripts.
- **Data safety** — read-before-overwrite, changed-on-disk checks, Undo.
- **Project awareness** — `AGENTS.md`/`CLAUDE.md` (else the README's start),
  toolchain from manifests (`deno.json` tasks, `package.json` scripts, cargo,
  go, python, make), git state, and where the docs are (`docs/`,
  `dep/<name>/docs/`, up to four levels, nearest first) — plus per-directory
  instruction files discovered as the agent navigates (see Hermes above). The
  rule that goes with it: read a framework's docs before its source — never
  experiment blind, never borrow binaries from other folders, and never lift the
  sandbox just to read a file.
- **Bounded storage** — stored tool output is capped per conversation, so the
  app stays light.

### Left out on purpose 🚫

- **"Similar enough" edit matching** (first/last line match, fuzzy middle) — it
  can overwrite code the model only guessed at.
- **Forcing Ollama's window** via its native API — a large `num_ctx` can
  overflow the GPU. The agent budgets against what Ollama loaded and says when
  that is small.
- **Heavy command parsers and repo maps** — much complexity for little gain; the
  sandbox does the safety job more simply.

**💡 Why this mix:** opencode is strongest at editing and memory, openclaude at
understanding messy local models, Hermes at hardening an agent against untrusted
output and per-directory project context. We added what all miss: the real
window, speed from the prompt cache, and data safety.

## 🧮 When the window fills up

No "compact at 80%" timer: **every request is packed to fit before it is sent**,
so the window never silently overflows. In order:

1. **Fits?** Sent exactly as last time (same bytes → server cache hit).
2. **Doesn't fit → stub.** Old tool results become one-line stubs naming the
   call (`[read {"path":"a.ts"} — result elided; call again if needed]`). The
   newest quarter of the budget's tool output stays whole.
3. **Still doesn't → fold.** The oldest whole exchanges are evicted and a
   summary call folds them into the system prompt (Goal / Key facts / Done /
   Next). Never evicted: your latest request, the newest exchange.
4. **Room to breathe.** Each cut goes down to **60%** of the budget, so the next
   several rounds fit with no new cut (and no new summary call).
5. **One giant message** (a pasted log) is clipped head + tail to half the
   budget — one row can never make the conversation unsendable.
6. **Reply room** is reserved (~15% of the window) and `max_tokens` is sent as
   what is left, so the answer has space.
7. **Estimates learn.** The server's own token counts correct the packer's
   guesses, so "full" is known accurately.
8. **Server still says "full"?** Its error is parsed for the real numbers
   (window, prompt size), the turn repacks tighter and retries — twice at most.
9. **Summary call fails?** A plain list of what was asked and done (paths,
   commands) stands in, so facts are never just lost.
10. **Last resort:** a clear message — load the model with a larger window, or
    Clear.

What keeps the model on track afterwards: its **task list** rides along on every
request, it is told old output may be elided (so it notes key facts in its
replies), and a stub says exactly what to call to get a result back. On screen,
folded rows stay visible, dimmed; the strip's meter shows how full the window
is.

## 💬 Talking to it while it works

- Type any time — the composer stays open during a turn.
- The message waits ("next step" chip, with × to take it back) and is delivered
  into the running task at its **next step**, marked as sent during the task.
  The model is told what to do with it: a correction changes the plan, a
  question gets a short answer before it carries on, "stop" means stop and
  summarize.
- An unmistakable stop — "stop", "cancel", "never mind", "I changed my mind",
  "scratch that" — cuts the current step short **at once** (no waiting for a
  two-minute test run); the same turn then answers the message.
- Anything written after the final answer is answered too, by the same turn.

## ⏹️ The Stop button

Typed "stop" asks the model to wind down and answers you. The **button** means
now, and nothing more is sent:

- The request in flight is cut; a running command is killed with its whole
  process group; a pending approval is withdrawn (it never runs).
- The rest of a batch of calls is **answered, not run** ("Not run: the user
  pressed Stop") — a stopped turn never goes on to edit the next file.
- What you typed meanwhile stays in the chat where you said it, unanswered.
- Stop pressed in the split second before the turn got going still counts.
- Stopped mid-compaction: the plain list of the evicted rows goes into the
  summary — old context is never lost to a Stop.
- A "working" flag with no turn behind it (a crash) is cleared by Stop, so the
  composer always comes back.
- Background programs the agent started keep running — the "N running" chip
  stops those.

## 🗄️ Every conversation is kept

- **Clear** empties the screen and the model's view — Undo brings it back — and
  saves every row to disk first.
- **Closing a tab** is one click with nothing behind it, so it saves the
  transcript on the way out too — and lets go of everything the conversation
  held: its background programs, its undo history, its temp directory, its
  settings. `history` can still find what was said.
- **Row cap (400):** rows pushed out of a long chat are saved, not dropped. The
  chat says how many ("N earlier messages are saved…").
- **Folded tool output** (stubs, evicted rows) is saved whole before it is cut.
- **Idle chats park.** A chat nobody has opened for 10 minutes, and that is not
  on screen, moves out of the app's state onto disk (checked a minute after
  start, then every 5 minutes). It comes back the moment you open it or write to
  it. On a real machine: 3.5 MB of state → 0.4 MB.
- **Nothing is deleted before it is saved.** A parked file is removed only once
  its rows are safely in the record; a damaged one is renamed aside (never
  overwritten) and the chat says so. After Clear, a turn still winding down
  writes nothing into the new, empty chat.
- **Where:** `~/.claude-control/history/` (0700, files 0600): one folder per
  project (its path hashed), one append-only file per conversation, parked chats
  in `parked/`. Never in `/tmp`, hidden from sandboxed commands.

The agent searches all of it with the **`history`** tool (read and agent modes):

- `history {query}` — best matches across this project's conversations: whole
  words first, every word found beats some, each hit tagged with its chat, time,
  speaker and id. `"a phrase"` stays whole.
- `history {id}` — one message, whole. `history {}` — the list of this project's
  conversations. `conversation: "this"` narrows to the current one.
- Only **this project**. Other projects' chats are never searched.
- It does not bloat the context: nothing is sent until the model asks, and the
  answer is sized to the tool budget. The summary tells the model the original
  messages are searchable, so a detail lost to compaction is one call away.

## 🛡️ Permissions for `sh`

| Mode          | What happens                                                                                                                                                                                                                                                                       |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Ask**       | The exact command is shown; the turn waits for Run / Refuse.                                                                                                                                                                                                                       |
| **Don't ask** | Runs unasked **in the sandbox**. Destructive commands refused. With no bubblewrap on the machine it asks, like Ask: without the box the only boundary left is a reading of the command's words, and words are easy to disguise (`\rm -rf ~`, `X=rm; $X -rf ~`, an eval of base64). |
| **Bypass**    | No checks. Credentials are still removed from the environment.                                                                                                                                                                                                                     |

**The sandbox ("Don't ask")**

- Writable: the project, the conversation's own `/tmp` and download caches.
  Everything else read-only; credential stores and this app's data hidden.
- `/tmp` is **per conversation and kept** between commands — it lives in
  `~/.claude-control/tmp/<conversation>` (mode 0700), never the shared `/tmp`.
  Also the sandbox's `XDG_RUNTIME_DIR`, `TMPDIR`, and `AIO_APPS_DIR` (so aio
  apps can run inside). Removed on Clear; swept after a week.
- **No network and no display** by default. They go together: the X server's
  abstract socket lives in the network namespace, so a sandbox with network
  could screenshot the whole desktop (a live session's model did). A switch in
  Settings allows the network for a conversation.
- `rm` inside the box's `/tmp` and `kill` of the box's own processes are
  allowed; other destructive commands are still refused.
- **Escape hatch:** `sh` with `outside_sandbox: true` (Claude Code's
  `dangerouslyDisableSandbox` works too) turns that ONE command into an Ask
  prompt — for a download, a GUI app, a `git push`. The refusal of a destructive
  command names this route, so the model asks instead of digging.
- The model is told all of this **before** its first command.

**Background programs**

- `sh` with `background: true` keeps a program running after the command returns
  (a dev server, the app under test). Output goes to `/tmp/job-<id>.log`; `jobs`
  lists them, `stop-job <id>` stops one.
- They stop on `stop-job`, the "N running" chip beside the composer, Clear,
  closing the conversation's tab, removing the project, or the app exiting — and
  after **12 hours**, because a dev server nobody is watching is a port held and
  a fan spinning. At most 4 per conversation; logs capped at 8 MB.
- A background program is the one thing this app starts on purpose to outlive
  the command that started it, so it is also written down: each conversation's
  live jobs are recorded next to its temp with the kernel's start time for every
  pid, and the **next boot stops what a crash left running** (a start time that
  no longer matches is somebody else's process, and is left alone — as are the
  jobs of a second copy of the app that is still alive).

**Limits every command runs under**

- `TMPDIR` is the conversation's temp; timeout 2 min by default (the model may
  ask for up to 10); everything but a background job is killed with its whole
  process tree when the command returns.
- **Credential-shaped environment variables are never passed** — anything named
  like a key, token, secret or password, and the usual cloud prefixes. Approving
  a command is not handing over every key you own; one `env` in a plausible
  command would otherwise put the lot into the transcript, on disk, and on the
  way to the model. A command that truly needs a secret is one for you to run.
- The kernel's own ceilings, which a timeout cannot give: a single file may grow
  to **2 GB**, and tasks are capped at a quarter more than this machine already
  runs — measured, because Linux counts that limit against every thread in your
  desktop session. A fork bomb hits it in a second; an honest build never
  notices. Both refusals are explained in words in the result.
- Output too long for the window is **kept, not dropped**: the whole run goes to
  `sh-<n>.log` in the conversation's temp and the result names it, so a 200 KB
  test run is one `grep` instead of another two-minute run.

## 📁 Reading outside the project

File tools stay inside the project. The one exception is **reading through a
link that lives in the project** — `dep/aio → ~/.local/lib/aio-versions/…` is
how a project vendors its framework, and the agent is told to read those docs
first.

A link may lead to a sibling checkout. It may **not** lead to:

- your home directory itself (one `grep` over it is a search for every secret
  you own) or anything hidden inside it — `~/.ssh`, `~/.config`, `~/.var`, this
  app's own data;
- a file that is a credential by its name: `.env`, `.env.*`, `id_*`, `*.pem`,
  `*.key`, `.netrc`, `.git-credentials`, `credentials`;
- `/proc`, `/sys`, `/dev`, `/root`, `/boot`, or `/` itself.

The project's own `.env` still reads: that is the work. Another project's does
not — one conversation's transcript must not end up holding keys that belong to
different work. Nothing is ever _written_ through such a link, and a missing
file suggests the same name elsewhere in the project.

## 🧪 Trying a model

```sh
deno task live lmstudio http://localhost:1234 google/gemma-3-12b
```

Runs the agent on a throwaway project with a planted bug and prints what it did.
`LIVE_DIR=` for a real project (read mode), `LIVE_CTX=` to force a small window,
`||` between turns.
