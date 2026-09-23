/**
 * @module
 * The always-visible status strip: what Claude Code is pointed at, what it is
 * running on, how much room is left in the window, and what it is doing right
 * now. Everything here is measured, never assumed — the one estimated figure
 * (the context window, before the first result lands) is labelled as such.
 */
import type { VNode } from "aio/air";
import { session, view } from "../cell/session.ts";
import {
  busyTaskCount,
  contextUsed,
  contextWindow,
  pendingPermissions,
  runningAgents,
} from "../cell/session.ts";
import { activeProject, activeSettings, workspace } from "../cell/workspace.ts";
import { EFFORTS, modelOf, MODELS, PERMISSION_MODES } from "../lib/stream.ts";
import { tokens, until, usd } from "../lib/format.ts";
import { Dot, Elapsed, Menu, Pill, Stat, useNow } from "./parts.tsx";
import { BranchStat, ContextStat, EngineStat, ProjectStat } from "./strip.tsx";
import {
  IconAgents,
  IconAlert,
  IconClock,
  IconCoins,
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
  // A live process was spawned with the effort and permission mode that were
  // set at the time, and changing either changes the NEXT session — so the
  // switchers say so instead of implying an effect they cannot have. The model
  // is the exception: it is switched on the running session (`useModel`).
  const running = view().status !== "offline" && view().status !== "error";
  const settings = activeSettings();
  // Both sides in the same vocabulary, deliberately: the CLI names the model in
  // full ("claude-haiku-4-5-20251001") and the picker names the family
  // ("haiku"), so comparing the raw strings called every session mismatched.
  const runningModel = modelOf(view().model);
  const chosenModel = modelOf(settings.model);
  const modePending = running && view().meta.permissionMode !== null &&
    view().meta.permissionMode !== settings.permissionMode;
  // A switch lands on the *next* turn, so a turn already in flight answers out
  // of the old model and says so. That gap is the one thing the model row can
  // still get wrong, so it is marked instead of being papered over.
  const behind = running && runningModel !== null && chosenModel !== null &&
    runningModel.id !== chosenModel.id;
  // This row is the CLI's. `App` swaps it for the local page's own strip the
  // moment the conversation on screen is answered by a local engine
  // (`activeIsLocal`), so a local branch HERE can never render: the pace,
  // run-as and capability pickers a local chat needs live on `LocalStrip` and
  // in Settings, where they are actually drawn.

  return (
    <div class="strip">
      {
        /* Project, branch, engine and model, in this order, on both engines'
          strips — see `strip.tsx`. Switching a project from Claude Code to a
          local model used to move every control on this row. */
      }
      <ProjectStat
        key="project"
        note={elsewhere && (
          <span
            class="pill pill--warn"
            style={{ padding: "1px 7px" }}
            title={`The running session is in ${view().cwd} — a project switch takes effect on the next start`}
          >
            session elsewhere
          </span>
        )}
      />
      <BranchStat key="branch" />
      <EngineStat key="engine" />

      {
        /* The three the strip used to only *report*. A control surface that
          shows which model is active and sends you elsewhere to change it is
          the exact complaint this app exists to answer — so each of these is
          the same list Settings offers, one click from where you read it.
          They apply to the NEXT session, which the trigger's title says and
          the strip marks below while one is running. */
      }
      <Stat key="model" label="Model">
        {IconModel({ size: 14 })}
        <Menu
          label="Model"
          value={activeSettings().model}
          title={running
            ? "Model for this session — a switch applies from the next turn"
            : "Model for the next session"}
          // The chosen model, named the way the picker names it — so choosing
          // from that picker changes what is written here. It used to be
          // whatever string the session last reported, which is how a `claude`
          // that had answered with a synthetic message ("You've reached your
          // Fable limit") left `<synthetic>` sitting here: a label no choice
          // the user made could budge. Where the two disagree is marked next
          // to it rather than substituted for it.
          trigger={chosenModel?.label ?? settings.model}
          options={MODELS.map((m) => ({
            id: m.id,
            label: m.label,
            hint: m.hint,
          }))}
          onChange={(id) => void session.useModel(id)}
          footer={running
            ? "Applies from the next turn — this session keeps its context."
            : undefined}
        />
        {behind && (
          <span
            class="pill pill--warn"
            style={{ padding: "1px 7px" }}
            title={`The running session last answered on ${runningModel?.label} — a switch applies from its next turn, so a turn already in flight finishes on the old model`}
          >
            on {runningModel?.label}
          </span>
        )}
      </Stat>

      <Stat key="effort" label="Effort">
        {IconThinking({ size: 14 })}
        <Menu
          label="Effort"
          value={activeSettings().effort}
          title="How hard the model works before it answers"
          trigger={EFFORTS.find((e) => e.id === settings.effort)?.label ??
            "Default"}
          options={EFFORTS.map((e) => ({
            id: e.id,
            label: e.label,
            hint: e.hint,
          }))}
          onChange={(id) => workspace.setEffort(id)}
          footer={running ? "Takes effect on the next session." : undefined}
        />
      </Stat>

      <Stat key="permissions" label="Permissions">
        {IconShield({ size: 14 })}
        <Menu
          label="Permission mode"
          value={activeSettings().permissionMode}
          title="What Claude Code may do without asking"
          trigger={PERMISSION_MODES.find((m) =>
            m.id === settings.permissionMode
          )
            ?.label ?? settings.permissionMode}
          options={PERMISSION_MODES.map((m) => ({
            id: m.id,
            label: m.label,
            hint: m.hint,
            tone: m.id === "bypassPermissions"
              ? ("danger" as const)
              : undefined,
          }))}
          onChange={(id) => workspace.setPermissionMode(id)}
          footer={modePending
            ? "The running session is on " +
              `${view().meta.permissionMode} — use Restart in Settings.`
            : running
            ? "Takes effect on the next session."
            : undefined}
        />
      </Stat>

      <ContextStat key="context" used={used} max={max} measured={measured} />

      <Stat key="agents" label="Agents" numeric minor>
        {IconAgents({ size: 14 })}
        <span>{agents}</span>
      </Stat>

      <Stat key="tasks" label="Tasks" numeric minor>
        {IconTasks({ size: 14 })}
        <span>{tasks}</span>
      </Stat>

      <Stat
        key="lastturn"
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

      <Stat
        key="cost"
        label="Cost"
        numeric
        title="Session total reported by the CLI"
      >
        {IconCoins({ size: 14 })}
        <span>{usd(view().cost)}</span>
      </Stat>

      <Stat key="session" label="Session">
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
      {!(view().thinkingTokens > 0 && view().status === "working")
        ? <span key="thinking" hidden />
        : (
          <Stat
            key="thinking"
            label="Thinking"
            numeric
            title="The CLI's running token estimate for the reasoning in this turn"
          >
            {IconThinking({ size: 14 })}
            <span>{tokens(view().thinkingTokens)}</span>
          </Stat>
        )}

      {!(tight && limit) ? <span key="limit" hidden /> : (
        <Stat
          key="limit"
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

      {holds === 0 ? <span key="holds" hidden /> : (
        <Stat
          key="holds"
          label="Approval"
          title="Claude Code is blocked until you answer — the prompt is above this page, wherever you are"
        >
          <Pill tone="warn">
            {IconShield({ size: 11 })} {holds} to answer
          </Pill>
        </Stat>
      )}

      {!activeSettings().skipPermissions ? <span key="skip" hidden /> : (
        <Stat
          key="skip"
          label="Permissions"
          title="Running with --dangerously-skip-permissions: every check is off"
        >
          <Pill tone="danger">{IconAlert({ size: 11 })} all allowed</Pill>
        </Stat>
      )}
    </div>
  );
}
