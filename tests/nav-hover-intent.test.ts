import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  NAV_HOVER_CLOSE_DELAY_MS,
  NAV_HOVER_OPEN_DELAY_MS,
  pointerTypeHovers,
} from "../src/components/nav/useNavHoverIntent.ts";

/**
 * The navbar dropdown hover-intent state machine, driven rather than read.
 *
 * ## Why this file exists
 *
 * Products and More both stopped opening on hover, and the whole test suite
 * stayed green. Every existing assertion was a source-text match — that the
 * hook exports the delays, that both menus import it, that the gate is a
 * particular media query — and each of those was true while the feature did not
 * work. The one that hurt actively *required* the broken mechanism:
 * `(hover: hover) and (pointer: fine)`.
 *
 * Those queries describe a device's **primary** input. On a Windows laptop with
 * a touchscreen the primary input is the touchscreen, so Chrome answers
 * `pointer: coarse` / `hover: none` with a mouse plugged in and in use, and the
 * gate refused a real mouse. Products had no gate at all before the two menus
 * were unified; unifying them is what introduced it.
 *
 * So this file tests the *behaviour*: a reimplementation of the hook's timer
 * logic, exercised through the same sequences a pointer produces. It is the
 * transitions that matter — open on intent, close on leave, cancel on re-entry,
 * ignore touch — and those are what regressed.
 *
 * ## What it deliberately does not claim
 *
 * It does not prove a real mouse opens the menu in a browser. It cannot: the
 * automation pane reports `(hover: hover)`, `(pointer: fine)`, `(any-hover)`
 * and `(any-pointer: fine)` all false, so no media-query-based check is
 * testable there either. What *was* driven in a real browser is the state
 * machine, using `pointerover` / `pointerout` with a `pointerType` — the events
 * React actually delegates — and both menus opened, bridged, closed and
 * cancelled correctly. Real fine-pointer hover is left for manual QA.
 */

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/* ------------------------------------------------------------------------ */
/* The gate                                                                  */
/* ------------------------------------------------------------------------ */

test("only touch is refused, and an unknown pointer is allowed to hover", () => {
  // A mouse and a pen both hover; a stylus reports proximity.
  assert.equal(pointerTypeHovers("mouse"), true);
  assert.equal(pointerTypeHovers("pen"), true);
  assert.equal(pointerTypeHovers("touch"), false);

  /*
   * Absent or unrecognised types hover. Every non-touch input this has to serve
   * does, and the failure modes are not symmetrical: treating an unknown
   * pointer as touch is the bug that just shipped, while treating it as a mouse
   * costs at worst a menu that opened when it need not have.
   */
  assert.equal(pointerTypeHovers(undefined), true);
  assert.equal(pointerTypeHovers(""), true);
  assert.equal(pointerTypeHovers("unknown-future-device"), true);
});

test("the close delay is the longer one", () => {
  /*
   * Opening late costs a moment; closing early costs the interaction, because
   * the pointer is still crossing the gap towards the panel it is aiming for.
   */
  assert.ok(NAV_HOVER_CLOSE_DELAY_MS > NAV_HOVER_OPEN_DELAY_MS);
  assert.equal(NAV_HOVER_OPEN_DELAY_MS, 110);
  assert.equal(NAV_HOVER_CLOSE_DELAY_MS, 220);
});

/* ------------------------------------------------------------------------ */
/* The state machine                                                         */
/* ------------------------------------------------------------------------ */

/**
 * The hook's timer logic, with a clock this test drives.
 *
 * Mirrors `useNavHoverIntent`: one timer at a time, cancelled and replaced by
 * whatever happens next. `enabled` and the pointer gate are applied exactly as
 * the hook applies them, so a sequence here is a sequence there.
 */
function makeMenu({ enabled = true }: { enabled?: boolean } = {}) {
  let open = false;
  let pending: { at: number; next: boolean } | null = null;
  let now = 0;

  const schedule = (next: boolean, delay: number) => {
    pending = { at: now + delay, next };
  };

  return {
    get open() {
      return open;
    },
    get hasPending() {
      return pending !== null;
    },
    pointerEnter(pointerType?: string) {
      if (!enabled || !pointerTypeHovers(pointerType)) return;
      schedule(true, NAV_HOVER_OPEN_DELAY_MS);
    },
    pointerLeave(pointerType?: string) {
      if (!enabled || !pointerTypeHovers(pointerType)) return;
      schedule(false, NAV_HOVER_CLOSE_DELAY_MS);
    },
    /** A click or key press decides immediately and outranks any pending timer. */
    activate(next?: boolean) {
      pending = null;
      open = next ?? !open;
    },
    escape() {
      pending = null;
      open = false;
    },
    advance(ms: number) {
      now += ms;
      if (pending && pending.at <= now) {
        open = pending.next;
        pending = null;
      }
    },
  };
}

test("hovering opens after the intent delay, not immediately", () => {
  const menu = makeMenu();
  menu.pointerEnter("mouse");
  assert.equal(menu.open, false, "a passing cursor must not flash the panel open");
  menu.advance(NAV_HOVER_OPEN_DELAY_MS - 1);
  assert.equal(menu.open, false);
  menu.advance(1);
  assert.equal(menu.open, true);
});

test("a brief pass across the trigger never opens it", () => {
  const menu = makeMenu();
  menu.pointerEnter("mouse");
  menu.advance(40);
  menu.pointerLeave("mouse");
  // The leave replaces the pending open, so the open never lands.
  menu.advance(NAV_HOVER_CLOSE_DELAY_MS + 50);
  assert.equal(menu.open, false, "crossing the trigger must not flash the menu");
});

test("leaving closes after a delay, and re-entering cancels it", () => {
  const menu = makeMenu();
  menu.pointerEnter("mouse");
  menu.advance(NAV_HOVER_OPEN_DELAY_MS);
  assert.equal(menu.open, true);

  menu.pointerLeave("mouse");
  menu.advance(NAV_HOVER_CLOSE_DELAY_MS - 1);
  assert.equal(menu.open, true, "the panel must survive the gap between trigger and menu");

  // Entering the panel re-enters the wrapper's subtree, which is the bridge.
  menu.pointerEnter("mouse");
  menu.advance(500);
  assert.equal(menu.open, true, "re-entry must cancel the pending close");
});

test("leaving the whole region does eventually close it", () => {
  const menu = makeMenu();
  menu.pointerEnter("mouse");
  menu.advance(NAV_HOVER_OPEN_DELAY_MS);
  menu.pointerLeave("mouse");
  menu.advance(NAV_HOVER_CLOSE_DELAY_MS);
  assert.equal(menu.open, false);
  assert.equal(menu.hasPending, false, "no timer may be left running");
});

test("touch never schedules anything, so tap keeps working", () => {
  const menu = makeMenu();
  /*
   * A tap synthesises enter before click. On a control whose trigger is also its
   * toggle — which More is — an ungated enter reads as open-then-close and the
   * menu appears broken on a phone.
   */
  menu.pointerEnter("touch");
  assert.equal(menu.hasPending, false);
  menu.advance(1000);
  assert.equal(menu.open, false);

  // The click still decides, untouched by any of this.
  menu.activate();
  assert.equal(menu.open, true);
  menu.pointerLeave("touch");
  menu.advance(1000);
  assert.equal(menu.open, true, "a touch leave must not close a tapped-open menu");
});

test("a hybrid device gets both behaviours from the same control", () => {
  // The case the media query got wrong: one machine, two inputs.
  const menu = makeMenu();
  menu.pointerEnter("touch");
  menu.advance(1000);
  assert.equal(menu.open, false, "the finger does not hover");

  menu.pointerEnter("mouse");
  menu.advance(NAV_HOVER_OPEN_DELAY_MS);
  assert.equal(menu.open, true, "the mouse on the same machine does");
});

test("a click or key press outranks a hover timer already in flight", () => {
  const menu = makeMenu();
  menu.pointerEnter("mouse");
  menu.activate(false);
  menu.advance(1000);
  assert.equal(menu.open, false, "a pending open must not undo a deliberate close");

  menu.pointerLeave("mouse");
  menu.activate(true);
  menu.advance(1000);
  assert.equal(menu.open, true, "a pending close must not undo a deliberate open");
});

test("Escape closes and clears, whatever the pointer had scheduled", () => {
  const menu = makeMenu();
  menu.pointerEnter("mouse");
  menu.advance(NAV_HOVER_OPEN_DELAY_MS);
  menu.pointerEnter("mouse");
  menu.escape();
  assert.equal(menu.open, false);
  menu.advance(1000);
  assert.equal(menu.open, false, "a timer must not reopen a menu Escape closed");
});

test("a disabled control is inert to the pointer but not to a click", () => {
  // Products passes `enabled: hasCategories` — nothing to open, nothing to schedule.
  const menu = makeMenu({ enabled: false });
  menu.pointerEnter("mouse");
  menu.advance(1000);
  assert.equal(menu.open, false);
  menu.activate();
  assert.equal(menu.open, true);
});

/* ------------------------------------------------------------------------ */
/* Wiring                                                                    */
/* ------------------------------------------------------------------------ */

test("both menus take the behaviour from the one hook, on the shared wrapper", () => {
  const hook = read("src/components/nav/useNavHoverIntent.ts");
  const navMenu = read("src/components/nav/NavMenu.tsx");
  const productsMenu = read("src/components/nav/ProductsMenu.tsx");

  for (const consumer of [navMenu, productsMenu]) {
    assert.match(consumer, /useNavHoverIntent/);
    // On the wrapper holding trigger *and* panel — that is the bridge.
    assert.match(consumer, /<div ref=\{wrapRef\}[^>]*\{\.\.\.hoverProps\}>/);
    // And no private timer left beside the shared one.
    assert.doesNotMatch(stripComments(consumer), /setTimeout\(/);
  }

  // More opts in; the account menu and the notification bell stay click-only,
  // because a panel of account links must not unfurl at a passing cursor.
  assert.match(read("src/components/SiteHeader.tsx"), /hoverIntent/);
  assert.match(navMenu, /hoverIntent = false/);
  for (const file of ["AccountMenu", "NotificationBell"]) {
    assert.doesNotMatch(stripComments(read(`src/components/nav/${file}.tsx`)), /hoverIntent/);
  }

  // Pointer events, because only they carry the type the gate reads.
  assert.match(hook, /onPointerEnter/);
  assert.match(hook, /onPointerLeave/);
  assert.doesNotMatch(stripComments(hook), /onMouseEnter|onMouseLeave/);
});

test("the Products label still navigates and the disclosure is still separate", () => {
  /*
   * The control has two jobs and they must not collapse into one. Hover reveals
   * the categories; clicking the word Products goes to the catalog.
   */
  const productsMenu = read("src/components/nav/ProductsMenu.tsx");
  assert.match(productsMenu, /href="\/catalog"/);
  assert.match(productsMenu, /className="products-menu-link"/);
  // The disclosure names its own state, so it is not a fixed string.
  assert.match(productsMenu, /aria-label=\{open \? "Hide product categories" : "Show product categories"\}/);
  assert.match(productsMenu, /aria-haspopup/);
  // The trigger is not a single button wrapping the link.
  assert.doesNotMatch(stripComments(productsMenu), /<button[^>]*>\s*\{?\s*<Link/);
});
