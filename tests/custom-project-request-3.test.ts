import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  ACCEPTED_FILE_EXTENSIONS,
  MAX_BUDGET_CENTS,
  MAX_FILE_BYTES,
  MAX_QUANTITY,
  MAX_REQUEST_FILES,
  REQUEST_TYPES,
  STEP_IDS,
  describeBudget,
  describeDimensions,
  describeTiming,
  emptyCustomRequest,
  fallbackTitle,
  fileKind,
  fileProblem,
  fulfillmentMethodFor,
  normalizeReferenceUrl,
  parseMoneyToCents,
  requestType,
  safeStorageName,
  storageContentType,
  validateAll,
  validateStep,
  type CustomRequestForm,
} from "../src/lib/orders/customRequest.ts";

/**
 * Custom Project Request 3.0.
 *
 * The domain rules are exercised as functions, because they *are* functions —
 * `/orders/new` and `/api/orders/custom` both import them, so a rule proven
 * here is proven for the form and for the route at once. The source assertions
 * that follow cover the things a unit test cannot reach: that the route really
 * does re-run the shared validation server-side, that ownership is still
 * decided by `customer_id` and a storage prefix, and that no second request
 * model was introduced.
 *
 * Comments are stripped before any `doesNotMatch`, because this codebase
 * routinely names the thing it removed in the comment explaining the removal.
 */

const read = (path: string) => readFileSync(path, "utf8");
const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, "");

const domain = read("src/lib/orders/customRequest.ts");
const page = read("src/app/orders/new/page.tsx");
const wizard = read("src/components/orders/CustomRequestWizard.tsx");
const steps = read("src/components/orders/CustomRequestSteps.tsx");
const filesUi = read("src/components/orders/RequestFiles.tsx");
const controls = read("src/components/orders/RequestControls.tsx");
const route = read("src/app/api/orders/custom/route.ts");
const specs = read("src/components/RequestSpecifications.tsx");
const bucket = read("supabase/migrations/20260731060000_configurable_products_recovery.sql");

/** A form that passes every step, as a base for the negative cases. */
function validForm(overrides: Partial<CustomRequestForm> = {}): CustomRequestForm {
  return {
    ...emptyCustomRequest(),
    request_type: "part",
    description: "A replacement knob for my drill press, it threads onto a 3/8-16 stud.",
    ...overrides,
  };
}

/* ===================================================================
 * Phase 56 — flow
 * ================================================================ */

test("the flow is five steps ending in a review", () => {
  assert.deepEqual([...STEP_IDS], ["project", "details", "files", "logistics", "review"]);
});

test("a project type must be chosen before anything else is asked", () => {
  const problems = validateStep("project", emptyCustomRequest());
  assert.equal(problems[0].field, "request_type");
});

test("existing-product requests must name the product they change", () => {
  const problems = validateStep("project", validForm({ request_type: "existing-product" }));
  assert.ok(problems.some((problem) => problem.field === "product_slug"));

  const chosen = validateStep("project", validForm({ request_type: "existing-product", product_slug: "walnut-board" }));
  assert.deepEqual(chosen, []);
});

test("a new custom project is not asked which product it is based on", () => {
  assert.deepEqual(validateStep("project", validForm({ request_type: "woodworking" })), []);
});

test("every request type is one the capabilities page claims", () => {
  // `/capabilities` names one-off parts, prototypes, signs, fixtures, plates,
  // knobs, trim pieces and short runs. Nothing here may promise more.
  const ids = REQUEST_TYPES.map((entry) => entry.id);
  assert.deepEqual(ids, [
    "existing-product", "part", "automotive", "woodworking", "sign", "fixture", "replacement", "other",
  ]);
  for (const entry of REQUEST_TYPES) assert.ok(entry.label.length > 3 && entry.blurb.length > 10);
});

test("a full pass over the wizard leaves nothing to complain about", () => {
  assert.deepEqual(validateAll(validForm()), []);
});

/* ===================================================================
 * Phase 57 — fields
 * ================================================================ */

test("description has a floor and the message says how far off it is", () => {
  assert.deepEqual(validateStep("details", validForm({ description: "" }))[0].field, "description");
  const short = validateStep("details", validForm({ description: "too short" }));
  assert.match(short[0].message, /more character/);
  assert.deepEqual(validateStep("details", validForm({ description: "x".repeat(20) })), []);
});

test("quantity is a whole number inside the route's own bounds", () => {
  for (const quantity of [0, -1, 1.5, MAX_QUANTITY + 1, Number.NaN]) {
    const problems = validateStep("logistics", validForm({ quantity }));
    assert.ok(problems.some((problem) => problem.field === "quantity"), `quantity ${quantity} must be refused`);
  }
  assert.deepEqual(validateStep("logistics", validForm({ quantity: MAX_QUANTITY })), []);
});

test("budget is optional, and refuses malformed or negative amounts", () => {
  assert.deepEqual(validateStep("logistics", validForm({ budget_mode: "none" })), []);
  assert.equal(describeBudget(validForm({ budget_mode: "none" })), "No budget set yet");

  for (const amount of ["-50", "abc", "1e9", "12.345", "", "  "]) {
    assert.equal(parseMoneyToCents(amount), null, `${amount} must not become money`);
  }
  assert.equal(parseMoneyToCents("250"), 25000);
  assert.equal(parseMoneyToCents("$1,200.50"), 120050);
  assert.equal(parseMoneyToCents(String(MAX_BUDGET_CENTS / 100 + 1)), null);

  const bad = validateStep("logistics", validForm({ budget_mode: "target", budget_min: "-5" }));
  assert.ok(bad.some((problem) => problem.field === "budget_min"));
});

test("a budget range must not run backwards", () => {
  const problems = validateStep(
    "logistics",
    validForm({ budget_mode: "range", budget_min: "600", budget_max: "250" })
  );
  assert.ok(problems.some((problem) => problem.field === "budget_max"));
  assert.equal(
    describeBudget(validForm({ budget_mode: "range", budget_min: "250", budget_max: "600" })),
    "$250.00 – $600.00"
  );
});

test("no deadline is a first-class answer and a past date is not", () => {
  assert.deepEqual(validateStep("logistics", validForm({ timing: "flexible" })), []);
  assert.equal(describeTiming(validForm({ timing: "flexible" })), "No deadline");
  assert.equal(describeTiming(validForm({ timing: "asap" })), "As soon as practical");

  const missing = validateStep("logistics", validForm({ timing: "by-date", target_date: "" }));
  assert.ok(missing.some((problem) => problem.field === "target_date"));
  const past = validateStep("logistics", validForm({ timing: "by-date", target_date: "2020-01-01" }));
  assert.match(past.find((problem) => problem.field === "target_date")!.message, /already passed/);
});

test("a requested date is described as a hope, never as a delivery date", () => {
  const described = describeTiming(validForm({ timing: "by-date", target_date: "2099-05-04" }));
  assert.match(described, /^Hoping for/);
  // And the field itself says so where the customer reads it.
  assert.match(steps, /not a delivery date until a quote confirms one/);
});

test("material and finish only demand a follow-up when 'other' is chosen", () => {
  assert.deepEqual(validateStep("details", validForm({ material: "aluminum" })), []);
  const problems = validateStep("details", validForm({ material: "other", finish: "other" }));
  assert.deepEqual(problems.map((problem) => problem.field).sort(), ["finish_other", "material_other"]);
});

test("dimensions can be declined outright", () => {
  assert.equal(describeDimensions(validForm({ dimensions_known: "help" })), "Needs help working them out");
  assert.deepEqual(validateStep("details", validForm({ dimensions_known: "help" })), []);
  const measured = describeDimensions(
    validForm({ dimensions: { ...emptyCustomRequest().dimensions, length: "18in", width: "9in" } })
  );
  assert.equal(measured, "L 18in · W 9in");
});

test("an external reference link is optional, and only ever http(s)", () => {
  assert.deepEqual(validateStep("files", validForm({ reference_url: "" })), []);
  for (const hostile of ["javascript:alert(1)", "data:text/html,<script>", "file:///etc/passwd"]) {
    const result = normalizeReferenceUrl(hostile);
    assert.ok("error" in result, `${hostile} must be refused`);
  }
  assert.deepEqual(normalizeReferenceUrl("example.com/thing"), { url: "https://example.com/thing" });
  assert.equal((normalizeReferenceUrl("https://a.example/x") as { url: string }).url, "https://a.example/x");
});

test("a project without a name still gets a useful one", () => {
  assert.equal(fallbackTitle(validForm({ request_type: "woodworking" })), "A woodworking piece request");
  assert.ok(fallbackTitle(emptyCustomRequest()).length > 0);
});

/* ===================================================================
 * Phase 58 — files
 * ================================================================ */

test("the form's size limit is the bucket's own, not a larger invented one", () => {
  // `order-assets` is created with file_size_limit 20971520. A form that
  // promises more is a form that fails after the customer chose the file.
  assert.match(bucket, /'order-assets'[^)]*20971520/);
  assert.equal(MAX_FILE_BYTES, 20971520);
  assert.doesNotMatch(stripComments(steps) + stripComments(filesUi), /50 MB/);
});

test("supported reference files are accepted and everything else is not", () => {
  for (const name of ["part.stl", "drawing.dxf", "assembly.step", "notes.pdf", "photo.jpg", "bundle.zip"]) {
    assert.equal(fileProblem({ name, size: 1024 }), "", `${name} should be accepted`);
  }
  for (const name of ["payload.html", "run.exe", "macro.js", "sheet.xlsx", "noextension"]) {
    assert.match(fileProblem({ name, size: 1024 }), /not a file type/, `${name} should be refused`);
  }
});

test("an oversize or empty file is refused with a fixable message", () => {
  assert.match(fileProblem({ name: "big.stl", size: MAX_FILE_BYTES + 1 }), /larger than 20 MB/);
  assert.match(fileProblem({ name: "empty.pdf", size: 0 }), /empty/);
});

test("file kinds are recognised so the UI can label them", () => {
  assert.equal(fileKind("a.step"), "cad");
  assert.equal(fileKind("a.PNG"), "image");
  assert.equal(fileKind("a.pdf"), "pdf");
  assert.equal(fileKind("a.svg"), "vector");
  assert.equal(fileKind("a.zip"), "archive");
});

test("only genuinely inline-safe types keep their content type", () => {
  // An SVG stored as image/svg+xml is a script KeyMoura hosts and staff click.
  assert.equal(storageContentType({ type: "image/svg+xml", name: "a.svg" }), "application/octet-stream");
  assert.equal(storageContentType({ type: "text/html", name: "a.html" }), "application/octet-stream");
  assert.equal(storageContentType({ type: "image/png", name: "a.png" }), "image/png");
  assert.equal(storageContentType({ type: "application/pdf", name: "a.pdf" }), "application/pdf");
});

test("storage object names cannot carry path or shell characters", () => {
  assert.equal(safeStorageName("../../etc/passwd"), ".._.._etc_passwd");
  assert.equal(safeStorageName("my drawing (v2).pdf"), "my_drawing__v2_.pdf");
});

test("files can be removed, retried, captioned and counted in the UI", () => {
  assert.match(filesUi, /aria-label=\{`Remove \$\{entry\.file\.name\}`\}/);
  assert.match(filesUi, /It will be tried again when you resubmit/);
  assert.match(filesUi, /Add a note about this file/);
  assert.match(filesUi, /is already attached/);
  assert.ok(MAX_REQUEST_FILES === 10);
});

test("drag, drop and paste are additions to a real file input, not replacements", () => {
  assert.match(filesUi, /type="file"/);
  assert.match(filesUi, /className="sr-only"/);
  assert.match(filesUi, /htmlFor=\{inputId\}/);
  assert.match(filesUi, /onDrop=/);
  assert.match(filesUi, /addEventListener\("paste"/);
  // `display:none` would take the input out of the tab order entirely.
  assert.doesNotMatch(stripComments(filesUi), /type="file"[\s\S]{0,200}hidden/);
});

test("staff can open every file on a custom request, not just single-file options", () => {
  // The bug: the route writes `kind: "files"` with an array, the renderer only
  // understood `kind: "file"` with a string, so custom-request attachments
  // rendered as plain grey text with nothing to click.
  assert.match(specs, /option\?\.kind === "files"/);
  assert.match(specs, /createSignedUrl/);
  // Rows written before this pass have no `items`, so names come from the
  // joined display value instead — old requests become downloadable too.
  assert.match(specs, /display_value === "string" \? option\.display_value\.split/);
});

test("a reference link opens as a link, and cannot reach back into the staff tab", () => {
  assert.match(specs, /rel="noopener noreferrer nofollow ugc"/);
});

/* ===================================================================
 * Phase 59 — security
 * ================================================================ */

test("ownership is customer_id and a storage prefix, never an email", () => {
  assert.match(route, /customer_id: user\?\.id \?\? null/);
  assert.match(route, /path\.startsWith\(`\$\{user\.id\}\/`\)/);
  // A guest is identified by a hashed token, and the email is only a reply
  // address — matching one must never be a way to read somebody's order.
  assert.match(route, /guest_token_hash: guestToken \? hashGuestOrderToken\(guestToken\) : null/);
  assert.doesNotMatch(stripComments(route), /eq\("guest_email"[^)]*\)\s*\.maybeSingle\(\)\s*;?\s*return/);
});

test("guests cannot attach files, and are told rather than having them dropped", () => {
  assert.match(route, /if \(!user\) \{[\s\S]{0,220}Files can be attached once you have an account/);
});

test("guest requests keep their setting, rate limit and Turnstile check", () => {
  assert.match(route, /settings\.guest\.allowRequests/);
  assert.match(route, /consumeRateLimit\(RATE_LIMITS\.guestRequest/);
  assert.match(route, /verifyTurnstile\(body\.turnstile_token/);
});

test("the server re-runs the shared validation on its own reading of the body", () => {
  assert.match(route, /const form = readForm\(body\)/);
  assert.match(route, /validateAll\(form\)/);
  // Not a spread of the body: an unexpected key must not ride into the order.
  assert.doesNotMatch(stripComments(route), /\.\.\.\(body as/);
  assert.doesNotMatch(stripComments(route), /specifications: body/);
});

test("file extension and declared size are decided by the server too", () => {
  assert.match(route, /ACCEPTED_FILE_EXTENSIONS as readonly string\[\]\)\.includes\(fileExtension\(name\)\)/);
  assert.match(route, /size > MAX_FILE_BYTES/);
});

test("no internal field is accepted from, or returned to, the customer", () => {
  const body = stripComments(route);
  for (const field of ["staff_notes", "agreed_price_cents", "amount_paid_cents", "payment_status", "initiated_by_staff"]) {
    assert.doesNotMatch(body, new RegExp(field), `${field} must not appear in the request route`);
  }
  // The success payload is an id and a destination, nothing else.
  assert.match(route, /\{ id: order\.id, href: guestToken \? `\/orders\/guest\/\$\{order\.id\}` : `\/orders\/\$\{order\.id\}\/confirmed` \}/);
});

/* ===================================================================
 * Submission, drafts, and the data model
 * ================================================================ */

test("a duplicate submit returns the first order instead of making a second", () => {
  assert.match(route, /checkout_token/);
  assert.match(route, /duplicate: true/);
  // 23505 is the unique index on (customer_id, checkout_token).
  assert.match(route, /error\?\.code === "23505"/);
  // The wizard must not mint a fresh token on retry, or the guard never fires.
  assert.match(wizard, /submitToken\.current \|\|= |if \(!submitToken\.current\) submitToken\.current = crypto\.randomUUID\(\)/);
});

test("a failed submit keeps the customer's work and cleans up what it uploaded", () => {
  assert.match(wizard, /storage\s*\n?\s*\.from\("order-assets"\)\s*\n?\s*\.remove/);
  assert.match(wizard, /Nothing was sent — try again in a moment/);
  assert.match(wizard, /Your request is still here — try again/);
  // No reset of the form or the step on failure.
  assert.doesNotMatch(stripComments(wizard), /setForm\(emptyCustomRequest\(\)\)/);
});

test("submission routes to wherever the server says the request is readable", () => {
  assert.match(wizard, /router\.push\(result\.href \?\? `\/orders\/\$\{result\.id\}\/confirmed`\)/);
  assert.match(route, /href: guestToken \? `\/orders\/guest\//);
});

test("the submit control cannot be pressed twice and never fakes success", () => {
  assert.match(wizard, /disabled=\{busy \|\| !identityKnown\}/);
  assert.match(wizard, /busy \? "Sending…" : "Submit project request"/);
  assert.match(wizard, /if \(busy\) return;/);
});

test("the CTA is a request, not a purchase", () => {
  assert.match(wizard, /Submit project request/);
  const visible = stripComments(wizard);
  assert.doesNotMatch(visible, /Buy now/);
  assert.doesNotMatch(visible, /Place order/);
});

test("drafts reuse the existing table and no new one is introduced", () => {
  assert.match(wizard, /order_request_drafts/);
  assert.match(wizard, /Draft saved/);
  // Signed out, the draft stays in the browser and drops the contact details.
  assert.match(wizard, /delete safe\.guest_email;\s*\n\s*delete safe\.guest_name;/);
  assert.match(wizard, /sessionStorage/);
  // And it is written after the deletions, never before them.
  const save = wizard.slice(wizard.indexOf("const safe: Partial<CustomRequestForm>"));
  assert.ok(
    save.indexOf("delete safe.guest_name") < save.indexOf("sessionStorage.setItem"),
    "contact details must be removed before the draft is written"
  );
});

test("leaving with unsaved work warns, and leaving after submitting does not", () => {
  assert.match(wizard, /if \(!worthSaving \|\| submitted\) return;[\s\S]{0,220}beforeunload/);
});

test("no second request model — a request is still an orders row", () => {
  assert.match(route, /\.from\("orders"\)\s*\n?\s*\.insert\(/);
  assert.match(route, /status: "requested"/);
  assert.match(route, /order_kind: "custom_request"/);
  const all = domain + wizard + steps + page;
  for (const invented of ["custom_projects", "project_requests", "order_requests\\b"]) {
    assert.doesNotMatch(stripComments(all), new RegExp(invented), `${invented} would be a duplicate model`);
  }
});

test("delivery intent is recorded even though the column has no word for it", () => {
  assert.equal(fulfillmentMethodFor("undecided"), "shipping");
  assert.equal(fulfillmentMethodFor("pickup"), "pickup");
  assert.equal(fulfillmentMethodFor("shipping"), "shipping");
  // The customer's real answer goes where staff read it.
  assert.match(route, /delivery: \{[\s\S]{0,160}Delivery preference/);
});

test("a full shipping address is no longer demanded at inquiry stage", () => {
  const body = stripComments(steps);
  for (const field of ["Street address", "address-level2", "address-level1"]) {
    assert.doesNotMatch(body, new RegExp(field), `${field} must not be collected on an inquiry`);
  }
  assert.match(body, /postal-code/);
  assert.match(body, /confirm the full address before anything is sent/);
});

/* ===================================================================
 * Phase 45 — staff handoff
 * ================================================================ */

test("every meaningful answer reaches the order staff open", () => {
  for (const key of [
    "project_type", "material", "finish", "dimensions", "quantity_intent",
    "timing", "delivery", "budget", "context", "reference_link", "files", "based_on",
  ]) {
    assert.match(route, new RegExp(`${key}:|specifications\\.${key}`), `${key} must reach staff`);
  }
  // Title, description, quantity and the customer are columns, not spec keys.
  assert.match(route, /product_name: \(clean\(body\.title, 120\)/);
  assert.match(route, /customer_notes: description/);
  assert.match(route, /quantity,/);
});

test("the older product-page payload still creates the same kind of request", () => {
  // Product Customization 2.0 posts `project_type`, `budget` and
  // `fulfillment_method`. Rewriting that form was not this pass's job.
  assert.match(route, /legacyProjectType/);
  assert.match(route, /body\.fulfillment_method/);
  assert.match(route, /clean\(body\.budget, 200\)/);
  assert.match(route, /selected_options/);
});

/* ===================================================================
 * Phase 49/50 — accessibility
 * ================================================================ */

test("choices are real radios in a fieldset, not clickable divs", () => {
  assert.match(controls, /<fieldset/);
  assert.match(controls, /<legend/);
  assert.match(controls, /type="radio"/);
  assert.doesNotMatch(stripComments(controls), /<div[^>]*role="radio"/);
});

test("errors are associated with their field, not just coloured", () => {
  assert.match(controls, /aria-invalid/);
  assert.match(controls, /aria-describedby/);
  assert.match(controls, /role="alert"/);
  assert.match(controls, /\$\{htmlFor\}-error/);
});

test("moving to a step moves focus to its heading", () => {
  assert.match(wizard, /headingRef\.current\?\.focus\(\)/);
  assert.match(wizard, /ref=\{headingRef\} tabIndex=\{-1\}/);
});

test("progress is announced, and answered steps stay reachable", () => {
  assert.match(wizard, /aria-current=\{isCurrent \? "step" : undefined\}/);
  assert.match(wizard, /answered — go back to it/);
  // Unlocking against the current step is what made Edit a trap.
  assert.match(wizard, /const visited = position <= furthest/);
  assert.match(wizard, /Back to review/);
});

/* ===================================================================
 * Phase 27/29 — commitment and legal
 * ================================================================ */

test("the review says what submitting does and does not do", () => {
  for (const phrase of ["charge you anything", "start any work", "accept a price or a date"]) {
    assert.match(wizard, new RegExp(phrase));
  }
  for (const phrase of ["send your project to", "lead to a written", "quote if we can make it"]) {
    assert.match(wizard, new RegExp(phrase));
  }
});

test("the inquiry stays an inquiry — no clickwrap is added here", () => {
  assert.match(wizard, /href="\/privacy"/);
  assert.match(wizard, /href="\/terms"/);
  // Storefront 4.0 puts the agreement at quote approval. A checkbox here would
  // ask a customer to accept terms for asking a question.
  const body = stripComments(wizard);
  assert.doesNotMatch(body, /I agree to the/);
  assert.doesNotMatch(body, /type="checkbox"[\s\S]{0,120}[Tt]erms/);
  assert.match(wizard, /Nothing is agreed until you approve a quote/);
});

/* ===================================================================
 * Entry points
 * ================================================================ */

test("a product page can hand its context to the wizard", () => {
  assert.match(page, /query\.product/);
  // Resolved against the published list, not trusted from the URL.
  assert.match(page, /products\.find\(\(entry\) => entry\.slug === requested\)/);
  assert.match(page, /is_published/);
  assert.match(wizard, /base\.request_type = "existing-product"/);
});

test("the page loads the catalog on the server so the picker can exist", () => {
  assert.doesNotMatch(page.split("\n")[0], /use client/);
  assert.match(page, /loadRequestableProducts/);
  assert.match(page, /archived_at/);
});

/* ===================================================================
 * Phase 60 — navbar follow-up
 * ================================================================ */

const css = read("src/app/globals.css");
const navMenu = read("src/components/nav/NavMenu.tsx");
const productsMenu = read("src/components/nav/ProductsMenu.tsx");
const hoverIntent = read("src/components/nav/useNavHoverIntent.ts");
const header = read("src/components/SiteHeader.tsx");

const underlineRule =
  css.match(/\.site-header-shell \.site-nav-primary-link::after \{[\s\S]*?\}/)?.[0] ?? "";

test("the underline is thicker than it was", () => {
  assert.match(underlineRule, /height: 3px/);
  assert.doesNotMatch(underlineRule, /height: 2px/);
});

test("the underline is a centred proportion of the control, not a fixed inset", () => {
  // A fixed inset made the rule ~80% of the control under `About` and ~91%
  // under `Custom Projects`; a percentage inset makes it one ratio everywhere.
  assert.match(underlineRule, /inset-inline: 14%/);
  assert.doesNotMatch(underlineRule, /inset-inline: 0\.375rem/);
  assert.match(underlineRule, /transform-origin: center/);
});

test("active and hover draw the same shape, differing only in weight", () => {
  const hover = css.match(/\.site-nav-primary-link:hover::after,[\s\S]*?\}/)?.[0] ?? "";
  const active = css.match(/\.site-nav-primary-link\.is-active::after \{[\s\S]*?\}/)?.[0] ?? "";
  assert.match(hover, /transform: scaleX\(1\)/);
  assert.match(active, /transform: scaleX\(1\)/);
  // Only opacity separates them, so nothing moves between states.
  assert.doesNotMatch(hover, /height:|inset-inline:/);
  assert.doesNotMatch(active, /height:|inset-inline:/);
});

test("the underline is reduced-motion safe", () => {
  assert.match(
    css,
    /@media \(prefers-reduced-motion: reduce\) \{\s*\.site-header-shell \.site-nav-primary-link::after \{ transition: none; \}/
  );
});

test("More and Products share one hover-intent implementation", () => {
  assert.match(hoverIntent, /NAV_HOVER_OPEN_DELAY_MS = 110/);
  assert.match(hoverIntent, /NAV_HOVER_CLOSE_DELAY_MS = 220/);
  for (const consumer of [navMenu, productsMenu]) {
    assert.match(consumer, /useNavHoverIntent/);
  }
  // No second hover system left behind in ProductsMenu.
  assert.doesNotMatch(stripComments(productsMenu), /OPEN_DELAY_MS = |setTimeout\(/);
  assert.match(header, /hoverIntent\s*\n?\s*(\/\*|panelClassName|trigger|>)/);

  /*
   * Both consumers spread the same `hoverProps` onto the wrapper that holds the
   * trigger *and* the panel. That shared wrapper is the whole bridge: crossing
   * the gap fires leave and only schedules a close, and entering the panel
   * re-enters the wrapper's subtree and cancels it. Putting the handlers on the
   * trigger alone would shut the menu the moment the pointer set off for it.
   */
  for (const consumer of [navMenu, productsMenu]) {
    assert.match(consumer, /<div ref=\{wrapRef\}[^>]*\{\.\.\.hoverProps\}>/);
  }
  // Pointer events, not mouse events: the gate needs `pointerType`, and only
  // the pointer family carries it.
  assert.match(hoverIntent, /onPointerEnter:/);
  assert.match(hoverIntent, /onPointerLeave:/);
  assert.doesNotMatch(stripComments(hoverIntent), /onMouseEnter|onMouseLeave/);
});

test("hover is opt-in, so the account and notification menus stay click-only", () => {
  assert.match(navMenu, /hoverIntent = false/);
  const accountMenu = read("src/components/nav/AccountMenu.tsx");
  const bell = read("src/components/nav/NotificationBell.tsx");
  assert.doesNotMatch(stripComments(accountMenu), /hoverIntent/);
  assert.doesNotMatch(stripComments(bell), /hoverIntent/);
});

test("a pointer that cannot hover never opens a menu by hovering", () => {
  /*
   * ## This assertion used to pin the bug in place
   *
   * It required `(hover: hover) and (pointer: fine)`, and that media query is
   * what broke Products and More on real hardware: those queries describe the
   * device's *primary* input, so a Windows laptop with a touchscreen reports
   * `pointer: coarse` and `hover: none` even with a mouse plugged in and in use.
   * Both menus went click-only on an extremely ordinary machine, and this test
   * went green the whole time — because it was asserting the mechanism rather
   * than the behaviour, and the mechanism was the thing that was wrong.
   *
   * The gate is now the event's own `pointerType`, which is per-interaction and
   * needs no device taxonomy. The behavioural half of this lives in
   * `tests/nav-hover-intent.test.ts`, which drives the real state machine.
   */
  assert.match(hoverIntent, /export function pointerTypeHovers/);
  assert.match(hoverIntent, /return pointerType !== "touch";/);
  assert.match(hoverIntent, /if \(!enabled \|\| !pointerTypeHovers\(event\?\.pointerType\)\) return;/);

  // The primary-pointer queries must not come back. `any-hover` is no better:
  // both ask what is attached, when the question is what is happening now.
  const code = stripComments(hoverIntent);
  assert.doesNotMatch(code, /matchMedia/, "capability must come from the event, not a media query");
  assert.doesNotMatch(code, /pointer: fine|hover: hover|any-hover|any-pointer/);

  // Read at handler time, not at render time — an SSR branch would be a
  // hydration mismatch.
  assert.doesNotMatch(code, /useState\(\(\) => pointer/);
});

test("a click or key press outranks a hover timer already in flight", () => {
  assert.match(navMenu, /cancelHover\(\);\s*\n\s*setOpen\(\(value\) => !value\)/);
  assert.match(navMenu, /cancelHover\(\);\s*\n\s*setOpen\(true\)/);
  assert.match(productsMenu, /clearTimer\(\);\s*\n\s*setOpen\(\(value\) => !value\)/);
});

test("Escape and keyboard navigation survive the change", () => {
  assert.match(navMenu, /event\.key === "Escape"/);
  assert.match(navMenu, /close\(true\)/);
  assert.match(navMenu, /ArrowDown/);
  assert.match(navMenu, /triggerRef\.current\?\.focus\(\)/);
});

test("mobile still reaches More by tap, through the drawer and the trigger", () => {
  const drawer = read("src/components/nav/MobileNavDrawer.tsx");
  assert.match(drawer, /secondaryNav/);
  assert.match(navMenu, /onClick=\{\(\) => \{/);
});
