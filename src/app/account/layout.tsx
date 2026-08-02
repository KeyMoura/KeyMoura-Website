import type { Metadata } from "next";

/** Signed-in area: titled for the browser, kept out of search results. */
export const metadata: Metadata = {
  title: "Account",
  robots: { index: false, follow: false },
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
