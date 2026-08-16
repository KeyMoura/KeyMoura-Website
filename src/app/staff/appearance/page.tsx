"use client";

import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";

import { Badge, Notice, cx } from "@/components/ui/DesignSystem";
import { hero as shippedHero } from "@/lib/home/content";
import { defaultSiteTheme, optionalVars, type SiteTheme } from "@/theme/runtime";
import { defaultAnnouncementConfig, type AnnouncementConfig } from "@/theme/announcement";
import { defaultBrandConfig, type BrandConfig } from "@/theme/brand";
import { defaultHomepageConfig, resolveHomepageHero, type HomepageConfig } from "@/theme/homepage";
import { APPEARANCE_SETTINGS, type AppearanceSetting } from "@/theme/appearanceMap";
import { APPEARANCE_TASKS } from "@/theme/appearanceTasks";
import {
  appearanceSection,
  sectionForTask,
  type AppearanceSearchEntry,
  type AppearanceSectionId,
} from "@/theme/appearanceSections";
import {
  BUILT_IN_PRESETS,
  normalizeAppearanceTemplateConfig,
  normalizeTemplateName,
  TEMPLATE_NAME_MAX,
  templateNameError,
  type AppearanceTemplate,
  type AppearanceTemplateConfig,
} from "@/theme/templates";

import { contrastRatio, type ColorValues } from "./ColorControls";
import {
  ActionBar,
  AppearanceSearch,
  ControlGroup,
  focusControl,
  SectionPicker,
  SectionRail,
} from "./EditorChrome";
import {
  AdvancedPanel,
  BusinessPanel,
  ColoursPanel,
  CommercePanel,
  ComponentsPanel,
  FormsPanel,
  LayoutPanel,
  NavigationPanel,
  TypographyPanel,
  type Identity,
  type ThemeEditor,
} from "./panels";
import { PreviewStage } from "./PreviewStage";
import { AnnouncementSection, BrandSection, Field, HomepageSection } from "./sections";
import type { PickedProduct } from "./ProductPicker";

/**
 * The KeyMoura Storefront Control Center.
 *
 * ## What this replaced, and why none of it was kept
 *
 * The previous editor was a three-column grid — a section list with a paragraph
 * under every entry, a settings pane, and a permanent 320px preview wall — with
 * the publish controls in a `position: fixed` bar across the bottom of the
 * viewport. Every reported complaint traced to one of those three decisions.
 *
 * The permanent third column left the actual editor about 400px on a 1366px
 * laptop, because the staff rail takes 280px before this page sees anything. A
 * colour row with a swatch, a hex field and an inheritance control does not fit
 * in 400px, so it wrapped, so the page got taller, so there was more scrolling.
 *
 * The fixed bar covered whatever scrolled under it. `pb-24` reserves space at
 * the *end* of a document, not along it, so on a 768px-tall screen the bar sat
 * on top of live controls for the entire scroll.
 *
 * And the organisation was by *kind of setting* rather than by task: the
 * navbar's shape under "Buttons & components" and its colours under
 * "Navigation"; the search box filtering colours only, so "announcement",
 * "logo" and "featured product" matched nothing at all.
 *
 * ## What this is
 *
 * A fixed-height shell — head, then rail and workspace side by side, then the
 * action bar — where the rail and the workspace scroll themselves and the bar is
 * a sibling *below* them rather than a layer over them. `.appearance-shell` in
 * `globals.css` carries the layout reasoning in full.
 *
 * One section is open at a time and it gets the whole workspace. The preview is
 * off by default and, when on, is a full-width horizontal stage showing the
 * surface the open section edits. Search covers every control in the editor and
 * navigates to the one you choose.
 *
 * ## What was deliberately preserved
 *
 * The theme engine, all of it. `SiteTheme`, `normalizeSiteTheme`, the CSS
 * variables, the optional-colour inheritance, `APPEARANCE_SETTINGS`,
 * `APPEARANCE_TASKS`, the templates, the persistence and the publish endpoint
 * are untouched. This pass replaced the editor, not the thing it edits — which
 * is also why an existing site's published values load and render exactly as
 * they did before.
 */

type Appearance = {
  primaryColor: string;
  accentColor: string;
  theme: SiteTheme;
  identity: Identity;
  brand: BrandConfig;
  announcement: AnnouncementConfig;
  homepage: HomepageConfig;
};

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

/**
 * How many distinct things are waiting to be published.
 *
 * Counted one level into each branch rather than as a boolean, because "you have
 * unpublished changes" answers a question nobody asked — the owner knows they
 * changed something. What they cannot see, four sections later, is how much.
 */
function countChanges(form: Appearance, saved: Appearance): number {
  let changed = 0;
  const compare = (left: unknown, right: unknown) => {
    if (JSON.stringify(left) !== JSON.stringify(right)) changed += 1;
  };
  compare(form.primaryColor, saved.primaryColor);
  compare(form.accentColor, saved.accentColor);
  for (const key of Object.keys(saved.theme) as (keyof SiteTheme)[]) {
    compare(form.theme[key], saved.theme[key]);
  }
  for (const key of Object.keys(saved.identity) as (keyof Identity)[]) {
    compare(form.identity[key], saved.identity[key]);
  }
  for (const key of Object.keys(saved.brand) as (keyof BrandConfig)[]) {
    compare(form.brand[key], saved.brand[key]);
  }
  for (const key of Object.keys(saved.announcement) as (keyof AnnouncementConfig)[]) {
    compare(form.announcement[key], saved.announcement[key]);
  }
  for (const key of Object.keys(saved.homepage) as (keyof HomepageConfig)[]) {
    compare(form.homepage[key], saved.homepage[key]);
  }
  return changed;
}

export default function AppearancePage() {
  const [form, setForm] = useState<Appearance>(defaults);
  const [saved, setSaved] = useState<Appearance>(defaults);
  const [section, setSection] = useState<AppearanceSectionId>("brand");
  const [showPreview, setShowPreview] = useState(false);
  const [state, setState] = useState("Loading appearance…");
  const [tone, setTone] = useState<"info" | "danger" | "success">("info");
  const [busy, setBusy] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);

  /*
   * Names and thumbnails for the two homepage pins, kept beside the form rather
   * than inside it.
   *
   * What gets *saved* is a pair of ids; this is only what those ids are called.
   * Keeping it out of `form` matters because dirtiness is a comparison of `form`
   * against `saved` — folding display data in would mark the page dirty the
   * moment a product was renamed somewhere else.
   */
  const [pinned, setPinned] = useState<Record<string, PickedProduct>>({});

  const [templates, setTemplates] = useState<AppearanceTemplate[]>([]);
  const [templatesError, setTemplatesError] = useState("");
  const [templateName, setTemplateName] = useState("");
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<AppearanceTemplate | null>(null);
  const [templateBusy, setTemplateBusy] = useState(false);
  const [templateNotice, setTemplateNotice] = useState("");

  const notify = useCallback((message: string, kind: "info" | "danger" | "success" = "info") => {
    setTone(kind);
    setState(message);
  }, []);

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
      .catch((error: Error) => notify(error.message || "Could not load appearance.", "danger"));
  }, [notify]);

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
  // separate action on the bar at the bottom of the shell.
  const applyTemplate = (name: string, config: AppearanceTemplateConfig) => {
    setForm((current) => applyTemplateToForm(current, config));
    setTemplateNotice(`Applied “${name}” to the editor. Publish to make it live.`);
  };

  const changed = countChanges(form, saved);
  const dirty = changed > 0;

  /*
   * The page-level contrast warning.
   *
   * Per-field warnings live beside the pair that caused them, in `TaskEditor`.
   * This one stays because three of these pairs span two sections — the primary
   * colour is checked against the *page*, not against a control near it — and a
   * warning that only appears in a section you have not opened is a warning
   * nobody sees.
   */
  const warning = useMemo(() => {
    const contrast = contrastRatio;
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

  const setTheme = useCallback(<Key extends keyof SiteTheme>(key: Key, value: SiteTheme[Key]) => {
    setForm((current) => ({ ...current, theme: { ...current.theme, [key]: value } }));
  }, []);

  const setIdentity = useCallback((key: keyof Identity, value: string) => {
    setForm((current) => ({ ...current, identity: { ...current.identity, [key]: value } }));
  }, []);

  /** Reads one colour off the form, wherever on it that colour lives. */
  const readColor = useCallback(
    (source: Appearance, setting: AppearanceSetting) =>
      setting.key === "primaryColor"
        ? source.primaryColor
        : setting.key === "accentColor"
          ? source.accentColor
          : (source.theme[setting.key as keyof SiteTheme] as string),
    []
  );

  const colors: ColorValues = useMemo(
    () => ({
      valueOf: (setting) => readColor(form, setting),
      publishedOf: (setting) => readColor(saved, setting),
      /**
       * What an automatic colour actually renders as.
       *
       * Not always the accent. The two primary-button overrides follow the
       * primary brand colour, and the button border follows the button
       * *background* — so a single shared accent made the automatic swatch a
       * lie, the toggle's wording wrong, and turning automatic off silently
       * repaint the button.
       */
      fallbackOf: (setting) => {
        switch (setting.optional?.follows) {
          case "primaryColor":
            return form.primaryColor;
          case "primaryButtonBackground":
            return form.theme.primaryButtonBackground || form.primaryColor;
          default:
            return form.accentColor;
        }
      },
      onChange: (setting, value) => {
        if (setting.key === "primaryColor") setForm((current) => ({ ...current, primaryColor: value }));
        else if (setting.key === "accentColor") setForm((current) => ({ ...current, accentColor: value }));
        else setTheme(setting.key as keyof SiteTheme, value as never);
      },
    }),
    [form, saved, readColor, setTheme]
  );

  const editor: ThemeEditor = useMemo(
    () => ({ theme: form.theme, setTheme, colors }),
    [form.theme, setTheme, colors]
  );

  /**
   * Send the owner to a control, opening whatever section holds it.
   *
   * `setTimeout`, deliberately, not `requestAnimationFrame`: rAF does not fire
   * at all while a tab is not being painted, so the jump silently did nothing in
   * a backgrounded tab — which is exactly the state a browser-driven check runs
   * in. A timeout is throttled in the background but still fires, and it lands
   * after React's commit just as reliably.
   */
  const goTo = useCallback((target: AppearanceSectionId, anchor: string) => {
    setSection(target);
    window.setTimeout(() => focusControl(anchor), 0);
  }, []);

  const onSearchGo = useCallback(
    (entry: AppearanceSearchEntry) => goTo(entry.section, entry.anchor),
    [goTo]
  );

  /**
   * Reset only what the open section edits, back to what is published.
   *
   * "Reset" here means "back to what is published", not "back to the factory
   * palette" — the owner pressing it has made a mess of one thing and wants that
   * one thing undone, and a button that also reverted the four other sections
   * they had just finished would be the worst possible reading of the word.
   *
   * The colour branches are derived from the section map rather than a
   * hand-written key list, so a colour that moves between sections cannot end up
   * reset by both or by neither.
   */
  const resetSection = () =>
    setForm((current) => {
      if (section === "templates") return current;
      if (section === "brand") return { ...current, brand: saved.brand };
      if (section === "announcement") return { ...current, announcement: saved.announcement };
      if (section === "homepage") return { ...current, homepage: saved.homepage };
      if (section === "business") return { ...current, identity: saved.identity };

      const next = { ...current, theme: { ...current.theme } };

      // Every colour this section draws, read off the same map the section
      // renders from.
      for (const setting of APPEARANCE_SETTINGS) {
        if (settingSection(setting) !== section) continue;
        if (setting.key === "primaryColor") next.primaryColor = saved.primaryColor;
        else if (setting.key === "accentColor") next.accentColor = saved.accentColor;
        else {
          const key = setting.key as keyof SiteTheme;
          (next.theme as Record<string, unknown>)[key] = saved.theme[key];
        }
      }

      // And every choice control it owns.
      for (const key of SECTION_CHOICE_KEYS[section] ?? []) {
        (next.theme as Record<string, unknown>)[key] = saved.theme[key];
      }
      return next;
    });

  const sectionDirty = useMemo(() => {
    // Cheap and honest: reset produces a different form only when something in
    // this section has moved. Computing it this way means the button cannot
    // claim there is nothing to reset while a control in view is clearly
    // changed.
    if (section === "templates") return false;
    if (section === "brand") return JSON.stringify(form.brand) !== JSON.stringify(saved.brand);
    if (section === "announcement") return JSON.stringify(form.announcement) !== JSON.stringify(saved.announcement);
    if (section === "homepage") return JSON.stringify(form.homepage) !== JSON.stringify(saved.homepage);
    if (section === "business") return JSON.stringify(form.identity) !== JSON.stringify(saved.identity);
    const colourMoved = APPEARANCE_SETTINGS.some(
      (setting) => settingSection(setting) === section && readColor(form, setting) !== readColor(saved, setting)
    );
    const choiceMoved = (SECTION_CHOICE_KEYS[section] ?? []).some(
      (key) => form.theme[key] !== saved.theme[key]
    );
    return colourMoved || choiceMoved;
  }, [section, form, saved, readColor]);

  async function publish() {
    setBusy(true);
    notify("Publishing appearance…");
    try {
      const response = await fetch("/api/staff/appearance", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(form),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || "Could not save.");
      // Only on success. The draft is otherwise left exactly as it was, so a
      // rejected save loses nothing and the owner can correct the one field the
      // message names.
      setSaved(form);
      notify("Appearance published.", "success");
    } catch (error) {
      notify(error instanceof Error ? error.message : "Could not save.", "danger");
    } finally {
      setBusy(false);
    }
  }

  const currentSection = appearanceSection(section);
  const heroCopy = resolveHomepageHero(form.homepage, shippedHero);

  return (
    <main
      className="appearance-shell"
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
      {/*
        The head is `flex: none`, so it never scrolls away and never grows. One
        line of identity, the search, and the preview toggle — the page title
        used to carry a three-line explanation of what appearance settings are,
        which is a sentence you read once and then scroll past forever.
      */}
      <header className="appearance-head flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-lg font-semibold leading-tight">Storefront control center</h1>
          <p className="text-xs text-brand-textMuted">Everything customers see, in one place.</p>
        </div>
        <div className="flex flex-1 flex-wrap items-center justify-end gap-2">
          <AppearanceSearch onGo={onSearchGo} />
          <button
            type="button"
            aria-pressed={showPreview}
            onClick={() => setShowPreview((value) => !value)}
            className={cx("ui-btn !py-1.5 text-xs", showPreview ? "ui-btn-secondary" : "ui-btn-ghost")}
            disabled={!currentSection.preview}
            title={currentSection.preview ? undefined : "This section has nothing to preview."}
          >
            {showPreview ? "Hide preview" : "Show preview"}
          </button>
        </div>
      </header>

      <div className="appearance-body">
        <SectionRail section={section} onSelect={setSection} />

        <div className="appearance-workspace space-y-3">
          <SectionPicker section={section} onSelect={setSection} />

          {state ? (
            <Notice tone={tone === "info" ? undefined : tone} role={tone === "danger" ? "alert" : "status"}>
              {state}
            </Notice>
          ) : null}
          {warning ? <Notice tone="warning">{warning}</Notice> : null}

          <section className="ui-card space-y-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <h2 className="text-base font-semibold">{currentSection.label}</h2>
                <p className="mt-1 max-w-2xl text-xs leading-5 text-brand-textMuted">
                  {currentSection.description}
                </p>
              </div>
              {sectionDirty ? (
                <button
                  type="button"
                  onClick={() => setConfirmReset(true)}
                  className="ui-btn ui-btn-ghost !py-1.5 text-xs"
                >
                  Reset {currentSection.label.toLowerCase()}
                </button>
              ) : null}
            </div>

            {showPreview && currentSection.preview ? (
              <PreviewStage
                /* Remounting on a section change is what resets the preview's
                   own context — see `PreviewStage`. */
                key={currentSection.preview}
                input={{
                  preview: currentSection.preview,
                  theme: form.theme,
                  brand: form.brand,
                  announcement: form.announcement,
                  hero: heroCopy,
                  heroImageUrl: form.homepage.heroImageUrl,
                  siteName: form.identity.shortName || form.identity.name,
                  primaryColor: form.primaryColor,
                }}
              />
            ) : null}

            {section === "brand" ? (
              <BrandSection
                brand={form.brand}
                siteName={form.identity.shortName || form.identity.name}
                onChange={(brand) => setForm((current) => ({ ...current, brand }))}
                onNotice={notify}
              />
            ) : null}

            {section === "navigation" ? <NavigationPanel editor={editor} /> : null}

            {section === "announcement" ? (
              <AnnouncementSection
                announcement={form.announcement}
                onChange={(announcement) => setForm((current) => ({ ...current, announcement }))}
              />
            ) : null}

            {section === "homepage" ? (
              <HomepageSection
                homepage={form.homepage}
                defaults={{
                  eyebrow: shippedHero.eyebrow,
                  titleLead: shippedHero.titleLead,
                  titleAccent: shippedHero.titleAccent,
                  lede: shippedHero.lede,
                  primaryLabel: shippedHero.primary.label,
                  primaryHref: shippedHero.primary.href,
                  secondaryLabel: shippedHero.secondary.label,
                  secondaryHref: shippedHero.secondary.href,
                }}
                featured={pinned[form.homepage.featuredProductId] ?? null}
                hero={pinned[form.homepage.heroProductId] ?? null}
                onChange={(homepage) => setForm((current) => ({ ...current, homepage }))}
                onPick={(_slot, product) => {
                  // The picker returns the display data alongside the id, so a
                  // freshly chosen product renders immediately instead of
                  // waiting for a reload to learn its own name.
                  if (product) setPinned((current) => ({ ...current, [product.id]: product }));
                }}
                onNotice={notify}
              />
            ) : null}

            {section === "colours" ? <ColoursPanel editor={editor} /> : null}
            {section === "typography" ? <TypographyPanel editor={editor} /> : null}
            {section === "components" ? <ComponentsPanel editor={editor} /> : null}
            {section === "commerce" ? <CommercePanel editor={editor} onGoTo={goTo} /> : null}
            {section === "forms" ? <FormsPanel editor={editor} /> : null}
            {section === "layout" ? <LayoutPanel editor={editor} /> : null}
            {section === "business" ? (
              <BusinessPanel identity={form.identity} onChange={setIdentity} />
            ) : null}
            {section === "advanced" ? <AdvancedPanel editor={editor} /> : null}

            {section === "templates" ? (
              <>
                {templatesError ? <Notice tone="danger" role="alert">{templatesError}</Notice> : null}
                {templateNotice ? <Notice role="status">{templateNotice}</Notice> : null}

                <ControlGroup
                  anchor="templates-save"
                  title="Save the current look"
                  description="Captures the brand colours, every component and navbar setting, and the brand artwork. Business details are not included, so applying a template never renames the site."
                >
                  <div className="flex flex-wrap items-end gap-3">
                    <div className="min-w-56 flex-1">
                      <Field
                        label="Template name"
                        value={templateName}
                        maxLength={TEMPLATE_NAME_MAX}
                        placeholder="Winter storefront"
                        invalid={Boolean(templateName && savedNameConflict)}
                        error={templateName && savedNameConflict ? savedNameConflict : undefined}
                        onChange={setTemplateName}
                      />
                    </div>
                    <button
                      type="button"
                      onClick={() => void saveTemplate()}
                      disabled={!canSaveTemplate}
                      className="ui-btn ui-btn-primary disabled:opacity-50"
                    >
                      Save as template
                    </button>
                  </div>
                </ControlGroup>

                <ControlGroup
                  anchor="templates-built-in"
                  title="Built-in presets"
                  description="Shipped with the site. They can be applied but not renamed or deleted."
                >
                  <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                    {Object.entries(BUILT_IN_PRESETS).map(([name, preset]) => (
                      <div key={name} className="ui-card !p-3">
                        <TemplateSwatch primary={preset.primaryColor} accent={preset.accentColor} />
                        <p className="mt-2 flex items-center gap-2 text-sm font-semibold">
                          {name}
                          <Badge>Built in</Badge>
                        </p>
                        <button
                          type="button"
                          onClick={() => applyTemplate(name, preset)}
                          className="ui-btn ui-btn-secondary mt-2 w-full !py-1.5 text-xs"
                        >
                          Apply
                        </button>
                      </div>
                    ))}
                  </div>
                </ControlGroup>

                <ControlGroup
                  anchor="templates-yours"
                  title="Your templates"
                  description="Applying loads a template into the editor. Nothing goes live until you publish."
                >
                  {templates.length === 0 ? (
                    <p className="ui-empty-state">No saved templates yet. Set up a look, then save it above.</p>
                  ) : (
                    <ul className="grid gap-3 sm:grid-cols-2">
                      {templates.map((template) => (
                        <li key={template.id} className="ui-card !p-3">
                          {renaming?.id === template.id ? (
                            <div className="space-y-2">
                              <Field
                                label="Rename template"
                                value={renaming.name}
                                maxLength={TEMPLATE_NAME_MAX}
                                onChange={(value) => setRenaming({ id: template.id, name: value })}
                              />
                              <div className="ui-action-row">
                                <button
                                  type="button"
                                  onClick={() => void renameTemplate()}
                                  disabled={
                                    templateBusy ||
                                    Boolean(
                                      templateNameError(
                                        renaming.name,
                                        templates.filter((other) => other.id !== template.id).map((other) => other.name)
                                      )
                                    )
                                  }
                                  className="ui-btn ui-btn-primary !py-1.5 text-xs disabled:opacity-50"
                                >
                                  Save name
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setRenaming(null)}
                                  className="ui-btn ui-btn-ghost !py-1.5 text-xs"
                                >
                                  Cancel
                                </button>
                              </div>
                            </div>
                          ) : (
                            <>
                              <TemplateSwatch primary={template.primaryColor} accent={template.accentColor} />
                              <p className="mt-2 text-sm font-semibold">{template.name}</p>
                              {template.updatedAt ? (
                                <p className="mt-0.5 text-xs text-brand-textMuted">
                                  Updated {new Date(template.updatedAt).toLocaleDateString()}
                                </p>
                              ) : null}
                              <div className="ui-action-row mt-2">
                                <button
                                  type="button"
                                  onClick={() => applyTemplate(template.name, template)}
                                  className="ui-btn ui-btn-secondary !py-1.5 text-xs"
                                >
                                  Apply
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setRenaming({ id: template.id, name: template.name })}
                                  className="ui-btn ui-btn-ghost !py-1.5 text-xs"
                                >
                                  Rename
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setConfirmDelete(template)}
                                  className="ui-btn ui-btn-danger !py-1.5 text-xs"
                                >
                                  Delete
                                </button>
                              </div>
                            </>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </ControlGroup>
              </>
            ) : null}
          </section>
        </div>
      </div>

      <ActionBar
        dirty={dirty}
        changed={changed}
        busy={busy}
        onPublish={() => void publish()}
        /* Confirmation is proportional: one stray change is undone without
           ceremony, but throwing away a session's work should take a decision. */
        onDiscard={() => (changed > 3 ? setConfirmDiscard(true) : setForm(saved))}
      />

      {confirmDiscard ? (
        <ConfirmDialog
          title={`Discard ${changed} unpublished changes?`}
          body="Everything you have changed since the last publish goes back to what is live. This cannot be undone."
          confirmLabel="Discard changes"
          onCancel={() => setConfirmDiscard(false)}
          onConfirm={() => {
            setForm(saved);
            setConfirmDiscard(false);
            notify("Unpublished changes discarded.");
          }}
        />
      ) : null}

      {confirmReset ? (
        <ConfirmDialog
          title={`Reset ${currentSection.label.toLowerCase()}?`}
          body={`Every setting in ${currentSection.label} goes back to what is currently published. Your other sections keep their unpublished changes.`}
          confirmLabel="Reset section"
          onCancel={() => setConfirmReset(false)}
          onConfirm={() => {
            resetSection();
            setConfirmReset(false);
          }}
        />
      ) : null}

      {confirmDelete ? (
        <ConfirmDialog
          title={`Delete “${confirmDelete.name}”?`}
          body="This removes the saved template. The appearance currently published to the site is not affected."
          confirmLabel="Delete template"
          busy={templateBusy}
          onCancel={() => setConfirmDelete(null)}
          onConfirm={() => void deleteTemplate()}
        />
      ) : null}
    </main>
  );
}

/**
 * Which editor section owns a colour.
 *
 * Resolved through the task that owns the setting, so the section map stays the
 * one place that decides. A colour with no task would be unreachable, which
 * `appearance-tasks.test.ts` already forbids.
 */
function settingSection(setting: AppearanceSetting): AppearanceSectionId | null {
  for (const task of APPEARANCE_TASKS) {
    if (task.fields.some((field) => field.key === setting.key)) return sectionForTask(task.id);
  }
  return null;
}

/**
 * The non-colour theme keys each section owns, for its reset.
 *
 * Listed once and used by both the reset and the "is this section dirty" check,
 * so what a section resets and what it reports as changed cannot disagree.
 */
const SECTION_CHOICE_KEYS: Partial<Record<AppearanceSectionId, readonly (keyof SiteTheme)[]>> = {
  navigation: ["publicNavigationStyle", "navigationBehavior", "navigationDensity"],
  typography: ["font"],
  components: ["primaryButtonStyle", "secondaryButtonStyle", "tabStyle", "cardStyle", "inputStyle", "navigationStyle"],
  forms: ["inputStyle"],
  layout: ["radius", "density", "contentWidth", "backgroundStyle", "shadowStyle", "borderStrength"],
};

function TemplateSwatch({ primary, accent }: { primary: string; accent: string }) {
  return (
    <span className="flex gap-1.5" aria-hidden="true">
      <span className="size-5 rounded-full border border-white/20" style={{ background: primary }} />
      <span className="size-5 rounded-full border border-white/20" style={{ background: accent }} />
    </span>
  );
}

/**
 * One confirmation dialog for every destructive action on this page.
 *
 * Three separate inline dialogs is how one of them ends up without a focus trap
 * or without `aria-modal`. The cancel button takes focus on open, so the default
 * action of pressing Enter or Escape is the safe one.
 */
function ConfirmDialog({
  title,
  body,
  confirmLabel,
  busy,
  onCancel,
  onConfirm,
}: {
  title: string;
  body: string;
  confirmLabel: string;
  busy?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4"
      onKeyDown={(event) => {
        if (event.key === "Escape") onCancel();
      }}
    >
      <div role="dialog" aria-modal="true" aria-labelledby="appearance-confirm-title" className="ui-card w-full max-w-md">
        <h2 id="appearance-confirm-title" className="text-lg font-semibold">
          {title}
        </h2>
        <p className="mt-2 text-sm text-brand-textMuted">{body}</p>
        <div className="ui-action-row mt-5 justify-end">
          <button type="button" autoFocus onClick={onCancel} className="ui-btn ui-btn-ghost">
            Keep it
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className="ui-btn ui-btn-danger disabled:opacity-50"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
