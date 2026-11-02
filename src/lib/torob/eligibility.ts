/**
 * Issue #894 Wave 1 — which managed website may become a Torob shop.
 *
 * The issue's first acceptance criterion is the one this file exists for:
 *
 *   *"Only «بیزامیز»-managed, correctly owned and connected websites may enroll;
 *   unmanaged URLs cannot register."*
 *
 * That is a rule about a **registry**, not about a form field, so it is written
 * once here as a pure function: the caller hands in the websites the platform
 * already manages for this business and the shops that exist, and gets back one
 * row per website saying whether it can enroll and, when it cannot, exactly what
 * to do about it. No database, no HTTP, nothing to mock — the service layer's job
 * is only to read the two registries and pass them in.
 *
 * Two things are deliberate:
 *
 *   1. **There is no "url" anywhere in the input.** A website is identified by the
 *      connection row Bizamiz itself created. There is no shape here a pasted
 *      address could be coerced into, which is cheaper to keep true than a
 *      validation rule someone later loosens.
 *   2. **Ineligible websites are returned, not filtered.** A merchant whose
 *      WordPress connector is out of date needs to see *that* website with
 *      «افزونهٔ اتصال به‌روز نیست» and a link to fix it, rather than an empty list
 *      that looks like the site was never set up. The screen decides what to do
 *      with the row; the reason is data.
 */

/** The two website systems Bizamiz manages. Torob is a channel onto both. */
export type TorobWebsiteKind = "woocommerce" | "eshobe_cms";

/**
 * What the platform knows about one website, as read from its own registry.
 *
 * Deliberately the *connection* facts, not catalogue facts: whether the site's
 * storefront is currently syncing products is a Wave 2 question (the feed is what
 * proves it), while "is this connection alive and owned by this business" is what
 * decides whether a shop may exist at all.
 */
export interface ManagedWebsiteCandidate {
  kind: TorobWebsiteKind;
  /** `integration_connections.id` or `eshobe_cms_connections.id`. */
  connectionId: string;
  /** Verified host, already normalised by the caller (lowercase, no scheme). */
  domain: string;
  /** A human label for the screen: the store's name or the CMS site's title. */
  label: string;
  /** The connection's own state, already reduced to the two facts we need. */
  connection: {
    /** `active` for both registries; anything else cannot enroll. */
    active: boolean;
    /** Whether the site can serve a product catalogue today. */
    catalogueReady: boolean;
    /** Why not, in the registry's own words — internal, operator-facing. */
    disabledReason: string | null;
  };
}

/** An existing Torob shop, as this business sees it. */
export interface ExistingTorobShop {
  id: string;
  kind: TorobWebsiteKind;
  connectionId: string;
  domain: string;
  authorizationState: "not_authorized" | "pending_approval" | "authorized" | "revoked";
  enabled: boolean;
}

/**
 * The states a website row can be in on the Growth screen.
 *
 * The issue asks for six and, crucially, for them to be told apart: *"Differentiate
 * site catalogue ready, Torob API ready, Torob connection approved, Torob webhook
 * accepted, and actual Torob listing/indexed. Never claim an accepted webhook
 * means products are indexed."* Wave 1 can only know the first two honestly, so
 * those are the only ones it produces — `connected` here means **authorized**,
 * and the feed states arrive in Wave 2 beside the data that can prove them.
 */
export type TorobWebsiteState =
  | "eligible"
  | "needs_attention"
  | "connected"
  | "pending_approval"
  | "inactive"
  | "disconnected";

export interface TorobWebsiteRow {
  kind: TorobWebsiteKind;
  connectionId: string;
  domain: string;
  label: string;
  state: TorobWebsiteState;
  /** Present once a shop exists; null while the website is only a candidate. */
  shop: ExistingTorobShop | null;
  /**
   * The internal reason a row is not simply `eligible`, for the console and the
   * log. Never tenant copy — the screen maps `state` to a first-party sentence.
   */
  reason: string | null;
}

/**
 * Resolve one row per managed website.
 *
 * Order of decision, which is also the order the merchant experiences:
 *
 *   1. the connection is not active → `inactive` (nothing Torob can do);
 *   2. the site cannot serve a catalogue → `needs_attention` (repair the site
 *      first: a feed of nothing is worse than no feed);
 *   3. a shop exists and is authorized → `connected`;
 *   4. a shop exists and waits on Torob's approval → `pending_approval`;
 *   5. a shop exists but was revoked → `disconnected` (an explicit merchant
 *      choice, so it is not an error and not a suggestion to retry silently);
 *   6. otherwise the website is `eligible`.
 *
 * A shop whose `enabled` is false but which is authorized is still `connected`:
 * the channel exists and can be switched on. `enabled` is the run switch, not a
 * different kind of relationship, and conflating them is how a merchant who
 * paused one site sees it as broken.
 */
export function resolveTorobWebsites(input: {
  websites: readonly ManagedWebsiteCandidate[];
  shops: readonly ExistingTorobShop[];
}): TorobWebsiteRow[] {
  const shopsByWebsite = new Map<string, ExistingTorobShop>();
  for (const shop of input.shops) {
    shopsByWebsite.set(websiteKey(shop.kind, shop.connectionId), shop);
  }

  const resolved = input.websites.map((website) => {
    const shop = shopsByWebsite.get(websiteKey(website.kind, website.connectionId)) ?? null;
    const base = {
      kind: website.kind,
      connectionId: website.connectionId,
      domain: website.domain,
      label: website.label,
      shop,
    };

    if (!website.connection.active) {
      return {
        ...base,
        state: "inactive" as const,
        reason: website.connection.disabledReason ?? "connection_inactive",
      };
    }

    if (!website.connection.catalogueReady) {
      return {
        ...base,
        state: "needs_attention" as const,
        reason: website.connection.disabledReason ?? "catalogue_unavailable",
      };
    }

    switch (shop?.authorizationState) {
      case "authorized":
        return { ...base, state: "connected" as const, reason: null };
      case "pending_approval":
        return { ...base, state: "pending_approval" as const, reason: null };
      case "revoked":
        return { ...base, state: "disconnected" as const, reason: "revoked_by_merchant" };
      case "not_authorized":
      case undefined:
        return { ...base, state: "eligible" as const, reason: null };
    }
  });

  /**
   * One shop per domain, decided here rather than discovered as a unique
   * violation.
   *
   * `torob_shops` is unique on `(business_id, domain)`, and the two registries can
   * legitimately point at the same host — a WooCommerce plugin and the Eshobe site
   * it is installed on are two managed websites at one address. Whichever one
   * already has a shop owns the domain (that is a registered fact); of the rest,
   * the first in registry order may enroll and the others are told why they
   * cannot. Only `eligible` rows are touched, because they are the only rows that
   * would insert a new shop.
   */
  const ownerByDomain = new Map<string, string>();
  for (const row of resolved) {
    if (row.shop) ownerByDomain.set(row.domain, websiteKey(row.kind, row.connectionId));
  }

  return resolved.map((row) => {
    const key = websiteKey(row.kind, row.connectionId);
    const owner = ownerByDomain.get(row.domain);
    if (owner && owner !== key && row.state === "eligible" && !row.shop) {
      return { ...row, state: "needs_attention" as const, reason: "domain_already_enrolled" };
    }
    if (!owner && row.state === "eligible") ownerByDomain.set(row.domain, key);
    return row;
  });
}

/**
 * The websites that may enroll right now.
 *
 * A `disconnected` website is included: reconnecting is the same operation as
 * connecting, and the service makes it idempotent. A `connected` one is not —
 * connecting an existing shop is a no-op that must not mint a second credential.
 */
export function enrollable(row: TorobWebsiteRow): boolean {
  return row.state === "eligible" || row.state === "disconnected";
}

/**
 * Each manager's own storefront product route, as the template a feed composes a
 * page URL from (`{id}` → local id, `{sku}` → SKU).
 *
 * It lives beside the website kinds because it *is* a fact about the manager, not
 * about Torob: the plugin's storefront uses `/product/{slug}` and the CMS's uses
 * `/products/{id}`. A shop stores its own copy, so a business that moves its
 * route edits one row — and Wave 4's screen edits exactly that.
 */
export const DEFAULT_PRODUCT_PATH: Readonly<Record<TorobWebsiteKind, string>> = {
  woocommerce: "/product/{id}",
  eshobe_cms: "/products/{id}",
};

/** Stable identity for a website across the two registries. */
export function websiteKey(kind: TorobWebsiteKind, connectionId: string): string {
  return `${kind}:${connectionId}`;
}

/**
 * Normalise a host for storage and comparison.
 *
 * The two registries store different things — WooCommerce a full `base_url`,
 * Eshobe a bare `site_domain` — so this is the single place a host is derived
 * from either. Returns `null` rather than throwing: an unparseable URL is a
 * website that cannot enroll, not an exception in the middle of a page render.
 *
 * An international domain comes back in its ASCII (`xn--`) form, because `URL`
 * does that — and it is the right form to store: Wave 2 matches Torob's
 * `page_url` hosts against this column, and the same function normalises both
 * sides, so `فروشگاه.ایران` and its punycode are the *same* shop rather than two.
 */
export function normaliseHost(value: string | null | undefined): string | null {
  const raw = (value ?? "").trim().toLowerCase();
  if (!raw) return null;
  let host: string;
  try {
    host = new URL(raw.includes("://") ? raw : `https://${raw}`).hostname;
  } catch {
    return null;
  }
  host = host.replace(/\.$/, "");
  // A bare IP or a single label (`localhost`) is never a public Torob shop: the
  // issue requires a publicly reachable domain, and accepting an internal host
  // here would publish a feed to something only we can reach.
  if (!host.includes(".") || /^\d+\.\d+\.\d+\.\d+$/.test(host) || host === "[::1]") return null;
  return host;
}
