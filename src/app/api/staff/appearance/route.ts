import { NextRequest, NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { requirePermission, routeServiceClient } from "@/lib/api/routeAuth";
import { normalizeSiteTheme } from "@/theme/runtime";
import { buildChangeSet } from "@/lib/audit/diff";
import { recordAuditChange, resolveActorLabel } from "@/lib/audit/events";

const clean = (value: unknown, max: number) => typeof value === "string" ? value.trim().slice(0, max) : "";

/**
 * How many theme tokens actually moved, compared one level deep.
 *
 * A count, not a list: the theme is a nested document of colours, spacing and
 * control styles, and "17 theme tokens changed" is the honest summary of a
 * design tweak. Anyone who needs the values has the theme itself.
 */
function countChangedTokens(before: unknown, after: unknown): number {
  const flatten = (value: unknown, prefix = ""): Record<string, string> => {
    if (!value || typeof value !== "object") return {};
    const output: Record<string, string> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      const path = prefix ? `${prefix}.${key}` : key;
      if (nested && typeof nested === "object" && !Array.isArray(nested)) {
        Object.assign(output, flatten(nested, path));
      } else {
        output[path] = JSON.stringify(nested ?? null);
      }
    }
    return output;
  };

  const previous = flatten(before);
  const next = flatten(after);
  const keys = new Set([...Object.keys(previous), ...Object.keys(next)]);
  let changed = 0;
  for (const key of keys) {
    if (previous[key] !== next[key]) changed += 1;
  }
  return changed;
}
const safeAsset = (value: unknown) => {
  const text = clean(value, 1000);
  return !text || text.startsWith("/") || /^https:\/\//i.test(text) ? text : null;
};

export async function GET(req: NextRequest) {
  const actor = await requirePermission(req, "appearance.manage");
  if (!actor) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const { data, error } = await routeServiceClient.from("site_settings")
    .select("site_name,description,public_url,logo_url,primary_color,accent_color,terminology,theme_config,branding_config").eq("singleton", true).maybeSingle();
  if (error || !data) return NextResponse.json({ error: "Could not load appearance." }, { status: 500 });
  const branding = (data.branding_config ?? {}) as Record<string, unknown>;
  return NextResponse.json({
    primaryColor: data.primary_color, accentColor: data.accent_color, theme: normalizeSiteTheme(data.theme_config),
    identity: {
      name: data.site_name ?? "KeyMoura", shortName: branding.shortName ?? data.site_name ?? "KeyMoura",
      tagline: branding.tagline ?? "", description: data.description ?? "", publicUrl: data.public_url ?? "",
      logoUrl: data.logo_url ?? "", wordmarkUrl: branding.wordmarkUrl ?? "", footerLogoUrl: branding.footerLogoUrl ?? "",
      faviconUrl: branding.faviconUrl ?? "/favicon.ico", appleIconUrl: branding.appleIconUrl ?? "/apple-icon.png",
      supportEmail: branding.supportEmail ?? "", copyrightText: branding.copyrightText ?? "All rights reserved.",
      forumLabel: (data.terminology as Record<string, unknown> | null)?.forum ?? "Community",
      knowledgeBaseLabel: (data.terminology as Record<string, unknown> | null)?.knowledgeBase ?? "Projects",
      trustedVendorLabel: (data.terminology as Record<string, unknown> | null)?.trustedVendor ?? "Trusted Shop",
    }
  });
}

export async function PATCH(req: NextRequest) {
  const actor = await requirePermission(req, "appearance.manage");
  if (!actor) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const body = await req.json().catch(() => null) as Record<string, unknown> | null;
  const hex = /^#[0-9a-f]{6}$/i;
  if (!body || typeof body.primaryColor !== "string" || !hex.test(body.primaryColor) ||
      typeof body.accentColor !== "string" || !hex.test(body.accentColor)) {
    return NextResponse.json({ error: "Colors must be six-digit hex values." }, { status: 400 });
  }
  const theme = normalizeSiteTheme(body.theme);
  const identity = body.identity as Record<string, unknown> | null;
  const name = clean(identity?.name, 80);
  const publicUrl = clean(identity?.publicUrl, 500);
  const logoUrl = safeAsset(identity?.logoUrl);
  const wordmarkUrl = safeAsset(identity?.wordmarkUrl);
  const footerLogoUrl = safeAsset(identity?.footerLogoUrl);
  const faviconUrl = safeAsset(identity?.faviconUrl);
  const appleIconUrl = safeAsset(identity?.appleIconUrl);
  const supportEmail = clean(identity?.supportEmail, 254);
  if (!name) return NextResponse.json({ error: "Site name is required." }, { status: 400 });
  if (publicUrl && !/^https?:\/\//i.test(publicUrl)) return NextResponse.json({ error: "Public URL must begin with http:// or https://." }, { status: 400 });
  if ([logoUrl, wordmarkUrl, footerLogoUrl, faviconUrl, appleIconUrl].some(value => value === null)) return NextResponse.json({ error: "Image paths must start with / or https://." }, { status: 400 });
  if (supportEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(supportEmail)) return NextResponse.json({ error: "Support email is not valid." }, { status: 400 });
  const brandingConfig = {
    shortName: clean(identity?.shortName, 30) || name,
    tagline: clean(identity?.tagline, 160), wordmarkUrl, footerLogoUrl, faviconUrl, appleIconUrl,
    supportEmail, copyrightText: clean(identity?.copyrightText, 160) || "All rights reserved.",
  };
  const terminology = {
    forum: clean(identity?.forumLabel, 40) || "Community",
    knowledgeBase: clean(identity?.knowledgeBaseLabel, 40) || "Projects",
    trustedVendor: clean(identity?.trustedVendorLabel, 40) || "Trusted Shop",
  };
  /*
   * Read before the write, so one Save produces one event with a diff of
   * *concepts* rather than a row per token.
   *
   * The appearance editor submits the entire theme on every save — a hundred-odd
   * values, almost all unchanged. Logging each one would bury the fact that
   * somebody changed the site name under ninety-nine identical lines, and
   * logging none would leave "appearance updated" meaning nothing. What is
   * recorded is the handful of named concepts plus a count of theme tokens that
   * actually moved.
   */
  const { data: previous } = await routeServiceClient
    .from("site_settings")
    .select("site_name,public_url,logo_url,primary_color,accent_color,theme_config")
    .eq("singleton", true)
    .maybeSingle();

  const next = {
    site_name: name, description: clean(identity?.description, 300), public_url: publicUrl || null,
    logo_url: logoUrl || null, branding_config: brandingConfig, terminology,
    primary_color: body.primaryColor.toLowerCase(), accent_color: body.accentColor.toLowerCase(),
    theme_config: theme, updated_at: new Date().toISOString(),
  };

  const { error } = await routeServiceClient.from("site_settings").update(next).eq("singleton", true);
  if (error) return NextResponse.json({ error: "Could not save appearance." }, { status: 500 });

  const changes = buildChangeSet(previous ?? {}, next, [
    "site_name",
    "public_url",
    "logo_url",
    "primary_color",
    "accent_color",
  ]);

  const themeTokensChanged = countChangedTokens(
    (previous as { theme_config?: unknown } | null)?.theme_config,
    theme
  );
  if (themeTokensChanged > 0) {
    changes.theme_config = { before: null, after: themeTokensChanged, summarized: false };
  }

  await recordAuditChange({
    action: "settings.appearance_changed",
    actor: {
      kind: "staff",
      userId: actor.userId,
      role: actor.role,
      label: await resolveActorLabel(actor.userId),
    },
    entity: { type: "setting", id: "appearance", label: "Appearance" },
    changes,
    summary: themeTokensChanged > 0 && Object.keys(changes).length === 1
      ? `${themeTokensChanged} theme ${themeTokensChanged === 1 ? "token" : "tokens"} changed`
      : undefined,
    source: "staff_ui",
  });
  revalidatePath("/", "layout");
  return NextResponse.json({ ok: true, primaryColor: body.primaryColor, accentColor: body.accentColor, theme });
}
