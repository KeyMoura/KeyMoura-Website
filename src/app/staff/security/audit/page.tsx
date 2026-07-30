"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";

import { MenuSelect } from "@/components/ui/MenuSelect";
import { supabaseBrowser } from "@/lib/supabaseClient";

type ProfileLite = {
  id: string;
  username: string | null;
  display_name: string | null;
};

type AuditRow = {
  id: string;
  created_at: string;
  actor_user_id: string | null;
  actor_role: string | null;
  actor_ip: string | null;
  event_type: string;
  target_table: string | null;
  target_id: string | null;
  metadata: Record<string, unknown> | null;
};

type SortKey = "created_at" | "event_type";

function formatWhen(iso: string) {
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? d.toLocaleString() : iso;
}

function looksLikeUuid(v: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

export default function StaffSecurityAuditPage() {
  const PAGE_SIZE = 50;
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const [logs, setLogs] = useState<AuditRow[]>([]);
  const [totalCount, setTotalCount] = useState<number>(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [profiles, setProfiles] = useState<Record<string, ProfileLite>>({});
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("created_at");
  const [sortDir, setSortDir] = useState<"desc" | "asc">("desc");
  const [eventFilter, setEventFilter] = useState<string>("all");

  const canView = true; // gated by /api/me/access below

  const getProfileLabel = (p: ProfileLite | undefined) => {
    const handle = p?.username ? `@${p.username}` : null;
    const name = p?.display_name ?? null;
    return handle ?? name ?? "Unknown";
  };

  const getTargetUserId = (row: AuditRow): string | null => {
    // direct
    if (row.target_table && row.target_id) {
      const tt = String(row.target_table).toLowerCase();
      if (tt === "profiles") return row.target_id;
    }

    const m = (row.metadata ?? {}) as Record<string, unknown>;
    const candidates = [
      m["userId"],
      m["user_id"],
      m["target_user_id"],
      m["_target_user_id"],
      m["profile_id"],
      m["profileId"],
      m["subject_user_id"],
      m["subjectUserId"],
      m["restricted_user_id"],
      m["banned_user_id"],
      m["targetUserId"],
      m["to_user_id"],
      m["toUserId"],
    ];
    for (const c of candidates) {
      if (typeof c === "string" && c.length > 0) return c;
    }
    return null;
  };

  const eventTypes = useMemo(() => {
    const s = new Set<string>();
    for (const r of logs) {
      if (isNonEmptyString(r.event_type)) s.add(r.event_type);
    }
    return Array.from(s).sort((a, b) => a.localeCompare(b));
  }, [logs]);

  const fetchPage = async (offset: number) => {
    const supabase = supabaseBrowser();

    const { data: rows, error, count } = await supabase
      .from("audit_logs")
      .select(
        "id, created_at, actor_user_id, actor_role, actor_ip, event_type, target_table, target_id, metadata",
        { count: "exact" }
      )
      .order("created_at", { ascending: false })
      .range(offset, offset + PAGE_SIZE - 1);

    if (error) throw error;
    setTotalCount(typeof count === "number" ? count : 0);
    return (rows ?? []) as AuditRow[];
  };

  useEffect(() => {
    const load = async () => {
      try {
        setLoading(true);
        setErrorMessage(null);

        const supabase = supabaseBrowser();
        const { data } = await supabase.auth.getSession();
        const token = data.session?.access_token ?? null;
        if (!token) {
          setErrorMessage("You must be logged in.");
          setLogs([]);
          return;
        }

        const accessRes = await fetch("/api/me/access", {
          method: "GET",
          headers: { Authorization: `Bearer ${token}` },
        }).catch(() => null);

        const accessJson = (await accessRes?.json().catch(() => null)) as any;
        const perms: string[] = Array.isArray(accessJson?.permissions) ? accessJson.permissions : [];
        const allowed = perms.includes("audit.view") || perms.includes("audit.read");
        if (!allowed) {
          setErrorMessage("Forbidden.");
          setLogs([]);
          return;
        }

        const first = await fetchPage(0);
        setLogs(first);
      } finally {
        setLoading(false);
      }
    };

    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const supabase = supabaseBrowser();
    const hydrate = async () => {
      // hydrate profiles for actor + target user (loaded rows only)
      const ids = new Set<string>();
      for (const r of logs) {
        if (r.actor_user_id) ids.add(r.actor_user_id);
        const t = getTargetUserId(r);
        if (t && looksLikeUuid(t)) ids.add(t);
      }

      const need = Array.from(ids);
      if (!need.length) {
        setProfiles({});
        return;
      }

      const { data: profRows } = await supabase.from("profiles").select("id, username, display_name").in("id", need);

      const map: Record<string, ProfileLite> = {};
      for (const p of (profRows ?? []) as ProfileLite[]) map[p.id] = p;
      setProfiles(map);
    };

    void hydrate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [logs]);

  const canLoadMore = logs.length < totalCount;

  const loadMore = async () => {
    if (loadingMore || !canLoadMore) return;
    try {
      setLoadingMore(true);
      const next = await fetchPage(logs.length);
      setLogs((prev) => [...prev, ...next]);
    } catch (e) {
      console.error("audit load more error", e);
      setErrorMessage("Failed to load more audit events.");
    } finally {
      setLoadingMore(false);
    }
  };

  const filteredLogs = useMemo(() => {
    const q = search.trim().toLowerCase();

    const out = [...logs]
      .filter((r) => {
        if (eventFilter !== "all" && String(r.event_type) !== eventFilter) return false;
        if (!q) return true;

        const actor = r.actor_user_id ? profiles[r.actor_user_id] : undefined;
        const targetId = getTargetUserId(r);
        const target = targetId ? profiles[targetId] : undefined;

        const hay = [
          r.event_type,
          r.actor_role ?? "",
          r.actor_ip ?? "",
          r.target_table ?? "",
          r.target_id ?? "",
          actor?.username ?? "",
          actor?.display_name ?? "",
          target?.username ?? "",
          target?.display_name ?? "",
          JSON.stringify(r.metadata ?? {}),
        ]
          .join(" ")
          .toLowerCase();
        return hay.includes(q);
      })
      .sort((a, b) => {
        if (sortKey === "event_type") {
          const va = a.event_type;
          const vb = b.event_type;
          return sortDir === "asc" ? va.localeCompare(vb) : vb.localeCompare(va);
        }
        const ta = new Date(a.created_at).getTime();
        const tb = new Date(b.created_at).getTime();
        return sortDir === "asc" ? ta - tb : tb - ta;
      });

    return out;
  }, [eventFilter, logs, profiles, search, sortKey, sortDir]);

  const renderRestrictionTarget = (row: AuditRow) => {
    const meta = (row.metadata ?? {}) as Record<string, unknown>;
    const tid = getTargetUserId(row);
    const kind = isNonEmptyString(meta["kind"]) ? String(meta["kind"]) : null;
    const restrictionLabel =
      kind === "site" ? "Timeout" : kind === "community" ? "Community restriction" : kind === "dm" ? "DM restriction" : "Restriction";

    if (tid && looksLikeUuid(tid)) {
      const t = profiles[tid];
      return (
        <div className="min-w-0">
          <Link href={`/user/${tid}`} className="text-amber-200 hover:underline">
            {getProfileLabel(t)}
          </Link>
          <div className="text-[11px] text-zinc-500">
            {restrictionLabel}
            {row.target_id ? ` • #${row.target_id}` : ""}
          </div>
        </div>
      );
    }

    return <span className="text-[12px] text-zinc-300">{restrictionLabel}{row.target_id ? ` #${row.target_id}` : ""}</span>;
  };

  const renderTargetCell = (row: AuditRow) => {
    const meta = (row.metadata ?? {}) as Record<string, unknown>;

    // Reports
    const reportId =
      (typeof meta["report_id"] === "number"
        ? String(meta["report_id"])
        : typeof meta["report_id"] === "string"
          ? (meta["report_id"] as string)
          : typeof meta["reportId"] === "string"
            ? (meta["reportId"] as string)
            : null) ?? (row.target_table === "reports" && row.target_id ? row.target_id : null);

    if (reportId) {
      return (
        <Link href={`/staff/moderation/reports?report=${encodeURIComponent(reportId)}`} className="text-amber-200 hover:underline">
          Report #{reportId}
        </Link>
      );
    }

    const tt = String(row.target_table ?? "").toLowerCase();
    if (tt === "user_restrictions") {
      return renderRestrictionTarget(row);
    }

    const tid = getTargetUserId(row);
    if (tid && looksLikeUuid(tid)) {
      const t = profiles[tid];
      return (
        <Link href={`/user/${tid}`} className="text-amber-200 hover:underline">
          {getProfileLabel(t)}
        </Link>
      );
    }

    // Forum links (only if we have slugs)
    const categorySlug = isNonEmptyString(meta["category_slug"]) ? String(meta["category_slug"]) : null;
    const threadSlug = isNonEmptyString(meta["thread_slug"]) ? String(meta["thread_slug"]) : null;
    const postId =
      typeof meta["post_id"] === "number"
        ? String(meta["post_id"])
        : typeof meta["post_id"] === "string"
          ? String(meta["post_id"])
          : null;

    if (categorySlug && threadSlug) {
      const href = postId ? `/community/${categorySlug}/${threadSlug}#post-${postId}` : `/community/${categorySlug}/${threadSlug}`;
      return (
        <Link href={href} className="text-amber-200 hover:underline">
          {postId ? `Post #${postId}` : "Thread"}
        </Link>
      );
    }

    if (row.target_table && row.target_id) {
      return <span className="font-mono text-[12px] text-zinc-300">{row.target_table}:{row.target_id}</span>;
    }

    return "—";
  };

  const renderEventSummary = (row: AuditRow) => {
    const meta = (row.metadata ?? {}) as Record<string, unknown>;
    const et = String(row.event_type ?? "");

    if (et.startsWith("moderation.restriction")) {
      const kind = isNonEmptyString(meta["kind"]) ? String(meta["kind"]) : null;
      const action = isNonEmptyString(meta["action"]) ? String(meta["action"]) : null;
      const hrs = typeof meta["durationHours"] === "number" && Number.isFinite(meta["durationHours"]) ? (meta["durationHours"] as number) : null;
      const until = isNonEmptyString(meta["expires_at"]) ? String(meta["expires_at"]) : null;

      const label = kind === "site" ? "Timeout" : kind === "community" ? "Community" : kind === "dm" ? "DM" : "Restriction";
      const act = action === "set" ? "set" : action === "clear" ? "cleared" : null;
      const parts = [label, act].filter(Boolean);
      const durationPart = hrs && hrs > 0 ? `${hrs}h` : null;
      if (durationPart) parts.push(durationPart);
      if (until) parts.push(`until ${formatWhen(until)}`);

      return parts.length ? parts.join(" • ") : null;
    }

    // Common role events
    if (et.includes("role")) {
      const role = isNonEmptyString(meta["role"]) ? String(meta["role"]) : isNonEmptyString(meta["new_role"]) ? String(meta["new_role"]) : null;
      const prev = isNonEmptyString(meta["old_role"]) ? String(meta["old_role"]) : null;
      if (role && prev && role !== prev) return `role: ${prev} → ${role}`;
      if (role) return `role: ${role}`;
    }

    // Report lifecycle
    if (et.includes("report")) {
      const status = isNonEmptyString(meta["status"]) ? String(meta["status"]) : null;
      const prev = isNonEmptyString(meta["previous_status"]) ? String(meta["previous_status"]) : null;
      if (status && prev && status !== prev) return `status: ${prev} → ${status}`;
      if (status) return `status: ${status}`;
    }

    return null;
  };

  return (
    <div className="mx-auto w-full max-w-6xl p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <p className="text-[11px] uppercase tracking-[0.15em] text-brand-textMuted">Admin • Security</p>
          <h1 className="text-xl font-semibold text-brand-text">Audit Log</h1>
          <p className="text-sm text-zinc-400">Security + moderation events for staff review.</p>
        </div>
      </div>

      {canView ? (
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search audit…"
            className="no-zoom-input h-8 w-full max-w-xs rounded-md border border-zinc-700 bg-black/60 px-2 text-[12px] text-brand-text outline-none placeholder:text-zinc-500 focus:border-amber-400"
          />

          <MenuSelect
            ariaLabel="Event type"
            value={eventFilter}
            onChange={(next) => setEventFilter(next)}
            className="flex h-8 items-center gap-2 rounded-md border border-zinc-700 bg-black/60 px-2 text-[11px] text-brand-text outline-none transition hover:border-amber-400/70"
            options={[
              { value: "all", label: "All events" },
              ...eventTypes.map((t) => ({ value: t, label: t })),
            ]}
          />

          <MenuSelect
            ariaLabel="Sort by"
            value={sortKey}
            onChange={(next) => setSortKey(next as SortKey)}
            className="flex h-8 items-center gap-2 rounded-md border border-zinc-700 bg-black/60 px-2 text-[11px] text-brand-text outline-none transition hover:border-amber-400/70"
            options={[
              { value: "created_at", label: "Sort: Time" },
              { value: "event_type", label: "Sort: Event" },
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
            Showing {Math.min(logs.length, totalCount)} out of {totalCount}
            {search.trim() || eventFilter !== "all" ? (
              <span className="ml-1 text-zinc-500">
                • {filteredLogs.length} match{filteredLogs.length === 1 ? "" : "es"}
              </span>
            ) : null}
          </div>
        </div>
      ) : null}

      {errorMessage && !loading ? (
        <div className="mb-3 rounded-lg border border-zinc-800 bg-black/40 p-3 text-sm text-amber-200">{errorMessage}</div>
      ) : null}

      {loading ? (
        <div className="rounded-lg border border-zinc-800 bg-black/40 p-3 text-sm text-zinc-300">Loading…</div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-zinc-800 bg-black/30">
          <div className="grid grid-cols-12 gap-2 border-b border-zinc-800 bg-black/40 px-3 py-2 text-[12px] text-zinc-400">
            <div className="col-span-3">Event</div>
            <div className="col-span-2">Actor</div>
            <div className="col-span-3">Target</div>
            <div className="col-span-1">IP</div>
            <div className="col-span-2">When</div>
            <div className="col-span-1 text-right">Details</div>
          </div>

          {filteredLogs.length === 0 ? (
            <div className="px-3 py-4 text-sm text-zinc-400">No audit events found.</div>
          ) : (
            filteredLogs.map((r) => {
              const isExpanded = expandedId === r.id;
              const actor = r.actor_user_id ? profiles[r.actor_user_id] : undefined;
              const summary = renderEventSummary(r);

              return (
                <div key={r.id} className="border-t border-zinc-800">
                  <div className="grid grid-cols-12 gap-2 px-3 py-2 text-sm text-brand-text">
                    <div className="col-span-3">
                      <div className="text-[12px] text-zinc-300">{r.event_type}</div>
                      {summary ? <div className="text-[11px] text-zinc-500">{summary}</div> : null}
                      {r.actor_role ? <div className="text-[11px] text-zinc-500">role: {r.actor_role}</div> : null}
                    </div>

                    <div className="col-span-2 text-zinc-300">
                      {r.actor_user_id ? (
                        <Link href={`/user/${r.actor_user_id}`} className="text-amber-200 hover:underline">
                          {getProfileLabel(actor)}
                        </Link>
                      ) : (
                        "—"
                      )}
                    </div>

                    <div className="col-span-3 text-zinc-300">{renderTargetCell(r)}</div>

                    <div className="col-span-1 font-mono text-[12px] text-zinc-300">{r.actor_ip ?? "—"}</div>

                    <div className="col-span-2 text-zinc-300">{formatWhen(r.created_at)}</div>

                    <div className="col-span-1 flex justify-end">
                      <button
                        type="button"
                        onClick={() => setExpandedId((p) => (p === r.id ? null : r.id))}
                        className="rounded-md border border-zinc-700 bg-zinc-900/60 px-2 py-1 text-[12px] text-amber-200 hover:bg-zinc-900"
                      >
                        {isExpanded ? "Hide" : "View"}
                      </button>
                    </div>
                  </div>

                  {isExpanded ? (
                    <div className="bg-black/25 px-3 pb-3">
                      <div className="rounded-lg border border-zinc-800 bg-black/40 p-3">
                        <div className="text-[11px] uppercase tracking-[0.12em] text-zinc-500">Metadata</div>
                        <pre className="mt-2 max-h-64 overflow-auto rounded-md border border-zinc-800 bg-black/60 p-2 text-[11px] text-zinc-400">
                          {JSON.stringify(r.metadata ?? {}, null, 2)}
                        </pre>
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
