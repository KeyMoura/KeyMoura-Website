import { NextRequest, NextResponse } from "next/server";
import { INSTALL_COOKIE, installationAttemptId, isRecoverableInstallerUser, verifyInstallSession } from "@/lib/installer/security";
import { installationStatus, installerAdmin } from "@/lib/installer/server";
import { assertModulesAvailable, validateInstallPayload } from "@/lib/installer/model";

export async function POST(request: NextRequest) {
  const installSession = request.cookies.get(INSTALL_COOKIE)?.value;
  if (!verifyInstallSession(installSession)) return NextResponse.json({ error: "Installer authorization expired." }, { status: 401 });
  const before = await installationStatus();
  if (before.status === "complete") return NextResponse.json({ error: "Not found." }, { status: 404 });
  try {
    const input = validateInstallPayload(await request.json());
    assertModulesAvailable(input.modules, before.modules);
    const db = installerAdmin();
    let attemptId = installationAttemptId(installSession!, input.owner.email);
    let ownerId: string | undefined;
    const listed = await db.auth.admin.listUsers({ page: 1, perPage: 1000 });
    const existing = listed.data.users.find((user) => user.email?.toLowerCase() === input.owner.email.toLowerCase());
    if (existing) {
      const claimedAttempt = existing.app_metadata?.installer_attempt_id;
      if (typeof claimedAttempt !== "string" || !isRecoverableInstallerUser(existing, input.owner.email, claimedAttempt)) {
        throw new Error("An unrelated account already uses this owner email; choose another email.");
      }
      const proof = await db.auth.signInWithPassword({ email: input.owner.email, password: input.owner.password });
      if (proof.error || proof.data.user?.id !== existing.id) {
        throw new Error("Owner account control could not be proven.");
      }
      attemptId = claimedAttempt;
    }
    const claim = await db.rpc("claim_first_install", { p_attempt_id: attemptId, p_owner_email: input.owner.email });
    if (claim.error) throw new Error(claim.error.message);
    ownerId = existing?.id;
    if (!ownerId) {
      const created = await db.auth.admin.createUser({ email: input.owner.email, password: input.owner.password, email_confirm: !input.auth.requireEmailConfirmation,
        app_metadata: { installer_attempt_id: attemptId, installer_owner_email: input.owner.email.trim().toLowerCase() } });
      if (created.error || !created.data.user) throw new Error(created.error?.message ?? "Owner account could not be created.");
      ownerId = created.data.user.id;
    }
    const settings = { site_name: input.siteName.trim(), description: input.description.trim(), public_url: input.publicUrl, logo_url: input.logoUrl, primary_color: input.primaryColor, accent_color: input.accentColor, terminology: input.terminology, auth_config: input.auth };
    const result = await db.rpc("complete_first_install", { p_attempt_id: attemptId, p_owner_user_id: ownerId, p_username: input.owner.username, p_settings: settings, p_modules: input.modules });
    if (result.error) throw new Error(result.error.message);
    const response = NextResponse.json({ installed: true, signInUrl: "/auth/login" });
    response.cookies.delete(INSTALL_COOKIE);
    return response;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Installation failed.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
