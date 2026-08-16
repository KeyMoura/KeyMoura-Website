"use client";

import { useId, type ReactNode } from "react";
import { cx } from "@/components/ui/DesignSystem";

/**
 * The three controls the request wizard needs that the shared design system
 * does not already have.
 *
 * `Field` in `DesignSystem` renders a `<label>` wrapping its control, which is
 * right for a single input and wrong for two things this form is mostly made
 * of: a group of radio cards, which needs `fieldset`/`legend` because one label
 * cannot name five inputs, and any control that has to announce an error, which
 * needs an id to point `aria-describedby` at.
 *
 * So these exist rather than a fourth spelling of a form row. They keep the same
 * `.ui-label` / `.ui-help` classes so the rhythm matches every other form on
 * the site — the thing `form-field-layout.test.ts` exists to protect.
 *
 * ## Errors are described, not just coloured
 *
 * Every one of these takes an `error` string. When it is set the control gets
 * `aria-invalid`, the message is rendered with `role="alert"`, and
 * `aria-describedby` links the two — so a screen reader user hears *what* is
 * wrong when focus reaches the field, rather than meeting a red border they
 * cannot see and a summary at the bottom of the page they have already passed.
 */

export function RequestField({
  label,
  htmlFor,
  required = false,
  help,
  error,
  className,
  children,
}: {
  label: ReactNode;
  /** The id of the control this labels. Required — this renders a real `<label for>`. */
  htmlFor: string;
  required?: boolean;
  help?: ReactNode;
  error?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cx("ui-field", className)}>
      <label className="ui-label" htmlFor={htmlFor}>
        {label}
        {required ? (
          <>
            <span className="ui-required" aria-hidden="true">
              *
            </span>
            <span className="sr-only"> (required)</span>
          </>
        ) : null}
      </label>
      {children}
      {help ? (
        <span className="ui-help" id={`${htmlFor}-help`}>
          {help}
        </span>
      ) : null}
      {error ? (
        <span className="request-error" id={`${htmlFor}-error`} role="alert">
          {error}
        </span>
      ) : null}
    </div>
  );
}

/** The `aria-*` attributes a control inside `RequestField` should carry. */
export function describedBy({ id, help, error }: { id: string; help?: unknown; error?: string }) {
  const ids = [help ? `${id}-help` : null, error ? `${id}-error` : null].filter(Boolean).join(" ");
  return {
    id,
    "aria-invalid": error ? true : undefined,
    "aria-describedby": ids || undefined,
  } as const;
}

export type Choice<T extends string> = { value: T; label: string; blurb?: string };

/**
 * A group of radio cards.
 *
 * Real `<input type="radio">` elements, visually hidden inside their labels
 * rather than replaced by click handlers on `<div>`s. That is what gives the
 * group arrow-key navigation, a single tab stop, `:focus-visible` on the card
 * through `:has()`, form semantics, and an accessible name for each option —
 * none of which a styled div has, and all of which a customer filling in a form
 * on a phone or with a keyboard depends on.
 */
export function ChoiceGroup<T extends string>({
  legend,
  name,
  value,
  onChange,
  options,
  help,
  error,
  columns = "auto",
  className,
}: {
  legend: ReactNode;
  name: string;
  value: T | "";
  onChange: (value: T) => void;
  options: readonly Choice<T>[];
  help?: ReactNode;
  error?: string;
  /** `auto` fits as many as will sit comfortably; `one` stacks them. */
  columns?: "auto" | "one" | "two";
  className?: string;
}) {
  const id = useId();
  const describedIds = [help ? `${id}-help` : null, error ? `${id}-error` : null].filter(Boolean).join(" ");

  return (
    <fieldset
      className={cx("request-choice-group", className)}
      aria-describedby={describedIds || undefined}
      aria-invalid={error ? true : undefined}
    >
      <legend className="ui-label">{legend}</legend>
      <div className={cx("request-choices", `is-${columns}`)}>
        {options.map((option) => (
          <label
            key={option.value}
            className={cx("request-choice", value === option.value && "is-selected")}
          >
            <input
              type="radio"
              className="sr-only"
              name={name}
              value={option.value}
              checked={value === option.value}
              onChange={() => onChange(option.value)}
            />
            <span className="request-choice-label">{option.label}</span>
            {option.blurb ? <span className="request-choice-blurb">{option.blurb}</span> : null}
          </label>
        ))}
      </div>
      {help ? (
        <p className="ui-help" id={`${id}-help`}>
          {help}
        </p>
      ) : null}
      {error ? (
        <p className="request-error" id={`${id}-error`} role="alert">
          {error}
        </p>
      ) : null}
    </fieldset>
  );
}

/**
 * A titled group of related inputs that is not a radio group — the dimensions
 * block, the budget amounts. A `<fieldset>` rather than a heading and a div, so
 * the legend names the inputs inside it for anyone not reading visually.
 */
export function RequestFieldset({
  legend,
  help,
  error,
  className,
  children,
}: {
  legend: ReactNode;
  help?: ReactNode;
  error?: string;
  className?: string;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <fieldset className={cx("request-fieldset", className)} aria-describedby={help ? `${id}-help` : undefined}>
      <legend className="ui-label">{legend}</legend>
      {children}
      {help ? (
        <p className="ui-help" id={`${id}-help`}>
          {help}
        </p>
      ) : null}
      {error ? (
        <p className="request-error" role="alert">
          {error}
        </p>
      ) : null}
    </fieldset>
  );
}
