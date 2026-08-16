"use client";

import { useId } from "react";
import QuantityField from "@/components/commerce/QuantityField";
import { MenuSelect } from "@/components/ui/MenuSelect";
import { ChoiceGroup, RequestField, RequestFieldset, describedBy } from "@/components/orders/RequestControls";
import {
  BUDGET_OPTIONS,
  DELIVERY_OPTIONS,
  FINISH_OPTIONS,
  MATERIAL_OPTIONS,
  MAX_DESCRIPTION,
  MAX_QUANTITY,
  MAX_TITLE,
  REPEATABILITY_OPTIONS,
  REQUEST_TYPES,
  TIMING_OPTIONS,
  todayIso,
  requestType,
  type BudgetMode,
  type CustomRequestForm,
  type DeliveryIntent,
  type Repeatability,
  type RequestTypeId,
  type Timing,
} from "@/lib/orders/customRequest";

/**
 * The three question steps. Review and Files live with the wizard and the
 * uploader respectively; these are the ones that are only fields.
 *
 * They are presentational: they read `form`, call `set`, and render whatever
 * `errors` holds for their fields. Every decision about *when* a field is shown
 * comes from the request type the customer chose on step one, which is the
 * whole reason the type is asked first — a woodworking board never meets the
 * vehicle question, and a shift knob never meets "where will it live".
 */

export type ProductOption = { slug: string; name: string };

export type StepProps = {
  form: CustomRequestForm;
  set: <K extends keyof CustomRequestForm>(key: K, value: CustomRequestForm[K]) => void;
  errors: Record<string, string>;
  products: readonly ProductOption[];
};

const input = "ui-input";
const selectTrigger = `${input} flex items-center justify-between text-left`;

/* ------------------------------------------------------------------ *
 * Step 1 — Project
 * ------------------------------------------------------------------ */

export function ProjectStep({ form, set, errors, products }: StepProps) {
  const titleId = useId();
  const productId = useId();

  return (
    <div className="request-step-body">
      <ChoiceGroup<RequestTypeId>
        legend="What kind of project is this?"
        name="request_type"
        value={form.request_type}
        onChange={(value) => set("request_type", value)}
        options={REQUEST_TYPES.map((type) => ({ value: type.id, label: type.label, blurb: type.blurb }))}
        error={errors.request_type}
        columns="two"
      />

      {/*
        The existing-product branch. This is the distinction the old form had no
        way to express: asking for a change to a board KeyMoura already makes is
        a different conversation from asking KeyMoura to invent one, and the
        request should carry which it is. The chosen product is resolved
        server-side from its slug, so the name recorded on the order is the
        published product's own rather than whatever the browser sent.
      */}
      {form.request_type === "existing-product" ? (
        products.length ? (
          <RequestField
            label="Which product?"
            htmlFor={productId}
            required
            error={errors.product_slug}
            help="We will start from this one and quote the changes you describe next."
          >
            <MenuSelect
              ariaLabel="Which product"
              value={form.product_slug}
              onChange={(value) => set("product_slug", value)}
              className={selectTrigger}
              options={[
                { value: "", label: "Choose a product" },
                ...products.map((product) => ({ value: product.slug, label: product.name })),
              ]}
            />
            <input type="hidden" {...describedBy({ id: productId, error: errors.product_slug })} />
          </RequestField>
        ) : (
          <p className="ui-notice ui-notice-info">
            There is nothing in the catalog to start from right now — pick another project type and describe
            what you have in mind instead.
          </p>
        )
      ) : null}

      <RequestField
        label="Give it a name"
        htmlFor={titleId}
        help="Something you would recognise in a list later. We will make one up if you skip this."
        error={errors.title}
      >
        <input
          className={input}
          value={form.title}
          onChange={(event) => set("title", event.target.value)}
          placeholder="Example: Billet shift knob, or Walnut serving board"
          maxLength={MAX_TITLE}
          autoComplete="off"
          {...describedBy({ id: titleId, help: true, error: errors.title })}
        />
      </RequestField>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Step 2 — Details
 * ------------------------------------------------------------------ */

export function DetailsStep({ form, set, errors }: StepProps) {
  const descriptionId = useId();
  const contextId = useId();
  const materialOtherId = useId();
  const finishOtherId = useId();
  const type = requestType(form.request_type);
  const remaining = MAX_DESCRIPTION - form.description.length;

  return (
    <div className="request-step-body">
      <RequestField
        label="Tell us what you want made and what it needs to do"
        htmlFor={descriptionId}
        required
        error={errors.description}
        help="Plain language beats engineering language. What is it, what does it attach to, and what must not change?"
      >
        <textarea
          className={`${input} min-h-40`}
          value={form.description}
          onChange={(event) => set("description", event.target.value.slice(0, MAX_DESCRIPTION))}
          placeholder="Example: A replacement knob for my drill press. The original cracked. It threads onto a 3/8-16 stud and needs to clear the table by about an inch."
          maxLength={MAX_DESCRIPTION}
          {...describedBy({ id: descriptionId, help: true, error: errors.description })}
        />
        {remaining < 500 ? (
          <span className="ui-help" aria-live="polite">
            {remaining} characters left
          </span>
        ) : null}
      </RequestField>

      {/* The one conditional question this project type earns. */}
      {type?.context ? (
        <RequestField label={type.context.label} htmlFor={contextId} help={type.context.help}>
          <input
            className={input}
            value={form.context}
            onChange={(event) => set("context", event.target.value.slice(0, 300))}
            placeholder={type.context.placeholder}
            maxLength={300}
            autoComplete="off"
            {...describedBy({ id: contextId, help: type.context.help })}
          />
        </RequestField>
      ) : null}

      {/*
        Dimensions, behind a question rather than in front of one.

        "I need help working them out" is a real answer and the commonest one
        for anything that has to fit an existing object. Six empty measurement
        boxes at the top of a form tell that customer they are in the wrong
        place; asking first tells them they are not.
      */}
      {type?.dimensions ? (
        <>
          <ChoiceGroup<"known" | "help">
            legend="Do you know the size it needs to be?"
            name="dimensions_known"
            value={form.dimensions_known}
            onChange={(value) => set("dimensions_known", value)}
            options={[
              { value: "known", label: "I have measurements", blurb: "Even rough ones help." },
              { value: "help", label: "I need help working it out", blurb: "We will measure or advise." },
            ]}
          />

          {form.dimensions_known === "known" ? (
            <RequestFieldset
              legend="Measurements"
              help="Any units — write 3.5in or 90mm. Fill in only what applies; blanks are fine."
            >
              <div className="request-dimension-grid">
                {(
                  [
                    ["length", "Length"],
                    ["width", "Width"],
                    ["height", "Height / thickness"],
                    ["diameter", "Diameter"],
                    ["thread", "Thread or bore"],
                  ] as const
                ).map(([key, label]) => (
                  <label key={key} className="request-dimension">
                    <span className="request-dimension-label">{label}</span>
                    <input
                      className={input}
                      value={form.dimensions[key]}
                      onChange={(event) =>
                        set("dimensions", { ...form.dimensions, [key]: event.target.value.slice(0, 60) })
                      }
                      placeholder={key === "thread" ? "3/8-16" : "—"}
                      maxLength={60}
                      autoComplete="off"
                    />
                  </label>
                ))}
              </div>
              <label className="request-dimension mt-3 block">
                <span className="request-dimension-label">Anything critical about the sizes</span>
                <input
                  className={input}
                  value={form.dimensions.notes}
                  onChange={(event) =>
                    set("dimensions", { ...form.dimensions, notes: event.target.value.slice(0, 300) })
                  }
                  placeholder="Example: the 90mm has to be exact, everything else can move."
                  maxLength={300}
                  autoComplete="off"
                />
              </label>
            </RequestFieldset>
          ) : (
            <p className="ui-notice ui-notice-info">
              No problem. Send a photo of what it has to fit on the next step and we will work the sizes out
              with you.
            </p>
          )}
        </>
      ) : null}

      <div className="request-pair">
        <RequestFieldset legend="Material">
          <MenuSelect
            ariaLabel="Material"
            value={form.material}
            onChange={(value) => set("material", value)}
            className={selectTrigger}
            options={MATERIAL_OPTIONS.map((option) => ({ value: option.value, label: option.label }))}
          />
          {form.material === "other" ? (
            <div className="mt-3">
              <RequestField label="Which material?" htmlFor={materialOtherId} error={errors.material_other}>
                <input
                  className={input}
                  value={form.material_other}
                  onChange={(event) => set("material_other", event.target.value.slice(0, 120))}
                  placeholder="Tell us what you had in mind"
                  maxLength={120}
                  autoComplete="off"
                  {...describedBy({ id: materialOtherId, error: errors.material_other })}
                />
              </RequestField>
            </div>
          ) : null}
        </RequestFieldset>

        <RequestFieldset legend="Finish">
          <MenuSelect
            ariaLabel="Finish"
            value={form.finish}
            onChange={(value) => set("finish", value)}
            className={selectTrigger}
            options={FINISH_OPTIONS.map((option) => ({ value: option.value, label: option.label }))}
          />
          {form.finish === "other" ? (
            <div className="mt-3">
              <RequestField label="Which finish?" htmlFor={finishOtherId} error={errors.finish_other}>
                <input
                  className={input}
                  value={form.finish_other}
                  onChange={(event) => set("finish_other", event.target.value.slice(0, 120))}
                  placeholder="Tell us what you had in mind"
                  maxLength={120}
                  autoComplete="off"
                  {...describedBy({ id: finishOtherId, error: errors.finish_other })}
                />
              </RequestField>
            </div>
          ) : null}
        </RequestFieldset>
      </div>

      <p className="request-aside">
        Not sure on either? Leave them on “recommend one”. Material and finish are part of what the quote
        answers, not something you have to decide first.
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Step 4 — Quantity, budget, timing, delivery
 * ------------------------------------------------------------------ */

export function LogisticsStep({ form, set, errors }: StepProps) {
  const budgetMinId = useId();
  const budgetMaxId = useId();
  const dateId = useId();
  const postalId = useId();

  return (
    <div className="request-step-body">
      <RequestFieldset legend="How many do you need?" help={`Between 1 and ${MAX_QUANTITY}.`}>
        <div className="max-w-56">
          <QuantityField
            label=""
            value={form.quantity}
            max={null}
            absoluteMax={MAX_QUANTITY}
            showMax={false}
            onCommit={(value) => set("quantity", value)}
          />
        </div>
        {errors.quantity ? (
          <p className="request-error" role="alert">
            {errors.quantity}
          </p>
        ) : null}
      </RequestFieldset>

      <ChoiceGroup<Repeatability>
        legend="Is this a one-off?"
        name="repeatability"
        value={form.repeatability}
        onChange={(value) => set("repeatability", value)}
        options={REPEATABILITY_OPTIONS.map((option) => ({
          value: option.value,
          label: option.label,
          blurb: option.blurb,
        }))}
        help="It changes how we set the job up — it does not change what you are committing to."
      />

      {/* ---------------- Budget ---------------- */}
      <ChoiceGroup<BudgetMode>
        legend={
          <>
            Budget <span className="request-optional">optional</span>
          </>
        }
        name="budget_mode"
        value={form.budget_mode}
        onChange={(value) => set("budget_mode", value)}
        options={BUDGET_OPTIONS.map((option) => ({ value: option.value, label: option.label }))}
        help="A number helps us suggest a sensible material and approach. Telling us one does not mean we have accepted it, and leaving it blank does not put you at the back of the queue."
      />

      {form.budget_mode !== "none" ? (
        <div className="request-pair">
          <RequestField
            label={form.budget_mode === "range" ? "From" : "Target price"}
            htmlFor={budgetMinId}
            error={errors.budget_min}
          >
            <div className="request-money">
              <span className="request-money-symbol" aria-hidden="true">
                $
              </span>
              <input
                className={`${input} request-money-input`}
                inputMode="decimal"
                value={form.budget_min}
                onChange={(event) => set("budget_min", event.target.value.slice(0, 12))}
                placeholder="250"
                autoComplete="off"
                {...describedBy({ id: budgetMinId, error: errors.budget_min })}
              />
            </div>
          </RequestField>

          {form.budget_mode === "range" ? (
            <RequestField label="To" htmlFor={budgetMaxId} error={errors.budget_max}>
              <div className="request-money">
                <span className="request-money-symbol" aria-hidden="true">
                  $
                </span>
                <input
                  className={`${input} request-money-input`}
                  inputMode="decimal"
                  value={form.budget_max}
                  onChange={(event) => set("budget_max", event.target.value.slice(0, 12))}
                  placeholder="600"
                  autoComplete="off"
                  {...describedBy({ id: budgetMaxId, error: errors.budget_max })}
                />
              </div>
            </RequestField>
          ) : null}
        </div>
      ) : null}

      {/* ---------------- Timing ---------------- */}
      <ChoiceGroup<Timing>
        legend="When do you need it?"
        name="timing"
        value={form.timing}
        onChange={(value) => set("timing", value)}
        options={TIMING_OPTIONS.map((option) => ({
          value: option.value,
          label: option.label,
          blurb: option.blurb,
        }))}
      />

      {form.timing === "by-date" ? (
        <RequestField
          label="Date you need it by"
          htmlFor={dateId}
          required
          error={errors.target_date}
          help="This is the date you are hoping for. It is not a delivery date until a quote confirms one."
        >
          <input
            className={input}
            type="date"
            min={todayIso()}
            value={form.target_date}
            onChange={(event) => set("target_date", event.target.value)}
            {...describedBy({ id: dateId, help: true, error: errors.target_date })}
          />
        </RequestField>
      ) : null}

      {/* ---------------- Delivery ---------------- */}
      <ChoiceGroup<DeliveryIntent>
        legend="How should it reach you?"
        name="delivery"
        value={form.delivery}
        onChange={(value) => set("delivery", value)}
        options={DELIVERY_OPTIONS.map((option) => ({
          value: option.value,
          label: option.label,
          blurb: option.blurb,
        }))}
      />

      {/*
        A postal code, and only a postal code.

        The old form demanded a full shipping address — name, street, city,
        state, ZIP — before it would show you the review step, for an inquiry
        that charges nothing and ships nothing. A postal code is enough to
        estimate carriage in a quote, and the full address is confirmed when
        there is something to send.
      */}
      {form.delivery === "shipping" ? (
        <RequestField
          label={
            <>
              Postal code <span className="request-optional">optional</span>
            </>
          }
          htmlFor={postalId}
          error={errors.postal_code}
          help="Just enough to estimate shipping. We confirm the full address before anything is sent — there is no need to type it now."
        >
          <input
            className={`${input} max-w-44`}
            value={form.postal_code}
            onChange={(event) => set("postal_code", event.target.value.slice(0, 24))}
            placeholder="ZIP or postal code"
            autoComplete="postal-code"
            {...describedBy({ id: postalId, help: true, error: errors.postal_code })}
          />
        </RequestField>
      ) : null}
    </div>
  );
}
