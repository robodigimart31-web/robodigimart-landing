import type { MetadataRoute } from "next";
export default function sitemap():MetadataRoute.Sitemap {
 const base="https://www.robodigimart.com";
 return ["id","en"].flatMap(locale=>["","/products/quadriga"].map(suffix=>({
  url:`${base}/${locale}${suffix}`,changeFrequency:"weekly" as const,priority:suffix ? 0.8 : 1,
  alternates:{languages:{"id-ID":`${base}/id${suffix}`,"en-US":`${base}/en${suffix}`}},
 })));
}
