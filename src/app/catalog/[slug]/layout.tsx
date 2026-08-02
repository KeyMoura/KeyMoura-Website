import type { Metadata } from "next";
import { supabaseAdmin } from "@/lib/supabaseServer";
import { primaryProductImage } from "@/lib/productImages";

/**
 * Product pages are the most-shared URLs on the site, so they carry their own
 * title, description, canonical URL, and share image instead of falling back
 * to the site defaults. The page itself is a client component and cannot
 * export metadata, so it lives here.
 */
export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;

  try {
    const client = supabaseAdmin();
    const { data } = await client
      .from("products")
      .select("id,name,short_description,image_url")
      .eq("slug", slug)
      .eq("is_published", true)
      .is("archived_at", null)
      .maybeSingle();

    if (!data) return { title: "Product", alternates: { canonical: `/catalog/${slug}` } };

    const { data: media } = await client
      .from("product_media")
      .select("url,kind,sort_order")
      .eq("product_id", data.id)
      .eq("kind", "image")
      .order("sort_order")
      .limit(1);

    const image = primaryProductImage({ image_url: data.image_url, product_media: media ?? [] });
    const description = data.short_description?.trim() || `${data.name} from the KeyMoura catalog.`;

    return {
      title: data.name,
      description,
      alternates: { canonical: `/catalog/${slug}` },
      openGraph: {
        type: "website",
        title: data.name,
        description,
        url: `/catalog/${slug}`,
        images: image ? [{ url: image }] : [],
      },
      twitter: { card: "summary_large_image", title: data.name, description, images: image ? [image] : [] },
    };
  } catch {
    return { title: "Product", alternates: { canonical: `/catalog/${slug}` } };
  }
}

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
