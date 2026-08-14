/**
 * @module
 * Settings — the project Claude Code runs in, the model it runs on, what it is
 * allowed to do, and everything the running session reports about itself.
 *
 * Changes that need a fresh process say so instead of pretending to apply.
 */
import { useLocal, useRef, type VNode } from "aio/air";
import { session } from "../cell/session.ts";
import { activeProject, workspace } from "../cell/workspace.ts";
import { MODELS, PERMISSION_MODES } from "../lib/stream.ts";
import { ago, clock, tildePath, usd } from "../lib/format.ts";
import {
  Banner,
  Choice,
  Empty,
  Panel,
  Pill,
  Segmented,
  Tags,
  useNow,
} from "./parts.tsx";
import { PageHead } from "./RunViews.tsx";
import {
  IconAlert,
  IconCheck,
  IconFolder,
  IconPlay,
  IconPlus,
  IconPower,
  IconRefresh,
  IconTrash,
} from "./icons.tsx";

export function SettingsPage(): VNode {
  const project = activeProject();
  // Slow, but ticking: "started 3s ago" otherwise stayed "3s ago" for as long as
  // an idle session left the page with nothing else to re-render it.
  const now = useNow(true, 10_000);
  const live = session.status !== "offline" && session.status !== "error";

  return (
    <div class="page">
      <PageHead
        title="Settings"
        sub="Project, model, permissions and session"
        actions={
          <div style={{ display: "flex", gap: "8px" }}>
            {live
              ? (
                <>
                  <button
                    type="button"
                    class="btn btn--sm"
                    onClick={() => session.start()}
                  >
                    {IconRefresh({ size: 13 })} Restart
                  </button>
                  <button
                    type="button"
                    class="btn btn--sm btn--danger"
                    onClick={() => session.stop()}
                  >
                    {IconPower({ size: 13 })} Stop
                  </button>
                </>
              )
              : (
                <>
                  {session.resumeId && (
                    <button
                      type="button"
                      class="btn btn--sm"
                      title={`Resume CLI session ${session.resumeId} — the model keeps its context; the transcript here starts empty`}
                      onClick={() => session.start(true)}
                    >
                      {IconRefresh({ size: 13 })} Resume
                    </button>
                  )}
                  <button
                    type="button"
                    class="btn btn--sm btn--primary"
                    onClick={() => session.start()}
                  >
                    {IconPlay({ size: 13 })} Start session
                  </button>
                </>
              )}
          </div>
        }
      />

      <div class="page__body grid">
        {workspace.error && (
          <Banner onDismiss={() => workspace.dismissError()}>
            {workspace.error}
          </Banner>
        )}
        {live && (
          <Banner tone="warn">
            Model and permission changes apply to the <b>next</b>{" "}
            session — restart to use them now.
          </Banner>
        )}

        <div class="grid grid--2">
          <Projects />

          <Panel title="Model" actions={<Pill>{workspace.model}</Pill>}>
            <div class="choices">
              {MODELS.map((m) => (
                <Choice
                  key={m.id}
                  label={m.label}
                  name={m.label}
                  hint={m.hint}
                  selected={workspace.model === m.id}
                  onSelect={() => workspace.setModel(m.id)}
                />
              ))}
            </div>
          </Panel>

          <Panel
            title="Permissions"
            actions={<Pill>{workspace.permissionMode}</Pill>}
          >
            <div class="choices">
              {PERMISSION_MODES.map((m) => (
                <Choice
                  key={m.id}
                  label={m.label}
                  name={m.label}
                  hint={m.hint}
                  selected={workspace.permissionMode === m.id}
                  onSelect={() => workspace.setPermissionMode(m.id)}
                />
              ))}
            </div>
            <div class="field__hint" style={{ marginTop: "10px" }}>
              Prompts come to you: whatever the CLI cannot decide on its own
              appears above the composer, and it waits for your answer.{" "}
              <b>Accept edits</b>{" "}
              is the working default — file edits go through, anything reaching
              further asks. <b>Ask always</b>{" "}
              holds the edits too, which is the mode to pick when you want to
              see each change before it lands; the CLI still clears trivia like
              an <code>echo</code>{" "}
              on its own. Anything the CLI blocks by itself is still reported on
              the Activity timeline, never swallowed.
            </div>
          </Panel>

          <Panel
            title="Allowed directories"
            actions={<Pill>{workspace.allowedDirs.length}</Pill>}
          >
            <AllowedDirs />
          </Panel>

          <Panel title="Appearance">
            <div class="field">
              <span class="field__label">Theme</span>
              <Segmented
                value={workspace.theme}
                options={[
                  { id: "system", label: "System" },
                  { id: "dark", label: "Dark" },
                  { id: "light", label: "Light" },
                ]}
                onChange={(v) => workspace.setTheme(v)}
              />
              <span class="field__hint">
                System follows your OS setting and switches with it.
              </span>
            </div>
          </Panel>
        </div>

        <AllowAll />

        <Panel title="Session">
          <div class="kv">
            <span class="kv__k">Status</span>
            <span class="kv__v">{session.status}</span>
            <span class="kv__k">Working directory</span>
            <span class="kv__v mono">
              {session.cwd ? tildePath(session.cwd, workspace.home) : "—"}
            </span>
            <span class="kv__k">CLI session id</span>
            <span class="kv__v mono">{session.sessionId ?? "—"}</span>
            <span class="kv__k">Process</span>
            <span class="kv__v mono">{session.pid ?? "—"}</span>
            <span class="kv__k">Claude Code</span>
            <span class="kv__v mono">
              {session.meta.version || workspace.cliVersion || "not found"}
            </span>
            <span class="kv__k">Started</span>
            <span class="kv__v">
              {session.startedAt
                ? `${clock(session.startedAt)} · ${ago(session.startedAt, now)}`
                : "—"}
            </span>
            <span class="kv__k">Turns · cost</span>
            <span class="kv__v">{session.turns} · {usd(session.cost)}</span>
            {session.rateLimit && (
              <>
                <span class="kv__k">Rate limit</span>
                <span class="kv__v">
                  {(session.rateLimit.utilization * 100).toFixed(0)}% of the
                  {" "}
                  {session.rateLimit.type.replace("_", "-")} window ·{" "}
                  {session.rateLimit.status}
                </span>
              </>
            )}
          </div>

          {session.meta.tools.length > 0 && (
            <>
              <div class="divider" />
              <div class="grid" style={{ gap: "10px" }}>
                <Capability label="Tools" items={session.meta.tools} />
                <Capability label="Agents" items={session.meta.agents} />
                <Capability label="Skills" items={session.meta.skills} />
                <Capability
                  label="Slash commands"
                  items={session.meta.commands}
                  max={18}
                />
                {session.meta.mcp.length > 0 && (
                  <div class="field">
                    <span class="field__label">MCP servers</span>
                    <div class="tags">
                      {session.meta.mcp.map((m) => (
                        <span key={m.name} class="tag">
                          {m.name} · {m.status}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </>
          )}
        </Panel>

        <Panel title="Transcript">
          <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
            <button
              type="button"
              class="btn btn--sm"
              onClick={() => session.clearTranscript()}
            >
              {IconTrash({ size: 13 })} Clear the view
            </button>
            <span class="field__hint">
              Clears what this app displays. The model keeps its own context —
              use Restart for a genuinely fresh session.
            </span>
          </div>
        </Panel>
      </div>
    </div>
  );
}

function Capability(
  props: { label: string; items: string[]; max?: number },
): VNode | null {
  if (props.items.length === 0) return null;
  return (
    <div class="field">
      <span class="field__label">
        {props.label} · {props.items.length}
      </span>
      <Tags items={props.items} max={props.max ?? 24} />
    </div>
  );
}

/* ── permissions ──────────────────────────────────────────────────────────── */

/**
 * The blunt instrument: `--dangerously-skip-permissions`, every check off.
 *
 * Two clicks, never one — the second click is the whole safety story, so it
 * says exactly what it grants rather than "are you sure?". While it is on the
 * status strip carries a permanent marker, because a mode this broad must
 * never be something you forgot you left enabled.
 */
function AllowAll(): VNode {
  const [armed, setArmed] = useLocal(false);
  const on = workspace.skipPermissions;

  if (on) {
    return (
      <div class="banner" style={{ marginBottom: 0 }}>
        <span class="banner__icon">{IconAlert({ size: 16 })}</span>
        <span style={{ flex: 1 }}>
          <b>All permission checks are off.</b>{" "}
          Claude Code can read, write and run anything this user account can,
          anywhere on the machine — not just in the project.
        </span>
        <button
          type="button"
          class="btn btn--sm"
          onClick={() => workspace.setSkipPermissions(false)}
        >
          Turn back on
        </button>
      </div>
    );
  }

  return (
    <div
      style={{
        marginTop: "10px",
        display: "flex",
        gap: "8px",
        alignItems: "center",
      }}
    >
      {armed
        ? (
          <>
            <button
              type="button"
              class="btn btn--sm btn--danger"
              onClick={() => {
                setArmed(false);
                workspace.setSkipPermissions(true);
              }}
            >
              {IconAlert({ size: 13 })} Yes — run with no checks at all
            </button>
            <button
              type="button"
              class="btn btn--sm btn--ghost"
              onClick={() => setArmed(false)}
            >
              Cancel
            </button>
          </>
        )
        : (
          <button
            type="button"
            class="btn btn--sm btn--danger"
            onClick={() => setArmed(true)}
          >
            Allow all
          </button>
        )}
      <span class="field__hint" style={{ flex: 1 }}>
        Runs the CLI with{" "}
        <code>--dangerously-skip-permissions</code>. Prefer adding the folder
        above — it grants exactly what is needed.
      </span>
    </div>
  );
}

/* ── allowed directories ──────────────────────────────────────────────────── */

/** Extra folders passed to the CLI as `--add-dir`. This is the answer to the
 *  denial most people hit: a path just outside the project. */
function AllowedDirs(): VNode {
  const ref = useRef<HTMLInputElement>(null!);

  const add = () => {
    const el = ref.current;
    if (!el) return;
    const value = el.value.trim();
    if (!value) return;
    el.value = "";
    void workspace.addAllowedDir(value);
  };

  return (
    <>
      <div style={{ display: "flex", gap: "8px", marginBottom: "10px" }}>
        <input
          ref={ref}
          class="input"
          placeholder="/tmp, ~/scratch, …"
          aria-label="Directory to allow"
          onKeyDown={(e: KeyboardEvent) => {
            if (e.key === "Enter") add();
          }}
        />
        <button type="button" class="btn btn--sm" onClick={add}>
          {IconPlus({ size: 13 })} Allow
        </button>
      </div>

      {workspace.allowedDirs.length === 0
        ? (
          <div class="field__hint">
            Claude Code may only touch the project folder. Add one here when a
            command needs to write or run somewhere else — a build output in
            {" "}
            <code>/tmp</code>, a sibling checkout.
          </div>
        )
        : (
          <div class="choices">
            {workspace.allowedDirs.map((d) => (
              <div key={d} class="choice" style={{ cursor: "default" }}>
                <span class="choice__label mono truncate" title={d}>
                  {tildePath(d, workspace.home)}
                </span>
                <button
                  type="button"
                  class="btn btn--ghost btn--sm btn--icon"
                  title={`Stop allowing ${d}`}
                  aria-label={`Stop allowing ${d}`}
                  onClick={() =>
                    workspace.removeAllowedDir(d)}
                >
                  {IconTrash({ size: 13 })}
                </button>
              </div>
            ))}
          </div>
        )}
    </>
  );
}

/* ── projects ─────────────────────────────────────────────────────────────── */

function Projects(): VNode {
  const ref = useRef<HTMLInputElement>(null!);
  const [adding, setAdding] = useLocal(false);
  const active = activeProject();

  const add = () => {
    const el = ref.current;
    if (!el) return;
    const value = el.value.trim();
    if (!value) return;
    el.value = "";
    setAdding(false);
    void workspace.addProject(value);
  };

  return (
    <Panel
      title="Projects"
      actions={
        <>
          <button
            type="button"
            class="btn btn--sm btn--ghost"
            title="Refresh git branch"
            aria-label="Refresh git branch"
            onClick={() => workspace.refreshGit()}
          >
            {IconRefresh({ size: 13 })}
          </button>
          <button
            type="button"
            class="btn btn--sm"
            onClick={() => setAdding(!adding)}
          >
            {IconPlus({ size: 13 })} Add
          </button>
        </>
      }
    >
      {adding && (
        <div style={{ display: "flex", gap: "8px", marginBottom: "10px" }}>
          <input
            ref={ref}
            class="input"
            placeholder="/path/to/project, ~/code/app, ./sub"
            aria-label="Project directory"
            onKeyDown={(e: KeyboardEvent) => {
              if (e.key === "Enter") {
                add();
              }
              if (e.key === "Escape") {
                setAdding(false);
              }
            }}
          />
          <button type="button" class="btn btn--sm btn--primary" onClick={add}>
            Add
          </button>
        </div>
      )}

      {workspace.projects.length === 0
        ? (
          <Empty
            icon={IconFolder({ size: 20 })}
            title="No projects"
            hint="Add a directory to point Claude Code at it."
          />
        )
        : (
          <div class="choices">
            {workspace.projects.map((p) => (
              <Choice
                key={p.id}
                name={p.name}
                label={
                  <span
                    style={{
                      display: "inline-flex",
                      gap: "8px",
                      alignItems: "center",
                    }}
                  >
                    {IconFolder({ size: 13 })}
                    {p.name}
                    {p.branch && <Pill>{p.branch}</Pill>}
                    {p.dirty && <Pill tone="warn">dirty</Pill>}
                  </span>
                }
                hint={tildePath(p.path, workspace.home)}
                selected={active?.id === p.id}
                onSelect={() => workspace.select(p.id)}
                trailing={
                  <span
                    style={{
                      display: "inline-flex",
                      gap: "4px",
                      alignItems: "center",
                    }}
                  >
                    {active?.id === p.id && IconCheck({ size: 16 })}
                    {workspace.projects.length > 1 && (
                      <span
                        role="button"
                        tabIndex={0}
                        class="btn btn--ghost btn--sm btn--icon"
                        title={`Remove ${p.name}`}
                        aria-label={`Remove ${p.name}`}
                        onClick={(e: Event) => {
                          e.stopPropagation();
                          workspace.removeProject(p.id);
                        }}
                      >
                        {IconTrash({ size: 13 })}
                      </span>
                    )}
                  </span>
                }
              />
            ))}
          </div>
        )}
      <div class="field__hint" style={{ marginTop: "10px" }}>
        Switching projects takes effect on the next session start.
      </div>
    </Panel>
  );
}
