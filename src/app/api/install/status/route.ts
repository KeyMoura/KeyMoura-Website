import { NextResponse } from "next/server";
import { installationStatus } from "@/lib/installer/server";

export const dynamic = "force-dynamic";
export async function GET() {
  try {
    const state = await installationStatus();
    return NextResponse.json({ ...state, checks: { node: process.versions.node, supabase: Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY), installToken: (process.env.INSTALL_TOKEN?.length ?? 0) >= 24 } });
  } catch { return NextResponse.json({ bootstrapReady: false, status: "missing", errorCode: "SERVER_CONFIGURATION_REQUIRED", modules: {} }, { status: 503 }); }
}
