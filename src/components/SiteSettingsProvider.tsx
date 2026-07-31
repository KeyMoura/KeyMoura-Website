"use client";

import { createContext, useContext } from "react";
import type { RuntimeSiteSettings } from "@/lib/siteSettings";

const SiteSettingsContext = createContext<RuntimeSiteSettings | null>(null);

export function SiteSettingsProvider({
  settings,
  children,
}: {
  settings: RuntimeSiteSettings;
  children: React.ReactNode;
}) {
  return (
    <SiteSettingsContext.Provider value={settings}>
      {children}
    </SiteSettingsContext.Provider>
  );
}

export function useSiteSettings() {
  const settings = useContext(SiteSettingsContext);
  if (!settings) throw new Error("useSiteSettings must be used inside SiteSettingsProvider");
  return settings;
}
