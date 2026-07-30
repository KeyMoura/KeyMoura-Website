"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { MenuSelect } from "@/components/ui/MenuSelect";
import { supabaseBrowser } from "@/lib/supabaseClient";
import { useMeAccess } from "@/lib/hooks/useMeAccess";
import { MarkdownContent } from "@/components/MarkdownContent";
import { MarkdownEditor } from "@/components/MarkdownEditor";
import { VerifiedBadge } from "@/components/VerifiedBadge";
import { DonationBadge } from "@/components/DonationBadge";
import { RolePill } from "@/components/RolePill";

type UpdateRow = {
  id: string;
  info_page_id: string;
  created_by: string;
  status: string;
  created_at: string;
  original_title: string | null;
  original_content_markdown: string | null;
  original_tags: string[] | null;
  original_category: string | null;
  original_chassis: string | null;
  proposed_title: string | null;
  proposed_content_markdown: string;
  proposed_tags: string[] | null;
  proposed_category: string | null;
  proposed_chassis: string | null;
};

type InfoPage = {
  id: string;
  title: string;
  slug: string;
  content_markdown: string;
  tags: string[] | null;
  category: string | null;
  chassis: string | null;
  created_by: string | null;
};

type ProfileLite = { id: string; username: string | null; display_name: string | null };

type SubmitterProfile = {
  id: string;
  username: string | null;
  display_name: string | null;
  avatar_url: string | null;
  is_verified?: boolean | null;
  donation_rank?: string | null;
};

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
  is_verified?: boolean | null;
  donation_rank?: string | null;
  role?: string | null;
};

type ReviewEvent = {
  id: string;
  action: string;
  performed_by: string | null;
  created_at: string;
  notes: string | null;
};

type Heading = { id: string; text: string; level: number };

const CATEGORY_OPTIONS = [
  { value: "oem-manuals", label: "OEM Literature" },
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

function parseTags(input: string): string[] {
  return input
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
}

function formatRoleLabel(role: string | null | undefined): string {
  const r = (role ?? "member").toLowerCase();
  if (r === "admin") return "Admin";
  if (r === "support") return "Support";
  if (r === "staff") return "Staff";
  return "Member";
}

function rolePillClass(role: string | null | undefined): string {
  const r = (role ?? "member").toLowerCase();
  if (r === "admin") return "border-rose-400/40 bg-rose-500/10 text-rose-200";
  if (r === "support") return "border-sky-400/40 bg-sky-500/10 text-sky-200";
  if (r === "staff") return "border-amber-400/40 bg-amber-500/10 text-amber-200";
  return "border-zinc-700 bg-black/40 text-brand-textMuted";
}

function formatRank(role: string | null | undefined): string {
  const lower = (role ?? "member").toLowerCase();
  if (lower === "admin") return "Admin";
  if (lower === "moderator" || lower === "mod") return "Moderator";
  if (lower === "support") return "Support";
  return "Member";
}

function rankChipClasses(role: string | null | undefined): string {
  const lower = (role ?? "member").toLowerCase();
  if (lower === "admin") return "border-rose-500 bg-rose-500/20 text-rose-300";
  if (lower === "moderator" || lower === "mod") return "border-emerald-500 bg-emerald-500/20 text-emerald-200";
  if (lower === "support") return "border-sky-400 bg-sky-500/20 text-sky-300";
  return "border-zinc-600 bg-black/40 text-brand-textMuted";
}

function formatReviewAction(action: string): string {
  const a = (action ?? "").toLowerCase();
  if (a === "admin_note") return "Note";
  if (a === "admin_forwarded_for_review") return "Forwarded";
  if (a === "admin_edited") return "Edited";
  if (a === "admin_update_approved") return "Approved update";
  if (a === "admin_update_rejected") return "Rejected update";
  if (a === "admin_approved") return "Approved";
  if (a === "admin_denied" || a === "admin_rejected") return "Rejected";
  return action;
}

export default function AdminInfoUpdateDetailPage() {
  const params = useParams() as { id: string };
  const id = params.id;
  const router = useRouter();
  const supabase = useMemo(() => supabaseBrowser(), []);

  const { data: access, isLoading: accessLoading } = useMeAccess();
  // Page access is .view-only; moderation perms don't imply visibility.
  const canView = Boolean(access?.permissions?.includes("info.updates.view"));
  const canModerate = Boolean(access?.permissions?.includes("info.moderate"));

  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [update, setUpdate] = useState<UpdateRow | null>(null);
  const [page, setPage] = useState<InfoPage | null>(null);
  const [submitter, setSubmitter] = useState<SubmitterProfile | null>(null);
  const [submitterRole, setSubmitterRole] = useState<string | null>(null);

  const [authorProfile, setAuthorProfile] = useState<AuthorProfile | null>(null);
  const [authorRole, setAuthorRole] = useState<string | null>(null);
  const [contributors, setContributors] = useState<ContributorProfile[]>([]);

  const [reviewEvents, setReviewEvents] = useState<ReviewEvent[]>([]);
  const [reviewNamesById, setReviewNamesById] = useState<Record<string, ProfileLite>>({});

  const [notes, setNotes] = useState("");
  const [acting, setActing] = useState<
    "idle" | "approving" | "rejecting" | "noting" | "forwarding" | "saving_edits"
  >("idle");

  // lightweight admin edit (tweaks the proposed update before approval)
  const [editOpen, setEditOpen] = useState(false);
  const [editTitle, setEditTitle] = useState<string>("");
  const [editContent, setEditContent] = useState<string>("");
  const [editTags, setEditTags] = useState<string>("");
  const [editCategory, setEditCategory] = useState<string>("maintenance-general");
  const [editChassis, setEditChassis] = useState<string>("general");

  // IMPORTANT: keep all hooks above any conditional `return` blocks.
  const who = useMemo(() => {
    if (!update) return "";
    return (submitter?.display_name ?? submitter?.username ?? update.created_by).toString();
  }, [submitter, update]);

  const currentHeadings: Heading[] = useMemo(() => {
    const md = page?.content_markdown ?? "";
    if (!md) return [];
    return md
      .split("\n")
      .map((l) => l.trim())
      .map((l) => {
        const m = /^(#{1,6})\s+(.*)$/.exec(l);
        if (!m) return null;
        const level = m[1].length;
        const text = m[2].trim();
        if (!text) return null;
        return { id: slugify(text), text, level };
      })
      .filter((x): x is Heading => Boolean(x));
  }, [page?.content_markdown]);

  const proposedHeadings: Heading[] = useMemo(() => {
    const md = update?.proposed_content_markdown ?? "";
    if (!md) return [];
    return md
      .split("\n")
      .map((l) => l.trim())
      .map((l) => {
        const m = /^(#{1,6})\s+(.*)$/.exec(l);
        if (!m) return null;
        const level = m[1].length;
        const text = m[2].trim();
        if (!text) return null;
        return { id: slugify(text), text, level };
      })
      .filter((x): x is Heading => Boolean(x));
  }, [update?.proposed_content_markdown]);

  // For the "Proposed" preview, treat the person who submitted the update as a contributor
  // (unless they're already the author or already listed).
  const proposedContributors = useMemo(() => {
    const base = [...contributors];
    const submitterId = submitter?.id ?? null;
    const authorId = authorProfile?.id ?? null;
    if (!submitterId) return base;
    if (authorId && submitterId === authorId) return base;
    if (base.some((c) => c.id === submitterId)) return base;

    base.unshift({
      id: submitterId,
      username: submitter?.username ?? null,
      display_name: submitter?.display_name ?? null,
      avatar_url: (submitter as SubmitterProfile | null)?.avatar_url ?? null,
      is_verified: (submitter as SubmitterProfile | null)?.is_verified ?? null,
      role: submitterRole ?? null,
    });
    return base;
  }, [contributors, submitter, submitterRole, authorProfile?.id]);

  const noteEvents = useMemo(() => {
    return reviewEvents.filter(
      (e) => e.action === "admin_note" && (e.notes ?? "").trim().length > 0
    );
  }, [reviewEvents]);

  const nonNoteReviewEvents = useMemo(() => {
    return reviewEvents.filter((e) => e.action !== "admin_note");
  }, [reviewEvents]);

  const noteCount = noteEvents.length;

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      setError(null);
      setForbidden(false);

      const { data: sess } = await supabase.auth.getSession();
      if (!sess.session) {
        setForbidden(true);
        setLoading(false);
        return;
      }

      if (accessLoading) {
        setLoading(true);
        return;
      }

      if (!canView) {
        setForbidden(true);
        setLoading(false);
        return;
      }

      const { data: upd, error: updErr } = await supabase
        .from("info_page_updates")
        .select(
          "id,info_page_id,created_by,status,created_at,original_title,original_content_markdown,original_tags,original_category,original_chassis,proposed_title,proposed_content_markdown,proposed_tags,proposed_category,proposed_chassis"
        )
        .eq("id", id)
        .maybeSingle<UpdateRow>();

      if (updErr || !upd) {
        setError("Update not found.");
        setLoading(false);
        return;
      }

      setUpdate(upd);

      // Prime edit controls from the current proposal
      setEditTitle(upd.proposed_title ?? "");
      setEditContent(upd.proposed_content_markdown ?? "");
      setEditTags((upd.proposed_tags ?? []).join(", "));
      setEditCategory(upd.proposed_category ?? "maintenance-general");
      setEditChassis(upd.proposed_chassis ?? "general");

      const { data: pg, error: pgErr } = await supabase
        .from("info_pages")
        .select("id,title,slug,content_markdown,tags,category,chassis,created_by")
        .eq("id", upd.info_page_id)
        .maybeSingle<InfoPage>();

      if (pgErr || !pg) {
        setError("Target page not found.");
        setLoading(false);
        return;
      }

      setPage(pg);

      // Load submitter (who proposed the update)
      const [submitterProfRes, submitterRoleRes] = await Promise.all([
        supabase
          .from("profiles")
          .select("id,username,display_name,avatar_url,is_verified,donation_rank")
          .eq("id", upd.created_by)
          .maybeSingle<SubmitterProfile>(),
        supabase
          .from("user_roles")
          .select("role")
          .eq("user_id", upd.created_by)
          .maybeSingle<{ role: string | null }>(),
      ]);

      setSubmitter(submitterProfRes.data ?? null);
      setSubmitterRole(submitterRoleRes.data?.role ?? null);

      // Load author profile + role (for preview sidebar)
      setAuthorProfile(null);
      setAuthorRole(null);
      if (pg.created_by) {
        const [profileRes, roleRes] = await Promise.all([
          supabase
            .from("profiles")
            .select("id,username,display_name,avatar_url,is_verified,donation_rank")
            .eq("id", pg.created_by)
            .maybeSingle<AuthorProfile>(),
          supabase
            .from("user_roles")
            .select("role")
            .eq("user_id", pg.created_by)
            .maybeSingle<{ role: string | null }>(),
        ]);

        setAuthorProfile(profileRes.data ?? null);
        setAuthorRole(roleRes.data?.role ?? null);
      }

      // Load contributors (excluding original author)
      setContributors([]);
      try {
        const { data: contribRows } = await supabase
          .from("info_page_contributors")
          .select("user_id")
          .eq("info_page_id", pg.id);

        const ids = (contribRows ?? [])
          .map((r) => (r as { user_id: string }).user_id)
          .filter((uid) => uid && uid !== pg.created_by);

        if (ids.length > 0) {
          const [{ data: profs }, { data: roles }] = await Promise.all([
            supabase
              .from("profiles")
              .select("id,username,display_name,avatar_url,is_verified,donation_rank")
              .in("id", ids),
            supabase
              .from("user_roles")
              .select("user_id,role")
              .in("user_id", ids),
          ]);

          const roleById: Record<string, string | null> = {};
          (roles ?? []).forEach((r) => {
            const row = r as { user_id: string; role: string | null };
            roleById[row.user_id] = row.role ?? null;
          });

          const merged = ((profs ?? []) as ContributorProfile[]).map((p) => ({
            ...p,
            role: roleById[p.id] ?? null,
          }));

          setContributors(merged);
        }
      } catch (e) {
        console.error("Failed to load contributors", e);
        setContributors([]);
      }

      // Load review history (notes + actions)
      const { data: evs } = await supabase
        .from("info_page_review_events")
        .select("id,action,performed_by,created_at,notes")
        .eq("info_page_id", pg.id)
        .order("created_at", { ascending: false })
        .limit(50);

      const events = (Array.isArray(evs) ? (evs as ReviewEvent[]) : []) ?? [];
      setReviewEvents(events);

      const actorIds = Array.from(
        new Set(
          events
            .map((e) => e.performed_by)
            .filter((x): x is string => typeof x === "string" && x.length > 0)
        )
      );

      if (actorIds.length > 0) {
        const { data: actorProfiles } = await supabase
          .from("profiles")
          .select("id,username,display_name")
          .in("id", actorIds);

        const map: Record<string, ProfileLite> = {};
        (actorProfiles ?? []).forEach((p) => {
          const row = p as ProfileLite;
          map[row.id] = row;
        });
        setReviewNamesById(map);
      } else {
        setReviewNamesById({});
      }

      setLoading(false);
    };

    void load();
  }, [id, supabase]);

  async function act(
    kind: "approve" | "reject" | "note" | "forward" | "edit",
    payload?: {
      proposedTitle?: string | null;
      proposedContentMarkdown?: string | null;
      proposedTags?: string[] | null;
      proposedCategory?: string | null;
      proposedChassis?: string | null;
    }
  ) {
    if (!update || !page) return;

    const { data: sess } = await supabase.auth.getSession();
    if (!sess.session) return;

    setActing(
      kind === "approve"
        ? "approving"
        : kind === "reject"
          ? "rejecting"
          : kind === "note"
            ? "noting"
            : kind === "forward"
              ? "forwarding"
              : "saving_edits"
    );
    setError(null);

    try {
      const res = await fetch("/api/admin/info/updates/action", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${sess.session.access_token}`,
        },
        body: JSON.stringify({
          updateId: update.id,
          action: kind,
          notes: notes.trim() || null,
          ...(payload ?? {}),
        }),
      });

      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) {
        setError(data?.error ?? "Action failed.");
        setActing("idle");
        return;
      }

      // If we only edited or added a note, keep the reviewer on the page.
      if (kind === "edit" || kind === "note" || kind === "forward") {
        // reload row so the proposed diff reflects the latest state
        const { data: refreshed } = await supabase
          .from("info_page_updates")
          .select(
            "id,info_page_id,created_by,status,created_at,original_title,original_content_markdown,original_tags,original_category,original_chassis,proposed_title,proposed_content_markdown,proposed_tags,proposed_category,proposed_chassis"
          )
          .eq("id", update.id)
          .maybeSingle<UpdateRow>();
        if (refreshed) {
          setUpdate(refreshed);
          setEditTitle(refreshed.proposed_title ?? "");
          setEditContent(refreshed.proposed_content_markdown ?? "");
          setEditTags((refreshed.proposed_tags ?? []).join(", "));
          setEditCategory(refreshed.proposed_category ?? page.category ?? "maintenance-general");
          setEditChassis(refreshed.proposed_chassis ?? page.chassis ?? "general");
        }

        // Refresh review history so notes/actions show immediately without a full page reload.
        const { data: evs } = await supabase
          .from("info_page_review_events")
          .select("id,action,performed_by,created_at,notes")
          .eq("info_page_id", page.id)
          .order("created_at", { ascending: false })
          .limit(50);

        const events = (Array.isArray(evs) ? (evs as ReviewEvent[]) : []) ?? [];
        setReviewEvents(events);

        const actorIds = Array.from(
          new Set(
            events
              .map((e) => e.performed_by)
              .filter((x): x is string => typeof x === "string" && x.length > 0)
          )
        );

        if (actorIds.length > 0) {
          const { data: actorProfiles } = await supabase
            .from("profiles")
            .select("id,username,display_name")
            .in("id", actorIds);

          const map: Record<string, ProfileLite> = {};
          (actorProfiles ?? []).forEach((p) => {
            const row = p as ProfileLite;
            map[row.id] = row;
          });
          setReviewNamesById(map);
        } else {
          setReviewNamesById({});
        }

        setActing("idle");
        if (kind === "edit") setEditOpen(false);
        return;
      }

      router.push("/staff/info/updates");
    } catch (e) {
      console.error(e);
      setError("Unexpected error.");
      setActing("idle");
    }
  }

  if (loading) {
    return <div className="mx-auto max-w-6xl px-4 py-8 text-brand-textMuted">Loading...</div>;
  }

  if (forbidden) {
    return (
      <div className="mx-auto max-w-6xl px-4 py-8">
        <div className="rounded-xl border border-zinc-800/80 bg-black/40 p-4">
          <p className="text-sm text-rose-200">Forbidden</p>
        </div>
      </div>
    );
  }

  if (!update || !page) {
    return (
      <div className="mx-auto max-w-6xl px-4 py-8">
        <div className="rounded-xl border border-zinc-800/80 bg-black/40 p-4">
          <p className="text-sm text-rose-200">Not found</p>
        </div>
      </div>
    );
  }

  // `who`, `currentHeadings`, `proposedHeadings`, `noteCount` are declared above.

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <div className="mb-3">
        <Link
          href="/staff/info/updates"
          className="text-[12px] underline underline-offset-2 text-amber-300 hover:text-amber-200"
        >
          ← Back to updates
        </Link>
      </div>

      <div className="mb-6">
        <p className="text-[11px] uppercase tracking-[0.15em] text-brand-textMuted">Admin • Info</p>
        <h1 className="text-2xl font-semibold text-brand-text">Review pending update</h1>
        <p className="mt-1 text-[12px] text-brand-textMuted">
          <span className="text-brand-text">{page.title}</span>
          <span className="text-brand-textMuted"> • </span>
          Submitted by {who}
        </p>
      </div>

      {error && (
        <div className="mb-4 rounded-xl border border-rose-400/30 bg-rose-500/10 p-3 text-sm text-rose-200">
          {error}
        </div>
      )}

      <div className="grid gap-6 md:grid-cols-[1fr,340px]">
        {/* Main content (styled closer to the live /info page) */}
        <div className="space-y-6">
          <div className="rounded-2xl border border-zinc-800/80 bg-black/30 p-5">
            <div className="flex flex-wrap items-end justify-between gap-2">
              <div>
                <p className="text-[11px] uppercase tracking-[0.15em] text-brand-textMuted">Current</p>
                <div className="mt-1 text-lg font-semibold text-brand-text">{page.title}</div>
                <div className="text-[12px] text-brand-textMuted">/{page.slug}</div>
              </div>
              <div className="text-[12px] text-brand-textMuted">
                Category: {page.category ?? "—"} • Chassis: {page.chassis ?? "—"}
              </div>
            </div>

            {Array.isArray(page.tags) && page.tags.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-1">
                {page.tags.map((t) => (
                  <span
                    key={t}
                    className="rounded-full border border-zinc-700 bg-black/40 px-2 py-0.5 text-[10px] text-brand-textMuted"
                  >
                    {t}
                  </span>
                ))}
              </div>
            )}

            <div className="mt-4 grid gap-6 md:grid-cols-3">
              <div className="min-w-0 md:col-span-2">
                <MarkdownContent markdown={page.content_markdown} />
              </div>

              <div className="space-y-3 md:col-span-1">
                {/* Author card (match /info/[id]) */}
                {authorProfile ? (
                  <Link
                    href={`/user/${authorProfile.id}`}
                    className="block rounded-lg border border-zinc-800/80 bg-black/40 p-3 hover:border-zinc-700"
                  >
                    <div className="flex items-start gap-3">
                      <div className="h-12 w-12 shrink-0 overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900/40">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        {authorProfile.avatar_url ? (
                          <img
                            src={authorProfile.avatar_url}
                            alt={authorProfile.display_name ?? authorProfile.username ?? "Author"}
                            className="h-full w-full object-cover"
                          />
                        ) : (
                          <div className="flex h-full w-full items-center justify-center text-zinc-400">
                            <span className="text-lg">
                              {((authorProfile.display_name ?? authorProfile.username ?? "?")[0] || "?").toUpperCase()}
                            </span>
                          </div>
                        )}
                      </div>

                      <div className="min-w-0">
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex min-w-0 items-center gap-1 truncate text-[13px] font-semibold text-zinc-100">
                            <span className="truncate">
                              {authorProfile.display_name || authorProfile.username || "Unknown"}
                            </span>
                            {authorProfile.is_verified ? <VerifiedBadge className="h-3 w-3" /> : null}
                            {authorProfile.donation_rank ? (
                              <DonationBadge rank={authorProfile.donation_rank} className="h-3 w-3" />
                            ) : null}
                          </div>
                          <RolePill role={authorRole} />
                        </div>
                        {authorProfile.username ? (
                          <div className="truncate text-[11px] text-brand-textMuted">
                            @{authorProfile.username}
                          </div>
                        ) : null}
                      </div>
                    </div>
                  </Link>
                ) : null}

                {/* Contributors (match /info/[id]) */}
                {contributors.length > 0 && (
                  <div className="rounded-lg border border-zinc-800/80 bg-black/40 p-3">
                    <p className="text-xs font-semibold uppercase tracking-wide text-brand-textMuted">Contributors</p>
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
                              {/* eslint-disable-next-line @next/next/no-img-element */}
                              {c.avatar_url ? (
                                <img src={c.avatar_url} alt={name} className="h-full w-full object-cover" />
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
                              {username ? (
                                <div className="truncate text-[10px] text-brand-textMuted">{username}</div>
                              ) : null}
                            </div>
                          </Link>
                        );
                      })}
                      {contributors.length > 8 ? (
                        <p className="text-[11px] text-brand-textMuted">+{contributors.length - 8} more</p>
                      ) : null}
                    </div>
                  </div>
                )}

                {/* Table of contents (match /info/[id]) */}
                <div className="rounded-lg border border-zinc-800/80 bg-black/40 p-3 text-[12px]">
                  <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-brand-textMuted">
                    Table of contents
                  </h2>

                  {currentHeadings.length === 0 ? (
                    <p className="text-[11px] text-brand-textMuted">This page has no headings yet.</p>
                  ) : (
                    <ul className="space-y-1 text-[12px]">
                      {currentHeadings.map((h) => (
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
                </div>
              </div>
            </div>
          </div>

          <div className="rounded-2xl border border-amber-400/25 bg-amber-500/5 p-5">
            <div className="flex flex-wrap items-end justify-between gap-2">
              <div>
                <p className="text-[11px] uppercase tracking-[0.15em] text-amber-200/90">Proposed</p>
                <div className="mt-1 text-lg font-semibold text-brand-text">{update.proposed_title ?? page.title}</div>
                <div className="text-[12px] text-brand-textMuted">/{page.slug}</div>
              </div>
              <div className="text-[12px] text-brand-textMuted">
                Category: {update.proposed_category ?? page.category ?? "—"} • Chassis: {update.proposed_chassis ?? page.chassis ?? "—"}
              </div>
            </div>

            {Array.isArray(update.proposed_tags) && update.proposed_tags.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-1">
                {update.proposed_tags.map((t) => (
                  <span
                    key={t}
                    className="rounded-full border border-amber-400/25 bg-black/20 px-2 py-0.5 text-[10px] text-amber-200/90"
                  >
                    {t}
                  </span>
                ))}
              </div>
            )}

            <div className="mt-4 grid gap-6 md:grid-cols-3">
              <div className="min-w-0 md:col-span-2">
                <MarkdownContent markdown={update.proposed_content_markdown} />
              </div>

              <div className="space-y-3 md:col-span-1">
                {/* Author card (match /info/[id]) */}
                {authorProfile ? (
                  <Link
                    href={`/user/${authorProfile.id}`}
                    className="block rounded-lg border border-zinc-800/80 bg-black/40 p-3 hover:border-zinc-700"
                  >
                    <div className="flex items-start gap-3">
                      <div className="h-12 w-12 shrink-0 overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900/40">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        {authorProfile.avatar_url ? (
                          <img
                            src={authorProfile.avatar_url}
                            alt={authorProfile.display_name ?? authorProfile.username ?? "Author"}
                            className="h-full w-full object-cover"
                          />
                        ) : (
                          <div className="flex h-full w-full items-center justify-center text-zinc-400">
                            <span className="text-lg">
                              {((authorProfile.display_name ?? authorProfile.username ?? "?")[0] || "?").toUpperCase()}
                            </span>
                          </div>
                        )}
                      </div>

                      <div className="min-w-0">
                        <div className="flex items-center gap-1 truncate text-[13px] font-semibold text-zinc-100">
                          <span className="truncate">
                            {authorProfile.display_name || authorProfile.username || "Unknown"}
                          </span>
                          {authorProfile.is_verified ? <VerifiedBadge className="h-3 w-3" /> : null}
                          {authorProfile.donation_rank ? (
                            <DonationBadge rank={authorProfile.donation_rank} className="h-3 w-3" />
                          ) : null}
                        </div>
                        {authorProfile.username ? (
                          <div className="truncate text-[11px] text-brand-textMuted">@{authorProfile.username}</div>
                        ) : null}
                        <div className="mt-2 flex flex-wrap items-center gap-2">
                          <span
                            className={[
                              "inline-flex items-center rounded-full border px-2 py-0.5 text-[10px]",
                              rolePillClass(authorRole),
                            ].join(" ")}
                          >
                            {formatRoleLabel(authorRole)}
                          </span>
                        </div>
                      </div>
                    </div>
                  </Link>
                ) : null}

                {/* Contributors (match /info/[id]) */}
                {proposedContributors.length > 0 && (
                  <div className="rounded-lg border border-zinc-800/80 bg-black/40 p-3">
                    <p className="text-xs font-semibold uppercase tracking-wide text-brand-textMuted">Contributors</p>
                    <div className="mt-2 space-y-2">
                      {proposedContributors.slice(0, 8).map((c) => {
                        const name = (c.display_name ?? c.username ?? "Member").trim();
                        const username = c.username ? `@${c.username}` : null;
                        return (
                          <Link
                            key={c.id}
                            href={`/user/${c.id}`}
                            className="flex items-center gap-2 rounded-md border border-zinc-800/80 bg-black/30 px-2 py-1.5 hover:border-zinc-700"
                          >
                            <div className="h-7 w-7 shrink-0 overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900/40">
                              {/* eslint-disable-next-line @next/next/no-img-element */}
                              {c.avatar_url ? (
                                <img src={c.avatar_url} alt={name} className="h-full w-full object-cover" />
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
                              {username ? (
                                <div className="truncate text-[10px] text-brand-textMuted">{username}</div>
                              ) : null}
                            </div>
                          </Link>
                        );
                      })}
                      {proposedContributors.length > 8 ? (
                        <p className="text-[11px] text-brand-textMuted">
                          +{proposedContributors.length - 8} more
                        </p>
                      ) : null}
                    </div>
                  </div>
                )}

                {/* Table of contents (match /info/[id]) */}
                <div className="rounded-lg border border-zinc-800/80 bg-black/40 p-3 text-[12px]">
                  <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-brand-textMuted">
                    Table of contents
                  </h2>

                  {proposedHeadings.length === 0 ? (
                    <p className="text-[11px] text-brand-textMuted">This page has no headings yet.</p>
                  ) : (
                    <ul className="space-y-1 text-[12px]">
                      {proposedHeadings.map((h) => (
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
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Sidebar actions */}
        <aside className="space-y-4">
          <div className="rounded-2xl border border-zinc-800/80 bg-black/40 p-4">
            <p className="text-[11px] uppercase tracking-[0.15em] text-brand-textMuted">Review</p>
            <div className="mt-2 space-y-2 text-[12px] text-brand-textMuted">
              <div>Submitted: <span className="text-brand-text">{new Date(update.created_at).toLocaleString()}</span></div>
              <div>Status: <span className="text-brand-text">{update.status}</span></div>
            </div>

            <p className="mt-4 text-[11px] uppercase tracking-[0.15em] text-brand-textMuted">Admin notes (optional)</p>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              className="mt-2 w-full rounded-lg border border-zinc-700 bg-black/40 p-3 text-sm text-brand-text outline-none"
              placeholder="Reason for approval/rejection (saved on review event)"
            />

            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                disabled={acting !== "idle"}
                onClick={() => void act("note")}
                className={`rounded-full border px-4 py-2 text-[12px] font-medium transition ${
                  acting !== "idle"
                    ? "cursor-not-allowed opacity-60 border-zinc-700 bg-black/30 text-brand-textMuted"
                    : "border-zinc-700 bg-black/30 text-brand-textMuted hover:border-zinc-500 hover:text-brand-text"
                }`}
              >
                {acting === "noting" ? "Saving note..." : "Save note"}
              </button>

              <button
                type="button"
                disabled={acting !== "idle"}
                onClick={() => setEditOpen((v) => !v)}
                className={`rounded-full border px-4 py-2 text-[12px] font-medium transition ${
                  acting !== "idle"
                    ? "cursor-not-allowed opacity-60 border-zinc-700 bg-black/30 text-brand-textMuted"
                    : editOpen
                      ? "border-brand-primary/60 bg-brand-primary/10 text-brand-text hover:border-brand-primary"
                      : "border-zinc-700 bg-black/30 text-brand-textMuted hover:border-zinc-500 hover:text-brand-text"
                }`}
              >
                {editOpen ? "Close editor" : "Edit proposal"}
              </button>
            </div>

            {editOpen && (
              <div className="mt-3 space-y-2 rounded-xl border border-zinc-800/80 bg-black/30 p-3">
                <div className="grid grid-cols-1 gap-2">
                  <label className="space-y-1">
                    <span className="text-[11px] uppercase tracking-[0.12em] text-brand-textMuted">
                      Proposed title
                    </span>
                    <input
                      value={editTitle}
                      onChange={(e) => setEditTitle(e.target.value)}
                      className="w-full rounded-md border border-zinc-700 bg-black/40 px-3 py-2 text-sm text-brand-text outline-none"
                      placeholder={page.title}
                    />
                  </label>

                  {/* Slug is intentionally read-only for update proposals (keeps parity with Pending UI) */}
                  <label className="space-y-1">
                    <span className="text-[11px] uppercase tracking-[0.12em] text-brand-textMuted">Slug</span>
                    <input
                      value={page.slug ?? ""}
                      disabled
                      className="w-full cursor-not-allowed rounded-md border border-zinc-800 bg-black/30 px-3 py-2 text-sm text-brand-textMuted outline-none"
                    />
                    <p className="text-[11px] text-brand-textMuted">Slug changes aren’t supported on updates (pending pages can edit slug).</p>
                  </label>

                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    <label className="space-y-1">
                      <span className="text-[11px] uppercase tracking-[0.12em] text-brand-textMuted">
                        Category
                      </span>
                      <MenuSelect
                        ariaLabel="Category"
                        value={editCategory}
                        onChange={(next) => setEditCategory(next)}
                        className="flex h-10 w-full items-center gap-2 rounded-md border border-zinc-700 bg-black/40 px-3 text-sm text-brand-text outline-none transition hover:border-amber-400/70"
                        options={CATEGORY_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
                      />
                    </label>
                    <label className="space-y-1">
                      <span className="text-[11px] uppercase tracking-[0.12em] text-brand-textMuted">
                        Chassis
                      </span>
                      <MenuSelect
                        ariaLabel="Chassis"
                        value={editChassis}
                        onChange={(next) => setEditChassis(next)}
                        className="flex h-10 w-full items-center gap-2 rounded-md border border-zinc-700 bg-black/40 px-3 text-sm text-brand-text outline-none transition hover:border-amber-400/70"
                        options={CHASSIS_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
                      />
                    </label>
                  </div>

                  <label className="space-y-1">
                    <span className="text-[11px] uppercase tracking-[0.12em] text-brand-textMuted">
                      Tags (comma-separated)
                    </span>
                    <input
                      value={editTags}
                      onChange={(e) => setEditTags(e.target.value)}
                      className="w-full rounded-md border border-zinc-700 bg-black/40 px-3 py-2 text-sm text-brand-text outline-none"
                      placeholder={(update.proposed_tags ?? page.tags ?? []).join(", ")}
                    />
                  </label>

                  <div className="space-y-1">
                    <span className="text-[11px] uppercase tracking-[0.12em] text-brand-textMuted">
                      Proposed content (markdown)
                    </span>
                    <MarkdownEditor
                      value={editContent}
                      onChange={setEditContent}
                      helperText="Use markdown for headings, links, images, lists, etc."
                      rows={10}
                    />
                  </div>

                  <div className="flex items-center justify-end gap-2">
                    <button
                      type="button"
                      disabled={acting !== "idle"}
                      onClick={() => {
                        const tags = editTags
                          .split(",")
                          .map((t) => t.trim())
                          .filter(Boolean);
                        void act("edit", {
                          proposedTitle: editTitle.trim() || null,
                          proposedContentMarkdown: editContent.trim() || null,
                          proposedTags: tags.length ? tags : null,
                          proposedCategory: editCategory.trim() || null,
                          proposedChassis: editChassis.trim() || null,
                        });
                      }}
                      className={`rounded-full border px-4 py-2 text-[12px] font-medium transition ${
                        acting !== "idle"
                          ? "cursor-not-allowed opacity-60 border-zinc-700 bg-black/30 text-brand-textMuted"
                          : "border-brand-primary/50 bg-brand-primary/15 text-brand-text hover:border-brand-primary"
                      }`}
                    >
                      {acting === "saving_edits" ? "Saving..." : "Save edits"}
                    </button>
                  </div>
                </div>
              </div>
            )}

            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                disabled={acting !== "idle"}
                onClick={() => void act("approve")}
                className={`rounded-full border px-4 py-2 text-[12px] font-medium transition ${
                  acting !== "idle"
                    ? "cursor-not-allowed opacity-60 border-zinc-700 bg-black/30 text-brand-textMuted"
                    : "border-emerald-400/40 bg-emerald-500/10 text-emerald-200 hover:border-emerald-300/70"
                }`}
              >
                {acting === "approving" ? "Approving..." : "Approve"}
              </button>

              <button
                type="button"
                disabled={acting !== "idle"}
                onClick={() => void act("reject")}
                className={`rounded-full border px-4 py-2 text-[12px] font-medium transition ${
                  acting !== "idle"
                    ? "cursor-not-allowed opacity-60 border-zinc-700 bg-black/30 text-brand-textMuted"
                    : "border-rose-400/40 bg-rose-500/10 text-rose-200 hover:border-rose-300/70"
                }`}
              >
                {acting === "rejecting" ? "Rejecting..." : "Reject"}
              </button>

              <button
                type="button"
                disabled={acting !== "idle"}
                onClick={() => void act("forward")}
                className={`rounded-full border px-4 py-2 text-[12px] font-medium transition ${
                  acting !== "idle"
                    ? "cursor-not-allowed opacity-60 border-zinc-700 bg-black/30 text-brand-textMuted"
                    : "border-amber-400/40 bg-amber-500/10 text-amber-200 hover:border-amber-300/70"
                }`}
              >
                {acting === "forwarding" ? "Submitting..." : "Submit for further review"}
              </button>

              <Link
                href={`/info/${encodeURIComponent(page.slug)}`}
                className="ml-auto rounded-full border border-zinc-700 bg-black/40 px-4 py-2 text-[12px] text-brand-textMuted hover:border-amber-400/80 hover:text-brand-text"
              >
                View live
              </Link>
            </div>

            <div className="mt-4 border-t border-zinc-800/80 pt-4">
              {noteEvents.length > 0 ? (
  <div className="mb-4">
    <div className="flex items-baseline justify-between gap-2">
      <p className="text-[11px] uppercase tracking-[0.15em] text-brand-textMuted">Notes</p>
      <p className="text-[11px] text-brand-textMuted">{noteCount === 1 ? "1 note" : `${noteCount} notes`}</p>
    </div>
    <div className="mt-2 space-y-2">
      {noteEvents.map((n) => {
        const actor = n.performed_by ? reviewNamesById[n.performed_by] : null;
        const actorName = actor?.display_name ?? actor?.username ?? (n.performed_by ?? "Unknown");
        return (
          <div key={n.id} className="rounded-xl border border-zinc-800/80 bg-black/30 p-3">
            <p className="text-[11px] text-brand-textMuted">{actorName} • {new Date(n.created_at).toLocaleString()}</p>
            <p className="mt-1 whitespace-pre-wrap text-[12px] text-brand-textMuted">{n.notes}</p>
          </div>
        );
      })}
    </div>
  </div>
) : null}

              <div className="flex items-baseline justify-between gap-2">
                <p className="text-[11px] uppercase tracking-[0.15em] text-brand-textMuted">Review history</p>
                <p className="text-[11px] text-brand-textMuted">
                  {nonNoteReviewEvents.length} event{nonNoteReviewEvents.length === 1 ? "" : "s"}
                </p>
              </div>

              {nonNoteReviewEvents.length === 0 ? (
                <p className="mt-2 text-[12px] text-brand-textMuted">No review history yet.</p>
              ) : (
                <div className="mt-2 space-y-2">
                  {nonNoteReviewEvents.map((ev) => {
                    const actor = ev.performed_by ? reviewNamesById[ev.performed_by] : null;
                    const actorName = actor?.display_name ?? actor?.username ?? (ev.performed_by ?? "Unknown");

                    return (
                      <div
                        key={ev.id}
                        className="rounded-xl border border-zinc-800/80 bg-black/30 p-3"
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <p className="text-[12px] font-semibold text-brand-text">
                              {formatReviewAction(ev.action)}
                            </p>
                            <p className="text-[11px] text-brand-textMuted">
                              {actorName} • {new Date(ev.created_at).toLocaleString()}
                            </p>
                          </div>
                        </div>
                        {/* notes are shown in the Notes section above */}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}
