# Hubungkan akun real HELIX dari VPS

Paket privat tersedia di artifacts/HELIX-VPS-PUBLISHER.zip. Jangan unggah paket atau file .set ke GitHub/website/chat publik: file .set berisi kunci pengiriman statistik. Password trading dan password VPS tidak diperlukan.

## Pasang sekali di VPS Windows

1. Salin ZIP ke VPS dan ekstrak.
2. Buka MT5 pada akun REAL khusus HELIX QUADRIGA. Di File > Open Data Folder, buka MQL5 > Experts. Salin HELIX_PERFORMANCE_PUBLISHER_V2.ex5 ke folder tersebut.
3. Di MT5 buka Tools > Options > Expert Advisors. Aktifkan Allow WebRequest for listed URL dan tambahkan:
   https://helix-performance.robo-digimart31.workers.dev
4. Buka chart BARU untuk simbol HELIX yang digunakan broker, misalnya XAUUSDm. Jangan mengganti EA trading di chart yang sudah berjalan.
5. Di Navigator > Expert Advisors, klik kanan Refresh. Tarik HELIX_PERFORMANCE_PUBLISHER_V2 ke chart baru.
6. Pada Inputs, klik Load, pilih HELIX-VPS-PRIVATE.set dari folder hasil ekstrak. Pastikan InpHistoryFrom tetap 2026.10.04 00:00:00 dan InpSyncHours 12, lalu OK. Tidak perlu mengubah pengaturan Algo Trading milik EA trading. Publisher tidak menggunakan fungsi transaksi atau DLL.
7. Buka Toolbox > Experts. Tanda berhasil: HELIX Publisher V2: sync OK. Perbarui halaman website; cache data maksimal 60 detik. Pengiriman berikutnya otomatis setiap 12 jam selama MT5 di VPS tersambung.

Terminal tidak perlu direstart. Paket EX5 sudah dikompilasi dengan 0 error dan 0 warning di komputer pengembangan. Jika MT5 VPS mengatakan versi EX5 tidak didukung, gunakan file MQ5 pendamping, buka di MetaEditor VPS dan Compile (F7); jangan menutup chart trading.

## Yang dilaporkan

- Semua transaksi dalam akun khusus HELIX, mulai 4 Oktober 2026 00.00 waktu broker; bukan WIB. Tidak ada posisi bawaan, sesuai konfirmasi pemilik akun.
- Saldo awal dihitung dari saldo saat ini dikurangi perubahan saldo dalam riwayat periode tersebut. Pastikan broker menyediakan riwayat lengkap. Jika baru deposit setelah tanggal mulai, saldo awal bisa nol.
- Laba bersih dan laba bulanan mengecualikan deposit/penarikan. Biaya, komisi, swap dan fee disertakan. Kredit/bonus/koreksi broker tertentu ditolak untuk pemeriksaan manual.
- Win rate, profit factor, dan jumlah posisi selesai dihitung untuk posisi yang ditutup penuh, termasuk biaya masuk/keluar. Partial close belum dihitung sebagai satu posisi selesai sampai sisanya ditutup. Laba yang sudah direalisasi tetap masuk net profit.
- Grafik Saldo berasal dari riwayat akhir hari menurut tanggal broker. Grafik Ekuitas berasal dari snapshot UTC sejak publisher terhubung. Tidak ada equity historis yang dibuat-buat.
- Drawdown snapshot hanya tampil setelah minimal dua snapshot dan tanpa perubahan arus dana dalam rentang snapshot. Bukan drawdown intrahari sejak 4 Oktober. Jika arus dana berubah, angka dibiarkan kosong agar tidak salah dianggap sebagai kerugian trading.
- Statistik adalah laporan terminal pemilik akun, bukan verifikasi broker independen.

## Jika belum tersambung

- HTTP -1 / error 4014: cek URL WebRequest dan pemasangan sebagai EA di chart normal, bukan Strategy Tester.
- HTTP 401: muat ulang file .set privat yang disediakan.
- HTTP 409: akun sudah terkunci ke akun pertama atau snapshot duplikat. Jangan mengganti akun pada publisher.
- HTTP 422: baca pesan ringkas pada Experts; dapat disebabkan jam Windows VPS tidak benar, riwayat tidak lengkap, kredit broker, atau tanggal tidak sesuai.
- HTTP 429: pembaruan terlalu cepat, tunggu jadwal ulang.
- Gagal koneksi: publisher mencoba lagi setiap 30 menit. MT5 harus tetap berjalan di VPS; laptop pribadi boleh dimatikan.

## Catatan pengembang

Backend terpisah: performance-worker/worker.mjs + Cloudflare D1 helix-performance. Website Pages tetap statis, membaca endpoint publik /api/performance lewat HTTPS. Kunci hanya berada di Worker secrets dan file .set privat, tidak di frontend atau repository.

POST /api/publisher/mt5 memerlukan Bearer key. Akun dikunci atomik pada hash akun/server pertama yang berhasil, dengan salt privat. Payload maksimum 3 MB/15.000 deal, batas tanggal tetap, validasi jam, penolakan duplikat dan jeda minimal lima menit. Raw deal diproses tetapi tidak disimpan di D1; hanya ringkasan publik, saldo harian, snapshot dan hash akun yang disimpan. Nomor akun/tiket/position ID tidak diekspos endpoint publik.

Uji: node --test performance-worker/metrics.test.mjs. Deploy backend: npx wrangler deploy --config performance-worker/wrangler.jsonc. Deployment website melalui branch cloudflare-landing. File .dev.vars dan artifacts diabaikan Git. Izin Cloudflare ditambah atas otorisasi pemilik.

Panduan resmi input Load: https://www.metatrader5.com/en/terminal/help/algotrading/trade_robots_indicators
Panduan WebRequest: https://www.mql5.com/en/docs/network/webrequest
