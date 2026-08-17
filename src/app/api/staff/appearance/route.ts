import { NextRequest, NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { requirePermission, routeServiceClient } from "@/lib/api/routeAuth";
import { normalizeSiteTheme } from "@/theme/runtime";
import { announcementConfigPayload, normalizeAnnouncementConfig } from "@/theme/announcement";
import { brandConfigPayload, normalizeBrandConfig } from "@/theme/brand";
import { homepageConfigPayload, normalizeHomepageConfig } from "@/theme/homepage";
import { buildChangeSet } from "@/lib/audit/diff";
import { recordAuditChange, resolveActorLabel } from "@/lib/audit/events";
import { productImageCandidates } from "@/lib/productImages";

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

type PinnedProduct = { id: string; name: string; slug: string; image: string | null; isPublished: boolean };

/**
 * Names and thumbnails for the homepage's pinned products.
 *
 * Read with the service client on purpose, which is the opposite of what the
 * storefront does. The storefront resolves a pin against the *published* list so
 * a draft can never reach the front page; the editor needs the other behaviour —
 * if somebody unpublishes the featured product, the owner has to be told that,
 * and a picker that silently showed an empty slot would be hiding the fact that
 * the homepage has quietly fallen back to catalog order.
 *
 * So `isPublished` comes back with the row and the editor warns on it. The two
 * readers disagree deliberately, and only one of them renders to customers.
 */
async function loadPinnedProducts(ids: readonly string[]): Promise<Record<string, PinnedProduct>> {
  const wanted = [...new Set(ids.filter(Boolean))];
  if (!wanted.length) return {};
  const { data } = await routeServiceClient
    .from("products")
    .select("id,name,slug,image_url,is_published,archived_at,product_media(url,kind,sort_order)")
    .in("id", wanted);

  const out: Record<string, PinnedProduct> = {};
  for (const row of (data ?? []) as Record<string, unknown>[]) {
    const id = String(row.id);
    out[id] = {
      id,
      name: String(row.name ?? ""),
      slug: String(row.slug ?? ""),
      image: productImageCandidates(row as never)[0] ?? null,
      isPublished: Boolean(row.is_published) && !row.archived_at,
    };
  }
  return out;
}

export async function GET(req: NextRequest) {
  const actor = await requirePermission(req, "appearance.manage");
  if (!actor) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const { data, error } = await routeServiceClient.from("site_settings")
    .select("site_name,description,public_url,logo_url,primary_color,accent_color,theme_config,branding_config").eq("singleton", true).maybeSingle();
  if (error || !data) return NextResponse.json({ error: "Could not load appearance." }, { status: 500 });
  const branding = (data.branding_config ?? {}) as Record<string, unknown>;
  /*
   * One request populates the whole editor.
   *
   * Brand, announcement and homepage are branches of the same `branding_config`
   * document this already reads, so adding three configurable areas added no
   * round trips. The alternative — an endpoint each — is what turns a settings
   * page into six spinners that finish at different times.
   */
  const homepage = normalizeHomepageConfig(branding);
  const pinned = await loadPinnedProducts([homepage.featuredProductId, homepage.heroProductId]);

  return NextResponse.json({
    primaryColor: data.primary_color, accentColor: data.accent_color, theme: normalizeSiteTheme(data.theme_config),
    brand: normalizeBrandConfig(branding, data.logo_url ?? ""),
    announcement: normalizeAnnouncementConfig(branding),
    homepage,
    pinnedProducts: pinned,
    identity: {
      name: data.site_name ?? "KeyMoura", shortName: branding.shortName ?? data.site_name ?? "KeyMoura",
      tagline: branding.tagline ?? "", description: data.description ?? "", publicUrl: data.public_url ?? "",
      logoUrl: data.logo_url ?? "", wordmarkUrl: branding.wordmarkUrl ?? "", footerLogoUrl: branding.footerLogoUrl ?? "",
      faviconUrl: branding.faviconUrl ?? "/favicon.ico", appleIconUrl: branding.appleIconUrl ?? "/apple-icon.png",
      supportEmail: branding.supportEmail ?? "", copyrightText: branding.copyrightText ?? "All rights reserved.",
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
  /*
   * Every new branch is normalized on the way in, by the same module the
   * storefront normalizes with on the way out. A value that fails validation
   * becomes its safe default here rather than being rejected: a mistyped promo
   * end date must not be able to block a save that also renamed the business.
   * The one exception is the announcement link, which is refused loudly below —
   * it is the only field that becomes an `href` on every page of the site.
   */
  const brand = normalizeBrandConfig(body, logoUrl ?? "");
  const announcement = normalizeAnnouncementConfig(body);
  const homepage = normalizeHomepageConfig(body);

  const requestedHref = (body.announcement as Record<string, unknown> | null)?.ctaHref;
  if (typeof requestedHref === "string" && requestedHref.trim() && !announcement.ctaHref) {
    return NextResponse.json(
      { error: "The announcement link must be a path starting with / or an https:// address." },
      { status: 400 }
    );
  }
  if (announcement.startsAt && announcement.endsAt &&
      Date.parse(announcement.endsAt) <= Date.parse(announcement.startsAt)) {
    return NextResponse.json({ error: "The announcement's end time must be after its start time." }, { status: 400 });
  }

  /*
   * The homepage's two buttons are refused loudly for the same reason the
   * announcement link is: they become `href`s above the fold on the site's
   * most-visited page.
   *
   * Normalizing them to "" silently would be worse than rejecting, not better —
   * `resolveHomepageHero` treats an empty destination as "use the shipped
   * button", so a mistyped URL would quietly restore "Shop products" and the
   * owner would publish believing they had changed it.
   */
  const requestedHomepage = (body.homepage as Record<string, unknown> | null) ?? {};
  for (const [field, label] of [
    ["heroPrimaryCtaHref", "main"],
    ["heroSecondaryCtaHref", "second"],
  ] as const) {
    const requested = requestedHomepage[field];
    if (typeof requested === "string" && requested.trim() && !homepage[field]) {
      return NextResponse.json(
        { error: `The homepage's ${label} button link must be a path starting with / or an https:// address.` },
        { status: 400 }
      );
    }
  }

  const brandingConfig = {
    shortName: clean(identity?.shortName, 30) || name,
    tagline: clean(identity?.tagline, 160), wordmarkUrl, footerLogoUrl, faviconUrl, appleIconUrl,
    supportEmail, copyrightText: clean(identity?.copyrightText, 160) || "All rights reserved.",
    brand: brandConfigPayload(brand),
    announcement: announcementConfigPayload(announcement),
    homepage: homepageConfigPayload(homepage),
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
    .select("site_name,public_url,logo_url,primary_color,accent_color,theme_config,branding_config")
    .eq("singleton", true)
    .maybeSingle();

  const next = {
    site_name: name, description: clean(identity?.description, 300), public_url: publicUrl || null,
    /*
     * The legacy column follows the primary slot rather than a field of its own.
     *
     * `logo_url` is read by the installer, by `getSiteSettings`' fallback, and by
     * anything that predates the brand editor. Writing it from the same value the
     * editor sets means there is one primary logo, not two that drift — and
     * `normalizeBrandConfig` seeds the slot *from* this column, so the round trip
     * is stable for a site that has never opened the new editor.
     */
    logo_url: brand.primaryLogoUrl || null, branding_config: brandingConfig,
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

  /*
   * The announcement is logged by value, unlike the theme.
   *
   * A colour change is a design decision and "17 tokens changed" is a fair
   * summary of one. Putting a sentence on every page of the storefront is a
   * publishing action, and the two questions afterwards are always "what did it
   * say" and "when did it go up" — neither of which a count can answer.
   */
  const previousAnnouncement = normalizeAnnouncementConfig(
    (previous as { branding_config?: unknown } | null)?.branding_config
  );
  const announcementChanges = buildChangeSet(
    { announcement_enabled: previousAnnouncement.enabled, announcement_message: previousAnnouncement.message },
    { announcement_enabled: announcement.enabled, announcement_message: announcement.message },
    ["announcement_enabled", "announcement_message"]
  );
  Object.assign(changes, announcementChanges);

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
