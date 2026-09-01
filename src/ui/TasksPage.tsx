/**
 * @module
 * Tasks — two kinds, kept visibly distinct rather than merged into a lie:
 *
 *  • **Background tasks** the CLI reports (`run_in_background`, background
 *    agents). Authoritative: the CLI tells us when they start, change and end.
 *  • **Tool calls**, which are the work of the current turn. A call with no
 *    result yet is running.
 */
import { useLocal, type VNode } from "aio/air";
import { view } from "../cell/session.ts";
import {
  decidedPermissions,
  runningTasks,
  runningTools,
  toolRuns,
} from "../cell/session.ts";
import type { BackgroundTask } from "../type/claude.ts";
import { ago, clock, duration } from "../lib/format.ts";
import { Empty, matches, Panel, Pill, Search, useNow } from "./parts.tsx";
import { NoSelection, PageHead, RunDetail, RunList } from "./RunViews.tsx";
import { PermissionRow } from "./PermissionPrompt.tsx";
import { IconTasks, IconTerminal } from "./icons.tsx";

export function TasksPage(): VNode {
  const [selected, setSelected] = useLocal<string | null>(null);
  const [query, setQuery] = useLocal("");

  const all = toolRuns();
  const tools = all.filter((r) => matches(query, r.title, r.name, r.detail));
  const runs = tools.slice().reverse();
  const current = tools.find((r) => r.id === selected) ?? runs[0] ?? null;
  const busy = runningTools().length;
  const bg = view().tasks;
  const decided = decidedPermissions();

  return (
    <div class="page">
      <PageHead
        scope="session"
        title="Tasks"
        sub={`${runningTasks().length} background · ${busy} tool calls running`}
      />
      <div class="page__body grid">
        {
          /* Every approval this session has answered. A permission decision is a
            fact about what the agent was allowed to do — it deserves a record,
            not just a prompt that vanishes when it is clicked. */
        }
        {decided.length > 0 && (
          <Panel flush title={`Permission decisions · ${decided.length}`}>
            <div class="rowlist">
              {decided.map((p) => <PermissionRow key={p.id} request={p} />)}
            </div>
          </Panel>
        )}

        <Panel flush title={`Background tasks · ${bg.length}`}>
          {bg.length === 0
            ? (
              <Empty
                icon={IconTasks({ size: 20 })}
                title="No background tasks"
                hint="Long-running commands started with run_in_background, and background agents, appear here while they run."
              />
            )
            : (
              <div class="rowlist">
                {bg.slice().reverse().map((t) => (
                  <TaskRow
                    key={t.id}
                    task={t}
                  />
                ))}
              </div>
            )}
        </Panel>

        {all.length === 0
          ? (
            <Panel flush title="Tool calls">
              <Empty
                icon={IconTerminal({ size: 20 })}
                title="No tool calls yet"
                hint="Every Bash, Read, Edit and Grep call in this session lands here with its input and output."
              />
            </Panel>
          )
          : (
            <div class="split">
              <Panel
                flush
                title={query.trim()
                  ? `Tool calls · ${tools.length} of ${all.length}`
                  : `Tool calls · ${tools.length}`}
                actions={
                  <Search
                    value={query}
                    onChange={setQuery}
                    label="Filter tool calls"
                    placeholder="Filter calls…"
                  />
                }
              >
                {runs.length === 0
                  ? (
                    <Empty
                      icon={IconTerminal({ size: 20 })}
                      title="Nothing matches"
                      hint="No call in this session matches that filter — clear it to see them all."
                    />
                  )
                  : (
                    <RunList
                      runs={runs}
                      selectedId={current?.id ?? null}
                      onSelect={setSelected}
                    />
                  )}
              </Panel>
              {current ? <RunDetail run={current} /> : (
                <NoSelection
                  icon={IconTerminal({ size: 20 })}
                  what="tool call"
                />
              )}
            </div>
          )}
      </div>
    </div>
  );
}

function TaskRow(props: { task: BackgroundTask }): VNode {
  const t = props.task;
  const running = t.status === "running";
  const now = useNow(running, 500);
  return (
    <div class="rowitem">
      <span
        class="rowitem__icon"
        style={running ? { color: "var(--accent)" } : {}}
      >
        {IconTasks({ size: 14 })}
      </span>
      <span class="truncate">
        <span class="rowitem__title truncate">{t.description}</span>
        <br />
        <span class="rowitem__detail truncate">
          {t.type}
          {t.outputFile ? ` · ${t.outputFile}` : ""}
        </span>
      </span>
      <span
        class="rowitem__meta"
        style={{ display: "grid", gap: "3px", justifyItems: "end" }}
      >
        <Pill
          tone={running ? "accent" : t.status === "completed" ? "ok" : "warn"}
        >
          {t.status}
        </Pill>
        <span>
          {duration((t.endedAt ?? now) - t.startedAt)} · {clock(t.startedAt)}
        </span>
        <span>{ago(t.startedAt, now)}</span>
      </span>
    </div>
  );
}
