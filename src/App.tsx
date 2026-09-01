/**
 * @module
 * Root layout and routing only — every page lives in `ui/`.
 *
 * The shell is three columns: the project dock, one routed page, and the
 * section rail — with the status strip pinned above the middle one, so whatever
 * you are looking at, what the session is doing is one glance away.
 *
 * The two side panels are separated by how often they are used. Which project
 * changes once a session and lives on the left; which section changes
 * constantly and lives on the right, under the hand that is already there.
 */
import { useConnected, useRoute, type VNode } from "aio/air";
import { Theme } from "./ui/theme.tsx";
import { Rail } from "./ui/Rail.tsx";
import { Dock } from "./ui/Dock.tsx";
import { StatusStrip } from "./ui/StatusStrip.tsx";
import { ChatPage } from "./ui/ChatPage.tsx";
import { AgentsPage } from "./ui/AgentsPage.tsx";
import { TasksPage } from "./ui/TasksPage.tsx";
import { ActivityPage } from "./ui/ActivityPage.tsx";
import { MemoryPage } from "./ui/MemoryPage.tsx";
import { JobsPage } from "./ui/JobsPage.tsx";
import { LoopsPage } from "./ui/LoopsPage.tsx";
import { TreePage } from "./ui/TreePage.tsx";
import { StoragePage } from "./ui/StoragePage.tsx";
import {
  CommandsPage,
  HooksPage,
  McpPage,
  PluginsPage,
  SkillsPage,
} from "./ui/ConfigPages.tsx";
import { SettingsPage } from "./ui/SettingsPage.tsx";
import { Banner, Empty } from "./ui/parts.tsx";
import { PermissionQueue } from "./ui/PermissionPrompt.tsx";
import { backgroundApprovals, pendingPermissions } from "./cell/session.ts";
import { workspace } from "./cell/workspace.ts";
import { IconChat } from "./ui/icons.tsx";

/**
 * One page per path, matched exactly.
 *
 * Deliberately not `<Route path="/">`: a `/` route prefix-matches every path
 * (dep/aio/docs/ui/air-routing.md — "Routes with children use prefix matching"),
 * so the chat page rendered underneath every other page. An explicit table is
 * unambiguous, and gives a real not-found instead of a blank column.
 */
const PAGES: Record<string, () => VNode> = {
  "/": ChatPage,
  "/agents": AgentsPage,
  "/tasks": TasksPage,
  "/activity": ActivityPage,
  "/jobs": JobsPage,
  "/loops": LoopsPage,
  "/tree": TreePage,
  "/memory": MemoryPage,
  "/skills": SkillsPage,
  "/commands": CommandsPage,
  "/mcp": McpPage,
  "/plugins": PluginsPage,
  "/hooks": HooksPage,
  "/storage": StoragePage,
  "/settings": SettingsPage,
};

export default function App(): VNode {
  const { path } = useRoute();
  const Page = PAGES[path.replace(/(.)\/$/, "$1")] ?? NotFound;

  return (
    <>
      <Theme />

      {
        /* Three columns: which project on the left, the work in the middle,
          which section on the right. The dock and the rail are both fixed; only
          the middle scrolls. */
      }
      <div class="shell">
        <Dock />
        <div class="main">
          <StatusStrip />
          <ConnectionBanner />
          {
            /* Above the routed page, not inside one: the CLI is blocked until
              this is answered, and the page you happen to be on when it asks is
              usually Sub-agents — watching the very agent that is waiting. */
          }
          <PermissionQueue requests={pendingPermissions()} />
          <ElsewhereBanner />
          <Page />
        </div>
        <Rail />
      </div>
    </>
  );
}

/**
 * Another project's session is blocked on an approval.
 *
 * The prompt itself only renders for the project on screen, and the CLI waiting
 * on it will wait until it gives up and denies — so a turn you started in one
 * codebase and walked away from would stall in silence. The dock marks the tab;
 * this says it in words, and takes you there.
 */
function ElsewhereBanner(): VNode | null {
  const waiting = backgroundApprovals();
  if (waiting.length === 0) return null;
  const total = waiting.reduce((n, w) => n + w.count, 0);
  const names = waiting
    .map((w) =>
      workspace.projects.find((p) => p.id === w.id)?.name ?? "a project"
    )
    .join(", ");

  return (
    <div style={{ padding: "12px 22px 0" }}>
      <Banner tone="warn">
        {total} approval{total > 1 ? "s" : ""} waiting in{" "}
        {names}. That session is blocked until it is answered.{" "}
        <button
          type="button"
          class="btn btn--sm"
          onClick={() => workspace.select(waiting[0].id)}
        >
          Go there
        </button>
      </Banner>
    </div>
  );
}

/** A dropped socket is worth saying out loud — the session keeps running on the
 *  server, so silence would read as "the app froze". */
function ConnectionBanner(): VNode | null {
  if (useConnected()) return null;
  return (
    <div style={{ padding: "12px 22px 0" }}>
      <Banner tone="warn">
        Disconnected from the app server — reconnecting. Nothing is lost: the
        Claude Code session keeps running.
      </Banner>
    </div>
  );
}

function NotFound(): VNode {
  return (
    <div class="page">
      <div class="page__body">
        <Banner tone="warn">That page does not exist.</Banner>
        <Empty
          icon={IconChat({ size: 20 })}
          title="Nothing here"
          hint="Pick a section from the rail on the right."
        />
      </div>
    </div>
  );
}
