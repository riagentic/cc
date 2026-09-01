/**
 * @module
 * The always-visible status strip: what Claude Code is pointed at, what it is
 * running on, how much room is left in the window, and what it is doing right
 * now. Everything here is measured, never assumed — the one estimated figure
 * (the context window, before the first result lands) is labelled as such.
 */
import type { VNode } from "aio/air";
import { view } from "../cell/session.ts";
import {
  busyTaskCount,
  contextUsed,
  contextWindow,
  pendingPermissions,
  runningAgents,
} from "../cell/session.ts";
import { activeProject, activeSettings, workspace } from "../cell/workspace.ts";
import { pct, tildePath, tokens, until, usd } from "../lib/format.ts";
import { Dot, Elapsed, Meter, Pill, Stat, useNow } from "./parts.tsx";
import {
  IconAgents,
  IconAlert,
  IconBranch,
  IconClock,
  IconCoins,
  IconFolder,
  IconModel,
  IconShield,
  IconTasks,
  IconThinking,
} from "./icons.tsx";

export function StatusStrip(): VNode {
  const project = activeProject();
  const used = contextUsed();
  const max = contextWindow();
  const measured = view().turns > 0;
  const agents = runningAgents().length;
  const tasks = busyTaskCount();
  const holds = pendingPermissions().length;
  // The fullest window the CLI has reported. It was only ever visible on the
  // Settings page, without its reset time — so the thing most likely to stop
  // the next turn was the one figure the status strip did not carry.
  const limit = view().rateLimit;
  const worst = limit?.windows[0] ?? null;
  const pressure = Math.max(limit?.utilization ?? 0, worst?.utilization ?? 0);
  const tight = pressure >= 0.8 || limit?.overage === true;
  const now = useNow(tight, 30_000);
  // A live session keeps the directory it was started in, and switching project
  // only takes effect on the next start. "Project: B" while the process works in
  // A is the one lie this row can tell, so the difference is marked rather than
  // hidden — the strip is where the session is read from at a glance.
  const elsewhere = view().cwd !== null && view().cwd !== project?.path &&
    view().status !== "offline" && view().status !== "error";

  return (
    <div class="strip">
      <Stat label="Project" clamp title={project?.path}>
        {IconFolder({ size: 14 })}
        <span class="truncate">
          {project ? tildePath(project.path, workspace.home) : "None"}
        </span>
        {elsewhere && (
          <span
            class="pill pill--warn"
            style={{ padding: "1px 7px" }}
            title={`The running session is in ${view().cwd} — a project switch takes effect on the next start`}
          >
            session elsewhere
          </span>
        )}
      </Stat>

      <Stat
        label="Branch"
        title={project?.dirty ? "Uncommitted changes" : undefined}
      >
        {IconBranch({ size: 14 })}
        <span class="truncate">{project?.branch ?? "—"}</span>
        {project?.dirty && (
          <span class="pill pill--warn" style={{ padding: "1px 7px" }}>
            dirty
          </span>
        )}
      </Stat>

      <Stat label="Model">
        {IconModel({ size: 14 })}
        <span class="truncate">{view().model ?? activeSettings().model}</span>
      </Stat>

      <Stat
        label={measured ? "Context" : "Context (est.)"}
        grow
        numeric
        title={measured
          ? "Tokens resident in the context window after the last request"
          : "Window size is the model default until the first turn reports it"}
      >
        <div style={{ width: "100%", display: "grid", gap: "3px" }}>
          <div style={{ display: "flex", gap: "8px", alignItems: "baseline" }}>
            <span>{tokens(used)}</span>
            <span style={{ color: "var(--ink-dim)" }}>/ {tokens(max)}</span>
            <span style={{ flex: 1 }} />
            <span style={{ color: "var(--ink-dim)" }}>
              {pct(used, max).toFixed(pct(used, max) < 10 ? 1 : 0)}%
            </span>
          </div>
          <Meter value={used} max={max} />
        </div>
      </Stat>

      <Stat label="Agents" numeric>
        {IconAgents({ size: 14 })}
        <span>{agents}</span>
      </Stat>

      <Stat label="Tasks" numeric>
        {IconTasks({ size: 14 })}
        <span>{tasks}</span>
      </Stat>

      <Stat
        label={view().turnStartedAt !== null ? "Running" : "Last turn"}
        numeric
        title="Processing time of the most recent request"
      >
        {IconClock({ size: 14 })}
        <Elapsed
          startedAt={view().turnStartedAt}
          fallbackMs={view().lastTurnMs}
        />
      </Stat>

      <Stat label="Cost" numeric title="Session total reported by the CLI">
        {IconCoins({ size: 14 })}
        <span>{usd(view().cost)}</span>
      </Stat>

      <Stat label="Session">
        <Dot status={view().status} />
        <span class="truncate">
          {holds > 0 ? "waiting for you" : view().status}
        </span>
        {view().queuedTurns > 0 && (
          <span
            class="pill"
            style={{ padding: "1px 7px" }}
            title="Turns the CLI is holding behind the one in flight"
          >
            +{view().queuedTurns} queued
          </span>
        )}
      </Stat>

      {
        /* Thinking is the one number that moves during a long turn. Shown only
          while it is moving — an idle strip should carry nothing spurious. */
      }
      {view().thinkingTokens > 0 && view().status === "working" && (
        <Stat
          label="Thinking"
          numeric
          title="The CLI's running token estimate for the reasoning in this turn"
        >
          {IconThinking({ size: 14 })}
          <span>{tokens(view().thinkingTokens)}</span>
        </Stat>
      )}

      {tight && limit && (
        <Stat
          label="Usage limit"
          numeric
          title={`${
            worst ? worst.name.replace("_", "-") : limit.type.replace("_", "-")
          } window · ${limit.status}${
            limit.overage ? " · billed as overage" : ""
          }${
            worst && worst.resetsAt > 0
              ? ` · resets ${until(worst.resetsAt, now)}`
              : ""
          }`}
        >
          <Pill tone={pressure >= 0.95 ? "danger" : "warn"}>
            {IconAlert({ size: 11 })} {Math.round(pressure * 100)}%
          </Pill>
        </Stat>
      )}

      {holds > 0 && (
        <Stat
          label="Approval"
          title="Claude Code is blocked until you answer — the prompt is above this page, wherever you are"
        >
          <Pill tone="warn">
            {IconShield({ size: 11 })} {holds} to answer
          </Pill>
        </Stat>
      )}

      {activeSettings().skipPermissions && (
        <Stat
          label="Permissions"
          title="Running with --dangerously-skip-permissions: every check is off"
        >
          <Pill tone="danger">{IconAlert({ size: 11 })} all allowed</Pill>
        </Stat>
      )}
    </div>
  );
}
