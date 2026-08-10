import { redirect } from "next/navigation";

/**
 * Legacy route.
 *
 * User management moved to `/staff/users`, which is a directory plus a
 * per-user workspace rather than one 1,500-line page. Everything this page did
 * — role assignment, permission overrides, verification, donation rank, profile
 * editing, restrictions and suspension — is on the workspace, alongside the
 * orders, spend, production, communications and audit history it never showed.
 *
 * A redirect rather than a second page, for the reason `/staff/security/audit`
 * became one: two user pages would mean two definitions of what a user is, and
 * two places to change when one of them is wrong.
 */
export default function StaffSecurityUsersRedirect() {
  redirect("/staff/users");
}
