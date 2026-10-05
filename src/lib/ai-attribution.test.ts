/**
 * Issue #812 §12 — per-turn and per-run attribution, asserted at both ends.
 *
 * Two halves, because a gap can open at either:
 *
 *  1. The CALLERS. Every surface that spends money says what it spent it on.
 *     The issue names project, mode, system-agent and research attribution, and
 *     a settlement without them is a cost nobody can explain — which matters
 *     most for the two dimensions that change the price: the runtime mode
 *     (different LiteLLM alias) and the Deep Research run (its own spend cap).
 *  2. The SCHEMA. Those dimensions are columns, so the usage report can group
 *     on them. This is where a regression would be invisible: a settlement with
 *     a request type the table's CHECK constraint rejects fails at INSERT time,
 *     which no unit test of the route would see.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const MIGRATION = "migrations/0208_ai_attribution_columns.sql";
const SETTLEMENT_TABLE = "migrations/0153_ai_wallet_billing.sql";

describe("issue #812 §12 — the attribution columns exist", () => {
  const sql = readFileSync(MIGRATION, "utf8");

  it("carries the issue's four named dimensions as columns", () => {
    for (const column of ["runtime_mode", "system_agent_id", "suggestion_id", "research_run_id"]) {
      expect(sql, `${column} must be a column`).toMatch(new RegExp(`ADD COLUMN IF NOT EXISTS ${column}`));
    }
    // The prompt layers too: a record of what the model was actually told,
    // kept with the cost, so "why did it answer like that" is answerable later.
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS prompt_layers jsonb/);
  });

  it("widens the request-type CHECK to admit deep_research", () => {
    // This is the regression the migration exists to prevent. The Deep Research
    // approve route has always written `requestType: "deep_research"`, and
    // 0153's CHECK list does not contain it — so the first real run to settle
    // would have been rejected at INSERT, losing the run's cost entirely.
    expect(sql).toMatch(/DROP CONSTRAINT IF EXISTS ai_wallet_settlements_request_type_check/);
    expect(sql).toMatch(/ADD CONSTRAINT ai_wallet_settlements_request_type_check/);
    expect(sql).toMatch(/'deep_research'/);
    // The original list is preserved, not replaced by a shorter one.
    for (const original of ["chat", "vision", "ocr", "media_detect", "proactive", "autopilot", "coworker", "agent", "automation", "embedding", "other"]) {
      expect(sql, `${original} must survive the rewrite`).toContain(`'${original}'`);
    }
  });

  it("leaves the runtime mode NULL for surfaces that have none", () => {
    // The issue asks for *relevant* attribution. An OCR call or a vision count
    // never touched a mode alias, so defaulting them to `auto` would make the
    // usage report claim they ran on the `auto` model — a number nobody could
    // reconcile against the gateway.
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS runtime_mode text\s*\n\s*CHECK/);
    expect(sql).not.toMatch(/runtime_mode text NOT NULL DEFAULT 'auto'/);
  });

  it("indexes the dimensions the report groups on", () => {
    // A column that cannot be indexed usefully is a column nobody groups on,
    // and the attribution would quietly stay inside `metadata`.
    for (const index of [
      "idx_ai_wallet_settlements_research_run",
      "idx_ai_wallet_settlements_mode",
      "idx_ai_wallet_settlements_system_agent",
    ]) {
      expect(sql, `${index} must exist`).toContain(index);
    }
  });

  it("keeps the settlement row's unique per-request guard intact", () => {
    // §16's idempotency is what stops a partial or failed call being settled
    // twice. A new attribution column must not have loosened it.
    const original = readFileSync(SETTLEMENT_TABLE, "utf8");
    expect(original).toMatch(/CREATE UNIQUE INDEX idx_ai_wallet_settlements_request/);
  });
});

describe("issue #812 §12 — every spending surface attributes its spend", () => {
  const chat = readFileSync("src/app/api/ai/chat/route.ts", "utf8");
  const research = readFileSync("src/app/api/ai/research/[id]/approve/route.ts", "utf8");
  const widgetRun = readFileSync("src/app/api/ai/widgets/[id]/run/route.ts", "utf8");

  it("types every settlement with a request type the table accepts", () => {
    // The CHECK list from 0153, plus `deep_research` from 0208. Anything else
    // is a settlement that will be rejected at INSERT.
    const allowed = [
      "chat", "vision", "ocr", "media_detect", "proactive", "autopilot",
      "coworker", "agent", "automation", "embedding", "deep_research", "other",
    ];
    for (const [name, src] of [
      ["chat", chat],
      ["research approve", research],
      ["widget run", widgetRun],
    ] as const) {
      const types = [...src.matchAll(/requestType:\s*"([^"]+)"/g)].map((m) => m[1]);
      expect(types.length, `${name} settles at least once`).toBeGreaterThan(0);
      for (const type of types) {
        expect(allowed, `${name} uses the unknown request type "${type}"`).toContain(type);
      }
    }
  });

  it("attributes the chat turn by mode, agent and suggestion on BOTH settlement paths", () => {
    // §16: a failed or partial turn still costs money and still has to be
    // attributable. The dimensions are filled in on the failure path too, not
    // only on the happy one.
    const settlements = chat.split("attribution: {").slice(1);
    expect(settlements.length).toBeGreaterThanOrEqual(2);
    for (const block of settlements) {
      expect(block, "every chat settlement names its runtime mode").toMatch(/runtimeMode/);
      expect(block, "every chat settlement names its system agent").toMatch(/systemAgentId/);
      expect(block, "every chat settlement names its suggestion card").toMatch(/suggestionId/);
      expect(block, "every chat settlement records its prompt layers").toMatch(/promptLayers/);
    }
  });

  it("attributes a Deep Research settlement by its run on BOTH paths", () => {
    const settlements = research.split("attribution: {").slice(1);
    expect(settlements.length).toBeGreaterThanOrEqual(2);
    for (const block of settlements) {
      expect(block, "every research settlement names its run").toMatch(/researchRunId/);
      expect(block, "every research settlement names its mode").toMatch(/runtimeMode:\s*"deep_research"/);
    }
  });

  it("types a widget run as chat on both paths, so its cost lands in one slice", () => {
    const types = [...widgetRun.matchAll(/requestType:\s*"([^"]+)"/g)].map((m) => m[1]);
    expect(types.length).toBeGreaterThanOrEqual(2);
    for (const type of types) {
      expect(type, "a widget run is a chat turn").toBe("chat");
    }
  });

  it("flattens the resolved prompt layers into the short keys a row can carry", () => {
    // The resolver's layer object is rich and nested; the settlement row needs
    // the ordered scope keys, so the composition order survives the trip.
    const resolver = readFileSync("src/lib/ai-prompt-resolver.ts", "utf8");
    expect(resolver).toMatch(/export function promptLayerKeys/);
    const chatRoute = chat;
    expect(chatRoute, "the chat route uses the flattening helper").toMatch(/promptLayerKeys\(/);
  });

  it("writes the attribution as columns, not only as metadata keys", () => {
    // The columns are what the usage report groups on. Keeping the same values
    // in `metadata` is fine and useful; relying on `metadata` alone is not,
    // because a typo in a jsonb key is a silent NULL group forever.
    const wallet = readFileSync("src/lib/wallet-service.ts", "utf8");
    const billing = readFileSync("src/lib/ai-wallet-billing.ts", "utf8");
    for (const [name, src] of [
      ["wallet-service", wallet],
      ["ai-wallet-billing", billing],
    ] as const) {
      for (const field of ["runtimeMode", "systemAgentId", "suggestionId", "researchRunId", "promptLayers"]) {
        expect(src, `${name} must carry ${field}`).toMatch(new RegExp(field));
      }
    }
    expect(wallet).toMatch(/INSERT INTO ai_wallet_settlements[\s\S]*?runtime_mode,\s*system_agent_id,\s*suggestion_id,\s*research_run_id,\s*prompt_layers/);
  });
});
