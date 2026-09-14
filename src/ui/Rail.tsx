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
import { type VNode } from "aio/air";
import {
  pendingPermissions,
  runningAgents,
  runningTasks,
  runningTools,
  session,
  view,
} from "../cell/session.ts";
import {
  activePane,
  activeProject,
  activeSessionKey,
  activeSettings,
  workspace,
} from "../cell/workspace.ts";
import { activeIsLocal, localChat, localConfig } from "../cell/local.ts";
import { ENGINE_NAMES } from "./LocalChatPage.tsx";
import { blockedJobs, jobs } from "../cell/jobs.ts";
import { activeLoops, projectLoops } from "../cell/loops.ts";
import { catalog, mcpEntries, memoryBytes } from "../cell/catalog.ts";
import { storage } from "../cell/storage.ts";
import { bytes, modelLabel } from "../lib/format.ts";
import { atRoute, go } from "./go.ts";
import { terminal } from "../cell/console.ts";
import { Badge, Dot } from "./parts.tsx";
import { MachineStrip } from "./Machine.tsx";

import { closeOverlay, showOverlay } from "./overlays.tsx";
import { CommandPalette } from "./Palette.tsx";
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
  IconTerminal,
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
  // An anchor of our own rather than `Link`.
  //
  // `Link` navigates on every click, including a click on the card you are
  // already looking at — and that rebuilt the whole tree, which on the Console
  // tears the terminal down and redraws it from scrollback. A visible flash
  // for a click that should do nothing at all. `Link` sets its own `onClick`
  // last, so there is no way to decline from outside it; the anchor here is
  // the same element with the same behaviour, minus that one click.
  //
  // The modifier check is `Link`'s, and matters for the same reason: those
  // gestures belong to the browser, and taking them over replaces what the
  // user asked for with an in-page route change.
  const here = atRoute(props.to, props.exact);
  return (
    <a
      href={props.to}
      class={`navcard${here ? " active" : ""}`}
      // Without this the link's accessible name is its label and hint run
      // together ("Chatcc"), which is what a screen reader announces and what
      // testUI/`am surface` address it by. One label, three consumers.
      aria-label={props.label}
      aria-current={here ? "page" : undefined}
      onClick={(e: MouseEvent) => {
        if (
          e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey
        ) {
          return;
        }
        e.preventDefault();
        if (here) return;
        go(props.to, props.exact);
      }}
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
    </a>
  );
}

/** A group heading. `wide` so it disappears with the labels when the rail
 *  collapses to icons — a heading over nothing is worse than no heading. */
const Group = (props: { children: unknown }): VNode => (
  <div class="rail__group">{props.children}</div>
);

/** Move focus between rail cards. Focus only — a card navigates on Enter, like
 *  every link, and arrowing through pages would fire fourteen navigations. */
function walkCards(e: KeyboardEvent): void {
  if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
  const list = e.currentTarget as HTMLElement | null;
  if (!list) return;
  const cards = [...list.querySelectorAll<HTMLElement>(".navcard")];
  const at = cards.indexOf(
    (e.target as HTMLElement).closest(".navcard") as HTMLElement,
  );
  if (at === -1) return;
  e.preventDefault();
  cards[e.key === "ArrowDown" ? at + 1 : at - 1]?.focus();
}

export function Rail(): VNode {
  const project = activeProject();
  // On a local engine most cards describe the Claude Code CLI — sub-agents,
  // tasks, jobs, capabilities, its storage. Hiding them is the honest rail:
  // a card whose page can only say "not running here" is noise, not signal.
  const isLocal = activeIsLocal();
  // What the dock is pointing at. The first card is the way back to it.
  const here = activePane();
  const onConsole = here?.kind === "console";
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
        {
          /* The brand is the palette's front door. A command palette nobody
            knows about is a feature nobody has — and the top-left corner of a
            desktop app is where people look for "what can this thing do". */
        }
        <button
          type="button"
          class="brand"
          aria-label="Command palette"
          title="Every action, by name"
          onClick={() =>
            showOverlay(() => <CommandPalette onClose={closeOverlay} />)}
        >
          <span class="brand__mark">{IconLogo({ size: 19 })}</span>
          <span class="brand__text truncate">
            <div class="brand__name">Claude Control</div>
            <div class="brand__sub">
              {workspace.cliVersion
                ? `CLI ${workspace.cliVersion}`
                : "CLI not found"}
            </div>
          </span>
        </button>
      </div>

      {
        /* Up and down walk the cards, the same way they walk the project
          list. Tab reaches them too, but Tab also leaves the rail. */
      }
      <div class="rail__nav" onKeyDown={walkCards}>
        <Group key="g-session">Session</Group>
        {
          /* The way back to what you were doing — which is not always a chat.

            A project holds conversations and shells, and the dock decides
            which one is showing. A card fixed on "Chat" sent you somewhere
            other than where you came from, and left the Console reachable only
            through the dock. This one follows the same active pane the dock
            marks, so leaving for Settings and coming back lands you where you
            were. */
        }
        <NavCard
          key="chat"
          to={onConsole ? "/console" : "/"}
          exact={!onConsole}
          icon={onConsole ? IconTerminal({ size: 16 }) : IconChat({ size: 16 })}
          label="Project"
          hint={onConsole
            ? `${here?.title ?? "Console"}${
              terminal().running ? ` · ${terminal().running}` : ""
            }`
            : isLocal
            ? `${
              ENGINE_NAMES[localConfig(activeSessionKey()).engine] ?? ""
            } · ${
              modelLabel(localConfig(activeSessionKey()).model) || "no model"
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
        {isLocal
          ? <span key="session-extra" hidden />
          : (
            <div key="session-extra" style={{ display: "contents" }}>
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
            </div>
          )}

        {isLocal
          ? <span key="g-background" hidden />
          : <Group key="g-background">Background</Group>}
        {isLocal
          ? <span key="background" hidden />
          : (
            <div key="background" style={{ display: "contents" }}>
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
            </div>
          )}

        {
          /* "Codebase", not "Project" — the first card is called Project now,
            and one panel cannot have two things by that name. These two are
            about the files: what is in the folder, and what the folder tells
            Claude about itself. */
        }
        <Group key="g-project">Codebase</Group>
        <NavCard
          key="tree"
          to="/tree"
          icon={IconTree({ size: 16 })}
          label="Tree"
          hint={project ? project.name : "No project"}
        />
        {isLocal ? <span key="memory" hidden /> : (
          <NavCard
            key="memory"
            to="/memory"
            icon={IconMemory({ size: 16 })}
            label="Memory"
            hint={catalog.memory.length > 0
              ? bytes(memoryBytes())
              : "Not scanned"}
          />
        )}

        {isLocal
          ? <span key="g-capabilities" hidden />
          : <Group key="g-capabilities">Capabilities</Group>}
        {isLocal
          ? <span key="capabilities" hidden />
          : (
            <div key="capabilities" style={{ display: "contents" }}>
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
            </div>
          )}
        <NavCard
          key="settings"
          to="/settings"
          icon={IconSettings({ size: 16 })}
          label="Settings"
          hint={isLocal
            ? `${
              ENGINE_NAMES[localConfig(activeSessionKey()).engine] ?? "local"
            } · ${localConfig(activeSessionKey()).mode}`
            : `${activeSettings().model} · ${activeSettings().permissionMode}${
              activeSettings().effort ? ` · ${activeSettings().effort}` : ""
            }`}
        />
      </div>

      <div class="rail__foot">
        {
          /* The machine, above the session. A local model that has filled the
            video memory and a test suite pinning every core are both reasons
            the app in front of you is slow, and neither is visible anywhere
            else in it. */
        }
        <MachineStrip />
        {isLocal
          ? (
            <div
              style={{ display: "flex", alignItems: "center", gap: "8px" }}
            >
              <Dot
                status={localChat(activeSessionKey()).status === "working"
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
                {localChat(activeSessionKey()).status === "working"
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
