import "server-only";

/**
 * Cloudflare Turnstile verification, when it is configured.
 *
 * `/staff/integrations` has reported Turnstile's configuration state since
 * pass 12 and nothing has ever verified a token — the keys were tracked and
 * unused. This is the verifier, wired into the surfaces a stranger can reach
 * without an account.
 *
 * ## Fail-open when unconfigured, fail-closed when configured
 *
 * With no `TURNSTILE_SECRET_KEY` this returns `configured: false` and allows
 * the request. That is the honest behaviour for a control the owner has not
 * turned on: refusing every guest request because a key is missing would take
 * the shop's front door off its hinges to protect it.
 *
 * Once the secret *is* set, a missing or invalid token is refused. There is no
 * middle state, and in particular no "allow on network error" — a verifier
 * that fails open under load is a verifier an attacker can create load
 * against. A Cloudflare outage refusing guest submissions is a bad hour; a
 * verifier that can be switched off by flooding it is a bad design.
 *
 * The token is never logged. It is a one-time credential, but it is also
 * attacker-supplied text and there is no reason for it to reach a log line.
 */

const VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

export type TurnstileResult =
  | { ok: true; configured: boolean }
  | { ok: false; configured: true; reason: "missing" | "invalid" | "unavailable" };

export function turnstileConfigured(): boolean {
  return Boolean(process.env.TURNSTILE_SECRET_KEY);
}

export async function verifyTurnstile(
  token: unknown,
  remoteIp: string | null = null
): Promise<TurnstileResult> {
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) return { ok: true, configured: false };

  if (typeof token !== "string" || !token.trim() || token.length > 2048) {
    return { ok: false, configured: true, reason: "missing" };
  }

  const body = new URLSearchParams({ secret, response: token.trim() });
  if (remoteIp) body.set("remoteip", remoteIp);

  try {
    const response = await fetch(VERIFY_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
      // Bounded: an unbounded verification call turns a Cloudflare slowdown
      // into this route's slowdown.
      signal: AbortSignal.timeout(6000),
    });
    if (!response.ok) return { ok: false, configured: true, reason: "unavailable" };
    const payload = (await response.json()) as { success?: boolean };
    return payload.success === true
      ? { ok: true, configured: true }
      : { ok: false, configured: true, reason: "invalid" };
  } catch {
    return { ok: false, configured: true, reason: "unavailable" };
  }
}

/** The sentence to show. Never the provider's error codes, which name nothing useful. */
export function turnstileMessage(result: Extract<TurnstileResult, { ok: false }>): string {
  return result.reason === "unavailable"
    ? "We could not complete the security check just now. Please try again in a moment."
    : "Please complete the security check and try again.";
}
