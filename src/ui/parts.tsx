/**
 * @module
 * Shared UI primitives. Small, unopinionated, and styled entirely by the
 * tokens in `theme.tsx` — no component here owns a colour.
 */
import {
  onCleanup,
  onGlobalKey,
  onMount,
  useInterval,
  useLocal,
  useRef,
  type VNode,
} from "aio/air";
import {
  IconAlert,
  IconCheck,
  IconChevron,
  IconCopy,
  IconExternal,
  IconSearch,
} from "./icons.tsx";
import { workspace } from "../cell/workspace.ts";
import { duration, pct as percent } from "../lib/format.ts";
import type { Status } from "../type/claude.ts";

/* ── menu ─────────────────────────────────────────────────────────────────── */

/** One row of a {@link Menu}. `hint` is the second line; `tone` marks the
 *  option that grants more than the others. */
export type MenuOption<T extends string> = {
  id: T;
  label: string;
  hint?: string;
  tone?: "danger" | "warn";
  /** Shown on the right of the row — a live number, a badge. */
  trailing?: unknown;
};

/**
 * A compact switcher: the current value as a button, the alternatives in a
 * popover under it.
 *
 * This exists because a status strip that *reports* the model and makes you
 * walk to Settings to change it is a strip that costs a click and pays none
 * back. Anything the strip names, the strip switches — so the popover is
 * deliberately the same control the Settings panel uses, not a lesser one:
 * every option carries its hint, and the selected one is ticked.
 *
 * Closing is handled for the three ways a popover is really dismissed —
 * choosing, Escape, and clicking anywhere else — because a menu that only
 * closes on its own trigger is a menu that gets left open.
 */
export function Menu<T extends string>(
  props: {
    /** Accessible name for the trigger — "Model", "Effort". */
    label: string;
    value: T;
    options: MenuOption<T>[];
    onChange: (v: T) => void;
    /** What the trigger shows. Defaults to the selected option's label. */
    trigger?: unknown;
    /** Right-aligned popover, for a control near the right edge. */
    align?: "right";
    title?: string;
    /** Rendered under the options — a link to the full settings, a caveat. */
    footer?: unknown;
    disabled?: boolean;
    /** Fired when the popover opens. For a list whose contents are discovered
     *  rather than known — "which local engines are running" — this is the
     *  moment to go and look, and the only moment worth spending it. */
    onOpen?: () => void;
  },
): VNode {
  const [open, setOpen] = useLocal(false);
  const root = useRef<HTMLSpanElement>(null!);
  // Read at event time, not closed over at mount: `onMount` runs once, so a
  // captured `open` would be false forever (the same trap `onGlobalKey`
  // documents in dep/aio/src/air/renderer-lifecycle.ts).
  const openRef = useRef(false);
  openRef.current = open;

  // Escape closes it from wherever the focus is — including the trigger, which
  // is where it still is right after a click. Handling the key only on the
  // popover meant the one place it was guaranteed NOT to work was the common
  // one. `ignoreInInput: false` so it also closes over a focused field.
  onGlobalKey("Escape", () => {
    if (openRef.current) setOpen(false);
  }, { ignoreInInput: false });

  onMount(() => {
    const dismiss = (e: Event) => {
      if (!openRef.current) return;
      const target = e.target as Node | null;
      if (target && root.current?.contains(target)) return;
      setOpen(false);
    };
    // Capture phase, so a click on a control that stops propagation still
    // closes the menu hanging over it.
    const doc = root.current?.ownerDocument ?? document;
    doc.addEventListener("pointerdown", dismiss, true);
    // A popover pinned to a button must not outlive the button's position.
    // Registered on the *document's* window, never the bare global: under a
    // test DOM those are two different objects, and a handler on the global is
    // one that can never fire (dep/aio/src/testing/ui-test.ts says so out loud).
    const win = doc.defaultView;
    win?.addEventListener("resize", dismiss, true);
    onCleanup(() => {
      doc.removeEventListener("pointerdown", dismiss, true);
      win?.removeEventListener("resize", dismiss, true);
    });
  });

  const current = props.options.find((o) => o.id === props.value);

  return (
    <span class="menu" ref={root}>
      <button
        type="button"
        class={`menu__btn${open ? " open" : ""}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={props.label}
        title={props.title ?? `${props.label} — click to change`}
        disabled={props.disabled}
        onClick={() => {
          if (!open) props.onOpen?.();
          setOpen(!open);
        }}
      >
        {
          /* No `truncate` here. The trigger is whatever the caller gave, and a
            caller that wants an ellipsis wraps it in one — the status strip's
            project path does, because a path is read from its tail. Clamping
            every trigger by default is what turned "Bypass" into "By…" and
            "haiku" into "h…" under a full-width label. */
        }
        {props.trigger ?? current?.label ?? props.value}
        {IconChevron({ size: 10 })}
      </button>

      {open && (
        <div
          class={`menu__pop${
            props.align === "right" ? " menu__pop--right" : ""
          }`}
          role="listbox"
          aria-label={props.label}
          onKeyDown={(e: KeyboardEvent) => {
            if (e.key === "Escape") {
              e.preventDefault();
              setOpen(false);
            }
          }}
        >
          {props.options.map((o) => (
            <button
              key={o.id}
              type="button"
              aria-pressed={o.id === props.value}
              // The label alone. Without it the accessible name is the label
              // and the hint run together ("OpusDeepest reasoning") — which is
              // what a screen reader announces and what testUI and `am` address
              // the row by. Same reason `Choice` takes a `name`.
              aria-label={o.label}
              class={`menu__item${o.id === props.value ? " selected" : ""}${
                o.tone ? ` menu__item--${o.tone}` : ""
              }`}
              onClick={() => {
                setOpen(false);
                if (o.id !== props.value) props.onChange(o.id);
              }}
            >
              <span class="menu__tick">
                {o.id === props.value ? IconCheck({ size: 13 }) : null}
              </span>
              <span class="truncate">
                <span class="menu__label truncate">{o.label}</span>
                {o.hint && (
                  <>
                    <br />
                    <span class="menu__hint">{o.hint}</span>
                  </>
                )}
              </span>
              {o.trailing}
            </button>
          ))}
          {props.footer && <div class="menu__foot">{props.footer}</div>}
        </div>
      )}
    </span>
  );
}

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
    /** `name` is the stable accessible label for an option whose visible text
     *  carries a live number ("Touched · 12"). Without it the announced — and
     *  addressable — name changes every time the count does. */
    options: { id: T; label: string; name?: string }[];
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
          aria-label={o.name}
          onClick={() => props.onChange(o.id)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/**
 * Copy-to-clipboard, for the things a reader actually wants out of a
 * transcript: a code block, a tool's input, an agent's answer.
 *
 * The confirmation is the label changing for a moment — a toast for an action
 * this small is more interruption than information.
 */
export function Copy(props: { text: string; label?: string }): VNode {
  const [done, setDone] = useLocal(false);

  const copy = async () => {
    const ok = await writeClipboard(props.text);
    if (!ok) return;
    setDone(true);
    // Long enough to read, short enough that the button is ready again before
    // anyone reaches for it twice.
    setTimeout(() => setDone(false), 1_200);
  };

  return (
    <button
      type="button"
      class="btn btn--ghost btn--sm copy"
      title={done ? "Copied" : "Copy to clipboard"}
      aria-label={done ? "Copied" : "Copy to clipboard"}
      onClick={() => void copy()}
    >
      {done ? IconCheck({ size: 13 }) : IconCopy({ size: 13 })}
      {props.label ? <span>{done ? "Copied" : props.label}</span> : null}
    </button>
  );
}

/** `navigator.clipboard` needs a secure context and a permission the embedder
 *  may not grant; the textarea path is the floor that works everywhere. */
async function writeClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const el = document.createElement("textarea");
      el.value = text;
      el.setAttribute("readonly", "");
      el.style.position = "fixed";
      el.style.opacity = "0";
      document.body.appendChild(el);
      el.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(el);
      return ok;
    } catch {
      return false;
    }
  }
}

/**
 * The two things anybody wants from a row that names a file: open it, or take
 * the path somewhere else.
 *
 * Five pages in this app list files — skills, commands, hooks, MCP servers,
 * memory — and every one of them named the file and stopped there, which is
 * exactly the "shows it, cannot act on it" the rest of this app is careful not
 * to do. Opening uses the desktop's own file association, so it is the user's
 * editor that opens, not one this app picked.
 */
export function PathActions(props: { path: string; label?: string }): VNode {
  return (
    <span class="pathacts" onClick={(e: Event) => e.stopPropagation()}>
      <button
        type="button"
        class="btn btn--ghost btn--sm btn--icon"
        title={`Open ${props.label ?? props.path}`}
        aria-label={`Open ${props.label ?? props.path}`}
        onClick={() => workspace.openPath(props.path)}
      >
        {IconExternal({ size: 13 })}
      </button>
      <Copy text={props.path} />
    </span>
  );
}

/**
 * A filter box for the long lists.
 *
 * The ring buffers behind these pages hold hundreds of entries, and a busy
 * session fills them in minutes — at which point scrolling is the only way to
 * find the one call you are looking for, which is no way at all.
 */
export function Search(
  props: {
    value: string;
    onChange: (v: string) => void;
    placeholder?: string;
    label: string;
  },
): VNode {
  return (
    <span class="search">
      <span class="search__icon">{IconSearch({ size: 13 })}</span>
      {
        /* The key that gets here from anywhere. Shown on the box itself and
          only while it is empty — a shortcut nobody is told about is a
          shortcut nobody uses, and one still advertised while you are typing
          in the field is noise. */
      }
      {props.value === "" && <span class="search__key kbd">/</span>}
      <input
        class="input input--search"
        type="search"
        value={props.value}
        aria-label={props.label}
        placeholder={props.placeholder ?? "Filter…"}
        onInput={(e) => props.onChange((e.target as HTMLInputElement).value)}
        // Escape clears without reaching for the mouse — the box is usually the
        // only thing standing between the reader and the full list again.
        onKeyDown={(e: KeyboardEvent) => {
          if (e.key === "Escape") props.onChange("");
        }}
      />
    </span>
  );
}

/** Case-insensitive "does this row match what was typed". Empty query matches
 *  everything, so a filter is never a way to lose the list. */
export const matches = (query: string, ...fields: unknown[]): boolean => {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return fields.some((f) =>
    typeof f === "string" && f.toLowerCase().includes(q)
  );
};

/**
 * Every word in the query must appear somewhere in the fields.
 *
 * The one-substring form ({@link matches}) is right for a list of short rows,
 * where what you type is a fragment of the row you want. It is wrong for a
 * page filter, where "allow dir" is two words about one panel and matching the
 * literal string "allow dir" finds nothing.
 */
export const matchesAll = (query: string, ...fields: unknown[]): boolean => {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const hay = fields
    .filter((f): f is string => typeof f === "string")
    .join(" ")
    .toLowerCase();
  return words.every((w) => hay.includes(w));
};

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
