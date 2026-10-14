/**
 * The spoken audience request, read back.
 *
 * Three properties, in the order they matter:
 *
 *  1. **What it understands, it understands the way the builder does.** Every
 *     sentence here produces rules from the closed field/operator union, with
 *     money converted from Toman to Rial exactly once, and the clauses printed
 *     back through `describeRule` — the same words the segment card uses.
 *  2. **What it does not understand, it says.** A word with no rule behind it
 *     comes back in `unread`, the interpretation is `ok: false`, and the screen
 *     therefore offers no way to create the segment. There is no default
 *     threshold anywhere in this module: «مشتریان وفادار» is not five orders.
 *  3. **It cannot reach a query.** The module imports the vocabulary and the
 *     validator, never the database; the fields it emits are checked against
 *     `isSegmentField`, so a phrase can only ever select something the audience
 *     builder can express.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  AUDIENCE_REQUEST_EXAMPLES,
  describeAudienceRequest,
  interpretAudienceRequest,
} from "./crm-audience-request";
import { isSegmentField, validateSegmentDefinition, type SegmentRule } from "./segments";

const SOURCE = readFileSync(
  fileURLToPath(new URL("./crm-audience-request.ts", import.meta.url)),
  "utf8",
);

/** Every rule of an interpretation, whichever group it landed in. */
function rules(sentence: string): SegmentRule[] {
  const { definition } = interpretAudienceRequest(sentence);
  return [...(definition.all ?? []), ...(definition.any ?? [])];
}

const read = (sentence: string) => interpretAudienceRequest(sentence);

describe("money", () => {
  it("reads Toman, stores Rial, once", () => {
    // ۱ میلیون تومان = 10,000,000 Rial. The rule holds Rial like every other
    // money value in the repo; the sentence is spoken in Toman like every other
    // form in the app.
    expect(rules("بیش از ۱ میلیون تومان خرید کرده‌اند")).toEqual([
      { field: "totalSpentRial", op: "gte", value: 10_000_000 },
    ]);
    expect(rules("کمتر از ۲۰۰ هزار تومان")).toEqual([
      { field: "totalSpentRial", op: "lte", value: 2_000_000 },
    ]);
  });

  it("takes ریال as written rather than converting it", () => {
    expect(rules("بیش از ۵۰۰۰۰۰ ریال")).toEqual([
      { field: "totalSpentRial", op: "gte", value: 500_000 },
    ]);
  });

  it("reads the average only when the sentence says average", () => {
    expect(rules("میانگین هر خرید بیش از ۵۰۰ هزار تومان")).toEqual([
      { field: "averageOrderRial", op: "gte", value: 5_000_000 },
    ]);
    // Without those words it is the lifetime total — the reading an owner means
    // by «بیش از … خرید کرده».
    expect(rules("بیش از ۵۰۰ هزار تومان خرید کرده")).toEqual([
      { field: "totalSpentRial", op: "gte", value: 5_000_000 },
    ]);
  });

  it("refuses an amount with no unit instead of guessing Toman or Rial", () => {
    const interpretation = read("مشتریانی که بیش از ۵۰۰ خرید کرده‌اند");
    expect(interpretation.clauses).toEqual([]);
    // Reported in the member's own spelling: «۵۰۰» is what they typed, and
    // folding it to ASCII in a refusal would be a second kind of noise.
    expect(interpretation.unread).toContain("۵۰۰");
    expect(interpretation.ok).toBe(false);
  });
});

describe("purchases and points", () => {
  it("counts orders", () => {
    expect(rules("مشتریان با بیش از ۵ سفارش")).toEqual([
      { field: "orderCount", op: "gte", value: 5 },
    ]);
    expect(rules("کمتر از ۲ سفارش")).toEqual([{ field: "orderCount", op: "lte", value: 2 }]);
  });

  it("counts loyalty points", () => {
    expect(rules("حداقل ۱۰۰ امتیاز")).toEqual([
      { field: "loyaltyPoints", op: "gte", value: 100 },
    ]);
  });

  it("reads a debtor as owing something, not as a threshold nobody chose", () => {
    // «Owes money» is the smallest positive amount, and «not a debtor» is zero —
    // both are facts of the phrase rather than invented numbers.
    expect(rules("مشتریان بدهکار")).toEqual([
      { field: "receivableRial", op: "gte", value: 1 },
    ]);
    expect(rules("مشتریان بدهکار نیستند")).toEqual([
      { field: "receivableRial", op: "lte", value: 0 },
    ]);
  });
});

describe("time", () => {
  it("reads a win-back sentence with the shop's own units", () => {
    expect(rules("۹۰ روز است خرید نکرده‌اند")).toEqual([
      { field: "lastPurchaseAt", op: "before", days: 90 },
    ]);
    expect(rules("بیش از ۶ ماه است که خرید نکرده‌اند")).toEqual([
      { field: "lastPurchaseAt", op: "before", days: 180 },
    ]);
  });

  it("reads recent buyers as an `after` bound", () => {
    expect(rules("در ۳۰ روز اخیر خرید کرده‌اند")).toEqual([
      { field: "lastPurchaseAt", op: "after", days: 30 },
    ]);
  });

  it("reads when the record appeared, in both directions", () => {
    expect(rules("در ۳۰ روز اخیر ثبت شده‌اند")).toEqual([
      { field: "createdAt", op: "after", days: 30 },
    ]);
    expect(rules("بیش از ۲ سال پیش ثبت شده")).toEqual([
      { field: "createdAt", op: "before", days: 730 },
    ]);
  });
});

describe("contactability", () => {
  it("reads consent and reachability as the flags they are", () => {
    expect(rules("ایمیل دارند")).toEqual([{ field: "hasEmail", op: "is", value: true }]);
    expect(rules("رضایت پیامک داده‌اند")).toEqual([
      { field: "smsConsent", op: "is", value: true },
    ]);
    expect(rules("رضایت پیامک ندارند")).toEqual([
      { field: "smsConsent", op: "is", value: false },
    ]);
    expect(rules("رضایت بازاریابی ندارند")).toEqual([
      { field: "marketingConsent", op: "is", value: false },
    ]);
  });

  it("reads active and inactive without confusing the two", () => {
    expect(rules("مشتریان فعال")).toEqual([{ field: "isActive", op: "is", value: true }]);
    expect(rules("مشتریان غیرفعال")).toEqual([{ field: "isActive", op: "is", value: false }]);
  });

  it("reads a tag or a city as free text in a bound value", () => {
    expect(rules("با برچسب عمده‌فروشی")).toEqual([
      { field: "tags", op: "hasAny", values: ["عمده‌فروشی"] },
    ]);
    expect(rules("بدون برچسب vip")).toEqual([
      { field: "tags", op: "hasNone", values: ["vip"] },
    ]);
    expect(rules("ساکن تهران")).toEqual([{ field: "city", op: "contains", value: "تهران" }]);
  });
});

describe("composition", () => {
  it("ands the clauses of one sentence", () => {
    const interpretation = read("ساکن تهران و بیش از ۱ میلیون تومان خرید کرده‌اند و ایمیل دارند");
    expect(interpretation.ok).toBe(true);
    expect(interpretation.unread).toEqual([]);
    expect(interpretation.definition.all).toEqual([
      { field: "totalSpentRial", op: "gte", value: 10_000_000 },
      { field: "hasEmail", op: "is", value: true },
      { field: "city", op: "contains", value: "تهران" },
    ]);
    // Every rule goes into `all`: the sentence has no OR in it, and the builder
    // is where an OR group is written.
    expect(interpretation.definition.any).toBeUndefined();
  });

  it("describes what it understood in the builder's own words", () => {
    const lines = describeAudienceRequest(read("حداقل ۵ سفارش و ایمیل دارند"), (rial) =>
      `${rial} ریال`,
    );
    // The builder's own spelling of that rule, digits and all: the box shows the
    // same sentence the segment card will, rather than a second rendering of it.
    expect(lines).toEqual(["حداقل 5 خرید", "ایمیل دارد"]);
  });
});

describe("refusals", () => {
  it("returns the words it could not read, and nothing else", () => {
    const interpretation = read("مشتریان خوش‌شانس");
    expect(interpretation.clauses).toEqual([]);
    expect(interpretation.definition).toEqual({});
    expect(interpretation.unread).toEqual(["خوش‌شانس"]);
    expect(interpretation.ok).toBe(false);
  });

  it("invents no threshold for a word with no number in it", () => {
    // The temptation is to map «وفادار» onto «۵ خرید یا بیشتر». That would be a
    // rule the member never wrote and cannot see, which is the failure this
    // whole module is shaped to avoid.
    const interpretation = read("مشتریان وفادار");
    expect(interpretation.clauses).toEqual([]);
    expect(interpretation.ok).toBe(false);
    expect(interpretation.unread).toContain("وفادار");
  });

  it("refuses an OR rather than giving it a precedence", () => {
    const interpretation = read("ساکن تهران یا اصفهان");
    expect(interpretation.ok).toBe(false);
    expect(interpretation.notes.join(" ")).toContain("«یا»");
  });

  it("refuses a birthday month, and says why", () => {
    // `birthdayMonth` holds a Gregorian number and «فروردین» is a Shamsi month:
    // a mapping here would send the campaign in the wrong month.
    const interpretation = read("متولدین فروردین");
    expect(interpretation.clauses).toEqual([]);
    expect(interpretation.ok).toBe(false);
    expect(interpretation.notes.join(" ")).toContain("ماه تولد");
  });

  it("keeps a half-read sentence from being usable", () => {
    const interpretation = read("ساکن تهران و مشتریان خوش‌شانس");
    expect(interpretation.clauses).toHaveLength(1);
    expect(interpretation.unread).toEqual(["خوش‌شانس"]);
    // One good clause is not enough: the screen may only offer to create the
    // segment when the whole sentence was understood.
    expect(interpretation.ok).toBe(false);
  });
});

describe("the vocabulary is the builder's, and the module is pure", () => {
  it("emits only fields the compiler knows", () => {
    for (const sentence of [
      "ساکن تهران و بیش از ۱ میلیون تومان خرید کرده‌اند",
      "۹۰ روز است خرید نکرده‌اند و بدهکار نیستند",
      "میانگین هر خرید بیش از ۵۰۰ هزار تومان و حداقل ۱۰۰ امتیاز",
      "در ۳۰ روز اخیر ثبت شده‌اند و رضایت بازاریابی دارند",
      "غیرفعال با برچسب نوروزی",
    ]) {
      for (const rule of rules(sentence)) {
        expect(isSegmentField(rule.field), `${sentence} → ${rule.field}`).toBe(true);
      }
    }
  });

  it("passes the validator on every example it shows", () => {
    for (const sentence of AUDIENCE_REQUEST_EXAMPLES) {
      const interpretation = read(sentence);
      expect(interpretation.problems, sentence).toEqual([]);
      expect(interpretation.ok, sentence).toBe(true);
      expect(validateSegmentDefinition(interpretation.definition), sentence).toEqual([]);
    }
  });

  it("cannot reach the database, and holds no SQL", () => {
    // The safety property is structural: this module has no query builder, no
    // `db` import, and no SQL word in it. A phrase can choose fields, never
    // write a statement.
    expect(SOURCE).not.toMatch(/from "\.\/db"/);
    expect(SOURCE).not.toMatch(/\bSELECT\b|\bWHERE\b|\bINSERT\b|\bUPDATE\b/);
  });
});
