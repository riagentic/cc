/**
 * @module
 * The machine's vital signs: a compact strip for the rail, and a fuller panel
 * for Settings.
 *
 * Both arm the sampler on mount and stand it down on unmount, so nothing is
 * measured while nothing is shown. That is not an optimisation — a GPU reading
 * costs a process launch, and a control surface that spawns one every two
 * seconds forever would be loading the machine it claims to be observing.
 *
 * An absent reading is drawn as a dash, never as zero. "No GPU tool installed"
 * and "GPU completely idle" are opposite facts and must not share a picture.
 */
import { onCleanup, onMount, type VNode } from "aio/air";
import { busiestGpu, memPercent, metrics, vram } from "../cell/metrics.ts";
import { bytes } from "../lib/format.ts";
import { Meter, Panel } from "./parts.tsx";
import { ScopeTag } from "./RunViews.tsx";

/** Arm the sampler for as long as this component is on screen. */
function useSampler(): void {
  onMount(() => {
    void metrics.watch();
    // Registered inside `onMount`, which is what makes it an UNMOUNT callback
    // rather than one that runs after every render — see aio's
    // renderer-lifecycle. Getting that wrong here would stop the sampler on
    // the first re-render and leave the numbers frozen.
    onCleanup(() => void metrics.unwatch());
  });
}

/** One reading: a name, a bar, and a number. `value` of `null` means the
 *  reading could not be taken. */
function Gauge(
  props: {
    label: string;
    value: number | null;
    detail?: string;
    title?: string;
  },
): VNode {
  const pct = props.value;
  return (
    <div class="gauge" title={props.title}>
      <span class="gauge__k">{props.label}</span>
      <span class="gauge__bar">
        <Meter value={pct ?? 0} max={100} label={props.label} />
      </span>
      <span class="gauge__v mono">
        {pct === null ? "—" : `${Math.round(pct)}%`}
      </span>
      {props.detail && <span class="gauge__d">{props.detail}</span>}
    </div>
  );
}

/**
 * The compact strip, for the rail foot.
 *
 * Three lines at most, and the GPU line only when there is a GPU: a permanent
 * row reading "GPU —" on a laptop with no discrete card is a row that teaches
 * the reader to ignore the whole block.
 */
export function MachineStrip(): VNode {
  useSampler();
  const mem = memPercent();
  const gpu = busiestGpu();
  const v = vram();

  return (
    <div class="machine">
      <Gauge
        label="CPU"
        value={metrics.cpu}
        title="Processor busy across every core, over the last two seconds"
      />
      <Gauge
        label="RAM"
        value={mem}
        title={metrics.memTotal > 0
          ? `${bytes(metrics.memUsed)} of ${
            bytes(metrics.memTotal)
          } in use · this app ${bytes(metrics.ownRss)}`
          : "Not measured"}
      />
      {gpu !== null && (
        <Gauge
          label="GPU"
          value={gpu.busy}
          title={`${gpu.name}${gpu.temp !== null ? ` · ${gpu.temp}°C` : ""}`}
        />
      )}
      {v !== null && v.total > 0 && (
        <Gauge
          label="VRAM"
          value={(v.used / v.total) * 100}
          title={`${bytes(v.used)} of ${bytes(v.total)} video memory in use${
            metrics.gpus.length > 1
              ? `, across ${metrics.gpus.length} cards`
              : ""
          }`}
        />
      )}
    </div>
  );
}

/** The full picture, for Settings: every card by name, and this app's own
 *  footprint beside the machine's. */
export function MachinePanel(): VNode {
  useSampler();
  const mem = memPercent();
  return (
    <Panel title="Machine" actions={<ScopeTag scope="machine" />}>
      <div class="machine machine--wide">
        <Gauge key="cpu" label="CPU" value={metrics.cpu} detail="all cores" />
        <Gauge
          key="ram"
          label="RAM"
          value={mem}
          detail={metrics.memTotal > 0
            ? `${bytes(metrics.memUsed)} of ${bytes(metrics.memTotal)}`
            : "not measured"}
        />
        {metrics.gpus.map((g, i) => (
          <Gauge
            key={g.name + i}
            label="GPU"
            value={g.busy}
            detail={`${g.name}${g.temp !== null ? ` · ${g.temp}°C` : ""}`}
          />
        ))}
        {metrics.gpus.map((g, i) => (
          <Gauge
            key={"vram" + i}
            label="VRAM"
            value={g.vramTotal > 0 ? (g.vramUsed / g.vramTotal) * 100 : null}
            detail={g.vramTotal > 0
              ? `${bytes(g.vramUsed)} of ${bytes(g.vramTotal)}`
              : "not reported"}
          />
        ))}
        {!metrics.gpuKnown && (
          <div key="nogpu" class="field__hint">
            No GPU tool answered. <code>nvidia-smi</code> and{" "}
            <code>rocm-smi</code>{" "}
            are the two this asks for; without one of them there is nothing to
            read, which is not the same as a card sitting idle.
          </div>
        )}
      </div>
      <div class="field__hint" style={{ marginTop: "10px" }}>
        This app itself is using{" "}
        <b>{bytes(metrics.ownRss)}</b>. Sampled every two seconds, and only
        while something is showing it.
      </div>
    </Panel>
  );
}
