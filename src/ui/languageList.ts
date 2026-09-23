/**
 * @module
 * The languages worth one click, shared by both speech panels.
 */
import { WHISPER_LANGUAGES } from "../lib/languages.ts";

/**
 * The languages worth naming, and "" is a real answer: Detect.
 *
 * A shortlist of a long list. Supertonic reads thirty-one, Kokoro eight and
 * whisper a hundred; offering all of any of them would be a scroll, and the
 * ones missing here can still be reached by choosing Detect and simply
 * speaking them. One list for reading and listening, so a language is offered
 * in both places or in neither.
 */
export const LANGUAGES: { id: string; label: string }[] = [
  { id: "", label: "Detect" },
  { id: "en", label: "English" },
  { id: "cs", label: "Czech" },
  { id: "sk", label: "Slovak" },
  { id: "pl", label: "Polish" },
  { id: "de", label: "German" },
  { id: "nl", label: "Dutch" },
  { id: "da", label: "Danish" },
  { id: "sv", label: "Swedish" },
  { id: "no", label: "Norwegian" },
  { id: "fi", label: "Finnish" },
  { id: "es", label: "Spanish" },
  { id: "pt", label: "Portuguese" },
  { id: "fr", label: "French" },
  { id: "it", label: "Italian" },
  { id: "ro", label: "Romanian" },
  { id: "el", label: "Greek" },
  { id: "hu", label: "Hungarian" },
  { id: "hr", label: "Croatian" },
  { id: "sr", label: "Serbian" },
  { id: "uk", label: "Ukrainian" },
  { id: "ru", label: "Russian" },
  { id: "tr", label: "Turkish" },
  { id: "ar", label: "Arabic" },
  { id: "fa", label: "Persian" },
  { id: "he", label: "Hebrew" },
  { id: "ka", label: "Georgian" },
  { id: "hi", label: "Hindi" },
  { id: "ne", label: "Nepali" },
  { id: "bn", label: "Bengali" },
  { id: "zh", label: "Chinese" },
  { id: "ja", label: "Japanese" },
  { id: "ko", label: "Korean" },
  { id: "vi", label: "Vietnamese" },
  { id: "id", label: "Indonesian" },
  { id: "sw", label: "Swahili" },
];

/** The same list, less whatever whisper cannot hear. */
export const HEARD_LANGUAGES: { id: string; label: string }[] = LANGUAGES
  .filter((l) => l.id === "" || l.id in WHISPER_LANGUAGES);
