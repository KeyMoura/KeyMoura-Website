export type SiteTheme = {
  background: string; backgroundEnd: string; surface: string; surfaceStrong: string;
  text: string; mutedText: string; headingText: string; linkText: string; border: string;
  primaryButtonText: string; secondaryButtonText: string;
  /**
   * Optional overrides. `""` means "follow the accent", which is what these
   * elements have always done — so an existing site renders identically until
   * somebody sets one.
   *
   * They exist because the two elements the shop owner asked about most had no
   * control at all. The "Customizable" badge and the catalog's "Need something
   * else? Start a custom project" button derived every colour from
   * `--brand-accent`, so the only way to change either was to change the accent
   * — which also moves footer links, the request stepper and every accent badge.
   * "Which setting controls this?" had no answer because the setting did not
   * exist.
   *
   * Stored empty rather than pre-filled with the derived hex: a stored colour
   * would freeze the badge at today's accent and silently stop it following a
   * future palette change, which is the behaviour every existing install
   * depends on.
   */
  badgeBackground: string; badgeText: string; badgeBorder: string;
  secondaryButtonBackground: string; secondaryButtonBorder: string;
  /**
   * The primary button's fill and edge.
   *
   * Secondary buttons have had background, border and text since the last
   * pass; primary had only text, so the fill was reachable only through the
   * primary *brand* colour — which also draws prices, section eyebrows, focus
   * outlines and the selected staff sidebar item. "Make the Buy now button
   * green" meant "make every price green" and there was no way to say
   * otherwise.
   *
   * Optional for the same reason as the others: `""` keeps following the
   * brand colour, so an existing site renders identically until somebody sets
   * one, and a future palette change still moves the button.
   */
  primaryButtonBackground: string; primaryButtonBorder: string;
  radius: "soft" | "rounded" | "pill";
  density: "compact" | "comfortable";
  font: "system" | "modern" | "technical";
  primaryButtonStyle: "solid" | "soft" | "outline" | "framed";
  secondaryButtonStyle: "solid" | "soft" | "outline" | "ghost" | "framed";
  tabStyle: "soft" | "framed" | "underline";
  cardStyle: "soft" | "solid" | "outline" | "elevated";
  inputStyle: "soft" | "solid" | "outline" | "filled";
  navigationStyle: "soft" | "framed" | "minimal";
  /**
   * The storefront header's link treatment.
   *
   * `classic` and `soft` are gone. Both drew a filled pill behind the current
   * page — `classic` a black lozenge, `soft` a tinted one — and the pill is what
   * this pass was asked to remove: it made four navigation links read as four
   * buttons, it collided with the utility controls that are *actually* pills, and
   * a storefront's current section is not a pressed control.
   *
   * They are removed from the union rather than left as options nobody should
   * pick, which has a deliberate consequence: `normalizeSiteTheme` refuses a
   * value it does not recognise and falls back to the default, so a site storing
   * `"classic"` renders as `underline` from the next deploy without anybody
   * editing the database. The stored string is untouched and still readable; only
   * its interpretation moved.
   */
  publicNavigationStyle: "underline" | "framed" | "minimal";
  navigationBehavior: "sticky" | "auto-hide";
  navigationDensity: "compact" | "comfortable";
  navigationBackground: string; navigationText: string; navigationActiveText: string; navigationBorder: string;
  navigationHoverBackground: string; navigationHoverText: string;
  navigationUtilityBackground: string; navigationUtilityBorder: string; navigationUtilityText: string;
  navigationUtilityHoverBackground: string; navigationUtilityHoverBorder: string; navigationUtilityHoverText: string;
  navigationBadgeBackground: string; navigationBadgeText: string;
  navigationMobileBackground: string; navigationMobileText: string;
  backgroundStyle: "gradient" | "solid" | "spotlight";
  contentWidth: "standard" | "wide" | "full";
  shadowStyle: "none" | "soft" | "glow";
  borderStrength: "subtle" | "standard" | "strong";
};

export const defaultSiteTheme: SiteTheme = {
  background: "#0a0f10", backgroundEnd: "#050708", surface: "#111827",
  surfaceStrong: "#18181b", text: "#f4f4f5", mutedText: "#a1a1aa",
  headingText: "#ffffff", linkText: "#f59e0b", border: "#3f3f46",
  primaryButtonText: "#09090b", secondaryButtonText: "#f4f4f5",
  badgeBackground: "", badgeText: "", badgeBorder: "",
  secondaryButtonBackground: "", secondaryButtonBorder: "",
  primaryButtonBackground: "", primaryButtonBorder: "",
  radius: "rounded", density: "comfortable", font: "modern",
  primaryButtonStyle: "solid", secondaryButtonStyle: "outline",
  tabStyle: "framed", cardStyle: "soft", inputStyle: "solid",
  navigationStyle: "soft", publicNavigationStyle: "underline", navigationBehavior: "auto-hide",
  navigationDensity: "compact", navigationBackground: "#09090b", navigationText: "#d4d4d8",
  navigationActiveText: "#f59e0b", navigationBorder: "#3f3f46",
  navigationHoverBackground: "#18181b", navigationHoverText: "#ffffff",
  navigationUtilityBackground: "#0a0a0c", navigationUtilityBorder: "#3f3f46", navigationUtilityText: "#f4f4f5",
  navigationUtilityHoverBackground: "#18181b", navigationUtilityHoverBorder: "#52525b", navigationUtilityHoverText: "#ffffff",
  navigationBadgeBackground: "#f59e0b", navigationBadgeText: "#09090b",
  navigationMobileBackground: "#0a0a0c", navigationMobileText: "#f4f4f5",
  backgroundStyle: "gradient", contentWidth: "standard", shadowStyle: "soft", borderStrength: "standard",
};

/**
 * Drops unset overrides so `var(--x, fallback)` can reach its fallback.
 *
 * An empty custom property is still *defined*, so `var()` would resolve it to
 * nothing rather than to the derivation behind it — the badge would lose its
 * colour instead of following the accent. Omitting the declaration entirely is
 * the only thing that keeps "unset" meaning "inherit".
 *
 * Shared by the root layout and the Appearance preview so both express "unset"
 * the same way; a preview that emitted empty strings would show a colourless
 * badge for a setting that renders correctly in production.
 */
export function optionalVars(values: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(values)) {
    if (value) out[name] = value;
  }
  return out;
}

const hex = /^#[0-9a-f]{6}$/i;
const oneOf = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T =>
  typeof value === "string" && allowed.includes(value as T) ? (value as T) : fallback;

export function normalizeSiteTheme(value: unknown): SiteTheme {
  const input = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const color = (key: keyof SiteTheme) => typeof input[key] === "string" && hex.test(input[key] as string) ? input[key] as string : defaultSiteTheme[key] as string;
  /**
   * A colour that may legitimately be unset.
   *
   * `""` is a real value here — "follow the accent" — so it must survive the
   * round trip rather than being replaced by a default. Anything that is
   * neither a hex nor empty is still rejected, so a malformed stored value
   * falls back to inheriting rather than to a hard-coded colour.
   */
  const optionalColor = (key: keyof SiteTheme) => {
    const value = input[key];
    if (typeof value !== "string") return "";
    const trimmed = value.trim();
    return hex.test(trimmed) ? trimmed : "";
  };
  return {
    background: color("background"), backgroundEnd: color("backgroundEnd"), surface: color("surface"),
    surfaceStrong: color("surfaceStrong"), text: color("text"), mutedText: color("mutedText"),
    headingText: color("headingText"), linkText: color("linkText"), border: color("border"),
    primaryButtonText: color("primaryButtonText"), secondaryButtonText: color("secondaryButtonText"),
    badgeBackground: optionalColor("badgeBackground"), badgeText: optionalColor("badgeText"),
    badgeBorder: optionalColor("badgeBorder"),
    secondaryButtonBackground: optionalColor("secondaryButtonBackground"),
    secondaryButtonBorder: optionalColor("secondaryButtonBorder"),
    primaryButtonBackground: optionalColor("primaryButtonBackground"),
    primaryButtonBorder: optionalColor("primaryButtonBorder"),
    navigationBackground: color("navigationBackground"), navigationText: color("navigationText"),
    navigationActiveText: color("navigationActiveText"), navigationBorder: color("navigationBorder"),
    navigationHoverBackground: color("navigationHoverBackground"), navigationHoverText: color("navigationHoverText"),
    navigationBadgeBackground: color("navigationBadgeBackground"), navigationBadgeText: color("navigationBadgeText"),
    navigationMobileBackground: color("navigationMobileBackground"), navigationMobileText: color("navigationMobileText"),
    navigationUtilityBackground: color("navigationUtilityBackground"), navigationUtilityBorder: color("navigationUtilityBorder"),
    navigationUtilityText: color("navigationUtilityText"), navigationUtilityHoverBackground: color("navigationUtilityHoverBackground"),
    navigationUtilityHoverBorder: color("navigationUtilityHoverBorder"), navigationUtilityHoverText: color("navigationUtilityHoverText"),
    radius: oneOf(input.radius, ["soft", "rounded", "pill"] as const, defaultSiteTheme.radius),
    density: oneOf(input.density, ["compact", "comfortable"] as const, defaultSiteTheme.density),
    font: oneOf(input.font, ["system", "modern", "technical"] as const, defaultSiteTheme.font),
    primaryButtonStyle: oneOf(input.primaryButtonStyle ?? input.buttonStyle, ["solid", "soft", "outline", "framed"] as const, defaultSiteTheme.primaryButtonStyle),
    secondaryButtonStyle: oneOf(input.secondaryButtonStyle, ["solid", "soft", "outline", "ghost", "framed"] as const, defaultSiteTheme.secondaryButtonStyle),
    tabStyle: oneOf(input.tabStyle, ["soft", "framed", "underline"] as const, defaultSiteTheme.tabStyle),
    cardStyle: oneOf(input.cardStyle, ["soft", "solid", "outline", "elevated"] as const, defaultSiteTheme.cardStyle),
    inputStyle: oneOf(input.inputStyle, ["soft", "solid", "outline", "filled"] as const, defaultSiteTheme.inputStyle),
    navigationStyle: oneOf(input.navigationStyle, ["soft", "framed", "minimal"] as const, defaultSiteTheme.navigationStyle),
    publicNavigationStyle: oneOf(input.publicNavigationStyle, ["underline", "framed", "minimal"] as const, defaultSiteTheme.publicNavigationStyle),
    navigationBehavior: oneOf(input.navigationBehavior, ["sticky", "auto-hide"] as const, defaultSiteTheme.navigationBehavior),
    navigationDensity: oneOf(input.navigationDensity, ["compact", "comfortable"] as const, defaultSiteTheme.navigationDensity),
    backgroundStyle: oneOf(input.backgroundStyle, ["gradient", "solid", "spotlight"] as const, defaultSiteTheme.backgroundStyle),
    contentWidth: oneOf(input.contentWidth, ["standard", "wide", "full"] as const, defaultSiteTheme.contentWidth),
    shadowStyle: oneOf(input.shadowStyle, ["none", "soft", "glow"] as const, defaultSiteTheme.shadowStyle),
    borderStrength: oneOf(input.borderStrength, ["subtle", "standard", "strong"] as const, defaultSiteTheme.borderStrength),
  };
}
