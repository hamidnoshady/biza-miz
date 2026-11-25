/**
 * Atomic write path for the retail products workspace.
 *
 * A product can span a container item, many sellable variant items, attribute
 * rows, scanner barcodes and opening stock/price rows. They are one user action
 * and therefore one transaction: a duplicate barcode or bad stock row must not
 * leave a half-created family in the catalogue.
 */
import Decimal from "decimal.js";
import { getPool, type PoolClient } from "./db";
import { setInitialUnitCost, setUnitPrice } from "./accessories-service";
import { createOpeningStockDraft, type OpeningStockLineInput } from "./item-opening-stock-service";
import { assignBarcode } from "./item-barcodes-service";
import {
  createItem,
  createVariantChild,
  updateItemMeta,
  type Item,
  type ItemMetaPatch,
} from "./items-service";
import type {
  ParsedPriceRecommendation,
  ParsedProductCreateInput,
  ParsedProductVariantInput,
} from "./product-input";
import { insertPriceHistory, type PriceHistoryRow } from "./price-history";

/**
 * Provenance for the opening prices this call writes (issue #924, review
 * item 3). `recommendation` is the advisor calculation the form showed when the
 * user pressed «اعمال قیمت پیشنهادی»; it only becomes audit metadata for an
 * item whose saved sale price still equals the suggestion.
 */
export interface ProductCreateAudit {
  businessId: string;
  userId?: string | null;
  recommendation?: ParsedPriceRecommendation | null;
}
import type { ProductValidationIssue } from "./product-input";
import { attributeComparisonKey, normalizeAttributeText } from "./product-attributes";

export interface CreatedProduct {
  item: Item;
  variants: Item[];
  galleryMediaIds?: string[];
  /**
   * The draft opening-stock document holding the quantities the form proposed
   * (GH #1567 F2); null when no opening quantity was entered. Nothing is on
   * the shelf until it is reviewed and posted.
   */
  openingStockDocumentId?: string | null;
}

function commonMeta(input: ParsedProductCreateInput): ItemMetaPatch {
  return {
    unit: input.unit,
    subUnit: input.subUnit,
    conversionFactor: input.conversionFactor,
    minOrderQty: input.minOrderQty,
    reorderReminderQty: input.reorderReminderQty,
    leadTimeDays: input.leadTimeDays,
    storageLocation: input.storageLocation,
    taxSalePercent: input.taxSalePercent,
    taxPurchasePercent: input.taxPurchasePercent,
    isSellable: input.isSellable,
    publishStatus: input.publishStatus,
    shortDescription: input.shortDescription,
    longDescription: input.longDescription,
  };
}

/**
 * Writes the catalogue half of the opening values — the sale price and the
 * purchase price as a price-list fact — and returns the opening quantity as a
 * proposed opening-stock line. Stock is never moved here (GH #1567 F2): a
 * quantity typed into the product form becomes a draft opening-stock document
 * that is reviewed and posted (stock + Dr inventory / Cr opening equity) as
 * its own act. Before F2 this path received the stock with no journal entry.
 */
async function writeOpeningValues(
  client: PoolClient,
  itemId: string,
  defaults: Pick<ParsedProductCreateInput, "sellPrice" | "purchasePrice" | "quantity">,
  override?: ParsedProductVariantInput,
): Promise<{ sellPrice: number | null; openingLine: OpeningStockLineInput | null }> {
  const sellPrice = override?.sellPrice ?? defaults.sellPrice;
  const purchasePrice = override?.purchasePrice ?? defaults.purchasePrice;
  const quantity = override?.quantity ?? defaults.quantity;

  if (sellPrice !== null) await setUnitPrice(itemId, sellPrice, client);
  // A known purchase price is a price-list fact with or without stock.
  if (purchasePrice !== null) await setInitialUnitCost(itemId, purchasePrice, client);

  const openingLine =
    quantity !== null && new Decimal(quantity).gt(0)
      ? { itemId, quantity: new Decimal(quantity).toFixed(), unitCost: String(purchasePrice ?? 0) }
      : null;
  return { sellPrice, openingLine };
}

/**
 * The audit row for one opening sale price. A price the advisor produced and the
 * user accepted unchanged is labelled `recommendation` with its inputs; any
 * other value is a manual edit — an override must never be disguised as an
 * algorithmic suggestion.
 */
function openingPriceHistory(
  audit: ProductCreateAudit | undefined,
  locationId: string,
  itemId: string,
  sellPrice: number,
): PriceHistoryRow {
  const recommendation =
    audit?.recommendation && audit.recommendation.suggestedPriceRial === sellPrice
      ? audit.recommendation
      : null;
  return {
    businessId: audit!.businessId,
    locationId,
    itemId,
    priceKind: "sale",
    oldPrice: null,
    newPrice: sellPrice,
    source: recommendation ? "recommendation" : "manual",
    actorId: audit?.userId ?? null,
    reason: recommendation ? "product_created_with_recommended_price" : "product_created",
    metadata: recommendation
      ? {
          kind: "retail_price_recommendation",
          mode: recommendation.mode,
          suggestedPriceRial: recommendation.suggestedPriceRial,
          appliedPriceRial: sellPrice,
          inputs: recommendation.inputs,
        }
      : null,
  };
}

interface AttributeDefinitionSnapshot {
  id: string;
  name: string;
  options: string[];
  is_active: boolean;
}

export class ProductAttributeValidationError extends Error {
  constructor(readonly issues: ProductValidationIssue[]) {
    super(issues[0]?.message ?? "ویژگی‌های تنوع با تعریف‌های فعال شعبه سازگار نیستند.");
    this.name = "ProductAttributeValidationError";
  }
}

function validationIssue(
  field: string,
  code: string,
  message: string,
): ProductValidationIssue {
  return { field, section: "attributes", code, message };
}

/**
 * Resolve submitted variant attributes against one locked branch snapshot.
 * Legacy/imported callers may still submit a name, but it must resolve to an
 * active definition. An empty options list is the explicit free-text policy;
 * predefined options are matched with the same Persian-aware key as the UI.
 */
async function resolveVariantDefinitions(
  client: PoolClient,
  locationId: string,
  input: ParsedProductCreateInput,
): Promise<ParsedProductCreateInput> {
  if (input.variants.length === 0) return input;

  const { rows } = await client.query<AttributeDefinitionSnapshot>(
    `SELECT id::text AS id, name, options, is_active
       FROM item_attribute_definitions
      WHERE location_id = $1
      FOR SHARE`,
    [locationId],
  );
  const byId = new Map(rows.map((row) => [row.id, row]));
  const byName = new Map<string, AttributeDefinitionSnapshot[]>();
  for (const definition of rows) {
    const key = attributeComparisonKey(definition.name);
    byName.set(key, [...(byName.get(key) ?? []), definition]);
  }

  const issues: ProductValidationIssue[] = [];
  const variants = input.variants.map((variant, variantIndex) => ({
    ...variant,
    attributes: variant.attributes.map((attribute, attributeIndex) => {
      const field = `variants.${variantIndex}.attributes.${attributeIndex}`;
      const candidates = attribute.definitionId
        ? [byId.get(attribute.definitionId)].filter((row): row is AttributeDefinitionSnapshot => Boolean(row))
        : byName.get(attributeComparisonKey(attribute.name)) ?? [];
      const definition = candidates[0];

      if (candidates.length > 1) {
        issues.push(validationIssue(`${field}.name`, "ambiguous_attribute", "نام ویژگی با بیش از یک تعریف در شعبه سازگار است؛ شناسهٔ ویژگی را تازه‌سازی کنید."));
        return attribute;
      }
      if (!definition) {
        issues.push(
          validationIssue(
            attribute.definitionId ? `${field}.definitionId` : `${field}.name`,
            "unknown_attribute_definition",
            "این ویژگی در شعبه تعریف نشده است؛ ساختار ویژگی‌ها را تازه‌سازی و مقدار پیش‌نویس را بازبینی کنید.",
          ),
        );
        return attribute;
      }
      if (!definition.is_active) {
        issues.push(
          validationIssue(
            `${field}.definitionId`,
            "inactive_attribute_definition",
            `ویژگی «${definition.name}» غیرفعال شده است؛ مقدار پیش‌نویس حفظ شده، اما باید آن را با یک ویژگی فعال تطبیق دهید.`,
          ),
        );
        return attribute;
      }

      let value = normalizeAttributeText(attribute.value);
      if (definition.options.length > 0) {
        const requested = attributeComparisonKey(value);
        const permitted = definition.options.filter((option) => attributeComparisonKey(option) === requested);
        if (permitted.length !== 1) {
          issues.push(
            validationIssue(
              `${field}.value`,
              "invalid_attribute_value",
              `مقدار ویژگی «${definition.name}» دیگر مجاز نیست؛ گزینه‌های فعال را تازه کنید و یک مقدار جایگزین برگزینید.`,
            ),
          );
          return attribute;
        }
        // A controlled value is always stored with its canonical master label.
        value = permitted[0];
      }

      return {
        definitionId: definition.id,
        name: definition.name,
        value,
      };
    }),
  }));

  if (issues.length > 0) throw new ProductAttributeValidationError(issues);
  return { ...input, variants };
}

async function assertProductMediaReferences(
  client: PoolClient,
  locationId: string,
  input: ParsedProductCreateInput,
): Promise<void> {
  const refs: Array<{ id: string; field: string; section: ProductValidationIssue["section"] }> = [];
  if (input.coverMediaId) {
    refs.push({ id: input.coverMediaId, field: "coverMediaId", section: "base" });
  }
  (input.galleryMediaIds ?? []).forEach((id, index) => {
    refs.push({ id, field: `galleryMediaIds.${index}`, section: "base" });
  });
  input.variants.forEach((variant, index) => {
    if (variant.imageMediaId) {
      refs.push({ id: variant.imageMediaId, field: `variants.${index}.imageMediaId`, section: "attributes" });
    }
  });
  if (refs.length === 0) return;

  const uniqueIds = [...new Set(refs.map((r) => r.id))];
  const { rows } = await client.query<{ id: string; kind: string; mime_type: string; deleted_at: string | null }>(
    `SELECT ma.id::text AS id, ma.kind, ma.mime_type, ma.deleted_at
       FROM media_assets ma
       JOIN locations l ON l.business_id = ma.business_id
      WHERE l.id = $1
        AND ma.id = ANY($2::uuid[])`,
    [locationId, uniqueIds],
  );
  const validIds = new Set(
    rows
      .filter((r) => r.kind === "image" && r.mime_type !== "image/svg+xml" && r.deleted_at === null)
      .map((r) => r.id),
  );

  const issues: ProductValidationIssue[] = [];
  for (const ref of refs) {
    if (!validIds.has(ref.id)) {
      issues.push({
        code: "invalid_media_asset",
        field: ref.field,
        section: ref.section,
        message: "تصویر انتخاب‌شده در کتابخانهٔ رسانهٔ این کسب‌وکار یافت نشد یا حذف شده است.",
      });
    }
  }
  if (issues.length > 0) {
    throw new ProductAttributeValidationError(issues);
  }
}

/** Create one validated product family, all-or-nothing. */
export async function createProductRecord(
  locationId: string,
  input: ParsedProductCreateInput,
  audit?: ProductCreateAudit,
  transactionClient?: PoolClient,
): Promise<CreatedProduct> {
  const client = transactionClient ?? await getPool().connect();
  const priced: { itemId: string; sellPrice: number }[] = [];
  const openingLines: OpeningStockLineInput[] = [];
  try {
    if (!transactionClient) await client.query("BEGIN");

    const resolvedInput = await resolveVariantDefinitions(client, locationId, input);
    await assertProductMediaReferences(client, locationId, resolvedInput);
    const hasVariants = resolvedInput.variants.length > 0;
    const parent = await createItem(
      {
        locationId,
        name: resolvedInput.name,
        sku: resolvedInput.sku,
        kind: hasVariants ? "variant_parent" : "simple",
      },
      client,
    );
    const updatedParent = await updateItemMeta(
      parent.id,
      {
        ...commonMeta(resolvedInput),
        // A family is not the thing at the till. The parser also refuses a
        // parent barcode when variants exist, keeping scanner identity on the
        // actual sellable row.
        barcode: hasVariants ? null : resolvedInput.barcode,
        imageMediaId: resolvedInput.coverMediaId ?? null,
      },
      client,
    );

    const galleryMediaIds = resolvedInput.galleryMediaIds ?? [];
    for (let index = 0; index < galleryMediaIds.length; index += 1) {
      await client.query(
        `INSERT INTO item_media (item_id, media_asset_id, sort_order) VALUES ($1, $2, $3)`,
        [parent.id, galleryMediaIds[index], index],
      );
    }

    const variants: Item[] = [];
    if (!hasVariants) {
      if (resolvedInput.barcode) await assignBarcode(parent.id, { code: resolvedInput.barcode }, client);
      const written = await writeOpeningValues(client, parent.id, resolvedInput);
      if (written.sellPrice !== null) priced.push({ itemId: parent.id, sellPrice: written.sellPrice });
      if (written.openingLine) openingLines.push(written.openingLine);
    } else {
      for (const variant of resolvedInput.variants) {
        const childName =
          variant.name ?? [resolvedInput.name, ...variant.attributes.map((attribute) => attribute.value)].join(" — ");
        const child = await createVariantChild(
          parent.id,
          locationId,
          childName,
          variant.sku,
          variant.attributes,
          client,
        );
        const updatedChild = await updateItemMeta(
          child.id,
          {
            ...commonMeta(resolvedInput),
            barcode: variant.barcode,
            imageMediaId: variant.imageMediaId ?? null,
          },
          client,
        );
        if (variant.barcode) await assignBarcode(child.id, { code: variant.barcode }, client);
        // Both facts matter: the price the opening write stored (for the
        // immutable price-history rows below) and the row as `updateItemMeta`
        // left it — the variant's barcode and media are written by that call,
        // so the stale `child` would drop them from the response.
        const written = await writeOpeningValues(client, child.id, resolvedInput, variant);
        if (written.sellPrice !== null) priced.push({ itemId: child.id, sellPrice: written.sellPrice });
        if (written.openingLine) openingLines.push(written.openingLine);
        variants.push(updatedChild ?? child);
      }
    }

    // The opening sale price is a price write like any other: it joins this
    // transaction, so a rollback cannot leave history for a product that was
    // never committed.
    if (audit?.businessId && priced.length > 0) {
      await insertPriceHistory(
        client,
        priced.map((entry) => openingPriceHistory(audit, locationId, entry.itemId, entry.sellPrice)),
      );
    }

    let openingStockDocumentId: string | null = null;
    if (openingLines.length > 0) {
      const businessId = audit?.businessId ?? (await client.query<{ business_id: string }>(
        `SELECT business_id::text FROM locations WHERE id = $1`,
        [locationId],
      )).rows[0]?.business_id;
      if (!businessId) throw new Error("location_not_found");
      const draft = await createOpeningStockDraft(client, {
        businessId,
        locationId,
        source: "product_form",
        note: `موجودی اولیهٔ «${resolvedInput.name}» — پیش از ثبت بازبینی شود`.slice(0, 500),
        idempotencyKey: `product:${parent.id}`,
        lines: openingLines,
        createdBy: audit?.userId ?? null,
      });
      openingStockDocumentId = draft.document.id;
    }

    if (!transactionClient) await client.query("COMMIT");
    return {
      item: updatedParent ?? parent,
      variants,
      galleryMediaIds,
      openingStockDocumentId,
    };
  } catch (error) {
    if (!transactionClient) await client.query("ROLLBACK");
    throw error;
  } finally {
    if (!transactionClient) client.release();
  }
}
