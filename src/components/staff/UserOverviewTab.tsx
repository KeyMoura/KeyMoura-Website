"use client";

import Link from "next/link";

import { Card, EmptyState, Fact, Facts, Row, Rows, Section } from "@/components/staff/StaffPage";
import { RecentActivityList } from "@/components/staff/UserWorkspaceTabs";
import { UserProfileEditor } from "@/components/staff/UserProfileEditor";
import { Badge } from "@/components/ui/DesignSystem";
import { permissionGroupViews } from "@/lib/staff/permissionGroups";
import { NOTE_CATEGORY_LABELS, type NoteCategory } from "@/lib/staff/userAccess";
import {
  ACCOUNT_STATUS_LABELS,
  ACCOUNT_STATUS_MEANING,
  formatCents,
  LOGIN_PROVIDER_LABELS,
  type LoginProvider,
} from "@/lib/staff/userDirectory";
import type { UserWorkspace } from "@/lib/staff/userWorkspace";

/**
 * Overview — a summary, and only a summary.
 *
 * What it was: an eight-row fact table, a ten-row metrics table, and a full
 * profile editor with its own Save button. Two of those three are answers to
 * questions nobody opened the page with, and the third made a summary page a
 * settings page.
 *
 * What it is: who this person is, what they have bought, what is outstanding
 * today, the last few things that happened, and the latest notes — each with a
 * link to the tab that holds all of it. Nothing here repeats a whole tab.
 *
 * ## Staff and customers get different summaries
 *
 * An administrator with no orders was previously shown ten commerce fields
 * reading `$0.00` and `—`, given the same weight as a customer's lifetime spend,
 * and nothing at all about the access that is the entire point of their account.
 * A staff account now leads with what its role reaches; a customer leads with
 * what they have bought.
 */

function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const parsed = new Date(iso);
  if (!Number.isFinite(parsed.getTime())) return "—";
  return parsed.toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" });
}

function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "Never";
  const parsed = new Date(iso);
  if (!Number.isFinite(parsed.getTime())) return "Never";
  return parsed.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** "1 year, 7 months" — the question "how long have they been with us". */
function accountAge(iso: string): string {
  const start = new Date(iso).getTime();
  if (!Number.isFinite(start)) return "—";
  const days = Math.max(0, Math.floor((Date.now() - start) / 86_400_000));
  if (days < 31) return days <= 1 ? "New today" : `${days} days`;
  const months = Math.floor(days / 30);
  if (months < 12) return months === 1 ? "1 month" : `${months} months`;
  const years = Math.floor(days / 365);
  const rest = Math.floor((days - years * 365) / 30);
  return `${years} ${years === 1 ? "year" : "years"}${rest ? `, ${rest} ${rest === 1 ? "month" : "months"}` : ""}`;
}

export function UserOverviewTab({
  workspace,
  auth,
  onOpenTab,
  onChanged,
}: {
  workspace: UserWorkspace;
  auth: { token: string };
  onOpenTab: (id: string) => void;
  onChanged: () => void;
}) {
  const { user, metrics, status, latestOrder, viewer } = workspace;

  const areas = workspace.rolePermissions
    ? permissionGroupViews({
        rolePermissions: new Set(workspace.rolePermissions[user.roleKey] ?? []),
        overrides: new Set(workspace.permissionOverrides ?? []),
      })
        .filter((group) => group.heldCount > 0)
        .map((group) => group.label)
    : null;

  const summary = (
    <Section headingLevel={3} title={user.isStaff ? "Staff summary" : "Customer summary"}>
      <Card>
        <Facts>
          <Fact label="With KeyMoura">
            {accountAge(user.createdAt)}
            <span className="block text-xs" style={{ color: "var(--muted)" }}>
              since {formatDate(user.createdAt)}
            </span>
          </Fact>
          <Fact label="Last activity">{formatDateTime(user.lastSeenAt)}</Fact>
          <Fact label="Role">
            <span className="flex flex-wrap items-center gap-2">
              {user.roleName}
              <Badge tone={user.isStaff ? "accent" : "neutral"}>{user.isStaff ? "Staff" : "Customer"}</Badge>
            </span>
          </Fact>
          <Fact label="Account status">
            <span className="block">{ACCOUNT_STATUS_LABELS[status.value]}</span>
            <span className="block text-xs" style={{ color: "var(--muted)" }}>
              {ACCOUNT_STATUS_MEANING[status.value]}
            </span>
          </Fact>
          <Fact label="Signs in with">
            {user.providers.length ? (
              <span className="flex flex-wrap gap-1.5">
                {user.providers.map((provider) => (
                  <Badge key={provider} tone="neutral">
                    {LOGIN_PROVIDER_LABELS[provider as LoginProvider] ?? provider}
                  </Badge>
                ))}
              </span>
            ) : (
              "—"
            )}
          </Fact>
          {user.isStaff ? (
            <Fact label="Can reach">
              {areas === null ? (
                <span style={{ color: "var(--muted)" }}>Not shown</span>
              ) : areas.length ? (
                areas.join(", ")
              ) : (
                <span style={{ color: "var(--muted)" }}>Nothing yet</span>
              )}
            </Fact>
          ) : null}
        </Facts>

        <p className="mt-3 text-xs">
          <button type="button" className="underline" onClick={() => onOpenTab("access")} style={{ color: "var(--muted)" }}>
            Manage access →
          </button>
        </p>
      </Card>
    </Section>
  );

  const commerce = (
    <Section
      headingLevel={3}
      title="Commerce"
      description="Money actually received on orders this account owns, less refunds. Unpaid quotes, abandoned checkouts and guest orders are not counted."
      actions={
        metrics.orderCount > 0 ? (
          <button type="button" className="ui-chip" onClick={() => onOpenTab("orders")}>
            View all orders
          </button>
        ) : null
      }
    >
      <Card>
        {metrics.orderCount === 0 ? (
          <p className="text-sm" style={{ color: "var(--muted)" }}>
            {user.isStaff
              ? "No orders. This is a staff account."
              : "This account has not placed an order yet."}
          </p>
        ) : (
          <>
            <Facts>
              <Fact label="Lifetime spend">
                <span className="text-lg tabular-nums">{formatCents(metrics.netSpendCents)}</span>
              </Fact>
              <Fact label="Orders">{metrics.orderCount}</Fact>
              <Fact label="Average order">
                {metrics.averageOrderValueCents === null ? "—" : formatCents(metrics.averageOrderValueCents)}
              </Fact>
              <Fact label="Refunded">{formatCents(metrics.refundedCents)}</Fact>
              <Fact label="Latest order">
                {latestOrder ? (
                  <Link href={`/staff/orders/${latestOrder.id}`} className="underline">
                    {latestOrder.orderNumber ?? "Open it"}
                  </Link>
                ) : (
                  formatDate(metrics.lastOrderAt)
                )}
              </Fact>
            </Facts>
            {workspace.possibleGuestOrderCount > 0 ? (
              <p className="mt-3 text-xs" style={{ color: "var(--muted)" }}>
                {workspace.possibleGuestOrderCount} guest{" "}
                {workspace.possibleGuestOrderCount === 1 ? "order was" : "orders were"} placed with this email address.
                They are not part of this account and are excluded from every figure above — see Orders.
              </p>
            ) : null}
          </>
        )}
      </Card>
    </Section>
  );

  const outstanding =
    metrics.openOrderCount > 0 || metrics.openProductionCount > 0 || (workspace.openSupportCount ?? 0) > 0 ? (
      <Section headingLevel={3} title="Needs attention">
        <Card>
          <Facts>
            {metrics.openOrderCount > 0 ? (
              <Fact label="Open orders">
                <button type="button" className="underline" onClick={() => onOpenTab("orders")}>
                  {metrics.openOrderCount}
                </button>
              </Fact>
            ) : null}
            {metrics.openProductionCount > 0 ? (
              <Fact label="In production">{metrics.openProductionCount}</Fact>
            ) : null}
            {(workspace.openSupportCount ?? 0) > 0 ? (
              <Fact label="Open support">
                <button type="button" className="underline" onClick={() => onOpenTab("support")}>
                  {workspace.openSupportCount}
                </button>
              </Fact>
            ) : null}
          </Facts>
        </Card>
      </Section>
    ) : null;

  return (
    <>
      {user.isStaff ? summary : commerce}
      {user.isStaff ? commerce : summary}
      {outstanding}

      {viewer.canViewNotes ? (
        <Section
          headingLevel={3}
          title="Internal notes"
          description="Staff only. Never shown to the customer."
          actions={
            <button type="button" className="ui-chip" onClick={() => onOpenTab("notes")}>
              {viewer.canWriteNotes ? "Add a note" : "View all notes"}
            </button>
          }
        >
          {workspace.recentNotes === null ? (
            <EmptyState>Notes are not shown for this account.</EmptyState>
          ) : workspace.recentNotes.length === 0 ? (
            <EmptyState>No internal notes yet.</EmptyState>
          ) : (
            <Rows>
              {workspace.recentNotes.map((note) => (
                <Row
                  key={note.id}
                  title={<span className="whitespace-pre-wrap font-normal">{note.body}</span>}
                  meta={`${note.authorLabel} · ${formatDateTime(note.createdAt)}`}
                  aside={
                    <Badge tone={note.category === "warning" ? "danger" : "neutral"}>
                      {NOTE_CATEGORY_LABELS[note.category as NoteCategory] ?? note.category}
                    </Badge>
                  }
                />
              ))}
            </Rows>
          )}
        </Section>
      ) : null}

      {viewer.canViewActivity ? (
        <Section
          headingLevel={3}
          title="Recent activity"
          actions={
            <button type="button" className="ui-chip" onClick={() => onOpenTab("activity")}>
              View full activity
            </button>
          }
        >
          <RecentActivityList userId={user.id} auth={auth} />
        </Section>
      ) : null}

      <UserProfileEditor
        userId={user.id}
        token={auth.token}
        initial={{
          username: user.username,
          displayName: user.displayName,
          bio: user.bio,
          location: user.location,
          email: user.email,
          avatarUrl: user.avatarUrl,
          isVerified: user.isVerified,
          donationRank: user.donationRank,
        }}
        canEditProfile={viewer.canEditProfile}
        canVerify={viewer.canVerify}
        canSetDonationRank={viewer.canSetDonationRank}
        onChanged={onChanged}
      />
    </>
  );
}
