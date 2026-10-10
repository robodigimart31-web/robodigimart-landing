import type { Metadata } from "next";
import { choose, type Locale } from "./i18n";
export function pageMetadata(locale: Locale, product = false): Metadata {
  const suffix = product ? "/products/quadriga" : "";
  const description = choose(locale,
    "Kenali HELIX QUADRIGA, Expert Advisor empat logika untuk MetaTrader 5. Pelajari produk, performa akun real, dan laporan uji historis.",
    "Explore HELIX QUADRIGA, a four-logic Expert Advisor for MetaTrader 5. Learn about the product, real account performance, and backtest reports.");
  return {
    title: product ? choose(locale, "QUADRIGA — Informasi Produk", "QUADRIGA — Product Overview") : {absolute:"HELIX | Trading Expert Advisor"},
    description,
    alternates: {canonical:`/${locale}${suffix}`, languages:{"id-ID":`/id${suffix}`, "en-US":`/en${suffix}`, "x-default":`/id${suffix}`}},
    openGraph:{title: "HELIX QUADRIGA",description,url:`/${locale}${suffix}`,locale:locale === "id" ? "id_ID" : "en_US", alternateLocale:locale === "id" ? "en_US" : "id_ID",type:"website",images:["/images/helix-logo.webp"]},
  };
}
