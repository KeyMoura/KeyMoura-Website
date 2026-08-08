import type { Metadata } from "next";

/**
 * Community is dormant as of pass 14.
 *
 * KeyMoura is a shop today, so Community was removed from every customer
 * surface — the desktop More menu, the mobile drawer, the footer and the search
 * palette. **Nothing was deleted.** Every route under `/community` still
 * resolves, every thread, post, comment, vote and category is untouched in the
 * database, and the `community.*` permissions are unchanged. A customer holding
 * a link, or following one from an old notification, still lands on the real
 * page.
 *
 * `noindex` applies because the site no longer links here. A section that is
 * unreachable from the navigation but still indexed sends search traffic to a
 * dead end — visitors arrive at a discussion area the shop has stopped
 * pointing at and nobody is answering in. `follow` stays true so the links
 * *out* of these pages, back into the shop, are still worth something.
 *
 * Reviving it is two edits: add the entry back to `secondaryNav` in
 * `src/lib/navigation.ts`, and drop the `robots` line below. There is no
 * migration and no data to restore.
 */
export const metadata: Metadata = {
  title: "Community",
  description: "Categories, threads, and discussion in the KeyMoura community.",
  alternates: { canonical: "/community" },
  robots: { index: false, follow: true },
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
