// src/app/api/info/pdf/[slug]/route.ts
import PDFDocument from "pdfkit";
import { createClient } from "@supabase/supabase-js";
import path from "path";

export const runtime = "nodejs";

async function fetchAsBuffer(url: string): Promise<Buffer> {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`Failed to fetch image: ${url} (${res.status})`);
  const ab = await res.arrayBuffer();
  return Buffer.from(ab);
}

function resolveImageUrl(input: string): string {
  const trimmed = (input || "").trim();

  // absolute
  if (/^https?:\/\//i.test(trimmed)) return trimmed;

  // protocol-relative
  if (trimmed.startsWith("//")) return `https:${trimmed}`;

  // root-relative: point to your own site (so /public files can be fetched)
  if (trimmed.startsWith("/")) return `${process.env.NEXT_PUBLIC_SITE_URL ?? "https://keymoura.com"}${trimmed}`;

  // fallback
  return trimmed;
}

export async function GET(
  _req: Request,
  context: { params: Promise<{ slug: string }> }
) {
  try {
    const { slug } = await context.params;

    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!url || !serviceKey) {
      console.error("Missing Supabase env vars", {
        hasUrl: !!url,
        hasServiceKey: !!serviceKey,
      });
      return new Response("Server misconfigured", { status: 500 });
    }

    const supabase = createClient(url, serviceKey, {
      auth: { persistSession: false },
    });

    const { data: page, error } = await supabase
      .from("info_pages")
      .select("title, slug, content_markdown, status, updated_at, created_at")
      .eq("slug", slug)
      .maybeSingle();

    if (error) {
      console.error("Supabase fetch error", error);
      return new Response("Database error", { status: 500 });
    }

    if (!page || page.status !== "approved") {
      return new Response("Not found", { status: 404 });
    }

    // Create PDF
    const doc = new PDFDocument({ size: "LETTER", margin: 54 });

    // Use your bundled font (keeps things consistent + avoids default font issues)
    const fontPath = path.join(process.cwd(), "public/fonts/Helvetica.ttf");
    doc.font(fontPath);

    const chunks: Buffer[] = [];
    doc.on("data", (c) => chunks.push(c));

    const done = new Promise<Buffer>((resolve, reject) => {
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);
    });

    // Header
    doc.fontSize(20).text(page.title);
    doc.moveDown(0.5);
    doc
      .fontSize(9)
      .fillColor("gray")
      .text(
        `keymoura.com/info/${encodeURIComponent(page.slug)} • ${new Date(
          page.updated_at || page.created_at
        ).toLocaleString()}`
      );
    doc.moveDown(1);
    doc.fillColor("black").fontSize(11);

    // Render markdown-ish with images + headings + link stripping
    const md = page.content_markdown || "";
    const lines = md.split(/\r?\n/);

    for (const raw of lines) {
      const line = raw.trimEnd();

      // Image: ![alt](url)
      const imgMatch = line.match(/^!\[([^\]]*)\]\(([^)]+)\)\s*$/);
      if (imgMatch) {
        const alt = imgMatch[1] || "Image";
        const url = resolveImageUrl(imgMatch[2]);

        try {
          const buf = await fetchAsBuffer(url);

          // caption
          doc
            .moveDown(0.3)
            .fontSize(9)
            .fillColor("gray")
            .text(alt);

          doc.fillColor("black").fontSize(11);

          // image
          const maxWidth = 504;
          const maxHeight = 380;

          doc.moveDown(0.2);
          doc.image(buf, { fit: [maxWidth, maxHeight] });
          doc.moveDown(0.8);
        } catch {
          doc
            .moveDown(0.3)
            .fontSize(9)
            .fillColor("gray")
            .text(`[Image failed to load] ${url}`);
          doc.fillColor("black").fontSize(11);
          doc.moveDown(0.4);
        }
        continue;
      }

      // Headings: # .. ######
      const h = line.match(/^(#{1,6})\s+(.*)$/);
      if (h) {
        const level = h[1].length;
        const heading = h[2];

        const size =
          level === 1 ? 18 : level === 2 ? 15 : level === 3 ? 13 : 12;

        doc.moveDown(0.6);
        doc.fontSize(size).text(heading);
        doc.moveDown(0.2);
        doc.fontSize(11);
        continue;
      }

      // Skip code fences (simple)
      if (line.startsWith("```")) continue;

      // Blank line spacing
      if (!line.trim()) {
        doc.moveDown(0.4);
        continue;
      }

      // Strip links but keep text: [label](url) -> label
      const cleaned = line.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");

      doc.text(cleaned, { width: 504, align: "left" });
    }

    doc.end();

    const pdf = await done;
    const bytes = new Uint8Array(pdf);

    return new Response(bytes, {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${page.slug}.pdf"`,
        "Cache-Control": "public, max-age=300",
      },
    });
  } catch (e) {
    const msg =
      e instanceof Error ? `${e.name}: ${e.message}\n${e.stack ?? ""}` : String(e);
    console.error("PDF route crashed:", msg);
    return new Response("PDF generation failed", { status: 500 });
  }
}
