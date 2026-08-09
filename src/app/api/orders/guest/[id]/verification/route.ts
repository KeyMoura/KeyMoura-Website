import { NextRequest, NextResponse } from "next/server";
import { sendCommerceEmail } from "@/lib/commerceEmail";
import { GUEST_ORDER_COOKIE, GUEST_ORDER_COOKIE_MAX_AGE } from "@/lib/commerce/guestOrders";
import { issueGuestCode, verifyGuestCode } from "@/lib/commerce/guestOrderVerification";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const generic = { error: "We could not send a code. Please wait and try again." };

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!uuid.test(id)) return NextResponse.json(generic, { status: 400 });
  const issued = await issueGuestCode(id);
  if (!issued.ok) return NextResponse.json(generic, { status: issued.reason === "cooldown" ? 429 : 400 });
  const sent = await sendCommerceEmail({
    to: issued.email, orderId: id, templateKey: "guest_order_access", eventKey: `guest-access-${issued.challengeId}`,
    variables: { customer_name: "Customer", order_label: "View your order", product_name: "", status: "", price: "", verification_code: issued.code },
  });
  if (!sent.sent) return NextResponse.json(generic, { status: 503 });
  return NextResponse.json({ sent: true, maskedEmail: issued.maskedEmail });
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!uuid.test(id)) return NextResponse.json({ error: "Invalid verification code.", reason: "invalid" }, { status: 400 });
  const body = await req.json().catch(() => ({})) as { code?: unknown };
  const result = await verifyGuestCode(id, typeof body.code === "string" ? body.code : "");
  if (!result.ok) {
    const message = result.reason === "expired" ? "That code has expired. Send a new code." : result.reason === "attempt_limit" ? "Too many attempts. Send a new code." : "Invalid verification code.";
    return NextResponse.json({ error: message, reason: result.reason }, { status: 400 });
  }
  const response = NextResponse.json({ verified: true });
  response.cookies.set(GUEST_ORDER_COOKIE, result.token, { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/", maxAge: GUEST_ORDER_COOKIE_MAX_AGE });
  return response;
}
