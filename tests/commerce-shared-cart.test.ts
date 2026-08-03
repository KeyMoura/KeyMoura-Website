import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const service = read("src/lib/commerce/sharedCartService.ts");
const shareRoute = read("src/app/api/cart/share/route.ts");
const sharedRoute = read("src/app/api/cart/shared/[token]/route.ts");
const sharedPage = read("src/app/cart/shared/[token]/page.tsx");
const panel = read("src/components/commerce/CartSharePanel.tsx");
const migration = read("supabase/migrations/20260803020000_shared_cart_ownership.sql");

test("a share link points at a snapshot, never at the owner's live cart", () => {
  const load = service.slice(service.indexOf("export async function loadSharedCart"));

  // The public read touches shared_carts and products. If it ever reached
  // `carts` or `cart_items`, the link would become a window onto live activity.
  assert.doesNotMatch(load, /from\("carts"\)/);
  assert.doesNotMatch(load, /from\("cart_items"\)/);
  assert.doesNotMatch(load, /resolveCart|findCart/);
  assert.match(load, /\.from\("shared_carts"\)/);
});

test("only currently valid lines are captured in a snapshot", () => {
  const create = service.slice(service.indexOf("export async function createCartShare"));
  // resolved.priced.lines excludes rejected lines. Sharing something that has
  // since gone request-only would promise what checkout will refuse.
  assert.match(create, /const lines = resolved\.priced\.lines/);
  assert.doesNotMatch(create.slice(0, create.indexOf("const { error }")), /rejected/);
});

test("the snapshot price is display-only and never used to charge", () => {
  // The copy path must not read a price out of the snapshot at all.
  assert.doesNotMatch(sharedRoute, /snapshotUnitPriceCents|unitPriceCents/);
  assert.match(sharedRoute, /await addCartItem\(owner\.owner, \{/);

  // And the view's comparison is explicitly against live pricing.
  const load = service.slice(service.indexOf("export async function loadSharedCart"));
  assert.match(load, /priceChanged: !rejected && priced\.unitPriceCents !== item\.unitPriceCents/);
  assert.match(load, /unitPriceCents: rejected \? null : priced\.unitPriceCents/);
});

test("a shared cart exposes no owner identity", () => {
  const load = service.slice(service.indexOf("export async function loadSharedCart"));
  const select = load.slice(load.indexOf(".select("), load.indexOf(".eq(\"token\""));

  for (const forbidden of ["created_by", "owner_hash", "customer_id"]) {
    assert.ok(!select.includes(forbidden), `the public read must not select ${forbidden}`);
  }

  const view = service.slice(service.indexOf("export type SharedCartView"));
  const shape = view.slice(0, view.indexOf("};"));
  for (const forbidden of ["customerId", "createdBy", "ownerHash", "email", "cartId"]) {
    assert.ok(!shape.includes(forbidden), `SharedCartView must not carry ${forbidden}`);
  }
});

test("a malformed token is rejected before it reaches a query", () => {
  const load = service.slice(service.indexOf("export async function loadSharedCart"));
  const guard = load.indexOf("isValidShareToken(token)");
  const query = load.indexOf('.from("shared_carts")');
  assert.ok(guard > -1 && guard < query, "token validation must precede the lookup");
});

test("revocation is scoped to the caller so a foreign token matches nothing", () => {
  const revoke = service.slice(service.indexOf("export async function revokeCartShare"));
  assert.match(revoke, /\.eq\("token", token\.trim\(\)\)/);
  assert.match(revoke, /\.eq\("owner_hash", ownerDigest\(owner\)\)/);
  // And an unmatched update is reported rather than passing silently.
  assert.match(revoke, /if \(!data\?\.length\) return \{ error:/);
});

test("a guest can revoke their own share, which is why owner_hash exists", () => {
  // created_by is null for a guest, so scoping on it alone would leave guest
  // links permanently unrevocable by the person who made them.
  assert.match(migration, /add column if not exists owner_hash text/);
  assert.match(service, /export function ownerDigest/);
  assert.match(service, /"customerId" in owner \? `user:\$\{owner\.customerId\}` : `guest:\$\{owner\.guestToken\}`/);
});

test("the owner digest is salted differently from the rate limiter's", () => {
  const rateLimit = read("src/lib/commerce/rateLimit.ts");
  const shareSalt = /const OWNER_SALT = "([^"]+)"/.exec(service);
  const limitSalt = /const SUBJECT_SALT = "([^"]+)"/.exec(rateLimit);
  assert.ok(shareSalt && limitSalt);
  // Same salt would let the two tables be joined to correlate a caller's share
  // links with their request volume.
  assert.notEqual(shareSalt[1], limitSalt[1]);
});

test("a raw guest token is never stored on a share row", () => {
  const create = service.slice(service.indexOf("export async function createCartShare"));
  const insert = create.slice(create.indexOf('.from("shared_carts").insert('));
  assert.match(insert, /owner_hash: ownerDigest\(owner\)/);
  assert.doesNotMatch(insert, /guest_token|guestToken/);
});

test("revoked and expired links stop resolving", () => {
  const load = service.slice(service.indexOf("export async function loadSharedCart"));
  assert.match(load, /shareIsLive\(\{ revoked_at: data\.revoked_at as string \| null, expires_at: data\.expires_at as string \| null \}\)/);
});

test("copying from a shared cart is restricted to lines on that snapshot", () => {
  assert.match(sharedRoute, /shared\.lines\.filter\(\(line\) => line\.productId === productId && line\.cartEligible\)/);
  assert.match(sharedRoute, /if \(!targets\.length\)/);
});

test("a share token never authorizes acting as the owner", () => {
  assert.match(sharedRoute, /resolveOwnerForWrite\(req\)/);
  assert.doesNotMatch(sharedRoute, /owner_hash|ownerDigest|created_by/);
});

test("creating and copying share links are rate limited", () => {
  assert.match(shareRoute, /consumeRateLimit\(RATE_LIMITS\.cartShare,/);
  assert.match(sharedRoute, /consumeRateLimit\(RATE_LIMITS\.cartShareCopy,/);
});

test("a snapshot is bounded so one share cannot carry an unbounded payload", () => {
  assert.match(service, /export const MAX_SHARED_CART_ITEMS = \d+/);
  assert.match(service, /\.slice\(0, MAX_SHARED_CART_ITEMS\)/);
  // And a stored snapshot is re-sanitized on read, not trusted as written.
  assert.match(service, /function sanitizeSnapshot/);
  assert.match(service, /value\.slice\(0, MAX_SHARED_CART_ITEMS\)/);
});

test("an empty cart cannot be shared", () => {
  const create = service.slice(service.indexOf("export async function createCartShare"));
  assert.match(create, /if \(!lines\.length\) \{/);
});

test("the shared cart page is kept out of search indexes", () => {
  assert.match(sharedPage, /robots: \{ index: false, follow: false \}/);
});

test("the shared cart page names what changed rather than showing stale numbers", () => {
  assert.match(sharedPage, /shared\.lines\.filter\(\(line\) => line\.priceChanged\)/);
  assert.match(sharedPage, /changed price since this list was/);
  assert.match(sharedPage, /Was \{money\(line\.snapshotUnitPriceCents\)\} when shared, now \{money\(line\.unitPriceCents\)\}/);
  // Unavailable, request-only, and removed lines are called out too.
  assert.match(sharedPage, /no longer available to buy/);
});

test("the share panel tells the owner it is a snapshot", () => {
  assert.match(panel, /snapshot of what is in your cart right now/);
  assert.match(panel, /never your name or account/);
});

test("the shared cart migration is additive", () => {
  assert.match(migration, /add column if not exists owner_hash text/);
  assert.match(migration, /add column if not exists snapshot_subtotal_cents integer/);
  assert.doesNotMatch(migration, /drop table|drop column|alter column .* type/i);
});

test("the view counter is a function so the public page needs no table rights", () => {
  assert.match(migration, /create or replace function public\.touch_shared_cart/);
  assert.match(migration, /revoke all on function public\.touch_shared_cart\(text\) from public, anon, authenticated/);
  assert.match(migration, /where token = p_token and revoked_at is null/);
});

test("a failed view counter never breaks the page", () => {
  const load = service.slice(service.indexOf("export async function loadSharedCart"));
  assert.match(load, /rpc\("touch_shared_cart"[\s\S]{0,120}\.then\(/);
});
