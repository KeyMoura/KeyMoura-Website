import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getActorAccessFromRequest, routeServiceClient } from "@/lib/api/routeAuth";
import { logAuditEvent } from "@/lib/audit";

const bodySchema = z.object({
  updateId: z.string().uuid(),
  action: z.enum(["approve", "reject", "forward", "note", "edit"]),
  notes: z.string().trim().max(2000).nullable().optional(),
  // edit-only fields (all optional, but at least one must be present)
  proposedTitle: z.string().trim().max(200).nullable().optional(),
  proposedContentMarkdown: z.string().trim().min(1).max(200000).nullable().optional(),
  proposedTags: z.array(z.string().trim().min(1).max(40)).max(25).nullable().optional(),
  proposedCategory: z.string().trim().max(50).nullable().optional(),
  proposedChassis: z.string().trim().max(50).nullable().optional(),
});

export async function POST(req: NextRequest) {
  try {
    const actor = await getActorAccessFromRequest(req);
    if (!actor) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    if (!actor.permissions.has("info.moderate")) {
      return NextResponse.json({ ok: false, error: "Forbidden" }, { status: 403 });
    }

    const json = await req.json().catch(() => null);
    const parsed = bodySchema.safeParse(json);
    if (!parsed.success) {
      return NextResponse.json({ ok: false, error: "Invalid payload" }, { status: 400 });
    }

    const {
      updateId,
      action,
      notes,
      proposedTitle,
      proposedContentMarkdown,
      proposedTags,
      proposedCategory,
      proposedChassis,
    } = parsed.data;

    const { data: upd, error: updErr } = await routeServiceClient
      .from("info_page_updates")
      .select(
        "id,info_page_id,created_by,status,proposed_title,proposed_content_markdown,proposed_tags,proposed_category,proposed_chassis"
      )
      .eq("id", updateId)
      .maybeSingle();

    if (updErr || !upd) {
      return NextResponse.json({ ok: false, error: "Update not found." }, { status: 404 });
    }

    if (upd.status !== "pending") {
      return NextResponse.json({ ok: false, error: "Update is not pending." }, { status: 400 });
    }

    const { data: page, error: pageErr } = await routeServiceClient
      .from("info_pages")
      .select("id,title,slug,content_markdown,tags,category,chassis,created_by")
      .eq("id", upd.info_page_id)
      .maybeSingle();

    if (pageErr || !page) {
      return NextResponse.json({ ok: false, error: "Target page not found." }, { status: 404 });
    }

    if (action === "note") {
      // Add a note without changing status
      const { error: noteErr } = await routeServiceClient.from("info_page_review_events").insert({
        info_page_id: page.id,
        action: "admin_note",
        performed_by: actor.userId,
        previous_title: page.title,
        previous_content_markdown: page.content_markdown,
        new_title: page.title,
        new_content_markdown: page.content_markdown,
        notes: notes ?? null,
      });
      if (noteErr) {
        console.error(noteErr);
        return NextResponse.json({ ok: false, error: "Failed to save note." }, { status: 500 });
      }

      await logAuditEvent({
        actorUserId: actor.userId,
        actorRole: actor.role,
        eventType: "admin.info_page_update.note",
        targetTable: "info_page_updates",
        targetId: upd.id,
        metadata: { info_page_id: page.id, notes: notes ?? null },
      });

      return NextResponse.json({ ok: true });
    }

    if (action === "forward") {
      // Mark as needing a second opinion (still pending)
      const { error: fwdErr } = await routeServiceClient.from("info_page_review_events").insert({
        info_page_id: page.id,
        action: "admin_forwarded_for_review",
        performed_by: actor.userId,
        previous_title: page.title,
        previous_content_markdown: page.content_markdown,
        new_title: page.title,
        new_content_markdown: page.content_markdown,
        notes: notes ?? null,
      });
      if (fwdErr) {
        console.error(fwdErr);
        return NextResponse.json({ ok: false, error: "Failed to forward for review." }, { status: 500 });
      }

      await logAuditEvent({
        actorUserId: actor.userId,
        actorRole: actor.role,
        eventType: "admin.info_page_update.forward",
        targetTable: "info_page_updates",
        targetId: upd.id,
        metadata: { info_page_id: page.id, notes: notes ?? null },
      });

      return NextResponse.json({ ok: true });
    }

    if (action === "edit") {
      const hasAny =
        proposedTitle !== undefined ||
        proposedContentMarkdown !== undefined ||
        proposedTags !== undefined ||
        proposedCategory !== undefined ||
        proposedChassis !== undefined;

      if (!hasAny) {
        return NextResponse.json(
          { ok: false, error: "No changes provided." },
          { status: 400 }
        );
      }

      const updatePayload: Record<string, unknown> = {};
      if (proposedTitle !== undefined) updatePayload["proposed_title"] = proposedTitle;
      if (proposedContentMarkdown !== undefined)
        updatePayload["proposed_content_markdown"] = proposedContentMarkdown;
      if (proposedTags !== undefined) updatePayload["proposed_tags"] = proposedTags;
      if (proposedCategory !== undefined) updatePayload["proposed_category"] = proposedCategory;
      if (proposedChassis !== undefined) updatePayload["proposed_chassis"] = proposedChassis;

      const { error: editErr } = await routeServiceClient
        .from("info_page_updates")
        .update(updatePayload)
        .eq("id", upd.id);
      if (editErr) {
        console.error(editErr);
        return NextResponse.json(
          { ok: false, error: "Failed to save edits." },
          { status: 500 }
        );
      }

      const previousTitle = (upd.proposed_title ?? page.title) as string;
      const previousContent = (upd.proposed_content_markdown ?? page.content_markdown) as string;
      const newTitle = (proposedTitle ?? upd.proposed_title ?? page.title) as string;
      const newContent = (proposedContentMarkdown ?? upd.proposed_content_markdown ?? page.content_markdown) as string;

      const { error: evErr } = await routeServiceClient.from("info_page_review_events").insert({
        info_page_id: page.id,
        action: "admin_edited",
        performed_by: actor.userId,
        previous_title: previousTitle,
        previous_content_markdown: previousContent,
        new_title: newTitle,
        new_content_markdown: newContent,
        notes: notes ?? null,
      });
      if (evErr) {
        console.error(evErr);
        return NextResponse.json({ ok: false, error: "Edits saved, but failed to log review event." }, { status: 500 });
      }

      await logAuditEvent({
        actorUserId: actor.userId,
        actorRole: actor.role,
        eventType: "admin.info_page_update.edit",
        targetTable: "info_page_updates",
        targetId: upd.id,
        metadata: { info_page_id: page.id },
      });

      return NextResponse.json({ ok: true });
    }

    if (action === "reject") {
      const { error: upErr } = await routeServiceClient
        .from("info_page_updates")
        .update({ status: "rejected" })
        .eq("id", upd.id);

      if (upErr) {
        console.error(upErr);
        return NextResponse.json({ ok: false, error: "Failed to reject." }, { status: 500 });
      }

      // Log the proposal that was rejected
      const { error: rejLogErr } = await routeServiceClient.from("info_page_review_events").insert({
        info_page_id: page.id,
        action: "admin_update_rejected",
        performed_by: actor.userId,
        previous_title: page.title,
        previous_content_markdown: page.content_markdown,
        new_title: (upd.proposed_title ?? page.title) as string,
        new_content_markdown: (upd.proposed_content_markdown ?? page.content_markdown) as string,
        notes: notes ?? null,
      });
      if (rejLogErr) {
        console.error(rejLogErr);
        return NextResponse.json({ ok: false, error: "Rejected, but failed to log review event." }, { status: 500 });
      }

      await logAuditEvent({
        actorUserId: actor.userId,
        actorRole: actor.role,
        eventType: "admin.info_page_update.reject",
        targetTable: "info_page_updates",
        targetId: upd.id,
        metadata: { info_page_id: page.id, notes: notes ?? null },
      });

      return NextResponse.json({ ok: true });
    }

    // approve
    const newTitle = (upd.proposed_title ?? page.title) as string;
    const newContent = upd.proposed_content_markdown as string;
    const newTags = (upd.proposed_tags ?? page.tags) as string[] | null;
    const newCategory = (upd.proposed_category ?? page.category) as string | null;
    const newChassis = (upd.proposed_chassis ?? page.chassis) as string | null;

    const { error: pageUpdErr } = await routeServiceClient
      .from("info_pages")
      .update({
        title: newTitle,
        content_markdown: newContent,
        tags: newTags,
        category: newCategory,
        chassis: newChassis,
      })
      .eq("id", page.id);

    if (pageUpdErr) {
      console.error(pageUpdErr);
      return NextResponse.json({ ok: false, error: "Failed to update page." }, { status: 500 });
    }

    const { error: updStatusErr } = await routeServiceClient
      .from("info_page_updates")
      .update({ status: "approved" })
      .eq("id", upd.id);

    if (updStatusErr) {
      console.error(updStatusErr);
      return NextResponse.json({ ok: false, error: "Failed to mark update approved." }, { status: 500 });
    }

    // contributor (only if not original author)
    const updaterId = (upd.created_by as string) ?? null;
    if (updaterId && updaterId !== page.created_by) {
      await routeServiceClient
        .from("info_page_contributors")
        .upsert({ info_page_id: page.id, user_id: updaterId }, { onConflict: "info_page_id,user_id" });
    }

    // review event
    const { error: apprLogErr } = await routeServiceClient.from("info_page_review_events").insert({
      info_page_id: page.id,
      action: "admin_update_approved",
      performed_by: actor.userId,
      previous_title: page.title,
      previous_content_markdown: page.content_markdown,
      new_title: newTitle,
      new_content_markdown: newContent,
      notes: notes ?? null,
    });
    if (apprLogErr) {
      console.error(apprLogErr);
      // Don't fail the approval if the review log fails, but surface it.
      return NextResponse.json({ ok: true, warning: "Approved, but failed to log review event." });
    }

    await logAuditEvent({
      actorUserId: actor.userId,
      actorRole: actor.role,
      eventType: "admin.info_page_update.approve",
      targetTable: "info_pages",
      targetId: page.id,
      metadata: { update_id: upd.id, notes: notes ?? null },
    });

    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error("admin info update action error", e);
    return NextResponse.json({ ok: false, error: "Server error" }, { status: 500 });
  }
}
