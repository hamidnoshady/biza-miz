/** Contact values in name fields are not human names. Keep this display-only. */
export function customerPersonName(...parts: (string | null | undefined)[]): string {
  const name = parts.map((part) => part?.trim() ?? "").filter(Boolean).join(" ").replace(/\s+/g, " ");
  return !name.includes("@") && /\p{L}/u.test(name) ? name : "";
}

/** Email remains contact/matching data; it never becomes the customer's name. */
export function customerDisplayName(input: { name?: string | null; phone?: string | null }): string {
  const name = customerPersonName(input.name);
  if (name) return name;
  const phone = input.phone?.trim() ?? "";
  if (/^[+\d۰-۹٠-٩\s().-]+$/u.test(phone) && phone.replace(/[^\d۰-۹٠-٩]/gu, "").length >= 7) return phone;
  return "مشتری آنلاین";
}
