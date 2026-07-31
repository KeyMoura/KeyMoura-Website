"use client";
import Link from "next/link";
import { use, useEffect, useState } from "react";
import { supabaseBrowser } from "@/lib/supabaseClient";
type Project = {
  id: string;
  owner_id: string;
  name: string | null;
  make: string | null;
  model: string | null;
  summary: string | null;
  mods: string | null;
  cover_image_url: string | null;
  created_at: string;
};
type Comment = {
  id: string;
  author_id: string;
  body: string;
  created_at: string;
  profiles?: { username: string | null; display_name: string | null } | null;
};
export default function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [p, setP] = useState<Project | null>(null);
  const [images, setImages] = useState<string[]>([]);
  const [comments, setComments] = useState<Comment[]>([]);
  const [viewer, setViewer] = useState<string | null>(null);
  const [likes, setLikes] = useState(0);
  const [liked, setLiked] = useState(false);
  const [body, setBody] = useState("");
  const [error, setError] = useState("");
  async function token() {
    return (
      (await supabaseBrowser().auth.getSession()).data.session?.access_token ??
      null
    );
  }
  async function loadComments() {
    const sb = supabaseBrowser();
    const { data } = await sb
      .from("workshop_comments")
      .select("id,author_id,body,created_at")
      .eq("project_id", id)
      .order("created_at");
    const rows = (data ?? []) as Omit<Comment, "profiles">[];
    const authorIds = [...new Set(rows.map((row) => row.author_id))];
    const { data: profiles } = authorIds.length
      ? await sb.from("profiles").select("id,username,display_name").in("id", authorIds)
      : { data: [] };
    const byId = new Map((profiles ?? []).map((profile) => [profile.id, profile]));
    setComments(rows.map((row) => ({ ...row, profiles: byId.get(row.author_id) ?? null })));
  }
  useEffect(() => {
    void (async () => {
      const sb = supabaseBrowser();
      setViewer((await sb.auth.getUser()).data.user?.id ?? null);
      const { data, error: e } = await sb
        .from("garage_cars")
        .select(
          "id,owner_id,name,make,model,summary,mods,cover_image_url,created_at",
        )
        .eq("id", id)
        .maybeSingle();
      if (e || !data) {
        setError("Project not found.");
        return;
      }
      setP(data as Project);
      const { data: imgs } = await sb
        .from("workshop_project_images")
        .select("image_url")
        .eq("project_id", id)
        .order("sort_order");
      setImages(
        imgs?.length
          ? imgs.map((x) => x.image_url)
          : data.cover_image_url
            ? [data.cover_image_url]
            : [],
      );
      await loadComments();
      const t = await token();
      const r = await fetch(`/api/garage/${id}/likes`, {
        headers: t ? { Authorization: `Bearer ${t}` } : {},
      });
      const j = (await r.json().catch(() => null)) as {
        count?: number;
        liked?: boolean;
      } | null;
      setLikes(j?.count ?? 0);
      setLiked(!!j?.liked);
    })();
    // loadComments only depends on this route's stable id.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);
  async function toggle() {
    const t = await token();
    if (!t) {
      setError("Log in to like projects.");
      return;
    }
    const r = await fetch(`/api/garage/${id}/like`, {
      method: "POST",
      headers: { Authorization: `Bearer ${t}` },
    });
    const j = (await r.json()) as {
      count?: number;
      liked?: boolean;
      error?: string;
    };
    if (!r.ok) setError(j.error ?? "Could not update like.");
    else {
      setLikes(j.count ?? 0);
      setLiked(!!j.liked);
    }
  }
  async function comment() {
    const sb = supabaseBrowser();
    const {
      data: { user },
    } = await sb.auth.getUser();
    if (!user) {
      setError("Log in to comment.");
      return;
    }
    const text = body.trim();
    if (!text) return;
    const { error: e } = await sb
      .from("workshop_comments")
      .insert({ project_id: id, author_id: user.id, body: text });
    if (e) setError(e.message);
    else {
      setBody("");
      await loadComments();
    }
  }
  async function removeComment(c: Comment) {
    const { error: e } = await supabaseBrowser()
      .from("workshop_comments")
      .delete()
      .eq("id", c.id);
    if (e) setError(e.message);
    else setComments((v) => v.filter((x) => x.id !== c.id));
  }
  if (error && !p)
    return (
      <main className="mx-auto max-w-4xl px-4 py-16 text-rose-200">
        {error}
      </main>
    );
  if (!p)
    return (
      <main className="mx-auto max-w-4xl px-4 py-16 text-brand-textMuted">
        Loading project…
      </main>
    );
  return (
    <main className="mx-auto max-w-5xl px-4 py-10 text-brand-text">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <Link href="/workshop" className="text-sm text-brand-primary">
            ← Workshop
          </Link>
          <h1 className="mt-3 text-4xl font-semibold">
            {p.name || "Untitled project"}
          </h1>
          <p className="mt-2 text-brand-textMuted">
            {p.make || "Project"}
            {p.model ? ` · ${p.model}` : ""}
          </p>
        </div>
        {viewer === p.owner_id && (
          <Link
            href={`/workshop/${id}/edit`}
            className="rounded-xl border border-brand-primary bg-brand-primary/20 px-4 py-2 font-semibold text-brand-primary"
          >
            Edit project
          </Link>
        )}
      </div>
      {error && (
        <p className="mt-5 rounded-xl border border-rose-500/40 bg-rose-500/10 p-3 text-rose-200">
          {error}
        </p>
      )}
      {images.length > 0 && (
        <div className="mt-8 grid gap-3 sm:grid-cols-2">
          {images.map((url, i) => (
            <img
              key={`${url}-${i}`}
              src={url}
              alt={`${p.name ?? "Project"} image ${i + 1}`}
              className={`w-full rounded-2xl border border-zinc-800 object-cover ${i === 0 && images.length % 2 === 1 ? "sm:col-span-2 max-h-[620px]" : "aspect-[4/3]"}`}
            />
          ))}
        </div>
      )}
      <div className="mt-8 grid gap-6 md:grid-cols-2">
        {p.summary && (
          <section className="rounded-2xl border border-zinc-800 bg-zinc-950/50 p-5">
            <h2 className="font-semibold text-brand-primary">What I made</h2>
            <p className="mt-3 whitespace-pre-wrap text-zinc-300">
              {p.summary}
            </p>
          </section>
        )}
        {p.mods && (
          <section className="rounded-2xl border border-zinc-800 bg-zinc-950/50 p-5">
            <h2 className="font-semibold text-brand-primary">How I made it</h2>
            <p className="mt-3 whitespace-pre-wrap text-zinc-300">{p.mods}</p>
          </section>
        )}
      </div>
      <button
        onClick={() => void toggle()}
        className={`mt-6 rounded-xl border px-4 py-2 font-semibold ${liked ? "border-rose-400 bg-rose-500/20 text-rose-200" : "border-brand-primary/60 bg-brand-primary/10 text-brand-primary"}`}
      >
        {liked ? "♥" : "♡"} {likes} {likes === 1 ? "like" : "likes"}
      </button>
      <section className="mt-10">
        <h2 className="text-2xl font-semibold">Comments</h2>
        <div className="mt-4 flex gap-2">
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            maxLength={2000}
            placeholder="Ask a question or leave feedback…"
            className="min-h-20 flex-1 rounded-xl border border-zinc-700 bg-zinc-900 p-3 outline-none focus:border-brand-primary"
          />
          <button
            onClick={() => void comment()}
            disabled={!body.trim()}
            className="self-end rounded-xl border border-brand-primary bg-brand-primary/20 px-4 py-2 font-semibold text-brand-primary disabled:opacity-50"
          >
            Post
          </button>
        </div>
        <div className="mt-5 space-y-3">
          {comments.length === 0 ? (
            <p className="text-brand-textMuted">No comments yet.</p>
          ) : (
            comments.map((c) => (
              <article
                key={c.id}
                className="rounded-xl border border-zinc-800 bg-zinc-950/50 p-4"
              >
                <div className="flex justify-between gap-3">
                  <p className="text-sm font-semibold text-brand-primary">
                    {c.profiles?.display_name ||
                      c.profiles?.username ||
                      "Member"}
                  </p>
                  {(viewer === c.author_id || viewer === p.owner_id) && (
                    <button
                      onClick={() => void removeComment(c)}
                      className="text-xs text-rose-300"
                    >
                      Delete
                    </button>
                  )}
                </div>
                <p className="mt-2 whitespace-pre-wrap text-zinc-300">
                  {c.body}
                </p>
              </article>
            ))
          )}
        </div>
      </section>
    </main>
  );
}
