// Theme tokens for the landing page.
//
// This module is inlined as a <script is:inline> in BaseLayout.astro so it
// runs before paint, bypassing Tailwind's CSS cascade entirely.  It sets CSS
// custom properties directly on document.documentElement.style — which wins
// over any stylesheet rule.
//
// Components reference these via var(--color-page-*) in inline styles and
// Tailwind arbitrary-value classes like bg-[var(--color-page-surface)].

/** Light palette (default) */
export const light = {
  "--color-page-bg": "#ffffff",
  "--color-page-bg-elevated": "#fafafa",
  "--color-page-bg-overlay": "rgba(255, 255, 255, 0.85)",
  "--color-page-surface": "#ffffff",
  "--color-page-surface-dim": "#f5f5f7",
  "--color-page-border": "rgba(0, 0, 0, 0.08)",
  "--color-page-border-active": "rgba(0, 0, 0, 0.16)",
  "--color-page-text": "#0b0b0d",
  "--color-page-text-muted": "#6b7280",

  "--color-tg-bg": "rgb(33, 33, 33)",
  "--color-tg-bg-secondary": "rgb(15, 15, 15)",
  "--color-tg-bubble-out": "#c2410c",
  "--color-tg-bubble-in": "rgb(33, 33, 33)",
  "--color-tg-accent": "#c2410c",
  "--color-tg-accent-rgb": "194, 65, 12",
  "--color-tg-border": "rgb(48, 48, 48)",
  "--color-tg-text": "white",
  "--color-tg-meta": "rgba(255, 255, 255, 0.533)",

  "--color-page-bg-inverted": "#0b0b0d",
  "--color-page-text-inverted": "#ffffff",
  "--color-page-dotted": "rgba(0, 0, 0, 0.08)",
  "--color-page-grid": "rgba(0, 0, 0, 0.06)",
  "--color-page-divider-mark": "rgba(0, 0, 0, 0.18)",
  "--color-page-overlay-backdrop": "rgba(0, 0, 0, 0.7)",
  "--color-page-code-bg": "rgba(0, 0, 0, 0.04)",
  "--color-page-code-border": "rgba(0, 0, 0, 0.08)",
  "--color-page-pre-bg-from": "rgba(20, 20, 24, 0.98)",
  "--color-page-pre-bg-to": "rgba(12, 12, 16, 0.98)",
  "--color-page-pre-border": "rgba(255, 255, 255, 0.09)",
  "--color-page-prose-text": "rgba(11, 11, 13, 0.82)",
  "--color-page-prose-blockquote": "rgba(11, 11, 13, 0.7)",
  "--color-page-hex-stroke": "rgba(0, 0, 0, 0.18)",
  "--color-page-hex-line": "rgba(0, 0, 0, 0.08)",
  "--color-page-shadow-sm": "0 1px 2px rgba(0, 0, 0, 0.05)",
  "--color-page-shadow-md":
    "0 12px 32px rgba(0, 0, 0, 0.08), 0 2px 6px rgba(0, 0, 0, 0.04)",
  "--color-page-dialog-close-bg": "rgba(0, 0, 0, 0.5)",
  "--color-page-dialog-close-hover": "rgba(0, 0, 0, 0.7)",
  "--color-page-meta-theme": "#ffffff",
} as const;

/** Dark palette */
export const dark = {
  "--color-page-bg": "#0a0a0b",
  "--color-page-bg-elevated": "#111113",
  "--color-page-bg-overlay": "rgba(10, 10, 11, 0.85)",
  "--color-page-surface": "#161618",
  "--color-page-surface-dim": "#1c1c1f",
  "--color-page-border": "rgba(255, 255, 255, 0.08)",
  "--color-page-border-active": "rgba(255, 255, 255, 0.16)",
  "--color-page-text": "#f0f0f2",
  "--color-page-text-muted": "#9ca3af",

  "--color-tg-bg": "rgb(22, 22, 24)",
  "--color-tg-bg-secondary": "rgb(10, 10, 11)",
  "--color-tg-bubble-in": "rgb(22, 22, 24)",
  "--color-tg-border": "rgb(48, 48, 48)",

  "--color-page-bg-inverted": "#f0f0f2",
  "--color-page-text-inverted": "#0a0a0b",
  "--color-page-dotted": "rgba(255, 255, 255, 0.06)",
  "--color-page-grid": "rgba(255, 255, 255, 0.04)",
  "--color-page-divider-mark": "rgba(255, 255, 255, 0.14)",
  "--color-page-overlay-backdrop": "rgba(0, 0, 0, 0.8)",
  "--color-page-code-bg": "rgba(255, 255, 255, 0.06)",
  "--color-page-code-border": "rgba(255, 255, 255, 0.08)",
  "--color-page-pre-bg-from": "rgba(20, 20, 24, 0.98)",
  "--color-page-pre-bg-to": "rgba(12, 12, 16, 0.98)",
  "--color-page-pre-border": "rgba(255, 255, 255, 0.09)",
  "--color-page-prose-text": "rgba(240, 240, 242, 0.82)",
  "--color-page-prose-blockquote": "rgba(240, 240, 242, 0.7)",
  "--color-page-hex-stroke": "rgba(255, 255, 255, 0.14)",
  "--color-page-hex-line": "rgba(255, 255, 255, 0.06)",
  "--color-page-shadow-sm": "0 1px 2px rgba(0, 0, 0, 0.3)",
  "--color-page-shadow-md":
    "0 12px 32px rgba(0, 0, 0, 0.4), 0 2px 6px rgba(0, 0, 0, 0.2)",
  "--color-page-dialog-close-bg": "rgba(255, 255, 255, 0.15)",
  "--color-page-dialog-close-hover": "rgba(255, 255, 255, 0.25)",
  "--color-page-meta-theme": "#0a0a0b",
} as const;
