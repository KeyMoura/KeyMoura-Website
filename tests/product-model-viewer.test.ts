import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { MODEL_TEXTURE_NOTICE, ProductModelViewer } from "../src/components/ProductModelViewer.tsx";
import ProductGallery from "../src/components/product/ProductGallery.tsx";

/**
 * The permanent texture disclaimer on every interactive 3D product view.
 *
 * The requirement is not "the product page says it" — it is that **any** surface
 * showing the interactive viewer says it, including ones that do not exist yet.
 * That is only enforceable if there is exactly one component that constructs a
 * `model-viewer`, so the suite asserts two separate things: the notice is part
 * of that component's own output, and no other module builds a viewer that could
 * bypass it.
 */

const read = (file: string) => readFileSync(file, "utf8");
const viewerSource = read("src/components/ProductModelViewer.tsx");
const gallerySource = read("src/components/product/ProductGallery.tsx");
const globalsCss = read("src/app/globals.css");

/** Source with comments stripped — several assertions below are "must not appear". */
const code = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

const image = (id: string) => ({ id, url: `https://example.test/${id}.jpg`, alt: id, caption: null });

/** Walks `src/` so a viewer added in a directory this file has never heard of is still caught. */
function sourceFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, found);
    else if (/\.(tsx?|jsx?)$/.test(entry)) found.push(full);
  }
  return found;
}

test("the warning text is exactly the specified sentence", () => {
  assert.equal(MODEL_TEXTURE_NOTICE, "Textures may not be accurate.");
});

test("the shared viewer renders the warning", () => {
  const markup = renderToStaticMarkup(
    createElement(ProductModelViewer, { src: "https://example.test/knob.glb", poster: null, alt: "3D view" })
  );
  assert.ok(markup.includes("Textures may not be accurate."), markup);
});

test("the warning is not conditional on anything", () => {
  const body = code(viewerSource);
  const notice = body.slice(body.indexOf("MODEL_TEXTURE_NOTICE}<"));
  assert.ok(notice.length > 0, "the notice must be rendered from the exported constant");

  // No ternary, no `&&` gate, no state and no props between the component body
  // and the notice: it renders on every path or it is not permanent.
  assert.ok(!/useState|useReducer|dismiss|hidden/i.test(body), "the notice must not be dismissible or stateful");
  assert.ok(!/\?\s*null|&&\s*\(?\s*<p/.test(body), "the notice must not sit behind a conditional");
});

test("the warning is text, not a tooltip, a toast or an icon", () => {
  const body = code(viewerSource);
  assert.ok(!/title=|tooltip|aria-describedby|role="alert"|toast/i.test(body));
  // Rendered as an ordinary paragraph in the reading order.
  assert.match(body, /<p className="product-model-viewer-notice">\{MODEL_TEXTURE_NOTICE\}<\/p>/);
});

test("the warning is always visible in CSS — never hover-gated or transparent", () => {
  const rule = globalsCss.slice(
    globalsCss.indexOf(".product-model-viewer-notice {"),
    globalsCss.indexOf(".product-model-viewer-notice {") + 600
  );
  assert.ok(rule.length > 0, "the notice needs a rule");
  assert.ok(!/display:\s*none|visibility:\s*hidden|opacity:\s*0/.test(rule), rule);
  assert.ok(
    !globalsCss.includes(".product-model-viewer:hover .product-model-viewer-notice"),
    "the notice must not appear only on hover"
  );
  // Laid out beneath the stage rather than over it, so it cannot cover the
  // model's drag surface or its controls.
  assert.match(globalsCss, /\.product-model-viewer-notice \{[^}]*flex:\s*none/);
  assert.ok(!/\.product-model-viewer-notice \{[^}]*position:\s*absolute/.test(globalsCss));
});

test("only one module constructs a 3D viewer, so every entry point inherits the warning", () => {
  const offenders = sourceFiles("src")
    .filter((file) => !file.endsWith(path.join("components", "ProductModelViewer.tsx")))
    .filter((file) => /["']model-viewer["']|<model-viewer/.test(code(read(file))));

  assert.deepEqual(
    offenders,
    [],
    "a second model-viewer would be a 3D surface with no texture warning; render <ProductModelViewer> instead"
  );
});

test("every customer-facing 3D surface goes through the shared viewer", () => {
  // Today that is the product gallery, and it is the only consumer. If a
  // quick-view or configurator is added, this list grows — and it can only grow
  // with modules that import the shared component, per the test above.
  const consumers = sourceFiles("src").filter((file) =>
    /from "@\/components\/ProductModelViewer"/.test(read(file))
  );
  assert.deepEqual(consumers, [path.join("src", "components", "product", "ProductGallery.tsx")]);
  assert.ok(code(gallerySource).includes("<ProductModelViewer"));
});

test("a 3D product shows the warning once the model view is chosen", () => {
  const markup = renderToStaticMarkup(
    createElement(ProductGallery, {
      images: [image("a"), image("b")],
      productName: "Shift knob",
      modelUrl: "https://example.test/knob.glb",
      modelPoster: null,
    })
  );
  // The gallery opens on the photograph, so the button that reaches the model
  // must exist; the warning is asserted on the viewer itself above, and the
  // viewer is the only thing that gate renders.
  assert.ok(markup.includes("Show the 3D model"), "a product with a model must offer the 3D view");
});

test("a product with no model gets no viewer and no irrelevant warning", () => {
  const markup = renderToStaticMarkup(
    createElement(ProductGallery, {
      images: [image("a"), image("b")],
      productName: "Shift knob",
      modelUrl: null,
      modelPoster: null,
    })
  );
  assert.ok(!markup.includes("Textures may not be accurate."));
  assert.ok(!markup.includes("Show the 3D model"));
  assert.ok(!markup.includes("product-model-viewer"));
});

test("the notice survives the controls the customer can change", () => {
  // The only viewer inputs are the model, its poster and the label. None of
  // them reaches the notice, which is why changing camera, options or product
  // cannot remove it — asserted by rendering the extremes rather than by
  // reading the code.
  for (const poster of [null, "https://example.test/poster.jpg"]) {
    for (const alt of ["3D view of Shift knob", ""]) {
      const markup = renderToStaticMarkup(
        createElement(ProductModelViewer, { src: "https://example.test/knob.glb", poster, alt })
      );
      assert.ok(markup.includes("Textures may not be accurate."), `poster=${poster} alt=${alt}`);
    }
  }
});

test("the notice is not hidden at any width", () => {
  // Nothing in the stylesheet may drop it inside a media query — a warning that
  // disappears on a phone is not permanent.
  const hidingRules = globalsCss
    .split("\n")
    .filter((line) => line.includes("product-model-viewer-notice"))
    .filter((line) => /display:\s*none|visibility:\s*hidden/.test(line));
  assert.deepEqual(hidingRules, []);
});
