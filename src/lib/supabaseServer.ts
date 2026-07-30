import { createClient } from "@supabase/supabase-js";

export const supabaseAdmin = () => {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceKey) {
    throw new Error("Supabase admin client missing URL or service role key.");
  }

  return createClient(url, serviceKey);
};
