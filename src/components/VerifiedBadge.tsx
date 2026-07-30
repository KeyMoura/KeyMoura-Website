// src/components/VerifiedBadge.tsx
"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faCircleCheck } from "@fortawesome/free-solid-svg-icons";

type Props = {
  className?: string;
};

type TooltipPos = { left: number; top: number };

export function VerifiedBadge({ className = "" }: Props) {
  const tooltipText = "This user has been officially verified";
  const anchorRef = useRef<HTMLSpanElement | null>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<TooltipPos | null>(null);

  // Avoid a "setState in effect" mount-flag. This component is client-only;
  // we can portal whenever document.body exists.
  const canPortal = typeof document !== "undefined" && !!document.body;

  const updatePos = () => {
    const el = anchorRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    // Tooltip centered under the icon.
    setPos({ left: r.left + r.width / 2, top: r.bottom + 6 });
  };

  useEffect(() => {
    if (!open) return;
    updatePos();

    const onScroll = () => updatePos();
    const onResize = () => updatePos();
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
    };
  }, [open]);

  return (
    <>
      <span
        ref={anchorRef}
        className="inline-flex items-center justify-center align-middle leading-none"
        aria-label={tooltipText}
        onMouseEnter={() => {
          setOpen(true);
          // compute on next tick so layout is stable
          queueMicrotask(updatePos);
        }}
        onMouseLeave={() => setOpen(false)}
      >
        <FontAwesomeIcon
          icon={faCircleCheck}
          // Slightly smaller than surrounding text by default.
          style={{ fontSize: "0.6em" }}
          className={"block text-sky-400 " + className}
          aria-label={tooltipText}
        />
      </span>

      {canPortal && open && pos
        ? createPortal(
            <span
              role="tooltip"
              className="pointer-events-none fixed z-[9999] -translate-x-1/2 whitespace-nowrap rounded-md border border-zinc-700 bg-black/90 px-2 py-1 text-[10px] text-brand-text shadow-lg"
              style={{ left: pos.left, top: pos.top }}
            >
              {tooltipText}
            </span>,
            document.body
          )
        : null}
    </>
  );
}
