/**
 * Issue #908 — contract documents: the draft, its rendered values, and the
 * frozen versions a signature can point at.
 *
 * The service owns three rules that the rest of the product is allowed to
 * assume:
 *
 *  1. **A draft is never what a signer sees.** Only `contract_document_versions`
 *     rows carry a hash and only those may be attached to an envelope, so
 *     "someone edited the text after sending" cannot happen by design.
 *  2. **Resolution happens at read time for drafts and once for frozen text.**
 *     A draft re-resolves `{{contract_value}}` from the contract/project/party
 *     on every read (so a corrected project date shows up), while freezing
 *     stores the resolved strings inside the version's content, so the printed
 *     document stops moving at the exact moment it acquires a hash.
 *  3. **Saving is optimistic.** `revision` is compared in the UPDATE itself; a
 *     stale tab gets `contract_document_conflict` and re-reads, rather than
 *     overwriting a paragraph it never saw.
 */
import { query, withTenantTransaction } from "../db";
import {
  createContract,
  getContract,
  recordActivity,
  resolveWorkspaceSubject,
  WorkspaceError,
  type WorkspaceContract,
  type WorkspaceOwner,
} from "../workspace";
import { resolveBusinessMoneyUnit } from "../ai-money-unit";
import { resolveBusinessBranding } from "../business-branding";
import { formatMoney } from "../money";
import { formatJalali } from "../jalali";
import {
  documentSummary,
  normalizeContractContent,
  renderTemplate,
  signatureSlots,
  validateContractContent,
  type ContractDocumentContent,
  type ContractIssue,
  type ContractSignatureSlot,
} from "./blocks";
import {
  bindingLabel,
  bindingSupported,
  changedBindings,
  resolveBindings,
  type ContractBindingContext,
  type ResolvedContractField,
} from "./bindings";
import { frozenContentHash } from "./crypto";
import {
  BUILTIN_CONTRACT_TEMPLATES,
  blankContent,
  builtinContractTemplate,
  contentFromTemplate,
  type ContractTemplateDefinition,
} from "./templates";

/* ===========================================================================
 * Wire shapes
 * ======================================================================== */

import type {
  ContractDocumentRecord,
  ContractDocumentVersionSummary,
  ContractDocumentView,
  ContractTemplateChoice,
  FrozenContractVersion,
  ResolvedFieldView,
} from "./view";

export type {
  ContractDocumentRecord,
  ContractDocumentVersionSummary,
  ContractDocumentView,
  ContractTemplateChoice,
  FrozenContractVersion,
  ResolvedFieldView,
};

/* ===========================================================================
 * Context: what a document may read
 * ======================================================================== */

interface BusinessFacts {
  name: string;
  phone: string;
  address: string;
}

/**
 * The business's own identity, for the `{{business_name}}` / address / phone
 * bindings.
 *
 * Reuses `resolveBusinessBranding` — the one resolver every printed document in
 * the product already goes through (#945) — so a contract cannot print a
 * different legal name than an invoice does. The branch-level address and phone
 * are only filled when the branding has none, because a framework contract is
 * issued by the business, not by one shop.
 */
async function businessFacts(businessId: string): Promise<BusinessFacts> {
  const branding = await resolveBusinessBranding(businessId, null, { includeLogo: false });
  let address = branding.address ?? "";
  let phone = branding.phone ?? "";
  if (!address || !phone) {
    const { rows } = await query<{ address: string | null; phone: string | null }>(
      `SELECT address, phone FROM locations
        WHERE business_id = $1 AND is_active
        ORDER BY created_at LIMIT 1`,
      [businessId],
    );
    address = address || rows[0]?.address || "";
    phone = phone || rows[0]?.phone || "";
  }
  return { name: branding.legalName || branding.businessName, phone, address };
}

/**
 * The projection every display unit and date goes through.
 *
 * Kept in one place because a frozen document and a draft must format
 * identically — otherwise "the preview differs from the PDF" bug reports are
 * unfixable.
 */
export function contractFormatters(unit: "rial" | "toman") {
  return {
    formatMoney: (rial: string) => formatMoney(Number(rial), unit),
    formatDate: (iso: string) => {
      const date = new Date(`${iso.slice(0, 10)}T12:00:00`);
      return Number.isNaN(date.getTime()) ? "" : formatJalali(date, { withMonthName: true });
    },
  };
}

interface PartyFacts {
  name: string;
  role: string;
  phone: string;
  nationalId: string;
}

async function partyFacts(businessId: string, partyId: string | null): Promise<PartyFacts | null> {
  if (!partyId) return null;
  const { rows } = await query<{ name: string; role: string | null; phone: string | null; national_id: string | null }>(
    `SELECT name, role, phone, national_id FROM parties WHERE id = $1 AND business_id = $2`,
    [partyId, businessId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    name: row.name,
    role: row.role ?? "",
    phone: row.phone ?? "",
    nationalId: row.national_id ?? "",
  };
}

interface ProjectFacts {
  name: string;
  description: string;
  startDate: string | null;
  endDate: string | null;
  partyName: string;
}

async function projectFacts(businessId: string, projectId: string | null): Promise<ProjectFacts | null> {
  if (!projectId) return null;
  const { rows } = await query<{
    name: string;
    description: string | null;
    start_date: string | null;
    end_date: string | null;
    party_name: string | null;
  }>(
    `SELECT p.name, p.description, p.start_date, p.end_date, party.name AS party_name
       FROM ai_projects p
       LEFT JOIN parties party ON party.id = p.party_id
      WHERE p.id = $1 AND p.business_id = $2`,
    [projectId, businessId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    name: row.name,
    description: row.description ?? "",
    startDate: row.start_date,
    endDate: row.end_date,
    partyName: row.party_name ?? "",
  };
}

/** Everything a document's `{{variables}}` may resolve from, for one contract. */
export async function loadContractBindingContext(
  owner: WorkspaceOwner,
  contract: WorkspaceContract,
): Promise<ContractBindingContext> {
  const [business, party, project] = await Promise.all([
    businessFacts(owner.businessId),
    partyFacts(owner.businessId, contract.partyId),
    projectFacts(owner.businessId, contract.projectId),
  ]);
  const today = new Date();
  return {
    contract: {
      title: contract.title,
      contractType: contract.contractType,
      contractTypeLabel: contract.contractType,
      valueRial: contract.valueRial,
      startDate: contract.startDate,
      endDate: contract.endDate,
      today: formatJalali(today, { withMonthName: true }),
    },
    project,
    party,
    business,
  };
}

/**
 * Resolve a document's variables against its contract.
 *
 * `formatters` is read from the same unit the frozen snapshot uses, so the
 * numbers in the editor and in the printed contract agree.
 */
export async function resolveContractDocument(
  owner: WorkspaceOwner,
  contract: WorkspaceContract,
  content: ContractDocumentContent,
  /**
   * Values as they were when the document was last approved/frozen. A binding
   * whose source moved since then is reported `stale`, which is the epic's
   * "detect stale source values" — a date the project changed under a contract
   * the sender already reviewed.
   */
  baseline?: Record<string, string> | null,
): Promise<{ values: Record<string, string>; resolved: ResolvedFieldView[] }> {
  const [context, unit] = await Promise.all([
    loadContractBindingContext(owner, contract),
    resolveBusinessMoneyUnit(owner.businessId),
  ]);
  const resolved = resolveBindings(content, context, contractFormatters(unit));
  const moved = new Set(baseline ? changedBindings(baseline, resolved.values) : []);
  return {
    values: resolved.values,
    resolved: resolved.fields.map((field: ResolvedContractField) => {
      const definition = content.fields.find((candidate) => candidate.key === field.key);
      return {
        key: field.key,
        label: definition?.label ?? field.key,
        value: field.value,
        provenance: field.provenance,
        sourceLabel: definition?.binding ? bindingLabel(definition.binding) : null,
        boundValue: field.boundValue,
        stale: field.bindingSupported && moved.has(field.key),
      };
    }),
  };
}

/* ===========================================================================
 * Rows
 * ======================================================================== */

function toRecord(row: Record<string, unknown>): ContractDocumentRecord {
  return {
    id: String(row.id),
    contractId: String(row.contract_id),
    templateId: (row.template_id as string | null) ?? null,
    content: normalizeContractContent(row.content),
    revision: Number(row.revision ?? 1),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export async function getContractDocument(
  businessId: string,
  contractId: string,
): Promise<ContractDocumentRecord | null> {
  const { rows } = await query<Record<string, unknown>>(
    `SELECT * FROM contract_documents WHERE business_id = $1 AND contract_id = $2`,
    [businessId, contractId],
  );
  return rows[0] ? toRecord(rows[0]) : null;
}

export interface CreateDocumentInput {
  /** A built-in template key (`blank`, `construction_subcontract`, …). */
  templateKey?: string | null;
  /** A tenant template id. Wins over `templateKey` when both are given. */
  templateId?: string | null;
  title?: string | null;
}

/**
 * The document for a contract, created on first read.
 *
 * Creating on read (rather than on contract creation) is deliberate: contracts
 * that predate #908, and contracts created from the quick dialog or by the
 * assistant, all get a document the first time somebody opens the editor —
 * with no backfill script and no possibility of two documents racing into
 * existence (the unique index arbitrates).
 */
export async function ensureContractDocument(
  owner: WorkspaceOwner,
  contract: WorkspaceContract,
  input: CreateDocumentInput = {},
): Promise<ContractDocumentRecord> {
  const existing = await getContractDocument(owner.businessId, contract.id);
  if (existing) return existing;

  let content: ContractDocumentContent = blankContent(contract.title);
  let templateId: string | null = null;

  if (input.templateId) {
    const template = await getContractTemplate(owner.businessId, input.templateId);
    if (!template) throw new WorkspaceError("contract_template_not_found");
    content = normalizeContractContent(template.content);
    templateId = template.id;
  } else if (input.templateKey) {
    const builtin = builtinContractTemplate(input.templateKey);
    if (!builtin) throw new WorkspaceError("contract_template_not_found");
    content = contentFromTemplate(builtin);
  }

  // The contract's own title is authoritative for a blank document; a template
  // keeps its own headline, which is the thing the sender chose it for.
  if (content.title.trim() === "") content = { ...content, title: contract.title };
  if (input.title?.trim()) content = { ...content, title: input.title.trim().slice(0, 200) };

  const { rows } = await query<Record<string, unknown>>(
    `INSERT INTO contract_documents (business_id, contract_id, template_id, content, created_by)
     VALUES ($1, $2, $3, $4::jsonb, $5)
     ON CONFLICT (contract_id) DO UPDATE SET updated_at = contract_documents.updated_at
     RETURNING *`,
    [owner.businessId, contract.id, templateId, JSON.stringify(content), owner.actorUserId],
  );
  const record = toRecord(rows[0]);
  await recordActivity(owner, {
    projectId: contract.projectId,
    subjectType: "contract",
    subjectId: contract.id,
    action: "document_created",
    summary: `سند قرارداد ساخته شد: ${documentSummary(content)}`,
  });
  return record;
}

/* ===========================================================================
 * Templates
 * ======================================================================== */

interface TenantTemplateRow extends Record<string, unknown> {
  id: string;
  name: string;
  description: string;
  contract_type: string;
  content: unknown;
  revision: number;
  updated_at: string;
}

export async function listContractTemplates(owner: WorkspaceOwner): Promise<ContractTemplateChoice[]> {
  const { rows } = await query<TenantTemplateRow>(
    `SELECT id, name, description, contract_type, content, revision, updated_at
       FROM contract_templates
      WHERE business_id = $1 AND archived_at IS NULL
      ORDER BY updated_at DESC`,
    [owner.businessId],
  );
  const builtin: ContractTemplateChoice[] = BUILTIN_CONTRACT_TEMPLATES.map((template) => ({
    id: `builtin:${template.key}`,
    name: template.name,
    description: template.description,
    contractType: template.contractType,
    builtin: true,
    editable: false,
    revision: 1,
    updatedAt: null,
  }));
  return [
    ...builtin,
    ...rows.map((row) => ({
      id: row.id,
      name: row.name,
      description: row.description,
      contractType: row.contract_type,
      builtin: false,
      editable: true,
      revision: row.revision,
      updatedAt: row.updated_at,
    })),
  ];
}

async function getContractTemplate(
  businessId: string,
  templateId: string,
): Promise<{ id: string; name: string; content: ContractDocumentContent } | null> {
  const { rows } = await query<{ id: string; name: string; content: unknown }>(
    `SELECT id, name, content FROM contract_templates
      WHERE id = $1 AND business_id = $2 AND archived_at IS NULL`,
    [templateId, businessId],
  );
  const row = rows[0];
  return row ? { id: row.id, name: row.name, content: normalizeContractContent(row.content) } : null;
}

export interface SaveTemplateInput {
  name: string;
  description?: string;
  contractType?: string;
  /** Content to store. Omit to publish the contract's current draft. */
  content?: ContractDocumentContent;
  contractId?: string | null;
}

/**
 * Save (or update) a tenant template and publish its next revision.
 *
 * Publishing a version every save is what makes "template revisions never
 * mutate issued contracts" true even for the template itself: the version rows
 * are immutable, and a contract created earlier keeps the copy it was created
 * from.
 */
export async function saveContractTemplate(
  owner: WorkspaceOwner,
  input: SaveTemplateInput,
): Promise<ContractTemplateChoice> {
  const name = (input.name ?? "").trim().slice(0, 200);
  if (!name) throw new WorkspaceError("template_name_required");

  let content = input.content ? normalizeContractContent(input.content) : null;
  if (!content) {
    if (!input.contractId) throw new WorkspaceError("contract_document_not_found");
    const contract = await getContract(owner.businessId, input.contractId);
    if (!contract) throw new WorkspaceError("contract_not_found");
    const document = await ensureContractDocument(owner, contract);
    content = document.content;
  }
  if (!content) throw new WorkspaceError("contract_document_not_found");
  if (content.title.trim() === "") content = { ...content, title: name };

  const contractType = ["contractor", "supplier", "consultant", "subcontractor", "vendor", "developer", "service", "other"].includes(
    String(input.contractType),
  )
    ? String(input.contractType)
    : "other";

  return withTenantTransaction(owner.businessId, async () => {
    const { rows } = await query<{ id: string; revision: number; updated_at: string }>(
      `INSERT INTO contract_templates (business_id, name, description, contract_type, content, created_by)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6)
       RETURNING id, revision, updated_at`,
      [owner.businessId, name, (input.description ?? "").slice(0, 500), contractType, JSON.stringify(content), owner.actorUserId],
    );
    const row = rows[0];
    await query(
      `INSERT INTO contract_template_versions (business_id, template_id, version, content, created_by)
       VALUES ($1, $2, 1, $3::jsonb, $4)`,
      [owner.businessId, row.id, JSON.stringify(content), owner.actorUserId],
    );
    return {
      id: row.id,
      name,
      description: (input.description ?? "").slice(0, 500),
      contractType,
      builtin: false,
      editable: true,
      revision: Number(row.revision ?? 1),
      updatedAt: String(row.updated_at),
    };
  });
}

/** Soft-delete: an issued contract keeps its `template_id` pointing at nothing. */
export async function archiveContractTemplate(owner: WorkspaceOwner, templateId: string): Promise<void> {
  const { rowCount } = await query(
    `UPDATE contract_templates SET archived_at = now(), updated_at = now()
      WHERE id = $1 AND business_id = $2 AND archived_at IS NULL`,
    [templateId, owner.businessId],
  );
  if (!rowCount) throw new WorkspaceError("contract_template_not_found");
}

/**
 * Start a contract's document from a template.
 *
 * Two sources, one code path: `builtin:<key>` names a starter that ships with
 * the product, anything else is the business's own `contract_templates` row.
 * The template's content is COPIED (not referenced), which is what makes
 * "a template revision never changes an issued contract" true by construction.
 */
export async function applyContractTemplate(
  owner: WorkspaceOwner,
  contract: WorkspaceContract,
  templateRef: string,
): Promise<ContractDocumentRecord> {
  const reference = (templateRef ?? "").trim();
  if (!reference) throw new WorkspaceError("contract_template_not_found");

  let content: ContractDocumentContent;
  let templateId: string | null = null;
  if (reference.startsWith("builtin:")) {
    const builtin = builtinContractTemplate(reference.slice("builtin:".length));
    if (!builtin) throw new WorkspaceError("contract_template_not_found");
    content = contentFromTemplate(builtin);
  } else {
    const template = await getContractTemplate(owner.businessId, reference);
    if (!template) throw new WorkspaceError("contract_template_not_found");
    content = template.content;
    templateId = template.id;
  }

  const document = await ensureContractDocument(owner, contract);
  const { rows } = await query<Record<string, unknown>>(
    `UPDATE contract_documents
        SET content = $1::jsonb, template_id = $2, revision = revision + 1, updated_at = now()
      WHERE id = $3 AND business_id = $4
      RETURNING *`,
    [JSON.stringify(content), templateId, document.id, owner.businessId],
  );
  await recordActivity(owner, {
    projectId: contract.projectId,
    subjectType: "contract",
    subjectId: contract.id,
    action: "document_from_template",
    summary: `${contract.title} — ${content.title}`,
  });
  return toRecord(rows[0]);
}

/**
 * Copy a contract — its terms AND its document — into a new draft.
 *
 * Duplication is how a business reuses an agreement it already negotiated: the
 * new contract starts as a draft with its own document, and the source keeps
 * its frozen versions and signatures untouched. The caller must be able to
 * read the source; creating the copy then needs the same write permission as
 * any other contract creation, which the route enforces.
 */
export async function duplicateContract(
  owner: WorkspaceOwner,
  sourceId: string,
  title?: string | null,
): Promise<WorkspaceContract> {
  await resolveWorkspaceSubject(owner, "contract", sourceId, "view");
  const source = await getContract(owner.businessId, sourceId);
  if (!source) throw new WorkspaceError("contract_not_found");
  const created = await createContract(owner, {
    title: (title ?? "").trim() || `کپی — ${source.title}`,
    contractType: source.contractType,
    projectId: source.projectId,
    partyId: source.partyId,
    valueRial: source.valueRial,
    startDate: source.startDate,
    endDate: source.endDate,
    notes: source.notes,
    status: "draft",
  });
  const sourceDocument = await getContractDocument(owner.businessId, sourceId);
  if (sourceDocument) {
    const document = await ensureContractDocument(owner, created);
    await query(
      `UPDATE contract_documents
          SET content = $1::jsonb, template_id = $2, revision = revision + 1, updated_at = now()
        WHERE id = $3 AND business_id = $4`,
      [JSON.stringify(sourceDocument.content), sourceDocument.templateId, document.id, owner.businessId],
    );
  }
  return created;
}

/* ===========================================================================
 * Reading the editor's view
 * ======================================================================== */

export async function requireContract(owner: WorkspaceOwner, contractId: string): Promise<WorkspaceContract> {
  const contract = await getContract(owner.businessId, contractId);
  if (!contract) throw new WorkspaceError("contract_not_found");
  return contract;
}

export async function readContractDocument(
  owner: WorkspaceOwner,
  contract: WorkspaceContract,
): Promise<ContractDocumentView> {
  const document = await ensureContractDocument(owner, contract);
  const newestFrozen = await latestFrozenVersion(owner.businessId, contract.id);
  const { values, resolved } = await resolveContractDocument(
    owner,
    contract,
    document.content,
    newestFrozen?.content.values ?? null,
  );
  const structuralIssues = validateContractContent(document.content);
  const issues = validateContractContent(document.content, values);
  const [versions, liveEnvelope] = await Promise.all([
    listContractDocumentVersions(owner.businessId, contract.id),
    latestLiveEnvelope(owner.businessId, contract.id),
  ]);
  const template = document.templateId ? await getContractTemplate(owner.businessId, document.templateId) : null;
  const newestVersion = versions[0] ?? null;
  return {
    contract,
    document,
    template: template ? { id: template.id, name: template.name } : null,
    values,
    resolved,
    issues,
    structuralIssues,
    slots: signatureSlots(document.content),
    versions,
    capabilities: {
      canEdit: true,
      canFreeze: issues.length === 0,
      draftMatchesSentVersion: !liveEnvelope || liveEnvelope.contentHash === newestVersion?.contentHash,
      liveEnvelopeStatus: liveEnvelope?.status ?? null,
    },
  };
}

interface LiveEnvelope {
  id: string;
  status: string;
  versionId: string;
  contentHash: string;
}

async function latestLiveEnvelope(businessId: string, contractId: string): Promise<LiveEnvelope | null> {
  const { rows } = await query<{ id: string; status: string; document_version_id: string; content_hash: string }>(
    `SELECT e.id, e.status, e.document_version_id, v.content_hash
       FROM contract_signing_envelopes e
       JOIN contract_document_versions v ON v.id = e.document_version_id
      WHERE e.business_id = $1 AND e.contract_id = $2
        AND e.status IN ('sent', 'partially_signed')
      ORDER BY e.created_at DESC LIMIT 1`,
    [businessId, contractId],
  );
  const row = rows[0];
  return row
    ? { id: row.id, status: row.status, versionId: row.document_version_id, contentHash: row.content_hash }
    : null;
}

export async function listContractDocumentVersions(
  businessId: string,
  contractId: string,
): Promise<ContractDocumentVersionSummary[]> {
  const { rows } = await query<Record<string, unknown>>(
    `SELECT v.id, v.version, v.content, v.content_hash, v.frozen_by, v.frozen_at,
            (SELECT e.id FROM contract_signing_envelopes e
              WHERE e.document_version_id = v.id
              ORDER BY e.created_at LIMIT 1) AS envelope_id
       FROM contract_document_versions v
      WHERE v.business_id = $1 AND v.contract_id = $2
      ORDER BY v.version DESC`,
    [businessId, contractId],
  );
  return rows.map((row) => {
    const content = normalizeContractContent(row.content);
    return {
      id: String(row.id),
      version: Number(row.version),
      title: String(row.title ?? content.title),
      contentHash: String(row.content_hash),
      frozenBy: String(row.frozen_by ?? ""),
      frozenAt: String(row.frozen_at),
      envelopeId: (row.envelope_id as string | null) ?? null,
    };
  });
}

export async function getFrozenVersion(
  businessId: string,
  contractId: string,
  versionId: string,
): Promise<FrozenContractVersion | null> {
  const { rows } = await query<Record<string, unknown>>(
    `SELECT id, version, title, content, content_hash, frozen_at, frozen_by
       FROM contract_document_versions
      WHERE id = $1 AND business_id = $2 AND contract_id = $3`,
    [versionId, businessId, contractId],
  );
  const row = rows[0];
  if (!row) return null;
  const raw = (row.content ?? {}) as Record<string, unknown>;
  return {
    id: String(row.id),
    version: Number(row.version),
    title: String(row.title ?? ""),
    content: normalizeContractContent(raw) as ContractDocumentContent & { values: Record<string, string> },
    contentHash: String(row.content_hash),
    frozenAt: String(row.frozen_at),
    frozenBy: String(row.frozen_by ?? ""),
  };
}

/** The newest frozen version, or null when nothing has been frozen yet. */
export async function latestFrozenVersion(
  businessId: string,
  contractId: string,
): Promise<FrozenContractVersion | null> {
  const { rows } = await query<{ id: string }>(
    `SELECT id FROM contract_document_versions
      WHERE business_id = $1 AND contract_id = $2
      ORDER BY version DESC LIMIT 1`,
    [businessId, contractId],
  );
  return rows[0] ? getFrozenVersion(businessId, contractId, rows[0].id) : null;
}

/* ===========================================================================
 * Saving and freezing
 * ======================================================================== */

export interface SaveDocumentInput {
  content: unknown;
  /** The revision the client based this save on. */
  revision: number;
}

export async function saveContractDocument(
  owner: WorkspaceOwner,
  contract: WorkspaceContract,
  input: SaveDocumentInput,
): Promise<ContractDocumentRecord> {
  if (!Number.isSafeInteger(input.revision) || input.revision < 1) {
    throw new WorkspaceError("invalid_revision");
  }
  const document = await ensureContractDocument(owner, contract);
  const content = normalizeContractContent(input.content);

  const { rows } = await query<Record<string, unknown>>(
    `UPDATE contract_documents
        SET content = $1::jsonb, revision = revision + 1, updated_at = now()
      WHERE id = $2 AND business_id = $3 AND revision = $4
      RETURNING *`,
    [JSON.stringify(content), document.id, owner.businessId, input.revision],
  );
  if (!rows[0]) {
    // Two tabs, one save each. The loser's work is NOT dropped: the client
    // keeps its local copy and offers "load the server's version".
    throw new WorkspaceError("document_conflict");
  }
  return toRecord(rows[0]);
}

/**
 * Freeze the current draft into an immutable version.
 *
 * Refuses while the document would print an unresolved variable, an empty
 * article or no signature line — the same `validateContractContent` the editor
 * shows, called again on the server because the client is not an authority.
 */
export async function freezeContractDocument(
  owner: WorkspaceOwner,
  contract: WorkspaceContract,
  options: { allowIssues?: boolean } = {},
): Promise<FrozenContractVersion> {
  const document = await ensureContractDocument(owner, contract);
  const { values } = await resolveContractDocument(owner, contract, document.content);
  const issues = validateContractContent(document.content, values);
  if (!options.allowIssues && issues.length > 0) {
    throw new WorkspaceError("contract_document_has_issues");
  }

  // Normalise once, hash exactly what gets stored, and store exactly that —
  // `frozenContentHash` is shared with the verification in `signing.ts`.
  const content = normalizeContractContent({ ...document.content, values });
  const contentHash = frozenContentHash(content);

  return withTenantTransaction(owner.businessId, async () => {
    // Lock the document row, not the version rows: the "next number" is a
    // property of the document, and two concurrent freezes must serialize.
    await query(`SELECT id FROM contract_documents WHERE id = $1 FOR UPDATE`, [document.id]);
    const { rows: existing } = await query<{ version: number }>(
      `SELECT version FROM contract_document_versions
        WHERE document_id = $1 ORDER BY version DESC LIMIT 1`,
      [document.id],
    );
    const version = Number(existing[0]?.version ?? 0) + 1;
    const { rows } = await query<Record<string, unknown>>(
      `INSERT INTO contract_document_versions
         (business_id, contract_id, document_id, version, title, content, content_hash, frozen_by)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)
       RETURNING id, version, title, content, content_hash, frozen_at, frozen_by`,
      [owner.businessId, contract.id, document.id, version, content.title, JSON.stringify(content), contentHash, owner.actorUserId],
    );
    await query(
      `INSERT INTO contract_signing_events (business_id, contract_id, kind, detail)
       VALUES ($1, $2, 'version_frozen', $3::jsonb)`,
      [owner.businessId, contract.id, JSON.stringify({ version, contentHash })],
    );
    const row = rows[0];
    return {
      id: String(row.id),
      version: Number(row.version),
      title: content.title,
      content: content as ContractDocumentContent & { values: Record<string, string> },
      contentHash: String(row.content_hash),
      frozenAt: String(row.frozen_at),
      frozenBy: String(row.frozen_by ?? ""),
    };
  });
}

/**
 * Fill a frozen version's variables for a caller that has already authenticated
 * as the signer. Deliberately narrow: it returns rendered display strings only,
 * never the binding context (project/party records), so the public page cannot
 * be used to enumerate a tenant's data.
 */
export function frozenValues(content: ContractDocumentContent): Record<string, string> {
  return content.values ?? {};
}

/** Render one template string for a frozen document (used by the receipt view). */
export function renderFrozenText(value: string, content: ContractDocumentContent): string {
  return renderTemplate(value, frozenValues(content));
}

/** True when the document's binding sources still point at something supported. */
export function unsupportedBindings(content: ContractDocumentContent): string[] {
  return content.fields
    .filter((field) => field.binding && !bindingSupported(field.binding))
    .map((field) => field.key);
}
