"use client";

import { useEffect, useMemo, useState } from "react";
import { MenuSelect } from "@/components/ui/MenuSelect";
import { supabaseBrowser } from "@/lib/supabaseClient";
import { isArray, isRecord, isString } from "@/lib/typeGuards";
import { RolePill } from "@/components/RolePill";
import { AccessDeniedCard } from "@/components/AccessDeniedCard";
import { ROLE_BADGE_ICONS } from "@/lib/staff/roleSchema";

type LoadState = "loading" | "denied" | "loaded";

/** "No icon" is a real choice, so it is an option rather than an empty field. */
const BADGE_ICON_OPTIONS = [
  { value: "", label: "No icon" },
  ...ROLE_BADGE_ICONS.map((name) => ({ value: name as string, label: name })),
];

type RoleRow = {
  key: string;
  label: string;
  description: string | null;
  priority: number;
  is_staff: boolean;
  badge_bg: string;
  badge_border: string;
  badge_text: string;
  badge_icon: string | null;
};

type PermissionRow = {
  key: string;
  description: string | null;
  category: string | null;
};

function normalizeAccess(v: unknown): { permissions: Set<string> } | null {
  if (!isRecord(v) || !isArray(v.permissions)) return null;
  const s = new Set<string>();
  for (const p of v.permissions) {
    if (isString(p)) s.add(p);
  }
  return { permissions: s };
}

function normalizeRoleRows(v: unknown): RoleRow[] {
  if (!isRecord(v) || !isArray(v.roles)) return [];
  const out: RoleRow[] = [];
  for (const r of v.roles) {
    if (!isRecord(r)) continue;
    if (!isString(r.key) || !isString(r.label)) continue;
    out.push({
      key: r.key,
      label: r.label,
      description: isString(r.description) ? r.description : null,
      priority: typeof r.priority === "number" ? r.priority : 0,
      is_staff: typeof r.is_staff === "boolean" ? r.is_staff : false,
      badge_bg: isString(r.badge_bg) ? r.badge_bg : "#111827",
      badge_border: isString(r.badge_border) ? r.badge_border : "#374151",
      badge_text: isString(r.badge_text) ? r.badge_text : "#E5E7EB",
      badge_icon: isString(r.badge_icon) ? r.badge_icon : null,
    });
  }
  return out;
}

function normalizePermissionRows(v: unknown): PermissionRow[] {
  if (!isRecord(v) || !isArray(v.permissions)) return [];
  const out: PermissionRow[] = [];
  for (const p of v.permissions) {
    if (!isRecord(p) || !isString(p.key)) continue;
    out.push({
      key: p.key,
      description: isString(p.description) ? p.description : null,
      category: isString(p.category) ? p.category : null,
    });
  }
  return out;
}

function normalizeRolePermissionRows(v: unknown): Set<string> {
  if (!isRecord(v) || !isArray(v.rows)) return new Set();
  const out = new Set<string>();
  for (const r of v.rows) {
    if (isRecord(r) && isString(r.permission_key)) out.add(r.permission_key);
  }
  return out;
}

async function getViewerToken(): Promise<string | null> {
  const supabase = supabaseBrowser();
  const { data } = await supabase.auth.getSession();
  const token = data?.session?.access_token;
  return typeof token === "string" && token.length ? token : null;
}

export default function StaffSecurityRolesPage() {
  const [state, setState] = useState<LoadState>("loading");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [viewerToken, setViewerToken] = useState<string | null>(null);

  const [roles, setRoles] = useState<RoleRow[]>([]);
  const [permissions, setPermissions] = useState<PermissionRow[]>([]);
  const [selectedRoleKey, setSelectedRoleKey] = useState<string | null>(null);
  const [selectedRolePerms, setSelectedRolePerms] = useState<Set<string>>(new Set());

  const [creatingKey, setCreatingKey] = useState<string>("");
  const [creatingLabel, setCreatingLabel] = useState<string>("");
  const [permissionQuery, setPermissionQuery] = useState<string>("");
  const [permissionCategory, setPermissionCategory] = useState<string>("all");

  // Draft fields so typing doesn't trigger network writes on every keystroke.
  const [labelDraft, setLabelDraft] = useState<string>("");
  const [iconDraft, setIconDraft] = useState<string>("");
  const [bgHexDraft, setBgHexDraft] = useState<string>("");
  const [borderHexDraft, setBorderHexDraft] = useState<string>("");
  const [textHexDraft, setTextHexDraft] = useState<string>("");

  const selectedRole = useMemo(
    () => roles.find((r) => r.key === selectedRoleKey) ?? null,
    [roles, selectedRoleKey]
  );

  useEffect(() => {
    if (!selectedRole) {
      setLabelDraft("");
      setIconDraft("");
      setBgHexDraft("");
      setBorderHexDraft("");
      setTextHexDraft("");
      return;
    }
    setLabelDraft(selectedRole.label ?? "");
    setIconDraft(selectedRole.badge_icon ?? "");
    setBgHexDraft(selectedRole.badge_bg ?? "");
    setBorderHexDraft(selectedRole.badge_border ?? "");
    setTextHexDraft(selectedRole.badge_text ?? "");
  }, [selectedRoleKey, selectedRole?.label, selectedRole?.badge_icon]);

  const permissionCategories = useMemo(() => {
    const set = new Set<string>();
    for (const p of permissions) {
      const c = (p.category ?? "").trim();
      if (c) set.add(c);
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [permissions]);

  const filteredPermissions = useMemo(() => {
    const q = permissionQuery.trim().toLowerCase();
    return permissions.filter((p) => {
      if (permissionCategory !== "all" && (p.category ?? "") !== permissionCategory) return false;
      if (!q) return true;
      const hay = `${p.key} ${(p.description ?? "")} ${(p.category ?? "")}`.toLowerCase();
      return hay.includes(q);
    });
  }, [permissionCategory, permissionQuery, permissions]);

  const isValidHex = (v: string) => /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(v.trim());

  useEffect(() => {
    const boot = async () => {
      setState("loading");
      setErrorMessage(null);

      const token = await getViewerToken();
      if (!token) {
        setState("denied");
        setErrorMessage("You must be logged in.");
        return;
      }
      setViewerToken(token);

      const accessRes = await fetch("/api/me/access", {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
      });
      const accessJson = (await accessRes.json().catch(() => null)) as unknown;
      const access = normalizeAccess(accessJson);
      if (!access || !access.permissions.has("roles.manage")) {
        setState("denied");
        setErrorMessage("Access denied.");
        return;
      }

      setState("loaded");
    };

    void boot();
  }, []);

  const loadRolesAndPermissions = async () => {
    if (!viewerToken) return;
    const [rolesRes, permsRes] = await Promise.all([
      fetch("/api/staff/security/roles", {
        method: "GET",
        headers: { Authorization: `Bearer ${viewerToken}` },
      }),
      fetch("/api/staff/security/permissions", {
        method: "GET",
        headers: { Authorization: `Bearer ${viewerToken}` },
      }),
    ]);

    const rolesJson = (await rolesRes.json().catch(() => null)) as unknown;
    const permsJson = (await permsRes.json().catch(() => null)) as unknown;

    setRoles(normalizeRoleRows(rolesJson));
    setPermissions(normalizePermissionRows(permsJson));
  };

  useEffect(() => {
    if (state !== "loaded") return;
    void loadRolesAndPermissions();
  }, [state, viewerToken]);

  const loadRolePermissions = async (roleKey: string) => {
    if (!viewerToken) return;
    const res = await fetch(`/api/staff/security/roles/${encodeURIComponent(roleKey)}/permissions/list`, {
      method: "GET",
      headers: { Authorization: `Bearer ${viewerToken}` },
    });
    const json = (await res.json().catch(() => null)) as unknown;
    setSelectedRolePerms(normalizeRolePermissionRows(json));
  };

  const selectRole = async (roleKey: string) => {
    setSelectedRoleKey(roleKey);
    await loadRolePermissions(roleKey);
  };

  const togglePermission = (permKey: string) => {
    setSelectedRolePerms((prev) => {
      const next = new Set(prev);
      if (next.has(permKey)) next.delete(permKey);
      else next.add(permKey);
      return next;
    });
  };

  const saveRolePermissions = async () => {
    if (!viewerToken || !selectedRoleKey) return;
    const res = await fetch(`/api/staff/security/roles/${encodeURIComponent(selectedRoleKey)}/permissions`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${viewerToken}`,
      },
      body: JSON.stringify({ permissions: Array.from(selectedRolePerms) }),
    });
    if (!res.ok) {
      const j = (await res.json().catch(() => null)) as unknown;
      const msg = isRecord(j) && isString(j.error) ? j.error : "Failed to save permissions.";
      alert(msg);
    } else {
      alert("Saved.");
    }
  };

  const updateRole = async (updates: Partial<RoleRow>) => {
    if (!viewerToken || !selectedRoleKey) return;
    const res = await fetch(`/api/staff/security/roles/${encodeURIComponent(selectedRoleKey)}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${viewerToken}`,
      },
      body: JSON.stringify(updates),
    });
    if (!res.ok) {
      const j = (await res.json().catch(() => null)) as unknown;
      const msg = isRecord(j) && isString(j.error) ? j.error : "Failed to update role.";
      alert(msg);
      return;
    }
    await loadRolesAndPermissions();
  };

  const createRole = async () => {
    if (!viewerToken) return;
    const key = creatingKey.trim().toLowerCase();
    const label = creatingLabel.trim();
    if (!key || !label) {
      alert("Enter a key and label.");
      return;
    }

    const res = await fetch("/api/staff/security/roles", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${viewerToken}`,
      },
      body: JSON.stringify({ key, label }),
    });

    if (!res.ok) {
      const j = (await res.json().catch(() => null)) as unknown;
      const msg = isRecord(j) && isString(j.error) ? j.error : "Failed to create role.";
      alert(msg);
      return;
    }

    setCreatingKey("");
    setCreatingLabel("");
    await loadRolesAndPermissions();
  };

  if (state === "loading") {
    return (
      <div className="mx-auto max-w-6xl px-4 py-10">
        <div className="text-sm text-brand-textMuted">Loading…</div>
      </div>
    );
  }

  if (state === "denied") {
    return <AccessDeniedCard />;
  }

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <div className="mb-6 flex items-center justify-between gap-3">
        <div>
          <div className="text-lg font-semibold text-brand-text">Security</div>
          <div className="text-sm text-brand-textMuted">Roles & permissions</div>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="rounded-2xl border border-zinc-800 bg-black/35 p-4">
          <div className="mb-3 text-sm font-semibold text-brand-text">Roles</div>
          <div className="space-y-2">
            {roles.map((r) => (
              <button
                key={r.key}
                type="button"
                onClick={() => void selectRole(r.key)}
                className={`ui-card ui-card-hover w-full !p-3 text-left text-sm ${selectedRoleKey === r.key ? "!border-brand-primary !bg-brand-primary/10" : ""}`}
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <RolePill role={r.key} />
                  </div>
                  <span className="text-[11px] text-brand-textMuted">{r.key}</span>
                </div>
              </button>
            ))}
          </div>

          <div className="mt-6 border-t border-zinc-800 pt-4">
            <div className="mb-2 text-xs font-semibold text-brand-textMuted">Create role</div>
            <div className="grid grid-cols-1 gap-2">
              <input
                value={creatingKey}
                onChange={(e) => setCreatingKey(e.target.value)}
                placeholder="key (e.g. organizer)"
                className="ui-input text-sm"
              />
              <input
                value={creatingLabel}
                onChange={(e) => setCreatingLabel(e.target.value)}
                placeholder="label (e.g. Organizer)"
                className="ui-input text-sm"
              />
              <button
                type="button"
                onClick={() => void createRole()}
                className="ui-btn ui-btn-primary w-full text-sm"
              >
                Create
              </button>
            </div>
          </div>
        </div>

        <div className="rounded-2xl border border-zinc-800 bg-black/35 p-4 lg:col-span-2">
          {selectedRole ? (
            <div>
              <div className="mb-4 flex items-start justify-between gap-4">
                <div>
                  <div className="text-sm font-semibold text-brand-text">{selectedRole.label}</div>
                  <div className="text-xs text-brand-textMuted">{selectedRole.key}</div>
                </div>
              </div>

              <div className="space-y-4">
                <div className="rounded-2xl border border-zinc-800 bg-black/30 p-4">
                  <div className="mb-3 text-xs font-semibold text-brand-textMuted">Badge</div>

                  <div className="mb-3 flex items-center justify-between gap-3 rounded-xl border border-zinc-800 bg-black/35 px-3 py-2">
                    <div>
                      <div className="text-xs font-semibold text-brand-text">Staff role</div>
                      <div className="text-[11px] text-brand-textMuted">Only staff roles can access /staff</div>
                    </div>
                    <label className="inline-flex cursor-pointer items-center gap-2 text-xs text-brand-text">
                      <input
                        type="checkbox"
                        checked={Boolean(selectedRole.is_staff)}
                        onChange={(e) => void updateRole({ is_staff: e.target.checked })}
                        className="no-zoom-input"
                      />
                      Enabled
                    </label>
                  </div>

                  <label className="block text-xs text-brand-textMuted">Label</label>
                  <input
                    value={labelDraft}
                    onChange={(e) => setLabelDraft(e.target.value)}
                    onBlur={() => {
                      if (!selectedRole) return;
                      const next = labelDraft.trim();
                      if (next && next !== selectedRole.label) void updateRole({ label: next });
                    }}
                    className="ui-input mt-1 text-sm"
                  />

                  {/* A closed list rather than a text box. `RolePill` resolves
                      the name through an allow-list and draws nothing for
                      anything else, so free text let a typo save cleanly,
                      report success, and render no icon. */}
                  <label className="mt-3 block text-xs text-brand-textMuted" id="role-badge-icon-label">
                    Icon
                  </label>
                  <div className="mt-1">
                    <MenuSelect
                      ariaLabel="Badge icon"
                      value={iconDraft}
                      onChange={(next) => {
                        setIconDraft(next);
                        if (!selectedRole) return;
                        const normalized = next.length ? next : null;
                        if (normalized !== (selectedRole.badge_icon ?? null)) {
                          void updateRole({ badge_icon: normalized });
                        }
                      }}
                      options={BADGE_ICON_OPTIONS}
                    />
                  </div>

                  <div className="mt-3 grid grid-cols-3 gap-2">
                    <div>
                      <label className="block text-xs text-brand-textMuted">BG</label>
                      <div className="mt-1 flex items-center gap-2">
                        <input
                          type="color"
                          value={bgHexDraft || selectedRole.badge_bg}
                          onChange={(e) => {
                            setBgHexDraft(e.target.value);
                            void updateRole({ badge_bg: e.target.value });
                          }}
                          className="aspect-square h-10 w-10 cursor-pointer appearance-none overflow-hidden rounded-md border border-zinc-800 bg-transparent p-0 [&::-webkit-color-swatch-wrapper]:p-0 [&::-webkit-color-swatch]:rounded-md [&::-webkit-color-swatch]:border-0"
                          title="Pick color"
                        />
                        <input
                          value={bgHexDraft}
                          onChange={(e) => setBgHexDraft(e.target.value)}
                          onBlur={() => {
                            if (!selectedRole) return;
                            const next = bgHexDraft.trim();
                            if (!isValidHex(next)) {
                              setBgHexDraft(selectedRole.badge_bg ?? "");
                              return;
                            }
                            if (next !== (selectedRole.badge_bg ?? "")) void updateRole({ badge_bg: next });
                          }}
                          className="ui-input w-24 text-[11px]"
                          placeholder="#RRGGBB"
                        />
                      </div>
                    </div>
                    <div>
                      <label className="block text-xs text-brand-textMuted">Border</label>
                      <div className="mt-1 flex items-center gap-2">
                        <input
                          type="color"
                          value={borderHexDraft || selectedRole.badge_border}
                          onChange={(e) => {
                            setBorderHexDraft(e.target.value);
                            void updateRole({ badge_border: e.target.value });
                          }}
                          className="aspect-square h-10 w-10 cursor-pointer appearance-none overflow-hidden rounded-md border border-zinc-800 bg-transparent p-0 [&::-webkit-color-swatch-wrapper]:p-0 [&::-webkit-color-swatch]:rounded-md [&::-webkit-color-swatch]:border-0"
                          title="Pick color"
                        />
                        <input
                          value={borderHexDraft}
                          onChange={(e) => setBorderHexDraft(e.target.value)}
                          onBlur={() => {
                            if (!selectedRole) return;
                            const next = borderHexDraft.trim();
                            if (!isValidHex(next)) {
                              setBorderHexDraft(selectedRole.badge_border ?? "");
                              return;
                            }
                            if (next !== (selectedRole.badge_border ?? "")) void updateRole({ badge_border: next });
                          }}
                          className="ui-input w-24 text-[11px]"
                          placeholder="#RRGGBB"
                        />
                      </div>
                    </div>
                    <div>
                      <label className="block text-xs text-brand-textMuted">Text</label>
                      <div className="mt-1 flex items-center gap-2">
                        <input
                          type="color"
                          value={textHexDraft || selectedRole.badge_text}
                          onChange={(e) => {
                            setTextHexDraft(e.target.value);
                            void updateRole({ badge_text: e.target.value });
                          }}
                          className="aspect-square h-10 w-10 cursor-pointer appearance-none overflow-hidden rounded-md border border-zinc-800 bg-transparent p-0 [&::-webkit-color-swatch-wrapper]:p-0 [&::-webkit-color-swatch]:rounded-md [&::-webkit-color-swatch]:border-0"
                          title="Pick color"
                        />
                        <input
                          value={textHexDraft}
                          onChange={(e) => setTextHexDraft(e.target.value)}
                          onBlur={() => {
                            if (!selectedRole) return;
                            const next = textHexDraft.trim();
                            if (!isValidHex(next)) {
                              setTextHexDraft(selectedRole.badge_text ?? "");
                              return;
                            }
                            if (next !== (selectedRole.badge_text ?? "")) void updateRole({ badge_text: next });
                          }}
                          className="ui-input w-24 text-[11px]"
                          placeholder="#RRGGBB"
                        />
                      </div>
                    </div>
                  </div>
                </div>

                <div className="rounded-2xl border border-zinc-800 bg-black/30 p-4">
                  <div className="mb-3 text-xs font-semibold text-brand-textMuted">Permissions</div>
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                    <MenuSelect
                      ariaLabel="Permission category"
                      value={permissionCategory}
                      onChange={(next) => setPermissionCategory(next)}
                      className="ui-select-trigger h-10 text-sm sm:w-56"
                      options={[{ value: "all", label: "All categories" }, ...permissionCategories.map((c) => ({ value: c, label: c }))]}
                    />

                    <input
                      value={permissionQuery}
                      onChange={(e) => setPermissionQuery(e.target.value)}
                      placeholder="Search permissions..."
                      className="ui-input h-10 text-sm"
                    />
                  </div>

                  <div className="mt-3 max-h-[380px] overflow-auto pr-1">
                    <div className="space-y-2">
                      {filteredPermissions.map((p) => {
                        const checked = selectedRolePerms.has(p.key);
                        return (
                          <label
                            key={p.key}
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
                              onChange={() => togglePermission(p.key)}
                            />
                            <div className="min-w-0">
                              <div className="text-sm font-medium">{p.key}</div>
                              {p.description ? (
                                <div className="break-words text-xs text-brand-textMuted">{p.description}</div>
                              ) : null}
                              {p.category ? (
                                <div className="mt-1 text-[11px] text-brand-textMuted">{p.category}</div>
                              ) : null}
                            </div>
                          </label>
                        );
                      })}
                    </div>
                  </div>

                  <button
                    type="button"
                    onClick={() => void saveRolePermissions()}
                    className="ui-btn ui-btn-primary mt-3 w-full text-sm"
                  >
                    Save permissions
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <div className="text-sm text-brand-textMuted">Select a role to edit.</div>
          )}
        </div>
      </div>
    </div>
  );
}
