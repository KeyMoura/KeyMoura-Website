"use client";

import { useId, type ReactNode } from "react";

import AnnouncementBar from "@/components/AnnouncementBar";
import { Badge, Notice, cx } from "@/components/ui/DesignSystem";
import {
  ANNOUNCEMENT_CTA_MAX,
  ANNOUNCEMENT_LABEL_MAX,
  ANNOUNCEMENT_MESSAGE_MAX,
  hasAnnouncementCta,
  isAnnouncementScheduled,
  isExternalAnnouncementHref,
  normalizeAnnouncementConfig,
  normalizeAnnouncementHref,
  type AnnouncementConfig,
} from "@/theme/announcement";
import { brandLogoFor, type BrandConfig, type BrandVariant } from "@/theme/brand";
import type { HomepageConfig } from "@/theme/homepage";

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
      <div className="grid gap-2 sm:grid-cols-2">
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            aria-pressed={value === option.value}
            onClick={() => onChange(option.value)}
            className={cx(
              "ui-card ui-card-hover !p-3 text-left",
              value === option.value && "!border-brand-primary !bg-brand-primary/10"
            )}
          >
            <span
              className={cx("block text-sm font-semibold", value === option.value && "text-brand-primary")}
            >
              {option.label}
            </span>
            {option.help ? (
              <span className="mt-1 block text-xs text-brand-textMuted">{option.help}</span>
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
}) {
  const id = useId();
  const errorId = `${id}-error`;
  return (
    <label htmlFor={id} className="block">
      <span className="ui-label">{label}</span>
      <input
        id={id}
        type={type}
        value={value}
        placeholder={placeholder}
        maxLength={maxLength}
        onChange={(event) => onChange(event.target.value)}
        aria-invalid={invalid || undefined}
        aria-describedby={error ? errorId : undefined}
        className="ui-input"
      />
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
    <fieldset className="rounded-[var(--control-radius)] border border-brand-border p-4">
      <legend className="px-2 text-sm font-semibold">{title}</legend>
      <p className="mb-4 text-xs text-brand-textMuted">{description}</p>
      <div className="space-y-4">{children}</div>
    </fieldset>
  );
}

/* ------------------------------------------------------------------------ */
/* Brand                                                                     */
/* ------------------------------------------------------------------------ */

const VARIANT_OPTIONS = [
  { value: "primary" as const, label: "Primary logo", help: "Slot one" },
  { value: "alternate" as const, label: "Alternate logo", help: "Slot two" },
];

/**
 * The brand section: two logo slots, where each is used, and the wordmark.
 *
 * The slots are named "primary" and "alternate" rather than "colour" and
 * "white". `theme/brand.ts` records why: the two files this shop happens to own
 * are a full-colour mark and a white one, but nothing in the code should depend
 * on that, and a setting called "White logo" stops being true the first time
 * somebody uploads two colour variants.
 */
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
      <Group
        title="Logo files"
        description="Upload the marks this site hosts. Nothing needs to be hosted anywhere else — files are stored with the site's own product images and served from the same place."
      >
        <div className="grid gap-3 lg:grid-cols-2">
          <LogoUpload
            slot="primary"
            label="Primary logo"
            description="The mark the header uses unless you choose otherwise below."
            value={brand.primaryLogoUrl}
            onChange={(url) => set("primaryLogoUrl", url)}
            onNotice={onNotice}
          />
          <LogoUpload
            slot="alternate"
            label="Alternate logo"
            description="A second version — often a white or single-colour mark for darker pages."
            value={brand.alternateLogoUrl}
            onChange={(url) => set("alternateLogoUrl", url)}
            onNotice={onNotice}
          />
        </div>
      </Group>

      <Group
        title="Which logo goes where"
        description="One rule decides the header's logo on every page. The homepage can differ from the rest of the site."
      >
        <OptionRow
          label="Homepage header"
          value={brand.homepageLogo}
          options={VARIANT_OPTIONS}
          onChange={(value) => set("homepageLogo", value as BrandVariant)}
        />
        <OptionRow
          label="Every other page"
          value={brand.interiorLogo}
          options={VARIANT_OPTIONS}
          onChange={(value) => set("interiorLogo", value as BrandVariant)}
        />
        {/* An empty slot is not an error, but choosing it silently gets you the
            primary mark, and an owner who is not told that will read the
            unchanged header as the setting not working. */}
        {alternateMissing && (brand.homepageLogo === "alternate" || brand.interiorLogo === "alternate") ? (
          <Notice tone="warning">
            No alternate logo is uploaded, so the primary logo is used in both places until you add one.
          </Notice>
        ) : null}
      </Group>

      <Group
        title="Site name in the header"
        description="Whether the words sit beside the mark on wide screens. Phone and tablet headers show the mark alone either way — there is no room for both."
      >
        <Toggle
          label={`Show “${siteName}” beside the logo`}
          hint="Turning this off never removes the site's name for screen readers: the logo link keeps it as its accessible name."
          checked={brand.showBrandName}
          onChange={(value) => set("showBrandName", value)}
        />
      </Group>

      <BrandPreview brand={brand} siteName={siteName} />
    </>
  );
}

/**
 * How the header will actually look, on both surfaces and in both routes.
 *
 * Built from the real navbar classes — `site-header-shell`, `site-nav-utility`,
 * `site-nav-primary-link` — rather than an approximation, so the underline, the
 * hover treatment and every navbar colour token are the ones the storefront
 * paints. An approximate preview that diverges is worse than none: it is
 * confidently wrong about the thing the owner came here to check.
 */
function BrandPreview({ brand, siteName }: { brand: BrandConfig; siteName: string }) {
  const rows: { title: string; variant: BrandVariant; note: string }[] = [
    { title: "Homepage", variant: brand.homepageLogo, note: "What a visitor sees first" },
    { title: "Every other page", variant: brand.interiorLogo, note: "Catalog, product, account, checkout" },
  ];

  return (
    <Group
      title="Preview"
      description="The real header markup and the real navbar colours, on the two backgrounds a logo has to survive."
    >
      {rows.map((row) => {
        const src = brandLogoFor(brand, row.variant);
        return (
          <div key={row.title}>
            <p className="text-xs font-semibold">
              {row.title}{" "}
              <span className="font-normal text-brand-textMuted">
                — {row.variant} logo · {row.note}
              </span>
            </p>
            <div className="site-header-shell mt-2 rounded-[var(--control-radius)] border px-3 py-2">
              <div className="flex items-center gap-4">
                <span className="flex items-center gap-2">
                  {src ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={src} alt="" className="h-8 w-8 object-contain" />
                  ) : (
                    <span className="text-[11px] text-brand-textMuted">No logo</span>
                  )}
                  {brand.showBrandName ? (
                    <span className="site-header-wordmark">{siteName}</span>
                  ) : null}
                </span>
                <span className="flex items-center gap-1">
                  {["Products", "Custom Projects", "Gallery"].map((label, index) => (
                    <span
                      key={label}
                      className={cx(
                        "site-nav-link site-nav-primary-link !h-8 text-xs",
                        index === 0 && "is-active"
                      )}
                    >
                      {label}
                    </span>
                  ))}
                </span>
              </div>
            </div>
          </div>
        );
      })}

      {/* The raised surface. A white mark uploaded as the alternate is invisible
          here, and the footer and dialogs use exactly this background. */}
      <div>
        <p className="text-xs font-semibold">
          On a panel <span className="font-normal text-brand-textMuted">— footer and dialogs</span>
        </p>
        <div
          className="mt-2 flex items-center gap-2 rounded-[var(--control-radius)] border border-brand-border p-3"
          style={{ background: "var(--km-surface-strong)" }}
        >
          {brand.primaryLogoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={brand.primaryLogoUrl} alt="" className="h-8 w-8 object-contain" />
          ) : (
            <span className="text-[11px] text-brand-textMuted">No logo</span>
          )}
          <span className="text-sm font-semibold">{siteName}</span>
        </div>
      </div>
    </Group>
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

/**
 * The storefront announcement bar's owner controls.
 *
 * The preview is the *actual component*, handed the working config. That is the
 * point of the split in `theme/announcement.ts`: the bar takes a plain config
 * object and renders it, so the editor can mount the same component the
 * storefront mounts and there is no second implementation to drift.
 */
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

  /*
   * The preview renders the *normalized* config, not the working form.
   *
   * These are not the same thing while somebody is typing, and the difference
   * matters twice. It is a correctness point — a preview showing a call to
   * action that the save would refuse is previewing something that cannot
   * exist — and a safety one: without this, typing `javascript:…` into the link
   * field puts that string straight into an `href` in the staff member's own
   * document. The value is refused on save either way, but a preview has no
   * business rendering a URL scheme the application does not accept.
   */
  const preview = normalizeAnnouncementConfig({ announcement });
  const ctaHalf = Boolean(announcement.ctaText) !== Boolean(announcement.ctaHref);
  const scheduleInverted =
    Boolean(announcement.startsAt && announcement.endsAt) &&
    Date.parse(announcement.endsAt) <= Date.parse(announcement.startsAt);
  const outsideWindow = announcement.enabled && !isAnnouncementScheduled(announcement);

  return (
    <>
      <Group
        title="Message"
        description="One line across the top of every storefront page. This is separate from the security notice on the Security page, which is for incidents."
      >
        <Toggle
          label="Show the announcement bar"
          checked={announcement.enabled}
          onChange={(value) => set("enabled", value)}
        />

        <Field
          label="Message"
          hint="Include a discount code directly if you have one — “15% off this weekend — KM15”."
          value={announcement.message}
          maxLength={ANNOUNCEMENT_MESSAGE_MAX}
          placeholder="Launching September 1st"
          onChange={(value) => set("message", value)}
        />

        <Field
          label="Label (optional)"
          hint="A short pill before the message: NEW, SALE, UPDATE. Leave empty for none."
          value={announcement.label}
          maxLength={ANNOUNCEMENT_LABEL_MAX}
          placeholder="NEW"
          onChange={(value) => set("label", value)}
        />

        {announcement.enabled && !announcement.message ? (
          <Notice tone="warning">The bar is on but has no message, so nothing will show.</Notice>
        ) : null}
      </Group>

      <Group
        title="Link"
        description="An optional call to action at the end of the message. Both parts are needed, or neither shows."
      >
        <Field
          label="Link text"
          value={announcement.ctaText}
          maxLength={ANNOUNCEMENT_CTA_MAX}
          placeholder="Shop the sale"
          onChange={(value) => set("ctaText", value)}
        />
        <Field
          label="Link address"
          hint="A path on this site such as /catalog, or a full https:// address. External links stay in the same tab."
          value={announcement.ctaHref}
          placeholder="/catalog"
          invalid={hrefRejected}
          error={
            hrefRejected
              ? "Use a path starting with / or a full https:// address."
              : undefined
          }
          onChange={(value) => set("ctaHref", value)}
        />
        {ctaHalf && !hrefRejected ? (
          <Notice tone="warning">
            {announcement.ctaText
              ? "Link text without an address will not show."
              : "A link address without text will not show."}
          </Notice>
        ) : null}
      </Group>

      <Group
        title="Dismissing"
        description="Whether a customer can close the bar, and for how long it stays closed."
      >
        <Toggle
          label="Let customers dismiss it"
          hint="Dismissal is remembered against the wording. Edit the message and everyone sees the new one, including people who closed the old one."
          checked={announcement.dismissible}
          onChange={(value) => set("dismissible", value)}
        />
      </Group>

      <Group
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
      </Group>

      <Group
        title="Appearance"
        description="Three tones, all built from colours you already control. There is no red — an incident notice has its own banner."
      >
        <OptionRow
          label="Tone"
          value={announcement.tone}
          options={TONE_OPTIONS}
          onChange={(value) => set("tone", value)}
        />
      </Group>

      <Group
        title="Preview"
        description="The real announcement bar component, exactly as the storefront renders it."
      >
        {preview.message ? (
          <>
            {/*
              `key` forces a remount whenever the wording changes.

              The bar hides itself when the reader has dismissed *this* version,
              and the version is derived from the words. Without the remount an
              owner who dismissed the preview would keep seeing an empty box
              while editing, and would reasonably read that as the message being
              broken.
            */}
            <AnnouncementBar
              key={`${preview.message}|${preview.label}|${preview.ctaText}`}
              config={preview}
            />
            <p className="text-xs text-brand-textMuted">
              {hasAnnouncementCta(preview)
                ? isExternalAnnouncementHref(preview.ctaHref)
                  ? "The link points off this site and will open in the same tab."
                  : "The link points at a page on this site."
                : "No link — the message shows on its own."}
            </p>
          </>
        ) : (
          <p className="ui-empty-state">Add a message above to see it here.</p>
        )}
      </Group>
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
 * Homepage merchandising.
 *
 * Two pins, and an honest statement about why there are only two.
 * `theme/homepage.ts` has the long version: Homepage 3.0 has no standalone image
 * slots at all — every frame on it is a product photograph, falling back to a
 * drawn sheet — so "upload a hero image" is not a setting on this architecture,
 * it is a new asset kind. What the owner can actually control is *which
 * products* fill the two frames that lead the page, and that is what this does.
 */
export function HomepageSection({
  homepage,
  featured,
  hero,
  onChange,
  onPick,
}: {
  homepage: HomepageConfig;
  featured: PickedProduct | null;
  hero: PickedProduct | null;
  onChange: (next: HomepageConfig) => void;
  onPick: (slot: "featured" | "hero", product: PickedProduct | null) => void;
}) {
  return (
    <>
      <Group
        title="Featured products"
        description="The homepage draws its photography from the catalog. These two settings choose which products lead it; everything else fills in from catalog order."
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
        <ProductPicker
          label="Hero image"
          description="The large frame at the very top of the homepage. Its photograph is this product's first image."
          selected={hero}
          onSelect={(product) => {
            onPick("hero", product);
            onChange({ ...homepage, heroProductId: product?.id ?? "" });
          }}
        />
      </Group>

      <Group
        title="Everything else on the homepage"
        description="What this section deliberately does not do."
      >
        <div className="space-y-2 text-sm text-brand-textMuted">
          <p>
            <Badge>From the catalog</Badge> The two capability panels and the three-product row fill
            themselves from published products, skipping whatever the frames above already used.
          </p>
          <p>
            <Badge>From Projects</Badge> The “Made recently” band shows your most recent published project
            write-ups. Edit those under Projects.
          </p>
          <p>
            <Badge>Not configurable yet</Badge> The homepage has no image slots of its own — every picture on
            it is a product or project photograph. Standalone hero artwork would need somewhere new to store
            it and a rule for what happens when it is missing, so it is not offered here rather than half
            offered.
          </p>
        </div>
      </Group>
    </>
  );
}
