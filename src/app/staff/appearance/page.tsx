"use client";

import Image from "next/image";
import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";

import { Badge, MetricCard, Notice, cx } from "@/components/ui/DesignSystem";
import { defaultSiteTheme, type SiteTheme } from "@/theme/runtime";

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

type Section = "brand" | "assets" | "wording" | "navigation" | "theme";

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

const presets: Record<string, Pick<Appearance, "primaryColor" | "accentColor" | "theme">> = {
  KeyMoura: defaults,
  Ember: {
    primaryColor: "#fb923c",
    accentColor: "#facc15",
    theme: { ...defaultSiteTheme, background: "#110c08", backgroundEnd: "#070504", surface: "#21140d", surfaceStrong: "#2b1a10" },
  },
  Graphite: {
    primaryColor: "#e4e4e7",
    accentColor: "#fbbf24",
    theme: { ...defaultSiteTheme, background: "#09090b", backgroundEnd: "#030303", surface: "#18181b", surfaceStrong: "#27272a" },
  },
};

const sectionCopy: Record<Section, { label: string; description: string }> = {
  brand: { label: "Brand & business", description: "Business name, public details, metadata, and support information." },
  assets: { label: "Logos & icons", description: "Header, footer, browser, and mobile brand artwork." },
  wording: { label: "Labels & wording", description: "Names customers see for the major areas of the site." },
  navigation: { label: "Navbar", description: "Restore the classic header or customize its colors and behavior independently." },
  theme: { label: "Colors & controls", description: "One shared visual language for storefront, account, orders, and staff tools." },
};

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

  const dirty = JSON.stringify(form) !== JSON.stringify(saved);
  const warning = useMemo(() => {
    if (contrast(form.theme.text, form.theme.background) < 4.5) return "Body text needs more contrast against the background.";
    if (contrast(form.theme.headingText, form.theme.background) < 4.5) return "Heading text needs more contrast against the background.";
    if (contrast(form.theme.mutedText, form.theme.background) < 3) return "Muted text needs more contrast against the background.";
    if (contrast(form.theme.navigationText, form.theme.navigationBackground) < 4.5) return "Navbar text needs more contrast against the navbar background.";
    if (contrast(form.theme.navigationActiveText, form.theme.navigationBackground) < 3) return "The active navbar link needs more contrast against the navbar background.";
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
  } as CSSProperties;

  const setTheme = <Key extends keyof SiteTheme>(key: Key, value: SiteTheme[Key]) =>
    setForm((current) => ({ ...current, theme: { ...current.theme, [key]: value } }));
  const setIdentity = (key: keyof Identity, value: string) =>
    setForm((current) => ({ ...current, identity: { ...current.identity, [key]: value } }));

  const resetSection = () => setForm((current) => {
    if (section === "theme") return { ...current, primaryColor: saved.primaryColor, accentColor: saved.accentColor, theme: saved.theme };
    if (section === "navigation") {
      const keys = ["publicNavigationStyle", "navigationBehavior", "navigationDensity", "navigationBackground", "navigationText", "navigationActiveText", "navigationBorder"] as const;
      return { ...current, theme: { ...current.theme, ...Object.fromEntries(keys.map((key) => [key, saved.theme[key]])) } };
    }
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

            {section === "navigation" ? <>
              <AppearanceGroup title="Public navbar" description="Classic restores the original KeyMoura header. These controls are independent from the staff sidebar.">
                <Choice label="Navbar style" value={form.theme.publicNavigationStyle} values={["classic", "soft", "framed", "minimal"]} onChange={(value) => setTheme("publicNavigationStyle", value as SiteTheme["publicNavigationStyle"])} />
                <Choice label="Scroll behavior" value={form.theme.navigationBehavior} values={["auto-hide", "sticky"]} onChange={(value) => setTheme("navigationBehavior", value as SiteTheme["navigationBehavior"])} />
                <Choice label="Navbar spacing" value={form.theme.navigationDensity} values={["compact", "comfortable"]} onChange={(value) => setTheme("navigationDensity", value as SiteTheme["navigationDensity"])} />
              </AppearanceGroup>
              <AppearanceGroup title="Navbar colors" description="Change the header without recoloring cards, buttons, or page content.">
                <div className="grid gap-4 sm:grid-cols-2"><ColorField label="Navbar background" value={form.theme.navigationBackground} onChange={(value) => setTheme("navigationBackground", value)} /><ColorField label="Navbar text" value={form.theme.navigationText} onChange={(value) => setTheme("navigationText", value)} /><ColorField label="Active link" value={form.theme.navigationActiveText} onChange={(value) => setTheme("navigationActiveText", value)} /><ColorField label="Navbar border" value={form.theme.navigationBorder} onChange={(value) => setTheme("navigationBorder", value)} /></div>
              </AppearanceGroup>
              <NavbarPreview form={form} />
            </> : null}

            {section === "theme" ? <>
              <AppearanceGroup title="Starting point" description="Apply a coordinated palette, then tune any component below.">
                <div className="grid gap-3 sm:grid-cols-3">{Object.entries(presets).map(([name, preset]) => <button key={name} type="button" onClick={() => setForm((current) => ({ ...current, ...preset }))} className="ui-card ui-card-hover text-left"><span className="flex gap-1.5"><span className="size-5 rounded-full border border-white/20" style={{ background: preset.primaryColor }} /><span className="size-5 rounded-full border border-white/20" style={{ background: preset.accentColor }} /></span><span className="mt-3 block text-sm font-semibold">{name}</span><span className="mt-1 block text-xs text-brand-textMuted">Apply palette</span></button>)}</div>
              </AppearanceGroup>

              <AppearanceGroup title="Layout & type" description="Set the overall density and silhouette used everywhere.">
                <Choice label="Page background" value={form.theme.backgroundStyle} values={["gradient", "solid", "spotlight"]} onChange={(value) => setTheme("backgroundStyle", value as SiteTheme["backgroundStyle"])} />
                <Choice label="Content width" value={form.theme.contentWidth} values={["standard", "wide", "full"]} onChange={(value) => setTheme("contentWidth", value as SiteTheme["contentWidth"])} />
                <Choice label="Spacing" value={form.theme.density} values={["compact", "comfortable"]} onChange={(value) => setTheme("density", value as SiteTheme["density"])} />
                <Choice label="Typography" value={form.theme.font} values={["system", "modern", "technical"]} onChange={(value) => setTheme("font", value as SiteTheme["font"])} />
                <Choice label="Corner shape" value={form.theme.radius} values={["soft", "rounded", "pill"]} onChange={(value) => setTheme("radius", value as SiteTheme["radius"])} />
              </AppearanceGroup>

              <AppearanceGroup title="Components" description="These controls now drive the same shared components on every major screen.">
                <Choice label="Primary buttons" value={form.theme.primaryButtonStyle} values={["solid", "soft", "outline", "framed"]} onChange={(value) => setTheme("primaryButtonStyle", value as SiteTheme["primaryButtonStyle"])} />
                <Choice label="Secondary buttons" value={form.theme.secondaryButtonStyle} values={["solid", "soft", "outline", "ghost", "framed"]} onChange={(value) => setTheme("secondaryButtonStyle", value as SiteTheme["secondaryButtonStyle"])} />
                <Choice label="Tabs" value={form.theme.tabStyle} values={["soft", "framed", "underline"]} onChange={(value) => setTheme("tabStyle", value as SiteTheme["tabStyle"])} />
                <Choice label="Cards & panels" value={form.theme.cardStyle} values={["soft", "solid", "outline", "elevated"]} onChange={(value) => setTheme("cardStyle", value as SiteTheme["cardStyle"])} />
                <Choice label="Inputs" value={form.theme.inputStyle} values={["soft", "solid", "outline", "filled"]} onChange={(value) => setTheme("inputStyle", value as SiteTheme["inputStyle"])} />
                <Choice label="Staff navigation" value={form.theme.navigationStyle} values={["soft", "framed", "minimal"]} onChange={(value) => setTheme("navigationStyle", value as SiteTheme["navigationStyle"])} />
                <Choice label="Surface shadows" value={form.theme.shadowStyle} values={["none", "soft", "glow"]} onChange={(value) => setTheme("shadowStyle", value as SiteTheme["shadowStyle"])} />
                <Choice label="Border contrast" value={form.theme.borderStrength} values={["subtle", "standard", "strong"]} onChange={(value) => setTheme("borderStrength", value as SiteTheme["borderStrength"])} />
              </AppearanceGroup>

              <AppearanceGroup title="Brand colors" description="The two colors used for actions, selections, links, and navigation.">
                <div className="grid gap-4 sm:grid-cols-2"><ColorField label="Primary actions" value={form.primaryColor} onChange={(value) => setForm((current) => ({ ...current, primaryColor: value }))} /><ColorField label="Accent / selected states" value={form.accentColor} onChange={(value) => setForm((current) => ({ ...current, accentColor: value }))} /></div>
                <details className="ui-card mt-4"><summary className="cursor-pointer font-semibold">Advanced palette</summary><p className="mt-1 text-xs text-brand-textMuted">Fine-tune surfaces and text only when the preset needs adjustment.</p><div className="mt-4 grid gap-4 sm:grid-cols-2">{([ ["background", "Page background"], ["backgroundEnd", "Background gradient end"], ["surface", "Cards and panels"], ["surfaceStrong", "Inputs and raised panels"], ["text", "Body text"], ["headingText", "Headings"], ["mutedText", "Muted text"], ["linkText", "Links"], ["border", "Borders"], ["primaryButtonText", "Primary button text"], ["secondaryButtonText", "Secondary button text"] ] as const).map(([key, label]) => <ColorField key={key} label={label} value={form.theme[key]} onChange={(value) => setTheme(key, value)} />)}</div></details>
              </AppearanceGroup>
            </> : null}
          </section>

          <button type="button" onClick={resetSection} className="ui-btn ui-btn-ghost">Reset this section</button>
        </div>

        <AppearancePreview form={form} />
      </div>

      <div className="fixed inset-x-0 bottom-0 z-30 border-t border-brand-border bg-black/90 px-4 py-3 backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4"><p className="text-sm text-brand-textMuted">{dirty ? "You have unpublished appearance changes." : "Appearance is up to date."}</p><div className="ui-action-row"><button type="button" onClick={() => setForm(saved)} disabled={!dirty} className="ui-btn ui-btn-ghost">Discard changes</button><button type="button" onClick={() => void save()} disabled={!dirty || Boolean(warning)} className="ui-btn ui-btn-primary">Publish appearance</button></div></div>
      </div>
    </main>
  );
}

function AppearancePreview({ form }: { form: Appearance }) {
  return <section className="ui-preview ui-card sticky top-5 h-fit space-y-4" aria-label="Live appearance preview">
    <div className="flex items-center gap-3">{form.identity.logoUrl ? <Image src={form.identity.logoUrl} alt="" width={48} height={48} unoptimized className="h-12 w-12 object-contain" /> : null}<div><p className="ui-eyebrow">Live preview</p><h2 className="text-2xl font-semibold">{form.identity.shortName || form.identity.name}</h2><p className="text-sm text-brand-textMuted">{form.identity.tagline}</p></div></div>
    <div className="ui-tabs w-full" role="tablist" aria-label="Preview tabs"><button type="button" role="tab" aria-selected="true" className="ui-tab is-active">Overview</button><button type="button" role="tab" aria-selected="false" className="ui-tab">Orders</button><button type="button" role="tab" aria-selected="false" className="ui-tab">Activity</button></div>
    <div className="grid grid-cols-2 gap-3"><MetricCard label="Active orders" value="12" detail="3 need attention" /><MetricCard label="Revenue" value="$1,240" detail="Last 30 days" /></div>
    <div className="ui-stepper"><div className="ui-step is-complete" data-step="1">Request</div><div className="ui-step is-current" data-step="2">Quote</div><div className="ui-step" data-step="3">Build</div></div>
    <Notice tone="warning">One order needs your approval.</Notice>
    <div className="ui-card"><div className="flex items-start justify-between gap-3"><div><p className="font-semibold">Custom shift knob</p><p className="mt-1 text-xs text-brand-textMuted">Shared cards, labels, borders, and actions update immediately.</p></div><Badge tone="accent">In review</Badge></div><label className="mt-4 block"><span className="ui-label">Customer notes</span><input className="ui-input" placeholder="Add a note…" /></label><div className="ui-action-row mt-4"><button type="button" className="ui-btn ui-btn-primary">Primary action</button><button type="button" className="ui-btn ui-btn-secondary">Secondary action</button><button type="button" className="ui-btn ui-btn-ghost">Quiet action</button></div></div>
  </section>;
}

function NavbarPreview({ form }: { form: Appearance }) {
  return <section className="space-y-3"><div><h3 className="text-sm font-semibold">Navbar preview</h3><p className="mt-1 text-xs text-brand-textMuted">Desktop link treatment and the independent navbar palette.</p></div><div className="site-header-shell rounded-[var(--control-radius)] border px-3 py-2"><div className="flex flex-wrap items-center justify-center gap-2"><span className="mr-2 font-semibold text-[var(--km-nav-active)]">{(form.identity.shortName || "KM").slice(0, 2).toUpperCase()}</span>{["About", "Projects", "Catalog", "Community"].map((label) => <span key={label} className={cx("site-nav-link inline-flex items-center border px-3 py-1.5 text-xs font-medium", label === "Projects" && "is-active")}>{label}</span>)}</div></div></section>;
}

function SectionTitle({ title, text }: { title: string; text: string }) {
  return <div><h2 className="text-lg font-semibold">{title}</h2><p className="mt-1 text-sm text-brand-textMuted">{text}</p></div>;
}

function AppearanceGroup({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return <fieldset className="rounded-[var(--control-radius)] border border-brand-border p-4"><legend className="px-2 text-sm font-semibold">{title}</legend><p className="mb-4 text-xs text-brand-textMuted">{description}</p><div className="space-y-5">{children}</div></fieldset>;
}

function TextField({ label, value, onChange, wide = false }: { label: string; value: string; onChange: (value: string) => void; wide?: boolean }) {
  return <label className={wide ? "block sm:col-span-2" : "block"}><span className="ui-label">{label}</span><input value={value} onChange={(event) => onChange(event.target.value)} className="ui-input" /></label>;
}

function ColorField({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return <label className="block"><span className="ui-label">{label}</span><span className="flex gap-2"><input type="color" value={value} onChange={(event) => onChange(event.target.value)} className="ui-color-input" /><input value={value} onChange={(event) => onChange(event.target.value)} className="ui-input font-mono uppercase" maxLength={7} /></span></label>;
}

function Choice({ label, value, values, onChange }: { label: string; value: string; values: string[]; onChange: (value: string) => void }) {
  return <div><p className="ui-label">{label}</p><div className="grid gap-2 sm:grid-cols-2">{values.map((item) => <button key={item} type="button" aria-pressed={value === item} onClick={() => onChange(item)} className={cx("ui-card ui-card-hover !p-3 text-left", value === item && "!border-brand-primary !bg-brand-primary/10")}><span className={cx("block text-sm font-semibold capitalize", value === item && "text-brand-primary")}>{item}</span><span className="mt-1 block text-xs text-brand-textMuted">{choiceHelp[item] || "Shared site treatment"}</span></button>)}</div></div>;
}
