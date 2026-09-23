/**
 * @module
 * Every action the app can be asked to do, as one list.
 *
 * This exists so that three surfaces cannot drift apart: the command palette,
 * the keyboard shortcuts, and the "what can I press" help. They are all built
 * from the table below, so a command added here is instantly findable by name,
 * bound to its key, and documented — and a key can never be listed in the help
 * without actually doing anything.
 *
 * The list is *live*: it is rebuilt from current state on every call, so a
 * command that makes no sense right now (stop a session that is not running,
 * open a page this engine does not have) is simply not in it. Greying a row out
 * tells the reader something is possible somewhere; leaving it out tells them
 * what they can do now.
 */
import { atRoute, go } from "./go.ts";
import type { Pane } from "../type/claude.ts";
import { type VNode } from "aio/air";
import {
  activePane,
  activeSessionKey,
  panesOf,
  workspace,
} from "../cell/workspace.ts";
import { consoleCell } from "../cell/console.ts";
import { session, view } from "../cell/session.ts";
import { activeIsLocal, local, localChat } from "../cell/local.ts";
import { prefs, ZOOM_STEP } from "../cell/prefs.ts";
import { speech, speechOn, speechReady } from "../cell/speech.ts";
import { startReading, stopReading } from "./spoken.ts";
import { showToast } from "./toast.tsx";
import { overlayOpen } from "./overlays.tsx";
import {
  IconActivity,
  IconAgents,
  IconChat,
  IconCommand,
  IconFolder,
  IconHook,
  IconJobs,
  IconLoop,
  IconMemory,
  IconPlug,
  IconPlugin,
  IconPlus,
  IconPower,
  IconRefresh,
  IconSearch,
  IconSettings,
  IconSpark,
  IconTasks,
  IconTrash,
  IconTree,
} from "./icons.tsx";
import { openFind } from "./find.tsx";

/** One thing the app can be asked to do. */
export type Command = {
  id: string;
  label: string;
  /** The second line: which project, which page, what it will cost you. */
  hint?: string;
  group: string;
  icon?: VNode;
  /** Extra words nobody sees, matched by the filter. The point is that
   *  "dark" finds the theme switch and "font" finds zoom. */
  alias?: string;
  danger?: boolean;
  run: () => void;
};

/** The destinations, in rail order. Also the source of the Go commands, so a
 *  page can never be reachable by click and unreachable by keyboard. */
const PAGES: {
  to: string;
  label: string;
  icon: VNode;
  claudeOnly?: boolean;
  alias?: string;
}[] = [
  { to: "/", label: "Chat", icon: IconChat({ size: 15 }) },
  {
    to: "/agents",
    label: "Sub-agents",
    icon: IconAgents({ size: 15 }),
    claudeOnly: true,
  },
  {
    to: "/tasks",
    label: "Tasks",
    icon: IconTasks({ size: 15 }),
    claudeOnly: true,
  },
  {
    to: "/activity",
    label: "Activity",
    icon: IconActivity({ size: 15 }),
    claudeOnly: true,
  },
  {
    to: "/jobs",
    label: "Jobs",
    icon: IconJobs({ size: 15 }),
    claudeOnly: true,
    alias: "background sessions machine",
  },
  {
    to: "/loops",
    label: "Loops",
    icon: IconLoop({ size: 15 }),
    claudeOnly: true,
    alias: "repeat schedule",
  },
  { to: "/tree", label: "Tree", icon: IconTree({ size: 15 }), alias: "files" },
  {
    to: "/memory",
    label: "Memory",
    icon: IconMemory({ size: 15 }),
    claudeOnly: true,
    alias: "claude.md",
  },
  {
    to: "/skills",
    label: "Skills",
    icon: IconSpark({ size: 15 }),
    claudeOnly: true,
  },
  {
    to: "/commands",
    label: "Commands",
    icon: IconCommand({ size: 15 }),
    claudeOnly: true,
    alias: "slash",
  },
  {
    to: "/mcp",
    label: "MCP",
    icon: IconPlug({ size: 15 }),
    claudeOnly: true,
    alias: "servers tools",
  },
  {
    to: "/plugins",
    label: "Plugins",
    icon: IconPlugin({ size: 15 }),
    claudeOnly: true,
  },
  {
    to: "/hooks",
    label: "Hooks",
    icon: IconHook({ size: 15 }),
    claudeOnly: true,
  },
  {
    to: "/storage",
    label: "Storage",
    icon: IconFolder({ size: 15 }),
    claudeOnly: true,
    alias: "disk size cleanup",
  },
  { to: "/settings", label: "Settings", icon: IconSettings({ size: 15 }) },
];

/** The theme cycle, in the order the shortcut walks it. High contrast is in
 *  the ring rather than hidden in Settings: somebody who needs it needs it on
 *  a bad screen in a bright room, which is not the moment to go looking. */
const NEXT_THEME = {
  system: "dark",
  dark: "light",
  light: "contrast",
  contrast: "system",
} as const;

/**
 * Move to the next or previous project, wrapping.
 *
 * Wrapping here and not in the arrow keys that walk the dock: this is a cycle
 * through a small set of things somebody is switching between, and the list of
 * tabs is a list you can get lost in.
 */
export function stepProject(by: number): void {
  const list = workspace.projects;
  const next = from(
    list,
    list.findIndex((p) => p.id === workspace.activeId),
    by,
  );
  if (next) workspace.select(next.id);
}

/**
 * The next item along, wrapping — and the sensible one when there is no
 * current item at all.
 *
 * `at < 0` means nothing here is selected: a page with no card of its own, a
 * project list that has just loaded. Pressing "next" should then land on the
 * FIRST item and "previous" on the LAST, which is where those two keys point
 * when the list is thought of as a ring you are stepping onto. Treating "no
 * selection" as index 0 gave the first item for both, so pressing up from
 * nowhere went down.
 */
export function from<T>(list: T[], at: number, by: number): T | undefined {
  if (list.length === 0) return undefined;
  if (at < 0) return by > 0 ? list[0] : list[list.length - 1];
  return list[((at + by) % list.length + list.length) % list.length];
}

/**
 * Move to the next thing in the LEFT panel — the dock.
 *
 * One flat walk over every conversation and shell, in the order they are
 * drawn, across every project. Crossing from the last row of one project into
 * the first of the next is what the eye expects from a list that is all on
 * screen at once, and selecting a pane selects its project anyway.
 *
 * Project rows are not stops of their own. A project row is a way of reaching
 * its conversations, and this walk already visits every one of them — stopping
 * on the heading first would mean two presses to reach what one press reaches
 * now.
 */
export function stepPane(by: number): void {
  const rows = workspace.projects.flatMap((p) => panesOf(p.id));
  const showing = activePane(workspace.activeId)?.id ?? "";
  const next = from(rows, rows.findIndex((pane) => pane.id === showing), by);
  if (!next) return;
  workspace.selectPane(next.id);
  showPane(next);
}

/** Put a pane on screen. A shell is arrived at to watch; a conversation is
 *  arrived at to talk to, so it gets the cursor. */
function showPane(pane: Pane): void {
  if (pane.kind === "console") {
    go("/console");
    return;
  }
  go("/", true);
  focusComposerSoon();
}

/** Alt N: another conversation in the project you are in, cursor in its box. */
export async function newChat(projectId = workspace.activeId): Promise<void> {
  if (!await workspace.addPane(projectId, "session")) return;
  go("/", true);
  focusComposerSoon();
}

/**
 * Alt C: make a shell, with an optional command to run in it.
 *
 * Order matters, and it took a wrong one to see why: the shell is made
 * FIRST, and only then does a pane point at it. Adding the pane is what
 * makes it the active one, and a Console page that is already open reacts to
 * that at once by starting a shell for it — a plain shell, with no command,
 * because the launcher had not got that far yet. The dock's own start then
 * killed that one and began again, so `deno task start` never ran and the
 * tab read "exited 0".
 *
 * The id is minted here so the terminal can exist before anything points at
 * it. Two calls rather than one cross-cell method: the dock owns the pane,
 * the console cell owns the terminal, and the id is what joins them.
 */
export async function openConsole(
  projectId = workspace.activeId,
  title = "",
  command = "",
): Promise<void> {
  if (!workspace.projects.some((p) => p.id === projectId)) return;
  const id = crypto.randomUUID();
  // Empty strings, not `undefined`. These arguments cross a JSON wire, where
  // `undefined` silently becomes "absent" or `null` — the server then
  // receives something other than what was passed, which the runtime warns
  // about and which is a real difference the moment anything reads it back.
  await consoleCell.open(id, projectId, { title, command });
  const pane = await workspace.addPane(projectId, "console", id, command);
  if (!pane) return;
  if (title !== "") await workspace.renamePane(id, title);
  go("/console");
}

/**
 * Close the conversation or shell you are looking at.
 *
 * The pane and whatever fills it go together: a shell is ended, a conversation
 * is let go. The last conversation in a project stays — `removePane` refuses
 * it, because a Chat page with nothing to show has no way back.
 */
export async function closePane(): Promise<void> {
  const pid = workspace.activeId;
  const pane = activePane(pid);
  if (!pane) return;
  // Asked before the close: afterwards the route says nothing about the pane.
  const onProject = atRoute(pane.kind === "console" ? "/console" : "/", true);
  if (pane.kind === "console") void consoleCell.remove(pane.id);
  // Awaited: a cell write lands a dispatch later, and reading the active pane
  // before it does would find the one just closed.
  await workspace.removePane(pane.id);
  // On the Project tab, show whatever took its place — a Console page left
  // over a conversation lights no card at all. Anywhere else, stay put.
  const next = activePane(pid);
  if (onProject && next && next.id !== pane.id) showPane(next);
}

/**
 * Which rail card a route lights up.
 *
 * The first card is Chat or Console — whichever the dock is showing — so the
 * two paths are one tab. Counting them apart would make "back" from Settings
 * land on a shell the dock has since moved away from.
 */
export const railTab = (path: string): string => {
  const clean = path.replace(/(.)\/$/, "$1");
  return clean === "/console" ? "/" : clean;
};

/** The tab on screen, and the one before it. */
export type TabTrail = { current: string; previous: string };

/**
 * The trail after arriving at `path`.
 *
 * Staying on the same tab changes nothing — a re-render, or the dock moving
 * between two chats, is not a new tab, and counting it would make "back" go
 * nowhere.
 */
export const arrive = (trail: TabTrail, path: string): TabTrail => {
  const tab = railTab(path);
  return tab === trail.current
    ? trail
    : { current: tab, previous: trail.current };
};

/* Module-local and written during render, not a cell: a cell write lands a
   dispatch later, and Alt G pressed right after a navigation would read the
   stale trail. */
let trail: TabTrail = { current: "", previous: "" };

/** Tell the trail where the router is. Called by the shell on every render. */
export function noteRoute(path: string): void {
  trail = arrive(trail, path);
}

/**
 * Alt G: back to the tab you were on before this one. Pressed twice, it comes
 * back again — the same toggle as switching between two windows.
 */
export function backToTab(): void {
  const to = trail.previous;
  if (to === "") return;
  // A Claude-only page after a switch to a local engine: its card is gone,
  // and the router would show the local chat under the wrong name.
  if (activeIsLocal() && PAGES.some((p) => p.to === to && p.claudeOnly)) {
    return;
  }
  if (to !== "/") {
    go(to);
    return;
  }
  // The Project tab: whichever pane the dock is showing now.
  if (activePane(workspace.activeId)?.kind === "console") {
    go("/console");
    return;
  }
  go("/", true);
  focusComposerSoon();
}

/**
 * Put the cursor in the composer as soon as there is one.
 *
 * Arriving at a conversation and arriving at its text box are the same act:
 * you came here to say something. But the box does not exist yet at the moment
 * the navigation is asked for — the page has not rendered, and on a switch
 * between two chats in one project it is the same page rendering different
 * content, so there is no mount to hook. Hence the retry: try each frame until
 * the box is there, and give up quickly if it never is, which is what happens
 * when the destination turns out to have no composer at all.
 */
export function focusComposerSoon(): void {
  if (typeof requestAnimationFrame === "undefined") return;
  // Twelve frames, about a fifth of a second. Long enough for a page to draw,
  // short enough that a stray attempt cannot steal the cursor from someone who
  // has started typing somewhere else in the meantime.
  //
  // It keeps watching for the whole window rather than stopping at the first
  // success, because the first success does not always hold: switching between
  // two conversations re-renders a page that is already on screen, and a
  // textarea replaced a frame after being focused takes the cursor with it.
  // Measured — one transition in five landed on `body`.
  let left = 12;
  const tick = () => {
    if (typeof document !== "undefined") {
      const at = document.activeElement;
      // Already there, or the person has gone somewhere else deliberately —
      // either way this has no business taking the cursor.
      if (!at?.closest?.(".composer")) focusComposer();
    }
    if (--left > 0) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

/** Focus whatever the page in front of you uses for typing. Used by the
 *  composer shortcut, and by the palette after it closes — a command that
 *  leaves you with nowhere to type has only done half its job. */
export function focusComposer(): boolean {
  if (typeof document === "undefined") return false;
  const box = document.querySelector<HTMLTextAreaElement>(".composer textarea");
  if (!box) return false;
  box.focus();
  return true;
}

/**
 * Everything that can be done right now, newest context first.
 *
 * Order matters: the palette shows this list unfiltered when it opens, and the
 * first screenful should be the things somebody actually reaches for.
 */
export function commands(): Command[] {
  const out: Command[] = [];
  const isLocal = activeIsLocal();
  const active = workspace.activeId;
  const status = isLocal ? localChat(active).status : view().status;

  /* ── go ─────────────────────────────────────────────────────────────── */
  for (const p of PAGES) {
    if (p.claudeOnly && isLocal) continue;
    out.push({
      id: `go:${p.to}`,
      group: "Go",
      label: p.label,
      hint: "Open the page",
      icon: p.icon,
      alias: p.alias,
      run: () => go(p.to),
    });
  }

  /* ── projects ───────────────────────────────────────────────────────── */
  /* Next and previous, for the tenth project onwards — and for anybody who
     would rather step through than remember which number a project is. */
  if (workspace.projects.length > 1) {
    out.push(
      {
        id: "project:next",
        group: "Switch to",
        label: "Next project",
        icon: IconFolder({ size: 15 }),
        run: () => stepProject(1),
      },
      {
        id: "project:prev",
        group: "Switch to",
        label: "Previous project",
        icon: IconFolder({ size: 15 }),
        run: () => stepProject(-1),
      },
    );
  }

  workspace.projects.forEach((p) => {
    if (p.id === active) return;
    out.push({
      id: `project:${p.id}`,
      group: "Switch to",
      label: p.name,
      hint: p.missing ? "Folder is gone" : p.path,
      icon: IconFolder({ size: 15 }),
      alias: p.path,
      run: () => workspace.select(p.id),
    });
  });

  /* ── session ────────────────────────────────────────────────────────── */
  if (!isLocal) {
    if (status === "offline" || status === "error") {
      out.push({
        id: "session:start",
        group: "Session",
        label: "Start session",
        hint: "Spawn the Claude Code CLI here",
        icon: IconPower({ size: 15 }),
        run: () => void session.start(),
      });
    } else {
      out.push({
        id: "session:stop",
        group: "Session",
        label: "Stop session",
        hint: "Ends the CLI process; the transcript stays",
        icon: IconPower({ size: 15 }),
        run: () => void session.stop(),
      });
    }
    if (status !== "offline" && status !== "error") {
      out.push({
        id: "session:restart",
        group: "Session",
        label: "Restart, keeping the context",
        hint:
          "New process, same conversation — the CLI is handed its session id",
        icon: IconRefresh({ size: 15 }),
        alias: "reload respawn resume",
        run: () => void session.start(true),
      });
      out.push({
        id: "session:fresh",
        group: "Session",
        label: "Restart with a blank context",
        hint: "A new session that remembers nothing",
        icon: IconRefresh({ size: 15 }),
        danger: true,
        alias: "reset new forget",
        run: () => void session.start(false),
      });
    }
    if (status === "working") {
      out.push({
        id: "session:interrupt",
        group: "Session",
        label: "Interrupt the turn",
        hint: "Stops what it is doing now",
        icon: IconPower({ size: 15 }),
        run: () => void session.interrupt(),
      });
    }
    if (view().error !== null && status !== "working") {
      out.push({
        id: "session:retry",
        group: "Session",
        label: "Send the last message again",
        hint: "The turn failed; the session kept its context",
        icon: IconRefresh({ size: 15 }),
        alias: "retry again resend",
        run: () => void session.retry(),
      });
    }

    out.push({
      id: "session:clear",
      group: "Session",
      label: "Clear the transcript",
      hint: "Empties the view; the CLI keeps its own memory",
      icon: IconTrash({ size: 15 }),
      danger: true,
      alias: "empty wipe",
      run: () => {
        session.clearTranscript();
        showToast({
          text: "Transcript cleared. The CLI still remembers the conversation.",
          action: { label: "Undo", run: () => session.undoClear() },
        });
      },
    });
  } else {
    out.push({
      id: "local:clear",
      group: "Session",
      label: "Clear the conversation",
      hint: "Starts the local model on a blank slate",
      icon: IconTrash({ size: 15 }),
      danger: true,
      alias: "empty wipe reset",
      run: () => {
        const key = activeSessionKey();
        void local.clear(key);
        showToast({
          text: "Conversation cleared.",
          action: { label: "Undo", run: () => void local.undoClear(key) },
        });
      },
    });
    out.push({
      id: "local:detect",
      group: "Session",
      label: "Scan for local servers",
      hint: "Looks for LM Studio, Ollama and llama.cpp",
      icon: IconRefresh({ size: 15 }),
      alias: "discover port find",
      run: () => void local.detect(),
    });
  }

  // Machine-wide, so it is offered whatever this project is running.
  if (workspace.projects.length > 1) {
    out.push({
      id: "session:stop-all",
      group: "Session",
      label: "Stop every session",
      hint: "Ends the CLI process in every project; transcripts are kept",
      icon: IconPower({ size: 15 }),
      danger: true,
      alias: "quit kill all shutdown",
      run: () => void session.stopAll(),
    });
  }

  out.push({
    id: "project:add",
    group: "Project",
    label: "Add a project…",
    hint: "Point the app at another folder",
    icon: IconPlus({ size: 15 }),
    alias: "new folder open directory",
    run: () => go("/settings"),
  });

  /* ── reading aloud ──────────────────────────────────────────────────── */
  // Only once there is something to read with. The speaker on the message bar
  // is the everyday control; these are here because the palette is where
  // people look for a thing they cannot see, and "make it stop" is the most
  // urgent request this feature can receive.
  if (speechReady()) {
    const talking = speech.status === "speaking";
    out.push({
      id: "speech:toggle",
      group: "Appearance",
      label: speechOn() ? "Stop reading replies aloud" : "Read replies aloud",
      hint: speechOn()
        ? "Back to silence"
        : "What you send and what comes back, in two voices",
      alias: "speak voice tts speaker say out loud",
      run: () => (speechOn() ? stopReading() : startReading()),
    });
    if (talking) {
      out.push({
        id: "speech:hush",
        group: "Appearance",
        label: "Skip this one",
        hint: "Stop the sentence being read, and keep reading the next",
        alias: "shut up quiet silence stop skip",
        run: () => void speech.hush(),
      });
    }
  }

  /* ── this page ─────────────────────────────────────────────────────── */
  out.push({
    id: "view:find",
    group: "Appearance",
    label: "Find in this conversation",
    hint: "Matches highlighted, Enter walks them",
    icon: IconSearch({ size: 15 }),
    alias: "search find text",
    run: () => openFind(),
  });

  /* ── appearance ─────────────────────────────────────────────────────── */
  out.push(
    {
      id: "view:theme",
      group: "Appearance",
      label: `Theme: ${workspace.theme}`,
      hint: `Switch to ${NEXT_THEME[workspace.theme]}`,
      alias: "dark light colour scheme",
      run: () => workspace.setTheme(NEXT_THEME[workspace.theme]),
    },
    {
      id: "view:zoom-in",
      group: "Appearance",
      label: "Zoom in",
      hint: `Now ${Math.round(prefs.zoom * 100)}%`,
      alias: "bigger font size larger text",
      run: () => prefs.zoomBy(ZOOM_STEP),
    },
    {
      id: "view:zoom-out",
      group: "Appearance",
      label: "Zoom out",
      hint: `Now ${Math.round(prefs.zoom * 100)}%`,
      alias: "smaller font size",
      run: () => prefs.zoomBy(-ZOOM_STEP),
    },
    {
      id: "view:zoom-reset",
      group: "Appearance",
      label: "Reset zoom to 100%",
      alias: "actual size",
      run: () => prefs.resetZoom(),
    },
    {
      id: "view:density",
      group: "Appearance",
      label: prefs.density === "cozy" ? "Compact layout" : "Comfortable layout",
      hint: "How much air the furniture gets",
      alias: "dense tight spacing",
      run: () =>
        prefs.setDensity(prefs.density === "cozy" ? "compact" : "cozy"),
    },
    {
      id: "view:dock",
      group: "Appearance",
      label: prefs.dockCollapsed ? "Show project names" : "Collapse projects",
      hint: "The left panel",
      alias: "sidebar hide dock",
      run: () => prefs.toggleDock(),
    },
    {
      id: "view:rail",
      group: "Appearance",
      label: prefs.railCollapsed ? "Show section names" : "Collapse sections",
      hint: "The right panel",
      alias: "sidebar hide rail",
      run: () => prefs.toggleRail(),
    },
    {
      id: "view:stamps",
      group: "Appearance",
      label: prefs.timestamps ? "Hide message times" : "Show message times",
      alias: "timestamp clock when",
      run: () => prefs.setTimestamps(!prefs.timestamps),
    },
    {
      id: "view:wrap",
      group: "Appearance",
      label: prefs.codeWrap ? "Scroll long code lines" : "Wrap long code lines",
      alias: "code block overflow",
      run: () => prefs.setCodeWrap(!prefs.codeWrap),
    },
  );

  return out;
}

/**
 * Does this event match a chord that must work even inside a terminal?
 *
 * Asked by the console, which otherwise swallows everything. It is answered
 * from the same table the shortcuts themselves come from, so a chord cannot be
 * listed in help as working everywhere and then be eaten by a shell.
 */
export function worksInTerminal(e: KeyboardEvent): boolean {
  const mod = e.ctrlKey || e.metaKey;
  return globalBindings().some((b) =>
    b.everywhere === true &&
    b.key.toLowerCase() === e.key.toLowerCase() &&
    !!b.chord.mod === mod &&
    !!b.chord.alt === e.altKey &&
    !!b.chord.shift === e.shiftKey
  );
}

/**
 * One global key binding.
 *
 * Bindings are *data*, not calls, for a reason that bites otherwise:
 * `onGlobalKey` is a hook, so it must be called the same number of times in
 * the same order on every render. The table below has a fixed length, and the
 * component that installs it just loops.
 */
export type Binding = {
  /** The key as `KeyboardEvent.key` reports it. */
  key: string;
  chord: {
    mod?: boolean;
    shift?: boolean;
    alt?: boolean;
    ignoreInInput?: boolean;
  };
  /** How the chord is written in help, e.g. "Alt S". */
  keys: string;
  /** What it does, in the imperative. Shown in the shortcuts panel. */
  label: string;
  /** The group it is filed under in help. */
  group: string;
  /**
   * This chord works even while a terminal has focus.
   *
   * A focused terminal eats every keystroke — that is what a terminal is for,
   * and `vim` needs `Escape` far more than this app does. But moving around
   * the app is not typing into a shell, and having to click away before
   * `Alt ↓` works is a worse trade than losing one chord inside the shell.
   *
   * So each binding says which side of that line it is on, and the console
   * declines exactly the ones marked here — see `worksInTerminal`. The rule
   * for choosing: navigation and view, yes; anything a shell or a program
   * running in one would want, no.
   */
  everywhere?: boolean;
  run: (e: KeyboardEvent) => void;
};

/**
 * Every global shortcut, in help order.
 *
 * The shortcut list in Settings reads this, so a key that is listed is a key
 * that works.
 */
export function globalBindings(): Binding[] {
  // This list and no more, by request — none of them on Ctrl, which belongs
  // to the page and the shell. Alt ↑/↓ walk the conversations and shells,
  // Alt PgUp/PgDn the projects, and Alt N / C / W make and close panes. The
  // right panel gets two jumps instead of a walk: Alt S to Settings and Alt G
  // back to the tab before. Escape brings you back to the conversation, and a
  // second one stops its turn. Push to talk is its own listener, in `pushToTalk.ts`, because it
  // acts on key UP as well.
  //
  // `mod: false` on each Alt chord: without it Ctrl Alt — which is AltGr on
  // many layouts, and how people type characters — would fire them too.
  return [
    {
      key: "ArrowDown",
      chord: { alt: true, mod: false, ignoreInInput: false },
      keys: "Alt ↓",
      group: "Move",
      everywhere: true,
      label: "Next conversation or shell (left panel)",
      run: (e) => {
        e.preventDefault();
        stepPane(1);
      },
    },
    {
      key: "ArrowUp",
      chord: { alt: true, mod: false, ignoreInInput: false },
      keys: "Alt ↑",
      group: "Move",
      everywhere: true,
      label: "Previous conversation or shell (left panel)",
      run: (e) => {
        e.preventDefault();
        stepPane(-1);
      },
    },
    {
      key: "s",
      chord: { alt: true, mod: false, ignoreInInput: false },
      keys: "Alt S",
      group: "Move",
      everywhere: true,
      label: "Go to Settings (right panel)",
      run: (e) => {
        e.preventDefault();
        go("/settings");
      },
    },
    {
      key: "g",
      chord: { alt: true, mod: false, ignoreInInput: false },
      keys: "Alt G",
      group: "Move",
      everywhere: true,
      label: "Back to the tab before (right panel)",
      run: (e) => {
        e.preventDefault();
        backToTab();
      },
    },
    {
      key: "PageDown",
      chord: { alt: true, mod: false, ignoreInInput: false },
      keys: "Alt PgDn",
      group: "Move",
      everywhere: true,
      label: "Next project tab (left panel)",
      run: (e) => {
        e.preventDefault();
        stepProject(1);
      },
    },
    {
      key: "PageUp",
      chord: { alt: true, mod: false, ignoreInInput: false },
      keys: "Alt PgUp",
      group: "Move",
      everywhere: true,
      label: "Previous project tab (left panel)",
      run: (e) => {
        e.preventDefault();
        stepProject(-1);
      },
    },
    {
      key: "n",
      chord: { alt: true, mod: false, ignoreInInput: false },
      keys: "Alt N",
      group: "Panes",
      everywhere: true,
      label: "New conversation in this project",
      run: (e) => {
        e.preventDefault();
        void newChat();
      },
    },
    {
      key: "c",
      chord: { alt: true, mod: false, ignoreInInput: false },
      keys: "Alt C",
      group: "Panes",
      everywhere: true,
      label: "New console in this project",
      run: (e) => {
        e.preventDefault();
        void openConsole();
      },
    },
    {
      key: "w",
      chord: { alt: true, mod: false, ignoreInInput: false },
      keys: "Alt W",
      group: "Panes",
      everywhere: true,
      label: "Close this conversation or console",
      run: (e) => {
        e.preventDefault();
        void closePane();
      },
    },
    {
      // Deliberately NOT `everywhere`: in a terminal, Escape belongs to the
      // program running there (`vim` cannot live without it).
      key: "Escape",
      chord: { ignoreInInput: false },
      keys: "Esc",
      group: "Move",
      label: "Back to the conversation — pressed again, stop its turn",
      run: (e) => {
        // An open menu, dialog or overlay closes with Escape first — each of
        // those calls preventDefault — and only a second press comes here.
        if (e.defaultPrevented || overlayOpen()) return;
        backToChat();
      },
    },
  ];
}

/**
 * Escape: back to the conversation you were in, with the cursor in its box.
 *
 * From a shell tab, the project's conversation it sits beside; from another
 * page, the chat page. Already there, it stops the turn that is running — the
 * same as the Stop button, so the session and the transcript stay — and puts
 * the cursor back. So one Escape is "let me keep typing", and the next is
 * "stop, I want to say something else".
 */
export function backToChat(): void {
  const pid = workspace.activeId;
  const panes = panesOf(pid);
  // `activePane`, not a lookup of `workspace.activePane[pid]`: a project whose
  // panes were never written has a conversation that no id points at.
  const current = activePane(pid);
  if (current?.kind === "session" && atRoute("/", true)) {
    if (activeIsLocal()) void local.stop(activeSessionKey());
    else void session.interrupt();
    focusComposer();
    return;
  }
  if (current && current.kind !== "session") {
    const chat = panes.filter((p) => p.kind === "session").pop();
    if (chat) workspace.selectPane(chat.id);
  }
  go("/", true);
  focusComposerSoon();
}

/**
 * The shortcuts worth printing, one row each.
 *
 * Two kinds of duplicate are dropped: the eight repeats of "switch to project
 * N", whose labels are empty, and the alternate spellings of one chord — the
 * plus key arrives as "=" or "+" depending on the shift state and the keyboard,
 * and a help panel that listed "Ctrl +" twice would look like a bug.
 */
export function helpRows(): Binding[] {
  const seen = new Set<string>();
  return globalBindings().filter((b) => {
    if (b.label === "" || seen.has(b.keys)) return false;
    seen.add(b.keys);
    return true;
  });
}
