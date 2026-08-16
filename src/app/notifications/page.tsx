import { permanentRedirect } from "next/navigation";

/**
 * Notifications moved to /account/notifications.
 *
 * Same reasoning as `/orders`: it is an account section, it is listed in the
 * account's own navigation, and at the site root it was the one tab that
 * navigated out of the shell that offered it. Notification emails and the
 * in-app bell have both linked here for a long time, so the old path keeps
 * working rather than 404ing.
 */
export default function LegacyNotifications(): never {
  permanentRedirect("/account/notifications");
}
