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
import { activeProject, workspace } from "../cell/workspace.ts";
import { session, sessionOf } from "../cell/session.ts";
import type { Project } from "../type/claude.ts";
import { tildePath } from "../lib/format.ts";
import { IconBranch, IconPlus, IconRefresh, IconX } from "./icons.tsx";

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

function ProjectTab(props: { project: Project; active: boolean }): VNode {
  const p = props.project;
  // This project's own conversation, whether or not it is the one on screen.
  const s = sessionOf(p.id);
  const holds = s.permissions.filter((r) => r.status === "pending").length;
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
    ? `${holds} approval${holds > 1 ? "s" : ""} needed`
    : s.status === "working"
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
        }`}
        onClick={() => workspace.select(p.id)}
      >
        <span class="ptab__mark">{initials(p.name)}</span>
        <span class="ptab__text truncate">
          <span class="ptab__name truncate">{p.name}</span>
          <br />
          <span class="ptab__sub truncate">
            {!p.missing && p.branch && holds === 0 && s.status !== "working" &&
              IconBranch({ size: 10 })}
            <span class="truncate">{sub}</span>
            {p.dirty && !p.missing && holds === 0 && s.status !== "working" && (
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
            : s.status === "working"
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
        /* Only when there is something to close. A cross on a project that has
          never been started would read as "remove this project", which is a
          different and much less recoverable action — that one lives in
          Settings, behind a list you have to look at. */
      }
      {running && (
        <button
          type="button"
          class="ptab__close"
          title={`End ${p.name}'s session — the conversation is kept, and Resume brings its context back`}
          aria-label={`Close ${p.name} session`}
          onClick={() => session.stop(p.id)}
        >
          {IconX({ size: 12 })}
        </button>
      )}
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

export function Dock(): VNode {
  const active = activeProject();

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
          : workspace.projects.map((p) => (
            <ProjectTab
              key={p.id}
              project={p}
              active={active?.id === p.id}
            />
          ))}
      </div>

      <div class="dock__foot">
        <AddProject />
      </div>
    </nav>
  );
}
