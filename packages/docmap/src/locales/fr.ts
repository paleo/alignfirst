import type { SearchLocale } from "./locale.js";

export const fr: SearchLocale = {
  code: "fr",
  isStopWord: (word) => STOP_WORDS.has(word),
  foldPlural,
};

// Folded forms: checks run on accent-folded words, so "a" also covers "à".
const STOP_WORDS = new Set([
  "le",
  "la",
  "les",
  "l",
  "un",
  "une",
  "des",
  "de",
  "du",
  "d",
  "a",
  "et",
  "ou",
  "est",
  "sont",
  "avec",
  "par",
  "pour",
  "dans",
  "sur",
  "au",
  "aux",
  "ce",
  "cette",
  "ces",
]);

// First matching rule wins; words under 4 characters are never folded. A bare "-aux" that is not
// an "-al" plural folds wrong (tuyaux -> tuyal) — acceptable, folding feeds matching, never display.
function foldPlural(word: string): string {
  if (word.length < 4) return word;
  if (word.endsWith("eaux")) return word.slice(0, -1);
  if (word.endsWith("aux")) return `${word.slice(0, -3)}al`;
  if (word.endsWith("eux")) return word.slice(0, -1);
  if (word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);
  return word;
}
