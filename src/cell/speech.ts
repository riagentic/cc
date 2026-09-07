/**
 * @module
 * The app reading the conversation back to you.
 *
 * The other half of push-to-talk. What you send is read in one voice, what
 * comes back in another, so a conversation you are not looking at still has
 * two sides to it. Off until you switch it on, every session — an app that
 * starts talking on its own is one nobody switches on twice.
 */
import { cell, log } from "aio";
import type { Speaker, SpeechConfig, SpeechStatus } from "../type/speech.ts";

/** Where Kokoro-FastAPI listens by default — its own documented port, the same
 *  courtesy whisper and the local engines get. */
export const DEFAULT_SPEECH_URL = "http://127.0.0.1:8880";

/**
 * The two voices this starts with.
 *
 * `af_heart` is the only voice the model card grades A, so Claude — which does
 * most of the talking — gets it. Yours is male not because that is anybody's
 * default but because it is the fastest distinction to hear: within two
 * exchanges you stop having to think about who is speaking, which is the whole
 * point of using two voices at all.
 */
const DEFAULT_OUT = "af_heart";
const DEFAULT_IN = "am_michael";

/**
 * The voices worth reaching for first, best first, across every engine this
 * app knows.
 *
 * Domain, not decoration, which is why it lives here rather than in the
 * panel: it is what the app falls back to when the server it is pointed at
 * does not have the voice that was chosen. Ordered by the engines' own
 * gradings — Kokoro's model card is unusually honest and rates exactly one
 * voice an A — and the panel offers them in this order too.
 */
export const PREFERRED = [
  // Kokoro: A, A-, B-, then the best of the C+ men.
  "af_heart",
  "af_bella",
  "bf_emma",
  "af_nicole",
  "am_michael",
  "am_fenrir",
  "am_puck",
  "bm_george",
  // Supertonic, which names its ten by nothing but sex and number.
  "F1",
  "F2",
  "F3",
  "M1",
  "M2",
  "M3",
  // Piper's best English pair. It offers 136 voices sorted by language code,
  // so without these two an engine switch landed on Arabic — alphabetically
  // first, and not what anybody meant.
  "en_US-lessac-high",
  "en_US-ryan-high",
];

/**
 * Female, male, or no idea, from the voice's id alone.
 *
 * A guess, and it is allowed to be: it only ever chooses a DEFAULT, and a
 * wrong guess costs one visit to the picker. Both engines happen to say so in
 * the name — Kokoro prefixes `af_`/`bf_` and `am_`/`bm_` for accent and sex,
 * Supertonic simply calls them F1 and M1 — and a default pair that sounds
 * alike defeats the only reason there are two.
 */
export const sexOf = (id: string): "f" | "m" | "" => {
  const m = /^[ab]([fm])_/.exec(id) ?? /^([FM])\d/.exec(id);
  return m ? (m[1].toLowerCase() as "f" | "m") : "";
};

/** How many spoken message ids to remember. Far more than the handful a
 *  duplicate could ever arrive within, and still nothing. */
const SAID_KEEP = 50;

/** One line, said in the voice you are about to choose. Short on purpose — a
 *  sample you have to sit through is one you stop using. */
const SAMPLE = "Right. Here is how that one sounds.";

type SpeechState = {
  status: SpeechStatus;
  /** What is being read right now, trimmed, for the tooltip. */
  saying: string;
  /**
   * How many readings are in flight.
   *
   * A count and not a flag. Your message and the reply to it are two separate
   * readings that overlap — the second is dispatched while the first is still
   * playing — and with a flag the first one to finish declared silence while
   * the speakers were still going.
   */
  busy: number;
  error: string | null;
  config: SpeechConfig;
  voices: { id: string; grade: string; name: string }[];
  reachable: boolean;
  /**
   * Message ids already handed to the speaker, most recent last.
   *
   * The authority, and it has to live here rather than in the page. EVERY
   * connected client renders, so two windows each decided independently that a
   * reply was new and each asked for it — one reply, two readings, and nothing
   * in the page could see the other page. Claimed before the first await, in a
   * cell with live reads, so the second asker finds the id already taken.
   *
   * Capped: a marker is only ever compared against the last few, and an
   * unbounded list of every sentence ever spoken is a leak with no upside.
   */
  said: string[];
};

export const speech = cell("speech", {
  // The address, the voices and the speed are worth keeping. `status` is not:
  // whether the app is talking is a fact about right now, and `onAtStart` is
  // the persisted answer to what it should be at the next launch.
  persist: { include: ["config"] },

  // Same stance as the microphone: several readings are in flight at once and
  // each is a short orchestrator around an await. Snapshot isolation would
  // refuse the second one's commits.
  transaction: false,

  state: {
    status: "off" as SpeechStatus,
    saying: "",
    busy: 0,
    error: null as string | null,
    config: {
      baseUrl: "",
      voiceOut: DEFAULT_OUT,
      voiceIn: DEFAULT_IN,
      readMine: true,
      speed: 1,
      language: "",
      onAtStart: false,
    } as SpeechConfig,
    voices: [] as { id: string; grade: string; name: string }[],
    reachable: false,
    said: [] as string[],
  },

  onDestroy() {
    // Never leave the speakers running because the window went away.
    void import("./speech.server.ts").then((io) => io.silence()).catch(
      () => {},
    );
  },

  methods: {
    /**
     * What the speaker should be at launch.
     *
     * Its own step rather than an initial value, because the answer is
     * persisted config and config is not loaded when the state is declared.
     * Called once from the shell.
     */
    wake(s: SpeechState) {
      s.status = s.config.onAtStart && s.config.baseUrl !== "" ? "idle" : "off";
      s.busy = 0;
      s.error = null;
    },

    /**
     * Switch on.
     *
     * Which messages count as already-read is NOT decided here, and used to
     * be. One marker for every conversation meant the one from the chat you
     * just left was not in the new chat you just opened, and the guard against
     * reciting an old transcript quietly swallowed its first line. The page
     * keeps a marker per conversation now; switching on is only "start
     * watching", and everything on screen at that moment is backlog.
     */
    on(s: SpeechState) {
      if (s.config.baseUrl === "") {
        s.status = "error";
        s.error = "No speech server set up yet — see Settings.";
        return;
      }
      s.status = "idle";
      s.error = null;
      // Nothing said in a previous stint counts against this one. The backlog
      // is skipped by the marker above, not by this list, and a transcript
      // that was cleared and rebuilt can reuse an id.
      s.said = [];
      log.info("speech", "reading aloud, from here on");
    },

    /** Switch off, and stop mid-word if it is talking. */
    async off(s: SpeechState) {
      s.status = "off";
      s.saying = "";
      s.busy = 0;
      s.error = null;
      const io = await import("./speech.server.ts");
      io.silence();
    },

    /** Stop what is being said without switching off. The next message is
     *  still read; this one is not. */
    async hush(s: SpeechState) {
      if (s.status === "off") return;
      s.saying = "";
      s.busy = 0;
      const io = await import("./speech.server.ts");
      io.silence();
      await speech.quiet(); // aiol-ok: orchestration, one step
    },

    quiet(s: SpeechState) {
      if (s.status === "speaking") s.status = "idle";
    },

    /**
     * Read something out.
     *
     * Orchestrator only — it awaits the server and the speakers, and a draft
     * held across either would republish the state it started with.
     */
    async say(s: SpeechState, text: string, who: Speaker, id = "") {
      // Read BEFORE the first await, like every other orchestrator here.
      if (s.status === "off") return;
      const cfg = { ...s.config };
      const clean = typeof text === "string" ? text.trim() : "";
      if (clean === "" || cfg.baseUrl === "") return;
      // Claimed here, synchronously, before anything can yield. Two clients
      // asking for the same message is not a race to win — it is one reading,
      // and the second asker has to find the id gone.
      if (id !== "") {
        if (s.said.includes(id)) return;
        s.said = [...s.said, id].slice(-SAID_KEEP);
      }
      const voice = who === "you" ? cfg.voiceIn : cfg.voiceOut;

      const io = await import("./speech.server.ts");
      await speech.began(clean); // aiol-ok: orchestration, one step
      try {
        await io.say(clean, {
          baseUrl: cfg.baseUrl,
          voice,
          speed: cfg.speed,
          language: cfg.language,
        });
        await speech.ended(""); // aiol-ok: orchestration, one step
      } catch (e) {
        await speech.ended(e instanceof Error ? e.message : String(e)); // aiol-ok: orchestration, one step
      }
    },

    began(s: SpeechState, text: string) {
      if (s.status === "off") return;
      s.busy += 1;
      s.status = "speaking";
      s.error = null;
      // Enough to recognise in a tooltip, not enough to be a transcript.
      s.saying = text.length > 80 ? text.slice(0, 79) + "…" : text;
    },

    ended(s: SpeechState, error: string) {
      s.busy = Math.max(0, s.busy - 1);
      if (s.busy > 0) return; // something else is still talking
      s.saying = "";
      if (s.status === "off") return;
      if (error !== "") {
        s.status = "error";
        s.error = error;
        log.warn("speech", "could not read that out", { error });
        return;
      }
      s.status = "idle";
    },

    dismissError(s: SpeechState) {
      if (s.status === "error") s.status = s.config.onAtStart ? "idle" : "off";
      s.error = null;
    },

    setBaseUrl(s: SpeechState, url: string) {
      if (typeof url !== "string") return;
      s.config.baseUrl = url.trim().replace(/\/+$/, "");
    },

    setVoiceOut(s: SpeechState, id: string) {
      if (typeof id === "string" && id !== "") s.config.voiceOut = id;
    },

    setVoiceIn(s: SpeechState, id: string) {
      if (typeof id === "string" && id !== "") s.config.voiceIn = id;
    },

    setReadMine(s: SpeechState, on: boolean) {
      s.config.readMine = on === true;
    },

    /** Half speed to double. Clamped rather than validated: a slider cannot
     *  send anything else, and a saved config from a future version should
     *  land somewhere sane instead of asking the server for 40× speech. */
    setSpeed(s: SpeechState, rate: number) {
      const n = typeof rate === "number" && Number.isFinite(rate) ? rate : 1;
      s.config.speed = Math.min(2, Math.max(0.5, Math.round(n * 20) / 20));
    },

    /** "" means let the server decide. Worth setting when you know: a server
     *  that cannot detect has to assume something, and what it assumes is
     *  usually English. */
    setLanguage(s: SpeechState, code: string) {
      if (typeof code !== "string") return;
      s.config.language = code.trim().toLowerCase().slice(0, 8);
    },

    setOnAtStart(s: SpeechState, on: boolean) {
      s.config.onAtStart = on === true;
    },

    /**
     * Say one line in a voice, whether or not the speaker is on.
     *
     * Choosing a voice you cannot hear is choosing from a list of names, and
     * `am_fenrir` tells you nothing at all. This deliberately ignores the
     * on/off switch — you are in Settings, you clicked the button.
     */
    async preview(s: SpeechState, id: string) {
      const cfg = { ...s.config };
      if (cfg.baseUrl === "" || typeof id !== "string" || id === "") return;
      const io = await import("./speech.server.ts");
      io.silence();
      await io.say(SAMPLE, {
        baseUrl: cfg.baseUrl,
        voice: id,
        speed: cfg.speed,
        language: cfg.language,
      })
        .catch((e: unknown) => {
          log.warn("speech", "could not play the sample", {
            error: e instanceof Error ? e.message : String(e),
          });
        });
    },

    /** Look for a speech server, adopt it if one answers, and learn its
     *  voices while we are there. */
    async find(s: SpeechState) {
      const url = s.config.baseUrl || DEFAULT_SPEECH_URL;
      const io = await import("./speech.server.ts");
      const ok = await io.probe(url);
      const list = ok ? await io.voices(url) : [];
      await speech.found(url, ok, list); // aiol-ok: orchestration, after the probe
    },

    found(
      s: SpeechState,
      url: string,
      ok: boolean,
      list: { id: string; grade: string; name: string }[],
    ) {
      s.reachable = ok === true;
      if (ok && s.config.baseUrl === "") s.config.baseUrl = url;
      if (!Array.isArray(list) || list.length === 0) return;
      s.voices = list;
      // Point the app at a different engine and the voices it was set to stop
      // existing — `af_heart` means nothing to a server whose voices are
      // called F1 and M1, and every sentence would come back 400 with nothing
      // on screen to say why. So a selection the server does not have is
      // replaced by one it does, keeping them different from each other.
      const have = list.map((v) => v.id);
      // Best first, then whatever else is there. Alphabetical order picked
      // `af_alloy` — a C — over `af_heart`, the only A the model card gives
      // out, which is a poor thing to land on by accident.
      const best = [...PREFERRED.filter((id) => have.includes(id)), ...have];
      if (!have.includes(s.config.voiceOut)) s.config.voiceOut = best[0];
      if (!have.includes(s.config.voiceIn)) {
        // Not just "a different id" — a different SOUND. Falling back to the
        // next name along handed out F1 and F2, two women, and the two sides
        // of the conversation stopped being tellable apart, which is the only
        // thing two voices are for.
        const other = sexOf(s.config.voiceOut) === "f" ? "m" : "f";
        s.config.voiceIn = best.find((id) => sexOf(id) === other) ??
          best.find((id) => id !== s.config.voiceOut) ??
          best[0];
      }
    },
  },
});

/** Is reading aloud set up at all? Everything in the UI hides behind this. */
export const speechReady = (): boolean => speech.config.baseUrl !== "";

/** Is the speaker switched on right now? */
export const speechOn = (): boolean => speech.status !== "off";
