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
import { siteConfig } from "@/site.config";

export const metadata: Metadata = {
  title: siteConfig.identity.name,
  description: siteConfig.identity.description,
  metadataBase: new URL(siteConfig.identity.url),
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-gradient-to-b from-brand-bgStart to-brand-bgEnd text-brand-text antialiased">
        <a className="skip-link" href="#main-content">
          Skip to main content
        </a>
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
      </body>
    </html>
  );
}
