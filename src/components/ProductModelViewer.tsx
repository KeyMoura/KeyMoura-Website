"use client";

import { createElement, useEffect } from "react";

export function ProductModelViewer({ src, poster, alt }: { src: string; poster?: string | null; alt: string }) {
  useEffect(() => {
    void import("@google/model-viewer");
  }, []);

  return createElement("model-viewer", {
    src, poster: poster || undefined, alt,
    "camera-controls": true, "auto-rotate": true,
    "shadow-intensity": "1", exposure: "1",
    className: "h-full min-h-80 w-full rounded-2xl bg-zinc-950",
  });
}
