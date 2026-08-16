import { NextRequest, NextResponse } from "next/server";
import { requirePermission, routeServiceClient } from "@/lib/api/routeAuth";
import {
  BRAND_BUCKET,
  brandObjectKey,
  brandObjectKeysFor,
  checkBrandUpload,
  isBrandSlot,
  isManagedBrandAsset,
  versionedBrandUrl,
} from "@/lib/brandAssets";
import { recordAuditChange, resolveActorLabel } from "@/lib/audit/events";

/**
 * Upload and remove the site's brand marks.
 *
 * ## Why this is a route and not a browser upload
 *
 * Product images are uploaded straight from `/staff/catalog` with the browser's
 * own Supabase client, and that is fine there: the bucket's insert policy is
 * `public.is_staff_user()`, so the database decides, and the worst a bad file
 * can do is look wrong on one product page.
 *
 * A logo is different in two ways. It renders on every page of the site
 * including the ones logged-out visitors see, and the *only* validation a direct
 * browser upload gets is the bucket's `allowed_mime_types` — which compares the
 * `Content-Type` the client sent, not the bytes. That is a check on a claim.
 *
 * So this runs server-side, where the bytes can be read before anything is
 * stored: the type is sniffed from the file's own header, the dimensions come
 * out of that header, and the storage key is built from a slot name off a fixed
 * list. Nothing the request supplies reaches the path, and nothing it *claims*
 * about the file is trusted.
 *
 * Authorization is `appearance.manage` — the same permission that publishes the
 * rest of this page. Replacing the logo and republishing the palette are the
 * same job, and splitting them across two permissions would mean an owner who
 * can change every colour on the site cannot change the mark above them.
 */

const SLOT_LABEL = { primary: "Primary logo", alternate: "Alternate logo" } as const;

export async function POST(req: NextRequest) {
  const actor = await requirePermission(req, "appearance.manage");
  if (!actor) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
  }

  const slot = form.get("slot");
  if (!isBrandSlot(slot)) {
    return NextResponse.json({ error: "Unknown logo slot." }, { status: 400 });
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "Choose an image to upload." }, { status: 400 });
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const check = checkBrandUpload(bytes, file.size);
  if (!check.ok) return NextResponse.json({ error: check.error }, { status: 400 });

  // The extension comes from the sniffed type, so a `.png` holding a JPEG is
  // stored as the JPEG it is and served with the header that matches it.
  const objectPath = brandObjectKey(slot, check.type);

  const upload = await routeServiceClient.storage
    .from(BRAND_BUCKET)
    .upload(objectPath, bytes, { upsert: true, contentType: check.type, cacheControl: "3600" });

  // Storage's own message can quote the key and the bucket's configuration, so
  // it is logged rather than handed to the browser.
  if (upload.error) {
    console.error("brand asset upload failed", upload.error);
    return NextResponse.json({ error: "Could not store that image." }, { status: 400 });
  }

  /*
   * A previous mark in a different format sits at a different key.
   *
   * Only the *other formats of this same slot* are cleared — a fixed list of two
   * keys this module computed itself. The other slot is never touched, and
   * neither is anything outside the `brand/` prefix, so a shared or
   * still-referenced object cannot be removed by replacing a logo. A failure
   * here is not worth failing the upload over: the settings already point at the
   * new object, and the orphan is one file.
   */
  const stale = brandObjectKeysFor(slot).filter((key) => key !== objectPath);
  if (stale.length) await routeServiceClient.storage.from(BRAND_BUCKET).remove(stale);

  const { data } = routeServiceClient.storage.from(BRAND_BUCKET).getPublicUrl(objectPath);
  const publicUrl = data?.publicUrl ?? "";
  if (!publicUrl) {
    return NextResponse.json({ error: "Could not resolve the stored image." }, { status: 400 });
  }

  /*
   * The URL is returned, not saved.
   *
   * Uploading puts the file somewhere; it does not publish it. The editor drops
   * the returned URL into its working form, which is then dirty like any other
   * unsaved change, and Publish is still what makes it live. An upload that
   * silently rewrote `site_settings` would be the one control on this page that
   * skipped the review step every other control has.
   */
  const url = versionedBrandUrl(publicUrl);

  await recordAuditChange({
    action: "settings.appearance_changed",
    actor: {
      kind: "staff",
      userId: actor.userId,
      role: actor.role,
      label: await resolveActorLabel(actor.userId),
    },
    entity: { type: "setting", id: "appearance", label: "Appearance" },
    changes: { [`brand_${slot}_logo`]: { before: null, after: objectPath, summarized: false } },
    summary: `${SLOT_LABEL[slot]} uploaded (${check.dimensions.width}×${check.dimensions.height})`,
    source: "staff_ui",
  });

  return NextResponse.json({
    ok: true,
    slot,
    url,
    width: check.dimensions.width,
    height: check.dimensions.height,
  });
}

/**
 * Remove a stored brand mark.
 *
 * Refuses anything this application did not store. The shipped marks under
 * `public/brand/` are referenced by `site.config.ts` as the build-time fallback
 * and are not in a bucket at all; a URL an owner pasted from elsewhere belongs
 * to whoever hosts it. In both cases the right behaviour is to clear the
 * setting and leave the file alone, which is what the editor does — this route
 * only exists for objects that would otherwise be orphaned.
 */
export async function DELETE(req: NextRequest) {
  const actor = await requirePermission(req, "appearance.manage");
  if (!actor) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const slot = body?.slot;
  if (!isBrandSlot(slot)) return NextResponse.json({ error: "Unknown logo slot." }, { status: 400 });

  const url = typeof body?.url === "string" ? body.url : "";
  if (url && !isManagedBrandAsset(url)) {
    // Not an error: clearing the field is still the right outcome, and the
    // editor has already done it. There is simply nothing here to delete.
    return NextResponse.json({ ok: true, removed: false });
  }

  const { error } = await routeServiceClient.storage
    .from(BRAND_BUCKET)
    .remove(brandObjectKeysFor(slot));
  if (error) {
    console.error("brand asset delete failed", error);
    return NextResponse.json({ error: "Could not remove that image." }, { status: 400 });
  }

  return NextResponse.json({ ok: true, removed: true });
}
