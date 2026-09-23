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
import { go } from "./go.ts";
import { focusComposerSoon, newChat, openConsole } from "./commands.ts";
import { useLocal, type VNode } from "aio/air";
import {
  activePane,
  activeProject,
  activeSessionKey,
  forgottenProjects,
  panesOf,
  workspace,
} from "../cell/workspace.ts";
import { session, sessionOf } from "../cell/session.ts";
import { consoleCell, terminalById } from "../cell/console.ts";
import {
  engineOf,
  localChat,
  localChatsOf,
  localConfig,
} from "../cell/local.ts";
import type { Pane, Project } from "../type/claude.ts";
import { hueOf, tildePath } from "../lib/format.ts";
import { ENGINE_TAGS } from "./LocalChatPage.tsx";
import { matches, Search } from "./parts.tsx";
import {
  claudePulse,
  consolePulse,
  localPulse,
  type Pulse,
  pulseTitle,
  strongest,
} from "./pulse.ts";
import { AbsentOffer, BrowseButton } from "./AddProject.tsx";
import { showToast } from "./toast.tsx";
import {
  IconBranch,
  IconChat,
  IconFolderOpen,
  IconPlay,
  IconPlus,
  IconPower,
  IconRefresh,
  IconTerminal,
  IconTrash,
  IconX,
} from "./icons.tsx";

/**
 * A project's conversations and shells, and the four ways to add one.
 *
 * Under the tab rather than beside it: these belong to the project, and a flat
 * list of everything open in every project is a list nobody can find anything
 * in. Only the project being worked in shows them — see the caller.
 */
function PaneList(props: { project: Project; active: boolean }): VNode {
  const p = props.project;
  const panes = panesOf(p.id);
  // Only the project you are in has a row on screen, so only that list may
  // show one as selected. Every project remembers which of its panes it will
  // open on, but two highlighted rows in two lists is a claim that two things
  // are showing at once.
  const showing = props.active ? activePane(p.id)?.id ?? "" : "";
  const sessions = panes.filter((x) => x.kind === "session").length;

  return (
    <div class="panes">
      {panes.map((pane) => {
        const paneState = panePulse(pane);
        return (
          <div
            key={pane.id}
            class={"pane" + (pane.id === showing ? " selected" : "")}
          >
            <button
              type="button"
              class="pane__main"
              aria-label={`${pane.title} in ${p.name}`}
              title={pane.kind === "console"
                ? `${pane.title} — a shell in ${p.path}`
                : `${pane.title} — a conversation in ${p.path}`}
              onClick={() => {
                workspace.selectPane(pane.id);
                if (pane.kind === "console") {
                  go("/console");
                  return;
                }
                go("/", true);
                // Clicking a conversation is asking to talk to it, whether the
                // click came from the mouse or from Alt+arrow.
                focusComposerSoon();
              }}
            >
              <span class="pane__icon">
                {pane.kind === "console"
                  ? IconTerminal({ size: 11 })
                  : IconChat({ size: 11 })}
              </span>
              <span class="truncate">{pane.title}</span>
              {
                /* One tag, two questions — the same one, really: what is
                behind this row.

                For a conversation it is the provider answering it, in words.
                Not a logo: four engine marks told apart at 11px is a puzzle,
                and the two llama-based ones are the same handful of grey
                pixels at that size. It is worth the room because a project can
                hold a Claude chat and a local one at the same time, and the
                rows are otherwise identical.

                For a shell it is whatever is running in it right now, and
                nothing at all at a prompt. The light already says a shell is
                busy; this says what with, which is the next thing you would
                want and the reason you would go and look. */
              }
              <span
                class={`pane__tag pane__tag--${paneTagKind(pane)}`}
                hidden={paneTag(pane) === ""}
                title={pane.kind === "console"
                  ? `Running ${paneTag(pane)}`
                  : undefined}
              >
                {
                  /* Never the empty string. A text child that renders to
                    nothing changes this span's child COUNT, and the reconciler
                    then holds the wrong node at child 0 — it says so out loud
                    in dev. The span is hidden when there is nothing to say, so
                    the space this reserves is never seen. */
                }
                {paneTag(pane) || "\u00a0"}
              </span>
              <span
                class={`pulse pulse--${paneState}`}
                title={pulseTitle(
                  paneState,
                  pane.kind === "console" ? "shell" : "chat",
                )}
              />
            </button>
            {
              /* The last conversation has no close button: a project with none
              is a Chat page with nothing to show and no way back. */
            }
            {!(pane.kind === "session" && sessions === 1) && (
              <button
                type="button"
                class="pane__close"
                aria-label={`Close ${pane.title}`}
                title={pane.kind === "console"
                  ? "End this shell and close it"
                  : "Close this conversation"}
                onClick={() => {
                  if (pane.kind === "console") void consoleCell.remove(pane.id);
                  workspace.removePane(pane.id);
                }}
              >
                {IconX({ size: 10 })}
              </button>
            )}
          </div>
        );
      })}

      <div class="panes__add" key="add">
        <button
          type="button"
          class="pane__add"
          aria-label="New conversation"
          title="Another conversation in this project — its own session, its own context"
          onClick={() => void newChat(p.id)}
        >
          {IconChat({ size: 11 })}
          <span class="pane__plus">+</span>
        </button>
        <button
          type="button"
          class="pane__add"
          aria-label="New console"
          title="Another shell in this project's directory"
          onClick={() => void openConsole(p.id)}
        >
          {IconTerminal({ size: 11 })}
          <span class="pane__plus">+</span>
        </button>
        {
          /* What this project itself says starts it, read off its own
            manifests — see lib/launch.ts. Absent rather than disabled when the
            project does not say: a run button that runs the wrong thing is
            worse than no run button. */
        }
        {p.launch.dev && (
          <button
            type="button"
            class="pane__add pane__add--run"
            aria-label="Start in developer mode"
            title={`Run ${p.launch.dev.command} in a new console (from ${p.launch.dev.from})`}
            onClick={() =>
              void openConsole(p.id, "dev", p.launch.dev?.command ?? "")}
          >
            {IconPlay({ size: 11 })}
            <span class="pane__runlabel">dev</span>
          </button>
        )}
        {p.launch.prod && (
          <button
            type="button"
            class="pane__add pane__add--run"
            aria-label="Start in production mode"
            title={`Run ${p.launch.prod.command} in a new console (from ${p.launch.prod.from})`}
            onClick={() =>
              void openConsole(
                p.id,
                "production",
                p.launch.prod?.command ?? "",
              )}
          >
            {IconPlay({ size: 11 })}
            <span class="pane__runlabel">prod</span>
          </button>
        )}
      </div>
    </div>
  );
}

/** Is this pane doing something right now? The dot is the only thing a
 *  collapsed row can say, so it has to mean exactly one thing: work in
 *  progress. */
/**
 * The most a tag has room to say.
 *
 * A process name from the kernel is already short — `comm` is capped at 15
 * bytes — but the dock is narrower than that, and a tag that pushes the title
 * out of its own row has stopped being a qualifier. Cut rather than shrunk:
 * the first characters are the ones that identify a command.
 */
const TAG_MAX = 10;

/** What this row's tag reads, or `""` for no tag: a conversation's provider,
 *  a shell's running command, nothing at a prompt. */
function paneTag(pane: Pane): string {
  if (pane.kind === "console") {
    return terminalById(pane.id).running.slice(0, TAG_MAX);
  }
  const engine = engineOf(pane.id);
  return (ENGINE_TAGS[engine] ?? engine).slice(0, TAG_MAX);
}

/** Which colour the tag wears. Shells share one, because a process name is not
 *  a member of a small set the eye can learn. */
const paneTagKind = (pane: Pane): string =>
  pane.kind === "console" ? "running" : engineOf(pane.id);

/**
 * What a pane's light should say.
 *
 * The old version asked `status === "live"` for a shell, which is "a shell
 * exists" — true of every shell, so the light was always on and told you
 * nothing. Now a shell is green only while a command actually holds its
 * foreground, and blue while it sits at a prompt.
 */
function panePulse(pane: Pane): Pulse {
  if (pane.kind === "console") return consolePulse(terminalById(pane.id));
  const engine = engineOf(pane.id);
  if (engine === "claude") {
    const s = sessionOf(pane.id);
    return claudePulse(
      s.status,
      s.permissions.filter((r) => r.status === "pending").length,
    );
  }
  const cfg = localConfig(pane.id);
  return localPulse(localChat(pane.id), cfg.baseUrl !== "" && cfg.model !== "");
}

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
  // This project's own conversation, whether or not it is the one on screen.
  const s = sessionOf(p.id);
  // Both kinds are counted, because a project can hold both: a Claude chat and
  // a local one, side by side, each with its own engine. Asking "is this
  // project local?" stopped being a question with an answer.
  //
  // A local chat has no Claude session, but it can still be stopped waiting
  // for somebody to allow a command — the same signal and the same stakes
  // (nothing moves, forever, until it is answered), so it gets the same words.
  const chats = localChatsOf(p.id);
  const holds = chats.filter((c) => c.pending).length +
    s.permissions.filter((r) => r.status === "pending").length;
  const isLocal = engineOf(activeSessionKey(p.id)) !== "claude";
  const working = chats.some((c) => c.status === "working") ||
    s.status === "working";
  // The session keeps the directory it started in, so "selected" and "where
  // Claude Code is actually working" can differ — and only one of them is the
  // truth about the turn in flight.
  const here = s.cwd !== null && s.cwd === p.path;
  // A session exists when there is a process behind it. `status` alone is not
  // the question — an errored session has no process left to close.
  const running = s.pid !== null;

  // The tab's own light is the strongest of everything inside it: with the
  // panes collapsed, this dot is all there is to say that one of five shells
  // is building or one of two chats is waiting for an answer.
  const tabState = strongest(panesOf(p.id).map(panePulse));

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
      // Drag to reorder. The order decides where Alt PgUp/PgDn walk, so it is
      // the user's to set — the order things happened to be added in is not a
      // decision anybody made.
      draggable
      onDragStart={(e: DragEvent) => {
        e.dataTransfer?.setData("text/cc-project", p.id);
        if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
      }}
      onDragOver={(e: DragEvent) => {
        // Only for a tab. Without the check, dropping a file from the desktop
        // onto the dock would be accepted and then do nothing at all.
        if (!e.dataTransfer?.types.includes("text/cc-project")) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
      }}
      onDrop={(e: DragEvent) => {
        const id = e.dataTransfer?.getData("text/cc-project");
        if (!id || id === p.id) return;
        e.preventDefault();
        workspace.moveProject(id, props.index);
      }}
    >
      <div class="ptab__row">
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
          {
            /* A colour per project, from its path. With six tabs open the one
            you want is found by its shape before its name is read — and two
            projects called "app" in different directories are otherwise
            identical until you hover. */
          }
          <span
            class="ptab__mark"
            style={{ "--hue": String(hueOf(p.path)) }}
          >
            {initials(p.name)}
          </span>
          <span class="ptab__text truncate">
            <span class="ptab__name truncate">{p.name}</span>
            <br />
            {
              /* Three children, always. Both of these used to be bare
              conditionals, so child 0 flipped between a branch icon and
              nothing every time the session's status changed — and the
              reconciler then wrote the next child into the vacated slot. The
              symptom was a tab briefly wearing another tab's subtitle. */
            }
            <span class="ptab__sub truncate">
              <span
                class="ptab__icon"
                hidden={!(!p.missing && p.branch && holds === 0 && !working)}
              >
                {IconBranch({ size: 10 })}
              </span>
              <span class="truncate">{sub}</span>
              <span
                title="Uncommitted changes"
                hidden={!(p.dirty && !p.missing && holds === 0 && !working)}
              >
                ●
              </span>
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
          class={`ptab__state ptab__state--${
            s.status === "error" && !isLocal ? "error" : tabState
          }`}
          title={pulseTitle(tabState, "chat")}
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
          {
            /* Open the folder in whatever the desktop uses for one. The tab is
            where somebody is already thinking about this project, and the
            alternative is copying a path out of Settings. */
          }
          <button
            type="button"
            class="ptab__act"
            title={`Open ${p.path}`}
            aria-label={`Open ${p.name} folder`}
            onClick={async () => {
              const why = await workspace.openPath(p.path);
              if (why !== null) showToast({ text: why, tone: "danger" });
            }}
          >
            {IconFolderOpen({ size: 12 })}
          </button>
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

      {
        /* What this project has open, and the ways to open more.

          Every project's, always — not just the one being worked in. The dock
          is how you move between conversations, and a list that folds away the
          moment you look elsewhere hides the thing you were about to click.
          The pane rows carry their own state lights, so the ones you are not
          in are exactly where a running build or a waiting question is worth
          seeing. */
      }
      <PaneList project={p} active={props.active} />
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

  // One element with the same two children whether the field is open or not.
  // Returning a fragment in one branch and a div in the other changes the
  // number of children this component contributes to the dock's foot, and the
  // reconciler pairs the survivors up by position — which is how the Add
  // button ended up wearing the offer's DOM node.
  //
  // The offer to create a folder outlives the field being folded away: an add
  // that failed is the reason somebody closed it, and hiding the way forward
  // along with the input would be the app forgetting faster than the user
  // does.
  return (
    <div style={{ display: "grid", gap: "6px" }}>
      {open
        ? (
          <div style={{ display: "grid", gap: "6px" }}>
            <input
              class="input"
              value={path}
              // Autofocus is right here and nowhere else in the app: the field
              // only exists because the user just asked for it.
              autoFocus
              placeholder="~/code/project"
              aria-label="Project directory"
              onInput={(e) => setPath((e.target as HTMLInputElement).value)}
              onKeyDown={(e: KeyboardEvent) => {
                if (e.key === "Enter") submit();
                // preventDefault: backing out of the field must not also be
                // the global Escape, which on the chat page stops the turn.
                if (e.key === "Escape") {
                  e.preventDefault();
                  setOpen(false);
                }
              }}
            />
            <div style={{ display: "flex", gap: "6px" }}>
              <button type="button" class="btn btn--sm" onClick={submit}>
                Add
              </button>
              <BrowseButton
                label=""
                onPick={(picked: string) => {
                  setPath(picked);
                  void workspace.addProject(picked);
                  setOpen(false);
                }}
              />
              <button
                type="button"
                class="btn btn--ghost btn--sm"
                onClick={() => setOpen(false)}
              >
                Cancel
              </button>
            </div>
          </div>
        )
        : (
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
        )}
      <AbsentOffer />
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

  /**
   * Up and down move between project tabs.
   *
   * Focus is moved rather than the selection changed: arrowing through a list
   * that switches project on every step would spawn and tear down a session
   * per keypress. Space or Enter still does the switching, which is what every
   * other list in every other app does too.
   */
  const walk = (e: KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const list = e.currentTarget as HTMLElement | null;
    if (!list) return;
    const tabs = [...list.querySelectorAll<HTMLElement>(".ptab__main")];
    const at = tabs.indexOf(
      (e.target as HTMLElement).closest(".ptab__main") as HTMLElement,
    );
    if (at === -1) return;
    e.preventDefault();
    // Stops at the ends rather than wrapping: a list that jumps from the last
    // row to the first is a list you can get lost in with one keypress too
    // many.
    const next = tabs[e.key === "ArrowDown" ? at + 1 : at - 1];
    next?.focus();
  };

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

      {
        /* Up and down walk the list once focus is in it. Tab already reaches
          every tab, but Tab also walks into each tab's two overlay buttons —
          so getting from the first project to the fourth is nine presses. */
      }
      <div class="dock__list" onKeyDown={walk}>
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
