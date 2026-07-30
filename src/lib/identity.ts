import { isRecord, isString } from "./typeGuards";

/**
 * A minimal shape for user-facing profile identity.
 */
export type DisplayIdentity = {
  username?: string | null;
  display_name?: string | null;
};

/**
 * Normalizes a username into a consistent, lowercased handle.
 */
export function normalizeUsername(value: unknown): string | null {
  if (!isString(value)) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed;
}

/**
 * Builds a consistent display name used throughout the UI.
 *
 * Order:
 * 1) `display_name` if non-empty
 * 2) `username` if non-empty
 * 3) fallback "User"
 */
export function formatDisplayName(identity: unknown): string {
  const record = isRecord(identity) ? identity : null;
  const display = record && isString(record.display_name) ? record.display_name.trim() : "";
  if (display) return display;

  const username = record && isString(record.username) ? record.username.trim() : "";
  if (username) return username;

  return "User";
}

/**
 * Builds a consistent "@handle" representation.
 */
export function formatHandle(identity: unknown): string | null {
  const record = isRecord(identity) ? identity : null;
  const username = record && isString(record.username) ? record.username.trim() : "";
  if (!username) return null;
  return username.startsWith("@") ? username : `@${username}`;
}

/**
 * Returns the first letter used for avatar placeholders.
 */
export function getAvatarInitial(identity: unknown): string {
  const name = formatDisplayName(identity);
  const first = name.trim().charAt(0);
  return first ? first.toUpperCase() : "U";
}

/**
 * Extracts a safe identity object from an unknown profile record.
 */
export function pickDisplayIdentity(value: unknown): DisplayIdentity {
  if (!isRecord(value)) return {};

  const username = isString(value.username) ? value.username : null;
  const display_name = isString(value.display_name) ? value.display_name : null;

  return { username, display_name };
}
