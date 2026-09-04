/**
 * @module
 * Taking a conversation out of the app: onto the clipboard, or onto disk.
 *
 * Both engines get the same two buttons in the same place, from the same
 * component. The Markdown they produce comes from `lib/transcript.ts`, so a
 * copied conversation and a saved one can never disagree.
 */
import { type VNode } from "aio/air";
import { activeProject } from "../cell/workspace.ts";
import { workspace } from "../cell/workspace.ts";
import { Copy } from "./parts.tsx";
import { showToast } from "./toast.tsx";
import { IconFile } from "./icons.tsx";

/** A file name that sorts by date and says which project it came from. */
const fileName = (title: string): string => {
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
  return `${title || "transcript"}-${stamp}.md`;
};

/**
 * Copy, and Save. `markdown` is produced by the page — it is the page that
 * knows which conversation is on screen — and `empty` disables both rather
 * than letting somebody export a file with nothing in it.
 */
export function ExportActions(
  props: { markdown: () => string; empty: boolean },
): VNode {
  const title = activeProject()?.name ?? "conversation";
  return (
    <span style={{ display: "inline-flex", gap: "6px" }}>
      <Copy text={props.markdown} label="Copy all" />
      <button
        type="button"
        class="btn btn--sm"
        disabled={props.empty}
        title="Write the whole conversation to a Markdown file"
        onClick={async () => {
          const done = await workspace.saveExport(
            fileName(title),
            props.markdown(),
          );
          showToast(
            done.path === null
              ? { text: done.error ?? "Could not save it.", tone: "danger" }
              : {
                text: `Saved to ${done.path}`,
                action: {
                  label: "Open",
                  run: () => void workspace.openPath(done.path as string),
                },
              },
          );
        }}
      >
        {IconFile({ size: 13 })} Save
      </button>
    </span>
  );
}
