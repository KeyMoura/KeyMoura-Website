import "server-only";

import { installerAdmin } from "@/lib/installer/server";

/** Service-side admission check shared by every token and cookie authorization path. */
export async function isUserAdmitted(userId: string): Promise<boolean> {
  if (!userId) return false;
  try {
    const { data, error } = await installerAdmin()
      .from("account_admissions")
      .select("user_id")
      .eq("user_id", userId)
      .maybeSingle();
    return !error && Boolean(data);
  } catch {
    return false;
  }
}
