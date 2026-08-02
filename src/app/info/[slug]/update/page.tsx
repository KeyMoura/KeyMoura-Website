import { permanentRedirect } from "next/navigation";

/**
 * Legacy alias. Projects lived at /info before it was renamed; those URLs are
 * still linked from elsewhere, so they permanently redirect to the canonical
 * /projects route rather than 404 or render a second copy of the page.
 */

export default async function LegacyProjectUpdate({ params }: { params: Promise<{ slug: string }> }): Promise<never> {
  const { slug } = await params;
  permanentRedirect(`/projects/${encodeURIComponent(slug)}/update`);
}
