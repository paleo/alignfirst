const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
// Two-character operators first, so `<=` is not read as `<`.
const OPERATORS = ["<=", ">=", "<", ">", "=", "~", "^"] as const;

type Operator = (typeof OPERATORS)[number];

interface Comparator {
  operator: "<" | "<=" | ">" | ">=" | "=";
  version: Version;
}

interface Version {
  major: number;
  minor: number;
  patch: number;
}

export function isValidVersionRange(range: string): boolean {
  return parseRange(range) !== undefined;
}

/** False for a version with a prerelease tag or an invalid range. */
export function satisfiesRange(version: string, range: string): boolean {
  const parsed = parseVersion(version);
  const sets = parseRange(range);
  if (parsed === undefined || sets === undefined) return false;
  return sets.some((set) => set.every((comparator) => holds(comparator, parsed)));
}

/** True when `version` is above every version the range accepts. */
export function isAheadOfRange(version: string, range: string): boolean {
  const parsed = parseVersion(version);
  const sets = parseRange(range);
  if (parsed === undefined || sets === undefined) return false;
  return sets.every((set) => set.some((comparator) => exceeds(comparator, parsed)));
}

function parseVersion(text: string): Version | undefined {
  const match = VERSION.exec(text);
  if (match === null) return;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

function parseRange(range: string): Comparator[][] | undefined {
  const sets: Comparator[][] = [];
  for (const part of range.split("||")) {
    const set = parseComparatorSet(part.trim());
    if (set === undefined) return;
    sets.push(set);
  }
  return sets;
}

function parseComparatorSet(text: string): Comparator[] | undefined {
  if (text === "") return;
  const comparators: Comparator[] = [];
  for (const token of text.split(/\s+/)) {
    const desugared = parseComparator(token);
    if (desugared === undefined) return;
    comparators.push(...desugared);
  }
  return comparators;
}

function parseComparator(token: string): Comparator[] | undefined {
  const operator = OPERATORS.find((candidate) => token.startsWith(candidate));
  const version = parseVersion(operator === undefined ? token : token.slice(operator.length));
  if (version === undefined) return;
  return desugar(operator ?? "=", version);
}

function desugar(operator: Operator, version: Version): Comparator[] {
  if (operator === "~") {
    const upper = { major: version.major, minor: version.minor + 1, patch: 0 };
    return [lowerBound(version), { operator: "<", version: upper }];
  }
  if (operator === "^")
    return [lowerBound(version), { operator: "<", version: caretUpper(version) }];
  return [{ operator, version }];
}

function lowerBound(version: Version): Comparator {
  return { operator: ">=", version };
}

function caretUpper({ major, minor, patch }: Version): Version {
  if (major > 0) return { major: major + 1, minor: 0, patch: 0 };
  if (minor > 0) return { major: 0, minor: minor + 1, patch: 0 };
  return { major: 0, minor: 0, patch: patch + 1 };
}

function holds({ operator, version }: Comparator, candidate: Version): boolean {
  const order = compareVersions(candidate, version);
  switch (operator) {
    case "<":
      return order < 0;
    case "<=":
      return order <= 0;
    case ">":
      return order > 0;
    case ">=":
      return order >= 0;
    case "=":
      return order === 0;
  }
}

function compareVersions(left: Version, right: Version): number {
  return left.major - right.major || left.minor - right.minor || left.patch - right.patch;
}

/** A set is exceeded when the candidate fails one of its upper bounds on the high side. */
function exceeds({ operator, version }: Comparator, candidate: Version): boolean {
  const order = compareVersions(candidate, version);
  if (operator === "<") return order >= 0;
  if (operator === "<=" || operator === "=") return order > 0;
  return false;
}
