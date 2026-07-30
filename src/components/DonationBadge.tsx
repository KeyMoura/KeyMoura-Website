"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { getDonationRankMeta } from "@/lib/donationRanks";

type Props = {
  // Supabase fields are often typed as `string | null`, so accept unknown and validate internally.
  rank: unknown;
  className?: string;
};

type TooltipPos = { left: number; top: number };

export function DonationBadge({ rank, className = "" }: Props) {
  const anchorRef = useRef<HTMLSpanElement | null>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<TooltipPos | null>(null);

  const meta = useMemo(() => getDonationRankMeta(rank), [rank]);
  const tooltipText = meta?.label ?? "";
  const canPortal = typeof document !== "undefined" && !!document.body;

  const updatePos = () => {
    const el = anchorRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({ left: r.left + r.width / 2, top: r.bottom + 6 });
  };

  useEffect(() => {
    // If rank becomes invalid, ensure tooltip closes.
    if (!meta) {
      if (open) setOpen(false);
      return;
    }

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, meta]);

  if (!meta) return null;

  return (
    <>
      <span
        ref={anchorRef}
        className="inline-flex items-center justify-center align-middle leading-none"
        aria-label={tooltipText}
        onMouseEnter={() => {
          setOpen(true);
          queueMicrotask(updatePos);
        }}
        onMouseLeave={() => setOpen(false)}
      >
        {/* Render /public/rank-icon.png but tint it using CSS masks so we can control the color precisely per tier. */}
        <span
          className={"block " + className}
          aria-hidden
          style={{
            width: "0.85em",
            height: "0.85em",
            backgroundColor: meta.colorHex,
            WebkitMaskImage: "url(/rank-icon.png)",
            WebkitMaskRepeat: "no-repeat",
            WebkitMaskPosition: "center",
            WebkitMaskSize: "contain",
            maskImage: "url(/rank-icon.png)",
            maskRepeat: "no-repeat",
            maskPosition: "center",
            maskSize: "contain",
          }}
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
