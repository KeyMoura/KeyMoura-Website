import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { canFinalizeInstallation, resolveModuleDependencies, validateInstallPayload } from "../src/lib/installer/model.ts";

test("installer adds hard module dependencies without adding soft integrations", () => {
  assert.deepEqual(resolveModuleDependencies(["forum"]), ["forum", "moderation"]);
  assert.deepEqual(resolveModuleDependencies(["messaging"]), ["messaging", "moderation"]);
  assert.deepEqual(resolveModuleDependencies(["garage"]), ["garage"]);
  assert.throws(() => resolveModuleDependencies(["unknown"]), /Unknown module/);
});

test("installer validation rejects weak owner credentials and normalizes modules", () => {
  const base = { siteName: "Example", description: "", publicUrl: "https://example.test", primaryColor: "#112233", accentColor: "#abcdef", terminology: {}, auth: { allowSignup: true, requireEmailConfirmation: true }, modules: ["forum"], owner: { email: "owner@example.test", password: "long-secure-password", username: "owner" } };
  assert.deepEqual(validateInstallPayload(base).modules, ["forum", "moderation"]);
  assert.throws(() => validateInstallPayload({ ...base, owner: { ...base.owner, password: "short" } }), /12 characters/);
  assert.throws(() => validateInstallPayload({ ...base, publicUrl: "javascript:alert(1)" }), /HTTP or HTTPS/);
});

test("completed installation can only resume for the same owner", () => {
  assert.equal(canFinalizeInstallation("pending", null, "owner-a"), "new");
  assert.equal(canFinalizeInstallation("complete", "owner-a", "owner-a"), "resume");
  assert.equal(canFinalizeInstallation("complete", "owner-a", "owner-b"), "locked");
});

test("installer readiness distinguishes a pending core from missing data and failures", async () => {
  const { checkInstallationReadiness, sanitizeSupabaseError } = await import("../src/lib/installer/readiness.ts");
  const db = (data: unknown, error: unknown = null) => ({
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data, error }) }) }) }),
  });
  const errorCode = async (data: unknown, error: unknown = null) => {
    const result = await checkInstallationReadiness(db(data, error) as never);
    assert.equal(result.ready, false);
    return result.ready ? null : result.errorCode;
  };
  const pending = await checkInstallationReadiness(db({ status: "pending" }) as never);
  assert.deepEqual(pending.ready && pending.status, "pending");
  assert.deepEqual(await errorCode(null), "CORE_ROW_MISSING");
  assert.deepEqual(await errorCode(null, { code: "42P01", message: "missing relation" }), "CORE_TABLE_MISSING");
  assert.deepEqual(await errorCode(null, { code: "PGRST301", message: "invalid JWT" }), "SUPABASE_AUTH_FAILED");
  assert.deepEqual(await errorCode(null, { message: "fetch failed" }), "SUPABASE_NETWORK_ERROR");
  assert.deepEqual(sanitizeSupabaseError({ code: "X", message: "safe" }), { code: "X", message: "safe", details: null, hint: null });
});

test("core migration uses transaction, advisory lock, RLS, and non-public finalizer", async () => {
  const sql = await readFile(new URL("../supabase/installer/00000000000000_installer_core.sql", import.meta.url), "utf8");
  assert.match(sql, /begin;/i); assert.match(sql, /commit;/i);
  assert.match(sql, /pg_advisory_xact_lock/);
  assert.match(sql, /for update/);
  assert.match(sql, /claim_first_install/);
  assert.match(sql, /INSTALLATION_IN_PROGRESS/);
  assert.match(sql, /enable row level security/g);
  assert.match(sql, /revoke all on function public\.complete_first_install/);
  const statements = sql.split("\n").filter((line) => !line.trimStart().startsWith("--")).join("\n");
  assert.doesNotMatch(statements, /\b(drop|truncate|delete\s+from)\b/i);
});

test("security bootstrap supplies every middleware and IP-check dependency", async () => {
  const sql = await readFile(new URL("../supabase/installer/00000000000001_security_bootstrap.sql", import.meta.url), "utf8");
  for (const dependency of ["site_security_settings", "ip_bans", "user_bans", "get_ip_ban_detail"]) {
    assert.match(sql, new RegExp(`\\b${dependency}\\b`));
  }
  assert.match(sql, /create or replace function public\.get_ip_ban_detail\(ip text\)/);
  assert.match(sql, /security definer[\s\S]*set search_path = public, pg_temp/);
  assert.match(sql, /revoke all on function public\.get_ip_ban_detail\(text\) from public/);
  const statements = sql.split("\n").filter((line) => !line.trimStart().startsWith("--")).join("\n");
  assert.doesNotMatch(statements, /\b(drop|truncate|delete\s+from|update\s+)\b/i);

  const middleware = await readFile(new URL("../middleware.ts", import.meta.url), "utf8");
  assert.match(middleware, /!installed && isInstallerPath\) return NextResponse\.next\(\)/);
  assert.doesNotMatch(middleware, /pathname === "\/api\/security\/ip-check"\) return NextResponse\.next/);

  const ipCheck = await readFile(new URL("../src/app/api/security/ip-check/route.ts", import.meta.url), "utf8");
  assert.match(ipCheck, /get_ip_ban_detail failed/);
  assert.match(ipCheck, /status: 503/g);
  assert.doesNotMatch(ipCheck, /get_ip_ban_detail error[\s\S]*banned: false/);
});

test("application baseline covers every current application relation and RPC", async () => {
  const { readdir } = await import("node:fs/promises");
  const { join } = await import("node:path");

  async function filesUnder(dir: URL): Promise<string[]> {
    const path = dir.pathname;
    const entries = await readdir(path, { withFileTypes: true });
    const nested = await Promise.all(entries.map(async (entry) => {
      const child = join(path, entry.name);
      return entry.isDirectory() ? filesUnder(new URL(`file://${child}/`)) : [child];
    }));
    return nested.flat();
  }

  const sourceFiles = (await filesUnder(new URL("../src/", import.meta.url)))
    .filter((file) => /\.(?:ts|tsx)$/.test(file));
  sourceFiles.push(new URL("../middleware.ts", import.meta.url).pathname);

  const source = (await Promise.all(sourceFiles.map((file) => readFile(file, "utf8")))).join("\n");
  const sqlFiles = [
    ...(await filesUnder(new URL("../supabase/installer/", import.meta.url))),
    ...(await filesUnder(new URL("../supabase/migrations/", import.meta.url))),
  ]
    .filter((file) => file.endsWith(".sql"));
  const sql = (await Promise.all(sqlFiles.map((file) => readFile(file, "utf8")))).join("\n");

  const relations = new Set(
    [...source.matchAll(/\.from\(["']([a-z][a-z0-9_-]+)["']\)/g)].map((match) => match[1])
  );
  const storageBuckets = new Set(["avatars", "garage-covers"]);
  for (const relation of relations) {
    if (storageBuckets.has(relation)) continue;
    assert.match(
      sql,
      new RegExp(`(?:create\\s+table\\s+if\\s+not\\s+exists\\s+public\\.|create\\s+(?:or\\s+replace\\s+)?view\\s+public\\.)${relation}\\b`, "i"),
      `installer SQL does not define application relation ${relation}`
    );
  }

  const rpcs = new Set(
    [...source.matchAll(/\.rpc\(\s*["']([a-z][a-z0-9_]+)["']/g)].map((match) => match[1])
  );
  for (const rpc of rpcs) {
    assert.match(
      sql,
      new RegExp(`create\\s+or\\s+replace\\s+function\\s+public\\.${rpc}\\b`, "i"),
      `installer SQL does not define application RPC ${rpc}`
    );
  }

  assert.match(sql, /create table if not exists public\.info_admin_todos/i);
  assert.match(sql, /grant usage on schema public to service_role/i);
  assert.match(sql, /grant select, insert, update, delete on all tables in schema public to service_role/i);

  const baseline = await readFile(new URL("../supabase/installer/00000000000002_application_baseline.sql", import.meta.url), "utf8");
  assert.match(baseline, /\\ir modules\/commerce\.sql/, "application baseline includes commerce schema");
  for (const moduleKey of ["forum", "knowledge_base", "garage", "vendors", "messaging", "notifications", "moderation"]) {
    assert.match(
      baseline,
      new RegExp(`\\('${moduleKey}'\\)`),
      `application baseline does not enable middleware-gated module ${moduleKey}`
    );
  }
});

test("unavailable module schemas cannot be selected or finalized", async () => {
  const { assertModulesAvailable, moduleAvailability } = await import("../src/lib/installer/model.ts");
  const availability = moduleAvailability(["core", "garage", "vendors"]);
  assert.equal(availability.forum.available, false);
  assert.equal(availability.knowledge_base.available, false);
  assert.equal(availability.notifications.available, false);
  assert.equal(availability.garage.available, true);
  assert.throws(() => assertModulesAvailable(["forum"], availability), /Unavailable modules/);
  assert.doesNotThrow(() => assertModulesAvailable(["garage", "vendors"], availability));
  const wizard = await readFile(new URL("../src/app/install/wizard.tsx", import.meta.url), "utf8");
  assert.match(wizard, /modules: \[\] as string\[\]/);
  assert.match(wizard, /disabled={!availability\.available}/);
});

test("installer browser globals are guarded during server rendering", async () => {
  const wizard = await readFile(new URL("../src/app/install/wizard.tsx", import.meta.url), "utf8");
  assert.match(wizard, /typeof window === "undefined" \? "" : window\.location\.origin/);
  assert.doesNotMatch(wizard, /publicUrl: window\.location\.origin/);
});

test("owner recovery requires both the installation attempt and owner identity", async () => {
  const security = await readFile(new URL("../src/lib/installer/security.ts", import.meta.url), "utf8");
  const route = await readFile(new URL("../src/app/api/install/complete/route.ts", import.meta.url), "utf8");
  const ddl = await readFile(new URL("../supabase/installer/00000000000000_installer_core.sql", import.meta.url), "utf8");
  assert.match(route, /isRecoverableInstallerUser/);
  assert.match(route, /signInWithPassword/);
  assert.match(route, /unrelated account already uses this owner email/i);
  assert.doesNotMatch(route, /ownerId = listed\.data\.users\.find/);
  assert.match(security, /installer_attempt_id === attemptId/);
  assert.match(security, /installer_owner_email === ownerEmail/);
  assert.match(ddl, /OWNER_CONTROL_NOT_PROVEN/);
  assert.match(ddl, /raw_app_meta_data->>'installer_attempt_id'=p_attempt_id::text/);
  assert.match(ddl, /current_state\.attempt_id is distinct from p_attempt_id/);
});

test("blank-project profile DDL implements the application profile contract", async () => {
  const ddl = await readFile(new URL("../supabase/installer/00000000000000_installer_core.sql", import.meta.url), "utf8");
  for (const column of ["id", "username", "display_name", "bio", "avatar_url", "location", "karma", "role", "is_verified", "donation_rank", "created_at", "updated_at", "last_seen_at", "last_ip", "last_user_agent", "username_last_changed_at", "is_op"]) {
    assert.match(ddl, new RegExp(`\\b${column}\\b`), `missing profiles.${column}`);
  }
  assert.doesNotMatch(ddl, /\n\s*verified boolean/);
  assert.match(ddl, /profiles_username_lower_idx/);
  assert.match(ddl, /own profile update/);
  assert.match(ddl, /grant update\(display_name,bio,location,avatar_url\)/);
  assert.doesNotMatch(ddl, /grant update\([^)]*last_seen_at/);
  assert.match(ddl, /function public\.touch_last_seen\(\)/);
  assert.match(ddl, /where id = auth\.uid\(\)/);
  assert.match(ddl, /interval '5 minutes'/);
  assert.match(ddl, /grant execute on function public\.touch_last_seen\(\) to authenticated/);
  assert.match(ddl, /function public\.ensure_user_profile\(p_user_id uuid\)/);
  assert.match(ddl, /auth_user_create_profile/);
  assert.match(ddl, /exception when unique_violation/);
  assert.match(ddl, /raw_user_meta_data->>'full_name'/);
  assert.match(ddl, /split_part\(coalesce\(auth_user\.email/);
});

test("automatic username migration repairs existing users and protects internal functions", async () => {
  const ddl = await readFile(new URL("../supabase/migrations/20260731020000_assign_automatic_usernames.sql", import.meta.url), "utf8");
  assert.match(ddl, /for existing_user in select id from auth\.users loop/);
  assert.match(ddl, /perform public\.ensure_user_profile\(existing_user\.id\)/);
  assert.match(ddl, /revoke all on function public\.ensure_user_profile\(uuid\) from public, anon, authenticated/);
  assert.match(ddl, /revoke all on function public\.create_profile_for_auth_user\(\) from public, anon, authenticated/);
  assert.match(ddl, /username is not null/);
});

test("Garage installer schema matches create/read/update and ownership contracts", async () => {
  const ddl = await readFile(new URL("../supabase/installer/modules/garage.sql", import.meta.url), "utf8");
  for (const column of ["owner_id","name","make","model","year","chassis","trim","color","engine","power_hp","torque_ftlb","weight_lb","use_type","visibility","is_primary","summary","mods","cover_image_url","created_at","updated_at"]) assert.match(ddl, new RegExp(`\\b${column}\\b`));
  assert.match(ddl, /visibility in \('public','unlisted','private'\)/);
  assert.match(ddl, /owner_id=auth\.uid\(\)/g);
  assert.match(ddl, /garage_one_primary_per_owner/);
  assert.match(ddl, /garage covers owner upload/);
  const createRoute = await readFile(new URL("../src/app/api/garage/new/route.ts", import.meta.url), "utf8");
  assert.match(createRoute, /owner_id !== user\.id/);
});

test("Shops installer schema enforces public visibility and staff management", async () => {
  const ddl = await readFile(new URL("../supabase/installer/modules/vendors.sql", import.meta.url), "utf8");
  for (const column of ["slug","name","url","description","tags","featured","sort_order","is_published","trust_status","warning_text","created_at","updated_at"]) assert.match(ddl, new RegExp(`\\b${column}\\b`));
  assert.match(ddl, /using\(is_published\)/);
  assert.match(ddl, /role in \('admin','moderator'\)/);
  assert.match(ddl, /shops_public_order_idx/);
  assert.match(ddl, /grant insert,update,delete on public\.shops to authenticated/);
});

test("registration policy fails closed when unavailable, missing, or malformed", async () => {
  const { readRegistrationPolicy, registrationPolicyResponse } = await import("../src/lib/authRegistration.ts");
  assert.deepEqual(readRegistrationPolicy({ auth_config: { allowSignup: false } }), { available: true, policy: { allowSignup: false } });
  assert.deepEqual(readRegistrationPolicy({ auth_config: { allowSignup: true } }), { available: true, policy: { allowSignup: true } });
  assert.deepEqual(readRegistrationPolicy(null), { available: false }, "missing settings do not authorize signup");
  assert.deepEqual(readRegistrationPolicy({ auth_config: {} }), { available: false }, "missing policy field does not authorize signup");
  assert.deepEqual(readRegistrationPolicy({ auth_config: { allowSignup: "false" } }), { available: false }, "malformed policy does not authorize signup");
  for (const result of [readRegistrationPolicy(null), readRegistrationPolicy({ auth_config: {} }), readRegistrationPolicy({ auth_config: { allowSignup: "false" } })]) {
    const response = registrationPolicyResponse(result);
    assert.equal(typeof response.allowSignup, "boolean");
    assert.equal(response.allowSignup, false);
  }
  const policyRoute = await readFile(new URL("../src/app/api/auth/policy/route.ts", import.meta.url), "utf8");
  assert.match(policyRoute, /registrationPolicyResponse\(result\)/, "endpoint preserves its boolean response contract");
  const otp = await readFile(new URL("../src/app/api/auth/otp/route.ts", import.meta.url), "utf8");
  const callback = await readFile(new URL("../src/app/auth/callback/route.ts", import.meta.url), "utf8");
  assert.match(otp, /shouldCreateUser: allowSignup/);
  assert.match(otp, /Authentication policy is unavailable/);
  assert.match(callback, /rpc\("admit_oauth_account"/, "callback delegates the entire decision to one atomic RPC");
  assert.match(callback, /admissionError[\s\S]*policy_unavailable/, "admission RPC errors fail closed");
  assert.match(callback, /already_admitted[\s\S]*admitted[\s\S]*return success/, "cookies are released only for admitted outcomes");
  assert.doesNotMatch(callback, /deleteUser/, "OAuth callback never deletes an Auth identity");
  assert.match(callback, /cookies are staged|Session cookies are staged/i);
  const ddl = await readFile(new URL("../supabase/installer/00000000000000_installer_core.sql", import.meta.url), "utf8");
  assert.match(ddl, /account_admissions/);
});

test("durable admissions backfill only authoritative members and queue ambiguous identities", async () => {
  const baseline = await readFile(new URL("../supabase/installer/00000000000000_installer_core.sql", import.meta.url), "utf8");
  const migration = await readFile(new URL("../supabase/migrations/20260729235900_add_account_admissions.sql", import.meta.url), "utf8");
  const installer = await readFile(new URL("../src/app/api/install/complete/route.ts", import.meta.url), "utf8");
  const admin = await readFile(new URL("../src/app/api/admin/create-user/route.ts", import.meta.url), "utf8");
  for (const sql of [baseline, migration]) {
    assert.match(sql, /user_id uuid primary key references auth\.users/);
    assert.match(sql, /enable row level security/);
    assert.match(sql, /revoke all on public\.account_admissions from public, anon, authenticated/);
    assert.doesNotMatch(sql, /select\s+(?:u\.)?id\s*,\s*'[^']+'\s+from auth\.users/i, "auth identities are never blanket-admitted");
    const statements = sql.split("\n").filter((line) => !line.trimStart().startsWith("--")).join("\n");
    assert.doesNotMatch(statements, /\b(drop|truncate|delete\s+from)\b/i);
  }
  assert.match(migration, /select distinct user_id,'legacy_membership' from public\.user_roles/);
  assert.match(migration, /account_admission_review_queue/);
  assert.match(migration, /where a\.user_id is null/, "ambiguous identities remain unadmitted and enter operator review");
  assert.match(baseline, /p_owner_user_id,'installer_owner'/);
  assert.match(installer, /complete_first_install/, "installer admits its owner transactionally");
  assert.match(admin, /admission_source: "administrator"/);
  assert.match(admin, /deleteUser\(newUserId\)/, "admin route rolls back auth creation when admission fails");
});

test("shared server authorization, middleware, RLS, and RPCs require admission", async () => {
  const routeAuth = await readFile(new URL("../src/lib/api/routeAuth.ts", import.meta.url), "utf8");
  const middleware = await readFile(new URL("../middleware.ts", import.meta.url), "utf8");
  const migration = await readFile(new URL("../supabase/migrations/20260729235900_add_account_admissions.sql", import.meta.url), "utf8");
  assert.match(routeAuth, /getAnonClient\(\)\.auth\.getUser\(token\)[\s\S]*isUserAdmitted\(user\.id\)/, "valid unadmitted bearer tokens are rejected");
  assert.match(routeAuth, /supabase\.auth\.getUser\(\)[\s\S]*isUserAdmitted\(user\.id\)/, "unadmitted cookie sessions are rejected");
  assert.match(middleware, /userId && !isAdmitted/);
  assert.match(migration, /as restrictive for all to authenticated using \(public\.is_account_admitted\(\)\)/, "RLS adds a restrictive admission requirement");
  assert.match(migration, /ACCOUNT_ADMISSION_REQUIRED/, "browser RPCs reject unadmitted callers");
  assert.match(migration, /exists\(select 1 from public\.account_admissions/, "admitted users satisfy the shared database guard");
  assert.match(migration, /revoke all on function public\.is_account_admitted\(uuid\) from public, anon, authenticated, service_role/, "obsolete cross-user admission lookup is inaccessible");
  assert.match(migration, /function public\.is_account_admitted\(\)/, "authenticated admission lookup accepts no user ID");
  assert.doesNotMatch(migration, /grant execute on function public\.is_account_admitted\(uuid\) to authenticated/, "authenticated users cannot inspect another identity");
  const directRoutes = await Promise.all([
    "admin/audit-info-action", "admin/info/action", "forum/posts/reply", "forum/threads/create",
    "garage/update", "info/submit", "me/role", "messages/send",
  ].map((route) => readFile(new URL(`../src/app/api/${route}/route.ts`, import.meta.url), "utf8")));
  for (const route of directRoutes) assert.match(route, /isUserAdmitted/, "direct token route must enforce admission before service-role work");
});

test("queued established OAuth identity survives closed-registration callback", async () => {
  const { closedRegistrationAction } = await import("../src/lib/authRegistration.ts");
  const migration = await readFile(new URL("../supabase/migrations/20260729235900_add_account_admissions.sql", import.meta.url), "utf8");
  const callback = await readFile(new URL("../src/app/auth/callback/route.ts", import.meta.url), "utf8");
  assert.match(migration, /account_admission_review_queue[\s\S]*where a\.user_id is null/, "migration queues ambiguous established identities");
  assert.equal(closedRegistrationAction({ queuedForReview: true, provenNewClosedCandidate: false }), "pending_review");
  assert.equal(closedRegistrationAction({ queuedForReview: false, provenNewClosedCandidate: false }), "reject");
  assert.equal(closedRegistrationAction({ queuedForReview: false, provenNewClosedCandidate: true }), "delete");
  assert.match(callback, /pending_review[\s\S]*account_pending_review/, "queued identity receives a pending-review error");
  assert.doesNotMatch(callback, /deleteUser/, "no admission outcome deletes an identity");
  assert.doesNotMatch(callback, /from\("account_admission_review_queue"\)\.delete/, "callback preserves the operator review record");
});

test("OAuth admission RPC is atomic, service-only, and fails closed", async () => {
  for (const file of [
    "../supabase/installer/00000000000000_installer_core.sql",
    "../supabase/migrations/20260729235900_add_account_admissions.sql",
  ]) {
    const sql = await readFile(new URL(file, import.meta.url), "utf8");
    assert.match(sql, /function public\.admit_oauth_account\(p_user_id uuid\)/);
    assert.match(sql, /site_settings[\s\S]*singleton=true for update/, "policy is locked in the admission transaction");
    assert.match(sql, /jsonb_typeof\(policy_config->'allowSignup'\) <> 'boolean'[\s\S]*policy_unavailable/);
    assert.match(sql, /policy_config->'allowSignup' <> 'true'::jsonb/, "only exact boolean true admits");
    for (const outcome of ["already_admitted", "admitted", "registration_closed", "pending_review", "rejected", "policy_unavailable"]) {
      assert.match(sql, new RegExp(`return '${outcome}'`), `RPC exposes ${outcome}`);
    }
    assert.match(sql, /revoke all on function public\.admit_oauth_account\(uuid\) from public,\s*anon,\s*authenticated/);
    assert.match(sql, /grant execute on function public\.admit_oauth_account\(uuid\) to service_role/);
  }
});

test("admission migrations are sequenced and policy creation is rerunnable", async () => {
  const baseline = await readFile(new URL("../supabase/installer/00000000000000_installer_core.sql", import.meta.url), "utf8");
  const upgrade = await readFile(new URL("../supabase/migrations/20260729235900_add_account_admissions.sql", import.meta.url), "utf8");
  assert.match(baseline, /Blank-project bootstrap/);
  assert.match(baseline, /Do not apply this baseline to an existing database/);
  assert.match(upgrade, /legacy_membership[\s\S]*installer_owner[\s\S]*account_admission_review_queue[\s\S]*account_admission_required/,
    "upgrade establishes authoritative admission and review state before restrictive policies");
  for (const sql of [baseline, upgrade]) {
    const dynamicPolicies = [...sql.matchAll(/execute format\('create policy account_admission_required/g)];
    assert.ok(dynamicPolicies.length > 0);
    assert.match(sql, /not exists\(select 1 from pg_policies p[\s\S]*policyname='account_admission_required'/,
      "dynamic CREATE POLICY skips policies created by a prior installer or migration run");
  }
});

test("callback next path rejects external and encoded redirect bypasses", async () => {
  const { safeLocalRedirectPath } = await import("../src/lib/authRegistration.ts");
  assert.equal(safeLocalRedirectPath("/garage?tab=mine#cars"), "/garage?tab=mine#cars");
  for (const unsafe of ["https://evil.test", "//evil.test", "%2f%2fevil.test", "/%2fevil.test", "/%252fevil.test", "/\\evil.test", "javascript:alert(1)", "/%", null]) {
    assert.equal(safeLocalRedirectPath(unsafe), "/", `expected ${String(unsafe)} to use the safe default`);
  }
});

test("OTP redirects are limited to the configured callback", async () => {
  const { approvedAuthRedirect } = await import("../src/lib/authRegistration.ts");
  assert.equal(approvedAuthRedirect("https://community.test/auth/callback", "https://community.test"), "https://community.test/auth/callback");
  assert.equal(approvedAuthRedirect("https://evil.test/auth/callback", "https://community.test"), undefined);
  assert.equal(approvedAuthRedirect("https://community.test/not-a-callback", "https://community.test"), undefined);
  assert.equal(approvedAuthRedirect("https://community.test/auth/callback?next=https://evil.test", "https://community.test"), undefined);
  assert.equal(approvedAuthRedirect("not a url", "https://community.test"), undefined);
});
