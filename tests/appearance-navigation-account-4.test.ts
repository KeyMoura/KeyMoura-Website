import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

import {
  ANNOUNCEMENT_STORAGE_KEY,
  announcementVersion,
  defaultAnnouncementConfig,
  hasAnnouncementCta,
  isAnnouncementScheduled,
  isAnnouncementVisible,
  isExternalAnnouncementHref,
  normalizeAnnouncementConfig,
  normalizeAnnouncementHref,
  normalizeSchedule,
} from "../src/theme/announcement.ts";
import {
  brandLogoFor,
  normalizeBrandConfig,
  resolveNavLogo,
} from "../src/theme/brand.ts";
import {
  isPinResolvable,
  normalizeHomepageConfig,
  normalizeProductId,
  pinFeatured,
} from "../src/theme/homepage.ts";
import {
  BRAND_MAX_BYTES,
  brandObjectKey,
  brandObjectKeysFor,
  checkBrandUpload,
  isBrandSlot,
  isManagedBrandAsset,
  readImageDimensions,
  sniffBrandImageType,
} from "../src/lib/brandAssets.ts";
import { accountSectionNav, isNavItemActive, primaryNav, secondaryNav } from "../src/lib/navigation.ts";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
/** Source with comments removed, for "must not appear" assertions. */
const code = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const css = read("src/app/globals.css");
const cssRules = css.replace(/\/\*[\s\S]*?\*\//g, "");
const header = read("src/components/SiteHeader.tsx");
const appearancePage = read("src/app/staff/appearance/page.tsx");
const sections = read("src/app/staff/appearance/sections.tsx");
const brandRoute = read("src/app/api/staff/appearance/brand-asset/route.ts");
const appearanceRoute = read("src/app/api/staff/appearance/route.ts");

// ===========================================================================
// PART A/B — the Appearance page's information architecture
// ===========================================================================

test("Appearance is sectioned by owner task, and every section resets only itself", () => {
  for (const section of ["brand", "navigation", "announcement", "homepage", "colors", "components", "business", "templates"]) {
    assert.match(appearancePage, new RegExp(`${section}: \\{ label:`), `${section} needs a heading and a description`);
  }

  /*
   * Reset is per-section and means "back to what is published", not "back to
   * the factory palette". An owner who has ruined one logo must not have to
   * choose between keeping it and discarding the four other sections they just
   * finished — which is what a single site-wide reset would force.
   */
  const reset = appearancePage.slice(
    appearancePage.indexOf("const resetSection ="),
    appearancePage.indexOf("async function save()")
  );
  for (const branch of ["brand", "announcement", "homepage", "colors", "navigation", "components"]) {
    assert.ok(reset.includes(`"${branch}"`), `${branch} must have its own reset branch`);
  }
  assert.match(reset, /saved\.brand/);
  assert.match(reset, /saved\.announcement/);
  assert.match(reset, /saved\.homepage/);
});

test("the colour list is partitioned, so no colour has two controls", () => {
  // Navigation shows the navbar's colours; Colours shows everything else. Both
  // render the same list through one filter rather than duplicating entries —
  // the rule `appearanceTasks.ts` exists to hold.
  assert.match(appearancePage, /only="navigation"/);
  assert.match(appearancePage, /only="site"/);
  assert.match(appearancePage, /function isNavigationTask/);
  assert.match(appearancePage, /isNavigationTask\(task\) === wantsNav/);
});

test("unsaved state, save feedback and publishing stay explicit", () => {
  assert.match(appearancePage, /You have unpublished appearance changes/);
  assert.match(appearancePage, /Appearance is up to date/);
  assert.match(appearancePage, /Discard changes/);
  assert.match(appearancePage, /Publish appearance/);
  assert.match(appearancePage, /Reset this section/);
  // Feedback is a status region, never a modal dialog the browser owns.
  assert.doesNotMatch(code(appearancePage), /\balert\(/);
  assert.doesNotMatch(code(sections), /\balert\(/);
});

test("uploading a logo does not publish it", () => {
  /*
   * The upload route stores the file and returns its URL; the editor drops that
   * into the working form and Publish is still what makes it live. An upload
   * that silently rewrote site_settings would be the one control on this page
   * that skipped the review step every other control has.
   */
  assert.doesNotMatch(brandRoute, /from\("site_settings"\)/);
  assert.match(brandRoute, /return NextResponse\.json\(\{[\s\S]{0,200}url,/);
  const upload = read("src/app/staff/appearance/LogoUpload.tsx");
  assert.match(upload, /Publish to make it live/);
});

// ===========================================================================
// PART C / O — brand assets, upload validation, storage
// ===========================================================================

/** A PNG whose IHDR declares the given size. Enough bytes for the header reader. */
function pngBytes(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(64);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

test("the uploaded file's own bytes decide its type, not what the request claimed", () => {
  assert.equal(sniffBrandImageType(pngBytes(64, 64)), "image/png");

  const jpeg = new Uint8Array(64);
  jpeg.set([0xff, 0xd8, 0xff], 0);
  assert.equal(sniffBrandImageType(jpeg), "image/jpeg");

  const webp = new Uint8Array(64);
  webp.set([0x52, 0x49, 0x46, 0x46], 0);
  webp.set([0x57, 0x45, 0x42, 0x50], 8);
  assert.equal(sniffBrandImageType(webp), "image/webp");

  /*
   * The cases that matter. `File.type` on a multipart upload is supplied by the
   * client — it is the browser repeating an extension back, and a script posting
   * the form can put any string there. A renamed executable and an SVG both look
   * like images by name and neither is one.
   */
  const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>');
  assert.equal(sniffBrandImageType(svg), null, "SVG is a document and is refused");

  const windowsExe = new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00, 0, 0, 0, 0]);
  assert.equal(sniffBrandImageType(windowsExe), null);

  const gif = new TextEncoder().encode("GIF89a");
  assert.equal(sniffBrandImageType(gif), null, "GIF is outside the allowed set");
});

test("dimensions come out of the header, and absurd ones are refused", () => {
  assert.deepEqual(readImageDimensions(pngBytes(512, 256), "image/png"), { width: 512, height: 256 });

  const ok = checkBrandUpload(pngBytes(512, 256), 4096);
  assert.equal(ok.ok, true);
  if (ok.ok) {
    assert.equal(ok.type, "image/png");
    assert.deepEqual(ok.dimensions, { width: 512, height: 256 });
  }

  const tiny = checkBrandUpload(pngBytes(8, 8), 512);
  assert.equal(tiny.ok, false);
  if (!tiny.ok) assert.match(tiny.error, /at least/);

  const huge = checkBrandUpload(pngBytes(9000, 9000), 4096);
  assert.equal(huge.ok, false);
  if (!huge.ok) assert.match(huge.error, /no larger than/);

  // A truncated file cannot be measured, and "cannot verify" is a refusal here
  // rather than a pass — an unreadable header is itself a reason to be careful.
  const truncated = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const short = checkBrandUpload(truncated, 8);
  assert.equal(short.ok, false);
});

test("size is checked before format, and an empty file is refused", () => {
  const oversize = checkBrandUpload(pngBytes(64, 64), BRAND_MAX_BYTES + 1);
  assert.equal(oversize.ok, false);
  // Size first: telling somebody to convert a 40 MB GIF and then rejecting it
  // for size on the second attempt is two round trips for one problem.
  if (!oversize.ok) assert.match(oversize.error, /too large/);

  const empty = checkBrandUpload(new Uint8Array(0), 0);
  assert.equal(empty.ok, false);
});

test("the storage key is built from values this module owns", () => {
  assert.equal(brandObjectKey("primary", "image/png"), "brand/primary.png");
  assert.equal(brandObjectKey("alternate", "image/webp"), "brand/alternate.webp");

  // One object per slot, so replacing in the same format overwrites in place and
  // only the *other two formats of the same slot* can ever be orphaned.
  assert.deepEqual(brandObjectKeysFor("primary").sort(), [
    "brand/primary.jpg",
    "brand/primary.png",
    "brand/primary.webp",
  ]);

  // Nothing a request supplies reaches the path.
  assert.equal(isBrandSlot("primary"), true);
  assert.equal(isBrandSlot("../../etc"), false);
  assert.equal(isBrandSlot("logo"), false);
});

test("cleanup refuses assets this application did not store", () => {
  assert.equal(
    isManagedBrandAsset("https://x.supabase.co/storage/v1/object/public/product-assets/brand/primary.png"),
    true
  );
  // The shipped marks are referenced by site.config.ts as the build-time
  // fallback and are not in a bucket; a pasted URL belongs to whoever hosts it.
  assert.equal(isManagedBrandAsset("/brand/keymoura-colored.png"), false);
  assert.equal(isManagedBrandAsset("https://cdn.example.com/logo.png"), false);
  assert.equal(
    isManagedBrandAsset("https://x.supabase.co/storage/v1/object/public/product-assets/abc/photo.png"),
    false,
    "a product photograph is not a brand asset"
  );
});

test("brand uploads are staff-only and reuse the bucket that already has policies", () => {
  assert.match(brandRoute, /requirePermission\(req, "appearance\.manage"\)/);
  assert.match(brandRoute, /status: 403/);
  // No new bucket and no migration: product-assets is already public-read and
  // already restricted on write to is_staff_user().
  const assets = read("src/lib/brandAssets.ts");
  assert.match(assets, /BRAND_BUCKET = "product-assets"/);
  // Both verbs are guarded, not just the upload.
  const deleteHandler = brandRoute.slice(brandRoute.indexOf("export async function DELETE"));
  assert.match(deleteHandler, /requirePermission\(req, "appearance\.manage"\)/);
});

test("no migration was added, and the pending security migrations are untouched", () => {
  for (const pending of [
    "supabase/migrations/20260811025000_public_profile_projection.sql",
    "supabase/migrations/20260811030000_security_boundary_hardening.sql",
  ]) {
    assert.ok(existsSync(new URL(`../${pending}`, import.meta.url)), `${pending} must still exist`);
  }
  // Everything this pass added persists in branding_config, which is jsonb and
  // already free-form.
  assert.match(appearanceRoute, /branding_config: brandingConfig/);
  assert.match(appearanceRoute, /brand: brandConfigPayload\(brand\)/);
  assert.match(appearanceRoute, /announcement: announcementConfigPayload\(announcement\)/);
  assert.match(appearanceRoute, /homepage: homepageConfigPayload\(homepage\)/);
});

// ---------------------------------------------------------------------------
// Brand configuration and the single navbar logo decision
// ---------------------------------------------------------------------------

test("an existing site keeps its logo when the brand editor has never been opened", () => {
  const brand = normalizeBrandConfig({}, "/brand/keymoura-colored.png");
  assert.equal(brand.primaryLogoUrl, "/brand/keymoura-colored.png");
  assert.equal(brand.alternateLogoUrl, "");
  assert.equal(brand.homepageLogo, "primary");
  assert.equal(brand.interiorLogo, "primary");
  // Absent means true: the header has always shown the name, so a site must not
  // lose its wordmark by virtue of the setting being new.
  assert.equal(brand.showBrandName, true);
});

test("stored asset references are refused unless they are a site path or https", () => {
  const brand = normalizeBrandConfig(
    { brand: { primaryLogoUrl: "javascript:alert(1)", alternateLogoUrl: "http://insecure.example/l.png" } },
    ""
  );
  assert.equal(brand.primaryLogoUrl, "");
  assert.equal(brand.alternateLogoUrl, "");
});

test("one function decides which logo the navbar draws", () => {
  const brand = normalizeBrandConfig(
    {
      brand: {
        primaryLogoUrl: "/brand/colour.png",
        alternateLogoUrl: "/brand/white.png",
        homepageLogo: "primary",
        interiorLogo: "alternate",
        showBrandName: false,
      },
    },
    ""
  );

  assert.equal(resolveNavLogo(brand, { isHome: true, siteName: "KeyMoura" }).src, "/brand/colour.png");
  assert.equal(resolveNavLogo(brand, { isHome: false, siteName: "KeyMoura" }).src, "/brand/white.png");

  // Choosing an empty slot falls back rather than rendering nothing.
  const noAlternate = { ...brand, alternateLogoUrl: "" };
  assert.equal(brandLogoFor(noAlternate, "alternate"), "/brand/colour.png");

  /*
   * The accessible name is present whether or not the wordmark is drawn. Hiding
   * the text is a visual choice; a logo link with no accessible name is
   * announced as "link, image", which is where a screen-reader user loses the
   * way home.
   */
  const hidden = resolveNavLogo(brand, { isHome: true, siteName: "KeyMoura" });
  assert.equal(hidden.showName, false);
  assert.equal(hidden.label, "KeyMoura home");
});

test("the header calls that one function instead of testing the pathname twice", () => {
  const headerCode = code(header);
  assert.match(headerCode, /const navLogo = resolveNavLogo\(/);
  assert.match(headerCode, /aria-label=\{navLogo\.label\}/);
  assert.match(headerCode, /navLogo\.showName/);
  // Exactly one `isHome` computation, feeding the one decision.
  assert.equal((headerCode.match(/const isHome =/g) ?? []).length, 1);
  // The decorative image never carries the name — the link does.
  assert.doesNotMatch(headerCode, /alt=\{siteSettings\.name\}/);
});

// ===========================================================================
// PART D — homepage configuration
// ===========================================================================

test("an unpublished product cannot be featured on the homepage", () => {
  /*
   * The safeguard is structural rather than a check. The list handed to
   * `pinFeatured` is what the *public*, RLS-backed catalog query returned, so a
   * product that has been unpublished, archived or deleted is simply not in it:
   * the pin finds nothing and the page falls back to catalog order.
   */
  const published = [{ id: "a" }, { id: "b" }, { id: "c" }];
  const draftId = "d";

  assert.equal(isPinResolvable(published, draftId), false);
  assert.deepEqual(pinFeatured(published, draftId), published, "an unresolvable pin changes nothing");

  assert.deepEqual(pinFeatured(published, "c").map((p) => p.id), ["c", "a", "b"]);
  assert.deepEqual(pinFeatured(published, "").map((p) => p.id), ["a", "b", "c"]);
  assert.deepEqual(pinFeatured(published, "a").map((p) => p.id), ["a", "b", "c"]);
});

test("the homepage's two pins fill different frames", () => {
  const home = read("src/app/page.tsx");
  /*
   * Applied to different lists in sequence: focus claims the first slot, then
   * the hero chooses from what is left. Pinning one product to both gives it the
   * focus section and leaves the hero to pick something else, rather than
   * showing the same photograph twice above the fold.
   */
  assert.match(home, /const withFocus = pinFeatured\(products, homepage\.featuredProductId\)/);
  assert.match(home, /pinFeatured\(withFocus\.slice\(1\), homepage\.heroProductId\)/);
});

test("product ids are validated, never interpolated blind", () => {
  assert.equal(normalizeProductId("3f2504e0-4f89-41d3-9a0c-0305e82c3301"), "3f2504e0-4f89-41d3-9a0c-0305e82c3301");
  assert.equal(normalizeProductId("3F2504E0-4F89-41D3-9A0C-0305E82C3301"), "3f2504e0-4f89-41d3-9a0c-0305e82c3301");
  assert.equal(normalizeProductId("' or 1=1 --"), "");
  assert.equal(normalizeProductId(42), "");
  assert.deepEqual(normalizeHomepageConfig({ homepage: { featuredProductId: "nope" } }), {
    featuredProductId: "",
    heroProductId: "",
  });
});

test("the featured product is chosen by searching, not by pasting a UUID", () => {
  const picker = read("src/app/staff/appearance/ProductPicker.tsx");
  // The public suggest endpoint only ever returns published products, so the
  // owner cannot pick something a customer could not see.
  assert.match(picker, /\/api\/public\/catalog-suggest/);
  assert.match(picker, /Search products/);
  assert.doesNotMatch(code(picker), /Product ID|productId" \/>/);
  // A pin that has since been unpublished says so, which is the one thing the
  // public endpoint cannot tell the owner.
  assert.match(picker, /Not published/);
});

// ===========================================================================
// PART E — the announcement bar
// ===========================================================================

const announcement = (overrides: Partial<typeof defaultAnnouncementConfig> = {}) => ({
  ...defaultAnnouncementConfig,
  ...overrides,
});

test("the announcement bar is separate from the security broadcast banner", () => {
  const broadcast = read("src/components/SiteBroadcastBanner.tsx");
  const bar = read("src/components/AnnouncementBar.tsx");

  // The security banner keeps its own table and its own severities.
  assert.match(broadcast, /get_site_lockdown_flags/);
  assert.match(broadcast, /critical/);
  // The announcement reads Appearance and has no severity at all — an
  // announcement that looks like an error is what this replaced.
  assert.doesNotMatch(code(bar), /get_site_lockdown_flags/);
  assert.doesNotMatch(code(bar), /critical|warning/);
  // Landmark, not an alert: a sale must not interrupt a screen reader.
  assert.match(bar, /aria-label="Site announcement"/);
  assert.doesNotMatch(code(bar), /role="alert"/);
});

test("nothing shows without both the switch and a message", () => {
  assert.equal(isAnnouncementVisible(announcement({ enabled: false, message: "Launching" })), false);
  assert.equal(isAnnouncementVisible(announcement({ enabled: true, message: "" })), false);
  assert.equal(isAnnouncementVisible(announcement({ enabled: true, message: "Launching" })), true);
});

test("scheduling opens and closes the window, and a malformed date never hides it", () => {
  const config = announcement({
    enabled: true,
    message: "15% off this weekend — KM15",
    startsAt: "2026-09-01T00:00:00.000Z",
    endsAt: "2026-09-03T00:00:00.000Z",
  });

  assert.equal(isAnnouncementScheduled(config, new Date("2026-08-31T23:59:00Z")), false);
  assert.equal(isAnnouncementScheduled(config, new Date("2026-09-02T12:00:00Z")), true);
  assert.equal(isAnnouncementScheduled(config, new Date("2026-09-04T00:00:00Z")), false);

  // An unbounded end is the default, and a value we cannot parse becomes
  // unbounded rather than closed: a typo must not be able to hide an
  // announcement the owner enabled, because that failure looks like the feature
  // not working.
  assert.equal(normalizeSchedule("not a date"), "");
  assert.equal(normalizeSchedule(""), "");
  const open = announcement({ enabled: true, message: "Launching", startsAt: "", endsAt: "" });
  assert.equal(isAnnouncementScheduled(open, new Date("2030-01-01T00:00:00Z")), true);

  // The window is evaluated on the server, so no clock reaches the browser.
  const layout = read("src/app/layout.tsx");
  assert.match(layout, /isAnnouncementVisible\(settings\.announcement\)/);
});

test("editing the message brings it back for everyone who dismissed the old one", () => {
  const first = announcement({ enabled: true, message: "Launching September 1st" });
  const edited = announcement({ enabled: true, message: "Launching September 8th" });
  const restyled = announcement({ enabled: true, message: "Launching September 1st", tone: "brand" });

  assert.notEqual(announcementVersion(first), announcementVersion(edited), "new wording, new key");
  assert.equal(
    announcementVersion(first),
    announcementVersion(restyled),
    "a colour change is the same announcement and must not un-dismiss it"
  );
  // Changing the call to action changes what is on screen, so it counts.
  assert.notEqual(
    announcementVersion(first),
    announcementVersion(announcement({ ...first, ctaText: "Shop now", ctaHref: "/catalog" }))
  );

  // One key, one short value. No personal data.
  assert.equal(ANNOUNCEMENT_STORAGE_KEY, "km-announcement-dismissed");
  assert.ok(announcementVersion(first).length <= 8);
});

test("a non-dismissible bar renders no close control", () => {
  const bar = read("src/components/AnnouncementBar.tsx");
  assert.match(bar, /config\.dismissible \? \(/);
  assert.match(bar, /aria-label="Dismiss announcement"/);
  /*
   * Turning dismissal off also clears the stored key. Otherwise everybody who
   * already dismissed the message is left unable to see it with no control on
   * screen that could bring it back — the one state invisible to both the reader
   * and the owner.
   */
  assert.match(bar, /removeItem\(ANNOUNCEMENT_STORAGE_KEY\)/);
});

test("the announcement link is the most dangerous field on the page and is treated as one", () => {
  assert.equal(normalizeAnnouncementHref("/catalog"), "/catalog");
  assert.equal(normalizeAnnouncementHref("https://example.com/sale"), "https://example.com/sale");
  assert.equal(normalizeAnnouncementHref("javascript:alert(1)"), "");
  assert.equal(normalizeAnnouncementHref("data:text/html,<script>"), "");
  assert.equal(normalizeAnnouncementHref("//evil.example"), "", "protocol-relative escapes the site");
  assert.equal(normalizeAnnouncementHref("http://insecure.example"), "");

  // A rejected link fails the save loudly rather than being silently dropped —
  // it is the one field that becomes an href on every page of the storefront.
  assert.match(appearanceRoute, /The announcement link must be a path starting with/);

  // External links get rel and stay in the same tab.
  assert.equal(isExternalAnnouncementHref("https://example.com"), true);
  assert.equal(isExternalAnnouncementHref("/catalog"), false);
  const bar = read("src/components/AnnouncementBar.tsx");
  assert.match(bar, /rel: "noopener noreferrer"/);
  assert.doesNotMatch(code(bar), /target="_blank"/);
});

test("half a call to action renders as none", () => {
  assert.equal(hasAnnouncementCta(announcement({ ctaText: "Shop", ctaHref: "" })), false);
  assert.equal(hasAnnouncementCta(announcement({ ctaText: "", ctaHref: "/catalog" })), false);
  assert.equal(hasAnnouncementCta(announcement({ ctaText: "Shop", ctaHref: "/catalog" })), true);
  // The editor says so rather than leaving the owner to notice.
  assert.match(sections, /Link text without an address will not show/);
});

test("announcement content is bounded and the tone set has no red", () => {
  const long = "x".repeat(500);
  const config = normalizeAnnouncementConfig({
    announcement: { label: long, message: long, ctaText: long, tone: "danger" },
  });
  assert.ok(config.label.length <= 16);
  assert.ok(config.message.length <= 200);
  assert.ok(config.ctaText.length <= 40);
  // An unknown tone falls back rather than reaching the stylesheet.
  assert.equal(config.tone, "accent");
  assert.doesNotMatch(cssRules, /\.announcement-bar\[data-tone="danger"\]/);
});

test("the announcement wraps on a phone rather than truncating a promo code", () => {
  const block = cssRules.slice(cssRules.indexOf(".announcement-bar-inner"), cssRules.indexOf(".announcement-bar-label"));
  assert.match(block, /flex-wrap: wrap/);
  // A code the customer cannot read is not a code.
  assert.doesNotMatch(block, /text-overflow: ellipsis/);
  assert.doesNotMatch(block, /white-space: nowrap/);
  assert.match(cssRules, /@media \(max-width: 480px\)[\s\S]{0,400}\.announcement-bar-cta \{ flex-basis: 100%/);
});

test("the editor previews the real component, not an approximation of it", () => {
  assert.match(sections, /import AnnouncementBar from "@\/components\/AnnouncementBar"/);
  assert.match(sections, /<AnnouncementBar/);
});

test("the preview renders the normalized config, never the raw form", () => {
  /*
   * Caught in browser QA. The preview was handed the working form, so typing
   * `javascript:alert(1)` into the link field rendered a call to action carrying
   * that string as an `href` in the staff member's own document — a URL scheme
   * the application refuses everywhere else.
   *
   * Two things were wrong and one fix addresses both: a preview showing a link
   * the save would reject is previewing something that cannot exist, and a
   * preview has no business putting an unaccepted scheme into the DOM. It now
   * renders what `normalizeAnnouncementConfig` produces, which is what would
   * actually be stored.
   */
  assert.match(sections, /const preview = normalizeAnnouncementConfig\(\{ announcement \}\)/);
  assert.match(sections, /<AnnouncementBar[\s\S]{0,160}config=\{preview\}/);
  assert.doesNotMatch(sections, /config=\{announcement\}/);

  // The property the fix relies on.
  assert.equal(
    normalizeAnnouncementConfig({ announcement: { ctaText: "Shop", ctaHref: "javascript:alert(1)" } }).ctaHref,
    ""
  );
  assert.equal(
    hasAnnouncementCta(normalizeAnnouncementConfig({ announcement: { ctaText: "Shop", ctaHref: "javascript:alert(1)" } })),
    false,
    "half a call to action is no call to action, so nothing renders"
  );
});

// ===========================================================================
// PART F/G/H — navbar language, More menu, count badges
// ===========================================================================

test("the current page is marked with an underline, not a pill", () => {
  const link = cssRules.slice(
    cssRules.indexOf(".site-header-shell .site-nav-primary-link {"),
    cssRules.indexOf(".site-header-shell .site-nav-primary-link:hover")
  );
  assert.match(link, /border-radius: 0/, "the lozenge is gone");

  // The rule itself: a scaled pseudo-element, because a border cannot animate
  // its width and would move every link by a pixel between states.
  const rule = cssRules.slice(cssRules.indexOf(".site-header-shell .site-nav-primary-link::after"));
  // 3px since Custom Project Request 3.0 — 2px was a hairline that dissolved
  // into the navbar background at this text size. The thickness itself is
  // pinned in `custom-project-request-3.test.ts`; what matters here is that
  // pass 4.0's *construction* survived, which the next two lines assert.
  assert.match(rule, /height: 3px/);
  assert.match(rule, /transform: scaleX\(0\)/);
  assert.match(rule, /\.site-nav-primary-link\.is-active::after \{[\s\S]{0,120}transform: scaleX\(1\)/);

  // Hover no longer fills a shape behind the words.
  const hover = cssRules.slice(
    cssRules.indexOf(".site-header-shell .site-nav-primary-link:hover"),
    cssRules.indexOf(".site-header-shell .site-nav-primary-link.is-active")
  );
  assert.doesNotMatch(hover, /background-color: var\(--km-nav-hover-bg/);

  assert.match(cssRules, /prefers-reduced-motion: reduce[\s\S]{0,200}\.site-nav-primary-link::after \{ transition: none/);
});

test("the underline is never the only signal that a link is current", () => {
  // Colour and weight carry it too, and `aria-current` carries it to assistive
  // technology — an underline alone is one cue, and forced-colours mode erases
  // it.
  assert.match(cssRules, /\.site-nav-primary-link\.is-active \{[\s\S]{0,120}font-weight: 600/);
  assert.match(cssRules, /\.site-header-shell \.site-nav-link\.is-active \{ color: var\(--km-nav-active/);
  assert.match(header, /aria-current=\{isNavItemActive\(item, pathname\) \? "page" : undefined\}/);
});

test("Gallery and About are on the bar, and More holds secondary destinations only", () => {
  const headerCode = code(header);
  const more = headerCode.slice(headerCode.indexOf('menuLabel="More destinations"'));
  assert.match(more, /secondaryNav\.map/);
  assert.doesNotMatch(more, /narrowMoreItems|primaryNav/);

  // Nothing in the More menu duplicates a primary destination.
  const secondaryHrefs = secondaryNav.map((item) => item.href);
  for (const item of primaryNav) {
    assert.ok(!secondaryHrefs.includes(item.href), `${item.href} must not appear in both places`);
  }
  for (const expected of ["/projects", "/about"]) {
    assert.ok(primaryNav.some((item) => item.href === expected), `${expected} belongs on the bar`);
  }
});

test("Products keeps its link, its menu and its keyboard behaviour", () => {
  assert.match(header, /<ProductsMenu/);
  assert.match(header, /controlClassName=\{navLinkClass\("\/catalog"\)\}/);
  const menu = read("src/components/nav/ProductsMenu.tsx");
  assert.match(menu, /href="\/catalog"/);
  assert.match(menu, /aria-expanded/);
  assert.match(menu, /Escape/);
});

test("every count bubble hangs from its own control", () => {
  /*
   * The defect: `.site-nav-badge` is absolute, and CartIndicator set no
   * `position`, so the bubble resolved against the sticky <header> and laid
   * itself out against the top-right corner of the whole bar. The other three
   * were correct for three different reasons, one of which was missing.
   *
   * So the containing block is now one named class declared beside the bubble,
   * and this asserts the pair holds everywhere rather than trusting each
   * component to remember.
   */
  assert.match(cssRules, /\.site-nav-count-host \{ position: relative; \}/);

  for (const path of [
    "src/components/commerce/CartIndicator.tsx",
    "src/components/commerce/WishlistIndicator.tsx",
    "src/components/nav/NotificationBell.tsx",
    "src/components/nav/AccountMenu.tsx",
    "src/components/SiteHeader.tsx",
  ]) {
    const source = read(path);
    if (!/site-nav-badge|site-nav-dot/.test(source)) continue;
    assert.match(source, /site-nav-count-host/, `${path} renders a count with nothing to hang it from`);
  }

  // Cart specifically, because it is the one that was wrong.
  const cart = read("src/components/commerce/CartIndicator.tsx");
  assert.match(cart, /site-nav-count-host inline-flex/);
});

test("a three-character count does not resize the control it sits on", () => {
  const badge = cssRules.slice(cssRules.indexOf(".site-nav-badge {"), cssRules.indexOf(".site-nav-badge {") + 400);
  assert.match(badge, /position: absolute/, "the count must not participate in layout");
  assert.match(badge, /min-width: 1\.35rem/, "sized for 99+ so 1, 12 and 99+ share a silhouette");
  assert.match(badge, /right: -0\.25rem/);
  assert.match(badge, /top: -0\.25rem/);
});

// ===========================================================================
// PART I — account information architecture
// ===========================================================================

test("the old customer routes redirect rather than breaking", () => {
  for (const [legacy, canonical] of [
    ["src/app/orders/page.tsx", "/account/orders"],
    ["src/app/notifications/page.tsx", "/account/notifications"],
  ] as const) {
    const source = read(legacy);
    assert.match(source, /permanentRedirect/, `${legacy} must redirect, not 404`);
    assert.match(source, new RegExp(`permanentRedirect\\("${canonical}"\\)`));
  }

  assert.ok(existsSync(new URL("../src/app/account/orders/page.tsx", import.meta.url)));
  assert.ok(existsSync(new URL("../src/app/account/notifications/page.tsx", import.meta.url)));
});

test("individual orders deliberately did not move", () => {
  /*
   * `/orders/[id]` is what confirmation and status emails link to,
   * `/orders/guest/[id]` sits beside it for customers who never made an account,
   * and `/orders/new` is the custom-project entry point. Moving them under
   * `/account` would file a guest's order behind a path claiming an account they
   * do not have, and would invalidate every order link already sent.
   */
  assert.ok(existsSync(new URL("../src/app/orders/[id]/page.tsx", import.meta.url)));
  assert.ok(existsSync(new URL("../src/app/orders/new/page.tsx", import.meta.url)));
  assert.ok(existsSync(new URL("../src/app/orders/guest/[id]/page.tsx", import.meta.url)));
  assert.ok(!existsSync(new URL("../src/app/account/orders/[id]/page.tsx", import.meta.url)));
});

test("every account tab stays inside the account shell", () => {
  /*
   * The whole point of the move. Two of the five tabs used to point outside
   * `/account/layout.tsx`, so using either navigated out of the shell that drew
   * them and the tab strip vanished on arrival.
   */
  for (const item of accountSectionNav) {
    assert.ok(item.href === "/account" || item.href.startsWith("/account/"), `${item.href} leaves the account shell`);
  }
  assert.equal(accountSectionNav.length, 5);

  const layout = read("src/app/account/layout.tsx");
  assert.match(layout, /AccountNav/);
});

test("the account overview does not claim its own children", () => {
  // Without `exact`, /account matches /account/orders and two tabs light up.
  assert.equal(isNavItemActive({ href: "/account", exact: true }, "/account"), true);
  assert.equal(isNavItemActive({ href: "/account", exact: true }, "/account/orders"), false);
  assert.equal(isNavItemActive({ href: "/account/orders" }, "/account/orders"), true);
  assert.equal(isNavItemActive({ href: "/account/notifications" }, "/account/notifications"), true);
  // Children of a non-exact entry still highlight their parent.
  assert.equal(isNavItemActive({ href: "/account/support" }, "/account/support/42"), true);
});

test("no customer navigation still points at the moved routes", () => {
  for (const path of [
    "src/lib/navigation.ts",
    "src/lib/siteSearch.ts",
    "src/components/account/AccountNav.tsx",
  ]) {
    const source = code(read(path));
    assert.doesNotMatch(source, /href: "\/orders"/, `${path} still links at the old order list`);
    assert.doesNotMatch(source, /"\/notifications"/, `${path} still links at the old notifications route`);
  }
});

// ===========================================================================
// PART J — one tab system, three roles
// ===========================================================================

test("section navigation and segmented tabs are different components", () => {
  const sectionNav = read("src/components/ui/SectionNav.tsx");
  const segmented = read("src/components/ui/SegmentedControl.tsx");
  const linkTabs = read("src/components/ui/LinkTabs.tsx");

  /*
   * Not one component with a `variant` prop — that only moves the confusion into
   * a parameter. The rule is what the control *does*: section navigation changes
   * which page you are on and is drawn like the site's header; a segmented
   * control filters the view of the page you are on and stays enclosed.
   */
  assert.match(sectionNav, /ui-section-nav-link/);
  assert.doesNotMatch(sectionNav, /ui-tab\b/);
  assert.match(segmented, /ui-tab/);
  assert.match(segmented, /role="tablist"/);
  assert.match(linkTabs, /ui-tab/);

  // The enclosure is what says "these belong to the thing below them", and the
  // order filters keep it.
  assert.match(cssRules, /\.ui-tabs \{[^}]*border: 1px solid var\(--border\)/);
  // Section navigation has no enclosure and gets an underline instead.
  assert.match(cssRules, /\.ui-section-nav-link\.is-active::after \{[\s\S]{0,120}transform: scaleX\(1\)/);
  assert.match(cssRules, /\.ui-section-nav-link\.is-active \{[^}]*font-weight: 600/);
});

test("the order filters stayed a segmented control", () => {
  const orders = read("src/app/account/orders/page.tsx");
  assert.match(orders, /SegmentedControl/);
  assert.doesNotMatch(orders, /SectionNav/);
});

test("filter chips are still their own thing", () => {
  // Compact and removable, styled as neither of the two above.
  assert.match(cssRules, /\.catalog-chip|\.ui-chip/);
});

// ===========================================================================
// PART K — icons
// ===========================================================================

test("/projects uses the same search icon as the header", () => {
  const projects = read("src/app/projects/ProjectsIndexClient.tsx");
  assert.match(projects, /faMagnifyingGlass/);
  assert.match(projects, /@fortawesome\/free-solid-svg-icons/);
  /*
   * It was the 🔍 emoji, which is not an icon: it renders as whatever glyph the
   * operating system ships — full colour on macOS and Windows, a different angle
   * on Android — at a size and baseline the surrounding text controls rather
   * than the design.
   */
  // Comments stripped: the component explains what it replaced and names the
  // character while doing so, which is exactly what the comment is for.
  assert.doesNotMatch(code(projects), /\u{1F50D}|\u{1F50E}/u, "the emoji must not come back");

  // One source for the glyph across every search field.
  for (const path of [
    "src/components/nav/StorefrontSearch.tsx",
    "src/components/catalog/CommerceSearch.tsx",
    "src/app/account/orders/page.tsx",
  ]) {
    assert.match(read(path), /faMagnifyingGlass/, `${path} should use the canonical icon`);
  }
});

// ===========================================================================
// PART N — accessibility of the new controls
// ===========================================================================

test("the upload control is a real, labelled file input", () => {
  const upload = read("src/app/staff/appearance/LogoUpload.tsx");
  /*
   * A styled div with a hidden input is how an upload control stops being
   * reachable by keyboard. This is an <input type="file"> with a <label
   * htmlFor>, and the drop zone is layered around it as an enhancement —
   * dropping is never the only way to do anything.
   */
  assert.match(upload, /type="file"/);
  assert.match(upload, /htmlFor=\{inputId\}/);
  assert.match(upload, /onDrop=/);
  // Rejections are announced and tied to the input, not just coloured.
  assert.match(upload, /aria-describedby=\{error \? errorId : undefined\}/);
  assert.match(upload, /role="status"/);
  assert.match(upload, /aria-invalid/);
  // Replacement says which it is.
  assert.match(upload, /Replace \$\{label\.toLowerCase\(\)\}/);
});

test("appearance inputs are labelled and their errors are associated", () => {
  assert.match(sections, /aria-describedby=\{error \? errorId : undefined\}/);
  assert.match(sections, /<label htmlFor=\{id\}/);
  // Toggles are real checkboxes, not divs with role="switch" and hand-written
  // key handling.
  assert.match(sections, /type="checkbox"/);
  assert.doesNotMatch(code(sections), /role="switch"/);
});

test("the section list is keyboard navigable and says which section is open", () => {
  assert.match(appearancePage, /aria-label="Appearance sections"/);
  assert.match(appearancePage, /aria-current=\{section === key \? "page" : undefined\}/);
  assert.match(appearancePage, /type="button"/);
});
