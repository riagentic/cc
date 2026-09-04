/**
 * @module
 * The pieces of the status strip that both engines share.
 *
 * The two conversations are different in almost every way that matters, and
 * their strips used to show it: the Claude strip led with the project, the
 * local one led with the engine, and the same four facts appeared in two
 * orders with two shapes. Switching a project from Claude Code to llama.cpp
 * moved every control on the row.
 *
 * So the shared facts — which project, which branch, which engine, which
 * model, how full the window is — are built here and placed in the same order
 * on both sides. What is genuinely engine-specific comes after them.
 */
import type { VNode } from "aio/air";
import { activeProject, workspace } from "../cell/workspace.ts";
import { detectedEngines, local, localConfig } from "../cell/local.ts";
import { pct, tildePath, tokens } from "../lib/format.ts";
import { Menu, Meter, Stat } from "./parts.tsx";
import { IconBranch, IconFolder, IconPlug } from "./icons.tsx";

/** Engines a project can run on, named the way Settings names them. */
export const ENGINE_OPTIONS = [
  { id: "claude", label: "Claude Code", hint: "The CLI, with every feature" },
  { id: "lmstudio", label: "LM Studio", hint: "Local · OpenAI-compatible" },
  { id: "ollama", label: "Ollama", hint: "Local · OpenAI-compatible" },
  { id: "llamacpp", label: "llama.cpp", hint: "Local · OpenAI-compatible" },
] as const;

/**
 * Which project — and a way to change it.
 *
 * The dock is where you pick a project deliberately; this is where you notice
 * you are in the wrong one, and it would be perverse to make you travel to fix
 * what you just read here.
 *
 * `note` is whatever the engine wants to add about *its* idea of where it is
 * running — the Claude session keeps the directory it was spawned in, and a
 * local engine has no such notion.
 */
export function ProjectStat(props: { note?: unknown }): VNode {
  const project = activeProject();
  return (
    <Stat label="Project" clamp title={project?.path}>
      {IconFolder({ size: 14 })}
      <Menu
        label="Project"
        value={project?.id ?? ""}
        title={project ? project.path : "Pick a project"}
        trigger={
          <span class="truncate">
            {project ? tildePath(project.path, workspace.home) : "None"}
          </span>
        }
        options={workspace.projects.map((p) => ({
          id: p.id,
          label: p.name,
          hint: p.missing
            ? "Folder is gone"
            : p.branch ?? tildePath(p.path, workspace.home),
          tone: p.missing ? ("danger" as const) : undefined,
        }))}
        onChange={(id) => workspace.select(id)}
      />
      {props.note as VNode}
    </Stat>
  );
}

/** Which branch, and whether the tree is dirty. A fact about the folder, so it
 *  reads the same whatever is running in it. */
export function BranchStat(): VNode {
  const project = activeProject();
  return (
    <Stat
      label="Branch"
      title={project?.dirty ? "Uncommitted changes" : undefined}
    >
      {IconBranch({ size: 14 })}
      <span class="truncate">{project?.branch ?? "—"}</span>
      {project?.dirty && (
        <span class="pill pill--warn" style={{ padding: "1px 7px" }}>
          dirty
        </span>
      )}
    </Stat>
  );
}

/**
 * What runs this project.
 *
 * The list looks for local servers the moment it is opened: the answer is only
 * interesting to somebody about to choose, and it would be stale by the time
 * it was useful if it had been gathered at boot.
 */
export function EngineStat(): VNode {
  const target = activeProject()?.id ?? workspace.activeId;
  return (
    <Stat label="Engine">
      {IconPlug({ size: 14 })}
      <Menu
        label="Engine"
        value={localConfig(target).engine}
        title="What runs this project"
        onOpen={() => void local.detect()}
        options={ENGINE_OPTIONS.map((e) => ({
          id: e.id,
          label: e.label,
          hint: e.id === "claude"
            ? e.hint
            : detectedEngines().find((d) => d.engine === e.id)?.reachable
            ? "Running now"
            : local.detecting
            ? "Looking…"
            : e.hint,
          trailing: e.id !== "claude" &&
              detectedEngines().find((d) => d.engine === e.id)?.reachable
            ? <span class="dot dot--ready" />
            : null,
        }))}
        // Chained, not fired side by side: a dispatch that has not committed is
        // invisible to the next one, so a parallel `syncEngine` can read the
        // engine the project was on a moment ago and refresh nothing.
        onChange={(engine) => {
          void local.setEngine(target, engine).then(() =>
            engine === "claude" ? undefined : local.syncEngine(target)
          );
        }}
      />
    </Stat>
  );
}

/**
 * How full the context window is.
 *
 * One shape for both engines, because it answers one question — how much room
 * is left before something has to be dropped — and the answer should not look
 * different depending on who is counting. `measured` says whether the number
 * is a report or an estimate, which is the only honest difference between
 * them.
 */
export function ContextStat(
  props: { used: number; max: number; measured: boolean; title?: string },
): VNode {
  const p = pct(props.used, props.max);
  return (
    <Stat
      label={props.measured ? "Context" : "Context (est.)"}
      grow
      numeric
      title={props.title ??
        (props.measured
          ? "Tokens resident in the context window after the last request"
          : "Window size is the model default until the first turn reports it")}
    >
      <div style={{ width: "100%", display: "grid", gap: "3px" }}>
        <div style={{ display: "flex", gap: "8px", alignItems: "baseline" }}>
          <span>{tokens(props.used)}</span>
          <span style={{ color: "var(--ink-dim)" }}>
            / {tokens(props.max)}
          </span>
          <span style={{ flex: 1 }} />
          <span style={{ color: "var(--ink-dim)" }}>
            {p.toFixed(p < 10 ? 1 : 0)}%
          </span>
        </div>
        <Meter
          value={props.used}
          max={props.max}
          label="Context window used"
        />
      </div>
    </Stat>
  );
}
