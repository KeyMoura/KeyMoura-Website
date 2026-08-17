import type { SiteTheme } from "./runtime";

/**
 * What every appearance colour actually controls, declared once.
 *
 * **The problem this file exists to solve.** The Appearance page labelled its
 * controls with the token's name — "Cards and panels", "Accent / selected
 * states", "Secondary button text" — and said nothing about where any of them
 * land. An owner who wanted to change the white text on the storefront's
 * "Need something else? Start a custom project" button had to already know that
 * the button is a *secondary* button, and then find that colour four levels
 * down inside a collapsed `<details>` labelled "Advanced palette". An owner who
 * wanted to change the "Customizable" badge had no control at all: the badge
 * derives all three of its colours from the accent, which also drives eyebrows,
 * the stepper, footer links and every accent badge.
 *
 * So each entry below carries the three things a label cannot: what it is in
 * plain words, **which real screen elements it changes**, and the words somebody
 * would actually type when hunting for it. The page renders from this; nothing
 * about a control's presentation is written at the call site any more.
 *
 * `usedBy` entries are checked by `tests/appearance-token-map.test.ts` against
 * the components that really consume the variable, so an entry that stops being
 * true fails a test rather than quietly misleading somebody. The same test
 * asserts every colour key on `SiteTheme` appears here exactly once — a new
 * token cannot ship without an explanation.
 */

/** Every `SiteTheme` key whose value is a colour. Choice-valued keys are not listed. */
export type ThemeColorKey = {
  [K in keyof SiteTheme]: SiteTheme[K] extends string
    ? (SiteTheme[K] extends string & Record<never, never> ? K : never)
    : never;
}[keyof SiteTheme];

export type AppearanceGroupId =
  | "brand"
  | "buttons"
  | "badges"
  | "surfaces"
  | "text"
  | "navbar"
  | "navbarMenus";

export type AppearanceSetting = {
  /** The `SiteTheme` key, or `primaryColor` / `accentColor` which live outside the theme object. */
  key: ThemeColorKey | "primaryColor" | "accentColor";
  /** The CSS custom property this writes. Asserted to exist in `globals.css`. */
  variable: string;
  /** Human-readable, in the vocabulary of the thing on screen. */
  label: string;
  /** One sentence. Says what changes, not what the token is called. */
  description: string;
  group: AppearanceGroupId;
  /**
   * Real screen elements this reaches, named the way a person would say them.
   * These are what the preview labels itself with.
   */
  usedBy: readonly string[];
  /** Extra words somebody might search. The label and description are searched too. */
  keywords?: readonly string[];
  /**
   * An optional override: `""` is a real value meaning "follow something else".
   *
   * These get a "following" state rather than a colour swatch that lies about
   * being set. `inheritsFrom` names what it follows in the words the owning
   * control uses.
   *
   * `follows` is the machine-readable half, and it is not decoration: the
   * editor paints the automatic swatch with it, labels the toggle with it, and
   * writes it into the field when somebody turns automatic *off*. Every
   * optional colour used to be assumed to follow the accent, so the two
   * primary-button overrides — which follow the *primary* — showed an orange
   * swatch, said "Use brand accent", and silently repainted the button orange
   * the moment an owner opted out.
   */
  optional?: {
    inheritsFrom: string;
    follows: "accentColor" | "primaryColor" | "primaryButtonBackground";
  };
  /**
   * True when the colour is *shared* — changing it moves several unrelated
   * things. The page warns rather than pretending the control is narrow.
   */
  shared?: boolean;
};

export const APPEARANCE_GROUPS: readonly {
  id: AppearanceGroupId;
  label: string;
  description: string;
  /** Storefront, staff, or both. Mixing them unlabelled is what made this page unreadable. */
  scope: "storefront" | "staff" | "both";
}[] = [
  {
    id: "brand",
    label: "Brand",
    description: "The two colors everything else is built from.",
    scope: "both",
  },
  {
    id: "buttons",
    label: "Buttons",
    description: "The text color on each kind of button. Button shape is set under Styles.",
    scope: "both",
  },
  {
    id: "badges",
    label: "Labels & badges",
    description: "The small pills on product cards and orders. Leave any of these unset to follow the accent color.",
    scope: "both",
  },
  {
    id: "surfaces",
    label: "Surfaces & borders",
    description: "The page behind everything, the cards on top of it, and the lines between.",
    scope: "both",
  },
  {
    id: "text",
    label: "Text",
    description: "Headings, body copy, quiet secondary text and links.",
    scope: "both",
  },
  {
    id: "navbar",
    label: "Navigation bar",
    description: "The header customers see on every storefront page.",
    scope: "storefront",
  },
  {
    id: "navbarMenus",
    label: "Menus & counts",
    description: "Dropdown panels, the phone drawer, and the cart and wishlist counts.",
    scope: "storefront",
  },
  /*
   * There is deliberately no "Staff area" colour group.
   *
   * A first draft had one, and `appearance-token-map.test.ts` refused it as an
   * empty heading — correctly. The staff area has no colour of its own: it
   * shares every surface, text and border colour with the storefront, and its
   * only dedicated control is the sidebar's *shape*, which lives under Shapes &
   * density. A group promising staff-specific colours would have been a
   * heading over somebody else's settings.
   */
];

export const APPEARANCE_SETTINGS: readonly AppearanceSetting[] = [
  // ---- Brand -------------------------------------------------------------
  {
    key: "primaryColor",
    variable: "--brand-primary",
    label: "Primary brand color",
    description: "Your main action color. Used for the most important button on every screen, and for prices.",
    group: "brand",
    shared: true,
    usedBy: [
      "“Buy now” on storefront product cards, unless Primary button background is set",
      "Add to Cart button",
      "Send proposal, Save and Publish buttons",
      "Product prices",
      "Section eyebrows",
      "The selected item in the staff sidebar",
      "Focus outlines",
    ],
    keywords: ["primary", "main", "action", "cta", "price", "button", "accent", "buy now"],
  },
  {
    key: "accentColor",
    variable: "--brand-accent",
    label: "Accent color",
    description: "The secondary highlight. Used for badges, selected states and links in the footer.",
    group: "brand",
    shared: true,
    usedBy: [
      "The “Customizable” badge on product cards, unless Badge background/text/border are set",
      "The custom project button's edge, unless Secondary button border is set",
      "Footer links",
      "The progress stepper on request forms",
      "Hover highlights on staff cards",
    ],
    keywords: ["accent", "secondary", "badge", "customizable", "highlight", "selected", "footer"],
  },

  // ---- Buttons -----------------------------------------------------------
  {
    key: "primaryButtonBackground",
    variable: "--km-primary-button-bg",
    label: "Primary button background",
    description:
      "The fill behind your main action buttons, including the storefront's “Buy now”. Leave unset and it follows the primary brand color.",
    group: "buttons",
    optional: { inheritsFrom: "the primary brand color and the Primary buttons shape", follows: "primaryColor" },
    usedBy: [
      "“Buy now” on storefront product cards",
      "Add to Cart",
      "Checkout",
      "Send proposal, Save and Publish buttons",
    ],
    keywords: ["button", "background", "primary", "fill", "buy now", "add to cart", "cta", "checkout"],
  },
  {
    key: "primaryButtonBorder",
    variable: "--km-primary-button-border",
    label: "Primary button border",
    description: "The edge around your main action buttons.",
    group: "buttons",
    optional: { inheritsFrom: "the primary button background", follows: "primaryButtonBackground" },
    usedBy: ["“Buy now” on storefront product cards", "Add to Cart", "Checkout"],
    keywords: ["button", "border", "primary", "edge", "outline", "buy now"],
  },
  {
    key: "primaryButtonText",
    variable: "--km-primary-button-text",
    label: "Primary button text",
    description:
      "The words on your main action buttons, sitting on the primary button background. Applies while Primary buttons is set to Solid; the Soft, Outline and Framed shapes put the label on the page, so it follows the primary brand color instead.",
    group: "buttons",
    usedBy: [
      "“Buy now” on storefront product cards",
      "Add to Cart",
      "Checkout",
      "Publish appearance",
      "Send proposal",
    ],
    keywords: ["button", "text", "label", "primary", "add to cart", "checkout", "buy now"],
  },
  {
    key: "secondaryButtonText",
    variable: "--km-secondary-button-text",
    label: "Secondary button text",
    description:
      "The words on supporting buttons. This is the white text on the catalog's “Need something else? Start a custom project”.",
    group: "buttons",
    usedBy: [
      "“Need something else? Start a custom project” on the catalog",
      "“Request a Custom Version” on a product",
      "Save draft on the custom request form",
      "Apply to preview on appearance templates",
    ],
    keywords: ["button", "text", "secondary", "custom project", "cta", "white text", "outline"],
  },

  {
    key: "secondaryButtonBackground",
    variable: "--km-secondary-button-bg",
    label: "Secondary button background",
    description:
      "The fill behind supporting buttons, including the catalog's “Need something else? Start a custom project”.",
    group: "buttons",
    optional: { inheritsFrom: "the Secondary buttons shape and the accent color", follows: "accentColor" },
    usedBy: [
      "“Need something else? Start a custom project” on the catalog",
      "“Request a Custom Version” on a product",
      "Save draft on the custom request form",
    ],
    keywords: ["button", "background", "secondary", "fill", "custom project", "cta"],
  },
  {
    key: "secondaryButtonBorder",
    variable: "--km-secondary-button-border",
    label: "Secondary button border",
    description: "The edge around supporting buttons.",
    group: "buttons",
    optional: { inheritsFrom: "the accent color", follows: "accentColor" },
    usedBy: [
      "“Need something else? Start a custom project” on the catalog",
      "“Request a Custom Version” on a product",
    ],
    keywords: ["button", "border", "secondary", "outline", "edge", "custom project"],
  },

  // ---- Labels & badges ---------------------------------------------------
  {
    key: "badgeBackground",
    variable: "--km-badge-bg",
    label: "Badge background",
    description: "The fill behind the “Customizable” badge and every other accent badge.",
    group: "badges",
    optional: { inheritsFrom: "the accent color", follows: "accentColor" },
    usedBy: [
      "The “Customizable” badge on product cards",
      "“In review” and other accent badges on orders",
    ],
    keywords: ["badge", "background", "customizable", "pill", "tag", "label", "fill"],
  },
  {
    key: "badgeText",
    variable: "--km-badge-text",
    label: "Badge text",
    description: "The words inside the “Customizable” badge and other accent badges.",
    group: "badges",
    optional: { inheritsFrom: "the accent color", follows: "accentColor" },
    usedBy: [
      "The word “Customizable” on product cards",
      "“In review” and other accent badges on orders",
    ],
    keywords: ["badge", "text", "customizable", "pill", "tag", "label", "word"],
  },
  {
    key: "badgeBorder",
    variable: "--km-badge-border",
    label: "Badge border",
    description: "The edge around the “Customizable” badge and other accent badges.",
    group: "badges",
    optional: { inheritsFrom: "the accent color and the border color", follows: "accentColor" },
    usedBy: ["The “Customizable” badge on product cards", "Accent badges on orders"],
    keywords: ["badge", "border", "customizable", "outline", "edge", "ring"],
  },

  // ---- Surfaces ----------------------------------------------------------
  {
    key: "background",
    variable: "--km-bg",
    label: "Page background",
    description: "The color behind every page, before any card is drawn on it.",
    group: "surfaces",
    usedBy: ["Every storefront page", "Every staff page"],
    keywords: ["background", "page", "body", "behind"],
  },
  {
    key: "backgroundEnd",
    variable: "--km-bg-end",
    label: "Background fade",
    description: "The color the page background fades towards. Only visible when the background style is Gradient.",
    group: "surfaces",
    usedBy: ["The bottom of every page, when Page background style is Gradient"],
    keywords: ["background", "gradient", "fade", "bottom"],
  },
  {
    key: "surface",
    variable: "--km-surface",
    label: "Card background",
    description: "The panels that sit on top of the page — product cards, staff panels, dialogs.",
    group: "surfaces",
    usedBy: ["Product cards on the catalog", "Cart line items", "Every staff card and panel", "Dialogs"],
    keywords: ["card", "panel", "surface", "product card", "box", "tile"],
  },
  {
    key: "surfaceStrong",
    variable: "--km-surface-strong",
    label: "Input & raised background",
    description: "Slightly stronger than a card. Used inside form fields and for panels raised above other panels.",
    group: "surfaces",
    usedBy: ["Text input and dropdown backgrounds", "Buttons on hover", "The staff sidebar item under the pointer"],
    keywords: ["input", "field", "form", "raised", "hover", "textbox", "dropdown"],
  },
  {
    key: "border",
    variable: "--km-border",
    label: "Border color",
    description: "Every dividing line: card edges, input outlines, table rules and separators.",
    group: "surfaces",
    shared: true,
    usedBy: ["Card edges", "Input outlines", "Table rules", "The line under the navbar"],
    keywords: ["border", "line", "edge", "outline", "divider", "rule", "stroke"],
  },

  // ---- Text --------------------------------------------------------------
  {
    key: "headingText",
    variable: "--km-heading",
    label: "Heading text",
    description: "Page titles and section headings.",
    group: "text",
    usedBy: ["Page titles", "Product names", "Section headings"],
    keywords: ["heading", "title", "h1", "h2", "header text"],
  },
  {
    key: "text",
    variable: "--km-text",
    label: "Body text",
    description: "The main reading color for everything that is not a heading or deliberately quiet.",
    group: "text",
    usedBy: ["Paragraphs", "Table cells", "Form values", "Staff sidebar labels"],
    keywords: ["body", "text", "paragraph", "copy", "main text", "foreground"],
  },
  {
    key: "mutedText",
    variable: "--km-muted",
    label: "Quiet text",
    description: "Secondary information: help text, captions, timestamps and field labels.",
    group: "text",
    usedBy: ["Form field labels", "Help text under inputs", "Timestamps", "Card descriptions", "Breadcrumbs"],
    keywords: ["muted", "secondary", "help", "caption", "grey", "gray", "subtle", "label"],
  },
  {
    key: "linkText",
    variable: "--km-link",
    label: "Link color",
    description: "Links inside body copy. Buttons and navigation links have their own colors.",
    group: "text",
    usedBy: ["Links inside paragraphs", "Links in policy and info pages"],
    keywords: ["link", "anchor", "href", "hyperlink"],
  },

  // ---- Navbar ------------------------------------------------------------
  {
    key: "navigationBackground",
    variable: "--km-nav-bg",
    label: "Navbar background",
    description: "The bar across the top of every storefront page.",
    group: "navbar",
    usedBy: ["The site header"],
    keywords: ["navbar", "header", "top bar", "nav", "menu bar"],
  },
  {
    key: "navigationText",
    variable: "--km-nav-text",
    label: "Navbar link text",
    description: "The navigation links at rest — About, Projects, Catalog.",
    group: "navbar",
    usedBy: ["About, Projects and Catalog links in the header"],
    keywords: ["navbar", "link", "text", "nav", "menu"],
  },
  {
    key: "navigationActiveText",
    variable: "--km-nav-active",
    label: "Current page link",
    description: "The navigation link for the page the customer is on right now.",
    group: "navbar",
    usedBy: ["The highlighted header link", "The wordmark beside it"],
    keywords: ["navbar", "active", "current", "selected", "highlight"],
  },
  {
    key: "navigationBorder",
    variable: "--km-nav-border",
    label: "Navbar border",
    description: "The line under the header, separating it from the page.",
    group: "navbar",
    usedBy: ["The line under the site header"],
    keywords: ["navbar", "border", "underline", "line", "separator"],
  },
  {
    key: "navigationHoverBackground",
    variable: "--km-nav-hover-bg",
    label: "Navbar hover background",
    description: "The shape that appears behind a header link under the pointer.",
    group: "navbar",
    usedBy: ["Header links on hover", "Rows inside the More and account menus"],
    keywords: ["navbar", "hover", "background", "pointer", "mouseover"],
  },
  {
    key: "navigationHoverText",
    variable: "--km-nav-hover-text",
    label: "Navbar hover text",
    description: "The link text under the pointer.",
    group: "navbar",
    usedBy: ["Header links on hover"],
    keywords: ["navbar", "hover", "text", "pointer"],
  },
  {
    key: "navigationUtilityBackground",
    variable: "--km-nav-util-bg",
    label: "Utility button background",
    description: "The round controls on the right of the header: search, wishlist, cart, notifications, account.",
    group: "navbar",
    usedBy: ["Search, wishlist, cart, notifications and account buttons"],
    keywords: ["utility", "cart", "search", "wishlist", "account", "notification", "icon button"],
  },
  {
    key: "navigationUtilityBorder",
    variable: "--km-nav-util-border",
    label: "Utility button border",
    description: "The ring around each header utility control.",
    group: "navbar",
    usedBy: ["The outline on the search, cart and account buttons"],
    keywords: ["utility", "border", "ring", "outline", "cart", "search"],
  },
  {
    key: "navigationUtilityText",
    variable: "--km-nav-util-text",
    label: "Utility button icon",
    description: "The icon inside each header utility control.",
    group: "navbar",
    usedBy: ["The cart, search, wishlist and account icons"],
    keywords: ["utility", "icon", "cart", "search", "symbol"],
  },
  {
    key: "navigationUtilityHoverBackground",
    variable: "--km-nav-util-hover-bg",
    label: "Utility hover background",
    description: "A header utility control under the pointer.",
    group: "navbar",
    usedBy: ["Search, cart and account buttons on hover"],
    keywords: ["utility", "hover", "background", "cart"],
  },
  {
    key: "navigationUtilityHoverBorder",
    variable: "--km-nav-util-hover-border",
    label: "Utility hover border",
    description: "The ring around a header utility control under the pointer.",
    group: "navbar",
    usedBy: ["The outline on utility buttons on hover"],
    keywords: ["utility", "hover", "border", "ring"],
  },
  {
    key: "navigationUtilityHoverText",
    variable: "--km-nav-util-hover-text",
    label: "Utility hover icon",
    description: "The icon inside a header utility control under the pointer.",
    group: "navbar",
    usedBy: ["Utility icons on hover"],
    keywords: ["utility", "hover", "icon"],
  },

  // ---- Menus & counts ----------------------------------------------------
  {
    key: "navigationBadgeBackground",
    variable: "--km-nav-badge-bg",
    label: "Count badge background",
    description: "The small circle carrying the number of items in the cart or wishlist.",
    group: "navbarMenus",
    usedBy: ["The cart count", "The wishlist count", "The unread notification dot"],
    keywords: ["badge", "count", "cart", "number", "circle", "notification", "dot"],
  },
  {
    key: "navigationBadgeText",
    variable: "--km-nav-badge-text",
    label: "Count badge number",
    description: "The digits inside the cart and wishlist counts. They are 10px, so contrast matters here.",
    group: "navbarMenus",
    usedBy: ["The number in the cart count", "The number in the wishlist count"],
    keywords: ["badge", "count", "number", "digit", "cart", "text"],
  },
  {
    key: "navigationMobileBackground",
    variable: "--km-nav-mobile-bg",
    label: "Menu panel background",
    description: "Dropdown panels and the slide-in menu on phones. Separate from the bar, which is usually translucent.",
    group: "navbarMenus",
    usedBy: ["The More dropdown", "The account dropdown", "The phone menu drawer"],
    keywords: ["menu", "dropdown", "drawer", "mobile", "panel", "phone", "popup"],
  },
  {
    key: "navigationMobileText",
    variable: "--km-nav-mobile-text",
    label: "Menu panel text",
    description: "The words inside dropdown panels and the phone menu.",
    group: "navbarMenus",
    usedBy: ["Items in the More dropdown", "Items in the phone menu drawer"],
    keywords: ["menu", "dropdown", "drawer", "mobile", "text", "phone"],
  },
];

/** Settings, keyed by group, in declaration order. */
export function appearanceSettingsByGroup(group: AppearanceGroupId): AppearanceSetting[] {
  return APPEARANCE_SETTINGS.filter((setting) => setting.group === group);
}

/**
 * Free-text search across labels, descriptions, the things each setting reaches,
 * and its extra keywords.
 *
 * Searching `usedBy` is the point: somebody types "customizable" or "cart" —
 * the name of a thing on their screen — not "accent" or "navigationBadge". An
 * empty query returns everything rather than nothing, so the field can be left
 * alone.
 */
export function searchAppearanceSettings(query: string): AppearanceSetting[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...APPEARANCE_SETTINGS];
  return APPEARANCE_SETTINGS.filter((setting) => {
    const haystack = [
      setting.label,
      setting.description,
      ...setting.usedBy,
      ...(setting.keywords ?? []),
    ]
      .join(" ")
      .toLowerCase();
    return haystack.includes(needle);
  });
}

/** Which setting drives a named screen element, for the "what controls this?" lookup. */
export function settingsForElement(element: string): AppearanceSetting[] {
  const needle = element.trim().toLowerCase();
  if (!needle) return [];
  return APPEARANCE_SETTINGS.filter((setting) =>
    setting.usedBy.some((use) => use.toLowerCase().includes(needle))
  );
}
