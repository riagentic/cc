/**
 * @module
 * Shared UI primitives. Small, unopinionated, and styled entirely by the
 * tokens in `theme.tsx` — no component here owns a colour.
 */
import { useInterval, useLocal, type VNode } from "aio/air";
import { IconAlert, IconCheck } from "./icons.tsx";
import { duration, pct as percent } from "../lib/format.ts";
import type { Status } from "../type/claude.ts";

/* ── live clock ───────────────────────────────────────────────────────────── */

/** A ticking `Date.now()`, scoped to whatever component calls it — so a live
 *  stopwatch re-renders one `<span>`, never the page around it. Stops when
 *  `active` is false: an idle app should be doing nothing at all. */
export function useNow(active: boolean, intervalMs = 100): number {
  const [now, setNow] = useLocal(Date.now());
  // `useInterval` follows `active` across re-renders; the hand-rolled
  // `onMount` + `setInterval` it replaces only read `active` once, at mount. A
  // sub-agent row outlives the run it shows, so both halves of that were wrong:
  // a finished run kept ticking forever, and a row that appeared before its run
  // started never ticked at all.
  useInterval(() => setNow(Date.now()), intervalMs, active);
  return active ? now : Date.now();
}

/** Live stopwatch for the turn in flight; the final duration once it lands. */
export function Elapsed(
  props: { startedAt: number | null; fallbackMs: number },
): VNode {
  const running = props.startedAt !== null;
  const now = useNow(running, 100);
  const ms = running ? now - (props.startedAt ?? now) : props.fallbackMs;
  return <span class="mono">{duration(ms)}</span>;
}

/* ── atoms ────────────────────────────────────────────────────────────────── */

export function Dot(props: { status: Status }): VNode {
  return <span class={`dot dot--${props.status}`} />;
}

export function Badge(
  props: { value: number | string; tone?: "live" | "ok" | "danger" },
): VNode {
  return (
    <span class={`badge${props.tone ? ` badge--${props.tone}` : ""}`}>
      {props.value}
    </span>
  );
}

export function Pill(
  props: {
    tone?: "accent" | "ok" | "danger" | "warn";
    icon?: unknown;
    children?: unknown;
  },
): VNode {
  return (
    <span class={`pill${props.tone ? ` pill--${props.tone}` : ""}`}>
      {props.icon}
      {props.children}
    </span>
  );
}

/** A labelled metric. `grow` gives it the free space in a status strip. */
export function Stat(
  props: {
    label: string;
    grow?: boolean;
    numeric?: boolean;
    /** Clamp the width so one long value cannot wrap the whole strip. */
    clamp?: boolean;
    title?: string;
    children?: unknown;
  },
): VNode {
  const cls = [
    "stat",
    props.grow ? "stat--grow" : "",
    props.numeric ? "stat--num" : "",
    props.clamp ? "stat--clamp" : "",
  ]
    .filter(Boolean).join(" ");
  return (
    <div class={cls} title={props.title}>
      <div class="stat__k">{props.label}</div>
      <div class="stat__v">{props.children}</div>
    </div>
  );
}

/**
 * A proportion bar. The colour is the warning: cool while there is room, warm
 * past 70%, hot past 90% — so context pressure is visible without reading a
 * single number.
 */
export function Meter(
  props: { value: number; max: number; tone?: "pressure" | "flat" },
): VNode {
  const p = percent(props.value, props.max);
  // "flat" is for bars that compare sizes to each other — the biggest bar is
  // not a warning. Only a real budget gets the escalating colour.
  const tone = props.tone === "flat"
    ? "ok"
    : p >= 90
    ? "hot"
    : p >= 70
    ? "warn"
    : "ok";
  return (
    <div
      class="meter"
      role="progressbar"
      aria-valuenow={Math.round(p)}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div
        class={`meter__fill meter__fill--${tone}`}
        style={{ width: `${p}%` }}
      />
    </div>
  );
}

export function Panel(
  props: {
    title?: unknown;
    actions?: unknown;
    flush?: boolean;
    children?: unknown;
  },
): VNode {
  return (
    <section class={`panel${props.flush ? " panel--flush" : ""}`}>
      {props.title !== undefined && (
        <header class="panel__head">
          <span class="panel__title">{props.title}</span>
          <span style={{ flex: 1 }} />
          {props.actions}
        </header>
      )}
      <div class="panel__body">{props.children}</div>
    </section>
  );
}

export function Empty(
  props: { icon: unknown; title: string; hint?: string; children?: unknown },
): VNode {
  return (
    <div class="empty">
      <div class="empty__icon">{props.icon}</div>
      <div class="empty__title">{props.title}</div>
      {props.hint && <div class="empty__hint">{props.hint}</div>}
      {props.children}
    </div>
  );
}

/** A dismissible problem report. Errors are never swallowed into a console. */
export function Banner(
  props: { tone?: "warn"; onDismiss?: () => void; children?: unknown },
): VNode {
  return (
    <div
      class={`banner${props.tone === "warn" ? " banner--warn" : ""}`}
      role="alert"
    >
      <span class="banner__icon">{IconAlert({ size: 16 })}</span>
      <span style={{ flex: 1 }}>{props.children}</span>
      {props.onDismiss && (
        <button
          type="button"
          class="btn btn--ghost btn--sm"
          onClick={props.onDismiss}
          aria-label="Dismiss"
        >
          Dismiss
        </button>
      )}
    </div>
  );
}

/** A radio-style option row — used for models, permission modes, projects. */
export function Choice(
  props: {
    label: unknown;
    /** Plain-text name for assistive tech. `label` may be rich markup whose
     *  text runs together ("OpusDeepest reasoning"), which is what a screen
     *  reader would otherwise announce — and what testUI addresses it by. */
    name?: string;
    hint?: string;
    selected: boolean;
    onSelect: () => void;
    trailing?: unknown;
  },
): VNode {
  return (
    <button
      type="button"
      class={`choice${props.selected ? " selected" : ""}`}
      aria-pressed={props.selected}
      aria-label={props.name}
      onClick={props.onSelect}
    >
      <span>
        <span class="choice__label">{props.label}</span>
        {props.hint && (
          <>
            <br />
            <span class="choice__hint">{props.hint}</span>
          </>
        )}
      </span>
      <span class="choice__tick">
        {props.trailing ?? (props.selected ? IconCheck({ size: 16 }) : null)}
      </span>
    </button>
  );
}

/** A compact 2–4 way switch. */
export function Segmented<T extends string>(
  props: {
    value: T;
    options: { id: T; label: string }[];
    onChange: (v: T) => void;
  },
): VNode {
  return (
    <div class="seg" role="group">
      {props.options.map((o) => (
        <button
          key={o.id}
          type="button"
          class={`seg__btn${props.value === o.id ? " selected" : ""}`}
          aria-pressed={props.value === o.id}
          onClick={() => props.onChange(o.id)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Tags(props: { items: string[]; max?: number }): VNode {
  const max = props.max ?? 999;
  const shown = props.items.slice(0, max);
  const rest = props.items.length - shown.length;
  return (
    <div class="tags">
      {shown.map((t) => <span key={t} class="tag">{t}</span>)}
      {rest > 0 && <span class="tag">+{rest} more</span>}
    </div>
  );
}
