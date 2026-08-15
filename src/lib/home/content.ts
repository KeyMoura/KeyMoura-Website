/**
 * Every word on the homepage, in one place.
 *
 * ## Why the copy is a module and not JSX
 *
 * The homepage makes claims about a real business, and the rule for this pass
 * was that it may not make one the business cannot back. Keeping the sentences
 * in a typed module rather than scattered through nine components means the
 * claims can be read in one sitting, and `tests/homepage-3.test.ts` can assert
 * things like "no number of years, no customer count, no tolerance figure"
 * against the source of the copy instead of against rendered markup.
 *
 * ## What is safe to say here
 *
 * Everything below is already stated somewhere the business controls —
 * `/capabilities`, `/about`, the custom-request flow, or the order hub. The
 * materials list is `/capabilities`' list. The four steps are the request
 * flow's actual steps. The assurances are the ones the checkout and order pages
 * genuinely implement.
 *
 * Deliberately absent, because nothing in this repository establishes them:
 * years in business, parts shipped, customers served, review scores, turnaround
 * times, tolerance capability, certifications, and named client logos. If any of
 * those become true and documented, they belong here — not invented at the
 * point of writing a section.
 */

export type Cta = { href: string; label: string };

export type Panel = { label: string; title: string; body: string; cta?: Cta };

export type Step = { step: string; title: string; body: string };

// ---------------------------------------------------------------------------
// Hero
// ---------------------------------------------------------------------------

/**
 * The headline carries both halves of the business in one line, because the
 * single most common thing a first-time visitor gets wrong about KeyMoura is
 * assuming it is one or the other: a shop that only sells finished goods, or a
 * job shop with nothing to buy.
 *
 * Split rather than one string so the second half can take the brand colour
 * without a `dangerouslySetInnerHTML` or a fragile split on a marker character.
 */
export const hero = {
  eyebrow: "Custom routing & light machining",
  titleLead: "Stocked parts, and",
  titleAccent: "parts that don't exist yet.",
  lede: "KeyMoura is a small shop making one-off parts, prototypes, fixtures, signage, and short runs. Buy something that's ready to go, or send a drawing and we'll work out whether it can be made the way you need it — and what it costs — before you pay for anything.",
  primary: { href: "/catalog", label: "Shop products" } satisfies Cta,
  secondary: { href: "/orders/new", label: "Start a custom project" } satisfies Cta,
  tertiary: { href: "/projects", label: "See recent work" } satisfies Cta,
  scrollCue: "What we make",
} as const;

/**
 * The four assurances, which are the homepage's entire trust story.
 *
 * Each one is a behaviour of this application, not a claim about the business:
 * the request flow really does take no payment, checkout really is Stripe,
 * every request really does reach a human queue, and the order hub really does
 * hold the files and the status. That is the test a trust signal has to pass to
 * appear on this page.
 */
export const assurances: readonly { title: string; body: string }[] = [
  {
    title: "Nothing charged before you approve",
    body: "A request costs nothing. Payment happens after you have seen the specification and the price and accepted both.",
  },
  {
    title: "Every request read by a person",
    body: "No automatic quote. Someone checks the part can actually be made the way you need it before a price goes out.",
  },
  {
    title: "Checkout handled by Stripe",
    body: "Card details go to Stripe, never to this site.",
  },
  {
    title: "One page for the whole order",
    body: "Files, messages, approvals, payment, production status, and delivery stay together.",
  },
] as const;

// ---------------------------------------------------------------------------
// What KeyMoura does
// ---------------------------------------------------------------------------

export const capabilityIntro = {
  label: "What we do",
  title: "Two ways in, one shop behind them.",
  body: "The catalog and the custom queue run through the same bench. A stocked product is something already worked out and repeatable; a custom project is the same work, starting from your drawing instead of ours.",
} as const;

export const capabilityPanels: readonly Panel[] = [
  {
    label: "Off the shelf",
    title: "Designed here, made in small batches.",
    body: "Products worked out once and made repeatedly — priced, photographed, and ready to buy. Some can be customized before you order; the product page says which.",
    cta: { href: "/catalog", label: "Browse the catalog" },
  },
  {
    label: "Made to order",
    title: "One-off parts, from your drawing or your description.",
    body: "Prototypes, fixtures, replacement parts for things that no longer have parts, signage, plates, knobs, trim, and short runs. A sketch with dimensions is enough to start.",
    cta: { href: "/orders/new", label: "Start a custom project" },
  },
] as const;

// ---------------------------------------------------------------------------
// Featured products
// ---------------------------------------------------------------------------

export const featured = {
  label: "Featured products",
  title: "Ready to buy.",
  body: "A few things currently on the bench and in stock. The full catalog has search, categories, and filters.",
  link: { href: "/catalog", label: "All products" } satisfies Cta,
  empty: "The catalog is being restocked. Custom projects are open as usual.",
} as const;

/** The heading above the single enlarged product. Its detail comes from the product row. */
export const productFocus = {
  label: "Featured build",
  action: "View product",
  fallbackBody: "Made to order in the shop.",
} as const;

// ---------------------------------------------------------------------------
// Custom work
// ---------------------------------------------------------------------------

export const custom = {
  label: "Custom work",
  title: "Need something that doesn't exist yet?",
  body: "Start with the idea. A photograph of the broken original, a sketch on paper with measurements on it, a CAD file, or a paragraph describing what the part has to do — any of those is a real starting point.",
  detail: "We read it, say plainly whether this shop should make it, raise anything that ought to change, and send a price tied to what was agreed. If it is not something we should take on, we say that instead of quoting it anyway.",
  primary: { href: "/orders/new", label: "Start a custom project" } satisfies Cta,
  secondary: { href: "/capabilities", label: "See what we can make" } satisfies Cta,
} as const;

export const process = {
  label: "How it works",
  title: "Four steps, and you can see which one you're on.",
  body: "The same sequence runs for a single bracket and for a short production run.",
  cta: { href: "/orders/new", label: "Start a request" } satisfies Cta,
} as const;

export const steps: readonly Step[] = [
  {
    step: "01",
    title: "Describe the part",
    body: "Start from a product page, or send a CAD file, drawing, sketch, or plain-language description. Dimensions, material, finish, quantity, and how the part gets used all help.",
  },
  {
    step: "02",
    title: "We review it and quote",
    body: "Every request is read by a person. We confirm the part can be made the way you need it, raise anything that should change, and send a price tied to the agreed specification.",
  },
  {
    step: "03",
    title: "You approve, then pay",
    body: "Nothing is charged until the scope and the price are settled and you approve the quote. Checkout is handled by Stripe.",
  },
  {
    step: "04",
    title: "Follow it through delivery",
    body: "Messages, files, approvals, payment, production status, and delivery updates stay together in your order hub.",
  },
] as const;

// ---------------------------------------------------------------------------
// In the shop
// ---------------------------------------------------------------------------

/**
 * The materials band, which is `/capabilities`' list verbatim in substance.
 *
 * "Something else?" earns its place: a materials list that implies the shop
 * will cut anything is the kind of overpromise this page is supposed to avoid,
 * and saying "ask first" out loud is more credible than a longer list.
 */
export const making = {
  label: "In the shop",
  title: "What gets cut here.",
  body: "Material decides most of what is practical — workholding, tooling, dust, heat, and safety more than the shape does. These are the ones this shop is set up for.",
  link: { href: "/capabilities", label: "Materials & limits" } satisfies Cta,
} as const;

export const materials: readonly { title: string; body: string }[] = [
  {
    title: "Plastics",
    body: "Delrin and acetal, HDPE, acrylic, and other machinable plastics — housings, jigs, and wear parts.",
  },
  {
    title: "Wood",
    body: "Hardwoods, softwoods, plywood, and selected engineered sheet goods — panels, signage, and trim.",
  },
  {
    title: "Aluminum",
    body: "Reviewed individually for geometry, finish, and the tolerance the part actually needs.",
  },
  {
    title: "Something else?",
    body: "Ask first. We will tell you plainly whether it is practical here, or whether you want a different shop.",
  },
] as const;

// ---------------------------------------------------------------------------
// Recent work
// ---------------------------------------------------------------------------

export const recentWork = {
  label: "Made recently",
  title: "Build write-ups from the shop.",
  body: "Notes on finished work — what it was, what it was made from, and what changed along the way.",
  link: { href: "/projects", label: "See all work" } satisfies Cta,
} as const;

// ---------------------------------------------------------------------------
// Questions, and the closing call to action
// ---------------------------------------------------------------------------

export const questions: readonly { question: string; answer: string }[] = [
  {
    question: "When do I pay?",
    answer: "For a catalog product, at checkout. For custom work, only after the specification and the final price are agreed and you approve the quote.",
  },
  {
    question: "What files can I send?",
    answer: "CAD (STL, STEP, IGES), drawings (DXF, DWG, SVG, PDF), and photographs or reference images. Up to 10 files, 50 MB each.",
  },
  {
    question: "What if you can't make it?",
    answer: "We say so, and explain why. Some geometry, materials, sizes, and safety-critical uses fall outside what this shop should take on.",
  },
  {
    question: "Can I see progress?",
    answer: "Yes. Your order hub tracks review, quote, payment, production, and delivery as they happen.",
  },
] as const;

export const finalCta = {
  label: "Have something in mind?",
  title: "Send the idea. We'll tell you what it takes.",
  body: "A sketch on paper is enough to start. We'll work out material, dimensions, finish, and a realistic path to a finished part — and say so plainly if it is not something this shop should make.",
  primary: { href: "/orders/new", label: "Start a custom project" } satisfies Cta,
  secondary: { href: "/catalog", label: "Browse products" } satisfies Cta,
  quiet: { href: "/support", label: "Ask a question first" } satisfies Cta,
} as const;

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

export const meta = {
  titleSuffix: "Custom Parts & Small-Batch Products",
  description:
    "KeyMoura is a small shop doing custom routing and light machining — one-off parts, prototypes, fixtures, signage, and short runs. Browse stocked products, or send a drawing and get a reviewed quote before you pay.",
} as const;
