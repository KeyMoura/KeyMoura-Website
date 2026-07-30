"use client";

import { useQuery } from "@tanstack/react-query";
import { supabaseBrowser } from "@/lib/supabaseClient";
import { isArray, isBoolean, isRecord, isString } from "@/lib/typeGuards";

export type MeAccess = {
  role: string;
  permissions: string[];
  isStaff: boolean;
  roleStyle?: { badge_bg: string | null; badge_border: string | null; badge_text: string | null } | null;
};

function normalizeAccess(v: unknown): MeAccess | null {
  if (!isRecord(v)) return null;
  const role = isString(v.role) ? v.role : null;
  const permissions = isArray(v.permissions) ? v.permissions.filter(isString) : null;
  const isStaff = isBoolean(v.isStaff) ? v.isStaff : null;
  if (!role || !permissions || isStaff === null) return null;
  const roleStyle = isRecord((v as any).roleStyle)
    ? {
        badge_bg: isString(((v as any).roleStyle as any).badge_bg) ? (((v as any).roleStyle as any).badge_bg as string) : null,
        badge_border: isString(((v as any).roleStyle as any).badge_border)
          ? (((v as any).roleStyle as any).badge_border as string)
          : null,
        badge_text: isString(((v as any).roleStyle as any).badge_text) ? (((v as any).roleStyle as any).badge_text as string) : null,
      }
    : null;
  return { role, permissions, isStaff, roleStyle };
}

async function getViewerToken(): Promise<string | null> {
  const supabase = supabaseBrowser();
  const { data } = await supabase.auth.getSession();
  const token = data?.session?.access_token;
  return typeof token === "string" && token.length ? token : null;
}

async function fetchMeAccess(): Promise<MeAccess | null> {
  const token = await getViewerToken();
  if (!token) return null;

  const res = await fetch("/api/me/access", {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
  });

  const json = (await res.json().catch(() => null)) as unknown;
  return normalizeAccess(json);
}

/**
 * Loads and caches the current viewer's access (role + permissions + staff flag).
 *
 * This is a client-only helper intended for gating UI. Server routes must still
 * enforce permissions using `requirePermission` and service-role Supabase clients.
 */
export function useMeAccess() {
  return useQuery({
    queryKey: ["meAccess"],
    queryFn: fetchMeAccess,
    staleTime: 60_000,
    gcTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });
}
