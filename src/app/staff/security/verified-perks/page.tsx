"use client";

import { useEffect, useMemo, useState } from "react";

import { useMeAccess } from "@/lib/hooks/useMeAccess";
import { supabaseBrowser } from "@/lib/supabaseClient";
import { AccessDeniedCard } from "@/components/AccessDeniedCard";
import { PERMISSION_META } from "@/lib/permissions";

type LoadState = "loading" | "ready";

const VERIFIED_PERKS_ALLOWED = ["info.submit", "info.update.submit"] as const;

export default function VerifiedPerksPage() {
  const { data: access, isLoading: accessLoading } = useMeAccess();
  const canManage = Boolean(access?.permissions?.includes("security.verified_perks.manage"));

  const [state, setState] = useState<LoadState>("loading");
  const [tableMissing, setTableMissing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);

  const allPerms = useMemo(() => {
    // Verified perks are intentionally *very* limited.
    return VERIFIED_PERKS_ALLOWED.filter((k) => Object.prototype.hasOwnProperty.call(PERMISSION_META, k));
  }, []);

  useEffect(() => {
    if (!canManage || accessLoading) return;

    (async () => {
      try {
        const supabase = supabaseBrowser();
        const { data: sessionData } = await supabase.auth.getSession();
        const token = sessionData?.session?.access_token;
        const res = await fetch("/api/staff/security/verified-perks", {
          headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        });
        const json = await res.json();
        const perms = Array.isArray(json?.permissions) ? json.permissions : [];
        setSelected(new Set(perms.filter((p: any) => typeof p === "string")));
        setTableMissing(Boolean(json?.tableMissing));
        setError(typeof json?.error === "string" ? json.error : null);
      } catch (e: any) {
        setError(e?.message || "Failed to load");
      } finally {
        setState("ready");
      }
    })();
  }, [canManage, accessLoading]);

  if (accessLoading) {
    return <div className="mx-auto max-w-5xl px-4 py-8">Loading...</div>;
  }

  if (!canManage) {
    return (
      <div className="mx-auto max-w-5xl px-4 py-8">
        <AccessDeniedCard title="Access denied" />
      </div>
    );
  }

  const toggle = (perm: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(perm)) next.delete(perm);
      else next.add(perm);
      return next;
    });
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const supabase = supabaseBrowser();
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData?.session?.access_token;
      const res = await fetch("/api/staff/security/verified-perks", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : null),
        } as any,
        body: JSON.stringify({ permissions: Array.from(selected) }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error || "Save failed");
      setTableMissing(Boolean(json?.tableMissing));
    } catch (e: any) {
      setError(e?.message || "Save failed");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mx-auto max-w-5xl px-4 py-8">
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold">Verified Badge Perks</h1>
        <p className="text-sm text-brand-textMuted">
          These permissions are automatically granted to users who have the verified badge.
        </p>
        {tableMissing ? (
          <div className="mt-2 rounded-xl border border-amber-400/30 bg-amber-500/10 p-3 text-sm text-amber-200">
            The database table <span className="font-mono">site_verified_perks</span> wasn't found.
            Create it with columns <span className="font-mono">id int primary key</span> and
            <span className="font-mono"> permissions text[]</span>, then refresh.
          </div>
        ) : null}
        {error ? (
          <div className="mt-2 rounded-xl border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-200">{error}</div>
        ) : null}
      </div>

      <div className="mt-6 rounded-2xl border border-white/10 bg-black/35 p-4 backdrop-blur-md">
        {state === "loading" ? (
          <div>Loading...</div>
        ) : (
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {allPerms.map((key) => {
              const meta = (PERMISSION_META as any)[key] as { category?: string; label?: string; description?: string };
              const checked = selected.has(key);
              return (
                <label
                  key={key}
                  className={`flex cursor-pointer items-start rounded-xl border p-3 transition-colors ${
                    checked
                      ? "border-emerald-400/40 bg-emerald-500/10"
                      : "border-white/10 bg-black/30 hover:border-brand-primary/40"
                  }`}
                >
                  <input
                    type="checkbox"
                    className="sr-only"
                    checked={checked}
                    onChange={() => toggle(key)}
                  />
                  <div className="min-w-0">
                    <div className="text-sm font-medium">{meta?.label || key}</div>
                    <div className="break-words text-xs text-brand-textMuted">
                      <span className="font-mono">{key}</span>
                      {meta?.description ? <> · {meta.description}</> : null}
                    </div>
                  </div>
                </label>
              );
            })}
          </div>
        )}

        <div className="mt-4 flex items-center justify-end gap-2">
          <button
            onClick={save}
            disabled={saving}
            className="ui-btn ui-btn-primary text-sm disabled:opacity-60"
          >
            {saving ? "Saving..." : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
