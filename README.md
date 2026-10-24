# System Scan & Stock (PWA)

Aplikasi scan barcode dan input stok per cabang (Kasir & Verifikator).

- **Frontend**: folder `public/` — HTML/JS statis, di-host di **Cloudflare Pages**
- **Backend**: folder `apps-script/` — **Google Apps Script** sebagai API JSON, data tersimpan di Google Sheets

```
public/                 -> di-deploy ke Cloudflare Pages (output directory)
  index.html            tampilan + logika
  config.js             URL Web App Apps Script (WAJIB diisi)
  manifest.webmanifest  agar bisa di-install sebagai aplikasi
  sw.js                 service worker (cache cangkang aplikasi)
  _headers              header Cloudflare Pages (izin kamera, dll.)
  icons/  vendor/       ikon & library scanner (html5-qrcode 2.3.8, di-host sendiri)
apps-script/Code.gs     -> disalin ke editor Apps Script
```

## 1. Pasang backend (Apps Script)

1. Buka Google Spreadsheet yang berisi sheet `Master` (kolom: produk_id, isbn, nama_produk, harga).
2. **Extensions → Apps Script**. Hapus isi lama, tempel isi `apps-script/Code.gs`, simpan.
3. (Disarankan) **Project Settings → Script Properties → Add**: nama `APP_PIN`, nilai PIN Anda.
   Jika tidak diisi, PIN bawaan di kode (`PIN_DEFAULT`) yang dipakai.
4. **Deploy → New deployment → Web app**
   - Execute as: **Me**
   - Who has access: **Anyone**
5. Salin **Web app URL** (berakhiran `/exec`). Setiap mengubah `Code.gs`, buat versi baru:
   **Deploy → Manage deployments → Edit → Version: New version → Deploy**.

## 2. Isi alamat API

Edit `public/config.js`, ganti `GANTI_DENGAN_URL_WEB_APP_APPS_SCRIPT` dengan URL tadi.

## 3. Buat repo GitHub

```bash
cd scan-stock-pwa
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
   - Build output directory: **`public`**
3. **Save and Deploy**. Hasilnya `https://<nama-proyek>.pages.dev` (HTTPS, jadi kamera bisa dipakai).

Setiap `git push` ke `main` otomatis men-deploy ulang.

## 5. Uji di HP

1. Buka alamat `.pages.dev` di Chrome → login → **Buka Kamera** → izinkan kamera.
2. Menu Chrome (⋮) → **Install app / Add to Home screen**.

## Catatan

- Sesi login berlaku maksimal 6 jam, lalu diminta login lagi.
- Cabang, role, nama, dan harga ditentukan **server** dari sesi dan sheet `Master`, bukan dari browser.
- Menambah cabang: ubah `CABANG_VALID` di `Code.gs` dan daftar `<option>` di `public/index.html`.
- Setelah mengubah file di `public/`, naikkan `CACHE = 'scanstock-v2'` di `sw.js` (mis. `v2`) agar HP mengambil versi terbaru.
- Aplikasi memerlukan internet; belum ada antrean offline.

## Notifikasi selisih & pencocokan

- Lonceng di pojok kanan atas (sebelah tombol tema) hanya untuk Kasir dan Verifikator. Badge = jumlah produk yang
  sudah diinput KEDUA peran tetapi nilainya berbeda. Urutan daftar: selisih terlama lebih dulu
  ("sejak" = waktu input terakhir dari kedua peran).
- Aplikasi mengecek server tiap `POLL_SECONDS` detik (`public/config.js`, bawaan 60, minimum 15), hanya saat tab terlihat.
- Klik baris -> isi nilai valid -> "Sudah yakin?" -> disimpan. Di sheet cabang: baris awal diwarnai oranye (nilai tidak diubah),
  satu baris REKONSILIASI hijau disisipkan tepat di bawahnya (kolom H "keterangan" mencatat siapa & nilai awal).
  Rekap dan notifikasi selalu membaca baris TERAKHIR tiap produk.
- Input susulan setelah rekonsiliasi dicatat di baris baru berlabel LANJUTAN (baris rekonsiliasi tidak pernah diubah).
- Setelah mengubah `Code.gs`, selalu buat versi deployment baru (Deploy > Manage deployments > Edit > New version).
