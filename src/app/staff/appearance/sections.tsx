"use client";

import { useId, type ReactNode } from "react";

import { Notice, cx } from "@/components/ui/DesignSystem";
import {
  ANNOUNCEMENT_CTA_MAX,
  ANNOUNCEMENT_LABEL_MAX,
  ANNOUNCEMENT_MESSAGE_MAX,
  isAnnouncementScheduled,
  normalizeAnnouncementHref,
  type AnnouncementConfig,
} from "@/theme/announcement";
import type { BrandConfig, BrandVariant } from "@/theme/brand";
import {
  HERO_CTA_LABEL_MAX,
  HERO_EYEBROW_MAX,
  HERO_LEDE_MAX,
  HERO_TITLE_MAX,
  normalizeHomepageHref,
  SECTION_TOGGLES,
  type HomepageConfig,
} from "@/theme/homepage";

import { ControlGroup } from "./EditorChrome";
import { LogoUpload } from "./LogoUpload";
import { ProductPicker, type PickedProduct } from "./ProductPicker";

/* ------------------------------------------------------------------------ */
/* Small shared controls                                                     */
/* ------------------------------------------------------------------------ */

/**
 * A labelled on/off control.
 *
 * A real `<input type="checkbox">` with a visible `<label>`, not a styled div
 * with `role="switch"`. The div version needs its own key handling, its own
 * focus ring and its own state announcement, and gets at least one of the three
 * wrong; a checkbox arrives with all of it.
 */
export function Toggle({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className="flex items-center gap-2 text-sm font-medium">
        <input
          id={id}
          type="checkbox"
          checked={checked}
          onChange={(event) => onChange(event.target.checked)}
          className="h-4 w-4 accent-[var(--brand-primary)]"
        />
        {label}
      </label>
      {hint ? <p className="mt-1 ml-6 text-xs text-brand-textMuted">{hint}</p> : null}
    </div>
  );
}

/** A short row of mutually exclusive options, for two- and three-way settings. */
export function OptionRow<T extends string>({
  label,
  hint,
  value,
  options,
  onChange,
}: {
  label: string;
  hint?: string;
  value: T;
  options: readonly { value: T; label: string; help?: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <div>
      <p className="ui-label">{label}</p>
      {hint ? <p className="mb-2 text-xs text-brand-textMuted">{hint}</p> : null}
      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            aria-pressed={value === option.value}
            onClick={() => onChange(option.value)}
            className={cx(
              "ui-card ui-card-hover !p-2.5 text-left",
              value === option.value && "!border-brand-primary !bg-brand-primary/10"
            )}
          >
            <span
              className={cx("block text-[13px] font-semibold", value === option.value && "text-brand-primary")}
            >
              {option.label}
            </span>
            {option.help ? (
              <span className="mt-0.5 block text-[11px] leading-4 text-brand-textMuted">{option.help}</span>
            ) : null}
          </button>
        ))}
      </div>
    </div>
  );
}

export function Field({
  label,
  hint,
  value,
  onChange,
  placeholder,
  maxLength,
  type = "text",
  invalid,
  error,
  multiline,
}: {
  label: string;
  hint?: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  maxLength?: number;
  type?: string;
  invalid?: boolean;
  error?: string;
  multiline?: boolean;
}) {
  const id = useId();
  const errorId = `${id}-error`;
  const shared = {
    id,
    value,
    placeholder,
    maxLength,
    "aria-invalid": invalid || undefined,
    "aria-describedby": error ? errorId : undefined,
    className: "ui-input",
  };
  return (
    <label htmlFor={id} className="block">
      <span className="ui-label">{label}</span>
      {multiline ? (
        <textarea {...shared} rows={3} onChange={(event) => onChange(event.target.value)} />
      ) : (
        <input {...shared} type={type} onChange={(event) => onChange(event.target.value)} />
      )}
      {hint ? <span className="mt-1 block text-xs text-brand-textMuted">{hint}</span> : null}
      {/* Validation messages are tied to their input rather than floating near
          it, so a screen reader reaches the reason at the same moment as the
          field it belongs to. */}
      {error ? (
        <span id={errorId} role="status" className="mt-1 block text-xs text-rose-300">
          {error}
        </span>
      ) : null}
    </label>
  );
}

export function Group({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <fieldset className="rounded-[var(--control-radius)] border border-brand-border p-3.5">
      <legend className="px-2 text-sm font-semibold">{title}</legend>
      <p className="mb-3 text-xs text-brand-textMuted">{description}</p>
      <div className="space-y-4">{children}</div>
    </fieldset>
  );
}

/* ------------------------------------------------------------------------ */
/* Brand                                                                     */
/* ------------------------------------------------------------------------ */

/**
 * The two logo slots are named "primary" and "alternate" rather than "colour"
 * and "white" — `theme/brand.ts` records why. The two files this shop owns
 * happen to be a full-colour mark and a white one, but nothing in the code
 * depends on that, and a setting called "White logo" stops being true the first
 * time somebody uploads two colour variants.
 *
 * Where each one is *used*, though, is named after the page rather than the
 * slot: Homepage and Every other page. That is the question an owner has —
 * "keymoura.com shows the colour mark, /catalog shows the white one" — and
 * "slot A / slot B" was the previous answer to it.
 */
const VARIANT_OPTIONS = [
  { value: "primary" as const, label: "Primary logo", help: "The first mark above" },
  { value: "alternate" as const, label: "Alternate logo", help: "The second mark above" },
];

export function BrandSection({
  brand,
  siteName,
  onChange,
  onNotice,
}: {
  brand: BrandConfig;
  siteName: string;
  onChange: (next: BrandConfig) => void;
  onNotice: (message: string) => void;
}) {
  const set = <K extends keyof BrandConfig>(key: K, value: BrandConfig[K]) =>
    onChange({ ...brand, [key]: value });

  const alternateMissing = !brand.alternateLogoUrl;

  return (
    <>
      <ControlGroup
        anchor="brand-primary-logo"
        title="Logo files"
        description="Uploaded to this site and served from it. Nothing needs to be hosted anywhere else."
      >
        <div className="grid gap-3 lg:grid-cols-2">
          <LogoUpload
            slot="primary"
            anchor="brand-primary-logo"
            label="Primary logo"
            description="The mark the header uses unless you choose otherwise below."
            value={brand.primaryLogoUrl}
            onChange={(url) => set("primaryLogoUrl", url)}
            onNotice={onNotice}
          />
          <LogoUpload
            slot="alternate"
            anchor="brand-alternate-logo"
            label="Alternate logo"
            description="A second version — often a white or single-colour mark for darker pages."
            value={brand.alternateLogoUrl}
            onChange={(url) => set("alternateLogoUrl", url)}
            onNotice={onNotice}
          />
        </div>
      </ControlGroup>

      <ControlGroup
        anchor="brand-homepage-logo"
        title="Which logo goes where"
        description="One rule decides the header's logo on every page. The homepage can differ from the rest of the site."
      >
        <OptionRow
          label="Homepage header"
          value={brand.homepageLogo}
          options={VARIANT_OPTIONS}
          onChange={(value) => set("homepageLogo", value as BrandVariant)}
        />
        <div id="appearance-brand-interior-logo" tabIndex={-1} className="scroll-mt-4">
          <OptionRow
            label="Every other page"
            hint="Catalog, product pages, account, checkout."
            value={brand.interiorLogo}
            options={VARIANT_OPTIONS}
            onChange={(value) => set("interiorLogo", value as BrandVariant)}
          />
        </div>
        {/* An empty slot is not an error, but choosing it silently gets you the
            primary mark, and an owner who is not told that will read the
            unchanged header as the setting not working. */}
        {alternateMissing && (brand.homepageLogo === "alternate" || brand.interiorLogo === "alternate") ? (
          <Notice tone="warning">
            No alternate logo is uploaded, so the primary logo is used in both places until you add one.
          </Notice>
        ) : null}
      </ControlGroup>

      <ControlGroup
        anchor="brand-show-name"
        title="Site name in the header"
        description="Whether the words sit beside the mark on wide screens. Phone and tablet headers show the mark alone either way — there is no room for both."
      >
        <Toggle
          label={`Show “${siteName}” beside the logo`}
          hint="Turning this off never removes the site's name for screen readers: the logo link keeps it as its accessible name."
          checked={brand.showBrandName}
          onChange={(value) => set("showBrandName", value)}
        />
      </ControlGroup>
    </>
  );
}

/* ------------------------------------------------------------------------ */
/* Announcement bar                                                          */
/* ------------------------------------------------------------------------ */

const TONE_OPTIONS = [
  { value: "accent" as const, label: "Accent", help: "Your highlight colour — the everyday choice" },
  { value: "brand" as const, label: "Brand", help: "Your primary colour, for a launch" },
  { value: "neutral" as const, label: "Quiet", help: "Grey, for lead times and shipping notes" },
];

export function AnnouncementSection({
  announcement,
  onChange,
}: {
  announcement: AnnouncementConfig;
  onChange: (next: AnnouncementConfig) => void;
}) {
  const set = <K extends keyof AnnouncementConfig>(key: K, value: AnnouncementConfig[K]) =>
    onChange({ ...announcement, [key]: value });

  const hrefTyped = announcement.ctaHref.trim();
  const hrefRejected = Boolean(hrefTyped) && !normalizeAnnouncementHref(hrefTyped);
  const ctaHalf = Boolean(announcement.ctaText) !== Boolean(announcement.ctaHref);
  const scheduleInverted =
    Boolean(announcement.startsAt && announcement.endsAt) &&
    Date.parse(announcement.endsAt) <= Date.parse(announcement.startsAt);
  const outsideWindow = announcement.enabled && !isAnnouncementScheduled(announcement);

  return (
    <>
      <ControlGroup
        anchor="announcement-message"
        title="Message"
        description="One line across the top of every storefront page. Separate from the security notice on the Security page, which is for incidents."
      >
        <div id="appearance-announcement-enabled" tabIndex={-1} className="scroll-mt-4">
          <Toggle
            label="Show the announcement bar"
            checked={announcement.enabled}
            onChange={(value) => set("enabled", value)}
          />
        </div>

        <div className="grid gap-3 lg:grid-cols-[2fr_1fr]">
          <Field
            label="Message"
            hint="Include a discount code directly if you have one — “15% off this weekend — KM15”."
            value={announcement.message}
            maxLength={ANNOUNCEMENT_MESSAGE_MAX}
            placeholder="Launching September 1st"
            onChange={(value) => set("message", value)}
          />
          <div id="appearance-announcement-label" tabIndex={-1} className="scroll-mt-4">
            <Field
              label="Label (optional)"
              hint="A short pill before the message: NEW, SALE."
              value={announcement.label}
              maxLength={ANNOUNCEMENT_LABEL_MAX}
              placeholder="NEW"
              onChange={(value) => set("label", value)}
            />
          </div>
        </div>

        {announcement.enabled && !announcement.message ? (
          <Notice tone="warning">The bar is on but has no message, so nothing will show.</Notice>
        ) : null}
      </ControlGroup>

      <ControlGroup
        anchor="announcement-link"
        title="Link"
        description="An optional call to action at the end of the message. Both parts are needed, or neither shows."
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            label="Link text"
            value={announcement.ctaText}
            maxLength={ANNOUNCEMENT_CTA_MAX}
            placeholder="Shop the sale"
            onChange={(value) => set("ctaText", value)}
          />
          <Field
            label="Link address"
            hint="A path such as /catalog, or a full https:// address."
            value={announcement.ctaHref}
            placeholder="/catalog"
            invalid={hrefRejected}
            error={hrefRejected ? "Use a path starting with / or a full https:// address." : undefined}
            onChange={(value) => set("ctaHref", value)}
          />
        </div>
        {ctaHalf && !hrefRejected ? (
          <Notice tone="warning">
            {announcement.ctaText
              ? "Link text without an address will not show."
              : "A link address without text will not show."}
          </Notice>
        ) : null}
      </ControlGroup>

      <ControlGroup
        anchor="announcement-tone"
        title="Colour"
        description="Three tones, all built from colours you already control. There is no red — an incident notice has its own banner."
      >
        <OptionRow
          label="Tone"
          value={announcement.tone}
          options={TONE_OPTIONS}
          onChange={(value) => set("tone", value)}
        />
      </ControlGroup>

      <ControlGroup
        anchor="announcement-dismissible"
        title="Dismissing"
        description="Whether a customer can close the bar."
      >
        <Toggle
          label="Let customers dismiss it"
          hint="Dismissal is remembered against the wording. Edit the message and everyone sees the new one, including people who closed the old one."
          checked={announcement.dismissible}
          onChange={(value) => set("dismissible", value)}
        />
      </ControlGroup>

      <ControlGroup
        anchor="announcement-schedule"
        title="Schedule (optional)"
        description="Leave both empty to show it until you turn it off. Times are your browser's local time."
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            label="Start"
            type="datetime-local"
            value={toLocalInput(announcement.startsAt)}
            onChange={(value) => set("startsAt", fromLocalInput(value))}
          />
          <Field
            label="End"
            type="datetime-local"
            value={toLocalInput(announcement.endsAt)}
            invalid={scheduleInverted}
            error={scheduleInverted ? "The end time must be after the start time." : undefined}
            onChange={(value) => set("endsAt", fromLocalInput(value))}
          />
        </div>
        {/* A scheduled bar that is enabled but outside its window renders
            nothing, and "I turned it on and nothing happened" is the support
            question that follows if the page does not say so. */}
        {outsideWindow ? (
          <Notice tone="warning">
            This is on, but outside its scheduled window, so it is not showing right now.
          </Notice>
        ) : null}
        <p className="text-xs text-brand-textMuted">
          Storefront pages are cached for a few minutes, so a start or end time can take that long to take
          effect.
        </p>
      </ControlGroup>
    </>
  );
}

/**
 * ISO ↔ the value a `datetime-local` input wants.
 *
 * The input has no timezone, so it is read and written in the browser's local
 * time while storage stays UTC. Doing it by hand rather than slicing the ISO
 * string is what makes "starts at 9am" mean nine in the morning where the owner
 * is, instead of nine UTC.
 */
function toLocalInput(iso: string): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function fromLocalInput(value: string): string {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

/* ------------------------------------------------------------------------ */
/* Homepage                                                                  */
/* ------------------------------------------------------------------------ */

/**
 * The homepage, as a place an owner actually works.
 *
 * ## What this replaced
 *
 * Two product pickers and a paragraph explaining that everything else was
 * hard-coded. That paragraph was honest about the architecture and useless as a
 * control panel: the front page's headline, its buttons, its picture and which
 * bands appeared were all code changes.
 *
 * ## What it does not do
 *
 * It is not a page builder. There is no drag handle, no section library and no
 * reordering — `app/page.tsx` allocates the page's photographs in prominence
 * order, so "move the focus band below the row" is not a reorder, it is a
 * different allocation. A fixed, intentional structure with real configuration
 * inside it is worth more here than a worse version of somebody else's builder.
 *
 * Empty copy fields mean "use the shipped wording", per field. That is why the
 * placeholders show the real defaults rather than invented examples: the
 * placeholder *is* what the page says today.
 */
export function HomepageSection({
  homepage,
  defaults,
  featured,
  hero,
  onChange,
  onPick,
  onNotice,
}: {
  homepage: HomepageConfig;
  /** The shipped hero wording, shown as placeholders. */
  defaults: { eyebrow: string; titleLead: string; titleAccent: string; lede: string; primaryLabel: string; primaryHref: string; secondaryLabel: string; secondaryHref: string };
  featured: PickedProduct | null;
  hero: PickedProduct | null;
  onChange: (next: HomepageConfig) => void;
  onPick: (slot: "featured" | "hero", product: PickedProduct | null) => void;
  onNotice: (message: string) => void;
}) {
  const set = <K extends keyof HomepageConfig>(key: K, value: HomepageConfig[K]) =>
    onChange({ ...homepage, [key]: value });

  const badHref = (value: string) => Boolean(value.trim()) && !normalizeHomepageHref(value);

  return (
    <>
      <ControlGroup
        anchor="homepage-hero-copy"
        title="Headline"
        description="The first thing a visitor reads. Leave a field empty to keep the wording the site ships with — shown as the placeholder."
      >
        <Field
          label="Eyebrow"
          hint="The small line above the headline."
          value={homepage.heroEyebrow}
          maxLength={HERO_EYEBROW_MAX}
          placeholder={defaults.eyebrow}
          onChange={(value) => set("heroEyebrow", value)}
        />
        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            label="Headline"
            hint="The plain half."
            value={homepage.heroTitleLead}
            maxLength={HERO_TITLE_MAX}
            placeholder={defaults.titleLead}
            onChange={(value) => set("heroTitleLead", value)}
          />
          <Field
            label="Headline, in the brand colour"
            hint="The second half, drawn in your primary colour."
            value={homepage.heroTitleAccent}
            maxLength={HERO_TITLE_MAX}
            placeholder={defaults.titleAccent}
            onChange={(value) => set("heroTitleAccent", value)}
          />
        </div>
        <Field
          label="Supporting paragraph"
          multiline
          value={homepage.heroLede}
          maxLength={HERO_LEDE_MAX}
          placeholder={defaults.lede}
          onChange={(value) => set("heroLede", value)}
        />
      </ControlGroup>

      <ControlGroup
        anchor="homepage-hero-ctas"
        title="Buttons"
        description="The two buttons under the headline. A button needs both its words and its destination to be overridden — a label with nowhere to go falls back to the shipped pair."
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            label="Main button"
            value={homepage.heroPrimaryCtaLabel}
            maxLength={HERO_CTA_LABEL_MAX}
            placeholder={defaults.primaryLabel}
            onChange={(value) => set("heroPrimaryCtaLabel", value)}
          />
          <Field
            label="Main button goes to"
            value={homepage.heroPrimaryCtaHref}
            placeholder={defaults.primaryHref}
            invalid={badHref(homepage.heroPrimaryCtaHref)}
            error={badHref(homepage.heroPrimaryCtaHref) ? "Use a path starting with / or a full https:// address." : undefined}
            onChange={(value) => set("heroPrimaryCtaHref", value)}
          />
          <Field
            label="Second button"
            value={homepage.heroSecondaryCtaLabel}
            maxLength={HERO_CTA_LABEL_MAX}
            placeholder={defaults.secondaryLabel}
            onChange={(value) => set("heroSecondaryCtaLabel", value)}
          />
          <Field
            label="Second button goes to"
            value={homepage.heroSecondaryCtaHref}
            placeholder={defaults.secondaryHref}
            invalid={badHref(homepage.heroSecondaryCtaHref)}
            error={badHref(homepage.heroSecondaryCtaHref) ? "Use a path starting with / or a full https:// address." : undefined}
            onChange={(value) => set("heroSecondaryCtaHref", value)}
          />
        </div>
      </ControlGroup>

      <ControlGroup
        anchor="homepage-hero-image"
        title="Hero image"
        description="The picture in the large frame above the fold. Upload one, or leave it empty and the pinned product's photograph is used instead."
      >
        <div className="max-w-md">
          <LogoUpload
            slot="homepage-hero"
            anchor="homepage-hero-image"
            label="Hero image"
            description="Shown at the top of the front page, beside the headline."
            value={homepage.heroImageUrl}
            surfaces={[{ name: "On the page", background: "var(--km-bg)" }]}
            onChange={(url) => set("heroImageUrl", url)}
            onNotice={onNotice}
          />
        </div>
      </ControlGroup>

      <ControlGroup
        anchor="homepage-featured-product"
        title="Featured products"
        description="Which products lead the page. Both fall back to catalog order if the product is unpublished or removed."
      >
        <ProductPicker
          label="Featured build"
          description="The large single product partway down the homepage, with its own heading and description."
          selected={featured}
          onSelect={(product) => {
            onPick("featured", product);
            onChange({ ...homepage, featuredProductId: product?.id ?? "" });
          }}
        />
        <div id="appearance-homepage-hero-product" tabIndex={-1} className="scroll-mt-4">
          <ProductPicker
            label="Hero product"
            description={
              homepage.heroImageUrl
                ? "Currently unused — an uploaded hero image takes the frame. Clear the image above to use a product photograph again."
                : "The large frame at the very top of the homepage. Its photograph is this product's first image."
            }
            selected={hero}
            onSelect={(product) => {
              onPick("hero", product);
              onChange({ ...homepage, heroProductId: product?.id ?? "" });
            }}
          />
        </div>
      </ControlGroup>

      <ControlGroup
        anchor="homepage-sections"
        title="Sections"
        description="Which optional bands appear below the hero. The hero, what we make, the product row, the custom-project band and the closing call to action always show — a homepage without them has stopped making your offer."
      >
        <div className="grid gap-2.5 sm:grid-cols-2">
          {SECTION_TOGGLES.map((toggle) => (
            <div
              key={toggle.id}
              id={`appearance-homepage-section-${toggle.id}`}
              tabIndex={-1}
              className="scroll-mt-4 rounded-[var(--control-radius)] border border-brand-border p-3"
            >
              <Toggle
                label={toggle.label}
                hint={toggle.description}
                checked={homepage.sections[toggle.id] !== false}
                onChange={(value) => set("sections", { ...homepage.sections, [toggle.id]: value })}
              />
            </div>
          ))}
        </div>
      </ControlGroup>
    </>
  );
}
