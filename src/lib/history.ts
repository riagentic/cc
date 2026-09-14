/**
 * @module
 * Searching what was said before — pure, so it is tested without a disk.
 *
 * A conversation's past lives in three places: rows still in the chat, rows
 * compacted out of the model's view (still in the chat, marked), and rows that
 * left the chat altogether (the 400-row cap, Clear, a parked conversation) and
 * were saved to disk. The executor gathers all three for ONE project and hands
 * them here; nothing from another project is ever searched.
 */
import { clip } from "./agent.ts";

/** One saved message, as history sees it. */
export type HistRow = {
  /** The conversation's key. */
  conv: string;
  /** The message id — unique within a conversation. */
  id: string;
  role: "user" | "assistant" | "tool";
  text: string;
  toolName?: string;
  /** The calls an assistant message made, flattened to `name args`. */
  calls?: string;
  at: number;
};

/**
 * What `history` searches that is not on disk: the rows the cell still holds.
 * Gathered by the cell for ONE project — this conversation's rows that left
 * the model's view, and every row of the project's other open conversations —
 * plus the keys of the project's parked conversations, whose rows are on disk.
 */
export type Recall = { self: string; rows: HistRow[]; parked: string[] };

/** The same row can be saved more than once — whole before its tool output
 *  was folded, folded later when the cap took it. The longest copy wins: it
 *  is the one with the facts in it. */
export function mergeRows(rows: HistRow[]): HistRow[] {
  const best = new Map<string, HistRow>();
  for (const r of rows) {
    const k = `${r.conv} ${r.id}`;
    const had = best.get(k);
    if (!had || r.text.length > had.text.length) best.set(k, r);
  }
  return [...best.values()].sort((a, b) => a.at - b.at);
}

/** The words to look for: `"a quoted phrase"` stays whole, the rest splits on
 *  space. Lower-cased; one-letter noise dropped. */
export function queryTerms(query: string): string[] {
  const out: string[] = [];
  const rest = query.replace(/"([^"]+)"/g, (_, p: string) => {
    if (p.trim()) out.push(p.trim().toLowerCase());
    return " ";
  });
  for (const w of rest.toLowerCase().split(/\s+/)) {
    if (w.length > 1 && !out.includes(w)) out.push(w);
  }
  return out;
}

const haystack = (r: HistRow): string =>
  `${r.text}\n${r.calls ?? ""}`.toLowerCase();

const escape = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

type Term = { text: string; word: RegExp };

/** Each term once, with its whole-word test compiled once per search. */
const compile = (terms: string[]): Term[] =>
  terms.map((text) => ({
    text,
    word: new RegExp(
      `(^|[^\\p{L}\\p{N}_])${escape(text)}($|[^\\p{L}\\p{N}_])`,
      "u",
    ),
  }));

/** How well one row answers: every term found beats most terms found, a
 *  whole word beats a piece of one ("port" in "import"), and what the user
 *  and the model SAID beats raw tool output on a tie. */
function score(r: HistRow, terms: Term[]): number {
  const h = haystack(r);
  let found = 0;
  let words = 0;
  for (const t of terms) {
    if (!h.includes(t.text)) continue;
    found++;
    if (t.word.test(h)) words++;
  }
  if (found === 0) return 0;
  return found * 10 + words * 6 + (found === terms.length ? 50 : 0) +
    (r.role === "tool" ? 0 : 3);
}

/** A window of text around the first hit, on one line. */
function snippet(r: HistRow, terms: string[], width: number): string {
  const flat = `${r.text}${r.calls ? ` [${r.calls}]` : ""}`.replace(/\s+/g, " ")
    .trim();
  const low = flat.toLowerCase();
  const at = terms.map((t) => low.indexOf(t)).filter((i) => i >= 0)
    .sort((a, b) => a - b)[0] ?? 0;
  const from = Math.max(0, at - Math.floor(width / 3));
  const piece = flat.slice(from, from + width);
  return `${from > 0 ? "…" : ""}${piece}${
    from + width < flat.length ? "…" : ""
  }`;
}

/** A row's time. Rows are read back from disk, so a nonsense value is
 *  possible — and must not take the whole search down with it. */
const stamp = (at: number): string => {
  if (!(Number.isFinite(at) && at > 0 && at < 8.64e15)) return "?";
  // The user's own clock, not UTC. In ISO it read two hours earlier than
  // everything else on screen, and a model reasoning about "earlier today"
  // was reasoning from the wrong hour. `sv-SE` is the locale whose format is
  // already YYYY-MM-DD HH:MM.
  try {
    return new Date(at).toLocaleString("sv-SE", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return new Date(at).toISOString().slice(0, 16).replace("T", " ");
  }
};

const who = (r: HistRow): string =>
  r.role === "tool" ? `${r.toolName ?? "tool"} result` : r.role;

/** A conversation's name: what the user asked first. */
export function convTitle(rows: HistRow[], conv: string): string {
  const first = rows.find((r) => r.conv === conv && r.role === "user");
  return first ? clip(first.text.replace(/\s+/g, " "), 60) : "(no request)";
}

/** Short, stable handle for a conversation — enough to name it in a call. */
export const convTag = (conv: string): string => conv.slice(0, 8);

export type SearchOpts = {
  /** The conversation the model is in — named "this" in results. */
  self: string;
  /** Room for the whole answer, in characters. */
  budget: number;
  limit?: number;
  /** Only this conversation (a tag, a full key, or "this"). */
  conversation?: string;
};

const pick = (rows: HistRow[], o: SearchOpts): HistRow[] => {
  const want = o.conversation?.trim();
  if (!want) return rows;
  const key = want === "this" ? o.self : want;
  return rows.filter((r) => r.conv === key || convTag(r.conv) === key);
};

/**
 * Answer a `history` call.
 *
 * With a query: the best-matching messages, each tagged with its conversation,
 * time, speaker and id, so a follow-up can open one whole (`id`). Without one:
 * the project's conversations — what each was about, when, how long.
 */
export function searchHistory(
  all: HistRow[],
  query: string,
  o: SearchOpts,
): string {
  const rows = pick(all, o);
  const label = (conv: string) => conv === o.self ? "this" : convTag(conv);
  if (rows.length === 0) {
    return o.conversation
      ? `No saved messages in conversation "${o.conversation}".`
      : "No earlier conversations are saved for this project.";
  }
  const terms = queryTerms(query);
  if (terms.length === 0) {
    const convs = [...new Set(rows.map((r) => r.conv))];
    const lines = convs.map((c) => {
      const mine = rows.filter((r) => r.conv === c);
      return `- ${label(c)} · ${stamp(mine[0].at)} → ${
        stamp(mine[mine.length - 1].at)
      } · ${mine.length} messages · "${convTitle(rows, c)}"`;
    });
    return clip(
      `Conversations in this project (newest last). Search with a query, or` +
        ` pass conversation to search one:\n${lines.join("\n")}`,
      o.budget,
      0.3,
    );
  }
  const limit = Math.min(Math.max(o.limit ?? 12, 1), 40);
  const compiled = compile(terms);
  const ranked = rows
    .map((r) => ({ r, s: score(r, compiled) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || b.r.at - a.r.at)
    .slice(0, limit);
  if (ranked.length === 0) {
    return `Nothing in this project's saved conversations matches` +
      ` ${terms.map((t) => `"${t}"`).join(" ")}. Try fewer or different words.`;
  }
  const width = Math.min(
    Math.max(Math.floor(o.budget / ranked.length) - 80, 120),
    600,
  );
  const lines = ranked.map(({ r }) =>
    `[${label(r.conv)} · ${stamp(r.at)} · ${who(r)} · id ${r.id}] ${
      snippet(r, terms, width)
    }`
  );
  return clip(
    `${ranked.length} match${ranked.length === 1 ? "" : "es"} (best first).` +
      ` Pass id to read one whole.\n${lines.join("\n")}`,
    o.budget,
    0.9,
  );
}

/** One saved message, whole — or as much of it as fits. */
export function readHistoryRow(
  all: HistRow[],
  id: string,
  o: SearchOpts,
): string {
  const r = pick(all, o).find((x) => x.id === id);
  if (!r) return `Error: no saved message with id "${id}" in this project.`;
  const head = `[${r.conv === o.self ? "this" : convTag(r.conv)} · ${
    stamp(r.at)
  } · ${who(r)}]`;
  return clip(
    `${head}\n${r.text}${r.calls ? `\n[calls: ${r.calls}]` : ""}`,
    o.budget,
    0.7,
  );
}
