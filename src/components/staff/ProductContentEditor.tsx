"use client";

import { MenuSelect } from "@/components/ui/MenuSelect";
import {
  INSTALLATION_DIFFICULTIES,
  INSTALLATION_DIFFICULTY_LABEL,
  parseDetailContent,
  type ProductDetailContent,
} from "@/lib/commerce/productContent";
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
 */

type ProductContentEditorProps = {
  draft: Partial<CatalogProduct>;
  onChange: (patch: Partial<CatalogProduct>) => void;
  content: ProductDetailContent;
  onContentChange: (content: ProductDetailContent) => void;
  disabled?: boolean;
};

const input = "ui-input";

export default function ProductContentEditor({
  draft,
  onChange,
  content,
  onContentChange,
  disabled = false,
}: ProductContentEditorProps) {
  const set = <K extends keyof CatalogProduct>(key: K, value: CatalogProduct[K]) => onChange({ [key]: value });

  /** Replaces one list, re-parsing so what is held matches what will be stored. */
  const setList = <K extends keyof ProductDetailContent>(key: K, rows: ProductDetailContent[K]) =>
    onContentChange(parseDetailContent({ ...content, [key]: rows, faq: key === "faq" ? rows : content.faq.map((r) => ({ question: r.title, answer: r.body })) }));

  const move = <T,>(rows: T[], index: number, direction: -1 | 1): T[] => {
    const next = index + direction;
    if (next < 0 || next >= rows.length) return rows;
    const copy = [...rows];
    [copy[index], copy[next]] = [copy[next], copy[index]];
    return copy;
  };

  const ListControls = ({
    index,
    length,
    onMove,
    onRemove,
  }: {
    index: number;
    length: number;
    onMove: (direction: -1 | 1) => void;
    onRemove: () => void;
  }) => (
    <div className="flex shrink-0 gap-1">
      <button
        type="button"
        disabled={disabled || index === 0}
        onClick={() => onMove(-1)}
        className="ui-btn ui-btn-ghost !px-2 !py-1 text-xs disabled:opacity-40"
        aria-label={`Move to position ${index}`}
      >
        ↑
      </button>
      <button
        type="button"
        disabled={disabled || index === length - 1}
        onClick={() => onMove(1)}
        className="ui-btn ui-btn-ghost !px-2 !py-1 text-xs disabled:opacity-40"
        aria-label={`Move to position ${index + 2}`}
      >
        ↓
      </button>
      <button
        type="button"
        disabled={disabled}
        onClick={onRemove}
        className="ui-btn ui-btn-ghost !px-2 !py-1 text-xs text-rose-300 disabled:opacity-40"
        aria-label="Remove this entry"
      >
        Remove
      </button>
    </div>
  );

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
                  className={input}
                  disabled={disabled}
                  value={row.title}
                  placeholder="Benefit title"
                  onChange={(e) => {
                    const rows = [...content.benefits];
                    rows[index] = { ...rows[index], title: e.target.value };
                    setList("benefits", rows);
                  }}
                />
                <ListControls
                  index={index}
                  length={content.benefits.length}
                  onMove={(direction) => setList("benefits", move(content.benefits, index, direction))}
                  onRemove={() => setList("benefits", content.benefits.filter((_, i) => i !== index))}
                />
              </div>
              <textarea
                className={`${input} mt-2 min-h-16`}
                disabled={disabled}
                value={row.body}
                placeholder="What it means for the customer"
                onChange={(e) => {
                  const rows = [...content.benefits];
                  rows[index] = { ...rows[index], body: e.target.value };
                  setList("benefits", rows);
                }}
              />
            </div>
          ))}
          <button
            type="button"
            disabled={disabled}
            onClick={() => setList("benefits", [...content.benefits, { title: "", body: "" }])}
            className="ui-btn ui-btn-secondary justify-self-start"
          >
            Add a benefit
          </button>
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
                className={`${input} min-w-40 flex-1`}
                disabled={disabled}
                value={row.name}
                placeholder="Name"
                onChange={(e) => {
                  const rows = [...content.specifications];
                  rows[index] = { ...rows[index], name: e.target.value };
                  setList("specifications", rows);
                }}
              />
              <input
                className={`${input} min-w-40 flex-[2]`}
                disabled={disabled}
                value={row.value}
                placeholder="Value"
                onChange={(e) => {
                  const rows = [...content.specifications];
                  rows[index] = { ...rows[index], value: e.target.value };
                  setList("specifications", rows);
                }}
              />
              <ListControls
                index={index}
                length={content.specifications.length}
                onMove={(direction) => setList("specifications", move(content.specifications, index, direction))}
                onRemove={() => setList("specifications", content.specifications.filter((_, i) => i !== index))}
              />
            </div>
          ))}
          <button
            type="button"
            disabled={disabled}
            onClick={() => setList("specifications", [...content.specifications, { name: "", value: "" }])}
            className="ui-btn ui-btn-secondary justify-self-start"
          >
            Add a specification
          </button>
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
                  className={`${input} min-w-40 flex-[2]`}
                  disabled={disabled}
                  value={row.value}
                  placeholder={placeholder}
                  onChange={(e) => {
                    const rows = [...content[key]];
                    rows[index] = { ...rows[index], value: e.target.value };
                    setList(key, rows);
                  }}
                />
                <input
                  className={`${input} min-w-40 flex-1`}
                  disabled={disabled}
                  value={row.note}
                  placeholder="Note (optional)"
                  onChange={(e) => {
                    const rows = [...content[key]];
                    rows[index] = { ...rows[index], note: e.target.value };
                    setList(key, rows);
                  }}
                />
                <ListControls
                  index={index}
                  length={content[key].length}
                  onMove={(direction) => setList(key, move(content[key], index, direction))}
                  onRemove={() => setList(key, content[key].filter((_, i) => i !== index))}
                />
              </div>
            ))}
            <button
              type="button"
              disabled={disabled}
              onClick={() => setList(key, [...content[key], { value: "", note: "" }])}
              className="ui-btn ui-btn-secondary justify-self-start"
            >
              Add an entry
            </button>
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
                  className={input}
                  disabled={disabled}
                  value={row.title}
                  placeholder="Question"
                  onChange={(e) => {
                    const rows = [...content.faq];
                    rows[index] = { ...rows[index], title: e.target.value };
                    setList("faq", rows);
                  }}
                />
                <ListControls
                  index={index}
                  length={content.faq.length}
                  onMove={(direction) => setList("faq", move(content.faq, index, direction))}
                  onRemove={() => setList("faq", content.faq.filter((_, i) => i !== index))}
                />
              </div>
              <textarea
                className={`${input} mt-2 min-h-16`}
                disabled={disabled}
                value={row.body}
                placeholder="Answer"
                onChange={(e) => {
                  const rows = [...content.faq];
                  rows[index] = { ...rows[index], body: e.target.value };
                  setList("faq", rows);
                }}
              />
            </div>
          ))}
          <button
            type="button"
            disabled={disabled}
            onClick={() => setList("faq", [...content.faq, { title: "", body: "" }])}
            className="ui-btn ui-btn-secondary justify-self-start"
          >
            Add a question
          </button>
        </div>
      </section>
    </div>
  );
}
