import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { type } from "arktype";

export const MARKER_FILENAME = ".alignfirst-projects.json";

const portRangeSchema = type({
  "+": "reject",
  first: "1 <= number.integer <= 65535",
  last: "1 <= number.integer <= 65535",
});
const markerSchema = type({
  "+": "reject",
  "description?": "string",
  "portRange?": portRangeSchema,
});

export interface ProjectsMarker {
  description?: string;
  portRange?: PortRange;
}

export interface PortRange {
  first: number;
  last: number;
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
  if (marker.portRange !== undefined) assertValidPortRange(marker.portRange, path);
  return marker;
}

export function writeMarker(dir: string, marker: ProjectsMarker): void {
  writeFileSync(join(dir, MARKER_FILENAME), `${JSON.stringify(marker, undefined, 2)}\n`);
}

export function assertValidPortRange(range: PortRange, label: string): void {
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

function invalidMarker(path: string, detail: string): Error {
  return new Error(`Invalid projects marker ${path}: ${detail}`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
