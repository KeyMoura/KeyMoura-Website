"use client";

import { useEffect, useMemo, useState } from "react";
import { supabaseBrowser } from "@/lib/supabaseClient";

export function OrderReviewGallery({ paths }: { paths: string[] }) {
  const supabase = useMemo(() => supabaseBrowser(), []);
  const [urls, setUrls] = useState<string[]>([]);

  useEffect(() => {
    let active = true;
    void Promise.all(paths.map(async (path) => {
      const { data } = await supabase.storage.from("order-assets").createSignedUrl(path, 3600);
      return data?.signedUrl || "";
    })).then((signed) => { if (active) setUrls(signed.filter(Boolean)); });
    return () => { active = false; };
  }, [paths, supabase]);

  if (!paths.length) return null;
  return <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
    {urls.map((url, index) => <a key={url} href={url} target="_blank" rel="noreferrer" className="group overflow-hidden rounded-xl border border-zinc-700 bg-black/30">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={url} alt={`Finished product review ${index + 1}`} className="aspect-square w-full object-cover transition group-hover:scale-[1.02]" />
    </a>)}
  </div>;
}
