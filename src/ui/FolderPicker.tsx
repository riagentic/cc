/**
 * @module
 * Choosing a folder, without leaving the app.
 *
 * The list is directories only, repositories are marked, and typing filters —
 * which is the whole argument for building this rather than reaching for a
 * native dialog. Somebody adding their fourteenth project knows the folder is
 * called "gateway"; they should type five letters, not click through three
 * levels.
 *
 * Every path it hands back is absolute and already resolved by the server, so
 * a caller never has to think about `~` or about where the app was started.
 */
import { onMount, useLocal, useRef, type VNode } from "aio/air";
import { browse, crumbs, parentOf, visibleEntries } from "../cell/browse.ts";
import { Banner, matches, Overlay, Toggle } from "./parts.tsx";
import {
  IconBranch,
  IconChevron,
  IconFolder,
  IconFolderOpen,
  IconPlus,
  IconSearch,
} from "./icons.tsx";

export function FolderPicker(
  props: {
    /** Where to start looking — usually the project on screen. */
    near?: string;
    /** What the caller does with the chosen folder. */
    onPick: (path: string) => void;
    onClose: () => void;
  },
): VNode {
  const [query, setQuery] = useLocal("");
  const [sel, setSel] = useLocal(0);
  const [making, setMaking] = useLocal(false);
  const input = useRef<HTMLInputElement>(null!);
  const newName = useRef<HTMLInputElement>(null!);

  onMount(() => {
    void browse.openNear(props.near ?? "");
    input.current?.focus();
  });

  const all = visibleEntries();
  const hits = query.trim() === ""
    ? all
    : all.filter((e) => matches(query, e.name));
  const index = Math.min(sel, Math.max(0, hits.length - 1));
  const up = parentOf(browse.cwd);

  const enter = (path: string) => {
    setQuery("");
    setSel(0);
    void browse.go(path);
  };

  const pick = (path: string) => {
    props.onClose();
    props.onPick(path);
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSel(Math.min(index + 1, hits.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSel(Math.max(index - 1, 0));
    } else if (e.key === "ArrowLeft" && query === "" && up !== null) {
      // Left is "up a level" only from an empty filter — otherwise it is the
      // caret moving through what somebody is typing.
      e.preventDefault();
      enter(up);
    } else if (e.key === "Enter") {
      e.preventDefault();
      // Enter walks in; Ctrl+Enter chooses. Walking in is what the key does a
      // dozen times per pick, so it gets the unmodified press.
      const target = hits[index];
      if (e.ctrlKey || e.metaKey || !target) pick(browse.cwd);
      else enter(target.path);
    }
  };

  return (
    <Overlay onClose={props.onClose} label="Choose a folder">
      <div class="pal pick">
        <div class="pick__crumbs">
          <button
            type="button"
            class="btn btn--sm btn--ghost btn--icon"
            title="Up one level"
            aria-label="Up one level"
            disabled={up === null}
            onClick={() => up !== null && enter(up)}
          >
            <span style={{ transform: "rotate(-90deg)", display: "flex" }}>
              {IconChevron({ size: 13 })}
            </span>
          </button>
          <div class="pick__trail">
            {crumbs(browse.cwd).map((c) => (
              <button
                key={c.path}
                type="button"
                class="pick__crumb"
                onClick={() => enter(c.path)}
              >
                {c.name}
              </button>
            ))}
          </div>
        </div>

        <div class="pal__search">
          <span class="pal__icon">{IconSearch({ size: 15 })}</span>
          <input
            ref={input}
            class="pal__input"
            type="text"
            value={query}
            placeholder="Filter folders — Enter to open, Ctrl+Enter to choose"
            aria-label="Filter folders"
            autoComplete="off"
            spellcheck={false}
            onInput={(e) => {
              setQuery((e.target as HTMLInputElement).value);
              setSel(0);
            }}
            onKeyDown={onKey}
          />
        </div>

        {
          /* One array, nulls filtered out, rather than a run of `cond &&`
            expressions beside a keyed list. A falsy conditional still renders
            a child — an unkeyed one — and a list with some keyed children and
            some not reconciles the unkeyed ones by position. That is how a
            banner ends up wearing a folder row. */
        }
        <div class="pal__list" role="listbox">
          {[
            browse.error
              ? <Banner key="error" tone="warn">{browse.error}</Banner>
              : null,
            hits.length === 0 && !browse.loading
              ? (
                <div class="pal__none" key="none">
                  {browse.entries.length === 0
                    ? "No folders in here. You can still choose it."
                    : `Nothing here matches ${query}.`}
                </div>
              )
              : null,
            ...hits.map((e, i) => (
              <div
                key={e.path}
                role="option"
                aria-selected={i === index}
                class={"pick__row" + (i === index ? " selected" : "")}
                onMouseEnter={() => setSel(i)}
              >
                <button
                  type="button"
                  class="pick__open"
                  title={`Open ${e.name}`}
                  onClick={() => enter(e.path)}
                >
                  <span class="pal__rowicon">
                    {e.git
                      ? IconBranch({ size: 14 })
                      : IconFolder({ size: 14 })}
                  </span>
                  <span class="truncate">
                    <span class="pal__label">{e.name}</span>
                    {e.git && <span class="pal__hint">git repository</span>}
                  </span>
                </button>
                <button
                  type="button"
                  class="btn btn--sm pick__choose"
                  title={`Choose ${e.name}`}
                  onClick={() => pick(e.path)}
                >
                  Choose
                </button>
              </div>
            )),
          ].filter(Boolean)}
        </div>

        {making
          ? (
            <div class="pick__foot">
              <input
                ref={newName}
                class="input"
                placeholder="new-folder-name"
                aria-label="New folder name"
                autoFocus
                onKeyDown={(e: KeyboardEvent) => {
                  if (e.key === "Escape") setMaking(false);
                  if (e.key !== "Enter") return;
                  const name = newName.current?.value.trim() ?? "";
                  if (name === "") return;
                  setMaking(false);
                  pick(browse.cwd.replace(/\/+$/, "") + "/" + name);
                }}
              />
              <button
                type="button"
                class="btn btn--sm btn--ghost"
                onClick={() => setMaking(false)}
              >
                Cancel
              </button>
            </div>
          )
          : (
            <div class="pick__foot">
              <Toggle
                label="Show hidden folders"
                checked={browse.hidden}
                onChange={() => void browse.toggleHidden()}
              />
              <button
                type="button"
                class="btn btn--sm"
                title="Make a new folder inside this one and use it"
                onClick={() => setMaking(true)}
              >
                {IconPlus({ size: 13 })} New
              </button>
              <button
                type="button"
                class="btn btn--sm btn--primary"
                onClick={() => pick(browse.cwd)}
              >
                {IconFolderOpen({ size: 13 })} Use this folder
              </button>
            </div>
          )}
      </div>
    </Overlay>
  );
}
