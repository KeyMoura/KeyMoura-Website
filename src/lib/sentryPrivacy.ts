const sensitiveKey = /authorization|cookie|password|secret|token|address|email|phone|message|notes?|content|card|payment_method|client_secret/i;

export function scrubSentryValue(value: unknown, depth = 0): unknown {
  if (depth > 5) return "[Truncated]";
  if (Array.isArray(value)) return value.map((item) => scrubSentryValue(item, depth + 1));
  if (!value || typeof value !== "object") return value;

  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
    key,
    sensitiveKey.test(key) ? "[Filtered]" : scrubSentryValue(entry, depth + 1),
  ]));
}

export function scrubSentryEvent(event: ErrorEvent): ErrorEvent {
  const scrubbed = scrubSentryValue(event) as ErrorEvent;
  if (scrubbed.user && typeof scrubbed.user === "object") {
    scrubbed.user = { id: scrubbed.user.id };
  }
  if (scrubbed.request?.url) {
    scrubbed.request.url = scrubbed.request.url.split("?")[0].split("#")[0];
  }
  return scrubbed;
}
import type { ErrorEvent } from "@sentry/nextjs";
