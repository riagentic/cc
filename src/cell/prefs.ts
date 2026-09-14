/**
 * @module
 * Preferences — how the app *looks and feels*, as opposed to what it does.
 *
 * Kept apart from `workspace` on purpose. Everything there is a claim about a
 * codebase (where it is, which model runs in it, what that model may do);
 * everything here is a claim about the person sitting in front of the window.
 * The two are edited at different moments, restored on different machines, and
 * a mistake in one should never be able to corrupt the other.
 *
 * Every field is persisted. A preference that does not survive a restart is not
 * a preference — it is a setting you have to make again, which is worse than
 * not offering it.
 *
 * The palette choice (dark / light / system) is the one appearance value that
 * does *not* live here: it predates this cell, it is already persisted by
 * `workspace`, and duplicating it would create two truths about one switch.
 * `theme.tsx` reads both and neither knows about the other.
 */
import { cell } from "aio";

/** The accent hue. One value, used for both palettes — the dark and light
 *  shades of each are picked per accent so neither ends up unreadable. */
export type Accent =
  | "ember"
  | "ocean"
  | "forest"
  | "grape"
  | "rose"
  | "steel";

/** How tightly the furniture is packed. */
export type Density = "cozy" | "compact";

/** How much the app moves. `auto` means "ask the operating system", which is
 *  where a person who is sensitive to motion has usually already said so. */
export type Motion = "auto" | "full" | "reduced";

/** How wide the transcript is allowed to grow. Long lines are hard to read;
 *  a fixed measure is the single biggest thing you can do for a wall of text. */
export type ChatWidth = "narrow" | "wide" | "full";

/** The zoom range, and the step a keystroke or a wheel notch moves it.
 *  Bounded so no single mis-scroll can leave the window unreadable and the
 *  control to fix it off-screen. */
export const ZOOM_MIN = 0.7;
export const ZOOM_MAX = 1.8;
export const ZOOM_STEP = 0.1;

/** Clamp and round a zoom factor, so `1.0999999` never reaches the DOM and
 *  every path that changes zoom agrees on what the value means. */
export const clampZoom = (z: number): number =>
  // NaN is the only value with no sensible clamp — it compares false against
  // everything, so Math.min would carry it straight through. An infinity, by
  // contrast, clamps exactly as you would want it to.
  Number.isNaN(z) || typeof z !== "number"
    ? 1
    : Math.round(Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z)) * 100) / 100;

/** The accents, in the order the picker offers them. `dark` is the shade used
 *  on the dark palette (bright, on near-black); `light` the shade used on the
 *  light one (deeper, so white text on it still passes).
 *
 *  Every value here is measured, not chosen by eye: an accent is a background
 *  under white text AND a text colour on the page, and three of these shades
 *  were between 3.6:1 and 4.4:1 — readable as a heading, not as a line of
 *  text. `src/test/ui/contrast.test.ts` holds the whole grid to 4.5:1, so a
 *  prettier shade cannot quietly cost somebody the words. */
export const ACCENTS: {
  id: Accent;
  label: string;
  dark: string;
  light: string;
}[] = [
  { id: "ember", label: "Ember", dark: "#e07a58", light: "#ae5233" },
  { id: "ocean", label: "Ocean", dark: "#4ea3f0", light: "#1c6fc4" },
  { id: "forest", label: "Forest", dark: "#4fc07a", light: "#1a7c45" },
  { id: "grape", label: "Grape", dark: "#a982f5", light: "#6f45cc" },
  { id: "rose", label: "Rose", dark: "#f0709c", light: "#c43665" },
  { id: "steel", label: "Steel", dark: "#8fa3c4", light: "#4a5b78" },
];

type PrefsState = {
  accent: Accent;
  zoom: number;
  density: Density;
  motion: Motion;
  chatWidth: ChatWidth;
  /** Show a wall-clock time on every message, rather than on hover only. */
  timestamps: boolean;
  /** Wrap long lines inside code blocks instead of scrolling them. */
  codeWrap: boolean;
  /** Collapse the project dock to icons. */
  dockCollapsed: boolean;
  /** Collapse the section rail to icons. */
  railCollapsed: boolean;
  /** A short sound when a turn finishes while the window is not focused. */
  sounds: boolean;
};

const DEFAULTS: PrefsState = {
  accent: "ember",
  zoom: 1,
  density: "cozy",
  motion: "auto",
  chatWidth: "wide",
  timestamps: false,
  codeWrap: false,
  dockCollapsed: false,
  railCollapsed: false,
  sounds: false,
};

/** Guard a persisted enum: a value that is no longer offered falls back to the
 *  default rather than reaching CSS as a selector nothing matches. */
const oneOf = <T extends string>(vals: readonly T[], v: unknown, dflt: T): T =>
  vals.includes(v as T) ? v as T : dflt;

const ACCENT_IDS = ACCENTS.map((a) => a.id);
const DENSITIES: Density[] = ["cozy", "compact"];
const MOTIONS: Motion[] = ["auto", "full", "reduced"];
const WIDTHS: ChatWidth[] = ["narrow", "wide", "full"];

export const prefs = cell("prefs", {
  // Written out key by key rather than spread from DEFAULTS: the state shape is
  // what tooling reads to know this cell exists at all, and a spread is opaque
  // to it. The values still come from the one table, so there is nothing to
  // keep in step by hand.
  state: {
    accent: DEFAULTS.accent,
    zoom: DEFAULTS.zoom,
    density: DEFAULTS.density,
    motion: DEFAULTS.motion,
    chatWidth: DEFAULTS.chatWidth,
    timestamps: DEFAULTS.timestamps,
    codeWrap: DEFAULTS.codeWrap,
    dockCollapsed: DEFAULTS.dockCollapsed,
    railCollapsed: DEFAULTS.railCollapsed,
    sounds: DEFAULTS.sounds,
  },
  // Every field here is a deliberate choice about this window. There is
  // nothing transient to leave out.
  persist: "all",

  methods: {
    setAccent(s: PrefsState, accent: string) {
      s.accent = oneOf(ACCENT_IDS, accent, s.accent);
    },

    /** Set zoom outright — the slider, and the "100%" reset. */
    setZoom(s: PrefsState, zoom: number) {
      s.zoom = clampZoom(typeof zoom === "number" ? zoom : s.zoom);
    },

    /** Nudge zoom — Ctrl+wheel, Ctrl+plus, Ctrl+minus. Relative rather than
     *  absolute so the caller never has to read the current value first and
     *  race with another nudge. */
    zoomBy(s: PrefsState, delta: number) {
      if (typeof delta !== "number" || !Number.isFinite(delta)) return;
      s.zoom = clampZoom(s.zoom + delta);
    },

    resetZoom(s: PrefsState) {
      s.zoom = 1;
    },

    setDensity(s: PrefsState, density: string) {
      s.density = oneOf(DENSITIES, density, s.density);
    },

    setMotion(s: PrefsState, motion: string) {
      s.motion = oneOf(MOTIONS, motion, s.motion);
    },

    setChatWidth(s: PrefsState, width: string) {
      s.chatWidth = oneOf(WIDTHS, width, s.chatWidth);
    },

    setTimestamps(s: PrefsState, on: boolean) {
      s.timestamps = on === true;
    },

    setCodeWrap(s: PrefsState, on: boolean) {
      s.codeWrap = on === true;
    },

    setSounds(s: PrefsState, on: boolean) {
      s.sounds = on === true;
    },

    toggleDock(s: PrefsState) {
      s.dockCollapsed = !s.dockCollapsed;
    },

    toggleRail(s: PrefsState) {
      s.railCollapsed = !s.railCollapsed;
    },

    /** Put every appearance choice back where it started. One button, because
     *  a set of knobs with no way home is a set of knobs people stop turning. */
    reset(s: PrefsState) {
      Object.assign(s, DEFAULTS);
    },

    /**
     * Put back a snapshot taken before a reset — the undo behind the Reset
     * button.
     *
     * Every field is re-validated on the way in rather than trusted: this
     * takes an object from the control plane, and a snapshot is exactly the
     * shape somebody would hand-write to try setting a value the pickers do
     * not offer.
     */
    restore(s: PrefsState, snap: unknown) {
      if (typeof snap !== "object" || snap === null) return;
      const v = snap as Record<string, unknown>;
      s.accent = oneOf(ACCENT_IDS, v.accent, s.accent);
      s.density = oneOf(DENSITIES, v.density, s.density);
      s.motion = oneOf(MOTIONS, v.motion, s.motion);
      s.chatWidth = oneOf(WIDTHS, v.chatWidth, s.chatWidth);
      s.zoom = clampZoom(typeof v.zoom === "number" ? v.zoom : s.zoom);
      s.timestamps = v.timestamps === true;
      s.codeWrap = v.codeWrap === true;
      s.sounds = v.sounds === true;
      s.dockCollapsed = v.dockCollapsed === true;
      s.railCollapsed = v.railCollapsed === true;
    },
  },
});

/** Whether animation should run at all, resolved against the OS when the
 *  choice is `auto`. Read by the components that animate; the stylesheet
 *  answers the same question for CSS, in its own media query. */
export const animates = (): boolean => {
  if (prefs.motion === "full") return true;
  if (prefs.motion === "reduced") return false;
  if (typeof globalThis.matchMedia !== "function") return true;
  return !globalThis.matchMedia("(prefers-reduced-motion: reduce)").matches;
};
