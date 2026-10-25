import type { MetadataRoute } from "next";
import { BRAND_NAME_EN, BRAND_NAME_FA, BRAND_TAGLINE_FA } from "@/lib/brand";

/**
 * PWA manifest (Phase 12) — served at /manifest.webmanifest by Next 15.
 *
 * Makes the complete Bizamiz platform installable as a standalone desktop app
 * (and on tablets/phones). Once installed, Chrome/Edge give it its own window
 * with no browser chrome, a Start-menu entry, and an icon — so it launches and
 * behaves like native software. Legacy Windows launchers can open this installed app directly.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    // lang is "fa" below, so the installed app is named in Persian.
    name: `${BRAND_NAME_FA} | ${BRAND_TAGLINE_FA}`,
    short_name: BRAND_NAME_FA,
    description: `${BRAND_NAME_EN} — multi-app platform for business management`,
    // Standalone = its own window, no browser tabs/address bar (looks native).
    display: "standalone",
    // Fixes the installed app's identity so it isn't treated as a new/duplicate
    // install if start_url ever gains query params.
    id: "/",
    // Where the app opens. Relative so it works on localhost, LAN IP, or domain.
    start_url: "/",
    scope: "/",
    dir: "rtl",
    lang: "fa",
    orientation: "any",
    background_color: "#0f172a",
    theme_color: "#0f172a",
    // A real PNG set matters here, not just the SVG: Chrome/Edge's installability
    // check has historically required a raster icon, and without one "Install app"
    // silently falls back to a browser "shortcut" (which keeps the address bar)
    // instead of a true standalone install. Maskable uses icon-square.svg's
    // full-bleed art (see scripts/generate-icons.ts) so the OS can crop it into
    // any shape without exposing transparent corners.
    icons: [
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      {
        src: "/icon-maskable-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
