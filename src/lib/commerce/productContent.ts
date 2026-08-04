/**
 * Structured product content: parsing, validation, and the questions the
 * product page asks about it.
 *
 * Pure and dependency-free, so the server component that renders the page, the
 * staff editor that writes it, and the tests all agree on what a benefit or a
 * specification row is. `products.detail_content` is `jsonb`, which means the
 * database guarantees it is an object and nothing more — every other guarantee
 * has to live here, in one place, or the page ends up defending against
 * malformed rows inline at fifteen call sites.
 *
 * Two rules run through all of it:
 *
 * 1. **Never render an empty section.** A "Specifications" heading over nothing
 *    reads as a broken page. Parsing therefore drops entries that carry no
 *    content, and `hasContent` answers whether a section is worth a heading at
 *    all — the page never has to check `.length` itself and get it wrong once.
 *
 * 2. **Text is text.** None of this is rendered as HTML. Staff-entered content
 *    goes through React's own escaping as plain strings, so a pasted `<script>`
 *    is a visible string rather than a hole. Newlines are preserved by CSS
 *    (`white-space: pre-line`) rather than by splitting into elements.
 */

export const INSTALLATION_DIFFICULTIES = ["easy", "moderate", "advanced", "professional"] as const;
export type InstallationDifficulty = (typeof INSTALLATION_DIFFICULTIES)[number];

export const INSTALLATION_DIFFICULTY_LABEL: Record<InstallationDifficulty, string> = {
  easy: "Easy — basic hand tools",
  moderate: "Moderate — some experience helps",
  advanced: "Advanced — specialist tools",
  professional: "Professional installation recommended",
};

export function isInstallationDifficulty(value: unknown): value is InstallationDifficulty {
  return typeof value === "string" && (INSTALLATION_DIFFICULTIES as readonly string[]).includes(value);
}

/** A titled paragraph: "Key benefits" and, reused, "Frequently asked questions". */
export type ProductBenefit = { title: string; body: string };
/** A name/value row: specifications. */
export type ProductSpec = { name: string; value: string };
/** A single line with an optional qualifier: fitment and what's included. */
export type ProductEntry = { value: string; note: string };

export type ProductDetailContent = {
  benefits: ProductBenefit[];
  specifications: ProductSpec[];
  compatibility: ProductEntry[];
  included: ProductEntry[];
  faq: ProductBenefit[];
};

export const EMPTY_DETAIL_CONTENT: ProductDetailContent = {
  benefits: [],
  specifications: [],
  compatibility: [],
  included: [],
  faq: [],
};

/**
 * Caps, applied at parse time rather than at write time.
 *
 * A row that already holds two hundred specification lines predates any limit
 * the editor enforces, and the product page still has to render it without
 * producing an unusable wall. Truncating on read means the page is bounded no
 * matter how the data got there.
 */
const MAX_ENTRIES = 60;
const MAX_TEXT = 2000;

function text(value: unknown, limit = MAX_TEXT): string {
  if (typeof value !== "string") return "";
  // Collapse the whitespace-only case to empty so `hasContent` is not fooled by
  // a row containing a single space, which is what an editor produces when a
  // field is focused and abandoned.
  const trimmed = value.trim();
  return trimmed.length > limit ? trimmed.slice(0, limit) : trimmed;
}

function rows(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object" && !Array.isArray(entry))
    .slice(0, MAX_ENTRIES);
}

/**
 * Turns whatever is in the column into the shape the page renders.
 *
 * Total: any input at all, including null, a string, or an array, yields a
 * valid empty structure. A product page must not fail to render because a
 * staff member saved something odd.
 */
export function parseDetailContent(value: unknown): ProductDetailContent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return EMPTY_DETAIL_CONTENT;
  const input = value as Record<string, unknown>;

  const titled = (key: string, titleKey: string, bodyKey: string): ProductBenefit[] =>
    rows(input[key])
      .map((row) => ({ title: text(row[titleKey], 200), body: text(row[bodyKey]) }))
      // A benefit with neither a title nor a body is a blank row left behind in
      // the editor, not content.
      .filter((row) => row.title || row.body);

  return {
    benefits: titled("benefits", "title", "body"),
    specifications: rows(input.specifications)
      .map((row) => ({ name: text(row.name, 200), value: text(row.value, 500) }))
      // Both halves are required: a value with no name is unlabelled, and a
      // name with no value is a question the page cannot answer.
      .filter((row) => row.name && row.value),
    compatibility: rows(input.compatibility)
      .map((row) => ({ value: text(row.value, 300), note: text(row.note, 300) }))
      .filter((row) => row.value),
    included: rows(input.included)
      .map((row) => ({ value: text(row.value, 300), note: text(row.note, 300) }))
      .filter((row) => row.value),
    faq: titled("faq", "question", "answer").map((row) => ({ title: row.title, body: row.body })),
  };
}

/**
 * Serializes editor state back to the column.
 *
 * Runs the same parse, so what is stored is exactly what would be read back —
 * an editor cannot save a shape the page then discards. Empty lists are stored
 * as empty arrays rather than omitted, which keeps the column's shape stable
 * and makes "staff cleared this section" distinguishable from "never set".
 */
export function serializeDetailContent(content: ProductDetailContent): ProductDetailContent {
  return parseDetailContent({
    benefits: content.benefits.map((row) => ({ title: row.title, body: row.body })),
    specifications: content.specifications,
    compatibility: content.compatibility,
    included: content.included,
    faq: content.faq.map((row) => ({ question: row.title, answer: row.body })),
  });
}

/** True when any structured section has something worth a heading. */
export function hasStructuredContent(content: ProductDetailContent): boolean {
  return (
    content.benefits.length > 0 ||
    content.specifications.length > 0 ||
    content.compatibility.length > 0 ||
    content.included.length > 0 ||
    content.faq.length > 0
  );
}

/**
 * The scalar product facts the page shows as a quick-information row.
 *
 * Deliberately a flat, nullable record rather than the product row itself, so
 * the quick-info renderer cannot reach for a field nobody decided to show.
 */
export type ProductFacts = {
  material: string | null;
  finish: string | null;
  madeToOrder: boolean;
  installationDifficulty: InstallationDifficulty | null;
  installationNotes: string | null;
  careInstructions: string | null;
  warrantyText: string | null;
  shippingNotes: string | null;
  returnNotes: string | null;
  cancellationNotes: string | null;
  dimensionsText: string | null;
  packageDimensionsText: string | null;
  weightGrams: number | null;
  sku: string | null;
  leadTimeText: string | null;
};

const nullableText = (value: unknown): string | null => text(value) || null;

export function parseProductFacts(row: Record<string, unknown> | null | undefined): ProductFacts {
  const input = row ?? {};
  const weight = input.weight_grams;
  return {
    material: nullableText(input.material),
    finish: nullableText(input.finish),
    madeToOrder: input.made_to_order === true,
    installationDifficulty: isInstallationDifficulty(input.installation_difficulty)
      ? input.installation_difficulty
      : null,
    installationNotes: nullableText(input.installation_notes),
    careInstructions: nullableText(input.care_instructions),
    warrantyText: nullableText(input.warranty_text),
    shippingNotes: nullableText(input.shipping_notes),
    returnNotes: nullableText(input.return_notes),
    cancellationNotes: nullableText(input.cancellation_notes),
    dimensionsText: nullableText(input.dimensions_text),
    packageDimensionsText: nullableText(input.package_dimensions_text),
    weightGrams: typeof weight === "number" && Number.isFinite(weight) && weight >= 0 ? Math.round(weight) : null,
    sku: nullableText(input.sku),
    leadTimeText: nullableText(input.lead_time_text),
  };
}

/**
 * Human weight.
 *
 * Grams below a kilogram, kilograms above, one decimal place. A part listed as
 * "0.4 kg" reads worse than "400 g", and "1400 g" reads worse than "1.4 kg".
 */
export function formatWeight(grams: number | null): string | null {
  if (grams == null) return null;
  if (grams < 1000) return `${grams} g`;
  const kg = grams / 1000;
  return `${kg % 1 === 0 ? kg.toFixed(0) : kg.toFixed(1)} kg`;
}

export type QuickFact = { label: string; value: string };

/**
 * The quick-information row beneath the purchase panel.
 *
 * Only facts that are actually set are returned — the page renders exactly what
 * comes back and never has to decide whether a placeholder is worth showing.
 * A sparse product yields a short row; a product with nothing set yields none,
 * and the whole block disappears.
 */
export function quickFacts(facts: ProductFacts, options: { readyToShip: boolean }): QuickFact[] {
  const out: QuickFact[] = [];

  if (facts.material) out.push({ label: "Material", value: facts.material });
  if (facts.finish) out.push({ label: "Finish", value: facts.finish });

  // Availability is one fact with two faces, never both at once.
  if (facts.madeToOrder) out.push({ label: "Production", value: "Made to order" });
  else if (options.readyToShip) out.push({ label: "Availability", value: "Ready to ship" });

  if (facts.leadTimeText) out.push({ label: "Lead time", value: facts.leadTimeText });
  if (facts.dimensionsText) out.push({ label: "Dimensions", value: facts.dimensionsText });

  const weight = formatWeight(facts.weightGrams);
  if (weight) out.push({ label: "Weight", value: weight });

  if (facts.installationDifficulty) {
    out.push({ label: "Installation", value: INSTALLATION_DIFFICULTY_LABEL[facts.installationDifficulty] });
  }
  if (facts.sku) out.push({ label: "SKU", value: facts.sku });

  return out;
}

/** One accessible accordion section on the product page. */
export type ProductSection = {
  id: string;
  title: string;
  /** Long-form prose, rendered with newlines preserved. */
  body?: string;
  benefits?: ProductBenefit[];
  specs?: ProductSpec[];
  entries?: ProductEntry[];
  faq?: ProductBenefit[];
};

/**
 * Every section the page should render, in order, already filtered to those
 * with content.
 *
 * Building the list here rather than in JSX is what makes "hide empty sections"
 * a property of the data instead of a dozen `{x ? … : null}` ternaries that
 * each have to remember to check the right thing. It also gives every section a
 * stable `id`, which is what the deep links and the section nav are keyed on.
 */
export function buildProductSections(input: {
  description: string | null;
  content: ProductDetailContent;
  facts: ProductFacts;
}): ProductSection[] {
  const { description, content, facts } = input;
  const sections: ProductSection[] = [];

  const push = (section: ProductSection) => {
    const hasBody = Boolean(section.body);
    const hasRows =
      Boolean(section.benefits?.length) ||
      Boolean(section.specs?.length) ||
      Boolean(section.entries?.length) ||
      Boolean(section.faq?.length);
    if (hasBody || hasRows) sections.push(section);
  };

  push({ id: "overview", title: "Overview", body: description?.trim() || undefined });
  push({ id: "benefits", title: "Key benefits", benefits: content.benefits });
  push({ id: "specifications", title: "Specifications", specs: content.specifications });

  // Material and finish are scalars but read as specifications; they are folded
  // into their own section rather than duplicated into the spec table, so a
  // product that sets only these still gets a section.
  const materials = [
    facts.material ? { name: "Material", value: facts.material } : null,
    facts.finish ? { name: "Finish", value: facts.finish } : null,
    facts.dimensionsText ? { name: "Dimensions", value: facts.dimensionsText } : null,
    formatWeight(facts.weightGrams) ? { name: "Weight", value: formatWeight(facts.weightGrams)! } : null,
  ].filter((row): row is ProductSpec => row !== null);
  push({ id: "materials", title: "Materials & finish", specs: materials });

  push({ id: "compatibility", title: "Compatibility & fitment", entries: content.compatibility });
  push({ id: "included", title: "What's included", entries: content.included });

  push({
    id: "installation",
    title: "Installation",
    body: [
      facts.installationDifficulty ? INSTALLATION_DIFFICULTY_LABEL[facts.installationDifficulty] : null,
      facts.installationNotes,
    ]
      .filter(Boolean)
      .join("\n\n") || undefined,
  });

  push({ id: "care", title: "Care instructions", body: facts.careInstructions ?? undefined });
  push({
    id: "shipping",
    title: "Shipping & lead time",
    body: [facts.leadTimeText, facts.shippingNotes].filter(Boolean).join("\n\n") || undefined,
  });
  push({ id: "warranty", title: "Warranty", body: facts.warrantyText ?? undefined });
  push({
    id: "returns",
    title: "Returns & cancellations",
    body: [facts.returnNotes, facts.cancellationNotes].filter(Boolean).join("\n\n") || undefined,
  });
  push({ id: "faq", title: "Frequently asked questions", faq: content.faq });

  return sections;
}
