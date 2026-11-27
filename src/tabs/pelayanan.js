import { DropdownField } from "../components/DropdownField.js";
import { TextField } from "../components/TextField.js";
import { ButtonField } from "../components/ButtonField.js";
import { isFieldVisible, buildFieldRules } from "../fieldConfig.js";
import { getFieldConfig } from "../remoteConfig.js";
import { getUserData, getPendaftaranRecordByNik } from "../auth.js";
import { recordToFieldValues, getDynamicDemographicRules, generateNormalFieldValues } from "../pelayananFormHelper.js";
import { addLogEntry, updateActiveLog, setActiveLogId, getHistory, getActiveLogId, deleteLogEntry } from "../services/historyService.js";
import { downloadTemplateFile } from "../services/templateService.js";
import { detectExcelMappingWithAI, sanitizeNik, sanitizeName, filterValidIdentityRows, formatSkippedIdentitySummary } from "../services/aiService.js";
import { fetchBotQueueFromCkgbankot, updateQueueStatusToCkgbankot } from "../services/encoSyncService.js";

export async function init({ checkDeviceOrSignOut, getTabId, sendToBackground, konfigurasi, fillBtn }) {
  const remoteFields = await getFieldConfig();
  const formEl = document.getElementById("ckg-form");

  let isPaused = false;
  let isPrefilling = false;
  let fetchedItems = [];
  let excelPatients = [];
  let pelayananMode = null; // 'system' | 'excel' | null
  let noticeBanner = null;
  let promoPlaceholder = null;

  const modeSelectionEl = document.getElementById("pelayanan-mode-selection");
  const btnSelectSystem = document.getElementById("btn-select-mode-system");
  const btnSelectExcel = document.getElementById("btn-select-mode-excel");
  const activeBarEl = document.getElementById("pelayanan-active-bar");
  const activeBadgeEl = document.getElementById("pelayanan-active-badge");
  const activeSubEl = document.getElementById("pelayanan-active-sub");
  const btnSwitchMode = document.getElementById("btn-switch-pelayanan-mode");
  const cardPelayananLastSession = document.getElementById("card-pelayanan-last-session");
  const sessionPelayananTime = document.getElementById("session-pelayanan-time");
  const sessionPelayananFilename = document.getElementById("session-pelayanan-filename");
  const sessionPelayananStatDone = document.getElementById("session-pelayanan-stat-done");
  const sessionPelayananStatWarning = document.getElementById("session-pelayanan-stat-warning");
  const sessionPelayananStatError = document.getElementById("session-pelayanan-stat-error");
  const sessionPelayananStatRemaining = document.getElementById("session-pelayanan-stat-remaining");
  const btnPelayananResumeSession = document.getElementById("btn-pelayanan-resume-session");
  const btnPelayananDeleteActiveSession = document.getElementById("btn-pelayanan-delete-active-session");
  const sectionPelayananOtherSessions = document.getElementById("section-pelayanan-other-sessions");
  const selectPelayananOlderSessions = document.getElementById("select-pelayanan-older-sessions");
  const btnPelayananLoadOlderSession = document.getElementById("btn-pelayanan-load-older-session");
  const btnPelayananDeleteOlderSession = document.getElementById("btn-pelayanan-delete-older-session");
  const dividerPelayananSession = document.getElementById("divider-pelayanan-session");
  const btnSwitchPelayananSession = document.getElementById("btn-switch-pelayanan-session");

  let currentPelayananSessions = [];

  let patientState = {
    jenisKelamin: "",
    kategori: "",
    nik: "",
    tanggalLahir: "",
    nomorTiket: "",
    attendDate: "",
    domicile: null,
    job: null,
    bornDate: null,
    mobileNumber: null
  };

  // ── 0. Excel Bar & Status Container ────────────────────────
  const excelBar = document.createElement("div");
  excelBar.className = "pelayanan-excel-bar excel-actions-grid";
  excelBar.innerHTML = `
    <button type="button" class="btn btn--secondary btn-download-template-pelayanan">
      <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
      </svg>
      <span>Download Template</span>
    </button>
    <label class="btn btn--primary btn-upload-excel-pelayanan" for="input-pelayanan-excel" style="cursor: pointer;">
      <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>
      </svg>
      <span>Upload Excel</span>
      <input type="file" id="input-pelayanan-excel" accept=".xlsx,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel" style="display: none;" />
    </label>
    <button type="button" class="btn btn--secondary btn-cloud-ckgbankot-pelayanan" style="border: 1px solid #0284c7; color: #38bdf8;" title="Ambil Antrean Pasien dari Cloud CKG Bankot">
      <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/><polyline points="8 14 12 18 16 14"/><line x1="12" y1="10" x2="12" y2="18"/>
      </svg>
      <span>Ambil CKG Bankot</span>
    </button>
  `;
  formEl.appendChild(excelBar);

  const btnUploadPelayanan = excelBar.querySelector(".btn-upload-excel-pelayanan");
  const inputPelayanan = excelBar.querySelector("#input-pelayanan-excel");
  if (btnUploadPelayanan && inputPelayanan) {
    btnUploadPelayanan.addEventListener("click", e => {
      if (e.target !== inputPelayanan) {
        inputPelayanan.click();
      }
    });
  }

  const btnCloudPelayanan = excelBar.querySelector(".btn-cloud-ckgbankot-pelayanan");
  if (btnCloudPelayanan) {
    btnCloudPelayanan.addEventListener("click", () => {
      handleLoadFromCkgBankot();
    });
  }

  const btnDownloadPelayanan = excelBar.querySelector(".btn-download-template-pelayanan");
  if (btnDownloadPelayanan) {
    btnDownloadPelayanan.addEventListener("click", () => {
      downloadTemplateFile();
    });
  }

  const excelStatus = document.createElement("div");
  excelStatus.className = "excel-status-banner";
  excelStatus.style.cssText = "display: flex; align-items: center; justify-content: space-between; background: rgba(37, 99, 235, 0.15); border: 1px solid rgba(59, 130, 246, 0.35); border-radius: 6px; padding: 6px 10px; font-size: 11px; color: #60a5fa; margin-bottom: 10px;";
  excelStatus.hidden = true;
  excelStatus.innerHTML = `
    <span class="excel-status-text"></span>
    <button type="button" class="btn btn--ghost-danger btn-clear-excel-pelayanan" style="padding: 2px 6px; font-size: 8.5px;">Hapus</button>
  `;
  formEl.appendChild(excelStatus);

  const excelFileInput = excelBar.querySelector("#input-pelayanan-excel");
  const excelClearBtn = excelStatus.querySelector(".btn-clear-excel-pelayanan");
  const excelStatusText = excelStatus.querySelector(".excel-status-text");

  const excelPatientDropdownWrapper = document.createElement("div");
  excelPatientDropdownWrapper.className = "select__wrapper";
  excelPatientDropdownWrapper.style.cssText = "margin-bottom: 10px; display: block;";
  excelPatientDropdownWrapper.hidden = true;
  excelPatientDropdownWrapper.innerHTML = `
    <select id="select-excel-patient-manual" class="field__select" style="font-size: 12px; width: 100%;">
      <option value="">— Pilih Nama Siswa / Pasien dari Excel —</option>
    </select>
    <span class="select__arrow">▾</span>
  `;
  formEl.appendChild(excelPatientDropdownWrapper);
  const excelPatientSelect = excelPatientDropdownWrapper.querySelector("#select-excel-patient-manual");

  function updateExcelStatusUI() {
    if (excelPatients && excelPatients.length > 0) {
      excelStatusText.textContent = `File Excel: ${excelPatients.length} data terload`;
      excelStatus.hidden = false;

      excelPatientSelect.innerHTML = `<option value="">— Pilih Nama Siswa / Pasien dari Excel —</option>` +
        excelPatients.map((p, idx) => {
          const detailStr = p.kelas ? ` (${p.kelas})` : p.sekolah ? ` (${p.sekolah})` : '';
          return `<option value="${idx}">${idx + 1}. ${p.nama || "Tanpa Nama"}${detailStr}</option>`;
        }).join('');
      excelPatientDropdownWrapper.hidden = false;
    } else {
      excelStatus.hidden = true;
      excelStatusText.textContent = "";
      excelPatientDropdownWrapper.hidden = true;
      excelPatientSelect.innerHTML = `<option value="">— Pilih Nama Siswa / Pasien dari Excel —</option>`;
    }
  }

  async function resumeFromLogEntry(entry) {
    if (!entry) return false;
    let sessionData = entry.data;
    if (!sessionData || !sessionData.length) {
      try {
        const userSession = await chrome.storage.local.get(["enco_user_session"]);
        const petugas = userSession.enco_user_session?.nama_user;
        if (petugas && entry.id) {
          const res = await fetch(`https://ckgbankot.web.id/api/enco/sessions/detail?id=${encodeURIComponent(entry.id)}&petugas=${encodeURIComponent(petugas)}&menu=pelayanan`);
          const json = await res.json();
          if (json.success && json.session?.data) {
            sessionData = json.session.data;
          }
        }
      } catch (_) {}
    }
    if (!sessionData || !sessionData.length) return false;
    excelPatients = sessionData;
    chrome.storage.session.set({ pelayananExcelPatients: excelPatients });
    setPelayananMode("excel");
    updateExcelStatusUI();
    await setActiveLogId("pelayanan", entry.id);
    if (excelPatients.length > 0) {
      applyPatientRecordToForm(excelPatients[0]);
    }
    return true;
  }

  async function refreshPelayananSessionPicker() {
    if (!cardPelayananLastSession) return;
    try {
      const history = await getHistory("pelayanan");
      currentPelayananSessions = history || [];
      if (currentPelayananSessions.length > 0) {
        const latest = currentPelayananSessions[0];
        const total = Number(latest.total || 0);
        const berhasil = Number(latest.berhasil || 0);
        const pernah = Number(latest.pernahInput || 0);
        const gagal = Number(latest.gagal || 0);
        const sisa = Math.max(0, total - berhasil - pernah - gagal);
        const timeStr = latest.dateStr || new Date(latest.timestamp || Date.now()).toLocaleString("id-ID");

        if (sessionPelayananFilename) sessionPelayananFilename.textContent = latest.fileName || "Sesi Pelayanan";
        if (sessionPelayananTime) sessionPelayananTime.textContent = timeStr;
        if (sessionPelayananStatDone) sessionPelayananStatDone.textContent = berhasil.toLocaleString("id-ID");
        if (sessionPelayananStatWarning) sessionPelayananStatWarning.textContent = pernah.toLocaleString("id-ID");
        if (sessionPelayananStatError) sessionPelayananStatError.textContent = gagal.toLocaleString("id-ID");
        if (sessionPelayananStatRemaining) sessionPelayananStatRemaining.textContent = `${sisa.toLocaleString("id-ID")} Pasien`;

        if (btnPelayananResumeSession) {
          btnPelayananResumeSession.innerHTML = `
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
            <span>LANJUTKAN SESI INI (${total.toLocaleString("id-ID")} PASIEN)</span>
          `;
        }

        if (currentPelayananSessions.length > 1 && sectionPelayananOtherSessions && selectPelayananOlderSessions) {
          sectionPelayananOtherSessions.hidden = false;
          selectPelayananOlderSessions.innerHTML = currentPelayananSessions.slice(1).map((s, idx) => {
            const t = s.dateStr || new Date(s.timestamp || Date.now()).toLocaleDateString("id-ID");
            return `<option value="${s.id}">${idx + 1}. ${s.fileName || "Sesi"} - ${t} (${s.total || 0} Pasien)</option>`;
          }).join("");
        } else if (sectionPelayananOtherSessions) {
          sectionPelayananOtherSessions.hidden = true;
        }

        cardPelayananLastSession.hidden = false;
        if (dividerPelayananSession) dividerPelayananSession.hidden = false;
      } else {
        cardPelayananLastSession.hidden = true;
        if (dividerPelayananSession) dividerPelayananSession.hidden = true;
      }
    } catch (err) {
      console.warn("[Pelayanan] Error loading history for session picker:", err);
      cardPelayananLastSession.hidden = true;
      if (dividerPelayananSession) dividerPelayananSession.hidden = true;
    }
  }

  function setPelayananMode(mode) {
    pelayananMode = mode;
    chrome.storage.session.set({ pelayananMode: mode });

    if (!mode) {
      if (modeSelectionEl) modeSelectionEl.hidden = false;
      formEl.hidden = true;
      if (activeBarEl) activeBarEl.hidden = true;
      const footer = document.getElementById("btn-footer");
      if (footer) footer.hidden = true;
      refreshPelayananSessionPicker();
      return;
    }

    if (modeSelectionEl) modeSelectionEl.hidden = true;
    formEl.hidden = false;
    if (activeBarEl) activeBarEl.hidden = false;
    const footer = document.getElementById("btn-footer");
    if (footer) footer.hidden = false;

    if (mode === "system") {
      excelBar.hidden = true;
      excelStatus.hidden = true;
      excelPatientDropdownWrapper.hidden = true;
      if (activeBadgeEl) {
        activeBadgeEl.className = "pelayanan-active-badge";
        activeBadgeEl.textContent = "MODE: SISTEM";
      }
      if (activeSubEl) activeSubEl.textContent = "Normal Otomatis";
      const heading = promoPlaceholder?.querySelector(".promo-placeholder__heading");
      const body = promoPlaceholder?.querySelector(".promo-placeholder__body");
      if (heading) heading.textContent = "Otomasi Pelayanan Sistem (Normal)";
      if (body) body.innerHTML = "Klik <strong>Ambil Data</strong> untuk memuat data pasien dari halaman aktif dan mengisi otomatis dengan template hasil normal acak dari sistem.";
    } else {
      excelBar.hidden = false;
      updateExcelStatusUI();
      if (activeBadgeEl) {
        activeBadgeEl.className = "pelayanan-active-badge pelayanan-active-badge--excel";
        activeBadgeEl.textContent = "MODE: FILE EXCEL";
      }
      if (activeSubEl) activeSubEl.textContent = "Data File .xlsx";
      const heading = promoPlaceholder?.querySelector(".promo-placeholder__heading");
      const body = promoPlaceholder?.querySelector(".promo-placeholder__body");
      if (heading) heading.textContent = "Mulai otomasi pelayanan CKG";
      if (body) body.innerHTML = "Klik <strong>Ambil Data</strong> untuk memuat data pasien dari halaman yang sedang aktif, lalu jalankan otomasi dengan satu klik.";
    }
  }

  if (btnSelectSystem) {
    btnSelectSystem.addEventListener("click", () => setPelayananMode("system"));
  }
  if (btnSelectExcel) {
    btnSelectExcel.addEventListener("click", () => setPelayananMode("excel"));
  }
  const btnSelectCloud = document.getElementById("btn-select-mode-cloud");
  if (btnSelectCloud) {
    btnSelectCloud.addEventListener("click", () => handleLoadFromCkgBankot());
  }
  if (btnSwitchMode) {
    btnSwitchMode.addEventListener("click", () => setPelayananMode(null));
  }

  async function handleLoadFromCkgBankot(chosenCategory) {
    let cat = chosenCategory;
    if (!cat) {
      if (typeof window.showCkgBankotCategoryPicker === "function") {
        cat = await window.showCkgBankotCategoryPicker();
      } else {
        cat = "UMUM";
      }
    }
    if (!cat) return; // Dibatalkan pengguna

    const btnCloud = document.getElementById("btn-select-mode-cloud");
    if (btnCloud) btnCloud.disabled = true;

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

      excelPatients = res.data.map(item => ({
        ...item,
        category: cat,
        _queue_id: item._queue_id,
        _queue_record_id: item._queue_record_id,
        _queue_jenis: cat,
        _status: (item._queue_status_pelayanan === "selesai" || item._queue_status_pelayanan === "Selesai Pelayanan") ? "done" : "idle"
      }));

      setPelayananMode("excel");
      updateExcelStatusUI();

      try {
        const storageArea = chrome.storage?.session || chrome.storage?.local;
        if (storageArea) {
          storageArea.set({ pelayananExcelPatients: excelPatients }).catch(() => {});
        }
      } catch (e) {
        console.warn("[Pelayanan] saveExcel error:", e);
      }

      if (excelPatients.length > 0) {
        applyPatientRecordToForm(excelPatients[0]);
      }

      await addLogEntry("pelayanan", {
        fileName: `Antrean Cloud ${cat} (${excelPatients.length} Pasien)`,
        category: cat,
        total: excelPatients.length,
        berhasil: 0,
        gagal: 0,
        sebagian: 0,
        data: excelPatients
      }).catch(err => console.error("[Pelayanan] addLogEntry error:", err));

      alert(`Berhasil mengambil ${excelPatients.length} data pemeriksaan CKG ${cat} dari Cloud CKG Bankot!`);
    } catch (err) {
      console.error("[Pelayanan] Error load CKG Bankot:", err);
      alert("Gagal mengambil data antrean dari CKG Bankot: " + (err.message || err));
    } finally {
      if (btnCloud) btnCloud.disabled = false;
    }
  }

  if (btnPelayananResumeSession) {
    btnPelayananResumeSession.addEventListener("click", async () => {
      if (!currentPelayananSessions.length) return;
      btnPelayananResumeSession.disabled = true;
      btnPelayananResumeSession.innerHTML = `<span class="spin">⏳</span> <span>Mengunduh data sesi dari Cloud...</span>`;
      try {
        await resumeFromLogEntry(currentPelayananSessions[0]);
      } finally {
        if (btnPelayananResumeSession) btnPelayananResumeSession.disabled = false;
      }
    });
  }

  if (btnPelayananDeleteActiveSession) {
    btnPelayananDeleteActiveSession.addEventListener("click", async () => {
      if (!currentPelayananSessions.length) return;
      const latest = currentPelayananSessions[0];
      const fileName = latest.fileName || "Sesi Pelayanan";
      if (!confirm(`Hapus sesi "${fileName}" secara permanen dari Cloud R2 & Database?`)) return;

      btnPelayananDeleteActiveSession.disabled = true;
      try {
        await deleteLogEntry("pelayanan", latest.id);
        const activeLogId = await getActiveLogId("pelayanan");
        if (activeLogId === "none" || activeLogId === latest.id) {
          excelPatients = [];
          await chrome.storage.session.remove(["pelayananExcelPatients"]);
          updateExcelStatusUI();
        }
        await refreshPelayananSessionPicker();
      } catch (err) {
        alert("Gagal menghapus sesi: " + (err.message || err));
      } finally {
        if (btnPelayananDeleteActiveSession) btnPelayananDeleteActiveSession.disabled = false;
      }
    });
  }

  if (btnPelayananLoadOlderSession) {
    btnPelayananLoadOlderSession.addEventListener("click", async () => {
      const selectedId = selectPelayananOlderSessions?.value;
      if (!selectedId) return;
      const target = currentPelayananSessions.find(s => s.id === selectedId);
      if (target) await resumeFromLogEntry(target);
    });
  }

  if (btnPelayananDeleteOlderSession) {
    btnPelayananDeleteOlderSession.addEventListener("click", async () => {
      const selectedId = selectPelayananOlderSessions?.value;
      if (!selectedId) {
        alert("Pilih sesi riwayat terlebih dahulu.");
        return;
      }
      const target = currentPelayananSessions.find(s => s.id === selectedId);
      const fileName = target?.fileName || "Sesi Riwayat";
      if (!confirm(`Hapus sesi "${fileName}" secara permanen dari Cloud R2 & Database?`)) return;

      btnPelayananDeleteOlderSession.disabled = true;
      try {
        await deleteLogEntry("pelayanan", selectedId);
        await refreshPelayananSessionPicker();
      } catch (err) {
        alert("Gagal menghapus sesi: " + (err.message || err));
      } finally {
        if (btnPelayananDeleteOlderSession) btnPelayananDeleteOlderSession.disabled = false;
      }
    });
  }

  if (btnSwitchPelayananSession) {
    btnSwitchPelayananSession.addEventListener("click", () => setPelayananMode(null));
  }

  excelPatientSelect.addEventListener("change", () => {
    const val = excelPatientSelect.value;
    if (val === "" || val == null) {
      noticeBanner.hidden = true;
      return;
    }
    const idx = parseInt(val, 10);
    const matched = excelPatients[idx];
    if (matched) {
      applyPatientRecordToForm(matched);
    }
  });

  async function fetchItemsFromTab(tabId) {
    try {
      const [res] = await chrome.scripting.executeScript({
        target: { tabId },
        world: "MAIN",
        func: () => {
          const isStatusDone = text => {
            const lower = (text || "").toLowerCase();
            if (lower.includes("belum") || lower.includes("sedang") || lower.includes("tidak")) return false;
            return (
              lower.includes("selesai diperiksa") ||
              lower.includes("sudah diperiksa") ||
              lower.includes("selesai") ||
              lower.includes("sudah")
            );
          };

          const tableItems = Array.from(document.querySelectorAll(".table-pemeriksaan-mandiri tr"))
            .filter(tr => tr.querySelector("button") || tr.querySelector("img"))
            .map((tr, idx) => {
              const tds = Array.from(tr.querySelectorAll("td"));
              const titleTd = tds.find(td => {
                const txt = td.innerText.trim();
                return !td.querySelector("button") && !td.querySelector("img") && txt.length > 0 && !/^\d+$/.test(txt);
              }) || tds.find(td => !td.querySelector("button") && td.innerText.trim().length > 0);

              const img = tr.querySelector("img");
              const hasSuccessIcon = !!img && (img.src || "").includes("icon-success.svg");
              const rowText = (tr.innerText || "").toLowerCase();
              const isDone = hasSuccessIcon || isStatusDone(rowText);

              return {
                title: titleTd?.innerText.replace(/\s+/g, " ").trim() ?? `Pemeriksaan Mandiri ${idx + 1}`,
                index: idx,
                done: isDone,
                source: "table"
              };
            });

          const candidateRows = Array.from(document.querySelectorAll(
            "#tableLayanan .grid.grid-cols-5, #tableLayanan .grid-cols-5, .grid.grid-cols-5, #tableLayanan [class*='grid-cols-5']"
          )).filter(r => !r.closest(".table-pemeriksaan-mandiri") && (r.querySelector(".col-span-2") || r.querySelector("button")));

          const colRows = Array.from(document.querySelectorAll("#tableLayanan .col-span-2, [class*='col-span-2']"))
            .filter(c => !c.closest(".table-pemeriksaan-mandiri"))
            .map(c => c.closest(".grid-cols-5") || c.closest(".grid") || c.parentElement)
            .filter(Boolean);

          const seenGrid = new Set();
          const gridRows = [];
          for (const item of [...candidateRows, ...colRows]) {
            if (!item || seenGrid.has(item) || item.closest(".table-pemeriksaan-mandiri")) continue;
            if (item.id === "tableLayanan" || item.classList.contains("space-y-2")) continue;
            seenGrid.add(item);
            gridRows.push(item);
          }

          const gridItems = gridRows.map((row, idx) => {
            const titleEl =
              row?.querySelector(".col-span-2.pl-12.flex.items-center") ||
              row?.querySelector(".col-span-2") ||
              row?.firstElementChild;

            const badge = row?.querySelector("span, div[class*='border'], div[class*='rounded'], [class*='badge']");
            const badgeText = (badge?.innerText || "").toLowerCase();
            const rowText = (row?.innerText || "").toLowerCase();
            const combinedText = `${badgeText} ${rowText}`;
            const isDone = isStatusDone(combinedText);

            return {
              title: titleEl?.innerText.replace(/\s+/g, " ").trim() ?? `Pelayanan Nakes ${idx + 1}`,
              index: tableItems.length + idx,
              done: isDone,
              source: "grid"
            };
          });

          return [...tableItems, ...gridItems];
        }
      });
      return res?.result ?? [];
    } catch (err) {
      console.error("[fetchItemsFromTab] error:", err);
      return [];
    }
  }

  async function ensureFetchedItems() {
    if (fetchedItems && fetchedItems.length > 0) return fetchedItems;
    try {
      const tabId = await getTabId();
      const items = await fetchItemsFromTab(tabId);
      if (items && items.length > 0) {
        fetchedItems = items;
        renderProgressItems(fetchedItems);
      }
    } catch (err) {
      console.error("[ensureFetchedItems] error:", err);
    }
    return fetchedItems;
  }

  async function applyPatientRecordToForm(matched) {
    if (!matched) return;
    try {
      if (matched.tanggal_lahir) patientState.tanggalLahir = matched.tanggal_lahir;
      if (matched.jenis_kelamin) patientState.jenisKelamin = matched.jenis_kelamin;
      if (matched.nik) patientState.nik = matched.nik;
      if (matched.nama) nameDisplay.textContent = matched.nama;
      const valuesMap = await recordToFieldValues(matched);
      isPrefilling = true;

      for (const field of remoteFields) {
        const val = valuesMap[field.id];
        if (!val) continue;

        const component = fieldMap.get(field.id);
        if (field.inputType) {
          const inputEl = component.querySelector("input.field__input");
          if (inputEl) {
            inputEl.value = val;
            fieldValues.set(field.id, val);
          }
        } else {
          fieldValues.set(field.id, val);
          selectOption(component, val);
        }
      }

      isPrefilling = false;
      evaluateVisibility();

      promoPlaceholder.hidden = true;
      btnFetch.hidden = true;
      btnReset.hidden = false;
      btnStart.hidden = false;

      await ensureFetchedItems();

      noticeBanner.innerHTML = `✓ Form terisi dari file Excel untuk: <strong>${matched.nama || matched.nik}</strong>`;
      noticeBanner.hidden = false;
      savePopupState();
    } catch (err) {
      isPrefilling = false;
      console.error("[Manual Select] Prefill failed:", err);
    }
  }

  excelFileInput.addEventListener("change", (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";
    const reader = new FileReader();
    reader.onload = async (evt) => {
      try {
        const XLSX = window.XLSX;
        if (!XLSX) {
          alert("Library XLSX belum siap.");
          return;
        }
        const workbook = XLSX.read(evt.target.result, { type: "array" });
        const sheetName = workbook.SheetNames[0];
        const sheet = workbook.Sheets[sheetName];
        const rawRows = XLSX.utils.sheet_to_json(sheet, { defval: "", raw: false });

        const colMap = {
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
          statuspernikahan: "status_pernikahan", statuskawin: "status_pernikahan", statusmenikah: "status_pernikahan",
          tanggallahir: "tanggal_lahir", tgllahir: "tanggal_lahir", tanggal: "tanggal_lahir", lahir: "tanggal_lahir", dob: "tanggal_lahir", dateofbirth: "tanggal_lahir",
          jeniskelamin: "jenis_kelamin", gender: "jenis_kelamin", kelamin: "jenis_kelamin", jk: "jenis_kelamin", jenis: "jenis_kelamin",
          kreatinin: "kreatinin", hasilemeriksaankreatinin: "kreatinin", nilaikreatinin: "kreatinin",
          ureum: "ureum", hasilpemeriksaanureum: "ureum", nilaiureum: "ureum",
          elfg: "elfg", egfr: "elfg", ckd: "elfg", ckdepi: "elfg",
          kolesterol: "kolesterol", kolesteroltotal: "kolesterol",
          hdl: "hdl", ldl: "ldl",
          trigliserida: "trigliserida", tg: "trigliserida",
          albuminurin: "albumin_urin", konsentrasialbuminurin: "albumin_urin",
          kreatininurin: "kreatinin_urin", konsentrasikreatininurin: "kreatinin_urin"
        };

        const parsedRaw = rawRows.map(row => {
          const cleanRow = {};
          for (const [k, v] of Object.entries(row)) {
            cleanRow[k.toLowerCase().replace(/[^a-z0-9]/g, "")] = v;
          }
          const item = {};
          for (const [rawK, stdK] of Object.entries(colMap)) {
            if (cleanRow[rawK] !== undefined && cleanRow[rawK] !== "") item[stdK] = cleanRow[rawK];
          }
          item.nama = sanitizeName(item.nama || cleanRow.nama || cleanRow.name || cleanRow.namalengkap || cleanRow.namapasien || "");
          item.nik = sanitizeNik(item.nik || cleanRow.nik || cleanRow.nonik || cleanRow.noktp || cleanRow.nomoridentitas || "");
          return item;
        });

        const stdFilter = filterValidIdentityRows(parsedRaw, { dedupeNik: false, checkDobGender: false });
        let parsed = stdFilter.validRows;
        let finalSkippedCount = stdFilter.skippedCount;
        let finalSkippedReasons = stdFilter.reasons;

        // If standard parser failed, trigger AI Smart Column Mapping
        if (!parsedRaw.some(p => p.nik)) {
          const uploadSpan = btnUploadPelayanan?.querySelector("span");
          const origUploadText = uploadSpan ? uploadSpan.textContent : "Upload Excel";
          if (uploadSpan) uploadSpan.textContent = "🤖 AI Menganalisis...";

          try {
            const raw2DRows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });
            if (raw2DRows && raw2DRows.length > 1) {
              const aiRes = await detectExcelMappingWithAI({ raw2DRows, mode: "pelayanan" });
              if (aiRes.success && aiRes.mapping) {
                const { headerRowIndex = 0, mapping = {} } = aiRes;
                const aiParsed = [];
                for (let i = headerRowIndex + 1; i < raw2DRows.length; i++) {
                  const row = raw2DRows[i];
                  if (!Array.isArray(row) || row.every(c => c === "" || c == null)) continue;
                  const getVal = (k) => {
                    const idx = mapping[k];
                    return (idx !== undefined && idx !== null && row[idx] !== undefined) ? String(row[idx]).trim() : "";
                  };
                  const item = {
                    nik: sanitizeNik(getVal("nik")),
                    nama: sanitizeName(getVal("nama")),
                    sekolah: getVal("sekolah"),
                    kelas: getVal("kelas"),
                    bb: getVal("bb"),
                    tb: getVal("tb"),
                    lp: getVal("lp"),
                    td_sistolik: getVal("td_sistolik"),
                    td_diastolik: getVal("td_diastolik"),
                    gula_darah: getVal("gula_darah"),
                    hb: getVal("hb"),
                    merokok: getVal("merokok"),
                    kacamata: getVal("kacamata"),
                    disabilitas: getVal("disabilitas")
                  };
                  if (item.nik || item.nama) {
                    aiParsed.push(item);
                  }
                }
                if (aiParsed.length > 0) {
                  const aiFilter = filterValidIdentityRows(aiParsed, { dedupeNik: false, checkDobGender: false });
                  parsed = aiFilter.validRows;
                  finalSkippedCount = aiFilter.skippedCount;
                  finalSkippedReasons = aiFilter.reasons;
                }
              }
            }
          } finally {
            if (uploadSpan) uploadSpan.textContent = origUploadText;
          }
        }

        const skipSummary = formatSkippedIdentitySummary(finalSkippedReasons);
        if (!parsed.length) {
          alert(skipSummary
            ? `Tidak ada data pasien valid (${finalSkippedCount} baris dilewati: ${skipSummary}).`
            : "Tidak ada data pasien valid ditemukan di file Excel.");
          return;
        }

        excelPatients = parsed;
        updateExcelStatusUI();
        if (finalSkippedCount > 0) {
          alert(`${parsed.length} pasien dimuat.\n${finalSkippedCount} baris dilewati karena data identitas kurang (${skipSummary}).`);
        }
        try {
          const storageArea = chrome.storage?.session || chrome.storage?.local;
          if (storageArea) {
            storageArea.set({ pelayananExcelPatients: excelPatients }).catch(() => {});
          }
        } catch (e) {
          console.warn("[Pelayanan] saveExcel error:", e);
        }

        addLogEntry("pelayanan", {
          fileName: file.name,
          category: "PELAYANAN",
          total: parsed.length,
          berhasil: 0,
          gagal: 0,
          sebagian: 0,
          data: parsed
        }).catch(err => console.error("[Pelayanan] addLogEntry error:", err));
      } catch (err) {
        console.error("[Pelayanan Excel] Parse error:", err);
        alert("Gagal membaca file Excel. Pastikan format file .xlsx valid.");
      }
    };
    reader.readAsArrayBuffer(file);
  });

  excelClearBtn.addEventListener("click", () => {
    excelPatients = [];
    try {
      const storageArea = chrome.storage?.session || chrome.storage?.local;
      if (storageArea) storageArea.remove("pelayananExcelPatients").catch(() => {});
    } catch (e) {}
    updateExcelStatusUI();
  });

  // Restore stored excelPatients if available
  const storageArea = chrome.storage?.session || chrome.storage?.local;
  if (storageArea) {
    storageArea.get("pelayananExcelPatients").then(({ pelayananExcelPatients }) => {
      if (pelayananExcelPatients?.length) {
        excelPatients = pelayananExcelPatients;
        updateExcelStatusUI();
      }
    }).catch(() => {});
  }

  // ── 1. DOM Elements Display ──────────────────────────────────
  const nameDisplay = document.createElement("div");
  nameDisplay.className = "name-display";
  nameDisplay.hidden = true;
  formEl.appendChild(nameDisplay);

  const infoRow = document.createElement("div");
  infoRow.className = "info-row";
  infoRow.hidden = true;
  formEl.appendChild(infoRow);

  const categoryDisplay = document.createElement("span");
  categoryDisplay.className = "category-display";
  infoRow.appendChild(categoryDisplay);

  const genderDisplay = document.createElement("span");
  genderDisplay.className = "jenis-kelamin-display";
  infoRow.appendChild(genderDisplay);

  const attendDateDisplay = document.createElement("span");
  attendDateDisplay.className = "attend-date-display";
  attendDateDisplay.hidden = true;
  infoRow.appendChild(attendDateDisplay);

  noticeBanner = document.createElement("div");
  noticeBanner.className = "excel-notice-banner";
  noticeBanner.style.cssText = "display: flex; align-items: center; gap: 8px; background: rgba(37, 99, 235, 0.15); border: 1px solid rgba(59, 130, 246, 0.35); border-radius: 6px; padding: 6px 10px; font-size: 11px; color: #60a5fa; margin: 6px 0;";
  noticeBanner.hidden = true;
  formEl.appendChild(noticeBanner);

  const patientNotice = document.createElement("div");
  patientNotice.className = "patient-notice";
  patientNotice.hidden = true;
  patientNotice.innerHTML = `
    <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class="patient-notice__icon"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
    <div>
      <p class="patient-notice__heading">Halaman pasien tidak terdeteksi</p>
      <p class="patient-notice__body">Buka halaman detail pasien terlebih dahulu, lalu klik <strong>Ambil Data</strong> kembali.</p>
    </div>
  `;
  formEl.appendChild(patientNotice);

  promoPlaceholder = document.createElement("div");
  promoPlaceholder.className = "promo-placeholder";
  promoPlaceholder.innerHTML = `
    <div class="promo-icon-ring">
      <svg xmlns="http://www.w3.org/2000/svg" width="34" height="34" viewBox="0 0 24 24" fill="none" aria-hidden="true" class="promo-placeholder__icon">
        <!-- HUD Octagonal Tech Reticle -->
        <polygon points="7.8 2.5 16.2 2.5 21.5 7.8 21.5 16.2 16.2 21.5 7.8 21.5 2.5 16.2 2.5 7.8" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" fill="rgba(14, 165, 233, 0.08)" />
        <!-- Targeting Crosshair Ticks -->
        <line x1="12" y1="2.5" x2="12" y2="5" stroke="#60a5fa" stroke-width="1.6" stroke-linecap="round" />
        <line x1="12" y1="19" x2="12" y2="21.5" stroke="#60a5fa" stroke-width="1.6" stroke-linecap="round" />
        <line x1="2.5" y1="12" x2="5" y2="12" stroke="#60a5fa" stroke-width="1.6" stroke-linecap="round" />
        <line x1="19" y1="12" x2="21.5" y2="12" stroke="#60a5fa" stroke-width="1.6" stroke-linecap="round" />
        <!-- High-Energy Cyber Overclock Lightning Core -->
        <polygon points="13 5.5 7.5 13 12 13 11 18.5 16.5 11 12 11 13 5.5" fill="rgba(56, 189, 248, 0.45)" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" />
        <circle cx="12" cy="12" r="1.3" fill="#ffffff" />
      </svg>
    </div>
    <p class="promo-placeholder__heading">Mulai otomasi pelayanan CKG</p>
    <p class="promo-placeholder__body">Klik <strong>Ambil Data</strong> untuk memuat data pasien dari halaman yang sedang aktif, lalu jalankan otomasi dengan satu klik.</p>
  `;
  formEl.appendChild(promoPlaceholder);

  // ── 2. Form Fields Injection ────────────────────────────────
  const fieldMap = new Map();
  const fieldValues = new Map(remoteFields.map(f => [f.id, f.default ?? ""]));

  for (const field of remoteFields) {
    const component = field.inputType
      ? TextField({
          ...field,
          type: field.inputType,
          onChange(val) {
            if (!isPrefilling) {
              fieldValues.set(field.id, val);
              savePopupState();
            }
          }
        })
      : DropdownField({
          ...field,
          onChange(val) {
            if (!isPrefilling) {
              fieldValues.set(field.id, val);
              evaluateVisibility();
              savePopupState();
            }
          }
        });

    component.hidden = true;
    formEl.appendChild(component);
    fieldMap.set(field.id, component);
  }

  function resetFieldValue(field, element) {
    if (field.inputType) {
      const inputEl = element.querySelector("input.field__input");
      if (inputEl) inputEl.value = "";
    } else {
      selectOption(element, "");
    }
    fieldValues.set(field.id, field.default ?? "");
  }

  function evaluateVisibility() {
    for (const field of remoteFields) {
      const el = fieldMap.get(field.id);
      const visible = isFieldVisible(field, fieldValues, patientState);
      if (!visible && !el.hidden) {
        resetFieldValue(field, el);
      }
      el.hidden = !visible;
    }

    for (const field of remoteFields) {
      if (!field.autoValue) continue;
      const { field: targetField, in: inList, value: autoVal } = field.autoValue;
      if (inList.includes(fieldValues.get(targetField) ?? "")) {
        fieldValues.set(field.id, autoVal);
        selectOption(fieldMap.get(field.id), autoVal);
      } else {
        fieldValues.set(field.id, field.default ?? "");
        selectOption(fieldMap.get(field.id), field.default ?? "");
      }
    }
  }

  function selectOption(element, val) {
    const opt = element.querySelector(`.dropdown__option[data-value="${val}"]`);
    opt?.click();
  }

  // ── 3. Progress Tracking List ────────────────────────────────
  const progressList = document.createElement("ul");
  progressList.className = "progress-list";
  progressList.hidden = true;
  formEl.appendChild(progressList);

  const progressItemsMap = new Map();

  function renderProgressItems(items) {
    progressList.innerHTML = "";
    progressItemsMap.clear();

    items.filter(Boolean).forEach(({ title, done, source = "table" }, idx) => {
      const li = document.createElement("li");
      li.className = "progress-item";

      const badge = document.createElement("span");
      badge.className = done ? "progress-badge progress-badge--done" : "progress-badge progress-badge--waiting";
      badge.textContent = done ? "Selesai" : "Menunggu";

      const label = document.createElement("span");
      label.className = "progress-label";
      label.textContent = title;

      const retryBtn = document.createElement("button");
      retryBtn.type = "button";
      retryBtn.className = "btn btn--secondary btn--retry";
      retryBtn.textContent = "Ulangi";
      retryBtn.hidden = !done;

      retryBtn.addEventListener("click", async () => {
        retryBtn.hidden = true;
        const tabId = await getTabId();
        updateProgressBadge(idx, "waiting");
        await sendToBackground({
          type: "RETRY",
          tabId,
          statusMenikah: fieldValues.get("status-menikah") ?? "",
          title,
          source,
          progressIndex: idx,
          delay: konfigurasi.getDelay(),
          fieldRules: generateFieldRules()
        });
      });

      li.appendChild(badge);
      li.appendChild(label);
      li.appendChild(retryBtn);
      progressList.appendChild(li);

      progressItemsMap.set(idx, { li, badge, retryBtn });
    });

    progressList.hidden = false;
  }

  const BADGE_CLASSES = {
    waiting: "progress-badge--waiting",
    "in-progress": "progress-badge--in-progress",
    done: "progress-badge--done",
    error: "progress-badge--error"
  };

  const BADGE_TEXTS = {
    waiting: "Menunggu",
    "in-progress": "Proses...",
    done: "Selesai",
    error: "Error"
  };

  function updateProgressBadge(index, status, errMessage) {
    const item = progressItemsMap.get(index);
    if (!item) return;

    const { li, badge, retryBtn } = item;
    Object.values(BADGE_CLASSES).forEach(c => badge.classList.remove(c));
    badge.classList.add(BADGE_CLASSES[status] ?? "");
    badge.textContent = BADGE_TEXTS[status] ?? status;

    if (errMessage) badge.title = errMessage;
    if (retryBtn) retryBtn.hidden = !konfigurasi.testMode && status !== "error";
    li.scrollIntoView({ block: "nearest" });
  }

  // ── 4. Form Rules & Prefill Helper ────────────────────────────
  const RANDOM_MEASUREMENT_MAP = {
    "berat-badan": "beratBadan",
    "tinggi-badan": "tinggiBadan",
    "lingkar-perut": "lingkarPerut",
    "tekanan-darah-sistolik": "sistolik",
    "tekanan-darah-diastolik": "diastolik",
    "gula-darah": "gulaDarah"
  };

  function generateRandomMeasurements() {
    const comboKey = (() => {
      const cat = (patientState.kategori ?? "").toLowerCase();
      const gen = (patientState.jenisKelamin ?? "").toLowerCase();
      const sub = ["dewasa", "remaja", "lansia"].find(t => cat.includes(t)) ?? "";
      const g = gen.includes("laki") ? "laki-laki" : gen.includes("perempuan") ? "perempuan" : "";
      return sub && g ? `${sub}-${g}` : null;
    })();

    const rangeData = konfigurasi.getRangeData();
    if (!comboKey || !rangeData[comboKey]) return [];

    const config = rangeData[comboKey];
    const rules = [];

    for (const [fieldId, configProp] of Object.entries(RANDOM_MEASUREMENT_MAP)) {
      if (fieldValues.get(fieldId)) continue;
      const [min, max] = config[configProp] ?? [];
      if (min == null || max == null) continue;

      const remoteItem = remoteFields.find(f => f.id === fieldId);
      for (const rule of remoteItem?.rules ?? []) {
        if (rule.valueFrom === "field") {
          const val = String(Math.floor(Math.random() * (max - min + 1)) + min);
          rules.push({ keyword: rule.keyword, type: "input", value: val });
        }
      }
    }
    return rules;
  }

  function generateFieldRules() {
    const coValue = Math.floor(Math.random() * 10) + 8;
    return [
      ...buildFieldRules(fieldValues, patientState, remoteFields),
      ...generateRandomMeasurements(),
      ...getDynamicDemographicRules(patientState),
      { keyword: "Kadar CO Pernapasan", type: "input", value: String(coValue) }
    ];
  }

  async function tryPrefillFromExcel(rawNik, rawName = "") {
    if (!excelPatients || !excelPatients.length) return false;
    const cleanNik = String(rawNik || "").replace(/\D/g, "");
    const cleanName = String(rawName || patientState.name || nameDisplay.textContent || "").trim().toLowerCase();

    if (!cleanNik && !cleanName) return false;

    let matched = null;

    // 1. Try matching by NIK (must be at least 8 digits)
    if (cleanNik && cleanNik.length >= 8) {
      matched = excelPatients.find(p => {
        const pNik = String(p.nik || "").replace(/\D/g, "");
        return pNik.length >= 8 && pNik === cleanNik;
      });
    }

    // 2. Fallback: Match by patient Name
    if (!matched && cleanName) {
      matched = excelPatients.find(p => {
        const excelName = String(p.nama || "").trim().toLowerCase();
        if (!excelName) return false;
        return excelName === cleanName || excelName.includes(cleanName) || cleanName.includes(excelName);
      });
    }

    if (!matched) {
      noticeBanner.hidden = true;
      return false;
    }

    try {
      if (matched.tanggal_lahir) patientState.tanggalLahir = matched.tanggal_lahir;
      if (matched.jenis_kelamin) patientState.jenisKelamin = matched.jenis_kelamin;
      if (matched.nik && !patientState.nik) patientState.nik = matched.nik;
      const valuesMap = await recordToFieldValues(matched);
      isPrefilling = true;

      for (const field of remoteFields) {
        const val = valuesMap[field.id];
        if (!val) continue;

        const component = fieldMap.get(field.id);
        if (field.inputType) {
          const inputEl = component.querySelector("input.field__input");
          if (inputEl) {
            inputEl.value = val;
            fieldValues.set(field.id, val);
          }
        } else {
          fieldValues.set(field.id, val);
          selectOption(component, val);
        }
      }

      isPrefilling = false;
      evaluateVisibility();

      const matchedIndex = excelPatients.indexOf(matched);
      if (matchedIndex !== -1) {
        excelPatientSelect.value = String(matchedIndex);
      }

      noticeBanner.innerHTML = `✓ Form terisi dari file Excel untuk: <strong>${matched.nama || matched.nik}</strong>`;
      noticeBanner.hidden = false;
      console.log("[Ambil Data] Prefilled from Excel patient row:", matched);
      return true;
    } catch (err) {
      isPrefilling = false;
      console.error("[Ambil Data] Prefill from Excel failed:", err);
      return false;
    }
  }

  function savePopupState() {
    chrome.storage.session.set({
      popupState: {
        fetched: !nameDisplay.hidden || !categoryDisplay.hidden,
        name: nameDisplay.textContent || null,
        kategori: categoryDisplay.textContent || null,
        kategoriStyle: categoryDisplay.hidden
          ? null
          : {
              color: categoryDisplay.style.color,
              backgroundColor: categoryDisplay.style.backgroundColor,
              borderColor: categoryDisplay.style.borderColor
            },
        jenisKelamin: genderDisplay.textContent || null,
        attendDate: patientState.attendDate || null,
        nik: patientState.nik || null,
        tanggalLahir: patientState.tanggalLahir || null,
        nomorTiket: patientState.nomorTiket || null,
        domicile: patientState.domicile || null,
        job: patientState.job || null,
        bornDate: patientState.bornDate || null,
        mobileNumber: patientState.mobileNumber || null,
        fields: Object.fromEntries(fieldValues),
        fetchedItems: fetchedItems.filter(Boolean)
      }
    });
  }

  // ── 5. Footer Buttons Construction ───────────────────────────
  const footerEl = document.getElementById("btn-footer");
  const btnRow = document.createElement("div");
  btnRow.id = "pelayanan-btn-row";
  btnRow.className = "field field--button";
  footerEl.appendChild(btnRow);

  const quotaError = document.createElement("p");
  quotaError.className = "quota-error";
  quotaError.hidden = true;
  footerEl.appendChild(quotaError);

  // Ambil Data Button
  const btnFetch = ButtonField({
    label: "Ambil Data",
    variant: "primary",
    onClick: async () => {
      if (!(await checkDeviceOrSignOut())) return;
      const tabId = await getTabId();
      let res;

      try {
        [res] = await chrome.scripting.executeScript({
          target: { tabId },
          world: "MAIN",
          func: () => {
            const catBadge = Array.from(document.querySelectorAll("*")).find(
              e =>
                typeof e.className === "string" &&
                e.className.includes("border-1") &&
                e.className.includes("border-solid") &&
                e.className.includes("border-rd-full") &&
                e.className.includes("px-3") &&
                e.className.includes("py-1")
            );

            const genderEl = Array.from(document.querySelectorAll('[class*="text-[#969BA2]"]')).filter(
              e => e.innerText.includes("Jenis Kelamin")
            )[0]?.nextSibling;

            const nikEl = Array.from(document.querySelectorAll('[class*="text-[#969BA2]"]')).filter(
              e => e.innerText.includes("NIK")
            )[0]?.nextSibling;

            const dobEl = Array.from(document.querySelectorAll('[class*="text-[#969BA2]"]')).filter(
              e => e.innerText.includes("Tanggal Lahir")
            )[0]?.nextSibling;

            const ticketEl = Array.from(document.querySelectorAll('[class*="text-[#969BA2]"]')).filter(
              e => e.innerText.includes("Nomor Tiket")
            )[0]?.nextSibling;

            const badgeStyle = catBadge ? getComputedStyle(catBadge) : null;

            const isStatusDone = text => {
              const lower = (text || "").toLowerCase();
              if (lower.includes("belum") || lower.includes("sedang") || lower.includes("tidak")) return false;
              return (
                lower.includes("selesai diperiksa") ||
                lower.includes("sudah diperiksa") ||
                lower.includes("selesai") ||
                lower.includes("sudah")
              );
            };

            const tableItems = Array.from(document.querySelectorAll(".table-pemeriksaan-mandiri tr"))
              .filter(tr => tr.querySelector("button") || tr.querySelector("img"))
              .map((tr, idx) => {
                const tds = Array.from(tr.querySelectorAll("td"));
                const titleTd = tds.find(td => {
                  const txt = td.innerText.trim();
                  return !td.querySelector("button") && !td.querySelector("img") && txt.length > 0 && !/^\d+$/.test(txt);
                }) || tds.find(td => !td.querySelector("button") && td.innerText.trim().length > 0);

                const img = tr.querySelector("img");
                const hasSuccessIcon = !!img && (img.src || "").includes("icon-success.svg");
                const rowText = (tr.innerText || "").toLowerCase();
                const isDone = hasSuccessIcon || isStatusDone(rowText);

                return {
                  title: titleTd?.innerText.replace(/\s+/g, " ").trim() ?? `Pemeriksaan Mandiri ${idx + 1}`,
                  index: idx,
                  done: isDone,
                  source: "table"
                };
              });

            const candidateRows = Array.from(document.querySelectorAll(
              "#tableLayanan .grid.grid-cols-5, #tableLayanan .grid-cols-5, .grid.grid-cols-5, #tableLayanan [class*='grid-cols-5']"
            )).filter(r => !r.closest(".table-pemeriksaan-mandiri") && (r.querySelector(".col-span-2") || r.querySelector("button")));

            const colRows = Array.from(document.querySelectorAll("#tableLayanan .col-span-2, [class*='col-span-2']"))
              .filter(c => !c.closest(".table-pemeriksaan-mandiri"))
              .map(c => c.closest(".grid-cols-5") || c.closest(".grid") || c.parentElement)
              .filter(Boolean);

            const seenGrid = new Set();
            const gridRows = [];
            for (const item of [...candidateRows, ...colRows]) {
              if (!item || seenGrid.has(item) || item.closest(".table-pemeriksaan-mandiri")) continue;
              if (item.id === "tableLayanan" || item.classList.contains("space-y-2")) continue;
              seenGrid.add(item);
              gridRows.push(item);
            }

            const gridItems = gridRows.map((row, idx) => {
              const titleEl =
                row?.querySelector(".col-span-2.pl-12.flex.items-center") ||
                row?.querySelector(".col-span-2") ||
                row?.firstElementChild;

              const badge = row?.querySelector("span, div[class*='border'], div[class*='rounded'], [class*='badge']");
              const badgeText = (badge?.innerText || "").toLowerCase();
              const rowText = (row?.innerText || "").toLowerCase();
              const combinedText = `${badgeText} ${rowText}`;
              const isDone = isStatusDone(combinedText);

              return {
                title: titleEl?.innerText.replace(/\s+/g, " ").trim() ?? `Pelayanan Nakes ${idx + 1}`,
                index: tableItems.length + idx,
                done: isDone,
                source: "grid"
              };
            });

            return {
              name: document.querySelector("div[class='text-[18px] font-bold']")?.innerText.trim() ?? null,
              kategori: catBadge ? catBadge.innerText.trim() : null,
              jenisKelamin: genderEl ? genderEl.innerText.trim() : null,
              nik: nikEl ? nikEl.innerText.trim() : null,
              tanggalLahir: dobEl ? dobEl.innerText.trim() : null,
              nomorTiket: ticketEl ? ticketEl.innerText.trim() : null,
              items: [...tableItems, ...gridItems],
              style: badgeStyle
                ? {
                    color: badgeStyle.color,
                    backgroundColor: badgeStyle.backgroundColor,
                    borderColor: badgeStyle.borderColor
                  }
                : null
            };
          }
        });
      } catch {
        return void (patientNotice.hidden = false);
      }

      const { name, kategori, jenisKelamin, nik, tanggalLahir, nomorTiket, style, items } = res?.result ?? {};

      if (!kategori) return void (patientNotice.hidden = false);
      patientNotice.hidden = true;

      nameDisplay.textContent = name ?? "";
      nameDisplay.hidden = !name;

      categoryDisplay.textContent = kategori;
      if (style) {
        categoryDisplay.style.color = style.color;
        categoryDisplay.style.backgroundColor = style.backgroundColor;
        categoryDisplay.style.borderColor = style.borderColor;
      }
      categoryDisplay.hidden = false;

      genderDisplay.textContent = jenisKelamin ?? "";
      infoRow.hidden = false;

      patientState = {
        jenisKelamin: jenisKelamin ?? "",
        kategori: kategori ?? "",
        nik: nik ?? "",
        tanggalLahir: tanggalLahir ?? "",
        nomorTiket: nomorTiket ?? "",
        attendDate: new Date().toISOString().split("T")[0],
        domicile: null,
        job: null,
        bornDate: null,
        mobileNumber: null
      };

      for (const field of remoteFields) {
        if (!field.showWhen) fieldMap.get(field.id).hidden = false;
      }
      evaluateVisibility();

      for (const field of remoteFields) {
        const comp = fieldMap.get(field.id);
        if (comp.hidden) continue;
        const val = fieldValues.get(field.id);
        if (val) {
          if (field.inputType) {
            const inputEl = comp.querySelector("input.field__input");
            if (inputEl && !inputEl.value) inputEl.value = val;
          } else {
            selectOption(comp, val);
          }
        }
      }

      const cleanNik = String(nik ?? "").replace(/\D/g, "");
      noticeBanner.hidden = true;

      if (pelayananMode === "system") {
        // ── Mode Sistem: isi form dengan nilai normal acak dari sistem ──
        const normalValues = generateNormalFieldValues(patientState);
        isPrefilling = true;
        for (const field of remoteFields) {
          const val = normalValues[field.id];
          if (!val) continue;
          const comp = fieldMap.get(field.id);
          if (field.inputType) {
            const inputEl = comp.querySelector("input.field__input");
            if (inputEl) {
              inputEl.value = val;
              fieldValues.set(field.id, val);
            }
          } else {
            fieldValues.set(field.id, val);
            selectOption(comp, val);
          }
        }
        isPrefilling = false;
        evaluateVisibility();
        noticeBanner.innerHTML = `✓ Form terisi otomatis dari <strong>Sistem</strong> (Hasil Normal) untuk: <strong>${name || "Pasien"}</strong>`;
        noticeBanner.hidden = false;
        console.log("[Ambil Data] Prefilled from SYSTEM mode (Normal Values) for:", name);
      } else {
        // ── Mode Excel: prefill dari Excel atau Supabase ──
        // 1. Try prefill from uploaded Excel first
        const prefilledFromExcel = await tryPrefillFromExcel(cleanNik, name);

        // 2. If not found in Excel, try prefill from Supabase pendaftaran_records
        if (!prefilledFromExcel && /^\d{16}$/.test(cleanNik)) {
          try {
            const rec = await getPendaftaranRecordByNik(cleanNik);
            if (rec) {
              const mapped = await recordToFieldValues(rec);
              isPrefilling = true;
              for (const field of remoteFields) {
                const val = mapped[field.id];
                if (!val) continue;
                const comp = fieldMap.get(field.id);
                if (field.inputType) {
                  const inputEl = comp.querySelector("input.field__input");
                  if (inputEl && !inputEl.value) {
                    inputEl.value = val;
                    fieldValues.set(field.id, val);
                  }
                } else {
                  fieldValues.set(field.id, val);
                  selectOption(comp, val);
                }
              }
              isPrefilling = false;
              evaluateVisibility();
              console.log("[Ambil Data] prefilled from pendaftaran_records — NIK:", cleanNik);
            }
          } catch (err) {
            isPrefilling = false;
            console.error("[Ambil Data] prefill from pendaftaran_records failed:", err.message);
          }
        }
      }

      fetchedItems = items ?? [];
      if (fetchedItems.length) renderProgressItems(fetchedItems);

      promoPlaceholder.hidden = true;
      btnFetch.hidden = true;
      btnReset.hidden = false;
      btnStart.hidden = false;

      try {
        const [cacheRes] = await chrome.scripting.executeScript({
          target: { tabId },
          world: "MAIN",
          func: () => {
            const data = window.__ckgCache?.detailScreening?.data;
            return data
              ? {
                  attend_date: data.treatment?.attend_date ?? null,
                  domicile: data.domicile ?? null,
                  job: data.job?.text ?? null,
                  born_date: data.patient_detail?.patient_born_date ?? null,
                  mobile_number: data.patient_detail?.patient_mobile_number ?? null
                }
              : null;
          }
        });

        const cachedData = cacheRes?.result;
        if (cachedData?.attend_date) {
          const formattedDate = new Date(cachedData.attend_date).toLocaleDateString("id-ID", {
            day: "numeric",
            month: "short",
            year: "numeric"
          });
          attendDateDisplay.textContent = `Tgl. Hadir: ${formattedDate}`;
          attendDateDisplay.hidden = false;
          patientState.attendDate = cachedData.attend_date;
        }

        if (cachedData?.domicile) patientState.domicile = cachedData.domicile;
        if (cachedData?.job) patientState.job = cachedData.job;
        if (cachedData?.born_date) patientState.bornDate = cachedData.born_date;
        if (cachedData?.mobile_number) patientState.mobileNumber = cachedData.mobile_number;
      } catch (err) {
        console.error("[Ambil Data] attend_date cache read failed:", err.message);
      }

      savePopupState();
    }
  });

  btnFetch.querySelector("button").classList.add("btn--fetch");
  btnRow.appendChild(btnFetch);

  // Reset Button
  const btnReset = ButtonField({
    label: "",
    variant: "danger",
    onClick: async () => {
      await sendToBackground({ type: "STOP" });
      await chrome.storage.session.remove(["popupState", "automationProgress"]);

      nameDisplay.textContent = "";
      nameDisplay.hidden = true;
      categoryDisplay.textContent = "";
      categoryDisplay.removeAttribute("style");
      categoryDisplay.hidden = true;
      genderDisplay.textContent = "";
      attendDateDisplay.textContent = "";
      attendDateDisplay.hidden = true;
      infoRow.hidden = true;
      noticeBanner.hidden = true;

      patientState = {
        jenisKelamin: "",
        kategori: "",
        nik: "",
        tanggalLahir: "",
        nomorTiket: "",
        attendDate: "",
        domicile: null,
        job: null,
        bornDate: null,
        mobileNumber: null
      };

      patientNotice.hidden = true;
      quotaError.hidden = true;

      for (const field of remoteFields) {
        resetFieldValue(field, fieldMap.get(field.id));
        fieldMap.get(field.id).hidden = true;
      }

      progressList.innerHTML = "";
      progressList.hidden = true;
      progressItemsMap.clear();
      fetchedItems = [];

      promoPlaceholder.hidden = false;
      btnFetch.hidden = false;
      btnReset.hidden = true;
      toggleRunningState(false);
      btnStart.hidden = true;
      isPaused = false;

      const pauseBtn = btnPause.querySelector("button");
      pauseBtn.textContent = "Jeda";
      pauseBtn.classList.replace("btn--primary", "btn--secondary");
    }
  });

  const resetBtnEl = btnReset.querySelector("button");
  resetBtnEl.classList.add("btn--reset");
  resetBtnEl.innerHTML = `
    <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-4.5"/>
    </svg>
  `;
  btnReset.hidden = true;
  btnRow.appendChild(btnReset);

  // Start Button
  const btnStart = ButtonField({
    label: "Start",
    variant: "primary",
    onClick: async function () {
      if (!(await checkDeviceOrSignOut())) return;

      const tabId = await getTabId();
      await ensureFetchedItems();

      if (!fetchedItems.length) {
        patientNotice.hidden = false;
        console.warn("[Start Otomasi] No items detected on current page.");
        return;
      }

      quotaError.hidden = true;
      let expiresAt = null;

      try {
        const uData = await getUserData();
        expiresAt = uData?.plan_expires_at ?? null;
      } catch {}

      if (!expiresAt || new Date(expiresAt) <= new Date()) {
        quotaError.textContent = "Langganan atau masa trial kamu sudah habis. Perpanjang langganan dengan mengakses https://ckg.sayureri.com/ untuk terus menggunakan otomasi.";
        return void (quotaError.hidden = false);
      }
      let activeLog = await getActiveLogId("pelayanan");
      if (!activeLog) {
        const hist = await getHistory("pelayanan");
        if (hist.length > 0) {
          await setActiveLogId("pelayanan", hist[0].id);
        } else {
          const newEntry = await addLogEntry("pelayanan", {
            fileName: nameDisplay?.textContent ? `Pasien: ${nameDisplay.textContent}` : "Pelayanan Pasien",
            category: patientState?.kategori || "UMUM",
            total: fetchedItems.length,
            berhasil: 0,
            gagal: 0,
            sebagian: 0,
            data: fetchedItems
          });
          if (newEntry) await setActiveLogId("pelayanan", newEntry.id);
        }
      }
      syncPelayananStatsToLog();
      renderProgressItems(fetchedItems);
      toggleRunningState(true);
      savePopupState();

      await sendToBackground({
        type: "START",
        tabId,
        statusMenikah: fieldValues.get("status-menikah") ?? "",
        items: fetchedItems,
        delay: konfigurasi.getDelay(),
        testMode: konfigurasi.testMode,
        fieldRules: generateFieldRules(),
        fieldValues: Object.fromEntries(fieldValues),
        patientData: {
          nik: patientState.nik ?? "",
          nomorTiket: patientState.nomorTiket ?? "",
          nama: nameDisplay.textContent ?? "",
          jenisKelamin: patientState.jenisKelamin ?? "",
          kategori: patientState.kategori ?? "",
          tanggalLahir: patientState.tanggalLahir ?? "",
          attendDate: patientState.attendDate ?? "",
          domicile: patientState.domicile ?? null,
          job: patientState.job ?? null,
          bornDate: patientState.bornDate ?? null,
          mobileNumber: patientState.mobileNumber ?? null,
          formData: Object.fromEntries(fieldValues)
        }
      });
    }
  });

  const startBtnEl = btnStart.querySelector("button");
  startBtnEl.classList.add("btn--start");
  startBtnEl.innerHTML = `
    <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" style="flex-shrink:0">
      <polygon points="5 3 19 12 5 21 5 3"/>
    </svg>
    <span>Start Otomasi</span>
  `;
  btnStart.hidden = true;
  btnRow.appendChild(btnStart);

  // Pause Button
  const btnPause = ButtonField({
    label: "Pause",
    variant: "secondary",
    onClick: async function () {
      isPaused = !isPaused;
      const pauseBtn = btnPause.querySelector("button");
      if (isPaused) {
        await sendToBackground({ type: "PAUSE" });
        pauseBtn.textContent = "Lanjut";
        pauseBtn.classList.replace("btn--secondary", "btn--primary");
      } else {
        await sendToBackground({ type: "RESUME" });
        pauseBtn.textContent = "Jeda";
        pauseBtn.classList.replace("btn--primary", "btn--secondary");
      }
    }
  });
  btnPause.hidden = true;
  btnRow.appendChild(btnPause);

  // Stop Button
  const btnStop = ButtonField({
    label: "Stop",
    variant: "danger",
    onClick: async function () {
      await sendToBackground({ type: "STOP" });
      toggleRunningState(false);
      isPaused = false;
      const pauseBtn = btnPause.querySelector("button");
      pauseBtn.textContent = "Jeda";
      pauseBtn.classList.replace("btn--primary", "btn--secondary");
    }
  });
  btnStop.hidden = true;
  btnRow.appendChild(btnStop);

  function toggleRunningState(running) {
    btnStart.hidden = running;
    btnPause.hidden = !running;
    btnStop.hidden = !running;
    if (fillBtn) fillBtn.disabled = running;
    chrome.storage.session.set({ otomasiRunning: running }).catch(() => {});
  }

  async function syncPelayananStatsToLog() {
    if (!fetchedItems || !fetchedItems.length) return;
    let berhasil = 0;
    let gagal = 0;
    let sebagian = 0;
    progressItemsMap.forEach(({ badge }) => {
      if (badge.classList.contains("progress-badge--success")) berhasil++;
      else if (badge.classList.contains("progress-badge--error")) gagal++;
      else if (badge.classList.contains("progress-badge--active") || badge.classList.contains("progress-badge--waiting")) sebagian++;
    });
    await updateActiveLog("pelayanan", {
      total: fetchedItems.length,
      berhasil,
      gagal,
      sebagian
    });
  }

  // ── 6. Message Listener & State Restoration ────────────────────
  chrome.runtime.onMessage.addListener(msg => {
    if (msg.type === "PROGRESS") {
      updateProgressBadge(msg.index, msg.status, msg.error);
      syncPelayananStatsToLog();
    }
    if (msg.type === "DONE") {
      toggleRunningState(false);
      syncPelayananStatsToLog();
      if (patientState?.nik) {
        updateQueueStatusToCkgbankot({
          nik: patientState.nik,
          jenis: (patientState.kategori?.toUpperCase().includes("SEKOLAH") ? "SEKOLAH" : "UMUM"),
          status_pelayanan: "Selesai Pelayanan",
          keterangan: "Pelayanan Selesai via Bot ENCO"
        }).catch(e => console.warn("[Pelayanan] updateQueueStatusToCkgbankot error:", e));
      }
    }
  });

  return {
    getFieldRules: generateFieldRules,
    restoreState: async function (state, bgState) {
      if (state?.fetched) {
        nameDisplay.textContent = state.name ?? "";
        nameDisplay.hidden = !state.name;

        categoryDisplay.textContent = state.kategori ?? "";
        if (state.kategoriStyle) {
          categoryDisplay.style.color = state.kategoriStyle.color;
          categoryDisplay.style.backgroundColor = state.kategoriStyle.backgroundColor;
          categoryDisplay.style.borderColor = state.kategoriStyle.borderColor;
        }
        categoryDisplay.hidden = false;

        genderDisplay.textContent = state.jenisKelamin ?? "";
        infoRow.hidden = false;

        patientState = {
          jenisKelamin: state.jenisKelamin ?? "",
          kategori: state.kategori ?? "",
          nik: state.nik ?? "",
          tanggalLahir: state.tanggalLahir ?? "",
          nomorTiket: state.nomorTiket ?? "",
          attendDate: state.attendDate ?? "",
          domicile: state.domicile ?? null,
          job: state.job ?? null,
          bornDate: state.bornDate ?? null,
          mobileNumber: state.mobileNumber ?? null
        };

        if (state.attendDate) {
          const formattedDate = new Date(state.attendDate).toLocaleDateString("id-ID", {
            day: "numeric",
            month: "short",
            year: "numeric"
          });
          attendDateDisplay.textContent = `Tgl. Hadir: ${formattedDate}`;
          attendDateDisplay.hidden = false;
        }

        const savedFields = state.fields ?? {};
        const legacyFields = {
          "status-menikah": state.statusMenikah,
          "rencana-menikah": state.rencanaMemikah,
          hamil: state.hamil,
          "hubungan-intim": state.hubunganIntim,
          merokok: state.merokok,
          "pernah-merokok": state.pernahMerokok
        };

        isPrefilling = true;
        for (const field of remoteFields) {
          const val = savedFields[field.id] ?? legacyFields[field.id] ?? field.default ?? "";
          fieldValues.set(field.id, val);
          if (val) {
            const comp = fieldMap.get(field.id);
            if (field.inputType) {
              const inputEl = comp.querySelector("input.field__input");
              if (inputEl) inputEl.value = val;
            } else {
              selectOption(comp, val);
            }
          }
        }
        isPrefilling = false;

        for (const field of remoteFields) {
          if (!field.showWhen) fieldMap.get(field.id).hidden = false;
        }
        evaluateVisibility();

        fetchedItems = state.fetchedItems ?? [];
        promoPlaceholder.hidden = true;
        btnFetch.hidden = true;
        btnStart.hidden = false;
        btnReset.hidden = false;

        if (fetchedItems.length) renderProgressItems(fetchedItems);
      }

      if (bgState?.progress?.length) {
        renderProgressItems(bgState.progress);
        bgState.progress.forEach(({ status, error }, idx) => {
          if (status !== "waiting") updateProgressBadge(idx, status, error);
        });

        if (bgState.running) {
          toggleRunningState(true);
          if (bgState.paused) {
            isPaused = true;
            const pauseBtn = btnPause.querySelector("button");
            pauseBtn.textContent = "Lanjut";
            pauseBtn.classList.replace("btn--secondary", "btn--primary");
          }
        }
      }

      if (!pelayananMode) {
        refreshPelayananSessionPicker();
      }
    },
    setRunningState: toggleRunningState,
    getStatusMenikah: () => fieldValues.get("status-menikah") ?? "",
    getMode: () => pelayananMode,
    resetMode: () => setPelayananMode(null),
    triggerFetchData: async () => {
      const fetchBtnEl = btnFetch.querySelector("button");
      if (fetchBtnEl && !fetchBtnEl.hidden) fetchBtnEl.click();
    },
    resumeFromLog: resumeFromLogEntry,
    createNewSession: async function (customName) {
      if (!fetchedItems || !fetchedItems.length) {
        alert("Belum ada data pemeriksaan pasien. Silakan klik Ambil Data terlebih dahulu pada halaman pasien.");
        return false;
      }

      const historyList = await getHistory("pelayanan");
      const activeId = await getActiveLogId("pelayanan");
      const currentActiveEntry = historyList.find(item => item.id === activeId) || historyList[0];
      const baseName = currentActiveEntry?.fileName || (nameDisplay?.textContent ? `Pasien: ${nameDisplay.textContent}` : "Pelayanan Pasien");
      const sessionName = customName || `${baseName} (Sesi)`;

      progressItemsMap.forEach(({ badge }) => {
        badge.className = "progress-badge progress-badge--waiting";
        badge.textContent = "Menunggu";
      });

      const newEntry = await addLogEntry("pelayanan", {
        fileName: sessionName,
        category: patientState?.kategori || "UMUM",
        total: fetchedItems.length,
        berhasil: 0,
        gagal: 0,
        sebagian: 0,
        status: "idle",
        data: fetchedItems
      });

      if (newEntry) {
        await setActiveLogId("pelayanan", newEntry.id);
      }
      return true;
    },
    endActiveSession: async function () {
      await setActiveLogId("pelayanan", "none");
      excelPatients = [];
      await chrome.storage.session.remove(["pelayananExcelPatients", "otomasiRunning"]);
      updateExcelStatusUI();
      return true;
    }
  };
}