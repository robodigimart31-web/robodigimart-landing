import type { Locale } from "./i18n";
export const SITE_NAME = "HELIX Trading Expert Advisor";
export const PRODUCT = {slug:"quadriga",name:"HELIX QUADRIGA",tagline:"4 Logic Architecture",status:"available" as const};
// Current public contact channel, supplied by the site owner.
export const TIKTOK_URL = "https://www.tiktok.com/@roboznapz";
export function contactHref(_locale:Locale = "id"):string { return TIKTOK_URL; }
