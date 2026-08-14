// Entry — wiring only. Cells self-register on import; appId/version/baseDir are
// inferred from deno.json and this file's location.
//
// `cc` is a desktop app: `deno task dev` opens the Electron window (deno.json
// `"client": "electron"`). `--client=browser` and `--client=server-only` are
// there for development and headless driving via `deno task am`.
import "./cell/workspace.ts";
import "./cell/session.ts";
import { aio } from "aio";

await aio.run({
  // `ui:` sets the Electron window (dep/aio/docs/clients/electron.md — the
  // server embeds it as <meta aio:width/height> and the thin client reads it;
  // bounds are then remembered in window-state.json).
  // The window opens wide enough for the real layout. Below ~880px the rail
  // collapses to icons, which is the right behaviour on a narrow window but the
  // wrong first impression for a desktop app — Electron's 800×600 default
  // landed exactly there. Bounds are remembered across runs after this.
  ui: { title: "Claude Control", width: 1440, height: 920 },
});
