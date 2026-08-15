import { notFound } from "next/navigation";

import VisualHarness from "./ui";

/**
 * The visual-system harness.
 *
 * Every other surface in this application needs a database, a session, or both
 * before it will render a button — which makes "does the Buy now button take
 * its colour from the right appearance role?" a question you cannot answer by
 * looking. This route renders the real shared components against fixtures, so
 * the visual system can be inspected and regression-tested on its own.
 *
 * Guarded exactly like `/dev/menuselect`: it is a development tool, not a page.
 */
export default function VisualDevPage() {
  if (process.env.NODE_ENV === "production") notFound();

  return <VisualHarness />;
}
