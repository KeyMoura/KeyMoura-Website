"use client";

import Image from "next/image";
import { useCallback, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";

import { Badge, MetricCard, Notice, cx } from "@/components/ui/DesignSystem";
import { defaultSiteTheme, optionalVars, type SiteTheme } from "@/theme/runtime";
import {
  APPEARANCE_GROUPS,
  APPEARANCE_SETTINGS,
  searchAppearanceSettings,
  type AppearanceSetting,
} from "@/theme/appearanceMap";
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
  forumLabel: string;
  knowledgeBaseLabel: string;
  trustedVendorLabel: string;
};

type Appearance = {
  primaryColor: string;
  accentColor: string;
  theme: SiteTheme;
  identity: Identity;
};

type Section = "colors" | "styles" | "brand" | "assets" | "wording" | "templates";

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
  forumLabel: "Community",
  knowledgeBaseLabel: "Projects",
  trustedVendorLabel: "Trusted Shop",
};

const defaults: Appearance = {
  primaryColor: "#fbbf24",
  accentColor: "#f59e0b",
  theme: defaultSiteTheme,
  identity: defaultIdentity,
};

/**
 * Section order is the order somebody actually works in: colours first, because
 * that is what every reported confusion was about, then shape, then the
 * identity fields that are set once during setup.
 *
 * "Colors & controls" and "Navbar" used to be separate sections holding 11 and
 * 17 colours respectively, so half the palette was in a section named after a
 * component. Every colour now lives in one searchable place, grouped by what it
 * touches.
 */
const sectionCopy: Record<Section, { label: string; description: string }> = {
  colors: { label: "Colours", description: "Every colour on the site, grouped by what it changes. Search if you know what you are looking for." },
  styles: { label: "Shapes & density", description: "Corner rounding, spacing, typography and the shape of buttons, cards and inputs." },
  brand: { label: "Business details", description: "Business name, public details, metadata, and support information." },
  assets: { label: "Logos & icons", description: "Header, footer, browser, and mobile brand artwork." },
  wording: { label: "Labels & wording", description: "Names customers see for the major areas of the site." },
  templates: { label: "Saved looks", description: "Save a complete look, try saved looks before publishing, and manage them." },
};

const SCOPE_LABEL: Record<"storefront" | "staff" | "both", string> = {
  storefront: "Storefront",
  staff: "Staff area",
  both: "Storefront & staff",
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
  const [section, setSection] = useState<Section>("colors");
  const [state, setState] = useState("Loading appearance…");
  const [colorQuery, setColorQuery] = useState("");

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
        const loaded = { ...defaults, ...body, identity: { ...defaultIdentity, ...body.identity } };
        setForm(loaded);
        setSaved(loaded);
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
    if (form.theme.primaryButtonStyle === "solid" && contrast(form.theme.primaryButtonText, form.primaryColor) < 4.5) return "Primary button text needs more contrast against the primary color.";
    if (form.theme.secondaryButtonStyle === "solid" && contrast(form.theme.secondaryButtonText, form.accentColor) < 4.5) return "Secondary button text needs more contrast against the accent color.";
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
    }),
  } as CSSProperties;

  const setTheme = <Key extends keyof SiteTheme>(key: Key, value: SiteTheme[Key]) =>
    setForm((current) => ({ ...current, theme: { ...current.theme, [key]: value } }));
  const setIdentity = (key: keyof Identity, value: string) =>
    setForm((current) => ({ ...current, identity: { ...current.identity, [key]: value } }));

  /**
   * Reset only what the open section edits.
   *
   * The two colour-bearing sections are derived from `APPEARANCE_SETTINGS`
   * rather than a hand-written key list. The previous version listed 19 navbar
   * keys by hand beside a section that reset the whole theme, so a colour added
   * to one list and not the other would silently survive a reset.
   */
  const resetSection = () => setForm((current) => {
    if (section === "colors") {
      const next = { ...current, theme: { ...current.theme } };
      for (const setting of APPEARANCE_SETTINGS) {
        if (setting.key === "primaryColor") next.primaryColor = saved.primaryColor;
        else if (setting.key === "accentColor") next.accentColor = saved.accentColor;
        else {
          const key = setting.key as keyof SiteTheme;
          (next.theme as Record<string, unknown>)[key] = saved.theme[key];
        }
      }
      return next;
    }
    if (section === "styles") {
      // Everything on the theme that is not a colour: the choice-valued keys.
      const colorKeys = new Set<string>(APPEARANCE_SETTINGS.map((setting) => setting.key));
      const next = { ...current, theme: { ...current.theme } };
      for (const key of Object.keys(saved.theme) as (keyof SiteTheme)[]) {
        if (!colorKeys.has(key)) (next.theme as Record<string, unknown>)[key] = saved.theme[key];
      }
      return next;
    }
    if (section === "templates") return current;
    const keys: Array<keyof Identity> = section === "brand"
      ? ["name", "shortName", "tagline", "description", "publicUrl", "supportEmail", "copyrightText"]
      : section === "assets"
        ? ["logoUrl", "wordmarkUrl", "footerLogoUrl", "faviconUrl", "appleIconUrl"]
        : ["forumLabel", "knowledgeBaseLabel", "trustedVendorLabel"];
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

      <div className="grid gap-5 xl:grid-cols-[230px_minmax(0,1fr)_minmax(320px,.7fr)]">
        <nav className="ui-card h-fit space-y-2" aria-label="Appearance sections">
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

            {section === "brand" ? <div className="grid gap-4 sm:grid-cols-2"><TextField label="Site name" value={form.identity.name} onChange={(value) => setIdentity("name", value)} /><TextField label="Short name" value={form.identity.shortName} onChange={(value) => setIdentity("shortName", value)} /><TextField label="Tagline" value={form.identity.tagline} onChange={(value) => setIdentity("tagline", value)} wide /><TextField label="SEO / site description" value={form.identity.description} onChange={(value) => setIdentity("description", value)} wide /><TextField label="Public site URL" value={form.identity.publicUrl} onChange={(value) => setIdentity("publicUrl", value)} /><TextField label="Support email" value={form.identity.supportEmail} onChange={(value) => setIdentity("supportEmail", value)} /><TextField label="Copyright text" value={form.identity.copyrightText} onChange={(value) => setIdentity("copyrightText", value)} wide /></div> : null}
            {section === "assets" ? <div className="grid gap-4 sm:grid-cols-2"><TextField label="Header logo" value={form.identity.logoUrl} onChange={(value) => setIdentity("logoUrl", value)} /><TextField label="Wordmark (optional)" value={form.identity.wordmarkUrl} onChange={(value) => setIdentity("wordmarkUrl", value)} /><TextField label="Footer logo" value={form.identity.footerLogoUrl} onChange={(value) => setIdentity("footerLogoUrl", value)} /><TextField label="Browser favicon" value={form.identity.faviconUrl} onChange={(value) => setIdentity("faviconUrl", value)} /><TextField label="Apple / mobile icon" value={form.identity.appleIconUrl} onChange={(value) => setIdentity("appleIconUrl", value)} /></div> : null}
            {section === "wording" ? <div className="grid gap-4 sm:grid-cols-2"><TextField label="Community label" value={form.identity.forumLabel} onChange={(value) => setIdentity("forumLabel", value)} /><TextField label="Projects label" value={form.identity.knowledgeBaseLabel} onChange={(value) => setIdentity("knowledgeBaseLabel", value)} /><TextField label="Trusted vendor label" value={form.identity.trustedVendorLabel} onChange={(value) => setIdentity("trustedVendorLabel", value)} /></div> : null}

            {section === "colors" ? (
              <ColorSection
                form={form}
                query={colorQuery}
                onQueryChange={setColorQuery}
                onChange={(setting, value) =>
                  setting.key === "primaryColor"
                    ? setForm((current) => ({ ...current, primaryColor: value }))
                    : setting.key === "accentColor"
                      ? setForm((current) => ({ ...current, accentColor: value }))
                      : setTheme(setting.key as keyof SiteTheme, value as never)
                }
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

            {section === "styles" ? <>
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
                <Choice label="Tabs" value={form.theme.tabStyle} values={["soft", "framed", "underline"]} onChange={(value) => setTheme("tabStyle", value as SiteTheme["tabStyle"])} />
                <Choice label="Cards & panels" value={form.theme.cardStyle} values={["soft", "solid", "outline", "elevated"]} onChange={(value) => setTheme("cardStyle", value as SiteTheme["cardStyle"])} />
                <Choice label="Inputs" value={form.theme.inputStyle} values={["soft", "solid", "outline", "filled"]} onChange={(value) => setTheme("inputStyle", value as SiteTheme["inputStyle"])} />
                <Choice label="Surface shadows" value={form.theme.shadowStyle} values={["none", "soft", "glow"]} onChange={(value) => setTheme("shadowStyle", value as SiteTheme["shadowStyle"])} />
                <Choice label="Border contrast" value={form.theme.borderStrength} values={["subtle", "standard", "strong"]} onChange={(value) => setTheme("borderStrength", value as SiteTheme["borderStrength"])} />
              </AppearanceGroup>

              {/* The navbar's own shape controls live beside the navbar, not in a
                  list of general component styles. "Navbar style" sitting between
                  "Inputs" and "Surface shadows" was how a storefront-only control
                  ended up reading as a site-wide one. */}
              <AppearanceGroup title="Navigation bar — storefront only" description="Classic restores the original KeyMoura header. None of these touch the staff sidebar.">
                <Choice label="Navbar style" value={form.theme.publicNavigationStyle} values={["classic", "soft", "framed", "minimal"]} onChange={(value) => setTheme("publicNavigationStyle", value as SiteTheme["publicNavigationStyle"])} />
                <Choice label="Scroll behavior" value={form.theme.navigationBehavior} values={["auto-hide", "sticky"]} onChange={(value) => setTheme("navigationBehavior", value as SiteTheme["navigationBehavior"])} />
                <Choice label="Navbar spacing" value={form.theme.navigationDensity} values={["compact", "comfortable"]} onChange={(value) => setTheme("navigationDensity", value as SiteTheme["navigationDensity"])} />
                <NavbarPreview form={form} />
              </AppearanceGroup>

              <AppearanceGroup title="Staff area only" description="Changes these admin screens. Customers never see it.">
                <Choice label="Staff sidebar" value={form.theme.navigationStyle} values={["soft", "framed", "minimal"]} onChange={(value) => setTheme("navigationStyle", value as SiteTheme["navigationStyle"])} />
              </AppearanceGroup>
            </> : null}
          </section>

          <button type="button" onClick={resetSection} className="ui-btn ui-btn-ghost">Reset this section</button>
        </div>

        <AppearancePreview form={form} />
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
}: {
  form: Appearance;
  query: string;
  onQueryChange: (value: string) => void;
  onChange: (setting: AppearanceSetting, value: string) => void;
}) {
  const matches = searchAppearanceSettings(query);
  const matched = new Set(matches.map((setting) => setting.key));
  const groups = APPEARANCE_GROUPS.map((group) => ({
    ...group,
    settings: matches.filter((setting) => setting.group === group.id),
  })).filter((group) => group.settings.length > 0);

  const valueOf = (setting: AppearanceSetting) =>
    setting.key === "primaryColor"
      ? form.primaryColor
      : setting.key === "accentColor"
        ? form.accentColor
        : (form.theme[setting.key as keyof SiteTheme] as string);

  return (
    <>
      <div>
        <label className="block">
          <span className="ui-label">Search colours</span>
          <input
            type="search"
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder="Try: cart, badge, button, customizable, navbar, input"
            className="ui-input"
          />
        </label>
        <p aria-live="polite" className="mt-2 text-xs text-brand-textMuted">
          {query.trim()
            ? `${matched.size} of ${APPEARANCE_SETTINGS.length} colours match “${query.trim()}”.`
            : `${APPEARANCE_SETTINGS.length} colours, grouped by what they change.`}
        </p>
      </div>

      {groups.length === 0 ? (
        <p className="ui-empty-state">
          Nothing matches “{query.trim()}”. Try the name of something you can see on the site — “cart”, “price”,
          “badge”, “menu”.
        </p>
      ) : null}

      {groups.map((group) => (
        <AppearanceGroup
          key={group.id}
          title={group.label}
          description={group.description}
          scope={SCOPE_LABEL[group.scope]}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            {group.settings.map((setting) => (
              <SettingField
                key={setting.key}
                setting={setting}
                value={valueOf(setting)}
                // What the element renders as while the setting is unset. Every
                // optional setting today follows the accent, so that is the
                // honest swatch to show.
                inherited={form.accentColor}
                onChange={(value) => onChange(setting, value)}
              />
            ))}
          </div>
        </AppearanceGroup>
      ))}
    </>
  );
}

/**
 * One colour, with the thing it changes stated beside it.
 *
 * `Used for` is the whole point. A label alone ("Secondary button text") only
 * works for somebody who already knows the vocabulary; the list underneath is
 * what lets an owner recognise the control for the button they are looking at.
 */
function SettingField({
  setting,
  value,
  inherited,
  onChange,
}: {
  setting: AppearanceSetting;
  value: string;
  /** What this element renders as today when the setting is left unset. */
  inherited: string;
  onChange: (value: string) => void;
}) {
  const describedBy = `appearance-help-${setting.key}`;
  const isUnset = Boolean(setting.optional) && !value;

  return (
    <div className="rounded-[var(--control-radius)] border border-brand-border p-3">
      <label className="block">
        <span className="ui-label">{setting.label}</span>
        <span className="flex gap-2">
          {/*
            An unset optional setting shows the colour it currently *renders* as,
            so the swatch is never a lie — but the text field beside it stays
            empty and the caption says it is following something else. A picker
            pre-filled with a stored-looking hex would make "unset" indis-
            tinguishable from "set to exactly the accent", and the two behave
            differently the next time the palette changes.
          */}
          <input
            type="color"
            value={value || inherited}
            aria-label={`${setting.label} colour picker`}
            onChange={(event) => onChange(event.target.value)}
            className="ui-color-input"
          />
          <input
            value={value}
            aria-describedby={describedBy}
            placeholder={isUnset ? "Automatic" : undefined}
            onChange={(event) => onChange(event.target.value)}
            className="ui-input font-mono uppercase"
            maxLength={7}
          />
          {setting.optional && value ? (
            <button
              type="button"
              onClick={() => onChange("")}
              className="ui-btn ui-btn-ghost !px-2 text-xs"
              title={`Go back to following ${setting.optional.inheritsFrom}`}
            >
              Clear
            </button>
          ) : null}
        </span>
      </label>
      <p id={describedBy} className="mt-2 text-xs text-brand-textMuted">
        {setting.description}
      </p>
      <p className="mt-2 text-xs text-brand-textMuted">
        <span className="font-semibold text-brand-text">Used for: </span>
        {setting.usedBy.join(" · ")}
      </p>
      {isUnset && setting.optional ? (
        <p className="mt-2 text-xs text-brand-textMuted">
          <b>Automatic</b> — following {setting.optional.inheritsFrom}. Pick a colour to set it on its own.
        </p>
      ) : null}
      {setting.shared ? (
        <p className="mt-2 text-xs text-amber-300">
          Shared — changing this moves everything listed above at once.
        </p>
      ) : null}
    </div>
  );
}

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

function PreviewBlock({ title, note, children }: { title: string; note: ReactNode; children: ReactNode }) {
  return (
    <div className="rounded-[var(--control-radius)] border border-brand-border p-3">
      <p className="text-[11px] font-semibold uppercase tracking-[.1em] text-brand-textMuted">{title}</p>
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
function AppearancePreview({ form }: { form: Appearance }) {
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
        note={
          <>
            Primary fill: <b>Primary brand colour</b> · Primary label: <b>Primary button text</b> · Secondary
            label: <b>Secondary button text</b> · Quiet: <b>Body text</b>
          </>
        }
      >
        <div className="ui-action-row">
          <button type="button" className="ui-btn ui-btn-primary">Add to Cart</button>
          <button type="button" className="ui-btn ui-btn-secondary">Request a Custom Version</button>
          <button type="button" className="ui-btn ui-btn-ghost">Cancel</button>
        </div>
      </PreviewBlock>

      <PreviewBlock
        title="Form field"
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

function NavbarPreview({ form }: { form: Appearance }) {
  return <section className="space-y-3"><div><h3 className="text-sm font-semibold">Navbar preview</h3><p className="mt-1 text-xs text-brand-textMuted">Desktop link treatment, the independent navbar palette, and the utility controls on the right.</p></div><div className="site-header-shell rounded-[var(--control-radius)] border px-3 py-2"><div className="flex flex-wrap items-center justify-between gap-2"><div className="flex flex-wrap items-center gap-2"><span className="mr-2 font-semibold text-[var(--km-nav-active)]">{(form.identity.shortName || "KM").slice(0, 2).toUpperCase()}</span>{["About", "Projects", "Catalog", "Community"].map((label) => <span key={label} className={cx("site-nav-link inline-flex items-center border px-3 py-1.5 text-xs font-medium", label === "Projects" && "is-active")}>{label}</span>)}</div><div className="flex flex-wrap items-center gap-2">{["Search", "Messages", "Notifications", "Account", "Staff"].map((label, index) => <span key={label} className={cx("site-nav-utility inline-flex items-center rounded-full border px-3 py-1.5 text-xs font-medium", index === 2 && "is-highlighted")}>{label}</span>)}</div></div></div></section>;
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

function TextField({ label, value, onChange, wide = false }: { label: string; value: string; onChange: (value: string) => void; wide?: boolean }) {
  return <label className={wide ? "block sm:col-span-2" : "block"}><span className="ui-label">{label}</span><input value={value} onChange={(event) => onChange(event.target.value)} className="ui-input" /></label>;
}

function Choice({ label, value, values, onChange }: { label: string; value: string; values: string[]; onChange: (value: string) => void }) {
  return <div><p className="ui-label">{label}</p><div className="grid gap-2 sm:grid-cols-2">{values.map((item) => <button key={item} type="button" aria-pressed={value === item} onClick={() => onChange(item)} className={cx("ui-card ui-card-hover !p-3 text-left", value === item && "!border-brand-primary !bg-brand-primary/10")}><span className={cx("block text-sm font-semibold capitalize", value === item && "text-brand-primary")}>{item}</span><span className="mt-1 block text-xs text-brand-textMuted">{choiceHelp[item] || "Shared site treatment"}</span></button>)}</div></div>;
}
