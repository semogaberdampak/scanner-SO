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
var PIN_DEFAULT = '123456';          // PIN Kasir & Verifikator semua cabang
var PIN_ADMIN_DEFAULT = '123admin456'; // PIN Super User (admin) saja          // Disarankan: isi Script Properties APP_PIN agar PIN tidak ada di kode
var SESSION_SECONDS = 6 * 60 * 60;   // 6 jam (batas maksimum CacheService)
var CABANG_VALID = ['kranggan', 'katedral', 'santamaria', 'athanasius', 'antonius', 'paulus'];
var ROLE_VALID = ['KASIR', 'VERIFIKATOR'];

// Format sheet tiap cabang: SATU BARIS PER PRODUK (kolom A-G) + kolom H "keterangan" (jejak audit)
var HEADER = ['kode_produk', 'nama_produk', 'harga', 'input_kasir', 'timestamp_kasir', 'input_verifikator', 'timestamp_verifikator'];
var HEADER_KET = 'keterangan';
var COL_KASIR = 4;        // D (timestamp di E)
var COL_VERIFIKATOR = 6;  // F (timestamp di G)
var COL_KET = 8;          // H
var FORMAT_WAKTU = 'dd/MM/yyyy HH:mm:ss';
var WARNA_AWAL = '#FCE4D6';   // baris input awal yang selisih (oranye muda)
var WARNA_REKON = '#E2EFDA';  // baris rekonsiliasi (hijau muda)
var NOTIF_CACHE_DETIK = 60;

// true = judul sudah ada; false = sheet kosong (judul akan dibuat); lempar error jika isinya format lain
function cekFormatSheet_(sheet) {
  if (sheet.getLastRow() === 0) return false;
  var a1 = String(sheet.getRange(1, 1).getValue()).trim().toLowerCase();
  if (a1 === HEADER[0]) return true;
  throw new Error('Format sheet "' + sheet.getName() + '" tidak sesuai. Baris 1 harus berisi judul: ' +
                  HEADER.join(', ') + '. Kosongkan data uji lama di sheet itu lalu coba lagi.');
}

// Ambil sheet cabang; buat judul jika kosong; pastikan kolom H "keterangan" ada
function siapkanSheet_(ss, nama) {
  var sheet = ss.getSheetByName(nama);
  if (!sheet) sheet = ss.insertSheet(nama);
  if (!cekFormatSheet_(sheet)) {
    sheet.appendRow(HEADER.concat([HEADER_KET]));
  } else if (!String(sheet.getRange(1, COL_KET).getValue()).trim()) {
    sheet.getRange(1, COL_KET).setValue(HEADER_KET);
  }
  return sheet;
}

// Baris "aktif" sebuah produk = baris TERAKHIR yang memuat kode itu (baris di atasnya = riwayat)
function barisAktif_(sheet, kode) {
  var hits = sheet.getRange('A:A').createTextFinder(kode).matchEntireCell(true).findAll();
  var last = 0;
  for (var i = 0; i < hits.length; i++) {
    var r = hits[i].getRow();
    if (r > 1 && r > last) last = r;
  }
  return last;
}

function waktu_(v) {
  if (v instanceof Date) return v.getTime();
  if (v === '' || v === null || v === undefined) return 0;
  var t = new Date(v).getTime();
  return isNaN(t) ? 0 : t;
}

// ===== Pengajuan rekonsiliasi sementara (BELUM ditulis ke sheet) =====
// Disimpan di Script Properties: kunci "rk|cabang|kode" -> { KASIR:{nilai,oleh,t}, VERIFIKATOR:{...}, tidakCocok:ms }
function kunciRekon_(cabang, kode) { return 'rk|' + cabang + '|' + kode; }
function hapusRekon_(cabang, kode) { PropertiesService.getScriptProperties().deleteProperty(kunciRekon_(cabang, kode)); }
function jam_(ms) { return Utilities.formatDate(new Date(ms), Session.getScriptTimeZone(), 'dd/MM HH:mm'); }

function hapusCache_(cabang) { CacheService.getScriptCache().remove('notif_' + cabang); }

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
      case 'notif':  return json_(notif_(requireSession_(body)));
      case 'rekonsiliasi': return json_(rekonsiliasi_(requireSession_(body), body));
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
  var cabang = String(b.cabang || '').toLowerCase().trim();

  // Admin dan cabang memakai PIN yang BERBEDA. Script Properties (APP_PIN_ADMIN / APP_PIN) boleh menggantikan bawaan.
  var props = PropertiesService.getScriptProperties();
  var benar = cabang === 'admin'
    ? String(props.getProperty('APP_PIN_ADMIN') || PIN_ADMIN_DEFAULT)
    : String(props.getProperty('APP_PIN') || PIN_DEFAULT);
  if (pin !== benar) {
    Utilities.sleep(800); // memperlambat tebak PIN
    return { ok: false, error: 'PIN salah.' };
  }

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

    var sheet = siapkanSheet_(ss, user.cabang);
    var kolom = user.role === 'KASIR' ? COL_KASIR : COL_VERIFIKATOR;
    var now = new Date();
    var kode = String(m[0]).trim();
    var total;

    var row = barisAktif_(sheet, kode);
    if (row) {
      // Jika baris aktif adalah hasil rekonsiliasi, JANGAN diubah (jejak audit). Buat baris "LANJUTAN" di bawahnya.
      if (String(sheet.getRange(row, COL_KET).getValue()).indexOf('REKONSILIASI') === 0) {
        var cur = sheet.getRange(row, 1, 1, 7).getValues()[0];
        sheet.insertRowAfter(row);
        row = row + 1;
        var rg = sheet.getRange(row, 1, 1, COL_KET);
        rg.setBackground(null);
        rg.setValues([cur.concat(['LANJUTAN'])]);
        sheet.getRange(row, 1).setNumberFormat('@');
      }
      total = (Number(sheet.getRange(row, kolom).getValue()) || 0) + qty;
      sheet.getRange(row, kolom, 1, 2).setValues([[total, now]]);
      sheet.getRange(row, kolom + 1).setNumberFormat(FORMAT_WAKTU);
    } else {
      var baru = sheet.getLastRow() + 1;
      sheet.getRange(baru, 1).setNumberFormat('@');
      var data = [kode, m[2], m[3], '', '', '', ''];
      data[kolom - 1] = qty;
      data[kolom] = now;
      sheet.getRange(baru, 1, 1, HEADER.length).setValues([data]);
      sheet.getRange(baru, kolom + 1).setNumberFormat(FORMAT_WAKTU);
      total = qty;
    }

    hapusRekon_(user.cabang, kode);   // nilai berubah: pengajuan rekonsiliasi lama tidak berlaku lagi
    hapusCache_(user.cabang);
    return { ok: true, total: total, message: 'Tersimpan di sheet ' + user.cabang + ' (' + user.role + ')' };
  } finally {
    lock.releaseLock();
  }
}

// Ambil satu baris aktif per produk dari seluruh isi sheet (baris terakhir menang)
function barisAktifSemua_(rows) {
  var urutan = [], aktif = {};
  for (var i = 1; i < rows.length; i++) {
    var kode = String(rows[i][0]).trim();
    if (!kode) continue;
    if (!(kode in aktif)) urutan.push(kode);
    aktif[kode] = rows[i];
  }
  return { urutan: urutan, aktif: aktif };
}

function rekap_(user, b) {
  // Admin boleh memilih cabang; selain admin hanya cabangnya sendiri
  var target = user.role === 'ADMIN' ? String(b.cabang || '').toLowerCase().trim() : user.cabang;
  if (CABANG_VALID.indexOf(target) < 0) return { ok: false, error: 'Cabang tidak valid.' };

  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(target);
  if (!sheet || !cekFormatSheet_(sheet)) return { ok: true, data: [], cabang: target };

  // Satu baris per produk: baris terakhir (nilai setelah rekonsiliasi). Baris riwayat tidak ikut dihitung.
  var p = barisAktifSemua_(sheet.getDataRange().getValues());
  var out = p.urutan.map(function (kode) {
    var r = p.aktif[kode];
    return { produk_id: kode, nama_produk: r[1], harga: r[2], qty_kasir: Number(r[3]) || 0, qty_verifikator: Number(r[5]) || 0 };
  });
  return { ok: true, data: out, cabang: target };
}

// ===== NOTIFIKASI SELISIH =====
// Selisih = kedua peran sudah menginput produk itu DAN nilainya berbeda.
// "sejak" = waktu input TERAKHIR dari kedua peran (saat pasangan terakhir menginput).
function hitungSelisih_(cabang) {
  var kosong = { ok: true, count: 0, items: [], menunggu: 0 };
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(cabang);
  if (!sheet || sheet.getLastRow() < 2) return kosong;
  if (String(sheet.getRange(1, 1).getValue()).trim().toLowerCase() !== HEADER[0]) return kosong;

  var p = barisAktifSemua_(sheet.getDataRange().getValues());
  var semua = PropertiesService.getScriptProperties().getProperties();
  var items = [], menunggu = 0;
  p.urutan.forEach(function (kode) {
    var r = p.aktif[kode];
    var tk = waktu_(r[4]), tv = waktu_(r[6]);
    var k = Number(r[3]) || 0, v = Number(r[5]) || 0;
    if (tk && tv) {
      if (k !== v) {
        var rec = semua[kunciRekon_(cabang, kode)];
        var pj = rec ? JSON.parse(rec) : {};
        items.push({
          produk_id: kode, nama_produk: r[1], harga: r[2], qty_kasir: k, qty_verifikator: v, sejak: Math.max(tk, tv),
          ajukan: { KASIR: !!pj.KASIR, VERIFIKATOR: !!pj.VERIFIKATOR },   // hanya ADA/TIDAK, bukan nilainya
          tidak_cocok: pj.tidakCocok || 0
        });
      }
    } else if (tk || tv) {
      menunggu++;   // baru diinput satu pihak: belum dihitung sebagai selisih
    }
  });
  items.sort(function (a, b) { return a.sejak - b.sejak; });   // selisih tertua lebih dulu
  return { ok: true, count: items.length, items: items, menunggu: menunggu };
}

function notif_(user) {
  if (user.role !== 'KASIR' && user.role !== 'VERIFIKATOR') return { ok: true, count: 0, items: [], menunggu: 0 };
  var cache = CacheService.getScriptCache();
  var key = 'notif_' + user.cabang;
  var hit = cache.get(key);
  if (hit) return JSON.parse(hit);
  var hasil = hitungSelisih_(user.cabang);
  try { cache.put(key, JSON.stringify(hasil), NOTIF_CACHE_DETIK); } catch (e) { /* terlalu besar: lewati cache */ }
  return hasil;
}

// ===== PENCOCOKAN (REKONSILIASI) =====
// Kasir DAN Verifikator masing-masing mengajukan nilai yang disepakati. Selama baru satu pihak, sheet TIDAK berubah.
// Jika kedua nilai sama -> baris awal diberi warna (nilai tidak diubah) + satu baris REKONSILIASI disisipkan di bawahnya.
// Jika berbeda -> kedua pengajuan dibatalkan, sheet tidak berubah.
function rekonsiliasi_(user, b) {
  if (user.role !== 'KASIR' && user.role !== 'VERIFIKATOR')
    return { ok: false, error: 'Hanya Kasir atau Verifikator yang bisa melakukan pencocokan.' };

  var nilai = parseInt(b.nilai, 10);
  if (!(nilai >= 0 && nilai <= 100000)) return { ok: false, error: 'Nilai tidak valid.' };

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName(user.cabang);
    if (!sheet || !cekFormatSheet_(sheet)) return { ok: false, error: 'Sheet cabang belum berisi data.' };
    sheet = siapkanSheet_(ss, user.cabang);

    var kode = String(b.produk_id).trim();
    var row = barisAktif_(sheet, kode);
    if (!row) return { ok: false, code: 'STALE', error: 'Produk tidak ditemukan di sheet cabang.' };

    var cur = sheet.getRange(row, 1, 1, 7).getValues()[0];
    var k = Number(cur[3]) || 0, v = Number(cur[5]) || 0;
    if (!waktu_(cur[4]) || !waktu_(cur[6]) || k === v) {
      hapusRekon_(user.cabang, kode);
      hapusCache_(user.cabang);
      return { ok: false, code: 'STALE', error: 'Produk ini sudah tidak selisih. Daftar notifikasi akan diperbarui.' };
    }
    // Pengaman: nilai yang dilihat petugas harus sama dengan nilai di sheet saat ini
    if (k !== Number(b.lihat_kasir) || v !== Number(b.lihat_verifikator)) {
      hapusCache_(user.cabang);
      return { ok: false, code: 'STALE', error: 'Nilai produk ini baru saja berubah (kasir ' + k + ', verifikator ' + v + '). Buka ulang dari daftar notifikasi.' };
    }

    var props = PropertiesService.getScriptProperties();
    var key = kunciRekon_(user.cabang, kode);
    var raw = props.getProperty(key);
    var rec = raw ? JSON.parse(raw) : {};
    var now = new Date();
    var lain = user.role === 'KASIR' ? 'VERIFIKATOR' : 'KASIR';

    delete rec.tidakCocok;                                   // putaran baru
    rec[user.role] = { nilai: nilai, oleh: user.username, t: now.getTime() };

    // (a) Pihak lain belum mengajukan: simpan sementara, sheet tidak berubah
    if (!rec[lain]) {
      props.setProperty(key, JSON.stringify(rec));
      hapusCache_(user.cabang);
      return { ok: true, status: 'menunggu', menunggu: lain, nilai: nilai };
    }

    // (b) Kedua pihak sudah mengajukan tetapi nilainya berbeda: batalkan keduanya, sheet tidak berubah
    if (Number(rec[lain].nilai) !== nilai) {
      props.setProperty(key, JSON.stringify({ tidakCocok: now.getTime() }));
      hapusCache_(user.cabang);
      return { ok: true, status: 'beda', menunggu: lain };
    }

    // (c) Nilai sama: baru sekarang ditulis ke sheet
    var ket = 'REKONSILIASI | disepakati kasir (' + rec.KASIR.oleh + ', ' + jam_(rec.KASIR.t) + ') & verifikator (' +
              rec.VERIFIKATOR.oleh + ', ' + jam_(rec.VERIFIKATOR.t) + ') | awal: kasir ' + k + ', verifikator ' + v +
              ' | nilai valid ' + nilai;

    sheet.insertRowAfter(row);
    var baru = row + 1;
    var rg = sheet.getRange(baru, 1, 1, COL_KET);
    rg.setValues([[cur[0], cur[1], cur[2], nilai, now, nilai, now, ket]]);
    rg.setBackground(WARNA_REKON);
    sheet.getRange(baru, 1).setNumberFormat('@');
    sheet.getRange(baru, 5).setNumberFormat(FORMAT_WAKTU);
    sheet.getRange(baru, 7).setNumberFormat(FORMAT_WAKTU);

    sheet.getRange(row, 1, 1, COL_KET).setBackground(WARNA_AWAL);
    var ketLama = String(sheet.getRange(row, COL_KET).getValue()).trim();
    sheet.getRange(row, COL_KET).setValue((ketLama ? ketLama + ' | ' : '') + 'SELISIH (diganti baris rekonsiliasi di bawahnya)');

    props.deleteProperty(key);
    hapusCache_(user.cabang);
    return { ok: true, status: 'selesai', nilai: nilai };
  } finally {
    lock.releaseLock();
  }
}
