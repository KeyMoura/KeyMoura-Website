"use client";

import { useEffect, useMemo, useState } from "react";

import { Card, EmptyState, Section } from "@/components/staff/StaffPage";
import { Notice } from "@/components/ui/DesignSystem";
import {
  OVERRIDE_RULE,
  PERMISSION_SOURCE_LABELS,
  PERMISSION_SOURCE_MARKS,
  permissionGroupViews,
  type PermissionGroupView,
} from "@/lib/staff/permissionGroups";

/**
 * What this person can do, and where each power comes from.
 *
 * ## What was here before
 *
 * 115 checkboxes in one ungrouped column, labelled with raw keys
 * (`catalog.categories.manage`), behind a category dropdown that showed one
 * category at a time. Measured at 6,367px tall — seven screens at a 900px
 * viewport. Nothing on it said which permissions the person's **role** already
 * granted, so the screen could not answer the question a reader actually brings
 * to it, and every tick looked like the only thing standing between the person
 * and the power.
 *
 * ## What it is now
 *
 * The full effective picture, grouped into areas a person would name, with each
 * row saying where it comes from: from the role, added for this person, or not
 * granted. The mark is a **shape** as well as a colour (`✓`, `+`, `○`) and the
 * source is spelled out in words beside it, because a matrix that encodes its
 * only distinction in colour is unreadable to a good share of the people who
 * have to use it.
 *
 * Groups are collapsed by default and open when the person holds something in
 * them, so a support account opens showing Support and Communications rather
 * than twelve empty accordions.
 *
 * ## Overrides can only add
 *
 * `user_permissions` is additive; there is no deny row in this schema and this
 * component must not draw a control implying otherwise. Rows the role grants
 * show no checkbox at all — a checkbox that cannot turn the thing off is a lie
 * about what pressing it does. {@link OVERRIDE_RULE} states the rule on screen.
 *
 * The save still goes through the existing `PUT` route, which computes the
 * before/after diff and writes `permission.changed`. Nothing here writes an
 * audit event; a client component never should.
 */

export function UserPermissionOverrides({
  userId,
  token,
  canGrant,
  roleName,
  rolePermissions,
  overrides,
  onSaved,
}: {
  userId: string;
  token: string;
  /** Whether this viewer may change the overrides. Reading is always allowed here. */
  canGrant: boolean;
  roleName: string;
  /** `null` when the viewer may not read role definitions. */
  rolePermissions: readonly string[] | null;
  overrides: readonly string[] | null;
  onSaved: () => void;
}) {
  const roleSet = useMemo(() => new Set(rolePermissions ?? []), [rolePermissions]);
  const [granted, setGranted] = useState<Set<string>>(() => new Set(overrides ?? []));
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [showKeys, setShowKeys] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);

  // Re-seeded whenever the workspace reloads, so a save elsewhere on the page
  // does not leave this control asserting a stale set.
  useEffect(() => {
    setGranted(new Set(overrides ?? []));
    setConfirmReset(false);
  }, [overrides]);

  const groups = useMemo(
    () => permissionGroupViews({ rolePermissions: roleSet, overrides: granted }),
    [roleSet, granted]
  );

  const savedOverrides = useMemo(() => new Set(overrides ?? []), [overrides]);
  const dirty = useMemo(
    () => granted.size !== savedOverrides.size || [...granted].some((key) => !savedOverrides.has(key)),
    [granted, savedOverrides]
  );

  const save = async (next: Set<string>) => {
    setSaving(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/staff/security/users/${userId}/permissions`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ permissions: [...next] }),
      });
      const json = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) {
        setMessage(json?.error ?? "Could not save the overrides.");
        return;
      }
      setMessage("Saved.");
      onSaved();
    } finally {
      setSaving(false);
      setConfirmReset(false);
    }
  };

  if (rolePermissions === null) {
    return (
      <Section
        headingLevel={3}
        title="Effective permissions"
        description="What this person can do, from their role and from any exceptions granted to them."
      >
        <Notice tone="info">
          Not shown. Seeing what a role grants needs the &ldquo;View roles&rdquo; permission, and this account does not
          hold it.
        </Notice>
      </Section>
    );
  }

  const heldTotal = groups.reduce((sum, group) => sum + group.heldCount, 0);
  const overrideTotal = groups.reduce((sum, group) => sum + group.overrideCount, 0);

  return (
    <Section
      headingLevel={3}
      title="Effective permissions"
      description={`${heldTotal} ${heldTotal === 1 ? "permission" : "permissions"} in total — ${
        heldTotal - overrideTotal
      } from the ${roleName} role${overrideTotal ? `, ${overrideTotal} added for this person` : ""}.`}
      actions={
        <button
          type="button"
          className="ui-chip"
          aria-pressed={showKeys}
          onClick={() => setShowKeys((open) => !open)}
        >
          {showKeys ? "Hide permission keys" : "Advanced"}
        </button>
      }
    >
      <p className="text-xs" style={{ color: "var(--muted)" }}>
        {OVERRIDE_RULE}
      </p>

      {groups.length === 0 ? (
        <EmptyState>No permissions are defined.</EmptyState>
      ) : (
        <div>
          {groups.map((group) => (
            <PermissionGroupBlock
              key={group.id}
              group={group}
              canGrant={canGrant}
              showKeys={showKeys}
              onToggle={(key, checked) => {
                setGranted((prev) => {
                  const next = new Set(prev);
                  if (checked) next.add(key);
                  else next.delete(key);
                  return next;
                });
              }}
            />
          ))}
        </div>
      )}

      {canGrant ? (
        <Card>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className="ui-btn ui-btn-primary"
              disabled={!dirty || saving}
              onClick={() => void save(granted)}
            >
              {saving ? "Saving…" : "Save exceptions"}
            </button>

            {confirmReset ? (
              <>
                <button
                  type="button"
                  className="ui-btn ui-btn-danger"
                  disabled={saving}
                  onClick={() => void save(new Set())}
                >
                  Remove all {savedOverrides.size} exceptions
                </button>
                <button type="button" className="ui-chip" onClick={() => setConfirmReset(false)}>
                  Cancel
                </button>
              </>
            ) : (
              <button
                type="button"
                className="ui-chip"
                disabled={savedOverrides.size === 0 || saving}
                onClick={() => setConfirmReset(true)}
              >
                Reset exceptions
              </button>
            )}

            <span className="text-xs" aria-live="polite" style={{ color: "var(--muted)" }}>
              {saving
                ? "Saving…"
                : dirty
                  ? "Unsaved changes"
                  : message ?? "Everything saved"}
            </span>
          </div>
        </Card>
      ) : (
        <p className="text-xs" style={{ color: "var(--muted)" }}>
          You do not have permission to add or remove exceptions. This is what the person holds today.
        </p>
      )}
    </Section>
  );
}

function PermissionGroupBlock({
  group,
  canGrant,
  showKeys,
  onToggle,
}: {
  group: PermissionGroupView;
  canGrant: boolean;
  showKeys: boolean;
  onToggle: (key: string, checked: boolean) => void;
}) {
  /*
   * Collapsed by default, open when this group holds an **exception**.
   *
   * Opening every group the person holds anything in looked helpful and was
   * not: an administrator holds something in eleven of twelve, which was 4,463
   * pixels of ticks confirming what the word "Administrator" already said. The
   * counts in the summary are the overview — twelve lines, one screen — and the
   * groups that open on their own are the ones carrying something the role did
   * not give.
   */
  return (
    <details className="staff-perm-group" open={group.overrideCount > 0}>
      <summary className="staff-perm-summary">
        <span>{group.label}</span>
        <span className="staff-perm-summary-note">
          {group.heldCount} of {group.rows.length}
          {group.overrideCount ? ` · ${group.overrideCount} added for this person` : ""}
        </span>
      </summary>
      <div className="staff-perm-list">
        {group.rows.map((row) => {
          // A permission the role grants gets no checkbox: unticking it would
          // not remove anything, and a control that does nothing is worse than
          // no control. The row still shows, so the reader sees the power.
          const editable = canGrant && !row.fromRole;
          const body = (
            <>
              <span className="staff-perm-mark" aria-hidden="true">
                {PERMISSION_SOURCE_MARKS[row.source]}
              </span>
              <span className="staff-perm-name">{row.label}</span>
              <span className="staff-perm-source">{PERMISSION_SOURCE_LABELS[row.source]}</span>
              {showKeys ? <span className="staff-perm-key">{row.key}</span> : null}
            </>
          );

          if (!editable) {
            return (
              <div key={row.key} className="staff-perm-row" data-source={row.source} title={row.description ?? undefined}>
                {body}
              </div>
            );
          }

          return (
            <div key={row.key} className="staff-perm-row" data-source={row.source} title={row.description ?? undefined}>
              <input
                type="checkbox"
                id={`perm-${row.key}`}
                checked={row.overridden}
                onChange={(event) => onToggle(row.key, event.target.checked)}
              />
              <label className="staff-perm-name" htmlFor={`perm-${row.key}`}>
                {row.label}
              </label>
              <span className="staff-perm-source">{PERMISSION_SOURCE_LABELS[row.source]}</span>
              {showKeys ? <span className="staff-perm-key">{row.key}</span> : null}
            </div>
          );
        })}
      </div>
    </details>
  );
}
