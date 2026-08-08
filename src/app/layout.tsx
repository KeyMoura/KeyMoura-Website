import type { CSSProperties } from "react";
import type { Metadata } from "next";
import "./globals.css";
import ReactQueryProvider from "./ReactQueryProvider";
import SiteHeader from "@/components/SiteHeader";
import CommandPalette from "@/components/CommandPalette";
import { LastSeenUpdater } from "@/components/LastSeenUpdater";
import SiteFooter from "@/components/SiteFooter";
import GlobalLockdownGate from "@/components/GlobalLockdownGate";
import SiteBroadcastBanner from "@/components/SiteBroadcastBanner";
import { SpeedInsights } from "@vercel/speed-insights/next";
import { Analytics } from "@vercel/analytics/next";
import { BlocksProvider } from "@/components/BlocksProvider";
import { getSiteSettings } from "@/lib/siteSettings";
import { optionalVars } from "@/theme/runtime";
import { SiteSettingsProvider } from "@/components/SiteSettingsProvider";

export async function generateMetadata(): Promise<Metadata> {
  const settings = await getSiteSettings();
  // The default title follows the configured tagline rather than a hard-coded
  // product line, so renaming the business in Appearance renames its metadata.
  const defaultTitle = settings.tagline ? `${settings.name} — ${settings.tagline}` : settings.name;
  return {
    title: { default: defaultTitle, template: `%s | ${settings.name}` },
    description: settings.description,
    metadataBase: new URL(settings.url),
    applicationName: settings.name,
    icons: {
      icon: settings.faviconUrl,
      shortcut: settings.faviconUrl,
      apple: settings.appleIconUrl,
    },
    openGraph: { type: "website", siteName: settings.name, title: defaultTitle, description: settings.description, url: settings.url, images: settings.logoUrl ? [{ url: settings.logoUrl }] : [] },
    twitter: { card: "summary_large_image", title: defaultTitle, description: settings.description, images: settings.logoUrl ? [settings.logoUrl] : [] },
  };
}

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const settings = await getSiteSettings();
  const brandStyles = {
    "--brand-primary": settings.primaryColor,
    "--brand-accent": settings.accentColor,
    "--km-bg": settings.theme.background,
    "--km-bg-end": settings.theme.backgroundEnd,
    "--km-surface": settings.theme.surface,
    "--km-surface-strong": settings.theme.surfaceStrong,
    "--km-text": settings.theme.text,
    "--km-muted": settings.theme.mutedText,
    "--km-heading": settings.theme.headingText,
    "--km-link": settings.theme.linkText,
    "--km-border": settings.theme.border,
    "--km-primary-button-text": settings.theme.primaryButtonText,
    "--km-secondary-button-text": settings.theme.secondaryButtonText,
    "--km-nav-bg": settings.theme.navigationBackground,
    "--km-nav-text": settings.theme.navigationText,
    "--km-nav-active": settings.theme.navigationActiveText,
    "--km-nav-border": settings.theme.navigationBorder,
    "--km-nav-util-bg": settings.theme.navigationUtilityBackground,
    "--km-nav-util-border": settings.theme.navigationUtilityBorder,
    "--km-nav-util-text": settings.theme.navigationUtilityText,
    "--km-nav-util-hover-bg": settings.theme.navigationUtilityHoverBackground,
    "--km-nav-util-hover-border": settings.theme.navigationUtilityHoverBorder,
    "--km-nav-util-hover-text": settings.theme.navigationUtilityHoverText,
    "--km-nav-hover-bg": settings.theme.navigationHoverBackground,
    "--km-nav-hover-text": settings.theme.navigationHoverText,
    "--km-nav-badge-bg": settings.theme.navigationBadgeBackground,
    "--km-nav-badge-text": settings.theme.navigationBadgeText,
    "--km-nav-mobile-bg": settings.theme.navigationMobileBackground,
    "--km-nav-mobile-text": settings.theme.navigationMobileText,
    /*
     * The five optional overrides. An unset value must not be emitted at all:
     * `var(--km-badge-bg, var(--accent-soft))` only reaches its fallback when
     * the custom property is genuinely absent, and an empty string is still
     * "present" as far as `var()` is concerned. Spreading a conditional object
     * is what keeps "unset" meaning "follow the accent" rather than "no colour".
     */
    ...optionalVars({
      "--km-badge-bg": settings.theme.badgeBackground,
      "--km-badge-text": settings.theme.badgeText,
      "--km-badge-border": settings.theme.badgeBorder,
      "--km-secondary-button-bg": settings.theme.secondaryButtonBackground,
      "--km-secondary-button-border": settings.theme.secondaryButtonBorder,
    }),
  } as CSSProperties;

  return (
    <html lang="en" style={brandStyles} data-radius={settings.theme.radius} data-density={settings.theme.density} data-font={settings.theme.font} data-primary-button-style={settings.theme.primaryButtonStyle} data-secondary-button-style={settings.theme.secondaryButtonStyle} data-tab-style={settings.theme.tabStyle} data-card-style={settings.theme.cardStyle} data-input-style={settings.theme.inputStyle} data-navigation-style={settings.theme.navigationStyle} data-public-navigation-style={settings.theme.publicNavigationStyle} data-navigation-density={settings.theme.navigationDensity} data-background-style={settings.theme.backgroundStyle} data-content-width={settings.theme.contentWidth} data-shadow-style={settings.theme.shadowStyle} data-border-strength={settings.theme.borderStrength}>
      <body className="min-h-screen text-brand-text antialiased">
        {/*
          Enables scroll reveals before first paint, so revealed content never
          flashes in and then hides itself. If this never runs — no scripting,
          a thrown error, or reduced motion — the attribute stays absent and
          every .reveal element renders in its final visible state.
        */}
        <script
          dangerouslySetInnerHTML={{
            __html:
              "try{if(!matchMedia('(prefers-reduced-motion: reduce)').matches){document.documentElement.dataset.motion='on'}}catch(e){}",
          }}
        />
        <a className="skip-link" href="#main-content">
          Skip to main content
        </a>
        <SiteSettingsProvider settings={settings}>
        <LastSeenUpdater />
        <ReactQueryProvider>
          <BlocksProvider>
            <GlobalLockdownGate>
              <div className="flex min-h-screen flex-col">
                <SiteHeader />
                <SiteBroadcastBanner />
                <CommandPalette />
                <main id="main-content" className="flex-1" tabIndex={-1}>
                  {children}
                </main>
                <SiteFooter />
                <SpeedInsights />
                <Analytics />
              </div>
            </GlobalLockdownGate>
          </BlocksProvider>
        </ReactQueryProvider>
        </SiteSettingsProvider>
      </body>
    </html>
  );
}
