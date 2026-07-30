"use client";

import { useEffect, useMemo, useState } from "react";
import { usePathname } from "next/navigation";
import { supabaseBrowser } from "@/lib/supabaseClient";
import { siteConfig } from "@/site.config";

type Props = {
  children: React.ReactNode;
};

type FlagsRow = {
  lockdown_enabled: boolean;
  lockdown_message: string | null;
  force_logout_epoch: number | null;
  maintenance_mode: boolean | null;
  lockdown_version: number | null;
};

type IpCheckResponse = {
  banned: boolean;
  reason?: string | null;
};

const LOCAL_UNLOCK_KEY = "scra_lockdown_ok"; // JSON: { v: number }
const LOCAL_FORCE_LOGOUT_KEY = "scra_force_logout_seen";

export default function GlobalLockdownGate({ children }: Props) {
  const pathname = usePathname();
  const supabase = useMemo(() => supabaseBrowser(), []);

  const [loading, setLoading] = useState(true);

  const [isAdmin, setIsAdmin] = useState(false);
  const [lockdownEnabled, setLockdownEnabled] = useState(false);
  const [lockdownMessage, setLockdownMessage] = useState("");
  const [lockdownVersion, setLockdownVersion] = useState(1);
  const [unlocked, setUnlocked] = useState(false);

  const [passwordInput, setPasswordInput] = useState("");
  const [checkingPassword, setCheckingPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [ipBanned, setIpBanned] = useState(false);
  const [ipBanReason, setIpBanReason] = useState<string | null>(null);

  // -------- init --------
  useEffect(() => {
    const init = async () => {
      try {
        // 0) IP ban check
        try {
          const res = await fetch("/api/security/ip-check", {
            method: "GET",
            cache: "no-store",
          });

          if (res.ok) {
            const body = (await res.json()) as IpCheckResponse;
            if (body.banned) {
              setIpBanned(true);
              setIpBanReason(body.reason ?? null);
              setLoading(false);
              return;
            }
          }
        } catch (e) {
          console.error("IP check failed (continuing)", e);
        }

        // 1) Determine admin
        const { data: userRes } = await supabase.auth.getUser();
        const user = userRes?.user ?? null;

        if (user) {
          const { data: roleRow } = await supabase
            .from("user_roles")
            .select("role")
            .eq("user_id", user.id)
            .maybeSingle<{ role: string }>();

          setIsAdmin(roleRow?.role === "admin");
        } else {
          setIsAdmin(false);
        }

        // 2) Load lockdown flags
        const { data, error: flagsErr } = await supabase.rpc("get_site_lockdown_flags");
        if (flagsErr || !data || data.length === 0) {
          console.error("get_site_lockdown_flags error", flagsErr);
          setLoading(false);
          return;
        }

        const row = data[0] as FlagsRow;

        const enabled = Boolean(row.lockdown_enabled);
        const version = row.lockdown_version ?? 1;

        setLockdownEnabled(enabled);
        setLockdownMessage(row.lockdown_message ?? "");
        setLockdownVersion(version);

        // 3) Force logout signal:
        // DO sign out + clear unlock, BUT DO NOT redirect to /auth/login.
        if (typeof window !== "undefined" && row.force_logout_epoch) {
          const remoteEpoch = row.force_logout_epoch;
          const localSeenRaw = window.localStorage.getItem(LOCAL_FORCE_LOGOUT_KEY);
          const localSeen = localSeenRaw ? parseInt(localSeenRaw, 10) || 0 : 0;

          if (remoteEpoch > localSeen) {
            try {
              await supabase.auth.signOut();
            } catch (e) {
              console.error("Error during forced signOut", e);
            }

            window.localStorage.setItem(LOCAL_FORCE_LOGOUT_KEY, String(remoteEpoch));
            window.localStorage.removeItem(LOCAL_UNLOCK_KEY);

            // Important: don't redirect. Gate logic handles it.
          }
        }

        // 4) Local unlock (must match version)
        if (typeof window !== "undefined") {
          const stored = window.localStorage.getItem(LOCAL_UNLOCK_KEY);
          if (stored) {
            try {
              const parsed = JSON.parse(stored) as { v?: number };
              if (parsed.v === version) setUnlocked(true);
            } catch {
              // ignore
            }
          }
        }
      } catch (e) {
        console.error("GlobalLockdownGate init error", e);
      } finally {
        setLoading(false);
      }
    };

    void init();
  }, [supabase]);

  // -------- redirect-to-home when locked (kept, but hook is top-level) --------
  const isAuthRoute = pathname.startsWith("/auth");

  const shouldGate =
    !loading &&
    !ipBanned &&
    lockdownEnabled &&
    !isAdmin &&
    !isAuthRoute &&
    !unlocked;

  const shouldForceHome = shouldGate && pathname !== "/";

  useEffect(() => {
    if (!shouldForceHome) return;
    if (typeof window === "undefined") return;

    // keep your “force to /” behavior
    window.location.replace("/");
  }, [shouldForceHome]);

  // -------- unlock submit --------
  const handleSubmitPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    try {
      setCheckingPassword(true);

      const { data, error: rpcErr } = await supabase.rpc("check_lockdown_password", {
        p_password: passwordInput,
      });

      if (rpcErr) {
        console.error("check_lockdown_password error", rpcErr);
        setError("Something went wrong. Try again.");
        return;
      }

      const ok = Boolean(data);
      if (!ok) {
        setError("Incorrect password.");
        return;
      }

      if (typeof window !== "undefined") {
        window.localStorage.setItem(LOCAL_UNLOCK_KEY, JSON.stringify({ v: lockdownVersion }));
      }

      setUnlocked(true);
      setPasswordInput("");
    } catch (err) {
      console.error("unlock submit error", err);
      setError("Something went wrong. Try again.");
    } finally {
      setCheckingPassword(false);
    }
  };

  // ---------------- render ----------------

  // While loading flags, don't block (prevents flicker)
  if (loading) return <>{children}</>;

  // Hard block: IP banned overrides everything
  if (ipBanned) {
    return (
      <div className="fixed inset-0 z-[9999] flex min-h-screen items-center justify-center bg-black px-4">
        <div className="w-full max-w-sm rounded-xl border border-red-700 bg-brand-bgStart/95 p-4 text-sm text-brand-text shadow-xl shadow-black/80">
          <h2 className="mb-2 text-base font-semibold text-red-100">Access blocked</h2>
          <p className="mb-2 text-[12px] text-red-100/80">
            This IP address has been blocked from accessing {siteConfig.identity.name}.
          </p>
          {ipBanReason && (
            <p className="mb-2 text-[11px] text-red-200/80">Reason: {ipBanReason}</p>
          )}
          <p className="text-[10px] text-red-200/70">
            If you believe this is a mistake, contact the site owner with your IP address.
          </p>
        </div>
      </div>
    );
  }

  // If lockdown is off or admin/unlocked/auth route, allow through
  if (!lockdownEnabled || isAdmin || unlocked || isAuthRoute) {
    return <>{children}</>;
  }

  // If locked and we're not on "/", the effect will force-home; render nothing to avoid flash.
  if (pathname !== "/") {
    return null;
  }

  // Gate UI
  return (
    <div className="fixed inset-0 z-[9999] flex min-h-screen items-center justify-center bg-black px-4">
      <div className="w-full max-w-sm rounded-xl border border-zinc-800 bg-brand-bgStart/95 p-4 text-sm text-brand-text shadow-xl shadow-black/80">
        <h2 className="mb-2 text-base font-semibold text-brand-text">Site temporarily locked</h2>

        {lockdownMessage ? (
          <p className="mb-3 text-[12px] text-brand-textMuted">{lockdownMessage}</p>
        ) : (
          <p className="mb-3 text-[12px] text-brand-textMuted">
            The site is in lockdown mode. Enter the password to continue.
          </p>
        )}

        <form onSubmit={handleSubmitPassword} className="space-y-3">
          <div>
            <label className="mb-1 block text-[11px] text-brand-textMuted">
              Lockdown password
            </label>
            <input
              type="password"
              value={passwordInput}
              onChange={(e) => setPasswordInput(e.target.value)}
              className="w-full no-zoom-input rounded-md border border-zinc-700 bg-black/60 px-2 py-1.5 text-[12px] text-brand-text outline-none placeholder:text-zinc-500 focus:border-amber-400/80"
              placeholder="••••••••"
            />
          </div>

          {error && <p className="text-[11px] text-red-400">{error}</p>}

          {/* Mobile-visible, high-contrast */}
          <button
            type="submit"
            disabled={!passwordInput.trim() || checkingPassword}
            className="w-full min-h-[44px] rounded-md border border-amber-300/40 bg-amber-400 px-3 py-2 text-[13px] font-semibold text-zinc-950 shadow-sm shadow-black/60 transition hover:bg-amber-300 focus:outline-none focus:ring-2 focus:ring-amber-400/40 disabled:opacity-60"
          >
            {checkingPassword ? "Checking…" : "Unlock site"}
          </button>

          <p className="text-[10px] text-brand-textMuted">Admins bypass this automatically.</p>
        </form>
      </div>
    </div>
  );
}
