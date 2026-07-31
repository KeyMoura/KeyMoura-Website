"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { supabaseBrowser } from "@/lib/supabaseClient";
type Project = {
  id: string;
  name: string | null;
  make: string | null;
  model: string | null;
  summary: string | null;
  cover_image_url: string | null;
  created_at: string;
  owner_id: string;
};
export default function Page() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    void supabaseBrowser()
      .from("garage_cars")
      .select("id,name,make,model,summary,cover_image_url,created_at,owner_id")
      .eq("use_type", "project")
      .eq("visibility", "public")
      .order("created_at", { ascending: false })
      .then(({ data }) => {
        setProjects((data ?? []) as Project[]);
        setLoading(false);
      });
  }, []);
  return (
    <main className="mx-auto max-w-6xl px-4 py-10 text-brand-text">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-xs uppercase tracking-[.2em] text-brand-primary">
            Community
          </p>
          <h1 className="mt-2 text-4xl font-semibold">Workshop</h1>
          <p className="mt-2 text-brand-textMuted">
            Projects made by the KeyMoura community.
          </p>
        </div>
        <div className="flex gap-2">
          <Link
            href="/workshop/mine"
            className="rounded-xl border border-zinc-600 bg-zinc-800 px-4 py-2 text-zinc-100"
          >
            My projects
          </Link>
          <Link
            href="/workshop/new"
            className="rounded-xl border border-brand-primary bg-brand-primary/20 px-4 py-2 font-semibold text-brand-primary"
          >
            Post a project
          </Link>
        </div>
      </div>
      {loading ? (
        <p className="mt-10 text-brand-textMuted">Loading projects…</p>
      ) : projects.length === 0 ? (
        <div className="mt-10 rounded-2xl border border-zinc-800 p-8 text-center text-brand-textMuted">
          No projects yet. Be the first to share something.
        </div>
      ) : (
        <div className="mt-8 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {projects.map((p) => (
            <Link
              key={p.id}
              href={`/workshop/${p.id}`}
              className="overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-950/60 transition hover:border-brand-primary/60"
            >
              {p.cover_image_url ? (
                <img
                  src={p.cover_image_url}
                  alt=""
                  className="aspect-[4/3] w-full object-cover"
                />
              ) : (
                <div className="flex aspect-[4/3] items-center justify-center bg-zinc-900 text-zinc-600">
                  No image
                </div>
              )}
              <div className="p-4">
                <p className="text-xs uppercase tracking-wider text-brand-primary">
                  {p.make || "Project"}
                </p>
                <h2 className="mt-1 text-xl font-semibold">
                  {p.name || "Untitled project"}
                </h2>
                <p className="mt-1 text-sm text-brand-textMuted">
                  {p.model || "Custom build"}
                </p>
                {p.summary && (
                  <p className="mt-3 line-clamp-2 text-sm text-zinc-300">
                    {p.summary}
                  </p>
                )}
              </div>
            </Link>
          ))}
        </div>
      )}
    </main>
  );
}
