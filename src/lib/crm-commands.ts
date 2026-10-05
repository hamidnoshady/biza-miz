/**
 * The CRM command field — «جست‌وجو یا پرسش در ارتباط با مشتری…».
 *
 * ## What this is
 *
 * A **closed grammar**, not a language model. It maps what a member types onto
 * one of three things the app can already do:
 *
 *  - **a destination** — «امروز», «فرصت‌ها», «تیکت‌ها»;
 *  - **a queue** — «پیگیری‌های عقب‌افتاده», «معامله‌های راکد», «بدهی»;
 *  - **a person** — anything that is not one of the above, searched through
 *    `/api/parties` (the directory's own endpoint, with its own permission).
 *
 * ## Why not a model, and why that is not a limitation
 *
 * The vocabulary below is the same closed list the rest of the CRM is built on:
 * the section keys, the queue keys, the lifecycle stages. Nothing a member types
 * becomes SQL — the worst a bad match can do is offer the wrong *screen*, and
 * the screen itself decides what the member may see. That is a property of the
 * shape rather than a policy: `interpretCrmCommand` returns keys, never a
 * query, and the caller resolves a key to a href through the tables that
 * already exist.
 *
 * An LLM may later sit in front of this to choose among the same keys; the
 * interface would not change, and the guarantee — that a phrase can only ever
 * select something the product already has — would not either.
 *
 * ## Matching, and what it deliberately tolerates
 *
 * Persian text arrives with `ZWNJ` between the parts of a compound word
 * («پیگیری‌ها»), with Arabic `ي`/`ك` where the keyboard produced them, with
 * Persian or Latin digits, and with the optional plural suffix. All of that is
 * folded before comparison, because a search box that fails on the reader's own
 * keyboard is a search box nobody uses. What is *not* folded is word order or
 * meaning: a phrase with no alias in the vocabulary is treated as a person's
 * name, which is the honest fallback — the directory can answer that question.
 */

import { CRM_SECTION_KEYS, type CrmSectionKey } from "./crm-permissions";
import { CRM_QUEUE_KEYS, CRM_QUEUE_PRESENTATION, type CrmQueueKey } from "./crm-shared";

/** Fold a phrase the way a Persian keyboard varies it. */
export function normalizeCrmPhrase(value: string): string {
  return value
    .trim()
    .toLowerCase()
    // Zero-width non-joiner: the difference between «پیگیریها» and «پیگیری ها»
    // is a keystroke, never an intention.
    .replace(/[\u200b-\u200f\u2028\u2029]/g, "")
    .replace(/\u064a/g, "\u06cc") // Arabic yeh → Persian yeh
    .replace(/\u0643/g, "\u06a9") // Arabic kaf → Persian kaf
    .replace(/[\u064b-\u0652\u0640]/g, "") // harakat and tatweel
    .replace(/[\u06f0-\u06f9]/g, (digit) => String(digit.charCodeAt(0) - 0x06f0)) // ۰-۹
    .replace(/[\u0660-\u0669]/g, (digit) => String(digit.charCodeAt(0) - 0x0660)) // ٠-٩
    .replace(/[؟?!.,،؛:]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Extra words per section.
 *
 * The label itself is *not* repeated here — the caller renders labels from
 * `crm-nav.ts` and compares against the same folded text. These are the words a
 * person types when they are not reading the menu: the thing they want.
 */
const SECTION_ALIASES: Record<CrmSectionKey, readonly string[]> = {
  overview: ["امروز", "کارهای امروز", "میز کار", "صف", "صف کار", "چه خبر", "توجه"],
  directory: ["مشتری", "مشتریان", "اشخاص", "دفترچه", "پرونده", "تلفن", "شماره", "مخاطب"],
  persons: ["پرونده مشتری", "پرونده ۳۶۰", "فایل مشتری"],
  leads: ["سرنخ", "سرنخ‌ها", "سرنخ تازه", "پرس‌وجو", "استعلام"],
  deals: ["فرصت", "فرصت‌ها", "معامله", "معامله‌ها", "قیف", "فروش", "پیشنهاد", "مذاکره"],
  activities: ["کار", "کارها", "پیگیری", "پیگیری‌ها", "تماس", "جلسه", "یادآوری", "وظیفه", "وظایف"],
  cases: ["تیکت", "تیکت‌ها", "شکایت", "پشتیبانی", "خدمات", "میز خدمت", "درخواست"],
  segments: ["بخش", "بخش‌بندی", "سگمنت", "گروه مشتریان", "تحلیل", "وفاداری", "چرخه عمر"],
  consent: ["رضایت", "اجازه", "پیامک", "ایمیل", "ارتباط"],
  // The workspace, and the two views inside it. All three phrases are offered
  // because all three addresses work: «کیفیت داده» opens the workspace, and
  // «تکراری‌ها» still finds the duplicate screen for whoever saved that link.
  quality: ["کیفیت داده", "مسائل داده", "اصلاح داده", "بی‌کیفیت"],
  duplicates: ["تکراری", "تکراری‌ها", "دوتایی", "ادغام"],
  reconciliation: ["تطبیق", "فروشگاه آنلاین", "خریدار آنلاین", "سایت", "هویت"],
  audit: ["سابقه", "لاگ", "تصمیم‌ها", "چه کسی", "تاریخچه تصمیم"],
  settings: ["تنظیمات", "پیکربندی", "فیلد کسب‌وکار", "فیلدها", "مراحل قیف"],
  // The rules that act on their own. Reached from the settings screen, and
  // findable by the words a person uses when they want one: an automation, a
  // rule that runs itself, or the plain verb.
  automations: ["اتوماسیون", "اتوماسیون‌ها", "قاعده خودکار", "خودکارسازی", "کار خودکار"],
};

/**
 * Extra words per queue. The queue's own label comes from the presentation
 * table, so this only adds how people describe the *problem*.
 */
const QUEUE_ALIASES: Record<CrmQueueKey, readonly string[]> = {
  overdue_follow_ups: ["عقب‌افتاده", "دیرکرد", "گذشته", "کارهای عقب‌افتاده"],
  due_today: ["امروز", "موعد امروز", "کارهای امروز"],
  sla_risk: ["مهلت", "خطر مهلت", "دیر پاسخ", "نقض sla", "بیرون از مهلت"],
  waiting_on_customer: ["منتظر", "در انتظار پاسخ", "پاسخ مشتری"],
  stalled_deals: ["راکد", "متوقف", "بی‌خبر", "کند", "خوابیده"],
  high_value_open: ["پرارزش", "بزرگ", "مبلغ بالا", "معامله بزرگ"],
  unassigned_cases: ["بی‌مسئول", "بدون مسئول", "واگذار نشده"],
  departed_owner: ["عضو غیرفعال", "رفته", "ترک کرده", "کارمند سابق", "غیرفعال"],
  vip_follow_up: ["ویژه", "وی‌آی‌پی", "مشتری وفادار", "مشتری طلایی", "سکوت"],
  at_risk_customers: ["در خطر", "ریزش", "از دست دادن", "در حال رفتن", "غیرفعال شدن"],
  new_leads: ["سرنخ تازه", "سرنخ جدید", "تازه رسیده"],
  new_identities: ["هویت تازه", "تازه‌وارد", "خریدار آنلاین", "تطبیق نشده"],
  possible_duplicates: ["تکراری", "شماره مشترک", "دوتایی", "ادغام"],
};

export interface CrmCommandMatch {
  kind: "section" | "queue";
  /** The section key, or the queue's key. */
  key: string;
  /** Where it goes. */
  href: string;
  /** Which phrase matched — shown to the reader as the interpreted filter. */
  matched: string;
  /** The section that must be openable for this match to be offered. */
  section: CrmSectionKey;
}

export interface CrmCommandInterpretation {
  /** The folded form of what was typed, for the «فهمیدم» line. */
  normalized: string;
  /** Destinations, best match first. */
  matches: CrmCommandMatch[];
  /**
   * Whether the phrase should *also* be searched as a person's name.
   *
   * True when nothing matched at all, and when the phrase is not a bare
   * qualifier: «مشتریان در خطر» is a queue, «مریم» is a person.
   */
  searchPeople: boolean;
}

/**
 * Words that carry no question of their own.
 *
 * Used by the leftover test below: after the vocabulary has consumed what it
 * recognises, whatever is left over is what the reader is *also* asking about —
 * «معامله‌های مریم» is a board and a person, and answering with only the board
 * would ignore half the sentence.
 */
const STOP_WORDS = new Set([
  "را", "و", "با", "در", "به", "از", "که", "چه", "کدام", "همه", "برای", "بدون",
  "های", "ها", "یک", "این", "آن", "تا", "بر", "روی", "می", "است", "بود",
]);

/** What is left of a phrase once every matched alias has been taken out. */
function leftoverWords(normalized: string, matched: readonly string[]): string[] {
  let rest = normalized;
  for (const alias of [...matched].sort((a, b) => b.length - a.length)) {
    rest = rest.split(alias).join(" ");
  }
  return rest
    .split(" ")
    .map((word) => word.trim())
    .filter((word) => word.length >= 3 && !STOP_WORDS.has(word));
}

function includesFolded(haystack: string, needle: string): boolean {
  return haystack.includes(needle);
}

/**
 * Interpret a phrase.
 *
 * Returns keys and hrefs only. The caller filters by permission *before*
 * rendering — a match the member cannot open is not a result, it is a locked
 * door with a label on it.
 */
export function interpretCrmCommand(text: string): CrmCommandInterpretation {
  const normalized = normalizeCrmPhrase(text);
  if (!normalized) return { normalized, matches: [], searchPeople: false };

  const scored: CrmCommandMatch[] = [];

  for (const section of CRM_SECTION_KEYS) {
    for (const alias of SECTION_ALIASES[section] ?? []) {
      const folded = normalizeCrmPhrase(alias);
      if (folded.length < 3 || !includesFolded(normalized, folded)) continue;
      scored.push({
        kind: "section",
        key: section,
        href: section === "overview" ? "/crm/overview" : `/crm/${section}`,
        matched: alias,
        section,
      });
    }
  }

  for (const key of CRM_QUEUE_KEYS) {
    const aliases = [CRM_QUEUE_PRESENTATION[key].label, ...QUEUE_ALIASES[key]];
    // The queue is rendered on the screen that owns it; the first owner is the
    // canonical one (a queue shared by deals and cases opens the deal board,
    // which shows both in its own queue list).
    const owner = CRM_QUEUE_PRESENTATION[key].sections[0] as CrmSectionKey | undefined;
    if (!owner) continue;
    for (const alias of aliases) {
      const folded = normalizeCrmPhrase(alias);
      if (folded.length < 3 || !includesFolded(normalized, folded)) continue;
      scored.push({
        kind: "queue",
        key,
        href: owner === "overview" ? "/crm/overview" : `/crm/${owner}`,
        matched: alias,
        section: owner,
      });
    }
  }

  // Longest match first: «سرنخ تازه» is a better answer than «سرنخ», and a
  // person who types a whole phrase means the whole phrase. A tie goes to the
  // **queue**: a named list of records is a more specific answer than the screen
  // it happens to live on, and the screen is one click away from it anyway.
  scored.sort((a, b) => {
    const byLength = normalizeCrmPhrase(b.matched).length - normalizeCrmPhrase(a.matched).length;
    if (byLength !== 0) return byLength;
    if (a.kind === b.kind) return 0;
    return a.kind === "queue" ? -1 : 1;
  });

  // One match per key: a queue that matched through two aliases is one result.
  const seen = new Set<string>();
  const matches = scored.filter((match) => {
    const id = `${match.kind}:${match.key}`;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });

  // Offer people when nothing matched — the directory is the honest fallback —
  // or when the phrase still carries a word the vocabulary does not know, which
  // is what a name looks like next to a qualifier.
  const leftover = leftoverWords(
    normalized,
    matches.map((match) => normalizeCrmPhrase(match.matched)),
  );
  const searchPeople = matches.length === 0 || leftover.length > 0;

  return { normalized, matches: matches.slice(0, 6), searchPeople };
}

/**
 * The permissions-filtered result the UI renders.
 *
 * Kept here rather than in the component so the rule is testable without a
 * renderer: a member is offered exactly the destinations they may open.
 */
export function availableCrmCommands<T extends CrmCommandMatch>(
  matches: readonly T[],
  canOpen: (section: CrmSectionKey) => boolean,
): T[] {
  return matches.filter((match) => canOpen(match.section));
}
