import "server-only";

import { createNotification } from "@/lib/notifications";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

type OrderNotification = {
  orderId: string;
  actorUserId: string | null;
  recipientUserId: string;
  title: string;
  message: string;
  staff?: boolean;
};

export async function notifyOrderUser(input: OrderNotification) {
  await createNotification({
    recipientUserId: input.recipientUserId,
    actorUserId: input.actorUserId,
    type: "order",
    bypassBlock: true,
    payload: {
      title: input.title,
      message: input.message,
      href: input.staff ? `/staff/orders/${input.orderId}` : `/orders/${input.orderId}`,
      order_id: input.orderId,
    },
  });
}

/**
 * Which staff hold a permission, by role grant or by direct grant.
 *
 * Extracted so notifications about things that are not orders — a product
 * running out of stock, say — reach the right people through the *same*
 * resolution rule rather than through a second, drifting copy of it. The actor
 * is excluded: telling someone about the thing they just did is noise.
 */
export async function resolveStaffRecipients(
  permissionKey: string,
  actorUserId: string | null
): Promise<string[]> {
  const [{ data: rolePermissions }, { data: directPermissions }] = await Promise.all([
    supabaseAdmin.from("role_permissions").select("role_key").eq("permission_key", permissionKey),
    supabaseAdmin.from("user_permissions").select("user_id").eq("permission_key", permissionKey).eq("allowed", true),
  ]);

  const roles = [...new Set((rolePermissions ?? []).map((row) => row.role_key).filter(Boolean))];
  const directIds = (directPermissions ?? []).map((row) => row.user_id).filter(Boolean);
  const { data: roleUsers } = roles.length
    ? await supabaseAdmin.from("user_roles").select("user_id").in("role", roles)
    : { data: [] };
  return [...new Set([...(roleUsers ?? []).map((row) => row.user_id), ...directIds])]
    .filter((id): id is string => typeof id === "string" && id !== actorUserId);
}

export async function notifyOrderStaff(input: Omit<OrderNotification, "recipientUserId" | "staff">) {
  const recipients = await resolveStaffRecipients("orders.manage", input.actorUserId);
  await Promise.all(recipients.map((recipientUserId) => notifyOrderUser({
    ...input,
    recipientUserId,
    staff: true,
  })));
}

/**
 * A staff notification that is not about an order.
 *
 * Deliberately routed through `createNotification` with the same `type` and
 * shape the order notifications use, so it lands in the one notification
 * centre staff already read rather than in a parallel inbox. `href` is supplied
 * by the caller because the deep link is the whole point of the alert.
 */
export async function notifyStaffByPermission(input: {
  permissionKey: string;
  actorUserId: string | null;
  title: string;
  message: string;
  href: string;
}) {
  const recipients = await resolveStaffRecipients(input.permissionKey, input.actorUserId);
  await Promise.all(
    recipients.map((recipientUserId) =>
      createNotification({
        recipientUserId,
        actorUserId: input.actorUserId,
        type: "order",
        bypassBlock: true,
        payload: { title: input.title, message: input.message, href: input.href },
      })
    )
  );
}
