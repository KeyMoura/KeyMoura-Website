"use client";

import { createElement, useEffect } from "react";

/**
 * The interactive 3D product viewer, and the only place one is constructed.
 *
 * ## The texture disclaimer lives here, not at the call sites
 *
 * Every customer-facing 3D view must permanently say `Textures may not be
 * accurate.` — the models are geometry references, and their surfaces are not a
 * promise about the finish that ships. Putting that sentence in the component
 * that *is* the viewer, rather than beside each place one is used, is what makes
 * the guarantee hold: a future quick-view, configurator or category preview
 * inherits the notice by construction, and there is no second copy of the string
 * to drift or be forgotten. `tests/product-model-viewer.test.ts` asserts both
 * halves — the exact wording, and that no other module renders a model viewer.
 *
 * It is deliberately plain: rendered in normal flow beneath the viewport (never
 * an overlay across the model or its drag surface), always present rather than
 * dismissible, never behind a tooltip, an info icon or a hover state, and styled
 * as quiet secondary text rather than as an error. It is a standing fact about
 * the medium, not an alert about this particular model, so nothing about it is
 * conditional — not on the product, not on the model, not on whether a texture
 * currently looks wrong.
 */

/** The exact customer-facing wording. Asserted by test; do not reword casually. */
export const MODEL_TEXTURE_NOTICE = "Textures may not be accurate.";

export function ProductModelViewer({ src, poster, alt }: { src: string; poster?: string | null; alt: string }) {
  useEffect(() => {
    void import("@google/model-viewer");
  }, []);

  return (
    <div className="product-model-viewer">
      {createElement("model-viewer", {
        src,
        poster: poster || undefined,
        alt,
        "camera-controls": true,
        "auto-rotate": true,
        "shadow-intensity": "1",
        exposure: "1",
        className: "product-model-viewer-stage",
      })}
      {/*
        Not `role="alert"` and not `aria-live`: it never changes, so announcing
        it as a live region would interrupt a screen reader for news that is
        already in the reading order. It is ordinary text, read in place.
      */}
      <p className="product-model-viewer-notice">{MODEL_TEXTURE_NOTICE}</p>
    </div>
  );
}
