/**
 * @module
 * Activity — one line per thing that happened, newest first. This is the page
 * you leave open on a second monitor while a long turn runs.
 */
import { useLocal, type VNode } from "aio/air";
import { view } from "../cell/session.ts";
import type { ActivityItem } from "../type/claude.ts";
import { ago, clock } from "../lib/format.ts";
import { Empty, matches, Panel, Search, Segmented, useNow } from "./parts.tsx";
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
  const [query, setQuery] = useLocal("");
  // Ticking even when the session is idle. Gated on "working", the "4m ago"
  // column froze at whatever it said when some other state last re-rendered the
  // page — and this is the page people leave open precisely while nothing is
  // happening. Ten seconds is plenty for a relative clock and costs nothing.
  const now = useNow(true, view().status === "working" ? 1_000 : 10_000);

  const items = view().activity
    .filter((a) => channel === "all" || a.channel === channel)
    .filter((a) => matches(query, a.label, a.detail))
    .slice()
    .reverse();

  return (
    <div class="page">
      <PageHead
        scope="session"
        title="Activity"
        sub={query.trim() || channel !== "all"
          ? `${items.length} of ${view().activity.length} events`
          : `${view().activity.length} events this session`}
        actions={
          <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
            <Search
              value={query}
              onChange={setQuery}
              label="Filter events"
              placeholder="Filter events…"
            />
            <Segmented
              value={channel}
              options={CHANNELS}
              onChange={setChannel}
            />
          </div>
        }
      />
      <div class="page__body">
        <Panel flush>
          {items.length === 0
            ? (
              <Empty
                icon={IconActivity({ size: 20 })}
                title={query.trim() || channel !== "all"
                  ? "Nothing matches"
                  : "Nothing here yet"}
                hint={query.trim() || channel !== "all"
                  ? "No event on this timeline matches that filter — clear it to see them all."
                  : "Session lifecycle, every turn, every tool call and every task lands on this timeline as it happens."}
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
