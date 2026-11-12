
  let productLookupMap = {};   // kunci HURUF BESAR: produk_id atau ISBN
  let productList = [];        // [{ idU, item }] untuk pencarian sebagian
  let currentUser = null;
  let activeItem = null;
  let session = null; // { token, user }
  const SESSION_KEY = 'scanstock.session.v1';

  // Gabungkan config.js (utama) dengan nilai cadangan di index.html
  function getConfig() {
    const d = window.APP_DEFAULTS || {};
    const c = window.APP_CONFIG || {};
    const valid = u => typeof u === 'string' && /^https:\/\/script\.google\.com\//.test(u);
    return {
      API_URL: valid(c.API_URL) ? c.API_URL : (valid(d.API_URL) ? d.API_URL : ''),
      POLL_SECONDS: Number(c.POLL_SECONDS) || Number(d.POLL_SECONDS) || 60
    };
  }

  // ---------- API (Google Apps Script sebagai backend) ----------
  // Content-Type text/plain sengaja dipakai agar tidak memicu preflight CORS.
  // ---------- Peran & mode uji admin ----------
  const PERAN_KEY = 'scanstock.peranuji';
  let peranUji = 'KASIR';
  try { const p = localStorage.getItem(PERAN_KEY); if (p === 'KASIR' || p === 'VERIFIKATOR') peranUji = p; } catch (e) {}
  // Status pencocokan verifikator (ON/OFF). Default ON, tersimpan di localStorage.
  let pencocokanVerifAktif = (localStorage.getItem('scanstock.pencocokanVerif') !== '0');
  function isAdmin() { return !!currentUser && currentUser.role === 'ADMIN'; }
  function peranAktif() { return isAdmin() ? peranUji : (currentUser ? currentUser.role : ''); }
  const labelSheet = () => (isAdmin() ? 'TES_INPUT' : (currentUser ? currentUser.cabang.toUpperCase() : ''));

  function tampilPeranUji() {
    ['KASIR', 'VERIFIKATOR'].forEach(r => document.getElementById('btnPeran' + r).classList.toggle('aktif', r === peranUji));
  }
  function setPeranUji(p) {
    peranUji = p;
    try { localStorage.setItem(PERAN_KEY, p); } catch (e) {}
    tampilPeranUji();
    tampilkanTombolSnd();
    if (peranAktif() !== 'KASIR') { tutupQr(); tutupSnd(); }
    if (document.getElementById('notifPanel').style.display === 'flex') renderNotifList();
    if (reconItem && document.getElementById('reconModal').style.display === 'flex') tampilkanStatusRecon();
  }

  async function api(action, payload) {
    const url = getConfig().API_URL;
    if (!url) {
      const status = window.APP_CONFIG ? 'config.js termuat tetapi API_URL-nya tidak valid' : 'config.js TIDAK termuat';
      throw Object.assign(new Error('API_URL tidak ditemukan (' + status + '). Periksa config.js atau nilai cadangan di index.html.'), { code: 'CONFIG' });
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 30000);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(Object.assign({ action: action, token: session ? session.token : null, peran_uji: isAdmin() ? peranUji : undefined }, payload || {})),
        signal: ctrl.signal
      });
      // Handle 401 Unauthorized - token expired/invalid
      if (res.status === 401) {
        throw Object.assign(new Error('Sesi berakhir, silakan login kembali.'), { code: 'AUTH' });
      }
      const data = await res.json();
      if (!data.ok) throw Object.assign(new Error(data.error || 'Permintaan gagal.'), { code: data.code || 'SERVER' });
      return data;
    } catch (err) {
      if (err.name === 'AbortError') throw Object.assign(new Error('Server terlalu lama merespons.'), { code: 'TIMEOUT' });
      if (err instanceof TypeError) throw Object.assign(new Error('Tidak dapat terhubung ke server. Periksa koneksi internet.'), { code: 'NETWORK' });
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  // Global error handler for unhandled promise rejections
  window.addEventListener('unhandledrejection', (event) => {
    const err = event.reason;
    if (err && err.code === 'AUTH') {
      event.preventDefault();
      handleAuthError(err);
    } else if (err && err.code === 'NETWORK') {
      event.preventDefault();
      showOfflineIndicator(true);
    }
  });

  function handleAuthError(err) {
    if (err && err.code === 'AUTH') {
      logout();
      showModal("Sesi Berakhir", "Silakan login kembali.");
      return true;
    }
    return false;
  }

  // ================= OFFLINE QUEUE & SYNC =================
  const OFFLINE_DB_NAME = 'scanstock-offline';
  const OFFLINE_STORE = 'pending_scans';
  let offlineDb = null;

  async function initOfflineDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(OFFLINE_DB_NAME, 1);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(OFFLINE_STORE)) {
          db.createObjectStore(OFFLINE_STORE, { keyPath: 'id', autoIncrement: true });
        }
      };
      req.onsuccess = () => { offlineDb = req.result; resolve(offlineDb); };
      req.onerror = () => reject(req.error);
    });
  }

  async function queueOfflineScan(scanData) {
    if (!offlineDb) await initOfflineDb();
    return new Promise((resolve, reject) => {
      const tx = offlineDb.transaction(OFFLINE_STORE, 'readwrite');
      tx.objectStore(OFFLINE_STORE).add({ ...scanData, timestamp: Date.now() });
      tx.oncomplete = () => { updateOfflineBadge(); resolve(); };
      tx.onerror = () => reject(tx.error);
    });
  }

  async function getOfflineQueue() {
    if (!offlineDb) await initOfflineDb();
    return new Promise((resolve, reject) => {
      const tx = offlineDb.transaction(OFFLINE_STORE, 'readonly');
      const req = tx.objectStore(OFFLINE_STORE).getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function clearOfflineQueue() {
    if (!offlineDb) await initOfflineDb();
    return new Promise((resolve, reject) => {
      const tx = offlineDb.transaction(OFFLINE_STORE, 'readwrite');
      tx.objectStore(OFFLINE_STORE).clear();
      tx.oncomplete = () => { updateOfflineBadge(); resolve(); };
      tx.onerror = () => reject(tx.error);
    });
  }

  async function removeOfflineItem(id) {
    if (!offlineDb) await initOfflineDb();
    return new Promise((resolve, reject) => {
      const tx = offlineDb.transaction(OFFLINE_STORE, 'readwrite');
      tx.objectStore(OFFLINE_STORE).delete(id);
      tx.oncomplete = () => { updateOfflineBadge(); resolve(); };
      tx.onerror = () => reject(tx.error);
    });
  }

  async function syncOfflineQueue() {
    const queue = await getOfflineQueue();
    if (queue.length === 0) return;

    showOfflineIndicator(true, `Menyinkronkan ${queue.length} item...`);

    for (const item of queue) {
      try {
        await api(item.action, item.payload);
        await removeOfflineItem(item.id);
      } catch (err) {
        if (err.code === 'NETWORK') {
          showOfflineIndicator(true, 'Offline - antrian tersimpan');
          break; // Stop syncing if still offline
        }
        // For other errors, remove the item to avoid blocking queue
        console.error('Sync failed for item:', item, err);
        await removeOfflineItem(item.id);
      }
    }
    updateOfflineBadge();
    showOfflineIndicator(false);
  }

  function updateOfflineBadge() {
    getOfflineQueue().then(queue => {
      const badge = document.getElementById('offlineBadge');
      if (badge) {
        badge.textContent = queue.length;
        badge.style.display = queue.length > 0 ? 'inline-flex' : 'none';
      }
    });
  }

  function showOfflineIndicator(show, message = '') {
    let indicator = document.getElementById('offlineIndicator');
    if (!indicator) {
      indicator = document.createElement('div');
      indicator.id = 'offlineIndicator';
      indicator.style.cssText = 'position:fixed;bottom:10px;left:50%;transform:translateX(-50%);background:var(--danger);color:white;padding:8px 16px;border-radius:20px;font-size:12px;z-index:9999;display:none;box-shadow:0 2px 8px rgba(0,0,0,0.2);';
      document.body.appendChild(indicator);
    }
    if (show) {
      indicator.textContent = message || '⚠️ Offline - Data tersimpan lokal';
      indicator.style.display = 'block';
    } else {
      indicator.style.display = 'none';
    }
  }

  // ================= HAPTIC FEEDBACK =================
  function hapticFeedback(type = 'light') {
    if ('vibrate' in navigator) {
      const patterns = {
        light: [10],
        medium: [20],
        heavy: [30],
        success: [10, 50, 10],
        error: [50, 30, 50],
        warning: [20, 20, 20]
      };
      navigator.vibrate(patterns[type] || patterns.light);
    }
  }

  // ================= KEYBOARD SHORTCUTS =================
  function initKeyboardShortcuts() {
    document.addEventListener('keydown', (e) => {
      // Don't trigger shortcuts when typing in inputs
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;

      if (e.ctrlKey || e.metaKey) {
        switch (e.key.toLowerCase()) {
          case 'k': // Ctrl+K: Focus search/scan
            e.preventDefault();
            const scanInput = document.getElementById('scanInput');
            if (scanInput) scanInput.focus();
            break;
          case 'enter': // Ctrl+Enter: Submit if in modal
            e.preventDefault();
            const confirmBtn = document.querySelector('.modal .btn-primary');
            if (confirmBtn) confirmBtn.click();
            break;
        }
      } else {
        switch (e.key) {
          case 'Enter': // Enter: Submit active form
            const activeModal = document.querySelector('.modal[style*="flex"]');
            if (activeModal) {
              const submitBtn = activeModal.querySelector('.btn-primary');
              if (submitBtn) submitBtn.click();
            }
            break;
          case 'Escape': // Esc: Close modals with animation
            document.querySelectorAll('.modal[style*="flex"]').forEach(m => closeModal(m));
            break;
        }
      }
    });
  }

  // ================= MODAL ANIMATION HELPERS =================
  const MODAL_ANIMATION_DURATION = 300; // matches --duration-normal

  function openModal(modalEl) {
    if (!modalEl) return;
    modalEl.style.display = 'flex';
    // Force reflow to ensure animation plays
    void modalEl.offsetWidth;
    modalEl.classList.add('modal-enter');
    document.body.classList.add('modal-open');
    // Clean up animation class after it completes
    setTimeout(() => modalEl.classList.remove('modal-enter'), MODAL_ANIMATION_DURATION);
  }

  function closeModal(modalEl) {
    if (!modalEl) return;
    modalEl.classList.add('modal-exit');
    setTimeout(() => {
      modalEl.style.display = 'none';
      modalEl.classList.remove('modal-exit');
      // Only remove modal-open if no other modals are open
      const openModals = document.querySelectorAll('.modal-overlay[style*="flex"]');
      if (openModals.length === 0) {
        document.body.classList.remove('modal-open');
      }
    }, MODAL_ANIMATION_DURATION);
  }

  // ================= PULL TO REFRESH =================
  let pullStartY = 0;
  let pullCurrentY = 0;
  let isPulling = false;
  let ptrIndicator = null;

  // Create ptr-indicator element
  function createPtrIndicator() {
    if (ptrIndicator) return ptrIndicator;
    ptrIndicator = document.createElement('div');
    ptrIndicator.className = 'ptr-indicator';
    ptrIndicator.innerHTML = `
      <div class="ptr-spinner"></div>
      <div class="ptr-text">Tarik untuk refresh</div>
    `;
    document.body.insertBefore(ptrIndicator, document.body.firstChild);
    return ptrIndicator;
  }

  function initPullToRefresh() {
    // Create the indicator element
    createPtrIndicator();

    document.addEventListener('touchstart', (e) => {
      if (window.scrollY === 0) {
        pullStartY = e.touches[0].clientY;
        isPulling = true;
      }
    }, { passive: true });

    document.addEventListener('touchmove', (e) => {
      if (!isPulling) return;
      pullCurrentY = e.touches[0].clientY;
      const delta = pullCurrentY - pullStartY;
      if (delta > 0 && delta < 100) {
        e.preventDefault();
        document.body.style.transform = `translateY(${delta * 0.5}px)`;
        document.body.style.transition = 'none';

        // Show/hide ptr-indicator based on pull distance
        if (ptrIndicator) {
          const progress = Math.min(delta / 80, 1);
          ptrIndicator.style.opacity = progress;
          ptrIndicator.style.transform = `translateY(-50%) scale(${0.8 + progress * 0.2})`;

          // Update text based on progress
          const textEl = ptrIndicator.querySelector('.ptr-text');
          if (textEl) {
            if (delta > 60) {
              textEl.textContent = 'Lepas untuk refresh';
              ptrIndicator.classList.add('ready');
            } else {
              textEl.textContent = 'Tarik untuk refresh';
              ptrIndicator.classList.remove('ready');
            }
          }
        }
      }
    }, { passive: false });

    document.addEventListener('touchend', () => {
      if (!isPulling) return;
      const delta = pullCurrentY - pullStartY;
      document.body.style.transition = 'transform 0.3s ease';
      document.body.style.transform = 'translateY(0)';

      // Hide ptr-indicator with animation
      if (ptrIndicator) {
        ptrIndicator.style.opacity = '0';
        ptrIndicator.style.transform = 'translateY(-50%) scale(0.8)';
        ptrIndicator.classList.remove('ready');
      }

      if (delta > 60) {
        hapticFeedback('medium');
        refreshData();
      }
      isPulling = false;
      pullStartY = 0;
      pullCurrentY = 0;
    });
  }

  async function refreshData() {
    const status = document.getElementById('dbStatus');
    if (status) status.innerText = "🔄 Memperbarui data...";
    try {
      await fetchMasterData();
      await fetchToggleVerifikasi();
      pollNotif(true);
      if (status) status.innerText = "✅ Data diperbarui";
      hapticFeedback('success');
    } catch (err) {
      if (status) status.innerText = "❌ Gagal memperbarui: " + err.message;
      hapticFeedback('error');
    }
  }

  async function fetchMasterData() {
    const status = document.getElementById('dbStatus');
    const indicator = document.getElementById('statusIndicator');
    if (status) status.innerText = "Memuat Master Produk...";
    if (indicator) indicator.className = 'status-indicator loading';

    // Show skeleton loader in scanner area while loading
    showScannerSkeleton(true);

    try {
      const res = await api('master');
      productLookupMap = {};
      productList = [];
      res.data.forEach(item => {
        if (!item.produk_id) return;
        const idU = String(item.produk_id).trim().toUpperCase();
        productLookupMap[idU] = item;
        productList.push({ idU: idU, item: item });
      });
      // ISBN dipakai sebagai kunci tambahan (tidak boleh menimpa produk_id yang sama)
      res.data.forEach(item => {
        const isbn = String(item.isbn || '').trim().replace(/[- ]/g, '').toUpperCase();
        if (isbn && !(isbn in productLookupMap)) productLookupMap[isbn] = item;
      });
      if (status) status.innerText = "✅ Database Siap (" + res.data.length + " Produk Loaded)";
      if (indicator) indicator.className = 'status-indicator ready';
    } catch (err) {
      if (handleAuthError(err)) return;
      if (status) status.innerText = "❌ Gagal memuat data master: " + err.message;
      if (indicator) indicator.className = 'status-indicator error';
    } finally {
      showScannerSkeleton(false);
    }
  }

  function showScannerSkeleton(show) {
    const scannerArea = document.getElementById('scannerArea');
    const hint = document.getElementById('scannerHint');
    const controls = scannerArea?.querySelector('.scanner-controls');

    if (show) {
      // Add skeleton overlay if not exists
      if (!scannerArea.querySelector('.scanner-skeleton')) {
        const skeleton = document.createElement('div');
        skeleton.className = 'scanner-skeleton';
        skeleton.style.cssText = 'position:absolute;inset:0;background:rgba(0,0,0,0.4);z-index:15;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;padding:16px;pointer-events:none;';
        skeleton.innerHTML = `
          <div class="skeleton" style="width:60px;height:60px;border-radius:50%;"></div>
          <div class="skeleton skeleton-text short" style="max-width:200px;"></div>
        `;
        scannerArea.insertBefore(skeleton, scannerArea.firstChild);
      }
      if (hint) hint.style.display = 'none';
      if (controls) controls.style.display = 'none';
    } else {
      const skeleton = scannerArea?.querySelector('.scanner-skeleton');
      if (skeleton) skeleton.remove();
      if (hint) hint.style.display = 'block';
      if (controls) controls.style.display = 'flex';
    }
  }

  // PIN admin memuat huruf, jadi keyboard angka hanya dipakai untuk cabang
  function aturKeyboardPin() {
    const admin = document.getElementById('loginBranch').value === 'admin';
    document.getElementById('loginPass').setAttribute('inputmode', admin ? 'text' : 'numeric');
  }

  async function login() {
    const branchSelect = document.getElementById('loginBranch').value;
    const selectedRole = document.querySelector('input[name="userRole"]:checked').value;
    const pass = document.getElementById('loginPass').value;
    if (!pass) return showModal("Peringatan", "Silahkan masukkan PIN / Password.");

    const btnLogin = document.getElementById('btnLogin');
    btnLogin.disabled = true;
    btnLogin.innerText = "Memeriksa...";
    try {
      const res = await api('login', { cabang: branchSelect, role: selectedRole, pin: pass });
      session = { token: res.token, user: res.user };
      try { localStorage.setItem(SESSION_KEY, JSON.stringify(session)); } catch (e) {}
      document.getElementById('loginPass').value = '';
      prosesMasuk();
      hapticFeedback('success');
    } catch (err) {
      showModal(err.code === 'SERVER' ? "Login Gagal" : "Gagal Login", err.message);
      hapticFeedback('error');
    } finally {
      btnLogin.disabled = false;
      btnLogin.innerText = "Login";
    }
  }

  function prosesMasuk() {
    currentUser = session.user;

    // Switch screens
    document.getElementById('loginSection').classList.remove('active');
    document.getElementById('appSection').classList.add('active');
    document.getElementById('appSection').style.display = 'flex';

    // Update top bar
    const branchName = currentUser.cabang ? currentUser.cabang.toUpperCase() : '';
    document.getElementById('topBarBranch').textContent = branchName;
    document.getElementById('topBarBranch').style.display = branchName ? 'inline-flex' : 'none';

    // Update user info in app screen header
    document.getElementById('currentUserInfo').textContent = `${currentUser.username} (${isAdmin() ? 'ADMIN' : currentUser.role})`;

    // Show/hide admin panel
    document.getElementById('adminPanel').style.display = isAdmin() ? 'block' : 'none';
    if (isAdmin()) tampilPeranUji();

    // Show/hide SND button in bottom bar
    tampilkanTombolSnd();

    // Show camera buttons for authenticated users
    const startBtn = document.getElementById('btnStartScanner');
    const fabScan = document.getElementById('fabScan');
    const stopBtn = document.getElementById('btnStopScanner');
    if (startBtn) startBtn.style.display = 'inline-flex';
    if (fabScan) fabScan.style.display = 'inline-flex';
    if (stopBtn) stopBtn.style.display = 'none';

    // Fetch master data
    fetchMasterData();
    startPolling();
  }

  function logout() {
    currentUser = null;
    session = null;
    productLookupMap = {};
    productList = [];
    activeItem = null;
    try { localStorage.removeItem(SESSION_KEY); } catch (e) {}

    // Switch screens
    document.getElementById('appSection').classList.remove('active');
    document.getElementById('appSection').style.display = 'none';
    document.getElementById('loginSection').classList.add('active');

    // Clear top bar
    document.getElementById('topBarBranch').textContent = '';
    document.getElementById('topBarBranch').style.display = 'none';
    document.getElementById('currentUserInfo').textContent = '';

    // Hide result card
    document.getElementById('resultCard').style.display = 'none';

    // Hide camera buttons on login page
    const startBtn = document.getElementById('btnStartScanner');
    const fabScan = document.getElementById('fabScan');
    const stopBtn = document.getElementById('btnStopScanner');
    if (startBtn) startBtn.style.display = 'none';
    if (fabScan) fabScan.style.display = 'none';
    if (stopBtn) stopBtn.style.display = 'none';

    // Reset status
    const statusEl = document.getElementById('dbStatus');
    if (statusEl) statusEl.innerText = "Silakan login untuk memuat data produk.";
    const indicator = document.getElementById('statusIndicator');
    if (indicator) indicator.className = 'status-indicator';

    stopScanner();
    resetNotif();
    document.getElementById('adminPanel').style.display = 'none';
    document.getElementById('aksesBar').style.display = 'none';
    document.getElementById('btnSnd').style.display = 'none';
    aksesData = null; aksesTerbuka = true;
    hapticFeedback('medium');
  }

  function jenisKode(kode) {
    if (/^[0-9]{10}$/.test(kode)) return 'NUMERIK';
    if (/^[A-Za-z0-9]{10}$/.test(kode)) return 'ALFANUMERIK';
    return 'LAIN';
  }

  function tampilkanProduk(item) {
    const card = document.getElementById('resultCard');
    activeItem = item;
    document.getElementById('resId').innerText = "ID: " + item.produk_id + (item.isbn ? " | ISBN: " + item.isbn : "");
    document.getElementById('resTitle').innerText = item.nama_produk;
    document.getElementById('resPrice').innerText = "Rp " + Number(item.harga).toLocaleString('id-ID');
    card.className = "card result-card";
    card.style.display = "block";
    // Trigger scan flash animation
    card.classList.add('flash');
    // Remove flash class after animation completes
    setTimeout(() => card.classList.remove('flash'), 600);

    // Auto-select kategori Eksternal untuk produk alfanumerik 10 digit (contoh: 1123LB0001)
    const kode = String(item.produk_id || '').trim();
    const jenis = jenisKode(kode);

    // Reset pilihan kategori sebelumnya
    inputKategoriTerpilih = null;
    const btns = document.querySelectorAll('#inputKategori button');
    btns.forEach(b => { b.style.background = ''; b.style.color = ''; });

    if (jenis === 'ALFANUMERIK') {
      // Produk alfanumerik 10 digit pasti Eksternal
      inputKategoriTerpilih = 'EKSTERNAL';
      btns.forEach(b => {
        if (b.textContent.toUpperCase().trim() === 'EKSTERNAL') {
          b.style.background = 'var(--accent-line)';
          b.style.color = '#fff';
        }
      });
    }

    if (!isScanning) document.getElementById('inputQty').focus();
    card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    hapticFeedback('success');
  }

  function produkTidakDitemukan(kode) {
    const card = document.getElementById('resultCard');
    activeItem = null;
    document.getElementById('resId').innerText = "Kode dicari: " + kode;
    document.getElementById('resTitle').innerText = "Produk Tidak Ditemukan";
    document.getElementById('resPrice').innerText = "Rp 0";
    card.className = "card result-card error";
    card.style.display = "block";
    hapticFeedback('error');
  }

  // Kode persis (produk_id atau ISBN), tanpa peduli huruf besar/kecil. Dipakai oleh scanner kamera & foto.
  function lookupProduct(scannedCode) {
    if (!scannedCode) return;
    const key = String(scannedCode).trim().replace(/[- ]/g, '').toUpperCase();
    const item = productLookupMap[key];
    if (item) tampilkanProduk(item); else produkTidakDitemukan(scannedCode);
  }

  async function simpanInputQty() {
    const qtyVal = parseInt(document.getElementById('inputQty').value) || 0;
    if (!activeItem) return;
    if (!aksesTerbuka) return showModal("Input Ditutup", "Input cabang ini sedang ditutup menurut jadwal. Lihat keterangan di bagian atas layar.");
    if (qtyVal <= 0) return showModal("Peringatan", "Jumlah produk harus lebih dari 0.");

    const btn = document.getElementById('btnSimpan');
    btn.innerText = "Simpan...";
    btn.disabled = true;

    try {
      // Cabang, role, user, nama & harga ditentukan server dari sesi dan sheet Master
      const kode = String(activeItem.produk_id).trim();
      // Ambil kategori: dari form input qty, atau dari konteks Input SnD (sndKategoriTerpilih)
      const kategori = inputKategoriTerpilih || sndKategoriTerpilih || null;
      const payload = { produk_id: activeItem.produk_id, qty: qtyVal, kategori: kategori };
      const res = await api('simpan', payload);
      document.getElementById('inputQty').value = 1;
      // Reset pilihan kategori setelah disimpan
      inputKategoriTerpilih = null;
      const btns = document.querySelectorAll('#inputKategori button');
      btns.forEach(b => { b.style.background = ''; b.style.color = ''; });
      resumeScanner();
      pollNotif(true);
      showModal("Berhasil Disimpan", `Tercatat (${peranAktif()}) +${qtyVal} Pcs ${activeItem.nama_produk} di ${String(res.sheet || labelSheet()).toUpperCase()}. Total input ${peranAktif().toLowerCase()} untuk produk ini: ${res.total} Pcs.${res.kategori ? ' Kategori: ' + res.kategori + '.' : ''}`);
      hapticFeedback('success');
    } catch (err) {
      if (handleAuthError(err)) return;
      // If network error, queue for offline sync
      if (err.code === 'NETWORK') {
        try {
          await queueOfflineScan({ action: 'simpan', payload });
          showModal("Tersimpan Offline", "Koneksi bermasalah. Data akan disinkronkan saat online kembali.");
          hapticFeedback('warning');
        } catch (e) {
          showModal("Gagal", "Gagal menyimpan offline: " + e.message);
          hapticFeedback('error');
        }
      } else if (err.code === 'TUTUP') {
        pollNotif(true);
        showModal("Input Ditutup", err.message);
        hapticFeedback('error');
      } else {
        showModal("Gagal Menyimpan", err.message);
        hapticFeedback('error');
      }
    } finally {
      terapkanAkses(aksesData);
    }
  }

  // ---------- Rekap: file Excel dengan baris abu-abu muda jika selisih kasir vs verifikator != 0 ----------
  function loadScriptOnce(src) {
    return new Promise((resolve, reject) => {
      if (window.ExcelJS) return resolve();
      const el = document.createElement('script');
      el.src = src;
      el.onload = resolve;
      el.onerror = () => reject(new Error('Pustaka Excel gagal dimuat. Periksa koneksi internet.'));
      document.head.appendChild(el);
    });
  }

  async function buildRekapBuffer(rows, cabang) {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(('Rekap ' + cabang).slice(0, 31));
    ws.columns = [
      { header: 'produk_id', width: 16 },
      { header: 'nama_produk', width: 56 },
      { header: 'harga', width: 12 },
      { header: 'qty_kasir', width: 12 },
      { header: 'qty_verifikator', width: 16 },
      { header: 'selisih', width: 10 },
      { header: 'Kategori', width: 16 }
    ];
    ws.getRow(1).font = { bold: true };
    ws.views = [{ state: 'frozen', ySplit: 1 }];

    rows.forEach((p, i) => {
      const n = i + 2;
      const selisih = p.qty_kasir - p.qty_verifikator;           // kolom D dikurangi kolom E
      const harga = Number(p.harga);
      const row = ws.addRow([
        String(p.produk_id),
        p.nama_produk,
        isNaN(harga) ? p.harga : harga,
        p.qty_kasir,
        p.qty_verifikator,
        { formula: `D${n}-E${n}`, result: selisih },
        p.kategori || ''
      ]);
      if (selisih !== 0) {                                       // minus atau plus: kolom A-G abu-abu muda
        for (let c = 1; c <= 7; c++) {
          row.getCell(c).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9D9D9' } };
        }
      }
    });
    return wb.xlsx.writeBuffer();
  }

  async function downloadDataRekap() {
    if (isAdmin()) {
      // Admin: show modal to select branch and options
      showExportModal();
    } else {
      // Non-admin: export own branch directly
      await doExportRekap(currentUser.cabang);
    }
  }

  function showExportModal() {
    const modal = document.createElement('div');
    modal.className = 'modal';
    modal.style.cssText = 'display:flex;position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.5);align-items:center;justify-content:center;z-index:1000;';
    modal.innerHTML = `
      <div style="background:var(--card);padding:24px;border-radius:12px;width:90%;max-width:400px;">
        <h3 style="margin:0 0 16px;">📥 Ekspor Rekap</h3>
        <div style="margin-bottom:12px;">
          <label style="display:block;margin-bottom:4px;font-weight:500;">Pilih Sheet</label>
          <select id="exportSheetSelect" style="width:100%;padding:10px;border:1px solid var(--border);border-radius:8px;background:var(--bg);color:var(--text);">
            <option value="tes_input">Tes Input (Mode Uji)</option>
            <option value="kranggan">Kranggan</option>
            <option value="katedral">Katedral</option>
            <option value="santamaria">Santa Maria</option>
            <option value="athanasius">Athanasius</option>
            <option value="antonius">Antonius</option>
            <option value="paulus">Paulus</option>
          </select>
        </div>
        <div style="margin-bottom:12px;">
          <label style="display:block;margin-bottom:4px;font-weight:500;">Rentang Tanggal <span style="color:var(--text-muted);font-weight:normal;font-size:12px;">(perlu dukungan backend)</span></label>
          <div style="display:flex;gap:8px;">
            <input type="date" id="exportDateFrom" style="flex:1;padding:10px;border:1px solid var(--border);border-radius:8px;background:var(--bg);color:var(--text);">
            <input type="date" id="exportDateTo" style="flex:1;padding:10px;border:1px solid var(--border);border-radius:8px;background:var(--bg);color:var(--text);">
          </div>
        </div>
        <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:20px;">
          <button class="btn btn-secondary" onclick="this.closest('.modal').remove()">Batal</button>
          <button class="btn btn-primary" onclick="confirmExportRekap()">Ekspor</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
    // Set default date range (last 30 days)
    const today = new Date();
    const thirtyDaysAgo = new Date(today.getTime() - 30*24*60*60*1000);
    document.getElementById('exportDateTo').value = today.toISOString().slice(0,10);
    document.getElementById('exportDateFrom').value = thirtyDaysAgo.toISOString().slice(0,10);
  }

  window.confirmExportRekap = function() {
    const sheet = document.getElementById('exportSheetSelect').value;
    const dateFrom = document.getElementById('exportDateFrom').value;
    const dateTo = document.getElementById('exportDateTo').value;
    document.querySelector('.modal').remove();
    doExportRekap(sheet, dateFrom, dateTo);
  };

  async function doExportRekap(cabang, dateFrom, dateTo) {
    const btn = event?.target;
    if (btn) { btn.disabled = true; btn.innerText = 'Memproses...'; }

    try {
      const res = await api('rekap', { cabang });
      if (!res.data || res.data.length === 0) {
        return showModal("Informasi", `Belum ada data transaksi di Sheet ${cabang.toUpperCase()}`);
      }

      // Client-side date filtering (if backend adds timestamp support in future)
      let filteredData = res.data;
      if (dateFrom || dateTo) {
        // Note: Current backend doesn't return timestamps, so this is placeholder
        // When backend adds 'tanggal' field to rekap data, uncomment below:
        /*
        filteredData = res.data.filter(row => {
          if (!row.tanggal) return true;
          const rowDate = new Date(row.tanggal);
          if (dateFrom && rowDate < new Date(dateFrom)) return false;
          if (dateTo && rowDate > new Date(dateTo)) return false;
          return true;
        });
        */
        showModal("Info", "Filter tanggal belum didukung backend. Menampilkan semua data.");
      }

      await loadScriptOnce('vendor/exceljs.min.js');
      const buf = await buildRekapBuffer(filteredData, cabang.toUpperCase());
      const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      const dateSuffix = dateFrom && dateTo ? `_${dateFrom}_sd_${dateTo}` : `_${new Date().toISOString().slice(0,10)}`;
      a.download = `Rekap_Perbandingan_${cabang.toUpperCase()}${dateSuffix}.xlsx`;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
      hapticFeedback('success');
    } catch (err) {
      if (handleAuthError(err)) return;
      showModal("Gagal", "Gagal membuat rekap: " + err.message);
      hapticFeedback('error');
    } finally {
      if (btn) { btn.disabled = false; btn.innerText = 'Ekspor'; }
    }
  }

  function exportCSVFile(csvContentStr, fileName) {
    const blob = new Blob([csvContentStr], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement("a");
    const url = URL.createObjectURL(blob);
    link.setAttribute("href", url);
    link.setAttribute("download", fileName);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }

  function showModal(title, message) {
    document.getElementById('modalTitle').innerText = title;
    document.getElementById('modalMessage').innerText = message;
    openModal(document.getElementById('notifyModal'));
  }

  function closeNotifyModal() {
    closeModal(document.getElementById('notifyModal'));
  }

  const MIN_KODE_SEBAGIAN = 3;
  const MAKS_PILIHAN = 50;

  function cariManual(e) {
    e.preventDefault();
    const input = document.getElementById('barcodeInput');
    const raw = input.value.trim();
    if (!raw) return;
    cariFleksibel(raw);
    input.value = "";
  }

  // 1) kode persis  2) kode berakhiran yang diketik (23lb0001, lb0001)  3) kode memuat yang diketik
  function cariFleksibel(raw) {
    const key = raw.replace(/[\s-]/g, '').toUpperCase();
    const persis = productLookupMap[key];
    if (persis) return tampilkanProduk(persis);

    if (key.length < MIN_KODE_SEBAGIAN)
      return showModal("Kode Terlalu Pendek", `Ketik minimal ${MIN_KODE_SEBAGIAN} karakter terakhir dari kode produk, atau scan barcode-nya.`);

    let hasil = productList.filter(p => p.idU.endsWith(key));
    let mode = 'akhir';
    if (hasil.length === 0) {
      hasil = productList.filter(p => p.idU.includes(key));
      mode = 'sebagian';
    }
    if (hasil.length === 0) return produkTidakDitemukan(raw);
    if (hasil.length === 1) return tampilkanProduk(hasil[0].item);

    hasil.sort((x, y) => (x.idU < y.idU ? -1 : x.idU > y.idU ? 1 : 0));
    bukaPilihProduk(raw, key, hasil, mode);
  }

  function bukaPilihProduk(raw, key, hasil, mode) {
    const list = document.getElementById('pilihList');
    list.textContent = '';
    list.classList.add('stagger-list'); // Add staggered animation
    let sub = `${hasil.length} produk cocok dengan “${raw}”`;
    if (mode === 'sebagian') sub += ' (dicari di bagian mana pun dari kode)';
    if (hasil.length > MAKS_PILIHAN) sub += ` · menampilkan ${MAKS_PILIHAN} pertama, ketik kode lebih lengkap untuk mempersempit`;
    document.getElementById('pilihSub').textContent = sub;

    hasil.slice(0, MAKS_PILIHAN).forEach(p => {
      const kode = String(p.item.produk_id).trim();
      const i = mode === 'akhir' ? kode.length - key.length : p.idU.indexOf(key);

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'pick-item';
      btn.onclick = () => { tutupPilihProduk(); tampilkanProduk(p.item); };

      const main = document.createElement('div'); main.className = 'pick-main';
      const kd = document.createElement('div'); kd.className = 'pick-kode';
      const hit = document.createElement('mark'); hit.textContent = kode.substr(i, key.length);
      kd.append(kode.substr(0, i), hit, kode.substr(i + key.length));
      const nm = document.createElement('div'); nm.className = 'pick-nama'; nm.textContent = p.item.nama_produk;
      main.append(kd, nm);

      const hg = document.createElement('div'); hg.className = 'pick-harga';
      hg.textContent = 'Rp ' + (Number(p.item.harga) || 0).toLocaleString('id-ID');

      btn.append(main, hg);
      list.appendChild(btn);
    });
    openModal(document.getElementById('pilihModal'));
  }

  function tutupPilihProduk() { closeModal(document.getElementById('pilihModal')); }

  // ================= KAMERA / SCANNER =================
  let qrScanner = null;
  let isScanning = false;
  let lastScan = { code: '', time: 0 };

  function cameraErrorMessage(err) {
    const name = (err && err.name) || '';
    const msg = String(err && err.message ? err.message : err);
    if (!window.isSecureContext) return "Kamera hanya bisa dipakai lewat HTTPS.";
    if ((name === 'NotAllowedError' || /permission|denied/i.test(msg)) && window.self !== window.top)
      return "Google Apps Script memblokir kamera langsung untuk halaman yang tampil di dalam iframe (" + (name || msg) + "). Ini batasan Apps Script, bukan izin browser. Gunakan tombol 📸 Foto, atau scanner barcode Bluetooth/USB.";
    if (name === 'NotAllowedError' || /permission|denied/i.test(msg))
      return "Akses kamera diblokir (" + (name || msg) + "). Izinkan kamera untuk situs ini di pengaturan browser, dan buka aplikasi lewat Chrome/Safari (bukan browser di dalam WhatsApp/Instagram). Jika tetap gagal, pakai tombol 📸 Foto.";
    if (name === 'NotFoundError' || /requested device not found/i.test(msg))
      return "Kamera tidak ditemukan di perangkat ini.";
    if (name === 'NotReadableError' || /could not start video/i.test(msg))
      return "Kamera sedang dipakai aplikasi lain. Tutup aplikasi/tab lain yang memakai kamera, lalu coba lagi.";
    return "Kamera gagal dibuka: " + (name ? name + " - " : "") + msg;
  }

  function scannerOptions() {
    const F = Html5QrcodeSupportedFormats;
    return {
      formatsToSupport: [F.EAN_13, F.EAN_8, F.UPC_A, F.UPC_E, F.CODE_128, F.CODE_39, F.QR_CODE],
      experimentalFeatures: { useBarCodeDetectorIfSupported: true },
      verbose: false
    };
  }

  function onScanSuccess(decodedText) {
    const now = Date.now();
    if (decodedText === lastScan.code && now - lastScan.time < 2000) return;
    lastScan = { code: decodedText, time: now };
    if (navigator.vibrate) navigator.vibrate(60);
    try { qrScanner.pause(true); } catch (e) {}
    lookupProduct(decodedText);
    if (!activeItem) setTimeout(resumeScanner, 1500);
  }

  function resumeScanner() {
    if (qrScanner && isScanning) {
      try { qrScanner.resume(); } catch (e) {}
    }
  }

  async function startScanner() {
    if (typeof Html5Qrcode === 'undefined')
      return showModal("Scanner Belum Siap", "Library scanner belum termuat. Periksa koneksi internet lalu muat ulang halaman.");
    if (isScanning) return resumeScanner();

    const hint = document.getElementById('scannerHint');
    const controls = document.querySelector('.scanner-controls');
    const startBtn = document.getElementById('btnStartScanner');
    const stopBtn = document.getElementById('btnStopScanner');
    const scanFrame = document.getElementById('scanFrame');

    if (hint) hint.style.display = 'none';
    if (controls) controls.style.display = 'flex';
    if (startBtn) startBtn.style.display = 'none';
    if (stopBtn) stopBtn.style.display = 'inline-flex';
    if (scanFrame) scanFrame.style.display = 'block';
    const readerEl = document.getElementById('reader');
    if (readerEl) readerEl.style.display = 'block';

    try {
      if (!qrScanner) qrScanner = new Html5Qrcode("reader", scannerOptions());
      await qrScanner.start(
        { facingMode: "environment" },
        {
          fps: 10,
          qrbox: (vw, vh) => {
            const w = Math.floor(Math.min(vw, 360) * 0.85);
            return { width: w, height: Math.floor(w * 0.55) };
          }
        },
        onScanSuccess,
        () => {}
      );
      isScanning = true;
      hapticFeedback('medium');
    } catch (err) {
      isScanning = false;
      if (hint) hint.style.display = 'block';
      if (controls) controls.style.display = 'none';
      if (startBtn) startBtn.style.display = 'inline-flex';
      if (stopBtn) stopBtn.style.display = 'none';
      if (scanFrame) scanFrame.style.display = 'none';
      const readerEl = document.getElementById('reader');
      if (readerEl) readerEl.style.display = 'none';
      showModal("Kamera Tidak Bisa Dibuka", cameraErrorMessage(err));
      hapticFeedback('error');
    }
  } // end startScanner

  async function stopScanner() {
    const hint = document.getElementById('scannerHint');
    const controls = document.querySelector('.scanner-controls');
    const startBtn = document.getElementById('btnStartScanner');
    const stopBtn = document.getElementById('btnStopScanner');
    const scanFrame = document.getElementById('scanFrame');

    try {
      if (qrScanner) {
        if (isScanning) await qrScanner.stop();
        qrScanner.clear();
      }
    } catch (e) {}
    qrScanner = null;
    isScanning = false;

    if (hint) hint.style.display = 'block';
    if (controls) controls.style.display = 'none';
    if (startBtn) startBtn.style.display = 'inline-flex';
    if (stopBtn) stopBtn.style.display = 'none';
    if (scanFrame) scanFrame.style.display = 'none';
    const readerEl = document.getElementById('reader');
    if (readerEl) readerEl.style.display = 'none';

    hapticFeedback('light');
  }

  async function scanFromPhoto(input) {
    const file = input.files && input.files[0];
    if (!file) return;
    try {
      if (typeof Html5Qrcode === 'undefined') throw new Error('Library scanner belum termuat');
      const tmp = new Html5Qrcode("reader-file", scannerOptions());
      const text = await tmp.scanFile(file, false);
      try { tmp.clear(); } catch (e) {}
      lookupProduct(text);
    } catch (err) {
      showModal("Barcode Tidak Terbaca", "Coba foto lagi dari jarak lebih dekat, pastikan barcode tajam, terang, dan memenuhi frame. Atau ketik kodenya manual.");
    }
    input.value = '';
  }

  const THEME_KEY = 'scanstock.theme';

  function applyTheme(theme) {
    const root = document.documentElement;
    const btn = document.getElementById('btnTheme');
    const meta = document.querySelector('meta[name="theme-color"]');
    if (theme === 'dark') {
      root.setAttribute('data-theme', 'dark');
      if (btn) btn.innerText = '☀️ Light';
      if (meta) meta.setAttribute('content', '#000000');
    } else {
      root.removeAttribute('data-theme');
      if (btn) btn.innerText = '🌙 Dark';
      if (meta) meta.setAttribute('content', '#DFDEDC');
    }
  }

  function toggleTheme() {
    const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    try { localStorage.setItem(THEME_KEY, next); } catch (e) {}
  }


  // ================= NOTIFIKASI SELISIH (polling) =================
  const POLL_MS = Math.max(5, getConfig().POLL_SECONDS) * 1000;
  let notif = { count: 0, items: [], menunggu: 0, updated: null };
  let notifSeen = false;       // sudah pernah menerima data dari server (untuk membedakan muatan awal)
  let pollTimer = null, polling = false, pollAgain = false;
  let reconItem = null, reconBusy = false;

  const rupiah = n => 'Rp ' + (Number(n) || 0).toLocaleString('id-ID');
  const bellAllowed = () => !!currentUser && (currentUser.role === 'KASIR' || currentUser.role === 'VERIFIKATOR' || currentUser.role === 'ADMIN');

  function startPolling() {
    stopPolling();
    if (!bellAllowed()) return;
    document.getElementById('btnBell').style.display = 'inline-flex';
    pollNotif(true);
    pollTimer = setInterval(() => pollNotif(false), POLL_MS);
  }

  function stopPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
  }

  function resetNotif() {
    stopPolling();
    notif = { count: 0, items: [], menunggu: 0, updated: null };
    notifSeen = false;
    reconItem = null;
    ['notifPanel', 'reconModal', 'confirmModal', 'pilihModal', 'jadwalModal', 'sndModal', 'qrModal'].forEach(id => document.getElementById(id).style.display = 'none');
    const bell = document.getElementById('btnBell');
    bell.style.display = 'none';
    bell.classList.remove('has-alert', 'ring');
    document.getElementById('bellBadge').style.display = 'none';
  }

  async function pollNotif(force) {
    if (!bellAllowed()) return;
    if (!force && document.hidden) return;        // tab tidak terlihat: hemat kuota server
    if (polling) { pollAgain = true; return; }
    polling = true;
    try {
      const res = await api('notif');
      applyNotif(res);
    } catch (err) {
      if (err.code === 'AUTH') handleAuthError(err);  // gangguan jaringan: diam, coba lagi di siklus berikutnya
    } finally {
      polling = false;
      if (pollAgain) { pollAgain = false; pollNotif(true); }
    }
  }

  function applyNotif(res) {
    const prev = notif.count;
    notif = { count: res.count || 0, items: res.items || [], menunggu: res.menunggu || 0, updated: new Date() };
    aksesData = res.akses || null;
    terapkanAkses(aksesData);
    renderBell(prev);
    if (document.getElementById('notifPanel').style.display === 'flex') renderNotifList();
    segarkanRecon();
  }

  function renderBell(prev) {
    const bell = document.getElementById('btnBell');
    const badge = document.getElementById('bellBadge');
    bell.classList.toggle('has-alert', notif.count > 0);
    bell.title = notif.count > 0 ? `${notif.count} produk selisih` : 'Tidak ada selisih';
    bell.setAttribute('aria-label', bell.title);

    if (notif.count > 0) {
      const teks = notif.count > 99 ? '99+' : String(notif.count);
      if (badge.innerText !== teks) {
        badge.innerText = teks;
        badge.classList.remove('bump'); void badge.offsetWidth; badge.classList.add('bump');
      }
      badge.style.display = 'block';
    } else {
      badge.style.display = 'none';
    }

    // Lonceng berdentang saat ada selisih BARU (atau selisih sudah ada ketika pertama kali dibuka)
    if (notif.count > prev || (!notifSeen && notif.count > 0)) ringBell();
    notifSeen = true;
  }

  function ringBell() {
    const bell = document.getElementById('btnBell');
    bell.classList.remove('ring'); void bell.offsetWidth; bell.classList.add('ring');
    setTimeout(() => bell.classList.remove('ring'), 2400);
  }

  function jamLabel(ms) {
    const d = new Date(ms);
    const jam = d.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' }).replace('.', ':');
    const hariIni = new Date().toDateString() === d.toDateString();
    const tgl = hariIni ? '' : d.toLocaleDateString('id-ID', { day: '2-digit', month: '2-digit' }) + ' ';
    const mnt = Math.max(0, Math.round((Date.now() - ms) / 60000));
    const lalu = mnt < 1 ? 'baru saja' : mnt < 60 ? `${mnt} mnt lalu` : `${Math.floor(mnt / 60)} j ${mnt % 60} mnt lalu`;
    return `${tgl}${jam} · ${lalu}`;
  }

  function openNotifPanel() {
    openModal(document.getElementById('notifPanel'));
    renderNotifList();
    pollNotif(true);
    hapticFeedback('light');
  }

  function closeNotifPanel() {
    closeModal(document.getElementById('notifPanel'));
    hapticFeedback('light');
  }

  async function refreshNotif() {
    const b = document.getElementById('btnRefreshNotif');
    b.disabled = true;
    await pollNotif(true);
    setTimeout(() => { b.disabled = false; }, 600);
  }

  function renderNotifList() {
    const list = document.getElementById('notifList');
    list.textContent = '';
    list.classList.add('stagger-list'); // Add staggered animation
    const cab = labelSheet();
    const upd = notif.updated ? notif.updated.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).replace(/\./g, ':') : '-';
    document.getElementById('notifSub').textContent =
      `${isAdmin() ? 'Sheet' : 'Cabang'} ${cab}${isAdmin() ? ' (mode uji, peran ' + namaPeran(peranUji) + ')' : ''} · diperbarui ${upd} · urut dari selisih terlama · cek otomatis tiap ${Math.round(POLL_MS / 1000)} detik (POLL_SECONDS)`;

    if (notif.items.length === 0) {
      const e = document.createElement('div');
      e.className = 'notif-empty';
      e.textContent = 'Tidak ada selisih. Input kasir dan verifikator sudah sama untuk semua produk yang dicatat oleh keduanya.';
      list.appendChild(e);
    }
    notif.items.forEach((it, i) => {
      const diff = it.qty_kasir - it.qty_verifikator;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'notif-item';
      btn.onclick = () => openRecon(i);

      const no = document.createElement('div'); no.className = 'notif-no'; no.textContent = String(i + 1);
      const main = document.createElement('div'); main.className = 'notif-main';
      const nm = document.createElement('div'); nm.className = 'notif-name'; nm.textContent = it.nama_produk;
      const mt = document.createElement('div'); mt.className = 'notif-meta'; mt.textContent = `${it.produk_id} · sejak ${jamLabel(it.sejak)}`;
      main.append(nm, mt);
      const st = statusRekon(it);
      if (st.tag) {
        const tg = document.createElement('span');
        tg.className = 'notif-tag' + (st.kelas === 'warn' ? ' warn' : '');
        tg.textContent = st.tag;
        main.appendChild(tg);
      }
      const side = document.createElement('div'); side.className = 'notif-side';
      const kv = document.createElement('div'); kv.textContent = `K ${it.qty_kasir} · V ${it.qty_verifikator}`;
      const df = document.createElement('span'); df.className = 'notif-diff'; df.textContent = (diff > 0 ? '+' : '') + diff;
      side.append(kv, df);
      btn.append(no, main, side);
      list.appendChild(btn);
    });

    const wait = document.getElementById('notifWait');
    if (notif.menunggu > 0) {
      wait.style.display = 'block';
      wait.textContent = `${notif.menunggu} produk baru diinput oleh satu pihak saja (menunggu pasangannya). Belum dihitung sebagai selisih.`;
    } else {
      wait.style.display = 'none';
    }
  }

  // ---------- Status jadwal input (Kasir/Verifikator) ----------
  let aksesData = null, aksesTerbuka = true;

  function tglLabel(iso) {
    const [y, m, d] = String(iso).split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString('id-ID', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' });
  }

  function terapkanAkses(a) {
    const bar = document.getElementById('aksesBar');
    const btn = document.getElementById('btnSimpan');
    if (!a || isAdmin()) {
      aksesTerbuka = true;
      bar.classList.add('collapsed');
    } else {
      aksesTerbuka = !!a.terbuka;
      bar.classList.remove('collapsed');
      bar.className = 'akses-bar card animate-height' + (a.terbuka ? '' : ' tutup');
      if (a.terbuka) {
        bar.textContent = `Input DIBUKA hari ini (${tglLabel(a.hari_ini)}).`;
      } else {
        const next = (a.jadwal || []).find(x => x > a.hari_ini);
        bar.textContent = `Input DITUTUP hari ini (${tglLabel(a.hari_ini)}). ` + (next ? `Jadwal berikutnya: ${tglLabel(next)}.` : 'Belum ada jadwal input. Hubungi admin.');
      }
    }
    btn.disabled = !aksesTerbuka;
    btn.innerText = aksesTerbuka ? 'Simpan Input' : 'Input Ditutup';
  }

  // ---------- Input SnD: filter produk per supplier (khusus Kasir, hanya tampilan) ----------
  const SND_PER_HAL = 20;
  const SND_HINT = 'Ketik 2 karakter kode supplier, misalnya LB atau 00.';
  let sndData = { items: [], belum: 0, total_pcs: 0, kode2: '' };
  let sndHal = 1, sndSeq = 0;
  const sEl = id => document.getElementById(id);

  // State baru untuk kategori & metode
  let sndKlikSet = new Set();       // produk_id yang sudah diklik (ribbon)
  let sndKategoriTerpilih = null;   // 'KANISIUS' | 'NON_KANISIUS' | 'EKSTERNAL'
  let sndMetodeTerpilih = null;     // 'QR' | 'QR_JUMLAH'
  let sndProductMap = new Map();    // kode -> { produk_id, nama_produk, harga, jumlah }
  let inputKategoriTerpilih = null; // 'KANISIUS' | 'NON_KANISIUS' | 'EKSTERNAL' (dari form input qty)

  function tampilkanTombolSnd() {
    sEl('btnSnd').style.display = (currentUser && peranAktif() === 'KASIR') ? '' : 'none';
  }

  // Pilih kategori untuk form input qty (scan QR / ketik produk)
  function pilihKategoriInput(kat) {
    inputKategoriTerpilih = kat;
    // Visual feedback: highlight tombol yang dipilih
    const btns = document.querySelectorAll('#inputKategori button');
    btns.forEach(b => {
      const t = b.textContent.toUpperCase().trim();
      let match = false;
      if (kat === 'KANISIUS') match = (t === 'KANISIUS');
      else if (kat === 'NON_KANISIUS') match = (t === 'NON KANISIUS');
      else if (kat === 'EKSTERNAL') match = (t === 'EKSTERNAL');
      if (match) {
        b.style.background = 'var(--accent-line)';
        b.style.color = '#fff';
      } else {
        b.style.background = '';
        b.style.color = '';
      }
    });
  }

  function sndKosongkan(teks) {
    sEl('sndList').textContent = '';
    sEl('sndPageInfo').style.display = 'none';
    sEl('sndPager').style.display = 'none';
    sEl('sndSummary').textContent = teks;
  }

  function bukaSnd() {
    if (peranAktif() !== 'KASIR') return;
    sndSeq++;
    sEl('sndKode').value = '';
    // Sembunyikan input supplier & daftar, tampilkan 3 tombol kategori
    sEl('sndKode').style.display = 'none';
    sEl('sndKode').previousElementSibling.style.display = 'none'; // label
    sEl('sndSummary').style.display = 'none';
    sEl('sndList').style.display = 'none';
    sEl('sndPageInfo').style.display = 'none';
    sEl('sndPager').style.display = 'none';
    sEl('sndKategoriWrapper').style.display = 'block';
    openModal(sEl('sndModal'));
  }

  function tutupSnd() {
    sndSeq++;
    closeModal(sEl('sndModal'));
    // Reset state
    sndKategoriTerpilih = null;
    sndMetodeTerpilih = null;
    // sndKlikSet sengaja jangan dibersihkan di sini (ribbon tetap konsisten);
    sndProductMap.clear();
    // Sembunyikan kategori wrapper, tampilkan input supplier kembali
    sEl('sndKategoriWrapper').style.display = 'none';
    sEl('sndKode').style.display = '';
    sEl('sndKode').previousElementSibling.style.display = '';
    sEl('sndSummary').style.display = '';
    sEl('sndList').style.display = '';
  }

  function sndInput(inp) {
    inp.value = inp.value.replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 2);
    sndSeq++;                                         // batalkan permintaan yang masih berjalan
    if (inp.value.length < 2) return sndKosongkan(SND_HINT);
    muatSnd(inp.value);
  }

  // --- Fungsi baru untuk kategori & metode ---
  function pilihKategori(kat) {
    sndKategoriTerpilih = kat;
    sEl('sndMetodeKategori').textContent =
      kat === 'KANISIUS' ? 'Buku Kanisius' :
      kat === 'NON_KANISIUS' ? 'Buku Non Kanisius' : 'Eksternal';
    openModal(sEl('sndMetodeModal'));
  }

  function pilihMetode(metode) {
    sndMetodeTerpilih = metode;
    closeModal(sEl('sndMetodeModal'));

    if (sndKategoriTerpilih === 'KANISIUS') {
      // Buku Kanisius: otomatis muat daftar produk dari rekap (kasir=verifikator), sort asc
      muatSndKanisius();
    } else {
      // Non Kanisius & Eksternal: tampilkan input supplier dengan hint yang sesuai
      sEl('sndKode').style.display = '';
      sEl('sndKode').previousElementSibling.style.display = '';
      sEl('sndSummary').style.display = '';
      sEl('sndList').style.display = '';
      const katLabel = sndKategoriTerpilih === 'NON_KANISIUS' ? 'Buku Non Kanisius' : 'Eksternal';
      sEl('sndSummary').textContent = `${katLabel}: ketik 2 karakter kode supplier (karakter ke-5 & 6 kode produk).`;
      setTimeout(() => sEl('sndKode').focus(), 50);
    }
  }

  function tutupSndMetode() {
    closeModal(sEl('sndMetodeModal'));
    // Kembali ke tampilan kategori
  }

  // Muat data Buku Kanisius dari rekap (kasir = verifikator > 0), urutkan kode asc
  async function muatSndKanisius() {
    const my = ++sndSeq;
    sndKosongkan('Memuat Buku Kanisius...');
    try {
      const res = await api('rekap', {});
      if (my !== sndSeq) return;
      
      // Filter: produk dengan kategori KANISIUS dari kolom I sheet, dan jumlah valid > 0
      const kanisiusItems = (res.data || [])
        .filter(it => {
          return String(it.kategori || '').toUpperCase() === 'KANISIUS' && Number(it.qty_kasir) > 0;
        })
        .map(it => ({
          produk_id: String(it.produk_id).trim(),
          nama_produk: it.nama_produk,
          harga: it.harga,
          jumlah: Number(it.qty_kasir),
          status: 'COCOK'
        }))
        .sort((a, b) => String(a.produk_id).localeCompare(String(b.produk_id)));
      
      if (my !== sndSeq) return;
      
      sndData = { items: kanisiusItems, belum: 0, total_pcs: kanisiusItems.reduce((s, it) => s + it.jumlah, 0), kode2: 'KANISIUS' };
      sndHal = 1;
      sEl('sndSummary').style.display = '';
      sEl('sndList').style.display = '';
      renderSnd();
    } catch (err) {
      if (my !== sndSeq) return;
      if (handleAuthError(err)) return;
      sndKosongkan('Gagal memuat: ' + err.message);
    }
  }

  async function muatSnd(k2) {
    const my = ++sndSeq;
    const katLabel = sndKategoriTerpilih === 'NON_KANISIUS' ? 'Buku Non Kanisius' : 'Eksternal';
    sndKosongkan(`Memuat ${katLabel} supplier ${k2}...`);
    try {
      const res = await api('snd', { kode2: k2, verifOff: !pencocokanVerifAktif });
      if (my !== sndSeq) return;

      // Filter berdasarkan kategori dari data API (kolom I di sheet)
      let filteredItems = (res.items || []).filter(it => {
        return String(it.kategori || '').toUpperCase() === sndKategoriTerpilih;
      });

      if (my !== sndSeq) return;

      sndData = {
        items: filteredItems,
        belum: 0,
        total_pcs: filteredItems.reduce((s, it) => s + (Number(it.jumlah) || 0), 0),
        kode2: k2
      };
      sndHal = 1;
      renderSnd();
    } catch (err) {
      if (my !== sndSeq) return;
      if (handleAuthError(err)) return;
      sndKosongkan('Gagal memuat: ' + err.message);
    }
  }

  function renderSnd() {
    const items = sndData.items || [];
    const total = items.length, k2 = sndData.kode2;
    const fmt = n => (Number(n) || 0).toLocaleString('id-ID');
    const belum = sndData.belum ? ` · ${fmt(sndData.belum)} produk lain belum valid (masih selisih atau menunggu pasangan)` : '';
    const list = sEl('sndList');
    list.textContent = '';
    list.classList.add('stagger-list'); // Add staggered animation
    sndProductMap.clear();

    if (total === 0) {
      sEl('sndSummary').textContent = `Supplier ${k2}: belum ada produk dengan jumlah valid${belum}.`;
      sEl('sndPageInfo').style.display = 'none';
      sEl('sndPager').style.display = 'none';
      return;
    }
    sEl('sndSummary').textContent = `Supplier ${k2}: ${fmt(total)} produk valid · total ${fmt(sndData.total_pcs)} Pcs${belum}`;

    const pages = Math.ceil(total / SND_PER_HAL);
    sndHal = Math.min(Math.max(sndHal, 1), pages);
    const awal = (sndHal - 1) * SND_PER_HAL;
    items.slice(awal, awal + SND_PER_HAL).forEach(it => {
      const kode = String(it.produk_id).trim();
      // Simpan ke map untuk lookup jumlah saat QR_JUMLAH
      sndProductMap.set(kode, { produk_id: kode, nama_produk: it.nama_produk, harga: it.harga, jumlah: it.jumlah });

      const row = document.createElement('div'); row.className = 'snd-item klik';
      row.tabIndex = 0;
      row.setAttribute('role', 'button');
      row.setAttribute('aria-label', 'Tampilkan QR kode produk ' + kode);
      const format = sndMetodeTerpilih === 'QR_JUMLAH' ? 'QR_JUMLAH' : 'QR';
      row.onclick = () => bukaQr(kode, format);
      row.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); bukaQr(kode, format); } };
      
      const main = document.createElement('div'); main.className = 'snd-main';
      const kd = document.createElement('div'); kd.className = 'snd-kode';
      const hit = document.createElement('mark'); hit.textContent = kode.substr(4, 2);
      kd.append(kode.substr(0, 4), hit, kode.substr(6));
      const nm = document.createElement('div'); nm.className = 'snd-nama'; nm.textContent = it.nama_produk;
      const tg = document.createElement('span'); tg.className = 'notif-tag'; tg.textContent = it.status === 'REKONSILIASI' ? 'Hasil pencocokan' : 'Cocok';
      main.append(kd, nm, tg);

      const side = document.createElement('div'); side.className = 'snd-side';
      const q = document.createElement('div'); q.className = 'snd-qty';
      const sm = document.createElement('small'); sm.textContent = ' Pcs';
      q.append(fmt(it.jumlah), sm);
      const hg = document.createElement('div'); hg.className = 'snd-harga';
      hg.textContent = Number(it.harga) > 0 ? 'Rp ' + fmt(it.harga) : '–';
      side.append(q, hg);

      // Ribbon indikator sudah diklik
      const ribbon = document.createElement('div');
      ribbon.className = 'snd-ribbon';
      ribbon.id = 'sndRibbon-' + kode.replace(/[^A-Za-z0-9]/g, '_');
      ribbon.textContent = '✓';
      ribbon.style.display = sndKlikSet.has(kode) ? 'flex' : 'none';
      row.appendChild(ribbon);

      row.append(main, side);
      list.appendChild(row);
    });
    list.scrollTop = 0;

    const dari = awal + 1, sampai = Math.min(awal + SND_PER_HAL, total);
    const info = sEl('sndPageInfo');
    info.textContent = `Menampilkan ${dari}–${sampai} dari ${fmt(total)} · Halaman ${sndHal} dari ${pages}`;
    info.style.display = 'block';
    sEl('sndPager').style.display = 'flex';
    sEl('sndPrev').disabled = sndHal <= 1;
    sEl('sndNext').disabled = sndHal >= pages;
  }

  function sndHalaman(delta) { sndHal += delta; renderSnd(); }

  // ---------- QR kode produk (hanya QR; ketuk area kosong untuk menutup) ----------
  let qrDibukaPada = 0;

  // QR dibuat sebagai SVG: tajam di ukuran berapa pun, hitam di atas putih, dengan zona tenang 4 modul
  function buatQrSvg(teks) {
    if (typeof qrcode === 'undefined') throw new Error('Pustaka QR belum termuat. Muat ulang halaman.');
    qrcode.stringToBytes = qrcode.stringToBytesFuncs['UTF-8'] || qrcode.stringToBytes;
    const qr = qrcode(0, 'Q');            // versi otomatis, koreksi kesalahan Q (25%) agar tahan silau
    qr.addData(teks);
    qr.make();
    const n = qr.getModuleCount(), tepi = 4, sisi = n + tepi * 2;
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${sisi} ${sisi}`);
    svg.setAttribute('shape-rendering', 'crispEdges');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', 'QR kode produk ' + teks);
    const bg = document.createElementNS(NS, 'rect');
    bg.setAttribute('width', sisi); bg.setAttribute('height', sisi); bg.setAttribute('fill', '#FFFFFF');
    let d = '';
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        if (!qr.isDark(r, c)) continue;
        let len = 1;
        while (c + len < n && qr.isDark(r, c + len)) len++;
        d += `M${c + tepi} ${r + tepi}h${len}v1h-${len}z`;
        c += len - 1;
      }
    }
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', d); path.setAttribute('fill', '#000000');
    svg.append(bg, path);
    return svg;
  }

  function bukaQr(kode, format = 'QR', withEnter = true) {
    // Tandai produk sebagai sudah diklik
    sndKlikSet.add(kode);
    const ribbon = document.getElementById('sndRibbon-' + kode.replace(/[^A-Za-z0-9]/g, '_'));
    if (ribbon) ribbon.style.display = 'flex';

    // Tentukan isi QR berdasarkan format
    let qrContent = kode;
    if (format === 'QR_JUMLAH') {
      const prod = sndProductMap.get(kode);
      if (prod && prod.jumlah > 0) {
        qrContent = `${kode}|${prod.jumlah}`;
      }
    }

    // Akhiri data QR dengan perintah Enter (Carriage Return) agar saat discan
    // scanner langsung menekan Enter (pindah ke kolom/baris berikutnya otomatis).
    if (withEnter) qrContent += '\r';

    const box = document.getElementById('qrBox');
    box.textContent = '';
    try {
      box.appendChild(buatQrSvg(qrContent));
    } catch (err) {
      return showModal("QR Gagal Dibuat", err.message);
    }
    qrDibukaPada = Date.now();
    openModal(document.getElementById('qrModal'));
  }

  function tutupQr() {
    closeModal(document.getElementById('qrModal'));
    document.getElementById('qrBox').textContent = '';

    // Tutup QR saja. JANGAN panggil tutupSnd() karena itu akan menghapus sndKlikSet (ribbon).
    // Kembali ke tampilan kategori agar ribbon tetap konsisten di semua kategori.
    // Untuk produk tunggal: user bisa klik "Tutup" di SnD jika ingin keluar sepenuhnya.
    kembaliKeKategori();
  }

  function kembaliKeKategori() {
    sEl('sndKode').style.display = 'none';
    sEl('sndKode').previousElementSibling.style.display = 'none';
    sEl('sndSummary').style.display = 'none';
    sEl('sndList').style.display = 'none';
    sEl('sndPageInfo').style.display = 'none';
    sEl('sndPager').style.display = 'none';
    sEl('sndKategoriWrapper').style.display = 'block';
    sndKategoriTerpilih = null;
    sndMetodeTerpilih = null;
  }

  // Hanya klik pada AREA KOSONG (latar gelap) yang menutup; mengetuk QR-nya sendiri tidak menutup.
  function qrKlik(e) {
    if (e.target !== e.currentTarget) return;
    if (Date.now() - qrDibukaPada < 250) return;      // abaikan ketukan ikutan saat baru dibuka
    tutupQr();
  }

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && document.getElementById('qrModal').style.display === 'flex') tutupQr();
  });

  // ---------- Jadwal input per cabang (admin) ----------
  const NAMA_CABANG = { kranggan: 'Kranggan', katedral: 'Katedral', santamaria: 'Santa Maria', athanasius: 'Athanasius', antonius: 'Antonius', paulus: 'Paulus' };
  let jadwal = {}, jadwalAsli = '{}', jadwalHariIni = '', jadwalPeringatan = false;
  const jEl = id => document.getElementById(id);

  function rentangTanggal(a, b) {
    const out = [];
    const [y1, m1, d1] = a.split('-').map(Number), [y2, m2, d2] = b.split('-').map(Number);
    for (let t = Date.UTC(y1, m1 - 1, d1), end = Date.UTC(y2, m2 - 1, d2); t <= end; t += 86400000) out.push(new Date(t).toISOString().slice(0, 10));
    return out;
  }

  async function bukaJadwal() {
    try {
      const res = await api('jadwal_get');
      jadwal = {};
      Object.keys(NAMA_CABANG).forEach(c => { jadwal[c] = ((res.jadwal[c] || {}).tanggal || []).slice(); });
      jadwalAsli = JSON.stringify(jadwal);
      jadwalHariIni = res.hari_ini;
      jadwalPeringatan = false;
      jEl('jadwalSub').textContent = `Kasir dan Verifikator hanya bisa input pada tanggal di bawah (waktu WIB). Cabang tanpa tanggal = input DITUTUP. Hari ini: ${tglLabel(jadwalHariIni)}. Mode uji admin (tes_input) tidak terkena jadwal.`;
      jEl('jadwalSub').classList.remove('jadwal-warn');
      jEl('jdMulai').value = ''; jEl('jdSelesai').value = '';
      jEl('jdCabList').textContent = '';
      Object.keys(NAMA_CABANG).forEach(c => {
        const lb = document.createElement('label'); lb.className = 'cab-check';
        const cb = document.createElement('input'); cb.type = 'checkbox'; cb.value = c; cb.id = 'jdc_' + c;
        lb.append(cb, NAMA_CABANG[c]);
        jEl('jdCabList').appendChild(lb);
      });
      renderJadwal();
      openModal(jEl('jadwalModal'));
    } catch (err) {
      if (handleAuthError(err)) return;
      showModal("Gagal Memuat Jadwal", err.message);
    }
  }

  function renderJadwal() {
    const list = jEl('jadwalList');
    list.textContent = '';
    const asli = JSON.parse(jadwalAsli);
    Object.keys(NAMA_CABANG).forEach(c => {
      const box = document.createElement('div'); box.className = 'jadwal-cab';
      const h = document.createElement('h4');
      const nm = document.createElement('span');
      nm.textContent = NAMA_CABANG[c] + (JSON.stringify(asli[c]) !== JSON.stringify(jadwal[c]) ? ' (belum disimpan)' : '');
      const buka = jadwal[c].indexOf(jadwalHariIni) >= 0;
      const st = document.createElement('span'); st.className = 'jadwal-hariini' + (buka ? '' : ' tutup'); st.textContent = buka ? 'Hari ini: BUKA' : 'Hari ini: TUTUP';
      h.append(nm, st);
      box.appendChild(h);
      if (jadwal[c].length === 0) {
        const e = document.createElement('div'); e.className = 'jadwal-kosong'; e.textContent = 'Belum ada tanggal. Input ditutup.';
        box.appendChild(e);
      } else {
        const chips = document.createElement('div'); chips.className = 'chips';
        jadwal[c].forEach(t => {
          const chip = document.createElement('span');
          chip.className = 'chip' + (t === jadwalHariIni ? ' hariini' : '') + (t < jadwalHariIni ? ' lewat' : '');
          chip.append(tglLabel(t));
          const x = document.createElement('button'); x.type = 'button'; x.textContent = '×'; x.setAttribute('aria-label', 'Hapus ' + tglLabel(t));
          x.onclick = () => { jadwal[c] = jadwal[c].filter(v => v !== t); renderJadwal(); };
          chip.appendChild(x);
          chips.appendChild(chip);
        });
        box.appendChild(chips);
      }
      list.appendChild(box);
    });
  }

  function tambahTanggalJadwal() {
    const a = jEl('jdMulai').value, b = jEl('jdSelesai').value || a;
    const cabs = Object.keys(NAMA_CABANG).filter(c => jEl('jdc_' + c).checked);
    if (!a) return showModal("Tanggal Belum Diisi", "Pilih tanggal mulai terlebih dulu.");
    if (b < a) return showModal("Rentang Tidak Valid", "Tanggal 'Sampai' tidak boleh sebelum tanggal 'Mulai'.");
    if (a < jadwalHariIni) return showModal("Tanggal Sudah Lewat", "Tanggal yang sudah lewat tidak bisa ditambahkan, karena input hanya dinilai pada hari berjalan.");
    const dates = rentangTanggal(a, b);
    if (dates.length > 31) return showModal("Rentang Terlalu Panjang", "Maksimal 31 hari sekali tambah.");
    if (cabs.length === 0) return showModal("Cabang Belum Dipilih", "Centang minimal satu cabang.");
    cabs.forEach(c => { jadwal[c] = Array.from(new Set(jadwal[c].concat(dates))).sort(); });
    jEl('jdMulai').value = ''; jEl('jdSelesai').value = '';
    renderJadwal();
  }

  async function simpanJadwal() {
    const btn = jEl('btnJadwalSimpan');
    btn.disabled = true; btn.innerText = 'Menyimpan...';
    try {
      const res = await api('jadwal_set', { jadwal: jadwal });
      Object.keys(NAMA_CABANG).forEach(c => { jadwal[c] = ((res.jadwal[c] || {}).tanggal || []).slice(); });
      jadwalAsli = JSON.stringify(jadwal);
      jadwalPeringatan = false;
      jEl('jadwalSub').classList.remove('jadwal-warn');
      renderJadwal();
      showModal("Jadwal Tersimpan", "Jadwal input per cabang sudah diperbarui dan langsung berlaku.");
    } catch (err) {
      if (handleAuthError(err)) return;
      showModal("Gagal Menyimpan Jadwal", err.message);
    } finally {
      btn.disabled = false; btn.innerText = 'Simpan Jadwal';
    }
  }

  function tutupJadwal() {
    if (JSON.stringify(jadwal) !== jadwalAsli && !jadwalPeringatan) {
      jadwalPeringatan = true;
      jEl('jadwalSub').textContent = 'Ada perubahan yang BELUM disimpan. Tekan Simpan Jadwal, atau tekan Tutup sekali lagi untuk membuang perubahan.';
      jEl('jadwalSub').classList.add('jadwal-warn');
      return;
    }
    closeModal(jEl('jadwalModal'));
  }

  // ---------- Toggle pencocokan verifikator (hanya admin) ----------

  async function togglePencocokanVerifikasi() {
    if (!isAdmin()) return;
    const akanNyalakan = !pencocokanVerifAktif;
    const pesan = akanNyalakan
      ? 'Yakin ingin mengaktifkan kembali pencocokan verifikator untuk semua cabang?'
      : 'Yakin ingin mematikan pencocokan verifikator untuk semua cabang? Fitur pencocokan kasir & verifikator akan dinonaktifkan.';
    if (!confirm(pesan)) return;
    try {
      await api('toggle_verif_set', { aktif: akanNyalakan });
      pencocokanVerifAktif = akanNyalakan;
      try { localStorage.setItem('scanstock.pencocokanVerif', akanNyalakan ? '1' : '0'); } catch (e) {}
      const btn = document.getElementById('btnTogglePencocokanVerif');
      if (btn) btn.textContent = pencocokanVerifAktif ? 'Matikan Pencocokan Verifikator' : 'Aktifkan Pencocokan Verifikator';
      terapkanTogglePencocokanVerif();
      updateBadgeVerifikasi();
      sinkronkanRoleVerifikator();
      hapticFeedback(akanNyalakan ? 'success' : 'warning');
    } catch (err) {
      showModal('Gagal', 'Tidak dapat menyimpan ke server: ' + err.message);
      hapticFeedback('error');
    }
  }

  function terapkanTogglePencocokanVerif() {
    const on = pencocokanVerifAktif;
    if (!on) {
      const bell = document.getElementById('btnBell');
      if (bell) bell.style.display = 'none';
      const notifPanel = document.getElementById('notifPanel');
      if (notifPanel && notifPanel.style.display === 'flex') closeModal(notifPanel);
      const reconModal = document.getElementById('reconModal');
      if (reconModal && reconModal.style.display === 'flex') closeModal(reconModal);
      reconItem = null;
    }
    // Saat ON: tidak paksa menampilkan bell, biarkan logika role/polling yang mengatur.
  }

  // ---------- Badge status verifikator (tampilkan di semua user) ----------
  function updateBadgeVerifikasi() {
    const el = document.getElementById('badgeVerifikasi');
    if (!el) return;
    if (pencocokanVerifAktif) {
      el.textContent = 'Verif: AKTIF';
      el.className = 'badge-verif aktif';
      el.title = 'Pencocokan verifikator AKTIF untuk semua cabang';
    } else {
      el.textContent = 'Verif: NONAKTIF';
      el.className = 'badge-verif nonaktif';
      el.title = 'Pencocokan verifikator NONAKTIF untuk semua cabang';
    }
  }

  // Sinkronkan enable/disable radio Verifikator berdasarkan status toggle
  function sinkronkanRoleVerifikator() {
    const rb = document.getElementById('roleVerifikator');
    const lbl = rb ? rb.parentElement : null;
    if (!rb) return;
    if (!pencocokanVerifAktif) {
      rb.disabled = true;
      rb.checked = false;
      const rbKasir = document.getElementById('roleKasir');
      if (rbKasir) rbKasir.checked = true;
      if (lbl) lbl.classList.add('disabled');
    } else {
      rb.disabled = false;
      if (lbl) lbl.classList.remove('disabled');
    }
  }

  // Ambil status toggle verifikator dari server (global semua cabang)
  async function fetchToggleVerifikasi() {
    try {
      const res = await api('toggle_verif_get', {});
      pencocokanVerifAktif = res.aktif !== false;
      try { localStorage.setItem('scanstock.pencocokanVerif', pencocokanVerifAktif ? '1' : '0'); } catch (e) {}
      const btn = document.getElementById('btnTogglePencocokanVerif');
      if (btn) btn.textContent = pencocokanVerifAktif ? 'Matikan Pencocokan Verifikator' : 'Aktifkan Pencocokan Verifikator';
      updateBadgeVerifikasi();
      sinkronkanRoleVerifikator();
    } catch (e) {
      // gagal fetch, pakai default true
      updateBadgeVerifikasi();
      sinkronkanRoleVerifikator();
    }
  }

  // ---------- Pencocokan (dua pihak harus sepakat) ----------
  const namaPeran = r => (r === 'KASIR' ? 'Kasir' : 'Verifikator');
  const peranLain = () => (peranAktif() === 'KASIR' ? 'VERIFIKATOR' : 'KASIR');

  function statusRekon(it) {
    const saya = peranAktif(), lain = peranLain(), aj = it.ajukan || {};
    if (aj[saya]) return { kelas: 'wait', tag: `Menunggu ${namaPeran(lain)}`,
      teks: `Anda sudah mengajukan. Menunggu ${namaPeran(lain)} mengisi nilai yang sama. Anda boleh mengirim ulang untuk mengubah nilai Anda.` };
    if (aj[lain]) return { kelas: '', tag: `${namaPeran(lain)} sudah mengajukan`,
      teks: `${namaPeran(lain)} sudah mengajukan nilai. Isi nilai yang Anda sepakati. Jika sama, data di sheet langsung diperbarui.` };
    if (it.tidak_cocok) return { kelas: 'warn', tag: 'Tidak cocok, isi ulang',
      teks: `Pengajuan terakhir tidak sama (${jamLabel(it.tidak_cocok).split(' · ')[0]}). Kedua pengajuan dibatalkan. Diskusikan, lalu kedua pihak mengisi ulang.` };
    return { kelas: '', tag: '', teks: 'Belum ada pengajuan. Diskusikan nilainya, lalu kedua pihak mengisi nilai yang sama.' };
  }

  function tampilkanStatusRecon() {
    const st = statusRekon(reconItem);
    const el = document.getElementById('reconStatus');
    el.className = 'recon-status' + (st.kelas ? ' ' + st.kelas : '');
    el.textContent = st.teks;
  }

  // Dipanggil tiap polling: perbarui status di modal yang sedang terbuka, atau tutup jika selisih sudah selesai
  function segarkanRecon() {
    if (!reconItem || reconBusy || document.getElementById('reconModal').style.display !== 'flex') return;
    const baru = notif.items.find(x => x.produk_id === reconItem.produk_id);
    if (!baru) {
      document.getElementById('reconModal').style.display = 'none';
      document.getElementById('confirmModal').style.display = 'none';
      reconItem = null;
      return showModal("Selisih Sudah Selesai", "Produk ini sudah tidak selisih. Kemungkinan pencocokan sudah selesai atau nilainya berubah.");
    }
    if (baru.qty_kasir !== reconItem.qty_kasir || baru.qty_verifikator !== reconItem.qty_verifikator) {
      document.getElementById('reconModal').style.display = 'none';
      document.getElementById('confirmModal').style.display = 'none';
      reconItem = null;
      return showModal("Data Sudah Berubah", "Nilai kasir atau verifikator untuk produk ini baru saja berubah. Buka ulang dari daftar notifikasi.");
    }
    reconItem = baru;
    tampilkanStatusRecon();
  }

  function openRecon(i) {
    if (!pencocokanVerifAktif) return showModal("Pencocokan Dinonaktifkan", "Pencocokan verifikator sedang dimatikan oleh admin. Aktifkan kembali melalui panel admin.");
    const it = notif.items[i];
    if (!it) return;
    reconItem = it;
    document.getElementById('reconKode').textContent = it.produk_id;
    document.getElementById('reconNama').textContent = it.nama_produk;
    document.getElementById('reconHarga').textContent = rupiah(it.harga);
    document.getElementById('reconKasir').textContent = it.qty_kasir + ' Pcs';
    document.getElementById('reconVerif').textContent = it.qty_verifikator + ' Pcs';
    document.getElementById('reconNilai').value = '';
    tampilkanStatusRecon();
    openModal(document.getElementById('reconModal'));
    setTimeout(() => document.getElementById('reconNilai').focus(), 50);
    hapticFeedback('light');
  }

  function closeRecon() {
    if (reconBusy) return;
    closeModal(document.getElementById('reconModal'));
    reconItem = null;
    hapticFeedback('light');
  }

  function mintaKonfirmasiRecon() {
    if (!reconItem) return;
    if (!pencocokanVerifAktif) return showModal("Pencocokan Dinonaktifkan", "Pencocokan verifikator sedang dimatikan oleh admin.");
    if (!aksesTerbuka) return showModal("Input Ditutup", "Pencocokan juga dikunci di luar jadwal input cabang ini.");
    const raw = document.getElementById('reconNilai').value.trim();
    const n = Number(raw);
    if (raw === '' || !Number.isInteger(n) || n < 0 || n > 100000)
      return showModal("Nilai Belum Valid", "Isi nilai hasil pencocokan dengan bilangan bulat 0 atau lebih.");
    const lain = namaPeran(peranLain());
    const sudah = (reconItem.ajukan || {})[peranLain()];
    document.getElementById('confirmText').textContent =
      `Anda mengajukan nilai ${n} Pcs untuk "${reconItem.nama_produk}" sebagai nilai yang disepakati. ` +
      (sudah
        ? `${lain} sudah mengajukan. Jika nilainya sama, data di sheet langsung diperbarui dan menggantikan input kasir (${reconItem.qty_kasir}) serta verifikator (${reconItem.qty_verifikator}). Jika berbeda, kedua pengajuan dibatalkan dan harus diisi ulang.`
        : `Data di sheet baru diperbarui setelah ${lain} mengajukan nilai yang sama.`);
    openModal(document.getElementById('confirmModal'));
    hapticFeedback('medium');
  }

  function tutupKonfirmasi() {
    if (reconBusy) return;
    closeModal(document.getElementById('confirmModal'));
    hapticFeedback('light');
  }

  async function simpanRecon() {
    if (!reconItem || reconBusy) return;
    if (!pencocokanVerifAktif) return showModal("Pencocokan Dinonaktifkan", "Pencocokan verifikator sedang dimatikan oleh admin.");
    const nilai = Number(document.getElementById('reconNilai').value);
    const it = reconItem;
    const yes = document.getElementById('btnReconYa');
    reconBusy = true; yes.disabled = true; yes.innerText = 'Menyimpan...';
    try {
      const res = await api('rekonsiliasi', { produk_id: it.produk_id, nilai: nilai, lihat_kasir: it.qty_kasir, lihat_verifikator: it.qty_verifikator });
      reconBusy = false;
      closeModal(document.getElementById('confirmModal'));
      closeModal(document.getElementById('reconModal'));
      reconItem = null;
      const lain = namaPeran(peranLain());
      if (res.status === 'selesai') {
        showModal("Pencocokan Selesai", `${it.nama_produk}: nilai ${nilai} Pcs disepakati kedua pihak dan sudah diperbarui di sheet.`);
        hapticFeedback('success');
      } else if (res.status === 'menunggu') {
        showModal("Pengajuan Tersimpan", `Nilai ${nilai} Pcs tercatat sementara. Data di sheet BELUM berubah. Menunggu ${lain} mengajukan nilai yang sama.`);
        hapticFeedback('medium');
      } else if (res.status === 'beda') {
        showModal("Nilai Tidak Sama", `Nilai Anda tidak sama dengan pengajuan ${lain}. Kedua pengajuan dibatalkan dan data di sheet tidak berubah. Diskusikan, lalu kedua pihak mengisi ulang.`);
        hapticFeedback('warning');
      } else {
        showModal("Pengajuan Diproses", "Status pengajuan tidak dikenali. Muat ulang daftar notifikasi untuk melihat keadaan terbaru.");
        hapticFeedback('light');
      }
    } catch (err) {
      reconBusy = false;
      closeModal(document.getElementById('confirmModal'));
      if (handleAuthError(err)) return;
      if (err.code === 'STALE') {
        closeModal(document.getElementById('reconModal'));
        reconItem = null;
      }
      if (err.code === 'TUTUP') pollNotif(true);
      showModal(err.code === 'STALE' ? "Data Sudah Berubah" : err.code === 'TUTUP' ? "Input Ditutup" : "Gagal Menyimpan", err.message);
      hapticFeedback('error');
    } finally {
      reconBusy = false;
      yes.disabled = false; yes.innerText = 'Ya, Simpan';
      pollNotif(true);
    }
  }

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      pollNotif(true);
      syncOfflineQueue(); // Sync offline queue when app becomes visible
    }
  });

  // Online/offline detection
  window.addEventListener('online', () => {
    showOfflineIndicator(false);
    syncOfflineQueue();
    hapticFeedback('success');
  });
  window.addEventListener('offline', () => {
    showOfflineIndicator(true, 'Offline - Data akan disimpan lokal');
    hapticFeedback('warning');
  });

  // ---------- Mulai ----------
  (function init() {
    applyTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light');
    document.getElementById('dbStatus').innerText = "Silakan login untuk memuat data produk.";
    try {
      const saved = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null');
      if (saved && saved.token && saved.user) { session = saved; prosesMasuk(); }
    } catch (e) {}

    if ('serviceWorker' in navigator) {
      window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
    }

    // Initialize offline DB
    initOfflineDb().catch(() => {});

    // Initialize keyboard shortcuts & pull-to-refresh
    initKeyboardShortcuts();
    initPullToRefresh();

    // Update offline badge periodically
    updateOfflineBadge();
    setInterval(updateOfflineBadge, 5000);

    // Update verifikasi badge periodically (realtime)
    updateBadgeVerifikasi();
    setInterval(updateBadgeVerifikasi, 10000);

    // Ambil status toggle verifikator dari server (global semua cabang)
    fetchToggleVerifikasi();
  })();
