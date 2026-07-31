"use client";
import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { supabaseBrowser } from "@/lib/supabaseClient";

export type WorkshopDraft = {
  id?: string;
  title: string;
  category: string;
  materials: string;
  summary: string;
  process: string;
  visibility: "public" | "unlisted" | "private";
  images: string[];
};
export function WorkshopProjectForm({ initial }: { initial?: WorkshopDraft }) {
  const router = useRouter();
  const [form, setForm] = useState<WorkshopDraft>(
    initial ?? {
      title: "",
      category: "",
      materials: "",
      summary: "",
      process: "",
      visibility: "public",
      images: [],
    },
  );
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const input =
    "mt-1 w-full rounded-xl border border-zinc-700 bg-zinc-900/80 px-3 py-2.5 text-brand-text outline-none focus:border-brand-primary";
  async function submit() {
    setBusy(true);
    setError("");
    try {
      const sb = supabaseBrowser();
      const { data } = await sb.auth.getSession();
      const s = data.session;
      if (!s) throw new Error("Log in before saving a project.");
      const urls = [...form.images];
      for (const file of files) {
        if (!file.type.startsWith("image/") || file.size > 10 * 1024 * 1024)
          throw new Error("Images must be JPG, PNG, or WebP and under 10 MB.");
        const path = `${s.user.id}/${crypto.randomUUID()}-${file.name.replace(/[^a-zA-Z0-9._-]/g, "-")}`;
        const up = await sb.storage
          .from("garage-covers")
          .upload(path, file, { contentType: file.type });
        if (up.error) throw up.error;
        urls.push(
          sb.storage.from("garage-covers").getPublicUrl(path).data.publicUrl,
        );
      }
      const endpoint = form.id ? "/api/garage/update" : "/api/garage/new";
      const body = {
        id: form.id,
        owner_id: s.user.id,
        name: form.title,
        make: form.category || "Project",
        model: form.materials || "Custom",
        year: null,
        chassis: null,
        trim: null,
        color: null,
        engine: null,
        power_hp: null,
        torque_ftlb: null,
        weight_lb: null,
        summary: form.summary || null,
        mods: form.process || null,
        use_type: "project",
        visibility: form.visibility,
        is_primary: false,
        cover_image_url: urls[0] ?? null,
      };
      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${s.access_token}`,
        },
        body: JSON.stringify(body),
      });
      const json = (await res.json().catch(() => null)) as {
        id?: string;
        error?: string;
      } | null;
      if (!res.ok) throw new Error(json?.error ?? "Could not save project.");
      const id = form.id ?? json?.id;
      if (!id) throw new Error("Project saved without an ID.");
      await sb.from("workshop_project_images").delete().eq("project_id", id);
      if (urls.length) {
        const ins = await sb
          .from("workshop_project_images")
          .insert(
            urls.map((image_url, i) => ({
              project_id: id,
              owner_id: s.user.id,
              image_url,
              sort_order: i,
            })),
          );
        if (ins.error) throw ins.error;
      }
      router.push(`/workshop/${id}`);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save project.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="mt-8 space-y-4 rounded-2xl border border-zinc-800 bg-zinc-950/50 p-5">
      {error && (
        <p className="rounded-xl border border-rose-500/40 bg-rose-500/10 p-3 text-rose-200">
          {error}
        </p>
      )}
      <label className="block text-sm">
        Project title
        <input
          className={input}
          value={form.title}
          onChange={(e) => setForm({ ...form, title: e.target.value })}
        />
      </label>
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block text-sm">
          Category
          <input
            className={input}
            placeholder="CNC, woodworking…"
            value={form.category}
            onChange={(e) => setForm({ ...form, category: e.target.value })}
          />
        </label>
        <label className="block text-sm">
          Materials
          <input
            className={input}
            placeholder="Walnut, Delrin…"
            value={form.materials}
            onChange={(e) => setForm({ ...form, materials: e.target.value })}
          />
        </label>
      </div>
      <label className="block text-sm">
        What did you make?
        <textarea
          className={`${input} min-h-28`}
          value={form.summary}
          onChange={(e) => setForm({ ...form, summary: e.target.value })}
        />
      </label>
      <label className="block text-sm">
        How did you make it?
        <textarea
          className={`${input} min-h-28`}
          value={form.process}
          onChange={(e) => setForm({ ...form, process: e.target.value })}
        />
      </label>
      <label className="block text-sm">
        Project images
        <input
          type="file"
          accept="image/jpeg,image/png,image/webp"
          multiple
          className={input}
          onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
        />
        <span className="mt-1 block text-xs text-brand-textMuted">
          Up to 10 MB each. The first image is the cover.
        </span>
      </label>
      {form.images.length > 0 && (
        <div className="grid grid-cols-3 gap-2">
          {form.images.map((url, i) => (
            <button
              type="button"
              key={url}
              onClick={() =>
                setForm({
                  ...form,
                  images: form.images.filter((_, n) => n !== i),
                })
              }
              className="overflow-hidden rounded-xl border border-zinc-700 bg-zinc-900"
            >
              <img
                src={url}
                alt="Existing project"
                className="aspect-square w-full object-cover"
              />
              <span className="block p-1 text-xs text-zinc-200">Remove</span>
            </button>
          ))}
        </div>
      )}
      <label className="block text-sm">
        Visibility
        <select
          className={input}
          value={form.visibility}
          onChange={(e) =>
            setForm({
              ...form,
              visibility: e.target.value as WorkshopDraft["visibility"],
            })
          }
        >
          <option value="public">Public</option>
          <option value="unlisted">Unlisted</option>
          <option value="private">Private</option>
        </select>
      </label>
      <div className="flex gap-3">
        <button
          type="button"
          disabled={busy || !form.title.trim()}
          onClick={() => void submit()}
          className="rounded-xl border border-brand-primary bg-brand-primary/20 px-5 py-2.5 font-semibold text-brand-primary hover:bg-brand-primary/30 disabled:opacity-50"
        >
          {busy ? "Saving…" : form.id ? "Save changes" : "Post project"}
        </button>
        <Link
          href={form.id ? `/workshop/${form.id}` : "/workshop"}
          className="rounded-xl border border-zinc-600 bg-zinc-800 px-5 py-2.5 text-zinc-100"
        >
          Cancel
        </Link>
      </div>
    </div>
  );
}
