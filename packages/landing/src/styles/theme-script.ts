import type { AstroGlobal } from "astro";
import { dark, light } from "../styles/theme-tokens";

function varsToJs(vars: Record<string, string>) {
  return Object.entries(vars)
    .map(([k, v]) => `s.setProperty("${k}","${v.replace(/"/g, '\\"')}");`)
    .join("");
}

/**
 * Returns a `<script is:inline>` body that:
 *  1. Checks `location.hash` for `#theme=dark` or `#theme=light` (testing override)
 *  2. Falls back to `prefers-color-scheme` media query (OS preference)
 *  3. Applies the matching palette via inline `style` on `<html>`
 *  4. Runs before paint so there's no FOUC
 *
 * Inline styles on the element win over every CSS rule (layers, !important
 * in @theme, etc.), which is exactly what we need to defeat Tailwind v4's
 * @layer theme hoisting of custom properties.
 */
export function themeScript(_astro: AstroGlobal) {
  return `(function(){var s=document.documentElement.style;var L=function(){${varsToJs(light)}};var D=function(){${varsToJs(dark)}};var h=location.hash.match(/[#&]theme=(dark|light)\\b/);if(h){if(h[1]==="dark"){D()}else{L()}}else if(window.matchMedia("(prefers-color-scheme:dark)").matches){D()}else{L()}})();`;
}
