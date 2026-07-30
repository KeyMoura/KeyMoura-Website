import { notFound } from "next/navigation";
import { installationStatus } from "@/lib/installer/server";
import InstallerWizard from "./wizard";

export const dynamic = "force-dynamic";

export default async function InstallPage() {
  const state = await installationStatus();
  if (state.status === "complete") notFound();
  return <InstallerWizard initialState={state} />;
}
