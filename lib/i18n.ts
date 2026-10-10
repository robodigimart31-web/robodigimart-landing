export type Locale = "id" | "en";
export const locales: Locale[] = ["id", "en"];
export function isLocale(value: string): value is Locale { return value === "id" || value === "en"; }
export function localeHome(locale: Locale) { return `/${locale}`; }
export function languageTag(locale: Locale) { return locale === "id" ? "id-ID" : "en-US"; }
export function choose(locale: Locale, id: string, en: string) { return locale === "id" ? id : en; }
