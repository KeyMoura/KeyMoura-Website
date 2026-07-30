/**
 * A small set of runtime type guards used across the app.
 *
 * The goal is to keep parsing/validation consistent and `unknown`-safe without using `any`.
 */

/**
 * Returns true when the provided value is a non-null object.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Returns true when the provided value is a string.
 */
export function isString(value: unknown): value is string {
  return typeof value === "string";
}

/**
 * Returns true when the provided value is a finite number.
 */
export function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Returns true when the provided value is a boolean.
 */
export function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

/**
 * Returns true when the provided value is an array.
 */
export function isArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

/**
 * Returns true when the provided value is a record containing a string property.
 */
export function hasStringKey<K extends string>(
  value: unknown,
  key: K
): value is Record<K, string> & Record<string, unknown> {
  return isRecord(value) && isString(value[key]);
}
