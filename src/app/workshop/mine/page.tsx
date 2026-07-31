"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabaseBrowser } from "@/lib/supabaseClient";
type P = {
  id: string;
  name: string | null;
  make: string | null;
  cover_image_url: string | null;
  visibility: string | null;
};
export default function Page() {
  const router = useRouter();
  const [items, setItems] = useState<P[]>([]);
  const [message, setMessage] = useState("Loading…");
  async function load() {
    const sb = supabaseBrowser();
    const {
      data: { user },
    } = await sb.auth.getUser();
    if (!user) {
      setMessage("Log in to manage your projects.");
      return;
    }
    const { data, error } = await sb
      .from("garage_cars")
      .select("id,name,make,cover_image_url,visibility")
      .eq("owner_id", user.id)
      .eq("use_type", "project")
      .order("updated_at", { ascending: false });
    setItems((data ?? []) as P[]);
    setMessage(error ? "Could not load your projects." : "");
  }
  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, []);
  async function remove(id: string) {
    if (!confirm("Delete this project? This cannot be undone.")) return;
    const { error } = await supabaseBrowser()
      .from("garage_cars")
      .delete()
      .eq("id", id);
    if (error) setMessage(error.message);
    else setItems((v) => v.filter((x) => x.id !== id));
  }
  return (
    <main className="mx-auto max-w-4xl px-4 py-10 text-brand-text">
      <div className="flex items-end justify-between">
        <div>
          <p className="text-xs uppercase tracking-[.2em] text-brand-primary">
            Workshop
          </p>
          <h1 className="mt-2 text-3xl font-semibold">My projects</h1>
        </div>
        <Link
          href="/workshop/new"
          className="rounded-xl border border-brand-primary bg-brand-primary/20 px-4 py-2 font-semibold text-brand-primary"
        >
          New project
        </Link>
      </div>
      {message && <p className="mt-8 text-brand-textMuted">{message}</p>}
      <div className="mt-8 space-y-3">
        {items.map((p) => (
          <div
            key={p.id}
            className="flex items-center gap-4 rounded-2xl border border-zinc-800 bg-zinc-950/50 p-3"
          >
            {p.cover_image_url ? (
              <img
                src={p.cover_image_url}
                alt=""
                className="h-20 w-24 rounded-xl object-cover"
              />
            ) : (
              <div className="h-20 w-24 rounded-xl bg-zinc-900" />
            )}
            <div className="min-w-0 flex-1">
              <Link
                href={`/workshop/${p.id}`}
                className="font-semibold hover:text-brand-primary"
              >
                {p.name || "Untitled project"}
              </Link>
              <p className="text-sm text-brand-textMuted">
                {p.make || "Project"} · {p.visibility}
              </p>
            </div>
            <button
              onClick={() => router.push(`/workshop/${p.id}/edit`)}
              className="rounded-lg border border-brand-primary/50 bg-brand-primary/10 px-3 py-2 text-sm text-brand-primary"
            >
              Edit
            </button>
            <button
              onClick={() => void remove(p.id)}
              className="rounded-lg border border-rose-500/50 bg-rose-500/10 px-3 py-2 text-sm text-rose-200"
            >
              Delete
            </button>
          </div>
        ))}
      </div>
    </main>
  );
}
