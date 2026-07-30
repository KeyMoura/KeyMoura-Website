// src/lib/notifications.ts
import "server-only";

import { supabaseAdmin } from "@/lib/supabaseAdmin";

export type NotificationType =
  | "reply"
  | "mention"
  | "accepted"
  | "accepted_answer"
  | "vote"
  | "garage_like"
  | "broadcast"
  | "admin_approval"
  | "report_update"
  | "moderation";

export type CreateNotificationArgs = {
  recipientUserId: string;
  actorUserId: string;
  type: NotificationType;
  threadId?: number | null;
  postId?: number | null;
  payload?: Record<string, unknown> | null;
  /**
   * When true, skip user block checks.
   * Use sparingly for system-critical notifications (e.g. moderation/report updates).
   */
  bypassBlock?: boolean;
};

/**
 * Returns true if either user has blocked the other.
 */
export async function isBlockedEitherDirection(
  aUserId: string,
  bUserId: string
): Promise<boolean> {
  if (!aUserId || !bUserId) return false;
  if (aUserId === bUserId) return false;

  const { data, error } = await supabaseAdmin
    .from("user_blocks")
    .select("id")
    .or(
      `and(blocker_user_id.eq.${aUserId},blocked_user_id.eq.${bUserId}),and(blocker_user_id.eq.${bUserId},blocked_user_id.eq.${aUserId})`
    )
    .limit(1);

  if (error) {
    // Fail closed (skip notifications) if block check fails
    console.error("isBlockedEitherDirection error", error);
    return true;
  }

  return (data?.length ?? 0) > 0;
}

/**
 * Single server-side helper for inserting notifications.
 * Enforces: no self-notifs, skip if blocked either direction.
 */
export async function createNotification(args: CreateNotificationArgs) {
  const { recipientUserId, actorUserId, type, threadId, postId, payload, bypassBlock } = args;

  if (!recipientUserId || !actorUserId) return;
  if (recipientUserId === actorUserId) return;

  if (!bypassBlock) {
    const blocked = await isBlockedEitherDirection(recipientUserId, actorUserId);
    if (blocked) return;
  }

  const { error } = await supabaseAdmin.from("notifications").insert({
    user_id: recipientUserId,
    actor_user_id: actorUserId,
    type,
    thread_id: threadId ?? null,
    post_id: postId ?? null,
    payload: payload ?? null,
    is_read: false,
  });

  if (error) {
    console.error("createNotification insert error", error);
  }
}

export type BroadcastNotificationArgs = {
  /** When null, the notification is considered a system/server announcement. */
  actorUserId: string | null;
  /** A short headline shown in the notifications UI. */
  title: string;
  /** Optional body/preview text. */
  message?: string | null;
  /** Optional deep-link metadata for the client to route. */
  href?: string | null;
};

/**
 * Admin-only helper for sending a notification to every user.
 *
 * NOTE: This intentionally does NOT apply user block checks. Broadcasts are
 * considered system notifications and should reach all users.
 */
export async function createBroadcastNotification(args: BroadcastNotificationArgs) {
  const { actorUserId, title, message, href } = args;
  const cleanTitle = (title ?? "").trim();
  const cleanMessage = (message ?? "").trim();

  if (!cleanTitle) return;

  const { data: users, error: usersErr } = await supabaseAdmin
    .from("profiles")
    .select("id");

  if (usersErr) {
    console.error("createBroadcastNotification users select error", usersErr);
    return;
  }

  const ids = (users ?? [])
    .map((u) => {
      const id = (u as { id?: unknown } | null)?.id;
      return typeof id === "string" ? id : null;
    })
    .filter((v): v is string => !!v);

  if (ids.length === 0) return;

  const payloadBase: Record<string, unknown> = {
    title: cleanTitle,
  };
  if (cleanMessage) payloadBase.message = cleanMessage;
  if (href && typeof href === "string" && href.trim()) {
    payloadBase.href = href.trim();
  }

  // Insert in chunks to avoid payload limits.
  const chunkSize = 500;
  for (let i = 0; i < ids.length; i += chunkSize) {
    const chunk = ids.slice(i, i + chunkSize);
    const rows = chunk.map((userId) => ({
      user_id: userId,
      actor_user_id: actorUserId,
      type: "broadcast" satisfies NotificationType,
      thread_id: null,
      post_id: null,
      payload: payloadBase,
      is_read: false,
    }));

    const { error: insertErr } = await supabaseAdmin
      .from("notifications")
      .insert(rows);
    if (insertErr) {
      console.error("createBroadcastNotification insert error", insertErr);
      // Continue attempting remaining chunks.
    }
  }
}

/**
 * Extract @mentions from markdown/text. Returns unique lowercased usernames.
 * NOTE: This assumes your usernames are stored in profiles.username.
 */
export function extractMentionUsernames(input: string): string[] {
  const s = (input ?? "").trim();
  if (!s) return [];

  // @username (letters/numbers/underscore/dot) — tweak if your username rules differ
  const re = /(^|[^\w@])@([a-zA-Z0-9_\.]{2,32})\b/g;
  const out = new Set<string>();

  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    const u = (m[2] ?? "").trim();
    if (u) out.add(u.toLowerCase());
  }

  return Array.from(out);
}
