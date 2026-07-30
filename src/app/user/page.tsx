"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { supabaseBrowser } from "@/lib/supabaseClient";
import { RolePill } from "@/components/RolePill";
import { DonationBadge } from "@/components/DonationBadge";
import { VerifiedBadge } from "@/components/VerifiedBadge";

type UserRow = {
  id: string;
  username: string | null;
  display_name: string | null;
  avatar_url: string | null;
  karma?: number | null;
  last_seen_at?: string | null;
  role?: string | null;
  donation_rank?: string | null;
  is_verified?: boolean | null;
};

export default function UserDirectoryPage() {
  const [viewerId, setViewerId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(20);
  const [rows, setRows] = useState<UserRow[]>([]);
  const [hasMore, setHasMore] = useState(false);

  useEffect(() => {
    const supabase = supabaseBrowser();
    void supabase.auth.getUser().then(({ data }) => setViewerId(data.user?.id ?? null));
  }, []);

  const normalizedQuery = useMemo(() => (query ?? "").trim(), [query]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        setLoading(true);
        setError(null);

        const supabase = supabaseBrowser();
        const take = limit;
        const realTake = take + 1;

        let q = supabase
          .from("profiles")
          .select("id, username, display_name, avatar_url, karma, last_seen_at, role, donation_rank, is_verified")
          .order("last_seen_at", { ascending: false, nullsFirst: false })
          .order("created_at", { ascending: false })
          .limit(realTake);

        if (normalizedQuery) {
          const esc = normalizedQuery.replace(/%/g, "\\%").replace(/_/g, "\\_");
          q = q.or(
            `username.ilike.%${esc}%,display_name.ilike.%${esc}%,id.ilike.%${esc}%`
          );
        }

        const { data, error: err } = await q;
        if (err) {
          console.error("user directory load failed", err);
          if (!cancelled) {
            setError("Failed to load users.");
            setRows([]);
            setHasMore(false);
          }
          return;
        }

        const raw = (data ?? []) as UserRow[];
        const more = raw.length > take;
        const nextRows = more ? raw.slice(0, take) : raw;

        if (!cancelled) {
          setRows(nextRows);
          setHasMore(more);
        }
      } catch (e) {
        console.error("user directory load unexpected", e);
        if (!cancelled) {
          setError("Unexpected error loading users.");
          setRows([]);
          setHasMore(false);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [limit, normalizedQuery]);

  return (
    <div className="mx-auto max-w-5xl px-5 py-8">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="text-xl font-semibold text-brand-text">Users</div>
          <div className="mt-1 text-sm text-brand-textMuted">
            Search by display name, @username, or id.
          </div>
        </div>
        {viewerId ? (
          <Link
            href={`/user/${viewerId}`}
            className="rounded-full border border-zinc-700 bg-black/40 px-4 py-2 text-[12px] text-brand-textMuted hover:border-amber-400/70 hover:text-brand-text"
          >
            My profile
          </Link>
        ) : null}
      </div>

      <div className="mb-4 rounded-xl border border-zinc-800/80 bg-black/40 p-3">
        <input
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setLimit(20);
          }}
          placeholder="Search users…"
          className="no-zoom-input w-full rounded-md border border-zinc-700 bg-black/60 px-3 py-2 text-[13px] text-brand-text outline-none placeholder:text-zinc-500"
        />
      </div>

      {error ? (
        <div className="rounded-xl border border-rose-500/40 bg-rose-500/10 p-4 text-[12px] text-rose-200">
          {error}
        </div>
      ) : loading ? (
        <div className="text-[12px] text-brand-textMuted">Loading users…</div>
      ) : rows.length === 0 ? (
        <div className="rounded-xl border border-zinc-800/80 bg-black/30 p-4 text-[12px] text-brand-textMuted">
          No users found.
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-zinc-800/80 bg-black/30">
          <ul className="divide-y divide-zinc-900">
            {rows.map((u) => {
              const name = u.display_name || u.username || "User";
              const username = u.username ? `@${u.username}` : null;
              return (
                <li key={u.id} className="flex items-center justify-between gap-3 px-4 py-3">
                  <div className="flex min-w-0 items-center gap-3">
                    <div className="h-10 w-10 shrink-0 overflow-hidden rounded-full border border-zinc-800 bg-black/40">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      {u.avatar_url ? (
                        <img src={u.avatar_url} alt="" className="h-full w-full object-cover" />
                      ) : null}
                    </div>
                    <div className="min-w-0">
                      <div className="flex min-w-0 items-center gap-2">
                        <Link
                          href={`/user/${u.id}`}
                          className="min-w-0 truncate text-[13px] font-semibold text-brand-text hover:text-amber-200"
                        >
                          {name}
                        </Link>
                        {username ? (
                          <span className="truncate text-[12px] text-brand-textMuted">{username}</span>
                        ) : null}

                      {/* Badges */}
                      <div className="flex items-center gap-1">
                        {u.role ? <RolePill role={u.role} sizeClassName="text-[10px]" /> : null}
                        {u.is_verified ? <VerifiedBadge className="h-3 w-3" /> : null}
                        {u.donation_rank ? <DonationBadge rank={u.donation_rank} className="h-3 w-3" /> : null}
                      </div>
                      </div>
                      <div className="mt-0.5 truncate text-[11px] text-zinc-500">{u.id}</div>
                    </div>
                  </div>

                  <Link
                    href={`/user/${u.id}`}
                    className="shrink-0 rounded-full border border-zinc-700 bg-black/40 px-4 py-2 text-[12px] text-brand-textMuted hover:border-amber-400/70 hover:text-brand-text"
                  >
                    View
                  </Link>
                </li>
              );
            })}
          </ul>

          {hasMore ? (
            <div className="flex items-center justify-center border-t border-zinc-900 p-3">
              <button
                type="button"
                onClick={() => setLimit((v) => Math.min(v + 20, 200))}
                className="rounded-full border border-zinc-700 bg-black/40 px-5 py-2 text-[12px] text-brand-textMuted hover:border-amber-400/70 hover:text-brand-text"
              >
                Load more
              </button>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
