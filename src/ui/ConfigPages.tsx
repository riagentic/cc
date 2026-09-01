/**
 * @module
 * The configuration pages: Skills, Commands, MCP, Plugins and Hooks.
 *
 * All five answer the same question about a different thing — *what can this
 * session do, where did it come from, and is it actually loaded* — so they are
 * one module with one row shape rather than five files that drift apart.
 *
 * The distinction every page here draws, and the reason they exist at all:
 *
 *  - **loaded** — the running session reported it in `system/init`. It affects
 *    the next turn.
 *  - **on disk** — a file declares it, but this session did not load it. Almost
 *    always because the session started before the file did, which is a restart
 *    away and not a mystery worth debugging.
 *
 * Showing only the first hides a hook you just wrote; showing only the second
 * claims a capability the session does not have.
 */
import { useLocal, type VNode } from "aio/air";
import {
  catalog,
  commandEntries,
  type Entry,
  mcpEntries,
  pluginEntries,
  skillEntries,
} from "../cell/catalog.ts";
import { view } from "../cell/session.ts";
import { workspace } from "../cell/workspace.ts";
import type { HookInfo, Scope } from "../type/claude.ts";
import { ago, tildePath } from "../lib/format.ts";
import {
  Banner,
  Empty,
  matches,
  Panel,
  Pill,
  Search,
  useNow,
} from "./parts.tsx";
import { PageHead, type PageScope } from "./RunViews.tsx";
import {
  IconCommand,
  IconHook,
  IconPlug,
  IconPlugin,
  IconRefresh,
  IconSpark,
} from "./icons.tsx";

/** Where a definition came from. Named rather than colour-coded alone: "which
 *  file do I edit to change this" is the question a scope answers. */
function ScopePill(props: { scope: Scope | string }): VNode {
  switch (props.scope) {
    case "project":
      return <Pill tone="accent">project</Pill>;
    case "user":
      return <Pill>user</Pill>;
    case "plugin":
      return <Pill tone="warn">plugin</Pill>;
    case "builtin":
      return <Pill>built-in</Pill>;
    default:
      return <Pill>{String(props.scope)}</Pill>;
  }
}

/** Loaded by the running session, or only sitting on disk. */
const LivePill = (props: { live: boolean }): VNode =>
  props.live
    ? <Pill tone="ok">loaded</Pill>
    : <Pill tone="warn">needs restart</Pill>;

/** The shared frame: title, filter, refresh, error, empty state. Every page
 *  below is this plus a row renderer. */
function ConfigPage(
  props: {
    title: string;
    sub: string;
    scope: PageScope;
    icon: VNode;
    emptyTitle: string;
    emptyHint: string;
    count: number;
    children: unknown;
    query: string;
    onQuery: (v: string) => void;
  },
): VNode {
  return (
    <div class="page">
      <PageHead
        title={props.title}
        scope={props.scope}
        sub={props.sub}
        actions={
          <>
            <Search
              value={props.query}
              onChange={props.onQuery}
              label={`Filter ${props.title.toLowerCase()}`}
            />
            <button
              type="button"
              class="btn btn--ghost btn--sm btn--icon"
              title="Re-read configuration from disk"
              aria-label="Refresh configuration"
              onClick={() => catalog.refresh()}
            >
              {IconRefresh({ size: 15 })}
            </button>
          </>
        }
      />
      <div class="page__body grid">
        {catalog.error && <Banner tone="warn">{catalog.error}</Banner>}
        {props.count === 0
          ? (
            <Panel>
              <Empty
                icon={props.icon}
                title={props.emptyTitle}
                hint={props.emptyHint}
              />
            </Panel>
          )
          : props.children}
      </div>
    </div>
  );
}

/** Skills and commands share a shape exactly, so they share a renderer. */
function DefinitionList(props: { entries: Entry[]; icon: VNode }): VNode {
  return (
    <Panel flush title={`${props.entries.length} shown`}>
      <div class="rowlist">
        {props.entries.map((e) => (
          <div key={`${e.scope}:${e.name}`} class="rowitem">
            <span class="rowitem__icon">{props.icon}</span>
            <span class="truncate">
              <span class="rowitem__title">{e.name}</span>
              <br />
              <span class="rowitem__detail">
                {e.description || (e.path
                  ? tildePath(e.path, workspace.home)
                  : "Built into the CLI — no file behind it")}
              </span>
              {e.path && e.description && (
                <>
                  <br />
                  <span
                    class="rowitem__detail"
                    style={{ color: "var(--ink-dim)", opacity: ".75" }}
                    title={e.path}
                  >
                    {tildePath(e.path, workspace.home)}
                  </span>
                </>
              )}
            </span>
            <span
              class="rowitem__meta"
              style={{ display: "flex", gap: "4px", flexWrap: "wrap" }}
            >
              <ScopePill scope={e.scope} />
              <LivePill live={e.live} />
            </span>
          </div>
        ))}
      </div>
    </Panel>
  );
}

/** How many of a list the session actually loaded — the sub-heading every page
 *  here carries, because "12 found" alone does not say whether they are on. */
const liveSub = (entries: { live: boolean }[], noun: string): string => {
  const live = entries.filter((e) => e.live).length;
  if (entries.length === 0) return `No ${noun}`;
  return live === entries.length
    ? `${entries.length} ${noun}, all loaded`
    : `${entries.length} ${noun} · ${live} loaded by this session`;
};

export function SkillsPage(): VNode {
  const [query, setQuery] = useLocal("");
  const all = skillEntries();
  const shown = all.filter((e) => matches(query, e.name, e.description));
  return (
    <ConfigPage
      title="Skills"
      scope="project"
      sub={liveSub(all, "skills")}
      icon={IconSpark({ size: 20 })}
      count={all.length}
      emptyTitle="No skills"
      emptyHint="A skill is a folder of instructions the model loads on demand, from .claude/skills in this project or in your home directory."
      query={query}
      onQuery={setQuery}
    >
      <DefinitionList entries={shown} icon={IconSpark({ size: 15 })} />
    </ConfigPage>
  );
}

export function CommandsPage(): VNode {
  const [query, setQuery] = useLocal("");
  const all = commandEntries();
  const shown = all.filter((e) => matches(query, e.name, e.description));
  return (
    <ConfigPage
      title="Commands"
      scope="project"
      sub={liveSub(all, "commands")}
      icon={IconCommand({ size: 20 })}
      count={all.length}
      emptyTitle="No slash commands"
      emptyHint="A command is a prompt saved as a file under .claude/commands, invoked with a leading slash."
      query={query}
      onQuery={setQuery}
    >
      <DefinitionList entries={shown} icon={IconCommand({ size: 15 })} />
    </ConfigPage>
  );
}

export function McpPage(): VNode {
  const [query, setQuery] = useLocal("");
  const all = mcpEntries();
  const shown = all.filter((m) => matches(query, m.name, m.target, m.status));
  const connected =
    all.filter((m) => m.status === "connected" || m.status === "ready").length;

  return (
    <ConfigPage
      title="MCP"
      scope="project"
      sub={all.length === 0
        ? "No servers configured"
        : `${connected}/${all.length} connected`}
      icon={IconPlug({ size: 20 })}
      count={all.length}
      emptyTitle="No MCP servers"
      emptyHint="MCP servers add tools to a session. Configure them in .mcp.json in the project, or in your settings."
      query={query}
      onQuery={setQuery}
    >
      <Panel flush title={`${shown.length} shown`}>
        <div class="rowlist">
          {shown.map((m) => (
            <div key={m.name} class="rowitem">
              <span class="rowitem__icon">{IconPlug({ size: 15 })}</span>
              <span class="truncate">
                <span class="rowitem__title">{m.name}</span>
                <br />
                <span class="rowitem__detail truncate" title={m.target}>
                  {m.target ||
                    "Configured outside the files this app reads — the session found it, we did not."}
                </span>
                {m.path && (
                  <>
                    <br />
                    <span
                      class="rowitem__detail"
                      style={{ color: "var(--ink-dim)", opacity: ".75" }}
                    >
                      {tildePath(m.path, workspace.home)}
                    </span>
                  </>
                )}
              </span>
              <span
                class="rowitem__meta"
                style={{ display: "flex", gap: "4px", flexWrap: "wrap" }}
              >
                {m.transport && <Pill>{m.transport}</Pill>}
                <ScopePill scope={m.scope} />
                {
                  /* Configured and reachable are different facts. An empty
                    status means the running session said nothing about this
                    server — usually because it started before the config did. */
                }
                {m.status === "connected" || m.status === "ready"
                  ? <Pill tone="ok">{m.status}</Pill>
                  : m.status
                  ? <Pill tone="danger">{m.status}</Pill>
                  : <Pill tone="warn">not in session</Pill>}
              </span>
            </div>
          ))}
        </div>
      </Panel>
    </ConfigPage>
  );
}

export function PluginsPage(): VNode {
  const [query, setQuery] = useLocal("");
  const now = useNow(true, 60_000);
  const all = pluginEntries();
  const shown = all.filter((p) => matches(query, p.name, p.marketplace));

  return (
    <ConfigPage
      title="Plugins"
      scope="machine"
      sub={all.length === 0
        ? "No plugins installed"
        : `${all.filter((p) => p.loaded).length}/${all.length} loaded`}
      icon={IconPlugin({ size: 20 })}
      count={all.length}
      emptyTitle="No plugins"
      emptyHint="Plugins bundle skills, commands, agents and MCP servers. Install them with claude plugin from a marketplace."
      query={query}
      onQuery={setQuery}
    >
      <Panel flush title={`${shown.length} shown`}>
        <div class="rowlist">
          {shown.map((p) => (
            <div key={`${p.name}@${p.marketplace}`} class="rowitem">
              <span class="rowitem__icon">{IconPlugin({ size: 15 })}</span>
              <span class="truncate">
                <span class="rowitem__title">{p.name}</span>
                <br />
                <span class="rowitem__detail">
                  {p.marketplace || "local"}
                  {p.version && ` · v${p.version}`}
                  {p.installedAt > 0 &&
                    ` · added ${ago(p.installedAt, now)}`}
                </span>
              </span>
              <span
                class="rowitem__meta"
                style={{ display: "flex", gap: "4px", flexWrap: "wrap" }}
              >
                <ScopePill scope={p.scope} />
                {
                  /* Installed, switched on, and loaded are three states, and an
                    installed-but-disabled plugin looks identical to a broken
                    one unless they are told apart. */
                }
                {!p.enabled
                  ? <Pill>disabled</Pill>
                  : p.loaded
                  ? <Pill tone="ok">loaded</Pill>
                  : <Pill tone="warn">needs restart</Pill>}
              </span>
            </div>
          ))}
        </div>
      </Panel>
    </ConfigPage>
  );
}

/** Hooks, grouped by the event they fire on — the axis anybody reasoning about
 *  them thinks in ("what runs before a tool call?"). */
export function HooksPage(): VNode {
  const [query, setQuery] = useLocal("");
  const all = catalog.hooks;
  const shown = all.filter((h) =>
    matches(query, h.event, h.matcher, h.command)
  );
  const byEvent = new Map<string, HookInfo[]>();
  for (const h of shown) {
    byEvent.set(h.event, [...(byEvent.get(h.event) ?? []), h]);
  }

  return (
    <ConfigPage
      title="Hooks"
      scope="project"
      sub={all.length === 0
        ? "No hooks configured"
        : `${all.length} across ${
          new Set(all.map((h) => h.event)).size
        } events`}
      icon={IconHook({ size: 20 })}
      count={all.length}
      emptyTitle="No hooks"
      emptyHint="A hook runs a shell command at a point in the session's lifecycle — before a tool call, after an edit, when a turn stops. Configure them in .claude/settings.json."
      query={query}
      onQuery={setQuery}
    >
      {
        /* Said once, at the top: these are commands that run on this machine
          without a prompt. That is the whole point of a hook and also the whole
          risk of one, and a list that does not say so is under-reporting. */
      }
      <Banner tone="warn">
        Every command below runs on this machine, automatically, without an
        approval prompt. Session{" "}
        {view().meta.version ? `on CLI ${view().meta.version}` : "not running"}.
      </Banner>
      {[...byEvent.entries()].map(([event, hooks]) => (
        <Panel key={event} flush title={`${event} · ${hooks.length}`}>
          <div class="rowlist">
            {hooks.map((h, i) => (
              <div key={`${event}-${i}`} class="rowitem">
                <span class="rowitem__icon">{IconHook({ size: 15 })}</span>
                <span class="truncate">
                  <span class="rowitem__title mono">{h.command}</span>
                  <br />
                  <span class="rowitem__detail">
                    {h.matcher ? `on ${h.matcher}` : "on every tool"} ·{" "}
                    {tildePath(h.path, workspace.home)}
                  </span>
                </span>
                <span
                  class="rowitem__meta"
                  style={{ display: "flex", gap: "4px" }}
                >
                  <Pill>{h.type}</Pill>
                  <ScopePill scope={h.scope} />
                </span>
              </div>
            ))}
          </div>
        </Panel>
      ))}
    </ConfigPage>
  );
}
