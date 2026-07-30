import { redirect } from "next/navigation";

/**
 * Legacy route.
 *
 * User management lives in /staff/security/users.
 */
export default function StaffInfoUsersRedirect() {
  redirect("/staff/security/users");
}
