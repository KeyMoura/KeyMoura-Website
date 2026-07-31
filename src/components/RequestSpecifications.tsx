"use client";

import { useMemo, useState } from "react";
import { supabaseBrowser } from "@/lib/supabaseClient";

type SavedOption = { label?: string; value?: unknown; display_value?: unknown; kind?: string; price_adjustment_cents?: number };

export function RequestSpecifications({ specifications }: { specifications: Record<string, unknown> }) {
  const supabase = useMemo(() => supabaseBrowser(), []);
  const [error, setError] = useState("");
  async function download(path: string) {
    setError("");
    const { data, error: signError } = await supabase.storage.from("order-assets").createSignedUrl(path, 60);
    if (signError) return setError(signError.message);
    window.open(data.signedUrl, "_blank", "noopener,noreferrer");
  }
  return <>
    {Object.entries(specifications).filter(([key, value]) => value != null && key !== "estimated_total_cents").map(([key, raw]) => {
      const option = typeof raw === "object" && raw !== null ? raw as SavedOption : null;
      const label = option?.label || key.replaceAll("_", " ");
      const display = option?.display_value ?? option?.value ?? raw;
      return <div key={key}><dt className="capitalize text-brand-textMuted">{label}</dt><dd className="mt-0.5">
        {option?.kind === "file" && typeof option.value === "string" ? <button type="button" onClick={() => void download(option.value as string)} className="text-brand-primary underline decoration-brand-primary/40 underline-offset-4">{String(display)}</button> : String(display === true ? "Yes" : display === false ? "No" : display ?? "—")}
        {option?.price_adjustment_cents ? <span className="ml-2 text-xs text-brand-primary">({option.price_adjustment_cents > 0 ? "+" : "−"}${(Math.abs(option.price_adjustment_cents) / 100).toFixed(2)})</span> : null}
      </dd></div>;
    })}
    {error ? <div className="text-rose-200">{error}</div> : null}
  </>;
}
