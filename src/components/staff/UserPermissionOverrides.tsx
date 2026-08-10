"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { Card, EmptyState, ErrorState, LoadingState, Section } from "@/components/staff/StaffPage";
import { MenuSelect } from "@/components/ui/MenuSelect";

/**
 * Per-user permission grants, on top of whatever the role gives.
 *
 * These are additive overrides in `user_permissions`, and they are the strongest
 * thing one staff member can hand another — a direct grant bypasses the role
 * entirely. The existing route already audits the change as `permission.changed`
 * with a computed before/after diff, which is why this component calls it rather
 * than writing anything itself.
 *
 * Grouped by category and collapsed behind a filter, because the full list is
 * ninety-odd keys and an ungrouped wall of checkboxes is how somebody ticks the
 * wrong one.
 */

type PermissionRow = { key: string; description: string | null; category: string | null };

export function UserPermissionOverrides({
  userId,
  token,
  canGrant,
}: {
  userId: string;
  token: string;
  canGrant: boolean;
}) {
  const [catalog, setCatalog] = useState<PermissionRow[]>([]);
  const [granted, setGranted] = useState<Set<string>>(new Set());
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [category, setCategory] = useState("all");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  const load = useCallback(async () => {
    setState("loading");
    try {
      const headers = { Authorization: `Bearer ${token}` };
      const [catalogRes, grantedRes] = await Promise.all([
        fetch("/api/staff/security/permissions", { headers }),
        fetch(`/api/staff/security/users/${userId}/permissions`, { headers }),
      ]);

      if (!catalogRes.ok || !grantedRes.ok) {
        setState("error");
        return;
      }

      const catalogJson = (await catalogRes.json()) as { permissions?: PermissionRow[] };
      const grantedJson = (await grantedRes.json()) as { permissions?: string[] };

      setCatalog(Array.isArray(catalogJson.permissions) ? catalogJson.permissions : []);
      setGranted(new Set(Array.isArray(grantedJson.permissions) ? grantedJson.permissions : []));
      setDirty(false);
      setState("ready");
    } catch {
      setState("error");
    }
  }, [userId, token]);

  useEffect(() => {
    if (!canGrant) return;
    void load();
  }, [canGrant, load]);

  const categories = useMemo(() => {
    const set = new Set<string>();
    for (const row of catalog) set.add(row.category ?? "General");
    return ["all", ...[...set].sort()];
  }, [catalog]);

  const visible = useMemo(
    () => (category === "all" ? catalog : catalog.filter((row) => (row.category ?? "General") === category)),
    [catalog, category]
  );

  const save = async () => {
    setSaving(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/staff/security/users/${userId}/permissions`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ permissions: [...granted] }),
      });
      const json = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) {
        setMessage(json?.error ?? "Could not save the overrides.");
        return;
      }
      setMessage("Saved.");
      setDirty(false);
      await load();
    } finally {
      setSaving(false);
    }
  };

  if (!canGrant) return null;

  return (
    <Section
      headingLevel={3}
      title="Direct permission grants"
      description="Extra permissions for this person only, on top of their role. Every change is recorded in the audit log."
      actions={
        <MenuSelect
          ariaLabel="Filter permissions by category"
          value={category}
          options={categories.map((c) => ({ value: c, label: c === "all" ? "All categories" : c }))}
          onChange={setCategory}
        />
      }
    >
      {state === "loading" ? <LoadingState /> : null}
      {state === "error" ? <ErrorState onRetry={() => void load()}>Could not load permissions.</ErrorState> : null}
      {state === "ready" ? (
        <Card>
          {visible.length === 0 ? (
            <EmptyState>No permissions in this category.</EmptyState>
          ) : (
            <div className="grid gap-1.5">
              {visible.map((permission) => (
                <label key={permission.key} className="staff-check">
                  <input
                    type="checkbox"
                    checked={granted.has(permission.key)}
                    onChange={(event) => {
                      setGranted((prev) => {
                        const next = new Set(prev);
                        if (event.target.checked) next.add(permission.key);
                        else next.delete(permission.key);
                        return next;
                      });
                      setDirty(true);
                    }}
                  />
                  <span className="staff-check-text">
                    {permission.key}
                    {permission.description ? (
                      <span className="staff-check-help">{permission.description}</span>
                    ) : null}
                  </span>
                </label>
              ))}
            </div>
          )}

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              type="button"
              className="ui-btn ui-btn-primary"
              disabled={!dirty || saving}
              onClick={() => void save()}
            >
              {saving ? "Saving…" : "Save grants"}
            </button>
            <span className="text-xs" aria-live="polite" style={{ color: "var(--muted)" }}>
              {saving ? "Saving…" : dirty ? "Unsaved changes" : message ?? "Everything saved"}
            </span>
          </div>
        </Card>
      ) : null}
    </Section>
  );
}
