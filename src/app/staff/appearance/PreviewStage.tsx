"use client";

import { useEffect, useState } from "react";

import AnnouncementBar from "@/components/AnnouncementBar";
import ProductCard, { type ProductCardProduct } from "@/components/ProductCard";
import { Badge, cx } from "@/components/ui/DesignSystem";
import { primaryNav } from "@/lib/navigation";
import type { AnnouncementConfig } from "@/theme/announcement";
import { normalizeAnnouncementConfig } from "@/theme/announcement";
import type { AppearancePreviewId } from "@/theme/appearanceSections";
import { brandLogoFor, type BrandConfig } from "@/theme/brand";
import { BUTTON_ROLES } from "@/theme/buttonRoles";
import type { ResolvedHero } from "@/theme/homepage";
import type { SiteTheme } from "@/theme/runtime";

/**
 * The preview, rebuilt as a stage rather than a wall.
 *
 * ## What it replaced
 *
 * A permanent third column, roughly 320px wide, carrying nine blocks — a product
 * card, a badge, a CTA, a button row, a card CTA, a form field, status badges, a
 * staff panel and a warning notice — each with a caption naming the tokens
 * behind it. All nine were on screen whatever section you were editing, so
 * tuning the announcement bar meant looking at a staff metric card, and the
 * captions turned the column into a reference sheet you had to read rather than
 * a picture you could glance at.
 *
 * Three things changed.
 *
 * **It is off by default.** The editor's normal state is the whole workspace.
 * Turning the preview on is a decision, and turning it off again is one press.
 *
 * **It shows the section you are editing.** One surface at a time, chosen by the
 * section, so what is on screen is always the thing being changed.
 *
 * **It is horizontal and full width.** A navbar needs about 900px to show its
 * links, its search and its account cluster without clipping — the old column
 * could show a third of it, which made the one section it mattered most for the
 * one it helped least.
 *
 * ## Real components, not approximations
 *
 * The announcement bar and the product card are the production components,
 * handed the working config. The header is built from the storefront's own
 * classes — `site-header-shell`, `site-nav-primary-link`, `site-nav-utility` —
 * because `SiteHeader` itself needs a router, a session and a cart, none of
 * which exist here; using its classes means the underline, the hover treatment,
 * the utility ring and the count bubble are painted by the rules that paint the
 * shop, so a preview cannot be confidently wrong about the exact thing it is
 * previewing.
 */

export type PreviewContext = "desktop" | "mobile" | "grid" | "list";

const CONTEXTS: Partial<Record<AppearancePreviewId, { value: PreviewContext; label: string }[]>> = {
  header: [
    { value: "desktop", label: "Desktop" },
    { value: "mobile", label: "Phone" },
  ],
  homepage: [
    { value: "desktop", label: "Desktop" },
    { value: "mobile", label: "Phone" },
  ],
  productCard: [
    { value: "list", label: "List" },
    { value: "grid", label: "Grid" },
  ],
};

const DEFAULT_CONTEXT: Record<AppearancePreviewId, PreviewContext> = {
  header: "desktop",
  announcement: "desktop",
  homepage: "desktop",
  palette: "desktop",
  type: "desktop",
  controls: "desktop",
  productCard: "list",
  form: "desktop",
};

export type PreviewInput = {
  preview: AppearancePreviewId;
  theme: SiteTheme;
  brand: BrandConfig;
  announcement: AnnouncementConfig;
  hero: ResolvedHero;
  heroImageUrl: string;
  siteName: string;
  primaryColor: string;
};

/**
 * The stage is keyed on `input.preview` by its caller, so changing section
 * remounts it and the context returns to that surface's default.
 *
 * That is the reset — not an effect watching the section. "Phone" means nothing
 * to a product card and "Grid" means nothing to a navbar, so the context has to
 * go back; doing it by remount keeps it a single render rather than a render
 * that shows the wrong control and a second one that corrects it.
 */
export function PreviewStage({ input }: { input: PreviewInput }) {
  const [context, setContext] = useState<PreviewContext>(DEFAULT_CONTEXT[input.preview]);
  const options = CONTEXTS[input.preview];

  return (
    /*
     * No card around the stage.
     *
     * It used to be `.ui-card` wrapping `.ui-preview`, inside the section's own
     * `.ui-card` — three bordered boxes before the preview's *content*, which is
     * frequently a card itself, making four. The stage already draws its own
     * border and its own background, because it has to: it paints the draft
     * theme rather than the staff theme. A second box around it was decoration
     * that only added an outline.
     */
    <div>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <p className="text-[11px] font-semibold uppercase tracking-[.12em] text-brand-textMuted">Preview</p>
        {options ? (
          <div className="ui-tabs !p-1" role="group" aria-label="Preview context">
            {options.map((option) => (
              <button
                key={option.value}
                type="button"
                aria-pressed={context === option.value}
                onClick={() => setContext(option.value)}
                className={cx("ui-tab !py-1 !text-xs", context === option.value && "is-active")}
              >
                {option.label}
              </button>
            ))}
          </div>
        ) : null}
      </div>

      <div className="ui-preview appearance-stage rounded-[var(--control-radius)] border p-3">
        <Surface input={input} context={context} />
      </div>
    </div>
  );
}

function Surface({ input, context }: { input: PreviewInput; context: PreviewContext }) {
  switch (input.preview) {
    case "header":
      return <HeaderPreview input={input} phone={context === "mobile"} />;
    case "announcement":
      return <AnnouncementPreview announcement={input.announcement} />;
    case "homepage":
      return <HomepagePreview input={input} phone={context === "mobile"} />;
    case "productCard":
      return <ProductCardPreview list={context !== "grid"} />;
    case "type":
      return <TypePreview />;
    case "form":
      return <FormPreview />;
    case "palette":
      return <PalettePreview />;
    default:
      return <ControlsPreview theme={input.theme} />;
  }
}

/* ------------------------------------------------------------------------ */

/**
 * The storefront header, at the width it really has.
 *
 * The links come from `primaryNav` so this cannot drift the way the old preview
 * did — it showed `About · Projects · Catalog · Community` for two passes after
 * the navigation had become Products, Custom Projects, Gallery, About and More.
 * The utility cluster is in its real order, the cart carries a count, and the
 * current-page underline is on the first link so the active treatment is
 * visible without having to imagine it.
 */
function HeaderPreview({ input, phone }: { input: PreviewInput; phone: boolean }) {
  const homeSrc = brandLogoFor(input.brand, input.brand.homepageLogo);
  const interiorSrc = brandLogoFor(input.brand, input.brand.interiorLogo);

  if (phone) {
    return (
      <div className="mx-auto w-[22rem] max-w-full space-y-3">
        {[
          { label: "Homepage", src: homeSrc },
          { label: "Every other page", src: interiorSrc },
        ].map((row) => (
          <div key={row.label}>
            <p className="mb-1.5 text-[11px] text-brand-textMuted">{row.label}</p>
            <div className="site-header-shell rounded-[var(--control-radius)] border px-3 py-2">
              <div className="flex items-center justify-between gap-3">
                <span className="flex min-w-0 items-center gap-2">
                  <LogoMark src={row.src} size={7} />
                  {/* The phone header shows the mark alone whatever the toggle
                      says — there is no room for both, and claiming otherwise
                      here would be the preview lying. */}
                </span>
                <span className="flex items-center gap-2">
                  <UtilityDot glyph="⌕" />
                  <UtilityDot glyph="▢" count="3" />
                  <UtilityDot glyph="☰" />
                </span>
              </div>
            </div>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="appearance-stage-wide space-y-3">
      <div>
        {[
          { label: "Homepage", src: homeSrc, active: -1 },
          { label: "Every other page", src: interiorSrc, active: 0 },
        ].map((row) => (
          <div key={row.label} className="mb-3 last:mb-0">
            <p className="mb-1.5 text-[11px] text-brand-textMuted">{row.label}</p>
            <div className="site-header-shell rounded-[var(--control-radius)] border px-3 py-2">
              <div className="flex items-center gap-4">
                <span className="flex flex-none items-center gap-2">
                  <LogoMark src={row.src} size={7} />
                  {input.brand.showBrandName ? (
                    <span className="site-header-wordmark">{input.siteName}</span>
                  ) : null}
                </span>

                <span className="flex items-center gap-1">
                  {primaryNav.map((item, index) => (
                    <span
                      key={item.href}
                      className={cx(
                        "site-nav-link site-nav-primary-link !h-8 whitespace-nowrap text-xs",
                        index === row.active && "is-active"
                      )}
                    >
                      {item.label}
                    </span>
                  ))}
                  <span className="site-nav-link site-nav-primary-link !h-8 text-xs">More</span>
                </span>

                <span className="ml-auto flex flex-none items-center gap-2">
                  <span className="site-nav-utility inline-flex h-8 items-center gap-2 rounded-full border px-3 text-[11px]">
                    ⌕ <span className="text-brand-textMuted">Search</span>
                  </span>
                  <UtilityDot glyph="♥" />
                  <UtilityDot glyph="▢" count="3" />
                  <UtilityDot glyph="◍" />
                </span>
              </div>
            </div>
          </div>
        ))}
      </div>
      <p className="text-[11px] text-brand-textMuted">
        The second bar shows a link on the current page, so the underline, the resting colour and the hover
        treatment can be compared side by side.
      </p>
    </div>
  );
}

function LogoMark({ src, size }: { src: string; size: number }) {
  if (!src) return <span className="text-[11px] text-brand-textMuted">No logo</span>;
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={src} alt="" className="object-contain" style={{ height: `${size * 4}px`, width: `${size * 4}px` }} />
  );
}

function UtilityDot({ glyph, count }: { glyph: string; count?: string }) {
  return (
    <span className="site-nav-count-host site-nav-utility inline-flex h-8 w-8 items-center justify-center rounded-full border text-[11px]">
      {glyph}
      {count ? <span className="site-nav-utility-badge site-nav-badge">{count}</span> : null}
    </span>
  );
}

/* ------------------------------------------------------------------------ */

/**
 * The real bar, handed the *normalized* config rather than the working form.
 *
 * Those are not the same thing while somebody is typing, and the difference
 * matters twice. Previewing a call to action the save would refuse is previewing
 * something that cannot exist — and without the normalizer, typing
 * `javascript:…` into the link field puts that string straight into an `href` in
 * the staff member's own document. It is refused on save either way; a preview
 * has no business rendering a scheme the application does not accept.
 */
function AnnouncementPreview({ announcement }: { announcement: AnnouncementConfig }) {
  const config = normalizeAnnouncementConfig({ announcement });
  if (!config.message) {
    return <p className="ui-empty-state">Add a message to see the bar here.</p>;
  }
  return (
    <div className="appearance-stage-wide">
      {/* `key` forces a remount when the wording changes: the bar hides itself
          when this version has been dismissed, and the version is derived from
          the words — without it, an owner who dismissed the preview would keep
          editing against an empty box. */}
      <AnnouncementBar key={`${config.message}|${config.label}|${config.ctaText}`} config={config} />
    </div>
  );
}

/* ------------------------------------------------------------------------ */

const PREVIEW_PRODUCTS: ProductCardProduct[] = [
  {
    id: "preview-1",
    name: "Billet Shift Knob",
    slug: "billet-shift-knob",
    short_description: "Turned from 6061 aluminium with a knurled grip and an M10 insert.",
    image_url: null,
    category: "Interior",
    starting_price_cents: 8400,
    is_custom: false,
    purchase_mode: "direct_purchase",
    availability_status: "available",
    lead_time_text: "Ships in 3 days",
    inventory_policy: "track",
    inventory_quantity: 12,
    continue_selling_when_out_of_stock: false,
    product_media: null,
  },
  {
    id: "preview-2",
    name: "Subframe Alignment Fixture",
    slug: "subframe-alignment-fixture",
    short_description: "Made to order from your drawing, with extended arms and a hardened bushing set.",
    image_url: null,
    category: "Chassis Tooling",
    starting_price_cents: 129900,
    is_custom: true,
    purchase_mode: "direct_or_request",
    availability_status: "limited",
    lead_time_text: "4–6 weeks",
    inventory_policy: "track",
    inventory_quantity: 1,
    continue_selling_when_out_of_stock: false,
    product_media: null,
  },
];

/**
 * The real `ProductCard`, in the real catalog grid, in both of the real modes.
 *
 * ## Why the attribute goes on `<html>`
 *
 * List and grid are chosen by `data-catalog-density`, which the catalog's
 * pre-paint script stamps on the document element — and the rules are written to
 * treat *no attribute at all* as list, so that a browser with scripting off
 * still gets the canonical default. That is right for the storefront and awkward
 * here: `/staff/appearance` never runs that script, so a wrapper attribute could
 * turn grid on but nothing could turn list's rules off.
 *
 * So the preview stamps the document element while it is mounted and removes it
 * on unmount. The cleanup matters: without it, navigating from here to the
 * catalog would carry a stale layout preference into a page whose own script
 * only runs on a full load.
 */
function ProductCardPreview({ list }: { list: boolean }) {
  useEffect(() => {
    const root = document.documentElement;
    const previous = root.getAttribute("data-catalog-density");
    root.setAttribute("data-catalog-density", list ? "list" : "2");
    return () => {
      if (previous === null) root.removeAttribute("data-catalog-density");
      else root.setAttribute("data-catalog-density", previous);
    };
  }, [list]);

  return (
    <div className="space-y-3">
      <div className="catalog-grid" style={{ ["--catalog-columns" as string]: "2" }}>
        {PREVIEW_PRODUCTS.map((product) => (
          <ProductCard key={product.id} product={product} />
        ))}
      </div>
      <p className="text-[11px] text-brand-textMuted">
        Both cards are the catalog&apos;s own component. The first is in stock and buyable; the second is
        made-to-order, which is why its button and its badges differ.
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------------ */

function HomepagePreview({ input, phone }: { input: PreviewInput; phone: boolean }) {
  return (
    <div className={cx("mx-auto", phone ? "w-[22rem] max-w-full" : "w-full")}>
      <div className={cx("grid gap-4", !phone && "sm:grid-cols-[1.2fr_1fr] sm:items-center")}>
        <div>
          <p className="ui-eyebrow">{input.hero.eyebrow}</p>
          <p className={cx("mt-2 font-semibold leading-tight", phone ? "text-2xl" : "text-3xl")}>
            {input.hero.titleLead}{" "}
            <span style={{ color: "var(--brand-primary)" }}>{input.hero.titleAccent}</span>
          </p>
          <p className="mt-3 text-sm leading-6 text-brand-textMuted">{input.hero.lede}</p>
          <div className="ui-action-row mt-4">
            <span className="ui-btn ui-btn-primary">{input.hero.primary.label}</span>
            <span className="ui-btn ui-btn-secondary">{input.hero.secondary.label}</span>
          </div>
        </div>
        <div
          className="flex aspect-[4/3] items-center justify-center overflow-hidden rounded-[var(--control-radius)] border border-brand-border"
          style={{ background: "var(--km-surface)" }}
        >
          {input.heroImageUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={input.heroImageUrl} alt="" className="h-full w-full object-cover" />
          ) : (
            <span className="p-4 text-center text-[11px] text-brand-textMuted">
              No image uploaded — the hero uses the pinned product&apos;s photograph
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------------ */

function TypePreview() {
  return (
    <div className="space-y-2.5">
      <h2 className="text-2xl font-semibold" style={{ color: "var(--km-heading)" }}>
        Stocked parts, and parts that don&apos;t exist yet
      </h2>
      <h3 className="text-base font-semibold">A section heading</h3>
      <p className="text-sm leading-6">
        Body copy at its reading size. KeyMoura is a small shop making one-off parts, prototypes, fixtures and
        short runs.
      </p>
      <p className="text-xs text-brand-textMuted">Quiet text: help, captions and timestamps.</p>
      <p className="text-lg font-semibold text-brand-primary">$125.00</p>
      <div className="ui-action-row">
        <span className="ui-btn ui-btn-primary">Add to Cart</span>
        <span className="ui-btn ui-btn-secondary">Request a Custom Version</span>
      </div>
    </div>
  );
}

function FormPreview() {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <label className="block">
        <span className="ui-label">Customer notes</span>
        <input className="ui-input" defaultValue="Brushed finish, no logo" readOnly />
        <span className="ui-help">Help text under a field.</span>
      </label>
      <label className="block">
        <span className="ui-label">Finish</span>
        <select className="ui-input" defaultValue="anodised">
          <option value="anodised">Anodised</option>
          <option value="raw">Raw</option>
        </select>
      </label>
      <label className="block sm:col-span-2">
        <span className="ui-label">Quantity</span>
        <input className="ui-input" aria-invalid defaultValue="0" readOnly />
        <span className="mt-1 block text-xs text-rose-300">Enter at least one.</span>
      </label>
    </div>
  );
}

/**
 * The four roles, each captioned with what it is for.
 *
 * It was a row of four buttons with no captions — which shows what the roles
 * *look* like and answers nothing about which is which. An owner comparing
 * "Add to Cart" against "Request a Custom Version" cannot tell from the picture
 * that the first is the role that also draws Check out, Continue and Submit
 * request, and the second is the one that does not.
 *
 * The captions are the first two surfaces from `BUTTON_ROLES`, the same list
 * the Buttons workspace maps in full, so a preview label cannot claim a usage
 * the mapping does not. Two rather than all of them: this is a preview column,
 * and the complete list is one section away.
 */
function ControlsPreview({ theme }: { theme: SiteTheme }) {
  return (
    <div className="space-y-3">
      <div className="grid gap-2 sm:grid-cols-2">
        {BUTTON_ROLES.map((role) => (
          <div key={role.id} className="flex flex-col items-start gap-1">
            <span className={`ui-btn ${role.classNames[0]} pointer-events-none`}>
              {role.surfaces[0]?.label ?? role.label}
            </span>
            <span className="text-[11px] leading-tight text-brand-textMuted">
              <b>{role.label}</b>
              {role.surfaces.length ? (
                <> — {role.surfaces.slice(0, 2).map((surface) => surface.label).join(", ")}</>
              ) : null}
            </span>
          </div>
        ))}
      </div>
      <div className="ui-tabs">
        <span className="ui-tab is-active">All orders</span>
        <span className="ui-tab">In production</span>
        <span className="ui-tab">Delivered</span>
      </div>
      <div className="ui-card !p-3">
        <p className="text-sm font-semibold">A card on the page</p>
        <p className="mt-1 text-xs text-brand-textMuted">
          Corner shape, shadow and border contrast all read here.
        </p>
        <div className="mt-2 flex flex-wrap gap-2">
          <Badge tone="accent">In review</Badge>
          <span className="ui-badge ui-badge-success">In stock</span>
          <span className="ui-badge ui-badge-danger">Sold out</span>
        </div>
      </div>
      <p className="text-[11px] text-brand-textMuted">
        Buttons are <b>{theme.primaryButtonStyle}</b> and <b>{theme.secondaryButtonStyle}</b>; cards are{" "}
        <b>{theme.cardStyle}</b>.
      </p>
    </div>
  );
}

function PalettePreview() {
  return (
    <div className="space-y-3">
      <div className="ui-card !p-3">
        <p className="text-sm font-semibold">A card on the page background</p>
        <p className="mt-1 text-xs text-brand-textMuted">
          Card background, border colour and heading text, over the page background behind them.
        </p>
        <p className="mt-2 text-sm">Body text at its reading colour.</p>
        <p className="mt-2 text-lg font-semibold text-brand-primary">$125.00</p>
      </div>
      <div className="ui-action-row">
        <span className="ui-btn ui-btn-primary">Primary</span>
        <span className="ui-btn ui-btn-secondary">Secondary</span>
      </div>
    </div>
  );
}
