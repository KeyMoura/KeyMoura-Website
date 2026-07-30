"use client";

import { createBrowserClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

const globalForSupabase = globalThis as unknown as {
  _supabaseBrowserClient?: SupabaseClient;
};

/**
 * Parses `document.cookie` into a list of cookie name/value pairs.
 */
function getAllCookies(): Array<{ name: string; value: string }> {
  const raw = typeof document === "undefined" ? "" : document.cookie;
  if (!raw) return [];

  return raw
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => {
      const idx = part.indexOf("=");
      if (idx < 0) return { name: part, value: "" };
      const name = part.slice(0, idx).trim();
      const value = part.slice(idx + 1);
      return { name, value };
    });
}

/**
 * Normalizes `sameSite` to a value accepted by `document.cookie`.
 */
function normalizeSameSite(value: boolean | "lax" | "strict" | "none" | undefined): "Lax" | "Strict" | "None" | undefined {
  if (value === undefined) return undefined;
  if (value === false) return undefined;
  if (value === true) return "Lax";
  if (value === "none") return "None";
  if (value === "strict") return "Strict";
  return "Lax";
}

/**
 * Writes cookies using `document.cookie`.
 */
function setAllCookies(
  cookies: Array<{
    name: string;
    value: string;
    options?: {
      domain?: string;
      path?: string;
      expires?: Date;
      httpOnly?: boolean;
      secure?: boolean;
      sameSite?: boolean | "lax" | "strict" | "none";
      maxAge?: number;
    };
  }>
): void {
  if (typeof document === "undefined") return;

  for (const cookie of cookies) {
    const opts = cookie.options ?? {};
    const parts: string[] = [];

    parts.push(`${cookie.name}=${cookie.value}`);
    parts.push(`Path=${opts.path ?? "/"}`);

    if (typeof opts.maxAge === "number") {
      parts.push(`Max-Age=${Math.trunc(opts.maxAge)}`);
    }
    if (opts.expires) {
      parts.push(`Expires=${opts.expires.toUTCString()}`);
    }
    if (opts.domain) {
      parts.push(`Domain=${opts.domain}`);
    }
    if (opts.secure) {
      parts.push("Secure");
    }

    void opts.httpOnly;

    const sameSite = normalizeSameSite(opts.sameSite);
    if (sameSite) {
      parts.push(`SameSite=${sameSite}`);
    }

    document.cookie = parts.join("; ");
  }
}

/**
 * Returns a singleton Supabase browser client configured to read/write session cookies.
 */
export function supabaseBrowser(): SupabaseClient {
  if (!globalForSupabase._supabaseBrowserClient) {
    globalForSupabase._supabaseBrowserClient = createBrowserClient(supabaseUrl, supabaseAnonKey, {
      cookies: {
        getAll() {
          return getAllCookies();
        },
        setAll(cookies) {
          setAllCookies(cookies);
        },
      },
      auth: {
        flowType: "pkce",
      },
    });
  }

  return globalForSupabase._supabaseBrowserClient;
}
