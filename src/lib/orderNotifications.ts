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

export async function notifyOrderStaff(input: Omit<OrderNotification, "recipientUserId" | "staff">) {
  const [{ data: rolePermissions }, { data: directPermissions }] = await Promise.all([
    supabaseAdmin.from("role_permissions").select("role_key").eq("permission_key", "orders.manage"),
    supabaseAdmin.from("user_permissions").select("user_id").eq("permission_key", "orders.manage").eq("allowed", true),
  ]);

  const roles = [...new Set((rolePermissions ?? []).map((row) => row.role_key).filter(Boolean))];
  const directIds = (directPermissions ?? []).map((row) => row.user_id).filter(Boolean);
  const { data: roleUsers } = roles.length
    ? await supabaseAdmin.from("user_roles").select("user_id").in("role", roles)
    : { data: [] };
  const recipients = [...new Set([...(roleUsers ?? []).map((row) => row.user_id), ...directIds])]
    .filter((id): id is string => typeof id === "string" && id !== input.actorUserId);

  await Promise.all(recipients.map((recipientUserId) => notifyOrderUser({
    ...input,
    recipientUserId,
    staff: true,
  })));
}
