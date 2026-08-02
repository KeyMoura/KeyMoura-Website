"use client";

import { useEffect, useRef, type CSSProperties, type ElementType, type ReactNode } from "react";

/**
 * Scroll reveals, driven by one shared IntersectionObserver.
 *
 * Every revealed element on a page registers with the same observer rather than
 * creating its own, and each element is unobserved the moment it appears, so a
 * long page costs one listener and a handful of one-shot callbacks.
 *
 * The visual hidden state lives in CSS behind `[data-motion="on"]`, which the
 * root layout's pre-paint script sets only when scripting works and the visitor
 * has not requested reduced motion. This component therefore only ever *adds*
 * visibility; it can never leave content hidden.
 */

let observer: IntersectionObserver | null = null;

function sharedObserver(): IntersectionObserver | null {
  if (typeof IntersectionObserver === "undefined") return null;
  if (observer) return observer;
  observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        (entry.target as HTMLElement).dataset.revealed = "true";
        observer?.unobserve(entry.target);
      }
    },
    // Start the transition slightly before the element is fully on screen so it
    // has finished by the time the reader reaches it.
    { rootMargin: "0px 0px -12% 0px", threshold: 0.05 }
  );
  return observer;
}

type RevealProps = {
  children: ReactNode;
  as?: ElementType;
  className?: string;
  /** Milliseconds to hold before this element starts. */
  delay?: number;
  /** Reveal children in sequence instead of the element as a whole. */
  stagger?: boolean;
  style?: CSSProperties;
  id?: string;
  "aria-labelledby"?: string;
};

export default function Reveal({
  children,
  as: Tag = "div",
  className,
  delay = 0,
  stagger = false,
  style,
  ...rest
}: RevealProps) {
  const ref = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;

    const active = sharedObserver();
    if (!active) {
      node.dataset.revealed = "true";
      return;
    }

    active.observe(node);
    return () => active.unobserve(node);
  }, []);

  const classes = [stagger ? "reveal-stagger" : "reveal", className].filter(Boolean).join(" ");

  return (
    <Tag
      ref={ref}
      className={classes}
      style={delay ? ({ ...style, "--reveal-delay": `${delay}ms` } as CSSProperties) : style}
      {...rest}
    >
      {children}
    </Tag>
  );
}
