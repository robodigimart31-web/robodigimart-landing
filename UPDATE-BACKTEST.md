# Memperbarui backtest HELIX

Website menampilkan satu laporan backtest aktif. Impor mengganti laporan secara utuh; tidak menggabungkan atau menjumlahkan dua pengujian.

## Cara termudah
Simpan laporan HTML hasil Strategy Tester di folder PROJECT WEB HELIX, lalu minta asisten mengimpor dan menerbitkan laporan tersebut. Nama file boleh berbeda.

Untuk memperpanjang hasil Januari sampai tanggal terbaru, jalankan pengujian lengkap dari tanggal mulai yang sama sampai tanggal akhir terbaru, dengan pengaturan yang sama. Laporan yang hanya mencakup satu bulan akan mengganti tampilan menjadi satu bulan tersebut. Pengujian dengan pengaturan berbeda adalah hasil pengujian baru, bukan kelanjutan otomatis.

## Perintah impor
Dari folder helix-website:

```powershell
npm run import:backtest -- "..\ReportTester-413995142.html"
npm run build:cloudflare
npm run check:cloudflare
```

Impor hanya memperbarui file lokal lib/backtest-data.json. Agar online, salin perubahan yang sudah diuji ke worktree helix-cloudflare-release, commit dan push branch cloudflare-landing. Cloudflare akan membangun ulang otomatis. Jangan mengunggah laporan HTML mentah ke repository publik: laporan dapat memuat parameter EA. Yang dipublikasikan hanya statistik dan saldo harian yang dipilih importer.

Importer mendukung laporan HTML MT5 berbahasa Inggris, UTF-8 atau UTF-16LE, EA HELIX_QUADRIGA, satu deposit awal tanpa penambahan/penarikan dana. Format tidak dikenal dan total yang tidak cocok ditolak sebelum file lama diganti.

## Definisi tampilan
- Profit, win rate, profit factor, total trades: ringkasan MT5, seluruh periode pengujian.
- Drawdown: Equity Drawdown Relative dari MT5 (persentase penurunan relatif maksimum), bukan drawdown dari kurva saldo harian.
- Kurva: saldo akhir hari dari tabel Deals; tidak mengarang equity. Waktu mengikuti tanggal server broker dalam laporan.
- Bulanan: selisih saldo akhir bulan dengan bulan sebelumnya; bulan pertama memakai modal awal. Delapan bulan terakhir ditampilkan, bulan terakhir dapat belum lengkap.
- Filter grafik tidak menghitung ulang statistik seluruh pengujian.
- Laporan mentah tetap lokal; riwayat JSON yang telah diterbitkan tersedia melalui Git.
