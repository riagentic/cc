/**
 * The console cell's bookkeeping — the part that decides what a tab says.
 *
 * Seeded rather than driven: reaching "a shell is open" through the real
 * methods means starting a real shell, and none of what is under test here
 * needs one.
 */
import { assertEquals } from "@std/assert";
import { testCell } from "aio/testing";
import {
  consoleCell,
  readerPresent,
  shouldWait,
  type Terminal,
} from "../../cell/console.ts";

const term = (over: Partial<Terminal> = {}): Terminal => ({
  projectId: "proj-1",
  title: "Console",
  command: "",
  createdAt: 0,
  status: "live",
  busy: false,
  running: "",
  exitCode: null,
  error: null,
  cwd: "/tmp",
  shell: "/bin/bash",
  out: [],
  base: 0,
  lost: 0,
  watchers: 0,
  rows: 24,
  cols: 80,
  run: 7,
  ...over,
});

testCell(consoleCell, "the running command is remembered, and let go", (t) => {
  t.init({ terms: { a: term() } });

  t.send.setBusy("a", true, "cargo");
  t.expect.state((s) => s.terms.a.busy === true);
  t.expect.state((s) => s.terms.a.running === "cargo");

  // Back to a prompt: the light goes out and the name goes with it. A tab
  // still reading `cargo` over an idle shell claims something is happening.
  t.send.setBusy("a", false, "");
  t.expect.state((s) => s.terms.a.running === "");

  // A name arriving with `busy: false` is not a name to show either.
  t.send.setBusy("a", false, "rustc");
  t.expect.state((s) => s.terms.a.running === "");
});

testCell(consoleCell, "a finished shell takes its record with it", (t) => {
  // `exit` and `Ctrl-D` end the session, and the tab showing it is done —
  // which is what closing a terminal window has always meant. A dead record
  // left behind is a row in the dock for a shell that is not there.
  t.init({
    terms: { a: term({ busy: true, running: "sleep" }) },
    active: { "proj-1": "a" },
  });
  t.send.ended("a", 0);
  assertEquals(t.getState().terms.a, undefined);
  // And the project stops pointing at it.
  assertEquals(t.getState().active["proj-1"], undefined);
});

testCell(consoleCell, "a superseded run cannot close the live tab", (t) => {
  t.init({ terms: { a: term({ run: 7 }) } });
  // The old host's exit arrives after the new one has published "live". It
  // carries the run it was made with, and a stale one must not take the tab
  // out from under its replacement.
  t.send.ended("a", 0, 6);
  assertEquals(t.getState().terms.a !== undefined, true);
});

testCell(consoleCell, "a superseded run cannot write to the tab", (t) => {
  t.init({ terms: { a: term({ run: 7 }) } });
  // Every callback carries the run it was made with. A host that has been
  // replaced must not write into its replacement's screen — or its tab.
  t.send.setBusy("a", true, "ghost", 6);
  t.expect.state((s) => s.terms.a.running === "");
  t.expect.state((s) => s.terms.a.busy === false);
  // The current run does write.
  t.send.setBusy("a", true, "make", 7);
  t.expect.state((s) => s.terms.a.running === "make");
});

testCell(consoleCell, "a terminal nobody opened is not invented", (t) => {
  // `setBusy` observes; it must not create. A record with an empty projectId
  // is a row the dock cannot place and a shell nothing can start.
  t.init({ terms: {} });
  t.send.setBusy("nope", true, "cargo");
  assertEquals(Object.keys(t.getState().terms).length, 0);
});

Deno.test("an unwatched shell is never held back", () => {
  // A dev server in a tab nobody is looking at: the queue fills, and waiting
  // for a page that is not there stalled it after ~96 chunks. Nobody reading
  // means keep running and let scrollback drop the oldest.
  assertEquals(shouldWait(0, 500, 0, 0), false);
  assertEquals(shouldWait(0, 96, 0, 0), false);
});

Deno.test("a watched shell waits for its reader, but only past the threshold", () => {
  const now = 10_000;
  assertEquals(shouldWait(1, 95, now, now), false);
  assertEquals(shouldWait(1, 96, now, now), true);
});

Deno.test("a watcher that stopped acknowledging is not a reader", () => {
  // A renderer that reloads never sends `unwatch`: the count stays at one for
  // good. Output waiting unacknowledged for longer than the lease is the
  // proof nobody is drawing it, and the shell must not stall behind it.
  assertEquals(readerPresent(1, 200, 0, 4_000), true);
  assertEquals(readerPresent(1, 200, 0, 6_000), false);
  assertEquals(shouldWait(1, 200, 0, 6_000), false);
  // Nothing waiting is not silence: an idle shell's reader is still there.
  assertEquals(readerPresent(1, 0, 0, 60_000), true);
});
