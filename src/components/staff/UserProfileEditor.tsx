"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { UserAvatar } from "@/components/staff/UserAvatar";
import { Field } from "@/components/ui/DesignSystem";
import { MenuSelect } from "@/components/ui/MenuSelect";
import { donationRankOptions } from "@/lib/donationRanks";
import { PROFILE_FIELD_LIMITS } from "@/lib/staff/userAccess";

/**
 * The profile fields staff may edit — and only those.
 *
 * ## Three routes, not one
 *
 * `users.profile.edit` writes the text fields, `users.verify` flips
 * verification, `users.donation_rank.set` sets the badge. Merging them into a
 * single Save would mean a staff member holding one of the three pressing a
 * button that fails for reasons they cannot see.
 *
 * ## What moved, and why
 *
 * This used to sit open on the Overview tab with its own Save button, which is
 * what made a summary page a settings page. It is now inside a disclosure that
 * is closed until somebody wants to edit.
 *
 * **Verified** and **Donation rank** moved behind *Advanced*. They are real,
 * they still work, and their routes and permissions are untouched — but they are
 * community-era attributes on a shop's customer record, and giving them the same
 * weight as a display name is what made this page read as an old forum admin
 * screen. `Bio` went with them for the same reason.
 *
 * **Email is displayed and not editable.** It lives in `auth.users` and this
 * codebase has no verified email-change flow; an unverified change is an
 * account-takeover primitive. The input is absent rather than disabled, because
 * a greyed-out field invites somebody to go looking for the permission that
 * enables it.
 *
 * ## The avatar
 *
 * Replacing it posts to the existing `…/avatar` route, which validates the type
 * and size, writes one object per user under a key derived from the uuid, and
 * removes the previous one. No second storage path is created here.
 */

type Props = {
  userId: string;
  token: string;
  initial: {
    username: string | null;
    displayName: string | null;
    bio: string | null;
    location: string | null;
    email: string | null;
    avatarUrl: string | null;
    isVerified: boolean;
    donationRank: string | null;
  };
  canEditProfile: boolean;
  canVerify: boolean;
  canSetDonationRank: boolean;
  onChanged: () => void;
};

export function UserProfileEditor({
  userId,
  token,
  initial,
  canEditProfile,
  canVerify,
  canSetDonationRank,
  onChanged,
}: Props) {
  const [username, setUsername] = useState(initial.username ?? "");
  const [displayName, setDisplayName] = useState(initial.displayName ?? "");
  const [bio, setBio] = useState(initial.bio ?? "");
  const [location, setLocation] = useState(initial.location ?? "");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const [verified, setVerified] = useState(initial.isVerified);
  const [rank, setRank] = useState(initial.donationRank ?? "");
  const [flagMessage, setFlagMessage] = useState<string | null>(null);

  const [avatarBusy, setAvatarBusy] = useState(false);
  const [avatarMessage, setAvatarMessage] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setUsername(initial.username ?? "");
    setDisplayName(initial.displayName ?? "");
    setBio(initial.bio ?? "");
    setLocation(initial.location ?? "");
    setVerified(initial.isVerified);
    setRank(initial.donationRank ?? "");
  }, [initial.username, initial.displayName, initial.bio, initial.location, initial.isVerified, initial.donationRank]);

  const dirty = useMemo(
    () =>
      username !== (initial.username ?? "") ||
      displayName !== (initial.displayName ?? "") ||
      bio !== (initial.bio ?? "") ||
      location !== (initial.location ?? ""),
    [username, displayName, bio, location, initial]
  );

  const patch = async (url: string, body: unknown, onOk: () => void, setMsg: (m: string) => void) => {
    const res = await fetch(url, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => null)) as { error?: string; changed?: boolean; auditFailed?: boolean } | null;
    if (!res.ok) {
      setMsg(json?.error ?? "Could not save.");
      return;
    }
    setMsg(json?.auditFailed ? "Saved, but the audit event failed to record." : json?.changed === false ? "No change." : "Saved.");
    onOk();
  };

  const saveProfile = async () => {
    setSaving(true);
    setMessage(null);
    try {
      await patch(
        `/api/staff/security/users/${userId}/profile`,
        {
          username: username.trim() || null,
          display_name: displayName.trim() || null,
          bio: bio.trim() || null,
          location: location.trim() || null,
        },
        onChanged,
        setMessage
      );
    } finally {
      setSaving(false);
    }
  };

  const uploadAvatar = async (file: File) => {
    setAvatarBusy(true);
    setAvatarMessage(null);
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch(`/api/staff/security/users/${userId}/avatar`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: form,
      });
      const json = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) {
        setAvatarMessage(json?.error ?? "Could not replace the picture.");
        return;
      }
      setAvatarMessage("Picture replaced.");
      onChanged();
    } finally {
      setAvatarBusy(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  };

  if (!canEditProfile && !canVerify && !canSetDonationRank) return null;

  return (
    <details className="staff-disclosure">
      <summary>Edit profile</summary>
      <div className="staff-disclosure-body">
        {canEditProfile ? (
          <>
            <div className="flex flex-wrap items-center gap-3">
              <UserAvatar src={initial.avatarUrl} label={displayName || username || "Person"} size={48} />
              <div>
                <input
                  ref={fileInput}
                  id="avatar-file"
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  className="sr-only"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) void uploadAvatar(file);
                  }}
                />
                <label htmlFor="avatar-file" className="ui-btn ui-btn-secondary cursor-pointer">
                  {avatarBusy ? "Uploading…" : "Replace picture"}
                </label>
                <p className="mt-1 text-xs" aria-live="polite" style={{ color: "var(--muted)" }}>
                  {avatarMessage ?? "PNG, JPEG or WebP. Replaces the existing picture."}
                </p>
              </div>
            </div>

            <div className="staff-form-grid mt-4">
              <Field label="Display name">
                <input
                  className="ui-input"
                  value={displayName}
                  maxLength={PROFILE_FIELD_LIMITS.display_name}
                  onChange={(event) => setDisplayName(event.target.value)}
                />
              </Field>
              <Field label="Username">
                <input
                  className="ui-input"
                  value={username}
                  maxLength={PROFILE_FIELD_LIMITS.username}
                  onChange={(event) => setUsername(event.target.value)}
                />
              </Field>
              <Field label="Location">
                <input
                  className="ui-input"
                  value={location}
                  maxLength={PROFILE_FIELD_LIMITS.location}
                  onChange={(event) => setLocation(event.target.value)}
                />
              </Field>
              <Field label="Email" help="Read-only. There is no verified email-change flow in staff tools.">
                <p className="text-sm" style={{ color: "var(--muted)" }}>
                  {initial.email ?? "None on record"}
                </p>
              </Field>
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-2">
              <button
                type="button"
                className="ui-btn ui-btn-primary"
                disabled={!dirty || saving}
                onClick={() => void saveProfile()}
              >
                {saving ? "Saving…" : "Save profile"}
              </button>
              <span className="text-xs" aria-live="polite" style={{ color: "var(--muted)" }}>
                {saving ? "Saving…" : dirty ? "Unsaved changes" : message ?? "Everything saved"}
              </span>
            </div>
          </>
        ) : null}

        {/*
         * Community-era attributes, kept and de-emphasised.
         *
         * Bio, verification and donation rank predate the shop. Nothing about
         * them is removed — same routes, same permissions, same behaviour — but
         * a customer record for a machine shop should not open on them.
         */}
        {canEditProfile || canVerify || canSetDonationRank ? (
          <details className="staff-disclosure mt-4">
            <summary>Advanced profile</summary>
            <div className="staff-disclosure-body">
              {/* The raw identifier, which used to be the first row of the
                  Overview tab. Nobody opens a customer record to read a uuid,
                  but the one person who needs it — reconciling a support
                  ticket, a log line, a database row — needs it exactly. */}
              <p className="text-xs" style={{ color: "var(--muted)" }}>
                Account ID <span className="font-mono break-all">{userId}</span>
              </p>

              {canEditProfile ? (
                <Field label="Bio" help="Shown on their public profile.">
                  <textarea
                    className="ui-input"
                    rows={3}
                    value={bio}
                    maxLength={PROFILE_FIELD_LIMITS.bio}
                    onChange={(event) => setBio(event.target.value)}
                  />
                </Field>
              ) : null}

              {canVerify || canSetDonationRank ? (
                <div className="mt-3 flex flex-wrap items-center gap-3">
                  {canVerify ? (
                    <label className="staff-check">
                      <input
                        type="checkbox"
                        checked={verified}
                        onChange={(event) => {
                          const next = event.target.checked;
                          setVerified(next);
                          void patch(
                            `/api/staff/security/users/${userId}/verify`,
                            { is_verified: next },
                            onChanged,
                            setFlagMessage
                          );
                        }}
                      />
                      <span className="staff-check-text">
                        Verified member
                        <span className="staff-check-help">
                          A community flag. Grants any bonus permissions configured under Verified perks.
                        </span>
                      </span>
                    </label>
                  ) : null}

                  {canSetDonationRank ? (
                    <Field label="Donation rank" help="A community badge. Not related to orders or spend.">
                      <MenuSelect
                        ariaLabel="Donation rank"
                        value={rank}
                        options={[
                          { value: "", label: "None" },
                          ...donationRankOptions.map((o) => ({ value: o.value, label: o.label })),
                        ]}
                        onChange={(value) => {
                          setRank(value);
                          void patch(
                            `/api/staff/security/users/${userId}/donation-rank`,
                            { donation_rank: value || null },
                            onChanged,
                            setFlagMessage
                          );
                        }}
                      />
                    </Field>
                  ) : null}

                  {flagMessage ? (
                    <span className="text-xs" aria-live="polite" style={{ color: "var(--muted)" }}>
                      {flagMessage}
                    </span>
                  ) : null}
                </div>
              ) : null}
            </div>
          </details>
        ) : null}
      </div>
    </details>
  );
}
