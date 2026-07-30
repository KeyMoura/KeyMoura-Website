import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { checkInstallationReadiness, logReadinessFailure, serverSupabaseEnv } from "./src/lib/installer/readiness";

/**
 * Site middleware.
 *
 * This file performs lightweight perimeter checks (IP bans, maintenance-mode write block,
 * staff/admin route gating) and refreshes Supabase session cookies.
 *
 * IMPORTANT:
 * - Middleware must never hang. Every database call is guarded by a short timeout.
 * - Client-side access always respects RLS. Any bypass happens only in server routes.
 */

const { url: supabaseUrl, anonKey, serviceRoleKey } = serverSupabaseEnv();

type SecurityRow = { maintenance_mode: boolean | null };
type IpBanRow = { id: number };
type UserRoleRow = { role: string };
type UserBanRow = { id: number; active: boolean | null };
type AdmissionRow = { user_id: string };

const moduleRoutes: Array<[string, string]> = [
  ["/community", "forum"], ["/api/forum", "forum"],
  ["/info", "knowledge_base"], ["/api/info", "knowledge_base"],
  ["/garage", "garage"], ["/api/garage", "garage"],
  ["/shops", "vendors"], ["/api/shops", "vendors"],
  ["/messages", "messaging"], ["/api/messages", "messaging"],
  ["/notifications", "notifications"], ["/api/notifications", "notifications"],
  ["/reports", "moderation"], ["/api/reports", "moderation"],
];

/**
 * Runs an async operation with a hard timeout.
 */
async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  fallback: T
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    const timeout = new Promise<T>((resolve) => {
      timer = setTimeout(() => resolve(fallback), timeoutMs);
    });
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Returns true when server-side security checks are available.
 */
function hasServerSecurityEnv(): boolean {
  return Boolean(supabaseUrl && anonKey && serviceRoleKey);
}

/**
 * Creates a service-role Supabase client.
 */
function createAdminDb() {
  return createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });
}

/**
 * Loads the maintenance mode flag.
 */
async function getSecuritySettings(adminDb: ReturnType<typeof createAdminDb>): Promise<{ maintenance_mode: boolean }> {
  try {
    const { data, error } = await adminDb
      .from("site_security_settings")
      .select("maintenance_mode")
      .eq("id", 1)
      .maybeSingle<SecurityRow>();

    if (error || !data) return { maintenance_mode: false };
    return { maintenance_mode: Boolean(data.maintenance_mode) };
  } catch {
    return { maintenance_mode: false };
  }
}

/**
 * Returns true if the request IP is banned.
 */
async function isIpBanned(adminDb: ReturnType<typeof createAdminDb>, ip: string | null): Promise<boolean> {
  if (!ip) return false;
  try {
    const { data, error } = await adminDb
      .from("ip_bans")
      .select("id")
      .eq("ip_address", ip)
      .maybeSingle<IpBanRow>();

    if (error) return false;
    return Boolean(data);
  } catch {
    return false;
  }
}

/**
 * Loads the user's role and ban status.
 */
async function loadUserGate(
  adminDb: ReturnType<typeof createAdminDb>,
  userId: string
): Promise<{ role: string | null; isBanned: boolean; isAdmitted: boolean }> {
  try {
    const [roleRes, banRes, admissionRes] = await Promise.all([
      adminDb
        .from("user_roles")
        .select("role")
        .eq("user_id", userId)
        .maybeSingle<UserRoleRow>(),
      adminDb
        .from("user_bans")
        .select("id, active")
        .eq("user_id", userId)
        .eq("active", true)
        .maybeSingle<UserBanRow>(),
      adminDb.from("account_admissions").select("user_id").eq("user_id", userId).maybeSingle<AdmissionRow>(),
    ]);

    const role = !roleRes.error && roleRes.data ? roleRes.data.role : null;
    const isBanned = !banRes.error && Boolean(banRes.data?.active);
    const isAdmitted = !admissionRes.error && Boolean(admissionRes.data);
    return { role, isBanned, isAdmitted };
  } catch {
    return { role: null, isBanned: false, isAdmitted: false };
  }
}

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const method = req.method.toUpperCase();

  /**
   * If an OAuth code is present in the URL, forward it to the canonical callback route.
   *
   * The callback route completes the exchange and sets session cookies. This avoids
   * relying on client-side PKCE verifier storage, which can vary by browser and may
   * be affected by redirects or storage policies.
   */
  const url = req.nextUrl;
  const code = url.searchParams.get("code");
  if (code && !pathname.startsWith("/api") && !pathname.startsWith("/auth/callback")) {
    const cleaned = new URL(req.url);
    cleaned.searchParams.delete("code");
    cleaned.searchParams.delete("error");
    cleaned.searchParams.delete("error_code");
    cleaned.searchParams.delete("error_description");

    const nextValue = cleaned.pathname + (cleaned.search ? cleaned.search : "") + cleaned.hash;
    const dest = new URL("/auth/callback", req.url);
    dest.searchParams.set("code", code);
    dest.searchParams.set("next", nextValue);
    return NextResponse.redirect(dest);
  }

  if (
    pathname.startsWith("/_next") ||
    pathname.startsWith("/static") ||
    pathname.startsWith("/favicon") ||
    pathname === "/robots.txt" ||
    pathname === "/sitemap.xml"
  ) {
    return NextResponse.next();
  }

  if (!hasServerSecurityEnv()) {
    return NextResponse.next();
  }

  const adminDb = createAdminDb();

  // Installation is fail-closed: a missing/incomplete bootstrap only exposes the
  // installer. Once complete, the page itself returns 404 and mutations reject.
  const isInstallerPath = pathname === "/install" || pathname.startsWith("/api/install/");
  const installState = await withTimeout(
    checkInstallationReadiness(adminDb, "status"),
    900,
    { ready: false as const, errorCode: "SUPABASE_NETWORK_ERROR" as const, error: { message: "Request timed out", code: "TIMEOUT", details: null, hint: null } }
  );
  if (!installState.ready) logReadinessFailure("middleware", installState);
  const installed = installState.ready && installState.status === "complete";
  // This endpoint deliberately fails open and must remain reachable while the
  // core is pending (and while readiness itself is temporarily unavailable).
  if (pathname === "/api/security/ip-check") return NextResponse.next();
  if (!installed && !isInstallerPath) {
    if (pathname.startsWith("/api")) return NextResponse.json({ error: "Installation required." }, { status: 503 });
    return NextResponse.redirect(new URL("/install", req.url));
  }
  if (installed && !isInstallerPath) {
    const matched = moduleRoutes.find(([prefix]) => pathname === prefix || pathname.startsWith(`${prefix}/`));
    if (matched) {
      const moduleState = await withTimeout(
        Promise.resolve(adminDb.from("installed_modules").select("enabled").eq("module_key", matched[1]).maybeSingle()),
        750,
        { data: null, error: { message: "timeout", details: "", hint: "", code: "TIMEOUT", name: "PostgrestError" }, count: null, status: 504, statusText: "Timeout" }
      );
      if (moduleState.error || !moduleState.data?.enabled) {
        if (pathname.startsWith("/api")) return NextResponse.json({ error: "Module not installed." }, { status: 404 });
        return new NextResponse("Not found.", { status: 404 });
      }
    }
  }

  const xff = req.headers.get("x-forwarded-for");
  const clientIp = xff?.split(",")[0]?.trim() ?? req.headers.get("x-real-ip") ?? null;

  const ipBanned = await withTimeout(isIpBanned(adminDb, clientIp), 750, false);
  if (ipBanned) {
    if (pathname.startsWith("/api")) {
      return NextResponse.json({ error: "Access denied from this IP address." }, { status: 403 });
    }
    return new NextResponse("Access denied from this IP address.", { status: 403 });
  }

  const res = NextResponse.next();

  const supabase = createServerClient(supabaseUrl, anonKey, {
    cookies: {
      getAll: () => req.cookies.getAll(),
      setAll: (cookiesToSet) => {
        cookiesToSet.forEach(({ name, value, options }) => {
          res.cookies.set(name, value, options);
        });
      },
    },
  });

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const userId = user?.id ?? null;
  const isAuthPath = pathname.startsWith("/auth") || pathname.startsWith("/api/auth");

  const { role, isBanned, isAdmitted } = userId
    ? await withTimeout(loadUserGate(adminDb, userId), 900, { role: null, isBanned: false, isAdmitted: false })
    : { role: null, isBanned: false, isAdmitted: false };

  if (userId && !isAdmitted && !isAuthPath) {
    if (pathname.startsWith("/api")) return NextResponse.json({ error: "Account admission required." }, { status: 403 });
    return NextResponse.redirect(new URL("/auth/login?error=account_not_admitted", req.url));
  }

  if (isBanned && !isAuthPath) {
    if (pathname.startsWith("/api")) {
      return NextResponse.json({ error: "This account has been banned." }, { status: 403 });
    }
    return new NextResponse("This account has been banned.", { status: 403 });
  }

  const isAdminPath = pathname.startsWith("/admin") || pathname.startsWith("/api/admin");
  const isStaffPath = pathname.startsWith("/staff") || pathname.startsWith("/api/staff");

  if (isStaffPath) {
    if (!userId) return NextResponse.redirect(new URL("/auth/login", req.url));
    const isStaffRole = role === "admin" || role === "moderator" || role === "support";
    if (!isStaffRole) {
      if (pathname.startsWith("/api")) {
        return NextResponse.json({ error: "Forbidden. Staff only." }, { status: 403 });
      }
      return new NextResponse("Forbidden. Staff only.", { status: 403 });
    }
  }

  if (isAdminPath) {
    if (!userId) return NextResponse.redirect(new URL("/auth/login", req.url));
    if (role !== "admin") {
      if (pathname.startsWith("/api")) {
        return NextResponse.json({ error: "Forbidden. Admins only." }, { status: 403 });
      }
      return new NextResponse("Forbidden. Admins only.", { status: 403 });
    }
  }

  const { maintenance_mode } = await withTimeout(getSecuritySettings(adminDb), 750, { maintenance_mode: false });
  if (maintenance_mode) {
    const isWrite = ["POST", "PUT", "PATCH", "DELETE"].includes(method);
    if (isWrite) {
      const isAdminOrAuthPath =
        pathname.startsWith("/admin") ||
        pathname.startsWith("/api/admin") ||
        pathname.startsWith("/staff") ||
        pathname.startsWith("/api/staff") ||
        pathname.startsWith("/auth") ||
        pathname.startsWith("/api/auth") ||
        pathname.startsWith("/api/lockdown-status") ||
        pathname.startsWith("/api/verify-lockdown-password");

      if (!isAdminOrAuthPath) {
        if (pathname.startsWith("/api")) {
          return NextResponse.json({ error: "Maintenance mode: writes disabled." }, { status: 503 });
        }
        return new NextResponse("Maintenance mode: writes disabled.", { status: 503 });
      }
    }
  }

  return res;
}

export const config = {
  matcher: "/((?!_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml).*)",
};
