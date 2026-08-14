/**
 * @module
 * Activity — one line per thing that happened, newest first. This is the page
 * you leave open on a second monitor while a long turn runs.
 */
import { useLocal, type VNode } from "aio/air";
import { session } from "../cell/session.ts";
import type { ActivityItem } from "../type/claude.ts";
import { ago, clock } from "../lib/format.ts";
import { Empty, Panel, Segmented, useNow } from "./parts.tsx";
import { PageHead } from "./RunViews.tsx";
import {
  IconActivity,
  IconAgents,
  IconAlert,
  IconModel,
  IconShield,
  IconTasks,
  IconTerminal,
} from "./icons.tsx";

type Channel = ActivityItem["channel"];

const CHANNELS: { id: Channel | "all"; label: string }[] = [
  { id: "all", label: "All" },
  { id: "agent", label: "Agents" },
  { id: "tool", label: "Tools" },
  { id: "task", label: "Tasks" },
  { id: "permission", label: "Permissions" },
  { id: "error", label: "Errors" },
];

const ICON: Record<Channel, (p?: { size?: number }) => unknown> = {
  session: IconActivity,
  model: IconModel,
  tool: IconTerminal,
  agent: IconAgents,
  task: IconTasks,
  permission: IconShield,
  error: IconAlert,
};

const TONE: Record<Channel, string> = {
  session: "var(--ink-soft)",
  model: "var(--info)",
  tool: "var(--ink-soft)",
  agent: "var(--violet)",
  task: "var(--warn)",
  permission: "var(--accent)",
  error: "var(--danger)",
};

export function ActivityPage(): VNode {
  const [channel, setChannel] = useLocal<Channel | "all">("all");
  const now = useNow(session.status === "working", 1000);

  const items = session.activity
    .filter((a) => channel === "all" || a.channel === channel)
    .slice()
    .reverse();

  return (
    <div class="page">
      <PageHead
        title="Activity"
        sub={`${session.activity.length} events this session`}
        actions={
          <Segmented value={channel} options={CHANNELS} onChange={setChannel} />
        }
      />
      <div class="page__body">
        <Panel flush>
          {items.length === 0
            ? (
              <Empty
                icon={IconActivity({ size: 20 })}
                title="Nothing here yet"
                hint="Session lifecycle, every turn, every tool call and every task lands on this timeline as it happens."
              />
            )
            : (
              <div class="rowlist">
                {items.map((a) => (
                  <div key={a.id} class="rowitem">
                    <span
                      class="rowitem__icon"
                      style={{ color: TONE[a.channel] }}
                    >
                      {ICON[a.channel]({ size: 14 })}
                    </span>
                    <span class="truncate">
                      <span class="rowitem__title">{a.label}</span>
                      {a.detail && (
                        <>
                          <br />
                          <span class="rowitem__detail truncate">
                            {a.detail}
                          </span>
                        </>
                      )}
                    </span>
                    <span class="rowitem__meta">
                      {clock(a.at)}
                      <br />
                      {ago(a.at, now)}
                    </span>
                  </div>
                ))}
              </div>
            )}
        </Panel>
      </div>
    </div>
  );
}
