/**
 * @module
 * Navigation that does nothing when you are already there.
 *
 * Clicking the page you are already on used to push a history entry and
 * re-sync the router, and the app rebuilt its tree — measured: one click on
 * the highlighted Console card, one whole-UI remount. On most pages that is
 * invisible waste. On the Console it is not: the terminal is torn down and
 * drawn again from its saved scrollback, so the screen flashes. It also left
 * a Back button that appeared to do nothing, because the entry it went back
 * to was the page you were looking at.
 *
 * So every navigation in this app goes through here.
 */
import { navigate, useRoute } from "aio/air";

/** Is `to` the page on screen? Prefix-matched the way a router matches, so
 *  `/settings` counts as active while you are at `/settings/mcp`. */
export const atRoute = (to: string, exact = false): boolean => {
  const path = useRoute().path;
  if (exact || to === "/") return path === to;
  return path === to || path.startsWith(to + "/");
};

/** Go there, unless that is where we are. */
export const go = (to: string, exact = false): void => {
  if (!atRoute(to, exact)) navigate(to);
};
