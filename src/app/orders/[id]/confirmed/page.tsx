"use client";

import Link from "next/link";
import { useParams } from "next/navigation";

export default function OrderConfirmedPage() {
  const { id } = useParams<{ id: string }>();
  return <main className="mx-auto flex min-h-[65vh] max-w-2xl items-center px-4 py-12"><section className="w-full rounded-3xl border border-emerald-400/30 bg-emerald-400/5 p-7 text-center sm:p-10"><div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-emerald-400/15 text-2xl text-emerald-200">✓</div><p className="mt-5 text-xs font-semibold uppercase tracking-[.2em] text-emerald-200">Request received</p><h1 className="mt-2 text-3xl font-semibold">You’re all set.</h1><p className="mx-auto mt-3 max-w-lg text-brand-textMuted">Your item and any limited inventory are reserved while KeyMoura reviews the details. We sent a confirmation email and will follow up in your order chat.</p><div className="mt-7 flex flex-col justify-center gap-3 sm:flex-row"><Link href={`/orders/${id}`} className="catalog-action-primary rounded-xl px-5 py-3 font-semibold">View request</Link><Link href="/catalog" className="rounded-xl border border-zinc-700 px-5 py-3 font-semibold transition hover:border-brand-primary/70">Back to catalog</Link></div></section></main>;
}
