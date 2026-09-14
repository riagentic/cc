/**
 * @module
 * The app reading aloud: what it says, and in whose voice.
 */

/** Whose words these are — which decides which voice says them. */
export type Speaker = "you" | "claude";

/** Where reading aloud has got to. */
export type SpeechStatus =
  | "off" // the speaker is switched off
  | "idle" // on, nothing to say
  | "speaking" // audio is playing right now
  | "error";

export type SpeechConfig = {
  /**
   * Is reading aloud part of this app at all.
   *
   * **Off by default, and it is the master switch**: with it off nothing here
   * contacts a speech server — not a probe, not a voice list, not a preview —
   * so a server that loads its voice model when something first asks it to
   * speak never loads one, and the memory it would have taken stays free. The
   * speaker button and its palette commands are not offered either.
   *
   * Separate from `baseUrl` on purpose. "Which server" and "do I want this"
   * are different questions, and answering the second by deleting the answer
   * to the first means setting the address up again every time you change your
   * mind.
   */
  enabled: boolean;
  /** Where the speech server answers. Empty means "not set up". */
  baseUrl: string;
  /** The voice for Claude's replies. */
  voiceOut: string;
  /** The voice for your own messages, read back. Deliberately a different one:
   *  two sides of a conversation in one voice is a monologue, and you lose
   *  track of who is talking within about three exchanges. */
  voiceIn: string;
  /** Read your own messages back at all. On by default — hearing what was sent
   *  is how you catch a misheard dictation before the answer arrives. */
  readMine: boolean;
  /** How fast, 0.5…2. `1` is the voice's own pace. */
  speed: number;
  /**
   * What language to read it in, or "" to let the server decide.
   *
   * "" is the right default and the reason is a lesson this app already paid
   * for once: whisper-server's own `language` default was `en`, which does not
   * mean "work it out" — it means "this IS English", and a Czech sentence came
   * back translated. Sending nothing lets a server that can detect do so; a
   * server that cannot has its own default either way.
   */
  language: string;
  /**
   * Switch the speaker ON when the app starts.
   *
   * Off by default, and that default is the point: an app that starts talking
   * the moment it opens is one you turn off and never turn on again. Speaking
   * has to be something you asked for that session.
   */
  onAtStart: boolean;
};
