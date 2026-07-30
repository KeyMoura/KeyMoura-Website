import { redirect } from "next/navigation";

/**
 * Moderation landing.
 *
 * Keep this as a stable entry point; route to the primary moderation queue.
 */
export default function StaffModerationPage() {
  redirect("/staff/moderation/reports");
}
