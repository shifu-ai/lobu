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
 *  4. Sets `data-theme` attribute + `starlight-theme` localStorage so Starlight stays in sync
 *  5. Adds `dark-mode`/`light-mode` class on `<body>` for Scalar API Reference
 *  6. Runs before paint so there's no FOUC
 */
export function themeScript(_astro: AstroGlobal) {
  return `(function(){var e=document.documentElement;var s=e.style;var n;var apply=function(){e.setAttribute("data-theme",n);try{localStorage.setItem("starlight-theme",n)}catch(x){}var b=document.body;if(b){b.classList.add(n+"-mode");b.classList.remove(n==="dark"?"light-mode":"dark-mode")}else{document.addEventListener("DOMContentLoaded",function(){document.body.classList.add(n+"-mode");document.body.classList.remove(n==="dark"?"light-mode":"dark-mode")})}};var L=function(){n="light";${varsToJs(light)};apply()};var D=function(){n="dark";${varsToJs(dark)};apply()};var h=location.hash.match(/[#&]theme=(dark|light)\\b/);if(h){if(h[1]==="dark"){D()}else{L()}}else if(window.matchMedia("(prefers-color-scheme:dark)").matches){D()}else{L()}})();`;
}
