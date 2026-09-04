/**
 * @module
 * Storage — the answer to "why is `~/.claude` this big", and the only place
 * that offers to make it smaller.
 *
 * Ordered by what a reader actually needs: the total, then where it went, then
 * the small part that is reclaimable. That order is deliberate — the honest
 * finding on the machine this was built against was that stale data is ~1.5% of
 * the total and *nothing* is orphaned, so a page that led with a Clean button
 * would have implied a problem it cannot solve. The bulk is the record of real,
 * recent work, and the useful thing to show about it is simply which projects
 * it belongs to.
 */
import { useLocal, type VNode } from "aio/air";
import { stale, staleBytes, storage } from "../cell/storage.ts";
import { workspace } from "../cell/workspace.ts";
import type { StoredProject } from "../cell/storage.server.ts";
import { ago, bytes, listKey, pct, tildePath } from "../lib/format.ts";
import {
  Banner,
  Empty,
  matches,
  Meter,
  Panel,
  Pill,
  Search,
  useNow,
} from "./parts.tsx";
import { PageHead } from "./RunViews.tsx";
import { IconFolder, IconRefresh, IconTrash } from "./icons.tsx";

function ProjectRow(props: { p: StoredProject; now: number }): VNode {
  const p = props.p;
  const busy = storage.busyDir === p.dir;
  return (
    <div class="rowitem">
      <span class="rowitem__icon">{IconFolder({ size: 15 })}</span>
      <span class="truncate">
        <span class="rowitem__title truncate">
          {p.path ? tildePath(p.path, workspace.home) : p.dir.split("/").pop()}
        </span>
        <br />
        <span class="rowitem__detail">
          {p.sessions} session{p.sessions === 1 ? "" : "s"}
          {p.usedAt > 0 && ` · last used ${ago(p.usedAt, props.now)}`}
        </span>
      </span>
      <span
        class="rowitem__meta"
        style={{ display: "flex", gap: "6px", alignItems: "center" }}
      >
        <span>{bytes(p.bytes)}</span>
        {p.exists === false
          ? (
            <>
              <Pill tone="warn">folder gone</Pill>
              <button
                type="button"
                class="btn btn--ghost btn--sm btn--icon"
                disabled={busy}
                title={`Delete this history — ${
                  bytes(p.bytes)
                }. The folder it belonged to no longer exists.`}
                // Stable handle: the aria-label carries the path, which a test
                // cannot know ahead of time.
                data-testid="DeleteHistory"
                aria-label={`Delete history for ${p.path}`}
                onClick={() => storage.remove(p.dir, p.path)}
              >
                {IconTrash({ size: 14 })}
              </button>
            </>
          )
          // Not "gone": no transcript in it says which folder it came from, and
          // the directory's own name cannot be decoded back to a path. Shown,
          // never offered for deletion.
          : p.exists === null
          ? <Pill>unknown</Pill>
          : null}
      </span>
    </div>
  );
}

export function StoragePage(): VNode {
  const now = useNow(true, 30_000);
  const [query, setQuery] = useLocal("");
  const [all, setAll] = useLocal(false);
  const scanned = storage.scannedAt > 0;
  const gone = stale();
  const reclaim = staleBytes();
  // Filtered first, capped second — a cap applied before the filter would hide
  // the very row somebody typed a path to find.
  const matching = storage.projects.filter((p) =>
    matches(query, p.path, p.dir)
  );
  const CAP = 20;
  const shown = all || query.trim() !== "" ? matching : matching.slice(0, CAP);
  const hidden = matching.length - shown.length;

  return (
    <div class="page">
      <PageHead
        title="Storage"
        scope="machine"
        sub={scanned
          ? `${
            bytes(storage.totalBytes)
          } across ${storage.projects.length} projects · scanned ${
            ago(storage.scannedAt, now)
          }`
          : "Not scanned yet"}
        actions={
          <>
            {scanned && (
              <Search
                value={query}
                onChange={setQuery}
                label="Filter stored projects"
                placeholder="Filter by path…"
              />
            )}
            <button
              type="button"
              class="btn btn--sm"
              disabled={storage.loading}
              onClick={() => storage.refresh()}
            >
              {IconRefresh({ size: 13 })}
              {storage.loading ? "Scanning…" : scanned ? "Rescan" : "Scan"}
            </button>
          </>
        }
      />
      <div class="page__body grid">
        {storage.error && <Banner tone="warn">{storage.error}</Banner>}

        {!scanned
          ? (
            <Panel>
              <Empty
                icon={IconFolder({ size: 20 })}
                title="Nothing measured yet"
                hint="Scanning walks every transcript Claude Code has written on this machine, so it runs when you ask rather than on a timer."
              />
            </Panel>
          )
          : (
            <>
              {
                /* Reclaimable first only when there IS any — otherwise the page
                  would open on a Clean button with nothing to clean, which
                  reads as a problem where there is none. */
              }
              {gone.length > 0
                ? (
                  <Panel
                    title={`Reclaimable · ${bytes(reclaim)}`}
                    actions={
                      <Pill tone="warn">
                        {pct(reclaim, storage.totalBytes).toFixed(1)}% of the
                        total
                      </Pill>
                    }
                  >
                    <div class="field__hint" style={{ marginBottom: "10px" }}>
                      History for {gone.length}{" "}
                      folder{gone.length === 1 ? "" : "s"}{" "}
                      that no longer exist. Deleting it removes those
                      conversations for good — an unmounted drive looks the same
                      as a deleted folder from here, so nothing is removed
                      automatically.
                    </div>
                    <div class="rowlist">
                      {gone.map((p) => (
                        <ProjectRow key={listKey(p.dir)} p={p} now={now} />
                      ))}
                    </div>
                  </Panel>
                )
                : (
                  <Banner>
                    Nothing stale. Every project with history on this machine
                    still exists on disk.
                  </Banner>
                )}

              <Panel
                title={query.trim()
                  ? `Where it went · ${matching.length} of ${storage.projects.length}`
                  : "Where it went"}
              >
                <Meter
                  label="Largest project's share of the total"
                  value={storage.projects[0]?.bytes ?? 0}
                  max={storage.totalBytes || 1}
                />
                <div class="field__hint" style={{ margin: "6px 0 12px" }}>
                  The bar is the largest single project. History is the record
                  of work, not a cache — the way to shrink it is to need less of
                  it, not to sweep it.
                </div>
                <div class="rowlist">
                  {shown.map((p) => (
                    <ProjectRow key={listKey(p.dir)} p={p} now={now} />
                  ))}
                </div>
                {
                  /* The cap used to be silent. On a machine with forty
                    projects that meant twenty of them — and any stale history
                    among them — simply did not exist on this page. */
                }
                {hidden > 0 && (
                  <button
                    type="button"
                    class="btn btn--ghost btn--sm"
                    style={{ marginTop: "10px" }}
                    onClick={() => setAll(true)}
                  >
                    Show {hidden} more
                  </button>
                )}
                {shown.length === 0 && (
                  <div class="field__hint">
                    No stored project matches that filter.
                  </div>
                )}
              </Panel>

              {storage.extras.length > 0 && (
                <Panel title="Other Claude Code state">
                  <div class="kv">
                    {storage.extras.map((e) => (
                      <>
                        <span key={`k${e.name}`} class="kv__k mono">
                          {e.name}
                        </span>
                        <span key={`v${e.name}`} class="kv__v">
                          {bytes(e.bytes)}
                        </span>
                      </>
                    ))}
                  </div>
                </Panel>
              )}
            </>
          )}
      </div>
    </div>
  );
}
