/**
 * @module
 * What the machine is doing right now: processor, memory, and any GPU that
 * will say.
 *
 * This app runs local models beside a CLI that spawns compilers and test
 * suites, and "why is this slow" is a question about the machine at least as
 * often as it is a question about the model. Two numbers on screen answer it
 * without opening a terminal.
 *
 * Everything here is best-effort by design. A reading that cannot be taken is
 * reported as absent, never as zero: a flat 0% GPU line and "no GPU tool
 * installed" look identical on a chart and mean opposite things.
 */

/** One processor sample, in jiffies. Kept between calls because CPU load is a
 *  *difference* — a single reading of /proc/stat says what the machine has
 *  done since it booted, which is not a number anybody wants. */
let previous: { idle: number; total: number } | null = null;

/** Percent busy since the previous call, or `null` on the first call and on
 *  any platform without /proc. */
export async function cpuPercent(): Promise<number | null> {
  const line = await Deno.readTextFile("/proc/stat")
    .then((t) => t.split("\n", 1)[0])
    .catch(() => null);
  if (line === null || !line.startsWith("cpu ")) return null;

  const parts = line.trim().split(/\s+/).slice(1).map(Number);
  if (parts.some((n) => !Number.isFinite(n))) return null;
  // user nice system idle iowait irq softirq steal …
  const idle = (parts[3] ?? 0) + (parts[4] ?? 0);
  const total = parts.reduce((a, b) => a + b, 0);

  const last = previous;
  previous = { idle, total };
  if (last === null) return null;

  const dTotal = total - last.total;
  const dIdle = idle - last.idle;
  // A clock that went backwards, or two samples in the same jiffy. Either way
  // there is no rate to report.
  if (dTotal <= 0) return null;
  return Math.min(100, Math.max(0, ((dTotal - dIdle) / dTotal) * 100));
}

/** Total and used bytes of system memory, or `null` where Deno cannot say. */
export function memory(): { total: number; used: number } | null {
  try {
    const m = Deno.systemMemoryInfo();
    // `available` rather than `free`: on Linux most of "free" is page cache
    // that the kernel will hand back on demand, so reporting free memory shows
    // a machine at 95% used that is in fact half empty.
    const available = m.available > 0 ? m.available : m.free;
    return { total: m.total, used: Math.max(0, m.total - available) };
  } catch {
    return null;
  }
}

/** This process — the app itself, not the machine. */
export function ownMemory(): number {
  try {
    return Deno.memoryUsage().rss;
  } catch {
    return 0;
  }
}

/** One graphics card, as its vendor tool reports it. */
export type Gpu = {
  name: string;
  /** Percent busy, or `null` when the tool does not report it. */
  busy: number | null;
  vramUsed: number;
  vramTotal: number;
  /** Degrees Celsius, or `null`. */
  temp: number | null;
};

/** Run a command with a short leash. `null` for anything that is not there,
 *  fails, or takes too long — a metrics reading is never worth a stall. */
async function ask(
  cmd: string,
  args: string[],
  timeoutMs = 2_000,
): Promise<string | null> {
  const kill = new AbortController();
  const timer = setTimeout(() => kill.abort(), timeoutMs);
  try {
    const out = await new Deno.Command(cmd, {
      args,
      stdout: "piped",
      stderr: "null",
      signal: kill.signal,
    }).output();
    if (!out.success) return null;
    return new TextDecoder().decode(out.stdout);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Every GPU the machine will describe.
 *
 * NVIDIA first because `nvidia-smi` is the one that answers precisely; AMD's
 * `rocm-smi` is asked only if the first found nothing, and its JSON is read
 * defensively because its shape has changed between releases.
 *
 * An empty array means "asked, nothing answered" — the caller turns that into
 * an absent reading rather than a zero.
 */
export async function gpus(): Promise<Gpu[]> {
  const nv = await ask("nvidia-smi", [
    "--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu",
    "--format=csv,noheader,nounits",
  ]);
  if (nv !== null) {
    const found: Gpu[] = [];
    for (const line of nv.trim().split("\n")) {
      if (line.trim() === "") continue;
      const [name, busy, used, total, temp] = line.split(",").map((s) =>
        s.trim()
      );
      const num = (s: string) => {
        const n = Number(s);
        return Number.isFinite(n) ? n : null;
      };
      found.push({
        name,
        busy: num(busy),
        // nvidia-smi reports mebibytes; everything else in this app is bytes.
        vramUsed: (num(used) ?? 0) * 1024 * 1024,
        vramTotal: (num(total) ?? 0) * 1024 * 1024,
        temp: num(temp),
      });
    }
    if (found.length > 0) return found;
  }

  const amd = await ask("rocm-smi", ["--showuse", "--showmemuse", "--json"]);
  if (amd === null) return [];
  try {
    const parsed = JSON.parse(amd) as Record<string, Record<string, string>>;
    const found: Gpu[] = [];
    for (const [card, fields] of Object.entries(parsed)) {
      const pick = (needle: string) => {
        const hit = Object.entries(fields).find(([k]) =>
          k.toLowerCase().includes(needle)
        );
        const n = Number(hit?.[1]);
        return Number.isFinite(n) ? n : null;
      };
      found.push({
        name: card,
        busy: pick("gpu use"),
        vramUsed: pick("used memory") ?? 0,
        vramTotal: pick("total memory") ?? 0,
        temp: null,
      });
    }
    return found;
  } catch {
    return [];
  }
}
