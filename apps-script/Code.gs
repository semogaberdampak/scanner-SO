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
  var qty = parseInt(b.qty, 10);
  if (!(qty >= 1 && qty <= 100000)) return { ok: false, error: 'Jumlah tidak valid.' };

  var ss = SpreadsheetApp.getActiveSpreadsheet();

  // Nama & harga diambil dari sheet Master (bukan dari klien) agar tidak bisa dimanipulasi
  var master = ss.getSheetByName('Master');
  if (!master) return { ok: false, error: 'Sheet Master tidak ditemukan.' };
  var found = master.getRange('A:A').createTextFinder(String(b.produk_id)).matchEntireCell(true).findNext();
  if (!found) return { ok: false, error: 'Produk tidak ditemukan di Master.' };
  var row = master.getRange(found.getRow(), 1, 1, 4).getValues()[0];

  var sheetName = user.cabang;
  var sheet = ss.getSheetByName(sheetName);
  if (!sheet) {
    sheet = ss.insertSheet(sheetName);
    sheet.appendRow(['Timestamp', 'Produk ID', 'Nama Produk', 'Harga', 'Role', 'Qty', 'User']);
  }

  sheet.appendRow([new Date(), String(row[0]).trim(), row[2], row[3], user.role, qty, user.username]);
  return { ok: true, message: 'Data berhasil disimpan ke sheet ' + sheetName };
}

function rekap_(user, b) {
  // Admin boleh memilih cabang; selain admin hanya cabangnya sendiri
  var target = user.role === 'ADMIN' ? String(b.cabang || '').toLowerCase().trim() : user.cabang;
  if (CABANG_VALID.indexOf(target) < 0 && target !== 'admin') return { ok: false, error: 'Cabang tidak valid.' };

  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(target);
  if (!sheet) return { ok: true, data: [], cabang: target };

  var rows = sheet.getDataRange().getValues();
  var out = [];
  for (var i = 1; i < rows.length; i++) {
    var r = rows[i];
    out.push({
      produk_id: String(r[1]).trim(),
      nama_produk: r[2],
      harga: r[3],
      role: String(r[4]).toUpperCase().trim(),
      qty: Number(r[5]) || 0
    });
  }
  return { ok: true, data: out, cabang: target };
}
