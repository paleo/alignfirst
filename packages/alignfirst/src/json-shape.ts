const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

export type Check<T> = (value: unknown, path: string) => T;

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

/** Rejects the first unknown key, then checks each field in declaration order. */
export function object<T extends object>(fields: Fields<T>): Check<T> {
  const entries: [string, Check<unknown> | OptionalField<unknown>][] = Object.entries(fields);
  return (value, path) => {
    if (!isPlainObject(value)) throw shapeError(path, "be an object");
    const unknownKey = Object.keys(value).find((key) => !Object.hasOwn(fields, key));
    if (unknownKey !== undefined) throw shapeError(childPath(path, unknownKey), "be removed");
    const result: Record<string, unknown> = {};
    for (const [key, field] of entries) {
      const fieldPath = childPath(path, key);
      if (typeof field === "function") result[key] = field(value[key], fieldPath);
      else if (value[key] !== undefined) result[key] = field.optional(value[key], fieldPath);
    }
    // The fields mirror T key by key.
    return result as T;
  };
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

export function shapeError(path: string, expectation: string): Error {
  return new ShapeError(`${path === "" ? "value" : path} must ${expectation}`);
}

export function optional<T>(check: Check<T>): OptionalField<T> {
  return { optional: check };
}

export function record<T>(check: Check<T>): Check<Record<string, T>> {
  return (value, path) => {
    if (!isPlainObject(value)) throw shapeError(path, "be an object");
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, check(item, childPath(path, key))]),
    );
  };
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

export function boolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw shapeError(path, "be a boolean");
  return value;
}
