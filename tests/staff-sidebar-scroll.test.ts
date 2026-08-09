import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * The staff sidebar scrolls itself.
 *
 * ## The defect
 *
 * `.staff-nav` carried `lg:sticky lg:top-4` and nothing bounded its height. A
 * sticky element **taller than the viewport** is the pathological case for
 * `position: sticky`: it pins at `top` and the part below the viewport's bottom
 * edge cannot be reached at all, because sticky does not scroll and the page
 * scroll moves the content column instead. With "More tools" expanded that is
 * eleven destinations you can see the top of and never click. It also rode up
 * under the `sticky top-0` site header, which sits above it at `z-60`.
 *
 * ## The shape now
 *
 * The *rail* is the sticky box, sized to the space under the header, and it is a
 * flex column: the head is `flex: none`, the group list takes the rest and
 * scrolls. `min-height: 0` in both places is load-bearing — a flex item's
 * default `min-height: auto` refuses to shrink below its content, which would
 * push the overflow straight back out of the box.
 */

/** Line endings are normalised so the anchors below cannot depend on CRLF. */
const css = readFileSync("src/app/globals.css", "utf8").replace(/\r\n/g, "\n");
const navSource = readFileSync("src/components/staff/StaffNav.tsx", "utf8");
/**
 * Comments stripped: the assertions below are of the form "this must not
 * appear", and the prose in `StaffNav` names `lg:sticky` precisely in order to
 * say it is gone. Matching the explanation instead of the code would fail on
 * the documentation.
 */
const nav = navSource
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "")
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
const shell = readFileSync("src/components/staff/StaffShell.tsx", "utf8");

/** The block of desktop rules, so a rule outside the `lg` query cannot satisfy these. */
const desktop = (() => {
  const start = css.indexOf("  @media (min-width: 1024px) {\n    .staff-shell {");
  assert.ok(start > -1, "the staff shell's desktop block moved");
  return css.slice(start, css.indexOf("\n  /* Below lg the rail is not rendered", start));
})();

const rule = (selector: string) => {
  const at = desktop.indexOf(`${selector} {`);
  assert.ok(at > -1, `${selector} has no desktop rule`);
  return desktop.slice(at, desktop.indexOf("}", at));
};

test("the rail is the sticky box, not the nav inside it", () => {
  const rail = rule(".staff-shell-rail");
  assert.match(rail, /position: sticky/);
  // The nav must have given the job up, or there are two sticky contexts.
  assert.doesNotMatch(nav, /lg:sticky/);
  assert.doesNotMatch(nav, /lg:top-4/);
  assert.match(nav, /className=\{variant === "sidebar" \? "staff-nav" :/);
});

test("the rail clears the site header instead of hiding under it", () => {
  const rail = rule(".staff-shell-rail");
  assert.match(rail, /top: calc\(var\(--km-header-height\) \+ 1rem\)/);
  // And the header's height is reachable from outside the header, which is the
  // whole reason the variable moved to the root.
  assert.match(css, /:root \{ --km-header-height: 3\.75rem; \}/);
  assert.match(css, /\[data-navigation-density="comfortable"\] \{ --km-header-height: 4\.25rem; \}/);
  // The density override has to stay *after* the root rule — equal specificity,
  // so source order is what decides.
  assert.ok(
    css.indexOf('[data-navigation-density="comfortable"] { --km-header-height')
      > css.indexOf(":root { --km-header-height"),
    "the comfortable override must come after the root default or it never applies"
  );
});

test("the rail is exactly the viewport, so it cannot outgrow the screen", () => {
  const rail = rule(".staff-shell-rail");
  assert.match(rail, /height: calc\(100dvh - var\(--km-header-height\) - 2rem\)/);
  assert.match(rail, /display: flex/);
  assert.match(rail, /flex-direction: column/);
});

test("the head stays put and the groups scroll beneath it", () => {
  assert.match(rule(".staff-shell-rail .staff-nav-head"), /flex: none/);

  const groups = rule(".staff-shell-rail .staff-nav-groups");
  assert.match(groups, /flex: 1 1 auto/);
  assert.match(groups, /overflow-y: auto/);
  // Without this the flex item refuses to shrink below its content and the
  // overflow returns.
  assert.match(groups, /min-height: 0/);
});

test("the nav itself can shrink, or the group list never gets a bounded height", () => {
  const navRule = rule(".staff-shell-rail .staff-nav");
  assert.match(navRule, /min-height: 0/);
  assert.match(navRule, /max-height: 100%/);
  assert.match(navRule, /flex-direction: column/);
});

test("reaching the end of the menu does not then scroll the page", () => {
  assert.match(rule(".staff-shell-rail .staff-nav-groups"), /overscroll-behavior: contain/);
});

test("the collapsed rail's tooltips escape the scroll container", () => {
  /*
   * The subtle one, and the one the browser caught.
   *
   * A scroll container clips its *other* axis too, so making the group list
   * scroll silently amputated every tooltip in the 72px rail — the labels a
   * sighted keyboard user depends on to tell one icon from another. The first
   * fix, `overflow-x: clip` with `overflow-clip-margin: 14rem`, looked correct
   * and does nothing: Chrome treats `clip` as `hidden` once the box scrolls the
   * other way, and measurement showed the tooltip 82px outside the rail with no
   * pixel of it painted.
   *
   * The tooltip is now one `position: fixed` element rendered outside the
   * scroller, positioned from the hovered or focused link. These assertions pin
   * all three properties that make that work.
   */
  /*
   * Matched against the rule *body* only.
   *
   * The prose above the rule explains that `opacity: 0` and the `:hover`
   * descendant selector are gone — so a naive search of the stylesheet finds
   * both strings in the comment that says they were removed, and the assertion
   * passes or fails on the documentation instead of the CSS.
   */
  const tipRule = (() => {
    const at = css.indexOf(".staff-nav-tip {");
    assert.ok(at > -1, ".staff-nav-tip has no rule");
    return css.slice(at, css.indexOf("}", at));
  })();

  assert.match(tipRule, /position: fixed/);
  assert.ok(!/left: calc\(100% \+ 0\.5rem\)/.test(tipRule), "positioning against the link puts it back inside the scroller");
  assert.ok(!/opacity:\s*0/.test(tipRule), "a faded tooltip cannot be verified in a pane that never composites");
  assert.ok(!/\.staff-nav-link:hover \.staff-nav-tip/.test(css), "the tooltip is no longer a descendant of the link");

  // Rendered as a sibling of the group list, not inside it.
  const tail = nav.slice(nav.indexOf('<div className="staff-nav-groups">'));
  assert.match(tail, /staff-nav-groups[\s\S]*?<\/div>[\s\S]*?staff-nav-tip/);
  // Driven by React state on hover *and* focus — `title` is not raised on focus
  // by any browser, which is why this exists at all.
  assert.match(nav, /onMouseEnter=\{isCompact \? showTip\(item\.label\) : undefined\}/);
  assert.match(nav, /onFocus=\{isCompact \? showTip\(item\.label\) : undefined\}/);
  assert.match(nav, /onBlur=\{isCompact \? \(\) => setTip\(null\) : undefined\}/);
});

test("the rail's group list cannot grow a horizontal scrollbar", () => {
  const groups = rule(".staff-shell-rail .staff-nav-groups");
  assert.match(groups, /overflow-x: hidden/);
  assert.doesNotMatch(groups, /overflow-x: (auto|scroll)/);
});

test("both rail widths still work", () => {
  assert.match(desktop, /\.staff-shell \{\s*grid-template-columns: 280px minmax\(0, 1fr\);/);
  assert.match(desktop, /\.staff-shell\[data-compact="true"\] \{\s*grid-template-columns: 4\.5rem minmax\(0, 1fr\);/);
  // The scroll rules are keyed on the rail, not on a width, so they apply to
  // the collapsed 72px rail and the expanded 280px one alike.
  assert.ok(!/data-compact[^}]*overflow-y/.test(desktop));
});

test("the scrollbar is unobtrusive and does not sit on the labels", () => {
  const groups = rule(".staff-shell-rail .staff-nav-groups");
  assert.match(groups, /scrollbar-width: thin/);
  assert.match(groups, /padding-right/);
  assert.match(css, /\.staff-shell-rail \.staff-nav-groups::-webkit-scrollbar-track \{ background: transparent; \}/);
});

test("the main column scrolls on its own", () => {
  // It is a plain grid item in normal document flow: no height, no overflow, no
  // second scroll container. That is what "independently" means here — the page
  // scroll is the content's scroll, and the rail simply does not move with it.
  assert.match(shell, /<div className="min-w-0">/);
  assert.ok(!/staff-shell > \*|\.staff-shell .min-w-0[^}]*overflow/.test(css));
  assert.match(desktop, /minmax\(0, 1fr\)/);
});

test("nothing here can cause page-level horizontal overflow", () => {
  const groups = rule(".staff-shell-rail .staff-nav-groups");
  // The x axis is clipped, never scrollable — a nested horizontal scrollbar in
  // a 72px rail is unusable and would also widen the grid column.
  assert.doesNotMatch(groups, /overflow-x: auto|overflow-x: scroll/);
  // Long labels ellipsise rather than widening the track.
  assert.match(css, /\.staff-nav-link-label \{[^}]*text-overflow: ellipsis/);
});
