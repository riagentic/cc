/**
 * Colour is measured here, not judged by eye.
 *
 * An accent is two jobs at once: a solid background under `--accent-ink`
 * (primary buttons, live badges, filled pills) and a text colour on the page
 * itself (the active project mark, an accent pill's label, a link). A shade can
 * look right and still fail one of them, and nothing on screen says so — the
 * words just get harder to read for whoever has the worst screen or the oldest
 * eyes. Three of the six light accents sat between 3.6:1 and 4.4:1, and the
 * quiet text tier was at 2.95:1 on the light page: grey on white.
 *
 * The numbers are WCAG 2.1 AA for body text, 4.5:1. Large text is allowed 3:1,
 * but these land on 11px badge labels and timestamps, so the whole grid is held
 * to the stricter one.
 *
 * Every value is read out of the stylesheet and the accent table themselves —
 * nothing here is a copy of a colour, so editing the palette moves this test
 * with it rather than leaving it certifying last month's values.
 *
 * The framework runs its own colour walk over the rendered DOM in dev, and it
 * is the one that found the quiet tier. This test exists beside it because that
 * walk only measures what is currently on screen, and under the test DOM it
 * reads custom properties with the wrong cascade (the last declaration in the
 * sheet, whatever the selectors say) and reports pairs the app cannot paint.
 */
import { assert } from "@std/assert";
import { ACCENTS } from "../../cell/prefs.ts";
import { themeCss } from "../../ui/theme.tsx";

/** WCAG relative luminance of an `#rrggbb`. */
const luminance = (hex: string): number => {
  const n = parseInt(hex.slice(1), 16);
  const chan = (v: number): number => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * chan((n >> 16) & 255) +
    0.7152 * chan((n >> 8) & 255) +
    0.0722 * chan(n & 255);
};

/** WCAG contrast ratio between two opaque colours. */
const ratio = (a: string, b: string): number => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (hi + 0.05) / (lo + 0.05);
};

const CSS = themeCss();

/** The tokens of one palette, read from the sheet at `anchor`. Only plain hex
 *  values are taken: a `color-mix` is not a colour anyone can measure without a
 *  browser, and every token this test needs is written out in full. */
const palette = (anchor: string): Record<string, string> => {
  const from = CSS.indexOf(anchor);
  assert(from >= 0, `the sheet no longer contains ${anchor}`);
  const to = CSS.indexOf("}", from);
  const block = CSS.slice(from, to < 0 ? undefined : to);
  const out: Record<string, string> = {};
  for (
    const [, name, hex] of block.matchAll(/(--[a-z0-9-]+):\s*(#[0-9a-f]{6})/g)
  ) {
    out[name] = hex;
  }
  return out;
};

/** The three palettes the app can paint, and which accent column each uses.
 *  High contrast takes the dark shades: its `data-accent` rules are the
 *  unprefixed ones, so an accent choice reaches it unchanged. */
const PALETTES = [
  { name: "dark", anchor: "color-scheme: dark;", accent: "dark" },
  { name: "light", anchor: "color-scheme: light;", accent: "light" },
  {
    name: "contrast",
    anchor: ':root[data-theme="contrast"] {',
    accent: "dark",
  },
] as const;

const GROUNDS = ["--bg", "--panel", "--panel-2"];
const INKS = ["--ink", "--ink-soft", "--ink-dim"];
/** The status colours. Each one is a text colour somewhere — a failed step's
 *  title, a warning banner's words, the green on a finished run — so each one
 *  is held to the same number as any other text. */
const TONES = ["--info", "--ok", "--warn", "--danger", "--violet"];
const AA = 4.5;

Deno.test("every accent is readable in every palette", () => {
  const misses: string[] = [];
  for (const p of PALETTES) {
    const tokens = palette(p.anchor);
    for (const a of ACCENTS) {
      const accent = p.accent === "dark" ? a.dark : a.light;
      // The accent as a background, with this palette's ink on top of it.
      const onAccent = ratio(tokens["--accent-ink"], accent);
      if (onAccent < AA) {
        misses.push(
          `${p.name}/${a.id}: --accent-ink ${
            tokens["--accent-ink"]
          } on ${accent} is ${onAccent.toFixed(2)}:1`,
        );
      }
      // The accent as text, on each surface the app puts it on.
      for (const ground of GROUNDS) {
        const r = ratio(accent, tokens[ground]);
        if (r < AA) {
          misses.push(
            `${p.name}/${a.id}: ${accent} on ${ground} ${tokens[ground]} is ${
              r.toFixed(2)
            }:1`,
          );
        }
      }
    }
  }
  assert(
    misses.length === 0,
    `${misses.length} colour pair(s) under ${AA}:1 for body text:\n  ` +
      misses.join("\n  "),
  );
});

Deno.test("every tier of text is readable on every surface", () => {
  // All three tiers, not just the loud one. `--ink-dim` is the quiet tier — a
  // timestamp, a path under a title, a detail line — and it was the one that
  // failed. Quiet is a style; unreadable is a defect, and the tier carrying the
  // least important words still carries most of the words on a busy page.
  const misses: string[] = [];
  for (const p of PALETTES) {
    const tokens = palette(p.anchor);
    for (const ground of GROUNDS) {
      for (const ink of [...INKS, ...TONES]) {
        const r = ratio(tokens[ink], tokens[ground]);
        if (r < AA) {
          misses.push(
            `${p.name}: ${ink} ${tokens[ink]} on ${ground} ${
              tokens[ground]
            } is ${r.toFixed(2)}:1`,
          );
        }
      }
    }
  }
  assert(misses.length === 0, `unreadable text:\n  ${misses.join("\n  ")}`);
});

Deno.test("the palettes are read, not assumed", () => {
  // If a rename ever empties this parse, the two tests above would pass by
  // measuring nothing at all.
  for (const p of PALETTES) {
    const tokens = palette(p.anchor);
    for (const name of [...GROUNDS, ...INKS, ...TONES, "--accent-ink"]) {
      assert(
        /^#[0-9a-f]{6}$/.test(tokens[name] ?? ""),
        `${p.name} palette has no plain ${name} (got ${tokens[name]})`,
      );
    }
  }
});
