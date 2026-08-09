import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { customerOrderPath, customerOrderUrl } from "../src/lib/commerce/orderUrls.ts";
import {
  GUEST_ACCESS_WINDOW_HOURS,
  GUEST_ACCESS_WINDOW_LABEL,
  GUEST_CODE_LENGTH,
  GUEST_CODE_TTL_MINUTES,
} from "../src/lib/commerce/guestAccessWindow.ts";
import { GUEST_ACCESS_WINDOW_DAYS, GUEST_ORDER_COOKIE_MAX_AGE } from "../src/lib/commerce/guestOrders.ts";

/**
 * The guest order email challenge.
 *
 * `guestOrderVerification.ts` is `server-only` and reaches the database through
 * a module-scope client, so its rules are asserted the way the rest of this
 * suite asserts server rules: against the source and the SQL that enforce them.
 * The pure helpers that can be imported — the URL helper, the window constants
 * — are exercised directly.
 */

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
/** Comments stripped, so a rule "found" in prose does not count as implemented. */
const code = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

const service = read("src/lib/commerce/guestOrderVerification.ts");
const route = read("src/app/api/orders/guest/[id]/verification/route.ts");
const component = read("src/components/commerce/GuestOrderVerification.tsx");
const guestPage = read("src/app/orders/guest/[id]/page.tsx");
const email = read("src/lib/commerceEmail.ts");
const guestOrders = read("src/lib/commerce/guestOrders.ts");
const migration = read("supabase/migrations/20260809010000_guest_order_verification.sql");
const installer = read("supabase/installer/modules/commerce.sql");

// ---------------------------------------------------------------------------
// The code itself
// ---------------------------------------------------------------------------

test("codes are six digits from a CSPRNG, zero-padded so leading zeros survive", () => {
  assert.match(service, /randomInt\(0, 1_000_000\)[\s\S]{0,60}padStart\(GUEST_CODE_LENGTH, "0"\)/);
  assert.equal(GUEST_CODE_LENGTH, 6);
  // Neither of the two ways to get this wrong: a non-cryptographic source, or
  // a modulo over raw bytes, which is biased.
  assert.doesNotMatch(code(service), /Math\.random/);
  assert.doesNotMatch(code(service), /randomBytes[\s\S]{0,40}%\s*1_?000_?000/);
});

test("codes are stored only as a domain-separated, order-bound HMAC", () => {
  assert.match(service, /createHmac\("sha256", key\)/);
  assert.match(service, /keymoura\.guest-order-code\.v1:\$\{orderId\}:\$\{code\}/);
  // A digest lifted from order A cannot be replayed against order B, and this
  // key's digests cannot be compared against any other subsystem's.
  assert.match(service, /GUEST_ORDER_VERIFICATION_SECRET/);
  // Nothing writes the plaintext. The column is `code_digest` in both the
  // historical migration and the installer baseline; neither has a `code` column.
  for (const [name, sql] of [["migration", migration], ["installer", installer]] as const) {
    assert.match(sql, /code_digest text not null/, `${name} stores a digest`);
    assert.doesNotMatch(sql, /^\s+code\s+text/m, `${name} must not store plaintext`);
  }
  assert.doesNotMatch(code(service), /p_code_digest: code\b/, "the raw code is never sent to the database");
});

test("comparison is constant-time and the secret is never logged", () => {
  assert.match(service, /timingSafeEqual\(actual, expected\)/);
  assert.match(service, /actual\.length === expected\.length/);
  const source = code(service) + code(route);
  assert.doesNotMatch(source, /console\.\w+\([^)]*\bcode\b/, "a code must never reach a log line");

  /*
   * The secret's *value* must never be logged. Its *name* deliberately is —
   * that single diagnostic is how an operator learns which variable to set, and
   * a check that forbade the string "SECRET" outright would forbid the one line
   * that makes the failure diagnosable. So the rule is about interpolation:
   * nothing that reads the key may appear inside a log call.
   */
  for (const reader of ["key", "verificationKey()", "process.env.GUEST_ORDER_VERIFICATION_SECRET"]) {
    const escaped = reader.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    assert.doesNotMatch(
      source,
      new RegExp(`console\\.\\w+\\([^)]*\\$\\{\\s*${escaped}`),
      `${reader} must never be interpolated into a log line`
    );
  }
  assert.doesNotMatch(source, /console\.\w+\([^)]*\bsecret\b(?!.*is not configured)/i);
});

// ---------------------------------------------------------------------------
// Defect A: a missing secret must fail closed, not with a 500
// ---------------------------------------------------------------------------

test("a missing secret fails closed with a controlled response, not an exception", () => {
  // Every entry point checks before it touches the database or throws.
  for (const entry of ["ensureGuestCode", "issueGuestCode", "verifyGuestCode"]) {
    const body = service.slice(service.indexOf(`export async function ${entry}`));
    assert.match(
      body.slice(0, 400),
      /if \(!guestVerificationConfigured\(\)\)[\s\S]{0,200}reason: "not_configured"/,
      `${entry} must fail closed before doing any work`
    );
  }
  assert.match(service, /function verificationKey\(\)[\s\S]{0,200}return key && key\.length > 0 \? key : null/);

  // The route turns that into 503 and a sentence that names nothing.
  assert.match(route, /issued\.reason === "not_configured"\) return NextResponse\.json\(UNCONFIGURED, \{ status: 503 \}\)/);
  assert.match(route, /result\.reason === "not_configured"\) return NextResponse\.json\(UNCONFIGURED, \{ status: 503 \}\)/);
  assert.match(route, /Order verification is temporarily unavailable/);
  assert.doesNotMatch(
    code(route),
    /GUEST_ORDER_VERIFICATION_SECRET|env|environment variable/i,
    "a response must never mention the server's configuration"
  );

  // A safe server-side diagnostic that names the variable and nothing else.
  assert.match(service, /function reportMisconfiguration\(where: string\)/);
  assert.match(service, /console\.error\(\s*`\[guest-order-verification\] GUEST_ORDER_VERIFICATION_SECRET is not configured/);

  // And the UI says it inline rather than throwing to an error boundary.
  assert.match(component, /response\.status === 503/);
  assert.match(component, /setPhase\("unavailable"\)/);
  assert.doesNotMatch(code(component), /\bthrow\b/, "a routine failure must not become an exception");
});

test("no order is exposed as a consolation when verification cannot run", () => {
  // The 503 path returns an error shape only — no order, no masked address.
  assert.match(route, /const UNCONFIGURED = \{[\s\S]{0,240}reason: "unavailable" as const,\s*\}/);
  assert.doesNotMatch(route, /UNCONFIGURED[\s\S]{0,80}maskedEmail/);
  // And the page only renders the order after `resolveGuestOrder` says ok.
  assert.match(guestPage, /if \(!result\.ok\) \{/);
});

// ---------------------------------------------------------------------------
// Defect B: one session lifetime, stated consistently
// ---------------------------------------------------------------------------

test("code lifetime and session lifetime are 15 minutes and 24 hours, from one constant each", () => {
  assert.equal(GUEST_CODE_TTL_MINUTES, 15);
  assert.match(service, /GUEST_CODE_TTL_SECONDS = GUEST_CODE_TTL_MINUTES \* 60/);

  assert.equal(GUEST_ACCESS_WINDOW_HOURS, 24);
  assert.equal(GUEST_ACCESS_WINDOW_LABEL, "24 hours");
  assert.equal(GUEST_ORDER_COOKIE_MAX_AGE, 60 * 60 * 24);
  assert.equal(GUEST_ACCESS_WINDOW_DAYS, 1);

  // Derived, not restated: the cookie's Max-Age and the row's expiry cannot
  // disagree, which is how a guest ends up staring at an unexplainable denial.
  assert.match(guestOrders, /GUEST_ORDER_COOKIE_MAX_AGE = 60 \* 60 \* GUEST_ACCESS_WINDOW_HOURS/);
  assert.match(guestOrders, /GUEST_ACCESS_WINDOW_DAYS = GUEST_ACCESS_WINDOW_HOURS \/ 24/);
  assert.match(guestOrders, /from\(\.getTime\(\) \+ GUEST_ORDER_COOKIE_MAX_AGE \* 1000\)|GUEST_ORDER_COOKIE_MAX_AGE \* 1000/);
});

test("no customer-facing copy still promises 90 days", () => {
  // The exact defect the previous implementation shipped: the session was cut
  // to a day while three pages still told the customer 90 days.
  for (const path of [
    "src/app/orders/guest/[id]/page.tsx",
    "src/app/cart/page.tsx",
    "src/components/product/ProductRequestForm.tsx",
  ]) {
    assert.doesNotMatch(read(path), /90 days/, `${path} still claims a 90-day guest session`);
  }
  // And they quote the shared constant rather than typing a number.
  for (const path of [
    "src/app/orders/guest/[id]/page.tsx",
    "src/app/cart/page.tsx",
    "src/components/product/ProductRequestForm.tsx",
  ]) {
    assert.match(read(path), /GUEST_ACCESS_WINDOW_LABEL/, `${path} must quote the shared window constant`);
  }
});

// ---------------------------------------------------------------------------
// Expiry, attempts, cooldown, replacement, single use
// ---------------------------------------------------------------------------

test("the challenge rules are the same numbers in the service and the database", () => {
  assert.match(service, /GUEST_CODE_RESEND_SECONDS = 60/);
  assert.match(service, /GUEST_CODE_MAX_ATTEMPTS = 5/);
  for (const [name, sql] of [["migration", migration], ["installer", installer]] as const) {
    // The order row is locked before the cooldown is read, so two concurrent
    // requests cannot both pass it.
    assert.match(sql, /for update/, `${name} locks the order`);
    assert.match(sql, /errcode = 'P0001'/, `${name} signals the cooldown distinctly`);
    // Replacement invalidates: the previous unconsumed row is consumed in the
    // same transaction that inserts the new one.
    assert.match(sql, /update public\.guest_order_access_codes set consumed_at = clock_timestamp\(\) where order_id = p_order_id and consumed_at is null;\s*insert into/, `${name} replaces atomically`);
    assert.match(sql, /unique index (?:if not exists )?guest_order_access_codes_one_active_idx/, `${name} permits one active challenge`);
    // Consumption re-checks expiry and the attempt ceiling in the same statement.
    assert.match(sql, /consumed_at is null and expires_at > clock_timestamp\(\) and failed_attempts < 5/, `${name} consumes only a live challenge`);
    assert.match(sql, /failed_attempts = least\(failed_attempts \+ 1, p_max_attempts\)/, `${name} counts failures`);
  }
});

test("verification checks state before the digest, and each failure is actionable", () => {
  const body = service.slice(service.indexOf("export async function verifyGuestCode"));
  const order = ["consumed_at", "failed_attempts >=", "Date.parse(row.expires_at)", "verificationDigestMatches"];
  let cursor = -1;
  for (const step of order) {
    const at = body.indexOf(step);
    assert.ok(at > cursor, `${step} must be checked in order`);
    cursor = at;
  }
  // A wrong guess increments through the database, so parallel guesses each cost.
  assert.match(body, /record_guest_order_code_failure/);
  // Distinct reasons, because "invalid" is useless advice for an expired code.
  for (const reason of ["expired", "attempt_limit", "consumed"]) {
    assert.match(route, new RegExp(`result\\.reason === "${reason}"`), `${reason} must be its own message`);
  }
  assert.match(route, /Send a new code to continue/);
});

test("a spent challenge cannot be replayed even if the digest matches", () => {
  // The RPC's own re-check is the authority; a false return means another
  // request consumed it first, and that is reported rather than ignored.
  assert.match(service, /if \(consumed\.error \|\| consumed\.data !== true\) return \{ ok: false, reason: "consumed" \}/);
});

test("the shape check runs before the HMAC", () => {
  const body = service.slice(service.indexOf("export async function verifyGuestCode"));
  assert.ok(
    body.indexOf("GUEST_CODE_LENGTH}\\}$") > -1 || /\^\\\\d\{\$\{GUEST_CODE_LENGTH\}\}\$/.test(body),
    "a non-numeric string must be rejected on shape"
  );
  assert.ok(body.indexOf("reason: \"invalid\"") < body.indexOf("verificationDigestMatches"));
});

// ---------------------------------------------------------------------------
// Phase 9: opening the page must not spam the inbox
// ---------------------------------------------------------------------------

test("a refresh while a challenge is live sends no second email", () => {
  // The page's own request is `ensure`, which reuses a usable challenge.
  assert.match(service, /export async function ensureGuestCode/);
  assert.match(service, /if \(stillUsable\(await latestChallenge\(orderId\)\)\) \{\s*return \{ ok: true, sent: false, maskedEmail/);
  assert.match(service, /function stillUsable[\s\S]{0,320}row\.consumed_at === null &&[\s\S]{0,200}failed_attempts < GUEST_CODE_MAX_ATTEMPTS &&[\s\S]{0,120}Date\.parse\(row\.expires_at\) > now/);

  // The route only replaces on an explicit resend.
  assert.match(route, /const wantsNew = body\.resend === true/);
  assert.match(route, /wantsNew \? await issueGuestCode\(id\) : await ensureGuestCode\(id\)/);
  // A reused challenge returns without an email being sent.
  assert.match(route, /if \(!issued\.sent\) \{\s*return NextResponse\.json\(\{ sent: false, alreadySent: true/);

  // The component's mount request is the non-resending one, and the button is
  // the resending one.
  assert.match(component, /requested\.current = true;\s*void requestCode\(false\)/);
  assert.match(component, /onClick=\{\(\) => void requestCode\(true\)\}/);
  assert.match(component, /disabled=\{busy \|\| cooldown > 0\}/);
});

test("even a duplicated send cannot deliver two copies of one code", () => {
  // One delivery key per challenge row, which the email layer deduplicates on.
  assert.match(route, /eventKey: `guest-access-\$\{issued\.challengeId\}`/);
  assert.match(email, /idempotencyKey: input\.eventKey/);
});

// ---------------------------------------------------------------------------
// Ownership, routes and URLs
// ---------------------------------------------------------------------------

test("account and guest orders resolve to different paths from one helper", () => {
  assert.equal(customerOrderPath("abc", "customer-a"), "/orders/abc");
  assert.equal(customerOrderPath("abc", null), "/orders/guest/abc");
  assert.equal(customerOrderPath("abc", undefined), "/orders/guest/abc");
  assert.equal(customerOrderUrl("https://keymoura.com", "abc", null), "https://keymoura.com/orders/guest/abc");
  assert.equal(customerOrderUrl("https://keymoura.com/", "abc", "cust"), "https://keymoura.com/orders/abc");
});

test("every customer order email derives its link from ownership, in one place", () => {
  assert.match(email, /customerOrderUrl\(config\.siteUrl, input\.orderId/);
  assert.match(email, /if \(input\.orderId && audience === "customer"\)/);
  // The old unconditional `/orders/${id}` is gone, which is what sent guests to
  // a page that could only refuse them.
  assert.doesNotMatch(code(email), /input\.orderId \? `\/orders\/\$\{input\.orderId\}`/);
});

test("no credential is ever placed in a URL", () => {
  for (const [name, source] of [
    ["email", email],
    ["route", route],
    ["component", component],
    ["page", guestPage],
  ] as const) {
    assert.doesNotMatch(code(source), /[?&](?:token|code)=/, `${name} must not put a credential in a URL`);
  }
  // The button target is the order page, not a magic link.
  assert.match(route, /orderId: id,/);
});

test("a logged-in account cannot reach a guest order, by email match or otherwise", () => {
  // Issuing requires the order to have no customer, so an account whose address
  // happens to equal `guest_email` gets nothing. Account claiming is a separate
  // feature, deliberately not this one.
  assert.match(service, /\.select\("customer_id,guest_email"\)/);
  assert.match(service, /if \(result\.error \|\| !order \|\| order\.customer_id \|\| !order\.guest_email\) return null/);
  assert.doesNotMatch(code(service), /guest_email\s*===|\.eq\("guest_email"/, "an address must never be an authorization");
  // And the database refuses too, independently of the service.
  for (const sql of [migration, installer]) {
    assert.match(sql, /where id = p_order_id and customer_id is null and guest_email is not null for update/);
  }
});

test("a session unlocks exactly the order it was minted for", () => {
  // The session digest is written onto that one order row, and the read path
  // fetches by id then compares — so a token for A presented at B fails.
  for (const sql of [migration, installer]) {
    assert.match(sql, /update public\.orders set guest_token_hash = p_session_digest, guest_access_expires_at = p_session_expires_at\s*where id = p_order_id/);
  }
  assert.match(service, /p_order_id: orderId,\s*p_session_digest: hashGuestOrderToken\(token\)/);
});

test("the session token leaves only as a cookie", () => {
  assert.match(route, /response\.cookies\.set\(GUEST_ORDER_COOKIE, result\.token, guestOrderCookieOptions\(\)\)/);
  // The JSON body is a bare confirmation. Asserted on the literal rather than a
  // loose scan, because the previous version's regex matched the `Set-Cookie`
  // line that follows and failed on correct code.
  assert.match(route, /const response = NextResponse\.json\(\{ verified: true \}\)/);
  assert.doesNotMatch(route, /NextResponse\.json\(\{[^}]*token/);
  assert.doesNotMatch(code(component), /result\.token|\.token\b/, "the client never sees a token");
});

// ---------------------------------------------------------------------------
// Masking
// ---------------------------------------------------------------------------

test("only a masked destination is ever returned", async () => {
  const { maskGuestEmail } = await import("../src/lib/commerce/guestOrderVerification.ts").catch(() => ({
    maskGuestEmail: null,
  })) as { maskGuestEmail: ((email: string) => string) | null };

  // `server-only` may refuse to load outside a Next server; the rule is then
  // asserted on the source, which is how the rest of this suite handles it.
  if (maskGuestEmail) {
    assert.equal(maskGuestEmail("ethan@keymoura.com"), "e••••@keymoura.com");
    assert.equal(maskGuestEmail("a@b.com"), "a••••@b.com");
    // A long local part does not leak its length.
    assert.equal(maskGuestEmail("averylonglocalpart@example.com"), "a••••••••@example.com");
    assert.equal(maskGuestEmail("not-an-email"), "•••••");
  } else {
    assert.match(service, /local\.slice\(0, 1\)/);
    assert.match(service, /Math\.max\(4, Math\.min\(local\.length - 1, 8\)\)/);
  }

  // The address itself is never returned to the browser.
  assert.match(route, /maskedEmail: issued\.maskedEmail/);
  assert.doesNotMatch(route, /NextResponse\.json\(\{[^}]*\bemail:/);
});

test("the destination is the order's stored address and cannot be supplied", () => {
  // No caller-provided recipient anywhere on this path — that would be an open
  // relay for order details.
  assert.match(route, /to: issued\.email/);
  assert.doesNotMatch(code(route), /body\.email|body\?\.email/, "the recipient must never come from the request");
  assert.doesNotMatch(code(component), /email:/, "the client cannot name a recipient");
});

// ---------------------------------------------------------------------------
// Phase 8: the form
// ---------------------------------------------------------------------------

test("the verification form is usable, accessible and paste-friendly", () => {
  assert.match(component, /Order access/);
  assert.match(component, /Enter the \{CODE_LENGTH\}-digit code sent to your email/);
  assert.match(component, /inputMode="numeric"/);
  assert.match(component, /autoComplete="one-time-code"/);
  assert.match(component, /htmlFor="guest-order-code"/);
  assert.match(component, /id="guest-order-code"/);
  // Paste of "123 456" or "123-456" becomes a valid entry instead of an error.
  assert.match(component, /value\.replace\(\/\\D\/g, ""\)\.slice\(0, CODE_LENGTH\)|event\.target\.value\.replace\(\/\\D\/g, ""\)/);
  assert.match(component, /role="alert"/);
  assert.match(component, /aria-live="polite"/);
  assert.match(component, /aria-describedby=\{error \? "guest-code-error" : undefined\}/);
  assert.match(component, /busy \? "Checking…" : "Verify"/);
  assert.match(component, /cooldown > 0 \? `Send a new code \(\$\{cooldown\}s\)` : "Send a new code"/);
  // Real buttons and a real form, so the keyboard works without any handlers.
  assert.match(component, /<button type="submit"/);
  assert.match(component, /<form onSubmit=\{verify\}/);
});

test("routine failures render inline rather than reaching an error boundary", () => {
  assert.doesNotMatch(code(component), /\bthrow\b/);
  assert.match(component, /catch \{/);
  assert.match(component, /setError\(/);
});

// ---------------------------------------------------------------------------
// Phase 11 / D: schema, grants and installer parity
// ---------------------------------------------------------------------------

test("the challenge table is unreachable by anon and by authenticated", () => {
  for (const [name, sql] of [["migration", migration], ["installer", installer]] as const) {
    assert.match(sql, /alter table public\.guest_order_access_codes enable row level security/, `${name} enables RLS`);
    assert.match(sql, /revoke all on public\.guest_order_access_codes from public, anon, authenticated/, `${name} revokes`);
    assert.match(sql, /grant select, insert, update, delete on public\.guest_order_access_codes to service_role/, `${name} grants only service_role`);
    // No policy is created, which with RLS on is a deny-all.
    assert.doesNotMatch(sql, /create policy[^\n]*guest_order_access_codes/i, `${name} must not add a policy`);
  }
});

test("every challenge function is search_path-pinned and service-role only", () => {
  const functions = [
    ["replace_guest_order_access_code", "uuid,text,timestamptz,integer"],
    ["record_guest_order_code_failure", "uuid,integer"],
    ["consume_guest_order_access_code", "uuid,uuid,text,timestamptz"],
  ] as const;
  for (const [name, sql] of [["migration", migration], ["installer", installer]] as const) {
    for (const [fn, args] of functions) {
      assert.match(sql, new RegExp(`create or replace function public\\.${fn}\\(`), `${name} defines ${fn}`);
      assert.match(sql, new RegExp(`revoke all on function public\\.${fn}\\(${args.replace(/,/g, ",")}\\) from public, anon, authenticated`), `${name} revokes ${fn}`);
      assert.match(sql, new RegExp(`grant execute on function public\\.${fn}\\(${args}\\) to service_role`), `${name} grants ${fn} to service_role only`);
    }
    const definers = sql.match(/security definer set search_path = public, pg_temp/g) ?? [];
    assert.equal(definers.length, 3, `${name}: every SECURITY DEFINER function must pin search_path`);
  }
});

test("indexes support order lookup and the active-challenge rules", () => {
  for (const [name, sql] of [["migration", migration], ["installer", installer]] as const) {
    assert.match(sql, /index (?:if not exists )?guest_order_access_codes_order_created_idx\s*\n?\s*on public\.guest_order_access_codes\(order_id, created_at desc\)/, `${name} indexes the lookup`);
    assert.match(sql, /unique index (?:if not exists )?guest_order_access_codes_one_active_idx\s*\n?\s*on public\.guest_order_access_codes\(order_id\) where consumed_at is null/, `${name} enforces one active challenge`);
  }
});

test("a fresh install produces the production schema, idempotently", () => {
  /*
   * Defect D. The migration is history and runs once, so it uses bare
   * `create table`; the installer baseline is promised to be re-runnable
   * against an existing database, so it must not. Both must describe the same
   * objects — this asserts each file uses the form its own contract requires.
   */
  assert.match(installer, /create table if not exists public\.guest_order_access_codes/);
  assert.match(installer, /create index if not exists guest_order_access_codes_order_created_idx/);
  assert.match(installer, /create unique index if not exists guest_order_access_codes_one_active_idx/);
  assert.match(migration, /create table public\.guest_order_access_codes/);

  // The columns match production, in both files.
  for (const column of [
    "id uuid primary key",
    "order_id uuid not null references public.orders(id) on delete cascade",
    "code_digest text not null check (char_length(code_digest) between 40 and 100)",
    "expires_at timestamptz not null",
    "consumed_at timestamptz",
    "failed_attempts smallint not null default 0 check (failed_attempts between 0 and 5)",
    "last_attempt_at timestamptz",
    "created_at timestamptz not null default now()",
  ]) {
    for (const [name, sql] of [["migration", migration], ["installer", installer]] as const) {
      assert.ok(sql.includes(column), `${name} is missing column definition: ${column}`);
    }
  }

  // The installer seeds the template without assuming a table it never installs.
  assert.match(installer, /to_regclass\('public\.email_templates'\) is not null/);
  assert.match(installer, /'guest_order_access','Guest order access'/);
});

test("the restored migration is history and is not re-runnable by accident", () => {
  // It is kept byte-exact because production's ledger already records this
  // version. Nothing in the repository should ever apply it again.
  assert.match(migration, /^begin;/);
  assert.match(migration, /commit;\s*$/);
  assert.doesNotMatch(installer, /\\ir \.\.\/\.\.\/migrations\/20260809010000/, "the baseline restates the schema rather than re-running history");
});
