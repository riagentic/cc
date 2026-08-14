/**
 * @module
 * The left rail: brand, the project being controlled, and one card per detail
 * page. Each card carries a live number, so the rail doubles as the dashboard —
 * you can see what the session is doing without opening anything.
 */
import { Link, type VNode } from "aio/air";
import { session } from "../cell/session.ts";
import {
  memoryBytes,
  pendingPermissions,
  runningAgents,
  runningTasks,
  runningTools,
} from "../cell/session.ts";
import { activeProject, workspace } from "../cell/workspace.ts";
import { bytes, tildePath } from "../lib/format.ts";
import { Badge, Dot } from "./parts.tsx";
import {
  IconActivity,
  IconAgents,
  IconChat,
  IconFolder,
  IconLogo,
  IconMemory,
  IconPlay,
  IconPower,
  IconSettings,
  IconTasks,
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
        <span class="navcard__label">{props.label}</span>
        <br />
        <span class="navcard__hint">{props.hint}</span>
      </span>
      {props.badge}
    </Link>
  );
}

export function Rail(): VNode {
  const project = activeProject();
  const agents = runningAgents().length;
  const tasks = runningTasks().length + runningTools().length;
  const holds = pendingPermissions().length;
  const live = session.status === "working";

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
        <NavCard
          to="/"
          exact
          icon={IconChat({ size: 16 })}
          label="Chat"
          hint={holds > 0
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
        <NavCard
          to="/agents"
          icon={IconAgents({ size: 16 })}
          label="Sub-agents"
          hint={agents > 0 ? `${agents} running` : "Idle"}
          badge={agents > 0 ? <Badge value={agents} tone="live" /> : undefined}
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
          hint={`${session.activity.length} events`}
        />
        <NavCard
          to="/memory"
          icon={IconMemory({ size: 16 })}
          label="Memory"
          hint={session.memory.length > 0
            ? bytes(memoryBytes())
            : "Not scanned"}
        />
        <NavCard
          to="/settings"
          icon={IconSettings({ size: 16 })}
          label="Settings"
          hint={`${workspace.model} · ${workspace.permissionMode}`}
        />
      </div>

      <div class="rail__foot">
        <div class="navcard" style={{ cursor: "default" }}>
          <span class="navcard__icon">{IconFolder({ size: 15 })}</span>
          <span class="truncate wide">
            <span class="navcard__label truncate">
              {project?.name ?? "No project"}
            </span>
            <br />
            <span class="navcard__hint truncate" title={project?.path}>
              {project
                ? tildePath(project.path, workspace.home)
                : "Add one in Settings"}
            </span>
          </span>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <Dot status={session.status} />
          <span
            class="wide"
            style={{ flex: 1, fontSize: "12px", color: "var(--ink-soft)" }}
          >
            {STATUS_TEXT[session.status] ?? session.status}
          </span>
          {session.status === "offline" || session.status === "error"
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
      </div>
    </nav>
  );
}
