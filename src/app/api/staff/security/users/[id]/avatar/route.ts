import { NextRequest, NextResponse } from "next/server";
import { requirePermission, routeServiceClient } from "@/lib/api/routeAuth";
import {
  AVATAR_BUCKET,
  avatarObjectKey,
  avatarObjectKeysFor,
  avatarRejectionReason,
  versionedAvatarUrl,
} from "@/lib/avatars";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Replace a user's avatar on their behalf.
 *
 * Three things were wrong here, all invisible because this route runs as
 * `service_role` and therefore bypasses the row-level security that would have
 * complained:
 *
 * 1. **The bucket name was repeated inside the key.** `upload()` is already
 *    scoped by `.from("avatars")`, so a key of `avatars/<id>/…` stored the
 *    object at `avatars/avatars/<id>/…`. The first path segment is what the
 *    bucket's policies compare against `auth.uid()`, so every object written
 *    here sat outside the prefix those policies govern — reachable only because
 *    nothing but `service_role` ever touched it.
 * 2. **The key was timestamped**, so each upload left the previous image behind
 *    with nothing that would ever remove it.
 * 3. **The file was never validated.** Type and size were passed straight to
 *    storage; the bucket's own limits were the only check, and its error text
 *    was returned verbatim to the browser.
 */
export async function POST(req: NextRequest, ctx: Ctx) {
  const actor = await requirePermission(req, "users.profile.edit");
  if (!actor) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { id } = await ctx.params;
  if (!id) return NextResponse.json({ error: "Invalid user id" }, { status: 400 });

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "Missing file." }, { status: 400 });
  }

  // The same rules the customer's own upload applies, from one module.
  const rejection = avatarRejectionReason(file);
  if (rejection) return NextResponse.json({ error: rejection }, { status: 400 });

  let objectPath: string;
  try {
    // Throws on an id that is not a UUID, so a route parameter can never choose
    // its own folder — `..%2F` would otherwise place the object anywhere.
    objectPath = avatarObjectKey(id, file.type);
  } catch {
    return NextResponse.json({ error: "Invalid user id" }, { status: 400 });
  }

  const upload = await routeServiceClient.storage
    .from(AVATAR_BUCKET)
    .upload(objectPath, file, { upsert: true, contentType: file.type, cacheControl: "3600" });

  // The provider's message can quote the key and the bucket's configuration, so
  // it is logged rather than returned.
  if (upload.error) {
    console.error("staff avatar upload failed", upload.error);
    return NextResponse.json({ error: "Could not store that image." }, { status: 400 });
  }

  // A previous avatar in a different format lives at a different key. Removing
  // it keeps one object per user; a failure here is not worth failing the
  // upload over, since the profile already points at the new image.
  const stale = avatarObjectKeysFor(id).filter((key) => key !== objectPath);
  if (stale.length) await routeServiceClient.storage.from(AVATAR_BUCKET).remove(stale);

  const { data } = routeServiceClient.storage.from(AVATAR_BUCKET).getPublicUrl(objectPath);
  const publicUrl = data?.publicUrl ?? "";
  if (!publicUrl) return NextResponse.json({ error: "Failed to resolve avatar url." }, { status: 400 });

  const avatarUrl = versionedAvatarUrl(publicUrl);
  const { error } = await routeServiceClient.from("profiles").update({ avatar_url: avatarUrl }).eq("id", id);
  if (error) {
    console.error("staff avatar profile update failed", error);
    return NextResponse.json({ error: "Could not save the profile." }, { status: 400 });
  }

  return NextResponse.json({ ok: true, avatar_url: avatarUrl }, { status: 200 });
}
