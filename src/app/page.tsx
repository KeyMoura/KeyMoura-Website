import Link from "next/link";
import { supabaseAdmin } from "@/lib/supabaseServer";
import type { CatalogProduct } from "@/lib/commerceTypes";

type FeaturedProduct = Pick<CatalogProduct, "id" | "name" | "slug" | "short_description" | "image_url" | "category" | "starting_price_cents" | "is_custom">;

async function featuredProducts(): Promise<FeaturedProduct[]> {
  try {
    const { data } = await supabaseAdmin().from("products")
      .select("id,name,slug,short_description,image_url,category,starting_price_cents,is_custom")
      .eq("is_published", true).order("sort_order").limit(3);
    return (data ?? []) as FeaturedProduct[];
  } catch { return []; }
}

const price = (cents: number | null) => cents == null ? "Quoted for your build" : `From $${(cents / 100).toFixed(2)}`;

export default async function Home() {
  const featured = await featuredProducts();
  return (
    <main>
      <section className="relative overflow-hidden border-b border-zinc-800/80">
        <div className="theme-accent-radial absolute inset-0" />
        <div className="relative mx-auto grid max-w-6xl gap-10 px-4 py-16 md:grid-cols-[1.3fr_.7fr] md:items-center md:py-24">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[.24em] text-brand-primary">Designed around your idea</p>
            <h1 className="mt-5 max-w-4xl text-4xl font-semibold tracking-tight md:text-6xl">Custom CNC parts without the usual guesswork.</h1>
            <p className="mt-6 max-w-2xl text-base leading-7 text-brand-textMuted md:text-lg">Choose a starting design or request something original. Review the details, approve your quote, pay securely, and follow the build from one place.</p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Link href="/catalog" className="catalog-action-primary rounded-full px-6 py-3 font-semibold">Explore products</Link>
              <Link href="/orders/new" className="catalog-action-secondary rounded-full px-6 py-3 font-medium">Request custom work</Link>
            </div>
          </div>
          <aside className="rounded-3xl border border-zinc-800 bg-black/35 p-6 backdrop-blur">
            <p className="text-sm font-semibold text-brand-primary">Built for one-off ideas</p>
            <dl className="mt-5 grid gap-5">
              {[['Clear quoting','No charge until the scope and price are agreed.'],['Direct collaboration','Messages, files, and approvals stay with your order.'],['Visible progress','Follow payment, production, and delivery status.']].map(([title, body]) => <div key={title}><dt className="font-semibold">{title}</dt><dd className="mt-1 text-sm leading-6 text-brand-textMuted">{body}</dd></div>)}
            </dl>
          </aside>
        </div>
      </section>

      <div className="mx-auto flex max-w-6xl flex-col gap-20 px-4 py-16">
        {featured.length ? <section>
          <div className="flex flex-wrap items-end justify-between gap-4"><div><p className="text-xs uppercase tracking-[.2em] text-brand-primary">Featured work</p><h2 className="mt-2 text-3xl font-semibold">A starting point for your build</h2></div><Link href="/catalog" className="text-sm font-semibold text-brand-primary hover:underline">View the full catalog →</Link></div>
          <div className="mt-7 grid gap-5 md:grid-cols-3">{featured.map(product => <article key={product.id} className="group overflow-hidden rounded-2xl border border-zinc-800 bg-black/30 transition hover:-translate-y-1 hover:border-brand-primary/40">
            {/* Product images are user-managed remote URLs that are not limited to a configured host. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            {product.image_url ? <img src={product.image_url} alt={product.name} className="aspect-[4/3] w-full object-cover transition duration-300 group-hover:scale-[1.02]" /> : <div className="flex aspect-[4/3] items-center justify-center bg-zinc-900 text-4xl font-semibold text-brand-primary">KM</div>}
            <div className="p-5"><p className="text-xs uppercase tracking-wide text-brand-textMuted">{product.category || 'Custom CNC'}</p><h3 className="mt-2 text-xl font-semibold"><Link href={`/catalog/${product.slug}`} className="after:absolute">{product.name}</Link></h3><p className="mt-2 line-clamp-2 text-sm leading-6 text-brand-textMuted">{product.short_description}</p><p className="mt-4 text-sm font-semibold text-brand-primary">{price(product.starting_price_cents)}</p></div>
          </article>)}</div>
        </section> : null}

        <section><p className="text-xs uppercase tracking-[.2em] text-brand-primary">Simple by design</p><h2 className="mt-2 text-3xl font-semibold">From idea to finished part</h2><div className="mt-7 grid gap-4 md:grid-cols-3">{[
          ['01','Choose or describe','Start with a catalog design or send the dimensions, reference files, and finish you need.'],['02','Review and approve','We confirm manufacturability, settle the details, and send a clear price before payment.'],['03','Track the build','See messages, progress, payment, and fulfillment updates from your account.']
        ].map(([n,t,b]) => <article key={n} className="rounded-2xl border border-zinc-800 bg-black/30 p-6"><span className="text-sm font-semibold text-brand-primary">{n}</span><h3 className="mt-4 text-lg font-semibold">{t}</h3><p className="mt-2 text-sm leading-6 text-brand-textMuted">{b}</p></article>)}</div></section>

        <section className="grid gap-5 md:grid-cols-2"><div className="rounded-3xl border border-brand-primary/25 bg-brand-primary/5 p-7 md:p-9"><p className="text-xs uppercase tracking-[.2em] text-brand-primary">Have something different in mind?</p><h2 className="mt-3 text-3xl font-semibold">Let’s make the part you actually need.</h2><p className="mt-4 leading-7 text-brand-textMuted">Send a sketch, CAD file, photo, or plain-language description. We’ll work out materials, dimensions, finish, and a realistic path to production.</p><Link href="/orders/new" className="catalog-action-primary mt-6 inline-flex rounded-full px-5 py-2.5 font-semibold">Start a custom request</Link></div>
        <div className="rounded-3xl border border-zinc-800 bg-black/30 p-7 md:p-9"><p className="text-xs uppercase tracking-[.2em] text-brand-primary">Common questions</p><div className="mt-4 divide-y divide-zinc-800">{[
          ['When do I pay?','Only after the details and final price are agreed.'],['Can I upload files?','Yes. Attach specifications and reference files to your request.'],['Can I see progress?','Yes. Your order hub keeps messages, payment, production, and delivery updates together.']
        ].map(([q,a]) => <details key={q} className="py-4"><summary className="cursor-pointer font-semibold">{q}</summary><p className="mt-2 text-sm leading-6 text-brand-textMuted">{a}</p></details>)}</div></div></section>
      </div>
    </main>
  );
}
