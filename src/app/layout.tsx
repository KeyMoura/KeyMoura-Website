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
import { BlocksProvider } from "@/components/BlocksProvider";
import { getSiteSettings } from "@/lib/siteSettings";
import { SiteSettingsProvider } from "@/components/SiteSettingsProvider";

export async function generateMetadata(): Promise<Metadata> {
  const settings = await getSiteSettings();
  return {
    title: settings.name,
    description: settings.description,
    metadataBase: new URL(settings.url),
    icons: {
      icon: settings.faviconUrl,
      shortcut: settings.faviconUrl,
      apple: settings.appleIconUrl,
    },
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
    "--km-border": settings.theme.border,
  } as CSSProperties;

  return (
    <html lang="en">
      <body style={brandStyles} data-radius={settings.theme.radius} data-density={settings.theme.density} data-font={settings.theme.font} data-button-style={settings.theme.buttonStyle} className="min-h-screen text-brand-text antialiased">
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
              </div>
            </GlobalLockdownGate>
          </BlocksProvider>
        </ReactQueryProvider>
        </SiteSettingsProvider>
      </body>
    </html>
  );
}
