/**
 * @module
 * A throwaway worker that runs one model-supplied regex over a batch of lines.
 *
 * It exists for one reason: a JavaScript regex is synchronous and can take
 * unbounded time (catastrophic backtracking), and there is no way to interrupt
 * one on the thread it runs on. Static pattern analysis cannot catch every bad
 * shape — nested groups and long `.*.*.*` runs each slipped past a heuristic
 * gate — so the guarantee lives here instead: the parent runs this worker
 * against a deadline and *terminates* it if it overruns. A wedged match takes
 * a disposable worker down, never the app.
 */

type Doc = { path: string; lines: string[] };
type Req = { pattern: string; docs: Doc[]; maxHits: number; lineScan: number };

self.onmessage = (e: MessageEvent<Req>) => {
  const { pattern, docs, maxHits, lineScan } = e.data;
  const hits: string[] = [];
  try {
    const re = new RegExp(pattern);
    outer:
    for (const doc of docs) {
      for (let i = 0; i < doc.lines.length; i++) {
        if (re.test(doc.lines[i].slice(0, lineScan))) {
          hits.push(
            `${doc.path}:${i + 1}: ${doc.lines[i].trim().slice(0, 200)}`,
          );
          if (hits.length >= maxHits) break outer;
        }
      }
    }
    (self as unknown as Worker).postMessage({ ok: true, hits });
  } catch {
    (self as unknown as Worker).postMessage({ ok: false });
  }
};
