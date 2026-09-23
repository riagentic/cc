/**
 * The talk key and the words it produces, as pure decisions.
 *
 * Both bugs here live in timing a UI test cannot reproduce — key repeat at
 * thirty a second, and a dispatch that lands a render late — so the decisions
 * are asked directly, as many times as the real thing would ask them.
 */
import { assertEquals } from "@std/assert";
import { type KeyEvt, onKey, type Press } from "../../ui/pushToTalk.ts";
import { shouldPaste } from "../../ui/heard.ts";

const KEY = "ControlRight";
const down = (code = KEY, repeat = false): KeyEvt => ({
  kind: "down",
  code,
  repeat,
});
const up = (code = KEY): KeyEvt => ({ kind: "up", code, repeat: false });

/** Run a sequence of events and collect what each one asked for. */
function run(events: KeyEvt[], ready: boolean) {
  let press: Press = "idle";
  const acts: string[] = [];
  for (const e of events) {
    const next = onKey(press, e, KEY, ready);
    press = next.press;
    if (next.act) acts.push(next.act);
  }
  return { press, acts };
}

Deno.test("onKey — a held key is one press, and one release", () => {
  const out = run([down(), down(KEY, true), down(KEY, true), up()], true);
  assertEquals(out.acts, ["start", "stop"]);
  assertEquals(out.press, "idle");
});

Deno.test("onKey — switched off, a held key refuses once and releases quietly", () => {
  // Voice is off by default. Right-Ctrl held for a second used to log two
  // warnings per press and one more per key repeat — thirty a second.
  const repeats = Array.from({ length: 30 }, () => down(KEY, true));
  const out = run([down(), ...repeats, up()], false);
  assertEquals(out.acts, ["refuse"]);
  assertEquals(out.press, "idle");
});

Deno.test("onKey — Right-Ctrl plus a letter is a shortcut, not speech", () => {
  // The recording of one was a second of key clicks, which whisper wrote up
  // as words and auto-send sent.
  const out = run([down(), down("KeyC"), up("KeyC"), up()], true);
  assertEquals(out.acts, ["start", "cancel"]);
  assertEquals(out.press, "idle");
});

Deno.test("onKey — losing focus ends a hold, and only a hold", () => {
  assertEquals(
    run([down(), { kind: "blur", code: "", repeat: false }], true).acts,
    ["start", "stop"],
  );
  assertEquals(run([{ kind: "blur", code: "", repeat: false }], true).acts, []);
});

Deno.test("onKey — a release nobody saw pressed is reported", () => {
  assertEquals(run([up()], true).acts, ["stray"]);
  // Other keys are none of its business.
  assertEquals(run([down("KeyA"), up("KeyA")], true).acts, []);
});

Deno.test("shouldPaste — a turn is pasted once, however stale the cell", () => {
  // The cell clears its text a dispatch later, and a streaming reply renders
  // dozens of times in that window. Each one used to paste — and send — again.
  let pasted = 0;
  let times = 0;
  for (let render = 0; render < 40; render++) {
    if (shouldPaste(3, "run the tests", pasted)) {
      pasted = 3;
      times++;
    }
  }
  assertEquals(times, 1);
  // The same words said again are a new turn, and do go in.
  assertEquals(shouldPaste(4, "run the tests", pasted), true);
  // Nothing heard yet, or already taken: nothing to paste.
  assertEquals(shouldPaste(0, "x", 0), false);
  assertEquals(shouldPaste(5, "", 3), false);
});
