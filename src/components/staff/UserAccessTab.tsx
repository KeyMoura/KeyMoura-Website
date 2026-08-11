"use client";

import { useMemo, useState } from "react";

import { ConsequentialAction, resultFromResponse } from "@/components/staff/ConsequentialAction";
import { Card, Fact, Facts, Section } from "@/components/staff/StaffPage";
import { UserPermissionOverrides } from "@/components/staff/UserPermissionOverrides";
import { Badge, Notice } from "@/components/ui/DesignSystem";
import { MenuSelect } from "@/components/ui/MenuSelect";
import { roleChangeImpact } from "@/lib/staff/permissionGroups";
import {
  MIN_STATUS_REASON_LENGTH,
  RESTRICTION_DURATIONS,
  RESTRICTION_KINDS,
  RESTRICTION_KIND_LABELS,
  RESTRICTION_KIND_MEANING,
  STATUS_ACTION_COPY,
  type RestrictionKind,
} from "@/lib/staff/userAccess";
import { ACCOUNT_STATUS_LABELS, ACCOUNT_STATUS_MEANING } from "@/lib/staff/userDirectory";
import type { UserWorkspace } from "@/lib/staff/userWorkspace";

/**
 * Access — the role, what it reaches, and whether the account works at all.
 *
 * Three panels in the order somebody needs them: which role this person holds,
 * what standing their account is in, and the full permission picture. The tab
 * was called "Roles & access" and stacked four unrelated blocks, one of which
 * was 115 raw permission keys.
 *
 * Every control here is hidden when the viewer may not use it **and** refused by
 * the route if it is called anyway. The `viewer` block drives the hiding; the
 * route is the boundary.
 */

const PROVIDER_LABELS: Readonly<Record<string, string>> = {
  email: "Email & password",
  google: "Google",
  facebook: "Facebook",
};

function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const parsed = new Date(iso);
  if (!Number.isFinite(parsed.getTime())) return "—";
  return parsed.toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" });
}

export function UserAccessTab({
  workspace,
  auth,
  onChanged,
}: {
  workspace: UserWorkspace;
  auth: { token: string };
  onChanged: () => void;
}) {
  const { user, viewer } = workspace;

  return (
    <>
      <RolePanel workspace={workspace} auth={auth} onChanged={onChanged} />
      <AccountStatusPanel workspace={workspace} auth={auth} onChanged={onChanged} />

      <UserPermissionOverrides
        userId={user.id}
        token={auth.token}
        canGrant={viewer.canGrantPermissions}
        roleName={user.roleName}
        rolePermissions={workspace.rolePermissions?.[user.roleKey] ?? null}
        overrides={workspace.permissionOverrides}
        onSaved={onChanged}
      />

      <Section
        headingLevel={3}
        title="Sign-in methods"
        description="Read-only. Passwords, tokens and multi-factor settings are never shown here and cannot be changed from staff tools."
      >
        <Card>
          {user.providers.length ? (
            <span className="flex flex-wrap gap-1.5">
              {user.providers.map((provider) => (
                <Badge key={provider} tone="neutral">
                  {PROVIDER_LABELS[provider] ?? provider}
                </Badge>
              ))}
            </span>
          ) : (
            <p className="text-sm" style={{ color: "var(--muted)" }}>
              No linked sign-in methods on record.
            </p>
          )}
          <p className="mt-2 text-xs" style={{ color: "var(--muted)" }}>
            Last signed in {user.lastSignInAt ? formatDate(user.lastSignInAt) : "never"}. Email is read-only because
            there is no verified change flow, and an identity cannot be unlinked from here.
          </p>
        </Card>
      </Section>
    </>
  );
}

// ---------------------------------------------------------------------------
// Role
// ---------------------------------------------------------------------------

/**
 * A role change, with its cost stated before it is made.
 *
 * The old control was a dropdown and a "Change role" button that said one
 * sentence — and only when the change crossed the staff boundary. Administrator
 * → Support said nothing at all about the catalog, people and commerce settings
 * about to be lost.
 *
 * The areas come from `roleChangeImpact`, which diffs the two roles' permission
 * sets **including this person's overrides**, because overrides survive a role
 * change and somebody keeping an area only through one must not be warned they
 * are losing it.
 */
function RolePanel({
  workspace,
  auth,
  onChanged,
}: {
  workspace: UserWorkspace;
  auth: { token: string };
  onChanged: () => void;
}) {
  const { user, viewer } = workspace;
  const [nextRole, setNextRole] = useState<string>("");

  const chosen = viewer.assignableRoles.find((role) => role.key === nextRole) ?? null;

  const impact = useMemo(() => {
    if (!chosen || !workspace.rolePermissions) return null;
    return roleChangeImpact({
      currentRolePermissions: new Set(workspace.rolePermissions[user.roleKey] ?? []),
      nextRolePermissions: new Set(workspace.rolePermissions[chosen.key] ?? []),
      overrides: new Set(workspace.permissionOverrides ?? []),
    });
  }, [chosen, workspace.rolePermissions, workspace.permissionOverrides, user.roleKey]);

  return (
    <Section
      headingLevel={3}
      title="Role"
      description="A person holds exactly one role, and it decides what they can reach."
    >
      <Card>
        <Facts>
          <Fact label="Current role">
            <span className="flex flex-wrap items-center gap-2">
              {user.roleName}
              <Badge tone={user.isStaff ? "accent" : "neutral"}>{user.isStaff ? "Staff" : "Customer"}</Badge>
            </span>
          </Fact>
          <Fact label="Staff area">{user.isStaff ? "Can sign in to staff tools" : "No staff access"}</Fact>
        </Facts>

        {viewer.canAssignRole ? (
          <div className="mt-4 flex flex-wrap items-end gap-2">
            <label className="ui-field" style={{ minWidth: "12rem" }}>
              <span className="ui-label">Change to</span>
              <MenuSelect
                ariaLabel="New role"
                value={nextRole}
                options={[
                  { value: "", label: `${user.roleName} (no change)` },
                  ...viewer.assignableRoles
                    .filter((role) => role.key !== user.roleKey)
                    .map((role) => ({ value: role.key, label: role.name })),
                ]}
                onChange={setNextRole}
              />
            </label>

            {chosen ? (
              <ConsequentialAction
                label={`Change to ${chosen.name}`}
                title="Change role"
                tone={chosen.dangerous ? "danger" : "default"}
                currentState={user.roleName}
                nextState={chosen.name}
                summary={
                  <>
                    <p>
                      {chosen.isStaff && !user.isStaff
                        ? "This grants access to the staff area."
                        : !chosen.isStaff && user.isStaff
                          ? "This removes their staff access immediately."
                          : "This replaces the role that decides everything they can reach."}
                    </p>
                    {impact ? (
                      <div className="mt-3 grid gap-2 text-sm">
                        <ImpactList
                          heading="Loses access to"
                          items={impact.lost}
                          empty="Nothing — no area is lost."
                        />
                        <ImpactList heading="Gains access to" items={impact.gained} empty="No new areas." />
                        <ImpactList heading="Keeps" items={impact.retained} empty="Nothing carries over." />
                      </div>
                    ) : (
                      <p className="mt-2 text-xs" style={{ color: "var(--muted)" }}>
                        The exact change in access is not shown because this account cannot read role definitions.
                      </p>
                    )}
                  </>
                }
                effects={{
                  customer: chosen.isStaff !== user.isStaff ? "Their role badge changes on posts and messages." : null,
                  financial: null,
                  inventory: null,
                  notification: "None. The person is not emailed about a role change.",
                }}
                confirmLabel={`Make them ${chosen.name}`}
                onConfirm={async () => {
                  const res = await fetch(`/api/staff/security/users/${user.id}/role`, {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json", Authorization: `Bearer ${auth.token}` },
                    // The role the page believes is current, so a change decided
                    // against a stale screen is refused rather than applied.
                    body: JSON.stringify({ role: chosen.key, expectedRole: user.roleKey }),
                  });
                  const result = await resultFromResponse(res, "Could not change the role.");
                  if (result.ok) {
                    setNextRole("");
                    onChanged();
                  }
                  return result;
                }}
              />
            ) : null}
          </div>
        ) : (
          <p className="mt-3 text-xs" style={{ color: "var(--muted)" }}>
            {viewer.isSelf
              ? "You cannot change your own role. Ask another admin."
              : viewer.outranksViewer
                ? "This person is at or above your own level, so you cannot change their role."
                : "You do not have permission to assign roles."}
          </p>
        )}

        <p className="mt-3 text-xs" style={{ color: "var(--muted)" }}>
          Admin role changes need a second admin and are filed in the approvals queue rather than applied. The last
          remaining admin cannot be demoted at all.
        </p>
      </Card>
    </Section>
  );
}

function ImpactList({ heading, items, empty }: { heading: string; items: string[]; empty: string }) {
  return (
    <div>
      <p className="text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--muted)" }}>
        {heading}
      </p>
      {items.length ? (
        <ul className="mt-1 list-disc pl-5">
          {items.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      ) : (
        <p className="mt-1" style={{ color: "var(--muted)" }}>
          {empty}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Account status
// ---------------------------------------------------------------------------

/**
 * One panel for standing, whatever the backend calls it.
 *
 * The database keeps two distinct things — a ban in `user_bans` and up to three
 * area restrictions in `user_restrictions` — and the old panel exposed them as
 * two dropdowns of verbs and areas with no explanation of either. They are still
 * two distinct things here, because collapsing them would be wrong: lifting a
 * suspension does not lift a community restriction. What changed is that the
 * screen states which is which, in words, and each act is a confirmation naming
 * what happens and what survives.
 *
 * `durationHours` is now sent. The route has accepted it since the table was
 * created and the old UI never offered it, so every restriction applied from
 * this screen was permanent whether or not anybody meant it to be.
 */
function AccountStatusPanel({
  workspace,
  auth,
  onChanged,
}: {
  workspace: UserWorkspace;
  auth: { token: string };
  onChanged: () => void;
}) {
  const { user, status, viewer } = workspace;
  const [kind, setKind] = useState<RestrictionKind>("site");
  const [durationHours, setDurationHours] = useState<number | null>(null);

  const post = async (body: Record<string, unknown>) => {
    const res = await fetch(`/api/staff/users/${user.id}/status`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${auth.token}` },
      body: JSON.stringify({ ...body, expectedStatus: status.value }),
    });
    const result = await resultFromResponse(res, "Could not change the account status.");
    if (result.ok) onChanged();
    return result;
  };

  const reason = {
    label: "Reason",
    required: true,
    minLength: MIN_STATUS_REASON_LENGTH,
    placeholder: "Chargeback under review",
    help: "Recorded in the audit log and shown to the person in their notification.",
  };

  const activeKinds = new Set(status.restrictions.map((r) => r.kind));

  return (
    <Section headingLevel={3} title="Account status">
      <Card>
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={status.value === "suspended" ? "danger" : status.value === "restricted" ? "warning" : "success"}>
            {ACCOUNT_STATUS_LABELS[status.value]}
          </Badge>
          <span className="text-sm" style={{ color: "var(--muted)" }}>
            {ACCOUNT_STATUS_MEANING[status.value]}
          </span>
        </div>

        {status.banReason ? (
          <p className="mt-3 text-sm">
            <strong>Suspended:</strong> {status.banReason}{" "}
            <span style={{ color: "var(--muted)" }}>({formatDate(status.bannedAt)})</span>
          </p>
        ) : null}

        {status.restrictions.length ? (
          <ul className="mt-3 grid gap-1.5 text-sm">
            {status.restrictions.map((restriction) => (
              <li key={`${restriction.kind}-${restriction.createdAt}`}>
                <strong>{RESTRICTION_KIND_LABELS[restriction.kind as RestrictionKind] ?? restriction.kind}</strong>{" "}
                withheld — {restriction.reason ?? "no reason recorded"}{" "}
                <span style={{ color: "var(--muted)" }}>
                  (applied {formatDate(restriction.createdAt)};{" "}
                  {restriction.expiresAt ? `expires ${formatDate(restriction.expiresAt)}` : "no expiry"})
                </span>
              </li>
            ))}
          </ul>
        ) : null}

        {viewer.isSelf ? (
          <Notice tone="info" className="mt-4">
            You cannot change your own account status.
          </Notice>
        ) : !viewer.canSuspend && !viewer.canRestrict ? (
          <p className="mt-3 text-xs" style={{ color: "var(--muted)" }}>
            You do not have permission to change account status.
          </p>
        ) : (
          <div className="mt-4 grid gap-3">
            <div className="flex flex-wrap items-end gap-2">
              {viewer.canRestrict ? (
                <>
                  <label className="ui-field" style={{ minWidth: "11rem" }}>
                    <span className="ui-label">Area to withhold</span>
                    <MenuSelect
                      ariaLabel="Area to withhold"
                      value={kind}
                      options={RESTRICTION_KINDS.map((value) => ({
                        value,
                        label: RESTRICTION_KIND_LABELS[value],
                      }))}
                      onChange={(value) => setKind(value as RestrictionKind)}
                    />
                  </label>
                  <label className="ui-field" style={{ minWidth: "11rem" }}>
                    <span className="ui-label">For how long</span>
                    <MenuSelect
                      ariaLabel="Restriction length"
                      value={durationHours === null ? "" : String(durationHours)}
                      options={RESTRICTION_DURATIONS.map((option) => ({
                        value: option.hours === null ? "" : String(option.hours),
                        label: option.label,
                      }))}
                      onChange={(value) => setDurationHours(value ? Number(value) : null)}
                    />
                  </label>
                </>
              ) : null}
            </div>

            <p className="text-xs" style={{ color: "var(--muted)" }}>
              {RESTRICTION_KIND_MEANING[kind]}
            </p>

            <div className="flex flex-wrap items-center gap-2">
              {viewer.canRestrict ? (
                <ConsequentialAction
                  label={`Restrict ${RESTRICTION_KIND_LABELS[kind].toLowerCase()}`}
                  title={STATUS_ACTION_COPY.restrict.title}
                  tone="danger"
                  currentState={ACCOUNT_STATUS_LABELS[status.value]}
                  nextState="Restricted"
                  summary={
                    <>
                      <p>{RESTRICTION_KIND_MEANING[kind]}</p>
                      <p className="mt-1">{STATUS_ACTION_COPY.restrict.preserved}</p>
                    </>
                  }
                  effects={{
                    customer: RESTRICTION_KIND_MEANING[kind],
                    financial: "None. No refund, no charge.",
                    inventory: null,
                    notification: "The person is notified, with the reason below.",
                  }}
                  reason={reason}
                  confirmLabel="Apply restriction"
                  onConfirm={({ reason: text }) =>
                    post({ action: "restrict", kind, reason: text, durationHours })
                  }
                />
              ) : null}

              {viewer.canRestrict && activeKinds.has(kind) ? (
                <ConsequentialAction
                  label={`Lift ${RESTRICTION_KIND_LABELS[kind].toLowerCase()} restriction`}
                  title={STATUS_ACTION_COPY.unrestrict.title}
                  currentState="Restricted"
                  nextState="Available again"
                  summary={
                    <>
                      <p>{STATUS_ACTION_COPY.unrestrict.effect}</p>
                      <p className="mt-1">{STATUS_ACTION_COPY.unrestrict.preserved}</p>
                    </>
                  }
                  reason={reason}
                  confirmLabel="Lift it"
                  onConfirm={({ reason: text }) => post({ action: "unrestrict", kind, reason: text })}
                />
              ) : null}

              {viewer.canSuspend && status.value !== "suspended" ? (
                <ConsequentialAction
                  label="Suspend account"
                  title={STATUS_ACTION_COPY.suspend.title}
                  tone="danger"
                  currentState={ACCOUNT_STATUS_LABELS[status.value]}
                  nextState="Suspended"
                  summary={
                    <>
                      <p>{STATUS_ACTION_COPY.suspend.effect}</p>
                      <p className="mt-1">{STATUS_ACTION_COPY.suspend.preserved}</p>
                    </>
                  }
                  effects={{
                    customer: "Cannot sign in. Existing paid orders stay visible by order link and email.",
                    financial: "None. No refund is issued and no payment is cancelled.",
                    inventory: null,
                    notification: "The person is notified, with the reason below.",
                  }}
                  reason={reason}
                  confirmLabel="Suspend this account"
                  onConfirm={({ reason: text }) => post({ action: "suspend", reason: text })}
                />
              ) : null}

              {viewer.canSuspend && status.value === "suspended" ? (
                <ConsequentialAction
                  label="Restore access"
                  title={STATUS_ACTION_COPY.unsuspend.title}
                  currentState="Suspended"
                  nextState="Can sign in"
                  summary={
                    <>
                      <p>{STATUS_ACTION_COPY.unsuspend.effect}</p>
                      <p className="mt-1">{STATUS_ACTION_COPY.unsuspend.preserved}</p>
                    </>
                  }
                  reason={reason}
                  confirmLabel="Restore access"
                  onConfirm={({ reason: text }) => post({ action: "unsuspend", reason: text })}
                />
              ) : null}
            </div>

            <p className="text-xs" style={{ color: "var(--muted)" }}>
              Standing is an application-level fact. Supabase Auth is not modified, no password is reset, and
              transactional email about paid orders keeps going out either way.
            </p>
          </div>
        )}
      </Card>
    </Section>
  );
}
