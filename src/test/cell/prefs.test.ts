/**
 * Preferences — the appearance choices, and the guards that keep a bad value
 * from reaching CSS.
 *
 * Two things are worth pinning here. Every setter takes `unknown` from the
 * control plane, so a value that is not one of the offered ones must leave the
 * stored choice alone rather than write a selector nothing matches. And zoom
 * must stay inside its range whichever path changes it — a mis-scroll that
 * leaves the window at 12% would put the control that fixes it off screen.
 */
import { assert, assertEquals } from "@std/assert";
import { bootCells } from "aio/testing";
import {
  ACCENTS,
  clampZoom,
  prefs,
  ZOOM_MAX,
  ZOOM_MIN,
} from "../../cell/prefs.ts";

async function fresh() {
  const h = await bootCells([prefs]);
  prefs.reset();
  return h;
}

Deno.test("prefs — an accent that is not offered is ignored", async () => {
  const h = await fresh();
  try {
    prefs.setAccent("ocean");
    assertEquals(prefs.accent, "ocean");
    prefs.setAccent("chartreuse");
    assertEquals(prefs.accent, "ocean", "a made-up accent must not be stored");
    prefs.setAccent(undefined as unknown as string);
    assertEquals(prefs.accent, "ocean", "and neither must nothing at all");
  } finally {
    h.dispose();
  }
});

Deno.test("prefs — every offered accent is settable", async () => {
  const h = await fresh();
  try {
    for (const a of ACCENTS) {
      prefs.setAccent(a.id);
      assertEquals(prefs.accent, a.id);
    }
  } finally {
    h.dispose();
  }
});

Deno.test("prefs — zoom is clamped from both directions", async () => {
  const h = await fresh();
  try {
    prefs.setZoom(99);
    assertEquals(prefs.zoom, ZOOM_MAX);
    prefs.setZoom(0.01);
    assertEquals(prefs.zoom, ZOOM_MIN);
    prefs.resetZoom();
    assertEquals(prefs.zoom, 1);

    // A hundred notches down cannot go below the floor, and a hundred back up
    // lands exactly on the ceiling — no accumulated float drift either way.
    for (let i = 0; i < 100; i++) prefs.zoomBy(-0.1);
    assertEquals(prefs.zoom, ZOOM_MIN);
    for (let i = 0; i < 100; i++) prefs.zoomBy(0.1);
    assertEquals(prefs.zoom, ZOOM_MAX);
  } finally {
    h.dispose();
  }
});

Deno.test("prefs — a junk zoom leaves the current one alone", async () => {
  const h = await fresh();
  try {
    prefs.setZoom(1.2);
    prefs.zoomBy(NaN);
    assertEquals(prefs.zoom, 1.2);
    prefs.zoomBy("big" as unknown as number);
    assertEquals(prefs.zoom, 1.2);
    prefs.setZoom(Infinity);
    assertEquals(prefs.zoom, ZOOM_MAX, "infinity is a number, and clamps");
  } finally {
    h.dispose();
  }
});

Deno.test("clampZoom rounds to whole percents", () => {
  // 1.0999999999999999 is what nine additions of 0.1 actually produce, and it
  // would reach the DOM as a zoom of 1.0999999999999999.
  assertEquals(clampZoom(1.0999999999999999), 1.1);
  assertEquals(clampZoom(1.2349), 1.23);
  assertEquals(clampZoom(NaN), 1);
});

Deno.test("prefs — reset puts every choice back", async () => {
  const h = await fresh();
  try {
    prefs.setAccent("grape");
    prefs.setDensity("compact");
    prefs.setChatWidth("full");
    prefs.setMotion("reduced");
    prefs.setTimestamps(true);
    prefs.setCodeWrap(true);
    prefs.setSounds(true);
    prefs.setZoom(1.5);
    prefs.toggleDock();
    prefs.toggleRail();

    prefs.reset();

    assertEquals(prefs.accent, "ember");
    assertEquals(prefs.density, "cozy");
    assertEquals(prefs.chatWidth, "wide");
    assertEquals(prefs.motion, "auto");
    assertEquals(prefs.timestamps, false);
    assertEquals(prefs.codeWrap, false);
    assertEquals(prefs.sounds, false);
    assertEquals(prefs.zoom, 1);
    assertEquals(prefs.dockCollapsed, false);
    assertEquals(prefs.railCollapsed, false);
  } finally {
    h.dispose();
  }
});

Deno.test("prefs — the booleans only ever store booleans", async () => {
  const h = await fresh();
  try {
    // The control plane can hand a method anything. "false" the string is the
    // classic one: truthy, and the opposite of what it says.
    prefs.setTimestamps("false" as unknown as boolean);
    assertEquals(prefs.timestamps, false);
    prefs.setCodeWrap(1 as unknown as boolean);
    assertEquals(prefs.codeWrap, false);
    prefs.setSounds(true);
    assert(prefs.sounds === true);
  } finally {
    h.dispose();
  }
});
