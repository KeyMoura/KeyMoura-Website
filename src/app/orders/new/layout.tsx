import type { Metadata } from "next";

/**
 * Explicitly indexable. This sits under /orders, whose layout marks the
 * signed-in area noindex, but the custom-request page is a public entry point
 * and must not inherit that.
 */
export const metadata: Metadata = {
  title: "Request custom work",
  description: "Describe the part you need and get a reviewed quote before you pay.",
  alternates: { canonical: "/orders/new" },
  robots: { index: true, follow: true },
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
