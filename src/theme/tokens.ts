export const colors = {
  primary: "var(--brand-primary, #fbbf24)",
  primarySoft: "color-mix(in srgb, var(--brand-primary, #fbbf24) 70%, white)",

  accent: "var(--brand-accent, #f59e0b)",
  accentSoft: "color-mix(in srgb, var(--brand-accent, #f59e0b) 70%, white)",

  bgStart: "var(--km-bg, #0a0f10)",
  bgEnd: "var(--km-bg-end, #050708)",

  text: "var(--km-text, #f4f4f5)",
  textMuted: "var(--km-muted, #a1a1aa)",
} as const;
