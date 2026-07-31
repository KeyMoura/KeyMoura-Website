"use client";

import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { supabaseBrowser } from "@/lib/supabaseClient";
import Link from "next/link";
import { MenuSelect } from "@/components/ui/MenuSelect";
import { AdminApprovalsPanel } from "@/components/AdminApprovalsPanel";
import { AccessDeniedCard } from "@/components/AccessDeniedCard";
import { useMeAccess } from "@/lib/hooks/useMeAccess";

type FlagsRow = {
  lockdown_enabled: boolean;
  lockdown_message: string;
  force_logout_epoch: number | null;
  maintenance_mode: boolean;
  lockdown_version: number | null;
  updated_at: string | null;
  // NEW:
  emergency_banner_enabled?: boolean | null;
  emergency_banner_text?: string | null;
  emergency_banner_level?: string | null;
};

type IpBanRow = {
  id: number;
  ip_address: string;
  reason: string | null;
  created_at: string;
  created_by: string | null;
};

type BannerLevel = "info" | "warning" | "critical";

export default function AdminSecurityPage() {
  const { data: access, isLoading: accessLoading } = useMeAccess();
  const perms = useMemo(() => new Set(access?.permissions ?? []), [access?.permissions]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const [lockdownEnabled, setLockdownEnabled] = useState(false);
  const [lockdownMessage, setLockdownMessage] = useState("");
  const [maintenanceMode, setMaintenanceMode] = useState(false);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<string | null>(null);

  const [lockdownVersion, setLockdownVersion] = useState<number>(1);
  const [newPassword, setNewPassword] = useState("");

  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null);

  // IP ban state
  const [ipBans, setIpBans] = useState<IpBanRow[]>([]);
  const [ipLoading, setIpLoading] = useState(false);
  const [ipSaving, setIpSaving] = useState(false);
  const [newIp, setNewIp] = useState("");
  const [newIpReason, setNewIpReason] = useState("");

  // Emergency banner state
  const [bannerEnabled, setBannerEnabled] = useState(false);
  const [bannerText, setBannerText] = useState("");
  const [bannerLevel, setBannerLevel] = useState<BannerLevel>("info");

  // Broadcast notification (admin only)
  const [broadcastTitle, setBroadcastTitle] = useState("");
  const [broadcastMessage, setBroadcastMessage] = useState("");
  const [broadcastHref, setBroadcastHref] = useState("");
  const [broadcastAsServer, setBroadcastAsServer] = useState(true);
  const [broadcastAudience, setBroadcastAudience] = useState<"all" | "staff" | "users">("all");
  const [broadcastUsernamesText, setBroadcastUsernamesText] = useState("");
  const [broadcastSending, setBroadcastSending] = useState(false);

  // Specific-user @username autocomplete (mirrors the community mention behavior)
  const broadcastUsersInputRef = useRef<HTMLInputElement | null>(null);
  const [userAcOpen, setUserAcOpen] = useState(false);
  const [userAcLoading, setUserAcLoading] = useState(false);
  const [userAcItems, setUserAcItems] = useState<Array<{ id: string; username: string; display_name: string | null; avatar_url: string | null }>>([]);
  const [userAcActiveIndex, setUserAcActiveIndex] = useState(0);
  const [userAcRange, setUserAcRange] = useState<{ start: number; end: number } | null>(null);

  const closeUserAc = () => {
    setUserAcOpen(false);
    setUserAcItems([]);
    setUserAcLoading(false);
    setUserAcActiveIndex(0);
    setUserAcRange(null);
  };

  const fetchUserAc = async (q: string) => {
    const trimmed = (q ?? "").trim().toLowerCase();
    if (trimmed.length < 3) {
      closeUserAc();
      return;
    }

    setUserAcLoading(true);
    try {
      const supabase = supabaseBrowser();
      const { data, error } = await supabase
        .from("profiles")
        .select("id, username, display_name, avatar_url")
        .ilike("username", `${trimmed}%`)
        .order("username", { ascending: true })
        .limit(5);

      if (error) {
        console.error("broadcast user autocomplete failed", error);
        closeUserAc();
        return;
      }

      const rows = (data ?? []) as Array<{ id: string; username: string | null; display_name: string | null; avatar_url: string | null }>;
      const items = rows
        .filter((r) => !!r?.id && !!r?.username)
        .map((r) => ({ id: r.id, username: String(r.username), display_name: r.display_name ?? null, avatar_url: r.avatar_url ?? null }));

      setUserAcItems(items);
      setUserAcActiveIndex(0);
      setUserAcOpen(items.length > 0);
    } catch (e) {
      console.error("broadcast user autocomplete unexpected", e);
      closeUserAc();
    } finally {
      setUserAcLoading(false);
    }
  };

  const handleBroadcastUsernamesChange = (v: string) => {
    setBroadcastUsernamesText(v);

    const el = broadcastUsersInputRef.current;
    const caret = el?.selectionStart ?? v.length;
    const before = v.slice(0, caret);

    // Find the nearest valid @mention token before the caret.
    const at = before.lastIndexOf("@");
    if (at < 0) {
      closeUserAc();
      return;
    }

    // Only treat @ as a mention if it's at start or preceded by space/comma.
    const prev = at > 0 ? before[at - 1] : " ";
    if (at > 0 && !(prev === " " || prev === ",")) {
      closeUserAc();
      return;
    }

    const q = before.slice(at + 1);
    // Stop if the token contains whitespace or another comma.
    if (/\s|,/.test(q)) {
      closeUserAc();
      return;
    }

    setUserAcRange({ start: at, end: caret });
    void fetchUserAc(q);
  };

  const applyUserSuggestion = (username: string) => {
    const el = broadcastUsersInputRef.current;
    const cur = broadcastUsernamesText;
    const caret = el?.selectionStart ?? cur.length;
    const range = userAcRange ?? { start: cur.lastIndexOf("@"), end: caret };
    if (range.start < 0) return;

    const before = cur.slice(0, range.start);
    const after = cur.slice(range.end);
    const insert = `@${username}`;

    // Ensure we end the token with ", " unless the next char is already a separator.
    const nextChar = after[0] ?? "";
    const needsSep = nextChar && !/^\s|,/.test(nextChar);
    const sep = after.length === 0 || needsSep ? ", " : "";

    const next = `${before}${insert}${sep}${after}`;
    setBroadcastUsernamesText(next);
    closeUserAc();

    // Place caret after inserted username (+ separator if added)
    requestAnimationFrame(() => {
      const newPos = (before.length + insert.length + sep.length);
      el?.setSelectionRange(newPos, newPos);
      el?.focus();
    });
  };

  const handleBroadcastUsernamesKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (!userAcOpen) return;
    if (e.key === "Escape") {
      e.preventDefault();
      closeUserAc();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setUserAcActiveIndex((v) => Math.min(userAcItems.length - 1, v + 1));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setUserAcActiveIndex((v) => Math.max(0, v - 1));
      return;
    }
    if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      const picked = userAcItems[userAcActiveIndex];
      if (picked?.username) applyUserSuggestion(picked.username);
    }
  };

  // Rate limit / abuse metrics
  const [abuseLoading, setAbuseLoading] = useState(false);
  const [abuseReports24h, setAbuseReports24h] = useState<number | null>(null);
  const [abuseReportMsgs24h, setAbuseReportMsgs24h] = useState<number | null>(null);
  const [abuseNewUsers24h, setAbuseNewUsers24h] = useState<number | null>(null);

  useEffect(() => {
    const supabase = supabaseBrowser();

    const load = async () => {
      try {
        setLoading(true);
        setErrorMessage(null);
        setActionMessage(null);

        // 1) Get current user
        const { data: userData } = await supabase.auth.getUser();
        const user = userData?.user ?? null;

        if (!user) {
          setIsAdmin(false);
          setErrorMessage(
            "You must be logged in as staff to view this page."
          );
          return;
        }

        setCurrentUserId(user.id);

        // Use the shared server-validated access model. Browser reads of
        // user_roles can be denied by RLS even for a valid administrator.
        if (!access || access.role !== "admin") {
          setIsAdmin(false);
          setErrorMessage("Access denied. Admins only.");
          return;
        }

        setIsAdmin(true);

        // 3) Load security settings row
        const { data, error } = await supabase
          .from("site_security_settings")
          .select(
            "lockdown_enabled, lockdown_message, maintenance_mode, force_logout_epoch, lockdown_version, updated_at, emergency_banner_enabled, emergency_banner_text, emergency_banner_level"
          )
          .eq("id", 1)
          .maybeSingle<FlagsRow>();

        if (error || !data) {
          console.error("Failed to load site_security_settings", error);
          setErrorMessage("Failed to load security settings.");
          return;
        }

        setLockdownEnabled(Boolean(data.lockdown_enabled));
        setLockdownMessage(data.lockdown_message ?? "");
        setMaintenanceMode(Boolean(data.maintenance_mode));
        setLockdownVersion(data.lockdown_version ?? 1);
        setLastUpdatedAt(
          data.updated_at ? new Date(data.updated_at).toLocaleString() : null
        );

        // Emergency banner values (with sane fallbacks)
        setBannerEnabled(Boolean(data.emergency_banner_enabled));
        setBannerText(data.emergency_banner_text ?? "");
        const lvl = (data.emergency_banner_level ?? "info") as BannerLevel;
        setBannerLevel(
          ["info", "warning", "critical"].includes(lvl) ? lvl : "info"
        );

        // 4) Load IP bans
        setIpLoading(true);
        const { data: bansData, error: bansError } = await supabase
          .from("ip_bans")
          .select("id, ip_address, reason, created_at, created_by")
          .order("created_at", { ascending: false });

        if (bansError) {
          console.error("Failed to load ip_bans", bansError);
          // soft-fail: don't kill the whole page
        } else if (bansData) {
          setIpBans(bansData as IpBanRow[]);
        }

        // 5) Rate limit / abuse metrics (last 24h)
        try {
          setAbuseLoading(true);
          const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

          const [
            { count: cReports },
            { count: cMsgs },
            { count: cUsers },
          ] = await Promise.all([
            supabase
              .from("reports")
              .select("id", { count: "exact", head: true })
              .gte("created_at", since),
            supabase
              .from("report_messages")
              .select("id", { count: "exact", head: true })
              .gte("created_at", since),
            supabase
              .from("profiles")
              .select("id", { count: "exact", head: true })
              .gte("created_at", since),
          ]);

          setAbuseReports24h(cReports ?? null);
          setAbuseReportMsgs24h(cMsgs ?? null);
          setAbuseNewUsers24h(cUsers ?? null);
        } catch (e) {
          console.error("Failed to load abuse metrics", e);
          setAbuseReports24h(null);
          setAbuseReportMsgs24h(null);
          setAbuseNewUsers24h(null);
        } finally {
          setAbuseLoading(false);
        }

      } catch (e) {
        console.error("AdminSecurityPage load error", e);
        setErrorMessage("Unexpected error loading security settings.");
      } finally {
        setIpLoading(false);
        setLoading(false);
      }
    };

    void load();
  }, [access]);

  const handleSaveSettings = async () => {
    if (!isAdmin) return;

    try {
      setSaving(true);
      setErrorMessage(null);
      setActionMessage(null);

      const supabase = supabaseBrowser();
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const token = session?.access_token;

      if (!token) {
        setErrorMessage("You must be logged in.");
        return;
      }

      // High-risk: settings changes require 2-admin approval
      const res = await fetch("/api/admin/security/settings", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          lockdown_enabled: lockdownEnabled,
          lockdown_message: lockdownMessage,
          maintenance_mode: maintenanceMode,
          emergency_banner_enabled: bannerEnabled,
          emergency_banner_text: bannerText,
          emergency_banner_level: bannerLevel,
          ...(newPassword.trim() ? { lockdown_password: newPassword.trim() } : {}),
        }),
      });

      const payload = (await res.json().catch(() => null)) as
        | { error?: string; pending?: boolean }
        | null;

      if (!res.ok || payload?.error) {
        setErrorMessage(payload?.error ?? "Failed to request settings update.");
        return;
      }

      setNewPassword("");
      setActionMessage(
        "Security settings update requested. A different admin from a different IP must approve it before it goes live."
      );
    } catch (e) {
      console.error("Save settings error", e);
      setErrorMessage("Unexpected error saving settings.");
    } finally {
      setSaving(false);
    }
  };

  const handleForceLogout = async () => {
    if (!isAdmin) return;

    try {
      setSaving(true);
      setErrorMessage(null);
      setActionMessage(null);

      const supabase = supabaseBrowser();
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const token = session?.access_token;

      if (!token) {
        setErrorMessage("You must be logged in.");
        return;
      }

      const res = await fetch("/api/admin/security/force-logout", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });

      const payload = (await res.json().catch(() => null)) as
        | { error?: string; pending?: boolean }
        | null;

      if (!res.ok || payload?.error) {
        setErrorMessage(payload?.error ?? "Failed to request force-logout.");
        return;
      }

      setActionMessage(
        "Force-logout requested. A different admin from a different IP must approve it before it goes live."
      );
    } catch (e) {
      console.error("Force logout error", e);
      setErrorMessage("Unexpected error forcing logout.");
    } finally {
      setSaving(false);
    }
  };

  const handleSendBroadcastNotification = async () => {
    if (!isAdmin) return;

    const title = broadcastTitle.trim();
    const message = broadcastMessage.trim();
    const href = broadcastHref.trim();
    const usernames = broadcastUsernamesText
      .split(/[\s,\n]+/g)
      .map((t) => t.trim())
      .filter(Boolean)
      .map((t) => (t.startsWith("@") ? t.substring(1) : t))
      .map((t) => t.toLowerCase())
      .filter(Boolean);

    if (!title) {
      setErrorMessage("Broadcast title is required.");
      return;
    }

    if (broadcastAudience === "users" && usernames.length === 0) {
      setErrorMessage("Please enter at least one @username for specific-user notifications.");
      return;
    }

    try {
      setBroadcastSending(true);
      setErrorMessage(null);
      setActionMessage(null);

      const supabase = supabaseBrowser();
      const {
        data: { session },
        error: sessionError,
      } = await supabase.auth.getSession();

      if (sessionError || !session?.access_token) {
        console.error("No session / access token", sessionError);
        setErrorMessage("You must be logged in as staff to send broadcasts.");
        return;
      }

      const res = await fetch("/api/admin/notifications/broadcast", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          title,
          message: message.length ? message : null,
          href: href.length ? href : null,
          send_as_server: broadcastAsServer,
          audience: broadcastAudience,
          usernames: broadcastAudience === "users" ? usernames : [],
        }),
      });

      const payload = (await res.json().catch(() => null)) as
        | { ok?: boolean; error?: string; pending?: boolean }
        | null;

      if (!res.ok || payload?.error) {
        console.error("Broadcast notification failed", payload);
        setErrorMessage(payload?.error ?? "Failed to send broadcast notification.");
        return;
      }

      setBroadcastTitle("");
      setBroadcastMessage("");
      setBroadcastHref("");
      setBroadcastUsernamesText("");
      setActionMessage(
        "Broadcast requested. A different admin from a different IP must approve it before it goes live."
      );
    } catch (e) {
      console.error("Broadcast notification error", e);
      setErrorMessage("Unexpected error sending broadcast notification.");
    } finally {
      setBroadcastSending(false);
    }
  };

  const handleAddIpBan = async () => {
    if (!isAdmin) return;
    const ip = newIp.trim();
    const reason = newIpReason.trim() || null;

    if (!ip) {
      setErrorMessage("Enter an IP address to ban.");
      return;
    }

    try {
      setIpSaving(true);
      setErrorMessage(null);
      setActionMessage(null);

      const supabase = supabaseBrowser();

      const { data, error } = await supabase
        .from("ip_bans")
        .insert({
          ip_address: ip,
          reason,
          created_by: currentUserId,
        })
        .select("id, ip_address, reason, created_at, created_by")
        .single<IpBanRow>();

      if (error) {
        console.error("Failed to add IP ban", error);
        setErrorMessage("Failed to add IP ban.");
        return;
      }

      if (data) {
        setIpBans((prev) => [data, ...prev]);
      }

      setNewIp("");
      setNewIpReason("");
      setActionMessage(`IP ${ip} banned.`);
    } catch (e) {
      console.error("Add IP ban error", e);
      setErrorMessage("Unexpected error adding IP ban.");
    } finally {
      setIpSaving(false);
    }
  };

  const handleRemoveIpBan = async (id: number) => {
    if (!isAdmin) return;

    try {
      setIpSaving(true);
      setErrorMessage(null);
      setActionMessage(null);

      const supabase = supabaseBrowser();

      const { error } = await supabase.from("ip_bans").delete().eq("id", id);

      if (error) {
        console.error("Failed to remove IP ban", error);
        setErrorMessage("Failed to remove IP ban.");
        return;
      }

      setIpBans((prev) => prev.filter((ban) => ban.id !== id));
      setActionMessage("IP ban removed.");
    } catch (e) {
      console.error("Remove IP ban error", e);
      setErrorMessage("Unexpected error removing IP ban.");
    } finally {
      setIpSaving(false);
    }
  };

  if (!accessLoading && !perms.has("security.view")) {
    return <AccessDeniedCard />;
  }

  if (loading && isAdmin === null) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-8 text-sm text-brand-text">
        <p>Loading security settings…</p>
      </div>
    );
  }

  if (isAdmin === false) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-8 text-sm text-brand-text">
        <p className="text-[11px] uppercase tracking-[0.15em] text-brand-textMuted">
          Admin • Security
        </p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight sm:text-3xl">
          Site security
        </h1>
        <p className="mt-2 text-[12px] text-brand-textMuted">
          {errorMessage ?? "Access denied. Admins only."}
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-8 text-sm text-brand-text">
      <section>
        <p className="text-[11px] uppercase tracking-[0.15em] text-brand-textMuted">
          Admin • Security
        </p>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-2">
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
            Site security
          </h1>
          <div className="flex flex-wrap items-center gap-3 text-[11px]">
            <Link
              href="/staff/security/audit"
              className="rounded-full border border-zinc-700 bg-black/50 px-3 py-1 text-[11px] text-brand-text hover:border-amber-400/80 hover:text-amber-200"
            >
              View audit logs →
            </Link>
          </div>
        </div>
        <p className="mt-1 text-[12px] text-brand-textMuted sm:text-sm">
          Lock the site behind a password, enable maintenance mode, manage
          emergency banners, or force all users to log in again.
        </p>
        {/* Sidebar navigation already provides a consistent way to move around staff tools. */}
      </section>

      <AdminApprovalsPanel />

      {errorMessage && (
        <div className="rounded-md border border-red-500/60 bg-red-500/10 px-3 py-2 text-[12px] text-red-100">
          {errorMessage}
        </div>
      )}
      {actionMessage && (
        <div className="rounded-md border border-emerald-500/60 bg-emerald-500/10 px-3 py-2 text-[12px] text-emerald-100">
          {actionMessage}
        </div>
      )}
      {/* Lockdown section */}
      <section className="rounded-xl border border-zinc-800/80 bg-black/40 p-4">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-brand-text">
            Lockdown mode
          </h2>
          {lastUpdatedAt && (
            <span className="text-[11px] text-brand-textMuted">
              Last updated: {lastUpdatedAt}
            </span>
          )}
        </div>

        <div className="space-y-3 text-[13px]">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={lockdownEnabled}
              onChange={(e) => setLockdownEnabled(e.target.checked)}
              className="no-zoom-input"
            />
            <span className="text-[12px] text-brand-text">
              Require a password before non-admins can use the site
            </span>
          </label>

          <div>
            <label className="mb-1 block text-[11px] text-brand-textMuted">
              Lockdown message (shown on the password screen)
            </label>
            <textarea
              value={lockdownMessage}
              onChange={(e) => setLockdownMessage(e.target.value)}
              rows={3}
              className="no-zoom-input w-full rounded-md border border-zinc-700 bg-black/60 px-2 py-1.5 text-[12px] text-brand-text outline-none placeholder:text-zinc-500"
              placeholder="Example: We're doing emergency maintenance after a security issue. The site will be back soon."
            />
          </div>

          <div>
            <label className="mb-1 block text-[11px] text-brand-textMuted">
              New lockdown password (optional)
            </label>
            <input
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              className="no-zoom-input w-full rounded-md border border-zinc-700 bg-black/60 px-2 py-1.5 text-[12px] text-brand-text outline-none placeholder:text-zinc-500"
              placeholder="Leave blank to keep current password"
            />
          </div>

          <button
            type="button"
            onClick={handleSaveSettings}
            disabled={saving}
            className="mt-1 inline-flex items-center justify-center rounded-full border border-amber-400/80 bg-amber-500/20 px-4 py-1.5 text-[12px] font-medium text-amber-200 shadow-sm shadow-black/60 hover:bg-amber-500/30 disabled:opacity-60"
          >
            {saving ? "Saving…" : "Save security settings"}
          </button>
        </div>
      </section>
      {/* Maintenance + force logout */}
      <section className="grid gap-4 md:grid-cols-2">
        <div className="rounded-xl border border-zinc-800/80 bg-black/40 p-4 text-[13px]">
          <h2 className="mb-1 text-sm font-semibold text-brand-text">
            Maintenance mode
          </h2>
          <p className="mb-2 text-[12px] text-brand-textMuted">
            Simple read-only toggle you can hook into write routes (info,
            garage, forums, etc).
          </p>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={maintenanceMode}
              onChange={(e) => setMaintenanceMode(e.target.checked)}
              className="no-zoom-input"
            />
            <span className="text-[12px] text-brand-text">
              Maintenance mode enabled
            </span>
          </label>
        </div>

        <div className="rounded-xl border border-zinc-800/80 bg-black/40 p-4 text-[13px]">
          <h2 className="mb-1 text-sm font-semibold text-brand-text">
            Force logout all users
          </h2>
          <p className="mb-2 text-[12px] text-brand-textMuted">
            Sends a signal so that everyone gets logged out the next time they
            load a page. Good after role changes or security issues.
          </p>
          <button
            type="button"
            onClick={handleForceLogout}
            disabled={saving}
            className="inline-flex items-center justify-center rounded-full border border-red-500/80 bg-red-500/20 px-4 py-1.5 text-[12px] font-medium text-red-100 shadow-sm shadow-black/60 hover:bg-red-500/30 disabled:opacity-60"
          >
            {saving ? "Sending…" : "Log out all users"}
          </button>
        </div>
      </section>
      {/* Emergency banner */}
      <section className="rounded-xl border border-zinc-800/80 bg-black/40 p-4 text-[13px]">
        <h2 className="mb-1 text-sm font-semibold text-brand-text">
          Broadcast banner
        </h2>
        <p className="mb-3 text-[12px] text-brand-textMuted">
          Show a site-wide banner at the top of every page for outages,
          incidents, or important announcements. This is saved together with the
          security settings.
        </p>

        <div className="mb-2 flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-[12px] text-brand-text">
            <input
              type="checkbox"
              checked={bannerEnabled}
              onChange={(e) => setBannerEnabled(e.target.checked)}
              className="no-zoom-input" />
            <span>Banner enabled</span>
          </label>

          <div className="flex items-center gap-2 text-[12px]">
            <span className="text-brand-textMuted">Severity:</span>
<MenuSelect
              ariaLabel="Severity"
              value={bannerLevel}
              onChange={(next) => setBannerLevel(next as BannerLevel)}
              className="flex h-8 items-center gap-2 rounded-md border border-zinc-700 bg-black/60 px-2 text-[12px] text-brand-text outline-none transition hover:border-amber-400/70"
              options={[
                { value: "info", label: "Info" },
                { value: "warning", label: "Warning" },
                { value: "critical", label: "Critical" },
              ]}
            />
          </div>
        </div>

        <div>
          <label className="mb-1 block text-[11px] text-brand-textMuted">
            Banner text
          </label>
          <textarea
            value={bannerText}
            onChange={(e) => setBannerText(e.target.value)}
            rows={3}
            placeholder="Example: We’re investigating issues with logins. Some users may be unable to sign in."
            className="no-zoom-input w-full rounded-md border border-zinc-700 bg-black/60 px-2 py-1.5 text-[12px] text-brand-text outline-none placeholder:text-zinc-500"
          />
        </div>

        <div className="mt-3 flex items-center justify-between">
          <p className="text-[11px] text-zinc-500">
            This banner will appear on every page where you mount the banner
            component. Changes are saved when you click{" "}
            <span className="font-semibold">Save security settings</span> or{" "}
            <span className="font-semibold">Save banner</span>.
          </p>
          <button
            type="button"
            onClick={handleSaveSettings}
            disabled={saving}
            className="inline-flex items-center justify-center rounded-full border border-amber-400/80 bg-amber-500/20 px-4 py-1.5 text-[12px] font-medium text-amber-200 shadow-sm shadow-black/60 hover:bg-amber-500/30 disabled:opacity-60 whitespace-nowrap"
          >
            {saving ? "Saving…" : "Save banner"}
          </button>
        </div>
      </section>

      {/* Broadcast notification */}
      <section className="rounded-xl border border-zinc-800/80 bg-black/40 p-4 text-[13px]">
        <h2 className="mb-1 text-sm font-semibold text-brand-text">
          Send notification
        </h2>
        <p className="mb-3 text-[12px] text-brand-textMuted">
          Send a one-time notification to all users, staff only, or a specific list of users.
          This does not affect DMs and does not poll clients—users will see it when they open
          the notifications dropdown or page.
        </p>

        <div className="grid gap-3">
          <div className="flex flex-wrap items-center gap-3 text-[12px] text-brand-textMuted">
            <span className="text-brand-textMuted">Audience:</span>
            <label className="inline-flex items-center gap-2">
              <input
                type="radio"
                name="broadcastAudience"
                checked={broadcastAudience === "all"}
                onChange={() => setBroadcastAudience("all")}
                className="h-4 w-4"
              />
              <span>All users</span>
            </label>
            <label className="inline-flex items-center gap-2">
              <input
                type="radio"
                name="broadcastAudience"
                checked={broadcastAudience === "staff"}
                onChange={() => setBroadcastAudience("staff")}
                className="h-4 w-4"
              />
              <span>Staff only</span>
            </label>
            <label className="inline-flex items-center gap-2">
              <input
                type="radio"
                name="broadcastAudience"
                checked={broadcastAudience === "users"}
                onChange={() => setBroadcastAudience("users")}
                className="h-4 w-4"
              />
              <span>Specific users</span>
            </label>
          </div>

          {broadcastAudience === "users" && (
            <div>
              <label className="mb-1 block text-[11px] text-brand-textMuted">
                Usernames (comma/space separated)
              </label>
              <div className="relative">
                <input
                  ref={broadcastUsersInputRef}
                  type="text"
                  value={broadcastUsernamesText}
                  onChange={(e) => handleBroadcastUsernamesChange(e.target.value)}
                  onKeyDown={handleBroadcastUsernamesKeyDown}
                  onBlur={() => {
                    // give click selection a moment to fire
                    setTimeout(() => closeUserAc(), 120);
                  }}
                  placeholder="@user1, @user2, @user3..."
                  className="no-zoom-input w-full rounded-md border border-zinc-700 bg-black/60 px-2 py-1.5 text-[12px] text-brand-text outline-none placeholder:text-zinc-500"
                />

                {userAcOpen && (
                  <div className="absolute left-0 right-0 top-full z-30 mt-1 overflow-hidden rounded-xl border border-zinc-800 bg-zinc-950/95 shadow-2xl backdrop-blur">
                    {userAcLoading ? (
                      <div className="px-3 py-2 text-[11px] text-brand-textMuted">Loading…</div>
                    ) : userAcItems.length === 0 ? (
                      <div className="px-3 py-2 text-[11px] text-brand-textMuted">No users</div>
                    ) : (
                      <ul className="max-h-[220px] overflow-auto">
                        {userAcItems.map((u, idx) => {
                          const active = idx === userAcActiveIndex;
                          return (
                            <li key={u.id}>
                              <button
                                type="button"
                                onMouseDown={(ev) => ev.preventDefault()}
                                onClick={() => applyUserSuggestion(u.username)}
                                className={
                                  "flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] " +
                                  (active ? "bg-white/10 text-brand-text" : "text-brand-textMuted hover:bg-white/5")
                                }
                              >
                                <div className="h-6 w-6 shrink-0 overflow-hidden rounded-full border border-zinc-800 bg-black/30">
                                  {/* eslint-disable-next-line @next/next/no-img-element */}
                                  {u.avatar_url ? (
                                    <img src={u.avatar_url} alt="" className="h-full w-full object-cover" />
                                  ) : (
                                    <div className="flex h-full w-full items-center justify-center text-[10px] text-zinc-500">
                                      {String(u.display_name || u.username || "?")[0]?.toUpperCase()}
                                    </div>
                                  )}
                                </div>
                                <div className="min-w-0 flex-1">
                                  <div className="truncate text-[12px] font-medium text-brand-text">@{u.username}</div>
                                  {u.display_name ? (
                                    <div className="truncate text-[11px] text-brand-textMuted">{u.display_name}</div>
                                  ) : null}
                                </div>
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </div>
                )}
              </div>
              <p className="mt-1 text-[11px] text-zinc-500">
                Tip: You can paste multiple usernames separated by commas, spaces, or new lines.
              </p>
            </div>
          )}
          <div>
            <label className="mb-1 block text-[11px] text-brand-textMuted">
              Title
            </label>
            <input
              type="text"
              value={broadcastTitle}
              onChange={(e) => setBroadcastTitle(e.target.value)}
              placeholder="Example: Scheduled maintenance"
              className="no-zoom-input w-full rounded-md border border-zinc-700 bg-black/60 px-2 py-1.5 text-[12px] text-brand-text outline-none placeholder:text-zinc-500"
            />
          </div>

          <div>
            <label className="mb-1 block text-[11px] text-brand-textMuted">
              Message (optional)
            </label>
            <textarea
              value={broadcastMessage}
              onChange={(e) => setBroadcastMessage(e.target.value)}
              rows={3}
              placeholder="What should users know?"
              className="no-zoom-input w-full rounded-md border border-zinc-700 bg-black/60 px-2 py-1.5 text-[12px] text-brand-text outline-none placeholder:text-zinc-500"
            />
          </div>

          <div>
            <label className="mb-1 block text-[11px] text-brand-textMuted">
              Link (optional)
            </label>
            <input
              type="text"
              value={broadcastHref}
              onChange={(e) => setBroadcastHref(e.target.value)}
              placeholder="/info/status or https://..."
              className="no-zoom-input w-full rounded-md border border-zinc-700 bg-black/60 px-2 py-1.5 text-[12px] text-brand-text outline-none placeholder:text-zinc-500"
            />
          </div>

          <label className="inline-flex items-center gap-2 text-[12px] text-brand-textMuted">
            <input
              type="checkbox"
              checked={broadcastAsServer}
              onChange={(e) => setBroadcastAsServer(e.target.checked)}
              className="no-zoom-input"
            />
            Send as server (not from my account)
          </label>

          <div className="flex items-center justify-end">
            <button
              type="button"
              onClick={handleSendBroadcastNotification}
              disabled={broadcastSending}
              className="inline-flex items-center justify-center rounded-full border border-amber-400/80 bg-amber-500/20 px-4 py-1.5 text-[12px] font-medium text-amber-200 shadow-sm shadow-black/60 hover:bg-amber-500/30 disabled:opacity-60"
            >
              {broadcastSending ? "Sending…" : "Send notification"}
            </button>
          </div>
        </div>
      </section>

      {/* IP ban list */}
      <section className="rounded-xl border border-zinc-800/80 bg-black/40 p-4 text-[13px]">
        <div className="mb-2 flex items-center justify-between gap-2">
          <div>
            <h2 className="text-sm font-semibold text-brand-text">
              IP ban list
            </h2>
            <p className="mt-0.5 text-[11px] text-brand-textMuted">
              Block abusive clients at the IP level. This is enforced by your
              global gate + /api/security/ip-check.
            </p>
          </div>
        </div>

        <div className="mt-3 space-y-2">
          <div className="grid gap-2 md:grid-cols-[1fr,1fr,auto]">
            <input
              type="text"
              value={newIp}
              onChange={(e) => setNewIp(e.target.value)}
              placeholder="IP address (e.g. 203.0.113.42)"
              className="no-zoom-input w-full rounded-md border border-zinc-700 bg-black/60 px-2 py-1.5 text-[12px] text-brand-text outline-none placeholder:text-zinc-500"
            />
            <input
              type="text"
              value={newIpReason}
              onChange={(e) => setNewIpReason(e.target.value)}
              placeholder="Reason (optional, admin only)"
              className="no-zoom-input w-full rounded-md border border-zinc-700 bg-black/60 px-2 py-1.5 text-[12px] text-brand-text outline-none placeholder:text-zinc-500"
            />
            <button
              type="button"
              onClick={handleAddIpBan}
              disabled={ipSaving}
              className="inline-flex items-center justify-center rounded-full border border-red-500/70 bg-red-500/15 px-4 py-1.5 text-[12px] font-medium text-red-200 shadow-sm shadow-black/60 hover:bg-red-500/25 disabled:opacity-60"
            >
              {ipSaving ? "Adding…" : "Ban IP"}
            </button>
          </div>

          <div className="mt-3 border-t border-zinc-800/80 pt-3">
            {ipLoading ? (
              <p className="text-[12px] text-brand-textMuted">
                Loading IP bans…
              </p>
            ) : ipBans.length === 0 ? (
              <p className="text-[12px] text-brand-textMuted">
                No IPs are currently banned.
              </p>
            ) : (
              <ul className="space-y-1.5">
                {ipBans.map((ban) => (
                  <li
                    key={ban.id}
                    className="flex items-center justify-between gap-3 rounded-lg border border-zinc-800/80 bg-black/40 px-3 py-2"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 text-[12px]">
                        <span className="inline-flex items-center rounded-full border border-amber-400/60 bg-amber-500/10 px-2 py-[1px] text-[11px] font-medium text-amber-200">
                          {ban.ip_address}
                        </span>
                      </div>
                      {ban.reason && (
                        <p className="mt-0.5 truncate text-[11px] text-brand-textMuted">
                          {ban.reason}
                        </p>
                      )}
                      <p className="mt-0.5 text-[11px] text-zinc-500">
                        Banned{" "}
                        {new Date(ban.created_at).toLocaleString(undefined, {
                          dateStyle: "short",
                          timeStyle: "short",
                        })}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => handleRemoveIpBan(ban.id)}
                      disabled={ipSaving}
                      className="inline-flex items-center justify-center rounded-full border border-zinc-700 bg-black/60 px-3 py-1 text-[11px] font-medium text-zinc-200 hover:border-red-500/70 hover:bg-red-500/20 hover:text-red-100 disabled:opacity-60"
                    >
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
