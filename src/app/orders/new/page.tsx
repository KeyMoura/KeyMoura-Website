import { routeServiceClient } from "@/lib/api/routeAuth";
import CustomRequestWizard from "@/components/orders/CustomRequestWizard";
import type { ProductOption } from "@/components/orders/CustomRequestSteps";

/**
 * `/orders/new` — the custom project intake.
 *
 * ## Why this became a server component
 *
 * It used to be `"use client"` from the first line, which meant the one thing
 * it could not do was know anything before it rendered. So the product a
 * customer might want changed was not offerable — there was no list — and
 * "customise something you already make" simply was not a journey this page
 * had. It existed only on a product page, in a different form, with different
 * fields, posting a different payload.
 *
 * Loading the catalog here closes that. The page renders knowing what KeyMoura
 * publishes, so the wizard can offer it, and a link from a product page
 * (`/orders/new?product=<slug>`) arrives with that product already resolved to
 * its real name rather than to whatever the query string said.
 *
 * Identity stays on the client, through `useCheckoutContext` — the same server
 * answer the cart and the product-page request form read, rather than a third
 * opinion about who is signed in.
 *
 * The list is read with the service client because it is public catalog data
 * and this page is public: published, unarchived products and two columns of
 * them. `/orders/[id]/confirmed` reads the same way for the same reason.
 */

export const dynamic = "force-dynamic";

async function loadRequestableProducts(): Promise<ProductOption[]> {
  const { data, error } = await routeServiceClient
    .from("products")
    .select("name,slug")
    .eq("is_published", true)
    .is("archived_at", null)
    .order("name", { ascending: true })
    .limit(200);

  if (error || !data) return [];
  return (data as { name: string; slug: string }[]).map((row) => ({ name: row.name, slug: row.slug }));
}

export default async function NewCustomRequestPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;
  const requested = typeof query.product === "string" ? query.product : "";

  const products = await loadRequestableProducts();
  // Resolved against the loaded list rather than trusted: an unknown or
  // unpublished slug in the URL simply starts an ordinary request instead of
  // seeding the form with a product that does not exist.
  const initialProduct = requested ? (products.find((entry) => entry.slug === requested) ?? null) : null;

  return (
    <main className="page-container">
      <CustomRequestWizard products={products} initialProduct={initialProduct} />
    </main>
  );
}
