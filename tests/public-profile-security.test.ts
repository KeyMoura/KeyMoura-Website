import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (path: string) => readFileSync(path, "utf8");
const projection = read("supabase/migrations/20260811025000_public_profile_projection.sql");
const hardening = read("supabase/migrations/20260811030000_security_boundary_hardening.sql");

const publicSurfaces = [
  "src/app/community/[slug]/[threadSlug]/page.tsx",
  "src/app/community/[slug]/page.tsx",
  "src/app/garage/[id]/page.tsx",
  "src/app/garage/page.tsx",
  "src/app/projects/[slug]/page.tsx",
  "src/app/workshop/[id]/page.tsx",
  "src/app/api/forum/category-threads/route.ts",
  "src/app/api/forum/community-feed/route.ts",
  "src/app/api/forum/thread-meta/route.ts",
];

test("the public projection exposes only reviewed identity fields", () => {
  const selectList = projection.match(/as\s+select([\s\S]*?)from public\.profiles/i)?.[1] ?? "";
  for (const field of ["id", "username", "display_name", "avatar_url", "karma", "is_verified", "donation_rank"]) {
    assert.match(selectList, new RegExp(`\\b${field}\\b`));
  }
  for (const field of ["email", "role", "last_ip", "last_user_agent", "location", "bio", "last_seen_at", "updated_at"]) {
    assert.doesNotMatch(selectList, new RegExp(`\\b${field}\\b`));
  }
  assert.match(projection, /grant select on public\.public_profiles to anon, authenticated, service_role/i);
});

test("community-facing profile lookups no longer select the base table", () => {
  for (const path of publicSurfaces) {
    const source = read(path);
    assert.doesNotMatch(source, /\.from\(["']profiles["']\)/, path);
    assert.match(source, /\.from\(["']public_profiles["']\)/, path);
  }
});

test("display names and avatars remain available to public community pages", () => {
  assert.match(read("src/app/garage/page.tsx"), /public_profiles[\s\S]*display_name[\s\S]*avatar_url/);
  assert.match(read("src/app/community/[slug]/[threadSlug]/page.tsx"), /public_profiles[\s\S]*display_name[\s\S]*avatar_url/);
});

test("hardening retains own-profile and authorized staff full reads", () => {
  assert.match(hardening, /id = \(select auth\.uid\(\)\)/i);
  assert.match(hardening, /public\.is_staff_user\(\)/i);
  assert.match(hardening, /revoke select on public\.profiles from anon/i);
  assert.match(hardening, /revoke select on public\.roles, public\.permissions from anon, authenticated/i);
  assert.match(hardening, /revoke truncate[\s\S]*from service_role/i);
});

test("projection is ordered before the compatible hardening migration", () => {
  assert.ok("20260811025000_public_profile_projection.sql" < "20260811030000_security_boundary_hardening.sql");
  assert.match(hardening, /public\.public_profiles/);
});
