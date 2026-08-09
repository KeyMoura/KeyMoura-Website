import Link from "next/link";
import { routeServiceClient } from "@/lib/api/routeAuth";
import { customerOrderPath } from "@/lib/commerce/orderUrls";

/**
 * "Request received", and a link to the request that actually opens it.
 *
 * ## Why this reads the database for one column
 *
 * This page used to be a client component that built its own `/orders/<id>`
 * link out of the route parameter. That is the same reconstruction the email
 * sender was fixed for in pass 18: `/orders/<id>` reads `orders` through RLS as
 * the signed-in customer, so a guest following it sees a permission error for
 * their own request. Today only the two signed-in submit paths route here, so
 * the reconstruction happened to be right — it was one changed guard away from
 * being wrong, and nothing would have failed loudly when it did.
 *
 * Resolving `customer_id` and handing it to `customerOrderPath` makes the
 * guarantee structural instead of conditional: whoever arrives, the button goes
 * where their order is readable. It is the same single decision the emails use.
 *
 * The lookup reads one indexed column and discloses nothing. The markup is
 * identical either way — only the button's target differs — and both targets
 * refuse an unauthorized viewer anyway: the account page through RLS, the guest
 * page through the six-digit challenge. A failed lookup keeps the historical
 * `/orders/<id>`, which is where every route that currently leads here belongs.
 */

export const dynamic = "force-dynamic";

export default async function OrderConfirmedPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  let href = `/orders/${id}`;
  if (uuid.test(id)) {
    const { data, error } = await routeServiceClient
      .from("orders")
      .select("customer_id")
      .eq("id", id)
      .maybeSingle();
    if (!error && data) {
      href = customerOrderPath(id, (data as { customer_id: string | null }).customer_id);
    }
  }

  return (
    <main className="mx-auto flex min-h-[65vh] max-w-2xl items-center px-4 py-12">
      <section className="w-full rounded-3xl border border-emerald-400/30 bg-emerald-400/5 p-7 text-center sm:p-10">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-emerald-400/15 text-2xl text-emerald-200">
          ✓
        </div>
        <p className="mt-5 text-xs font-semibold uppercase tracking-[.2em] text-emerald-200">Request received</p>
        <h1 className="mt-2 text-3xl font-semibold">You&rsquo;re all set.</h1>
        <p className="mx-auto mt-3 max-w-lg text-brand-textMuted">
          Your item and any limited inventory are reserved while KeyMoura reviews the details. We sent a
          confirmation email and will follow up in your order chat.
        </p>
        <div className="mt-7 flex flex-col justify-center gap-3 sm:flex-row">
          <Link href={href} className="catalog-action-primary rounded-xl px-5 py-3 font-semibold">
            View request
          </Link>
          <Link
            href="/catalog"
            className="rounded-xl border border-zinc-700 px-5 py-3 font-semibold transition hover:border-brand-primary/70"
          >
            Back to catalog
          </Link>
        </div>
      </section>
    </main>
  );
}
