/**
 * @module
 * Catalog — the configuration that decides what a session *can* do: skills,
 * slash commands, MCP servers, plugins and hooks.
 *
 * Two sources, deliberately joined rather than picked between:
 *
 *  - **`system/init`** says what the running session actually loaded. It is the
 *    truth about this turn, and it is a bare list of names.
 *  - **the files on disk** say what each one is, where it came from, and which
 *    scope defined it — everything needed to go and change it.
 *
 * Either alone misleads. Disk alone lists a hook the session never loaded
 * because it was started before the file was written; the session alone names a
 * skill with no way to find out what it does or where it lives. Every page here
 * shows both, and says when they disagree.
 */
import { cell, log, type MethodDraftMeta, schedule } from "aio";
import type {
  HookInfo,
  McpInfo,
  MemoryFile,
  PluginInfo,
  SkillInfo,
} from "../type/claude.ts";
import { view } from "./session.ts";
import { activeProject } from "./workspace.ts";

/** How stale an automatic memory measurement may be before it is taken again.
 *  The Rescan button never waits — this only paces the automatic passes, which
 *  the CLI triggers by re-emitting `init` after every result. */
const RESCAN_MS = 15_000;

/** What a measurement was taken over: the project, plus the session memory
 *  directories the CLI reported. When this changes the figure on screen is
 *  about somewhere else, so the pacing above must not hold the new one back. */
const scanKey = (path: string, dirs: readonly string[]): string =>
  [path, ...dirs].join("\n");

type CatalogState = {
  skills: SkillInfo[];
  commands: SkillInfo[];
  mcp: McpInfo[];
  plugins: PluginInfo[];
  hooks: HookInfo[];
  /**
   * Every `CLAUDE.md` and memory file in play, measured on disk.
   *
   * Here rather than on the session, because that is what it is: a fact about
   * the project's files. Kept on the session record it was only ever measured
   * when a session started, so a project you had merely *selected* reported
   * "Not scanned" while its `CLAUDE.md` sat on disk — the one page in the
   * Project group that needed a running process to say anything.
   */
  memory: MemoryFile[];
  memoryScannedAt: number | null;
  /** What the measurement above was taken over ({@link scanKey}). */
  memoryScannedFor: string;
  /** The project the scan was of, so a stale catalog is detectable. */
  root: string;
  scannedAt: number;
  loading: boolean;
  error: string | null;
};

/* ── plain helpers ────────────────────────────────────────────────────────── */

/**
 * Measure the project's memory into the draft.
 *
 * A plain function so both callers apply it to *this* draft: the full refresh,
 * and the cheap memory-only pass the session triggers when the CLI finally
 * names its session memory directories.
 */
async function scanMemory(
  s: CatalogState,
  root: string,
  force: boolean,
): Promise<void> {
  if (!root) {
    s.memory = [];
    s.memoryScannedAt = null;
    s.memoryScannedFor = "";
    return;
  }
  // The session's own memory directories, when there is a session. They are the
  // one part of this that a running process knows and the disk does not.
  const dirs = [...view().meta.memoryPaths];
  const key = scanKey(root, dirs);
  const at = s.memoryScannedAt;
  const fresh = at !== null && Date.now() - at < RESCAN_MS;
  if (!force && fresh && s.memoryScannedFor === key) return;

  const io = await import("./claude.server.ts");
  const files = await io.scanMemory(root, dirs);
  s.memory = files;
  s.memoryScannedAt = Date.now();
  s.memoryScannedFor = key;
}

export const catalog = cell("catalog", {
  // Read from disk in a few milliseconds. Persisting it would only create a
  // window in which the app shows configuration that has since been edited.
  persist: "none",

  // Live reads, for the same reason as the tree cell: a burst of project
  // switches puts two scans in flight, and under snapshot isolation the second
  // one's commit is refused rather than merged — leaving the pages showing the
  // configuration of the project you just left.
  transaction: false,

  state: {
    skills: [] as SkillInfo[],
    commands: [] as SkillInfo[],
    mcp: [] as McpInfo[],
    plugins: [] as PluginInfo[],
    hooks: [] as HookInfo[],
    memory: [] as MemoryFile[],
    memoryScannedAt: null as number | null,
    memoryScannedFor: "",
    root: "",
    scannedAt: 0,
    loading: false,
    error: null as string | null,
  },

  onInit() {
    // The cell's runtime is not up during `onInit`; the first scan waits a tick
    // like every other cell here.
    setTimeout(() => void catalog.refresh(), 0); // aiol-ok
  },

  methods: {
    /** Re-read every configuration source for the active project. */
    async refresh(s: CatalogState) {
      const project = activeProject();
      // No project yet: the user-scope halves are still real and still worth
      // showing. `""` asks for those alone — the server skips every project
      // file rather than resolving it against the app's own directory.
      const root = project?.path ?? "";
      s.loading = true;
      try {
        const io = await import("./catalog.server.ts");
        const [skills, commands, mcp, plugins, hooks] = await Promise.all([
          io.scanDefinitionDirs(root, "skill"),
          io.scanDefinitionDirs(root, "command"),
          io.scanMcp(root),
          io.scanPlugins(),
          io.scanHooks(root),
        ]);
        // The project this scan was *of*, checked again now it has finished:
        // a slower scan of the project you just left must not overwrite the
        // one you are on. aiol-ok: that re-read is the point
        if ((activeProject()?.path ?? "") !== root) return;
        s.skills = skills;
        s.commands = commands;
        s.mcp = mcp;
        s.plugins = plugins;
        s.hooks = hooks;
        s.root = root;
        s.scannedAt = Date.now();
        s.error = null;
        // Forced: `refresh` runs on a project switch, and the previous
        // project's measurement is not a fresh answer about this one.
        await scanMemory(s, root, true);
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        s.error = reason;
        log.warn("catalog", "scan failed", { error: reason });
      } finally {
        s.loading = false;
      }
    },

    /**
     * Re-measure memory only.
     *
     * Separate from {@link refresh} because the CLI re-emits `system/init` after
     * every result, and walking the whole configuration tree on each one would
     * be several subprocesses' worth of work for a figure that has not moved.
     * `force` is the Rescan button, which never waits.
     */
    async refreshMemory(s: CatalogState, force = true) {
      const root = activeProject()?.path ?? "";
      try {
        await scanMemory(s, root, force);
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        s.error = reason;
        log.warn("catalog", "memory scan failed", { error: reason });
      }
    },

    /** The project changed — re-scan, shortly. Debounced for the same reason
     *  the tree's is: switching project happens in bursts. */
    reproject(s: CatalogState & Partial<MethodDraftMeta>) {
      s.$do?.(
        schedule.after("catalog-reproject", 60, catalog.refresh.action()),
      );
    },
  },
});

/* ── joins with the running session ──────────────────────────────────────────
 *
 * Each of these answers the same question in the same shape: everything the
 * session loaded, plus everything on disk that it did not, each labelled with
 * which of the two it came from. A name in only one column is the interesting
 * case — it is either configuration that needs a restart to take effect, or a
 * capability with no file behind it to go and read.
 */

/** A catalog row as the pages render it. */
export type Entry = SkillInfo & {
  /** The running session loaded this one. */
  live: boolean;
};

/** Join a name list from `system/init` with definitions found on disk. */
function join(
  loaded: readonly string[],
  onDisk: readonly SkillInfo[],
): Entry[] {
  const byName = new Map<string, Entry>();
  for (const d of onDisk) byName.set(d.name, { ...d, live: false });
  for (const raw of loaded) {
    // The CLI names a plugin's contribution `plugin:name`; the file behind it
    // sits under the plugin, not the project, so the bare name is what matches
    // anything we found on disk.
    const name = raw.includes(":") ? raw.slice(raw.indexOf(":") + 1) : raw;
    const found = byName.get(name);
    if (found) {
      found.live = true;
      continue;
    }
    byName.set(name, {
      name: raw,
      // Named by the session with no file behind it: built into the CLI, or
      // contributed by a plugin whose files are outside the scanned scopes.
      scope: raw.includes(":") ? "plugin" : "builtin",
      description: "",
      path: "",
      live: true,
    });
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Everything memory costs before a word is typed. */
export const memoryBytes = (): number =>
  catalog.memory.reduce((n, f) => n + f.bytes, 0);

export const skillEntries = (): Entry[] =>
  join(view().meta.skills, catalog.skills);

export const commandEntries = (): Entry[] =>
  join(view().meta.commands, catalog.commands);

/** MCP servers, configured and reported, with the session's status attached. */
export function mcpEntries(): McpInfo[] {
  const live = new Map(view().meta.mcp.map((m) => [m.name, m.status]));
  const out = catalog.mcp.map((m) => ({
    ...m,
    status: live.get(m.name) ?? "",
  }));
  // A server the session reports but no scanned file declares — it came from
  // `--mcp-config`, or a settings file this app does not read. Still real.
  for (const m of view().meta.mcp) {
    if (!out.some((x) => x.name === m.name)) {
      out.push({
        name: m.name,
        transport: "",
        target: "",
        scope: "user",
        path: "",
        status: m.status,
      });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Installed plugins, marked with whether the running session loaded them. */
export function pluginEntries(): PluginInfo[] {
  const live = new Set(view().meta.plugins.map((p) => p.name));
  const out = catalog.plugins.map((p) => ({ ...p, loaded: live.has(p.name) }));
  for (const p of view().meta.plugins) {
    if (!out.some((x) => x.name === p.name)) {
      out.push({
        name: p.name,
        marketplace: "",
        version: p.version,
        scope: "session",
        enabled: true,
        installedAt: 0,
        loaded: true,
      });
    }
  }
  return out;
}
