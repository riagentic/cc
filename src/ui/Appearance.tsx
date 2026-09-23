/**
 * @module
 * The appearance controls, and the printed keyboard map — the two settings
 * panels that are about the *window* rather than about any codebase.
 *
 * Kept out of `SettingsPage.tsx` because they share nothing with it: no
 * project, no session, no CLI. The page composes them; they know nothing about
 * the page.
 */
import type { VNode } from "aio/air";
import { THEMES, workspace } from "../cell/workspace.ts";
import {
  ACCENTS,
  prefs,
  ZOOM_MAX,
  ZOOM_MIN,
  ZOOM_STEP,
} from "../cell/prefs.ts";
import { Segmented, Toggle } from "./parts.tsx";
import { helpRows } from "./commands.ts";

/** One labelled control. The same shape the rest of the settings page uses, so
 *  a row here and a row there line up. */
const Field = (
  props: { label: string; hint?: string; children?: unknown },
): VNode => (
  <div class="field">
    <span class="field__label">{props.label}</span>
    {props.children as VNode}
    {props.hint && <span class="field__hint">{props.hint}</span>}
  </div>
);

export function AppearanceFields(): VNode {
  const pct = Math.round(prefs.zoom * 100);
  return (
    <>
      <Field
        label="Theme"
        hint={THEMES.find((t) => t.id === workspace.theme)?.hint ??
          "System follows your OS setting and switches with it."}
      >
        <Segmented
          value={workspace.theme}
          options={THEMES.map((t) => ({ id: t.id, label: t.label }))}
          onChange={(v) => workspace.setTheme(v)}
        />
      </Field>

      <Field
        label="Accent"
        hint="Used for the selected project, live badges, focus rings and links."
      >
        <div class="swatches" role="group" aria-label="Accent colour">
          {ACCENTS.map((a) => (
            <button
              key={a.id}
              type="button"
              class={"swatch" + (prefs.accent === a.id ? " selected" : "")}
              aria-label={a.label}
              aria-pressed={prefs.accent === a.id}
              title={a.label}
              onClick={() => prefs.setAccent(a.id)}
            >
              <span
                style={{
                  background: `linear-gradient(150deg, ${a.dark}, ${a.light})`,
                }}
              />
            </button>
          ))}
        </div>
      </Field>

      <Field
        label="Zoom"
        hint="Zoom lives here — Ctrl and the scroll wheel are left alone."
      >
        <div class="stepper">
          <button
            type="button"
            class="btn btn--sm"
            aria-label="Zoom out"
            disabled={prefs.zoom <= ZOOM_MIN}
            onClick={() => prefs.zoomBy(-ZOOM_STEP)}
          >
            −
          </button>
          <span class="stepper__v">{pct}%</span>
          <button
            type="button"
            class="btn btn--sm"
            aria-label="Zoom in"
            disabled={prefs.zoom >= ZOOM_MAX}
            onClick={() => prefs.zoomBy(ZOOM_STEP)}
          >
            +
          </button>
          <button
            type="button"
            class="btn btn--sm btn--ghost"
            disabled={pct === 100}
            onClick={() => prefs.resetZoom()}
          >
            Reset
          </button>
        </div>
      </Field>

      <Field
        label="Density"
        hint="Compact trims the padding and hides the second line on list rows."
      >
        <Segmented
          value={prefs.density}
          options={[
            { id: "cozy", label: "Comfortable" },
            { id: "compact", label: "Compact" },
          ]}
          onChange={(v) => prefs.setDensity(v)}
        />
      </Field>

      <Field
        label="Text width"
        hint="How wide the conversation is allowed to grow. Narrow is easier to read on a big screen."
      >
        <Segmented
          value={prefs.chatWidth}
          options={[
            { id: "narrow", label: "Narrow" },
            { id: "wide", label: "Wide" },
            { id: "full", label: "Full" },
          ]}
          onChange={(v) => prefs.setChatWidth(v)}
        />
      </Field>

      <Field
        label="Motion"
        hint="Automatic follows the reduced-motion setting your system already has."
      >
        <Segmented
          value={prefs.motion}
          options={[
            { id: "auto", label: "Automatic" },
            { id: "full", label: "Full" },
            { id: "reduced", label: "Reduced" },
          ]}
          onChange={(v) => prefs.setMotion(v)}
        />
      </Field>

      <div class="stack">
        <Toggle
          label="Show message times"
          hint="A clock on every message, not just on hover."
          checked={prefs.timestamps}
          onChange={(on) => prefs.setTimestamps(on)}
        />
        <Toggle
          label="Wrap long code lines"
          hint="Off means a code block scrolls sideways, which keeps a command copyable exactly as written."
          checked={prefs.codeWrap}
          onChange={(on) => prefs.setCodeWrap(on)}
        />
        <Toggle
          label="Sound when a turn finishes"
          hint="Only while the window is in the background — a chime for work you walked away from."
          checked={prefs.sounds}
          onChange={(on) => prefs.setSounds(on)}
        />
      </div>
    </>
  );
}

/** Every global shortcut, printed. Same table the keys are installed from, so
 *  this cannot list a key that does nothing. */
export function ShortcutList(): VNode {
  const rows = helpRows();
  const groups = [...new Set(rows.map((r) => r.group))];
  return (
    <div class="stack">
      {groups.map((g) => (
        <div key={g}>
          <div class="rail__group" style={{ padding: "6px 0 2px" }}>{g}</div>
          {rows.filter((r) => r.group === g).map((r) => (
            <div class="pal__help" key={r.keys}>
              <span class="truncate">{r.label}</span>
              <span class="pal__keys">
                {r.keys.split(" ").map((k) => <kbd class="kbd" key={k}>{k}
                </kbd>)}
              </span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
