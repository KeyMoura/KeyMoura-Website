import { NextRequest, NextResponse } from "next/server";
import { createInstallSession, INSTALL_COOKIE, verifyInstallToken } from "@/lib/installer/security";
import { installationStatus } from "@/lib/installer/server";

export async function POST(request: NextRequest) {
  const state = await installationStatus();
  if (state.status === "complete") return NextResponse.json({ error: "Not found." }, { status: 404 });
  const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (!verifyInstallToken(token)) return NextResponse.json({ error: "Invalid installation token." }, { status: 401 });
  const response = NextResponse.json({ unlocked: true });
  response.cookies.set(INSTALL_COOKIE, createInstallSession(), { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "strict", path: "/", maxAge: 1800 });
  return response;
}
