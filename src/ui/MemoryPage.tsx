/**
 * @module
 * Memory — how much Claude Code is carrying into every request before you have
 * typed a word, measured file by file on disk.
 *
 * Three scopes, because they behave differently: **user** memory applies to
 * every project, **project** memory to this one, and **session** memory is what
 * the agent has written down for itself.
 *
 * Measured from the project's files, not from a running process — selecting a
 * project is enough to see what it carries. Only the *session* scope needs a
 * session, because only a running CLI knows where it keeps its own notes.
 */
import type { VNode } from "aio/air";
import { catalog, memoryBytes } from "../cell/catalog.ts";
import { view } from "../cell/session.ts";
import type { MemoryFile } from "../type/claude.ts";
import { ago, bytes, pct, tokens } from "../lib/format.ts";
import { Empty, Meter, Panel, Pill, useNow } from "./parts.tsx";
import { PageHead } from "./RunViews.tsx";
import { IconFile, IconMemory, IconRefresh } from "./icons.tsx";

const SCOPES: { id: MemoryFile["scope"]; label: string; hint: string }[] = [
  {
    id: "user",
    label: "User",
    hint: "Applies to every project on this machine",
  },
  { id: "project", label: "Project", hint: "Committed with this repository" },
  { id: "session", label: "Session", hint: "Written by the agent for itself" },
];

export function MemoryPage(): VNode {
  const total = memoryBytes();
  const files = catalog.memory;
  // The files are the project's; the window they are measured against, and the
  // session memory directories below, are the running session's. This page is
  // the one honest place those two meet.
  const sess = view();
  const window = sess.usage.contextWindow;
  const largest = files[0]?.bytes ?? 0;
  // Slow, but ticking: with `false` the "scanned 12s ago" line froze at whatever
  // it said when some other state last re-rendered the page, which on an idle
  // session is for as long as the page stays open.
  const now = useNow(true, 10_000);

  return (
    <div class="page">
      <PageHead
        scope="project"
        title="Memory"
        sub={files.length > 0
          ? `${bytes(total)} across ${files.length} files${
            catalog.memoryScannedAt
              ? ` · scanned ${ago(catalog.memoryScannedAt, now)}`
              : ""
          }`
          : "Not scanned yet"}
        actions={
          <button
            type="button"
            class="btn btn--sm"
            onClick={() => catalog.refreshMemory()}
          >
            {IconRefresh({ size: 13 })} Rescan
          </button>
        }
      />

      <div class="page__body grid">
        {files.length === 0
          ? (
            <Panel>
              <Empty
                icon={IconMemory({ size: 20 })}
                title="No memory measured"
                hint="Start a session — the CLI reports where its memory lives, and this page measures that plus every CLAUDE.md that applies."
              >
                <button
                  type="button"
                  class="btn btn--sm"
                  onClick={() => catalog.refreshMemory()}
                >
                  Scan now
                </button>
              </Empty>
            </Panel>
          )
          : (
            <>
              <Panel title="Total loaded">
                <div
                  style={{
                    display: "flex",
                    alignItems: "baseline",
                    gap: "10px",
                    marginBottom: "8px",
                  }}
                >
                  <span
                    style={{
                      fontSize: "26px",
                      fontWeight: 640,
                      letterSpacing: "-.02em",
                    }}
                  >
                    {bytes(total)}
                  </span>
                  <span class="page__sub">
                    ≈ {Math.round(total / 4).toLocaleString()} tokens ·{" "}
                    {pct(total / 4, window).toFixed(1)}% of the {tokens(window)}
                    {" "}
                    window
                  </span>
                </div>
                <Meter value={total / 4} max={window} />
                <div class="field__hint" style={{ marginTop: "6px" }}>
                  Token count is an estimate (≈4 bytes per token) — the CLI
                  reports exact usage only once a turn completes.
                </div>
              </Panel>

              {SCOPES.map((scope) => {
                const rows = files.filter((f) => f.scope === scope.id);
                if (rows.length === 0) return null;
                const sum = rows.reduce((n, f) => n + f.bytes, 0);
                return (
                  <Panel
                    key={scope.id}
                    flush
                    title={
                      <span
                        style={{
                          display: "inline-flex",
                          gap: "8px",
                          alignItems: "center",
                        }}
                      >
                        {scope.label}
                        <Pill>{bytes(sum)}</Pill>
                      </span>
                    }
                    actions={<span class="page__sub">{scope.hint}</span>}
                  >
                    <div class="rowlist">
                      {rows.map((f) => (
                        <div key={f.path} class="rowitem">
                          <span class="rowitem__icon">
                            {IconFile({ size: 14 })}
                          </span>
                          <span class="truncate">
                            <span class="rowitem__title truncate">
                              {f.label}
                            </span>
                            <div
                              style={{ marginTop: "5px", maxWidth: "420px" }}
                            >
                              <Meter
                                value={f.bytes}
                                max={largest}
                                tone="flat"
                              />
                            </div>
                          </span>
                          <span class="rowitem__meta">
                            {bytes(f.bytes)}
                            <br />
                            {f.modifiedAt ? ago(f.modifiedAt, now) : ""}
                          </span>
                        </div>
                      ))}
                    </div>
                  </Panel>
                );
              })}
            </>
          )}

        {sess.meta.memoryPaths.length > 0 && (
          <Panel title="Memory directories reported by the CLI">
            <div class="tags">
              {sess.meta.memoryPaths.map((p) => (
                <span key={p} class="tag">{p}</span>
              ))}
            </div>
          </Panel>
        )}
      </div>
    </div>
  );
}
