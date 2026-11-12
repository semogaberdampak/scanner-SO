---
name: project-overview
description: Ringkasan project scanner-SO (PWA scan barcode & stok)
metadata:
  type: project
---

# Project: System Scan & Stock (PWA)

**Lokasi:** D:\_Nitip\awud\scanner-SO

## Arsitektur
- **Frontend** (`public/`): HTML/JS statis, di-host di **Netlify**
- **Backend** (`apps-script/`): **Google Apps Script** sebagai API JSON, data di Google Sheets

## Fitur Utama
- Scan barcode (kamera/HP) + input stok per cabang
- Dua role: **Kasir** & **Verifikator** (pencocokan data antar role)
- Role **Admin** punya toggle "Mode Uji" (matikan/aktifkan pencocokan verifikator)
- PWA: installable, service worker, HTTPS via Netlify
- Sesi login max 6 jam

## Konfigurasi Penting
- `public/config.js` → URL Web App Apps Script (WAJIB diisi)
- `apps-script/Code.gs` → deploy sebagai Web App (Execute as: Me, Who has access: Anyone)
- `sw.js` → cache version (`CACHE = 'scanstock-v2'`), naikkan versi setelah ubah file
- `CABANG_VALID` di `Code.gs` + `<option>` di `index.html` untuk daftar cabang

## Warna (CSS Custom Properties)
- Palet: `#000000`, `#DFDEDC`, `#464545`, `#00ACAC` (teal), `#A6A7A2`
- Teal untuk tombol dengan teks hitam
- Merah untuk selisih/peringatan (di luar palet, bermakna warning)

## Notifikasi & Rekonsiliasi
- Lonceng (badge) = jumlah produk dengan input ganda tapi nilai berbeda
- Polling tiap `POLL_SECONDS` detik (default 60, min 5)
- Klik baris selisih → isi nilai valid → "Sudah yakin?" → simpan
- Di sheet: baris awal oranye + baris REKONSILIASI hijau di bawahnya
- Input susulan = LANJUTAN (baris rekonsiliasi tidak diubah)

## QR Code
- Setiap QR diakhiri `\r` (Carriage Return) → scanner keyboard wedge auto Enter
- Contoh: `ITEM001|5\r`