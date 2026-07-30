"use client";

import React, { useEffect, useState } from "react";
import { MarkdownContent } from "@/components/MarkdownContent";
import Link from "next/link";
import { supabaseBrowser } from "@/lib/supabaseClient";

type InfoPage = {
  id: string;
  title: string;
  slug: string;
  content_markdown: string;
  created_at: string;
  status: string;
};

type ReviewEvent = {
  id: string;
  info_page_id: string;
  notes: string | null;
  created_at: string;
};

type LastNoteByPage = {
  [infoPageId: string]: {
    created_at: string;
    notes: string;
  };
};

export default function MyInfoSubmissionsPage() {
  const supabase = supabaseBrowser();

  const [loading, setLoading] = useState(true);
  const [pages, setPages] = useState<InfoPage[]>([]);
  const [lastNotes, setLastNotes] = useState<LastNoteByPage>({});
  const [error, setError] = useState<string | null>(null);
  const [userId, setUserId] = useState<string | null>(null);

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      setError(null);

      try {
        const {
          data: { user },
          error: userError,
        } = await supabase.auth.getUser();

        if (userError || !user) {
          setUserId(null);
          setPages([]);
          setLastNotes({});
          setError("You must be logged in to see your submissions.");
          setLoading(false);
          return;
        }

        setUserId(user.id);

        // 1) load info pages created by this user
        const { data: pagesData, error: pagesError } = await supabase
          .from("info_pages")
          .select(
            "id, title, slug, content_markdown, created_at, status"
          )
          .eq("created_by", user.id)
          .order("created_at", { ascending: false });

        if (pagesError) {
          console.error("Failed to load your info pages:", pagesError);
          setError("Failed to load your submissions.");
          setLoading(false);
          return;
        }

        const infoPages = (pagesData || []) as InfoPage[];
        setPages(infoPages);

        if (infoPages.length === 0) {
          setLastNotes({});
          setLoading(false);
          return;
        }

        const ids = infoPages.map((p) => p.id);

        // 2) load last note per page (if any)
        const { data: eventsData, error: eventsError } = await supabase
          .from("info_page_review_events")
          .select("id, info_page_id, notes, created_at")
          .in("info_page_id", ids)
          .order("created_at", { ascending: true });

        if (eventsError) {
          console.error(
            "Failed to load review notes for your submissions:",
            eventsError
          );
          setLoading(false);
          return;
        }

        const notesMap: LastNoteByPage = {};

        for (const ev of (eventsData || []) as ReviewEvent[]) {
          if (!ev.notes || !ev.notes.trim()) continue;

          const existing = notesMap[ev.info_page_id];
          if (!existing) {
            notesMap[ev.info_page_id] = {
              created_at: ev.created_at,
              notes: ev.notes,
            };
          } else {
            const existingTime = new Date(existing.created_at).getTime();
            const thisTime = new Date(ev.created_at).getTime();
            if (thisTime >= existingTime) {
              notesMap[ev.info_page_id] = {
                created_at: ev.created_at,
                notes: ev.notes,
              };
            }
          }
        }

        setLastNotes(notesMap);
        setLoading(false);
      } catch (err) {
        console.error("Unexpected error loading your submissions:", err);
        setError("Unexpected error loading your submissions.");
        setLoading(false);
      }
    };

    void load();
  }, [supabase]);

  if (loading) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-8 text-brand-text">
        <p>Loading your submissions...</p>
      </div>
    );
  }

  if (!userId) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-8 text-brand-text">
        <h1 className="mb-2 text-xl font-semibold">
          My Info Submissions
        </h1>
        <p className="text-sm text-brand-textMuted">
          {error ||
            "You must be logged in to view your info page submissions."}
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 text-brand-text">
      <h1 className="mb-2 text-2xl font-semibold">
        My Info Submissions
      </h1>
      <p className="mb-4 text-sm text-brand-textMuted">
        These are info pages that you have submitted for review.
      </p>
      <div className="mt-2 mb-5 text-[11px] text-brand-textMuted">
          <Link
            href="/info"
            className="text-amber-300 hover:text-amber-200 underline underline-offset-2"
          >
            ← Back to all info
          </Link>
      </div>

      {error && (
        <p className="mb-4 text-sm text-red-400">{error}</p>
      )}

      {pages.length === 0 ? (
        <p className="text-sm text-brand-textMuted">
          You haven&apos;t submitted any info pages yet.
        </p>
      ) : (
        <div className="space-y-4">
          {pages.map((page) => {
            const status = page.status;
            const statusLabel =
              status.charAt(0).toUpperCase() +
              status.slice(1).toLowerCase();

            let statusClasses =
              "border-zinc-700 bg-black/40 text-brand-text";
            if (status === "pending") {
              statusClasses =
                "border-yellow-500/40 bg-yellow-500/10 text-yellow-100";
            } else if (status === "approved") {
              statusClasses =
                "border-emerald-500/40 bg-emerald-500/10 text-emerald-100";
            } else if (status === "rejected") {
              statusClasses =
                "border-red-500/40 bg-red-500/10 text-red-100";
            }

            const lastNote = lastNotes[page.id];

            const snippet =
              page.content_markdown.length > 220
                ? page.content_markdown.slice(0, 220) + "…"
                : page.content_markdown;

            return (
              <div
                key={page.id}
                className="rounded-lg border border-zinc-700 bg-gradient-to-br from-brand-bgStart/80 to-brand-bgEnd/80 p-4"
              >
                <div className="mb-2 flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h2 className="text-lg font-semibold">
                      {page.title}
                    </h2>
                    <p className="mt-0.5 text-[11px] text-brand-textMuted">
                      Slug: {page.slug}
                    </p>
                    <p className="mt-0.5 text-[11px] text-brand-textMuted">
                      Created:{" "}
                      {new Date(
                        page.created_at
                      ).toLocaleString()}
                    </p>
                  </div>
                  <div className="flex flex-col items-end gap-1">
                    <span
                      className={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${statusClasses}`}
                    >
                      {statusLabel}
                    </span>
                    {status === "rejected" && (
                      <Link
                        href={`/info/submit?edit=${page.id}`}
                        className="text-[11px] text-amber-300 hover:text-amber-200 underline underline-offset-2"
                      >
                        Edit &amp; resubmit →
                      </Link>
                    )}
                    {status === "approved" && (
                      <a
                        href={`/info/${page.slug}`}
                        className="text-[11px] text-brand-primary hover:text-brand-accent"
                      >
                        View live page →
                      </a>
                    )}
                  </div>
                </div>

                <p className="mb-3 text-xs text-brand-textMuted">
                  {snippet}
                </p>

                {lastNote && (
                  <div className="mt-1 rounded-md border border-zinc-700 bg-black/40 p-2 text-[11px]">
                    <p className="mb-1 text-[10px] font-semibold text-brand-textMuted">
                      Last admin note (
                      {new Date(
                        lastNote.created_at
                      ).toLocaleString()}
                      ):
                    </p>
                    <div className="[&_a]:text-brand-primary [&_a]:underline">
                      <MarkdownContent
                        markdown={lastNote.notes}
                        makeUserHref={(u) => `/user/@${u}`}
                      />
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
