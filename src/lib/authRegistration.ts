export type RegistrationPolicy = { allowSignup: boolean };

export type PolicyResult =
  | { available: true; policy: RegistrationPolicy }
  | { available: false };

/** Treat anything other than an explicit, well-formed policy as unavailable. */
export function readRegistrationPolicy(row: { auth_config?: unknown } | null): PolicyResult {
  const config = row?.auth_config;
  if (!config || typeof config !== "object" || Array.isArray(config)) return { available: false };
  const allowSignup = (config as Record<string, unknown>).allowSignup;
  if (typeof allowSignup !== "boolean") return { available: false };
  return { available: true, policy: { allowSignup } };
}

export function registrationPolicyResponse(result: PolicyResult): { allowSignup: boolean } {
  return { allowSignup: result.available ? result.policy.allowSignup : false };
}

export function closedRegistrationAction(input: { queuedForReview: boolean; provenNewClosedCandidate: boolean }): "pending_review" | "delete" | "reject" {
  if (input.queuedForReview) return "pending_review";
  return input.provenNewClosedCandidate ? "delete" : "reject";
}

/**
 * Accept a same-application path only. Every encoded layer is checked because URL
 * consumers may decode it again after this callback has redirected.
 */
export function safeLocalRedirectPath(value: unknown): string {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//")) return "/";
  let decoded = value;
  try {
    for (let index = 0; index < 5; index += 1) {
      if (/[\u0000-\u001f\u007f]/.test(decoded) || decoded.includes("\\") || decoded.startsWith("//")) return "/";
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    }
  } catch {
    return "/";
  }
  if (!decoded.startsWith("/") || decoded.startsWith("//") || decoded.includes("\\")) return "/";
  return value;
}

export function approvedAuthRedirect(redirectTo: unknown, publicUrl: unknown): string | undefined {
  if (typeof redirectTo !== "string" || typeof publicUrl !== "string") return undefined;
  try {
    const requested = new URL(redirectTo);
    const configured = new URL(publicUrl);
    if (!/^https?:$/.test(configured.protocol) || requested.origin !== configured.origin) return undefined;
    if (requested.pathname !== "/auth/callback" || requested.search || requested.hash) return undefined;
    return requested.toString();
  } catch {
    return undefined;
  }
}
