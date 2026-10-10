# HELIX di Cloudflare Pages

## Status

Build statis landing page sudah disiapkan. Source Next.js asli tetap bisa dijalankan; pipeline Cloudflare membuat salinan terisolasi tanpa API server atau file .env. Portal VIP, aktivasi/reset lisensi, dan publisher MT5 belum termasuk deployment ini. Bagian performa menampilkan belum ada data tanpa memanggil API yang tidak tersedia.

Target GitHub: `robodigimart31-web/robodigimart-landing`. Gunakan branch `cloudflare-landing` untuk memisahkan migrasi dari website Vercel pada branch `main`.

## Build dan pemeriksaan

```powershell
npm ci
npm run build:cloudflare
npm run check:cloudflare
npx wrangler pages dev cloudflare-dist --port 8788
```

Buka http://localhost:8788. Output publik berada di `cloudflare-dist`. Gambar WebP responsif dibuat saat build. File `_headers` dan `_redirects` menerapkan keamanan dasar serta pengalihan URL pada Pages. Jangan mengunggah folder source atau `.cloudflare-build` sebagai hasil build.

## Hubungkan GitHub satu kali

1. Login https://dash.cloudflare.com dan buka Workers & Pages → Create application → Pages → Import an existing Git repository. Gunakan Git integration agar update otomatis. Jangan memilih Direct Upload untuk project utama; mode itu tidak bisa langsung diubah menjadi Git integration.
2. Hubungkan akun GitHub pemilik dan pilih hanya repository `robodigimart-landing`.
3. Nama project: `helix-website` (atau nama lain jika sudah dipakai).
4. Production branch: `cloudflare-landing`. Branch ini harus sudah di-push.
5. Framework preset: None. Build command: `npm run build:cloudflare && npm run check:cloudflare`.
6. Build output directory: `cloudflare-dist`. Root directory: kosong/default karena package.json di root repository.
7. Environment variable build: `NODE_VERSION` = `22`. Tidak perlu kunci database, secret lisensi, atau variabel Vercel.
8. Jalankan deployment dan periksa URL `*.pages.dev` yang diberikan Cloudflare. Jangan menebak URL dari nama project sebelum hasil deployment tersedia.

Setelah terhubung, setiap push ke `cloudflare-landing` membangun dan menerbitkan perubahan otomatis. Perubahan branch lain dapat memakai preview. Main dan project Vercel lama tidak perlu dihapus.

## Pindahkan domain setelah preview lulus

Domain tetap diperpanjang di Hostinger. Untuk apex `robodigimart.com` di Pages, zona DNS perlu berada di Cloudflare.

1. Simpan seluruh DNS saat ini dari Vercel: apex, www, viphub, MX, TXT (SPF/DKIM/DMARC), CAA, dan record verifikasi lain. Auto-scan tidak selalu menemukan semuanya.
2. Tambahkan `robodigimart.com` sebagai zona Cloudflare Free. Cocokkan record hasil impor dengan Vercel. Pertahankan target `viphub` lama dan record email; jangan menggantinya dengan Pages.
3. Periksa apakah DNSSEC aktif sebelum mengganti nameserver. Jika aktif, ikuti prosedur migrasi DNSSEC Cloudflare/registrar agar domain tidak gagal resolusi.
4. Sesudah zona siap, ganti nameserver di Hostinger memakai dua nameserver persis yang diberikan akun Cloudflare. Jangan memakai nama contoh.
5. Pada project Pages, tambahkan `www.robodigimart.com` dan `robodigimart.com` di Custom domains dan ikuti record yang diberikan project. Tunggu sertifikat HTTPS aktif.
6. Tetapkan redirect apex ke `https://www.robodigimart.com` dengan mempertahankan path dan query, sesuai canonical yang sudah digunakan source. Periksa tidak ada redirect bolak-balik.
7. Uji domain utama, www, viphub, serta email bila digunakan. Website Vercel lama dipertahankan untuk rollback.

Nameserver dan target DNS tidak dapat dipastikan hanya dari screenshot lama. Jangan menghapus record sebelum inventaris aktual selesai. Jika koneksi akun belum tersedia, pekerjaan berhenti pada persiapan dan preview lokal, bukan berarti migrasi live selesai.

## Pemulihan

Untuk masalah perubahan konten di Pages, rollback deployment melalui dashboard. Untuk masalah perpindahan domain, pulihkan record hosting lama dari catatan DNS. Perubahan DNS/nameserver memerlukan waktu propagasi; jangan menghapus project Vercel saat transisi.

## Rujukan

- https://developers.cloudflare.com/pages/framework-guides/nextjs/deploy-a-static-nextjs-site/
- https://developers.cloudflare.com/pages/configuration/git-integration/
- https://developers.cloudflare.com/pages/configuration/custom-domains/
- https://nextjs.org/docs/app/guides/static-exports
