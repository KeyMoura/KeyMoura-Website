import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  buildDiscountDraft,
  buildTargetDrafts,
  DISCOUNT_CODE_PATTERN,
  discountStatus,
  discountValueLabel,
} from "../src/lib/commerce/discountAdmin.ts";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const listRoute = read("src/app/api/staff/catalog/discounts/route.ts");
const itemRoute = read("src/app/api/staff/catalog/discounts/[id]/route.ts");
const page = read("src/app/staff/catalog/discounts/page.tsx");
const cartRoute = read("src/app/api/cart/route.ts");
const migration = read("supabase/migrations/20260802020300_discount_codes.sql");

const base = { code: "SPRING10", discountType: "percent", discountValue: 10 };

/* -- draft validation, tested directly ---------------------------------- */

test("the code pattern matches the database constraint exactly", () => {
  // Lifted from discount_codes_code_shape. If these drift, staff get a raw
  // constraint violation instead of a sentence.
  const constraint = /constraint discount_codes_code_shape check \(code ~ '([^']+)'\)/.exec(migration);
  assert.ok(constraint, "the migration must still declare the code shape");
  assert.equal(DISCOUNT_CODE_PATTERN.source, constraint[1]);
});

test("a code is normalized to upper case before it is validated", () => {
  const result = buildDiscountDraft({ ...base, code: "  spring10  " });
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.draft.code, "SPRING10");
});

test("a malformed code is refused with an explanation", () => {
  for (const code of ["", "AB", "-LEADING", "has space"]) {
    const result = buildDiscountDraft({ ...base, code });
    assert.equal(result.ok, false, `${code} must be refused`);
  }
});

test("an over-long code is refused rather than silently truncated", () => {
  // normalizeDiscountCodeInput slices to 40, which is correct when a *customer*
  // submits a code. Applying it here would store the first 40 characters of a
  // longer one, and staff would hand out a code that never matches.
  const result = buildDiscountDraft({ ...base, code: "A".repeat(41) });
  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.problem, /at most 40 characters/);

  assert.equal(buildDiscountDraft({ ...base, code: "A".repeat(40) }).ok, true, "exactly 40 is allowed");
});

test("a percentage is stored as whole percent and a fixed amount as cents", () => {
  const percent = buildDiscountDraft({ ...base, discountType: "percent", discountValue: 15 });
  assert.equal(percent.ok && percent.draft.discount_value, 15);

  // The form takes dollars; the column is cents. Getting this backwards is a
  // hundredfold pricing error in the customer's favour.
  const fixed = buildDiscountDraft({ ...base, discountType: "fixed", discountValue: 12.5 });
  assert.equal(fixed.ok && fixed.draft.discount_value, 1250);
});

test("percentages outside 1 to 100 are refused", () => {
  for (const value of [0, -5, 101, 1000]) {
    const result = buildDiscountDraft({ ...base, discountType: "percent", discountValue: value });
    assert.equal(result.ok, false, `${value}% must be refused`);
  }
  assert.equal(buildDiscountDraft({ ...base, discountType: "percent", discountValue: 100 }).ok, true);
});

test("a fixed discount of nothing is refused", () => {
  assert.equal(buildDiscountDraft({ ...base, discountType: "fixed", discountValue: 0 }).ok, false);
  assert.equal(buildDiscountDraft({ ...base, discountType: "fixed", discountValue: -1 }).ok, false);
});

test("an end date must follow the start date", () => {
  const result = buildDiscountDraft({
    ...base,
    startsAt: "2026-09-01",
    endsAt: "2026-08-01",
  });
  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.problem, /after the start date/);

  assert.equal(buildDiscountDraft({ ...base, startsAt: "2026-08-01", endsAt: "2026-09-01" }).ok, true);
});

test("empty optional fields mean no limit rather than zero", () => {
  const result = buildDiscountDraft({
    ...base,
    maxDiscount: "",
    minimumSubtotal: "",
    startsAt: "",
    endsAt: "",
    maxTotalUses: "",
    maxUsesPerCustomer: "",
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.equal(result.draft.max_discount_cents, null);
  assert.equal(result.draft.starts_at, null);
  assert.equal(result.draft.ends_at, null);
  assert.equal(result.draft.max_total_uses, null);
  assert.equal(result.draft.max_uses_per_customer, null);
  // A minimum genuinely is zero rather than absent — the column is NOT NULL.
  assert.equal(result.draft.minimum_subtotal_cents, 0);
});

test("a zero or negative usage limit is refused rather than silently dropped", () => {
  // Storing 0 would violate discount_codes_limits_check; silently turning it
  // into null would create an unlimited code the staff member did not ask for.
  assert.equal(buildDiscountDraft({ ...base, maxTotalUses: 0 }).ok, false);
  assert.equal(buildDiscountDraft({ ...base, maxUsesPerCustomer: -3 }).ok, false);
  assert.equal(buildDiscountDraft({ ...base, maxTotalUses: "not a number" }).ok, false);
});

test("money fields are converted to cents", () => {
  const result = buildDiscountDraft({ ...base, maxDiscount: 25, minimumSubtotal: 99.99 });
  assert.equal(result.ok && result.draft.max_discount_cents, 2500);
  assert.equal(result.ok && result.draft.minimum_subtotal_cents, 9999);
});

test("flags default to the safe option", () => {
  const result = buildDiscountDraft(base);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  // Stacking and first-order-only both widen or narrow who can use a code, so
  // neither may be enabled by an omitted field.
  assert.equal(result.draft.is_stackable, false);
  assert.equal(result.draft.first_order_only, false);
  assert.equal(result.draft.is_active, true);
});

/* -- targeting ----------------------------------------------------------- */

test("targeting rows are deduplicated on the same key as the unique index", () => {
  const targets = buildTargetDrafts([
    { targetType: "product", targetId: "p1", isExclusion: false },
    { targetType: "product", targetId: "p1", isExclusion: false },
    { targetType: "category", targetId: "c1", isExclusion: true },
  ]);
  assert.equal(targets.length, 2);
});

test("a product both included and excluded keeps both rows", () => {
  // The exclusion wins at evaluation time. Dropping one here would hide the
  // staff member's contradiction rather than letting the list show it.
  const targets = buildTargetDrafts([
    { targetType: "product", targetId: "p1", isExclusion: false },
    { targetType: "product", targetId: "p1", isExclusion: true },
  ]);
  assert.equal(targets.length, 2);
});

test("malformed targeting entries are dropped rather than stored", () => {
  const targets = buildTargetDrafts([
    { targetType: "nonsense", targetId: "p1" },
    { targetType: "product", targetId: "" },
    null,
    "not an object",
    { targetType: "product", targetId: "p2", isExclusion: false },
  ]);
  assert.deepEqual(targets, [{ target_type: "product", target_id: "p2", is_exclusion: false }]);
});

test("targeting is bounded", () => {
  const many = Array.from({ length: 400 }, (_, index) => ({
    targetType: "product",
    targetId: `p${index}`,
    isExclusion: false,
  }));
  assert.ok(buildTargetDrafts(many).length <= 200);
});

/* -- status and labels --------------------------------------------------- */

test("the staff status never claims a code is live when a customer would be refused", () => {
  const now = new Date("2026-08-03T00:00:00Z");
  const live = {
    is_active: true,
    starts_at: null,
    ends_at: null,
    max_total_uses: null,
    archived_at: null,
    total_uses: 0,
  };

  assert.equal(discountStatus(live, now), null);
  assert.equal(discountStatus({ ...live, archived_at: "2026-08-01T00:00:00Z" }, now), "Archived");
  assert.equal(discountStatus({ ...live, is_active: false }, now), "Inactive");
  assert.equal(discountStatus({ ...live, starts_at: "2026-09-01T00:00:00Z" }, now), "Not started");
  assert.equal(discountStatus({ ...live, ends_at: "2026-08-01T00:00:00Z" }, now), "Expired");
  assert.equal(discountStatus({ ...live, max_total_uses: 5, total_uses: 5 }, now), "Fully redeemed");
});

test("the value label reads as money or percent, not a raw column", () => {
  assert.equal(discountValueLabel({ discount_type: "percent", discount_value: 15 }), "15% off");
  assert.equal(discountValueLabel({ discount_type: "fixed", discount_value: 1250 }), "$12.50 off");
});

/* -- routes -------------------------------------------------------------- */

test("every discount handler requires the discount permission", () => {
  for (const [name, source] of [["list", listRoute], ["item", itemRoute]] as const) {
    const handlers = source.match(/export async function (GET|POST|PATCH|DELETE)/g) ?? [];
    assert.ok(handlers.length > 0, `${name} route defines no handlers`);
    const guards = source.match(/requirePermission\(req, "catalog\.discounts\.manage"\)/g) ?? [];
    assert.equal(guards.length, handlers.length, `${name} route has an unguarded handler`);
  }
});

test("a redeemed code is archived rather than deleted", () => {
  const remove = itemRoute.slice(itemRoute.indexOf("export async function DELETE"));
  // discount_redemptions references the code, and an order's discount has to
  // stay explainable long after the code stops being offered.
  assert.match(remove, /archived_at: new Date\(\)\.toISOString\(\)/);
  assert.doesNotMatch(remove, /\.delete\(\)\.eq\("id"/);
});

test("a partial edit cannot silently strip a code's targeting", () => {
  const patch = itemRoute.slice(itemRoute.indexOf("export async function PATCH"));
  assert.match(patch, /if \(body\.targets !== undefined\)/);
});

test("every discount change writes an audit event", () => {
  for (const event of ["create"]) {
    assert.match(listRoute, new RegExp(`staff\\.catalog\\.discount\\.${event}`));
  }
  for (const event of ["update", "archive", "activate", "deactivate"]) {
    assert.match(itemRoute, new RegExp(`staff\\.catalog\\.discount\\.${event}`));
  }
});

test("audit metadata carries the code and its terms, never customer data", () => {
  for (const source of [listRoute, itemRoute]) {
    const events = source.matchAll(/metadata: \{([^}]*)\}/g);
    for (const [, body] of events) {
      for (const forbidden of ["customer", "email", "userId", "name:"]) {
        assert.ok(!body.includes(forbidden), `audit metadata must not carry ${forbidden}`);
      }
    }
  }
});

test("the usage report totals redemptions rather than trusting the held counter", () => {
  // total_uses is decremented when an unpaid order releases a code, so it
  // answers "how many are still held", not "how much has this cost us".
  assert.match(listRoute, /from\("discount_redemptions"\)\.select\("discount_code_id,amount_cents"\)/);
  assert.match(listRoute, /entry\.amountCents \+= Number\(row\.amount_cents \?\? 0\)/);
});

test("the usage report shows orders, not customer identities", () => {
  const get = itemRoute.slice(itemRoute.indexOf("export async function GET"));
  assert.match(get, /select\("id,order_number,status,payment_status"\)/);
  assert.doesNotMatch(get, /customer_id|email/);
});

test("a failed targeting write is reported rather than reported as success", () => {
  const post = listRoute.slice(listRoute.indexOf("export async function POST"));
  // Leaving staff believing a restricted code is restricted is the dangerous
  // outcome here — an unrestricted code discounts the whole catalog.
  assert.match(post, /status: 207/);
  assert.match(post, /targeting did not save/);
});

/* -- customer-facing ------------------------------------------------------ */

test("discount attempts are rate limited but clearing a code is not", () => {
  assert.match(cartRoute, /const isDiscountAttempt = typeof body\.discountCode === "string" && body\.discountCode\.trim\(\) !== ""/);
  assert.match(cartRoute, /if \(isDiscountAttempt\) \{/);
  assert.match(cartRoute, /consumeRateLimit\(RATE_LIMITS\.discountAttempt, identity\)/);
});

test("the customer never sends a discount amount, only a code", () => {
  for (const forbidden of ["discountCents", "discountAmount", "amountCents"]) {
    assert.doesNotMatch(cartRoute, new RegExp(`body\\.${forbidden}`));
  }
});

test("the staff page refuses to render without the permission", () => {
  assert.match(page, /const canManage = permissions\.has\("catalog\.discounts\.manage"\)/);
  assert.match(page, /if \(!canManage\) \{[\s\S]{0,160}AccessDeniedCard/);
});

test("the staff page explains that pricing is ours, not Stripe's", () => {
  assert.match(page, /not by Stripe/);
  assert.match(page, /confirmed again immediately before payment/);
});
