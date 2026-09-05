/**
 * @module
 * Jobs — the background sessions `claude --bg` detaches.
 *
 * The page is built around one failure: a job that went **blocked**. It is
 * waiting for a human answer, it is costing nothing, it will never finish, and
 * until now the only way to discover it was to remember it existed and run
 * `claude agents`. Blocked jobs sort first, carry the loudest pill, and show the
 * question they are actually holding on.
 */
import { useLocal, type VNode } from "aio/air";
import { cliCanRemove, jobs, selectedJob, staleJobs } from "../cell/jobs.ts";
import type { Job, JobState } from "../type/claude.ts";
import { ago, clock, oneLine, tildePath, tokens } from "../lib/format.ts";
import { workspace } from "../cell/workspace.ts";
import {
  Banner,
  Empty,
  matches,
  Panel,
  Pill,
  Search,
  useNow,
} from "./parts.tsx";
import { PageHead } from "./RunViews.tsx";
import {
  IconJobs,
  IconPower,
  IconRefresh,
  IconTrash,
  IconX,
} from "./icons.tsx";

/** Blocked first, then working, then everything finished. Freshness decides
 *  inside a group — but never across one, or a job waiting on a human would
 *  sink under a stream of finished ones. */
const RANK: Record<JobState, number> = {
  blocked: 0,
  working: 1,
  unknown: 2,
  failed: 3,
  stopped: 4,
  done: 5,
};

function StatePill(props: { state: JobState }): VNode {
  switch (props.state) {
    case "blocked":
      return <Pill tone="warn">waiting on you</Pill>;
    case "working":
      return <Pill tone="accent">working</Pill>;
    case "done":
      return <Pill tone="ok">done</Pill>;
    case "failed":
      return <Pill tone="danger">failed</Pill>;
    case "stopped":
      return <Pill>stopped</Pill>;
    default:
      return <Pill>unknown</Pill>;
  }
}

function JobRow(
  props: { job: Job; selected: boolean; now: number },
): VNode {
  const j = props.job;
  return (
    <button
      type="button"
      class={`rowitem${props.selected ? " selected" : ""}`}
      aria-label={j.name}
      onClick={() => jobs.select(j.id)}
    >
      <span class="rowitem__icon">{IconJobs({ size: 15 })}</span>
      <span class="truncate">
        <span class="rowitem__title truncate">{j.name}</span>
        <br />
        <span class="rowitem__detail truncate">
          {j.detail || j.needs || tildePath(j.cwd, workspace.home)}
        </span>
      </span>
      <span class="rowitem__meta">
        {
          /* "Waiting for you" and "was waiting for you, months ago, and
            nothing is running it" ask completely different things of the
            reader, and the state pill alone said the same for both. */
        }
        {j.stale
          ? (
            <span title="No background service is running this any more">
              <Pill>leftover</Pill>
            </span>
          )
          : <StatePill state={j.state} />}
        <br />
        {j.updatedAt > 0 ? ago(j.updatedAt, props.now) : "—"}
      </span>
    </button>
  );
}

/** One field of a job's detail. A fragment, not a wrapper: `.kv` is the grid,
 *  and a div per pair would give every row its own columns to align in. */
const Row = (props: { k: string; v: unknown }): VNode => (
  <>
    <span class="kv__k">{props.k}</span>
    <span class="kv__v">{props.v}</span>
  </>
);

function JobDetail(props: { job: Job; now: number }): VNode {
  const j = props.job;
  const busy = jobs.busyId === j.id;
  const shortCwd = tildePath(j.cwd, workspace.home);
  // Removing a job deletes a whole background conversation through the CLI's
  // own subcommand, and there is no undo for it. Every other one-click
  // destructive action in this app is reversible — a removed project comes
  // back from the dock — so this one arms instead. Two clicks, and the second
  // says what it does rather than asking "are you sure?".
  const [armed, setArmed] = useLocal(false);
  // …and the second escape hatch, which needs its own arming for a different
  // reason: it does not go through the CLI at all.
  const [armedForget, setArmedForget] = useLocal(false);

  return (
    <div class="grid">
      <Panel
        title={j.name}
        actions={
          <>
            <StatePill state={j.state} />
            {j.state === "working" && (
              <button
                type="button"
                class="btn btn--sm"
                disabled={busy}
                title="Stop this background session — its conversation is kept"
                onClick={() => jobs.act(j.id, "stop")}
              >
                {IconPower({ size: 14 })} Stop
              </button>
            )}
            {j.state !== "working" && (
              <button
                type="button"
                class="btn btn--sm"
                disabled={busy || !cliCanRemove()}
                title={cliCanRemove()
                  ? "Restart it under the current CLI version"
                  : "Respawning goes through the background service, and none is running"}
                onClick={() => jobs.act(j.id, "respawn")}
              >
                {IconRefresh({ size: 14 })} Respawn
              </button>
            )}
            {armed
              ? (
                <>
                  <button
                    type="button"
                    class="btn btn--sm btn--danger"
                    disabled={busy}
                    onClick={() => {
                      setArmed(false);
                      jobs.act(j.id, "remove");
                    }}
                  >
                    {IconTrash({ size: 14 })} Delete this conversation
                  </button>
                  <button
                    type="button"
                    class="btn btn--ghost btn--sm"
                    onClick={() => setArmed(false)}
                  >
                    Cancel
                  </button>
                </>
              )
              : (
                <button
                  type="button"
                  class="btn btn--ghost btn--sm btn--icon"
                  disabled={busy}
                  title="Delete this background session for good — there is no undo"
                  aria-label={`Remove ${j.name}`}
                  onClick={() => setArmed(true)}
                >
                  {IconTrash({ size: 14 })}
                </button>
              )}
          </>
        }
      >
        {
          /* The state the CLI cannot get out of. `claude stop` and `claude rm`
            confirm their work through the background service, so with none
            running they refuse — and a job whose daemon exited weeks ago says
            "waiting for you" forever, with no button that removes it. This is
            the way out, and it says exactly what it does. */
        }
        {j.stale && (
          <Banner tone="warn">
            <strong>Nothing is running this any more.</strong>{" "}
            The background service that owned it has exited, so its own
            <code>claude stop</code> and <code>claude rm</code>{" "}
            cannot confirm anything and refuse. What is left is the record on
            disk.
            {armedForget
              ? (
                <span
                  style={{
                    display: "inline-flex",
                    gap: "6px",
                    marginLeft: "8px",
                  }}
                >
                  <button
                    type="button"
                    class="btn btn--sm btn--danger"
                    disabled={busy}
                    onClick={() => {
                      setArmedForget(false);
                      void jobs.forget(j.id);
                    }}
                  >
                    {IconTrash({ size: 13 })} Remove the record
                  </button>
                  <button
                    type="button"
                    class="btn btn--ghost btn--sm"
                    onClick={() => setArmedForget(false)}
                  >
                    Cancel
                  </button>
                </span>
              )
              : (
                <button
                  type="button"
                  class="btn btn--sm"
                  style={{ marginLeft: "8px" }}
                  disabled={busy}
                  title="Delete ~/.claude/jobs/{id} — the conversation and any worktree stay"
                  onClick={() => setArmedForget(true)}
                >
                  Clean it up
                </button>
              )}
          </Banner>
        )}

        {
          /* The reason this page exists, at the top of the page: what the job
            is waiting for, and the question it asked. Everything else about a
            blocked job is detail. */
        }
        {j.state === "blocked" && (j.needs || j.questions.length > 0) && (
          <Banner tone="warn">
            <strong>Waiting for an answer.</strong> {j.needs}
            {j.questions.length > 0 && (
              <ul style={{ margin: "6px 0 0", paddingLeft: "1.1em" }}>
                {j.questions.map((q, i) => <li key={i}>{q}</li>)}
              </ul>
            )}
            <div
              style={{
                marginTop: "8px",
                fontSize: "12px",
                color: "var(--ink-soft)",
              }}
            >
              Answer it with <code class="mono">claude attach {j.id}</code>{" "}
              — a background session is a conversation, and this app drives a
              different one.
            </div>
          </Banner>
        )}

        <div class="kv">
          <Row k="Id" v={<code class="mono">{j.id}</code>} />
          <Row k="State" v={j.detail || j.state} />
          <Row
            k="Directory"
            v={<code class="mono" title={j.cwd}>{shortCwd}</code>}
          />
          {j.model && <Row k="Model" v={<code class="mono">{j.model}</code>} />}
          <Row k="Tokens" v={tokens(j.tokens)} />
          {(j.inFlight.tasks > 0 || j.inFlight.queued > 0) && (
            <Row
              k="In flight"
              v={`${j.inFlight.tasks} running · ${j.inFlight.queued} queued`}
            />
          )}
          {j.cliVersion && <Row k="Started on" v={`CLI ${j.cliVersion}`} />}
          {j.createdAt > 0 && (
            <Row
              k="Created"
              v={`${clock(j.createdAt)} · ${ago(j.createdAt, props.now)}`}
            />
          )}
          {j.updatedAt > 0 && (
            <Row k="Last moved" v={ago(j.updatedAt, props.now)} />
          )}
          {j.sessionId && (
            <Row
              k="Session"
              v={<code class="mono">{j.sessionId}</code>}
            />
          )}
        </div>
      </Panel>

      {j.intent && j.intent !== j.name && (
        <Panel title="Started with">
          <div class="bubble bubble--user">{j.intent}</div>
        </Panel>
      )}

      <Panel flush title={`Timeline · ${j.timeline.length}`}>
        {j.timeline.length === 0
          ? (
            <Empty
              icon={IconJobs({ size: 20 })}
              title="Nothing recorded yet"
              hint="A background session writes a timeline entry each time it changes state."
            />
          )
          : (
            <div class="rowlist">
              {/* Newest first here, unlike the file, which appends. */}
              {j.timeline.slice().reverse().map((e, i) => (
                <div key={i} class="rowitem">
                  <span class="rowitem__icon">
                    <StatePill state={e.state} />
                  </span>
                  <span class="truncate">
                    <span class="rowitem__title">{e.detail || e.state}</span>
                    {e.text && (
                      <>
                        <br />
                        <span class="rowitem__detail">
                          {oneLine(e.text, 200)}
                        </span>
                      </>
                    )}
                  </span>
                  <span class="rowitem__meta">{clock(e.at)}</span>
                </div>
              ))}
            </div>
          )}
      </Panel>
    </div>
  );
}

export function JobsPage(): VNode {
  const [query, setQuery] = useLocal("");
  // A job's age is the figure that moves while you look at it; nothing else on
  // this page ticks, so the clock is slow.
  const now = useNow(true, 5_000);

  const all = jobs.jobs.filter((j) =>
    matches(query, j.name, j.intent, j.detail, j.cwd, j.needs)
  );
  const sorted = all.slice().sort((a, b) =>
    RANK[a.state] - RANK[b.state] || b.updatedAt - a.updatedAt
  );
  const current = selectedJob();
  const stale = staleJobs();
  const [armedAll, setArmedAll] = useLocal(false);
  const blocked = jobs.jobs.filter((j) => j.state === "blocked").length;
  const working = jobs.jobs.filter((j) => j.state === "working").length;

  return (
    <div class="page">
      <PageHead
        scope="machine"
        title="Jobs"
        sub={jobs.jobs.length === 0
          ? "No background sessions"
          : `${working} working · ${blocked} waiting on you · ${jobs.jobs.length} total`}
        actions={
          <>
            <Search
              value={query}
              onChange={setQuery}
              label="Filter jobs"
              placeholder="Filter jobs…"
            />
            <button
              type="button"
              class="btn btn--ghost btn--sm btn--icon"
              title="Re-read background sessions now"
              aria-label="Refresh jobs"
              onClick={() => jobs.refresh()}
            >
              {IconRefresh({ size: 15 })}
            </button>
          </>
        }
      />
      <div class="page__body grid">
        {jobs.error && <Banner tone="warn">{jobs.error}</Banner>}

        {
          /* Said once, at the top, because it explains every button on this
            page that will not work. The service runs on demand and exits when
            idle, so "not running" is ordinary — what is not ordinary is that
            stop and remove go *through* it and refuse without it. */
        }
        {stale.length > 0 && (
          <Banner tone="warn">
            <strong>
              {stale.length === 1
                ? "One job is a leftover."
                : `${stale.length} jobs are leftovers.`}
            </strong>{" "}
            They say they are working or waiting, and no background service is
            running to be doing it — so the CLI's own <code>stop</code> and{" "}
            <code>rm</code>{" "}
            cannot confirm anything and refuse. Removing the record is the only
            thing left that works.
            {armedAll
              ? (
                <span
                  style={{
                    display: "inline-flex",
                    gap: "6px",
                    marginLeft: "8px",
                  }}
                >
                  <button
                    type="button"
                    class="btn btn--sm btn--danger"
                    onClick={() => {
                      setArmedAll(false);
                      for (const j of stale) void jobs.forget(j.id);
                    }}
                  >
                    {IconTrash({ size: 13 })} Remove {stale.length}{" "}
                    record{stale.length === 1 ? "" : "s"}
                  </button>
                  <button
                    type="button"
                    class="btn btn--ghost btn--sm"
                    onClick={() => setArmedAll(false)}
                  >
                    Cancel
                  </button>
                </span>
              )
              : (
                <button
                  type="button"
                  class="btn btn--sm"
                  style={{ marginLeft: "8px" }}
                  title="Delete their entries under ~/.claude/jobs. Conversations and worktrees stay."
                  onClick={() => setArmedAll(true)}
                >
                  Clean them up
                </button>
              )}
          </Banner>
        )}

        {jobs.jobs.length === 0
          ? (
            <Panel>
              <Empty
                icon={IconJobs({ size: 20 })}
                title="No background sessions"
                hint="A session started with claude --bg keeps working after its terminal closes. Every one shows up here — including the ones that stopped to ask a question and are still waiting."
              />
            </Panel>
          )
          : (
            <>
              <Panel flush title={`${sorted.length} shown`}>
                {sorted.length === 0
                  ? (
                    <Empty
                      icon={IconJobs({ size: 20 })}
                      title="Nothing matches"
                      hint="No background session matches that filter."
                    />
                  )
                  : (
                    <div class="rowlist">
                      {sorted.map((j) => (
                        <JobRow
                          key={j.id}
                          job={j}
                          selected={current?.id === j.id}
                          now={now}
                        />
                      ))}
                    </div>
                  )}
              </Panel>

              {current ? <JobDetail job={current} now={now} /> : (
                <Panel>
                  <Empty
                    icon={IconX({ size: 20 })}
                    title="Pick a job"
                    hint="Its prompt, its directory, what it is waiting for, and everything it has done so far."
                  />
                </Panel>
              )}
            </>
          )}
      </div>
    </div>
  );
}
