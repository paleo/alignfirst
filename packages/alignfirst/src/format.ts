import { isAbsolute, relative, sep } from "node:path";

const KIB = 1024;
const MIB = KIB * KIB;

export function formatSize(bytes: number): string {
  if (bytes < KIB) return `${bytes} B`;
  if (bytes < MIB) return `${trimDecimal(bytes / KIB)} KiB`;
  return `${trimDecimal(bytes / MIB)} MiB`;
}

function trimDecimal(value: number): string {
  return value.toFixed(1).replace(/\.0$/, "");
}

export function formatLocalTimestamp(date: Date): string {
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes < 0 ? "-" : "+";
  const offset = Math.abs(offsetMinutes);
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  return `${day}T${time}${sign}${pad(Math.floor(offset / 60))}:${pad(offset % 60)}`;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/** Relative to `cwd` when inside it, absolute otherwise. */
export function displayPath(cwd: string, path: string): string {
  const rel = relative(cwd, path);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return path;
  return rel;
}
