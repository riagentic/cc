/**
 * @module
 * Sub-agents — every `Task`-family tool call this session has spawned, running
 * or finished, with the full prompt and result behind each one.
 */
import { useLocal, type VNode } from "aio/air";
import { agentRuns, runningAgents } from "../cell/session.ts";
import { Empty, matches, Panel, Search, Segmented } from "./parts.tsx";
import { NoSelection, PageHead, RunDetail, RunList } from "./RunViews.tsx";
import { IconAgents } from "./icons.tsx";

export function AgentsPage(): VNode {
  // `null` is "nobody has chosen yet". A choice is then always honoured — the
  // auto-pick used to override it, so clicking Running with nothing running
  // left the button dead under the cursor.
  const [filter, setFilter] = useLocal<"running" | "all" | null>(null);
  const [selected, setSelected] = useLocal<string | null>(null);
  const [query, setQuery] = useLocal("");

  const all = agentRuns();
  const running = runningAgents();
  // "Running" is the useful default — until nothing is running, when an empty
  // page would be a worse answer than the history.
  const effective = filter ?? (running.length > 0 ? "running" : "all");
  const runs = (effective === "running" ? running : all)
    .filter((r) => matches(query, r.title, r.detail, r.agent?.type ?? ""))
    .slice()
    .reverse();
  // The selection has to come from what is *shown*: keeping a run that the
  // current filter excludes put a detail panel on screen with no row beside it.
  const current = runs.find((r) => r.id === selected) ?? runs[0] ?? null;

  return (
    <div class="page">
      <PageHead
        scope="session"
        title="Sub-agents"
        sub={`${running.length} running · ${all.length} this session`}
        actions={
          <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
            <Search
              value={query}
              onChange={setQuery}
              label="Filter sub-agents"
              placeholder="Filter agents…"
            />
            <Segmented
              value={effective}
              options={[{ id: "running", label: "Running" }, {
                id: "all",
                label: "All",
              }]}
              onChange={setFilter}
            />
          </div>
        }
      />
      <div class="page__body">
        {all.length === 0
          ? (
            <Panel>
              <Empty
                icon={IconAgents({ size: 20 })}
                title="No sub-agents yet"
                hint="When Claude Code delegates with the Task tool, every sub-agent appears here with its prompt, its progress and its result."
              />
            </Panel>
          )
          : (
            <div class="split">
              <Panel flush title={`${runs.length} shown`}>
                {runs.length === 0
                  ? (
                    <Empty
                      icon={IconAgents({ size: 20 })}
                      title="Nothing matches"
                      hint="No sub-agent in this view matches that filter — clear it, or switch to All."
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
                  icon={IconAgents({ size: 20 })}
                  what="sub-agent"
                />
              )}
            </div>
          )}
      </div>
    </div>
  );
}
