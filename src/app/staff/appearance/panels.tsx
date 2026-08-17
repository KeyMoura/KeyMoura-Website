"use client";

import { Badge, Notice, cx } from "@/components/ui/DesignSystem";
import { APPEARANCE_SETTINGS } from "@/theme/appearanceMap";
import { tasksForSection } from "@/theme/appearanceSections";
import { taskById } from "@/theme/appearanceTasks";
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

export function ColoursPanel({ editor }: { editor: ThemeEditor }) {
  const tasks = tasksForSection("colours");
  const brand = tasks.filter((task) => task.id.startsWith("brand-") && task.id !== "brand-surfaces");
  const surfaces = tasks.filter((task) => !brand.includes(task));

  return (
    <>
      <ColorRun
        title="Brand"
        description="The two colours everything else is built from. Changing either moves a lot at once, which is what makes them brand colours."
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
    </>
  );
}

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
        title="Text colours"
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

export function ComponentsPanel({ editor }: { editor: ThemeEditor }) {
  return (
    <>
      <ColorRun
        title="Button colours"
        description="Two roles. The primary is every main action — Add to cart, Checkout, Publish. The secondary is the supporting one, including the catalog's “Start a custom project”."
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
        description="The silhouette each role wears. Colours are above; this is fill versus outline."
      >
        <Choice
          anchor="component-primary-shape"
          label="Primary buttons"
          editor={editor}
          field="primaryButtonStyle"
          options={[
            { value: "solid", label: "Solid", help: "Filled with the button background" },
            { value: "soft", label: "Soft", help: "Low-contrast tint of the brand colour" },
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
            { value: "solid", label: "Solid", help: "One flat surface colour" },
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
            All five are your <b>primary button</b>. They share one set of colours, so setting the primary
            button background changes every buying action on the site at once — there is no separate
            &ldquo;Add to cart colour&rdquo; hiding anywhere.
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
            than being one, so it is coloured like the catalog&apos;s &ldquo;Start a custom project&rdquo;.
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
        description="The pills on a product card, and the colour its price is drawn in."
        tasks={tasksForSection("commerce")}
        colors={editor.colors}
      />

      <ControlGroup
        anchor="commerce-statuses"
        title="Stock and status"
        description="Which badges you can recolour, and which ones mean something."
      >
        <div className="rounded-[var(--control-radius)] border border-brand-border p-3">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="accent">Customizable</Badge>
            <span className="ui-badge ui-badge-success">In stock</span>
            <span className="ui-badge ui-badge-danger">Sold out</span>
          </div>
          <p className="mt-3 text-xs text-brand-textMuted">
            <b>Customizable</b> is a brand badge and follows your accent colour until you give it one of its
            own, above.
          </p>
          <p className="mt-1.5 text-xs text-brand-textMuted">
            <b>In stock</b> and <b>Sold out</b> are deliberately fixed green and red. A status colour that
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
        title="Field colours"
        description="What the inside of a field is filled with, and what the focus ring follows."
        tasks={tasksForSection("forms")}
        colors={editor.colors}
      />

      <Notice>
        Field <b>labels</b> use Quiet text and typed <b>values</b> use Body text, both under Typography.
        Outlines use the Border colour under Colours. <b>Error</b> messages keep their own red whatever the
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
            { value: "solid", label: "Solid", help: "One flat surface colour" },
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
        description="Every colour on the site, the variable it writes, and what it paints. Read-only — each one is edited in the section named beside it."
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
        description="The non-colour settings, as stored."
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
            { value: "minimal", label: "Minimal", help: "Colour and weight only, no rule" },
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
          {tasks.length - 7} navbar {Math.abs(tasks.length - 7) === 1 ? "colour is" : "colours are"} not shown
          here. This is a bug — report it.
        </Notice>
      ) : null}
    </>
  );
}

/** Shared by the sections that only carry a run of colours. */
export function ColourOnlyPanel({
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
