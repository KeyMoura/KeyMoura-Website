// app/community/[slug]/[threadSlug]/page.tsx
"use client";

import * as React from "react";
import {FormEvent, useEffect, useMemo, useState, useRef, useCallback} from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { VerifiedBadge } from "@/components/VerifiedBadge";
import { DonationBadge } from "@/components/DonationBadge";
import { RolePill } from "@/components/RolePill";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faShareFromSquare, faSquarePollHorizontal, faReply } from "@fortawesome/free-solid-svg-icons";
import { useParams, useRouter } from "next/navigation";
import { supabaseBrowser } from "@/lib/supabaseClient";
import { MenuSelect } from "@/components/ui/MenuSelect";
import { useBlocks } from "@/components/BlocksProvider";
import { MarkdownEditor } from "@/components/MarkdownEditor";
import { MarkdownContent } from "@/components/MarkdownContent";
import ReportModal from "@/components/ReportModal";
import { useThreadPostsLoader } from "@/hooks/useThreadPostsLoader";
import MiniProfileModal, { type MiniProfileUser } from "@/components/MiniProfileModal";
import { useMeAccess } from "@/lib/hooks/useMeAccess";

const cn = (...classes: Array<string | false | null | undefined>) =>
  classes.filter(Boolean).join(" ");

// IMPORTANT:
// Do NOT use Tailwind `space-y-*` for post stacking.
// `space-y` creates *margins between siblings*, which breaks the continuous vertical connector
// (the spine can't draw through margins), and makes the "last reply" look lower/unconnected.
// We use per-item `pb-*` instead so the connector can extend through the spacing.
const POST_STACK_ITEM_PB = "pb-3";

// Slightly larger spacing between sibling replies inside a reply-chain.
// Tweak this if you want tighter/looser reply-to-reply spacing (only affects nested replies).
const REPLY_STACK_ITEM_PB = "pb-3";



// If a top-level reply has more than this many total descendant replies,
// start that reply's subtree collapsed by default (users can expand with the existing +/- rail).
const AUTO_COLLAPSE_REPLY_LIMIT = 8;
function useCanHover(): boolean {
  const [canHover, setCanHover] = React.useState(false);

  React.useEffect(() => {
    const mq = window.matchMedia("(hover: hover) and (pointer: fine)");
    const update = () => setCanHover(!!mq.matches);
    update();
    mq.addEventListener?.("change", update);
    return () => mq.removeEventListener?.("change", update);
  }, []);

  return canHover;
}

// Tailwind's `md` breakpoint is 768px.
// We only use this for small client-side layout decisions (reply gutter math).
function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = React.useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const mql = window.matchMedia("(max-width: 767px)");
    const apply = () => setIsMobile(Boolean(mql.matches));
    apply();

    // Safari < 14 uses addListener/removeListener.
    if (typeof mql.addEventListener === "function") {
      mql.addEventListener("change", apply);
      return () => mql.removeEventListener("change", apply);
    }
    mql.addListener(apply);
    return () => mql.removeListener(apply);
  }, []);

  return isMobile;
}


type LoadState = "idle" | "loading" | "loaded" | "error";

type ForumCategoryRow = {
  id: number;
  slug: string;
  name: string;
  description: string | null;
  is_archived: boolean;
  created_at: string;
  parent_id: number | null;
};

type ForumThreadRow = {
  id: number;
  category_id: number;
  title: string;
  slug: string;
  created_at: string;
  updated_at: string | null;
  created_by: string;
  last_post_at: string | null;
  last_post_by: string | null;
  reply_count: number;
  view_count: number;
  is_locked: boolean;
  is_pinned: boolean;
  is_deleted: boolean;
  accepted_post_id: number | null;
  locked_by: string | null;
  locked_at: string | null;
  locked_reason: string | null;
  tags: string[] | null;
};

export type ForumPostRow = {
  id: number;
  thread_id: number;
  parent_post_id: number | null;
  created_at: string;
  updated_at: string | null;
  created_by: string;
  body_markdown: string;
  is_deleted: boolean;
  edit_reason: string | null;
  // Optional vote counters (present if selected)
  vote_score?: number | null;
  upvote_count?: number | null;
  downvote_count?: number | null;
};

type ProfileRow = {
  id: string;
  username: string | null;
  display_name: string | null;
  avatar_url?: string | null;
  karma?: number | null;
  is_verified?: boolean | null;
  donation_rank?: string | null;
  bio?: string | null;
  last_seen_at?: string | null;
};

type PostNode = ForumPostRow & {
  children: PostNode[];
};

// Voting
export type VoteValue = -1 | 0 | 1;


// ---------- role helpers ----------
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

// ---------- @mention helpers ----------
type MentionSuggestion = {
  id: string;
  username: string;
  display_name: string | null;
  avatar_url: string | null;
  is_verified?: boolean | null;
  donation_rank?: string | null;
};

function extractMentions(text: string): string[] {
  const s = (text ?? "").toLowerCase();
  if (!s) return [];
  const re = /(^|[^a-zA-Z0-9_\.])@([a-zA-Z0-9_\.]{2,32})\b/g;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    const u = (m[2] ?? "").trim();
    if (u) out.push(u);
  }
  return Array.from(new Set(out));
}

function postMentionsUsername(text: string, username: string): boolean {
  const u = (username ?? "").trim().toLowerCase();
  if (!u) return false;

  const s = (text ?? "").toLowerCase();
  if (!s) return false;

  // boundary-safe: avoid matching inside emails/words
  const re = new RegExp(`(^|[^a-zA-Z0-9_\.])@${u}\\b`, "i");
  return re.test(s);
}


function renderMentionsToReact(text: string, makeHref: (username: string) => string): React.ReactNode[] {
  const s = text ?? "";
  if (!s) return [s];

  const re = /(^|[^a-zA-Z0-9_\.])@([a-zA-Z0-9_\.]{2,32})\b/g;

  const out: React.ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;

  while ((m = re.exec(s))) {
    const fullStart = m.index;
    const prefix = m[1] ?? "";
    const uname = m[2] ?? "";
    const atStart = fullStart + prefix.length;

    if (atStart > last) out.push(s.slice(last, atStart));
    if (prefix) out.push(prefix);

    const usernameLower = uname.toLowerCase();
    const href = makeHref(usernameLower);

    out.push(
      <Link
        key={`${atStart}-${usernameLower}`}
        href={href}
        className="inline-flex items-center rounded-md px-1 text-amber-300 underline underline-offset-2 transition hover:bg-amber-500/15 hover:text-amber-200 hover:no-underline focus:outline-none focus:ring-2 focus:ring-amber-400/40"
        onClick={(e) => e.stopPropagation()}
        title={`View @${usernameLower}`}
      >
        @{uname}
      </Link>
    );

    last = atStart + 1 + uname.length;
  }

  if (last < s.length) out.push(s.slice(last));
  return out;
}

function MentionText({
  text,
  makeHref,
  className,
}: {
  text: string;
  makeHref: (username: string) => string;
  className?: string;
}) {
  return <div className={className ?? ""}>{renderMentionsToReact(text, makeHref)}</div>;
}

async function resolveMentionUsers(usernames: string[]) {
  const list = Array.from(new Set((usernames ?? []).map((u) => u.toLowerCase())))
    .filter(Boolean)
    .slice(0, 50);

  if (list.length === 0) return [];

  const supabase = supabaseBrowser();
  const { data, error } = await supabase.from("profiles").select("id, username").in("username", list);

  if (error) {
    console.error("resolveMentionUsers failed", error);
    return [];
  }

  return (data ?? []) as { id: string; username: string }[];
}

async function validateMentionsAgainstBlocks(args: {
  text: string;
  currentUserId: string | null;
  blockedUserIds: Set<string>;
}): Promise<{ ok: true } | { ok: false; message: string }> {
  const { text, currentUserId, blockedUserIds } = args;

  const mentions = extractMentions(text);
  if (!currentUserId || mentions.length === 0) return { ok: true };

  const rows = await resolveMentionUsers(mentions);
  if (rows.length === 0) return { ok: true };

  const mentioned = rows.filter((r) => r.id && r.id !== currentUserId);
  if (mentioned.length === 0) return { ok: true };

  const youBlocked = mentioned.filter((m) => blockedUserIds.has(m.id));

  let theyBlocked: { id: string; username: string }[] = [];
  try {
    const supabase = supabaseBrowser();
    const ids = mentioned.map((m) => m.id);
    const { data, error } = await supabase
      .from("user_blocks")
      .select("blocker_user_id")
      .eq("blocked_user_id", currentUserId)
      .in("blocker_user_id", ids);

    if (!error && data?.length) {
      type ReverseBlockRow = { blocker_user_id: string | null };
      const blockers = new Set<string>((data as ReverseBlockRow[]).map((x) => String(x.blocker_user_id ?? "")));
      theyBlocked = mentioned.filter((m) => blockers.has(m.id));
    }
  } catch (e) {
    console.error("validateMentions reverse blocks failed", e);
  }

  const bad = new Map<string, string>();
  for (const u of youBlocked) bad.set(u.username, "You blocked this user");
  for (const u of theyBlocked) bad.set(u.username, "This user blocked you");

  if (bad.size === 0) return { ok: true };

  const badList = Array.from(bad.entries())
    .slice(0, 10)
    .map(([username, reason]) => `@${username} (${reason})`)
    .join(", ");

  return { ok: false, message: `Remove blocked mentions before posting: ${badList}` };
}

function useMentionAutocomplete(args: { currentUserId: string | null; blockedUserIds: Set<string> }) {
  const { currentUserId, blockedUserIds } = args;

  const [query, setQuery] = useState<string>("");
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<MentionSuggestion[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [loading, setLoading] = useState(false);
  const reqSeqRef = useRef(0);

  const fetchUsers = async (q: string) => {
    const trimmed = (q ?? "").trim().toLowerCase();
    console.log("fetchUsers", trimmed);

    const reqId = ++reqSeqRef.current;

    if (trimmed.length < 3) {
      if (reqId !== reqSeqRef.current) return;
      setItems([]);
      setOpen(false);
      setLoading(false);
      return;
    }

    setLoading(true);
    try {
      const supabase = supabaseBrowser();
      const { data, error } = await supabase
        .from("profiles")
        .select("id, username, display_name, avatar_url, is_verified, donation_rank")
        .ilike("username", `${trimmed}%`)
        .order("username", { ascending: true })
        .limit(5);

      if (error) {
        console.error("mention autocomplete query failed", error);
        if (reqId !== reqSeqRef.current) return;
        setItems([]);
        setOpen(false);
        setLoading(false);
        return;
      }

      let rows = (data ?? []) as MentionSuggestion[];
      rows = rows.filter((r) => !!r?.id && !!r?.username);

      let filtered = rows.filter((r) => {
        if (currentUserId && r.id === currentUserId) return false;
        if (blockedUserIds?.has(r.id)) return false;
        return true;
      });

      if (currentUserId && filtered.length > 0) {
        const ids = filtered.map((x) => x.id);

        const { data: reverseBlocks, error: rbErr } = await supabase
          .from("user_blocks")
          .select("blocker_user_id")
          .eq("blocked_user_id", currentUserId)
          .in("blocker_user_id", ids);

        if (!rbErr && reverseBlocks?.length) {
          type ReverseBlockRow = { blocker_user_id: string | null };
          const blockers = new Set<string>((reverseBlocks as ReverseBlockRow[]).map((x) => String(x.blocker_user_id ?? "")));
          filtered = filtered.filter((u) => !blockers.has(u.id));
        }
      }
      if (reqId !== reqSeqRef.current) return;

      setItems(filtered);
      setActiveIndex(0);
      setOpen(filtered.length > 0);
      setLoading(false);
    } catch (e) {
      console.error("mention autocomplete unexpected error", e);
      if (reqId !== reqSeqRef.current) return;
      setItems([]);
      setOpen(false);
      setLoading(false);
    }
  };

  return { query, setQuery, open, setOpen, items, activeIndex, setActiveIndex, loading, fetchUsers };
}

function MentionTextarea(props: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  rows?: number;
  disabled?: boolean;
  className?: string;
  makeUserHref: (username: string) => string;
  currentUserId: string | null;
  blockedUserIds: Set<string>;
}) {
  const { value, onChange, placeholder, rows = 4, disabled, className, makeUserHref, currentUserId, blockedUserIds } = props;

  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const ac = useMentionAutocomplete({ currentUserId, blockedUserIds });
  const [mentionStartIndex, setMentionStartIndex] = useState<number | null>(null);

  const close = () => {
    ac.setOpen(false);
    ac.setQuery("");
    setMentionStartIndex(null);
  };

  const getCursor = () => {
    const el = taRef.current;
    if (!el) return 0;
    return el.selectionStart ?? 0;
  };

  const replaceActiveMention = (username: string) => {
    const el = taRef.current;
    if (!el) return;

    const cursor = getCursor();
    const start = mentionStartIndex ?? cursor;

    const before = value.slice(0, start);
    const after = value.slice(cursor);
    const insert = `@${username} `;

    const next = before + insert + after;
    onChange(next);

    requestAnimationFrame(() => {
      const pos = (before + insert).length;
      el.focus();
      el.setSelectionRange(pos, pos);
    });

    close();
  };

  const handleKeyDown: React.KeyboardEventHandler<HTMLTextAreaElement> = (e) => {
    if (!ac.open) return;

    if (e.key === "Escape") {
      e.preventDefault();
      close();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      ac.setActiveIndex((i) => Math.min(i + 1, ac.items.length - 1));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      ac.setActiveIndex((i) => Math.max(i - 1, 0));
      return;
    }
    if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      const pick = ac.items[ac.activeIndex];
      if (pick?.username) replaceActiveMention(pick.username);
      return;
    }
  };

  const handleChange = async (next: string) => {
    onChange(next);

    const cursor = taRef.current?.selectionStart ?? next.length;
    const before = next.slice(0, cursor);
    const at = before.lastIndexOf("@");
    if (at === -1) {
      close();
      return;
    }

    const prev = at === 0 ? "" : before[at - 1];
    const boundaryOk = at === 0 || !/[a-zA-Z0-9_\.]/.test(prev);
    if (!boundaryOk) {
      close();
      return;
    }

    const fragment = before.slice(at + 1);
    if (/\s/.test(fragment)) {
      close();
      return;
    }

    setMentionStartIndex(at);
    ac.setQuery(fragment);
    await ac.fetchUsers(fragment);
  };

  return (
    <div className="relative">
      <MarkdownEditor
        value={value}
        onChange={(v) => void handleChange(v)}
        onKeyDown={handleKeyDown}
        textareaRef={taRef}
        placeholder={placeholder}
        rows={rows}
        disabled={disabled}
        className={className}
      />

      {ac.open && ac.items.length > 0 && (
        <div className="absolute left-0 right-0 top-full z-[9999] mt-1 w-full overflow-hidden rounded-xl border border-zinc-700 bg-zinc-950/95 shadow-xl backdrop-blur">
          <div className="max-h-56 overflow-auto p-1">
            {ac.items.map((u, idx) => {
              const active = idx === ac.activeIndex;
              return (
                <button
                  key={u.id}
                  type="button"
                  onMouseDown={(ev) => {
                    ev.preventDefault();
                    ev.stopPropagation();
                    replaceActiveMention(u.username);
                  }}
                  onMouseEnter={() => ac.setActiveIndex(idx)}
                  className={[
                    "flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-[12px]",
                    active ? "bg-amber-500/15 text-brand-text" : "text-brand-textMuted hover:bg-white/5 hover:text-brand-text",
                  ].join(" ")}
                >
                  <div className="h-7 w-7 shrink-0 overflow-hidden rounded-full border border-zinc-800 bg-black/30">
                    {u.avatar_url ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={u.avatar_url} alt="" className="h-full w-full object-cover" />
                    ) : (
                      <div className="flex h-full w-full items-center justify-center text-[11px] text-zinc-500">@</div>
                    )}
                  </div>

                  <div className="min-w-0">
                    <div className="truncate font-medium text-brand-text">@{u.username}</div>
                    <div className="truncate text-[11px] text-brand-textMuted">{u.display_name ?? ""}</div>
                  </div>

                  <div className="ml-auto shrink-0 text-[10px] text-zinc-500">↵</div>
                </button>
              );
            })}
          </div>

          <div className="border-t border-zinc-800 px-2 py-1 text-[10px] text-zinc-500">
            Mentions link to <span className="text-zinc-300">{makeUserHref("username")}</span>
          </div>
        </div>
      )}
    </div>
  );
}

export default function ThreadPage() {
  const { viewerId, viewerIsStaff, blockedUserIds, blockedByUserIds, setBlockedLocal } = useBlocks();
  const loadThreadPosts = useThreadPostsLoader();
  const params = useParams();
  const router = useRouter();
  const replyComposerRef = useRef<HTMLDivElement | null>(null);

  const categorySlug = String(params?.slug ?? "");
  const threadSlug = String(params?.threadSlug ?? "");
  const [highlightPostId, setHighlightPostId] = useState<number | null>(null);
  const jumpToPostId = (postId: number) => {
    if (typeof window === "undefined") return;
    window.location.hash = `#post-${postId}`;
    setHighlightPostId(postId);
    didAutoScrollRef.current = false;
  };
  const didAutoScrollRef = useRef(false);

  useEffect(() => {
    const readHash = () => {
      const hash = typeof window !== "undefined" ? window.location.hash : "";
      const m = /^#post-(\d+)$/.exec(hash);
      const raw = m ? Number(m[1]) : null;
      const next = typeof raw === "number" && Number.isFinite(raw) ? raw : null;
      setHighlightPostId(next);
      didAutoScrollRef.current = false;
    };

    readHash();

    // Hash changes triggered by the browser fire "hashchange" normally.
    // However, when Next.js updates the URL via history.pushState/replaceState
    // (e.g., clicking a notification while already on the thread), browsers do
    // not emit "hashchange". Hook history mutations so the highlight updates
    // immediately without requiring a refresh.
    const onHashOrHistory = () => readHash();

    const origPush = window.history.pushState;
    const origReplace = window.history.replaceState;

    window.history.pushState = function (...args: Parameters<History["pushState"]>) {
      // Avoid `any` casts while preserving the native signature.
      origPush.call(window.history, ...args);
      onHashOrHistory();
    };

    window.history.replaceState = function (...args: Parameters<History["replaceState"]>) {
      // Avoid `any` casts while preserving the native signature.
      origReplace.call(window.history, ...args);
      onHashOrHistory();
    };

    window.addEventListener("hashchange", onHashOrHistory);
    window.addEventListener("popstate", onHashOrHistory);

    return () => {
      window.removeEventListener("hashchange", onHashOrHistory);
      window.removeEventListener("popstate", onHashOrHistory);
      window.history.pushState = origPush;
      window.history.replaceState = origReplace;
    };
  }, [categorySlug, threadSlug]);


  const [state, setState] = useState<LoadState>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const [category, setCategory] = useState<ForumCategoryRow | null>(null);
  const [thread, setThread] = useState<ForumThreadRow | null>(null);
  const [posts, setPosts] = useState<ForumPostRow[]>([]);


type RecycleInfo = { daysLeft: number; expiresAt: string };

type RecycleBinLookupRow = {
  original_id: number;
  expires_at: string;
  restored_at: string | null;
};
  const [recycleInfoByPostId, setRecycleInfoByPostId] = useState<Record<string, RecycleInfo>>({});
  const [profilesById, setProfilesById] = useState<Map<string, ProfileRow>>(
    () => new Map()
  );
  const [rolesByUserId, setRolesByUserId] = useState<Map<string, string>>(
    () => new Map()
  );

  // Mini profile modal state (reusable across profile chips + @mentions)
  const [miniProfileOpen, setMiniProfileOpen] = useState(false);
  const [miniProfileUser, setMiniProfileUser] = useState<MiniProfileUser | null>(null);
  const miniProfileCacheRef = useRef<Map<string, MiniProfileUser>>(new Map());

  // Auth / ban / role / mod state
  const [isLoggedIn, setIsLoggedIn] = useState<boolean | null>(null);
  const [isBanned, setIsBanned] = useState<boolean>(false);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [currentUsername, setCurrentUsername] = useState<string | null>(null);
  const { data: access } = useMeAccess();
  const viewerPermissions = useMemo(() => new Set(access?.permissions ?? []), [access?.permissions]);

  // Reply collapsing state must live at the thread-page level so nested toggles persist.
  const [collapsedRepliesByPostId, setCollapsedRepliesByPostId] = useState<Record<number, boolean>>({});
  // When a reply group is auto-collapsed by our depth heuristic, we reveal it progressively.
  // We only show a small number of items at first unless the user explicitly "unhides" the group.
  const [autoCollapsedByPostId, setAutoCollapsedByPostId] = useState<Record<number, boolean>>({});
  const [revealChildCountByPostId, setRevealChildCountByPostId] = useState<Record<number, number>>({});
  const [userUnhiddenByPostId, setUserUnhiddenByPostId] = useState<Record<number, boolean>>({});
  const [hoverRailId, setHoverRailId] = useState<number | null>(null);

  // Reply sorting (top-level replies only).
  // Default is "Popular" (Top score).
  type ReplySort = "best" | "top" | "new" | "old" | "controversial";
  const [replySort, setReplySort] = useState<ReplySort>("best");


  // Blocked users are provided by BlocksProvider (cached globally)

  // Voting state
  const [myPostVotes, setMyPostVotes] = useState<Record<number, VoteValue>>({});
  const [isVotingByPostId, setIsVotingByPostId] = useState<Record<number, boolean>>({});
  const [voteErrorByPostId, setVoteErrorByPostId] = useState<Record<number, string>>({});

  // Reply composer
  const [replyBody, setReplyBody] = useState("");
  const [replyError, setReplyError] = useState<string | null>(null);
  const [postingReply, setPostingReply] = useState(false);

  // Inline reply composer (shown directly under the post being replied to)
  const [inlineReplyParentPostId, setInlineReplyParentPostId] = useState<number | null>(null);
  const [inlineReplyBody, setInlineReplyBody] = useState("");
  const [inlineReplyError, setInlineReplyError] = useState<string | null>(null);
  const [postingInlineReply, setPostingInlineReply] = useState(false);


  const [reportThreadOpen, setReportThreadOpen] = useState(false);
  const [reportUserOpen, setReportUserOpen] = useState(false);
  const [reportUserId, setReportUserId] = useState<string | null>(null);
  const [flagToast, setFlagToast] = useState<string | null>(null);

  // Thread control UI state
  const [threadActionError, setThreadActionError] = useState<string | null>(
    null
  );
  const [locking, setLocking] = useState(false);
  const [pinning, setPinning] = useState(false);
  const [updatingAnswer, setUpdatingAnswer] = useState(false);
  const [karmaFlashByUserId, setKarmaFlashByUserId] = useState<Record<string, number>>({});

  const threadUrl = `/community/${categorySlug}/${threadSlug}`;

  const handleFlag = async (targetType: "thread" | "post", targetId: string) => {
    try {
      setFlagToast(null);

      // Must be logged in to flag.
      const supabase = supabaseBrowser();
      const { data: sess } = await supabase.auth.getSession();
      if (!sess.session) {
        setFlagToast("Please sign in to flag content.");
        window.setTimeout(() => setFlagToast(null), 2500);
        router.push(`/auth/login?next=${encodeURIComponent(threadUrl)}`);
        return;
      }

      const reason = window.prompt("Optional: why are you flagging this? (spam, scam, harassment, etc.)") ?? "";
      const res = await fetch("/api/forum/flags", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${sess.session.access_token}`,
        },
        body: JSON.stringify({ targetType, targetId, reason }),
      });
      type FlagApiResponse = {
        error?: string;
        already?: boolean;
      };

      let data: FlagApiResponse | null = null;
      try {
        data = (await res.json()) as FlagApiResponse;
      } catch {
        data = null;
      }

      if (!res.ok) {
        setFlagToast(data?.error ?? "Failed to flag.");
        return;
      }
      setFlagToast(data?.already ? "Already flagged." : "Flag submitted.");
      window.setTimeout(() => setFlagToast(null), 2500);
    } catch {
      setFlagToast("Failed to flag.");
    }
  };

  
  const beginReplyToPost = (post: ForumPostRow) => {
    if (!thread) return;

    if (thread.is_locked) {
      setInlineReplyError("This thread is locked and cannot accept new replies.");
      return;
    }

    if (isBanned) {
      setInlineReplyError("You are banned and cannot reply.");
      return;
    }

    if (!currentUserId) {
      router.push(`/auth/login?next=${encodeURIComponent(threadUrl)}`);
      return;
    }

    setInlineReplyError(null);

    // Toggle the inline composer under this post.
    setInlineReplyParentPostId((prev) => (prev === post.id ? null : post.id));
    setInlineReplyBody("");

    // Bring the target post into view (so the inline composer is visible).
    requestAnimationFrame(() => {
      const el = document.getElementById(`post-${post.id}`);
      el?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  };

  const cancelInlineReply = () => {
    setInlineReplyParentPostId(null);
    setInlineReplyBody("");
    setInlineReplyError(null);
  };

  const bumpProfileKarma = (userId: string, delta: number) => {
    if (!userId || !delta) return;

    setProfilesById((prev) => {
      const next = new Map(prev);
      const p = next.get(userId);
      if (!p) return prev;
      const current = typeof p.karma === "number" ? p.karma : 0;
      next.set(userId, { ...p, karma: current + delta });
      return next;
    });

    // Flash animation (green for +, red for -)
    setKarmaFlashByUserId((prev) => ({ ...prev, [userId]: delta }));
    window.setTimeout(() => {
      setKarmaFlashByUserId((prev) => {
        if (!(userId in prev)) return prev;
        const { [userId]: _removed, ...rest } = prev;
        return rest;
      });
    }, 650);
  };

  const getKarmaFlash = (userId: string) => karmaFlashByUserId[userId] ?? 0;

  // --- Load auth / ban state ---
  useEffect(() => {
    const loadAuth = async () => {
      try {
        const supabase = supabaseBrowser();
        const { data: sessionData } = await supabase.auth.getSession();
        const user = sessionData.session?.user ?? null;

        if (!user) {
          setIsLoggedIn(false);
          setIsBanned(false);
          setCurrentUserId(null);
          setCurrentUsername(null);
          return;
        }

        setIsLoggedIn(true);
        setCurrentUserId(user.id);

        // username is used for @mention UI (e.g. "mentioned you")
        const { data: meProfile } = await supabase
          .from("profiles")
          .select("username")
          .eq("id", user.id)
          .maybeSingle<{ username: string | null }>();
        setCurrentUsername(meProfile?.username ?? null);


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
        setCurrentUserId(null);
      }
    };

    void loadAuth();
  }, []);

  // Keep currentUserId aligned with BlocksProvider viewerId (prevents double-sources)
  useEffect(() => {
    if (viewerId) setCurrentUserId(viewerId);
  }, [viewerId]);

  // --- Load category / thread / posts ---
  useEffect(() => {
    if (!categorySlug || !threadSlug) return;

    const load = async () => {
      setState("loading");
      setErrorMessage(null);

      try {
        const supabase = supabaseBrowser();

        // Prefer a server route for category/thread metadata so staff cannot be hidden
        // by member blocks (and to avoid relying on RLS for this view).
        const { data: sessionData } = await supabase.auth.getSession();
        const token = sessionData.session?.access_token ?? "";

        if (token) {
          const metaRes = await fetch("/api/forum/thread-meta", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({ categorySlug, threadSlug }),
          });

          const metaJson = (await metaRes.json().catch(() => null)) as unknown;
          const metaRec =
            metaJson && typeof metaJson === "object" && metaJson !== null
              ? (metaJson as Record<string, unknown>)
              : null;

          if (!metaRes.ok || !metaRec || metaRec.ok !== true) {
            const msg =
              metaRec && typeof metaRec.error === "string"
                ? metaRec.error
                : "Failed to load thread.";
            setErrorMessage(msg);
            setState("error");
            return;
          }

          setCategory((metaRec.category as unknown) as ForumCategoryRow);
          setThread((metaRec.thread as unknown) as ForumThreadRow);

          /** Preload profiles/roles for thread authors. */
          try {
            const map = new Map<string, ProfileRow>();
            const profilesValue = metaRec.profiles;
            for (const p of Array.isArray(profilesValue) ? profilesValue : []) {
              if (!p || typeof p !== "object") continue;
              const rec = p as Record<string, unknown>;
              const id = typeof rec.id === "string" ? rec.id : null;
              if (!id) continue;
              map.set(id, rec as unknown as ProfileRow);
            }
            if (map.size) setProfilesById(map);

            const rmap = new Map<string, string>();
            const rolesValue = metaRec.roles;
            for (const r of Array.isArray(rolesValue) ? rolesValue : []) {
              if (!r || typeof r !== "object") continue;
              const rec = r as Record<string, unknown>;
              const userId = typeof rec.user_id === "string" ? rec.user_id : null;
              const role = typeof rec.role === "string" ? rec.role : null;
              if (userId && role) rmap.set(userId, role);
            }
            if (rmap.size) setRolesByUserId(rmap);
          } catch {
            /** Ignored. */
          }

          const threadRow = (metaRec.thread as unknown) as ForumThreadRow;

          // 3) Posts for this thread (include deleted, we show tombstones)
          const { posts: postRows, error: postsErr } = await loadThreadPosts(threadRow.id);

          if (postsErr) {
            console.error("Failed to load posts", postsErr);
            setErrorMessage("Failed to load posts.");
            setState("error");
            return;
          }

          setPosts(postRows);

          // Continue with profile/role loading below (it may noop if already loaded)
          // and then mark loaded.

          // 4) Minimal profiles for thread + posts authors
          const userIds = new Set<string>();
          userIds.add(threadRow.created_by);
          if (threadRow.last_post_by) userIds.add(threadRow.last_post_by);
          for (const p of postRows) {
            if (p.created_by) userIds.add(p.created_by);
          }

          if (userIds.size > 0) {
            const ids = Array.from(userIds);

            const { data: profileData, error: profileErr } = await supabase
              .from("profiles")
              .select("id, username, display_name, avatar_url, karma, is_verified, donation_rank, bio, last_seen_at")
              .in("id", ids);

            if (profileErr) {
              console.error("Failed to load profiles for thread posts", profileErr);
            } else if (profileData) {
              const map = new Map<string, ProfileRow>();
              for (const p of profileData as ProfileRow[]) {
                map.set(p.id, p);
              }
              setProfilesById((prev) => {
                const next = new Map(prev);
                for (const [k, v] of map.entries()) next.set(k, v);
                return next;
              });
            }

            const { data: roleData, error: roleErr } = await supabase
              .from("user_roles")
              .select("user_id, role")
              .in("user_id", ids);

            if (roleErr) {
              console.error("Failed to load roles for thread posts", roleErr);
            } else {
              const map = new Map<string, string>();
              for (const r of (roleData ?? []) as { user_id: string; role: string }[]) {
                if (r?.user_id && r?.role) map.set(r.user_id, r.role);
              }
              setRolesByUserId((prev) => {
                const next = new Map(prev);
                for (const [k, v] of map.entries()) next.set(k, v);
                return next;
              });
            }
          }

          setState("loaded");
          return;
        }
        // Fallback: logged out (or no token) -> rely on client-side queries

        // 1) Category
        const {
          data: categoryRow,
          error: categoryErr,
        } = await supabase
          .from("forum_categories")
          .select("id, slug, name, description, is_archived, created_at, parent_id")
          .eq("slug", categorySlug)
          .maybeSingle<ForumCategoryRow>();

        if (categoryErr) {
          console.error("Failed to load forum category", categoryErr);
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

        // 2) Thread within this category
        const {
          data: threadRow,
          error: threadErr,
        } = await supabase
          .from("forum_threads")
          .select(
            "id, category_id, title, slug, created_at, updated_at, created_by, last_post_at, last_post_by, reply_count, view_count, is_locked, is_pinned, is_deleted, accepted_post_id, locked_by, locked_at, locked_reason, tags"
          )
          .eq("category_id", categoryRow.id)
          .eq("slug", threadSlug)
          .maybeSingle<ForumThreadRow>();

        if (threadErr) {
          console.error("Failed to load thread", threadErr);
          setErrorMessage("Failed to load thread.");
          setState("error");
          return;
        }

        if (!threadRow || threadRow.is_deleted) {
          setErrorMessage("Thread not found.");
          setState("error");
          return;
        }

        setThread(threadRow);

        // 3) Posts for this thread (include deleted, we show tombstones)
        const { posts: postRows, error: postsErr } = await loadThreadPosts(threadRow.id);

        if (postsErr) {
          console.error("Failed to load posts", postsErr);
          setErrorMessage("Failed to load posts.");
          setState("error");
          return;
        }

        setPosts(postRows);

        // 4) Minimal profiles for thread + posts authors
        const userIds = new Set<string>();
        userIds.add(threadRow.created_by);
        if (threadRow.last_post_by) userIds.add(threadRow.last_post_by);

        for (const p of postRows) {
          if (p.created_by) userIds.add(p.created_by);
        }

        if (userIds.size > 0) {
          const ids = Array.from(userIds);

          const { data: profileData, error: profileErr } = await supabase
            .from("profiles")
            .select("id, username, display_name, avatar_url, karma, is_verified, donation_rank, bio, last_seen_at")
            .in("id", ids);

          if (profileErr) {
            console.error("Failed to load profiles for thread posts", profileErr);
          } else if (profileData) {
            const map = new Map<string, ProfileRow>();
            for (const p of profileData as ProfileRow[]) {
              map.set(p.id, p);
            }
            setProfilesById(map);
          }

          // 5) Roles for thread + posts authors
          const { data: roleData, error: roleErr } = await supabase
            .from("user_roles")
            .select("user_id, role")
            .in("user_id", ids);

          if (roleErr) {
            console.error("Failed to load roles for thread posts", roleErr);
          } else {
            const map = new Map<string, string>();
            for (const r of (roleData ?? []) as { user_id: string; role: string }[]) {
              if (r?.user_id && r?.role) map.set(r.user_id, r.role);
            }
            setRolesByUserId(map);
          }
        }

        setState("loaded");
      } catch (err) {
        console.error("Unexpected error loading thread view", err);
        setErrorMessage("Unexpected error loading thread.");
        setState("error");
      }
    };

    void load();
  }, [categorySlug, loadThreadPosts, threadSlug]);

  useEffect(() => {
    if (!thread?.id) return;

    // Dedup per browser for 6 hours per thread
    const key = `thread_viewed_${thread.id}`;
    const now = Date.now();
    const last = Number(localStorage.getItem(key) ?? "0");
    const sixHours = 6 * 60 * 60 * 1000;

    if (last && now - last < sixHours) return;

    localStorage.setItem(key, String(now));

    void (async () => {
      try {
        const supabase = supabaseBrowser();
        const { error } = await supabase.rpc("increment_thread_view", {
          p_thread_id: thread.id,
        });

        if (error) {
          console.error("increment_thread_view failed", error);
        }
      } catch (e: unknown) {
        console.error("increment_thread_view unexpected error", e);
      }
    })();
  }, [thread?.id]);

  const acceptedPost = useMemo(() => {
    if (!thread || !thread.accepted_post_id) return null;
    return posts.find((p) => p.id === thread.accepted_post_id) ?? null;
  }, [thread, posts]);

  const leadPost = useMemo(() => {
    if (!thread) return null;

    const candidates = posts.filter(
      (p) =>
        !p.is_deleted &&
        p.parent_post_id === null &&
        p.created_by === thread.created_by
    );

    if (candidates.length === 0) return null;

    return candidates.reduce((earliest, current) => {
      const earliestTime = new Date(earliest.created_at).getTime();
      const currentTime = new Date(current.created_at).getTime();
      if (!Number.isFinite(earliestTime)) return current;
      if (!Number.isFinite(currentTime)) return earliest;
      return currentTime < earliestTime ? current : earliest;
    });
  }, [thread, posts]);

  const postsWithoutLead = useMemo(
    () => (leadPost ? posts.filter((p) => p.id !== leadPost.id) : posts),
    [leadPost, posts]
  );

// --- Load my votes for posts in this thread ---
useEffect(() => {
  const loadMyVotes = async () => {
    if (!currentUserId) {
      setMyPostVotes({});
      return;
    }
    if (!posts || posts.length === 0) {
      setMyPostVotes({});
      return;
    }

    try {
      const supabase = supabaseBrowser();
      const postIds = posts.map((p) => p.id);
      const { data, error } = await supabase
        .from("forum_post_votes")
        .select("post_id, value")
        .eq("voter_user_id", currentUserId)
        .in("post_id", postIds);

      if (error) {
        console.error("Failed to load my post votes", error);
        return;
      }

    type ForumPostVoteRow = {
      post_id: number | string;
      value: number | string;
    };

    const votes: Record<number, VoteValue> = {};

    const rows: ForumPostVoteRow[] = Array.isArray(data) ? (data as ForumPostVoteRow[]) : [];

    for (const row of rows) {
      const pid = Number(row.post_id);
      const valNum = Number(row.value);

      const val: VoteValue = valNum === 1 ? 1 : valNum === -1 ? -1 : 0;

      if (Number.isFinite(pid)) votes[pid] = val;
    }

    setMyPostVotes(votes);
    } catch (e) {
      console.error("Unexpected error loading my post votes", e);
    }
  };

  void loadMyVotes();
}, [currentUserId, posts]);

const canVoteForPost = (post: ForumPostRow): boolean => {
  if (!currentUserId) return false;
  if (isLoggedIn !== true) return false;
  if (isBanned) return false;
  if (post.is_deleted) return false;
  if (post.created_by === currentUserId) return false;
  if (!viewerIsStaff && blockedUserIds.has(post.created_by)) return false;
  return true;
};

const getScoreForPost = (post: ForumPostRow): number => {
  const v = post.vote_score;
  return typeof v === "number" ? v : 0;
};

const applyVote = async (postId: number, requested: VoteValue) => {
  if (!currentUserId) return;

  const prevVote = myPostVotes[postId] ?? 0;
  const nextValue: VoteValue = prevVote === requested ? 0 : requested;

  setIsVotingByPostId((s) => ({ ...s, [postId]: true }));
  setVoteErrorByPostId((s) => {
    const { [postId]: _removed, ...rest } = s;
    return rest;
  });

  try {
    const supabase = supabaseBrowser();
    const {
      data: { session },
      error: sessionError,
    } = await supabase.auth.getSession();

    if (sessionError || !session?.access_token) {
      setVoteErrorByPostId((s) => ({ ...s, [postId]: "You must be logged in to vote." }));
      return;
    }

    const res = await fetch(`/api/forum/posts/${postId}/vote`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${session.access_token}`,
      },
      body: JSON.stringify({ value: nextValue }),
    });

    type VoteApiResponse =
      | { ok: true; my_vote: VoteValue; post?: Partial<ForumPostRow> & { id: number } }
      | { ok: false; error: string };

    const json: VoteApiResponse | null = await res
      .json()
      .then((x: unknown) => x as VoteApiResponse)
      .catch(() => null);

    if (!res.ok || !json || json.ok === false) {
      const msg =
        json && json.ok === false && typeof json.error === "string"
          ? json.error
          : "Failed to vote.";
      setVoteErrorByPostId((s) => ({ ...s, [postId]: msg }));
      return;
    }

    // ok === true
    setMyPostVotes((s) => ({ ...s, [postId]: json.my_vote }));

    const targetPost = posts.find((p) => p.id === postId);
    if (targetPost) {
      const karmaDelta = (json.my_vote - prevVote) as number;
      bumpProfileKarma(targetPost.created_by, karmaDelta);
    }

    if (json.post && typeof json.post.id === "number") {
      const updated = json.post;
      setPosts((prev) =>
        prev.map((p) => (p.id === updated.id ? ({ ...p, ...updated } as ForumPostRow) : p))
      );
    }
  } catch (e) {
    console.error("Vote request failed", e);
    setVoteErrorByPostId((s) => ({ ...s, [postId]: "Vote failed. Please try again." }));
  } finally {
    setIsVotingByPostId((s) => ({ ...s, [postId]: false }));
  }
};

  const postTree = useMemo(
    () => buildPostTree(postsWithoutLead),
    [postsWithoutLead]
  );

  const sortedPostTree = useMemo(() => {
    if (!postTree || postTree.length <= 1) return postTree;

    const scoreOf = (n: PostNode) => (typeof n.vote_score === "number" ? n.vote_score : 0);
    const upOf = (n: PostNode) => (typeof n.upvote_count === "number" ? n.upvote_count : 0);
    const downOf = (n: PostNode) => (typeof n.downvote_count === "number" ? n.downvote_count : 0);
    const timeOf = (n: PostNode) => {
      const t = new Date(n.created_at).getTime();
      return Number.isFinite(t) ? t : 0;
    };

    // "Subtree karma" for sorting:
    // - The top-level reply itself counts as 2× weight.
    // - Any descendant reply counts as 1× weight.
    // This keeps "active" reply chains higher in the list without over-indenting the UI.
    const subtreeVotes = (root: PostNode) => {
      let up = upOf(root) * 2;
      let down = downOf(root) * 2;
      let score = scoreOf(root) * 2;

      const q: PostNode[] = [...(root.children ?? [])];
      while (q.length) {
        const n = q.shift()!;
        up += upOf(n);
        down += downOf(n);
        score += scoreOf(n);
        const kids = n.children ?? [];
        for (const k of kids) q.push(k);
      }

      return { up, down, score };
    };

    const list = [...postTree];

    // Reddit-style "Best" comment sort uses a confidence score (Wilson score interval)
    // to avoid tiny-sample comments floating above well-voted ones.
    const wilsonLowerBound = (up: number, down: number) => {
      const n = up + down;
      if (n <= 0) return 0;
      const z = 1.281551565545; // ~80% confidence (Reddit-ish)
      const phat = up / n;
      const z2 = z * z;
      return (
        (phat + z2 / (2 * n) - z * Math.sqrt((phat * (1 - phat) + z2 / (4 * n)) / n)) /
        (1 + z2 / n)
      );
    };

    list.sort((a, b) => {
      if (replySort === "best") {
        const aV = subtreeVotes(a);
        const bV = subtreeVotes(b);

        const aBest = wilsonLowerBound(aV.up, aV.down);
        const bBest = wilsonLowerBound(bV.up, bV.down);
        const d = bBest - aBest;
        if (d !== 0) return d;

        // Tie-breakers: score then recency.
        const sd = bV.score - aV.score;
        if (sd !== 0) return sd;
        return timeOf(b) - timeOf(a);
      }
      if (replySort === "new") {
        return timeOf(b) - timeOf(a);
      }
      if (replySort === "old") {
        return timeOf(a) - timeOf(b);
      }
      if (replySort === "top") {
        const aV = subtreeVotes(a);
        const bV = subtreeVotes(b);
        const d = bV.score - aV.score;
        if (d !== 0) return d;
        return timeOf(b) - timeOf(a);
      }
      // controversial: prefer threads with meaningful disagreement + activity.
      // If we have up/down counts, use min(up, down) then total votes as tiebreaker.
      const aV = subtreeVotes(a);
      const bV = subtreeVotes(b);
      const aUp = aV.up;
      const aDown = aV.down;
      const bUp = bV.up;
      const bDown = bV.down;

      const aMin = Math.min(aUp, aDown);
      const bMin = Math.min(bUp, bDown);

      const minDiff = bMin - aMin;
      if (minDiff !== 0) return minDiff;

      const aTotal = aUp + aDown;
      const bTotal = bUp + bDown;
      const totalDiff = bTotal - aTotal;
      if (totalDiff !== 0) return totalDiff;

      // Fallback to score magnitude then recency.
      const magDiff = Math.abs(bV.score) - Math.abs(aV.score);
      if (magDiff !== 0) return magDiff;

      return timeOf(b) - timeOf(a);
    });

    return list;
  }, [postTree, replySort]);

  // Build a lightweight parent/index map so we can unhide a specific comment when linked via #post-<id>.
  const postParentById = useMemo<{
    parent: Map<number, number | null>;
    indexInParent: Map<number, number>;
  }>(() => {
    const parent = new Map<number, number | null>();
    const indexInParent = new Map<number, number>();

    const walk = (nodes: PostNode[] | undefined, parentId: number | null) => {
      if (!nodes || nodes.length === 0) return;
      nodes.forEach((n, idx) => {
        parent.set(n.id, parentId);
        indexInParent.set(n.id, idx);
        walk(n.children as PostNode[] | undefined, n.id);
      });
    };

    walk(postTree, null);
    return { parent, indexInParent };
  }, [postTree]);

  const ensurePostVisible = useCallback(
    (targetPostId: number) => {
      const { parent, indexInParent } = postParentById;
      let cur: number | null | undefined = targetPostId;

      // Walk up to the root, expanding each ancestor so the target can render.
      while (cur != null) {
        const parentId: number | null = (parent.get(cur) as number | null | undefined) ?? null;
        if (parentId != null) {
          // Expand ancestor reply group
          // IMPORTANT: even if the key is undefined, the UI may still be collapsed via
          // autoCollapsedByPostId[parentId]. Force an explicit "false" so deep links
          // always uncollapse the path.
          setCollapsedRepliesByPostId((prev) => (prev[parentId] === false ? prev : { ...prev, [parentId]: false }));

          // If this parent is limiting visible children (auto-collapsed or reveal-limited),
          // ensure we render enough list items to include this path node.
          // This matters for deep links to hidden comments.
          const isRevealLimited = (revealChildCountByPostId[parentId] ?? 0) > 0;
          if ((autoCollapsedByPostId[parentId] || isRevealLimited) && !userUnhiddenByPostId[parentId]) {
            const idx = indexInParent.get(cur) ?? 0;
            setRevealChildCountByPostId((prev) => {
              const want = idx + 1;
              const curVal = prev[parentId] ?? 0;
              return want > curVal ? { ...prev, [parentId]: want } : prev;
            });
          }
        }
        cur = parentId;
      }
    },
    [postParentById, autoCollapsedByPostId, userUnhiddenByPostId, revealChildCountByPostId]
  );

  // When navigating directly to #post-<id>, make sure the post is visible even if it sits
  // inside an auto-collapsed reply group, and then scroll it into view.
  useEffect(() => {
    if (highlightPostId == null) return;

    // Expand just enough ancestors so the target can render.
    ensurePostVisible(highlightPostId);

    if (didAutoScrollRef.current) return;
    const targetId = `post-${highlightPostId}`;

    let attempts = 0;
    const maxAttempts = 12;

    const tryScroll = () => {
      attempts += 1;
      const el = document.getElementById(targetId);
      if (!el) {
        if (attempts < maxAttempts) requestAnimationFrame(tryScroll);
        return;
      }

      didAutoScrollRef.current = true;

      try {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
      } catch {
        // ignore
      }

      // Fallback: compute top offset and scroll the window directly.
      try {
        const rect = el.getBoundingClientRect();
        const top = rect.top + window.scrollY - 120;
        window.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
      } catch {
        // ignore
      }
    };

    requestAnimationFrame(tryScroll);

    const t = window.setTimeout(() => {
      if (!didAutoScrollRef.current) tryScroll();
    }, 350);

    return () => window.clearTimeout(t);
  }, [highlightPostId, posts.length, ensurePostVisible]);



  // Auto-collapse *parts* of large top-level reply subtrees so we still show the first N replies,
  // then the rest start collapsed using the existing +/- rail logic (no new UI).
  //
  // "Order" here matches what you described:
  // - show all direct replies first (depth 1, in array order)
  // - then grandchildren (depth 2), etc. (breadth-first by depth)
  useEffect(() => {
    if (!postTree || sortedPostTree.length === 0) return;

    setCollapsedRepliesByPostId((prev: Record<number, boolean>) => {
      const next: Record<number, boolean> = { ...prev };
      let changed = false;
      const newlyAutoCollapsed: number[] = [];

      for (const rootReply of postTree) {
        // Collapse low-scoring top-level replies by default (Reddit-like).
        // This uses the existing rail toggle (collapses that reply's subtree).
        const rootScore = typeof rootReply.vote_score === "number" ? rootReply.vote_score : 0;
        if (rootScore < -1 && typeof next[rootReply.id] === "undefined") {
          next[rootReply.id] = true;
          changed = true;
          newlyAutoCollapsed.push(rootReply.id);
        }

        const total = countDescendantReplies(rootReply);
        if (total <= AUTO_COLLAPSE_REPLY_LIMIT) continue;

        // Breadth-first list of ALL descendants under this rootReply, with parent tracking.
        type QItem = { node: PostNode; parentId: number };
        const ordered: Array<{ id: number; parentId: number }> = [];
        const q: QItem[] = [];

        const children: PostNode[] = rootReply.children ?? [];
        for (const c of children) q.push({ node: c, parentId: rootReply.id });

        while (q.length) {
          const { node, parentId } = q.shift()!;
          ordered.push({ id: node.id, parentId });

          const kids: PostNode[] = node.children ?? [];
          for (const k of kids) q.push({ node: k, parentId: node.id });
        }

        // Keep first N descendants visible.
        const keepIds = new Set<number>();
        for (let i = 0; i < Math.min(AUTO_COLLAPSE_REPLY_LIMIT, ordered.length); i += 1) {
          keepIds.add(ordered[i].id);
        }

        // Parents that are visible/rendered and can be collapsed to hide deeper nodes.
        // rootReply itself is rendered, even though it isn't a "descendant" in keepIds.
        const visibleParents = new Set<number>(keepIds);
        visibleParents.add(rootReply.id);

        // For every excluded node, collapse its parent (if that parent is visible) so the excluded node
        // doesn't render until user expands it using the existing rail.
        for (let i = AUTO_COLLAPSE_REPLY_LIMIT; i < ordered.length; i += 1) {
          const { parentId } = ordered[i];
          if (!visibleParents.has(parentId)) continue;

          // Only set a default if the user hasn't already toggled this parent.
          if (typeof next[parentId] === "undefined") {
            next[parentId] = true;
            changed = true;
            newlyAutoCollapsed.push(parentId);
          }
        }
      }

      if (newlyAutoCollapsed.length) {
        setAutoCollapsedByPostId((prevAuto) => {
          const nextAuto = { ...prevAuto };
          let autoChanged = false;
          for (const id of newlyAutoCollapsed) {
            if (!nextAuto[id]) {
              nextAuto[id] = true;
              autoChanged = true;
            }
          }
          return autoChanged ? nextAuto : prevAuto;
        });
      }

      return changed ? next : prev;
    });
  }, [postTree]);

  const getProfile = (userId: string | null | undefined): ProfileRow | null => {
    if (!userId) return null;
    return profilesById.get(userId) ?? null;
  };

  const getDisplayName = (userId: string | null | undefined): string => {
    if (!userId) return "Unknown user";
    const profile = getProfile(userId);
    if (!profile) return userId;
    return profile.display_name || profile.username || userId;
  };

  const getUserRole = (userId: string | null | undefined): string => {
    if (!userId) return "member";
    return rolesByUserId.get(userId) ?? "member";
  };

  const getUserHref = (userId: string | null | undefined): string => {
    if (!userId) return "/user/unknown";
    const p = getProfile(userId);
    if (p?.username) return `/user/@${p.username}`;
    return `/user/${userId}`;
  };

  const formatDateTime = (value: string | null): string => {
    if (!value) return "—";
    const d = new Date(value);
    return d.toLocaleString(undefined, {
      dateStyle: "short",
      timeStyle: "short",
    });
  };

  const closeMiniProfile = () => {
    setMiniProfileOpen(false);
    // Keep last user in state so reopening is instant.
  };

  const openMiniProfileByUserId = (userId: string | null | undefined) => {
    if (!userId) return;
    const p = getProfile(userId);
    const u: MiniProfileUser = {
      id: userId,
      username: p?.username ?? null,
      displayName: p?.display_name ?? null,
      avatarUrl: p?.avatar_url ?? null,
      isVerified: p?.is_verified ?? null,
      donationRank: p?.donation_rank ?? null,
      karma: p?.karma ?? null,
      role: getUserRole(userId),
      bio: p?.bio ?? null,
      lastSeenAt: p?.last_seen_at ?? null,
    };
    setMiniProfileUser(u);
    setMiniProfileOpen(true);
  };

  const openMiniProfileByUsername = async (usernameRaw: string) => {
    const username = (usernameRaw ?? "").trim();
    if (!username) return;
    const key = username.toLowerCase();

    // Fast path: a profile in the current thread already.
    for (const p of profilesById.values()) {
      if ((p.username ?? "").toLowerCase() === key) {
        openMiniProfileByUserId(p.id);
        return;
      }
    }

    // Cache (so repeated mentions don't spam the DB)
    const cached = miniProfileCacheRef.current.get(key);
    if (cached) {
      setMiniProfileUser(cached);
      setMiniProfileOpen(true);
      return;
    }

    // Load on-demand.
    setMiniProfileUser(null);
    setMiniProfileOpen(true);

    const supabase = supabaseBrowser();
    const { data: prof, error: profErr } = await supabase
      .from("profiles")
      .select("id, username, display_name, avatar_url, karma, is_verified, donation_rank, bio, last_seen_at")
      .ilike("username", username)
      .maybeSingle<{
        id: string;
        username: string | null;
        display_name: string | null;
        avatar_url: string | null;
        karma: number | null;
        is_verified: boolean | null;
        donation_rank: string | null;
        bio: string | null;
        last_seen_at: string | null;
      }>();

    if (profErr || !prof?.id) {
      // Keep the modal open, but show a basic fallback.
      const fallback: MiniProfileUser = {
        id: "",
        username,
        displayName: username,
        avatarUrl: null,
        isVerified: null,
        donationRank: null,
        karma: null,
        role: null,
      };
      setMiniProfileUser(fallback);
      return;
    }

    const { data: roleRow } = await supabase
      .from("user_roles")
      .select("role")
      .eq("user_id", prof.id)
      .maybeSingle<{ role: string }>();

    const loaded: MiniProfileUser = {
      id: prof.id,
      username: prof.username,
      displayName: prof.display_name,
      avatarUrl: prof.avatar_url,
      karma: prof.karma,
      isVerified: prof.is_verified,
      donationRank: prof.donation_rank,
      role: roleRow?.role ?? null,
      bio: prof.bio,
      lastSeenAt: prof.last_seen_at,
    };

    miniProfileCacheRef.current.set(key, loaded);
    setMiniProfileUser(loaded);
  };

  // Derived moderation permissions
  const isThreadOwner = !!(thread && currentUserId && thread.created_by === currentUserId);
  const canLockAny = viewerPermissions.has("community.lock_thread");
  const canLockOwn = viewerPermissions.has("community.thread.lock.own");
  const canPinThread = viewerPermissions.has("community.pin_thread");
  const canMarkAny = viewerPermissions.has("community.mark_answer");
  const canMarkOwn = viewerPermissions.has("community.thread.mark_answer.own");

  const canLockThread = !!(thread && currentUserId && (canLockAny || (isThreadOwner && canLockOwn)));
  const canMarkAnswers = !!(thread && currentUserId && (canMarkAny || (isThreadOwner && canMarkOwn)));



// Staff-only: show remaining restore time for soft-deleted posts that are still in the recycle bin.
useEffect(() => {
  if (!viewerIsStaff) {
    setRecycleInfoByPostId({});
    return;
  }

  const deletedIds = posts.filter((p) => p.is_deleted).map((p) => p.id);
  const key = deletedIds.join(",");
  if (!key) {
    setRecycleInfoByPostId({});
    return;
  }

  const supabase = supabaseBrowser();
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  let cancelled = false;

  const loadRecycleInfo = async () => {
    const { data, error } = await supabase
      .from("moderation_recycle_bin")
      .select("original_id, expires_at, restored_at")
      .eq("item_type", "post")
      .in("original_id", deletedIds)
      .is("restored_at", null)
      .gt("expires_at", nowIso);

    if (cancelled) return;
    if (error) {
      // Table/policy may not exist yet; fail silently.
      setRecycleInfoByPostId({});
      return;
    }

    const rows = (data ?? []) as RecycleBinLookupRow[];
    const map: Record<string, RecycleInfo> = {};
    for (const row of rows) {
      const originalId = String(row.original_id ?? "");
      const expiresAt = String(row.expires_at ?? "");
      const exp = new Date(expiresAt).getTime();
      if (!originalId || !Number.isFinite(exp)) continue;
      const daysLeft = Math.max(0, Math.ceil((exp - now) / (1000 * 60 * 60 * 24)));
      map[originalId] = { daysLeft, expiresAt };
    }
    setRecycleInfoByPostId(map);
  };

  void loadRecycleInfo();

  return () => {
    cancelled = true;
  };
}, [viewerIsStaff, posts.map((p) => `${p.id}:${p.is_deleted ? 1 : 0}`).join("|")]);

  // Update a single post in local state
  const handleLocalPostUpdated = (updated: ForumPostRow) => {
    setPosts((prev) => prev.map((p) => (p.id === updated.id ? updated : p)));
  };

  // --- Thread controls: lock/unlock ---
  const handleToggleLock = async () => {
    if (!thread) return;

    setThreadActionError(null);

    try {
      setLocking(true);

      const supabase = supabaseBrowser();
      const {
        data: { session },
        error: sessionError,
      } = await supabase.auth.getSession();

      if (sessionError || !session?.access_token) {
        setThreadActionError("You must be logged in to lock/unlock threads.");
        setLocking(false);
        return;
      }

      const res = await fetch(`/api/forum/threads/${thread.id}/lock`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          lock: !thread.is_locked,
          reason: !thread.is_locked ? "Locked via thread controls" : null,
        }),
      });

      const payload = (await res.json().catch(() => null)) as
        | { ok?: boolean; thread?: ForumThreadRow; error?: string }
        | null;

      if (!res.ok || !payload?.ok || !payload.thread) {
        console.error("Failed to toggle lock", payload);
        setThreadActionError(payload?.error ?? "Failed to update lock state.");
        setLocking(false);
        return;
      }

      setThread(payload.thread);
      setLocking(false);
    } catch (err) {
      console.error("Unexpected error toggling lock", err);
      setThreadActionError("Unexpected error updating lock state.");
      setLocking(false);
    }
  };

  // --- Thread controls: pin/unpin ---
  const handleTogglePin = async () => {
    if (!thread) return;

    setThreadActionError(null);

    try {
      setPinning(true);

      const supabase = supabaseBrowser();
      const {
        data: { session },
        error: sessionError,
      } = await supabase.auth.getSession();

      if (sessionError || !session?.access_token) {
        setThreadActionError("You must be logged in to pin/unpin threads.");
        setPinning(false);
        return;
      }

      const res = await fetch(`/api/forum/threads/${thread.id}/pin`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          pin: !thread.is_pinned,
        }),
      });

      const payload = (await res.json().catch(() => null)) as
        | { ok?: boolean; thread?: ForumThreadRow; error?: string }
        | null;

      if (!res.ok || !payload?.ok || !payload.thread) {
        console.error("Failed to toggle pin", payload);
        setThreadActionError(payload?.error ?? "Failed to update pin state.");
        setPinning(false);
        return;
      }

      setThread(payload.thread);
      setPinning(false);
    } catch (err) {
      console.error("Unexpected error toggling pin", err);
      setThreadActionError("Unexpected error updating pin state.");
      setPinning(false);
    }
  };

  // --- Thread controls: set/unset accepted answer (auto lock / unlock) ---
  const handleSetAcceptedPost = async (postId: number | null) => {
    if (!thread) return;

    const prevAccepted = thread.accepted_post_id ?? null;

    setThreadActionError(null);

    try {
      setUpdatingAnswer(true);

      const supabase = supabaseBrowser();
      const {
        data: { session },
        error: sessionError,
      } = await supabase.auth.getSession();

      if (sessionError || !session?.access_token) {
        setThreadActionError("You must be logged in to mark an answer.");
        setUpdatingAnswer(false);
        return;
      }

      const res = await fetch(`/api/forum/threads/${thread.id}/accept-answer`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ postId }),
      });

      const rawText = await res.text();
      let payload: { ok?: boolean; thread?: ForumThreadRow; error?: string } | null =
        null;

      try {
        payload = rawText
          ? (JSON.parse(rawText) as {
              ok?: boolean;
              thread?: ForumThreadRow;
              error?: string;
            })
          : null;
      } catch {
        payload = null;
      }

      if (!res.ok || !payload?.ok || !payload.thread) {
        console.error("Failed to update accepted answer", {
          status: res.status,
          rawText,
          parsed: payload,
        });
        setThreadActionError(
          payload?.error ?? `Failed to update accepted answer (status ${res.status}).`
        );
        setUpdatingAnswer(false);
        return;
      }

      // ✅ Update thread immediately
      setThread(payload.thread);

      const nextAccepted = postId ?? null;

      const prevPost = prevAccepted != null ? posts.find((p) => p.id === prevAccepted) : null;
      const nextPost = nextAccepted != null ? posts.find((p) => p.id === nextAccepted) : null;

      // If switching answers, remove from old
      if (prevAccepted != null && prevAccepted !== nextAccepted && prevPost) {
        bumpProfileKarma(prevPost.created_by, -3);
      }

      // If setting an answer (new or switch), add to new
      if (nextAccepted != null && prevAccepted !== nextAccepted && nextPost) {
        bumpProfileKarma(nextPost.created_by, 3);
      }

      setUpdatingAnswer(false);
    } catch (err) {
      console.error("Unexpected error updating accepted answer", err);
      setThreadActionError("Unexpected error updating accepted answer.");
      setUpdatingAnswer(false);
    }
  };

  // --- Block / unblock user (API) ---
  const handleToggleBlockUser = async (
    targetUserId: string,
    shouldBlock: boolean
  ) => {
    if (!currentUserId) {
      setThreadActionError("You must be logged in to block users.");
      return;
    }

    if (!targetUserId) {
      console.error("Missing targetUserId parameter in handleToggleBlockUser");
      setThreadActionError("Internal error blocking user.");
      return;
    }

    if (currentUserId === targetUserId) {
      setThreadActionError("You cannot block yourself.");
      return;
    }

    setThreadActionError(null);

    // Optimistic update so the UI reacts instantly (and stays in sync across pages)
    const prevWasBlocked = blockedUserIds.has(targetUserId);
    setBlockedLocal(targetUserId, shouldBlock);

    try {
      const supabase = supabaseBrowser();
      const {
        data: { session },
        error: sessionError,
      } = await supabase.auth.getSession();

      if (sessionError || !session?.access_token) {
        // rollback optimistic
        setBlockedLocal(targetUserId, prevWasBlocked);
        setThreadActionError("You must be logged in to block users.");
        return;
      }

      const url = `/api/forum/users/${encodeURIComponent(targetUserId)}/block`;

      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          block: shouldBlock,
        }),
      });

      const rawText = await res.text();
      let payload: { ok?: boolean; error?: string } | null = null;
      try {
        payload = rawText
          ? (JSON.parse(rawText) as { ok?: boolean; error?: string })
          : null;
      } catch {
        payload = null;
      }

      if (!res.ok || !payload?.ok) {
        console.error("Failed to toggle block", {
          status: res.status,
          rawText,
          parsed: payload,
        });
        // Roll back optimistic update on failure
        setBlockedLocal(targetUserId, prevWasBlocked);
        setThreadActionError(
          payload?.error ?? `Failed to update block (status ${res.status}).`
        );
        return;
      }

      // Server confirmed: nothing else to do (optimistic state already applied)
    } catch (err) {
      console.error("Unexpected error toggling block", err);
      // Roll back optimistic update on unexpected error
      setBlockedLocal(targetUserId, prevWasBlocked);
      setThreadActionError("Unexpected error updating block state.");
    }
  };

  
  const submitReply = async (opts: {
    parentPostId: number | null;
    body: string;
    setError: (v: string | null) => void;
    setPosting: (v: boolean) => void;
    onSuccess?: (newPostId: number) => void;
  }) => {
    const { parentPostId, body, setError, setPosting, onSuccess } = opts;

    setError(null);

    if (!thread) {
      setError("Thread not loaded.");
      return;
    }

    const trimmed = body.trim();
    if (!trimmed) {
      setError("Reply text is required.");
      return;
    }

    if (thread.is_locked) {
      setError("This thread is locked and cannot accept new replies.");
      return;
    }

    if (isBanned) {
      setError("You are banned and cannot reply.");
      return;
    }

    if (isLoggedIn === false) {
      router.push(`/auth/login?next=${encodeURIComponent(threadUrl)}`);
      return;
    }

    const mentionCheck = await validateMentionsAgainstBlocks({
      text: trimmed,
      currentUserId,
      blockedUserIds,
    });

    if (!mentionCheck.ok) {
      setError(mentionCheck.message);
      return;
    }

    try {
      setPosting(true);

      const supabase = supabaseBrowser();
      const {
        data: { session },
        error: sessionError,
      } = await supabase.auth.getSession();

      if (sessionError || !session?.access_token) {
        router.push(`/auth/login?next=${encodeURIComponent(threadUrl)}`);
        return;
      }

      const res = await fetch("/api/forum/posts/reply", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          threadId: thread.id,
          parentPostId,
          bodyMarkdown: trimmed,
        }),
      });

      const payload = (await res.json().catch(() => null)) as
        | { ok?: boolean; postId?: number; error?: string; createdAt?: string }
        | null;

      if (!res.ok || !payload?.ok || !payload?.postId) {
        setError(payload?.error ?? "Failed to post reply.");
        setPosting(false);
        return;
      }

      const createdAt = payload.createdAt ?? new Date().toISOString();
      const newPost: ForumPostRow = {
        id: payload.postId,
        thread_id: thread.id,
        parent_post_id: parentPostId,
        created_at: createdAt,
        updated_at: null,
        created_by: currentUserId ?? thread.created_by,
        body_markdown: trimmed,
        is_deleted: false,
        edit_reason: null,
      };

      setPosts((prev) => [...prev, newPost]);

      setThread((prev) =>
        prev
          ? {
              ...prev,
              reply_count: (prev.reply_count ?? 0) + 1,
              last_post_at: createdAt,
              last_post_by: currentUserId ?? prev.last_post_by,
            }
          : prev
      );

      onSuccess?.(payload.postId);
      setPosting(false);
    } catch (err) {
      console.error("Unexpected error posting reply", err);
      setError("Unexpected error posting reply.");
      setPosting(false);
    }
  };

// --- Reply submit handler (bottom reply box) ---
  
  const handleSubmitReply = async (e: FormEvent) => {
    e.preventDefault();
    await submitReply({
      parentPostId: null,
      body: replyBody,
      setError: setReplyError,
      setPosting: setPostingReply,
      onSuccess: (newPostId) => {
        setReplyBody("");
        jumpToPostId(newPostId);
      },
    });
  };

  const handleSubmitInlineReply = async (parentPostId: number) => {
    await submitReply({
      parentPostId,
      body: inlineReplyBody,
      setError: setInlineReplyError,
      setPosting: setPostingInlineReply,
      onSuccess: (newPostId) => {
        setInlineReplyBody("");
        setInlineReplyParentPostId(null);
        jumpToPostId(newPostId);
      },
    });
  };

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-8 text-sm text-brand-text">
      {thread ? (
        <ReportModal
          open={reportThreadOpen}
          title="Report thread"
          description="This creates a private conversation with staff."
          targetType="forum_thread"
          targetId={String(thread.id)}
          onClose={() => setReportThreadOpen(false)}
        />
      ) : null}

      <MiniProfileModal
        open={miniProfileOpen}
        user={miniProfileUser}
        onClose={closeMiniProfile}
        isBlocked={miniProfileUser?.id ? blockedUserIds.has(miniProfileUser.id) : false}
        onToggleBlockUser={handleToggleBlockUser}
        onReportUser={(targetUserId) => {
          setReportUserId(targetUserId);
          setReportUserOpen(true);
        }}
      />

      <ReportModal
        open={reportUserOpen && !!reportUserId}
        title="Report user"
        description="This creates a private conversation with staff."
        targetType="user"
        targetId={reportUserId ?? ""}
        onClose={() => {
          setReportUserOpen(false);
          setReportUserId(null);
        }}
      />

            {/* Breadcrumbs (Info › Category › Page) */}
            <div className="mb-3 flex flex-wrap items-center gap-2 text-[11px] text-brand-textMuted">
              <Link
                href="/community"
                className="text-amber-300 underline underline-offset-2 hover:text-amber-200"
              >
                Community
              </Link>

              {categorySlug ? (
                <>
                  <span>›</span>
                  <Link
                    href={`/community/${encodeURIComponent(categorySlug)}`}
                    className="text-amber-300 underline underline-offset-2 hover:text-amber-200"
                  >
                    {category?.name ?? "Category"}
                  </Link>
                </>
              ) : null}

              <span>›</span>
              <span className="text-brand-text">{thread?.title}</span>
            </div>

      {/* Title + meta */}
      <section className="space-y-2">
        <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">
          {thread ? thread.title : "Thread"}
        </h1>

        {thread && (
          <div className="flex flex-wrap items-center gap-2 text-[10px]">
            {thread.is_pinned && (
              <span className="inline-flex items-center gap-1 rounded-full border border-amber-400/80 bg-amber-500/20 px-2 py-0.5 text-amber-200">
                📌 Pinned
              </span>
            )}
            {thread.accepted_post_id && (
              <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/80 bg-emerald-500/15 px-2 py-0.5 text-emerald-200">
                ✅ Answered
              </span>
            )}
            {thread.is_locked && (
              <span className="inline-flex items-center gap-1 rounded-full border border-rose-500/70 bg-rose-500/15 px-2 py-0.5 text-rose-200">
                🔒 Locked
              </span>
            )}

            {(thread.tags ?? []).length > 0 && (
              <div className="flex flex-wrap items-center gap-1">
                {(thread.tags ?? []).slice(0, 6).map((tag) => (
                  <span
                    key={tag}
                    className="rounded-full border border-zinc-700/80 bg-black/30 px-2 py-0.5 text-[10px] text-brand-textMuted"
                  >
                    #{tag}
                  </span>
                ))}
              </div>
            )}

            {currentUserId && thread.created_by !== currentUserId && !thread.is_deleted && (
              <div className="ml-auto inline-flex items-center gap-2">
                {viewerIsStaff ? (
                  <button
                    type="button"
                    onClick={() => void handleFlag("thread", String(thread.id))}
                    className="rounded-full border border-zinc-700 bg-black/40 px-2 py-0.5 text-[10px] hover:border-zinc-500 hover:text-brand-text"
                  >
                    Flag
                  </button>
                ) : null}
                <button
                  type="button"
                  onClick={() => setReportThreadOpen(true)}
                  className="rounded-full border border-zinc-700 bg-black/40 px-2 py-0.5 text-[10px] hover:border-zinc-500 hover:text-brand-text"
                >
                  Report thread
                </button>
              </div>
            )}
          </div>
        )}

        {flagToast ? (
          <div className="rounded-xl border border-zinc-800/70 bg-black/40 px-3 py-2 text-xs text-brand-textMuted">
            {flagToast}
          </div>
        ) : null}

        {thread && (
          <div className="text-[11px] text-brand-textMuted">
            <span>
              by{" "}
              <span className="text-brand-text">
                {getDisplayName(thread.created_by)}
              </span>
            </span>
            <span> • </span>
            <span>{formatDateTime(thread.created_at)}</span>
            <span> • </span>
            <span>
              {thread.reply_count} repl{thread.reply_count === 1 ? "y" : "ies"}
            </span>
            <span> • </span>
            <span>
              {thread.view_count} view{thread.view_count === 1 ? "" : "s"}
            </span>
          </div>
        )}

        {/* Thread controls */}
        {thread && (canLockThread || canPinThread) && (
          <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-brand-textMuted">
            {canPinThread && (
              <button
                type="button"
                onClick={handleTogglePin}
                disabled={pinning}
                className={
                  "inline-flex items-center rounded-full border px-3 py-0.5 text-[11px] " +
                  (thread.is_pinned
                    ? "border-zinc-700 bg-black/40 text-brand-text hover:border-zinc-500"
                    : "border-amber-400/80 bg-amber-500/20 text-amber-200 hover:bg-amber-500/30") +
                  (pinning ? " opacity-60" : "")
                }
              >
                {pinning ? "Updating…" : thread.is_pinned ? "Unpin" : "Pin"}
              </button>
            )}

            {canLockThread && (
              <button
                type="button"
                onClick={handleToggleLock}
                disabled={locking}
                className={
                  "inline-flex items-center rounded-full border px-3 py-0.5 text-[11px] " +
                  (thread.is_locked
                    ? "border-emerald-500/70 bg-emerald-500/15 text-emerald-200 hover:bg-emerald-500/25"
                    : "border-rose-500/70 bg-rose-500/15 text-rose-200 hover:bg-rose-500/25") +
                  (locking ? " opacity-60" : "")
                }
              >
                {locking ? "Updating…" : thread.is_locked ? "Unlock" : "Lock"}
              </button>
            )}

            {threadActionError && (
              <span className="text-[10px] text-rose-300">
                {threadActionError}
              </span>
            )}
          </div>
        )}

        {thread?.is_locked && (
          <div className="mt-2 rounded-md border border-rose-500/60 bg-rose-950/40 px-3 py-2 text-[11px] text-rose-100">
            <div className="font-semibold">Thread locked</div>
            <div className="mt-0.5">
              {thread.locked_reason
                ? thread.locked_reason
                : "This thread has been locked. No new replies can be posted."}
            </div>
            {thread.locked_at && (
              <div className="mt-0.5 text-[10px] text-rose-200/80">
                Locked at {formatDateTime(thread.locked_at)} by{" "}
                <span className="text-rose-50">
                  {getDisplayName(thread.locked_by)}
                </span>
              </div>
            )}
          </div>
        )}
      </section>

      {/* Error / loading */}
      {state === "error" && (
        <section>
          <p className="rounded-md border border-rose-500/60 bg-rose-950/40 px-3 py-2 text-[12px] text-rose-200">
            {errorMessage ?? "Failed to load thread."}
          </p>
        </section>
      )}

      {state === "loading" && (
        <section>
          <p className="text-[12px] text-brand-textMuted">Loading thread…</p>
        </section>
      )}

      {/* Lead (OP) */}
      {state === "loaded" && thread && leadPost && (
        <section className="rounded-2xl">
          <OriginalPostCard
            recycleInfoByPostId={recycleInfoByPostId}
            post={leadPost}
            onReplyTo={beginReplyToPost}
            getKarmaFlash={getKarmaFlash}
            getDisplayName={getDisplayName}
            getProfile={getProfile}
            getUserRole={getUserRole}
            getUserHref={getUserHref}
            formatDateTime={formatDateTime}
            currentUserId={currentUserId}
            myVote={myPostVotes[leadPost.id] ?? 0}
            canVote={canVoteForPost(leadPost)}
            isVoting={!!isVotingByPostId[leadPost.id]}
            score={getScoreForPost(leadPost)}
            onVote={applyVote}
            voteError={voteErrorByPostId[leadPost.id] ?? null}
            onPostUpdated={handleLocalPostUpdated}
            blockedUserIds={blockedUserIds}
            currentUsername={currentUsername}
            onOpenMiniProfileByUserId={openMiniProfileByUserId}
            onOpenMiniProfileByUsername={openMiniProfileByUsername}
            viewerPermissions={viewerPermissions}
            highlightedPostId={highlightPostId}
          />
        </section>
      )}

      {/* Accepted answer (if any) */}
      {state === "loaded" && thread && acceptedPost && (
        <section className="space-y-2 rounded-2xl border border-emerald-500/60 bg-emerald-900/20 p-4 sm:p-5">
          <div className="flex items-center justify-between gap-2">
            <div className="text-[12px] font-semibold text-emerald-100">
              ✅ Answered
            </div>
            <div className="text-[10px] text-emerald-200/80">
              Marked as the answer
            </div>
          </div>
          <div data-post-card="1" data-depth={0} data-parent-id={0}>
            <PostCard
              recycleInfoByPostId={recycleInfoByPostId}
              highlightedPostId={highlightPostId}
              depth={1}
              isDepthCapped={false}
              onJumpToPostId={jumpToPostId}
              onOpenMiniProfileByUserId={openMiniProfileByUserId}
              onOpenMiniProfileByUsername={openMiniProfileByUsername}
              post={acceptedPost}
              replyingTo={null}
              onReplyTo={beginReplyToPost}
              inlineReplyParentPostId={inlineReplyParentPostId}
              inlineReplyBody={inlineReplyBody}
              inlineReplyError={inlineReplyError}
              postingInlineReply={postingInlineReply}
              onChangeInlineReplyBody={(v) => { setInlineReplyBody(v); if (inlineReplyError) setInlineReplyError(null); }}
              onSubmitInlineReply={handleSubmitInlineReply}
              onCancelInlineReply={cancelInlineReply}
              handleFlag={handleFlag}
              myVote={myPostVotes[acceptedPost.id] ?? 0}
              canVote={canVoteForPost(acceptedPost)}
              isVoting={!!isVotingByPostId[acceptedPost.id]}
              score={getScoreForPost(acceptedPost)}
              onVote={applyVote}
              voteError={voteErrorByPostId[acceptedPost.id] ?? null}
              threadOwnerId={thread.created_by}
              getKarmaFlash={getKarmaFlash}
              getDisplayName={getDisplayName}
              getProfile={getProfile}
              getUserRole={getUserRole}
              getUserHref={getUserHref}
              formatDateTime={formatDateTime}
              highlightAuthor={true}
              currentUserId={currentUserId}
              viewerPermissions={viewerPermissions}
              blockedUserIds={blockedUserIds}
              currentUsername={currentUsername}
              onPostUpdated={handleLocalPostUpdated}
              acceptedPostId={thread.accepted_post_id}
              canMarkAnswer={canMarkAnswers}
              isUpdatingAnswer={updatingAnswer}
              onSetAcceptedPost={handleSetAcceptedPost}
              isBlocked={false}
              onToggleBlockUser={handleToggleBlockUser}
            />
          </div>
        </section>
      )}

      {/* Replies + reply box */}
      {state === "loaded" && thread && (
        <section className="space-y-4">
          <div className="border-t border-zinc-800/80 pt-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="text-[18px] font-semibold text-amber-300">Replies</div>

              <div className="flex items-center gap-2 text-[11px] text-brand-textMuted">
                <span className="hidden sm:inline">Sort:</span>
                <MenuSelect
                  value={replySort}
                  onChange={(next) => setReplySort(next as ReplySort)}
                  ariaLabel="Sort replies"
                  className="flex h-8 items-center gap-2 rounded-full border border-zinc-700 bg-black/40 px-3 text-[11px] text-brand-text outline-none transition hover:border-zinc-500"
                  options={[
                    { value: "best", label: "Best" },
                    { value: "top", label: "Popular" },
                    { value: "new", label: "Most recent" },
                    { value: "old", label: "Oldest" },
                    { value: "controversial", label: "Controversial" },
                  ]}
                />
              </div>
            </div>
          </div>

          {/* Reply box */}
          <div
            ref={replyComposerRef}
            className="mt-4 rounded-2xl border border-zinc-800/80 bg-black/35 p-4 text-[12px]"
          >
            <div className="mb-2 flex items-center justify-between gap-2">
              <p className="text-[11px] font-semibold text-brand-text">
                Write a reply…
              </p>
              <p className="text-[10px] text-brand-textMuted">
                (you can @mention people by username)
              </p>
            </div>

            {thread.is_locked && (
              <p className="text-[11px] text-brand-textMuted">
                This thread is locked. Replies are disabled.
              </p>
            )}

            {!thread.is_locked && (
              <>
                {isBanned && (
                  <p className="mb-2 rounded-md border border-rose-500/60 bg-rose-950/40 px-3 py-2 text-[11px] text-rose-200">
                    You are banned and cannot reply.
                  </p>
                )}

                {!isBanned && isLoggedIn === false && (
                  <p className="mb-2 rounded-md border border-zinc-700 bg-black/50 px-3 py-2 text-[11px] text-brand-textMuted">
                    You must be logged in to reply.{" "}
                    <Link
                      href={`/auth/login?next=${encodeURIComponent(threadUrl)}`}
                      className="text-amber-300 underline underline-offset-2 hover:text-amber-200"
                    >
                      Log in
                    </Link>
                  </p>
                )}

                <form className="space-y-2" onSubmit={handleSubmitReply}>
                  <MentionTextarea

                    value={replyBody}

                    onChange={setReplyBody}

                    placeholder="Write a reply…"

                    rows={5}

                    className="no-zoom-input w-full rounded-xl py-2 text-[12px] text-brand-text outline-none placeholder:text-brand-textMuted focus:border-amber-400"

                    disabled={postingReply || isBanned || isLoggedIn === false}

                    makeUserHref={(username) => `/user/@${username}`}

                    currentUserId={currentUserId}

                    blockedUserIds={blockedUserIds}
/>
                  {replyError && (
                    <p className="text-[11px] text-rose-300">{replyError}</p>
                  )}

                  <div className="flex items-center justify-end">
                    <button
                      type="submit"
                      disabled={postingReply || isBanned || isLoggedIn === false}
                      className="inline-flex items-center justify-center rounded-full border border-amber-400/80 bg-amber-500/20 px-5 py-2 text-[11px] font-medium text-amber-300 hover:bg-amber-500/25 disabled:opacity-60"
                    >
                      {postingReply ? "Posting…" : "Post reply"}
                    </button>
                  </div>
                </form>
              </>
            )}
          </div>

          {sortedPostTree.length === 0 ? (
            <p className="text-[12px] text-brand-textMuted">No replies yet.</p>
          ) : (
            <div className="flex flex-col">
              {sortedPostTree.map((node, idx) => {
                const isLast = idx === sortedPostTree.length - 1;
                return (
                  <div key={node.id} className={cn(!isLast && POST_STACK_ITEM_PB)}>
                    <PostTreeNode
                      key={node.id}
                      node={node}
                      parent={null}
                      depth={1}
                      threadOwnerId={thread.created_by}
                      recycleInfoByPostId={recycleInfoByPostId}
                      getKarmaFlash={getKarmaFlash}
                      getDisplayName={getDisplayName}
                      getProfile={getProfile}
                      getUserRole={getUserRole}
                      getUserHref={getUserHref}
                      formatDateTime={formatDateTime}
                      acceptedPostId={thread.accepted_post_id}
                      currentUserId={currentUserId}
                      currentUsername={currentUsername}
                      viewerPermissions={viewerPermissions}
                      onPostUpdated={handleLocalPostUpdated}
                      canMarkAnswer={canMarkAnswers}
                      isUpdatingAnswer={updatingAnswer}
                      onSetAcceptedPost={handleSetAcceptedPost}
                      blockedUserIds={blockedUserIds}
                      blockedByUserIds={blockedByUserIds}
                      viewerIsStaff={viewerIsStaff}
                      onToggleBlockUser={handleToggleBlockUser}
                      myPostVotes={myPostVotes}
                      isVotingByPostId={isVotingByPostId}
                      voteErrorByPostId={voteErrorByPostId}
                      onVote={applyVote}
                      canVoteForPost={canVoteForPost}
                      getScoreForPost={getScoreForPost}
                      onReplyTo={beginReplyToPost}
              inlineReplyParentPostId={inlineReplyParentPostId}
              inlineReplyBody={inlineReplyBody}
              inlineReplyError={inlineReplyError}
              postingInlineReply={postingInlineReply}
              onChangeInlineReplyBody={(v) => { setInlineReplyBody(v); if (inlineReplyError) setInlineReplyError(null); }}
              onSubmitInlineReply={handleSubmitInlineReply}
              onCancelInlineReply={cancelInlineReply}
                      handleFlag={handleFlag}
                      highlightedPostId={highlightPostId}
                      hoverRailId={hoverRailId}
                      setHoverRailId={setHoverRailId}
                      collapsedRepliesByPostId={collapsedRepliesByPostId}
                      setCollapsedRepliesByPostId={setCollapsedRepliesByPostId}
                      autoCollapsedByPostId={autoCollapsedByPostId}
                      revealChildCountByPostId={revealChildCountByPostId}
                      setRevealChildCountByPostId={setRevealChildCountByPostId}
                      userUnhiddenByPostId={userUnhiddenByPostId}
                      setUserUnhiddenByPostId={setUserUnhiddenByPostId}
                      onJumpToPostId={jumpToPostId}
                      onOpenMiniProfileByUserId={openMiniProfileByUserId}
                      onOpenMiniProfileByUsername={openMiniProfileByUsername}
                    />
                  </div>
                );
              })}
            </div>
          )}
        </section>
      )}
    </div>
  );
}

// --------- helpers ---------
function buildPostTree(posts: ForumPostRow[]): PostNode[] {
  const nodesById = new Map<number, PostNode>();
  const roots: PostNode[] = [];

  for (const p of posts) nodesById.set(p.id, { ...p, children: [] });

  for (const node of nodesById.values()) {
    if (node.parent_post_id && nodesById.has(node.parent_post_id)) {
      const parent = nodesById.get(node.parent_post_id)!;
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }

  return roots;
}

// Count all descendant replies (children + grandchildren, etc.) under a post node.
function countDescendantReplies(n: PostNode): number {
  let count = 0;
  for (const child of n.children) {
    count += 1;
    count += countDescendantReplies(child);
  }
  return count;
}


// --------- UI components ---------

function VoteControls({
  postId,
  myVote,
  score,
  canVote,
  isVoting,
  onVote,
  voteError,
}: {
  postId: number;
  myVote: VoteValue;
  score: number;
  canVote: boolean;
  isVoting: boolean;
  onVote: (postId: number, value: VoteValue) => void;
  voteError: string | null;
}) {
  const isMobile = useIsMobile();
  const disabled = !canVote || isVoting;

  const baseBtn =
    "inline-flex items-center justify-center rounded-full border transition " +
    (isMobile ? "h-7 w-7 text-[11px]" : "h-8 w-8 text-[12px]");
  const disabledCls = disabled ? " opacity-60 cursor-not-allowed" : "";

  const upCls =
    myVote === 1
      ? " border-emerald-400/80 bg-emerald-500/20 text-emerald-200"
      : " border-zinc-700 bg-black/40 text-brand-textMuted hover:text-emerald-200 hover:border-emerald-400/60";

  const downCls =
    myVote === -1
      ? " border-rose-400/80 bg-rose-500/20 text-rose-200"
      : " border-zinc-700 bg-black/40 text-brand-textMuted hover:text-rose-200 hover:border-rose-400/60";

  return (
    <div className="flex flex-col items-end">
      <div className="inline-flex items-center gap-2">
        <button
          type="button"
          aria-label="Upvote"
          disabled={disabled}
          onClick={() => onVote(postId, myVote === 1 ? 0 : 1)}
          className={baseBtn + upCls + disabledCls}
        >
          ▲
        </button>

        <div className={"text-center font-semibold text-brand-text " + (isMobile ? "min-w-6 text-[10px]" : "min-w-7 text-[11px]")}>
          {score}
        </div>

        <button
          type="button"
          aria-label="Downvote"
          disabled={disabled}
          onClick={() => onVote(postId, myVote === -1 ? 0 : -1)}
          className={baseBtn + downCls + disabledCls}
        >
          ▼
        </button>
      </div>

      {voteError ? (
        <div className="mt-1 max-w-[180px] text-right text-[10px] text-rose-300">
          {voteError}
        </div>
      ) : null}
    </div>
  );
}

function PostTreeNode({
  node,
  parent,
  threadOwnerId,
  handleFlag = () => {},
  getKarmaFlash,
  getDisplayName,
  getProfile,
  getUserRole,
  getUserHref,
  formatDateTime,
  acceptedPostId,
  currentUserId,
  currentUsername,
  viewerPermissions,
  depth = 0,
  rawDepth = depth,
  autoDepthRemaining = null,
  suppressChildren = false,
  onPostUpdated,
  recycleInfoByPostId,
  canMarkAnswer,
  isUpdatingAnswer,
  onSetAcceptedPost,
  blockedUserIds,
  blockedByUserIds,
  viewerIsStaff,
  onToggleBlockUser,
  myPostVotes,
  isVotingByPostId,
  voteErrorByPostId,
  onVote,
  canVoteForPost,
  getScoreForPost,
  highlightedPostId,
  onReplyTo,
  inlineReplyParentPostId,
  inlineReplyBody,
  inlineReplyError,
  postingInlineReply,
  onChangeInlineReplyBody,
  onSubmitInlineReply,
  onCancelInlineReply,
  collapsedRepliesByPostId,
  setCollapsedRepliesByPostId,
  autoCollapsedByPostId,
  revealChildCountByPostId,
  setRevealChildCountByPostId,
  userUnhiddenByPostId,
  setUserUnhiddenByPostId,
  hoverRailId,
  setHoverRailId,
  onJumpToPostId,
  onOpenMiniProfileByUserId,
  onOpenMiniProfileByUsername,
}: {
  node: PostNode;
  parent: PostNode | null;
  threadOwnerId: string | null;
  getKarmaFlash: (userId: string) => number;
  getDisplayName: (userId: string | null | undefined) => string;
  getProfile: (userId: string | null | undefined) => ProfileRow | null;
  getUserRole: (userId: string | null | undefined) => string;
  getUserHref: (userId: string | null | undefined) => string;
  formatDateTime: (value: string | null) => string;
  acceptedPostId: number | null;
  currentUserId: string | null;
  currentUsername: string | null;
  viewerPermissions: ReadonlySet<string>;
  highlightedPostId: number | null;
  depth?: number;
  rawDepth?: number;
  // When set, limits how many additional levels of descendants may render.
  // Used to show only children + grandchildren for auto-collapsed groups (Reddit-style).
  autoDepthRemaining?: number | null;
  suppressChildren?: boolean;
  onPostUpdated: (post: ForumPostRow) => void;
  recycleInfoByPostId?: Record<string, { daysLeft: number; expiresAt: string }>;
  canMarkAnswer: boolean;
  isUpdatingAnswer: boolean;
  onSetAcceptedPost: (postId: number | null) => void;
  blockedUserIds: Set<string>;
  blockedByUserIds: Set<string>;
  viewerIsStaff: boolean;
  onToggleBlockUser: (targetUserId: string, shouldBlock: boolean) => void | Promise<void>;
  myPostVotes: Record<number, VoteValue>;
  isVotingByPostId: Record<number, boolean>;
  voteErrorByPostId: Record<number, string>;
  onVote: (postId: number, value: VoteValue) => void;
  canVoteForPost: (post: ForumPostRow) => boolean;
  getScoreForPost: (post: ForumPostRow) => number;
  onReplyTo: (post: ForumPostRow) => void;
  inlineReplyParentPostId: number | null;
  inlineReplyBody: string;
  inlineReplyError: string | null;
  postingInlineReply: boolean;
  onChangeInlineReplyBody: (v: string) => void;
  onSubmitInlineReply: (parentPostId: number) => void | Promise<void>;
  onCancelInlineReply: () => void;
  handleFlag?: (targetType: "thread" | "post", targetId: string) => void | Promise<void>;
  collapsedRepliesByPostId: Record<number, boolean>;
  setCollapsedRepliesByPostId: React.Dispatch<React.SetStateAction<Record<number, boolean>>>;
  autoCollapsedByPostId: Record<number, boolean>;
  revealChildCountByPostId: Record<number, number>;
  setRevealChildCountByPostId: React.Dispatch<React.SetStateAction<Record<number, number>>>;
  userUnhiddenByPostId: Record<number, boolean>;
  setUserUnhiddenByPostId: React.Dispatch<React.SetStateAction<Record<number, boolean>>>;
  hoverRailId: number | null;
  setHoverRailId: React.Dispatch<React.SetStateAction<number | null>>;
  onJumpToPostId: (postId: number) => void;
  onOpenMiniProfileByUserId: (userId: string | null | undefined) => void;
  onOpenMiniProfileByUsername: (username: string) => void | Promise<void>;
}) {
  const isAccepted = acceptedPostId != null && node.id === acceptedPostId;
  // Reddit-style indentation:
  // The visual nesting is produced by each parent's reply-group padding-left (gutter).
  // If we ALSO add per-depth margins here, grandchildren end up double-indented, which
  // makes elbows无法 reach the card and breaks the continuous skeleton.
  const indent = false;
  const iBlockedThem = blockedUserIds.has(node.created_by);
  const theyBlockedMe = blockedByUserIds.has(node.created_by);

  // Staff must still be able to view/moderate everyone.
  // Keep UI block state (for the Block/Unblock button) as "I blocked them",
  // but only suppress visibility for non-staff viewers.
  const isBlocked = iBlockedThem;
  const hideForBlocks = !viewerIsStaff && (iBlockedThem || theyBlockedMe);

  const isAutoGroup = !!autoCollapsedByPostId[node.id] && !userUnhiddenByPostId[node.id];

  // Reddit-style progressive reveal:
  // - Auto-collapsed groups start collapsed.
  // - When opened, we reveal *children* in batches (2 at a time).
  // - For each revealed child, we also show its immediate children (grandchildren).
  // - Deeper levels remain collapsed, but are still expandable by the user.
  const effectiveAutoDepth =
    autoDepthRemaining != null ? autoDepthRemaining : isAutoGroup ? 2 : null;

  const forceCollapsedByAutoDepth =
    effectiveAutoDepth != null &&
    effectiveAutoDepth <= 0 &&
    !userUnhiddenByPostId[node.id];

  const repliesCollapsed = forceCollapsedByAutoDepth
    ? true
    : (collapsedRepliesByPostId[node.id] ?? false);

  const suppressAllChildren = suppressChildren;
  const hiddenRepliesCount = React.useMemo(() => countDescendantReplies(node), [node]);

  // Hover/viewport helpers (needed for both connector rendering and progressive reveal logic)
  const canHover = useCanHover();
  const isMobile = useIsMobile();
  // Cap how far the UI visually indents. (Counts comments/replies only; the thread itself is NOT counted.)
  const MAX_INDEX_DEPTH = isMobile ? 6 : 12;
  const depthForIndent = Math.min(rawDepth, MAX_INDEX_DEPTH);
  const capDescendantsInThisList = rawDepth >= MAX_INDEX_DEPTH - 1;
  const isDepthCapped = rawDepth > MAX_INDEX_DEPTH;
  const isRailHot = canHover && hoverRailId === node.id;
  // Connector highlight only on desktop (hover-capable pointers)
  const railColor = isRailHot ? "rgba(245,245,245,1)" : "rgba(60,60,60,1)";
  const textColor = isRailHot ? "rgba(245,245,245,0.92)" : "rgba(120,120,120,1)";
  // Child list for this node.
  // For *auto-collapsed* groups we do NOT flatten the entire subtree.
  // Instead, we reveal direct children in batches (2 at a time), and each child
  // renders up to one more level (grandchildren). Deeper levels stay hidden.
  const childItems = React.useMemo(() => {
    if (capDescendantsInThisList) {
      // When we hit the visual depth cap we flatten so the user can still read the chain.
      const out: Array<{ node: PostNode; parent: PostNode; rawDepth: number }> = [];
      const stack: Array<{ n: PostNode; p: PostNode; d: number }> = [];
      for (let i = (node.children ?? []).length - 1; i >= 0; i--) {
        stack.push({ n: (node.children ?? [])[i]!, p: node, d: rawDepth + 1 });
      }
      while (stack.length) {
        const cur = stack.pop()!;
        out.push({ node: cur.n, parent: cur.p, rawDepth: cur.d });
        if (cur.n.children?.length) {
          for (let i = cur.n.children.length - 1; i >= 0; i--) {
            stack.push({ n: cur.n.children[i]!, p: cur.n, d: cur.d + 1 });
          }
        }
      }
      return out;
    }
    return (node.children ?? []).map((c) => ({ node: c, parent: node, rawDepth: rawDepth + 1 }));
  }, [capDescendantsInThisList, node, rawDepth]);
  const initialReveal = 2;
  const hasDeepDescendants = React.useMemo(() => {
    for (const c of node.children ?? []) {
      if ((c.children?.length ?? 0) > 0) return true;
    }
    return false;
  }, [node.children]);
  const curReveal = revealChildCountByPostId[node.id] ?? 0;
  const effectiveReveal = isAutoGroup
    ? Math.min(childItems.length, Math.max(curReveal || initialReveal, initialReveal))
    : childItems.length;
  const visibleChildItems = isAutoGroup ? childItems.slice(0, effectiveReveal) : childItems;
  const canShowMore = isAutoGroup && visibleChildItems.length < childItems.length;

  const handleToggleReplies = React.useCallback(() => {
    // If this node is being kept collapsed only due to the "show 2 levels" auto-depth cap,
    // treat a click as an explicit user action to expand deeper.
    if (forceCollapsedByAutoDepth) {
      setUserUnhiddenByPostId((prev) => ({ ...prev, [node.id]: true }));
      setCollapsedRepliesByPostId((prev) => ({ ...prev, [node.id]: false }));
      return;
    }

    setCollapsedRepliesByPostId((prev) => {
      const cur = prev[node.id] ?? false;
      return { ...prev, [node.id]: !cur };
    });

    // When opening an auto-collapsed group, reveal 2 direct children.
    // Each revealed child will render its children (grandchildren). Deeper levels remain collapsed.
    if (repliesCollapsed && isAutoGroup) {
      setRevealChildCountByPostId((prev) => ({
        ...prev,
        [node.id]: Math.min(initialReveal, childItems.length),
      }));
    }
  }, [childItems.length, forceCollapsedByAutoDepth, initialReveal, isAutoGroup, node.id, repliesCollapsed, setCollapsedRepliesByPostId, setRevealChildCountByPostId, setUserUnhiddenByPostId]);

  const showMore = React.useCallback(() => {
    setRevealChildCountByPostId((prev) => {
      const cur = prev[node.id] ?? initialReveal;
      const next = Math.min(childItems.length, cur + 2);
      return { ...prev, [node.id]: next };
    });
  }, [childItems.length, initialReveal, node.id, setRevealChildCountByPostId]);

  // Gutter geometry for Reddit-style connectors
  // Reduced on purpose so deep reply chains don't chew up the entire mobile viewport.
  // Mobile gets an even smaller gutter so deep threads stay readable.
  // These values must stay in sync with the reply-group padding-left classes below.
  const GUTTER_PADDING = isMobile ? 16 : 24; // matches `pl-4 md:pl-6`
  const GUTTER_LANE_X = isMobile ? 3 : 6; // lane offset inside the gutter padding
  const GUTTER_LANE_ABS = GUTTER_PADDING + GUTTER_LANE_X; // absolute x for the lane
  const GUTTER_BUTTON_LEFT = GUTTER_LANE_ABS - 10; // center 20px button over the 2px lane
  const GUTTER_TOP_SEGMENT_H = 8; // matches `pt-2`

  const myVote: VoteValue = myPostVotes[node.id] ?? 0;
  const canVote = canVoteForPost(node);
  const isVoting = !!isVotingByPostId[node.id];
  const voteError = voteErrorByPostId[node.id] ?? null;
  const score = getScoreForPost(node);

  return (
    // IMPORTANT: We do NOT draw an extra border-left on every nested node.
    // That was causing the "stack of extra lines" effect. The reply-group below
    // is responsible for drawing the Reddit-style spine + elbow.
    <div className={(indent ? "ml-4 pl-3" : "") + " relative"}>
      {/*
        IMPORTANT:
        We tag every rendered post card with data attributes so the reply-group
        can measure the direct-reply stack and draw a continuous Reddit-style spine.
      */}
      <div data-post-card="1" data-depth={depthForIndent} data-parent-id={parent?.id ?? 0}>
        <PostCard
          recycleInfoByPostId={recycleInfoByPostId}
          highlightedPostId={highlightedPostId}
          depth={depth}
          isDepthCapped={isDepthCapped}
          onJumpToPostId={onJumpToPostId}
          post={node}
          replyingTo={
            parent
              ? {
                  postId: parent.id,
                  createdBy: parent.created_by,
                  displayName: getDisplayName(parent.created_by),
                  href: getUserHref(parent.created_by),
                }
              : null
          }
          onReplyTo={onReplyTo}
          inlineReplyParentPostId={inlineReplyParentPostId}
          inlineReplyBody={inlineReplyBody}
          inlineReplyError={inlineReplyError}
          postingInlineReply={postingInlineReply}
          onChangeInlineReplyBody={onChangeInlineReplyBody}
          onSubmitInlineReply={onSubmitInlineReply}
          onCancelInlineReply={onCancelInlineReply}
          handleFlag={handleFlag}
          threadOwnerId={threadOwnerId}
          getKarmaFlash={getKarmaFlash}
          getDisplayName={getDisplayName}
          getProfile={getProfile}
          getUserRole={getUserRole}
          getUserHref={getUserHref}
          formatDateTime={formatDateTime}
          highlightAuthor={isAccepted}
          currentUserId={currentUserId}
          viewerPermissions={viewerPermissions}
          blockedUserIds={blockedUserIds}
          currentUsername={currentUsername}
          onPostUpdated={onPostUpdated}
          myVote={myVote}
          canVote={canVote}
          isVoting={isVoting}
          score={score}
          onVote={onVote}
          voteError={voteError}
          acceptedPostId={acceptedPostId}
          canMarkAnswer={canMarkAnswer}
          isUpdatingAnswer={isUpdatingAnswer}
          onSetAcceptedPost={onSetAcceptedPost}
          isBlocked={isBlocked}
          hideForBlocks={hideForBlocks}
          onToggleBlockUser={onToggleBlockUser}
          onOpenMiniProfileByUserId={onOpenMiniProfileByUserId}
          onOpenMiniProfileByUsername={onOpenMiniProfileByUsername}
        />
      </div>
      
      {!suppressAllChildren && node.children.length > 0 && (
        <>
          {/* IMPORTANT: The reply-group wrapper MUST NOT add vertical height when replies are collapsed.
              Keeping `pt-2` while collapsed makes this post taller than its siblings, which shows up as the
              "last reply" sitting too low with an empty gap under it. We only add vertical breathing room
              when replies are actually expanded. */}
        {/*
          When we hit the visual depth cap, we STOP shifting cards to the right,
          but we still need the gutter space to draw a continuous spine + elbows.
          We achieve that by keeping the gutter padding, while negating the extra
          horizontal shift with a matching negative margin.
        */}
        <div
          className={cn(
            "relative",
            !repliesCollapsed && "pt-2",
            "pl-4 md:pl-6"
          )}
        >
          {/* Collapse / expand replies (matches Reddit-style lane behavior) */}
          <div
            className="absolute top-2 z-10 flex items-center gap-2"
            style={{ left: GUTTER_BUTTON_LEFT }}
          >
            <button
              type="button"
              onClick={handleToggleReplies}
              onMouseEnter={() => { if (canHover) setHoverRailId(node.id); }}
              onMouseLeave={() => { if (canHover) setHoverRailId((prev) => (prev === node.id ? null : prev)); }}
              className="flex h-5 w-5 items-center justify-center rounded-full text-[14px] font-bold leading-none transition-transform duration-150 hover:scale-105 active:scale-95"
              title={repliesCollapsed ? "Show replies" : "Hide replies"}
              aria-label={repliesCollapsed ? "Show replies" : "Hide replies"}
              style={{
                backgroundColor: railColor,
                color: "rgba(0,0,0,0.92)",
              }}
            >
              {repliesCollapsed ? "+" : "–"}
            </button>

            {repliesCollapsed && (
              <span
                className="text-xs leading-none whitespace-nowrap relative top-[0.5px] transition-colors"
                style={{ color: textColor }}
              >
                {hiddenRepliesCount} repl{hiddenRepliesCount === 1 ? "y" : "ies"} hidden
              </span>
            )}


          </div>

          {/* Reserve vertical space for the toggle row when collapsed so it never overlaps the next reply. */}
          {repliesCollapsed ? <div className="h-7" aria-hidden="true" /> : null}

          {/*
            IMPORTANT:
            Do NOT add a "collapsed spacer" here.
            Any extra height inside this reply-group would make the gap between
            sibling posts vary depending on whether a post has children and is
            collapsed (this was the "last reply is too far down" issue).
            The toggle row lives in the gutter (not over the cards), so we don't
            add any extra vertical spacer/padding that would compound with depth.
          */}

          {/* Top connector segment: stays visible even when replies are collapsed */}
          <span
            className="pointer-events-none absolute"
            style={{
              left: GUTTER_LANE_ABS,
              top: 0,
              width: 2,
              height: GUTTER_TOP_SEGMENT_H,
              background: railColor,
            }}
            aria-hidden="true"
          />
          {/* Click/hover target only over the visible top connector */}
          <button
            type="button"
            onClick={handleToggleReplies}
            onMouseEnter={() => { if (canHover) setHoverRailId(node.id); }}
            onMouseLeave={() => { if (canHover) setHoverRailId((prev) => (prev === node.id ? null : prev)); }}
            aria-label={repliesCollapsed ? "Show replies" : "Hide replies"}
            className="absolute z-[1] bg-transparent p-0"
            style={{ left: 0, top: 0, width: 18, height: GUTTER_TOP_SEGMENT_H, cursor: "pointer" }}
          />


          {/*
            Animate the replies open/closed (Reddit-like): we keep the subtree mounted,
            but collapse it via an animated grid row + fade/slide.
          */}
          <div
            className={cn(
              "grid transition-[grid-template-rows] duration-200 ease-out",
              repliesCollapsed ? "grid-rows-[0fr]" : "grid-rows-[1fr]"
            )}
          >
            <div
              className={cn(
                "min-h-0 overflow-hidden transition-[opacity,transform] duration-200 ease-out",
                repliesCollapsed ? "pointer-events-none opacity-0 -translate-y-1" : "opacity-100 translate-y-0"
              )}
            >
              {/*
                Consistent vertical spacing between replies.
                IMPORTANT: do NOT add extra top padding per depth.
                Any constant "reserve" padding here stacks at every nesting level,
                which is what made the last reply in a deep column look "too far down".
              */}
              <div className="flex flex-col">
                <>
                  {visibleChildItems.map((it, index) => {
                    const isLast = index === visibleChildItems.length - 1;

                    // Shared x position for this depth lane + elbows.
                    // NOTE: After the depth cap, we flatten descendants into this same list and suppress their
                    // nested child-rendering. That means every rendered item in this list is a sibling and should
                    // draw on the exact same lane.
                    const LANE_X = GUTTER_LANE_X;
                    const ELBOW_TOP = 28;

                    return (
                      <div
                        key={it.node.id}
                        className={cn(
                          "relative",
                          !isLast && REPLY_STACK_ITEM_PB,
                          // Keep the gutter padding so the lane column exists; but when capped, do NOT advance the lane.
                          "pl-4 md:pl-6"
                        )}
                      >
                        {/* Hover/click only where connector is visible */}
                        <button
                          type="button"
                          onClick={handleToggleReplies}
                          onMouseEnter={() => { if (canHover) setHoverRailId(node.id); }}
                          onMouseLeave={() => { if (canHover) setHoverRailId((prev) => (prev === node.id ? null : prev)); }}
                          aria-label={repliesCollapsed ? "Show replies" : "Hide replies"}
                          className="absolute z-[1] bg-transparent p-0"
                          style={{
                            left: 0,
                            top: 0,
                            width: 12,
                            cursor: "pointer",
                            ...(isLast ? { height: ELBOW_TOP } : { bottom: 0 }),
                          }}
                        />
                        <button
                          type="button"
                          onClick={handleToggleReplies}
                          onMouseEnter={() => { if (canHover) setHoverRailId(node.id); }}
                          onMouseLeave={() => { if (canHover) setHoverRailId((prev) => (prev === node.id ? null : prev)); }}
                          aria-label={repliesCollapsed ? "Show replies" : "Hide replies"}
                          className="absolute z-[1] bg-transparent p-0"
                          style={{
                            left: 0,
                            top: ELBOW_TOP,
                            width: isMobile ? 24 : 25,
                            height: 22,
                            cursor: "pointer",
                          }}
                        />

                        {/* Vertical lane for this depth: extend through siblings, but stop at the last child's elbow */}
                        <span
                          className="pointer-events-none absolute"
                          style={{
                            left: LANE_X,
                            top: 0,
                            width: 2,
                            ...(isLast ? { height: ELBOW_TOP } : { bottom: 0 }),
                            background: railColor,
                          }}
                          aria-hidden="true"
                        />

                        {/* Self elbow (into this comment) */}
                        <span
                          className="pointer-events-none absolute"
                          style={{
                            left: LANE_X,
                            top: ELBOW_TOP,
                            width: isMobile ? 13 : 18,
                            height: 18,
                            borderLeft: `2px solid ${railColor}`,
                            borderBottom: `2px solid ${railColor}`,
                            borderBottomLeftRadius: 10,
                          }}
                          aria-hidden="true"
                        />

                        <div>
                          <PostTreeNode
                            node={it.node}
                            parent={it.parent}
                            threadOwnerId={threadOwnerId}
                            recycleInfoByPostId={recycleInfoByPostId}
                            handleFlag={handleFlag}
                            getKarmaFlash={getKarmaFlash}
                            getDisplayName={getDisplayName}
                            getProfile={getProfile}
                            getUserRole={getUserRole}
                            getUserHref={getUserHref}
                            formatDateTime={formatDateTime}
                            acceptedPostId={acceptedPostId}
                            currentUserId={currentUserId}
                            currentUsername={currentUsername}
                            viewerPermissions={viewerPermissions}
                            highlightedPostId={highlightedPostId}
                            depth={Math.min(it.rawDepth, MAX_INDEX_DEPTH)}
                            rawDepth={it.rawDepth}
                            // When an auto-collapsed group is opened, we progressively reveal *direct children* (2 at a time).
                            // Each revealed child renders one more level (grandchildren). Deeper levels stay hidden.
                            autoDepthRemaining={effectiveAutoDepth != null ? Math.max(0, effectiveAutoDepth - 1) : null}
                            // When we flatten due to visual depth cap, suppress nested rendering to avoid duplicating the chain.
                            suppressChildren={capDescendantsInThisList}
                            onPostUpdated={onPostUpdated}
                            canMarkAnswer={canMarkAnswer}
                            isUpdatingAnswer={isUpdatingAnswer}
                            onSetAcceptedPost={onSetAcceptedPost}
                            blockedUserIds={blockedUserIds}
                            blockedByUserIds={blockedByUserIds}
                            viewerIsStaff={viewerIsStaff}
                            onToggleBlockUser={onToggleBlockUser}
                            myPostVotes={myPostVotes}
                            isVotingByPostId={isVotingByPostId}
                            voteErrorByPostId={voteErrorByPostId}
                            onVote={onVote}
                            canVoteForPost={canVoteForPost}
                            getScoreForPost={getScoreForPost}
                            onReplyTo={onReplyTo}
                            inlineReplyParentPostId={inlineReplyParentPostId}
                            inlineReplyBody={inlineReplyBody}
                            inlineReplyError={inlineReplyError}
                            postingInlineReply={postingInlineReply}
                            onChangeInlineReplyBody={onChangeInlineReplyBody}
                            onSubmitInlineReply={onSubmitInlineReply}
                            onCancelInlineReply={onCancelInlineReply}
                            collapsedRepliesByPostId={collapsedRepliesByPostId}
                            setCollapsedRepliesByPostId={setCollapsedRepliesByPostId}
                            autoCollapsedByPostId={autoCollapsedByPostId}
                            revealChildCountByPostId={revealChildCountByPostId}
                            setRevealChildCountByPostId={setRevealChildCountByPostId}
                            userUnhiddenByPostId={userUnhiddenByPostId}
                            setUserUnhiddenByPostId={setUserUnhiddenByPostId}
                            hoverRailId={hoverRailId}
                            setHoverRailId={setHoverRailId}
                            onJumpToPostId={onJumpToPostId}
                            onOpenMiniProfileByUserId={onOpenMiniProfileByUserId}
                            onOpenMiniProfileByUsername={onOpenMiniProfileByUsername}
                          />
                        </div>
                      </div>
                    );
                  })}

                  {!repliesCollapsed && canShowMore ? (
                    <div className={cn("pl-4 md:pl-6", REPLY_STACK_ITEM_PB)}>
                      <button
                        type="button"
                        onClick={showMore}
                        className="inline-flex items-center gap-2 rounded-full border border-zinc-700 bg-black/40 px-3 py-1 text-xs text-brand-textMuted transition hover:border-zinc-500 hover:text-brand-text"
                      >
                        Show 2 more replies
                      </button>
                    </div>
                  ) : null}
                </>
              </div>
            </div>
          </div>
        </div>
        </>
      )}
  </div>
  );
}

function OriginalPostCard({
  highlightedPostId,

  recycleInfoByPostId,

  post,
  getKarmaFlash,
  myVote,
  canVote,
  isVoting,
  score,
  onVote,
  voteError,
  getDisplayName,
  getProfile,
  getUserRole,
  getUserHref,
  formatDateTime,
  currentUserId,
  viewerPermissions,
  onReplyTo,
  blockedUserIds,
  currentUsername,
  onPostUpdated,
  onOpenMiniProfileByUserId,
  onOpenMiniProfileByUsername,
}: {
  post: ForumPostRow;
  highlightedPostId: number | null;
  getKarmaFlash: (userId: string) => number;
  myVote: VoteValue;
  canVote: boolean;
  isVoting: boolean;
  score: number;
  onVote: (postId: number, value: VoteValue) => void;
  voteError: string | null;
  getDisplayName: (userId: string | null | undefined) => string;
  getProfile: (userId: string | null | undefined) => ProfileRow | null;
  getUserRole: (userId: string | null | undefined) => string;
  getUserHref: (userId: string | null | undefined) => string;
  onReplyTo: (post: ForumPostRow) => void;
  formatDateTime: (value: string | null) => string;
  currentUserId: string | null;
  viewerPermissions: ReadonlySet<string>;
  blockedUserIds: Set<string>;
  currentUsername: string | null;
  onPostUpdated: (post: ForumPostRow) => void;
  onOpenMiniProfileByUserId: (userId: string | null | undefined) => void;
  onOpenMiniProfileByUsername: (username: string) => void | Promise<void>;
  recycleInfoByPostId?: Record<string, { daysLeft: number; expiresAt: string }>;
}) {
  const profile = getProfile(post.created_by);
  const displayName = getDisplayName(post.created_by);

  const role = getUserRole(post.created_by);
  const href = getUserHref(post.created_by);
  const isMobile = useIsMobile();

  const createdLabel = formatDateTime(post.created_at);
  const updatedLabel =
    post.updated_at && post.updated_at !== post.created_at
      ? formatDateTime(post.updated_at)
      : null;

  
  const [isEditing, setIsEditing] = useState(false);
  const [editBody, setEditBody] = useState(post.body_markdown);
  const [editReason, setEditReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  const canEditAny = viewerPermissions.has("community.post.edit");
  const canEditOwn = viewerPermissions.has("community.post.edit.own");
  const canDeleteAny = viewerPermissions.has("community.delete_post");
  const canDeleteOwn = viewerPermissions.has("community.post.delete.own");
  const canRestore = viewerPermissions.has("community.restore_post");
  const isStaffViewer = canDeleteAny || canRestore;

  const canEdit =
    !post.is_deleted &&
    currentUserId != null &&
    (canEditAny || (currentUserId === post.created_by && canEditOwn));

  const canDelete =
    !post.is_deleted &&
    currentUserId != null &&
    (canDeleteAny || (currentUserId === post.created_by && canDeleteOwn));



  const handleSaveEdit = async () => {
    setLocalError(null);

    const body = editBody.trim();

    const mentionCheck = await validateMentionsAgainstBlocks({
      text: body,
      currentUserId,
      blockedUserIds,
    });

    if (!mentionCheck.ok) {
      setLocalError(mentionCheck.message);
      return;
    }
    if (!body) {
      setLocalError("Body cannot be empty.");
      return;
    }

    try {
      setSaving(true);
      const supabase = supabaseBrowser();
      const {
        data: { session },
        error: sessionError,
      } = await supabase.auth.getSession();

      if (sessionError || !session?.access_token) {
        setLocalError("You must be logged in to edit.");
        setSaving(false);
        return;
      }

      const res = await fetch(`/api/forum/posts/${post.id}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          bodyMarkdown: body,
          editReason: editReason || null,
        }),
      });

      const payload = (await res.json().catch(() => null)) as
        | { ok?: boolean; post?: ForumPostRow; error?: string }
        | null;

      if (!res.ok || !payload?.ok || !payload.post) {
        console.error("Failed to edit post", payload);
        setLocalError(payload?.error ?? "Failed to update post.");
        setSaving(false);
        return;
      }

      onPostUpdated(payload.post);
      setIsEditing(false);
      setSaving(false);
    } catch (err) {
      console.error("Unexpected error editing post", err);
      setLocalError("Unexpected error editing post.");
      setSaving(false);
    }
  };

  return (
    <article
      id={`post-${post.id}`}
      className={
        "rounded-2xl border p-4 sm:p-5 " +
        (highlightedPostId != null && post.id === highlightedPostId
          ? "border-amber-400/70 bg-amber-500/5 shadow-[0_0_0_4px_rgba(251,191,36,0.12)]"
          : "border-zinc-800/80 bg-black/20")
      }
    >
      <div className="grid grid-cols-1 gap-2 items-stretch md:grid-cols-[110px_12px_1fr]">
        {/* Left rail (desktop only) */}
        <div className="hidden self-stretch flex-col items-center justify-center gap-2 md:flex">
          <button
            type="button"
            onClick={() => onOpenMiniProfileByUserId(post.created_by)}
            className="group flex flex-col items-center gap-1 md:gap-2 cursor-pointer"
          >
            <div className="h-10 w-10 overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900/40 md:h-16 md:w-16">
              {profile?.avatar_url ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={profile.avatar_url}
                  alt={displayName}
                  className="h-full w-full object-cover"
                />
              ) : (
                <div className="flex h-full w-full items-center justify-center text-zinc-400">
                  <span className="text-xl">
                    {(displayName[0] || "?").toUpperCase()}
                  </span>
                </div>
              )}
            </div>

            <div className="text-center leading-tight">
              <div className="max-w-[100px] truncate text-sm font-semibold text-zinc-100 group-hover:text-white">
                {displayName}
                {profile?.is_verified ? <VerifiedBadge className="ml-0.5 h-3 w-3" /> : null}
                {profile?.donation_rank ? (
                  <DonationBadge rank={profile.donation_rank} className="ml-0.5 h-3 w-3" />
                ) : null}
              </div>
              {profile?.username ? (
                <div className="mt-0.5 flex max-w-[100px] items-center justify-center gap-1 truncate text-[11px] text-brand-textMuted">
                  <span className="truncate">@{profile.username}</span>
                </div>
              ) : null}
              <div className="mt-0.5 flex flex-col items-center gap-0.5 md:mt-1 md:gap-1">
                <RolePill role={role} />
                <span className="inline-flex items-center rounded-full border border-zinc-700 bg-black/40 px-2 py-0.5 text-[10px] text-brand-textMuted">
                  OP
                </span>
                <div
                  className={
                    "text-[10px] transition-transform duration-300 md:text-[11px] " +
                    (getKarmaFlash(post.created_by) > 0
                      ? "text-emerald-300 scale-110"
                      : getKarmaFlash(post.created_by) < 0
                        ? "text-rose-300 scale-110"
                        : "text-white/60 scale-100")
                  }
                >
                  Karma • {getProfile(post.created_by)?.karma ?? 0}
                </div>
              </div>
            </div>
          </button>
        </div>

        <div className="hidden self-stretch items-stretch justify-center md:flex">
          <div className="my-2 w-px self-stretch rounded-full bg-zinc-800/80 md:my-3" />
        </div>

        {/* Right content */}
        <div className="min-w-0 flex flex-col h-full">
          {isMobile ? (
            <div className="mb-2 flex items-center justify-between gap-2">
              <button
                type="button"
                onClick={() => onOpenMiniProfileByUserId(post.created_by)}
                className="flex min-w-0 items-center gap-2 text-left cursor-pointer"
              >
                <div className="h-8 w-8 overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900/40 flex-none">
                  {profile?.avatar_url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={profile.avatar_url} alt={displayName} className="h-full w-full object-cover" />
                  ) : (
                    <div className="flex h-full w-full items-center justify-center text-zinc-400">
                      <span className="text-sm">{(displayName[0] || "?").toUpperCase()}</span>
                    </div>
                  )}
                </div>

                <div className="min-w-0">
                  <div className="flex items-center gap-1 min-w-0">
                    <span className="max-w-[190px] truncate text-[13px] font-semibold text-zinc-100">{displayName}</span>
                    {profile?.is_verified ? <VerifiedBadge className="h-3 w-3" /> : null}
                    {profile?.donation_rank ? <DonationBadge rank={profile.donation_rank} className="h-3 w-3" /> : null}
                  </div>
                  {profile?.username ? (
                    <div className="mt-0.5 flex max-w-[240px] items-center gap-1 truncate text-[11px] text-brand-textMuted">
                      <span className="truncate">@{profile.username}</span>
                      <RolePill role={role} />
                      <span className="inline-flex items-center rounded-full border border-zinc-700 bg-black/30 px-2 py-0.5 text-[10px] text-brand-textMuted">
                        OP
                      </span>
                    </div>
                  ) : null}
                </div>
              </button>
            </div>
          ) : null}
          <div className="mb-2 flex flex-wrap items-start justify-between gap-2">
            <div className="text-[11px] text-zinc-500">
              <span>{createdLabel}</span>
              {updatedLabel ? <span className="ml-1">• Edited {updatedLabel}</span> : null}
            </div>

            {canEdit && !post.is_deleted && !isEditing && (
              <button
                type="button"
                onClick={() => {
                  setIsEditing(true);
                  setEditBody(post.body_markdown);
                  setEditReason("");
                }}
                className="rounded-full border border-zinc-700 bg-black/40 px-3 py-1 text-[11px] text-brand-textMuted hover:border-amber-400/80 hover:text-brand-text"
              >
                Edit
              </button>
            )}
          </div>

          {post.is_deleted ? (
            <div className="rounded-xl border border-zinc-800 bg-black/25 p-4 text-[12px] italic text-zinc-500">
              This post was deleted.
            </div>
          ) : isEditing ? (
            <div className="space-y-2">
              <MentionTextarea

                value={editBody}

                onChange={setEditBody}

                rows={6}

                disabled={saving}

                makeUserHref={(username) => `/user/@${username}`}

                currentUserId={currentUserId}

                blockedUserIds={blockedUserIds}

                className="w-full no-zoom-input rounded-xl border border-zinc-700 bg-black/40 px-3 py-2 text-[12px] text-brand-text outline-none placeholder:text-brand-textMuted focus:border-amber-400"
/>
              <input
                type="text"
                value={editReason}
                onChange={(e) => setEditReason(e.target.value)}
                placeholder="Edit reason (optional)"
                className="w-full no-zoom-input rounded-xl border border-zinc-700 bg-black/40 px-3 py-2 text-[11px] text-brand-text outline-none placeholder:text-brand-textMuted focus:border-amber-400"
              />
              {localError && (
                <p className="text-[11px] text-rose-300">{localError}</p>
              )}
              <div className="flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setIsEditing(false);
                    setLocalError(null);
                  }}
                  className="rounded-full border border-zinc-700 bg-black/40 px-3 py-1 text-[11px] text-brand-textMuted hover:text-brand-text"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleSaveEdit}
                  disabled={saving}
                  className="rounded-full border border-amber-400/80 bg-amber-500/20 px-3 py-1 text-[11px] font-medium text-amber-300 hover:bg-amber-500/25 disabled:opacity-60"
                >
                  {saving ? "Saving…" : "Save"}
                </button>
              </div>
            </div>
          ) : (
            <div className="rounded-xl">
              <MarkdownContent
                markdown={post.body_markdown}
                makeUserHref={(username) => `/user/@${username}`}
                onUserClick={(username) => void onOpenMiniProfileByUsername(username)}
                className="text-[13px] leading-relaxed text-brand-text"
              />
            </div>
          )}

          {post.edit_reason && !post.is_deleted && (
            <div className="mt-2 text-[10px] text-zinc-500">
              Edit reason: {post.edit_reason}
            </div>
          )}

          {/* Footer: lead post shows votes only */}
          <div className="mt-auto flex items-center justify-end">
            <VoteControls
              postId={post.id}
              myVote={myVote}
              canVote={canVote}
              isVoting={isVoting}
              score={score}
              onVote={onVote}
              voteError={voteError}
            />
          </div>
        </div>
      </div>
    </article>
  );
}

function PostCard({
  recycleInfoByPostId,
  highlightedPostId,
  depth,
  isDepthCapped,
  onJumpToPostId,

  post,
  replyingTo,
  onReplyTo,
  inlineReplyParentPostId,
  inlineReplyBody,
  inlineReplyError,
  postingInlineReply,
  onChangeInlineReplyBody,
  onSubmitInlineReply,
  onCancelInlineReply,
  handleFlag = () => {},
  threadOwnerId,
  getKarmaFlash,
  myVote,
  canVote,
  isVoting,
  score,
  onVote,
  voteError,
  getDisplayName,
  getProfile,
  getUserRole,
  getUserHref,
  formatDateTime,
  highlightAuthor,
  currentUserId,
  viewerPermissions,
  blockedUserIds,
  currentUsername,
  onPostUpdated,
  acceptedPostId,
  canMarkAnswer,
  isUpdatingAnswer,
  onSetAcceptedPost,
  isBlocked,
  onToggleBlockUser,
  onOpenMiniProfileByUserId,
  onOpenMiniProfileByUsername,
  hideForBlocks = false,
}: {
  recycleInfoByPostId?: Record<string, { daysLeft: number; expiresAt: string }>;
  post: ForumPostRow;
  highlightedPostId: number | null;
  depth: number;
  isDepthCapped: boolean;
  onJumpToPostId: (postId: number) => void;
  replyingTo: { postId: number; createdBy: string; displayName: string; href: string } | null;
  onReplyTo: (post: ForumPostRow) => void;
  inlineReplyParentPostId: number | null;
  inlineReplyBody: string;
  inlineReplyError: string | null;
  postingInlineReply: boolean;
  onChangeInlineReplyBody: (v: string) => void;
  onSubmitInlineReply: (parentPostId: number) => void | Promise<void>;
  onCancelInlineReply: () => void;
  handleFlag?: (targetType: "thread" | "post", targetId: string) => void | Promise<void>;
  threadOwnerId?: string | null;
  getKarmaFlash: (userId: string) => number;
  myVote: VoteValue;
  canVote: boolean;
  isVoting: boolean;
  score: number;
  onVote: (postId: number, value: VoteValue) => void;
  voteError: string | null;
  getDisplayName: (userId: string | null | undefined) => string;
  getProfile: (userId: string | null | undefined) => ProfileRow | null;
  getUserRole: (userId: string | null | undefined) => string;
  getUserHref: (userId: string | null | undefined) => string;
  formatDateTime: (value: string | null) => string;
  highlightAuthor?: boolean;
  currentUserId: string | null;
  viewerPermissions: ReadonlySet<string>;
  blockedUserIds: Set<string>;
  currentUsername: string | null;
  onPostUpdated: (post: ForumPostRow) => void;
  acceptedPostId: number | null;
  canMarkAnswer: boolean;
  isUpdatingAnswer: boolean;
  onSetAcceptedPost: (postId: number | null) => void;
  isBlocked: boolean;
  onToggleBlockUser: (targetUserId: string, shouldBlock: boolean) => void | Promise<void>;
  onOpenMiniProfileByUserId: (userId: string | null | undefined) => void;
  onOpenMiniProfileByUsername: (username: string) => void | Promise<void>;
  hideForBlocks?: boolean;
}) {
  const profile = getProfile(post.created_by);
  const displayName = getDisplayName(post.created_by);
  const createdLabel = formatDateTime(post.created_at);
  const updatedLabel =
  post.updated_at && post.updated_at !== post.created_at
    ? formatDateTime(post.updated_at)
    : null;

  // Actions menu (used on mobile + desktop).

  const role = getUserRole(post.created_by);
  const href = getUserHref(post.created_by);
  const isMobile = useIsMobile();

  const replyingUsername = replyingTo
    ? getProfile(replyingTo.createdBy)?.username
    : null;
  const showReplyingToBanner = isDepthCapped && !!replyingTo;


  const isInlineReplyOpen = inlineReplyParentPostId === post.id;
  const inlineComposerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!isInlineReplyOpen) return;
    // Auto-scroll just enough so the composer is fully visible, then focus.
    // ("nearest" isn't enough when the bottom is clipped; we compute the delta.)
    const t = window.setTimeout(() => {
      const root = inlineComposerRef.current;
      if (!root) return;

      const rect = root.getBoundingClientRect();
      const topLimit = 96; // avoid sticking under sticky headers
      const bottomLimit = window.innerHeight - 24;
      let dy = 0;
      if (rect.bottom > bottomLimit) dy = rect.bottom - bottomLimit;
      else if (rect.top < topLimit) dy = rect.top - topLimit;

      if (dy !== 0) window.scrollBy({ top: dy, behavior: "smooth" });

      // Focus after a tick so the scroll/animation has started.
      window.setTimeout(() => {
        const ta = root.querySelector("textarea") as HTMLTextAreaElement | null;
        ta?.focus();
      }, 80);
    }, 50);
    return () => window.clearTimeout(t);
  }, [isInlineReplyOpen]);


  const [isEditing, setIsEditing] = useState(false);
  const [editBody, setEditBody] = useState(post.body_markdown);
  const [editReason, setEditReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const [actionsMenuOpen, setActionsMenuOpen] = useState(false);
  const actionsMenuRef = useRef<HTMLDivElement | null>(null);
  const actionsButtonRef = useRef<HTMLButtonElement | null>(null);
  const actionsMenuPanelRef = useRef<HTMLDivElement | null>(null);
  const [actionsMenuPos, setActionsMenuPos] = useState<{ left: number; top: number } | null>(null);
  const [linkCopied, setLinkCopied] = useState(false);

  const copyLink = async () => {
    try {
      const url = `${window.location.origin}${window.location.pathname}#post-${post.id}`;
      await navigator.clipboard.writeText(url);
      setLinkCopied(true);
      window.setTimeout(() => setLinkCopied(false), 1500);
    } catch {
      // ignore
    }
  };


  useEffect(() => {
    if (!actionsMenuOpen) return;

    // Position the menu using viewport coordinates so it won't be clipped by any overflow/animation wrappers.
    // Recompute on scroll/resize so it "sticks" to the trigger while the page moves.
    let raf = 0;
    const updatePos = () => {
      if (!actionsButtonRef.current) return;
      const r = actionsButtonRef.current.getBoundingClientRect();
      const menuW = 192; // matches w-48
      const pad = 8;
      const left = Math.max(pad, Math.min(r.left, window.innerWidth - menuW - pad));
      const top = Math.min(r.bottom + 8, window.innerHeight - pad);
      setActionsMenuPos({ left, top });
    };
    const scheduleUpdate = () => {
      if (raf) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(updatePos);
    };
    updatePos();

    const onDown: EventListener = (ev) => {
      const target = (ev as Event).target;
      if (!(target instanceof Node)) return;
      if (actionsMenuRef.current && actionsMenuRef.current.contains(target)) return;
      if (actionsMenuPanelRef.current && actionsMenuPanelRef.current.contains(target)) return;
      setActionsMenuOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("touchstart", onDown);
    window.addEventListener("scroll", scheduleUpdate, true);
    window.addEventListener("resize", scheduleUpdate);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("touchstart", onDown);
      window.removeEventListener("scroll", scheduleUpdate, true);
      window.removeEventListener("resize", scheduleUpdate);
      if (raf) cancelAnimationFrame(raf);
      setActionsMenuPos(null);
    };
  }, [actionsMenuOpen]);
  const canEditAny = viewerPermissions.has("community.post.edit");
  const canEditOwn = viewerPermissions.has("community.post.edit.own");
  const canDeleteAny = viewerPermissions.has("community.delete_post");
  const canDeleteOwn = viewerPermissions.has("community.post.delete.own");
  const canRestore = viewerPermissions.has("community.restore_post");
  const isStaffViewer = canDeleteAny || canRestore;

  const canEdit =
    !post.is_deleted &&
    currentUserId != null &&
    (canEditAny || (currentUserId === post.created_by && canEditOwn));

  const canDelete =
    !post.is_deleted &&
    currentUserId != null &&
    (canDeleteAny || (currentUserId === post.created_by && canDeleteOwn));

  const isAccepted = acceptedPostId != null && post.id === acceptedPostId;

  const handleSaveEdit = async () => {
    setLocalError(null);

    const body = editBody.trim();

    const mentionCheck = await validateMentionsAgainstBlocks({
      text: body,
      currentUserId,
      blockedUserIds,
    });

    if (!mentionCheck.ok) {
      setLocalError(mentionCheck.message);
      return;
    }
    if (!body) {
      setLocalError("Body cannot be empty.");
      return;
    }

    try {
      setSaving(true);
      const supabase = supabaseBrowser();
      const {
        data: { session },
        error: sessionError,
      } = await supabase.auth.getSession();

      if (sessionError || !session?.access_token) {
        setLocalError("You must be logged in to edit.");
        setSaving(false);
        return;
      }

      const res = await fetch(`/api/forum/posts/${post.id}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          bodyMarkdown: body,
          editReason: editReason || null,
        }),
      });

      const payload = (await res.json().catch(() => null)) as
        | { ok?: boolean; post?: ForumPostRow; error?: string }
        | null;

      if (!res.ok || !payload?.ok || !payload.post) {
        console.error("Failed to edit post", payload);
        setLocalError(payload?.error ?? "Failed to update post.");
        setSaving(false);
        return;
      }

      onPostUpdated(payload.post);
      setIsEditing(false);
      setSaving(false);
    } catch (err) {
      console.error("Unexpected error editing post", err);
      setLocalError("Unexpected error editing post.");
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    const isStaffDeletingOther = canDeleteAny && currentUserId !== post.created_by;

    // If staff is deleting someone else's content, collect a reason.
    // (If they cancel, we abort.)
    let deleteReason: string | null = null;
    if (isStaffDeletingOther) {
      const input = window.prompt("Reason for deletion (optional)", "Deleted by staff");
      if (input === null) return;
      deleteReason = input.trim() || "Deleted by staff";
    } else {
      if (!window.confirm("Delete this reply?")) return;
      deleteReason = "Deleted by author";
    }

    setLocalError(null);

    try {
      setDeleting(true);
      const supabase = supabaseBrowser();
      const {
        data: { session },
        error: sessionError,
      } = await supabase.auth.getSession();

      if (sessionError || !session?.access_token) {
        setLocalError("You must be logged in to delete.");
        setDeleting(false);
        return;
      }

      const res = await fetch(`/api/forum/posts/${post.id}/delete`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          reason: deleteReason,
        }),
      });

      const payload = (await res.json().catch(() => null)) as
        | { ok?: boolean; post?: ForumPostRow; error?: string }
        | null;

      if (!res.ok || !payload?.ok || !payload.post) {
        console.error("Failed to delete post", payload);
        setLocalError(payload?.error ?? "Failed to delete post.");
        setDeleting(false);
        return;
      }

      onPostUpdated(payload.post);
      setDeleting(false);
    } catch (err) {
      console.error("Unexpected error deleting post", err);
      setLocalError("Unexpected error deleting post.");
      setDeleting(false);
    }
  };

  const handleDeletePost = handleDelete;
  const handleCopyLink = copyLink;

  const showBody = !post.is_deleted && !hideForBlocks;

  const handleToggleAnswer = () => {
    if (!canMarkAnswer || post.is_deleted) return;
    const next = isAccepted ? null : post.id;
    onSetAcceptedPost(next);
  };

  const handleBlockClick = () => {
    if (!currentUserId || post.created_by === currentUserId) return;
    onToggleBlockUser(post.created_by, !isBlocked);
  };

  const isAnchorHighlighted = highlightedPostId != null && post.id === highlightedPostId;

  return (
    <>
      <article
        id={`post-${post.id}`}
        className={
          "rounded-2xl border p-4 " +
          (isAnchorHighlighted
            ? "border-amber-400/70 bg-amber-500/5 shadow-[0_0_0_4px_rgba(251,191,36,0.12)]"
            : highlightAuthor
              ? "border-emerald-500/70 bg-emerald-500/5"
              : "border-zinc-800/80 bg-black/20")
        }
      >
        {showReplyingToBanner && replyingTo ? (
          <button
            type="button"
            onClick={() => onJumpToPostId(replyingTo.postId)}
            className="mb-2 inline-flex max-w-full items-center gap-1 truncate rounded-lg border border-zinc-800 bg-black/20 px-2 py-1 text-[11px] text-brand-textMuted hover:border-zinc-700 hover:text-brand-text"
            title={`Jump to #${replyingTo.postId}`}
          >
            <span className="truncate">
              Replying to{" "}
              <span className="font-medium text-zinc-100">
                @{replyingUsername ?? replyingTo.displayName}
              </span>
            </span>
          </button>
        ) : null}

        <div className="grid grid-cols-1 gap-2 items-stretch md:grid-cols-[110px_12px_1fr]">
          {/* Left rail */}
          <div className="hidden self-stretch flex-col items-center justify-center gap-2 md:flex">
            <button
              type="button"
              onClick={() => onOpenMiniProfileByUserId(post.created_by)}
              className="group flex flex-col items-center gap-2 cursor-pointer"
            >
              <div className="h-16 w-16 overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900/40">
                {profile?.avatar_url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={profile.avatar_url}
                    alt={displayName}
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <div className="flex h-full w-full items-center justify-center text-zinc-400">
                    <span className="text-xl">
                      {(displayName[0] || "?").toUpperCase()}
                    </span>
                  </div>
                )}
              </div>

              <div className="text-center leading-tight">
                <div className="max-w-[100px] truncate text-sm font-semibold text-zinc-100 group-hover:text-white">
                  {displayName}
                  {profile?.is_verified ? <VerifiedBadge className="ml-0.5 h-3 w-3" /> : null}
                  {profile?.donation_rank ? (
                    <DonationBadge rank={profile.donation_rank} className="ml-0.5 h-3 w-3" />
                  ) : null}
                </div>
                {profile?.username ? (
                  <div className="mt-0.5 flex max-w-[100px] items-center justify-center gap-1 truncate text-[11px] text-brand-textMuted">
                    <span className="truncate">@{profile.username}</span>
                  </div>
                ) : null}

                <div className="mt-0.5 flex flex-col items-center gap-0.5 md:mt-1 md:gap-1">
                  <RolePill role={role} />
                  {threadOwnerId && post.created_by === threadOwnerId ? (
                    <span className="inline-flex items-center rounded-full border border-zinc-700 bg-black/40 px-2 py-0.5 text-[10px] text-brand-textMuted">
                      OP
                    </span>
                  ) : null}

                  <div
                    className={
                      "text-[11px] transition-transform duration-300 " +
                      (getKarmaFlash(post.created_by) > 0
                        ? "text-emerald-300 scale-110"
                        : getKarmaFlash(post.created_by) < 0
                          ? "text-rose-300 scale-110"
                          : "text-white/60 scale-100")
                    }
                  >
                    Karma • {getProfile(post.created_by)?.karma ?? 0}
                  </div>
                </div>
              </div>
            </button>
          </div>

          <div className="hidden self-stretch items-stretch justify-center md:flex">
            <div className="my-2 w-px self-stretch rounded-full bg-zinc-800/80 md:my-3" />
          </div>

          {/* Right content */}
          <div className="min-w-0 flex flex-col h-full">
            {isMobile ? (
              <div className="mb-2 flex items-center justify-between gap-2">
                <button
                  type="button"
                  onClick={() => onOpenMiniProfileByUserId(post.created_by)}
                  className="flex min-w-0 items-center gap-2 text-left cursor-pointer"
                >
                  <div className="h-8 w-8 overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900/40 flex-none">
                    {profile?.avatar_url ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={profile.avatar_url} alt={displayName} className="h-full w-full object-cover" />
                    ) : (
                      <div className="flex h-full w-full items-center justify-center text-zinc-400">
                        <span className="text-sm">{(displayName[0] || "?").toUpperCase()}</span>
                      </div>
                    )}
                  </div>

                  <div className="min-w-0">
                    <div className="flex items-center gap-1 min-w-0">
                      <span className="max-w-[190px] truncate text-[13px] font-semibold text-zinc-100">{displayName}</span>
                      {profile?.is_verified ? <VerifiedBadge className="h-3 w-3" /> : null}
                      {profile?.donation_rank ? <DonationBadge rank={profile.donation_rank} className="h-3 w-3" /> : null}
                    </div>
                    {profile?.username ? (
                      <div className="mt-0.5 flex max-w-[220px] items-center gap-1 truncate text-[11px] text-brand-textMuted">
                        <span className="truncate">@{profile.username}</span>
                        <RolePill role={role} />
                        {threadOwnerId && post.created_by === threadOwnerId ? (
                          <span className="inline-flex items-center rounded-full border border-zinc-700 bg-black/30 px-2 py-0.5 text-[10px] text-brand-textMuted">
                            OP
                          </span>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                </button>
              </div>
            ) : null}

          <div className="mb-2 flex flex-wrap items-start justify-between gap-2">
            <div className="text-[10px] text-brand-textMuted">
              {createdLabel}
              {updatedLabel && (
                <span className="ml-1 text-zinc-500">(edited {updatedLabel})</span>
              )}
            </div>
            <div className="flex items-center justify-end gap-2 text-[10px] text-brand-textMuted" />
          </div>

          {post.is_deleted ? (
            <div className="rounded-xl border border-zinc-800 bg-black/25 p-4 text-[11px] text-zinc-500">
              <div className="flex items-center justify-between gap-2">
                <span className="italic">This reply was deleted.</span>
                {isStaffViewer && recycleInfoByPostId?.[String(post.id)] ? (
                  <span className="rounded-full border border-amber-400/30 bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium text-amber-200">
                    {`Soft delete • ${recycleInfoByPostId[String(post.id)]!.daysLeft}d left`}
                  </span>
                ) : null}
              </div>

              {/* Author undo window (5 min) */}
              {!isStaffViewer && currentUserId && currentUserId === post.created_by && post.updated_at ? (
                (() => {
                  // Time window enforced server-side
                  const canUndo = true;
                  return (
                    <button
                      type="button"
                      onClick={async () => {
                        try {
                          const supabase = supabaseBrowser();
                          const { data: sessData } = await supabase.auth.getSession();
                          const token = sessData?.session?.access_token ?? null;
                          if (!token) return;
                          const res = await fetch(`/api/forum/posts/${post.id}/restore`, {
                            method: "POST",
                            headers: { Authorization: `Bearer ${token}` },
                          });
                          if (res.ok) {
                            // Simple refresh to pull updated post state
                            window.location.reload();
                          }
                        } catch {
                          // ignore
                        }
                      }}
                      className="mt-2 rounded-full border border-zinc-700 bg-black/40 px-3 py-1 text-[11px] text-amber-200 hover:border-amber-400/60"
                    >
                      Undo delete
                    </button>
                  );
                })()
              ) : null}
            </div>
          ) : hideForBlocks ? (
            <div className="rounded-xl border border-zinc-800 bg-black/25 p-4 text-[11px] italic text-zinc-500">
              {isBlocked
                ? "You\'ve blocked this user. Their content is hidden."
                : "You can\'t view this content because this user has blocked you."}
            </div>
          ) : isEditing ? (
            <div className="space-y-2">
              <MentionTextarea
                value={editBody}
                onChange={setEditBody}
                rows={4}
                disabled={saving}
                makeUserHref={(username) => `/user/@${username}`}
                currentUserId={currentUserId}
                blockedUserIds={blockedUserIds}
                className="w-full no-zoom-input rounded-xl border border-zinc-700 bg-black/40 px-3 py-2 text-[12px] text-brand-text outline-none placeholder:text-brand-textMuted focus:border-amber-400"
              />
              <input
                type="text"
                value={editReason}
                onChange={(e) => setEditReason(e.target.value)}
                placeholder="Edit reason (optional)"
                className="w-full no-zoom-input rounded-xl border border-zinc-700 bg-black/40 px-3 py-2 text-[11px] text-brand-text outline-none placeholder:text-brand-textMuted focus:border-amber-400"
              />
              {localError && (
                <p className="text-[11px] text-rose-300">{localError}</p>
              )}
              <div className="flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setIsEditing(false);
                    setLocalError(null);
                  }}
                  className="rounded-full border border-zinc-700 bg-black/40 px-3 py-1 text-[11px] text-brand-textMuted hover:text-brand-text"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleSaveEdit}
                  disabled={saving}
                  className="rounded-full border border-amber-400/80 bg-amber-500/20 px-3 py-1 text-[11px] font-medium text-amber-300 hover:bg-amber-500/25 disabled:opacity-60"
                >
                  {saving ? "Saving…" : "Save"}
                </button>
              </div>
            </div>
          ) : (
            <div className="rounded-xl">
              <MarkdownContent
                markdown={showBody ? post.body_markdown : ""}
                makeUserHref={(username) => `/user/@${username}`}
                onUserClick={(username) => void onOpenMiniProfileByUsername(username)}
                className="text-[12px] leading-relaxed text-brand-text"
              />
            </div>
          )}

          {post.edit_reason && !post.is_deleted && !hideForBlocks && (
            <div className="mt-2 text-[10px] text-zinc-500">
              Edit reason: {post.edit_reason}
            </div>
          )}
          {post.is_deleted && post.edit_reason && (
            <div className="mt-2 text-[10px] text-zinc-500">{post.edit_reason}</div>
          )}

          {/* Footer actions */}
          <div className={cn("mt-auto flex items-center justify-end gap-3")}>
            {currentUserId && !post.is_deleted ? (
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => onReplyTo(post)}
                  aria-label="Reply"
                  className="inline-flex items-center justify-center text-zinc-300 hover:text-white"
                >
                  <FontAwesomeIcon icon={faReply} className="h-4 w-4" />
                </button>

                <div ref={actionsMenuRef} className="relative">
                  <button
                    type="button"
                    aria-label="Post actions"
                    ref={actionsButtonRef}
                    onClick={() => setActionsMenuOpen((v) => !v)}
                    className="inline-flex items-center justify-center text-zinc-300 hover:text-white"
                  >
                    <FontAwesomeIcon icon={faSquarePollHorizontal} className="h-4 w-4" />
                  </button>

                  {actionsMenuOpen && actionsMenuPos && typeof document !== "undefined"
                    ? createPortal(
                        <div
                          ref={actionsMenuPanelRef}
                          className="z-[2147483647] w-48 overflow-hidden rounded-xl border border-zinc-700 bg-zinc-950 shadow-lg"
                          style={{ position: "fixed", left: actionsMenuPos.left, top: actionsMenuPos.top, zIndex: 2147483647 }}
                        >
                          <div className="flex flex-col py-1 text-sm">
                            {canMarkAnswer && !post.is_deleted && (
                              <button
                                type="button"
                                onClick={() => { void handleToggleAnswer(); setActionsMenuOpen(false); }}
                                disabled={isUpdatingAnswer}
                                className="w-full px-3 py-2 text-left text-zinc-100 hover:bg-zinc-900 disabled:opacity-60"
                              >
                                {isAccepted ? "Unmark answer" : "Mark as answer"}
                              </button>
                            )}

                            {currentUserId && post.created_by !== currentUserId && !post.is_deleted ? (
                              <>
                                {isStaffViewer ? (
                                  <button
                                    type="button"
                                    onClick={() => { void handleFlag("post", String(post.id)); setActionsMenuOpen(false); }}
                                    className="w-full px-3 py-2 text-left text-zinc-100 hover:bg-zinc-900"
                                  >
                                    Flag
                                  </button>
                                ) : null}
                                <button
                                  type="button"
                                  onClick={() => { setReportOpen(true); setActionsMenuOpen(false); }}
                                  className="w-full px-3 py-2 text-left text-zinc-100 hover:bg-zinc-900"
                                >
                                  Report
                                </button>
                              </>
                            ) : null}

                            {canEdit && !post.is_deleted && !isEditing ? (
                              <button
                                type="button"
                                onClick={() => {
                                  setIsEditing(true);
                                  setEditBody(post.body_markdown);
                                  setEditReason("");
                                  setActionsMenuOpen(false);
                                }}
                                className="w-full px-3 py-2 text-left text-zinc-100 hover:bg-zinc-900"
                              >
                                Edit
                              </button>
                            ) : null}

                            {canDelete && !post.is_deleted ? (
                              <button
                                type="button"
                                onClick={() => { void handleDeletePost(); setActionsMenuOpen(false); }}
                                className="w-full px-3 py-2 text-left text-rose-200 hover:bg-zinc-900"
                              >
                                Delete
                              </button>
                            ) : null}

                            <button
                              type="button"
                              onClick={() => { void handleCopyLink(); setActionsMenuOpen(false); }}
                              className="w-full px-3 py-2 text-left text-zinc-100 hover:bg-zinc-900"
                            >
                              Copy link
                            </button>
                          </div>
                        </div>,
                        document.body
                      )
                    : null}
                </div>
              </div>
            ) : null}

            <VoteControls
              postId={post.id}
              myVote={myVote}
              canVote={canVote}
              isVoting={isVoting}
              score={score}
              onVote={onVote}
              voteError={voteError}
            />
          </div>

          {/* Inline reply (reply-to-post) — placed under action row, animated like the reply-collapse */}
          {!post.is_deleted && !hideForBlocks ? (
            <div
              className={cn(
                "grid transition-[grid-template-rows] duration-200 ease-out",
                isInlineReplyOpen ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
              )}
            >
              <div
                className={cn(
                  "min-h-0 overflow-hidden transition-[opacity,transform] duration-200 ease-out",
                  isInlineReplyOpen
                    ? "opacity-100 translate-y-0"
                    : "pointer-events-none opacity-0 -translate-y-1"
                )}
              >
                <div
                  ref={inlineComposerRef}
                  className="mt-4 rounded-xl border border-zinc-800 bg-black/30 p-3"
                >
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <div className="text-[11px] font-semibold text-brand-text">Reply</div>
                  </div>

                  <MentionTextarea
                    value={inlineReplyBody}
                    onChange={onChangeInlineReplyBody}
                    placeholder="Write a reply…"
                    rows={4}
                    disabled={postingInlineReply}
                    makeUserHref={(username) => `/user/@${username}`}
                    currentUserId={currentUserId}
                    blockedUserIds={blockedUserIds}
                    className="no-zoom-input w-full rounded-xl py-2 text-[12px] text-brand-text outline-none placeholder:text-brand-textMuted focus:border-amber-400"
                  />

                  {inlineReplyError ? (
                    <p className="mt-2 text-[11px] text-rose-300">{inlineReplyError}</p>
                  ) : null}

                  <div className="mt-2 flex items-center justify-end gap-2">
                    <button
                      type="button"
                      onClick={onCancelInlineReply}
                      disabled={postingInlineReply}
                      className="inline-flex items-center justify-center rounded-full border border-zinc-700 bg-black/40 px-5 py-2 text-[11px] font-medium text-brand-textMuted hover:border-zinc-500 hover:text-brand-text disabled:opacity-60"
                    >
                      Cancel
                    </button>

                    <button
                      type="button"
                      onClick={() => void onSubmitInlineReply(post.id)}
                      disabled={postingInlineReply}
                      className="inline-flex items-center justify-center rounded-full border border-amber-400/80 bg-amber-500/20 px-5 py-2 text-[11px] font-medium text-amber-300 hover:bg-amber-500/25 disabled:opacity-60"
                    >
                      {postingInlineReply ? "Posting…" : "Post reply"}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          ) : null}
          </div>
        </div>
      </article>

      <ReportModal
        open={reportOpen}
        title="Report post"
        description="This creates a private conversation with staff."
        targetType="forum_post"
        targetId={String(post.id)}
        onClose={() => setReportOpen(false)}
      />
    </>
  );
}
