/**
 * @module
 * Setting up reading aloud: which voice server, who says what, in what
 * language.
 */
import { type VNode } from "aio/air";
import { DEFAULT_SPEECH_URL, PREFERRED, speech } from "../cell/speech.ts";
import { Pill, Segmented } from "./parts.tsx";
import { LANGUAGES } from "./languageList.ts";
import { IconRefresh, IconSpeaker } from "./icons.tsx";

/**
 * The two voice servers this app knows how to set up, and the trade between
 * them.
 *
 * Not a hardcoding of what it can talk to — it speaks the OpenAI speech route
 * and will drive anything that answers it, which is what the address field is
 * for. These are the two that are worth one click.
 */
const ENGINES: { url: string; label: string; hint: string }[] = [
  {
    url: "http://127.0.0.1:8880",
    label: "Kokoro",
    hint:
      "The best English there is at this size, and the only voice graded A. Eight languages, and Czech is not one of them.",
  },
  {
    url: "http://127.0.0.1:7788",
    label: "Supertonic",
    hint:
      "Thirty-one languages, Czech among them. English is a shade behind Kokoro and still good.",
  },
  {
    url: "http://127.0.0.1:7799",
    label: "Piper",
    hint:
      "Fifty-seven languages — Nepali, Bengali, Georgian, Welsh, the whole long tail. It is the 2021 generation and it sounds it: here for the languages the other two cannot say at all, not as a third opinion on English.",
  },
];

/**
 * Names for voices this app knows about, so a picker is not a list of ids.
 *
 * Anything absent is shown as its own id, which is the right answer for a
 * server that came after this code: a name it cannot explain is better than a
 * voice it refuses to offer.
 */
const NAMES: Record<string, string> = {
  // Kokoro. The parenthetical grades are the model card's own, and it is
  // unusually honest — exactly one voice is an A.
  af_heart: "Heart — female, American · the best one",
  af_bella: "Bella — female, American · warm",
  bf_emma: "Emma — female, British",
  af_nicole: "Nicole — female, American · soft, close",
  am_michael: "Michael — male, American",
  am_fenrir: "Fenrir — male, American · deep",
  am_puck: "Puck — male, American · bright",
  bm_george: "George — male, British",
  // Supertonic, which names its ten by nothing but sex and number.
  F1: "F1 — female",
  F2: "F2 — female",
  F3: "F3 — female",
  F4: "F4 — female",
  F5: "F5 — female",
  M1: "M1 — male",
  M2: "M2 — male",
  M3: "M3 — male",
  M4: "M4 — male",
  M5: "M5 — male",
};

const SPEEDS = [0.8, 0.9, 1, 1.1, 1.25, 1.5];

/** How fast, said in words. "1.25" is a number; "a bit quicker" is a choice. */
const speedLabel = (n: number): string =>
  n === 1 ? "Normal" : n < 1 ? `Slower · ${n}×` : `Quicker · ${n}×`;

/**
 * What to put in a voice picker, given what the server actually has.
 *
 * Server-driven, and it has to be: the shortlist used to be hardcoded to
 * Kokoro's names, so pointing the app at any other engine offered eight voices
 * that did not exist. `current` is included even when the server has not been
 * asked yet, because a `select` whose value is not among its options renders
 * blank and cannot be changed back.
 */
export function pickable(have: string[], current: string): {
  best: string[];
  rest: string[];
} {
  if (have.length === 0) return { best: [current], rest: [] };
  const best = PREFERRED.filter((id) => have.includes(id));
  return { best, rest: have.filter((id) => !best.includes(id)).sort() };
}

/** One voice chooser, with a button that plays it. Two of these differ only in
 *  which half of the conversation they dress, so they are one component. */
function VoicePick(
  props: {
    label: string;
    hint: string;
    value: string;
    onPick: (v: string) => void;
  },
): VNode {
  const { best, rest } = pickable(speech.voices.map((v) => v.id), props.value);
  // The server's own label wins where it wrote one. It is the only thing that
  // can know that `cs_CZ-kasandra-medium` is a Czech woman, and 136 raw ids
  // across 57 languages is a wall rather than a list.
  const said = new Map(
    speech.voices.filter((v) => v.name !== "").map((v) => [v.id, v.name]),
  );
  const name = (id: string) => said.get(id) ?? NAMES[id] ?? id;

  return (
    <div class="field">
      <span class="field__label">{props.label}</span>
      <span class="field__hint">{props.hint}</span>
      <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
        <select
          class="input"
          value={props.value}
          aria-label={props.label}
          onFocus={() => void speech.find()}
          onChange={(e: Event) =>
            props.onPick((e.target as HTMLSelectElement).value)}
        >
          <optgroup label="Recommended">
            {best.map((id) => <option key={id} value={id}>{name(id)}</option>)}
          </optgroup>
          {rest.length > 0 && (
            <optgroup label="All voices">
              {rest.map((id) => (
                <option key={id} value={id}>{name(id)}</option>
              ))}
            </optgroup>
          )}
        </select>
        <button
          type="button"
          class="btn btn--sm"
          title="Hear this voice"
          aria-label={`Hear ${props.value}`}
          onClick={() => void speech.preview(props.value)}
        >
          {IconSpeaker({ size: 13 })} Hear it
        </button>
      </div>
    </div>
  );
}

export function SpeechPanel(): VNode {
  const cfg = speech.config;
  const on = cfg.baseUrl !== "";
  const engine = ENGINES.find((e) => e.url === cfg.baseUrl);

  return (
    <div class="grid" style={{ gap: "12px" }}>
      {
        /* The master switch, first, because everything under it is a detail of
          a thing that is off until you say otherwise. The rest of the panel is
          not rendered while it is off: settings for a feature that is not
          running read as if it were. */
      }
      <div class="field">
        <span class="field__label">Voice output</span>
        <span class="field__hint">
          Off by default. While it is off this app contacts no speech server at
          all — so a voice model that would load the moment something asked it
          to speak never loads, and the graphics memory it wants stays free.
          Your server address and chosen voices are kept either way.
        </span>
        <Segmented
          value={cfg.enabled ? "on" : "off"}
          options={[
            { id: "off", label: "Off" },
            { id: "on", label: "On" },
          ]}
          onChange={(v: string) => void speech.setEnabled(v === "on")}
        />
      </div>

      {!cfg.enabled && (
        <div class="field__hint">
          Switch it on to choose a voice server and a pair of voices. Nothing
          below is contacted until you do.
        </div>
      )}

      {cfg.enabled && (
        <>
          <div class="field__hint">
            The speaker on the message bar reads the conversation back — what
            you send in one voice, what comes back in another. It starts
            switched off every time, and switching it on reads only what happens
            next, never the backlog.
          </div>

          <div class="field">
            <span class="field__label">Voice</span>
            <span class="field__hint">
              {engine?.hint ??
                "Two are set up here; the address below will drive anything else that answers the same route."}
            </span>
            <Segmented
              value={engine?.url ?? ""}
              options={ENGINES.map((e) => ({ id: e.url, label: e.label }))}
              onChange={(url: string) => {
                speech.setBaseUrl(url);
                // Straight away, because the voices are about to be different
                // ones and the picker below is filled from the answer.
                void speech.find(true);
              }}
            />
          </div>

          <div class="field">
            <span class="field__label">Voice server</span>
            <span class="field__hint">
              Where it answers. Anything speaking OpenAI's{" "}
              <code>/v1/audio/speech</code> will do.
            </span>
            <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
              <input
                class="input"
                type="text"
                value={cfg.baseUrl}
                placeholder={DEFAULT_SPEECH_URL}
                aria-label="Voice server address"
                onChange={(e: Event) =>
                  speech.setBaseUrl((e.target as HTMLInputElement).value)}
              />
              <button
                type="button"
                class="btn btn--sm"
                title="Look for a voice server"
                onClick={() => void speech.find(true)}
              >
                {IconRefresh({ size: 13 })} Find
              </button>
              {on && (
                <Pill tone={speech.reachable ? "ok" : "warn"}>
                  {speech.reachable ? "answering" : "no answer"}
                </Pill>
              )}
            </div>
          </div>

          <VoicePick
            label="Claude's voice"
            hint="The one you will hear most. Try a few — they are not interchangeable."
            value={cfg.voiceOut}
            onPick={(v) => speech.setVoiceOut(v)}
          />

          <VoicePick
            label="Your voice"
            hint="Your own messages, read back. Pick one that is obviously not Claude's — hearing which side is talking is the whole reason there are two."
            value={cfg.voiceIn}
            onPick={(v) => speech.setVoiceIn(v)}
          />

          <div class="field">
            <span class="field__label">Language</span>
            <span class="field__hint">
              Leave it on Detect unless it gets one wrong. Not every voice
              speaks every one of these: Piper answers by changing voice,
              Supertonic says so plainly, and Kokoro reads it in the accent it
              has.
            </span>
            <select
              class="input"
              value={cfg.language}
              aria-label="Reading language"
              onChange={(e: Event) =>
                speech.setLanguage((e.target as HTMLSelectElement).value)}
            >
              {LANGUAGES.map((l) => (
                <option key={l.id || "auto"} value={l.id}>{l.label}</option>
              ))}
            </select>
          </div>

          <div class="field">
            <span class="field__label">Read my messages back</span>
            <span class="field__hint">
              On is how you catch a misheard dictation before the answer to it
              arrives. Off if you already know what you typed.
            </span>
            <Segmented
              value={cfg.readMine ? "both" : "reply"}
              options={[
                { id: "both", label: "Both sides" },
                { id: "reply", label: "Only the reply" },
              ]}
              onChange={(v: string) => speech.setReadMine(v === "both")}
            />
          </div>

          <div class="field">
            <span class="field__label">Pace</span>
            <span class="field__hint">
              Faster than about 1.25 starts to slur; the voice does not
              re-phrase, it just hurries.
            </span>
            <select
              class="input"
              value={String(cfg.speed)}
              aria-label="Reading speed"
              onChange={(e: Event) =>
                speech.setSpeed(Number((e.target as HTMLSelectElement).value))}
            >
              {SPEEDS.map((n) => (
                <option key={String(n)} value={String(n)}>
                  {speedLabel(n)}
                </option>
              ))}
            </select>
          </div>

          <div class="field">
            <span class="field__label">When the app opens</span>
            <span class="field__hint">
              Silent by default, on purpose: an app that starts talking before
              you have asked it anything is one you switch off and never switch
              back on.
            </span>
            <Segmented
              value={cfg.onAtStart ? "on" : "off"}
              options={[
                { id: "off", label: "Stay quiet" },
                { id: "on", label: "Start reading" },
              ]}
              onChange={(v: string) => speech.setOnAtStart(v === "on")}
            />
          </div>
        </>
      )}
    </div>
  );
}
