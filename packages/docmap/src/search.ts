import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  collectAllFiles,
  entryFromContent,
  type FileEntry,
  formatFileBullets,
  isMarkdown,
} from "./formatter.js";
import { locales } from "./locales/index.js";
import { stripFrontmatter } from "./parser.js";

const SEARCH_RESULT_CAP = 20;
// Naive TF saturation: a term repeated all over a tier counts at most this many times, so body
// spam maxes out below a single title hit.
const OCCURRENCE_CAP = 3;

export function searchDocs(baseDir: string, terms: string[], prefix: string): string[] {
  const queryTerms = prepareQueryTerms(terms);
  if (queryTerms.length === 0) return [];

  const matches: MatchedFile[] = [];
  for (const rel of collectAllFiles(baseDir, "")) {
    const match = scoreFile(baseDir, rel, queryTerms);
    if (match) matches.push(match);
  }
  matches.sort(compareMatches);

  const lines: string[] = [];
  for (const match of matches.slice(0, SEARCH_RESULT_CAP)) {
    lines.push(...formatFileBullets([match.entry], match.relDir, prefix));
  }
  if (matches.length > SEARCH_RESULT_CAP)
    lines.push(`… and ${matches.length - SEARCH_RESULT_CAP} more matches`);
  return lines;
}

// Splits incoming terms with the shared tokenizer (so "code-style" becomes two terms), folds
// them, and drops stopwords of any locale (docs trees mix languages). Stopwords are checked
// before plural folding so the sets keep natural forms ("this", "dans").
function prepareQueryTerms(terms: string[]): string[] {
  const words = terms.flatMap(tokenize).map(foldAccents);
  const kept = words.filter((word) => !isStopWord(word));
  // Safety valve: an all-stopwords query still searches with its own words.
  return (kept.length > 0 ? kept : words).map(foldPlural);
}

function isStopWord(word: string): boolean {
  return locales.some((locale) => locale.isStopWord(word));
}

interface MatchedFile {
  rel: string;
  relDir: string;
  entry: FileEntry;
  termsMatched: number;
  totalScore: number;
}

function scoreFile(baseDir: string, rel: string, queryTerms: string[]): MatchedFile | undefined {
  const slash = rel.lastIndexOf("/");
  const relDir = slash === -1 ? "" : rel.slice(0, slash);
  const name = slash === -1 ? rel : rel.slice(slash + 1);
  const content = readFileSync(join(baseDir, rel), "utf-8");
  const entry = entryFromContent(name, content);
  const tiers = buildTiers(rel, entry, content);

  let termsMatched = 0;
  let totalScore = 0;
  for (const term of queryTerms) {
    const score = scoreTerm(term, tiers);
    if (score === 0) continue;
    ++termsMatched;
    totalScore += score;
  }
  if (termsMatched === 0) return;
  return { rel, relDir, entry, termsMatched, totalScore };
}

interface Tier {
  weight: number;
  tokens: string[];
}

function buildTiers(rel: string, entry: FileEntry, content: string): Tier[] {
  const body = isMarkdown(entry.name) ? stripFrontmatter(content) : content;
  return [
    { weight: 3, tokens: foldTokens(joinDefined([rel, entry.title])) },
    { weight: 2, tokens: foldTokens(joinDefined([entry.summary, ...entry.readWhen])) },
    { weight: 1, tokens: foldTokens(body) },
  ];
}

function joinDefined(parts: (string | undefined)[]): string {
  return parts.filter((part): part is string => part !== undefined).join(" ");
}

// Per tier: occurrences = tokens containing the term (substring), capped. A token equal to the
// term in any tier earns a +1 word-boundary bonus, once per term.
function scoreTerm(term: string, tiers: Tier[]): number {
  let score = 0;
  let boundary = false;
  for (const tier of tiers) {
    let occurrences = 0;
    for (const token of tier.tokens) {
      if (!token.includes(term)) continue;
      ++occurrences;
      if (token === term) boundary = true;
    }
    score += tier.weight * Math.min(occurrences, OCCURRENCE_CAP);
  }
  return boundary ? score + 1 : score;
}

// Files matching more distinct terms always come first (former AND results lead), then higher
// total score, then path order for deterministic output.
function compareMatches(a: MatchedFile, b: MatchedFile): number {
  if (a.termsMatched !== b.termsMatched) return b.termsMatched - a.termsMatched;
  if (a.totalScore !== b.totalScore) return b.totalScore - a.totalScore;
  return a.rel < b.rel ? -1 : 1;
}

function foldTokens(text: string): string[] {
  return tokenize(text).map(foldWord);
}

function tokenize(text: string): string[] {
  return text.split(/[^\p{L}\p{N}]+/u).filter((token) => token.length > 0);
}

function foldWord(word: string): string {
  return foldPlural(foldAccents(word));
}

function foldAccents(word: string): string {
  return word.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "");
}

// The first locale whose rule changes the word wins; never chain locales (en "buses" -> "bus",
// then fr stripping the final -s again, would give "bu").
function foldPlural(word: string): string {
  for (const locale of locales) {
    const folded = locale.foldPlural(word);
    if (folded !== word) return folded;
  }
  return word;
}
