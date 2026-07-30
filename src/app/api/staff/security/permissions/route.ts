import { NextRequest, NextResponse } from "next/server";
import { requireAnyPermission, routeServiceClient } from "@/lib/api/routeAuth";
import { PERMISSION_META } from "@/lib/permissions";
import { readJson, asRecord } from "@/lib/json";
import { isArray, isString } from "@/lib/typeGuards";

type PermissionRow = {
  key: string;
  description: string | null;
  category: string | null;
};

function normalizePermissionRow(v: unknown): PermissionRow | null {
  const r = asRecord(v);
  if (!r) return null;
  if (!isString(r.key)) return null;
  const description = isString(r.description) ? r.description : null;
  const category = isString(r.category) ? r.category : null;
  return { key: r.key, description, category };
}

function parseCreatePayload(v: unknown): PermissionRow | null {
  const r = asRecord(v);
  if (!r) return null;
  const key = isString(r.key) ? r.key.trim() : "";
  if (!key) return null;
  const description = isString(r.description) ? r.description : null;
  const category = isString(r.category) ? r.category : null;
  return { key, description, category };
}

export async function GET(req: NextRequest) {
  const actor = await requireAnyPermission(req, [
    "permissions.manage",
    "permissions.grant",
  ]);
  if (!actor) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  /**
   * Keep the database permission catalog in sync with the application registry.
   *
   * We intentionally do not expose a UI to create arbitrary permissions.
   * Instead, the server seeds known permissions with stable descriptions.
   */
  const seedRows: PermissionRow[] = Object.entries(PERMISSION_META).map(([key, meta]) => ({
    key,
    description: meta.description,
    category: meta.category,
  }));

  await routeServiceClient.from("permissions").upsert(seedRows, { onConflict: "key" });

  const { data } = await routeServiceClient
    .from("permissions")
    .select("key,description,category")
    .order("key");
  const permissions: PermissionRow[] = [];
  if (isArray(data)) {
    for (const row of data) {
      const n = normalizePermissionRow(row);
      if (!n) continue;
      if (!(n.key in PERMISSION_META)) continue;
      const meta = (PERMISSION_META as any)[n.key] as { description?: string; category?: string } | undefined;
      permissions.push({
        key: n.key,
        description: meta?.description ?? n.description,
        category: meta?.category ?? n.category,
      });
    }
  }
  return NextResponse.json({ permissions }, { status: 200 });
}

export async function POST(req: NextRequest) {
  const actor = await requireAnyPermission(req, ["permissions.manage"]);
  if (!actor) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  /**
   * Creating new permissions from the UI is intentionally disabled.
   *
   * Permission keys are owned by the codebase to keep behavior predictable.
   */
  const payload = await readJson(req);
  const parsed = parseCreatePayload(payload);
  if (!parsed) return NextResponse.json({ error: "Invalid payload" }, { status: 400 });

  if (!(parsed.key in PERMISSION_META)) {
    return NextResponse.json(
      {
        error:
          "Permission creation is disabled. Add the key to src/lib/permissions.ts (PERMISSIONS + PERMISSION_META) and redeploy.",
      },
      { status: 400 }
    );
  }

  await routeServiceClient.from("permissions").upsert(parsed, { onConflict: "key" });
  return NextResponse.json({ ok: true }, { status: 200 });
}
