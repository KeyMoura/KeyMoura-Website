"use client";

import type { ReactNode } from "react";
import { useEffect, useMemo, useState, KeyboardEvent, ChangeEvent } from "react";
import Link from "next/link";
import { VerifiedBadge } from "@/components/VerifiedBadge";
import { DonationBadge } from "@/components/DonationBadge";
import { RolePill } from "@/components/RolePill";
import { useParams, useRouter } from "next/navigation";
import { supabaseBrowser } from "@/lib/supabaseClient";
import { useBlocks } from "@/components/BlocksProvider";
import { MarkdownEditor } from "@/components/MarkdownEditor";
import ReportModal from "@/components/ReportModal";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import {
  faPaperPlane,
  faGavel,
  faHand,
  faLocationDot,
} from "@fortawesome/free-solid-svg-icons";

const INITIAL_NOW = Date.now();

// ---------- types ----------

type ProfileRow = {
  id: string;
  username: string | null;
  display_name: string | null;
  bio: string | null;
  location: string | null;
  avatar_url: string | null;
  karma?: number | null;
  created_at: string;
  last_seen_at: string | null;
  is_verified?: boolean | null;
  donation_rank?: string | null;
};

type RoleRow = { role: string };

type RestrictionRow = {
  id: string;
  user_id: string;
  kind: "site" | "community" | "dm" | string;
  active: boolean | null;
  expires_at: string | null;
};

type InfoPageRow = {
  id: string;
  title: string;
  slug: string;
  created_at: string;
  status: string;
  category: string | null;
  chassis: string | null;
  tags: string[] | null;
  content_markdown: string | null;
};

type UserPost = {
  id: string;
  title: string;
  slug: string;
  createdAt: string;
  excerpt: string;
  tags: string[];
  category: string | null;
  chassis: string | null;
  // If true, user is the original author (created_by)
  is_author?: boolean;
  // If true, user is a contributor (not the original author)
  is_contributor?: boolean;
};

type GarageCarRow = {
  id: string;
  owner_id: string;
  name: string | null;
  make: string | null;
  model: string | null;
  year: number | null;
  chassis: string | null;
  trim: string | null;
  color: string | null;
  engine: string | null;
  power_hp: number | null;
  torque_ftlb: number | null;
  weight_lb: number | null;
  use_type: string | null;
  visibility: string | null;
  is_primary: boolean | null;
  summary: string | null;
  mods: string | null;
  cover_image_url: string | null;
  created_at: string;
  updated_at: string;
};

type CommunityThread = {
  id: number;
  title: string;
  slug: string;
  categorySlug: string;
  createdAt: string;
  lastPostAt: string | null;
  replyCount: number;
  viewCount: number;
};

type RecentReply = {
  id: number;
  threadId: number;
  threadTitle: string;
  threadSlug: string;
  categorySlug: string;
  createdAt: string;
  excerpt: string;
};

// ---------- staff bundle "unknown-safe" types (remove explicit any) ----------

type UnknownRow = Record<string, unknown>;
type UnknownRowMap = Record<string, UnknownRow>;

type StaffBundleResp =
  | { ok: true; [key: string]: unknown }
  | { ok: false; error: string; [key: string]: unknown };

// ---------- helpers ----------

function isUuid(v: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    v.trim()
  );
}

function normalizeUserKey(raw: string): { kind: "uuid" | "username"; value: string } {
  const t = decodeURIComponent(raw).trim();
  if (isUuid(t)) return { kind: "uuid", value: t };
  const u = t.startsWith("@") ? t.slice(1) : t;
  return { kind: "username", value: u };
}

// ---------- highlight helpers ----------

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function highlightText(text: string, tokens: string[]): ReactNode {
  if (!text || tokens.length === 0) return text;

  const cleanedTokens = Array.from(
    new Set(
      tokens
        .map((t) => t.trim().toLowerCase())
        .filter((t) => t.length > 0)
    )
  );
  if (cleanedTokens.length === 0) return text;

  const pattern = cleanedTokens.map(escapeRegExp).join("|");
  if (!pattern) return text;

  const regex = new RegExp(`(${pattern})`, "gi");
  const parts = text.split(regex);

  return parts.map((part, idx) => {
    const lower = part.toLowerCase();
    const isMatch = cleanedTokens.some((t) => t === lower);

    if (isMatch) {
      return (
        <span key={idx} className="rounded-[3px] bg-amber-500/20 px-0.5 text-amber-300">
          {part}
        </span>
      );
    }

    return <span key={idx}>{part}</span>;
  });
}

function truncateText(input: string | null | undefined, maxLen: number): string {
  const t = (input ?? "").trim();
  if (!t) return "";
  if (t.length <= maxLen) return t;
  return `${t.slice(0, Math.max(0, maxLen - 1))}…`;
}

// ---------- main page ----------

export default function UserProfilePage() {
  const router = useRouter();
  const [requiresLogin, setRequiresLogin] = useState(false);
  const params = useParams();
  const idParam = (params as { id?: string }).id;
  const rawId =
    typeof idParam === "string" ? idParam : Array.isArray(idParam) ? idParam[0] : undefined;

  // resolved UUID
  const [resolvedUserId, setResolvedUserId] = useState<string | null>(null);
  const [resolveLoading, setResolveLoading] = useState<boolean>(!!rawId);

  const [loading, setLoading] = useState<boolean>(!!rawId);
  const [error, setError] = useState<string | null>(rawId ? null : "Missing user id.");

  const [reportOpen, setReportOpen] = useState(false);

  const [profile, setProfile] = useState<ProfileRow | null>(null);
  const [role, setRole] = useState<string | null>(null);
  const [posts, setPosts] = useState<UserPost[]>([]);
  const [communityThreads, setCommunityThreads] = useState<CommunityThread[]>([]);
  const [recentReplies, setRecentReplies] = useState<RecentReply[]>([]);

  // garage
  const [garageCars, setGarageCars] = useState<GarageCarRow[]>([]);
  const [garageLoaded, setGarageLoaded] = useState(false);

  // viewer / blocking (cached globally)
  const {
    viewerId,
    viewerRole: blocksViewerRole,
    viewerIsStaff: blocksViewerIsStaff,
    blockedUserIds,
    blockedByUserIds,
    loading: blocksLoading,
    setBlockedLocal,
  } = useBlocks();
  const [viewerIsStaff, setViewerIsStaff] = useState(false);
  const [viewerRoleLower, setViewerRoleLower] = useState<string>("member");
  const viewerCanModerate = viewerRoleLower === "admin" || viewerRoleLower === "moderator";

  const [targetRoleLower, setTargetRoleLower] = useState<string | null>(null);
  const targetIsStaff = !!(targetRoleLower && targetRoleLower !== "member");

  const [activeRestrictions, setActiveRestrictions] = useState<RestrictionRow[]>([]);
  const [restrLoading, setRestrLoading] = useState(false);
  const [restrError, setRestrError] = useState<string | null>(null);

  const [banStatusLoading, setBanStatusLoading] = useState(false);
  const [isPermanentlyBanned, setIsPermanentlyBanned] = useState(false);
  const [banReason, setBanReason] = useState<string | null>(null);
  const [banAt, setBanAt] = useState<string | null>(null);

  const [moderationBusy, setModerationBusy] = useState(false);
  const [moderationMsg, setModerationMsg] = useState<string | null>(null);
  const [blockLoading, setBlockLoading] = useState(false);
  const [blockError, setBlockError] = useState<string | null>(null);

  const [messageLoading, setMessageLoading] = useState(false);
  const [messageError, setMessageError] = useState<string | null>(null);

  // re-fetch trigger (when unblock to restore content)
  const [reloadNonce, setReloadNonce] = useState(0);

  // When staff views a profile, we load via a server bundle route (service-role)
  // so a member blocking staff cannot hide their content.
  const [loadedViaApi, setLoadedViaApi] = useState(false);

  // chip-style search
  const [fragment, setFragment] = useState("");
  const [committedTerms, setCommittedTerms] = useState<string[]>([]);
  const [visibleCount, setVisibleCount] = useState(5);

  // chip-style search (community threads)
  const [threadFragment, setThreadFragment] = useState("");
  const [threadCommittedTerms, setThreadCommittedTerms] = useState<string[]>([]);
  const [threadVisibleCount, setThreadVisibleCount] = useState(5);

  // chip-style search (recent replies)
  const [replyFragment, setReplyFragment] = useState("");
  const [replyCommittedTerms, setReplyCommittedTerms] = useState<string[]>([]);
  const [replyVisibleCount, setReplyVisibleCount] = useState(5);

  // derived ids
  const iBlockedThem = !!(viewerId && resolvedUserId && blockedUserIds.has(resolvedUserId));
  const theyBlockedMe = !!(viewerId && resolvedUserId && blockedByUserIds.has(resolvedUserId));

  // IMPORTANT: staff must never have visibility suppressed by user blocks.
  // We compute an "effective" staff flag that works even during initial load.
  const viewerIsStaffEffective = viewerIsStaff || blocksViewerIsStaff;

  // Staff moderation menu: load active restrictions (site/community/dm) for this profile.
  useEffect(() => {
    if (!viewerCanModerate) {
      setActiveRestrictions([]);
      setRestrError(null);
      return;
    }
    if (!viewerId || !resolvedUserId) return;
    const run = async () => {
      setRestrLoading(true);
      setRestrError(null);
      try {
        const supabase = supabaseBrowser();
        // Load target role so we can hide moderation actions for staff accounts
        const { data: roleRow } = await supabase
          .from("user_roles")
          .select("role")
          .eq("user_id", resolvedUserId)
          .maybeSingle();

        const rawRole =
          roleRow && typeof (roleRow as unknown as { role?: unknown }).role === "string"
            ? String((roleRow as unknown as { role: string }).role).toLowerCase()
            : "member";

        setTargetRoleLower(rawRole);

        const { data, error: rErr } = await supabase
          .from("user_restrictions")
          .select("id, user_id, kind, active, expires_at")
          .eq("user_id", resolvedUserId)
          .eq("active", true)
          .in("kind", ["site", "community", "dm"]);

        if (rErr) {
          console.error("Failed to load restrictions", rErr);
          setRestrError("Failed to load restrictions.");
          setActiveRestrictions([]);
          setRestrLoading(false);
          return;
        }

        const nowMs = Date.now();
        const rows = (data ?? []) as RestrictionRow[];
        const active = rows.filter((r) => {
          const exp = r.expires_at;
          if (typeof exp === "string" && exp.length) {
            const t = new Date(exp).getTime();
            return Number.isFinite(t) ? t > nowMs : true;
          }
          return true;
        });

        setActiveRestrictions(active);
        setRestrLoading(false);
      } catch (e) {
        console.error("Unexpected restriction load error", e);
        setRestrError("Failed to load restrictions.");
        setActiveRestrictions([]);
        setRestrLoading(false);
      }
    };

    void run();
  }, [viewerCanModerate, viewerId, resolvedUserId, reloadNonce]);

  // Staff moderation menu: load permanent ban status for this profile.
  useEffect(() => {
    if (!viewerCanModerate) {
      setIsPermanentlyBanned(false);
      setBanReason(null);
      setBanAt(null);
      return;
    }
    if (!viewerId || !resolvedUserId) return;

    const run = async () => {
      setBanStatusLoading(true);
      try {
        const supabase = supabaseBrowser();
        const { data: sessionData } = await supabase.auth.getSession();
        const token = sessionData.session?.access_token;
        if (!token) return;

        const res = await fetch(
          `/api/admin/users/${encodeURIComponent(resolvedUserId)}/ban-status`,
          { headers: { Authorization: `Bearer ${token}` } }
        );

        const j = (await res.json().catch(() => null)) as
          | { ok?: boolean; banned?: unknown; reason?: unknown; banned_at?: unknown }
          | { error?: unknown }
          | null;

        if (!res.ok) {
          setIsPermanentlyBanned(false);
          setBanReason(null);
          setBanAt(null);
          return;
        }

        const banned = !!(j && (j as { banned?: unknown }).banned === true);
        const reason =
          typeof (j as { reason?: unknown } | null)?.reason === "string"
            ? ((j as { reason?: string }).reason ?? null)
            : null;

        const bannedAt =
          typeof (j as { banned_at?: unknown } | null)?.banned_at === "string"
            ? ((j as { banned_at?: string }).banned_at ?? null)
            : null;

        setIsPermanentlyBanned(banned);
        setBanReason(reason);
        setBanAt(bannedAt);
      } finally {
        setBanStatusLoading(false);
      }
    };

    void run();
  }, [viewerCanModerate, viewerId, resolvedUserId, reloadNonce]);

  function formatUntil(expiresAt: string | null): string {
    if (!expiresAt) return "";
    const d = new Date(expiresAt);
    if (!Number.isFinite(d.getTime())) return "";
    return d.toLocaleString();
  }

  async function setRestriction(kind: "site" | "community" | "dm", durationHours: number | null) {
    if (!resolvedUserId) return;
    setModerationBusy(true);
    setModerationMsg(null);
    try {
      const supabase = supabaseBrowser();
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData.session?.access_token;

      if (!token) {
        setModerationMsg("Unauthorized");
        return;
      }

      const res = await fetch("/api/staff/restrictions/set", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          userId: resolvedUserId,
          kind,
          action: "set",
          durationHours,
          reason: `From user profile ${resolvedUserId}`,
        }),
      });

      const j = (await res.json().catch(() => null)) as unknown;
      const ok = res.ok;
      if (!ok) {
        const msg =
          j &&
          typeof j === "object" &&
          "error" in j &&
          typeof (j as { error?: unknown }).error === "string"
            ? String((j as { error?: unknown }).error)
            : "Failed to apply restriction.";
        setModerationMsg(msg);
      } else {
        setModerationMsg("Updated.");
        setReloadNonce((n) => n + 1);
      }
    } catch (e) {
      console.error("restriction set error", e);
      setModerationMsg("Failed to apply restriction.");
    } finally {
      setModerationBusy(false);
    }
  }

  async function clearRestriction(kind: "site" | "community" | "dm") {
    if (!resolvedUserId) return;
    setModerationBusy(true);
    setModerationMsg(null);
    try {
      const supabase = supabaseBrowser();
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData.session?.access_token;

      if (!token) {
        setModerationMsg("Unauthorized");
        return;
      }

      const res = await fetch("/api/staff/restrictions/set", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          userId: resolvedUserId,
          kind,
          action: "clear",
          durationHours: null,
          reason: `From user profile ${resolvedUserId}`,
        }),
      });

      const j = (await res.json().catch(() => null)) as unknown;
      if (!res.ok) {
        const msg =
          j &&
          typeof j === "object" &&
          "error" in j &&
          typeof (j as { error?: unknown }).error === "string"
            ? String((j as { error?: unknown }).error)
            : "Failed to clear restriction.";
        setModerationMsg(msg);
      } else {
        setModerationMsg("Updated.");
        setReloadNonce((n) => n + 1);
      }
    } catch (e) {
      console.error("restriction clear error", e);
      setModerationMsg("Failed to clear restriction.");
    } finally {
      setModerationBusy(false);
    }
  }

  async function togglePermBan() {
    if (!resolvedUserId) return;
    setModerationBusy(true);
    setModerationMsg(null);
    try {
      const supabase = supabaseBrowser();
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData.session?.access_token;

      const res = await fetch("/api/staff/ban-user", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          userId: resolvedUserId,
          currentlyBanned: isPermanentlyBanned,
          reason: `From user profile ${resolvedUserId}`,
        }),
      });

      const j = (await res.json().catch(() => null)) as unknown;
      if (!res.ok) {
        const msg =
          j &&
          typeof j === "object" &&
          "error" in j &&
          typeof (j as { error?: unknown }).error === "string"
            ? String((j as { error?: unknown }).error)
            : "Failed to request ban.";
        setModerationMsg(msg);
      } else {
        const pending =
          j && typeof j === "object" && "pending" in j
            ? Boolean((j as { pending?: unknown }).pending)
            : false;

        if (pending) {
          setModerationMsg(
            isPermanentlyBanned ? "Unban request sent for approval." : "Ban request sent for approval."
          );
        } else {
          setModerationMsg(isPermanentlyBanned ? "User unbanned." : "User banned.");
          setReloadNonce((n) => n + 1);
        }
      }
    } catch (e) {
      console.error("ban request error", e);
      setModerationMsg("Failed to update ban.");
    } finally {
      setModerationBusy(false);
    }
  }

  // 0) Resolve /user/<uuid> OR /user/@username -> uuid
  useEffect(() => {
    if (!rawId) return;

    // Reset API-load flag whenever the route param changes.
    setLoadedViaApi(false);

    const run = async () => {
      setResolveLoading(true);
      setError(null);
      setResolvedUserId(null);

      // STAFF BYPASS:
      // If the viewer is staff, load the full profile bundle via a server route that
      // uses the service-role key. This ensures that a member blocking staff cannot
      // hide their /user page content, threads, or replies from staff.
      if (blocksViewerIsStaff) {
        try {
          const supabase = supabaseBrowser();
          const { data: sessionData } = await supabase.auth.getSession();
          const token = sessionData.session?.access_token ?? "";

          if (!token) {
            setRequiresLogin(true);
            setResolveLoading(false);
            setLoading(false);
            return;
          }

          const res = await fetch("/api/user/bundle", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({ userKey: rawId }),
          });

          const json = (await res.json().catch(() => null)) as StaffBundleResp | null;
          if (!res.ok || !json || json.ok !== true) {
            const msg =
              typeof (json as { error?: unknown } | null)?.error === "string"
                ? String((json as { error?: unknown }).error)
                : "Failed to load user.";
            setError(msg);
            setResolveLoading(false);
            setLoading(false);
            return;
          }

          const targetId: string = String((json as UnknownRow)?.target && typeof (json as UnknownRow).target === "object"
            ? ((json as UnknownRow).target as UnknownRow).id ?? ""
            : "");
          if (!targetId) {
            setError("User not found.");
            setResolveLoading(false);
            setLoading(false);
            return;
          }

          // Basic profile + role
          setResolvedUserId(targetId);
          setProfile(((json as UnknownRow).profile ?? null) as ProfileRow | null);

          const targetRoleLower = String(
            (json as UnknownRow)?.target && typeof (json as UnknownRow).target === "object"
              ? (((json as UnknownRow).target as UnknownRow).role ?? "member")
              : "member"
          ).toLowerCase();
          setRole(targetRoleLower);

          // Viewer role for moderation UI
          const viewerRoleTmp: string = String(
            (json as UnknownRow)?.viewer && typeof (json as UnknownRow).viewer === "object"
              ? (((json as UnknownRow).viewer as UnknownRow).role ?? blocksViewerRole ?? "member")
              : (blocksViewerRole ?? "member")
          ).toLowerCase();

          setViewerRoleLower(viewerRoleTmp);
          setViewerIsStaff(true);

          // Info pages (+ contributed)
          const pages = (Array.isArray((json as UnknownRow)?.pages) ? (json as UnknownRow).pages : []) as UnknownRow[];
          const contrib = (Array.isArray((json as UnknownRow)?.contributed_pages)
            ? (json as UnknownRow).contributed_pages
            : []) as UnknownRow[];

          const mappedPages: UserPost[] = pages.map((row) => {
            const content = String(row.content_markdown ?? "");
            const excerpt = content.length > 220 ? content.slice(0, 220) + "…" : content;
            return {
              id: String(row.id ?? ""),
              title: String(row.title ?? ""),
              slug: String(row.slug ?? ""),
              createdAt: String(row.created_at ?? ""),
              excerpt,
              tags: Array.isArray(row.tags) ? (row.tags as unknown[]).map((t) => String(t)) : [],
              category: (row.category ?? null) as string | null,
              chassis: (row.chassis ?? null) as string | null,
              // These rows are already filtered to pages created_by the target user.
              is_author: true,
            } as UserPost;
          });

          const mappedContrib: UserPost[] = contrib.map((row) => {
            const content = String(row.content_markdown ?? "");
            const excerpt = content.length > 220 ? content.slice(0, 220) + "…" : content;
            return {
              id: String(row.id ?? ""),
              title: String(row.title ?? ""),
              slug: String(row.slug ?? ""),
              createdAt: String(row.created_at ?? ""),
              excerpt,
              tags: Array.isArray(row.tags) ? (row.tags as unknown[]).map((t) => String(t)) : [],
              category: (row.category ?? null) as string | null,
              chassis: (row.chassis ?? null) as string | null,
              is_contributor: true,
            } as UserPost;
          });

          const byId = new Map<string, UserPost>();
          mappedPages.forEach((p) => byId.set(p.id, p));
          mappedContrib.forEach((p) => {
            if (!byId.has(p.id)) byId.set(p.id, p);
          });
          setPosts(Array.from(byId.values()));

          // Community threads
          const catSlugById = (((json as UnknownRow).thread_category_slugs ?? {}) as Record<string, string>) ?? {};
          const threadRows = (Array.isArray((json as UnknownRow)?.threads)
            ? (json as UnknownRow).threads
            : []) as UnknownRow[];

          const mappedThreads: CommunityThread[] = threadRows
            .map((t) => {
              const catSlug = catSlugById[String(t.category_id ?? "")] ?? "";
              if (!catSlug) return null;
              return {
                id: Number(t.id ?? 0),
                title: String(t.title ?? ""),
                slug: String(t.slug ?? ""),
                categorySlug: catSlug,
                createdAt: String(t.created_at ?? ""),
                lastPostAt: (t.last_post_at ?? null) as string | null,
                replyCount: Number(t.reply_count ?? 0),
                viewCount: Number(t.view_count ?? 0),
              } as CommunityThread;
            })
            .filter((x): x is CommunityThread => !!x);
          setCommunityThreads(mappedThreads);

          // Recent replies
          const replyRows = (Array.isArray((json as UnknownRow)?.replies)
            ? (json as UnknownRow).replies
            : []) as UnknownRow[];

          const replyThreads = (
            (json as UnknownRow)?.reply_threads && typeof (json as UnknownRow).reply_threads === "object"
              ? ((json as UnknownRow).reply_threads as UnknownRowMap)
              : {}
          ) as UnknownRowMap;

          const replyCatSlugs =
            ((json as UnknownRow)?.reply_category_slugs && typeof (json as UnknownRow).reply_category_slugs === "object"
              ? ((json as UnknownRow).reply_category_slugs as Record<string, string>)
              : {}) as Record<string, string>;

          const mappedReplies: RecentReply[] = replyRows
            .map((r) => {
              const th = replyThreads[String(r.thread_id ?? "")];
              if (!th) return null;
              const catSlug = replyCatSlugs[String(th.category_id ?? "")] ?? "";
              if (!catSlug) return null;
              const body = String(r.body_markdown ?? "");
              const excerpt = body.length > 220 ? body.slice(0, 220) + "…" : body;
              return {
                id: Number(r.id ?? 0),
                threadId: Number(r.thread_id ?? 0),
                threadTitle: String(th.title ?? ""),
                threadSlug: String(th.slug ?? ""),
                categorySlug: catSlug,
                createdAt: String(r.created_at ?? ""),
                excerpt,
              } as RecentReply;
            })
            .filter((x): x is RecentReply => !!x);
          setRecentReplies(mappedReplies);

          // Garage
          setGarageCars(
            (Array.isArray((json as UnknownRow).garage_cars)
              ? ((json as UnknownRow).garage_cars as unknown[])
              : []) as GarageCarRow[]
          );
          setGarageLoaded(true);

          setLoadedViaApi(true);
          setResolveLoading(false);
          setLoading(false);
          return;
        } catch (e) {
          console.error("staff bundle load error", e);
          setError("Failed to load user.");
          setResolveLoading(false);
          setLoading(false);
          return;
        }
      }

      const supabase = supabaseBrowser();
      const key = normalizeUserKey(rawId);

      try {
        if (key.kind === "uuid") {
          setResolvedUserId(key.value);
          setResolveLoading(false);
          return;
        }

        const username = key.value.trim();
        if (!username) {
          setError("Missing username.");
          setResolveLoading(false);
          setLoading(false);
          return;
        }

        const { data, error: findErr } = await supabase
          .from("profiles")
          .select("id")
          .ilike("username", username)
          .maybeSingle<{ id: string }>();

        if (findErr) {
          console.error("Failed to resolve username", findErr);
          setError("Failed to resolve username.");
          setResolveLoading(false);
          setLoading(false);
          return;
        }

        if (!data?.id) {
          setError("User not found.");
          setResolveLoading(false);
          setLoading(false);
          return;
        }

        setResolvedUserId(data.id);
        setResolveLoading(false);
      } catch (e) {
        console.error("Unexpected error resolving user key", e);
        setError("Unexpected error resolving user.");
        setResolveLoading(false);
        setLoading(false);
      }
    };

    void run();
  }, [rawId, blocksViewerIsStaff, blocksViewerRole]);

  // 1) Load page using resolvedUserId
  useEffect(() => {
    if (!resolvedUserId) return;
    if (loadedViaApi) return;

    const load = async () => {
      setRequiresLogin(false);
      setLoading(true);
      setError(null);
      setRole(null);
      setProfile(null);
      setPosts([]);
      setGarageCars([]);
      setGarageLoaded(false);
      setBlockError(null);

      try {
        const supabase = supabaseBrowser();

        // Require login to view user profiles (soft-lock page)
        if (!viewerId) {
          setRequiresLogin(true);
          setLoading(false);
          return;
        }

        const isSelf = viewerId === resolvedUserId;

        // viewer role (for staff exception + moderation menu)
        // IMPORTANT: rely on BlocksProvider's service-role backed role fetch.
        const viewerRoleTmp: string = (blocksViewerRole || "member").toLowerCase();
        setViewerRoleLower(viewerRoleTmp);

        const staff =
          viewerRoleTmp === "admin" ||
          viewerRoleTmp === "support" ||
          viewerRoleTmp === "moderator" ||
          viewerRoleTmp === "mod";
        setViewerIsStaff(staff);

        // profile
        const { data: profileData, error: profileErr } = await supabase
          .from("profiles")
          .select(
            "id, username, display_name, bio, location, avatar_url, karma, created_at, last_seen_at, is_verified, donation_rank"
          )
          .eq("id", resolvedUserId)
          .maybeSingle<ProfileRow>();

        if (profileErr) {
          console.error("Failed to load profile", profileErr);
          setError("Failed to load user profile.");
          setLoading(false);
          return;
        }

        if (!profileData) {
          setError("User not found.");
          setLoading(false);
          return;
        }

        setProfile(profileData);

        // role (profile owner's role)
        const { data: roleRow, error: roleErr } = await supabase
          .from("user_roles")
          .select("role")
          .eq("user_id", resolvedUserId)
          .maybeSingle<RoleRow>();

        const profileRoleLower = !roleErr && roleRow?.role ? String(roleRow.role).toLowerCase() : "member";
        setRole(profileRoleLower);

        // ✅ IMPORTANT: compute from the freshly fetched roleRow, NOT from `role` state
        const profileIsStaff =
          profileRoleLower === "admin" ||
          profileRoleLower === "support" ||
          profileRoleLower === "moderator" ||
          profileRoleLower === "mod";

        // ✅ APPLY BLOCK RULES
        // Staff should never have visibility suppressed by user blocks.
        // IMPORTANT: compute from the freshly fetched viewerRoleTmp (and blocks provider) inside this async load,
        // so we don't get stuck using stale state captured by the closure.
        const viewerIsStaffNow = staff || blocksViewerIsStaff;

        const shouldHideForBlocks = !isSelf && !viewerIsStaffNow && (iBlockedThem || theyBlockedMe);

        if (shouldHideForBlocks) {
          setGarageLoaded(true);
          setLoading(false);
          return;
        }

        // posts
        const { data: pagesData, error: pagesError } = await supabase
          .from("info_pages")
          .select("id, title, slug, created_at, status, category, chassis, tags, content_markdown")
          .eq("created_by", resolvedUserId)
          .eq("status", "approved")
          .order("created_at", { ascending: false })
          .limit(200);

        if (pagesError) console.error("Failed to load user posts", pagesError);

        const rows = (pagesData ?? []) as InfoPageRow[];
        const mapped: UserPost[] = rows.map((row) => {
          const content = row.content_markdown ?? "";
          const excerpt = content.length > 220 ? content.slice(0, 220) + "…" : content;
          return {
            id: row.id,
            title: row.title,
            slug: row.slug,
            createdAt: row.created_at,
            excerpt,
            tags: row.tags ?? [],
            category: row.category,
            chassis: row.chassis,
            is_author: true,
          };
        });

        // include approved pages where this user is a contributor
        try {
          const { data: contribRows, error: contribErr } = await supabase
            .from("info_page_contributors")
            .select("info_page_id")
            .eq("user_id", resolvedUserId);

          if (contribErr) {
            console.error("Failed to load info page contributions", contribErr);
          } else {
            const contribIds = Array.from(
              new Set(
                (contribRows ?? [])
                  .map((r) => (r as { info_page_id?: string | null }).info_page_id)
                  .filter((v): v is string => typeof v === "string" && v.length > 0)
              )
            );

            if (contribIds.length > 0) {
              const { data: contribPages, error: contribPagesErr } = await supabase
                .from("info_pages")
                .select("id, title, slug, created_at, status, category, chassis, tags, content_markdown")
                .in("id", contribIds)
                .eq("status", "approved")
                .order("created_at", { ascending: false })
                .limit(200);

              if (contribPagesErr) {
                console.error("Failed to load contributed info pages", contribPagesErr);
              } else {
                const contribMapped: UserPost[] = ((contribPages ?? []) as InfoPageRow[]).map((row) => {
                  const content = row.content_markdown ?? "";
                  const excerpt = content.length > 220 ? content.slice(0, 220) + "…" : content;
                  return {
                    id: row.id,
                    title: row.title,
                    slug: row.slug,
                    createdAt: row.created_at,
                    excerpt,
                    tags: row.tags ?? [],
                    category: row.category,
                    chassis: row.chassis,
                    is_contributor: true,
                  };
                });

                const byId = new Map<string, UserPost>();
                mapped.forEach((p) => byId.set(p.id, p));
                contribMapped.forEach((p) => {
                  if (!byId.has(p.id)) byId.set(p.id, p);
                });

                setPosts(Array.from(byId.values()));
              }
            }
          }
        } catch (contribCatch) {
          console.error("Error while loading contributed info pages", contribCatch);
        }

        // community threads created by this user
        try {
          const { data: threadRows, error: threadErr } = await supabase
            .from("forum_threads")
            .select("id, category_id, title, slug, created_at, last_post_at, reply_count, view_count, is_deleted")
            .eq("created_by", resolvedUserId)
            .eq("is_deleted", false)
            .order("created_at", { ascending: false })
            .limit(200);

          if (threadErr) {
            console.error("Failed to load community threads", threadErr);
          } else {
            const tRows = (threadRows ?? []) as Array<{
              id: number;
              category_id: number;
              title: string;
              slug: string;
              created_at: string;
              last_post_at: string | null;
              reply_count: number;
              view_count: number;
            }>;

            const catIds = Array.from(
              new Set(tRows.map((t) => t.category_id).filter((n) => Number.isFinite(n)))
            );
            const catSlugById = new Map<number, string>();
            if (catIds.length > 0) {
              const { data: cats } = await supabase.from("forum_categories").select("id, slug").in("id", catIds);
              (cats ?? []).forEach((c) => {
                const row = c as { id: number; slug: string };
                catSlugById.set(row.id, row.slug);
              });
            }

            const mappedThreads: CommunityThread[] = tRows
              .map((t) => ({
                id: t.id,
                title: t.title,
                slug: t.slug,
                categorySlug: catSlugById.get(t.category_id) ?? "",
                createdAt: t.created_at,
                lastPostAt: t.last_post_at,
                replyCount: t.reply_count ?? 0,
                viewCount: t.view_count ?? 0,
              }))
              .filter((t) => t.categorySlug.length > 0);

            setCommunityThreads(mappedThreads);
          }
        } catch (threadCatch) {
          console.error("Error while loading community threads", threadCatch);
        }

        // recent replies by this user (posts with a parent)
        try {
          const { data: replyRows, error: replyErr } = await supabase
            .from("forum_posts")
            .select("id, thread_id, parent_post_id, created_at, body_markdown, is_deleted")
            .eq("created_by", resolvedUserId)
            .not("parent_post_id", "is", null)
            .eq("is_deleted", false)
            .order("created_at", { ascending: false })
            .limit(200);

          if (replyErr) {
            console.error("Failed to load recent replies", replyErr);
          } else {
            const rRows = (replyRows ?? []) as Array<{
              id: number;
              thread_id: number;
              created_at: string;
              body_markdown: string | null;
            }>;

            const threadIds = Array.from(new Set(rRows.map((r) => r.thread_id).filter((n) => Number.isFinite(n))));
            const threadById = new Map<number, { title: string; slug: string; category_id: number }>();
            if (threadIds.length > 0) {
              const { data: threads2 } = await supabase
                .from("forum_threads")
                .select("id, title, slug, category_id, is_deleted")
                .in("id", threadIds)
                .eq("is_deleted", false);

              (threads2 ?? []).forEach((t) => {
                const row = t as { id: number; title: string; slug: string; category_id: number };
                threadById.set(row.id, { title: row.title, slug: row.slug, category_id: row.category_id });
              });
            }

            const catIds2 = Array.from(new Set(Array.from(threadById.values()).map((t) => t.category_id)));
            const catSlugById2 = new Map<number, string>();
            if (catIds2.length > 0) {
              const { data: cats2 } = await supabase.from("forum_categories").select("id, slug").in("id", catIds2);
              (cats2 ?? []).forEach((c) => {
                const row = c as { id: number; slug: string };
                catSlugById2.set(row.id, row.slug);
              });
            }

            const mappedReplies: RecentReply[] = rRows
              .map((r) => {
                const th = threadById.get(r.thread_id);
                if (!th) return null;
                const catSlug = catSlugById2.get(th.category_id) ?? "";
                if (!catSlug) return null;
                const body = r.body_markdown ?? "";
                const excerpt = body.length > 220 ? body.slice(0, 220) + "…" : body;
                return {
                  id: r.id,
                  threadId: r.thread_id,
                  threadTitle: th.title,
                  threadSlug: th.slug,
                  categorySlug: catSlug,
                  createdAt: r.created_at,
                  excerpt,
                } as RecentReply;
              })
              .filter((x): x is RecentReply => !!x);

            setRecentReplies(mappedReplies);
          }
        } catch (replyCatch) {
          console.error("Error while loading recent replies", replyCatch);
        }

        // keep base set (authored pages) for cases where contrib fetch doesn't merge
        setPosts(mapped);

        // garage cars
        try {
          let query = supabase
            .from("garage_cars")
            .select(
              "id, owner_id, name, make, model, year, chassis, trim, color, engine, power_hp, torque_ftlb, weight_lb, use_type, visibility, is_primary, summary, mods, cover_image_url, created_at, updated_at"
            )
            .eq("owner_id", resolvedUserId);

          if (!isSelf) {
            query = query.in("visibility", ["public", "unlisted"]);
          }

          const { data: garageData, error: garageError } = await query
            .order("is_primary", { ascending: false })
            .order("created_at", { ascending: false });

          if (garageError) {
            console.error("Failed to load user garage cars", garageError);
          } else {
            setGarageCars((garageData ?? []) as GarageCarRow[]);
          }
        } catch (garageErr) {
          console.error("Error while loading garage cars", garageErr);
        } finally {
          setGarageLoaded(true);
        }
      } catch (e) {
        console.error("Unexpected error loading user profile", e);
        setError("Unexpected error loading user data.");
      } finally {
        setLoading(false);
      }
    };

    void load();
  }, [
    resolvedUserId,
    viewerId,
    iBlockedThem,
    theyBlockedMe,
    blocksLoading,
    blocksViewerIsStaff,
    reloadNonce,
    loadedViaApi,
  ]);

  // block/unblock handler
  const handleToggleBlock = async () => {
    if (!profile || !resolvedUserId) return;

    if (!viewerId) {
      setBlockError("You must be logged in to block users.");
      return;
    }

    if (viewerId === resolvedUserId) {
      setBlockError("You cannot block yourself.");
      return;
    }

    setBlockError(null);
    setBlockLoading(true);

    try {
      const supabase = supabaseBrowser();
      const {
        data: { session },
        error: sessionError,
      } = await supabase.auth.getSession();

      if (sessionError || !session?.access_token) {
        setBlockError("You must be logged in to block users.");
        setBlockLoading(false);
        return;
      }

      const nextShouldBlock = !iBlockedThem;

      const res = await fetch(`/api/forum/users/${resolvedUserId}/block`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ block: nextShouldBlock }),
      });

      const payload = (await res.json().catch(() => null)) as
        | { ok?: boolean; blocked?: boolean; error?: string }
        | null;

      if (!res.ok || !payload?.ok) {
        console.error("Failed to toggle block", payload);
        setBlockError(payload?.error ?? "Failed to update block.");
        setBlockLoading(false);
        return;
      }

      const nowBlocked = !!payload.blocked;
      setBlockedLocal(resolvedUserId, nowBlocked);

      // If we just unblocked, reload the page content
      if (!nowBlocked) setReloadNonce((n) => n + 1);

      setBlockLoading(false);
    } catch (err) {
      console.error("Unexpected error toggling block on profile", err);
      setBlockError("Unexpected error updating block state.");
      setBlockLoading(false);
    }
  };

  const handleMessageUser = async () => {
    if (!viewerId) {
      setMessageError("You must be logged in to send messages.");
      return;
    }
    if (!resolvedUserId) {
      setMessageError("User not found.");
      return;
    }
    if (viewerId === resolvedUserId) {
      setMessageError("You cannot message yourself.");
      return;
    }

    // DM privacy: no bypass. If either block exists, don’t allow.
    if (iBlockedThem || theyBlockedMe) {
      setMessageError("You can’t message this user because one of you has blocked the other.");
      return;
    }

    setMessageError(null);
    setMessageLoading(true);
    try {
      const supabase = supabaseBrowser();
      const { data, error } = await supabase.rpc("dm_get_or_create_thread", {
        p_other_user_id: resolvedUserId,
      });

      if (error) {
        console.error("dm_get_or_create_thread failed", error);
        setMessageError("Failed to start message thread.");
        setMessageLoading(false);
        return;
      }

      const threadId = typeof data === "string" ? data : null;
      if (!threadId) {
        setMessageError("Failed to start message thread.");
        setMessageLoading(false);
        return;
      }

      router.push(`/messages/${encodeURIComponent(threadId)}`);
    } catch (e: unknown) {
      console.error("dm start unexpected", e);
      setMessageError("Failed to start message thread.");
    } finally {
      setMessageLoading(false);
    }
  };

  // derived role
  const rankLabel = useMemo(() => {
    if (!role) return "Member";
    const lower = role.toLowerCase();
    if (lower === "admin") return "Admin";
    if (lower === "moderator" || lower === "mod") return "Moderator";
    if (lower === "support") return "Support";
    return "Member";
  }, [role]);

  const rankChipClasses = useMemo(() => {
    const lower = (role ?? "member").toLowerCase();
    if (lower === "admin") return "border-rose-500 bg-rose-500/20 text-rose-300";
    if (lower === "moderator" || lower === "mod")
      return "border-emerald-500 bg-emerald-500/20 text-emerald-200";
    if (lower === "support") return "border-sky-400 bg-sky-500/20 text-sky-300";
    return "border-zinc-600 bg-black/40 text-brand-textMuted";
  }, [role]);

  const displayName = profile?.display_name?.trim() || profile?.username || "User";
  const usernameLabel =
    profile?.username && profile.username.trim().length > 0 ? `@${profile.username}` : null;

  const createdLabel = profile?.created_at
    ? new Date(profile.created_at).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
      })
    : "—";

  const lastSeenDate = profile?.last_seen_at ? new Date(profile.last_seen_at) : null;
  const isActive = lastSeenDate != null && INITIAL_NOW - lastSeenDate.getTime() <= 60 * 1000;

  const lastSeenLabel = profile?.last_seen_at
    ? new Date(profile.last_seen_at).toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
      })
    : "—";

  const isSelfProfile = !!(viewerId && profile && viewerId === profile.id);

  // ✅ Correct block visibility rule:
  // Staff must be able to view/moderate everyone, even if blocks exist.
  const canViewContent = isSelfProfile || viewerIsStaffEffective || (!iBlockedThem && !theyBlockedMe);

  // chip tokens
  const textTokens = useMemo(() => {
    const raw = fragment.trim().toLowerCase();
    if (!raw) return [] as string[];
    return raw.split(/\s+/).map((p) => p.trim()).filter(Boolean);
  }, [fragment]);

  const tagTokens = useMemo(
    () => committedTerms.map((t) => t.trim().toLowerCase()).filter((t) => t.length > 0),
    [committedTerms]
  );

  const allHighlightTokens = useMemo(
    () => Array.from(new Set([...textTokens, ...tagTokens])),
    [textTokens, tagTokens]
  );

  const threadTokens = useMemo(
    () =>
      Array.from(
        new Set(
          threadCommittedTerms
            .map((t) => t.trim().toLowerCase())
            .filter((t) => t.length > 0)
        )
      ),
    [threadCommittedTerms]
  );

  const replyTokens = useMemo(
    () =>
      Array.from(
        new Set(
          replyCommittedTerms
            .map((t) => t.trim().toLowerCase())
            .filter((t) => t.length > 0)
        )
      ),
    [replyCommittedTerms]
  );

  const filteredCommunityThreads = useMemo(() => {
    if (communityThreads.length === 0) return [] as CommunityThread[];
    if (threadTokens.length === 0) return communityThreads;
    return communityThreads.filter((t) => {
      const hay = `${t.title} ${t.categorySlug} ${t.slug}`.toLowerCase();
      return threadTokens.some((tok) => hay.includes(tok));
    });
  }, [communityThreads, threadTokens]);

  const visibleCommunityThreads = useMemo(
    () => filteredCommunityThreads.slice(0, threadVisibleCount),
    [filteredCommunityThreads, threadVisibleCount]
  );

  const filteredRecentReplies = useMemo(() => {
    if (recentReplies.length === 0) return [] as RecentReply[];
    if (replyTokens.length === 0) return recentReplies;
    return recentReplies.filter((r) => {
      const hay = `${r.threadTitle} ${r.excerpt} ${r.categorySlug} ${r.threadSlug}`.toLowerCase();
      return replyTokens.some((tok) => hay.includes(tok));
    });
  }, [recentReplies, replyTokens]);

  const visibleRecentReplies = useMemo(
    () => filteredRecentReplies.slice(0, replyVisibleCount),
    [filteredRecentReplies, replyVisibleCount]
  );

  const scoredPosts = useMemo(() => {
    if (posts.length === 0) return [] as { post: UserPost; score: number }[];

    const hasTokens = textTokens.length > 0 || tagTokens.length > 0;
    if (!hasTokens) {
      return posts.map((post, index) => ({ post, score: 1000 - index }));
    }

    const scoreOne = (post: UserPost): number => {
      let score = 0;
      const title = (post.title ?? "").toLowerCase();
      for (const t of textTokens) if (t && title.includes(t)) score += 20;

      const tags = (post.tags ?? []).map((x) => (x ?? "").toLowerCase());
      const category = (post.category ?? "").toLowerCase();
      const chassis = (post.chassis ?? "").toLowerCase();
      for (const t of tagTokens) {
        if (!t) continue;
        if (tags.some((x) => x.includes(t))) score += 16;
        if (category.includes(t)) score += 14;
        if (chassis.includes(t)) score += 14;
      }

      const excerpt = (post.excerpt ?? "").toLowerCase();
      for (const t of textTokens) if (t && excerpt.includes(t)) score += 6;

      return score;
    };

    const scored = posts.map((post) => ({ post, score: scoreOne(post) })).filter((x) => x.score > 0);
    scored.sort((a, b) => b.score - a.score);
    return scored;
  }, [posts, textTokens, tagTokens]);

  const visiblePosts = useMemo(
    () => scoredPosts.slice(0, Math.max(1, visibleCount)),
    [scoredPosts, visibleCount]
  );

  // garage derived
  const hasGarageCars = garageLoaded && garageCars.length > 0;
  const primaryCar = hasGarageCars ? garageCars.find((c) => c.is_primary) : null;
  const otherCars = hasGarageCars ? garageCars.filter((c) => !c.is_primary) : [];

  // chip handlers
  const handleFragmentChange = (e: ChangeEvent<HTMLInputElement>) => {
    setFragment(e.target.value);
    setVisibleCount(5);
  };

  const commitChip = (term: string) => {
    const t = term.trim();
    if (!t) return;
    setCommittedTerms((prev) => Array.from(new Set([...prev, t])));
    setFragment("");
    setVisibleCount(5);
  };

  const handleFragmentKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (fragment.trim().length > 0) commitChip(fragment);
    }
    if (e.key === "Backspace" && fragment.length === 0 && committedTerms.length > 0) {
      const last = committedTerms[committedTerms.length - 1];
      setCommittedTerms((prev) => prev.slice(0, -1));
      setFragment(last);
      setVisibleCount(5);
    }
  };

  const handleRemoveChip = (term: string) => {
    setCommittedTerms((prev) => prev.filter((x) => x !== term));
    setVisibleCount(5);
  };

  const handleThreadFragmentChange = (e: ChangeEvent<HTMLInputElement>) => {
    setThreadFragment(e.target.value);
    setThreadVisibleCount(5);
  };

  const handleThreadFragmentKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "Enter" && e.key !== ",") return;
    e.preventDefault();
    const term = threadFragment.trim();
    if (!term) return;
    setThreadCommittedTerms((prev) => (prev.includes(term) ? prev : [...prev, term]));
    setThreadFragment("");
    setThreadVisibleCount(5);
  };

  const handleRemoveThreadChip = (term: string) => {
    setThreadCommittedTerms((prev) => prev.filter((t) => t !== term));
    setThreadVisibleCount(5);
  };

  const handleReplyFragmentChange = (e: ChangeEvent<HTMLInputElement>) => {
    setReplyFragment(e.target.value);
    setReplyVisibleCount(5);
  };

  const handleReplyFragmentKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "Enter" && e.key !== ",") return;
    e.preventDefault();
    const term = replyFragment.trim();
    if (!term) return;
    setReplyCommittedTerms((prev) => (prev.includes(term) ? prev : [...prev, term]));
    setReplyFragment("");
    setReplyVisibleCount(5);
  };

  const handleRemoveReplyChip = (term: string) => {
    setReplyCommittedTerms((prev) => prev.filter((t) => t !== term));
    setReplyVisibleCount(5);
  };

  // render guards
  if (resolveLoading) {
    return (
      <div className="mx-auto max-w-6xl px-4 py-10 text-sm text-brand-textMuted">Loading user…</div>
    );
  }

  if (loading) {
    return (
      <div className="mx-auto max-w-6xl px-4 py-10 text-sm text-brand-textMuted">Loading profile…</div>
    );
  }

  if (requiresLogin) {
    return (
      <div className="mx-auto max-w-6xl px-4 py-10">
        <div className="rounded-xl border border-zinc-800/80 bg-black/30 p-5">
          <h1 className="text-base font-semibold text-brand-text">This profile requires login</h1>
          <p className="mt-2 text-sm text-brand-textMuted">Please sign in to view user profiles.</p>
          <div className="mt-4 flex flex-wrap gap-2">
            <Link
              href={`/auth/login?next=${encodeURIComponent(`/user/${rawId ?? ""}`)}`}
              className="inline-flex items-center justify-center rounded-full border border-amber-400/70 bg-amber-500/15 px-4 py-2 text-sm text-amber-200 hover:bg-amber-500/25"
            >
              Sign in
            </Link>
            <Link
              href="/auth/signup"
              className="inline-flex items-center justify-center rounded-full border border-zinc-700 bg-black/40 px-4 py-2 text-sm text-brand-textMuted hover:border-amber-400/60 hover:text-brand-text"
            >
              Create account
            </Link>
          </div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="mx-auto max-w-6xl px-4 py-10">
        <div className="rounded-xl border border-zinc-800/80 bg-black/30 p-4 text-sm text-rose-200">
          {error}
        </div>
      </div>
    );
  }

  if (!profile) {
    return (
      <div className="mx-auto max-w-6xl px-4 py-10 text-sm text-brand-textMuted">User not found.</div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-8 text-brand-text">
      <div className="relative w-full">
        <div className="mx-auto w-full max-w-3xl space-y-6">
          {/* Header / profile block */}
          <section className="relative w-full">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              {/* Left: avatar + identity */}
              <div className="flex min-w-0 items-start gap-4">
                <div className="h-14 w-14 shrink-0 overflow-hidden rounded-full border border-zinc-700 bg-black/50">
                  {profile.avatar_url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={profile.avatar_url}
                      alt={displayName}
                      className="h-full w-full object-cover"
                    />
                  ) : (
                    <div className="flex h-full w-full items-center justify-center text-sm text-brand-textMuted">
                      {displayName.slice(0, 2).toUpperCase()}
                    </div>
                  )}
                </div>

                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h1 className="inline-flex items-center text-xl font-semibold tracking-tight sm:text-2xl">
                      {displayName}
                      {profile?.is_verified ? <VerifiedBadge className="ml-2 h-4 w-4" /> : null}
                      {profile?.donation_rank ? (
                        <DonationBadge rank={profile.donation_rank} className="ml-0.5 h-4 w-4" />
                      ) : null}
                    </h1>
                    {usernameLabel && <span className="text-[12px] text-brand-textMuted">{usernameLabel}</span>}
                  </div>

                  <div className="flex flex-wrap items-center gap-2 text-[11px]">
                    <RolePill role={role} sizeClassName="text-[11px]" />

                    <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 font-medium text-amber-100">
                      <span>Karma</span>
                      <span>•</span>
                      <span>{profile.karma ?? 0}</span>
                    </span>

                    {canViewContent && isActive && (
                      <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/60 bg-emerald-500/15 px-2 py-0.5 text-[11px] text-emerald-200">
                        <span className="text-[10px]">●</span>
                        <span>Active</span>
                      </span>
                    )}
                  </div>

                  {canViewContent && profile.location && (
                    <p className="mt-0.5 inline-flex items-center gap-2 text-[11px] text-brand-textMuted">
                      <FontAwesomeIcon icon={faLocationDot} className="text-[11px]" />
                      <span>{profile.location}</span>
                    </p>
                  )}

                  {canViewContent && profile.bio && (
                    <p className="mt-1 max-w-2xl text-[12px] text-brand-textMuted">{profile.bio}</p>
                  )}

                  <div className="mt-1 flex flex-wrap gap-3 text-[11px] text-brand-textMuted">
                    <span>
                      Joined <span className="text-brand-text font-medium">{createdLabel}</span>
                    </span>

                    {canViewContent && (
                      <span>
                        Last seen <span className="text-brand-text font-medium">{lastSeenLabel}</span>
                      </span>
                    )}

                    <span className="break-all text-xs text-brand-textMuted/80">
                      id: <span className="text-brand-text font-mono text-[11px]">{profile.id}</span>
                    </span>
                  </div>
                </div>
              </div>

              {/* Right: actions */}
              <div className="flex flex-nowrap items-center justify-start gap-2 whitespace-nowrap overflow-x-auto px-2 py-1 sm:justify-end sm:overflow-visible">
                {isSelfProfile && (
                  <Link
                    href="/account"
                    className="inline-flex items-center justify-center rounded-full border border-zinc-700 bg-black/40 px-3 py-1.5 text-[11px] text-brand-textMuted hover:border-amber-400/60 hover:text-brand-text"
                  >
                    Edit
                  </Link>
                )}

                {!isSelfProfile && viewerId && (
                  <button
                    type="button"
                    onClick={handleMessageUser}
                    disabled={messageLoading || iBlockedThem || theyBlockedMe}
                    className={
                      "inline-flex items-center justify-center rounded-full border px-3 py-1.5 text-[11px] " +
                      (iBlockedThem || theyBlockedMe
                        ? "border-zinc-700 bg-black/30 text-brand-textMuted opacity-60"
                        : "border-amber-400/70 bg-amber-500/15 text-amber-200 hover:bg-amber-500/25") +
                      (messageLoading ? " opacity-60" : "")
                    }
                    title={iBlockedThem || theyBlockedMe ? "Messaging is disabled due to blocks" : "Message"}
                  >
                    {messageLoading ? (
                      "Opening…"
                    ) : (
                      <span className="inline-flex items-center gap-2">
                        <FontAwesomeIcon icon={faPaperPlane} className="text-[12px]" />
                        <span>Message</span>
                      </span>
                    )}
                  </button>
                )}

                {!isSelfProfile && viewerId && (
                  <button
                    type="button"
                    onClick={handleToggleBlock}
                    disabled={blockLoading}
                    className={
                      "inline-flex items-center justify-center rounded-full border px-3 py-1.5 text-[11px] " +
                      (iBlockedThem
                        ? "border-zinc-600 bg-black/40 text-brand-textMuted hover:border-zinc-500"
                        : "border-rose-500/70 bg-rose-500/15 text-rose-200 hover:bg-rose-500/25") +
                      (blockLoading ? " opacity-60" : "")
                    }
                  >
                    {blockLoading ? (
                      "Updating…"
                    ) : (
                      <span className="inline-flex items-center gap-2">
                        <FontAwesomeIcon icon={faGavel} className="text-[12px]" />
                        <span>{iBlockedThem ? "Unblock user" : "Block user"}</span>
                      </span>
                    )}
                  </button>
                )}

                {!isSelfProfile && viewerId && (
                  <button
                    type="button"
                    onClick={() => setReportOpen(true)}
                    className="inline-flex items-center justify-center rounded-full border border-zinc-700 bg-black/40 px-3 py-1.5 text-[11px] text-brand-textMuted hover:border-zinc-500 hover:text-brand-text"
                  >
                    <span className="inline-flex items-center gap-2">
                      <FontAwesomeIcon icon={faHand} className="text-[12px]" />
                      <span>Report</span>
                    </span>
                  </button>
                )}
              </div>
            </div>
          </section>

          {(blockError || messageError) && (
            <div className="mt-2 space-y-1 text-left">
              {blockError && <p className="text-[10px] text-rose-300">{blockError}</p>}
              {messageError && <p className="text-[10px] text-rose-300">{messageError}</p>}
            </div>
          )}

          <ReportModal
            open={reportOpen && !!viewerId && !!resolvedUserId}
            title="Report user"
            description="This creates a private conversation with staff."
            targetType="user"
            targetId={resolvedUserId ?? ""}
            onClose={() => setReportOpen(false)}
          />

          {/* Main content */}
          <div className="space-y-4">
            {/* Privacy notice */}
            {!canViewContent && (
              <section className="rounded-xl border border-zinc-800/80 bg-black/30 p-4">
                <p className="text-[12px] text-brand-textMuted">
                  {iBlockedThem
                    ? "You blocked this user. Their content is hidden."
                    : "You can’t view this user’s content because they’ve blocked you."}
                </p>
              </section>
            )}

            {/* Workshop section */}
            {canViewContent && garageLoaded && garageCars.length > 0 && (
              <section className="space-y-3 rounded-xl border border-zinc-800/80 bg-black/30 p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <h2 className="text-sm font-semibold uppercase tracking-wide text-brand-textMuted">Workshop</h2>
                    <p className="text-[11px] text-brand-textMuted">
                      {garageCars.length} project{garageCars.length === 1 ? "" : "s"} shared by this user.
                    </p>
                  </div>
                </div>

                <div className="space-y-3">
                  {primaryCar && <ProfileGarageCarCard car={primaryCar} highlightPrimary />}
                  {otherCars.length > 0 && (
                    <div className="space-y-2">
                      {otherCars.map((car) => (
                        <ProfileGarageCarCard key={car.id} car={car} />
                      ))}
                    </div>
                  )}
                </div>
              </section>
            )}

            {/* Community threads */}
            {canViewContent && communityThreads.length > 0 && (
              <section className="space-y-3 rounded-xl border border-zinc-800/80 bg-black/30 p-4">
                <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                  <div>
                    <h2 className="text-sm font-semibold uppercase tracking-wide text-brand-textMuted">
                      Community Threads
                    </h2>
                    <p className="text-[11px] text-brand-textMuted">
                      Showing {Math.min(visibleCommunityThreads.length, filteredCommunityThreads.length)} of{" "}
                      {filteredCommunityThreads.length} thread
                      {filteredCommunityThreads.length === 1 ? "" : "s"}
                    </p>
                  </div>

                  <div className="w-full md:w-80">
                    <div className="flex min-h-8 flex-wrap items-center gap-1 rounded-md border border-zinc-700 bg-black/40 px-2 py-1 text-xs text-brand-text">
                      {threadCommittedTerms.map((term) => (
                        <button
                          key={term}
                          type="button"
                          onClick={() => handleRemoveThreadChip(term)}
                          className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-2 py-0.5 text-[11px] text-amber-200 border border-amber-400/60"
                        >
                          <span>{term}</span>
                          <span className="text-[10px]">✕</span>
                        </button>
                      ))}
                      <input
                        type="text"
                        value={threadFragment}
                        onChange={handleThreadFragmentChange}
                        onKeyDown={handleThreadFragmentKeyDown}
                        placeholder={threadCommittedTerms.length ? "Add more filters…" : "Search threads…"}
                        className="no-zoom-input flex-1 bg-transparent text-[11px] text-brand-text outline-none placeholder:text-brand-textMuted"
                      />
                    </div>
                    {threadTokens.length > 0 && (
                      <p className="mt-1 text-[10px] text-brand-textMuted">
                        Filtering by: <span className="text-brand-text">{threadTokens.join(", ")}</span>
                      </p>
                    )}
                  </div>
                </div>

                {filteredCommunityThreads.length === 0 ? (
                  <p className="text-[12px] text-brand-textMuted">No matching threads.</p>
                ) : (
                  <>
                    <div className="space-y-3">
                      {visibleCommunityThreads.map((t) => {
                        const createdLabel2 = new Date(t.createdAt).toLocaleDateString(undefined, {
                          month: "short",
                          day: "numeric",
                          year: "numeric",
                        });

                        const lastLabel = t.lastPostAt
                          ? new Date(t.lastPostAt).toLocaleDateString(undefined, {
                              month: "short",
                              day: "numeric",
                              year: "numeric",
                            })
                          : null;

                        return (
                          <Link
                            key={t.id}
                            href={`/community/${t.categorySlug}/${t.slug}`}
                            className="block rounded-lg border border-zinc-800/80 bg-black/40 p-4 text-sm text-brand-text transition hover:border-amber-400/80 hover:bg-black/60"
                          >
                            <div className="mb-1 flex items-start justify-between gap-2">
                              <h3 className="text-[13px] font-semibold text-brand-text">
                                {highlightText(t.title, threadTokens)}
                              </h3>
                              <span className="text-[10px] text-brand-textMuted">{createdLabel2}</span>
                            </div>

                            <div className="mt-2 flex items-center justify-between text-[11px] text-brand-textMuted">
                              <div className="flex items-center gap-4">
                                <span>
                                  <span className="text-brand-text">{t.replyCount}</span> replies
                                </span>
                                <span>
                                  <span className="text-brand-text">{t.viewCount}</span> views
                                </span>
                              </div>
                              {lastLabel ? <span>Latest: {lastLabel}</span> : <span />}
                            </div>
                          </Link>
                        );
                      })}
                    </div>

                    {visibleCommunityThreads.length >= filteredCommunityThreads.length ? null : (
                      <div className="mt-3 flex justify-center">
                        <button
                          type="button"
                          onClick={() => setThreadVisibleCount((prev) => prev + 5)}
                          className="inline-flex items-center justify-center rounded-full border border-zinc-700 bg-black/60 px-4 py-1.5 text-[12px] text-brand-textMuted hover:border-amber-400/80 hover:text-brand-text"
                        >
                          Show more ({Math.min(Math.max(filteredCommunityThreads.length - threadVisibleCount, 0), 5)} more)
                        </button>
                      </div>
                    )}
                  </>
                )}
              </section>
            )}

            {/* Recent replies */}
            {canViewContent && recentReplies.length > 0 && (
              <section className="space-y-3 rounded-xl border border-zinc-800/80 bg-black/30 p-4">
                <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                  <div>
                    <h2 className="text-sm font-semibold uppercase tracking-wide text-brand-textMuted">
                      Recent Replies
                    </h2>
                    <p className="text-[11px] text-brand-textMuted">
                      Showing {Math.min(visibleRecentReplies.length, filteredRecentReplies.length)} of{" "}
                      {filteredRecentReplies.length} repl
                      {filteredRecentReplies.length === 1 ? "y" : "ies"}
                    </p>
                  </div>

                  <div className="w-full md:w-80">
                    <div className="flex min-h-8 flex-wrap items-center gap-1 rounded-md border border-zinc-700 bg-black/40 px-2 py-1 text-xs text-brand-text">
                      {replyCommittedTerms.map((term) => (
                        <button
                          key={term}
                          type="button"
                          onClick={() => handleRemoveReplyChip(term)}
                          className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-2 py-0.5 text-[11px] text-amber-200 border border-amber-400/60"
                        >
                          <span>{term}</span>
                          <span className="text-[10px]">✕</span>
                        </button>
                      ))}
                      <input
                        type="text"
                        value={replyFragment}
                        onChange={handleReplyFragmentChange}
                        onKeyDown={handleReplyFragmentKeyDown}
                        placeholder={replyCommittedTerms.length ? "Add more filters…" : "Search replies…"}
                        className="no-zoom-input flex-1 bg-transparent text-[11px] text-brand-text outline-none placeholder:text-brand-textMuted"
                      />
                    </div>
                    {replyTokens.length > 0 && (
                      <p className="mt-1 text-[10px] text-brand-textMuted">
                        Filtering by: <span className="text-brand-text">{replyTokens.join(", ")}</span>
                      </p>
                    )}
                  </div>
                </div>

                {filteredRecentReplies.length === 0 ? (
                  <p className="text-[12px] text-brand-textMuted">No matching replies.</p>
                ) : (
                  <>
                    <div className="space-y-3">
                      {visibleRecentReplies.map((r) => {
                        const createdLabel3 = new Date(r.createdAt).toLocaleDateString(undefined, {
                          month: "short",
                          day: "numeric",
                          year: "numeric",
                        });

                        return (
                          <Link
                            key={r.id}
                            href={`/community/${r.categorySlug}/${r.threadSlug}#post-${r.id}`}
                            className="block rounded-lg border border-zinc-800/80 bg-black/40 p-4 text-sm text-brand-text transition hover:border-amber-400/80 hover:bg-black/60"
                          >
                            <div className="mb-1 flex items-start justify-between gap-2">
                              <div className="min-w-0">
                                <h3 className="truncate text-[13px] font-semibold text-brand-text">
                                  {highlightText(r.threadTitle, replyTokens)}
                                </h3>
                                <p className="mt-1 text-[11px] text-brand-textMuted">
                                  {highlightText(truncateText(r.excerpt, 200), replyTokens)}
                                </p>
                              </div>
                              <span className="shrink-0 text-[10px] text-brand-textMuted">{createdLabel3}</span>
                            </div>
                          </Link>
                        );
                      })}
                    </div>

                    {visibleRecentReplies.length >= filteredRecentReplies.length ? null : (
                      <div className="mt-3 flex justify-center">
                        <button
                          type="button"
                          onClick={() => setReplyVisibleCount((prev) => prev + 5)}
                          className="inline-flex items-center justify-center rounded-full border border-zinc-700 bg-black/60 px-4 py-1.5 text-[12px] text-brand-textMuted hover:border-amber-400/80 hover:text-brand-text"
                        >
                          Show more ({Math.min(Math.max(filteredRecentReplies.length - replyVisibleCount, 0), 5)} more)
                        </button>
                      </div>
                    )}
                  </>
                )}
              </section>
            )}

            {/* User posts / chip + text search */}
            {canViewContent && posts.length > 0 && (
              <section className="space-y-3 rounded-xl border border-zinc-800/80 bg-black/30 p-4">
                <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                  <div>
                    <h2 className="text-sm font-semibold uppercase tracking-wide text-brand-textMuted">
                      Info pages
                    </h2>
                    {scoredPosts.length > 0 && (
                      <p className="text-[11px] text-brand-textMuted">
                        Showing {visiblePosts.length} of {scoredPosts.length} page
                        {scoredPosts.length === 1 ? "" : "s"}
                      </p>
                    )}
                  </div>

                  <div className="w-full md:w-80">
                    <div className="flex min-h-8 flex-wrap items-center gap-1 rounded-md border border-zinc-700 bg-black/40 px-2 py-1 text-xs text-brand-text">
                      {committedTerms.map((term) => (
                        <button
                          key={term}
                          type="button"
                          onClick={() => handleRemoveChip(term)}
                          className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-2 py-0.5 text-[11px] text-amber-200 border border-amber-400/60"
                        >
                          <span>{term}</span>
                          <span className="text-[10px]">✕</span>
                        </button>
                      ))}
                      <input
                        type="text"
                        value={fragment}
                        onChange={handleFragmentChange}
                        onKeyDown={handleFragmentKeyDown}
                        placeholder={committedTerms.length ? "Add more filters…" : "Type to search title/tags…"}
                        className="no-zoom-input flex-1 bg-transparent text-[11px] text-brand-text outline-none placeholder:text-brand-textMuted"
                      />
                    </div>
                    {allHighlightTokens.length > 0 && (
                      <p className="mt-1 text-[10px] text-brand-textMuted">
                        Filtering by: <span className="text-brand-text">{allHighlightTokens.join(", ")}</span>
                      </p>
                    )}
                  </div>
                </div>

                {scoredPosts.length === 0 ? (
                  <p className="text-[12px] text-brand-textMuted">No matching info pages.</p>
                ) : (
                  <>
                    <div className="space-y-3">
                      {visiblePosts.map(({ post }) => {
                        const createdLabel4 = new Date(post.createdAt).toLocaleDateString(undefined, {
                          month: "short",
                          day: "numeric",
                          year: "numeric",
                        });

                        return (
                          <Link
                            key={post.id}
                            href={`/projects/${post.slug}`}
                            className="block rounded-lg border border-zinc-800/80 bg-black/40 p-4 text-sm text-brand-text transition hover:border-amber-400/80 hover:bg-black/60"
                          >
                            <div className="mb-1 flex items-start justify-between gap-2">
                              <div className="min-w-0 flex items-center gap-2">
                                <h3 className="truncate text-[13px] font-semibold text-brand-text">
                                  {highlightText(post.title, allHighlightTokens)}
                                </h3>
                                {post.is_author ? (
                                  <span className="inline-flex shrink-0 items-center rounded-full border border-amber-400/40 bg-amber-500/10 px-2 py-0.5 text-[10px] text-amber-200">
                                    Author
                                  </span>
                                ) : null}
                                {post.is_contributor ? (
                                  <span className="inline-flex shrink-0 items-center rounded-full border border-sky-400/40 bg-sky-500/10 px-2 py-0.5 text-[10px] text-sky-200">
                                    Contributor
                                  </span>
                                ) : null}
                              </div>
                              <span className="shrink-0 text-[10px] text-brand-textMuted">{createdLabel4}</span>
                            </div>

                            <p className="text-[11px] text-brand-textMuted">
                              {highlightText(truncateText(post.excerpt, 200), allHighlightTokens)}
                            </p>

                            <div className="mt-1 flex flex-wrap gap-1 text-[10px]">
                              {post.category && (
                                <span className="rounded-full border border-zinc-700 bg-black/40 px-2 py-0.5 text-brand-textMuted">
                                  {highlightText(post.category, allHighlightTokens)}
                                </span>
                              )}
                              {post.chassis && (
                                <span className="rounded-full border border-zinc-700 bg-black/40 px-2 py-0.5 text-brand-textMuted">
                                  {highlightText(post.chassis.toUpperCase(), allHighlightTokens)}
                                </span>
                              )}
                              {post.tags.slice(0, 4).map((tag) => (
                                <span
                                  key={`${post.id}-${tag}`}
                                  className="rounded-full border border-zinc-700 bg-black/40 px-2 py-0.5 text-brand-textMuted"
                                >
                                  {highlightText(tag, allHighlightTokens)}
                                </span>
                              ))}
                              {post.tags.length > 4 && (
                                <span className="text-[10px] text-brand-textMuted">
                                  +{post.tags.length - 4} more
                                </span>
                              )}
                            </div>
                          </Link>
                        );
                      })}
                    </div>

                    {visiblePosts.length >= scoredPosts.length ? null : (
                      <div className="mt-3 flex justify-center">
                        <button
                          type="button"
                          onClick={() => setVisibleCount((prev) => prev + 5)}
                          className="inline-flex items-center justify-center rounded-full border border-zinc-700 bg-black/60 px-4 py-1.5 text-[12px] text-brand-textMuted hover:border-amber-400/80 hover:text-brand-text"
                        >
                          Show more ({Math.min(Math.max(scoredPosts.length - visibleCount, 0), 5)} more)
                        </button>
                      </div>
                    )}
                  </>
                )}
              </section>
            )}
          </div>
        </div>

        {viewerCanModerate && !isSelfProfile && !targetIsStaff && (
          <aside className="mt-6 lg:mt-0 lg:absolute lg:top-0 lg:left-1/2 lg:ml-[408px] lg:w-80">
            <div className="w-full rounded-xl border border-zinc-800/80 bg-black/40 p-3 text-left">
              <div className="flex items-center justify-between gap-2">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-brand-textMuted">Staff Tools</p>
                {restrLoading ? (
                  <span className="text-[10px] text-brand-textMuted">Loading…</span>
                ) : restrError ? (
                  <span className="text-[10px] text-rose-300">{restrError}</span>
                ) : null}
              </div>

              <div className="mt-3 space-y-2">
                <div className="flex flex-wrap gap-2">
                  {(["site", "community", "dm"] as const).map((kind) => {
                    const r = activeRestrictions.find((x) => String(x.kind) === kind) ?? null;
                    const label = kind === "site" ? "Temp banned" : kind === "community" ? "Community" : "DM";
                    const status = r ? (r.expires_at ? `until ${formatUntil(r.expires_at)}` : "active") : "none";

                    return (
                      <span
                        key={kind}
                        className={
                          "rounded-full border px-2 py-0.5 text-[10px] " +
                          (r
                            ? "border-amber-400/40 bg-amber-500/10 text-amber-200"
                            : "border-zinc-700/70 bg-black/20 text-brand-textMuted")
                        }
                      >
                        {label}: {status}
                      </span>
                    );
                  })}
                </div>

                {targetIsStaff ? null : (
                  <>
                    <button
                      type="button"
                      disabled={moderationBusy}
                      onClick={() => {
                        const r = activeRestrictions.find((x) => String(x.kind) === "site") ?? null;
                        if (r) {
                          void clearRestriction("site");
                          return;
                        }

                        const raw = window.prompt("Tempban (site) — hours", "24");
                        if (raw === null) return;
                        const n = Number(raw.trim());
                        if (Number.isFinite(n) && n > 0) void setRestriction("site", n);
                      }}
                      className="w-full rounded-lg border border-zinc-700/70 bg-black/30 px-3 py-2 text-[11px] text-brand-textMuted hover:border-amber-400/70 hover:text-brand-text disabled:opacity-60"
                    >
                      {(() => {
                        const r = activeRestrictions.find((x) => String(x.kind) === "site") ?? null;
                        if (!r) {
                          return (
                            <>
                              <span className="block">Tempban</span>
                              <span className="mt-0.5 block text-[10px] text-brand-textMuted">Currently: none</span>
                            </>
                          );
                        }
                        return (
                          <>
                            <span className="block">Clear tempban</span>
                            <span className="mt-0.5 block text-[10px] text-brand-textMuted">
                              Currently: {r.expires_at ? `until ${formatUntil(r.expires_at)}` : "active"}
                            </span>
                          </>
                        );
                      })()}
                    </button>

                    <button
                      type="button"
                      disabled={moderationBusy}
                      onClick={() => {
                        const r = activeRestrictions.find((x) => String(x.kind) === "community") ?? null;
                        if (r) {
                          void clearRestriction("community");
                          return;
                        }

                        const raw = window.prompt("Community ban (hours, blank = permanent)", "24");
                        if (raw === null) return;
                        const trimmed = raw.trim();
                        if (!trimmed.length) {
                          void setRestriction("community", null);
                          return;
                        }
                        const n = Number(trimmed);
                        if (Number.isFinite(n) && n > 0) void setRestriction("community", n);
                      }}
                      className="w-full rounded-lg border border-zinc-700/70 bg-black/30 px-3 py-2 text-[11px] text-brand-textMuted hover:border-amber-400/70 hover:text-brand-text disabled:opacity-60"
                    >
                      {(() => {
                        const r = activeRestrictions.find((x) => String(x.kind) === "community") ?? null;
                        if (!r) {
                          return (
                            <>
                              <span className="block">Restrict community</span>
                              <span className="mt-0.5 block text-[10px] text-brand-textMuted">Currently: none</span>
                            </>
                          );
                        }
                        return (
                          <>
                            <span className="block">Clear community restriction</span>
                            <span className="mt-0.5 block text-[10px] text-brand-textMuted">
                              Currently: {r.expires_at ? `until ${formatUntil(r.expires_at)}` : "active"}
                            </span>
                          </>
                        );
                      })()}
                    </button>

                    <button
                      type="button"
                      disabled={moderationBusy}
                      onClick={() => {
                        const r = activeRestrictions.find((x) => String(x.kind) === "dm") ?? null;
                        if (r) {
                          void clearRestriction("dm");
                          return;
                        }

                        const raw = window.prompt("DM ban (hours, blank = permanent)", "24");
                        if (raw === null) return;
                        const trimmed = raw.trim();
                        if (!trimmed.length) {
                          void setRestriction("dm", null);
                          return;
                        }
                        const n = Number(trimmed);
                        if (Number.isFinite(n) && n > 0) void setRestriction("dm", n);
                      }}
                      className="w-full rounded-lg border border-zinc-700/70 bg-black/30 px-3 py-2 text-[11px] text-brand-textMuted hover:border-amber-400/70 hover:text-brand-text disabled:opacity-60"
                    >
                      {(() => {
                        const r = activeRestrictions.find((x) => String(x.kind) === "dm") ?? null;
                        if (!r) {
                          return (
                            <>
                              <span className="block">Restrict DM</span>
                              <span className="mt-0.5 block text-[10px] text-brand-textMuted">Currently: none</span>
                            </>
                          );
                        }
                        return (
                          <>
                            <span className="block">Clear DM restriction</span>
                            <span className="mt-0.5 block text-[10px] text-brand-textMuted">
                              Currently: {r.expires_at ? `until ${formatUntil(r.expires_at)}` : "active"}
                            </span>
                          </>
                        );
                      })()}
                    </button>

                    <button
                      type="button"
                      disabled={moderationBusy || banStatusLoading}
                      onClick={() => void togglePermBan()}
                      className={
                        "w-full rounded-lg border px-3 py-2 text-[11px] disabled:opacity-60 " +
                        (isPermanentlyBanned
                          ? "border-emerald-500/60 bg-emerald-500/10 text-emerald-200 hover:bg-emerald-500/15"
                          : "border-rose-500/60 bg-rose-500/10 text-rose-200 hover:bg-rose-500/15")
                      }
                    >
                      {isPermanentlyBanned ? "Unban" : viewerRoleLower === "admin" ? "Ban" : "Request perm ban"}
                    </button>
                  </>
                )}

                {moderationMsg && <p className="text-[10px] text-brand-textMuted">{moderationMsg}</p>}
              </div>
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}

// Compact card used on the user profile page for garage cars
function ProfileGarageCarCard({ car, highlightPrimary }: { car: GarageCarRow; highlightPrimary?: boolean }) {
  const title =
    car.name ||
    [car.year, car.make, car.model, car.chassis ? `(${car.chassis.toUpperCase()})` : null]
      .filter(Boolean)
      .join(" ");

  const subtitle = [car.engine, car.color, car.trim].filter(Boolean).join(" • ");

  const hpLabel = car.power_hp != null && car.power_hp > 0 ? `${car.power_hp} hp` : null;
  const tqLabel = car.torque_ftlb != null && car.torque_ftlb > 0 ? `${car.torque_ftlb} ft-lb` : null;
  const wtLabel = car.weight_lb != null && car.weight_lb > 0 ? `${car.weight_lb} lb` : null;

  const useLabel = car.use_type ? `${car.use_type.charAt(0).toUpperCase()}${car.use_type.slice(1)}` : null;

  const meta = [hpLabel, tqLabel, wtLabel, useLabel].filter(Boolean).join(" • ");
  const href = `/workshop/${car.id}`;

  return (
    <Link
      href={href}
      className={
        "block rounded-lg border bg-black/40 p-4 transition hover:bg-black/60 " +
        (highlightPrimary
          ? "border-amber-400/80 hover:border-amber-400"
          : "border-zinc-800/80 hover:border-amber-400/50")
      }
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate text-[13px] font-semibold text-brand-text">{title || "Untitled car"}</h3>
          {subtitle && <p className="mt-0.5 text-[11px] text-brand-textMuted">{subtitle}</p>}
          {meta && <p className="mt-1 text-[10px] text-brand-textMuted">{meta}</p>}
          {car.summary && <p className="mt-2 text-[11px] text-brand-textMuted line-clamp-2">{car.summary}</p>}
        </div>

        {car.cover_image_url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={car.cover_image_url}
            alt={title || "Car"}
            className="h-16 w-20 flex-shrink-0 rounded-md border border-zinc-800 object-cover"
          />
        ) : (
          <div className="h-16 w-20 flex-shrink-0 rounded-md border border-zinc-800 bg-black/30" />
        )}
      </div>

      {highlightPrimary && (
        <div className="mt-3 inline-flex items-center gap-1 rounded-full border border-amber-400/60 bg-amber-500/15 px-2 py-0.5 text-[10px] text-amber-200">
          Primary
        </div>
      )}
    </Link>
  );
}
