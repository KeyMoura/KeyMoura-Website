import type { Metadata } from "next";
import { AccountNav } from "@/components/account/AccountNav";

/** Signed-in area: titled for the browser, kept out of search results. */
export const metadata: Metadata = {
  title: "Account",
  robots: { index: false, follow: false },
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return <><AccountNav />{children}</>;
}
