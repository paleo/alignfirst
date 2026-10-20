const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

// Warning paths redact record keys; validation paths retain their exact field identity.
export type Check<T> = (value: unknown, path: string, warningPath?: string) => T;

export interface OptionalField<T> {
  optional: Check<T>;
}

// Each key of T maps to a checker; optional keys of T require `optional(...)`.
type Fields<T> = {
  [K in keyof T]-?: undefined extends T[K] ? OptionalField<Exclude<T[K], undefined>> : Check<T[K]>;
};

class ShapeError extends Error {}

/** Runs `check` at the root; a shape failure becomes `toError(<message>)`. */
export function parseShape<T>(
  check: Check<T>,
  value: unknown,
  toError: (detail: string) => Error,
): T {
  try {
    return check(value, "");
  } catch (error) {
    if (error instanceof ShapeError) throw toError(error.message);
    throw error;
  }
}

export function object<T extends object>(
  fields: Fields<T>,
  onUnknown?: (path: string, key: string) => void,
): Check<T> {
  const entries: [string, Check<unknown> | OptionalField<unknown>][] = Object.entries(fields);
  return (value, path, warningPath = path) => {
    if (!isPlainObject(value)) throw shapeError(path, "be an object");
    for (const key of Object.keys(value)) {
      if (Object.hasOwn(fields, key)) continue;
      if (onUnknown === undefined) throw shapeError(childPath(path, key), "be removed");
      onUnknown(warningPath, key);
    }
    const result: Record<string, unknown> = {};
    for (const [key, field] of entries) {
      const fieldPath = childPath(path, key);
      const fieldWarningPath = childPath(warningPath, key);
      if (typeof field === "function") result[key] = field(value[key], fieldPath, fieldWarningPath);
      else if (value[key] !== undefined)
        result[key] = field.optional(value[key], fieldPath, fieldWarningPath);
    }
    // The fields mirror T key by key.
    return result as T;
  };
}

export function record<T>(
  check: Check<T>,
  keyCheck: Check<string> = string,
): Check<Record<string, T>> {
  return (value, path, warningPath = path) => {
    if (!isPlainObject(value)) throw shapeError(path, "be an object");
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => {
        const fieldPath = childPath(path, key);
        keyCheck(key, fieldPath);
        return [key, check(item, fieldPath, `${warningPath}[<entry>]`)];
      }),
    );
  };
}

export function nonblankString(value: unknown, path: string): string {
  const text = string(value, path);
  if (text.trim() === "") throw shapeError(path, "be nonblank");
  return text;
}

export function nulFreeString(value: unknown, path: string): string {
  const text = string(value, path);
  if (text.includes("\u0000")) throw shapeError(path, "contain no NUL characters");
  return text;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function childPath(path: string, key: string): string {
  if (!IDENTIFIER.test(key)) return bracketPath(path, JSON.stringify(key));
  return path === "" ? key : `${path}.${key}`;
}

function bracketPath(path: string, segment: string): string {
  return `${path === "" ? "value" : path}[${segment}]`;
}

function shapeError(path: string, expectation: string): Error {
  return new ShapeError(`${path === "" ? "value" : path} must ${expectation}`);
}

export function optional<T>(check: Check<T>): OptionalField<T> {
  return { optional: check };
}

export function literal<const T extends readonly (string | number)[]>(
  ...values: T
): Check<T[number]> {
  const expectation = `be ${listOf(values.map((item) => JSON.stringify(item)))}`;
  return (value, path) => {
    const match = values.find((item) => item === value);
    if (match === undefined) throw shapeError(path, expectation);
    return match;
  };
}

function listOf(items: string[]): string {
  if (items.length === 1) return items[0];
  return `${items.slice(0, -1).join(", ")} or ${items.at(-1)}`;
}

export function integerBetween(min: number, max: number): Check<number> {
  return (value, path) => {
    if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max)
      throw shapeError(path, `be an integer from ${min} to ${max}`);
    return value;
  };
}

export function nonEmptyString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0)
    throw shapeError(path, "be a non-empty string");
  return value;
}

export function string(value: unknown, path: string): string {
  if (typeof value !== "string") throw shapeError(path, "be a string");
  return value;
}

export function boolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw shapeError(path, "be a boolean");
  return value;
}

export function matching(pattern: RegExp): Check<string> {
  return (value, path) => {
    const text = string(value, path);
    if (!pattern.test(text)) throw shapeError(path, `match ${String(pattern)}`);
    return text;
  };
}

export function arrayOf<T>(check: Check<T>): Check<T[]> {
  return (value, path, warningPath = path) => {
    if (!Array.isArray(value)) throw shapeError(path, "be an array");
    return value.map((item, index) =>
      check(item, bracketPath(path, String(index)), bracketPath(warningPath, String(index))),
    );
  };
}

export function nonEmptyArrayOf<T>(check: Check<T>): Check<T[]> {
  const checkArray = arrayOf(check);
  return (value, path, warningPath = path) => {
    const items = checkArray(value, path, warningPath);
    if (items.length === 0) throw shapeError(path, "be a non-empty array");
    return items;
  };
}
