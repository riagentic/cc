/**
 * @module
 * Short-lived notices, and the undo that sometimes comes with them.
 *
 * The app already has banners for conditions — a session that will not start,
 * an approval waiting elsewhere — and those belong in the layout, because they
 * stay true until something changes. A toast is the other kind: confirmation
 * that the thing you *just did* happened. It has no place in the layout,
 * because a moment later it is not true any more.
 *
 * Held in a module signal rather than a cell for the same reason the overlay
 * host is: an undo is a *callback*, and a callback cannot live in serialised
 * state. Nothing here needs to survive a reload — a notice about something you
 * did ten seconds ago is not worth restoring.
 */
import { onMount, signal, type VNode } from "aio/air";
import { IconCheck, IconX } from "./icons.tsx";

/** How long a notice stays. Long enough to read a sentence and reach the
 *  button; short enough that it is gone before it is in the way. */
const LIFE_MS = 6_000;

export type Toast = {
  id: number;
  text: string;
  tone: "ok" | "warn" | "danger";
  /** The one thing you might want to do about it. Almost always "Undo". */
  action?: { label: string; run: () => void };
};

const toasts = signal<Toast[]>([]);
let nextId = 1;

/**
 * Say that something happened.
 *
 * Returns the notice's id so a caller can take it away early — usually because
 * the thing it offered to undo has just been undone.
 */
export function showToast(
  t: { text: string; tone?: Toast["tone"]; action?: Toast["action"] },
): number {
  const id = nextId++;
  toasts.set([...toasts.peek(), {
    id,
    text: t.text,
    tone: t.tone ?? "ok",
    action: t.action,
  }]);
  arm(id, LIFE_MS);
  return id;
}

export function dismissToast(id: number): void {
  const c = clocks.get(id);
  if (c?.handle !== undefined) clearTimeout(c.handle);
  clocks.delete(id);
  toasts.set(toasts.peek().filter((t) => t.id !== id));
}

/**
 * Each notice's countdown, paused while the pointer is over it or focus is in
 * it — an Undo must not vanish from under the hand reaching for it.
 *
 * `setTimeout` rather than a scheduled effect: this is a fact about a browser
 * window, not about application state, and it must not exist at all on the
 * server side of a cell. Module-local and written synchronously, for the same
 * reason: a pause has to hold from the very event that asks for it.
 */
type Clock = {
  handle?: ReturnType<typeof setTimeout>;
  left: number;
  since: number;
  /** Why it is paused: "hover", "focus" — both must go before it runs. */
  held: Set<string>;
};
const clocks = new Map<number, Clock>();

/** The least a resumed notice gets: enough to read it again after looking away. */
const RESUME_MIN_MS = 1_500;

function arm(id: number, ms: number): void {
  const held = clocks.get(id)?.held ?? new Set<string>();
  clocks.set(id, {
    handle: setTimeout(() => dismissToast(id), ms),
    left: ms,
    since: Date.now(),
    held,
  });
}

/** Stop the countdown of notice `id` for `why`. */
export function holdToast(id: number, why: string): void {
  const c = clocks.get(id);
  if (!c) return;
  c.held.add(why);
  if (c.handle === undefined) return;
  clearTimeout(c.handle);
  c.handle = undefined;
  c.left = Math.max(0, c.left - (Date.now() - c.since));
}

/** Drop `why`; once nothing holds it, the countdown carries on. */
export function releaseToast(id: number, why: string): void {
  const c = clocks.get(id);
  if (!c || !c.held.delete(why) || c.held.size > 0) return;
  if (c.handle === undefined) arm(id, Math.max(c.left, RESUME_MIN_MS));
}

/** Rendered once, near the root of the app. */
export function ToastHost(): VNode | null {
  // Same reasoning as the overlay host: a notice must not survive the app
  // being torn down and rebuilt between two tests.
  onMount(() => {
    for (const c of clocks.values()) {
      if (c.handle !== undefined) clearTimeout(c.handle);
    }
    clocks.clear();
    toasts.set([]);
  });
  const list = toasts.get();
  if (list.length === 0) return null;
  return (
    <div class="toasts" role="status" aria-live="polite">
      {list.map((t) => (
        <div
          key={t.id}
          class={`toast toast--${t.tone}`}
          onMouseEnter={() => holdToast(t.id, "hover")}
          onMouseLeave={() => releaseToast(t.id, "hover")}
          onFocusIn={() => holdToast(t.id, "focus")}
          onFocusOut={() => releaseToast(t.id, "focus")}
        >
          <span class="toast__icon">
            {t.tone === "ok" ? IconCheck({ size: 14 }) : IconX({ size: 14 })}
          </span>
          <span class="toast__text">{t.text}</span>
          {t.action && (
            <button
              type="button"
              class="btn btn--sm"
              onClick={() => {
                dismissToast(t.id);
                t.action?.run();
              }}
            >
              {t.action.label}
            </button>
          )}
          <button
            type="button"
            class="btn btn--ghost btn--sm btn--icon"
            aria-label="Dismiss"
            title="Dismiss"
            onClick={() => dismissToast(t.id)}
          >
            {IconX({ size: 12 })}
          </button>
        </div>
      ))}
    </div>
  );
}
