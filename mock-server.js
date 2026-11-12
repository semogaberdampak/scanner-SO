/**
 * Mock Server for scanner-SO
 * Meniru Google Apps Script API (doPost actions)
 * Jalankan: node mock-server.js
 * Endpoint: http://localhost:3000/api
 */

const express = require('express');
const cors = require('cors');
const fs = require('fs').promises;
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const ExcelJS = require('exceljs');

const app = express();
const PORT = 3000;
const DATA_DIR = path.join(__dirname, 'mock-data');
const SHEETS_DIR = path.join(DATA_DIR, 'sheets');

// ===== CONFIG =====
const SESSION_SECONDS = 6 * 60 * 60; // 6 jam
const CABANG_VALID = ['kranggan', 'katedral', 'santamaria', 'athanasius', 'antonius', 'paulus'];
const ROLE_VALID = ['KASIR', 'VERIFIKATOR'];
const SHEET_UJI = 'tes_input';
const PIN_DEFAULT = '123456';
const PIN_ADMIN_DEFAULT = 'admin123';
const PIN_VERIFIKATOR_DEFAULT = 'verif123';
const TZ_AKSES = 'Asia/Jakarta';
const FORMAT_WAKTU = 'dd/MM/yyyy HH:mm:ss';
const WARNA_AWAL = '#FCE4D6';
const WARNA_REKON = '#E2EFDA';

// Column indices (1-based like Apps Script)
const HEADER = ['kode_produk', 'nama_produk', 'harga', 'input_kasir', 'timestamp_kasir', 'input_verifikator', 'timestamp_verifikator', 'keterangan', 'kategori'];
const COL_KASIR = 4;        // D
const COL_VERIFIKATOR = 6;  // F
const COL_KET = 8;          // H
const COL_KAT = 9;          // I

// ===== UTILITIES =====

function hariIni() {
  const now = new Date();
  // Simulate Asia/Jakarta (UTC+7)
  const jakarta = new Date(now.getTime() + 7 * 60 * 60 * 1000);
  return jakarta.toISOString().split('T')[0]; // yyyy-MM-dd
}

function tglIndo(s) {
  if (!s) return '';
  const p = String(s).split('-');
  return `${p[2]}/${p[1]}/${p[0]}`;
}

function waktu_(v) {
  if (v instanceof Date) return v.getTime();
  if (!v || v === '') return 0;
  const t = new Date(v).getTime();
  return isNaN(t) ? 0 : t;
}

function jam_(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  // Format dd/MM HH:mm
  const dd = String(d.getDate()).padStart(2, '0');
  const MM = String(d.getMonth() + 1).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${dd}/${MM} ${hh}:${mm}`;
}

function kunciRekon(cabang, kode) {
  return `rk|${cabang}|${kode}`;
}

// ===== DATA ACCESS =====

async function readJSON(file, fallback = {}) {
  try {
    const content = await fs.readFile(file, 'utf8');
    return JSON.parse(content);
  } catch (e) {
    return fallback;
  }
}

async function writeJSON(file, data) {
  await fs.writeFile(file, JSON.stringify(data, null, 2), 'utf8');
}

async function getSheet(cabang) {
  const file = path.join(SHEETS_DIR, `${cabang}.json`);
  let data = await readJSON(file, { rows: [] });
  // Ensure header exists
  if (!data.rows || data.rows.length === 0) {
    data.rows = [HEADER];
    await writeJSON(file, data);
  }
  return data;
}

async function saveSheet(cabang, data) {
  const file = path.join(SHEETS_DIR, `${cabang}.json`);
  await writeJSON(file, data);
}

function cekFormatSheet(sheet) {
  if (!sheet.rows || sheet.rows.length === 0) return false;
  const a1 = String(sheet.rows[0][0] || '').trim().toLowerCase();
  return a1 === HEADER[0].toLowerCase();
}

function barisAktif(sheet, kode) {
  if (!sheet.rows) return 0;
  let last = 0;
  for (let i = 1; i < sheet.rows.length; i++) {
    const rowKode = String(sheet.rows[i][0] || '').trim();
    if (rowKode === kode && i > last) {
      last = i;
    }
  }
  return last;
}

function barisAktifSemua(sheet) {
  const urutan = [];
  const aktif = {};
  if (!sheet.rows) return { urutan, aktif };
  for (let i = 1; i < sheet.rows.length; i++) {
    const kode = String(sheet.rows[i][0] || '').trim();
    if (!kode) continue;
    if (!(kode in aktif)) urutan.push(kode);
    aktif[kode] = sheet.rows[i];
  }
  return { urutan, aktif };
}

// ===== SESSION MANAGEMENT =====

const sessions = new Map(); // token -> { user, expires }

function createSession(user) {
  const token = uuidv4() + uuidv4();
  const expires = Date.now() + SESSION_SECONDS * 1000;
  sessions.set(token, { user, expires });
  return token;
}

function getSession(token) {
  const sess = sessions.get(token);
  if (!sess) return null;
  if (Date.now() > sess.expires) {
    sessions.delete(token);
    return null;
  }
  // Extend session
  sess.expires = Date.now() + SESSION_SECONDS * 1000;
  return sess.user;
}

function deleteSession(token) {
  sessions.delete(token);
}

// ===== PERAN UJI (Admin) =====

let peranUji = 'KASIR'; // persisted in memory, could be file

// ===== TOGGLE VERIFIKATOR =====

let toggleVerifAktif = true;

// ===== JADWAL =====

let jadwalData = {}; // cabang -> { d: [], oleh, t }

// ===== REKON PENDING =====

let reconPending = {}; // kunciRekon -> { KASIR: {...}, VERIFIKATOR: {...}, tidakCocok: ms }

// ===== INIT DATA =====

async function initData() {
  // Master products
  const masterFile = path.join(DATA_DIR, 'master.json');
  const masterExists = await fs.access(masterFile).then(() => true).catch(() => false);
  if (!masterExists) {
    const masterData = {
      data: [
        { produk_id: '1123LB0001', isbn: '978602000001', nama_produk: 'Buku Kanisius SD Kelas 1', harga: 85000 },
        { produk_id: '1123LB0002', isbn: '978602000002', nama_produk: 'Buku Kanisius SD Kelas 2', harga: 90000 },
        { produk_id: '1123LB0003', isbn: '978602000003', nama_produk: 'Buku Kanisius SD Kelas 3', harga: 95000 },
        { produk_id: '1123NK0001', isbn: '978602100001', nama_produk: 'Novel Non Kanisius A', harga: 120000 },
        { produk_id: '1123NK0002', isbn: '978602100002', nama_produk: 'Novel Non Kanisius B', harga: 135000 },
        { produk_id: '1123EK0001', isbn: '978602200001', nama_produk: 'Buku Eksternal Matematika', harga: 75000 },
        { produk_id: '1123EK0002', isbn: '978602200002', nama_produk: 'Buku Eksternal IPA', harga: 80000 },
        { produk_id: '1123LB0004', isbn: '978602000004', nama_produk: 'Buku Kanisius SD Kelas 4', harga: 100000 },
        { produk_id: '1123LB0005', isbn: '978602000005', nama_produk: 'Buku Kanisius SD Kelas 5', harga: 105000 },
        { produk_id: '1123LB0006', isbn: '978602000006', nama_produk: 'Buku Kanisius SD Kelas 6', harga: 110000 },
      ]
    };
    await writeJSON(masterFile, masterData);
  }

  // Init sheets for each cabang
  for (const cabang of CABANG_VALID) {
    const sheetFile = path.join(SHEETS_DIR, `${cabang}.json`);
    const exists = await fs.access(sheetFile).then(() => true).catch(() => false);
    if (!exists) {
      await writeJSON(sheetFile, { rows: [HEADER] });
    }
  }

  // Tes input sheet
  const tesFile = path.join(SHEETS_DIR, `${SHEET_UJI}.json`);
  const tesExists = await fs.access(tesFile).then(() => true).catch(() => false);
  if (!tesExists) {
    await writeJSON(tesFile, { rows: [HEADER] });
  }

  // Jadwal
  const jadwalFile = path.join(DATA_DIR, 'jadwal.json');
  const jadwalExists = await fs.access(jadwalFile).then(() => true).catch(() => false);
  if (!jadwalExists) {
    await writeJSON(jadwalFile, {});
  } else {
    jadwalData = await readJSON(jadwalFile, {});
  }

  // Toggle verif
  const toggleFile = path.join(DATA_DIR, 'toggle_verif.json');
  const toggleExists = await fs.access(toggleFile).then(() => true).catch(() => false);
  if (!toggleExists) {
    await writeJSON(toggleFile, { aktif: true });
  } else {
    const t = await readJSON(toggleFile, { aktif: true });
    toggleVerifAktif = t.aktif;
  }

  // Recon pending
  const reconFile = path.join(DATA_DIR, 'recon_pending.json');
  const reconExists = await fs.access(reconFile).then(() => true).catch(() => false);
  if (!reconExists) {
    await writeJSON(reconFile, {});
  } else {
    reconPending = await readJSON(reconFile, {});
  }

  console.log('[INIT] Mock data initialized');
}

// ===== MIDDLEWARE =====

app.use(cors());
app.use(express.text({ type: 'text/plain', limit: '1mb' }));
app.use(express.json({ limit: '1mb' }));

// Parse body as JSON (Apps Script uses text/plain with JSON body)
app.use((req, res, next) => {
  if (req.is('text/plain') && req.body) {
    try {
      req.parsedBody = JSON.parse(req.body);
    } catch (e) {
      req.parsedBody = {};
    }
  } else if (req.is('application/json')) {
    req.parsedBody = req.body;
  } else {
    req.parsedBody = {};
  }
  next();
});

// ===== API ENDPOINTS =====

// Health check
app.get('/api', (req, res) => {
  res.json({ ok: true, service: 'System Scan & Stock Mock API', version: '1.0.0' });
});

// Main doPost endpoint
app.post('/api', async (req, res) => {
  const body = req.parsedBody || {};
  const action = body.action;

  console.log(`[API] ${action}`, JSON.stringify(body).substring(0, 200));

  try {
    let result;

    switch (action) {
      case 'login':
        result = await handleLogin(body);
        break;
      case 'master':
        result = await handleMaster(body);
        break;
      case 'simpan':
        result = await handleSimpan(body);
        break;
      case 'rekap':
        result = await handleRekap(body);
        break;
      case 'notif':
        result = await handleNotif(body);
        break;
      case 'snd':
        result = await handleSnd(body);
        break;
      case 'rekonsiliasi':
        result = await handleRekonsiliasi(body);
        break;
      case 'jadwal_get':
        result = await handleJadwalGet(body);
        break;
      case 'jadwal_set':
        result = await handleJadwalSet(body);
        break;
      case 'toggle_verif_get':
        result = await handleToggleVerifGet(body);
        break;
      case 'toggle_verif_set':
        result = await handleToggleVerifSet(body);
        break;
      default:
        result = { ok: false, error: 'Aksi tidak dikenal: ' + action };
    }

    res.json(result);
  } catch (err) {
    console.error('[API ERROR]', action, err);
    if (err.code === 'AUTH') {
      res.json({ ok: false, code: 'AUTH', error: err.message });
    } else {
      res.json({ ok: false, error: err.message || String(err) });
    }
  }
});

// ===== HANDLERS =====

async function handleLogin(body) {
  const pin = String(body.pin || '').trim();
  const cabang = String(body.cabang || '').toLowerCase().trim();
  const role = String(body.role || '').toUpperCase();

  // Admin
  if (cabang === 'admin') {
    const benarAdmin = PIN_ADMIN_DEFAULT;
    if (pin !== benarAdmin) {
      await new Promise(r => setTimeout(r, 800));
      return { ok: false, error: 'PIN salah.' };
    }
    const user = { username: 'admin', role: 'ADMIN', cabang: 'admin' };
    const token = createSession(user);
    return { ok: true, token, user };
  }

  // Cabang
  if (CABANG_VALID.indexOf(cabang) < 0) return { ok: false, error: 'Cabang tidak valid.' };
  if (ROLE_VALID.indexOf(role) < 0) return { ok: false, error: 'Role tidak valid.' };

  // Verifikator - check toggle
  if (role === 'VERIFIKATOR') {
    if (!toggleVerifAktif) {
      return { ok: false, error: 'Login Verifikator sementara dinonaktifkan oleh admin (mode verifikator OFF).' };
    }
    const benarVerif = PIN_VERIFIKATOR_DEFAULT;
    if (pin !== benarVerif) {
      await new Promise(r => setTimeout(r, 800));
      return { ok: false, error: 'PIN Verifikator salah.' };
    }
    const user = { username: `verifikator_${cabang}`, role: 'VERIFIKATOR', cabang };
    const token = createSession(user);
    return { ok: true, token, user };
  } else {
    // Kasir
    const benarKasir = PIN_DEFAULT;
    if (pin !== benarKasir) {
      await new Promise(r => setTimeout(r, 800));
      return { ok: false, error: 'PIN salah.' };
    }
    const user = { username: `kasir_${cabang}`, role: 'KASIR', cabang };
    const token = createSession(user);
    return { ok: true, token, user };
  }
}

function requireSession(body) {
  const token = String(body.token || '').trim();
  if (!token) throw { code: 'AUTH', message: 'Token tidak ditemukan. Silakan login ulang.' };
  const user = getSession(token);
  if (!user) throw { code: 'AUTH', message: 'Sesi habis atau tidak valid. Silakan login ulang.' };
  return user;
}

function efektif(user, body) {
  if (user.role !== 'ADMIN') return user;
  const peran = String((body && body.peran_uji) || '').toUpperCase();
  if (ROLE_VALID.indexOf(peran) >= 0) {
    return { username: `admin_${peran.toLowerCase()}`, role: peran, cabang: SHEET_UJI, uji: true };
  }
  return { username: 'admin', role: 'ADMIN', cabang: SHEET_UJI, uji: true };
}

async function handleMaster(body) {
  const user = efektif(requireSession(body), body);
  const masterFile = path.join(DATA_DIR, 'master.json');
  const master = await readJSON(masterFile, { data: [] });
  return { ok: true, data: master.data };
}

async function handleSimpan(body) {
  const baseUser = requireSession(body);
  const user = efektif(baseUser, body);

  if (user.role !== 'KASIR' && user.role !== 'VERIFIKATOR') {
    return { ok: false, error: 'Pilih peran uji (Kasir atau Verifikator) terlebih dulu.' };
  }

  // Check jadwal (skip for admin/tes_input)
  if (!user.uji) {
    const akses = cekAksesCabang(user.cabang);
    if (!akses.terbuka) {
      return { ok: false, code: 'TUTUP', error: akses.error };
    }
  }

  const qty = parseInt(body.qty, 10);
  if (!(qty >= 1 && qty <= 100000)) return { ok: false, error: 'Jumlah tidak valid.' };

  // Get master product
  const masterFile = path.join(DATA_DIR, 'master.json');
  const master = await readJSON(masterFile, { data: [] });
  const produk = master.data.find(p => p.produk_id === body.produk_id);
  if (!produk) return { ok: false, error: 'Produk tidak ditemukan di Master.' };

  // Get sheet
  const sheet = await getSheet(user.cabang);
  if (!cekFormatSheet(sheet)) {
    sheet.rows = [HEADER];
  }

  const kolom = user.role === 'KASIR' ? COL_KASIR : COL_VERIFIKATOR;
  const now = new Date();
  const kode = produk.produk_id;
  const kategori = String(body.kategori || '').trim().toUpperCase();

  const rowIdx = barisAktif(sheet, kode);
  console.log(`[SIMPAN DEBUG] user=${user.username}, role=${user.role}, kode=${kode}, rowIdx=${rowIdx}, sheet.rows.length=${sheet.rows.length}`);
  let total;

  if (rowIdx > 0) {
    // Check if active row is REKONSILIASI
    const ket = String(sheet.rows[rowIdx][COL_KET - 1] || '');
    if (ket.indexOf('REKONSILIASI') === 0) {
      // Insert LANJUTAN row after
      const cur = [...sheet.rows[rowIdx]];
      sheet.rows.splice(rowIdx + 1, 0, [...cur, 'LANJUTAN']);
      // Update new row
      const newRowIdx = rowIdx + 1;
      sheet.rows[newRowIdx][kolom - 1] = Number(sheet.rows[newRowIdx][kolom - 1] || 0) + qty;
      sheet.rows[newRowIdx][kolom] = now.toISOString();
      if (kategori) sheet.rows[newRowIdx][COL_KAT - 1] = kategori;
      total = sheet.rows[newRowIdx][kolom - 1];
    } else {
      // Update existing row
      sheet.rows[rowIdx][kolom - 1] = Number(sheet.rows[rowIdx][kolom - 1] || 0) + qty;
      sheet.rows[rowIdx][kolom] = now.toISOString();
      if (kategori) sheet.rows[rowIdx][COL_KAT - 1] = kategori;
      total = sheet.rows[rowIdx][kolom - 1];
    }
  } else {
    // New row
    const baru = sheet.rows.length;
    const data = new Array(HEADER.length).fill('');
    data[0] = kode;
    data[1] = produk.nama_produk;
    data[2] = produk.harga;
    data[kolom - 1] = qty;
    data[kolom] = now.toISOString();
    data[COL_KAT - 1] = kategori;
    sheet.rows.push(data);
    total = qty;
  }

  // Clear recon pending for this product
  delete reconPending[kunciRekon(user.cabang, kode)];
  await writeJSON(path.join(DATA_DIR, 'recon_pending.json'), reconPending);

  await saveSheet(user.cabang, sheet);
  return { ok: true, total, sheet: user.cabang, message: `Tersimpan di sheet ${user.cabang} (${user.role})` };
}

function cekAksesCabang(cabang) {
  const h = hariIni();
  if (cabang === SHEET_UJI) return { terbuka: true, uji: true, hari_ini: h, jadwal: [] };
  const j = jadwalData[cabang] || { d: [], oleh: '', t: 0 };
  return { terbuka: j.d.indexOf(h) >= 0, uji: false, hari_ini: h, jadwal: j.d };
}

async function handleRekap(body) {
  const baseUser = requireSession(body);
  const user = efektif(baseUser, body);

  const target = user.uji ? SHEET_UJI : user.cabang;
  if (target !== SHEET_UJI && CABANG_VALID.indexOf(target) < 0) {
    return { ok: false, error: 'Cabang tidak valid.' };
  }

  const sheet = await getSheet(target);
  if (!sheet.rows || !cekFormatSheet(sheet)) return { ok: true, data: [], cabang: target };

  const p = barisAktifSemua(sheet);
  const out = p.urutan.map(kode => {
    const r = p.aktif[kode];
    return {
      produk_id: kode,
      nama_produk: r[1],
      harga: r[2],
      qty_kasir: Number(r[3]) || 0,
      qty_verifikator: Number(r[5]) || 0,
      kategori: String(r[8] || '').trim()
    };
  });
  return { ok: true, data: out, cabang: target };
}

async function handleSnd(body) {
  const baseUser = requireSession(body);
  const user = efektif(baseUser, body);

  if (user.role !== 'KASIR') return { ok: false, error: 'Fitur Input SnD hanya untuk Kasir.' };

  const kode2 = String(body.kode2 || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{2}$/.test(kode2)) return { ok: false, error: 'Isi tepat 2 karakter (huruf atau angka).' };
  const verifOff = body.verifOff === true;

  const kosong = { ok: true, kode2, items: [], belum: 0, total_pcs: 0 };
  const sheet = await getSheet(user.cabang);
  if (!sheet.rows || !cekFormatSheet(sheet)) return kosong;

  const p = barisAktifSemua(sheet);
  const items = [];
  let belum = 0, total = 0;

  p.urutan.forEach(kode => {
    if (kode.length < 6 || kode.substr(4, 2).toUpperCase() !== kode2) return;
    const r = p.aktif[kode];
    const k = Number(r[3]) || 0;
    const v = Number(r[5]) || 0;
    const tk = waktu_(r[4]);
    const tv = waktu_(r[6]);

    if (verifOff ? (tk && k > 0) : (tk && tv && k === v)) {
      const ket = String(r[7] || '');
      items.push({
        produk_id: kode,
        nama_produk: r[1],
        harga: r[2],
        jumlah: k,
        status: ket.indexOf('REKONSILIASI') === 0 ? 'REKONSILIASI' : 'COCOK',
        kategori: String(r[8] || '').trim()
      });
      total += k;
    } else {
      belum++;
    }
  });

  items.sort((a, b) => a.produk_id.localeCompare(b.produk_id));
  return { ok: true, kode2, items, belum, total_pcs: total };
}

async function handleNotif(body) {
  const baseUser = requireSession(body);
  const user = efektif(baseUser, body);

  const cabang = user.cabang;
  const sheet = await getSheet(cabang);
  if (!sheet.rows || sheet.rows.length < 2 || !cekFormatSheet(sheet)) {
    return { ok: true, count: 0, items: [], menunggu: 0, akses: cekAksesCabang(cabang) };
  }

  const p = barisAktifSemua(sheet);
  const items = [];
  let menunggu = 0;

  p.urutan.forEach(kode => {
    const r = p.aktif[kode];
    const tk = waktu_(r[4]);
    const tv = waktu_(r[6]);
    const k = Number(r[3]) || 0;
    const v = Number(r[5]) || 0;

    if (tk && tv) {
      if (k !== v) {
        const rec = reconPending[kunciRekon(cabang, kode)] || {};
        items.push({
          produk_id: kode,
          nama_produk: r[1],
          harga: r[2],
          qty_kasir: k,
          qty_verifikator: v,
          sejak: Math.max(tk, tv),
          ajukan: { KASIR: !!rec.KASIR, VERIFIKATOR: !!rec.VERIFIKATOR },
          tidak_cocok: rec.tidakCocok || 0
        });
      }
    } else if (tk || tv) {
      menunggu++;
    }
  });

  items.sort((a, b) => a.sejak - b.sejak);
  return { ok: true, count: items.length, items, menunggu, akses: cekAksesCabang(cabang) };
}

async function handleRekonsiliasi(body) {
  const baseUser = requireSession(body);
  const user = efektif(baseUser, body);

  if (user.role !== 'KASIR' && user.role !== 'VERIFIKATOR') {
    return { ok: false, error: 'Pilih peran uji (Kasir atau Verifikator) terlebih dulu.' };
  }

  if (!user.uji) {
    const akses = cekAksesCabang(user.cabang);
    if (!akses.terbuka) return akses;
  }

  const nilai = parseInt(body.nilai, 10);
  if (!(nilai >= 0 && nilai <= 100000)) return { ok: false, error: 'Nilai tidak valid.' };

  const sheet = await getSheet(user.cabang);
  if (!sheet.rows || !cekFormatSheet(sheet)) return { ok: false, error: 'Sheet cabang belum berisi data.' };

  const kode = String(body.produk_id).trim();
  const rowIdx = barisAktif(sheet, kode);
  if (!rowIdx) return { ok: false, code: 'STALE', error: 'Produk tidak ditemukan di sheet cabang.' };

  const cur = sheet.rows[rowIdx];
  const k = Number(cur[3]) || 0;
  const v = Number(cur[5]) || 0;

  if (!waktu_(cur[4]) || !waktu_(cur[6]) || k === v) {
    delete reconPending[kunciRekon(user.cabang, kode)];
    await writeJSON(path.join(DATA_DIR, 'recon_pending.json'), reconPending);
    return { ok: false, code: 'STALE', error: 'Produk ini sudah tidak selisih. Daftar notifikasi akan diperbarui.' };
  }

  // Validate current values match what user sees
  if (k !== Number(body.lihat_kasir) || v !== Number(body.lihat_verifikator)) {
    return { ok: false, code: 'STALE', error: `Nilai produk ini baru saja berubah (kasir ${k}, verifikator ${v}). Buka ulang dari daftar notifikasi.` };
  }

  const key = kunciRekon(user.cabang, kode);
  const rec = reconPending[key] || {};
  const now = new Date();
  const lain = user.role === 'KASIR' ? 'VERIFIKATOR' : 'KASIR';

  delete rec.tidakCocok;
  rec[user.role] = { nilai, oleh: user.username, t: now.getTime() };

  // Other party hasn't submitted yet
  if (!rec[lain]) {
    reconPending[key] = rec;
    await writeJSON(path.join(DATA_DIR, 'recon_pending.json'), reconPending);
    return { ok: true, status: 'menunggu', menunggu: lain, nilai };
  }

  // Both submitted but values differ
  if (Number(rec[lain].nilai) !== nilai) {
    reconPending[key] = { tidakCocok: now.getTime() };
    await writeJSON(path.join(DATA_DIR, 'recon_pending.json'), reconPending);
    return { ok: true, status: 'beda', menunggu: lain };
  }

  // Values match - write reconciliation
  const ket = `REKONSILIASI | disepakati kasir (${rec.KASIR.oleh}, ${jam_(rec.KASIR.t)}) & verifikator (${rec.VERIFIKATOR.oleh}, ${jam_(rec.VERIFIKATOR.t)}) | awal: kasir ${k}, verifikator ${v} | nilai valid ${nilai}`;

  // Insert new row after current
  const newRow = [...cur];
  newRow[3] = nilai; // input_kasir
  newRow[4] = now.toISOString(); // timestamp_kasir
  newRow[5] = nilai; // input_verifikator
  newRow[6] = now.toISOString(); // timestamp_verifikator
  newRow[7] = ket; // keterangan
  // kategori stays same (index 8)

  sheet.rows.splice(rowIdx + 1, 0, newRow);
  // Mark original row
  sheet.rows[rowIdx][COL_KET - 1] = (String(sheet.rows[rowIdx][COL_KET - 1] || '').trim() ? String(sheet.rows[rowIdx][COL_KET - 1]) + ' | ' : '') + 'SELISIH (diganti baris rekonsiliasi di bawahnya)';

  delete reconPending[key];
  await writeJSON(path.join(DATA_DIR, 'recon_pending.json'), reconPending);
  await saveSheet(user.cabang, sheet);

  return { ok: true, status: 'selesai', nilai };
}

async function handleJadwalGet(body) {
  const user = requireSession(body);
  if (user.role !== 'ADMIN') return { ok: false, error: 'Hanya admin yang dapat mengatur jadwal.' };

  const out = {};
  CABANG_VALID.forEach(c => {
    const j = jadwalData[c] || { d: [], oleh: '', t: 0 };
    out[c] = { tanggal: j.d, oleh: j.oleh, t: j.t };
  });
  return { ok: true, jadwal: out, hari_ini: hariIni(), cabang: CABANG_VALID };
}

async function handleJadwalSet(body) {
  const user = requireSession(body);
  if (user.role !== 'ADMIN') return { ok: false, error: 'Hanya admin yang dapat mengatur jadwal.' };

  const masuk = body.jadwal;
  if (!masuk || typeof masuk !== 'object') return { ok: false, error: 'Data jadwal tidak valid.' };

  const baru = {};
  const cabangList = Object.keys(masuk);
  for (const c of cabangList) {
    const arr = masuk[c];
    if (CABANG_VALID.indexOf(c) < 0) return { ok: false, error: 'Cabang tidak valid: ' + c };
    if (!Array.isArray(arr)) return { ok: false, error: 'Daftar tanggal ' + c + ' tidak valid.' };
    if (arr.length > 400) return { ok: false, error: 'Maksimal 400 tanggal per cabang.' };
    const uniq = {};
    for (const d of arr) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return { ok: false, error: 'Tanggal tidak valid pada ' + c + ': ' + d };
      uniq[d] = true;
    }
    baru[c] = Object.keys(uniq).sort();
  }

  // Only update changed
  Object.keys(baru).forEach(c => {
    const lama = (jadwalData[c] || { d: [] }).d;
    if (JSON.stringify(lama) !== JSON.stringify(baru[c])) {
      jadwalData[c] = { d: baru[c], oleh: user.username, t: Date.now() };
    }
  });

  await writeJSON(path.join(DATA_DIR, 'jadwal.json'), jadwalData);
  return handleJadwalGet(body);
}

async function handleToggleVerifGet(body) {
  const user = requireSession(body);
  return { ok: true, aktif: toggleVerifAktif };
}

async function handleToggleVerifSet(body) {
  const user = requireSession(body);
  if (user.role !== 'ADMIN') return { ok: false, error: 'Hanya admin yang boleh mengubah mode ini.' };

  const aktif = body.aktif === true;
  toggleVerifAktif = aktif;
  await writeJSON(path.join(DATA_DIR, 'toggle_verif.json'), { aktif });
  return { ok: true, aktif };
}

// ===== EXPORT EXCEL =====

app.get('/api/export', async (req, res) => {
  try {
    const { cabang, token } = req.query;
    if (!token) return res.status(401).json({ ok: false, error: 'Token required' });

    const user = getSession(token);
    if (!user) return res.status(401).json({ ok: false, error: 'Invalid session' });

    const target = user.uji ? SHEET_UJI : (cabang || user.cabang);
    const sheet = await getSheet(target);
    if (!sheet.rows || !cekFormatSheet(sheet)) {
      return res.json({ ok: true, data: [], cabang: target });
    }

    const p = barisAktifSemua(sheet);
    const data = p.urutan.map(kode => {
      const r = p.aktif[kode];
      return {
        produk_id: kode,
        nama_produk: r[1],
        harga: r[2],
        qty_kasir: Number(r[3]) || 0,
        qty_verifikator: Number(r[5]) || 0,
        kategori: String(r[8] || '').trim()
      };
    });

    const workbook = new ExcelJS.Workbook();
    const ws = workbook.addWorksheet('Rekap');

    ws.columns = [
      { header: 'Kode Produk', key: 'produk_id', width: 20 },
      { header: 'Nama Produk', key: 'nama_produk', width: 40 },
      { header: 'Harga', key: 'harga', width: 15 },
      { header: 'Qty Kasir', key: 'qty_kasir', width: 12 },
      { header: 'Qty Verifikator', key: 'qty_verifikator', width: 15 },
      { header: 'Kategori', key: 'kategori', width: 15 },
    ];

    data.forEach(d => ws.addRow(d));

    // Style header
    ws.getRow(1).font = { bold: true };
    ws.getRow(1).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF00ACAC' }
    };
    ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="rekap-${target}-${new Date().toISOString().split('T')[0]}.xlsx"`);

    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error('[EXPORT ERROR]', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ===== START =====

async function start() {
  await initData();

  app.listen(PORT, () => {
    console.log(`
╔══════════════════════════════════════════════════════════╗
║  Mock Server Running                                     ║
║  ────────────────────                                     ║
║  API Endpoint:  http://localhost:${PORT}/api               ║
║  Export Excel:  http://localhost:${PORT}/api/export        ║
║  Data Dir:      ${DATA_DIR}                                ║
║                                                            ║
║  Test Accounts:                                           ║
║    Admin         → cabang: admin, PIN: admin123           ║
║    Kasir         → cabang: kranggan (dst), PIN: 123456    ║
║    Verifikator   → cabang: kranggan (dst), PIN: verif123  ║
╚══════════════════════════════════════════════════════════╝
    `);
  });
}

start().catch(console.error);