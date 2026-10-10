# Publisher V3: profit HELIX saja

Paket privat: artifacts/HELIX-VPS-PUBLISHER-V3.zip. File .set berisi kunci pengiriman; jangan dibagikan atau diunggah ke repository publik.

## Mengganti V2 yang sudah terpasang di VPS

1. Salin ZIP V3 ke VPS dan ekstrak.
2. Pada chart PUBLISHER, hapus HELIX_PERFORMANCE_PUBLISHER_V2 dari chart. Jangan menghapus atau mengganti EA HELIX QUADRIGA yang melakukan trading pada chart lain.
3. MT5 > File > Open Data Folder > MQL5 > Experts: salin HELIX_PERFORMANCE_PUBLISHER_V3.ex5.
4. Navigator > Expert Advisors > klik kanan Refresh. Pasang HELIX_PERFORMANCE_PUBLISHER_V3 pada chart publisher tadi, dengan simbol HELIX yang digunakan broker.
5. Inputs > Load > pilih HELIX-VPS-V3-PRIVATE.set. Tanggal bawaan tetap 2026.10.04 00:00:00 (waktu broker), interval 12 jam. Klik OK.
6. URL WebRequest tetap sama: https://helix-performance.robo-digimart31.workers.dev . Tidak perlu menambahkan URL baru. Publisher tidak memerlukan izin Algo Trading dan tidak melakukan transaksi; biarkan pengaturan Algo Trading EA trading sebagaimana sebelumnya.
7. Tab Experts harus menampilkan HELIX Publisher V3: sync OK. Riwayat sejak 4 Oktober otomatis dikirim ulang dengan filter baru. Refresh website; cache maksimal 60 detik.

V3 memakai penjadwalan baru agar mengirim segera setelah dipasang, tidak menunggu jadwal 12 jam V2. Jika server menjawab 429 karena pembaruan sebelumnya kurang dari lima menit, publisher mencoba kembali setelah 30 menit. Laptop pribadi boleh mati; MT5 VPS perlu tetap berjalan dan tersambung.

## Aturan statistik

- Hanya posisi yang dibuka dengan magic 681000 sampai 681999 (inklusif).
- Posisi HELIX yang ditutup manual tetap dihitung, berdasarkan position ID. Posisi yang sejak awal dibuka manual atau EA lain tidak dihitung dan tidak dikirim oleh publisher.
- Pada akun netting, penambahan/reversal manual atau EA lain dalam position ID yang sama dengan HELIX tidak bisa dipisahkan dengan andal. Pengiriman ditolak untuk pemeriksaan, bukan diam-diam dicampur.
- Deposit, penarikan, balance, equity, kredit akun dan modal awal tidak dikirim. Operasi non-trading tidak masuk profit.
- Profit kumulatif mulai nol pada 4 Oktober 2026 00.00 waktu broker. Nilainya berasal dari profit terealisasi + komisi + swap + fee yang melekat pada deal posisi HELIX. Biaya akun terpisah yang tidak dapat diatribusikan ke posisi tidak disertakan.
- Biaya entry dicatat saat terjadi; profit partial close masuk profit, tetapi posisi baru masuk hitungan win rate/profit factor/jumlah posisi selesai setelah ditutup penuh.
- Profit bulanan menggunakan aturan yang sama, tanpa perubahan akibat deposit/WD. Floating P/L tidak dihitung.
- Mata uang tetap mengikuti akun, termasuk USC untuk akun cent; tidak dikonversi diam-diam ke USD.
- Modal awal, menu Balance/Equity, dan drawdown equity dihapus dari kartu akun real. Kartu backtest mempertahankan modal dan drawdown dari laporan pengujiannya.
- Statistik seluruh periode tidak dihitung ulang saat filter rentang grafik diubah.

## Transisi dan pemeriksaan

Backend V3 menolak publisher V2 yang tidak membawa magic. Data V2 tidak ditampilkan sebagai data berfilter; website menunggu pengiriman V3 pertama. Kunci dan penguncian akun tetap sama. Data agregat V2 lama tidak cukup untuk dihitung ulang karena raw deals tidak disimpan; V3 harus membaca ulang riwayat MT5.

Pengujian: node --test performance-worker/metrics.test.mjs. Meliputi batas magic, transaksi manual, penutupan manual HELIX, deposit/WD, biaya, partial close, posisi campuran dan format lama. Paket EX5 dikompilasi dengan 0 error/0 warning. MQ5 pendamping dapat dikompilasi ulang di MetaEditor VPS jika versi terminal lebih lama menolak EX5.

- HTTP 401: muat file .set yang diberikan.
- HTTP 409: akun berbeda atau timestamp duplikat; jangan mengganti akun yang terhubung.
- HTTP 422: lihat pesan pada Experts; bisa berarti V2 lama, posisi campuran, riwayat entry tidak lengkap, atau jam VPS keliru.
- HTTP -1/error 4014: periksa izin WebRequest dan URL. Pasang pada chart normal, bukan Strategy Tester.

## Backend

Worker helix-performance dan D1 helix-performance. POST /api/publisher/mt5 menggunakan Bearer key dan account hash dengan salt privat; GET /api/performance hanya mengeluarkan agregat profit yang lolos filter. V3 tidak lagi membaca/menulis tabel snapshots lama. Riwayat snapshot lama tidak ditampilkan; tidak ada penghapusan database yang diperlukan untuk upgrade.

Deploy backend: npx wrangler deploy --config performance-worker/wrangler.jsonc . Deploy frontend melalui branch cloudflare-landing. Folder artifacts dan .dev.vars diabaikan Git. Kunci tidak dimasukkan ke source EX5/MQ5 maupun frontend.

Referensi properti magic dan position ID: https://www.mql5.com/en/docs/constants/tradingconstants/dealproperties
