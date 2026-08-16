import type { CSSProperties } from "react";
import type { Metadata } from "next";
import "./globals.css";
import ReactQueryProvider from "./ReactQueryProvider";
import SiteHeader from "@/components/SiteHeader";
import CartDrawerProvider from "@/components/commerce/CartDrawerProvider";
import CommandPalette from "@/components/CommandPalette";
import { LastSeenUpdater } from "@/components/LastSeenUpdater";
import SiteFooter from "@/components/SiteFooter";
import GlobalLockdownGate from "@/components/GlobalLockdownGate";
import SiteBroadcastBanner from "@/components/SiteBroadcastBanner";
import AnnouncementBar from "@/components/AnnouncementBar";
import { isAnnouncementVisible } from "@/theme/announcement";
import { SpeedInsights } from "@vercel/speed-insights/next";
import { Analytics } from "@vercel/analytics/next";
import { BlocksProvider } from "@/components/BlocksProvider";
import { getSiteSettings } from "@/lib/siteSettings";
import { loadStorefrontNav } from "@/lib/commerce/storefrontNav";
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
  /*
   * The header's category dropdown is rendered from the same hierarchy the
   * catalog uses, loaded here so it is server-rendered rather than fetched
   * after hydration — a menu that pops into existence a second late is a menu
   * customers stop reaching for. Two small queries, and a failure returns an
   * empty menu so Products stays a working link to /catalog regardless.
   */
  const [settings, productsNav] = await Promise.all([getSiteSettings(), loadStorefrontNav()]);
  /*
   * The scheduling window is evaluated here, on the server, so the browser is
   * never handed a start and end time to compare against its own clock — a
   * client-side check would disagree with the server-rendered markup on the
   * first frame and would trust a clock the shop does not control.
   *
   * The cost is that the answer is only as fresh as the page's cache entry: on
   * a route with `revalidate = 300` a promo can start up to five minutes late.
   * For launch notices and weekend sales that is the right trade against making
   * every storefront page dynamic.
   */
  const announcementVisible = isAnnouncementVisible(settings.announcement);
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
      "--km-primary-button-bg": settings.theme.primaryButtonBackground,
      "--km-primary-button-border": settings.theme.primaryButtonBorder,
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
              {/*
                The cart drawer is mounted here, above both the header that opens
                it and the catalog pages that open it after an add — which is the
                only place that is above both. Inside the lockdown gate, so a
                locked site does not carry a cart dialog behind its password
                screen; inside the query provider, because the drawer reads the
                same canonical cart the header's badge reads.
              */}
              <CartDrawerProvider>
                <div className="flex min-h-screen flex-col">
                  <SiteHeader productsNav={productsNav} />
                  {/*
                    Two bars, in order of urgency, and both below the header
                    rather than above it.

                    Above would be the conventional place for a storefront
                    announcement, and it is not available here: the header is
                    `sticky top-0`, and `--km-header-height` is what the mobile
                    drawer offsets by, the sticky purchase panel subtracts, and
                    the staff rail sizes against. Anything inserted above the bar
                    pushes it out of its own coordinate system and every one of
                    those goes wrong together.

                    The emergency banner is second because it is the louder of
                    the two and, when it is showing at all, the one that should
                    be closest to the page content. It reads the security table;
                    the announcement reads Appearance. See `theme/announcement.ts`
                    for why those stayed separate.
                  */}
                  {announcementVisible ? <AnnouncementBar config={settings.announcement} /> : null}
                  <SiteBroadcastBanner />
                  <CommandPalette />
                  <main id="main-content" className="flex-1" tabIndex={-1}>
                    {children}
                  </main>
                  <SiteFooter />
                  <SpeedInsights />
                  <Analytics />
                </div>
              </CartDrawerProvider>
            </GlobalLockdownGate>
          </BlocksProvider>
        </ReactQueryProvider>
        </SiteSettingsProvider>
      </body>
    </html>
  );
}
