"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { supabaseBrowser } from "@/lib/supabaseClient";
import Link from "next/link";

type AdminActionStatus = "pending" | "open" | "approved" | "rejected";

type AdminActionRow = {
  id: string;
  action_type: string;
  payload: Record<string, unknown>;
  status: AdminActionStatus;
  requested_by: string;
  requested_ip: string | null;
  requested_at: string;
};

type MiniProfile = {
  id: string;
  username: string | null;
  display_name: string | null;
};

function readString(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function getTargetUserId(row: AdminActionRow): string | null {
  /** Most actions store a target user as payload.userId. */
  /** Some legacy code stores it in payload._target_user_id. */
  const p = row.payload;
  return readString(p["userId"]) ?? readString(p["_target_user_id"]) ?? null;
}

function formatRole(role: string | null): string {
  if (!role) return "(role)";
  /** "mod" is legacy; display as "moderator". */
  if (role === "mod") return "moderator";
  return role;
}

export function AdminApprovalsPanel() {
  const [rows, setRows] = useState<AdminActionRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [workingId, setWorkingId] = useState<string | null>(null);
  const [adminOverridePassword, setAdminOverridePassword] = useState("");
  const [profileById, setProfileById] = useState<Record<string, MiniProfile>>({});

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const supabase = supabaseBrowser();
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const token = session?.access_token;
      if (!token) {
        setRows([]);
        return;
      }

      const res = await fetch("/api/admin/approvals/pending?limit=50", {
        headers: { Authorization: `Bearer ${token}` },
      });
      const payload = (await res.json().catch(() => null)) as
        | { rows?: AdminActionRow[]; error?: string }
        | null;

      if (!res.ok || payload?.error || !Array.isArray(payload?.rows)) {
        setRows([]);
        return;
      }

      setRows(payload.rows);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /** Resolves user ids (requester + target users) to @username for nicer display. */
  useEffect(() => {
    const ids = Array.from(
      new Set(
        rows
          .flatMap((r) => [r.requested_by, getTargetUserId(r)])
          .filter((v): v is string => typeof v === "string" && v.length > 0)
      )
    );

    const missing = ids.filter((id) => !profileById[id]);
    if (missing.length === 0) return;

    let cancelled = false;
    const run = async () => {
      try {
        const supabase = supabaseBrowser();
        const { data, error } = await supabase
          .from("profiles")
          .select("id, username, display_name")
          .in("id", missing);

        if (cancelled) return;
        if (error || !data) return;

        const next: Record<string, MiniProfile> = { ...profileById };
        for (const p of (Array.isArray(data) ? data : [])) {
          if (p && typeof p === "object" && typeof (p as Record<string, unknown>).id === "string") {
            next[String((p as Record<string, unknown>).id)] = {
              id: String((p as Record<string, unknown>).id),
              username: typeof (p as Record<string, unknown>).username === "string" ? String((p as Record<string, unknown>).username) : null,
              display_name: typeof (p as Record<string, unknown>).display_name === "string" ? String((p as Record<string, unknown>).display_name) : null,
            };
          }
        }
        setProfileById(next);
      } catch {
        /** Ignored. */
      }
    };

    void run();
    return () => {
      cancelled = true;
    };
  }, [rows, profileById]);

  const hasRows = rows.length > 0;

  const sorted = useMemo(() => {
    return [...rows].sort((a, b) => (a.requested_at < b.requested_at ? 1 : -1));
  }, [rows]);

  const act = useCallback(
    async (kind: "approve" | "reject", requestId: string) => {
      setWorkingId(requestId);
      try {
        const supabase = supabaseBrowser();
        const {
          data: { session },
        } = await supabase.auth.getSession();
        const token = session?.access_token;
        if (!token) {
          alert("You must be logged in.");
          return;
        }

        const res = await fetch(`/api/admin/approvals/${kind}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ requestId }),
        });

        const payload = (await res.json().catch(() => null)) as
          | { error?: string; ok?: boolean }
          | null;

        if (!res.ok || payload?.error) {
          alert(payload?.error ?? "Action failed.");
          return;
        }

        await load();
      } finally {
        setWorkingId(null);
      }
    },
    [load]
  );

  const overrideApprove = useCallback(
    async (requestId: string) => {
      const pw = adminOverridePassword.trim();
      if (!pw) {
        alert("Enter the admin override password first.");
        return;
      }

      setWorkingId(requestId);
      try {
        const supabase = supabaseBrowser();
        const {
          data: { session },
        } = await supabase.auth.getSession();
        const token = session?.access_token;
        if (!token) {
          alert("You must be logged in.");
          return;
        }

        const res = await fetch("/api/admin/approvals/override-approve", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            requestId,
            admin_override_password: pw,
          }),
        });

        const payload = (await res.json().catch(() => null)) as
          | { error?: string; ok?: boolean }
          | null;

        if (!res.ok || payload?.error) {
          alert(payload?.error ?? "Override approve failed.");
          return;
        }

        await load();
      } finally {
        setWorkingId(null);
      }
    },
    [adminOverridePassword, load]
  );

  const renderUser = useCallback(
    (userId: string | null) => {
      if (!userId) return <span className="text-brand-textMuted">(user)</span>;
      const prof = profileById[userId];
      const username = prof?.username;
      const label = username ? `@${username}` : userId;
      return (
        <Link href={`/user/${userId}`} className="text-brand-text hover:underline">
          {label}
        </Link>
      );
    },
    [profileById]
  );

  const renderAction = useCallback(
    (row: AdminActionRow) => {
      const t = row.action_type;
      const p = row.payload;

      if (t === "role_change") {
        const userId = readString(p["userId"]);
        const newRole = formatRole(readString(p["newRole"]));
        return (
          <>
            Role change: {renderUser(userId)} → <span className="text-brand-text">{newRole}</span>
          </>
        );
      }

      if (t === "security_broadcast") {
        const enabled = p["enabled"] === true;
        const level = readString(p["level"]) ?? "info";
        return (
          <>
            Emergency banner: <span className="text-brand-text">{enabled ? "enable" : "disable"}</span> ({level})
          </>
        );
      }

      if (t === "security_settings") {
        const lockdown = p["lockdown_enabled"] === true;
        const maintenance = p["maintenance_mode"] === true;
        return (
          <>
            Security settings: lockdown {lockdown ? "on" : "off"}, maintenance {maintenance ? "on" : "off"}
          </>
        );
      }

      if (t === "force_logout") {
        return <>Force logout all users</>;
      }

      if (t === "notification_broadcast") {
        const title = readString(p["title"]) ?? "Announcement";
        return (
          <>
            Notify all users: <span className="text-brand-text">{title}</span>
          </>
        );
      }

      if (t === "restriction_set") {
        const userId = readString(p["userId"]);
        const kind = readString(p["kind"]) ?? "(kind)";
        const action = readString(p["action"]) ?? "(action)";
        const duration = p["durationHours"];
        const durText = typeof duration === "number" && duration > 0 ? ` (${duration}h)` : "";
        return (
          <>
            Restriction {action}: <span className="text-brand-text">{kind}</span>
            {durText} → {renderUser(userId)}
          </>
        );
      }

      if (t === "ban_user") {
        const userId = readString(p["userId"]);
        const currentlyBanned = p["currentlyBanned"] === true;
        return (
          <>
            {currentlyBanned ? "Unban" : "Ban"}: {renderUser(userId)}
          </>
        );
      }

      return (
        <>
          Action: <span className="text-brand-text">{t}</span>
        </>
      );
    },
    [renderUser]
  );

  return (
    <section className="rounded-xl border border-zinc-800 bg-black/40 p-4">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold text-brand-text">Pending approvals</h2>
          <p className="text-[11px] text-brand-textMuted">
            High-risk actions require a second admin from a different IP.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          className="rounded-full border border-zinc-700 bg-black/40 px-3 py-1 text-[11px] text-brand-text hover:border-amber-400 disabled:opacity-60"
        >
          {loading ? "Refreshing…" : "Refresh"}
        </button>
      </div>



      <div className="mt-3 rounded-lg border border-zinc-800 bg-black/30 p-3">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="text-[11px] font-semibold text-brand-text">Admin override password</div>
            <div className="text-[10px] text-brand-textMuted">
              Optional: lets you bypass the second-admin requirement for urgent actions.
            </div>
          </div>
          <input
            type="password"
            value={adminOverridePassword}
            onChange={(e) => setAdminOverridePassword(e.target.value)}
            placeholder="Override password"
            className="w-full max-w-xs rounded-md border border-zinc-700 bg-black/40 px-3 py-2 text-[12px] text-brand-text placeholder:text-brand-textMuted"
          />
        </div>
      </div>

      {!hasRows ? (
        <div className="mt-3 rounded-lg border border-zinc-800 bg-black/30 p-3 text-[11px] text-brand-textMuted">
          No pending approvals.
        </div>
      ) : (
        <div className="mt-3 space-y-2">
          {sorted.map((r) => (
            <div
              key={r.id}
              className="flex flex-col gap-2 rounded-lg border border-zinc-800 bg-black/30 p-3"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="text-[12px] text-brand-text">
                  {renderAction(r)}
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => void act("reject", r.id)}
                    disabled={workingId === r.id}
                    className="rounded-full border border-red-500/60 bg-red-500/15 px-3 py-1 text-[11px] text-red-200 hover:bg-red-500/25 disabled:opacity-60"
                  >
                    Reject
                  </button>

                  {adminOverridePassword.trim().length > 0 && (
                    <button
                      type="button"
                      onClick={() => void overrideApprove(r.id)}
                      disabled={workingId === r.id}
                      className="rounded-full border border-zinc-600 bg-black/50 px-3 py-1 text-[11px] text-brand-text hover:border-amber-400 disabled:opacity-60"
                      title="Bypasses the second-admin requirement"
                    >
                      Override Approve
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => void act("approve", r.id)}
                    disabled={workingId === r.id}
                    className="rounded-full border border-emerald-500/70 bg-emerald-500/15 px-3 py-1 text-[11px] text-emerald-100 hover:bg-emerald-500/25 disabled:opacity-60"
                  >
                    Approve
                  </button>
                </div>
              </div>
              <div className="text-[10px] text-brand-textMuted">
                Requested by:{" "}
                {(() => {
                  const prof = profileById[r.requested_by];
                  const username = prof?.username;
                  const label = username ? `@${username}` : r.requested_by;
                  return (
                    <Link
                      href={`/user/${r.requested_by}`}
                      className="text-brand-text hover:underline"
                    >
                      {label}
                    </Link>
                  );
                })()}
                {" "}• IP: {r.requested_ip ?? "(unknown)"} • {new Date(r.requested_at).toLocaleString()}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
