"use client";

import { useEffect, useState, ChangeEvent } from "react";
import Link from "next/link";
import { supabaseBrowser } from "@/lib/supabaseClient";
import { ImageCropModal } from "@/components/ImageCropModal";
import { VerifiedBadge } from "@/components/VerifiedBadge";
import { DonationBadge } from "@/components/DonationBadge";
import { RolePill } from "@/components/RolePill";
import { useBlocks } from "@/components/BlocksProvider";

type SimpleUser = {
  id: string;
  email: string | null;
};

type ProfileRow = {
  username: string | null;
  display_name: string | null;
  created_at: string | null;
  avatar_url: string | null;
  bio: string | null;
  location: string | null;
  last_seen_at: string | null;
  is_verified?: boolean | null;
  donation_rank?: string | null;
  username_last_changed_at?: string | null;
};

type BlockedUserRow = {
  id: number;
  blocked_user_id: string;
  created_at: string | null;
  profiles: Array<{
    id: string;
    username: string | null;
    display_name: string | null;
    avatar_url: string | null;
    last_seen_at: string | null;
  }>;
};

const AVATAR_MAX_SIZE_PX = 256;

// Resize an image file down to maxSize (px) and convert to JPEG
async function resizeImageToJpeg(file: File, maxSize: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = (event) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement("canvas");

        const scale = Math.min(maxSize / img.width, maxSize / img.height, 1);
        const width = img.width * scale;
        const height = img.height * scale;

        canvas.width = width;
        canvas.height = height;

        const ctx = canvas.getContext("2d");
        if (!ctx) {
          reject(new Error("Failed to get canvas context"));
          return;
        }

        ctx.drawImage(img, 0, 0, width, height);

        canvas.toBlob(
          (blob) => {
            if (!blob) {
              reject(new Error("Failed to create blob from canvas"));
              return;
            }
            resolve(blob);
          },
          "image/jpeg",
          0.8
        );
      };
      img.onerror = () => reject(new Error("Failed to load image"));
      img.src = event.target?.result as string;
    };

    reader.onerror = () => reject(new Error("Failed to read file"));
    reader.readAsDataURL(file);
  });
}

export default function AccountPage() {
  const supabase = supabaseBrowser();

  const [user, setUser] = useState<SimpleUser | null>(null);
  const [profile, setProfile] = useState<ProfileRow | null>(null);
  const [myRole, setMyRole] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [activeTab, setActiveTab] = useState<"profile" | "reports" | "security" | "blocked">("profile");

  // Avatar upload UX
  const [avatarUploading, setAvatarUploading] = useState(false);
  const [avatarMessage, setAvatarMessage] = useState<string | null>(null);
  const [avatarCropFile, setAvatarCropFile] = useState<File | null>(null);
  const [avatarCropOpen, setAvatarCropOpen] = useState(false);

  // Profile edit UX
  const [profileSaving, setProfileSaving] = useState(false);
  const [profileMessage, setProfileMessage] = useState<string | null>(null);
  const [displayNameInput, setDisplayNameInput] = useState("");
  const [usernameInput, setUsernameInput] = useState("");
  const [bioInput, setBioInput] = useState("");
  const [locationInput, setLocationInput] = useState("");

  const [blockedLoading, setBlockedLoading] = useState(false);
  const [blockedError, setBlockedError] = useState<string | null>(null);
  const [blockedUsers, setBlockedUsers] = useState<BlockedUserRow[]>([]);
  const { setBlockedLocal } = useBlocks();
  const [unblockingIds, setUnblockingIds] = useState<Set<number>>(new Set());

  // My reports
type MyReportRow = {
  id: string;
  created_at: string;
  status: string;
  category: string | null;
  reason: string;
  target_type: string;
  target_id: string;
};

const [myReportsLoading, setMyReportsLoading] = useState(false);
const [myReportsError, setMyReportsError] = useState<string | null>(null);
const [myReports, setMyReports] = useState<MyReportRow[]>([]);

// Account deletion UX
  const [deleteConfirm, setDeleteConfirm] = useState("");
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteMessage, setDeleteMessage] = useState<string | null>(null);

  // Password UX (also lets Google or magic-link accounts add their first password)
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [passwordBusy, setPasswordBusy] = useState(false);
  const [passwordMessage, setPasswordMessage] = useState<string | null>(null);

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      setError(null);

      try {
        const {
          data: { user },
          error: userError,
        } = await supabase.auth.getUser();

        if (userError) {
          console.error("Error loading auth user for account page", userError);
          setError("Failed to load account.");
          setLoading(false);
          return;
        }

        if (!user) {
          setUser(null);
          setProfile(null);
          setLoading(false);
          return;
        }

        const simple: SimpleUser = {
          id: user.id,
          email: user.email ?? null,
        };
        setUser(simple);

        // Load staff role (if any) for display.
        const { data: roleRow } = await supabase
          .from("user_roles")
          .select("role")
          .eq("user_id", user.id)
          .maybeSingle<{ role: string | null }>();
        setMyRole(roleRow?.role ?? null);

        const { data: profileRow, error: profileError } = await supabase
          .from("profiles")
          .select(
            "username, display_name, created_at, avatar_url, bio, location, last_seen_at, is_verified, donation_rank, username_last_changed_at"
          )
          .eq("id", user.id)
          .maybeSingle<ProfileRow>();

        if (profileError) {
          console.error("Error loading profile for account page", profileError);
          setError("Failed to load profile.");
        } else {
          const row: ProfileRow =
            profileRow ?? {
              username: null,
              display_name: null,
              created_at: null,
              avatar_url: null,
              bio: null,
              location: null,
              last_seen_at: null,
              is_verified: null,
              donation_rank: null,
            };
          setProfile(row);
          setDisplayNameInput(row.display_name ?? "");
          setUsernameInput((row.username ?? "").toLowerCase());
          setBioInput(row.bio ?? "");
          setLocationInput(row.location ?? "");
        }
      } catch (e) {
        console.error("Unexpected error loading account page", e);
        setError("Unexpected error loading account.");
      } finally {
        setLoading(false);
      }
    };

    void load();
  }, [supabase]);

useEffect(() => {
  if (!user) return;
  if (activeTab !== "reports") return;
  void loadMyReports(user.id);
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, [activeTab, user?.id]);


  const loadBlockedUsers = async (viewerId: string) => {
    setBlockedLoading(true);
    setBlockedError(null);

    try {
      // 1) get blocks
      const { data: blocks, error: blocksErr } = await supabase
        .from("user_blocks")
        .select("id, blocked_user_id, created_at")
        .eq("blocker_user_id", viewerId)
        .order("created_at", { ascending: false });

      if (blocksErr) {
        console.error("Error loading blocked users (blocks)", blocksErr);
        setBlockedError("Failed to load blocked users.");
        setBlockedUsers([]);
        return;
      }

      const blockRows = (blocks ?? []) as Array<{
        id: number;
        blocked_user_id: string;
        created_at: string | null;
      }>;

      if (blockRows.length === 0) {
        setBlockedUsers([]);
        return;
      }

      // 2) load profiles for those ids
      const ids = blockRows.map((b) => b.blocked_user_id);

      const { data: profs, error: profErr } = await supabase
        .from("profiles")
        .select("id, username, display_name, avatar_url, last_seen_at")
        .in("id", ids);

      if (profErr) {
        console.error("Error loading blocked users (profiles)", profErr);
        setBlockedError("Failed to load blocked users.");
        setBlockedUsers([]);
        return;
      }

      const byId = new Map(
        (profs ?? []).map((p) => [String((p as { id: string }).id), p] as const)
      );

      // Build the exact shape your UI uses (profiles as an array)
      const merged: BlockedUserRow[] = blockRows.map((b) => {
        const p = byId.get(String(b.blocked_user_id)) as
          | {
              id: string;
              username: string | null;
              display_name: string | null;
              avatar_url: string | null;
              last_seen_at: string | null;
            }
          | undefined;

        return {
          id: b.id,
          blocked_user_id: b.blocked_user_id,
          created_at: b.created_at,
          profiles: p ? [p] : [],
        };
      });

      setBlockedUsers(merged);
    } catch (e) {
      console.error("Unexpected error loading blocked users", e);
      setBlockedError("Unexpected error loading blocked users.");
      setBlockedUsers([]);
    } finally {
      setBlockedLoading(false);
    }
  };

  useEffect(() => {
    if (activeTab !== "blocked") return;
    if (!user) return;
    void loadBlockedUsers(user.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, user?.id]);

  const displayName =
    profile?.display_name || profile?.username || user?.email || "Your account";

  const avatarUrl = profile?.avatar_url ?? null;
  const avatarInitial = (displayName?.[0] || "U").toUpperCase();

  const memberSince =
    profile?.created_at != null
      ? new Date(profile.created_at).toLocaleDateString()
      : null;

  const lastSeen =
    profile?.last_seen_at != null
      ? new Date(profile.last_seen_at).toLocaleString()
      : null;

  const handlePasswordSave = async () => {
    setPasswordMessage(null);
    if (newPassword.length < 12) {
      setPasswordMessage("Use at least 12 characters.");
      return;
    }
    if (newPassword !== confirmPassword) {
      setPasswordMessage("The passwords do not match.");
      return;
    }
    setPasswordBusy(true);
    const { error } = await supabase.auth.updateUser({ password: newPassword });
    setPasswordBusy(false);
    if (error) {
      setPasswordMessage("Password could not be updated. Log in again and retry, or use Forgot password.");
      return;
    }
    setNewPassword("");
    setConfirmPassword("");
    setPasswordMessage("Password saved. You can now use email + password to log in.");
  };

  const handleAvatarChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];

    // allow re-selecting the same file later
    event.target.value = "";

    if (!file || !user) return;

    setAvatarMessage(null);

    const allowedTypes = ["image/jpeg", "image/png", "image/webp"];
    if (!allowedTypes.includes(file.type)) {
      setAvatarMessage("Please upload a JPEG, PNG, or WebP image.");
      return;
    }

    const maxOriginalSize = 5 * 1024 * 1024;
    if (file.size > maxOriginalSize) {
      setAvatarMessage("Image is too large. Please use something under 5 MB.");
      return;
    }

    // Open crop modal first (square avatar).
    setAvatarCropFile(file);
    setAvatarCropOpen(true);
  };

  const uploadAvatarBlob = async (blob: Blob) => {
    if (!user) return;
    setAvatarMessage(null);
    setAvatarUploading(true);
    try {
      const filePath = `${user.id}.jpg`;

      const { error: uploadError } = await supabase.storage
        .from("avatars")
        .upload(filePath, blob, {
          cacheControl: "3600",
          upsert: true,
          contentType: "image/jpeg",
        });

      if (uploadError) {
        console.error("Error uploading avatar", uploadError);
        setAvatarMessage("Failed to upload avatar. Please try again.");
        return;
      }

      const { data: publicData } = supabase.storage.from("avatars").getPublicUrl(filePath);
      const publicUrl = publicData.publicUrl;
      const versionedUrl = `${publicUrl}?t=${Date.now()}`;

      const { error: updateError } = await supabase
        .from("profiles")
        .update({ avatar_url: versionedUrl })
        .eq("id", user.id);

      if (updateError) {
        console.error("Error updating avatar_url in profiles", updateError);
        setAvatarMessage("Avatar uploaded, but failed to save profile.");
        return;
      }

      setProfile((prev) => (prev ? { ...prev, avatar_url: versionedUrl } : prev));
      setAvatarMessage("Avatar updated.");
    } catch (e) {
      console.error("Unexpected avatar upload error", e);
      setAvatarMessage("Unexpected error uploading avatar.");
    } finally {
      setAvatarUploading(false);
    }
  };

  
const loadMyReports = async (viewerId: string) => {
  setMyReportsLoading(true);
  setMyReportsError(null);

  try {
    const { data, error: repErr } = await supabase
      .from("reports")
      .select("id, created_at, status, category, reason, target_type, target_id")
      .eq("reporter_user_id", viewerId)
      .order("created_at", { ascending: false })
      .limit(200);

    if (repErr) {
      console.error("Error loading my reports", repErr);
      setMyReportsError("Failed to load your reports.");
      setMyReports([]);
      return;
    }

    setMyReports((data ?? []) as MyReportRow[]);
  } catch (e) {
    console.error("Unexpected error loading my reports", e);
    setMyReportsError("Unexpected error loading your reports.");
    setMyReports([]);
  } finally {
    setMyReportsLoading(false);
  }
};

  const handleUnblock = async (blockId: number) => {
    if (!user) return;

    const row = blockedUsers.find((x) => x.id === blockId);
    const blockedUserId = row?.blocked_user_id ?? null;

    setUnblockingIds((prev) => new Set(prev).add(blockId));

    try {
      const { error } = await supabase
        .from("user_blocks")
        .delete()
        .eq("id", blockId)
        .eq("blocker_user_id", user.id);

      if (error) {
        console.error("Error unblocking user", error);
        setBlockedError("Failed to unblock user.");
        return;
      }

      if (blockedUserId) {
        // Keep BlocksProvider in sync so other pages update without a hard refresh
        setBlockedLocal(blockedUserId, false);
      }
      setBlockedUsers((prev) => prev.filter((x) => x.id !== blockId));
    } catch (e) {
      console.error("Unexpected unblock error", e);
      setBlockedError("Unexpected error unblocking user.");
    } finally {
      setUnblockingIds((prev) => {
        const next = new Set(prev);
        next.delete(blockId);
        return next;
      });
    }
  };

  const handleProfileSave = async () => {
    if (!user) return;

    setProfileMessage(null);
    setProfileSaving(true);

    try {
      const trimmedDisplay = displayNameInput.trim();
      const trimmedUsername = usernameInput.trim().toLowerCase();
      const trimmedBio = bioInput.trim();
      const trimmedLocation = locationInput.trim();

      if (usernameInput !== trimmedUsername) {
        setUsernameInput(trimmedUsername);
      }

      if (!trimmedDisplay || !trimmedUsername) {
        setProfileMessage("Display name and username are required.");
        setProfileSaving(false);
        return;
      }

      if (
        trimmedDisplay.length < 3 ||
        trimmedDisplay.length > 15 ||
        trimmedUsername.length < 3 ||
        trimmedUsername.length > 15
      ) {
        setProfileMessage(
          "Display name and username must be between 3 and 15 characters."
        );
        setProfileSaving(false);
        return;
      }

      const displayNameRegex = /^[A-Za-z0-9_.\- ]+$/;
      if (!displayNameRegex.test(trimmedDisplay)) {
        setProfileMessage(
          "Display name can use letters, numbers, spaces, underscores, dashes, and dots."
        );
        setProfileSaving(false);
        return;
      }

      const usernameRegex = /^[a-z0-9_.-]+$/;
      if (!usernameRegex.test(trimmedUsername)) {
        setProfileMessage(
          "Username can only use lowercase letters, numbers, underscores, dashes, and dots."
        );
        setProfileSaving(false);
        return;
      }

      if (trimmedBio.length > 400) {
        setProfileMessage("Bio is too long. Keep it under 400 characters.");
        setProfileSaving(false);
        return;
      }

      if (trimmedLocation.length > 60) {
        setProfileMessage("Location is too long. Keep it under 60 characters.");
        setProfileSaving(false);
        return;
      }

      const {
        data: { session },
      } = await supabase.auth.getSession();
      const token = session?.access_token;
      if (!token) {
        setProfileMessage("You must be logged in to update your profile.");
        setProfileSaving(false);
        return;
      }

      // Update profile fields via API so profanity filtering is enforced server-side.
      const profRes = await fetch("/api/account/profile/update", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          display_name: trimmedDisplay,
          bio: trimmedBio || null,
          location: trimmedLocation || null,
        }),
      });

      if (!profRes.ok) {
        const j = (await profRes.json().catch(() => null)) as
          | { error?: string }
          | null;
        setProfileMessage(j?.error ?? "Failed to save profile changes.");
        setProfileSaving(false);
        return;
      }

      // Username change is enforced server-side (30 day rule) via API.
      if (trimmedUsername !== (profile?.username ?? "").toLowerCase()) {
        if (!token) {
          setProfileMessage("You must be logged in to change your username.");
          setProfileSaving(false);
          return;
        }

        const res = await fetch("/api/account/username/change", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ username: trimmedUsername }),
        });

        if (!res.ok) {
          const j = (await res.json().catch(() => null)) as
            | { error?: string }
            | null;
          setProfileMessage(j?.error ?? "Failed to change username.");
          setProfileSaving(false);
          return;
        }

        // Re-load from DB so the UI reflects the source of truth (prevents "saved" but not persisted).
        const { data: fresh, error: freshErr } = await supabase
          .from("profiles")
          .select(
            "username, display_name, created_at, avatar_url, bio, location, last_seen_at, username_last_changed_at"
          )
          .eq("id", user.id)
          .maybeSingle<ProfileRow>();

        if (!freshErr && fresh) {
          setProfile(fresh);
          setDisplayNameInput(fresh.display_name ?? "");
          setUsernameInput((fresh.username ?? "").toLowerCase());
          setBioInput(fresh.bio ?? "");
          setLocationInput(fresh.location ?? "");

          const persistedOk =
            (fresh.display_name ?? "") === trimmedDisplay &&
            (fresh.username ?? "").toLowerCase() === trimmedUsername &&
            (fresh.bio ?? "") === (trimmedBio || "") &&
            (fresh.location ?? "") === (trimmedLocation || "");

          setProfileMessage(
            persistedOk
              ? "Profile updated."
              : "Saved, but some changes did not persist. Try refreshing the page."
          );
        } else {
          // Fallback to local optimistic state.
          setProfile((prev) =>
            prev
              ? {
                  ...prev,
                  display_name: trimmedDisplay,
                  username: trimmedUsername,
                  bio: trimmedBio || null,
                  location: trimmedLocation || null,
                  username_last_changed_at: new Date().toISOString(),
                }
              : prev
          );

          setProfileMessage("Profile updated.");
        }
        setProfileSaving(false);
        return;
      }

      // Re-load to ensure we reflect persisted values.
      const { data: fresh, error: freshErr } = await supabase
        .from("profiles")
        .select(
          "username, display_name, created_at, avatar_url, bio, location, last_seen_at, username_last_changed_at"
        )
        .eq("id", user.id)
        .maybeSingle<ProfileRow>();

      if (!freshErr && fresh) {
        setProfile(fresh);
        setDisplayNameInput(fresh.display_name ?? "");
        setUsernameInput((fresh.username ?? "").toLowerCase());
        setBioInput(fresh.bio ?? "");
        setLocationInput(fresh.location ?? "");

        const persistedOk =
          (fresh.display_name ?? "") === trimmedDisplay &&
          (fresh.bio ?? "") === (trimmedBio || "") &&
          (fresh.location ?? "") === (trimmedLocation || "");

        setProfileMessage(
          persistedOk
            ? "Profile updated."
            : "Saved, but some changes did not persist. Try refreshing the page."
        );
      } else {
        setProfile((prev) =>
          prev
            ? {
                ...prev,
                display_name: trimmedDisplay,
                bio: trimmedBio || null,
                location: trimmedLocation || null,
              }
            : prev
        );
      }

      setProfileMessage("Profile updated.");
    } catch (e) {
      console.error("Unexpected error saving profile", e);
      setProfileMessage("Unexpected error updating profile.");
    } finally {
      setProfileSaving(false);
    }
  };

  const handleDeleteAccount = async () => {
    if (!user) return;
    setDeleteMessage(null);

    if (deleteConfirm.trim() !== "DELETE") {
      setDeleteMessage('Type "DELETE" to confirm.');
      return;
    }

    setDeleteBusy(true);
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const token = session?.access_token;
      if (!token) {
        setDeleteMessage("You must be logged in.");
        return;
      }

      const res = await fetch("/api/account/delete", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ confirm: deleteConfirm.trim() }),
      });

      if (!res.ok) {
        const j = (await res.json().catch(() => null)) as
          | { error?: string }
          | null;
        setDeleteMessage(j?.error ?? "Failed to delete account.");
        return;
      }

      // Sign out locally and redirect home.
      await supabase.auth.signOut();
      window.location.href = "/";
    } catch (e) {
      console.error("Delete account error", e);
      setDeleteMessage("Unexpected error deleting account.");
    } finally {
      setDeleteBusy(false);
    }
  };

  const renderAvatar = () => {
    if (avatarUrl) {
      return (
        <img
          src={avatarUrl}
          alt={displayName}
          className="h-12 w-12 rounded-full border border-zinc-700 object-cover"
        />
      );
    }

    return (
      <div className="h-12 w-12 rounded-full border border-zinc-700 bg-brand-primary/10 text-brand-primary">
        <svg viewBox="0 0 40 40" className="h-full w-full" aria-hidden="true">
          <defs>
            <linearGradient id="avatarGradient" x1="0%" x2="100%" y1="0%" y2="100%">
              <stop offset="0%" stopColor="var(--brand-primary)" />
              <stop offset="100%" stopColor="var(--brand-accent)" />
            </linearGradient>
          </defs>
          <circle cx="20" cy="20" r="19" fill="url(#avatarGradient)" opacity="0.25" />
          <circle cx="20" cy="16" r="7" fill="none" stroke="var(--brand-primary)" strokeWidth="2" />
          <path
            d="M10 30c2.5-4 6-6 10-6s7.5 2 10 6"
            fill="none"
            stroke="var(--brand-primary)"
            strokeWidth="2"
            strokeLinecap="round"
          />
          <text
            x="20"
            y="22"
            textAnchor="middle"
            fill="var(--km-text)"
            fontSize="11"
            fontFamily="system-ui, -apple-system, BlinkMacSystemFont, sans-serif"
            dy="4"
          >
            {avatarInitial}
          </text>
        </svg>
      </div>
    );
  };

  if (loading) {
    return (
      <div className="page-container page-stack text-brand-text">
        <p className="text-sm text-brand-textMuted">Loading account…</p>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="mx-auto max-w-6xl px-4 py-8 text-brand-text">
        <h1 className="mb-2 text-xl font-semibold">You&apos;re not logged in</h1>
        <p className="mb-4 text-sm text-brand-textMuted">
          Log in to submit info pages, track your drafts, and manage your account.
        </p>
        <Link
          href="/auth/login"
          className="ui-btn ui-btn-primary"
        >
          Go to login
        </Link>
      </div>
    );
  }

  return (
    <div className="page-container page-stack">
      <ImageCropModal
        open={avatarCropOpen}
        file={avatarCropFile}
        title="Crop avatar"
        aspect={1}
        maxSize={AVATAR_MAX_SIZE_PX}
        confirmLabel="Save avatar"
        onCancel={() => {
          setAvatarCropOpen(false);
          setAvatarCropFile(null);
        }}
        onConfirm={(blob) => {
          setAvatarCropOpen(false);
          setAvatarCropFile(null);
          void uploadAvatarBlob(blob);
        }}
      />

      {/* Header – same structure as admin/users header */}
      <section className="space-y-2">
        <p className="ui-eyebrow">
          Account
        </p>
        <h1 className="text-2xl font-semibold tracking-tight text-brand-text sm:text-3xl">
          Your profile & account
        </h1>
        <p className="text-[12px] text-brand-textMuted sm:text-sm">
          Update your public profile, avatar, and account details.
        </p>
        <div className="mt-1 text-[11px] text-brand-textMuted">
          <Link
            href={`/user/${user.id}`}
            className="font-medium text-brand-primary hover:underline"
          >
            View public profile →
          </Link>
        </div>
        {avatarMessage && (
          <p className="mt-1 text-[11px] text-brand-textMuted">
            {avatarMessage}
          </p>
        )}
      </section>
      <section className="ui-card p-5 sm:p-6">
        {/* Header row inside card */}
        <div className="flex flex-col items-start gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-4">
            {renderAvatar()}
            <div>
              <h2 className="inline-flex flex-wrap items-center gap-1 text-lg font-semibold text-brand-text">
                <span>{displayName}</span>
                {profile?.is_verified ? <VerifiedBadge className="h-3 w-3" /> : null}
                {profile?.donation_rank ? (
                  <DonationBadge rank={profile.donation_rank} className="h-3 w-3" />
                ) : null}
                {myRole && myRole !== "member" ? <RolePill role={myRole} /> : null}
              </h2>
              <p className="text-[11px] text-brand-textMuted">
                {user.email || "No email on file"}
              </p>
              {memberSince && (
                <p className="text-[11px] text-brand-textMuted">
                  Member since {memberSince}
                </p>
              )}
              {lastSeen && (
                <p className="text-[11px] text-brand-textMuted">
                  Last seen: <span className="text-brand-text">{lastSeen}</span>
                </p>
              )}
              <p className="text-[11px] text-brand-textMuted">
                User ID:{" "}
                <span className="font-mono text-[11px] text-brand-text">
                    {user.id}
                </span>
              </p>
            </div>
          </div>
        </div>

        {/* Tabs – same style as SortChip group, but not full width */}
        <div className="ui-tabs mt-6" role="tablist" aria-label="Account sections">
          <button
            type="button"
            onClick={() => setActiveTab("profile")}
            className={
              "ui-tab " +
              (activeTab === "profile"
                ? "is-active" : "")
            }
          >
            Profile
          </button>
          <button
            type="button"
            onClick={() => setActiveTab("security")}
            className={
              "ui-tab " +
              (activeTab === "security"
                ? "is-active" : "")
            }
          >
            Security
          </button>
          <button
            type="button"
            onClick={() => setActiveTab("reports")}
            className={
              "ui-tab " +
              (activeTab === "reports"
                ? "is-active" : "")
            }
          >
            Reports
          </button>
          <button
            type="button"
            onClick={() => setActiveTab("blocked")}
            className={
              "ui-tab " +
              (activeTab === "blocked"
                ? "is-active" : "")
            }
          >
            Blocked users
          </button>
        </div>

        {/* Profile tab */}
        {activeTab === "profile" && (
          <div className="mt-5 space-y-5">
            {/* Avatar upload */}
            <div>
              <h2 className="mb-1 text-[13px] font-semibold text-brand-text">
                Avatar
              </h2>
              <p className="mb-2 text-[11px] text-brand-textMuted">
                Upload a square image. It will be resized and compressed to keep
                things fast.
              </p>
              <div className="flex flex-wrap items-center gap-3">
                <label className="ui-btn ui-btn-ghost cursor-pointer text-xs">
                  <input
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    className="no-zoom-input hidden"
                    onChange={handleAvatarChange}
                  />
                  Change avatar
                </label>
                {avatarUploading && (
                  <span className="text-[11px] text-brand-textMuted">
                    Uploading…
                  </span>
                )}
              </div>
            </div>

            {/* Profile fields */}
            <div>
              <h2 className="mb-1 text-[13px] font-semibold text-brand-text">
                Profile details
              </h2>
              <p className="mb-3 text-[11px] text-brand-textMuted">
                Display name and username are required. Bio and location show up
                on your public profile.
              </p>

              <div className="space-y-3 text-[12px]">
                <div>
                  <label
                    htmlFor="display_name"
                    className="mb-1 block text-[11px] font-medium text-brand-textMuted"
                  >
                    Display name
                  </label>
                  <input
                    id="display_name"
                    type="text"
                    value={displayNameInput}
                    onChange={(e) => setDisplayNameInput(e.target.value)}
                    className="ui-input no-zoom-input"
                    placeholder="Your public name"
                  />
                  <p className="mt-1 text-[11px] text-brand-textMuted">
                    3–15 characters. Letters, numbers, spaces, underscores, dashes,
                    and dots only.
                  </p>
                </div>

                <div>
                  <label
                    htmlFor="username"
                    className="mb-1 block text-[11px] font-medium text-brand-textMuted"
                  >
                    Username
                  </label>
                  <input
                    id="username"
                    type="text"
                    value={usernameInput}
                    onChange={(e) => setUsernameInput(e.target.value.toLowerCase())}
                    className="ui-input no-zoom-input"
                    placeholder="Unique handle (lowercase)"
                  />
                  <p className="mt-1 text-[11px] text-brand-textMuted">
                    3–15 characters. Lowercase letters, numbers, underscores,
                    dashes, and dots only. Must be unique.
                  </p>
                </div>

                <div>
                  <label
                    htmlFor="bio"
                    className="mb-1 block text-[11px] font-medium text-brand-textMuted"
                  >
                    Bio
                  </label>
                  <textarea
                    id="bio"
                    value={bioInput}
                    onChange={(e) => setBioInput(e.target.value)}
                    rows={4}
                    className="ui-input no-zoom-input"
                    placeholder="Tell people a bit about you, your cars, or what you know."
                  />
                  <p className="mt-1 text-[11px] text-brand-textMuted">
                    Optional. Keep it under 800 characters.
                  </p>
                </div>

                <div>
                  <label
                    htmlFor="location"
                    className="mb-1 block text-[11px] font-medium text-brand-textMuted"
                  >
                    Location
                  </label>
                  <input
                    id="location"
                    type="text"
                    value={locationInput}
                    onChange={(e) => setLocationInput(e.target.value)}
                    className="ui-input no-zoom-input"
                    placeholder="City / region (optional)"
                  />
                  <p className="mt-1 text-[11px] text-brand-textMuted">
                    Optional. Example: &quot;NY, USA&quot; or &quot;Osaka,
                    Japan&quot;.
                  </p>
                </div>
              </div>

              <div className="mt-4 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={handleProfileSave}
                  disabled={profileSaving}
                  className="ui-btn ui-btn-primary text-xs"
                >
                  {profileSaving ? "Saving…" : "Save changes"}
                </button>
                {profileMessage && (
                  <span className="text-[11px] text-brand-textMuted">
                    {profileMessage}
                  </span>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Account tab */}
        {activeTab === "security" && (
          <div className="mt-5 space-y-5 text-[12px] text-brand-textMuted">
            <div className="grid gap-3 md:grid-cols-3">
              <div>
                <div className="text-[11px] uppercase tracking-wide text-zinc-400">
                  Email
                </div>
                <div className="text-sm text-brand-text">
                  {user.email || "Not set"}
                </div>
              </div>
              <div>
                <div className="text-[11px] uppercase tracking-wide text-zinc-400">
                  Member since
                </div>
                <div className="text-sm text-brand-text">
                  {memberSince || "Unknown"}
                </div>
              </div>
              <div>
                <div className="text-[11px] uppercase tracking-wide text-zinc-400">
                  Last seen
                </div>
                <div className="text-sm text-brand-text">
                  {lastSeen || "No activity recorded yet"}
                </div>
              </div>
            </div>

            {profile?.is_verified ? (
              <div>
                <h2 className="mb-1 text-[13px] font-semibold text-brand-text">
                  Submissions
                </h2>
                <p className="mb-3 text-[11px] text-brand-textMuted">
                  Create and track info pages you&apos;ve contributed to the archive.
                </p>
                <div className="flex flex-wrap gap-2">
                  <Link
                    href="/info/mine"
                    className="ui-btn ui-btn-primary text-xs"
                  >
                    View my submissions
                  </Link>
                  <Link
                    href="/info/submit"
                    className="ui-btn ui-btn-ghost text-xs"
                  >
                    Submit info page
                  </Link>
                </div>
              </div>
            ) : null}

            <div>
              <h2 className="mb-1 text-[13px] font-semibold text-brand-text">
                Password
              </h2>
              <p className="mb-3 text-[11px] text-brand-textMuted">
                Add a password to a Google or email-link account, or replace your existing password. You can still use Google or a one-time email link afterward.
              </p>
              <div className="grid gap-3 sm:max-w-xl sm:grid-cols-2">
                <label className="block">
                  <span className="ui-label">New password</span>
                  <input className="ui-input no-zoom-input" type="password" autoComplete="new-password" minLength={12} value={newPassword} onChange={(e) => setNewPassword(e.target.value)} />
                </label>
                <label className="block">
                  <span className="ui-label">Confirm password</span>
                  <input className="ui-input no-zoom-input" type="password" autoComplete="new-password" minLength={12} value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} />
                </label>
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <button type="button" onClick={handlePasswordSave} disabled={passwordBusy || !newPassword || !confirmPassword} className="ui-btn ui-btn-primary text-xs">
                  {passwordBusy ? "Saving…" : "Set or change password"}
                </button>
                {passwordMessage ? <span className="text-[11px] text-brand-textMuted">{passwordMessage}</span> : null}
              </div>
            </div>

            <div>
              <h2 className="mb-1 text-[13px] font-semibold text-brand-text">
                Session
              </h2>
              <p className="mb-3 text-[11px] text-brand-textMuted">
                Sign out on this browser. You can log back in with Google, your
                password, or a one-time email link.
              </p>
              <Link
                href="/auth/logout"
                className="ui-btn ui-btn-ghost text-xs"
              >
                Log out
              </Link>
            </div>

            <div className="rounded-xl border border-rose-500/20 bg-rose-500/5 p-4">
              <h2 className="mb-1 text-[13px] font-semibold text-rose-200">
                Delete account
              </h2>
              <p className="mb-3 text-[11px] text-rose-200/70">
                This permanently deletes your account and associated data. This cannot be undone.
              </p>
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                <input
                  value={deleteConfirm}
                  onChange={(e) => setDeleteConfirm(e.target.value)}
                  placeholder='Type "DELETE"'
                  className="no-zoom-input w-full rounded-md border border-rose-500/30 bg-black/40 px-3 py-2 text-sm text-brand-text outline-none placeholder:text-zinc-500 focus:border-rose-400/70 sm:max-w-[220px]"
                />
                <button
                  type="button"
                  onClick={handleDeleteAccount}
                  disabled={deleteBusy || deleteConfirm.trim() !== "DELETE"}
                  className="inline-flex items-center justify-center rounded-full border border-rose-400/60 bg-rose-500/15 px-4 py-2 text-[12px] font-medium text-rose-200 transition hover:bg-rose-500/20 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {deleteBusy ? "Deleting…" : "Delete permanently"}
                </button>
                {deleteMessage && (
                  <span className="text-[11px] text-rose-200/80">{deleteMessage}</span>
                )}
              </div>
            </div>

            {error && (
              <p className="mt-2 text-[11px] text-rose-300/80">{error}</p>
            )}
          </div>
        )}
        {activeTab === "reports" && (
  <div className="mt-5 space-y-4">
    <div className="flex items-start justify-between gap-3">
      <div>
        <h2 className="mb-1 text-[13px] font-semibold text-brand-text">Your reports</h2>
        <p className="text-[11px] text-brand-textMuted">
          Track status updates from staff. Open a report to view the thread and replies.
        </p>
      </div>
      <button
        type="button"
        onClick={() => user && void loadMyReports(user.id)}
        className="ui-btn ui-btn-ghost text-xs"
      >
        Refresh
      </button>
    </div>

    {myReportsLoading ? (
      <p className="text-[11px] text-brand-textMuted">Loading…</p>
    ) : myReportsError ? (
      <p className="text-[11px] text-rose-300/80">{myReportsError}</p>
    ) : myReports.length === 0 ? (
      <div className="ui-card text-xs text-brand-textMuted">
        You haven’t submitted any reports.
      </div>
    ) : (
      <div className="ui-table-wrap">
        <table className="min-w-full text-left text-[12px]">
          <thead className="text-[11px] text-brand-textMuted">
            <tr className="border-b border-zinc-800">
              <th className="px-3 py-2">Created</th>
              <th className="px-3 py-2">Category</th>
              <th className="px-3 py-2">Reason</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2 text-right">Open</th>
            </tr>
          </thead>
          <tbody>
            {myReports.map((r) => (
              <tr key={r.id} className="border-b border-zinc-900">
                <td className="px-3 py-2 whitespace-nowrap text-[11px] text-brand-textMuted">
                  {new Date(r.created_at).toLocaleString()}
                </td>
                <td className="px-3 py-2 whitespace-nowrap">
                  {r.category ? (
                    <span className="rounded-full border border-zinc-700 bg-black/40 px-2 py-0.5 text-[11px] text-zinc-200">
                      {r.category.replace(/_/g, " ")}
                    </span>
                  ) : (
                    <span className="text-[11px] text-brand-textMuted">—</span>
                  )}
                </td>
                <td className="px-3 py-2">
                  <div className="line-clamp-2 max-w-[520px] text-[11px] text-brand-text">
                    {(() => {
                      const s = (r.reason ?? "").trim();
                      if (!s) return "—";
                      return s.length > 50 ? s.slice(0, 50) + "..." : s;
                    })()}
                  </div>
                </td>
                <td className="px-3 py-2 whitespace-nowrap">
                  <span className="rounded-full border border-zinc-700 bg-black/40 px-2 py-0.5 text-[11px] text-zinc-200">
                    {r.status.replace(/_/g, " ")}
                  </span>
                </td>
                <td className="px-3 py-2 text-right whitespace-nowrap">
                  <Link
                    href={`/reports/${r.id}`}
                    className="ui-btn ui-btn-primary px-3 py-1 text-xs"
                  >
                    Open
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )}
  </div>
)}

{activeTab === "blocked" && (
          <div className="mt-5 space-y-3">
            <div>
              <h2 className="mb-1 text-[13px] font-semibold text-brand-text">
                Blocked users
              </h2>
              <p className="text-[11px] text-brand-textMuted">
                Manage people you’ve blocked. Unblocking will let them show up again across the site.
              </p>
            </div>

            {blockedError && (
              <p className="text-[11px] text-rose-300/80">{blockedError}</p>
            )}

            {blockedLoading ? (
              <p className="text-[11px] text-brand-textMuted">Loading blocked users…</p>
            ) : blockedUsers.length === 0 ? (
              <div className="ui-card text-xs text-brand-textMuted">
                You haven’t blocked anyone.
              </div>
            ) : (
              <div className="space-y-2">
                {blockedUsers.map((b) => {
                  const p = b.profiles?.[0] ?? null;
                  const name = p?.display_name || p?.username || "Unknown user";
                  const uname = p?.username ? `@${p.username}` : null;
                  const href = p?.username ? `/user/@${p.username}` : "#";
                  const isBusy = unblockingIds.has(b.id);

                  return (
                    <div
                      key={b.id}
                      className="ui-card flex items-center justify-between gap-3 p-3"
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        {p?.avatar_url ? (
                          <img
                            src={p.avatar_url}
                            alt={name}
                            className="h-10 w-10 rounded-full border border-zinc-700 object-cover"
                          />
                        ) : (
                          <div className="h-10 w-10 rounded-full border border-zinc-700 bg-black/40" />
                        )}

                        <div className="min-w-0">
                          <Link
                            href={href}
                            className="block truncate text-[12px] font-medium text-brand-text hover:text-white"
                          >
                            {name}
                          </Link>
                          {uname && (
                            <div className="truncate text-[11px] text-brand-textMuted">
                              {uname}
                            </div>
                          )}
                        </div>
                      </div>

                      <button
                        type="button"
                        onClick={() => handleUnblock(b.id)}
                        disabled={isBusy}
                        className="ui-btn ui-btn-ghost shrink-0 px-3 py-1 text-xs"
                      >
                        {isBusy ? "Unblocking…" : "Unblock"}
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
