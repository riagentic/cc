/**
 * @module
 * Setting up push-to-talk: where the speech server is, and what to hold.
 */
import { type VNode } from "aio/air";
import { DEFAULT_VOICE_URL, voice, voiceReady } from "../cell/voice.ts";
import { Pill, Segmented, Toggle } from "./parts.tsx";
import { keyLabel } from "./Mic.tsx";
import { IconRefresh } from "./icons.tsx";
import { HEARD_LANGUAGES } from "./languageList.ts";

/**
 * What to offer in the microphone picker.
 *
 * The saved one is always among them, even before the machine has been asked
 * what it has: the list is filled when the picker is focused, and until then
 * a `select` whose value is not among its options renders "System default"
 * while recording from something else — which is a lie about the one setting
 * that decides whether you are heard at all.
 */
export function micOptions(
  devices: { id: string; label: string }[],
  current: string,
): { id: string; label: string }[] {
  const listed = [{ id: "", label: "System default" }, ...devices];
  return listed.some((d) => d.id === current)
    ? listed
    : [...listed, { id: current, label: current }];
}

export function VoicePanel(): VNode {
  const cfg = voice.config;
  // A config saved before this field existed has none of it.
  const spoken = Array.isArray(cfg.spoken) ? cfg.spoken : [];
  const on = cfg.baseUrl !== "";
  // A config saved before the switch existed has no `enabled`, and "not set"
  // must mean off — that is the default, and it is the one that costs no VRAM.
  const enabled = cfg.enabled === true;
  const ready = voiceReady();

  return (
    <div class="grid" style={{ gap: "12px" }}>
      <Toggle
        label="Enable speech-to-text"
        hint="Off by default — whisper holds VRAM the model could use, and typing is
              always there. While off, the held key does nothing."
        checked={enabled}
        onChange={(v: boolean) => void voice.setEnabled(v)}
      />

      {enabled && (
        <>
          <div class="field__hint">
            Hold <b>{keyLabel(cfg.key)}</b>{" "}
            and speak; let go and the words land in the composer, and are sent
            unless you choose otherwise below. Needs <code>whisper-server</code>
            {" "}
            running locally.
          </div>

          <div class="field">
            <span class="field__label">Speech server</span>
            <span class="field__hint">Where whisper.cpp answers</span>
            <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
              <input
                class="input"
                type="text"
                value={cfg.baseUrl}
                placeholder={DEFAULT_VOICE_URL}
                aria-label="Speech server address"
                onChange={(e: Event) =>
                  voice.setBaseUrl((e.target as HTMLInputElement).value)}
              />
              <button
                type="button"
                class="btn btn--sm"
                title="Look for a speech server"
                onClick={() => void voice.find()}
              >
                {IconRefresh({ size: 13 })} Find
              </button>
              {on && (
                <Pill tone={voice.reachable ? "ok" : "warn"}>
                  {voice.reachable ? "answering" : "no answer"}
                </Pill>
              )}
            </div>
          </div>

          <div class="field">
            <span class="field__label">Microphone</span>
            <span class="field__hint">
              The system default is right for most machines and wrong for any
              whose default is a digital input with no microphone on it — which
              is a setup that makes this feature look broken rather than
              unconfigured.
            </span>
            <select
              class="input"
              value={cfg.device}
              aria-label="Microphone"
              onFocus={() => void voice.listInputs()}
              onChange={(e: Event) =>
                voice.setDevice((e.target as HTMLSelectElement).value)}
            >
              {micOptions(voice.devices, cfg.device).map((d) => (
                <option key={d.id || "default"} value={d.id}>{d.label}</option>
              ))}
            </select>
          </div>

          <div class="field">
            <span class="field__label">Language</span>
            <span class="field__hint">
              Forcing one skips detection — which is a guess made on the first
              few words, and a short instruction is only a few words
            </span>
            <select
              class="input"
              value={cfg.language}
              aria-label="Speech language"
              onChange={(e: Event) =>
                voice.setLanguage((e.target as HTMLSelectElement).value)}
            >
              {HEARD_LANGUAGES.map((l) => (
                <option key={l.id || "auto"} value={l.id}>{l.label}</option>
              ))}
            </select>
          </div>

          <div class="field">
            <span class="field__label">Languages you speak</span>
            <span class="field__hint">
              Pick the ones you actually switch between. Detection has to commit
              on the first few words — which for a short instruction is all of
              them — and Czech, Slovak and Polish are neighbours. Naming yours
              turns that guess into a shortlist: an answer landing outside them
              is asked again, once per language, and the most confident wins.
              Leave it empty to trust detection.
            </span>
            <div class="chips">
              {HEARD_LANGUAGES.filter((l) => l.id !== "").map((l) => {
                const on = spoken.includes(l.id);
                return (
                  <button
                    key={l.id}
                    type="button"
                    class={`chip${on ? " chip--on" : ""}`}
                    aria-pressed={on}
                    aria-label={`I speak ${l.label}`}
                    onClick={() =>
                      voice.setSpoken(
                        on
                          ? spoken.filter((c) => c !== l.id)
                          : [...spoken, l.id],
                      )}
                  >
                    {l.label}
                  </button>
                );
              })}
            </div>
          </div>

          <div class="field">
            <span class="field__label">Write it down</span>
            <span class="field__hint">
              As said, in the language it was said in — or turned into English.
              Whisper translates well; it is only wrong as a default.
            </span>
            <Segmented
              value={cfg.translate === true ? "english" : "asis"}
              options={[
                { id: "asis", label: "As I said it" },
                { id: "english", label: "In English" },
              ]}
              onChange={(v: string) => voice.setTranslate(v === "english")}
            />
          </div>

          <div class="field">
            <span class="field__label">When you let go</span>
            <span class="field__hint">
              Sending straight away is the point of speaking. Turn it off to
              dictate in several takes, where sending after the first would cut
              you off mid-thought.
            </span>
            <Segmented
              value={cfg.autoSend ? "send" : "hold"}
              options={[
                { id: "send", label: "Send it" },
                { id: "hold", label: "Leave it to read" },
              ]}
              onChange={(v: string) => voice.setAutoSend(v === "send")}
            />
          </div>

          <div class="field">
            <span class="field__label">Key to hold</span>
            <span class="field__hint">
              A bare modifier is best: held alone it sends nothing to a shell,
              so it costs the Console nothing
            </span>
            <select
              class="input"
              value={cfg.key}
              aria-label="Push to talk key"
              onChange={(e: Event) =>
                voice.setKey((e.target as HTMLSelectElement).value)}
            >
              {["ControlRight", "AltRight", "ShiftRight", "ContextMenu"].map((
                k,
              ) => <option key={k} value={k}>{keyLabel(k)}</option>)}
            </select>
          </div>
        </>
      )}

      {enabled && !ready && (
        <div class="field__hint">
          The key stays silent until a speech server is configured above.
        </div>
      )}
    </div>
  );
}
