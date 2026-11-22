const MENTION = /\balignfirst context\b/;
const LAUNCHED_MENTION = /`[^`\n]*alignfirst context`/g;
const LEGACY_HEADING = "Docmap - Seek Documentation";

export type InstructionStatus = InstructionDiagnosis["status"];

export interface InstructionFile {
  path: string;
  content: string;
}

export type InstructionDiagnosis = UnmatchedDiagnosis | MatchedDiagnosis;

export interface UnmatchedDiagnosis {
  status: "absent" | "ambiguous";
  /** Every mention. */
  locations: BootstrapLocation[];
  legacySections: SectionLocation[];
}

export interface MatchedDiagnosis {
  status: "current" | "differs";
  /** The single matched section. */
  locations: [BootstrapLocation];
  /** Its heading and the paragraph holding the mention. */
  current: string;
  legacySections: SectionLocation[];
}

export interface BootstrapLocation {
  path: string;
  /** 1-based. */
  line: number;
  /** The level-2 heading of the section, absent for a mention outside any section. */
  heading?: string;
}

export interface SectionLocation {
  path: string;
  /** 1-based. */
  line: number;
  heading: string;
}

interface ScannedFile {
  lines: string[];
  headings: Heading[];
  /** 0-based line indexes. */
  mentions: number[];
}

interface Heading {
  /** 0-based. */
  index: number;
  level: number;
}

interface Mention {
  path: string;
  scanned: ScannedFile;
  /** 0-based. */
  line: number;
  section?: Heading;
}

interface SectionMention extends Mention {
  section: Heading;
}

/** Diagnoses the bootstrap section of the instruction files against the canonical section. */
export function diagnoseInstructions(
  files: InstructionFile[],
  canonical: string,
): InstructionDiagnosis {
  const scans = files.map((file) => ({ path: file.path, scanned: scanLines(file.content) }));
  const legacySections = scans.flatMap(({ path, scanned }) => findLegacySections(path, scanned));
  const mentions: Mention[] = scans.flatMap(({ path, scanned }) =>
    scanned.mentions.map((line) => ({
      path,
      scanned,
      line,
      section: enclosingSection(scanned, line),
    })),
  );
  if (mentions.length === 0) return { status: "absent", locations: [], legacySections };
  const sections = uniqueSections(mentions);
  if (sections.length !== 1 || !mentions.every(hasSection))
    return { status: "ambiguous", locations: mentions.map(mentionLocation), legacySections };
  const [section] = sections;
  const current = bootstrapText(section);
  const expected = canonicalBootstrapText(canonical);
  return {
    status: normalize(current) === normalize(expected) ? "current" : "differs",
    locations: [sectionLocation(section)],
    current,
    legacySections,
  };
}

function findLegacySections(path: string, scanned: ScannedFile): SectionLocation[] {
  return scanned.headings
    .filter(({ index, level }) => level === 2 && scanned.lines[index].includes(LEGACY_HEADING))
    .map(({ index }) => ({ path, line: index + 1, heading: scanned.lines[index] }));
}

/** The level-2 heading opening the section, `undefined` when the line is outside any. */
function enclosingSection(scanned: ScannedFile, line: number): Heading | undefined {
  const opening = scanned.headings.findLast(({ index, level }) => index <= line && level <= 2);
  return opening?.level === 2 ? opening : undefined;
}

/** The first mention of each distinct section. */
function uniqueSections(mentions: Mention[]): SectionMention[] {
  const unique = new Map<string, SectionMention>();
  for (const mention of mentions) {
    if (!hasSection(mention)) continue;
    const key = `${mention.path}\u0000${mention.section.index}`;
    if (!unique.has(key)) unique.set(key, mention);
  }
  return [...unique.values()];
}

function hasSection(mention: Mention): mention is SectionMention {
  return mention.section !== undefined;
}

function mentionLocation(mention: Mention): BootstrapLocation {
  if (!hasSection(mention)) return { path: mention.path, line: mention.line + 1 };
  return { ...sectionLocation(mention), line: mention.line + 1 };
}

function sectionLocation({ path, scanned, section }: SectionMention): BootstrapLocation {
  return { path, line: section.index + 1, heading: scanned.lines[section.index] };
}

function canonicalBootstrapText(canonical: string): string {
  const scanned = scanLines(canonical);
  const mention = scanned.mentions[0];
  const section = mention === undefined ? undefined : enclosingSection(scanned, mention);
  if (mention === undefined || section === undefined)
    throw new Error("The canonical bootstrap section has no level-2 heading or mention.");
  return bootstrapText({ path: "", scanned, line: mention, section });
}

/** The heading line and the paragraph holding the mention. */
function bootstrapText({ scanned, line, section }: SectionMention): string {
  return `${scanned.lines[section.index]}\n\n${paragraphAt(scanned, line)}`;
}

function paragraphAt({ lines, headings }: ScannedFile, index: number): string {
  const isBoundary = (i: number) =>
    lines[i].trim() === "" || headings.some((heading) => heading.index === i);
  if (headings.some((heading) => heading.index === index)) return "";
  let start = index;
  while (start > 0 && !isBoundary(start - 1)) --start;
  let end = index;
  while (end < lines.length - 1 && !isBoundary(end + 1)) ++end;
  return lines.slice(start, end + 1).join("\n");
}

function normalize(text: string): string {
  return text.replaceAll(LAUNCHED_MENTION, "`alignfirst context`").replaceAll(/\s+/g, " ").trim();
}

/**
 * Inserts the section before the first heading of level 2 or deeper outside a code fence, or
 * appends it when there is none.
 */
export function insertSection(content: string, section: string): string {
  const block = section.trim();
  if (content.trim() === "") return `${block}\n`;
  const { lines, headings } = scanLines(content);
  const target = headings.find(({ level }) => level >= 2);
  if (target === undefined) return `${content.trimEnd()}\n\n${block}\n`;
  const before = lines.slice(0, target.index).join("\n").trimEnd();
  const after = lines.slice(target.index).join("\n");
  return before === "" ? `${block}\n\n${after}` : `${before}\n\n${block}\n\n${after}`;
}

/** Skips a leading YAML frontmatter and fenced code blocks. */
function scanLines(content: string): ScannedFile {
  const lines = content.split(/\r?\n/);
  const headings: Heading[] = [];
  const mentions: number[] = [];
  let fence: string | undefined;
  for (let index = frontmatterEnd(lines); index < lines.length; ++index) {
    const line = lines[index];
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence !== undefined) {
      if (marker !== undefined && closesFence(marker, fence, line)) fence = undefined;
      continue;
    }
    if (marker !== undefined) {
      fence = marker;
      continue;
    }
    const level = /^ {0,3}(#{1,6})(?:[ \t]|$)/.exec(line)?.[1].length;
    if (level !== undefined) headings.push({ index, level });
    if (MENTION.test(line)) mentions.push(index);
  }
  return { lines, headings, mentions };
}

function frontmatterEnd(lines: string[]): number {
  if (lines[0]?.trim() !== "---") return 0;
  const close = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  return close === -1 ? 0 : close + 1;
}

function closesFence(marker: string, fence: string, line: string): boolean {
  return marker[0] === fence[0] && marker.length >= fence.length && line.trim() === marker;
}
