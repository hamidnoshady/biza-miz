/**
 * Domain resolvers — pure.
 *
 * One function per domain turns an incoming record plus a snapshot of what the
 * business already holds into a `Resolution`. They read no database: the
 * service builds the context (`ProductContext`, …) from the canonical tables
 * and the verified source identities, and the resolver only judges.
 *
 * The rules every resolver shares, because they are the issue's non-negotiables:
 *
 *  1. A verified source identity wins; nothing else can re-point it.
 *  2. An identity is only unambiguous when exactly one candidate matches a
 *     *unique* key and every constraint (tenant branch, type, unit, tracking,
 *     variant options, role) agrees. One failed constraint demotes the record
 *     to `ambiguous` — it is never silently linked and never silently created.
 *  3. A name, a phone, an e-mail, an amount or a date on its own is evidence for
 *     a person to weigh, not a reason to link.
 *  4. Nothing here writes. The engine can be run over any dataset, any number of
 *     times, with no effect on the books.
 */

import {
  decimalDelta,
  decimalEquals,
  normalizeBarcodeKey,
  normalizeEmailKey,
  normalizeNameKey,
  normalizePhoneKey,
  normalizeReferenceKey,
  normalizeSkuKey,
} from "./normalize";
import {
  emptyResolution,
  type CandidateRef,
  type FinancialDocumentKind,
  type IncomingFinancialDocument,
  type IncomingInventory,
  type IncomingParty,
  type IncomingProduct,
  type MatchEvidence,
  type PartyRole,
  type ProductKind,
  type ProductTracking,
  type Resolution,
  type ResolutionReason,
} from "./types";

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function resolution(
  outcome: Resolution["outcome"],
  reasons: ResolutionReason[],
  extra: Partial<Resolution> = {},
): Resolution {
  return { ...emptyResolution(outcome, reasons), ...extra };
}

// ---------------------------------------------------------------------------
// Products
// ---------------------------------------------------------------------------

export interface CanonicalProduct {
  id: string;
  locationId: string;
  name: string;
  sku: string | null;
  barcodes: readonly string[];
  kind: ProductKind;
  unit: string | null;
  tracking: ProductTracking | null;
  variantOptions?: Readonly<Record<string, string>>;
  isActive: boolean;
  /** Comparable canonical field values, for the field-authority diff. */
  fields?: Readonly<Record<string, unknown>>;
}

export interface ProductContext {
  /** The branch the import writes into. A candidate from elsewhere is not a match. */
  locationId: string;
  /** Verified source identities of *this* source: external id → canonical id. */
  mappings: ReadonlyMap<string, string>;
  /** Every canonical row the lookups below can return, by id. */
  canonicalById: ReadonlyMap<string, CanonicalProduct>;
  /** Normalised SKU → every canonical row carrying it (more than one means non-unique). */
  candidatesBySku: ReadonlyMap<string, readonly CanonicalProduct[]>;
  candidatesByBarcode: ReadonlyMap<string, readonly CanonicalProduct[]>;
  candidatesByName: ReadonlyMap<string, readonly CanonicalProduct[]>;
  /** How often each key occurs among the *incoming* records of this run. */
  incomingSkuCounts: ReadonlyMap<string, number>;
  incomingBarcodeCounts: ReadonlyMap<string, number>;
}

function productRef(p: CanonicalProduct): CandidateRef {
  return { id: p.id, label: p.sku ? `${p.name} (${p.sku})` : p.name };
}

function sameOptions(a: Readonly<Record<string, string>>, b: Readonly<Record<string, string>>): boolean {
  const keys = unique([...Object.keys(a), ...Object.keys(b)]);
  return keys.every((k) => normalizeNameKey(a[k]) === normalizeNameKey(b[k]));
}

/**
 * The constraint check a single candidate must pass to be linked without a
 * person. Returns the reasons it failed (empty ⇒ all agree).
 */
function productConstraintFailures(record: IncomingProduct, candidate: CanonicalProduct, ctx: ProductContext): ResolutionReason[] {
  const failures: ResolutionReason[] = [];
  if (candidate.locationId !== ctx.locationId) failures.push("branch_mismatch");
  if ((record.kind ?? "simple") !== candidate.kind) failures.push("type_mismatch");
  const incomingUnit = normalizeNameKey(record.unit);
  const canonicalUnit = normalizeNameKey(candidate.unit);
  if (incomingUnit && canonicalUnit && incomingUnit !== canonicalUnit) failures.push("unit_mismatch");
  if (record.tracking && candidate.tracking && record.tracking !== candidate.tracking) failures.push("tracking_mismatch");
  if (
    record.variantOptions &&
    candidate.variantOptions &&
    Object.keys(record.variantOptions).length > 0 &&
    !sameOptions(record.variantOptions, candidate.variantOptions)
  ) {
    failures.push("variant_mismatch");
  }
  // The identifiers that did not select this candidate must not contradict it.
  const sku = normalizeSkuKey(record.sku);
  const candidateSku = normalizeSkuKey(candidate.sku);
  if (sku && candidateSku && sku !== candidateSku) failures.push("identifier_conflict");
  return failures;
}

export function resolveProduct(record: IncomingProduct, ctx: ProductContext): Resolution {
  // 1. A verified source identity is the only thing that links without looking.
  if (record.externalId != null) {
    const mapped = ctx.mappings.get(record.externalId);
    if (mapped) {
      const target = ctx.canonicalById.get(mapped);
      if (!target) {
        // The row it pointed at is gone. Recreating it silently would resurrect
        // a deleted product under a new id; a person decides.
        return resolution("ambiguous", ["mapped_target_missing"], {
          evidence: [{ kind: "mapping", value: record.externalId, weak: false }],
        });
      }
      return resolution("already_linked", ["verified_mapping"], {
        canonicalId: target.id,
        candidates: [productRef(target)],
        evidence: [{ kind: "mapping", value: record.externalId, weak: false }],
      });
    }
  }

  const sku = normalizeSkuKey(record.sku);
  const barcodes = unique((record.barcodes ?? []).map(normalizeBarcodeKey).filter((b): b is string => b != null));
  const name = normalizeNameKey(record.name);

  if (!name && !sku && barcodes.length === 0) {
    return resolution("invalid", ["missing_identity"]);
  }

  // 2. Non-unique keys inside the incoming data itself are ambiguous for every
  //    row that shares them — which of the two is "the" product is not ours to say.
  const evidence: MatchEvidence[] = [];
  if (sku) evidence.push({ kind: "sku", value: sku, weak: false });
  for (const b of barcodes) evidence.push({ kind: "barcode", value: b, weak: false });
  if ((sku && (ctx.incomingSkuCounts.get(sku) ?? 0) > 1) || barcodes.some((b) => (ctx.incomingBarcodeCounts.get(b) ?? 0) > 1)) {
    return resolution("ambiguous", ["duplicate_in_source"], { evidence });
  }

  // 3. Strong candidates: anything sharing a SKU or barcode.
  const byId = new Map<string, CanonicalProduct>();
  const skuHits = sku ? (ctx.candidatesBySku.get(sku) ?? []) : [];
  const barcodeHits = barcodes.flatMap((b) => ctx.candidatesByBarcode.get(b) ?? []);
  for (const c of [...skuHits, ...barcodeHits]) byId.set(c.id, c);
  const candidates = [...byId.values()];

  if (candidates.length === 0) {
    // Nothing shares a key. A name alone is weak evidence: when the record has
    // no identifier at all, an equal name makes it a review item; when it has
    // identifiers that matched nobody, the name is a coincidence.
    if (!sku && barcodes.length === 0 && name) {
      const sameName = ctx.candidatesByName.get(name) ?? [];
      if (sameName.length > 0) {
        return resolution("ambiguous", ["name_only"], {
          candidates: sameName.map(productRef),
          evidence: [{ kind: "name", value: name, weak: true }],
        });
      }
    }
    return resolution("create_new", ["no_overlap"], { evidence });
  }

  const candidateRefs = candidates.map(productRef);

  // The SKU points at one row and the barcode at another — the source and the
  // books disagree about what identifies what.
  const hitsId = (hits: readonly CanonicalProduct[], c: CanonicalProduct) => hits.some((h) => h.id === c.id);
  if (skuHits.length > 0 && barcodeHits.length > 0 && !candidates.every((c) => hitsId(skuHits, c) && hitsId(barcodeHits, c))) {
    return resolution("ambiguous", ["identifier_collision"], { candidates: candidateRefs, evidence });
  }
  if (candidates.length > 1 || skuHits.length > 1) {
    return resolution("ambiguous", ["multiple_candidates"], { candidates: candidateRefs, evidence });
  }

  const [candidate] = candidates;
  const failures = productConstraintFailures(record, candidate, ctx);
  if (failures.length > 0) {
    return resolution("ambiguous", unique(failures), { candidates: candidateRefs, evidence });
  }
  const reasons: ResolutionReason[] = [];
  if (barcodeHits.length > 0) reasons.push("unique_barcode");
  if (skuHits.length > 0) reasons.push("unique_sku");
  return resolution("safe_match", reasons, {
    canonicalId: candidate.id,
    candidates: candidateRefs,
    evidence,
    notes: candidate.isActive ? [] : ["canonical_inactive"],
  });
}

// ---------------------------------------------------------------------------
// Parties (customers, suppliers, staff)
// ---------------------------------------------------------------------------

export interface CanonicalParty {
  id: string;
  name: string;
  /** Normalised `+98…` numbers on the file. */
  phones: readonly string[];
  /** Subset of `phones` the business has verified (OTP, in-person). */
  verifiedPhones: readonly string[];
  emails: readonly string[];
  roles: readonly PartyRole[];
  /** A guest checkout or an archived file is never an automatic target. */
  isGuest: boolean;
  isArchived: boolean;
}

export interface PartyContext {
  mappings: ReadonlyMap<string, string>;
  canonicalById: ReadonlyMap<string, CanonicalParty>;
  candidatesByPhone: ReadonlyMap<string, readonly CanonicalParty[]>;
  candidatesByEmail: ReadonlyMap<string, readonly CanonicalParty[]>;
  candidatesByName: ReadonlyMap<string, readonly CanonicalParty[]>;
  /** How often each phone occurs among the incoming records of this run. */
  incomingPhoneCounts: ReadonlyMap<string, number>;
}

function partyRef(p: CanonicalParty): CandidateRef {
  return { id: p.id, label: p.name };
}

export function resolveParty(record: IncomingParty, ctx: PartyContext): Resolution {
  const consentNote = record.consent && Object.keys(record.consent).length > 0 ? ["consent_not_transferred"] : [];

  if (record.externalId != null) {
    const mapped = ctx.mappings.get(record.externalId);
    if (mapped) {
      const target = ctx.canonicalById.get(mapped);
      if (!target) {
        return resolution("ambiguous", ["mapped_target_missing"], {
          evidence: [{ kind: "mapping", value: record.externalId, weak: false }],
          notes: consentNote,
        });
      }
      return resolution("already_linked", ["verified_mapping"], {
        canonicalId: target.id,
        candidates: [partyRef(target)],
        evidence: [{ kind: "mapping", value: record.externalId, weak: false }],
        notes: consentNote,
      });
    }
  }

  const phone = normalizePhoneKey(record.phone);
  const email = normalizeEmailKey(record.email);
  const name = normalizeNameKey(record.name);
  if (!phone && !email && !name) return resolution("invalid", ["missing_identity"], { notes: consentNote });

  const evidence: MatchEvidence[] = [];
  if (phone) evidence.push({ kind: "phone", value: phone, weak: false });
  if (email) evidence.push({ kind: "email", value: email, weak: false });

  const byId = new Map<string, CanonicalParty>();
  const phoneHits = phone ? (ctx.candidatesByPhone.get(phone) ?? []) : [];
  const emailHits = email ? (ctx.candidatesByEmail.get(email) ?? []) : [];
  for (const c of [...phoneHits, ...emailHits]) byId.set(c.id, c);
  const candidates = [...byId.values()];

  if (phone && (ctx.incomingPhoneCounts.get(phone) ?? 0) > 1) {
    return resolution("ambiguous", ["duplicate_in_source"], {
      candidates: candidates.map(partyRef),
      evidence,
      notes: consentNote,
    });
  }

  if (candidates.length === 0) {
    if (name && !phone && !email) {
      const sameName = ctx.candidatesByName.get(name) ?? [];
      if (sameName.length > 0) {
        return resolution("ambiguous", ["name_only"], {
          candidates: sameName.map(partyRef),
          evidence: [{ kind: "name", value: name, weak: true }],
          notes: consentNote,
        });
      }
    } else if (name) {
      // Contact details that match nobody, but the name does: still the same
      // person is plausible (a new phone). Surface it, never link it.
      const sameName = ctx.candidatesByName.get(name) ?? [];
      if (sameName.length > 0) {
        return resolution("ambiguous", ["name_only"], {
          candidates: sameName.map(partyRef),
          evidence: [...evidence, { kind: "name", value: name, weak: true }],
          notes: consentNote,
        });
      }
    }
    return resolution("create_new", ["no_overlap"], { evidence, notes: consentNote });
  }

  const refs = candidates.map(partyRef);
  if (candidates.length > 1) {
    return resolution("ambiguous", ["multiple_candidates"], { candidates: refs, evidence, notes: consentNote });
  }
  const [candidate] = candidates;
  if (candidate.isGuest || candidate.isArchived) {
    return resolution("ambiguous", ["guest_or_archived"], { candidates: refs, evidence, notes: consentNote });
  }
  if (record.role && !candidate.roles.includes(record.role)) {
    // A supplier arriving with a customer's phone number is not the customer.
    return resolution("ambiguous", ["role_mismatch"], { candidates: refs, evidence, notes: consentNote });
  }
  // Unverified contact details are a hint. Only a verified phone, matched by a
  // single party, counts as an identity the business has vouched for.
  const emailContradicts = email != null && candidate.emails.length > 0 && !candidate.emails.includes(email);
  if (emailContradicts) {
    return resolution("ambiguous", ["identifier_conflict"], { candidates: refs, evidence, notes: consentNote });
  }
  if (phone && phoneHits.length === 1 && candidate.verifiedPhones.includes(phone)) {
    return resolution("safe_match", ["verified_phone"], {
      canonicalId: candidate.id,
      candidates: refs,
      evidence,
      notes: consentNote,
    });
  }
  const reasons: ResolutionReason[] = [];
  if (phoneHits.length > 0) reasons.push("phone_match_unverified");
  if (emailHits.length > 0) reasons.push("email_match_unverified");
  return resolution("ambiguous", reasons, { candidates: refs, evidence, notes: consentNote });
}

// ---------------------------------------------------------------------------
// Financial documents — invoices, orders, payments, refunds, journals
// ---------------------------------------------------------------------------

export interface CanonicalFinancialDocument {
  id: string;
  kind: FinancialDocumentKind;
  totalRial: string;
  currency: string;
  /** Gregorian ISO date (business day). */
  date: string;
  references: readonly string[];
  /** Where the books got it from; a manual entry is the usual duplicate risk. */
  origin: "manual" | "imported" | "online" | "pos";
  lines?: readonly { sku: string | null; quantity: string; amountRial: string }[];
}

export interface FinancialDocumentContext {
  mappings: ReadonlyMap<string, string>;
  canonicalById: ReadonlyMap<string, CanonicalFinancialDocument>;
  /** Normalised reference → canonical documents carrying it. */
  candidatesByReference: ReadonlyMap<string, readonly CanonicalFinancialDocument[]>;
  /** `${kind}|${totalRial}|${date}` → canonical documents. Weak evidence only. */
  candidatesByAmountDate: ReadonlyMap<string, readonly CanonicalFinancialDocument[]>;
  /** The currency the books are kept in. */
  bookCurrency: string;
}

export function amountDateKey(kind: string, totalRial: string, date: string): string {
  return `${kind}|${totalRial}|${date}`;
}

function docRef(d: CanonicalFinancialDocument): CandidateRef {
  return { id: d.id, label: `${d.kind} ${d.references[0] ?? d.id} ${d.date}` };
}

function linesEqual(
  a: NonNullable<IncomingFinancialDocument["lines"]>,
  b: NonNullable<CanonicalFinancialDocument["lines"]>,
): boolean {
  if (a.length !== b.length) return false;
  const norm = (l: { sku: string | null; quantity: string; amountRial: string }) =>
    `${normalizeSkuKey(l.sku) ?? ""}|${l.quantity.replace(/\.0+$/, "")}|${l.amountRial}`;
  const left = a.map(norm).sort();
  const right = b.map(norm).sort();
  return left.every((v, i) => v === right[i]);
}

/**
 * A past transaction is `historical`: matched or reconciled, never merged on
 * amount and date alone, and never given a second invoice, payment, stock
 * movement or COGS entry because the source also remembers it.
 */
export function resolveFinancialDocument(record: IncomingFinancialDocument, ctx: FinancialDocumentContext): Resolution {
  const base = { historical: true };

  if (record.externalId != null) {
    const mapped = ctx.mappings.get(record.externalId);
    if (mapped) {
      const target = ctx.canonicalById.get(mapped);
      if (!target) {
        return resolution("ambiguous", ["mapped_target_missing"], {
          ...base,
          evidence: [{ kind: "mapping", value: record.externalId, weak: false }],
        });
      }
      return resolution("already_linked", ["verified_mapping"], {
        ...base,
        canonicalId: target.id,
        candidates: [docRef(target)],
        evidence: [{ kind: "mapping", value: record.externalId, weak: false }],
      });
    }
  }

  const refs = unique((record.references ?? []).map(normalizeReferenceKey).filter((r): r is string => r != null));
  if (record.externalId == null && refs.length === 0) {
    return resolution("invalid", ["missing_identity"], base);
  }
  if (record.totalRial == null || !/^-?\d+$/.test(record.totalRial)) {
    return resolution("invalid", ["invalid_amount"], base);
  }
  const currency = (record.currency ?? ctx.bookCurrency).toUpperCase();
  if (currency !== ctx.bookCurrency.toUpperCase()) {
    return resolution("invalid", ["currency_mismatch"], base);
  }

  const evidence: MatchEvidence[] = refs.map((r) => ({ kind: "reference", value: r, weak: false }));
  const byId = new Map<string, CanonicalFinancialDocument>();
  for (const r of refs) for (const d of ctx.candidatesByReference.get(r) ?? []) byId.set(d.id, d);
  const referenceHits = [...byId.values()].filter((d) => d.kind === record.kind);

  if (referenceHits.length > 1) {
    return resolution("ambiguous", ["multiple_candidates"], {
      ...base,
      candidates: referenceHits.map(docRef),
      evidence,
    });
  }
  if (referenceHits.length === 1) {
    const [doc] = referenceHits;
    const sameTotal = decimalEquals(doc.totalRial, record.totalRial);
    const sameLines = !record.lines || !doc.lines || linesEqual(record.lines, doc.lines);
    if (sameTotal && sameLines) {
      return resolution("historical_match", ["reference_match"], {
        ...base,
        canonicalId: doc.id,
        candidates: [docRef(doc)],
        evidence,
      });
    }
    return resolution("field_conflict", ["reference_total_mismatch"], {
      ...base,
      canonicalId: doc.id,
      candidates: [docRef(doc)],
      evidence,
    });
  }

  // No trusted reference matched. Amount and date can only make a person look.
  if (record.date) {
    const weak = ctx.candidatesByAmountDate.get(amountDateKey(record.kind, record.totalRial, record.date)) ?? [];
    if (weak.length > 0) {
      return resolution("ambiguous", ["amount_date_only"], {
        ...base,
        candidates: weak.map(docRef),
        evidence: [...evidence, { kind: "amount_date", value: `${record.totalRial}@${record.date}`, weak: true }],
        notes: weak.some((d) => d.origin === "manual") ? ["possible_manual_entry"] : [],
      });
    }
  }
  return resolution("create_new", ["historical_unmatched"], { ...base, evidence });
}

// ---------------------------------------------------------------------------
// Inventory — snapshots vs movements
// ---------------------------------------------------------------------------

export interface CanonicalStock {
  productId: string;
  /** False when the business does not manage stock for the product (null, not zero). */
  managed: boolean;
  /** Current on-hand, decimal string. Null when no stock row exists yet. */
  quantity: string | null;
  tracking: ProductTracking | null;
}

export interface InventoryContext {
  /** Source product id → canonical product id, only for products already resolved. */
  productLinks: ReadonlyMap<string, string>;
  stockByProduct: ReadonlyMap<string, CanonicalStock>;
  /** Source movement ids the books already hold. */
  appliedMovementIds: ReadonlySet<string>;
  /** How many snapshots in this run target each (product, location). */
  incomingSnapshotCounts: ReadonlyMap<string, number>;
}

export function snapshotKey(productExternalId: string, locationKey: string | null | undefined): string {
  return `${productExternalId}|${locationKey ?? ""}`;
}

/**
 * Stock is the canonical books' figure, so no inventory record is ever
 * `safe_match`: an absolute snapshot that differs is a `field_conflict` for a
 * person to settle (set / keep), and two snapshots are never added together.
 */
export function resolveInventory(record: IncomingInventory, ctx: InventoryContext): Resolution {
  if (!record.productExternalId) return resolution("invalid", ["missing_identity"]);
  const productId = ctx.productLinks.get(record.productExternalId);
  if (!productId) return resolution("ambiguous", ["product_unresolved"]);

  if (record.quantity == null || record.quantity.trim() === "") {
    // "The source does not know" is not "zero on hand".
    return resolution("skipped", ["null_quantity"], { canonicalId: productId });
  }
  if (!/^-?\d+(\.\d+)?$/.test(record.quantity.trim())) return resolution("invalid", ["invalid_amount"], { canonicalId: productId });

  const stock = ctx.stockByProduct.get(productId);
  if (stock && !stock.managed) return resolution("skipped", ["stock_unmanaged"], { canonicalId: productId });

  if ((record.lot || record.serial) && stock?.tracking === "none") {
    return resolution("ambiguous", ["tracking_mismatch"], { canonicalId: productId });
  }
  if (record.serial && !decimalEquals(record.quantity, "1")) {
    return resolution("invalid", ["serial_quantity"], { canonicalId: productId });
  }

  if (record.kind === "movement") {
    if (record.cause === "online_order") {
      // The online order owns this deduction; importing it again as an
      // adjustment would relieve the stock twice.
      return resolution("skipped", ["order_owned_stock"], { canonicalId: productId, notes: ["order_owned_stock"] });
    }
    if (record.externalId != null && ctx.appliedMovementIds.has(record.externalId)) {
      return resolution("already_linked", ["movement_already_applied"], { canonicalId: productId });
    }
    return resolution("create_new", ["no_overlap"], { canonicalId: productId, notes: ["movement_delta"] });
  }

  // Snapshot.
  if ((ctx.incomingSnapshotCounts.get(snapshotKey(record.productExternalId, record.locationKey)) ?? 0) > 1) {
    return resolution("ambiguous", ["duplicate_snapshot"], { canonicalId: productId });
  }
  if (!stock || stock.quantity == null) {
    return resolution("create_new", ["opening_stock"], { canonicalId: productId, notes: ["snapshot_set"] });
  }
  if (decimalEquals(stock.quantity, record.quantity)) {
    return resolution("already_linked", ["stock_equal"], { canonicalId: productId });
  }
  return resolution("field_conflict", ["stock_differs"], {
    canonicalId: productId,
    notes: [`delta:${decimalDelta(record.quantity, stock.quantity)}`],
  });
}
