/**
 * The voice server, from the far side of the HTTP route.
 *
 * A fake server on a free port, so what is pinned is what `say` asks and when
 * it stops asking. Nothing here reaches the speakers except the one test that
 * needs a player to exist, and that one plays silence.
 */
import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  identify,
  probe,
  refusesRaw,
  say,
  silence,
  Unreachable,
} from "../../cell/speech.server.ts";

type Asked = { model: string; format: string };

/** A speech server that answers however `speak` says, and remembers what it
 *  was asked. */
function fake(
  speak: (asked: Asked, req: Request) => Response | Promise<Response>,
  health: () => Response = () => new Response("", { status: 404 }),
) {
  const asked: Asked[] = [];
  const server = Deno.serve({ port: 0, onListen() {} }, async (req) => {
    const path = new URL(req.url).pathname;
    if (path === "/v1/health") return health();
    if (path === "/v1/audio/speech") {
      const body = await req.json();
      const a = { model: body.model, format: body.response_format };
      asked.push(a);
      return speak(a, req);
    }
    return new Response("", { status: 404 });
  });
  const url = `http://127.0.0.1:${server.addr.port}`;
  return { url, asked, stop: () => server.shutdown() };
}

const opts = (baseUrl: string) => ({
  baseUrl,
  voice: "af_heart",
  speed: 1,
  language: "",
});

const hasPaplay = (() => {
  try {
    return new Deno.Command("paplay", { args: ["--version"] }).outputSync()
      .success;
  } catch {
    return false;
  }
})();

Deno.test("identify — whichever route answered wins, and a guess is only a guess", () => {
  assertEquals(identify({ model: "supertonic-3" }, null).model, "supertonic-3");
  assertEquals(
    identify(null, { data: [{ id: "tts-1" }, { id: "kokoro" }] }).model,
    "kokoro",
  );
  assertEquals(identify(null, null), {
    model: "kokoro",
    raw: true,
    rate: 24_000,
  });
  assertEquals(identify({ sample_rate: 22_050 }, null).rate, 22_050);
});

Deno.test("refusesRaw — only a refusal of the format turns streaming off", () => {
  // Supertonic's actual answer to `pcm`.
  assert(
    refusesRaw(
      400,
      `{"error":{"message":"unsupported response_format 'pcm'"}}`,
    ),
  );
  assert(refusesRaw(422, `{"detail":[{"loc":["body","response_format"]}]}`));
  // A model still loading, a wrong model name, a server error: not this.
  assert(!refusesRaw(503, "server not ready"));
  assert(!refusesRaw(400, `{"error":{"message":"this server serves 'x'"}}`));
  assert(!refusesRaw(500, "pcm encoder crashed"));
});

Deno.test("a hiccup does not switch streaming off for good", async () => {
  // Any non-OK used to set raw=false forever: one 500 from Kokoro, and every
  // reply after it waited for the whole file.
  const srv = fake(() => new Response("oops", { status: 500 }));
  try {
    await probe(srv.url, true);
    for (let i = 0; i < 2; i++) {
      await assertRejects(() => say("Hello there.", opts(srv.url)));
    }
    assertEquals(srv.asked.map((a) => a.format), ["pcm", "pcm"]);
  } finally {
    await srv.stop();
  }
});

Deno.test("a server still loading is asked who it is again, not guessed at forever", async () => {
  // Supertonic's health is a 503 while its model loads. The guess made then
  // was cached, and every sentence after went out as "kokoro" — a 400 each.
  let loaded = false;
  const srv = fake(
    () => new Response("no", { status: 500 }),
    () =>
      loaded
        ? Response.json({ model: "supertonic-3", sample_rate: 44_100 })
        : new Response("server not ready", { status: 503 }),
  );
  try {
    await probe(srv.url, true);
    await assertRejects(() => say("Hello.", opts(srv.url)));
    loaded = true;
    await assertRejects(() => say("Hello.", opts(srv.url)));
    assertEquals(srv.asked.map((a) => a.model), ["kokoro", "supertonic-3"]);
  } finally {
    await srv.stop();
  }
});

Deno.test("Stop before the first sound means no sound", async () => {
  // Most of a reading's first second is waiting for the first piece, and a
  // Stop pressed then found nothing to stop: the piece arrived, a player
  // started, and the sentence was read anyway. Stopped properly, the reading
  // is over the moment Stop is pressed — long before the server answers.
  const srv = fake(async () => {
    await new Promise((r) => setTimeout(r, 1500));
    return new Response(new Uint8Array(4800));
  });
  try {
    await probe(srv.url, true);
    const reading = say("Hello there.", opts(srv.url));
    await new Promise((r) => setTimeout(r, 100));
    const at = Date.now();
    silence();
    await reading; // resolves quietly: a stop is not a failure
    const took = Date.now() - at;
    assert(took < 700, `still waited for the server: ${took} ms after Stop`);
  } finally {
    await srv.stop();
  }
});

Deno.test({
  name: "Stop during the last sentence is a stop, not a failure",
  ignore: !hasPaplay,
  async fn() {
    // Every piece already written, the player still playing: Stop kills it.
    // `paplay` traps SIGTERM and exits 0, but a player killed before its
    // handler is up dies of the signal — and that exit must read as a stop,
    // not "could not play the audio". One second of silence, small enough to
    // fit the pipe in one write.
    const srv = fake(() => new Response(new Uint8Array(48_000)));
    try {
      await probe(srv.url, true);
      const reading = say("Hello there.", opts(srv.url));
      await new Promise((r) => setTimeout(r, 400));
      silence();
      await reading;
    } finally {
      await srv.stop();
    }
  },
});

Deno.test("nothing listening is its own kind of failure", async () => {
  // A port that was open a moment ago and is closed now.
  const srv = fake(() => new Response(""));
  const url = srv.url;
  await srv.stop();
  await assertRejects(() => say("Hello.", opts(url)), Unreachable);
});
