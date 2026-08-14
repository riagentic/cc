// Thin CLI client — live view of a running server's state over WebSocket.
// Run it against a dev server (`deno run -A src/client.ts`); the `cli-client`
// build target compiles it into a standalone client binary (add "cli-client" to
// build.targets, then `deno task build`). No local server.
//
// Logging goes through aio's `log`, never `console` — one log system, one
// format, and the output lands in the app's log files like everything else
// (dep/aio/docs/basics/api-reference.md#logging).
import { log } from "aio";
import { connectCli } from "aio/server";

const url = Deno.args[0] || "ws://localhost:8000/ws";
log.info("client", "connecting", { url });

const app = connectCli(url);
await app.ready;
log.info("client", "connected", { state: app.state });
app.subscribe(() => log.info("client", "state changed", { state: app.state }));
