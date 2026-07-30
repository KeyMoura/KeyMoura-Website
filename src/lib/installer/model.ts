export const OPTIONAL_MODULES = {
  forum: { label: "Forum", requires: ["moderation"], schemaKey: "forum" },
  knowledge_base: { label: "Knowledge Base", requires: [], schemaKey: "knowledge_base" },
  garage: { label: "Garage", requires: [], schemaKey: "garage" },
  vendors: { label: "Shops / Vendors", requires: [], schemaKey: "vendors" },
  messaging: { label: "Messaging", requires: ["moderation"], schemaKey: "messaging" },
  notifications: { label: "Notifications", requires: [], schemaKey: "notifications" },
  moderation: { label: "Moderation / Reports", requires: [], schemaKey: "moderation" },
} as const;

export type OptionalModule = keyof typeof OPTIONAL_MODULES;

export function resolveModuleDependencies(input: readonly string[]): OptionalModule[] {
  const selected = new Set<OptionalModule>();
  const visit = (key: string) => {
    if (!(key in OPTIONAL_MODULES)) throw new Error(`Unknown module: ${key}`);
    const moduleKey = key as OptionalModule;
    if (selected.has(moduleKey)) return;
    selected.add(moduleKey);
    OPTIONAL_MODULES[moduleKey].requires.forEach(visit);
  };
  input.forEach(visit);
  return [...selected].sort();
}

export type ModuleAvailability = Record<OptionalModule, { available: boolean; reason: string }>;

export function moduleAvailability(appliedSchemaKeys: readonly string[]): ModuleAvailability {
  const applied = new Set(appliedSchemaKeys);
  return Object.fromEntries(Object.entries(OPTIONAL_MODULES).map(([key, value]) => {
    const missing = [value.schemaKey, ...value.requires.map((dependency) => OPTIONAL_MODULES[dependency].schemaKey)]
      .filter((schemaKey) => !applied.has(schemaKey));
    return [key, { available: missing.length === 0, reason: missing.length ? `Required schema not applied: ${missing.join(", ")}` : "Schema is installed and ready." }];
  })) as ModuleAvailability;
}

export function assertModulesAvailable(modules: readonly OptionalModule[], availability: ModuleAvailability): void {
  const unavailable = modules.filter((module) => !availability[module]?.available);
  if (unavailable.length) throw new Error(`Unavailable modules cannot be installed: ${unavailable.join(", ")}`);
}

export type InstallPayload = {
  siteName: string; description: string; publicUrl: string; logoUrl?: string;
  primaryColor: string; accentColor: string;
  terminology: Record<string, string>;
  auth: { allowSignup: boolean; requireEmailConfirmation: boolean };
  modules: OptionalModule[];
  owner: { email: string; password: string; username: string };
};

const colorPattern = /^#[0-9a-f]{6}$/i;
const usernamePattern = /^[a-z0-9_-]{3,32}$/i;

export function validateInstallPayload(value: unknown): InstallPayload {
  if (!value || typeof value !== "object") throw new Error("Invalid installation request.");
  const data = value as Partial<InstallPayload>;
  if (!data.siteName?.trim() || data.siteName.length > 100) throw new Error("Site name is required and must be at most 100 characters.");
  let url: URL;
  try { url = new URL(data.publicUrl ?? ""); } catch { throw new Error("A valid public URL is required."); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error("Public URL must use HTTP or HTTPS.");
  if (!colorPattern.test(data.primaryColor ?? "") || !colorPattern.test(data.accentColor ?? "")) throw new Error("Theme colors must be six-digit hex values.");
  if (!data.owner?.email?.includes("@")) throw new Error("A valid owner email is required.");
  if ((data.owner.password?.length ?? 0) < 12) throw new Error("Owner password must contain at least 12 characters.");
  if (!usernamePattern.test(data.owner.username ?? "")) throw new Error("Username must be 3–32 letters, numbers, underscores, or hyphens.");
  const modules = resolveModuleDependencies(data.modules ?? []);
  return { ...data, description: data.description ?? "", logoUrl: data.logoUrl ?? "", terminology: data.terminology ?? {}, auth: data.auth ?? { allowSignup: true, requireEmailConfirmation: true }, modules } as InstallPayload;
}

export function canFinalizeInstallation(status: string, existingOwner: string | null, requestedOwner: string): "new" | "resume" | "locked" {
  if (status !== "complete") return "new";
  return existingOwner === requestedOwner ? "resume" : "locked";
}
