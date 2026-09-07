/**
 * What whisper calls each language.
 *
 * The table is lifted from whisper.cpp, so these tests are about the lookup
 * being honest rather than about the data — an unknown code must answer "no",
 * not throw and not guess.
 */
import { assertEquals } from "@std/assert";
import { isLanguage, WHISPER_LANGUAGES } from "../../lib/languages.ts";

Deno.test("isLanguage — the codes this app offers all resolve", () => {
  // Every language the Voice panel can offer has to be checkable, or naming
  // it as one you speak would silently never match what whisper answered.
  for (
    const code of [
      "en",
      "cs",
      "sk",
      "pl",
      "de",
      "nl",
      "es",
      "pt",
      "fr",
      "it",
      "hu",
      "ro",
      "uk",
      "ru",
      "tr",
      "ar",
      "hi",
      "ne",
      "zh",
      "ja",
      "ko",
    ]
  ) {
    assertEquals(typeof WHISPER_LANGUAGES[code], "string", code);
  }
  assertEquals(WHISPER_LANGUAGES.cs, "czech");
  assertEquals(WHISPER_LANGUAGES.ne, "nepali");
});

Deno.test("isLanguage — matches whisper's own spelling, and only that", () => {
  assertEquals(isLanguage("cs", "czech"), true);
  assertEquals(isLanguage("CS", " Czech "), true); // both sides normalised
  assertEquals(isLanguage("cs", "polish"), false);
  // The confusable neighbours are separate answers, which is the whole point.
  assertEquals(isLanguage("sk", "czech"), false);
  assertEquals(isLanguage("pl", "czech"), false);
  // A code the table has never heard of answers no rather than throwing: that
  // is exactly the case that should fall through to being checked properly.
  assertEquals(isLanguage("xx", "czech"), false);
  assertEquals(isLanguage("", ""), false);
});
