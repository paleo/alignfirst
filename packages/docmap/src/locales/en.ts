import type { SearchLocale } from "./locale.js";

export const en: SearchLocale = {
  code: "en",
  isStopWord: (word) => STOP_WORDS.has(word),
  stemWord,
  irregularOf: (word) => IRREGULARS.get(word),
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

// Each rule strips a plural or singular suffix, leaving a prefix shared by both numbers
// ("boxes" -> "box"; "dependency" and "dependencies" -> "dependenc").
const STEM_RULES: [RegExp, number][] = [
  [/ies$/, 3],
  [/[^aeiou]y$/, 1],
  [/(?:s|x|z|ch|sh)es$/, 2],
  [/[^s]s$/, 1],
];

// Mutating plurals no prefix rule covers, both directions.
const IRREGULAR_PAIRS: [string, string][] = [
  ["index", "indices"],
  ["vertex", "vertices"],
  ["matrix", "matrices"],
  ["appendix", "appendices"],
  ["analysis", "analyses"],
  ["axis", "axes"],
  ["basis", "bases"],
  ["child", "children"],
  ["leaf", "leaves"],
  ["half", "halves"],
  ["person", "people"],
  ["foot", "feet"],
];

const IRREGULARS = new Map(
  IRREGULAR_PAIRS.flatMap(([a, b]): [string, string][] => [
    [a, b],
    [b, a],
  ]),
);

// First rule that matches and leaves a stem of at least 3 characters wins ("axes" skips the
// -es rule for the -s rule); words under 4 characters are never stemmed.
function stemWord(word: string): string {
  if (word.length < 4) return word;
  for (const [suffix, strip] of STEM_RULES) {
    if (suffix.test(word) && word.length - strip >= 3) return word.slice(0, -strip);
  }
  return word;
}
