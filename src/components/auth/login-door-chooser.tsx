"use client";

/**
 * "Which door?" — shown once per browser (or every time on a device that
 * chose not to be remembered) before either sign-in form.
 *
 * The audit's confirmed bug: a tenant's origin used to open straight into the
 * staff quick-login roster on every visit, and the owner/manager door
 * (`/admin`) had no link anywhere a first-time user would see — the only
 * place that even named it was a caption on the phone-OTP tab, three steps
 * into the staff flow. An owner who forgot the exact URL, or someone setting
 * up a new terminal, had no way back to their own login.
 *
 * This chooser is not an authorization boundary (both `/admin` and `/login`
 * already enforce who may sign in there server-side); it is the missing
 * front door. "Offline Local Login" is not a fourth credential system: this
 * install's staff PIN door (`pin-login/roster`, `pin-login`) already works
 * with no Internet connection whenever the local server itself is reachable
 * — the card exists so a user who does not know that can find the same
 * button under the label that matches what they are trying to do, and lands
 * on the identical flow with a note explaining why it needs no Internet.
 */
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  MonitorSmartphoneIcon,
  ShieldCheckIcon,
  UserRoundCogIcon,
  UsersRoundIcon,
  WifiOffIcon,
} from "lucide-react";
import { cardClass } from "@/app/dashboard/page-chrome";
import { rememberLoginDoor, type LoginDoor } from "@/lib/login-door";
import { withLoginNextParam } from "@/lib/login-contract";

export type DoorChoice = "admin" | "staff" | "offline";

interface DoorOption {
  choice: DoorChoice;
  storedDoor: LoginDoor;
  href: string | null;
  icon: typeof UserRoundCogIcon;
  title: string;
  description: string;
  points: string[];
}

/**
 * What `/api/auth/login-capabilities` answers.
 *
 * Null while the probe is in flight or if it failed, in which case the
 * offline card falls back to the *cloud* wording — the profile under which no
 * offline promise is made. Guessing optimistically here is exactly the bug
 * being fixed.
 */
export interface LoginCapabilities {
  deploymentProfile: "cloud" | "hybrid" | "local";
  phoneOtpEnforcement: "off" | "grace" | "pending_sms" | "enforced";
  phoneOtpDaysLeft: number | null;
}

/** Asks the install what it can do. Never throws; a failed probe is `null`. */
export function useLoginCapabilities(): LoginCapabilities | null {
  const [capabilities, setCapabilities] = useState<LoginCapabilities | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/auth/login-capabilities", { signal: controller.signal })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data && !controller.signal.aborted) {
          setCapabilities(data as LoginCapabilities);
        }
      })
      .catch(() => {
        // A probe that cannot complete leaves the card on its conservative
        // wording. Swallowing this is deliberate: the login screen must not
        // fail because an optional description could not be fetched.
      });
    return () => controller.abort();
  }, []);
  return capabilities;
}

/**
 * Issue #885 L04 — the three cards, worded for what this install can do.
 *
 * The offline card is the one that changes. On a cloud origin it no longer
 * claims «نیازی به اینترنت ندارد», because that was untrue there and pressing
 * it only mounted the same same-origin staff form. On a local or hybrid
 * install the claim is kept — it is accurate about the server being talked to
 * — with the phone-verification prerequisite stated when the policy actually
 * enforces one, so a member does not discover at the keypad that an offline
 * login still needs a fresh SMS after their seven-day window closes.
 */
function doorOptions(capabilities: LoginCapabilities | null): DoorOption[] {
  const localInstall =
    capabilities?.deploymentProfile === "local" ||
    capabilities?.deploymentProfile === "hybrid";
  const phoneEnforced = capabilities?.phoneOtpEnforcement === "enforced";

  return [
    {
      choice: "staff",
      storedDoor: "staff",
      href: null,
      icon: UsersRoundIcon,
      title: "ورود کارکنان",
      description: "برای عملیات صندوق، سفارش‌گیری و کارهای روزانهٔ فروشگاه.",
      points: ["ورود سریع با انتخاب نام و پین", "ورود با اثر انگشت/چهره در دستگاه‌های ثبت‌شده"],
    },
    {
      choice: "admin",
      storedDoor: "admin",
      href: "/admin",
      icon: UserRoundCogIcon,
      title: "ورود مدیر / مالک",
      description: "برای تنظیمات کسب‌وکار، اتصال ابری، کاربران و پیکربندی همگام‌سازی.",
      // Issue #885 L16 — "full access to settings and reports" was a promise
      // the authorization layer does not keep: what a manager can open is
      // decided by their role's permissions in `authorize.ts`, and a manager
      // is not an owner. Naming the mechanism instead of the outcome.
      points: ["ایمیل و رمز عبور", "دسترسی مطابق نقش و مجوزهای شما"],
    },
    localInstall
      ? {
          choice: "offline",
          storedDoor: "staff",
          href: null,
          icon: WifiOffIcon,
          title: "ورود آفلاین (محلی)",
          description: "همان ورود کارکنان، برای وقتی این دستگاه یا شعبه به اینترنت وصل نیست.",
          points: phoneEnforced
            ? [
                "روی سرور محلی همین شبکه کار می‌کند",
                "پس از پایان مهلت ۷ روزه، یک‌بار تأیید پیامکی لازم است",
              ]
            : ["نیازی به اینترنت ندارد", "روی سرور محلی همین شبکه کار می‌کند"],
        }
      : {
          choice: "offline",
          storedDoor: "staff",
          href: null,
          icon: WifiOffIcon,
          title: "ورود آفلاین (محلی)",
          // Truthful on a cloud origin: this install is reached over the
          // Internet, so offline login is a property of the local app, not of
          // this page. Saying so beats a button that cannot do what it says.
          description:
            "ورود بدون اینترنت روی نسخهٔ محلی/سایت کسب‌وکار ممکن است، نه روی این نشانی ابری.",
          points: [
            "برای ورود آفلاین از اپلیکیشن محلی همان شعبه استفاده کنید",
            "این نشانی به اینترنت نیاز دارد",
          ],
        },
  ];
}

/**
 * The chooser's `remember` checkbox writes a device-local UI shortcut only
 * (see `login-door.ts`) — it never changes what a credential can do.
 */
export function LoginDoorChooser({
  onChoose,
  next = null,
}: {
  /** "staff"/"offline" are handled in-place (the caller renders the existing roster) so the roster fetch already in flight is not thrown away; "admin" is a hard navigation to /admin. */
  onChoose: (choice: DoorChoice) => void;
  /**
   * The destination this visit was heading to, already validated by
   * `useNextPath`. Carried onto the manager door so changing one's mind about
   * which door to use does not cost the deep link (issue #885 L06).
   */
  next?: string | null;
}) {
  const router = useRouter();
  const [remember, setRemember] = useState(true);
  const capabilities = useLoginCapabilities();
  const options = doorOptions(capabilities);

  function choose(option: DoorOption) {
    rememberLoginDoor(option.storedDoor, remember);
    if (option.href) {
      // Issue #885 L06 — the hard-coded "/admin" here is what dropped
      // ?next=/settings/profile the moment the manager card was chosen.
      router.push(withLoginNextParam(option.href, next));
      return;
    }
    onChoose(option.choice);
  }

  return (
    <div className={`w-full max-w-3xl ${cardClass} p-6 sm:p-8`}>
      <div className="mb-6 text-center">
        <h1 className="mb-1 text-xl font-bold text-foreground">خوش آمدید</h1>
        <p className="text-sm text-muted-foreground">نوع ورود خود را انتخاب کنید</p>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        {options.map((option) => {
          const Icon = option.icon;
          return (
            <button
              key={option.choice}
              type="button"
              onClick={() => choose(option)}
              className="flex flex-col items-start gap-3 rounded-xl border border-border/80 p-4 text-start transition-colors hover:border-primary/60 hover:bg-primary/5 outline-none focus-visible:ring focus-visible:ring-ring/50"
            >
              <span className="flex size-10 items-center justify-center rounded-xl bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-200">
                <Icon className="size-5" aria-hidden="true" />
              </span>
              <span className="font-bold text-foreground">{option.title}</span>
              <span className="text-xs leading-5 text-muted-foreground">{option.description}</span>
              <ul className="mt-1 space-y-1 text-xs text-muted-foreground">
                {option.points.map((point) => (
                  <li key={point} className="flex items-center gap-1.5">
                    <span className="size-1 rounded-full bg-muted-foreground/60" />
                    {point}
                  </li>
                ))}
              </ul>
            </button>
          );
        })}
      </div>

      <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-border/80 pt-4">
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <input
            type="checkbox"
            checked={remember}
            onChange={(e) => setRemember(e.target.checked)}
            className="size-4 rounded border-input"
          />
          نوع ورود را روی این مرورگر به خاطر بسپار
        </label>
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <ShieldCheckIcon className="size-3.5 text-emerald-700 dark:text-emerald-300" aria-hidden="true" />
          {/*
            Issue #885 L07 — say what it is and what it is not. This checkbox
            records which door to open first; it stores no credential and it
            is not the seven-day device trust, which is earned only by
            completing a verification and is held server-side.
          */}
          رمز عبور ذخیره نمی‌شود؛ هر زمان از «تغییر نوع ورود» می‌توانید این صفحه را دوباره ببینید
        </span>
      </div>
    </div>
  );
}

/** The small, always-available way back to the chooser — never a dead end. */
export function ChangeLoginTypeLink({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="mx-auto mt-4 flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground outline-none focus-visible:ring focus-visible:ring-ring/50"
    >
      <MonitorSmartphoneIcon className="size-3.5" aria-hidden="true" />
      تغییر نوع ورود
    </button>
  );
}

/**
 * The footnote shown on the staff door after choosing "Offline Local Login"
 * specifically.
 *
 * Issue #885 L04 — it asks the install before making the claim. On a cloud
 * origin this used to read «نیازی به اینترنت ندارد» under a page that is
 * itself reached over the Internet, which is a promise nothing on that
 * deployment could keep.
 */
export function OfflineLoginNote() {
  const capabilities = useLoginCapabilities();
  const localInstall =
    capabilities?.deploymentProfile === "local" ||
    capabilities?.deploymentProfile === "hybrid";
  const phoneEnforced = capabilities?.phoneOtpEnforcement === "enforced";

  return (
    <p className="mt-4 flex items-center justify-center gap-1.5 text-center text-xs text-muted-foreground">
      <WifiOffIcon className="size-3.5" aria-hidden="true" />
      {localInstall
        ? phoneEnforced
          ? "این ورود روی سرور محلی همین شبکه کار می‌کند؛ پس از پایان مهلت ۷ روزه یک‌بار تأیید پیامکی لازم است."
          : "این ورود روی همین دستگاه/شبکهٔ محلی کار می‌کند و نیازی به اینترنت ندارد."
        : "این نشانی ابری است و به اینترنت نیاز دارد. برای ورود بدون اینترنت از اپلیکیشن محلی همان شعبه استفاده کنید."}
    </p>
  );
}
