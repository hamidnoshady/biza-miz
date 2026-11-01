/**
 * Issue #908 — the built-in contract templates.
 *
 * They live in code, not in a migration, for the same reason the workspace
 * project templates do (`workspace-shared.ts`'s `BUILTIN_TEMPLATES`): no tenant
 * should need seeding to write its first contract, and a template is prose and
 * structure, not tenant data. A business's OWN templates are rows in
 * `contract_templates`; these four are the starting points the wizard offers
 * beside them.
 *
 * Two deliberate choices about the text:
 *
 *  1. **Every template says what it is.** The first block of each is a notice
 *     that this is a starting point, that the business is responsible for its
 *     own clauses, and that an electronic signature here is an ordinary
 *     intention-to-sign record — not a certified PKI certificate. The epic is
 *     explicit that an OTP + drawn signature must never be represented as
 *     something stronger than it is, and the cheapest place to keep that honest
 *     is inside the document itself.
 *  2. **Values are bindings, not literals.** Dates, amounts and names point at
 *     the contract/project/party records (`bindings.ts`), so the numbers a
 *     signer reads are the numbers the business actually holds.
 */
import { BRAND_NAME_FA } from "@/lib/brand";
import {
  normalizeContractContent,
  type ContractBlock,
  type ContractDocumentContent,
  type ContractField,
} from "./blocks";

export interface ContractTemplateDefinition {
  key: string;
  name: string;
  description: string;
  /** Matches `workspace_contracts.contract_type`. */
  contractType: "contractor" | "supplier" | "consultant" | "subcontractor" | "vendor" | "developer" | "service" | "other";
  content: ContractDocumentContent;
}

/**
 * The line that tells a signer what they are looking at. The product name comes
 * from `@/lib/brand`, never a literal: a rename is one file, and the brand
 * guard rejects a stale name anywhere in shipped sources.
 */
const SIGNING_FOOTER = `این سند در سامانهٔ «${BRAND_NAME_FA}» تنظیم و برای امضای الکترونیکی ارسال شده است.`;

/** Shorthands that keep the templates below readable. */
const heading = (id: string, text: string): ContractBlock => ({ id, type: "heading", text });
const paragraph = (id: string, text: string): ContractBlock => ({ id, type: "paragraph", text });
const article = (id: string, title: string, text: string): ContractBlock => ({
  id,
  type: "article",
  title,
  text,
});
const numbered = (id: string, items: string[]): ContractBlock => ({ id, type: "numbered", items });
const signature = (id: string, slotId: string, label: string): ContractBlock => ({
  id,
  type: "signature",
  slotId,
  label,
  caption: "نام و نام خانوادگی، تاریخ",
});

interface FieldInput {
  key: string;
  label: string;
  type: ContractField["type"];
  required?: boolean;
  binding?: { source: "contract" | "project" | "party" | "business"; path: string };
  value?: string;
  options?: string[];
}

const field = (input: FieldInput): ContractField => ({
  key: input.key,
  label: input.label,
  type: input.type,
  required: input.required ?? false,
  binding: input.binding ?? null,
  options: input.options ?? [],
  value: input.value ?? "",
});

/**
 * The fields every execution contract needs: who the parties are, what it is
 * for, what it is worth and when it runs. A template adds its own on top.
 */
const partiesAndMoney: ContractField[] = [
  field({ key: "employer_name", label: "نام کارفرما", type: "text", required: true, binding: { source: "business", path: "name" } }),
  field({ key: "counterparty_name", label: "نام طرف مقابل", type: "text", required: true, binding: { source: "party", path: "name" } }),
  field({ key: "counterparty_national_id", label: "شناسهٔ ملی طرف مقابل", type: "text", binding: { source: "party", path: "national_id" } }),
  field({ key: "contract_value", label: "مبلغ قرارداد (ریال)", type: "money", required: true, binding: { source: "contract", path: "value" } }),
  field({ key: "start_date", label: "تاریخ شروع", type: "date", required: true, binding: { source: "contract", path: "start_date" } }),
  field({ key: "end_date", label: "تاریخ پایان", type: "date", required: true, binding: { source: "contract", path: "end_date" } }),
  field({ key: "today", label: "تاریخ تنظیم", type: "date", required: true, binding: { source: "contract", path: "today" } }),
  field({ key: "business_phone", label: "تلفن کسب‌وکار", type: "text", binding: { source: "business", path: "phone" } }),
  field({ key: "business_address", label: "نشانی کسب‌وکار", type: "multiline", binding: { source: "business", path: "address" } }),
];

const projectField = (): ContractField =>
  field({ key: "project_name", label: "نام پروژه", type: "text", binding: { source: "project", path: "name" } });

const electronicSignatureNote: ContractBlock = paragraph(
  "notice_esign",
  "این سند به‌صورت الکترونیکی امضا می‌شود. امضای الکترونیکی در این سامانه شامل تأیید مشاهدهٔ همین نسخهٔ ثابت‌شدهٔ سند، تأیید شمارهٔ همراه با کد یک‌بارمصرف و ثبت امضای دست‌نویس طرفین است و به‌عنوان اعلام ارادهٔ طرفین برای انعقاد این قرارداد ثبت می‌شود. «گواهی امضای الکترونیکی» به معنای گواهی صادرشده توسط مرجع گواهی رسمی، به‌طور خودکار برای این سند صادر نمی‌شود.",
);

function blankContent(title = ""): ContractDocumentContent {
  return normalizeContractContent({
    title,
    headerText: "",
    footerText: "",
    blocks: [
      heading("b1", title || "عنوان قرارداد"),
      paragraph("b2", ""),
    ],
    fields: [],
  });
}

export const BUILTIN_CONTRACT_TEMPLATES: readonly ContractTemplateDefinition[] = [
  {
    key: "blank",
    name: "سند سفید",
    description: "از صفر بنویسید؛ بلوک‌ها، متغیرها و جای امضا را خودتان اضافه می‌کنید.",
    contractType: "other",
    content: blankContent(),
  },
  {
    key: "construction_subcontract",
    name: "پیمان اجرای کارهای ساختمانی",
    description:
      "قرارداد بین کارفرما و پیمان‌کار برای اجرای موضوع پروژه، با جدول اقساط، تعهدات پیمان‌کار و دو جای امضا.",
    contractType: "contractor",
    content: normalizeContractContent({
      title: "پیمان اجرای کارهای ساختمانی",
      headerText: "پیمان اجرای کارهای ساختمانی",
      footerText: SIGNING_FOOTER,
      fields: [
        ...partiesAndMoney,
        projectField(),
        field({ key: "project_description", label: "شرح پروژه", type: "multiline", binding: { source: "project", path: "description" } }),
        field({
          key: "subject",
          label: "موضوع قرارداد",
          type: "multiline",
          required: true,
          value: "اجرای کامل کارهای موضوع این قرارداد بر اساس مشخصات فنی، نقشه‌ها و ضمائم مورد توافق طرفین.",
        }),
        field({
          key: "payment_terms",
          label: "شرایط پرداخت",
          type: "multiline",
          value: "پرداخت بر اساس صورت‌وضعیت‌های تأییدشدهٔ کارفرما و ظرف ده روز کاری پس از تأیید انجام می‌شود.",
        }),
        field({ key: "delay_penalty", label: "وجه التزام تأخیر (شرح)", type: "text", value: "روزانه نیم درصد مبلغ قرارداد تا سقف ده درصد" }),
      ],
      blocks: [
        electronicSignatureNote,
        article("a1", "مادهٔ ۱ — طرف‌های قرارداد", "این قرارداد در تاریخ {{today}} میان {{employer_name}} به نشانی {{business_address}} (کارفرما) و {{counterparty_name}} به شناسهٔ ملی {{counterparty_national_id}} (پیمان‌کار) بسته می‌شود."),
        article("a2", "مادهٔ ۲ — موضوع قرارداد", "{{subject}} پروژهٔ موضوع این قرارداد «{{project_name}}» است: {{project_description}}"),
        article("a3", "مادهٔ ۳ — مدت اجرا", "مدت اجرای این پیمان از {{start_date}} تا {{end_date}} است و طرفین می‌توانند با توافق کتبی آن را تمدید کنند."),
        article("a4", "مادهٔ ۴ — مبلغ و اقساط", "مبلغ این قرارداد {{contract_value}} است و بر اساس صورت‌وضعیت‌های تأییدشده و جدول اقساط زیر پرداخت می‌شود."),
        {
          id: "t_installments",
          type: "table",
          caption: "جدول اقساط",
          columns: ["ردیف", "شرح", "مبلغ"],
          rows: [
            ["۱", "علی‌الحساب پیش‌پرداخت", "{{contract_value}}"],
            ["۲", "پس از تأیید صورت‌وضعیت نخست", "—"],
            ["۳", "تسویهٔ نهایی پس از تحویل موقت", "—"],
          ],
        },
        article("a5", "مادهٔ ۵ — تعهدات پیمان‌کار", "پیمان‌کار تعهد می‌دهد:"),
        numbered("n1", [
          "کارها را با مصالح و تجهیزات مطابق مشخصات فنی و اصول فنی انجام دهد.",
          "نیروی انسانی متخصص و ایمنی کارگاه را تأمین کند.",
          "برنامهٔ زمانی و گزارش پیشرفت را در فواصل توافق‌شده به کارفرما ارائه دهد.",
          "خسارت ناشی از تأخیر از {{delay_penalty}} را بپذیرد.",
        ]),
        article("a6", "مادهٔ ۶ — شرایط پرداخت", "{{payment_terms}}"),
        article("a7", "مادهٔ ۷ — فسخ", "هر طرف که به تعهدات خود عمل نکند، پس از اخطار کتبی و گذشت پانزده روز، طرف دیگر می‌تواند این قرارداد را فسخ کند."),
        article("a8", "مادهٔ ۸ — حل اختلاف", "اختلاف‌ها ابتدا از راه مذاکره و در صورت نبود توافق از طریق مراجع صالح قضایی حل می‌شود."),
        heading("s_head", "امضاها"),
        paragraph("s_note", "طرفین با امضای الکترونیکی زیر تأیید می‌کنند که متن همین نسخهٔ ثابت‌شده را خوانده و پذیرفته‌اند."),
        signature("sig_employer", "employer", "امضای کارفرما"),
        signature("sig_contractor", "contractor", "امضای پیمان‌کار"),
      ],
    }),
  },
  {
    key: "supply_goods",
    name: "قرارداد تأمین کالا",
    description: "سفارش و تحویل کالا با جدول اقلام، شرایط تحویل و دو جای امضا.",
    contractType: "supplier",
    content: normalizeContractContent({
      title: "قرارداد تأمین کالا",
      headerText: "قرارداد تأمین کالا",
      footerText: SIGNING_FOOTER,
      fields: [
        ...partiesAndMoney,
        field({ key: "goods_description", label: "شرح اقلام", type: "multiline", required: true, value: "اقلام موضوع این قرارداد مطابق فهرست پیوست و نمونهٔ تأییدشده." }),
        field({ key: "delivery_place", label: "محل تحویل", type: "text", value: "انبار خریدار" }),
        field({ key: "delivery_days", label: "مهلت تحویل (روز)", type: "number", value: "15" }),
        field({ key: "warranty", label: "مدت ضمانت", type: "text", value: "دوازده ماه از تاریخ تحویل" }),
      ],
      blocks: [
        electronicSignatureNote,
        article("a1", "مادهٔ ۱ — طرف‌ها", "این قرارداد در تاریخ {{today}} میان {{employer_name}} (خریدار) و {{counterparty_name}} (فروشنده) بسته می‌شود."),
        article("a2", "مادهٔ ۲ — موضوع", "{{goods_description}}"),
        {
          id: "t_items",
          type: "table",
          caption: "اقلام و مبالغ",
          columns: ["ردیف", "شرح", "مبلغ"],
          rows: [
            ["۱", "{{goods_description}}", "{{contract_value}}"],
          ],
        },
        article("a3", "مادهٔ ۳ — مبلغ و پرداخت", "مبلغ کل {{contract_value}} است و پس از تحویل و تأیید کیفیت، در مهلت توافق‌شده پرداخت می‌شود."),
        article("a4", "مادهٔ ۴ — تحویل", "فروشنده اقلام را حداکثر تا {{delivery_days}} روز پس از امضای این قرارداد در {{delivery_place}} تحویل می‌دهد."),
        article("a5", "مادهٔ ۵ — ضمانت", "ضمانت اقلام {{warranty}} است و شامل ایرادهای ناشی از ساخت است."),
        article("a6", "مادهٔ ۶ — مدت قرارداد", "این قرارداد از {{start_date}} تا {{end_date}} اعتبار دارد."),
        heading("s_head", "امضاها"),
        signature("sig_buyer", "buyer", "امضای خریدار"),
        signature("sig_seller", "seller", "امضای فروشنده"),
      ],
    }),
  },
  {
    key: "consulting_services",
    name: "قرارداد مشاوره",
    description: "ارائهٔ خدمات مشاوره با دامنهٔ کار، دستمزد و دو جای امضا.",
    contractType: "consultant",
    content: normalizeContractContent({
      title: "قرارداد خدمات مشاوره",
      headerText: "قرارداد خدمات مشاوره",
      footerText: SIGNING_FOOTER,
      fields: [
        ...partiesAndMoney,
        projectField(),
        field({ key: "scope", label: "دامنهٔ خدمات", type: "multiline", required: true, value: "بررسی وضعیت موجود، تهیهٔ گزارش تحلیلی و ارائهٔ راهکار اجرایی." }),
        field({ key: "deliverables", label: "خروجی‌ها", type: "multiline", value: "گزارش ماهانه، مستندات فنی و جلسهٔ ارائهٔ نهایی." }),
        field({ key: "fee_terms", label: "شرایط دستمزد", type: "multiline", value: "پرداخت ماهانه پس از ارائهٔ گزارش پیشرفت." }),
      ],
      blocks: [
        electronicSignatureNote,
        article("a1", "مادهٔ ۱ — طرف‌ها", "این قرارداد در تاریخ {{today}} میان {{employer_name}} (کارفرما) و {{counterparty_name}} (مشاور) بسته می‌شود."),
        article("a2", "مادهٔ ۲ — دامنهٔ خدمات", "{{scope}}{{project_name}}"),
        article("a3", "مادهٔ ۳ — خروجی‌ها", "{{deliverables}}"),
        article("a4", "مادهٔ ۴ — دستمزد", "دستمزد این قرارداد {{contract_value}} است. {{fee_terms}}"),
        article("a5", "مادهٔ ۵ — مدت", "این قرارداد از {{start_date}} تا {{end_date}} اعتبار دارد."),
        article("a6", "مادهٔ ۶ — محرمانگی", "مشاور متعهد است اطلاعات کارفرما را محرمانه نگه دارد و تنها برای اجرای این قرارداد از آن استفاده کند."),
        heading("s_head", "امضاها"),
        signature("sig_client", "client", "امضای کارفرما"),
        signature("sig_consultant", "consultant", "امضای مشاور"),
      ],
    }),
  },
];

export function builtinContractTemplate(key: string): ContractTemplateDefinition | null {
  return BUILTIN_CONTRACT_TEMPLATES.find((template) => template.key === key) ?? null;
}

/**
 * A fresh copy of a template's content.
 *
 * Deep-cloned because a template definition is a module-level constant: editing
 * a contract created from it must not edit the template for the next contract.
 */
export function contentFromTemplate(template: ContractTemplateDefinition, title?: string): ContractDocumentContent {
  const clone = JSON.parse(JSON.stringify(template.content)) as ContractDocumentContent;
  return normalizeContractContent({ ...clone, title: title ?? clone.title });
}

export { blankContent };
