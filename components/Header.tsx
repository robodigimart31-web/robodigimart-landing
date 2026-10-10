"use client";
import { useState } from "react";
import Link from "next/link";
import { contactHref } from "@/lib/config";
import { Icon } from "@/components/icons";
import { choose, type Locale } from "@/lib/i18n";
export function Header({locale = "id", page = "home"}: {locale?: Locale; page?: "home" | "product"}) {
 const [open,setOpen] = useState(false);
 const t=(id:string,en:string)=>choose(locale,id,en);
 const home=`/${locale}`;
 const nav = [{label:t("Produk","Products"),href:`${home}#products`},{label:t("Performa","Performance"),href:`${home}#performance`},{label:t("Teknologi","Technology"),href:`${home}#technology`},{label:t("Tanya jawab","FAQ"),href:`${home}#faq`}];
 return <><a className="skip-link" href="#main-content">{t("Lewati ke konten","Skip to content")}</a><header className="site-header"><div className="nav-inner container"><Link className="brand" href={home} aria-label={t("HELIX beranda","HELIX home")} onClick={()=>setOpen(false)}><img src="/images/helix-emblem.webp" alt="" width="45" height="55"/><span><b>HELIX</b><small>TRADING EXPERT ADVISOR</small></span></Link><nav id="main-navigation" className={`nav-links ${open ? "nav-open" : ""}`} aria-label={t("Navigasi utama","Main navigation")} onKeyDown={event=>{if(event.key === "Escape") setOpen(false);}}>{nav.map(item=><Link key={item.href} href={item.href} onClick={()=>setOpen(false)}>{item.label}</Link>)}</nav><div className="nav-actions"><div className="language-switch" role="group" aria-label={t("Pilih bahasa","Choose language")}>{(["id","en"] as const).map(lang=><a key={lang} href={`/${lang}${page === "product" ? "/products/quadriga" : ""}`} hrefLang={lang} lang={lang} aria-label={lang === "id" ? "Bahasa Indonesia" : "English"} aria-current={locale === lang ? "true" : undefined} onClick={event=>{event.currentTarget.href += window.location.hash;setOpen(false);}}>{lang.toUpperCase()}</a>)}</div><a className="btn btn-gold btn-small header-contact" href={contactHref(locale)} onClick={()=>setOpen(false)}>TikTok <Icon name="external" size={15}/></a><button className="menu-toggle" aria-label={open ? t("Tutup menu","Close menu") : t("Buka menu","Open menu")} aria-controls="main-navigation" aria-expanded={open} onClick={()=>setOpen(!open)}><Icon name={open ? "close" : "menu"}/></button></div></div></header></>;
}
