/**
 * @module
 * Root layout and routing only — every page lives in `ui/`.
 *
 * The shell is a fixed rail plus one routed page, with the status strip pinned
 * above both: whatever you are looking at, what the session is doing is one
 * glance away.
 */
import { useConnected, useRoute, type VNode } from "aio/air";
import { Theme } from "./ui/theme.tsx";
import { Rail } from "./ui/Rail.tsx";
import { StatusStrip } from "./ui/StatusStrip.tsx";
import { ChatPage } from "./ui/ChatPage.tsx";
import { AgentsPage } from "./ui/AgentsPage.tsx";
import { TasksPage } from "./ui/TasksPage.tsx";
import { ActivityPage } from "./ui/ActivityPage.tsx";
import { MemoryPage } from "./ui/MemoryPage.tsx";
import { SettingsPage } from "./ui/SettingsPage.tsx";
import { Banner, Empty } from "./ui/parts.tsx";
import { PermissionQueue } from "./ui/PermissionPrompt.tsx";
import { pendingPermissions } from "./cell/session.ts";
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
  "/memory": MemoryPage,
  "/settings": SettingsPage,
};

export default function App(): VNode {
  const { path } = useRoute();
  const Page = PAGES[path.replace(/(.)\/$/, "$1")] ?? NotFound;

  return (
    <>
      <Theme />

      <div class="shell">
        <Rail />
        <div class="main">
          <StatusStrip />
          <ConnectionBanner />
          {
            /* Above the routed page, not inside one: the CLI is blocked until
              this is answered, and the page you happen to be on when it asks is
              usually Sub-agents — watching the very agent that is waiting. */
          }
          <PermissionQueue requests={pendingPermissions()} />
          <Page />
        </div>
      </div>
    </>
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
          hint="Pick a section from the rail on the left."
        />
      </div>
    </div>
  );
}
