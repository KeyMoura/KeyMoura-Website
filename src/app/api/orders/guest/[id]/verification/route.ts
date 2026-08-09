import { NextRequest, NextResponse } from "next/server";
import { sendCommerceEmail } from "@/lib/commerceEmail";
import { GUEST_ORDER_COOKIE, guestOrderCookieOptions } from "@/lib/commerce/guestOrders";
import {
  ensureGuestCode,
  issueGuestCode,
  verifyGuestCode,
  GUEST_CODE_RESEND_SECONDS,
} from "@/lib/commerce/guestOrderVerification";

/**
 * Requesting and answering the guest order challenge.
 *
 * `POST` asks for a code, `PUT` answers one. They are the same resource because
 * they are the same thing — the challenge on this order — and splitting them
 * across two paths would only invite one to be secured and the other forgotten.
 *
 * ## What the responses deliberately do not say
 *
 * Every failure that is not a misconfiguration answers with the same sentence.
 * An order id that does not exist, an order that belongs to an account, and an
 * order whose email is missing are all "we could not send a code", because
 * telling them apart turns this endpoint into an oracle for which order ids are
 * real. The one distinction drawn is the resend cooldown, which the customer
 * can act on and which they already know about from the countdown on the page.
 *
 * A response body never carries the code, the session token, or anything about
 * the server's configuration. The token leaves only as `Set-Cookie`.
 */

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const GENERIC = { error: "We could not send a code. Please try again in a moment." };
/**
 * Said when the HMAC secret is absent.
 *
 * It names no environment variable and implies no defect — an operator reads
 * the cause in the server log, and the customer reads something true and
 * actionable. It fails closed: no order is exposed as a consolation prize.
 */
const UNCONFIGURED = {
  error: "Order verification is temporarily unavailable. Please try again shortly or contact support.",
  reason: "unavailable" as const,
};

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!uuid.test(id)) return NextResponse.json(GENERIC, { status: 400 });

  // The page's own first load asks to *ensure* a challenge exists, which sends
  // nothing when a usable one already does. Only the customer pressing "send a
  // new code" replaces it, and that is what the cooldown governs.
  const body = (await req.json().catch(() => ({}))) as { resend?: unknown };
  const wantsNew = body.resend === true;

  const issued = wantsNew ? await issueGuestCode(id) : await ensureGuestCode(id);

  if (!issued.ok) {
    if (issued.reason === "not_configured") return NextResponse.json(UNCONFIGURED, { status: 503 });
    if (issued.reason === "cooldown") {
      return NextResponse.json(
        { error: `Please wait ${GUEST_CODE_RESEND_SECONDS} seconds before requesting another code.`, reason: "cooldown" },
        { status: 429 }
      );
    }
    return NextResponse.json(GENERIC, { status: 400 });
  }

  // Already covered by a live challenge. The page still learns where to look,
  // which is the whole reason a refresh is not simply a no-op.
  if (!issued.sent) {
    return NextResponse.json({ sent: false, alreadySent: true, maskedEmail: issued.maskedEmail });
  }

  const sent = await sendCommerceEmail({
    to: issued.email,
    orderId: id,
    templateKey: "guest_order_access",
    // One key per challenge, so a retried request cannot deliver a second copy
    // of the same code.
    eventKey: `guest-access-${issued.challengeId}`,
    variables: {
      customer_name: "there",
      order_label: "Order access",
      product_name: "",
      status: "",
      price: "",
      verification_code: issued.code,
    },
  });

  if (!sent.sent && !sent.suppressed) return NextResponse.json(GENERIC, { status: 503 });
  return NextResponse.json({ sent: true, maskedEmail: issued.maskedEmail });
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const invalid = { error: "That code is not right. Check the digits and try again.", reason: "invalid" };
  if (!uuid.test(id)) return NextResponse.json(invalid, { status: 400 });

  const body = (await req.json().catch(() => ({}))) as { code?: unknown };
  const result = await verifyGuestCode(id, typeof body.code === "string" ? body.code : "");

  if (!result.ok) {
    if (result.reason === "not_configured") return NextResponse.json(UNCONFIGURED, { status: 503 });
    const message =
      result.reason === "expired"
        ? "That code has expired. Send a new code to continue."
        : result.reason === "attempt_limit"
          ? "Too many incorrect attempts. Send a new code to continue."
          : result.reason === "consumed"
            ? "That code has already been used. Send a new code to continue."
            : invalid.error;
    return NextResponse.json({ error: message, reason: result.reason }, { status: 400 });
  }

  const response = NextResponse.json({ verified: true });
  response.cookies.set(GUEST_ORDER_COOKIE, result.token, guestOrderCookieOptions());
  return response;
}
