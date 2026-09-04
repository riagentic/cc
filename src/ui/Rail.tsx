/**
 * @module
 * The section rail, on the right: one card per page, grouped, each carrying a
 * live number so the rail doubles as the dashboard.
 *
 * It sits on the right because it is the column that gets clicked — the pointer
 * already lives near the scrollbar, and the project dock on the left changes
 * once a session where this changes constantly.
 *
 * The groups are not decoration. Fourteen destinations is past the number a
 * flat list can be scanned as one thing, and they divide cleanly by what they
 * are *about*: the live turn, work that outlives it, the code on disk, and the
 * configuration that decides what any of it can do.
 */
import { Link, type VNode } from "aio/air";
import {
  pendingPermissions,
  runningAgents,
  runningTasks,
  runningTools,
  session,
  view,
} from "../cell/session.ts";
import { activeProject, activeSettings, workspace } from "../cell/workspace.ts";
import { activeIsLocal, localChat, localConfig } from "../cell/local.ts";
import { ENGINE_NAMES } from "./LocalChatPage.tsx";
import { blockedJobs, jobs } from "../cell/jobs.ts";
import { activeLoops, projectLoops } from "../cell/loops.ts";
import { catalog, mcpEntries, memoryBytes } from "../cell/catalog.ts";
import { storage } from "../cell/storage.ts";
import { bytes, modelLabel } from "../lib/format.ts";
import { Badge, Dot } from "./parts.tsx";
import {
  IconActivity,
  IconAgents,
  IconChat,
  IconCommand,
  IconFolder,
  IconHook,
  IconJobs,
  IconLogo,
  IconLoop,
  IconMemory,
  IconPlay,
  IconPlug,
  IconPlugin,
  IconPower,
  IconSettings,
  IconSpark,
  IconTasks,
  IconTree,
} from "./icons.tsx";

const STATUS_TEXT: Record<string, string> = {
  offline: "Offline",
  starting: "Starting…",
  ready: "Ready",
  working: "Working",
  error: "Error",
};

function NavCard(
  props: {
    to: string;
    exact?: boolean;
    icon: VNode;
    label: string;
    hint: string;
    /** Marks a destination that is NOT about the selected project. Three of
     *  these are machine-wide, and the groups below sort pages by what they are
     *  for, not by what they cover — so without this, Jobs (every background
     *  session on the machine) and Loops (this project only) look identical. */
    machine?: boolean;
    badge?: VNode;
  },
): VNode {
  return (
    <Link
      to={props.to}
      exact={props.exact}
      // `className`, not `class`: Link merges `activeClass` into `className`
      // (dep/aio/src/browser/browser-air-router.ts Link), so a class passed the
      // other way is dropped the moment the link goes active.
      // Routing reference: dep/aio/docs/ui/air-routing.md.
      className="navcard"
      activeClass="active"
      // Without this the link's accessible name is its label and hint run
      // together ("Chatcc"), which is what a screen reader announces and what
      // testUI/`am surface` address it by. One label, three consumers.
      aria-label={props.label}
    >
      <span class="navcard__icon">{props.icon}</span>
      <span class="truncate">
        <span class="navcard__label">
          {props.label}
          {props.machine && (
            <span
              class="navcard__machine"
              title="Machine-wide — every project, not just the one selected"
            />
          )}
        </span>
        <br />
        <span class="navcard__hint">{props.hint}</span>
      </span>
      {props.badge}
    </Link>
  );
}

/** A group heading. `wide` so it disappears with the labels when the rail
 *  collapses to icons — a heading over nothing is worse than no heading. */
const Group = (props: { children: unknown }): VNode => (
  <div class="rail__group">{props.children}</div>
);

export function Rail(): VNode {
  const project = activeProject();
  // On a local engine most cards describe the Claude Code CLI — sub-agents,
  // tasks, jobs, capabilities, its storage. Hiding them is the honest rail:
  // a card whose page can only say "not running here" is noise, not signal.
  const isLocal = activeIsLocal();
  const agents = runningAgents().length;
  const tasks = runningTasks().length + runningTools().length;
  const holds = pendingPermissions().length;
  const live = view().status === "working";

  const working = jobs.jobs.filter((j) => j.state === "working").length;
  const blocked = blockedJobs().length;
  const loops = projectLoops().length;
  const armed = activeLoops().length;
  const servers = mcpEntries();
  const connected =
    servers.filter((m) => m.status === "connected" || m.status === "ready")
      .length;

  return (
    <nav class="rail" aria-label="Sections">
      <div class="rail__head">
        <div class="brand">
          <span class="brand__mark">{IconLogo({ size: 19 })}</span>
          <span class="brand__text truncate">
            <div class="brand__name">Claude Control</div>
            <div class="brand__sub">
              {workspace.cliVersion
                ? `CLI ${workspace.cliVersion}`
                : "CLI not found"}
            </div>
          </span>
        </div>
      </div>

      <div class="rail__nav">
        <Group>Session</Group>
        <NavCard
          to="/"
          exact
          icon={IconChat({ size: 16 })}
          label="Chat"
          hint={isLocal
            ? `${
              ENGINE_NAMES[localConfig(workspace.activeId).engine] ?? ""
            } · ${
              modelLabel(localConfig(workspace.activeId).model) || "no model"
            }`
            : holds > 0
            ? `${holds} approval${holds > 1 ? "s" : ""} needed`
            : project
            ? project.name
            : "No project"}
          // The prompt renders above whichever page you are on, but the rail
          // still carries the count — a blocked turn is never silent, and the
          // badge is what catches the eye first.
          badge={holds > 0
            ? <Badge value="approve" tone="danger" />
            : live
            ? <Badge value="live" tone="live" />
            : undefined}
        />
        {!isLocal && (
          <>
            <NavCard
              to="/agents"
              icon={IconAgents({ size: 16 })}
              label="Sub-agents"
              hint={agents > 0 ? `${agents} running` : "Idle"}
              badge={agents > 0
                ? <Badge value={agents} tone="live" />
                : undefined}
            />
            <NavCard
              to="/tasks"
              icon={IconTasks({ size: 16 })}
              label="Tasks"
              hint={tasks > 0
                ? `${tasks} running`
                : holds > 0
                ? `${holds} waiting for you`
                : "Idle"}
              badge={tasks > 0
                ? <Badge value={tasks} tone="live" />
                : holds > 0
                ? <Badge value={holds} tone="danger" />
                : undefined}
            />
            <NavCard
              to="/activity"
              icon={IconActivity({ size: 16 })}
              label="Activity"
              hint={`${view().activity.length} events`}
            />
          </>
        )}

        {!isLocal && <Group>Background</Group>}
        {!isLocal && (
          <>
            <NavCard
              to="/jobs"
              icon={IconJobs({ size: 16 })}
              label="Jobs"
              machine
              // Blocked leads, because a blocked job is the one that will sit there
              // forever if nobody is told about it.
              hint={blocked > 0
                ? `${blocked} waiting on you`
                : working > 0
                ? `${working} working`
                : jobs.jobs.length > 0
                ? `${jobs.jobs.length} total`
                : "None"}
              badge={blocked > 0
                ? <Badge value={blocked} tone="danger" />
                : working > 0
                ? <Badge value={working} tone="live" />
                : undefined}
            />
            <NavCard
              to="/loops"
              icon={IconLoop({ size: 16 })}
              label="Loops"
              hint={armed > 0
                ? `${armed} armed`
                : loops > 0
                ? `${loops} paused`
                : "None"}
              badge={armed > 0 ? <Badge value={armed} /> : undefined}
            />
          </>
        )}

        <Group>Project</Group>
        <NavCard
          to="/tree"
          icon={IconTree({ size: 16 })}
          label="Tree"
          hint={project ? project.name : "No project"}
        />
        {!isLocal && (
          <NavCard
            to="/memory"
            icon={IconMemory({ size: 16 })}
            label="Memory"
            hint={catalog.memory.length > 0
              ? bytes(memoryBytes())
              : "Not scanned"}
          />
        )}

        {!isLocal && <Group>Capabilities</Group>}
        {!isLocal && (
          <>
            <NavCard
              to="/skills"
              icon={IconSpark({ size: 16 })}
              label="Skills"
              hint={`${
                view().meta.skills.length || catalog.skills.length
              } loaded`}
            />
            <NavCard
              to="/commands"
              icon={IconCommand({ size: 16 })}
              label="Commands"
              hint={`${
                view().meta.commands.length || catalog.commands.length
              } available`}
            />
            <NavCard
              to="/mcp"
              icon={IconPlug({ size: 16 })}
              label="MCP"
              hint={servers.length === 0
                ? "None configured"
                : `${connected}/${servers.length} connected`}
            />
            <NavCard
              to="/plugins"
              icon={IconPlugin({ size: 16 })}
              label="Plugins"
              machine
              hint={catalog.plugins.length > 0
                ? `${catalog.plugins.length} installed`
                : "None"}
            />
            <NavCard
              to="/hooks"
              icon={IconHook({ size: 16 })}
              label="Hooks"
              hint={catalog.hooks.length > 0
                ? `${catalog.hooks.length} configured`
                : "None"}
            />
            <NavCard
              to="/storage"
              icon={IconFolder({ size: 16 })}
              label="Storage"
              machine
              hint={storage.scannedAt > 0
                ? bytes(storage.totalBytes)
                : "Not scanned"}
            />
          </>
        )}
        <NavCard
          to="/settings"
          icon={IconSettings({ size: 16 })}
          label="Settings"
          hint={isLocal
            ? `${
              ENGINE_NAMES[localConfig(workspace.activeId).engine] ?? "local"
            } · ${localConfig(workspace.activeId).mode}`
            : `${activeSettings().model} · ${activeSettings().permissionMode}${
              activeSettings().effort ? ` · ${activeSettings().effort}` : ""
            }`}
        />
      </div>

      <div class="rail__foot">
        {isLocal
          ? (
            <div
              style={{ display: "flex", alignItems: "center", gap: "8px" }}
            >
              <Dot
                status={localChat(workspace.activeId).status === "working"
                  ? "working"
                  : "ready"}
              />
              <span
                class="wide"
                style={{
                  flex: 1,
                  fontSize: "12px",
                  color: "var(--ink-soft)",
                }}
              >
                {localChat(workspace.activeId).status === "working"
                  ? "Working"
                  : "Ready"}
              </span>
            </div>
          )
          : (
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <Dot status={view().status} />
              <span
                class="wide"
                style={{ flex: 1, fontSize: "12px", color: "var(--ink-soft)" }}
              >
                {STATUS_TEXT[view().status] ?? view().status}
              </span>
              {view().status === "offline" || view().status === "error"
                ? (
                  <button
                    type="button"
                    class="btn btn--sm btn--icon"
                    title="Start session"
                    aria-label="Start session"
                    onClick={() => session.start()}
                  >
                    {IconPlay({ size: 15 })}
                  </button>
                )
                : (
                  <button
                    type="button"
                    class="btn btn--sm btn--icon"
                    title="Stop session"
                    aria-label="Stop session"
                    onClick={() => session.stop()}
                  >
                    {IconPower({ size: 15 })}
                  </button>
                )}
            </div>
          )}
      </div>
    </nav>
  );
}
