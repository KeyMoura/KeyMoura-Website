import { redirect } from "next/navigation";

/**
 * The security audit page moved to `/staff/audit`.
 *
 * It is not kept alongside the new one. This page read `audit_logs` directly
 * from the browser as `authenticated`, which held no SELECT grant — so every
 * read failed with `42501` and, because the rejection was swallowed by a
 * `load()` with a `finally` and no `catch`, it rendered "No audit events found"
 * over a table that had forty-six of them. It also filtered and sorted in the
 * browser over whatever it had managed to fetch, which was never going to
 * survive a log that grows by a row per staff action.
 *
 * Two audit pages would mean two definitions of what an event means. This is a
 * redirect so existing bookmarks and the staff nav both land on the one that
 * works.
 */
export default function StaffSecurityAuditRedirect() {
  redirect("/staff/audit");
}
