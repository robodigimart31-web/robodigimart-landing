import type { Metadata } from "next";
import type { ReactNode } from "react";
import localFont from "next/font/local";
import { notFound } from "next/navigation";
import { isLocale, locales } from "@/lib/i18n";
import "../globals.css";
const manrope=localFont({src:"../../public/fonts/Manrope-Variable.ttf",variable:"--font-manrope",weight:"200 800",display:"swap"});
export const metadata: Metadata = {
 metadataBase:new URL("https://www.robodigimart.com"),
 title:{default:"HELIX | Trading Expert Advisor",template:"%s | HELIX"},
 applicationName:"HELIX",robots:{index:true,follow:true},
 icons:{icon:"/icon.png"},
};
export function generateStaticParams(){return locales.map(locale=>({locale}));}
export default async function LocaleLayout({children,params}:{children:ReactNode;params:Promise<{locale:string}>}){
 const {locale}=await params;
 if(!isLocale(locale)) notFound();
 return <html lang={locale} className={manrope.variable}><body><div className="ambient-gold" aria-hidden="true"/><div className="site-surface">{children}</div></body></html>;
}
