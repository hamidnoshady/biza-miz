/**
 * What the CMS edit modal may open — the client-safe half of `owner-bridge.ts`, shared by
 * the embed route and the screens that open the modal. It mirrors the CMS's own
 * `EMBED_COLLECTIONS`; anything outside it is refused here before the CMS is asked.
 * `header`, `footer` and `site-branding` are per-site singletons the CMS opens from their
 * list view.
 */
export const OWNER_EMBED_COLLECTIONS = [
  "posts",
  "pages",
  "categories",
  "media",
  "forms",
  "form-submissions",
  "header",
  "footer",
  "site-branding",
] as const;
export type OwnerEmbedCollection = (typeof OWNER_EMBED_COLLECTIONS)[number];

export function isOwnerEmbedCollection(value: unknown): value is OwnerEmbedCollection {
  return typeof value === "string" && (OWNER_EMBED_COLLECTIONS as readonly string[]).includes(value);
}

/** One document (or its «new» form), a collection's list, or the site's whole panel. */
export type OwnerEmbedView = "edit" | "list" | "dashboard";

export type OwnerEmbedTarget =
  | { view?: "edit"; collection: OwnerEmbedCollection; id?: string }
  | { view: "list"; collection: OwnerEmbedCollection }
  | { view: "dashboard" };
