// Entry — wiring only. Cells self-register on import; appId/version/baseDir are
// inferred from deno.json and this file's location.
//
// `cc` is a desktop app: `deno task dev` opens the Electron window (deno.json
// `"client": "electron"`). `--client=browser` and `--client=server-only` are
// there for development and headless driving via `deno task am`.
import "./cell/workspace.ts";
import "./cell/prefs.ts";
import "./cell/browse.ts";
import "./cell/metrics.ts";
import "./cell/session.ts";
import "./cell/jobs.ts";
import "./cell/loops.ts";
import "./cell/tree.ts";
import "./cell/catalog.ts";
import "./cell/storage.ts";
import "./cell/local.ts";
import { aio } from "aio";
import { REDACTED_ACTIONS } from "./cell/redact.ts";

await aio.run({
  // `ui:` sets the Electron window (dep/aio/docs/clients/electron.md — the
  // server embeds it as <meta aio:width/height> and the thin client reads it;
  // bounds are then remembered in window-state.json).
  // The window opens wide enough for the real layout. Below ~880px the rail
  // collapses to icons, which is the right behaviour on a narrow window but the
  // wrong first impression for a desktop app — Electron's 800×600 default
  // landed exactly there. Bounds are remembered across runs after this.
  ui: { title: "Claude Control", width: 1440, height: 920 },

  // Restrict scripts so Electron stops warning that `unsafe-eval` is enabled —
  // and, more to the point, so an `<script src=//evil>` injected through the
  // model-generated markdown this renderer displays cannot load. aio's
  // "strict" keeps `'unsafe-inline'` for the inlined theme stylesheet, the
  // module bootstrap and this app's own inline styles, and drops only
  // `unsafe-eval`; the markdown renderer emits no <img> and nothing here loads
  // off-origin, so `default-src 'self'` costs the app nothing
  // (dep/aio/docs/clients/electron.md — "csp: strict").
  security: { csp: "strict" },

  // The conversation is private, and it is only ever meant to live in memory
  // (session never persists; local persists only its per-project config, never
  // the transcript). But `deno task dev` runs from
  // source, where aio's diagnostics default to on, and the action log +
  // checkpoint would otherwise write verbatim prompts and model output to
  // `~/.claude-control/logs/`. `redactActions` keeps those actions' type,
  // sequence and touched-paths while withholding their values — and, because
  // the checkpoint holds state rather than actions, it withholds the whole
  // slice of every listed cell (dep/aio/docs/persistence/where-files-live.md).
  redactActions: REDACTED_ACTIONS,
});
