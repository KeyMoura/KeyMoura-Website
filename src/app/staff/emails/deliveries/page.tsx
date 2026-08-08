import { redirect } from "next/navigation";

/**
 * The delivery log is a tab of `/staff/emails`, not a page of its own.
 *
 * It lived here, one menu click away from the templates it exists to debug: you
 * edited the wording of the shipping email in one place and found out whether
 * it had reached anybody in another. The route is kept and redirects, because
 * it is linked from the ledger, from staff bookmarks, and from the sidebar's
 * `alsoOwns` entry — a consolidated route that 404s is a worse outcome than the
 * split it replaced.
 */
export default function EmailDeliveriesPage() {
  redirect("/staff/emails#deliveries");
}
