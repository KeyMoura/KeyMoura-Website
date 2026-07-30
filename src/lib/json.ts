import { NextRequest } from "next/server";
import { isRecord } from "./typeGuards";

/**
 * Parses a request JSON body as `unknown`.
 *
 * Returns `null` when the body is missing or invalid JSON.
 */
export async function readJson(req: NextRequest): Promise<unknown | null> {
  try {
    return await req.json();
  } catch {
    return null;
  }
}

/**
 * Parses a JSON response as `unknown`.
 *
 * Returns `null` when the body is missing or invalid JSON.
 */
export async function readJsonFromResponse(res: Response): Promise<unknown | null> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * Converts an unknown JSON payload to a record.
 */
export function asRecord(payload: unknown): Record<string, unknown> | null {
  return isRecord(payload) ? payload : null;
}
