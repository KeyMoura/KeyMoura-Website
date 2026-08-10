"use client";

import { useEffect, useMemo, useState } from "react";

import { Card, Section } from "@/components/staff/StaffPage";
import { Field } from "@/components/ui/DesignSystem";
import { MenuSelect } from "@/components/ui/MenuSelect";
import { donationRankOptions } from "@/lib/donationRanks";
import { PROFILE_FIELD_LIMITS } from "@/lib/staff/userAccess";

/**
 * The profile fields staff may edit, and the two flags that live beside them.
 *
 * Three routes, not one, because they are three different permissions:
 * `users.profile.edit` writes the text fields, `users.verify` flips
 * verification, `users.donation_rank.set` sets the badge. Merging them into a
 * single Save would mean a staff member with one of the three pressing a button
 * that fails for reasons they cannot see.
 *
 * **Email is displayed and not editable.** It lives in `auth.users` and this
 * codebase has no verified email-change flow; an unverified change is an
 * account-takeover primitive. The input is absent rather than disabled, because
 * a greyed-out field invites somebody to go looking for the permission that
 * enables it.
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

  if (!canEditProfile && !canVerify && !canSetDonationRank) return null;

  return (
    <Section
      headingLevel={3}
      title="Details"
      description="Staff-editable profile fields. Email, password, sign-in methods and multi-factor settings are not editable here."
    >
      <Card>
        {canEditProfile ? (
          <>
            <div className="staff-form-grid">
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

            <div className="staff-form-wide mt-3">
              <Field label="Bio">
                <textarea
                  className="ui-input"
                  rows={3}
                  value={bio}
                  maxLength={PROFILE_FIELD_LIMITS.bio}
                  onChange={(event) => setBio(event.target.value)}
                />
              </Field>
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-2">
              <button
                type="button"
                className="ui-btn ui-btn-primary"
                disabled={!dirty || saving}
                onClick={() => void saveProfile()}
              >
                {saving ? "Saving…" : "Save details"}
              </button>
              <span className="text-xs" aria-live="polite" style={{ color: "var(--muted)" }}>
                {saving ? "Saving…" : dirty ? "Unsaved changes" : message ?? "Everything saved"}
              </span>
            </div>
          </>
        ) : null}

        {canVerify || canSetDonationRank ? (
          <div className="mt-4 flex flex-wrap items-center gap-3 border-t pt-3" style={{ borderColor: "var(--border)" }}>
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
                  Verified
                  <span className="staff-check-help">Grants any bonus permissions configured under Verified perks.</span>
                </span>
              </label>
            ) : null}

            {canSetDonationRank ? (
              <label className="flex items-center gap-2 text-xs" style={{ color: "var(--muted)" }}>
                Donation rank
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
              </label>
            ) : null}

            {flagMessage ? (
              <span className="text-xs" aria-live="polite" style={{ color: "var(--muted)" }}>
                {flagMessage}
              </span>
            ) : null}
          </div>
        ) : null}
      </Card>
    </Section>
  );
}
