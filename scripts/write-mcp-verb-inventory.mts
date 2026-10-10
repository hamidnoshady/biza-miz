/**
 * Regenerates docs/mcp/verb-inventory.md from src/lib/mcp/registry.ts.
 * Run after changing the registry; review the diff, commit both together.
 */
import { writeFileSync } from "node:fs";
import { buildMcpVerbInventory } from "../src/lib/mcp/verb-inventory";

writeFileSync("docs/mcp/verb-inventory.md", buildMcpVerbInventory(), "utf8");
console.log("docs/mcp/verb-inventory.md regenerated from src/lib/mcp/registry.ts");
