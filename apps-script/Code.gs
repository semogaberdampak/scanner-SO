/**
 * System Scan & Stock - Backend API (Google Apps Script)
 *
 * Dipasang sebagai Web App:
 *   Execute as : Me
 *   Who has access : Anyone
 *
 * Script ini HARUS dibuat dari dalam Google Spreadsheet (Extensions > Apps Script)
 * karena memakai SpreadsheetApp.getActiveSpreadsheet().
 *
 * Frontend (Cloudflare Pages) memanggil dengan POST, Content-Type: text/plain
 * (supaya tidak memicu preflight CORS, yang tidak didukung Apps Script).
 */

// ===== PENGATURAN =====
var PIN_DEFAULT = '123456';          // Disarankan: isi Script Properties APP_PIN agar PIN tidak ada di kode
var SESSION_SECONDS = 6 * 60 * 60;   // 6 jam (batas maksimum CacheService)
var CABANG_VALID = ['kranggan', 'katedral', 'santamaria', 'athanasius', 'antonius', 'paulus'];
var ROLE_VALID = ['KASIR', 'VERIFIKATOR'];

// Format sheet tiap cabang: SATU BARIS PER PRODUK (kolom A-G)
var HEADER = ['kode_produk', 'nama_produk', 'harga', 'input_kasir', 'timestamp_kasir', 'input_verifikator', 'timestamp_verifikator'];
var COL_KASIR = 4;        // D (timestamp di E)
var COL_VERIFIKATOR = 6;  // F (timestamp di G)
var FORMAT_WAKTU = 'dd/MM/yyyy HH:mm:ss';

// true = judul sudah ada; false = sheet kosong (judul akan dibuat); lempar error jika isinya format lain
function cekFormatSheet_(sheet) {
  if (sheet.getLastRow() === 0) return false;
  var a1 = String(sheet.getRange(1, 1).getValue()).trim().toLowerCase();
  if (a1 === HEADER[0]) return true;
  throw new Error('Format sheet "' + sheet.getName() + '" tidak sesuai. Baris 1 harus berisi judul: ' +
                  HEADER.join(', ') + '. Kosongkan data uji lama di sheet itu lalu coba lagi.');
}

// ===== ENTRY POINT =====
function doGet() {
  return json_({ ok: true, service: 'System Scan & Stock API' });
}

function doPost(e) {
  try {
    var body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    switch (body.action) {
      case 'login':  return json_(login_(body));
      case 'master': return json_(master_(requireSession_(body)));
      case 'simpan': return json_(simpan_(requireSession_(body), body));
      case 'rekap':  return json_(rekap_(requireSession_(body), body));
      default:       return json_({ ok: false, error: 'Aksi tidak dikenal.' });
    }
  } catch (err) {
    if (err && err.code === 'AUTH') return json_({ ok: false, code: 'AUTH', error: err.message });
    return json_({ ok: false, error: String(err && err.message ? err.message : err) });
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// ===== LOGIN & SESI =====
function login_(b) {
  var pin = String(b.pin || '').trim();
  var benar = String(PropertiesService.getScriptProperties().getProperty('APP_PIN') || PIN_DEFAULT);
  if (pin !== benar) {
    Utilities.sleep(800); // memperlambat tebak PIN
    return { ok: false, error: 'PIN salah.' };
  }

  var cabang = String(b.cabang || '').toLowerCase().trim();
  var role = String(b.role || '').toUpperCase().trim();
  var user;

  if (cabang === 'admin') {
    user = { username: 'admin', role: 'ADMIN', cabang: 'admin' };
  } else {
    if (CABANG_VALID.indexOf(cabang) < 0) return { ok: false, error: 'Cabang tidak valid.' };
    if (ROLE_VALID.indexOf(role) < 0) return { ok: false, error: 'Role tidak valid.' };
    user = { username: cabang + '_' + role.toLowerCase(), role: role, cabang: cabang };
  }

  var token = Utilities.getUuid() + Utilities.getUuid();
  CacheService.getScriptCache().put('ses_' + token, JSON.stringify(user), SESSION_SECONDS);
  return { ok: true, token: token, user: user };
}

function requireSession_(b) {
  var raw = b.token ? CacheService.getScriptCache().get('ses_' + b.token) : null;
  if (!raw) {
    var e = new Error('Sesi berakhir. Silakan login kembali.');
    e.code = 'AUTH';
    throw e;
  }
  return JSON.parse(raw);
}

// ===== DATA =====
function master_(user) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Master');
  if (!sheet) return { ok: true, data: [] };

  var rows = sheet.getDataRange().getValues();
  var out = [];
  for (var i = 1; i < rows.length; i++) {
    var r = rows[i];
    if (r[0]) {
      out.push({
        produk_id: String(r[0]).trim(),
        isbn: String(r[1] || '').trim(),
        nama_produk: r[2],
        harga: r[3]
      });
    }
  }
  return { ok: true, data: out };
}

function simpan_(user, b) {
  if (user.role !== 'KASIR' && user.role !== 'VERIFIKATOR')
    return { ok: false, error: 'Akun Super User tidak bisa mencatat input. Login sebagai Kasir atau Verifikator.' };

  var qty = parseInt(b.qty, 10);
  if (!(qty >= 1 && qty <= 100000)) return { ok: false, error: 'Jumlah tidak valid.' };

  // Kunci: kasir & verifikator yang menyimpan bersamaan diproses bergantian, tidak saling menimpa
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();

    // Nama & harga diambil dari sheet Master (bukan dari klien)
    var master = ss.getSheetByName('Master');
    if (!master) return { ok: false, error: 'Sheet Master tidak ditemukan.' };
    var mf = master.getRange('A:A').createTextFinder(String(b.produk_id)).matchEntireCell(true).findNext();
    if (!mf) return { ok: false, error: 'Produk tidak ditemukan di Master.' };
    var m = master.getRange(mf.getRow(), 1, 1, 4).getValues()[0];

    var sheet = ss.getSheetByName(user.cabang);
    if (!sheet) sheet = ss.insertSheet(user.cabang);
    if (!cekFormatSheet_(sheet)) sheet.appendRow(HEADER);

    var kolom = user.role === 'KASIR' ? COL_KASIR : COL_VERIFIKATOR;
    var now = new Date();
    var kode = String(m[0]).trim();
    var total;

    var f = sheet.getRange('A:A').createTextFinder(kode).matchEntireCell(true).findNext();
    if (f && f.getRow() > 1) {
      // Produk sudah ada di sheet: tambahkan ke jumlah peran ini, perbarui waktunya
      var row = f.getRow();
      total = (Number(sheet.getRange(row, kolom).getValue()) || 0) + qty;
      sheet.getRange(row, kolom, 1, 2).setValues([[total, now]]);
      sheet.getRange(row, kolom + 1).setNumberFormat(FORMAT_WAKTU);
    } else {
      // Produk baru di sheet cabang ini: buat satu baris baru
      var baru = sheet.getLastRow() + 1;
      sheet.getRange(baru, 1).setNumberFormat('@');
      var data = [kode, m[2], m[3], '', '', '', ''];
      data[kolom - 1] = qty;
      data[kolom] = now;
      sheet.getRange(baru, 1, 1, HEADER.length).setValues([data]);
      sheet.getRange(baru, kolom + 1).setNumberFormat(FORMAT_WAKTU);
      total = qty;
    }

    return {
      ok: true,
      total: total,
      message: 'Tersimpan di sheet ' + user.cabang + ' (' + user.role + ')'
    };
  } finally {
    lock.releaseLock();
  }
}

function rekap_(user, b) {
  // Admin boleh memilih cabang; selain admin hanya cabangnya sendiri
  var target = user.role === 'ADMIN' ? String(b.cabang || '').toLowerCase().trim() : user.cabang;
  if (CABANG_VALID.indexOf(target) < 0) return { ok: false, error: 'Cabang tidak valid.' };

  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(target);
  if (!sheet || !cekFormatSheet_(sheet)) return { ok: true, data: [], cabang: target };

  var rows = sheet.getDataRange().getValues();
  var out = [];
  for (var i = 1; i < rows.length; i++) {
    var r = rows[i];
    if (!r[0]) continue;
    out.push({
      produk_id: String(r[0]).trim(),
      nama_produk: r[1],
      harga: r[2],
      qty_kasir: Number(r[3]) || 0,
      qty_verifikator: Number(r[5]) || 0
    });
  }
  return { ok: true, data: out, cabang: target };
}
