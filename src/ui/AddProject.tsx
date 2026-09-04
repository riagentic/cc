/**
 * @module
 * The two pieces both "add a project" surfaces share: the Browse button, and
 * the offer that follows a path which is not there yet.
 *
 * The offer matters more than it looks. A path somebody typed that does not
 * exist is nearly always a project they are *about to start* — and "no such
 * directory", with nothing to press, is the least useful possible answer to
 * that. It is still a decision, though: creating a folder writes to the user's
 * disk, so it happens because they read the path and pressed the button, never
 * as a silent recovery from a typo.
 */
import type { VNode } from "aio/air";
import { workspace } from "../cell/workspace.ts";
import { FolderPicker } from "./FolderPicker.tsx";
import { closeOverlay, showOverlay } from "./overlays.tsx";
import { IconFolderOpen, IconPlus } from "./icons.tsx";
import { showToast } from "./toast.tsx";

/** A button that opens the folder picker and hands back what was chosen. */
export function BrowseButton(
  props: { onPick: (path: string) => void; label?: string; near?: string },
): VNode {
  // The picker is handed to the overlay host rather than rendered here: this
  // button lives inside a panel with a backdrop-filter, and a fixed-position
  // dialog rendered under one is trapped inside it. See `overlays.tsx`.
  const open = () =>
    showOverlay(() => (
      <FolderPicker
        near={props.near ??
          workspace.projects.find((p) => p.id === workspace.activeId)?.path}
        onClose={closeOverlay}
        onPick={props.onPick}
      />
    ));
  return (
    <button
      type="button"
      class="btn btn--sm"
      title="Look through the folders on this machine"
      aria-label="Browse for a folder"
      onClick={open}
    >
      {IconFolderOpen({ size: 13 })}
      {props.label !== "" && <span class="wide">{props.label ?? "Browse"}
      </span>}
    </button>
  );
}

/**
 * "There is no folder there — shall I make it?"
 *
 * Renders only after an add has actually failed that way, and names the
 * resolved path rather than what was typed: `~/code/new` and
 * `/home/you/code/new` are the same folder, and the one that will appear on
 * disk is the second.
 */
export function AbsentOffer(): VNode | null {
  const path = workspace.absentPath;
  if (path === "") return null;
  return (
    <div class="absent">
      <span class="truncate">
        Nothing is at <code class="mono">{path}</code> yet.
      </span>
      <button
        type="button"
        class="btn btn--sm btn--primary"
        onClick={async () => {
          // The return value, not `workspace.error`: on a browser client the
          // patch for this call may not have arrived, so reading the cell here
          // reads the answer to the *previous* question.
          const why = await workspace.createProject(path);
          showToast(
            why === null
              ? { text: `Created ${path} and opened it.` }
              : { text: why, tone: "danger" },
          );
        }}
      >
        {IconPlus({ size: 13 })} Create it
      </button>
      <button
        type="button"
        class="btn btn--sm btn--ghost"
        onClick={() => workspace.forgetAbsent()}
      >
        Not that
      </button>
    </div>
  );
}
