import { APPEARANCE_SETTINGS, type AppearanceSetting } from "./appearanceMap";

/**
 * Appearance, expressed as things on the screen rather than as colour tokens.
 *
 * ## Why this layer exists
 *
 * `appearanceMap.ts` already fixed the *labelling* problem: every colour says
 * what it reaches in plain words, and search matches those words. It did not fix
 * the **counting** problem, and that is what the owner reported as "harder to
 * navigate". Thirty-four individually editable colours is thirty-four decisions,
 * and searching "customizable" returned four separate rows — the accent plus
 * three badge tokens — each of which was a plausible answer. Searching "custom
 * project" returned four more. The page answered "which of these?" when the
 * question was "change the badge".
 *
 * A task is one thing an owner would say out loud — "the Customizable badge",
 * "the custom project button", "the navbar" — with the two or three colours that
 * thing actually has, named by the role they play in it: Background, Text,
 * Border. That is the whole idea. Searching "customizable" now returns **one**
 * result, and opening it shows three fields instead of sending you to three
 * places.
 *
 * ## The rules that keep it honest
 *
 * - **Every colour has exactly one home.** Two controls writing one value is how
 *   an editor starts contradicting itself; `appearance-tasks.test.ts` asserts the
 *   partition is total and disjoint.
 * - **Shared colours say so, and are not duplicated.** Prices use the primary
 *   brand colour, and so does the main button. Rather than a second "Product
 *   price" swatch writing the same variable, a `pointer` task explains where it
 *   lives and sends you there. An owner searching "price" still finds something;
 *   what they find is the truth.
 * - **Uncommon colours are in Advanced, not gone.** Everything remains editable.
 *   The hover state of a header utility button is a real setting and a rare one,
 *   and putting it beside "Primary button" is what made the common case hard.
 */

export type AppearanceTaskSection = "brand" | "buttons" | "cards" | "navigation" | "forms" | "advanced";

export type AppearanceFieldRole = "Background" | "Text" | "Border" | "Colour" | "Fade";

export type AppearanceTaskField = {
  role: AppearanceFieldRole;
  key: AppearanceSetting["key"];
};

export type AppearanceTask = {
  id: string;
  /** What an owner would call it. Never a token name. */
  label: string;
  /** One sentence, in the same vocabulary. */
  description: string;
  section: AppearanceTaskSection;
  /** The colours this thing has, in the order they read: fill, then words, then edge. */
  fields: AppearanceTaskField[];
  /** Extra words somebody might type. The label, description and each field's map entry are searched too. */
  keywords?: readonly string[];
  /**
   * This element takes its colour from another task rather than having its own.
   *
   * A pointer has no fields. It exists so that searching for a real thing on the
   * screen — "price", "focus ring" — finds an answer instead of nothing, and the
   * answer is "it follows X", which is the fact the owner needs.
   */
  pointer?: { toTaskId: string; because: string };
};

export const APPEARANCE_TASK_SECTIONS: readonly {
  id: AppearanceTaskSection;
  label: string;
  description: string;
}[] = [
  { id: "brand", label: "Brand", description: "The colours everything else is built from." },
  { id: "buttons", label: "Buttons", description: "The buttons customers press." },
  { id: "cards", label: "Product cards", description: "How a product looks in the catalog." },
  { id: "navigation", label: "Navigation", description: "The bar across the top of every page." },
  { id: "forms", label: "Forms", description: "Text boxes and dropdowns." },
  {
    id: "advanced",
    label: "Advanced",
    description: "Uncommon colours — hover states, dropdown panels and count badges. Everything here is optional.",
  },
];

export const APPEARANCE_TASKS: readonly AppearanceTask[] = [
  // ---- Brand -------------------------------------------------------------
  {
    id: "brand-accent",
    label: "Brand accent",
    description: "The highlight colour. Badges, footer links and the request stepper all follow it.",
    section: "brand",
    fields: [{ role: "Colour", key: "accentColor" }],
    keywords: ["accent", "highlight", "brand", "secondary colour"],
  },
  {
    id: "brand-surfaces",
    label: "Main surfaces",
    description: "The page behind everything, the cards on top of it, and the lines between them.",
    section: "brand",
    fields: [
      { role: "Background", key: "background" },
      { role: "Colour", key: "surface" },
      { role: "Border", key: "border" },
    ],
    keywords: ["background", "page", "card", "panel", "surface", "border", "line", "divider"],
  },
  {
    id: "brand-text",
    label: "Main text",
    description: "Headings, body copy and the quieter secondary text under them.",
    section: "brand",
    fields: [
      { role: "Colour", key: "headingText" },
      { role: "Text", key: "text" },
      { role: "Fade", key: "mutedText" },
    ],
    keywords: ["text", "heading", "title", "body", "copy", "muted", "grey", "gray"],
  },

  // ---- Buttons -----------------------------------------------------------
  {
    id: "primary-button",
    label: "Primary button",
    description: "Add to cart, Checkout, and the main action on every screen.",
    section: "buttons",
    fields: [
      { role: "Background", key: "primaryColor" },
      { role: "Text", key: "primaryButtonText" },
    ],
    keywords: ["primary", "main button", "add to cart", "checkout", "action", "cta", "buy"],
  },
  {
    id: "custom-project-button",
    label: "Custom project button",
    description: "“Need something else? Start a custom project”, and “Request a custom version” on a product.",
    section: "buttons",
    fields: [
      { role: "Background", key: "secondaryButtonBackground" },
      { role: "Text", key: "secondaryButtonText" },
      { role: "Border", key: "secondaryButtonBorder" },
    ],
    keywords: ["custom project", "secondary", "request", "outline", "supporting button", "start a custom project"],
  },

  // ---- Product cards -----------------------------------------------------
  {
    id: "customizable-badge",
    label: "Customizable badge",
    description: "The small “Customizable” pill on product cards, and other accent badges on orders.",
    section: "cards",
    fields: [
      { role: "Background", key: "badgeBackground" },
      { role: "Text", key: "badgeText" },
      { role: "Border", key: "badgeBorder" },
    ],
    keywords: ["customizable", "badge", "pill", "tag", "label", "chip"],
  },
  {
    id: "product-price",
    label: "Product price",
    description: "Prices on cards and on the product page.",
    section: "cards",
    fields: [],
    pointer: {
      toTaskId: "primary-button",
      because: "Prices use the primary brand colour, the same one behind your main button.",
    },
    keywords: ["price", "cost", "amount", "money", "£", "$"],
  },

  // ---- Navigation --------------------------------------------------------
  {
    id: "navbar",
    label: "Navbar",
    description: "The bar across the top of every storefront page, and the links at rest.",
    section: "navigation",
    fields: [
      { role: "Background", key: "navigationBackground" },
      { role: "Text", key: "navigationText" },
      { role: "Border", key: "navigationBorder" },
    ],
    keywords: ["navbar", "header", "top bar", "nav", "menu bar", "navigation"],
  },
  {
    id: "navbar-active",
    label: "Current page link",
    description: "The navbar link for the page the customer is on right now.",
    section: "navigation",
    fields: [{ role: "Colour", key: "navigationActiveText" }],
    keywords: ["active", "current", "selected", "navbar", "highlight"],
  },

  // ---- Forms -------------------------------------------------------------
  {
    id: "form-input",
    label: "Form fields",
    description: "The inside of text boxes and dropdowns.",
    section: "forms",
    fields: [{ role: "Background", key: "surfaceStrong" }],
    keywords: ["input", "field", "form", "text box", "dropdown", "textbox", "search box"],
  },
  {
    id: "form-focus",
    label: "Focus outline",
    description: "The ring around whatever is selected when someone is using a keyboard.",
    section: "forms",
    fields: [],
    pointer: {
      toTaskId: "primary-button",
      because: "The focus ring uses the primary brand colour so it always meets the same contrast as your main button.",
    },
    keywords: ["focus", "outline", "ring", "keyboard", "tab", "accessibility"],
  },

  // ---- Advanced ----------------------------------------------------------
  {
    id: "advanced-page-fade",
    label: "Page background fade",
    description: "Only visible when the page background style is set to Gradient.",
    section: "advanced",
    fields: [{ role: "Fade", key: "backgroundEnd" }],
    keywords: ["gradient", "fade", "background"],
  },
  {
    id: "advanced-body-links",
    label: "Links inside text",
    description: "Links in paragraphs and on policy pages. Buttons and navigation have their own colours.",
    section: "advanced",
    fields: [{ role: "Colour", key: "linkText" }],
    keywords: ["link", "anchor", "hyperlink"],
  },
  {
    id: "advanced-navbar-hover",
    label: "Navbar link hover",
    description: "A header link with the pointer over it.",
    section: "advanced",
    fields: [
      { role: "Background", key: "navigationHoverBackground" },
      { role: "Text", key: "navigationHoverText" },
    ],
    keywords: ["navbar", "hover", "pointer", "mouseover"],
  },
  {
    id: "advanced-utility-buttons",
    label: "Header utility buttons",
    description: "The round search, wishlist, cart, notification and account controls on the right of the header.",
    section: "advanced",
    fields: [
      { role: "Background", key: "navigationUtilityBackground" },
      { role: "Text", key: "navigationUtilityText" },
      { role: "Border", key: "navigationUtilityBorder" },
    ],
    keywords: ["cart", "search", "wishlist", "account", "notification", "icon button", "utility"],
  },
  {
    id: "advanced-utility-hover",
    label: "Header utility hover",
    description: "A header utility control with the pointer over it.",
    section: "advanced",
    fields: [
      { role: "Background", key: "navigationUtilityHoverBackground" },
      { role: "Text", key: "navigationUtilityHoverText" },
      { role: "Border", key: "navigationUtilityHoverBorder" },
    ],
    keywords: ["utility", "hover", "cart", "search"],
  },
  {
    id: "advanced-count-badge",
    label: "Cart and wishlist counts",
    description: "The small circle carrying the number of items, and the unread notification dot.",
    section: "advanced",
    fields: [
      { role: "Background", key: "navigationBadgeBackground" },
      { role: "Text", key: "navigationBadgeText" },
    ],
    keywords: ["count", "cart", "number", "circle", "notification", "dot", "badge"],
  },
  {
    id: "advanced-menus",
    label: "Dropdowns and the phone menu",
    description: "The More and account dropdowns, and the slide-in menu on phones.",
    section: "advanced",
    fields: [
      { role: "Background", key: "navigationMobileBackground" },
      { role: "Text", key: "navigationMobileText" },
    ],
    keywords: ["menu", "dropdown", "drawer", "mobile", "phone", "panel", "popup"],
  },
];

const SETTING_BY_KEY = new Map(APPEARANCE_SETTINGS.map((setting) => [setting.key, setting]));

export function settingFor(key: AppearanceSetting["key"]): AppearanceSetting {
  const setting = SETTING_BY_KEY.get(key);
  // Impossible unless the map and the tasks disagree, which a test forbids.
  if (!setting) throw new Error(`No appearance setting named ${key}`);
  return setting;
}

export function tasksInSection(section: AppearanceTaskSection): AppearanceTask[] {
  return APPEARANCE_TASKS.filter((task) => task.section === section);
}

export function taskById(id: string): AppearanceTask | undefined {
  return APPEARANCE_TASKS.find((task) => task.id === id);
}

/**
 * How well a task answers a query.
 *
 * - `2` — the task *is* the thing asked for: its own name, sentence or keywords
 *   match. "customizable" → Customizable badge.
 * - `1` — the task is *related*: one of its colours mentions the thing in the
 *   colour map's `usedBy` prose. "customizable" → Brand accent, because the badge
 *   follows the accent until it is given its own colour.
 * - `0` — no match.
 *
 * Both are worth returning, and they are emphatically not worth returning in
 * arbitrary order. A strict-equality search would have hidden a true and useful
 * relationship; an unranked one reproduces the original complaint, where every
 * result looked equally likely to be the right one.
 */
export function taskMatchStrength(task: AppearanceTask, query: string): 0 | 1 | 2 {
  const needle = query.trim().toLowerCase();
  if (!needle) return 2;

  const own = [task.label, task.description, ...(task.keywords ?? [])].join(" ").toLowerCase();
  if (own.includes(needle)) return 2;

  const related = task.fields
    .flatMap((field) => {
      const setting = settingFor(field.key);
      return [setting.label, setting.description, ...setting.usedBy, ...(setting.keywords ?? [])];
    })
    .join(" ")
    .toLowerCase();
  return related.includes(needle) ? 1 : 0;
}

/**
 * Search over things, not tokens.
 *
 * The haystack deliberately reaches each field's `usedBy` prose from the colour
 * map, so everything the old per-token search could find is still findable —
 * "cart", "stepper", "eyebrow". The difference is the shape of the answer: one
 * ranked list of *things*, best first, instead of four near-identical token rows
 * with nothing to choose between them. An empty query returns everything in
 * declaration order, so the field can be left alone.
 */
export function searchAppearanceTasks(query: string): AppearanceTask[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...APPEARANCE_TASKS];

  return APPEARANCE_TASKS.map((task) => ({ task, strength: taskMatchStrength(task, needle) }))
    .filter((entry) => entry.strength > 0)
    // Stable within a strength band: `sort` is stable in every engine this runs
    // on, so equally-good results keep their declaration order rather than
    // shuffling between renders.
    .sort((left, right) => right.strength - left.strength)
    .map((entry) => entry.task);
}

/** Tasks that *are* the thing asked for, as opposed to merely related to it. */
export function directTaskMatches(query: string): AppearanceTask[] {
  return APPEARANCE_TASKS.filter((task) => taskMatchStrength(task, query) === 2);
}

/** Every colour key a task owns. Used by the test that proves the partition is total. */
export function ownedKeys(): AppearanceSetting["key"][] {
  return APPEARANCE_TASKS.flatMap((task) => task.fields.map((field) => field.key));
}
