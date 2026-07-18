import type { SearchLocale } from "./locale.js";

export const en: SearchLocale = {
  code: "en",
  isStopWord: (word) => STOP_WORDS.has(word),
  foldPlural,
};

const STOP_WORDS = new Set([
  "the",
  "a",
  "an",
  "of",
  "in",
  "on",
  "at",
  "to",
  "for",
  "and",
  "or",
  "is",
  "are",
  "with",
  "by",
  "it",
  "this",
  "that",
]);

// First matching rule wins; words under 4 characters are never folded.
function foldPlural(word: string): string {
  if (word.length < 4) return word;
  if (word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  if (/(?:s|x|z|ch|sh)es$/.test(word)) return word.slice(0, -2);
  if (word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);
  return word;
}
