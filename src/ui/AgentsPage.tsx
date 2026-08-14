/**
 * @module
 * Sub-agents — every `Task`-family tool call this session has spawned, running
 * or finished, with the full prompt and result behind each one.
 */
import { useLocal, type VNode } from "aio/air";
import { agentRuns, runningAgents } from "../cell/session.ts";
import { Empty, Panel, Segmented } from "./parts.tsx";
import { NoSelection, PageHead, RunDetail, RunList } from "./RunViews.tsx";
import { IconAgents } from "./icons.tsx";

export function AgentsPage(): VNode {
  // `null` is "nobody has chosen yet". A choice is then always honoured — the
  // auto-pick used to override it, so clicking Running with nothing running
  // left the button dead under the cursor.
  const [filter, setFilter] = useLocal<"running" | "all" | null>(null);
  const [selected, setSelected] = useLocal<string | null>(null);

  const all = agentRuns();
  const running = runningAgents();
  // "Running" is the useful default — until nothing is running, when an empty
  // page would be a worse answer than the history.
  const effective = filter ?? (running.length > 0 ? "running" : "all");
  const runs = (effective === "running" ? running : all).slice().reverse();
  const current = all.find((r) => r.id === selected) ?? runs[0] ?? null;

  return (
    <div class="page">
      <PageHead
        title="Sub-agents"
        sub={`${running.length} running · ${all.length} this session`}
        actions={
          <Segmented
            value={effective}
            options={[{ id: "running", label: "Running" }, {
              id: "all",
              label: "All",
            }]}
            onChange={setFilter}
          />
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
                <RunList
                  runs={runs}
                  selectedId={current?.id ?? null}
                  onSelect={setSelected}
                />
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
