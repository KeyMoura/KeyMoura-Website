"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { SharedCartSummary } from "@/lib/commerce/sharedCartService";

/**
 * Creating and managing cart share links, from the cart page.
 *
 * A share is a snapshot taken at the moment the link is made, so the panel says
 * so plainly — someone who expects the link to track their live cart will
 * otherwise be surprised when they add something and the recipient sees the old
 * list.
 */

const SHARES_QUERY_KEY = ["cart-shares"] as const;

const EXPIRY_CHOICES = [
  { label: "No expiry", value: "" },
  { label: "7 days", value: "7" },
  { label: "30 days", value: "30" },
  { label: "90 days", value: "90" },
] as const;

type ShareResponse = { share?: { token: string; url: string; expiresAt: string | null }; shares?: SharedCartSummary[]; error?: string };

export default function CartSharePanel({ canShare }: { canShare: boolean }) {
  const queryClient = useQueryClient();
  const [expiry, setExpiry] = useState("");
  const [note, setNote] = useState("");
  const [freshUrl, setFreshUrl] = useState("");
  const [copied, setCopied] = useState(false);
  const [copyProblem, setCopyProblem] = useState("");

  const { data: shares = [], isLoading } = useQuery({
    queryKey: SHARES_QUERY_KEY,
    queryFn: async () => {
      const response = await fetch("/api/cart/share", { credentials: "same-origin" });
      const payload = (await response.json().catch(() => null)) as ShareResponse | null;
      if (!response.ok) throw new Error(payload?.error || "Could not load your share links.");
      return payload?.shares ?? [];
    },
  });

  const create = useMutation({
    mutationFn: async () => {
      const response = await fetch("/api/cart/share", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ expiresInDays: expiry ? Number(expiry) : null, note: note.trim() || undefined }),
      });
      const payload = (await response.json().catch(() => null)) as ShareResponse | null;
      if (!response.ok || !payload?.share) throw new Error(payload?.error || "Could not create a share link.");
      return payload;
    },
    onSuccess: (payload) => {
      setFreshUrl(payload.share?.url ?? "");
      setNote("");
      setCopied(false);
      if (payload.shares) queryClient.setQueryData(SHARES_QUERY_KEY, payload.shares);
    },
  });

  const revoke = useMutation({
    mutationFn: async (token: string) => {
      const response = await fetch(`/api/cart/share?token=${encodeURIComponent(token)}`, {
        method: "DELETE",
        credentials: "same-origin",
      });
      const payload = (await response.json().catch(() => null)) as ShareResponse | null;
      if (!response.ok) throw new Error(payload?.error || "Could not revoke that link.");
      return payload;
    },
    onSuccess: (payload) => {
      if (payload?.shares) queryClient.setQueryData(SHARES_QUERY_KEY, payload.shares);
    },
  });

  async function copyLink(url: string) {
    setCopyProblem("");
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      setCopied(false);
      setCopyProblem("Copy was blocked by your browser. Select the link and copy it manually.");
    }
  }

  const live = shares.filter((share) => !share.revokedAt);
  const error = create.error?.message || revoke.error?.message || "";

  // With an empty cart and nothing shared there is nothing to say, so the panel
  // stays out of the way. It reappears the moment there is a link to revoke.
  if (!canShare && !live.length && !isLoading) return null;

  return (
    <section aria-labelledby="cart-share" className="ui-card">
      <h2 id="cart-share" className="text-lg font-semibold">
        Share this cart
      </h2>
      <p className="mt-2 text-sm text-brand-textMuted">
        A share link is a snapshot of what is in your cart right now — it will not change as you keep shopping. It
        shows the items only, never your name or account.
      </p>

      {error ? (
        <p role="alert" className="ui-notice ui-notice-danger mt-3 text-sm">
          {error}
        </p>
      ) : null}

      {canShare ? (
        <div className="mt-4">
          <label className="ui-label block" htmlFor="cart-share-note">
            Add a note (optional)
          </label>
          <input
            id="cart-share-note"
            value={note}
            maxLength={200}
            onChange={(event) => setNote(event.target.value)}
            placeholder="What is this list for?"
            className="ui-input mt-1 w-full"
          />

          <label className="ui-label mt-3 block" htmlFor="cart-share-expiry">
            Link expires
          </label>
          <select
            id="cart-share-expiry"
            value={expiry}
            onChange={(event) => setExpiry(event.target.value)}
            className="ui-input mt-1 w-full"
          >
            {EXPIRY_CHOICES.map((choice) => (
              <option key={choice.label} value={choice.value}>
                {choice.label}
              </option>
            ))}
          </select>

          <button
            type="button"
            disabled={create.isPending}
            onClick={() => create.mutate()}
            className="ui-btn ui-btn-secondary mt-3 w-full disabled:opacity-50"
          >
            {create.isPending ? "Creating…" : "Create a share link"}
          </button>
        </div>
      ) : (
        <p className="mt-4 text-sm text-brand-textMuted">Add something to your cart to share it.</p>
      )}

      {freshUrl ? (
        <div className="mt-4">
          <label className="ui-label block" htmlFor="cart-share-url">
            Your new link
          </label>
          <input
            id="cart-share-url"
            readOnly
            value={freshUrl}
            onFocus={(event) => event.currentTarget.select()}
            className="ui-input mt-1 w-full text-xs"
          />
          <button
            type="button"
            onClick={() => void copyLink(freshUrl)}
            className="ui-btn ui-btn-ghost mt-2 !py-1.5 text-sm"
          >
            {copied ? "Copied" : "Copy link"}
          </button>
          {copyProblem ? (
            <p role="status" className="mt-2 text-xs text-amber-200">
              {copyProblem}
            </p>
          ) : null}
        </div>
      ) : null}

      {isLoading ? (
        <p aria-live="polite" className="mt-4 text-sm text-brand-textMuted">
          Loading your share links…
        </p>
      ) : live.length ? (
        <div className="mt-5">
          <h3 className="text-sm font-semibold">Active links</h3>
          <ul className="mt-2 space-y-3">
            {live.map((share) => (
              <li key={share.token} className="text-sm">
                <p className="text-brand-text">
                  {share.itemCount} item{share.itemCount === 1 ? "" : "s"} ·{" "}
                  {new Date(share.createdAt).toLocaleDateString()}
                </p>
                <p className="text-xs text-brand-textMuted">
                  {share.viewCount} view{share.viewCount === 1 ? "" : "s"}
                  {share.expiresAt ? ` · expires ${new Date(share.expiresAt).toLocaleDateString()}` : " · no expiry"}
                </p>
                {share.note ? <p className="mt-0.5 text-xs text-brand-textMuted">“{share.note}”</p> : null}
                <button
                  type="button"
                  disabled={revoke.isPending}
                  onClick={() => revoke.mutate(share.token)}
                  className="mt-1 text-xs text-brand-textMuted underline hover:text-brand-text disabled:opacity-50"
                >
                  <span aria-hidden="true">Revoke</span>
                  <span className="sr-only">
                    Revoke the link shared on {new Date(share.createdAt).toLocaleDateString()}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
