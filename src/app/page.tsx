import Link from "next/link";
import { getSiteSettings } from "@/lib/siteSettings";

export default async function Home() {
  const siteSettings = await getSiteSettings();
  return (
    <main className="mx-auto flex max-w-6xl flex-col gap-10 px-4 py-10 md:py-16">
      <section className="relative overflow-hidden rounded-3xl border border-zinc-800 bg-zinc-950 px-6 py-16 md:px-12">
        <div className="theme-accent-radial absolute inset-0" />
        <div className="relative max-w-2xl">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-brand-primary">{siteSettings.name}</p>
          <h1 className="mt-4 text-4xl font-semibold tracking-tight text-brand-text md:text-6xl">Custom parts, made around your idea.</h1>
          <p className="mt-5 max-w-xl text-base leading-7 text-brand-textMuted">Browse available designs, choose your options, and request a custom build. You can approve details, message us, follow progress, and pay securely from one order page.</p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Link href="/catalog" className="rounded-full bg-brand-primary px-5 py-2.5 font-semibold text-black transition hover:brightness-110">Browse products</Link>
            <Link href="/orders" className="rounded-full border border-zinc-700 bg-black/30 px-5 py-2.5 font-medium text-white transition hover:border-zinc-500">Track an order</Link>
          </div>
        </div>
      </section>

      <section>
        <h2 className="text-sm font-semibold uppercase tracking-wide text-brand-textMuted">How it works</h2>
        <div className="mt-4 grid gap-4 md:grid-cols-3">
          {[
            ["1", "Request your item", "Pick a product, select its options, and tell us what you want changed."],
            ["2", "Confirm the details", "We review the request, message you with questions, and set the final price."],
            ["3", "Follow the build", "Pay securely and receive notifications as your order moves through production."],
          ].map(([number, title, body]) => (
            <article key={number} className="rounded-2xl border border-zinc-800 bg-black/30 p-5">
              <span className="text-sm font-semibold text-brand-primary">{number}</span>
              <h3 className="mt-3 font-semibold text-brand-text">{title}</h3>
              <p className="mt-2 text-sm leading-6 text-brand-textMuted">{body}</p>
            </article>
          ))}
        </div>
      </section>
    </main>
  );
}
