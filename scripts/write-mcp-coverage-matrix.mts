/**
 * Regenerates docs/mcp/coverage-matrix.md from the coverage map and the
 * route files. Run after touching src/lib/mcp/coverage-map.ts, the MCP
 * registries, or anything under src/app/api — the drift test compares.
 */
import { writeFileSync } from "node:fs";
import { buildCoverageMatrix } from "../src/lib/mcp/coverage-matrix";

const result = buildCoverageMatrix();
if (result.errors.length > 0) {
  console.error("Coverage map validation failed:");
  for (const error of result.errors) console.error(`  - ${error}`);
  process.exit(1);
}
writeFileSync("docs/mcp/coverage-matrix.md", result.markdown, "utf8");
console.log(
  `docs/mcp/coverage-matrix.md regenerated: ${result.stats.totalRoutes} routes, ` +
    `tenant gaps ${result.stats.tenantGaps.length}, platform gaps ${result.stats.platformGaps.length}, ` +
    `unclassified ${result.unclassified.length}`,
);
if (result.unclassified.length > 0) {
  console.log("Unclassified routes (add a coverage row or mark infra):");
  for (const route of result.unclassified) console.log(`  - ${route}`);
}
