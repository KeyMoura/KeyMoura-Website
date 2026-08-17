/**
 * The semantic roles the site's buttons play, and where each one is actually used.
 *
 * ## The problem this answers
 *
 * The editor could already set a primary button's colours and its shape. What
 * it could not say was **which buttons those are**. An owner looking at
 * "Primary buttons — Solid / Soft / Outline / Framed" has no way to know from
 * that screen that the choice moves Add to cart, Check out, Continue and Submit
 * request, and does not move Back or Request a Custom Version. So the controls
 * were operable and the consequences were invisible, and the only way to find
 * out what a setting reached was to change it and go looking.
 *
 * This module is the mapping, written down once. The Buttons workspace renders
 * it, the preview labels its samples from it, and the search index is generated
 * from it — so an owner can type "checkout" or "submit request" or "orders/new"
 * and land on the control that governs it.
 *
 * ## It describes the implementation; it does not create it
 *
 * Every `className` below is a class the storefront really paints with, and
 * every `surfaces` entry is a button that really carries it — checked against
 * the markup rather than described from memory. Nothing here is a new theming
 * mechanism: there is no per-route override, no page-by-page token matrix, and
 * no way to make `/orders/new` a different colour from `/catalog`. A role is a
 * role everywhere it appears, which is the property that makes the mapping
 * worth trusting.
 *
 * ## Why there is no separate "commerce" role
 *
 * It would be a reasonable role to have and this site does not have one. Add to
 * cart, Buy now, Check out and Request a quote are all `.ui-btn-primary` (or
 * `.product-card-cta-primary`, which resolves the same three variables), so a
 * shop that sets the primary button has already set every buying action. Adding
 * a "Commerce primary" entry here would describe a distinction the CSS does not
 * make and the owner could not act on; saying so plainly on the primary role is
 * the honest version, and it is what `usedFor` records.
 *
 * ## Why Danger is listed but not configurable
 *
 * Same reasoning the Sold out badge already follows. A destructive action that
 * could be recoloured to the brand's own green is a destructive action somebody
 * presses by accident. It is in the list because an owner who cannot find it
 * will assume it was forgotten, and the answer "this one is deliberately fixed"
 * is only available if the question can be asked.
 */

export type ButtonRoleId = "primary" | "secondary" | "quiet" | "danger";

export type ButtonSurface = {
  /** The words on the button, as a customer reads them. */
  label: string;
  /** Where it is. Short — this is a caption, not documentation. */
  where: string;
};

export type ButtonRole = {
  id: ButtonRoleId;
  /** What an owner would call it. */
  label: string;
  /** One sentence: what this role is *for*, not what it looks like. */
  description: string;
  /** The classes the storefront paints with. Named so a developer can grep. */
  classNames: readonly string[];
  /**
   * The colour task that owns this role's colours, or null when the role has
   * no colours of its own. Never a second control writing the same value — the
   * editor links to the one that already exists.
   */
  colorTaskId: string | null;
  /** The shape control's anchor, when the role has one. */
  shapeAnchor: string | null;
  /**
   * Where a role's colours come from when it has no task of its own, or the
   * fact an owner needs about the ones it does. Rendered as-is.
   */
  usedFor: string;
  /** The real buttons. Checked against the markup, not recalled. */
  surfaces: readonly ButtonSurface[];
  /** Extra words somebody might type into the editor's search. */
  keywords: readonly string[];
};

export const BUTTON_ROLES: readonly ButtonRole[] = [
  {
    id: "primary",
    label: "Primary action",
    description: "The one thing a screen most wants the customer to do.",
    classNames: ["ui-btn-primary", "catalog-action-primary", "product-card-action", "product-card-cta-primary"],
    colorTaskId: "primary-button",
    shapeAnchor: "component-primary-shape",
    usedFor:
      "Every buying action is this role. There is no separate “Add to cart color” — setting the primary button sets Add to cart, Buy now and Check out together.",
    surfaces: [
      { label: "Add to cart", where: "Product page and product cards" },
      { label: "Check out", where: "Cart page and cart drawer" },
      { label: "Continue", where: "Custom request, /orders/new" },
      { label: "Submit request", where: "Custom request, /orders/new" },
      { label: "Send request", where: "Support" },
      { label: "Start a request", where: "About, Capabilities, Design guide" },
      { label: "View request", where: "Order confirmed" },
    ],
    keywords: [
      "primary", "main button", "add to cart", "buy", "buy now", "cart", "checkout", "check out",
      "continue", "submit", "submit request", "send request", "save", "cta", "action", "purchase",
      "orders/new", "custom request", "commerce",
    ],
  },
  {
    id: "secondary",
    label: "Secondary action",
    description: "The supporting choice beside a primary one — a different route to the same goal.",
    classNames: ["ui-btn-secondary", "catalog-action-secondary", "product-card-cta-secondary"],
    colorTaskId: "custom-project-button",
    shapeAnchor: "component-secondary-shape",
    usedFor:
      "“Request a Custom Version” is this role rather than the primary one: it sits beside a buying action rather than being one.",
    surfaces: [
      { label: "Request a Custom Version", where: "Product page" },
      { label: "Request a quote", where: "A made-to-order or unpriced product card" },
      { label: "Choose options", where: "A product card that needs configuring first" },
      { label: "View details", where: "A product card with nothing to buy yet" },
      { label: "Review answers", where: "Custom request, /orders/new" },
      { label: "View capabilities", where: "About" },
    ],
    keywords: [
      "secondary", "supporting", "custom project", "custom version", "request", "quote",
      "choose options", "customize", "view details", "outline", "review", "orders/new",
    ],
  },
  {
    id: "quiet",
    label: "Quiet action",
    description: "Reversals and asides — present, and deliberately not competing for attention.",
    classNames: ["ui-btn-ghost"],
    // No task of its own, and that is the fact worth surfacing rather than
    // hiding: it follows the surfaces and text colours, so it is already themed.
    colorTaskId: null,
    shapeAnchor: null,
    usedFor:
      "No colors of its own. It follows the Border and Body text colors under Main surfaces and Main text, so it changes with the rest of the page.",
    surfaces: [
      { label: "Back", where: "Custom request, /orders/new" },
      { label: "Continue shopping", where: "Cart" },
      { label: "Clear cart", where: "Cart" },
      { label: "Remove", where: "Cart lines" },
      { label: "Cancel", where: "Dialogs and forms" },
    ],
    keywords: ["quiet", "ghost", "tertiary", "back", "cancel", "remove", "clear", "subtle", "orders/new"],
  },
  {
    id: "danger",
    label: "Destructive action",
    description: "Deleting and declining. Fixed red, on purpose.",
    classNames: ["ui-btn-danger"],
    colorTaskId: null,
    shapeAnchor: null,
    usedFor:
      "Deliberately not themeable, for the same reason Sold out is not: a destructive button in your brand color is one somebody presses by accident.",
    surfaces: [
      { label: "Delete", where: "Staff editors" },
      { label: "Decline proposal", where: "Order proposals" },
      { label: "Cancel order", where: "Order lifecycle" },
    ],
    keywords: ["danger", "destructive", "delete", "remove", "decline", "cancel order", "red"],
  },
];

export function buttonRole(id: ButtonRoleId): ButtonRole {
  const role = BUTTON_ROLES.find((entry) => entry.id === id);
  if (!role) throw new Error(`No button role named ${id}`);
  return role;
}

/** Roles an owner can actually change something about. */
export function configurableButtonRoles(): ButtonRole[] {
  return BUTTON_ROLES.filter((role) => role.colorTaskId !== null || role.shapeAnchor !== null);
}
