import "server-only";
import Stripe from "stripe";

export function stripeClient() {
  const secret = process.env.STRIPE_SECRET_KEY;
  if (!secret) throw new Error("Stripe is not configured.");
  return new Stripe(secret, { typescript: true });
}
