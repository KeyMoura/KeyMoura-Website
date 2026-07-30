"use client";

import Link from "next/link";
import { MenuSelect } from "@/components/ui/MenuSelect";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { MarkdownEditor } from "@/components/MarkdownEditor";
import { MarkdownContent } from "@/components/MarkdownContent";
import { supabaseBrowser } from "@/lib/supabaseClient";

type InfoPage = {
  id: string;
  title: string;
  slug: string;
  content_markdown: string;
  tags: string[] | null;
  category: string | null;
  chassis: string | null;
  status: string;
};

const CATEGORY_OPTIONS = [
  { value: "chassis-suspension", label: "Chassis & Suspension" },
  { value: "engine-drivetrain", label: "Engine & Drivetrain" },
  { value: "wiring-electronics", label: "Wiring & Electronics" },
  { value: "body-aero", label: "Body & Aero" },
  { value: "maintenance-general", label: "Maintenance & General" },
];

const CHASSIS_OPTIONS = [
  { value: "s13", label: "S13" },
  { value: "s14", label: "S14" },
  { value: "s15", label: "S15" },
  { value: "general", label: "General / Any" },
];

function normalizeTag(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, "-");
}

export default function InfoUpdatePage() {
  const params = useParams() as { slug: string };
  const router = useRouter();
  const supabase = useMemo(() => supabaseBrowser(), []);

  const slug = params.slug;

  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState<InfoPage | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [title, setTitle] = useState("");
  const [category, setCategory] = useState("maintenance-general");
  const [chassis, setChassis] = useState("general");
  const [tagsInput, setTagsInput] = useState("");
  const [content, setContent] = useState("");

  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [notVerified, setNotVerified] = useState(false);

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      setError(null);

      const { data: sessionData } = await supabase.auth.getSession();
      if (!sessionData.session) {
        // For pages that require auth, redirect to login instead of showing a dead-end error
        router.replace(`/login?next=${encodeURIComponent(`/info/${slug}/update`)}`);
        return;
      }

      // Permission gate (replaces old verified-only gate)
      setNotVerified(false);
      const token = sessionData.session.access_token;
      let canSubmit = false;
      if (token) {
        const res = await fetch("/api/me/access", {
          headers: { Authorization: `Bearer ${token}` },
        }).catch(() => null);
        const json = await res?.json().catch(() => null);
        const perms = Array.isArray(json?.permissions) ? json.permissions : [];
        canSubmit = perms.includes("info.update.submit");
      }

      if (!canSubmit) {
        setNotVerified(true);
        setLoading(false);
        return;
      }

      const { data, error: pageErr } = await supabase
        .from("info_pages")
        .select("id,title,slug,content_markdown,tags,category,chassis,status")
        .eq("slug", slug)
        .maybeSingle<InfoPage>();

      if (pageErr || !data) {
        setError("Page not found.");
        setLoading(false);
        return;
      }

      if (data.status !== "approved") {
        setError("Only approved pages can be updated.");
        setLoading(false);
        return;
      }

      setPage(data);
      setTitle(data.title);
      setCategory(data.category ?? "maintenance-general");
      setChassis(data.chassis ?? "general");
      setContent(data.content_markdown ?? "");
      setTagsInput((data.tags ?? []).join(", "));
      setLoading(false);
    };

    void load();
  }, [slug, supabase]);

  async function submitUpdate() {
    if (!page) return;

    setSubmitting(true);
    setMessage(null);

    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();

      if (!session) {
        setMessage("You must be logged in.");
        setSubmitting(false);
        return;
      }

      const tags = tagsInput
        .split(",")
        .map((t) => normalizeTag(t))
        .filter(Boolean)
        .slice(0, 24);

      const res = await fetch("/api/info/updates/submit", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          infoPageId: page.id,
          proposedTitle: title.trim(),
          proposedContentMarkdown: content,
          proposedTags: tags,
          proposedCategory: category,
          proposedChassis: chassis,
        }),
      });

      const data = (await res.json()) as { ok?: boolean; error?: string };

      if (!res.ok || !data.ok) {
        setMessage(data?.error ?? "Failed to submit update.");
        setSubmitting(false);
        return;
      }

      setSubmitting(false);
      router.push(`/info/${encodeURIComponent(page.slug)}?updateSubmitted=1`);
    } catch (e) {
      console.error(e);
      setMessage("Unexpected error submitting update.");
      setSubmitting(false);
    }
  }

  if (loading) {
    return (
      <div className="mx-auto max-w-6xl px-4 py-8 text-brand-textMuted">
        Loading...
      </div>
    );
  }

  if (notVerified) {
    return (
      <div className="mx-auto max-w-6xl px-4 py-8">
        <div className="rounded-xl border border-zinc-800/80 bg-black/40 p-4">
          <p className="text-sm text-amber-200">
            You do not have permission to submit updates to info pages.
          </p>
          <div className="mt-3">
            <Link href="/info" className="text-[12px] text-amber-300 underline underline-offset-2 hover:text-amber-200">
              ← Back to Info
            </Link>
          </div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="mx-auto max-w-6xl px-4 py-8">
        <div className="rounded-xl border border-zinc-800/80 bg-black/40 p-4">
          <p className="text-sm text-rose-200">{error}</p>
          <div className="mt-3">
            <Link href={`/info/${encodeURIComponent(slug)}`} className="text-[12px] text-amber-200 hover:underline">
              Back to page
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div>
          <p className="text-[11px] uppercase tracking-[0.15em] text-brand-textMuted">Suggest an update</p>
          <h1 className="text-2xl font-semibold text-brand-text">{page?.title}</h1>
          <div className="mt-2 text-[11px] text-brand-textMuted">
            <Link
              href={`/info/${encodeURIComponent(page?.slug ?? slug)}`}
              className="underline underline-offset-2 text-amber-300 hover:text-amber-200"
            >
              ← Back to page
            </Link>
          </div>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-[1fr,420px]">
        <div className="space-y-3">
          <MarkdownEditor value={content} onChange={setContent} />
        </div>

        <aside className="space-y-4">
          <div className="rounded-xl border border-zinc-800/80 bg-black/40 p-4 space-y-3">
            <div>
              <p className="text-[11px] text-brand-textMuted">Title</p>
              <input
                title="Title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                className="mt-1 w-full rounded-lg border border-zinc-700 bg-black/40 px-3 py-2 text-sm text-brand-text outline-none"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <p className="text-[11px] text-brand-textMuted">Category</p>
                <MenuSelect
                  ariaLabel="Category"
                  value={category as string}
                  onChange={(next) => setCategory(next)}
                  className="mt-1 flex h-10 w-full items-center gap-2 rounded-lg border border-zinc-700 bg-black/40 px-3 py-2 text-[12px] text-brand-text outline-none transition hover:border-zinc-500"
                  options={CATEGORY_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
                />
              </div>
              <div>
                <p className="text-[11px] text-brand-textMuted">Chassis</p>
                <MenuSelect
                  ariaLabel="Chassis"
                  value={chassis as string}
                  onChange={(next) => setChassis(next)}
                  className="mt-1 flex h-10 w-full items-center gap-2 rounded-lg border border-zinc-700 bg-black/40 px-3 py-2 text-[12px] text-brand-text outline-none transition hover:border-zinc-500"
                  options={CHASSIS_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
                />
              </div>
            </div>

            <div>
              <p className="text-[11px] text-brand-textMuted">Tags (comma separated)</p>
              <input
                title="Tags"
                value={tagsInput}
                onChange={(e) => setTagsInput(e.target.value)}
                className="mt-1 w-full rounded-lg border border-zinc-700 bg-black/40 px-3 py-2 text-sm text-brand-text outline-none"
              />
            </div>

            {message && (
              <div className="rounded-lg border border-rose-400/30 bg-rose-500/10 p-2 text-[12px] text-rose-200">
                {message}
              </div>
            )}

            <button
              type="button"
              disabled={submitting}
              onClick={() => void submitUpdate()}
              className={`w-full rounded-full border px-4 py-2 text-[12px] font-medium transition ${
                submitting
                  ? "cursor-not-allowed opacity-60 border-zinc-700 bg-black/30 text-brand-textMuted"
                  : "border-amber-400/80 bg-amber-500/20 text-amber-200 hover:border-amber-300/90"
              }`}
            >
              {submitting ? "Submitting..." : "Submit update for review"}
            </button>

            <p className="text-[11px] text-brand-textMuted">
              Updates are reviewed by admins before going live.
            </p>
          </div>
        </aside>
      </div>
    </div>
  );
}
