import type { Metadata } from "next";
import Link from "next/link";
import ContactForm from "./ContactForm";
import { getSiteSettings } from "@/lib/siteSettings";

export const metadata: Metadata = { title: "Contact", description: "Contact KeyMoura about products, orders, or general CNC questions." };

export default async function ContactPage() {
  const settings = await getSiteSettings();
  return <main className="mx-auto max-w-6xl px-4 py-12 sm:py-16"><div className="grid gap-10 lg:grid-cols-[.75fr_1.25fr]"><section><p className="text-xs font-semibold uppercase tracking-[.22em] text-brand-primary">Contact</p><h1 className="mt-4 text-4xl font-semibold tracking-tight sm:text-5xl">Let’s figure out what you need.</h1><p className="mt-5 leading-7 text-brand-textMuted">Use this form for product questions, account help, or anything that does not belong to an existing order.</p><div className="mt-7 rounded-2xl border border-zinc-800 bg-black/30 p-5"><p className="font-semibold">Already have an order?</p><p className="mt-2 text-sm leading-6 text-brand-textMuted">Send the message from your order page so the conversation stays with its files and quote.</p><Link href="/orders" className="mt-3 inline-flex text-sm font-semibold text-brand-primary hover:underline">Open my orders →</Link></div><p className="mt-6 text-sm text-brand-textMuted">You can also email <a className="text-brand-primary hover:underline" href={`mailto:${settings.supportEmail}`}>{settings.supportEmail}</a>.</p></section><ContactForm /></div></main>;
}
