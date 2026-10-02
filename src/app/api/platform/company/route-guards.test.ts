/**
 * Per-method guard regression for the Platform Business API surface.
 *
 * Every route under `/api/platform/company/**` crosses a realm boundary: the
 * caller is a *platform* identity and the data it touches belongs to the
 * internal company's *tenant*. The order that crossing has to happen in is
 * fixed, because each step is what makes the next one safe:
 *
 *   authenticate/platform session → resolve the ACTIVE identity → resolve the
 *   membership → check the preset permission → replace the platform bypass
 *   with the internal tenant scope → do the operation
 *
 * Doing any of that by hand in a handler is how the first version of this
 * surface drifted: some routes checked a role, some read a `businessId` from
 * the request, some forgot the tenant scope entirely and wrote through the
 * platform bypass. `withPlatformScope(...)` performs the whole sequence, so
 * this suite requires it on every handler that authenticates a platform
 * session, and separately forbids the shortcuts that used to stand in for it.
 *
 * Two routes legitimately sit outside it: `/status` answers the very first
 * question ("does the company exist, and am I in it?") before a membership can
 * exist, and `/setup` is the provisioning call itself. Both are allow-listed
 * here by name rather than by a flag inside the file, so adding one is a
 * visible decision in this test.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const COMPANY_API_ROOT = join(process.cwd(), "src", "app", "api", "platform", "company");

/** Routes whose whole job is to establish what `withPlatformScope` requires. */
const PRE_MEMBERSHIP_ROUTES = new Set([
  "status/route.ts",
  "setup/route.ts",
  // The handoff redeemer is minted and redeemed by the token alone; there is
  // no platform session to authenticate on the tenant origin by design.
  "../../../auth/company-handoff/route.ts",
]);

function collectRouteFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectRouteFiles(full));
    else if (entry.name === "route.ts") out.push(full);
  }
  return out;
}

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

function handlerBlocks(src: string): { method: string; index: number; body: string }[] {
  const anchors: { method: string; index: number }[] = [];
  for (const method of METHODS) {
    const re = new RegExp(`export\\s+(?:async\\s+)?function\\s+${method}\\b|export\\s+const\\s+${method}\\s*=`, "g");
    for (const m of src.matchAll(re)) anchors.push({ method, index: m.index ?? 0 });
  }
  anchors.sort((a, b) => a.index - b.index);
  return anchors.map((anchor, i) => ({
    method: anchor.method,
    index: anchor.index,
    body: src.slice(anchor.index, anchors[i + 1]?.index ?? src.length),
  }));
}

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const files = collectRouteFiles(COMPANY_API_ROOT);
const relatives = files.map((file) => relative(COMPANY_API_ROOT, file));

/**
 * The route inventory, pinned.
 *
 * `docs/platform-company-route-inventory.md` classifies every route in this
 * surface. A document nobody checks drifts within a sprint, so the list lives
 * here too: adding a route to `src/app/api/platform/company/**` fails this test
 * until it is named, which is the moment someone has to decide whether it is
 * ACTIVE, NEEDS_CALLER, INTERNAL_ONLY, EXTERNAL_INTEGRATION or a DUPLICATE of
 * something that already exists — rather than discovering a sixth project
 * endpoint six months later.
 */
const KNOWN_ROUTES = [
  "accounting/reconciliation/route.ts",
  "crm/customers/route.ts",
  "crm/deals/route.ts",
  "growth/audience/route.ts",
  "members/route.ts",
  "open/route.ts",
  "setup/route.ts",
  "status/route.ts",
  "websites/credentials/route.ts",
  "websites/sites/route.ts",
  "workspace/from-deal/route.ts",
  "workspace/projects/route.ts",
].sort();

describe("platform company route inventory", () => {
  it("every route file is named in the inventory", () => {
    expect([...relatives].sort()).toEqual(KNOWN_ROUTES);
  });

  it("no route was removed without updating the inventory", () => {
    expect(KNOWN_ROUTES.filter((name) => !relatives.includes(name))).toEqual([]);
  });
});

describe("platform company API guard contract", () => {
  it("found the route files (the scan is not vacuously green)", () => {
    expect(files.length).toBeGreaterThan(8);
  });

  it("has exactly the pre-membership routes it claims", () => {
    const unexpected = relatives.filter(
      (name) => PRE_MEMBERSHIP_ROUTES.has(name) && !/^(status|setup)\/route\.ts$/.test(name),
    );
    expect(unexpected).toEqual([]);
  });

  for (const file of files) {
    const name = relative(COMPANY_API_ROOT, file);
    if (PRE_MEMBERSHIP_ROUTES.has(name)) continue;
    const src = readFileSync(file, "utf8");

    describe(name, () => {
      const blocks = handlerBlocks(src);

      it("exports at least one handler", () => {
        expect(blocks.length).toBeGreaterThan(0);
      });

      for (const block of blocks) {
        it(`${block.method} runs withPlatformScope`, () => {
          expect(block.body).toMatch(/withPlatformScope\s*\(/);
        });
      }

      it("never accepts a business id from the request", () => {
        const code = stripComments(src);
        for (const pattern of [
          // A business id ASSIGNED from request data. `actor.businessId` is the
          // adapter's, and passing it to a helper is the whole point.
          /\bbusinessId\s*[:=]\s*(body|await\s+request\.json|request\.nextUrl|searchParams)/,
          /\b(body|searchParams)\s*\.\s*(get\s*\(\s*["']businessId|businessId)/,
          /\bbody\s*\.\s*businessId\b/,
          /\bcompanyBusinessId\s*[:=]\s*[^\n]*\b(body|searchParams|nextUrl)\b/,
        ]) {
          expect(code).not.toMatch(pattern);
        }
      });

      it("never branches on a platform administrator role to decide a company question", () => {
        const code = stripComments(src);
        // `role === 'owner'`, `isSuperadmin`, `padmin`-only checks and the like
        // silently bypass membership. The adapter decides that, not the route.
        for (const pattern of [
          /\broles?\s*(===|!==|==)\s*["'](owner|admin|superadmin)["']/,
          /\b(?:isSuperadmin|isPlatformOwner|session\.role)\s*(?:===|&&|\|\|)/,
        ]) {
          expect(code).not.toMatch(pattern);
        }
      });

      it("never reaches for a tenant-realm helper without going through the adapter", () => {
        const code = stripComments(src);
        // `requireSession()` authenticates a TENANT session; a platform route
        // must not treat one as a company membership.
        expect(code).not.toMatch(/\brequireSession\s*\(/);
      });
    });
  }
});

describe("platform company authorization helpers stay authoritative", () => {
  const adapter = readFileSync(join(process.cwd(), "src", "lib", "platform-company.ts"), "utf8");

  it("exposes withPlatformScope only through the tenant scope, never a bare bypass", () => {
    // The whole point of the adapter: the bypass is replaced by tenant scope
    // before any handler body runs.
    expect(adapter).toMatch(/withTenant\s*\(\s*actor\.businessId/);
  });

  it("logs no token, hash, password or raw company-secret value", () => {
    const code = stripComments(adapter);
    for (const pattern of [
      /console\.[a-z]+\s*\([^)]*\b(token|tokenHash|password|secret|credential)\b/i,
      /platformCompanyLog\([^)]*\b(token|password)\b/i,
    ]) {
      expect(code).not.toMatch(pattern);
    }
  });
});

describe("money and dates in the Platform Business UI", () => {
  const roots = [
    join(process.cwd(), "src", "app", "platform", "company"),
    join(process.cwd(), "src", "app", "api", "platform", "company"),
  ];

  function collect(dir: string, acc: string[] = []): string[] {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) collect(full, acc);
      else if (/\.tsx?$/.test(entry.name)) acc.push(full);
    }
    return acc;
  }

  const uiFiles = roots.flatMap((root) => collect(root));
  const tsxFiles = uiFiles.filter((file) => file.endsWith(".tsx"));

  it("found the company UI files", () => {
    expect(tsxFiles.length).toBeGreaterThan(3);
  });

  for (const file of tsxFiles) {
    const name = relative(process.cwd(), file);
    const src = readFileSync(file, "utf8");
    const code = stripComments(src);

    describe(name, () => {
      it("never divides or multiplies by 10 to fake a money unit", () => {
        // Money is integer Rial in storage and formatted through useMoney /
        // formatMoney. A hand-rolled /10 hides the unit from the reader and
        // breaks the moment the business picks Rial.
        expect(code).not.toMatch(/\b\w*[Rr]ial\w*\s*(\/|\*)\s*10\b/);
        expect(code).not.toMatch(/\bMath\.(floor|round|trunc)\s*\(\s*\w*[Rr]ial\w*\s*\/\s*10/);
      });

      it("does not hard-code a money unit next to a number", () => {
        for (const pattern of [/\{\s*\d[\d_]*\s*\}\s*"\s*(?:ریال|تومان)/, /`(?:[^`]*)\b(?:ریال|تومان)`/]) {
          expect(code).not.toMatch(pattern);
        }
      });

      it("formats dates through the Jalali helpers rather than toLocaleDateString", () => {
        // Every user-visible date in the product is Shamsi.
        expect(code).not.toMatch(/toLocaleDateString|toLocaleString\s*\(|Intl\.DateTimeFormat/);
      });
    });
  }
});

describe("historical backfill matches the live event model", () => {
  const migration = readFileSync(
    join(process.cwd(), "migrations", "0193_platform_company_security_and_repair.sql"),
    "utf8",
  );
  const backfill = readFileSync(
    join(process.cwd(), "scripts", "platform-company-billing-backfill.ts"),
    "utf8",
  );

  it("uses the same source_version values its triggers use", () => {
    // A replay that minted different (table, id, version) tuples would create
    // a second event for a fact already posted — and therefore a second
    // journal entry for money that moved once.
    for (const version of ["'issued'", "'void'", "'created'", "'invoice-settlement'"]) {
      expect(migration, `migration should emit ${version}`).toContain(version);
      expect(backfill, `backfill should emit ${version}`).toContain(version);
    }
    // The two dynamic versions are computed from the same expressions: the
    // trigger is only reached for a verified payment, so 'settlement:'||status
    // IS 'settlement:verified'.
    expect(migration).toContain("'settlement:'||NEW.status");
    expect(backfill).toContain("'settlement:verified'");
    expect(migration).toContain("'paid:'||");
    expect(backfill).toContain("'paid:'||");
  });

  it("clips replayed settlements with the same helper the triggers use", () => {
    expect(backfill).toContain("platform_company_invoice_settled_rial");
  });

  it("is dry-run by default and never runs during migration, startup or deployment", () => {
    const code = stripComments(backfill);
    expect(code).toMatch(/--apply/);
    expect(code).toMatch(/process\.argv\.includes\("--apply"\)/);
    const server = readFileSync(join(process.cwd(), "server.ts"), "utf8");
    expect(server).not.toMatch(/billing-backfill/);
  });
});

describe("migration 0193 narrows the billing-event RLS hole without widening anything", () => {
  const migration = readFileSync(
    join(process.cwd(), "migrations", "0193_platform_company_security_and_repair.sql"),
    "utf8",
  );

  it("keys the read policy on the internal business, not on customer_tenant_id", () => {
    const policy = migration.slice(migration.indexOf("CREATE POLICY internal_company_select"));
    expect(policy).toContain("internal_business_id = app_current_business()");
    expect(policy).not.toContain("customer_tenant_id = app_current_business()");
  });

  it("never lets the customer tenant INSERT, UPDATE or DELETE an event", () => {
    for (const [name, verb] of [
      ["outbox_insert", "INSERT"],
      ["internal_company_update", "UPDATE"],
      ["internal_company_delete", "DELETE"],
    ] as const) {
      const policies = migration
        .split(/CREATE POLICY\s+/)
        .filter((chunk) => chunk.startsWith(name));
      expect(policies.length, `${verb} policy present`).toBe(1);
      expect(policies[0], `${verb} policy requires the bypass`).toContain("app_rls_bypass()");
    }
  });

  it("drops the old leaky policies by name", () => {
    // 0191 shipped a single permissive policy; every successor it might have
    // been renamed to is dropped here so a partial rename cannot leave the
    // customer tenant able to read the outbox.
    for (const name of [
      "tenant_isolation",
      "internal_company_access",
      "internal_company_select",
      "internal_company_update",
      "internal_company_delete",
      "outbox_insert",
    ]) {
      expect(migration).toContain(`DROP POLICY IF EXISTS ${name} ON platform_company_billing_events;`);
    }
  });

  it("makes the outbox write path idempotent at the database level", () => {
    // Two layers, because application-level checks lose to concurrent workers:
    // one posting row per event, and at most one posted journal entry per
    // (business, source_id).
    expect(migration).toContain(
      "CREATE UNIQUE INDEX IF NOT EXISTS platform_company_accounting_postings_event",
    );
    expect(migration).toContain("ON platform_company_accounting_postings (event_id)");
    expect(migration).toContain("CREATE UNIQUE INDEX journal_entries_platform_billing_source");
    expect(migration).toContain("WHERE source_type = 'platform_billing'");
  });
});
