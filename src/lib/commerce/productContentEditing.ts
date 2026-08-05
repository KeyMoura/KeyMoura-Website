/**
 * Editor-state operations for structured product content.
 *
 * ## Why this module exists
 *
 * `parseDetailContent` is a *boundary* function. It runs when content is read
 * out of the column and again when it is written back, and it deliberately
 * drops incomplete rows and trims whitespace, because a half-filled row is not
 * something the product page should render.
 *
 * The staff editor previously used that same function as its state reducer:
 * every keystroke and every button click rebuilt editor state by re-parsing it.
 * That is the bug this module exists to make unrepeatable. A blank row is
 * *precisely* what an Add button is for, so re-parsing deleted the row in the
 * same tick it was created and the button appeared dead. The same call trimmed
 * every keystroke, so a trailing space could never survive long enough to be
 * followed by another word, and it dropped a specification the moment either
 * half was cleared for retyping.
 *
 * So the rule here is one line: **editor state is verbatim.** What staff typed
 * is what is held, spaces and blank rows and all. Normalization happens exactly
 * twice — reading from the column, and `serializeDetailContent` on save — and
 * never in between.
 *
 * Everything is pure and dependency-free so the component, the tests, and any
 * future editing surface share one definition of what "add a row" means.
 */

import {
  CONTENT_LIMITS,
  MAX_ENTRIES,
  type ProductBenefit,
  type ProductDetailContent,
  type ProductEntry,
  type ProductSpec,
} from "./productContent";

export { CONTENT_LIMITS, MAX_ENTRIES };

export type ContentListKey = keyof ProductDetailContent;
export type ContentRow<K extends ContentListKey> = ProductDetailContent[K][number];

export const CONTENT_LIST_KEYS = [
  "benefits",
  "specifications",
  "compatibility",
  "included",
  "faq",
] as const satisfies readonly ContentListKey[];

type ListMeta = {
  /** Singular noun, used to name each row's own controls. */
  noun: string;
  /** Plural, for the "these will not be saved" notice. */
  plural: string;
  /** The Add button's visible text, which is also its accessible name. */
  addLabel: string;
  /** What a row needs before it is worth saving, phrased for staff. */
  requirement: string;
};

/**
 * Per-list wording, here rather than in the component.
 *
 * Two of these lists were previously rendered from a shared template whose
 * button read "Add an entry" for both, which meant the fitment list and the
 * included-items list had *identical* accessible names. A screen-reader user
 * moving by button had no way to tell which list they were about to add to.
 * Naming lives beside the data so the two cannot drift apart again.
 */
export const CONTENT_LIST_META: Record<ContentListKey, ListMeta> = {
  benefits: {
    noun: "benefit",
    plural: "benefits",
    addLabel: "Add a benefit",
    requirement: "Each one needs a title or a description.",
  },
  specifications: {
    noun: "specification",
    plural: "specifications",
    addLabel: "Add a specification",
    requirement: "Each one needs both a name and a value.",
  },
  compatibility: {
    noun: "compatibility entry",
    plural: "compatibility entries",
    addLabel: "Add a compatibility entry",
    requirement: "Each one needs a value; the note is optional.",
  },
  included: {
    noun: "included item",
    plural: "included items",
    addLabel: "Add an included item",
    requirement: "Each one needs a value; the note is optional.",
  },
  faq: {
    noun: "question",
    plural: "questions",
    addLabel: "Add a question",
    requirement: "Each one needs a question or an answer.",
  },
};

const BLANK_ROWS: { [K in ContentListKey]: () => ContentRow<K> } = {
  benefits: (): ProductBenefit => ({ title: "", body: "" }),
  specifications: (): ProductSpec => ({ name: "", value: "" }),
  compatibility: (): ProductEntry => ({ value: "", note: "" }),
  included: (): ProductEntry => ({ value: "", note: "" }),
  faq: (): ProductBenefit => ({ title: "", body: "" }),
};

/** A fresh empty row of the right shape for a list. */
export function blankRow<K extends ContentListKey>(key: K): ContentRow<K> {
  return BLANK_ROWS[key]() as ContentRow<K>;
}

/**
 * Replaces one list, leaving every other list byte-identical.
 *
 * The single write path, so "adding a benefit reset my FAQs" is structurally
 * impossible rather than merely tested for: the four untouched arrays are
 * carried across by reference and never rebuilt.
 */
export function replaceList<K extends ContentListKey>(
  content: ProductDetailContent,
  key: K,
  rows: ContentRow<K>[],
): ProductDetailContent {
  return { ...content, [key]: rows } as ProductDetailContent;
}

const listOf = <K extends ContentListKey>(content: ProductDetailContent, key: K): ContentRow<K>[] =>
  content[key] as ContentRow<K>[];

const inRange = (rows: readonly unknown[], index: number) =>
  Number.isInteger(index) && index >= 0 && index < rows.length;

/**
 * Appends one blank, editable row.
 *
 * Refuses at `MAX_ENTRIES` rather than appending a row the save would discard —
 * the parser caps every list at 60 on read, so a 61st row would be accepted by
 * the editor, look real, and then vanish on save. Callers surface the refusal;
 * see `isListFull`.
 */
export function addRow<K extends ContentListKey>(
  content: ProductDetailContent,
  key: K,
): ProductDetailContent {
  const rows = listOf(content, key);
  if (rows.length >= MAX_ENTRIES) return content;
  return replaceList(content, key, [...rows, blankRow(key)]);
}

export function isListFull(content: ProductDetailContent, key: ContentListKey): boolean {
  return content[key].length >= MAX_ENTRIES;
}

/** Patches one field of one row. Out-of-range indexes are a no-op, not a throw. */
export function updateRow<K extends ContentListKey>(
  content: ProductDetailContent,
  key: K,
  index: number,
  patch: Partial<ContentRow<K>>,
): ProductDetailContent {
  const rows = listOf(content, key);
  if (!inRange(rows, index)) return content;
  const next = [...rows];
  next[index] = { ...next[index], ...patch };
  return replaceList(content, key, next);
}

/** Removes exactly one row, by position. */
export function removeRow<K extends ContentListKey>(
  content: ProductDetailContent,
  key: K,
  index: number,
): ProductDetailContent {
  const rows = listOf(content, key);
  if (!inRange(rows, index)) return content;
  return replaceList(
    content,
    key,
    rows.filter((_, i) => i !== index),
  );
}

/**
 * Swaps a row with its neighbour.
 *
 * Returns the *same object* at either end of the list, so a disabled-looking
 * arrow that is somehow activated cannot mark the form dirty.
 */
export function moveRow<K extends ContentListKey>(
  content: ProductDetailContent,
  key: K,
  index: number,
  direction: -1 | 1,
): ProductDetailContent {
  const rows = listOf(content, key);
  const target = index + direction;
  if (!inRange(rows, index) || !inRange(rows, target)) return content;
  const next = [...rows];
  [next[index], next[target]] = [next[target], next[index]];
  return replaceList(content, key, next);
}

/**
 * Whether a row would be discarded by `serializeDetailContent`.
 *
 * These predicates mirror the parser's filters exactly, and a test pins the two
 * together by counting rows here and comparing against what actually survives a
 * serialize. Dropping incomplete rows on save is deliberate — an unlabelled
 * specification has nothing to render — but doing it *silently* is not, which is
 * what this answers: the editor can say so before staff press Save.
 */
export function isRowIncomplete<K extends ContentListKey>(key: K, row: ContentRow<K>): boolean {
  switch (key) {
    case "benefits":
    case "faq": {
      const titled = row as ProductBenefit;
      return !titled.title.trim() && !titled.body.trim();
    }
    case "specifications": {
      const spec = row as ProductSpec;
      return !spec.name.trim() || !spec.value.trim();
    }
    default: {
      const entry = row as ProductEntry;
      return !entry.value.trim();
    }
  }
}

/** The positions in a list that will not survive a save. */
export function incompleteRowIndexes(content: ProductDetailContent, key: ContentListKey): number[] {
  return content[key].reduce<number[]>((out, row, index) => {
    if (isRowIncomplete(key, row as ContentRow<typeof key>)) out.push(index);
    return out;
  }, []);
}

/**
 * The sentence shown under a list holding rows that will not be saved.
 *
 * Returns null when there is nothing to say, so the notice is absent rather than
 * empty — a permanently visible warning box reading "0 rows" is noise staff
 * learn to ignore.
 */
export function describeIncompleteRows(
  content: ProductDetailContent,
  key: ContentListKey,
): string | null {
  const count = incompleteRowIndexes(content, key).length;
  if (count === 0) return null;
  const meta = CONTENT_LIST_META[key];
  const noun = count === 1 ? meta.noun : meta.plural;
  return `${count} incomplete ${noun} will not be saved. ${meta.requirement}`;
}
