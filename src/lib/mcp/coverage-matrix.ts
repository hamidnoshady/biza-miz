/**
 * Issue #883 (package 1) — builds `docs/mcp/coverage-matrix.md` from:
 *
 *   1. every route file under `src/app/api` (verbs + permission tokens it
 *      really exports, read from source — no copy-paste list to drift),
 *   2. ./coverage-map.ts (the curated entity rows and the MCP verbs that
 *      serve each operation column today), and
 *   3. the MCP registries (./registry.ts, ./platform-mcp.ts) for permission
 *      and approval metadata.
 *
 * Rows the map does not claim are NOT swept under the carpet: they appear in
 * an "Unclassified" section so adding a route without a coverage row shows up
 * in the same diff a reviewer reads.
 *
 * Determinism: the route scan is sorted before joining; the output is pure
 * text. `npx tsx scripts/write-mcp-coverage-matrix.mts` regenerates the
 * committed file; the drift test in registry.test.ts compares them.
 */
import { readdirSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, relative, dirname, sep } from "node:path";
import { PERMISSIONS } from "../permissions";
import { TENANT_COVERAGE, PLATFORM_COVERAGE, type CoverageEntity, type CoverageOps } from "./coverage-map";
import { MCP_READ_REGISTRY, MCP_WRITE_REGISTRY } from "./registry";
import { PLATFORM_MCP_TOOLS } from "./platform-mcp";

const OP_COLUMNS = ["list/search/detail", "create", "update", "delete/lifecycle", "bulk/import/export"] as const;
type OpKey = keyof Required<CoverageOps>;
const OPMOST: Record<OpKey, (typeof OP_COLUMNS)[number]> = {
  listDetail: "list/search/detail",
  create: "create",
  update: "update",
  lifecycle: "delete/lifecycle",
  bulk: "bulk/import/export",
};

const LIFECYCLE_ACTIONS = new Set([
  "pay", "reverse", "cancel", "void", "close", "reopen", "approve", "reject", "refund", "returns",
  "redeem", "expire", "complete", "restore", "transfer", "receive", "ship", "archive", "dispose",
  "depreciate", "convert", "publish", "merge", "handoff", "purge", "reconcile", "run", "check",
  "test", "estimate", "disable", "enable", "start", "end", "renew", "resume", "retry", "sync",
  "amend", "reply", "verify", "consign", "sell", "payout", "issue", "propose", "categorize",
  "revalidate", "self-test", "ack", "impersonate", "redeem", "lifecycle", "execute", "rotate",
]);

interface RouteRecord {
  key: string; // e.g. "ledger/accounts/[id]"
  verbs: string[]; // sorted unique
  perms: string[]; // dotted values, sorted unique
}

function walkRoutes(dir: string): RouteRecord[] {
  const out: RouteRecord[] = [];
  const addRoute = (full: string, src: string) => {
    const key = dirname(relative(dir, full)).split(sep).join("/");
    // The management planes of MCP itself are enumerated, not gap-counted.
    if (key === "." || key === "") return;
    const verbs = [...new Set([...src.matchAll(/export (?:const|async function) (GET|POST|PATCH|PUT|DELETE)\b/g)].map((m) => m[1]))].sort();
    if (verbs.length === 0) return;
    const perms = [...new Set([...src.matchAll(/PERMISSIONS\.([a-zA-Z]+)/g)]
      .map((m) => (PERMISSIONS as Record<string, string>)[m[1]])
      .filter((p): p is string => Boolean(p)))].sort();
    out.push({ key, verbs, perms });
  };
  const fallbackWalk = () => {
    const walk = (current: string) => {
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        const full = join(current, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name === "route.ts") addRoute(full, readFileSync(full, "utf8"));
      }
    };
    walk(dir);
  };

  // Windows runners can omit filesystem entries when materializing large,
  // nested route trees. Use Git's cross-platform path inventory as the
  // authoritative set, while reading modified/untracked source from disk.
  try {
    const prefix = relative(process.cwd(), dir).split(sep).join("/");
    const paths = execFileSync(
      "git",
      ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", prefix],
      { encoding: "utf8" },
    ).split("\0").filter((path) => path.endsWith("/route.ts"));
    if (paths.length === 0) fallbackWalk();
    for (const path of paths) {
      const full = join(process.cwd(), path);
      let src: string;
      try {
        src = readFileSync(full, "utf8");
      } catch {
        src = execFileSync("git", ["show", `HEAD:${path}`], { encoding: "utf8" });
      }
      addRoute(full, src);
    }
  } catch {
    out.length = 0;
    fallbackWalk();
  }
  return out.sort((a, b) => a.key.localeCompare(b.key));
}

type Column = (typeof OP_COLUMNS)[number];

function columnsForRoute(verb: string, routeKey: string): Column[] {
  const segments = routeKey.split("/");
  const tail = segments[segments.length - 1];
  if (verb === "GET") return ["list/search/detail"];
  if (verb === "PATCH" || verb === "PUT") return ["update"];
  if (verb === "DELETE") return ["delete/lifecycle"];
  // POST
  if (routeKey.includes("/import") || routeKey.includes("/export") || routeKey.includes("/bulk")) return ["bulk/import/export"];
  if (tail.startsWith("[")) return ["delete/lifecycle"]; // e.g. cheques/[id]/[action]
  const lastFixed = [...segments].reverse().find((s) => !s.startsWith("[")) ?? "";
  if (LIFECYCLE_ACTIONS.has(lastFixed)) return ["delete/lifecycle"];
  return ["create"];
}

interface DerivedRow {
  entity: CoverageEntity;
  matched: RouteRecord[];
  /** op column -> MCP verbs (empty = route only) */
  ops: Record<OpKey, string[]>;
  columnsPresent: Column[];
  status: "covered" | "partial" | "MCP gap" | "backend gap" | "n/a (infra)" | "duplicate surface" | "route-only (by design)";
  approval: string;
  perms: string[];
}

function opOps(entity: CoverageEntity, key: OpKey): string[] {
  return [...(entity.ops?.[key] ?? [])].sort();
}

function matches(routeKey: string, prefix: string): boolean {
  if (prefix.endsWith("!")) return routeKey === prefix.slice(0, -1);
  return routeKey === prefix || routeKey.startsWith(prefix + "/");
}

function validateOps(entity: CoverageEntity, errors: string[]) {
  const readNames = new Set(MCP_READ_REGISTRY.map((e) => e.name));
  const writeNames = new Set(MCP_WRITE_REGISTRY.map((e) => e.actionType));
  const platformNames = new Set(PLATFORM_MCP_TOOLS.map((t) => t.name));
  const isPlatform = entity.routes[0]?.startsWith("platform/");
  for (const [key, verbs] of Object.entries(entity.ops ?? {}) as [OpKey, string[]][]) {
    for (const verb of verbs) {
      if (isPlatform) {
        if (!platformNames.has(verb)) errors.push(`${entity.id}: platform verb "${verb}" (${key}) is not in PLATFORM_MCP_TOOLS`);
      } else if (key === "listDetail") {
        if (!readNames.has(verb)) errors.push(`${entity.id}: read verb "${verb}" is not in MCP_READ_REGISTRY`);
      } else {
        if (!writeNames.has(verb)) errors.push(`${entity.id}: write verb "${verb}" is not in MCP_WRITE_REGISTRY`);
      }
    }
  }
}

function deriveRow(entity: CoverageEntity, routes: RouteRecord[], errors: string[]): DerivedRow {
  validateOps(entity, errors);
  const matched = routes.filter((r) => entity.routes.some((p) => matches(r.key, p)));
  const present = new Set<Column>();
  for (const route of matched) for (const verb of route.verbs) for (const col of columnsForRoute(verb, route.key)) present.add(col);
  const ops: Record<OpKey, string[]> = {
    listDetail: opOps(entity, "listDetail"),
    create: opOps(entity, "create"),
    update: opOps(entity, "update"),
    lifecycle: opOps(entity, "lifecycle"),
    bulk: opOps(entity, "bulk"),
  };
  const covered = OP_COLUMNS.filter((_, i) => ops[(Object.keys(OPMOST) as OpKey[])[i]].length > 0);
  const gapped = (Object.keys(OPMOST) as OpKey[]).filter((k) => present.has(OPMOST[k]) && ops[k].length === 0);
  let status: DerivedRow["status"];
  if (entity.status) status = entity.status;
  else if (matched.length === 0) status = "MCP gap";
  else if (gapped.length === 0 && (covered.length > 0 || present.size === 0)) status = "covered";
  else if (covered.length > 0) status = "partial";
  else status = "MCP gap";

  const approvals = new Set<string>();
  const isPlatform = entity.routes[0]?.startsWith("platform/");
  const writeVerbs = [...ops.create, ...ops.update, ...ops.lifecycle, ...ops.bulk];
  if (!isPlatform) {
    for (const verb of writeVerbs) {
      const entry = MCP_WRITE_REGISTRY.find((e) => e.actionType === verb);
      approvals.add(entry?.approval === "always_approve" ? "step-up (always approve)" : "connection mode");
    }
  } else {
    for (const verb of writeVerbs) {
      const tool = PLATFORM_MCP_TOOLS.find((t) => t.name === verb);
      if (tool) approvals.add(tool.stepUp ? "step-up" : "none (capability-managed)");
    }
  }
  const perms = [...new Set(matched.flatMap((r) => r.perms))].sort().slice(0, 8);
  return {
    entity,
    matched,
    ops,
    columnsPresent: OP_COLUMNS.filter((c) => present.has(c)),
    status,
    approval: writeVerbs.length === 0 ? "—" : [...approvals].sort().join("; "),
    perms,
  };
}

function cell(row: DerivedRow, column: Column): string {
  const key = (Object.keys(OPMOST) as OpKey[]).find((k) => OPMOST[k] === column)!;
  const hasRoute = row.columnsPresent.includes(column);
  const verbs = row.ops[key];
  if (!hasRoute && verbs.length === 0) return "—";
  if (verbs.length === 0) return "(route only)";
  return verbs.join(", ");
}

function statusCounts(rows: DerivedRow[]): string {
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.status, (counts.get(r.status) ?? 0) + 1);
  const order = ["covered", "partial", "MCP gap", "backend gap", "n/a (infra)", "duplicate surface", "route-only (by design)"];
  return order.map((s) => `${s}: ${counts.get(s) ?? 0}`).join(" · ");
}

export interface CoverageMatrixResult {
  markdown: string;
  unclassified: string[];
  stats: {
    tenantRows: number;
    platformRows: number;
    tenantGaps: string[];
    platformGaps: string[];
    totalRoutes: number;
  };
  errors: string[];
}

export function buildCoverageMatrix(apiRoot = join(process.cwd(), "src", "app", "api")): CoverageMatrixResult {
  const routes = walkRoutes(apiRoot);
  const errors: string[] = [];
  const tenantRows = TENANT_COVERAGE.map((e) => deriveRow(e, routes, errors));
  const platformRows = PLATFORM_COVERAGE.map((e) => deriveRow(e, routes.filter((r) => r.key.startsWith("platform/") || r.key === "platform"), errors));

  const classified = new Set<string>(
    [...tenantRows, ...platformRows].flatMap((r) => r.matched.map((m) => m.key)),
  );
  const unclassified = routes
    .filter((r) => !classified.has(r.key))
    .map((r) => `${r.key} (${r.verbs.join("/")})`)
    .sort();

  const tenantGaps = tenantRows.filter((r) => r.status === "MCP gap" || r.status === "partial" || r.status === "backend gap").map((r) => r.entity.id);
  const platformGaps = platformRows.filter((r) => r.status === "MCP gap" || r.status === "partial" || r.status === "backend gap").map((r) => r.entity.id);

  const section = (title: string, rows: DerivedRow[], preamble: string): string => {
    const lines: string[] = [`## ${title}`, "", preamble, ""];
    lines.push(`Counts — ${statusCounts(rows)}`);
    lines.push("");
    lines.push("| module | entity | list/search/detail | create | update | delete/lifecycle | bulk/import/export | permission | approval | MCP tool | test | status |");
    lines.push("|---|---|---|---|---|---|---|---|---|---|---|---|");
    for (const row of rows) {
      const ops = (c: Column) => cell(row, c);
      const allVerbs = [...row.ops.listDetail, ...row.ops.create, ...row.ops.update, ...row.ops.lifecycle, ...row.ops.bulk];
      const note = row.entity.note ? `<br>_${row.entity.note}_` : "";
      lines.push(
        `| ${row.entity.module} | ${row.entity.entity}${note} | ${ops("list/search/detail")} | ${ops("create")} | ${ops("update")} | ${ops("delete/lifecycle")} | ${ops("bulk/import/export")} | ` +
          `${row.perms.join(", ") || "—"} | ${row.approval} | ${allVerbs.join(", ") || "—"} | ${row.entity.test ?? "—"} | ${row.status} |`,
      );
    }
    return lines.join("\n");
  };

  const gapList = (rows: DerivedRow[]): string =>
    rows
      .filter((r) => r.status === "MCP gap" || r.status === "partial" || r.status === "backend gap")
      .map((r) => `- **${r.entity.id}** (${r.entity.module} · ${r.entity.entity}) — ${r.status}`)
      .join("\n");

  const markdown = `# Issue #883 — MCP coverage matrix (machine-reviewable)

> GENERATED FILE — do not edit by hand. Regenerate with
> \`npx tsx scripts/write-mcp-coverage-matrix.mts\` after changing
> \`src/lib/mcp/coverage-map.ts\`, the registries, or API routes; the matrix
> test fails on drift.
>
> Legend: an operation cell shows the MCP verbs serving it, \`(route only)\`
> when the HTTP API supports the operation but MCP does not, and \`—\` when the
> domain has no such operation. Status **covered** means every operation the
> API exposes has an MCP path; **partial** means some do; **MCP gap** means
> none do; **backend gap** means neither side supports it.

Route files scanned: **${routes.length}**. Rows: tenant **${tenantRows.length}**, platform **${platformRows.length}**.

## Summary of remaining gaps

### Tenant (${tenantGaps.length})
${tenantGaps.length ? gapList(tenantRows) : "_none — every entity row is covered or deliberately out of scope_"}

### Platform (${platformGaps.length})
${platformGaps.length ? gapList(platformRows) : "_none_"}

${section("Tenant realm (posmcp_)", tenantRows, "Full CRUD + lifecycle verbs where the domain supports them. The permission column is read from the route files themselves.")}

${section("Platform realm (pospmcp_) — Superadmin", platformRows, "Each tool carries a per-tool \\`platformCan\\` capability re-checked on every call; step-up rules mirror the tenant ones (billing/credits/restore/access/secrets/mass mutation/deletion/financial posting/large exports).")}

## Unclassified routes (not claimed by any row)

${unclassified.length === 0 ? "_none — every route file belongs to a row_" : unclassified.map((r) => `- \`${r}\``).join("\n")}
`;

  return {
    markdown,
    unclassified,
    stats: { tenantRows: tenantRows.length, platformRows: platformRows.length, tenantGaps, platformGaps, totalRoutes: routes.length },
    errors,
  };
}
