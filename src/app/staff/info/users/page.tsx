import { redirect } from "next/navigation";

/**
 * Legacy route.
 *
 * User management lives at /staff/users. This previously forwarded to
 * /staff/security/users, which is itself now a redirect — pointing straight at
 * the destination avoids making a browser take two hops.
 */
export default function StaffInfoUsersRedirect() {
  redirect("/staff/users");
}
