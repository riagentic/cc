/**
 * @module
 * Settings — the project Claude Code runs in, the model it runs on, what it is
 * allowed to do, and everything the running session reports about itself.
 *
 * Changes that need a fresh process say so instead of pretending to apply.
 */
import { useLocal, useRef, type VNode } from "aio/air";
import { session, view } from "../cell/session.ts";
import {
  activeIsLocal,
  local,
  localChat,
  strayConfigs,
} from "../cell/local.ts";
import { EnginePanel } from "./LocalChatPage.tsx";
import { AppearanceFields, ShortcutList } from "./Appearance.tsx";
import { AbsentOffer, BrowseButton } from "./AddProject.tsx";
import { MachinePanel } from "./Machine.tsx";
import { showToast } from "./toast.tsx";
import { ExportActions } from "./Export.tsx";
import {
  localTranscriptMarkdown,
  transcriptMarkdown,
} from "../lib/transcript.ts";
import { prefs } from "../cell/prefs.ts";
import {
  activeProject,
  activeSessionKey,
  activeSettings,
  pruneUnknown,
  workspace,
} from "../cell/workspace.ts";
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
  matchesAll,
  Menu,
  Meter,
  Panel,
  Pill,
  Search,
  Segmented,
  Tags,
  useNow,
} from "./parts.tsx";
import { PageHead, type PageScope, ScopeTag } from "./RunViews.tsx";
import {
  IconAlert,
  IconCheck,
  IconFolder,
  IconPlay,
  IconPlus,
  IconPower,
  IconRefresh,
  IconSearch,
  IconTrash,
} from "./icons.tsx";

/**
 * What each panel is *about*, in the words a person would type looking for it.
 *
 * One table rather than a `keys` prop per panel, for one reason: the page has
 * to know whether the filter matched **anything** in order to say so, and it
 * cannot ask fourteen components that each decided for themselves. Titles are
 * the keys, so a panel and its search terms cannot drift apart.
 */
const SECTION_KEYS: Record<string, string> = {
  "Engine":
    "local llm lm studio ollama llama.cpp model server provider context window offline detect scan",
  "Projects":
    "folder directory add remove gone missing branch dirty switch repository tab forget undo restore",
  "Model": "opus sonnet haiku fable claude reasoning switch",
  "Effort": "thinking reasoning budget low medium high xhigh max --effort",
  "Permissions":
    "approval prompt ask accept edits plan bypass dontask safety guardrails mode",
  "Allowed directories":
    "add-dir folder path outside project sandbox scope write tmp",
  "Allow all permissions":
    "dangerously skip permissions bypass unrestricted danger",
  "Appearance":
    "theme dark light system colour color window accent zoom font size bigger smaller density compact comfortable width narrow motion animation timestamps wrap code sound chime",
  "Keyboard": "shortcut key binding chord palette hotkey command",
  "Machine":
    "cpu processor gpu ram memory vram video card nvidia amd load usage temperature hardware",
  "Session":
    "status pid process cwd cost turns usage limit rate tools skills commands mcp plugins version",
  "Transcript":
    "clear history conversation wipe view export save copy markdown download",
  "Conversation":
    "clear history wipe local export save copy markdown transcript",
};

/** Panels that only exist while the project runs on the Claude Code CLI. */
const CLAUDE_ONLY = new Set([
  "Model",
  "Effort",
  "Permissions",
  "Allowed directories",
  "Allow all permissions",
  "Session",
  "Transcript",
]);

/** How many panels a query would leave on screen. Zero is the only number the
 *  page needs to treat specially, and the only one it cannot see otherwise. */
function sectionHits(query: string, isLocal: boolean): number {
  return Object.entries(SECTION_KEYS).filter(([title, keys]) =>
    (!isLocal || !CLAUDE_ONLY.has(title)) && matchesAll(query, title, keys)
  ).length;
}

/**
 * One settings panel, shown only while it matches the filter.
 *
 * The filter is not decoration. This page carries fourteen panels across three
 * different scopes, and the thing a person arrives looking for — "where do I
 * turn the prompts off", "what is this session costing" — is a word, not a
 * position on a scroll bar. So every panel declares the words somebody would
 * actually type at it (`keys`), not just its title: nobody searches for
 * "Permissions" when what they want is "bypass".
 */
function Section(
  props: {
    query: string;
    title: string;
    scope?: PageScope;
    actions?: unknown;
    children?: unknown;
  },
): VNode | null {
  if (!matchesAll(props.query, props.title, SECTION_KEYS[props.title])) {
    return null;
  }
  return (
    <Panel
      title={props.title}
      actions={
        <>
          {props.actions}
          {props.scope && <ScopeTag scope={props.scope} />}
        </>
      }
    >
      {props.children}
    </Panel>
  );
}

export function SettingsPage(): VNode {
  // One resolution per render: `view()` resolves by key, and repeating
  // the call also defeats every narrowing of its nullable fields.
  const sess = view();
  // Built on demand, not on every render: a long conversation is megabytes of
  // string, and nothing needs it until somebody presses Copy or Save.
  const transcript = () =>
    sess.messages.length === 0 ? "" : transcriptMarkdown(
      activeProject()?.name ?? "Conversation",
      sess.messages,
    );
  const localTranscript = () =>
    localTranscriptMarkdown(
      activeProject()?.name ?? "Conversation",
      localChat(activeSessionKey()).messages,
    );
  // Slow, but ticking: "started 3s ago" otherwise stayed "3s ago" for as long as
  // an idle session left the page with nothing else to re-render it.
  const now = useNow(true, 10_000);
  const live = sess.status !== "offline" && sess.status !== "error";
  // On a local engine, the panels that configure the Claude Code CLI vanish —
  // they set flags on a process this project does not run. Projects,
  // Appearance and the engine switch itself stay: those belong to the app.
  const isLocal = activeIsLocal();
  const [query, setQuery] = useLocal("");
  const q = query.trim();

  return (
    <div class="page">
      <PageHead
        title="Settings"
        sub="Some of this belongs to the project, some to the machine"
        actions={
          <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
            <Search
              value={query}
              onChange={setQuery}
              label="Filter settings"
              placeholder="Filter settings…"
            />
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
                    onClick={() =>
                      session.stop()}
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

        {q !== "" && sectionHits(q, isLocal) === 0 && (
          <NoSettingsMatch
            query={q}
            onClear={() => setQuery("")}
          />
        )}

        {
          /* Said once, above the panels that mean it: these are settings for
            ONE codebase. Every project keeps its own, seeded from what the CLI
            is configured to do in that directory, and a change here follows the
            project rather than the app — which is the whole point, and is also
            the thing a reader would otherwise have to guess. */
        }
        <ProjectScope />

        <Section
          query={q}
          title="Engine"
          scope="project"
        >
          <EnginePanel />
        </Section>

        <Section
          query={q}
          title="Conversation"
          scope="session"
          actions={
            <ExportActions
              empty={localChat(activeSessionKey()).messages.length === 0}
              markdown={localTranscript}
            />
          }
        >
          <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
            <button
              type="button"
              class="btn btn--sm"
              onClick={() => {
                void local.clear();
                showToast({
                  text: "Conversation cleared.",
                  action: {
                    label: "Undo",
                    run: () => void local.undoClear(),
                  },
                });
              }}
            >
              {IconTrash({ size: 13 })} Clear the conversation
            </button>
            <span class="field__hint">
              Starts the local model on a blank slate. Nothing is sent anywhere
              — the conversation only ever existed in this window.
            </span>
          </div>
        </Section>

        <div class="grid grid--2">
          <Projects query={q} />

          {!isLocal && (
            <>
              <Section
                query={q}
                title="Model"
                scope="project"
                actions={<Pill>{activeSettings().model}</Pill>}
              >
                <div class="choices">
                  {MODELS.map((m) => (
                    <Choice
                      key={m.id}
                      label={m.label}
                      name={m.label}
                      hint={m.hint}
                      selected={activeSettings().model === m.id}
                      // Switches the running session too, not just the next
                      // one — see `session.useModel`.
                      onSelect={() => void session.useModel(m.id)}
                    />
                  ))}
                </div>
              </Section>

              <Section
                query={q}
                title="Effort"
                scope="project"
                actions={<Pill>{activeSettings().effort || "default"}</Pill>}
              >
                <div class="choices" key="efforts">
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
                <div
                  class="field__hint"
                  key="foot"
                  style={{ marginTop: "10px" }}
                >
                  How hard the model works before it answers (<code>
                    --effort
                  </code>). <b>Default</b>{" "}
                  passes no flag at all, so whatever you have configured for the
                  CLI itself still applies.
                </div>
              </Section>

              <Section
                query={q}
                title="Permissions"
                scope="project"
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
                  is the working default — file edits go through, anything
                  reaching further asks. <b>Ask always</b>{" "}
                  holds the edits too, which is the mode to pick when you want
                  to see each change before it lands; the CLI still clears
                  trivia like an <code>echo</code>{" "}
                  on its own. Anything the CLI blocks by itself is still
                  reported on the Activity timeline, never swallowed.
                </div>
              </Section>

              <Section
                query={q}
                title="Allowed directories"
                scope="project"
                actions={<Pill>{activeSettings().allowedDirs.length}</Pill>}
              >
                <AllowedDirs />
              </Section>
            </>
          )}

          <Section
            query={q}
            title="Appearance"
            scope="machine"
            actions={
              <button
                type="button"
                class="btn btn--sm btn--ghost"
                title="Put every appearance choice back to its default"
                onClick={() => {
                  // Snapshotted before the reset, and offered straight back:
                  // a Reset that quietly discards ten deliberate choices is
                  // a button nobody presses twice.
                  const before = {
                    accent: prefs.accent,
                    zoom: prefs.zoom,
                    density: prefs.density,
                    motion: prefs.motion,
                    chatWidth: prefs.chatWidth,
                    timestamps: prefs.timestamps,
                    codeWrap: prefs.codeWrap,
                    sounds: prefs.sounds,
                    dockCollapsed: prefs.dockCollapsed,
                    railCollapsed: prefs.railCollapsed,
                  };
                  prefs.reset();
                  showToast({
                    text: "Appearance back to its defaults.",
                    action: {
                      label: "Undo",
                      run: () => prefs.restore(before),
                    },
                  });
                }}
              >
                Reset
              </button>
            }
          >
            <AppearanceFields />
          </Section>

          <Section query={q} title="Keyboard" scope="machine">
            <ShortcutList />
          </Section>

          {matchesAll(q, "Machine", SECTION_KEYS["Machine"]) &&
            <MachinePanel />}
        </div>

        {!isLocal &&
          matchesAll(
            q,
            "Allow all permissions",
            SECTION_KEYS["Allow all permissions"],
          ) && <AllowAll />}

        {!isLocal && (
          <Section
            query={q}
            title="Session"
            scope="session"
          >
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
                              <Meter
                                value={w.utilization * 100}
                                max={100}
                                label={`${w.name} usage window`}
                              />
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
                      <span key="status" style={{ color: "var(--ink-dim)" }}>
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
          </Section>
        )}

        {!isLocal && (
          <Section
            query={q}
            title="Transcript"
            scope="session"
            actions={
              <ExportActions
                empty={sess.messages.length === 0}
                markdown={transcript}
              />
            }
          >
            <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
              <button
                type="button"
                class="btn btn--sm"
                onClick={() => {
                  session.clearTranscript();
                  showToast({
                    text:
                      "Transcript cleared. The CLI still remembers the conversation.",
                    action: { label: "Undo", run: () => session.undoClear() },
                  });
                }}
              >
                {IconTrash({ size: 13 })} Clear the view
              </button>
              <span class="field__hint">
                Clears what this app displays. The model keeps its own context —
                use Restart for a genuinely fresh session.
              </span>
            </div>
          </Section>
        )}
      </div>
    </div>
  );
}

/**
 * Shown when a filter hides everything.
 *
 * The count comes from the same table the panels filter themselves against,
 * so "nothing matched" and "nothing rendered" cannot disagree — which is the
 * one thing a filter must never get wrong: an empty page with no explanation.
 */
function NoSettingsMatch(
  props: { query: string; onClear: () => void },
): VNode {
  return (
    <Panel>
      <Empty
        icon={IconSearch({ size: 20 })}
        title={`Nothing matches "${props.query}"`}
        hint="Try a single word — model, effort, permissions, folder, theme, engine."
      >
        <button type="button" class="btn btn--sm" onClick={props.onClear}>
          Clear the filter
        </button>
      </Empty>
    </Panel>
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

function Projects(props: { query: string }): VNode | null {
  const ref = useRef<HTMLInputElement>(null!);
  const [adding, setAdding] = useLocal(false);
  const active = activeProject();
  if (!matchesAll(props.query, "Projects", SECTION_KEYS["Projects"])) {
    return null;
  }

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
      {
        /* Each of these is wrapped in a keyed element that always renders,
          rather than left as a bare `cond &&`. A falsy conditional is still a
          child — an unkeyed null — and a parent holding several of those
          reconciles them by position, which is how one panel's controls end up
          in another's DOM node after a re-render. */
      }
      <div key="add-field">
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
            <button
              type="button"
              class="btn btn--sm btn--primary"
              onClick={add}
            >
              Add
            </button>
            <BrowseButton
              onPick={(picked: string) => {
                if (ref.current) {
                  ref.current.value = picked;
                }
                void workspace.addProject(picked);
                setAdding(false);
              }}
            />
          </div>
        )}
      </div>
      <div key="absent">
        <AbsentOffer />
      </div>

      {workspace.projects.length === 0
        ? (
          <Empty
            key="none"
            icon={IconFolder({ size: 20 })}
            title="No projects"
            hint="Add a directory to point Claude Code at it."
          />
        )
        : (
          <div class="choices" key="list">
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
      <div key="gone-note">
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
      </div>

      {
        /* The sweep, and the switch for it. On by default, and stated plainly
          rather than left as behaviour people have to infer from tabs
          disappearing: the exact test it applies is the difference between a
          tidy list and a lost project. */
      }
      {
        /* Leftovers from before removals released their own state, or from a
          crash. A button, not a timer: the sweep compares stored ids against
          the project list, and the only time that list is unambiguous is when
          somebody is looking at it. */
      }
      <div key="strays">
        {strayConfigs().length > 0 && (
          <>
            <div class="divider" />
            <div class="field">
              <span class="field__label">Leftover settings</span>
              <div
                style={{ display: "flex", gap: "8px", alignItems: "center" }}
              >
                <button
                  type="button"
                  class="btn btn--sm"
                  onClick={() => pruneUnknown()}
                >
                  {IconTrash({ size: 13 })} Forget {strayConfigs().length} stray
                  {strayConfigs().length === 1 ? " entry" : " entries"}
                </button>
                <span class="field__hint" style={{ flex: 1 }}>
                  Engine settings and loops still stored for projects that are
                  no longer in this list. Nothing on disk is touched.
                </span>
              </div>
            </div>
          </>
        )}
      </div>

      <div class="divider" key="divider" />
      <div class="field" key="auto-forget">
        <span class="field__label">When a project folder is gone</span>
        <Segmented
          value={workspace.autoForget ? "forget" : "keep"}
          options={[
            { id: "forget", label: "Forget the project" },
            { id: "keep", label: "Keep it, marked gone" },
          ]}
          onChange={(v) => workspace.setAutoForget(v === "forget")}
        />
        <span class="field__hint">
          Checked every 20 seconds and on every start. A project is only
          forgotten when the folder <i>above</i>{" "}
          it is still there — so a deleted directory drops out, while an
          unmounted drive or a locked home keeps every project on it. Removing a
          project never touches the folder or Claude Code&rsquo;s history for
          it, and the dock offers an <b>Undo</b> until you dismiss it.
        </span>
      </div>

      <div class="field__hint" key="foot" style={{ marginTop: "10px" }}>
        Switching projects takes effect on the next session start.
      </div>
    </Panel>
  );
}
