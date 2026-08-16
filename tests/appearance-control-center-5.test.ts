import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  APPEARANCE_CLUSTERS,
  APPEARANCE_SEARCH_INDEX,
  APPEARANCE_SECTIONS,
  appearanceSection,
  searchAppearance,
  searchMatchStrength,
  sectionForTask,
  tasksForSection,
} from "../src/theme/appearanceSections.ts";
import { APPEARANCE_SETTINGS } from "../src/theme/appearanceMap.ts";
import { APPEARANCE_TASKS } from "../src/theme/appearanceTasks.ts";
import {
  HERO_LEDE_MAX,
  HERO_TITLE_MAX,
  SECTION_TOGGLES,
  defaultHomepageConfig,
  homepageConfigPayload,
  isHomepageSectionVisible,
  isPinResolvable,
  normalizeHomepageConfig,
  normalizeHomepageHref,
  pinFeatured,
  resolveHomepageHero,
} from "../src/theme/homepage.ts";
import {
  BRAND_SLOTS,
  SLOT_POLICY,
  checkBrandUpload,
  brandObjectKey,
  brandObjectKeysFor,
  isBrandSlot,
  isManagedBrandAsset,
} from "../src/lib/brandAssets.ts";
import { normalizeSiteTheme, defaultSiteTheme } from "../src/theme/runtime.ts";

/**
 * Appearance Editor 5.0 — the Storefront Control Center.
 *
 * The passes before this one fixed *labelling*: every colour says what it
 * reaches, and searching for a thing on the screen finds it. What they could not
 * fix was the shell those labels lived in — three columns, a permanent preview
 * wall, a `position: fixed` publish bar over the content, and a search that only
 * covered colours. This file covers what 5.0 replaced.
 *
 * Source-text assertions here are deliberately about *properties that would
 * otherwise regress silently*: a fixed action bar, a permanent preview column, a
 * second colour control. Where a property can be asserted against data or
 * behaviour instead, it is.
 */

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
/** Source with comments removed, for "must not appear" assertions. */
const code = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const page = read("src/app/staff/appearance/page.tsx");
const chrome = read("src/app/staff/appearance/EditorChrome.tsx");
const controls = read("src/app/staff/appearance/ColorControls.tsx");
const panels = read("src/app/staff/appearance/panels.tsx");
const stage = read("src/app/staff/appearance/PreviewStage.tsx");
const sections = read("src/app/staff/appearance/sections.tsx");
const css = read("src/app/globals.css");
const cssRules = css.replace(/\/\*[\s\S]*?\*\//g, "");

/* ========================================================================== */
/* PHASE 2 / 52–56 — the shell                                                */
/* ========================================================================== */

test("the three-column editor is gone, and cannot come back unnoticed", () => {
  /*
   * The exact grid that caused this pass. The staff rail takes 280px before this
   * page sees anything, so on a 1366px laptop a permanent 320px preview column
   * left the editor about 400px — narrower than one colour row.
   */
  assert.doesNotMatch(
    code(page),
    /xl:grid-cols-\[230px_minmax\(0,1fr\)_minmax\(320px,\.7fr\)\]/,
    "the old three-column grid must not return"
  );
  // Nothing in the editor may declare a three-column shell at all.
  for (const source of [page, chrome, panels, stage]) {
    assert.doesNotMatch(
      code(source),
      /grid-cols-\[[^\]]*_[^\]]*_[^\]]*\]/,
      "the editor shell is two columns: a rail and a workspace"
    );
  }

  // The shell is the declared one, and it is two columns.
  assert.match(page, /className="appearance-shell"/);
  assert.match(page, /className="appearance-body"/);
  assert.match(cssRules, /\.appearance-body \{ display: grid; gap: \.75rem; min-height: 0; \}/);
  assert.match(cssRules, /grid-template-columns: 13\.5rem minmax\(0, 1fr\)/);
});

test("the workspace scrolls itself, so the action bar is never over content", () => {
  /*
   * The old bar was `fixed inset-x-0 bottom-0` with `pb-24` on the page. `pb-24`
   * reserves space at the *end* of a document, not along it — so everything that
   * scrolled past the viewport's bottom edge passed underneath the bar, and on a
   * 768px screen it sat on top of live controls for the entire scroll.
   *
   * The fix is structural rather than cosmetic: the shell is exactly
   * viewport-high, the rail and workspace scroll inside it, and the action bar
   * is a `flex: none` sibling *below* them.
   */
  assert.doesNotMatch(code(chrome), /position:\s*fixed|fixed inset-x-0/, "the action bar must not be fixed");
  assert.doesNotMatch(code(page), /pb-24/, "no bottom padding compensating for a floating bar");

  assert.match(cssRules, /\.appearance-actions \{ flex: none; \}/);
  assert.match(cssRules, /\.appearance-head \{ flex: none; \}/);
  assert.match(cssRules, /\.appearance-workspace \{ overflow-y: auto; overscroll-behavior: contain; \}/);
  assert.match(cssRules, /height: calc\(100dvh - var\(--km-header-height\) - 2rem\)/);

  /*
   * `min-height: 0` is what makes the internal scroll real. A grid or flex item
   * defaults to `min-height: auto`, which refuses to shrink below its content
   * and pushes the overflow back out of the box — restoring the original bug
   * with extra steps.
   */
  assert.match(cssRules, /\.appearance-rail \{ min-height: 0; \}/);
  assert.match(cssRules, /\.appearance-workspace \{ min-height: 0; \}/);

  /*
   * The fixed height only applies where there is room for it. Below 640px tall
   * the shell would be shorter than a workable workspace, so it falls back to
   * ordinary document flow and the page scrolls — which is the right behaviour
   * for a short window and the layout phones get anyway.
   */
  assert.match(cssRules, /@media \(min-width: 1024px\) and \(min-height: 640px\)/);
});

test("the rail is one line per section, clustered, and has a phone equivalent", () => {
  // The old rail printed a full sentence under all eight entries — 24 lines of
  // prose to read past on every visit to reach one word.
  assert.match(chrome, /function SectionRail/);
  assert.doesNotMatch(chrome.slice(chrome.indexOf("function SectionRail")), /section\.description/);

  // Three clusters, and every section is in one of them.
  assert.equal(APPEARANCE_CLUSTERS.length, 3);
  const clusters = new Set(APPEARANCE_CLUSTERS.map((cluster) => cluster.id));
  for (const section of APPEARANCE_SECTIONS) {
    assert.ok(clusters.has(section.cluster), `${section.id} has no cluster`);
  }
  // No cluster is empty, which would render a heading over nothing.
  for (const cluster of APPEARANCE_CLUSTERS) {
    assert.ok(
      APPEARANCE_SECTIONS.some((section) => section.cluster === cluster.id),
      `${cluster.id} has no sections`
    );
  }

  // Below the rail's breakpoint the same list is a native <select>: one control,
  // already keyboard- and screen-reader-correct, opening the platform's own
  // picker on a phone.
  assert.match(chrome, /function SectionPicker/);
  assert.match(chrome, /className="lg:hidden"/);
  assert.match(page, /<SectionPicker/);
});

/* ========================================================================== */
/* PHASE 5 — one section at a time                                            */
/* ========================================================================== */

test("each section renders only its own controls", () => {
  /*
   * The reported failure was opening Navigation and being shown previews for
   * buttons, forms, cards and staff panels beside it. Every section is now
   * behind an equality test on the open section, so nothing renders next to
   * something unrelated.
   */
  const rendered = [...page.matchAll(/section === "([a-z]+)" \?/g)].map((match) => match[1]);
  const declared = APPEARANCE_SECTIONS.map((section) => section.id);
  for (const id of declared) {
    assert.ok(rendered.includes(id), `${id} must have a workspace`);
  }
  for (const id of rendered) {
    assert.ok(declared.includes(id as never), `${id} is rendered but not declared`);
  }
});

test("every section has a title, one sentence, and a reset when it is dirty", () => {
  for (const section of APPEARANCE_SECTIONS) {
    const resolved = appearanceSection(section.id);
    assert.equal(resolved.id, section.id);
  }
  // Section reset is offered only when there is something to reset, and it is
  // named after the section rather than "this section".
  assert.match(page, /\{sectionDirty \? \(/);
  assert.match(page, /Reset \{currentSection\.label\.toLowerCase\(\)\}/);
  // And it confirms, because it throws away work.
  assert.match(page, /setConfirmReset\(true\)/);
  assert.match(page, /Reset section/);
});

/* ========================================================================== */
/* PHASE 7–10 — the preview                                                   */
/* ========================================================================== */

test("the preview is optional and never permanently takes a third of the screen", () => {
  // Off by default: the editor's normal state is the whole workspace.
  assert.match(page, /useState\(false\)/);
  assert.match(page, /\{showPreview \? "Hide preview" : "Show preview"\}/);
  assert.match(page, /aria-pressed=\{showPreview\}/);
  // It renders only when asked for, and only where there is something to show.
  assert.match(page, /\{showPreview && currentSection\.preview \?/);
  // The toggle is disabled rather than lying when a section has no preview.
  assert.match(page, /disabled=\{!currentSection\.preview\}/);

  /*
   * The stage is horizontal and capped, not a column. A navbar needs about
   * 900px to show its links, its search and its account cluster without
   * clipping; the old 320px column could show a third of it. The height cap is
   * what stops it becoming the same problem in the other axis on a 768px laptop.
   */
  assert.match(cssRules, /\.appearance-stage \{ max-height: 45vh; overflow: auto/);
  // A wide surface scrolls inside its own box rather than widening the page.
  assert.match(cssRules, /\.appearance-stage-wide \{ overflow-x: auto; \}/);
});

test("previews are real components, never approximations", () => {
  // The announcement bar and the product card are the production components.
  assert.match(stage, /import AnnouncementBar from "@\/components\/AnnouncementBar"/);
  assert.match(stage, /import ProductCard/);
  assert.match(stage, /className="catalog-grid"/);
  // The header uses the storefront's own classes, because `SiteHeader` needs a
  // router, a session and a cart that do not exist in the editor.
  for (const cssClass of ["site-header-shell", "site-nav-primary-link", "site-nav-utility", "site-nav-badge"]) {
    assert.ok(stage.includes(cssClass), `the header preview must use ${cssClass}`);
  }
  // The links come from the shared definition, so the preview cannot drift the
  // way the old one did — it showed a navigation two passes out of date.
  assert.match(stage, /import \{ primaryNav \}/);
  assert.match(stage, /primaryNav\.map/);
});

test("preview contexts are the real modes, and reset when the section changes", () => {
  // Desktop/phone for the header and homepage, list/grid for a product card —
  // both of which are real catalog modes, not invented ones.
  assert.match(stage, /header: \[\s*\{ value: "desktop"/);
  assert.match(stage, /productCard: \[\s*\{ value: "list"/);

  /*
   * List and grid are chosen by `data-catalog-density`, which only the catalog's
   * own pre-paint script stamps — and the rules treat *no attribute* as list, so
   * a wrapper attribute could turn grid on but nothing could turn list off. The
   * stage therefore stamps the document element, and removes it on unmount so a
   * client-side navigation to the catalog does not carry a stale preference into
   * a page whose script only runs on a full load.
   */
  assert.match(stage, /root\.setAttribute\("data-catalog-density", list \? "list" : "2"\)/);
  assert.match(stage, /if \(previous === null\) root\.removeAttribute\("data-catalog-density"\)/);

  // The context resets by remount rather than by an effect that renders the
  // wrong control once and then corrects it.
  assert.match(page, /key=\{currentSection\.preview\}/);
});

/* ========================================================================== */
/* PHASE 42–43 — search                                                       */
/* ========================================================================== */

test("search covers every kind of setting, not only colours", () => {
  const kinds = new Map<string, number>();
  for (const entry of APPEARANCE_SEARCH_INDEX) {
    kinds.set(entry.section, (kinds.get(entry.section) ?? 0) + 1);
  }
  // Every section a person can work in is represented. `templates` and
  // `advanced` are deliberately not: one holds saved looks rather than settings,
  // the other is a read-only reference.
  for (const id of ["brand", "navigation", "announcement", "homepage", "colours", "typography", "components", "commerce", "forms", "layout", "business"]) {
    assert.ok((kinds.get(id) ?? 0) > 0, `${id} has no findable settings`);
  }

  // Each result carries the three things a result needs to be useful.
  for (const entry of APPEARANCE_SEARCH_INDEX) {
    assert.ok(entry.label.length > 2, `${entry.anchor} needs a name`);
    assert.ok(entry.context.length > 10, `${entry.anchor} needs a short context`);
    assert.ok(
      APPEARANCE_SECTIONS.some((section) => section.id === entry.section),
      `${entry.anchor} points at an unknown section`
    );
  }

  // Anchors are unique — two results with the same anchor would send the owner
  // to whichever happened to render first.
  const anchors = APPEARANCE_SEARCH_INDEX.map((entry) => entry.anchor);
  assert.equal(new Set(anchors).size, anchors.length, "duplicate search anchors");
});

test("the brief's own search examples find the right settings", () => {
  const expect = (query: string, ...anchors: string[]) => {
    const found = searchAppearance(query).map((entry) => entry.anchor);
    for (const anchor of anchors) {
      assert.ok(found.includes(anchor), `"${query}" must find ${anchor}; got ${found.join(", ") || "nothing"}`);
    }
  };

  // "search: buy button → Buttons & components → Primary button; Product cards
  //  → Add to cart CTA"
  expect("buy", "task-primary-button", "commerce-cta");
  // "search: navbar → Navigation → Background, Text, Active accent; Brand →
  //  Interior logo"
  expect("navbar", "task-navbar");
  expect("interior", "brand-interior-logo");
  // "search: announcement → Message, Background, Link"
  expect("announcement", "announcement-message", "announcement-tone", "announcement-link");

  // The ranking: a result whose own name says it beats one that merely mentions
  // it in a keyword, so "cart" leads with the buying button rather than with the
  // count bubble that happens to mention carts.
  const cart = searchAppearance("cart");
  assert.ok(cart.length > 1);
  assert.equal(
    searchMatchStrength(cart[0], "cart"),
    2,
    "the best match must be one whose name or context says it"
  );
});

test("choosing a result opens its section and lands on the control", () => {
  assert.match(page, /const onSearchGo = useCallback\(\s*\(entry: AppearanceSearchEntry\) => goTo\(entry\.section, entry\.anchor\)/);
  assert.match(page, /setSection\(target\)/);
  /*
   * `setTimeout`, not `requestAnimationFrame`: rAF does not fire at all while a
   * tab is not being painted, so the jump silently did nothing in a backgrounded
   * tab — exactly the state a browser-driven check runs in.
   */
  assert.match(page, /window\.setTimeout\(\(\) => focusControl\(anchor\), 0\)/);
  assert.doesNotMatch(code(page), /requestAnimationFrame\(\(\) => focusControl/);

  // The result list is a real combobox, so it is operable without a mouse.
  assert.match(chrome, /role="combobox"/);
  assert.match(chrome, /role="listbox"/);
  assert.match(chrome, /role="option"/);
  assert.match(chrome, /aria-activedescendant/);
  assert.match(chrome, /event\.key === "ArrowDown"/);
  assert.match(chrome, /event\.key === "Escape"/);
});

/* ========================================================================== */
/* PHASE 28–31 — colour controls and inheritance                              */
/* ========================================================================== */

test("a colour shows its value whether it is set or inherited", () => {
  /*
   * The old row showed an empty text box beside a filled swatch for an automatic
   * colour, which reads as a bug rather than as inheritance. The value is now
   * always readable, and the two states say which they are.
   */
  assert.match(controls, /const shown = value \|\| fallback/);
  assert.match(controls, /Following <b[^>]*>\{setting\.optional\?\.inheritsFrom\}/);
  assert.match(controls, /\{shown\}<\/span>/);
});

test("inheritance names what it actually follows, per setting", () => {
  /*
   * Three of the seven optional colours do not follow the accent — the two
   * primary-button overrides follow the primary, and the button border follows
   * the button background. A single shared "Use brand accent" was therefore
   * wrong about half the time it appeared, and turning it off silently
   * repainted the button.
   */
  const follows = new Map(
    APPEARANCE_SETTINGS.filter((setting) => setting.optional).map((setting) => [
      setting.key,
      setting.optional!.follows,
    ])
  );
  assert.equal(follows.get("primaryButtonBackground"), "primaryColor");
  assert.equal(follows.get("primaryButtonBorder"), "primaryButtonBackground");
  assert.equal(follows.get("badgeBackground"), "accentColor");

  // The control reads the relationship from the map rather than assuming one.
  assert.match(controls, /setting\.optional\.inheritsFrom/);
  assert.doesNotMatch(code(controls), /"Use brand accent"/, "no single hard-coded inheritance label");
  // Opting out seeds the field with what was already rendering, so it never
  // changes what is on screen — it only stops tracking future palette changes.
  assert.match(controls, /onChange\(following \? fallback : ""\)/);
});

test("a changed colour offers to go back to what is published", () => {
  // Per-field reset, and it means "back to published" rather than "back to the
  // factory palette".
  assert.match(controls, /const moved = value !== published/);
  assert.match(controls, /onClick=\{\(\) => onChange\(published\)\}/);
  assert.match(page, /publishedOf: \(setting\) => readColor\(saved, setting\)/);
});

test("an unset optional colour stays unset through a round trip", () => {
  /*
   * `""` is a real value meaning "follow the accent", and it has to survive
   * normalization — a default substituted here would freeze the badge at
   * today's accent and silently stop it following a future palette change,
   * which is the behaviour every existing install depends on.
   */
  const theme = normalizeSiteTheme({ ...defaultSiteTheme, badgeBackground: "" });
  assert.equal(theme.badgeBackground, "");
  // And a malformed stored value falls back to inheriting rather than to a
  // hard-coded colour.
  assert.equal(normalizeSiteTheme({ badgeBackground: "not-a-colour" }).badgeBackground, "");
  assert.equal(normalizeSiteTheme({ badgeBackground: "#ABCDEF" }).badgeBackground, "#ABCDEF");
});

test("contrast is reported, not enforced", () => {
  // Per-field feedback beside the pair that caused it, and the page-level
  // warning for the pairs that span two sections.
  assert.match(controls, /Small text needs 4\.5:1 to stay readable/);
  assert.match(page, /needs more contrast/);
  // Nothing is blocked: publishing is gated on dirtiness, never on the warning.
  assert.match(chrome, /disabled=\{!dirty \|\| busy\}/);
  assert.doesNotMatch(code(chrome), /disabled=\{[^}]*warning/);
  assert.doesNotMatch(code(page), /if \(warning\) return;/);
});

/* ========================================================================== */
/* PHASE 44–49 — publish, discard, reset                                      */
/* ========================================================================== */

test("unsaved state is a count, and publishing is the only thing that saves", () => {
  assert.match(page, /function countChanges/);
  assert.match(page, /const changed = countChanges\(form, saved\)/);
  assert.match(chrome, /\{changed\} unpublished/);
  // Applying a template edits the form; it does not publish.
  const apply = page.slice(page.indexOf("const applyTemplate ="), page.indexOf("const changed ="));
  assert.doesNotMatch(apply, /fetch\(/);
  assert.match(apply, /Publish to make it live/);
});

test("a failed publish keeps the draft and says what went wrong", () => {
  const publish = page.slice(page.indexOf("async function publish()"), page.indexOf("const currentSection"));
  // `setSaved` runs only on the success path, so a rejected save loses nothing
  // and the owner can correct the one field the message names.
  const successIndex = publish.indexOf("setSaved(form)");
  const throwIndex = publish.indexOf("throw new Error");
  assert.ok(throwIndex >= 0 && successIndex > throwIndex, "the draft must survive a failed publish");
  assert.match(publish, /notify\(error instanceof Error \? error\.message : "Could not save\.", "danger"\)/);
  // The success write is inside the `try`, after the throw — so a non-OK
  // response can never reach it.
  assert.ok(publish.indexOf("} catch (error)") > successIndex, "setSaved must be inside the try");
});

test("discarding real work asks first", () => {
  // Proportional: one stray change goes back without ceremony, a session's worth
  // takes a decision.
  assert.match(page, /changed > 3 \? setConfirmDiscard\(true\) : setForm\(saved\)/);
  assert.match(page, /Discard \$\{changed\} unpublished changes\?/);
  // One dialog component for every destructive action, so none of them can end
  // up without `aria-modal` or with focus on the destructive button.
  assert.match(page, /function ConfirmDialog/);
  assert.match(page, /aria-modal="true"/);
  assert.match(page, /<button type="button" autoFocus onClick=\{onCancel\}/);
  assert.match(page, /event\.key === "Escape"/);
});

test("section reset touches only that section", () => {
  const reset = page.slice(page.indexOf("const resetSection ="), page.indexOf("const sectionDirty"));
  // Derived from the section map, so a colour that moves between sections cannot
  // be reset by both or by neither.
  assert.match(reset, /settingSection\(setting\) !== section/);
  assert.match(reset, /SECTION_CHOICE_KEYS\[section\]/);
  // And it resets to what is published, not to the defaults.
  assert.doesNotMatch(reset, /defaultSiteTheme/);
  assert.match(reset, /saved\.theme\[key\]/);
});

/* ========================================================================== */
/* PHASE 11–15 / 59–60 — brand and uploads                                    */
/* ========================================================================== */

test("logos are uploaded, not pasted, and the slots are named by page", () => {
  assert.match(sections, /<LogoUpload/);
  assert.match(sections, /slot="primary"/);
  assert.match(sections, /slot="alternate"/);
  // Named by the page they appear on, which is the question an owner has —
  // "keymoura.com shows the colour mark, /catalog shows the white one".
  assert.match(sections, /Homepage header/);
  assert.match(sections, /Every other page/);
  assert.doesNotMatch(code(sections), /slot A|slot B/i);
  // Choosing an empty slot silently gets you the primary mark, and an owner who
  // is not told that reads the unchanged header as the setting not working.
  assert.match(sections, /No alternate logo is uploaded/);
  // The site-name toggle.
  assert.match(sections, /Show “\$\{siteName\}” beside the logo/);
});

test("the homepage hero image reuses the logo pipeline rather than a new one", () => {
  assert.ok(isBrandSlot("homepage-hero"));
  assert.ok(BRAND_SLOTS.includes("homepage-hero"));
  // The storage key is still built from a name off the fixed list and an
  // extension sniffed from the bytes, so nothing a request supplies reaches the
  // path.
  assert.equal(brandObjectKey("homepage-hero", "image/png"), "brand/homepage-hero.png");
  assert.deepEqual(brandObjectKeysFor("homepage-hero"), [
    "brand/homepage-hero.png",
    "brand/homepage-hero.jpg",
    "brand/homepage-hero.webp",
  ]);
  // And it is still inside the prefix the cleanup path is allowed to delete.
  assert.ok(
    isManagedBrandAsset(
      "https://x.supabase.co/storage/v1/object/public/product-assets/brand/homepage-hero.png"
    )
  );
  assert.ok(!isManagedBrandAsset("https://example.com/someone-elses-logo.png"));

  assert.match(sections, /slot="homepage-hero"/);
});

test("slot policy changes the limits and nothing else", () => {
  /** A PNG whose IHDR declares the given size. */
  const png = (width: number, height: number) => {
    const bytes = new Uint8Array(64);
    bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
    const view = new DataView(bytes.buffer);
    view.setUint32(16, width);
    view.setUint32(20, height);
    return bytes;
  };

  // A hero is allowed to be heavier than a logo, and has to be bigger.
  assert.ok(SLOT_POLICY["homepage-hero"].maxBytes > SLOT_POLICY.primary.maxBytes);
  assert.ok(SLOT_POLICY["homepage-hero"].minDimension > SLOT_POLICY.primary.minDimension);

  // 64×64 is a fine logo and far too small for a hero.
  assert.equal(checkBrandUpload(png(64, 64), 1000, "primary").ok, true);
  const smallHero = checkBrandUpload(png(64, 64), 1000, "homepage-hero");
  assert.equal(smallHero.ok, false);
  assert.match(smallHero.ok ? "" : smallHero.error, /at least 600px/);

  /*
   * Every *refusal* is identical whichever slot is being written. A hero image
   * is served from the same world-readable bucket on the same origin as the
   * logo, so relaxing any of these for the larger file would relax them for the
   * threat too.
   */
  for (const slot of BRAND_SLOTS) {
    // SVG is a document, not a bitmap: it can carry script and would be served
    // same-origin. Refused for every slot.
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>');
    const result = checkBrandUpload(svg, svg.length, slot);
    assert.equal(result.ok, false, `${slot} must refuse SVG`);
    assert.match(result.ok ? "" : result.error, /PNG, JPEG, or WebP/);

    // Empty and unreadable files are refused everywhere too.
    assert.equal(checkBrandUpload(new Uint8Array(0), 0, slot).ok, false);
    assert.equal(checkBrandUpload(png(0, 0), 100, slot).ok, false);
  }
});

/* ========================================================================== */
/* PHASE 21–27 / 64 — homepage                                                */
/* ========================================================================== */

test("homepage configuration fits the existing settings document", () => {
  /*
   * The deciding question for this pass: homepage configuration either fits the
   * settings architecture that exists or it needs a schema, and a schema needs
   * authorization. It fits — every field is a string, a boolean or a product id
   * on the `branding_config.homepage` branch that already held the two pins.
   */
  const payload = homepageConfigPayload(defaultHomepageConfig);
  for (const key of Object.keys(defaultHomepageConfig)) {
    assert.ok(key in payload, `${key} must round-trip`);
  }
  // And it reads back to itself.
  assert.deepEqual(normalizeHomepageConfig({ homepage: payload }), defaultHomepageConfig);
});

test("hero copy falls back per field, not per object", () => {
  const shipped = {
    eyebrow: "Shipped eyebrow",
    titleLead: "Shipped lead",
    titleAccent: "Shipped accent",
    lede: "Shipped lede",
    primary: { label: "Shop", href: "/catalog" },
    secondary: { label: "Custom", href: "/orders/new" },
  };

  // An owner who rewrites only the headline keeps the shipped eyebrow and
  // buttons. A copied default would freeze, and the next time the shipped copy
  // improved this site would be the one still showing the old sentence.
  const partial = resolveHomepageHero(
    { ...defaultHomepageConfig, heroTitleLead: "Ours" },
    shipped
  );
  assert.equal(partial.titleLead, "Ours");
  assert.equal(partial.eyebrow, "Shipped eyebrow");
  assert.deepEqual(partial.primary, shipped.primary);

  // A button needs both halves. A label with no destination is a button that
  // goes nowhere, so the pair falls back together.
  const halfCta = resolveHomepageHero(
    { ...defaultHomepageConfig, heroPrimaryCtaLabel: "Buy" },
    shipped
  );
  assert.deepEqual(halfCta.primary, shipped.primary, "a label without a destination falls back");

  const fullCta = resolveHomepageHero(
    { ...defaultHomepageConfig, heroPrimaryCtaLabel: "Buy", heroPrimaryCtaHref: "/shop" },
    shipped
  );
  assert.deepEqual(fullCta.primary, { label: "Buy", href: "/shop" });
});

test("homepage button destinations refuse anything but a path or https", () => {
  assert.equal(normalizeHomepageHref("/catalog"), "/catalog");
  assert.equal(normalizeHomepageHref("https://example.com"), "https://example.com");
  // These become `href`s above the fold on the most-visited page.
  assert.equal(normalizeHomepageHref("javascript:alert(1)"), "");
  assert.equal(normalizeHomepageHref("data:text/html,<script>"), "");
  assert.equal(normalizeHomepageHref("http://example.com"), "");
  assert.equal(normalizeHomepageHref(42), "");

  // And the route refuses them loudly rather than normalizing them away —
  // silently emptying a destination would restore the shipped button while the
  // owner believed they had changed it.
  const route = read("src/app/api/staff/appearance/route.ts");
  assert.match(route, /heroPrimaryCtaHref/);
  assert.match(route, /button link must be a path starting with \/ or an https:\/\/ address/);
});

test("copy is bounded, so a headline cannot become an essay", () => {
  const long = "x".repeat(1000);
  const config = normalizeHomepageConfig({
    homepage: { heroTitleLead: long, heroLede: long },
  });
  assert.equal(config.heroTitleLead.length, HERO_TITLE_MAX);
  assert.equal(config.heroLede.length, HERO_LEDE_MAX);
});

test("the featured product is a canonical id, and a missing one degrades quietly", () => {
  const published = [{ id: "a" }, { id: "b" }, { id: "c" }];

  // A pin reorders the published list; it is never a lookup.
  assert.deepEqual(pinFeatured(published, "c").map((product) => product.id), ["c", "a", "b"]);

  /*
   * This is the entire safeguard against featuring a draft. The list handed in
   * is what the *public*, row-level-security-backed catalog query returned, so a
   * product that is unpublished, archived or deleted is simply not in it, the
   * find misses, and the page falls back to its normal ordering.
   */
  assert.deepEqual(pinFeatured(published, "deleted").map((product) => product.id), ["a", "b", "c"]);
  assert.deepEqual(pinFeatured([], "a"), []);
  assert.ok(!isPinResolvable(published, "deleted"));
  assert.ok(isPinResolvable(published, "b"));

  /*
   * Nothing about the product is duplicated into appearance settings — only the
   * id. A stored name or price would be a second copy of catalog data that
   * nothing keeps in step, and the homepage would go on advertising last
   * month's price after somebody changed it in the catalog.
   */
  const payload = homepageConfigPayload({ ...defaultHomepageConfig, featuredProductId: "abc" });
  const productKeys = Object.keys(payload).filter((key) => /product/i.test(key));
  assert.deepEqual(productKeys, ["featuredProductId", "heroProductId"]);
  for (const key of productKeys) {
    assert.match(key, /Id$/, `${key} must store a reference, not a detail`);
  }
  assert.deepEqual(
    Object.keys(payload).filter((key) => /name|price|slug|thumbnail/i.test(key)),
    [],
    "product details stay canonical"
  );

  // The picker searches published products rather than taking a pasted id.
  const picker = read("src/app/staff/appearance/ProductPicker.tsx");
  assert.match(picker, /\/api\/public\/catalog-suggest/);
});

test("optional homepage bands can be hidden, and the load-bearing ones cannot", () => {
  const optional = SECTION_TOGGLES.map((toggle) => toggle.id);
  // The five that are elaboration.
  assert.deepEqual(optional, ["productFocus", "process", "making", "recentWork", "assurances"]);

  /*
   * The ones deliberately absent carry the page's actual offer and both of its
   * conversion paths. Hiding those does not customise the homepage, it removes
   * it — and an editor that lets somebody do that by accident has mis-sold the
   * word "optional".
   */
  for (const critical of ["hero", "capabilities", "featuredProducts", "customProject", "finalCta"]) {
    assert.ok(!optional.includes(critical as never), `${critical} must not be hideable`);
  }

  // Absent means shown: a band that is new to the settings document must appear
  // for a site that has never opened this editor, not vanish from it.
  const fresh = normalizeHomepageConfig({ homepage: {} });
  for (const toggle of SECTION_TOGGLES) {
    assert.equal(isHomepageSectionVisible(fresh, toggle.id), true, `${toggle.id} must default to shown`);
  }
  const hidden = normalizeHomepageConfig({ homepage: { sections: { process: false } } });
  assert.equal(isHomepageSectionVisible(hidden, "process"), false);
  assert.equal(isHomepageSectionVisible(hidden, "making"), true);

  // The page reads the same list, so the editor and the homepage cannot
  // disagree about which bands are optional.
  const home = read("src/app/page.tsx");
  assert.match(home, /isHomepageSectionVisible/);
  for (const id of optional) {
    assert.match(home, new RegExp(`shows\\("${id}"\\)`), `${id} must be gated on the page`);
  }
  // And the critical ones are rendered unconditionally.
  assert.match(home, /<HomeCapabilities media=/);
  assert.match(home, /\n      <HomeCustomProject \/>/);
  assert.match(home, /\n      <HomeFinalCta \/>/);
});

test("an uploaded hero image goes through the site's one image pipeline", () => {
  const home = read("src/app/page.tsx");
  /*
   * `HomeMedia` takes a `ProductImageSource`, which is `{ image_url,
   * product_media }` — so a one-field object is a legitimate source, not a
   * workaround. It gets the same candidate ordering, the same fall-forward past
   * a broken URL and the same optimizer decision as every other picture.
   */
  assert.match(home, /homepage\.heroImageUrl \? \{ image_url: homepage\.heroImageUrl \} : media\.heroLead/);
  // And it is decorative beside the headline, unlike the product photograph it
  // replaces, which was named because it carried information.
  assert.match(home, /homepage\.heroImageUrl \? "" : \(media\.heroLead\?\.name \?\? ""\)/);
});

/* ========================================================================== */
/* PHASE 35 / 39 — commerce                                                   */
/* ========================================================================== */

test("every storefront buying action maps to one documented button role", () => {
  /*
   * The colours were never wrong: `.ui-btn-primary`, `.catalog-action-primary`
   * and the card's `.product-card-action` all resolve `--primary-action-bg`.
   * What was missing was the editor saying so, so an owner hunting for "the
   * green Add to cart button" had no reason to look under a heading called
   * Buttons.
   */
  for (const selector of ["\\.ui-btn-primary", "\\.catalog-action-primary", "\\.product-card-action"]) {
    const rule = new RegExp(`${selector}[^{]*\\{[^}]*--primary-action-`, "s");
    assert.match(cssRules, rule, `${selector} must read the shared primary action role`);
  }
  assert.match(cssRules, /--primary-action-bg: var\(--km-primary-button-bg, var\(--brand-primary/);

  // The editor names all five, says they share one set of colours, and links to
  // the control rather than offering a second one that writes the same value.
  for (const label of ["Add to cart", "Buy now", "Checkout", "Customize", "Request a quote"]) {
    assert.ok(panels.includes(label), `the commerce section must name ${label}`);
  }
  assert.match(panels, /there is no separate/);
  assert.match(panels, /onGoTo\("components", "task-primary-button"\)/);

  // And the one that is genuinely surprising: it looks like a buying action and
  // is coloured like a supporting one.
  assert.match(panels, /Request a Custom Version/);
  assert.match(panels, /onGoTo\("components", "task-custom-project-button"\)/);
});

test("semantic status colours stay semantic, and the editor explains why", () => {
  for (const selector of [".ui-badge-success", ".ui-badge-danger"]) {
    const start = cssRules.indexOf(selector);
    assert.ok(start > 0, `${selector} must exist`);
    const rule = cssRules.slice(start, cssRules.indexOf("}", start));
    assert.match(rule, /#(4ade80|fb7185)/, `${selector} is intentionally fixed and must stay literal`);
  }
  assert.match(panels, /deliberately fixed green and red/);
  assert.match(panels, /Sold out badge in your accent green/);
  // The one badge that *is* brand-controlled says which colour it follows.
  assert.equal(sectionForTask("customizable-badge"), "commerce");
});

/* ========================================================================== */
/* PHASE 4 — what happened to "Labels"                                        */
/* ========================================================================== */

test("there is no Labels section, and the badge colours sit with the card", () => {
  /*
   * The editor's "Labels & wording" section went a pass ago — it wrote
   * `site_settings.terminology`, which nothing rendered. What survived was the
   * colour *group* still called "Labels & badges", holding the three badge
   * tokens, and that name was the remaining half of the same problem: a shop
   * owner looking for the "Customizable" pill does not look under Labels.
   */
  const labels = APPEARANCE_SECTIONS.filter((section) => /label/i.test(section.label));
  assert.deepEqual(labels, [], "no section may be called Labels");

  // The badge colours are beside the card they appear on and the CTA under them.
  assert.equal(sectionForTask("customizable-badge"), "commerce");
  assert.equal(sectionForTask("product-price"), "commerce");

  // The underlying tokens are untouched — this was a presentation move, which is
  // the layer allowed to change without a database change.
  for (const key of ["badgeBackground", "badgeText", "badgeBorder"]) {
    assert.ok(
      APPEARANCE_SETTINGS.some((setting) => setting.key === key),
      `${key} must still be a declared setting`
    );
  }
  assert.equal(defaultSiteTheme.badgeBackground, "", "the token still defaults to following the accent");
});

/* ========================================================================== */
/* PHASE 50–51 / 61–63 — Advanced, and backward compatibility                 */
/* ========================================================================== */

test("the main editor is not a CSS-variable inspector", () => {
  // The variable name appears in exactly one workspace, and that workspace says
  // it is read-only.
  assert.match(panels, /function AdvancedPanel/);
  const advanced = panels.slice(panels.indexOf("function AdvancedPanel"));
  assert.match(advanced, /setting\.variable/);
  assert.match(advanced, /Read-only/);
  // No other section prints a token name at an owner.
  assert.doesNotMatch(code(controls), /setting\.variable/);
  assert.doesNotMatch(code(sections), /setting\.variable/);
});

test("published values load unchanged, and the editor never resets a live site", () => {
  /*
   * The rebuild replaced the editor, not the thing it edits. A site's stored
   * theme has to load and render exactly as before — an editor redesign that
   * repainted a live storefront on first open would be the worst possible
   * outcome of a usability pass.
   */
  const stored = {
    ...defaultSiteTheme,
    background: "#101820",
    navigationBackground: "#000000",
    primaryButtonBackground: "#2266cc",
    badgeBackground: "",
  };
  assert.deepEqual(normalizeSiteTheme(stored), stored, "a stored theme must survive a round trip");

  // The page loads the published values into both the working form and the
  // baseline, so a freshly opened editor is not dirty.
  assert.match(page, /setForm\(loaded\)/);
  assert.match(page, /setSaved\(loaded\)/);
  // And it does not write defaults over what came back.
  assert.match(page, /\.\.\.defaults,\s*\n\s*\.\.\.settings,/);
});

test("every colour still has exactly one control, in exactly one section", () => {
  // The partition, asserted end to end: task → section, and no colour orphaned.
  const owned = APPEARANCE_TASKS.flatMap((task) => task.fields.map((field) => field.key));
  assert.equal(new Set(owned).size, owned.length, "a colour with two controls");
  assert.equal(owned.length, APPEARANCE_SETTINGS.length, "a colour with no control");

  const drawn = APPEARANCE_SECTIONS.flatMap((section) => tasksForSection(section.id));
  assert.equal(drawn.length, APPEARANCE_TASKS.length, "a task drawn twice, or not at all");
});
