"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { VerifiedBadge } from "@/components/VerifiedBadge";
import { DonationBadge } from "@/components/DonationBadge";
import { RolePill } from "@/components/RolePill";
import { supabaseBrowser } from "@/lib/supabaseClient";
import { InfoCard, InfoCardItem } from "@/components/info/InfoCard";
import { MarkdownContent } from "@/components/MarkdownContent";

type InfoPage = {
  id: string;
  title: string;
  slug: string;
  content_markdown: string;
  created_at: string;
  updated_at?: string | null;
  status: string;
  created_by?: string | null;
  tags?: string[] | null;
  category?: string | null;
  chassis?: string | null;
};

type Heading = {
  id: string;
  text: string;
  level: number;
};

type InfoRelatedItem = InfoCardItem;

type AuthorProfile = {
  id: string;
  username: string | null;
  display_name: string | null;
  avatar_url: string | null;
  is_verified?: boolean | null;
  donation_rank?: string | null;
};

type ContributorProfile = {
  id: string;
  username: string | null;
  display_name: string | null;
  avatar_url: string | null;
  role?: string | null;
  is_verified?: boolean | null;
  donation_rank?: string | null;
};

function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
}

function dedupeById<T extends { id: string }>(items: T[]): T[] {
  const map = new Map<string, T>();
  for (const item of items) {
    if (!map.has(item.id)) map.set(item.id, item);
  }
  return Array.from(map.values());
}

function prettyCategoryLabel(input: string): string {
  // turns "engine-drivetrain" -> "Engine Drivetrain"
  return input
    .trim()
    .replace(/[-_]+/g, " ")
    .split(" ")
    .filter(Boolean)
    .map((w) => w[0]?.toUpperCase() + w.slice(1))
    .join(" ");
}

// ---------- role helpers (match forum look) ----------
function formatRoleLabel(role: string): string {
  const r = (role || "member").toLowerCase();
  if (r === "admin") return "Admin";
  if (r === "moderator" || r === "mod") return "Moderator";
  if (r === "support") return "Support";
  return "Member";
}

function rolePillClass(role: string): string {
  const r = (role || "member").toLowerCase();
  if (r === "admin") return "border-red-500/40 bg-red-500/10 text-red-200";
  if (r === "moderator" || r === "mod")
    return "border-emerald-500/40 bg-emerald-500/10 text-emerald-200";
  if (r === "support") return "border-sky-500/40 bg-sky-500/10 text-sky-200";
  return "border-zinc-700 bg-zinc-900/40 text-zinc-200";
}

export default function InfoSlugPage() {
  const params = useParams() as { slug: string };
  const slug = params.slug;

  const supabase = supabaseBrowser();

  const [page, setPage] = useState<InfoPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [authorProfile, setAuthorProfile] = useState<AuthorProfile | null>(null);
  const [authorRole, setAuthorRole] = useState<string>("member");

  const [contributors, setContributors] = useState<ContributorProfile[]>([]);
  const [viewerLoggedIn, setViewerLoggedIn] = useState(false);
  const [viewerVerified, setViewerVerified] = useState(false);

  const [relatedByTags, setRelatedByTags] = useState<InfoRelatedItem[]>([]);
  const [moreInCategory, setMoreInCategory] = useState<InfoRelatedItem[]>([]);
  const [moreForChassis, setMoreForChassis] = useState<InfoRelatedItem[]>([]);
  const [relatedLoading, setRelatedLoading] = useState(false);
  const [relatedError, setRelatedError] = useState<string | null>(null);

  useEffect(() => {
    const load = async () => {
      if (!slug) {
        setNotFound(true);
        setLoading(false);
        return;
      }

      setLoading(true);
      setError(null);
      setNotFound(false);

      try {
        const { data: sess } = await supabase.auth.getSession();
        const hasSession = !!sess.session;
        setViewerLoggedIn(hasSession);
        setViewerVerified(false);

        if (hasSession) {
          const viewerId = sess.session?.user?.id;
          if (viewerId) {
            const { data: viewerProfile } = await supabase
              .from("profiles")
              .select("is_verified")
              .eq("id", viewerId)
              .maybeSingle<{ is_verified?: boolean | null }>();
            setViewerVerified(!!viewerProfile?.is_verified);
          }
        }

        const { data, error: pageError } = await supabase
          .from("info_pages")
          .select(
            "id, title, slug, content_markdown, created_at, updated_at, status, created_by, tags, category, chassis"
          )
          .eq("slug", slug)
          .maybeSingle<InfoPage>();

        if (pageError) {
          console.error("Error loading info page", pageError);
          setError("Failed to load this page.");
          setLoading(false);
          return;
        }

        if (!data || data.status !== "approved") {
          setNotFound(true);
          setLoading(false);
          return;
        }

        setPage(data);

        // Load contributors (excluding original author)
        setContributors([]);
        if (data.id) {
          const { data: contribRows } = await supabase
            .from("info_page_contributors")
            .select("user_id")
            .eq("info_page_id", data.id);

          const ids = (contribRows ?? [])
            .map((r) => (r as { user_id: string }).user_id)
            .filter((id) => id && id !== data.created_by);

          if (ids.length > 0) {
            const { data: profiles } = await supabase
              .from("profiles")
              .select("id, username, display_name, avatar_url, is_verified, donation_rank")
              .in("id", ids);

            const { data: roleRows } = await supabase
              .from("user_roles")
              .select("user_id, role")
              .in("user_id", ids);

            const roleById: Record<string, string | null> = {};
            (roleRows ?? []).forEach((r) => {
              const row = r as { user_id: string; role: string | null };
              roleById[row.user_id] = row.role ?? null;
            });

            const merged = ((profiles ?? []) as ContributorProfile[]).map((p) => ({
              ...p,
              role: roleById[p.id] ?? null,
            }));

            setContributors(merged);
          }
        }

        // Load author profile + role for sidebar card
        if (data.created_by) {
          const authorId = data.created_by;

          const { data: profile, error: profileError } = await supabase
            .from("profiles")
            .select("id, username, display_name, avatar_url, is_verified, donation_rank")
            .eq("id", authorId)
            .maybeSingle<AuthorProfile>();

          if (profileError) {
            console.error("Error loading author profile", profileError);
            setAuthorProfile(null);
          } else {
            setAuthorProfile(profile ?? null);
          }

          const { data: roleRow, error: roleErr } = await supabase
            .from("user_roles")
            .select("role")
            .eq("user_id", authorId)
            .maybeSingle<{ role: string }>();

          if (roleErr) {
            setAuthorRole("member");
          } else {
            setAuthorRole(roleRow?.role ?? "member");
          }
        } else {
          setAuthorProfile(null);
          setAuthorRole("member");
        }

        setLoading(false);
      } catch (err) {
        console.error("Unexpected error loading info page", err);
        setError("Unexpected error loading this page.");
        setLoading(false);
      }
    };

    void load();
  }, [slug, supabase]);

  // Load related guides once we know the current page
  useEffect(() => {
    const loadRelated = async () => {
      if (!page) return;

      setRelatedLoading(true);
      setRelatedError(null);
      setRelatedByTags([]);
      setMoreInCategory([]);
      setMoreForChassis([]);

      try {
        const { data, error } = await supabase
          .from("info_pages")
          .select(
            "id, title, slug, created_at, updated_at, status, tags, category, chassis"
          )
          .eq("status", "approved")
          .neq("id", page.id)
          .order("updated_at", { ascending: false })
          .limit(32);

        if (error) {
          console.error("Error loading related pages", error);
          setRelatedError("Failed to load related guides.");
          setRelatedLoading(false);
          return;
        }

        const baseTags = (page.tags ?? []).map((t) => t.toLowerCase());
        const baseTagSet = new Set(baseTags);
        const baseCategory = (page.category ?? "").trim().toLowerCase();
        const baseChassis = (page.chassis ?? "").trim().toLowerCase();

        const tagMatches: InfoRelatedItem[] = [];
        const categoryMatches: InfoRelatedItem[] = [];
        const chassisMatches: InfoRelatedItem[] = [];

        for (const raw of data ?? []) {
          const row = raw as InfoRelatedItem;

          const rowTags = (row.tags ?? []).map((t) => t.toLowerCase());
          const rowCategory = (row.category ?? "").trim().toLowerCase();
          const rowChassis = (row.chassis ?? "").trim().toLowerCase();

          const sharesTag =
            baseTagSet.size > 0 && rowTags.some((t) => baseTagSet.has(t));

          const sameCategory =
            baseCategory.length > 0 &&
            rowCategory.length > 0 &&
            rowCategory === baseCategory;

          const sameChassis =
            baseChassis.length > 0 &&
            rowChassis.length > 0 &&
            rowChassis === baseChassis;

          if (sharesTag) tagMatches.push(row);
          if (sameCategory) categoryMatches.push(row);
          if (sameChassis) chassisMatches.push(row);
        }

        const sortByUpdatedDesc = (arr: InfoRelatedItem[]) =>
          arr.sort((a, b) => {
            const aDate = new Date(a.updated_at || a.created_at).getTime();
            const bDate = new Date(b.updated_at || b.created_at).getTime();
            return bDate - aDate;
          });

        const byTags = sortByUpdatedDesc(dedupeById(tagMatches)).slice(0, 4);
        const inCategory = sortByUpdatedDesc(dedupeById(categoryMatches)).slice(
          0,
          2
        );
        const forChassis = sortByUpdatedDesc(dedupeById(chassisMatches)).slice(
          0,
          2
        );

        setRelatedByTags(byTags);
        setMoreInCategory(inCategory);
        setMoreForChassis(forChassis);
        setRelatedLoading(false);
      } catch (err) {
        console.error("Unexpected error loading related pages", err);
        setRelatedError("Unexpected error while loading related guides.");
        setRelatedLoading(false);
      }
    };

    void loadRelated();
  }, [page, supabase]);

  const contentMarkdown = page?.content_markdown ?? "";

  const headings: Heading[] = useMemo(() => {
    if (!contentMarkdown) return [];

    const lines = contentMarkdown.split("\n");
    const result: Heading[] = [];

    for (const line of lines) {
      const match = /^(#{1,6})\s+(.*)$/.exec(line.trim());
      if (!match) continue;

      const level = match[1].length;
      const text = match[2].trim();
      if (!text) continue;

      const id = slugify(text);
      result.push({ id, text, level });
    }

    return result;
  }, [contentMarkdown]);

  if (loading) {
    return (
      <div className="mx-auto max-w-4xl px-4 py-8 text-brand-text">
        <p>Loading page...</p>
      </div>
    );
  }

  if (notFound) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-16 text-brand-text">
        <h1 className="mb-2 text-2xl font-semibold">Page not found</h1>
        <p className="text-sm text-brand-textMuted">
          This info page doesn&apos;t exist or hasn&apos;t been approved yet.
        </p>
      </div>
    );
  }

  if (error || !page) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-16 text-brand-text">
        <h1 className="mb-2 text-2xl font-semibold">Something went wrong</h1>
        <p className="text-sm text-brand-textMuted">
          {error || "Unable to load this page right now."}
        </p>
      </div>
    );
  }

  const lastUpdated = page.updated_at || page.created_at;
  const tags = page.tags ?? [];

  const categorySlug = (page.category ?? "").trim();
  const categoryLabel = categorySlug ? prettyCategoryLabel(categorySlug) : null;

  const hasAnyRelated =
    relatedByTags.length > 0 ||
    moreInCategory.length > 0 ||
    moreForChassis.length > 0;

  const authorHref =
    authorProfile?.username
      ? `/user/@${authorProfile.username}`
      : authorProfile?.id
      ? `/user/${authorProfile.id}`
      : null;

  const authorDisplayName =
    authorProfile?.display_name ||
    authorProfile?.username ||
    (page.created_by ?? "Unknown");

  const authorUsername =
    authorProfile?.username ? `@${authorProfile.username}` : null;

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-8 text-brand-text md:flex-row">
      {/* Main content */}
      <article className="w-full md:w-3/4">
        <header className="mb-4 flex flex-col gap-3 border-b border-zinc-800/80 pb-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <p className="mb-1 text-[11px] uppercase tracking-wide text-brand-textMuted">
              Info Page
            </p>

            {/* Breadcrumbs (Info › Category › Page) */}
            <div className="mb-3 flex flex-wrap items-center gap-2 text-[11px] text-brand-textMuted">
              <Link
                href="/info"
                className="text-amber-300 underline underline-offset-2 hover:text-amber-200"
              >
                Info
              </Link>

              {categorySlug ? (
                <>
                  <span>›</span>
                  <Link
                    href={`/info/category/${encodeURIComponent(categorySlug)}`}
                    className="text-amber-300 underline underline-offset-2 hover:text-amber-200"
                  >
                    {categoryLabel ?? "Category"}
                  </Link>
                </>
              ) : null}

              <span>›</span>
              <span className="text-brand-text">{page.title}</span>
            </div>

            <h1 className="mb-2 text-3xl font-semibold tracking-tight">
              {page.title}
            </h1>

            <div className="flex flex-wrap items-center gap-3 text-[11px] text-brand-textMuted">
              <span>Last updated: {new Date(lastUpdated).toLocaleString()}</span>
            </div>

            {/* Tag chips */}
            {tags.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-1">
                {tags.map((tag) => (
                  <Link
                    key={tag}
                    href={`/info?q=${encodeURIComponent(tag)}`}
                    className="rounded-full border border-zinc-700 bg-black/40 px-2 py-0.5 text-[11px] text-brand-textMuted hover:border-brand-primary/70 hover:text-brand-text"
                  >
                    {tag}
                  </Link>
                ))}
              </div>
            )}
          </div>

          {/* DOWNLOAD PDF BUTTON */}
          <a
            href={`/api/info/pdf/${encodeURIComponent(page.slug)}`}
            className="inline-flex shrink-0 items-center justify-center rounded-full border border-zinc-700 bg-black/40 px-3 py-1.5 text-[11px] font-medium text-brand-text transition hover:bg-zinc-900"
          >
            Download PDF
          </a>
        </header>

        <section className="prose prose-invert max-w-none text-sm [&_a]:text-brand-primary [&_a]:underline">
          <MarkdownContent
            markdown={page.content_markdown}
            makeUserHref={(u) => `/user/@${u}`}
            getHeadingId={(text: string) => slugify(text)}
          />
        </section>

        {/* Related guides */}
        <section className="mt-8 border-t border-zinc-800/80 pt-4">
          <div className="mb-3 flex items-center justify-between gap-2">
            <h2 className="text-sm font-semibold tracking-tight text-brand-text">
              Related guides
            </h2>
          </div>

          {relatedLoading && (
            <p className="text-[12px] text-brand-textMuted">
              Finding related guides…
            </p>
          )}

          {relatedError && (
            <p className="text-[12px] text-rose-300/80">{relatedError}</p>
          )}

          {!relatedLoading && !relatedError && !hasAnyRelated && (
            <p className="text-[12px] text-brand-textMuted">
              No related guides yet. As the archive grows, more related content
              will show up here.
            </p>
          )}

          {!relatedLoading && !relatedError && hasAnyRelated && (
            <div className="space-y-5">
              {relatedByTags.length > 0 && (
                <div>
                  <h3 className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-brand-textMuted">
                    Related by tags
                  </h3>
                  <div className="grid gap-3 md:grid-cols-2">
                    {relatedByTags.map((item) => (
                      <InfoCard
                        key={item.id}
                        item={item}
                        showCategory={true}
                        showTags={true}
                        maxTags={3}
                      />
                    ))}
                  </div>
                </div>
              )}

              {moreInCategory.length > 0 && (
                <div>
                  <h3 className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-brand-textMuted">
                    More from this category
                  </h3>
                  <div className="grid gap-3 md:grid-cols-2">
                    {moreInCategory.map((item) => (
                      <InfoCard
                        key={item.id}
                        item={item}
                        showCategory={false}
                        showTags={false}
                      />
                    ))}
                  </div>
                </div>
              )}

              {moreForChassis.length > 0 && (
                <div>
                  <h3 className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-brand-textMuted">
                    More for this chassis
                  </h3>
                  <div className="grid gap-3 md:grid-cols-2">
                    {moreForChassis.map((item) => (
                      <InfoCard
                        key={item.id}
                        item={item}
                        showCategory={true}
                        showTags={false}
                      />
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </section>
      </article>

      {/* Sidebar ToC */}
      <aside className="md:w-1/4 md:pl-4">
        <div className="sticky top-20 space-y-3">
          {/* Author card (forum-style, no karma) */}
          {authorHref && (
            <Link
              href={authorHref}
              className="block rounded-lg border border-zinc-800/80 bg-black/40 p-3 hover:border-zinc-700"
            >
              <div className="flex items-start gap-3">
                <div className="h-12 w-12 shrink-0 overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900/40">
                  {authorProfile?.avatar_url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={authorProfile.avatar_url}
                      alt={authorDisplayName}
                      className="h-full w-full object-cover"
                    />
                  ) : (
                    <div className="flex h-full w-full items-center justify-center text-zinc-400">
                      <span className="text-lg">
                        {(authorDisplayName[0] || "?").toUpperCase()}
                      </span>
                    </div>
                  )}
                </div>

                <div className="min-w-0">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-1 truncate text-[13px] font-semibold text-zinc-100">
                      <span className="truncate">{authorDisplayName}</span>
                      {authorProfile?.is_verified ? (
                        <VerifiedBadge className="h-3 w-3" />
                      ) : null}
                      {authorProfile?.donation_rank ? (
                        <DonationBadge rank={authorProfile.donation_rank} className="h-3 w-3" />
                      ) : null}
                    </div>
                    <RolePill role={authorRole} />
                  </div>
                  {authorUsername && (
                    <div className="truncate text-[11px] text-brand-textMuted">
                      {authorUsername}
                    </div>
                  )}
                </div>
              </div>
            </Link>
          )}

          {/* Contributors */}
          {contributors.length > 0 && (
            <div className="rounded-lg border border-zinc-800/80 bg-black/40 p-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-brand-textMuted">
                Contributors
              </p>
              <div className="mt-2 space-y-2">
                {contributors.slice(0, 8).map((c) => {
                  const name = (c.display_name ?? c.username ?? "Member").trim();
                  const username = c.username ? `@${c.username}` : null;
                  return (
                    <Link
                      key={c.id}
                      href={`/user/${c.id}`}
                      className="flex items-center gap-2 rounded-md border border-zinc-800/80 bg-black/30 px-2 py-1.5 hover:border-zinc-700"
                    >
                      <div className="h-7 w-7 shrink-0 overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900/40">
                        {c.avatar_url ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={c.avatar_url}
                            alt={name}
                            className="h-full w-full object-cover"
                          />
                        ) : (
                          <div className="flex h-full w-full items-center justify-center text-[11px] text-zinc-400">
                            {(name[0] || "?").toUpperCase()}
                          </div>
                        )}
                      </div>
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <div className="inline-flex items-center gap-1 truncate text-[12px] text-brand-text">
                            <span className="truncate">{name}</span>
                            {c.is_verified ? <VerifiedBadge className="h-3 w-3" /> : null}
                            {c.donation_rank ? (
                              <DonationBadge rank={c.donation_rank} className="h-3 w-3" />
                            ) : null}
                          </div>
                          <RolePill role={c.role} />
                        </div>
                        {username && (
                          <div className="truncate text-[10px] text-brand-textMuted">
                            {username}
                          </div>
                        )}
                      </div>
                    </Link>
                  );
                })}
                {contributors.length > 8 && (
                  <p className="text-[11px] text-brand-textMuted">+{contributors.length - 8} more</p>
                )}
              </div>
            </div>
          )}

          <div className="rounded-lg border border-zinc-800/80 bg-black/40 p-3 text-[12px]">
            <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-brand-textMuted">
              Table of contents
            </h2>

            {headings.length === 0 ? (
              <p className="text-[11px] text-brand-textMuted">
                This page has no headings yet.
              </p>
            ) : (
              <ul className="space-y-1 text-[12px]">
                {headings.map((h) => (
                  <li
                    key={h.id}
                    className={
                      (h.level === 1
                        ? "font-semibold"
                        : h.level === 2
                        ? "pl-2"
                        : "pl-4") + " leading-snug"
                    }
                  >
                    <a
                      href={`#${h.id}`}
                      className="text-brand-textMuted hover:text-brand-primary"
                    >
                      {h.text}
                    </a>
                  </li>
                ))}
              </ul>
            )}

            {/* Suggest update */}
            {viewerVerified && page && (
            <div className="mt-4 border-t border-zinc-800/80 pt-3 text-[11px] text-brand-textMuted">
              <p>
                Found an issue?{" "}
                <Link
                  href={`/info/${encodeURIComponent(page.slug)}/update`}
                  className="text-amber-300 underline underline-offset-2 hover:text-amber-200"
                >
                  Submit an update
                </Link>
                .
              </p>
            </div>
            )}
          </div>
        </div>
      </aside>
    </div>
  );
}
