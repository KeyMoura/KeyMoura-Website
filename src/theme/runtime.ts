export type SiteTheme = {
  background: string; backgroundEnd: string; surface: string; surfaceStrong: string;
  text: string; mutedText: string; headingText: string; linkText: string; border: string;
  primaryButtonText: string; secondaryButtonText: string;
  radius: "soft" | "rounded" | "pill";
  density: "compact" | "comfortable";
  font: "system" | "modern" | "technical";
  primaryButtonStyle: "solid" | "soft" | "outline" | "framed";
  secondaryButtonStyle: "solid" | "soft" | "outline" | "ghost" | "framed";
  tabStyle: "soft" | "framed" | "underline";
  cardStyle: "soft" | "solid" | "outline";
  inputStyle: "soft" | "solid" | "outline";
  navigationStyle: "soft" | "framed" | "minimal";
  backgroundStyle: "gradient" | "solid";
  contentWidth: "standard" | "wide";
};

export const defaultSiteTheme: SiteTheme = {
  background: "#0a0f10", backgroundEnd: "#050708", surface: "#111827",
  surfaceStrong: "#18181b", text: "#f4f4f5", mutedText: "#a1a1aa",
  headingText: "#ffffff", linkText: "#f59e0b", border: "#3f3f46",
  primaryButtonText: "#09090b", secondaryButtonText: "#f4f4f5",
  radius: "rounded", density: "comfortable", font: "modern",
  primaryButtonStyle: "solid", secondaryButtonStyle: "outline",
  tabStyle: "framed", cardStyle: "soft", inputStyle: "solid",
  navigationStyle: "soft", backgroundStyle: "gradient", contentWidth: "standard",
};

const hex = /^#[0-9a-f]{6}$/i;
const oneOf = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T =>
  typeof value === "string" && allowed.includes(value as T) ? (value as T) : fallback;

export function normalizeSiteTheme(value: unknown): SiteTheme {
  const input = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const color = (key: keyof SiteTheme) => typeof input[key] === "string" && hex.test(input[key] as string) ? input[key] as string : defaultSiteTheme[key] as string;
  return {
    background: color("background"), backgroundEnd: color("backgroundEnd"), surface: color("surface"),
    surfaceStrong: color("surfaceStrong"), text: color("text"), mutedText: color("mutedText"),
    headingText: color("headingText"), linkText: color("linkText"), border: color("border"),
    primaryButtonText: color("primaryButtonText"), secondaryButtonText: color("secondaryButtonText"),
    radius: oneOf(input.radius, ["soft", "rounded", "pill"] as const, defaultSiteTheme.radius),
    density: oneOf(input.density, ["compact", "comfortable"] as const, defaultSiteTheme.density),
    font: oneOf(input.font, ["system", "modern", "technical"] as const, defaultSiteTheme.font),
    primaryButtonStyle: oneOf(input.primaryButtonStyle ?? input.buttonStyle, ["solid", "soft", "outline", "framed"] as const, defaultSiteTheme.primaryButtonStyle),
    secondaryButtonStyle: oneOf(input.secondaryButtonStyle, ["solid", "soft", "outline", "ghost", "framed"] as const, defaultSiteTheme.secondaryButtonStyle),
    tabStyle: oneOf(input.tabStyle, ["soft", "framed", "underline"] as const, defaultSiteTheme.tabStyle),
    cardStyle: oneOf(input.cardStyle, ["soft", "solid", "outline"] as const, defaultSiteTheme.cardStyle),
    inputStyle: oneOf(input.inputStyle, ["soft", "solid", "outline"] as const, defaultSiteTheme.inputStyle),
    navigationStyle: oneOf(input.navigationStyle, ["soft", "framed", "minimal"] as const, defaultSiteTheme.navigationStyle),
    backgroundStyle: oneOf(input.backgroundStyle, ["gradient", "solid"] as const, defaultSiteTheme.backgroundStyle),
    contentWidth: oneOf(input.contentWidth, ["standard", "wide"] as const, defaultSiteTheme.contentWidth),
  };
}
