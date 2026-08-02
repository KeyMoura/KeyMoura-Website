import * as Sentry from "@sentry/nextjs";

export function captureCommerceException(
  error: unknown,
  context: { operation: string; orderId?: string; stripeEventId?: string },
) {
  Sentry.withScope((scope) => {
    scope.setTag("commerce.operation", context.operation);
    if (context.orderId) scope.setTag("order.id", context.orderId);
    if (context.stripeEventId) scope.setTag("stripe.event_id", context.stripeEventId);
    Sentry.captureException(error);
  });
}
