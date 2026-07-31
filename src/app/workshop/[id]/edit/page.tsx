"use client";
import { use, useEffect, useState } from "react";
import { WorkshopProjectForm, WorkshopDraft } from "../../WorkshopProjectForm";
import { supabaseBrowser } from "@/lib/supabaseClient";
export default function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [draft, setDraft] = useState<WorkshopDraft | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    void (async () => {
      const sb = supabaseBrowser();
      const {
        data: { user },
      } = await sb.auth.getUser();
      if (!user) {
        setError("Log in to edit this project.");
        return;
      }
      const { data, error: e } = await sb
        .from("garage_cars")
        .select("id,owner_id,name,make,model,summary,mods,visibility")
        .eq("id", id)
        .eq("owner_id", user.id)
        .maybeSingle();
      if (e || !data) {
        setError("Project not found or you do not own it.");
        return;
      }
      const { data: imgs } = await sb
        .from("workshop_project_images")
        .select("image_url")
        .eq("project_id", id)
        .order("sort_order");
      setDraft({
        id,
        title: data.name ?? "",
        category: data.make ?? "",
        materials: data.model ?? "",
        summary: data.summary ?? "",
        process: data.mods ?? "",
        visibility: (data.visibility ??
          "public") as WorkshopDraft["visibility"],
        images: imgs?.length ? imgs.map((x) => x.image_url) : [],
      });
    })();
  }, [id]);
  return (
    <main className="mx-auto max-w-3xl px-4 py-10 text-brand-text">
      <p className="text-xs uppercase tracking-[.2em] text-brand-primary">
        Workshop
      </p>
      <h1 className="mt-2 text-3xl font-semibold">Edit project</h1>
      {error ? (
        <p className="mt-8 text-rose-200">{error}</p>
      ) : draft ? (
        <WorkshopProjectForm initial={draft} />
      ) : (
        <p className="mt-8 text-brand-textMuted">Loading…</p>
      )}
    </main>
  );
}
