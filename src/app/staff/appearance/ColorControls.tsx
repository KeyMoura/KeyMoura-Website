"use client";

import { useId } from "react";

import { cx } from "@/components/ui/DesignSystem";
import { type AppearanceSetting } from "@/theme/appearanceMap";
import { settingFor, taskById, type AppearanceTask } from "@/theme/appearanceTasks";

import { anchorId } from "./EditorChrome";

/**
 * Colour editing, rebuilt around the two questions the old rows could not
 * answer: *what does this paint*, and *why did changing one thing move six*.
 *
 * ## What a row used to be
 *
 * A 28px swatch, a hex field and — for the seven optional colours — an unlabelled
 * checkbox reading "Use brand accent". Three of those seven do not follow the
 * accent, so the checkbox was wrong about half the time it appeared; and an
 * automatic colour showed an empty text box beside a filled swatch, which reads
 * as a bug rather than as inheritance.
 *
 * ## What it is now
 *
 * The swatch is large enough to judge a colour by. The value is always readable,
 * whether it is set or inherited. Inheritance is a stated relationship —
 * "Following the accent colour" with an Override button — rather than a checkbox
 * whose meaning has to be reverse-engineered. And every field that has been
 * moved away from what is published offers to put it back, which is the reset
 * an owner actually wants: not "back to the factory palette", but "undo what I
 * just did to this one thing".
 */

export type ColorValues = {
  /** The working value for a setting. */
  valueOf: (setting: AppearanceSetting) => string;
  /** What an *automatic* setting actually renders as — per setting, never one shared accent. */
  fallbackOf: (setting: AppearanceSetting) => string;
  /** The published value, for the per-field reset. */
  publishedOf: (setting: AppearanceSetting) => string;
  onChange: (setting: AppearanceSetting, value: string) => void;
};

/** Relative luminance, for the contrast hint. WCAG's formula. */
function luminance(hex: string): number {
  const values = [1, 3, 5]
    .map((index) => Number.parseInt(hex.slice(index, index + 2), 16) / 255)
    .map((value) => (value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4));
  return 0.2126 * values[0] + 0.7152 * values[1] + 0.0722 * values[2];
}

export function contrastRatio(first: string, second: string): number {
  if (!/^#[0-9a-f]{6}$/i.test(first) || !/^#[0-9a-f]{6}$/i.test(second)) return 21;
  const [high, low] = [luminance(first), luminance(second)].sort((left, right) => right - left);
  return (high + 0.05) / (low + 0.05);
}

/**
 * One thing on the screen, with only its own colours.
 *
 * Fields are labelled by the role the colour plays *in this thing* — Background,
 * Text, Border — not by the token's name. "Secondary button background" only
 * means something to somebody who already knows the custom-project button is a
 * secondary button; under a heading that says **Custom project button**, the
 * field is simply Background.
 */
export function TaskEditor({
  task,
  colors,
  /** Text/background pairs worth warning about inside this task, by field role. */
  contrastPair,
}: {
  task: AppearanceTask;
  colors: ColorValues;
  contrastPair?: { text: AppearanceSetting["key"]; background: AppearanceSetting["key"] };
}) {
  if (task.pointer) {
    const target = taskById(task.pointer.toTaskId);
    return (
      <div
        id={anchorId(`task-${task.id}`)}
        tabIndex={-1}
        className="scroll-mt-4 rounded-[var(--control-radius)] border border-brand-border p-3"
      >
        <p className="text-sm font-semibold">{task.label}</p>
        <p className="mt-1 text-xs text-brand-textMuted">{task.description}</p>
        {/* An honest non-answer beats an empty search result, and beats a second
            control writing the same value from a different screen. */}
        <p className="mt-2 text-xs text-brand-textMuted">
          {task.pointer.because} Change it under <b>{target?.label ?? task.pointer.toTaskId}</b>.
        </p>
      </div>
    );
  }

  const warn = (() => {
    if (!contrastPair) return "";
    const text = colors.valueOf(settingFor(contrastPair.text)) || colors.fallbackOf(settingFor(contrastPair.text));
    const background =
      colors.valueOf(settingFor(contrastPair.background)) ||
      colors.fallbackOf(settingFor(contrastPair.background));
    const ratio = contrastRatio(text, background);
    return ratio < 4.5 ? `Text on this background is ${ratio.toFixed(1)}:1. Small text needs 4.5:1 to stay readable.` : "";
  })();

  return (
    <div
      className="scroll-mt-4 rounded-[var(--control-radius)] border border-brand-border p-3"
      id={anchorId(`task-${task.id}`)}
      tabIndex={-1}
    >
      <p className="text-sm font-semibold">{task.label}</p>
      <p className="mt-1 text-xs text-brand-textMuted">{task.description}</p>

      <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {task.fields.map((field) => {
          const setting = settingFor(field.key);
          return (
            <ColorField
              key={field.key}
              role={field.role}
              setting={setting}
              value={colors.valueOf(setting)}
              fallback={colors.fallbackOf(setting)}
              published={colors.publishedOf(setting)}
              onChange={(value) => colors.onChange(setting, value)}
            />
          );
        })}
      </div>

      {/*
        Contrast feedback, not a contrast block.
        The brief was explicit that an intentional choice should not be refused,
        so this is a sentence next to the pair that caused it — the owner can
        read it and carry on.
      */}
      {warn ? <p className="mt-2 text-xs text-amber-300">{warn}</p> : null}

      {task.fields.some((field) => settingFor(field.key).shared) ? (
        <p className="mt-2 text-xs text-amber-300">
          Shared — this colour is used in more than one place, so changing it moves them together.
        </p>
      ) : null}
    </div>
  );
}

/**
 * A single colour: name, swatch, value, and its relationship to everything else.
 *
 * The inheritance control is a button pair rather than a checkbox because the
 * two states are not symmetrical. "Following the accent colour" is a *statement
 * about where the value comes from*, and the action on it is Override; "Custom
 * #E5A000" is a value, and the action on it is Reset. A checkbox forces both
 * into one label, which is how the old control ended up saying "Use brand
 * accent" on the three fields that follow the primary.
 */
function ColorField({
  role,
  setting,
  value,
  fallback,
  published,
  onChange,
}: {
  role: string;
  setting: AppearanceSetting;
  value: string;
  /** What this renders as while automatic — the accent, the primary, or the button fill. */
  fallback: string;
  /** The published value, for Reset. */
  published: string;
  onChange: (value: string) => void;
}) {
  const id = useId();
  const following = Boolean(setting.optional) && !value;
  const shown = value || fallback;
  const moved = value !== published;

  return (
    <div className="rounded-[var(--control-radius)] border border-brand-border/70 p-2.5">
      <div className="flex items-start justify-between gap-2">
        <span className="text-xs font-semibold">{role}</span>
        {/*
          Reset means "back to what is published", not "back to the factory
          palette". Somebody who has made a mess of one colour wants that colour
          undone; a button that also reverted the four sections they had just
          finished would be the worst possible reading of the word.
        */}
        {moved ? (
          <button
            type="button"
            onClick={() => onChange(published)}
            className="text-[11px] font-semibold text-brand-accent hover:underline"
          >
            Reset
          </button>
        ) : null}
      </div>

      <div className="mt-2 flex items-center gap-2">
        {/*
          A following colour shows the colour it *renders* as, so the swatch is
          never a lie — and the value beside it is labelled as inherited rather
          than typed into the field, because "following" and "set to exactly
          this" behave differently the next time the palette moves.
        */}
        <input
          type="color"
          id={id}
          value={shown}
          aria-label={`${setting.label} — colour picker`}
          onChange={(event) => onChange(event.target.value)}
          className="ui-color-input !h-9 !w-9 flex-none"
        />
        {following ? (
          <p className="min-w-0 text-[11px] leading-4 text-brand-textMuted">
            Following <b className="font-semibold text-brand-text">{setting.optional?.inheritsFrom}</b>
            <span className="block font-mono uppercase">{shown}</span>
          </p>
        ) : (
          <input
            value={value}
            aria-label={`${setting.label} — hex value`}
            onChange={(event) => onChange(event.target.value)}
            className="ui-input min-w-0 !py-1.5 font-mono text-xs uppercase"
            maxLength={7}
          />
        )}
      </div>

      {setting.optional ? (
        <button
          type="button"
          /* Turning inheritance off seeds the field with the colour it was
             already rendering, so opting out never changes what is on screen —
             it only stops it tracking future palette changes. */
          onClick={() => onChange(following ? fallback : "")}
          className="mt-2 text-[11px] font-semibold text-brand-accent hover:underline"
        >
          {following ? "Give it its own colour" : `Follow ${setting.optional.inheritsFrom} again`}
        </button>
      ) : null}

      <p className="mt-1.5 text-[11px] leading-4 text-brand-textMuted">{setting.description}</p>
    </div>
  );
}

/** A titled run of tasks. Used by every section that edits colours. */
export function ColorRun({
  title,
  description,
  tasks,
  colors,
  contrastPairs,
}: {
  title: string;
  description?: string;
  tasks: AppearanceTask[];
  colors: ColorValues;
  contrastPairs?: Record<string, { text: AppearanceSetting["key"]; background: AppearanceSetting["key"] }>;
}) {
  if (!tasks.length) return null;
  return (
    <section className={cx("space-y-3")}>
      <div>
        <h3 className="text-sm font-semibold">{title}</h3>
        {description ? <p className="mt-1 text-xs text-brand-textMuted">{description}</p> : null}
      </div>
      <div className="grid gap-3">
        {tasks.map((task) => (
          <TaskEditor key={task.id} task={task} colors={colors} contrastPair={contrastPairs?.[task.id]} />
        ))}
      </div>
    </section>
  );
}
