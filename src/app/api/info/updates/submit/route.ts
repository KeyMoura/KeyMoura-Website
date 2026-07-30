import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getActorAccessFromRequest, routeServiceClient } from "@/lib/api/routeAuth";
import { hardBlockIfProfane } from "@/lib/profanity";

const bodySchema = z.object({
  infoPageId: z.string().uuid(),
  proposedTitle: z.string().trim().min(1).max(160).optional(),
  proposedContentMarkdown: z.string().trim().min(1).max(200_000),
  proposedTags: z.array(z.string().trim().min(1).max(48)).max(24).optional(),
  proposedCategory: z.string().trim().min(1).max(64).optional(),
  proposedChassis: z.string().trim().min(1).max(32).optional(),
});

export async function POST(req: NextRequest) {
  try {
    const actor = await getActorAccessFromRequest(req);
    if (!actor) {
      return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }
    if (!actor.permissions.has("info.update.submit")) {
      return NextResponse.json({ ok: false, error: "Forbidden" }, { status: 403 });
    }

    const json = await req.json().catch(() => null);
    const parsed = bodySchema.safeParse(json);
    if (!parsed.success) {
      return NextResponse.json({ ok: false, error: "Invalid payload" }, { status: 400 });
    }

    const {
      infoPageId,
      proposedTitle,
      proposedContentMarkdown,
      proposedTags,
      proposedCategory,
      proposedChassis,
    } = parsed.data;

    // Maintenance mode (same behavior as info submit)
    const { data: flagsData } = await routeServiceClient.rpc("get_site_lockdown_flags");
    const maintenanceMode = Array.isArray(flagsData) && flagsData[0]?.maintenance_mode === true;

    if (maintenanceMode) {
      // Allow admins to submit updates during maintenance
      if (!actor.permissions.has("security.settings.manage")) {
        return NextResponse.json(
          { ok: false, error: "Site is currently in maintenance mode. Updates are temporarily disabled." },
          { status: 503 }
        );
      }
    }

    // Verify target page exists + approved
    const { data: page, error: pageErr } = await routeServiceClient
      .from("info_pages")
      // Include the current approved values so the update record can store an immutable
      // "original" snapshot alongside the proposed changes.
      .select("id,status,title,content_markdown,tags,category,chassis")
      .eq("id", infoPageId)
      .maybeSingle();

    if (pageErr || !page) {
      return NextResponse.json({ ok: false, error: "Info page not found." }, { status: 404 });
    }

    if (page.status !== "approved") {
      return NextResponse.json({ ok: false, error: "Only approved pages can be updated." }, { status: 400 });
    }

    // Profanity hard-block
    for (const field of [
      proposedTitle ?? "",
      proposedContentMarkdown,
      ...(proposedTags ?? []),
      proposedCategory ?? "",
      proposedChassis ?? "",
    ]) {
      const prof = await hardBlockIfProfane(field);
      if ("error" in prof) {
        return NextResponse.json({ ok: false, error: prof.error }, { status: 400 });
      }
    }

    const { error: insertErr } = await routeServiceClient
      .from("info_page_updates")
      .insert({
        info_page_id: infoPageId,
        created_by: actor.userId,
        // Immutable snapshot of what the page looked like at the time the update was submitted.
        original_title: page.title ?? null,
        original_content_markdown: page.content_markdown ?? null,
        original_tags: (page.tags as string[] | null) ?? null,
        original_category: page.category ?? null,
        original_chassis: page.chassis ?? null,
        proposed_title: proposedTitle ?? null,
        proposed_content_markdown: proposedContentMarkdown,
        proposed_tags: proposedTags ?? null,
        proposed_category: proposedCategory ?? null,
        proposed_chassis: proposedChassis ?? null,
        status: "pending",
      });

    if (insertErr) {
      console.error("info update insert error", insertErr);
      return NextResponse.json({ ok: false, error: "Failed to submit update." }, { status: 500 });
    }

    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error("info updates submit route error", e);
    return NextResponse.json({ ok: false, error: "Server error" }, { status: 500 });
  }
}
