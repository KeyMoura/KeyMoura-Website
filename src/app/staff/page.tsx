import { redirect } from "next/navigation";

/**
 * Staff landing.
 *
 * The left-side Staff navigation is the primary entrypoint. This route exists
 * only as a stable landing URL and immediately redirects to the main staff area.
 */
export default function StaffLandingPage() {
  redirect("/staff/moderation/reports");
}
