import "server-only";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const INSTALL_COOKIE = "sca_install_session";
const ttlSeconds = 30 * 60;

function secret(): string {
  const value = process.env.INSTALL_TOKEN;
  if (!value || value.length < 24) throw new Error("INSTALL_TOKEN must be at least 24 characters.");
  return value;
}

export function verifyInstallToken(candidate: string): boolean {
  const expected = createHash("sha256").update(secret()).digest();
  const actual = createHash("sha256").update(candidate).digest();
  return timingSafeEqual(expected, actual);
}

export function createInstallSession(now = Date.now()): string {
  const payload = `${Math.floor(now / 1000) + ttlSeconds}.${randomBytes(18).toString("base64url")}`;
  const signature = createHmac("sha256", secret()).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

export function verifyInstallSession(value: string | undefined, now = Date.now()): boolean {
  if (!value) return false;
  const [expires, nonce, signature] = value.split(".");
  if (!expires || !nonce || !signature || Number(expires) < Math.floor(now / 1000)) return false;
  const payload = `${expires}.${nonce}`;
  const expected = createHmac("sha256", secret()).update(payload).digest();
  const actual = Buffer.from(signature, "base64url");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/** Stable for one unlocked browser session, but unusable without INSTALL_TOKEN. */
export function installationAttemptId(session: string, ownerEmail: string): string {
  const hex = createHmac("sha256", secret()).update(`${session}\n${ownerEmail.trim().toLowerCase()}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function isRecoverableInstallerUser(
  user: { email?: string; app_metadata?: Record<string, unknown> },
  ownerEmail: string,
  attemptId: string,
): boolean {
  return user.email?.toLowerCase() === ownerEmail.trim().toLowerCase()
    && user.app_metadata?.installer_attempt_id === attemptId
    && user.app_metadata?.installer_owner_email === ownerEmail.trim().toLowerCase();
}
