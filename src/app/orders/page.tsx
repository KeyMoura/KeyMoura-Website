import { permanentRedirect } from "next/navigation";

/**
 * The order *list* moved to /account/orders.
 *
 * Order history is account information — it sits beside the profile, the
 * support threads and the notifications, and it is the one a customer reaches
 * from the account menu. Living at the site root meant `/account`'s own
 * navigation offered "Orders & projects" as a tab and then navigated *out* of
 * the account shell, so the tabs vanished the moment somebody used them. The
 * same was true of Notifications.
 *
 * Individual orders deliberately did **not** move. `/orders/[id]` is the
 * canonical order URL: it is what confirmation and status emails link to, it is
 * where `/orders/guest/[id]` sits beside it for customers who never made an
 * account, and `/orders/new` is the entry point for a custom project. Moving
 * those under `/account` would put a guest's order behind a path that says it
 * belongs to an account they do not have, and would invalidate every order link
 * already sent by email for no gain.
 *
 * Permanent rather than temporary, matching `/info` → `/projects`: this is a
 * rename, not an experiment, and bookmarks and inbound links should be updated
 * by whatever follows them.
 */
export default function LegacyOrderHistory(): never {
  permanentRedirect("/account/orders");
}
