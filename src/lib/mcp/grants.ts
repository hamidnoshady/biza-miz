/**
 * Issue #883 (wave 2) — the least-privilege grant vocabulary for MCP
 * connections: WHICH apps, WHICH branches.
 *
 * `scopes` (pos.read / pos.write) decides *whether* a connection may read and
 * write at all; `grants` decides *where within the business*. A connection
 * whose owner wants "CRM reads only, for my accounting questions" must be able
 * to say exactly that, and the catalogue + dispatcher must refuse everything
 * else without leaking that it exists.
 *
 * This module is pure — no database, no framework — so it can be unit-tested
 * exhaustively and so the consent UI, the connections service, the dispatcher
 * and the OAuth flow all parse stored values through the same fail-closed
 * code. Parsing NEVER throws: something this short shipped with a shipping
 * release gets read from production rows forever.
 */

/** The application domains a connection can be granted. Mirrors the issue's
 * own app list: POS, Accounting, CRM, Growth & Marketing, Website Management,
 * My Workspace. */
export const MCP_APPS = [
  "pos",
  "accounting",
  "crm",
  "growth",
  "website",
  "workspace",
] as const;

export type McpApp = (typeof MCP_APPS)[number];

/** Persian labels, for the consent screen and the connections page. */
export const MCP_APP_LABELS: Record<McpApp, string> = {
  pos: "صندوق و عملیات",
  accounting: "حسابداری",
  crm: "مشتریان",
  growth: "رشد و بازاریابی",
  website: "وب‌سایت",
  workspace: "میز کار من",
};

/** Short English descriptions, for the consent screen's second language. */
export const MCP_APP_DESCRIPTIONS: Record<McpApp, string> = {
  pos: "Menu, orders, inventory, tables, delivery, production and waste.",
  accounting: "Ledger, payroll, VAT, receivables/payables, expense drafts and reports.",
  crm: "Customers, segments, loyalty, notes and customer timeline.",
  growth: "Message templates and marketing campaigns.",
  website: "Website manager: posts, products and WooCommerce status.",
  workspace: "Project desk (میز کار): tasks, projects, contracts, team approvals.",
};

/** A single app's read/write grant. */
export interface McpAppGrant {
  read: boolean;
  write: boolean;
}

/** The parsed grant document. */
export interface McpGrants {
  /**
   * app → grant. Only apps named here are reachable. `read: true` allows the
   * app's read tools; `write: true` its write tools — write still requires
   * 'pos.write' in scopes, and the model never "upgrades" a read into a write.
   */
  apps: Partial<Record<McpApp, McpAppGrant>>;
  /**
   * Branch consent: the names of the branches this connection may reach.
   *   * 'all' — the owner consented to every branch, today and when a new one
   *     opens (multi-branch).
   *   * string[] — only these location ids. An empty array is not legal at
   *     mint time; parse keeps it so a stored value round-trips, but
   *     `mcpGrantsUsable` treats it as no access rather than as everything.
   */
  branches: string[] | "all";
}

/**
 * The legacy default for every connection minted before wave 2. Empty means:
 * keep behaving the way the connection meant when its owner granted it — that
 * is the "conservative legacy migration" the issue demands. What it meant
 * then, in the code, was: every app its authorizer could reach (the read
 * catalogue was a pure authorizer-permission filter), and every branch (the
 * tools all answered business-wide). So `{}` parses to exactly that.
 */
export const LEGACY_GRANTS: McpGrants = {
  apps: {}, // {} = every app at scope level, resolved by mcpAppGrantsFor
  branches: "all",
};

function isApp(value: unknown): value is McpApp {
  return typeof value === "string" && (MCP_APPS as readonly string[]).includes(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parse a stored `grants` jsonb value fail-closed.
 *
 *   * Not an object / null / undefined → the legacy default ({} rows are the
 *     conservative-migration case: all apps at scope level, all branches).
 *   * Unknown top-level keys and unknown apps → dropped (a removed vocabulary
 *     entry must never widen a connection).
 *   * `branches: "all"` or an array of strings; anything else is invalid and
 *     parses to a CLOSED value (no branches), never to "all".
 *
 * Returns the same "empty grants" object for `{}` keyed by reference, so
 * callers can cheaply detect the legacy case with `grants === LEGACY_GRANTS`.
 */
export function parseMcpGrants(value: unknown): McpGrants {
  if (!isPlainObject(value) || Object.keys(value).length === 0) return LEGACY_GRANTS;

  const appsRaw = isPlainObject(value.apps) ? value.apps : {};
  const apps: Partial<Record<McpApp, McpAppGrant>> = {};
  for (const app of MCP_APPS) {
    const granted = appsRaw[app];
    if (!isPlainObject(granted)) continue;
    apps[app] = {
      read: granted.read === true,
      write: granted.write === true,
    };
  }

  let branches: string[] | "all" = [];
  if (value.branches === "all") {
    branches = "all";
  } else if (Array.isArray(value.branches)) {
    branches = value.branches.filter(
      (branch): branch is string => typeof branch === "string" && branch.length > 0,
    );
  }
  return { apps, branches };
}

/**
 * Whether a stored grants document GRANTS anything at all. `parseMcpGrants`
 * never throws and can produce the closed shape (no app grants, no branches)
 * from a malformed stored value; this is the distinction the dispatcher needs
 * between "legacy connection, behaves as minted" and "says nothing / names
 * nothing". A closed grants document denies every tool — never error-open.
 */
export function mcpGrantsUsable(grants: McpGrants): boolean {
  return (
    grants.branches === "all" ||
    grants.branches.length > 0 ||
    isLegacyGrants(grants)
  );
}

/** True when the document is the legacy `{}` (all apps, all branches). */
export function isLegacyGrants(grants: McpGrants): boolean {
  return grants === LEGACY_GRANTS || (Object.keys(grants.apps).length === 0 && grants.branches === "all");
}

/**
 * Whether an app is readable. Absent app in a non-legacy document means no;
 * in the legacy document every app reads (as before).
 */
export function mcpCanReadApp(grants: McpGrants, app: McpApp): boolean {
  if (isLegacyGrants(grants)) return true;
  return grants.apps[app]?.read === true;
}

/** Whether an app is writable. Same rule as read. */
export function mcpCanWriteApp(grants: McpGrants, app: McpApp): boolean {
  if (isLegacyGrants(grants)) return true;
  return grants.apps[app]?.write === true;
}

/**
 * The branch classification the dispatcher needs:
 *
 *   * 'multi' — branches is "all", OR an explicit list of 2+ branches, OR a
 *     legacy connection: the connection answers questions that span branches
 *     (branch comparison, business-wide reports).
 *   * 'single' — an explicit one-branch list: only that branch is reachable,
 *     and the read tools an MCP connection may call are pinned to it.
 */
export type McpBranchScope = "single" | "multi";

export function mcpBranchScopeOf(grants: McpGrants): McpBranchScope {
  if (isLegacyGrants(grants)) return "multi";
  if (grants.branches === "all") return "multi";
  return grants.branches.length <= 1 ? "single" : "multi";
}

/** The explicit branches a connection reaches; null = "all". */
export function mcpBrancheIds(grants: McpGrants): string[] | null {
  return grants.branches === "all" ? null : grants.branches;
}

/**
 * Validate owner's grant choices at mint time (never trust the request body).
 *
 * The rule set:
 *   * At least one app with read OR write must be granted.
 *   * write requires its matching read: a connection that "may move menu
 *     prices but not see the menu" is meaningless and also blind.
 *   * branches: a non-empty array of location ids, or "all".
 *   * `app.grants === null` allowed but means "no apps at all" (legacy).
 */
export type McpGrantMintError =
  | "no_apps"
  | "write_without_read"
  | "no_branches";

export function validateMcpGrantsMint(value: McpGrants): McpGrantMintError | null {
  if (isLegacyGrants(value)) return null;
  const grantedApps = MCP_APPS.filter(
    (app) => value.apps[app]?.read === true || value.apps[app]?.write === true,
  );
  if (grantedApps.length === 0) return "no_apps";
  for (const app of grantedApps) {
    if (value.apps[app]?.write === true && value.apps[app]?.read !== true) return "write_without_read";
  }
  if (value.branches !== "all" && value.branches.length === 0) return "no_branches";
  return null;
}

/**
 * The document the consent screen and the connections panel build by default
 * (issue #883 §1 "safe defaults"): every app READABLE, nothing writable, only
 * the branch the owner is currently working in — never "all". The owner then
 * widens from here; the UI can never mint the legacy `{}` shape for a new
 * connection.
 */
export function defaultGrantsForConsents(primaryBranchId: string): McpGrants {
  const apps: Partial<Record<McpApp, McpAppGrant>> = {};
  for (const app of MCP_APPS) apps[app] = { read: true, write: false };
  return { apps, branches: [primaryBranchId] };
}

/**
 * Serialize for the wire/DB — the service accepts the same shape, so the UI
 * never builds raw strings of its own.
 */
export function grantsToStorage(grants: McpGrants): unknown {
  const apps: Record<string, { read: boolean; write: boolean }> = {};
  for (const app of MCP_APPS) {
    const granted = grants.apps[app];
    if (granted) apps[app] = { read: granted.read, write: granted.write };
  }
  if (grants.branches === "all") return { apps, branches: "all" };
  return { apps, branches: [...grants.branches] };
}
