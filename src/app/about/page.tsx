import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = { title: "About", description: "How KeyMoura turns custom part ideas into clearly quoted CNC projects." };

export default function AboutPage() {
  return <main className="mx-auto max-w-5xl px-4 py-12 sm:py-16">
    <p className="text-xs font-semibold uppercase tracking-[.22em] text-brand-primary">About KeyMoura</p>
    <h1 className="mt-4 max-w-3xl text-4xl font-semibold tracking-tight sm:text-5xl">Custom parts should feel collaborative, not mysterious.</h1>
    <p className="mt-6 max-w-3xl text-lg leading-8 text-brand-textMuted">KeyMoura is built around one-off and small-run CNC work. You bring the idea, dimensions, drawing, or CAD file; we help turn it into a manufacturable plan with a clear quote and visible progress.</p>
    <section className="mt-12 grid gap-5 md:grid-cols-3">{[
      ["Clear before committed", "Material, scope, price, timing, and fulfillment are confirmed before payment."],
      ["Direct communication", "Questions, files, revisions, and approvals stay connected to the order."],
      ["Progress you can follow", "Your account shows payment, production, and delivery updates in one place."],
    ].map(([title, body]) => <article key={title} className="rounded-2xl border border-zinc-800 bg-black/30 p-6"><h2 className="text-lg font-semibold">{title}</h2><p className="mt-3 text-sm leading-6 text-brand-textMuted">{body}</p></article>)}</section>
    <section className="mt-12 rounded-3xl border border-brand-primary/25 bg-brand-primary/5 p-7 sm:p-9"><h2 className="text-2xl font-semibold">Have a part in mind?</h2><p className="mt-3 max-w-2xl leading-7 text-brand-textMuted">A polished model is not required. A sketch, reference photo, measurements, and a description of how the part will be used are enough to start the conversation.</p><div className="mt-6 flex flex-wrap gap-3"><Link href="/orders/new" className="catalog-action-primary rounded-full px-5 py-2.5 font-semibold">Start a request</Link><Link href="/capabilities" className="catalog-action-secondary rounded-full px-5 py-2.5 font-medium">View capabilities</Link></div></section>
  </main>;
}
