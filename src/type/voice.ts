/**
 * @module
 * Speaking to the app instead of typing to it.
 */

/** Where a turn of speech has got to.
 *
 *  `transcribing` is deliberately distinct from `recording`: the wait after you
 *  let go of the key is the part that feels slow, and a control that cannot say
 *  which of the two it is in leaves you wondering whether it heard you. */
export type VoiceStatus =
  | "off" // not listening
  | "recording" // the key is held, audio is coming in
  | "transcribing" // the key is out, the model is thinking
  | "queued" // heard, written down, waiting for a reply to finish
  | "error";

export type VoiceConfig = {
  /** Where whisper.cpp's server answers. Empty means "not set up". */
  baseUrl: string;
  /** The language to force, or "" to let the model detect it.
   *
   *  Worth forcing when you know: detection costs a little time and is itself
   *  a guess that can be wrong on the first few words — which is exactly where
   *  a short instruction lives. */
  language: string;
  /**
   * The languages you actually speak.
   *
   * Empty means "trust whatever the model detects", which is the old
   * behaviour and the right default for someone who works in one language.
   * Naming two or three turns detection from a decision into a shortlist: an
   * answer that lands outside them is asked again, once per language here,
   * and the most confident wins. That is the fix for Czech coming back as
   * Polish — the model is not merely wrong there, it is unsure, and asking it
   * to transcribe a named language is a much easier question than asking it
   * to work out which language it is hearing.
   */
  spoken: string[];
  /** The key held to talk, as `KeyboardEvent.code`. */
  key: string;
  /**
   * Send as soon as you let go, rather than leaving the words to be read.
   *
   * On by default: saying a thing and having it happen is the point, and a
   * misheard instruction to a chat is corrected by saying the next one — it is
   * not the same as a misheard command in a shell, which voice never reaches.
   *
   * Off is for dictating in several takes, where sending after the first would
   * cut you off mid-thought.
   */
  autoSend: boolean;
  /** Which microphone to record from, or "" for the system default. */
  device: string;
  /**
   * Turn what was said into English, whatever language it was said in.
   *
   * Off by default, and this default is the one that matters: whisper-server's
   * OWN default is `language = "en"`, which is not detection — it tells the
   * model the audio IS English, and a Czech sentence then comes back as an
   * English one. Dictation must write down what you said, in the language you
   * said it; translating is a separate thing you ask for.
   */
  translate: boolean;
};
