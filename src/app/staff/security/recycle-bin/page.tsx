"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";

import { MenuSelect } from "@/components/ui/MenuSelect";
import { MarkdownContent } from "@/components/MarkdownContent";
import { VerifiedBadge } from "@/components/VerifiedBadge";
import { DonationBadge } from "@/components/DonationBadge";
import { RolePill } from "@/components/RolePill";

import { supabaseBrowser } from "@/lib/supabaseClient";

type RoleRow = { role: string };

type ProfileLite = {
  id: string;
  username: string | null;
  display_name: string | null;
  avatar_url?: string | null;
  is_verified?: boolean | null;
  donation_rank?: string | null;
};

type RecycleBinRow = {
  id: string;
  item_type: "thread" | "post" | "dm_message";
  original_table: string;
  original_id: string;
  deleted_by: string | null;
  deleted_at: string;
  expires_at: string;
  payload: Record<string, unknown> | null;
};

type SortKey = "deleted_at" | "expires_at" | "type";

function formatWhen(iso: string) {
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? d.toLocaleString() : iso;
}

export default function StaffRecycleBinPage() {
  const PAGE_SIZE = 50;
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [items, setItems] = useState<RecycleBinRow[]>([]);
  const [totalCount, setTotalCount] = useState<number>(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [profiles, setProfiles] = useState<Record<string, ProfileLite>>({});
  const [actorRole, setActorRole] = useState<string | null>(null);
  const [restoringId, setRestoringId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [rawOpenById, setRawOpenById] = useState<Record<string, boolean>>({});

  const [search, setSearch] = useState<string>("");
  const [sortKey, setSortKey] = useState<SortKey>("deleted_at");
  const [sortDir, setSortDir] = useState<"desc" | "asc">("desc");

  const canView = actorRole === "admin" || actorRole === "moderator" || actorRole === "support";
  const canRestore = actorRole === "admin" || actorRole === "moderator";

  const canLoadMore = canView && totalCount > 0 && items.length < totalCount;

  const getProfileLabel = (p: ProfileLite | undefined) => {
    const handle = p?.username ? `@${p.username}` : null;
    const name = p?.display_name ?? null;
    return handle ?? name ?? "Unknown";
  };

  const getProfileDisplay = (p: ProfileLite | undefined) => {
    const username = p?.username ? `@${p.username}` : null;
    const name = p?.display_name ?? null;
    return username ?? name ?? "Unknown";
  };

  const renderAvatar = (p: ProfileLite | undefined) => {
    const letter = (p?.display_name ?? p?.username ?? "?").trim().charAt(0).toUpperCase();
    const url = p?.avatar_url ?? null;
    return (
      <div className="h-11 w-11 overflow-hidden rounded-full border border-zinc-700 bg-black/40">
        {url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={url} alt="" className="h-full w-full object-cover" />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-sm font-semibold text-zinc-200">
            {letter || "?"}
          </div>
        )}
      </div>
    );
  };

  const getBodyMarkdown = (row: RecycleBinRow): string | null => {
    const p = row.payload ?? {};
    if (typeof (p as any).body_markdown === "string") return String((p as any).body_markdown);
    if (typeof (p as any).first_post_body_markdown === "string") return String((p as any).first_post_body_markdown);
    return null;
  };

  const getTitle = (row: RecycleBinRow): string | null => {
    const p = row.payload ?? {};
    if (typeof (p as any).title === "string") return String((p as any).title);
    return null;
  };

  const getAvatarLetter = (p: ProfileLite | undefined) => {
    const handle = p?.username ?? p?.display_name ?? "?";
    const ch = handle.trim().charAt(0);
    return ch ? ch.toUpperCase() : "?";
  };

  const getTargetUserId = (row: RecycleBinRow): string | null => {
    const p = row.payload ?? {};
    const candidates = [
      (p as any).created_by,
      (p as any).createdBy,
      (p as any).user_id,
      (p as any).userId,
      (p as any).sender_id,
      (p as any).senderId,
    ];
    for (const c of candidates) {
      if (typeof c === "string" && c.length > 0) return c;
    }
    return null;
  };

  const getPayloadSummary = (row: RecycleBinRow) => {
    const p = row.payload ?? {};
    if (row.item_type === "thread") {
      const title = typeof (p as any).title === "string" ? (p as any).title : null;
      const slug = typeof (p as any).slug === "string" ? (p as any).slug : null;
      return {
        title: title ?? "(thread)",
        subtitle: slug ? `slug: ${slug}` : null,
        body:
          typeof (p as any).body_markdown === "string"
            ? String((p as any).body_markdown).slice(0, 500)
            : null,
      };
    }
    if (row.item_type === "post") {
      const threadId = (p as any).thread_id ?? null;
      return {
        title: threadId ? `Post in thread #${threadId}` : "(post)",
        subtitle:
          typeof (p as any).delete_reason === "string" && (p as any).delete_reason.length
            ? `reason: ${(p as any).delete_reason}`
            : null,
        body:
          typeof (p as any).body_markdown === "string"
            ? String((p as any).body_markdown).slice(0, 500)
            : null,
      };
    }
    return {
      title: row.item_type,
      subtitle: null,
      body: null,
    };
  };

  const getAuthHeaders = async (): Promise<Record<string, string>> => {
    const supabase = supabaseBrowser();
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    return {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
  };

  const fetchPage = async (offset: number) => {
    const supabase = supabaseBrowser();

    // Best-effort: table might not exist yet.
    const { data, error, count } = await supabase
      .from("moderation_recycle_bin")
      .select("id, item_type, original_table, original_id, deleted_by, deleted_at, expires_at, payload", {
        count: "exact",
      })
      .order("deleted_at", { ascending: false })
      .range(offset, offset + PAGE_SIZE - 1);

    if (error) {
      console.error("recycle bin load error", error);
      throw error;
    }

    setTotalCount(typeof count === "number" ? count : 0);
    return (data ?? []) as RecycleBinRow[];
  };

  useEffect(() => {
    const supabase = supabaseBrowser();

    const load = async () => {
      try {
        setLoading(true);
        setErrorMessage(null);

        const { data: userData } = await supabase.auth.getUser();
        const user = userData?.user ?? null;
        if (!user) {
          setErrorMessage("You must be logged in.");
          return;
        }

        const { data: roleRow, error: roleErr } = await supabase
          .from("user_roles")
          .select("role")
          .eq("user_id", user.id)
          .maybeSingle<RoleRow>();

        if (roleErr || !roleRow) {
          setActorRole("member");
          setErrorMessage("Forbidden.");
          return;
        }

        setActorRole(roleRow.role);

        if (!["admin", "moderator", "support"].includes(roleRow.role)) {
          setErrorMessage("Forbidden.");
          return;
        }

        const first = await fetchPage(0);
        setItems(first);
      } catch (err) {
        setErrorMessage(
          "Recycle bin table is not deployed yet (moderation_recycle_bin). Add the table + policy and redeploy."
        );
        setItems([]);
        setTotalCount(0);
      } finally {
        setLoading(false);
      }
    };

    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadMore = async () => {
    if (!canLoadMore || loadingMore) return;
    try {
      setLoadingMore(true);
      const next = await fetchPage(items.length);
      setItems((prev) => [...prev, ...next]);
    } catch {
      // noop
    } finally {
      setLoadingMore(false);
    }
  };

  useEffect(() => {
    const supabase = supabaseBrowser();

    const loadProfiles = async () => {
      if (!canView) return;
      const ids = new Set<string>();
      for (const i of items) {
        if (i.deleted_by) ids.add(i.deleted_by);
        const t = getTargetUserId(i);
        if (t) ids.add(t);
      }

      const need = Array.from(ids).filter((id) => !profiles[id]);
      if (!need.length) return;

      const { data } = await supabase
        .from("profiles")
        .select("id, username, display_name, avatar_url, is_verified, donation_rank")
        .in("id", need);
      setProfiles((prev) => {
        const next = { ...prev };
        for (const p of (data ?? []) as ProfileLite[]) next[p.id] = p;
        return next;
      });
    };

    void loadProfiles();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, canView]);

  const activeItems = useMemo(() => {
    const now = Date.now();
    return items.filter((i) => new Date(i.expires_at).getTime() > now);
  }, [items]);

  const filteredItems = useMemo(() => {
    const q = search.trim().toLowerCase();
    const base = [...activeItems];

    const passSearch = (row: RecycleBinRow) => {
      if (!q) return true;
      const deleter = row.deleted_by ? profiles[row.deleted_by] : undefined;
      const targetId = getTargetUserId(row);
      const target = targetId ? profiles[targetId] : undefined;
      const summary = getPayloadSummary(row);

      const hay = [
        row.item_type,
        row.original_table,
        row.original_id,
        deleter?.username ?? "",
        deleter?.display_name ?? "",
        target?.username ?? "",
        target?.display_name ?? "",
        summary.title ?? "",
        summary.subtitle ?? "",
        summary.body ?? "",
      ]
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    };

    const out = base.filter(passSearch);

    out.sort((a, b) => {
      if (sortKey === "type") {
        const va = a.item_type;
        const vb = b.item_type;
        return sortDir === "asc" ? va.localeCompare(vb) : vb.localeCompare(va);
      }
      if (sortKey === "expires_at") {
        const ta = new Date(a.expires_at).getTime();
        const tb = new Date(b.expires_at).getTime();
        return sortDir === "asc" ? ta - tb : tb - ta;
      }
      const ta = new Date(a.deleted_at).getTime();
      const tb = new Date(b.deleted_at).getTime();
      return sortDir === "asc" ? ta - tb : tb - ta;
    });

    return out;
  }, [activeItems, search, sortKey, sortDir, profiles]);

  const handleRestore = async (id: string) => {
    try {
      setRestoringId(id);
      setErrorMessage(null);

      const res = await fetch("/api/staff/moderation/recycle-bin/restore", {
        method: "POST",
        headers: await getAuthHeaders(),
        body: JSON.stringify({ id }),
      });

      const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) {
        const msg = typeof json.error === "string" ? json.error : "Failed to restore.";
        setErrorMessage(msg);
        return;
      }

      // Optimistic remove
      setItems((prev) => prev.filter((x) => x.id !== id));
    } finally {
      setRestoringId(null);
    }
  };

  const renderSnapshotPreview = (row: RecycleBinRow) => {
    const p = (row.payload ?? {}) as any;
    const createdBy: string | null = typeof p.created_by === "string" ? p.created_by : null;
    const author = createdBy ? profiles[createdBy] : undefined;
    const createdAt = typeof p.created_at === "string" ? p.created_at : row.deleted_at;
    const body = typeof p.body_markdown === "string" ? String(p.body_markdown) : null;

    if (row.item_type === "thread") {
      const title = typeof p.title === "string" ? p.title : "(thread)";
      const firstBody = typeof p.first_post_body_markdown === "string" ? String(p.first_post_body_markdown) : null;

      return (
        <div className="rounded-xl border border-zinc-800 bg-black/40">
          <div className="border-b border-zinc-800 px-4 py-3">
            <div className="text-[11px] uppercase tracking-[0.12em] text-zinc-500">Thread snapshot</div>
            <div className="mt-1 text-base font-semibold text-brand-text">{title}</div>
          </div>

          <div className="flex gap-4 px-4 py-4">
            <div className="w-12">
              <div className="h-12 w-12 overflow-hidden rounded-full border border-zinc-800 bg-black/60 flex items-center justify-center text-sm text-zinc-200">
                {author?.avatar_url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img alt="" src={author.avatar_url} className="h-full w-full object-cover" />
                ) : (
                  <span className="font-semibold">{getAvatarLetter(author)}</span>
                )}
              </div>
            </div>

            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                {createdBy ? (
                  <Link href={`/user/${createdBy}`} className="font-semibold text-amber-200 hover:underline">
                    {getProfileLabel(author)}
                  </Link>
                ) : (
                  <span className="font-semibold text-zinc-300">Unknown</span>
                )}
                {author?.is_verified ? <VerifiedBadge /> : null}
                {author?.donation_rank ? <DonationBadge rank={author.donation_rank as any} /> : null}
                {/* Role is not always available in profiles; keep pill slot for consistency */}
              </div>

              <div className="mt-1 text-[12px] text-zinc-400">Created: {formatWhen(createdAt)}</div>
              {firstBody ? (
                <div className="mt-3 border-l border-zinc-800 pl-4">
                  <MarkdownContent className="prose prose-invert max-w-none text-[13px]" markdown={firstBody} />
                </div>
              ) : (
                <div className="mt-3 text-sm text-zinc-400">No first post snapshot was captured.</div>
              )}
            </div>
          </div>
        </div>
      );
    }

    // post
    return (
      <div className="rounded-xl border border-zinc-800 bg-black/40">
        <div className="flex gap-4 px-4 py-4">
          <div className="w-12">
            <div className="h-12 w-12 overflow-hidden rounded-full border border-zinc-800 bg-black/60 flex items-center justify-center text-sm text-zinc-200">
              {author?.avatar_url ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img alt="" src={author.avatar_url} className="h-full w-full object-cover" />
              ) : (
                <span className="font-semibold">{getAvatarLetter(author)}</span>
              )}
            </div>
          </div>

          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              {createdBy ? (
                <Link href={`/user/${createdBy}`} className="font-semibold text-amber-200 hover:underline">
                  {getProfileLabel(author)}
                </Link>
              ) : (
                <span className="font-semibold text-zinc-300">Unknown</span>
              )}
              {author?.is_verified ? <VerifiedBadge /> : null}
              {author?.donation_rank ? <DonationBadge rank={author.donation_rank as any} /> : null}
            </div>

            <div className="mt-1 text-[12px] text-zinc-400">Posted: {formatWhen(createdAt)}</div>

            {body ? (
              <div className="mt-3 border-l border-zinc-800 pl-4">
                <MarkdownContent className="prose prose-invert max-w-none text-[13px]" markdown={body} />
              </div>
            ) : (
              <div className="mt-3 text-sm text-zinc-400">No body snapshot was captured.</div>
            )}
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="mx-auto w-full max-w-6xl p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <p className="text-[11px] uppercase tracking-[0.15em] text-brand-textMuted">Admin • Security</p>
          <h1 className="text-xl font-semibold text-brand-text">Recycle Bin</h1>
          <p className="text-sm text-zinc-400">
            Deleted threads/posts/messages are kept for 30 days so staff can undo mistakes.
          </p>
          {/* Sidebar navigation already provides ... */}
        </div>
      </div>

      {canView ? (
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search recycle bin…"
            className="no-zoom-input h-8 w-full max-w-xs rounded-md border border-zinc-700 bg-black/60 px-2 text-[12px] text-brand-text outline-none placeholder:text-zinc-500 focus:border-amber-400"
          />
          <MenuSelect
            ariaLabel="Sort by"
            value={sortKey}
            onChange={(next) => setSortKey(next as SortKey)}
            className="flex h-8 items-center gap-2 rounded-md border border-zinc-700 bg-black/60 px-2 text-[11px] text-brand-text outline-none transition hover:border-amber-400/70"
            options={[
              { value: "deleted_at", label: "Sort: Deleted" },
              { value: "expires_at", label: "Sort: Expires" },
              { value: "type", label: "Sort: Type" },
            ]}
          />
          <button
            type="button"
            onClick={() => setSortDir((p) => (p === "desc" ? "asc" : "desc"))}
            className="inline-flex h-8 items-center rounded-md border border-zinc-700 bg-black/60 px-3 text-[11px] text-brand-textMuted hover:border-amber-400 hover:text-brand-text"
          >
            {sortDir === "desc" ? "Newest" : "Oldest"}
          </button>
          <div className="text-[11px] text-brand-textMuted">
            Showing {Math.min(items.length, totalCount)} out of {totalCount}
            {search.trim() ? (
              <span className="ml-1 text-zinc-500">
                • {filteredItems.length} match
              </span>
            ) : null}
          </div>
        </div>
      ) : null}

      {!canView && !loading && (
        <div className="rounded-lg border border-zinc-800 bg-black/40 p-3 text-sm text-red-300">{errorMessage ?? "Forbidden."}</div>
      )}

      {canView && errorMessage && (
        <div className="mb-3 rounded-lg border border-zinc-800 bg-black/40 p-3 text-sm text-amber-200">{errorMessage}</div>
      )}

      {loading ? (
        <div className="rounded-lg border border-zinc-800 bg-black/40 p-3 text-sm text-zinc-300">Loading…</div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-zinc-800 bg-black/30">
          <div className="grid grid-cols-12 gap-2 border-b border-zinc-800 bg-black/40 px-3 py-2 text-[12px] text-zinc-400">
            <div className="col-span-2">Type</div>
            <div className="col-span-3">Original</div>
            <div className="col-span-2">Deleted By</div>
            <div className="col-span-2">Target</div>
            <div className="col-span-1">Deleted At</div>
            <div className="col-span-1">Expires At</div>
            <div className="col-span-1 text-right">Action</div>
          </div>

          {filteredItems.length === 0 ? (
            <div className="px-3 py-4 text-sm text-zinc-400">No items in the recycle bin.</div>
          ) : (
            filteredItems.map((i) => {
              const deleter = i.deleted_by ? profiles[i.deleted_by] : undefined;
              const targetId = getTargetUserId(i);
              const target = targetId ? profiles[targetId] : undefined;
              const summary = getPayloadSummary(i);
              const isExpanded = expandedId === i.id;

              return (
                <div key={i.id} className="border-t border-zinc-800">
                  <div className="grid grid-cols-12 gap-2 px-3 py-2 text-sm text-brand-text">
                    <button
                      type="button"
                      onClick={() => setExpandedId((prev) => (prev === i.id ? null : i.id))}
                      className="col-span-2 flex items-center gap-2 text-left text-brand-text hover:text-amber-200"
                    >
                      <span className="inline-flex h-5 w-5 items-center justify-center rounded-md border border-zinc-700 bg-black/40 text-[10px] text-zinc-300">
                        {isExpanded ? "−" : "+"}
                      </span>
                      <span>{i.item_type}</span>
                    </button>

                    <div className="col-span-3">
                      <div className="font-mono text-[12px] text-zinc-300">
                        {i.original_table}:{i.original_id}
                      </div>
                      <div className="text-[12px] text-zinc-400">{summary.title}</div>
                      {summary.subtitle ? <div className="text-[11px] text-zinc-500">{summary.subtitle}</div> : null}
                    </div>

                    <div className="col-span-2 text-zinc-300">
                      {i.deleted_by ? (
                        <Link
                          href={`/user/${i.deleted_by}`}
                          className="text-amber-200 hover:underline"
                        >
                          {getProfileLabel(deleter)}
                        </Link>
                      ) : (
                        "—"
                      )}
                    </div>

                    <div className="col-span-2 text-zinc-300">
                      {targetId ? (
                        <Link
                          href={`/user/${targetId}`}
                          className="text-amber-200 hover:underline"
                        >
                          {getProfileLabel(target)}
                        </Link>
                      ) : (
                        "—"
                      )}
                    </div>

                    <div className="col-span-1 text-zinc-300">{formatWhen(i.deleted_at)}</div>
                    <div className="col-span-1 text-zinc-300">
                      {formatWhen(i.expires_at)}
                      <span className="ml-2 text-[11px] text-amber-200">
                        • {Math.max(0, Math.ceil((new Date(i.expires_at).getTime() - Date.now()) / (1000 * 60 * 60 * 24)))}d left
                      </span>
                    </div>

                    <div className="col-span-1 flex justify-end gap-2">
                      {canRestore ? (
                        <button
                          onClick={() => void handleRestore(i.id)}
                          disabled={restoringId === i.id}
                          className="rounded-md border border-zinc-700 bg-zinc-900/60 px-2 py-1 text-[12px] text-amber-200 hover:bg-zinc-900 disabled:opacity-50"
                        >
                          {restoringId === i.id ? "Restoring…" : "Undo"}
                        </button>
                      ) : null}
                    </div>
                  </div>

                  {isExpanded ? (
                    <div className="bg-black/25 px-3 pb-3">
                      <div className="space-y-3 rounded-lg border border-zinc-800 bg-black/40 p-3">
                        <div>
                          <div className="text-[11px] uppercase tracking-[0.12em] text-zinc-500">Snapshot preview</div>
                          <div className="mt-2">{renderSnapshotPreview(i)}</div>
                        </div>

                        <div>
                          <button
                            type="button"
                            onClick={() =>
                              setRawOpenById((prev) => ({ ...prev, [i.id]: !prev[i.id] }))
                            }
                            className="inline-flex items-center gap-2 rounded-md border border-zinc-800 bg-black/60 px-3 py-2 text-[12px] text-zinc-200 hover:border-amber-400/60"
                          >
                            <span className="font-mono">{rawOpenById[i.id] ? "−" : "+"}</span>
                            View raw snapshot JSON
                          </button>

                          {rawOpenById[i.id] ? (
                            <pre className="mt-2 max-h-64 overflow-auto rounded-md border border-zinc-800 bg-black/60 p-2 text-[11px] text-zinc-400">
                              {JSON.stringify(i.payload ?? {}, null, 2)}
                            </pre>
                          ) : null}
                        </div>
                      </div>
                    </div>
                  ) : null}
                </div>
              );
            })
          )}
        </div>
      )}

      {canView && !loading && canLoadMore ? (
        <div className="mt-3 flex justify-center">
          <button
            type="button"
            disabled={loadingMore}
            onClick={loadMore}
            className="inline-flex h-9 items-center rounded-md border border-zinc-700 bg-black/60 px-4 text-[12px] text-brand-text hover:border-amber-400 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {loadingMore ? "Loading…" : `Load ${PAGE_SIZE} more`}
          </button>
        </div>
      ) : null}
    </div>
  );
}
