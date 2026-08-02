import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Trusted shops",
  description: "Shops and makers recommended by KeyMoura.",
  alternates: { canonical: "/shops" },
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
