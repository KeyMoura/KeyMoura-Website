import * as Sentry from "@sentry/nextjs";
import { scrubSentryEvent } from "./src/lib/sentryPrivacy";

Sentry.init({
  dsn: process.env.SENTRY_DSN || process.env.NEXT_PUBLIC_SENTRY_DSN,
  enabled: process.env.NODE_ENV === "production",
  sendDefaultPii: false,
  tracesSampleRate: 0.1,
  beforeSend: (event) => scrubSentryEvent(event),
});
