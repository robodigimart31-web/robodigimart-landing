"use client";
import Link from "next/link";
import { useParams } from "next/navigation";
export default function NotFound(){const {locale}=useParams();const en=locale === "en";return <main className="notfound"><h1>404</h1><p>{en ? "This page could not be found." : "Halaman ini tidak ditemukan."}</p><Link href={en ? "/en" : "/id"} className="btn btn-gold">{en ? "Return to HELIX" : "Kembali ke HELIX"}</Link></main>}
