/**
 * Issue #1207 §C — the words the duplicate review speaks.
 *
 * The report (`duplicate-items.ts`), the plan (`duplicate-items-resolution.ts`)
 * and the script labels were written in English for an operator reading a
 * terminal. The Accounting screen in front of the owner is Persian, so the
 * screen's copy lives here: one place for the verdicts, the blockers that stop
 * an automatic archive, the reasons a candidate may be ambiguous, and the
 * reasons two rows may legitimately stay separate.
 *
 * Framework-free and DB-free, like the two modules it labels, so both the
 * service and the review panel import the same strings.
 */
import type { DuplicateItemMember, DuplicateVerdict } from "./duplicate-items";
import type { OrphanBlocker } from "./duplicate-items-resolution";

export interface DuplicateVerdictCopy {
  /** The verdict in one short phrase. */
  label: string;
  /** What the reader should do about it, in one sentence. */
  action: string;
}

export const DUPLICATE_VERDICT_COPY: Record<DuplicateVerdict, DuplicateVerdictCopy> = {
  variant_family: {
    label: "خانوادهٔ تنوع (طبیعی)",
    action: "این یک محصول اصلی و تنوع‌های خودش است؛ کاری لازم نیست.",
  },
  per_branch_copies: {
    label: "یک نسخه در هر شعبه (طبیعی)",
    action: "کالاها به‌ازای هر شعبه جدا هستند؛ این ردیف‌ها را دست نزنید.",
  },
  race_orphan: {
    label: "نسخهٔ تکراری از تلاقی ایجاد محصول",
    action: "ردیف بدون پیوند، نسخهٔ بازندهٔ ساختن هم‌زمان یک محصول فروشگاه است. اگر هیچ سابقه‌ای به آن ارجاع نمی‌دهد، بایگانی می‌شود؛ در غیر این صورت تصمیم با شماست.",
  },
  same_remote_mapped_twice: {
    label: "یک محصول فروشگاه، دو ردیف محلی",
    action: "یک محصول فروشگاه به دو ردیف محلی وصل شده است. یکی از اتصال‌ها را نگه دارید و بقیه را بایگانی کنید.",
  },
  unmapped_duplicate: {
    label: "ردیف تکراری بدون پیوند",
    action: "دست‌کم یکی از ردیف‌ها به هیچ اتصالی وصل نیست؛ خودتان تعیین کنید کدام ردیف واقعی است.",
  },
  distinct_remote_records: {
    label: "دو محصول متفاوت فروشگاه با یک کد کالا",
    action: "کد کالا را در خود فروشگاه اصلاح کنید؛ ادغام این دو ردیف اشتباه است.",
  },
};

export const ORPHAN_BLOCKER_COPY: Record<OrphanBlocker, string> = {
  twin_not_woo_product: "ردیف همتای متصل، محصول ووکامرس نیست.",
  twin_inactive: "ردیف همتای متصل، بایگانی شده است.",
  ambiguous_twin: "بیش از یک ردیف متصل می‌تواند همتای آن باشد.",
  has_references: "سابقه، موجودی یا رکورد دیگری به آن ارجاع می‌دهد.",
};

/** The stored reference tables, named the way an owner reads them. */
const REFERENCE_TABLE_COPY: Record<string, string> = {
  order_items: "ردیف سفارش",
  sale_items: "ردیف فروش",
  invoice_items: "ردیف فاکتور",
  stock_movements: "گردش موجودی",
  item_batches: "بچ کالا",
  item_serials: "شماره سریال",
  item_barcodes: "بارکد",
  product_price_history: "تاریخچهٔ قیمت",
  recipe_items: "دستور پخت",
  purchase_order_items: "ردیف خرید",
};

export function referenceTableLabel(table: string): string {
  return REFERENCE_TABLE_COPY[table] ?? table;
}

/** §C's rule in one sentence, shown on every duplicate candidate. */
export const SHARED_SKU_IS_NOT_A_MERGE_KEY =
  "کد کالای مشترک به‌تنهایی معیار ادغام نیست؛ ابتدا تفاوت‌ها را بررسی کنید.";

/**
 * Why a candidate cannot be decided automatically. Empty for the two
 * legitimate verdicts (a family, a copy per branch), which are reported but
 * never acted on.
 */
export function duplicateAmbiguityNotes(
  verdict: DuplicateVerdict,
  members: readonly DuplicateItemMember[],
): string[] {
  if (verdict === "variant_family" || verdict === "per_branch_copies") return [];
  const notes: string[] = [];
  const branches = new Set(members.map((member) => member.locationId));
  const mapped = members.filter((member) => member.mappings.length > 0);
  const unmapped = members.filter((member) => member.mappings.length === 0);
  if (branches.size > 1) notes.push("ردیف‌ها به شعبه‌های مختلف تعلق دارند.");
  if (mapped.length > 0 && unmapped.length > 0) notes.push("یک ردیف پیوند فروشگاه دارد و دیگری ندارد.");
  if (mapped.length > 1) {
    const remoteKeys = new Set(
      mapped.flatMap((member) =>
        member.mappings.map(
          (mapping) => `${mapping.entityType}|${mapping.storeKey ?? mapping.connectionId}|${mapping.remoteId}`,
        ),
      ),
    );
    notes.push(
      remoteKeys.size > 1
        ? "این ردیف‌ها به رکوردهای متفاوتی در فروشگاه وصل‌اند."
        : "بیش از یک ردیف به یک رکورد فروشگاه وصل شده است.",
    );
  }
  if (unmapped.length > 1) notes.push("بیش از یک ردیف هیچ پیوند فروشگاهی ندارد.");
  const sources = new Set(mapped.map((member) => member.mappings[0]?.provider).filter(Boolean));
  if (sources.size > 1) notes.push("ردیف‌ها از منابع متفاوت (مثلاً هلو و ووکامرس) آمده‌اند.");
  const kinds = new Set(members.map((member) => member.kind));
  if (kinds.size > 1) notes.push("ترکیب محصول اصلی و تنوع در یک کد کالا دیده می‌شود.");
  return notes;
}

/**
 * The distinctions that justify «نگهداری جداگانه». A person still decides —
 * this only names what the two rows genuinely do not share, so a true
 * different product is not merged by a screen that only knows the SKU.
 */
export function keepSeparateReasons(members: readonly DuplicateItemMember[]): string[] {
  const reasons: string[] = [];
  if (new Set(members.map((member) => member.locationId)).size > 1) {
    reasons.push("شعبه‌های متفاوت");
  }
  if (members.some((member) => member.parentItemId !== members[0].parentItemId) || members.some((member) => member.kind === "variant_child")) {
    reasons.push("خانوادهٔ تنوع متفاوت");
  }
  const providers = new Set(
    members.flatMap((member) => member.mappings.map((mapping) => mapping.provider)),
  );
  if (providers.size > 1) reasons.push("منبع‌های متفاوت");
  const stores = new Set(
    members.flatMap((member) => member.mappings.map((mapping) => mapping.connectionId)),
  );
  if (stores.size > 1) reasons.push("پیوند به فروشگاه‌های متفاوت");
  const remotes = new Set(
    members.flatMap((member) => member.mappings.map((mapping) => `${mapping.storeKey ?? mapping.connectionId}|${mapping.remoteId}`)),
  );
  if (remotes.size > 1) reasons.push("رکوردهای متفاوت در فروشگاه");
  if (members.some((member) => member.mappings.length === 0)) reasons.push("ردیف بدون پیوند (محلی)");
  return reasons;
}
