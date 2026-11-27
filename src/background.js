// Storage polyfill for Titanium Browser / Kiwi / older Chromium
try {
  if (typeof chrome !== "undefined" && chrome.storage && !chrome.storage.session) {
    chrome.storage.session = chrome.storage.local;
  }
  // Izinkan storage session diakses dari semua konteks ekstensi (popup, sidepanel, content script)
  if (typeof chrome !== "undefined" && chrome.storage?.session?.setAccessLevel) {
    chrome.storage.session.setAccessLevel({ accessLevel: "TRUSTED_AND_UNTRUSTED_CONTEXTS" }).catch(() => {});
  }
} catch (e) {
  console.warn("[ENCO Background] Storage session polyfill failed:", e);
}

// Native Chrome Side Panel: otomatis buka panel samping saat ikon ekstensi diklik
try {
  if (typeof chrome !== "undefined" && chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch((err) => {
      console.warn("[ENCO Background] setPanelBehavior warning:", err);
    });
  }
} catch (e) {
  console.warn("[ENCO Background] sidePanel init warning:", e);
}

import { Automation as e } from "./automation.js";
import { PendaftaranAutomation as t } from "./pendaftaranAutomation.js";
import { getCkgUser, runPendaftaranApi } from "./pendaftaranApi.js";
import { runPelayananApi, fetchPendingPatientsApi } from "./pelayananApi.js";
import { runFlow as a } from "./pelayananInstanAutomation.js";
import { runUncheckAll as n } from "./uncheckUtils.js";
import { setChromeProxy } from "./tabs/vpnProxy.js";
import {
  recordToFieldRules as o,
  recordToFieldValues as r,
  waitForFormToAppear as s,
  getDynamicDemographicRules as getDemoRules
} from "./pelayananFormHelper.js";
import {
  openPatientInTable,
  confirmMulaiPemeriksaanIfPresent,
  extractDetailPatientState,
  returnToPelayananTable
} from "./services/pelayananScanner.js";
import {
  signInWithGoogle as c,
  signOut as i,
  verifyDevice as l,
  insertAutomationRecord as d,
  insertPendaftaranRecord as u,
  ensurePendaftaranRecord as g
} from "./auth.js";
import { warmRemoteConfigCache as m } from "./remoteConfig.js";
import {
  updateQueueStatusToCkgbankot,
  syncPatientToCkgbankot,
  flushPendingPatientSync,
  syncLogToCkgbankot
} from "./services/encoSyncService.js";
import {
  getSession as p,
  authedFetch as A,
  updatePendaftaranRecordStatus as h,
  getPendaftaranRecordByNik as f,
  updateUserCkgDetails as k
} from "./supabase.js";
import { updateActiveLog } from "./services/historyService.js";
import {
  pingCkgSession,
  setupHeartbeatAlarm,
  stopHeartbeatAlarm,
  CKG_HEARTBEAT_ALARM
} from "./services/sessionHeartbeatService.js";

m().catch(() => {});
setupHeartbeatAlarm().catch(() => {});
let N = null, w = null;
const S = {}, y = {};
let P = 0, I = false;

async function T() {
  return true;
}

let isPendaftaranProcessing = false;

// ── Pendaftaran Queue Runner ────────────────────────────────────────────────
async function _() {
  if (isPendaftaranProcessing) return;

  const { pendaftaranQueue: a } = await chrome.storage.session.get("pendaftaranQueue");
  if (!a?.patients?.length) {
    isPendaftaranProcessing = false;
    await chrome.storage.session.set({ pendaftaranRunning: false });
    return void chrome.runtime.sendMessage({ type: "PENDAFTARAN_QUEUE_DONE" }).catch(() => {});
  }

  isPendaftaranProcessing = true;
  await chrome.storage.session.set({ pendaftaranRunning: true });

  const { tabId: n, patients: o, delayMultiplier: r, skipKonfirmasiHadir: skipHadir } = a;
  const rawItem = o[0];
  const c = typeof rawItem === "object" && rawItem !== null ? (rawItem.patientIndex ?? 0) : rawItem;

  const i = `pendaftaranStop_${c}`;
  const stopFlag = (await chrome.storage.session.get(i))[i];
  if (stopFlag) {
    await chrome.storage.session.remove(i).catch(() => {});
    const remaining = o.slice(1);
    await chrome.storage.session.set({
      pendaftaranQueue: { tabId: n, patients: remaining, delayMultiplier: r, skipKonfirmasiHadir: skipHadir },
      pendaftaranRunning: remaining.length > 0
    });
    isPendaftaranProcessing = false;
    return void await _();
  }

  const { pendaftaranPatients: l } = await chrome.storage.session.get("pendaftaranPatients");
  const s = l?.[c] || (typeof rawItem === "object" ? rawItem.patient : null) || {};
  if (!s.category) {
    s.category = rawItem?.patient?.category || a?.category || "UMUM";
  }

  if (void 0 !== l?.[c]) {
    l[c]._status = "in-progress";
    await chrome.storage.session.set({ pendaftaranPatients: l });
  }
  chrome.runtime.sendMessage({ type: "PENDAFTARAN_STATUS", patientIndex: c, status: "in-progress" }).catch(() => {});

  const d = async (status, nomorTiket = null, errorMsg = null, extraData = {}) => {
    delete S[c];
    await chrome.storage.session.remove(i).catch(() => {});
    const finalStatus = "stopped" === status ? "idle" : status;
    const { pendaftaranPatients: currentPatients } = await chrome.storage.session.get("pendaftaranPatients");
    if (void 0 !== currentPatients?.[c]) {
      currentPatients[c]._status = finalStatus;
      if (nomorTiket) currentPatients[c]._nomorTiket = nomorTiket;
      if (errorMsg) currentPatients[c]._errorMsg = errorMsg;
      if (extraData?.screeningDate) currentPatients[c]._screeningDate = extraData.screeningDate;
      if (extraData?.screeningFaskes && !/whatsapp|notifikasi/i.test(extraData.screeningFaskes)) {
        currentPatients[c]._screeningFaskes = extraData.screeningFaskes;
      }
      if (extraData?.screeningLayanan && !/selesai\s*diperiksa|menerima\s*layanan/i.test(extraData.screeningLayanan)) {
        currentPatients[c]._screeningLayanan = extraData.screeningLayanan;
      }
      if (extraData?.screeningDetail) currentPatients[c]._screeningDetail = extraData.screeningDetail;

      if (!currentPatients[c]._screeningDate && errorMsg) {
        const tm = errorMsg.match(/(?:tanggal(?:\s*pemeriksaan|\s*skrining|\s*layanan)?|tgl|date|pada)\s*[:\-]?\s*([0-9]{1,2}\s+[A-Za-z]+\s+[0-9]{4}|[0-9]{1,4}[\/\-][0-9]{1,2}[\/\-][0-9]{1,4})/i);
        if (tm) currentPatients[c]._screeningDate = tm[1].trim();
      }
      if ((!currentPatients[c]._screeningFaskes || /whatsapp|notifikasi/i.test(currentPatients[c]._screeningFaskes)) && errorMsg) {
        const fm = errorMsg.match(/puskesmas\s*pemeriksa\s*[:\-]\s*([^\r\n,\)\.]+)/i) ||
                   errorMsg.match(/(?:puskesmas|faskes|fasilitas\s*kesehatan|klinik)\s*pemeriksa\s*[:\-]\s*([^\r\n,\)\.]+)/i) ||
                   errorMsg.match(/puskesmas\s*[:\-]\s*([^\r\n,\)\.]+)/i);
        if (fm && !/whatsapp|notifikasi|rapor|ssm/i.test(fm[1].trim())) {
          currentPatients[c]._screeningFaskes = fm[1].trim();
        }
      }
      if ((!currentPatients[c]._screeningLayanan || /selesai\s*diperiksa|menerima\s*layanan/i.test(currentPatients[c]._screeningLayanan)) && errorMsg) {
        const lm = errorMsg.match(/(?:^|[\r\n\(])\s*layanan\s*[:\-]\s*([^\r\n,\)\.]+)/i);
        if (lm && !/menerima|selesai|diperiksa/i.test(lm[1].trim())) {
          currentPatients[c]._screeningLayanan = lm[1].trim();
        }
      }
      await chrome.storage.session.set({ pendaftaranPatients: currentPatients });

      // Sinkronisasi otomatis ke log history pendaftaran
      const berhasil = currentPatients.filter(p => p._status === "done").length;
      const gagal = currentPatients.filter(p => p._status === "error" || p._status === "invalid-nik").length;
      const sebagian = currentPatients.filter(p => p._status === "partial").length;
      const pernahInput = currentPatients.filter(p => p._status === "already-screened").length;
      updateActiveLog("pendaftaran", {
        total: currentPatients.length,
        berhasil,
        gagal,
        sebagian,
        pernahInput,
        data: currentPatients
      }).catch(err => console.error("[Pendaftaran BG] updateActiveLog error:", err));
    }
    chrome.runtime.sendMessage({ type: "PENDAFTARAN_STATUS", patientIndex: c, status: finalStatus, nomorTiket, errorMsg, ...extraData }).catch(() => {});
    if ("done" === status) {
      try {
        const patientData = currentPatients?.[c] || s;
        await u(patientData, nomorTiket);
      } catch (e) {
        console.error("[Pendaftaran BG] insertPendaftaranRecord threw:", e);
      }
    }
    const { pendaftaranQueue: q } = await chrome.storage.session.get("pendaftaranQueue");
    const remaining = (q?.patients ?? o).slice(1);
    await chrome.storage.session.set({
      pendaftaranQueue: { tabId: q?.tabId ?? n, patients: remaining, delayMultiplier: q?.delayMultiplier ?? r, skipKonfirmasiHadir: q?.skipKonfirmasiHadir ?? skipHadir },
      pendaftaranRunning: remaining.length > 0
    });
    isPendaftaranProcessing = false;
    _().catch(e => console.error("[Pendaftaran BG] runNextInQueue error:", e));
  };

  const g = new t({ tabId: n, patient: s, patientIndex: c, delayMultiplier: r, category: s.category ?? "UMUM", onStatus: d, skipKonfirmasiHadir: skipHadir });
  S[c] = g;
  g.run().catch(async e => {
    console.error("[Pendaftaran BG] queue error:", e);
    await d("error", null, e?.message || "Terjadi kesalahan");
  });
}

// ── Pelayanan (Menu Pasien) Concurrent Queue Dispatcher ──────────────────────
let activePelayananWorkers = 0;
let isDispatchingPelayanan = false;
let pelayananStorageLock = Promise.resolve();

async function updatePelayananInstanRecord(nik, updater) {
  pelayananStorageLock = pelayananStorageLock.then(async () => {
    try {
      const { "pelayanan-instan-records": curRecs = [] } = await chrome.storage.session.get("pelayanan-instan-records");
      const curIdx = curRecs.findIndex(r => r.nik === nik || r.nomorTiket === nik || r.id === nik || r.nama === nik);
      if (curIdx !== -1) {
        updater(curRecs[curIdx]);
        await chrome.storage.session.set({ "pelayanan-instan-records": curRecs });

        // Sinkronisasi otomatis ke log history pasien secara realtime
        const berhasil = curRecs.filter(r => (r.status === "DONE_PELAYANAN" || (r._status === "done" && r.status !== "DONE_PENDAFTARAN")) && r._status !== "already-screened" && r.status !== "ALREADY_SCREENED").length;
        const sebagian = curRecs.filter(r => r.status === "PARTIAL_DONE_PELAYANAN" || r._status === "partial").length;
        const gagal = curRecs.filter(r => r._status === "error" || r.status === "MISSING" || r.status === "SERVER_ERROR" || r.status === "ERROR").length;
        const pernahInput = curRecs.filter(r => r._status === "already-screened" || r.status === "ALREADY_SCREENED").length;
        updateActiveLog("pasien", {
          total: curRecs.length,
          berhasil,
          gagal,
          sebagian,
          pernahInput,
          data: curRecs
        }).catch(err => console.error("[background] updateActiveLog error:", err));
      }
    } catch (e) {
      console.error("[updatePelayananInstanRecord] error:", e);
    }
  });
  return pelayananStorageLock;
}

async function addPelayananPendingStatus(item) {
  pelayananStorageLock = pelayananStorageLock.then(async () => {
    try {
      const { pelayananInstanPendingStatuses: ep = [] } = await chrome.storage.session.get("pelayananInstanPendingStatuses");
      ep.push(item);
      await chrome.storage.session.set({ pelayananInstanPendingStatuses: ep });
    } catch (e) {
      console.error("[addPelayananPendingStatus] error:", e);
    }
  });
  return pelayananStorageLock;
}

async function dispatchPelayananQueue() {
  if (isDispatchingPelayanan) return;
  isDispatchingPelayanan = true;

  try {
    const {
      pelayananQueue: queue = [],
      pelayananConcurrentLimit: limit = 3,
      pelayananPaused = false
    } = await chrome.storage.session.get(["pelayananQueue", "pelayananConcurrentLimit", "pelayananPaused"]);

    if (pelayananPaused) {
      return;
    }

    const maxConcurrent = Math.max(1, Math.min(20, parseInt(limit, 10) || 3));

    // Safety check: jika activePelayananWorkers desync dari controller aktif di y, reset ke controller aktual
    const activeControllersCount = Object.keys(y).length;
    if (activePelayananWorkers > activeControllersCount) {
      console.log(`[dispatchPelayananQueue] Sync activePelayananWorkers from ${activePelayananWorkers} to active controllers count: ${activeControllersCount}`);
      activePelayananWorkers = activeControllersCount;
    }

    if ((!queue || !queue.length) && activePelayananWorkers === 0) {
      await chrome.storage.session.set({ pelayananRunning: false, pelayananPaused: false });
      chrome.runtime.sendMessage({ type: "PELAYANAN_QUEUE_DONE" }).catch(() => {});
      return;
    }

    while (activePelayananWorkers < maxConcurrent && queue.length > 0) {
      const job = queue.shift();
      const stopKey = `pelayananStop_${job.nik}`;
      const stopFlag = (await chrome.storage.session.get(stopKey))[stopKey];
      if (stopFlag) {
        await chrome.storage.session.remove(stopKey);
        await chrome.storage.session.set({ pelayananQueue: queue });
        continue;
      }

      await chrome.storage.session.set({
        pelayananQueue: queue,
        pelayananRunning: true
      });

      activePelayananWorkers++;

      (async (curJob) => {
        chrome.runtime.sendMessage({
          type: "PELAYANAN_INSTAN_STATUS",
          nik: curJob.nik,
          automationStatus: "in-progress"
        }).catch(() => {});

        await updatePelayananInstanRecord(curJob.nik, rec => {
          rec._status = "in-progress";
        });

        try {
          await D({
            type: "RUN_PELAYANAN_AUTOMATION",
            recordIndex: curJob.recordIndex,
            nik: curJob.nik,
            tanggalData: curJob.tanggalData,
            isExcel: curJob.isExcel,
            patientRecord: curJob.patientRecord
          });
        } catch (err) {
          console.error(`[dispatchPelayananQueue] Job failed for NIK ${curJob.nik}:`, err);
        } finally {
          activePelayananWorkers = Math.max(0, activePelayananWorkers - 1);
          await new Promise(r => setTimeout(r, 600));
          dispatchPelayananQueue().catch(err => {
            console.error("[dispatchPelayananQueue] Error on worker finish dispatch:", err);
          });
        }
      })(job);

      if (activePelayananWorkers < maxConcurrent && queue.length > 0) {
        await new Promise(r => setTimeout(r, 1200));
      }
    }
  } finally {
    isDispatchingPelayanan = false;
  }
}

// ── ASIK Live Queue Dispatcher ───────────────────────────────────────────────
let asikLiveQueue = [];
let asikLiveRunning = false;
let asikLivePaused = false;
let asikLiveAbortCtrl = null;
let activeAsikWorkers = 0;
let isDispatchingAsikLive = false;

async function processSingleAsikLiveJob(tabId, curJob, { allowDomFallback = true, interFormDelayMs = 400 } = {}) {
  const patient = curJob.patientRecord;
  const pIdentifier = patient.nomorTiket || patient.nik || patient.nama;

  chrome.runtime.sendMessage({
    type: "PELAYANAN_INSTAN_STATUS",
    nik: pIdentifier,
    automationStatus: "in-progress"
  }).catch(() => {});

  await updatePelayananInstanRecord(pIdentifier, rec => {
    rec._status = "in-progress";
  });

  try {
    const { ckg_ranges: nr, ckg_config: cr } = await chrome.storage.local.get(["ckg_ranges", "ckg_config"]);
    const sRanges = nr ?? {};
    const iDelay = Math.round(1e3 * (cr?.delay ?? 1.2));

    const apiPatientData = {
      nama: patient.nama,
      nik: patient.nik || patient.nomorTiket,
      nomorTiket: patient.nomorTiket,
      reg_id: patient.reg_id || null,
      tanggal_lahir: patient.tanggalLahir || patient.tanggal_lahir || "",
      kategori: patient.isSchool ? "anak" : "dewasa",
      jenisKelamin: patient.jenisKelamin || "perempuan",
      jenis_kelamin: patient.jenisKelamin || "perempuan",
      status_pernikahan: "menikah",
      attendDate: patient.attendDate || null
    };

    const apiRules = await o(apiPatientData, sRanges);
    let isSuccess = false;
    let usedApi = false;
    let resolvedNik = patient.nik || "";
    let lastApiError = "";

    // Jalur Utama: 100% API (tanpa DOM/klik browser)
    try {
      const ckgUser = await getCkgUser(tabId);
      console.log(`[asikLive] Menjalankan Pelayanan API untuk ${patient.nama} (tiket: ${patient.nomorTiket}, regId: ${patient.reg_id || "-"})`);
      const apiRes = await runPelayananApi(tabId, apiPatientData, {
        ckgUser,
        regId: patient.reg_id || null,
        ticketNumber: patient.nomorTiket,
        isSchool: !!patient.isSchool,
        screeningDate: patient.attendDate || null,
        dryRun: false,
        fieldRules: apiRules,
        interFormDelayMs,
        onProgress: (idx, total, title) => {
          const pct = total > 0 ? Math.round(((idx + 1) / total) * 100) : 0;
          chrome.runtime.sendMessage({
            type: "PELAYANAN_INSTAN_STATUS",
            nik: pIdentifier,
            automationStatus: "in-progress",
            formIndex: idx + 1,
            formTotal: total,
            formName: title || "",
            percent: pct,
            text: `Form ${idx + 1}/${total} (${pct}%): ${title || ""}`
          }).catch(() => {});
        }
      });
      if (apiRes?.status === "done") {
        isSuccess = true;
        usedApi = true;
      } else {
        const failedNames = (apiRes?.failedForms || []).map(f => `${f.name}: ${f.error}`).join("; ");
        lastApiError = failedNames || `API belum penuh (${apiRes?.status})`;
        console.warn(`[asikLive] Pelayanan API belum penuh (${apiRes?.status}):`, apiRes?.failedForms);
      }
    } catch (apiErr) {
      lastApiError = apiErr?.message || String(apiErr);
      console.warn(`[asikLive] Pelayanan API gagal:`, lastApiError);
    }

    // Jika paralel (>1), jangan sentuh DOM agar tab tidak tabrakan
    if (!isSuccess && !allowDomFallback) {
      throw new Error(lastApiError || "Pelayanan API gagal (mode paralel tanpa DOM)");
    }

    // Jalur Fallback DOM hanya jika concurrent === 1
    if (!isSuccess) {
      console.log(`[asikLive] Membuka baris pasien (DOM fallback): ${patient.nama} (${patient.nomorTiket})`);
      await openPatientInTable(tabId, patient);

      console.log(`[asikLive] Konfirmasi tanggal pemeriksaan jika muncul...`);
      await confirmMulaiPemeriksaanIfPresent(tabId);

      const pDetail = await extractDetailPatientState(tabId).catch(() => null);
      if (pDetail?.nik) resolvedNik = pDetail.nik;

      const patientData = {
        nama: patient.nama,
        nik: pDetail?.nik || patient.nomorTiket,
        nomorTiket: pDetail?.nomorTiket || patient.nomorTiket,
        kategori: pDetail?.kategori || (patient.isSchool ? "anak" : "dewasa"),
        jenisKelamin: pDetail?.jenisKelamin || patient.jenisKelamin || "perempuan",
        status_pernikahan: "menikah",
        attendDate: pDetail?.attendDate || null
      };

      const lRules = await o(patientData, sRanges);

      const uAuto = new e({
        tabId,
        statusMenikah: "menikah",
        delay: iDelay,
        testMode: cr?.testMode ?? false,
        fieldRules: lRules,
        items: null,
        attendDate: patientData.attendDate,
        patientData,
        onProgress: (idx, status, title) => {
          chrome.runtime.sendMessage({
            type: "PELAYANAN_INSTAN_STATUS",
            nik: pIdentifier,
            text: `${title}: ${status}`
          }).catch(() => {});
        },
        onDone: () => {
          console.log(`[asikLive] Kuesioner skrining selesai diisi untuk ${patient.nama}`);
        }
      });

      await uAuto.run();
      if (!uAuto._stopped && !uAuto.pelayananFinished) {
        await uAuto.run();
      }
      if (!uAuto._stopped && !uAuto.pelayananFinished) {
        console.log(`[asikLive] Menyelesaikan layanan...`);
        const finRes = await uAuto.finishPelayanan().catch(e => ({ success: false, error: e.message }));
        if (finRes?.success) uAuto.pelayananFinished = true;
      }

      if (uAuto.pelayananFinished) {
        isSuccess = true;
      } else {
        const verifyRes = await uAuto.verifyAllDone().catch(() => null);
        if (verifyRes?.allDone && (!uAuto.failedItems || uAuto.failedItems.length === 0)) {
          isSuccess = true;
        }
      }

      if (!isSuccess) {
        throw new Error("Layanan belum terselesaikan penuh di web ASIK");
      }
    }

    await updatePelayananInstanRecord(pIdentifier, rec => {
      rec._status = "done";
      rec.status = "DONE_PELAYANAN";
      if (resolvedNik) rec.nik = resolvedNik;
    });

    await addPelayananPendingStatus({
      nik: pIdentifier,
      automationStatus: "done",
      recordStatus: "DONE_PELAYANAN"
    });

    // Fitur "Periksa Langsung dari Web ASIK" (ASIK_LIVE) tidak merekam / mengirim data ke ckgbankot

    chrome.runtime.sendMessage({
      type: "PELAYANAN_INSTAN_STATUS",
      nik: pIdentifier,
      automationStatus: "done",
      recordStatus: "DONE_PELAYANAN",
      text: `✓ Selesai: ${patient.nama}`
    }).catch(() => {});

    if (!usedApi && allowDomFallback) {
      console.log(`[asikLive] Kembali ke tabel pasien...`);
      await returnToPelayananTable(tabId);
      await new Promise(r => setTimeout(r, 1200));
    } else {
      await new Promise(r => setTimeout(r, 500));
    }
  } catch (err) {
    console.error(`[asikLive] Gagal memproses ${patient.nama}:`, err);

    await updatePelayananInstanRecord(pIdentifier, rec => {
      rec._status = "error";
      rec.status = "error";
      rec._errorMsg = err.message;
    });

    await addPelayananPendingStatus({
      nik: pIdentifier,
      automationStatus: "error",
      recordStatus: "error"
    });

    chrome.runtime.sendMessage({
      type: "PELAYANAN_INSTAN_STATUS",
      nik: pIdentifier,
      automationStatus: "error",
      recordStatus: "error",
      text: `Error: ${err.message}`
    }).catch(() => {});

    if (allowDomFallback) {
      try {
        await returnToPelayananTable(tabId);
        await new Promise(r => setTimeout(r, 1200));
      } catch (_) {}
    }
  }
}

async function dispatchAsikLiveQueue() {
  if (!asikLiveRunning || isDispatchingAsikLive) return;
  isDispatchingAsikLive = true;

  try {
    const tabs = await chrome.tabs.query({ url: "*://sehatindonesiaku.kemkes.go.id/*" });
    let asikTab = tabs.find(t => t.url && t.url.includes("ckg-pelayanan"));
    if (!asikTab && tabs.length > 0) asikTab = tabs[0];

    if (!asikTab) {
      chrome.runtime.sendMessage({
        type: "PELAYANAN_INSTAN_STATUS",
        text: "Tab web ASIK ckg-pelayanan tidak ditemukan!"
      }).catch(() => {});
      asikLiveRunning = false;
      await chrome.storage.session.set({ pelayananRunning: false, asikLiveRunning: false });
      return;
    }

    if (asikTab.url && !asikTab.url.includes("ckg-pelayanan")) {
      await chrome.tabs.update(asikTab.id, { url: "https://sehatindonesiaku.kemkes.go.id/ckg-pelayanan" });
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
    }

    const tabId = asikTab.id;
    const {
      pelayananConcurrentLimit: rawLimit = 1,
      pelayananPaused = false
    } = await chrome.storage.session.get(["pelayananConcurrentLimit", "pelayananPaused"]);

    if (pelayananPaused || asikLivePaused) return;
    if (asikLiveAbortCtrl?.signal?.aborted) {
      asikLiveQueue = [];
    }

    const maxConcurrent = Math.max(1, Math.min(5, Number(rawLimit) || 1));
    const allowDomFallback = maxConcurrent === 1;
    const interFormDelayMs = maxConcurrent > 1 ? 650 : 400;

    if (asikLiveQueue.length === 0 && activeAsikWorkers === 0) {
      asikLiveRunning = false;
      await chrome.storage.session.set({
        pelayananRunning: false,
        pelayananPaused: false,
        asikLiveRunning: false
      });
      chrome.runtime.sendMessage({ type: "PELAYANAN_QUEUE_DONE" }).catch(() => {});
      return;
    }

    while (activeAsikWorkers < maxConcurrent && asikLiveQueue.length > 0 && asikLiveRunning) {
      if (asikLiveAbortCtrl?.signal?.aborted) break;

      const curJob = asikLiveQueue.shift();
      activeAsikWorkers++;

      (async (job) => {
        try {
          await processSingleAsikLiveJob(tabId, job, { allowDomFallback, interFormDelayMs });
        } finally {
          activeAsikWorkers = Math.max(0, activeAsikWorkers - 1);
          if (asikLiveQueue.length === 0 && activeAsikWorkers === 0) {
            asikLiveRunning = false;
            await chrome.storage.session.set({
              pelayananRunning: false,
              pelayananPaused: false,
              asikLiveRunning: false
            });
            chrome.runtime.sendMessage({ type: "PELAYANAN_QUEUE_DONE" }).catch(() => {});
          } else if (asikLiveRunning) {
            dispatchAsikLiveQueue().catch(e => console.error("[dispatchAsikLiveQueue] next error:", e));
          }
        }
      })(curJob);

      // Stagger start 600ms antar worker paralel agar tidak burst ke server Kemkes
      if (activeAsikWorkers < maxConcurrent && asikLiveQueue.length > 0) {
        await new Promise(r => setTimeout(r, 600));
      }
    }
  } finally {
    isDispatchingAsikLive = false;
  }
}

// ── One-Stop CKG: Daftar & Layani Dispatcher ──────────────────────────────
let daftarLayaniQueue = [];
let daftarLayaniRunning = false;
let daftarLayaniAbortCtrl = null;
let daftarLayaniStateLock = Promise.resolve();

function persistDaftarLayaniPatientState(pIndex, patch) {
  if (typeof pIndex !== "number") return Promise.resolve();
  daftarLayaniStateLock = daftarLayaniStateLock.then(async () => {
    try {
      const res = await chrome.storage.local.get("enco_daftar_layani_state");
      const state = res?.enco_daftar_layani_state;
      if (state && Array.isArray(state.patients) && state.patients[pIndex]) {
        state.patients[pIndex] = { ...state.patients[pIndex], ...patch };
        await chrome.storage.local.set({ enco_daftar_layani_state: state });
      }
    } catch (_) {}
  });
  return daftarLayaniStateLock;
}

async function dispatchDaftarLayaniQueue(options = {}) {
  if (!daftarLayaniRunning) return;

  const tabs = await chrome.tabs.query({ url: "*://sehatindonesiaku.kemkes.go.id/*" });
  let asikTab = tabs.find(t => t.url && t.url.includes("ckg-pelayanan")) || tabs[0];

  if (!asikTab) {
    const formTabs = await chrome.tabs.query({ url: "*://form.kemkes.go.id/*" });
    if (formTabs.length > 0) {
      const targetReturn = options.category === "SEKOLAH"
        ? "https://sehatindonesiaku.kemkes.go.id/ckg-pelayanan-sekolah"
        : "https://sehatindonesiaku.kemkes.go.id/ckg-pelayanan";
      await chrome.tabs.update(formTabs[0].id, { url: targetReturn });
      await new Promise(resolve => {
        const listener = (tid, info) => {
          if (tid === formTabs[0].id && info.status === "complete") {
            chrome.tabs.onUpdated.removeListener(listener);
            resolve();
          }
        };
        chrome.tabs.onUpdated.addListener(listener);
        setTimeout(() => { chrome.tabs.onUpdated.removeListener(listener); resolve(); }, 12000);
      });
      await new Promise(r => setTimeout(r, 1200));
      asikTab = await chrome.tabs.get(formTabs[0].id).catch(() => null);
    }
  }

  if (!asikTab) {
    chrome.runtime.sendMessage({
      type: "DAFTAR_LAYANI_PROGRESS",
      index: 0,
      stage: "daftar",
      status: "error",
      message: "Tab web ASIK tidak ditemukan! Buka web ASIK terlebih dahulu.",
      isFinished: true
    }).catch(() => {});
    daftarLayaniRunning = false;
    await chrome.storage.session.set({ daftarLayaniRunning: false });
    return;
  }

  const tabId = asikTab.id;
  daftarLayaniAbortCtrl = new AbortController();

  let ckgUser = null;
  try {
    ckgUser = await getCkgUser(tabId);
  } catch (err) {
    console.error("[daftarLayani] Gagal getCkgUser:", err);
    chrome.runtime.sendMessage({
      type: "DAFTAR_LAYANI_PROGRESS",
      index: 0,
      stage: "daftar",
      status: "error",
      message: "Gagal membaca sesi web ASIK: " + err.message,
      isFinished: true
    }).catch(() => {});
    daftarLayaniRunning = false;
    await chrome.storage.session.set({ daftarLayaniRunning: false });
    return;
  }

  const isSchool = options.category === "SEKOLAH";
  const categoryLabel = isSchool ? "SEKOLAH" : "UMUM";
  const targetPelayananUrl = isSchool
    ? "https://sehatindonesiaku.kemkes.go.id/ckg-pelayanan-sekolah"
    : "https://sehatindonesiaku.kemkes.go.id/ckg-pelayanan";
  const todayIso = new Date().toISOString().split("T")[0];
  const stats = {
    total: daftarLayaniQueue.length,
    done: 0,
    already: 0,
    error: 0
  };
  const syncEnabled = !options.dryRun;
  const buildSyncBase = (p, extra = {}) => ({
    nik: p.nik,
    nama: p.nama || p.name || "",
    tanggal_lahir: p.tanggal_lahir || p.tanggallahir || p.dob || p.tgllahir || "",
    jenis_kelamin: p.jenis_kelamin || p.jeniskelamin || p.jk || p.gender || "",
    status_pernikahan: p.status_pernikahan || p.statuspernikahan || p.statusnikah || p.nikah || "",
    pekerjaan: p.pekerjaan || p.job || "",
    provinsi: p.provinsi || p.province || "Jawa Barat",
    kab_kota: p.kabkota || p.kab_kota || p.kota || p.kabupaten || "Kab. Bandung",
    kecamatan: p.kecamatan || p.district || "Banjaran",
    kelurahan: p.kelurahan || p.desa || p.subdistrict || "",
    alamat: p.alamat || p.detailalamat || p.detaildomisili || p.address || "",
    kategori: categoryLabel,
    tanggal_daftar: options.screeningDate || p.screening_date || todayIso,
    raw_details: p,
    ...extra
  });

  const maxConcurrent = Math.max(1, Math.min(5, Number(options.concurrentLimit) || 1));
  const allowDomFallback = maxConcurrent === 1;
  const interFormDelayMs = maxConcurrent > 1 ? 650 : 400;

  const processOneDaftarLayaniJob = async (curJob) => {
    const pIndex = curJob.index ?? 0;
    const patient = { ...curJob };
    const dryRun = !!options.dryRun;

    console.log(`[daftarLayani] Mulai proses [${pIndex + 1}]: ${patient.nama} (NIK: ${patient.nik || "-"})`);

    // ── TAHAP 1: PENDAFTARAN VIA API KEMKES ────────────────────────────────
    chrome.runtime.sendMessage({
      type: "DAFTAR_LAYANI_PROGRESS",
      index: pIndex,
      stage: "pendaftaran",
      status: "in-progress",
      message: dryRun ? "Memvalidasi NIK (Dry Run)..." : "Mendaftarkan ke API Kemkes..."
    }).catch(() => {});

    let ticketNumber = patient.ticketNumber || patient.no_tiket || null;
    let regId = patient.reg_id || patient.regId || null;
    try {
      if (!dryRun && ticketNumber) {
        console.log(`[daftarLayani] Pasien ${patient.nama} sudah punya tiket (${ticketNumber}), langsung lanjut pelayanan.`);
      } else {
        const regRes = await runPendaftaranApi(tabId, ckgUser, patient, { dryRun });
        console.log(`[daftarLayani] Hasil pendaftaran:`, regRes);

        if (regRes.status === "valid-dry-run") {
          chrome.runtime.sendMessage({
            type: "DAFTAR_LAYANI_PROGRESS",
            index: pIndex,
            stage: "pendaftaran",
            status: "valid-dry-run",
            message: regRes.message || "Valid (Dry Run)"
          }).catch(() => {});
          await new Promise(r => setTimeout(r, options.delayMs || 1000));
          return;
        }

        if (regRes.status === "already-screened") {
          stats.already++;
          persistDaftarLayaniPatientState(pIndex, {
            _status: "already-screened",
            _stage: "pendaftaran",
            _errorMsg: regRes.message || "Sudah pernah diskrining"
          });
          if (syncEnabled && patient.nik) {
            updateQueueStatusToCkgbankot({
              nik: patient.nik,
              jenis: categoryLabel,
              status_pendaftaran: "Sudah Terdaftar",
              status_pelayanan: "Pernah Input",
              keterangan: regRes.message || "Sudah pernah diskrining"
            }).catch(() => {});
            syncPatientToCkgbankot(buildSyncBase(patient, {
              status_pendaftaran: "Sudah Terdaftar",
              status_pelayanan: "Pernah Input"
            })).catch(() => {});
          }
          chrome.runtime.sendMessage({
            type: "DAFTAR_LAYANI_PROGRESS",
            index: pIndex,
            stage: "pendaftaran",
            status: "already-screened",
            message: regRes.message || "Individu sudah menerima layanan"
          }).catch(() => {});
          await new Promise(r => setTimeout(r, options.delayMs || 1000));
          return;
        }

        if (regRes.status !== "done") {
          throw new Error(regRes.message || "Gagal registrasi pasien di web ASIK");
        }

        ticketNumber = regRes.ticketNumber;
        regId = regRes.regId ?? null;
        persistDaftarLayaniPatientState(pIndex, {
          _stage: "pelayanan",
          _status: "in-progress",
          ticketNumber: ticketNumber || "",
          _nomorTiket: ticketNumber || "",
          no_tiket: ticketNumber || "",
          reg_id: regId || ""
        });
        if (syncEnabled && patient.nik) {
          updateQueueStatusToCkgbankot({
            nik: patient.nik,
            jenis: categoryLabel,
            status_pendaftaran: "Sudah Terdaftar",
            no_tiket: ticketNumber || "",
            keterangan: "Pendaftaran One-Stop Berhasil"
          }).catch(() => {});
          syncPatientToCkgbankot(buildSyncBase(patient, {
            no_tiket: ticketNumber || "",
            status_pendaftaran: "Sudah Terdaftar",
            status_pelayanan: "Belum Pelayanan"
          })).catch(() => {});
        }
        chrome.runtime.sendMessage({
          type: "DAFTAR_LAYANI_PROGRESS",
          index: pIndex,
          stage: "pelayanan",
          status: "in-progress",
          ticketNumber: ticketNumber,
          message: `Terdaftar (Tiket: ${ticketNumber || "OK"})`
        }).catch(() => {});
      }

    } catch (regErr) {
      stats.error++;
      console.error(`[daftarLayani] Error registrasi pasien ${patient.nama}:`, regErr);
      persistDaftarLayaniPatientState(pIndex, {
        _status: "error",
        _stage: "pendaftaran",
        _errorMsg: regErr.message || "Gagal registrasi"
      });
      const isSessionDead = regErr.message.includes("401") ||
                            regErr.message.includes("Sesi CKG kedaluwarsa") ||
                            regErr.message.toLowerCase().includes("unauthorized");

      if (syncEnabled && patient.nik) {
        updateQueueStatusToCkgbankot({
          nik: patient.nik,
          jenis: categoryLabel,
          status_pendaftaran: "Gagal Pendaftaran",
          keterangan: regErr.message || "Gagal pendaftaran di ASIK"
        }).catch(() => {});
      }

      chrome.runtime.sendMessage({
        type: "DAFTAR_LAYANI_PROGRESS",
        index: pIndex,
        stage: "pendaftaran",
        status: "error",
        message: isSessionDead ? "Sesi ASIK kedaluwarsa (401). Silakan login ulang di web ASIK." : regErr.message
      }).catch(() => {});

      if (isSessionDead) {
        console.warn("[daftarLayani] Sesi ASIK terdeteksi 401 Unauthorized, menghentikan antrean.");
        daftarLayaniRunning = false;
        await chrome.storage.session.set({ daftarLayaniRunning: false });
        if (syncEnabled && stats.total > 0) {
          await flushPendingPatientSync().catch(() => {});
          await syncLogToCkgbankot({
            jenis_kegiatan: `Daftar & Layani ${categoryLabel}`,
            total_pasien: stats.total,
            jumlah_berhasil: stats.done,
            jumlah_terdaftar: stats.already,
            jumlah_gagal: stats.error,
            status: "Dihentikan (401)",
            keterangan: `Terhenti 401: ${stats.done} selesai, ${stats.already} pernah input, ${stats.error} gagal.`
          }).catch(() => {});
        }
        chrome.runtime.sendMessage({
          type: "DAFTAR_LAYANI_PROGRESS",
          index: pIndex,
          stage: "pendaftaran",
          status: "error",
          message: "Sesi ASIK kedaluwarsa (401). Silakan login ulang di web ASIK lalu klik Mulai Proses lagi.",
          isFinished: true
        }).catch(() => {});
        return;
      }

      await new Promise(r => setTimeout(r, options.delayMs || 1000));
      return;
    }

    if (daftarLayaniAbortCtrl?.signal?.aborted || !daftarLayaniRunning) return;

    // ── TAHAP 2: LANGSUNG PELAYANAN PEMERIKSAAN ─────────────────────────────
    chrome.runtime.sendMessage({
      type: "DAFTAR_LAYANI_PROGRESS",
      index: pIndex,
      stage: "pelayanan",
      status: "in-progress",
      ticketNumber: ticketNumber,
      message: "Membuka formulir pelayanan..."
    }).catch(() => {});

    try {
      const rawGender = patient.jenis_kelamin || patient.jeniskelamin || patient.gender || patient.jk || "";
      const fallbackGender = String(rawGender).toLowerCase().startsWith("p") ? "perempuan" : "laki-laki";
      const cleanVal = v => {
        const s = String(v ?? "").trim();
        return !s || s === "-" ? "" : s;
      };

      const apiPatientData = {
        ...patient,
        nama: patient.nama,
        nik: patient.nik || ticketNumber,
        nomorTiket: ticketNumber,
        reg_id: regId,
        tanggal_lahir: patient.tanggal_lahir || patient.tanggallahir || "",
        kategori: isSchool ? "anak" : "dewasa",
        category: categoryLabel,
        jenisKelamin: fallbackGender,
        jenis_kelamin: fallbackGender,
        status_pernikahan: patient.status_pernikahan || patient.statusnikah || patient.statusperkawinan || "menikah",
        td_sistolik: cleanVal(patient.td_sistolik || patient.tdsistolik || patient.sistole || patient.sistolik),
        td_diastolik: cleanVal(patient.td_diastolik || patient.tddiastolik || patient.diastole || patient.diastolik),
        gula_darah: cleanVal(patient.gula_darah || patient.guladarah || patient.gds || patient.gd),
        hb: cleanVal(patient.hb),
        merokok: cleanVal(patient.merokok || patient.riwayatmerokok || patient.rokok),
        telinga: cleanVal(patient.telinga || patient.serumentelinga),
        mata: cleanVal(patient.mata),
        gigi: cleanVal(patient.gigi || patient.caries || patient.karies),
        attendDate: options.screeningDate || patient.screening_date || null
      };

      const { ckg_ranges: nrApi } = await chrome.storage.local.get("ckg_ranges");
      const apiRules = await o(apiPatientData, nrApi ?? {});

      let isSuccess = false;
      let usedDomFallback = false;
      let patientData = apiPatientData;
      let lastApiError = "";

      // Jalur Utama: 100% API (tanpa DOM/klik browser)
      if (!options.forceDomPelayanan) {
        try {
          console.log(`[daftarLayani] Menjalankan Pelayanan API untuk ${patient.nama} (regId: ${regId || "-"}, tiket: ${ticketNumber || "-"})`);
          const apiRes = await runPelayananApi(tabId, apiPatientData, {
            ckgUser,
            regId,
            ticketNumber,
            isSchool,
            screeningDate: options.screeningDate || patient.screening_date || null,
            dryRun: false,
            fieldRules: apiRules,
            interFormDelayMs,
            onProgress: (idx, total, title) => {
              const pct = total > 0 ? Math.round(((idx + 1) / total) * 100) : 0;
              chrome.runtime.sendMessage({
                type: "DAFTAR_LAYANI_PROGRESS",
                index: pIndex,
                stage: "pelayanan",
                status: "in-progress",
                ticketNumber: ticketNumber,
                formIndex: idx + 1,
                formTotal: total,
                formName: title || "",
                percent: pct,
                message: `Form ${idx + 1}/${total} (${pct}%): ${title || ""}`
              }).catch(() => {});
            }
          });
          if (apiRes?.status === "done") {
            isSuccess = true;
            console.log(`[daftarLayani] Pelayanan API selesai (${apiRes.submittedCount} form): ${patient.nama}`);
          } else {
            const failedNames = (apiRes?.failedForms || []).map(f => `${f.name}: ${f.error}`).join("; ");
            lastApiError = failedNames || `API belum penuh (${apiRes?.status})`;
            console.warn(`[daftarLayani] Pelayanan API belum penuh (${apiRes?.status}):`, apiRes?.failedForms);
          }
        } catch (apiErr) {
          lastApiError = apiErr?.message || String(apiErr);
          console.warn(`[daftarLayani] Pelayanan API gagal:`, lastApiError);
        }
      }

      if (!isSuccess && !allowDomFallback) {
        throw new Error(lastApiError || "Pelayanan API gagal (mode paralel tanpa DOM)");
      }

      // Jalur Fallback DOM jika API gagal / partial (hanya saat paralel === 1)
      if (!isSuccess) {
        usedDomFallback = true;
        // 1. Pastikan tab berada di halaman ckg-pelayanan yang sesuai
        const currentTab = await chrome.tabs.get(tabId).catch(() => null);
        const isCorrectUrl = currentTab?.url && currentTab.url.includes(isSchool ? "ckg-pelayanan-sekolah" : "ckg-pelayanan");
        if (!isCorrectUrl) {
          await chrome.tabs.update(tabId, { url: targetPelayananUrl });
          await new Promise(resolve => {
            const listener = (tid, changeInfo) => {
              if (tid === tabId && changeInfo.status === "complete") {
                chrome.tabs.onUpdated.removeListener(listener);
                resolve();
              }
            };
            chrome.tabs.onUpdated.addListener(listener);
            setTimeout(() => { chrome.tabs.onUpdated.removeListener(listener); resolve(); }, 12000);
          });
          await new Promise(r => setTimeout(r, 1500));
        }

        // 2. Buka baris pasien di tabel pelayanan ASIK
        const patientMatch = {
          ...patient,
          nomorTiket: ticketNumber || patient.nomorTiket,
          nik: patient.nik
        };
        console.log(`[daftarLayani] Mencari dan membuka pasien di tabel pelayanan:`, patientMatch.nama, patientMatch.nomorTiket);
        await openPatientInTable(tabId, patientMatch);

        // 3. Konfirmasi modal tanggal jika muncul
        await confirmMulaiPemeriksaanIfPresent(tabId, options.screeningDate || patient.screening_date || null);

        // 4. Ekstrak detail pasien dan gabungkan seluruh nilai klinis dari Excel (termasuk alias kolom Laporan CKG)
        const pDetail = await extractDetailPatientState(tabId).catch(() => null);
        patientData = {
          ...apiPatientData,
          nik: pDetail?.nik || patient.nik || ticketNumber,
          nomorTiket: pDetail?.nomorTiket || ticketNumber,
          tanggal_lahir: patient.tanggal_lahir || patient.tanggallahir || pDetail?.tanggalLahir || "",
          kategori: pDetail?.kategori || (isSchool ? "anak" : "dewasa"),
          jenisKelamin: pDetail?.jenisKelamin || fallbackGender,
          jenis_kelamin: pDetail?.jenisKelamin || fallbackGender,
          attendDate: pDetail?.attendDate || options.screeningDate || patient.screening_date || null
        };

        // 5. Uncheck layanan tambahan & generate rules skrining dari data Excel
        const bRules = await r(patientData);
        await n(tabId, bRules).catch(err => console.error("[daftarLayani] Uncheck pass 1/2 error:", err));
        await n(tabId, bRules).catch(err => console.error("[daftarLayani] Uncheck pass 2/2 error:", err));

        const { ckg_ranges: nr, ckg_config: cr } = await chrome.storage.local.get(["ckg_ranges", "ckg_config"]);
        const sRanges = nr ?? {};
        const iDelay = Math.round(1e3 * (cr?.delay ?? 1.2));
        const lRules = await o(patientData, sRanges);

        // 6. Jalankan Automation pengisian kuesioner
        const uAuto = new e({
          tabId,
          statusMenikah: patientData.status_pernikahan,
          delay: iDelay,
          testMode: cr?.testMode ?? false,
          fieldRules: lRules,
          items: null,
          attendDate: patientData.attendDate,
          patientData,
          onProgress: (idx, status, title) => {
            chrome.runtime.sendMessage({
              type: "DAFTAR_LAYANI_PROGRESS",
              index: pIndex,
              stage: "pelayanan",
              status: "in-progress",
              ticketNumber: ticketNumber,
              message: `Mengisi [${idx + 1}] ${title || ""}`
            }).catch(() => {});
          },
          onDone: () => {
            console.log(`[daftarLayani] Selesai isi kuesioner: ${patient.nama}`);
          }
        });

        await uAuto.run();
        if (!uAuto._stopped && !uAuto.pelayananFinished) {
          await uAuto.run();
        }
        if (!uAuto._stopped && !uAuto.pelayananFinished) {
          console.log(`[daftarLayani] Menyelesaikan layanan...`);
          const finRes = await uAuto.finishPelayanan().catch(e => ({ success: false, error: e.message }));
          if (finRes?.success) uAuto.pelayananFinished = true;
        }

        if (uAuto.pelayananFinished) {
          isSuccess = true;
        } else {
          const verifyRes = await uAuto.verifyAllDone().catch(() => null);
          if (verifyRes?.allDone && (!uAuto.failedItems || uAuto.failedItems.length === 0)) {
            isSuccess = true;
          }
        }

        if (!isSuccess) {
          throw new Error("Layanan belum terselesaikan penuh di web ASIK");
        }
      }

      // Selesai dengan sukses!
      stats.done++;
      persistDaftarLayaniPatientState(pIndex, {
        _status: "done",
        _stage: "done",
        ticketNumber: ticketNumber || "",
        _nomorTiket: ticketNumber || "",
        no_tiket: ticketNumber || "",
        reg_id: regId || "",
        _errorMsg: ""
      });
      if (syncEnabled && patient.nik) {
        await Promise.all([
          updateQueueStatusToCkgbankot({
            nik: patient.nik,
            jenis: categoryLabel,
            status_pendaftaran: "Sudah Terdaftar",
            status_pelayanan: "Selesai Pelayanan",
            no_tiket: ticketNumber || "",
            keterangan: "Daftar & Layani Selesai via Bot ENCO"
          }).catch(() => {}),
          syncPatientToCkgbankot(buildSyncBase(patient, {
            no_tiket: ticketNumber || patientData.nomorTiket || "",
            status_pendaftaran: "Sudah Terdaftar",
            status_pelayanan: "Selesai Pelayanan",
            tanggal_pelayanan: patientData.attendDate || options.screeningDate || todayIso,
            raw_details: { ...patient, ...patientData }
          })).catch(() => {})
        ]);
        await flushPendingPatientSync().catch(() => {});
      }

      chrome.runtime.sendMessage({
        type: "DAFTAR_LAYANI_PROGRESS",
        index: pIndex,
        stage: "done",
        status: "done",
        ticketNumber: ticketNumber,
        percent: 100,
        message: "Selesai Pelayanan!"
      }).catch(() => {});

      // Kembali ke tabel pelayanan hanya jika tadi memakai jalur DOM fallback
      if (usedDomFallback) {
        await returnToPelayananTable(tabId);
      }
      await new Promise(r => setTimeout(r, options.delayMs || (maxConcurrent > 1 ? 600 : 1200)));

    } catch (layaniErr) {
      stats.error++;
      console.error(`[daftarLayani] Error pelayanan pasien ${patient.nama}:`, layaniErr);
      persistDaftarLayaniPatientState(pIndex, {
        _status: "error",
        _stage: "pelayanan",
        ticketNumber: ticketNumber || "",
        _errorMsg: layaniErr.message || "Gagal pelayanan"
      });
      if (syncEnabled && patient.nik) {
        updateQueueStatusToCkgbankot({
          nik: patient.nik,
          jenis: categoryLabel,
          status_pelayanan: "Gagal Pelayanan",
          no_tiket: ticketNumber || "",
          keterangan: layaniErr.message || "Gagal menyelesaikan pelayanan"
        }).catch(() => {});
      }
      chrome.runtime.sendMessage({
        type: "DAFTAR_LAYANI_PROGRESS",
        index: pIndex,
        stage: "pelayanan",
        status: "error",
        ticketNumber: ticketNumber,
        message: layaniErr.message
      }).catch(() => {});

      if (allowDomFallback) {
        try {
          await returnToPelayananTable(tabId);
          await new Promise(r => setTimeout(r, 1200));
        } catch (_) {}
      }
    }
  };

  const workerCount = Math.min(maxConcurrent, daftarLayaniQueue.length || 1);
  await Promise.all(
    Array.from({ length: workerCount }, (_, wIdx) => (async () => {
      if (wIdx > 0) {
        await new Promise(r => setTimeout(r, wIdx * 600));
      }
      while (daftarLayaniQueue.length > 0 && daftarLayaniRunning) {
        if (daftarLayaniAbortCtrl?.signal?.aborted) break;
        const job = daftarLayaniQueue.shift();
        if (!job) break;
        await processOneDaftarLayaniJob(job);
      }
    })())
  );

  const wasStopped = !daftarLayaniRunning || !!daftarLayaniAbortCtrl?.signal?.aborted;

  if (syncEnabled && (stats.done + stats.already + stats.error) > 0) {
    await flushPendingPatientSync().catch(() => {});
    await syncLogToCkgbankot({
      jenis_kegiatan: `Daftar & Layani ${categoryLabel}`,
      total_pasien: stats.total,
      jumlah_berhasil: stats.done,
      jumlah_terdaftar: stats.already,
      jumlah_gagal: stats.error,
      status: wasStopped ? "Dihentikan" : stats.error > 0 ? "Selesai Sebagian" : "Selesai",
      keterangan: `One-Stop CKG ${wasStopped ? "dihentikan" : "selesai"}: ${stats.done} selesai pelayanan, ${stats.already} pernah input, ${stats.error} gagal.`
    }).catch(err => console.warn("[daftarLayani] syncLogToCkgbankot error:", err));
  }

  daftarLayaniRunning = false;
  await chrome.storage.session.set({ daftarLayaniRunning: false });
  chrome.runtime.sendMessage({
    type: "DAFTAR_LAYANI_PROGRESS",
    isFinished: true,
    wasStopped
  }).catch(() => {});
}

// ── Device Conflict Check Alarm & Heartbeat Alarm ─────────────────────────
chrome.alarms.create("deviceCheck", { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener(async e => {
  if ("deviceCheck" === e.name) {
    if (!await l().catch(() => false)) {
      const { session: e } = await chrome.storage.local.get("session");
      if (!e) return;
      await i();
      chrome.runtime.sendMessage({ type: "DEVICE_CONFLICT" }).catch(() => {});
    }
  } else if (CKG_HEARTBEAT_ALARM === e.name) {
    await pingCkgSession().catch(err => console.error("[background] Heartbeat ping error:", err));
  }
});

let E = 0;
function b(e, t, a) {
  const n = Date.now();
  if ("error" !== t && "done" !== t && n - E < 500) return;
  E = n;
  chrome.runtime.sendMessage({ type: "PROGRESS", index: e, status: t, error: a }).catch(() => {});
}

async function R(e) {
  await chrome.storage.session.set({ automationProgress: e });
}

async function M() {
  const { automationProgress: e } = await chrome.storage.session.get("automationProgress");
  return e ?? [];
}

// ── Main Dispatcher ─────────────────────────────────────────────────────────
async function D(s) {
  switch (s.type) {
    case "START": {
      if (!await T()) {
        await i();
        chrome.runtime.sendMessage({ type: "DEVICE_CONFLICT" }).catch(() => {});
        return { ok: false, error: "DEVICE_CONFLICT" };
      }
      if (N) N.stop();
      const { tabId: t, statusMenikah: a, items: o, delay: r, testMode: c, fieldRules: rawRules, fieldValues: u = {}, patientData: m } = s;
      const l = [...(rawRules || [])];
      if (m) {
        const dRules = getDemoRules(m);
        for (const dr of dRules) {
          if (!l.some(x => x.keyword === dr.keyword)) l.push(dr);
        }
      }
      const pIso = (new Date()).toISOString();
      const AProg = o.map(({ title: e, source: t = "table", done: a = false }) => ({
        title: e,
        source: t,
        status: a ? "done" : "waiting"
      }));
      await R(AProg);
      if (m) {
        try {
          await g({ patientData: m, startedAt: pIso });
        } catch (e) {
          console.error("[START] ensurePendaftaranRecord error:", e);
        }
      }
      const hObj = { patientData: m, progress: AProg, stopped: false };
      w = hObj;
      await chrome.storage.session.set({ otomasiRunning: true }).catch(() => {});
      N = new e({
        tabId: t,
        statusMenikah: a,
        delay: r,
        testMode: c,
        fieldRules: l,
        items: o,
        attendDate: m?.attendDate,
        patientData: m,
        onProgress: async (e, t, a, n) => {
          AProg[e] = { ...AProg[e], title: a, status: t, error: n };
          await R(AProg);
          b(e, t, n);
        },
        onDone: async () => {
          N = null;
          await chrome.storage.session.set({ otomasiRunning: false }).catch(() => {});
          if (w === hObj) {
            if (fAuto?._stopped) hObj.stopped = true;
            w = null;
          }
          const e = AProg.filter(e => "done" === e.status || "error" === e.status).length;
          const t = AProg.filter(e => "done" === e.status).length;
          if (m) {
            try {
              await d({ patientData: m, progress: AProg, attempted: e, succeeded: t, stopped: hObj.stopped, startedAt: pIso });
            } catch (e) {
              console.error("[record] insertAutomationRecord threw:", e);
            }
          }
          chrome.runtime.sendMessage({ type: "DONE" }).catch(() => {});
        }
      });
      const fAuto = N;
      return (async () => {
        await (async function (e, t) {
          const a = t ? new Date(t) : new Date();
          const ef = isNaN(a.getTime()) ? new Date() : a;
          const n = ef.getFullYear(), o = ef.getMonth() + 1, r = ef.getDate();
          const [s] = await chrome.scripting.executeScript({
            target: { tabId: e },
            world: "MAIN",
            func: () => {
              const e = Array.from(document.querySelectorAll("button")).find(e => "Mulai Pemeriksaan" === e.textContent.trim());
              return !(!e || e.disabled || !(e.getBoundingClientRect().width > 0));
            }
          });
          if (s?.result) {
            await chrome.scripting.executeScript({
              target: { tabId: e },
              world: "MAIN",
              func: (e, t, a) => {
                const n = ["Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Agu", "Sep", "Okt", "Nov", "Des"];
                const o = e => new Promise(t => {
                  const a = performance.now();
                  const n = new MessageChannel();
                  n.port1.onmessage = () => { performance.now() - a >= e ? t() : n.port2.postMessage(null); };
                  n.port2.postMessage(null);
                });
                (async () => {
                  Array.from(document.querySelectorAll("button")).find(e => "Mulai Pemeriksaan" === e.textContent.trim())?.click();
                  await o(1e3);
                  const r = t - 1 + 12 * e;
                  for (let e = 0; e < 36; e++) {
                    const e = Array.from(document.querySelectorAll("div.flex.items-center")).find(e => 2 === e.children.length && /^(Jan|Feb|Mar|Apr|Mei|Jun|Jul|Agu|Sep|Okt|Nov|Des)\d{4}$/.test((e.textContent || "").replace(/\s+/g, "")));
                    if (!e) { await o(300); continue; }
                    const t = (e.textContent || "").replace(/\s+/g, "").match(/^([A-Za-z]{3})(\d{4})$/);
                    const a = t ? t[1] + " " + t[2] : "";
                    if (!a) { await o(300); continue; }
                    const [s, c] = a.split(" ");
                    const i = n.indexOf(s) + 12 * parseInt(c);
                    if (i === r) break;
                    const l = i > r;
                    const d = e.parentElement?.querySelector("div.flex.items-center.justify-center");
                    const u = d ? Array.from(d.querySelectorAll("button")) : [];
                    u[l ? 0 : 1]?.click();
                    await o(450);
                  }
                  Array.from(document.querySelectorAll("span")).find(e => e.textContent.trim() === String(a) && !/text-gray-300/.test(e.className) && e.closest(".grid") && null !== e.offsetParent)?.click();
                  await o(400);
                  Array.from(document.querySelectorAll("button")).find(e => "Simpan" === e.textContent.trim() && !e.disabled)?.click();
                  await o(800);
                })();
              },
              args: [n, o, r]
            });
            console.log("[setTanggalPemeriksaan] Done — tanggal set to", n, o, r);
          } else {
            console.log("[setTanggalPemeriksaan] No Mulai Pemeriksaan button — skipping");
          }
        })(t, m?.attendDate).catch(e => console.error("[START] setTanggalPemeriksaan error:", e));

        await n(t, u).catch(e => console.error("[START] runUncheckAll (pass 1/2) error:", e));
        await n(t, u).catch(e => console.error("[START] runUncheckAll (pass 2/2) error:", e));
        await fAuto.run().catch(e => console.error("[START] automation.run (pass 1/2) error:", e));
        if (fAuto._stopped || fAuto.pelayananFinished) return;
        fAuto.items = null;
        fAuto._itemsCache = null;
        await fAuto.run().catch(e => console.error("[START] automation.run (pass 2/2) error:", e));
        if (!fAuto._stopped && !fAuto.pelayananFinished) {
          console.log("[START] Memanggil fAuto.finishPelayanan() sebagai jaminan tahap akhir...");
          const finRes = await fAuto.finishPelayanan().catch(e => ({ success: false, error: e.message }));
          if (finRes?.success) fAuto.pelayananFinished = true;
        }
      })(), { ok: true };
    }

    case "PAUSE":
      return N?.pause(), { ok: true };
    case "RESUME":
      return N?.resume(), { ok: true };
    case "STOP":
      if (w) w.stopped = true;
      if (N) N.stop();
      N = null;
      await chrome.storage.session.set({ otomasiRunning: false }).catch(() => {});
      return { ok: true };
    case "RETRY": {
      const { tabId: t, statusMenikah: a, title: n, source: o = "table", progressIndex: r, delay: c, fieldRules: i } = s;
      const l = await M();
      return new e({
        tabId: t,
        statusMenikah: a,
        delay: c,
        fieldRules: i,
        onProgress: async (e, t, a, n) => {
          l[r] = { ...l[r], title: a, status: t, error: n };
          await R(l);
          b(r, t, n);
        },
        onDone: async () => {
          chrome.runtime.sendMessage({ type: "DONE" }).catch(() => {});
        }
      }).runSingle({ title: n, source: o }, r), { ok: true };
    }

    case "FILL_FORM": {
      const { tabId: t, statusMenikah: a, title: n, delay: o, fieldRules: r } = s;
      const cAuto = new e({ tabId: t, statusMenikah: a, delay: o, fieldRules: r, onProgress: () => {}, onDone: () => {} });
      try {
        return await cAuto.fillForm(n), { ok: true };
      } catch (e) {
        return console.error("[FILL_FORM] error:", e), { ok: false, error: e.message };
      }
    }

    case "RUN_PELAYANAN_AUTOMATION": {
      const { recordIndex: t, nik: c, tanggalData: i, isExcel: l = false, patientRecord: d = null } = s;
      let g = false;
      let PTabId = null;
      try {
        const abortCtrl = new AbortController();
        y[t] = abortCtrl;
        chrome.runtime.sendMessage({ type: "PELAYANAN_INSTAN_STATUS", nik: c, automationStatus: "in-progress" }).catch(() => {});

        const m = l ? d : await f(c);
        const A = m?.category ?? "UMUM";
        const k = m?.sekolah;
        const N = m?.kelas;
        const wUrls = {
          UMUM: "https://sehatindonesiaku.kemkes.go.id/ckg-pelayanan",
          SEKOLAH: "https://sehatindonesiaku.kemkes.go.id/ckg-pelayanan-sekolah"
        };
        const SUrl = wUrls[A] ?? wUrls.UMUM;
        const createdTab = await chrome.tabs.create({ url: SUrl });
        PTabId = createdTab.id;
        await new Promise(e => setTimeout(e, 1600));

        const I = e => {
          console.log("[Pelayanan Automation]", e);
          chrome.runtime.sendMessage({ type: "PELAYANAN_INSTAN_STATUS", nik: c, text: e }).catch(() => {});
        };

        const _onDone = l ? () => {
          u(d).then(() => {
            console.log("[background] Excel patient inserted into pendaftaran_records — nik:", c);
          }).catch(e => {
            console.error("[background] Failed to insert Excel patient record:", e);
          });
        } : void 0;

        const E = await a(PTabId, { nik: c, tahun: i.tahun, bulan: i.bulan, hari: i.hari, category: A, sekolah: k, kelas: N }, I, abortCtrl.signal, _onDone);

        // 1. EARLY STATUS: ALREADY_SCREENED / DONE_PELAYANAN (Sudah Selesai Pemeriksaan Sebelumnya)
        if ("ALREADY_SCREENED" === E?.earlyStatus || "DONE_PELAYANAN" === E?.earlyStatus) {
          console.log("[background] Patient found in Selesai Pemeriksaan, marking ALREADY_SCREENED (Pernah Input)");
          if (!l) {
            try {
              await h(`?nik=eq.${encodeURIComponent(c)}`, "ALREADY_SCREENED");
            } catch (e) {
              console.error("[background] Failed to update record status on early screened:", e);
            }
          }
          delete y[t];
          if (PTabId) chrome.tabs.remove(PTabId).catch(() => {});

          await updatePelayananInstanRecord(c, rec => {
            rec._status = "already-screened";
            rec.status = "ALREADY_SCREENED";
          });

          await addPelayananPendingStatus({ nik: c, automationStatus: "already-screened", recordStatus: "ALREADY_SCREENED" });

          updateQueueStatusToCkgbankot({
            nik: c,
            status_pelayanan: "Pernah Input",
            keterangan: "Pernah Input di ASIK Kemkes"
          }).catch(() => {});

          chrome.runtime.sendMessage({
            type: "PELAYANAN_INSTAN_STATUS",
            nik: c,
            automationStatus: "already-screened",
            recordStatus: "ALREADY_SCREENED",
            text: "Pernah Input"
          }).catch(() => {});

          return { ok: true, earlyStatus: "ALREADY_SCREENED" };
        }

        // 2. EARLY STATUS: MISSING (Tidak Ditemukan)
        if ("MISSING" === E?.earlyStatus) {
          if (!l) {
            try {
              await h(`?nik=eq.${encodeURIComponent(c)}`, "MISSING");
            } catch (e) {
              console.error("[background] Failed to update record status on missing:", e);
            }
          }
          delete y[t];
          if (PTabId) chrome.tabs.remove(PTabId).catch(() => {});

          await updatePelayananInstanRecord(c, rec => {
            rec._status = "error";
            rec.status = "MISSING";
          });

          await addPelayananPendingStatus({ nik: c, automationStatus: "error", recordStatus: "MISSING" });

          chrome.runtime.sendMessage({
            type: "PELAYANAN_INSTAN_STATUS",
            nik: c,
            automationStatus: "error",
            recordStatus: "MISSING"
          }).catch(() => {});

          return { ok: true, earlyStatus: "MISSING" };
        }

        // 2b. EARLY STATUS: SERVER_ERROR_SKIP (Internal Server Error 3x dilewati)
        if ("SERVER_ERROR_SKIP" === E?.earlyStatus) {
          console.warn(`[background] Patient ${c} skipped due to persistent Internal Server Error (3x refresh)`);
          if (!l) {
            try {
              await h(`?nik=eq.${encodeURIComponent(c)}`, "PARTIAL_DONE_PELAYANAN");
            } catch (e) {
              console.error("[background] Failed to update record status on server error skip:", e);
            }
          }
          delete y[t];
          if (PTabId) chrome.tabs.remove(PTabId).catch(() => {});

          const { "pelayanan-instan-records": curRecs = [] } = await chrome.storage.session.get("pelayanan-instan-records");
          const curIdx = curRecs.findIndex(r => r.nik === c);
          if (curIdx !== -1) {
            curRecs[curIdx]._status = "error";
            curRecs[curIdx].status = "SERVER_ERROR";
            curRecs[curIdx]._errorMsg = "Internal Server Error (3x dilewati)";
            await chrome.storage.session.set({ "pelayanan-instan-records": curRecs });
          }

          const { pelayananInstanPendingStatuses: ep = [] } = await chrome.storage.session.get("pelayananInstanPendingStatuses");
          ep.push({ nik: c, automationStatus: "error", recordStatus: "SERVER_ERROR" });
          await chrome.storage.session.set({ pelayananInstanPendingStatuses: ep });

          chrome.runtime.sendMessage({
            type: "PELAYANAN_INSTAN_STATUS",
            nik: c,
            automationStatus: "error",
            recordStatus: "SERVER_ERROR",
            text: "Internal Server Error (3x dilewati)"
          }).catch(() => {});

          return { ok: true, earlyStatus: "SERVER_ERROR_SKIP" };
        }

        // 3. ABORTED
        if (abortCtrl.signal.aborted) {
          console.log("[background] Automation was stopped by user");
          if (!l) {
            try {
              await h(`?nik=eq.${encodeURIComponent(c)}`, "PARTIAL_DONE_PELAYANAN");
            } catch (e) {}
          }
          delete y[t];
          if (PTabId) chrome.tabs.remove(PTabId).catch(() => {});
          chrome.runtime.sendMessage({ type: "PELAYANAN_INSTAN_STATUS", nik: c, automationStatus: "idle" }).catch(() => {});
          return { ok: true };
        }

        // 4. NORMAL FORM AUTOMATION
        const bRules = m ? await r(m) : {};
        console.log("[background] Running uncheck all on tab", PTabId, "(pass 1/2)");
        try { await n(PTabId, bRules); } catch (e) { console.error("[background] Uncheck all error:", e); }
        console.log("[background] Running uncheck all on tab", PTabId, "(pass 2/2)");
        try { await n(PTabId, bRules); } catch (e) { console.error("[background] Uncheck all error:", e); }

        console.log("[background] Starting form automation phase...");
        try {
          let recData = null;
          try {
            recData = await f(c);
          } catch (e) {}
          if (!recData) recData = m;
          if (!recData) {
            recData = { nik: c, category: "dewasa", status_pernikahan: "menikah" };
          }

          const { ckg_ranges: nr, ckg_config: cr } = await chrome.storage.local.get(["ckg_ranges", "ckg_config"]);
          const sRanges = nr ?? {};
          const iDelay = Math.round(1e3 * (cr?.delay ?? 1.2));
          const lRules = await o(recData, sRanges);
          const attDateStr = s.tanggalData ? `${s.tanggalData.tahun}-${s.tanggalData.bulan}-${s.tanggalData.hari}` : null;

          const uAuto = new e({
            tabId: PTabId,
            statusMenikah: recData.status_pernikahan || "menikah",
            delay: iDelay,
            testMode: cr?.testMode ?? false,
            fieldRules: lRules,
            items: null,
            attendDate: attDateStr,
            patientData: recData,
            onProgress: (idx, status, title, error) => {
              I(`${title}: ${status}`);
            },
            onDone: () => {
              I("✓ Semua form berhasil diselesaikan");
            }
          });

          console.log("[background] Starting automation run through all items (pass 1/2)...");
          await uAuto.run();
          if (!uAuto._stopped && !uAuto.pelayananFinished) {
            console.log("[background] Starting automation run pass 2 for remaining items...");
            await uAuto.run();
          }

          // Jaminan Tahap Akhir: Jika pelayananFinished belum tercapai (misal butuh klik tombol Selesaikan Layanan)
          if (!uAuto._stopped && !uAuto.pelayananFinished) {
            console.log("[background] Memanggil uAuto.finishPelayanan() secara eksplisit dari background...");
            const finRes = await uAuto.finishPelayanan().catch(e => ({ success: false, error: e.message }));
            if (finRes?.success) {
              uAuto.pelayananFinished = true;
              console.log("[background] uAuto.finishPelayanan() berhasil diselesaikan.");
            } else {
              console.warn("[background] uAuto.finishPelayanan() gagal:", finRes);
            }
          }

          let isAllDone = false;
          if (uAuto.pelayananFinished) {
            isAllDone = true;
          } else {
            try {
              const verifyRes = await uAuto.verifyAllDone();
              // Jika tombol Selesaikan Layanan masih ada di web ASIK, JANGAN pernah anggap Berhasil!
              if (verifyRes?.hasSelesaikanBtn) {
                console.warn("[background] Tombol Selesaikan Layanan masih ada di web ASIK. Pasien belum selesai penuh.");
                isAllDone = false;
              } else {
                const hasNoFailed = (uAuto.failedItems || []).length === 0;
                const noRemainingInput = !verifyRes?.anyActiveInputBtn;
                isAllDone = (verifyRes?.allDone && hasNoFailed) || (noRemainingInput && hasNoFailed && !verifyRes?.hasSelesaikanBtn);
              }
            } catch (err) {
              console.warn("[background] verifyAllDone failed:", err.message);
              isAllDone = false;
            }
          }

          g = isAllDone;
          const finalStatus = isAllDone ? "DONE_PELAYANAN" : "PARTIAL_DONE_PELAYANAN";
          if (!l) {
            try {
              if (recData?.id) {
                await h(`?id=eq.${encodeURIComponent(recData.id)}`, finalStatus);
              }
              await h(`?nik=eq.${encodeURIComponent(c)}`, finalStatus);
            } catch (e) {
              console.error("[background] Failed to update supabase status:", e);
            }
          }
        } catch (formErr) {
          console.error("[background] Form automation error:", formErr);
          I(`Form automation error: ${formErr.message}`);
          g = false;
          const isServerError = formErr?.message?.includes("INTERNAL_SERVER_ERROR_SKIP");
          if (!l) {
            try {
              await h(`?nik=eq.${encodeURIComponent(c)}`, "PARTIAL_DONE_PELAYANAN");
            } catch (e) {}
          }
          if (isServerError) {
            delete y[t];
            if (PTabId) chrome.tabs.remove(PTabId).catch(() => {});

            await updatePelayananInstanRecord(c, rec => {
              rec._status = "error";
              rec.status = "SERVER_ERROR";
              rec._errorMsg = "Internal Server Error (3x dilewati)";
            });

            await addPelayananPendingStatus({ nik: c, automationStatus: "error", recordStatus: "SERVER_ERROR" });

            chrome.runtime.sendMessage({
              type: "PELAYANAN_INSTAN_STATUS",
              nik: c,
              automationStatus: "error",
              recordStatus: "SERVER_ERROR",
              text: "Internal Server Error (3x dilewati)"
            }).catch(() => {});

            return { ok: true, earlyStatus: "SERVER_ERROR_SKIP" };
          }
        }

        delete y[t];
        if (PTabId) chrome.tabs.remove(PTabId).catch(() => {});

        const R = g ? "DONE_PELAYANAN" : "PARTIAL_DONE_PELAYANAN";
        console.log("[background] finalRecordStatus:", R, "| formAutomationSuccess:", g);

        await updatePelayananInstanRecord(c, rec => {
          rec._status = g ? "done" : "partial";
          rec.status = R;
        });

        await addPelayananPendingStatus({ nik: c, automationStatus: g ? "done" : "partial", recordStatus: R });

        chrome.runtime.sendMessage({
          type: "PELAYANAN_INSTAN_STATUS",
          nik: c,
          automationStatus: g ? "done" : "partial",
          recordStatus: R
        }).catch(() => {});

        return { ok: true };
      } catch (err) {
        console.error("[RUN_PELAYANAN_AUTOMATION] error:", err);
        delete y[t];
        if (PTabId) chrome.tabs.remove(PTabId).catch(() => {});

        if (!g && !l) {
          try {
            await h(`?nik=eq.${encodeURIComponent(c)}`, "PARTIAL_DONE_PELAYANAN");
          } catch (e) {}
        }

        const R = g ? "DONE_PELAYANAN" : "PARTIAL_DONE_PELAYANAN";

        await updatePelayananInstanRecord(c, rec => {
          rec._status = "error";
          rec.status = R;
          rec._errorMsg = err.message;
        });

        chrome.runtime.sendMessage({
          type: "PELAYANAN_INSTAN_STATUS",
          nik: c,
          automationStatus: "error",
          recordStatus: R,
          text: err.message
        }).catch(() => {});

        return { ok: false, error: err.message };
      }
    }

    case "PELAYANAN_INSTAN_STOP": {
      const { recordIndex: e } = s;
      const t = y[e];
      if (t) {
        t.abort();
        delete y[e];
      }
      const { pelayananQueue: q = [] } = await chrome.storage.session.get("pelayananQueue");
      const filteredQ = q.filter(j => j.recordIndex !== e);
      if (filteredQ.length !== q.length) {
        await chrome.storage.session.set({ pelayananQueue: filteredQ });
      }
      chrome.runtime.sendMessage({ type: "PELAYANAN_INSTAN_STATUS", recordIndex: e, automationStatus: "idle" }).catch(() => {});
      return { ok: true };
    }

    case "GET_STATE":
      return { running: !(!N), paused: N?._paused ?? false, progress: await M() };

    case "CKG_USER_ME": {
      const { data: e } = s;
      return await k({ instance: e?.instance ?? null, email: e?.email ?? null, name: e?.name ?? null }).catch(e => console.error("[CKG_USER_ME] updateUserCkgDetails error:", e)), { ok: true };
    }

    case "SIGN_IN":
      return { ok: true, session: await c() };

    case "SIGN_OUT":
      return await i(), { ok: true };

    case "VERIFY_DEVICE":
      return { ok: true, valid: await T() };

    case "PENDAFTARAN_START": {
      const { tabId: e, patient: a, patientIndex: n, delayMultiplier: o, skipKonfirmasiHadir: skipHadir } = s;
      await chrome.storage.session.set({ pendaftaranRunning: true });
      const r = new t({
        tabId: e,
        patient: a,
        patientIndex: n,
        delayMultiplier: o,
        category: a.category ?? "UMUM",
        skipKonfirmasiHadir: skipHadir,
        onStatus: async (e, t = null, errorMsg = null, extraData = {}) => {
          delete S[n];
          await chrome.storage.session.remove(`pendaftaranStop_${n}`).catch(() => {});
          const s = "stopped" === e ? "idle" : e;
          const { pendaftaranPatients: o } = await chrome.storage.session.get("pendaftaranPatients");
          if (void 0 !== o?.[n]) {
            o[n]._status = s;
            if (t) o[n]._nomorTiket = t;
            if (errorMsg) o[n]._errorMsg = errorMsg;
            if (extraData?.screeningDate) o[n]._screeningDate = extraData.screeningDate;
            if (extraData?.screeningFaskes) o[n]._screeningFaskes = extraData.screeningFaskes;
            if (extraData?.screeningLayanan) o[n]._screeningLayanan = extraData.screeningLayanan;
            if (extraData?.screeningDetail) o[n]._screeningDetail = extraData.screeningDetail;

            if (!o[n]._screeningDate && errorMsg) {
              const tm = errorMsg.match(/(?:tanggal(?:\s*pemeriksaan|\s*skrining|\s*layanan)?|tgl|date|pada)\s*[:\-]?\s*([0-9]{1,2}\s+[A-Za-z]+\s+[0-9]{4}|[0-9]{1,4}[\/\-][0-9]{1,2}[\/\-][0-9]{1,4})/i);
              if (tm) o[n]._screeningDate = tm[1].trim();
            }
            if (!o[n]._screeningFaskes && errorMsg) {
              const fm = errorMsg.match(/(?:puskesmas|faskes|fasilitas\s*kesehatan|klinik)(?:\s*pemeriksa)?\s*[:\-]?\s*([^\r\n,\)\.]+)/i);
              if (fm) o[n]._screeningFaskes = fm[1].trim();
            }
            if (!o[n]._screeningLayanan && errorMsg) {
              const lm = errorMsg.match(/layanan\s*[:\-]?\s*([^\r\n,\)\.]+)/i);
              if (lm) o[n]._screeningLayanan = lm[1].trim();
            }
            await chrome.storage.session.set({ pendaftaranPatients: o });
          }
          await chrome.storage.session.set({ pendaftaranRunning: false });
          chrome.runtime.sendMessage({ type: "PENDAFTARAN_STATUS", patientIndex: n, status: s, nomorTiket: t, errorMsg, ...extraData }).catch(() => {});
          if ("done" === e) {
            try {
              const patientData = o?.[n] || a;
              await u(patientData, t);
            } catch (e) {
              console.error("[Pendaftaran BG] insertPendaftaranRecord threw:", e);
            }
          }
        }
      });
      S[n] = r;
      r.run().catch(async e => {
        console.error("[Pendaftaran BG] unhandled error:", e);
        delete S[n];
        await chrome.storage.session.set({ pendaftaranRunning: false });
        chrome.runtime.sendMessage({ type: "PENDAFTARAN_STATUS", patientIndex: n, status: "error", errorMsg: e?.message || "Terjadi kesalahan" }).catch(() => {});
      });
      return { ok: true };
    }

    case "PENDAFTARAN_START_ALL": {
      const { tabId: e, patients: t, delayMultiplier: a, skipKonfirmasiHadir: skipHadir } = s;
      const allSession = await chrome.storage.session.get(null);
      const stopKeys = Object.keys(allSession).filter(k => k.startsWith("pendaftaranStop_"));
      if (stopKeys.length) {
        await chrome.storage.session.remove(stopKeys).catch(() => {});
      }
      isPendaftaranProcessing = false;
      const lightPatients = (t || []).map(item => {
        const idx = item.patientIndex !== undefined ? item.patientIndex : item;
        return { patientIndex: idx };
      });
      await chrome.storage.session.set({
        pendaftaranQueue: { tabId: e, patients: lightPatients, delayMultiplier: a, skipKonfirmasiHadir: skipHadir },
        pendaftaranRunning: true
      });
      await _();
      return { ok: true };
    }

    case "PENDAFTARAN_STOP": {
      const { patientIndex: e } = s;
      await chrome.storage.session.set({ [`pendaftaranStop_${e}`]: true });
      S[e]?.stop();
      setTimeout(async () => {
        if (!S[e]) return;
        delete S[e];
        const { pendaftaranQueue: t } = await chrome.storage.session.get("pendaftaranQueue");
        const a = (t?.patients ?? []).filter(item => (item.patientIndex !== undefined ? item.patientIndex : item) !== e);
        await chrome.storage.session.set({
          pendaftaranQueue: { tabId: t?.tabId, patients: a, delayMultiplier: t?.delayMultiplier, skipKonfirmasiHadir: t?.skipKonfirmasiHadir },
          pendaftaranRunning: a.length > 0
        });
        await chrome.storage.session.remove(`pendaftaranStop_${e}`).catch(() => {});
        const { pendaftaranPatients: n } = await chrome.storage.session.get("pendaftaranPatients");
        if (void 0 !== n?.[e]) {
          n[e]._status = "idle";
          await chrome.storage.session.set({ pendaftaranPatients: n });
        }
        chrome.runtime.sendMessage({ type: "PENDAFTARAN_STATUS", patientIndex: e, status: "idle" }).catch(() => {});
        isPendaftaranProcessing = false;
        _().catch(() => {});
      }, 3000);
      return { ok: true };
    }

    case "PENDAFTARAN_STOP_ALL": {
      isPendaftaranProcessing = false;
      for (const [e, t] of Object.entries(S)) {
        try { t.stop(); } catch (err) {}
        delete S[e];
      }
      const { pendaftaranQueue: e } = await chrome.storage.session.get("pendaftaranQueue");
      const t = e?.patients ?? [];
      for (const item of t) {
        const idx = item.patientIndex !== undefined ? item.patientIndex : item;
        chrome.runtime.sendMessage({ type: "PENDAFTARAN_STATUS", patientIndex: idx, status: "idle" }).catch(() => {});
      }
      const allSession = await chrome.storage.session.get(null);
      const stopKeys = Object.keys(allSession).filter(k => k.startsWith("pendaftaranStop_"));
      if (stopKeys.length) {
        await chrome.storage.session.remove(stopKeys).catch(() => {});
      }
      const { pendaftaranPatients: l } = await chrome.storage.session.get("pendaftaranPatients");
      if (Array.isArray(l)) {
        l.forEach(p => {
          if (p._status === "in-progress") p._status = "idle";
        });
        await chrome.storage.session.set({ pendaftaranPatients: l });
      }
      await chrome.storage.session.set({ pendaftaranQueue: { patients: [] }, pendaftaranRunning: false });
      chrome.runtime.sendMessage({ type: "PENDAFTARAN_ALL_STOPPED" }).catch(() => {});
      return { ok: true };
    }

    case "PENDAFTARAN_API_TEST": {
      const { rows = [], dryRun = true, delayMs = 1500 } = s;
      try {
        const CKG_URL = "https://sehatindonesiaku.kemkes.go.id";
        const getCkgTab = async () => {
          let tabs = await chrome.tabs.query({ url: `${CKG_URL}/*` }).catch(() => []);
          if (!tabs.length) {
            tabs = (await chrome.tabs.query({}).catch(() => [])).filter(
              t => typeof t.url === "string" && t.url.startsWith(CKG_URL)
            );
          }
          const validTabs = tabs.filter(t => typeof t.id === "number" && t.id >= 0);
          if (validTabs.length) {
            return (validTabs.find(t => t.status === "complete") ?? validTabs[0]).id;
          }
          const createdTab = await chrome.tabs.create({ url: `${CKG_URL}/`, active: false });
          await new Promise(resolve => {
            const listener = (tid, changeInfo) => {
              if (tid === createdTab.id && changeInfo.status === "complete") {
                chrome.tabs.onUpdated.removeListener(listener);
                resolve();
              }
            };
            chrome.tabs.onUpdated.addListener(listener);
            setTimeout(() => {
              chrome.tabs.onUpdated.removeListener(listener);
              resolve();
            }, 15000);
          });
          if (typeof createdTab?.id !== "number" || createdTab.id < 0) {
            throw new Error("Tidak bisa membuka tab CKG. Buka https://sehatindonesiaku.kemkes.go.id dan login dulu.");
          }
          return createdTab.id;
        };

        const tabId = await getCkgTab();
        if (typeof tabId !== "number" || tabId < 0) {
          throw new Error("Tab CKG tidak ditemukan. Buka https://sehatindonesiaku.kemkes.go.id di tab lain, login, lalu jalankan lagi.");
        }

        const userObj = await getCkgUser(tabId);
        const results = [];
        const resultMap = {};

        await chrome.storage.session.set({
          apiTestProgress: { running: true, total: rows.length, done: 0, results: {} }
        });

        for (let i = 0; i < rows.length; i++) {
          const res = await runPendaftaranApi(tabId, userObj, rows[i], { dryRun });
          results.push(res);
          resultMap[i] = res;

          await chrome.storage.session.set({
            apiTestProgress: {
              running: i < rows.length - 1,
              total: rows.length,
              done: i + 1,
              results: { ...resultMap }
            }
          });

          chrome.runtime.sendMessage({
            type: "PENDAFTARAN_API_PROGRESS",
            index: i,
            total: rows.length,
            result: res
          }).catch(() => {});

          if (i < rows.length - 1) {
            await new Promise(r => setTimeout(r, delayMs));
          }
        }

        await chrome.storage.session.set({
          apiTestProgress: {
            running: false,
            total: rows.length,
            done: rows.length,
            results: { ...resultMap }
          }
        });

        return { ok: true, results, dryRun };
      } catch (err) {
        await chrome.storage.session.set({
          apiTestProgress: { running: false, error: err.message }
        }).catch(() => {});
        return { ok: false, error: err.message };
      }
    }

    case "RUN_PELAYANAN_BULK": {
      const { jobs = [], concurrentLimit = 3 } = s;
      const limit = Math.max(1, Math.min(20, parseInt(concurrentLimit, 10) || 3));
      activePelayananWorkers = Object.keys(y).length;
      isDispatchingPelayanan = false;
      await chrome.storage.session.set({
        pelayananQueue: jobs,
        pelayananConcurrentLimit: limit,
        pelayananRunning: true,
        pelayananPaused: false
      });
      setTimeout(() => {
        dispatchPelayananQueue().catch(e => console.error("[RUN_PELAYANAN_BULK] queue error:", e));
      }, 50);
      return { ok: true };
    }

    case "RUN_ASIK_LIVE_BATCH": {
      const { jobs = [], concurrentLimit = 1 } = s;
      const limit = Math.max(1, Math.min(5, Number(concurrentLimit) || 1));
      asikLiveQueue = [...jobs];
      asikLiveRunning = true;
      asikLivePaused = false;
      activeAsikWorkers = 0;
      isDispatchingAsikLive = false;
      asikLiveAbortCtrl = new AbortController();
      await chrome.storage.session.set({
        pelayananRunning: true,
        pelayananPaused: false,
        asikLiveRunning: true,
        pelayananConcurrentLimit: limit
      });
      setTimeout(() => {
        dispatchAsikLiveQueue().catch(e => console.error("[RUN_ASIK_LIVE_BATCH] queue error:", e));
      }, 50);
      return { ok: true };
    }

    case "RUN_ASIK_LIVE_SINGLE": {
      const { patientRecord } = s;
      asikLiveQueue = [{ patientRecord }];
      asikLiveRunning = true;
      asikLivePaused = false;
      activeAsikWorkers = 0;
      isDispatchingAsikLive = false;
      asikLiveAbortCtrl = new AbortController();
      await chrome.storage.session.set({
        pelayananRunning: true,
        pelayananPaused: false,
        asikLiveRunning: true,
        pelayananConcurrentLimit: 1
      });
      setTimeout(() => {
        dispatchAsikLiveQueue().catch(e => console.error("[RUN_ASIK_LIVE_SINGLE] error:", e));
      }, 50);
      return { ok: true };
    }

    case "ASIK_LIVE_STOP": {
      asikLiveQueue = [];
      asikLiveRunning = false;
      asikLivePaused = false;
      if (asikLiveAbortCtrl) {
        try { asikLiveAbortCtrl.abort(); } catch (_) {}
      }
      await chrome.storage.session.set({
        pelayananRunning: false,
        pelayananPaused: false,
        asikLiveRunning: false
      });
      chrome.runtime.sendMessage({ type: "PELAYANAN_ALL_STOPPED" }).catch(() => {});
      return { ok: true };
    }

    case "RUN_DAFTAR_LAYANI_BATCH": {
      const { rows = [], category = "UMUM", screeningDate = "", delayMs = 1500, concurrentLimit = 1, dryRun = false } = s;
      daftarLayaniQueue = [...rows];
      daftarLayaniRunning = true;
      await chrome.storage.session.set({ daftarLayaniRunning: true });
      setTimeout(() => {
        dispatchDaftarLayaniQueue({ category, screeningDate, delayMs, concurrentLimit, dryRun }).catch(e => console.error("[RUN_DAFTAR_LAYANI_BATCH] error:", e));
      }, 50);
      return { ok: true };
    }

    case "DAFTAR_LAYANI_STOP": {
      daftarLayaniQueue = [];
      daftarLayaniRunning = false;
      if (daftarLayaniAbortCtrl) {
        try { daftarLayaniAbortCtrl.abort(); } catch (_) {}
      }
      await chrome.storage.session.set({ daftarLayaniRunning: false });
      return { ok: true };
    }

    case "SCAN_ASIK_LIVE_API": {
      try {
        const tabs = await chrome.tabs.query({ url: "*://sehatindonesiaku.kemkes.go.id/*" });
        const asikTab = tabs.find(t => t.url && t.url.includes("ckg-pelayanan")) || tabs[0];
        if (!asikTab) return { ok: false, error: "Tab web ASIK tidak ditemukan" };
        const ckgUser = await getCkgUser(asikTab.id);
        const isSchool = typeof s.isSchool === "boolean"
          ? s.isSchool
          : !!(asikTab.url && asikTab.url.includes("ckg-pelayanan-sekolah"));
        const patients = await fetchPendingPatientsApi(asikTab.id, {
          ckgUser,
          isSchool,
          includeBelum: s.includeBelum !== false,
          includeSedang: s.includeSedang !== false,
          screeningStartDate: s.screeningStartDate || null,
          screeningEndDate: s.screeningEndDate || null
        });
        return { ok: true, patients, isSchool };
      } catch (err) {
        console.error("[SCAN_ASIK_LIVE_API] error:", err);
        return { ok: false, error: err?.message || String(err) };
      }
    }

    case "PELAYANAN_API_RUN": {
      const tabs = await chrome.tabs.query({ url: "*://sehatindonesiaku.kemkes.go.id/*" });
      const asikTab = tabs.find(t => t.url && t.url.includes("ckg-pelayanan")) || tabs[0];
      if (!asikTab) return { ok: false, error: "Tab web ASIK tidak ditemukan" };
      const ckgUser = await getCkgUser(asikTab.id);
      const res = await runPelayananApi(asikTab.id, s.patient || {}, {
        ckgUser,
        regId: s.regId || null,
        ticketNumber: s.ticketNumber || null,
        isSchool: !!s.isSchool,
        screeningDate: s.screeningDate || null,
        dryRun: !!s.dryRun
      });
      return { ok: true, result: res };
    }

    case "PELAYANAN_PAUSE": {
      asikLivePaused = true;
      await chrome.storage.session.set({ pelayananPaused: true });
      chrome.runtime.sendMessage({ type: "PELAYANAN_PAUSED" }).catch(() => {});
      return { ok: true };
    }

    case "PELAYANAN_RESUME": {
      asikLivePaused = false;
      isDispatchingPelayanan = false;
      await chrome.storage.session.set({ pelayananPaused: false, pelayananRunning: true });
      chrome.runtime.sendMessage({ type: "PELAYANAN_RESUMED" }).catch(() => {});
      if (asikLiveRunning && asikLiveQueue.length > 0) {
        dispatchAsikLiveQueue().catch(e => console.error("[ASIK_LIVE_RESUME] error:", e));
      }
      dispatchPelayananQueue().catch(e => console.error("[PELAYANAN_RESUME] error:", e));
      return { ok: true };
    }

    case "PELAYANAN_STOP_ALL": {
      asikLiveQueue = [];
      asikLiveRunning = false;
      asikLivePaused = false;
      if (asikLiveAbortCtrl) {
        try { asikLiveAbortCtrl.abort(); } catch (_) {}
      }
      await chrome.storage.session.set({ pelayananQueue: [], pelayananRunning: false, pelayananPaused: false, asikLiveRunning: false });
      for (const [k, ctrl] of Object.entries(y)) {
        try { ctrl.abort(); } catch (e) {}
        delete y[k];
      }
      activePelayananWorkers = 0;
      isDispatchingPelayanan = false;
      chrome.runtime.sendMessage({ type: "PELAYANAN_ALL_STOPPED" }).catch(() => {});
      return { ok: true };
    }

    case "CKG_HEARTBEAT_PING": {
      const status = await pingCkgSession();
      return { ok: true, status };
    }

    case "CKG_HEARTBEAT_CONFIG": {
      const { enabled = true, interval = 2 } = s;
      const { ckg_config = {} } = await chrome.storage.local.get("ckg_config");
      const updatedConfig = { ...ckg_config, heartbeatEnabled: enabled, heartbeatInterval: interval };
      await chrome.storage.local.set({ ckg_config: updatedConfig });
      await setupHeartbeatAlarm(interval);
      return { ok: true, config: updatedConfig };
    }

    default:
      return { ok: false, error: "Unknown message type" };
  }
}

chrome.runtime.onMessage.addListener((e, t, a) => (
  D(e).then(a).catch(e => a({ ok: false, error: e.message })),
  true
));

chrome.runtime.onStartup.addListener(async () => {
  try {
    const { vpn_config } = await chrome.storage.local.get(["vpn_config"]);
    if (vpn_config?.enabled) {
      await setChromeProxy(vpn_config);
    }
  } catch (e) {}
  setupHeartbeatAlarm().catch(() => {});
  setTimeout(() => pingCkgSession().catch(() => {}), 3000);
});

chrome.runtime.onInstalled.addListener(async () => {
  try {
    const { vpn_config } = await chrome.storage.local.get(["vpn_config"]);
    if (vpn_config?.enabled) {
      await setChromeProxy(vpn_config);
    }
  } catch (e) {}
  setupHeartbeatAlarm().catch(() => {});
  setTimeout(() => pingCkgSession().catch(() => {}), 2000);
});