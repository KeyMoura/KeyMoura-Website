"use client";

import * as React from "react";
import { createPortal } from "react-dom";

export type MenuSelectOption<T extends string = string> = {
  value: T;
  label: string;
  disabled?: boolean;
};

type Props<T extends string = string> = {
  value: T;
  onChange: (next: T) => void;
  options: MenuSelectOption<T>[];
  disabled?: boolean;
  ariaLabel?: string;
  className?: string;
  menuClassName?: string;
  align?: "left" | "right";
  renderValue?: (opt: MenuSelectOption<T> | undefined) => React.ReactNode;
  renderOption?: (opt: MenuSelectOption<T>, active: boolean) => React.ReactNode;
};

/**
 * Sitewide dropdown that matches the Staff role dropdown style:
 * - Button trigger (rounded-xl)
 * - Dark popover panel (rounded-2xl)
 * - Option rows (rounded-xl)
 */
export function MenuSelect<T extends string = string>({
  value,
  onChange,
  options,
  ariaLabel,
  className,
  menuClassName,
  align = "right",
  renderValue,
  renderOption,
  disabled = false,
}: Props<T>) {
  const [open, setOpen] = React.useState(false);
  const rootRef = React.useRef<HTMLDivElement | null>(null);
  const triggerRef = React.useRef<HTMLButtonElement | null>(null);
  const menuRef = React.useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = React.useState<{
    top: number;
    left: number;
    minWidth: number;
    maxWidth: number;
  } | null>(null);

  const selected = React.useMemo(
    () => options.find((o) => o.value === value),
    [options, value]
  );

  React.useEffect(() => {
    if (!open) return;
    // Use a *capturing* pointerdown listener so we close even when inner
    // components stop propagation or are inside overflow/portals.
    const onPointerDown = (e: PointerEvent) => {
      const root = rootRef.current;
      const menu = menuRef.current;
      const path = typeof e.composedPath === "function" ? e.composedPath() : [];

      if (root && (path.includes(root) || root.contains(e.target as Node))) return;
      if (menu && (path.includes(menu) || menu.contains(e.target as Node))) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const recomputePosition = React.useCallback(() => {
    const btn = triggerRef.current;
    if (!btn) return;

    const rect = btn.getBoundingClientRect();
    const viewportW = window.innerWidth;
    const viewportH = window.innerHeight;

    const GAP = 6;
    const PAD = 8;

    // Default menu width is 16rem (w-64). If you override menuClassName, we still
    // clamp to the viewport.
    const defaultMenuW = 256;
    const maxWidth = Math.max(180, Math.min(defaultMenuW, viewportW - PAD * 2));

    let left = align === "right" ? rect.right - maxWidth : rect.left;
    left = Math.max(PAD, Math.min(left, viewportW - PAD - maxWidth));

    // Max visible items = 8, item height ~36px, plus panel padding.
    const maxPanelH = 288 + 16;

    const spaceBelow = viewportH - rect.bottom - PAD;
    const spaceAbove = rect.top - PAD;
    const shouldFlip = spaceBelow < maxPanelH && spaceAbove > spaceBelow;

    // Always position using `top` (never `bottom`). Some browsers can produce
    // odd document scroll behavior when a portaled, fixed-position element uses
    // only `bottom`.
    const top = shouldFlip
      ? Math.max(PAD, rect.top - GAP - maxPanelH)
      : Math.min(viewportH - PAD - maxPanelH, rect.bottom + GAP);

    setPos({
      top,
      left,
      minWidth: rect.width,
      maxWidth,
    });
  }, [align]);

  React.useEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    recomputePosition();

    const onResize = () => recomputePosition();
    const onScroll = () => recomputePosition();
    window.addEventListener("resize", onResize);
    // capture scroll so it updates even when scrolling nested containers
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("resize", onResize);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [open, recomputePosition]);

  const triggerCls =
    className ??
    "flex h-9 items-center gap-2 rounded-xl border border-zinc-800 bg-black/40 px-3 text-xs text-brand-text outline-none transition-all hover:border-amber-400/80 disabled:opacity-50 disabled:cursor-not-allowed";

  const menuWrapCls =
    menuClassName ?? "overflow-hidden rounded-2xl border border-zinc-800 bg-black/95 shadow-2xl";

  return (
    <div ref={rootRef} className="relative inline-block">
      <button
        type="button"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        ref={triggerRef}
        onClick={() => { if (disabled) return; setOpen((v) => !v); }}
        className={triggerCls}
      >
        <span className="min-w-0 truncate">
          {renderValue ? renderValue(selected) : selected?.label ?? "Select"}
        </span>
        <span className="opacity-70">▾</span>
      </button>

      {open && pos
        ? createPortal(
            // Render the menu itself as a fixed-position element (no full-screen
            // wrapper). This avoids any possibility of "phantom" document height
            // on desktop browsers while keeping outside-click detection.
            <div
              ref={menuRef}
              data-menuselect-portal
              style={{
                position: "fixed",
                left: pos.left,
                top: pos.top,
                minWidth: pos.minWidth,
                width: pos.maxWidth,
                zIndex: 1000,
              }}
              className={menuWrapCls}
            >
              <div className="p-2" role="listbox" aria-label={ariaLabel ?? "Select"}>
                {/* show max 8 options before scrolling */}
                <div className="max-h-72 overflow-y-auto pr-1">
                  <div className="space-y-1">
                    {options.map((o) => {
                      const active = o.value === value;
                      const optDisabled = Boolean(o.disabled);
                      return (
                        <button
                          key={o.value}
                          type="button"
                          disabled={optDisabled}
                          onClick={() => {
                            if (optDisabled) return;
                            onChange(o.value);
                            setOpen(false);
                          }}
                          className={`flex w-full items-center justify-between gap-3 rounded-xl border px-3 py-2 text-left text-xs transition ${
                            active
                              ? "border-amber-400/40 bg-amber-500/10 text-amber-100"
                              : "border-transparent bg-transparent text-brand-text hover:border-zinc-700"
                          } ${optDisabled ? "opacity-50 cursor-not-allowed" : ""}`}
                        >
                          {renderOption ? renderOption(o, active) : <span className="text-[11px]">{o.label}</span>}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>
            </div>,
            document.body
          )
        : null}
    </div>
  );
}
