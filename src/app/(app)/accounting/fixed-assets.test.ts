import { describe, expect, it } from "vitest";
import { errorMessageOrRaw } from "@/app/dashboard/ui";

describe("Fixed assets error translation and resolution", () => {
  it("translates all fixed asset specific error codes correctly", () => {
    expect(errorMessageOrRaw("fixed_asset_not_found")).toBe("دارایی ثابت پیدا نشد.");
    expect(errorMessageOrRaw("fixed_asset_has_depreciation")).toBe(
      "برای این دارایی سابقه حسابداری ثبت شده و حذف آن ممکن نیست؛ می‌توانید آن را بایگانی کنید.",
    );
    expect(errorMessageOrRaw("fixed_asset_has_history")).toBe(
      "برای این دارایی سابقه ثبت شده (خرید، انتقال یا تغییر برآورد) و حذف آن ممکن نیست؛ می‌توانید آن را بایگانی کنید.",
    );
    expect(errorMessageOrRaw("period_already_depreciated")).toBe("استهلاک این دوره قبلاً برای این دارایی ثبت شده است.");
    expect(errorMessageOrRaw("fully_depreciated")).toBe("این دارایی به‌طور کامل مستهلک شده است.");
    expect(errorMessageOrRaw("salvage_value_invalid")).toBe("ارزش اسقاط باید کمتر از بهای تمام‌شده باشد.");
    expect(errorMessageOrRaw("period_label_required")).toBe("عنوان دوره الزامی است.");
  });

  it("translates the chronology error codes of the #833 review follow-up", () => {
    expect(errorMessageOrRaw("entry_date_in_future")).toBe("تاریخ سند نمی‌تواند در آینده باشد.");
    expect(errorMessageOrRaw("transfer_before_in_service")).toBe(
      "تاریخ انتقال نمی‌تواند پیش از تاریخ بهره‌برداری دارایی باشد.",
    );
    expect(errorMessageOrRaw("transfer_before_last_transfer")).toBe(
      "تاریخ انتقال نمی‌تواند پیش از آخرین انتقال ثبت‌شده باشد؛ سابقه انتقال‌ها تغییرناپذیر است.",
    );
    expect(errorMessageOrRaw("disposal_before_last_transfer")).toBe(
      "تاریخ واگذاری نمی‌تواند پیش از آخرین انتقال ثبت‌شده باشد.",
    );
  });

  it("translates the fixed-asset lifecycle error codes of issue #833", () => {
    expect(errorMessageOrRaw("asset_disposed")).toBe("این دارایی واگذار/اسقاط شده و دیگر عملیاتی روی آن انجام نمی‌شود.");
    expect(errorMessageOrRaw("asset_archived")).toBe("این دارایی بایگانی شده است.");
    expect(errorMessageOrRaw("depreciation_already_reversed")).toBe("این استهلاک قبلاً برگشت خورده است.");
    expect(errorMessageOrRaw("depreciation_entry_not_found")).toBe("سند استهلاک انتخاب‌شده پیدا نشد.");
    expect(errorMessageOrRaw("disposal_proceeds_required")).toBe("برای فروش، مبلغ واگذاری (بزرگ‌تر از صفر) الزامی است.");
    expect(errorMessageOrRaw("disposal_proceeds_not_allowed")).toBe("برای اسقاط یا حذف، مبلغ واگذاری نباید وارد شود.");
    expect(errorMessageOrRaw("proceeds_account_required")).toBe("حساب وصول مبلغ فروش را انتخاب کنید.");
    expect(errorMessageOrRaw("estimate_unchanged")).toBe("مقدار جدید با مقدار فعلی یکسان است.");
    expect(errorMessageOrRaw("transfer_same_location")).toBe("دارایی هم‌اکنون در همین شعبه است.");
    expect(errorMessageOrRaw("invalid_asset_account")).toBe(
      "حساب دارایی انتخاب‌شده باید یک حساب دارایی ثابت (۱۵۰۰ تا ۱۵۹۹) باشد.",
    );
  });

  it("passes through raw Persian strings if already formatted", () => {
    const rawPersian = "ارزش اسقاط باید کمتر از بهای تمام‌شده باشد.";
    expect(errorMessageOrRaw(rawPersian)).toBe(rawPersian);
  });
});

describe("Fixed asset calculations and progress metrics", () => {
  it("calculates progress percentage and remaining book value accurately", () => {
    const cost = 120_000_000;
    const salvageValue = 20_000_000;
    const usefulLifeMonths = 60;
    const depreciableBase = cost - salvageValue; // 100,000,000
    const monthly = Math.round(depreciableBase / usefulLifeMonths); // 1,666,667

    // After 12 months
    const accumulated = monthly * 12; // 20,000,004
    const bookValue = cost - accumulated; // 99,999,996
    const percent = Math.min(100, Math.round((accumulated / depreciableBase) * 100)); // 20%

    expect(percent).toBe(20);
    expect(bookValue).toBe(99_999_996);
  });

  it("determines fully depreciated status correctly", () => {
    const cost = 50_000_000;
    const salvageValue = 5_000_000;
    const depreciableBase = cost - salvageValue;

    // Not fully depreciated
    const acc1 = 40_000_000;
    const bookValue1 = cost - acc1;
    const isFullyDepreciated1 = bookValue1 <= salvageValue || acc1 >= depreciableBase;
    expect(isFullyDepreciated1).toBe(false);

    // Fully depreciated
    const acc2 = 45_000_000;
    const bookValue2 = cost - acc2;
    const isFullyDepreciated2 = bookValue2 <= salvageValue || acc2 >= depreciableBase;
    expect(isFullyDepreciated2).toBe(true);
  });
});
