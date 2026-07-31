export type SiteTheme = {
  background: string; backgroundEnd: string; surface: string; surfaceStrong: string;
  text: string; mutedText: string; border: string;
  radius: "soft" | "rounded" | "pill";
  density: "compact" | "comfortable";
  font: "system" | "modern" | "technical";
  buttonStyle: "solid" | "soft" | "outline";
};

export const defaultSiteTheme: SiteTheme = {
  background: "#0a0f10", backgroundEnd: "#050708", surface: "#111827",
  surfaceStrong: "#18181b", text: "#f4f4f5", mutedText: "#a1a1aa", border: "#3f3f46",
  radius: "rounded", density: "comfortable", font: "modern", buttonStyle: "solid",
};

const hex = /^#[0-9a-f]{6}$/i;
const oneOf = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T =>
  typeof value === "string" && allowed.includes(value as T) ? (value as T) : fallback;

export function normalizeSiteTheme(value: unknown): SiteTheme {
  const input = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const color = (key: keyof SiteTheme) => typeof input[key] === "string" && hex.test(input[key] as string) ? input[key] as string : defaultSiteTheme[key] as string;
  return {
    background: color("background"), backgroundEnd: color("backgroundEnd"), surface: color("surface"),
    surfaceStrong: color("surfaceStrong"), text: color("text"), mutedText: color("mutedText"), border: color("border"),
    radius: oneOf(input.radius, ["soft", "rounded", "pill"] as const, defaultSiteTheme.radius),
    density: oneOf(input.density, ["compact", "comfortable"] as const, defaultSiteTheme.density),
    font: oneOf(input.font, ["system", "modern", "technical"] as const, defaultSiteTheme.font),
    buttonStyle: oneOf(input.buttonStyle, ["solid", "soft", "outline"] as const, defaultSiteTheme.buttonStyle),
  };
}
