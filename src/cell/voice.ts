/**
 * @module
 * Push to talk.
 *
 * Hold a key, say a sentence, let go — the words arrive in the composer and,
 * unless auto-send is switched off, are sent as if you had pressed Enter.
 * Never into the shell: a misheard instruction to a chat is corrected by the
 * next one, a misheard command is already running.
 */
import { cell, log } from "aio";
import type { VoiceConfig, VoiceStatus } from "../type/voice.ts";

/** Where whisper.cpp's server listens by default. Its own documented port —
 *  the same courtesy the local engines get. */
export const DEFAULT_VOICE_URL = "http://127.0.0.1:8910";

/** The key held to talk.
 *
 *  A BARE modifier, and that is the whole reason for it. Holding one produces
 *  no bytes for a terminal — unlike a letter or a chord, which a shell wants —
 *  so this is the one kind of key that can be taken globally without costing
 *  the Console anything. `code` rather than `key`, so it is the right-hand one
 *  specifically and every left-Ctrl shortcut is untouched. */
const DEFAULT_KEY = "ControlRight";

type VoiceState = {
  status: VoiceStatus;
  /** Loudness right now, 0…1 — the meter, and the only proof the microphone
   *  is actually hearing you rather than muted. */
  level: number;
  /** What was heard last, so the page can put it in the composer once. */
  text: string;
  /** Bumped with `text`, so a page can tell "said the same thing twice" from
   *  "said nothing new" — an identical sentence is not a stale one. */
  turn: number;
  /**
   * Which press this is — bumped every time the key goes down.
   *
   * A press can start while the last one is still being transcribed, and the
   * last one's ending used to land on top of it: "off" while the microphone
   * was open, the meter frozen, the next release finding nothing to stop.
   * Every step of a turn carries the press it belongs to, and one from an
   * earlier press still hands over its words but leaves the state alone.
   */
  take: number;
  error: string | null;
  config: VoiceConfig;
  /** Whether a speech server answered the last time anyone looked. */
  reachable: boolean;
  devices: { id: string; label: string }[];
};

export const voice = cell("voice", {
  // The address and the language are worth keeping; a half-finished recording
  // is not.
  persist: { include: ["config"] },

  // Live reads and incremental commits, like the console cell and for the same
  // reason: `level` is a sync reducer fed by a process, and it runs many times
  // a second while `start` is still suspended waiting on that same process.
  // Snapshot isolation would refuse most of them, and the meter — whose whole
  // job is to move — would sit still.
  transaction: false,

  state: {
    status: "off" as VoiceStatus,
    level: 0,
    text: "",
    turn: 0,
    take: 0,
    error: null as string | null,
    config: {
      // Off until somebody switches it on: the GPU whisper holds is VRAM
      // taken from the model this app exists to run, so the feature is
      // something you opt into, never something you find running.
      enabled: false,
      baseUrl: "",
      language: "",
      spoken: [],
      key: DEFAULT_KEY,
      autoSend: true,
      device: "",
      translate: false,
    } as VoiceConfig,
    /** The microphones this machine offers. Filled when Settings asks. */
    devices: [] as { id: string; label: string }[],
    reachable: false,
  },

  onDestroy() {
    // Never leave the microphone open because the app went away. The console
    // cell closes its shells here for the same reason, and a recorder nobody
    // owns is worse than a shell nobody owns.
    void import("./voice.server.ts").then((io) => io.stopCapture()).catch(
      () => {},
    );
  },

  methods: {
    /** Begin listening. Ignored when already listening, because a held key
     *  repeats and every repeat would otherwise restart the recording. */
    async start(s: VoiceState) {
      // The master switch first, from the draft: this is also reached by
      // dispatches that are not the key hook, and a switch only the shortcut
      // obeys is half a switch. Unlike the hook, a switched-off press here is
      // silent — the hook already said so, once.
      if (s.config.enabled !== true) return;
      // Said out loud, because a refused press is invisible otherwise — and
      // "sometimes it listens, sometimes it does not" is precisely what a
      // silent refusal looks like from the outside.
      if (s.status === "recording") {
        log.warn("voice", "already recording — press ignored", {
          level: s.level,
        });
        return;
      }
      if (s.config.baseUrl === "") {
        s.error = "No speech server set up yet — see Settings.";
        s.status = "error";
        return;
      }
      s.status = "recording";
      s.error = null;
      s.level = 0;
      s.take += 1;
      log.info("voice", "listening (key down)");
      await openMic(s);
    },

    /** The meter. A method of its own because it is written many times a
     *  second while `start` is still suspended — and named for the act rather
     *  than the field, because a method may not share a name with a state key
     *  (reading `voice.level` in a component would hand back the function). */
    hearing(s: VoiceState, level: number) {
      if (s.status !== "recording") return;
      s.level = typeof level === "number" && level >= 0
        ? Math.min(1, level)
        : 0;
    },

    /**
     * Let go: stop recording and ask what was said.
     *
     * Orchestrator only — it awaits the recorder and then the model, and a
     * draft held across either would republish the state it entered with.
     */
    async stop(s: VoiceState) {
      // Read BEFORE the first await. Everything below is a commit point, and
      // the settings cannot change while a key is held anyway — so taking them
      // here is both correct and the honest description of when they applied.
      const cfg = { ...s.config };
      const take = s.take;

      const io = await import("./voice.server.ts");
      let wav: Uint8Array | null;
      try {
        wav = await io.stopCapture();
      } catch (e) {
        // The recorder said why it heard nothing — a microphone that is not
        // there. That one IS a failure, and the only place its reason exists.
        await voice.settled( // aiol-ok: orchestration, one step
          "",
          e instanceof Error ? e.message : String(e),
          take,
        );
        return;
      }
      if (!wav) {
        // Too short, or only silence. Said quietly rather than as an error: a
        // brushed key is not a failure, and whisper answers silence with
        // confident invented sentences, which is why it is not sent at all.
        await voice.discarded(take); // aiol-ok: orchestration, one step
        return;
      }
      await voice.thinking(take); // aiol-ok: orchestration, one step
      try {
        const text = await io.transcribe(wav, {
          baseUrl: cfg.baseUrl,
          language: cfg.language,
          // `=== true`: a config saved before this field existed has no value
          // here, and "not set" must mean the default, which is off.
          translate: cfg.translate === true,
          // A config saved before this field existed has none, and "not set"
          // has to mean the old behaviour: trust detection.
          spoken: Array.isArray(cfg.spoken) ? cfg.spoken : [],
        }, AbortSignal.timeout(60_000));
        await voice.settled(text, "", take); // aiol-ok: orchestration, one step
      } catch (e) {
        await voice.settled( // aiol-ok: orchestration, one step
          "",
          e instanceof Error ? e.message : String(e),
          take,
        );
      }
    },

    /**
     * Let go, but throw the recording away.
     *
     * Another key went down while this one was held: Right-Ctrl+C is a
     * shortcut, not a sentence. Transcribed, it was a second or two of key
     * clicks that whisper wrote up as words, and auto-send then sent them.
     */
    async cancel(s: VoiceState) {
      const take = s.take;
      const io = await import("./voice.server.ts");
      await io.stopCapture().catch(() => null);
      log.info("voice", "another key joined the press — a shortcut, discarded");
      await voice.discarded(take); // aiol-ok: orchestration, one step
    },

    thinking(s: VoiceState, take: number) {
      if (take !== s.take) return; // a newer press is recording
      s.status = "transcribing";
      s.level = 0;
    },

    /**
     * The press produced nothing worth sending — too short, only silence, or
     * cancelled.
     *
     * Not `settled("", "")`, which this used to be: that path reports "the
     * model made no words" when the model was never asked, and it cleared an
     * "error" the microphone had just set — a mic that failed to open looked,
     * one release later, like a mic that was fine. Only a recording is ended
     * here; anything else the press left behind stays.
     */
    discarded(s: VoiceState, take: number) {
      if (take !== s.take || s.status !== "recording") return;
      s.status = "off";
      s.level = 0;
    },

    /**
     * The turn is over, however it ended.
     *
     * One method for all three endings — words, nothing, a failure — because
     * they differ only in what they leave behind, and three separate ones
     * meant three dispatches from `stop` racing to describe the same moment.
     */
    settled(s: VoiceState, text: string, error: string, take: number) {
      // An earlier press, ending while a newer one records. Its words are
      // still yours and still handed over; the state belongs to the new one.
      const current = take === s.take;
      if (error !== "") {
        log.warn("voice", "could not transcribe", { error });
        if (!current) return;
        s.level = 0;
        s.status = "error";
        s.error = error;
        return;
      }
      if (current) {
        s.level = 0;
        s.status = "off";
      }
      const clean = typeof text === "string" ? text.trim() : "";
      if (clean === "") {
        // The commonest silent failure: audio went to the model and came back
        // as nothing. Reported, because "I held the key and spoke and the app
        // did not react" needs to leave a trace somewhere.
        log.warn("voice", "the model made no words of that recording");
        return;
      }
      s.text = clean;
      // Bumped so that saying the same sentence twice is two events. Without
      // it the second one looks like the first still sitting there.
      s.turn += 1;
      log.info("voice", "heard", { chars: clean.length });
    },

    /** The page has put the text somewhere. Cleared so a later render cannot
     *  paste it a second time. */
    taken(s: VoiceState) {
      s.text = "";
    },

    /** The words are in the box, waiting for a reply to finish before they can
     *  go. A state of its own so the mic can say "waiting", which is a
     *  different thing from "failed" and from "idle". */
    queued(s: VoiceState) {
      s.status = "queued";
      s.error = null;
    },

    /**
     * The words are in the box but could not be sent.
     *
     * Said out loud rather than left to be noticed. Auto-send is on by
     * default, so "I spoke and nothing happened" is the failure people will
     * actually meet — a turn already running, or a page with nowhere to type —
     * and in every one of those cases the app used to do exactly nothing and
     * explain nothing. The words are still there; this is what says where.
     */
    notSent(s: VoiceState, why: string) {
      s.status = "error";
      s.error = why;
    },

    /** The words went to the model. Back to plain idle.
     *
     *  Its own method rather than `settled("", "")`, which the page used to
     *  call here: that path logs "the model made no words of that recording",
     *  and it was doing so once after every successful sentence — a phantom
     *  failure in the log, right after the real success, for months. */
    sent(s: VoiceState) {
      s.status = "off";
      s.error = null;
    },

    dismissError(s: VoiceState) {
      if (s.status === "error") s.status = "off";
      s.error = null;
    },

    setBaseUrl(s: VoiceState, url: string) {
      if (typeof url !== "string") return;
      s.config.baseUrl = url.trim().replace(/\/+$/, "");
    },

    /**
     * The master switch: whether speech-to-text exists at all.
     *
     * Turning it OFF also parks the state — a recording in flight is stopped,
     * so the switch is immediate, not "from the next sentence". Turning it on
     * does nothing else: the server address and the rest are configured
     * separately, and an empty address still means not set up.
     *
     * Synchronous, like every other config setter, so the state reads back
     * the moment it is set; the capture stop is dispatched rather than
     * awaited — the server half is fire-and-forget cleanup, same as
     * `onDestroy`.
     */
    setEnabled(s: VoiceState, on: boolean) {
      s.config.enabled = on === true;
      if (!s.config.enabled && s.status !== "off") {
        s.status = "off";
        s.level = 0;
        s.text = "";
        void import("./voice.server.ts").then((io) => io.stopCapture()).catch(
          () => {},
        );
      }
      log.info("voice", "speech-to-text switched", {
        enabled: s.config.enabled,
      });
    },

    /** "" means let the model decide. Worth setting when you know: detection
     *  is itself a guess, and it is made on the first few words — which for a
     *  short instruction is all of them. */
    setLanguage(s: VoiceState, code: string) {
      if (typeof code !== "string") return;
      s.config.language = code.trim().toLowerCase().slice(0, 8);
    },

    /**
     * Which languages you actually speak.
     *
     * A list rather than a single choice, because the point is the ones you
     * switch between. One entry is the same as pinning it; none is the same
     * as trusting detection, which is where this started.
     */
    setSpoken(s: VoiceState, codes: string[]) {
      if (!Array.isArray(codes)) return;
      const clean = codes
        .filter((c): c is string => typeof c === "string")
        .map((c) => c.trim().toLowerCase().slice(0, 8))
        .filter((c) => c !== "");
      // Deduplicated, and capped: every one past the first costs a second
      // request whenever detection goes astray, and nobody speaks six.
      s.config.spoken = [...new Set(clean)].slice(0, 5);
    },

    setKey(s: VoiceState, code: string) {
      if (typeof code !== "string" || code === "") return;
      s.config.key = code;
    },

    setAutoSend(s: VoiceState, on: boolean) {
      s.config.autoSend = on === true;
    },

    setDevice(s: VoiceState, id: string) {
      if (typeof id !== "string") return;
      s.config.device = id;
    },

    setTranslate(s: VoiceState, on: boolean) {
      s.config.translate = on === true;
    },

    /** Ask the machine what it can hear with. */
    async listInputs(_s: VoiceState) {
      const io = await import("./voice.server.ts");
      await voice.gotInputs(await io.inputs()); // aiol-ok: after the read
    },

    gotInputs(s: VoiceState, list: { id: string; label: string }[]) {
      s.devices = Array.isArray(list) ? list : [];
    },

    /**
     * Look for a speech server, and adopt it if one answers.
     *
     * Asked for, not polled — the same call the Engine panel makes when it
     * opens. A speech server that is not running is not an emergency, and a
     * background probe every thirty seconds would be thirty seconds of nothing
     * happening, forever, to answer a question nobody asked.
     */
    async find(s: VoiceState) {
      // Before the await, for the same reason as `stop`.
      const url = s.config.baseUrl || DEFAULT_VOICE_URL;
      const io = await import("./voice.server.ts");
      const ok = await io.probe(url);
      await voice.found(url, ok); // aiol-ok: orchestration, after the probe
    },

    found(s: VoiceState, url: string, ok: boolean) {
      s.reachable = ok === true;
      if (ok && s.config.baseUrl === "") s.config.baseUrl = url;
    },
  },
});

/**
 * Open the microphone, and keep the meter fed while it is open.
 *
 * A plain function taking the draft, like every other shared step in this app.
 * The level callback fires many times a second long after this has returned,
 * so it cannot be a write to `s` — it has to be a dispatch, and a dispatch
 * written inside a method reads as a nested same-cell call, which is a real
 * mistake elsewhere. Here the shape is deliberate and this is where it lives.
 */
async function openMic(s: VoiceState): Promise<void> {
  const io = await import("./voice.server.ts");
  try {
    await io.startCapture({ device: voice.config.device }, {
      onLevel: (l) => voice.hearing(l),
      // The cap was reached with the key still down. Ended as if released; the
      // real release, when it comes, finds nothing left to stop.
      onFull: () => void voice.stop(),
    });
  } catch (e) {
    s.status = "error";
    s.level = 0;
    s.error = e instanceof Error ? e.message : String(e);
    log.warn("voice", "could not open the microphone", { error: s.error });
  }
}

/** The key held to talk. */
export const voiceKey = (): string => voice.config.key || DEFAULT_KEY;

/**
 * Is voice set up at all? Everything in the UI hides behind this — an app
 * half-showing a feature nobody can use is worse than one not showing it.
 *
 * The master switch is part of the answer, and deliberately first: a disabled
 * feature with a configured server is still disabled — the VRAM whisper would
 * hold belongs to whoever switched it off, and no amount of configuration
 * makes the held key do anything.
 */
export const voiceReady = (): boolean =>
  voice.config.enabled === true && voice.config.baseUrl !== "";
