import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  clampShareDays,
  isValidShareToken,
  MAX_SHARE_DAYS,
  shareExpired,
  shareExpiryFrom,
  shareIsLive,
} from "../src/lib/commerce/sharing.ts";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const wishlistService = read("src/lib/commerce/wishlistService.ts");
const wishlistSession = read("src/lib/commerce/wishlistSession.ts");
const wishlistRoute = read("src/app/api/wishlist/route.ts");
const shareRoute = read("src/app/api/wishlist/share/route.ts");
const moveRoute = read("src/app/api/wishlist/move-to-cart/route.ts");
const sharedRoute = read("src/app/api/wishlist/shared/[token]/route.ts");
const sharedPage = read("src/app/wishlist/shared/[token]/page.tsx");
const wishlistButton = read("src/components/commerce/WishlistButton.tsx");
const rateLimit = read("src/lib/commerce/rateLimit.ts");
const migration = read("supabase/migrations/20260803010000_wishlist_sharing_and_rate_limits.sql");

/* -- share-link rules, tested directly ---------------------------------- */

test("a share token must be long enough that it cannot be guessed", () => {
  const real = "a".repeat(43);
  assert.equal(isValidShareToken(real), true);

  // Anything short, empty, or wrongly shaped is a probe rather than a lost link.
  for (const bad of ["", "short", "a".repeat(39), "a".repeat(65), "has spaces in it".repeat(3), null, 12345, {}]) {
    assert.equal(isValidShareToken(bad), false, `${String(bad)} must not validate`);
  }
});

test("a share token with base64url punctuation still validates", () => {
  assert.equal(isValidShareToken(`${"-_".repeat(20)}abc`), true);
});

test("share lifetimes are clamped rather than rejected", () => {
  assert.equal(clampShareDays(null), null, "no expiry is a legitimate choice");
  assert.equal(clampShareDays(""), null);
  assert.equal(clampShareDays("not a number"), null);
  assert.equal(clampShareDays(7), 7);
  assert.equal(clampShareDays("30"), 30);
  assert.equal(clampShareDays(0), 1, "a zero-day link would be born dead");
  assert.equal(clampShareDays(-5), 1);
  assert.equal(clampShareDays(9999), MAX_SHARE_DAYS, "a link longer than the cap is effectively permanent");
});

test("an expiry is computed from the requested lifetime", () => {
  const now = Date.UTC(2026, 7, 3);
  assert.equal(shareExpiryFrom(null, now), null);
  assert.equal(shareExpiryFrom(1, now), new Date(now + 86_400_000).toISOString());
  assert.equal(shareExpiryFrom(9999, now), new Date(now + MAX_SHARE_DAYS * 86_400_000).toISOString());
});

test("an unreadable expiry counts as expired rather than as permanent", () => {
  const now = Date.UTC(2026, 7, 3);
  assert.equal(shareExpired(null, now), false, "no expiry means it never lapses");
  assert.equal(shareExpired(new Date(now + 1000).toISOString(), now), false);
  assert.equal(shareExpired(new Date(now - 1000).toISOString(), now), true);
  assert.equal(shareExpired(new Date(now).toISOString(), now), true, "expiry is inclusive");
  assert.equal(shareExpired("not a date", now), true, "an unparseable privilege is not a valid one");
});

test("revocation, the public flag, and expiry are all honoured together", () => {
  const now = Date.UTC(2026, 7, 3);
  const live = { is_public: true, revoked_at: null, expires_at: null };

  assert.equal(shareIsLive(live, now), true);
  assert.equal(shareIsLive({ ...live, is_public: false }, now), false);
  assert.equal(shareIsLive({ ...live, revoked_at: new Date(now).toISOString() }, now), false);
  assert.equal(shareIsLive({ ...live, expires_at: new Date(now - 1).toISOString() }, now), false);
  // A row with no is_public column at all (shared carts) is still governed by
  // revocation and expiry.
  assert.equal(shareIsLive({ revoked_at: null, expires_at: null }, now), true);
});

/* -- wishlist rules ------------------------------------------------------ */

test("a wishlist accepts request-only products, unlike a cart", () => {
  const add = wishlistService.slice(wishlistService.indexOf("export async function addWishlistItem"));
  const body = add.slice(0, add.indexOf("\nasync function touchWishlist"));

  // The only gate is that the product is real and publicly visible. Gating on
  // purchase mode here would make it impossible to save a made-to-order piece,
  // which is most of what this catalog sells.
  assert.match(body, /if \(!product\.is_published \|\| product\.archived_at\)/);
  assert.doesNotMatch(body, /allowsDirectPurchase/, "purchase mode is a cart rule, not a wishlist rule");
  assert.doesNotMatch(body, /isRejected/, "a wishlist entry is not required to be priceable");
});

test("saving the same product twice is a no-op rather than an error", () => {
  const add = wishlistService.slice(wishlistService.indexOf("export async function addWishlistItem"));
  // The button is a toggle; re-adding has to stay idempotent or a double click
  // surfaces a spurious failure.
  assert.match(add, /if \(existing\.some\(\(item\) => item\.product_id === productId\)\) return \{ ok: true \}/);
});

test("wishlist mutations are scoped to the caller's own list", () => {
  const body = wishlistService.slice(wishlistService.indexOf("export async function removeWishlistItem"));
  const scoped = body.slice(0, body.indexOf("\nexport async function clearWishlist"));
  // Scoping by wishlist_id is the ownership check: a foreign id matches nothing.
  assert.match(scoped, /\.eq\("wishlist_id", wishlist\.id\)/);
  assert.equal((scoped.match(/\.eq\("wishlist_id", wishlist\.id\)/g) ?? []).length, 2, "both delete paths must be scoped");
});

test("the wishlist is bounded so it cannot be grown without limit", () => {
  assert.match(wishlistService, /export const MAX_WISHLIST_ITEMS = \d+/);
  assert.match(wishlistService, /existing\.length >= MAX_WISHLIST_ITEMS/);
  assert.match(wishlistService, /Math\.max\(0, MAX_WISHLIST_ITEMS - existing\.length\)/, "the merge must respect the cap too");
});

test("an entry whose product vanished is shown as removed rather than hidden", () => {
  const resolve = wishlistService.slice(wishlistService.indexOf("export async function resolveWishlistEntries"));
  assert.match(resolve, /if \(!product\) \{/);
  assert.match(resolve, /removed: true/);
  // Unpublished and archived products stay visible too, annotated.
  assert.match(resolve, /const removed = !product\.is_published \|\| Boolean\(product\.archived_at\)/);
});

test("wishlist entries carry a cart-eligibility answer computed server-side", () => {
  const resolve = wishlistService.slice(wishlistService.indexOf("export async function resolveWishlistEntries"));
  assert.match(resolve, /const priced = priceLine\(product, \{/);
  assert.match(resolve, /cartEligible: !rejected/);
  assert.match(resolve, /blockedMessage: rejected \? priced\.blocker\.message : null/);
  // A rejected line has no trustworthy price, so none is published.
  assert.match(resolve, /unitPriceCents: rejected \? null : priced\.unitPriceCents/);
});

/* -- guest ownership and merge ------------------------------------------ */

test("the guest wishlist cookie is httpOnly and not sent cross-site", () => {
  const attach = wishlistSession.slice(wishlistSession.indexOf("export function attachWishlistCookie"));
  assert.match(attach, /httpOnly: true/);
  assert.match(attach, /sameSite: "lax"/);
  assert.match(attach, /secure: process\.env\.NODE_ENV === "production"/);
});

test("a malformed guest wishlist cookie is ignored instead of used as a lookup key", () => {
  assert.match(wishlistSession, /\/\^\[A-Za-z0-9_-\]\{40,64\}\$\/\.test\(raw\)/);
});

test("a signed-in customer's wishlist always wins over a stale guest cookie", () => {
  const resolve = wishlistSession.slice(wishlistSession.indexOf("export async function resolveWishlistOwner"));
  const body = resolve.slice(0, resolve.indexOf("\n}"));
  assert.match(body, /owner: \{ customerId: user\.id \}/);
  assert.match(body, /pendingGuestMerge: guestToken/);
});

test("reading the wishlist never mints a guest cookie", () => {
  const get = wishlistRoute.slice(wishlistRoute.indexOf("export async function GET"));
  const body = get.slice(0, get.indexOf("\n}"));
  assert.match(body, /resolveWishlistOwner\(req\)/);
  assert.doesNotMatch(body, /resolveWishlistOwnerForWrite/);
});

test("a merged guest wishlist leaves no live handle behind", () => {
  assert.match(wishlistRoute, /merged \? clearWishlistCookie\(res\) : attachWishlistCookie\(res, resolved\)/);
  // The guest row itself is deleted, not just detached: leaving it would leave
  // a share link pointing at a list its owner can no longer reach.
  const merge = wishlistService.slice(wishlistService.indexOf("export async function mergeGuestWishlist"));
  assert.match(merge, /\.from\("wishlists"\)\.delete\(\)\.eq\("id", guestList\.id\)/);
});

/* -- sharing privacy ----------------------------------------------------- */

test("a shared wishlist exposes products and nothing about its owner", () => {
  const load = wishlistService.slice(wishlistService.indexOf("export async function loadSharedWishlist"));
  const body = load.slice(0, load.indexOf("\n/* ---"));

  // The row is read by token, and only the columns needed to render are taken.
  assert.match(body, /\.select\("id,is_public,share_expires_at,shared_at"\)/);
  for (const forbidden of ["customer_id", "guest_token", "share_token,"]) {
    assert.ok(!body.includes(forbidden), `the shared read must not select ${forbidden}`);
  }

  // And the returned view has no owner-shaped field at all.
  const view = wishlistService.slice(wishlistService.indexOf("export type SharedWishlistView"));
  const shape = view.slice(0, view.indexOf("};"));
  for (const forbidden of ["customerId", "wishlistId", "email", "ownerId", "guestToken"]) {
    assert.ok(!shape.includes(forbidden), `SharedWishlistView must not carry ${forbidden}`);
  }
});

test("revoking a share clears the token rather than only hiding it", () => {
  const revoke = wishlistService.slice(wishlistService.indexOf("export async function revokeWishlistShare"));
  // Clearing only is_public would let a later bug revive a link that leaked.
  assert.match(revoke, /share_token: null/);
  assert.match(revoke, /is_public: false/);
  assert.match(revoke, /share_expires_at: null/);
});

test("an empty wishlist cannot be shared", () => {
  const create = wishlistService.slice(wishlistService.indexOf("export async function createWishlistShare"));
  assert.match(create, /if \(!items\.length\) return \{ error:/);
});

test("re-sharing keeps the existing link unless rotation is asked for", () => {
  const create = wishlistService.slice(wishlistService.indexOf("export async function createWishlistShare"));
  assert.match(create, /options\.rotate \|\| !wishlist\.share_token \? createToken\(\) : wishlist\.share_token/);
});

test("a shared wishlist page is kept out of search indexes", () => {
  assert.match(sharedPage, /robots: \{ index: false, follow: false \}/);
});

/* -- copying and moving -------------------------------------------------- */

test("moving to the cart revalidates every line instead of trusting the wishlist", () => {
  // cartEligible is a hint for rendering. The authority is addCartItem, which
  // re-checks purchase mode, publication, stock, options, and price.
  assert.match(moveRoute, /await addCartItem\(cartOwner\.owner, \{/);
  assert.doesNotMatch(moveRoute, /unitPriceCents/, "the move path must never carry a price");
});

test("a moved item is only removed once the cart has actually accepted it", () => {
  const loop = moveRoute.slice(moveRoute.indexOf("for (const entry of targets)"));
  const accepted = loop.indexOf("moved += 1");
  const removed = loop.indexOf("if (wantsMove) await removeWishlistItem");
  assert.ok(accepted > -1 && removed > accepted, "removal must follow the successful add, never precede it");
  assert.match(loop, /if \(isCartMutationError\(result\)\) \{\s*failures\.push\(result\.error\);\s*continue;/);
});

test("copying from a shared link is restricted to products actually on that list", () => {
  // Without this the endpoint is a general "add anything to my cart" route that
  // merely happens to require a valid token.
  assert.match(sharedRoute, /shared\.entries\.filter\(\(entry\) => entry\.productId === productId\)/);
  assert.match(sharedRoute, /if \(!targets\.length\) \{/);
});

test("a share token never authorizes acting as the list's owner", () => {
  // The viewer's own owner is resolved from their own cookies and session.
  assert.match(sharedRoute, /resolveWishlistOwnerForWrite\(req\)/);
  assert.match(sharedRoute, /resolveOwnerForWrite\(req\)/);
  assert.doesNotMatch(sharedRoute, /findWishlist|created_by|customer_id/);
});

/* -- rate limiting ------------------------------------------------------- */

test("share creation and copying are rate limited well below ordinary writes", () => {
  assert.match(shareRoute, /consumeRateLimit\(RATE_LIMITS\.wishlistShare/);
  assert.match(sharedRoute, /consumeRateLimit\(RATE_LIMITS\.wishlistCopy/);
  assert.match(wishlistRoute, /consumeRateLimit\(RATE_LIMITS\.wishlistWrite/);

  const limits = rateLimit.slice(rateLimit.indexOf("export const RATE_LIMITS"));
  const share = /wishlistShare: \{ bucket: "wishlist\.share", limit: (\d+), windowSeconds: (\d+) \}/.exec(limits);
  const write = /wishlistWrite: \{ bucket: "wishlist\.write", limit: (\d+), windowSeconds: (\d+) \}/.exec(limits);
  assert.ok(share && write);
  const sharePerMinute = Number(share[1]) / (Number(share[2]) / 60);
  const writePerMinute = Number(write[1]) / (Number(write[2]) / 60);
  assert.ok(sharePerMinute < writePerMinute, "minting share links must be tighter than saving items");
});

test("the rate limiter never stores a raw guest token or user id", () => {
  assert.match(rateLimit, /createHash\("sha256"\)/);
  assert.match(rateLimit, /export function rateLimitSubject/);
  // Every caller goes through the digest, not the raw identity.
  assert.match(rateLimit, /p_subject: rateLimitSubject\(identity\)/);
  assert.match(migration, /constraint rate_limit_hits_subject_shape check \(char_length\(subject\) between 16 and 128\)/);
});

test("the rate limiter is atomic so a burst cannot slip past the limit", () => {
  // Without the advisory lock two concurrent requests both read the count below
  // the limit and both proceed — exactly the burst this exists to stop.
  assert.match(migration, /perform pg_advisory_xact_lock\(hashtextextended\(p_bucket \|\| ':' \|\| p_subject, 0\)\)/);
});

test("the rate limiter fails open, because it is not an authorization control", () => {
  const consume = rateLimit.slice(rateLimit.indexOf("export async function consumeRateLimit"));
  assert.match(consume, /if \(error \|\| !data\) return \{ allowed: true/);
});

test("the rate-limit table denies anon and authenticated outright", () => {
  assert.match(migration, /alter table public\.rate_limit_hits enable row level security/);
  assert.match(migration, /revoke all on public\.rate_limit_hits from anon, authenticated/);
  assert.match(migration, /revoke all on function public\.consume_rate_limit\(text, text, integer, integer\) from public, anon, authenticated/);
});

test("the wishlist migration is additive", () => {
  assert.match(migration, /add column if not exists share_expires_at timestamptz/);
  assert.match(migration, /create table if not exists public\.rate_limit_hits/);
  assert.doesNotMatch(migration, /drop table|drop column|alter column .* type/i);
});

/* -- interface ----------------------------------------------------------- */

test("the wishlist toggle announces its state rather than just showing a heart", () => {
  assert.match(wishlistButton, /aria-pressed=\{saved\}/);
  // The accessible name carries the product, so a grid of cards is navigable.
  assert.match(wishlistButton, /const label = saved \? `Remove \$\{productName\}/);
  assert.match(wishlistButton, /focus-visible:outline/);
});

test("the wishlist indicator is reachable on mobile as well as desktop", () => {
  const header = read("src/components/SiteHeader.tsx");
  const mounts = header.match(/<WishlistIndicator \/>/g) ?? [];
  assert.equal(mounts.length, 2, "WishlistIndicator must be mounted in both the desktop and mobile bars");
});

test("the wishlist toggle on a card sits above the card's stretched link", () => {
  const card = read("src/components/ProductCard.tsx");
  // .product-card-link::after covers the whole card; without its own stacking
  // context the toggle is rendered but unclickable.
  assert.match(card, /absolute right-3 top-3 z-10/);
  assert.match(card, /<WishlistButton[\s\S]*?variant="icon"/);
});

test("the wishlist page covers loading, error, empty, and populated states", () => {
  const page = read("src/app/wishlist/page.tsx");
  assert.match(page, /if \(isLoading\)/);
  assert.match(page, /if \(isError\)/);
  assert.match(page, /ui-empty-state/);
  assert.match(page, /role="alert"/);
  assert.match(page, /aria-live="polite"/);
});
