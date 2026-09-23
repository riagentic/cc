/**
 * @module
 * What the two sound servers share — the voice that reads aloud and the
 * microphone that listens. Both talk to a local process and a local HTTP
 * server, and both got the same three things wrong in the same way before
 * they were written once, here.
 */

/**
 * One piece of work at a time, in the order asked for.
 *
 * A factory, so each caller keeps its OWN chain: a reading queued behind the
 * speakers has no business waiting for the microphone to close. The chain has
 * to survive a failure, or one bad turn silences every later one.
 */
export function serial(): <T>(work: () => Promise<T>) => Promise<T> {
  let chain: Promise<unknown> = Promise.resolve();
  return <T>(work: () => Promise<T>): Promise<T> => {
    const next = chain.then(work, work);
    chain = next.then(() => {}, () => {});
    return next;
  };
}

/** The last non-empty line of what a process said — the one that explains. */
export const lastLine = (text: string): string =>
  text.trim().split("\n").map((l) => l.trim()).filter((l) => l !== "")
    .pop() ?? "";

/**
 * What a refusal actually said, from its status and body.
 *
 * These servers answer in OpenAI's error shape, and the message inside is the
 * useful part. Falls back to the status when there is nothing to read, which
 * is the most that can honestly be said then.
 */
export function refusal(status: number, said: string): string {
  try {
    const body = JSON.parse(said) as { error?: { message?: string } };
    const msg = body?.error?.message;
    if (typeof msg === "string" && msg !== "") return msg;
  } catch { /* not JSON; fall through to the raw text */ }
  const trimmed = said.trim().slice(0, 160);
  return trimmed === ""
    ? `the speech server answered ${status}`
    : `the speech server answered ${status}: ${trimmed}`;
}

/** `refusal`, reading the body — which also closes it. */
export async function complaint(res: Response): Promise<string> {
  return refusal(res.status, await res.text().catch(() => ""));
}
