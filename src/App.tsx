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
import {
  onCleanup,
  onGlobalKey,
  onMount,
  useConnected,
  useRef,
  useRoute,
  type VNode,
} from "aio/air";
import { Theme } from "./ui/theme.tsx";
import { Rail } from "./ui/Rail.tsx";
import { Dock } from "./ui/Dock.tsx";
import { StatusStrip } from "./ui/StatusStrip.tsx";
import { ChatPage } from "./ui/ChatPage.tsx";
import { ConsolePage } from "./ui/ConsolePage.tsx";
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
import {
  pendingPermissions,
  sessionOf,
  sessionsOf,
  view,
} from "./cell/session.ts";
import { activeIsLocal, engineOf, localChat } from "./cell/local.ts";
import { LocalChatPage } from "./ui/LocalChatPage.tsx";
import { activeSessionKey, workspace } from "./cell/workspace.ts";
import { IconChat } from "./ui/icons.tsx";
import { usePushToTalk } from "./ui/pushToTalk.ts";
import { useHeardText } from "./ui/heard.ts";
import { useSpokenText } from "./ui/spoken.ts";
import { speech } from "./cell/speech.ts";
import { globalBindings, noteRoute } from "./ui/commands.ts";
import { OverlayHost } from "./ui/overlays.tsx";
import { ToastHost } from "./ui/toast.tsx";
import { useAttention } from "./ui/attention.ts";

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
const LOCAL_PAGES = new Set(["/console", "/tree", "/settings"]);

const PAGES: Record<string, () => VNode> = {
  "/": ChatPage,
  "/console": ConsolePage,
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
  // Alt G's memory of the tab before. Here, during render, so it is current
  // the moment the route is — see `noteRoute`.
  noteRoute(path);
  const shell = useRef<HTMLDivElement | null>(null);
  useWheelVeto(shell);
  // Hold a key, say a sentence. Installed at the root because the key is held
  // wherever you happen to be — including inside a shell, where a bare
  // modifier is the one thing that costs the terminal nothing.
  usePushToTalk();
  useHeardText();
  // The other direction: finished messages get read back out. Off unless the
  // speaker is switched on, and while it is off this subscribes to nothing but
  // its own switch — a silent app must not re-render on every token.
  useSpokenText();
  // Whether the speaker starts on is persisted config, and config is not
  // loaded when the cell declares its state. Asked once, here.
  onMount(() => void speech.wake());
  // The window title follows the turn, and a chime marks one that finished
  // while you were elsewhere. Both engines, one hook — the shell already knows
  // which is running.
  const project = workspace.projects.find((p) => p.id === workspace.activeId);
  useAttention(
    activeIsLocal()
      ? localChat(activeSessionKey()).status === "working"
      : view().status === "working",
    project?.name ?? "",
  );
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
      <div class="shell" ref={shell}>
        <Dock />
        <div class="main">
          {
            /* Every child here is keyed, and the conditional ones render a
              keyed placeholder rather than nothing. Four of these come and go
              — the strip and the approval queue are Claude-only, the banners
              are conditions — and a falsy conditional is still a child, an
              unkeyed one, so the reconciler paired unrelated subtrees by
              position whenever one appeared. */
          }
          {isLocal ? <span key="strip" hidden /> : <StatusStrip key="strip" />}
          <ConnectionBanner key="connection" />
          {
            /* Above the routed page, not inside one: the CLI is blocked until
              this is answered, and the page you happen to be on when it asks is
              usually Sub-agents — watching the very agent that is waiting. */
          }
          {isLocal ? <span key="approvals" hidden /> : (
            <PermissionQueue
              key="approvals"
              requests={pendingPermissions()}
            />
          )}
          {
            /* Above the page on BOTH engines: a turn stopped in a project you
              are not looking at is the one thing that waits forever. */
          }
          <ElsewhereBanner key="elsewhere" />
          <Page key="page" />
        </div>
        <Rail />
      </div>

      {
        /* Every dialog in the app renders here — see `overlays.tsx` for the
          reason it cannot render where it is opened from. */
      }
      <OverlayHost />
      {
        /* Confirmation of things you just did, with the one thing you might
          want to do about them. Conditions stay in banners inside the layout;
          a notice about a past act has no place there. */
      }
      <ToastHost />
    </>
  );
}

/**
 * Install every global shortcut, from the one table that also documents them.
 *
 * The loop is over a fixed-length list on purpose: `onGlobalKey` is a hook, so
 * the count and order must not change between renders. See `commands.ts`.
 */
function useShortcuts(): void {
  const bindings = globalBindings();
  for (const b of bindings) onGlobalKey(b.key, b.run, b.chord);
}

/**
 * Ctrl+wheel does nothing — neither the app's zoom nor Electron's.
 *
 * The app's keys are the Alt chords, Escape and push-to-talk, by request;
 * zoom lives in Settings. Electron answers a ctrl-wheel with its own page
 * zoom, which scales the window chrome, is not persisted, and disagrees with
 * the app's zoom about what 100% means — so the event is still vetoed, just
 * no longer turned into anything.
 *
 * `passive: false` is what makes `preventDefault` legal on a wheel listener at
 * all — without it Chromium ignores the veto and zooms anyway.
 */
function useWheelVeto(anchor: { current: HTMLElement | null }): void {
  onMount(() => {
    // The window the app is actually rendered into, not the ambient global.
    // Under `testUI` those are two different objects, and a listener on the
    // global one never fires — the same trap a browser hides because there the
    // two happen to be the same thing.
    const win = anchor.current?.ownerDocument?.defaultView ?? globalThis;
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) e.preventDefault();
    };
    win.addEventListener("wheel", onWheel as EventListener, {
      passive: false,
    });
    onCleanup(() => win.removeEventListener("wheel", onWheel as EventListener));
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
  const waiting = waitingElsewhere();
  if (waiting.length === 0) return null;
  const total = waiting.reduce((n, w) => n + w.count, 0);
  const names = [...new Set(waiting.map((w) => w.projectId))]
    .map((id) => workspace.projects.find((p) => p.id === id)?.name)
    .map((name) => name ?? "a project")
    .join(", ");

  return (
    <div style={{ padding: "12px 22px 0" }}>
      <Banner tone="warn">
        {total} approval{total > 1 ? "s" : ""} waiting in{" "}
        {names}. Nothing moves there until it is answered.{" "}
        <button
          type="button"
          class="btn btn--sm"
          // The conversation itself, not its project: a project's first chat
          // is not necessarily the one that is waiting, and when the one that
          // is waiting sits in the project already on screen, selecting the
          // project did nothing at all.
          onClick={() => workspace.selectPane(waiting[0].key)}
        >
          Go there
        </button>
      </Banner>
    </div>
  );
}

/**
 * Every conversation stopped on an approval, except the one on screen.
 *
 * Per conversation, not per project: a project can hold several chats, any of
 * them can be the one waiting — a second chat in the project on screen as
 * much as one elsewhere — and "Go there" has to land on it. Claude approvals
 * and a local engine's held command are the same fact about two
 * integrations: a turn has stopped and will not start again until somebody
 * answers, and the prompt for either only renders for the chat on screen.
 */
function waitingElsewhere(): {
  projectId: string;
  key: string;
  count: number;
}[] {
  const showing = activeSessionKey();
  return workspace.projects.flatMap((p) =>
    sessionsOf(p.id)
      .filter((key) => key !== showing)
      .map((key) => ({
        projectId: p.id,
        key,
        count: engineOf(key) === "claude"
          ? sessionOf(key).permissions.filter((r) => r.status === "pending")
            .length
          : localChat(key).pending !== null
          ? 1
          : 0,
      }))
      .filter((w) => w.count > 0)
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
