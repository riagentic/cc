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
import { go } from "./go.ts";
import { type VNode } from "aio/air";
import { activePane, panesOf, workspace } from "../cell/workspace.ts";
import { consoleCell } from "../cell/console.ts";
import { session, view } from "../cell/session.ts";
import { activeIsLocal, local, localChat } from "../cell/local.ts";
import { prefs, ZOOM_STEP } from "../cell/prefs.ts";
import { showToast } from "./toast.tsx";
import { overlayOpen } from "./overlays.tsx";
import { openFind } from "./find.tsx";
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
  IconSettings,
  IconSpark,
  IconTasks,
  IconTrash,
  IconTree,
} from "./icons.tsx";

/** One thing the app can be asked to do. */
export type Command = {
  id: string;
  label: string;
  /** The second line: which project, which page, what it will cost you. */
  hint?: string;
  group: string;
  /** The chord, written the way it is pressed. Display only — the binding
   *  itself lives in `bindings()`, so the two are generated from one row. */
  keys?: string;
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
  if (next.kind === "console") {
    go("/console");
    return;
  }
  go("/", true);
  // A shell is arrived at to watch; a conversation is arrived at to talk to.
  focusComposerSoon();
}

/**
 * Close the conversation or shell you are looking at.
 *
 * The pane and whatever fills it go together: a shell is ended, a conversation
 * is let go. The last conversation in a project stays — `removePane` refuses
 * it, because a Chat page with nothing to show has no way back.
 */
export function closePane(): void {
  const pane = activePane(workspace.activeId);
  if (!pane) return;
  if (pane.kind === "console") void consoleCell.remove(pane.id);
  workspace.removePane(pane.id);
}

/**
 * Move to the next page in the RIGHT panel — the rail.
 *
 * Read off the DOM rather than from a list of routes, and deliberately: the
 * rail hides cards that do not apply — a local project has no sub-agents, a
 * Claude one has no engine settings — so a list written here would drift from
 * what is on screen, and stepping would land on a page that is not offered.
 * The cards themselves are the list.
 */
export function stepRail(by: number): void {
  if (typeof document === "undefined") return;
  const cards = [...document.querySelectorAll<HTMLAnchorElement>(
    ".rail .navcard",
  )];
  const at = cards.findIndex((c) => c.classList.contains("active"));
  const to = from(cards, at, by)?.getAttribute("href");
  if (to) go(to);
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
        keys: "Ctrl ]",
        icon: IconFolder({ size: 15 }),
        run: () => stepProject(1),
      },
      {
        id: "project:prev",
        group: "Switch to",
        label: "Previous project",
        keys: "Ctrl [",
        icon: IconFolder({ size: 15 }),
        run: () => stepProject(-1),
      },
    );
  }

  workspace.projects.forEach((p, i) => {
    if (p.id === active) return;
    out.push({
      id: `project:${p.id}`,
      group: "Switch to",
      label: p.name,
      hint: p.missing ? "Folder is gone" : p.path,
      icon: IconFolder({ size: 15 }),
      keys: i < 9 ? `Ctrl ${i + 1}` : undefined,
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
        keys: "Esc",
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
        void local.clear();
        showToast({
          text: "Conversation cleared.",
          action: { label: "Undo", run: () => void local.undoClear() },
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

  /* ── appearance ─────────────────────────────────────────────────────── */
  out.push(
    {
      id: "view:theme",
      group: "Appearance",
      label: `Theme: ${workspace.theme}`,
      hint: `Switch to ${NEXT_THEME[workspace.theme]}`,
      keys: "Ctrl Shift L",
      alias: "dark light colour scheme",
      run: () => workspace.setTheme(NEXT_THEME[workspace.theme]),
    },
    {
      id: "view:zoom-in",
      group: "Appearance",
      label: "Zoom in",
      hint: `Now ${Math.round(prefs.zoom * 100)}%`,
      keys: "Ctrl +",
      alias: "bigger font size larger text",
      run: () => prefs.zoomBy(ZOOM_STEP),
    },
    {
      id: "view:zoom-out",
      group: "Appearance",
      label: "Zoom out",
      hint: `Now ${Math.round(prefs.zoom * 100)}%`,
      keys: "Ctrl -",
      alias: "smaller font size",
      run: () => prefs.zoomBy(-ZOOM_STEP),
    },
    {
      id: "view:zoom-reset",
      group: "Appearance",
      label: "Reset zoom to 100%",
      keys: "Ctrl 0",
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
      keys: "Ctrl B",
      alias: "sidebar hide dock",
      run: () => prefs.toggleDock(),
    },
    {
      id: "view:rail",
      group: "Appearance",
      label: prefs.railCollapsed ? "Show section names" : "Collapse sections",
      hint: "The right panel",
      keys: "Ctrl Shift B",
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
  return globalBindings({ openPalette: noop, openHelp: noop }).some((b) =>
    b.everywhere === true &&
    b.key.toLowerCase() === e.key.toLowerCase() &&
    !!b.chord.mod === mod &&
    !!b.chord.alt === e.altKey &&
    !!b.chord.shift === e.shiftKey
  );
}

const noop = () => {};

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
  /** How the chord is written in help, e.g. "Ctrl K". */
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
   * `Ctrl ↓` works is a worse trade than losing one chord inside the shell.
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
 * The palette and the help panel both read this, so a key that is listed is a
 * key that works. Two callbacks come from the shell because they toggle
 * something the shell owns rather than something in a cell.
 */
export function globalBindings(
  ui: { openPalette: () => void; openHelp: () => void },
): Binding[] {
  const list: Binding[] = [
    {
      key: "k",
      chord: { mod: true, ignoreInInput: false },
      keys: "Ctrl K",
      group: "App",
      everywhere: true,
      label: "Command palette — every action, by name",
      run: (e) => {
        e.preventDefault();
        ui.openPalette();
      },
    },
    {
      key: "?",
      chord: {},
      keys: "?",
      group: "App",
      label: "Keyboard shortcuts",
      run: (e) => {
        e.preventDefault();
        ui.openHelp();
      },
    },
    {
      key: "/",
      chord: {},
      keys: "/",
      group: "App",
      label: "Jump to the filter box on this page",
      run: (e) => {
        // The filter belonging to the PAGE, not the one in the project dock —
        // which comes first in the DOM and would otherwise win every time.
        const box =
          document.querySelector<HTMLInputElement>(".main .input--search") ??
            document.querySelector<HTMLInputElement>(".input--search");
        if (!box) return;
        e.preventDefault();
        box.focus();
        box.select();
      },
    },
    {
      key: "Escape",
      chord: { ignoreInInput: false },
      keys: "Esc",
      group: "Session",
      label: "Interrupt the turn that is running",
      run: (e) => {
        // Three things already own Escape: an overlay closes with it, the
        // composer uses it to abandon a recalled turn, and a menu closes with
        // it. Each of those calls preventDefault, so this fires only when
        // nothing nearer to the user wanted it.
        if (e.defaultPrevented || overlayOpen()) return;
        if (activeIsLocal()) {
          if (localChat(workspace.activeId).status !== "working") return;
          void local.stop();
        } else {
          if (view().status !== "working") return;
          void session.interrupt();
        }
      },
    },
    {
      key: "f",
      chord: { mod: true, ignoreInInput: false },
      keys: "Ctrl F",
      group: "App",
      label: "Find in this conversation",
      run: (e) => {
        e.preventDefault();
        openFind();
      },
    },
    {
      key: "i",
      chord: { mod: true, ignoreInInput: false },
      keys: "Ctrl I",
      group: "App",
      label: "Put the cursor in the message box",
      run: (e) => {
        if (focusComposer()) e.preventDefault();
      },
    },
    {
      key: "b",
      chord: { mod: true, shift: false, ignoreInInput: false },
      keys: "Ctrl B",
      group: "View",
      label: "Collapse or show the project panel",
      run: (e) => {
        e.preventDefault();
        prefs.toggleDock();
      },
    },
    {
      key: "b",
      chord: { mod: true, shift: true, ignoreInInput: false },
      keys: "Ctrl Shift B",
      group: "View",
      label: "Collapse or show the section panel",
      run: (e) => {
        e.preventDefault();
        prefs.toggleRail();
      },
    },
    {
      key: "l",
      chord: { mod: true, shift: true, ignoreInInput: false },
      keys: "Ctrl Shift L",
      group: "View",
      label: "Cycle theme: system, dark, light",
      run: (e) => {
        e.preventDefault();
        workspace.setTheme(NEXT_THEME[workspace.theme]);
      },
    },
    {
      // Deliberately NOT `everywhere`. `Ctrl [` IS `Escape` — the same byte,
      // 0x1b — so taking it from a focused terminal would take Escape from
      // `vim`, and `Ctrl ]` is how `telnet` and `gdb` are interrupted. The
      // arrow versions of these two do the same job and cost the shell
      // nothing it needs as badly.
      key: "]",
      chord: { mod: true, ignoreInInput: false },
      keys: "Ctrl ]",
      group: "Projects",
      label: "Next project",
      run: (e) => {
        e.preventDefault();
        stepProject(1);
      },
    },
    {
      key: "[",
      chord: { mod: true, ignoreInInput: false },
      keys: "Ctrl [",
      group: "Projects",
      label: "Previous project",
      run: (e) => {
        e.preventDefault();
        stepProject(-1);
      },
    },
    {
      // Ctrl for the left panel, Alt for the right. One rule, so a chord you
      // have not learned is still guessable from where you are looking.
      key: "ArrowDown",
      chord: { mod: true, ignoreInInput: false },
      keys: "Ctrl ↓",
      group: "Projects",
      everywhere: true,
      label: "Next conversation or shell (left panel)",
      run: (e) => {
        e.preventDefault();
        stepPane(1);
      },
    },
    {
      key: "ArrowUp",
      chord: { mod: true, ignoreInInput: false },
      keys: "Ctrl ↑",
      group: "Projects",
      everywhere: true,
      label: "Previous conversation or shell (left panel)",
      run: (e) => {
        e.preventDefault();
        stepPane(-1);
      },
    },
    {
      // Deliberately NOT `everywhere`. `Ctrl W` is readline's delete-the-last-
      // word, used constantly in a shell, and a terminal you are typing in has
      // its own way out that this app has no business overriding: `exit`, or
      // `Ctrl D`, which now closes the tab too.
      key: "w",
      chord: { mod: true, ignoreInInput: false },
      keys: "Ctrl W",
      group: "Projects",
      label: "Close this conversation or shell",
      run: (e) => {
        // Electron would close the WINDOW otherwise, which is a considerably
        // larger thing than the tab that was asked for.
        e.preventDefault();
        closePane();
      },
    },
    {
      // Down and up walk every row; left and right skip a whole project. Both
      // rotate, so the end of the list is never a dead end.
      key: "ArrowRight",
      chord: { mod: true, ignoreInInput: false },
      keys: "Ctrl →",
      group: "Projects",
      everywhere: true,
      label: "Next project (left panel)",
      run: (e) => {
        e.preventDefault();
        stepProject(1);
      },
    },
    {
      key: "ArrowLeft",
      chord: { mod: true, ignoreInInput: false },
      keys: "Ctrl ←",
      group: "Projects",
      everywhere: true,
      label: "Previous project (left panel)",
      run: (e) => {
        e.preventDefault();
        stepProject(-1);
      },
    },
    {
      key: "ArrowDown",
      chord: { alt: true, ignoreInInput: false },
      keys: "Alt ↓",
      group: "App",
      everywhere: true,
      label: "Next page (right panel)",
      run: (e) => {
        e.preventDefault();
        stepRail(1);
      },
    },
    {
      key: "ArrowUp",
      chord: { alt: true, ignoreInInput: false },
      keys: "Alt ↑",
      group: "App",
      everywhere: true,
      label: "Previous page (right panel)",
      run: (e) => {
        e.preventDefault();
        stepRail(-1);
      },
    },
    {
      key: "0",
      chord: { mod: true, ignoreInInput: false },
      keys: "Ctrl 0",
      group: "View",
      label: "Reset zoom to 100%",
      run: (e) => {
        e.preventDefault();
        prefs.resetZoom();
      },
    },
  ];

  // Zoom. Four keys, not two: the plus on the main row arrives as "=" without
  // shift and "+" with it, and the numeric keypad sends its own. A shortcut
  // that works on one keyboard and not another is the kind of detail people
  // give up on rather than report.
  for (const key of ["=", "+"]) {
    list.push({
      key,
      chord: { mod: true, ignoreInInput: false },
      keys: "Ctrl +",
      group: "View",
      label: "Zoom in",
      run: (e) => {
        e.preventDefault();
        prefs.zoomBy(ZOOM_STEP);
      },
    });
  }
  for (const key of ["-", "_"]) {
    list.push({
      key,
      chord: { mod: true, ignoreInInput: false },
      keys: "Ctrl -",
      group: "View",
      label: "Zoom out",
      run: (e) => {
        e.preventDefault();
        prefs.zoomBy(-ZOOM_STEP);
      },
    });
  }

  // Project switching. Nine, because the tenth would need two keys and the
  // list is a click away.
  for (let n = 1; n <= 9; n++) {
    list.push({
      key: String(n),
      chord: { mod: true, ignoreInInput: false },
      keys: "Ctrl " + n,
      group: "Projects",
      label: n === 1 ? "Switch to project 1 … 9" : "",
      run: () => {
        const project = workspace.projects[n - 1];
        // Nothing at that position is a no-op, not a wrap-around: a shortcut
        // that lands somewhere unexpected is worse than one that does nothing.
        if (project) workspace.select(project.id);
      },
    });
  }

  return list;
}

/**
 * The shortcuts worth printing, one row each.
 *
 * Two kinds of duplicate are dropped: the eight repeats of "switch to project
 * N", whose labels are empty, and the alternate spellings of one chord — the
 * plus key arrives as "=" or "+" depending on the shift state and the keyboard,
 * and a help panel that listed "Ctrl +" twice would look like a bug.
 */
export function helpRows(
  ui: { openPalette: () => void; openHelp: () => void },
): Binding[] {
  const seen = new Set<string>();
  return globalBindings(ui).filter((b) => {
    if (b.label === "" || seen.has(b.keys)) return false;
    seen.add(b.keys);
    return true;
  });
}
