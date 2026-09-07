/**
 * @module
 * The one list of actions whose recorded values must be kept nowhere — not in
 * `logs/actions.jsonl`, not in the diagnostic checkpoint, not in `am timeline`.
 *
 * The criterion is one question per cell: can its state carry arbitrary user
 * or model text, or file contents? Every cell that can is listed:
 *   - `session` — the Claude Code transcript;
 *   - `local`   — the local-engine transcript;
 *   - `jobs`    — other projects' background sessions: their `intent` is a raw
 *                 user prompt and their `timeline[].text` is model output;
 *   - `tree`    — the file preview pane holds file contents verbatim;
 *   - `voice`   — what the microphone heard, before you have even seen it;
 *   - `speech`  — the text on its way to the speakers, which is either half
 *                 of the conversation.
 * The cells left off hold only metadata that is a fact about the machine, not
 * about a conversation: `catalog` (skill/command sizes and names), `storage`
 * (paths and byte counts), `workspace` (project paths and settings, which it
 * persists deliberately anyway).
 *
 * Prefix patterns (`cell:*`), not a list of method names, deliberately: a
 * redaction list of individual methods is the list that goes stale the day a
 * method is added, and a stale redaction list fails open
 * (dep/aio/docs/persistence/where-files-live.md). A listed cell's whole state
 * slice is withheld from the checkpoint, which is precisely right here — the
 * slice *is* the private content.
 */
export const REDACTED_ACTIONS: string[] = [
  "session:*",
  "local:*",
  "jobs:*",
  "tree:*",
  "voice:*",
  "speech:*",
];
