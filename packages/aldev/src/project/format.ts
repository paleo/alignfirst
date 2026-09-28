import type { PortRange } from "./markers.js";

export function formatRange(range: PortRange): string {
  return `${range.first}..${range.last}`;
}

/** Escapes C0, C1 and line-separator characters for a terminal-safe line. */
export function escapeControlCharacters(value: string): string {
  return Array.from(value, (character) => {
    if (!isControlCharacter(character, true)) return character;
    const jsonEscape = JSON.stringify(character).slice(1, -1);
    return jsonEscape === character ? unicodeEscape(character) : jsonEscape;
  }).join("");
}

/** Escapes the characters JSON.stringify leaves as-is: C1 and the line separators. */
export function escapeAdditionalJsonCharacters(value: string): string {
  return Array.from(value, (character) =>
    isControlCharacter(character, false) ? unicodeEscape(character) : character,
  ).join("");
}

function isControlCharacter(character: string, includeC0: boolean): boolean {
  const codePoint = character.codePointAt(0);
  if (codePoint === undefined) return false;
  return (
    (includeC0 && codePoint <= 0x1f) ||
    (codePoint >= 0x7f && codePoint <= 0x9f) ||
    codePoint === 0x2028 ||
    codePoint === 0x2029
  );
}

function unicodeEscape(character: string): string {
  const codePoint = character.codePointAt(0);
  if (codePoint === undefined) throw new Error("Cannot escape an empty character");
  return `\\u${codePoint.toString(16).padStart(4, "0")}`;
}
