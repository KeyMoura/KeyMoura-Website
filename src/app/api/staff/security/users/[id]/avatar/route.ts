import { NextRequest, NextResponse } from "next/server";
import { requirePermission, routeServiceClient } from "@/lib/api/routeAuth";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Uploads a new avatar image for a user and updates the profile avatar_url.
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

  const ext = (file.type || "image/jpeg").includes("png") ? "png" : "jpg";
  const objectPath = `avatars/${id}/${Date.now()}.${ext}`;

  const upload = await routeServiceClient.storage
    .from("avatars")
    .upload(objectPath, file, { upsert: true, contentType: file.type || undefined });

  if (upload.error) {
    return NextResponse.json({ error: upload.error.message }, { status: 400 });
  }

  const { data } = routeServiceClient.storage.from("avatars").getPublicUrl(objectPath);
  const publicUrl = data?.publicUrl ?? "";
  if (!publicUrl) return NextResponse.json({ error: "Failed to resolve avatar url." }, { status: 400 });

  const { error } = await routeServiceClient.from("profiles").update({ avatar_url: publicUrl }).eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  return NextResponse.json({ ok: true, avatar_url: publicUrl }, { status: 200 });
}
