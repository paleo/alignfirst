import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { type } from "arktype";

import { errorMessage } from "../errors.js";
import { formatRange } from "./format.js";

export const MARKER_FILENAME = ".alignfirst-projects.json";

const markerPortRangeSchema = type({
  "+": "reject",
  first: "1 <= number.integer <= 65535",
  last: "1 <= number.integer <= 65535",
  "code?": /^[a-z][a-z0-9-]*$/,
  "description?": "string",
});
const markerSchema = type({
  "+": "reject",
  "description?": "string",
  "portRanges?": markerPortRangeSchema.array().atLeastLength(1),
});

export interface PortRange {
  first: number;
  last: number;
}

export interface ProjectsMarker {
  description?: string;
  portRanges?: MarkerPortRange[];
}

export interface MarkerPortRange extends PortRange {
  code?: string;
  description?: string;
}

export function readMarker(dir: string): ProjectsMarker | undefined {
  const path = join(dir, MARKER_FILENAME);
  if (!existsSync(path)) return;
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw invalidMarker(path, errorMessage(error));
  }
  const marker = markerSchema(value);
  if (marker instanceof type.errors) {
    throw invalidMarker(path, marker.summary.split("\n", 1)[0]);
  }
  if (marker.portRanges !== undefined) assertValidPortRanges(marker.portRanges, path);
  return marker;
}

export function writeMarker(dir: string, marker: ProjectsMarker): void {
  writeFileSync(join(dir, MARKER_FILENAME), `${JSON.stringify(marker, undefined, 2)}\n`);
}

export function assertValidPortRanges(ranges: MarkerPortRange[], label: string): void {
  for (const range of ranges) assertValidPortRange(range, label);
  assertUniquePortRangeCodes(ranges, label);
  if (ranges.filter(({ code }) => code === undefined).length > 1) {
    throw new Error(`Invalid ${label}: at most one port range may have no code`);
  }
  for (let index = 0; index < ranges.length; ++index) {
    const range = ranges[index];
    for (let previous = 0; previous < index; ++previous) {
      const other = ranges[previous];
      if (!rangesOverlap(range, other)) continue;
      throw new Error(
        `Invalid ${label}: port ranges ${formatRange(other)} and ${formatRange(range)} overlap`,
      );
    }
  }
}

function assertValidPortRange(range: PortRange, label: string): void {
  if (
    !Number.isInteger(range.first) ||
    !Number.isInteger(range.last) ||
    range.first < 1 ||
    range.first > 65_535 ||
    range.last < 1 ||
    range.last > 65_535
  ) {
    throw new Error(`Invalid ${label}: port range endpoints must be integers from 1 to 65535`);
  }
  if (range.first > range.last) {
    throw new Error(`Invalid ${label}: portRange.first must not exceed portRange.last`);
  }
}

function assertUniquePortRangeCodes(ranges: MarkerPortRange[], label: string): void {
  const codes = new Set<string>();
  for (const { code } of ranges) {
    if (code === undefined) continue;
    if (codes.has(code)) {
      throw new Error(`Invalid ${label}: duplicate port range code ${JSON.stringify(code)}`);
    }
    codes.add(code);
  }
}

export function containsRange(available: PortRange, allocation: PortRange): boolean {
  return allocation.first >= available.first && allocation.last <= available.last;
}

export function rangesOverlap(left: PortRange, right: PortRange): boolean {
  return left.first <= right.last && right.first <= left.last;
}

function invalidMarker(path: string, detail: string): Error {
  return new Error(`Invalid projects marker ${path}: ${detail}`);
}
