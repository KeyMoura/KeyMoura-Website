import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * The review step must never send the request by itself.
 *
 * ## The defect this file exists for
 *
 * The wizard's primary action was one JSX slot holding a ternary — a
 * `type="button"` Continue on steps 1–4, a `type="submit"` Submit on the review.
 * Two `<button>`s in the same position with no `key` are the *same element* to
 * React, so it kept the live DOM node and patched the attribute in place:
 * `type="button"` became `type="submit"` on the node the customer had their
 * finger on.
 *
 * React flushes a click synchronously, so that patch landed *during* the click's
 * dispatch — and a button's activation behaviour is resolved from its `type`
 * **after** the listeners have run. By the time the browser asked what the click
 * did, it was looking at a submit button. Pressing Continue on step 4 therefore
 * pressed Submit on step 5, and the request left about two seconds later (the
 * `getUser` and `getSession` round trips) with the customer still reading the
 * summary.
 *
 * Driven in a real browser against the unfixed code, one trusted click on
 * Continue produced a trusted `submit` event whose `submitter` was that same
 * morphed node, and `POST /api/orders/custom` fired 2,171 ms later with no
 * further input.
 *
 * ## Why these assertions are structural
 *
 * Not for want of a DOM. The bug *is* the browser resolving activation
 * behaviour after listeners run, and jsdom does not implement that ordering —
 * a jsdom test of "enter review, advance timers, assert no call" passes on the
 * broken code as readily as on the fixed code. It would have caught nothing
 * here while reading like proof, which is worse than no test.
 *
 * So the properties pinned below are the ones that actually made it
 * unreachable, each of which a refactor can plausibly undo:
 *
 *   - there is no submit control in the form for a stray activation to become;
 *   - the form refuses submission unconditionally;
 *   - the two buttons carry distinct keys, so no node is shared to morph;
 *   - submission is called from the Submit button's own `onClick` and nowhere
 *     else — no effect, no timer, no step-change side effect;
 *   - the in-flight door is a ref, so two clicks in one frame cannot both pass;
 *   - and a failure leaves the customer where they are, with their answers.
 *
 * The behavioural half — four seconds parked on Review with zero calls, three
 * clicks in one frame producing exactly one, a 503 leaving the form intact —
 * was verified in a browser against the fixed build.
 */

/**
 * Line endings are normalised on the way in. The working tree is CRLF, and an
 * extraction anchored on "\n  }\n" silently matches nothing there — which does
 * not fail, it just quietly widens the slice to the rest of the file and starts
 * asserting against code that is not the function under test.
 */
const read = (path: string) =>
  readFileSync(new URL(`../${path}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");

/**
 * Comments have to go before anything is asserted *absent*.
 *
 * This codebase explains what it removed in the comment explaining the removal
 * — the block above says `type="submit"` four times — so a `doesNotMatch`
 * against the raw file would fail on the prose describing the fix.
 *
 * `//` is only stripped when it is not preceded by a colon, so the `https://`
 * in a placeholder URL survives.
 */
const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(?<!:)\/\/.*$/gm, "");

const wizardRaw = read("src/components/orders/CustomRequestWizard.tsx");
const wizard = stripComments(wizardRaw);
const steps = stripComments(read("src/components/orders/CustomRequestSteps.tsx"));
const files = stripComments(read("src/components/orders/RequestFiles.tsx"));
const controls = stripComments(read("src/components/orders/RequestControls.tsx"));
const quantity = stripComments(read("src/components/commerce/QuantityField.tsx"));
const css = read("src/app/globals.css");

/**
 * The body of the wizard's `submit`, from its signature to the closing brace.
 *
 * Deliberately tolerant of the signature and never asserted at module scope: a
 * throw out here aborts the whole file, which turns "eight invariants broke"
 * into one unreadable load error. Each test says what it needed instead.
 */
const submitBody = (() => {
  const match = wizard.match(/async function submit\([^)]*\)[\s\S]*?\n  \}\n/);
  return match ? match[0] : "";
})();

/* ------------------------------------------------------------------ *
 * Nothing in the form can submit it
 * ------------------------------------------------------------------ */

test("the wizard contains no submit control at all", () => {
  // Every button the wizard renders, across all five steps and the uploader,
  // states `type` explicitly and states it as "button". A bare <button> inside
  // a form defaults to submit, which is the other half of this family of bug.
  for (const [name, source] of Object.entries({ wizard, steps, files, controls, quantity })) {
    assert.doesNotMatch(source, /type="submit"/, `${name} must not render a submit control`);
    assert.doesNotMatch(source, /<button(?![^>]*\btype=)[^>]*>/, `${name} has a <button> with no explicit type`);
  }
});

test("the form refuses submission unconditionally", () => {
  // Not routed to the handler, refused: the only way in is the button's onClick.
  assert.match(
    wizard,
    /<form\s+onSubmit=\{\(event: FormEvent\) => event\.preventDefault\(\)\}/,
    "the form's onSubmit must be a preventDefault-only blocker"
  );
  // And it must not be wired to the real submission by any spelling.
  assert.doesNotMatch(wizard, /onSubmit=\{submit\}/);
  assert.doesNotMatch(wizard, /onSubmit=\{\(\) => submit/);
  assert.doesNotMatch(wizard, /onSubmit=\{void submit/);
});

test("continue and submit cannot be reconciled into one DOM node", () => {
  // The keys are the fix for the morph. Without them React keeps the node and
  // patches `type`, which is precisely how a Continue click became a submit.
  assert.match(wizard, /key="continue"/, "the Continue button needs a distinct key");
  assert.match(wizard, /key="submit"/, "the Submit button needs a distinct key");
});

/* ------------------------------------------------------------------ *
 * Submission is a deliberate act
 * ------------------------------------------------------------------ */

test("submission is invoked only from the submit button's own click", () => {
  assert.match(
    wizard,
    /onClick=\{\(\) => void submit\(\)\}/,
    "Submit must call the submission directly from its click handler"
  );
  // Exactly one call site. A second one is a second way in.
  const callSites = wizard.match(/(?<!async function )\bsubmit\(\)/g) ?? [];
  assert.equal(callSites.length, 1, `submit() must have exactly one call site, found ${callSites.length}`);
});

test("no effect, timer, or step change can start a submission", () => {
  // Every useEffect body in the wizard, checked for a submission.
  const effects = wizardRaw.match(/useEffect\(\(\)\s*=>\s*\{[\s\S]*?\n  \}, \[[^\]]*\]\);/g) ?? [];
  assert.ok(effects.length > 0, "expected to find the wizard's effects");
  for (const effect of effects) {
    const body = stripComments(effect);
    assert.doesNotMatch(body, /\bsubmit\(/, "no effect may call submit");
    assert.doesNotMatch(body, /requestSubmit|\.submit\(\)/, "no effect may submit the form element");
  }
  // No effect is keyed on arriving at the review step, which is the shape the
  // brief specifically rules out.
  assert.doesNotMatch(wizard, /useEffect\([\s\S]{0,400}?isLast/);
  assert.doesNotMatch(wizard, /useEffect\([\s\S]{0,400}?step === "review"/);
  // The only timer in the file is the autosave debounce, and it saves a draft.
  const timers = wizard.match(/setTimeout\(([^;]*)\)/g) ?? [];
  for (const timer of timers) {
    assert.doesNotMatch(timer, /submit/, "no timer may call submit");
    assert.match(timer, /saveDraft/, `unexpected timer: ${timer}`);
  }
  // Nothing anywhere programmatically submits a form.
  assert.doesNotMatch(wizard, /requestSubmit\(/);
  assert.doesNotMatch(wizard, /formRef/);
});

/* ------------------------------------------------------------------ *
 * One click, one request
 * ------------------------------------------------------------------ */

test("a second click in the same frame cannot become a second request", () => {
  // A ref, not `busy`. Two clicks in one frame read the same stale state out of
  // the same closure, and `disabled` only lands on the render after the first.
  assert.match(wizard, /const inFlight = useRef\(false\)/);
  assert.match(submitBody, /if \(inFlight\.current\) return;\s*\n\s*inFlight\.current = true;/);

  // The guard has to close before the first await, or it is not a guard.
  const guardAt = submitBody.indexOf("inFlight.current = true");
  const firstAwait = submitBody.indexOf("await ");
  assert.notEqual(guardAt, -1);
  assert.notEqual(firstAwait, -1);
  assert.ok(guardAt < firstAwait, "the in-flight guard must close before the first await");

  // The server's own idempotency stays the backstop, not the only stop.
  assert.match(wizard, /checkout_token: submitToken\.current/);
});

test("every failure reopens the door, and success does not", () => {
  // `busy` and the ref are cleared together, so they cannot drift apart.
  assert.match(submitBody, /const abandon = \(\) => \{\s*\n\s*inFlight\.current = false;\s*\n\s*setBusy\(false\);/);
  // No bare setBusy(false) outside abandon: that would clear the spinner while
  // leaving the door shut, and the customer could never retry.
  const bareResets = submitBody.match(/setBusy\(false\)/g) ?? [];
  assert.equal(bareResets.length, 1, "setBusy(false) must live only inside abandon()");
  // Three ways this can fail after the door closes: a bad upload, an
  // unreachable server, and a refusal. All three reopen it.
  const abandonCalls = submitBody.match(/\n\s*abandon\(\);/g) ?? [];
  assert.equal(abandonCalls.length, 3, `every failure path must call abandon(), found ${abandonCalls.length}`);
  // The success path deliberately does not: there is a request on the other
  // side now, and the navigation away is what ends the interaction.
  const successTail = submitBody.slice(submitBody.indexOf("setSubmitted(true)"));
  assert.doesNotMatch(successTail, /abandon\(\)/);
});

test("a refused submission leaves the customer on review with their answers", () => {
  // Nothing on a failure path moves the step or the route, and nothing clears
  // the form. The banner and the field errors are the whole response.
  const failureTail = submitBody.slice(0, submitBody.indexOf("setSubmitted(true)"));
  assert.doesNotMatch(failureTail, /setForm\(/, "a failure must not clear what was typed");
  assert.doesNotMatch(failureTail, /emptyCustomRequest\(\)/);
  assert.doesNotMatch(failureTail, /setFiles\(\[\]\)/, "a failure must not drop the attachments");
  // The one router.push before success is the signed-out redirect, which is a
  // deliberate hand-off and happens before anything is sent.
  const pushes = failureTail.match(/router\.push\(/g) ?? [];
  assert.equal(pushes.length, 1);
  assert.match(failureTail, /router\.push\(`\/auth\/login\?next=/);
  // A failed request takes its uploads back down rather than orphaning them.
  assert.match(failureTail, /remove\(uploaded\.map\(\(item\) => item\.path\)\)/);
  // And the guard against leaving is only lifted once there is something to go
  // and look at.
  assert.match(submitBody, /setSubmitted\(true\);/);
});

test("going back from review is not a submission", () => {
  // Back, the step chips, and every Edit on the summary are plain buttons with
  // click handlers that only move the step.
  assert.match(wizard, /onClick=\{back\}/);
  assert.match(wizard, /onClick=\{\(\) => goTo\("review"\)\}/);
  assert.match(wizard, /onClick=\{\(\) => goTo\(section\.step\)\}/);
  const goTo = wizard.slice(wizard.indexOf("const goTo ="), wizard.indexOf("const next ="));
  assert.doesNotMatch(goTo, /submit/, "moving between steps must not touch submission");
});

/* ------------------------------------------------------------------ *
 * The step navigation, and the theme it is drawn in
 * ------------------------------------------------------------------ */

test("the current step is never the faded one", () => {
  // The current chip is `disabled` — there is nowhere to go by pressing the
  // step you are on — and the strip's blanket fade used to catch it, dimming
  // the one step that had to stand out.
  assert.doesNotMatch(css, /\.request-step-chip:disabled \{[^}]*opacity/);
  assert.match(css, /\.request-step-chip:disabled:not\(\.is-current\)/);
  assert.match(css, /\.request-step-chip\.is-current \{[^}]*opacity: 1/);
});

test("the three step states differ by more than a colour", () => {
  const current = css.slice(css.indexOf(".request-step-chip.is-current {"));
  const block = current.slice(0, current.indexOf("}"));
  assert.match(block, /font-weight: 700/, "the current step carries weight, not just hue");
  assert.match(css, /\.request-step-chip\.is-current::after/, "the current step carries a rail");
  assert.match(css, /\.request-step-chip:disabled:not\(\.is-current\) \{[^}]*border-style: dashed/);
  assert.match(css, /\.ui-step\.is-complete::before \{[^}]*content: "✓"/, "a completed step carries a tick");
});

test("a clipped step label is still readable with a pointer", () => {
  // Five columns leave ~110px for a label, so "Quantity & delivery" clips.
  // `truncate` is CSS-only, so assistive tech always had the whole string as
  // the button's accessible name; the `title` is the pointer half of that.
  // Asserted on the same element that does the clipping, so the two cannot
  // drift apart.
  assert.match(wizard, /<span className="truncate" title=\{entry\.label\}>/);
  // And the fix stays a tooltip rather than a wider chip — the row is five
  // equal columns from 640px up, and widening them is what overflows it.
  assert.match(css, /@media \(min-width: 640px\) \{ \.ui-stepper \{ grid-auto-columns: minmax\(0, 1fr\)/);
  assert.match(css, /\.ui-step \{[^}]*min-width: 0/);
});

test("the wizard states meaning, not hex", () => {
  // The status roles exist, and are not derived from the brand: an error must
  // not turn gold because a shop's colour did.
  for (const token of ["--danger:", "--danger-text:", "--success:", "--success-text:", "--warning-text:"]) {
    assert.match(css, new RegExp(token.replace(/-/g, "\\-")), `${token} must be defined as a role`);
  }
  // Nothing in the wizard's own stylesheet block names a colour directly.
  const start = css.indexOf(".request-layout {");
  const end = css.indexOf(".request-saved {");
  assert.ok(start !== -1 && end > start, "expected to find the request-* stylesheet block");
  const wizardCss = css.slice(start, end);
  const hexes = wizardCss.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
  assert.deepEqual(hexes, [], `the wizard's CSS must use roles, found ${hexes.join(", ")}`);
});

test("the step marker cannot resolve to gold on gold", () => {
  // `var(--km-primary-button-text)` with no fallback is invalid at
  // computed-value time when the property is absent, and `color` then inherits
  // — from `.is-current`, which is the brand colour. The number would have been
  // gold on a gold fill in every theme-scoped preview.
  assert.match(css, /\.ui-step\.is-current::before \{[^}]*color: var\(--km-primary-button-text, #09090b\)/);
});
