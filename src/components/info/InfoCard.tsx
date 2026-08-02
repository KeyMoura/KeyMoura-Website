"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

export type InfoCardItem = {
  id: string;
  title: string;
  slug: string;
  created_at: string;
  updated_at: string | null;
  chassis?: string | null;
  tags?: string[] | null;
  category?: string | null;
};

type InfoCardProps = {
  item: InfoCardItem;
  showCategory?: boolean;
  showTags?: boolean;
  maxTags?: number;
  highlightTokens?: string[];
};

// simple highlight helper (same classes as index / command palette)
function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function highlightText(text: string, tokens: string[] = []): ReactNode {
  if (!text || tokens.length === 0) return text;

  const cleanedTokens = Array.from(
    new Set(
      tokens
        .map((t) => t.trim().toLowerCase())
        .filter((t) => t.length > 0)
    )
  );
  if (cleanedTokens.length === 0) return text;

  const pattern = cleanedTokens.map(escapeRegExp).join("|");
  if (!pattern) return text;

  const regex = new RegExp(`(${pattern})`, "gi");
  const parts = text.split(regex);

  return parts.map((part, idx) => {
    const lower = part.toLowerCase();
    const isMatch = cleanedTokens.some((t) => t === lower);

    if (isMatch) {
      return (
        <span
          key={idx}
          className="rounded-[3px] bg-amber-500/20 px-0.5 text-amber-300"
        >
          {part}
        </span>
      );
    }

    return <span key={idx}>{part}</span>;
  });
}

export function InfoCard({
  item,
  showCategory = false,
  showTags = true,
  maxTags = 4,
  highlightTokens = [],
}: InfoCardProps) {
  const router = useRouter();

  const updated = item.updated_at || item.created_at;
  const updatedLabel = new Date(updated).toLocaleDateString();
  const tags = item.tags ?? [];

  return (
    <Link
      href={`/projects/${item.slug}`}
      className="rounded-lg border border-zinc-800/80 bg-black/40 p-4 text-sm text-brand-text transition hover:border-amber-400/80 hover:bg-black/60"
    >
      <div className="mb-1 flex items-center justify-between gap-2">
        <h3 className="text-[13px] font-semibold text-brand-text">
          {highlightText(item.title, highlightTokens)}
        </h3>
        {item.chassis && (
          <span className="rounded-full border border-zinc-700 bg-black/40 px-2 py-0.5 text-[10px] uppercase tracking-wide text-brand-textMuted">
            {highlightText(item.chassis, highlightTokens)}
          </span>
        )}
      </div>

      <p className="mb-1 text-[11px] text-brand-textMuted">
        Last updated {updatedLabel}
      </p>

      {showCategory && item.category && (
        <p className="mb-1 text-[10px] uppercase tracking-wide text-brand-textMuted">
          {highlightText(item.category, highlightTokens)}
        </p>
      )}

      {showTags && tags.length > 0 && (
        <div className="mt-1 flex flex-wrap gap-1">
          {tags.slice(0, maxTags).map((tag) => (
            <button
              key={tag}
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                router.push(`/projects?q=${encodeURIComponent(tag)}`);
              }}
              className="rounded-full border border-zinc-700 bg-black/40 px-2 py-0.5 text-[10px] text-brand-textMuted hover:border-amber-400/80 hover:text-brand-text"
            >
              {highlightText(tag, highlightTokens)}
            </button>
          ))}
          {tags.length > maxTags && (
            <span className="text-[10px] text-brand-textMuted">
              +{tags.length - maxTags} more
            </span>
          )}
        </div>
      )}
    </Link>
  );
}
