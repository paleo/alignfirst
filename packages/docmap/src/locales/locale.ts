// Words handed to a locale are already lowercased and accent-folded ("à" arrives as "a",
// "œ" as "oe"). Locale rules apply to query words only — document tokens are never mutated.
export interface SearchLocale {
  code: string; // "en", "fr"
  isStopWord(word: string): boolean;
  // Prefix-stems a singular or plural surface form so that both forms contain the result
  // ("dependency" and "dependencies" -> "dependenc"). Unchanged when no rule applies.
  stemWord(word: string): string;
  // The other number of an irregular word ("index" -> "indices", "indices" -> "index").
  irregularOf(word: string): string | undefined;
}
