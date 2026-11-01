/**
 * Issue #908 — contract documents, freezing and multi-party signing against a
 * REAL PostgreSQL.
 *
 * `schema-contract.test.ts` proves the migration still describes what the
 * service writes; this file proves the behaviour those writes exist for, and it
 * is the only place that can:
 *
 *  - **RLS actually isolates the drafts.** A contract's text and its signers
 *    are the most sensitive rows in the module; reading Alpha's document from
 *    Beta's tenant scope must return nothing, and forging a `business_id` must
 *    be refused by the policy, not by a WHERE clause someone could delete.
 *  - **Optimistic concurrency is real.** Two saves built on the same revision:
 *    one wins, the other gets `document_conflict` — the guarantee the editor's
 *    409 banner is written against.
 *  - **A frozen version stops moving.** Editing the draft after freezing leaves
 *    the version's hash, text and the signature pointing at it untouched.
 *  - **The signing round behaves like the epic says.** Parallel vs sequential
 *    turns, the OTP being required before a signature exists, honest delivery
 *    reporting when no SMS provider is configured, one signature per person,
 *    and a completed round burning the remaining links.
 *
 * The OTP challenge is seeded directly (the same way
 * `phone-otp.integration.test.ts` does) because the code is only ever printed
 * into an SMS — a test that could read it back would mean the product stored it.
 */
import { createHmac, randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";
import { createAppRole } from "../scripts/create-app-role";
import { workspaceAccessFlags, type WorkspaceAccessFlags } from "../src/lib/workspace-shared";
import { normalizeContractContent } from "../src/lib/contracts/blocks";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

let databaseName: string;
let db: Client;
let dbLib: typeof import("../src/lib/db");
let workspace: typeof import("../src/lib/workspace");
let service: typeof import("../src/lib/contracts/service");
let signing: typeof import("../src/lib/contracts/signing");
let jwtSecret: typeof import("../src/lib/jwt-secret");

/**
 * A SECOND connection as an unprivileged role.
 *
 * The policy assertions need it: the stock database owner (`pos`) is a
 * superuser here, and superusers bypass row-level security entirely — run as
 * `pos`, "Beta cannot read Alpha's contract" would pass vacuously while proving
 * nothing. `integration/tenant-isolation.integration.test.ts` documents the same
 * trap; this file reuses the role-creation script rather than re-deriving it.
 */
let appClient: Client;
const APP_ROLE = "pos_contract_signing_test_role";
const APP_PASSWORD = "contract-signing-test-password";

const alpha = { businessId: "", ownerId: "", partyId: "", projectId: "", counterpartyId: "" };
const beta = { businessId: "", ownerId: "" };

const ORIGIN = "https://app.example.test";

function urlFor(database: string): string {
  const url = new URL(rootDatabaseUrl!);
  url.pathname = `/${database}`;
  return url.toString();
}

function maintenanceUrl(): string {
  const url = new URL(rootDatabaseUrl!);
  url.pathname = "/postgres";
  return url.toString();
}

beforeAll(async () => {
  databaseName = `pos_contracts_${randomUUID().replaceAll("-", "")}`;
  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await maintenance.end();
  }

  await runMigrations({ databaseUrl: urlFor(databaseName), quiet: true });

  process.env.DATABASE_URL = urlFor(databaseName);
  dbLib = await import("../src/lib/db");
  workspace = await import("../src/lib/workspace");
  service = await import("../src/lib/contracts/service");
  signing = await import("../src/lib/contracts/signing");
  jwtSecret = await import("../src/lib/jwt-secret");

  db = new Client({ connectionString: urlFor(databaseName) });
  await db.connect();

  await createAppRole({
    databaseUrl: urlFor(databaseName),
    roleName: APP_ROLE,
    password: APP_PASSWORD,
    quiet: true,
  });
  const appUrl = new URL(urlFor(databaseName));
  appUrl.username = APP_ROLE;
  appUrl.password = APP_PASSWORD;
  appClient = new Client({ connectionString: appUrl.toString() });
  await appClient.connect();
}, 180_000);

afterAll(async () => {
  await appClient?.end();
  await db?.end();
  await dbLib?.getPool().end().catch(() => {});
  process.env.DATABASE_URL = rootDatabaseUrl;

  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    await maintenance.query(`DROP ROLE IF EXISTS ${APP_ROLE}`);
  } finally {
    await maintenance.end();
  }
});

/** Runs `fn` on the unprivileged connection, scoped to one business. */
async function asBusiness<T>(businessId: string, fn: () => Promise<T>): Promise<T> {
  await appClient.query("SELECT set_config('app.business_id', $1, false)", [businessId]);
  await appClient.query("SELECT set_config('app.rls_bypass', '', false)");
  return fn();
}

const ADMIN = workspaceAccessFlags(
  new Set([
    "workspace.view",
    "workspace.manage",
    "workspace.contracts_manage",
    "workspace.approve",
    "workspace.admin",
  ]),
);

function owner(access: WorkspaceAccessFlags = ADMIN) {
  return {
    businessId: alpha.businessId,
    actorUserId: alpha.ownerId,
    actorName: "Owner",
    access,
  };
}

function inAlpha<T>(fn: () => Promise<T>): Promise<T> {
  return dbLib.withTenant(alpha.businessId, fn);
}

beforeEach(async () => {
  await db.query("DELETE FROM businesses");
  delete process.env.KAVENEGAR_API_KEY;
  delete process.env.KAVENEGAR_SENDER;

  const biz = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, slug) VALUES ('Alpha', $1) RETURNING id",
    [`alpha-${randomUUID().slice(0, 8)}`],
  );
  alpha.businessId = biz.rows[0].id;
  const user = await db.query<{ id: string }>(
    `INSERT INTO users (business_id, role, full_name, email, password_hash)
     VALUES ($1, 'owner', 'Owner', $2, 'x') RETURNING id`,
    [alpha.businessId, `owner-${randomUUID().slice(0, 8)}@example.test`],
  );
  alpha.ownerId = user.rows[0].id;

  const party = await db.query<{ id: string }>(
    `INSERT INTO parties (business_id, name, role, national_id)
     VALUES ($1, 'شرکت پیمان‌کار الف', 'supplier', '10101010101') RETURNING id`,
    [alpha.businessId],
  );
  alpha.partyId = party.rows[0].id;

  const project = await inAlpha(() =>
    workspace.createWorkspaceProject(owner(), {
      name: "برج شمال",
      description: "اجرای اسکلت",
      status: "active",
      partyId: alpha.partyId,
    }),
  );
  alpha.projectId = project.id;

  const other = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, slug) VALUES ('Beta', $1) RETURNING id",
    [`beta-${randomUUID().slice(0, 8)}`],
  );
  beta.businessId = other.rows[0].id;
  const betaUser = await db.query<{ id: string }>(
    `INSERT INTO users (business_id, role, full_name, email, password_hash)
     VALUES ($1, 'owner', 'Owner', $2, 'x') RETURNING id`,
    [beta.businessId, `beta-${randomUUID().slice(0, 8)}@example.test`],
  );
  beta.ownerId = betaUser.rows[0].id;
});

/* ===========================================================================
 * Fixtures
 * ======================================================================== */

async function makeContract(overrides: Record<string, unknown> = {}) {
  return inAlpha(() =>
    workspace.createContract(owner(), {
      title: "پیمان اجرای اسکلت",
      contractType: "contractor",
      projectId: alpha.projectId,
      partyId: alpha.partyId,
      valueRial: 1_250_000_000,
      startDate: "2026-01-05",
      endDate: "2026-09-30",
      status: "active",
      ...overrides,
    }),
  );
}

/** A document that is READY to freeze: one bound variable, one placement. */
function sendableContent(extra: Record<string, unknown> = {}) {
  return normalizeContractContent({
    title: "پیمان اجرای اسکلت",
    headerText: "",
    footerText: "",
    blocks: [
      { id: "b1", type: "heading", text: "مادهٔ ۱ — طرف‌ها" },
      {
        id: "b2",
        type: "paragraph",
        text: "این قرارداد میان {{counterparty_name}} با شناسهٔ ملی {{national_id}} بسته می‌شود.",
      },
      { id: "b3", type: "signature", slotId: "employer", label: "امضای کارفرما", caption: "" },
      { id: "b4", type: "signature", slotId: "contractor", label: "امضای پیمان‌کار", caption: "" },
    ],
    fields: [
      {
        key: "counterparty_name",
        label: "نام طرف مقابل",
        type: "text",
        required: true,
        binding: { source: "party", path: "name" },
      },
      {
        key: "national_id",
        label: "شناسهٔ ملی",
        type: "text",
        required: true,
        binding: { source: "party", path: "national_id" },
      },
    ],
    ...extra,
  });
}

async function readyContract() {
  const contract = await makeContract();
  const document = await inAlpha(() => service.ensureContractDocument(owner(), contract));
  await inAlpha(() =>
    service.saveContractDocument(owner(), contract, {
      content: sendableContent(),
      revision: document.revision,
    }),
  );
  return contract;
}

/** A live challenge for one signer, with a code the test chose. */
async function seedOtp(signerId: string, phone: string, code = "424242") {
  const secret = await jwtSecret.getRealmSecret("platform");
  const hmac = createHmac("sha256", secret).update(code).digest("hex");
  await db.query(
    `INSERT INTO mfa_challenges
       (subject_realm, subject_id, purpose, candidate_phone_e164, hashed_otp, expires_at)
     VALUES ('contract_signer', $1, 'contract_signing', $2, $3, now() + interval '5 minutes')`,
    [signerId, phone, hmac],
  );
  return code;
}

const DRAWN =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/** Open a live round for one contract and return the tokens by signer name. */
async function sendRound(
  contract: { id: string; title: string },
  input: { mode: "parallel" | "sequential"; signers: { name: string; phone: string; slotId: string }[] },
) {
  const sent = await inAlpha(() =>
    signing.sendEnvelope(
      owner(),
      contract as never,
      {
        signingMode: input.mode,
        signers: input.signers.map((signer, index) => ({
          fullName: signer.name,
          phone: signer.phone,
          slotId: signer.slotId,
          order: index + 1,
        })),
        expiresInDays: 7,
        origin: ORIGIN,
      },
      () => service.freezeContractDocument(owner(), contract as never),
    ),
  );
  const tokens: Record<string, string> = {};
  for (const delivery of sent.deliveries) {
    tokens[delivery.signerId] = delivery.url.split("/sign/")[1];
  }
  return { sent, tokens };
}

async function signerIds(contractId: string): Promise<Record<string, string>> {
  const { rows } = await db.query<{ id: string; full_name: string }>(
    `SELECT s.id, s.full_name FROM contract_signers s
       JOIN contract_signing_envelopes e ON e.id = s.envelope_id
      WHERE e.contract_id = $1`,
    [contractId],
  );
  return Object.fromEntries(rows.map((row) => [row.full_name, row.id]));
}

/* ===========================================================================
 * The document
 * ======================================================================== */

describe("the contract document", () => {
  it("is created on first read, titled with the contract, and is editable", async () => {
    const contract = await makeContract();
    const document = await inAlpha(() => service.ensureContractDocument(owner(), contract));
    expect(document.contractId).toBe(contract.id);
    expect(document.content.title).toBe(contract.title);
    expect(document.revision).toBe(1);

    // Idempotent: opening the editor twice does not create a second document.
    const again = await inAlpha(() => service.ensureContractDocument(owner(), contract));
    expect(again.id).toBe(document.id);
  });

  it("resolves a bound variable from the party record and reports its lineage", async () => {
    const contract = await readyContract();
    const view = await inAlpha(() => service.readContractDocument(owner(), contract));
    expect(view.values.counterparty_name).toBe("شرکت پیمان‌کار الف");
    expect(view.values.national_id).toBe("10101010101");
    const field = view.resolved.find((entry) => entry.key === "counterparty_name")!;
    expect(field.provenance).toBe("binding");
    expect(field.sourceLabel).toContain("طرف حساب");
    expect(field.stale).toBe(false);
    expect(view.issues).toEqual([]);
    expect(view.capabilities.canFreeze).toBe(true);
  });

  it("refuses a stale save instead of overwriting the other tab's paragraph", async () => {
    const contract = await makeContract();
    const document = await inAlpha(() => service.ensureContractDocument(owner(), contract));
    const first = await inAlpha(() =>
      service.saveContractDocument(owner(), contract, {
        content: sendableContent({ title: "نسخهٔ الف" }),
        revision: document.revision,
      }),
    );
    expect(first.revision).toBe(document.revision + 1);

    // A second tab still holding the old revision.
    await expect(
      inAlpha(() =>
        service.saveContractDocument(owner(), contract, {
          content: sendableContent({ title: "نسخهٔ ب" }),
          revision: document.revision,
        }),
      ),
    ).rejects.toMatchObject({ code: "document_conflict" });

    const stored = await inAlpha(() => service.getContractDocument(alpha.businessId, contract.id));
    expect(stored!.content.title).toBe("نسخهٔ الف");
  });

  it("refuses to freeze a document that would print an unresolved variable", async () => {
    const contract = await makeContract();
    const document = await inAlpha(() => service.ensureContractDocument(owner(), contract));
    await inAlpha(() =>
      service.saveContractDocument(owner(), contract, {
        content: sendableContent({
          // A binding the catalogue does not offer resolves to nothing.
          fields: [
            {
              key: "counterparty_name",
              label: "نام",
              type: "text",
              required: true,
              binding: { source: "party", path: "secret" },
            },
            { key: "national_id", label: "کد", type: "text", required: true, value: "1" },
          ],
        }),
        revision: document.revision,
      }),
    );

    await expect(
      inAlpha(() => service.freezeContractDocument(owner(), contract)),
    ).rejects.toMatchObject({ code: "contract_document_has_issues" });
  });

  it("freezes a version that carries the resolved values and a stable hash", async () => {
    const contract = await readyContract();
    const frozen = await inAlpha(() => service.freezeContractDocument(owner(), contract));
    expect(frozen.version).toBe(1);
    expect(frozen.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(frozen.content.values.counterparty_name).toBe("شرکت پیمان‌کار الف");

    const reread = await inAlpha(() =>
      service.getFrozenVersion(alpha.businessId, contract.id, frozen.id),
    );
    expect(reread!.contentHash).toBe(frozen.contentHash);
    expect(reread!.content.values.national_id).toBe("10101010101");

    // A second freeze is a new version, never an edit of the first.
    const document = await inAlpha(() => service.ensureContractDocument(owner(), contract));
    await inAlpha(() =>
      service.saveContractDocument(owner(), contract, {
        content: sendableContent({ title: "عنوان ویرایش‌شده" }),
        revision: document.revision,
      }),
    );
    const second = await inAlpha(() => service.freezeContractDocument(owner(), contract));
    expect(second.version).toBe(2);
    expect(second.contentHash).not.toBe(frozen.contentHash);
    const stillFirst = await inAlpha(() =>
      service.getFrozenVersion(alpha.businessId, contract.id, frozen.id),
    );
    expect(stillFirst!.content.title).toBe("پیمان اجرای اسکلت");
    expect(stillFirst!.contentHash).toBe(frozen.contentHash);
  });

  it("duplicates a contract together with its text", async () => {
    const contract = await readyContract();
    const copy = await inAlpha(() => service.duplicateContract(owner(), contract.id));
    expect(copy.id).not.toBe(contract.id);
    expect(copy.status).toBe("draft");
    const copyDocument = await inAlpha(() => service.getContractDocument(alpha.businessId, copy.id));
    expect(copyDocument!.content.blocks).toHaveLength(4);
    expect(copyDocument!.id).not.toBe(
      (await inAlpha(() => service.getContractDocument(alpha.businessId, contract.id)))!.id,
    );
  });
});

/* ===========================================================================
 * Templates
 * ======================================================================== */

describe("templates", () => {
  it("saves a contract as a reusable template and starts a new one from it", async () => {
    const contract = await readyContract();
    const template = await inAlpha(() =>
      service.saveContractTemplate(owner(), { name: "پیمان استاندارد", contractId: contract.id }),
    );
    expect(template.builtin).toBe(false);

    const listed = await inAlpha(() => service.listContractTemplates(owner()));
    expect(listed.some((entry) => entry.id === template.id)).toBe(true);
    expect(listed.some((entry) => entry.builtin)).toBe(true);

    const target = await makeContract({ title: "پیمان دوم" });
    await inAlpha(() => service.ensureContractDocument(owner(), target));
    const applied = await inAlpha(() => service.applyContractTemplate(owner(), target, template.id));
    expect(applied.templateId).toBe(template.id);
    expect(applied.content.blocks).toHaveLength(4);
  });

  it("copies the content, so later edits never reach a contract made from it", async () => {
    const source = await readyContract();
    const target = await makeContract({ title: "پیمان دیگر" });
    await inAlpha(() => service.ensureContractDocument(owner(), target));
    await inAlpha(() => service.applyContractTemplate(owner(), target, "builtin:construction_subcontract"));

    const template = await inAlpha(() =>
      service.saveContractTemplate(owner(), { name: "از سند", contractId: source.id }),
    );
    const applied = await inAlpha(() => service.applyContractTemplate(owner(), target, template.id));

    // Edit the SOURCE contract's draft afterwards.
    const sourceDocument = await inAlpha(() => service.ensureContractDocument(owner(), source));
    await inAlpha(() =>
      service.saveContractDocument(owner(), source, {
        content: sendableContent({ title: "تغییر یافته" }),
        revision: sourceDocument.revision,
      }),
    );

    const stored = await inAlpha(() => service.getContractDocument(alpha.businessId, target.id));
    expect(stored!.content.title).toBe(applied.content.title);
    expect(stored!.content.title).not.toBe("تغییر یافته");
  });

  it("applies a built-in starter without touching any tenant row", async () => {
    const contract = await makeContract();
    await inAlpha(() => service.ensureContractDocument(owner(), contract));
    const applied = await inAlpha(() =>
      service.applyContractTemplate(owner(), contract, "builtin:construction_subcontract"),
    );
    expect(applied.templateId).toBeNull();
    expect(applied.content.fields.length).toBeGreaterThan(0);
    await expect(
      inAlpha(() => service.applyContractTemplate(owner(), contract, "builtin:does_not_exist")),
    ).rejects.toMatchObject({ code: "contract_template_not_found" });
  });
});

/* ===========================================================================
 * Tenant isolation
 * ======================================================================== */

describe("tenant isolation", () => {
  it("hides Alpha's document and versions from Beta's tenant scope", async () => {
    const contract = await readyContract();
    const frozen = await inAlpha(() => service.freezeContractDocument(owner(), contract));

    await expect(
      dbLib.withTenant(beta.businessId, () => service.getContractDocument(beta.businessId, contract.id)),
    ).resolves.toBeNull();
    await expect(
      dbLib.withTenant(beta.businessId, () =>
        service.getFrozenVersion(beta.businessId, contract.id, frozen.id),
      ),
    ).resolves.toBeNull();
    const versions = await dbLib.withTenant(beta.businessId, () =>
      service.listContractDocumentVersions(beta.businessId, contract.id),
    );
    expect(versions).toEqual([]);
  });

  it("shows Alpha's rows only under Alpha's tenant, as the unprivileged app role", async () => {
    const contract = await readyContract();
    const frozen = await inAlpha(() => service.freezeContractDocument(owner(), contract));

    const mine = await asBusiness(alpha.businessId, () =>
      appClient.query<{ n: string }>(
        `SELECT count(*) AS n FROM contract_documents WHERE contract_id = $1`,
        [contract.id],
      ),
    );
    expect(Number(mine.rows[0].n)).toBe(1);

    // Same query, Beta's scope: the row does not exist as far as the session is
    // concerned, and neither does its frozen version.
    const theirs = await asBusiness(beta.businessId, () =>
      appClient.query<{ n: string }>(
        `SELECT count(*) AS n FROM contract_documents WHERE contract_id = $1`,
        [contract.id],
      ),
    );
    expect(Number(theirs.rows[0].n)).toBe(0);
    const theirVersions = await asBusiness(beta.businessId, () =>
      appClient.query<{ n: string }>(`SELECT count(*) AS n FROM contract_document_versions WHERE id = $1`, [
        frozen.id,
      ]),
    );
    expect(Number(theirVersions.rows[0].n)).toBe(0);
  });

  it("refuses a forged business_id: the policy is the check, not a WHERE clause", async () => {
    // A contract of Alpha's with no document yet, so the insert below is
    // refused by the POLICY rather than by the one-document-per-contract index.
    const contract = await makeContract();

    await expect(
      asBusiness(beta.businessId, () =>
        appClient.query(
          `INSERT INTO contract_documents (business_id, contract_id, content)
           VALUES ($1, $2, '{}'::jsonb)`,
          [alpha.businessId, contract.id],
        ),
      ),
    ).rejects.toThrow(/row-level security|policy/i);
  });

  it("keeps the evidence tables append-only: UPDATE and DELETE touch no row", async () => {
    const contract = await readyContract();
    const frozen = await inAlpha(() => service.freezeContractDocument(owner(), contract));

    // Alpha's OWN session, so this is not a tenant-boundary test: there is
    // simply no UPDATE or DELETE policy on these tables, so the rows are
    // invisible to those commands and the trail cannot be rewritten.
    const updated = await asBusiness(alpha.businessId, () =>
      appClient.query(`UPDATE contract_document_versions SET content_hash = $2 WHERE id = $1`, [
        frozen.id,
        "0".repeat(64),
      ]),
    );
    expect(updated.rowCount).toBe(0);

    const deleted = await asBusiness(alpha.businessId, () =>
      appClient.query(`DELETE FROM contract_signing_events WHERE contract_id = $1`, [contract.id]),
    );
    expect(deleted.rowCount).toBe(0);

    const reread = await inAlpha(() =>
      service.getFrozenVersion(alpha.businessId, contract.id, frozen.id),
    );
    expect(reread!.contentHash).toBe(frozen.contentHash);
    const { rows: events } = await db.query(`SELECT id FROM contract_signing_events WHERE contract_id = $1`, [
      contract.id,
    ]);
    expect(events.length).toBeGreaterThan(0);
  });
});

/* ===========================================================================
 * The signing round
 * ======================================================================== */

describe("a parallel signing round", () => {
  it("reports honestly when no SMS provider is configured, and still hands over the link", async () => {
    const contract = await readyContract();
    const { sent } = await sendRound(contract, {
      mode: "parallel",
      signers: [
        { name: "کارفرما", phone: "09121110001", slotId: "employer" },
        { name: "پیمان‌کار", phone: "09121110002", slotId: "contractor" },
      ],
    });
    expect(sent.envelope.status).toBe("sent");
    expect(sent.deliveries).toHaveLength(2);
    for (const delivery of sent.deliveries) {
      expect(delivery.delivered).toBe(false);
      expect(delivery.reason).toBe("sms_not_configured");
      expect(delivery.url).toContain("/sign/");
    }
  });

  it("requires consent and an OTP before a signature exists, then signs once", async () => {
    const contract = await readyContract();
    const { tokens } = await sendRound(contract, {
      mode: "parallel",
      signers: [
        { name: "کارفرما", phone: "09121110001", slotId: "employer" },
        { name: "پیمان‌کار", phone: "09121110002", slotId: "contractor" },
      ],
    });
    const ids = await signerIds(contract.id);
    const employerToken = tokens[ids["کارفرما"]];

    const opened = await signing.openSigningSession(employerToken);
    expect(opened.step).toBe("review");
    expect(opened.state).toBe("active");
    expect(opened.document.content.values?.counterparty_name).toBe("شرکت پیمان‌کار الف");

    // Signing without consent is refused.
    await expect(
      signing.submitSignature(employerToken, { code: "424242", fullName: "کارفرما", drawnImage: DRAWN }),
    ).rejects.toMatchObject({ code: "otp_invalid" });

    await signing.acknowledgeSigningSession(employerToken, { consent: true });
    const acknowledged = await signing.openSigningSession(employerToken);
    expect(acknowledged.step).toBe("verify");

    // No code issued yet: a guessed code must not sign anything.
    await expect(
      signing.submitSignature(employerToken, { code: "424242", fullName: "کارفرما", drawnImage: DRAWN }),
    ).rejects.toMatchObject({ code: "otp_invalid" });

    const code = await seedOtp(ids["کارفرما"], "+989121110001");
    const result = await signing.submitSignature(employerToken, {
      code,
      fullName: "کارفرما",
      drawnImage: DRAWN,
      ip: "192.168.10.44",
    });
    expect(result.completed).toBe(false);
    expect(result.envelopeStatus).toBe("partially_signed");
    expect(result.contentHash).toBe(result.contentHash.toLowerCase());

    // One signature per person: the same token cannot sign twice.
    await expect(
      signing.submitSignature(employerToken, { code, fullName: "کارفرما", drawnImage: DRAWN }),
    ).rejects.toMatchObject({ code: "signer_already_signed" });

    // The evidence row carries the version hash and a truncated address.
    const { rows } = await db.query<{ content_hash: string; ip_address: string; slot_id: string }>(
      `SELECT content_hash, ip_address, slot_id FROM contract_signatures WHERE signer_id = $1`,
      [ids["کارفرما"]],
    );
    expect(rows[0].content_hash).toBe(result.contentHash);
    expect(rows[0].ip_address).toBe("192.168.10.0");
    expect(rows[0].slot_id).toBe("employer");
  });

  it("completes when everyone has signed and burns the remaining links", async () => {
    const contract = await readyContract();
    const { tokens } = await sendRound(contract, {
      mode: "parallel",
      signers: [
        { name: "کارفرما", phone: "09121110001", slotId: "employer" },
        { name: "پیمان‌کار", phone: "09121110002", slotId: "contractor" },
      ],
    });
    const ids = await signerIds(contract.id);

    for (const [name, phone, slot] of [
      ["کارفرما", "+989121110001", "employer"],
      ["پیمان‌کار", "+989121110002", "contractor"],
    ] as const) {
      const token = tokens[ids[name]];
      await signing.acknowledgeSigningSession(token, { consent: true });
      const code = await seedOtp(ids[name], phone, "515151");
      await signing.submitSignature(token, { code, fullName: name, drawnImage: DRAWN });
    }

    const overview = await inAlpha(() => signing.getSigningOverview(owner(), contract));
    expect(overview.envelope!.status).toBe("completed");
    expect(overview.progress).toMatchObject({ required: 2, signed: 2, complete: true });

    const { rows: live } = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM contract_invitations
        WHERE envelope_id = $1 AND revoked_at IS NULL`,
      [overview.envelope!.id],
    );
    expect(live[0].count).toBe("0");

    // A completed round is not a live capability any more.
    const token = tokens[ids["کارفرما"]];
    await expect(signing.openSigningSession(token)).rejects.toMatchObject({ code: "link_revoked" });
  });

  it("holds the second party's turn in a sequential round until the first signs", async () => {
    const contract = await readyContract();
    const { tokens } = await sendRound(contract, {
      mode: "sequential",
      signers: [
        { name: "کارفرما", phone: "09121110001", slotId: "employer" },
        { name: "پیمان‌کار", phone: "09121110002", slotId: "contractor" },
      ],
    });
    const ids = await signerIds(contract.id);

    // Only the first party was invited; the second has no token yet.
    expect(tokens[ids["پیمان‌کار"]]).toBeUndefined();
    const { rows: secondInvites } = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM contract_invitations WHERE signer_id = $1`,
      [ids["پیمان‌کار"]],
    );
    expect(secondInvites[0].count).toBe("0");

    const firstToken = tokens[ids["کارفرما"]];
    await signing.acknowledgeSigningSession(firstToken, { consent: true });
    const code = await seedOtp(ids["کارفرما"], "+989121110001");
    await signing.submitSignature(firstToken, { code, fullName: "کارفرما", drawnImage: DRAWN });

    // Now the second party has a live link.
    const { rows: after } = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM contract_invitations
        WHERE signer_id = $1 AND revoked_at IS NULL`,
      [ids["پیمان‌کار"]],
    );
    expect(after[0].count).toBe("1");
  });

  it("rotates a signer's link on resend, so the old link stops working", async () => {
    const contract = await readyContract();
    const { tokens } = await sendRound(contract, {
      mode: "parallel",
      signers: [{ name: "کارفرما", phone: "09121110001", slotId: "employer" }],
    });
    const ids = await signerIds(contract.id);
    const oldToken = tokens[ids["کارفرما"]];

    const rotated = await inAlpha(() =>
      signing.resendInvitation(owner(), contract as never, ids["کارفرما"], {
        channel: "link",
        origin: ORIGIN,
      }),
    );
    expect(rotated.url).toContain("/sign/");
    const newToken = rotated.url.split("/sign/")[1];
    expect(newToken).not.toBe(oldToken);

    await expect(signing.openSigningSession(oldToken)).rejects.toMatchObject({ code: "link_revoked" });
    await expect(signing.openSigningSession(newToken)).resolves.toMatchObject({ state: "active" });
  });

  it("refuses a second live round and a signer outside the document's placements", async () => {
    const contract = await readyContract();
    await sendRound(contract, {
      mode: "parallel",
      signers: [{ name: "کارفرما", phone: "09121110001", slotId: "employer" }],
    });

    await expect(
      inAlpha(() =>
        signing.sendEnvelope(
          owner(),
          contract as never,
          { signingMode: "parallel", signers: [], expiresInDays: 7, origin: ORIGIN },
          () => service.freezeContractDocument(owner(), contract as never),
        ),
      ),
    ).rejects.toMatchObject({ code: "signing_already_sent" });

    const fresh = await readyContract();
    await expect(
      inAlpha(() =>
        signing.saveSigningDraft(owner(), fresh as never, {
          signingMode: "parallel",
          signers: [{ fullName: "کسی", phone: "09121110009", slotId: "not_a_slot" }],
        }),
      ),
    ).rejects.toMatchObject({ code: "signer_slot_invalid" });

    await expect(
      inAlpha(() =>
        signing.saveSigningDraft(owner(), fresh as never, {
          signingMode: "parallel",
          signers: [{ fullName: "کسی", phone: "02112345678", slotId: "employer" }],
        }),
      ),
    ).rejects.toMatchObject({ code: "signer_phone_invalid" });
  });

  it("leaves the signed version untouched when the sender edits the draft afterwards", async () => {
    const contract = await readyContract();
    const { tokens } = await sendRound(contract, {
      mode: "parallel",
      signers: [{ name: "کارفرما", phone: "09121110001", slotId: "employer" }],
    });
    const ids = await signerIds(contract.id);
    const token = tokens[ids["کارفرما"]];
    await signing.acknowledgeSigningSession(token, { consent: true });
    const code = await seedOtp(ids["کارفرما"], "+989121110001");
    const signed = await signing.submitSignature(token, {
      code,
      fullName: "کارفرما",
      drawnImage: DRAWN,
    });

    const document = await inAlpha(() => service.ensureContractDocument(owner(), contract));
    await inAlpha(() =>
      service.saveContractDocument(owner(), contract, {
        content: sendableContent({ title: "متن تازه پس از امضا" }),
        revision: document.revision,
      }),
    );

    const view = await inAlpha(() => service.readContractDocument(owner(), contract));
    expect(view.capabilities.draftMatchesSentVersion).toBe(true);
    const frozen = await inAlpha(() =>
      service.getFrozenVersion(alpha.businessId, contract.id, view.versions[0].id),
    );
    expect(frozen!.contentHash).toBe(signed.contentHash);
    expect(frozen!.content.title).toBe("پیمان اجرای اسکلت");
  });
});
