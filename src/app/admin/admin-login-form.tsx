"use client";

import { useRouter } from "next/navigation";
import { cardClass } from "@/app/dashboard/page-chrome";
import { AccountLoginForm } from "@/components/auth/account-login-form";
import { clearRememberedLoginDoor } from "@/lib/login-door";

/**
 * The owner/manager door of a tenant's origin, at `/admin`.
 *
 * The form itself is `AccountLoginForm` — the same component the cloud door at
 * `/login` mounts. This route previously carried its own copy of the password +
 * MFA + business-picker flow, which meant every fix (the bounded request, the
 * 423 wording, the MFA interstitial) had to be made twice and could silently
 * land in one door only. Only the card, heading and the way back to the staff
 * door are specific to `/admin`.
 *
 * Two deliberate differences from the cloud door, both props:
 *  - the field is labelled «ایمیل» (this door has always taken an address);
 *  - a successful sign-in lands on `/`, the setup-aware root, not `/dashboard`.
 */
export default function AdminLoginForm() {
  const router = useRouter();

  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <div className={`w-full max-w-sm ${cardClass} p-8`}>
        <h1 className="mb-1 text-center text-xl font-bold">
          بیزامیز
        </h1>
        <p className="mb-6 text-center text-sm text-muted-foreground">
          ورود مدیر / مالک
        </p>

        <AccountLoginForm
          identifierLabel="ایمیل"
          identifierType="email"
          defaultNext="/"
          trustDeviceDefault={false}
        />

        {/*
          An owner who lands here by mistake (or who wants to switch this
          device back to the staff door) must not be stuck on a password form
          with no way out. Clearing the remembered door sends `/login` back to
          its normal door on the next visit.
        */}
        <button
          type="button"
          onClick={() => {
            clearRememberedLoginDoor();
            router.push("/login");
          }}
          className="mx-auto mt-4 block text-center text-xs text-muted-foreground transition-colors hover:text-foreground outline-none focus-visible:ring focus-visible:ring-ring/50"
        >
          کارمند هستید؟ ورود کارکنان
        </button>
      </div>
    </main>
  );
}
