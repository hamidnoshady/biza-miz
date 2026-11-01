/**
 * Issue #908 — the schema contract between `migrations/0258` and the service.
 *
 * The database tests in `npm run test:db` prove the tables behave; this one
 * proves they still describe what `service.ts`/`signing.ts` WRITE. It exists
 * because the first draft of this branch drifted exactly here: the service
 * inserted into `ip_address`, `cancel_reason` and a `title` column that the
 * migration had spelled differently — typechecking cannot see SQL, and the
 * failure would only appear at runtime, on the signing path, with a real
 * contract half-signed.
 *
 * So each column the contract code names is checked against the migration text,
 * together with the invariants the epic depends on:
 *
 *  - every table is tenant-scoped and FORCE RLS'd;
 *  - frozen versions, signatures and the event trail are INSERT-only;
 *  - one document per contract, one live envelope per contract, one live token
 *    per signer, one signature per signer;
 *  - the token is stored as a 64-hex digest and never as plaintext.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const MIGRATIONS_DIR = join(process.cwd(), "migrations");
const SQL = readdirSync(MIGRATIONS_DIR)
  .filter((name) => name.startsWith("0258_"))
  .map((name) => readFileSync(join(MIGRATIONS_DIR, name), "utf8"))
  .join("\n");

/** The `CREATE TABLE <name> ( ... );` body, so column checks stay inside one table. */
function tableBody(name: string): string {
  const match = new RegExp(`CREATE TABLE ${name} \\(([\\s\\S]*?)\\n\\);`).exec(SQL);
  if (!match) throw new Error(`missing CREATE TABLE ${name}`);
  return match[1];
}

function columnNames(name: string): string[] {
  return tableBody(name)
    .split("\n")
    .map((line) => /^\s{4}([a-z][a-z0-9_]*)\s/.exec(line)?.[1])
    .filter((value): value is string => Boolean(value));
}

const TABLES = [
  "contract_templates",
  "contract_template_versions",
  "contract_documents",
  "contract_document_versions",
  "contract_signing_envelopes",
  "contract_signers",
  "contract_invitations",
  "contract_signatures",
  "contract_signing_events",
];

describe("0258 — the tables exist and are tenant-scoped", () => {
  it("creates all nine tables of the contract document and signing engine", () => {
    for (const table of TABLES) {
      expect(SQL).toContain(`CREATE TABLE ${table} (`);
    }
  });

  it("forces row-level security on every one of them", () => {
    for (const table of TABLES) {
      expect(SQL, `${table} must ENABLE RLS`).toContain(
        `ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;`,
      );
      expect(SQL, `${table} must FORCE RLS`).toContain(
        `ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;`,
      );
    }
  });

  it("scopes every policy to the business, with the documented platform bypass", () => {
    const policies = [...SQL.matchAll(/CREATE POLICY (\w+) ON (\w+) FOR (\w+)\n?\s*([\s\S]*?);/g)];
    expect(policies.length).toBeGreaterThanOrEqual(TABLES.length);
    for (const [, , table, , body] of policies) {
      expect(body, `${table} policy must use the tenant predicate`).toContain(
        "business_id = app_current_business()",
      );
    }
  });

  it("makes the evidence tables append-only: INSERT, never UPDATE or DELETE", () => {
    for (const table of ["contract_document_versions", "contract_signatures", "contract_signing_events"]) {
      expect(SQL).toContain(`CREATE POLICY tenant_read ON ${table} FOR SELECT`);
      expect(SQL).toContain(`CREATE POLICY tenant_insert ON ${table} FOR INSERT`);
      expect(SQL).not.toMatch(new RegExp(`ON ${table} FOR (?:UPDATE|DELETE|ALL)`));
    }
  });
});

describe("0258 — every column the service names exists", () => {
  const REQUIRED: Record<string, string[]> = {
    contract_templates: ["business_id", "name", "description", "contract_type", "content", "revision", "archived_at"],
    contract_template_versions: ["business_id", "template_id", "version", "content", "created_by"],
    contract_documents: ["business_id", "contract_id", "template_id", "content", "revision", "updated_at"],
    contract_document_versions: [
      "business_id", "contract_id", "document_id", "version", "title",
      "content", "content_hash", "frozen_by", "frozen_at",
    ],
    contract_signing_envelopes: [
      "business_id", "contract_id", "document_version_id", "status", "signing_mode",
      "expires_at", "cancel_reason", "sent_at", "completed_at", "cancelled_at",
    ],
    contract_signers: [
      "business_id", "envelope_id", "party_id", "full_name", "role_label", "phone_e164",
      "slot_id", "sign_order", "required", "status", "decline_reason", "deadline",
      "invited_at", "opened_at", "acknowledged_at", "verified_at", "signed_at", "declined_at",
    ],
    contract_invitations: [
      "business_id", "envelope_id", "signer_id", "token_hash", "expires_at",
      "send_count", "last_sent_at", "revoked_at",
    ],
    contract_signatures: [
      "business_id", "envelope_id", "signer_id", "document_version_id", "slot_id",
      "full_name", "drawn_image", "signature_kind", "content_hash", "ip_address",
      "user_agent", "signed_at",
    ],
    contract_signing_events: ["business_id", "contract_id", "envelope_id", "signer_id", "kind", "detail", "created_at"],
  };

  it("has every column, table by table", () => {
    for (const [table, columns] of Object.entries(REQUIRED)) {
      const actual = columnNames(table);
      for (const column of columns) {
        expect(actual, `${table}.${column}`).toContain(column);
      }
    }
  });

  it("stores the invitation token only as a 64-hex digest", () => {
    expect(tableBody("contract_invitations")).toContain("token_hash  text NOT NULL CHECK (token_hash ~ '^[0-9a-f]{64}$')");
    expect(tableBody("contract_invitations")).not.toMatch(/\btoken\s+text/);
  });

  it("stores a 64-hex content hash on versions and on signatures", () => {
    expect(tableBody("contract_document_versions")).toContain("content_hash ~ '^[0-9a-f]{64}$'");
    expect(tableBody("contract_signatures")).toContain("content_hash ~ '^[0-9a-f]{64}$'");
  });
});

describe("0258 — the invariants the services rely on", () => {
  it("keeps one document per contract", () => {
    expect(SQL).toContain("CONSTRAINT contract_documents_one_per_contract UNIQUE (contract_id)");
  });

  it("keeps one LIVE envelope per contract and allows a new round afterwards", () => {
    expect(SQL).toMatch(
      /CREATE UNIQUE INDEX contract_signing_envelopes_one_live[\s\S]*?WHERE status IN \('draft', 'sent', 'partially_signed'\)/,
    );
  });

  it("keeps one live token per signer, so resending rotates the old link away", () => {
    expect(SQL).toMatch(
      /CREATE UNIQUE INDEX contract_invitations_one_live[\s\S]*?\(signer_id\) WHERE revoked_at IS NULL/,
    );
  });

  it("keeps one signature per signer and one phone per slot per envelope", () => {
    expect(SQL).toContain("CONSTRAINT contract_signatures_one_per_signer UNIQUE (signer_id)");
    expect(SQL).toContain("CONSTRAINT contract_signers_unique_slot UNIQUE (envelope_id, slot_id)");
    expect(SQL).toContain("CONSTRAINT contract_signers_unique_phone UNIQUE (envelope_id, phone_e164)");
  });

  it("accepts exactly the signer and envelope statuses the code writes", () => {
    const signerStatuses = /status\s+text NOT NULL DEFAULT 'pending'[\s\S]*?CHECK \(status IN \(([\s\S]*?)\)\),/.exec(
      tableBody("contract_signers"),
    )?.[1] ?? "";
    expect([...signerStatuses.matchAll(/'([a-z_]+)'/g)].map((m) => m[1])).toEqual([
      "pending", "invited", "opened", "acknowledged", "signed", "declined", "expired",
    ]);
    const envelopeStatuses = /status\s+text NOT NULL DEFAULT 'draft'[\s\S]*?CHECK \(status IN \(([\s\S]*?)\)\),/.exec(
      tableBody("contract_signing_envelopes"),
    )?.[1] ?? "";
    expect([...envelopeStatuses.matchAll(/'([a-z_]+)'/g)].map((m) => m[1])).toEqual([
      "draft", "sent", "partially_signed", "completed", "declined", "cancelled", "expired",
    ]);
  });

  it("keeps money in integer Rial and never stores a formatted amount", () => {
    // The document's numbers live inside `workspace_contracts.value_rial`
    // (pre-existing, bigint) and inside resolved display strings in the frozen
    // JSON — never as a new money column of this migration.
    expect(SQL).not.toMatch(/\b(?:value|amount|price)_(?:rial|toman)?\s+(?:numeric|float|double)/);
  });
});
