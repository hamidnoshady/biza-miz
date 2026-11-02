/**
 * Issue #908 — the Persian sentences of the contract surface, in one file.
 *
 * Two audiences read these strings: the internal workspace (statuses, delivery
 * reasons, validation) and the external signatory (invitation, consent, OTP,
 * receipt). Keeping them out of the services means the public page never ships
 * a database import just to print «امضا شد», and means a wording change is a
 * review of one file rather than a hunt through queries.
 */
import type {
  ContractEnvelopeStatus,
  ContractSignerStatus,
  ContractSigningMode,
  SigningSessionFailure,
} from "./view";

export const ENVELOPE_STATUS_LABELS: Record<ContractEnvelopeStatus, string> = {
  draft: "پیش‌نویس درخواست امضا",
  sent: "ارسال‌شده",
  partially_signed: "نیمه‌امضا",
  completed: "همهٔ امضاها کامل",
  declined: "رد‌شده",
  cancelled: "لغو‌شده",
  expired: "منقضی",
};

export const SIGNER_STATUS_LABELS: Record<ContractSignerStatus, string> = {
  pending: "در انتظار ارسال",
  invited: "دعوت‌شده",
  opened: "سند را باز کرد",
  acknowledged: "مطالعه را تأیید کرد",
  signed: "امضا کرد",
  declined: "امضا نکرد",
  expired: "باطل‌شده (درخواست لغو شد)",
};

export const SIGNING_MODE_LABELS: Record<ContractSigningMode, string> = {
  parallel: "هم‌زمان (هر ترتیبی)",
  sequential: "به‌ترتیب",
};

export const SIGNING_MODE_HINTS: Record<ContractSigningMode, string> = {
  parallel: "همهٔ طرف‌ها از همان لحظه می‌توانند امضا کنند.",
  sequential: "هر طرف پس از امضای طرف قبلی دعوت می‌شود.",
};

export const DELIVERY_REASON_LABELS: Record<string, string> = {
  sms_not_configured: "ارسال پیامک روی این نصب تنظیم نشده است؛ لینک را دستی بفرستید.",
  sms_not_available: "سرویس پیامک در دسترس نیست؛ لینک را دستی بفرستید.",
  sms_rejected: "سرویس پیامک این پیام را نپذیرفت؛ لینک را دستی بفرستید.",
  no_live_link: "لینک فعالی برای این طرف وجود ندارد؛ دوباره دعوت بسازید.",
  sequential_later: "به‌ترتیب امضا می‌شود؛ این طرف پس از امضای نفر قبلی دعوت می‌شود.",
};

export const SIGNING_EVENT_LABELS: Record<string, string> = {
  version_frozen: "نسخهٔ سند ثابت شد",
  envelope_created: "پیش‌نویس درخواست امضا ساخته شد",
  signers_saved: "فهرست امضاکنندگان ذخیره شد",
  signed_document_finalized: "نسخهٔ نهایی امضاها ثبت شد",
  otp_sent: "کد تأیید فرستاده شد",
  envelope_sent: "درخواست امضا ارسال شد",
  invitation_sent: "دعوت‌نامه ارسال شد",
  invitation_failed: "ارسال دعوت‌نامه ناموفق بود",
  invitation_rotated: "لینک امضا تازه شد",
  invitation_revoked: "لینک امضا باطل شد",
  invited: "دعوت شد",
  opened: "سند را باز کرد",
  acknowledged: "مطالعهٔ سند را تأیید کرد",
  otp_requested: "کد تأیید درخواست شد",
  otp_verified: "شمارهٔ همراه تأیید شد",
  otp_failed: "کد تأیید نادرست بود",
  signed: "امضا کرد",
  declined: "امضا را رد کرد",
  envelope_completed: "همهٔ امضاها کامل شد",
  envelope_cancelled: "درخواست امضا لغو شد",
  envelope_expired: "مهلت امضا گذشت",
  envelope_declined: "درخواست امضا رد شد",
};

export const SIGNING_FAILURE_LABELS: Record<SigningSessionFailure | string, string> = {
  link_expired: "مهلت این لینک امضا تمام شده است. از طرف قرارداد لینک تازه بخواهید.",
  link_revoked: "این لینک امضا باطل شده است. از طرف قرارداد لینک تازه بخواهید.",
  signing_envelope_not_live: "این درخواست امضا بسته شده است.",
  signing_already_signed: "شما این سند را امضا کرده‌اید؛ همین صفحه رسید شماست.",
  signing_not_your_turn: "نوبت امضای شما هنوز نرسیده است.",
  signer_declined: "شما امضای این سند را رد کرده‌اید.",
  otp_required: "برای امضا ابتدا شمارهٔ همراه خود را با کد تأیید کنید.",
  turn_pending: "نوبت امضای شما هنوز نرسیده است.",
};

/** Server error codes → the sentence the sender or signer reads. */
export const CONTRACT_ERROR_MESSAGES: Record<string, string> = {
  contract_document_not_found: "سند این قرارداد پیدا نشد.",
  contract_document_conflict: "نسخهٔ سند در جای دیگری تغییر کرده است؛ نسخهٔ تازه را بارگذاری کنید.",
  contract_document_incomplete: "پیش از ارسال، خطاهای سند را برطرف کنید.",
  contract_document_not_frozen: "سند هنوز نهایی نشده است.",
  invalid_revision: "درخواست ذخیره معتبر نیست؛ سند را دوباره بارگذاری کنید.",
  contract_template_not_found: "قالب انتخاب‌شده پیدا نشد.",
  template_name_required: "نام قالب را وارد کنید.",
  template_content_required: "محتوای قالب خالی است.",
  signer_required: "دست‌کم یک امضاکننده لازم است.",
  signers_required: "دست‌کم یک امضاکننده لازم است.",
  too_many_signers: "تعداد امضاکنندگان بیش از حد مجاز است.",
  signer_name_required: "نام امضاکننده را وارد کنید.",
  signer_phone_invalid: "شمارهٔ همراه امضاکننده معتبر نیست.",
  signer_phone_duplicate: "این شماره برای دو امضاکننده استفاده شده است.",
  signer_slot_invalid: "جای امضای انتخاب‌شده در سند وجود ندارد.",
  signer_slot_duplicate: "دو امضاکننده نمی‌توانند یک جای امضا داشته باشند.",
  signer_not_found: "امضاکننده پیدا نشد.",
  signer_already_signed: "این طرف سند را امضا کرده است.",
  signer_declined: "این طرف امضا را رد کرده است.",
  signers_incomplete: "برای همهٔ جای‌های امضا، امضاکننده تعیین کنید.",
  signing_envelope_not_found: "درخواست امضا پیدا نشد.",
  signing_envelope_not_draft: "این درخواست امضا ارسال شده و قابل ویرایش نیست.",
  signing_envelope_not_live: "این درخواست امضا دیگر فعال نیست.",
  signing_already_live: "یک درخواست امضای فعال برای این قرارداد وجود دارد.",
  signing_nothing_to_send: "ابتدا سند را کامل کنید و سپس ارسال کنید.",
  contract_signing_unavailable: "ارسال امضا موقتاً ممکن نیست؛ دوباره تلاش کنید.",
  contract_not_found: "قرارداد پیدا نشد.",
  invalid_link: "این لینک امضا معتبر نیست.",
  link_expired: SIGNING_FAILURE_LABELS.link_expired,
  link_revoked: SIGNING_FAILURE_LABELS.link_revoked,
  otp_invalid: "کد تأیید درست نیست.",
  otp_expired: "کد تأیید منقضی شده است؛ کد تازه بگیرید.",
  otp_attempts_exhausted: "تعداد تلاش‌های کد تأیید تمام شده است؛ کد تازه بگیرید.",
  otp_rate_limited: "درخواست کد بیش از حد مجاز بوده است؛ کمی بعد دوباره تلاش کنید.",
  consent_required: "برای ادامه، مطالعهٔ سند را تأیید کنید.",
  signature_invalid: "امضای ثبت‌شده معتبر نیست؛ دوباره امضا کنید.",
  signing_not_your_turn: SIGNING_FAILURE_LABELS.signing_not_your_turn,
  contract_version_mismatch: "سند پس از دعوت تغییر کرده است؛ از طرف قرارداد بخواهید دوباره ارسال کند.",
  decline_reason_required: "دلیل رد کردن را بنویسید.",
  unknown_action: "این عملیات برای این لینک مجاز نیست.",
};

/**
 * The sender screens' copy. `CONTRACT_EDIT_ERROR_MESSAGES` is the name the
 * editor and the signing panel share; `SIGNING_ERROR_MESSAGES` is the public
 * signer page's, which must never mention a tenant id or a server detail.
 */
export const CONTRACT_EDIT_ERROR_MESSAGES = CONTRACT_ERROR_MESSAGES;

export const SIGNING_ERROR_MESSAGES: Record<string, string> = {
  invalid_link: CONTRACT_ERROR_MESSAGES.invalid_link,
  link_expired: CONTRACT_ERROR_MESSAGES.link_expired,
  link_revoked: CONTRACT_ERROR_MESSAGES.link_revoked,
  signer_already_signed: CONTRACT_ERROR_MESSAGES.signer_already_signed,
  signer_declined: CONTRACT_ERROR_MESSAGES.signer_declined,
  signing_envelope_not_live: CONTRACT_ERROR_MESSAGES.signing_envelope_not_live,
  signing_not_your_turn: CONTRACT_ERROR_MESSAGES.signing_not_your_turn,
  consent_required: CONTRACT_ERROR_MESSAGES.consent_required,
  otp_invalid: CONTRACT_ERROR_MESSAGES.otp_invalid,
  otp_expired: CONTRACT_ERROR_MESSAGES.otp_expired,
  otp_attempts_exhausted: CONTRACT_ERROR_MESSAGES.otp_attempts_exhausted,
  otp_rate_limited: CONTRACT_ERROR_MESSAGES.otp_rate_limited,
  otp_required: SIGNING_FAILURE_LABELS.otp_required,
  signer_name_required: CONTRACT_ERROR_MESSAGES.signer_name_required,
  signature_invalid: CONTRACT_ERROR_MESSAGES.signature_invalid,
  contract_version_mismatch: CONTRACT_ERROR_MESSAGES.contract_version_mismatch,
  decline_reason_required: CONTRACT_ERROR_MESSAGES.decline_reason_required,
  unknown_action: CONTRACT_ERROR_MESSAGES.unknown_action,
  invalid_action: CONTRACT_ERROR_MESSAGES.unknown_action,
};

/** The neutral sentence a screen shows when it has no specific one. */
export const UNKNOWN_CONTRACT_ERROR = "انجام این کار ممکن نیست؛ دوباره تلاش کنید.";

/** Resolves a code to a sentence, without ever leaking the raw code to a user. */
export function contractErrorMessage(code: string | undefined | null): string {
  if (!code) return "انجام این کار ممکن نیست؛ دوباره تلاش کنید.";
  return CONTRACT_ERROR_MESSAGES[code] ?? "انجام این کار ممکن نیست؛ دوباره تلاش کنید.";
}
