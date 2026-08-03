import Link from "next/link";
import type { Metadata } from "next";
import ProductCard, { type ProductCardProduct } from "@/components/ProductCard";
import Reveal from "@/components/Reveal";
import { supabaseAdmin } from "@/lib/supabaseServer";
import { groupMediaByProduct } from "@/lib/productImages";
import { getSiteSettings } from "@/lib/siteSettings";

export const revalidate = 300;

export async function generateMetadata(): Promise<Metadata> {
  const settings = await getSiteSettings();
  return {
    title: `${settings.name} | Custom Parts, Made to Order`,
    description:
      "KeyMoura designs and machines custom parts, prototypes, fixtures, and short runs. Browse the catalog or send a drawing, CAD file, or description and get a reviewed quote before you pay.",
    alternates: { canonical: "/" },
  };
}

type FeaturedProject = { id: string; title: string; slug: string; category: string | null; updated_at: string | null };

/**
 * The homepage and /catalog resolve product images the same way: gallery media
 * first, then the denormalized products.image_url. Reading only image_url here
 * is what made products with real photographs render as placeholders.
 */
async function loadFeaturedProducts(): Promise<ProductCardProduct[]> {
  try {
    const client = supabaseAdmin();
    const { data } = await client
      .from("products")
      .select(
        "id,name,slug,short_description,image_url,category,category_id,purchase_mode,starting_price_cents,is_custom,availability_status,lead_time_text,inventory_policy,inventory_quantity,continue_selling_when_out_of_stock"
      )
      .eq("is_published", true)
      .is("archived_at", null)
      .order("sort_order")
      .limit(3);

    const products = (data ?? []) as ProductCardProduct[];
    if (!products.length) return [];

    const { data: media } = await client
      .from("product_media")
      .select("product_id,url,kind,sort_order")
      .in(
        "product_id",
        products.map((product) => product.id)
      )
      .eq("kind", "image")
      .order("sort_order");

    const byProduct = groupMediaByProduct(media ?? []);
    return products.map((product) => ({ ...product, product_media: byProduct.get(product.id) ?? [] }));
  } catch {
    return [];
  }
}

async function loadFeaturedProjects(): Promise<FeaturedProject[]> {
  try {
    const { data } = await supabaseAdmin()
      .from("info_pages")
      .select("id,title,slug,category,updated_at")
      .eq("status", "approved")
      .order("updated_at", { ascending: false })
      .limit(3);
    return (data ?? []) as FeaturedProject[];
  } catch {
    return [];
  }
}

const capabilities = [
  {
    title: "Plastics",
    body: "Delrin and acetal, HDPE, acrylic, and other machinable plastics for housings, jigs, and wear parts.",
  },
  {
    title: "Wood",
    body: "Hardwoods, softwoods, plywood, and selected engineered sheet goods for panels, signage, and trim.",
  },
  {
    title: "Aluminum",
    body: "Aluminum work reviewed individually for geometry, finish, and the tolerance the part actually needs.",
  },
  {
    title: "Something else?",
    body: "Ask first. Workholding, tooling, dust, heat, and safety decide what is practical — we will tell you plainly.",
  },
];

const process = [
  {
    step: "01",
    title: "Describe the part",
    body: "Start from a catalog design or send a CAD file, drawing, sketch, or plain-language description. Dimensions, material, finish, quantity, and how the part gets used all help.",
  },
  {
    step: "02",
    title: "We review it and quote",
    body: "Every request is read by a person. We confirm the part can actually be made the way you need it, raise anything that should change, and send a price tied to the agreed specification.",
  },
  {
    step: "03",
    title: "You approve, then pay",
    body: "Nothing is charged until the scope and price are settled and you approve the quote. Checkout is handled by Stripe.",
  },
  {
    step: "04",
    title: "Follow it through delivery",
    body: "Messages, files, approvals, payment, production status, and delivery updates stay together in your order hub.",
  },
];

const assurances = [
  {
    title: "No charge before approval",
    body: "A request costs nothing. Payment only happens after you have seen the specification and the price and accepted both.",
  },
  {
    title: "Manufacturability checked first",
    body: "Deep pockets, thin walls, undercuts, and very tight tolerances get flagged before production, not after.",
  },
  {
    title: "One place for the whole order",
    body: "Your files, messages, quote, payment, and status live on a single order page instead of scattered email threads.",
  },
];

const faq = [
  ["When do I pay?", "Only after the specification and the final price are agreed and you approve the quote."],
  [
    "What files can I send?",
    "CAD (STL, STEP, IGES), drawings (DXF, DWG, SVG, PDF), and photographs or reference images. Up to 10 files, 50 MB each.",
  ],
  [
    "What if you cannot make it?",
    "We say so, and explain why. Some geometry, materials, sizes, and safety-critical uses fall outside what this shop should take on.",
  ],
  ["Can I see progress?", "Yes. Your order hub tracks review, quote, payment, production, and delivery as they happen."],
];

export default async function Home() {
  const [products, projects] = await Promise.all([loadFeaturedProducts(), loadFeaturedProjects()]);

  return (
    <>
      <section className="home-hero">
        <div className="home-hero-wash" aria-hidden="true" />
        <div className="home-hero-inner">
          <Reveal className="home-hero-copy">
            <p className="ui-eyebrow">Custom routing &amp; light machining</p>
            <h1 className="home-hero-title">
              Parts made to your drawing, <span className="home-hero-accent">quoted before you pay.</span>
            </h1>
            <p className="home-hero-lede">
              KeyMoura makes one-off parts, prototypes, fixtures, signage, and short runs. Start from a catalog design
              or send your own idea — we review whether it can be made, agree the details, and only then ask for
              payment.
            </p>
            <div className="home-hero-actions">
              <Link href="/orders/new" className="ui-btn ui-btn-primary !px-6 !py-3">
                Request custom work
              </Link>
              <Link href="/catalog" className="ui-btn ui-btn-secondary !px-6 !py-3">
                Browse the catalog
              </Link>
            </div>
            <p className="home-hero-note">
              Not sure it is possible?{" "}
              <Link href="/capabilities">Check what we can make</Link> or{" "}
              <Link href="/contact">ask a question first</Link>.
            </p>
          </Reveal>

          <Reveal as="ul" className="home-hero-facts" delay={140}>
            {assurances.map((item) => (
              <li key={item.title}>
                <p className="font-semibold text-brand-text">{item.title}</p>
                <p className="mt-1 text-sm leading-6 text-brand-textMuted">{item.body}</p>
              </li>
            ))}
          </Reveal>
        </div>
      </section>

      <div className="home-sections">
        <section className="home-section" aria-labelledby="home-capabilities">
          <Reveal className="home-section-head">
            <div>
              <p className="ui-eyebrow">Capabilities</p>
              <h2 id="home-capabilities" className="home-section-title">
                What this shop works in
              </h2>
            </div>
            <Link href="/capabilities" className="home-section-link">
              Materials &amp; limits →
            </Link>
          </Reveal>
          <Reveal stagger className="mt-7 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {capabilities.map((item) => (
              <article key={item.title} className="ui-card ui-card-hover">
                <h3 className="font-semibold text-brand-primary">{item.title}</h3>
                <p className="mt-2 text-sm leading-6 text-brand-textMuted">{item.body}</p>
              </article>
            ))}
          </Reveal>
        </section>

        {products.length ? (
          <section className="home-section" aria-labelledby="home-catalog">
            <Reveal className="home-section-head">
              <div>
                <p className="ui-eyebrow">From the catalog</p>
                <h2 id="home-catalog" className="home-section-title">
                  Ready designs you can customize
                </h2>
              </div>
              <Link href="/catalog" className="home-section-link">
                View the full catalog →
              </Link>
            </Reveal>
            <Reveal stagger className="mt-7 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
              {products.map((product, index) => (
                <ProductCard key={product.id} product={product} showAvailability={false} priority={index === 0} />
              ))}
            </Reveal>
          </section>
        ) : null}

        <section className="home-section" aria-labelledby="home-process">
          <div className="home-process">
            <Reveal className="home-process-intro">
              <p className="ui-eyebrow">How custom work happens</p>
              <h2 id="home-process" className="home-section-title">
                Four steps, no surprises
              </h2>
              <p className="mt-4 leading-7 text-brand-textMuted">
                The same sequence runs for a single bracket and for a short production run. You can see exactly where
                your order is at any point.
              </p>
              <Link href="/orders/new" className="ui-btn ui-btn-primary mt-6 !px-5 !py-2.5">
                Start a request
              </Link>
            </Reveal>

            <Reveal as="ol" stagger className="home-process-steps">
              {process.map((item) => (
                <li key={item.step} className="home-process-step">
                  <span className="home-process-number" aria-hidden="true">
                    {item.step}
                  </span>
                  <div>
                    <h3 className="text-lg font-semibold">{item.title}</h3>
                    <p className="mt-2 text-sm leading-6 text-brand-textMuted">{item.body}</p>
                  </div>
                </li>
              ))}
            </Reveal>
          </div>
        </section>

        {projects.length ? (
          <section className="home-section" aria-labelledby="home-projects">
            <Reveal className="home-section-head">
              <div>
                <p className="ui-eyebrow">Projects</p>
                <h2 id="home-projects" className="home-section-title">
                  Recent write-ups and builds
                </h2>
              </div>
              <Link href="/projects" className="home-section-link">
                All projects →
              </Link>
            </Reveal>
            <Reveal stagger className="mt-7 grid gap-4 md:grid-cols-3">
              {projects.map((project) => (
                <article key={project.id} className="content-grid-card">
                  {project.category ? <p className="ui-eyebrow">{project.category}</p> : null}
                  <h3 className="mt-2 text-lg font-semibold">
                    <Link href={`/projects/${project.slug}`} className="hover:text-brand-primary">
                      {project.title}
                    </Link>
                  </h3>
                </article>
              ))}
            </Reveal>
          </section>
        ) : null}

        <section className="home-section" aria-labelledby="home-cta">
          <div className="home-cta">
            <Reveal className="home-cta-primary">
              <p className="ui-eyebrow">Have something in mind?</p>
              <h2 id="home-cta" className="home-section-title">
                Send the idea. We&rsquo;ll tell you what it takes.
              </h2>
              <p className="mt-4 leading-7 text-brand-textMuted">
                A sketch on paper is enough to start. We will work out material, dimensions, finish, and a realistic
                path to a finished part — and say so plainly if it is not something this shop should make.
              </p>
              <div className="ui-action-row mt-6">
                <Link href="/orders/new" className="ui-btn ui-btn-primary !px-5 !py-2.5">
                  Start a custom request
                </Link>
                <Link href="/contact" className="ui-btn ui-btn-ghost !px-5 !py-2.5">
                  Ask a question
                </Link>
              </div>
            </Reveal>

            <Reveal className="home-cta-faq" delay={120}>
              <h3 className="text-lg font-semibold">Common questions</h3>
              <div className="mt-3 divide-y divide-[var(--border)]">
                {faq.map(([question, answer]) => (
                  <details key={question} className="home-faq-item">
                    <summary>{question}</summary>
                    <p className="mt-2 text-sm leading-6 text-brand-textMuted">{answer}</p>
                  </details>
                ))}
              </div>
              <p className="mt-4 text-sm text-brand-textMuted">
                More detail in the <Link href="/design-guide">design &amp; tolerance guide</Link>.
              </p>
            </Reveal>
          </div>
        </section>
      </div>
    </>
  );
}
