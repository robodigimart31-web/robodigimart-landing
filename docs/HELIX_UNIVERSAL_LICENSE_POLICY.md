# HELIX Universal License Implementation Policy

**Status:** mandatory contract for HELIX QUADRIGA and every future HELIX EA, product/code name, strategy family, and release.  
**Baseline:** License API v1, pairing protocol v2, release acknowledgement v1.8k.  
**Authority:** Cloudflare API and Supabase state decide access. EA cache, portal display, telemetry, and local files never grant a license.

Dokumen ini menetapkan cara merancang, mengimplementasikan, menguji, dan merilis seluruh sistem license HELIX. Nama produk, code name, dan strategi ML/RL/SHL/LGL tidak boleh membuat aturan license atau slot yang berbeda.

## 1. Prinsip wajib

1. Server menentukan identitas member, kepemilikan license, status, expiry, kuota, binding, sesi terminal, release, dan izin telemetry. Browser dan EA dapat dimodifikasi; jangan mempercayai flag UI, EA version, status lokal, magic number, mode akun, atau klaim ACK tanpa validasi server.
2. Supabase service-role key, Ed25519 private key, pairing hash secret, dan session proof tidak boleh masuk ke browser, source EA, repository, log, screenshot, ZIP handoff, atau pesan. Simpan hanya pada secret store yang sesuai.
3. Penolakan server bersifat final untuk entry baru. `SUSPENDED`, `REVOKED`, `EXPIRED`, `NOT_OWNER`, kuota penuh, sesi dicabut, `PENDING_RELEASE`, `RELEASED`, atau state tak dikenal tidak boleh diubah menjadi ACTIVE melalui cache/offline mode.
4. License denial tidak menutup paksa posisi terbuka. Posisi tetap dikelola oleh strategi/risk logic EA yang sudah disetujui.
5. Telemetry hanya pelaporan. Data telemetry/performance tidak memberi atau memperpanjang hak trading.
6. Mutasi status, role, release, dan force release harus diotorisasi server-side serta menyimpan actor, waktu, alasan, target, dan hasil ke audit.

## 2. Identitas, kepemilikan, kuota, expiry

- Satu license dimiliki satu `member_id`, memiliki `product_slug`, status, expiry, dan `max_accounts` (produk saat ini maksimal lima).
- Satu slot adalah satu binding akun broker: broker/server + login + fingerprint yang dibuat server. Demo dan real masing-masing memakai satu slot. Broker server berbeda adalah binding berbeda. Jangan gunakan email/nama akun sebagai identitas MT5.
- Banyak chart, instance EA/family HELIX, atau strategi pada fingerprint akun yang sama tetap satu slot. Pairing ulang binding aktif harus idempotent dan tidak membuat slot kedua.
- Binding `ACTIVE` dan `PENDING_RELEASE` tetap menghitung slot. Hanya `RELEASED` membebaskan slot. UI tidak menghitung kuota.
- Pairing tidak boleh diam-diam mengaktifkan binding `PENDING_RELEASE`/`RELEASED`. Reaktivasi harus melewati kebijakan pairing server yang eksplisit dan ber-audit.
- Waktu expiry dan aktivasi pertama ditetapkan server. Client tidak memilih/memperpanjang expiry. Suspend/revoke/delete harus memblokir atau mencabut sesi dan binding melalui operasi transaksional yang benar.

## 3. OTP pairing

### Alur

1. EA membaca broker/server, login, dan mode demo/real dari MT5; EA tidak meminta password/investor password broker.
2. EA memanggil `POST /api/license/v1/pair/start` melalui TLS dengan `broker_server`, `account_login`, `mode`, `protocol_version:"v2"`, `ea_build`, `ea_product_id`, `ea_version`, dan `magic_base` bila EA mendukung telemetry.
3. Server membuat OTP numerik 8 digit berumur pendek, menyimpan hash OTP, membuat random session secret, dan hanya menyimpan hash session proof. EA menampilkan OTP; session secret disimpan aman dan tidak pernah dicatat ke log.
4. Member login ke VIP Portal, memilih license miliknya dan mengirim OTP. Lookup/approval server memverifikasi Supabase user, kepemilikan license, status, expiry, product, mode/fingerprint, canary/global permission, dan kuota. Frontend bukan kontrol otorisasi.
5. EA melakukan poll `POST /api/license/v1/pair/poll` dengan `Authorization: Bearer <session_secret>`. `PENDING` berarti menunggu; hanya `APPROVED` dengan signed entitlement yang bisa mengaktifkan license.
6. OTP salah, expired, replay, ditolak, license bukan milik member, status tidak valid, kuota penuh, atau canary tidak cocok menghasilkan penolakan tegas dan rate-limit/audit yang sesuai.

Contoh pair/start response dummy:

```json
{
  "pairing_code":"38160427",
  "pairing_request_id":"f79ca26c-2979-4c1c-b927-e433668f7248",
  "session_secret":"<dummy-secret-never-use-in-production>",
  "expires_at":"2026-10-12T12:15:00.000Z",
  "poll_interval_seconds":15,
  "protocol_version":"v2",
  "ea_product_id":"quadriga",
  "ea_version":"1.8k"
}
```

Poll pending: `{"state":"PENDING","retry_after_seconds":15,"expires_at":"2026-10-12T12:15:00.000Z"}`. Poll approved berisi `state:"APPROVED"`, entitlement bertanda tangan, interval sync, retry, dan offline deadline server. OTP bukan license.

### Proteksi OTP

- OTP acak kriptografis, satu kali pakai, TTL pendek, disimpan sebagai hash, tak dicatat ke analytics/log.
- Rate limit pair/start berdasarkan sumber/akun, poll berdasarkan session hash, lookup/approve berdasarkan member/IP. Terapkan di server/database.
- Error tidak membocorkan apakah email/license milik orang lain. Session proof tidak muncul di audit log.
- Canary diverifikasi per binding/license/member di server. Tombol frontend yang aktif tidak memberi izin pairing.

## 4. Ed25519 entitlement

- Backend menandatangani entitlement dengan Ed25519; private key tetap secret Cloudflare. EA hanya memuat public key tersemat dan key ID yang disepakati.
- Claim mengikat minimal license, binding/fingerprint, product, account/mode, issue/server time, expiry, entitlement version dan offline deadline bila berlaku. Field wajib harus konsisten dengan kontrak API aktual.
- EA memverifikasi signature, trusted key ID, account fingerprint saat ini, product scope, masa berlaku, dan state sebelum entry. Signature/payload/key/fingerprint/time invalid atau claim tak dikenal berarti DENIED untuk entry baru.
- Jangan parse lalu menyusun ulang JSON sebelum signature check. Kontrak menetapkan canonical serialization dan byte UTF-8 persis yang ditandatangani. Perubahan serialization memerlukan protocol revision dan test vectors lintas platform.
- Test vectors memakai key terpisah; private test key tidak disertakan pada release. Public key production hanya boleh dipublikasikan setelah diturunkan dan dicocokkan tanpa membaca/mengekspos secret.
- Rotasi key: siapkan verifier menerima key lama+baru, publikasikan key ID, mulai signing baru, pantau adopsi, lalu cabut key lama. Jangan menebak atau mengganti production key tanpa verifikasi dan rencana owner.

## 5. License sync, offline, restart, denial

### Aturan v1.8k

- Sync sukses dijadwalkan setiap 15 menit. Kegagalan koneksi/service sementara dicoba ulang setelah 15 menit.
- Setelah maksimal 8 kegagalan beruntun ATAU 120 menit sejak validasi ACTIVE terakhir, EA menampilkan `LICENSE SYNC REQUIRED` dan memblokir entry baru. Kedua batas berlaku secara terpisah.
- Offline entitlement berakhir paling lambat pada waktu lebih awal antara expiry license dan 120 menit sesudah validasi ACTIVE terakhir.
- Hanya gangguan koneksi/service sementara boleh memakai offline cache. Server denial (suspend/revoke/expire/not-owner/quota/release) tidak boleh masuk offline grace.
- Restart/reinstall/reattach tidak menghapus state server, mereset offline timer, membuat binding/slot baru, atau menggandakan deal. EA memulihkan state lokal yang diperlukan lalu revalidate.
- Signature rusak, response malformed, clock claim invalid, atau state tak dikenal: fail-closed untuk entry. Jangan menutup posisi open hanya karena denial license.
- Hindari request berlipat dari multi-chart, tetapi server rate-limit/idempotency tetap wajib karena beberapa terminal bisa aktif bersamaan.

`POST /api/license/v1/sync` memakai `Authorization: Bearer <session_secret>`. Payload boleh memuat `magic_base` bila EA mendukung. v1.8k ACTIVE response menyediakan signed entitlement dan `next_sync_seconds:900`; denial server harus dipisahkan dari error transport. Jangan menganggap HTTP 200 saja sebagai ACTIVE—baca state dan verifikasi signature.

## 6. Release hold, ACK, dan slot

1. Klik Lepas membuat permintaan idempotent `PENDING_RELEASE`. Binding tetap terlihat, tetap memakai slot, dan status portal tidak boleh menjadi RELEASED sebelum server mengubahnya.
2. Sync berikut memberi `PENDING_RELEASE` + `release_id`. Semua chart/terminal pada binding memblokir entry baru.
3. EA membersihkan pending order HELIX sesuai kontrak; posisi open tetap dikelola normal. ACK dikirim hanya setelah pending-order state benar-benar terverifikasi bersih.
4. Tiap sesi terminal aktif yang diminta server mengirim `POST /api/license/v1/release/ack` dengan session proof, release ID, dan `pending_orders_clean:true`. Endpoint authenticated, binding/session-scoped, idempotent, dan ber-audit.
5. ACK salah, proof invalid/revoked, release ID berbeda, atau flag clean false ditolak. ACK satu terminal tidak membebaskan slot jika sesi aktif lain masih wajib ACK.
6. Server set `RELEASED` dan membebaskan slot hanya setelah seluruh syarat ACK terpenuhi. Terminal offline, timeout, atau 8 sync gagal bukan ACK. Force Release admin hanya sebagai override dengan warning eksplisit, alasan, dan audit.
7. HTTP 200 dapat mengembalikan state menunggu ACK sesi lain. Client membaca `state`, bukan hanya status HTTP. ACK duplikat untuk release sama harus aman dan konsisten.

Contoh ACK (dummy):

```http
POST /api/license/v1/release/ack
Authorization: Bearer <session-secret>
Content-Type: application/json
```
```json
{"release_id":"b00d867f-c3a8-49a9-9005-06c086821042","pending_orders_clean":true}
```

Response dapat memuat `state`, `idempotent`, `acked_sessions`, `required_sessions`, dan `released_at`.

## 7. Endpoint dan otorisasi

| Endpoint | Pemanggil | Aturan |
|---|---|---|
| `POST /api/license/v1/pair/start` | EA | Membuat OTP/session baru; tidak mengaktifkan license |
| `POST /api/license/v1/pair/poll` | EA | Session bearer; PENDING/APPROVED/REJECTED |
| `POST /api/license/v1/sync` | EA | Session bearer; signed ACTIVE, PENDING_RELEASE, RELEASED, atau denial |
| `POST /api/license/v1/release/ack` | EA | Session bearer + release ID; ACK per sesi |
| `POST /api/telemetry/v1/deals` | EA | Session proof → binding/license; telemetry tidak memberi akses |
| `/vip/api/member/pairings/...` | VIP member | Supabase token; server checks ownership/license/canary/quota |
| `/vip/api/admin/...` | Admin | Auth dan role admin diverifikasi server; operasi berhak diaudit |
| `GET /api/portal/v1/status` | Publik | Feature state non-secret saja |

Error harus machine-readable dan ditangani fail-closed jika tidak dikenal. Contoh: `SESSION_PROOF_REQUIRED`, `INVALID_REQUEST`, `FEATURE_NOT_ACTIVATED`, `INVALID_RELEASE_ID`, `PENDING_ORDERS_NOT_CLEARED`, `SESSION_INVALID`, `SESSION_REVOKED`, `ACTIVE_SLOTS_EXCEED_LIMIT`, `LICENSE_SUSPENDED`, `LICENSE_REVOKED`, `LICENSE_EXPIRED`, `PAIRING_NOT_APPROVED`, `RATE_LIMITED`. Jangan mengotorisasi berdasarkan teks pesan UI.

## 8. Telemetry: batas dan konsistensi

- Hanya session proof valid yang terhubung server ke member, license, dan binding tepat; client tidak menentukan `member_id` sebagai sumber otoritas.
- Ikuti schema EA eksplisit, termasuk `schema_version` dan basis waktu. `2-broker-time` adalah broker-local tanpa zona; jangan menganggap UTC secara diam-diam.
- Magic Base terdaftar per session/binding. Entry HELIX harus berada pada Base +1..47. Magic 0 hanya untuk exit jika kontrak EA menyatakan demikian dan provenance position dapat dibuktikan.
- Deduplikasi gunakan binding + deal ticket; pengelompokan lifecycle memakai position ID serta aturan yang diuji. Retry, replay, restart, multi-chart tidak menggandakan ledger.
- Partial close, INOUT, close-by, hedge/netting, commission/swap/fee harus dipetakan eksplisit. Ambiguitas dikecualikan, tidak ditebak.
- PnL disimpan per mata uang akun. Agregasi USD memakai rate admin yang ditampilkan. Demo/real tidak dicampur saat rekonsiliasi. Tampilkan First Recorded Trade, Last Sync, serta bahwa histori mungkin tidak lengkap.
- Publisher V3 bukan pengganti Trading EA atau sumber entitlement.

## 9. Schema dan migration database

- Schema menyimpan members, licenses, bindings, event audit, hashed pairing/session proof, release request/ACK per session, dan telemetry ledger dengan uniqueness/index untuk idempotency.
- Gunakan migration additive bernomor unik dengan preflight, privilege/RPC verification, serta cara rollback yang mempertahankan data. Jangan menjalankan `db push` jika bisa menerapkan migration lama/duplikat tanpa inspeksi.
- Migrasi Production perlu izin owner untuk operasi DB tersebut, backup yang terverifikasi dapat dipulihkan, cek project ref, preflight constraint/data, dan flag tetap OFF saat rollout awal. File SQL ada bukan bukti sudah dijalankan.
- Mutasi quota/status harus transaksional untuk mencegah race. RPC batasi `search_path`, validasi actor/ownership, dan cabut proof terkait.
- Jangan mengubah/menghapus customer, license, binding, expiry, ledger, atau audit sebagai efek samping migrasi tanpa rencana pelestarian dan izin owner.
- Preview/testing wajib jelas menunjuk project terpisah. Jangan biarkan URL/secret testing terhubung ke Production tanpa disengaja.

## 10. Semua versi dan code name EA

- Semua product/code name berbagi endpoint, state, slot semantics, interval/deadline, dan release ACK. `ea_product_id`, version, build, dan capability adalah metadata/negosiasi, bukan authorization.
- Naikkan protocol version bila perubahan memengaruhi signature serialization, auth, state machine, cadence/deadline, atau release. Perubahan kompatibel tetap melewati contract tests.
- Backend mencatat versi saat session/pair dibuat. Mengganti binary EA tidak memperbarui record. Untuk upgrade tak kompatibel perlu fresh authenticated session atau endpoint version-migration server-verified.
- Bila versi lama dan baru harus coexist, lakukan rollout gate per binding/member di server. Jangan menonaktifkan versi lama global sebelum seluruh terminal terdampak siap.
- Jangan mengganti License Client dengan Publisher V3, script lokal, atau UI portal.

## 11. Rollout, production verify, rollback

1. Tetapkan request/response, threat model, dan migration contract sebelum coding EA/backend paralel.
2. Terapkan migration additive di target yang benar, verifikasi objek/privilege/RPC, dan biarkan flag OFF.
3. Deploy backend kompatibel. Canary harus server-side per binding, bukan frontend-only.
4. Compile EA final; jalankan contract tests dan acceptance demo yang diizinkan.
5. PASS wajib: ACTIVE renewal; OTP invalid/replay/expired; owner mismatch; suspend/revoke/expiry; kuota penuh/akun keenam; pairing idempotent; entitlement test vectors; denial vs offline; gagal 1–8/120 menit; restart; pending order/open positions; multi-chart/terminal; ACK valid/invalid/duplicate; slot hold/free; audit; telemetry replay/isolation.
6. Periksa status endpoint, deployment commit/ID, DB state, serta portal member/admin. Hanya perluas flag setelah test PASS dan sesuai izin rollout owner.
7. Rollback tidak menghapus pending release/ACK/audit, tidak menghidupkan sesi revoked, tidak membebaskan pending slot, dan tidak membuat terminal protokol baru kembali mendapat akses dengan cache lama.

Production harus berasal dari `cloudflare-landing`; verifikasi deployment dan route publik setelah deploy, lalu sinkronkan backup lokal ke commit/source yang sama. Perubahan UI tidak mengotorisasi perubahan DB/secret.

## 12. Acceptance suite untuk setiap EA baru

**Pairing/auth:** OTP valid/invalid/expired/replay; member/license mismatch; canary denial; demo+real; akun keenam; chart ganda.  
**Signature:** valid/invalid, payload tampered, wrong key/key ID, wrong fingerprint, expired/revoked/suspended, malformed JSON, restart/cache.  
**Sync:** ACTIVE renewal 15 menit, transient failure 1–8, cutoff 120 menit, recovery, denial server tidak memakai offline, restart/reinstall/offline.  
**Release:** PENDING tetap memakai slot; semua terminal deny entry; pending HELIX bersih; posisi open dikelola; ACK salah/valid/duplicate; multi-session; terminal offline; RELEASED bebas slot; force release diaudit.  
**Regression:** ML/RL/SHL/LGL, sizing, entry/exit, Magic Base, schema telemetry, dan dedupe tidak berubah kecuali disetujui terpisah.

Arsipkan commit EA/backend, deployment ID, migration version, flags, fixture non-customer, timestamp, redacted request/response, dan hasil PASS/FAIL. Jangan sertakan secrets, session proof, atau PII tak diperlukan.

## 13. Security checklist

- **SQL/PostgREST injection:** validasi tipe/rentang/panjang, allowlist nama kolom/function, parameter SQL/RPC, encode dan validasi ID sebelum membentuk REST filter; service-role hanya di server.
- **XSS:** escape semua data dinamis saat masuk HTML; utamakan `textContent`; jangan render announcement sebagai HTML; link HTTPS memakai `noopener noreferrer`; validasi URL.
- **Brute force/abuse:** rate limit auth/pair/poll/approve/sync/ACK/admin writes per IP dan identitas; OTP/session proof di-hash; error tidak membocorkan akun; redact logs.
- **Defacement:** branch protection/review, deployment provenance, immutable commit artifact, secret scanning, Cloudflare access controls, backup dan rollback.
- **Malware/ransomware:** private storage, ukuran/extension/MIME/content validation, scanning attachment sebelum publish, signed URL singkat, jangan jalankan file upload, backup terenkripsi/offline, least privilege.
- **Framework/dependencies:** lockfile, audit advisories, patch terjadwal, kurangi dependencies, security headers/CSP/TLS, error generik tanpa stack/secret.
- **Authorization isolation:** uji akses antar-member pada API server-side, bukan tampilan saja; production testing harus non-destruktif dan fixture diizinkan.

## 14. Perubahan terlarang tanpa protocol revision

Tidak boleh melepas slot saat tombol ditekan; mengandalkan frontend flag; cache mengalahkan denial; grace berhari-hari untuk entry baru; membebaskan slot karena timeout/gagal sync; menutup posisi open semata karena license denied; menganggap demo gratis kuota; menghitung chart sebagai slot; magic tetap global; telemetry tanpa session-binding ownership; konversi mata uang diam-diam; atau membuka global flag tanpa acceptance test versi terminal terdampak.

Pengecualian membutuhkan revisi dokumen/protokol, backend contract tests, migration, EA tests, rollback plan, dan persetujuan owner.
