/**
 * @module
 * Shared master–detail views over tool runs — used by the sub-agent and task
 * pages, which differ only in what they select and how they title it.
 */
import type { VNode } from "aio/air";
import { agentSteps, view } from "../cell/session.ts";
import type { ToolRun } from "../type/claude.ts";
import { ago, clock, duration, oneLine, tokens } from "../lib/format.ts";
import { Copy, Empty, Panel, Pill, useNow } from "./parts.tsx";
import { Markdown } from "./Markdown.tsx";
import { IconCheck, IconShield, IconX, toolIcon } from "./icons.tsx";

/**
 * What a page is *about*, stated on the page.
 *
 * Three of these sections are machine-wide and the rest are not, and nothing on
 * screen used to say which was which — so Jobs (every background session on the
 * machine, each in its own directory) sat next to Loops (this project only)
 * looking exactly alike. The rail groups pages by what they are FOR, which is
 * the right way to find one and the wrong way to know what it covers.
 */
export type PageScope = "session" | "project" | "machine";

const SCOPE_TEXT: Record<PageScope, { label: string; title: string }> = {
  session: {
    label: "this session",
    title: "This project's running Claude Code session. Ends when it does.",
  },
  project: {
    label: "this project",
    title:
      "The project selected on the left. Each project has its own, and they are remembered separately.",
  },
  machine: {
    label: "this machine",
    title:
      "Everything on this machine, across every project — not just the one selected.",
  },
};

/** The tag itself, so a panel on a mixed page can carry its own — Settings has
 *  all three scopes on it, and one tag on the title would be a lie about two. */
export function ScopeTag(props: { scope: PageScope }): VNode {
  const scope = SCOPE_TEXT[props.scope];
  return (
    <span class={`scopetag scopetag--${props.scope}`} title={scope.title}>
      {scope.label}
    </span>
  );
}

export function PageHead(
  props: {
    title: string;
    sub?: string;
    scope?: PageScope;
    actions?: unknown;
  },
): VNode {
  return (
    <div class="page__head">
      <h1 class="page__title">{props.title}</h1>
      {props.scope && <ScopeTag scope={props.scope} />}
      {props.sub && <span class="page__sub">{props.sub}</span>}
      <span style={{ flex: 1 }} />
      {props.actions}
    </div>
  );
}

/** Running / waiting / done / failed, at a glance. */
export function RunPill(props: { run: ToolRun }): VNode {
  const r = props.run;
  if (r.permissionId !== null) {
    return (
      <Pill tone="warn" icon={IconShield({ size: 11 })}>needs approval</Pill>
    );
  }
  if (r.endedAt === null) return <Pill tone="accent">running</Pill>;
  // Ended with no outcome: the session was stopped, or the process died under
  // it. The call neither succeeded nor failed, and "done" would be a guess in
  // the app's own favour — the one direction a status must never round.
  if (r.ok === null) return <Pill tone="warn">cut off</Pill>;
  return r.ok === false
    ? <Pill tone="danger" icon={IconX({ size: 11 })}>failed</Pill>
    : <Pill tone="ok" icon={IconCheck({ size: 11 })}>done</Pill>;
}

/** Wall-clock length of a run — ticking while it is still going. */
export function RunTime(props: { run: ToolRun }): VNode {
  const r = props.run;
  const now = useNow(r.endedAt === null, 200);
  return <span>{duration((r.endedAt ?? now) - r.startedAt)}</span>;
}

/** The second line of a run row: the tool's own name for a plain call, and for
 *  a sub-agent the thing worth knowing — what it is doing, or what it said. */
function subtitle(r: ToolRun): string {
  if (r.kind !== "agent") return r.name;
  const type = r.agent?.type ?? "agent";
  if (r.permissionId !== null) return `${type} · waiting for your approval`;
  if (r.endedAt !== null) {
    if (r.output) return `${type} · ${oneLine(r.output, 90)}`;
    return r.ok === null ? `${type} · cut off` : `${type} · finished`;
  }
  const steps = agentSteps(r.id);
  const live = steps.filter((t) => t.endedAt === null);
  if (live.length > 0) return `${type} · ${oneLine(live[0].title, 70)}`;
  return steps.length > 0
    ? `${type} · ${steps.length} step${steps.length > 1 ? "s" : ""} so far`
    : `${type} · starting…`;
}

export function RunList(
  props: {
    runs: ToolRun[];
    selectedId: string | null;
    onSelect: (id: string) => void;
  },
): VNode {
  return (
    <div class="rowlist">
      {props.runs.map((r) => (
        <button
          key={r.id}
          type="button"
          class={`rowitem${props.selectedId === r.id ? " selected" : ""}`}
          onClick={() => props.onSelect(r.id)}
        >
          <span
            class="rowitem__icon"
            style={r.endedAt === null
              ? { color: "var(--accent)" }
              : r.ok === false
              ? { color: "var(--danger)" }
              : {}}
          >
            {toolIcon(r.name, 14)}
          </span>
          <span class="truncate">
            <span class="rowitem__title truncate">{r.title}</span>
            <br />
            {
              /* What it is doing, not just what it is: the live step count and
                the answer once there is one. A list of spinners says nothing. */
            }
            <span class="rowitem__detail truncate">{subtitle(r)}</span>
          </span>
          <span class="rowitem__meta">
            {r.permissionId !== null
              ? <span style={{ color: "var(--warn)" }}>approval</span>
              : <RunTime run={r} />}
            <br />
            {clock(r.startedAt)}
          </span>
        </button>
      ))}
    </div>
  );
}

/** Everything known about one run — input, timing, output, and any transcript
 *  the sub-agent produced under it. */
export function RunDetail(props: { run: ToolRun }): VNode {
  const r = props.run;
  const nested = view().messages.filter((m) => m.parentToolUseId === r.id);
  const steps = agentSteps(r.id);
  const now = useNow(r.endedAt === null, 500);
  const held = r.permissionId !== null;

  return (
    <div class="grid">
      <Panel
        title={
          <span
            style={{ display: "inline-flex", alignItems: "center", gap: "8px" }}
          >
            {toolIcon(r.name, 15)} {r.name}
          </span>
        }
        actions={<RunPill run={r} />}
      >
        <div
          style={{ fontSize: "13.5px", fontWeight: 560, marginBottom: "8px" }}
        >
          {r.title}
        </div>
        {r.detail && (
          <div class="rowitem__detail" style={{ marginBottom: "10px" }}>
            {r.detail}
          </div>
        )}
        <div class="kv">
          {r.agent?.type && (
            <>
              <span class="kv__k">Agent</span>
              <span class="kv__v">{r.agent.type}</span>
            </>
          )}
          <span class="kv__k">Started</span>
          <span class="kv__v">
            {clock(r.startedAt)} · {ago(r.startedAt, now)}
          </span>
          <span class="kv__k">Duration</span>
          <span class="kv__v">
            <RunTime run={r} />
            {r.agent?.durationMs
              ? ` · ${duration(r.agent.durationMs)} reported by the CLI`
              : ""}
          </span>
          {r.agent?.tokens !== null && r.agent?.tokens !== undefined && (
            <>
              <span class="kv__k">Tokens</span>
              <span class="kv__v">{tokens(r.agent.tokens)}</span>
            </>
          )}
          {(r.agent?.toolUses ?? null) !== null && (
            <>
              <span class="kv__k">Tool calls</span>
              <span class="kv__v">
                {r.agent?.toolUses}
                {steps.length > 0 && steps.length !== r.agent?.toolUses
                  ? ` · ${steps.length} seen live`
                  : ""}
              </span>
            </>
          )}
          <span class="kv__k">Tool use id</span>
          <span class="kv__v mono">{r.id}</span>
          {r.taskId && (
            <>
              <span class="kv__k">Task</span>
              <span class="kv__v mono">{r.taskId}</span>
            </>
          )}
          {r.parentToolUseId && (
            <>
              <span class="kv__k">Parent</span>
              <span class="kv__v mono">{r.parentToolUseId}</span>
            </>
          )}
        </div>
      </Panel>

      {r.agent?.prompt && (
        <Panel title="Prompt" actions={<Copy text={r.agent.prompt} />}>
          <div class="code">{r.agent.prompt}</div>
        </Panel>
      )}

      {
        /* What the agent is doing *right now* — every tool it has called, live.
          Until this existed, a running sub-agent was a spinner and nothing else. */
      }
      {steps.length > 0 && (
        <Panel
          title={`Steps · ${steps.length}`}
          actions={
            <span class="rowitem__detail">
              {steps.filter((t) => t.endedAt === null).length} in flight
            </span>
          }
        >
          <div class="rowlist">
            {steps.map((t) => (
              <div key={t.id} class="rowitem" style={{ cursor: "default" }}>
                <span
                  class="rowitem__icon"
                  style={t.endedAt === null
                    ? { color: "var(--accent)" }
                    : t.ok === false
                    ? { color: "var(--danger)" }
                    : {}}
                >
                  {toolIcon(t.name, 14)}
                </span>
                <span class="truncate">
                  <span class="rowitem__title truncate">{t.title}</span>
                  <br />
                  <span class="rowitem__detail truncate">
                    {t.name}
                    {t.output ? ` · ${oneLine(t.output, 90)}` : ""}
                  </span>
                </span>
                <span class="rowitem__meta">
                  <RunTime run={t} />
                  <br />
                  {clock(t.startedAt)}
                </span>
              </div>
            ))}
          </div>
        </Panel>
      )}

      {r.output !== null && r.output !== "" && (
        <Panel
          title={r.ok === false
            ? "Error"
            : r.kind === "agent"
            ? "Returned"
            : "Result"}
          actions={<Copy text={r.output} />}
        >
          {r.kind === "agent" && r.ok !== false
            ? <Markdown source={r.output} />
            : <div class="code">{r.output}</div>}
        </Panel>
      )}

      {r.kind === "agent" && r.endedAt === null && r.output === null && !held &&
        (
          <Panel title="Returned">
            <div class="rowitem__detail">
              Still working — the result appears here the moment the agent
              reports back.
            </div>
          </Panel>
        )}

      {nested.length > 0 && (
        <Panel title={`Transcript · ${nested.length}`}>
          <div class="grid" style={{ gap: "8px" }}>
            {nested.map((m) => (
              <div key={m.id} class="code">
                {m.blocks
                  .map((b) =>
                    b.kind === "text" || b.kind === "thinking"
                      ? b.text
                      : b.kind === "tool"
                      ? `→ ${b.name}`
                      : ""
                  )
                  .filter(Boolean)
                  .join("\n")}
              </div>
            ))}
          </div>
        </Panel>
      )}

      <Panel
        title="Input"
        actions={<Copy text={JSON.stringify(r.input, null, 2)} />}
      >
        <div class="code">{JSON.stringify(r.input, null, 2)}</div>
      </Panel>
    </div>
  );
}

export function NoSelection(props: { icon: unknown; what: string }): VNode {
  return (
    <Panel>
      <Empty
        icon={props.icon}
        title={`Select a ${props.what}`}
        hint={`Pick one on the left to see its input, timing and result.`}
      />
    </Panel>
  );
}
