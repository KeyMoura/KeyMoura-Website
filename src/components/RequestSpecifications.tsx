"use client";

import { useMemo, useState } from "react";
import { supabaseBrowser } from "@/lib/supabaseClient";

type SavedFileItem = { path?: unknown; name?: unknown; note?: unknown };

type SavedOption = {
  label?: string;
  option_name?: string;
  value?: unknown;
  value_name?: string;
  display_value?: unknown;
  kind?: string;
  price_adjustment_cents?: number;
  items?: unknown;
};

/**
 * The specification bag on an order, rendered for whoever is allowed to see it.
 *
 * ## The bug this had
 *
 * It understood `kind: "file"` — one path, one download button — because that
 * is what a product option group with a file input writes. It did not
 * understand `kind: "files"`, which is what a custom project request writes:
 * `value` is an *array* of storage paths and `display_value` is the filenames
 * joined with commas.
 *
 * Falling through to `String(display)` meant that entry rendered as a line of
 * grey text. Staff opening a custom request saw the names of the drawings the
 * customer had attached, correctly, and had no way to open any of them — on
 * the one order type where the attachment is the request. The files were in the
 * bucket the whole time and the read policy already allowed staff; nothing was
 * lost, and nothing said it was unreachable either.
 *
 * Both shapes are handled now. `items` is used when present, because it carries
 * the per-file note the customer wrote; otherwise the names are recovered by
 * splitting `display_value`, so requests submitted before this pass become
 * downloadable too rather than only new ones.
 *
 * ## Why a signed URL and not a link
 *
 * `order-assets` is private. A path is not a URL, and the object is readable
 * only by its owner or by staff — so the URL is minted per click, lives 60
 * seconds, and is never rendered into the markup. Nothing here leaks a path to
 * a viewer who could not already read the object.
 */
export function RequestSpecifications({ specifications }: { specifications: Record<string, unknown> }) {
  const supabase = useMemo(() => supabaseBrowser(), []);
  const [error, setError] = useState("");

  async function download(path: string) {
    setError("");
    const { data, error: signError } = await supabase.storage.from("order-assets").createSignedUrl(path, 60);
    if (signError || !data) return setError(signError?.message ?? "Could not open that file.");
    window.open(data.signedUrl, "_blank", "noopener,noreferrer");
  }

  /** `{path, name, note}` per attachment, from either stored shape. */
  function attachments(option: SavedOption): { path: string; name: string; note: string }[] {
    if (Array.isArray(option.items)) {
      return (option.items as SavedFileItem[])
        .filter((item) => typeof item?.path === "string")
        .map((item, index) => ({
          path: String(item.path),
          name: typeof item.name === "string" && item.name ? item.name : `File ${index + 1}`,
          note: typeof item.note === "string" ? item.note : "",
        }));
    }
    const paths = Array.isArray(option.value) ? option.value.filter((entry): entry is string => typeof entry === "string") : [];
    // Older rows only ever recorded the names as one joined string.
    const names = typeof option.display_value === "string" ? option.display_value.split(", ") : [];
    return paths.map((path, index) => ({ path, name: names[index] || `File ${index + 1}`, note: "" }));
  }

  return (
    <>
      {Object.entries(specifications)
        .filter(([key, value]) => value != null && key !== "estimated_total_cents")
        .map(([key, raw]) => {
          const option = typeof raw === "object" && raw !== null ? (raw as SavedOption) : null;
          const label = option?.option_name || option?.label || key.replaceAll("_", " ");
          const display = option?.value_name ?? option?.display_value ?? option?.value ?? raw;

          // A custom request's attachments: a real list, each one openable.
          if (option?.kind === "files") {
            const items = attachments(option);
            if (!items.length) return null;
            return (
              <div key={key}>
                <dt className="capitalize text-brand-textMuted">{label}</dt>
                <dd className="mt-0.5">
                  <ul className="space-y-1">
                    {items.map((item) => (
                      <li key={item.path}>
                        <button
                          type="button"
                          onClick={() => void download(item.path)}
                          className="text-left text-brand-primary underline decoration-brand-primary/40 underline-offset-4"
                        >
                          {item.name}
                        </button>
                        {item.note ? (
                          <span className="ml-2 text-xs text-brand-textMuted">— {item.note}</span>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </dd>
              </div>
            );
          }

          // A reference the customer gave us. `rel` is what keeps an external
          // page from reaching back into the staff tab that opened it.
          if (option?.kind === "link" && typeof option.value === "string") {
            return (
              <div key={key}>
                <dt className="capitalize text-brand-textMuted">{label}</dt>
                <dd className="mt-0.5">
                  <a
                    href={option.value}
                    target="_blank"
                    rel="noopener noreferrer nofollow ugc"
                    className="break-all text-brand-primary underline decoration-brand-primary/40 underline-offset-4"
                  >
                    {String(display)}
                  </a>
                </dd>
              </div>
            );
          }

          return (
            <div key={key}>
              <dt className="capitalize text-brand-textMuted">{label}</dt>
              <dd className="mt-0.5">
                {option?.kind === "file" && typeof option.value === "string" ? (
                  <button
                    type="button"
                    onClick={() => void download(option.value as string)}
                    className="text-brand-primary underline decoration-brand-primary/40 underline-offset-4"
                  >
                    {String(display)}
                  </button>
                ) : (
                  String(display === true ? "Yes" : display === false ? "No" : (display ?? "—"))
                )}
                {option?.price_adjustment_cents ? (
                  <span className="ml-2 text-xs text-brand-primary">
                    ({option.price_adjustment_cents > 0 ? "+" : "−"}$
                    {(Math.abs(option.price_adjustment_cents) / 100).toFixed(2)})
                  </span>
                ) : null}
              </dd>
            </div>
          );
        })}
      {error ? <div className="text-rose-200">{error}</div> : null}
    </>
  );
}
