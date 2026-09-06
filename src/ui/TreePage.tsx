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
import { useLocal, type VNode } from "aio/air";
import { gitMark, touchedPaths, tree } from "../cell/tree.ts";
import { activeProject, workspace } from "../cell/workspace.ts";
import type { Touch, TreeNode } from "../type/claude.ts";
import { bytes, listKey, tildePath } from "../lib/format.ts";
import { highlight, langOfFile } from "../lib/highlight.ts";
import {
  Banner,
  Empty,
  matches,
  Panel,
  PathActions,
  Pill,
  Search,
  Segmented,
} from "./parts.tsx";
import { PageHead } from "./RunViews.tsx";
import { DiffView } from "./Diff.tsx";
import {
  IconEye,
  IconFile,
  IconFolder,
  IconFolderOpen,
  IconPencil,
  IconRefresh,
  IconTree,
} from "./icons.tsx";

/** A list key for a node — see {@link listKey}: a `/` in a key makes the row
 *  unaddressable from `am trigger` and from every UI test. */
const rowKey = listKey;

function TreeRow(
  props: { node: TreeNode; touch: Touch | undefined; selected: boolean },
): VNode {
  const n = props.node;
  const touchClass = props.touch ? ` treerow--${props.touch}` : "";

  // Asked for EVERY row, and used only for files.
  //
  // Directories are not marked — git reports files, and a folder wearing an
  // "M" would be a claim about everything inside it — but skipping the call
  // for them meant a directory row's body read no cell state at all, and a
  // component that reads nothing subscribes to nothing. The renderer says so
  // out loud: "this instance will never re-render". It happened to look right
  // because the parent re-renders and hands down fresh props; that is a
  // coincidence of the current shape, not a guarantee, and it is one refactor
  // away from a folder that never redraws.
  const mark = gitMark(n.path);

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
      {
        /* What git thinks, next to what the session did. They answer different
          questions — "is this yours to review" and "did the agent touch it" —
          and a file can easily be one and not the other. */
      }
      {
        /* A non-breaking space rather than "": an empty text child renders to
          no node at all, which changes this span's child count and desyncs the
          reconciler. The column is fixed-width, so the space is what was being
          drawn here anyway. */
      }
      <span
        class={"treerow__git" +
          (mark && !n.dir ? ` treerow__git--${mark}` : "")}
      >
        {n.dir
          ? "\u00a0"
          : mark === "modified"
          ? "M"
          : mark === "new"
          ? "A"
          : "\u00a0"}
      </span>
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
              {n.bytes === null ? "\u00a0" : bytes(n.bytes)}
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
  // The committed version, when there is one. "Changes" is offered only for a
  // file git considers changed — see the cell, which only fetches it then.
  const head = tree.previewHead;
  const [showDiff, setShowDiff] = useLocal(false);

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
  const tokens = highlight(p.text, langOfFile(name));

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
        {
          /* A preview is for reading; the next thing after reading a file is
            opening it. The pane knew the path and made you retype it. */
        }
        <PathActions path={path} label={name} />
        {
          /* Only for a file git says has changed — for anything else the
            switch would offer a diff with nothing in it. */
        }
        {head !== "" && (
          <Segmented
            value={showDiff ? "diff" : "file"}
            options={[
              { id: "file", label: "File" },
              { id: "diff", label: "Changes" },
            ]}
            onChange={(v) => setShowDiff(v === "diff")}
          />
        )}
      </div>
      {showDiff && head !== ""
        ? <DiffView before={head} after={p.text} />
        : (
          <pre class="codeview">
            <code>
              {tokens.map((t, i) => (
                <span
                  key={i}
                  class={t.kind === "plain" ? undefined : `tok--${t.kind}`}
                >
                  {t.text}
                </span>
              ))}
            </code>
          </pre>
        )}
    </div>
  );
}

/**
 * Every file the session read or wrote, flat, newest tool call first.
 *
 * Deliberately not a tree: these paths are known exactly, from the tool calls
 * themselves, and arranging them into a hierarchy would mean walking
 * directories to find parents that nobody asked to see.
 */
function TouchedList(
  props: { touched: Map<string, Touch>; query: string },
): VNode {
  const rows = [...props.touched.entries()]
    .filter(([path]) => matches(props.query, path))
    .sort((a, b) => a[0].localeCompare(b[0]));

  if (rows.length === 0) {
    return (
      <Empty
        icon={IconTree({ size: 20 })}
        title={props.touched.size === 0
          ? "Nothing touched yet"
          : "Nothing matches"}
        hint={props.touched.size === 0
          ? "Files this session reads or writes appear here as it works, whether or not their folder is open."
          : "Clear the filter to see every file this session has touched."}
      />
    );
  }

  return (
    <>
      {rows.map(([path, touch]) => (
        <button
          key={rowKey(path)}
          type="button"
          class={`treerow treerow--${touch}${
            tree.selected === path ? " selected" : ""
          }`}
          style={{ paddingLeft: "10px" }}
          title={path}
          aria-label={path.slice(path.lastIndexOf("/") + 1)}
          onClick={() => tree.select(path)}
        >
          <span class="treerow__icon">
            {touch === "written" ? IconPencil({ size: 13 }) : IconEye({
              size: 13,
            })}
          </span>
          <span class="treerow__name truncate" title={path}>
            {tildePath(path, workspace.home)}
          </span>
        </button>
      ))}
    </>
  );
}

export function TreePage(): VNode {
  const project = activeProject();
  const touched = touchedPaths();
  const [query, setQuery] = useLocal("");
  const [mode, setMode] = useLocal<"tree" | "touched">("tree");
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

  // Filtering the flat list, which is only ever the open folders. Said out
  // loud in the empty state rather than pretended otherwise: walking the whole
  // repository to answer a keystroke is the cost this panel exists to avoid.
  // A directory is kept whenever it is on the way to a match, so a hit three
  // levels down does not appear parentless.
  const shown = query.trim() === ""
    ? nodes
    : nodes.filter((n) =>
      matches(query, n.name) ||
      (n.dir && nodes.some((m) =>
        !m.dir && m.path.startsWith(n.path + "/") &&
        matches(query, m.name)
      ))
    );

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
          <>
            {
              /* The overlay is the reason this page exists, and until now you
                could only see it by guessing which folders to expand — a file
                the session wrote three directories down was marked, invisibly.
                Touched is that same set, flat, in one click. It needs no walk:
                the paths come from the tool calls themselves. */
            }
            <Segmented
              value={mode}
              options={[
                { id: "tree", label: "Tree" },
                {
                  id: "touched",
                  name: "Touched",
                  label: touched.size > 0
                    ? `Touched · ${touched.size}`
                    : "Touched",
                },
              ]}
              onChange={setMode}
            />
            <Search
              value={query}
              onChange={setQuery}
              label="Filter files"
              placeholder={mode === "touched"
                ? "Filter touched files…"
                : "Filter open folders…"}
            />
            <button
              type="button"
              class="btn btn--ghost btn--sm btn--icon"
              title="Re-read the tree from disk"
              aria-label="Refresh tree"
              onClick={() => tree.refresh()}
            >
              {IconRefresh({ size: 15 })}
            </button>
          </>
        }
      />
      {tree.error && (
        <div style={{ padding: "0 22px 10px" }}>
          <Banner tone="warn">{tree.error}</Banner>
        </div>
      )}
      <div class="treesplit">
        <div class="treepane">
          {mode === "touched"
            ? <TouchedList touched={touched} query={query} />
            : shown.length === 0
            ? (
              <Empty
                icon={IconTree({ size: 20 })}
                title={tree.loading
                  ? "Reading…"
                  : query.trim()
                  ? "Nothing matches"
                  : "Nothing to show"}
                hint={tree.loading
                  ? undefined
                  : query.trim()
                  ? "The filter only sees folders that are open — expand one, or clear it."
                  : "This directory is empty, or everything in it is filtered out."}
              />
            )
            : shown.map((n) => (
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
