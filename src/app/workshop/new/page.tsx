"use client";
import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { supabaseBrowser } from "@/lib/supabaseClient";

export default function NewWorkshopProjectPage() {
  const router = useRouter();
  const [form, setForm] = useState({ title: "", category: "", materials: "", summary: "", process: "", image: "" });
  const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  const set = (key: keyof typeof form, value: string) => setForm(v => ({ ...v, [key]: value }));
  async function submit() {
    setBusy(true); setError("");
    const { data } = await supabaseBrowser().auth.getSession(); const session = data.session;
    if (!session) { setError("Log in before posting a project."); setBusy(false); return; }
    const res = await fetch("/api/garage/new", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` }, body: JSON.stringify({ owner_id: session.user.id, name: form.title, make: form.category || "Project", model: form.materials || "Custom", year: null, chassis: null, trim: null, color: null, engine: null, power_hp: null, torque_ftlb: null, weight_lb: null, summary: form.summary || null, mods: form.process || null, use_type: "project", visibility: "public", is_primary: false, cover_image_url: form.image || null }) });
    const json = await res.json().catch(() => null) as { id?: string; error?: string } | null;
    if (!res.ok || !json?.id) { setError(json?.error ?? "Could not post project."); setBusy(false); return; }
    router.push(`/workshop/${json.id}`);
  }
  const input = "mt-1 w-full rounded-xl border border-zinc-700 bg-zinc-900/80 px-3 py-2.5 text-brand-text outline-none focus:border-brand-primary";
  return <main className="mx-auto max-w-3xl px-4 py-10 text-brand-text"><p className="text-xs uppercase tracking-[.2em] text-brand-primary">Workshop</p><h1 className="mt-2 text-3xl font-semibold">Post something you made</h1><p className="mt-2 text-brand-textMuted">Share a CNC project, printed part, woodworking build, electronics project, or anything else you created.</p><div className="mt-8 space-y-4 rounded-2xl border border-zinc-800 bg-zinc-950/50 p-5">{error ? <p className="rounded-xl border border-rose-500/40 bg-rose-500/10 p-3 text-rose-200">{error}</p> : null}<label className="block text-sm">Project title<input className={input} value={form.title} onChange={e => set("title", e.target.value)} /></label><div className="grid gap-4 sm:grid-cols-2"><label className="block text-sm">Category<input className={input} placeholder="CNC, woodworking…" value={form.category} onChange={e => set("category", e.target.value)} /></label><label className="block text-sm">Materials<input className={input} placeholder="Walnut, Delrin…" value={form.materials} onChange={e => set("materials", e.target.value)} /></label></div><label className="block text-sm">What did you make?<textarea className={`${input} min-h-28`} value={form.summary} onChange={e => set("summary", e.target.value)} /></label><label className="block text-sm">How did you make it?<textarea className={`${input} min-h-28`} value={form.process} onChange={e => set("process", e.target.value)} /></label><label className="block text-sm">Image URL (optional)<input className={input} value={form.image} onChange={e => set("image", e.target.value)} /></label><div className="flex gap-3"><button type="button" disabled={busy || !form.title.trim()} onClick={() => void submit()} className="rounded-xl border border-brand-primary bg-brand-primary/20 px-5 py-2.5 font-semibold text-brand-primary hover:bg-brand-primary/30 disabled:opacity-50">{busy ? "Posting…" : "Post project"}</button><Link href="/workshop" className="rounded-xl border border-zinc-600 bg-zinc-800 px-5 py-2.5 text-zinc-100">Cancel</Link></div></div></main>;
}
