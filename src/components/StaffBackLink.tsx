"use client";

import Link from "next/link";

type Props = {
  href?: string;
  label?: string;
};

/**
 * Renders a consistent staff back link.
 */
export function StaffBackLink({ href = "/staff", label = "Back to staff overview" }: Props) {
  return (
    <Link
      href={href}
      className="inline-flex items-center gap-2 rounded-xl border border-zinc-800 bg-black/30 px-3 py-1.5 text-sm font-medium text-brand-text transition-all hover:border-brand-primary/60 hover:bg-black/50"
    >
      <span aria-hidden>←</span>
      <span>{label}</span>
    </Link>
  );
}
