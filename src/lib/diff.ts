/**
 * @module
 * A line diff, for showing what an edit actually changes.
 *
 * The Edit tool sends the old text and the new text, and the app was rendering
 * both as raw JSON — two walls of escaped string with the difference somewhere
 * inside them. A person approving an edit, or reading back what one did, is
 * asking exactly one question: which lines changed. This answers it.
 *
 * The algorithm is the textbook LCS table, which is O(n·m) in lines. That is
 * the right choice here and would be the wrong one in a version-control system:
 * an Edit's `old_string` is a handful of lines by construction — the tool
 * requires a unique match — and a bound below keeps a pathological input from
 * turning a rendering pass into a hang.
 */

/** One line of the result. `same` lines carry both sides' numbering. */
export type DiffLine = {
  kind: "same" | "add" | "del";
  text: string;
};

/**
 * Above this many lines on either side, the diff is not computed.
 *
 * The table is lines² cells; 600×600 is a third of a million, which is fine,
 * and ten thousand squared is not. A caller that gets `null` shows the two
 * texts plainly, which is what it did before this existed.
 */
export const MAX_DIFF_LINES = 600;

/**
 * Line-by-line difference between two texts, or `null` when either side is too
 * big to be worth the table.
 *
 * Trailing newlines are dropped before splitting: a file that ends in one
 * would otherwise always show a phantom empty last line as changed.
 */
export function diffLines(before: string, after: string): DiffLine[] | null {
  const a = before.replace(/\n$/, "").split("\n");
  const b = after.replace(/\n$/, "").split("\n");
  if (a.length > MAX_DIFF_LINES || b.length > MAX_DIFF_LINES) return null;

  // lcs[i][j] = length of the longest common subsequence of a[i:] and b[j:].
  const lcs: number[][] = Array.from(
    { length: a.length + 1 },
    () => new Array(b.length + 1).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j]
        ? lcs[i + 1][j + 1] + 1
        : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ kind: "same", text: a[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      // Deletions before insertions at the same position: a replaced line
      // reads as "this went, that came" in the order a person would say it.
      out.push({ kind: "del", text: a[i] });
      i++;
    } else {
      out.push({ kind: "add", text: b[j] });
      j++;
    }
  }
  while (i < a.length) out.push({ kind: "del", text: a[i++] });
  while (j < b.length) out.push({ kind: "add", text: b[j++] });
  return out;
}

/**
 * Drop long runs of unchanged lines, keeping `context` either side of every
 * change — the same idea as `diff -U3`.
 *
 * A `null` entry marks where lines were dropped, so the renderer can say how
 * many rather than silently joining two distant hunks into one.
 */
export function collapse(
  lines: DiffLine[],
  context = 3,
): (DiffLine | { kind: "gap"; text: string })[] {
  const keep = new Array(lines.length).fill(false);
  lines.forEach((l, n) => {
    if (l.kind === "same") return;
    for (
      let k = Math.max(0, n - context);
      k <= Math.min(lines.length - 1, n + context);
      k++
    ) keep[k] = true;
  });

  const out: (DiffLine | { kind: "gap"; text: string })[] = [];
  let skipped = 0;
  for (let n = 0; n < lines.length; n++) {
    if (keep[n]) {
      if (skipped > 0) {
        out.push({
          kind: "gap",
          text: `${skipped} unchanged line${skipped === 1 ? "" : "s"}`,
        });
        skipped = 0;
      }
      out.push(lines[n]);
    } else skipped++;
  }
  if (skipped > 0) {
    out.push({
      kind: "gap",
      text: `${skipped} unchanged line${skipped === 1 ? "" : "s"}`,
    });
  }
  return out;
}

/** How many lines an edit adds and removes — the one-line summary that belongs
 *  next to the file name. */
export const diffStat = (
  lines: DiffLine[],
): { added: number; removed: number } => ({
  added: lines.filter((l) => l.kind === "add").length,
  removed: lines.filter((l) => l.kind === "del").length,
});
