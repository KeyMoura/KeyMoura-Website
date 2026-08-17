"use client";

import { Badge, Notice, cx } from "@/components/ui/DesignSystem";
import { APPEARANCE_SETTINGS } from "@/theme/appearanceMap";
import { tasksForSection, type AppearanceSectionId } from "@/theme/appearanceSections";
import { taskById } from "@/theme/appearanceTasks";
import { BUTTON_ROLES } from "@/theme/buttonRoles";
import type { SiteTheme } from "@/theme/runtime";

import { ColorRun, type ColorValues } from "./ColorControls";
import { ControlGroup } from "./EditorChrome";
import { Field, OptionRow } from "./sections";

/**
 * The design-system workspaces: colours, typography, buttons, product cards,
 * forms, layout, business details and the developer reference.
 *
 * Each one is a *workspace*, which is the whole point of the rebuild: opening
 * Product cards shows the card, its badges, its price and its buy button, and
 * nothing about the navbar or the announcement bar. The old editor put every
 * shape control in one section called "Buttons & components" and every colour in
 * another called "Colours", so changing how a product card looked meant working
 * in two places and holding the connection in your head.
 */

export type ThemeEditor = {
  theme: SiteTheme;
  setTheme: <K extends keyof SiteTheme>(key: K, value: SiteTheme[K]) => void;
  colors: ColorValues;
};

/** A choice control with an anchor, so search can land on it. */
function Choice<K extends keyof SiteTheme>({
  anchor,
  label,
  hint,
  editor,
  field,
  options,
}: {
  anchor: string;
  label: string;
  hint?: string;
  editor: ThemeEditor;
  field: K;
  options: readonly { value: SiteTheme[K] & string; label: string; help: string }[];
}) {
  return (
    <div id={`appearance-${anchor}`} tabIndex={-1} className="scroll-mt-4">
      <OptionRow
        label={label}
        hint={hint}
        value={editor.theme[field] as string}
        options={options as readonly { value: string; label: string; help: string }[]}
        onChange={(value) => editor.setTheme(field, value as SiteTheme[K])}
      />
    </div>
  );
}

/* ------------------------------------------------------------------------ */

/**
 * Colors.
 *
 * ## The two halves, and why the second one is links rather than controls
 *
 * The section edits the colours that belong to nothing in particular — the
 * brand pair and the page's own surfaces. Everything else on the site that has
 * a colour has it *as part of something*: the navbar's background belongs to
 * the navbar, the primary button's fill belongs to the button. Those controls
 * stay in the workspace that owns the thing, because editing a navbar with the
 * navbar's shape controls on screen is the whole reason the workspaces exist.
 *
 * That left a real gap, and it is the one the owner reported: if you think
 * "I want to change a colour", Colors is where you look, and Colors held four
 * of the twenty. So the second half is a complete index of every colour in the
 * editor, grouped by what it paints, with a link to the control.
 *
 * **They are links, not a second copy of the controls.** A colour rendered in
 * two places is two `ColorRun`s writing one key — which persists correctly and
 * still produces two DOM anchors with the same id, so the editor's own search
 * would start landing on whichever the browser found first. One canonical
 * control, several ways to reach it, is the same rule the shared-colour
 * `pointer` tasks already follow.
 */
export function ColorsPanel({
  editor,
  onGoTo,
}: {
  editor: ThemeEditor;
  onGoTo: (section: AppearanceSectionId, anchor: string) => void;
}) {
  const tasks = tasksForSection("colors");
  const brand = tasks.filter((task) => task.id.startsWith("brand-") && task.id !== "brand-surfaces");
  const surfaces = tasks.filter((task) => !brand.includes(task));

  return (
    <>
      <ColorRun
        title="Brand"
        description="The two colors everything else is built from. Changing either moves a lot at once, which is what makes them brand colors."
        tasks={brand}
        colors={editor.colors}
      />
      <ColorRun
        title="Surfaces"
        description="The page behind everything, the cards on top of it, and the lines between them."
        tasks={surfaces}
        colors={editor.colors}
        contrastPairs={{ "brand-surfaces": { text: "text", background: "background" } }}
      />

      <ControlGroup
        anchor="colors-index"
        title="Every other color, and where it lives"
        description="Colors that belong to one thing are edited beside that thing. This is the whole list, so nothing has to be hunted for."
      >
        <div className="grid gap-3">
          {COLOR_INDEX.map((group) => (
            <div key={group.section} className="rounded-[var(--control-radius)] border border-brand-border p-3">
              <p className="text-sm font-semibold">{group.title}</p>
              <p className="mt-0.5 text-xs text-brand-textMuted">{group.description}</p>
              <ul className="mt-2 grid gap-1">
                {group.taskIds.map((taskId) => {
                  const task = taskById(taskId);
                  if (!task) return null;
                  return (
                    <li key={taskId}>
                      <button
                        type="button"
                        onClick={() => onGoTo(group.section, `task-${taskId}`)}
                        className="appearance-index-link"
                      >
                        <span className="font-medium">{task.label}</span>
                        <span className="appearance-index-link-go" aria-hidden="true">
                          →
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      </ControlGroup>
    </>
  );
}

/**
 * Every colour the editor holds that is *not* edited in Colors, by purpose.
 *
 * The task ids are the same ones `TASK_SECTION` files, and `ColorsPanel`
 * resolves each through `taskById` so a renamed task shows up as a missing row
 * rather than a wrong label. `appearance-role-coverage.test.ts` asserts the
 * index and the section map name the same set, so a colour added to the editor
 * and not listed here fails rather than quietly becoming undiscoverable again.
 */
export const COLOR_INDEX: readonly {
  section: AppearanceSectionId;
  title: string;
  description: string;
  taskIds: readonly string[];
}[] = [
  {
    section: "navigation",
    title: "Navigation",
    description: "The bar, its links in each state, its round controls, and the panels that drop from it.",
    taskIds: [
      "navbar",
      "navbar-active",
      "advanced-navbar-hover",
      "advanced-utility-buttons",
      "advanced-utility-hover",
      "advanced-count-badge",
      "advanced-menus",
    ],
  },
  {
    section: "components",
    title: "Buttons",
    description: "Two roles with colors of their own. Quiet and destructive buttons deliberately have none.",
    taskIds: ["primary-button", "custom-project-button"],
  },
  {
    section: "commerce",
    title: "Product cards",
    description: "The pills on a card, and the color a price is drawn in.",
    taskIds: ["customizable-badge", "product-price"],
  },
  {
    section: "typography",
    title: "Text",
    description: "Headings, body copy, quiet secondary text, and links inside paragraphs.",
    taskIds: ["brand-text", "advanced-body-links"],
  },
  {
    section: "forms",
    title: "Forms",
    description: "The inside of a text box, and the ring around whatever is selected.",
    taskIds: ["form-input", "form-focus"],
  },
];

export function TypographyPanel({ editor }: { editor: ThemeEditor }) {
  return (
    <>
      <ControlGroup
        anchor="type-font"
        title="Typeface"
        description="One typeface for the whole site — storefront and staff. The preview shows a heading, body copy, quiet text, a price and a button together, because those are the sizes that have to work with each other."
      >
        <Choice
          anchor="type-font"
          label="Typeface"
          editor={editor}
          field="font"
          options={[
            { value: "modern", label: "Modern", help: "Clean interface typography. The KeyMoura default" },
            { value: "system", label: "System", help: "Whatever the reader's device uses" },
            { value: "technical", label: "Technical", help: "Monospace, for a workshop feel" },
          ]}
        />
      </ControlGroup>

      <ColorRun
        title="Text colors"
        description="Headings, body copy, the quieter secondary text under them, and links inside paragraphs."
        tasks={tasksForSection("typography")}
        colors={editor.colors}
        contrastPairs={{ "brand-text": { text: "text", background: "background" } }}
      />

      {/*
        Size and weight are not offered, and saying so is better than an empty
        heading. The type scale is set in `globals.css` against the layout it has
        to fit — a heading size control would be a slider that breaks the
        homepage hero at one end and the staff tables at the other.
      */}
      <Notice>
        Type <b>sizes</b> and <b>weights</b> are set by the design system rather than here: they are tuned
        against the layouts they sit in, and a size that suits the homepage headline breaks the staff tables.
        Overall tightness is under <b>Layout &amp; density</b>.
      </Notice>
    </>
  );
}

/**
 * The four roles, and the real buttons in each.
 *
 * ## Why a wall of text earns its place here
 *
 * This is the answer to the question the editor could not answer: a shape
 * control labelled "Primary buttons" is operable and its consequences are
 * invisible, because nothing on the screen says that it moves Add to cart,
 * Check out, Continue and Submit request, and does not move Back. An owner
 * could only find out by changing it and going to look.
 *
 * The list is generated from `BUTTON_ROLES`, which is checked against the
 * markup rather than written from memory, so it cannot describe a mapping the
 * site does not have. It is a *reference*, not a set of controls — the controls
 * are the colour run and the shape choices below it, one canonical pair per
 * role, exactly as before.
 */
function ButtonRoleMap({ onGoTo }: { onGoTo: (section: AppearanceSectionId, anchor: string) => void }) {
  return (
    <div className="grid gap-3">
      {BUTTON_ROLES.map((role) => (
        <div
          key={role.id}
          id={`appearance-button-role-${role.id}`}
          tabIndex={-1}
          className="scroll-mt-4 rounded-[var(--control-radius)] border border-brand-border p-3"
        >
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <p className="text-sm font-semibold">{role.label}</p>
            {/* A live sample of the role, drawn with the class the storefront
                paints with — so it is the button, not a picture of one. */}
            <span className={`ui-btn ${role.classNames[0]} pointer-events-none !py-1 text-xs`}>
              {role.surfaces[0]?.label ?? role.label}
            </span>
          </div>
          <p className="mt-1 text-xs text-brand-textMuted">{role.description}</p>

          <p className="mt-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-brand-textMuted">Used on</p>
          <ul className="mt-1 grid gap-0.5 sm:grid-cols-2">
            {role.surfaces.map((surface) => (
              <li key={`${role.id}-${surface.label}-${surface.where}`} className="text-xs">
                <span className="font-medium">{surface.label}</span>{" "}
                <span className="text-brand-textMuted">— {surface.where}</span>
              </li>
            ))}
          </ul>

          <p className="mt-2 text-xs text-brand-textMuted">{role.usedFor}</p>

          {role.colorTaskId || role.shapeAnchor ? (
            <div className="ui-action-row mt-2">
              {role.colorTaskId ? (
                <button
                  type="button"
                  onClick={() => onGoTo("components", `task-${role.colorTaskId}`)}
                  className="ui-btn ui-btn-ghost !py-1 text-xs"
                >
                  Edit its colors →
                </button>
              ) : null}
              {role.shapeAnchor ? (
                <button
                  type="button"
                  onClick={() => onGoTo("components", role.shapeAnchor as string)}
                  className="ui-btn ui-btn-ghost !py-1 text-xs"
                >
                  Edit its shape →
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}

export function ComponentsPanel({
  editor,
  onGoTo,
}: {
  editor: ThemeEditor;
  onGoTo: (section: AppearanceSectionId, anchor: string) => void;
}) {
  return (
    <>
      <ControlGroup
        anchor="button-roles"
        title="Which buttons are which"
        description="Every button on the site plays one of four roles. This is which, and where each one appears."
      >
        <ButtonRoleMap onGoTo={onGoTo} />
      </ControlGroup>

      <ColorRun
        title="Button colors"
        description="The two roles that have colors of their own. Quiet buttons follow the page's borders and text; destructive ones are fixed."
        tasks={tasksForSection("components")}
        colors={editor.colors}
        contrastPairs={{
          "primary-button": { text: "primaryButtonText", background: "primaryButtonBackground" },
          "custom-project-button": { text: "secondaryButtonText", background: "secondaryButtonBackground" },
        }}
      />

      <ControlGroup
        anchor="component-primary-shape"
        title="Button shape"
        description="The silhouette each role wears. Colors are above; this is fill versus outline."
      >
        <Choice
          anchor="component-primary-shape"
          label="Primary buttons"
          editor={editor}
          field="primaryButtonStyle"
          options={[
            { value: "solid", label: "Solid", help: "Filled with the button background" },
            { value: "soft", label: "Soft", help: "Low-contrast tint of the brand color" },
            { value: "outline", label: "Outline", help: "Transparent with a clear border" },
            { value: "framed", label: "Framed", help: "The layered style used by account tabs" },
          ]}
        />
        <Choice
          anchor="component-secondary-shape"
          label="Secondary buttons"
          editor={editor}
          field="secondaryButtonStyle"
          options={[
            { value: "outline", label: "Outline", help: "Transparent with a clear border" },
            { value: "solid", label: "Solid", help: "Filled" },
            { value: "soft", label: "Soft", help: "Low-contrast filled treatment" },
            { value: "ghost", label: "Ghost", help: "Quiet until hovered" },
            { value: "framed", label: "Framed", help: "Layered" },
          ]}
        />
      </ControlGroup>

      <ControlGroup
        anchor="component-cards"
        title="Other components"
        description="The shape of the panels, tabs and fields the buttons sit among."
      >
        <Choice
          anchor="component-cards"
          label="Cards & panels"
          editor={editor}
          field="cardStyle"
          options={[
            { value: "soft", label: "Soft", help: "Low-contrast filled panels" },
            { value: "solid", label: "Solid", help: "One flat surface color" },
            { value: "outline", label: "Outline", help: "Transparent with a border" },
            { value: "elevated", label: "Elevated", help: "Raised, with a soft shadow" },
          ]}
        />
        <Choice
          anchor="component-tabs"
          label="Segmented tabs"
          hint="The order filters and the staff view switchers. Not the main site navigation, which follows the storefront header by design."
          editor={editor}
          field="tabStyle"
          options={[
            { value: "framed", label: "Framed", help: "Each tab in its own outline" },
            { value: "soft", label: "Soft", help: "A tinted pill behind the current tab" },
            { value: "underline", label: "Underline", help: "Minimal editorial tabs" },
          ]}
        />
        <Choice
          anchor="component-inputs"
          label="Inputs"
          editor={editor}
          field="inputStyle"
          options={[
            { value: "solid", label: "Solid", help: "A filled field on the page" },
            { value: "soft", label: "Soft", help: "Low-contrast fill" },
            { value: "outline", label: "Outline", help: "Transparent with a border" },
            { value: "filled", label: "Filled", help: "Stronger filled controls" },
          ]}
        />
      </ControlGroup>

      {/*
        The custom request wizard, spelled out.

        It earns a block of its own because it is the one storefront flow that
        is neither the catalog nor the cart, and the pass that fixed its
        low-contrast buttons proved the cost of that: nothing in the editor said
        which of its controls followed which setting, so "the request page looks
        wrong" was not a question this screen could answer. Every row below is a
        class in `globals.css` resolving the named variable — no new theming, no
        per-page override, just the mapping written down.
      */}
      <ControlGroup
        anchor="component-request-flow"
        title="The custom request page"
        description="What /orders/new follows. It has no settings of its own — everything on it is one of the colors you already control."
      >
        <div className="rounded-[var(--control-radius)] border border-brand-border p-3">
          <ul className="grid gap-1.5 text-xs">
            {[
              ["Continue, Submit request", "Primary action", "components", "task-primary-button"],
              ["Review answers", "Secondary action", "components", "task-custom-project-button"],
              ["Back", "Quiet action — page borders and body text", "colors", "task-brand-surfaces"],
              ["The step you are on", "Brand primary", "colors", "task-brand-primary"],
              ["A selected option card", "Brand primary", "colors", "task-brand-primary"],
              ["Focus rings and step headings", "Brand accent", "colors", "task-brand-accent"],
              ["Upload area and text boxes", "Form fields", "forms", "task-form-input"],
            ].map(([what, follows, section, anchor]) => (
              <li key={what} className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="font-medium">{what}</span>
                <button
                  type="button"
                  onClick={() => onGoTo(section as AppearanceSectionId, anchor)}
                  className="appearance-index-link !w-auto text-brand-textMuted"
                >
                  {follows} <span aria-hidden="true">→</span>
                </button>
              </li>
            ))}
          </ul>
          <p className="mt-2.5 text-xs text-brand-textMuted">
            Error and warning messages keep their own red whatever the theme, for the same reason{" "}
            <b>Sold out</b> does.
          </p>
        </div>
      </ControlGroup>

      <ControlGroup
        anchor="component-staff-sidebar"
        title="Staff area"
        description="Changes these admin screens only. Customers never see it."
      >
        <Choice
          anchor="component-staff-sidebar"
          label="Staff sidebar"
          editor={editor}
          field="navigationStyle"
          options={[
            { value: "soft", label: "Soft", help: "A tinted panel behind the current item" },
            { value: "framed", label: "Framed", help: "Outlined items" },
            { value: "minimal", label: "Minimal", help: "Nearly borderless" },
          ]}
        />
      </ControlGroup>
    </>
  );
}

/**
 * Product cards and the buying actions on them.
 *
 * ## Why this section exists at all
 *
 * The brief asked, twice, for "Add to cart" styling to be *discoverable* — and
 * noted that earlier passes had missed the storefront's real CTAs. The colours
 * were never wrong: `.ui-btn-primary`, `.catalog-action-primary` and the card's
 * `.product-card-action` all resolve `--primary-action-bg` from the primary
 * button background, so a shop that sets one has already set all three. The
 * problem was that nothing in the editor said so, so an owner hunting for "the
 * green Add to cart button" had no reason to look under a heading called
 * Buttons.
 *
 * So the CTA block below is not a control. It is the answer to a question, and
 * it links to the control — which is exactly the treatment `appearanceTasks.ts`
 * gives a shared colour, for the same reason: a second control writing the same
 * value is how an editor starts contradicting itself.
 */
export function CommercePanel({
  editor,
  onGoTo,
}: {
  editor: ThemeEditor;
  onGoTo: (section: "components", anchor: string) => void;
}) {
  return (
    <>
      <ControlGroup
        anchor="commerce-cta"
        title="Buying buttons"
        description="Every action a customer presses to buy something."
      >
        <div className="rounded-[var(--control-radius)] border border-brand-border p-3">
          <div className="grid gap-2 sm:grid-cols-2">
            {[
              ["Add to cart", "On a card and on the product page"],
              ["Buy now", "The card's own action"],
              ["Checkout", "The cart drawer and the cart page"],
              ["Customize", "A product that needs configuring first"],
              ["Request a quote", "A made-to-order or unpriced product"],
            ].map(([label, where]) => (
              <div key={label} className="flex items-baseline gap-2">
                <span className="text-sm font-semibold">{label}</span>
                <span className="text-[11px] text-brand-textMuted">{where}</span>
              </div>
            ))}
          </div>
          <p className="mt-3 text-xs text-brand-textMuted">
            All five are your <b>primary button</b>. They share one set of colors, so setting the primary
            button background changes every buying action on the site at once — there is no separate
            &ldquo;Add to cart color&rdquo; hiding anywhere.
          </p>
          <button
            type="button"
            onClick={() => onGoTo("components", "task-primary-button")}
            className="ui-btn ui-btn-secondary mt-3 !py-1.5 text-xs"
          >
            Edit the primary button →
          </button>
        </div>

        {/* "Request a custom version" is the *secondary* role, and that is a
            genuinely surprising fact — it looks like a buying action and is
            coloured like a supporting one. Saying it here is cheaper than
            letting somebody discover it by changing the primary and finding
            this button unchanged. */}
        <div className="rounded-[var(--control-radius)] border border-brand-border p-3">
          <p className="text-sm font-semibold">Request a Custom Version</p>
          <p className="mt-1 text-xs text-brand-textMuted">
            This one is the <b>secondary</b> button, not the primary — it sits beside a buying action rather
            than being one, so it is colored like the catalog&apos;s &ldquo;Start a custom project&rdquo;.
          </p>
          <button
            type="button"
            onClick={() => onGoTo("components", "task-custom-project-button")}
            className="ui-btn ui-btn-ghost mt-2 !py-1.5 text-xs"
          >
            Edit the secondary button →
          </button>
        </div>
      </ControlGroup>

      <ColorRun
        title="Badges and price"
        description="The pills on a product card, and the color its price is drawn in."
        tasks={tasksForSection("commerce")}
        colors={editor.colors}
      />

      <ControlGroup
        anchor="commerce-statuses"
        title="Stock and status"
        description="Which badges you can recolor, and which ones mean something."
      >
        <div className="rounded-[var(--control-radius)] border border-brand-border p-3">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="accent">Customizable</Badge>
            <span className="ui-badge ui-badge-success">In stock</span>
            <span className="ui-badge ui-badge-danger">Sold out</span>
          </div>
          <p className="mt-3 text-xs text-brand-textMuted">
            <b>Customizable</b> is a brand badge and follows your accent color until you give it one of its
            own, above.
          </p>
          <p className="mt-1.5 text-xs text-brand-textMuted">
            <b>In stock</b> and <b>Sold out</b> are deliberately fixed green and red. A status color that
            could be reassigned would stop meaning anything — a Sold out badge in your accent green is a
            product a customer will try to buy.
          </p>
        </div>
      </ControlGroup>
    </>
  );
}

export function FormsPanel({ editor }: { editor: ThemeEditor }) {
  return (
    <>
      <ControlGroup
        anchor="component-inputs"
        title="Field shape"
        description="How a text box or dropdown is drawn. The same control appears under Buttons & components, because it is one setting."
      >
        <Choice
          anchor="forms-input-style"
          label="Inputs"
          editor={editor}
          field="inputStyle"
          options={[
            { value: "solid", label: "Solid", help: "A filled field on the page" },
            { value: "soft", label: "Soft", help: "Low-contrast fill" },
            { value: "outline", label: "Outline", help: "Transparent with a border" },
            { value: "filled", label: "Filled", help: "Stronger filled controls" },
          ]}
        />
      </ControlGroup>

      <ColorRun
        title="Field colors"
        description="What the inside of a field is filled with, and what the focus ring follows."
        tasks={tasksForSection("forms")}
        colors={editor.colors}
      />

      <Notice>
        Field <b>labels</b> use Quiet text and typed <b>values</b> use Body text, both under Typography.
        Outlines use the Border color under Colors. <b>Error</b> messages keep their own red whatever the
        theme, for the same reason Sold out does.
      </Notice>
    </>
  );
}

export function LayoutPanel({ editor }: { editor: ThemeEditor }) {
  return (
    <>
      <ControlGroup
        anchor="layout-radius"
        title="Shape and spacing"
        description="How rounded everything is, and how much room it takes."
      >
        <Choice
          anchor="layout-radius"
          label="Corner shape"
          editor={editor}
          field="radius"
          options={[
            { value: "rounded", label: "Rounded", help: "Balanced everyday corners" },
            { value: "soft", label: "Soft", help: "Barely rounded" },
            { value: "pill", label: "Pill", help: "Fully rounded controls" },
          ]}
        />
        <Choice
          anchor="layout-density"
          label="Spacing"
          editor={editor}
          field="density"
          options={[
            { value: "comfortable", label: "Comfortable", help: "More breathing room" },
            { value: "compact", label: "Compact", help: "Tighter controls and spacing" },
          ]}
        />
        <Choice
          anchor="layout-content-width"
          label="Content width"
          editor={editor}
          field="contentWidth"
          options={[
            { value: "standard", label: "Standard", help: "Comfortable reading width" },
            { value: "wide", label: "Wide", help: "More room for dense staff tools" },
            { value: "full", label: "Full", help: "Nearly all available screen width" },
          ]}
        />
      </ControlGroup>

      <ControlGroup
        anchor="layout-background-style"
        title="Depth"
        description="How strongly surfaces separate from the page and from each other."
      >
        <Choice
          anchor="layout-background-style"
          label="Page background"
          editor={editor}
          field="backgroundStyle"
          options={[
            { value: "gradient", label: "Gradient", help: "Subtle depth from top to bottom" },
            { value: "solid", label: "Solid", help: "One flat surface color" },
            { value: "spotlight", label: "Spotlight", help: "A subtle brand glow behind the page" },
          ]}
        />
        <Choice
          anchor="layout-shadows"
          label="Surface shadows"
          editor={editor}
          field="shadowStyle"
          options={[
            { value: "soft", label: "Soft", help: "A restrained lift under each card" },
            { value: "none", label: "None", help: "Flat surfaces without shadows" },
            { value: "glow", label: "Glow", help: "A restrained brand-tinted glow" },
          ]}
        />
        <Choice
          anchor="layout-border-strength"
          label="Border contrast"
          editor={editor}
          field="borderStrength"
          options={[
            { value: "standard", label: "Standard", help: "The default separation" },
            { value: "subtle", label: "Subtle", help: "Quieter borders between surfaces" },
            { value: "strong", label: "Strong", help: "Higher-contrast borders" },
          ]}
        />
      </ControlGroup>
    </>
  );
}

export type Identity = {
  name: string;
  shortName: string;
  tagline: string;
  description: string;
  publicUrl: string;
  logoUrl: string;
  wordmarkUrl: string;
  footerLogoUrl: string;
  faviconUrl: string;
  appleIconUrl: string;
  supportEmail: string;
  copyrightText: string;
};

export function BusinessPanel({
  identity,
  onChange,
}: {
  identity: Identity;
  onChange: (key: keyof Identity, value: string) => void;
}) {
  return (
    <>
      <ControlGroup
        anchor="business-name"
        title="Names"
        description="Used in page titles, search results and the footer's small print."
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Site name" value={identity.name} onChange={(value) => onChange("name", value)} />
          <Field
            label="Short name"
            hint="Used where space is tight, including beside the header logo."
            value={identity.shortName}
            onChange={(value) => onChange("shortName", value)}
          />
          <Field label="Tagline" value={identity.tagline} onChange={(value) => onChange("tagline", value)} />
          <Field
            label="Copyright text"
            value={identity.copyrightText}
            onChange={(value) => onChange("copyrightText", value)}
          />
        </div>
        <Field
          label="Search-engine description"
          multiline
          hint="One or two sentences, shown under your name in search results."
          value={identity.description}
          onChange={(value) => onChange("description", value)}
        />
      </ControlGroup>

      <ControlGroup
        anchor="business-contact"
        title="Contact"
        description="Where customers reach you, and this site's own address."
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            label="Public site URL"
            value={identity.publicUrl}
            onChange={(value) => onChange("publicUrl", value)}
          />
          <Field
            label="Support email"
            value={identity.supportEmail}
            onChange={(value) => onChange("supportEmail", value)}
          />
        </div>
      </ControlGroup>

      {/*
        These four keep their URL fields on purpose. A favicon and an Apple touch
        icon are build-time files with fixed names that the browser fetches
        directly, not marks the header composes; the footer logo and the
        wordmark are set once and rarely changed. Putting them behind the header
        logo's upload flow would imply the site manages a favicon it does not.
      */}
      <ControlGroup
        anchor="business-icons"
        title="Icons and secondary artwork"
        description="Set once during setup. The header's logo is under Brand, where it can be uploaded."
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            label="Footer logo"
            value={identity.footerLogoUrl}
            onChange={(value) => onChange("footerLogoUrl", value)}
          />
          <Field
            label="Wordmark image (optional)"
            hint="Replaces the site name text beside the header logo."
            value={identity.wordmarkUrl}
            onChange={(value) => onChange("wordmarkUrl", value)}
          />
          <Field
            label="Browser favicon"
            value={identity.faviconUrl}
            onChange={(value) => onChange("faviconUrl", value)}
          />
          <Field
            label="Apple / mobile icon"
            value={identity.appleIconUrl}
            onChange={(value) => onChange("appleIconUrl", value)}
          />
        </div>
      </ControlGroup>
    </>
  );
}

/**
 * The developer reference.
 *
 * ## Why this is a section and not the whole editor
 *
 * The old page was, in effect, a CSS-variable inspector wearing a settings page:
 * thirty-four colour rows, each captioned with the elements it reached. That is
 * genuinely useful information — to somebody editing `globals.css`. It is not
 * what a shop owner opens this page to do, and putting it first is what made
 * every other task hard to find.
 *
 * So the mapping survives in full, once, here — read-only, because every value
 * in it is edited somewhere a person can understand. Nothing is hidden and
 * nothing is duplicated.
 */
export function AdvancedPanel({ editor }: { editor: ThemeEditor }) {
  return (
    <>
      <ControlGroup
        anchor="advanced-tokens"
        title="CSS variables"
        description="Every color on the site, the variable it writes, and what it paints. Read-only — each one is edited in the section named beside it."
      >
        <div className="ui-table-wrap overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="text-brand-textMuted">
              <tr>
                <th scope="col" className="p-2 font-semibold">Setting</th>
                <th scope="col" className="p-2 font-semibold">Variable</th>
                <th scope="col" className="p-2 font-semibold">Value</th>
              </tr>
            </thead>
            <tbody>
              {APPEARANCE_SETTINGS.map((setting) => {
                const value = editor.colors.valueOf(setting);
                return (
                  <tr key={setting.key} className="border-t border-brand-border/60">
                    <td className="p-2 align-top">
                      <span className="font-semibold">{setting.label}</span>
                      <span className="mt-0.5 block text-[11px] text-brand-textMuted">
                        {setting.description}
                      </span>
                    </td>
                    <td className="p-2 align-top font-mono text-[11px] text-brand-textMuted">
                      {setting.variable}
                    </td>
                    <td className="p-2 align-top">
                      <span className="flex items-center gap-1.5">
                        <span
                          aria-hidden="true"
                          className="size-3.5 flex-none rounded-full border border-white/20"
                          style={{ background: value || editor.colors.fallbackOf(setting) }}
                        />
                        <span className="font-mono text-[11px] uppercase">
                          {value || "inherited"}
                        </span>
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </ControlGroup>

      <ControlGroup
        anchor="advanced-choices"
        title="Current theme choices"
        description="The non-color settings, as stored."
      >
        <dl className="grid gap-x-4 gap-y-1.5 text-xs sm:grid-cols-2">
          {(Object.keys(editor.theme) as (keyof SiteTheme)[])
            .filter((key) => !/^#|Color$/.test(String(editor.theme[key])) && !String(editor.theme[key]).startsWith("#"))
            .filter((key) => editor.theme[key] !== "")
            .map((key) => (
              <div key={key} className="flex justify-between gap-3 border-b border-brand-border/40 py-1">
                <dt className="font-mono text-brand-textMuted">{key}</dt>
                <dd className="font-semibold">{String(editor.theme[key])}</dd>
              </div>
            ))}
        </dl>
      </ControlGroup>
    </>
  );
}

/**
 * Navigation, grouped by *state* rather than by rarity.
 *
 * The five navbar tasks that used to live under a collapsed "Advanced"
 * disclosure — hover, the utility buttons, their hover, the count badge and the
 * menu panels — are here, beside the bar they belong to. Filing them by how
 * often they are used is what made "what is the difference between a link at
 * rest, under the pointer, and on the page you are on" a question you had to
 * open a disclosure in a different section to answer.
 */
export function NavigationPanel({ editor }: { editor: ThemeEditor }) {
  const tasks = tasksForSection("navigation");
  const pick = (...ids: string[]) => ids.map((id) => taskById(id)).filter(Boolean) as ReturnType<typeof tasksForSection>;

  return (
    <>
      <ControlGroup
        anchor="nav-current-marker"
        title="Shape and behaviour"
        description="Storefront only. The staff sidebar is under Buttons & components."
      >
        <Choice
          anchor="nav-current-marker"
          label="Current page marker"
          hint="How the header shows which section a customer is in."
          editor={editor}
          field="publicNavigationStyle"
          options={[
            { value: "underline", label: "Underline", help: "A rule under the current link. The KeyMoura default" },
            { value: "framed", label: "Enclosed", help: "Each link in its own outline, like tabs" },
            { value: "minimal", label: "Minimal", help: "Color and weight only, no rule" },
          ]}
        />
        <Choice
          anchor="nav-scroll-behaviour"
          label="When scrolling"
          editor={editor}
          field="navigationBehavior"
          options={[
            { value: "auto-hide", label: "Slide away", help: "Hides going down, returns going up" },
            { value: "sticky", label: "Always visible", help: "Stays put the whole way down" },
          ]}
        />
        <Choice
          anchor="nav-height"
          label="Header height"
          editor={editor}
          field="navigationDensity"
          options={[
            { value: "compact", label: "Compact", help: "60px" },
            { value: "comfortable", label: "Comfortable", help: "68px" },
          ]}
        />
      </ControlGroup>

      <ColorRun
        title="The bar"
        description="The strip itself, and the links on it at rest."
        tasks={pick("navbar")}
        colors={editor.colors}
        contrastPairs={{ navbar: { text: "navigationText", background: "navigationBackground" } }}
      />

      {/*
        Three link states, in the order a customer meets them, under one heading
        that names the distinction. This is the whole of Phase 18: "at rest",
        "under the pointer" and "the page you are on" are the words an owner
        uses, and they were previously spread over two sections and a disclosure.
      */}
      <ColorRun
        title="Link states"
        description="A navbar link has three appearances: at rest (above), under the pointer, and on the page the customer is currently reading."
        tasks={pick("advanced-navbar-hover", "navbar-active")}
        colors={editor.colors}
      />

      <ColorRun
        title="Search, cart and account controls"
        description="The round controls on the right of the header, and the count bubble on the cart."
        tasks={pick("advanced-utility-buttons", "advanced-utility-hover", "advanced-count-badge")}
        colors={editor.colors}
        contrastPairs={{
          "advanced-count-badge": { text: "navigationBadgeText", background: "navigationBadgeBackground" },
        }}
      />

      <ColorRun
        title="Dropdowns and the phone menu"
        description="The More and account panels, and the slide-in menu on phones. These are separate from the bar, which is usually translucent."
        tasks={pick("advanced-menus")}
        colors={editor.colors}
        contrastPairs={{
          "advanced-menus": { text: "navigationMobileText", background: "navigationMobileBackground" },
        }}
      />

      {tasks.length !== 7 ? (
        // A cheap guard against the map and this panel drifting: if a navbar
        // task is added to `TASK_SECTION` and not listed above, it would render
        // nowhere at all.
        <Notice tone="warning">
          {tasks.length - 7} navbar {Math.abs(tasks.length - 7) === 1 ? "color is" : "colors are"} not shown
          here. This is a bug — report it.
        </Notice>
      ) : null}
    </>
  );
}

/** Shared by the sections that only carry a run of colours. */
export function ColorOnlyPanel({
  editor,
  section,
  title,
  description,
}: {
  editor: ThemeEditor;
  section: Parameters<typeof tasksForSection>[0];
  title: string;
  description: string;
}) {
  return (
    <ColorRun
      title={title}
      description={description}
      tasks={tasksForSection(section)}
      colors={editor.colors}
    />
  );
}

export { cx };
