# System Scan & Stock (PWA)

Aplikasi scan barcode dan input stok per cabang, dengan tiga peran: **Kasir**, **Verifikator**, dan **Admin**.

- **Frontend**: HTML/JS statis, di-host di **Cloudflare Pages**
- **Backend**: **Google Apps Script** sebagai API JSON, data tersimpan di Google Sheets

## Struktur folder

```
index.html              tampilan + logika (satu file)
config.js               URL Web App Apps Script + interval polling (WAJIB diisi)
manifest.webmanifest    agar bisa di-install sebagai aplikasi
sw.js                   service worker (cache cangkang aplikasi)
_headers                header Cloudflare Pages (izin kamera, CSP, cache)
icons/                  ikon aplikasi
vendor/                 library di-host sendiri: html5-qrcode (scanner), qrcode.js (pembuat QR),
                        exceljs (ekspor rekap .xlsx, dimuat hanya saat diunduh)
apps-script/Code.gs     -> disalin ke editor Apps Script (tidak ikut dipakai di browser)
```

File pengembangan berikut **bukan bagian aplikasi** dan tidak perlu di-deploy:
`findings.json`, `patch1.txt`, `temp_end_check.txt`, `test-validation.js`, `verify_4.js`.
(`findings.json` dan `test-validation.js` merujuk versi `Code.gs` yang lebih lama, jadi isinya sudah tidak mewakili kode sekarang.)

> **Saran:** pindahkan file aplikasi (`index.html`, `config.js`, `manifest.webmanifest`, `sw.js`, `_headers`, `icons/`, `vendor/`)
> ke folder `public/` dan jadikan itu *output directory* di Cloudflare Pages. Dengan begitu `apps-script/` dan file
> pengembangan di atas tidak ikut terpublikasi.

## 1. Pasang backend (Apps Script)

1. Buka Google Spreadsheet yang berisi sheet `Master` dengan kolom A–D: `produk_id`, `isbn`, `nama_produk`, `harga`.
2. **Extensions → Apps Script**. Hapus isi lama, tempel isi `apps-script/Code.gs`, simpan.
3. **Project Settings → Script Properties → Add** (WAJIB, ketiganya):

   | Nama | Dipakai untuk |
   |---|---|
   | `APP_PIN` | PIN **Kasir** (satu PIN untuk semua cabang) |
   | `APP_PIN_VERIFIKATOR` | PIN **Verifikator** (satu PIN untuk semua cabang) |
   | `APP_PIN_ADMIN` | PIN **Admin** (Super User) |

   Nilai bawaan di kode (`PIN_DEFAULT`, `PIN_ADMIN_DEFAULT`, `PIN_VERIFIKATOR_DEFAULT`) sengaja kosong.
   Jika sebuah properti belum diisi, login untuk peran itu ditolak dengan pesan yang menyebut properti mana yang kurang.
4. **Deploy → New deployment → Web app**
   - Execute as: **Me**
   - Who has access: **Anyone**
5. Salin **Web app URL** (berakhiran `/exec`). Setiap mengubah `Code.gs`, buat versi baru:
   **Deploy → Manage deployments → Edit → Version: New version → Deploy**.

Sheet per cabang (`kranggan`, `katedral`, `santamaria`, `athanasius`, `antonius`, `paulus`) dan sheet uji `tes_input`
dibuat otomatis saat pertama dipakai, dengan kolom: `kode_produk`, `nama_produk`, `harga`, `input_kasir`,
`timestamp_kasir`, `input_verifikator`, `timestamp_verifikator`, `keterangan`, `kategori`.
Jika sheet dengan nama itu sudah ada dan baris 1-nya bukan format di atas, aplikasi menolak menulis ke sheet tersebut.

## 2. Isi alamat API

Edit `config.js`:

```js
window.APP_CONFIG = {
  API_URL: "https://script.google.com/macros/s/XXXX/exec",   // URL Web App tadi
  POLL_SECONDS: 60                                           // lihat bagian Notifikasi
};
```

`API_URL` harus diawali `https://script.google.com/`. Jika `config.js` gagal dimuat, aplikasi memakai nilai cadangan
`window.APP_DEFAULTS` di bagian atas `index.html`; **ubah juga URL di sana** bila Web App di-deploy ulang dengan URL baru.

## 3. Buat repo GitHub

```bash
git init
git add .
git commit -m "Versi awal: Scan & Stock PWA"
git branch -M main
git remote add origin https://github.com/<username>/<nama-repo>.git
git push -u origin main
```

(Buat repo kosong dulu di github.com → New repository, tanpa README/.gitignore bawaan.)

## 4. Deploy ke Cloudflare Pages

1. Dashboard Cloudflare → **Workers & Pages → Create → Pages → Connect to Git**, pilih repo tadi.
   (Nama menu bisa sedikit berbeda tergantung versi dashboard.)
2. Pengaturan build:
   - Framework preset: **None**
   - Build command: *(kosongkan)*
   - Build output directory: **`public`** jika file aplikasi sudah dipindah ke `public/` (disarankan),
     atau *(kosongkan / root)* jika struktur tetap datar seperti sekarang
3. **Save and Deploy**. Hasilnya `https://<nama-proyek>.pages.dev` (HTTPS, jadi kamera bisa dipakai).

Setiap `git push` ke `main` otomatis men-deploy ulang.

## 5. Uji di HP

1. Buka alamat `.pages.dev` di Chrome → pilih cabang & peran → masukkan PIN → **Buka Kamera** → izinkan kamera.
2. Menu Chrome (⋮) → **Install app / Add to Home screen**.

## Peran dan login

- Login memilih **cabang** (atau **Super User (Admin)**) lalu **peran** Kasir / Verifikator, dan memasukkan PIN peran tersebut.
- Sesi berlaku **6 jam sejak aktivitas terakhir** (diperpanjang setiap permintaan ke server), lalu diminta login lagi.
- Cabang, role, nama, dan harga ditentukan **server** dari sesi dan sheet `Master`, bukan dari browser.
- Salah PIN ditunda ±0,8 detik sebelum dijawab.
- **Menambah cabang**: ubah `CABANG_VALID` di `Code.gs`, lalu tambahkan `<option>` di **dua** tempat pada `index.html`
  (daftar cabang di form login dan daftar sheet di panel unduh rekap admin).

## Jadwal input per cabang (Admin)

- Admin mengatur tanggal-tanggal yang diizinkan untuk tiap cabang. **Tanpa tanggal = cabang ditutup.**
- Pada hari yang tidak terdaftar (zona waktu WIB), **simpan stok dan pencocokan ditolak** dengan pesan jadwal berikutnya.
- Unduh rekap tetap bisa dilakukan kapan saja. Maksimal 400 tanggal per cabang.
- Sheet uji `tes_input` tidak terkena jadwal.

## Mode uji Admin

- Admin **tidak menyentuh data cabang**. Semua aksi admin diarahkan ke sheet `tes_input`.
- Admin dapat memilih **peran uji** (Kasir atau Verifikator) untuk menguji alur dua pihak.
- Ekspor rekap oleh admin bisa memilih `tes_input` atau cabang (hanya baca).

## Notifikasi selisih & pencocokan

- Lonceng di pojok kanan atas (sebelah tombol tema) hanya untuk Kasir dan Verifikator. Badge = jumlah produk yang
  sudah diinput KEDUA peran tetapi nilainya berbeda. Urutan daftar: selisih terlama lebih dulu
  ("sejak" = waktu input terakhir dari kedua peran).
- Aplikasi mengecek server tiap `POLL_SECONDS` detik (`config.js`; bawaan kode 60, minimum 5), hanya saat tab terlihat.
  Server men-cache hasil hitungan selisih selama 60 detik (cache dihapus otomatis saat ada simpan/pencocokan).
  Pada `config.js` yang disertakan nilainya masih **10 (untuk uji coba)**; naikkan ke 60 untuk pemakaian harian.
- **Pencocokan butuh persetujuan dua pihak.** Kasir dan Verifikator masing-masing mengajukan nilai yang valid
  (klik baris → isi nilai → "Sudah yakin?"):
  1. Baru satu pihak mengajukan → pengajuan disimpan sementara, **sheet tidak berubah**.
  2. Kedua pihak mengajukan nilai **sama** → sheet ditulis: baris awal diwarnai oranye (nilai tidak diubah, kolom H
     ditandai `SELISIH`), satu baris `REKONSILIASI` hijau disisipkan tepat di bawahnya (kolom H mencatat siapa,
     kapan, nilai awal, dan nilai valid).
  3. Kedua pihak mengajukan nilai **berbeda** → kedua pengajuan dibatalkan, sheet tidak berubah, ulangi dari awal.
- Jika nilai produk berubah (ada input baru) saat pengajuan berjalan, pengajuan lama dibatalkan.
- Rekap, notifikasi, dan Input SnD selalu membaca baris TERAKHIR tiap produk.
- Input susulan setelah rekonsiliasi dicatat di baris baru berlabel `LANJUTAN` (baris rekonsiliasi tidak pernah diubah).

## Toggle Pencocokan Verifikator (Admin)

- Hanya role **ADMIN** yang melihat tombol toggle di panel admin. Muncul konfirmasi saat mematikan maupun mengaktifkan.
- Status **disimpan di server** (Script Property `TOGGLE_VERIFIKATOR`) dan berlaku untuk **semua cabang**.
  `localStorage` hanya salinan lokal; nilai dari server yang dipakai saat aplikasi dimuat.
- Badge **Verif: AKTIF / NONAKTIF** tampil untuk semua pengguna.
- Tombol berubah teks sesuai status:
  - `Matikan Pencocokan Verifikator` → pencocokan Kasir ↔ Verifikator **AKTIF** (default).
  - `Aktifkan Pencocokan Verifikator` → pencocokan **MATI**.
- Saat MATI:
  - **Login Verifikator ditolak** oleh server dan pilihan peran Verifikator dinonaktifkan di form login.
  - Modal Pencocokan Selisih tidak dapat dibuka dan lonceng notifikasi disembunyikan.
  - Aksi pencocokan diblokir di frontend.
  - Input SnD hanya mensyaratkan Kasir sudah input (tanpa menunggu Verifikator).
- Fitur input stok Kasir tetap bekerja normal baik toggle ON maupun OFF.

## Modal input produk

- Setelah produk ditemukan (scan kamera, foto, ketik kode, atau pilih dari daftar), muncul **modal di tengah layar**
  berisi ID, nama, harga, kolom Jumlah (bawaan 1), dan pilihan kategori.
- Produk berkode alfanumerik 10 karakter (mis. `1123LB0001`) otomatis berkategori Eksternal.
- **Simpan** menutup modal lalu menampilkan pesan hasil; **Batal** menutup modal dan kamera lanjut memindai.
- Kamera berhenti sementara selama modal terbuka. Jika jadwal input cabang sedang tutup, tombol Simpan dinonaktifkan.

## Input SnD (khusus Kasir)

- Menampilkan produk per **kode supplier** = karakter ke-5 dan ke-6 kode produk (mis. `1123LB0001` → `LB`). Isi tepat 2 karakter.
- Hanya produk yang jumlahnya **sudah valid** yang tampil: kedua peran sudah input dan nilainya sama
  (hasil pencocokan atau memang sama sejak awal). Produk yang belum valid dihitung sebagai "belum".
  Saat toggle pencocokan MATI, cukup Kasir yang sudah input.
- Tanda centang (✓) muncul pada produk yang QR-nya sudah dibuka. Centang **disimpan di server** pada sheet
  `snd_centang` (kolom `cabang`, `kode_produk`, `waktu`, `oleh`; dibuat otomatis), per cabang (admin: `tes_input`), sehingga
  tidak hilang saat aplikasi ditutup, besok hari, atau berganti perangkat. Centang dimuat tiap kali Input SnD dibuka.
  Jika koneksi putus, centang tertahan dan dikirim ulang pada centang berikutnya atau saat SnD dibuka lagi.
  Untuk memulai siklus baru: tombol **Hapus semua centang** di layar pilihan kategori (menghapus untuk cabang itu saja),
  atau hapus barisnya langsung di sheet. Setelah QR ditutup, tampilan **tetap di daftar produk**
  selama masih ada produk yang belum bercentang di daftar itu (mis. supplier `JR`); jika halaman yang tampil sudah
  tercentang semua, tampilan pindah ke halaman yang masih punya produk belum bercentang. Kembali ke pilihan kategori
  hanya jika semua produk sudah bercentang, atau daftar hanya berisi satu produk.
- Fitur ini hanya membaca, tidak menyimpan apa pun ke sheet.

## QR Code dengan perintah "Enter"

- Tombol tampilkan QR di layar SnD membuat QR berformat `KODE` atau `KODE|JUMLAH`, diakhiri karakter
  **Carriage Return (`\r`)**.
- Saat QR discan scanner barcode (mode keyboard wedge), scanner mengetik isi QR lalu menekan **Enter** otomatis,
  sehingga kursor pindah ke kolom/baris berikutnya. Contoh isi: `ITEM001|5` + Enter (dikirim sebagai `ITEM001|5\r`).
- Perilaku ini bergantung pada konfigurasi scanner handheld. Beberapa scanner memfilter karakter kontrol;
  pastikan scanner diatur mengirim suffix Enter setelah scan.

## Pencarian produk (ketik)

- Tidak peka huruf besar/kecil (`1123lb0001` = `1123LB0001`). Spasi dan tanda minus diabaikan.
- Urutan: kode persis (produk_id atau ISBN) → kode yang BERAKHIRAN dengan yang diketik (`23lb0001`, `lb0001`)
  → kode yang memuat yang diketik. **Minimal 3 karakter** untuk pencarian sebagian.
- Jika cocok dengan lebih dari satu produk, muncul daftar pilihan (maksimal 50 baris, bagian yang diketik disorot).
- Scanner kamera/foto tetap memakai kode persis (tidak sebagian), supaya hasil scan tidak salah produk.

## Rekap (unduh Excel)

- Tombol unduh di bar bawah membuka modal **Ekspor Rekap** untuk semua peran. File `.xlsx` berisi perbandingan Kasir vs
  Verifikator, satu baris per produk (nilai terakhir, setelah rekonsiliasi).
- **Sheet**: Kasir/Verifikator selalu cabangnya sendiri. Admin memilih `tes_input` atau salah satu cabang (hanya baca,
  tidak mengubah data).
- **Rentang tanggal (opsional)**: kosongkan untuk semua data. Filter memakai **tanggal input terakhir** tiap produk
  (yang lebih baru antara waktu Kasir dan waktu Verifikator, zona WIB, batas awal dan akhir ikut). Produk yang belum punya
  waktu input tidak ikut saat filter dipakai. Format salah atau "Dari" setelah "Sampai" ditolak server.
- Kolom: `produk_id`, `nama_produk`, `harga`, `qty_kasir`, `qty_verifikator`, `selisih` (rumus D−E), `Kategori`,
  `waktu_kasir`, `waktu_verifikator`, `keterangan`. Baris yang selisihnya tidak nol diberi latar abu-abu muda;
  judul dibekukan dan ada filter otomatis.
- Nama file: `Rekap_Perbandingan_<SHEET>_<tanggal>.xlsx`, dengan akhiran `_<dari>_sd_<sampai>`, `_sejak_<dari>`,
  atau `_sampai_<sampai>` sesuai filter.
- Pustaka `exceljs` dimuat hanya saat tombol Ekspor dipakai.

## Warna

Palet: `#000000`, `#DFDEDC`, `#464545`, `#00ACAC` (teal), `#A6A7A2`. Semua warna ada di blok `:root` (terang) dan
`[data-theme="dark"]` (gelap) di `index.html`. Teal dipakai sebagai latar tombol dengan teks hitam; untuk teks/garis
di mode terang dipakai `--accent-text` (teal lebih gelap) agar kontras minimal 4.5:1. Warna merah (selisih/peringatan)
sengaja di luar palet karena bermakna peringatan.

## Catatan

- Setelah mengubah file aplikasi (`index.html`, dll.), naikkan nomor `CACHE` di `sw.js` (saat ini `scanstock-v13`,
  jadi berikutnya `v14`) agar HP mengambil versi terbaru.
- Setelah mengubah `Code.gs`, selalu buat versi deployment baru (Deploy > Manage deployments > Edit > New version).
- Aplikasi memerlukan internet. Jika penyimpanan stok gagal karena koneksi, input masuk antrean offline di browser
  (badge offline tampil) dan dikirim otomatis saat koneksi kembali atau aplikasi dibuka lagi.
