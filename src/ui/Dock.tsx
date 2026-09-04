/**
 * @module
 * The project dock: one vertical tab per project, on the left.
 *
 * Switching project is the outermost thing you can do in this app — it decides
 * which codebase every other panel is about — so it gets its own column rather
 * than a row inside Settings, where it used to live three scrolls down.
 *
 * A tab says the things that decide whether it is the one you want: the
 * project's name, its branch, whether the directory is still there — and what
 * its **own** conversation is doing.
 *
 * That last one is the reason the dock is worth a column. Every project owns a
 * `claude` of its own and they run concurrently, so a turn you started in one
 * codebase keeps working while you read another. Without a per-tab signal, the
 * only way to find out it had finished — or had stopped to ask you something,
 * and would wait forever — would be to click through every project in the list.
 */
import { useLocal, type VNode } from "aio/air";
import {
  activeProject,
  forgottenProjects,
  workspace,
} from "../cell/workspace.ts";
import { session, sessionOf } from "../cell/session.ts";
import { engineOf, localChat } from "../cell/local.ts";
import type { Project } from "../type/claude.ts";
import { tildePath } from "../lib/format.ts";
import { matches, Search } from "./parts.tsx";
import {
  IconBranch,
  IconPlus,
  IconPower,
  IconRefresh,
  IconTrash,
  IconX,
} from "./icons.tsx";

/** What each status is called, for the tab's tooltip. */
const STATUS_TEXT: Record<string, string> = {
  offline: "Not started",
  starting: "Starting…",
  ready: "Ready",
  working: "Working",
  error: "Error",
};

/** Two letters is enough to tell projects apart at a glance, and is all there
 *  is room for once the dock collapses to icons. Word boundaries first, so
 *  `claude-control` reads `CC` rather than `CL`. */
function initials(name: string): string {
  const parts = name.split(/[^A-Za-z0-9]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).slice(0, 2);
  return (parts[0] ?? name).slice(0, 2);
}

function ProjectTab(
  props: { project: Project; active: boolean; index: number },
): VNode {
  const p = props.project;
  // The first nine get a number, because that is what Mod+1…9 reaches. Stated
  // in the tooltip rather than printed on the tab: it is a fact about the
  // keyboard, not about the project.
  const chord = props.index < 9 ? `\nCtrl/Cmd+${props.index + 1}` : "";
  // This project's own conversation, whether or not it is the one on screen.
  const s = sessionOf(p.id);
  // A project on a local engine has no Claude session — but it can still be
  // stopped, waiting for somebody to allow a command. That is the same signal
  // and the same stakes (nothing moves, forever, until it is answered), so it
  // gets the same dot and the same words.
  const isLocal = engineOf(p.id) !== "claude";
  const holds = isLocal
    ? (localChat(p.id).pending ? 1 : 0)
    : s.permissions.filter((r) => r.status === "pending").length;
  const working = isLocal
    ? localChat(p.id).status === "working"
    : s.status === "working";
  // The session keeps the directory it started in, so "selected" and "where
  // Claude Code is actually working" can differ — and only one of them is the
  // truth about the turn in flight.
  const here = s.cwd !== null && s.cwd === p.path;
  // A session exists when there is a process behind it. `status` alone is not
  // the question — an errored session has no process left to close.
  const running = s.pid !== null;

  const sub = p.missing
    ? "Folder is gone"
    // Waiting on a human leads, because nothing moves until somebody answers
    // and the prompt itself only renders for the project you are looking at.
    : holds > 0
    ? (isLocal
      ? "Command needs approval"
      : `${holds} approval${holds > 1 ? "s" : ""} needed`)
    : working
    ? "Working…"
    : running && !here
    ? "Session is elsewhere"
    : p.branch ?? tildePath(p.path, workspace.home);

  return (
    // A wrapper, not a button: the close control is a button of its own, and a
    // button inside a button is invalid markup that browsers resolve however
    // they like — the row would have had one focus stop and an ambiguous click.
    <div
      class={`ptab${props.active ? " active" : ""}${
        p.missing ? " ptab--missing" : ""
      }`}
    >
      <button
        type="button"
        class="ptab__main"
        aria-pressed={props.active}
        // The name alone, plus the one qualifier that changes what the tab
        // *means*. Announcing the branch and path here would make every tab a
        // sentence to listen through, and both are already in the title.
        aria-label={p.missing ? `${p.name} (folder is gone)` : p.name}
        title={`${p.name}\n${p.path}${
          p.missing
            ? "\nFolder is gone"
            : `\n${STATUS_TEXT[s.status] ?? s.status}`
        }${chord}`}
        onClick={() => workspace.select(p.id)}
      >
        <span class="ptab__mark">{initials(p.name)}</span>
        <span class="ptab__text truncate">
          <span class="ptab__name truncate">{p.name}</span>
          <br />
          <span class="ptab__sub truncate">
            {!p.missing && p.branch && holds === 0 && !working &&
              IconBranch({ size: 10 })}
            <span class="truncate">{sub}</span>
            {p.dirty && !p.missing && holds === 0 && !working && (
              <span title="Uncommitted changes">●</span>
            )}
          </span>
        </span>
      </button>

      {
        /* The signal that survives the tab collapsing to an icon: a dot for a
          live session, and a loud one when it is blocked on the user. It gives
          way to the close control on hover, which is the only thing you would
          reach for in that corner once you can see the session is there. */
      }
      <span
        class={`ptab__state${
          holds > 0
            ? " ptab__state--holds"
            : working
            ? " ptab__state--working"
            : s.status === "ready"
            ? " ptab__state--ready"
            : s.status === "error"
            ? " ptab__state--error"
            : ""
        }`}
        aria-hidden="true"
      />

      {
        /* Two different actions, so two different controls with two different
          icons — a single × that meant "end the session" on a running tab and
          "remove the project" on an idle one is the ambiguity that kept the
          second one out of this column entirely.

          Removing takes one click and no confirmation because it is genuinely
          undoable: it forgets a row, leaves the folder and Claude Code's own
          history alone, and the strip below this list offers it straight back.
          A confirmation on a reversible action is a tax on the common case. */
      }
      <span class="ptab__acts">
        {running && (
          <button
            type="button"
            class="ptab__act"
            title={`End ${p.name}'s session — the conversation is kept, and Resume brings its context back`}
            aria-label={`Close ${p.name} session`}
            onClick={() => session.stop(p.id)}
          >
            {IconPower({ size: 12 })}
          </button>
        )}
        <button
          type="button"
          class="ptab__act ptab__act--danger"
          title={`Remove ${p.name} from this list — the folder and its Claude Code history are untouched, and this can be undone`}
          aria-label={`Remove ${p.name}`}
          onClick={() => workspace.removeProject(p.id)}
        >
          {IconTrash({ size: 12 })}
        </button>
      </span>
    </div>
  );
}

/** The add-a-project field, folded away until asked for — the dock is a
 *  switcher first, and a permanent text input in a 212px column would cost more
 *  room than the thing it adds. */
function AddProject(): VNode {
  const [open, setOpen] = useLocal(false);
  const [path, setPath] = useLocal("");

  const submit = () => {
    const typed = path.trim();
    if (!typed) return;
    void workspace.addProject(typed);
    setPath("");
    setOpen(false);
  };

  if (!open) {
    return (
      <button
        type="button"
        class="btn btn--ghost btn--sm"
        aria-label="Add project"
        title="Add a project directory"
        onClick={() => setOpen(true)}
      >
        {IconPlus({ size: 14 })}
        <span class="wide">Add project</span>
      </button>
    );
  }
  return (
    <div style={{ display: "grid", gap: "6px" }}>
      <input
        class="input"
        value={path}
        // Autofocus is right here and nowhere else in the app: the field only
        // exists because the user just asked for it.
        autoFocus
        placeholder="~/code/project"
        aria-label="Project directory"
        onInput={(e) => setPath((e.target as HTMLInputElement).value)}
        onKeyDown={(e: KeyboardEvent) => {
          if (e.key === "Enter") submit();
          if (e.key === "Escape") setOpen(false);
        }}
      />
      <div style={{ display: "flex", gap: "6px" }}>
        <button type="button" class="btn btn--sm" onClick={submit}>Add</button>
        <button
          type="button"
          class="btn btn--ghost btn--sm"
          onClick={() => setOpen(false)}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

/**
 * "Removed N · Undo" — the thing that makes one-click removal honest.
 *
 * It covers the sweep as well as the button: a project whose folder was
 * deleted while the app was open disappears on its own, and this is what says
 * so. Without it that would be a tab vanishing for no visible reason, which is
 * indistinguishable from a bug.
 */
function UndoRemove(): VNode | null {
  const gone = forgottenProjects();
  if (gone.length === 0) return null;
  return (
    <div class="dock__undo">
      <span class="truncate" title={gone.map((p) => p.path).join("\n")}>
        {gone.length === 1
          ? `Removed ${gone[0].name}`
          : `Removed ${gone.length} projects`}
      </span>
      <button
        type="button"
        class="btn btn--ghost btn--sm"
        onClick={() => workspace.undoForget()}
      >
        Undo
      </button>
      <button
        type="button"
        class="btn btn--ghost btn--sm btn--icon"
        title="Dismiss"
        aria-label="Dismiss removed projects"
        onClick={() => workspace.clearForgotten()}
      >
        {IconX({ size: 12 })}
      </button>
    </div>
  );
}

/** Past this many tabs, scanning the column stops being faster than typing. */
const FILTER_AT = 7;

export function Dock(): VNode {
  const active = activeProject();
  const [query, setQuery] = useLocal("");
  const many = workspace.projects.length > FILTER_AT;
  // The filter never removes the project you are *on*. A dock that hid the tab
  // under the cursor while you typed would leave the whole app describing a
  // project with no visible tab.
  const shown = many
    ? workspace.projects.filter((p) =>
      p.id === active?.id || matches(query, p.name, p.path, p.branch)
    )
    : workspace.projects;

  return (
    <nav class="dock" aria-label="Projects">
      <div class="dock__head">
        <span>Projects</span>
        <span style={{ flex: 1 }} />
        <button
          type="button"
          class="btn btn--ghost btn--icon btn--sm"
          title="Re-check every project against the disk"
          aria-label="Re-check projects"
          onClick={() => workspace.refreshProjects()}
        >
          {IconRefresh({ size: 13 })}
        </button>
      </div>

      {
        /* Only once the column is long enough to be worth searching. A
          permanent text field in a 212px column costs more room than it saves
          for the three projects most people have open. */
      }
      {many && (
        <div class="dock__filter">
          <Search
            value={query}
            onChange={setQuery}
            label="Filter projects"
            placeholder="Filter projects…"
          />
        </div>
      )}

      <div class="dock__list">
        {workspace.projects.length === 0
          ? (
            <div
              style={{
                padding: "10px 8px",
                fontSize: "11.5px",
                color: "var(--ink-dim)",
              }}
            >
              No projects yet.
            </div>
          )
          : shown.map((p) => (
            <ProjectTab
              key={p.id}
              project={p}
              // Its position in the WHOLE list, not in the filtered view —
              // that is what Mod+1…9 reaches, and a tooltip promising a key
              // that selects a different project is worse than none.
              index={workspace.projects.findIndex((x) => x.id === p.id)}
              active={active?.id === p.id}
            />
          ))}
      </div>

      <div class="dock__foot">
        <UndoRemove />
        <AddProject />
      </div>
    </nav>
  );
}
