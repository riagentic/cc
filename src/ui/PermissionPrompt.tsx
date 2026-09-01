/**
 * @module
 * Approval prompts — the moment Claude Code stops and asks.
 *
 * The CLI blocks the whole turn on one of these, so the prompt is the loudest
 * thing on the page while it is up: what is being asked, on what, why approval
 * is needed, and three answers that are all one click away. Nothing here is
 * inferred — every line comes from the request the CLI sent.
 */
import { onMount, useLocal, useRef, type VNode } from "aio/air";
import { session } from "../cell/session.ts";
import type { PermissionRequest } from "../type/claude.ts";
import { highlight } from "../lib/highlight.ts";
import { clock, duration, oneLine } from "../lib/format.ts";
import { useNow } from "./parts.tsx";
import { IconAlert, IconCheck, IconShield, IconX, toolIcon } from "./icons.tsx";

/** Every pending prompt, oldest first — the CLI asked in that order and is
 *  waiting on each one. */
export function PermissionQueue(
  props: { requests: PermissionRequest[] },
): VNode | null {
  if (props.requests.length === 0) return null;
  return (
    <div class="perm__queue">
      {props.requests.map((r) => <PermissionCard key={r.id} request={r} />)}
    </div>
  );
}

function PermissionCard(props: { request: PermissionRequest }): VNode {
  const r = props.request;
  const [showInput, setShowInput] = useLocal(false);
  const [denying, setDenying] = useLocal(false);
  const [reason, setReason] = useLocal("");
  const now = useNow(true, 500);
  const suggestion = r.suggestions[0] ?? null;
  const card = useRef<HTMLElement>(null!);

  // Move focus to the prompt when it appears. A blocked turn that a keyboard
  // user has to Tab across the whole page to reach is a blocked turn.
  //
  // The *card* takes focus, never a button: focusing "Allow once" would arm
  // Enter to approve a tool call, and the one thing an approval dialog must
  // never do is let a stray keystroke say yes.
  onMount(() => card.current?.focus());

  return (
    <section
      ref={card}
      class="perm"
      role="alertdialog"
      tabIndex={-1}
      aria-label={`Approve ${r.tool}`}
    >
      <header class="perm__head">
        <span class="perm__icon">{IconShield({ size: 16 })}</span>
        <span class="perm__title">
          Claude Code needs your approval
        </span>
        <span style={{ flex: 1 }} />
        <span class="perm__wait mono" title={`Asked at ${clock(r.askedAt)}`}>
          waiting {duration(now - r.askedAt)}
        </span>
      </header>

      <div class="perm__body">
        <div class="perm__what">
          <span class="perm__tool">
            {toolIcon(r.tool, 14)} {r.title}
          </span>
          <span class="perm__desc">{oneLine(r.description, 160)}</span>
        </div>

        {r.reason && (
          <div class="perm__why">
            {IconAlert({ size: 13 })} {r.reason}
          </div>
        )}

        <button
          type="button"
          class="btn btn--ghost btn--sm perm__toggle"
          aria-expanded={showInput}
          onClick={() => setShowInput(!showInput)}
        >
          {showInput ? "Hide" : "Show"} exactly what it will run
        </button>
        {showInput && (
          <div class="code">
            {highlight(JSON.stringify(r.input, null, 2), "json").map((t, n) =>
              t.kind === "plain"
                ? t.text
                : <span key={n} class={`tok tok--${t.kind}`}>{t.text}</span>
            )}
          </div>
        )}

        {denying
          ? (
            <div class="perm__deny">
              <input
                type="text"
                class="input"
                placeholder="Tell Claude why (optional) — it reads this as the tool's error"
                aria-label="Reason for denying"
                value={reason}
                onInput={(e) => setReason((e.target as HTMLInputElement).value)}
                // Enter sends the denial, Escape backs out of it — the two
                // things a hand already on this field wants to do next.
                onKeyDown={(e: KeyboardEvent) => {
                  if (e.isComposing || e.keyCode === 229) return;
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void session.denyPermission(r.id, reason);
                  }
                  if (e.key === "Escape") setDenying(false);
                }}
              />
              <div class="perm__actions">
                <button
                  type="button"
                  class="btn btn--sm"
                  onClick={() => setDenying(false)}
                >
                  Back
                </button>
                <button
                  type="button"
                  class="btn btn--danger btn--sm"
                  onClick={() => void session.denyPermission(r.id, reason)}
                >
                  {IconX({ size: 13 })} Deny this call
                </button>
              </div>
            </div>
          )
          : (
            <div class="perm__actions">
              <button
                type="button"
                class="btn btn--sm"
                onClick={() => setDenying(true)}
              >
                {IconX({ size: 13 })} Deny…
              </button>
              <span style={{ flex: 1 }} />
              {suggestion && (
                <button
                  type="button"
                  class="btn btn--sm"
                  title={suggestion.label}
                  onClick={() => void session.allowPermission(r.id, true)}
                >
                  Always allow
                </button>
              )}
              <button
                type="button"
                class="btn btn--primary btn--sm"
                onClick={() => void session.allowPermission(r.id, false)}
              >
                {IconCheck({ size: 14 })} Allow once
              </button>
            </div>
          )}

        {suggestion && !denying && (
          <div class="perm__hint">
            “Always allow” also does this: {suggestion.label.toLowerCase()}.
          </div>
        )}
      </div>
    </section>
  );
}

/** One answered prompt, for the audit trail on the Tasks page. */
export function PermissionRow(props: { request: PermissionRequest }): VNode {
  const r = props.request;
  const tone = r.status === "allowed"
    ? "var(--ok)"
    : r.status === "denied"
    ? "var(--danger)"
    : "var(--ink-dim)";
  return (
    <div class="rowitem" style={{ cursor: "default" }}>
      <span class="rowitem__icon" style={{ color: tone }}>
        {IconShield({ size: 14 })}
      </span>
      <span class="truncate">
        <span class="rowitem__title truncate">
          {r.tool} · {oneLine(r.description, 80)}
        </span>
        <br />
        <span class="rowitem__detail truncate">
          {r.status}
          {r.appliedSuggestion ? ` · ${r.appliedSuggestion}` : ""}
          {r.reason ? ` · ${r.reason}` : ""}
        </span>
      </span>
      <span class="rowitem__meta">
        {clock(r.askedAt)}
        <br />
        {r.decidedAt ? duration(r.decidedAt - r.askedAt) : "—"}
      </span>
    </div>
  );
}
