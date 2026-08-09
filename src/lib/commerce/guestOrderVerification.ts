import "server-only";

import { createHmac, randomInt, timingSafeEqual } from "node:crypto";
import { routeServiceClient } from "@/lib/api/routeAuth";
import { createGuestOrderToken, guestAccessExpiry, hashGuestOrderToken } from "@/lib/commerce/guestOrders";

export const GUEST_CODE_TTL_SECONDS = 15 * 60;
export const GUEST_CODE_RESEND_SECONDS = 60;
export const GUEST_CODE_MAX_ATTEMPTS = 5;

const secret = () => process.env.GUEST_ORDER_VERIFICATION_SECRET || "";

export function createGuestVerificationCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, "0");
}

export function digestGuestVerificationCode(orderId: string, code: string): string {
  const key = secret();
  if (!key) throw new Error("Guest order verification is not configured");
  return createHmac("sha256", key).update(`keymoura.guest-order-code.v1:${orderId}:${code}`).digest("base64url");
}

export function verificationDigestMatches(orderId: string, code: string, stored: string): boolean {
  const actual = Buffer.from(digestGuestVerificationCode(orderId, code));
  const expected = Buffer.from(stored);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function maskGuestEmail(email: string): string {
  const [local, domain] = email.split("@");
  return `${local.slice(0, 1)}${"•".repeat(Math.max(4, Math.min(local.length - 1, 8)))}@${domain}`;
}

export async function issueGuestCode(orderId: string) {
  const orderResult = await routeServiceClient.from("orders").select("customer_id,guest_email").eq("id", orderId).maybeSingle();
  const order = orderResult.data as { customer_id: string | null; guest_email: string | null } | null;
  if (orderResult.error || !order || order.customer_id || !order.guest_email) return { ok: false as const, reason: "unavailable" as const };

  const code = createGuestVerificationCode();
  const result = await routeServiceClient.rpc("replace_guest_order_access_code", {
    p_order_id: orderId,
    p_code_digest: digestGuestVerificationCode(orderId, code),
    p_expires_at: new Date(Date.now() + GUEST_CODE_TTL_SECONDS * 1000).toISOString(),
    p_cooldown_seconds: GUEST_CODE_RESEND_SECONDS,
  });
  if (result.error) return { ok: false as const, reason: result.error.code === "P0001" ? "cooldown" as const : "unavailable" as const };
  return { ok: true as const, code, challengeId: String(result.data), email: order.guest_email, maskedEmail: maskGuestEmail(order.guest_email) };
}

export type VerificationResult =
  | { ok: true; token: string }
  | { ok: false; reason: "invalid" | "expired" | "consumed" | "attempt_limit" | "unavailable" };

export async function verifyGuestCode(orderId: string, code: string): Promise<VerificationResult> {
  if (!/^\d{6}$/.test(code)) return { ok: false, reason: "invalid" };
  const found = await routeServiceClient.from("guest_order_access_codes")
    .select("id,code_digest,expires_at,consumed_at,failed_attempts")
    .eq("order_id", orderId).order("created_at", { ascending: false }).limit(1).maybeSingle();
  const row = found.data as { id: string; code_digest: string; expires_at: string; consumed_at: string | null; failed_attempts: number } | null;
  if (found.error || !row) return { ok: false, reason: "invalid" };
  if (row.consumed_at) return { ok: false, reason: "consumed" };
  if (row.failed_attempts >= GUEST_CODE_MAX_ATTEMPTS) return { ok: false, reason: "attempt_limit" };
  if (Date.parse(row.expires_at) <= Date.now()) return { ok: false, reason: "expired" };
  if (!verificationDigestMatches(orderId, code, row.code_digest)) {
    await routeServiceClient.rpc("record_guest_order_code_failure", { p_code_id: row.id, p_max_attempts: GUEST_CODE_MAX_ATTEMPTS });
    return { ok: false, reason: "invalid" };
  }

  const token = createGuestOrderToken();
  const consumed = await routeServiceClient.rpc("consume_guest_order_access_code", {
    p_code_id: row.id, p_order_id: orderId, p_session_digest: hashGuestOrderToken(token), p_session_expires_at: guestAccessExpiry(),
  });
  if (consumed.error || consumed.data !== true) return { ok: false, reason: "consumed" };
  return { ok: true, token };
}
