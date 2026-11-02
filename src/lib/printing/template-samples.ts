/**
 * The sample document a template card and the preview dialog render.
 *
 * Pure (no UI imports) so the gallery, the designer and a unit test read the
 * same data. A sample must look like what *this* business type prints: a
 * jeweller never sees a café table number, a shelf label always carries a
 * barcode and a price, and the payment rows add up to the bill — a preview is
 * a claim about the real output, so the numbers on it have to reconcile.
 */
import type { Industry } from "../industries";
import { formatMoney } from "../money";
import type { PrintDocumentData, PrintLine, PrintTemplate } from "../print-template";
import { templateMetadata } from "./template-catalog";
import { wooPrintSample } from "./woo-order-print-data";

interface TradeSample {
  /** Invoice heading for this trade. */
  invoiceTitle: string;
  /** Receipt heading; the document default when omitted. */
  receiptTitle?: string;
  /** Printed under the heading. */
  subtitle: string;
  lines: PrintLine[];
  discount: number;
  /** Shelf-label / tag product. */
  labelName: string;
  labelCode: string;
  labelPrice: number;
  note: string;
}

const GENERIC_TRADE: TradeSample = {
  invoiceTitle: "فاکتور فروشگاه نمونه",
  subtitle: "فروش حضوری",
  lines: [
    { name: "کالای نمونهٔ شمارهٔ ۱", quantity: 2, detail: "کد کالا: SKU-1042", unitPrice: 725_000, lineTotal: 1_450_000 },
    { name: "کالای نمونهٔ شمارهٔ ۲", quantity: 1, detail: "رنگ: سرمه‌ای", unitPrice: 2_350_000, lineTotal: 2_350_000 },
  ],
  discount: 150_000,
  labelName: "کالای نمونه",
  labelCode: "SKU-1042",
  labelPrice: 1_250_000,
  note: "همهٔ مقادیر نمونه فرضی هستند.",
};

/**
 * What each trade without a dedicated sample kind sells. Food service keeps the
 * café sale from `samplePrintDocument`; jewelry, watch, cosmetics and
 * automotive have their own richer samples below.
 */
const TRADE_SAMPLES: Partial<Record<Industry, Partial<TradeSample>>> = {
  food_service: {
    labelName: "کیک شکلاتی بسته‌بندی‌شده",
    labelCode: "CAKE-1042",
    labelPrice: 1_450_000,
  },
  accessories: {
    invoiceTitle: "فاکتور فروش بدلیجات",
    lines: [
      { name: "گردنبند آبکاری‌شده نمونه", quantity: 1, detail: "کد: ACC-1042 · رنگ طلایی", unitPrice: 1_850_000, lineTotal: 1_850_000 },
      { name: "گوشواره نگین‌دار نمونه", quantity: 2, detail: "کد: ACC-2042", unitPrice: 650_000, lineTotal: 1_300_000 },
    ],
    discount: 100_000,
    labelName: "گردنبند آبکاری‌شده نمونه",
    labelCode: "ACC-1042",
    labelPrice: 1_850_000,
  },
  wholesale: {
    invoiceTitle: "فاکتور فروش عمده",
    subtitle: "فروش عمده",
    lines: [
      { name: "کارتن شوینده ۱۲ عددی", quantity: 20, detail: "کد کالا: WH-1042 · هر کارتن ۱۲ عدد", unitPrice: 4_800_000, lineTotal: 96_000_000 },
      { name: "کارتن دستمال کاغذی ۲۴ عددی", quantity: 10, detail: "کد کالا: WH-2042", unitPrice: 3_100_000, lineTotal: 31_000_000 },
    ],
    discount: 2_000_000,
    labelName: "کارتن شوینده ۱۲ عددی",
    labelCode: "WH-1042",
    labelPrice: 4_800_000,
  },
  tools_fittings: {
    invoiceTitle: "فاکتور فروش ابزار و یراق‌آلات",
    lines: [
      { name: "شیر توپی برنجی ۱ اینچ", quantity: 6, detail: "کد کالا: TF-1042", unitPrice: 920_000, lineTotal: 5_520_000 },
      { name: "پیچ‌گوشتی دوسو ۲۰ سانتی", quantity: 4, detail: "کد کالا: TF-2042", unitPrice: 310_000, lineTotal: 1_240_000 },
    ],
    discount: 240_000,
    labelName: "شیر توپی برنجی ۱ اینچ",
    labelCode: "TF-1042",
    labelPrice: 920_000,
  },
  haberdashery: {
    invoiceTitle: "فاکتور فروش خرازی",
    lines: [
      { name: "کلاف نخ ابریشمی", quantity: 12, detail: "کد کالا: HB-1042 · رنگ ۲۴", unitPrice: 95_000, lineTotal: 1_140_000 },
      { name: "دکمه صدفی ۲۰ میلی‌متر (بسته ۱۰۰ عددی)", quantity: 2, detail: "کد کالا: HB-2042", unitPrice: 420_000, lineTotal: 840_000 },
    ],
    discount: 40_000,
    labelName: "کلاف نخ ابریشمی",
    labelCode: "HB-1042",
    labelPrice: 95_000,
  },
  service_saas: {
    invoiceTitle: "فاکتور خدمات",
    receiptTitle: "رسید دریافت وجه",
    subtitle: "خدمات",
    lines: [
      { name: "اشتراک ماهانهٔ پلن حرفه‌ای", quantity: 1, detail: "دورهٔ ۳۰ روزه · ۵ کاربر", unitPrice: 4_500_000, lineTotal: 4_500_000 },
      { name: "راه‌اندازی و آموزش تیم", quantity: 1, detail: "۴ ساعت · حضوری", unitPrice: 2_000_000, lineTotal: 2_000_000 },
    ],
    discount: 0,
    note: "اطلاعات این نمونه فرضی هستند.",
  },
  architecture_construction: {
    invoiceTitle: "فاکتور خدمات مهندسی",
    receiptTitle: "رسید دریافت وجه",
    subtitle: "خدمات مهندسی",
    lines: [
      { name: "طراحی معماری — فاز یک", quantity: 1, detail: "پروژه نمونه · نقشه‌های مفهومی", unitPrice: 85_000_000, lineTotal: 85_000_000 },
      { name: "نظارت کارگاهی — ماه اول", quantity: 1, detail: "پروژه نمونه · بازدید هفتگی", unitPrice: 24_000_000, lineTotal: 24_000_000 },
    ],
    discount: 0,
    note: "اطلاعات این نمونه فرضی هستند.",
  },
};

function tradeSample(industry: Industry | null): TradeSample {
  return { ...GENERIC_TRADE, ...(industry ? TRADE_SAMPLES[industry] : {}) };
}

function paymentsFor(total: number): { label: string; amount: number }[] {
  return [{ label: "کارت‌خوان", amount: total }];
}

/** A sample sale whose totals and payment rows reconcile with its lines. */
function priced(
  base: PrintDocumentData,
  lines: PrintLine[],
  discount: number,
  extra: Partial<PrintDocumentData> = {},
): PrintDocumentData {
  const subtotal = lines.reduce((sum, line) => sum + line.lineTotal, 0);
  const total = subtotal - discount;
  return { ...base, lines, subtotal, discount, tax: 0, total, payments: paymentsFor(total), ...extra };
}

/** `samplePrintDocument` is a café sale; every other trade starts from a plain counter sale. */
function counterSale(data: PrintDocumentData, subtitle: string): PrintDocumentData {
  return { ...data, subtitle, tip: undefined, paid: null, due: null };
}

export function sampleForTemplate(
  template: PrintTemplate,
  data: PrintDocumentData,
  industry: Industry | null,
): PrintDocumentData {
  if (template.docType === "shipping_label" || template.docType === "woo_invoice") {
    return wooPrintSample(template.docType, data.business);
  }

  let kind = templateMetadata(template).sampleKind;
  if (kind === "retail" && industry === "food_service") kind = "food_service";
  else if (kind === "retail" && industry === "jewelry") kind = "jewelry";
  else if (kind === "retail" && industry === "watch") kind = "serialized_retail";
  else if (kind === "retail" && industry === "cosmetics") kind = "batch_expiry";
  else if (kind === "retail" && industry === "automotive") kind = "vehicle";
  else if (kind === "serialized_retail" && industry === "jewelry") kind = "jewelry";
  else if (kind === "serialized_retail" && industry === "automotive") kind = "vehicle";
  // The café sale is the right sample for a café's receipt or invoice; a shelf
  // label for a packaged item needs a product, a code and a price instead.
  const isCafeSale = kind === "food_service";
  if (isCafeSale && template.docType !== "label") return data;

  if (kind === "kitchen") {
    return {
      ...data,
      title: "سفارش آشپزخانه",
      subtitle: "میز ۳ · نمونه",
      lines: [
        { name: "لاتهٔ متوسط", quantity: 2, detail: "شیر جو دوسر · داغ", lineTotal: 0 },
        { name: "ساندویچ سبزیجات", quantity: 1, detail: "بدون پیاز · سس جدا", lineTotal: 0 },
      ],
      note: "نمونه: آماده‌سازی به‌ترتیب اقلام",
      subtotal: 0,
      discount: 0,
      tax: 0,
      total: 0,
      payments: null,
    };
  }

  const sale = counterSale(data, tradeSample(industry).subtitle);

  if (kind === "jewelry") {
    return priced(
      sale,
      [{ name: "انگشتر طلای ۱۸ عیار", quantity: 1, detail: "وزن ۳٫۲ گرم · عیار ۷۵۰ · اجرت نمونه", unitPrice: 84_000_000, tax: 0, lineTotal: 84_000_000 }],
      0,
      {
        title: template.docType === "label" ? "انگشتر نمونه" : "فاکتور فروش طلا و جواهر",
        number: "J-1042",
        barcodeValue: "JEW-SAMPLE-42",
        barcodeFormat: "code128",
        labelFields: [
          { label: "وزن", value: "۳٫۲ گرم" },
          { label: "عیار", value: "۷۵۰" },
          { label: "قیمت نمونه", value: formatMoney(84_000_000, data.unit ?? "toman") },
        ],
        note: "مقادیر این نمونه فرضی هستند.",
      },
    );
  }

  if (kind === "serialized_retail") {
    return priced(
      sale,
      [{ name: "ساعت مچی نمونه", quantity: 1, detail: "سریال SN-2042 · گارانتی نمونه · وضعیت سالم", unitPrice: 12_500_000, tax: 0, lineTotal: 12_500_000 }],
      0,
      {
        title: template.docType === "label" ? "کالای سریال‌دار نمونه" : "فاکتور کالای سریال‌دار",
        number: "R-1042",
        barcodeValue: "SN-2042",
        barcodeFormat: "code128",
        labelFields: [
          { label: "شماره سریال", value: "SN-2042" },
          { label: "وضعیت", value: "نمونه · سالم" },
          { label: "قیمت نمونه", value: formatMoney(12_500_000, data.unit ?? "toman") },
        ],
        note: "اطلاعات این نمونه فرضی هستند.",
      },
    );
  }

  if (kind === "vehicle") {
    return priced(
      sale,
      [{ name: "خودروی نمونه", quantity: 1, detail: "شماره موجودی CAR-1042 · VIN SAMPLEVIN42 · شاسی CH-SAMPLE42 · پلاک نمونه", unitPrice: 2_450_000_000, lineTotal: 2_450_000_000 }],
      0,
      {
        title: template.docType === "label" ? "خودروی نمونه" : "فاکتور فروش خودرو",
        number: "CAR-1042",
        barcodeValue: "SAMPLEVIN42",
        barcodeFormat: "code128",
        labelFields: [
          { label: "شمارهٔ موجودی", value: "CAR-1042" },
          { label: "VIN", value: "SAMPLEVIN42" },
          { label: "قیمت نمونه", value: formatMoney(2_450_000_000, data.unit ?? "toman") },
        ],
        note: "اطلاعات این نمونه فرضی هستند.",
      },
    );
  }

  if (kind === "batch_expiry") {
    const expiryDetail = "LOT-SAMPLE-42 · انقضا ۱۴۰۵/۰۶/۰۱";
    return priced(
      sale,
      [{ name: "کرم مرطوب‌کنندهٔ نمونه", quantity: 1, detail: expiryDetail, unitPrice: 1_650_000, lineTotal: 1_650_000 }],
      0,
      {
        title: template.docType === "label" ? "کرم مرطوب‌کنندهٔ نمونه" : "فاکتور کالای آرایشی نمونه",
        number: "B-1042",
        barcodeValue: "COS-SAMPLE-42",
        barcodeFormat: "code128",
        labelFields: [
          { label: "بچ", value: "LOT-SAMPLE-42" },
          { label: "تاریخ انقضا", value: "۱۴۰۵/۰۶/۰۱" },
          { label: "قیمت نمونه", value: formatMoney(1_650_000, data.unit ?? "toman") },
        ],
        note: "نمونهٔ نمایشی؛ اطلاعات واقعی بچ نیست.",
      },
    );
  }

  const trade = tradeSample(industry);

  if (template.docType === "label") {
    return {
      ...sale,
      title: trade.labelName,
      number: trade.labelCode,
      lines: [{ name: trade.labelName, quantity: 1, unitPrice: trade.labelPrice, lineTotal: trade.labelPrice }],
      barcodeValue: trade.labelCode,
      barcodeFormat: "code128",
      labelFields: [
        { label: "شناسه", value: trade.labelCode },
        { label: "قیمت نمونه", value: formatMoney(trade.labelPrice, data.unit ?? "toman") },
      ],
    };
  }

  const document = priced(sale, trade.lines, trade.discount, {
    title: template.docType === "invoice" ? trade.invoiceTitle : trade.receiptTitle ?? data.title,
    number: "R-1042",
    barcodeValue: trade.labelCode,
    barcodeFormat: "code128",
    note: trade.note,
  });
  return {
    ...document,
    labelFields: [
      { label: "شناسه کالا", value: trade.labelCode },
      { label: "قیمت نمونه", value: formatMoney(document.total, data.unit ?? "toman") },
    ],
  };
}
