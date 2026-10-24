/**
 * The one DOM id every page's own `<h1>` (`PageHeader` in
 * `src/app/dashboard/page-chrome.tsx`) carries, so `heading-focus.tsx` can
 * find it from the persistent shell without either module importing a
 * component from the other.
 *
 * Deliberately its own plain module (no `"use client"`, no React) so a
 * Server Component (`page-chrome.tsx` is one) can import the constant
 * directly, while the client-only focus logic lives in `heading-focus.tsx`.
 */
export const PAGE_HEADING_ID = "page-heading";
