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
import { navigate, type VNode } from "aio/air";
import { workspace } from "../cell/workspace.ts";
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
  if (list.length < 2) return;
  const at = list.findIndex((p) => p.id === workspace.activeId);
  const next = list[
    ((at < 0 ? 0 : at + by) % list.length + list.length) %
    list.length
  ];
  if (next) workspace.select(next.id);
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
      run: () => navigate(p.to),
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
    run: () => navigate("/settings"),
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
