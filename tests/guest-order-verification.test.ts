import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { customerOrderPath } from "../src/lib/commerce/orderUrls.ts";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const service = read("src/lib/commerce/guestOrderVerification.ts");
const route = read("src/app/api/orders/guest/[id]/verification/route.ts");
const email = read("src/lib/commerceEmail.ts");
const migration = read("supabase/migrations/20260809010000_guest_order_verification.sql");

test("canonical customer order paths separate account and guest orders", () => {
  assert.equal(customerOrderPath("abc", "customer-a"), "/orders/abc");
  assert.equal(customerOrderPath("abc", null), "/orders/guest/abc");
});

test("verification codes are six secure digits, HMAC-separated, and constant-time compared", () => {
  assert.match(service, /randomInt\(0, 1_000_000\).*padStart\(6/);
  assert.match(service, /createHmac\("sha256"/);
  assert.match(service, /keymoura\.guest-order-code\.v1/);
  assert.match(service, /timingSafeEqual/);
  assert.doesNotMatch(migration, /code\s+text|plaintext/i);
});

test("challenge lifetime, attempts, cooldown and consumption are enforced server-side", () => {
  assert.match(service, /GUEST_CODE_TTL_SECONDS = 15 \* 60/);
  assert.match(service, /GUEST_CODE_RESEND_SECONDS = 60/);
  assert.match(service, /GUEST_CODE_MAX_ATTEMPTS = 5/);
  assert.match(migration, /for update/);
  assert.match(migration, /failed_attempts < 5/);
  assert.match(migration, /consumed_at = clock_timestamp\(\)/);
  assert.match(migration, /unique index guest_order_access_codes_one_active_idx/);
});

test("guest session cookie is httpOnly, scoped by its per-order digest, and never returned", () => {
  assert.match(route, /httpOnly: true/);
  assert.match(route, /sameSite: "lax"/);
  assert.match(route, /secure: process\.env\.NODE_ENV === "production"/);
  assert.match(service, /hashGuestOrderToken\(token\)/);
  assert.doesNotMatch(route, /NextResponse\.json\(\{[\s\S]*?token/);
});

test("email URLs are ownership-derived and codes stay out of URLs", () => {
  assert.match(email, /customerOrderUrl\(config\.siteUrl, input\.orderId/);
  assert.match(email, /Verification code:/);
  assert.doesNotMatch(email, /[?&](?:token|code)=/);
  assert.doesNotMatch(route, /[?&](?:token|code)=/);
});

test("challenge storage has no direct anon or account access", () => {
  assert.match(migration, /enable row level security/);
  assert.match(migration, /revoke all on public\.guest_order_access_codes from public, anon, authenticated/);
  assert.match(migration, /grant select, insert, update, delete on public\.guest_order_access_codes to service_role/);
});
