/**
 * @module
 * One place where every overlay in the app is rendered.
 *
 * Not a nicety — a correctness fix. `position: fixed` is *contained* by any
 * ancestor with a `backdrop-filter`, and both side panels have one. A picker
 * opened from a button in the 212px project dock therefore rendered inside the
 * dock: a full-screen dialog, 212px wide. Nothing about the dialog was wrong;
 * it was in the wrong branch of the DOM.
 *
 * A portal into `document.body` would also fix it, and would take the overlay
 * outside the mounted root — where `testUI` cannot see it, and where a test can
 * no longer prove the thing a user is looking at. This host is a child of the
 * app root instead: same effect, still inspectable.
 *
 * It holds exactly one overlay. Two stacked dialogs is a state nobody designed
 * and everybody eventually reaches, so opening one closes the other by
 * construction rather than by remembering to.
 */
import { onMount, signal, type VNode } from "aio/air";

/** The overlay to render, wrapped so the setter can never mistake a render
 *  function for an updater function. */
const current = signal<{ render: () => VNode } | null>(null);

/** Put an overlay on screen, replacing whatever was there. */
export const showOverlay = (render: () => VNode): void => {
  current.set({ render });
};

/** Take it away. Safe to call when nothing is open. */
export const closeOverlay = (): void => {
  current.set(null);
};

/** Whether anything is up — for the shortcuts that must not fire behind a
 *  dialog. */
export const overlayOpen = (): boolean => current.get() !== null;

/** Rendered once, near the root of the app. */
export function OverlayHost(): VNode | null {
  // An overlay must not survive the app being torn down and rebuilt — which
  // is exactly what happens between two UI tests sharing this module.
  //
  // `onMount`, not `onCleanup`: cleanup callbacks collected during render run
  // again on every RE-render, so closing there closed the overlay on the very
  // render that opened it. Mount runs once per mounted app, which is exactly
  // the boundary this needs to reset at.
  onMount(() => current.set(null));
  const open = current.get();
  return open ? open.render() : null;
}
