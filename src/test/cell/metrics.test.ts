/**
 * Machine metrics — the sampler's contract, not the numbers.
 *
 * What is worth pinning is that nothing is measured while nothing is being
 * shown (a GPU reading costs a process launch), and that a reading which
 * cannot be taken stays absent rather than becoming a zero. A flat 0% and "no
 * tool installed" look identical on a bar and mean opposite things.
 */
import { assert, assertEquals } from "@std/assert";
import { bootCells } from "aio/testing";
import { busiestGpu, memPercent, metrics, vram } from "../../cell/metrics.ts";
import { cpuPercent } from "../../cell/metrics.server.ts";

Deno.test("metrics — the sampler is armed by watchers and stood down with them", async () => {
  const h = await bootCells([metrics]);
  try {
    assertEquals(metrics.watchers, 0);

    metrics.watch();
    assertEquals(metrics.watchers, 1);
    metrics.watch();
    assertEquals(metrics.watchers, 2);

    metrics.unwatch();
    metrics.unwatch();
    assertEquals(metrics.watchers, 0);

    // Never below zero, however many times it is told to stop: a component
    // unmounting twice must not leave the count negative and the sampler
    // unarmable afterwards.
    metrics.unwatch();
    assertEquals(metrics.watchers, 0);
  } finally {
    h.dispose();
  }
});

Deno.test("metrics — a sample with nobody watching does nothing", async () => {
  const h = await bootCells([metrics]);
  try {
    await metrics.sample();
    assertEquals(metrics.sampledAt, 0, "no watcher, no reading");

    metrics.watch();
    await metrics.sample();
    assert(metrics.sampledAt > 0, "a watcher gets one");
    metrics.unwatch();
  } finally {
    h.dispose();
  }
});

Deno.test("metrics — one-off sampling ignores the watch count", async () => {
  const h = await bootCells([metrics]);
  try {
    await metrics.sampleOnce();
    assert(metrics.sampledAt > 0);
    assertEquals(metrics.watchers, 0, "and does not leave a watcher behind");
  } finally {
    h.dispose();
  }
});

Deno.test("metrics — derived readings are absent, not zero, before a sample", async () => {
  const h = await bootCells([metrics]);
  try {
    assertEquals(metrics.cpu, null);
    assertEquals(memPercent(), null, "no total means no percentage");
    assertEquals(busiestGpu(), null);
    assertEquals(vram(), null, "no cards is not a card with no memory");
  } finally {
    h.dispose();
  }
});

Deno.test("cpuPercent reports a percentage, or nothing at all", async () => {
  // Three ways this legitimately answers "nothing": no /proc at all, the first
  // call after the module loaded (load is a difference, and one read of
  // /proc/stat describes the machine's whole uptime), and two calls inside the
  // same jiffy. So the invariant worth pinning is not *when* it answers — it is
  // that whenever it does, the answer is a real percentage, and that it never
  // invents a zero to fill the gap.
  for (let i = 0; i < 4; i++) {
    const v = await cpuPercent();
    assert(
      v === null || (v >= 0 && v <= 100),
      `not a percentage: ${v}`,
    );
  }
});
