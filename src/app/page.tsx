import Link from "next/link";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { getSiteSettings } from "@/lib/siteSettings";

export default async function Home() {
  const siteSettings = await getSiteSettings();
  const cookieStore = await cookies();
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => cookieStore.getAll(),
        setAll: () => {
          // no-op in Server Components
        },
      },
    }
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { data: profile } = user
    ? await supabase
        .from("profiles")
        .select("is_verified")
        .eq("id", user.id)
        .maybeSingle()
    : { data: null as null };

  const isVerified = Boolean(profile?.is_verified);

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-10 px-4 py-10 md:py-16">
      {/* Hero */}
      <section className="relative overflow-hidden rounded-2xl border border-zinc-800/80">
        {/* Background image */}
        <div
          className="absolute inset-0 bg-cover bg-center"
          style={{
            backgroundImage: `url('${siteSettings.logoUrl}')`,
          }}
        />

        {/* Dark overlay */}
        <div className="absolute inset-0 bg-black/65 backdrop-blur-[1px]" />

        {/* Content */}
        <div className="relative z-10 flex flex-col gap-6 px-6 py-10 md:flex-row md:items-center md:justify-between md:px-10 md:py-16">
          {/* Left */}
          <div className="max-w-xl space-y-4">
            <p className="text-[11px] uppercase tracking-[0.15em] text-brand-textMuted">
              {siteSettings.name}
            </p>

            <h1 className="text-3xl font-semibold tracking-tight text-brand-text sm:text-4xl">
              {siteSettings.tagline}
            </h1>

            <p className="text-sm leading-relaxed text-brand-textMuted sm:text-base">
              {siteSettings.description}
            </p>

            <div className="mt-4 flex flex-wrap gap-3">
              <Link
                href="/info"
                className="inline-flex items-center justify-center rounded-full border border-[#ebc313] bg-[#ebc313] px-4 py-2 font-medium text-black shadow-sm shadow-black/60 transition hover:bg-[#ebe013]"
              >
                Browse {siteSettings.terminology.knowledgeBase.toLowerCase()}
              </Link>

              <Link
                href="/community"
                className="inline-flex items-center justify-center rounded-full border border-zinc-700 bg-black/40 px-4 py-2 text-sm font-medium text-brand-text transition hover:bg-black/60"
              >
                Join the {siteSettings.terminology.forum.toLowerCase()}
              </Link>
            </div>

            <p className="mt-3 text-[11px] text-brand-textMuted">
              Info guides are drafted, reviewed by admins, and only published once
              they&apos;re verified — so you can actually trust what you read.
            </p>
          </div>

          {/* Right / Quick Find */}
          <div className="mt-6 w-full max-w-sm md:mt-0">
            <div className="rounded-xl border border-zinc-800/80 bg-black/50 p-4 text-xs text-brand-textMuted shadow-sm backdrop-blur">
              <p className="mb-2 text-[11px] uppercase tracking-wide text-brand-textMuted">
                Quick Find
              </p>

              <ul className="space-y-2">
                {/* Card 1 */}
                <li>
                  <Link
                    href="info/category/oem-manuals"
                    className="group block rounded-md border border-zinc-800/80 bg-black/40 px-3 py-2 transition
                               hover:border-zinc-700 hover:bg-black/55
                               focus:outline-none focus-visible:ring-2 focus-visible:ring-[#ebc313]/70"
                    aria-label="Quick Find: OEM Literature"
                  >
                    <p className="text-[13px] font-medium text-brand-text transition group-hover:text-white">
                      OEM Literature
                    </p>
                    <p className="text-[11px] text-brand-textMuted">
                      Full service manuals, brochures, parts catalogs.
                    </p>
                  </Link>
                </li>

                {/* Card 2 */}
                <li>
                  <Link
                    href="/info/category/engine-drivetrain"
                    className="group block rounded-md border border-zinc-800/80 bg-black/40 px-3 py-2 transition
                               hover:border-zinc-700 hover:bg-black/55
                               focus:outline-none focus-visible:ring-2 focus-visible:ring-[#ebc313]/70"
                    aria-label="Quick Find: Engine & Drivetrain"
                  >
                    <p className="text-[13px] font-medium text-brand-text transition group-hover:text-white">
                      Engine &amp; Drivetrain
                    </p>
                    <p className="text-[11px] text-brand-textMuted">
                      SR swaps, turbo setups, fueling, cooling.
                    </p>
                  </Link>
                </li>

                {/* Card 3 */}
                <li>
                  <Link
                    href="/info/category/wiring-electronics"
                    className="group block rounded-md border border-zinc-800/80 bg-black/40 px-3 py-2 transition
                               hover:border-zinc-700 hover:bg-black/55
                               focus:outline-none focus-visible:ring-2 focus-visible:ring-[#ebc313]/70"
                    aria-label="Quick Find: Wiring & Electronics"
                  >
                    <p className="text-[13px] font-medium text-brand-text transition group-hover:text-white">
                      Wiring &amp; Electronics
                    </p>
                    <p className="text-[11px] text-brand-textMuted">
                      ECU wiring, digital dashes, sensors, CAN.
                    </p>
                  </Link>
                </li>
              </ul>
            </div>
          </div>
        </div>
      </section>

      {/* What’s inside */}
      <section className="space-y-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-brand-textMuted">
          What&apos;s inside
        </h2>

        <div className="grid gap-4 md:grid-cols-3">
          <div className="rounded-xl border border-zinc-800/80 bg-black/40 p-4 text-sm">
            <h3 className="mb-1 text-[13px] font-semibold text-brand-text">
              Deep-dive info pages
            </h3>
            <p className="text-[12px] text-brand-textMuted">
              Detailed writeups with tables of contents, tuned specifically
              around the S-chassis platform instead of generic car advice.
            </p>
          </div>

          <div className="rounded-xl border border-zinc-800/80 bg-black/40 p-4 text-sm">
            <h3 className="mb-1 text-[13px] font-semibold text-brand-text">
              Community Forums
            </h3>
            <p className="text-[12px] text-brand-textMuted">
              Talk with fellow S-chassis enthusiasts, ask questions, and share
              your own knowledge.
            </p>
          </div>

          <div className="rounded-xl border border-zinc-800/80 bg-black/40 p-4 text-sm">
            <h3 className="mb-1 text-[13px] font-semibold text-brand-text">
              Built by S-chassis owners
            </h3>
            <p className="text-[12px] text-brand-textMuted">
              Content from people who actually own and track these cars, not
              generic scraped articles.
            </p>
          </div>
        </div>
      </section>

      {/* Contribute */}
      {isVerified ? (
<section className="mt-2 rounded-xl border border-zinc-800/80 bg-black/40 p-4">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div>
            <h2 className="text-sm font-semibold text-brand-text">
              Want to contribute?
            </h2>
            <p className="text-[12px] text-brand-textMuted">
              Log in, write a draft, and submit it for review. You can track your
              submissions and drafts from your account.
            </p>
          </div>

          <div className="flex flex-wrap gap-2">
            <Link
              href="/info/submit"
              className="inline-flex items-center justify-center rounded-full bg-white px-4 py-2 text-[12px] font-medium text-black shadow-sm shadow-black/30 transition hover:bg-white"
            >
              Submit new information
            </Link>

            <Link
              href="/info/mine"
              className="inline-flex items-center justify-center rounded-full border border-zinc-700 bg-black/40 px-4 py-2 text-[12px] font-medium text-brand-text transition hover:bg-black/60"
            >
              View my submissions
            </Link>
          </div>
        </div>
      </section>
      ) : null}
    </div>
  );
}
