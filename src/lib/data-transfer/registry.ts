/**
 * The entity registry — the single table every app registers its data into.
 *
 * ## The rule this file exists to enforce
 *
 * There is ONE import/export engine. A module does not get an importer; it
 * gets an *entry here*, describing its entity in the vocabulary of
 * `types.ts` — fields, types, required-ness, validation, relations, duplicate
 * rules and the two permissions that gate the directions. Everything else (the
 * mapping screen, the preview, the queue, the templates, the schedules, the
 * history, the four file formats) is written once and derived from this table.
 *
 * ## Why the definitions are here and the adapters are not
 *
 * A definition is pure data and belongs in one readable list. The *adapters* —
 * the functions that actually read and write a module's rows — live beside the
 * module's own service (`entities/*.ts`), because an imported party must go
 * through `createParty` to get its field encryption, blind index and
 * accounting code, and an imported menu item must go through the menu's own
 * upsert. A registry that wrote its own SQL would be a second, subtly
 * different writer for every table in the product, which is exactly the class
 * of bug this engine is replacing.
 *
 * Splitting them also keeps this file importable from the browser: the mapping
 * UI needs the field list, and it must not drag `pg` in with it.
 */

import type { Industry } from "../industries";
import { PERMISSIONS } from "../permissions";
import { EXPENSE_DUPLICATE_RULES } from "../expense-import";
import { EXPENSE_SETTLEMENT_LABELS, EXPENSE_SETTLEMENTS } from "../payables-input";
import type { DataModuleKey, EntityDefinition, EntityField } from "./types";

// ---------------------------------------------------------------------------
// Shared field fragments
// ---------------------------------------------------------------------------

/** The identifier column every export carries and no import writes. */
const ID_FIELD: EntityField = {
  key: "id",
  label: "شناسه",
  type: "text",
  readOnly: true,
  exportDefault: false,
  hint: "شناسهٔ داخلی سیستم؛ در ورود اطلاعات نادیده گرفته می‌شود.",
};

const CREATED_AT_FIELD: EntityField = {
  key: "createdAt",
  label: "تاریخ ایجاد",
  type: "date",
  readOnly: true,
  exportDefault: true,
};

const ACTIVE_FIELD: EntityField = {
  key: "isActive",
  label: "فعال",
  type: "boolean",
  aliases: ["active", "status", "وضعیت", "فعال بودن"],
  exportDefault: true,
};

// ---------------------------------------------------------------------------
// CRM — «ارتباط با مشتری»
// ---------------------------------------------------------------------------

const CRM_CUSTOMERS: EntityDefinition = {
  key: "crm.customers",
  module: "crm",
  label: "مشتریان",
  description: "پروندهٔ اشخاص با نقش مشتری: نام، تماس، دسته‌بندی و برچسب‌ها.",
  exportPermission: PERMISSIONS.crmExport,
  importPermission: PERMISSIONS.crmExport,
  fields: [
    ID_FIELD,
    {
      key: "name",
      label: "نام",
      type: "text",
      required: true,
      aliases: ["full name", "fullname", "نام مشتری", "مشتری", "نام کامل", "عنوان"],
      validation: { maxLength: 200 },
      exportDefault: true,
    },
    {
      key: "firstName",
      label: "نام کوچک",
      type: "text",
      aliases: ["first name", "نام کوچک"],
      validation: { maxLength: 100 },
    },
    {
      key: "lastName",
      label: "نام خانوادگی",
      type: "text",
      aliases: ["last name", "surname", "فامیلی"],
      validation: { maxLength: 100 },
    },
    {
      key: "phone",
      label: "تلفن",
      type: "phone",
      aliases: ["mobile", "موبایل", "شماره", "شمارهٔ تلفن", "شماره تماس", "همراه"],
      exportDefault: true,
    },
    {
      key: "email",
      label: "ایمیل",
      type: "email",
      aliases: ["e-mail", "پست الکترونیک", "رایانامه"],
      exportDefault: true,
    },
    {
      key: "nationalId",
      label: "کد ملی",
      type: "text",
      aliases: ["national id", "کدملی", "شمارهٔ ملی"],
      validation: { pattern: "^\\d{10}$", patternMessage: "کد ملی باید ۱۰ رقم باشد." },
    },
    {
      key: "economicCode",
      label: "کد اقتصادی",
      type: "text",
      aliases: ["economic code", "کداقتصادی"],
    },
    {
      key: "address",
      label: "نشانی",
      type: "longtext",
      aliases: ["آدرس", "محل"],
      exportDefault: true,
    },
    {
      key: "categoryName",
      label: "دستهٔ شخص",
      type: "reference",
      aliases: ["دسته", "گروه مشتری", "category"],
      relation: {
        entity: "crm.party_categories",
        lookupFields: ["name"],
        onMissing: "create",
        label: "دستهٔ شخص",
      },
      exportDefault: true,
      hint: "اگر دسته وجود نداشته باشد، بر اساس انتخاب شما ساخته یا نادیده گرفته می‌شود.",
    },
    {
      key: "tags",
      label: "برچسب‌ها",
      type: "tags",
      aliases: ["tag", "برچسب", "برچسب ها"],
      exportDefault: true,
      hint: "چند برچسب را با ویرگول از هم جدا کنید.",
    },
    {
      key: "notes",
      label: "یادداشت",
      type: "longtext",
      aliases: ["note", "توضیحات", "توضیح"],
    },
    {
      key: "accountingCode",
      label: "کد حسابداری",
      type: "text",
      aliases: ["کد حساب", "accounting code"],
      exportDefault: true,
      hint: "خالی بگذارید تا سیستم به‌صورت خودکار شماره بدهد.",
    },
    ACTIVE_FIELD,
    {
      key: "lifecycleStage",
      label: "مرحلهٔ چرخهٔ عمر",
      type: "text",
      readOnly: true,
      exportDefault: true,
    },
    {
      key: "orderCount",
      label: "تعداد خرید",
      type: "integer",
      readOnly: true,
      exportDefault: true,
    },
    {
      key: "totalSpentRial",
      label: "مجموع خرید",
      type: "money",
      readOnly: true,
      exportDefault: true,
    },
    {
      key: "lastPurchaseAt",
      label: "آخرین خرید",
      type: "date",
      readOnly: true,
      exportDefault: true,
    },
    CREATED_AT_FIELD,
  ],
  duplicateRules: [
    { key: "phone", label: "شمارهٔ تماس", fields: ["phone"] },
    { key: "email", label: "ایمیل", fields: ["email"] },
    { key: "national_id", label: "کد ملی", fields: ["nationalId"] },
    { key: "name", label: "نام", fields: ["name"] },
  ],
};

const CRM_COMPANIES: EntityDefinition = {
  key: "crm.companies",
  module: "crm",
  label: "شرکت‌ها",
  description: "اشخاص حقوقی: نام شرکت، کد اقتصادی، تماس و نشانی.",
  exportPermission: PERMISSIONS.crmExport,
  importPermission: PERMISSIONS.crmExport,
  fields: [
    ID_FIELD,
    {
      key: "name",
      label: "نام شرکت",
      type: "text",
      required: true,
      aliases: ["company", "organization", "سازمان", "شرکت", "نام"],
      validation: { maxLength: 200 },
      exportDefault: true,
    },
    {
      key: "economicCode",
      label: "کد اقتصادی",
      type: "text",
      aliases: ["economic code", "کداقتصادی"],
      exportDefault: true,
    },
    {
      key: "nationalId",
      label: "شناسهٔ ملی",
      type: "text",
      aliases: ["national id", "شناسه ملی"],
      exportDefault: true,
    },
    {
      key: "phone",
      label: "تلفن",
      type: "phone",
      aliases: ["تلفن شرکت", "شماره تماس"],
      exportDefault: true,
    },
    { key: "email", label: "ایمیل", type: "email", exportDefault: true },
    { key: "address", label: "نشانی", type: "longtext", aliases: ["آدرس"], exportDefault: true },
    {
      key: "categoryName",
      label: "دستهٔ شخص",
      type: "reference",
      aliases: ["دسته", "گروه"],
      relation: {
        entity: "crm.party_categories",
        lookupFields: ["name"],
        onMissing: "create",
        label: "دستهٔ شخص",
      },
    },
    { key: "tags", label: "برچسب‌ها", type: "tags", exportDefault: true },
    ACTIVE_FIELD,
    CREATED_AT_FIELD,
  ],
  duplicateRules: [
    { key: "economic_code", label: "کد اقتصادی", fields: ["economicCode"] },
    { key: "name", label: "نام شرکت", fields: ["name"] },
    { key: "phone", label: "شمارهٔ تماس", fields: ["phone"] },
  ],
};

const CRM_PARTY_CATEGORIES: EntityDefinition = {
  key: "crm.party_categories",
  module: "crm",
  label: "دسته‌های اشخاص",
  description: "دسته‌بندی مشتریان، تأمین‌کنندگان و کارکنان.",
  exportPermission: PERMISSIONS.partiesView,
  importPermission: PERMISSIONS.partiesManage,
  fields: [
    ID_FIELD,
    {
      key: "name",
      label: "نام دسته",
      type: "text",
      required: true,
      aliases: ["دسته", "عنوان", "category"],
      validation: { maxLength: 120 },
      exportDefault: true,
    },
    {
      key: "role",
      label: "نقش",
      type: "enum",
      options: [
        { value: "customer", label: "مشتری" },
        { value: "supplier", label: "تأمین‌کننده" },
        { value: "employee", label: "کارمند" },
      ],
      aliases: ["نوع"],
      exportDefault: true,
    },
    { key: "sortOrder", label: "ترتیب", type: "integer", aliases: ["ترتیب نمایش"] },
    ACTIVE_FIELD,
  ],
  duplicateRules: [{ key: "name", label: "نام دسته", fields: ["name"] }],
};

const CRM_LEADS: EntityDefinition = {
  key: "crm.leads",
  module: "crm",
  label: "سرنخ‌ها",
  description: "سرنخ‌های فروش: نام، سازمان، تماس، منبع و وضعیت.",
  exportPermission: PERMISSIONS.crmExport,
  importPermission: PERMISSIONS.crmExport,
  fields: [
    ID_FIELD,
    {
      key: "name",
      label: "نام",
      type: "text",
      required: true,
      aliases: ["نام سرنخ", "lead"],
      validation: { maxLength: 200 },
      exportDefault: true,
    },
    {
      key: "organization",
      label: "سازمان",
      type: "text",
      aliases: ["company", "شرکت"],
      exportDefault: true,
    },
    { key: "phone", label: "تلفن", type: "phone", aliases: ["موبایل"], exportDefault: true },
    { key: "email", label: "ایمیل", type: "email", exportDefault: true },
    {
      key: "source",
      label: "منبع",
      type: "text",
      aliases: ["راه آشنایی", "کانال"],
      exportDefault: true,
    },
    {
      key: "status",
      label: "وضعیت",
      type: "enum",
      options: [
        { value: "new", label: "جدید" },
        { value: "working", label: "در حال پیگیری" },
        { value: "qualified", label: "واجد شرایط" },
        { value: "disqualified", label: "رد شده" },
        { value: "converted", label: "تبدیل شده" },
      ],
      exportDefault: true,
    },
    {
      key: "rating",
      label: "درجه",
      type: "enum",
      options: [
        { value: "hot", label: "داغ" },
        { value: "warm", label: "گرم" },
        { value: "cold", label: "سرد" },
      ],
      exportDefault: true,
    },
    { key: "notes", label: "یادداشت", type: "longtext", aliases: ["توضیحات"] },
    CREATED_AT_FIELD,
  ],
  duplicateRules: [
    { key: "phone", label: "شمارهٔ تماس", fields: ["phone"] },
    { key: "email", label: "ایمیل", fields: ["email"] },
    { key: "name_org", label: "نام و سازمان", fields: ["name", "organization"] },
  ],
};

const CRM_DEALS: EntityDefinition = {
  key: "crm.deals",
  module: "crm",
  label: "معامله‌ها",
  description: "فرصت‌های فروش: عنوان، مشتری، مبلغ، مرحله و تاریخ بسته‌شدن.",
  exportPermission: PERMISSIONS.crmExport,
  importPermission: PERMISSIONS.crmExport,
  fields: [
    ID_FIELD,
    {
      key: "title",
      label: "عنوان",
      type: "text",
      required: true,
      aliases: ["نام معامله", "deal", "موضوع"],
      validation: { maxLength: 200 },
      exportDefault: true,
    },
    {
      key: "customerName",
      label: "مشتری",
      type: "reference",
      aliases: ["نام مشتری", "customer", "طرف حساب"],
      relation: {
        entity: "crm.customers",
        lookupFields: ["name", "phone", "email"],
        // A deal is a commitment against a real customer; inventing one to
        // hang a number off is worse than refusing the row.
        onMissing: "skip",
        label: "مشتری",
      },
      exportDefault: true,
    },
    {
      key: "valueRial",
      label: "مبلغ",
      type: "money",
      aliases: ["ارزش", "مبلغ معامله", "value"],
      exportDefault: true,
    },
    {
      key: "stageName",
      label: "مرحله",
      type: "reference",
      aliases: ["stage", "وضعیت", "مرحلهٔ قیف"],
      relation: {
        entity: "crm.pipeline_stages",
        lookupFields: ["name"],
        // A stage nobody defined is a reporting hole; import it into the
        // pipeline's first stage and say so.
        onMissing: "warn",
        label: "مرحلهٔ قیف فروش",
      },
      exportDefault: true,
    },
    {
      key: "probability",
      label: "احتمال (٪)",
      type: "integer",
      validation: { min: 0, max: 100 },
      exportDefault: true,
    },
    {
      key: "expectedCloseDate",
      label: "تاریخ بسته‌شدن پیش‌بینی‌شده",
      type: "date",
      aliases: ["تاریخ بسته شدن", "close date"],
      exportDefault: true,
    },
    { key: "ownerUser", label: "مسئول", type: "text", aliases: ["owner", "کارشناس"] },
    { key: "description", label: "توضیحات", type: "longtext" },
    { key: "tags", label: "برچسب‌ها", type: "tags" },
    CREATED_AT_FIELD,
  ],
  duplicateRules: [
    { key: "title_customer", label: "عنوان و مشتری", fields: ["title", "customerName"] },
    { key: "title", label: "عنوان", fields: ["title"] },
  ],
};

const CRM_ACTIVITIES: EntityDefinition = {
  key: "crm.activities",
  module: "crm",
  label: "فعالیت‌ها",
  description: "تماس‌ها، جلسه‌ها، یادداشت‌ها و کارهای پیگیری.",
  exportPermission: PERMISSIONS.crmView,
  importPermission: PERMISSIONS.crmManage,
  fields: [
    ID_FIELD,
    {
      key: "subject",
      label: "موضوع",
      type: "text",
      required: true,
      aliases: ["عنوان", "subject"],
      validation: { maxLength: 200 },
      exportDefault: true,
    },
    {
      key: "kind",
      label: "نوع",
      type: "enum",
      required: true,
      options: [
        { value: "call", label: "تماس" },
        { value: "meeting", label: "جلسه" },
        { value: "note", label: "یادداشت" },
        { value: "task", label: "کار" },
        { value: "email", label: "ایمیل" },
      ],
      exportDefault: true,
    },
    {
      key: "customerName",
      label: "مشتری",
      type: "reference",
      aliases: ["طرف حساب", "customer"],
      relation: {
        entity: "crm.customers",
        lookupFields: ["name", "phone", "email"],
        onMissing: "warn",
        label: "مشتری",
      },
      exportDefault: true,
    },
    { key: "body", label: "شرح", type: "longtext", aliases: ["توضیحات", "متن"], exportDefault: true },
    { key: "dueAt", label: "موعد", type: "date", aliases: ["تاریخ سررسید"], exportDefault: true },
    {
      key: "priority",
      label: "اولویت",
      type: "enum",
      options: [
        { value: "low", label: "کم" },
        { value: "normal", label: "عادی" },
        { value: "high", label: "زیاد" },
      ],
      exportDefault: true,
    },
    { key: "assignedTo", label: "مسئول", type: "text", aliases: ["کارشناس"], exportDefault: true },
    { key: "completedAt", label: "تاریخ انجام", type: "date", readOnly: true, exportDefault: true },
    CREATED_AT_FIELD,
  ],
  duplicateRules: [
    { key: "subject_customer", label: "موضوع و مشتری", fields: ["subject", "customerName"] },
  ],
};

const CRM_PIPELINE_STAGES: EntityDefinition = {
  key: "crm.pipeline_stages",
  module: "crm",
  label: "مراحل قیف فروش",
  description: "مراحل هر قیف فروش و احتمال پیش‌فرض هر مرحله.",
  exportPermission: PERMISSIONS.crmView,
  importPermission: PERMISSIONS.crmConfigure,
  fields: [
    ID_FIELD,
    {
      key: "name",
      label: "نام مرحله",
      type: "text",
      required: true,
      aliases: ["مرحله", "stage"],
      exportDefault: true,
    },
    { key: "pipelineName", label: "قیف فروش", type: "text", readOnly: true, exportDefault: true },
    {
      key: "defaultProbability",
      label: "احتمال پیش‌فرض (٪)",
      type: "integer",
      validation: { min: 0, max: 100 },
      exportDefault: true,
    },
    { key: "displayOrder", label: "ترتیب", type: "integer", exportDefault: true },
    ACTIVE_FIELD,
  ],
  duplicateRules: [{ key: "name", label: "نام مرحله", fields: ["name"] }],
};

// ---------------------------------------------------------------------------
// POS — «فروش و صندوق»
// ---------------------------------------------------------------------------

const POS_CATEGORIES: EntityDefinition = {
  key: "pos.categories",
  module: "pos",
  label: "دسته‌های منو",
  description: "دسته‌بندی آیتم‌های منو و نرخ مالیات هر دسته.",
  exportPermission: PERMISSIONS.menuView,
  importPermission: PERMISSIONS.menuEdit,
  locationScoped: true,
  requiresModule: "menu",
  fields: [
    ID_FIELD,
    {
      key: "name",
      label: "نام دسته",
      type: "text",
      required: true,
      aliases: ["دسته", "دسته‌بندی", "گروه", "category"],
      validation: { maxLength: 120 },
      exportDefault: true,
    },
    {
      key: "taxRate",
      label: "نرخ مالیات (٪)",
      type: "number",
      aliases: ["مالیات", "نرخ مالیات", "درصد مالیات", "tax"],
      validation: { min: 0, max: 100 },
      exportDefault: true,
    },
    { key: "sortOrder", label: "ترتیب", type: "integer", aliases: ["ترتیب نمایش"] },
    ACTIVE_FIELD,
  ],
  duplicateRules: [{ key: "name", label: "نام دسته", fields: ["name"] }],
};

const POS_PRODUCTS: EntityDefinition = {
  key: "pos.products",
  module: "pos",
  label: "آیتم‌های منو",
  description: "آیتم‌های فروش صندوق: نام، دسته، قیمت و کد کالا.",
  exportPermission: PERMISSIONS.menuView,
  importPermission: PERMISSIONS.menuEdit,
  locationScoped: true,
  requiresModule: "menu",
  fields: [
    ID_FIELD,
    {
      key: "name",
      label: "نام آیتم",
      type: "text",
      required: true,
      aliases: ["نام", "کالا", "آیتم", "محصول", "item", "product"],
      validation: { maxLength: 200 },
      exportDefault: true,
    },
    {
      key: "categoryName",
      label: "دسته",
      type: "reference",
      required: true,
      aliases: ["دسته‌بندی", "گروه", "category"],
      relation: {
        entity: "pos.categories",
        lookupFields: ["name"],
        // A category is a label the operator owns — creating «نوشیدنی گرم»
        // because the file mentions it is what they expect.
        onMissing: "create",
        label: "دستهٔ منو",
      },
      exportDefault: true,
    },
    {
      key: "price",
      label: "قیمت",
      type: "money",
      required: true,
      aliases: ["قیمت فروش", "مبلغ", "price"],
      exportDefault: true,
    },
    {
      key: "sku",
      label: "کد کالا",
      type: "text",
      aliases: ["کد", "sku", "code", "کد محصول"],
      exportDefault: true,
    },
    { key: "description", label: "توضیحات", type: "longtext", aliases: ["توضیح"], exportDefault: true },
    {
      key: "imageUrl",
      label: "لینک تصویر",
      type: "text",
      aliases: ["تصویر", "عکس", "image", "img"],
      validation: { maxLength: 2000 },
      exportDefault: true,
    },
    {
      key: "imageMediaId",
      label: "شناسهٔ رسانهٔ تصویر",
      type: "text",
      aliases: ["رسانه", "media id", "image_media_id"],
      hint:
        "شناسهٔ دارایی در کتابخانهٔ رسانه. در ورود، اگر در این کسب‌وکار موجود نباشد با هشدار نادیده گرفته می‌شود.",
      exportDefault: true,
    },
    {
      key: "targetMarginPercent",
      label: "حاشیهٔ سود هدف (٪)",
      type: "number",
      aliases: ["حاشیه سود", "margin", "حاشیه"],
      validation: { min: 0, max: 100 },
      exportDefault: true,
    },
    { key: "sortOrder", label: "ترتیب", type: "integer" },
    ACTIVE_FIELD,
    CREATED_AT_FIELD,
  ],
  duplicateRules: [
    { key: "sku", label: "کد کالا", fields: ["sku"] },
    { key: "name_category", label: "نام و دسته", fields: ["name", "categoryName"] },
    { key: "name", label: "نام آیتم", fields: ["name"] },
  ],
};

/**
 * Item ↔ modifier-group attachments (issue #844 parity): per-item min/max
 * overrides, per-item link order and the link's own active state — the facts
 * a flat items/modifiers export could not represent.
 */
const POS_ITEM_MODIFIER_GROUPS: EntityDefinition = {
  key: "pos.item_modifier_groups",
  module: "pos",
  label: "اتصال افزودنی به آیتم",
  description:
    "کدام گروه افزودنی به کدام آیتم وصل است، با حداقل/حداکثر اختصاصی، ترتیب نمایش و وضعیت پیوند.",
  exportPermission: PERMISSIONS.menuView,
  importPermission: PERMISSIONS.menuEdit,
  locationScoped: true,
  requiresModule: "menu",
  fields: [
    {
      key: "itemName",
      label: "نام آیتم",
      type: "text",
      required: true,
      aliases: ["آیتم", "محصول", "item", "نام محصول"],
      exportDefault: true,
    },
    {
      key: "itemSku",
      label: "کد کالا",
      type: "text",
      aliases: ["کد", "sku"],
      exportDefault: true,
      hint: "در صورت وجود، مرجع اصلی آیتم است؛ در غیر این صورت از نام استفاده می‌شود.",
    },
    {
      key: "groupName",
      label: "گروه افزودنی",
      type: "text",
      required: true,
      aliases: ["گروه", "افزودنی", "modifier group"],
      exportDefault: true,
    },
    {
      key: "minSelectOverride",
      label: "حداقل انتخاب (اختصاصی)",
      type: "integer",
      aliases: ["حداقل", "min"],
      validation: { min: 0 },
    },
    {
      key: "maxSelectOverride",
      label: "حداکثر انتخاب (اختصاصی)",
      type: "integer",
      aliases: ["حداکثر", "max"],
      validation: { min: 0 },
    },
    { key: "sortOrder", label: "ترتیب نمایش در آیتم", type: "integer", exportDefault: true },
    ACTIVE_FIELD,
  ],
  duplicateRules: [
    { key: "item_group", label: "آیتم و گروه", fields: ["itemName", "groupName"] },
  ],
};

const POS_MODIFIERS: EntityDefinition = {
  key: "pos.modifiers",
  module: "pos",
  label: "افزودنی‌ها",
  description: "گروه‌های افزودنی و گزینه‌های هر گروه، با اختلاف قیمت.",
  exportPermission: PERMISSIONS.menuView,
  importPermission: PERMISSIONS.menuEdit,
  locationScoped: true,
  requiresModule: "menu",
  fields: [
    ID_FIELD,
    {
      key: "groupName",
      label: "گروه افزودنی",
      type: "text",
      required: true,
      aliases: ["گروه", "modifier group", "افزودنی گروه"],
      exportDefault: true,
    },
    {
      key: "name",
      label: "نام افزودنی",
      type: "text",
      required: true,
      aliases: ["افزودنی", "گزینه", "modifier"],
      exportDefault: true,
    },
    {
      key: "priceDelta",
      label: "اختلاف قیمت",
      type: "money",
      aliases: ["قیمت", "مبلغ اضافه"],
      exportDefault: true,
    },
    {
      key: "minSelect",
      label: "حداقل انتخاب",
      type: "integer",
      aliases: ["min select", "حداقل"],
      validation: { min: 0 },
    },
    {
      key: "maxSelect",
      label: "حداکثر انتخاب",
      type: "integer",
      aliases: ["max select", "حداکثر"],
      validation: { min: 0 },
    },
    { key: "sortOrder", label: "ترتیب", type: "integer" },
    ACTIVE_FIELD,
  ],
  duplicateRules: [
    { key: "group_name", label: "گروه و نام", fields: ["groupName", "name"] },
  ],
};

const POS_ORDERS: EntityDefinition = {
  key: "pos.orders",
  module: "pos",
  label: "سفارش‌ها",
  description: "سفارش‌های ثبت‌شده با مبالغ، وضعیت و مشتری. فقط خروجی.",
  exportPermission: PERMISSIONS.reportsExport,
  locationScoped: true,
  fields: [
    ID_FIELD,
    { key: "orderNumber", label: "شمارهٔ سفارش", type: "integer", readOnly: true, exportDefault: true },
    {
      key: "type",
      label: "نوع",
      type: "enum",
      readOnly: true,
      options: [
        { value: "dine_in", label: "سالن" },
        { value: "takeaway", label: "بیرون‌بر" },
        { value: "delivery", label: "ارسال" },
        { value: "retail", label: "فروش خرده" },
      ],
      exportDefault: true,
    },
    {
      key: "status",
      label: "وضعیت",
      type: "enum",
      readOnly: true,
      options: [
        { value: "open", label: "باز" },
        { value: "held", label: "معلق" },
        { value: "completed", label: "تکمیل شده" },
        { value: "voided", label: "ابطال شده" },
      ],
      exportDefault: true,
    },
    { key: "customerName", label: "مشتری", type: "text", readOnly: true, exportDefault: true },
    { key: "subtotal", label: "جمع جزء", type: "money", readOnly: true, exportDefault: true },
    { key: "discount", label: "تخفیف", type: "money", readOnly: true, exportDefault: true },
    { key: "tax", label: "مالیات", type: "money", readOnly: true, exportDefault: true },
    { key: "serviceCharge", label: "حق سرویس", type: "money", readOnly: true, exportDefault: true },
    { key: "total", label: "مبلغ کل", type: "money", readOnly: true, exportDefault: true },
    { key: "itemCount", label: "تعداد اقلام", type: "integer", readOnly: true, exportDefault: true },
    { key: "openedAt", label: "زمان ثبت", type: "date", readOnly: true, exportDefault: true },
    { key: "closedAt", label: "زمان تسویه", type: "date", readOnly: true, exportDefault: true },
    { key: "note", label: "یادداشت", type: "longtext", readOnly: true },
  ],
};

// ---------------------------------------------------------------------------
// Inventory — «انبار و موجودی»
// ---------------------------------------------------------------------------

const INVENTORY_ITEMS: EntityDefinition = {
  key: "inventory.items",
  module: "inventory",
  label: "کالاهای انبار",
  description: "مواد اولیه و کالاهای انبار: نام، کد، واحد و نقطهٔ سفارش.",
  exportPermission: PERMISSIONS.inventoryView,
  importPermission: PERMISSIONS.inventoryAdjust,
  locationScoped: true,
  fields: [
    ID_FIELD,
    {
      key: "name",
      label: "نام کالا",
      type: "text",
      required: true,
      aliases: ["نام", "کالا", "ماده", "item"],
      validation: { maxLength: 200 },
      exportDefault: true,
    },
    {
      key: "sku",
      label: "کد کالا",
      type: "text",
      aliases: ["کد", "sku", "code"],
      exportDefault: true,
    },
    {
      key: "unit",
      label: "واحد",
      type: "text",
      required: true,
      aliases: ["واحد شمارش", "unit", "یکا"],
      exportDefault: true,
      hint: "مثلاً کیلوگرم، عدد، لیتر.",
    },
    {
      key: "reorderLevel",
      label: "نقطهٔ سفارش",
      type: "number",
      aliases: ["حداقل موجودی", "reorder"],
      validation: { min: 0 },
      exportDefault: true,
    },
    {
      key: "purchaseUnit",
      label: "واحد خرید",
      type: "text",
      aliases: ["واحد خریداری"],
    },
    {
      key: "purchaseUnitFactor",
      label: "ضریب واحد خرید",
      type: "number",
      validation: { min: 0 },
    },
    {
      key: "avgCost",
      label: "بهای میانگین",
      type: "money",
      readOnly: true,
      exportDefault: true,
    },
    ACTIVE_FIELD,
    CREATED_AT_FIELD,
  ],
  duplicateRules: [
    { key: "sku", label: "کد کالا", fields: ["sku"] },
    { key: "name", label: "نام کالا", fields: ["name"] },
  ],
};

const INVENTORY_STOCK: EntityDefinition = {
  key: "inventory.stock",
  module: "inventory",
  label: "موجودی انبار",
  description: "موجودی فعلی هر کالا در هر شعبه. فقط خروجی.",
  exportPermission: PERMISSIONS.inventoryView,
  locationScoped: true,
  fields: [
    { key: "itemName", label: "کالا", type: "text", readOnly: true, exportDefault: true },
    { key: "sku", label: "کد کالا", type: "text", readOnly: true, exportDefault: true },
    { key: "unit", label: "واحد", type: "text", readOnly: true, exportDefault: true },
    { key: "quantity", label: "موجودی", type: "number", readOnly: true, exportDefault: true },
    { key: "reorderLevel", label: "نقطهٔ سفارش", type: "number", readOnly: true, exportDefault: true },
    { key: "avgCost", label: "بهای میانگین", type: "money", readOnly: true, exportDefault: true },
    { key: "stockValue", label: "ارزش موجودی", type: "money", readOnly: true, exportDefault: true },
  ],
};

const INVENTORY_WAREHOUSES: EntityDefinition = {
  key: "inventory.warehouses",
  module: "inventory",
  label: "شعبه‌ها و انبارها",
  description: "شعبه‌های کسب‌وکار، که انبار هر کدام جداگانه نگه‌داری می‌شود.",
  exportPermission: PERMISSIONS.inventoryView,
  fields: [
    ID_FIELD,
    // Not `required`: the flag means "an import must supply this", and this
    // entity has no import. A read-only required field would be unsatisfiable
    // if one were ever added — see registry.test.ts.
    { key: "name", label: "نام شعبه", type: "text", readOnly: true, exportDefault: true },
    { key: "address", label: "نشانی", type: "longtext", readOnly: true, exportDefault: true },
    { key: "phone", label: "تلفن", type: "phone", readOnly: true, exportDefault: true },
    { key: "timezone", label: "منطقهٔ زمانی", type: "text", readOnly: true },
    { key: "itemCount", label: "تعداد کالا", type: "integer", readOnly: true, exportDefault: true },
    ACTIVE_FIELD,
  ],
};

// ---------------------------------------------------------------------------
// Accounting — «حسابداری»
// ---------------------------------------------------------------------------

const ACCOUNTING_ACCOUNTS: EntityDefinition = {
  key: "accounting.accounts",
  module: "accounting",
  label: "سرفصل‌های حساب",
  description: "کدینگ حسابداری: کد، نام، نوع و سطح هر حساب.",
  exportPermission: PERMISSIONS.ledgerView,
  importPermission: PERMISSIONS.accountsEdit,
  fields: [
    ID_FIELD,
    {
      key: "code",
      label: "کد حساب",
      type: "text",
      required: true,
      aliases: ["کد", "code", "شمارهٔ حساب"],
      validation: { maxLength: 24 },
      exportDefault: true,
    },
    {
      key: "name",
      label: "نام حساب",
      type: "text",
      required: true,
      aliases: ["نام", "عنوان حساب", "سرفصل"],
      validation: { maxLength: 200 },
      exportDefault: true,
    },
    {
      key: "type",
      label: "نوع",
      type: "enum",
      required: true,
      options: [
        { value: "asset", label: "دارایی" },
        { value: "liability", label: "بدهی" },
        { value: "equity", label: "حقوق صاحبان سرمایه" },
        { value: "revenue", label: "درآمد" },
        { value: "expense", label: "هزینه" },
      ],
      aliases: ["گروه حساب", "ماهیت"],
      exportDefault: true,
    },
    {
      key: "level",
      label: "سطح",
      type: "enum",
      options: [
        { value: "group", label: "گروه" },
        { value: "kol", label: "کل" },
        { value: "moein", label: "معین" },
        { value: "tafsili", label: "تفصیلی" },
      ],
      exportDefault: true,
    },
    {
      key: "parentCode",
      label: "حساب بالادست",
      type: "reference",
      aliases: ["کد والد", "حساب والد", "parent"],
      relation: {
        entity: "accounting.accounts",
        lookupFields: ["code", "name"],
        // Inventing a parent account silently reshapes the chart, and every
        // report built on it: refuse instead.
        onMissing: "skip",
        label: "حساب بالادست",
      },
      exportDefault: true,
    },
    {
      key: "normalBalance",
      label: "ماهیت",
      type: "enum",
      options: [
        { value: "debit", label: "بدهکار" },
        { value: "credit", label: "بستانکار" },
      ],
      exportDefault: true,
    },
    ACTIVE_FIELD,
  ],
  duplicateRules: [
    { key: "code", label: "کد حساب", fields: ["code"] },
    { key: "name", label: "نام حساب", fields: ["name"] },
  ],
};

const ACCOUNTING_INVOICES: EntityDefinition = {
  key: "accounting.invoices",
  module: "accounting",
  label: "فاکتورهای فروش",
  description: "فاکتورهای فروش با مشتری، مبالغ و وضعیت تسویه. فقط خروجی.",
  exportPermission: PERMISSIONS.reportsExport,
  fields: [
    ID_FIELD,
    { key: "invoiceNumber", label: "شمارهٔ فاکتور", type: "integer", readOnly: true, exportDefault: true },
    { key: "customerName", label: "مشتری", type: "text", readOnly: true, exportDefault: true },
    { key: "customerPhone", label: "تلفن مشتری", type: "phone", readOnly: true, exportDefault: true },
    { key: "invoiceDate", label: "تاریخ فاکتور", type: "date", readOnly: true, exportDefault: true },
    { key: "subtotal", label: "جمع جزء", type: "money", readOnly: true, exportDefault: true },
    { key: "discount", label: "تخفیف", type: "money", readOnly: true, exportDefault: true },
    { key: "tax", label: "مالیات", type: "money", readOnly: true, exportDefault: true },
    { key: "total", label: "مبلغ کل", type: "money", readOnly: true, exportDefault: true },
    { key: "paid", label: "پرداخت‌شده", type: "money", readOnly: true, exportDefault: true },
    { key: "balance", label: "مانده", type: "money", readOnly: true, exportDefault: true },
    { key: "branchName", label: "شعبه", type: "text", readOnly: true, exportDefault: true },
  ],
};

const ACCOUNTING_PAYMENTS: EntityDefinition = {
  key: "accounting.payments",
  module: "accounting",
  label: "دریافت‌ها و پرداخت‌ها",
  description: "پرداخت‌های ثبت‌شده روی فاکتورها، با روش و مبلغ. فقط خروجی.",
  exportPermission: PERMISSIONS.reportsExport,
  fields: [
    ID_FIELD,
    { key: "invoiceNumber", label: "شمارهٔ فاکتور", type: "integer", readOnly: true, exportDefault: true },
    { key: "customerName", label: "مشتری", type: "text", readOnly: true, exportDefault: true },
    {
      key: "method",
      label: "روش پرداخت",
      type: "enum",
      readOnly: true,
      options: [
        { value: "cash", label: "نقدی" },
        { value: "card", label: "کارت‌خوان" },
        { value: "card_to_card", label: "کارت به کارت" },
        { value: "online", label: "آنلاین" },
        { value: "credit", label: "نسیه" },
        { value: "snappfood", label: "اسنپ‌فود" },
        { value: "cheque", label: "چک" },
      ],
      exportDefault: true,
    },
    { key: "amount", label: "مبلغ", type: "money", readOnly: true, exportDefault: true },
    { key: "receivedAt", label: "تاریخ دریافت", type: "date", readOnly: true, exportDefault: true },
    { key: "reference", label: "شمارهٔ پیگیری", type: "text", readOnly: true, exportDefault: true },
    { key: "branchName", label: "شعبه", type: "text", readOnly: true, exportDefault: true },
  ],
};

/**
 * The two settlements of audit F11, in the words the A/P screens and the expense
 * form already use. Declared from `payables-input` rather than restated: the
 * engine's `enum` coercion accepts a value *or* its label, so the only thing this
 * adds is the Persian spelling an operator types into a cell — and if the service
 * ever renames a settlement, the label here follows it instead of drifting.
 */
const EXPENSE_SETTLEMENT_OPTIONS = EXPENSE_SETTLEMENTS.map((value) => ({
  value,
  label: EXPENSE_SETTLEMENT_LABELS[value],
}));

const ACCOUNTING_EXPENSES: EntityDefinition = {
  key: "accounting.expenses",
  module: "accounting",
  label: "هزینه‌ها",
  description:
    "هزینه‌های ثبت‌شده: سرفصل، مبلغ، تاریخ، طرف حساب، مالیات قابل استرداد و نحوهٔ تسویه.",
  exportPermission: PERMISSIONS.ledgerView,
  /*
   * `ledger.post` was a second, unintended door to the same business act: a
   * custom role holding `data.import` + `ledger.post` but *not*
   * `finance.expenses_manage` could create paid expenses in bulk while being
   * refused by `POST /api/ledger/expenses` (issue #832 §4). One capability now
   * means "may create paid operating expenses", wherever the row comes from —
   * the route, the importer, the assistant. (`data.import` is still required on
   * top of it by every `/api/data/**` route; `importPermission` decides which
   * entities a member may write through that door.)
   */
  importPermission: PERMISSIONS.financeExpensesManage,
  fields: [
    ID_FIELD,
    {
      key: "accountCode",
      label: "سرفصل هزینه",
      type: "reference",
      required: true,
      aliases: ["کد حساب", "حساب هزینه", "سرفصل"],
      relation: {
        entity: "accounting.accounts",
        lookupFields: ["code", "name"],
        onMissing: "skip",
        label: "سرفصل هزینه",
      },
      exportDefault: true,
    },
    /*
     * Required of a **paid** row only. `parseExpenseSettlement` — the parser the
     * form and the API use — is what decides, in the adapter, because a credit row
     * has no payment account of its own: its credit is the Accounts Payable control
     * account, derived from the chart. A cell that names a *different* account on
     * an owed row is refused rather than ignored.
     */
    {
      key: "paymentAccountCode",
      label: "حساب پرداخت",
      type: "reference",
      aliases: ["از حساب", "حساب بانکی", "صندوق"],
      relation: {
        entity: "accounting.accounts",
        lookupFields: ["code", "name"],
        onMissing: "skip",
        label: "حساب پرداخت",
      },
      hint: "برای «پرداخت‌شده» الزامی است؛ برای «پرداخت بعدی» خالی بگذارید (بستانکار، حساب‌های پرداختنی است).",
      exportDefault: true,
    },
    {
      key: "amount",
      label: "مبلغ",
      type: "money",
      required: true,
      /*
       * The two unit spellings are the export's own headers: `buildExport` names a
       * money column «مبلغ (تومان)», and a sheet the register wrote has to be a
       * sheet the register can read back — otherwise the first column an operator
       * copies from an export is the one the mapper drops. (The suffix is a rule of
       * the export layer, so every entity's money columns have this gap; only the
       * expense one is closed here, and closing it engine-wide is a change to
       * `suggestMapping` rather than to this list.)
       */
      aliases: ["مبلغ هزینه", "amount", "مبلغ (تومان)", "مبلغ (ریال)"],
      // `integral` because the ledger stores whole Rial: a Toman file whose cell
      // carries a fraction is refused by name, not rounded into a posting nobody
      // wrote (the same rule `parseExpenseAmount` applies to the API).
      validation: { min: 1, integral: true },
      exportDefault: true,
    },
    {
      key: "vatAmount",
      label: "مالیات قابل استرداد",
      type: "money",
      aliases: [
        "مالیات",
        "مالیات بر ارزش افزوده",
        "مالیات قابل استرداد (تومان)",
        "مالیات قابل استرداد (ریال)",
      ],
      validation: { min: 0, integral: true },
      hint: "بخشی از مبلغ کل، در حساب ۱۲۲۰ بدهکار می‌شود؛ خالی یعنی بدون مالیات.",
      exportDefault: true,
    },
    {
      key: "expenseDate",
      label: "تاریخ",
      type: "date",
      required: true,
      aliases: ["تاریخ هزینه", "date"],
      exportDefault: true,
    },
    {
      key: "settlement",
      label: "نحوهٔ تسویه",
      type: "enum",
      options: EXPENSE_SETTLEMENT_OPTIONS,
      hint: "خالی یعنی «پرداخت‌شده». «پرداخت بعدی» بدهی را در «حساب‌های پرداختنی» همان تأمین‌کننده می‌نشیند.",
      exportDefault: true,
    },
    {
      key: "supplier",
      label: "تأمین‌کننده",
      type: "text",
      aliases: ["فروشنده", "حساب تأمین‌کننده"],
      // Resolved by the adapter through `listSupplierDirectory` — the same
      // tenant-scoped list the screen's picker reads — by id, exact name or phone.
      hint: "فقط برای «پرداخت بعدی»؛ نام، شمارهٔ تماس یا شناسهٔ تأمین‌کننده در «حساب‌های پرداختنی».",
      exportDefault: true,
    },
    {
      key: "dueDate",
      label: "سررسید پرداخت",
      type: "date",
      aliases: ["تاریخ سررسید", "سررسید"],
      hint: "فقط برای «پرداخت بعدی»؛ برای «تأخیر» در همان فهرست.",
      exportDefault: true,
    },
    {
      key: "party",
      label: "شخص (فهرست اشخاص)",
      type: "text",
      aliases: ["شخص", "اشخاص"],
      // Resolved through `searchParties`, so the encrypted columns, the inactive
      // flag and a merged-away record are all handled by the directory rather
      // than re-implemented here; an ambiguous name is refused, not guessed.
      hint: "نام دقیق یا شمارهٔ تماس شخص در «فهرست اشخاص»؛ خالی یعنی بدون پیوند.",
      exportDefault: true,
    },
    // The free-text name the row carries even after the person is deleted (§12) —
    // hence its own column, and why «تأمین‌کننده» is no longer an alias of it:
    // with a real supplier column, one header spelling may not name two fields.
    { key: "vendor", label: "طرف حساب", type: "text", aliases: ["نام طرف حساب"], exportDefault: true },
    { key: "memo", label: "شرح", type: "longtext", aliases: ["توضیحات", "بابت"], exportDefault: true },
    // Read-only facts: they travel in an export so a sheet can be tied back to the
    // ledger, and the engine excludes read-only fields from the mapping, so a
    // re-import can never overwrite a document number or invent one.
    { key: "reference", label: "شمارهٔ سند", type: "text", readOnly: true, exportDefault: true },
  ],
  // Defined once, in `src/lib/expense-import.ts`, because the database-side
  // lookup the adapter runs has to match the in-file rule the preview promises.
  duplicateRules: EXPENSE_DUPLICATE_RULES,
};

// ---------------------------------------------------------------------------
// Website — «مدیریت وب‌سایت»
// ---------------------------------------------------------------------------

const WEBSITE_PRODUCTS: EntityDefinition = {
  key: "website.products",
  module: "website",
  label: "محصولات وب‌سایت",
  description: "کالاهایی که با فروشگاه اینترنتی همگام می‌شوند و وضعیت همگام‌سازی آن‌ها.",
  exportPermission: PERMISSIONS.menuView,
  importPermission: PERMISSIONS.menuEdit,
  fields: [
    ID_FIELD,
    { key: "localName", label: "نام کالا", type: "text", readOnly: true, exportDefault: true },
    {
      key: "localKind",
      label: "نوع کالا",
      type: "enum",
      readOnly: true,
      options: [
        { value: "menu_item", label: "آیتم منو" },
        { value: "item", label: "کالای فروشگاهی" },
      ],
      exportDefault: true,
    },
    { key: "remoteId", label: "شناسهٔ سایت", type: "text", aliases: ["remote id"], exportDefault: true },
    {
      key: "syncEnabled",
      label: "همگام‌سازی فعال",
      type: "boolean",
      aliases: ["همگام سازی", "sync"],
      exportDefault: true,
    },
    { key: "lastPushedPriceRial", label: "آخرین قیمت ارسالی", type: "money", readOnly: true, exportDefault: true },
    { key: "lastPushedStock", label: "آخرین موجودی ارسالی", type: "number", readOnly: true, exportDefault: true },
    { key: "lastPushedAt", label: "آخرین ارسال", type: "date", readOnly: true, exportDefault: true },
  ],
  duplicateRules: [{ key: "remote_id", label: "شناسهٔ سایت", fields: ["remoteId"] }],
};

const WEBSITE_PAGES: EntityDefinition = {
  key: "website.pages",
  module: "website",
  label: "برگه‌های سایت",
  description: "برگه‌ها و نوشته‌های سایت وردپرسی متصل. فقط خروجی.",
  exportPermission: PERMISSIONS.menuView,
  fields: [
    ID_FIELD,
    { key: "title", label: "عنوان", type: "text", readOnly: true, exportDefault: true },
    { key: "slug", label: "نشانی کوتاه", type: "text", readOnly: true, exportDefault: true },
    { key: "wpType", label: "نوع", type: "text", readOnly: true, exportDefault: true },
    { key: "status", label: "وضعیت", type: "text", readOnly: true, exportDefault: true },
    { key: "authorName", label: "نویسنده", type: "text", readOnly: true, exportDefault: true },
    { key: "permalink", label: "نشانی کامل", type: "text", readOnly: true, exportDefault: true },
    { key: "remoteUpdatedAt", label: "آخرین ویرایش", type: "date", readOnly: true, exportDefault: true },
  ],
};

const WEBSITE_CONTENT: EntityDefinition = {
  key: "website.content",
  module: "website",
  label: "محتوای رسانه",
  description: "فایل‌ها و تصاویر کتابخانهٔ رسانه، با پوشه و اندازه.",
  exportPermission: PERMISSIONS.menuView,
  fields: [
    ID_FIELD,
    { key: "title", label: "عنوان", type: "text", readOnly: true, exportDefault: true },
    { key: "fileName", label: "نام فایل", type: "text", readOnly: true, exportDefault: true },
    { key: "folderName", label: "پوشه", type: "text", readOnly: true, exportDefault: true },
    { key: "mimeType", label: "نوع فایل", type: "text", readOnly: true, exportDefault: true },
    { key: "sizeBytes", label: "حجم (بایت)", type: "integer", readOnly: true, exportDefault: true },
    CREATED_AT_FIELD,
  ],
};

// ---------------------------------------------------------------------------
// My Workspace — «میز کار من»
// ---------------------------------------------------------------------------

const WORKSPACE_PROJECTS: EntityDefinition = {
  key: "workspace.projects",
  module: "workspace",
  label: "پروژه‌ها",
  description: "پروژه‌های اجرایی: نام، وضعیت، بازهٔ زمانی، بودجه و کارفرما.",
  exportPermission: PERMISSIONS.workspaceView,
  importPermission: PERMISSIONS.workspaceManage,
  fields: [
    ID_FIELD,
    {
      key: "name",
      label: "نام پروژه",
      type: "text",
      required: true,
      aliases: ["پروژه", "عنوان", "project"],
      validation: { maxLength: 200 },
      exportDefault: true,
    },
    {
      key: "status",
      label: "وضعیت",
      type: "enum",
      options: [
        { value: "planning", label: "برنامه‌ریزی" },
        { value: "active", label: "در حال اجرا" },
        { value: "paused", label: "متوقف" },
        { value: "completed", label: "تکمیل شده" },
        { value: "cancelled", label: "لغو شده" },
      ],
      exportDefault: true,
    },
    {
      key: "priority",
      label: "اولویت",
      type: "enum",
      options: [
        { value: "low", label: "کم" },
        { value: "normal", label: "عادی" },
        { value: "high", label: "زیاد" },
        { value: "urgent", label: "فوری" },
      ],
      exportDefault: true,
    },
    {
      key: "partyName",
      label: "کارفرما",
      type: "reference",
      aliases: ["مشتری", "customer", "طرف قرارداد"],
      relation: {
        entity: "crm.customers",
        lookupFields: ["name", "phone"],
        onMissing: "warn",
        label: "کارفرما",
      },
      exportDefault: true,
    },
    { key: "startDate", label: "تاریخ شروع", type: "date", aliases: ["شروع"], exportDefault: true },
    { key: "endDate", label: "تاریخ پایان", type: "date", aliases: ["پایان"], exportDefault: true },
    { key: "budgetRial", label: "بودجه", type: "money", aliases: ["بودجه پروژه"], exportDefault: true },
    { key: "description", label: "توضیحات", type: "longtext", exportDefault: true },
    { key: "projectType", label: "نوع پروژه", type: "text" },
    { key: "tags", label: "برچسب‌ها", type: "tags", exportDefault: true },
    { key: "taskCount", label: "تعداد کار", type: "integer", readOnly: true, exportDefault: true },
    CREATED_AT_FIELD,
  ],
  duplicateRules: [{ key: "name", label: "نام پروژه", fields: ["name"] }],
};

const WORKSPACE_TASKS: EntityDefinition = {
  key: "workspace.tasks",
  module: "workspace",
  label: "کارها",
  description: "کارهای هر پروژه: عنوان، وضعیت، موعد و اولویت.",
  exportPermission: PERMISSIONS.workspaceView,
  importPermission: PERMISSIONS.workspaceManage,
  fields: [
    ID_FIELD,
    {
      key: "title",
      label: "عنوان کار",
      type: "text",
      required: true,
      aliases: ["کار", "task", "شرح کار"],
      validation: { maxLength: 300 },
      exportDefault: true,
    },
    {
      key: "projectName",
      label: "پروژه",
      type: "reference",
      required: true,
      aliases: ["نام پروژه", "project"],
      relation: {
        entity: "workspace.projects",
        lookupFields: ["name"],
        // A task with no project has nowhere to live; the project is a folder
        // the operator owns, so creating it is what they expect.
        onMissing: "create",
        label: "پروژه",
      },
      exportDefault: true,
    },
    {
      key: "status",
      label: "وضعیت",
      type: "enum",
      options: [
        { value: "todo", label: "انجام نشده" },
        { value: "in_progress", label: "در حال انجام" },
        { value: "blocked", label: "متوقف" },
        { value: "done", label: "انجام شد" },
      ],
      exportDefault: true,
    },
    {
      key: "priority",
      label: "اولویت",
      type: "enum",
      options: [
        { value: "low", label: "کم" },
        { value: "normal", label: "عادی" },
        { value: "high", label: "زیاد" },
        { value: "urgent", label: "فوری" },
      ],
      exportDefault: true,
    },
    { key: "dueDate", label: "موعد", type: "date", aliases: ["تاریخ سررسید", "due"], exportDefault: true },
    { key: "description", label: "توضیحات", type: "longtext", exportDefault: true },
    { key: "completedAt", label: "تاریخ انجام", type: "date", readOnly: true, exportDefault: true },
    CREATED_AT_FIELD,
  ],
  duplicateRules: [
    { key: "title_project", label: "عنوان و پروژه", fields: ["title", "projectName"] },
  ],
};

const WORKSPACE_CONTRACTS: EntityDefinition = {
  key: "workspace.contracts",
  module: "workspace",
  label: "قراردادها",
  description: "قراردادهای اجرایی: عنوان، طرف قرارداد، مبلغ و بازهٔ زمانی.",
  exportPermission: PERMISSIONS.workspaceView,
  importPermission: PERMISSIONS.workspaceContractsManage,
  fields: [
    ID_FIELD,
    {
      key: "title",
      label: "عنوان قرارداد",
      type: "text",
      required: true,
      aliases: ["قرارداد", "موضوع", "contract"],
      validation: { maxLength: 300 },
      exportDefault: true,
    },
    {
      key: "contractType",
      label: "نوع قرارداد",
      type: "enum",
      options: [
        { value: "client", label: "کارفرما" },
        { value: "contractor", label: "پیمانکار" },
        { value: "supplier", label: "تأمین‌کننده" },
        { value: "service", label: "خدمات" },
        { value: "other", label: "سایر" },
      ],
      exportDefault: true,
    },
    {
      key: "partyName",
      label: "طرف قرارداد",
      type: "reference",
      aliases: ["طرف حساب", "پیمانکار", "کارفرما"],
      relation: {
        entity: "crm.customers",
        lookupFields: ["name", "phone"],
        // A contract commits money to a named third party; creating that party
        // from a spreadsheet cell is not a decision an importer should make.
        onMissing: "skip",
        label: "طرف قرارداد",
      },
      exportDefault: true,
    },
    {
      key: "projectName",
      label: "پروژه",
      type: "reference",
      aliases: ["نام پروژه"],
      relation: {
        entity: "workspace.projects",
        lookupFields: ["name"],
        onMissing: "warn",
        label: "پروژه",
      },
      exportDefault: true,
    },
    { key: "valueRial", label: "مبلغ قرارداد", type: "money", aliases: ["مبلغ", "ارزش"], exportDefault: true },
    { key: "startDate", label: "تاریخ شروع", type: "date", exportDefault: true },
    { key: "endDate", label: "تاریخ پایان", type: "date", exportDefault: true },
    {
      key: "status",
      label: "وضعیت",
      type: "enum",
      options: [
        { value: "draft", label: "پیش‌نویس" },
        { value: "active", label: "جاری" },
        { value: "completed", label: "خاتمه‌یافته" },
        { value: "cancelled", label: "فسخ شده" },
      ],
      exportDefault: true,
    },
    { key: "notes", label: "یادداشت", type: "longtext" },
    CREATED_AT_FIELD,
  ],
  duplicateRules: [
    { key: "title_party", label: "عنوان و طرف قرارداد", fields: ["title", "partyName"] },
    { key: "title", label: "عنوان قرارداد", fields: ["title"] },
  ],
};

const WORKSPACE_DOCUMENTS: EntityDefinition = {
  key: "workspace.documents",
  module: "workspace",
  label: "مدارک",
  description: "مدارک پروژه‌ها و قراردادها، با نسخه و وضعیت. فقط خروجی.",
  exportPermission: PERMISSIONS.workspaceView,
  fields: [
    ID_FIELD,
    { key: "title", label: "عنوان", type: "text", readOnly: true, exportDefault: true },
    { key: "projectName", label: "پروژه", type: "text", readOnly: true, exportDefault: true },
    { key: "contractTitle", label: "قرارداد", type: "text", readOnly: true, exportDefault: true },
    { key: "status", label: "وضعیت", type: "text", readOnly: true, exportDefault: true },
    { key: "version", label: "نسخه", type: "integer", readOnly: true, exportDefault: true },
    { key: "tags", label: "برچسب‌ها", type: "tags", readOnly: true, exportDefault: true },
    { key: "description", label: "توضیحات", type: "longtext", readOnly: true },
    CREATED_AT_FIELD,
  ],
};

/**
 * Issue #799 §7 — the BOQ's measured rows, importable through this engine
 * rather than a parser of its own ("do not create an isolated BOQ CSV parser").
 *
 * The flat shape a spreadsheet actually has: one row per measured item, with
 * its chapter, its project and — optionally — the revision it belongs to. A
 * row that names a revision which is no longer a draft is refused rather than
 * written, because an approved revision is a historical record; a row that
 * names no revision lands in the project's current draft, and one is created
 * the first time somebody imports into a project that has no estimate yet.
 */
const WORKSPACE_BOQ_ITEMS: EntityDefinition = {
  key: "workspace.boq_items",
  module: "workspace",
  label: "ردیف‌های متره و برآورد",
  description:
    "متره و برآورد پروژه‌های عمرانی: فصل، شرح، واحد، مقدار و نرخ‌های تشکیل‌دهندهٔ قیمت. نرخ‌ها به ریال خوانده می‌شوند.",
  exportPermission: PERMISSIONS.workspaceView,
  importPermission: PERMISSIONS.workspaceManage,
  fields: [
    ID_FIELD,
    {
      key: "projectName",
      label: "پروژه",
      type: "reference",
      required: true,
      aliases: ["پروژه", "project"],
      relation: {
        entity: "workspace.projects",
        lookupFields: ["name"],
        // A BOQ row for a project that does not exist is a mistake in the file,
        // not an instruction to create a project: the row is skipped with the
        // reason, and the operator fixes the sheet.
        onMissing: "skip",
        label: "پروژه",
      },
      exportDefault: true,
    },
    {
      key: "estimateTitle",
      label: "برآورد",
      type: "text",
      aliases: ["برآورد", "متره", "BOQ", "عنوان برآورد"],
      hint: "خالی بماند، «برآورد اصلی» استفاده می‌شود.",
      validation: { maxLength: 200 },
      exportDefault: true,
    },
    {
      key: "versionNo",
      label: "شمارهٔ نسخه",
      type: "integer",
      aliases: ["نسخه", "ورژن", "revision"],
      hint: "فقط نسخهٔ پیش‌نویس قابل ورود است؛ خالی بماند، نسخهٔ پیش‌نویس جاری انتخاب می‌شود.",
      exportDefault: true,
    },
    {
      key: "sectionCode",
      label: "کد فصل",
      type: "text",
      aliases: ["فصل", "کد فصل", "بخش"],
      validation: { maxLength: 40 },
      exportDefault: true,
    },
    {
      key: "sectionTitle",
      label: "عنوان فصل",
      type: "text",
      aliases: ["شرح فصل", "عنوان بخش"],
      validation: { maxLength: 200 },
      exportDefault: true,
    },
    {
      key: "itemCode",
      label: "کد ردیف",
      type: "text",
      aliases: ["کد", "ردیف", "کد آیتم", "item"],
      validation: { maxLength: 40 },
      exportDefault: true,
    },
    {
      key: "description",
      label: "شرح ردیف",
      type: "text",
      required: true,
      aliases: ["شرح", "شرح آیتم", "description"],
      validation: { maxLength: 500 },
      exportDefault: true,
    },
    {
      key: "unit",
      label: "واحد",
      type: "text",
      aliases: ["واحد اندازه‌گیری", "unit"],
      validation: { maxLength: 20 },
      exportDefault: true,
    },
    { key: "quantity", label: "مقدار", type: "number", aliases: ["مقدار", "متره"], exportDefault: true },
    { key: "materialRateRial", label: "نرخ مصالح", type: "money", exportDefault: true },
    { key: "laborRateRial", label: "نرخ دستمزد", type: "money", exportDefault: true },
    { key: "equipmentRateRial", label: "نرخ ماشین‌آلات", type: "money", exportDefault: true },
    { key: "subcontractRateRial", label: "نرخ پیمانکار جزء", type: "money", exportDefault: true },
    { key: "wastePercent", label: "ضریب پرت (٪)", type: "number", aliases: ["پرت", "ضایعات"], exportDefault: true },
    { key: "overheadPercent", label: "سربار (٪)", type: "number", exportDefault: true },
    { key: "markupPercent", label: "سود (٪)", type: "number", aliases: ["سود", "markup"], exportDefault: true },
    {
      key: "workPackage",
      label: "بستهٔ کاری",
      type: "text",
      aliases: ["رشته", "دیسیپلین", "work package"],
      validation: { maxLength: 120 },
      exportDefault: true,
    },
    {
      key: "partyName",
      label: "تأمین‌کننده/پیمانکار",
      type: "reference",
      aliases: ["تأمین‌کننده", "پیمانکار", "supplier"],
      relation: {
        entity: "crm.customers",
        lookupFields: ["name", "phone"],
        onMissing: "warn",
        label: "تأمین‌کننده/پیمانکار",
      },
      exportDefault: true,
    },
    { key: "notes", label: "توضیحات", type: "longtext" },
    // Computed by the database, exported so a round trip is checkable and never
    // importable: the two columns a wrong file would otherwise be able to fake.
    { key: "unitPriceRial", label: "قیمت واحد", type: "money", readOnly: true, exportDefault: true },
    { key: "totalRial", label: "جمع ردیف", type: "money", readOnly: true, exportDefault: true },
    CREATED_AT_FIELD,
  ],
  duplicateRules: [
    {
      key: "item",
      label: "کد/شرح ردیف در همان پروژه",
      fields: ["projectName", "estimateTitle", "versionNo", "itemCode", "description"],
    },
  ],
  requiresIndustry: "architecture_construction",
};

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

/**
 * Every entity the platform can move, in the order the UI lists them.
 *
 * A module adds a row here and an adapter beside its service; it does NOT add
 * an import screen, a CSV parser, an API route or a history table. That is the
 * whole point.
 */
export const DATA_ENTITIES: readonly EntityDefinition[] = [
  // CRM
  CRM_CUSTOMERS,
  CRM_COMPANIES,
  CRM_LEADS,
  CRM_DEALS,
  CRM_ACTIVITIES,
  CRM_PARTY_CATEGORIES,
  CRM_PIPELINE_STAGES,
  // POS
  POS_PRODUCTS,
  POS_CATEGORIES,
  POS_ITEM_MODIFIER_GROUPS,
  POS_MODIFIERS,
  POS_ORDERS,
  // Inventory
  INVENTORY_ITEMS,
  INVENTORY_STOCK,
  INVENTORY_WAREHOUSES,
  // Accounting
  ACCOUNTING_ACCOUNTS,
  ACCOUNTING_INVOICES,
  ACCOUNTING_PAYMENTS,
  ACCOUNTING_EXPENSES,
  // Website
  WEBSITE_PRODUCTS,
  WEBSITE_PAGES,
  WEBSITE_CONTENT,
  // My Workspace
  WORKSPACE_PROJECTS,
  WORKSPACE_TASKS,
  WORKSPACE_CONTRACTS,
  WORKSPACE_DOCUMENTS,
  WORKSPACE_BOQ_ITEMS,
];

const BY_KEY = new Map(DATA_ENTITIES.map((entity) => [entity.key, entity]));

/**
 * The entities a business may even see, before permissions narrow them further.
 *
 * One function so the catalogue route and any future caller cannot disagree
 * about which trade an entity belongs to — and so the answer is unit-testable
 * without a database.
 */
export function entitiesForIndustry(industry: Industry | null | undefined): EntityDefinition[] {
  return DATA_ENTITIES.filter(
    (entity) => !entity.requiresIndustry || entity.requiresIndustry === industry,
  );
}

/** The entity a key names, or null. Never throws — a key comes from a URL. */
export function findEntity(key: string | null | undefined): EntityDefinition | null {
  if (!key) return null;
  return BY_KEY.get(key) ?? null;
}

/** The entity a key names. Throws — for callers that already validated it. */
export function requireEntity(key: string): EntityDefinition {
  const entity = BY_KEY.get(key);
  if (!entity) throw new Error(`unknown entity: ${key}`);
  return entity;
}

/** Every entity of one module, in registry order. */
export function entitiesForModule(module: DataModuleKey): EntityDefinition[] {
  return DATA_ENTITIES.filter((entity) => entity.module === module);
}

/** A field of an entity, by key. */
export function findField(entity: EntityDefinition, key: string): EntityField | null {
  return entity.fields.find((field) => field.key === key) ?? null;
}

/** The fields an export includes when the operator picks none explicitly. */
export function defaultExportFields(entity: EntityDefinition): string[] {
  const defaults = entity.fields.filter((field) => field.exportDefault).map((field) => field.key);
  // An entity whose author marked nothing still has to export something
  // useful, so fall back to every non-id field rather than an empty file.
  if (defaults.length > 0) return defaults;
  return entity.fields.filter((field) => field.key !== "id").map((field) => field.key);
}

/** The fields an import may write. */
export function importableFields(entity: EntityDefinition): EntityField[] {
  return entity.fields.filter((field) => !field.readOnly);
}

/** Whether this entity can be imported at all. */
export function isImportable(entity: EntityDefinition): boolean {
  return Boolean(entity.importPermission) && importableFields(entity).length > 0;
}
