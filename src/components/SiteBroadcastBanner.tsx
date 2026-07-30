// src/components/SiteBroadcastBanner.tsx
"use client";

import { useEffect, useState } from "react";
import { supabaseBrowser } from "@/lib/supabaseClient";

type BannerLevel = "info" | "warning" | "critical";

type FlagsRow = {
  emergency_banner_enabled: boolean;
  emergency_banner_text: string | null;
  emergency_banner_level: string | null;
};

export default function SiteBroadcastBanner() {
  const [enabled, setEnabled] = useState(false);
  const [text, setText] = useState<string>("");
  const [level, setLevel] = useState<BannerLevel>("info");
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    const load = async () => {
      try {
        const supabase = supabaseBrowser();
        const { data, error } = await supabase.rpc(
          "get_site_lockdown_flags"
        );

        if (error) {
          console.error(
            "SiteBroadcastBanner: get_site_lockdown_flags error",
            error
          );
          return;
        }

        if (!data || !Array.isArray(data) || data.length === 0) return;

        const row = data[0] as FlagsRow;

        const isEnabled = !!row.emergency_banner_enabled;
        const bannerText = row.emergency_banner_text ?? "";
        const lvlRaw = (row.emergency_banner_level ?? "info") as string;
        const lvl: BannerLevel = ["info", "warning", "critical"].includes(
          lvlRaw
        )
          ? (lvlRaw as BannerLevel)
          : "info";

        setEnabled(isEnabled && bannerText.trim().length > 0);
        setText(bannerText);
        setLevel(lvl);
        setDismissed(false);
      } catch (e) {
        console.error("SiteBroadcastBanner: unexpected error", e);
      }
    };

    void load();
  }, []);

  const handleClose = () => {
    setDismissed(true);
  };

  if (!enabled || !text.trim() || dismissed) return null;

  // Color styles based on level
  let colorClasses =
    "border-b border-sky-400/70 bg-sky-500/15 text-sky-100"; // info
  if (level === "warning") {
    colorClasses =
      "border-b border-amber-400/80 bg-amber-500/15 text-amber-50";
  } else if (level === "critical") {
    colorClasses =
      "border-b border-red-500/80 bg-red-600/20 text-red-50";
  }

  const label =
    level === "critical"
      ? "CRITICAL"
      : level === "warning"
      ? "WARNING"
      : "INFO";

  return (
    <div className={`w-full ${colorClasses}`}>
      <div className="mx-auto flex max-w-5xl items-center gap-3 px-4 py-2 text-[12px]">
        {/* Severity pill */}
        <span className="inline-flex flex-shrink-0 items-center rounded-full border border-white/40 px-2 py-[2px] text-[10px] font-semibold uppercase tracking-[0.15em]">
          {label}
        </span>

        {/* Centered text */}
        <p className="flex-1 text-center leading-snug">{text}</p>

        {/* Close button */}
        <button
          type="button"
          onClick={handleClose}
          aria-label="Dismiss banner"
          className="inline-flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full border border-white/30 text-[11px] font-semibold hover:bg-white/15"
        >
          ×
        </button>
      </div>
    </div>
  );
}
