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
  --rail: 260px;

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

.shell { display: grid; grid-template-columns: var(--rail) minmax(0, 1fr); height: 100vh; }

.rail {
  display: flex; flex-direction: column; min-height: 0;
  border-right: 1px solid var(--line);
  background: color-mix(in srgb, var(--panel) 78%, transparent);
  backdrop-filter: blur(12px);
}
.rail__head { padding: 16px 16px 12px; }
.rail__nav { flex: 1; overflow-y: auto; padding: 4px 10px 10px; display: flex; flex-direction: column; gap: 4px; }
.rail__foot { padding: 10px; border-top: 1px solid var(--line-soft); display: grid; gap: 8px; }

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

/* ── content ────────────────────────────────────────────────────────────── */

.main { display: flex; flex-direction: column; min-width: 0; min-height: 0; }
.page { flex: 1; min-height: 0; display: flex; flex-direction: column; overflow: hidden; }
.page__body { flex: 1; min-height: 0; overflow-y: auto; padding: 18px 22px 26px; }
.page__head { padding: 16px 22px 10px; display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; }
.page__title { font-size: 17px; font-weight: 640; letter-spacing: -.015em; margin: 0; }
.page__sub { font-size: 12.5px; color: var(--ink-dim); }

/* ── status strip ───────────────────────────────────────────────────────── */

.strip {
  display: flex; align-items: stretch; gap: 2px; flex-wrap: wrap;
  padding: 8px 12px; border-bottom: 1px solid var(--line);
  background: color-mix(in srgb, var(--panel) 62%, transparent);
  backdrop-filter: blur(12px); position: sticky; top: 0; z-index: 5;
}
.stat { display: grid; gap: 1px; padding: 4px 12px; min-width: 0; border-radius: var(--radius-sm); }
.stat + .stat { border-left: 1px solid var(--line-soft); }
.stat__k { font-size: 10px; text-transform: uppercase; letter-spacing: .08em; color: var(--ink-dim); font-weight: 600; }
.stat__v { font-size: 13px; font-weight: 560; display: flex; align-items: center; gap: 6px; min-width: 0; }
.stat__v code, .mono { font-family: var(--mono); font-size: 12px; }
.stat--grow { flex: 1; min-width: 190px; }
/* One very long value (a deep project path) must not push the whole strip onto
   a second row — clamp it and let the title attribute carry the full text. */
.stat--clamp { max-width: 300px; }
.stat--num .stat__v { font-variant-numeric: tabular-nums; }
.truncate { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }

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
.choice__hint { font-size: 11.5px; color: var(--ink-dim); }
.choice__tick { color: var(--accent); }

.seg { display: inline-flex; padding: 3px; gap: 2px; background: var(--panel-2); border: 1px solid var(--line); border-radius: 99px; }
.seg__btn { border: 0; background: none; color: var(--ink-soft); font: inherit; font-size: 12px; font-weight: 560; padding: 4px 12px; border-radius: 99px; cursor: pointer; transition: background .15s var(--ease), color .15s var(--ease); }
.seg__btn:hover { color: var(--ink); }
.seg__btn.selected { background: var(--raise); color: var(--ink); }

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

@media (prefers-reduced-motion: reduce) {
  * { animation-duration: .01ms !important; animation-iteration-count: 1 !important; transition-duration: .01ms !important; scroll-behavior: auto !important; }
}

@media (max-width: 880px) {
  :root { --rail: 68px; }
  .rail__head, .rail__foot { padding-inline: 8px; }
  .brand__text, .navcard__label, .navcard__hint, .rail__foot .wide { display: none; }
  .navcard { grid-template-columns: 30px; justify-content: center; }
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
