import Link from "next/link";
import Image from "next/image";
import { notFound } from "next/navigation";
import { Header } from "@/components/Header";
import { contactHref } from "@/lib/config";
import { Icon } from "@/components/icons";
import { choose, isLocale } from "@/lib/i18n";
import { pageMetadata } from "@/lib/page-metadata";
type Props={params:Promise<{locale:string}>};
export async function generateMetadata({params}:Props){const {locale}=await params;return pageMetadata(isLocale(locale) ? locale : "id",true);}
export default async function Quadriga({params}:Props) {
 const {locale}=await params;if(!isLocale(locale))notFound();
 const t=(id:string,en:string)=>choose(locale,id,en),home=`/${locale}`;
 return <><Header locale={locale} page="product"/><main id="main-content"><section className="product-detail-hero"><div className="container detail-grid"><div><span className="eyebrow">{t("HELIX / SERI 01","HELIX / SERIES 01")}</span><h1>HELIX <em>QUADRIGA</em></h1><h2>{t("Empat pendekatan. Satu sistem.","Four approaches. One engine.")}</h2><p>{t("QUADRIGA menggabungkan keluarga strategi yang berbeda untuk mengevaluasi konteks pasar. Setiap pendekatan memiliki tujuan transaksi dan pengelolaannya sendiri.","QUADRIGA combines different strategy families to evaluate market contexts. Each approach has its own trading objectives and management rules.")}</p><div className="hero-buttons"><a className="btn btn-gold" href={contactHref(locale)}>{t("Kunjungi TikTok HELIX","Visit HELIX on TikTok")} <Icon name="external"/></a><Link className="btn btn-outline" href={`${home}#performance`}>{t("Lihat Performa","View Performance")}</Link></div></div><div className="detail-art"><Image priority sizes="(max-width: 760px) 100vw, 620px" src="/images/helix-quadriga-scene.png" alt="HELIX QUADRIGA" width="1024" height="768"/></div></div></section><section className="section"><div className="container"><div className="section-header"><div><span className="eyebrow">{t("ARSITEKTUR SISTEM","THE ARCHITECTURE")}</span><h2>{t("Beragam konteks.","Different contexts.")}<br/><em>{t("Pendekatan terstruktur.","A structured approach.")}</em></h2><p>{t("Gambaran umum empat keluarga strategi QUADRIGA.","An overview of QUADRIGA’s four strategy families.")}</p></div></div><div className="why-grid">{[
 [t("Tren & Struktur","Trend & Structure"),t("Mengevaluasi arah dan struktur pasar sebagai konteks pengambilan keputusan.","Evaluates market direction and structure as context for decision-making.")],
 [t("Analisis Kerangka Waktu","Refined Timeframes"),t("Melengkapi evaluasi dengan konteks dari kerangka waktu yang berbeda.","Complements evaluation with context from different timeframes.")],
 [t("Pergerakan Pendek","Short-Move Engine"),t("Mengevaluasi peluang pergerakan pendek dan koreksi harga.","Evaluates opportunities in shorter moves and retracements.")],
 [t("Pergerakan Lanjutan","Extended-Move Engine"),t("Mengevaluasi peluang kelanjutan pergerakan yang lebih panjang.","Evaluates opportunities in longer continuation moves.")],
 ].map(([title,body],i)=><article key={title} className="why-card"><span className="step-no">0{i+1}</span><h3>{title}</h3><p>{body}</p></article>)}</div><div className="detail-bottom"><p><Icon name="info" size={18}/>{t("Konfirmasikan versi produk, instrumen yang didukung, harga, dan ketentuan lisensi dengan tim HELIX sebelum membeli. Trading memiliki risiko dan tidak menjamin keuntungan.","Confirm the product version, supported instruments, pricing, and license terms with the HELIX team before purchasing. Trading involves risk and does not guarantee profits.")}</p><Link href={home} className="btn btn-outline">{t("Kembali ke Beranda","Back to Homepage")} <Icon name="arrow"/></Link></div></div></section></main></>;
}
