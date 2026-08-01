"use client";

import { FormEvent, useState } from "react";

export default function ContactForm() {
  const [status, setStatus] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [message, setMessage] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setStatus("sending"); setMessage("");
    const form = event.currentTarget;
    const values = Object.fromEntries(new FormData(form).entries());
    try {
      const response = await fetch("/api/contact", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(values) });
      const body = await response.json() as { error?: string };
      if (!response.ok) throw new Error(body.error || "Could not send your message.");
      form.reset(); setStatus("sent"); setMessage("Message sent. We’ll reply by email as soon as possible.");
    } catch (error) { setStatus("error"); setMessage(error instanceof Error ? error.message : "Could not send your message."); }
  }

  const input = "mt-1 w-full rounded-xl border border-zinc-700 bg-black/40 px-3 py-2.5 outline-none focus:border-brand-primary";
  return <form onSubmit={submit} className="rounded-2xl border border-zinc-800 bg-black/30 p-5 sm:p-7">
    <div className="grid gap-4 sm:grid-cols-2"><label className="text-sm">Name<input name="name" required maxLength={100} autoComplete="name" className={input} /></label><label className="text-sm">Email<input name="email" required type="email" maxLength={254} autoComplete="email" className={input} /></label></div>
    <label className="mt-4 block text-sm">Subject<input name="subject" required maxLength={140} className={input} /></label>
    <label className="mt-4 block text-sm">Message<textarea name="message" required minLength={10} maxLength={5000} className={`${input} min-h-40`} placeholder="How can we help?" /></label>
    <label className="hidden" aria-hidden="true">Company website<input name="website" tabIndex={-1} autoComplete="off" /></label>
    {message ? <p role="status" className={`mt-4 text-sm ${status === "error" ? "text-rose-200" : "text-emerald-200"}`}>{message}</p> : null}
    <button disabled={status === "sending"} className="catalog-action-primary mt-5 rounded-full px-6 py-3 font-semibold disabled:opacity-60">{status === "sending" ? "Sending…" : "Send message"}</button>
  </form>;
}
