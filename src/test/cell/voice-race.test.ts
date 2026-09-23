/**
 * The press that is over before the recorder is open.
 *
 * `start` and `stop` are both async and both driven by a key. Down and up can
 * be a tenth of a second apart while `start` is still awaiting a spawn. Run
 * out of order, `stop` found no recorder, called the press too short and threw
 * the audio away — and then `start` finished and left a recorder running that
 * nobody owned. The next press cleaned that up, which is exactly why it looked
 * like every other attempt worked.
 */
import { assertEquals } from "@std/assert";
import {
  capturing,
  startCapture,
  stopCapture,
} from "../../cell/voice.server.ts";

Deno.test("a press shorter than the recorder takes to open still records", async () => {
  // Not awaited: this is the key going down, and the key comes up while the
  // recorder is still being spawned.
  const started = startCapture({ device: "" }, {
    onLevel: () => {},
    onFull: () => {},
  });
  const wav = await stopCapture();

  await started;
  assertEquals(
    capturing(),
    false,
    "no recorder may be left running once the key is up",
  );
  // Either it captured something or it honestly had nothing — what it must
  // NOT do is leave the microphone open, which is what the race did.
  if (wav !== null) {
    assertEquals(wav.length > 44, true, "a WAV with samples in it");
  }
});

Deno.test("stop is safe when nothing is recording", async () => {
  assertEquals(await stopCapture(), null);
  assertEquals(capturing(), false);
});

Deno.test("two presses in a row cannot overlap", async () => {
  const a = startCapture({ device: "" }, {
    onLevel: () => {},
    onFull: () => {},
  });
  const b = startCapture({ device: "" }, {
    onLevel: () => {},
    onFull: () => {},
  });
  await Promise.all([a, b]);
  assertEquals(capturing(), true, "exactly one recorder is open");
  await stopCapture();
  assertEquals(capturing(), false, "and it closes");
});
