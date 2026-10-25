/**
 * Canonical business-type policy and descriptive metadata for print templates.
 *
 * The settings gallery, rule selector, AI executors and the print-plan
 * resolver all use this registry. Keep support claims tied to the industry
 * profile and to document types the print pipeline actually loads; a mock
 * design must never make an unsupported feature appear available.
 */
import { INDUSTRIES, INDUSTRY_LABELS, type Industry } from "../industries";
import {
  BUILT_IN_TEMPLATES,
  DOC_TYPE_LABELS,
  PAPERS,
  templatePaperFitsDocType,
  type DocType,
  type PaperKey,
  type PrintTemplate,
} from "../print-template";
import {
  hasCapability,
  hasModule,
  industryProfile,
  type CapabilityKey,
  type ModuleKey,
} from "../industry-profile";
import { purposeForDocument, type PrinterPurpose } from "./routing";

// Keep catalog eligibility derived from #233's registry rather than a second
// hand-maintained list that drifts when an industry or capability is added.
const POS_INDUSTRIES: readonly Industry[] = INDUSTRIES.filter((industry) => hasModule(industry, "pos"));
const BARCODE_INDUSTRIES: readonly Industry[] = INDUSTRIES.filter((industry) => hasCapability(industry, "barcode"));
const REPAIR_INDUSTRIES: readonly Industry[] = INDUSTRIES.filter((industry) => hasCapability(industry, "repairs"));
const SERIALIZED_RETAIL_INDUSTRIES: readonly Industry[] = INDUSTRIES.filter(
  (industry) => hasCapability(industry, "repairs") || hasModule(industry, "automotive"),
);

export type TemplateSampleKind =
  | "food_service"
  | "retail"
  | "jewelry"
  | "serialized_retail"
  | "batch_expiry"
  | "kitchen"
  | "woo_invoice"
  | "shipping_label"
  | "vehicle";

export interface PrintTemplateMetadata {
  /** Stable catalog identity. This is unchanged if a built-in's label changes. */
  key: string;
  version: number;
  docType: DocType;
  paper: PaperKey;
  allowedIndustries: readonly Industry[];
  /** All listed modules/capabilities are required. */
  requiredModules: readonly ModuleKey[];
  requiredCapabilities: readonly CapabilityKey[];
  compatiblePrinterPurposes: readonly PrinterPurpose[];
  /** Fields rendered by the canonical data contract (not promises of compliance). */
  requiredDataFields: readonly string[];
  requiresWooConnection: boolean;
  sampleKind: TemplateSampleKind;
}

export interface TemplateAccessContext {
  industry: Industry;
  /** True only when integrations are enabled and this branch has an active Woo store. */
  wooEnabled: boolean;
}

export type TemplateUnavailableReason =
  | "unsupported_document"
  | "industry_mismatch"
  | "module_unavailable"
  | "capability_unavailable"
  | "woo_not_connected"
  | "incompatible_paper";

const SPECIAL_POLICY: Partial<Record<string, Partial<Pick<
  PrintTemplateMetadata,
  "allowedIndustries" | "requiredModules" | "requiredCapabilities" | "requiresWooConnection" | "sampleKind"
>>>> = {
  "thermal58-receipt-grocery": {
    allowedIndustries: BARCODE_INDUSTRIES,
    requiredCapabilities: ["barcode"],
    sampleKind: "retail",
  },
  "thermal80-kitchen": { allowedIndustries: ["food_service"], sampleKind: "kitchen" },
  "thermal80-kitchen-large": { allowedIndustries: ["food_service"], sampleKind: "kitchen" },
  "thermal80-kitchen-barista": { allowedIndustries: ["food_service"], sampleKind: "kitchen" },
  "thermal58-kitchen-compact": {
    allowedIndustries: ["food_service"],
    sampleKind: "kitchen",
  },
  "a4-invoice-jewelry": {
    allowedIndustries: ["jewelry"],
    requiredModules: ["pos", "jewelry"],
    sampleKind: "jewelry",
  },
  "a4-invoice-serialized": {
    allowedIndustries: SERIALIZED_RETAIL_INDUSTRIES,
    requiredCapabilities: ["barcode"],
    sampleKind: "serialized_retail",
  },
  "a5-invoice-service": {
    allowedIndustries: REPAIR_INDUSTRIES,
    requiredCapabilities: ["repairs"],
    sampleKind: "serialized_retail",
  },
  "label57x40-batch-expiry": {
    allowedIndustries: ["cosmetics"],
    requiredCapabilities: ["barcode", "batch_expiry"],
    sampleKind: "batch_expiry",
  },
  "label57x40-shelf-price": {
    allowedIndustries: BARCODE_INDUSTRIES,
    requiredCapabilities: ["barcode"],
    sampleKind: "retail",
  },
  "label57x40-jewelry-tag": {
    allowedIndustries: REPAIR_INDUSTRIES,
    requiredCapabilities: ["barcode"],
    sampleKind: "jewelry",
  },
  "woo-shipping-100x150": {
    allowedIndustries: POS_INDUSTRIES,
    requiredModules: ["integrations", "pos"],
    requiresWooConnection: true,
    sampleKind: "shipping_label",
  },
  "woo-shipping-a6": {
    allowedIndustries: POS_INDUSTRIES,
    requiredModules: ["integrations", "pos"],
    requiresWooConnection: true,
    sampleKind: "shipping_label",
  },
  "a6-shipping-compact": {
    allowedIndustries: POS_INDUSTRIES,
    requiredModules: ["integrations", "pos"],
    requiresWooConnection: true,
    sampleKind: "shipping_label",
  },
  "woo-a4-invoice": {
    allowedIndustries: POS_INDUSTRIES,
    requiredModules: ["integrations", "pos"],
    requiresWooConnection: true,
    sampleKind: "woo_invoice",
  },
  "woo-a5-invoice": {
    allowedIndustries: POS_INDUSTRIES,
    requiredModules: ["integrations", "pos"],
    requiresWooConnection: true,
    sampleKind: "woo_invoice",
  },
  "a5-woo-invoice-summary": {
    allowedIndustries: POS_INDUSTRIES,
    requiredModules: ["integrations", "pos"],
    requiresWooConnection: true,
    sampleKind: "woo_invoice",
  },
  "a4-woo-invoice-packing": {
    allowedIndustries: POS_INDUSTRIES,
    requiredModules: ["integrations", "pos"],
    requiresWooConnection: true,
    sampleKind: "woo_invoice",
  },
};

const DOC_POLICY: Record<DocType, Pick<PrintTemplateMetadata,
  "allowedIndustries" | "requiredModules" | "requiredCapabilities" | "compatiblePrinterPurposes" | "requiredDataFields" | "requiresWooConnection" | "sampleKind"
>> = {
  receipt: {
    allowedIndustries: POS_INDUSTRIES,
    requiredModules: ["pos"],
    requiredCapabilities: [],
    compatiblePrinterPurposes: [purposeForDocument("receipt")],
    requiredDataFields: ["number", "issuedAt", "lines", "total"],
    requiresWooConnection: false,
    sampleKind: "retail",
  },
  invoice: {
    allowedIndustries: POS_INDUSTRIES,
    requiredModules: ["pos"],
    requiredCapabilities: [],
    compatiblePrinterPurposes: [purposeForDocument("invoice")],
    requiredDataFields: ["number", "issuedAt", "customer", "lines", "totals"],
    requiresWooConnection: false,
    sampleKind: "retail",
  },
  kitchen: {
    allowedIndustries: ["food_service"],
    requiredModules: ["kitchen"],
    requiredCapabilities: [],
    compatiblePrinterPurposes: [purposeForDocument("kitchen")],
    requiredDataFields: ["number", "issuedAt", "lines", "note"],
    requiresWooConnection: false,
    sampleKind: "kitchen",
  },
  label: {
    allowedIndustries: BARCODE_INDUSTRIES,
    requiredModules: ["pos"],
    requiredCapabilities: ["barcode"],
    compatiblePrinterPurposes: [purposeForDocument("label")],
    requiredDataFields: ["title", "labelFields", "barcodeValue"],
    requiresWooConnection: false,
    sampleKind: "retail",
  },
  shipping_label: {
    allowedIndustries: POS_INDUSTRIES,
    requiredModules: ["integrations", "pos"],
    requiredCapabilities: [],
    compatiblePrinterPurposes: ["label", "document"],
    requiredDataFields: ["shipment.recipient", "shipment.address", "shipment.phone"],
    requiresWooConnection: true,
    sampleKind: "shipping_label",
  },
  woo_invoice: {
    allowedIndustries: POS_INDUSTRIES,
    requiredModules: ["integrations", "pos"],
    requiredCapabilities: [],
    compatiblePrinterPurposes: ["document"],
    requiredDataFields: ["number", "sourceAmounts", "customer", "lines"],
    requiresWooConnection: true,
    sampleKind: "woo_invoice",
  },
};

function metadataForKey(template: PrintTemplate, stableKey: string): PrintTemplateMetadata {
  const base = DOC_POLICY[template.docType];
  const special = SPECIAL_POLICY[stableKey] ?? {};
  return {
    key: stableKey,
    version: 1,
    docType: template.docType,
    paper: template.paper,
    ...base,
    ...special,
    compatiblePrinterPurposes: base.compatiblePrinterPurposes,
    requiredDataFields: base.requiredDataFields,
  };
}

/**
 * Metadata for a built-in, a copied built-in (`sourceKey`) or a user-created
 * layout. User-created layouts inherit the safe, document-wide policy unless
 * they retain a source key for an industry-specific design.
 */
export function templateMetadata(template: PrintTemplate): PrintTemplateMetadata {
  const candidateKey = template.sourceKey ?? template.key;
  const source = BUILT_IN_TEMPLATES.find((candidate) => candidate.key === candidateKey);
  const stableKey = source ? source.key : template.docType;
  const metadata = metadataForKey(source ?? template, stableKey);
  return { ...metadata, key: stableKey, paper: template.paper };
}

export function templateUnavailableReason(
  template: PrintTemplate,
  context: TemplateAccessContext,
): TemplateUnavailableReason | null {
  const metadata = templateMetadata(template);
  // A copy's source must continue to describe the same document kind; changing
  // the layout's document kind never carries the old source's permission.
  if (template.sourceKey && metadata.docType !== template.docType) return "unsupported_document";
  if (!PAPERS[template.paper] || !templatePaperFitsDocType(template.docType, template.paper)) return "incompatible_paper";
  if (!metadata.allowedIndustries.includes(context.industry)) return "industry_mismatch";
  const profile = industryProfile(context.industry);
  if (!metadata.requiredModules.every((module) => profile.modules.includes(module))) return "module_unavailable";
  if (!metadata.requiredCapabilities.every((capability) => profile.capabilities.includes(capability))) return "capability_unavailable";
  if (metadata.requiresWooConnection && !context.wooEnabled) return "woo_not_connected";
  return null;
}

export function isTemplateAvailable(template: PrintTemplate, context: TemplateAccessContext): boolean {
  return templateUnavailableReason(template, context) === null;
}

/** Built-ins the business may browse, select and print at this moment. */
export function availableBuiltInTemplates(context: TemplateAccessContext): PrintTemplate[] {
  return BUILT_IN_TEMPLATES.filter((template) => isTemplateAvailable(template, context));
}

export function eligibleTemplates<T extends PrintTemplate>(templates: readonly T[], context: TemplateAccessContext): T[] {
  return templates.filter((template) => isTemplateAvailable(template, context));
}

export function templatesForDocumentType(
  templates: readonly PrintTemplate[],
  documentType: DocType,
): PrintTemplate[] {
  return templates.filter((template) => template.docType === documentType);
}

export function hasAvailableTemplateForDocument(
  templates: readonly PrintTemplate[],
  documentType: DocType,
): boolean {
  return templates.some((template) => template.docType === documentType);
}

export function eligibleIndustryLabel(metadata: PrintTemplateMetadata): string {
  if (metadata.allowedIndustries.length === POS_INDUSTRIES.length) return "همهٔ کسب‌وکارهای دارای فروش صندوقی";
  return metadata.allowedIndustries.map((industry) => INDUSTRY_LABELS[industry]).join("، ");
}

export function templateMetadataForDisplay(template: PrintTemplate): {
  eligibleIndustry: string;
  documentKind: string;
  paper: string;
  orientation: string;
  logo: string;
  requiredDataFields: readonly string[];
} {
  const metadata = templateMetadata(template);
  const dimensions = PAPERS[template.paper];
  const landscape = template.options.orientation === "landscape" && dimensions.kind !== "thermal";
  const usesLogo = template.blocks.some((block) => block.visible && block.type === "logo");
  return {
    eligibleIndustry: eligibleIndustryLabel(metadata),
    documentKind: DOC_TYPE_LABELS[template.docType],
    paper: dimensions.label,
    orientation: landscape ? "افقی" : "عمودی",
    logo: usesLogo ? "لوگو: در صورت ثبت نمایش داده می‌شود" : "لوگو: در این قالب استفاده نمی‌شود",
    requiredDataFields: metadata.requiredDataFields,
  };
}

/** UI filters and tests use the same document types as the eligible catalog. */
export function availableDocumentTypes(templates: readonly PrintTemplate[]): DocType[] {
  const order: DocType[] = ["receipt", "invoice", "kitchen", "label", "shipping_label", "woo_invoice"];
  return order.filter((docType) => templates.some((template) => template.docType === docType));
}
