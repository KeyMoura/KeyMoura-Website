import { APPEARANCE_TASKS, settingFor, type AppearanceTask } from "./appearanceTasks";
import { SECTION_TOGGLES } from "./homepage";

/**
 * The Storefront Control Center's information architecture, declared once.
 *
 * ## What this replaced
 *
 * The editor was three columns — a section list, a settings pane and a permanent
 * preview wall — and it was organised around *where a value is stored*. The
 * navbar's shape lived under "Buttons & components" while its colours lived
 * under "Navigation"; the "Customizable" badge lived under "Labels & badges"
 * while the card it sits on lived under "Colours"; the search box only searched
 * colours, so "announcement" and "logo" matched nothing. An owner looking for
 * one thing had to already know which of those buckets the engineers had put it
 * in.
 *
 * This module is the answer to "where does a setting live", and it is the only
 * answer. Three things read it: the section rail, the workspace that renders one
 * section at a time, and the search. They cannot disagree about the shape of the
 * editor because none of them holds an opinion about it.
 *
 * ## What happened to "Labels"
 *
 * The editor's "Labels & wording" section was removed a pass ago — it wrote
 * `site_settings.terminology`, which nothing rendered. What survived was the
 * *colour group* still called "Labels & badges" in `appearanceMap.ts`, holding
 * the three badge tokens, and that name was the remaining half of the same
 * problem: a shop owner looking for the "Customizable" pill on a product card
 * does not look under Labels.
 *
 * So there is no Labels section here. The badge colours are in **Product cards
 * & commerce**, beside the card they appear on and the CTA beneath them. The
 * tokens are untouched, the colour group in `appearanceMap.ts` is untouched —
 * what moved is which workspace draws the control, which is exactly the layer
 * that is allowed to move without a database change.
 *
 * ## Grouping
 *
 * The rail is clustered rather than flat. Thirteen equal entries is a list to
 * read; three clusters of four is a place to look. The clusters answer "am I
 * changing what customers see, how the whole system looks, or how the business
 * is described" — which is the first branch an owner actually makes.
 */

export type AppearanceSectionId =
  | "brand"
  | "navigation"
  | "announcement"
  | "homepage"
  | "colours"
  | "typography"
  | "components"
  | "commerce"
  | "forms"
  | "layout"
  | "business"
  | "templates"
  | "advanced";

export type AppearanceClusterId = "storefront" | "system" | "site";

export const APPEARANCE_CLUSTERS: readonly {
  id: AppearanceClusterId;
  label: string;
}[] = [
  { id: "storefront", label: "Storefront" },
  { id: "system", label: "Design system" },
  { id: "site", label: "Site" },
];

export type AppearanceSectionDef = {
  id: AppearanceSectionId;
  cluster: AppearanceClusterId;
  /** The rail label. Short — the rail is a rail, not a paragraph. */
  label: string;
  /** One sentence under the section title. Not a paragraph, and not a tutorial. */
  description: string;
  /** Whether this section has a preview worth showing, and what it previews. */
  preview?: AppearancePreviewId;
};

/**
 * Which real component a section previews.
 *
 * Every one of these mounts production markup or the production class the
 * storefront paints with. There is no abstract "sample card" any more: the old
 * preview column carried nine invented blocks, each with a paragraph explaining
 * which token drove it, and a preview that has to explain itself is a diagram.
 */
export type AppearancePreviewId =
  | "header"
  | "announcement"
  | "homepage"
  | "palette"
  | "type"
  | "controls"
  | "productCard"
  | "form";

export const APPEARANCE_SECTIONS: readonly AppearanceSectionDef[] = [
  {
    id: "brand",
    cluster: "storefront",
    label: "Brand",
    description: "Your logo files, which one each page uses, and whether the site name sits beside it.",
    preview: "header",
  },
  {
    id: "navigation",
    cluster: "storefront",
    label: "Navigation",
    description: "The header customers see on every page — its shape, its colours, and how links look at rest, under the pointer, and on the current page.",
    preview: "header",
  },
  {
    id: "announcement",
    cluster: "storefront",
    label: "Announcement bar",
    description: "The message strip across the top of the storefront: launches, promotions, discount codes, lead times.",
    preview: "announcement",
  },
  {
    id: "homepage",
    cluster: "storefront",
    label: "Homepage",
    description: "The words and image at the top of the front page, which products lead it, and which bands appear.",
    preview: "homepage",
  },
  {
    id: "colours",
    cluster: "system",
    label: "Colours",
    description: "The page, the cards on it, and the text — grouped by what each colour actually paints.",
    preview: "palette",
  },
  {
    id: "typography",
    cluster: "system",
    label: "Typography",
    description: "The typeface the whole site is set in, and the text colours that go with it.",
    preview: "type",
  },
  {
    id: "components",
    cluster: "system",
    label: "Buttons & components",
    description: "The buttons customers press, and the shape of cards, tabs and panels around them.",
    preview: "controls",
  },
  {
    id: "commerce",
    cluster: "system",
    label: "Product cards",
    description: "How a product looks in the catalog: the card, the price, the badges, and the Add to cart button.",
    preview: "productCard",
  },
  {
    id: "forms",
    cluster: "system",
    label: "Forms",
    description: "Text boxes, dropdowns and the labels above them.",
    preview: "form",
  },
  {
    id: "layout",
    cluster: "system",
    label: "Layout & density",
    description: "Corner rounding, spacing, content width and how strongly surfaces separate from each other.",
    preview: "controls",
  },
  {
    id: "business",
    cluster: "site",
    label: "Business details",
    description: "Name, public address, support email, icons and the footer's small print.",
  },
  {
    id: "templates",
    cluster: "site",
    label: "Saved looks",
    description: "Save a complete look, try one before publishing, and manage the ones you have.",
  },
  {
    id: "advanced",
    cluster: "site",
    label: "Advanced",
    description: "The CSS variable behind every colour, for anyone working on the site's code. Nothing here needs setting.",
  },
];

const SECTION_BY_ID = new Map(APPEARANCE_SECTIONS.map((section) => [section.id, section]));

export function appearanceSection(id: AppearanceSectionId): AppearanceSectionDef {
  const section = SECTION_BY_ID.get(id);
  if (!section) throw new Error(`No appearance section named ${id}`);
  return section;
}

/**
 * Which workspace draws each colour task.
 *
 * The tasks themselves are declared in `appearanceTasks.ts` with their own
 * sections, and those stay as they are — that file owns the rule that every
 * colour has exactly one home, and a test proves the partition is total. This
 * map is a *presentation* decision layered over it, and it differs in two ways
 * that matter.
 *
 * **The old Advanced is mostly gone.** Seven tasks were filed there by rarity:
 * the page fade, body links, navbar hover, the two utility-button tasks, the
 * count badge and the menu panels. Five of those seven are navbar states, and
 * filing them under "Advanced" is what made Phase 18's question — what is the
 * difference between a link at rest, under the pointer, and on the current page
 * — unanswerable without opening a disclosure in a different section. They are
 * in Navigation now, grouped by state. The remaining two are ordinary colours
 * and sit with the colours they belong to.
 *
 * **Badges moved to the card they appear on.** See the note on "Labels" above.
 */
const TASK_SECTION: Readonly<Record<string, AppearanceSectionId>> = {
  "brand-primary": "colours",
  "brand-accent": "colours",
  "brand-surfaces": "colours",
  "brand-text": "typography",
  "advanced-page-fade": "colours",
  "advanced-body-links": "typography",

  "primary-button": "components",
  "custom-project-button": "components",

  "customizable-badge": "commerce",
  "product-price": "commerce",

  navbar: "navigation",
  "navbar-active": "navigation",
  "advanced-navbar-hover": "navigation",
  "advanced-utility-buttons": "navigation",
  "advanced-utility-hover": "navigation",
  "advanced-count-badge": "navigation",
  "advanced-menus": "navigation",

  "form-input": "forms",
  "form-focus": "forms",
};

export function sectionForTask(taskId: string): AppearanceSectionId {
  return TASK_SECTION[taskId] ?? "colours";
}

/** Every colour task a section draws, in declaration order. */
export function tasksForSection(section: AppearanceSectionId): AppearanceTask[] {
  return APPEARANCE_TASKS.filter((task) => sectionForTask(task.id) === section);
}

/* ------------------------------------------------------------------------ */
/* The search index                                                          */
/* ------------------------------------------------------------------------ */

/**
 * One findable setting.
 *
 * The old search covered colours only, because it was a filter over the colour
 * list rather than an index. Typing "announcement" — the single most obvious
 * thing to type — matched nothing at all, and typing "logo" matched nothing,
 * and typing "featured product" matched nothing. Those are not edge cases; they
 * are three of the six tasks this pass was asked to make easy.
 *
 * So a result is any control an owner can operate, wherever it lives and
 * whatever kind of value it holds. `anchor` is the DOM id the workspace gives
 * that control, which is what makes a result *navigable* rather than merely
 * informative: choosing it opens the section, scrolls to the control and puts
 * focus in it.
 */
export type AppearanceSearchEntry = {
  /** Stable id, unique across the whole editor. Also the DOM anchor suffix. */
  anchor: string;
  label: string;
  section: AppearanceSectionId;
  /** One short phrase. What this changes, in the words of the thing on screen. */
  context: string;
  keywords?: readonly string[];
};

/**
 * The controls that are not colours.
 *
 * Written out rather than derived, because there is nothing to derive them
 * from: a shape choice, a logo slot and a promotional message have no shared
 * declaration the way the colour tokens do. The cost is that a new control has
 * to be added here to be findable, and the test suite asserts the reverse
 * direction — every anchor named here is rendered by the workspace — so a stale
 * entry fails rather than sending somebody to a control that no longer exists.
 */
const NON_COLOUR_ENTRIES: readonly AppearanceSearchEntry[] = [
  // ---- Brand -------------------------------------------------------------
  {
    anchor: "brand-primary-logo",
    label: "Primary logo",
    section: "brand",
    context: "Upload the main mark the header draws",
    keywords: ["logo", "upload", "mark", "image", "brand", "png", "webp", "file"],
  },
  {
    anchor: "brand-alternate-logo",
    label: "Alternate logo",
    section: "brand",
    context: "A second mark — often white — for darker pages",
    keywords: ["logo", "white", "alternate", "second", "upload", "interior", "dark"],
  },
  {
    anchor: "brand-homepage-logo",
    label: "Homepage logo",
    section: "brand",
    context: "Which mark the front page's header uses",
    keywords: ["logo", "homepage", "home", "front page", "which"],
  },
  {
    anchor: "brand-interior-logo",
    label: "Interior-page logo",
    section: "brand",
    context: "Which mark every other page's header uses",
    keywords: ["logo", "interior", "catalog", "other pages", "inside", "which"],
  },
  {
    anchor: "brand-show-name",
    label: "Site name beside the logo",
    section: "brand",
    context: "Whether the words sit next to the mark in the header",
    keywords: ["name", "wordmark", "text", "keymoura", "beside", "show", "hide", "title"],
  },

  // ---- Navigation --------------------------------------------------------
  {
    anchor: "nav-current-marker",
    label: "Current page marker",
    section: "navigation",
    context: "How the header shows which section a customer is in",
    keywords: ["active", "current", "underline", "marker", "navbar", "selected", "highlight"],
  },
  {
    anchor: "nav-scroll-behaviour",
    label: "Header when scrolling",
    section: "navigation",
    context: "Whether the header slides away or stays visible",
    keywords: ["sticky", "scroll", "hide", "auto-hide", "navbar", "fixed"],
  },
  {
    anchor: "nav-height",
    label: "Header height",
    section: "navigation",
    context: "Compact or comfortable navbar height",
    keywords: ["height", "navbar", "density", "compact", "tall", "size"],
  },

  // ---- Announcement ------------------------------------------------------
  {
    anchor: "announcement-enabled",
    label: "Show the announcement bar",
    section: "announcement",
    context: "Turns the strip at the top of the storefront on or off",
    keywords: ["announcement", "banner", "bar", "on", "off", "enable", "strip", "promo"],
  },
  {
    anchor: "announcement-message",
    label: "Announcement message",
    section: "announcement",
    context: "The sentence customers read across the top of every page",
    keywords: ["announcement", "message", "text", "promo", "sale", "discount code", "launch", "banner"],
  },
  {
    anchor: "announcement-label",
    label: "Announcement label",
    section: "announcement",
    context: "The short pill before the message — NEW, SALE",
    keywords: ["announcement", "label", "pill", "tag", "new", "sale", "badge"],
  },
  {
    anchor: "announcement-link",
    label: "Announcement link",
    section: "announcement",
    context: "An optional call to action at the end of the message",
    keywords: ["announcement", "link", "cta", "url", "href", "destination", "shop the sale"],
  },
  {
    anchor: "announcement-tone",
    label: "Announcement colour",
    section: "announcement",
    context: "Accent, brand or quiet — all built from colours you already control",
    keywords: ["announcement", "tone", "colour", "color", "background", "accent", "brand", "quiet"],
  },
  {
    anchor: "announcement-dismissible",
    label: "Let customers dismiss it",
    section: "announcement",
    context: "Whether the bar can be closed, and for how long",
    keywords: ["announcement", "dismiss", "close", "hide", "x"],
  },
  {
    anchor: "announcement-schedule",
    label: "Announcement schedule",
    section: "announcement",
    context: "Start and end times for a timed promotion",
    keywords: ["announcement", "schedule", "start", "end", "date", "time", "timed", "promotion"],
  },

  // ---- Homepage ----------------------------------------------------------
  {
    anchor: "homepage-hero-copy",
    label: "Homepage headline",
    section: "homepage",
    context: "The eyebrow, headline and paragraph at the top of the front page",
    keywords: ["hero", "headline", "title", "heading", "homepage", "eyebrow", "copy", "words", "lede", "paragraph"],
  },
  {
    anchor: "homepage-hero-ctas",
    label: "Homepage buttons",
    section: "homepage",
    context: "The two buttons under the headline, and where they go",
    keywords: ["hero", "cta", "button", "homepage", "shop", "custom project", "link", "destination"],
  },
  {
    anchor: "homepage-hero-image",
    label: "Homepage hero image",
    section: "homepage",
    context: "Upload the picture in the large frame above the fold",
    keywords: ["hero", "image", "picture", "photo", "homepage", "upload", "media", "artwork", "banner"],
  },
  {
    anchor: "homepage-featured-product",
    label: "Featured product",
    section: "homepage",
    context: "Which product fills the large focus frame on the homepage",
    keywords: ["featured", "product", "homepage", "focus", "pin", "highlight", "which product"],
  },
  {
    anchor: "homepage-hero-product",
    label: "Hero product",
    section: "homepage",
    context: "Which product's photograph leads the homepage, when no image is uploaded",
    keywords: ["hero", "product", "homepage", "lead", "pin", "photo", "top"],
  },
  {
    anchor: "homepage-sections",
    label: "Homepage sections",
    section: "homepage",
    context: "Which optional bands appear on the front page",
    keywords: ["homepage", "section", "show", "hide", "band", "visibility", "process", "recent work"],
  },

  // ---- Typography --------------------------------------------------------
  {
    anchor: "type-font",
    label: "Typeface",
    section: "typography",
    context: "The type the whole site is set in",
    keywords: ["font", "typeface", "typography", "type", "family", "modern", "system", "monospace"],
  },

  // ---- Components --------------------------------------------------------
  {
    anchor: "component-primary-shape",
    label: "Primary button shape",
    section: "components",
    context: "Solid, soft, outline or framed — for Add to cart and Checkout",
    keywords: ["button", "shape", "primary", "solid", "outline", "add to cart", "checkout", "style", "buy"],
  },
  {
    anchor: "component-secondary-shape",
    label: "Secondary button shape",
    section: "components",
    context: "The shape of supporting buttons like Start a custom project",
    keywords: ["button", "shape", "secondary", "outline", "ghost", "custom project", "style"],
  },
  {
    anchor: "component-tabs",
    label: "Segmented tabs",
    section: "components",
    context: "The order filters and staff view switchers",
    keywords: ["tabs", "segmented", "switcher", "filter", "pills"],
  },
  {
    anchor: "component-cards",
    label: "Cards & panels",
    section: "components",
    context: "The shape of every panel on the site",
    keywords: ["card", "panel", "shape", "elevated", "outline", "surface"],
  },
  {
    anchor: "component-inputs",
    label: "Input shape",
    section: "components",
    context: "The treatment of text boxes and dropdowns",
    keywords: ["input", "field", "shape", "textbox", "form", "filled", "outline"],
  },
  {
    anchor: "component-staff-sidebar",
    label: "Staff sidebar",
    section: "components",
    context: "The staff area's own navigation. Customers never see it",
    keywords: ["staff", "sidebar", "admin", "navigation", "internal"],
  },

  // ---- Commerce ----------------------------------------------------------
  {
    anchor: "commerce-cta",
    label: "Add to cart button",
    section: "commerce",
    context: "Every storefront buying action, and where its colours come from",
    keywords: [
      "add to cart", "buy", "buy now", "cart", "checkout", "cta", "purchase", "customize",
      "commerce", "button", "request",
    ],
  },
  {
    anchor: "commerce-statuses",
    label: "Stock and status badges",
    section: "commerce",
    context: "In stock, Sold out and Made to order, and which of them you can recolour",
    keywords: ["status", "stock", "sold out", "made to order", "badge", "availability", "semantic", "green", "red"],
  },

  // ---- Layout ------------------------------------------------------------
  {
    anchor: "layout-radius",
    label: "Corner shape",
    section: "layout",
    context: "How rounded every control and card is",
    keywords: ["radius", "corner", "round", "pill", "square", "shape", "rounding"],
  },
  {
    anchor: "layout-density",
    label: "Spacing",
    section: "layout",
    context: "Compact or comfortable spacing across the site",
    keywords: ["density", "spacing", "compact", "comfortable", "padding", "tight", "room"],
  },
  {
    anchor: "layout-content-width",
    label: "Content width",
    section: "layout",
    context: "How wide a page's content runs before it stops",
    keywords: ["width", "content", "wide", "narrow", "container", "full"],
  },
  {
    anchor: "layout-background-style",
    label: "Page background style",
    section: "layout",
    context: "Flat, a gradient, or a brand-tinted glow",
    keywords: ["background", "gradient", "solid", "spotlight", "page", "behind"],
  },
  {
    anchor: "layout-shadows",
    label: "Surface shadows",
    section: "layout",
    context: "How much every card lifts off the page",
    keywords: ["shadow", "elevation", "glow", "depth", "flat"],
  },
  {
    anchor: "layout-border-strength",
    label: "Border contrast",
    section: "layout",
    context: "How strongly the lines between surfaces read",
    keywords: ["border", "contrast", "line", "divider", "subtle", "strong"],
  },

  // ---- Business ----------------------------------------------------------
  {
    anchor: "business-name",
    label: "Site name",
    section: "business",
    context: "Used in page titles, search results and the footer",
    keywords: ["name", "business", "site name", "title", "company"],
  },
  {
    anchor: "business-contact",
    label: "Support email and public address",
    section: "business",
    context: "Where customers reach you, and this site's own URL",
    keywords: ["email", "support", "contact", "url", "address", "public"],
  },
  {
    anchor: "business-icons",
    label: "Favicon and secondary artwork",
    section: "business",
    context: "The browser tab icon, the Apple touch icon and the footer logo",
    keywords: ["favicon", "icon", "apple", "tab", "footer logo", "wordmark", "browser"],
  },
];

/**
 * Every findable control in the editor.
 *
 * The colour tasks are folded in from `APPEARANCE_TASKS` rather than restated,
 * so a colour cannot be searchable here and absent from the workspace, or
 * described differently in the two places. Their context sentence is the task's
 * own description, which is already written in the vocabulary of the thing on
 * screen.
 */
export const APPEARANCE_SEARCH_INDEX: readonly AppearanceSearchEntry[] = [
  ...APPEARANCE_TASKS.map((task) => ({
    anchor: `task-${task.id}`,
    label: task.label,
    section: sectionForTask(task.id),
    context: task.description,
    keywords: [
      ...(task.keywords ?? []),
      // The screen elements each of this task's colours actually reaches.
      // Searching "cart", "stepper" or "eyebrow" has always worked against
      // these; folding them in keeps that true now the index is wider.
      ...task.fields.flatMap((field) => {
        const setting = settingFor(field.key);
        return [...setting.usedBy, ...(setting.keywords ?? [])];
      }),
    ],
  })),
  ...NON_COLOUR_ENTRIES,
  ...SECTION_TOGGLES.map((toggle) => ({
    anchor: `homepage-section-${toggle.id}`,
    label: `${toggle.label} section`,
    section: "homepage" as const,
    context: `Show or hide this band: ${toggle.description}`,
    keywords: ["homepage", "section", "show", "hide", toggle.label.toLowerCase()],
  })),
];

/**
 * How well an entry answers a query.
 *
 * `2` — the label or context says it. `1` — only a keyword does. Ranking them
 * apart matters for the same reason it did in `appearanceTasks.ts`: an unranked
 * list where six results look equally plausible reproduces the complaint that
 * started all of this. "cart" should lead with the Add to cart button, not with
 * the count badge that happens to mention carts.
 */
export function searchMatchStrength(entry: AppearanceSearchEntry, query: string): 0 | 1 | 2 {
  const needle = query.trim().toLowerCase();
  if (!needle) return 2;
  if (`${entry.label} ${entry.context}`.toLowerCase().includes(needle)) return 2;
  return (entry.keywords ?? []).some((word) => word.toLowerCase().includes(needle)) ? 1 : 0;
}

/** Ranked results across every section. An empty query returns nothing, not everything. */
export function searchAppearance(query: string): AppearanceSearchEntry[] {
  if (!query.trim()) return [];
  return APPEARANCE_SEARCH_INDEX.map((entry) => ({
    entry,
    strength: searchMatchStrength(entry, query),
  }))
    .filter((row) => row.strength > 0)
    .sort((left, right) => right.strength - left.strength)
    .map((row) => row.entry);
}
