import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs";

/**
 * Product and profile media live in this project's Supabase Storage buckets.
 * Allowing that one host lets next/image resize and re-encode uploads — a
 * catalog cover is commonly a 4096px PNG rendered into a ~360px box. Operator
 * URLs on any other host stay on a plain <img>; see components/ProductImage.
 */
function supabaseImageHost(): string | null {
  try {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    return url ? new URL(url).hostname : null;
  } catch {
    return null;
  }
}

const storageHost = supabaseImageHost();

const nextConfig: NextConfig = {
  serverExternalPackages: ["pdfkit"],
  reactCompiler: true,
  images: {
    remotePatterns: storageHost
      ? [{ protocol: "https", hostname: storageHost, pathname: "/storage/v1/object/public/**" }]
      : [],
  },
};

export default withSentryConfig(nextConfig, {
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  authToken: process.env.SENTRY_AUTH_TOKEN,
  silent: !process.env.CI,
  sourcemaps: { deleteSourcemapsAfterUpload: true },
  webpack: { treeshake: { removeDebugLogging: true } },
});
