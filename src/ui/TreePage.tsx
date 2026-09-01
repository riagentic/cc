/**
 * @module
 * Tree — the project's files, with the session's own footprint drawn over them.
 *
 * A file browser is the least interesting thing this app could show; every
 * editor has one. What earns it a tab is the overlay: every file the running
 * session has **read** or **written** is marked, live, from the tool calls it
 * actually made. "What has it touched in my repo" is the first question anybody
 * asks of an agent, and the only other way to answer it is to scroll the whole
 * transcript.
 */
import { type VNode } from "aio/air";
import { touchedPaths, tree } from "../cell/tree.ts";
import { activeProject, workspace } from "../cell/workspace.ts";
import type { Touch, TreeNode } from "../type/claude.ts";
import { bytes, tildePath } from "../lib/format.ts";
import { highlight } from "../lib/highlight.ts";
import { Banner, Empty, Panel, Pill } from "./parts.tsx";
import { PageHead } from "./RunViews.tsx";
import {
  IconEye,
  IconFile,
  IconFolder,
  IconFolderOpen,
  IconPencil,
  IconRefresh,
  IconTree,
} from "./icons.tsx";

/** The fence language for a file, from its extension. The highlighter answers
 *  "I have no dialect for this" by rendering plain, so an unknown extension
 *  costs nothing and a wrong guess would cost colour on the wrong tokens. */
const LANGS: Record<string, string> = {
  ts: "ts",
  tsx: "ts",
  js: "js",
  jsx: "js",
  mjs: "js",
  json: "json",
  jsonc: "json",
  md: "md",
  css: "css",
  html: "html",
  sh: "bash",
  bash: "bash",
  py: "python",
  rs: "rust",
  go: "go",
  toml: "toml",
  yml: "yaml",
  yaml: "yaml",
};

const langOf = (name: string): string => {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? LANGS[name.slice(dot + 1).toLowerCase()] ?? "" : "";
};

/**
 * A list key for a node.
 *
 * The path itself would be the obvious key — it is already the identity — but
 * the semantic surface addresses a keyed row as `Component[key]` within a path
 * whose segments are joined by `/`, so a key that contains `/` produces an
 * address nothing can parse back: `TreeRow[/home/dev/x/src]:SrcButton` is
 * ambiguous by construction. That makes every row unaddressable from `am
 * trigger` and from a UI test. Separators out, identity intact — `\u00b7` cannot
 * appear in a POSIX path segment, so the key stays unique.
 */
const rowKey = (path: string): string => path.replaceAll("/", "\u00b7");

function TreeRow(
  props: { node: TreeNode; touch: Touch | undefined; selected: boolean },
): VNode {
  const n = props.node;
  const touchClass = props.touch ? ` treerow--${props.touch}` : "";

  return (
    <button
      type="button"
      class={`treerow${n.dir ? " treerow--dir" : ""}${touchClass}${
        props.selected ? " selected" : ""
      }`}
      // The indent is padding on the row, not a spacer element: one node is one
      // element, which is what keeps a four-thousand-row tree cheap.
      style={{ paddingLeft: `${10 + n.depth * 13}px` }}
      title={n.path}
      aria-label={n.name}
      aria-expanded={n.dir ? n.open : undefined}
      onClick={() => n.dir ? tree.toggle(n.path) : tree.select(n.path)}
    >
      <span class="treerow__icon">
        {n.dir
          ? (n.open ? IconFolderOpen({ size: 13 }) : IconFolder({ size: 13 }))
          : IconFile({ size: 13 })}
      </span>
      <span class="treerow__name">{n.name}</span>
      <span class="treerow__touch">
        {props.touch === "written"
          ? (
            <span title="This session wrote this file">
              {IconPencil({ size: 11 })}
            </span>
          )
          : props.touch === "read"
          ? (
            <span title="This session read this file">
              {IconEye({ size: 11 })}
            </span>
          )
          : n.dir
          ? null
          : (
            <span class="treerow__size">
              {n.bytes === null ? "" : bytes(n.bytes)}
            </span>
          )}
      </span>
    </button>
  );
}

/** The preview pane. Syntax-highlit through the same tokeniser the chat's code
 *  blocks use, so a file reads the same here as when the model quotes it. */
function FilePane(): VNode {
  const path = tree.selected;
  const p = tree.preview;

  if (!path) {
    return (
      <Empty
        icon={IconTree({ size: 20 })}
        title="Pick a file"
        hint="Files this session has read are tinted; ones it has written are marked with a pencil."
      />
    );
  }
  if (p.error) {
    return (
      <Empty
        icon={IconFile({ size: 20 })}
        title={p.error}
        hint={`${path} · ${bytes(p.bytes)}`}
      />
    );
  }

  const name = path.slice(path.lastIndexOf("/") + 1);
  const tokens = highlight(p.text, langOf(name));

  return (
    <div style={{ display: "grid", gap: "10px", minWidth: 0 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "8px",
          flexWrap: "wrap",
        }}
      >
        <strong style={{ fontSize: "13px" }}>{name}</strong>
        <code
          class="mono"
          style={{ color: "var(--ink-dim)", fontSize: "11.5px" }}
        >
          {tildePath(path, workspace.home)}
        </code>
        <span style={{ flex: 1 }} />
        <Pill>{bytes(p.bytes)}</Pill>
        {p.truncated && <Pill tone="warn">truncated</Pill>}
      </div>
      <pre class="codeview">
        <code>
          {tokens.map((t, i) => (
            <span key={i} class={t.kind === "plain" ? undefined : `tok--${t.kind}`}>
              {t.text}
            </span>
          ))}
        </code>
      </pre>
    </div>
  );
}

export function TreePage(): VNode {
  const project = activeProject();
  const touched = touchedPaths();
  const nodes = tree.nodes;

  // Counted over the whole session, not over the rows on screen: a file the
  // session wrote inside a folder nobody has expanded still counts, and a
  // figure that changed when you opened a folder would be meaningless.
  const written = [...touched.values()].filter((t) => t === "written").length;
  const read = touched.size - written;

  if (!project) {
    return (
      <div class="page">
        <PageHead title="Tree" scope="project" />
        <div class="page__body">
          <Panel>
            <Empty
              icon={IconTree({ size: 20 })}
              title="No project selected"
              hint="Pick one from the dock on the left, and its files appear here."
            />
          </Panel>
        </div>
      </div>
    );
  }

  return (
    <div class="page">
      <PageHead
        scope="project"
        title="Tree"
        sub={`${tildePath(project.path, workspace.home)}${
          touched.size > 0
            ? ` · ${written} written · ${read} read this session`
            : ""
        }`}
        actions={
          <button
            type="button"
            class="btn btn--ghost btn--sm btn--icon"
            title="Re-read the tree from disk"
            aria-label="Refresh tree"
            onClick={() => tree.refresh()}
          >
            {IconRefresh({ size: 15 })}
          </button>
        }
      />
      {tree.error && (
        <div style={{ padding: "0 22px 10px" }}>
          <Banner tone="warn">{tree.error}</Banner>
        </div>
      )}
      <div class="treesplit">
        <div class="treepane">
          {nodes.length === 0
            ? (
              <Empty
                icon={IconTree({ size: 20 })}
                title={tree.loading ? "Reading…" : "Nothing to show"}
                hint={tree.loading
                  ? undefined
                  : "This directory is empty, or everything in it is filtered out."}
              />
            )
            : nodes.map((n) => (
              <TreeRow
                key={rowKey(n.path)}
                node={n}
                touch={touched.get(n.path)}
                selected={tree.selected === n.path}
              />
            ))}
        </div>
        <div class="filepane">
          <FilePane />
        </div>
      </div>
    </div>
  );
}
