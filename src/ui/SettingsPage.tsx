/**
 * @module
 * Settings — the project Claude Code runs in, the model it runs on, what it is
 * allowed to do, and everything the running session reports about itself.
 *
 * Changes that need a fresh process say so instead of pretending to apply.
 */
import { useLocal, useRef, type VNode } from "aio/air";
import { session, view } from "../cell/session.ts";
import { activeProject, activeSettings, workspace } from "../cell/workspace.ts";
import { EFFORTS, MODELS, PERMISSION_MODES } from "../lib/stream.ts";
import {
  ago,
  clock,
  duration,
  tailPath,
  tildePath,
  until,
  usd,
} from "../lib/format.ts";
import {
  Banner,
  Choice,
  Empty,
  Meter,
  Panel,
  Pill,
  Segmented,
  Tags,
  useNow,
} from "./parts.tsx";
import { PageHead, ScopeTag } from "./RunViews.tsx";
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
  // One resolution per render: `view()` resolves by key, and repeating
  // the call also defeats every narrowing of its nullable fields.
  const sess = view();
  // Slow, but ticking: "started 3s ago" otherwise stayed "3s ago" for as long as
  // an idle session left the page with nothing else to re-render it.
  const now = useNow(true, 10_000);
  const live = sess.status !== "offline" && sess.status !== "error";

  return (
    <div class="page">
      <PageHead
        title="Settings"
        sub="Some of this belongs to the project, some to the machine"
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
                  {sess.resumeId && (
                    <button
                      type="button"
                      class="btn btn--sm"
                      title={`Resume CLI session ${sess.resumeId} — the model keeps its context; the transcript here starts empty`}
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

        {
          /* Said once, above the panels that mean it: these are settings for
            ONE codebase. Every project keeps its own, seeded from what the CLI
            is configured to do in that directory, and a change here follows the
            project rather than the app — which is the whole point, and is also
            the thing a reader would otherwise have to guess. */
        }
        <ProjectScope />

        <div class="grid grid--2">
          <Projects />

          <Panel title="Model" actions={<Pill>{activeSettings().model}</Pill>}>
            <div class="choices">
              {MODELS.map((m) => (
                <Choice
                  key={m.id}
                  label={m.label}
                  name={m.label}
                  hint={m.hint}
                  selected={activeSettings().model === m.id}
                  onSelect={() => workspace.setModel(m.id)}
                />
              ))}
            </div>
          </Panel>

          <Panel
            title="Effort"
            actions={<Pill>{activeSettings().effort || "default"}</Pill>}
          >
            <div class="choices">
              {EFFORTS.map((e) => (
                <Choice
                  key={e.id || "default"}
                  label={e.label}
                  name={e.label}
                  hint={e.hint}
                  selected={activeSettings().effort === e.id}
                  onSelect={() => workspace.setEffort(e.id)}
                />
              ))}
            </div>
            <div class="field__hint" style={{ marginTop: "10px" }}>
              How hard the model works before it answers (<code>
                --effort
              </code>). <b>Default</b>{" "}
              passes no flag at all, so whatever you have configured for the CLI
              itself still applies.
            </div>
          </Panel>

          <Panel
            title="Permissions"
            actions={<Pill>{activeSettings().permissionMode}</Pill>}
          >
            <div class="choices">
              {PERMISSION_MODES.map((m) => (
                <Choice
                  key={m.id}
                  label={m.label}
                  name={m.label}
                  hint={m.hint}
                  selected={activeSettings().permissionMode === m.id}
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
            actions={<Pill>{activeSettings().allowedDirs.length}</Pill>}
          >
            <AllowedDirs />
          </Panel>

          <Panel title="Appearance" actions={<ScopeTag scope="machine" />}>
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

        <Panel title="Session" actions={<ScopeTag scope="session" />}>
          <div class="kv">
            <span class="kv__k">Status</span>
            <span class="kv__v">{sess.status}</span>
            <span class="kv__k">Working directory</span>
            <span class="kv__v mono">
              {sess.cwd ? tildePath(sess.cwd, workspace.home) : "—"}
            </span>
            <span class="kv__k">CLI session id</span>
            <span class="kv__v mono">{sess.sessionId ?? "—"}</span>
            <span class="kv__k">Process</span>
            <span class="kv__v mono">{sess.pid ?? "—"}</span>
            <span class="kv__k">Claude Code</span>
            <span class="kv__v mono">
              {sess.meta.version || workspace.cliVersion || "not found"}
            </span>
            <span class="kv__k">Started</span>
            <span class="kv__v">
              {sess.startedAt
                ? `${clock(sess.startedAt)} · ${ago(sess.startedAt, now)}`
                : "—"}
            </span>
            {sess.turnEnd && (
              <>
                <span class="kv__k">Last turn ended</span>
                <span class="kv__v">
                  {
                    /* "completed" and "ran out of output tokens" look identical
                      on screen and mean very different things about whether the
                      answer you are reading is finished. */
                  }
                  {sess.turnEnd.reason || sess.turnEnd.stopReason || "—"}
                  {sess.turnEnd.stopReason &&
                      sess.turnEnd.stopReason !== sess.turnEnd.reason
                    ? ` · ${sess.turnEnd.stopReason}`
                    : ""}
                  {sess.turnEnd.ttftMs > 0
                    ? ` · first token in ${duration(sess.turnEnd.ttftMs)}`
                    : ""}
                </span>
              </>
            )}
            {sess.agentStats && sess.agentStats.spawned > 0 && (
              <>
                <span class="kv__k">Sub-agents last turn</span>
                <span class="kv__v">
                  {sess.agentStats.spawned} spawned ·{" "}
                  {sess.agentStats.completed} completed
                  {sess.agentStats.failed > 0
                    ? ` · ${sess.agentStats.failed} failed`
                    : ""}
                  {sess.agentStats.killed > 0
                    ? ` · ${sess.agentStats.killed} killed`
                    : ""}
                  {sess.agentStats.refused > 0
                    ? ` · ${sess.agentStats.refused} refused`
                    : ""}
                </span>
              </>
            )}
            <span class="kv__k">Turns · cost</span>
            <span class="kv__v">
              {sess.turns} · {usd(sess.cost)}
              {sess.queuedTurns > 0 ? ` · ${sess.queuedTurns} queued` : ""}
            </span>
            {sess.meta.outputStyle && (
              <>
                <span class="kv__k">Output style</span>
                <span class="kv__v">{sess.meta.outputStyle}</span>
              </>
            )}
            {
              /* Every window, with the time it resets. One headline percentage
                and no reset time left the two questions that matter — which
                limit, and how long until it lifts — both unanswered. */
            }
            {sess.rateLimit && (
              <>
                <span class="kv__k">Usage limits</span>
                <span class="kv__v">
                  <div style={{ display: "grid", gap: "4px" }}>
                    {(sess.rateLimit.windows.length > 0
                      ? sess.rateLimit.windows
                      : [{
                        name: sess.rateLimit.type || "window",
                        utilization: sess.rateLimit.utilization,
                        resetsAt: sess.rateLimit.resetsAt,
                      }]).map((w) => (
                        <div
                          key={w.name}
                          style={{
                            display: "flex",
                            gap: "8px",
                            alignItems: "center",
                          }}
                        >
                          <span style={{ minWidth: "72px" }}>
                            {w.name.replace("_", "-")}
                          </span>
                          <span
                            style={{
                              minWidth: "132px",
                              maxWidth: "180px",
                              flex: 1,
                            }}
                          >
                            <Meter value={w.utilization * 100} max={100} />
                          </span>
                          <span class="mono" style={{ minWidth: "38px" }}>
                            {Math.round(w.utilization * 100)}%
                          </span>
                          <span style={{ color: "var(--ink-dim)" }}>
                            {w.resetsAt > 0
                              ? `resets ${until(w.resetsAt, now)}`
                              : ""}
                          </span>
                        </div>
                      ))}
                    <span style={{ color: "var(--ink-dim)" }}>
                      {sess.rateLimit.status}
                      {sess.rateLimit.overage ? " · billed as overage" : ""}
                    </span>
                  </div>
                </span>
              </>
            )}
          </div>

          {sess.meta.tools.length > 0 && (
            <>
              <div class="divider" />
              <div class="grid" style={{ gap: "10px" }}>
                <Capability label="Tools" items={sess.meta.tools} />
                <Capability label="Agents" items={sess.meta.agents} />
                <Capability label="Skills" items={sess.meta.skills} />
                <Capability
                  label="Slash commands"
                  items={sess.meta.commands}
                  max={18}
                />
                {sess.meta.plugins.length > 0 && (
                  <div class="field">
                    <span class="field__label">
                      Plugins · {sess.meta.plugins.length}
                    </span>
                    <div class="tags">
                      {sess.meta.plugins.map((x) => (
                        <span key={x.name} class="tag">
                          {x.name}
                          {x.version ? ` · ${x.version}` : ""}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
                {sess.meta.mcp.length > 0 && (
                  <div class="field">
                    <span class="field__label">MCP servers</span>
                    <div class="tags">
                      {sess.meta.mcp.map((m) => (
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

        <Panel title="Transcript" actions={<ScopeTag scope="session" />}>
          <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
            <button
              type="button"
              class="btn btn--sm"
              onClick={() =>
                session.clearTranscript()}
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

/** Which project the settings below belong to. */
function ProjectScope(): VNode {
  const project = activeProject();
  if (!project) {
    return (
      <Banner tone="warn">
        No project selected — the settings below have nowhere to go. Pick one
        from the dock on the left, or add one under Projects.
      </Banner>
    );
  }
  return (
    <div class="scopebar">
      <span class="scopebar__icon">{IconFolder({ size: 14 })}</span>
      <span>
        Model, effort, permissions and allowed directories below are{" "}
        <b>{project.name}</b>&rsquo;s own, and are remembered with it. Every
        project keeps its own set.
      </span>
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
  const on = activeSettings().skipPermissions;

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

      {activeSettings().allowedDirs.length === 0
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
            {activeSettings().allowedDirs.map((d) => (
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
          <ScopeTag scope="machine" />
          {workspace.projects.some((p) => p.missing) && (
            <button
              type="button"
              class="btn btn--ghost btn--sm"
              title="Remove every project whose folder is gone. Their Claude Code history is untouched — delete that from Storage, where its size is shown."
              onClick={() => workspace.removeMissingProjects()}
            >
              Remove gone
            </button>
          )}
          <button
            type="button"
            class="btn btn--sm btn--ghost"
            title="Re-check every project against the disk, and refresh the branch"
            aria-label="Re-check projects"
            onClick={() => workspace.refreshProjects()}
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
                    {p.missing ? <Pill tone="danger">folder is gone</Pill> : (
                      <>
                        {p.branch && <Pill>{p.branch}</Pill>}
                        {p.dirty && <Pill tone="warn">dirty</Pill>}
                      </>
                    )}
                  </span>
                }
                // Trimmed from the left: a path is read from its tail, and the
                // first 60 characters of one say only which machine it is on.
                hint={tailPath(tildePath(p.path, workspace.home), 52)}
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
                    {
                      /* Always removable. Gating this on "more than one
                        project" was a dead end with no exit: a single project
                        whose folder had been deleted could not be started and
                        could not be removed either. */
                    }
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
                      // A `<span role="button">` gets no key handling for free,
                      // and it cannot be a real `<button>` here — it sits inside
                      // the row's own button, which nesting forbids. Enter and
                      // Space are wired by hand so the row is operable from the
                      // keyboard, not only the mouse.
                      onKeyDown={(e: KeyboardEvent) => {
                        if (e.key !== "Enter" && e.key !== " ") return;
                        e.preventDefault();
                        e.stopPropagation();
                        workspace.removeProject(p.id);
                      }}
                    >
                      {IconTrash({ size: 13 })}
                    </span>
                  </span>
                }
              />
            ))}
          </div>
        )}
      {workspace.projects.some((p) => p.missing) && (
        <div
          class="field__hint"
          style={{ marginTop: "10px", color: "var(--danger)" }}
        >
          A folder marked <b>gone</b>{" "}
          is no longer on disk — a session cannot start in it. Select a
          different project, or remove the row.
        </div>
      )}
      <div class="field__hint" style={{ marginTop: "10px" }}>
        Switching projects takes effect on the next session start.
      </div>
    </Panel>
  );
}
