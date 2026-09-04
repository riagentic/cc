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
import { onGlobalKey, useConnected, useRoute, type VNode } from "aio/air";
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
import { activeIsLocal, engineOf, localChat } from "./cell/local.ts";
import { LocalChatPage } from "./ui/LocalChatPage.tsx";
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
/** Paths that stay meaningful when a project runs a local engine — about the
 *  project or the app, never about the Claude Code CLI. `/` is not listed:
 *  the local-page branch below owns it. */
const LOCAL_PAGES = new Set(["/tree", "/settings"]);

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
  useShortcuts();
  const clean = path.replace(/(.)\/$/, "$1");
  // A project on a local engine gets the local conversation at `/` and none
  // of the Claude session chrome — the strip, the permission queue and the
  // approval banners all describe a CLI that is not running here. A
  // Claude-only path — parked there before the switch, or typed — falls back
  // to the local chat too: rendering a page whose rail card just disappeared
  // would leak the very surface the switch removed.
  const isLocal = activeIsLocal();
  const Page = isLocal
    ? LOCAL_PAGES.has(clean) ? PAGES[clean] ?? NotFound : LocalChatPage
    : PAGES[clean] ?? NotFound;

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
          {!isLocal && <StatusStrip />}
          <ConnectionBanner />
          {
            /* Above the routed page, not inside one: the CLI is blocked until
              this is answered, and the page you happen to be on when it asks is
              usually Sub-agents — watching the very agent that is waiting. */
          }
          {!isLocal && <PermissionQueue requests={pendingPermissions()} />}
          {
            /* Above the page on BOTH engines: a turn stopped in a project you
              are not looking at is the one thing that waits forever. */
          }
          <ElsewhereBanner />
          <Page />
        </div>
        <Rail />
      </div>
    </>
  );
}

/**
 * The two keystrokes a control surface with a project list and a filter on
 * every page actually needs.
 *
 * Deliberately two, not twenty. A shortcut nobody can remember is a key that
 * has been taken away from the page, and this app's own composer wants every
 * plain letter for typing.
 *
 *  - **Mod+1…9** switches project. It is the most repeated action here — the
 *    whole app is about several codebases at once — and it is the one the
 *    pointer has to travel furthest for.
 *  - **`/`** puts the cursor in whatever filter the page in front of you has.
 *    Guarded by `ignoreInInput`, which is the framework's default and the
 *    reason a bare letter is safe at all: typing a slash in the composer types
 *    a slash.
 */
function useShortcuts(): void {
  for (let n = 1; n <= 9; n++) {
    onGlobalKey(String(n), () => {
      const project = workspace.projects[n - 1];
      // Nothing at that position is a no-op, not a wrap-around: a shortcut
      // that lands somewhere unexpected is worse than one that does nothing.
      if (project) workspace.select(project.id);
    }, { mod: true, ignoreInInput: false });
  }

  onGlobalKey("/", (e) => {
    // The filter belonging to the PAGE, not the one in the project dock —
    // which comes first in the DOM and would otherwise win every time. The
    // middle column is what "the thing in front of you" means here.
    const box = document.querySelector<HTMLInputElement>(
      ".main .input--search",
    ) ?? document.querySelector<HTMLInputElement>(".input--search");
    if (!box) return;
    e.preventDefault();
    box.focus();
    box.select();
  });
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
  // Claude approvals, and a local engine's held command — the same fact about
  // two integrations. Both mean a turn somewhere else has stopped and will not
  // start again until somebody answers, and the prompt for either only renders
  // for the project on screen.
  const active = workspace.activeId;
  const waiting = [
    ...backgroundApprovals(),
    ...workspace.projects
      .filter((p) =>
        p.id !== active && engineOf(p.id) !== "claude" &&
        localChat(p.id).pending !== null
      )
      .map((p) => ({ id: p.id, count: 1 })),
  ];
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
        {names}. Nothing moves there until it is answered.{" "}
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
