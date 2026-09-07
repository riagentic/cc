/**
 * @module
 * What whisper calls each language.
 *
 * Its `verbose_json` answer names the language it detected — "czech", not
 * "cs" — so deciding whether that is a language you actually speak needs the
 * translation back. Lifted verbatim from `g_lang` in whisper.cpp, which is the
 * only definition that is guaranteed to match what the server will say.
 */

/** Code to whisper's own name for it. All 100 the model knows. */
export const WHISPER_LANGUAGES: Readonly<Record<string, string>> = {
  en: "english",
  zh: "chinese",
  de: "german",
  es: "spanish",
  ru: "russian",
  ko: "korean",
  fr: "french",
  ja: "japanese",
  pt: "portuguese",
  tr: "turkish",
  pl: "polish",
  ca: "catalan",
  nl: "dutch",
  ar: "arabic",
  sv: "swedish",
  it: "italian",
  id: "indonesian",
  hi: "hindi",
  fi: "finnish",
  vi: "vietnamese",
  he: "hebrew",
  uk: "ukrainian",
  el: "greek",
  ms: "malay",
  cs: "czech",
  ro: "romanian",
  da: "danish",
  hu: "hungarian",
  ta: "tamil",
  no: "norwegian",
  th: "thai",
  ur: "urdu",
  hr: "croatian",
  bg: "bulgarian",
  lt: "lithuanian",
  la: "latin",
  mi: "maori",
  ml: "malayalam",
  cy: "welsh",
  sk: "slovak",
  te: "telugu",
  fa: "persian",
  lv: "latvian",
  bn: "bengali",
  sr: "serbian",
  az: "azerbaijani",
  sl: "slovenian",
  kn: "kannada",
  et: "estonian",
  mk: "macedonian",
  br: "breton",
  eu: "basque",
  is: "icelandic",
  hy: "armenian",
  ne: "nepali",
  mn: "mongolian",
  bs: "bosnian",
  kk: "kazakh",
  sq: "albanian",
  sw: "swahili",
  gl: "galician",
  mr: "marathi",
  pa: "punjabi",
  si: "sinhala",
  km: "khmer",
  sn: "shona",
  yo: "yoruba",
  so: "somali",
  af: "afrikaans",
  oc: "occitan",
  ka: "georgian",
  be: "belarusian",
  tg: "tajik",
  sd: "sindhi",
  gu: "gujarati",
  am: "amharic",
  yi: "yiddish",
  lo: "lao",
  uz: "uzbek",
  fo: "faroese",
  ht: "haitian creole",
  ps: "pashto",
  tk: "turkmen",
  nn: "nynorsk",
  mt: "maltese",
  sa: "sanskrit",
  lb: "luxembourgish",
  my: "myanmar",
  bo: "tibetan",
  tl: "tagalog",
  mg: "malagasy",
  as: "assamese",
  tt: "tatar",
  haw: "hawaiian",
  ln: "lingala",
  ha: "hausa",
  ba: "bashkir",
  jw: "javanese",
  su: "sundanese",
  yue: "cantonese",
};

/**
 * Is this what whisper meant by that code?
 *
 * Both directions are normalised, and an unknown code answers `false` rather
 * than throwing — a language this table has never heard of is exactly the case
 * that should fall through to being checked properly.
 */
export const isLanguage = (code: string, whisperSaid: string): boolean => {
  const name = WHISPER_LANGUAGES[code.trim().toLowerCase()];
  return name !== undefined && name === whisperSaid.trim().toLowerCase();
};
