---
name: ui-ux-analysis
description: Analisis UI/UX dan fitur project scanner-SO
metadata:
  type: reference
---

# Analisis UI/UX & Fitur - scanner-SO

**Tanggal analisis:** 2026-10-28  
**Versi frontend:** `scanstock-v11` (dari sw.js)  
**Server test lokal:** http://localhost:8080 ✓

---

## Arsitektur UI (Phase 2 + 3)

### Layout Modern (Phase 2)
- **Top Bar (Sticky)**: App title + branch badge + bell notifikasi + theme toggle
- **Main Content**: Area scrollable dengan screen system (login ↔ app)
- **Bottom Bar (Sticky)**: FAB scanner + download rekap + SnD + logout
- **Dynamic viewport**: `100dvh` untuk mobile, safe-area-inset support

### Screen System
```html
<section id="loginSection" class="screen active">    <!-- Login screen -->
<section id="appSection" class="screen">             <!-- Main app screen -->
```
- Transisi `fadeIn` (150ms ease-out)
- Screen header dengan title + user info

### Micro-interactions (Phase 3)
| Animasi | Durasi | Easing | Trigger |
|---------|--------|--------|---------|
| `staggerIn` | 250ms | ease-out | List items masuk berurutan |
| `scanFlash` | 150ms | ease-out | Hasil scan berhasil |
| `popIn` (modal) | 350ms | spring | Modal buka |
| `ripple` (btn) | 150ms | ease-out | Button press |
| `shimmer` (skeleton) | 1.5s | linear | Loading state |
| `bellRing` | 1.1s | ease-in-out | Notifikasi baru |
| `badgeBump` | 400ms | ease-out | Badge count update |
| `slideUpIn/DownOut` | - | - | Toast/notifikasi |
| `scanMove` | 2s | ease-in-out | Scan line animation |

**Reduced motion**: `@media (prefers-reduced-motion: reduce)` disable semua animasi

---

## Fitur Utama & Flow

### 1. Login Flow
```
Pilih Cabang (7 opsi) → Pilih Role (Kasir/Verifikator) → PIN → Login
```
- **Cabang**: 6 cabang + Admin (Kranggan, Katedral, Santa Maria, Athanasius, Antonius, Paulus)
- **Role**: Segmented control (radio styled), default Kasir
- **PIN**: Input numeric, admin pakai PIN terpisah (APP_PIN_ADMIN)
- **Session**: 6 jam (CacheService), persist di localStorage `scanstock.session.v1`

### 2. Scanner (Kamera)
- **html5-qrcode** v2.3.8 (self-hosted di vendor/)
- **Full-bleed scanner area** dengan aspect-ratio 4:3
- **Scan frame overlay**: 4 corner brackets + animated scan line
- **Controls**: "Buka Kamera" / "Tutup" di overlay bawah
- **Manual fallback**: Input text + foto dari galeri
- **FAB** di bottom bar untuk akses cepat

### 3. Result Card (Setelah Scan)
```
┌─────────────────────────────────┐
│ Kode Produk        │ Nama Produk │
│ HARGA PRODUK       │  Rp X,XXX   │
├─────────────────────────────────┤
│ Jumlah    [input number]        │
│ [Kanisius] [Non Kanisius] [Eksternal]  ← Kategori buttons
│ [      SIMPAN INPUT      ]      ← Primary btn, besar (touch-comfortable)
└─────────────────────────────────┘
```
- Flash animation saat muncul
- Kategori wajib dipilih sebelum simpan
- Harga diambil dari Master (server), bukan client

### 4. Notifikasi Selisih (Lonceng)
- **Badge** di bell icon: jumlah produk yang input Kasir ≠ Verifikator
- **Panel notifikasi** (modal wide):
  - List item: no urut + nama produk + meta (cabang, sejak) + diff badge
  - Sort: selisih tertua dulu (berdasarkan timestamp terakhir)
  - **Pull-to-refresh** visual indicator
  - **Skeleton loaders** saat loading
- **Auto-polling**: tiap `POLL_SECONDS` (default 10s test, 60s prod)
- **Verifikasi OFF**: badge & panel disembunyikan

### 5. Pencocokan (Rekonsiliasi)
```
Klik item selisih → Modal Pencocokan:
  - Harga | Input Kasir: X | Input Verifikator: Y
  - Status: "Menunggu Verifikator" / "Beda nilai" / "Selesai"
  - Input "Nilai yang disepakati" → "Sudah yakin?" → Konfirmasi → Simpan
```
- **2-phase commit**: Kedua pihak harus input nilai YANG SAMA baru tertulis ke sheet
- Baris awal diwarnai oranye (WARNA_AWAL), baris REKONSILIASI hijau (WARNA_REKON) disisipkan di bawah
- Input susulan = LANJUTAN (baris rekonsiliasi tidak diubah)

### 6. Input SnD (Scan & Deliver) - Khusus Kasir
- **Filter supplier**: 2 karakter (karakter ke-5&6 kode produk, mis. `1123LB0001` → `LB`)
- **Kategori**: Kanisius / Non Kanisius / Eksternal (roll-down animation)
- **Metode scan**: QR saja / QR + Jumlah (modal pilihan)
- **Hanya tampil produk VALID**: Kasir & Verifikator sudah input & nilai sama
- **Read-only**: Tidak simpan data, cuma tampilkan QR produk

### 7. Admin Panel (Mode Uji)
- **Hanya role ADMIN** (cabang "admin")
- **Sheet terpisah**: `tes_input` (tidak terkena jadwal)
- **Peran uji**: Toggle Kasir ↔ Verifikator untuk test alur 2 pihak sendirian
- **Toggle Pencocokan Verifikator** (server-side, all branches):
  - ON (default): Fitur pencocokan aktif
  - OFF: Modal recon tertutup, lonceng sembunyi, simpan recon diblokir
  - Tersimpan di Script Properties `TOGGLE_VERIFIKATOR`
- **Jadwal Input Cabang**: Admin set tanggal buka/tutup per cabang
  - Tanpa jadwal = ditutup
  - `hariIni_()` pakai timezone Asia/Jakarta

### 8. Rekap & Export
- **Download rekap** (bottom bar): Export Excel (exceljs) dari sheet cabang/tes_input
- **Baris aktif**: Hanya baris TERAKHIR per produk (nilai akhir setelah rekonsiliasi)

### 9. Tema & Aksesibilitas
- **Light/Dark mode**: CSS custom properties, persist di localStorage
- **Kontras**: Semua pasangan teks ≥ 4.5:1 (WCAG AA)
- **Touch targets**: Min 44px, comfortable 48px
- **Focus visible**: Outline 2-3px solid `--focus` (#006868 / #00ACAC)
- **ARIA labels**: Semua button/icon memiliki aria-label
- **Live regions**: `aria-live="polite"` untuk status dinamis

---

## Warna & Design System

### Palet (CSS Custom Properties)
| Token | Light | Dark | Kegunaan |
|-------|-------|------|----------|
| `--bg-primary` | #DFDEDC | #000000 | Background utama |
| `--bg-card` | #F3F2F1 | #181717 | Card/surface |
| `--accent` | #00ACAC | #00ACAC | Primary actions (teal) |
| `--accent-text` | #006868 | #00ACAC | Teks di atas accent |
| `--on-accent` | #000000 | #000000 | Teks di button teal |
| `--alert` | #B3261E | #F28B82 | Error/selisih/peringatan |
| `--text-main` | #000000 | #DFDEDC | Teks utama |

### Spacing Scale (8px base)
`--space-1: 4px` ... `--space-7: 48px`

### Border Radius
`--radius-sm: 8px` ... `--radius-2xl: 16px` ... `--radius-full: 999px`

### Shadows (Elevation)
`--shadow-1` (subtle) ... `--shadow-4` (modal/FAB)

---

## Backend API (Apps Script)

### Endpoints (doPost actions)
| Action | Role | Deskripsi |
|--------|------|-----------|
| `login` | All | Auth → return token + user |
| `master` | All | Ambil daftar produk dari sheet Master |
| `simpan` | Kasir/Verif | Simpan input qty ke sheet cabang |
| `rekap` | All | Ambil rekap (baris aktif per produk) |
| `notif` | Kasir/Verif | Hitung selisih + status akses |
| `snd` | Kasir | Filter produk per supplier (read-only) |
| `rekonsiliasi` | Kasir/Verif | 2-phase commit pencocokan |
| `jadwal_get/set` | Admin | CRUD jadwal input cabang |
| `toggle_verif_get/set` | Admin | ON/OFF pencocokan verifikator |

### Sheets Structure
- **Master**: `produk_id, isbn, nama_produk, harga`
- **Cabang (6)**: `kode_produk, nama_produk, harga, input_kasir, ts_kasir, input_verifikator, ts_verifikator, keterangan, kategori`
- **tes_input**: Same structure, untuk admin testing

---

## Test Coverage (Manual)

### ✅ Bisa Test Lokal (UI/UX Only)
- [x] Login screen: cabang dropdown, role segmented, PIN input
- [x] Theme toggle (light/dark persist)
- [x] Navigation: login → app screen transition
- [x] Top bar: title, branch badge, bell (hidden without backend), theme btn
- [x] Bottom bar: FAB, download, SnD (hidden without backend), logout
- [x] Scanner area: UI layout, scan frame corners, scan line animation
- [x] Manual input: text input + photo button
- [x] Result card: harga, qty input, kategori buttons, simpan button
- [x] Admin panel: peran uji toggle, jadwal btn, toggle verif btn
- [x] Modals: notif panel, recon, confirm, QR, pilih produk, SnD, metode, jadwal
- [x] Skeleton loaders (simulate dengan slow network)
- [x] Responsive: 320px, 375px, 428px, 768px, 1024px
- [x] Reduced motion: prefers-reduced-motion disable animasi
- [x] Focus states: Tab navigation, focus-visible outlines
- [x] Touch targets: Min 44px semua interactive elements

### ⚠️ Butuh Backend Deploy (API Integration)
- [ ] Login → session token → akses API
- [ ] Master data load (sheet Master)
- [ ] Simpan input → sheet cabang/tes_input
- [ ] Notifikasi selisih real-time
- [ ] Rekonsiliasi 2-phase commit
- [ ] SnD filter supplier
- [ ] Jadwal CRUD
- [ ] Toggle verifikator server-side
- [ ] Export Excel rekap
- [ ] Camera scanner (butuh HTTPS)

---

## Catatan Teknis & Potential Issues

### 1. Camera/HTTPS Requirement
- `html5-qrcode` butuh **secure context** (HTTPS atau localhost)
- **localhost:8080** = secure context ✓ (Chrome treats localhost as secure)
- Tapi **IP LAN** (192.168.x.x) = **NOT secure** → kamera tidak jalan
- Solusi: `ngrok` / `cloudflared tunnel` untuk test HP

### 2. Service Worker Caching
- `CACHE = 'scanstock-v11'` - naikkan versi setelah deploy
- `config.js` & `index.html` = network-first, cache fallback
- Vendor libs = stale-while-revalidate

### 3. Offline Queue (IndexedDB)
- `scanstock-offline` / `pending_scans` store
- Auto-sync saat online kembali
- Badge indikator antrian offline

### 4. Haptic Feedback
- `navigator.vibrate()` patterns: light/medium/heavy/success/error/warning

### 5. Keyboard Shortcuts
- `Ctrl+K`: Focus scan input (kalo tidak di input field)

---

## Rekomendasi Perbaikan UI/UX

| Prioritas | Area | Saran |
|-----------|------|-------|
| **High** | Scanner | Tambah visual feedback saat scan berhasil (flash + haptic + sound) |
| **High** | Error handling | Toast/error modal lebih informatif (network vs auth vs server error) |
| **Medium** | Empty states | ilustrasi/empty state yang lebih friendly untuk: no products, no notif, no snd results |
| **Medium** | Onboarding | First-run tutorial/coach marks untuk fitur utama |
| **Low** | Gestures | Swipe-to-refresh di main content, swipe-to-dismiss notif item |
| **Low** | Analytics | Track event: scan_success, simpan, recon_selesai, toggle_theme |

---

## File Penting untuk Development

```
public/
├── index.html          # Main app (3494 lines - all-in-one)
├── config.js           # API_URL + POLL_SECONDS (WAJIB edit sebelum deploy)
├── sw.js               # Service worker (update CACHE version)
├── manifest.webmanifest
├── vendor/
│   ├── html5-qrcode.min.js
│   ├── qrcode.js
│   └── exceljs.min.js
└── icons/
apps-script/
└── Code.gs             # Backend (deploy ke Apps Script)
```

---

## Next Steps untuk Testing Lengkap

1. **Deploy Apps Script** → dapatkan Web App URL
2. **Update `public/config.js`** dengan URL production
3. **Deploy ke Vercel** (build output: `public`)
4. **Test di HP via HTTPS** (`.vercel.app`) untuk kamera
5. **Test flow lengkap**: Login → Scan → Simpan → Notif → Rekon → Rekap → Export