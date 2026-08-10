import type { Metadata } from "next";
import Link from "next/link";

import { getSiteSettings } from "@/lib/siteSettings";
import SupportRequestForm from "./SupportRequestForm";

export const metadata: Metadata = {
  title: "Support",
  description: "Ask KeyMoura about an order, a custom project, shipping, a return, or anything else.",
};

/**
 * The support front door.
 *
 * `/contact` used to live here and posted to a route that sent one email and
 * stored nothing — no record, no status, no owner, no history. This page opens a
 * real conversation: it gets a reference, it lands in a staff inbox, and an
 * account holder can read the whole thread back at `/account/support`.
 *
 * Kept deliberately small. Category, subject, message, and — only when it is
 * useful and only when ownership can be proved — an order. A support form is
 * something a person reaches when they are already mildly annoyed, and every
 * extra field is one more reason to close the tab and send an email instead.
 */
export default async function SupportPage({
  searchParams,
}: {
  searchParams: Promise<{ order?: string; category?: string }>;
}) {
  const [settings, params] = await Promise.all([getSiteSettings(), searchParams]);

  return (
    <main className="mx-auto max-w-6xl px-4 py-12 sm:py-16">
      <div className="grid gap-10 lg:grid-cols-[.8fr_1.2fr]">
        <section>
          <p className="text-xs font-semibold uppercase tracking-[.22em] text-brand-primary">Support</p>
          <h1 className="mt-4 text-4xl font-semibold tracking-tight sm:text-5xl">Need help?</h1>
          <p className="mt-5 leading-7 text-brand-textMuted">
            Tell us what is going on and we will come back to you. Every request gets a reference so nothing gets
            lost.
          </p>

          <div className="mt-7 rounded-2xl border border-zinc-800 bg-black/30 p-5">
            <p className="font-semibold">Already signed in?</p>
            <p className="mt-2 text-sm leading-6 text-brand-textMuted">
              Your requests and our replies live in one place, and you can attach an order you have placed.
            </p>
            <Link
              href="/account/support"
              className="mt-3 inline-flex text-sm font-semibold text-brand-primary hover:underline"
            >
              My support requests →
            </Link>
          </div>

          {settings.supportEmail ? (
            <p className="mt-6 text-sm text-brand-textMuted">
              You can also email{" "}
              <a className="text-brand-primary hover:underline" href={`mailto:${settings.supportEmail}`}>
                {settings.supportEmail}
              </a>
              .
            </p>
          ) : null}
        </section>

        {/*
          The order id arrives in the URL from the guest order page and from the
          account order page. It is a *suggestion*: the server re-derives whether
          this requester may attach it — account ownership, or the guest session
          cookie — and refuses otherwise. Nothing here is trusted.
        */}
        <SupportRequestForm initialOrderId={params.order ?? null} initialCategory={params.category ?? null} />
      </div>
    </main>
  );
}
