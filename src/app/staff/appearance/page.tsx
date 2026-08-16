"use client";

import Image from "next/image";
import { useCallback, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";

import { Badge, MetricCard, Notice, cx } from "@/components/ui/DesignSystem";
import { defaultSiteTheme, optionalVars, type SiteTheme } from "@/theme/runtime";
import { defaultAnnouncementConfig, type AnnouncementConfig } from "@/theme/announcement";
import { defaultBrandConfig, type BrandConfig } from "@/theme/brand";
import { defaultHomepageConfig, type HomepageConfig } from "@/theme/homepage";
import { APPEARANCE_SETTINGS, type AppearanceSetting } from "@/theme/appearanceMap";
import { primaryNav } from "@/lib/navigation";
import { AnnouncementSection, BrandSection, Field, Group, HomepageSection, OptionRow } from "./sections";
import type { PickedProduct } from "./ProductPicker";
import {
  APPEARANCE_TASK_SECTIONS,
  searchAppearanceTasks,
  settingFor,
  taskById,
  type AppearanceTask,
} from "@/theme/appearanceTasks";
import {
  BUILT_IN_PRESETS,
  normalizeAppearanceTemplateConfig,
  normalizeTemplateName,
  TEMPLATE_NAME_MAX,
  templateNameError,
  type AppearanceTemplate,
  type AppearanceTemplateConfig,
} from "@/theme/templates";

type Identity = {
  name: string;
  shortName: string;
  tagline: string;
  description: string;
  publicUrl: string;
  logoUrl: string;
  wordmarkUrl: string;
  footerLogoUrl: string;
  faviconUrl: string;
  appleIconUrl: string;
  supportEmail: string;
  copyrightText: string;
};

type Appearance = {
  primaryColor: string;
  accentColor: string;
  theme: SiteTheme;
  identity: Identity;
  brand: BrandConfig;
  announcement: AnnouncementConfig;
  homepage: HomepageConfig;
};

type Section =
  | "brand"
  | "navigation"
  | "announcement"
  | "homepage"
  | "colors"
  | "components"
  | "business"
  | "templates";

const defaultIdentity: Identity = {
  name: "KeyMoura",
  shortName: "KeyMoura",
  tagline: "Built around your idea.",
  description: "Custom parts, products, and made-to-order projects.",
  publicUrl: "https://keymoura.com",
  logoUrl: "/brand/keymoura-colored.png",
  wordmarkUrl: "",
  footerLogoUrl: "/brand/keymoura-colored.png",
  faviconUrl: "/favicon.ico",
  appleIconUrl: "/apple-icon.png",
  supportEmail: "support@keymoura.com",
  copyrightText: "All rights reserved.",
};

const defaults: Appearance = {
  primaryColor: "#fbbf24",
  accentColor: "#f59e0b",
  theme: defaultSiteTheme,
  identity: defaultIdentity,
  brand: defaultBrandConfig,
  announcement: defaultAnnouncementConfig,
  homepage: defaultHomepageConfig,
};

/**
 * The sections, in the order an owner actually works.
 *
 * ## What this replaced, and why
 *
 * The previous six were Colours, Shapes & density, Business details, Logos &
 * icons, **Labels & wording**, and Saved looks. Two problems.
 *
 * First, the page was organised around *kinds of setting* rather than around
 * anything an owner sets out to do. "Change the announcement bar" and "put the
 * white logo on interior pages" had no home at all, and "make the navbar
 * cleaner" meant finding a navbar shape control filed under Shapes and navbar
 * colours filed under Colours.
 *
 * Second, **Labels & wording did nothing.** Its three controls — Community
 * label, Projects label, Trusted vendor label — wrote to `site_settings.
 * terminology`, which `getSiteSettings()` faithfully read, returned on
 * `RuntimeSiteSettings.terminology`, and which **no component anywhere on the
 * site ever rendered**. Three inputs, a round trip, a saved value, and no
 * observable effect. That is the section the owner called useless, and it was.
 * It is gone from this page and from the runtime settings type; the database
 * column and its contents are untouched, and the installer still writes it, so
 * nothing was destroyed — what was removed is a control that promised an effect
 * it did not have. The full reasoning is in the pass notes.
 *
 * The first four sections below are the things this pass was asked about, in
 * the order somebody sets a shop up. Colours and Components are the older,
 * larger editors, unchanged in substance and moved below the tasks. Business
 * details is the once-at-setup material, which is why it is second to last.
 */
const sectionCopy: Record<Section, { label: string; description: string }> = {
  brand: { label: "Brand", description: "Your logo files, which one each page uses, and whether the site name sits beside it." },
  navigation: { label: "Navigation", description: "The header customers see on every page — its shape, how it behaves, and its colours." },
  announcement: { label: "Announcement bar", description: "The message strip across the top of the storefront: launches, promotions, lead times." },
  homepage: { label: "Homepage", description: "Which products lead the front page." },
  colors: { label: "Colours", description: "Every colour on the site, grouped by what it changes. Search if you know what you are looking for." },
  components: { label: "Buttons & components", description: "Corner rounding, spacing, typography and the shape of buttons, cards, tabs and inputs." },
  business: { label: "Business details", description: "Name, public URL, support address, favicon and the footer's small print." },
  templates: { label: "Saved looks", description: "Save a complete look, try saved looks before publishing, and manage them." },
};

/** Sections whose settings live outside the theme object, for the reset button. */
const IDENTITY_SECTION_KEYS: Partial<Record<Section, readonly (keyof Identity)[]>> = {
  business: ["name", "shortName", "tagline", "description", "publicUrl", "supportEmail", "copyrightText", "faviconUrl", "appleIconUrl", "footerLogoUrl", "wordmarkUrl"],
};

/**
 * The theme keys the Navigation section owns rather than Components.
 *
 * Listed once and used by both the renderer and the reset, so "what Navigation
 * shows" and "what Navigation resets" cannot disagree. The navbar's *colours*
 * are not here — those are partitioned off `APPEARANCE_SETTINGS.group`, which is
 * already the source of truth for which colour belongs where.
 */
const NAVIGATION_SHAPE_KEYS = [
  "publicNavigationStyle",
  "navigationBehavior",
  "navigationDensity",
] as const satisfies readonly (keyof SiteTheme)[];

/** The part of the form a template captures. */
function templateConfigFrom(form: Appearance): AppearanceTemplateConfig {
  return {
    primaryColor: form.primaryColor,
    accentColor: form.accentColor,
    theme: form.theme,
    assets: {
      logoUrl: form.identity.logoUrl,
      wordmarkUrl: form.identity.wordmarkUrl,
      footerLogoUrl: form.identity.footerLogoUrl,
      faviconUrl: form.identity.faviconUrl,
      appleIconUrl: form.identity.appleIconUrl,
    },
  };
}

/** Applies a template to the working form. Publishing stays a separate step. */
function applyTemplateToForm(form: Appearance, config: AppearanceTemplateConfig): Appearance {
  const normalized = normalizeAppearanceTemplateConfig(config);
  return {
    ...form,
    primaryColor: normalized.primaryColor,
    accentColor: normalized.accentColor,
    theme: normalized.theme,
    identity: { ...form.identity, ...normalized.assets },
  };
}

const choiceHelp: Record<string, string> = {
  gradient: "Subtle depth from top to bottom",
  solid: "One flat surface color",
  standard: "Comfortable reading width",
  wide: "More room for dense staff tools",
  compact: "Tighter controls and spacing",
  comfortable: "More breathing room",
  system: "Familiar operating-system type",
  modern: "Clean interface typography",
  technical: "Monospace workshop feel",
  soft: "Low-contrast filled treatment",
  rounded: "Balanced everyday corners",
  pill: "Fully rounded controls",
  outline: "Transparent with a clear border",
  framed: "The layered style used by Account tabs",
  ghost: "Quiet until hovered",
  underline: "Minimal editorial tabs",
  minimal: "Nearly borderless navigation",
  classic: "The original KeyMoura black-pill navbar",
  "auto-hide": "Slides away while scrolling down",
  sticky: "Stays visible while scrolling",
  elevated: "Raised panels with a soft shadow",
  filled: "Stronger filled form controls",
  spotlight: "A subtle brand glow behind the page",
  full: "Use nearly all available screen width",
  none: "Flat surfaces without shadows",
  glow: "A restrained brand-tinted glow",
  subtle: "Quieter borders between surfaces",
  strong: "Higher-contrast borders",
};

function luminance(hex: string) {
  const values = [1, 3, 5]
    .map((index) => Number.parseInt(hex.slice(index, index + 2), 16) / 255)
    .map((value) => value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return 0.2126 * values[0] + 0.7152 * values[1] + 0.0722 * values[2];
}

function contrast(first: string, second: string) {
  const [high, low] = [luminance(first), luminance(second)].sort((left, right) => right - left);
  return (high + 0.05) / (low + 0.05);
}

export default function AppearancePage() {
  const [form, setForm] = useState<Appearance>(defaults);
  const [saved, setSaved] = useState<Appearance>(defaults);
  const [section, setSection] = useState<Section>("brand");
  const [state, setState] = useState("Loading appearance…");
  const [colorQuery, setColorQuery] = useState("");

  /*
   * Names and thumbnails for the two homepage pins, kept beside the form rather
   * than inside it.
   *
   * What gets *saved* is a pair of ids; this is only what those ids are called.
   * Keeping it out of `form` matters because dirtiness is a deep comparison of
   * `form` against `saved` — folding display data in would mark the page dirty
   * the moment a product was renamed somewhere else.
   */
  const [pinned, setPinned] = useState<Record<string, PickedProduct>>({});

  const [templates, setTemplates] = useState<AppearanceTemplate[]>([]);
  const [templatesError, setTemplatesError] = useState("");
  const [templateName, setTemplateName] = useState("");
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<AppearanceTemplate | null>(null);
  const [templateBusy, setTemplateBusy] = useState(false);
  const [templateNotice, setTemplateNotice] = useState("");

  useEffect(() => {
    fetch("/api/staff/appearance")
      .then(async (response) => ({ ok: response.ok, body: await response.json() }))
      .then(({ ok, body }) => {
        if (!ok) throw new Error(body.error);
        // `pinnedProducts` is display data, not settings, so it is lifted out
        // before the rest becomes the form. See the `pinned` state above.
        const { pinnedProducts, ...settings } = body as Record<string, unknown>;
        const loaded = {
          ...defaults,
          ...settings,
          identity: { ...defaultIdentity, ...(settings.identity as object) },
        } as Appearance;
        setForm(loaded);
        setSaved(loaded);
        setPinned((pinnedProducts as Record<string, PickedProduct>) ?? {});
        setState("");
      })
      .catch((error: Error) => setState(error.message || "Could not load appearance."));
  }, []);

  const loadTemplates = useCallback(async () => {
    try {
      const response = await fetch("/api/staff/appearance/templates");
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Could not load templates.");
      setTemplates(body.templates as AppearanceTemplate[]);
      setTemplatesError("");
    } catch (error) {
      setTemplatesError(error instanceof Error ? error.message : "Could not load templates.");
    }
  }, []);

  useEffect(() => {
    void loadTemplates();
  }, [loadTemplates]);

  const savedNameConflict = templateNameError(templateName, templates.map((template) => template.name));
  const canSaveTemplate = Boolean(normalizeTemplateName(templateName)) && !savedNameConflict && !templateBusy;

  async function templateRequest(input: RequestInfo, init: RequestInit, success: string) {
    setTemplateBusy(true);
    setTemplateNotice("");
    try {
      const response = await fetch(input, init);
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || "That did not work.");
      await loadTemplates();
      setTemplateNotice(success);
      return true;
    } catch (error) {
      setTemplateNotice(error instanceof Error ? error.message : "That did not work.");
      return false;
    } finally {
      setTemplateBusy(false);
    }
  }

  const saveTemplate = async () => {
    const name = normalizeTemplateName(templateName);
    const ok = await templateRequest(
      "/api/staff/appearance/templates",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, config: templateConfigFrom(form) }),
      },
      `Saved “${name}”.`
    );
    if (ok) setTemplateName("");
  };

  const renameTemplate = async () => {
    if (!renaming) return;
    const name = normalizeTemplateName(renaming.name);
    const ok = await templateRequest(
      `/api/staff/appearance/templates/${renaming.id}`,
      { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) },
      `Renamed to “${name}”.`
    );
    if (ok) setRenaming(null);
  };

  const deleteTemplate = async () => {
    if (!confirmDelete) return;
    const ok = await templateRequest(
      `/api/staff/appearance/templates/${confirmDelete.id}`,
      { method: "DELETE" },
      `Deleted “${confirmDelete.name}”.`
    );
    if (ok) setConfirmDelete(null);
  };

  // Applying only edits the working form. Publishing stays a deliberate,
  // separate action on the bar at the bottom of the page.
  const applyTemplate = (name: string, config: AppearanceTemplateConfig) => {
    setForm((current) => applyTemplateToForm(current, config));
    setTemplateNotice(`Applied “${name}” to the preview. Publish to make it live.`);
  };

  const dirty = JSON.stringify(form) !== JSON.stringify(saved);
  const warning = useMemo(() => {
    if (contrast(form.theme.text, form.theme.background) < 4.5) return "Body text needs more contrast against the background.";
    if (contrast(form.theme.headingText, form.theme.background) < 4.5) return "Heading text needs more contrast against the background.";
    if (contrast(form.theme.mutedText, form.theme.background) < 3) return "Muted text needs more contrast against the background.";
    if (contrast(form.theme.navigationText, form.theme.navigationBackground) < 4.5) return "Navbar text needs more contrast against the navbar background.";
    if (contrast(form.theme.navigationActiveText, form.theme.navigationBackground) < 3) return "The active navbar link needs more contrast against the navbar background.";
    if (contrast(form.theme.navigationHoverText, form.theme.navigationHoverBackground) < 4.5) return "Navbar hover text needs more contrast against the hover background.";
    // A count badge carries 10px bold text. It is small, so it is held to the
    // normal-text ratio rather than the large-text one.
    if (contrast(form.theme.navigationBadgeText, form.theme.navigationBadgeBackground) < 4.5) return "Badge text needs more contrast against the badge background — cart and wishlist counts are 10px.";
    if (contrast(form.theme.navigationMobileText, form.theme.navigationMobileBackground) < 4.5) return "Menu text needs more contrast against the menu background.";
    // The brand colors are not only fills: eyebrows, prices, section links, and
    // in-content links are drawn in them directly on the page background.
    if (contrast(form.primaryColor, form.theme.background) < 4.5) return "The primary color needs more contrast against the page background — it is also used for small text like prices and section links.";
    if (contrast(form.theme.linkText, form.theme.background) < 4.5) return "Link text needs more contrast against the page background.";
    /*
     * Validate against the fill that actually renders, not the brand colour.
     *
     * These used to compare the label with `primaryColor` / `accentColor`. Once
     * the buttons gained their own optional backgrounds that stopped being the
     * same thing: a dark blue Primary button background with the default
     * near-black label passed the check — because the *unrelated* brand gold
     * had plenty of contrast — and published an unreadable Buy now, Checkout
     * and every staff primary action.
     *
     * On the non-solid shapes the label follows the brand colour and sits on
     * the page rather than on a fill, which is what the pair below compares.
     */
    const primaryFill = form.theme.primaryButtonBackground || form.primaryColor;
    const secondaryFill = form.theme.secondaryButtonBackground || form.accentColor;
    if (form.theme.primaryButtonStyle === "solid" && contrast(form.theme.primaryButtonText, primaryFill) < 4.5) return "Primary button text needs more contrast against the primary button background.";
    if (form.theme.primaryButtonStyle !== "solid" && form.theme.primaryButtonBackground && contrast(form.primaryColor, primaryFill) < 4.5) return "The primary brand colour needs more contrast against the primary button background — the Soft, Outline and Framed shapes draw the label in it.";
    if (form.theme.secondaryButtonStyle === "solid" && contrast(form.theme.secondaryButtonText, secondaryFill) < 4.5) return "Secondary button text needs more contrast against the secondary button background.";
    return "";
  }, [form]);

  const variables = {
    "--brand-primary": form.primaryColor,
    "--brand-accent": form.accentColor,
    "--km-bg": form.theme.background,
    "--km-bg-end": form.theme.backgroundEnd,
    "--km-surface": form.theme.surface,
    "--km-surface-strong": form.theme.surfaceStrong,
    "--km-text": form.theme.text,
    "--km-muted": form.theme.mutedText,
    "--km-heading": form.theme.headingText,
    "--km-link": form.theme.linkText,
    "--km-border": form.theme.border,
    "--km-primary-button-text": form.theme.primaryButtonText,
    "--km-secondary-button-text": form.theme.secondaryButtonText,
    "--km-nav-bg": form.theme.navigationBackground,
    "--km-nav-text": form.theme.navigationText,
    "--km-nav-active": form.theme.navigationActiveText,
    "--km-nav-border": form.theme.navigationBorder,
    "--km-nav-util-bg": form.theme.navigationUtilityBackground,
    "--km-nav-util-border": form.theme.navigationUtilityBorder,
    "--km-nav-util-text": form.theme.navigationUtilityText,
    "--km-nav-util-hover-bg": form.theme.navigationUtilityHoverBackground,
    "--km-nav-util-hover-border": form.theme.navigationUtilityHoverBorder,
    "--km-nav-util-hover-text": form.theme.navigationUtilityHoverText,
    "--km-nav-hover-bg": form.theme.navigationHoverBackground,
    "--km-nav-hover-text": form.theme.navigationHoverText,
    "--km-nav-badge-bg": form.theme.navigationBadgeBackground,
    "--km-nav-badge-text": form.theme.navigationBadgeText,
    "--km-nav-mobile-bg": form.theme.navigationMobileBackground,
    "--km-nav-mobile-text": form.theme.navigationMobileText,
    // Same helper the root layout uses. An unset override must be *absent*
    // here too, or the preview would render a colourless badge for a setting
    // that follows the accent correctly on the live site.
    ...optionalVars({
      "--km-badge-bg": form.theme.badgeBackground,
      "--km-badge-text": form.theme.badgeText,
      "--km-badge-border": form.theme.badgeBorder,
      "--km-secondary-button-bg": form.theme.secondaryButtonBackground,
      "--km-secondary-button-border": form.theme.secondaryButtonBorder,
      "--km-primary-button-bg": form.theme.primaryButtonBackground,
      "--km-primary-button-border": form.theme.primaryButtonBorder,
    }),
  } as CSSProperties;

  const setTheme = <Key extends keyof SiteTheme>(key: Key, value: SiteTheme[Key]) =>
    setForm((current) => ({ ...current, theme: { ...current.theme, [key]: value } }));
  const setIdentity = (key: keyof Identity, value: string) =>
    setForm((current) => ({ ...current, identity: { ...current.identity, [key]: value } }));

  /** Writes one colour, wherever on the form that colour actually lives. */
  const applyColor = (setting: AppearanceSetting, value: string) => {
    if (setting.key === "primaryColor") setForm((current) => ({ ...current, primaryColor: value }));
    else if (setting.key === "accentColor") setForm((current) => ({ ...current, accentColor: value }));
    else setTheme(setting.key as keyof SiteTheme, value as never);
  };

  /**
   * Reset only what the open section edits.
   *
   * "Reset" here means "back to what is published", not "back to the factory
   * palette" — the owner pressing it has made a mess of one thing and wants that
   * one thing undone, and a button that also reverted the four other sections
   * they had just finished would be the worst possible reading of the word.
   *
   * The colour-bearing branches are derived from `APPEARANCE_SETTINGS` rather
   * than a hand-written key list. An earlier version listed 19 navbar keys by
   * hand beside a section that reset the whole theme, so a colour added to one
   * list and not the other would silently survive a reset.
   */
  const resetSection = () => setForm((current) => {
    if (section === "templates") return current;

    // The three branches whose settings are a self-contained object.
    if (section === "brand") return { ...current, brand: saved.brand };
    if (section === "announcement") return { ...current, announcement: saved.announcement };
    if (section === "homepage") return { ...current, homepage: saved.homepage };

    if (section === "colors" || section === "navigation") {
      // Colours owns every group except the navbar's; Navigation owns exactly
      // the navbar's. The partition is read off the same map both sections
      // render from, so neither can drift from what it displays.
      const wantsNav = section === "navigation";
      const next = { ...current, theme: { ...current.theme } };
      for (const setting of APPEARANCE_SETTINGS) {
        const isNav = setting.group === "navbar" || setting.group === "navbarMenus";
        if (isNav !== wantsNav) continue;
        if (setting.key === "primaryColor") next.primaryColor = saved.primaryColor;
        else if (setting.key === "accentColor") next.accentColor = saved.accentColor;
        else {
          const key = setting.key as keyof SiteTheme;
          (next.theme as Record<string, unknown>)[key] = saved.theme[key];
        }
      }
      if (wantsNav) {
        for (const key of NAVIGATION_SHAPE_KEYS) {
          (next.theme as Record<string, unknown>)[key] = saved.theme[key];
        }
      }
      return next;
    }

    if (section === "components") {
      // Everything on the theme that is neither a colour nor a navbar shape:
      // the remaining choice-valued keys.
      const colorKeys = new Set<string>(APPEARANCE_SETTINGS.map((setting) => setting.key));
      const next = { ...current, theme: { ...current.theme } };
      for (const key of Object.keys(saved.theme) as (keyof SiteTheme)[]) {
        if (colorKeys.has(key) || (NAVIGATION_SHAPE_KEYS as readonly string[]).includes(key)) continue;
        (next.theme as Record<string, unknown>)[key] = saved.theme[key];
      }
      return next;
    }

    const keys = IDENTITY_SECTION_KEYS[section] ?? [];
    return { ...current, identity: { ...current.identity, ...Object.fromEntries(keys.map((key) => [key, saved.identity[key]])) } };
  });

  async function save() {
    setState("Publishing appearance…");
    const response = await fetch("/api/staff/appearance", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(form),
    });
    const body = await response.json();
    if (response.ok) {
      setSaved(form);
      setState("Appearance published.");
    } else {
      setState(body.error || "Could not save.");
    }
  }

  return (
    <main
      className="page-stack pb-24"
      style={variables}
      data-theme-scope="true"
      data-radius={form.theme.radius}
      data-density={form.theme.density}
      data-font={form.theme.font}
      data-primary-button-style={form.theme.primaryButtonStyle}
      data-secondary-button-style={form.theme.secondaryButtonStyle}
      data-tab-style={form.theme.tabStyle}
      data-card-style={form.theme.cardStyle}
      data-input-style={form.theme.inputStyle}
      data-navigation-style={form.theme.navigationStyle}
      data-public-navigation-style={form.theme.publicNavigationStyle}
      data-navigation-density={form.theme.navigationDensity}
      data-background-style={form.theme.backgroundStyle}
      data-content-width={form.theme.contentWidth}
      data-shadow-style={form.theme.shadowStyle}
      data-border-strength={form.theme.borderStrength}
    >
      <header>
        <p className="ui-eyebrow">Site design & identity</p>
        <h1 className="mt-1 text-3xl font-semibold">Appearance</h1>
        <p className="mt-2 max-w-3xl text-sm text-brand-textMuted">Choose one shared system for every customer and staff screen. Preview real components before publishing.</p>
      </header>

      {state ? <Notice role="status">{state}</Notice> : null}
      {warning ? <Notice tone="warning">{warning}</Notice> : null}

      {/*
        Three columns on a wide screen, one on anything narrower.

        The section list is a `<nav>` of buttons rather than a scroll-spy or a
        tab strip. The page is eight distinct editors, several of which are long,
        and the thing the owner needs is to *leave* one and arrive at another —
        which is a jump, not a scroll. On a laptop the whole list is visible
        without moving, so "where is the announcement bar" is answered by looking
        rather than by hunting.

        Below `xl` the columns stack: the list, then the editor, then the
        preview. Nothing is hidden at any width and nothing overflows
        horizontally — the preview column is `minmax(320px, …)` on wide screens
        only, so it cannot force a horizontal scrollbar on a laptop.
      */}
      <div className="grid gap-5 xl:grid-cols-[230px_minmax(0,1fr)_minmax(320px,.7fr)]">
        <nav className="ui-card h-fit space-y-2 xl:sticky xl:top-5" aria-label="Appearance sections">
          {(Object.keys(sectionCopy) as Section[]).map((key) => (
            <button
              key={key}
              type="button"
              onClick={() => setSection(key)}
              aria-current={section === key ? "page" : undefined}
              className={cx("ui-btn w-full !justify-start text-left", section === key ? "ui-btn-primary" : "ui-btn-ghost")}
            >
              <span><span className="block font-semibold">{sectionCopy[key].label}</span><span className="mt-1 block text-xs font-normal opacity-75">{sectionCopy[key].description}</span></span>
            </button>
          ))}
        </nav>

        <div className="space-y-5">
          <section className="ui-card space-y-5">
            <SectionTitle title={sectionCopy[section].label} text={sectionCopy[section].description} />

            {section === "brand" ? (
              <BrandSection
                brand={form.brand}
                siteName={form.identity.name}
                onChange={(brand) => setForm((current) => ({ ...current, brand }))}
                onNotice={setState}
              />
            ) : null}

            {section === "announcement" ? (
              <AnnouncementSection
                announcement={form.announcement}
                onChange={(announcement) => setForm((current) => ({ ...current, announcement }))}
              />
            ) : null}

            {section === "homepage" ? (
              <HomepageSection
                homepage={form.homepage}
                featured={pinned[form.homepage.featuredProductId] ?? null}
                hero={pinned[form.homepage.heroProductId] ?? null}
                onChange={(homepage) => setForm((current) => ({ ...current, homepage }))}
                onPick={(_slot, product) => {
                  // The picker returns the display data alongside the id, so a
                  // freshly chosen product renders immediately instead of
                  // waiting for a reload to learn its own name.
                  if (product) setPinned((current) => ({ ...current, [product.id]: product }));
                }}
              />
            ) : null}

            {section === "navigation" ? (
              <>
                <Group
                  title="Header shape and behaviour"
                  description="Storefront only. None of these touch the staff sidebar, which is under Buttons & components."
                >
                  <OptionRow
                    label="Current page marker"
                    hint="How the header shows which section a customer is in."
                    value={form.theme.publicNavigationStyle}
                    options={[
                      { value: "underline" as const, label: "Underline", help: "A rule under the current link. The KeyMoura default." },
                      { value: "framed" as const, label: "Enclosed", help: "Each link in its own outline, like tabs" },
                      { value: "minimal" as const, label: "Minimal", help: "Colour and weight only, no rule" },
                    ]}
                    onChange={(value) => setTheme("publicNavigationStyle", value)}
                  />
                  <OptionRow
                    label="When scrolling"
                    value={form.theme.navigationBehavior}
                    options={[
                      { value: "auto-hide" as const, label: "Slide away", help: "Hides going down, returns going up" },
                      { value: "sticky" as const, label: "Always visible", help: "Stays put the whole way down" },
                    ]}
                    onChange={(value) => setTheme("navigationBehavior", value)}
                  />
                  <OptionRow
                    label="Header height"
                    value={form.theme.navigationDensity}
                    options={[
                      { value: "compact" as const, label: "Compact", help: "60px" },
                      { value: "comfortable" as const, label: "Comfortable", help: "68px" },
                    ]}
                    onChange={(value) => setTheme("navigationDensity", value)}
                  />
                  <NavbarPreview form={form} />
                </Group>

                {/*
                  The navbar's colours live here rather than under Colours.
                  Every other colour on the site is site-wide; these thirteen
                  are the only ones that belong to a single component, and
                  splitting "make the header darker" across two sections is
                  what sent people hunting. `ColorSection` excludes the same
                  group, so each colour still has exactly one control.
                */}
                <ColorSection
                  form={form}
                  query={colorQuery}
                  onQueryChange={setColorQuery}
                  only="navigation"
                  onChange={applyColor}
                />
              </>
            ) : null}

            {section === "business" ? (
              <>
                <Group title="Business details" description="Used in page titles, search results, and the footer's small print.">
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field label="Site name" value={form.identity.name} onChange={(value) => setIdentity("name", value)} />
                    <Field label="Short name" hint="Used where space is tight." value={form.identity.shortName} onChange={(value) => setIdentity("shortName", value)} />
                    <Field label="Tagline" value={form.identity.tagline} onChange={(value) => setIdentity("tagline", value)} />
                    <Field label="Public site URL" value={form.identity.publicUrl} onChange={(value) => setIdentity("publicUrl", value)} />
                    <Field label="Support email" value={form.identity.supportEmail} onChange={(value) => setIdentity("supportEmail", value)} />
                    <Field label="Copyright text" value={form.identity.copyrightText} onChange={(value) => setIdentity("copyrightText", value)} />
                  </div>
                  <Field label="Search-engine description" hint="One or two sentences, shown under your name in search results." value={form.identity.description} onChange={(value) => setIdentity("description", value)} />
                </Group>

                {/*
                  These four kept their URL fields on purpose. A favicon and an
                  Apple touch icon are build-time files with fixed names that the
                  browser fetches directly, not brand marks the header composes,
                  and the footer logo and wordmark are set once and rarely
                  changed. Putting them behind the same upload flow as the header
                  logo would imply the site manages a favicon it does not.
                */}
                <Group title="Icons and secondary artwork" description="Set once during setup. The header's logo is under Brand.">
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field label="Footer logo" value={form.identity.footerLogoUrl} onChange={(value) => setIdentity("footerLogoUrl", value)} />
                    <Field label="Wordmark image (optional)" hint="Replaces the site name text beside the header logo." value={form.identity.wordmarkUrl} onChange={(value) => setIdentity("wordmarkUrl", value)} />
                    <Field label="Browser favicon" value={form.identity.faviconUrl} onChange={(value) => setIdentity("faviconUrl", value)} />
                    <Field label="Apple / mobile icon" value={form.identity.appleIconUrl} onChange={(value) => setIdentity("appleIconUrl", value)} />
                  </div>
                </Group>
              </>
            ) : null}

            {section === "colors" ? (
              <ColorSection
                form={form}
                query={colorQuery}
                onQueryChange={setColorQuery}
                only="site"
                onChange={applyColor}
              />
            ) : null}

            {section === "templates" ? <>
              {templatesError ? <Notice tone="danger" role="alert">{templatesError}</Notice> : null}
              {templateNotice ? <Notice role="status">{templateNotice}</Notice> : null}

              <AppearanceGroup title="Save the current look" description="Captures the brand colors, every component and navbar setting, and the brand artwork. Business details and labels are not included, so applying a template never renames the site.">
                <div className="flex flex-wrap items-end gap-3">
                  <label className="min-w-56 flex-1">
                    <span className="ui-label">Template name</span>
                    <input
                      value={templateName}
                      onChange={(event) => setTemplateName(event.target.value)}
                      maxLength={TEMPLATE_NAME_MAX}
                      placeholder="Winter storefront"
                      aria-invalid={Boolean(templateName && savedNameConflict)}
                      aria-describedby={templateName && savedNameConflict ? "template-name-error" : undefined}
                      className="ui-input"
                    />
                  </label>
                  <button type="button" onClick={() => void saveTemplate()} disabled={!canSaveTemplate} className="ui-btn ui-btn-primary disabled:opacity-50">
                    Save as template
                  </button>
                </div>
                {templateName && savedNameConflict ? <p id="template-name-error" className="text-xs text-rose-300">{savedNameConflict}</p> : null}
              </AppearanceGroup>

              <AppearanceGroup title="Built-in presets" description="Shipped with the site. They can be applied but not renamed or deleted.">
                <div className="grid gap-3 sm:grid-cols-3">
                  {Object.entries(BUILT_IN_PRESETS).map(([name, preset]) => (
                    <div key={name} className="ui-card">
                      <TemplateSwatch primary={preset.primaryColor} accent={preset.accentColor} />
                      <p className="mt-3 flex items-center gap-2 text-sm font-semibold">{name}<Badge>Built in</Badge></p>
                      <button type="button" onClick={() => applyTemplate(name, preset)} className="ui-btn ui-btn-secondary mt-3 w-full !py-1.5 text-xs">
                        Apply to preview
                      </button>
                    </div>
                  ))}
                </div>
              </AppearanceGroup>

              <AppearanceGroup title="Your templates" description="Applying loads a template into the editor so you can preview it. Nothing goes live until you publish.">
                {templates.length === 0 ? (
                  <p className="ui-empty-state">No saved templates yet. Set up a look above, then save it here.</p>
                ) : (
                  <ul className="grid gap-3 sm:grid-cols-2">
                    {templates.map((template) => (
                      <li key={template.id} className="ui-card">
                        {renaming?.id === template.id ? (
                          <div className="space-y-2">
                            <label className="block">
                              <span className="ui-label">Rename template</span>
                              <input
                                autoFocus
                                value={renaming.name}
                                maxLength={TEMPLATE_NAME_MAX}
                                onChange={(event) => setRenaming({ id: template.id, name: event.target.value })}
                                onKeyDown={(event) => { if (event.key === "Escape") setRenaming(null); }}
                                className="ui-input"
                              />
                            </label>
                            <div className="ui-action-row">
                              <button
                                type="button"
                                onClick={() => void renameTemplate()}
                                disabled={templateBusy || Boolean(templateNameError(renaming.name, templates.filter((other) => other.id !== template.id).map((other) => other.name)))}
                                className="ui-btn ui-btn-primary !py-1.5 text-xs disabled:opacity-50"
                              >
                                Save name
                              </button>
                              <button type="button" onClick={() => setRenaming(null)} className="ui-btn ui-btn-ghost !py-1.5 text-xs">Cancel</button>
                            </div>
                          </div>
                        ) : (
                          <>
                            <TemplateSwatch primary={template.primaryColor} accent={template.accentColor} />
                            <p className="mt-3 text-sm font-semibold">{template.name}</p>
                            {template.updatedAt ? <p className="mt-1 text-xs text-brand-textMuted">Updated {new Date(template.updatedAt).toLocaleDateString()}</p> : null}
                            <div className="ui-action-row mt-3">
                              <button type="button" onClick={() => applyTemplate(template.name, template)} className="ui-btn ui-btn-secondary !py-1.5 text-xs">Apply to preview</button>
                              <button type="button" onClick={() => setRenaming({ id: template.id, name: template.name })} className="ui-btn ui-btn-ghost !py-1.5 text-xs">Rename</button>
                              <button type="button" onClick={() => setConfirmDelete(template)} className="ui-btn ui-btn-danger !py-1.5 text-xs">Delete</button>
                            </div>
                          </>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </AppearanceGroup>
            </> : null}

            {section === "components" ? <>
              <AppearanceGroup title="Starting point" description="Apply a coordinated palette, then tune anything below. Save your own under Saved looks.">
                <div className="grid gap-3 sm:grid-cols-3">{Object.entries(BUILT_IN_PRESETS).map(([name, preset]) => <button key={name} type="button" onClick={() => applyTemplate(name, preset)} className="ui-card ui-card-hover text-left"><TemplateSwatch primary={preset.primaryColor} accent={preset.accentColor} /><span className="mt-3 block text-sm font-semibold">{name}</span><span className="mt-1 block text-xs text-brand-textMuted">Apply palette</span></button>)}</div>
              </AppearanceGroup>

              <AppearanceGroup title="Layout & type" description="Storefront and staff. Sets the overall density and silhouette used everywhere.">
                <Choice label="Page background" value={form.theme.backgroundStyle} values={["gradient", "solid", "spotlight"]} onChange={(value) => setTheme("backgroundStyle", value as SiteTheme["backgroundStyle"])} />
                <Choice label="Content width" value={form.theme.contentWidth} values={["standard", "wide", "full"]} onChange={(value) => setTheme("contentWidth", value as SiteTheme["contentWidth"])} />
                <Choice label="Spacing" value={form.theme.density} values={["compact", "comfortable"]} onChange={(value) => setTheme("density", value as SiteTheme["density"])} />
                <Choice label="Typography" value={form.theme.font} values={["system", "modern", "technical"]} onChange={(value) => setTheme("font", value as SiteTheme["font"])} />
                <Choice label="Corner shape" value={form.theme.radius} values={["soft", "rounded", "pill"]} onChange={(value) => setTheme("radius", value as SiteTheme["radius"])} />
              </AppearanceGroup>

              <AppearanceGroup title="Control shapes" description="Storefront and staff. The shape of each control; its colours are under Colours.">
                <Choice label="Primary buttons" value={form.theme.primaryButtonStyle} values={["solid", "soft", "outline", "framed"]} onChange={(value) => setTheme("primaryButtonStyle", value as SiteTheme["primaryButtonStyle"])} />
                <Choice label="Secondary buttons" value={form.theme.secondaryButtonStyle} values={["solid", "soft", "outline", "ghost", "framed"]} onChange={(value) => setTheme("secondaryButtonStyle", value as SiteTheme["secondaryButtonStyle"])} />
                {/* This is the *segmented* tab control — the order filters, the
                    staff view switchers. Primary section navigation is not
                    themed here: it follows the storefront header's language by
                    design, so that moving between areas of the site looks the
                    same wherever you do it. See `SectionNav`. */}
                <Choice label="Segmented tabs" value={form.theme.tabStyle} values={["soft", "framed", "underline"]} onChange={(value) => setTheme("tabStyle", value as SiteTheme["tabStyle"])} />
                <Choice label="Cards & panels" value={form.theme.cardStyle} values={["soft", "solid", "outline", "elevated"]} onChange={(value) => setTheme("cardStyle", value as SiteTheme["cardStyle"])} />
                <Choice label="Inputs" value={form.theme.inputStyle} values={["soft", "solid", "outline", "filled"]} onChange={(value) => setTheme("inputStyle", value as SiteTheme["inputStyle"])} />
                <Choice label="Surface shadows" value={form.theme.shadowStyle} values={["none", "soft", "glow"]} onChange={(value) => setTheme("shadowStyle", value as SiteTheme["shadowStyle"])} />
                <Choice label="Border contrast" value={form.theme.borderStrength} values={["subtle", "standard", "strong"]} onChange={(value) => setTheme("borderStrength", value as SiteTheme["borderStrength"])} />
              </AppearanceGroup>

              {/* The storefront navbar's controls moved out of this list
                  entirely and into their own section, together with the navbar's
                  colours. "Navbar style" sitting between "Inputs" and "Surface
                  shadows" was how a storefront-only control ended up reading as
                  a site-wide one, and its colours being a section away was the
                  other half of the same problem. */}
              <AppearanceGroup title="Staff area only" description="Changes these admin screens. Customers never see it.">
                <Choice label="Staff sidebar" value={form.theme.navigationStyle} values={["soft", "framed", "minimal"]} onChange={(value) => setTheme("navigationStyle", value as SiteTheme["navigationStyle"])} />
              </AppearanceGroup>
            </> : null}
          </section>

          <button type="button" onClick={resetSection} className="ui-btn ui-btn-ghost">Reset this section</button>
        </div>

        {/*
          Clearing the search before jumping is not tidiness — a filtered list
          may not contain the target, and `scrollIntoView` on an element that is
          not in the DOM fails silently. The clear is a state update, so the
          jump is deferred until React has put the full list back.

          `setTimeout`, deliberately, not `requestAnimationFrame`: rAF does not
          fire at all while the tab is not being painted, so the jump silently
          did nothing in a backgrounded tab — which is exactly the state a
          browser-driven check runs in, and how this was caught. A timeout is
          throttled in the background but still fires, and it lands after
          React's commit just as reliably.
        */}
        <AppearancePreview
          form={form}
          onJump={(taskId) => {
            // The colour list is split across two sections now, so the jump has
            // to open the one that actually holds the control. Asking the task
            // which side it is on keeps this correct if a task is ever
            // reclassified — a hard-coded "colors" would scroll to an element
            // that is not rendered and fail silently.
            const task = taskById(taskId);
            setSection(task && isNavigationTask(task) ? "navigation" : "colors");
            setColorQuery("");
            window.setTimeout(() => jumpToAppearanceTask(taskId), 0);
          }}
        />
      </div>

      {confirmDelete ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4">
          <div role="dialog" aria-modal="true" aria-labelledby="delete-template-title" className="ui-card w-full max-w-md">
            <h2 id="delete-template-title" className="text-lg font-semibold">Delete “{confirmDelete.name}”?</h2>
            <p className="mt-2 text-sm text-brand-textMuted">
              This removes the saved template. The appearance currently published to the site is not affected.
            </p>
            <div className="ui-action-row mt-5 justify-end">
              <button type="button" autoFocus onClick={() => setConfirmDelete(null)} className="ui-btn ui-btn-ghost">Keep it</button>
              <button type="button" onClick={() => void deleteTemplate()} disabled={templateBusy} className="ui-btn ui-btn-danger disabled:opacity-50">Delete template</button>
            </div>
          </div>
        </div>
      ) : null}

      <div className="fixed inset-x-0 bottom-0 z-30 border-t border-brand-border bg-black/90 px-4 py-3 backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4"><p className="text-sm text-brand-textMuted">{dirty ? "You have unpublished appearance changes." : "Appearance is up to date."}</p><div className="ui-action-row"><button type="button" onClick={() => setForm(saved)} disabled={!dirty} className="ui-btn ui-btn-ghost">Discard changes</button><button type="button" onClick={() => void save()} disabled={!dirty} className="ui-btn ui-btn-primary">Publish appearance</button></div></div>
      </div>
    </main>
  );
}

/**
 * Whether a task's colours belong to the navbar rather than to the site.
 *
 * Decided from the *settings* each field writes, not from the task's own
 * section, because the five navbar tasks under "Advanced" — hover states,
 * utility buttons, count badges, menu panels — are filed by rarity rather than
 * by subject and would otherwise be split from the navbar they belong to.
 *
 * This is the same partition `resetSection` uses, read off the same `group`
 * field, so what a section shows and what it resets cannot drift apart. A
 * pointer task has no fields and stays with the site list, where the thing it
 * points at lives.
 */
function isNavigationTask(task: AppearanceTask): boolean {
  if (!task.fields.length) return false;
  return task.fields.every((field) => {
    const group = settingFor(field.key).group;
    return group === "navbar" || group === "navbarMenus";
  });
}

/**
 * The colour editor: one searchable list, grouped by what each colour touches.
 *
 * Every reported confusion on this page was the same shape — "I can see the
 * thing on my storefront, I cannot find the control for it". So the search
 * matches against the *screen elements* each setting reaches, not only its
 * label: typing "customizable", "cart" or "custom project" finds the right
 * control without knowing the token is called an accent or a badge.
 */
function ColorSection({
  form,
  query,
  onQueryChange,
  onChange,
  only,
}: {
  form: Appearance;
  query: string;
  onQueryChange: (value: string) => void;
  onChange: (setting: AppearanceSetting, value: string) => void;
  /**
   * Which half of the colour list to render.
   *
   * The navbar's thirteen colours moved to the Navigation section, so "make the
   * header darker" is one place rather than a shape control in one section and
   * its colours in another. Everything else stays here. The split is a filter
   * over one list rather than two lists, so every colour still has exactly one
   * control — the rule `appearanceTasks.ts` exists to hold.
   */
  only: "site" | "navigation";
}) {
  const wantsNav = only === "navigation";
  const matches = searchAppearanceTasks(query).filter(
    (task) => isNavigationTask(task) === wantsNav
  );
  const searching = Boolean(query.trim());

  const valueOf = (setting: AppearanceSetting) =>
    setting.key === "primaryColor"
      ? form.primaryColor
      : setting.key === "accentColor"
        ? form.accentColor
        : (form.theme[setting.key as keyof SiteTheme] as string);

  /**
   * What an automatic colour actually renders as.
   *
   * Not always the accent. The two primary-button overrides follow the primary
   * brand colour, and the button border follows the button *background* — so a
   * single shared accent made the automatic swatch a lie, the toggle's wording
   * wrong, and turning automatic off silently repaint the button.
   */
  const fallbackOf = (setting: AppearanceSetting) => {
    switch (setting.optional?.follows) {
      case "primaryColor":
        return form.primaryColor;
      case "primaryButtonBackground":
        return form.theme.primaryButtonBackground || form.primaryColor;
      default:
        return form.accentColor;
    }
  };

  const renderTask = (task: AppearanceTask) => (
    <TaskEditor
      key={task.id}
      task={task}
      valueOf={valueOf}
      fallbackOf={fallbackOf}
      onChange={onChange}
    />
  );

  const everyday = APPEARANCE_TASK_SECTIONS.filter((section) => section.id !== "advanced")
    .map((section) => ({ ...section, tasks: matches.filter((task) => task.section === section.id) }))
    .filter((section) => section.tasks.length > 0);
  const advanced = matches.filter((task) => task.section === "advanced");

  return (
    <>
      <div>
        <label className="block">
          <span className="ui-label">Search</span>
          <input
            type="search"
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder="Try: customizable, custom project, navbar, price, cart"
            className="ui-input"
          />
        </label>
        <p aria-live="polite" className="mt-2 text-xs text-brand-textMuted">
          {searching
            ? `${matches.length} ${matches.length === 1 ? "result" : "results"} for “${query.trim()}”.`
            : "Pick the thing you want to change. Each one shows only its own colours."}
        </p>
      </div>

      {matches.length === 0 ? (
        <p className="ui-empty-state">
          Nothing matches “{query.trim()}”. Try the name of something you can see on the site — “cart”, “price”,
          “badge”, “menu”.
        </p>
      ) : null}

      {everyday.map((section) => (
        <AppearanceGroup key={section.id} title={section.label} description={section.description}>
          <div className="grid gap-3">{section.tasks.map(renderTask)}</div>
        </AppearanceGroup>
      ))}

      {/*
        Advanced is a disclosure, closed by default — and it *opens itself* when
        a search matches something inside it. Leaving it shut would make the
        result count say "1 result" over an empty list, which is the worst
        version of both behaviours.
      */}
      {advanced.length ? (
        <details className="ui-card p-4" open={searching}>
          <summary className="cursor-pointer text-sm font-semibold">
            Advanced
            <span className="ml-2 font-normal text-brand-textMuted">
              {advanced.length} uncommon {advanced.length === 1 ? "control" : "controls"}
            </span>
          </summary>
          <p className="mt-2 text-xs text-brand-textMuted">
            Hover states, dropdown panels and count badges. Nothing here needs setting for the site to look
            finished.
          </p>
          <div className="mt-3 grid gap-3">{advanced.map(renderTask)}</div>
        </details>
      ) : null}
    </>
  );
}

/**
 * One thing on the screen, with only its own colours.
 *
 * The fields are labelled by the role the colour plays *in this thing* —
 * Background, Text, Border — rather than by the token's name. "Secondary button
 * background" is only meaningful to somebody who already knows the custom
 * project button is a secondary button; under a heading that says **Custom
 * project button**, the field is simply called Background.
 */
function TaskEditor({
  task,
  valueOf,
  fallbackOf,
  onChange,
}: {
  task: AppearanceTask;
  valueOf: (setting: AppearanceSetting) => string;
  /** The colour an automatic field renders as — per setting, not one shared accent. */
  fallbackOf: (setting: AppearanceSetting) => string;
  onChange: (setting: AppearanceSetting, value: string) => void;
}) {
  if (task.pointer) {
    const target = taskById(task.pointer.toTaskId);
    return (
      <div className="rounded-[var(--control-radius)] border border-brand-border p-3">
        <p className="text-sm font-semibold">{task.label}</p>
        <p className="mt-1 text-xs text-brand-textMuted">{task.description}</p>
        {/* An honest non-answer beats an empty search result, and beats a second
            control writing the same value. */}
        <p className="mt-2 text-xs text-brand-textMuted">
          {task.pointer.because} Change it under <b>{target?.label ?? task.pointer.toTaskId}</b>.
        </p>
      </div>
    );
  }

  return (
    /*
      `tabIndex={-1}` so the preview's "Edit these" jump can *focus* this block
      rather than only scrolling to it. Scrolling alone leaves a keyboard user's
      focus wherever it was, so the next Tab returns them to the preview they
      just left; focusing moves the caret into the settings they asked for.

      `scroll-mt-24` keeps the heading clear of the sticky page header once
      `scrollIntoView` lands.
    */
    <div
      className="scroll-mt-24 rounded-[var(--control-radius)] border border-brand-border p-3"
      id={`appearance-${task.id}`}
      tabIndex={-1}
    >
      <p className="text-sm font-semibold">{task.label}</p>
      <p className="mt-1 text-xs text-brand-textMuted">{task.description}</p>
      <div className="mt-3 grid gap-3 sm:grid-cols-3">
        {task.fields.map((field) => {
          const setting = settingFor(field.key);
          return (
            <TaskColorField
              key={field.key}
              role={field.role}
              setting={setting}
              value={valueOf(setting)}
              fallback={fallbackOf(setting)}
              onChange={(value) => onChange(setting, value)}
            />
          );
        })}
      </div>
      {task.fields.some((field) => settingFor(field.key).shared) ? (
        <p className="mt-2 text-xs text-amber-300">
          Shared — this colour is used in more than one place, so changing it moves them together.
        </p>
      ) : null}
    </div>
  );
}

/** A single colour inside a task: role name, swatch, hex, and the inheritance toggle. */
function TaskColorField({
  role,
  setting,
  value,
  fallback,
  onChange,
}: {
  role: string;
  setting: AppearanceSetting;
  value: string;
  /** What this renders as while automatic — the accent, the primary, or the button fill. */
  fallback: string;
  onChange: (value: string) => void;
}) {
  const following = Boolean(setting.optional) && !value;
  /* The toggle names the colour it actually follows. Saying "brand accent" on
     a control that follows the primary is how an owner ends up changing a
     colour they were told they were leaving alone. */
  const followLabel =
    setting.optional?.follows === "primaryColor"
      ? "Use brand primary"
      : setting.optional?.follows === "primaryButtonBackground"
        ? "Use button background"
        : "Use brand accent";

  return (
    <div>
      <label className="block">
        <span className="ui-label">{role}</span>
        <span className="flex gap-1.5">
          {/*
            An optional colour that is following shows the colour it *renders*
            as, so the swatch is never a lie — but the text box beside it stays
            empty, because a pre-filled hex would make "following" indis-
            tinguishable from "set to exactly this", and the two behave
            differently the next time the accent changes.
          */}
          <input
            type="color"
            value={value || fallback}
            aria-label={`${setting.label} colour picker`}
            onChange={(event) => onChange(event.target.value)}
            className="ui-color-input"
          />
          <input
            value={value}
            placeholder={following ? "Automatic" : undefined}
            onChange={(event) => onChange(event.target.value)}
            className="ui-input min-w-0 font-mono uppercase"
            maxLength={7}
          />
        </span>
      </label>

      {/*
        "Use brand accent", not "unset" and not "clear".

        The stored value is an empty string and the mechanism is variable
        absence, but neither of those is what the owner is deciding. They are
        deciding whether this thing has its own colour or follows the brand.

        Turning automatic *off* seeds the field with the colour it was already
        rendering, so opting out never changes what is on screen — it only
        stops it tracking future palette changes.
      */}
      {setting.optional ? (
        <label className="mt-1.5 flex items-center gap-1.5 text-xs text-brand-textMuted">
          <input
            type="checkbox"
            checked={following}
            onChange={(event) => onChange(event.target.checked ? "" : fallback)}
          />
          <span>{followLabel}</span>
        </label>
      ) : null}
    </div>
  );
}

/* * `SettingField` used to render one control per colour token, with a "Used * for" list underneath naming everything it reached. `TaskEditor` replaced it:
 * the same information, but grouped under the thing on the screen that owns
 * those colours, so the list is two or three fields rather than thirty-four
 * rows the owner has to disambiguate. Removed rather than left unreferenced —
 * a second colour control nobody renders is the next thing to drift.
 */

function TemplateSwatch({ primary, accent }: { primary: string; accent: string }) {
  return (
    <span className="flex gap-1.5" aria-hidden="true">
      <span className="size-5 rounded-full border border-white/20" style={{ background: primary }} />
      <span className="size-5 rounded-full border border-white/20" style={{ background: accent }} />
    </span>
  );
}

/**
 * A labelled caption under a previewed element.
 *
 * Every preview piece says which settings drive it. That is the difference
 * between a preview that shows a change and a preview that explains one — the
 * reported confusion was never "I cannot see the button", it was "I cannot
 * find the control for the button I can see".
 */
function PreviewNote({ children }: { children: ReactNode }) {
  return <p className="mt-2 text-[11px] leading-4 text-brand-textMuted">{children}</p>;
}

/**
 * Scroll to a task editor, open whatever is hiding it, and put focus in it.
 *
 * The preview could always *show* a change and name the settings behind it; it
 * could not take you to them, so "I can see the thing, I cannot find the
 * control" survived one step further down the page than before. This closes it.
 *
 * Three things have to happen in order, and skipping any one of them makes the
 * jump silently do nothing:
 *
 * 1. **Clear the search.** A filtered list may not contain the target at all,
 *    and scrolling to an element that is not in the DOM is a no-op with no
 *    feedback. The caller clears the query before this runs.
 * 2. **Open the ancestor disclosure.** Seven of the eighteen tasks live inside
 *    the collapsed "Advanced" `<details>`; `scrollIntoView` on a `display:none`
 *    subtree lands nowhere.
 * 3. **Focus, not just scroll**, for the reason in `TaskEditor`.
 *
 * The highlight is an inline style rather than a class. A new `globals.css`
 * rule is not served until `.next` is cleared, and an unused Tailwind ring
 * utility may never be generated — either way the failure is invisible, which
 * is the worst kind for a confirmation cue.
 */
function jumpToAppearanceTask(taskId: string) {
  const target = document.getElementById(`appearance-${taskId}`);
  if (!target) return;
  target.closest("details")?.setAttribute("open", "");
  target.scrollIntoView({ behavior: "smooth", block: "center" });
  target.focus({ preventScroll: true });
  target.style.outline = "2px solid var(--brand-primary)";
  target.style.outlineOffset = "3px";
  window.setTimeout(() => {
    target.style.outline = "";
    target.style.outlineOffset = "";
  }, 1800);
}

function PreviewBlock({
  title,
  note,
  jumpTo,
  onJump,
  children,
}: {
  title: string;
  note: ReactNode;
  /** The task editor this block's settings live in. */
  jumpTo?: string;
  onJump?: (taskId: string) => void;
  children: ReactNode;
}) {
  return (
    <div className="rounded-[var(--control-radius)] border border-brand-border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[11px] font-semibold uppercase tracking-[.1em] text-brand-textMuted">{title}</p>
        {jumpTo && onJump ? (
          <button
            type="button"
            onClick={() => onJump(jumpTo)}
            className="text-[11px] font-semibold text-brand-accent hover:underline"
          >
            Edit these →
          </button>
        ) : null}
      </div>
      <div className="mt-3">{children}</div>
      <PreviewNote>{note}</PreviewNote>
    </div>
  );
}

/**
 * The live preview.
 *
 * It previews the **storefront** first. The old version showed metric cards, a
 * stepper and a tab strip — all staff components — so an owner tuning the shop
 * customers see had nothing on screen that resembled it, and the two elements
 * they actually asked about (the custom-project CTA and the "Customizable"
 * badge) appeared nowhere at all.
 */
function AppearancePreview({ form, onJump }: { form: Appearance; onJump: (taskId: string) => void }) {
  return (
    <section className="ui-preview ui-card sticky top-5 h-fit space-y-3 self-start" aria-label="Live appearance preview">
      <div className="flex items-center gap-3">
        {form.identity.logoUrl ? (
          <Image src={form.identity.logoUrl} alt="" width={40} height={40} unoptimized className="h-10 w-10 object-contain" />
        ) : null}
        <div>
          <p className="ui-eyebrow">Live preview</p>
          <h2 className="text-xl font-semibold">{form.identity.shortName || form.identity.name}</h2>
        </div>
      </div>

      <PreviewBlock
        title="Product card"
        jumpTo="brand-surfaces"
        onJump={onJump}
        note={
          <>
            Background: <b>Card background</b> · Title: <b>Heading text</b> · Category and description:{" "}
            <b>Quiet text</b> · Price: <b>Primary brand colour</b> · Edge: <b>Border colour</b>
          </>
        }
      >
        <div className="ui-card !p-3">
          <div className="flex items-center justify-between gap-2 text-xs text-brand-textMuted">
            <span>Interior</span>
            <span className="ui-badge ui-badge-accent">Customizable</span>
          </div>
          <h3 className="mt-2 text-base font-semibold">Custom shift knob</h3>
          <p className="mt-1 line-clamp-2 text-xs leading-5 text-brand-textMuted">
            Machined to your spline pattern and finish.
          </p>
          <p className="mt-2 text-lg font-semibold text-brand-primary">$125.00</p>
        </div>
      </PreviewBlock>

      {/* The badge the owner asked about, shown on its own as well as on the
          card — and honest about the fact that it has no control of its own. */}
      <PreviewBlock
        title="“Customizable” badge"
        jumpTo="customizable-badge"
        onJump={onJump}
        note={
          <>
            Background: <b>Badge background</b> · Text: <b>Badge text</b> · Border: <b>Badge border</b>. All three
            are under Labels &amp; badges, and each follows <b>Accent colour</b> until you set it.
          </>
        }
      >
        <span className="ui-badge ui-badge-accent">Customizable</span>
      </PreviewBlock>

      <PreviewBlock
        title="Custom project CTA"
        jumpTo="custom-project-button"
        onJump={onJump}
        note={
          <>
            Background: <b>Secondary button background</b> · Text: <b>Secondary button text</b> · Border:{" "}
            <b>Secondary button border</b> · Shape: <b>Secondary buttons</b> under Shapes &amp; density (currently{" "}
            <b>{form.theme.secondaryButtonStyle}</b>)
          </>
        }
      >
        <button type="button" className="ui-btn ui-btn-secondary">
          Need something else? Start a custom project
        </button>
      </PreviewBlock>

      <PreviewBlock
        title="Buttons"
        jumpTo="primary-button"
        onJump={onJump}
        note={
          <>
            Primary fill: <b>Primary button background</b> · Primary label: <b>Primary button text</b> · Secondary
            label: <b>Secondary button text</b> · Quiet: <b>Body text</b> · Shape: <b>Primary buttons</b> under
            Shapes &amp; density (currently <b>{form.theme.primaryButtonStyle}</b>)
          </>
        }
      >
        <div className="ui-action-row">
          <button type="button" className="ui-btn ui-btn-primary">Add to Cart</button>
          <button type="button" className="ui-btn ui-btn-secondary">Request a Custom Version</button>
          <button type="button" className="ui-btn ui-btn-ghost">Cancel</button>
        </div>
      </PreviewBlock>

      {/*
        The storefront call-to-action, rendered with the real
        `.product-card-action` class rather than an approximation, so what is
        previewed here is literally what the catalog paints. It is the primary
        role at card size — the note says so rather than implying a control of
        its own.
      */}
      <PreviewBlock
        title="Product card CTA"
        jumpTo="primary-button"
        onJump={onJump}
        note={
          <>
            “Buy now” is your <b>primary button</b> at card size: fill from <b>Primary button background</b>, label
            from <b>Primary button text</b>, edge from <b>Primary button border</b>. On the Soft, Outline and Framed
            shapes the label follows <b>Primary brand colour</b>, because it then sits on the page rather than on
            the fill.
          </>
        }
      >
        <div className="product-card-footer !pt-0">
          <p className="text-sm font-semibold text-brand-primary">$84.00</p>
          <span className="product-card-action">Buy now</span>
        </div>
      </PreviewBlock>

      <PreviewBlock
        title="Form field"
        jumpTo="form-input"
        onJump={onJump}
        note={
          <>
            Label: <b>Quiet text</b> · Field background: <b>Input &amp; raised background</b> · Outline:{" "}
            <b>Border colour</b> · Typed value: <b>Body text</b>
          </>
        }
      >
        <label className="block">
          <span className="ui-label">Customer notes</span>
          <input className="ui-input" defaultValue="Brushed finish, no logo" />
        </label>
      </PreviewBlock>

      <PreviewBlock
        title="Status badges"
        jumpTo="brand-accent"
        onJump={onJump}
        note={
          <>
            “In review” follows <b>Accent colour</b>. In stock and Sold out are deliberately fixed green and red —
            a status colour that could be reassigned would stop meaning anything.
          </>
        }
      >
        <div className="flex flex-wrap gap-2">
          <Badge tone="accent">In review</Badge>
          <span className="ui-badge ui-badge-success">In stock</span>
          <span className="ui-badge ui-badge-danger">Sold out</span>
        </div>
      </PreviewBlock>

      <PreviewBlock
        title="Staff panel"
        jumpTo="brand-surfaces"
        onJump={onJump}
        note={
          <>
            The same <b>Card background</b>, <b>Border colour</b> and <b>Heading text</b> as the storefront. Only
            the staff sidebar has settings of its own.
          </>
        }
      >
        <div className="grid grid-cols-2 gap-2">
          <MetricCard label="Active orders" value="12" detail="3 need attention" />
          <MetricCard label="Revenue" value="$1,240" detail="Last 30 days" />
        </div>
      </PreviewBlock>

      <Notice tone="warning">Warnings keep their own colour, whatever the theme.</Notice>
    </section>
  );
}

/**
 * The header, as the storefront actually builds it.
 *
 * ## What it used to show
 *
 * `About · Projects · Catalog · Community` on the left and `Search · Messages ·
 * Notifications · Account · Staff` on the right — the navigation from *two*
 * passes ago. Community left the customer navigation entirely, Messages and
 * Staff moved inside the account menu, Catalog became a Products menu, and
 * search became a field on the bar rather than an icon. An owner tuning navbar
 * colours was matching them against a header that no longer existed, and the
 * two controls they would most want to see — the current-page marker and the
 * cart count — were not in it at all.
 *
 * ## What it shows now
 *
 * The real links, read from `primaryNav` so this cannot drift again, and the
 * real utility cluster in its real order. The classes are the storefront's own —
 * `site-header-shell`, `site-nav-primary-link`, `site-nav-utility`,
 * `site-nav-count-host`, `site-nav-badge` — so the underline, the hover
 * treatment, the utility ring and the count bubble are painted by the same rules
 * that paint the shop. An approximation here would be confidently wrong about
 * the exact thing the section exists to adjust.
 *
 * The count bubble is shown deliberately: this pass fixed it being positioned
 * against the header instead of the cart, and a preview that omits it is a
 * preview that could not have caught that.
 */
function NavbarPreview({ form }: { form: Appearance }) {
  return (
    <section className="space-y-3">
      <div>
        <h3 className="text-sm font-semibold">Header preview</h3>
        <p className="mt-1 text-xs text-brand-textMuted">
          The real header markup and the real navbar colours. Products is shown as the current page.
        </p>
      </div>
      <div className="site-header-shell overflow-x-auto rounded-[var(--control-radius)] border px-3 py-2">
        <div className="flex min-w-max items-center gap-4">
          <span className="flex items-center gap-2">
            {form.brand.primaryLogoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={form.brand.primaryLogoUrl} alt="" className="h-7 w-7 object-contain" />
            ) : null}
            {form.brand.showBrandName ? (
              <span className="site-header-wordmark">{form.identity.shortName || form.identity.name}</span>
            ) : null}
          </span>

          <span className="flex items-center gap-1">
            {primaryNav.map((item, index) => (
              <span
                key={item.href}
                className={cx("site-nav-link site-nav-primary-link !h-8 text-xs", index === 0 && "is-active")}
              >
                {item.label}
              </span>
            ))}
            <span className="site-nav-link site-nav-primary-link !h-8 text-xs">More</span>
          </span>

          <span className="ml-auto flex items-center gap-2">
            {/* Wishlist and cart, with the cart carrying a count — the pair
                whose badge placement this pass repaired. */}
            <span className="site-nav-count-host site-nav-utility inline-flex h-8 w-8 items-center justify-center rounded-full border text-[11px]">
              ♥
            </span>
            <span className="site-nav-count-host site-nav-utility inline-flex h-8 w-8 items-center justify-center rounded-full border text-[11px]">
              ▢
              <span className="site-nav-utility-badge site-nav-badge">3</span>
            </span>
          </span>
        </div>
      </div>
    </section>
  );
}

function SectionTitle({ title, text }: { title: string; text: string }) {
  return <div><h2 className="text-lg font-semibold">{title}</h2><p className="mt-1 text-sm text-brand-textMuted">{text}</p></div>;
}

/**
 * `scope` says whether a group touches the storefront, the staff area, or both.
 *
 * Without it the two were interleaved with nothing to tell them apart — a
 * staff-only sidebar control sat between two site-wide ones, so a shop owner
 * reasonably read the whole list as customer-facing.
 */
function AppearanceGroup({ title, description, scope, children }: { title: string; description: string; scope?: string; children: ReactNode }) {
  return (
    <fieldset className="rounded-[var(--control-radius)] border border-brand-border p-4">
      <legend className="px-2 text-sm font-semibold">{title}</legend>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        {scope ? <Badge>{scope}</Badge> : null}
        <p className="text-xs text-brand-textMuted">{description}</p>
      </div>
      <div className="space-y-5">{children}</div>
    </fieldset>
  );
}

/*
 * `TextField` was removed. Every text input on this page now uses `Field` from
 * `./sections`, which does the two things this one did not: it associates its
 * label with its input by id rather than by wrapping, and it can carry a
 * validation message tied to the field with `aria-describedby`. Two text-input
 * components on one form is how half the fields end up without error handling.
 */

function Choice({ label, value, values, onChange }: { label: string; value: string; values: string[]; onChange: (value: string) => void }) {
  return <div><p className="ui-label">{label}</p><div className="grid gap-2 sm:grid-cols-2">{values.map((item) => <button key={item} type="button" aria-pressed={value === item} onClick={() => onChange(item)} className={cx("ui-card ui-card-hover !p-3 text-left", value === item && "!border-brand-primary !bg-brand-primary/10")}><span className={cx("block text-sm font-semibold capitalize", value === item && "text-brand-primary")}>{item}</span><span className="mt-1 block text-xs text-brand-textMuted">{choiceHelp[item] || "Shared site treatment"}</span></button>)}</div></div>;
}
