/**
 * Status lights. The rule worth pinning is the one the old dot got wrong: a
 * thing existing is not a thing happening.
 */
import { assertEquals } from "@std/assert";
import type { Terminal } from "../../cell/console.ts";
import type { LocalChat } from "../../type/local.ts";
import {
  claudePulse,
  consolePulse,
  localPulse,
  pulseTitle,
  strongest,
} from "../../ui/pulse.ts";

const term = (over: Partial<Terminal> = {}): Terminal => ({
  projectId: "p",
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
  run: 1,
  ...over,
});

Deno.test("a shell sitting at a prompt is not busy", () => {
  // The whole point. This used to be green, and so was every other shell in
  // the dock, for as long as the app was open.
  assertEquals(consolePulse(term()), "ready");
});

Deno.test("a silent command is busy", () => {
  // `sleep 30` prints nothing at all. Watching output would call this idle,
  // which is why the signal comes from the terminal's foreground group.
  assertEquals(consolePulse(term({ busy: true })), "busy");
});

Deno.test("the light depends on state alone, never on the clock", () => {
  // A version of this read "output younger than 700ms counts as busy", and the
  // light then stayed on: the app has no reason to re-render at the instant a
  // deadline passes, so the moment never arrived. Any wait belongs in the
  // host, where a loop with a clock already runs, and must reach this as an
  // ordinary change of state.
  const t = term({ busy: false });
  assertEquals(consolePulse(t), "ready");
  assertEquals(consolePulse(t), consolePulse(t));
});

Deno.test("no shell, or a finished one, is idle", () => {
  assertEquals(consolePulse(term({ status: "off" })), "idle");
  // Even if it was mid-command when it died.
  assertEquals(consolePulse(term({ status: "exited", busy: true })), "idle");
});

Deno.test("waiting for a person outranks working", () => {
  // A turn parked on a permission prompt is not working, however long it has
  // been open, and that difference matters more than any other here.
  assertEquals(claudePulse("working", 1), "attention");
  assertEquals(claudePulse("working", 0), "busy");
  assertEquals(claudePulse("ready", 0), "ready");
  assertEquals(claudePulse("offline", 0), "idle");
  assertEquals(claudePulse("error", 0), "idle");
});

Deno.test("a local chat is idle until it has somewhere to talk to", () => {
  const chat = (over: Partial<LocalChat> = {}) =>
    ({ status: "idle", pending: null, messages: [], ...over }) as LocalChat;
  assertEquals(localPulse(chat(), false), "idle");
  assertEquals(localPulse(chat(), true), "ready");
  assertEquals(localPulse(chat({ status: "working" }), true), "busy");
  assertEquals(
    localPulse(chat({ pending: { id: "1" } as never }), true),
    "attention",
  );
});

Deno.test("a project shows the loudest thing inside it", () => {
  assertEquals(strongest(["idle", "ready", "busy"]), "busy");
  assertEquals(strongest(["busy", "attention"]), "attention");
  assertEquals(strongest(["idle", "idle"]), "idle");
  // No panes at all is not an error, and not a light.
  assertEquals(strongest([]), "idle");
});

Deno.test("every state says what it means", () => {
  // A colour nobody can name is a colour nobody reads, so each one carries
  // words on hover.
  for (const p of ["idle", "ready", "busy", "attention"] as const) {
    for (const what of ["shell", "chat"] as const) {
      assertEquals(pulseTitle(p, what).length > 0, true);
    }
  }
  assertEquals(pulseTitle("ready", "shell"), "At a prompt, nothing running");
});
