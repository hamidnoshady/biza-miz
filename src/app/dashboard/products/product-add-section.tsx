"use client";

/**
 * «افزودن محصول» — a validated, responsive product-family form.
 *
 * Drafts are isolated by business/branch in this browser. The same pure input
 * parser runs here and in the API, while the server commits the parent,
 * variants, barcodes and opening values atomically.
 */
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BarcodeIcon,
  CheckCircle2Icon,
  Layers3Icon,
  PlusIcon,
  RotateCcwIcon,
  SaveIcon,
  Trash2Icon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { PersianNumberInput } from "@/components/ui/persian-number-input";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { useMoney } from "@/components/money/money-context";
import { internalBarcodeForPayload } from "@/lib/barcode";
import { accountingProductsHref } from "@/lib/app-routes";
import { normalizeNumericText, toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import {
  parseProductCreateInput,
  type ProductFormSection,
  type ProductValidationIssue,
} from "@/lib/product-input";
import type { AttributeDefinition } from "@/lib/product-attributes-service";
import {
  draftAttributeReconciliationIssues,
  migrateDraftAttributeValues,
  snapshotAttributeDefinitions,
  type AttributeDefinitionSnapshot,
  type DraftAttributeReconciliationIssue,
} from "@/lib/product-attribute-drafts";
import { attributeComparisonKey } from "@/lib/product-attributes";
import { recommendRetailPrice, type ProfitTargetMode } from "@/lib/retail-price-recommendation";
import { api, ErrorBox, Field, inputClass } from "../ui";
import {
  cardClass,
  EmptyState,
  SectionCard,
  SectionCardSkeleton,
  TabBar,
  TabPanel,
} from "../page-chrome";

const DRAFTS_KEY_PREFIX = "products-add-drafts:v3";
const LEGACY_DRAFTS_KEY_PREFIX = "products-add-drafts:v2";
const MAX_DRAFTS = 10;

type DraftId = string | number;

interface VariantDraft {
  id: DraftId;
  /** Values are keyed by immutable attribute-definition ID, never by its label. */
  values: Record<string, string>;
  /** Values that could not be safely matched while migrating an older draft. */
  unresolvedValues: Record<string, string>;
  sku: string;
  barcode: string;
  autoBarcode: boolean;
  sellPrice: string;
  purchasePrice: string;
  quantity: string;
}

interface FormState {
  name: string;
  barcode: string;
  autoBarcode: boolean;
  sku: string;
  autoSku: boolean;
  notSellable: boolean;
  sellPrice: string;
  purchasePrice: string;
  calculatorFixedOverhead: string;
  calculatorOverheadPercent: string;
  calculatorTargetPercent: string;
  calculatorTargetMode: ProfitTargetMode;
  quantity: string;
  unit: string;
  subUnit: string;
  conversionFactor: string;
  reorderReminder: string;
  minOrder: string;
  leadTimeDays: string;
  storageLocation: string;
  taxSalePercent: string;
  taxPurchasePercent: string;
  variants: VariantDraft[];
  definitionSnapshot: Record<string, AttributeDefinitionSnapshot>;
}

const EMPTY_FORM: FormState = {
  name: "",
  barcode: "",
  autoBarcode: false,
  sku: "",
  autoSku: false,
  notSellable: false,
  sellPrice: "",
  purchasePrice: "",
  calculatorFixedOverhead: "",
  calculatorOverheadPercent: "",
  calculatorTargetPercent: "",
  calculatorTargetMode: "markup",
  quantity: "",
  unit: "",
  subUnit: "",
  conversionFactor: "",
  reorderReminder: "",
  minOrder: "",
  leadTimeDays: "",
  storageLocation: "",
  taxSalePercent: "",
  taxPurchasePercent: "",
  variants: [],
  definitionSnapshot: {},
};

interface StoredDraft {
  id: DraftId;
  savedAt: number;
  form: FormState;
}

const TABS = [
  { key: "pricing", label: "قیمت‌گذاری" },
  { key: "general", label: "عمومی" },
  { key: "order", label: "سفارش" },
  { key: "tax", label: "مالیات" },
  { key: "attributes", label: "تنوع‌ها" },
] as const;
type TabKey = (typeof TABS)[number]["key"];

const SECTION_TO_TAB: Partial<Record<ProductFormSection, TabKey>> = {
  pricing: "pricing",
  general: "general",
  order: "order",
  tax: "tax",
  attributes: "attributes",
};

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Tolerate stale/corrupt localStorage instead of crashing the whole page. */
function safeForm(value: unknown): FormState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ...EMPTY_FORM };
  const raw = value as Record<string, unknown>;
  const variants = Array.isArray(raw.variants)
    ? raw.variants.slice(0, 100).flatMap((entry, index): VariantDraft[] => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
        const variant = entry as Record<string, unknown>;
        const rawValues =
          variant.values && typeof variant.values === "object" && !Array.isArray(variant.values)
            ? (variant.values as Record<string, unknown>)
            : {};
        const values = Object.fromEntries(
          Object.entries(rawValues)
            .filter(([, option]) => typeof option === "string")
            .map(([definitionId, option]) => [definitionId, String(option)]),
        );
        const rawUnresolved =
          variant.unresolvedValues && typeof variant.unresolvedValues === "object" && !Array.isArray(variant.unresolvedValues)
            ? (variant.unresolvedValues as Record<string, unknown>)
            : {};
        const unresolvedValues = Object.fromEntries(
          Object.entries(rawUnresolved)
            .filter(([, option]) => typeof option === "string")
            .map(([oldName, option]) => [oldName, String(option)]),
        );
        return [
          {
            id:
              typeof variant.id === "string" || typeof variant.id === "number"
                ? variant.id
                : `restored-${index}`,
            values,
            unresolvedValues,
            sku: text(variant.sku),
            barcode: text(variant.barcode),
            autoBarcode: variant.autoBarcode === true,
            sellPrice: text(variant.sellPrice),
            purchasePrice: text(variant.purchasePrice),
            quantity: text(variant.quantity),
          },
        ];
      })
    : [];
  const rawSnapshot =
    raw.definitionSnapshot && typeof raw.definitionSnapshot === "object" && !Array.isArray(raw.definitionSnapshot)
      ? (raw.definitionSnapshot as Record<string, unknown>)
      : {};
  const definitionSnapshot = Object.fromEntries(
    Object.entries(rawSnapshot).slice(0, 100).flatMap(([id, snapshot]) => {
      if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return [];
      const entry = snapshot as Record<string, unknown>;
      if (typeof entry.name !== "string" || !Array.isArray(entry.options)) return [];
      return [[id, {
        name: entry.name.slice(0, 200),
        options: entry.options.filter((option): option is string => typeof option === "string").slice(0, 50).map((option) => option.slice(0, 200)),
        isActive: entry.isActive === true,
      } satisfies AttributeDefinitionSnapshot]];
    }),
  );

  return {
    name: text(raw.name),
    barcode: text(raw.barcode),
    autoBarcode: raw.autoBarcode === true,
    sku: text(raw.sku),
    autoSku: raw.autoSku === true,
    notSellable: raw.notSellable === true,
    sellPrice: text(raw.sellPrice),
    purchasePrice: text(raw.purchasePrice),
    calculatorFixedOverhead: text(raw.calculatorFixedOverhead),
    calculatorOverheadPercent: text(raw.calculatorOverheadPercent),
    calculatorTargetPercent: text(raw.calculatorTargetPercent),
    calculatorTargetMode: raw.calculatorTargetMode === "gross_margin" ? "gross_margin" : "markup",
    quantity: text(raw.quantity),
    unit: text(raw.unit),
    subUnit: text(raw.subUnit),
    conversionFactor: text(raw.conversionFactor),
    reorderReminder: text(raw.reorderReminder),
    minOrder: text(raw.minOrder),
    leadTimeDays: text(raw.leadTimeDays),
    storageLocation: text(raw.storageLocation),
    taxSalePercent: text(raw.taxSalePercent),
    taxPurchasePercent: text(raw.taxPurchasePercent),
    variants,
    definitionSnapshot,
  };
}

function readDrafts(storageKey: string): StoredDraft[] {
  try {
    const legacyKey = storageKey.replace(DRAFTS_KEY_PREFIX, LEGACY_DRAFTS_KEY_PREFIX);
    const current = window.localStorage.getItem(storageKey);
    const legacy = current ? null : window.localStorage.getItem(legacyKey);
    const raw = JSON.parse(current ?? legacy ?? "[]") as unknown;
    if (!Array.isArray(raw)) return [];
    return raw.slice(0, MAX_DRAFTS).flatMap((entry): StoredDraft[] => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
      const draft = entry as Record<string, unknown>;
      if (
        (typeof draft.id !== "string" && typeof draft.id !== "number") ||
        typeof draft.savedAt !== "number" ||
        !Number.isFinite(draft.savedAt)
      ) {
        return [];
      }
      return [{ id: draft.id, savedAt: draft.savedAt, form: safeForm(draft.form) }];
    });
  } catch {
    return [];
  }
}

function hasContent(form: FormState): boolean {
  return (
    form.notSellable ||
    form.variants.length > 0 ||
    Object.entries(form).some(([key, value]) =>
      key === "variants" || key === "notSellable" || typeof value !== "string" ? false : value.trim() !== "",
    )
  );
}

function uniqueId(prefix: string): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return `${prefix}-${crypto.randomUUID()}`;
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function generatedSku(): string {
  if (typeof crypto !== "undefined" && "getRandomValues" in crypto) {
    const values = new Uint32Array(1);
    crypto.getRandomValues(values);
    return `K-${values[0].toString(36).toUpperCase().padStart(7, "0").slice(-7)}`;
  }
  return `K-${Date.now().toString(36).slice(-7).toUpperCase()}`;
}

function generatedBarcode(): string {
  let seed: bigint;
  if (typeof crypto !== "undefined" && "getRandomValues" in crypto) {
    const values = new Uint32Array(2);
    crypto.getRandomValues(values);
    seed = (BigInt(values[0]) << 32n) | BigInt(values[1]);
  } else {
    seed = BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000));
  }
  const payload = (seed % 100_000_000_000n).toString().padStart(11, "0");
  return internalBarcodeForPayload(payload);
}

function draftDate(savedAt: number): string {
  try {
    return toPersianDigits(formatJalali(new Date(savedAt), { withTime: true }));
  } catch {
    return "زمان نامشخص";
  }
}

function reconciliationIssueText(issue: DraftAttributeReconciliationIssue): string {
  const description = {
    definition_removed: "ویژگی از شعبه حذف شده است",
    definition_inactive: "ویژگی غیرفعال شده است",
    schema_changed: "ساختار ویژگی تغییر کرده است؛ مقدار حفظ شده است",
    option_removed: "مقدار دیگر در گزینه‌های مجاز نیست",
    unmapped_legacy_value: "نام ویژگی قدیمی با اطمینان تطبیق نیافت",
  }[issue.reason];
  return `«${issue.previousName}»: ${description}`;
}

function InlineError({ message }: { message?: string }) {
  return message ? <p className="mt-1 text-xs text-destructive">{message}</p> : null;
}

export function ProductAddSection({ draftScope }: { draftScope: string }) {
  const money = useMoney();
  const storageKey = `${DRAFTS_KEY_PREFIX}:${draftScope}`;
  const nameRef = useRef<HTMLInputElement>(null);
  const definitionLoadSequence = useRef(0);
  const definitionLoadAbort = useRef<AbortController | null>(null);
  const [form, setForm] = useState<FormState>({ ...EMPTY_FORM });
  const [tab, setTab] = useState<TabKey>("pricing");
  const [definitions, setDefinitions] = useState<AttributeDefinition[] | null>(null);
  const [loadError, setLoadError] = useState("");
  const [drafts, setDrafts] = useState<StoredDraft[]>([]);
  const [activeDraftId, setActiveDraftId] = useState<DraftId | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [issues, setIssues] = useState<ProductValidationIssue[]>([]);
  const [replacementTargets, setReplacementTargets] = useState<Record<string, string>>({});

  useEffect(() => {
    setDrafts(readDrafts(storageKey));
    setActiveDraftId(null);
  }, [storageKey]);

  const loadDefinitions = useCallback(async () => {
    const sequence = ++definitionLoadSequence.current;
    definitionLoadAbort.current?.abort();
    const controller = new AbortController();
    definitionLoadAbort.current = controller;
    setLoadError("");
    const result = await api<{ definitions: AttributeDefinition[]; error?: string }>(
      "/api/products/attributes",
      { signal: controller.signal },
    );
    if (result.aborted || sequence !== definitionLoadSequence.current) return false;
    definitionLoadAbort.current = null;
    if (result.ok && Array.isArray(result.data.definitions)) {
      const nextDefinitions = result.data.definitions;
      setDefinitions(nextDefinitions);
      setForm((current) => {
        if (Object.keys(current.definitionSnapshot).length > 0 || current.variants.length > 0) return current;
        return { ...current, definitionSnapshot: snapshotAttributeDefinitions(nextDefinitions) };
      });
      return true;
    }
    setDefinitions((current) => current ?? []);
    setLoadError(result.data.error === "forbidden"
      ? "برای ساخت تنوع، اجازهٔ مشاهدهٔ ویژگی‌های محصول لازم است."
      : "ویژگی‌های محصول بارگیری نشد. اطلاعات پیش‌نویس حفظ شده است؛ دوباره تلاش کنید.");
    return false;
  }, []);
  useEffect(() => {
    void loadDefinitions();
    return () => {
      definitionLoadSequence.current += 1;
      definitionLoadAbort.current?.abort();
    };
  }, [loadDefinitions]);

  const fieldErrors = useMemo(() => {
    const result = new Map<string, string>();
    issues.forEach((entry) => {
      if (!result.has(entry.field)) result.set(entry.field, entry.message);
    });
    return result;
  }, [issues]);
  const activeDefinitions = useMemo(
    () => (definitions ?? []).filter((definition) => definition.isActive),
    [definitions],
  );
  const reconciliationIssues = useMemo(
    () => draftAttributeReconciliationIssues(form.variants, form.definitionSnapshot, definitions ?? []),
    [definitions, form.definitionSnapshot, form.variants],
  );
  const requiresSchemaReview = reconciliationIssues.some((entry) => entry.reason === "schema_changed");

  function clearFeedback() {
    setError("");
    setNotice("");
    setIssues([]);
  }

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    clearFeedback();
    setForm((current) => ({ ...current, [key]: value }));
  };

  function setVariant(variantId: DraftId, patch: Partial<VariantDraft>) {
    clearFeedback();
    setForm((current) => ({
      ...current,
      variants: current.variants.map((variant) =>
        variant.id === variantId ? { ...variant, ...patch } : variant,
      ),
    }));
  }

  function persistDrafts(next: StoredDraft[]) {
    const limited = next.slice(0, MAX_DRAFTS);
    setDrafts(limited);
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(limited));
    } catch {
      // Private browsing/storage quota: keep drafts for this mounted session.
    }
  }

  function upsertCurrentDraft(source: StoredDraft[]): { drafts: StoredDraft[]; id: DraftId } {
    const now = Date.now();
    const id = activeDraftId ?? uniqueId("draft");
    const snapshot: StoredDraft = { id, savedAt: now, form };
    return {
      id,
      drafts: [snapshot, ...source.filter((draft) => draft.id !== id)].slice(0, MAX_DRAFTS),
    };
  }

  function resetForm(message?: string) {
    setForm({ ...EMPTY_FORM, definitionSnapshot: snapshotAttributeDefinitions(definitions ?? []) });
    setReplacementTargets({});
    setActiveDraftId(null);
    setTab("pricing");
    setError("");
    setIssues([]);
    if (message) setNotice(message);
    requestAnimationFrame(() => nameRef.current?.focus());
  }

  function stashDraft() {
    if (!hasContent(form)) {
      setError("فرم خالی است؛ ابتدا بخشی از اطلاعات محصول را وارد کنید.");
      return;
    }
    const result = upsertCurrentDraft(drafts);
    persistDrafts(result.drafts);
    resetForm(activeDraftId === null ? "پیش‌نویس ذخیره شد و فرم تازه آماده است." : "تغییرات پیش‌نویس ذخیره شد.");
  }

  function openDraft(draft: StoredDraft) {
    if (activeDraftId === draft.id) return;
    let next = drafts;
    if (hasContent(form)) next = upsertCurrentDraft(next).drafts;
    // Keep the requested draft even when auto-saving a tenth current draft.
    if (!next.some((entry) => entry.id === draft.id)) next = [draft, ...next].slice(0, MAX_DRAFTS);
    persistDrafts(next);
    const restored = safeForm(draft.form);
    restored.variants = migrateDraftAttributeValues(restored.variants, definitions ?? []);
    if (Object.keys(restored.definitionSnapshot).length === 0) {
      restored.definitionSnapshot = snapshotAttributeDefinitions(definitions ?? []);
    }
    setForm(restored);
    setReplacementTargets({});
    setActiveDraftId(draft.id);
    setError("");
    setNotice(hasContent(form) ? "فرم قبلی خودکار به‌صورت پیش‌نویس ذخیره شد." : "پیش‌نویس برای ویرایش باز شد.");
    setIssues([]);
  }

  function removeDraft(draftId: DraftId) {
    persistDrafts(drafts.filter((draft) => draft.id !== draftId));
    if (activeDraftId === draftId) setActiveDraftId(null);
  }

  function removeVariantRow(variantId: DraftId) {
    const removed = form.variants.find((variant) => variant.id === variantId);
    const finalVariant = form.variants.length === 1 ? removed : undefined;
    clearFeedback();
    setForm((current) => ({
      ...current,
      barcode: finalVariant?.barcode || current.barcode,
      autoBarcode: finalVariant?.barcode ? finalVariant.autoBarcode : current.autoBarcode,
      variants: current.variants.filter((variant) => variant.id !== variantId),
    }));
    if (finalVariant?.barcode) {
      setNotice("بارکد آخرین تنوع به محصول ساده برگردانده شد.");
    }
  }

  function addVariantRow() {
    const firstVariant = form.variants.length === 0;
    const movedBarcode = firstVariant ? form.barcode : "";
    setForm((current) => ({
      ...current,
      barcode: firstVariant ? "" : current.barcode,
      autoBarcode: firstVariant ? false : current.autoBarcode,
      variants: [
        ...current.variants,
        {
          id: uniqueId("variant"),
          values: {},
          unresolvedValues: {},
          sku: "",
          barcode: movedBarcode,
          autoBarcode: firstVariant ? current.autoBarcode : false,
          sellPrice: "",
          purchasePrice: "",
          quantity: "",
        },
      ],
    }));
    clearFeedback();
    if (movedBarcode) setNotice("بارکد محصول به تنوع اول منتقل شد؛ هر تنوع باید بارکد خودش را داشته باشد.");
  }

  function acknowledgeDefinitionChanges() {
    setForm((current) => ({
      ...current,
      definitionSnapshot: snapshotAttributeDefinitions(definitions ?? []),
    }));
    setError("");
    setNotice("ساختار تازهٔ ویژگی‌ها ثبت شد؛ مقدارهای پیش‌نویس حفظ شدند و گزینه‌های نامعتبر هنوز نیاز به اصلاح دارند.");
  }

  function replacementKey(variantId: DraftId, source: string, sourceKey: string): string {
    return JSON.stringify([String(variantId), source, sourceKey]);
  }

  function repairDraftValue(
    issue: (typeof reconciliationIssues)[number],
    action: "replace" | "remove",
  ) {
    const variant = form.variants.find((entry) => entry.id === issue.variantId);
    if (!variant) return;
    if (action === "replace") {
      const targetId = replacementTargets[replacementKey(issue.variantId, issue.source, issue.sourceKey)];
      const target = activeDefinitions.find((entry) => entry.id === targetId);
      if (!target) {
        setError("برای جایگزینی، یک ویژگی فعال انتخاب کنید.");
        return;
      }
      if (variant.values[target.id]?.trim()) {
        setError(`ویژگی «${target.name}» همین حالا برای این تنوع مقدار دارد؛ آن مقدار را جداگانه تغییر دهید.`);
        return;
      }
      setForm((current) => ({
        ...current,
        variants: current.variants.map((entry) => {
          if (entry.id !== issue.variantId) return entry;
          const values = { ...entry.values, [target.id]: issue.value };
          const unresolvedValues = { ...entry.unresolvedValues };
          if (issue.source === "values") delete values[issue.sourceKey];
          else delete unresolvedValues[issue.sourceKey];
          return { ...entry, values, unresolvedValues };
        }),
      }));
      setNotice(`مقدار قدیمی «${issue.previousName}» با ویژگی فعال «${target.name}» تطبیق داده شد.`);
    } else {
      setForm((current) => ({
        ...current,
        variants: current.variants.map((entry) => {
          if (entry.id !== issue.variantId) return entry;
          const values = { ...entry.values };
          const unresolvedValues = { ...entry.unresolvedValues };
          if (issue.source === "values") delete values[issue.sourceKey];
          else delete unresolvedValues[issue.sourceKey];
          return { ...entry, values, unresolvedValues };
        }),
      }));
      setNotice(`مقدار قدیمی «${issue.previousName}» از پیش‌نویس حذف شد.`);
    }
    setReplacementTargets((current) => {
      const next = { ...current };
      delete next[replacementKey(issue.variantId, issue.source, issue.sourceKey)];
      return next;
    });
    setError("");
    setIssues([]);
  }

  function priceToRial(value: string): string | null {
    if (!value.trim()) return null;
    try {
      return money.parseText(value);
    } catch {
      return value;
    }
  }

  function requestPayload() {
    const definitionsById = new Map((definitions ?? []).map((definition) => [definition.id, definition]));
    return {
      name: form.name,
      sku: form.sku || null,
      barcode: form.barcode || null,
      isSellable: !form.notSellable,
      unit: form.unit || null,
      subUnit: form.subUnit || null,
      conversionFactor: form.conversionFactor || null,
      minOrderQty: form.minOrder || null,
      reorderReminderQty: form.reorderReminder || null,
      leadTimeDays: form.leadTimeDays || null,
      storageLocation: form.storageLocation || null,
      taxSalePercent: form.taxSalePercent || null,
      taxPurchasePercent: form.taxPurchasePercent || null,
      sellPrice: priceToRial(form.sellPrice),
      purchasePrice: priceToRial(form.purchasePrice),
      quantity: form.quantity || null,
      variants: form.variants.map((variant) => ({
        sku: variant.sku || null,
        barcode: variant.barcode || null,
        sellPrice: priceToRial(variant.sellPrice),
        purchasePrice: priceToRial(variant.purchasePrice),
        quantity: variant.quantity || null,
        attributes: Object.entries(variant.values)
          .filter(([, value]) => value.trim())
          .map(([definitionId, value]) => ({
            definitionId,
            name: definitionsById.get(definitionId)?.name ?? form.definitionSnapshot[definitionId]?.name ?? definitionId,
            value,
          })),
      })),
    };
  }

  function showIssues(nextIssues: ProductValidationIssue[]) {
    setIssues(nextIssues);
    const first = nextIssues[0];
    const remaining = nextIssues.length - 1;
    setError(
      first
        ? `${first.message}${remaining > 0 ? ` (${toPersianDigits(remaining)} مورد دیگر را هم بررسی کنید.)` : ""}`
        : "اطلاعات محصول معتبر نیست.",
    );
    const targetTab = first ? SECTION_TO_TAB[first.section] : undefined;
    if (targetTab) setTab(targetTab);
    if (first?.section === "base") requestAnimationFrame(() => nameRef.current?.focus());
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    if (form.variants.length > 0 && loadError) {
      setTab("attributes");
      setError("تعریف‌های ویژگی هنوز بارگیری نشده‌اند. اتصال را تازه کنید تا مقدارهای تنوع بدون حذف یا تغییر ناخواسته بررسی شوند.");
      return;
    }
    if (reconciliationIssues.length > 0) {
      setTab("attributes");
      setError("ویژگی‌های پیش‌نویس با ساختار فعلی شعبه نیاز به بازبینی دارند؛ مقدارها حفظ شده‌اند و تا اصلاح، ثبت انجام نمی‌شود.");
      return;
    }

    const parsed = parseProductCreateInput(requestPayload());
    if (!parsed.ok) {
      setNotice("");
      showIssues(parsed.issues);
      return;
    }

    setBusy(true);
    setError("");
    setNotice("");
    setIssues([]);
    const result = await api<{
      error?: string;
      message?: string;
      issues?: ProductValidationIssue[];
    }>("/api/products/items", {
      method: "POST",
      body: JSON.stringify(parsed.data),
    });
    setBusy(false);

    if (!result.ok) {
      if (Array.isArray(result.data.issues) && result.data.issues.length > 0) {
        const attributeSchemaChanged = result.data.issues.some((entry) => [
          "unknown_attribute_definition",
          "inactive_attribute_definition",
          "invalid_attribute_value",
          "ambiguous_attribute",
        ].includes(entry.code));
        if (attributeSchemaChanged) {
          await loadDefinitions();
          setTab("attributes");
          setNotice("ساختار ویژگی‌ها از زمان بارگیری فرم تغییر کرده است؛ مقدارهای این پیش‌نویس حفظ شده‌اند و اکنون می‌توانید آن‌ها را بازبینی کنید.");
        }
        showIssues(result.data.issues);
      } else if (result.data.error === "duplicate_barcode") {
        setTab(form.variants.length > 0 ? "attributes" : tab);
        setError(result.data.message ?? "این بارکد قبلاً برای محصول دیگری ثبت شده است.");
      } else if (result.data.error === "no_location") {
        setError("برای ثبت محصول باید یک شعبهٔ فعال داشته باشید.");
      } else if (result.data.error === "network_error") {
        setError("ارتباط با سرور برقرار نشد. اطلاعات فرم حفظ شده است؛ دوباره تلاش کنید.");
      } else {
        setError(result.data.message ?? "محصول ذخیره نشد. اطلاعات فرم حفظ شده است؛ دوباره تلاش کنید.");
      }
      return;
    }

    if (activeDraftId !== null) {
      persistDrafts(drafts.filter((draft) => draft.id !== activeDraftId));
    }
    resetForm("محصول با موفقیت ذخیره شد. می‌توانید محصول بعدی را ثبت کنید.");
  }

  if (definitions === null) {
    return (
      <div className="min-w-0 space-y-4">
        <SectionCardSkeleton rows={6} label="در حال آماده‌سازی فرم محصول" />
      </div>
    );
  }

  const commonPricingHint =
    form.variants.length > 0
      ? "این مقدار پیش‌فرض همهٔ تنوع‌هاست؛ در کارت هر تنوع می‌توانید آن را تغییر دهید."
      : "مبلغ و موجودی آغازین همین محصول را وارد کنید.";
  const recommendation = (() => {
    try {
      return recommendRetailPrice({
        purchaseCostRial: form.purchasePrice.trim() ? money.parseText(form.purchasePrice) : null,
        fixedOverheadRial: form.calculatorFixedOverhead.trim() ? money.parseText(form.calculatorFixedOverhead) : "0",
        overheadPercent: normalizeNumericText(form.calculatorOverheadPercent, { grouping: false }) || "0",
        targetPercent: normalizeNumericText(form.calculatorTargetPercent, { grouping: false }) || "0",
        targetMode: form.calculatorTargetMode,
      });
    } catch {
      return { ok: false as const, error: "invalid_amount" as const };
    }
  })();

  const actionButtons = (
    <>
      <Button type="submit" form="product-add-form" disabled={busy} size="lg" className="w-full font-semibold">
        <SaveIcon aria-hidden="true" className="size-4" />
        {busy ? "در حال ثبت…" : form.variants.length > 0 ? "ثبت محصول و تنوع‌ها" : "ثبت محصول"}
      </Button>
      <Button
        type="button"
        variant="outline"
        className="w-full"
        disabled={busy || !hasContent(form)}
        onClick={stashDraft}
      >
        <RotateCcwIcon aria-hidden="true" className="size-4" />
        ذخیره پیش‌نویس و فرم جدید
      </Button>
    </>
  );

  return (
    <div className="grid min-w-0 items-start gap-4 lg:grid-cols-[minmax(0,1fr)_19rem] lg:gap-5">
      <form id="product-add-form" noValidate onSubmit={save} className="min-w-0 space-y-4">
        <div aria-live="assertive">
          <ErrorBox>{error}</ErrorBox>
        </div>
        {notice ? (
          <div
            role="status"
            className="flex items-start gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-3 text-sm text-emerald-900 dark:border-emerald-500/30 dark:bg-emerald-500/20 dark:text-emerald-100"
          >
            <CheckCircle2Icon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            <p>
              {notice}{" "}
              {notice.startsWith("محصول با موفقیت") ? (
                <Link href={accountingProductsHref()} className="font-semibold text-primary underline-offset-4 hover:underline">
                  مشاهدهٔ فهرست محصولات
                </Link>
              ) : null}
            </p>
          </div>
        ) : null}
        {loadError ? (
          <div role="alert" className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-destructive/30 bg-destructive/5 px-3 py-3 text-sm text-destructive">
            <p>{loadError}</p>
            <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void loadDefinitions()}>
              تلاش دوباره
            </Button>
          </div>
        ) : null}
        {reconciliationIssues.length > 0 ? (
          <section role="alert" className="space-y-2 rounded-xl border border-amber-300 bg-amber-50 px-3 py-3 text-sm text-amber-950 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-100">
            <p className="font-semibold">مقدارهای تنوع این پیش‌نویس تغییر نکرده‌اند؛ پیش از ثبت باید تعریف‌های شعبه را بازبینی کنید.</p>
            <ul className="list-inside list-disc space-y-1 text-xs">
              {reconciliationIssues.slice(0, 5).map((entry, index) => (
                <li key={`${entry.variantId}-${entry.source}-${entry.sourceKey}-${entry.reason}-${index}`}>
                  تنوع {toPersianDigits(form.variants.findIndex((variant) => variant.id === entry.variantId) + 1)} · {reconciliationIssueText(entry)}
                </li>
              ))}
              {reconciliationIssues.length > 5 ? <li>و {toPersianDigits(reconciliationIssues.length - 5)} مورد دیگر</li> : null}
            </ul>
            {requiresSchemaReview ? (
              <Button type="button" variant="outline" size="sm" disabled={busy} onClick={acknowledgeDefinitionChanges}>
                ساختار تازه را بررسی کردم؛ مقدارها را حفظ کن
              </Button>
            ) : null}
          </section>
        ) : null}

        <fieldset disabled={busy} className="min-w-0 space-y-4 disabled:opacity-75">
          <SectionCard
            title="مشخصات اصلی"
            description="نام محصول الزامی است. کد کالا و بارکد را دستی وارد کنید یا بسازید."
          >
            <div className="grid min-w-0 gap-x-4 sm:grid-cols-2">
              <div className="sm:col-span-2">
                <Field label="نام محصول *">
                  <input
                    ref={nameRef}
                    className={inputClass}
                    value={form.name}
                    onChange={(event) => set("name", event.target.value)}
                    maxLength={200}
                    autoComplete="off"
                    aria-required="true"
                    aria-invalid={fieldErrors.has("name")}
                    placeholder="مثلاً پیراهن مردانه"
                  />
                  <InlineError message={fieldErrors.get("name")} />
                </Field>
              </div>

              <Field
                label={form.variants.length > 0 ? "بارکد خانواده" : "بارکد"}
                hint={
                  form.variants.length > 0
                    ? "برای محصول چندتنوعی، بارکد را داخل کارت هر تنوع وارد کنید."
                    : "بارکد دستی می‌تواند EAN-۱۳، UPC یا کد داخلی باشد."
                }
              >
                <input
                  className={inputClass}
                  dir="ltr"
                  value={form.barcode}
                  onChange={(event) => set("barcode", event.target.value)}
                  disabled={form.autoBarcode || form.variants.length > 0}
                  maxLength={256}
                  autoComplete="off"
                  aria-invalid={fieldErrors.has("barcode")}
                  placeholder={form.variants.length > 0 ? "برای خانواده استفاده نمی‌شود" : "اسکن یا ورود بارکد"}
                />
                <InlineError message={fieldErrors.get("barcode")} />
                {form.variants.length === 0 ? (
                  <label className="mt-2 flex min-h-9 cursor-pointer items-center gap-2 rounded-lg px-1 text-xs text-muted-foreground">
                    <input
                      type="checkbox"
                      checked={form.autoBarcode}
                      onChange={(event) => {
                        const checked = event.target.checked;
                        set("autoBarcode", checked);
                        if (checked) set("barcode", generatedBarcode());
                      }}
                      className="size-4 accent-amber-600"
                    />
                    ایجاد خودکار بارکد EAN-۱۳
                  </label>
                ) : null}
              </Field>

              <Field label="کد کالا" hint="کد کوتاه داخلی برای جستجو و گزارش‌ها">
                <input
                  className={inputClass}
                  dir="ltr"
                  value={form.sku}
                  onChange={(event) => set("sku", event.target.value)}
                  disabled={form.autoSku}
                  maxLength={100}
                  autoComplete="off"
                  aria-invalid={fieldErrors.has("sku")}
                  placeholder="مثلاً SH-10"
                />
                <InlineError message={fieldErrors.get("sku")} />
                <label className="mt-2 flex min-h-9 cursor-pointer items-center gap-2 rounded-lg px-1 text-xs text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={form.autoSku}
                    onChange={(event) => {
                      const checked = event.target.checked;
                      set("autoSku", checked);
                      if (checked) set("sku", generatedSku());
                    }}
                    className="size-4 accent-amber-600"
                  />
                  ایجاد خودکار کد کالا
                </label>
              </Field>

              <label className="flex min-h-11 cursor-pointer items-center gap-2 rounded-xl bg-muted/60 px-3 text-sm text-foreground sm:col-span-2">
                <input
                  type="checkbox"
                  checked={form.notSellable}
                  onChange={(event) => set("notSellable", event.target.checked)}
                  className="size-4 accent-amber-600"
                />
                این محصول فعلاً قابل فروش نیست
              </label>
            </div>
          </SectionCard>

          <TabBar
            idPrefix="product-add"
            label="بخش‌های فرم محصول"
            tabs={TABS}
            active={tab}
            onChange={(nextTab) => {
              setTab(nextTab);
              setError("");
            }}
          />
          <TabPanel idPrefix="product-add" active={tab}>
            {tab === "pricing" ? (
              <SectionCard title="قیمت و موجودی اولیه" description={commonPricingHint}>
                <div className="grid min-w-0 gap-x-4 sm:grid-cols-2 xl:grid-cols-3">
                  <Field label={`قیمت فروش (${money.unitLabel})`} hint="در صورت ورود، باید بیشتر از صفر باشد.">
                    <PersianNumberInput
                      value={form.sellPrice}
                      onChange={(event) => set("sellPrice", event.target.value)}
                      allowDecimal={false}
                      allowNegative={false}
                      aria-invalid={fieldErrors.has("sellPrice")}
                      placeholder="۰"
                    />
                    <InlineError message={fieldErrors.get("sellPrice")} />
                  </Field>
                  <Field label={`قیمت خرید (${money.unitLabel})`} hint="می‌تواند بدون موجودی اولیه ثبت شود.">
                    <PersianNumberInput
                      value={form.purchasePrice}
                      onChange={(event) => set("purchasePrice", event.target.value)}
                      allowDecimal={false}
                      allowNegative={false}
                      aria-invalid={fieldErrors.has("purchasePrice")}
                      placeholder="۰"
                    />
                    <InlineError message={fieldErrors.get("purchasePrice")} />
                  </Field>
                  <Field label="موجودی اولیه" hint="برای کالای شمارشی، مقدار اعشاری هم پذیرفته می‌شود.">
                    <PersianNumberInput
                      value={form.quantity}
                      onChange={(event) => set("quantity", event.target.value)}
                      inputMode="decimal"
                      allowDecimal
                      allowNegative={false}
                      aria-invalid={fieldErrors.has("quantity")}
                      placeholder="۰"
                    />
                    <InlineError message={fieldErrors.get("quantity")} />
                  </Field>
                </div>
                <div className="mt-5 rounded-xl border border-border bg-muted/30 p-4">
                  <h3 className="text-sm font-semibold">محاسبه قیمت پیشنهادی</h3>
                  <p className="mt-1 text-xs leading-6 text-muted-foreground">
                    برآورد راهنماست و مالیات را وارد بهای تمام‌شده یا سود نمی‌کند. هزینهٔ درصدی بر پایهٔ قیمت خرید محاسبه می‌شود؛ هیچ قیمتی تا انتخاب دکمهٔ اعمال تغییر نمی‌کند.
                  </p>
                  <div className="mt-4 grid min-w-0 gap-x-4 sm:grid-cols-2 xl:grid-cols-3">
                    <Field label={`سربار ثابت هر واحد (${money.unitLabel})`}>
                      <PersianNumberInput
                        value={form.calculatorFixedOverhead}
                        onChange={(event) => set("calculatorFixedOverhead", event.target.value)}
                        allowDecimal={false}
                        allowNegative={false}
                        placeholder="۰"
                      />
                    </Field>
                    <Field label="سربار درصدی از قیمت خرید (%)">
                      <PersianNumberInput
                        value={form.calculatorOverheadPercent}
                        onChange={(event) => set("calculatorOverheadPercent", event.target.value)}
                        inputMode="decimal"
                        allowDecimal
                        allowNegative={false}
                        placeholder="۰"
                      />
                    </Field>
                    <Field label="هدف سود (%)" hint={form.calculatorTargetMode === "markup" ? "درصد افزایش بر کل هزینهٔ برآوردی" : "درصد سود از قیمت فروش؛ باید کمتر از ۱۰۰ باشد"}>
                      <PersianNumberInput
                        value={form.calculatorTargetPercent}
                        onChange={(event) => set("calculatorTargetPercent", event.target.value)}
                        inputMode="decimal"
                        allowDecimal
                        allowNegative={false}
                        placeholder="۲۰"
                      />
                    </Field>
                    <Field label="روش محاسبهٔ سود">
                      <select
                        className={inputClass}
                        value={form.calculatorTargetMode}
                        onChange={(event) => set("calculatorTargetMode", event.target.value as ProfitTargetMode)}
                      >
                        <option value="markup">درصد افزایش بر هزینه (Markup)</option>
                        <option value="gross_margin">حاشیه سود از فروش (Gross margin)</option>
                      </select>
                    </Field>
                  </div>
                  {recommendation.ok ? (
                    <div className="mt-4 rounded-lg border border-border bg-card p-3" aria-live="polite">
                      <dl className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
                        <div className="flex justify-between gap-3"><dt className="text-muted-foreground">بهای خرید</dt><dd className="font-medium">{money.formatText(recommendation.value.purchaseCostRial)}</dd></div>
                        <div className="flex justify-between gap-3"><dt className="text-muted-foreground">سربار ثابت</dt><dd className="font-medium">{money.formatText(recommendation.value.fixedOverheadRial)}</dd></div>
                        <div className="flex justify-between gap-3"><dt className="text-muted-foreground">سربار درصدی (مبنای خرید)</dt><dd className="font-medium">{money.formatText(recommendation.value.percentageOverheadRial)}</dd></div>
                        <div className="flex justify-between gap-3"><dt className="text-muted-foreground">کل هزینهٔ برآوردی</dt><dd className="font-semibold">{money.formatText(recommendation.value.totalCostRial)}</dd></div>
                        <div className="flex justify-between gap-3"><dt className="text-muted-foreground">سود هدف برآوردی</dt><dd className="font-medium">{money.formatText(recommendation.value.targetProfitRial)}</dd></div>
                        <div className="flex justify-between gap-3"><dt className="text-muted-foreground">قیمت فروش پیشنهادی</dt><dd className="font-bold text-primary">{money.formatText(recommendation.value.suggestedPriceRial)}</dd></div>
                        <div className="flex justify-between gap-3"><dt className="text-muted-foreground">افزایش تحقق‌یافته بر هزینه</dt><dd>{toPersianDigits(recommendation.value.realizedMarkupPercent)}٪</dd></div>
                        <div className="flex justify-between gap-3"><dt className="text-muted-foreground">حاشیهٔ تحقق‌یافته از فروش</dt><dd>{toPersianDigits(recommendation.value.realizedMarginPercent)}٪</dd></div>
                      </dl>
                      <Button
                        type="button"
                        variant="outline"
                        className="mt-3 w-full sm:w-auto"
                        onClick={() => set("sellPrice", money.toInputText(recommendation.value.suggestedPriceRial))}
                      >
                        اعمال قیمت پیشنهادی
                      </Button>
                    </div>
                  ) : (
                    <p className="mt-3 text-xs text-muted-foreground" role={recommendation.error === "missing_cost" ? undefined : "alert"}>
                      {recommendation.error === "missing_cost" ? "برای برآورد، ابتدا قیمت خرید را وارد کنید؛ قیمت خرید می‌تواند بدون موجودی اولیه ثبت شود." : recommendation.error === "invalid_margin" ? "حاشیهٔ سود باید کمتر از ۱۰۰٪ باشد." : recommendation.error === "amount_too_large" ? "مبلغ حاصل از محاسبه بیش از حد مجاز است." : "مبلغ یا درصد واردشده معتبر نیست؛ مقدار نامنفی و قابل محاسبه وارد کنید."}
                    </p>
                  )}
                </div>
              </SectionCard>
            ) : null}

            {tab === "general" ? (
              <SectionCard
                title="واحدهای محصول"
                description="اگر واحد فرعی دارید، هر سه مقدار واحد اصلی، واحد فرعی و ضریب تبدیل را کامل کنید."
              >
                <div className="grid min-w-0 gap-x-4 sm:grid-cols-2 xl:grid-cols-3">
                  <Field label="واحد اصلی">
                    <input
                      className={inputClass}
                      value={form.unit}
                      onChange={(event) => set("unit", event.target.value)}
                      maxLength={50}
                      aria-invalid={fieldErrors.has("unit")}
                      placeholder="عدد"
                    />
                    <InlineError message={fieldErrors.get("unit")} />
                  </Field>
                  <Field label="واحد فرعی">
                    <input
                      className={inputClass}
                      value={form.subUnit}
                      onChange={(event) => set("subUnit", event.target.value)}
                      maxLength={50}
                      aria-invalid={fieldErrors.has("subUnit")}
                      placeholder="کارتن"
                    />
                    <InlineError message={fieldErrors.get("subUnit")} />
                  </Field>
                  <Field label="ضریب تبدیل" hint="مثلاً هر کارتن شامل ۲۴ عدد است.">
                    <PersianNumberInput
                      value={form.conversionFactor}
                      onChange={(event) => set("conversionFactor", event.target.value)}
                      inputMode="decimal"
                      allowDecimal
                      allowNegative={false}
                      aria-invalid={fieldErrors.has("conversionFactor")}
                      placeholder="۲۴"
                    />
                    <InlineError message={fieldErrors.get("conversionFactor")} />
                  </Field>
                </div>
              </SectionCard>
            ) : null}

            {tab === "order" ? (
              <SectionCard title="تنظیمات سفارش" description="نقطهٔ سفارش و محل نگهداری را برای برنامه‌ریزی خرید ثبت کنید.">
                <div className="grid min-w-0 gap-x-4 sm:grid-cols-2">
                  <Field label="نقطهٔ یادآوری سفارش" hint="وقتی موجودی به این مقدار رسید، یادآوری شود.">
                    <PersianNumberInput
                      value={form.reorderReminder}
                      onChange={(event) => set("reorderReminder", event.target.value)}
                      inputMode="decimal"
                      allowDecimal
                      allowNegative={false}
                      aria-invalid={fieldErrors.has("reorderReminderQty")}
                      placeholder="۵"
                    />
                    <InlineError message={fieldErrors.get("reorderReminderQty")} />
                  </Field>
                  <Field label="حداقل مقدار سفارش">
                    <PersianNumberInput
                      value={form.minOrder}
                      onChange={(event) => set("minOrder", event.target.value)}
                      inputMode="decimal"
                      allowDecimal
                      allowNegative={false}
                      aria-invalid={fieldErrors.has("minOrderQty")}
                      placeholder="۱۰"
                    />
                    <InlineError message={fieldErrors.get("minOrderQty")} />
                  </Field>
                  <Field label="زمان تحویل (روز)">
                    <PersianNumberInput
                      value={form.leadTimeDays}
                      onChange={(event) => set("leadTimeDays", event.target.value)}
                      allowDecimal={false}
                      allowNegative={false}
                      aria-invalid={fieldErrors.has("leadTimeDays")}
                      placeholder="۳"
                    />
                    <InlineError message={fieldErrors.get("leadTimeDays")} />
                  </Field>
                  <Field label="محل نگهداری کالا">
                    <input
                      className={inputClass}
                      value={form.storageLocation}
                      onChange={(event) => set("storageLocation", event.target.value)}
                      maxLength={200}
                      aria-invalid={fieldErrors.has("storageLocation")}
                      placeholder="راهرو ۱، قفسه ۲، طبقه ۳"
                    />
                    <InlineError message={fieldErrors.get("storageLocation")} />
                  </Field>
                </div>
              </SectionCard>
            ) : null}

            {tab === "tax" ? (
              <SectionCard title="مالیات" description="نرخ مالیات فروش و خرید جداگانه نگهداری می‌شود؛ این نرخ‌ها مالیات قابل پرداخت/اعتبار مالیاتی را تعیین نمی‌کنند و به‌طور خودکار به بهای موجودی یا پیشنهاد قیمت افزوده نمی‌شوند.">
                <div className="grid min-w-0 gap-x-4 sm:grid-cols-2">
                  <Field label="مالیات فروش (درصد)">
                    <PersianNumberInput
                      value={form.taxSalePercent}
                      onChange={(event) => set("taxSalePercent", event.target.value)}
                      inputMode="decimal"
                      allowDecimal
                      allowNegative={false}
                      aria-invalid={fieldErrors.has("taxSalePercent")}
                      placeholder="۱۰"
                    />
                    <InlineError message={fieldErrors.get("taxSalePercent")} />
                  </Field>
                  <Field label="مالیات خرید (درصد)">
                    <PersianNumberInput
                      value={form.taxPurchasePercent}
                      onChange={(event) => set("taxPurchasePercent", event.target.value)}
                      inputMode="decimal"
                      allowDecimal
                      allowNegative={false}
                      aria-invalid={fieldErrors.has("taxPurchasePercent")}
                      placeholder="۱۰"
                    />
                    <InlineError message={fieldErrors.get("taxPurchasePercent")} />
                  </Field>
                </div>
                <div className="mt-3 space-y-1 text-xs leading-6 text-muted-foreground">
                  <p>مالیات خرید، مالیات فروش و هزینهٔ کالا سه قلم جدا هستند. تشخیص مالیات خریدِ قابل‌بازیافت یا غیرقابل‌بازیافت تابع سیاست مالیاتی کسب‌وکار است و این فرم آن را به موجودی یا بهای تمام‌شده ثبت نمی‌کند.</p>
                  <p>این صفحه نرخ را ذخیره می‌کند؛ تنظیم قیمت شامل/غیرشامل مالیات در نمایش قیمت‌ها کنترل نمی‌شود. پیش‌نمایش قیمت پیشنهادی قبل از مالیات است و ثبت نرخ، سند مالیاتی یا تغییر قیمت ایجاد نمی‌کند.</p>
                </div>
              </SectionCard>
            ) : null}

            {tab === "attributes" ? (
              <SectionCard
                title="تنوع‌های محصول"
                description="هر تنوع یک کالای قابل فروش مستقل با ویژگی، کد، بارکد، قیمت و موجودی خودش است."
              >
                {activeDefinitions.length === 0 && form.variants.length === 0 ? (
                  <EmptyState>
                    ویژگی فعالی تعریف نشده است. ابتدا در{" "}
                    <Link href={accountingProductsHref("attributes")} className="font-semibold text-primary underline-offset-4 hover:underline">
                      ویژگی محصول
                    </Link>{" "}
                    یک ویژگی مثل رنگ یا سایز بسازید.
                  </EmptyState>
                ) : (
                  <div className="min-w-0 space-y-4">
                    {activeDefinitions.length === 0 ? (
                      <div className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-100">
                        همهٔ ویژگی‌های قبلی غیرفعال یا حذف شده‌اند. مقدارهای پیش‌نویس نگه داشته شده‌اند؛ برای فعال‌سازی یا افزودن تعریف به{" "}
                        <Link href={accountingProductsHref("attributes")} className="font-semibold underline underline-offset-4">مدیریت ویژگی‌ها</Link>{" "}
                        بروید و سپس این فرم را تازه‌سازی کنید.
                      </div>
                    ) : null}
                    {form.variants.length === 0 ? (
                      <div className="rounded-xl border border-dashed border-border px-4 py-6 text-center">
                        <Layers3Icon aria-hidden="true" className="mx-auto size-6 text-amber-700 dark:text-amber-300" />
                        <p className="mt-2 text-sm font-medium text-foreground">این محصول فعلاً ساده است.</p>
                        <p className="mt-1 text-xs leading-5 text-muted-foreground">
                          اگر رنگ، سایز یا مدل‌های جداگانه دارد، اولین تنوع را اضافه کنید.
                        </p>
                      </div>
                    ) : null}

                    {form.variants.map((variant, index) => {
                      const variantPrefix = `variants.${index}`;
                      const rowError = issues.find(
                        (entry) => entry.field.startsWith(`${variantPrefix}.attributes`) || entry.field === variantPrefix,
                      )?.message;
                      const staleAttributeIssues = reconciliationIssues.filter(
                        (entry) => entry.variantId === variant.id && [
                          "definition_removed",
                          "definition_inactive",
                          "unmapped_legacy_value",
                        ].includes(entry.reason),
                      );
                      return (
                        <section key={variant.id} className="min-w-0 rounded-xl border border-border/80 bg-muted/40 p-3 sm:p-4">
                          <div className="flex items-center justify-between gap-2 border-b border-border/80 pb-3">
                            <div className="min-w-0">
                              <h3 className="text-sm font-semibold text-foreground">تنوع {toPersianDigits(index + 1)}</h3>
                              <p className="mt-0.5 truncate text-xs text-muted-foreground">
                                {Object.values(variant.values).filter(Boolean).join("، ") || "ویژگی‌ها را انتخاب کنید"}
                              </p>
                            </div>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              className="shrink-0 text-destructive hover:bg-destructive/10 hover:text-destructive"
                              aria-label={`حذف تنوع ${toPersianDigits(index + 1)}`}
                              onClick={() => removeVariantRow(variant.id)}
                            >
                              <Trash2Icon aria-hidden="true" className="size-4" />
                            </Button>
                          </div>

                          {rowError ? <p className="mt-3 text-xs text-destructive">{rowError}</p> : null}
                          {staleAttributeIssues.length > 0 ? (
                            <div className="mt-3 space-y-2 rounded-xl border border-amber-300 bg-amber-50 p-3 dark:border-amber-500/30 dark:bg-amber-500/10">
                              <p className="text-xs font-semibold text-amber-950 dark:text-amber-100">این مقدارهای قدیمی تا انتخاب یا حذف صریح، در پیش‌نویس حفظ می‌شوند.</p>
                              {staleAttributeIssues.map((entry) => {
                                const targetKey = replacementKey(variant.id, entry.source, entry.sourceKey);
                                const existingDefinition = definitions.find((definition) => definition.id === entry.definitionId);
                                return (
                                  <div key={`${entry.source}-${entry.sourceKey}-${entry.reason}`} className="grid min-w-0 gap-2 rounded-lg bg-background/70 p-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-end">
                                    <p className="min-w-0 break-words text-xs text-foreground">
                                      {existingDefinition?.isActive === false ? "غیرفعال" : "حذف‌شده/قدیمی"} · {entry.previousName}: «{entry.value}»
                                    </p>
                                    {activeDefinitions.length > 0 ? (
                                      <Field label="جایگزینی با ویژگی فعال">
                                        <select
                                          className={inputClass}
                                          value={replacementTargets[targetKey] ?? ""}
                                          onChange={(event) => setReplacementTargets((current) => ({ ...current, [targetKey]: event.target.value }))}
                                        >
                                          <option value="">انتخاب کنید</option>
                                          {activeDefinitions.map((definition) => <option key={definition.id} value={definition.id}>{definition.name}</option>)}
                                        </select>
                                      </Field>
                                    ) : <p className="text-xs text-muted-foreground">ابتدا یک ویژگی فعال بسازید یا دوباره فعال کنید.</p>}
                                    <div className="flex gap-1 sm:justify-end">
                                      <Button type="button" size="sm" variant="outline" disabled={!replacementTargets[targetKey]} onClick={() => repairDraftValue(entry, "replace")}>
                                        تطبیق
                                      </Button>
                                      <Button type="button" size="sm" variant="ghost" className="text-destructive" onClick={() => repairDraftValue(entry, "remove")}>
                                        حذف مقدار
                                      </Button>
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          ) : null}
                          <div className="mt-3 grid min-w-0 gap-x-3 sm:grid-cols-2 xl:grid-cols-3">
                            {activeDefinitions.map((definition) => {
                              const savedValue = variant.values[definition.id] ?? "";
                              const matchingOption = definition.options.find((option) => attributeComparisonKey(option) === attributeComparisonKey(savedValue));
                              const invalidSavedOption = Boolean(savedValue && definition.options.length > 0 && !matchingOption);
                              return (
                                <Field key={definition.id} label={definition.name} as={definition.options.length > 0 ? "div" : "label"}>
                                  {invalidSavedOption ? (
                                    <p className="mb-1 text-xs text-amber-700 dark:text-amber-300">
                                      مقدار پیش‌نویس «{savedValue}» دیگر مجاز نیست؛ برای جایگزینی، گزینه‌ای انتخاب کنید.
                                    </p>
                                  ) : null}
                                  {definition.options.length > 0 ? (
                                    <SearchableSelect
                                      value={matchingOption ?? ""}
                                      onChange={(value) => setVariant(variant.id, { values: { ...variant.values, [definition.id]: value } })}
                                      options={[
                                        { value: "", label: invalidSavedOption ? "انتخاب مقدار جایگزین" : "انتخاب نشده" },
                                        ...definition.options.map((option) => ({ value: option, label: option })),
                                      ]}
                                      placeholder="انتخاب کنید"
                                      ariaLabel={`ویژگی ${definition.name} برای تنوع ${toPersianDigits(index + 1)}`}
                                    />
                                  ) : (
                                    <input
                                      className={inputClass}
                                      value={savedValue}
                                      onChange={(event) => setVariant(variant.id, { values: { ...variant.values, [definition.id]: event.target.value } })}
                                      maxLength={200}
                                    />
                                  )}
                                </Field>
                              );
                            })}

                            <Field label="کد کالا (اختیاری)">
                              <input
                                className={inputClass}
                                dir="ltr"
                                value={variant.sku}
                                onChange={(event) => setVariant(variant.id, { sku: event.target.value })}
                                maxLength={100}
                                autoComplete="off"
                                aria-invalid={fieldErrors.has(`${variantPrefix}.sku`)}
                              />
                              <InlineError message={fieldErrors.get(`${variantPrefix}.sku`)} />
                            </Field>

                            <Field label="بارکد تنوع" hint="هر بارکد در شعبه باید یکتا باشد.">
                              <input
                                className={inputClass}
                                dir="ltr"
                                value={variant.barcode}
                                onChange={(event) => setVariant(variant.id, { barcode: event.target.value })}
                                disabled={variant.autoBarcode}
                                maxLength={256}
                                autoComplete="off"
                                aria-invalid={fieldErrors.has(`${variantPrefix}.barcode`)}
                                placeholder="اسکن یا ورود بارکد"
                              />
                              <InlineError message={fieldErrors.get(`${variantPrefix}.barcode`)} />
                              <label className="mt-2 flex min-h-9 cursor-pointer items-center gap-2 rounded-lg px-1 text-xs text-muted-foreground">
                                <input
                                  type="checkbox"
                                  checked={variant.autoBarcode}
                                  onChange={(event) => {
                                    const checked = event.target.checked;
                                    setVariant(variant.id, {
                                      autoBarcode: checked,
                                      barcode: checked ? generatedBarcode() : variant.barcode,
                                    });
                                  }}
                                  className="size-4 accent-amber-600"
                                />
                                ایجاد خودکار بارکد
                              </label>
                            </Field>

                            <Field label={`قیمت فروش (${money.unitLabel})`} hint="خالی یعنی استفاده از قیمت پیش‌فرض بالا.">
                              <PersianNumberInput
                                value={variant.sellPrice}
                                onChange={(event) => setVariant(variant.id, { sellPrice: event.target.value })}
                                allowDecimal={false}
                                allowNegative={false}
                                aria-invalid={fieldErrors.has(`${variantPrefix}.sellPrice`)}
                                placeholder={form.sellPrice || "پیش‌فرض"}
                              />
                              <InlineError message={fieldErrors.get(`${variantPrefix}.sellPrice`)} />
                            </Field>
                            <Field label={`قیمت خرید (${money.unitLabel})`} hint="خالی یعنی استفاده از قیمت پیش‌فرض بالا.">
                              <PersianNumberInput
                                value={variant.purchasePrice}
                                onChange={(event) => setVariant(variant.id, { purchasePrice: event.target.value })}
                                allowDecimal={false}
                                allowNegative={false}
                                aria-invalid={fieldErrors.has(`${variantPrefix}.purchasePrice`)}
                                placeholder={form.purchasePrice || "پیش‌فرض"}
                              />
                              <InlineError message={fieldErrors.get(`${variantPrefix}.purchasePrice`)} />
                            </Field>
                            <Field label="موجودی اولیه" hint="خالی یعنی استفاده از موجودی پیش‌فرض بالا.">
                              <PersianNumberInput
                                value={variant.quantity}
                                onChange={(event) => setVariant(variant.id, { quantity: event.target.value })}
                                inputMode="decimal"
                                allowDecimal
                                allowNegative={false}
                                aria-invalid={fieldErrors.has(`${variantPrefix}.quantity`)}
                                placeholder={form.quantity || "پیش‌فرض"}
                              />
                              <InlineError message={fieldErrors.get(`${variantPrefix}.quantity`)} />
                            </Field>
                          </div>
                        </section>
                      );
                    })}

                    <Button
                      type="button"
                      variant="outline"
                      className="min-h-11 w-full border-dashed"
                      onClick={addVariantRow}
                      disabled={form.variants.length >= 100 || activeDefinitions.length === 0}
                    >
                      <PlusIcon aria-hidden="true" className="size-4" />
                      {form.variants.length >= 100 ? "حداکثر ۱۰۰ تنوع ثبت شده است" : activeDefinitions.length === 0 ? "برای تنوع، ویژگی فعال لازم است" : "افزودن تنوع"}
                    </Button>
                  </div>
                )}
              </SectionCard>
            ) : null}
          </TabPanel>
        </fieldset>

        <div className={`${cardClass} sticky bottom-3 z-20 grid gap-2 bg-card/95 p-3 backdrop-blur-sm lg:hidden`}>
          {actionButtons}
        </div>
      </form>

      <aside className="min-w-0 lg:sticky lg:top-4">
        <section className={`${cardClass} min-w-0 overflow-hidden`} aria-label="پیش‌نویس‌های محصول">
          <div className="border-b border-border/80 px-4 py-4">
            <div className="flex items-center gap-2">
              <BarcodeIcon aria-hidden="true" className="size-4 text-amber-700 dark:text-amber-300" />
              <h2 className="font-semibold text-foreground">پیش‌نویس‌ها</h2>
              <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                {toPersianDigits(drafts.length)}
              </span>
            </div>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">فقط روی همین دستگاه و برای همین شعبه نگهداری می‌شوند.</p>
          </div>

          <div className="p-3">
            {drafts.length > 0 ? (
              <ul className="max-h-[22rem] space-y-2 overflow-y-auto overscroll-contain">
                {drafts.map((draft) => {
                  const active = activeDraftId === draft.id;
                  return (
                    <li
                      key={draft.id}
                      className={`flex min-w-0 items-center gap-1 rounded-xl border px-2 py-1.5 ${
                        active
                          ? "border-amber-200 bg-amber-100 dark:border-amber-500/30 dark:bg-amber-500/20"
                          : "border-transparent bg-muted/60"
                      }`}
                    >
                      <button
                        type="button"
                        className="min-h-11 min-w-0 flex-1 px-1 text-start"
                        onClick={() => openDraft(draft)}
                        aria-current={active ? "true" : undefined}
                      >
                        <span className="block truncate text-sm font-medium text-foreground">
                          {draft.form.name.trim() || "محصول بدون نام"}
                        </span>
                        <span className="mt-0.5 block text-[11px] text-muted-foreground">
                          {active ? "در حال ویرایش · " : ""}{draftDate(draft.savedAt)}
                        </span>
                      </button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="size-10 shrink-0 text-destructive hover:bg-destructive/10 hover:text-destructive"
                        aria-label={`حذف پیش‌نویس ${draft.form.name.trim() || "بدون نام"}`}
                        onClick={() => removeDraft(draft.id)}
                      >
                        <Trash2Icon aria-hidden="true" className="size-4" />
                      </Button>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="rounded-xl border border-dashed border-border px-3 py-5 text-center text-xs leading-5 text-muted-foreground">
                پیش‌نویسی ذخیره نشده است.
              </p>
            )}
          </div>

          <div className="hidden space-y-2 border-t border-border/80 bg-muted/40 p-3 lg:block">{actionButtons}</div>
        </section>
      </aside>
    </div>
  );
}
