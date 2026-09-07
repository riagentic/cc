/**
 * @module
 * Putting text into the message box from somewhere else on the page.
 *
 * Through the DOM rather than through state, and that is deliberate. The
 * composer's value is an *uncontrolled* textarea — the user is mid-sentence in
 * it, the caret is somewhere, and an undo stack has been building since they
 * started typing. Routing "edit this turn again" through a cell would re-render
 * the box, throw all three away, and make the app feel like it was fighting the
 * keyboard.
 *
 * Both engines' composers use the same markup, so one function serves both.
 */

/** The message box on the page, if there is one. */
const box = (): HTMLTextAreaElement | null =>
  typeof document === "undefined"
    ? null
    : document.querySelector<HTMLTextAreaElement>(".composer textarea");

/**
 * Replace the draft with `text`, focus the box, and put the caret at the end.
 *
 * The caret goes to the end because every caller means "here is a starting
 * point, now change it" — a re-sent turn, a suggestion, a template. Returns
 * whether there was a box at all, so a caller can fall back rather than
 * silently do nothing.
 */
export function fillComposer(text: string): boolean {
  const el = box();
  if (!el) return false;
  el.value = text;
  // The height is recomputed by the composer's own `input` handler, so tell it
  // something happened. Without this a recalled ten-line turn sits in a
  // one-line box until the next keystroke.
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.focus();
  el.setSelectionRange(el.value.length, el.value.length);
  return true;
}

/** Add text to the end of whatever is already in the box, on its own line. */
export function appendToComposer(text: string): boolean {
  const el = box();
  if (!el) return false;
  const sep = el.value === "" || el.value.endsWith("\n") ? "" : "\n";
  return fillComposer(el.value + sep + text);
}

/**
 * Unsent drafts, one per conversation.
 *
 * Per CONVERSATION, not per project, and that distinction is the bug this
 * fixes: a project can hold several chats, they share one composer, and keying
 * by project meant switching between two chats in the same project swapped
 * nothing — the half-written message stayed on screen, now aimed at the other
 * conversation. Which is worse than losing it, because the words look like
 * they belong where they are.
 *
 * Held here rather than in a cell for the same reason `fillComposer` writes to
 * the DOM: the box is uncontrolled, and routing every keystroke through state
 * would take the caret and the undo stack with it. Nothing here runs per
 * keystroke — a draft is saved when you leave it and read back when you
 * return.
 */
const drafts = new Map<string, string>();

/**
 * Keep what is in the box, under the conversation it was written for.
 *
 * An empty draft is deleted rather than stored: "nothing" is the default, and
 * a map of empty strings is a leak that also makes `loadDraft` answer with
 * something it never needed to.
 */
export function saveDraft(key: string, text: string): void {
  if (key === "") return;
  if (text.trim() === "") drafts.delete(key);
  else drafts.set(key, text);
}

/** What was left in this conversation's box, or "". */
export function loadDraft(key: string): string {
  return drafts.get(key) ?? "";
}

/**
 * Move the draft aside and bring the other one back.
 *
 * Called when the conversation on screen changes while the composer stays
 * mounted: `from` is whose words are in the box now, `to` is the one about to
 * be shown. Returns what the box should hold.
 */
export function swapDraft(from: string, to: string, current: string): string {
  if (from === to) return current;
  saveDraft(from, current);
  return loadDraft(to);
}

/** Forget a draft — it was sent, or the conversation is gone. */
export function dropDraft(key: string): void {
  drafts.delete(key);
}
