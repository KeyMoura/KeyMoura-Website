import { redirect } from "next/navigation";

/**
 * `/contact` is now `/support`.
 *
 * A redirect rather than a second page, for the reason `/staff/security/audit`
 * and `/staff/security/users` became redirects in the two passes before this:
 * two "ask us a question" surfaces would mean two definitions of what a customer
 * question *is*, and only one of them would have a status, an owner and a
 * history.
 *
 * The link is kept working rather than removed. `/contact` is on the homepage,
 * the catalog, the order pages, the design guide and in site search, and it is
 * in whatever people have bookmarked and printed.
 */
export default function ContactPage() {
  redirect("/support");
}
