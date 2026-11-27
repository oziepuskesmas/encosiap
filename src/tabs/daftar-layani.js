/**
 * daftar-layani.js
 * Modul One-Stop CKG: Mendaftarkan Pasien Baru ke ASIK dan Langsung Melanjutkan ke Pelayanan Pemeriksaan
 */
import {
  addLogEntry,
  updateActiveLog,
  getHistory,
  setActiveLogId,
  deleteLogEntry,
  formatLogDate,
  syncCloudR2History
} from "../services/historyService.js";
import { fetchBotQueueFromCkgbankot } from "../services/encoSyncService.js";
import { sanitizeName, filterValidIdentityRows, formatSkippedIdentitySummary } from "../services/aiService.js";

export function initDaftarLayani() {
  const container = document.getElementById("tab-daftar-layani");
  if (!container) return;

  let patients = [];
  let loadedFileName = "";
  let isRunning = false;
  let isPaused = false;
  const PAGE_SIZE = 10;
  let currentPage = 1;
  let activeFilter = "all";
  let isSetupCollapsed = false;
  const STATE_KEY = "enco_daftar_layani_state";

  container.innerHTML = `
    <div class="dl-panel">
      <div style="display: flex; align-items: center; justify-content: space-between; gap: 6px;">
        <span id="dl-setup-summary" style="font-size: 10.5px; color: #94a3b8; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">Pengaturan &amp; Sumber Data</span>
        <button id="dl-btn-toggle-setup" class="dl-page-btn" type="button" style="padding: 0 8px; height: 22px; font-size: 10px; color: #38bdf8; border-color: rgba(56, 189, 248, 0.35); white-space: nowrap;">
          ▲ Sembunyikan
        </button>
      </div>

      <div id="dl-setup-section" style="display: flex; flex-direction: column; gap: 10px;">
        <!-- Clinical Operational Header -->
        <div class="dl-hero-card">
          <div class="dl-hero-top">
            <h3 class="dl-hero-title">Daftar &amp; Layani Pasien</h3>
            <span class="dl-hero-badge">One-Stop CKG</span>
          </div>
          <p class="dl-hero-desc">Registrasi pasien ke API Kemkes &amp; selesaikan skrining otomatis tanpa klik DOM.</p>
        </div>

        <!-- Config Card -->
        <div class="dl-config-card">
          <div>
            <label class="field__label" for="dl-category" style="font-size: 10.5px; margin-bottom: 3px; display: block;">Kategori Sasaran</label>
            <select id="dl-category" class="field__input" style="font-size: 11px; height: 32px; width: 100%;">
              <option value="UMUM" selected>CKG Umum (Dewasa &amp; Lansia)</option>
              <option value="SEKOLAH">CKG Sekolah (Peserta Didik)</option>
            </select>
          </div>

          <div class="dl-config-row">
            <div class="dl-config-col" style="flex: 1.2;">
              <label class="field__label" for="dl-screening-date" style="font-size: 10.5px; margin-bottom: 3px; display: block;">Tanggal</label>
              <input type="date" id="dl-screening-date" class="field__input" style="font-size: 11px; height: 32px; width: 100%;">
            </div>
            <div class="dl-config-col" style="flex: 0.65;">
              <label class="field__label" for="dl-delay" style="font-size: 10.5px; margin-bottom: 3px; display: block;">Jeda (dtk)</label>
              <input type="number" id="dl-delay" class="field__input" min="0.5" max="10" step="0.5" value="1.5" style="font-size: 11px; height: 32px; width: 100%;">
            </div>
            <div class="dl-config-col" style="flex: 0.65;">
              <label class="field__label" for="dl-concurrent" style="font-size: 10.5px; margin-bottom: 3px; display: block;">Paralel</label>
              <input type="number" id="dl-concurrent" class="field__input" min="1" max="5" step="1" value="1" title="Jumlah pasien diproses bersamaan via API (1-5, tanpa DOM)" style="font-size: 11px; height: 32px; width: 100%;">
            </div>
          </div>

          <label class="field__toggle-label" style="font-size: 11px; cursor: pointer; display: flex; align-items: center; gap: 6px; color: #cbd5e1;">
            <input type="checkbox" id="dl-dry-run" style="cursor: pointer;">
            <span>Simulasi (Dry Run) — validasi NIK tanpa mendaftar</span>
          </label>
        </div>

        <!-- Source & Utility Buttons -->
        <div style="display: flex; flex-direction: column; gap: 6px;">
          <div style="display: flex; gap: 6px; align-items: center;">
            <button id="dl-btn-pick-excel" class="btn dl-btn-subtle" type="button" style="flex: 1.1; font-size: 11px; padding: 7px 6px; white-space: nowrap; color: #f8fafc !important; border-color: rgba(56, 189, 248, 0.35) !important;">
              📁 Pilih Excel
            </button>
            <button id="dl-btn-fetch-bankot" class="btn dl-btn-subtle" type="button" style="flex: 1.2; font-size: 11px; padding: 7px 6px; white-space: nowrap; color: #38bdf8 !important; border-color: rgba(56, 189, 248, 0.35) !important;">
              ☁ CKG Bankot
            </button>
            <button id="dl-btn-history" class="btn dl-btn-subtle" type="button" style="flex: 0.7; font-size: 11px; padding: 7px 6px; white-space: nowrap;">
              🕒 Log
            </button>
          </div>
          <div style="display: flex; gap: 6px; align-items: center;">
            <button id="dl-btn-download-template" class="btn dl-btn-subtle" type="button" style="flex: 1; font-size: 10.5px; padding: 6px 8px; white-space: nowrap;">
              ⬇ Template Excel
            </button>
            <button id="dl-btn-clear" class="btn dl-btn-danger-subtle" type="button" hidden style="font-size: 10.5px; padding: 6px 12px; white-space: nowrap;">
              Hapus Antrian
            </button>
          </div>
        </div>
      </div>

      <!-- Start / Stop selalu terlihat -->
      <div style="display: flex; gap: 6px;">
        <button id="dl-btn-start" class="btn btn--primary dl-btn-start" type="button" disabled style="width: 100%; font-size: 11.5px; padding: 8px 12px; font-weight: 700; white-space: nowrap; display: flex; align-items: center; justify-content: center;">
          ▶ Mulai Proses (Daftar &amp; Layani)
        </button>
        <button id="dl-btn-stop" class="btn btn--danger" type="button" hidden style="width: 100%; font-size: 11.5px; padding: 8px 12px; font-weight: 700; white-space: nowrap; display: none; align-items: center; justify-content: center;">
          ⏹ Hentikan Proses
        </button>
      </div>
      <input type="file" id="dl-excel-file" accept=".xlsx,.xls" hidden>

      <!-- History Drawer -->
      <div id="dl-history-drawer" class="dl-history-drawer" style="display: none;">
        <div class="dl-history-header">
          <span>🕒 Log Riwayat (Lanjutkan Sesi)</span>
          <button id="dl-btn-close-history" type="button" class="dl-page-btn" style="height: 20px; min-width: 20px; font-size: 10px;">✕</button>
        </div>
        <ul id="dl-history-list" class="dl-history-list"></ul>
      </div>

      <!-- Stats Metrics Strip -->
      <div id="dl-stats-bar" class="dl-stats-strip" style="display: none;">
        <div class="dl-stat-cell">
          <span class="dl-stat-label">Total</span>
          <span id="dl-stat-total" class="dl-stat-val">0</span>
        </div>
        <div class="dl-stat-cell">
          <span class="dl-stat-label">Terdaftar</span>
          <span id="dl-stat-reg" class="dl-stat-val dl-stat-val--blue">0</span>
        </div>
        <div class="dl-stat-cell">
          <span class="dl-stat-label">Selesai</span>
          <span id="dl-stat-done" class="dl-stat-val dl-stat-val--green">0</span>
        </div>
        <div class="dl-stat-cell">
          <span class="dl-stat-label">Gagal</span>
          <span id="dl-stat-err" class="dl-stat-val dl-stat-val--red">0</span>
        </div>
      </div>

      <p id="dl-status-msg" style="font-size: 11px; color: #94a3b8; margin: 0; min-height: 16px; line-height: 1.35;"></p>

      <!-- Filter Chips -->
      <div id="dl-filter-bar" class="dl-filter-bar" style="display: none;">
        <button type="button" class="dl-filter-chip dl-filter-chip--active" data-filter="all">Semua (0)</button>
        <button type="button" class="dl-filter-chip" data-filter="pending">Belum Entry (0)</button>
        <button type="button" class="dl-filter-chip" data-filter="already">Sudah Entry (0)</button>
        <button type="button" class="dl-filter-chip" data-filter="done">Selesai (0)</button>
        <button type="button" class="dl-filter-chip" data-filter="error">Error (0)</button>
      </div>

      <!-- Patient Roster List (max 10 per page) -->
      <ul id="dl-patient-list" style="display: none; margin: 0; padding: 0; list-style: none; flex-direction: column; gap: 5px;"></ul>

      <!-- Pagination Bar -->
      <div id="dl-pagination" class="dl-pagination" style="display: none;">
        <span id="dl-page-info" class="dl-page-info"></span>
        <div id="dl-page-controls" class="dl-page-controls"></div>
      </div>
    </div>
  `;

  // Elements
  const btnToggleSetup = container.querySelector("#dl-btn-toggle-setup");
  const setupSection = container.querySelector("#dl-setup-section");
  const setupSummary = container.querySelector("#dl-setup-summary");
  const selCategory = container.querySelector("#dl-category");
  const inputDate = container.querySelector("#dl-screening-date");
  const inputDelay = container.querySelector("#dl-delay");
  const inputConcurrent = container.querySelector("#dl-concurrent");
  const chkDryRun = container.querySelector("#dl-dry-run");
  const btnPickExcel = container.querySelector("#dl-btn-pick-excel");
  const btnFetchBankot = container.querySelector("#dl-btn-fetch-bankot");
  const btnHistory = container.querySelector("#dl-btn-history");
  const btnCloseHistory = container.querySelector("#dl-btn-close-history");
  const historyDrawer = container.querySelector("#dl-history-drawer");
  const historyListUl = container.querySelector("#dl-history-list");
  const btnDownloadTemplate = container.querySelector("#dl-btn-download-template");
  const btnStart = container.querySelector("#dl-btn-start");
  const btnStop = container.querySelector("#dl-btn-stop");
  const btnClear = container.querySelector("#dl-btn-clear");
  const fileInput = container.querySelector("#dl-excel-file");
  const statsBar = container.querySelector("#dl-stats-bar");
  const statTotal = container.querySelector("#dl-stat-total");
  const statReg = container.querySelector("#dl-stat-reg");
  const statDone = container.querySelector("#dl-stat-done");
  const statErr = container.querySelector("#dl-stat-err");
  const statusMsg = container.querySelector("#dl-status-msg");
  const filterBarEl = container.querySelector("#dl-filter-bar");
  const patientListUl = container.querySelector("#dl-patient-list");
  const paginationEl = container.querySelector("#dl-pagination");
  const pageInfoEl = container.querySelector("#dl-page-info");
  const pageControlsEl = container.querySelector("#dl-page-controls");

  // Set default date to today
  const now = new Date();
  inputDate.value = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0")
  ].join("-");
  inputDate.addEventListener("click", () => {
    try { inputDate.showPicker?.(); } catch (_) {}
  });

  function saveState() {
    chrome.storage.local.set({
      [STATE_KEY]: {
        patients,
        fileName: loadedFileName,
        category: selCategory.value,
        screeningDate: inputDate.value,
        delay: inputDelay.value,
        concurrent: inputConcurrent?.value || "1",
        dryRun: chkDryRun.checked,
        isSetupCollapsed
      }
    }).catch(() => {});
  }

  function updateStats() {
    let regCount = 0;
    let doneCount = 0;
    let errCount = 0;

    patients.forEach(p => {
      if (p._status === "done" || p._stage === "done") {
        doneCount++;
        regCount++;
      } else if (p._status === "already-screened") {
        regCount++;
      } else if (p.ticketNumber || p._stage === "pelayanan") {
        regCount++;
      } else if (p._status === "error" || p._status === "invalid-nik") {
        errCount++;
      }
    });

    statTotal.textContent = patients.length;
    statReg.textContent = regCount;
    statDone.textContent = doneCount;
    statErr.textContent = errCount;
  }

  function getRowParts(p) {
    let badgeCls = "progress-badge--waiting";
    let badgeText = "Menunggu";

    if (p._status === "in-progress") {
      badgeCls = "progress-badge--waiting";
      if (p._stage === "pendaftaran") {
        badgeText = "⏳ Mendaftar...";
      } else if (typeof p._progressPct === "number" && p._formStep) {
        badgeText = `⏳ ${p._progressPct}% (${p._formStep})`;
      } else {
        badgeText = "⏳ Memeriksa...";
      }
    } else if (p._status === "done" || p._stage === "done") {
      badgeCls = "progress-badge--done";
      badgeText = "✓ Selesai";
    } else if (p.ticketNumber && p._stage === "pelayanan") {
      badgeCls = "progress-badge--waiting";
      badgeText = `✓ Tiket: ${p.ticketNumber}`;
    } else if (p._status === "valid-dry-run") {
      badgeCls = "progress-badge--done";
      badgeText = "Valid (Dry Run)";
    } else if (p._status === "already-screened") {
      badgeCls = "progress-badge--waiting";
      badgeText = "Pernah Input";
    } else if (p._status === "invalid-nik" || p._status === "error") {
      badgeCls = "progress-badge--error";
      badgeText = isNonRetryableInvalid(p) ? "Tidak Valid" : "Gagal";
    }

    const ticketInfo = p.ticketNumber ? ` · Tiket: ${p.ticketNumber}` : "";
    let msgInfo = "";
    if (p._errorMsg) {
      const msgColor = p._status === "already-screened" ? "#fbbf24" : "#f87171";
      msgInfo = `<div style="font-size: 10px; color: ${msgColor}; margin-top: 2px;">${p._errorMsg}</div>`;
    } else if (p._status === "in-progress" && p._progressMsg) {
      const pctVal = typeof p._progressPct === "number" ? Math.max(0, Math.min(100, p._progressPct)) : 0;
      const barHtml = typeof p._progressPct === "number"
        ? `<div style="width: 100%; height: 4px; background: rgba(148,163,184,0.22); border-radius: 999px; overflow: hidden; margin-top: 3px;"><div style="width: ${pctVal}%; height: 100%; background: #38bdf8; transition: width 0.25s ease;"></div></div>`
        : "";
      msgInfo = `<div style="font-size: 10px; color: #38bdf8; margin-top: 2px;">${p._progressMsg}${barHtml}</div>`;
    }
    return { badgeCls, badgeText, ticketInfo, msgInfo };
  }

  function formatDisplayClass(rawClass) {
    const s = String(rawClass ?? "").trim();
    if (!s) return "";
    const explicitNum = s.match(/^\s*(?:kelas\s*)?(1[0-2]|[1-9])(?:\b|[a-zA-Z\-])/i) ||
      s.match(/\bkelas\s*(1[0-2]|[1-9])\b/i);
    if (explicitNum) return `Kelas ${parseInt(explicitNum[1], 10)}`;

    const romanMap = [
      ["XII", 12], ["XI", 11], ["X", 10],
      ["IX", 9], ["VIII", 8], ["VII", 7],
      ["VI", 6], ["IV", 4], ["V", 5], ["III", 3], ["II", 2], ["I", 1]
    ];
    const upper = s.toUpperCase();
    const leadRoman = upper.match(/^(?:KELAS\s*)?(XII|XI|IX|VIII|VII|VI|IV|III|II|X|V|I)(?:\b|[\s\-_])/);
    if (leadRoman) {
      const found = romanMap.find(([r]) => r === leadRoman[1]);
      if (found) return `Kelas ${found[1]}`;
    }
    const tokens = upper.split(/[\s\-_\/]+/);
    for (const [roman, num] of romanMap) {
      if (tokens.includes(roman)) return `Kelas ${num}`;
    }
    const anyNum = s.match(/\b(1[0-2]|[1-9])\b/);
    return anyNum ? `Kelas ${parseInt(anyNum[1], 10)}` : s;
  }

  function renderRowInner(p, idx) {
    const { badgeCls, badgeText, ticketInfo, msgInfo } = getRowParts(p);
    const schoolName = String(p.sekolah ?? p.nama_sekolah ?? p.school_name ?? "").trim();
    const classLabel = formatDisplayClass(p.kelas ?? p.class_name ?? p.tingkat ?? p.rombel ?? "");
    const schoolLine = [schoolName, classLabel].filter(Boolean).join(" · ");
    const schoolHtml = schoolLine
      ? `<span class="dl-patient-meta" style="color: #7dd3fc; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">🏫 ${schoolLine}</span>`
      : "";
    return `
      <div class="dl-patient-info">
        <span class="dl-patient-name">
          ${idx + 1}. ${p.nama || "(tanpa nama)"}
        </span>
        <span class="dl-patient-meta">
          NIK: ${p.nik || "—"}${ticketInfo}
        </span>
        ${schoolHtml}
        ${msgInfo}
      </div>
      <span class="progress-badge ${badgeCls}" style="flex-shrink: 0; font-size: 10px; padding: 2px 8px; border-radius: 4px;">${badgeText}</span>
    `;
  }

  function isNonRetryableInvalid(p) {
    if (!p) return false;
    if (p._status === "invalid-nik") return true;
    const msg = String(p._errorMsg || "").toLowerCase();
    return msg.includes("data peserta tidak valid") || msg.includes("data tidak valid");
  }

  function getPatientFilterCategory(p) {
    if (p._status === "done" || p._stage === "done") return "done";
    if (p._status === "already-screened") return "already";
    if (p._status === "error" || p._status === "invalid-nik") return "error";
    return "pending";
  }

  function renderFilterBar() {
    if (!patients.length) {
      filterBarEl.style.display = "none";
      return { all: 0, pending: 0, already: 0, done: 0, error: 0 };
    }
    const counts = { all: patients.length, pending: 0, already: 0, done: 0, error: 0 };
    for (const p of patients) {
      counts[getPatientFilterCategory(p)]++;
    }
    filterBarEl.style.display = "flex";
    const labels = {
      all: `Semua (${counts.all})`,
      pending: `Belum Entry (${counts.pending})`,
      already: `Sudah Entry (${counts.already})`,
      done: `Selesai (${counts.done})`,
      error: `Error (${counts.error})`
    };
    filterBarEl.querySelectorAll(".dl-filter-chip").forEach(btn => {
      const f = btn.dataset.filter;
      btn.textContent = labels[f] || f;
      btn.classList.toggle("dl-filter-chip--active", f === activeFilter);
    });
    const retryableErrors = patients.filter(
      p => getPatientFilterCategory(p) === "error" && !isNonRetryableInvalid(p)
    ).length;
    const filterTitleMap = {
      all: "Daftar & Layani",
      pending: `Belum Entry (${counts.pending})`,
      already: `Sudah Entry (${counts.already})`,
      done: `Selesai (${counts.done})`,
      error: `Ulangi Error (${retryableErrors})`
    };
    btnStart.textContent = `▶ Mulai Proses (${filterTitleMap[activeFilter] || "Daftar & Layani"})`;
    return counts;
  }

  function renderPagination(totalPages, startIdx, endIdx, totalFiltered) {
    if (totalPages <= 1) {
      paginationEl.style.display = "none";
      return;
    }
    paginationEl.style.display = "flex";
    pageInfoEl.textContent = `${startIdx + 1}–${endIdx} / ${totalFiltered}`;

    const pages = [];
    if (totalPages <= 5) {
      for (let i = 1; i <= totalPages; i++) pages.push(i);
    } else {
      pages.push(1);
      if (currentPage > 3) pages.push("...");
      const start = Math.max(2, currentPage - 1);
      const end = Math.min(totalPages - 1, currentPage + 1);
      for (let i = start; i <= end; i++) pages.push(i);
      if (currentPage < totalPages - 2) pages.push("...");
      pages.push(totalPages);
    }

    const prevBtn = `<button type="button" class="dl-page-btn" data-page="${currentPage - 1}" ${currentPage === 1 ? "disabled" : ""}>◀</button>`;
    const nextBtn = `<button type="button" class="dl-page-btn" data-page="${currentPage + 1}" ${currentPage === totalPages ? "disabled" : ""}>▶</button>`;
    const numBtns = pages.map(pg =>
      pg === "..."
        ? `<span style="font-size: 10px; color: #64748b; padding: 0 2px;">…</span>`
        : `<button type="button" class="dl-page-btn ${pg === currentPage ? "dl-page-btn--active" : ""}" data-page="${pg}">${pg}</button>`
    ).join("");

    pageControlsEl.innerHTML = prevBtn + numBtns + nextBtn;
  }

  function renderList(updatedIndex = null) {
    if (!patients.length) {
      patientListUl.style.display = "none";
      statsBar.style.display = "none";
      filterBarEl.style.display = "none";
      paginationEl.style.display = "none";
      btnClear.hidden = true;
      btnStart.disabled = true;
      return;
    }

    updateStats();
    renderFilterBar();
    statsBar.style.display = "grid";
    btnClear.hidden = isRunning;
    btnStart.disabled = isRunning;

    if (activeFilter === "all" && typeof updatedIndex === "number" && patients[updatedIndex]) {
      const existingRow = document.getElementById(`dl-row-${updatedIndex}`);
      if (existingRow) {
        existingRow.innerHTML = renderRowInner(patients[updatedIndex], updatedIndex);
        return;
      }
    }

    const filteredEntries = patients
      .map((p, origIdx) => ({ p, origIdx }))
      .filter(entry => activeFilter === "all" || getPatientFilterCategory(entry.p) === activeFilter);

    const totalFiltered = filteredEntries.length;
    const totalPages = Math.max(1, Math.ceil(totalFiltered / PAGE_SIZE));
    if (currentPage > totalPages) currentPage = totalPages;
    if (currentPage < 1) currentPage = 1;

    const startIdx = (currentPage - 1) * PAGE_SIZE;
    const endIdx = Math.min(totalFiltered, startIdx + PAGE_SIZE);

    patientListUl.style.display = "flex";
    renderPagination(totalPages, startIdx, endIdx, totalFiltered);

    if (totalFiltered === 0) {
      patientListUl.innerHTML = `<li style="text-align:center; padding: 14px; font-size: 11px; color: #64748b;">Tidak ada pasien pada filter ini.</li>`;
      return;
    }

    patientListUl.innerHTML = filteredEntries
      .slice(startIdx, endIdx)
      .map(({ p, origIdx }) =>
        `<li class="dl-patient-item" id="dl-row-${origIdx}">${renderRowInner(p, origIdx)}</li>`
      )
      .join("");
  }

  filterBarEl.addEventListener("click", (e) => {
    const btn = e.target.closest(".dl-filter-chip[data-filter]");
    if (!btn) return;
    const nextFilter = btn.dataset.filter;
    if (nextFilter && nextFilter !== activeFilter) {
      activeFilter = nextFilter;
      currentPage = 1;
      renderList();
    }
  });

  pageControlsEl.addEventListener("click", (e) => {
    const btn = e.target.closest(".dl-page-btn[data-page]");
    if (!btn || btn.disabled) return;
    const nextPage = parseInt(btn.dataset.page, 10);
    if (!Number.isNaN(nextPage)) {
      currentPage = nextPage;
      renderList();
    }
  });

  function setRunningUI(running) {
    isRunning = running;
    btnStart.disabled = running || !patients.length;
    btnStart.style.display = running ? "none" : "flex";
    btnStop.hidden = !running;
    btnStop.style.display = running ? "flex" : "none";
    btnPickExcel.disabled = running;
    btnClear.hidden = running || !patients.length;
  }

  function applySetupVisibility() {
    if (!setupSection || !btnToggleSetup) return;
    setupSection.style.display = isSetupCollapsed ? "none" : "flex";
    btnToggleSetup.textContent = isSetupCollapsed ? "▼ Tampilkan Pengaturan" : "▲ Sembunyikan";
    if (setupSummary) {
      setupSummary.textContent = isSetupCollapsed
        ? `${selCategory.value} · ${inputDate.value || "-"} · ${loadedFileName || "Belum ada file"}`
        : "Pengaturan & Sumber Data";
    }
  }

  btnToggleSetup?.addEventListener("click", () => {
    isSetupCollapsed = !isSetupCollapsed;
    applySetupVisibility();
    saveState();
  });

  // Events
  btnPickExcel.addEventListener("click", () => fileInput.click());

  async function renderHistoryDrawer() {
    historyListUl.innerHTML = `<li style="font-size: 10.5px; color: #94a3b8; padding: 6px;">Memuat riwayat...</li>`;
    await syncCloudR2History("pasien").catch(() => {});
    const logs = (await getHistory("pasien").catch(() => [])) || [];
    if (!logs.length) {
      historyListUl.innerHTML = `<li style="font-size: 10.5px; color: #64748b; padding: 8px; text-align: center;">Belum ada log riwayat tersimpan.</li>`;
      return;
    }

    historyListUl.innerHTML = logs.slice(0, 20).map(entry => {
      const total = entry.total || entry.data?.length || 0;
      const done = entry.berhasil || 0;
      const already = entry.pernahInput || 0;
      const err = entry.gagal || 0;
      const dateStr = formatLogDate(entry.timestamp);
      return `
        <li class="dl-history-item" data-log-id="${entry.id}">
          <div class="dl-history-meta">
            <span class="dl-history-title">${entry.fileName || "Sesi Daftar & Layani"}</span>
            <span class="dl-history-sub">${dateStr} · Total ${total} (✓${done} · ↺${already} · ✕${err})</span>
          </div>
          <div style="display: flex; gap: 4px; flex-shrink: 0;">
            <button type="button" class="dl-page-btn dl-history-load" data-log-id="${entry.id}" style="padding: 0 8px; background: rgba(2,132,199,0.35); border-color: #38bdf8; color: #f8fafc;">Lanjutkan</button>
            <button type="button" class="dl-page-btn dl-history-del" data-log-id="${entry.id}" style="color: #fca5a5;">✕</button>
          </div>
        </li>
      `;
    }).join("");
  }

  btnHistory.addEventListener("click", async () => {
    const isHidden = historyDrawer.style.display === "none";
    historyDrawer.style.display = isHidden ? "flex" : "none";
    if (isHidden) {
      await renderHistoryDrawer();
    }
  });

  btnCloseHistory.addEventListener("click", () => {
    historyDrawer.style.display = "none";
  });

  historyListUl.addEventListener("click", async (e) => {
    const loadBtn = e.target.closest(".dl-history-load");
    if (loadBtn) {
      if (isRunning) {
        alert("Hentikan proses yang sedang berjalan terlebih dahulu.");
        return;
      }
      const logId = loadBtn.dataset.logId;
      const logs = (await getHistory("pasien").catch(() => [])) || [];
      const entry = logs.find(l => l.id === logId);
      if (!entry || !Array.isArray(entry.data) || !entry.data.length) {
        statusMsg.textContent = "Data pasien pada log ini kosong.";
        return;
      }
      patients = entry.data.map(p => ({
        ...p,
        nama: sanitizeName(p.nama || p.name || ""),
        _status: p._status === "in-progress" ? "idle" : (p._status || "idle"),
        _progressMsg: "",
        _progressPct: null,
        _formStep: ""
      }));
      loadedFileName = entry.fileName || "Log Riwayat";
      if (entry.category) selCategory.value = entry.category;
      activeFilter = "all";
      currentPage = 1;
      await setActiveLogId("pasien", entry.id).catch(() => {});
      saveState();
      renderList();
      historyDrawer.style.display = "none";
      const sisa = patients.filter(p => p._status !== "done" && p._status !== "already-screened").length;
      statusMsg.textContent = `Log "${loadedFileName}" dimuat (${patients.length} pasien, ${sisa} belum selesai).`;
      return;
    }

    const delBtn = e.target.closest(".dl-history-del");
    if (delBtn) {
      const logId = delBtn.dataset.logId;
      await deleteLogEntry("pasien", logId).catch(() => {});
      await renderHistoryDrawer();
    }
  });

  btnFetchBankot.addEventListener("click", async () => {
    if (isRunning) return;
    const cat = selCategory.value || "UMUM";
    btnFetchBankot.disabled = true;
    const origText = btnFetchBankot.textContent;
    btnFetchBankot.textContent = "⏳ Mengambil...";
    statusMsg.textContent = `Mengambil antrian bot (${cat}) dari ckgbankot.web.id...`;

    try {
      let res = await fetchBotQueueFromCkgbankot(cat, "antre");
      if (res.success && (!res.data || !res.data.length)) {
        // Cek juga status 'pendaftaran' jika 'antre' kosong
        const resPend = await fetchBotQueueFromCkgbankot(cat, "pendaftaran");
        if (resPend.success && resPend.data?.length) res = resPend;
      }

      if (!res.success) {
        statusMsg.textContent = `Gagal ambil antrian CKG Bankot: ${res.error || "Unknown error"}`;
        return;
      }

      if (!res.data || !res.data.length) {
        statusMsg.textContent = `Antrian bot (${cat}) di ckgbankot.web.id kosong untuk petugas Anda.`;
        return;
      }

      const normalized = res.data.map(r => ({
        ...r,
        nama: sanitizeName(r.nama || r.name || ""),
        _status: "idle",
        _stage: "menunggu"
      }));

      const { validRows, skippedCount, reasons } = filterValidIdentityRows(normalized, {
        dedupeNik: true,
        checkDobGender: false
      });

      if (!validRows.length) {
        const skipSummary = formatSkippedIdentitySummary(reasons);
        statusMsg.textContent = skipSummary
          ? `Tidak ada data valid dari CKG Bankot (${skippedCount} dilewati: ${skipSummary}).`
          : "Tidak ada data pasien yang valid dari antrian CKG Bankot.";
        return;
      }

      patients = validRows;
      loadedFileName = `CKG Bankot (${cat})`;
      activeFilter = "all";
      currentPage = 1;
      const skipSummary = formatSkippedIdentitySummary(reasons);
      statusMsg.textContent = skippedCount > 0
        ? `${patients.length} pasien dimuat dari CKG Bankot (${skippedCount} dilewati: ${skipSummary}).`
        : `${patients.length} pasien berhasil dimuat dari antrian CKG Bankot (${res.petugas || "petugas"}).`;

      renderList();
      saveState();

      addLogEntry("pasien", {
        fileName: `[One-Stop] ${loadedFileName}`,
        category: cat,
        total: patients.length,
        berhasil: 0,
        gagal: 0,
        sebagian: 0,
        pernahInput: 0,
        status: "idle",
        data: patients
      }).catch(() => {});
    } catch (err) {
      statusMsg.textContent = "Error ambil antrian CKG Bankot: " + err.message;
    } finally {
      btnFetchBankot.disabled = false;
      btnFetchBankot.textContent = origText;
    }
  });

  btnDownloadTemplate.addEventListener("click", () => {
    const url = chrome.runtime.getURL(
      selCategory.value === "SEKOLAH" ? "TEMPLATE BOT CKG SEKOLAH.xlsx" : "TEMPLATE BOT CKG.xlsx"
    );
    chrome.tabs.create({ url });
  });

  btnClear.addEventListener("click", () => {
    if (isRunning) return;
    patients = [];
    currentPage = 1;
    statusMsg.textContent = "";
    chrome.storage.local.remove([STATE_KEY]).catch(() => {});
    chrome.storage.session.remove([STATE_KEY]).catch(() => {});
    renderList();
  });

  fileInput.addEventListener("change", (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";

    const reader = new FileReader();
    reader.onload = (evt) => {
      try {
        const XLSX = window.XLSX;
        const wb = XLSX.read(evt.target.result, { type: "array" });
        const sheet = wb.Sheets[wb.SheetNames[0]];
        const rawJson = XLSX.utils.sheet_to_json(sheet, { defval: "", raw: false });

        const mappedRows = rawJson.map(row => {
          const clean = {};
          for (const [k, v] of Object.entries(row)) {
            clean[k.toLowerCase().replace(/[^a-z0-9]/g, "")] = v;
          }
          const nikVal = String(clean.nik || clean.nonik || clean.nomoridentitas || clean.noktp || "").replace(/[^0-9]/g, "");
          const dobVal = clean.tanggallahir || clean.tgllahir || clean.tgl || clean.birthdate || "";
          const genderVal = clean.jeniskelamin || clean.jk || clean.gender || clean.sex || "";
          const rawWaStr = String(clean.nowhatsapp || clean.nowa || clean.nomorwa || clean.nohp || clean.hp || clean.wa || clean.telp || "").trim();
          const waDigits = rawWaStr.replace(/\D/g, "").replace(/^0+/, "");
          const waVal = waDigits.length >= 6 ? rawWaStr : "081225566666";
          const maritalVal = clean.statusnikah || clean.statuspernikahan || clean.statusperkawinan || clean.statusmenikah || clean.maritalstatus || "";
          const cleanOpt = v => {
            const s = String(v ?? "").trim();
            return !s || s === "-" ? "" : s;
          };

          return {
            ...clean,
            nama: sanitizeName(clean.nama || clean.name || clean.namalengkap || clean.namapasien || ""),
            nik: nikVal,
            tanggal_lahir: dobVal,
            tanggallahir: dobVal,
            jenis_kelamin: genderVal,
            jeniskelamin: genderVal,
            nowhatsapp: waVal,
            status_pernikahan: maritalVal,
            statusperkawinan: maritalVal,
            kab_kota: clean.kabkota || clean.kabupaten || clean.kota || "",
            td_sistolik: cleanOpt(clean.tdsistolik || clean.tekanandarahsistolik || clean.sistole || clean.sistolik),
            td_diastolik: cleanOpt(clean.tddiastolik || clean.tekanandarahdiastolik || clean.diastole || clean.diastolik),
            gula_darah: cleanOpt(clean.guladarah || clean.guladarahsewaktu || clean.gds || clean.gd),
            hb: cleanOpt(clean.hb),
            merokok: cleanOpt(clean.merokok || clean.perilakumerokok || clean.riwayatmerokok || clean.rokok),
            telinga: cleanOpt(clean.telinga || clean.serumentelinga),
            mata: cleanOpt(clean.mata),
            gigi: cleanOpt(clean.gigi || clean.caries || clean.karies),
            _status: "idle",
            _stage: "menunggu",
            ticketNumber: null,
            _errorMsg: ""
          };
        });

        const { validRows, skippedCount, reasons } = filterValidIdentityRows(mappedRows, {
          dedupeNik: true,
          checkDobGender: true
        });
        patients = validRows;

        const skipSummary = formatSkippedIdentitySummary(reasons);

        if (!patients.length) {
          statusMsg.textContent = skipSummary
            ? `Tidak ada data pasien valid (${skippedCount} baris dilewati: ${skipSummary}).`
            : "Tidak ada data pasien yang valid di file Excel ini.";
          btnStart.disabled = true;
          renderList();
          return;
        }

        loadedFileName = file.name || "Daftar & Layani Excel";
        currentPage = 1;
        statusMsg.textContent = skippedCount > 0
          ? `${patients.length} pasien valid dimuat (${skippedCount} baris dilewati: ${skipSummary}).`
          : `${patients.length} pasien berhasil dimuat dari Excel.`;
        btnStart.disabled = false;
        renderList();
        saveState();

        addLogEntry("pasien", {
          fileName: `[One-Stop] ${loadedFileName}`,
          category: selCategory.value || "UMUM",
          total: patients.length,
          berhasil: 0,
          gagal: 0,
          sebagian: 0,
          pernahInput: 0,
          status: "idle",
          data: patients
        }).catch(err => console.warn("[daftar-layani] addLogEntry error:", err));
      } catch (err) {
        statusMsg.textContent = "Gagal membaca file Excel: " + err.message;
      }
    };
    reader.readAsArrayBuffer(file);
  });

  btnStart.addEventListener("click", async () => {
    if (isRunning || !patients.length) return;

    const screeningDate = inputDate.value;
    if (!screeningDate) {
      alert("Tanggal pemeriksaan wajib diisi!");
      return;
    }

    const category = selCategory.value;
    const delayMs = Math.round(1000 * parseFloat(inputDelay.value || "1.5"));
    const rawConc = parseInt(inputConcurrent?.value || "1", 10);
    const concurrentLimit = isNaN(rawConc) || rawConc < 1 ? 1 : rawConc > 5 ? 5 : rawConc;
    if (inputConcurrent) inputConcurrent.value = String(concurrentLimit);

    const filterLabelMap = {
      all: "Semua Belum Selesai",
      pending: "Belum Entry",
      already: "Sudah Entry",
      done: "Selesai",
      error: "Error"
    };

    const jobs = patients
      .map((p, idx) => ({
        index: idx,
        ...p,
        screening_date: screeningDate,
        is_school: category === "SEKOLAH"
      }))
      .filter(j => {
        if (activeFilter === "all") {
          return j._status !== "done" && j._status !== "already-screened" && !isNonRetryableInvalid(j);
        }
        if (activeFilter === "pending") {
          return getPatientFilterCategory(j) === "pending";
        }
        if (activeFilter === "error") {
          return getPatientFilterCategory(j) === "error" && !isNonRetryableInvalid(j);
        }
        // Tab "already" / "done" tidak dijalankan ulang agar tidak duplikasi
        return false;
      });

    if (!jobs.length) {
      statusMsg.textContent =
        activeFilter === "done" || activeFilter === "already"
          ? `Pasien di tab "${filterLabelMap[activeFilter]}" sudah selesai / pernah input.`
          : `Tidak ada pasien yang perlu diproses pada tab "${filterLabelMap[activeFilter]}".`;
      return;
    }

    const dryRun = chkDryRun.checked;
    if (!dryRun && jobs.length > 0) {
      const confirmRun = confirm(
        `PERINGATAN: ONE-STOP CKG AKAN DIJALANKAN!\n\n` +
        `Tab Filter: ${filterLabelMap[activeFilter]}\n` +
        `Sebanyak ${jobs.length} pasien akan:\n` +
        `1. DIDAFTARKAN BARU ke server CKG Kemkes\n` +
        `2. LANGSUNG DIPERIKSA dan DISELESAIKAN layanannya.\n\n` +
        `Lanjutkan proses sekarang?`
      );
      if (!confirmRun) return;
    }

    setRunningUI(true);
    statusMsg.textContent = `Memulai proses (${filterLabelMap[activeFilter]}: ${jobs.length} pasien)...`;

    try {
      const res = await chrome.runtime.sendMessage({
        type: "RUN_DAFTAR_LAYANI_BATCH",
        rows: jobs,
        category,
        screeningDate,
        delayMs,
        concurrentLimit,
        dryRun
      });

      if (!res?.ok) {
        statusMsg.textContent = "Gagal memulai: " + (res?.error || "Unknown error");
        setRunningUI(false);
      }
    } catch (err) {
      statusMsg.textContent = "Error: " + err.message;
      setRunningUI(false);
    }
  });

  btnStop.addEventListener("click", async () => {
    setRunningUI(false);
    statusMsg.textContent = "Proses dihentikan oleh pengguna.";
    await chrome.runtime.sendMessage({ type: "DAFTAR_LAYANI_STOP" }).catch(() => {});
    renderList();
  });

  // Listener pesan progress dari background
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "DAFTAR_LAYANI_PROGRESS") {
      const { index, stage, status, ticketNumber, message, formIndex, formTotal, formName, percent, isFinished, wasStopped } = msg;
      if (typeof index === "number" && patients[index]) {
        if (stage) patients[index]._stage = stage;
        if (status) patients[index]._status = status === "success" ? (stage === "done" || stage === "layani" ? "done" : "idle") : status;
        if (ticketNumber) {
          patients[index].ticketNumber = ticketNumber;
          patients[index]._nomorTiket = ticketNumber;
          patients[index].no_tiket = ticketNumber;
        }
        if (status === "error" || status === "invalid-nik") {
          patients[index]._errorMsg = message || "Gagal";
          patients[index]._progressMsg = "";
          patients[index]._progressPct = null;
          patients[index]._formStep = "";
        } else if (status === "already-screened") {
          patients[index]._errorMsg = message || "Sudah pernah skrining";
          patients[index]._progressMsg = "";
          patients[index]._progressPct = null;
          patients[index]._formStep = "";
        } else if (status === "in-progress") {
          patients[index]._errorMsg = "";
          patients[index]._progressMsg = formName ? `Mengisi: ${formName}` : (message || "");
          patients[index]._progressPct = typeof percent === "number" ? percent : null;
          patients[index]._formStep = formIndex && formTotal ? `${formIndex}/${formTotal}` : "";
          const pName = patients[index].nama || `Pasien #${index + 1}`;
          statusMsg.textContent = `[${index + 1}/${patients.length}] ${pName} — ${message || "Memproses..."}`;
        } else {
          patients[index]._errorMsg = "";
          patients[index]._progressMsg = "";
          patients[index]._progressPct = typeof percent === "number" ? percent : null;
          patients[index]._formStep = "";
        }
      }

      updateStats();
      if (activeFilter === "all" && typeof index === "number") {
        const targetPage = Math.floor(index / PAGE_SIZE) + 1;
        if (currentPage !== targetPage) {
          currentPage = targetPage;
          renderList();
        } else {
          renderList(index);
        }
      } else {
        renderList();
      }

      if (typeof index === "number") {
        const targetRow = document.getElementById(`dl-row-${index}`);
        if (targetRow) targetRow.scrollIntoView({ block: "nearest" });
      }

      if (!chkDryRun.checked && patients.length > 0 && (isFinished || (typeof index === "number" && status !== "in-progress"))) {
        const berhasil = patients.filter(p => p._status === "done" || p._stage === "done").length;
        const pernahInput = patients.filter(p => p._status === "already-screened").length;
        const gagal = patients.filter(p => p._status === "error" || p._status === "invalid-nik").length;
        const logStatus = isFinished
          ? (wasStopped ? "paused" : gagal > 0 ? "has-error" : "completed")
          : "running";
        updateActiveLog("pasien", {
          fileName: loadedFileName ? `[One-Stop] ${loadedFileName}` : "[One-Stop] Daftar & Layani",
          category: selCategory.value || "UMUM",
          total: patients.length,
          berhasil,
          gagal,
          sebagian: 0,
          pernahInput,
          status: logStatus,
          data: patients
        }).catch(() => {});
      }

      if (isFinished) {
        setRunningUI(false);
        statusMsg.textContent = wasStopped
          ? "Proses dihentikan oleh pengguna."
          : "Semua proses Daftar & Layani telah selesai!";
      } else if (typeof index === "number" && status !== "in-progress") {
        statusMsg.textContent = `Memproses pasien ${index + 1}/${patients.length}: ${patients[index]?.nama || ""} (${message || ""})`;
      }
      saveState();
    }
  });

  // Restore state (persisten di storage.local agar tahan reload ekstensi / restart browser)
  chrome.storage.local.get(STATE_KEY).then(async res => {
    let data = res?.[STATE_KEY];
    if (!data) {
      const sess = await chrome.storage.session.get(STATE_KEY).catch(() => ({}));
      data = sess?.[STATE_KEY];
    }
    if (data) {
      if (Array.isArray(data.patients)) {
        patients = data.patients.map(p => ({
          ...p,
          nama: sanitizeName(p.nama || p.name || ""),
          // Jika terputus di tengah saat in-progress sebelum reload, kembalikan ke idle agar bisa dilanjutkan
          _status: p._status === "in-progress" ? "idle" : (p._status || "idle"),
          _progressMsg: "",
          _progressPct: null,
          _formStep: ""
        }));
      }
      if (data.fileName) loadedFileName = data.fileName;
      if (data.category) selCategory.value = data.category;
      if (data.screeningDate) inputDate.value = data.screeningDate;
      if (data.delay) inputDelay.value = data.delay;
      if (data.concurrent && inputConcurrent) {
        const c = parseInt(data.concurrent, 10);
        inputConcurrent.value = String(isNaN(c) || c < 1 ? 1 : c > 5 ? 5 : c);
      }
      if (typeof data.dryRun === "boolean") chkDryRun.checked = data.dryRun;
      if (typeof data.isSetupCollapsed === "boolean") isSetupCollapsed = data.isSetupCollapsed;
      applySetupVisibility();
      renderList();
      if (patients.length > 0) {
        const sisa = patients.filter(p => p._status !== "done" && p._status !== "already-screened").length;
        statusMsg.textContent = sisa > 0
          ? `History dimuat: ${patients.length} pasien (${sisa} belum selesai, siap dilanjutkan).`
          : `History dimuat: semua ${patients.length} pasien sudah selesai.`;
      }
    }
  }).catch(() => {});
}
