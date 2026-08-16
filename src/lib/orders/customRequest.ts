/**
 * What a custom project request *is*, defined once for both sides of the wire.
 *
 * The wizard at `/orders/new` and the route at `/api/orders/custom` used to
 * disagree about almost everything they both claimed to check. The page allowed
 * 50 MB uploads; the `order-assets` bucket refuses anything over 20 MB, so a
 * customer who attached a 30 MB drawing passed every check the form could see
 * and then met a raw storage error. The page offered a materials list the route
 * had never heard of and stored as free text. The page required a full shipping
 * address to continue; the route required one too, for an inquiry that charges
 * nothing and ships nothing.
 *
 * So the shapes, the option lists and the rules live here, and both sides
 * import them. That is not a way of trusting the client — the route still
 * validates every field itself, on the server, and nothing below runs in the
 * browser on the route's behalf. It is a way of making the two *agree*: when
 * the limit changes it changes in one place, and a form can no longer promise
 * something the server will refuse.
 *
 * ## What is deliberately not here
 *
 * A second data model. A request is an `orders` row with `status = 'requested'`
 * — that is the canonical shape, it already carries quotes, messages, payments,
 * fulfillment and history, and this pass adds no table and no column to it.
 * Everything structured below lands in `orders.specifications`, which is the
 * jsonb bag that surface was built for, in the `{ label, value, display_value }`
 * form `RequestSpecifications` already renders for staff and customer alike.
 */

/* -------------------------------------------------------------------------
 * Request types
 * ---------------------------------------------------------------------- */

/**
 * The kinds of work a customer can ask for.
 *
 * Every entry is something `/capabilities` already says KeyMoura does —
 * "custom routing and light machining for one-off parts, prototypes, signs,
 * fixtures, plates, knobs, trim pieces, and short runs". Nothing here invents
 * a capability, and nothing here is an internal status: a customer chooses
 * from the things they came to have made, not from the shop's queue names.
 *
 * `context` is the one follow-up question the type earns. It is why these are
 * types at all rather than a single free-text box — a woodworking piece needs
 * to know whether it lives outdoors, an automotive part needs the vehicle, and
 * neither wants the other's question. See `Phase 38` reasoning in the ledger:
 * conditional where it changes the answer, not a form engine.
 */
export type RequestTypeId =
  | "existing-product"
  | "part"
  | "automotive"
  | "woodworking"
  | "sign"
  | "fixture"
  | "replacement"
  | "other";

export type RequestType = {
  id: RequestTypeId;
  label: string;
  /** One line under the label, in the customer's words. */
  blurb: string;
  /** The single conditional question this type earns, or `null` for none. */
  context: { label: string; placeholder: string; help?: string } | null;
  /** Whether the dimensions step is worth offering up front for this type. */
  dimensions: boolean;
};

export const REQUEST_TYPES: readonly RequestType[] = [
  {
    id: "existing-product",
    label: "Change something we already make",
    blurb: "Start from a KeyMoura product and have it altered or personalised.",
    context: {
      label: "What should be different about it?",
      placeholder: "Example: same board, but 4 inches longer and no handle cut-out.",
    },
    dimensions: true,
  },
  {
    id: "part",
    label: "A custom part or component",
    blurb: "A knob, plate, bracket, trim piece, or something that fits onto something else.",
    context: {
      label: "What does it fit or work with?",
      placeholder: "Example: mounts to a 40mm rail with two M5 bolts.",
      help: "If it has to fit an existing thing, tell us what that thing is.",
    },
    dimensions: true,
  },
  {
    id: "automotive",
    label: "An automotive part or trim piece",
    blurb: "Shift knobs, brackets, covers, interior and engine-bay trim.",
    context: {
      label: "Vehicle or application",
      placeholder: "Example: 2015 Ford Focus ST, manual transmission.",
      help: "Year, make, model and trim if you know them.",
    },
    dimensions: true,
  },
  {
    id: "woodworking",
    label: "A woodworking piece",
    blurb: "Boards, panels, furniture parts, and other work in hardwood or sheet goods.",
    context: {
      label: "Where will it live?",
      placeholder: "Example: kitchen counter, used daily for food prep.",
      help: "Indoor or outdoor changes what wood and finish we would suggest.",
    },
    dimensions: true,
  },
  {
    id: "sign",
    label: "A sign, plate, or display piece",
    blurb: "Engraved or cut lettering, plaques, badges, and display stands.",
    context: {
      label: "Wording or artwork",
      placeholder: "Example: “THE MOURA WORKSHOP · EST. 2019”, two lines, centred.",
      help: "Type the exact text you want. Spelling is copied as written.",
    },
    dimensions: true,
  },
  {
    id: "fixture",
    label: "A fixture, jig, or shop tool",
    blurb: "Something that holds, locates, or guides another part.",
    context: {
      label: "What does it need to hold or locate?",
      placeholder: "Example: locates a 2\" pipe flange for repeat drilling.",
    },
    dimensions: true,
  },
  {
    id: "replacement",
    label: "A replacement or reproduction part",
    blurb: "Remaking something that broke, wore out, or is no longer sold.",
    context: {
      label: "What is it replacing?",
      placeholder: "Example: knob from a 1970s Delta drill press, part no. 1234.",
      help: "A part number, the machine it came from, or a photo of the original all help.",
    },
    dimensions: true,
  },
  {
    id: "other",
    label: "Something else",
    blurb: "Not sure which of these fits? Start here and describe it.",
    context: {
      label: "What is this for?",
      placeholder: "Example: a gift, a repair, a prototype for a bigger project.",
    },
    dimensions: false,
  },
] as const;

export const requestType = (id: string): RequestType | null =>
  REQUEST_TYPES.find((entry) => entry.id === id) ?? null;

/** The label recorded on the order, so staff read words rather than a slug. */
export const requestTypeLabel = (id: string): string => requestType(id)?.label ?? "";

/* -------------------------------------------------------------------------
 * Materials and finishes
 * ---------------------------------------------------------------------- */

/**
 * Materials, taken from `/capabilities` and nowhere else.
 *
 * That page names plastics (Delrin/acetal, HDPE, acrylic), wood (hardwoods,
 * softwoods, plywood and engineered sheet goods) and aluminum, and says
 * everything else has to be asked about first. This list says exactly that and
 * no more. A dropdown is a promise, and a customer who picks "titanium" from a
 * form has been told the shop cuts titanium.
 */
export const MATERIAL_OPTIONS = [
  { value: "", label: "Not sure — recommend one" },
  { value: "hardwood", label: "Wood — hardwood" },
  { value: "softwood", label: "Wood — softwood" },
  { value: "sheet-goods", label: "Wood — plywood or sheet goods" },
  { value: "delrin", label: "Plastic — Delrin / acetal" },
  { value: "hdpe", label: "Plastic — HDPE" },
  { value: "acrylic", label: "Plastic — acrylic" },
  { value: "aluminum", label: "Aluminum" },
  { value: "other", label: "Something else — I'll describe it" },
] as const;

/**
 * Finishes. Short on purpose.
 *
 * `/capabilities` lists no finish catalog and warns that specialty finishes may
 * need an outside service or a declined request, so anodising and powder coat
 * are absent rather than offered and walked back later. "Something else" is
 * where a customer who wants one says so, and staff answers honestly.
 */
export const FINISH_OPTIONS = [
  { value: "", label: "Not sure — recommend one" },
  { value: "as-machined", label: "As machined / as cut" },
  { value: "sanded", label: "Sanded smooth" },
  { value: "polished", label: "Polished" },
  { value: "oiled", label: "Oiled or sealed (wood)" },
  { value: "painted", label: "Painted" },
  { value: "other", label: "Something else — I'll describe it" },
] as const;

const labelFrom = (options: readonly { value: string; label: string }[], value: string) =>
  options.find((option) => option.value === value)?.label ?? "";

export const materialLabel = (value: string) => labelFrom(MATERIAL_OPTIONS, value);
export const finishLabel = (value: string) => labelFrom(FINISH_OPTIONS, value);

/* -------------------------------------------------------------------------
 * Quantity, timing, delivery
 * ---------------------------------------------------------------------- */

/** Matches the 1–1000 the route has always enforced. */
export const MIN_QUANTITY = 1;
export const MAX_QUANTITY = 1000;

/**
 * Whether this is a one-off or something that may be made again.
 *
 * Cheap to ask and it changes real work: a repeatable part is worth cutting a
 * fixture for and worth recording setup notes against, a one-off is not. It is
 * not a promise of bulk manufacturing — the quantity cap is unchanged.
 */
export type Repeatability = "one-off" | "repeatable";

export const REPEATABILITY_OPTIONS: readonly { value: Repeatability; label: string; blurb: string }[] = [
  { value: "one-off", label: "Just this once", blurb: "A single piece or a one-time batch." },
  { value: "repeatable", label: "I may reorder", blurb: "Worth setting up so it can be made again." },
] as const;

export type Timing = "flexible" | "asap" | "by-date";

export const TIMING_OPTIONS: readonly { value: Timing; label: string; blurb: string }[] = [
  { value: "flexible", label: "No deadline", blurb: "Whenever it is ready." },
  { value: "asap", label: "As soon as practical", blurb: "No fixed date, but sooner is better." },
  { value: "by-date", label: "By a specific date", blurb: "There is a date this has to be done for." },
] as const;

/**
 * What the customer expects to happen at the end.
 *
 * `undecided` is a real answer at inquiry stage and the previous form had no
 * way to give it — it demanded shipping or pickup, and a full address with it,
 * before it would show you the review step.
 *
 * The `orders.fulfillment_method` column only accepts `shipping`, `pickup` or
 * `none`, and this pass adds no migration, so `undecided` is not written there:
 * the column keeps the shipping default it has always had, and the customer's
 * actual answer is recorded in `specifications.delivery` where staff read it
 * and the quote settles it. Nothing downstream acts on the column until an
 * order is quoted and paid, by which point a human has agreed the method.
 */
export type DeliveryIntent = "shipping" | "pickup" | "undecided";

export const DELIVERY_OPTIONS: readonly { value: DeliveryIntent; label: string; blurb: string }[] = [
  { value: "shipping", label: "Ship it to me", blurb: "Cost confirmed with your quote." },
  { value: "pickup", label: "Local pickup", blurb: "Arrange collection once it is done." },
  { value: "undecided", label: "Not sure yet", blurb: "Decide when you see the quote." },
] as const;

/** The column value for a chosen intent. See the note on `DeliveryIntent`. */
export const fulfillmentMethodFor = (intent: DeliveryIntent): "shipping" | "pickup" =>
  intent === "pickup" ? "pickup" : "shipping";

export const deliveryLabel = (intent: DeliveryIntent) =>
  DELIVERY_OPTIONS.find((option) => option.value === intent)?.label ?? "Not sure yet";

/* -------------------------------------------------------------------------
 * Budget
 * ---------------------------------------------------------------------- */

export type BudgetMode = "none" | "target" | "range";

export const BUDGET_OPTIONS: readonly { value: BudgetMode; label: string }[] = [
  { value: "none", label: "No budget in mind yet" },
  { value: "target", label: "I have a target price" },
  { value: "range", label: "I have a range" },
] as const;

/** A million dollars, which is not a budget this shop needs to represent. */
export const MAX_BUDGET_CENTS = 100_000_000;

/**
 * Dollars as typed into a text field, to integer cents.
 *
 * Returns `null` for anything that is not a plain non-negative amount — empty,
 * negative, `1e9`, `Infinity`, `12.345`, or text. Negative in particular: the
 * old field was a free string that went to the database exactly as typed, so
 * `-500` was a budget the system would happily record.
 */
export function parseMoneyToCents(input: string): number | null {
  const text = input.trim().replace(/^\$/, "").replace(/,/g, "");
  if (!text) return null;
  if (!/^\d+(\.\d{1,2})?$/.test(text)) return null;
  const cents = Math.round(Number(text) * 100);
  if (!Number.isSafeInteger(cents) || cents < 0 || cents > MAX_BUDGET_CENTS) return null;
  return cents;
}

export const formatCents = (cents: number) =>
  `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/* -------------------------------------------------------------------------
 * Files
 * ---------------------------------------------------------------------- */

export const MAX_REQUEST_FILES = 10;

/**
 * 20 MB, because that is `storage.buckets.file_size_limit` for `order-assets`
 * (`20260731060000_configurable_products_recovery.sql`, `20971520`).
 *
 * The form used to say 50 MB. Nothing enforced it below the bucket, so the
 * limit a customer was shown was more than twice the limit that applied, and
 * the difference surfaced as an unexplained upload failure after they had
 * chosen the file. Stating the storage layer's own number is the only version
 * of this that cannot drift.
 */
export const MAX_FILE_BYTES = 20 * 1024 * 1024;

/**
 * Extensions accepted, grouped by what they are for.
 *
 * The extension is what the customer sees and what the accept attribute
 * filters on. It is checked again on the server, because an `accept` attribute
 * is a file picker hint and not a control.
 */
export const ACCEPTED_FILE_EXTENSIONS = [
  ".stl", ".step", ".stp", ".iges", ".igs", ".dxf", ".dwg",
  ".pdf", ".svg",
  ".png", ".jpg", ".jpeg", ".webp", ".heic",
  ".zip",
] as const;

export const FILE_ACCEPT_ATTRIBUTE = ACCEPTED_FILE_EXTENSIONS.join(",");

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".heic"]);
const CAD_EXTENSIONS = new Set([".stl", ".step", ".stp", ".iges", ".igs", ".dxf", ".dwg"]);

export type FileKind = "image" | "cad" | "pdf" | "vector" | "archive" | "file";

export const fileExtension = (name: string) => {
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot).toLowerCase();
};

export function fileKind(name: string): FileKind {
  const extension = fileExtension(name);
  if (IMAGE_EXTENSIONS.has(extension)) return "image";
  if (CAD_EXTENSIONS.has(extension)) return "cad";
  if (extension === ".pdf") return "pdf";
  if (extension === ".svg") return "vector";
  if (extension === ".zip") return "archive";
  return "file";
}

export const FILE_KIND_LABEL: Record<FileKind, string> = {
  image: "Image",
  cad: "CAD",
  pdf: "PDF",
  vector: "Vector",
  archive: "Archive",
  file: "File",
};

/**
 * The content type a file is *stored* with.
 *
 * Only the four types a browser can be trusted to render keep their own. An
 * SVG is a document that can carry script, and `createSignedUrl` serves it
 * with whatever content type it was stored under — so an SVG stored as
 * `image/svg+xml` is a script KeyMoura hosts and staff click on. Storing
 * everything else as `application/octet-stream` makes those files download
 * instead of render, which is what a drawing is for anyway.
 */
const INLINE_SAFE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "application/pdf"]);

export function storageContentType(file: { type?: string; name: string }): string {
  const declared = (file.type || "").toLowerCase();
  return INLINE_SAFE_TYPES.has(declared) ? declared : "application/octet-stream";
}

/** Storage object keys are ASCII-safe; the display name is kept separately. */
export const safeStorageName = (name: string) => name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);

export function fileProblem(file: { name: string; size: number }): string {
  const extension = fileExtension(file.name);
  if (!extension || !(ACCEPTED_FILE_EXTENSIONS as readonly string[]).includes(extension)) {
    return `${file.name} is not a file type we can open. Send a CAD file, drawing, PDF, image, or ZIP.`;
  }
  if (file.size > MAX_FILE_BYTES) {
    return `${file.name} is larger than 20 MB. Send a smaller export, or a ZIP split into parts.`;
  }
  if (file.size === 0) return `${file.name} is empty.`;
  return "";
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/* -------------------------------------------------------------------------
 * Reference link
 * ---------------------------------------------------------------------- */

/**
 * An optional link to something that already exists.
 *
 * `http` and `https` only. Anything else — `javascript:`, `data:`, `file:` — is
 * a string that becomes an anchor on a staff screen, and this is the one field
 * on the form whose whole purpose is to be clicked later.
 */
export function normalizeReferenceUrl(input: string): { url: string } | { error: string } {
  const text = input.trim();
  if (!text) return { url: "" };
  const candidate = /^https?:\/\//i.test(text) ? text : `https://${text}`;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return { error: "That does not look like a web address. Example: https://example.com/photo" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { error: "Reference links must start with http:// or https://" };
  }
  if (!parsed.hostname.includes(".")) {
    return { error: "That does not look like a web address. Example: https://example.com/photo" };
  }
  if (candidate.length > 500) return { error: "That link is too long — send the file instead." };
  return { url: parsed.toString() };
}

/* -------------------------------------------------------------------------
 * The form itself
 * ---------------------------------------------------------------------- */

export type RequestDimensions = {
  length: string;
  width: string;
  height: string;
  diameter: string;
  thread: string;
  notes: string;
};

export type CustomRequestForm = {
  request_type: RequestTypeId | "";
  /** Slug of the KeyMoura product this is based on, when there is one. */
  product_slug: string;
  title: string;
  description: string;
  /** The one conditional answer earned by `request_type`. */
  context: string;
  dimensions_known: "known" | "help";
  dimensions: RequestDimensions;
  material: string;
  material_other: string;
  finish: string;
  finish_other: string;
  reference_url: string;
  quantity: number;
  repeatability: Repeatability;
  budget_mode: BudgetMode;
  budget_min: string;
  budget_max: string;
  timing: Timing;
  target_date: string;
  delivery: DeliveryIntent;
  postal_code: string;
  country: string;
  /** Guest contact. Ignored entirely when a session owns the request. */
  guest_email: string;
  guest_name: string;
};

export const emptyDimensions = (): RequestDimensions => ({
  length: "", width: "", height: "", diameter: "", thread: "", notes: "",
});

export const emptyCustomRequest = (): CustomRequestForm => ({
  request_type: "",
  product_slug: "",
  title: "",
  description: "",
  context: "",
  dimensions_known: "known",
  dimensions: emptyDimensions(),
  material: "",
  material_other: "",
  finish: "",
  finish_other: "",
  reference_url: "",
  quantity: 1,
  repeatability: "one-off",
  budget_mode: "none",
  budget_min: "",
  budget_max: "",
  timing: "flexible",
  target_date: "",
  delivery: "undecided",
  postal_code: "",
  country: "US",
  guest_email: "",
  guest_name: "",
});

/* -------------------------------------------------------------------------
 * Steps and validation
 * ---------------------------------------------------------------------- */

export const STEP_IDS = ["project", "details", "files", "logistics", "review"] as const;
export type StepId = (typeof STEP_IDS)[number];

export const STEPS: readonly { id: StepId; label: string; heading: string; lede: string }[] = [
  {
    id: "project",
    label: "Project",
    heading: "What would you like made?",
    lede: "Pick the closest match. It only decides which questions we ask next — nothing is locked in.",
  },
  {
    id: "details",
    label: "Details",
    heading: "Tell us about it",
    lede: "Plain language is fine. Anything you do not know yet, leave blank and we will work it out together.",
  },
  {
    id: "files",
    label: "Files",
    heading: "Drawings, photos, and references",
    lede: "A sketch on a napkin is genuinely useful. So is a CAD file. Neither is required.",
  },
  {
    id: "logistics",
    label: "Quantity & delivery",
    heading: "How many, by when, and where to",
    lede: "Budget and dates are optional, and none of it commits you to anything.",
  },
  {
    id: "review",
    label: "Review",
    heading: "Check it over",
    lede: "Nothing is charged and nothing is scheduled. This sends your project to KeyMoura for review.",
  },
] as const;

export const stepIndex = (id: StepId) => STEP_IDS.indexOf(id);

export const MIN_DESCRIPTION = 20;
export const MAX_DESCRIPTION = 5000;
export const MAX_TITLE = 120;

export type FieldError = { field: string; message: string };

/**
 * Everything wrong with one step, in the order the fields appear.
 *
 * Returns a list rather than the first problem so a step can mark each field it
 * rejected, instead of the old behaviour: one string in a banner at the bottom,
 * naming one field, with nothing pointing at the control it meant.
 *
 * The route calls this too. That is the point — a rule stated once cannot be
 * enforced differently in the two places that enforce it — but the route calls
 * it on its own reconstruction of the form from the request body, never on
 * anything the browser claims to have already checked.
 */
export function validateStep(step: StepId, form: CustomRequestForm): FieldError[] {
  const errors: FieldError[] = [];

  if (step === "project") {
    if (!form.request_type) {
      errors.push({ field: "request_type", message: "Choose the kind of project so we know what to ask." });
    }
    if (form.request_type === "existing-product" && !form.product_slug.trim()) {
      errors.push({ field: "product_slug", message: "Choose which product you want changed." });
    }
    if (form.title.trim().length > MAX_TITLE) {
      errors.push({ field: "title", message: `Keep the project name under ${MAX_TITLE} characters.` });
    }
  }

  if (step === "details") {
    const description = form.description.trim();
    if (!description) {
      errors.push({ field: "description", message: "Tell us what you want made — a sentence or two is plenty." });
    } else if (description.length < MIN_DESCRIPTION) {
      errors.push({
        field: "description",
        message: `A little more detail, please — ${MIN_DESCRIPTION - description.length} more character${
          MIN_DESCRIPTION - description.length === 1 ? "" : "s"
        } or so.`,
      });
    }
    if (form.material === "other" && !form.material_other.trim()) {
      errors.push({ field: "material_other", message: "Which material did you have in mind?" });
    }
    if (form.finish === "other" && !form.finish_other.trim()) {
      errors.push({ field: "finish_other", message: "Which finish did you have in mind?" });
    }
  }

  if (step === "files") {
    if (form.reference_url.trim()) {
      const result = normalizeReferenceUrl(form.reference_url);
      if ("error" in result) errors.push({ field: "reference_url", message: result.error });
    }
  }

  if (step === "logistics") {
    if (!Number.isInteger(form.quantity) || form.quantity < MIN_QUANTITY || form.quantity > MAX_QUANTITY) {
      errors.push({
        field: "quantity",
        message: `Quantity has to be a whole number between ${MIN_QUANTITY} and ${MAX_QUANTITY}.`,
      });
    }
    if (form.timing === "by-date") {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(form.target_date)) {
        errors.push({ field: "target_date", message: "Pick the date you need it by." });
      } else if (form.target_date < todayIso()) {
        errors.push({ field: "target_date", message: "That date has already passed — pick a future one." });
      }
    }
    if (form.budget_mode === "target" && parseMoneyToCents(form.budget_min) === null) {
      errors.push({ field: "budget_min", message: "Enter a target amount, like 250 or 1200.50." });
    }
    if (form.budget_mode === "range") {
      const low = parseMoneyToCents(form.budget_min);
      const high = parseMoneyToCents(form.budget_max);
      if (low === null) errors.push({ field: "budget_min", message: "Enter the lower end of your range." });
      if (high === null) errors.push({ field: "budget_max", message: "Enter the upper end of your range." });
      if (low !== null && high !== null && high < low) {
        errors.push({ field: "budget_max", message: "The upper end should be at least the lower end." });
      }
    }
    if (form.delivery === "shipping" && form.postal_code.trim() && form.postal_code.trim().length > 24) {
      errors.push({ field: "postal_code", message: "That postal code is too long." });
    }
  }

  return errors;
}

/** `YYYY-MM-DD` in the viewer's own timezone, so "today" is their today. */
export function todayIso(): string {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

/** Every step's problems, for a submit that must not trust step order. */
export function validateAll(form: CustomRequestForm): FieldError[] {
  return STEP_IDS.filter((id) => id !== "review").flatMap((id) => validateStep(id, form));
}

/* -------------------------------------------------------------------------
 * The summary both sides render
 * ---------------------------------------------------------------------- */

/** A resolved dimension line, or "" when nothing was given. */
export function describeDimensions(form: CustomRequestForm): string {
  if (form.dimensions_known === "help") return "Needs help working them out";
  const parts = [
    form.dimensions.length && `L ${form.dimensions.length}`,
    form.dimensions.width && `W ${form.dimensions.width}`,
    form.dimensions.height && `H ${form.dimensions.height}`,
    form.dimensions.diameter && `⌀ ${form.dimensions.diameter}`,
    form.dimensions.thread && `Thread ${form.dimensions.thread}`,
  ].filter(Boolean) as string[];
  const measured = parts.join(" · ");
  if (measured && form.dimensions.notes.trim()) return `${measured} — ${form.dimensions.notes.trim()}`;
  return measured || form.dimensions.notes.trim();
}

export function describeMaterial(form: CustomRequestForm): string {
  if (form.material === "other") return form.material_other.trim() || "Something else";
  return materialLabel(form.material) || "Open to recommendation";
}

export function describeFinish(form: CustomRequestForm): string {
  if (form.finish === "other") return form.finish_other.trim() || "Something else";
  return finishLabel(form.finish) || "Open to recommendation";
}

export function describeBudget(form: CustomRequestForm): string {
  if (form.budget_mode === "none") return "No budget set yet";
  const low = parseMoneyToCents(form.budget_min);
  const high = parseMoneyToCents(form.budget_max);
  if (form.budget_mode === "target") return low === null ? "No budget set yet" : `Around ${formatCents(low)}`;
  if (low === null || high === null) return "No budget set yet";
  return `${formatCents(low)} – ${formatCents(high)}`;
}

export function describeTiming(form: CustomRequestForm): string {
  if (form.timing === "flexible") return "No deadline";
  if (form.timing === "asap") return "As soon as practical";
  if (!form.target_date) return "No deadline";
  // Parsed at local noon so a date-only string cannot slip a day in either
  // direction when the browser's offset is applied.
  return `Hoping for ${new Date(`${form.target_date}T12:00:00`).toLocaleDateString()}`;
}

/** The default project name when the customer does not write one. */
export function fallbackTitle(form: CustomRequestForm): string {
  const label = requestTypeLabel(form.request_type);
  return (label ? `${label} request` : "Custom project request").slice(0, MAX_TITLE);
}

export const resolvedTitle = (form: CustomRequestForm) => form.title.trim() || fallbackTitle(form);
