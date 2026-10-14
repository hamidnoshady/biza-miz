/**
 * Versioned, fail-closed Holoo SQL schema profiles.
 *
 * A profile is a compatibility contract for this adapter, not a claim that
 * every Holoo installation has the same schema. The generic v1 profile is the
 * repository's internal canonical layout from issue #845. It is deliberately
 * read-only for connected SQL writes until a concrete, externally verified
 * edition has an audited column-order/write contract.
 */

/** The Holoo tables the current integration knows how to describe. */
export type HolooEntity =
  | "goods"
  | "persons"
  | "accounts"
  | "invoices"
  | "invoice_lines"
  | "purchases"
  | "receipt_payment"
  | "stock_movements"
  | "journal"
  | "journal_lines";

export interface HolooSchemaColumns {
  goods: {
    id: string;
    name: string;
    sku?: string;
    price?: string;
    unit?: string;
    updatedAt?: string;
  };
  persons: {
    id: string;
    name: string;
    phone?: string;
    address?: string;
    isSupplier?: string;
    updatedAt?: string;
  };
  accounts: {
    id: string;
    code: string;
    name: string;
    nature?: string;
    parentCode?: string;
    updatedAt?: string;
  };
  invoices: {
    id: string;
    date: string;
    personId?: string;
    total: string;
    updatedAt?: string;
  };
  invoiceLines: {
    invoiceId: string;
    goodsId: string;
    quantity: string;
    total: string;
  };
  purchases: {
    id: string;
    date: string;
    personId?: string;
    total: string;
    updatedAt?: string;
  };
  receiptPayment: {
    id: string;
    date: string;
    personId?: string;
    amount: string;
    direction?: string;
    updatedAt?: string;
  };
  stockMovements: {
    id: string;
    date?: string;
    goodsId: string;
    quantity: string;
    unitCost?: string;
    updatedAt?: string;
  };
  journal: {
    id: string;
    date: string;
    memo?: string;
    updatedAt?: string;
  };
  journalLines: {
    journalId: string;
    accountCode: string;
    debit: string;
    credit: string;
  };
}

export interface HolooSchemaFingerprint {
  /** SQL Server's @@VERSION (not an asserted Holoo application version). */
  serverVersion: string;
  /** SERVERPROPERTY('ProductVersion'). */
  productVersion: string;
  /** SERVERPROPERTY('ProductLevel'), for example RTM or SP2. */
  productLevel: string;
  /** SERVERPROPERTY('Edition'), for example Express Edition (64-bit). */
  edition: string;
  databaseCollation: string | null;
  /** Holoo's own version, when an installation exposes it to the probe. */
  holooVersion?: string | null;
}

export interface HolooSchemaColumn {
  name: string;
  dataType: string;
  nullable: boolean;
  maxLength?: number | null;
  precision?: number | null;
  scale?: number | null;
  collation?: string | null;
  primaryKeyOrdinal?: number | null;
}

export interface HolooSchemaTable {
  schema: string;
  name: string;
  columns: readonly HolooSchemaColumn[];
  /** Ordered primary-key column names; empty when no primary key was found. */
  primaryKey: readonly string[];
}

export interface HolooDateSample {
  schema: string;
  table: string;
  column: string;
  /** ISO-shaped values sampled read-only from native SQL date/time columns. */
  values: readonly string[];
}

/** The complete set of schema facts collected by the safe SQL Server probe. */
export interface HolooSchemaSnapshot {
  fingerprint: HolooSchemaFingerprint;
  tables: readonly HolooSchemaTable[];
  dateSamples: readonly HolooDateSample[];
}

export type HolooColumnSemantic = "code" | "unicode_text" | "text" | "money" | "quantity" | "boolean" | "date";

export interface HolooRequiredColumn {
  name: string;
  semantic: HolooColumnSemantic;
  /** One of the SQL types this versioned profile has explicitly reviewed. */
  compatibleTypes: readonly string[];
  /** Critical identifiers/values must not be nullable. */
  notNull?: boolean;
  /** Text comparison/encoding follows the probed database collation. */
  databaseCollation?: boolean;
}

export interface HolooTableRequirement {
  /** Canonical internal table name for this version only. */
  name: string;
  requiredColumns: readonly HolooRequiredColumn[];
  /** Exact PK shape when stable remote identity depends on it. */
  primaryKey?: readonly string[];
}

export interface HolooSchemaProfile {
  /** Stable identifier stored in holoo_connection_settings.schema_profile. */
  key: string;
  profileVersion: number;
  label: string;
  /** SQL schemas allowed by this profile. */
  supportedSchemas: readonly string[];
  /** Server runtime fingerprint rules; structural requirements are checked too. */
  fingerprintRules: {
    sqlServerMajorVersions: readonly number[];
    editionTokens: readonly string[];
    productLevelPattern: string;
    databaseCollationPattern: string;
  };
  tables: Record<HolooEntity, string>;
  columns: HolooSchemaColumns;
  requirements: Record<HolooEntity, HolooTableRequirement>;
  dateMode: "native_sql_date";
  currencyUnitAssumption: "connection_setting";
  capabilities: {
    read: readonly ("goods" | "persons" | "accounts" | "openingInventory")[];
    webServiceWrite: readonly ("sale" | "purchase" | "receipt_payment")[];
    directSqlWrite: boolean;
    rollback: boolean;
  };
}

const CODE_TYPES = ["nvarchar", "nchar", "varchar", "char", "tinyint", "smallint", "int", "bigint", "decimal", "numeric"] as const;
const UNICODE_TYPES = ["nvarchar", "nchar"] as const;
const TEXT_TYPES = ["nvarchar", "nchar", "varchar", "char"] as const;
const EXACT_MONEY_TYPES = ["decimal", "numeric", "money", "smallmoney", "bigint", "int", "smallint"] as const;
const EXACT_QUANTITY_TYPES = ["decimal", "numeric", "bigint", "int", "smallint"] as const;
const BOOLEAN_TYPES = ["bit", "tinyint", "smallint", "int", "char", "nchar", "varchar", "nvarchar"] as const;
const DATE_TYPES = ["date", "datetime", "datetime2", "smalldatetime"] as const;

const code = (name: string, notNull = false): HolooRequiredColumn => ({
  name,
  semantic: "code",
  compatibleTypes: CODE_TYPES,
  notNull,
  databaseCollation: true,
});
const unicodeText = (name: string, notNull = false): HolooRequiredColumn => ({
  name,
  semantic: "unicode_text",
  compatibleTypes: UNICODE_TYPES,
  notNull,
  databaseCollation: true,
});
const text = (name: string, notNull = false): HolooRequiredColumn => ({
  name,
  semantic: "text",
  compatibleTypes: TEXT_TYPES,
  notNull,
  databaseCollation: true,
});
const money = (name: string, notNull = false): HolooRequiredColumn => ({
  name,
  semantic: "money",
  compatibleTypes: EXACT_MONEY_TYPES,
  notNull,
});
const quantity = (name: string, notNull = false): HolooRequiredColumn => ({
  name,
  semantic: "quantity",
  compatibleTypes: EXACT_QUANTITY_TYPES,
  notNull,
});
const boolean = (name: string, notNull = false): HolooRequiredColumn => ({
  name,
  semantic: "boolean",
  compatibleTypes: BOOLEAN_TYPES,
  notNull,
});
const date = (name: string, notNull = false): HolooRequiredColumn => ({
  name,
  semantic: "date",
  compatibleTypes: DATE_TYPES,
  notNull,
});

/**
 * Canonical internal profile described by issue #845. This is intentionally
 * not called "the Holoo schema": another SQL type, PK layout, table/schema,
 * server fingerprint or date representation produces an unknown profile.
 */
export const HOLOO_GENERIC_V1: HolooSchemaProfile = {
  key: "holoo-generic-v1",
  profileVersion: 1,
  label: "هلو — چیدمان داخلی نسخهٔ ۱ (خواندنی)",
  supportedSchemas: ["dbo"],
  fingerprintRules: {
    sqlServerMajorVersions: [10, 11, 12, 13, 14, 15, 16, 17],
    editionTokens: ["express", "standard", "enterprise", "developer", "web", "evaluation"],
    productLevelPattern: "^(RTM|SP[0-9]+|CU[0-9]+|GDR.*|QFE.*)$",
    databaseCollationPattern: "(?:_CI_|_CS_|_BIN)",
  },
  tables: {
    goods: "Goods",
    persons: "Person",
    accounts: "Account",
    invoices: "Invoice",
    invoice_lines: "InvoiceItem",
    purchases: "BuyInvoice",
    receipt_payment: "ReceivePay",
    stock_movements: "Stock",
    journal: "Sanad",
    journal_lines: "SanadRow",
  },
  columns: {
    goods: { id: "Code", name: "Name", sku: "BarCode", price: "SellPrice", unit: "UnitName", updatedAt: "ModifiedDate" },
    persons: { id: "Code", name: "Name", phone: "Tel", address: "Address", isSupplier: "IsSupplier", updatedAt: "ModifiedDate" },
    accounts: { id: "Code", code: "Code", name: "Name", nature: "Nature", parentCode: "ParentCode", updatedAt: "ModifiedDate" },
    invoices: { id: "Code", date: "Date", personId: "PersonCode", total: "TotalPrice", updatedAt: "ModifiedDate" },
    invoiceLines: { invoiceId: "InvoiceCode", goodsId: "GoodsCode", quantity: "Quantity", total: "TotalPrice" },
    purchases: { id: "Code", date: "Date", personId: "PersonCode", total: "TotalPrice", updatedAt: "ModifiedDate" },
    receiptPayment: { id: "Code", date: "Date", personId: "PersonCode", amount: "Amount", direction: "Type", updatedAt: "ModifiedDate" },
    stockMovements: { id: "Code", date: "Date", goodsId: "GoodsCode", quantity: "Quantity", unitCost: "UnitCost", updatedAt: "ModifiedDate" },
    journal: { id: "Code", date: "Date", memo: "Description", updatedAt: "ModifiedDate" },
    journalLines: { journalId: "SanadCode", accountCode: "AccountCode", debit: "Debit", credit: "Credit" },
  },
  requirements: {
    goods: {
      name: "Goods",
      primaryKey: ["Code"],
      requiredColumns: [code("Code", true), unicodeText("Name", true), text("BarCode"), money("SellPrice"), unicodeText("UnitName"), date("ModifiedDate")],
    },
    persons: {
      name: "Person",
      primaryKey: ["Code"],
      requiredColumns: [code("Code", true), unicodeText("Name", true), text("Tel"), unicodeText("Address"), boolean("IsSupplier"), date("ModifiedDate")],
    },
    accounts: {
      name: "Account",
      primaryKey: ["Code"],
      requiredColumns: [code("Code", true), unicodeText("Name", true), text("Nature"), code("ParentCode"), date("ModifiedDate")],
    },
    invoices: {
      name: "Invoice",
      primaryKey: ["Code"],
      requiredColumns: [code("Code", true), date("Date", true), code("PersonCode"), money("TotalPrice", true), date("ModifiedDate")],
    },
    invoice_lines: {
      name: "InvoiceItem",
      requiredColumns: [code("InvoiceCode", true), code("GoodsCode", true), quantity("Quantity", true), money("TotalPrice", true)],
    },
    purchases: {
      name: "BuyInvoice",
      primaryKey: ["Code"],
      requiredColumns: [code("Code", true), date("Date", true), code("PersonCode"), money("TotalPrice", true), date("ModifiedDate")],
    },
    receipt_payment: {
      name: "ReceivePay",
      primaryKey: ["Code"],
      requiredColumns: [code("Code", true), date("Date", true), code("PersonCode"), money("Amount", true), text("Type", true), date("ModifiedDate")],
    },
    stock_movements: {
      name: "Stock",
      primaryKey: ["Code"],
      requiredColumns: [code("Code", true), date("Date"), code("GoodsCode", true), quantity("Quantity", true), money("UnitCost"), date("ModifiedDate")],
    },
    journal: {
      name: "Sanad",
      primaryKey: ["Code"],
      requiredColumns: [code("Code", true), date("Date", true), unicodeText("Description"), date("ModifiedDate")],
    },
    journal_lines: {
      name: "SanadRow",
      requiredColumns: [code("SanadCode", true), code("AccountCode", true), money("Debit", true), money("Credit", true)],
    },
  },
  dateMode: "native_sql_date",
  currencyUnitAssumption: "connection_setting",
  capabilities: {
    // This is the set implemented by the current base-data reader. Financial
    // document scopes are not claimed until their source readers are profile
    // driven and document-atomic.
    read: ["goods", "persons", "accounts", "openingInventory"],
    webServiceWrite: ["sale", "purchase", "receipt_payment"],
    // The direct-SQL fallback uses positional INSERTs. No canonical profile
    // may enable it without a reviewed column-order/write manifest.
    directSqlWrite: false,
    rollback: true,
  },
};

export const HOLOO_PROFILES: readonly HolooSchemaProfile[] = [HOLOO_GENERIC_V1];

export interface HolooProfileDiagnostic {
  code:
    | "missing_fingerprint"
    | "unsupported_sql_server"
    | "unsupported_sql_server_version"
    | "unsupported_edition"
    | "unsupported_product_level"
    | "missing_database_collation"
    | "unsupported_database_collation"
    | "missing_table"
    | "unsupported_table_schema"
    | "ambiguous_table"
    | "missing_column"
    | "incompatible_column_type"
    | "nullable_required_column"
    | "column_collation_mismatch"
    | "primary_key_mismatch"
    | "invalid_date_sample";
  table?: string;
  column?: string;
}

export interface HolooProfileMatch {
  profile: HolooSchemaProfile | null;
  diagnostics: HolooProfileDiagnostic[];
}

const lower = (value: string) => value.trim().toLowerCase();

function fingerprintDiagnostics(profile: HolooSchemaProfile, fingerprint: HolooSchemaFingerprint): HolooProfileDiagnostic[] {
  const diagnostics: HolooProfileDiagnostic[] = [];
  if (!fingerprint.serverVersion || !fingerprint.productVersion || !fingerprint.productLevel || !fingerprint.edition) {
    return [{ code: "missing_fingerprint" }];
  }
  if (!/microsoft\s+sql\s+server/i.test(fingerprint.serverVersion)) {
    diagnostics.push({ code: "unsupported_sql_server" });
  }
  const version = /^(\d+)\./.exec(fingerprint.productVersion.trim());
  if (!version || !profile.fingerprintRules.sqlServerMajorVersions.includes(Number(version[1]))) {
    diagnostics.push({ code: "unsupported_sql_server_version" });
  }
  const edition = lower(fingerprint.edition);
  if (!profile.fingerprintRules.editionTokens.some((token) => edition.includes(token)) || !/edition/i.test(edition)) {
    diagnostics.push({ code: "unsupported_edition" });
  }
  if (!new RegExp(profile.fingerprintRules.productLevelPattern, "i").test(fingerprint.productLevel.trim())) {
    diagnostics.push({ code: "unsupported_product_level" });
  }
  if (!fingerprint.databaseCollation?.trim()) {
    diagnostics.push({ code: "missing_database_collation" });
  } else if (!new RegExp(profile.fingerprintRules.databaseCollationPattern, "i").test(fingerprint.databaseCollation)) {
    diagnostics.push({ code: "unsupported_database_collation" });
  }
  return diagnostics;
}

function tableForRequirement(
  snapshot: HolooSchemaSnapshot,
  profile: HolooSchemaProfile,
  requirement: HolooTableRequirement,
): { table: HolooSchemaTable | null; diagnostics: HolooProfileDiagnostic[] } {
  const nameMatches = snapshot.tables.filter((table) => lower(table.name) === lower(requirement.name));
  const allowed = nameMatches.filter((table) => profile.supportedSchemas.some((schema) => lower(schema) === lower(table.schema)));
  if (allowed.length === 0) {
    return {
      table: null,
      diagnostics: [{ code: nameMatches.length ? "unsupported_table_schema" : "missing_table", table: requirement.name }],
    };
  }
  if (allowed.length > 1) {
    return { table: null, diagnostics: [{ code: "ambiguous_table", table: requirement.name }] };
  }
  return { table: allowed[0], diagnostics: [] };
}

function profileDiagnostics(profile: HolooSchemaProfile, snapshot: HolooSchemaSnapshot): HolooProfileDiagnostic[] {
  const diagnostics = fingerprintDiagnostics(profile, snapshot.fingerprint);
  const dbCollation = snapshot.fingerprint.databaseCollation?.trim().toLowerCase() ?? null;

  for (const [entity, requirement] of Object.entries(profile.requirements) as [HolooEntity, HolooTableRequirement][]) {
    const found = tableForRequirement(snapshot, profile, requirement);
    diagnostics.push(...found.diagnostics);
    if (!found.table) continue;
    const table = found.table;
    const columns = new Map<string, HolooSchemaColumn[]>();
    for (const column of table.columns) {
      const key = lower(column.name);
      columns.set(key, [...(columns.get(key) ?? []), column]);
    }

    for (const required of requirement.requiredColumns) {
      const matches = columns.get(lower(required.name)) ?? [];
      if (matches.length === 0) {
        diagnostics.push({ code: "missing_column", table: requirement.name, column: required.name });
        continue;
      }
      if (matches.length > 1) {
        diagnostics.push({ code: "ambiguous_table", table: requirement.name, column: required.name });
        continue;
      }
      const actual = matches[0];
      if (!required.compatibleTypes.includes(lower(actual.dataType))) {
        diagnostics.push({ code: "incompatible_column_type", table: requirement.name, column: required.name });
      }
      if (required.notNull && actual.nullable) {
        diagnostics.push({ code: "nullable_required_column", table: requirement.name, column: required.name });
      }
      if (required.databaseCollation && actual.collation) {
        if (!dbCollation || lower(actual.collation) !== dbCollation) {
          diagnostics.push({ code: "column_collation_mismatch", table: requirement.name, column: required.name });
        }
      } else if (required.databaseCollation && (required.semantic === "unicode_text" || required.semantic === "text")) {
        diagnostics.push({ code: "column_collation_mismatch", table: requirement.name, column: required.name });
      }
      if (required.semantic === "date" && !DATE_TYPES.includes(lower(actual.dataType) as (typeof DATE_TYPES)[number])) {
        diagnostics.push({ code: "incompatible_column_type", table: requirement.name, column: required.name });
      }
    }

    if (requirement.primaryKey) {
      const actual = table.primaryKey.map(lower);
      const expected = requirement.primaryKey.map(lower);
      if (actual.length !== expected.length || actual.some((column, index) => column !== expected[index])) {
        diagnostics.push({ code: "primary_key_mismatch", table: requirement.name });
      }
    }

    for (const required of requirement.requiredColumns.filter((column) => column.semantic === "date")) {
      const samples = snapshot.dateSamples.find(
        (sample) => lower(sample.schema) === lower(table.schema) && lower(sample.table) === lower(table.name) && lower(sample.column) === lower(required.name),
      );
      if (samples && samples.values.some((value) => !/^\d{4}-\d{2}-\d{2}(?:[T ].*)?$/.test(value) || !Number.isFinite(Date.parse(value)))) {
        diagnostics.push({ code: "invalid_date_sample", table: requirement.name, column: required.name });
      }
    }

    // Keep `entity` in the loop's type-checking path: every requirement must
    // correspond to an adapter entity, even when it has no primary-key rule.
    void entity;
  }
  return diagnostics;
}

/**
 * Run all explicit profile checks and return the closest useful diagnostics
 * when the installation is unknown. No table-name-only match is possible.
 */
export function diagnoseProfile(snapshot: HolooSchemaSnapshot): HolooProfileMatch {
  let closest: { profile: HolooSchemaProfile; diagnostics: HolooProfileDiagnostic[] } | null = null;
  for (const profile of HOLOO_PROFILES) {
    const diagnostics = profileDiagnostics(profile, snapshot);
    if (diagnostics.length === 0) return { profile, diagnostics: [] };
    if (!closest || diagnostics.length < closest.diagnostics.length) closest = { profile, diagnostics };
  }
  return {
    profile: null,
    diagnostics: closest?.diagnostics ?? [{ code: "missing_fingerprint" }],
  };
}

/** Match an exact supported structure, or return null. */
export function matchProfile(snapshot: HolooSchemaSnapshot): HolooSchemaProfile | null {
  return diagnoseProfile(snapshot).profile;
}

/** Look up a versioned profile key stored on a connection. */
export function profileForKey(key: string | null | undefined): HolooSchemaProfile | null {
  return HOLOO_PROFILES.find((profile) => profile.key === key) ?? null;
}

/** Whether a key is eligible to arm the SQL write fallback. */
export function profileAllowsDirectSql(key: string | null | undefined): boolean {
  return profileForKey(key)?.capabilities.directSqlWrite === true;
}

/** SQL Server native date/time types accepted by this profile family. */
export function isHolooNativeDateType(type: string): boolean {
  return DATE_TYPES.includes(lower(type) as (typeof DATE_TYPES)[number]);
}
