/**
 * @module
 * The design system, as one stylesheet rendered through AIR (SSR- and
 * test-safe — no global document, no build step).
 *
 * NOTE: the stylesheet is a template literal, so a backtick anywhere inside it
 * — including in a comment — silently ends the string and breaks the module.
 *
 * Two ideas carry the whole look:
 *  1. Every colour is a token. Dark is the default; light is the same tokens
 *     re-valued, so nothing is hard-coded to one theme.
 *  2. Depth comes from *layers*, not shadows — background, panel, raised —
 *     with hairline borders. It stays legible on a laptop screen at night.
 */
import type { VNode } from "aio/air";
import { workspace } from "../cell/workspace.ts";

/** The light palette, defined once and applied from two places: an explicit
 *  `data-theme="light"` choice, and `prefers-color-scheme` when the user has
 *  chosen "system". Without the second, "system" would silently mean "dark". */
const LIGHT = `
  color-scheme: light;
  --bg: #eef1f6;
  --bg-grad: radial-gradient(1100px 620px at 78% -12%, #e7edfa 0%, transparent 62%),
             radial-gradient(760px 480px at -8% 8%, #fbeee8 0%, transparent 58%);
  --panel: #ffffff;
  --panel-2: #f5f7fa;
  --raise: #e7ebf3;
  --line: #dae0ea;
  --line-soft: #eaeef5;
  --ink: #131722;
  --ink-soft: #566076;
  --ink-dim: #838da2;
  --accent: #c65f3c;
  --accent-ink: #ffffff;
  --accent-soft: rgba(198,95,60,.12);
  --info: #2f6fd0;
  --ok: #1f8f43;
  --warn: #9a6a06;
  --danger: #cf3b30;
  --violet: #7a4fd0;
  --shadow: 0 1px 2px rgba(16,24,40,.06), 0 10px 28px -14px rgba(16,24,40,.28);
`;

const CSS = `
:root {
  color-scheme: dark;
  --bg: #0a0c11;
  --bg-grad: radial-gradient(1100px 620px at 78% -12%, #1b2436 0%, transparent 62%),
             radial-gradient(760px 480px at -8% 8%, #221a17 0%, transparent 58%);
  --panel: #11141c;
  --panel-2: #161a24;
  --raise: #1c2130;
  --line: #242a37;
  --line-soft: #1a1f2a;
  --ink: #e9edf6;
  --ink-soft: #99a3b8;
  --ink-dim: #6b7589;
  --accent: #e07a58;
  --accent-ink: #1a0f0a;
  --accent-soft: rgba(224,122,88,.14);
  --info: #63a4ff;
  --ok: #46c46b;
  --warn: #e3b341;
  --danger: #f6685e;
  --violet: #a982f5;
  --radius: 12px;
  --radius-sm: 8px;
  --font: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", sans-serif;
  --mono: ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace;
  --shadow: 0 1px 2px rgba(0,0,0,.4), 0 12px 32px -12px rgba(0,0,0,.6);
  --ease: cubic-bezier(.22,.61,.36,1);
  --rail: 248px;
  --dock: 212px;

  /* aio/ui kit reskin — the kit inherits this palette instead of fighting it */
  --aio-accent: var(--accent);
  --aio-accent-ink: var(--accent-ink);
  --aio-bg: var(--panel);
  --aio-surface: var(--panel-2);
  --aio-ink: var(--ink);
  --aio-ink-soft: var(--ink-soft);
  --aio-line: var(--line);
  --aio-danger: var(--danger);
  --aio-radius: var(--radius-sm);
  --aio-font: var(--font);
}

:root[data-theme="light"] {${LIGHT}}
@media (prefers-color-scheme: light) {
  :root:not([data-theme="dark"]) {${LIGHT}}
}

* { box-sizing: border-box; }

html, body, #root {
  height: 100%;
  margin: 0;
}

body {
  background: var(--bg);
  background-image: var(--bg-grad);
  background-attachment: fixed;
  color: var(--ink);
  font-family: var(--font);
  font-size: 14px;
  line-height: 1.55;
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
}

::selection { background: var(--accent-soft); }

::-webkit-scrollbar { width: 10px; height: 10px; }
::-webkit-scrollbar-thumb {
  background: color-mix(in srgb, var(--ink-dim) 34%, transparent);
  border-radius: 99px; border: 3px solid transparent; background-clip: padding-box;
}
::-webkit-scrollbar-thumb:hover { background: color-mix(in srgb, var(--ink-dim) 55%, transparent); background-clip: padding-box; }
::-webkit-scrollbar-track { background: transparent; }

:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 4px; }

/* ── shell ──────────────────────────────────────────────────────────────── */

/* Projects on the left, sections on the right, the work in the middle.
   The two panels answer different questions and are deliberately not
   interchangeable: the left one is *which codebase*, and it changes rarely; the
   right one is *what am I looking at*, and it changes constantly. Putting the
   frequently-clicked column next to the scrollbar, on the side the pointer
   already rests, is the whole reason for the split. */
.shell {
  display: grid;
  grid-template-columns: var(--dock) minmax(0, 1fr) var(--rail);
  height: 100vh;
}

.rail {
  display: flex; flex-direction: column; min-height: 0;
  grid-column: 3;
  border-left: 1px solid var(--line);
  background: color-mix(in srgb, var(--panel) 78%, transparent);
  backdrop-filter: blur(12px);
}
.rail__head { padding: 16px 16px 12px; }
.rail__nav { flex: 1; overflow-y: auto; padding: 4px 10px 10px; display: flex; flex-direction: column; gap: 3px; }
.rail__foot { padding: 10px; border-top: 1px solid var(--line-soft); display: grid; gap: 8px; }

/* A heading inside the rail. Fourteen destinations is too many to scan as one
   list; four short groups is not. */
.rail__group {
  font-size: 9.5px; text-transform: uppercase; letter-spacing: .1em; font-weight: 700;
  color: var(--ink-dim); padding: 12px 12px 4px;
}
.rail__group:first-child { padding-top: 2px; }

/* ── project dock ───────────────────────────────────────────────────────── */

.dock {
  grid-column: 1;
  display: flex; flex-direction: column; min-height: 0;
  border-right: 1px solid var(--line);
  background: color-mix(in srgb, var(--panel) 62%, transparent);
  backdrop-filter: blur(12px);
}
.dock__head {
  padding: 14px 12px 8px; display: flex; align-items: center; gap: 8px;
  font-size: 9.5px; text-transform: uppercase; letter-spacing: .1em; font-weight: 700;
  color: var(--ink-dim);
}
.dock__list { flex: 1; overflow-y: auto; padding: 2px 8px 8px; display: flex; flex-direction: column; gap: 3px; }
.dock__foot { padding: 8px; border-top: 1px solid var(--line-soft); display: grid; gap: 6px; }

/* One project. A tab, not a list row: the accent bar on the leading edge is
   what makes "this is the one the session runs in" readable at a glance.
   The tab is a WRAPPER — the select and the close are two real buttons, since a
   button inside a button is invalid and collapses to one ambiguous target. */
.ptab {
  position: relative; display: flex; align-items: center;
  border-radius: var(--radius-sm);
  border: 1px solid transparent; background: transparent; color: var(--ink-soft);
  transition: background .16s var(--ease), color .16s var(--ease), border-color .16s var(--ease);
}
/* The select button IS the tab: full width, with room reserved on the right for
   the overlays. It used to be a flex sibling of the state dot, which left a
   ~16px strip down the right of every tab that looked like the tab and clicked
   like nothing — the "sometimes switching does nothing" bug. */
.ptab__main {
  width: 100%; min-width: 0;
  display: grid; grid-template-columns: 26px minmax(0, 1fr);
  align-items: center; gap: 9px; text-align: left;
  padding: 8px 30px 8px 9px; border: 0; background: none; color: inherit;
  font: inherit; cursor: pointer; border-radius: inherit;
}
.ptab:hover { background: var(--panel-2); color: var(--ink); }
.ptab.active {
  background: var(--accent-soft); color: var(--ink);
  border-color: color-mix(in srgb, var(--accent) 30%, transparent);
}
.ptab.active::before {
  content: ""; position: absolute; left: -8px; top: 50%; transform: translateY(-50%);
  width: 3px; height: 22px; border-radius: 0 3px 3px 0; background: var(--accent);
}
.ptab__mark {
  width: 26px; height: 26px; border-radius: 7px; display: grid; place-items: center;
  background: var(--raise); color: var(--ink-soft);
  font-size: 11.5px; font-weight: 700; letter-spacing: -.02em; text-transform: uppercase;
}
.ptab.active .ptab__mark { background: color-mix(in srgb, var(--accent) 22%, transparent); color: var(--accent); }
.ptab__name { font-size: 12.5px; font-weight: 560; letter-spacing: -.005em; }
.ptab__sub { font-size: 10.5px; color: var(--ink-dim); display: flex; align-items: center; gap: 4px; }
/* Each project's own session, at a glance. The dock is the only place that
   reports a conversation you are NOT looking at, so this is the whole signal
   for a turn that finished — or stopped to ask something — in another project. */
/* An indicator, never a target: pointer-events none, so the dot cannot swallow
   a click meant for the tab underneath it. */
.ptab__state {
  position: absolute; right: 10px; top: 50%; transform: translateY(-50%);
  width: 7px; height: 7px; border-radius: 99px; background: transparent;
  pointer-events: none;
}
.ptab__state--ready { background: color-mix(in srgb, var(--ok) 70%, transparent); }
.ptab__state--working { background: var(--accent); animation: pulse 1.5s var(--ease) infinite; }
.ptab__state--error { background: var(--danger); }
/* Blocked on a human: it will wait forever, so it gets a ring rather than a dot. */
.ptab__state--holds {
  background: var(--warn);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--warn) 26%, transparent);
  animation: pulse 1.8s var(--ease) infinite;
}

/* End this project's session, and remove the project — revealed together on
   hover and on keyboard focus. Always reachable, never sitting there inviting a
   mis-click on a session that is working. They take the state dot's place, so
   the row does not reflow when they appear. */
.ptab__acts {
  position: absolute; right: 5px; top: 50%; transform: translateY(-50%);
  display: flex; gap: 2px;
  /* Hidden means UNCLICKABLE. opacity 0 alone still hit-tests, so the tab
     carried invisible buttons that ate clicks aimed at the project. */
  opacity: 0; pointer-events: none;
  transition: opacity .14s var(--ease);
}
.ptab__act {
  display: grid; place-items: center; width: 20px; height: 20px;
  border: 0; border-radius: 6px; padding: 0;
  background: var(--raise); color: var(--ink-dim);
  cursor: pointer;
  transition: color .14s var(--ease), background .14s var(--ease);
}
.ptab:hover .ptab__acts, .ptab:focus-within .ptab__acts {
  opacity: 1; pointer-events: auto;
}
.ptab:hover .ptab__state { opacity: 0; }
.ptab__act:hover { background: color-mix(in srgb, var(--ink) 12%, transparent); color: var(--ink); }
.ptab__act--danger:hover { background: color-mix(in srgb, var(--danger) 18%, transparent); color: var(--danger); }

/* The undo offer under the list. It is what lets removal be one click: a row
   that vanished — because you clicked, or because its folder did — is one
   button away from being back. */
/* The dock's own filter fills its column — the shared max-width is meant for a
   page header, where a search box sits beside a title. */
.dock__filter { padding: 0 8px 6px; }
.dock__filter .search, .dock__filter .input--search { width: 100%; max-width: none; min-width: 0; }

.dock__undo {
  display: flex; align-items: center; gap: 4px; min-width: 0;
  padding: 5px 6px; border-radius: var(--radius-sm);
  background: var(--panel-2); border: 1px solid var(--line);
  font-size: 11.5px; color: var(--ink-soft);
}

/* A project whose directory is gone is still listed — it is the row you go to
   in order to remove it — but it must not look startable. */
.ptab--missing .ptab__mark { background: color-mix(in srgb, var(--danger) 18%, transparent); color: var(--danger); }
.ptab--missing .ptab__name { text-decoration: line-through; text-decoration-color: color-mix(in srgb, var(--danger) 60%, transparent); }

.brand { display: flex; align-items: center; gap: 10px; }
.brand__mark {
  width: 34px; height: 34px; border-radius: 10px; display: grid; place-items: center;
  background: linear-gradient(150deg, var(--accent), color-mix(in srgb, var(--accent) 55%, var(--violet)));
  color: var(--accent-ink); box-shadow: var(--shadow); flex: none;
}
.brand__name { font-weight: 640; letter-spacing: -.01em; line-height: 1.15; }
.brand__sub { font-size: 11px; color: var(--ink-dim); letter-spacing: .02em; }

/* ── nav cards ──────────────────────────────────────────────────────────── */

.navcard {
  display: grid; grid-template-columns: 30px minmax(0,1fr) auto; align-items: center; gap: 10px;
  padding: 9px 10px; border-radius: var(--radius-sm);
  color: var(--ink-soft); text-decoration: none; border: 1px solid transparent;
  transition: background .16s var(--ease), color .16s var(--ease), border-color .16s var(--ease), transform .16s var(--ease);
}
.navcard:hover { background: var(--panel-2); color: var(--ink); }
.navcard:active { transform: scale(.985); }
.navcard.active { background: var(--accent-soft); color: var(--ink); border-color: color-mix(in srgb, var(--accent) 32%, transparent); }
.navcard.active .navcard__icon { color: var(--accent); }
.navcard__icon { display: grid; place-items: center; width: 30px; height: 30px; border-radius: 8px; background: var(--panel-2); color: var(--ink-soft); transition: color .16s var(--ease); }
.navcard.active .navcard__icon { background: color-mix(in srgb, var(--accent) 20%, transparent); }
.navcard__label { font-size: 13px; font-weight: 560; letter-spacing: -.005em; }
.navcard__hint { font-size: 11px; color: var(--ink-dim); }
/* Machine-wide, in the one place the choice is made. Same hue as the page's
   scope tag, so the two read as one idea rather than two decorations. */
.navcard__machine {
  display: inline-block; width: 5px; height: 5px; border-radius: 99px;
  margin-left: 6px; vertical-align: 2px;
  background: color-mix(in srgb, var(--violet) 75%, transparent);
}

/* A line that scopes the panels under it to one project. Not a Banner: nothing
   is wrong, and a warning tone for an ordinary fact trains people to ignore
   warnings. */
.scopebar {
  display: flex; align-items: center; gap: 9px;
  padding: 9px 13px; border-radius: var(--radius-sm);
  border: 1px solid var(--line-soft); background: var(--panel-2);
  font-size: 12.5px; color: var(--ink-soft);
}
.scopebar__icon { display: grid; place-items: center; color: var(--ink-dim); flex: none; }
.scopebar b { color: var(--ink); font-weight: 620; }

/* ── content ────────────────────────────────────────────────────────────── */

.main { display: flex; flex-direction: column; min-width: 0; min-height: 0; }
.page { flex: 1; min-height: 0; display: flex; flex-direction: column; overflow: hidden; }
.page__body { flex: 1; min-height: 0; overflow-y: auto; padding: 18px 22px 26px; }
.page__head { padding: 16px 22px 10px; display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; }
.page__title { font-size: 17px; font-weight: 640; letter-spacing: -.015em; margin: 0; }
.page__sub { font-size: 12.5px; color: var(--ink-dim); }

/* The scope tag beside a page title. Muted by default — it is a label, not a
   status — with the machine-wide one given a distinct hue, because that is the
   case a reader is most likely to get wrong. */
.scopetag {
  font-size: 10px; font-weight: 650; letter-spacing: .04em; text-transform: uppercase;
  padding: 2px 7px; border-radius: 99px; white-space: nowrap;
  border: 1px solid var(--line); background: var(--panel-2); color: var(--ink-dim);
  cursor: help;
}
.scopetag--machine {
  border-color: color-mix(in srgb, var(--violet) 40%, transparent);
  background: color-mix(in srgb, var(--violet) 12%, transparent);
  color: var(--violet);
}

/* ── status strip ───────────────────────────────────────────────────────── */

.strip {
  display: flex; align-items: stretch; gap: 2px; flex-wrap: wrap;
  padding: 8px 12px; border-bottom: 1px solid var(--line);
  background: color-mix(in srgb, var(--panel) 62%, transparent);
  backdrop-filter: blur(12px); position: sticky; top: 0; z-index: 5;
}
/* flex: none, not the default 1 1 auto: the strip WRAPS, so an item that does
   not fit belongs on the next line — shrinking it instead is how a row of
   readable values became "MODEL h… EFFORT Def… PERMISSIONS By…", which is a
   status strip that has stopped reporting status. Only the context meter grows,
   and only the project path clamps (it has its own ellipsis, and a path is read
   from its tail anyway). */
.stat { display: grid; gap: 1px; padding: 3px 11px; min-width: 0; flex: none; border-radius: var(--radius-sm); }
.stat + .stat { border-left: 1px solid var(--line-soft); }
.stat__k { font-size: 10px; text-transform: uppercase; letter-spacing: .08em; color: var(--ink-dim); font-weight: 600; }
.stat__v { font-size: 13px; font-weight: 560; display: flex; align-items: center; gap: 6px; min-width: 0; }
.stat__v code, .mono { font-family: var(--mono); font-size: 12px; }
.stat--grow { flex: 1 1 190px; min-width: 190px; }
/* One very long value (a deep project path) must not push the whole strip onto
   a second row — clamp it and let the title attribute carry the full text. */
/* The project path is the one value that SHOULD ellipse — it can be any length
   — but it still needs room to be worth reading. Without a floor its grid track
   collapsed to the width of the word "PROJECT" above it. */
.stat--clamp { min-width: 190px; max-width: 300px; flex: 0 1 auto; }
/* …and the floor has to be on the VALUE, not only on the stat: the value is a
   grid item whose track is sized from its own min-content, and an
   ellipsis-nowrap span's min-content is nothing. Without this the project path
   ellipsed at a dozen characters inside a box with room for twice that. */
.stat--clamp .stat__v { min-width: 172px; }
/* …and the switcher inside it takes the room. A flex item does not grow unless
   told to, so the trigger sat at its own content width and ellipsed inside a
   box with twice the space. */
.stat--clamp .menu, .stat--clamp .menu__btn { flex: 1 1 auto; min-width: 0; }
.stat--num .stat__v { font-variant-numeric: tabular-nums; }
.truncate { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }

/* A model name is read, not glanced at. The generic .menu__btn cap is a
   percentage, and a percentage inside a max-content flex item resolves
   against the room left in the row rather than against the text - so the name
   was cut short with empty space beside it. The wrapper carries the cap
   instead, in a font-relative unit. */
.modelmenu .menu__btn { max-width: none; }

/* ── meter ──────────────────────────────────────────────────────────────── */

.meter { height: 7px; border-radius: 99px; background: var(--raise); overflow: hidden; position: relative; }
.meter__fill { height: 100%; border-radius: 99px; transition: width .45s var(--ease), background .3s var(--ease); }
.meter__fill--ok { background: linear-gradient(90deg, var(--info), color-mix(in srgb, var(--info) 60%, var(--violet))); }
.meter__fill--warn { background: linear-gradient(90deg, var(--warn), var(--accent)); }
.meter__fill--hot { background: linear-gradient(90deg, var(--accent), var(--danger)); }

/* ── dot / badge / pill ─────────────────────────────────────────────────── */

.dot { width: 8px; height: 8px; border-radius: 99px; flex: none; background: var(--ink-dim); }
.dot--ready { background: var(--ok); }
.dot--working { background: var(--accent); animation: pulse 1.5s var(--ease) infinite; }
.dot--starting { background: var(--warn); animation: pulse 1.5s var(--ease) infinite; }
.dot--error { background: var(--danger); }
@keyframes pulse { 0%,100% { opacity: 1; transform: scale(1); } 50% { opacity: .45; transform: scale(.82); } }

.badge {
  min-width: 20px; height: 20px; padding: 0 6px; border-radius: 99px;
  display: inline-grid; place-items: center; font-size: 11px; font-weight: 640;
  font-variant-numeric: tabular-nums;
  background: var(--raise); color: var(--ink-soft);
}
.badge--live { background: var(--accent); color: var(--accent-ink); }
.badge--ok { background: color-mix(in srgb, var(--ok) 20%, transparent); color: var(--ok); }
.badge--danger { background: color-mix(in srgb, var(--danger) 20%, transparent); color: var(--danger); }

.pill {
  display: inline-flex; align-items: center; gap: 6px; padding: 3px 9px;
  border-radius: 99px; border: 1px solid var(--line); background: var(--panel-2);
  font-size: 11.5px; color: var(--ink-soft); font-weight: 550;
}
.pill--accent { border-color: color-mix(in srgb, var(--accent) 40%, transparent); color: var(--accent); background: var(--accent-soft); }
.pill--ok { border-color: color-mix(in srgb, var(--ok) 40%, transparent); color: var(--ok); background: color-mix(in srgb, var(--ok) 12%, transparent); }
.pill--danger { border-color: color-mix(in srgb, var(--danger) 40%, transparent); color: var(--danger); background: color-mix(in srgb, var(--danger) 12%, transparent); }
.pill--warn { border-color: color-mix(in srgb, var(--warn) 40%, transparent); color: var(--warn); background: color-mix(in srgb, var(--warn) 12%, transparent); }

/* ── panel ──────────────────────────────────────────────────────────────── */

.panel { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); overflow: hidden; }
.panel__head { display: flex; align-items: center; gap: 10px; padding: 11px 14px; border-bottom: 1px solid var(--line-soft); }
.panel__title { font-size: 13px; font-weight: 620; letter-spacing: -.005em; }
.panel__body { padding: 14px; }
.panel--flush .panel__body { padding: 0; }
.split { display: grid; grid-template-columns: minmax(260px, 360px) minmax(0, 1fr); gap: 14px; align-items: start; align-content: start; grid-auto-rows: max-content; }
@media (max-width: 1040px) { .split { grid-template-columns: minmax(0, 1fr); } }
/* grid-auto-rows:max-content is load-bearing, not cosmetic. These grids sit in
   a height-constrained scroll area, and .panel sets overflow:hidden — which
   makes a grid item's automatic minimum size 0, so an auto row is free to
   collapse a whole panel to its 2px border to make the rows fit the box. Pin
   every row to its content and the body scrolls instead. */
.grid { display: grid; gap: 14px; align-content: start; grid-auto-rows: max-content; }
.grid--2 { grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); }
.grid--3 { grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); }

/* ── list rows ──────────────────────────────────────────────────────────── */

.rowlist { display: flex; flex-direction: column; }
.rowitem {
  display: grid; grid-template-columns: 28px minmax(0,1fr) auto; gap: 11px; align-items: start;
  padding: 11px 14px; border-bottom: 1px solid var(--line-soft); text-align: left;
  background: none; border-left: 0; border-right: 0; border-top: 0; color: inherit; font: inherit; width: 100%;
  transition: background .14s var(--ease);
}
.rowitem:last-child { border-bottom: 0; }
button.rowitem { cursor: pointer; }
button.rowitem:hover { background: var(--panel-2); }
.rowitem.selected { background: var(--accent-soft); }
.rowitem__icon { width: 28px; height: 28px; border-radius: 8px; display: grid; place-items: center; background: var(--panel-2); color: var(--ink-soft); flex: none; }
.rowitem__title { font-size: 13px; font-weight: 560; }
.rowitem__detail { font-size: 12px; color: var(--ink-dim); font-family: var(--mono); }
.rowitem__meta { font-size: 11px; color: var(--ink-dim); font-variant-numeric: tabular-nums; text-align: right; white-space: nowrap; }

/* ── file tree ──────────────────────────────────────────────────────────── */

/* The tree scrolls independently of the preview beside it: opening a deep
   folder must not push the file you are reading off the screen. */
.treesplit { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(240px, 340px) minmax(0, 1fr); gap: 0; }
@media (max-width: 1000px) { .treesplit { grid-template-columns: minmax(0, 1fr); } .treesplit .filepane { display: none; } }
.treepane { min-height: 0; overflow-y: auto; border-right: 1px solid var(--line-soft); padding: 6px 0 14px; }
.filepane { min-height: 0; overflow: auto; padding: 12px 16px 20px; }

.treerow {
  display: grid; grid-template-columns: 16px minmax(0, 1fr) auto; align-items: center; gap: 7px;
  width: 100%; text-align: left; font: inherit; color: var(--ink-soft);
  background: none; border: 0; cursor: pointer;
  padding: 3px 12px 3px 0; line-height: 1.5;
  transition: background .12s var(--ease), color .12s var(--ease);
}
.treerow:hover { background: var(--panel-2); color: var(--ink); }
.treerow.selected { background: var(--accent-soft); color: var(--ink); }
.treerow__icon { display: grid; place-items: center; color: var(--ink-dim); }
.treerow.selected .treerow__icon, .treerow--dir .treerow__icon { color: var(--ink-soft); }
.treerow__name { font-size: 12.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.treerow--dir .treerow__name { font-weight: 560; }
.treerow__size { font-size: 10.5px; color: var(--ink-dim); font-variant-numeric: tabular-nums; white-space: nowrap; }
/* The overlay this panel exists for: a file the session read, or changed.
   Sized by content with a floor, not pinned to the icon's width: the same cell
   also carries a file size, and a fixed 15px wrapped "155 B" onto two lines. */
.treerow__touch { display: grid; place-items: center; justify-self: end; min-width: 15px; }
.treerow--read .treerow__name { color: var(--info); }
.treerow--written .treerow__name { color: var(--accent); font-weight: 600; }

/* ── code preview ───────────────────────────────────────────────────────── */

.codeview {
  margin: 0; padding: 12px 14px; overflow: auto;
  background: var(--panel-2); border: 1px solid var(--line-soft); border-radius: var(--radius-sm);
  font-family: var(--mono); font-size: 12px; line-height: 1.62; white-space: pre;
  /* tab-size matters here and nowhere else in the app: this is the only place
     that renders a file's own bytes rather than text the model produced. */
  tab-size: 2;
}

/* ── chat ───────────────────────────────────────────────────────────────── */

.chat { flex: 1; min-height: 0; overflow-y: auto; padding: 20px 22px 8px; scroll-behavior: smooth; }
.thread { max-width: 860px; margin: 0 auto; display: flex; flex-direction: column; gap: 18px; }

.msg { display: grid; grid-template-columns: 30px minmax(0,1fr); gap: 12px; animation: rise .22s var(--ease); }
@keyframes rise { from { opacity: 0; transform: translateY(6px); } }
.msg__avatar { width: 30px; height: 30px; border-radius: 9px; display: grid; place-items: center; flex: none; }
.msg__avatar--user { background: var(--raise); color: var(--ink-soft); }
.msg__avatar--assistant { background: linear-gradient(150deg, var(--accent), color-mix(in srgb, var(--accent) 50%, var(--violet))); color: var(--accent-ink); }
.msg__who { font-size: 11px; font-weight: 640; letter-spacing: .05em; text-transform: uppercase; color: var(--ink-dim); margin-bottom: 4px; }
.msg__body { min-width: 0; display: grid; gap: 9px; }
.bubble {
  background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius);
  padding: 11px 14px; white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.6;
}
.bubble--user { background: var(--panel-2); }

.think {
  border: 1px dashed var(--line); border-radius: var(--radius); padding: 9px 12px;
  color: var(--ink-dim); font-size: 12.5px; white-space: pre-wrap; overflow-wrap: anywhere;
  background: color-mix(in srgb, var(--violet) 6%, transparent);
}
.think__k { font-size: 10px; letter-spacing: .08em; text-transform: uppercase; color: var(--violet); font-weight: 640; display: flex; align-items: center; gap: 6px; margin-bottom: 4px; }

.toolchip {
  display: grid; grid-template-columns: 26px minmax(0,1fr) auto; gap: 10px; align-items: center;
  border: 1px solid var(--line); border-radius: var(--radius-sm); padding: 8px 11px;
  background: var(--panel-2); width: 100%; text-align: left; color: inherit; font: inherit; cursor: pointer;
  transition: border-color .16s var(--ease), background .16s var(--ease);
}
.toolchip:hover { border-color: color-mix(in srgb, var(--accent) 45%, transparent); }
.toolchip__icon { width: 26px; height: 26px; border-radius: 7px; display: grid; place-items: center; background: var(--raise); color: var(--ink-soft); }
.toolchip__name { font-size: 12px; font-weight: 620; }
.toolchip__title { font-size: 12px; color: var(--ink-dim); font-family: var(--mono); }

.caret { display: inline-block; width: 7px; height: 15px; margin-left: 2px; vertical-align: -2px; background: var(--accent); border-radius: 2px; animation: blink 1.05s steps(2, start) infinite; }
@keyframes blink { 50% { opacity: 0; } }

/* ── markdown ───────────────────────────────────────────────────────────── */

.md > :first-child { margin-top: 0; }
.md > :last-child { margin-bottom: 0; }
.md__p { margin: 0 0 .7em; }
.md__h { font-weight: 640; letter-spacing: -.012em; line-height: 1.3; margin: 1.1em 0 .45em; }
.md__list { margin: 0 0 .7em; padding-left: 1.35em; }
.md__list li { margin: .18em 0; }
.md__list li::marker { color: var(--ink-dim); }
.md__quote { margin: 0 0 .7em; padding: .1em 0 .1em .9em; border-left: 3px solid var(--line); color: var(--ink-soft); }
.md__hr { border: 0; border-top: 1px solid var(--line-soft); margin: 1.1em 0; }
.md__a { color: var(--accent); text-underline-offset: 2px; }
.md__code { font-family: var(--mono); font-size: .88em; background: var(--panel-2); border: 1px solid var(--line-soft); border-radius: 5px; padding: .08em .35em; }
.md__pre {
  position: relative; margin: 0 0 .7em; padding: .8em .9em; overflow-x: auto;
  background: var(--panel-2); border: 1px solid var(--line-soft); border-radius: var(--radius-sm);
  font-family: var(--mono); font-size: 12px; line-height: 1.6; white-space: pre;
}
.md__pre code { background: none; border: 0; padding: 0; font: inherit; }
/* The copy control sits over the block and fades in on hover — always reachable
   from the keyboard, never in the way of the code while reading. */
.md__copy { position: absolute; top: 6px; right: 6px; opacity: 0; transition: opacity .12s; }
.md__pre:hover .md__copy, .md__copy:focus-within { opacity: 1; }
.copy { gap: 5px; }


/* The card takes focus when it appears, so it needs a visible ring — an
   invisible focus target is worse than none. */
.perm:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.perm:focus { outline: none; }

/* Tables. The wrapper scrolls, not the page: a wide comparison table is normal
   model output and must never push the chat column sideways. */
.md__tablewrap { margin: 0 0 .7em; overflow-x: auto; max-width: 100%; }
.md__table {
  border-collapse: collapse; font-size: .94em;
  border: 1px solid var(--line-soft); border-radius: var(--radius-sm);
}
.md__table th, .md__table td {
  padding: .38em .7em; border: 1px solid var(--line-soft); vertical-align: top;
}
.md__table th { background: var(--panel-2); font-weight: 620; white-space: nowrap; }
.md__table tbody tr:nth-child(even) td { background: color-mix(in srgb, var(--panel-2) 45%, transparent); }

/* Syntax tokens. One hue per meaning, from the same palette as the rest of the
   app, so code reads as part of the UI rather than a pasted-in widget. */
.tok--comment  { color: var(--ink-dim); font-style: italic; }
.tok--string   { color: var(--ok); }
.tok--number   { color: var(--warn); }
.tok--keyword  { color: var(--violet); font-weight: 560; }
.tok--literal  { color: var(--accent); }
.tok--function { color: var(--info); }
.tok--property { color: var(--ink-soft); }
.tok--operator { color: var(--ink-dim); }
.md__lang {
  position: absolute; top: 0; right: 0; padding: 2px 8px; font-size: 10px; letter-spacing: .06em;
  text-transform: uppercase; color: var(--ink-dim); background: var(--raise);
  border-bottom-left-radius: var(--radius-sm); border-top-right-radius: var(--radius-sm);
}

/* ── permission prompt ──────────────────────────────────────────────────── */
/* The CLI is blocked while one of these is up, so it is styled to be the loudest
   thing on the page: warm border, its own surface, and a pulse on the shield. */

/* It sits between the status strip and whatever page is open, so it carries its
   own top padding — the page below keeps its own. */
.perm__queue { padding: 12px 22px 0; display: grid; gap: 10px; }
.perm {
  max-width: 860px; width: 100%; margin: 0 auto;
  border: 1px solid color-mix(in srgb, var(--warn) 45%, transparent);
  background: color-mix(in srgb, var(--warn) 7%, var(--panel));
  border-radius: var(--radius); box-shadow: var(--shadow); overflow: hidden;
}
.perm__head {
  display: flex; align-items: center; gap: 8px; padding: 9px 13px;
  background: color-mix(in srgb, var(--warn) 12%, transparent);
  border-bottom: 1px solid color-mix(in srgb, var(--warn) 25%, transparent);
}
.perm__icon { display: inline-flex; color: var(--warn); animation: permpulse 1.8s var(--ease) infinite; }
@keyframes permpulse { 0%,100% { opacity: 1; } 50% { opacity: .45; } }
.perm__title { font-size: 13px; font-weight: 640; }
.perm__wait { font-size: 11px; color: var(--ink-soft); }
.perm__body { padding: 12px 13px; display: grid; gap: 10px; }
.perm__what { display: grid; gap: 4px; }
.perm__tool { display: inline-flex; align-items: center; gap: 7px; font-size: 13.5px; font-weight: 600; }
.perm__desc { font-size: 12.5px; color: var(--ink-soft); word-break: break-word; }
.perm__why {
  display: flex; align-items: flex-start; gap: 7px; font-size: 12px; color: var(--warn);
  background: color-mix(in srgb, var(--warn) 10%, transparent);
  border-radius: var(--radius-sm); padding: 7px 9px;
}
.perm__toggle { justify-self: start; padding-left: 0; }
.perm__actions { display: flex; align-items: center; gap: 8px; }
.perm__deny { display: grid; gap: 8px; }
.perm__hint { font-size: 11.5px; color: var(--ink-dim); }
/* The "/" marker inside a filter box. Right-aligned, and a label rather than a
   target — clicking it should reach the input underneath. */
.search__key {
  position: absolute; right: 7px; top: 50%; transform: translateY(-50%);
  pointer-events: none; opacity: .6;
}
/* The command, exactly as it would run. Wrapped rather than scrolled: a
   decision about a command you can only see half of is not a decision. */
.perm__cmd {
  margin: 0; padding: 9px 11px; border-radius: var(--radius-sm);
  background: var(--panel-2); border: 1px solid var(--line);
  font-family: var(--mono); font-size: 12px; line-height: 1.55;
  white-space: pre-wrap; word-break: break-word; max-height: 34vh; overflow-y: auto;
}

/* ── composer ───────────────────────────────────────────────────────────── */

.composer { padding: 10px 22px 18px; }
.composer__inner {
  max-width: 860px; margin: 0 auto;
  border: 1px solid var(--line); border-radius: var(--radius); background: var(--panel);
  box-shadow: var(--shadow); transition: border-color .16s var(--ease), box-shadow .16s var(--ease);
}
.composer__inner:focus-within { border-color: color-mix(in srgb, var(--accent) 55%, transparent); }
.composer textarea {
  width: 100%; border: 0; background: none; color: var(--ink); font: inherit; line-height: 1.6;
  padding: 12px 14px 4px; resize: none; outline: none; max-height: 260px; min-height: 52px;
}
.composer textarea::placeholder { color: var(--ink-dim); }
.composer__bar { display: flex; align-items: center; gap: 8px; padding: 6px 8px 8px 14px; }
.composer__hint { flex: 1; font-size: 11px; color: var(--ink-dim); }
.kbd { font-family: var(--mono); font-size: 10.5px; border: 1px solid var(--line); border-bottom-width: 2px; border-radius: 5px; padding: 1px 5px; color: var(--ink-soft); }

/* ── buttons ────────────────────────────────────────────────────────────── */

.btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 7px;
  font: inherit; font-size: 13px; font-weight: 560; line-height: 1;
  padding: 8px 13px; border-radius: var(--radius-sm); cursor: pointer;
  border: 1px solid var(--line); background: var(--panel-2); color: var(--ink);
  transition: background .15s var(--ease), border-color .15s var(--ease), transform .12s var(--ease), opacity .15s var(--ease);
  white-space: nowrap;
}
.btn:hover:not(:disabled) { background: var(--raise); border-color: color-mix(in srgb, var(--ink-dim) 40%, transparent); }
.btn:active:not(:disabled) { transform: scale(.97); }
.btn:disabled { opacity: .45; cursor: not-allowed; }
.btn--primary { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); font-weight: 620; }
.btn--primary:hover:not(:disabled) { filter: brightness(1.08); background: var(--accent); border-color: var(--accent); }
.btn--danger { color: var(--danger); border-color: color-mix(in srgb, var(--danger) 35%, transparent); background: color-mix(in srgb, var(--danger) 10%, transparent); }
.btn--danger:hover:not(:disabled) { background: color-mix(in srgb, var(--danger) 18%, transparent); border-color: var(--danger); }
.btn--ghost { background: transparent; border-color: transparent; color: var(--ink-soft); }
.btn--ghost:hover:not(:disabled) { background: var(--panel-2); color: var(--ink); }
.btn--sm { padding: 5px 9px; font-size: 12px; }
.btn--icon { padding: 7px; }

/* ── inputs ─────────────────────────────────────────────────────────────── */

.input {
  width: 100%; font: inherit; font-size: 13px; color: var(--ink);
  background: var(--panel-2); border: 1px solid var(--line); border-radius: var(--radius-sm);
  padding: 8px 11px; outline: none; transition: border-color .15s var(--ease), box-shadow .15s var(--ease);
}
.input:focus { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
.input::placeholder { color: var(--ink-dim); }

/* Filter box. Sits in a page header beside the segmented control, so it is
   sized to that row rather than to a form.

   Declared *after* the .input rule, deliberately: both are one class deep, so
   source order decides, and defined earlier its left padding lost — leaving the
   magnifier sitting on top of the placeholder text. */
.search { position: relative; display: inline-flex; align-items: center; }
.search__icon {
  position: absolute; left: 8px; display: inline-flex; pointer-events: none;
  color: var(--ink-dim);
}
.input--search {
  padding-left: 27px; padding-right: 24px; min-width: 150px; max-width: 240px;
  height: 28px; font-size: 12px;
}
.input--search::-webkit-search-cancel-button { filter: invert(.5); }
.field { display: grid; gap: 6px; }
.field__label { font-size: 12px; font-weight: 600; color: var(--ink-soft); }
.field__hint { font-size: 11.5px; color: var(--ink-dim); }

.choices { display: grid; gap: 7px; }
.choice {
  display: grid; grid-template-columns: minmax(0,1fr) auto; align-items: center; gap: 10px;
  padding: 9px 12px; border-radius: var(--radius-sm); border: 1px solid var(--line);
  background: var(--panel-2); cursor: pointer; text-align: left; color: inherit; font: inherit;
  transition: border-color .15s var(--ease), background .15s var(--ease);
}
.choice:hover { border-color: color-mix(in srgb, var(--accent) 40%, transparent); }
.choice.selected { border-color: var(--accent); background: var(--accent-soft); }
.choice__label { font-size: 13px; font-weight: 560; }
/* One line, always. A hint is a subtitle, and a long one — a project path
   outside the home directory is the usual culprit — wrapped a row to four lines
   and pushed everything under it off the panel. */
.choice__hint {
  display: block; font-size: 11.5px; color: var(--ink-dim);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.choice__tick { color: var(--accent); }

.seg { display: inline-flex; padding: 3px; gap: 2px; background: var(--panel-2); border: 1px solid var(--line); border-radius: 99px; }
.seg__btn { border: 0; background: none; color: var(--ink-soft); font: inherit; font-size: 12px; font-weight: 560; padding: 4px 12px; border-radius: 99px; cursor: pointer; transition: background .15s var(--ease), color .15s var(--ease); }
.seg__btn:hover { color: var(--ink); }
.seg__btn.selected { background: var(--raise); color: var(--ink); }

/* Menu — the switcher behind every value the status strip names. The popover
   is positioned, not portalled: it hangs off its own trigger, so it follows a
   strip that reflows instead of pointing at where the button used to be. */
.menu { position: relative; display: inline-flex; min-width: 0; }
.menu__btn {
  display: inline-flex; align-items: center; gap: 5px; min-width: 0; max-width: 100%;
  border: 1px solid transparent; background: none; color: inherit; font: inherit;
  white-space: nowrap;
  padding: 2px 6px; margin: -2px -6px; border-radius: var(--radius-sm); cursor: pointer;
  transition: background .13s var(--ease), border-color .13s var(--ease);
}
.menu__btn:hover:not(:disabled) { background: var(--panel-2); border-color: var(--line); }
.menu__btn.open { background: var(--panel-2); border-color: var(--line); }
.menu__btn:disabled { cursor: default; opacity: .55; }
.menu__btn svg { flex: none; color: var(--ink-dim); transform: rotate(90deg); }
/* A trigger only ellipses when its own content asks to. Left to the generic
   truncate rule, the grid track a .stat gives its value collapses to the
   min-content of a nowrap-ellipsis span — which is nothing — and every value in
   the strip rendered as one letter and a dot. */
/* The value row is never narrower than the value. A .stat is a grid, and its
   auto track was resolving against the LABEL — so "Bypass" rendered as "By…"
   under a full-width "PERMISSIONS". Only the two stats that are meant to be
   elastic are exempt: the project path (which clamps and ellipses on purpose)
   and the context meter (which grows). */
.stat:not(.stat--clamp):not(.stat--grow) .stat__v { min-width: max-content; }
.menu__pop {
  position: absolute; top: calc(100% + 6px); left: 0; z-index: 40;
  min-width: 232px; max-width: 340px; max-height: 62vh; overflow-y: auto;
  padding: 5px; display: flex; flex-direction: column; gap: 1px;
  background: var(--panel); border: 1px solid var(--line);
  border-radius: var(--radius); box-shadow: var(--shadow);
}
.menu__pop--right { left: auto; right: 0; }
.menu__item {
  display: flex; align-items: flex-start; gap: 7px; width: 100%; min-width: 0;
  padding: 6px 8px; border: 0; border-radius: var(--radius-sm);
  background: none; color: var(--ink-soft); font: inherit; font-size: 12.5px;
  line-height: 1.45; text-align: left; cursor: pointer;
}
.menu__item:hover { background: var(--panel-2); color: var(--ink); }
.menu__item.selected { color: var(--ink); }
.menu__item--danger { color: var(--danger); }
.menu__item--warn { color: var(--warn); }
.menu__tick { flex: none; width: 13px; color: var(--accent); padding-top: 1px; }
/* Inline, like every other label in this app that is followed by a <br>. As a
   block it produced its own line break AND kept the <br>, so every option in
   an open menu was double-spaced and a six-option list filled half the window. */
.menu__label { font-weight: 560; }
.menu__hint { font-size: 11.5px; color: var(--ink-dim); font-weight: 500; }
.menu__foot {
  margin-top: 3px; padding: 7px 8px 3px; border-top: 1px solid var(--line-soft);
  font-size: 11.5px; color: var(--ink-dim);
}

/* ── misc ───────────────────────────────────────────────────────────────── */

.empty { display: grid; place-items: center; gap: 10px; padding: 46px 20px; text-align: center; color: var(--ink-dim); }
.empty__icon { width: 46px; height: 46px; border-radius: 14px; display: grid; place-items: center; background: var(--panel-2); color: var(--ink-dim); }
.empty__title { font-size: 14px; font-weight: 600; color: var(--ink-soft); }
.empty__hint { font-size: 12.5px; max-width: 42ch; }

.banner {
  display: flex; align-items: flex-start; gap: 10px; padding: 10px 13px; border-radius: var(--radius-sm);
  border: 1px solid color-mix(in srgb, var(--danger) 40%, transparent);
  background: color-mix(in srgb, var(--danger) 11%, transparent); color: var(--ink);
  font-size: 12.5px; margin-bottom: 14px;
}
.banner__icon { color: var(--danger); flex: none; margin-top: 1px; }
.banner--warn { border-color: color-mix(in srgb, var(--warn) 40%, transparent); background: color-mix(in srgb, var(--warn) 11%, transparent); }
.banner--warn .banner__icon { color: var(--warn); }

.code {
  font-family: var(--mono); font-size: 11.5px; line-height: 1.6; white-space: pre-wrap;
  overflow-wrap: anywhere; background: var(--panel-2); border: 1px solid var(--line-soft);
  border-radius: var(--radius-sm); padding: 10px 12px; max-height: 320px; overflow: auto; color: var(--ink-soft);
}
.tags { display: flex; flex-wrap: wrap; gap: 5px; }
.tag { font-family: var(--mono); font-size: 11px; padding: 2px 7px; border-radius: 6px; background: var(--panel-2); border: 1px solid var(--line-soft); color: var(--ink-soft); }
.kv { display: grid; grid-template-columns: minmax(90px, auto) minmax(0,1fr); gap: 6px 14px; font-size: 12.5px; }
.kv__k { color: var(--ink-dim); }
.kv__v { overflow-wrap: anywhere; }
.divider { height: 1px; background: var(--line-soft); margin: 14px 0; }

/* Open-the-file and copy-the-path, on any row that names one. Quiet until the
   row is hovered or something in it has focus: the actions are the answer to a
   question you only ask after reading the row. */
.pathacts { display: inline-flex; gap: 2px; opacity: .28; transition: opacity .14s var(--ease); }
.rowitem:hover .pathacts, .pathacts:hover, .pathacts:focus-within { opacity: 1; }

@media (prefers-reduced-motion: reduce) {
  * { animation-duration: .01ms !important; animation-iteration-count: 1 !important; transition-duration: .01ms !important; scroll-behavior: auto !important; }
}

/* Two collapse steps, because there are now two panels to give up. The dock
   goes to icons first — a project is recognisable from its initial and its
   colour — and the rail follows only when the window is genuinely small. */
@media (max-width: 1180px) {
  :root { --dock: 56px; }
  .dock__head, .dock__foot { padding-inline: 6px; }
  .dock__head span, .ptab__text { display: none; }
  /* The state dot survives the collapse — it is the one thing a 56px column
     still has room to say, and the only warning that another project is
     blocked. It overlaps the initials rather than taking a column of its own. */
  .ptab__main { grid-template-columns: 26px; justify-content: center; padding-right: 9px; }
  .ptab__state { top: 6px; right: 6px; transform: none; }
  /* No room for two 20px buttons beside a 26px badge — the collapsed dock is a
     switcher, and removal lives in Settings at this width. */
  .ptab__acts { display: none; }
  .dock__undo span:first-child { display: none; }
}

@media (max-width: 900px) {
  :root { --rail: 68px; }
  .rail__head, .rail__foot { padding-inline: 8px; }
  .brand__text, .navcard__label, .navcard__hint, .rail__foot .wide { display: none; }
  .navcard { grid-template-columns: 30px; justify-content: center; }
  .rail__group { text-align: center; padding-inline: 0; letter-spacing: .04em; }
  .chat, .composer { padding-inline: 14px; }
  .page__body, .page__head { padding-inline: 14px; }
}
`.trim();

/**
 * Renders the stylesheet and keeps `data-theme` in sync with the user's choice.
 * "system" removes the attribute so `prefers-color-scheme` decides — a real
 * third state, not a coin flip made once at boot.
 */
export function Theme(): VNode {
  const mode = workspace.theme;
  const root = typeof document === "undefined"
    ? null
    : document.documentElement;
  if (root) {
    if (mode === "system") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", mode);
  }
  return <style data-cc-theme="">{CSS}</style>;
}
