// Words handed to a locale are already lowercased and accent-folded ("à" arrives as "a").
export interface SearchLocale {
  code: string; // "en", "fr"
  isStopWord(word: string): boolean;
  // Returns the word unchanged when no rule applies.
  foldPlural(word: string): string;
}
