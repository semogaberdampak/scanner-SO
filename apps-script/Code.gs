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
// var PIN_DEFAULT = '';          // PIN Kasir & Verifikator semua cabang
// var PIN_ADMIN_DEFAULT = '';
// var PIN_VERIFIKATOR_DEFAULT = ''; // PIN Verifikator saja // PIN Super User (admin) saja
// Disarankan: isi Script Properties APP_PIN agar PIN tidak ada di kode
var SESSION_SECONDS = 1 * 60 * 60;   // 6 jam (batas maksimum CacheService)
var CABANG_VALID = ['kranggan', 'katedral', 'santamaria', 'athanasius', 'antonius', 'paulus'];
var ROLE_VALID = ['KASIR', 'VERIFIKATOR'];

// Format sheet tiap cabang: SATU BARIS PER PRODUK (kolom A-G) + kolom H "keterangan" (jejak audit)
var HEADER = ['kode_produk', 'nama_produk', 'harga', 'input_kasir', 'timestamp_kasir', 'input_verifikator', 'timestamp_verifikator', 'keterangan', 'kategori'];
var HEADER_KET = 'keterangan';
var HEADER_KAT = 'kategori';
var COL_KASIR = 4;        // D (timestamp di E)
var COL_VERIFIKATOR = 6;  // F (timestamp di G)
var COL_KET = 8;          // H
var COL_KAT = 9;          // I
var FORMAT_WAKTU = 'dd/MM/yyyy HH:mm:ss';
var WARNA_AWAL = '#FCE4D6';   // baris input awal yang selisih (oranye muda)
var WARNA_REKON = '#E2EFDA';  // baris rekonsiliasi (hijau muda)
var NOTIF_CACHE_DETIK = 60;
var SHEET_UJI = 'tes_input';        // sheet khusus uji coba admin (semua fitur, tanpa jadwal)
var TZ_AKSES = 'Asia/Jakarta';     // "hari ini" untuk jadwal input mengikuti WIB
var MAKS_TANGGAL = 400;            // batas jumlah tanggal per cabang

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
    sheet.appendRow(HEADER);
  } else {
    // Pastikan kolom H keterangan dan kolom I kategori ada
    var h = String(sheet.getRange(1, COL_KET).getValue()).trim();
    if (!h) sheet.getRange(1, COL_KET).setValue(HEADER_KET);
    var kat = String(sheet.getRange(1, COL_KAT).getValue()).trim();
    if (!kat) sheet.getRange(1, COL_KAT).setValue(HEADER_KAT);
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

// ===== JADWAL INPUT PER CABANG (Time-Based Access Control) =====
// Disimpan di Script Properties: "jadwal|cabang" -> { d:["yyyy-MM-dd",...], oleh, t }
// Aturan: cabang HANYA boleh input (simpan & rekonsiliasi) pada tanggal yang tercantum. Tanpa tanggal = ditutup.
function hariIni_() { return Utilities.formatDate(new Date(), TZ_AKSES, 'yyyy-MM-dd'); }
function tglIndo_(s) { var p = String(s).split('-'); return p[2] + '/' + p[1] + '/' + p[0]; }

function tanggalValid_(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  var p = s.split('-'), y = Number(p[0]), m = Number(p[1]), d = Number(p[2]);
  var dt = new Date(Date.UTC(y, m - 1, d));
  return y >= 2020 && y <= 2100 && dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function bacaJadwal_(cabang) {
  var raw = PropertiesService.getScriptProperties().getProperty('jadwal|' + cabang);
  if (!raw) return { d: [], oleh: '', t: 0 };
  try { var o = JSON.parse(raw); o.d = o.d || []; return o; } catch (e) { return { d: [], oleh: '', t: 0 }; }
}

function aksesCabang_(cabang) {
  var h = hariIni_();
  if (cabang === SHEET_UJI) return { terbuka: true, uji: true, hari_ini: h, jadwal: [] };
  var j = bacaJadwal_(cabang);
  return { terbuka: j.d.indexOf(h) >= 0, uji: false, hari_ini: h, jadwal: j.d };
}

// null = boleh; selain itu = objek error siap dikirim
function wajibTerbuka_(user) {
  var a = aksesCabang_(user.cabang);
  if (a.terbuka) return null;
  var berikut = a.jadwal.filter(function (x) { return x > a.hari_ini; })[0];
  return { ok: false, code: 'TUTUP',
    error: 'Input cabang ' + user.cabang.toUpperCase() + ' ditutup hari ini (' + tglIndo_(a.hari_ini) + '). ' +
           (berikut ? 'Jadwal input berikutnya: ' + tglIndo_(berikut) + '.' : 'Belum ada jadwal input. Hubungi admin.') };
}

// Admin tidak menyentuh data cabang: semua operasinya diarahkan ke sheet tes_input.
// Dengan "peran_uji" admin dapat berperan sebagai KASIR atau VERIFIKATOR (untuk menguji alur dua pihak).
function efektif_(sesi, b) {
  if (sesi.role !== 'ADMIN') return sesi;
  var peran = String((b && b.peran_uji) || '').toUpperCase();
  if (ROLE_VALID.indexOf(peran) >= 0) return { username: 'admin_' + peran.toLowerCase(), role: peran, cabang: SHEET_UJI, uji: true };
  return { username: 'admin', role: 'ADMIN', cabang: SHEET_UJI, uji: true };
}

function jadwalGet_(sesi) {
  if (sesi.role !== 'ADMIN') return { ok: false, error: 'Hanya admin yang dapat mengatur jadwal.' };
  var out = {};
  CABANG_VALID.forEach(function (c) { var j = bacaJadwal_(c); out[c] = { tanggal: j.d, oleh: j.oleh, t: j.t }; });
  return { ok: true, jadwal: out, hari_ini: hariIni_(), cabang: CABANG_VALID };
}

function jadwalSet_(sesi, b) {
  if (sesi.role !== 'ADMIN') return { ok: false, error: 'Hanya admin yang dapat mengatur jadwal.' };
  var masuk = b.jadwal;
  if (!masuk || typeof masuk !== 'object') return { ok: false, error: 'Data jadwal tidak valid.' };

  var baru = {};
  var cabangList = Object.keys(masuk);
  for (var i = 0; i < cabangList.length; i++) {
    var c = cabangList[i], arr = masuk[c];
    if (CABANG_VALID.indexOf(c) < 0) return { ok: false, error: 'Cabang tidak valid: ' + c };
    if (!Array.isArray(arr)) return { ok: false, error: 'Daftar tanggal ' + c + ' tidak valid.' };
    if (arr.length > MAKS_TANGGAL) return { ok: false, error: 'Maksimal ' + MAKS_TANGGAL + ' tanggal per cabang.' };
    var uniq = {};
    for (var k = 0; k < arr.length; k++) {
      if (!tanggalValid_(arr[k])) return { ok: false, error: 'Tanggal tidak valid pada ' + c + ': ' + arr[k] };
      uniq[arr[k]] = true;
    }
    baru[c] = Object.keys(uniq).sort();
  }

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var props = PropertiesService.getScriptProperties();
    Object.keys(baru).forEach(function (c) {
      var lama = bacaJadwal_(c).d;
      if (JSON.stringify(lama) !== JSON.stringify(baru[c]))     // hanya cabang yang berubah yang dicatat
        props.setProperty('jadwal|' + c, JSON.stringify({ d: baru[c], oleh: sesi.username, t: new Date().getTime() }));
    });
  } finally {
    lock.releaseLock();
  }
  return jadwalGet_(sesi);
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
      case 'master': return json_(master_(efektif_(requireSession_(body), body)));
      case 'simpan': return json_(simpan_(efektif_(requireSession_(body), body), body));
      case 'rekap':  return json_(rekap_(efektif_(requireSession_(body), body), body));
      case 'notif':  return json_(notif_(efektif_(requireSession_(body), body)));
      case 'snd':    return json_(snd_(efektif_(requireSession_(body), body), body));
      case 'rekonsiliasi': return json_(rekonsiliasi_(efektif_(requireSession_(body), body), body));
      case 'jadwal_get': return json_(jadwalGet_(requireSession_(body)));
      case 'jadwal_set': return json_(jadwalSet_(requireSession_(body), body));
      case 'toggle_verif_get': return json_(toggleVerifGet_(requireSession_(body)));
      case 'toggle_verif_set': return json_(toggleVerifSet_(efektif_(requireSession_(body), body), body));

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

  var props = PropertiesService.getScriptProperties();
  var role = String(b.role || '').toUpperCase();

  // Admin: PIN admin tersendiri
  if (cabang === 'admin') {
    var benarAdmin = String(props.getProperty('APP_PIN_ADMIN') || PIN_ADMIN_DEFAULT);
    if (pin !== benarAdmin) { Utilities.sleep(800); return { ok: false, error: 'PIN salah.' }; };
    var user = { username: 'admin', role: 'ADMIN', cabang: 'admin' };
    var token = Utilities.getUuid() + Utilities.getUuid();
    CacheService.getScriptCache().put('ses_' + token, JSON.stringify(user), SESSION_SECONDS);
    return { ok: true, token: token, user: user };
  }

  // Cabang: Kasir dan Verifikator
  if (CABANG_VALID.indexOf(cabang) < 0) return { ok: false, error: 'Cabang tidak valid.' };
  if (ROLE_VALID.indexOf(role) < 0) return { ok: false, error: 'Role tidak valid.' };

  // Blokir login Verifikator saat mode OFF
  if (role === 'VERIFIKATOR') {
    var valVerif = props.getProperty('TOGGLE_VERIFIKATOR');
    if (valVerif === '0') {
      return { ok: false, error: 'Login Verifikator sementara dinonaktifkan oleh admin (mode verifikator OFF).' };
    }
    var benarVerif = String(props.getProperty('APP_PIN_VERIFIKATOR') || PIN_VERIFIKATOR_DEFAULT);
    if (pin !== benarVerif) { Utilities.sleep(800); return { ok: false, error: 'PIN Verifikator salah.' }; }
  } else {
    // Kasir pakai PIN cabang biasa
    var benarKasir = String(props.getProperty('APP_PIN') || PIN_DEFAULT);
    if (pin !== benarKasir) { Utilities.sleep(800); return { ok: false, error: 'PIN salah.' }; }
  }
  return { ok: false, error: 'Login gagal.' };
}

// ===== SESI =====
function requireSession_(b) {
  var token = String(b.token || '').trim();
  if (!token) throw { code: 'AUTH', message: 'Token tidak ditemukan. Silakan login ulang.' };
  var raw = CacheService.getScriptCache().get('ses_' + token);
  if (!raw) throw { code: 'AUTH', message: 'Sesi habis atau tidak valid. Silakan login ulang.' };
  var user = JSON.parse(raw);
  CacheService.getScriptCache().put('ses_' + token, JSON.stringify(user), SESSION_SECONDS); // perpanjang
  return user;
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
    return { ok: false, error: 'Pilih peran uji (Kasir atau Verifikator) terlebih dulu.' };
  var tutup = wajibTerbuka_(user);          // jadwal input per cabang (admin/tes_input dikecualikan)
  if (tutup) return tutup;

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
    var kategori = String(b.kategori || '').trim().toUpperCase();

    var row = barisAktif_(sheet, kode);
    if (row) {
      // Jika baris aktif adalah hasil rekonsiliasi, JANGAN diubah (jejak audit). Buat baris "LANJUTAN" di bawahnya.
      if (String(sheet.getRange(row, COL_KET).getValue()).indexOf('REKONSILIASI') === 0) {
        var cur = sheet.getRange(row, 1, 1, 9).getValues()[0];
        sheet.insertRowAfter(row);
        row = row + 1;
        var rg = sheet.getRange(row, 1, 1, COL_KET);
        rg.setBackground(null);
        rg.setValues([cur.concat(['LANJUTAN'])]);
        sheet.getRange(row, 1).setNumberFormat('@');
      }
      total = (Number(sheet.getRange(row, kolom).getValue()) || 0) + qty;
      sheet.getRange(row, kolom, 1, 2).setValues([[total, now]]);
      if (kategori) sheet.getRange(row, COL_KAT).setValue(kategori);
      sheet.getRange(row, kolom + 1).setNumberFormat(FORMAT_WAKTU);
    } else {
      var baru = sheet.getLastRow() + 1;
      sheet.getRange(baru, 1).setNumberFormat('@');
      var data = [kode, m[2], m[3], '', '', '', '', '', kategori];
      data[kolom - 1] = qty;
      data[kolom] = now;
      sheet.getRange(baru, 1, 1, HEADER.length).setValues([data]);
      sheet.getRange(baru, kolom + 1).setNumberFormat(FORMAT_WAKTU);
      total = qty;
    }

    hapusRekon_(user.cabang, kode);   // nilai berubah: pengajuan rekonsiliasi lama tidak berlaku lagi
    hapusCache_(user.cabang);
    return { ok: true, total: total, sheet: user.cabang, message: 'Tersimpan di sheet ' + user.cabang + ' (' + user.role + ')' };
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
  // Admin: HANYA sheet tes_input. Selain admin: hanya cabangnya sendiri (boleh diunduh kapan saja).
  var target = user.uji ? SHEET_UJI : user.cabang;
  if (target !== SHEET_UJI && CABANG_VALID.indexOf(target) < 0) return { ok: false, error: 'Cabang tidak valid.' };

  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(target);
  if (!sheet || !cekFormatSheet_(sheet)) return { ok: true, data: [], cabang: target };

  // Satu baris per produk: baris terakhir (nilai setelah rekonsiliasi). Baris riwayat tidak ikut dihitung.
  var p = barisAktifSemua_(sheet.getDataRange().getValues());
  var out = p.urutan.map(function (kode) {
    var r = p.aktif[kode];
    return { produk_id: kode, nama_produk: r[1], harga: r[2], qty_kasir: Number(r[3]) || 0, qty_verifikator: Number(r[5]) || 0, kategori: String(r[8] || "").trim() };
  });
  return { ok: true, data: out, cabang: target };
}

// ===== INPUT SnD: filter produk per supplier (HANYA BACA, tidak menyimpan apa pun) =====
// Kode supplier = karakter ke-5 dan ke-6 dari kode produk (mis. 1123LB0001 -> "LB").
// Hanya produk yang jumlahnya sudah VALID: kedua peran sudah input dan nilainya sama
// (hasil pencocokan, atau memang sama sejak awal). Khusus Kasir.
function snd_(user, b) {
  if (user.role !== 'KASIR') return { ok: false, error: 'Fitur Input SnD hanya untuk Kasir.' };
  var kode2 = String(b.kode2 || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{2}$/.test(kode2)) return { ok: false, error: 'Isi tepat 2 karakter (huruf atau angka).' };
  // Jika pencocokan verifikator dimatikan, cukup kasir sudah input dan qty valid.
  var verifOff = b.verifOff === true;

  var kosong = { ok: true, kode2: kode2, items: [], belum: 0, total_pcs: 0 };
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(user.cabang);
  if (!sheet || !cekFormatSheet_(sheet)) return kosong;

  var p = barisAktifSemua_(sheet.getDataRange().getValues());
  var items = [], belum = 0, total = 0;
  p.urutan.forEach(function (kode) {
    if (kode.length < 6 || kode.substr(4, 2).toUpperCase() !== kode2) return;
    var r = p.aktif[kode];
    var k = Number(r[3]) || 0, v = Number(r[5]) || 0;
    if (verifOff ? (waktu_(r[4]) && k > 0) : (waktu_(r[4]) && waktu_(r[6]) && k === v)) {
      items.push({
        produk_id: kode, nama_produk: r[1], harga: r[2], jumlah: k,
        status: String(r[7] || '').indexOf('REKONSILIASI') === 0 ? 'REKONSILIASI' : 'COCOK',
        kategori: String(r[8] || '').trim()
      });
      total += k;
    } else {
      belum++;     // masih selisih atau baru satu pihak: belum FIX/VALID
    }
  });
  items.sort(function (a, b) { return a.produk_id < b.produk_id ? -1 : a.produk_id > b.produk_id ? 1 : 0; });
  return { ok: true, kode2: kode2, items: items, belum: belum, total_pcs: total };
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
  var cache = CacheService.getScriptCache();
  var key = 'notif_' + user.cabang;
  var hit = cache.get(key);
  var hasil;
  if (hit) {
    hasil = JSON.parse(hit);
  } else {
    hasil = hitungSelisih_(user.cabang);
    try { cache.put(key, JSON.stringify(hasil), NOTIF_CACHE_DETIK); } catch (e) { /* terlalu besar: lewati cache */ }
  }
  hasil.akses = aksesCabang_(user.cabang);    // status jadwal selalu dihitung segar (tidak ikut cache)
  return hasil;
}

// ===== PENCOCOKAN (REKONSILIASI) =====
// Kasir DAN Verifikator masing-masing mengajukan nilai yang disepakati. Selama baru satu pihak, sheet TIDAK berubah.
// Jika kedua nilai sama -> baris awal diberi warna (nilai tidak diubah) + satu baris REKONSILIASI disisipkan di bawahnya.
// Jika berbeda -> kedua pengajuan dibatalkan, sheet tidak berubah.
function rekonsiliasi_(user, b) {
  if (user.role !== 'KASIR' && user.role !== 'VERIFIKATOR')
    return { ok: false, error: 'Pilih peran uji (Kasir atau Verifikator) terlebih dulu.' };
  var tutup = wajibTerbuka_(user);
  if (tutup) return tutup;

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

    var cur = sheet.getRange(row, 1, 1, 9).getValues()[0];
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
    var rg = sheet.getRange(baru, 1, 1, COL_KAT);
    rg.setValues([[cur[0], cur[1], cur[2], nilai, now, nilai, now, ket, cur[8] || '']]);
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

// ===== TOGGLE VERIFIKATOR (server-side, semua cabang) =====
function toggleVerifGet_(user) {
  var props = PropertiesService.getScriptProperties();
  var val = props.getProperty('TOGGLE_VERIFIKATOR');
  return { ok: true, aktif: val !== '0' }; // default true
}

function toggleVerifSet_(user, b) {
  if (user.role !== 'ADMIN') return { ok: false, error: 'Hanya admin yang boleh mengubah mode ini.' };
  var aktif = b.aktif === true;
  var props = PropertiesService.getScriptProperties();
  props.setProperty('TOGGLE_VERIFIKATOR', aktif ? '1' : '0');
  return { ok: true, aktif: aktif };
}