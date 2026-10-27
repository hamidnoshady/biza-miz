/**
 * Issue #1128 — the eight *operating profiles* of an advertising agency.
 *
 * One industry key, eight shapes. §"Agency operating profiles" is explicit that
 * these are presets **inside** `advertising_agency`, never separate keys: a
 * full-service agency, a digital/social shop, a branding studio, a media buyer,
 * an outdoor & print producer, a content/video studio, a PR & events agency and
 * a small agency or freelancer all keep the same chart of accounts, the same
 * four apps and the same permissions. What the profile changes is the *starting
 * point* — which project blueprint the workspace marks «پیشنهادی» and lists
 * first — so a two-person social-media shop is not handed an outdoor-production
 * sequence as its default and a media buyer is not handed a brand book.
 *
 * ## What a profile is not
 *
 * Nothing here decides *permissions*. This module holds no role, no permission
 * key and no capability switch, and `agency.test.ts` fails if one appears: the
 * issue's "presets … **never replace role authorization**" is the reason. Who
 * may open a screen is still the member's role and the platform permission
 * (`permissions.ts`), and which areas exist at all is the industry profile's
 * module set (`industry-profile.ts`). A profile only orders and labels choices
 * the member could already make.
 *
 * That is also why this is a *smaller* machine than AEC's (`aec.ts`): AEC's
 * profile presets nineteen capabilities because nineteen domains arrive wave by
 * wave and each needs a switch. An agency's eight profiles differ in what work
 * they run, not in which product areas they own — all eight buy media or
 * subcontract production or invoice a retainer through the same Accounting
 * documents. Copying AEC's capability layer here would have invented switches
 * with nothing behind them, which is the "preset machinery without a screen"
 * the issue's non-goals rule out.
 *
 * ## Combining specialties
 *
 * An agency may do branding *and* media buying. The stored setting therefore
 * keeps the primary profile plus any number of secondary ones: the primary
 * decides the blueprint ordering, the secondaries are labels a picker and later
 * reporting can read. Neither is a gate — a studio whose primary is
 * `branding_studio` still gets every agency blueprint in its list, exactly as
 * an AEC contractor renovating an office still gets «داخلی و بازسازی».
 */

import type { Industry } from "./industries";

/** The one industry key all eight profiles belong to. */
export const AGENCY_INDUSTRY: Industry = "advertising_agency";

export const AGENCY_OPERATING_PROFILES = [
  /** From strategy and creative through media buying to reporting. */
  "full_service",
  /** Paid social/search and organic content, run monthly. */
  "digital_social",
  /** Identity, packaging and design systems. */
  "branding_studio",
  /** Space and time buying on a management fee. */
  "media_buying",
  /** Billboards, banners, print and physical production. */
  "outdoor_print",
  /** Shoots, editing and content production. */
  "content_video",
  /** Media relations, launches and experiential work. */
  "pr_events",
  /** One or two people, several concurrent engagements. */
  "small_agency",
] as const;

export type AgencyOperatingProfile = (typeof AGENCY_OPERATING_PROFILES)[number];

export interface AgencyOperatingProfileDef {
  key: AgencyOperatingProfile;
  /** What the settings form shows as the choice's title. */
  label: string;
  /** One line saying what work this shape runs — the picker's only help text. */
  description: string;
}

/**
 * Labels and descriptions, in the order the picker lists them: the broadest
 * shape first and the smallest last, so an owner who is not sure yet reads down
 * a narrowing list rather than hunting.
 */
export const AGENCY_OPERATING_PROFILE_DEFS: Record<AgencyOperatingProfile, AgencyOperatingProfileDef> = {
  full_service: {
    key: "full_service",
    label: "آژانس تبلیغاتی تمام‌خدمات",
    description: "از استراتژی و خلاقیت تا خرید رسانه، اجرا و گزارش عملکرد؛ چند مشتری و چند کانال همزمان.",
  },
  digital_social: {
    key: "digital_social",
    label: "دیجیتال و شبکه‌های اجتماعی",
    description: "کمپین‌های کلیکی و اجتماعی، تقویم محتوای ماهانه و گزارش عملکرد کانال‌ها.",
  },
  branding_studio: {
    key: "branding_studio",
    label: "کانون برندینگ و استودیو خلاقیت",
    description: "هویت بصری، بسته‌بندی و سیستم طراحی؛ پروژه‌های تحکیمی با تحویل‌های مشخص و کتابچهٔ برند.",
  },
  media_buying: {
    key: "media_buying",
    label: "خرید رسانه و تبلیغات عملکردی",
    description: "بودجهٔ رسانه، خرید فضا و زمان و کارمزد مدیریت؛ پایش هزینه، سرنخ و بازگشت سرمایه.",
  },
  outdoor_print: {
    key: "outdoor_print",
    label: "تبلیغات محیطی، چاپ و تولید",
    description: "بیلبورد، بنر، چاپ و ساخت؛ مجوزها، پیمانکاران و هزینهٔ تولید مستقیم هر پروژه.",
  },
  content_video: {
    key: "content_video",
    label: "تولید محتوا و ویدیو",
    description: "فیلمبرداری، تدوین و تولید محتوا؛ نسخه‌های متعدد، بازبینی کارفرما و خروجی برای هر کانال.",
  },
  pr_events: {
    key: "pr_events",
    label: "روابط عمومی، رویداد و اجرا",
    description: "پوشش رسانه‌ای، رویداد و تجربهٔ میدانی؛ زمان‌بندی اجرا، تأمین‌کنندگان و گزارش نتایج.",
  },
  small_agency: {
    key: "small_agency",
    label: "آژانس کوچک یا فریلنسر",
    description: "یک یا دو نفر و چند پروژهٔ همزمان؛ صورتحساب ساعتی یا پروژه‌ای و تحویل‌های کوتاه.",
  },
};

/**
 * What an agency gets before it chooses: the broadest preset, because it is the
 * one whose recommended blueprints cover the most of the list. Mirrors
 * `AEC_DEFAULT_OPERATING_PROFILE`, and like it this is only a default — a
 * business with no stored profile still sees every agency blueprint.
 */
export const AGENCY_DEFAULT_OPERATING_PROFILE: AgencyOperatingProfile = "full_service";

/** Type guard for a value that came from the database, a request body or a URL. */
export function isAgencyOperatingProfile(value: string): value is AgencyOperatingProfile {
  return (AGENCY_OPERATING_PROFILES as readonly string[]).includes(value);
}

/** The picker's list: key plus the copy that renders next to it. */
export function agencyOperatingProfileOptions(): AgencyOperatingProfileDef[] {
  return AGENCY_OPERATING_PROFILES.map((key) => AGENCY_OPERATING_PROFILE_DEFS[key]);
}

/**
 * The stored shape of `SETTING_KEYS.agencyProfile` (settings.ts).
 *
 * A plain jsonb value in the shared key/value `settings` table rather than a
 * column or a table of its own: one business-wide choice, no history, nothing
 * to join. AEC needed `aec_business_profiles` because it stores nineteen
 * capability overrides and a specialty list per business; an agency preset is
 * one word, and `settings` already has the tenancy, the audit path and the
 * desktop-sync behaviour every other business-wide preference uses.
 */
export interface AgencyProfileSetting {
  /** The profile that decides blueprint ordering. */
  operatingProfile: AgencyOperatingProfile;
  /**
   * Additional shapes the same agency works in. Labels only — they never widen
   * what the business can open, and the first entry is never duplicated into
   * `operatingProfile`.
   */
  specialties: AgencyOperatingProfile[];
  /** ISO time of the last save, or null while nothing has been stored. */
  updatedAt: string | null;
}

const MAX_SPECIALTIES = AGENCY_OPERATING_PROFILES.length;

/**
 * Pure: reads the stored jsonb defensively and returns null when there is
 * nothing usable, so a caller can tell "never saved" from "saved".
 *
 * An unrecognised profile string is *not* coerced to the default: a value this
 * code does not know is a value written by a newer version or by hand, and
 * answering "full_service" would let a later save overwrite it silently. The
 * caller reports the default separately instead.
 *
 * `agency-service.ts` also uses this to validate a save request, by handing it
 * the body's fields with the current values standing in for the omitted ones —
 * one parser for both paths, so a shape the reader accepts is a shape the
 * writer can store.
 */
export function parseAgencyProfileSetting(raw: unknown): AgencyProfileSetting | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  const profile = value.operatingProfile;
  if (typeof profile !== "string" || !isAgencyOperatingProfile(profile)) return null;
  // A `specialties` that is present but not a list is a malformed write, not an
  // empty one: refusing it is what keeps "the reader accepts exactly what the
  // writer may store" true in both directions.
  if (value.specialties !== undefined && !Array.isArray(value.specialties)) return null;
  const specialties = Array.isArray(value.specialties)
    ? [
        ...new Set(
          value.specialties.filter(
            (key): key is AgencyOperatingProfile =>
              typeof key === "string" && isAgencyOperatingProfile(key) && key !== profile,
          ),
        ),
      ].slice(0, MAX_SPECIALTIES)
    : [];
  return {
    operatingProfile: profile,
    specialties,
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : null,
  };
}


