/**
 * @module
 * The machine's own vital signs, sampled only while somebody is looking.
 *
 * The polling contract is the whole design. Asking `nvidia-smi` costs a
 * process launch, and a control surface that spawns one every two seconds
 * forever — including while minimised, including on a laptop on battery —
 * would be measuring the machine by loading it. So the sampler is armed by the
 * components that display it and stands down when the last one goes away.
 *
 * Nothing here is persisted. Every number is about this second.
 */
import { cell, log, type MethodDraftMeta, schedule } from "aio";
import type { Gpu } from "./metrics.server.ts";

/** How often the machine is sampled while it is being watched. Two seconds is
 *  slow enough to be free and fast enough that a build starting is visible. */
const TICK_MS = 2_000;

type MetricsState = {
  /** Percent busy, or `null` when it has not been measured — the first sample
   *  is a baseline, not a reading, and some platforms never answer. */
  cpu: number | null;
  memTotal: number;
  memUsed: number;
  /** Resident memory of this app itself. The honest counterweight to showing
   *  the machine's: a control surface that quietly eats a gigabyte should say
   *  so where its user can see it. */
  ownRss: number;
  gpus: Gpu[];
  /** Whether any GPU tool answered at all. `false` means "asked, nothing
   *  there", which is why an empty list is never drawn as 0%. */
  gpuKnown: boolean;
  /** How many components are showing these numbers. The sampler runs while
   *  this is above zero and not otherwise. */
  watchers: number;
  sampledAt: number;
};

type Draft = MetricsState & Partial<MethodDraftMeta<MetricsState>>;

/**
 * Take one reading into the draft.
 *
 * A plain function rather than a method the other methods call: a nested
 * same-cell call runs as its own transaction against *committed* state, so it
 * cannot see what its caller is halfway through writing. Every cell in this
 * app shares the work this way for the same reason.
 *
 * Everything is gathered before the first write. Four awaits interleaved with
 * writes would make the whole pass one long pinned transaction, which a
 * watcher arriving in the middle would abort.
 */
async function applySample(s: Draft): Promise<void> {
  const io = await import("./metrics.server.ts");
  const cpu = await io.cpuPercent();
  const mem = io.memory();
  const rss = io.ownMemory();
  const cards = await io.gpus();

  const live = s.$live ?? s;
  live.cpu = cpu;
  if (mem !== null) {
    live.memTotal = mem.total;
    live.memUsed = mem.used;
  }
  live.ownRss = rss;
  live.gpus = cards;
  live.gpuKnown = cards.length > 0;
  live.sampledAt = Date.now();
}

export const metrics = cell("metrics", {
  state: {
    cpu: null as number | null,
    memTotal: 0,
    memUsed: 0,
    ownRss: 0,
    gpus: [] as Gpu[],
    gpuKnown: false,
    watchers: 0,
    sampledAt: 0,
  },

  // Nothing here survives a restart, and nothing should: every field is a
  // statement about the last two seconds.
  persist: "none",

  // The sampler awaits four readings between writes, and a watcher arriving
  // mid-sample must not tear the result in half.
  transaction: true,

  methods: {
    /** A component started showing these numbers. */
    watch(s: Draft) {
      s.watchers += 1;
      if (s.watchers === 1) {
        // The first watcher gets a reading immediately rather than in two
        // seconds: an indicator that is blank when it appears reads as broken.
        s.$do?.(schedule.after("metrics-first", 0, metrics.sample.action()));
        s.$do?.(
          schedule.every("metrics-tick", TICK_MS, metrics.sample.action(), {
            skipIfRunning: true,
          }),
        );
      }
    },

    /** …and stopped. */
    unwatch(s: Draft) {
      s.watchers = Math.max(0, s.watchers - 1);
      if (s.watchers === 0) s.$do?.(schedule.cancel("metrics-tick"));
    },

    async sample(s: Draft) {
      // A tick that outlived the last watcher: the schedule is cancelled, but
      // one sample may already have been queued.
      if (s.watchers === 0) return;
      await applySample(s);
    },

    /** Take one reading now, whatever the watch count — for a page that shows
     *  a snapshot with a Refresh button rather than a live meter. */
    async sampleOnce(s: Draft) {
      await applySample(s);
    },
  },
});

/** Memory in use, as a percentage — or `null` before the first reading. */
export const memPercent = (): number | null =>
  metrics.memTotal > 0 ? (metrics.memUsed / metrics.memTotal) * 100 : null;

/** The busiest card, which is the one worth a single number on screen. */
export const busiestGpu = (): Gpu | null => {
  if (metrics.gpus.length === 0) return null;
  return metrics.gpus.reduce((worst, g) =>
    (g.busy ?? -1) > (worst.busy ?? -1) ? g : worst
  );
};

/** Video memory across every card. Summed rather than shown per card in the
 *  compact indicator: two cards half full is one machine half full. */
export const vram = (): { used: number; total: number } | null => {
  if (metrics.gpus.length === 0) return null;
  return metrics.gpus.reduce(
    (sum, g) => ({
      used: sum.used + g.vramUsed,
      total: sum.total + g.vramTotal,
    }),
    { used: 0, total: 0 },
  );
};
