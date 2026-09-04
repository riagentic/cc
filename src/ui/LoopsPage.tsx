/**
 * @module
 * Loops — prompts this app re-sends on an interval.
 *
 * The page is deliberately explicit about the two things a scheduled prompt can
 * quietly get wrong: *when it will next fire*, and *which project it will fire
 * into*. Both are shown on every row, because a loop that silently retargets or
 * silently stops is worse than no loop at all.
 */
import { useLocal, type VNode } from "aio/air";
import { loops, MIN_EVERY_SEC, projectLoops } from "../cell/loops.ts";
import { view } from "../cell/session.ts";
import { activeProject } from "../cell/workspace.ts";
import type { Loop } from "../type/claude.ts";
import { ago, clock, duration, until } from "../lib/format.ts";
import { Banner, Empty, Panel, Pill, useNow } from "./parts.tsx";
import { PageHead } from "./RunViews.tsx";
import {
  IconLoop,
  IconPause,
  IconPlay,
  IconPlus,
  IconTrash,
} from "./icons.tsx";

/** The intervals worth one click. Anything else is typed. */
const PRESETS: { label: string; sec: number }[] = [
  { label: "1m", sec: 60 },
  { label: "5m", sec: 300 },
  { label: "15m", sec: 900 },
  { label: "1h", sec: 3_600 },
  { label: "6h", sec: 21_600 },
];

/** `everySec` as something readable. `duration` already does exactly this for
 *  milliseconds, and a second unit for the same idea would drift from it. */
const every = (sec: number): string => duration(sec * 1_000);

function LoopRow(props: { loop: Loop; now: number }): VNode {
  const l = props.loop;
  const open = l.runs[0] && l.runs[0].ok === null;

  return (
    <div class="rowitem">
      <span class="rowitem__icon">{IconLoop({ size: 15 })}</span>
      <span class="truncate">
        <span class="rowitem__title">{l.prompt}</span>
        <br />
        <span class="rowitem__detail">
          every {every(l.everySec)}
          {" · "}
          {l.paused
            ? "paused"
            : open
            ? "running now"
            : l.nextAt > 0
            ? `next ${until(l.nextAt, props.now)}`
            : "not scheduled"}
          {l.runs.length > 0 &&
            ` · ${l.runs.length} run${l.runs.length > 1 ? "s" : ""}`}
        </span>
      </span>
      <span class="rowitem__meta" style={{ display: "flex", gap: "4px" }}>
        {open
          ? <Pill tone="accent">running</Pill>
          : l.paused
          ? <Pill>paused</Pill>
          : <Pill tone="ok">armed</Pill>}
        <button
          type="button"
          class="btn btn--ghost btn--sm btn--icon"
          title={l.paused ? "Resume this loop" : "Pause this loop"}
          aria-label={l.paused ? `Resume ${l.prompt}` : `Pause ${l.prompt}`}
          onClick={() => loops.toggle(l.id)}
        >
          {l.paused ? IconPlay({ size: 14 }) : IconPause({ size: 14 })}
        </button>
        <button
          type="button"
          class="btn btn--ghost btn--sm"
          disabled={l.paused}
          title="Run this one now, without changing its schedule"
          onClick={() => loops.runNow(l.id)}
        >
          Now
        </button>
        <button
          type="button"
          class="btn btn--ghost btn--sm btn--icon"
          title="Delete this loop"
          aria-label={`Delete ${l.prompt}`}
          onClick={() => loops.remove(l.id)}
        >
          {IconTrash({ size: 14 })}
        </button>
      </span>
    </div>
  );
}

/** A loop's run history — what it actually did each time, not just that it
 *  fired. A schedule with no record of its results is a promise, not a report. */
function History(props: { loops: Loop[]; now: number }): VNode | null {
  const runs = props.loops
    .flatMap((l) => l.runs.map((r) => ({ ...r, prompt: l.prompt })))
    .sort((a, b) => b.at - a.at)
    .slice(0, 60);
  if (runs.length === 0) return null;

  return (
    <Panel flush title={`Runs · ${runs.length}`}>
      <div class="rowlist">
        {runs.map((r, i) => (
          <div key={`${r.at}-${i}`} class="rowitem">
            <span class="rowitem__icon">
              {r.ok === null
                ? <Pill tone="accent">·</Pill>
                : r.ok
                ? <Pill tone="ok">✓</Pill>
                : <Pill tone="danger">✕</Pill>}
            </span>
            <span class="truncate">
              <span class="rowitem__title truncate">{r.summary}</span>
              <br />
              <span class="rowitem__detail truncate">{r.prompt}</span>
            </span>
            <span class="rowitem__meta">
              {clock(r.at)}
              <br />
              {r.endedAt !== null
                ? duration(r.endedAt - r.at)
                : ago(r.at, props.now)}
            </span>
          </div>
        ))}
      </div>
    </Panel>
  );
}

function NewLoop(): VNode {
  const [prompt, setPrompt] = useLocal("");
  const [sec, setSec] = useLocal(300);

  const submit = () => {
    if (!prompt.trim()) return;
    void loops.add(prompt, sec);
    setPrompt("");
  };

  return (
    <Panel title="New loop">
      <div style={{ display: "grid", gap: "10px" }}>
        <textarea
          class="input"
          rows={2}
          value={prompt}
          aria-label="Loop prompt"
          placeholder="Run the tests and fix anything red"
          onInput={(e) => setPrompt((e.target as HTMLTextAreaElement).value)}
          // Enter alone inserts a newline: a loop prompt is often several
          // sentences, and losing one to a stray Enter is the worse mistake.
          onKeyDown={(e: KeyboardEvent) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit();
          }}
        />
        <div
          style={{
            display: "flex",
            gap: "6px",
            alignItems: "center",
            flexWrap: "wrap",
          }}
        >
          <span
            key="every"
            style={{ fontSize: "12px", color: "var(--ink-dim)" }}
          >
            Every
          </span>
          {PRESETS.map((p) => (
            <button
              key={p.label}
              type="button"
              class={`btn btn--sm${sec === p.sec ? "" : " btn--ghost"}`}
              onClick={() => setSec(p.sec)}
            >
              {p.label}
            </button>
          ))}
          <input
            key="seconds"
            class="input"
            type="number"
            min={MIN_EVERY_SEC}
            value={sec}
            aria-label="Interval in seconds"
            style={{ width: "92px" }}
            onInput={(e) =>
              setSec(Number((e.target as HTMLInputElement).value) || sec)}
          />
          <span
            key="unit"
            style={{ fontSize: "12px", color: "var(--ink-dim)" }}
          >
            seconds
          </span>
          <span key="spacer" style={{ flex: 1 }} />
          <button
            key="save"
            type="button"
            class="btn btn--sm"
            disabled={!prompt.trim()}
            onClick={submit}
          >
            {IconPlus({ size: 14 })} Add loop
          </button>
        </div>
      </div>
    </Panel>
  );
}

export function LoopsPage(): VNode {
  const now = useNow(true, 1_000);
  const mine = projectLoops();
  const project = activeProject();
  const armed = mine.filter((l) => !l.paused).length;
  const elsewhere = loops.loops.length - mine.length;

  return (
    <div class="page">
      <PageHead
        scope="project"
        title="Loops"
        sub={mine.length === 0
          ? "No loops for this project"
          : `${armed} armed · ${mine.length} total`}
      />
      <div class="page__body grid">
        {loops.error && <Banner tone="warn">{loops.error}</Banner>}

        {
          /* Said plainly rather than left to be discovered: a loop cannot fire
            while a turn is running, and it cannot fire into a project it does
            not belong to. Both are the right behaviour and both look like a
            bug if they are not stated. */
        }
        {armed > 0 && view().status === "working" && (
          <Banner tone="warn">
            A turn is in flight — due loops wait for it and fire on the next
            tick. They are never queued behind one another.
          </Banner>
        )}

        <NewLoop />

        {mine.length === 0
          ? (
            <Panel>
              <Empty
                icon={IconLoop({ size: 20 })}
                title={project
                  ? `No loops for ${project.name}`
                  : "No project selected"}
                hint="A loop re-sends the same prompt on an interval — a standing check on the tests, the build, or an inbox. It belongs to one project and only ever fires into that one."
              />
            </Panel>
          )
          : (
            <Panel flush title={`Loops · ${mine.length}`}>
              <div class="rowlist">
                {mine.map((l) => <LoopRow key={l.id} loop={l} now={now} />)}
              </div>
            </Panel>
          )}

        {elsewhere > 0 && (
          <div style={{ fontSize: "12px", color: "var(--ink-dim)" }}>
            {elsewhere} loop{elsewhere > 1 ? "s" : ""}{" "}
            belong to other projects. They fire only when that project is the
            one selected.
          </div>
        )}

        <History loops={mine} now={now} />
      </div>
    </div>
  );
}
