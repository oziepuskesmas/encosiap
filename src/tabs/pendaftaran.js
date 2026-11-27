import { addLogEntry, updateActiveLog, setActiveLogId, getHistory, getActiveLogId, deleteLogEntry } from "../services/historyService.js";
import { downloadTemplateFile } from "../services/templateService.js";
import { getAgeCategory, matchesPendaftaranStatus } from "../services/filterHelper.js";
import {
  syncPatientToCkgbankot,
  syncLogToCkgbankot,
  flushPendingPatientSync,
  fetchBotQueueFromCkgbankot,
  updateQueueStatusToCkgbankot
} from "../services/encoSyncService.js";
import {
  detectExcelMappingWithAI,
  sanitizeNik,
  sanitizeDate,
  sanitizeGender,
  sanitizeName,
  filterValidIdentityRows,
  formatSkippedIdentitySummary
} from "../services/aiService.js";

export function init({ konfigurasi } = {}) {
  let patients = [];
  let isRunning = false;
  let hasData = false;
  let selectedCategory = "UMUM";
  let selectedAgeFilter = "ALL";
  let selectedStatusFilter = "ALL";

  const TEMPLATE_URLS = {
    UMUM: "https://docs.google.com/spreadsheets/d/180hF_OePGBm29t1Jra0qbG6hWdKKBewnn4DzV4tbP3Y/edit?gid=0#gid=0",
    SEKOLAH: "https://docs.google.com/spreadsheets/d/1bhF0e5M25cqWda6HGyR4Afb-zayWst7e5IJcdltxdr8/edit?usp=sharing"
  };

  const TARGET_URLS = {
    UMUM: "https://sehatindonesiaku.kemkes.go.id/ckg-pendaftaran-individu",
    SEKOLAH: "https://sehatindonesiaku.kemkes.go.id/ckg-pendaftaran-anak-sekolah",
    KLASTER_2: "https://sehatindonesiaku.kemkes.go.id/ckg-pendaftaran-individu"
  };

  const emptyPlaceholder = document.getElementById("pendaftaran-empty");
  const listContainer = document.getElementById("pendaftaran-list");
  const countBadge = document.getElementById("pendaftaran-count");
  const patientsListEl = document.getElementById("pendaftaran-patients");
  const paginationContainerEl = document.getElementById("pendaftaran-pagination");
  const btnPrevPageEl = document.getElementById("btn-pendaftaran-prev-page");
  const btnNextPageEl = document.getElementById("btn-pendaftaran-next-page");
  const pageInfoEl = document.getElementById("pendaftaran-page-info");
  let currentPage = 1;
  const PAGE_SIZE = 50;
  const btnUploadExcel = document.getElementById("btn-upload-excel");
  const btnStartOtomasi = document.getElementById("btn-start-otomasi");
  const btnRestartError = document.getElementById("btn-restart-error");
  const btnStopOtomasi = document.getElementById("btn-stop-otomasi");
  const btnDownloadTemplate = document.getElementById("btn-download-template");
  const categoryFilter = document.getElementById("category-filter-pendaftaran");
  const ageFilterEl = document.getElementById("age-filter-pendaftaran");
  const statusFilterEl = document.getElementById("status-filter-pendaftaran");
  const filterRowEl = document.getElementById("pendaftaran-filter-row");
  const optionsRowEl = document.getElementById("pendaftaran-options-row");
  const skipKonfirmasiCheckbox = document.getElementById("check-lewati-konfirmasi-hadir");
  let skipKonfirmasiHadir = false;

  let pendaftaranMode = null; // "UMUM" | "SEKOLAH" | null
  const modeSelectionEl = document.getElementById("pendaftaran-mode-selection");
  const btnSelectUmum = document.getElementById("btn-select-pendaftaran-umum");
  const btnSelectSekolah = document.getElementById("btn-select-pendaftaran-sekolah");
  const activeBarEl = document.getElementById("pendaftaran-active-bar");
  const activeBadgeEl = document.getElementById("pendaftaran-active-badge");
  const activeSubEl = document.getElementById("pendaftaran-active-sub");
  const btnSwitchMode = document.getElementById("btn-switch-pendaftaran-mode");
  const mainContentEl = document.getElementById("pendaftaran-main-content");
  const pendaftaranFab = document.getElementById("pendaftaran-fab");

  // ── Session Selection Elements (Load Log Sesi vs Buat Sesi Baru) ──
  const sessionSelectionEl = document.getElementById("pendaftaran-session-selection");
  const sessionTargetTagEl = document.getElementById("pendaftaran-session-target-tag");
  const btnPendaftaranBackToMode = document.getElementById("btn-pendaftaran-back-to-mode");
  const cardLastSessionEl = document.getElementById("card-pendaftaran-last-session");
  const sessionTimeEl = document.getElementById("session-picker-time");
  const sessionFileNameEl = document.getElementById("session-picker-filename");
  const sessionStatDoneEl = document.getElementById("session-stat-done");
  const sessionStatWarningEl = document.getElementById("session-stat-warning");
  const sessionStatErrorEl = document.getElementById("session-stat-error");
  const sessionStatRemainingEl = document.getElementById("session-stat-remaining");
  const btnResumeSession = document.getElementById("btn-pendaftaran-resume-session");
  const btnNewSession = document.getElementById("btn-pendaftaran-new-session");
  const sectionOtherSessionsEl = document.getElementById("section-pendaftaran-other-sessions");
  const selectOlderSessionsEl = document.getElementById("select-pendaftaran-older-sessions");
  const btnLoadOlderSession = document.getElementById("btn-pendaftaran-load-older-session");
  const btnDeleteActiveSession = document.getElementById("btn-pendaftaran-delete-active-session");
  const btnDeleteOlderSession = document.getElementById("btn-pendaftaran-delete-older-session");
  const btnSwitchSession = document.getElementById("btn-switch-pendaftaran-session");

  let currentCategorySessions = [];
  let currentLatestSession = null;

  function escapeHtml(str) {
    if (!str) return "";
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  // ── 1. Buka Layar Pemilihan Sesi (Load Log) setelah Kategori dipilih ──
  async function showPendaftaranSessionPicker(category) {
    selectedCategory = category;
    chrome.storage.session.set({ "pendaftaran-category": category });
    if (categoryFilter) categoryFilter.value = category;
    updateCategoryClass(category);

    if (modeSelectionEl) modeSelectionEl.hidden = true;
    if (mainContentEl) mainContentEl.hidden = true;
    if (activeBarEl) activeBarEl.hidden = true;
    if (pendaftaranFab) pendaftaranFab.hidden = true;
    if (sessionSelectionEl) sessionSelectionEl.hidden = false;

    if (sessionTargetTagEl) {
      sessionTargetTagEl.textContent = category === "UMUM" ? "PENDAFTARAN UMUM" : "PENDAFTARAN SEKOLAH";
    }

    if (sessionFileNameEl) sessionFileNameEl.textContent = "Memuat sesi dari Cloud R2...";
    if (sessionTimeEl) sessionTimeEl.textContent = "Sinkronisasi...";
    if (btnResumeSession) {
      btnResumeSession.disabled = true;
      btnResumeSession.innerHTML = `<span class="spin">⏳</span> <span>Memuat Sesi dari Cloud...</span>`;
    }

    try {
      const history = await getHistory("pendaftaran");
      const matched = history.filter(h => !h.category || h.category.toUpperCase() === category.toUpperCase() || h.category.toUpperCase() === "ALL");
      currentCategorySessions = matched.length > 0 ? matched : history;

      if (currentCategorySessions.length > 0) {
        currentLatestSession = currentCategorySessions[0];
        const s = currentLatestSession;

        if (sessionFileNameEl) sessionFileNameEl.textContent = s.fileName || "Sesi Pendaftaran";
        if (sessionTimeEl) sessionTimeEl.textContent = s.dateStr || new Date(s.timestamp || Date.now()).toLocaleString("id-ID");

        const total = Number(s.total || 0);
        const berhasil = Number(s.berhasil || 0);
        const pernah = Number(s.pernahInput || 0);
        const gagal = Number(s.gagal || 0);
        const sisa = Math.max(0, total - berhasil - pernah - gagal);

        if (sessionStatDoneEl) sessionStatDoneEl.textContent = berhasil.toLocaleString("id-ID");
        if (sessionStatWarningEl) sessionStatWarningEl.textContent = pernah.toLocaleString("id-ID");
        if (sessionStatErrorEl) sessionStatErrorEl.textContent = gagal.toLocaleString("id-ID");
        if (sessionStatRemainingEl) sessionStatRemainingEl.textContent = `${sisa.toLocaleString("id-ID")} Pasien`;

        if (cardLastSessionEl) cardLastSessionEl.hidden = false;
        if (btnResumeSession) {
          btnResumeSession.disabled = false;
          btnResumeSession.innerHTML = `
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
            <span>LANJUTKAN SESI INI (${total.toLocaleString("id-ID")} PASIEN)</span>
          `;
        }

        // Dropdown Riwayat Sesi Lainnya (jika ada lebih dari 1 sesi)
        if (currentCategorySessions.length > 1 && selectOlderSessionsEl && sectionOtherSessionsEl) {
          sectionOtherSessionsEl.hidden = false;
          selectOlderSessionsEl.innerHTML = currentCategorySessions.slice(1).map((item, idx) => {
            const timeStr = item.dateStr || new Date(item.timestamp || Date.now()).toLocaleDateString("id-ID");
            const file = item.fileName || "Sesi";
            const tot = item.total ? `(${item.total} Pasien)` : "";
            return `<option value="${escapeHtml(item.id)}">${idx + 1}. ${escapeHtml(file)} - ${escapeHtml(timeStr)} ${tot}</option>`;
          }).join("");
        } else if (sectionOtherSessionsEl) {
          sectionOtherSessionsEl.hidden = true;
        }
      } else {
        currentLatestSession = null;
        if (sessionFileNameEl) sessionFileNameEl.textContent = "Belum Ada Sesi Tersimpan di Cloud";
        if (sessionTimeEl) sessionTimeEl.textContent = "-";
        if (sessionStatDoneEl) sessionStatDoneEl.textContent = "0";
        if (sessionStatWarningEl) sessionStatWarningEl.textContent = "0";
        if (sessionStatErrorEl) sessionStatErrorEl.textContent = "0";
        if (sessionStatRemainingEl) sessionStatRemainingEl.textContent = "0";
        if (cardLastSessionEl) cardLastSessionEl.hidden = true;
        if (sectionOtherSessionsEl) sectionOtherSessionsEl.hidden = true;
      }
    } catch (err) {
      console.warn("[Pendaftaran] Error loading sessions from Cloud:", err);
      if (sessionFileNameEl) sessionFileNameEl.textContent = "Gagal memuat sesi dari Cloud";
      if (btnResumeSession) {
        btnResumeSession.disabled = true;
        btnResumeSession.textContent = "Gagal Memuat Sesi";
      }
    }
  }

  // ── 2. Masuk ke Halaman Utama Antrean Pendaftaran ──
  function setPendaftaranMode(mode) {
    pendaftaranMode = mode;
    chrome.storage.session.set({ pendaftaranMode: mode });

    if (!mode) {
      if (modeSelectionEl) modeSelectionEl.hidden = false;
      if (sessionSelectionEl) sessionSelectionEl.hidden = true;
      if (mainContentEl) mainContentEl.hidden = true;
      if (activeBarEl) activeBarEl.hidden = true;
      if (pendaftaranFab) pendaftaranFab.hidden = true;
      return;
    }

    selectedCategory = mode;
    chrome.storage.session.set({ "pendaftaran-category": mode });
    if (categoryFilter) categoryFilter.value = mode;
    updateCategoryClass(mode);

    if (patients.length > 0) {
      patients.forEach(p => {
        p.category = mode;
      });
      savePatientsToSession();
    }

    if (modeSelectionEl) modeSelectionEl.hidden = true;
    if (sessionSelectionEl) sessionSelectionEl.hidden = true;
    if (mainContentEl) mainContentEl.hidden = false;
    if (activeBarEl) activeBarEl.hidden = false;

    const isPendaftaranActive = !document.getElementById("tab-pendaftaran")?.hidden;
    if (isPendaftaranActive && pendaftaranFab) {
      pendaftaranFab.hidden = false;
    }

    if (mode === "UMUM") {
      if (activeBadgeEl) {
        activeBadgeEl.className = "pelayanan-active-badge";
        activeBadgeEl.textContent = "KATEGORI: UMUM";
      }
      if (activeSubEl) activeSubEl.textContent = "Pendaftaran Individu";
    } else {
      if (activeBadgeEl) {
        activeBadgeEl.className = "pelayanan-active-badge pelayanan-active-badge--emerald";
        activeBadgeEl.textContent = "KATEGORI: SEKOLAH";
      }
      if (activeSubEl) activeSubEl.textContent = "Pendaftaran Siswa";
    }
  }

  // ── Event Listener Tombol Pilihan Sesi ──
  if (btnResumeSession) {
    btnResumeSession.addEventListener("click", async () => {
      if (!currentLatestSession) return;
      btnResumeSession.disabled = true;
      btnResumeSession.innerHTML = `<span class="spin">⏳</span> <span>Mengunduh data antrean dari Cloud R2...</span>`;
      try {
        const success = await resumeFromLogEntry(currentLatestSession);
        if (success) {
          setPendaftaranMode(selectedCategory || "UMUM");
        } else {
          alert("Gagal memuat data sesi dari Cloud R2. Silakan coba lagi.");
        }
      } finally {
        btnResumeSession.disabled = false;
        btnResumeSession.innerHTML = `
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
          <span>LANJUTKAN SESI INI</span>
        `;
      }
    });
  }

  if (btnNewSession) {
    btnNewSession.addEventListener("click", async () => {
      // Buat Sesi Baru: bersihkan antrean sebelumnya
      patients = [];
      await chrome.storage.session.remove(["pendaftaranPatients", "pendaftaranQueue", "pendaftaranRunning"]);
      await chrome.storage.local.remove(["pendaftaranPatients", "pendaftaranQueue"]);
      await setActiveLogId("pendaftaran", "none");
      renderPatients();
      setHasDataState(false);
      setPendaftaranMode(selectedCategory || "UMUM");
    });
  }

  if (btnLoadOlderSession) {
    btnLoadOlderSession.addEventListener("click", async () => {
      const selectedId = selectOlderSessionsEl?.value;
      if (!selectedId) return;
      const target = currentCategorySessions.find(s => s.id === selectedId);
      if (!target) return;
      btnLoadOlderSession.disabled = true;
      btnLoadOlderSession.textContent = "Memuat...";
      try {
        const success = await resumeFromLogEntry(target);
        if (success) {
          setPendaftaranMode(selectedCategory || "UMUM");
        } else {
          alert("Gagal memuat sesi riwayat dari Cloud R2.");
        }
      } finally {
        btnLoadOlderSession.disabled = false;
        btnLoadOlderSession.textContent = "Muat Sesi";
      }
    });
  }

  // ── Hapus Sesi Aktif dari Cloud R2 & Database D1 ──
  if (btnDeleteActiveSession) {
    btnDeleteActiveSession.addEventListener("click", async () => {
      if (!currentLatestSession?.id) return;
      const fileName = currentLatestSession.fileName || "Sesi Pendaftaran";
      if (!confirm(`Hapus sesi "${fileName}" secara permanen dari Cloud R2 & Database?`)) return;

      btnDeleteActiveSession.disabled = true;
      try {
        await deleteLogEntry("pendaftaran", currentLatestSession.id);
        patients = [];
        await chrome.storage.session.remove(["pendaftaranPatients", "pendaftaranQueue", "pendaftaranRunning"]);
        await chrome.storage.local.remove(["pendaftaranPatients", "pendaftaranQueue"]);
        renderPatients();
        setHasDataState(false);
        await showPendaftaranSessionPicker(selectedCategory || "UMUM");
      } catch (err) {
        console.error("[Pendaftaran] Gagal hapus sesi aktif:", err);
        alert("Gagal menghapus sesi: " + (err.message || err));
      } finally {
        if (btnDeleteActiveSession) btnDeleteActiveSession.disabled = false;
      }
    });
  }

  // ── Hapus Sesi Riwayat Lainnya dari Cloud R2 & Database D1 ──
  if (btnDeleteOlderSession) {
    btnDeleteOlderSession.addEventListener("click", async () => {
      const selectedId = selectOlderSessionsEl?.value;
      if (!selectedId) {
        alert("Pilih sesi riwayat yang ingin dihapus terlebih dahulu.");
        return;
      }
      const target = currentCategorySessions.find(s => s.id === selectedId);
      const fileName = target?.fileName || "Sesi Riwayat";
      if (!confirm(`Hapus sesi "${fileName}" secara permanen dari Cloud R2 & Database?`)) return;

      btnDeleteOlderSession.disabled = true;
      try {
        await deleteLogEntry("pendaftaran", selectedId);
        const activeLogId = await getActiveLogId("pendaftaran");
        if (activeLogId === selectedId || activeLogId === "none") {
          patients = [];
          await chrome.storage.session.remove(["pendaftaranPatients", "pendaftaranQueue", "pendaftaranRunning"]);
          await chrome.storage.local.remove(["pendaftaranPatients", "pendaftaranQueue"]);
          renderPatients();
          setHasDataState(false);
        }
        await showPendaftaranSessionPicker(selectedCategory || "UMUM");
      } catch (err) {
        console.error("[Pendaftaran] Gagal hapus sesi riwayat:", err);
        alert("Gagal menghapus sesi: " + (err.message || err));
      } finally {
        if (btnDeleteOlderSession) btnDeleteOlderSession.disabled = false;
      }
    });
  }

  if (btnPendaftaranBackToMode) {
    btnPendaftaranBackToMode.addEventListener("click", () => {
      if (sessionSelectionEl) sessionSelectionEl.hidden = true;
      if (modeSelectionEl) modeSelectionEl.hidden = false;
      if (mainContentEl) mainContentEl.hidden = true;
      if (activeBarEl) activeBarEl.hidden = true;
      if (pendaftaranFab) pendaftaranFab.hidden = true;
    });
  }

  if (btnSwitchSession) {
    btnSwitchSession.addEventListener("click", () => {
      showPendaftaranSessionPicker(selectedCategory || "UMUM");
    });
  }

  // ── Ambil Data Antrean Langsung dari Portal CKG Bankot (CKG Umum / Sekolah) ──
  const btnPendaftaranPickCkgBankot = document.getElementById("btn-pendaftaran-pick-ckgbankot");
  const btnFetchCkgBankotPendaftaran = document.getElementById("btn-fetch-ckgbankot-pendaftaran");

  async function handleLoadFromCkgBankot(chosenCategory) {
    if (patients && patients.length > 0) {
      const ok = confirm(`Saat ini ada ${patients.length} data pasien di antrean. Apakah Anda yakin ingin memuat antrean baru dari Cloud CKG Bankot (data saat ini akan diganti)?`);
      if (!ok) return;
    }

    let cat = chosenCategory;
    if (!cat) {
      if (typeof window.showCkgBankotCategoryPicker === "function") {
        cat = await window.showCkgBankotCategoryPicker();
      } else {
        cat = selectedCategory || "UMUM";
      }
    }
    if (!cat) return; // Dibatalkan oleh pengguna

    const origCardText = btnPendaftaranPickCkgBankot ? btnPendaftaranPickCkgBankot.innerHTML : "";
    if (btnPendaftaranPickCkgBankot) {
      btnPendaftaranPickCkgBankot.disabled = true;
      btnPendaftaranPickCkgBankot.innerHTML = `<span class="spin">⏳</span> <span>Mengambil Antrean...</span>`;
    }
    if (btnFetchCkgBankotPendaftaran) {
      btnFetchCkgBankotPendaftaran.disabled = true;
      btnFetchCkgBankotPendaftaran.classList.add("loading");
    }

    try {
      const res = await fetchBotQueueFromCkgbankot(cat, "pendaftaran");
      if (!res.success) {
        alert(res.error || "Gagal mengambil antrean cloud.");
        return;
      }
      if (!res.data || res.data.length === 0) {
        alert(`Tidak ada antrean pendaftaran CKG ${cat} milik akun "${res.petugas || 'Anda'}" yang belum dikerjakan di portal ckgbankot.web.id.\n\nCatatan: Antrean ini dibaca per akun. Pastikan data pasien dimasukkan melalui web ckgbankot dengan akun "${res.petugas || 'Anda'}".`);
        return;
      }

      patients = res.data.map((item, idx) => ({
        ...item,
        nama: sanitizeName(item.nama || item.name || ""),
        id: item.id || `q-${item._queue_id || idx + 1}`,
        category: cat,
        _queue_id: item._queue_id,
        _queue_record_id: item._queue_record_id,
        _queue_jenis: cat,
        _status: (item._queue_status_pendaftaran === "berhasil" || item._queue_status_pendaftaran === "Sudah Terdaftar") ? "done" : "idle"
      }));

      currentPage = 1;
      selectedCategory = cat;
      setPendaftaranMode(cat);
      renderPatients();
      setHasDataState(true);
      savePatientsToSession();

      await addLogEntry("pendaftaran", {
        fileName: `Antrean Cloud ${cat} (${res.data.length} Pasien)`,
        category: cat,
        total: res.data.length,
        berhasil: 0,
        gagal: 0,
        sebagian: 0,
        pernahInput: 0,
        data: patients
      }).catch(err => console.error("[Pendaftaran] addLogEntry error:", err));

      alert(`Berhasil mengambil ${res.data.length} antrean pasien CKG ${cat} dari Cloud CKG Bankot!`);
    } catch (err) {
      console.error("[Pendaftaran] Gagal mengambil antrean CKG Bankot:", err);
      alert("Gagal mengambil data antrean dari CKG Bankot: " + (err.message || err));
    } finally {
      if (btnPendaftaranPickCkgBankot) {
        btnPendaftaranPickCkgBankot.disabled = false;
        btnPendaftaranPickCkgBankot.innerHTML = origCardText;
      }
      if (btnFetchCkgBankotPendaftaran) {
        btnFetchCkgBankotPendaftaran.disabled = false;
        btnFetchCkgBankotPendaftaran.classList.remove("loading");
      }
    }
  }

  if (btnPendaftaranPickCkgBankot) {
    btnPendaftaranPickCkgBankot.addEventListener("click", () => {
      handleLoadFromCkgBankot(selectedCategory || "UMUM");
    });
  }

  if (btnFetchCkgBankotPendaftaran) {
    btnFetchCkgBankotPendaftaran.addEventListener("click", () => {
      handleLoadFromCkgBankot(null);
    });
  }

  if (btnSelectUmum) {
    btnSelectUmum.addEventListener("click", () => showPendaftaranSessionPicker("UMUM"));
  }
  if (btnSelectSekolah) {
    btnSelectSekolah.addEventListener("click", () => showPendaftaranSessionPicker("SEKOLAH"));
  }
  if (btnSwitchMode) {
    btnSwitchMode.addEventListener("click", () => setPendaftaranMode(null));
  }

  chrome.storage.local.get("pendaftaranSkipKonfirmasi", res => {
    skipKonfirmasiHadir = !!res.pendaftaranSkipKonfirmasi;
    if (skipKonfirmasiCheckbox) {
      skipKonfirmasiCheckbox.checked = skipKonfirmasiHadir;
    }
  });

  if (skipKonfirmasiCheckbox) {
    skipKonfirmasiCheckbox.addEventListener("change", () => {
      skipKonfirmasiHadir = skipKonfirmasiCheckbox.checked;
      chrome.storage.local.set({ pendaftaranSkipKonfirmasi: skipKonfirmasiHadir });
    });
  }

  function setRunningState(running) {
    isRunning = running;
    btnStartOtomasi.hidden = running || !hasData;
    btnStopOtomasi.hidden = !running;
    btnUploadExcel.hidden = running || hasData;
    if (btnFetchCkgBankotPendaftaran) btnFetchCkgBankotPendaftaran.hidden = running;
    checkErrorButtonVisibility();
  }

  function setHasDataState(has) {
    if (!isRunning) {
      hasData = has;
      btnUploadExcel.hidden = has;
      btnStartOtomasi.hidden = !has;
      btnDownloadTemplate.hidden = has;
      btnStopOtomasi.hidden = true;
      if (filterRowEl) filterRowEl.hidden = !has;
      if (optionsRowEl) optionsRowEl.hidden = !has;
      checkErrorButtonVisibility();
    }
  }

  function getFilteredPatients() {
    return patients.filter(p => {
      const matchAge = selectedAgeFilter === "ALL" || getAgeCategory(p) === selectedAgeFilter;
      const matchStatus = matchesPendaftaranStatus(p, selectedStatusFilter);
      return matchAge && matchStatus;
    });
  }

  function checkErrorButtonVisibility() {
    const hasError = getFilteredPatients().some(p => p._status === "error" || p._status === "invalid-nik");
    btnRestartError.hidden = !hasError || isRunning;
  }

  const STATUS_CONFIG = {
    idle: { label: "Menunggu", cls: "patient-badge--idle" },
    "in-progress": { label: "Proses…", cls: "patient-badge--in-progress" },
    done: { label: "Selesai", cls: "patient-badge--done" },
    error: { label: "Error", cls: "patient-badge--error" },
    "already-screened": { label: "Sudah Daftar", cls: "patient-badge--warning" },
    "invalid-nik": { label: "Tidak valid", cls: "patient-badge--error" }
  };

  function sanitizeNik(val) {
    if (!val) return "";
    let s = String(val).trim();
    if (/e\+/i.test(s)) {
      const n = Number(val);
      if (!isNaN(n)) {
        try {
          s = BigInt(Math.round(n)).toString();
        } catch (e) {
          s = String(n);
        }
      }
    }
    s = s.replace(/\D/g, "");
    return s;
  }

  function renderPatients() {
    const displayList = getFilteredPatients();
    patientsListEl.innerHTML = "";

    const totalFiltered = displayList.length;
    const totalPages = Math.max(1, Math.ceil(totalFiltered / PAGE_SIZE));
    if (currentPage > totalPages) currentPage = totalPages;
    if (currentPage < 1) currentPage = 1;

    if (paginationContainerEl) {
      paginationContainerEl.hidden = totalFiltered <= PAGE_SIZE;
      if (pageInfoEl) {
        const start = totalFiltered === 0 ? 0 : (currentPage - 1) * PAGE_SIZE + 1;
        const end = Math.min(currentPage * PAGE_SIZE, totalFiltered);
        pageInfoEl.innerHTML = `<span>Hal <strong>${currentPage}</strong>/<strong>${totalPages}</strong></span> <span class="page-nav-range">(${start.toLocaleString("id-ID")}–${end.toLocaleString("id-ID")})</span>`;
      }
      if (btnPrevPageEl) btnPrevPageEl.disabled = currentPage <= 1;
      if (btnNextPageEl) btnNextPageEl.disabled = currentPage >= totalPages;
    }

    if (patients.length > 0 && displayList.length === 0) {
      const emptyLi = document.createElement("li");
      emptyLi.className = "patient-empty-filter";
      emptyLi.textContent = "Tidak ada data pasien yang sesuai filter terpilih.";
      patientsListEl.appendChild(emptyLi);
    } else {
      const startIdx = (currentPage - 1) * PAGE_SIZE;
      const endIdx = Math.min(startIdx + PAGE_SIZE, totalFiltered);
      const pagedList = displayList.slice(startIdx, endIdx);

      const fragment = document.createDocumentFragment();
      pagedList.forEach((item, sliceIdx) => {
        const displayIdx = startIdx + sliceIdx;
        const originalIndex = patients.indexOf(item);
        const li = document.createElement("li");
        li.className = "patient-item";
        li.dataset.index = originalIndex;

        const num = document.createElement("span");
        num.className = "patient-item__num";
        num.textContent = displayIdx + 1;

        const name = document.createElement("span");
        name.className = "patient-item__name";
        name.textContent = item.nama || "—";

        const statusKey = item._status ?? "idle";
        const badge = document.createElement("span");
        badge.className = `patient-badge ${STATUS_CONFIG[statusKey]?.cls ?? ""}`;
        badge.textContent = STATUS_CONFIG[statusKey]?.label ?? statusKey;

        const isItemRunning = statusKey === "in-progress";
        const isDone = item._status === "done";
        const actionBtn = document.createElement("button");
        actionBtn.type = "button";
        actionBtn.className = isItemRunning ? "patient-item__stop" : "patient-item__play";
        actionBtn.disabled = isDone;
        actionBtn.setAttribute("aria-label", isItemRunning ? `Stop ${item.nama}` : `Jalankan ${item.nama}`);
        actionBtn.innerHTML = isItemRunning
          ? '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="4" y="4" width="16" height="16"/></svg>'
          : '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><polygon points="5 3 19 12 5 21 5 3"/></svg>';

        actionBtn.addEventListener("click", async () => {
          if (originalIndex === -1) return;
          if (patients[originalIndex]._status === "invalid-nik") {
            alert(`NIK pasien ${item.nama} tidak valid (harus 16 digit).`);
            return;
          }

          // If clicking stop on running item
          if (patients[originalIndex]._status === "in-progress") {
            patients[originalIndex]._status = "idle";
            savePatientsToSession();
            renderPatients();
            setRunningState(false);
            chrome.runtime.sendMessage({ type: "PENDAFTARAN_STOP", patientIndex: originalIndex });
            return;
          }

          if (isRunning) {
            alert("Otomasi sedang berjalan. Tunggu atau hentikan terlebih dahulu.");
            return;
          }

          const targetUrl = TARGET_URLS[selectedCategory] || TARGET_URLS.UMUM;
          let tabId;
          try {
            const tabs = await chrome.tabs.query({ url: "*://sehatindonesiaku.kemkes.go.id/*" });
            const pendaftaranTab = tabs.find(t => (t.url || "").includes("ckg-pendaftaran"));
            if (pendaftaranTab) {
              tabId = pendaftaranTab.id;
              await chrome.tabs.update(tabId, { active: true });
            } else {
              tabId = (await chrome.tabs.create({ url: targetUrl })).id;
            }
          } catch (err) {
            console.error("[Pendaftaran] Gagal membuka tab:", err);
            return;
          }

          patients[originalIndex]._status = "in-progress";
          patients[originalIndex].category = selectedCategory;
          savePatientsToSession();
          renderPatients();
          setRunningState(true);

          chrome.runtime.sendMessage({
            type: "PENDAFTARAN_START",
            tabId,
            patient: patients[originalIndex],
            patientIndex: originalIndex,
            delayMultiplier: konfigurasi?.getPendaftaranDelay() ?? 1,
            skipKonfirmasiHadir
          });
        });

        li.appendChild(num);
        li.appendChild(name);
        li.appendChild(badge);
        li.appendChild(actionBtn);
        fragment.appendChild(li);
      });
      patientsListEl.appendChild(fragment);
    }

    if (patients.length > 0 && displayList.length !== patients.length) {
      countBadge.textContent = `${displayList.length} / ${patients.length} pasien`;
    } else {
      countBadge.textContent = `${patients.length} pasien`;
    }
    emptyPlaceholder.hidden = true;
    listContainer.hidden = false;
    if (filterRowEl) filterRowEl.hidden = false;
    if (optionsRowEl) optionsRowEl.hidden = false;
    checkErrorButtonVisibility();
  }

  let saveSessionTimer = null;
  function debouncedSavePatientsToSession(delay = 1500) {
    if (saveSessionTimer) clearTimeout(saveSessionTimer);
    saveSessionTimer = setTimeout(() => {
      saveSessionTimer = null;
      flushSavePatientsToSession();
    }, delay);
  }

  function flushSavePatientsToSession() {
    if (saveSessionTimer) {
      clearTimeout(saveSessionTimer);
      saveSessionTimer = null;
    }
    try {
      const storageArea = chrome.storage?.session || chrome.storage?.local;
      if (storageArea) {
        storageArea.set({ pendaftaranPatients: patients }).catch(() => { });
      }
      if (chrome.storage?.local) {
        chrome.storage.local.set({ pendaftaranPatients: patients }).catch(() => { });
      }
    } catch (err) {
      console.warn("[Pendaftaran] savePatientsToSession error:", err);
    }
    debouncedSyncStatsToActiveLog();
  }

  function savePatientsToSession() {
    flushSavePatientsToSession();
  }

  let syncStatsTimer = null;
  function debouncedSyncStatsToActiveLog(delay = 2000) {
    if (syncStatsTimer) clearTimeout(syncStatsTimer);
    syncStatsTimer = setTimeout(() => {
      syncStatsTimer = null;
      flushSyncStatsToActiveLog();
    }, delay);
  }

  async function flushSyncStatsToActiveLog() {
    if (syncStatsTimer) {
      clearTimeout(syncStatsTimer);
      syncStatsTimer = null;
    }
    if (!patients || !patients.length) return;
    const berhasil = patients.filter(p => p._status === "done").length;
    const gagal = patients.filter(p => p._status === "error" || p._status === "invalid-nik").length;
    const sebagian = patients.filter(p => p._status === "partial").length;
    const pernahInput = patients.filter(p => p._status === "already-screened").length;
    await updateActiveLog("pendaftaran", {
      total: patients.length,
      berhasil,
      gagal,
      sebagian,
      pernahInput,
      data: patients
    });
  }

  function syncStatsToActiveLog() {
    return flushSyncStatsToActiveLog();
  }

  /**
   * Perbarui satu node pasien di DOM secara langsung tanpa render ulang 2000+ elemen
   */
  function updateSinglePatientStatusInDom(patientIndex, statusKey) {
    let li = patientsListEl.querySelector(`li[data-index="${patientIndex}"]`);
    if (!li) {
      // Auto-follow: jika item in-progress ada di halaman lain, otomatis beralih halaman
      if (statusKey === "in-progress" && patients[patientIndex]) {
        const displayList = getFilteredPatients();
        const displayIdx = displayList.indexOf(patients[patientIndex]);
        if (displayIdx !== -1) {
          const targetPage = Math.floor(displayIdx / PAGE_SIZE) + 1;
          if (targetPage !== currentPage) {
            currentPage = targetPage;
            renderPatients();
            li = patientsListEl.querySelector(`li[data-index="${patientIndex}"]`);
          }
        }
      }
      if (!li) return false;
    }

    const badge = li.querySelector(".patient-badge");
    if (badge) {
      const cfg = STATUS_CONFIG[statusKey] || { label: statusKey, cls: "" };
      badge.className = `patient-badge ${cfg.cls}`;
      badge.textContent = cfg.label;
    }

    const actionBtn = li.querySelector("button");
    if (actionBtn) {
      const isItemRunning = statusKey === "in-progress";
      const isDone = statusKey === "done";
      actionBtn.className = isItemRunning ? "patient-item__stop" : "patient-item__play";
      actionBtn.disabled = isDone;
      actionBtn.setAttribute("aria-label", isItemRunning ? "Stop" : "Jalankan");
      actionBtn.innerHTML = isItemRunning
        ? '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="4" y="4" width="16" height="16"/></svg>'
        : '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><polygon points="5 3 19 12 5 21 5 3"/></svg>';
    }

    if (statusKey === "in-progress") {
      li.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }

    return true;
  }

  function updateCategoryClass(category) {
    emptyPlaceholder.classList.toggle("promo-placeholder--sekolah", category === "SEKOLAH");
  }

  chrome.runtime.onMessage.addListener(msg => {
    if (msg.type === "PENDAFTARAN_STATUS") {
      const { patientIndex, status, nomorTiket, errorMsg, error, reason, screeningDate, screeningFaskes, screeningLayanan, screeningDetail } = msg;
      if (patients[patientIndex] !== undefined) {
        patients[patientIndex]._status = status;
        if (nomorTiket) patients[patientIndex]._nomorTiket = nomorTiket;
        if (errorMsg || error || reason) {
          patients[patientIndex]._errorMsg = errorMsg || error || reason;
        }
        if (screeningDate) patients[patientIndex]._screeningDate = screeningDate;
        if (screeningFaskes && !/whatsapp|notifikasi/i.test(screeningFaskes)) {
          patients[patientIndex]._screeningFaskes = screeningFaskes;
        }
        if (screeningLayanan && !/selesai\s*diperiksa|menerima\s*layanan/i.test(screeningLayanan)) {
          patients[patientIndex]._screeningLayanan = screeningLayanan;
        }
        if (screeningDetail) patients[patientIndex]._screeningDetail = screeningDetail;

        const effectiveMsg = errorMsg || error || reason;
        if (!patients[patientIndex]._screeningDate && effectiveMsg) {
          const tm = effectiveMsg.match(/(?:tanggal(?:\s*pemeriksaan|\s*skrining|\s*layanan)?|tgl|date|pada)\s*[:\-]?\s*([0-9]{1,2}\s+[A-Za-z]+\s+[0-9]{4}|[0-9]{1,4}[\/\-][0-9]{1,2}[\/\-][0-9]{1,4})/i);
          if (tm) patients[patientIndex]._screeningDate = tm[1].trim();
        }
        if ((!patients[patientIndex]._screeningFaskes || /whatsapp|notifikasi/i.test(patients[patientIndex]._screeningFaskes)) && effectiveMsg) {
          const fm = effectiveMsg.match(/puskesmas\s*pemeriksa\s*[:\-]\s*([^\r\n,\)\.]+)/i) ||
            effectiveMsg.match(/(?:puskesmas|faskes|fasilitas\s*kesehatan|klinik)\s*pemeriksa\s*[:\-]\s*([^\r\n,\)\.]+)/i) ||
            effectiveMsg.match(/puskesmas\s*[:\-]\s*([^\r\n,\)\.]+)/i);
          if (fm && !/whatsapp|notifikasi|rapor|ssm/i.test(fm[1].trim())) {
            patients[patientIndex]._screeningFaskes = fm[1].trim();
          }
        }
        if ((!patients[patientIndex]._screeningLayanan || /selesai\s*diperiksa|menerima\s*layanan/i.test(patients[patientIndex]._screeningLayanan)) && effectiveMsg) {
          const lm = effectiveMsg.match(/(?:^|[\r\n\(])\s*layanan\s*[:\-]\s*([^\r\n,\)\.]+)/i);
          if (lm && !/menerima|selesai|diperiksa/i.test(lm[1].trim())) {
            patients[patientIndex]._screeningLayanan = lm[1].trim();
          }
        }

        // Perbarui DOM secara presisi pada 1 item agar tidak freeze
        const updatedInDom = updateSinglePatientStatusInDom(patientIndex, status);
        if (!updatedInDom) {
          renderPatients();
        } else {
          checkErrorButtonVisibility();
        }

        // Simpan antrean dengan debounce (tidak disk-write setiap 500ms)
        debouncedSavePatientsToSession();

        // 🤖 Sinkronisasi Pasien Terdaftar / Berhasil ke Database ckgbankot (secara batch antrean)
        if (status === "done" || status === "already-screened") {
          const p = patients[patientIndex];
          updateQueueStatusToCkgbankot({
            nik: p.nik || p.NIK,
            jenis: selectedCategory || "UMUM",
            status_pendaftaran: status === "already-screened" ? "Sudah Terdaftar" : "Berhasil Didaftarkan",
            no_tiket: nomorTiket || p._nomorTiket || p.no_tiket || "",
            keterangan: status === "already-screened" ? "Sudah pernah diskrining" : "Pendaftaran Berhasil"
          }).catch(e => console.warn("[ENCO Sync] updateQueueStatusToCkgbankot error:", e));

          syncPatientToCkgbankot({
            nik: p.nik || p.NIK,
            nama: p.nama || p.Nama || p.nama_pasien,
            tanggal_lahir: p.tanggallahir || p.tanggal_lahir || p.dob || p["Tanggal Lahir"] || p.tgllahir || "",
            jenis_kelamin: p.jeniskelamin || p.jenis_kelamin || p.jk || p["Jenis Kelamin"] || p.gender || "",
            status_pernikahan: p.statuspernikahan || p.status_pernikahan || p.statusnikah || p.nikah || "",
            pekerjaan: p.pekerjaan || p.job || "",
            provinsi: p.provinsi || p.province || "Jawa Barat",
            kab_kota: p.kabkota || p.kab_kota || p.kota || p.kabupaten || "Kab. Bandung",
            kecamatan: p.kecamatan || p.district || "Banjaran",
            kelurahan: p.kelurahan || p.desa || p.subdistrict || "",
            alamat: p.detailalamat || p.alamat || p.detaildomisili || p.address || "",
            no_tiket: nomorTiket || p._nomorTiket || p.no_tiket || "",
            kategori: selectedCategory || "UMUM",
            status_pendaftaran: status === "already-screened" ? "Sudah Terdaftar" : "Berhasil Didaftarkan",
            status_pelayanan: "Belum Pelayanan",
            raw_details: p
          }).catch(e => console.warn("[ENCO Sync] syncPatient error:", e));
        } else if (status === "error" || status === "invalid-nik") {
          const p = patients[patientIndex];
          if (p) {
            updateQueueStatusToCkgbankot({
              nik: p.nik || p.NIK,
              jenis: selectedCategory || "UMUM",
              status_pendaftaran: "Gagal Pendaftaran",
              keterangan: p._errorMsg || "Gagal pendaftaran di ASIK"
            }).catch(e => console.warn("[ENCO Sync] updateQueueStatusToCkgbankot error:", e));
          }
        }

        // Check if any patient is still running
        const stillRunning = patients.some(p => p._status === "in-progress");
        if (!stillRunning && isRunning) {
          chrome.storage.session.get("pendaftaranQueue").then(({ pendaftaranQueue }) => {
            if (!pendaftaranQueue?.patients?.length) {
              setRunningState(false);
            }
          });
        }
      }
    }

    if (msg.type === "PENDAFTARAN_QUEUE_DONE" || msg.type === "PENDAFTARAN_ALL_STOPPED") {
      setRunningState(false);
      flushSavePatientsToSession();
      flushSyncStatsToActiveLog();
      renderPatients();
      flushPendingPatientSync().catch(() => { });

      // 🤖 Kirim Sesi Log Otomasi ke Database ckgbankot
      const totalP = patients.length;
      const b = patients.filter(p => p._status === "done").length;
      const t = patients.filter(p => p._status === "already-screened").length;
      const g = patients.filter(p => p._status === "error" || p._status === "invalid-nik").length;
      if (totalP > 0) {
        syncLogToCkgbankot({
          jenis_kegiatan: "Pendaftaran " + (selectedCategory || "UMUM"),
          total_pasien: totalP,
          jumlah_berhasil: b,
          jumlah_terdaftar: t,
          jumlah_gagal: g,
          status: g > 0 ? "Selesai Sebagian" : "Selesai",
          keterangan: `Pendaftaran selesai: ${b} berhasil daftar, ${t} sudah terdaftar, ${g} gagal.`
        }).catch(e => console.warn("[ENCO Sync] syncLog error:", e));
      }
    }
  });

  document.getElementById("btn-clear-excel").addEventListener("click", async () => {
    patients = [];
    patientsListEl.innerHTML = "";
    emptyPlaceholder.hidden = false;
    listContainer.hidden = true;
    if (filterRowEl) filterRowEl.hidden = true;
    if (optionsRowEl) optionsRowEl.hidden = true;
    selectedAgeFilter = "ALL";
    selectedStatusFilter = "ALL";
    if (ageFilterEl) ageFilterEl.value = "ALL";
    if (statusFilterEl) statusFilterEl.value = "ALL";
    setHasDataState(false);
    await chrome.storage.session.remove(["pendaftaranPatients", "pendaftaranQueue", "pendaftaranRunning", "pendaftaran-age-filter", "pendaftaran-status-filter"]);
    await chrome.storage.local.remove(["pendaftaranPatients", "pendaftaranQueue"]);
    await setActiveLogId("pendaftaran", "none");
  });

  if (categoryFilter) {
    categoryFilter.addEventListener("change", () => {
      selectedCategory = categoryFilter.value;
      chrome.storage.session.set({ "pendaftaran-category": selectedCategory });
      updateCategoryClass(selectedCategory);
      currentPage = 1;

      // Synchronize category to all loaded patients
      if (patients.length > 0) {
        patients.forEach(p => {
          p.category = selectedCategory;
        });
        savePatientsToSession();
      }
      renderPatients();
    });
  }

  if (ageFilterEl) {
    ageFilterEl.addEventListener("change", () => {
      selectedAgeFilter = ageFilterEl.value;
      chrome.storage.session.set({ "pendaftaran-age-filter": selectedAgeFilter });
      currentPage = 1;
      renderPatients();
    });
  }

  if (statusFilterEl) {
    statusFilterEl.addEventListener("change", () => {
      selectedStatusFilter = statusFilterEl.value;
      chrome.storage.session.set({ "pendaftaran-status-filter": selectedStatusFilter });
      currentPage = 1;
      renderPatients();
    });
  }

  if (btnPrevPageEl) {
    btnPrevPageEl.addEventListener("click", () => {
      if (currentPage > 1) {
        currentPage--;
        renderPatients();
        patientsListEl.scrollTop = 0;
      }
    });
  }

  if (btnNextPageEl) {
    btnNextPageEl.addEventListener("click", () => {
      const displayList = getFilteredPatients();
      const totalPages = Math.max(1, Math.ceil(displayList.length / PAGE_SIZE));
      if (currentPage < totalPages) {
        currentPage++;
        renderPatients();
        patientsListEl.scrollTop = 0;
      }
    });
  }

  btnDownloadTemplate.addEventListener("click", e => {
    e.preventDefault();
    if (selectedCategory === "SEKOLAH") {
      downloadTemplateFile("SEKOLAH");
    } else {
      downloadTemplateFile("UMUM");
    }
  });

  const runAllFiltered = async filterFn => {
    const filtered = getFilteredPatients();
    const candidates = filtered
      .map(p => ({ p, i: patients.indexOf(p) }))
      .filter(({ p, i }) => i !== -1 && filterFn(p));

    if (!candidates.length) {
      alert("Tidak ada pasien yang sesuai filter untuk dijalankan.");
      return;
    }

    const targetUrl = TARGET_URLS[selectedCategory] || TARGET_URLS.UMUM;
    let tabId;
    try {
      const tabs = await chrome.tabs.query({ url: "*://sehatindonesiaku.kemkes.go.id/*" });
      const pendaftaranTab = tabs.find(t => (t.url || "").includes("ckg-pendaftaran"));
      if (pendaftaranTab) {
        tabId = pendaftaranTab.id;
        await chrome.tabs.update(tabId, { active: true });
      } else {
        tabId = (await chrome.tabs.create({ url: targetUrl })).id;
      }
    } catch (err) {
      console.error("[Pendaftaran] Gagal membuka tab:", err);
      return;
    }

    let activeLog = await getActiveLogId("pendaftaran");
    if (!activeLog) {
      const hist = await getHistory("pendaftaran");
      if (hist.length > 0) {
        await setActiveLogId("pendaftaran", hist[0].id);
      } else {
        const newEntry = await addLogEntry("pendaftaran", {
          fileName: "Data Pendaftaran",
          category: selectedCategory,
          total: patients.length,
          berhasil: 0,
          gagal: 0,
          sebagian: 0,
          pernahInput: 0,
          data: patients
        });
        if (newEntry) await setActiveLogId("pendaftaran", newEntry.id);
      }
    }
    syncStatsToActiveLog();

    candidates.forEach(({ p }) => {
      p.category = selectedCategory;
    });
    savePatientsToSession();

    // Berikan respons visual langsung pada pasien pertama yang akan diproses
    const firstCand = candidates[0];
    if (firstCand && patients[firstCand.i]) {
      patients[firstCand.i]._status = "in-progress";
      renderPatients();
    }

    setRunningState(true);
    chrome.runtime.sendMessage({
      type: "PENDAFTARAN_START_ALL",
      tabId,
      patients: candidates.map(({ i }) => ({ patientIndex: i })),
      delayMultiplier: konfigurasi?.getPendaftaranDelay() ?? 1,
      skipKonfirmasiHadir
    });
  };

  btnStartOtomasi.addEventListener("click", () => {
    runAllFiltered(p => p._status !== "done" && p._status !== "in-progress" && p._status !== "already-screened");
  });

  btnRestartError.addEventListener("click", () => {
    runAllFiltered(p => p._status === "error" || p._status === "invalid-nik");
  });

  btnStopOtomasi.addEventListener("click", () => {
    setRunningState(false);
    chrome.runtime.sendMessage({ type: "PENDAFTARAN_STOP_ALL" });
  });

  document.getElementById("input-excel-file").addEventListener("change", e => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";

    const reader = new FileReader();
    reader.onload = async evt => {
      try {
        const XLSX = window.XLSX;
        const workbook = XLSX.read(evt.target.result, { type: "array" });

        // Find relevant sheet
        let sheetName = workbook.SheetNames[0];
        if (selectedCategory === "SEKOLAH") {
          const matchSch = workbook.SheetNames.find(n => n.toUpperCase().includes("SEKOLAH"));
          if (matchSch) sheetName = matchSch;
        }

        const sheet = workbook.Sheets[sheetName];
        const rawJson = XLSX.utils.sheet_to_json(sheet, { defval: "", raw: false });

        let parsedRaw = rawJson
          .map(row => {
            const cleanRow = {};
            for (const [k, v] of Object.entries(row)) {
              cleanRow[k.toLowerCase().replace(/[^a-z0-9]/g, "")] = v;
            }

            const cleanNikVal = sanitizeNik(cleanRow.nik ?? cleanRow.NIK ?? cleanRow.nonik ?? cleanRow.noktp ?? cleanRow.nomoridentitas ?? "");
            const item = {
              ...cleanRow,
              nik: cleanNikVal,
              nama: sanitizeName(cleanRow.nama || cleanRow.name || cleanRow.namalengkap || cleanRow.namapasien || ""),
              category: selectedCategory
            };

            // Standardize fields from Excel
            item.sekolah = cleanRow.sekolah || cleanRow.namasekolah || cleanRow.sekolahmadrasah || cleanRow.namamadrasah || item.sekolah || "";
            item.kelas = cleanRow.kelas || cleanRow.tingkat || cleanRow.jenjang || cleanRow.jenjangpendidikan || item.kelas || "";
            const rawWa = String(cleanRow.nowhatsapp || cleanRow.nowa || cleanRow.nomorwa || cleanRow.nohp || cleanRow.hp || cleanRow.telp || cleanRow.notelepon || cleanRow.wa || "").trim();
            const waDigits = rawWa.replace(/\D/g, "").replace(/^0+/, "");
            item.wa = waDigits.length >= 6 ? rawWa : "081225566666";
            item.jeniskelamin = sanitizeGender(cleanRow.jeniskelamin || cleanRow.jk || cleanRow.gender || "");
            item.tanggallahir = sanitizeDate(cleanRow.tanggallahir || cleanRow.tgllahir || cleanRow.tgl_lahir || cleanRow.tanggal || cleanRow.tgl || cleanRow.ttl || cleanRow.dob || cleanRow.birthdate || cleanRow.tgllhr || cleanRow.tanggallhr || cleanRow.lahir || "");
            item.tahunlahir = cleanRow.tahunlahir || cleanRow.tahun || "";
            item.bulanlahir = cleanRow.bulanlahir || cleanRow.bulan || "";
            item.statuspernikahan = cleanRow.statuspernikahan || cleanRow.statusnikah || cleanRow.nikah || "";
            item.pekerjaan = cleanRow.pekerjaan || cleanRow.job || "";
            item.provinsi = cleanRow.provinsi || cleanRow.province || "";
            item.kabkota = cleanRow.kabkota || cleanRow.kota || cleanRow.kabupaten || cleanRow.city || "";
            item.kecamatan = cleanRow.kecamatan || cleanRow.district || "";
            item.kelurahan = cleanRow.kelurahan || cleanRow.desa || cleanRow.subdistrict || cleanRow.desaataukelurahan || "";
            item.detailalamat = cleanRow.detailalamat || cleanRow.detaildomisili || cleanRow.alamat || cleanRow.address || "";

            if (cleanNikVal && cleanNikVal.length !== 16) {
              item._status = "invalid-nik";
              item._errorMsg = `Panjang NIK (${cleanNikVal.length} digit) tidak valid, harus tepat 16 digit.`;
            }
            return item;
          });

        const stdFilter = filterValidIdentityRows(parsedRaw, { dedupeNik: true, checkDobGender: true });
        let parsed = stdFilter.validRows;
        let finalSkippedCount = stdFilter.skippedCount;
        let finalSkippedReasons = stdFilter.reasons;

        // Verify if standard template parsing succeeded
        const hasValidData = parsedRaw.some(p => p.nama && p.nik);

        if (!hasValidData) {
          // Trigger AI Smart Column Mapping (Zero-Template Ingestion)
          console.log("[Pendaftaran] Template standar tidak cocok, mencoba membaca dengan AI Gemini...");
          const uploadBtnSpan = document.querySelector("#btn-upload-excel span");
          const origText = uploadBtnSpan ? uploadBtnSpan.textContent : "Upload Excel";
          if (uploadBtnSpan) uploadBtnSpan.textContent = "🤖 AI Menganalisis...";

          try {
            const raw2DRows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });

            if (raw2DRows && raw2DRows.length > 1) {
              const aiRes = await detectExcelMappingWithAI({ raw2DRows, mode: "pendaftaran" });
              if (aiRes.success && aiRes.mapping && (aiRes.mapping.nik !== undefined || aiRes.mapping.nama !== undefined)) {
                console.log("[Pendaftaran] AI Column Mapping Result:", aiRes);
                const { headerRowIndex = 0, mapping = {} } = aiRes;
                const aiParsed = [];

                for (let i = headerRowIndex + 1; i < raw2DRows.length; i++) {
                  const row = raw2DRows[i];
                  if (!Array.isArray(row) || row.every(c => c === "" || c == null)) continue;

                  const getVal = (fieldKey) => {
                    const colIdx = mapping[fieldKey];
                    if (colIdx !== undefined && colIdx !== null && row[colIdx] !== undefined) {
                      return row[colIdx];
                    }
                    return "";
                  };

                  const rawNik = getVal("nik");
                  const cleanNikVal = sanitizeNik(rawNik);
                  const namaVal = sanitizeName(getVal("nama") || "");

                  if (!namaVal && !cleanNikVal) continue;
                  if (namaVal.toUpperCase() === "CONTOH NAMA") continue;

                  const item = {
                    nik: cleanNikVal,
                    nama: namaVal,
                    category: selectedCategory,
                    sekolah: String(getVal("sekolah") || "").trim(),
                    kelas: String(getVal("kelas") || "").trim(),
                    wa: String(getVal("wa") || "").trim(),
                    jeniskelamin: sanitizeGender(getVal("jeniskelamin")),
                    tanggallahir: sanitizeDate(getVal("tanggallahir")),
                    tahunlahir: "",
                    bulanlahir: "",
                    statuspernikahan: String(getVal("statuspernikahan") || "").trim(),
                    pekerjaan: String(getVal("pekerjaan") || "").trim(),
                    provinsi: String(getVal("provinsi") || "").trim(),
                    kabkota: String(getVal("kabkota") || "").trim(),
                    kecamatan: String(getVal("kecamatan") || "").trim(),
                    kelurahan: String(getVal("kelurahan") || "").trim(),
                    detailalamat: String(getVal("detailalamat") || "").trim(),
                  };

                  if (cleanNikVal && cleanNikVal.length !== 16) {
                    item._status = "invalid-nik";
                    item._errorMsg = `Panjang NIK (${cleanNikVal.length} digit) tidak valid, harus tepat 16 digit.`;
                  }

                  aiParsed.push(item);
                }

                if (aiParsed.length > 0) {
                  const aiFilter = filterValidIdentityRows(aiParsed, { dedupeNik: true, checkDobGender: true });
                  parsed = aiFilter.validRows;
                  finalSkippedCount = aiFilter.skippedCount;
                  finalSkippedReasons = aiFilter.reasons;
                  console.log(`[Pendaftaran] AI berhasil memproses ${parsed.length} data pasien!`);
                }
              }
            }
          } finally {
            if (uploadBtnSpan) uploadBtnSpan.textContent = origText;
          }
        }

        const skipSummary = formatSkippedIdentitySummary(finalSkippedReasons);
        if (!parsed.length) {
          alert(skipSummary
            ? `Tidak ada data pasien valid (${finalSkippedCount} baris dilewati: ${skipSummary}).`
            : "Tidak ada data pasien ditemukan di file ini. Pastikan file Excel berisi kolom Nama dan NIK.");
          return;
        }

        patients = parsed;
        currentPage = 1;
        renderPatients();
        setHasDataState(true);
        savePatientsToSession();

        if (finalSkippedCount > 0) {
          alert(`${parsed.length} pasien dimuat ke antrean.\n${finalSkippedCount} baris dilewati karena data identitas kurang/duplikat (${skipSummary}).`);
        }

        addLogEntry("pendaftaran", {
          fileName: file.name,
          category: selectedCategory,
          total: parsed.length,
          berhasil: 0,
          gagal: 0,
          sebagian: 0,
          pernahInput: 0,
          data: parsed
        }).catch(err => console.error("[Pendaftaran] addLogEntry error:", err));
      } catch (err) {
        console.error("[Pendaftaran] Gagal membaca Excel:", err);
        alert("Gagal membaca file Excel. Pastikan file valid dan berformat .xlsx.");
      }
    };
    reader.readAsArrayBuffer(file);
  });

  const fileInputEl = document.getElementById("input-excel-file");
  if (btnUploadExcel && fileInputEl) {
    btnUploadExcel.addEventListener("click", e => {
      if (e.target !== fileInputEl) {
        fileInputEl.click();
      }
    });
  }

  async function resumeFromLogEntry(entry) {
    if (!entry) return false;
    let sessionData = entry.data;
    if (!sessionData || !sessionData.length) {
      try {
        const userSession = await chrome.storage.local.get(["enco_user_session"]);
        const petugas = userSession.enco_user_session?.nama_user;
        if (petugas && entry.id) {
          const res = await fetch(`https://ckgbankot.web.id/api/enco/sessions/detail?id=${encodeURIComponent(entry.id)}&petugas=${encodeURIComponent(petugas)}&menu=pendaftaran`);
          const json = await res.json();
          if (json.success && json.session?.data) {
            sessionData = json.session.data;
          }
        }
      } catch (err) {
        console.warn("[Pendaftaran] Error fetching session detail from Cloud R2:", err);
      }
    }
    if (!sessionData || !sessionData.length) return false;
    patients = sessionData;
    currentPage = 1;
    if (entry.category) {
      selectedCategory = entry.category;
    }
    await setActiveLogId("pendaftaran", entry.id);
    savePatientsToSession();
    renderPatients();
    setHasDataState(true);
    checkErrorButtonVisibility();
    return true;
  }

  const storageArea = chrome.storage?.session || chrome.storage?.local;
  if (storageArea) {
    storageArea
      .get(["pendaftaranPatients", "pendaftaranRunning", "pendaftaranQueue", "pendaftaranMode", "pendaftaran-category", "pendaftaran-age-filter", "pendaftaran-status-filter"])
      .then(async ({ pendaftaranPatients, pendaftaranRunning, pendaftaranQueue, pendaftaranMode: savedMode, "pendaftaran-category": savedCategory, "pendaftaran-age-filter": savedAge, "pendaftaran-status-filter": savedStatus }) => {
        const activeLogId = await getActiveLogId("pendaftaran");
        if (!pendaftaranRunning && (activeLogId === "none" || !activeLogId)) {
          // Bersihkan sisa cache nyangkut jika tidak ada sesi aktif
          patients = [];
          await chrome.storage.session?.remove(["pendaftaranPatients", "pendaftaranQueue"]).catch(() => { });
          await chrome.storage.local?.remove(["pendaftaranPatients", "pendaftaranQueue"]).catch(() => { });
          setHasDataState(false);
          setPendaftaranMode(null);
          return;
        }

        if (savedAge) {
          selectedAgeFilter = savedAge;
          if (ageFilterEl) ageFilterEl.value = savedAge;
        }
        if (savedStatus) {
          selectedStatusFilter = savedStatus;
          if (statusFilterEl) statusFilterEl.value = savedStatus;
        }
        if (pendaftaranPatients?.length) {
          patients = pendaftaranPatients;
          renderPatients();
          setHasDataState(true);
        }

        if (pendaftaranQueue?.patients?.length > 0 || pendaftaranRunning) {
          // Jika otomasi sedang aktif berjalan, langsung tampilkan antrean aktif
          const modeToSet = savedMode || (savedCategory || "UMUM");
          setPendaftaranMode(modeToSet);
          setRunningState(true);
        } else {
          // Jika Chrome baru dibuka atau bot idle, sambut pengguna dengan layar pemilihan kategori & sesi
          setPendaftaranMode(null);
          checkErrorButtonVisibility();
        }
      })
      .catch(err => console.warn("[Pendaftaran] session restore error:", err));
  }

  return {
    getMode: () => pendaftaranMode,
    getPatients: () => patients,
    resetMode: () => setPendaftaranMode(null),
    showSessionPicker: showPendaftaranSessionPicker,
    resumeFromLog: resumeFromLogEntry,
    createNewSession: async function (customName) {
      if (!patients || !patients.length) {
        alert("Tidak ada data pendaftaran yang dimuat. Silakan upload file Excel terlebih dahulu.");
        return false;
      }

      const historyList = await getHistory("pendaftaran");
      const activeId = await getActiveLogId("pendaftaran");
      const currentActiveEntry = historyList.find(item => item.id === activeId) || historyList[0];
      const baseName = currentActiveEntry?.fileName || "Pendaftaran Pasien";
      const sessionName = customName || `${baseName} (Sesi)`;

      // Reset seluruh status pendaftaran agar siap diproses ulang
      patients.forEach(p => {
        p._status = "idle";
        p._nomorTiket = null;
      });

      const newEntry = await addLogEntry("pendaftaran", {
        fileName: sessionName,
        category: selectedCategory,
        total: patients.length,
        berhasil: 0,
        gagal: 0,
        sebagian: 0,
        pernahInput: 0,
        status: "idle",
        data: patients
      });

      if (newEntry) {
        await setActiveLogId("pendaftaran", newEntry.id);
      }

      savePatientsToSession();
      renderPatients();
      setHasDataState(true);
      checkErrorButtonVisibility();
      return true;
    },
    endActiveSession: async function () {
      await syncStatsToActiveLog();
      await setActiveLogId("pendaftaran", "none");
      patients = [];
      patientsListEl.innerHTML = "";
      emptyPlaceholder.hidden = false;
      listContainer.hidden = true;
      if (filterRowEl) filterRowEl.hidden = true;
      if (optionsRowEl) optionsRowEl.hidden = true;
      selectedAgeFilter = "ALL";
      selectedStatusFilter = "ALL";
      if (ageFilterEl) ageFilterEl.value = "ALL";
      if (statusFilterEl) statusFilterEl.value = "ALL";
      setHasDataState(false);
      setPendaftaranMode(null);
      await chrome.storage.session.remove(["pendaftaranPatients", "pendaftaranQueue", "pendaftaranRunning", "pendaftaranMode", "pendaftaran-age-filter", "pendaftaran-status-filter"]);
      await chrome.storage.local.remove(["pendaftaranPatients", "pendaftaranQueue"]);
      return true;
    }
  };
}