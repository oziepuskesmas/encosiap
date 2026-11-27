import { getPendaftaranRecords, clearPendaftaranRecords, insertPendaftaranRecord, syncPendaftaranPatientsToDatabase } from "../auth.js";
import { addLogEntry, updateActiveLog, setActiveLogId, getHistory, getActiveLogId, deleteLogEntry } from "../services/historyService.js";
import { downloadTemplateFile } from "../services/templateService.js";
import { scanPelayananTable } from "../services/pelayananScanner.js";
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
import { getAgeCategory, matchesPelayananStatus } from "../services/filterHelper.js";

function parseDate(dateStr) {
  if (!dateStr) {
    const now = new Date();
    return { tahun: now.getFullYear(), bulan: now.getMonth() + 1, hari: now.getDate() };
  }
  const date = new Date(dateStr);
  if (isNaN(date.getTime())) {
    const now = new Date();
    return { tahun: now.getFullYear(), bulan: now.getMonth() + 1, hari: now.getDate() };
  }
  return { tahun: date.getFullYear(), bulan: date.getMonth() + 1, hari: date.getDate() };
}

export function init({ checkDeviceOrSignOut, getPendaftaranPatients } = {}) {
  const containerEl = document.getElementById("pelayanan-instan-container");
  let records = [];
  let isInitialized = false;
  let concurrentLimit = 1;
  let selectedCategory = "EXCEL_SEKOLAH";
  let pelayananInstanMode = null; // null | "EXCEL_SEKOLAH" | "EXCEL_UMUM" | "UMUM" | "SEKOLAH"
  let selectedSekolah = "";
  let selectedKelas = "";
  let selectedAge = "ALL";
  let selectedStatus = "ALL";
  let currentInstanPage = 1;
  const INSTAN_PAGE_SIZE = 50;

  const STORAGE_INIT_KEY = "pelayanan-instan-initialized";

  function isRecordError(r) {
    if (!r) return false;
    return r.status === "MISSING" || r.status === "SERVER_ERROR" || r.status === "error" || r._status === "error";
  }

  function isRecordDone(r) {
    if (!r) return false;
    if (isRecordError(r)) return false;
    return r.status === "DONE_PELAYANAN" || r.status === "ALREADY_SCREENED" || (r._status === "done" && r.status !== "DONE_PENDAFTARAN") || r._status === "already-screened";
  }

  function normalizeRecords(list) {
    if (!list || !list.length) return;
    list.forEach(r => {
      // Jika statusnya baru selesai pendaftaran, status antrean pelayanannya harus idle / siap
      if (r.status === "DONE_PENDAFTARAN" && (r._status === "done" || !r._status)) {
        r._status = "idle";
      } else if (r.status === "DONE_PELAYANAN" && (!r._status || r._status === "idle")) {
        r._status = "done";
      } else if (r.status === "PARTIAL_DONE_PELAYANAN" && (!r._status || r._status === "idle")) {
        r._status = "partial";
      } else if (r.status === "ALREADY_SCREENED" && (!r._status || r._status === "idle")) {
        r._status = "already-screened";
      }
      if (isRecordError(r) && r._status !== "in-progress") {
        r._status = "error";
      }
    });
  }

  // Footer Bulk Row
  const bulkFooterRow = document.createElement("div");
  bulkFooterRow.id = "pelayanan-instan-footer-row";
  bulkFooterRow.className = "field field--button";
  bulkFooterRow.style.cssText = "display:flex;align-items:center;justify-content:center;gap:8px;";
  bulkFooterRow.hidden = true;

  const btnStartBulk = document.createElement("button");
  btnStartBulk.type = "button";
  btnStartBulk.id = "btn-start-instan";
  btnStartBulk.className = "btn btn--primary";
  btnStartBulk.innerHTML = `
    <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" style="flex-shrink:0">
      <polygon points="5 3 19 12 5 21 5 3"/>
    </svg>
    <span>Mulai Otomasi</span>
  `;

  const btnPauseBulk = document.createElement("button");
  btnPauseBulk.type = "button";
  btnPauseBulk.id = "btn-pause-instan";
  btnPauseBulk.className = "btn btn--warning";
  btnPauseBulk.style.display = "none";
  btnPauseBulk.innerHTML = `
    <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" style="flex-shrink:0">
      <rect x="6" y="4" width="4" height="16"/>
      <rect x="14" y="4" width="4" height="16"/>
    </svg>
    <span>Jeda</span>
  `;

  const btnStopBulk = document.createElement("button");
  btnStopBulk.type = "button";
  btnStopBulk.id = "btn-stop-instan";
  btnStopBulk.className = "btn btn--danger";
  btnStopBulk.style.display = "none";
  btnStopBulk.innerHTML = `
    <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" style="flex-shrink:0">
      <rect x="4" y="4" width="16" height="16"/>
    </svg>
    <span>Stop Otomasi</span>
  `;

  const btnRestartError = document.createElement("button");
  btnRestartError.type = "button";
  btnRestartError.id = "btn-restart-error-instan";
  btnRestartError.className = "btn btn--warning";
  btnRestartError.style.display = "none";
  btnRestartError.innerHTML = `
    <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="flex-shrink:0">
      <polyline points="23 4 23 10 17 10"/>
      <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
    </svg>
    <span>Periksa Ulang Error</span>
  `;

  const concurrentInput = document.createElement("input");
  concurrentInput.type = "number";
  concurrentInput.min = "1";
  concurrentInput.max = "5";
  concurrentInput.value = "1";
  concurrentInput.className = "instan-concurrent-input";
  concurrentInput.title = "Jumlah pasien yang diproses paralel via API (1-5, tanpa DOM)";
  concurrentInput.addEventListener("change", () => {
    const val = parseInt(concurrentInput.value, 10);
    concurrentLimit = isNaN(val) || val < 1 ? 1 : val > 5 ? 5 : val;
    concurrentInput.value = String(concurrentLimit);
    chrome.storage.local.set({ "pelayanan-concurrent-limit": concurrentLimit });
    chrome.storage.session.set({ pelayananConcurrentLimit: concurrentLimit });
  });

  bulkFooterRow.appendChild(btnStartBulk);
  bulkFooterRow.appendChild(btnPauseBulk);
  bulkFooterRow.appendChild(btnStopBulk);
  bulkFooterRow.appendChild(btnRestartError);
  bulkFooterRow.appendChild(concurrentInput);

  // Footer Excel Row
  const excelFooterRow = document.createElement("div");
  excelFooterRow.id = "pelayanan-instan-excel-footer-row";
  excelFooterRow.className = "field field--button excel-actions-grid";
  excelFooterRow.hidden = true;

  const btnDownloadTemplate = document.createElement("button");
  btnDownloadTemplate.type = "button";
  btnDownloadTemplate.className = "btn btn--secondary pendaftaran-fab__btn";
  btnDownloadTemplate.innerHTML = `
    <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="flex-shrink:0">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
    </svg>
    <span>Download Template</span>
  `;
  btnDownloadTemplate.addEventListener("click", () => {
    downloadTemplateFile(selectedCategory === "EXCEL_SEKOLAH" ? "SEKOLAH" : "UMUM");
  });

  const btnUploadExcel = document.createElement("button");
  btnUploadExcel.type = "button";
  btnUploadExcel.className = "btn btn--primary pendaftaran-fab__btn";
  btnUploadExcel.innerHTML = `
    <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="flex-shrink:0">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>
    </svg>
    <span>Upload Excel</span>
  `;

  const excelFileInput = document.createElement("input");
  excelFileInput.type = "file";
  excelFileInput.accept = ".xlsx,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel";
  excelFileInput.style.display = "none";
  btnUploadExcel.addEventListener("click", () => excelFileInput.click());

  const COLUMN_MAPPINGS = {
    nik: "nik", nonik: "nik", nikpasien: "nik",
    nama: "nama", name: "nama", namalengkap: "nama", namapasien: "nama", namasiswa: "nama",
    bb: "bb", beratbadan: "bb", beratbadankg: "bb", bbkg: "bb", berat: "bb",
    tb: "tb", tinggibadan: "tb", tinggibadancm: "tb", tbcm: "tb", tinggi: "tb",
    lp: "lp", lingkarperut: "lp", lingkarperutcm: "lp", lpcm: "lp", lingkar: "lp",
    tdsistolik: "td_sistolik", tekanandarahsistolik: "td_sistolik", tekanandarahsistolikmmhg: "td_sistolik", sistolik: "td_sistolik", sistol: "td_sistolik", tdsistol: "td_sistolik",
    tddiastolik: "td_diastolik", tekanandarahdiastolik: "td_diastolik", tekanandarahdiastolikmmhg: "td_diastolik", diastolik: "td_diastolik", diastol: "td_diastolik", tddiastol: "td_diastolik",
    guladarah: "gula_darah", guladarahsewaktu: "gula_darah", gds: "gula_darah", guladarahmgdl: "gula_darah", gd: "gula_darah",
    hb: "hb", kadarhb: "hb", hemoglobin: "hb", hasilpemeriksaanhemoglobin: "hb", anemia: "hb", hbgdl: "hb", kadarhbgdl: "hb", kadarhemoglobin: "hb",
    merokok: "merokok", perilakumerokok: "merokok", statusmerokok: "merokok", rokok: "merokok",
    telinga: "telinga", pemeriksaantelinga: "telinga",
    mata: "mata", pemeriksaanmata: "mata",
    gigi: "gigi", pemeriksaangigi: "gigi",
    katarak: "katarak", karies: "karies", kariesgigi: "karies",
    kebugaran: "kebugaran", teskebugaran: "kebugaran", hasilkebugaran: "kebugaran",
    menstruasi: "menstruasi", haid: "menstruasi",
    kacamata: "kacamata", pakaikacamata: "kacamata",
    sekolah: "sekolah", namasekolah: "sekolah",
    kelas: "kelas", tingkat: "kelas",
    kategori: "category", category: "category",
    tanggallahir: "tanggal_lahir", tgllahir: "tanggal_lahir", tanggal: "tanggal_lahir", lahir: "tanggal_lahir", dob: "tanggal_lahir", dateofbirth: "tanggal_lahir",
    jeniskelamin: "jenis_kelamin", gender: "jenis_kelamin", kelamin: "jenis_kelamin", jk: "jenis_kelamin", jenis: "jenis_kelamin",
    statuspernikahan: "status_pernikahan", statusnikah: "status_pernikahan", nikah: "status_pernikahan",
    pekerjaan: "pekerjaan", job: "pekerjaan",
    provinsi: "provinsi", province: "provinsi",
    kabkota: "kab_kota", kota: "kab_kota", kabupaten: "kab_kota", kab: "kab_kota", city: "kab_kota", kab_kota: "kab_kota",
    kecamatan: "kecamatan", district: "kecamatan", kec: "kecamatan",
    kelurahan: "kelurahan", desa: "kelurahan", subdistrict: "kelurahan", kel: "kelurahan", desaataukelurahan: "kelurahan",
    alamat: "alamat", detailalamat: "alamat", detaildomisili: "alamat", address: "alamat", domisili: "alamat", jalan: "alamat"
  };

  excelFileInput.addEventListener("change", (evt) => {
    const file = evt.target.files?.[0];
    if (!file) return;
    evt.target.value = "";

    const reader = new FileReader();
    reader.onload = async (e) => {
      try {
        const XLSX = window.XLSX;
        const workbook = XLSX.read(e.target.result, { type: "array" });
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        const rawJson = XLSX.utils.sheet_to_json(sheet, { defval: "", raw: false });

        const targetCat = selectedCategory === "EXCEL_SEKOLAH" ? "SEKOLAH" : "UMUM";

        const allowSekolahNoNik = selectedCategory === "EXCEL_SEKOLAH";
        const parsedRaw = rawJson.map(row => {
          const cleanRow = {};
          for (const [k, v] of Object.entries(row)) {
            cleanRow[k.toLowerCase().replace(/[^a-z0-9]/g, "")] = v;
          }
          const item = {
            category: cleanRow.category ? cleanRow.category.toUpperCase() : targetCat,
            status: "DONE_PENDAFTARAN",
            _status: "idle"
          };
          for (const [rawK, stdK] of Object.entries(COLUMN_MAPPINGS)) {
            if (cleanRow[rawK] !== undefined) item[stdK] = cleanRow[rawK];
          }
          item.nama = sanitizeName(item.nama || cleanRow.nama || cleanRow.name || cleanRow.namalengkap || cleanRow.namapasien || "");
          item.nik = sanitizeNik(item.nik || cleanRow.nik || cleanRow.nonik || cleanRow.noktp || cleanRow.nomoridentitas || "");
          return item;
        });

        const stdFilter = filterValidIdentityRows(parsedRaw, {
          dedupeNik: true,
          allowSekolahWithoutNik: allowSekolahNoNik,
          checkDobGender: true
        });
        let parsed = stdFilter.validRows;
        let finalSkippedCount = stdFilter.skippedCount;
        let finalSkippedReasons = stdFilter.reasons;

        const hasValidData = parsedRaw.some(p => p.nama && (p.nik || p.sekolah));

        if (!hasValidData) {
          const uploadSpan = btnUploadExcel?.querySelector("span");
          const origText = uploadSpan ? uploadSpan.textContent : "Upload Excel";
          if (uploadSpan) uploadSpan.textContent = "🤖 AI Menganalisis...";

          try {
            const raw2DRows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });
            if (raw2DRows && raw2DRows.length > 1) {
              const aiMode = selectedCategory === "EXCEL_SEKOLAH" ? "pendaftaran" : "pelayanan";
              const aiRes = await detectExcelMappingWithAI({ raw2DRows, mode: aiMode });
              if (aiRes.success && aiRes.mapping && (aiRes.mapping.nik !== undefined || aiRes.mapping.nama !== undefined)) {
                const { headerRowIndex = 0, mapping = {} } = aiRes;
                const aiParsed = [];

                for (let i = headerRowIndex + 1; i < raw2DRows.length; i++) {
                  const row = raw2DRows[i];
                  if (!Array.isArray(row) || row.every(c => c === "" || c == null)) continue;

                  const getVal = (k) => {
                    const idx = mapping[k];
                    return (idx !== undefined && idx !== null && row[idx] !== undefined) ? String(row[idx]).trim() : "";
                  };

                  const cleanNikVal = sanitizeNik(getVal("nik"));
                  const namaVal = sanitizeName(getVal("nama"));
                  if (!namaVal && !cleanNikVal) continue;
                  if (namaVal.toUpperCase() === "CONTOH NAMA") continue;

                  const item = {
                    category: targetCat,
                    status: "DONE_PENDAFTARAN",
                    _status: "idle",
                    nik: cleanNikVal,
                    nama: namaVal,
                    sekolah: getVal("sekolah"),
                    kelas: getVal("kelas"),
                    wa: getVal("wa"),
                    jeniskelamin: sanitizeGender(getVal("jeniskelamin")),
                    tanggallahir: sanitizeDate(getVal("tanggallahir")),
                    bb: getVal("bb"),
                    tb: getVal("tb"),
                    lp: getVal("lp"),
                    td_sistolik: getVal("td_sistolik"),
                    td_diastolik: getVal("td_diastolik"),
                    gula_darah: getVal("gula_darah"),
                    hb: getVal("hb"),
                    merokok: getVal("merokok"),
                    kacamata: getVal("kacamata"),
                    disabilitas: getVal("disabilitas"),
                    status_pernikahan: getVal("statuspernikahan") || getVal("status_pernikahan") || getVal("statusnikah") || "",
                    pekerjaan: getVal("pekerjaan") || getVal("job") || "",
                    provinsi: getVal("provinsi") || "Jawa Barat",
                    kab_kota: getVal("kabkota") || getVal("kab_kota") || getVal("kota") || "Kab. Bandung",
                    kecamatan: getVal("kecamatan") || "Banjaran",
                    kelurahan: getVal("kelurahan") || getVal("desa") || "",
                    alamat: getVal("alamat") || getVal("detailalamat") || ""
                  };

                  aiParsed.push(item);
                }

                if (aiParsed.length > 0) {
                  const aiFilter = filterValidIdentityRows(aiParsed, {
                    dedupeNik: true,
                    allowSekolahWithoutNik: allowSekolahNoNik,
                    checkDobGender: true
                  });
                  parsed = aiFilter.validRows;
                  finalSkippedCount = aiFilter.skippedCount;
                  finalSkippedReasons = aiFilter.reasons;
                }
              }
            }
          } finally {
            if (uploadSpan) uploadSpan.textContent = origText;
          }
        }

        const skipSummary = formatSkippedIdentitySummary(finalSkippedReasons);
        if (!parsed.length) {
          alert(skipSummary
            ? `Tidak ada data pasien valid (${finalSkippedCount} baris dilewati: ${skipSummary}).`
            : "Tidak ada data pasien ditemukan di file ini. Pastikan menggunakan template yang benar.");
          return;
        }

        records = parsed;
        currentInstanPage = 1;
        showBulkFooter();
        renderPatientList(getSortedRecords());
        saveRecordsToSession();
        if (finalSkippedCount > 0) {
          alert(`${records.length} pasien dimuat.\n${finalSkippedCount} baris dilewati karena data identitas kurang/duplikat (${skipSummary}).`);
        }

        addLogEntry("pasien", {
          fileName: file.name,
          category: selectedCategory,
          total: records.length,
          berhasil: 0,
          gagal: 0,
          sebagian: 0,
          data: records
        }).catch(err => console.error("[Pelayanan Instan] addLogEntry error:", err));
      } catch (err) {
        console.error("[Pelayanan Instan] Excel parse error:", err);
        alert("Gagal membaca file Excel. Pastikan file valid dan menggunakan format .xlsx.");
      }
    };
    reader.readAsArrayBuffer(file);
  });

  const btnCloudCkgBankot = document.createElement("button");
  btnCloudCkgBankot.type = "button";
  btnCloudCkgBankot.className = "btn btn--secondary pendaftaran-fab__btn";
  btnCloudCkgBankot.style.borderColor = "#0284c7";
  btnCloudCkgBankot.style.color = "#38bdf8";
  btnCloudCkgBankot.title = "Ambil Antrean Pasien dari Portal Cloud CKG Bankot";
  btnCloudCkgBankot.innerHTML = `
    <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="flex-shrink:0">
      <path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/><polyline points="8 14 12 18 16 14"/><line x1="12" y1="10" x2="12" y2="18"/>
    </svg>
    <span>Ambil CKG Bankot</span>
  `;
  btnCloudCkgBankot.addEventListener("click", () => handleLoadFromCkgBankot());

  excelFooterRow.appendChild(btnDownloadTemplate);
  excelFooterRow.appendChild(btnUploadExcel);
  excelFooterRow.appendChild(btnCloudCkgBankot);
  excelFooterRow.appendChild(excelFileInput);

  const globalFooter = document.getElementById("btn-footer");
  if (globalFooter) {
    globalFooter.appendChild(bulkFooterRow);
    globalFooter.appendChild(excelFooterRow);
  }

  function isExcelMode() {
    return selectedCategory.startsWith("EXCEL");
  }

  function showExcelFooter() {
    bulkFooterRow.hidden = true;
    excelFooterRow.hidden = false;
    const globalFooter = document.getElementById("btn-footer");
    if (globalFooter) globalFooter.hidden = false;
  }

  function showBulkFooter() {
    excelFooterRow.hidden = true;
    bulkFooterRow.hidden = false;
    const globalFooter = document.getElementById("btn-footer");
    if (globalFooter) globalFooter.hidden = false;
    updateRestartErrorButtonVisibility();
  }

  async function resumeFromLogEntry(entry) {
    if (!entry) return false;
    let sessionData = entry.data;
    if (!sessionData || !sessionData.length) {
      try {
        const userSession = await chrome.storage.local.get(["enco_user_session"]);
        const petugas = userSession.enco_user_session?.nama_user;
        if (petugas && entry.id) {
          const res = await fetch(`https://ckgbankot.web.id/api/enco/sessions/detail?id=${encodeURIComponent(entry.id)}&petugas=${encodeURIComponent(petugas)}&menu=pasien`);
          const json = await res.json();
          if (json.success && json.session?.data) {
            sessionData = json.session.data;
          }
        }
      } catch (_) { }
    }
    if (!sessionData || !sessionData.length) return false;
    records = sessionData;
    currentInstanPage = 1;
    normalizeRecords(records);
    if (entry.category) {
      setPelayananInstanMode(entry.category);
    } else {
      setPelayananInstanMode(records[0]?.category || "EXCEL_SEKOLAH");
    }
    await setActiveLogId("pasien", entry.id);
    saveRecordsToSession();
    renderPatientList(getSortedRecords());
    showBulkFooter();
    return true;
  }

  async function renderModeSelection() {
    pelayananInstanMode = null;
    chrome.storage.session.remove(["pelayanan-instan-mode"]);
    bulkFooterRow.hidden = true;
    excelFooterRow.hidden = true;
    const globalFooter = document.getElementById("btn-footer");
    if (globalFooter) globalFooter.hidden = true;

    let history = [];
    try {
      history = await getHistory("pasien");
    } catch (_) { }
    const latestSession = history && history.length > 0 ? history[0] : null;

    let sessionHtml = "";
    if (latestSession) {
      const total = Number(latestSession.total || 0);
      const berhasil = Number(latestSession.berhasil || 0);
      const pernah = Number(latestSession.pernahInput || 0);
      const gagal = Number(latestSession.gagal || 0);
      const sisa = Math.max(0, total - berhasil - pernah - gagal);
      const timeStr = latestSession.dateStr || new Date(latestSession.timestamp || Date.now()).toLocaleString("id-ID");
      const fileName = latestSession.fileName || "Sesi Pasien";

      let olderOptions = "";
      if (history.length > 1) {
        olderOptions = `
          <div style="margin-top: 12px; padding-top: 10px; border-top: 1px dashed rgba(255, 255, 255, 0.12);">
            <div style="font-size: 10px; color: #94a3b8; font-weight: 700; margin-bottom: 6px; letter-spacing: 0.05em; text-transform: uppercase;">
              Riwayat Sesi Sebelumnya:
            </div>
            <select id="select-instan-older-sessions" class="form-select" style="width: 100%; font-size: 11px; padding: 7px 10px; background: rgba(11, 18, 34, 0.95); color: #e2e8f0; border: 1px solid rgba(59, 130, 246, 0.35); border-radius: 6px; margin-bottom: 8px; box-sizing: border-box; text-overflow: ellipsis;">
              ${history.slice(1).map((item, idx) => `<option value="${item.id}">${idx + 1}. ${item.fileName || "Sesi"} - ${item.dateStr || new Date(item.timestamp || Date.now()).toLocaleDateString("id-ID")} (${item.total || 0} Pasien)</option>`).join("")}
            </select>
            <div style="display: flex; gap: 8px; width: 100%; box-sizing: border-box;">
              <button id="btn-instan-load-older-session" class="btn btn--secondary" type="button" style="flex: 1; font-size: 11px; padding: 7px 10px; display: flex; align-items: center; justify-content: center; gap: 6px; height: 34px; box-sizing: border-box; border-radius: 6px;">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                <span>Muat Sesi Ini</span>
              </button>
              <button id="btn-instan-delete-older-session" class="btn-session-action btn-session-action--delete" type="button" style="width: 38px; height: 34px; padding: 0; display: flex; align-items: center; justify-content: center; flex: none; border-radius: 6px;" title="Hapus sesi terpilih dari Cloud">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
              </button>
            </div>
          </div>
        `;
      }

      sessionHtml = `
        <div class="session-picker-divider" style="margin: 14px 0 10px;">
          <span>ATAU LANJUTKAN SESI SEBELUMNYA</span>
        </div>

        <div class="session-picker-card session-picker-card--active" style="width: 100%; box-sizing: border-box; overflow: hidden; margin-bottom: 12px;">
          <div class="session-picker-card__header">
            <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
              <span class="session-picker-card__badge">🟢 SESI AKTIF TERAKHIR</span>
              <span class="session-picker-card__time">${timeStr}</span>
            </div>
          </div>

          <div class="session-picker-card__body" style="margin-top: 4px;">
            <div class="session-picker-card__filename" title="${fileName}">${fileName}</div>
            <div class="session-picker-card__stats" style="display: flex; flex-wrap: wrap; gap: 5px; margin-top: 6px;">
              <span class="session-stat-pill session-stat-pill--success">Selesai: <strong>${berhasil}</strong></span>
              <span class="session-stat-pill session-stat-pill--warning">Pernah: <strong>${pernah}</strong></span>
              <span class="session-stat-pill session-stat-pill--danger">Error: <strong>${gagal}</strong></span>
              <span class="session-stat-pill session-stat-pill--info">Sisa: <strong>${sisa}</strong></span>
            </div>
          </div>

          <div style="display: flex; gap: 8px; width: 100%; box-sizing: border-box; margin-top: 10px;">
            <button id="btn-instan-resume-session" class="btn-session-action btn-session-action--resume" type="button" style="flex: 1; min-width: 0; padding: 8px 12px; gap: 6px;">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" style="flex-shrink: 0;"><polygon points="5 3 19 12 5 21 5 3"/></svg>
              <span style="font-size: 11px; letter-spacing: 0.02em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">LANJUTKAN (${total.toLocaleString("id-ID")} PASIEN)</span>
            </button>
            <button id="btn-instan-delete-active-session" class="btn-session-action btn-session-action--delete" type="button" title="Hapus sesi ini dari Cloud R2 & Database" style="width: 38px; height: 34px; padding: 0; flex: none; display: flex; align-items: center; justify-content: center;">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>
            </button>
          </div>

          ${olderOptions}
        </div>
      `;
    }

    containerEl.innerHTML = `
      <div id="pelayanan-instan-mode-selection" class="pelayanan-mode-selection" style="width: 100%; box-sizing: border-box;">
        <div class="pelayanan-mode-header">
          <span class="pelayanan-mode-header__tag">SUMBER &amp; KATEGORI PASIEN</span>
          <h2 class="pelayanan-mode-header__title">Pilih Sumber Pasien:</h2>
          <p class="pelayanan-mode-header__subtitle">Pilih sumber data pasien yang akan diberikan pelayanan</p>
        </div>

        <div class="pelayanan-mode-grid pelayanan-mode-grid--compact" style="width: 100%; box-sizing: border-box;">
          <!-- 1. Dari Excel (Sekolah) -->
          <button id="btn-instan-excel-sekolah" class="pelayanan-mode-card pelayanan-mode-card--compact pelayanan-mode-card--excel pelayanan-mode-card--emerald" type="button">
            <div class="pelayanan-mode-card__top">
              <div class="pelayanan-mode-card__icon-wrap">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                  <polyline points="14 2 14 8 20 8"/>
                  <line x1="8" y1="13" x2="16" y2="13"/>
                  <line x1="8" y1="17" x2="16" y2="17"/>
                  <polyline points="10 9 9 9 8 9"/>
                </svg>
              </div>
              <span class="pelayanan-mode-card__badge pelayanan-mode-card__badge--emerald">EXCEL SEKOLAH</span>
            </div>
            <div class="pelayanan-mode-card__body">
              <h3 class="pelayanan-mode-card__title">Dari Excel (Sekolah)</h3>
              <p class="pelayanan-mode-card__desc">Upload file Excel data siswa sekolah</p>
            </div>
            <div class="pelayanan-mode-card__action">
              <span>PILIH</span>
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
            </div>
          </button>

          <!-- 2. Dari Excel (Umum) -->
          <button id="btn-instan-excel-umum" class="pelayanan-mode-card pelayanan-mode-card--compact pelayanan-mode-card--excel" type="button">
            <div class="pelayanan-mode-card__top">
              <div class="pelayanan-mode-card__icon-wrap">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                  <polyline points="14 2 14 8 20 8"/>
                  <line x1="8" y1="13" x2="16" y2="13"/>
                  <line x1="8" y1="17" x2="16" y2="17"/>
                  <polyline points="10 9 9 9 8 9"/>
                </svg>
              </div>
              <span class="pelayanan-mode-card__badge pelayanan-mode-card__badge--excel">EXCEL UMUM</span>
            </div>
            <div class="pelayanan-mode-card__body">
              <h3 class="pelayanan-mode-card__title">Dari Excel (Umum)</h3>
              <p class="pelayanan-mode-card__desc">Upload file Excel data pasien umum</p>
            </div>
            <div class="pelayanan-mode-card__action">
              <span>PILIH</span>
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
            </div>
          </button>

          <!-- 3. Database (Umum) -->
          <button id="btn-instan-db-umum" class="pelayanan-mode-card pelayanan-mode-card--compact pelayanan-mode-card--database" type="button">
            <div class="pelayanan-mode-card__top">
              <div class="pelayanan-mode-card__icon-wrap">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                  <ellipse cx="12" cy="5" rx="9" ry="3"/>
                  <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/>
                  <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/>
                </svg>
              </div>
              <span class="pelayanan-mode-card__badge pelayanan-mode-card__badge--database">DATABASE UMUM</span>
            </div>
            <div class="pelayanan-mode-card__body">
              <h3 class="pelayanan-mode-card__title">Database (Umum)</h3>
              <p class="pelayanan-mode-card__desc">Ambil data pasien umum dari ASIK</p>
            </div>
            <div class="pelayanan-mode-card__action">
              <span>PILIH</span>
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
            </div>
          </button>

          <!-- 4. Database (Sekolah) -->
          <button id="btn-instan-db-sekolah" class="pelayanan-mode-card pelayanan-mode-card--compact pelayanan-mode-card--database pelayanan-mode-card--emerald" type="button">
            <div class="pelayanan-mode-card__top">
              <div class="pelayanan-mode-card__icon-wrap">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M22 10v6M2 10l10-5 10 5-10 5z"/>
                  <path d="M6 12v5c3 3 9 3 12 0v-5"/>
                </svg>
              </div>
              <span class="pelayanan-mode-card__badge pelayanan-mode-card__badge--emerald">DATABASE SEKOLAH</span>
            </div>
            <div class="pelayanan-mode-card__body">
              <h3 class="pelayanan-mode-card__title">Database (Sekolah)</h3>
              <p class="pelayanan-mode-card__desc">Ambil data siswa sekolah dari ASIK</p>
            </div>
            <div class="pelayanan-mode-card__action">
              <span>PILIH</span>
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
            </div>
          </button>

          <!-- 5. Antrean Cloud CKG Bankot -->
          <button id="btn-instan-cloud-ckgbankot" class="pelayanan-mode-card pelayanan-mode-card--compact pelayanan-mode-card--cloud" type="button" style="border: 1.5px solid #0284c7; background: rgba(2, 132, 199, 0.12); grid-column: 1 / -1;">
            <div class="pelayanan-mode-card__top">
              <div class="pelayanan-mode-card__icon-wrap" style="color: #38bdf8;">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/>
                  <polyline points="8 14 12 18 16 14"/>
                  <line x1="12" y1="10" x2="12" y2="18"/>
                </svg>
              </div>
              <span class="pelayanan-mode-card__badge" style="background: #0284c7; color: #fff;">ANTREAN CLOUD CKG BANKOT</span>
            </div>
            <div class="pelayanan-mode-card__body">
              <h3 class="pelayanan-mode-card__title" style="color: #38bdf8;">Ambil Data dari CKG Bankot</h3>
              <p class="pelayanan-mode-card__desc">Tarik data antrean pasien langsung dari portal ckgbankot (CKG Umum atau CKG Sekolah)</p>
            </div>
            <div class="pelayanan-mode-card__action">
              <span>AMBIL DARI CLOUD</span>
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
            </div>
          </button>

          <!-- 6. Periksa Langsung dari Web ASIK (Tab Belum Pemeriksaan) -->
          <button id="btn-instan-asik-live" class="pelayanan-mode-card pelayanan-mode-card--compact pelayanan-mode-card--cyan" type="button" style="border: 1.5px solid #06b6d4; background: rgba(6, 182, 212, 0.12); grid-column: 1 / -1;">
            <div class="pelayanan-mode-card__top">
              <div class="pelayanan-mode-card__icon-wrap" style="color: #22d3ee; background: rgba(6, 182, 212, 0.2); border: 1px solid rgba(6, 182, 212, 0.4);">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M22 12h-4l-3 9L9 3l-3 9H2"/>
                </svg>
              </div>
              <span class="pelayanan-mode-card__badge" style="background: #0891b2; color: #fff;">BELUM PEMERIKSAAN ASIK</span>
            </div>
            <div class="pelayanan-mode-card__body">
              <h3 class="pelayanan-mode-card__title" style="color: #22d3ee;">Periksa Langsung dari Web ASIK</h3>
              <p class="pelayanan-mode-card__desc">Pindai dan periksa otomatis pasien di tab 'Belum Pemeriksaan' yang sedang dibuka di web ASIK Kemenkes</p>
            </div>
            <div class="pelayanan-mode-card__action" style="color: #22d3ee;">
              <span>PERIKSA LANGSUNG</span>
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
            </div>
          </button>
        </div>

        ${sessionHtml}
      </div>
    `;

    // Event listener sesi aktif
    if (latestSession) {
      document.getElementById("btn-instan-resume-session")?.addEventListener("click", async () => {
        const btn = document.getElementById("btn-instan-resume-session");
        if (btn) {
          btn.disabled = true;
          btn.innerHTML = `<span class="spin">⏳</span> <span>Mengunduh data antrean dari Cloud...</span>`;
        }
        try {
          const success = await resumeFromLogEntry(latestSession);
          if (!success) alert("Gagal memuat sesi pasien dari Cloud.");
        } finally {
          if (btn) btn.disabled = false;
        }
      });

      document.getElementById("btn-instan-delete-active-session")?.addEventListener("click", async () => {
        const fileName = latestSession.fileName || "Sesi Pasien";
        if (!confirm(`Hapus sesi "${fileName}" secara permanen dari Cloud R2 & Database?`)) return;
        try {
          await deleteLogEntry("pasien", latestSession.id);
          const activeLogId = await getActiveLogId("pasien");
          if (activeLogId === "none" || activeLogId === latestSession.id) {
            records = [];
            await chrome.storage.session.remove(["pelayanan-instan-records"]);
          }
          await renderModeSelection();
        } catch (err) {
          alert("Gagal menghapus sesi: " + (err.message || err));
        }
      });

      document.getElementById("btn-instan-load-older-session")?.addEventListener("click", async () => {
        const sel = document.getElementById("select-instan-older-sessions");
        const targetId = sel?.value;
        if (!targetId) return;
        const target = history.find(s => s.id === targetId);
        if (target) await resumeFromLogEntry(target);
      });

      document.getElementById("btn-instan-delete-older-session")?.addEventListener("click", async () => {
        const sel = document.getElementById("select-instan-older-sessions");
        const targetId = sel?.value;
        if (!targetId) {
          alert("Pilih sesi riwayat terlebih dahulu.");
          return;
        }
        const target = history.find(s => s.id === targetId);
        const fileName = target?.fileName || "Sesi Riwayat";
        if (!confirm(`Hapus sesi "${fileName}" secara permanen dari Cloud R2 & Database?`)) return;
        try {
          await deleteLogEntry("pasien", targetId);
          await renderModeSelection();
        } catch (err) {
          alert("Gagal menghapus sesi: " + (err.message || err));
        }
      });
    }

    document.getElementById("btn-instan-excel-sekolah")?.addEventListener("click", () => setPelayananInstanMode("EXCEL_SEKOLAH"));
    document.getElementById("btn-instan-excel-umum")?.addEventListener("click", () => setPelayananInstanMode("EXCEL_UMUM"));
    document.getElementById("btn-instan-db-umum")?.addEventListener("click", () => setPelayananInstanMode("UMUM"));
    document.getElementById("btn-instan-db-sekolah")?.addEventListener("click", () => setPelayananInstanMode("SEKOLAH"));
    document.getElementById("btn-instan-cloud-ckgbankot")?.addEventListener("click", () => handleLoadFromCkgBankot());
    document.getElementById("btn-instan-asik-live")?.addEventListener("click", () => handleLoadFromAsikLive());
  }

  async function handleLoadFromAsikLive() {
    try {
      const tabs = await chrome.tabs.query({ url: "*://sehatindonesiaku.kemkes.go.id/*" });
      let asikTab = tabs.find(t => t.url && t.url.includes("ckg-pelayanan"));

      if (!asikTab) {
        // Cek apakah ada tab ASIK di halaman lain (misal pendaftaran atau dashboard)
        const anyAsikTab = tabs.find(t => t.url && t.url.includes("sehatindonesiaku.kemkes.go.id"));
        if (anyAsikTab) {
          asikTab = anyAsikTab;
          containerEl.innerHTML = `
            <div class="field" style="text-align: center; padding: 40px 16px;">
              <div style="font-size: 28px; margin-bottom: 12px; animation: spin 1s linear infinite; display: inline-block;">⏳</div>
              <div style="font-weight: 700; font-size: 14px; color: #00f0ff; margin-bottom: 8px;">Membuka CKG Pelayanan...</div>
              <div style="font-size: 11px; color: #94a3b8; font-family: var(--font-cyber);">Mengarahkan tab ASIK ke halaman pelayanan CKG...</div>
            </div>
          `;
          await chrome.tabs.update(asikTab.id, { url: "https://sehatindonesiaku.kemkes.go.id/ckg-pelayanan", active: true });
          await new Promise(resolve => {
            const listener = (tid, changeInfo) => {
              if (tid === asikTab.id && changeInfo.status === "complete") {
                chrome.tabs.onUpdated.removeListener(listener);
                resolve();
              }
            };
            chrome.tabs.onUpdated.addListener(listener);
            setTimeout(() => { chrome.tabs.onUpdated.removeListener(listener); resolve(); }, 12000);
          });
          await new Promise(r => setTimeout(r, 1500));
        } else {
          // Buka tab baru jika belum ada sama sekali
          await chrome.tabs.create({ url: "https://sehatindonesiaku.kemkes.go.id/ckg-pelayanan", active: true });
          alert("Tab web ASIK CKG Pelayanan telah dibuka di browser.\n\nSilakan pastikan Anda sudah login, lalu klik tombol 'Periksa Langsung dari Web ASIK' kembali.");
          return;
        }
      }

      const detectedSchool = !!(asikTab.url && asikTab.url.includes("ckg-pelayanan-sekolah"));
      const nowD = new Date();
      const todayIso = [nowD.getFullYear(), String(nowD.getMonth() + 1).padStart(2, "0"), String(nowD.getDate()).padStart(2, "0")].join("-");
      const agoD = new Date(nowD.getTime() - 30 * 86400000);
      const agoIso = [agoD.getFullYear(), String(agoD.getMonth() + 1).padStart(2, "0"), String(agoD.getDate()).padStart(2, "0")].join("-");

      containerEl.innerHTML = `
        <div class="field" style="padding: 12px; display: flex; flex-direction: column; gap: 10px; background: rgba(15, 23, 42, 0.75); border: 1px solid rgba(56, 189, 248, 0.3); border-radius: 8px;">
          <div style="font-weight: 700; font-size: 13px; color: #f8fafc;">Pilih Sumber Scan Web ASIK</div>

          <div>
            <label style="display: block; font-size: 10.5px; color: #94a3b8; margin-bottom: 4px;">Kategori Halaman ASIK</label>
            <select id="asik-live-category" class="field__input" style="width: 100%; height: 32px; font-size: 11.5px;">
              <option value="UMUM"${!detectedSchool ? " selected" : ""}>CKG Umum (Dewasa &amp; Lansia)</option>
              <option value="SEKOLAH"${detectedSchool ? " selected" : ""}>CKG Sekolah (Peserta Didik)</option>
            </select>
          </div>

          <div id="asik-date-range-wrap" style="display: ${detectedSchool ? "none" : "flex"}; gap: 6px;">
            <div style="flex: 1;">
              <label style="display: block; font-size: 10px; color: #94a3b8; margin-bottom: 3px;">Dari Tanggal (Backdate)</label>
              <input type="date" id="asik-scan-start" class="field__input" value="${agoIso}" style="width: 100%; height: 30px; font-size: 11px;">
            </div>
            <div style="flex: 1;">
              <label style="display: block; font-size: 10px; color: #94a3b8; margin-bottom: 3px;">Sampai Tanggal</label>
              <input type="date" id="asik-scan-end" class="field__input" value="${todayIso}" style="width: 100%; height: 30px; font-size: 11px;">
            </div>
          </div>

          <div style="display: flex; flex-direction: column; gap: 6px;">
            <span style="font-size: 10.5px; color: #94a3b8;">Bagian yang akan di-scan:</span>
            <label style="display: flex; align-items: center; gap: 8px; font-size: 11.5px; color: #f8fafc; cursor: pointer;">
              <input type="checkbox" id="asik-chk-belum" checked style="cursor: pointer;">
              <span>Belum Pemeriksaan</span>
            </label>
            <label style="display: flex; align-items: center; gap: 8px; font-size: 11.5px; color: #f8fafc; cursor: pointer;">
              <input type="checkbox" id="asik-chk-sedang" checked style="cursor: pointer;">
              <span>Sedang Pemeriksaan</span>
            </label>
            <label style="display: flex; align-items: center; gap: 8px; font-size: 11px; color: #7dd3fc; cursor: pointer; margin-top: 2px;">
              <input type="checkbox" id="asik-chk-backdate" checked style="cursor: pointer;">
              <span>Gunakan tanggal daftar asli pasien (Backdate)</span>
            </label>
          </div>

          <div style="display: flex; gap: 8px; margin-top: 4px;">
            <button id="asik-btn-back-mode" type="button" class="btn btn--secondary" style="flex: 0.7; font-size: 11.5px; padding: 8px;">
              ← Kembali
            </button>
            <button id="asik-btn-start-scan" type="button" class="btn btn--primary" style="flex: 1.5; font-size: 11.5px; padding: 8px; font-weight: 700; background: #0284c7; border-color: #38bdf8;">
              🔍 Mulai Scan
            </button>
          </div>
        </div>
      `;

      document.getElementById("asik-live-category")?.addEventListener("change", (e) => {
        const wrap = document.getElementById("asik-date-range-wrap");
        if (wrap) wrap.style.display = e.target.value === "SEKOLAH" ? "none" : "flex";
      });

      document.getElementById("asik-btn-back-mode")?.addEventListener("click", () => renderModeSelection());
      document.getElementById("asik-btn-start-scan")?.addEventListener("click", async () => {
        const isSchoolTab = document.getElementById("asik-live-category")?.value === "SEKOLAH";
        const includeBelum = !!document.getElementById("asik-chk-belum")?.checked;
        const includeSedang = !!document.getElementById("asik-chk-sedang")?.checked;
        const useBackdate = !!document.getElementById("asik-chk-backdate")?.checked;
        const screeningStartDate = document.getElementById("asik-scan-start")?.value || null;
        const screeningEndDate = document.getElementById("asik-scan-end")?.value || null;
        if (!includeBelum && !includeSedang) {
          alert("Pilih minimal 1 bagian (Belum Pemeriksaan atau Sedang Pemeriksaan).");
          return;
        }
        await executeAsikLiveScan(asikTab, {
          isSchoolTab,
          includeBelum,
          includeSedang,
          useBackdate,
          screeningStartDate,
          screeningEndDate
        });
      });
    } catch (err) {
      console.error("[handleLoadFromAsikLive] error:", err);
      alert("Gagal memuat data dari Web ASIK: " + err.message);
      await renderModeSelection();
    }
  }

  async function executeAsikLiveScan(asikTab, { isSchoolTab, includeBelum, includeSedang, useBackdate = true, screeningStartDate = null, screeningEndDate = null }) {
    try {
      const scanParts = [
        includeBelum ? "Belum Pemeriksaan" : null,
        includeSedang ? "Sedang Pemeriksaan" : null
      ].filter(Boolean).join(" & ");

      containerEl.innerHTML = `
        <div class="field" style="text-align: center; padding: 40px 16px;">
          <div style="font-size: 28px; margin-bottom: 12px; animation: spin 1s linear infinite; display: inline-block;">⏳</div>
          <div style="font-weight: 700; font-size: 14px; color: #38bdf8; margin-bottom: 8px;">Memindai Web ASIK (API)...</div>
          <div id="asik-scan-status-msg" style="font-size: 11px; color: #94a3b8; font-family: var(--font-cyber);">Mengambil antrean ${scanParts}...</div>
        </div>
      `;

      const statusEl = document.getElementById("asik-scan-status-msg");
      let scanned = null;
      let scanSource = "API";
      let lastApiErr = "";

      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          if (attempt > 1) {
            if (statusEl) statusEl.textContent = "Menyiapkan sesi API ASIK, mencoba ulang...";
            await new Promise(r => setTimeout(r, 1500));
          }
          const apiScan = await chrome.runtime.sendMessage({
            type: "SCAN_ASIK_LIVE_API",
            isSchool: isSchoolTab,
            includeBelum,
            includeSedang,
            screeningStartDate,
            screeningEndDate
          });
          if (apiScan?.ok && Array.isArray(apiScan.patients)) {
            scanned = apiScan.patients;
            break;
          }
          lastApiErr = apiScan?.error || "Respons API tidak valid";
        } catch (err) {
          lastApiErr = err?.message || String(err);
        }
      }

      // Fallback ke scan DOM hanya jika user setuju setelah API gagal 2x
      if (!scanned) {
        const useDom = confirm(
          `Scan API ASIK gagal (${lastApiErr}).\n\n` +
          `Gunakan scan tabel DOM sebagai cadangan? (Lebih lambat untuk antrean banyak)`
        );
        if (!useDom) {
          await renderModeSelection();
          return;
        }
        scanSource = "DOM Fallback";
        if (statusEl) statusEl.textContent = `Fallback ke pemindaian tabel DOM (${scanParts})...`;
        const onProgress = (info) => {
          if (statusEl && info?.message) statusEl.textContent = info.message;
        };
        scanned = await scanPelayananTable(asikTab.id, {
          scanBelum: includeBelum,
          scanSedang: includeSedang,
          scanAllPages: true
        }, onProgress);
      }

      const belumCount = (scanned || []).filter(i => i.sourceTab !== "Sedang Pemeriksaan").length;
      const sedangCount = (scanned || []).filter(i => i.sourceTab === "Sedang Pemeriksaan").length;
      console.log(`[handleLoadFromAsikLive] (${scanSource}) Total: ${scanned?.length || 0} (Belum: ${belumCount}, Sedang: ${sedangCount})`);

      if (!scanned || scanned.length === 0) {
        alert("Tidak ditemukan pasien pada tab 'Belum Pemeriksaan' maupun 'Sedang Pemeriksaan' di web ASIK.");
        await renderModeSelection();
        return;
      }

      pelayananInstanMode = "ASIK_LIVE";
      selectedCategory = "ASIK_LIVE";
      await chrome.storage.session.set({
        "pelayanan-instan-mode": "ASIK_LIVE",
        "pelayanan-instan-category": "ASIK_LIVE"
      });

      const globalFooter = document.getElementById("btn-footer");
      if (globalFooter) globalFooter.hidden = false;

      records = scanned.map(item => ({
        id: item.reg_id || item.id || `asik_${item.nomorTiket || Date.now()}`,
        reg_id: item.reg_id || null,
        nama: item.nama,
        nomorTiket: item.nomorTiket,
        tanggalLahir: item.tanggalLahir,
        jenisKelamin: item.jenisKelamin || "",
        namaWali: item.namaWali,
        sekolah: item.sekolah || "",
        kelas: item.kelas || "",
        unitPelayanan: item.unitPelayanan || "",
        category: "ASIK_LIVE",
        _status: "idle",
        status: item.sourceTab === "Sedang Pemeriksaan" ? "SEDANG_PEMERIKSAAN" : "BELUM_PEMERIKSAAN",
        sourceTab: item.sourceTab || "Belum Pemeriksaan",
        attendDate: useBackdate ? (item.attendDate || "") : "",
        isSchool: typeof item.isSchool === "boolean" ? item.isSchool : isSchoolTab,
        nik: item.nik || ""
      }));

      currentInstanPage = 1;
      showBulkFooter();
      renderPatientList(getSortedRecords());
      saveRecordsToSession();

      await addLogEntry("pasien", {
        fileName: `Web ASIK Belum Periksa (${records.length} Pasien)`,
        category: "ASIK_LIVE",
        total: records.length,
        berhasil: 0,
        gagal: 0,
        sebagian: 0,
        pernahInput: 0,
        data: records
      }).catch(err => console.error("[ASIK Live] addLogEntry error:", err));

      alert(`Berhasil memindai ${records.length} pasien dari tab Belum Pemeriksaan web ASIK!`);
    } catch (err) {
      console.error("[handleLoadFromAsikLive] error:", err);
      alert("Gagal memindai web ASIK: " + (err.message || err));
      await renderModeSelection();
    }
  }

  async function handleLoadFromCkgBankot(chosenCategory) {
    let cat = chosenCategory;
    if (!cat) {
      if (typeof window.showCkgBankotCategoryPicker === "function") {
        cat = await window.showCkgBankotCategoryPicker();
      } else {
        cat = selectedCategory?.includes("SEKOLAH") ? "SEKOLAH" : "UMUM";
      }
    }
    if (!cat) return; // Dibatalkan oleh pengguna

    const modeToSet = cat === "SEKOLAH" ? "EXCEL_SEKOLAH" : "EXCEL_UMUM";

    try {
      const res = await fetchBotQueueFromCkgbankot(cat, "pelayanan");
      if (!res.success) {
        alert(res.error || "Gagal mengambil antrean cloud.");
        return;
      }
      if (!res.data || res.data.length === 0) {
        alert(`Tidak ada antrean skrining CKG ${cat} milik akun "${res.petugas || 'Anda'}" yang belum selesai di portal ckgbankot.web.id.\n\nCatatan: Antrean ini dibaca per akun. Pastikan data antrean dimasukkan melalui web ckgbankot dengan akun "${res.petugas || 'Anda'}".`);
        return;
      }

      setPelayananInstanMode(modeToSet);

      records = res.data.map(item => {
        const isPernah = item._queue_status_pelayanan === "Pernah Input" ||
          item._queue_status_pelayanan === "already-screened" ||
          item.status === "ALREADY_SCREENED";
        const isDone = item._queue_status_pelayanan === "selesai" ||
          item._queue_status_pelayanan === "Selesai Pelayanan";
        return {
          ...item,
          category: cat,
          _queue_id: item._queue_id,
          _queue_record_id: item._queue_record_id,
          _queue_jenis: cat,
          _status: isDone ? "done" : (isPernah ? "already-screened" : "idle"),
          status: isPernah ? "ALREADY_SCREENED" : (isDone ? "DONE_PELAYANAN" : (item.status || "DONE_PENDAFTARAN"))
        };
      });

      currentInstanPage = 1;
      showBulkFooter();
      renderPatientList(getSortedRecords());
      saveRecordsToSession();

      await addLogEntry("pasien", {
        fileName: `Antrean Cloud ${cat} (${records.length} Pasien)`,
        category: modeToSet,
        total: records.length,
        berhasil: 0,
        gagal: 0,
        sebagian: 0,
        data: records
      }).catch(err => console.error("[Pelayanan Instan] addLogEntry error:", err));

      alert(`Berhasil mengambil ${records.length} data antrean skrining CKG ${cat} dari Cloud CKG Bankot!`);
    } catch (err) {
      console.error("[Pelayanan Instan] Error load CKG Bankot:", err);
      alert("Gagal mengambil data antrean dari CKG Bankot: " + (err.message || err));
    }
  }

  function setPelayananInstanMode(mode) {
    if (!mode) {
      pelayananInstanMode = null;
      renderModeSelection();
      return;
    }

    const previousCategory = selectedCategory;
    pelayananInstanMode = mode;
    selectedCategory = mode;
    chrome.storage.session.set({
      "pelayanan-instan-mode": mode,
      "pelayanan-instan-category": mode
    });

    const globalFooter = document.getElementById("btn-footer");
    if (globalFooter) globalFooter.hidden = false;

    if (mode === "ASIK_LIVE") {
      if (records && records.length > 0) {
        renderPatientList(getSortedRecords());
        showBulkFooter();
      } else {
        handleLoadFromAsikLive();
      }
      return;
    }

    if (isExcelMode()) {
      if (previousCategory !== mode) {
        records = [];
        chrome.storage.session.set({ "pelayanan-instan-records": records });
      }
      if (records && records.length > 0) {
        renderPatientList(getSortedRecords());
        showBulkFooter();
      } else {
        renderExcelEmptyState();
      }
    } else {
      if (previousCategory !== mode) {
        records = [];
        chrome.storage.session.set({ "pelayanan-instan-records": records });
      }
      fetchAndLoadRecords();
    }
  }

  function updateRestartErrorButtonVisibility() {
    const hasError = records.some(isRecordError);
    chrome.storage.session.get("pelayananRunning").then(({ pelayananRunning }) => {
      if (pelayananRunning) {
        btnRestartError.style.display = "none";
      } else {
        btnRestartError.style.display = hasError && !bulkFooterRow.hidden ? "flex" : "none";
      }
    }).catch(() => {
      btnRestartError.style.display = hasError && !bulkFooterRow.hidden ? "flex" : "none";
    });
  }

  let isBulkPaused = false;

  function setBulkRunningState(running, paused = false) {
    isBulkPaused = paused;
    chrome.storage.session.set({ pelayananRunning: running, pelayananPaused: paused }).catch(() => { });
    if (running) {
      btnStartBulk.style.display = "none";
      btnRestartError.style.display = "none";
      btnPauseBulk.style.display = "inline-flex";
      btnStopBulk.style.display = "inline-flex";

      if (paused) {
        btnPauseBulk.className = "btn btn--primary";
        btnPauseBulk.innerHTML = `
          <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" style="flex-shrink:0">
            <polygon points="5 3 19 12 5 21 5 3"/>
          </svg>
          <span>Lanjut</span>
        `;
      } else {
        btnPauseBulk.className = "btn btn--warning";
        btnPauseBulk.innerHTML = `
          <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" style="flex-shrink:0">
            <rect x="6" y="4" width="4" height="16"/>
            <rect x="14" y="4" width="4" height="16"/>
          </svg>
          <span>Jeda</span>
        `;
      }
    } else {
      btnStartBulk.style.display = "inline-flex";
      btnPauseBulk.style.display = "none";
      btnStopBulk.style.display = "none";
      updateRestartErrorButtonVisibility();
    }
  }

  async function runJobs(targetList) {
    const todayDateObj = new Date();
    const todayDateParsed = {
      tahun: todayDateObj.getFullYear(),
      bulan: todayDateObj.getMonth() + 1,
      hari: todayDateObj.getDate()
    };

    const jobs = targetList.flatMap(rec => {
      const nik = rec.nik;
      if (!nik) return [];

      let tanggalData;
      if (isExcelMode()) {
        tanggalData = todayDateParsed;
      } else {
        tanggalData = parseDate(rec.registered_at || rec.created_at);
      }

      const recIndex = records.indexOf(rec);

      const job = { recordIndex: recIndex, nik, tanggalData, patientRecord: rec };
      if (isExcelMode()) {
        job.isExcel = true;
      }
      return [job];
    });

    if (jobs.length) {
      let activeLog = await getActiveLogId("pasien");
      if (!activeLog) {
        const hist = await getHistory("pasien");
        if (hist.length > 0) {
          await setActiveLogId("pasien", hist[0].id);
        } else {
          const newEntry = await addLogEntry("pasien", {
            fileName: isExcelMode() ? "Data Excel" : "Data Database",
            category: selectedCategory,
            total: records.length,
            berhasil: 0,
            gagal: 0,
            sebagian: 0,
            pernahInput: 0,
            data: records
          });
          if (newEntry) await setActiveLogId("pasien", newEntry.id);
        }
      }
      syncStatsToActiveLog();
      setBulkRunningState(true);
      chrome.runtime.sendMessage({ type: "RUN_PELAYANAN_BULK", jobs, concurrentLimit }).catch(() => { });
    }
  }

  async function runAsikLiveBatch(targetList) {
    const jobs = targetList.map(rec => {
      const recIndex = records.indexOf(rec);
      return {
        recordIndex: recIndex,
        nomorTiket: rec.nomorTiket,
        nama: rec.nama,
        tanggalLahir: rec.tanggalLahir,
        patientRecord: rec
      };
    });

    if (!jobs.length) return;

    let activeLog = await getActiveLogId("pasien");
    if (!activeLog) {
      const hist = await getHistory("pasien");
      if (hist.length > 0) {
        await setActiveLogId("pasien", hist[0].id);
      } else {
        const newEntry = await addLogEntry("pasien", {
          fileName: `Web ASIK Live (${records.length} Pasien)`,
          category: "ASIK_LIVE",
          total: records.length,
          berhasil: 0,
          gagal: 0,
          sebagian: 0,
          pernahInput: 0,
          data: records
        });
        if (newEntry) await setActiveLogId("pasien", newEntry.id);
      }
    }
    syncStatsToActiveLog();
    setBulkRunningState(true);
    chrome.runtime.sendMessage({ type: "RUN_ASIK_LIVE_BATCH", jobs, concurrentLimit }).catch(() => {});
  }

  btnStartBulk.addEventListener("click", async () => {
    if (!(await checkDeviceOrSignOut())) return;

    const available = getSortedRecords().filter(r => {
      if (r._status === "in-progress") return false;
      if (isRecordError(r)) return true; // Error patients can be re-checked!
      if (isRecordDone(r)) return false;
      return true;
    });

    if (!available.length) {
      alert("Semua pasien yang dipilih sudah selesai atau tidak ada pasien yang siap diproses.");
      return;
    }

    if (selectedCategory === "ASIK_LIVE") {
      await runAsikLiveBatch(available);
      return;
    }

    await runJobs(available);
  });

  btnPauseBulk.addEventListener("click", async () => {
    if (isBulkPaused) {
      chrome.runtime.sendMessage({ type: "PELAYANAN_RESUME" }).catch(() => { });
      setBulkRunningState(true, false);
    } else {
      chrome.runtime.sendMessage({ type: "PELAYANAN_PAUSE" }).catch(() => { });
      setBulkRunningState(true, true);
    }
  });

  btnStopBulk.addEventListener("click", async () => {
    chrome.runtime.sendMessage({ type: "PELAYANAN_STOP_ALL" }).catch(() => { });
    setBulkRunningState(false, false);
  });

  btnRestartError.addEventListener("click", async () => {
    if (!(await checkDeviceOrSignOut())) return;

    let errList = getSortedRecords().filter(isRecordError);
    if (!errList.length) {
      errList = records.filter(isRecordError);
    }
    const available = errList.filter(r => r._status !== "in-progress");

    if (!available.length) {
      alert("Tidak ada pasien error yang dapat diperiksa ulang.");
      return;
    }

    if (selectedCategory === "ASIK_LIVE") {
      await runAsikLiveBatch(available);
      return;
    }

    await runJobs(available);
  });

  const STATUS_CONFIG = {
    DONE_PENDAFTARAN: { label: "Siap Pelayanan", cls: "patient-badge--idle" },
    BELUM_PEMERIKSAAN: { label: "Belum Periksa", cls: "patient-badge--idle" },
    ready: { label: "Siap Periksa", cls: "patient-badge--idle" },
    PARTIAL_DONE_PELAYANAN: { label: "Selesai Sebagian", cls: "patient-badge--partial" },
    DONE_PELAYANAN: { label: "Selesai", cls: "patient-badge--done" },
    ALREADY_SCREENED: { label: "Pernah Input", cls: "patient-badge--warning" },
    "already-screened": { label: "Pernah Input", cls: "patient-badge--warning" },
    MISSING: { label: "Tidak Ditemukan", cls: "patient-badge--missing" },
    SERVER_ERROR: { label: "Server Error", cls: "patient-badge--error" },
    error: { label: "Error", cls: "patient-badge--error" }
  };

  function renderExcelEmptyState() {
    containerEl.innerHTML = `
      ${renderFilterHeader()}
      <div class="promo-placeholder" style="margin-top: 12px;">
        <div class="promo-icon-ring">
          <svg xmlns="http://www.w3.org/2000/svg" width="34" height="34" viewBox="0 0 24 24" fill="none" aria-hidden="true" class="promo-placeholder__icon">
            <!-- Cyber Data Shard Outer Edge -->
            <path d="M4 2.5H14.5L20 8V21C20 21.55 19.55 22 19 22H5C4.45 22 4 21.55 4 21V2.5Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" fill="rgba(14, 165, 233, 0.08)" />
            <!-- Chamfered Fold with Tech Port -->
            <path d="M14 2.5V7.5C14 8.05 14.45 8.5 15 8.5H20" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" />
            <!-- Microchip Contact Pins -->
            <line x1="7" y1="2.5" x2="7" y2="5.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
            <line x1="10" y1="2.5" x2="10" y2="5.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
            <!-- Quantum Data Core Diamond -->
            <polygon points="12 11 15.5 14 12 17 8.5 14" fill="rgba(56, 189, 248, 0.45)" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" />
            <circle cx="12" cy="14" r="1.3" fill="#ffffff" />
            <!-- Circuit Traces -->
            <line x1="5.5" y1="14" x2="8.5" y2="14" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
            <line x1="15.5" y1="14" x2="18.5" y2="14" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
            <!-- Cyber Data Bus Track at Bottom -->
            <line x1="7" y1="19.5" x2="11" y2="19.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
            <line x1="13.5" y1="19.5" x2="17" y2="19.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-dasharray="1.2 1.2" />
          </svg>
        </div>
        <p class="promo-placeholder__heading">Upload file Excel (${selectedCategory === "EXCEL_SEKOLAH" ? "CKG Sekolah" : "CKG Umum"})</p>
        <p class="promo-placeholder__body">Download template, isi data pasien,<br>lalu upload file untuk memulai.</p>
      </div>
    `;
    attachHeaderListeners();
    showExcelFooter();
  }

  function renderFilterHeader() {
    let badgeClass = "pelayanan-active-badge";
    let badgeText = "DATABASE (UMUM)";
    let subText = "Database Kemkes";

    if (selectedCategory === "EXCEL_SEKOLAH") {
      badgeClass = "pelayanan-active-badge pelayanan-active-badge--emerald";
      badgeText = "EXCEL (SEKOLAH)";
      subText = "Siswa Sekolah";
    } else if (selectedCategory === "EXCEL_UMUM") {
      badgeClass = "pelayanan-active-badge pelayanan-active-badge--excel";
      badgeText = "EXCEL (UMUM)";
      subText = "Pasien Umum";
    } else if (selectedCategory === "SEKOLAH") {
      badgeClass = "pelayanan-active-badge pelayanan-active-badge--emerald";
      badgeText = "DATABASE (SEKOLAH)";
      subText = "Database Kemkes";
    } else if (selectedCategory === "ASIK_LIVE") {
      badgeClass = "pelayanan-active-badge pelayanan-active-badge--cyan";
      badgeText = "BELUM PEMERIKSAAN ASIK";
      subText = "Web ASIK Langsung";
    }

    return `
      <div class="pelayanan-active-bar" style="margin-bottom: 8px;">
        <div class="pelayanan-active-bar__left">
          <span class="${badgeClass}">${badgeText}</span>
          <span class="pelayanan-active-sub">${subText}</span>
        </div>
        <div style="display: flex; align-items: center; gap: 6px;">
          ${!isExcelMode()
        ? `
          <button id="btn-refresh-pelayanan-instan" type="button" title="Refresh data" style="padding: 3px 7px; border: 1px solid rgba(255, 255, 255, 0.15); border-radius: 5px; background: rgba(255, 255, 255, 0.06); cursor: pointer; display: flex; align-items: center; color: #94a3b8; transition: all 0.2s ease;">
            <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-4.5"/></svg>
          </button>`
        : ""
      }
          <button id="btn-switch-pelayanan-instan-session" class="btn-switch-mode" type="button" title="Pilih / Ganti Sesi">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
            <span>Pilih Sesi</span>
          </button>
          <button id="btn-switch-pelayanan-instan-mode" class="btn-switch-mode" type="button" title="Ganti Sumber Pasien">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-4.5"/></svg>
            <span>Ganti Sumber</span>
          </button>
        </div>
      </div>
    `;
  }

  function renderFilterControls() {
    const ageOptions = [
      { value: "ALL", label: "👥 Semua Umur" },
      { value: "anak", label: "🧒 Anak (<10 thn)" },
      { value: "remaja", label: "🧑 Remaja (10-17 thn)" },
      { value: "dewasa", label: "👨 Dewasa (18-59 thn)" },
      { value: "lansia", label: "👴 Lansia (≥60 thn)" }
    ];

    const statusOptions = [
      { value: "ALL", label: "📋 Semua Status" },
      { value: "ready", label: "⏳ Siap Pelayanan" },
      { value: "selesai", label: "✅ Selesai" },
      { value: "sebagian", label: "🟡 Sebagian" },
      { value: "pernah-input", label: "⚠️ Pernah Input" },
      { value: "error", label: "❌ Error" }
    ];

    return `
      <div class="filter-controls-row">
        <div class="select__wrapper filter-select-wrapper">
          <select id="age-filter-pelayanan-instan" class="field__select filter-select">
            ${ageOptions.map(opt => `<option value="${opt.value}"${selectedAge === opt.value ? " selected" : ""}>${opt.label}</option>`).join("")}
          </select>
          <span class="select__arrow">▾</span>
        </div>
        <div class="select__wrapper filter-select-wrapper">
          <select id="status-filter-pelayanan-instan" class="field__select filter-select">
            ${statusOptions.map(opt => `<option value="${opt.value}"${selectedStatus === opt.value ? " selected" : ""}>${opt.label}</option>`).join("")}
          </select>
          <span class="select__arrow">▾</span>
        </div>
      </div>
    `;
  }

  function attachHeaderListeners() {
    const refreshBtn = document.getElementById("btn-refresh-pelayanan-instan");
    if (refreshBtn) {
      refreshBtn.addEventListener("click", async () => {
        refreshBtn.style.transition = "transform 0.5s cubic-bezier(0.4, 0, 0.2, 1)";
        refreshBtn.style.transform = "rotate(360deg)";
        setTimeout(() => {
          refreshBtn.style.transition = "none";
          refreshBtn.style.transform = "none";
        }, 550);

        if (selectedCategory === "ASIK_LIVE") {
          await handleLoadFromAsikLive();
        } else if (isExcelMode()) {
          records = [];
          await chrome.storage.session.set({ "pelayanan-instan-records": records });
          renderExcelEmptyState();
        } else {
          await fetchAndLoadRecords();
        }
      });
    }

    const switchSessionBtn = document.getElementById("btn-switch-pelayanan-instan-session");
    if (switchSessionBtn) {
      switchSessionBtn.addEventListener("click", () => {
        renderModeSelection();
      });
    }

    const switchBtn = document.getElementById("btn-switch-pelayanan-instan-mode");
    if (switchBtn) {
      switchBtn.addEventListener("click", () => {
        setPelayananInstanMode(null);
      });
    }

    const ageSelect = document.getElementById("age-filter-pelayanan-instan");
    if (ageSelect) {
      ageSelect.addEventListener("change", () => {
        selectedAge = ageSelect.value;
        chrome.storage.session.set({ "pelayanan-instan-age": selectedAge });
        currentInstanPage = 1;
        renderPatientList(getSortedRecords());
      });
    }

    const statusSelect = document.getElementById("status-filter-pelayanan-instan");
    if (statusSelect) {
      statusSelect.addEventListener("change", () => {
        selectedStatus = statusSelect.value;
        chrome.storage.session.set({ "pelayanan-instan-status": selectedStatus });
        currentInstanPage = 1;
        renderPatientList(getSortedRecords());
      });
    }

    const emptySyncBtn = document.getElementById("btn-sync-database-empty");
    if (emptySyncBtn) {
      emptySyncBtn.addEventListener("click", async () => {
        emptySyncBtn.disabled = true;
        emptySyncBtn.innerHTML = `
          <svg class="spin-icon" xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="animation: spin 0.8s linear infinite;"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-4.5"/></svg>
          Menyinkronkan data…
        `;
        await fetchAndLoadRecords();
      });
    }
  }

  function renderDatabaseEmptyState() {
    containerEl.innerHTML = `
      ${renderFilterHeader()}
      <div class="promo-placeholder" style="margin-top: 12px;">
        <div class="promo-icon-ring">
          <svg xmlns="http://www.w3.org/2000/svg" width="34" height="34" viewBox="0 0 24 24" fill="none" aria-hidden="true" class="promo-placeholder__icon">
            <!-- Biometric HUD Targeting Brackets -->
            <path d="M4 6V4H6" stroke="#60a5fa" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
            <path d="M18 4H20V6" stroke="#60a5fa" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
            <path d="M4 18V20H6" stroke="#60a5fa" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
            <path d="M18 20H20V18" stroke="#60a5fa" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
            <!-- Cybernetic Avatar Silhouette with Optic Visor -->
            <circle cx="12" cy="8.5" r="3.8" stroke="currentColor" stroke-width="1.5" fill="rgba(14, 165, 233, 0.12)" />
            <line x1="9.5" y1="8.5" x2="14.5" y2="8.5" stroke="#ffffff" stroke-width="1.8" stroke-linecap="round" />
            <!-- Torso Tech Mesh -->
            <path d="M6.5 19.5C6.5 16.2 9 14.8 12 14.8C15 14.8 17.5 16.2 17.5 19.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
            <!-- Biometric Laser Scanner Line -->
            <line x1="3" y1="12" x2="21" y2="12" stroke="#38bdf8" stroke-width="1.2" stroke-dasharray="2 2" opacity="0.65" />
            <circle cx="12" cy="3.5" r="0.9" fill="#38bdf8" />
          </svg>
        </div>
        <p class="promo-placeholder__heading">Belum ada pasien</p>
        <p class="promo-placeholder__body">
          Data pasien akan muncul di sini setelah pendaftaran selesai.<br>
          Pastikan tab <strong>Pendaftaran</strong> sudah dijalankan terlebih dahulu.
        </p>
        <div style="margin-top: 14px; text-align: center;">
          <button type="button" id="btn-sync-database-empty" class="btn btn--primary" style="font-size: 12px; padding: 7px 16px; gap: 6px; display: inline-flex; align-items: center; border-radius: 6px; cursor: pointer;">
            <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-4.5"/></svg>
            Tarik Data Selesai Pendaftaran
          </button>
        </div>
      </div>
    `;
    attachHeaderListeners();
  }

  function getUniqueSekolahList() {
    const set = new Set();
    for (const r of records) { if (r.sekolah) set.add(r.sekolah.trim()); }
    return [...set].sort();
  }

  function getUniqueKelasList() {
    const set = new Set();
    for (const r of records) {
      if (!r.kelas) continue;
      if (selectedSekolah && r.sekolah?.trim() !== selectedSekolah) continue;
      set.add(r.kelas.trim());
    }
    return [...set].sort();
  }

  function getSortedRecords() {
    let filtered = records;

    const isSchool = selectedCategory === "EXCEL_SEKOLAH" || selectedCategory === "SEKOLAH";
    if (isSchool) {
      if (selectedSekolah) filtered = filtered.filter(r => r.sekolah?.trim() === selectedSekolah);
      if (selectedKelas) filtered = filtered.filter(r => r.kelas?.trim() === selectedKelas);
    }

    if (selectedAge && selectedAge !== "ALL") {
      filtered = filtered.filter(r => getAgeCategory(r) === selectedAge);
    }

    if (selectedStatus && selectedStatus !== "ALL") {
      filtered = filtered.filter(r => matchesPelayananStatus(r, selectedStatus));
    }

    const PRIORITY = { PARTIAL_DONE_PELAYANAN: 0, DONE_PENDAFTARAN: 1, DONE_PELAYANAN: 2, MISSING: 3, SERVER_ERROR: 4 };

    return filtered.sort((a, b) => {
      const pA = PRIORITY[a.status] ?? 1;
      const pB = PRIORITY[b.status] ?? 1;
      if (pA !== pB) return pA - pB;
      return new Date(a.registered_at || a.created_at || 0).getTime() - new Date(b.registered_at || b.created_at || 0).getTime();
    });
  }

  function renderPatientList(listData) {
    if (!records.length) {
      return isExcelMode() ? renderExcelEmptyState() : renderDatabaseEmptyState();
    }

    if (selectedCategory === "SEKOLAH") {
      bulkFooterRow.hidden = true;
      excelFooterRow.hidden = true;
    } else {
      showBulkFooter();
    }

    const anyInProgressSekolah = selectedCategory === "SEKOLAH" && listData.some(r => r._status === "in-progress");

    const totalFiltered = listData.length;
    const totalPages = Math.max(1, Math.ceil(totalFiltered / INSTAN_PAGE_SIZE));
    if (currentInstanPage > totalPages) currentInstanPage = totalPages;
    if (currentInstanPage < 1) currentInstanPage = 1;

    const startIdx = (currentInstanPage - 1) * INSTAN_PAGE_SIZE;
    const endIdx = Math.min(startIdx + INSTAN_PAGE_SIZE, totalFiltered);
    const pagedList = listData.slice(startIdx, endIdx);

    let itemsHtml = "";
    if (listData.length === 0) {
      itemsHtml = `<li class="patient-empty-filter">Tidak ada pasien yang sesuai filter terpilih.</li>`;
    } else {
      itemsHtml = pagedList
        .map((item, sliceIdx) => {
          const displayIdx = startIdx + sliceIdx + 1;
          const realIdx = records.indexOf(item);
          const rawStatus = item.status ?? "DONE_PENDAFTARAN";
          const cfg = STATUS_CONFIG[rawStatus] ?? { label: rawStatus, cls: "" };
          const inProgress = item._status === "in-progress";
          const isErr = isRecordError(item);
          const isDone = isRecordDone(item);

          let labelText = cfg.label;
          if (inProgress) {
            labelText = (typeof item._progressPct === "number" && item._formStep)
              ? `⏳ ${item._progressPct}% (${item._formStep})`
              : "⏳ Proses";
          }
          const labelCls = inProgress ? "patient-badge--in-progress" : cfg.cls;

          const subMetaParts = [
            item.nik || null,
            item.nomorTiket ? `Tiket: ${item.nomorTiket}` : null,
            item.sourceTab && selectedCategory === "ASIK_LIVE" ? item.sourceTab : null
          ].filter(Boolean).join(" · ");

          let detailLineHtml = subMetaParts
            ? `<span style="font-size:10px;color:#94a3b8;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${subMetaParts}</span>`
            : "";

          if (inProgress && item._progressMsg) {
            const pctVal = typeof item._progressPct === "number" ? Math.max(0, Math.min(100, item._progressPct)) : 0;
            const barHtml = typeof item._progressPct === "number"
              ? `<div style="width:100%;height:4px;background:rgba(148,163,184,0.22);border-radius:999px;overflow:hidden;margin-top:3px;"><div style="width:${pctVal}%;height:100%;background:#38bdf8;transition:width 0.25s ease;"></div></div>`
              : "";
            detailLineHtml += `<div style="font-size:10px;color:#38bdf8;margin-top:2px;">${item._progressMsg}${barHtml}</div>`;
          } else if (isErr && item._errorMsg) {
            detailLineHtml += `<div style="font-size:10px;color:#f87171;margin-top:2px;">${item._errorMsg}</div>`;
          }

          return `
          <li class="patient-item" style="align-items:center;">
            <span class="patient-item__num">${displayIdx}</span>
            <div style="flex:1;min-width:0;display:flex;flex-direction:column;">
              <span class="patient-item__name">${item.nama || "—"}</span>
              ${detailLineHtml}
            </div>
            <span class="patient-badge ${labelCls}">${labelText}</span>
            <button type="button" class="${inProgress ? "patient-item__stop" : "patient-item__play"}" data-index="${realIdx}" ${isDone || (!inProgress && anyInProgressSekolah) ? "disabled" : ""
            } aria-label="${inProgress ? "Stop" : isErr ? "Periksa ulang " + (item.nama || "") : "Jalankan " + (item.nama || "")}" title="${inProgress ? "Stop" : isErr ? "Periksa ulang pasien ini" : "Jalankan pasien ini"}">
              ${inProgress
              ? '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="4" y="4" width="16" height="16"/></svg>'
              : '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><polygon points="5 3 19 12 5 21 5 3"/></svg>'
            }
            </button>
          </li>
        `;
        })
        .join("");
    }

    const isSchool = selectedCategory === "EXCEL_SEKOLAH" || selectedCategory === "SEKOLAH";
    const deleteBtnHtml = isExcelMode()
      ? '<button type="button" id="btn-hapus-excel-instan" class="btn btn--ghost-danger">Hapus</button>'
      : '<button type="button" id="btn-hapus-database-instan" class="btn btn--ghost-danger" title="Kosongkan database antrean pasien">Kosongkan</button>';

    const sekolahFilterHtml = (isSchool && records.some(r => r.sekolah)) ? `
      <div style="display:flex;gap:6px;margin-top:8px;">
        <div class="select__wrapper" style="flex:1;">
          <select id="filter-sekolah-instan" class="field__select" style="font-size:12px;">
            <option value="">— Semua Sekolah —</option>
            ${getUniqueSekolahList().map(s => `<option value="${s}"${selectedSekolah === s ? ' selected' : ''}>${s}</option>`).join('')}
          </select>
          <span class="select__arrow">▾</span>
        </div>
        <div class="select__wrapper" style="flex:1;">
          <select id="filter-kelas-instan" class="field__select" style="font-size:12px;">
            <option value="">— Semua Kelas —</option>
            ${getUniqueKelasList().map(k => `<option value="${k}"${selectedKelas === k ? ' selected' : ''}>${k}</option>`).join('')}
          </select>
          <span class="select__arrow">▾</span>
        </div>
      </div>
    ` : '';

    const countText = listData.length !== records.length
      ? `${listData.length} / ${records.length} pasien`
      : `${records.length} pasien`;

    containerEl.innerHTML = `
      ${renderFilterHeader()}
      ${renderFilterControls()}
      ${sekolahFilterHtml}
      <div class="pendaftaran-list">
        <div class="pendaftaran-list__header">
          <span class="pendaftaran-list__count">${countText}</span>
          ${deleteBtnHtml}
        </div>
        <ul class="patient-list" id="pelayanan-instan-list">
          ${itemsHtml}
        </ul>
        <div id="pelayanan-instan-pagination" class="bot-pagination" ${totalFiltered <= INSTAN_PAGE_SIZE ? "hidden" : ""}>
          <button id="btn-instan-prev-page" class="btn-page-nav" type="button" ${currentInstanPage <= 1 ? "disabled" : ""}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="15 18 9 12 15 6"/></svg>
            <span>Sebelumnya</span>
          </button>
          <span class="page-nav-info"><span>Hal <strong>${currentInstanPage}</strong>/<strong>${totalPages}</strong></span> <span class="page-nav-range">(${totalFiltered === 0 ? 0 : `${(startIdx + 1).toLocaleString("id-ID")}–${endIdx.toLocaleString("id-ID")}`})</span></span>
          <button id="btn-instan-next-page" class="btn-page-nav" type="button" ${currentInstanPage >= totalPages ? "disabled" : ""}>
            <span>Selanjutnya</span>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"/></svg>
          </button>
        </div>
      </div>
    `;

    attachHeaderListeners();
    updateRestartErrorButtonVisibility();

    const prevBtn = document.getElementById("btn-instan-prev-page");
    if (prevBtn) {
      prevBtn.addEventListener("click", () => {
        if (currentInstanPage > 1) {
          currentInstanPage--;
          renderPatientList(getSortedRecords());
          const listUl = document.getElementById("pelayanan-instan-list");
          if (listUl) listUl.scrollTop = 0;
        }
      });
    }

    const nextBtn = document.getElementById("btn-instan-next-page");
    if (nextBtn) {
      nextBtn.addEventListener("click", () => {
        const totalPages = Math.max(1, Math.ceil(listData.length / INSTAN_PAGE_SIZE));
        if (currentInstanPage < totalPages) {
          currentInstanPage++;
          renderPatientList(getSortedRecords());
          const listUl = document.getElementById("pelayanan-instan-list");
          if (listUl) listUl.scrollTop = 0;
        }
      });
    }

    const sekolahSelect = document.getElementById("filter-sekolah-instan");
    if (sekolahSelect) {
      sekolahSelect.addEventListener("change", () => {
        selectedSekolah = sekolahSelect.value;
        selectedKelas = "";
        currentInstanPage = 1;
        chrome.storage.session.set({ "pelayanan-instan-sekolah": selectedSekolah, "pelayanan-instan-kelas": "" });
        renderPatientList(getSortedRecords());
      });
    }
    const kelasSelect = document.getElementById("filter-kelas-instan");
    if (kelasSelect) {
      kelasSelect.addEventListener("change", () => {
        selectedKelas = kelasSelect.value;
        currentInstanPage = 1;
        chrome.storage.session.set({ "pelayanan-instan-kelas": selectedKelas });
        renderPatientList(getSortedRecords());
      });
    }

    const deleteExcelBtn = document.getElementById("btn-hapus-excel-instan");
    if (deleteExcelBtn) {
      deleteExcelBtn.addEventListener("click", async () => {
        records = [];
        selectedSekolah = "";
        selectedKelas = "";
        selectedAge = "ALL";
        selectedStatus = "ALL";
        currentInstanPage = 1;
        saveRecordsToSession();
        await chrome.storage.session.set({
          "pelayanan-instan-sekolah": "",
          "pelayanan-instan-kelas": "",
          "pelayanan-instan-age": "ALL",
          "pelayanan-instan-status": "ALL"
        });
        await chrome.storage.session.remove(["pelayanan-instan-records"]);
        await chrome.storage.local.remove(["pelayanan-instan-records"]);
        await setActiveLogId("pasien", "none");
        renderExcelEmptyState();
      });
    }

    const deleteDatabaseBtn = document.getElementById("btn-hapus-database-instan");
    if (deleteDatabaseBtn) {
      deleteDatabaseBtn.addEventListener("click", async () => {
        if (selectedCategory === "ASIK_LIVE") {
          if (!confirm("Kosongkan antrean web ASIK ini?")) return;
          records = [];
          currentInstanPage = 1;
          saveRecordsToSession();
          await chrome.storage.session.remove(["pelayanan-instan-records"]);
          await setActiveLogId("pasien", "none");
          await renderModeSelection();
          return;
        }

        if (!confirm("Kosongkan antrean database pasien ini?")) return;
        records = [];
        selectedSekolah = "";
        selectedKelas = "";
        selectedAge = "ALL";
        selectedStatus = "ALL";
        currentInstanPage = 1;
        saveRecordsToSession();
        await chrome.storage.session.remove(["pelayanan-instan-records"]);
        await chrome.storage.local.remove(["pelayanan-instan-records"]);
        await setActiveLogId("pasien", "none");
        const cat = selectedCategory === "SEKOLAH" ? "SEKOLAH" : "UMUM";
        await clearPendaftaranRecords(cat);
        renderDatabaseEmptyState();
      });
    }

    const actionBtns = document.querySelectorAll("#pelayanan-instan-list button[data-index]");
    actionBtns.forEach(btn => {
      const realIndex = parseInt(btn.dataset.index, 10);
      const rec = records[realIndex];

      if (btn && rec && realIndex !== -1) {
        btn.addEventListener("click", async () => {
          if (rec._status === "in-progress") {
            rec._status = "idle";
            saveRecordsToSession();
            renderPatientList(getSortedRecords());
            if (selectedCategory === "ASIK_LIVE") {
              chrome.runtime.sendMessage({ type: "ASIK_LIVE_STOP" }).catch(() => {});
            } else {
              chrome.runtime.sendMessage({ type: "PELAYANAN_INSTAN_STOP", recordIndex: realIndex });
            }
            return;
          }

          if (selectedCategory === "ASIK_LIVE") {
            try {
              rec._status = "in-progress";
              saveRecordsToSession();
              renderPatientList(getSortedRecords());

              const msgPayload = {
                type: "RUN_ASIK_LIVE_SINGLE",
                recordIndex: realIndex,
                patientRecord: rec
              };
              const res = await chrome.runtime.sendMessage(msgPayload);
              if (!res?.ok) {
                rec._status = "idle";
                saveRecordsToSession();
                renderPatientList(getSortedRecords());
                alert("Gagal menjalankan otomasi: " + (res?.error || "Unknown error"));
              }
            } catch (err) {
              rec._status = "idle";
              saveRecordsToSession();
              renderPatientList(getSortedRecords());
              alert("Gagal menjalankan otomasi: " + err.message);
            }
            return;
          }

          const nik = rec.nik;
          if (!nik) {
            alert("Data NIK tidak ada");
            return;
          }

          let tanggalData;
          if (isExcelMode()) {
            const today = new Date();
            tanggalData = { tahun: today.getFullYear(), bulan: today.getMonth() + 1, hari: today.getDate() };
          } else {
            tanggalData = parseDate(rec.registered_at || rec.created_at);
          }

          console.log("[Pelayanan Instan] Starting automation for:", { nik, tanggalData, category: rec.category });

          try {
            rec._status = "in-progress";
            saveRecordsToSession();
            renderPatientList(getSortedRecords());

            const msgPayload = { type: "RUN_PELAYANAN_AUTOMATION", recordIndex: realIndex, nik, tanggalData, patientRecord: rec };
            if (isExcelMode()) {
              msgPayload.isExcel = true;
            }

            const res = await chrome.runtime.sendMessage(msgPayload);
            if (!res.ok) {
              rec._status = "idle";
              saveRecordsToSession();
              renderPatientList(getSortedRecords());
              alert("Gagal menjalankan otomasi: " + (res.error || "Unknown error"));
            }
          } catch (err) {
            rec._status = "idle";
            saveRecordsToSession();
            renderPatientList(getSortedRecords());
            console.error("[Pelayanan Instan] Automation error:", err);
            alert("Gagal menjalankan otomasi: " + err.message);
          }
        });
      }
    });
  }

  let saveSessionTimer = null;
  function debouncedSaveRecordsToSession(delay = 1500) {
    if (saveSessionTimer) clearTimeout(saveSessionTimer);
    saveSessionTimer = setTimeout(() => {
      saveSessionTimer = null;
      flushSaveRecordsToSession();
    }, delay);
  }

  function flushSaveRecordsToSession() {
    if (saveSessionTimer) {
      clearTimeout(saveSessionTimer);
      saveSessionTimer = null;
    }
    try {
      const storageArea = chrome.storage?.session || chrome.storage?.local;
      if (storageArea) {
        storageArea.set({ "pelayanan-instan-records": records }).catch(() => { });
      }
    } catch (err) {
      console.warn("[Pelayanan Instan] saveRecordsToSession warning:", err);
    }
    debouncedSyncStatsToActiveLog();
  }

  function saveRecordsToSession() {
    flushSaveRecordsToSession();
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
    if (!records || !records.length) return;
    const berhasil = records.filter(r => (r.status === "DONE_PELAYANAN" || (r._status === "done" && r.status !== "DONE_PENDAFTARAN")) && r._status !== "already-screened" && r.status !== "ALREADY_SCREENED" && !isRecordError(r)).length;
    const sebagian = records.filter(r => (r.status === "PARTIAL_DONE_PELAYANAN" || r._status === "partial") && !isRecordError(r)).length;
    const gagal = records.filter(isRecordError).length;
    const pernahInput = records.filter(r => (r._status === "already-screened" || r.status === "ALREADY_SCREENED") && !isRecordError(r)).length;
    await updateActiveLog("pasien", {
      total: records.length,
      berhasil,
      gagal,
      sebagian,
      pernahInput,
      data: records
    });
  }

  function syncStatsToActiveLog() {
    return flushSyncStatsToActiveLog();
  }

  async function fetchAndLoadRecords() {
    if (isExcelMode()) {
      records = [];
      await chrome.storage.session.set({ "pelayanan-instan-records": records });
      renderExcelEmptyState();
      return;
    }

    if (await checkDeviceOrSignOut()) {
      containerEl.innerHTML = `
        ${renderFilterHeader()}
        <div class="field">
          <p style="text-align: center; color: #666; padding: 20px;">Memuat data…</p>
        </div>
      `;
      attachHeaderListeners();

      try {
        const queryCat = selectedCategory === "SEKOLAH" ? "SEKOLAH" : "UMUM";

        // Sinkronisasi Live: Ambil pasien pendaftaran yang sudah berhasil (status 'done')
        // secara batch cepat (atomic) dari memori aktif, storage session/local, atau log history
        try {
          const directCandidates = typeof getPendaftaranPatients === "function" ? getPendaftaranPatients() : null;
          await syncPendaftaranPatientsToDatabase(queryCat, directCandidates);
        } catch (syncErr) {
          console.warn("[Pelayanan Instan] Sync live pendaftaran warning:", syncErr);
        }

        records = await getPendaftaranRecords(queryCat);
        normalizeRecords(records);
        await chrome.storage.session.set({ "pelayanan-instan-records": records }).catch(() => { });

        if (records && records.length !== 0) {
          renderPatientList(getSortedRecords());
        } else {
          renderDatabaseEmptyState();
        }
      } catch (err) {
        console.error("[Pelayanan Instan] failed to load records:", err);
        const errMsg = err.message ?? "Terjadi kesalahan saat memuat data";
        containerEl.innerHTML = `
          ${renderFilterHeader()}
          <div class="field">
            <div style="text-align: center; padding: 20px;">
              <svg xmlns="http://www.w3.org/2000/svg" width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="color: #dc2626; margin-bottom: 12px;">
                <circle cx="12" cy="12" r="10"/>
                <line x1="12" y1="8" x2="12" y2="12"/>
                <line x1="12" y1="16" x2="12.01" y2="16"/>
              </svg>
              <p style="color: #374151; margin: 8px 0; font-weight: 500;">Gagal memuat data</p>
              <p style="color: #666; font-size: 13px; margin: 8px 0;">${errMsg}</p>
            </div>
          </div>
        `;
        attachHeaderListeners();
      }
    }
  }

  chrome.runtime.onMessage.addListener(async msg => {
    if (msg.type === "PELAYANAN_QUEUE_DONE" || msg.type === "PELAYANAN_ALL_STOPPED") {
      setBulkRunningState(false, false);
      flushSaveRecordsToSession();
      flushSyncStatsToActiveLog();
      renderPatientList(getSortedRecords());
      flushPendingPatientSync().catch(() => { });

      // 🤖 Kirim Sesi Log Pelayanan ke Database ckgbankot
      const totalP = records.length;
      const b = records.filter(r => isRecordDone(r)).length;
      const g = records.filter(r => isRecordError(r)).length;
      if (totalP > 0) {
        syncLogToCkgbankot({
          jenis_kegiatan: "Pelayanan " + (selectedCategory || "UMUM"),
          total_pasien: totalP,
          jumlah_berhasil: b,
          jumlah_terdaftar: 0,
          jumlah_gagal: g,
          status: g > 0 ? "Selesai Sebagian" : "Selesai",
          keterangan: `Pelayanan selesai: ${b} selesai pelayanan, ${g} gagal/missing.`
        }).catch(e => console.warn("[ENCO Sync] syncLog Pelayanan error:", e));
      }
      return;
    }
    if (msg.type === "PELAYANAN_PAUSED") {
      setBulkRunningState(true, true);
      return;
    }
    if (msg.type === "PELAYANAN_RESUMED") {
      setBulkRunningState(true, false);
      return;
    }
    if (msg.type !== "PELAYANAN_INSTAN_STATUS") return;
    const { nik, automationStatus, recordStatus, text, formIndex, formTotal, formName, percent } = msg;

    if (automationStatus === "done") {
      const idx = records.findIndex(r => r.nik === nik || r.nomorTiket === nik || r.id === nik || r.nama === nik);
      if (idx !== -1) {
        records[idx]._status = "done";
        records[idx]._progressMsg = "";
        records[idx]._progressPct = null;
        records[idx]._formStep = "";
        records[idx]._errorMsg = "";
        if (recordStatus) records[idx].status = recordStatus;
        debouncedSaveRecordsToSession();
        renderPatientList(getSortedRecords());

        // 🤖 Sinkronisasi Pelayanan Selesai ke Database ckgbankot & Antrean Bot
        const rec = records[idx];
        updateQueueStatusToCkgbankot({
          nik: rec.nik,
          jenis: (selectedCategory && selectedCategory.includes("SEKOLAH")) ? "SEKOLAH" : "UMUM",
          status_pelayanan: "Selesai Pelayanan",
          keterangan: "Pelayanan Selesai via Bot ENCO"
        }).catch(e => console.warn("[ENCO Sync] updateQueueStatusToCkgbankot error:", e));

        syncPatientToCkgbankot({
          nik: rec.nik,
          nama: rec.nama || rec.name,
          tanggal_lahir: rec.tanggal_lahir || rec.tanggallahir || rec.dob || rec.tgllahir || "",
          jenis_kelamin: rec.jenis_kelamin || rec.jeniskelamin || rec.jk || rec.gender || "",
          status_pernikahan: rec.status_pernikahan || rec.statuspernikahan || rec.statusnikah || rec.nikah || "",
          pekerjaan: rec.pekerjaan || rec.job || "",
          provinsi: rec.provinsi || rec.province || "Jawa Barat",
          kab_kota: rec.kab_kota || rec.kabkota || rec.kota || rec.kabupaten || "Kab. Bandung",
          kecamatan: rec.kecamatan || rec.district || "Banjaran",
          kelurahan: rec.kelurahan || rec.desa || rec.subdistrict || "",
          alamat: rec.alamat || rec.detailalamat || rec.detaildomisili || rec.address || "",
          no_tiket: rec.no_tiket || rec.ticket || "",
          kategori: selectedCategory || "UMUM",
          status_pendaftaran: "Sudah Terdaftar",
          status_pelayanan: "Selesai Pelayanan",
          tanggal_pelayanan: new Date().toISOString().split("T")[0],
          raw_details: rec
        }).catch(e => console.warn("[ENCO Sync] syncPatient Pelayanan error:", e));
      }

      if (recordStatus !== "MISSING") {
        setTimeout(async () => {
          try {
            if (!isExcelMode() && selectedCategory !== "ASIK_LIVE") {
              const queryCat = selectedCategory === "SEKOLAH" ? "SEKOLAH" : "UMUM";
              const fetched = await getPendaftaranRecords(queryCat);
              const curMap = new Map(records.map(r => [r.nik, r]));
              let hasNew = false;
              for (const f of fetched) {
                if (!curMap.has(f.nik)) {
                  records.push(f);
                  curMap.set(f.nik, f);
                  hasNew = true;
                }
              }
              if (hasNew) {
                normalizeRecords(records);
                saveRecordsToSession();
                renderPatientList(getSortedRecords());
              }
            }
          } catch (err) {
            console.error("[pelayanan-instan] Failed to merge records after done:", err);
          }
        }, 1500);
      }
      return;
    }

    const idx = records.findIndex(r => r.nik === nik || r.nomorTiket === nik || r.id === nik || r.nama === nik);
    if (idx !== -1) {
      if (automationStatus) records[idx]._status = automationStatus;
      if (recordStatus) records[idx].status = recordStatus;
      if (automationStatus === "error" || recordStatus === "error") {
        records[idx]._errorMsg = text || "Gagal";
        records[idx]._progressMsg = "";
        records[idx]._progressPct = null;
        records[idx]._formStep = "";
      } else if (automationStatus === "in-progress" || records[idx]._status === "in-progress" || typeof percent === "number") {
        records[idx]._status = "in-progress";
        records[idx]._errorMsg = "";
        records[idx]._progressMsg = formName ? `Mengisi: ${formName}` : (text || "Memproses...");
        records[idx]._progressPct = typeof percent === "number" ? percent : (records[idx]._progressPct ?? null);
        records[idx]._formStep = (formIndex && formTotal) ? `${formIndex}/${formTotal}` : (records[idx]._formStep || "");
      }

      // 🤖 Jika pasien sudah pernah di-input skrining sebelumnya di ASIK, update status ke portal ckgbankot
      if (automationStatus === "already-screened" || recordStatus === "ALREADY_SCREENED") {
        const rec = records[idx];
        updateQueueStatusToCkgbankot({
          nik: rec.nik,
          jenis: (selectedCategory && selectedCategory.includes("SEKOLAH")) ? "SEKOLAH" : "UMUM",
          status_pelayanan: "Pernah Input",
          keterangan: "Pernah Input di ASIK Kemkes"
        }).catch(e => console.warn("[ENCO Sync] updateQueueStatusToCkgbankot Pernah Input error:", e));

        syncPatientToCkgbankot({
          nik: rec.nik,
          nama: rec.nama || rec.name,
          tanggal_lahir: rec.tanggal_lahir || rec.tanggallahir || rec.dob || rec.tgllahir || "",
          jenis_kelamin: rec.jenis_kelamin || rec.jeniskelamin || rec.jk || rec.gender || "",
          status_pernikahan: rec.status_pernikahan || rec.statuspernikahan || rec.statusnikah || rec.nikah || "",
          pekerjaan: rec.pekerjaan || rec.job || "",
          provinsi: rec.provinsi || rec.province || "Jawa Barat",
          kab_kota: rec.kab_kota || rec.kabkota || rec.kota || rec.kabupaten || "Kab. Bandung",
          kecamatan: rec.kecamatan || rec.district || "Banjaran",
          kelurahan: rec.kelurahan || rec.desa || rec.subdistrict || "",
          alamat: rec.alamat || rec.detailalamat || rec.detaildomisili || rec.address || "",
          no_tiket: rec.no_tiket || rec.ticket || "",
          kategori: selectedCategory || "UMUM",
          status_pendaftaran: "Sudah Terdaftar",
          status_pelayanan: "Pernah Input",
          tanggal_pelayanan: new Date().toISOString().split("T")[0],
          raw_details: rec
        }).catch(e => console.warn("[ENCO Sync] syncPatient Pernah Input error:", e));
      }

      // Auto-follow: jika pasien in-progress berada di luar halaman aktif, otomatis geser ke halaman tersebut
      if (automationStatus === "in-progress") {
        const sorted = getSortedRecords();
        const sortedIdx = sorted.findIndex(r => r.nik === nik);
        if (sortedIdx !== -1) {
          const targetPage = Math.floor(sortedIdx / INSTAN_PAGE_SIZE) + 1;
          if (targetPage !== currentInstanPage) {
            currentInstanPage = targetPage;
          }
        }
      }

      saveRecordsToSession();
      renderPatientList(getSortedRecords());
    }
  });

  return {
    getMode: () => pelayananInstanMode,
    resetMode: () => setPelayananInstanMode(null),
    initialize: async function () {
      if (isInitialized) return;

      const sessionVals = await chrome.storage.session.get([
        "pelayanan-instan-mode",
        "pelayanan-instan-category",
        "pelayanan-instan-sekolah",
        "pelayanan-instan-kelas",
        "pelayanan-instan-age",
        "pelayanan-instan-status"
      ]);
      if (sessionVals["pelayanan-instan-mode"]) {
        pelayananInstanMode = sessionVals["pelayanan-instan-mode"];
        selectedCategory = pelayananInstanMode;
      } else if (sessionVals["pelayanan-instan-category"]) {
        const savedCat = sessionVals["pelayanan-instan-category"];
        selectedCategory = savedCat === "EXCEL" ? "EXCEL_SEKOLAH" : savedCat;
      }
      selectedSekolah = sessionVals["pelayanan-instan-sekolah"] || "";
      selectedKelas = sessionVals["pelayanan-instan-kelas"] || "";
      selectedAge = sessionVals["pelayanan-instan-age"] || "ALL";
      selectedStatus = sessionVals["pelayanan-instan-status"] || "ALL";

      const savedLimit = await chrome.storage.local.get("pelayanan-concurrent-limit");
      if (savedLimit["pelayanan-concurrent-limit"]) {
        const parsedLimit = parseInt(savedLimit["pelayanan-concurrent-limit"], 10);
        concurrentLimit = isNaN(parsedLimit) || parsedLimit < 1 ? 1 : parsedLimit > 5 ? 5 : parsedLimit;
        concurrentInput.value = String(concurrentLimit);
      }

      isInitialized = true;
      const storedRecs = await chrome.storage.session.get("pelayanan-instan-records");
      const existingRecords = storedRecs["pelayanan-instan-records"];

      const { pelayananRunning, pelayananPaused } = await chrome.storage.session.get(["pelayananRunning", "pelayananPaused"]);

      if (pelayananRunning && existingRecords && existingRecords.length > 0) {
        records = existingRecords;
        normalizeRecords(records);
        if (!pelayananInstanMode) {
          pelayananInstanMode = selectedCategory;
        }
        const { pelayananInstanPendingStatuses } = await chrome.storage.session.get("pelayananInstanPendingStatuses");
        if (pelayananInstanPendingStatuses?.length) {
          let updated = false;
          for (const { nik, automationStatus, recordStatus } of pelayananInstanPendingStatuses) {
            const idx = records.findIndex(r => r.nik === nik);
            if (idx !== -1) {
              records[idx]._status = automationStatus;
              if (recordStatus) records[idx].status = recordStatus;
              updated = true;
            }
          }
          await chrome.storage.session.remove("pelayananInstanPendingStatuses");
          if (updated) saveRecordsToSession();
        }
        renderPatientList(getSortedRecords());
        showBulkFooter();
        setBulkRunningState(true, !!pelayananPaused);
      } else {
        renderModeSelection();
      }
    },
    loadRecords: fetchAndLoadRecords,
    setFooterButtonsVisibility: function (visible) {
      const mainBtnRow = document.getElementById("pelayanan-btn-row");
      if (mainBtnRow) mainBtnRow.hidden = visible;

      const globalFooter = document.getElementById("btn-footer");

      if (visible && pelayananInstanMode) {
        if (globalFooter) globalFooter.hidden = false;
        if (isExcelMode() && !records.length) {
          showExcelFooter();
        } else if (selectedCategory !== "SEKOLAH" || records.length > 0) {
          showBulkFooter();
        }
      } else {
        bulkFooterRow.hidden = true;
        excelFooterRow.hidden = true;
      }
    },
    resumeFromLog: resumeFromLogEntry,
    createNewSession: async function (customName) {
      if (!records || !records.length) {
        alert("Tidak ada data pasien yang dimuat. Silakan upload file Excel atau pilih kategori terlebih dahulu.");
        return false;
      }

      const historyList = await getHistory("pasien");
      const activeId = await getActiveLogId("pasien");
      const currentActiveEntry = historyList.find(item => item.id === activeId) || historyList[0];
      const baseName = currentActiveEntry?.fileName || (isExcelMode() ? "Data Excel" : "Data Database");
      const sessionName = customName || `${baseName} (Sesi)`;

      // Reset seluruh status pasien agar siap diproses ulang pada sesi baru
      records.forEach(r => {
        r._status = "idle";
        if (r.status !== "DONE_PELAYANAN") {
          r.status = "DONE_PENDAFTARAN";
        }
      });

      const newEntry = await addLogEntry("pasien", {
        fileName: sessionName,
        category: selectedCategory,
        total: records.length,
        berhasil: 0,
        gagal: 0,
        sebagian: 0,
        pernahInput: 0,
        status: "idle",
        data: records
      });

      if (newEntry) {
        await setActiveLogId("pasien", newEntry.id);
      }

      saveRecordsToSession();
      renderPatientList(getSortedRecords());
      return true;
    },
    endActiveSession: async function () {
      await syncStatsToActiveLog();
      await setActiveLogId("pasien", "none");
      records = [];
      selectedSekolah = "";
      selectedKelas = "";
      selectedAge = "ALL";
      selectedStatus = "ALL";
      await chrome.storage.session.set({
        "pelayanan-instan-records": [],
        "pelayanan-instan-sekolah": "",
        "pelayanan-instan-kelas": "",
        "pelayanan-instan-age": "ALL",
        "pelayanan-instan-status": "ALL"
      });
      await chrome.storage.session.remove(["pelayanan-instan-records", "pelayananRunning", "pelayananInstanPendingStatuses", "pelayanan-instan-mode"]);
      await chrome.storage.local.remove(["pelayanan-instan-records"]);
      setPelayananInstanMode(null);
      return true;
    }
  };
}