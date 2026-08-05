"use client";

import { useRef } from "react";

import { MenuSelect } from "@/components/ui/MenuSelect";
import {
  INSTALLATION_DIFFICULTIES,
  INSTALLATION_DIFFICULTY_LABEL,
  type ProductDetailContent,
} from "@/lib/commerce/productContent";
import {
  addRow,
  CONTENT_LIMITS,
  CONTENT_LIST_META,
  type ContentListKey,
  describeIncompleteRows,
  isListFull,
  MAX_ENTRIES,
  moveRow,
  removeRow,
  updateRow,
} from "@/lib/commerce/productContentEditing";
import type { CatalogProduct } from "@/lib/commerceTypes";

/**
 * The staff surface for the product page's structured content.
 *
 * Additive in every sense: nothing here can clear `description` or
 * `short_description`, which stay where they were on the main details form. A
 * product with none of this set is not incomplete — it renders a shorter page.
 * That is why there is no "complete your product" checklist for these fields
 * and none of them gate publishing.
 *
 * The list editors are deliberately plain: add, edit, remove, reorder by
 * position. Ordering is by array index, which is what the product page renders,
 * so what staff see here is the order a customer gets. There is no drag
 * handle — reordering four benefits with two buttons is fine, and a drag
 * implementation is a pointer-events and keyboard-accessibility problem worth
 * paying for only when the lists get long.
 *
 * Every value is stored as text and rendered as text. Staff may paste anything;
 * `parseDetailContent` is the one gate, and the page never renders it as HTML.
 *
 * **This component holds staff input verbatim and normalizes nothing.** Every
 * list mutation goes through `productContentEditing`, which is pure and does no
 * parsing. Re-parsing here is what previously made every Add button appear
 * dead — a freshly added row is blank, and the parser's job is to drop blank
 * rows. Normalization belongs at the save boundary, where
 * `serializeDetailContent` still does it, and nowhere else.
 */

type ProductContentEditorProps = {
  draft: Partial<CatalogProduct>;
  onChange: (patch: Partial<CatalogProduct>) => void;
  content: ProductDetailContent;
  /**
   * Takes an updater, not a value.
   *
   * Every mutation here is derived from the content that was current when the
   * row rendered, so two activations inside one React batch — a double-click on
   * Add, or two keystrokes landing in the same tick — would both compute from
   * the same starting point and the second would overwrite the first. Measured:
   * clicking Add twice quickly produced one row. Handing React a function makes
   * each change compose on the latest state instead. `useState`'s setter takes
   * an updater already, so the page passes it straight through.
   */
  onContentChange: (update: (current: ProductDetailContent) => ProductDetailContent) => void;
  disabled?: boolean;
};

const input = "ui-input";
const addButton = "ui-btn ui-btn-secondary justify-self-start disabled:opacity-50";

/**
 * One row's move and remove controls.
 *
 * Defined at module scope rather than inside the editor. A component declared
 * in a render body is a new type on every render, so React unmounts and
 * remounts it — which throws away focus the instant a control is used, and
 * makes reordering by keyboard require re-finding the button after every press.
 */
function ListControls({
  index,
  length,
  noun,
  disabled,
  onMove,
  onRemove,
}: {
  index: number;
  length: number;
  noun: string;
  disabled: boolean;
  onMove: (direction: -1 | 1) => void;
  onRemove: () => void;
}) {
  // Positions staff see are 1-based, and every name says which list it belongs
  // to. "Remove this entry", repeated identically on every row of all five
  // lists, told a screen-reader user nothing about what they were removing.
  const position = index + 1;
  const control = "ui-btn ui-btn-ghost !px-2 !py-1 text-xs disabled:opacity-40";
  return (
    <div className="flex shrink-0 gap-1">
      <button
        type="button"
        disabled={disabled || index === 0}
        onClick={() => onMove(-1)}
        className={control}
        aria-label={`Move ${noun} ${position} up`}
      >
        ↑
      </button>
      <button
        type="button"
        disabled={disabled || index === length - 1}
        onClick={() => onMove(1)}
        className={control}
        aria-label={`Move ${noun} ${position} down`}
      >
        ↓
      </button>
      <button
        type="button"
        disabled={disabled}
        onClick={onRemove}
        className={`${control} text-rose-300`}
        aria-label={`Remove ${noun} ${position}`}
      >
        Remove
      </button>
    </div>
  );
}

/**
 * What will not survive Save, said before Save is pressed.
 *
 * Dropping incomplete rows is deliberate — an unlabelled specification has
 * nothing to render — but doing it without a word is how staff type half a row,
 * save, and find it gone with no explanation.
 */
function IncompleteNotice({ content, listKey }: { content: ProductDetailContent; listKey: ContentListKey }) {
  const message = describeIncompleteRows(content, listKey);
  if (!message) return null;
  return <p className="text-xs text-amber-200">{message}</p>;
}

export default function ProductContentEditor({
  draft,
  onChange,
  content,
  onContentChange,
  disabled = false,
}: ProductContentEditorProps) {
  const set = <K extends keyof CatalogProduct>(key: K, value: CatalogProduct[K]) => onChange({ [key]: value });

  /**
   * Focus follows a newly added row.
   *
   * Adding a row and leaving focus on the Add button means a keyboard user has
   * to tab back through every existing row to reach the box they just asked
   * for. The new row's field does not exist yet when the button is clicked, so
   * the target is parked in a ref and claimed by that field's own ref callback
   * as it mounts. A ref rather than state, and no effect: focusing is a commit
   * side effect on one element, not a reason to render the editor again.
   */
  const pendingFocus = useRef<string | null>(null);

  const focusOnMount =
    (id: string) => (element: HTMLInputElement | HTMLTextAreaElement | null) => {
      if (!element || pendingFocus.current !== id) return;
      pendingFocus.current = null;
      element.focus();
    };

  const add = (key: ContentListKey) => {
    // `addRow` returns the same object at the cap, which the button's own
    // disabled state should have prevented anyway — nothing changes and nothing
    // is marked dirty. The focus target is the position this click is asking
    // for; two Adds batched together both point at the first of the new rows,
    // which is where focus should land regardless.
    if (isListFull(content, key)) return;
    pendingFocus.current = `${key}-${content[key].length}`;
    onContentChange((current) => addRow(current, key));
  };

  const update = <K extends ContentListKey>(key: K, index: number, patch: Partial<ProductDetailContent[K][number]>) =>
    onContentChange((current) => updateRow(current, key, index, patch));

  /**
   * The Add control and, at the cap, the reason it is unavailable.
   *
   * A function returning elements rather than a component declared in a render
   * body — the latter is a fresh type on every render, which remounts whatever
   * it renders and throws away focus. That is the same mistake this file's row
   * controls used to make.
   */
  const addControl = (key: ContentListKey) => {
    const full = isListFull(content, key);
    return (
      <>
        <button type="button" disabled={disabled || full} onClick={() => add(key)} className={addButton}>
          {CONTENT_LIST_META[key].addLabel}
        </button>
        {full ? (
          <p className="text-xs text-amber-200">
            This list is at its limit of {MAX_ENTRIES} rows. Remove one before adding another.
          </p>
        ) : null}
      </>
    );
  };

  return (
    <div className="grid gap-8">
      <section aria-labelledby="content-facts">
        <h3 id="content-facts" className="text-lg font-semibold">
          Product facts
        </h3>
        <p className="mt-1 text-sm text-brand-textMuted">
          Shown in the quick-information row beside the buy button. Anything left blank is simply not
          shown — there are no empty placeholders on the product page.
        </p>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <label className="text-sm">
            Material
            <input
              className={`${input} mt-1`}
              disabled={disabled}
              value={draft.material ?? ""}
              onChange={(e) => set("material", e.target.value)}
              placeholder="Example: 6061 aluminium"
            />
          </label>
          <label className="text-sm">
            Finish
            <input
              className={`${input} mt-1`}
              disabled={disabled}
              value={draft.finish ?? ""}
              onChange={(e) => set("finish", e.target.value)}
              placeholder="Example: Bead blasted, anodised"
            />
          </label>
          <label className="text-sm">
            Product dimensions
            <input
              className={`${input} mt-1`}
              disabled={disabled}
              value={draft.dimensions_text ?? ""}
              onChange={(e) => set("dimensions_text", e.target.value)}
              placeholder="Example: 50 × 50 × 42 mm"
            />
          </label>
          <label className="text-sm">
            Package dimensions
            <input
              className={`${input} mt-1`}
              disabled={disabled}
              value={draft.package_dimensions_text ?? ""}
              onChange={(e) => set("package_dimensions_text", e.target.value)}
              placeholder="Example: 120 × 90 × 80 mm"
            />
          </label>
          <label className="text-sm">
            Weight (grams)
            <input
              className={`${input} mt-1`}
              type="number"
              min="0"
              disabled={disabled}
              value={draft.weight_grams ?? ""}
              onChange={(e) => set("weight_grams", e.target.value ? Math.max(0, Number(e.target.value)) : null)}
            />
            <span className="mt-1 block text-xs text-brand-textMuted">
              Shown as grams below 1 kg and kilograms above.
            </span>
          </label>
          <label className="text-sm">
            Installation difficulty
            <MenuSelect
              className="ui-select-trigger mt-1"
              disabled={disabled}
              ariaLabel="Installation difficulty"
              value={draft.installation_difficulty ?? ""}
              onChange={(value) => set("installation_difficulty", value || null)}
              options={[
                { value: "", label: "Not stated" },
                ...INSTALLATION_DIFFICULTIES.map((value) => ({
                  value,
                  label: INSTALLATION_DIFFICULTY_LABEL[value],
                })),
              ]}
            />
          </label>
          <label className="flex items-center gap-2 text-sm sm:col-span-2">
            <input
              type="checkbox"
              disabled={disabled}
              checked={Boolean(draft.made_to_order)}
              onChange={(e) => set("made_to_order", e.target.checked)}
            />
            Made to order — manufactured per order rather than shipped from stock
          </label>
        </div>
      </section>

      <section aria-labelledby="content-notes">
        <h3 id="content-notes" className="text-lg font-semibold">
          Page sections
        </h3>
        <p className="mt-1 text-sm text-brand-textMuted">
          Each becomes its own section on the product page. Empty ones are hidden. Line breaks are
          kept; formatting and links are not — this is plain text.
        </p>
        <div className="mt-4 grid gap-4">
          {(
            [
              ["installation_notes", "Installation notes", "How the part goes on, and anything to watch for."],
              ["care_instructions", "Care instructions", "How to clean and maintain it."],
              ["warranty_text", "Warranty", "What is covered, and for how long."],
              ["shipping_notes", "Shipping notes", "Shown with the lead time."],
              ["return_notes", "Return notes", "Shown with cancellations."],
              ["cancellation_notes", "Cancellation notes", "When an order can still be cancelled."],
            ] as const
          ).map(([key, label, hint]) => (
            <label key={key} className="text-sm">
              {label}
              <textarea
                className={`${input} mt-1 min-h-24`}
                disabled={disabled}
                value={(draft[key] as string | null | undefined) ?? ""}
                onChange={(e) => set(key, e.target.value)}
              />
              <span className="mt-1 block text-xs text-brand-textMuted">{hint}</span>
            </label>
          ))}
        </div>
      </section>

      <section aria-labelledby="content-benefits">
        <h3 id="content-benefits" className="text-lg font-semibold">
          Key benefits
        </h3>
        <div className="mt-3 grid gap-3">
          {content.benefits.map((row, index) => (
            <div key={index} className="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-3">
              <div className="flex items-start justify-between gap-3">
                <input
                  ref={focusOnMount(`benefits-${index}`)}
                  className={input}
                  disabled={disabled}
                  value={row.title}
                  maxLength={CONTENT_LIMITS.benefits.title}
                  placeholder="Benefit title"
                  aria-label={`Benefit ${index + 1} title`}
                  onChange={(e) => update("benefits", index, { title: e.target.value })}
                />
                <ListControls
                  index={index}
                  length={content.benefits.length}
                  noun={CONTENT_LIST_META.benefits.noun}
                  disabled={disabled}
                  onMove={(direction) => onContentChange((current) => moveRow(current, "benefits", index, direction))}
                  onRemove={() => onContentChange((current) => removeRow(current, "benefits", index))}
                />
              </div>
              <textarea
                className={`${input} mt-2 min-h-16`}
                disabled={disabled}
                value={row.body}
                maxLength={CONTENT_LIMITS.benefits.body}
                placeholder="What it means for the customer"
                aria-label={`Benefit ${index + 1} description`}
                onChange={(e) => update("benefits", index, { body: e.target.value })}
              />
            </div>
          ))}
          <IncompleteNotice content={content} listKey="benefits" />
          {addControl("benefits")}
        </div>
      </section>

      <section aria-labelledby="content-specs">
        <h3 id="content-specs" className="text-lg font-semibold">
          Specifications
        </h3>
        <div className="mt-3 grid gap-2">
          {content.specifications.map((row, index) => (
            <div key={index} className="flex flex-wrap items-center gap-2">
              <input
                ref={focusOnMount(`specifications-${index}`)}
                className={`${input} min-w-40 flex-1`}
                disabled={disabled}
                value={row.name}
                maxLength={CONTENT_LIMITS.specifications.name}
                placeholder="Name"
                aria-label={`Specification ${index + 1} name`}
                onChange={(e) => update("specifications", index, { name: e.target.value })}
              />
              <input
                className={`${input} min-w-40 flex-[2]`}
                disabled={disabled}
                value={row.value}
                maxLength={CONTENT_LIMITS.specifications.value}
                placeholder="Value"
                aria-label={`Specification ${index + 1} value`}
                onChange={(e) => update("specifications", index, { value: e.target.value })}
              />
              <ListControls
                index={index}
                length={content.specifications.length}
                noun={CONTENT_LIST_META.specifications.noun}
                disabled={disabled}
                onMove={(direction) => onContentChange((current) => moveRow(current, "specifications", index, direction))}
                onRemove={() => onContentChange((current) => removeRow(current, "specifications", index))}
              />
            </div>
          ))}
          <IncompleteNotice content={content} listKey="specifications" />
          {addControl("specifications")}
          <p className="text-xs text-brand-textMuted">
            Both halves are needed. A value with no name is unlabelled on the page, so incomplete rows
            are dropped when saved.
          </p>
        </div>
      </section>

      {(
        [
          ["compatibility", "Compatibility & fitment", "Example: Miata NA/NB, M10×1.25"],
          ["included", "What's included", "Example: Shift knob"],
        ] as const
      ).map(([key, heading, placeholder]) => (
        <section key={key} aria-labelledby={`content-${key}`}>
          <h3 id={`content-${key}`} className="text-lg font-semibold">
            {heading}
          </h3>
          <div className="mt-3 grid gap-2">
            {content[key].map((row, index) => (
              <div key={index} className="flex flex-wrap items-center gap-2">
                <input
                  ref={focusOnMount(`${key}-${index}`)}
                  className={`${input} min-w-40 flex-[2]`}
                  disabled={disabled}
                  value={row.value}
                  maxLength={CONTENT_LIMITS[key].value}
                  placeholder={placeholder}
                  aria-label={`${CONTENT_LIST_META[key].noun} ${index + 1}`}
                  onChange={(e) => update(key, index, { value: e.target.value })}
                />
                <input
                  className={`${input} min-w-40 flex-1`}
                  disabled={disabled}
                  value={row.note}
                  maxLength={CONTENT_LIMITS[key].note}
                  placeholder="Note (optional)"
                  aria-label={`${CONTENT_LIST_META[key].noun} ${index + 1} note`}
                  onChange={(e) => update(key, index, { note: e.target.value })}
                />
                <ListControls
                  index={index}
                  length={content[key].length}
                  noun={CONTENT_LIST_META[key].noun}
                  disabled={disabled}
                  onMove={(direction) => onContentChange((current) => moveRow(current, key, index, direction))}
                  onRemove={() => onContentChange((current) => removeRow(current, key, index))}
                />
              </div>
            ))}
            <IncompleteNotice content={content} listKey={key} />
            {addControl(key)}
          </div>
        </section>
      ))}

      <section aria-labelledby="content-faq">
        <h3 id="content-faq" className="text-lg font-semibold">
          Frequently asked questions
        </h3>
        <div className="mt-3 grid gap-3">
          {content.faq.map((row, index) => (
            <div key={index} className="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-3">
              <div className="flex items-start justify-between gap-3">
                <input
                  ref={focusOnMount(`faq-${index}`)}
                  className={input}
                  disabled={disabled}
                  value={row.title}
                  maxLength={CONTENT_LIMITS.faq.title}
                  placeholder="Question"
                  aria-label={`Question ${index + 1}`}
                  onChange={(e) => update("faq", index, { title: e.target.value })}
                />
                <ListControls
                  index={index}
                  length={content.faq.length}
                  noun={CONTENT_LIST_META.faq.noun}
                  disabled={disabled}
                  onMove={(direction) => onContentChange((current) => moveRow(current, "faq", index, direction))}
                  onRemove={() => onContentChange((current) => removeRow(current, "faq", index))}
                />
              </div>
              <textarea
                className={`${input} mt-2 min-h-16`}
                disabled={disabled}
                value={row.body}
                maxLength={CONTENT_LIMITS.faq.body}
                placeholder="Answer"
                aria-label={`Answer ${index + 1}`}
                onChange={(e) => update("faq", index, { body: e.target.value })}
              />
            </div>
          ))}
          <IncompleteNotice content={content} listKey="faq" />
          {addControl("faq")}
        </div>
      </section>
    </div>
  );
}
