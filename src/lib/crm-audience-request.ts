/**
 * «همهٔ مشتریان تهران که پارسال خرید نکرده‌اند» — a sentence, turned into a rule
 * document.
 *
 * ## What this is
 *
 * The audience screen's rule builder is a closed vocabulary of fields and
 * operators (`segments.ts`), and this module is the *spoken* half of the same
 * vocabulary: it reads a Persian sentence and produces a `SegmentDefinition`
 * built only from rules the compiler already accepts. Nothing else.
 *
 * ## What it is not, and why the difference matters
 *
 * There is no model here, and no SQL. The output of `interpretAudienceRequest`
 * is a JSON document that `validateSegmentDefinition` must approve before the
 * screen will offer to create anything — so the worst a misunderstood sentence
 * can do is put the *wrong filter* in a form the member is looking at, with the
 * clauses it understood printed under the box and the words it did not printed
 * beside them. An LLM may later sit in front of this to choose among the same
 * fields; the guarantee — that a phrase can only ever select something the
 * audience builder can express — would not change.
 *
 * ## The rules that keep it honest
 *
 * - **It never invents a threshold.** «مشتریان وفادار» has no number in it, so
 *   there is no rule to build: the words come back as unread rather than as
 *   `orderCount >= 5`, which would be a decision the member never made and
 *   cannot see.
 * - **It never guesses between two readings.** «بیش از ۵۰۰ هزار تومان خرید
 *   کرده» is a *total*; «میانگین هر خرید بیش از ۵۰۰ هزار تومان» is an average,
 *   and only the words say which. «بیش از ۵۰۰ خرید کرده» is neither: 500 what?
 *   The amount is required to name its money and the count to name its noun, and
 *   the sentence that names neither is refused with a note saying so.
 * - **It refuses «یا» outright.** `SegmentDefinition` really does have an OR
 *   group, but «الف یا ب و پ» has two readings and the sentence did not choose
 *   one; the builder is where an OR is written deliberately.
 * - **It refuses birthday months.** `birthdayMonth` holds a *Gregorian* month
 *   number and «فروردین» is a Shamsi month with no fixed Gregorian number — a
 *   mapping here would send a birthday campaign in the wrong month. The refusal
 *   is a note, not just an unread word, so the member learns why.
 *
 * ## Money, once
 *
 * A rule holds integer **Rial** (the repo-wide storage convention) and the forms
 * take Toman. People speak Toman, so «تومان» is multiplied by ten exactly once
 * here, «ریال» is taken as written, and the clauses are printed back through
 * `describeRule` — so the number typed and the number stored are both visible.
 *
 * ## Words, kept as written
 *
 * Folding (`normalizeCrmPhrase`) is for *matching*: it erases the ZWNJ, maps
 * Arabic yeh/kaf and folds Persian digits, which is exactly wrong for a value
 * that will be compared against stored data. So the sentence is tokenised once,
 * each token keeps both its written and its folded form, and every captured
 * value — a tag, a city, an unread word — is handed back in its **original**
 * spelling. A tag read as «عمده‌فروشی» must match the tag the shop stored.
 */

import { normalizeCrmPhrase } from "./crm-commands";
import {
  describeRule,
  validateSegmentDefinition,
  type SegmentDefinition,
  type SegmentRule,
} from "./segments";

/** One clause of the sentence, and the words that produced it. */
export interface AudienceRequestClause {
  rule: SegmentRule;
  /** The words this clause consumed, as the member wrote them. */
  matched: string;
}

export interface AudienceRequestInterpretation {
  /** The folded sentence, for the «فهمیدم» line. */
  normalized: string;
  clauses: AudienceRequestClause[];
  /** Only ever rules this module wrote from the closed field/operator union. */
  definition: SegmentDefinition;
  /** Words with no rule behind them. A request with any of these is not usable. */
  unread: string[];
  /** Refusals that deserve a sentence of their own (see the birthday note). */
  notes: string[];
  /** `validateSegmentDefinition` on the produced document — belt and braces. */
  problems: string[];
  /** True when there is at least one clause and nothing was left unexplained. */
  ok: boolean;
}

/** Sentences to show as examples — each one is pinned by a test. */
export const AUDIENCE_REQUEST_EXAMPLES = [
  "ساکن تهران و ۹۰ روز است خرید نکرده‌اند",
  "بیش از ۱ میلیون تومان خرید کرده‌اند و ایمیل دارند",
  "مشتریان غیرفعال با برچسب عمده‌فروشی",
] as const;

/** Words that carry no question of their own, so they are not «unread». */
const STOP_WORDS = new Set([
  "مشتری",
  "مشتریان",
  "مشتریانی",
  "خریداران",
  "مشتریهای",
  "مشتریهایی",
  "افراد",
  "کسانی",
  "که",
  "و",
  "یا",
  "با",
  "بدون",
  "در",
  "به",
  "از",
  "را",
  "برای",
  "این",
  "آن",
  "همه",
  "هر",
  "یک",
  "است",
  "هستند",
  "بوده",
  "شده",
  "شدهاند",
  "کرده",
  "کردهاند",
  "کردند",
  "داده",
  "دادهاند",
  "دارند",
  "دارد",
  "ندارند",
  "ندارد",
  "نیستند",
  "نیست",
  "حداقل",
  "حداکثر",
  "بیش",
  "بیشتر",
  "کمتر",
  "بالای",
  "بالاتر",
  "زیر",
  "روز",
  "هفته",
  "ماه",
  "سال",
  "اخیر",
  "گذشته",
  "قبل",
  "پیش",
  "تومان",
  "تومن",
  "ریال",
  "هزار",
  "میلیون",
  "میلیارد",
  "خرید",
  "خریدند",
  "سفارش",
  "بار",
  "مرتبه",
  "فاکتور",
  "نکرده",
  "نکردهاند",
  "نکردند",
  "نیامده",
  "نیامدهاند",
  "نداشته",
  "نداشتهاند",
  "امتیاز",
  "بدهی",
  "بدهکار",
]);

/** affirmative / negative markers, as folded forms. */
const YES_WORDS = ["دارند", "دارد", "هستند", "هست", "داده", "دادهاند", "میدهند"];
const NO_WORDS = ["ندارند", "ندارد", "نیستند", "نیست", "نداده", "ندادهاند", "نمیدهند"];
const YES = YES_WORDS.join("|");
const NO = NO_WORDS.join("|");

/** «بیش از» / «کمتر از», longest alternative first. */
const GTE = "بیش از|بیشتر از|بالاتر از|بالای|حداقل";
const LTE = "کمتر از|پایین‌تر از|حداکثر|زیر";
const ANY_COMPARATOR = `${GTE}|${LTE}`;

/** The money pattern, with its three groups: amount, scale, currency. */
const MONEY_PATTERN = "(\\d+)\\s*(میلیارد|میلیون|هزار)?\\s*(تومان|تومن|ریال)";

const UNIT_DAYS: Record<string, number> = { روز: 1, هفته: 7, ماه: 30, سال: 365 };
const SCALE: Record<string, number> = {
  "": 1,
  هزار: 1_000,
  میلیون: 1_000_000,
  میلیارد: 1_000_000_000,
};
/** Rial per unit of the word used: the repo stores Rial, people speak Toman. */
const CURRENCY: Record<string, number> = { تومان: 10, تومن: 10, ریال: 1 };

/** A character that is not whitespace, so a pattern can never span a read clause. */
const FILLER = "\u0000";

interface Token {
  /** As the member wrote it, minus sentence punctuation. */
  original: string;
  /** As the vocabulary compares it. */
  folded: string;
  start: number;
  end: number;
}

interface Taken {
  /** The covered tokens, in order. */
  tokens: Token[];
  /** Their original spelling, for the «what I read» line. */
  span: string;
  groups: RegExpMatchArray;
}

/**
 * A sentence as tokens, each carrying its written and its folded form.
 *
 * Matching happens on the folded text; *reading* — a tag, a city, a word the
 * module could not use — always answers with the written form. Blanking a taken
 * clause replaces it with a non-space filler, so no later pattern can reach
 * across a clause that has already been understood (and the offsets stay put,
 * which is what makes covering tokens by match offset exact).
 */
class Phrase {
  readonly text: string;
  private readonly tokens: Token[];
  private readonly taken = new Set<Token>();
  private buffer: string;

  constructor(sentence: string) {
    this.tokens = [];
    let cursor = 0;
    for (const raw of sentence.trim().split(/\s+/)) {
      const original = raw.replace(/[.,،؛:!؟]+$/g, "").trim();
      const folded = normalizeCrmPhrase(original);
      if (!folded) continue;
      this.tokens.push({ original, folded, start: cursor, end: cursor + folded.length });
      cursor += folded.length + 1;
    }
    this.text = this.tokens.map((token) => token.folded).join(" ");
    this.buffer = this.text;
  }

  /** Take the first match of `pattern`, and hand back the tokens it covered. */
  take(pattern: RegExp): Taken | null {
    const match = pattern.exec(this.buffer);
    if (!match) return null;
    const from = match.index;
    const to = from + match[0].length;
    const covered = this.tokens.filter(
      (token) => !this.taken.has(token) && token.start < to && token.end > from,
    );
    if (covered.length === 0) return null;
    for (const token of covered) {
      this.taken.add(token);
      this.buffer =
        this.buffer.slice(0, token.start) +
        FILLER.repeat(token.end - token.start) +
        this.buffer.slice(token.end);
    }
    return {
      tokens: covered,
      span: covered.map((token) => token.original).join(" "),
      groups: match,
    };
  }

  /**
   * The value of a captured group, in the member's own spelling.
   *
   * The value is always the *tail* of the match (a tag, a city), so its tokens
   * are the last ones covered; connectives at the edges («… و ایمیل دارند») are
   * the sentence's punctuation rather than part of the value.
   */
  value(taken: Taken, group: number): string {
    const words = (taken.groups[group] ?? "").trim().split(/\s+/).filter(Boolean);
    const tail = taken.tokens.slice(Math.max(0, taken.tokens.length - words.length));
    return tail
      .map((token) => token.original)
      .filter((word) => !STOP_WORDS.has(normalizeCrmPhrase(word)))
      .join(" ")
      .trim();
  }

  /** Whether the taken words include a negation. */
  negated(taken: Taken): boolean {
    return taken.tokens.some((token) => NO_WORDS.includes(token.folded));
  }

  /** Every word this module did not manage to read, as written. */
  leftover(): string[] {
    return this.tokens
      .filter((token) => !this.taken.has(token))
      .map((token) => token.original)
      .filter(
        (word) =>
          (word.length >= 2 || /^\d+$/.test(normalizeCrmPhrase(word))) &&
          !STOP_WORDS.has(normalizeCrmPhrase(word)),
      );
  }
}

/** Amount in Rial from a match whose amount group is `index`. */
function rial(match: RegExpMatchArray, index: number): number {
  const amount = Number(normalizeCrmPhrase(match[index] ?? "0"));
  const scale = SCALE[match[index + 1] ?? ""] ?? 1;
  const currency = CURRENCY[match[index + 2] ?? "ریال"] ?? 1;
  return Math.round(amount * scale * currency);
}

/**
 * Read a sentence.
 *
 * The patterns run in a fixed order — money before counts (an amount names its
 * currency and a count names its noun, so neither can steal the other), rates
 * before durations, durations before booleans (a boolean marker can follow a
 * duration) — and each match blanks its own words, so the order is a statement
 * about precedence rather than about meaning.
 */
export function interpretAudienceRequest(sentence: string): AudienceRequestInterpretation {
  const phrase = new Phrase(sentence);
  const clauses: AudienceRequestClause[] = [];
  const notes: string[] = [];
  const add = (rule: SegmentRule, span: string) => clauses.push({ rule, matched: span });

  // --- Money: total spent, or the average order when the words say so. ------
  const leading = phrase.take(new RegExp(`(میانگین|هر خرید|هر سفارش)?\\s*(?:${GTE})\\s*${MONEY_PATTERN}`));
  if (leading) {
    // Groups: 1 the average marker, 2-4 the amount, so `rial` reads from 2.
    add(
      {
        field: leading.groups[1] ? "averageOrderRial" : "totalSpentRial",
        op: "gte",
        value: rial(leading.groups, 2),
      },
      leading.span,
    );
  } else {
    // A comparator may trail instead: «۵۰۰ هزار تومان کمتر». Same rule, so both
    // spellings are read and both are printed back in the builder's words.
    const trailing =
      phrase.take(new RegExp(`(?:${LTE})\\s*${MONEY_PATTERN}`)) ??
      phrase.take(new RegExp(`${MONEY_PATTERN}\\s*(?:${LTE})`));
    if (trailing) add({ field: "totalSpentRial", op: "lte", value: rial(trailing.groups, 1) }, trailing.span);
  }

  // --- How many purchases. The noun is required: «بیش از ۵۰۰ خرید کرده» could
  // be 500 purchases or 500 Toman, and the sentence did not say which. --------
  for (const [op, comparator] of [
    ["gte", GTE],
    ["lte", LTE],
  ] as const) {
    const taken = phrase.take(new RegExp(`(?:${comparator})\\s*(\\d+)\\s*(سفارش|بار|مرتبه|فاکتور)`));
    if (taken) {
      add({ field: "orderCount", op, value: Number(taken.groups[1]) }, taken.span);
    }
  }

  // --- Loyalty points. ------------------------------------------------------
  for (const [op, comparator] of [
    ["gte", GTE],
    ["lte", LTE],
  ] as const) {
    const taken = phrase.take(new RegExp(`(?:${comparator})\\s*(\\d+)\\s*امتیاز`));
    if (taken) add({ field: "loyaltyPoints", op, value: Number(taken.groups[1]) }, taken.span);
  }

  // --- Outstanding money. «Owes money» is the smallest positive amount and
  // «not a debtor» is zero: both are what the words say, not a chosen figure. --
  const debtor = phrase.take(new RegExp(`بدهکار\\s*(?:${NO})?`));
  if (debtor) {
    const negated = phrase.negated(debtor);
    add({ field: "receivableRial", op: negated ? "lte" : "gte", value: negated ? 0 : 1 }, debtor.span);
  } else {
    const owes = phrase.take(new RegExp(`بدهی\\s*(?:${YES}|${NO})`));
    if (owes) {
      const negated = phrase.negated(owes);
      add({ field: "receivableRial", op: negated ? "lte" : "gte", value: negated ? 0 : 1 }, owes.span);
    }
  }

  // --- Recency: «۹۰ روز است خرید نکرده‌اند» / «در ۳۰ روز اخیر خرید کرده‌اند». --
  const winback = phrase.take(
    new RegExp(
      `(?:بیش از\\s*)?(\\d+)\\s*(روز|هفته|ماه|سال)\\s*(?:است|هست)?\\s*(?:که)?\\s*(?:خرید|سفارش|مراجعه|تماس)?\\s*(?:نکرده|نکرده‌اند|نکردند|نیامده|نیامده‌اند|نداشته|نداشته‌اند)`,
    ),
  );
  if (winback) {
    add(
      { field: "lastPurchaseAt", op: "before", days: Number(winback.groups[1]) * UNIT_DAYS[winback.groups[2]] },
      winback.span,
    );
  } else {
    // The verb is required here: without it, «۳۰ روز اخیر ثبت شده» is tenure,
    // not a purchase, and reading it as one would filter on the wrong field.
    const recent = phrase.take(
      new RegExp(
        `(\\d+)\\s*(روز|هفته|ماه|سال)\\s*(?:اخیر|گذشته|قبل)\\s*(?:خرید|سفارش|مراجعه|تماس)\\s*(?:کرده|کرده‌اند|کردند|داشته|داشته‌اند)`,
      ),
    );
    if (recent) {
      add(
        { field: "lastPurchaseAt", op: "after", days: Number(recent.groups[1]) * UNIT_DAYS[recent.groups[2]] },
        recent.span,
      );
    }
  }

  // --- Tenure: when the record appeared («۳۰ روز اخیر ثبت شده‌اند»). -----------
  const tenure = phrase.take(
    new RegExp(
      `(?:بیش از\\s*)?(\\d+)\\s*(روز|هفته|ماه|سال)\\s*(پیش|اخیر)?\\s*(?:ثبت|عضو|ایجاد)\\s*(?:شده|شده‌اند)?`,
    ),
  );
  if (tenure) {
    add(
      {
        field: "createdAt",
        op: tenure.groups[3] === "اخیر" ? "after" : "before",
        days: Number(tenure.groups[1]) * UNIT_DAYS[tenure.groups[2]],
      },
      tenure.span,
    );
  }

  // --- Contactability and consent. -----------------------------------------
  const boolean = (
    pattern: RegExp,
    field: "hasEmail" | "smsConsent" | "marketingConsent",
  ) => {
    const taken = phrase.take(pattern);
    if (!taken) return;
    add({ field, op: "is", value: !phrase.negated(taken) }, taken.span);
  };
  boolean(new RegExp(`ایمیل\\s*(?:${YES}|${NO})`), "hasEmail");
  boolean(new RegExp(`(?:رضایت|اجازه)\\s*(?:پیامک|اس‌ام‌اس|اس ام اس)\\s*(?:${YES}|${NO})`), "smsConsent");
  boolean(new RegExp(`(?:رضایت|اجازه)\\s*بازاریابی\\s*(?:${YES}|${NO})`), "marketingConsent");
  boolean(new RegExp(`(?:پیامک|اس‌ام‌اس)\\s*(?:${YES}|${NO})`), "smsConsent");
  boolean(new RegExp(`بازاریابی\\s*(?:${YES}|${NO})`), "marketingConsent");

  // --- Active or not. «غیرفعال» is taken first, or its tail would read as
  // «فعال» — the one place where a suffix changes the meaning. ----------------
  const inactive = phrase.take(/غیرفعال/);
  if (inactive) {
    add({ field: "isActive", op: "is", value: false }, inactive.span);
  } else {
    const active = phrase.take(/فعال/);
    if (active) add({ field: "isActive", op: "is", value: true }, active.span);
  }

  // --- Tags and place: free text, captured as written. ----------------------
  const untagged = phrase.take(/(?:بدون)\s*(?:برچسب|تگ)(?:‌های|‌ها|های|ها)?\s*([^\s,،]+(?:\s+[^\s,،]+)?)/);
  if (untagged) {
    add({ field: "tags", op: "hasNone", values: [phrase.value(untagged, 1)] }, untagged.span);
  } else {
    const tagged = phrase.take(/(?:برچسب|تگ)(?:‌های|‌ها|های|ها)?\s+([^\s,،]+(?:\s+[^\s,،]+)?)/);
    if (tagged) add({ field: "tags", op: "hasAny", values: [phrase.value(tagged, 1)] }, tagged.span);
  }

  const located = phrase.take(/(?:ساکن|اهل)\s+([^\s,،]+(?:\s+[^\s,،]+)?)/);
  if (located) add({ field: "city", op: "contains", value: phrase.value(located, 1) }, located.span);

  // --- Refusals that deserve an explanation. --------------------------------
  if (/تولد|متولد/.test(phrase.text.replace(new RegExp(FILLER, "g"), " "))) {
    notes.push(
      "ماه تولد اینجا خوانده نمی‌شود: تاریخ تولد میلادی ذخیره می‌شود و «فروردین» عدد میلادی ثابتی ندارد؛ این شرط را در فرم بخش بسازید.",
    );
  }
  // Persian has no ASCII word boundary, so «یا» is found by token, not by `\b`.
  if (sentence.split(/\s+/).some((word) => normalizeCrmPhrase(word) === "یا")) {
    notes.push("«یا» خوانده نشد: شرط‌های «یا» را در فرم بخش بسازید تا معنایشان روشن بماند.");
  }
  if (clauses.length === 0 && /\d/.test(normalizeCrmPhrase(sentence))) {
    notes.push(
      "شمار یا مبلغ بی‌واحد خوانده نشد: برای تعداد «سفارش» یا «بار» بنویسید و برای مبلغ واحد پول (تومان یا ریال) را بیاورید.",
    );
  }

  const unread = phrase.leftover();
  const definition: SegmentDefinition =
    clauses.length > 0 ? { all: clauses.map((clause) => clause.rule) } : {};
  const problems = validateSegmentDefinition(definition).filter(
    (problem) => !/تعریف بخش باید/.test(problem),
  );
  const ok = clauses.length > 0 && unread.length === 0 && problems.length === 0;

  return {
    normalized: normalizeCrmPhrase(sentence),
    clauses,
    definition,
    unread,
    notes,
    problems,
    ok,
  };
}

/**
 * The clauses, described with the audience builder's own words.
 *
 * `describeRule` is the function the segment card and the builder's summary use,
 * so «what I understood» is written in the vocabulary the member is looking at
 * rather than in a second dialect invented for the box.
 */
export function describeAudienceRequest(
  interpretation: AudienceRequestInterpretation,
  formatMoney: (rial: number) => string,
): string[] {
  return interpretation.clauses.map((clause) => describeRule(clause.rule, formatMoney));
}
