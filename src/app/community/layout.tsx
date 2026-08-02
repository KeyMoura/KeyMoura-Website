import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Community",
  description: "Categories, threads, and discussion in the KeyMoura community.",
  alternates: { canonical: "/community" },
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
