"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { supabaseBrowser } from "@/lib/supabaseClient";
import { useMeAccess } from "@/lib/hooks/useMeAccess";
import { isArray, isRecord, isString } from "@/lib/typeGuards";
import { AccessDeniedCard } from "@/components/AccessDeniedCard";
import { DonationBadge } from "@/components/DonationBadge";
import { RolePill } from "@/components/RolePill";
import { VerifiedBadge } from "@/components/VerifiedBadge";
import { ImageCropModal } from "@/components/ImageCropModal";
import { donationRankOptions, DonationRankKey } from "@/lib/donationRanks";
import { MenuSelect } from "@/components/ui/MenuSelect";

type LoadState = "loading" | "denied" | "loaded";

type RoleRow = {
  key: string;
  label: string;
  priority: number;
  is_staff: boolean;
  badge_bg: string | null;
  badge_border: string | null;
  badge_text: string | null;
  badge_icon: string | null;
};

type UserRow = {
  id: string;
  username: string | null;
  display_name: string | null;
  avatar_url: string | null;
  bio: string | null;
  location: string | null;
  karma: number | null;
  role: string | null;
  is_verified: boolean | null;
  donation_rank: string | null;
  created_at?: string | null;
  last_seen_at?: string | null;
  last_ip?: string | null;
  last_user_agent?: string | null;
  username_last_changed_at?: string | null;
  is_op?: boolean | null;
};

type UsersResponse = {
  users: UserRow[];
  nextCursor: number | null;
  hasMore: boolean;
};

type UserStatus = {
  ban_active: boolean;
  ban_reason: string | null;
  site_restriction_active: boolean;
  site_restriction_expires_at: string | null;
  community_restriction_active: boolean;
  community_restriction_expires_at: string | null;
  dm_restriction_active: boolean;
  dm_restriction_expires_at: string | null;
};

function normalizeRoles(v: unknown): RoleRow[] {
  if (!isRecord(v) || !isArray(v.roles)) return [];
  const out: RoleRow[] = [];
  for (const r of v.roles) {
    if (!isRecord(r) || !isString(r.key) || !isString(r.label)) continue;
    out.push({
      key: r.key,
      label: r.label,
      priority: typeof r.priority === "number" ? r.priority : 0,
      is_staff: typeof r.is_staff === "boolean" ? r.is_staff : false,
      badge_bg: isString((r as any).badge_bg) ? (r as any).badge_bg : null,
      badge_border: isString((r as any).badge_border) ? (r as any).badge_border : null,
      badge_text: isString((r as any).badge_text) ? (r as any).badge_text : null,
      badge_icon: isString((r as any).badge_icon) ? (r as any).badge_icon : null,
    });
  }
  return out.sort((a, b) => b.priority - a.priority);
}

function normalizeUsersResponse(v: unknown): UsersResponse {
  const empty: UsersResponse = { users: [], nextCursor: null, hasMore: false };
  if (!isRecord(v) || !isArray(v.users)) return empty;

  const users: UserRow[] = [];
  for (const u of v.users) {
    if (!isRecord(u) || !isString(u.id)) continue;
    users.push({
      id: u.id,
      username: isString(u.username) ? u.username : null,
      display_name: isString(u.display_name) ? u.display_name : null,
      avatar_url: isString(u.avatar_url) ? u.avatar_url : null,
      bio: isString((u as any).bio) ? (u as any).bio : null,
      location: isString((u as any).location) ? (u as any).location : null,
      karma: typeof (u as any).karma === "number" ? (u as any).karma : null,
      role: isString(u.role) ? u.role : null,
      is_verified: typeof u.is_verified === "boolean" ? u.is_verified : null,
      donation_rank: isString(u.donation_rank) ? u.donation_rank : null,
      created_at: isString((u as any).created_at) ? (u as any).created_at : null,
      last_seen_at: isString((u as any).last_seen_at) ? (u as any).last_seen_at : null,
      last_ip: isString((u as any).last_ip) ? (u as any).last_ip : null,
      last_user_agent: isString((u as any).last_user_agent) ? (u as any).last_user_agent : null,
      username_last_changed_at: isString((u as any).username_last_changed_at)
        ? (u as any).username_last_changed_at
        : null,
      is_op: typeof (u as any).is_op === "boolean" ? (u as any).is_op : null,
    });
  }

  const nextCursor = typeof v.nextCursor === "number" && Number.isFinite(v.nextCursor) ? v.nextCursor : null;
  const hasMore = typeof v.hasMore === "boolean" ? v.hasMore : false;
  return { users, nextCursor, hasMore };
}

type PermissionRow = {
  key: string;
  description: string | null;
  category: string | null;
};

function normalizePermList(v: unknown): PermissionRow[] {
  if (!isRecord(v) || !isArray(v.permissions)) return [];
  const out: PermissionRow[] = [];
  for (const p of v.permissions) {
    if (isString(p)) {
      out.push({ key: p, description: null, category: null });
      continue;
    }
    if (isRecord(p) && isString(p.key)) {
      out.push({
        key: p.key,
        description: isString(p.description) ? p.description : null,
        category: isString(p.category) ? p.category : null,
      });
    }
  }
  // De-dupe by key
  const seen = new Set<string>();
  return out.filter((r) => {
    if (seen.has(r.key)) return false;
    seen.add(r.key);
    return true;
  });
}

async function getViewerToken(): Promise<string | null> {
  const supabase = supabaseBrowser();
  const { data } = await supabase.auth.getSession();
  const token = data?.session?.access_token;
  return typeof token === "string" && token.length ? token : null;
}

export default function StaffSecurityUsersPage() {
  const { data: access, isLoading: accessLoading } = useMeAccess();
  const router = useRouter();

  const [state, setState] = useState<LoadState>("loading");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [viewerToken, setViewerToken] = useState<string | null>(null);

  const [roles, setRoles] = useState<RoleRow[]>([]);
  const [allPermissions, setAllPermissions] = useState<PermissionRow[]>([]);
  const [permCategoryFilter, setPermCategoryFilter] = useState<string>("all");

  const [query, setQuery] = useState<string>("");
  const [permissionQuery, setPermissionQuery] = useState<string>("");
  const [roleFilter, setRoleFilter] = useState<string>("all");
  const [verifiedOnly, setVerifiedOnly] = useState<boolean>(false);
  const [donationFilter, setDonationFilter] = useState<"all" | "any" | DonationRankKey>("all");
  const [sortMode, setSortMode] = useState<"name" | "donation_desc" | "donation_asc">("name");

  const roleByKey = useMemo(() => {
    const m = new Map<string, RoleRow>();
    for (const r of roles) m.set(r.key, r);
    return m;
  }, [roles]);

  const donationFilterOptions = useMemo(
    () =>
      ([
        { value: "all", label: "All donations" },
        { value: "any", label: "Any donor" },
        ...donationRankOptions.map((o) => ({ value: o.value, label: o.label })),
      ] as const),
    []
  );

  const sortOptions = useMemo(
    () =>
      [
        { value: "name", label: "Sort: name" },
        { value: "donation_desc", label: "Sort: donation (high→low)" },
        { value: "donation_asc", label: "Sort: donation (low→high)" },
      ] as const,
    []
  );
  const [searching, setSearching] = useState<boolean>(false);

  const [users, setUsers] = useState<UserRow[]>([]);
  const [cursor, setCursor] = useState<number | null>(0);
  const [hasMore, setHasMore] = useState<boolean>(false);
  const [loadingMore, setLoadingMore] = useState<boolean>(false);

  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [selectedRole, setSelectedRole] = useState<string>("");
  const [selectedUserPerms, setSelectedUserPerms] = useState<Set<string>>(new Set());

  const [savingVerify, setSavingVerify] = useState<boolean>(false);
  const [savingDonation, setSavingDonation] = useState<boolean>(false);

  const [selectedDonationRank, setSelectedDonationRank] = useState<string>("");

  const [userStatus, setUserStatus] = useState<UserStatus | null>(null);
  const [loadingStatus, setLoadingStatus] = useState<boolean>(false);

  const [loginEvents, setLoginEvents] = useState<
    { id: number; event_type: string; ip: string | null; user_agent: string | null; created_at: string }[]
  >([]);
  const [loadingLoginEvents, setLoadingLoginEvents] = useState<boolean>(false);
  const [loginEventsError, setLoginEventsError] = useState<string | null>(null);

  const [editUsername, setEditUsername] = useState<string>("");
  const [editDisplayName, setEditDisplayName] = useState<string>("");
  const [editBio, setEditBio] = useState<string>("");
  const [editLocation, setEditLocation] = useState<string>("");
  const [editAvatarUrl, setEditAvatarUrl] = useState<string>("");
  const [savingProfile, setSavingProfile] = useState<boolean>(false);
  const [profileMessage, setProfileMessage] = useState<string | null>(null);

  const [avatarCropOpen, setAvatarCropOpen] = useState<boolean>(false);
  const [avatarCropFile, setAvatarCropFile] = useState<File | null>(null);
  const [avatarUploading, setAvatarUploading] = useState<boolean>(false);
  const [avatarMessage, setAvatarMessage] = useState<string | null>(null);

  const avatarFileInputRef = useRef<HTMLInputElement | null>(null);

  const [tempbanHours, setTempbanHours] = useState<number>(24);
  const [communityBanHours, setCommunityBanHours] = useState<number>(24);
  const [dmBanHours, setDmBanHours] = useState<number>(24);
  const [restrictionReason, setRestrictionReason] = useState<string>("");
  const [savingModeration, setSavingModeration] = useState<boolean>(false);

  const canAssignRole = Boolean(access?.permissions?.includes("roles.assign"));
  const canGrantPerms = Boolean(access?.permissions?.includes("permissions.grant"));
  const canViewPage = Boolean(access?.permissions?.includes("users.view"));
  const canSearch = Boolean(access?.permissions?.includes("users.search"));
  const canVerify = Boolean(access?.permissions?.includes("users.verify"));
  const canSetDonation = Boolean(access?.permissions?.includes("users.donation_rank.set"));
  const canEditProfile = Boolean(access?.permissions?.includes("users.profile.edit"));
  const canViewIpLogs = Boolean(access?.permissions?.includes("security.ip_logs.view"));
  const canRestrictSite = Boolean(access?.permissions?.includes("moderation.restrict"));
  const canRequestRestrictSite = Boolean(access?.permissions?.includes("moderation.restrict.request"));

  const canRestrictCommunity = Boolean(access?.permissions?.includes("moderation.restrict.community"));
  const canRequestRestrictCommunity = Boolean(access?.permissions?.includes("moderation.restrict.community.request"));

  const canRestrictDm = Boolean(access?.permissions?.includes("moderation.restrict.dm"));
  const canRequestRestrictDm = Boolean(access?.permissions?.includes("moderation.restrict.dm.request"));

  const canActOnSiteRestriction = canRestrictSite || canRequestRestrictSite;
  const canActOnCommunityRestriction = canRestrictCommunity || canRequestRestrictCommunity;
  const canActOnDmRestriction = canRestrictDm || canRequestRestrictDm;
  const canBanDirect = Boolean(access?.permissions?.includes("moderation.ban"));
  const canBanRequest = Boolean(access?.permissions?.includes("moderation.ban.request"));
  const canDm = Boolean(access?.permissions?.includes("users.dm"));
  const canRestrictAny = canActOnSiteRestriction || canActOnCommunityRestriction || canActOnDmRestriction;

  const selectedUser = useMemo(() => users.find((u) => u.id === selectedUserId) ?? null, [users, selectedUserId]);
  const selectedUserInitial = useMemo(() => {
    const c = (selectedUser?.display_name || selectedUser?.username || selectedUser?.id || "U").trim();
    return (c[0] || "U").toUpperCase();
  }, [selectedUser]);

  const selectedUserIsActive = useMemo(() => {
    if (!selectedUser?.last_seen_at) return false;
    const t = new Date(selectedUser.last_seen_at).getTime();
    if (!Number.isFinite(t)) return false;
    // Treat "active" as seen within the last 5 minutes.
    return Date.now() - t <= 5 * 60 * 1000;
  }, [selectedUser?.last_seen_at]);

  const displayedUsers = useMemo(() => {
    const copy = users
      .filter((u) => {
        if (roleFilter === "all") return true;
        const key = (u.role ?? "").toLowerCase();
        return key === roleFilter.toLowerCase();
      })
      .filter((u) => {
        if (!verifiedOnly) return true;
        return Boolean(u.is_verified);
      })
      .filter((u) => {
        if (donationFilter === "all") return true;
        if (donationFilter === "any") return Boolean(u.donation_rank);
        return (u.donation_rank ?? "") === donationFilter;
      });

    const donationWeight = (rank: string | null) => {
      if (!rank) return 0;
      const idx = donationRankOptions.findIndex((o) => o.value === rank);
      return idx >= 0 ? idx + 1 : 0;
    };

    copy.sort((a, b) => {
      if (sortMode === "donation_desc") {
        const d = donationWeight(b.donation_rank) - donationWeight(a.donation_rank);
        if (d !== 0) return d;
      }
      if (sortMode === "donation_asc") {
        const d = donationWeight(a.donation_rank) - donationWeight(b.donation_rank);
        if (d !== 0) return d;
      }
      const aName = (a.display_name ?? a.username ?? a.id).toLowerCase();
      const bName = (b.display_name ?? b.username ?? b.id).toLowerCase();
      return aName.localeCompare(bName);
    });

    return copy;
  }, [users, roleFilter, verifiedOnly, donationFilter, sortMode]);

  useEffect(() => {
    if (!selectedUser) {
      setUserStatus(null);
      setLoginEvents([]);
      setLoginEventsError(null);
      return;
    }
    setEditUsername(selectedUser.username ?? "");
    setEditDisplayName(selectedUser.display_name ?? "");
    setEditBio(selectedUser.bio ?? "");
    setEditLocation(selectedUser.location ?? "");
    setEditAvatarUrl(selectedUser.avatar_url ?? "");
    setSelectedRole(selectedUser.role ?? "");
    setSelectedDonationRank(selectedUser.donation_rank ?? "");
    setRestrictionReason("");

    const run = async () => {
      if (!viewerToken) return;
      setLoadingStatus(true);
      try {
        const res = await fetch(`/api/staff/security/users/${encodeURIComponent(selectedUser.id)}/status`, {
          headers: { Authorization: `Bearer ${viewerToken}` },
        });
        if (!res.ok) {
          setUserStatus(null);
          return;
        }
        const j = (await res.json().catch(() => null)) as unknown;
        if (!isRecord(j) || typeof (j as any).ban_active !== "boolean") {
          setUserStatus(null);
          return;
        }
        setUserStatus({
          ban_active: Boolean((j as any).ban_active),
          ban_reason: isString((j as any).ban_reason) ? (j as any).ban_reason : null,
          site_restriction_active: Boolean((j as any).site_restriction_active),
          site_restriction_expires_at: isString((j as any).site_restriction_expires_at)
            ? (j as any).site_restriction_expires_at
            : null,
          community_restriction_active: Boolean((j as any).community_restriction_active),
          community_restriction_expires_at: isString((j as any).community_restriction_expires_at)
            ? (j as any).community_restriction_expires_at
            : null,
          dm_restriction_active: Boolean((j as any).dm_restriction_active),
          dm_restriction_expires_at: isString((j as any).dm_restriction_expires_at)
            ? (j as any).dm_restriction_expires_at
            : null,
        });
      } finally {
        setLoadingStatus(false);
      }
    };

    const runIp = async () => {
      if (!viewerToken || !canViewIpLogs) {
        setLoginEvents([]);
        setLoginEventsError(null);
        return;
      }
      setLoadingLoginEvents(true);
      setLoginEventsError(null);
      try {
        const res = await fetch(
          `/api/staff/security/users/login-events?profile_id=${encodeURIComponent(selectedUser.id)}&limit=20`,
          {
            headers: { Authorization: `Bearer ${viewerToken}` },
          }
        );
        if (!res.ok) {
          setLoginEvents([]);
          setLoginEventsError(res.status === 403 ? "You don't have permission to view IP logs." : "Failed to load IP logs.");
          return;
        }
        const j = (await res.json().catch(() => null)) as any;
        const rows = Array.isArray(j?.data) ? j.data : [];
        setLoginEvents(
          rows
            .filter((r: any) => r && typeof r === "object" && typeof r.created_at === "string")
            .map((r: any) => ({
              id: typeof r.id === "number" ? r.id : Number(r.id) || 0,
              event_type: typeof r.event_type === "string" ? r.event_type : "login",
              ip: typeof r.ip === "string" ? r.ip : null,
              user_agent: typeof r.user_agent === "string" ? r.user_agent : null,
              created_at: r.created_at,
            }))
        );
      } finally {
        setLoadingLoginEvents(false);
      }
    };

    void run();
    void runIp();
  }, [selectedUserId, selectedUser, viewerToken, canViewIpLogs]);

  useEffect(() => {
    const boot = async () => {
      if (accessLoading) {
        setState("loading");
        return;
      }

      if (!access) {
        setState("denied");
        setErrorMessage("You must be logged in.");
        return;
      }

      if (!access.isStaff) {
        setState("denied");
        setErrorMessage("Access denied.");
        return;
      }

      // Page access is controlled by .view. Action perms are checked per-control.
      if (!canViewPage) {
        setState("denied");
        setErrorMessage("You do not have permission to view users.");
        return;
      }

      const token = await getViewerToken();
      if (!token) {
        setState("denied");
        setErrorMessage("You must be logged in.");
        return;
      }

      setViewerToken(token);
      setState("loaded");
    };

    void boot();
  }, [accessLoading, access, canAssignRole, canGrantPerms, canSearch, canVerify, canSetDonation, canViewPage]);

  useEffect(() => {
    if (state !== "loaded" || !viewerToken) return;

    const loadMeta = async () => {
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

      setRoles(normalizeRoles(rolesJson));
      setAllPermissions(normalizePermList(permsJson));
    };

    void loadMeta();
  }, [state, viewerToken]);

  const fetchUsers = async (opts: { q?: string; cursor?: number | null; replace?: boolean }) => {
    if (!viewerToken || !canSearch) return;
    const q = (opts.q ?? "").trim();
    const isSearch = q.length >= 2;
    const cursorParam = isSearch ? "" : `&cursor=${encodeURIComponent(String(opts.cursor ?? 0))}`;

    const url = `/api/staff/security/users/search?q=${encodeURIComponent(q)}${cursorParam}`;

    const res = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${viewerToken}` },
    });

    const json = (await res.json().catch(() => null)) as unknown;
    const parsed = normalizeUsersResponse(json);

    setUsers((prev) => (opts.replace ? parsed.users : [...prev, ...parsed.users]));
    setCursor(parsed.nextCursor);
    setHasMore(parsed.hasMore);

    const first = parsed.users[0]?.id ?? null;
    if (opts.replace && first) setSelectedUserId(first);
    if (opts.replace && !first) setSelectedUserId(null);
  };

  useEffect(() => {
    if (state !== "loaded" || !viewerToken || !canSearch) return;
    void fetchUsers({ q: "", cursor: 0, replace: true });
  }, [state, viewerToken, canSearch]);

  const runSearch = async () => {
    if (!viewerToken || !canSearch) return;
    setSearching(true);
    try {
      await fetchUsers({ q: query, cursor: 0, replace: true });
    } finally {
      setSearching(false);
    }
  };

  // Live search as you type (debounced). This keeps the UX snappy on desktop/mobile
  // and avoids requiring Enter/blur to refresh the list.
  useEffect(() => {
    if (!canSearch) return;

    const q = query.trim();
    if (!q) {
      // When empty, show the "browse" list (first page) instead of forcing an explicit search.
      // This matches the expected behavior on other staff tools.
      const t = window.setTimeout(() => {
        void fetchUsers({ q: "", cursor: 0, replace: true });
      }, 150);

      return () => window.clearTimeout(t);
    }

    const t = window.setTimeout(() => {
      void runSearch();
    }, 250);

    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, canSearch]);

  const loadMore = async () => {
    if (!viewerToken || !canSearch || loadingMore || !hasMore) return;
    setLoadingMore(true);
    try {
      await fetchUsers({ q: query.trim(), cursor, replace: false });
    } finally {
      setLoadingMore(false);
    }
  };

  const loadSelectedUserOverrides = async (userId: string) => {
    if (!viewerToken || !canGrantPerms) return;
    const res = await fetch(`/api/staff/security/users/${encodeURIComponent(userId)}/permissions`, {
      method: "GET",
      headers: { Authorization: `Bearer ${viewerToken}` },
    });
    const json = (await res.json().catch(() => null)) as unknown;
    // Store selected permissions as a Set<string> of permission keys.
    setSelectedUserPerms(new Set(normalizePermList(json).map((p) => p.key)));
  };

  useEffect(() => {
    if (!selectedUser) return;
    setSelectedRole(String(selectedUser.role ?? "member"));
    setSelectedDonationRank(String(selectedUser.donation_rank ?? ""));

    if (canGrantPerms) {
      void loadSelectedUserOverrides(selectedUser.id);
    } else {
      setSelectedUserPerms(new Set());
    }
  }, [selectedUserId, selectedUser, canGrantPerms]);

  const saveRole = async () => {
    if (!viewerToken || !selectedUserId || !canAssignRole) return;
    const res = await fetch(`/api/staff/security/users/${encodeURIComponent(selectedUserId)}/role`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${viewerToken}`,
      },
      body: JSON.stringify({ role: selectedRole }),
    });

    const j = (await res.json().catch(() => null)) as unknown;

    if (!res.ok) {
      const msg = isRecord(j) && isString(j.error) ? j.error : "Failed to update role.";
      alert(msg);
      return;
    }

    if (isRecord(j) && j.requiresApproval === true && isString(j.requestId)) {
      alert("Admin role changes require approval by another admin. A request was created in the approvals queue.");
      return;
    }

    setUsers((prev) => prev.map((u) => (u.id === selectedUserId ? { ...u, role: selectedRole } : u)));
    alert("Role updated.");
  };

  const toggleUserPermission = (perm: string) => {
    setSelectedUserPerms((prev) => {
      const next = new Set(prev);
      if (next.has(perm)) next.delete(perm);
      else next.add(perm);
      return next;
    });
  };

  const saveUserPermissions = async () => {
    if (!viewerToken || !selectedUserId || !canGrantPerms) return;
    const res = await fetch(`/api/staff/security/users/${encodeURIComponent(selectedUserId)}/permissions`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${viewerToken}`,
      },
      body: JSON.stringify({ permissions: Array.from(selectedUserPerms) }),
    });

    if (!res.ok) {
      const j = (await res.json().catch(() => null)) as unknown;
      const msg = isRecord(j) && isString(j.error) ? j.error : "Failed to update permissions.";
      alert(msg);
      return;
    }

    alert("User permissions saved.");
  };

  const setVerified = async (value: boolean) => {
    if (!viewerToken || !selectedUserId || !canVerify) return;
    setSavingVerify(true);
    try {
      const res = await fetch(`/api/staff/security/users/${encodeURIComponent(selectedUserId)}/verify`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${viewerToken}`,
        },
        body: JSON.stringify({ isVerified: value }),
      });

      if (!res.ok) {
        const j = (await res.json().catch(() => null)) as unknown;
        const msg = isRecord(j) && isString(j.error) ? j.error : "Failed to update verification.";
        alert(msg);
        return;
      }

      setUsers((prev) => prev.map((u) => (u.id === selectedUserId ? { ...u, is_verified: value } : u)));
    } finally {
      setSavingVerify(false);
    }
  };

  const setDonationRank = async (rank: string | null) => {
    if (!viewerToken || !selectedUserId || !canSetDonation) return;
    setSavingDonation(true);
    try {
      const res = await fetch(`/api/staff/security/users/${encodeURIComponent(selectedUserId)}/donation-rank`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${viewerToken}`,
        },
        body: JSON.stringify({ donationRank: rank }),
      });

      if (!res.ok) {
        const j = (await res.json().catch(() => null)) as unknown;
        const msg = isRecord(j) && isString(j.error) ? j.error : "Failed to update donation rank.";
        alert(msg);
        return;
      }

      setUsers((prev) => prev.map((u) => (u.id === selectedUserId ? { ...u, donation_rank: rank } : u)));
    } finally {
      setSavingDonation(false);
    }
  };

  const onAvatarPick = (file: File | null) => {
    setAvatarMessage(null);
    if (!file || !selectedUserId) {
      setAvatarCropFile(null);
      setAvatarCropOpen(false);
      return;
    }
    setAvatarCropFile(file);
    setAvatarCropOpen(true);
  };

  const uploadAvatarBlob = async (blob: Blob) => {
    if (!viewerToken || !selectedUserId || !canEditProfile) return;
    setAvatarUploading(true);
    setAvatarMessage(null);
    try {
      const form = new FormData();
      form.append("file", new File([blob], "avatar.jpg", { type: "image/jpeg" }));

      const res = await fetch(`/api/staff/security/users/${encodeURIComponent(selectedUserId)}/avatar`, {
        method: "POST",
        headers: { Authorization: `Bearer ${viewerToken}` },
        body: form,
      });

      const json = (await res.json().catch(() => null)) as any;
      if (!res.ok) {
        const msg = json && typeof json.error === "string" ? json.error : "Failed to upload avatar.";
        setAvatarMessage(msg);
        return;
      }

      const url = json && typeof json.avatar_url === "string" ? json.avatar_url : "";
      if (url) {
        setEditAvatarUrl(url);
        setUsers((prev) => prev.map((u) => (u.id === selectedUserId ? { ...u, avatar_url: url } : u)));
        setAvatarMessage("Avatar updated.");
      }
    } finally {
      setAvatarUploading(false);
    }
  };

  const saveProfile = async () => {
    if (!viewerToken || !selectedUserId || !canEditProfile) return;
    setSavingProfile(true);
    setProfileMessage(null);
    try {
      const res = await fetch(`/api/staff/security/users/${encodeURIComponent(selectedUserId)}/profile`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${viewerToken}`,
        },
        body: JSON.stringify({
          username: editUsername,
          display_name: editDisplayName,
          bio: editBio,
          location: editLocation,
          avatar_url: editAvatarUrl,
        }),
      });

      if (!res.ok) {
        const j = (await res.json().catch(() => null)) as unknown;
        const msg = isRecord(j) && isString(j.error) ? j.error : "Failed to update profile.";
        setProfileMessage(msg);
        return;
      }

      setUsers((prev) =>
        prev.map((u) =>
          u.id === selectedUserId
            ? {
                ...u,
                username: editUsername.trim().length ? editUsername.trim() : null,
                display_name: editDisplayName.trim().length ? editDisplayName.trim() : null,
                avatar_url: editAvatarUrl.trim().length ? editAvatarUrl.trim() : null,
                bio: editBio.trim().length ? editBio.trim() : null,
                location: editLocation.trim().length ? editLocation.trim() : null,
              }
            : u
        )
      );

      setProfileMessage("Profile updated.");
    } finally {
      setSavingProfile(false);
    }
  };

  const toggleBan = async () => {
    if (!viewerToken || !selectedUserId || (!canBanDirect && !canBanRequest)) return;
    if (!userStatus) return;

    setSavingModeration(true);
    try {
      const res = await fetch(`/api/staff/ban-user`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${viewerToken}`,
        },
        body: JSON.stringify({
          userId: selectedUserId,
          currentlyBanned: userStatus.ban_active,
          reason: restrictionReason,
        }),
      });

      if (!res.ok) {
        const j = (await res.json().catch(() => null)) as unknown;
        const msg = isRecord(j) && isString(j.error) ? j.error : "Ban action failed.";
        alert(msg);
        return;
      }

      setUserStatus((prev) =>
        prev
          ? {
              ...prev,
              ban_active: !prev.ban_active,
              ban_reason: restrictionReason.trim().length ? restrictionReason.trim() : null,
            }
          : prev
      );
    } finally {
      setSavingModeration(false);
    }
  };

  const setRestriction = async (params: {
    kind: "site" | "community" | "dm";
    action: "set" | "clear";
    durationHours?: number | null;
  }) => {
    if (!viewerToken || !selectedUserId) return;
    if (params.kind === "site" && !canActOnSiteRestriction) return;
    if (params.kind === "community" && !canActOnCommunityRestriction) return;
    if (params.kind === "dm" && !canActOnDmRestriction) return;
    setSavingModeration(true);
    try {
      const res = await fetch(`/api/staff/restrictions/set`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${viewerToken}`,
        },
        body: JSON.stringify({
          userId: selectedUserId,
          kind: params.kind,
          action: params.action,
          durationHours: params.action === "set" ? (params.durationHours ?? null) : null,
          reason: restrictionReason,
        }),
      });

      if (!res.ok) {
        const j = (await res.json().catch(() => null)) as unknown;
        const msg = isRecord(j) && isString(j.error) ? j.error : "Restriction action failed.";
        alert(msg);
        return;
      }

      const j = (await res.json().catch(() => null)) as unknown;
      const pending = isRecord(j) && (j as any).pending === true;

      if (pending) {
        alert("Request submitted for approval.");
        return;
      }

      if (params.action === "clear") {
        setUserStatus((prev) => {
          if (!prev) return prev;
          if (params.kind === "site") {
            return { ...prev, site_restriction_active: false, site_restriction_expires_at: null };
          }
          if (params.kind === "community") {
            return { ...prev, community_restriction_active: false, community_restriction_expires_at: null };
          }
          return { ...prev, dm_restriction_active: false, dm_restriction_expires_at: null };
        });
        return;
      }

      const durationHours = typeof params.durationHours === "number" && params.durationHours > 0 ? params.durationHours : null;
      const expiresAt = durationHours ? new Date(Date.now() + durationHours * 60 * 60 * 1000).toISOString() : null;
      setUserStatus((prev) => {
        if (!prev) return prev;
        if (params.kind === "site") {
          return { ...prev, site_restriction_active: true, site_restriction_expires_at: expiresAt };
        }
        if (params.kind === "community") {
          return { ...prev, community_restriction_active: true, community_restriction_expires_at: expiresAt };
        }
        return { ...prev, dm_restriction_active: true, dm_restriction_expires_at: expiresAt };
      });
    } finally {
      setSavingModeration(false);
    }
  };

  const startDmWithUser = async () => {
    if (!selectedUserId) return;
    try {
      const supabase = supabaseBrowser();
      const { data, error } = await supabase.rpc("dm_get_or_create_thread", {
        p_other_user_id: selectedUserId,
      });

      if (error) {
        console.error("dm_get_or_create_thread failed", error);
        alert("Failed to start DM thread.");
        return;
      }

      const threadId = typeof data === "string" ? data : null;
      if (!threadId) {
        alert("Failed to start DM thread.");
        return;
      }

      router.push(`/messages/${encodeURIComponent(threadId)}`);
    } catch (e: unknown) {
      console.error("dm start unexpected", e);
      alert("Failed to start DM thread.");
    }
  };

  const permissionFilter = useMemo(() => {
    const q = permissionQuery.trim().toLowerCase();
    return allPermissions.filter((p) => {
      if (permCategoryFilter !== "all") {
        const cat = (p.category ?? "Uncategorized").toLowerCase();
        if (cat !== permCategoryFilter.toLowerCase()) return false;
      }
      if (!q) return true;
      const hay = `${p.key} ${p.description ?? ""}`.toLowerCase();
      return hay.includes(q);
    });
  }, [allPermissions, permissionQuery, permCategoryFilter]);

  const permissionCategories = useMemo(() => {
    const set = new Set<string>();
    for (const p of allPermissions) set.add(p.category ?? "Uncategorized");
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [allPermissions]);

  if (state === "loading") {
    return (
      <div className="mx-auto max-w-6xl px-5 py-10">
        <div className="text-sm text-brand-textMuted">Loading…</div>
      </div>
    );
  }

  if (state === "denied") {
    return (
      <AccessDeniedCard
        title="Security • Users"
        message={errorMessage ?? "Access denied."}
        backHref="/staff/security"
        backLabel="Back to Security"
      />
    );
  }

  // NOTE: This page contains large, scroll-heavy panels (users list, permissions list).
  // Use the standard page shell. Avoid forcing viewport-based heights; this page should
  // behave like other staff pages and not create extra blank scroll space.
  return (
    <div className="page-container page-stack">
      <ImageCropModal
        open={avatarCropOpen}
        title="Crop avatar"
        file={avatarCropFile}
        aspect={1}
        maxSize={256}
        quality={0.9}
        onCancel={() => {
          setAvatarCropOpen(false);
          setAvatarCropFile(null);
        }}
        onConfirm={(blob) => {
          setAvatarCropOpen(false);
          setAvatarCropFile(null);
          void uploadAvatarBlob(blob);
        }}
        confirmLabel={avatarUploading ? "Uploading…" : "Upload"}
        hint="This will update the user's avatar on their profile."
      />
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-xl font-semibold text-brand-text">Security • Users</div>
          <div className="mt-1 text-sm text-brand-textMuted">
            Search users, assign roles, toggle verification, donation ranks, and grant direct permission overrides.
          </div>
        </div>
      </div>

      <div className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-[360px_1fr]">
        <div className="rounded-2xl border border-zinc-800 bg-black/35 p-4">
          <div className="text-sm font-semibold text-brand-text">Users</div>

          <div className="mt-3">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search username, display name, or user ID…"
              className="no-zoom-input w-full rounded-xl border border-zinc-800 bg-black/45 px-3 py-2 text-sm text-brand-text outline-none focus:border-amber-400/80"
            />
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => setVerifiedOnly((v) => !v)}
                className={
                  verifiedOnly
                    ? "flex h-9 items-center rounded-full border border-emerald-400/40 bg-emerald-500/15 px-3 text-[12px] font-medium text-emerald-100"
                    : "flex h-9 items-center rounded-full border border-zinc-700 bg-black/40 px-3 text-[12px] font-medium text-brand-textMuted transition hover:border-amber-400/70"
                }
              >
                Verified only
              </button>

              <MenuSelect
                ariaLabel="Donation filter"
                value={donationFilter as any}
                onChange={(v) => setDonationFilter(v as any)}
                options={donationFilterOptions as any}
                className="flex h-9 items-center gap-2 rounded-full border border-zinc-700 bg-black/40 px-3 text-[12px] text-brand-text outline-none transition hover:border-amber-400/80"
                menuClassName="mt-2 w-64 overflow-hidden rounded-2xl border border-zinc-800 bg-black/95 shadow-2xl"
              />

              <MenuSelect
                ariaLabel="Sort users"
                value={sortMode as any}
                onChange={(v) => setSortMode(v as any)}
                options={sortOptions as any}
                className="flex h-9 items-center gap-2 rounded-full border border-zinc-700 bg-black/40 px-3 text-[12px] text-brand-text outline-none transition hover:border-amber-400/80"
                menuClassName="mt-2 w-64 overflow-hidden rounded-2xl border border-zinc-800 bg-black/95 shadow-2xl"
              />

              {searching ? <span className="text-[11px] text-brand-textMuted">Searching…</span> : null}
            </div>
          </div>

          <div className="mt-3 flex items-center justify-between gap-2">
            <div className="text-[11px] text-brand-textMuted">Role</div>
            <MenuSelect
              ariaLabel="Role filter"
              value={roleFilter as any}
              onChange={(v) => setRoleFilter(v as any)}
              options={[
                { value: "all", label: "All roles" },
                ...roles
                  .slice()
                  .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))
                  .map((r) => ({ value: r.key.toLowerCase(), label: r.label ?? r.key })),
              ]}
              className="flex h-9 items-center gap-2 rounded-xl border border-zinc-800 bg-black/40 px-3 text-xs text-brand-text outline-none transition-all hover:border-amber-400/80"
              menuClassName="mt-2 w-64 overflow-hidden rounded-2xl border border-zinc-800 bg-black/95 shadow-2xl"
              renderValue={(opt) =>
                !opt || opt.value === "all" ? <span>All roles</span> : <RolePill role={opt.value} />
              }
              renderOption={(opt) =>
                opt.value === "all" ? (
                  <span className="text-[11px]">All roles</span>
                ) : (
                  <div className="flex w-full items-center justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-2">
                      <RolePill role={opt.value} />
                      <span className="truncate text-[11px]">{opt.label}</span>
                    </div>
                  </div>
                )
              }
            />
          </div>

          {/* Cap the users list height and scroll within the list.
              Use a viewport-relative cap so it doesn't feel tiny on tall screens. */}
          <div className="mt-4 max-h-[70vh] space-y-2 overflow-y-auto pr-1">
            {displayedUsers.map((u) => {
              const active = u.id === selectedUserId;
              const label = u.display_name || u.username || u.id;
              const roleKey = u.role ?? "member";
              return (
                <button
                  key={u.id}
                  type="button"
                  onClick={() => setSelectedUserId(u.id)}
                  className={`w-full rounded-xl border px-3 py-2 text-left text-sm transition-all ${
                    active
                      ? "border-brand-primary/60 bg-black/60 text-brand-primary"
                      : "border-zinc-800 bg-black/40 text-brand-text hover:border-zinc-700 hover:bg-black/55"
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="truncate">{label}</div>
                    <div className="flex items-center gap-2">
                      <RolePill role={roleKey} />
                      {u.is_verified ? <VerifiedBadge className="scale-90" /> : null}
                      {u.donation_rank ? <DonationBadge rank={u.donation_rank as any} className="scale-90" /> : null}
                      <span
                        className={`ui-chip-static text-[11px] ${
                          (typeof u.karma === "number" ? u.karma : 0) < 0
                            ? "border-red-500/30 bg-red-500/10 text-red-200"
                            : "border-emerald-500/30 bg-emerald-500/10 text-emerald-200"
                        }`}
                        title="User karma"
                      >
                        Karma {typeof u.karma === "number" ? u.karma : 0}
                      </span>
                    </div>
                  </div>
                  {u.username ? (
                    <div className="mt-0.5 text-[11px] text-brand-textMuted">@{u.username}</div>
                  ) : null}
                </button>
              );
            })}

            {!users.length ? (
              <div className="rounded-xl border border-zinc-800 bg-black/25 p-3 text-xs text-brand-textMuted">
                No users found.
              </div>
            ) : null}
          </div>

          {hasMore ? (
            <button
              type="button"
              onClick={() => void loadMore()}
              disabled={!canSearch || loadingMore}
              className="mt-3 w-full rounded-xl border border-zinc-700 bg-black/40 px-3 py-2 text-sm font-medium text-brand-text transition-all hover:border-brand-primary/70 hover:bg-black/65 hover:text-brand-primary disabled:opacity-60"
            >
              {loadingMore ? "Loading…" : "Load more"}
            </button>
          ) : null}
        </div>

        <div className="rounded-2xl border border-zinc-800 bg-black/35 p-4">
          <div className="text-sm font-semibold text-brand-text">User</div>

          {!selectedUser ? (
            <div className="mt-3 text-sm text-brand-textMuted">Select a user.</div>
          ) : (
            <>
              <div className="mt-3 rounded-2xl border border-zinc-800 bg-black/30 p-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-semibold text-brand-text">
                      {selectedUser.display_name || selectedUser.username || selectedUser.id}
                    </div>
                    {selectedUser.username ? (
                      <div className="mt-1 text-xs text-brand-textMuted">@{selectedUser.username}</div>
                    ) : null}
                    <div className="mt-1 text-[11px] text-brand-textMuted">{selectedUser.id}</div>
                  </div>

                  {/* Badges + last seen pinned to the right edge */}
                  <div className="flex flex-col items-end gap-2">
                    <div className="flex flex-wrap items-center justify-end gap-2">
                      {selectedUser.is_op ? (
                        <span className="rounded-full border border-sky-400/40 bg-sky-500/10 px-2 py-0.5 text-[10px] font-medium text-sky-200">
                          OP
                        </span>
                      ) : null}
                      <RolePill role={selectedUser.role ?? "member"} />
                      {selectedUser.is_verified ? <VerifiedBadge className="scale-90" /> : null}
                      {selectedUser.donation_rank ? (
                        <DonationBadge rank={selectedUser.donation_rank as any} className="scale-90" />
                      ) : null}
                      <span
                        className={`ui-chip-static text-[11px] ${
                          (typeof selectedUser.karma === "number" ? selectedUser.karma : 0) < 0
                            ? "border-red-500/30 bg-red-500/10 text-red-200"
                            : "border-emerald-500/30 bg-emerald-500/10 text-emerald-200"
                        }`}
                        title="User karma"
                      >
                        Karma {typeof selectedUser.karma === "number" ? selectedUser.karma : 0}
                      </span>
                      {selectedUserIsActive ? (
                        <span className="ui-chip-static border-emerald-400/30 bg-emerald-500/10 text-[11px] text-emerald-200">
                          Active
                        </span>
                      ) : null}
                    </div>

                    {/* Created/Last seen/Last IP moved into the details grid below for a cleaner header layout */}
                  </div>
                </div>

                <div className="mt-2 grid grid-cols-1 gap-1 text-[11px] text-brand-textMuted sm:grid-cols-2">
                  <div className="space-y-1">
                    {selectedUser.created_at ? (
                      <div>
                        <span className="text-brand-textMuted">Created:</span> {new Date(selectedUser.created_at).toLocaleString()}
                      </div>
                    ) : null}
                    {selectedUser.last_seen_at ? (
                      <div>
                        <span className="text-brand-textMuted">Last seen:</span> {new Date(selectedUser.last_seen_at).toLocaleString()}
                      </div>
                    ) : null}
                    {canViewIpLogs && selectedUser.last_ip ? (
                      <div>
                        <span className="text-brand-textMuted">Last IP:</span> {selectedUser.last_ip}
                      </div>
                    ) : null}
                  </div>
                  {selectedUser.username_last_changed_at ? (
                    <div className="sm:col-span-2">
                      <span className="text-brand-textMuted">Username changed:</span> {new Date(
                        selectedUser.username_last_changed_at
                      ).toLocaleString()}
                    </div>
                  ) : null}
                  {canViewIpLogs && selectedUser.last_user_agent ? (
                    <div className="sm:col-span-2">
                      <span className="text-brand-textMuted">User agent:</span> {selectedUser.last_user_agent}
                    </div>
                  ) : null}
                </div>



                {canViewIpLogs ? (
                  <div className="mt-3 rounded-xl border border-zinc-800 bg-black/35 p-3">
                    <div className="flex items-center justify-between gap-2">
                      <div className="text-xs font-semibold text-brand-text">IP logs</div>
                      {loadingLoginEvents ? <div className="text-[11px] text-brand-textMuted">Loading…</div> : null}
                    </div>
                    {loginEventsError ? (
                      <div className="mt-2 text-xs text-red-200">{loginEventsError}</div>
                    ) : null}

                    {!loginEventsError && !loadingLoginEvents && loginEvents.length === 0 ? (
                      <div className="mt-2 text-xs text-brand-textMuted">
                        No events yet (they'll appear after the user loads the site at least once after IP logging is enabled).
                      </div>
                    ) : null}

                    {loginEvents.length ? (
                      <div className="mt-2 overflow-hidden rounded-xl border border-zinc-800">
                        <div className="grid grid-cols-12 gap-2 bg-black/45 px-3 py-2 text-[10px] font-semibold text-brand-textMuted">
                          <div className="col-span-4">When</div>
                          <div className="col-span-3">IP</div>
                          <div className="col-span-2">Event</div>
                          <div className="col-span-3">User agent</div>
                        </div>

                        {/* Cap visible rows (about 5) and scroll for the rest. */}
                        <div className="max-h-[190px] overflow-y-auto">
                          {loginEvents.map((e) => (
                            <div
                              key={`${e.id}-${e.created_at}`}
                              className="grid grid-cols-12 gap-2 border-t border-zinc-800 px-3 py-2 text-[11px] text-brand-text"
                            >
                              <div className="col-span-4 text-brand-textMuted">{new Date(e.created_at).toLocaleString()}</div>
                              <div className="col-span-3 font-mono text-[10px] text-brand-text">{e.ip ?? "—"}</div>
                              <div className="col-span-2 text-brand-textMuted">{e.event_type}</div>
                              <div className="col-span-3 truncate text-brand-textMuted" title={e.user_agent ?? ""}>
                                {e.user_agent ?? "—"}
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    ) : null}
                  </div>
                ) : null}

                <div className="mt-3 flex flex-wrap gap-2">
                  <a
                    href={`/user/${encodeURIComponent(selectedUser.id)}`}
                    className="whitespace-nowrap rounded-full border border-zinc-700 bg-black/40 px-3 py-1.5 text-xs font-medium text-brand-text transition-all hover:border-brand-primary/70 hover:bg-black/65 hover:text-brand-primary disabled:opacity-60"
                  >
                    View profile
                  </a>
                  <button
                    type="button"
                    onClick={() => void startDmWithUser()}
                    disabled={!canDm}
                    className="rounded-full border border-zinc-700 bg-black/40 px-3 py-1.5 text-xs font-medium text-brand-text transition-all hover:border-brand-primary/70 hover:bg-black/65 hover:text-brand-primary"
                  >
                    DM
                  </button>
                </div>
              </div>

              <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
                <div className="rounded-2xl border border-zinc-800 bg-black/30 p-3 flex flex-col items-center">
                  <div className="w-full text-center text-xs font-semibold text-brand-text">Role</div>
                  <div className="mt-2 w-full flex-1 flex justify-center">
                    <MenuSelect
                    ariaLabel="Role"
                    value={selectedRole as string}
                    onChange={(next) => setSelectedRole(next)}
                    disabled={!canAssignRole}
                    className="flex h-10 w-full max-w-[360px] items-center gap-2 rounded-xl border border-zinc-800 bg-black/45 px-3 text-sm text-brand-text outline-none transition hover:border-brand-primary/70 disabled:opacity-60"
                    options={roles
                      .slice()
                      .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))
                      .map((r) => ({ value: r.key.toLowerCase(), label: r.label ?? r.key }))}
                    renderValue={(opt) => (opt ? <RolePill role={opt.value} /> : <span>Select</span>)}
                    renderOption={(opt) => (
                      <div className="flex w-full items-center gap-2">
                        <RolePill role={opt.value} />
                        <span className="truncate text-[11px] text-brand-text">{opt.label}</span>
                      </div>
                    )}
                    />
                  </div>
                  <button
                    type="button"
                    onClick={() => void saveRole()}
                    disabled={!canAssignRole}
                    className="mt-3 w-full rounded-xl border border-amber-400/30 bg-amber-500/10 px-3 py-2 text-sm font-medium text-amber-200 transition-all hover:border-amber-300/50 hover:bg-amber-500/15 disabled:opacity-60"
                  >
                    Save Role
                  </button>
                </div>

                <div className="rounded-2xl border border-zinc-800 bg-black/30 p-3 flex flex-col items-center">
                  <div className="w-full text-center text-xs font-semibold text-brand-text">Verification & Donation</div>

                  <div className="mt-3 flex w-full flex-wrap items-center justify-center gap-2">
                    <button
                      type="button"
                      onClick={() => void setVerified(!selectedUser.is_verified)}
                      disabled={!canVerify || savingVerify}
                      className={`min-w-[92px] whitespace-nowrap rounded-full border px-3 py-1.5 text-xs font-medium transition-all disabled:opacity-60 ${
                        selectedUser.is_verified
                          ? "border-zinc-700 bg-black/40 text-brand-text hover:border-brand-primary/70 hover:bg-black/65 hover:text-brand-primary"
                          : "border-sky-400/30 bg-sky-500/10 text-sky-200 hover:border-sky-300/50 hover:bg-sky-500/15"
                      }`}
                    >
                      {selectedUser.is_verified ? "Unverify" : "Verify user"}
                    </button>
                  </div>

                  <div className="mt-4 w-full">
                    <div className="text-[11px] font-medium text-brand-textMuted text-center">Donation rank</div>
                    <div className="mt-2 flex w-full justify-center">
                      <MenuSelect
                      ariaLabel="Donation rank"
                      value={selectedDonationRank as string}
                      onChange={(next) => setSelectedDonationRank(next)}
                      disabled={!canSetDonation || savingDonation}
                      className="flex h-10 w-full max-w-[360px] items-center gap-2 rounded-xl border border-zinc-800 bg-black/45 px-3 text-sm text-brand-text outline-none transition hover:border-brand-primary/70 disabled:opacity-60"
                      options={[{ value: "", label: "None" }, ...donationRankOptions.map((o) => ({ value: o.value, label: o.label }))]}
                    />
                    </div>

                    <button
                      type="button"
                      onClick={() =>
                        void setDonationRank(
                          selectedDonationRank.trim().length
                            ? (selectedDonationRank.trim() as DonationRankKey)
                            : null
                        )
                      }
                      disabled={!canSetDonation || savingDonation}
                      className="mt-3 w-full rounded-xl border border-amber-400/30 bg-amber-500/10 px-3 py-2 text-sm font-medium text-amber-200 transition-all hover:border-amber-300/50 hover:bg-amber-500/15 disabled:opacity-60"
                    >
                      Save Donation Rank
                    </button>
                  </div>
                </div>

                <div className="rounded-2xl border border-zinc-800 bg-black/30 p-3 flex flex-col">
                  <div className="text-xs font-semibold text-brand-text">Profile</div>
                  <div className="mt-3 flex flex-1 flex-col gap-2">
                    <label className="text-[11px] text-brand-textMuted">
                      Username
                      <input
                        value={editUsername}
                        onChange={(e) => setEditUsername(e.target.value)}
                        disabled={!canEditProfile || savingProfile}
                        className="mt-1 w-full rounded-xl border border-zinc-800 bg-black/45 px-3 py-2 text-sm text-brand-text outline-none focus:border-brand-primary/60 disabled:opacity-60"
                      />
                    </label>
                    <label className="text-[11px] text-brand-textMuted">
                      Display name
                      <input
                        value={editDisplayName}
                        onChange={(e) => setEditDisplayName(e.target.value)}
                        disabled={!canEditProfile || savingProfile}
                        className="mt-1 w-full rounded-xl border border-zinc-800 bg-black/45 px-3 py-2 text-sm text-brand-text outline-none focus:border-brand-primary/60 disabled:opacity-60"
                      />
                    </label>
                    <label className="text-[11px] text-brand-textMuted">
                      Location
                      <input
                        value={editLocation}
                        onChange={(e) => setEditLocation(e.target.value)}
                        disabled={!canEditProfile || savingProfile}
                        className="mt-1 w-full rounded-xl border border-zinc-800 bg-black/45 px-3 py-2 text-sm text-brand-text outline-none focus:border-brand-primary/60 disabled:opacity-60"
                      />
                    </label>
                    <label className="text-[11px] text-brand-textMuted">
                      Avatar URL
                      <input
                        value={editAvatarUrl}
                        onChange={(e) => setEditAvatarUrl(e.target.value)}
                        disabled={!canEditProfile || savingProfile}
                        className="mt-1 w-full rounded-xl border border-zinc-800 bg-black/45 px-3 py-2 text-sm text-brand-text outline-none focus:border-brand-primary/60 disabled:opacity-60"
                      />
                    </label>

                    <div className="mt-1 rounded-xl border border-zinc-800 bg-black/35 p-3">
                      <div className="flex items-center justify-between gap-3">
                        <div className="flex min-w-0 items-center gap-3">
                          {editAvatarUrl.trim().length ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img
                              src={editAvatarUrl}
                              alt="Avatar preview"
                              className="h-12 w-12 shrink-0 aspect-square rounded-full border border-zinc-700 object-cover"
                            />
                          ) : (
                            <div className="flex h-12 w-12 shrink-0 aspect-square items-center justify-center rounded-full border border-zinc-800 bg-black/40 text-sm font-semibold leading-none text-brand-text">
                              {selectedUserInitial}
                            </div>
                          )}
                          <div className="min-w-0" />
                        </div>

                        <input
                          ref={avatarFileInputRef}
                          type="file"
                          accept="image/*"
                          disabled={!canEditProfile || avatarUploading}
                          onChange={(e) => onAvatarPick(e.target.files && e.target.files[0] ? e.target.files[0] : null)}
                          className="hidden"
                        />

                        <button
                          type="button"
                          onClick={() => avatarFileInputRef.current?.click()}
                          disabled={!canEditProfile || avatarUploading}
                          className="rounded-xl border border-zinc-700 bg-black/40 px-3 py-2 text-xs font-semibold text-brand-text transition-all hover:border-brand-primary/70 hover:bg-black/65 hover:text-brand-primary disabled:opacity-60"
                        >
                          {avatarUploading ? "Uploading…" : "Upload"}
                        </button>
                      </div>

                      {avatarMessage ? <div className="mt-2 text-[11px] text-brand-textMuted">{avatarMessage}</div> : null}
                    </div>
                    <label className="text-[11px] text-brand-textMuted">
                      Bio
                      <textarea
                        value={editBio}
                        onChange={(e) => setEditBio(e.target.value)}
                        disabled={!canEditProfile || savingProfile}
                        rows={3}
                        className="mt-1 w-full resize-y rounded-xl border border-zinc-800 bg-black/45 px-3 py-2 text-sm text-brand-text outline-none focus:border-brand-primary/60 disabled:opacity-60"
                      />
                    </label>
                  </div>

                  <button
                    type="button"
                    onClick={() => void saveProfile()}
                    disabled={!canEditProfile || savingProfile}
                    className="mt-3 w-full rounded-xl border border-amber-400/30 bg-amber-500/10 px-3 py-2 text-sm font-medium text-amber-200 transition-all hover:border-amber-300/50 hover:bg-amber-500/15 disabled:opacity-60"
                  >
                    Save Profile
                  </button>
                  {profileMessage ? <div className="mt-2 text-[11px] text-brand-textMuted">{profileMessage}</div> : null}
                </div>

                <div className="rounded-2xl border border-zinc-800 bg-black/30 p-3">
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-xs font-semibold text-brand-text">Moderation</div>
                    <div className="text-[11px] text-brand-textMuted">
                      {loadingStatus ? "Loading…" : userStatus?.ban_active ? "Banned" : "Not banned"}
                      {userStatus?.site_restriction_active ? " • Site restricted" : ""}
                      {userStatus?.community_restriction_active ? " • Community restricted" : ""}
                      {userStatus?.dm_restriction_active ? " • DM restricted" : ""}
                    </div>
                  </div>

                  <div className="mt-4">
                    <div className="text-[11px] font-medium text-brand-textMuted">Restrictions</div>

                    <div className="mt-2">
                      <input
                        value={restrictionReason}
                        onChange={(e) => setRestrictionReason(e.target.value)}
                        placeholder="Reason (optional)"
                        disabled={!canRestrictAny}
                        className="w-full rounded-xl border border-zinc-800 bg-black/45 px-3 py-2 text-sm text-brand-text outline-none focus:border-brand-primary/60 disabled:opacity-60"
                      />
                    </div>

                    <div className="mt-3 grid grid-cols-1 gap-3">
                      <div className="rounded-xl border border-zinc-800 bg-black/20 p-3">
                        <div className="flex items-center justify-between gap-2">
                          <div className="text-xs font-semibold text-brand-text">Site</div>
                          <div className="text-[11px] text-brand-textMuted">
                            {userStatus?.site_restriction_active
                              ? userStatus.site_restriction_expires_at
                                ? `until ${new Date(userStatus.site_restriction_expires_at).toLocaleString()}`
                                : "active"
                              : "none"}
                          </div>
                        </div>
                        <div className="mt-2 flex items-center justify-center gap-2">
                          <input
                            type="number"
                            min={1}
                            max={720}
                            value={tempbanHours}
                            onChange={(e) => setTempbanHours(Number(e.target.value))}
                            disabled={!canActOnSiteRestriction}
                            className="w-28 rounded-xl border border-zinc-800 bg-black/45 px-3 py-2 text-sm text-brand-text outline-none focus:border-brand-primary/60 disabled:opacity-60"
                          />
                          <span className="text-xs text-brand-textMuted">hours</span>
                        </div>
                        <div className="mt-2 space-y-2">
                          <div className="grid grid-cols-2 gap-2">
                            <button
                              type="button"
                              onClick={() => void setRestriction({ kind: "site", action: "set", durationHours: tempbanHours })}
                              disabled={savingModeration || !canActOnSiteRestriction}
                              className="whitespace-nowrap rounded-full border border-zinc-700 bg-black/40 px-3 py-1.5 text-xs font-medium text-brand-text transition-all hover:border-brand-primary/70 hover:bg-black/65 hover:text-brand-primary disabled:opacity-60"
                            >
                              {canRestrictSite ? "Timeout" : "Request temp restrict"}
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                if (!userStatus?.ban_active) void toggleBan();
                              }}
                              disabled={savingModeration || !userStatus || userStatus.ban_active || (!canBanDirect && !canBanRequest)}
                              className={`whitespace-nowrap rounded-full border px-3 py-1.5 text-xs font-medium transition-all disabled:opacity-60 ${
                                userStatus?.ban_active
                                  ? "border-red-400/25 bg-red-500/5 text-red-200"
                                  : canBanDirect
                                    ? "border-red-400/30 bg-red-500/10 text-red-200 hover:border-red-300/50 hover:bg-red-500/15"
                                    : "border-amber-400/30 bg-amber-500/10 text-amber-200 hover:border-amber-300/50 hover:bg-amber-500/15"
                              }`}
                            >
                              {userStatus?.ban_active ? "Banned" : canBanDirect ? "Ban" : "Request ban"}
                            </button>
                          </div>

                          <button
                            type="button"
                            onClick={() => {
                              if (!userStatus) return;
                              // Match community/DM behavior: "Clear" is how you undo an active perm ban/restriction.
                              if (userStatus.ban_active) void toggleBan();
                              if (userStatus.site_restriction_active) void setRestriction({ kind: "site", action: "clear" });
                            }}
                            disabled={
                              savingModeration ||
                              !userStatus ||
                              (!userStatus.ban_active && !userStatus.site_restriction_active) ||
                              (!canActOnSiteRestriction && !canBanDirect && !canBanRequest)
                            }
                            className="w-full rounded-full border border-zinc-700 bg-black/40 px-3 py-1.5 text-xs font-medium text-brand-text transition-all hover:border-brand-primary/70 hover:bg-black/65 hover:text-brand-primary disabled:opacity-60"
                          >
                            Clear
                          </button>
                        </div>

                        {userStatus?.ban_active && userStatus?.ban_reason ? (
                          <div className="mt-2 text-[11px] text-brand-textMuted">Reason: {userStatus.ban_reason}</div>
                        ) : null}
                      </div>

                      <div className="rounded-xl border border-zinc-800 bg-black/20 p-3">
                        <div className="flex items-center justify-between gap-2">
                          <div className="text-xs font-semibold text-brand-text">Community</div>
                          <div className="text-[11px] text-brand-textMuted">
                            {userStatus?.community_restriction_active
                              ? userStatus.community_restriction_expires_at
                                ? `until ${new Date(userStatus.community_restriction_expires_at).toLocaleString()}`
                                : "active"
                              : "none"}
                          </div>
                        </div>
                        <div className="mt-2 flex items-center justify-center gap-2">
                          <input
                            type="number"
                            min={1}
                            max={720}
                            value={communityBanHours}
                            onChange={(e) => setCommunityBanHours(Number(e.target.value))}
                            disabled={!canActOnCommunityRestriction}
                            className="w-28 rounded-xl border border-zinc-800 bg-black/45 px-3 py-2 text-sm text-brand-text outline-none focus:border-brand-primary/60 disabled:opacity-60"
                          />
                          <span className="text-xs text-brand-textMuted">hours</span>
                        </div>
                        <div className="mt-2 space-y-2">
                          <div className="grid grid-cols-2 gap-2">
                            <button
                            type="button"
                            onClick={() =>
                              void setRestriction({ kind: "community", action: "set", durationHours: communityBanHours })
                            }
                            disabled={savingModeration || !canActOnCommunityRestriction}
                            className="rounded-full border border-zinc-700 bg-black/40 px-3 py-1.5 text-xs font-medium text-brand-text transition-all hover:border-brand-primary/70 hover:bg-black/65 hover:text-brand-primary disabled:opacity-60"
                          >
                            {canRestrictCommunity ? "Timeout" : "Request temp ban"}
                            </button>
                            <button
                            type="button"
                            onClick={() => void setRestriction({ kind: "community", action: "set", durationHours: null })}
                            disabled={savingModeration || !canActOnCommunityRestriction}
                            className={`min-w-[86px] whitespace-nowrap rounded-full border px-3 py-1.5 text-xs font-medium transition-all disabled:opacity-60 ${
                              canRestrictCommunity
                                ? "border-red-400/30 bg-red-500/10 text-red-200 hover:border-red-300/50 hover:bg-red-500/15"
                                : "border-amber-400/30 bg-amber-500/10 text-amber-200 hover:border-amber-300/50 hover:bg-amber-500/15"
                            }`}
                          >
                            {canRestrictCommunity ? "Ban" : "Request ban"}
                            </button>
                          </div>
                          <button
                            type="button"
                            onClick={() => void setRestriction({ kind: "community", action: "clear" })}
                            disabled={savingModeration || !canActOnCommunityRestriction || !userStatus?.community_restriction_active}
                            className="w-full rounded-full border border-zinc-700 bg-black/40 px-3 py-1.5 text-xs font-medium text-brand-text transition-all hover:border-brand-primary/70 hover:bg-black/65 hover:text-brand-primary disabled:opacity-60"
                          >
                            Clear
                          </button>
                        </div>
                      </div>

                      <div className="rounded-xl border border-zinc-800 bg-black/20 p-3">
                        <div className="flex items-center justify-between gap-2">
                          <div className="text-xs font-semibold text-brand-text">DM</div>
                          <div className="text-[11px] text-brand-textMuted">
                            {userStatus?.dm_restriction_active
                              ? userStatus.dm_restriction_expires_at
                                ? `until ${new Date(userStatus.dm_restriction_expires_at).toLocaleString()}`
                                : "active"
                              : "none"}
                          </div>
                        </div>
                        <div className="mt-2 flex items-center justify-center gap-2">
                          <input
                            type="number"
                            min={1}
                            max={720}
                            value={dmBanHours}
                            onChange={(e) => setDmBanHours(Number(e.target.value))}
                            disabled={!canActOnDmRestriction}
                            className="w-28 rounded-xl border border-zinc-800 bg-black/45 px-3 py-2 text-sm text-brand-text outline-none focus:border-brand-primary/60 disabled:opacity-60"
                          />
                          <span className="text-xs text-brand-textMuted">hours</span>
                        </div>
                        <div className="mt-2 space-y-2">
                          <div className="grid grid-cols-2 gap-2">
                            <button
                            type="button"
                            onClick={() => void setRestriction({ kind: "dm", action: "set", durationHours: dmBanHours })}
                            disabled={savingModeration || !canActOnDmRestriction}
                            className="rounded-full border border-zinc-700 bg-black/40 px-3 py-1.5 text-xs font-medium text-brand-text transition-all hover:border-brand-primary/70 hover:bg-black/65 hover:text-brand-primary disabled:opacity-60"
                          >
                            {canRestrictDm ? "Timeout" : "Request temp ban"}
                            </button>
                            <button
                            type="button"
                            onClick={() => void setRestriction({ kind: "dm", action: "set", durationHours: null })}
                            disabled={savingModeration || !canActOnDmRestriction}
                            className={`min-w-[86px] whitespace-nowrap rounded-full border px-3 py-1.5 text-xs font-medium transition-all disabled:opacity-60 ${
                              canRestrictDm
                                ? "border-red-400/30 bg-red-500/10 text-red-200 hover:border-red-300/50 hover:bg-red-500/15"
                                : "border-amber-400/30 bg-amber-500/10 text-amber-200 hover:border-amber-300/50 hover:bg-amber-500/15"
                            }`}
                          >
                            {canRestrictDm ? "Ban" : "Request ban"}
                            </button>
                          </div>
                          <button
                            type="button"
                            onClick={() => void setRestriction({ kind: "dm", action: "clear" })}
                            disabled={savingModeration || !canActOnDmRestriction || !userStatus?.dm_restriction_active}
                            className="w-full rounded-full border border-zinc-700 bg-black/40 px-3 py-1.5 text-xs font-medium text-brand-text transition-all hover:border-brand-primary/70 hover:bg-black/65 hover:text-brand-primary disabled:opacity-60"
                          >
                            Clear
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              <div className="mt-4 rounded-2xl border border-zinc-800 bg-black/30 p-4">
                <div className="mb-3 text-xs font-semibold text-brand-textMuted">Direct Permissions</div>
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                  <MenuSelect
                    ariaLabel="Permission category"
                    value={permCategoryFilter}
                    onChange={(next) => setPermCategoryFilter(next)}
                    className="flex h-10 w-full items-center gap-2 rounded-xl border border-zinc-800 bg-black/40 px-3 text-sm text-brand-text outline-none transition hover:border-zinc-600 sm:w-56"
                    options={[{ value: "all", label: "All categories" }, ...permissionCategories.map((c) => ({ value: c, label: c }))]}
                  />

                  <input
                    value={permissionQuery}
                    onChange={(e) => setPermissionQuery(e.target.value)}
                    placeholder="Search permissions..."
                    className="h-10 w-full rounded-xl border border-zinc-800 bg-black/40 px-3 text-sm text-brand-text outline-none placeholder:text-brand-textMuted focus:border-zinc-600"
                  />
                </div>

                {/*
                  NOTE: Use a fixed height (not max-height) here.
                  On some desktop browsers, a very tall child inside an overflow
                  container can still inflate the documentElement scroll height,
                  causing "phantom" blank space past the footer. A fixed height
                  prevents that while still allowing internal scrolling.
                */}
                <div className="mt-3 pr-1" style={{ height: 380, overflowY: "auto", contain: "content" }}>
                  <div className="space-y-2">
                    {permissionFilter.map((p) => {
                      const checked = selectedUserPerms.has(p.key);
                      return (
                        <label
                          key={p.key}
                          className={`flex cursor-pointer items-start rounded-xl border p-3 transition-colors ${
                            checked
                              ? "border-emerald-400/40 bg-emerald-500/10"
                              : "border-white/10 bg-black/30 hover:border-brand-primary/40"
                          } ${!canGrantPerms ? "opacity-60 cursor-not-allowed" : ""}`}
                        >
                          <input
                            type="checkbox"
                            className="sr-only"
                            checked={checked}
                            onChange={() => toggleUserPermission(p.key)}
                            disabled={!canGrantPerms}
                          />
                          <div className="min-w-0">
                            <div className="text-sm font-medium break-all">{p.key}</div>
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
                  onClick={() => void saveUserPermissions()}
                  disabled={!canGrantPerms}
                  className="mt-3 w-full rounded-xl border border-amber-400/30 bg-amber-500/10 px-3 py-2 text-sm font-medium text-amber-200 transition-all hover:border-amber-300/50 hover:bg-amber-500/15 disabled:opacity-60"
                >
                  Save Permissions
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
