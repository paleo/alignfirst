import type { SearchLocale } from "./locale.js";

export const fr: SearchLocale = {
  code: "fr",
  isStopWord: (word) => STOP_WORDS.has(word),
  stemWord,
  irregularOf: (word) => IRREGULARS.get(word),
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

// Each rule strips a plural or singular suffix, leaving a prefix shared by both numbers
// ("gateaux" -> "gateau"; "cheval" and "chevaux" -> "cheva").
const STEM_RULES: [RegExp, number][] = [
  [/eaux$/, 1],
  [/aux$/, 2],
  [/al$/, 1],
  [/eux$/, 1],
  [/[^s]s$/, 1],
];

// Mutating plurals no prefix rule covers, both directions.
const IRREGULAR_PAIRS: [string, string][] = [
  ["travail", "travaux"],
  ["oeil", "yeux"],
  ["ciel", "cieux"],
];

const IRREGULARS = new Map(
  IRREGULAR_PAIRS.flatMap(([a, b]): [string, string][] => [
    [a, b],
    [b, a],
  ]),
);

// First rule that matches and leaves a stem of at least 3 characters wins; words under
// 4 characters are never stemmed.
function stemWord(word: string): string {
  if (word.length < 4) return word;
  for (const [suffix, strip] of STEM_RULES) {
    if (suffix.test(word) && word.length - strip >= 3) return word.slice(0, -strip);
  }
  return word;
}
