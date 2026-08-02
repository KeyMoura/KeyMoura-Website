"use client";

import { FormEvent, useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { MarkdownEditor } from "@/components/MarkdownEditor";
import { supabaseBrowser } from "@/lib/supabaseClient";

type LoadState = "idle" | "loading" | "loaded" | "error";

type ForumCategoryRow = {
  id: number;
  slug: string;
  name: string;
  description: string | null;
  is_archived: boolean;
  created_at: string;
};

function parseTags(input: string): string[] {
  const raw = input
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length > 0 && t.length <= 24);
  return Array.from(new Set(raw)).slice(0, 8);
}

export default function NewThreadPage() {
  const params = useParams();
  const router = useRouter();
  const slug = String(params?.slug ?? "");

  const [state, setState] = useState<LoadState>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const [category, setCategory] = useState<ForumCategoryRow | null>(null);

  const [isLoggedIn, setIsLoggedIn] = useState<boolean | null>(null);
  const [isBanned, setIsBanned] = useState<boolean>(false);

  const [title, setTitle] = useState("");
  const [tagsInput, setTagsInput] = useState("");
  const [body, setBody] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  // Load auth + ban state
  useEffect(() => {
    const loadAuth = async () => {
      try {
        const supabase = supabaseBrowser();
        const {
          data: { user },
        } = await supabase.auth.getUser();

        if (!user) {
          setIsLoggedIn(false);
          setIsBanned(false);
          return;
        }

        setIsLoggedIn(true);

        const { data: banRow, error: banErr } = await supabase
          .from("user_bans")
          .select("id, active")
          .eq("user_id", user.id)
          .eq("active", true)
          .maybeSingle<{ id: number; active: boolean }>();

        if (banErr) {
          console.error("Failed to check ban status on client", banErr);
          setIsBanned(false);
        } else {
          setIsBanned(!!banRow && banRow.active !== false);
        }
      } catch (e) {
        console.error("Unexpected error checking auth/ban state", e);
        setIsLoggedIn(null);
        setIsBanned(false);
      }
    };

    void loadAuth();
  }, []);

  // Load category
  useEffect(() => {
    if (!slug) return;

    const loadCategory = async () => {
      setState("loading");
      setErrorMessage(null);

      try {
        const supabase = supabaseBrowser();

        const {
          data: categoryRow,
          error: categoryError,
        } = await supabase
          .from("forum_categories")
          .select(
            "id, slug, name, description, is_archived, created_at"
          )
          .eq("slug", slug)
          .maybeSingle<ForumCategoryRow>();

        if (categoryError) {
          console.error("Failed to load forum category", categoryError);
          setErrorMessage("Failed to load category.");
          setState("error");
          return;
        }

        if (!categoryRow) {
          setErrorMessage("Category not found.");
          setState("error");
          return;
        }

        setCategory(categoryRow);
        setState("loaded");
      } catch (err) {
        console.error("Unexpected error loading category", err);
        setErrorMessage("Unexpected error loading category.");
        setState("error");
      }
    };

    void loadCategory();
  }, [slug]);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setCreateError(null);

    if (!category) {
      setCreateError("Category not loaded.");
      return;
    }

    const t = title.trim();
    const b = body.trim();
    const tags = parseTags(tagsInput);

    if (!t) {
      setCreateError("Title is required.");
      return;
    }
    if (!b) {
      setCreateError("Body is required.");
      return;
    }

    if (category.is_archived) {
      setCreateError("This category is archived and cannot accept new threads.");
      return;
    }

    if (isBanned) {
      setCreateError("You are banned and cannot create threads.");
      return;
    }

    if (isLoggedIn === false) {
      router.push(
        `/auth/login?next=${encodeURIComponent(
          `/community/${slug}/new`
        )}`
      );
      return;
    }

    try {
      setCreating(true);

      const supabase = supabaseBrowser();
      const {
        data: { session },
        error: sessionError,
      } = await supabase.auth.getSession();

      if (sessionError || !session?.access_token) {
        console.error("No session / access token", sessionError);
        router.push(
          `/auth/login?next=${encodeURIComponent(
            `/community/${slug}/new`
          )}`
        );
        return;
      }

      const res = await fetch("/api/forum/threads/create", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          categoryId: category.id,
          title: t,
          bodyMarkdown: b,
          tags,
        }),
      });

      const payload = (await res.json().catch(() => null)) as
        | { ok?: boolean; slug?: string; error?: string; categorySlug?: string }
        | null;

      if (!res.ok || !payload?.ok || !payload.slug) {
        console.error("Failed to create thread", payload);
        setCreateError(payload?.error ?? "Failed to create thread.");
        setCreating(false);
        return;
      }

      const targetCategorySlug = payload.categorySlug ?? category.slug;
      router.push(`/community/${targetCategorySlug}/${payload.slug}`);
    } catch (err) {
      console.error("Unexpected error creating thread", err);
      setCreateError("Unexpected error creating thread.");
      setCreating(false);
    }
  };

  const categoryHref = `/community/${slug}`;

  const parsedTags = parseTags(tagsInput);

  return (
    <div className="page-container page-stack max-w-3xl text-sm text-brand-text">
      <section className="space-y-2">
        <div className="flex items-center gap-2 text-[11px] text-brand-textMuted">
          <button
            type="button"
            onClick={() => router.push(categoryHref)}
            className="text-amber-300 underline underline-offset-2 hover:text-amber-200"
          >
            ← Back to {category ? category.name : "category"}
          </button>
          <span>•</span>
          <span>New thread</span>
        </div>

        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
          {category ? `New thread in ${category.name}` : "New thread"}
        </h1>

        {category?.description && (
          <p className="text-[12px] text-brand-textMuted sm:text-sm">
            {category.description}
          </p>
        )}

        {category?.is_archived && (
          <p className="mt-1 inline-flex items-center gap-1 rounded-full border border-zinc-700 bg-black/50 px-2 py-0.5 text-[11px] text-brand-textMuted">
            <span>⚠</span>
            <span>This category is archived and may be read-only.</span>
          </p>
        )}
      </section>
      {state === "error" && (
        <section>
          <p className="rounded-md border border-rose-500/60 bg-rose-950/40 px-3 py-2 text-[12px] text-rose-200">
            {errorMessage ?? "Failed to load category."}
          </p>
        </section>
      )}
      {state === "loading" && (
        <section>
          <p className="text-[12px] text-brand-textMuted">
            Loading category…
          </p>
        </section>
      )}
      {state === "loaded" && category && (
        <section className="ui-card text-[12px]">
          {isBanned && (
            <p className="mb-3 rounded-md border border-rose-500/60 bg-rose-950/40 px-3 py-2 text-[11px] text-rose-200">
              You are banned and cannot create new threads.
            </p>
          )}

          {isLoggedIn === false && !isBanned && (
            <p className="mb-3 rounded-md border border-zinc-700 bg-black/50 px-3 py-2 text-[11px] text-brand-textMuted">
              You must be logged in to post.{" "}
              <Link
                href={`/auth/login?next=${encodeURIComponent(
                  `/community/${slug}/new`
                )}`}
                className="text-amber-300 underline underline-offset-2 hover:text-amber-200"
              >
                Log in
              </Link>
            </p>
          )}

          <form className="space-y-2" onSubmit={handleSubmit}>
            <div className="space-y-1">
              <label className="block text-[11px] text-brand-textMuted">
                Title
              </label>
              <input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Thread title (e.g. “Best finish for outdoor aluminum brackets?”)"
                className="no-zoom-input w-full rounded-md border border-zinc-700 bg-black/40 px-2 py-1.5 text-[12px] text-brand-text outline-none placeholder:text-brand-textMuted focus:border-amber-400"
                disabled={creating || isBanned}
              />
            </div>

            <div className="space-y-1">
              <label className="block text-[11px] text-brand-textMuted">
                Tags (optional)
              </label>
              <input
                type="text"
                value={tagsInput}
                onChange={(e) => setTagsInput(e.target.value)}
                placeholder="e.g. aluminum, anodizing, tolerance"
                className="no-zoom-input w-full rounded-md border border-zinc-700 bg-black/40 px-2 py-1.5 text-[12px] text-brand-text outline-none placeholder:text-brand-textMuted focus:border-amber-400"
                disabled={creating || isBanned}
              />
              {parsedTags.length > 0 && (
                <div className="flex flex-wrap gap-2 text-[10px] text-brand-textMuted">
                  {parsedTags.map((tag) => (
                    <span
                      key={tag}
                      className="rounded-full border border-zinc-700/80 bg-black/30 px-2 py-0.5"
                    >
                      #{tag}
                    </span>
                  ))}
                </div>
              )}
            </div>

            <div className="space-y-1">
              <label className="block text-[11px] text-brand-textMuted">
                First post
              </label>
              <MarkdownEditor
                value={body}
                onChange={setBody}
                placeholder="Describe your question or topic in detail. Markdown supported."
                rows={10}
                disabled={creating || isBanned}
              />
            </div>

            {createError && (
              <p className="text-[11px] text-rose-300">{createError}</p>
            )}

            <div className="mt-2 flex items-center justify-between gap-2">
              <button
                type="button"
                onClick={() => router.push(categoryHref)}
                className="text-[11px] text-brand-textMuted hover:text-brand-text"
              >
                Cancel
              </button>

              <button
                type="submit"
                disabled={
                  creating ||
                  isBanned ||
                  isLoggedIn === false ||
                  category.is_archived
                }
                className="ui-btn ui-btn-primary text-[11px] disabled:opacity-60"
              >
                {creating ? "Posting…" : "Create thread"}
              </button>
            </div>
          </form>
        </section>
      )}
    </div>
  );
}
