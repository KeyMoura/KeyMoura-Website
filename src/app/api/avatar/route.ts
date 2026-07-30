import { NextResponse } from "next/server";

function isAllowedAvatarUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    // Restrict to known avatar hosts to avoid becoming an open proxy.
    if (u.protocol !== "https:") return false;
    const host = u.hostname.toLowerCase();
    return host.endsWith("googleusercontent.com");
  } catch {
    return false;
  }
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const url = searchParams.get("url");

  if (!url || !isAllowedAvatarUrl(url)) {
    return NextResponse.json({ ok: false, error: "Invalid avatar URL." }, { status: 400 });
  }

  const res = await fetch(url, {
    // Some avatar hosts care about UA; this keeps it simple and compatible.
    headers: { "User-Agent": "Mozilla/5.0" },
    cache: "force-cache",
  });

  if (!res.ok) {
    return NextResponse.json({ ok: false, error: `Upstream failed (${res.status})` }, { status: 502 });
  }

  const contentType = res.headers.get("content-type") || "image/jpeg";
  const buf = await res.arrayBuffer();

  return new NextResponse(buf, {
    status: 200,
    headers: {
      "Content-Type": contentType,
      // Cache aggressively; avatars rarely change. CDN will respect this.
      "Cache-Control": "public, max-age=86400, s-maxage=604800, stale-while-revalidate=86400",
    },
  });
}
