/**
 * The stylesheet parses.
 *
 * This sounds like a test of the browser rather than of the app, and it is
 * not. The sheet is one template literal assembled from several pieces, and
 * the failure mode is silent: a stray brace makes the CSSOM discard the rule
 * *after* it, which surfaces weeks later as a single control quietly ignoring
 * its own margin. It happened — a `}` left behind when a media query was
 * replaced ate the rule that spaces a message's timestamp from its name.
 *
 * A brace balance check catches it in a millisecond and needs no DOM.
 */
import { assert, assertEquals } from "@std/assert";
import { themeCss } from "../../ui/theme.tsx";

/** The sheet with comments removed — a brace inside a comment is not a brace. */
const bare = (): string => themeCss().replace(/\/\*[\s\S]*?\*\//g, "");

Deno.test("the stylesheet's braces balance, and none closes nothing", () => {
  const css = bare();
  let depth = 0;
  let line = 1;
  for (let i = 0; i < css.length; i++) {
    const c = css[i];
    if (c === "\n") line++;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      assert(depth >= 0, `a closing brace at line ${line} closes nothing`);
    }
  }
  assertEquals(depth, 0, `${depth} block(s) left open`);
});

Deno.test("every rule this app relies on survives parsing", () => {
  const css = bare();
  // A representative selector from each area that has been broken by an
  // unbalanced brace at some point, or would be hard to notice if it were.
  for (
    const needle of [
      ".msg__time {",
      ".msg__acts {",
      ".diff__line--add",
      ".toast {",
      ".pal__row {",
      ".gauge {",
      ".jump {",
      ".find {",
      ".toggle {",
      ".daymark {",
      ".absent {",
      ".pick__row {",
    ]
  ) {
    assert(css.includes(needle), `the sheet lost ${needle}`);
  }
});

Deno.test("the sheet declares every palette and accent", () => {
  const css = themeCss();
  for (const theme of ["light", "contrast"]) {
    assert(
      css.includes(`:root[data-theme="${theme}"]`),
      `no ${theme} palette`,
    );
  }
  for (const accent of ["ember", "ocean", "forest", "grape", "rose", "steel"]) {
    assert(
      css.includes(`[data-accent="${accent}"]`),
      `no ${accent} accent`,
    );
  }
  // An explicit palette must not be overruled by the OS preference. Every
  // "the user has not said dark" selector has to exclude the explicit
  // palettes too — without that, choosing High contrast on a machine set to
  // light mode silently repainted it light.
  const unguarded = css.match(
    /:root:not\(\[data-theme="dark"\]\)(?!:not\(\[data-theme="contrast"\]\))/g,
  ) ?? [];
  assertEquals(
    unguarded.length,
    0,
    "a light-mode selector that would also claim an explicit palette",
  );
});
