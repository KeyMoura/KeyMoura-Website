import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

/** Source with comments stripped: several assertions below name what must not appear. */
const code = (source: string) =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

const login = read("src/app/auth/login/page.tsx");
const account = read("src/app/account/page.tsx");

/**
 * Replacing Discord with Facebook.
 *
 * The production audit before this change: **3 users, 0 with a Discord
 * identity, 0 whose only method is Discord.** Nobody's login path was removed.
 * Nothing was disabled in Supabase Auth and no identity was unlinked — the UI
 * stopped *offering* Discord, which is a different thing from the project
 * refusing it.
 */

// ---------------------------------------------------------------------------
// What is offered
// ---------------------------------------------------------------------------

test("sign-in offers Google and Facebook, and no longer offers Discord", () => {
  const source = code(login);
  assert.match(source, /handleOAuth\("google"\)/);
  assert.match(source, /handleOAuth\("facebook"\)/);
  assert.match(source, /Continue with Facebook/);
  assert.doesNotMatch(source, /handleOAuth\("discord"\)/);
  assert.doesNotMatch(source, /Continue with Discord/);
});

test("account linking offers Google and Facebook, and no longer offers Discord", () => {
  const source = code(account);
  assert.match(source, /const offeredProviders = \["google", "facebook"\] as const/);
  assert.doesNotMatch(source, /offeredProviders = \[[^\]]*discord/);
});

test("email and password sign-in are untouched", () => {
  const source = code(login);
  assert.match(source, /signInWithPassword|signInWithOtp|\/api\/auth/, "email sign-in must still exist");
  assert.match(source, /type="password"|type="email"/);
});

// ---------------------------------------------------------------------------
// The provider identifier is the real one
// ---------------------------------------------------------------------------

test("facebook is a provider the installed Supabase client actually accepts", () => {
  // Checked against `node_modules` rather than remembered. A provider string
  // the SDK does not know is a runtime failure at the moment somebody tries to
  // sign in, which is the worst possible time to find out.
  const types = read("node_modules/@supabase/auth-js/dist/module/lib/types.d.ts");
  const union = types.match(/export type Provider = ([^;]+);/);
  assert.ok(union, "the SDK must still export a Provider union");
  assert.match(union[1], /'facebook'/);
  // And the handlers are typed to that exact literal, so a typo is a compile
  // error rather than a redirect to nowhere.
  assert.match(code(login), /provider: "google" \| "facebook"/);
  assert.match(code(account), /provider: "google" \| "facebook"/);
});

// ---------------------------------------------------------------------------
// Existing identities are preserved
// ---------------------------------------------------------------------------

test("an already-linked provider stays visible after it stops being offered", () => {
  // The audit found zero Discord identities, so this protects a case that does
  // not currently exist — which is exactly when it is cheap to get right. An
  // identity the UI stopped listing would be one the owner could neither see
  // nor remove.
  const source = code(account);
  assert.match(source, /for \(const identity of identities\)/);
  assert.match(source, /rows\.push\(\{ provider: identity\.provider, offered: false \}\)/);
  // Rendered with a label rather than a raw provider string.
  assert.match(account, /provider === "discord" \? "Discord"/);
  // …and with no Connect button, because there is nothing to connect it to.
  assert.match(source, /: offered \? <button/);
});

test("nothing unlinks an identity without the owner asking", () => {
  const source = code(account);
  // `unlinkIdentity` may appear exactly once, inside the handler the Disconnect
  // button calls. An automatic cleanup on load is the failure mode here.
  assert.equal((source.match(/unlinkIdentity\(/g) ?? []).length, 1);
  assert.match(source, /const handleUnlinkIdentity = async \(identity: AccountIdentity\)/);
  assert.doesNotMatch(source, /useEffect\([^)]*unlinkIdentity/);
});

test("the last usable login method cannot be disconnected", () => {
  const source = code(account);
  assert.match(source, /if \(identities\.length < 2\)/, "the handler refuses");
  assert.match(source, /disabled=\{identityBusy !== null \|\| identities\.length < 2\}/, "and the button is disabled");
  assert.match(source, /Add another sign-in method before disconnecting this one/);
});

// ---------------------------------------------------------------------------
// Redirects
// ---------------------------------------------------------------------------

test("OAuth returns to this origin and cannot be pointed elsewhere", () => {
  const source = code(login);
  // The redirect target is built from `window.location.origin`, never from a
  // query parameter, so `?redirectTo=https://evil.example` has nothing to
  // attach to.
  assert.match(source, /\$\{window\.location\.origin\}\/auth\/callback/);
  assert.doesNotMatch(source, /redirectTo:\s*(searchParams|params|requested)/);
});

test("the post-sign-in destination is refused unless it is a path on this site", () => {
  // `//evil.example` is a protocol-relative URL: it starts with "/" and is
  // still off-site, which is why the second clause exists.
  assert.match(login, /requested\?\.startsWith\("\/"\) && !requested\.startsWith\("\/\/"\)/);
  assert.match(code(account), /linkIdentity\(\{ provider, options: \{ redirectTo \} \}\)/);
  assert.match(account, /\$\{window\.location\.origin\}\/auth\/callback/);
});

test("the account link target encodes the provider it came back for", () => {
  // A provider name interpolated raw into a query string is a place to inject
  // one; `encodeURIComponent` is what stops it.
  assert.match(account, /encodeURIComponent\(`\/account\?linked=\$\{provider\}`\)/);
});
