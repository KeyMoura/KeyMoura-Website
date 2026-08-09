export function customerOrderPath(orderId: string, customerId: string | null | undefined): string {
  return customerId ? `/orders/${orderId}` : `/orders/guest/${orderId}`;
}

export function customerOrderUrl(siteUrl: string, orderId: string, customerId: string | null | undefined): string {
  return `${siteUrl.replace(/\/$/, "")}${customerOrderPath(orderId, customerId)}`;
}
