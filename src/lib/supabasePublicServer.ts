import { createClient } from "@supabase/supabase-js";

/**
 * A server-side Supabase client that reads as the public.
 *
 * The product page renders public catalog data — published products, their
 * media, their options, their category. All four are readable by `anon` under
 * RLS, which is exactly why the old client-side page worked with the browser's
 * anon key.
 *
 * Using `supabaseAdmin()` (service role) here would have been the obvious move,
 * since the homepage already does it. It is the wrong one:
 *
 * 1. **It reads more than it should.** Service role has `BYPASSRLS`, so a typo
 *    in a filter — a missing `.eq("is_published", true)` — silently serves an
 *    unpublished draft instead of returning nothing. With the anon key the
 *    policy is a second, independent guard behind every query on this page.
 * 2. **It cannot be exercised locally.** `.env.local` carries a deliberately
 *    fake `SUPABASE_SERVICE_ROLE_KEY`, so every service-role read fails on this
 *    machine. Passes 3, 4 and 5 each recorded "the data path was not verified
 *    locally" for that reason. The anon key is real, so the product page's real
 *    query runs in local browser testing.
 *
 * No session is attached and none is wanted: this is the same data for every
 * visitor, which is what makes the page cacheable.
 */
export function supabasePublicServer() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !anonKey) {
    throw new Error("Supabase public client missing URL or anon key.");
  }

  return createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
