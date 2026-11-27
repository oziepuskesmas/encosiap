/**
 * historyService.js
 * Modul untuk mengelola Log History per akun petugas (Pendaftaran, Pasien, Pelayanan)
 * Terhubung ke Cloudflare R2 Storage (enco-storage) & ckgbankot.web.id
 */

const STORAGE_KEY = "enco_log_history";
const ACTIVE_LOG_PREFIX = "enco_active_log_";
const CKG_API_BASE = "https://ckgbankot.web.id";

const listeners = new Set();
const syncTimeoutMap = new Map();

/**
 * Mendapatkan storage key lokal yang terikat dengan akun petugas yang sedang login
 */
async function getAccountStorageKey() {
  try {
    const data = await chrome.storage.local.get(["enco_user_session"]);
    const user = data.enco_user_session?.nama_user;
    if (user && user.trim()) {
      const slug = user.toLowerCase().trim().replace(/[^a-z0-9]/g, "_");
      return `enco_log_history_${slug}`;
    }
  } catch (_) { }
  return STORAGE_KEY;
}

/**
 * Mendapatkan nama petugas yang sedang aktif login
 */
async function getCurrentPetugasName() {
  try {
    const data = await chrome.storage.local.get(["enco_user_session"]);
    return data.enco_user_session?.nama_user || "Petugas";
  } catch (_) {
    return "Petugas";
  }
}

/**
 * Jadwalkan sinkronisasi sesi ke Cloudflare R2 secara debounced
 */
function scheduleCloudR2Sync(menu, sessionObj) {
  if (!sessionObj || !sessionObj.id) return;
  const syncKey = `${menu}_${sessionObj.id}`;
  if (syncTimeoutMap.has(syncKey)) {
    clearTimeout(syncTimeoutMap.get(syncKey));
  }
  syncTimeoutMap.set(syncKey, setTimeout(async () => {
    syncTimeoutMap.delete(syncKey);
    try {
      const petugas = await getCurrentPetugasName();
      await fetch(`${CKG_API_BASE}/api/enco/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          petugas,
          menu,
          session: sessionObj
        })
      });
      console.log(`[historyService] Sesi ${sessionObj.id} berhasil disinkronkan ke Cloud R2 (${petugas})`);
    } catch (err) {
      console.warn("[historyService] Gagal sync sesi ke Cloud R2:", err);
    }
  }, 2500));
}

/**
 * Sinkronisasi penghapusan sesi dari Cloud R2
 */
async function syncSessionDeleteToCloud(menu, sessionId) {
  try {
    const petugas = await getCurrentPetugasName();
    await fetch(`${CKG_API_BASE}/api/enco/sessions?id=${encodeURIComponent(sessionId)}&petugas=${encodeURIComponent(petugas)}&menu=${encodeURIComponent(menu)}`, {
      method: "DELETE"
    });
  } catch (err) {
    console.warn("[historyService] Gagal hapus sesi dari Cloud R2:", err);
  }
}

// Throttle map untuk sinkronisasi dari Cloud R2 agar tidak flood request
const lastCloudFetchTimes = new Map();
let isCloudFetching = false;

/**
 * Sinkronisasi data sesi dari Cloud R2 ke penyimpanan lokal akun
 * Menjadikan ckgbankot Cloud R2 sebagai Single Source of Truth
 */
export async function syncCloudR2History(menu = "pendaftaran", force = false) {
  const now = Date.now();
  const lastTime = lastCloudFetchTimes.get(menu) || 0;
  if (!force && now - lastTime < 5000) {
    return; // Hindari request ganda dalam 5 detik
  }
  if (isCloudFetching) return;

  try {
    isCloudFetching = true;
    lastCloudFetchTimes.set(menu, now);

    const storageKey = await getAccountStorageKey();
    const petugas = await getCurrentPetugasName();
    if (!petugas || petugas === "Petugas") return;

    // Bersihkan legacy storage lokal yang usang agar tidak membingungkan
    chrome.storage.local.remove([STORAGE_KEY]).catch(() => { });

    const res = await fetch(`${CKG_API_BASE}/api/enco/sessions?petugas=${encodeURIComponent(petugas)}&menu=${encodeURIComponent(menu)}`);
    const data = await res.json();

    if (data.success && Array.isArray(data.data)) {
      const localData = await chrome.storage.local.get(storageKey);
      const allHist = localData[storageKey] || { pendaftaran: [], pasien: [], pelayanan: [] };

      // Gantikan seluruh daftar sesi menu ini dengan snapshot resmi dari ckgbankot Cloud R2
      allHist[menu] = data.data;

      // Ambil detail lengkap data pasien untuk sesi aktif / pertama jika diperlukan
      if (data.data.length > 0 && (!data.data[0].data || data.data[0].data.length === 0) && data.data[0].id) {
        try {
          const detailRes = await fetch(`${CKG_API_BASE}/api/enco/sessions/detail?id=${encodeURIComponent(data.data[0].id)}&petugas=${encodeURIComponent(petugas)}&menu=${encodeURIComponent(menu)}`);
          const detailData = await detailRes.json();
          if (detailData.success && detailData.session?.data && detailData.session.data.length > 0) {
            allHist[menu][0].data = detailData.session.data;
            const storageArea = chrome.storage?.session || chrome.storage?.local;
            if (menu === "pendaftaran") {
              storageArea.set({ pendaftaranPatients: detailData.session.data }).catch(() => { });
            } else if (menu === "pasien") {
              storageArea.set({ "pelayanan-instan-records": detailData.session.data }).catch(() => { });
            }
          }
        } catch (_) { }
      }

      await chrome.storage.local.set({ [storageKey]: allHist });
      notifyChange(menu, allHist[menu]);
      return allHist[menu];
    }
  } catch (err) {
    console.warn("[historyService] syncCloudR2History warning:", err);
  } finally {
    isCloudFetching = false;
  }
}

/**
 * Format timestamp ke format tanggal & waktu Indonesia
 * Contoh: "23/09/2026, 09:15"
 */
export function formatLogDate(timestamp = Date.now()) {
  const d = new Date(timestamp);
  const pad = n => String(n).padStart(2, "0");
  const day = pad(d.getDate());
  const month = pad(d.getMonth() + 1);
  const year = d.getFullYear();
  const hours = pad(d.getHours());
  const mins = pad(d.getMinutes());
  return `${day}/${month}/${year}, ${hours}:${mins}`;
}

/**
 * Mengambil seluruh riwayat untuk menu tertentu ("pendaftaran" | "pasien" | "pelayanan")
 * Bridging langsung dengan Cloud R2 ckgbankot sebagai sumber kebenaran utama
 */
export async function getHistory(menu) {
  try {
    const storageKey = await getAccountStorageKey();
    const petugas = await getCurrentPetugasName();

    // Hapus penyimpanan legacy lama agar riwayat lokal usang hilang sepenuhnya
    chrome.storage.local.remove([STORAGE_KEY]).catch(() => { });

    // Bridging online ke ckgbankot Cloud R2
    if (petugas && petugas !== "Petugas") {
      try {
        const res = await fetch(`${CKG_API_BASE}/api/enco/sessions?petugas=${encodeURIComponent(petugas)}&menu=${encodeURIComponent(menu)}`);
        const data = await res.json();
        if (data.success && Array.isArray(data.data)) {
          const localData = await chrome.storage.local.get(storageKey);
          const allHist = localData[storageKey] || { pendaftaran: [], pasien: [], pelayanan: [] };
          allHist[menu] = data.data;
          await chrome.storage.local.set({ [storageKey]: allHist });
          return data.data;
        }
      } catch (netErr) {
        console.warn("[historyService] Bridging cloud gagal, beralih ke cache lokal:", netErr);
      }
    }

    // Fallback jika offline
    const res = await chrome.storage.local.get(storageKey);
    const allHistory = res[storageKey] || {};
    if (menu) {
      return allHistory?.[menu] || [];
    }
    return allHistory || {};
  } catch (err) {
    console.error("[historyService] Gagal membaca riwayat:", err);
    return menu ? [] : {};
  }
}

/**
 * Menambahkan entri log baru ke menu tertentu
 * @param {"pendaftaran" | "pasien" | "pelayanan"} menu
 * @param {Object} entryData
 * @returns {Promise<Object>} Entri log yang baru dibuat
 */
export async function addLogEntry(menu, entryData) {
  try {
    const storageKey = await getAccountStorageKey();
    const res = await chrome.storage.local.get(storageKey);
    const allHistory = res[storageKey] || { pendaftaran: [], pasien: [], pelayanan: [] };
    if (!allHistory[menu]) allHistory[menu] = [];

    const now = Date.now();
    const newEntry = {
      id: `log_${menu}_${now}_${Math.random().toString(36).slice(2, 6)}`,
      menu,
      timestamp: now,
      dateStr: formatLogDate(now),
      fileName: entryData.fileName || "Input Manual",
      category: entryData.category || "UMUM",
      total: entryData.total || 0,
      berhasil: entryData.berhasil || 0,
      gagal: entryData.gagal || 0,
      sebagian: entryData.sebagian || 0,
      pernahInput: entryData.pernahInput || 0,
      status: entryData.status || "idle", // "idle" | "running" | "completed" | "paused"
      data: entryData.data || [] // snapshot data antrean / pasien
    };

    allHistory[menu].unshift(newEntry);
    if (allHistory[menu].length > 30) {
      allHistory[menu] = allHistory[menu].slice(0, 30);
    }

    await chrome.storage.local.set({ [storageKey]: allHistory });
    await setActiveLogId(menu, newEntry.id);
    notifyChange(menu, allHistory[menu]);

    // Sinkronisasikan ke Cloudflare R2
    scheduleCloudR2Sync(menu, newEntry);

    return newEntry;
  } catch (err) {
    console.error("[historyService] Gagal menambahkan log:", err);
    return null;
  }
}

/**
 * Memperbarui data statistik / status pada entri log yang ada
 * @param {"pendaftaran" | "pasien" | "pelayanan"} menu
 * @param {string} logId
 * @param {Object} updates { berhasil, gagal, sebagian, total, status, data }
 */
export async function updateLogEntry(menu, logId, updates) {
  if (!logId) return null;
  try {
    const storageKey = await getAccountStorageKey();
    const res = await chrome.storage.local.get(storageKey);
    const allHistory = res[storageKey] || {};
    const list = allHistory[menu] || [];

    const idx = list.findIndex(item => item.id === logId);
    if (idx === -1) return null;

    const current = list[idx];
    const updated = {
      ...current,
      ...updates,
      lastUpdated: Date.now()
    };

    if (updated.total > 0 && (updated.berhasil + updated.gagal + updated.sebagian + (updated.pernahInput || 0)) >= updated.total) {
      if (updated.gagal > 0) {
        updated.status = "has-error";
      } else {
        updated.status = "completed";
      }
    }

    list[idx] = updated;
    allHistory[menu] = list;

    await chrome.storage.local.set({ [storageKey]: allHistory });
    notifyChange(menu, list);

    // Sinkronisasi pembaruan ke Cloudflare R2
    scheduleCloudR2Sync(menu, updated);

    return updated;
  } catch (err) {
    console.error("[historyService] Gagal memperbarui log:", err);
    return null;
  }
}

/**
 * Memperbarui log aktif saat ini jika ada
 */
export async function updateActiveLog(menu, updates) {
  const activeId = await getActiveLogId(menu);
  if (!activeId) return null;
  return updateLogEntry(menu, activeId, updates);
}

/**
 * Menghapus satu entri log berdasarkan id
 */
export async function deleteLogEntry(menu, logId) {
  try {
    const storageKey = await getAccountStorageKey();
    const res = await chrome.storage.local.get(storageKey);
    const allHistory = res[storageKey] || {};
    if (!allHistory[menu]) return false;

    allHistory[menu] = allHistory[menu].filter(item => item.id !== logId);
    await chrome.storage.local.set({ [storageKey]: allHistory });

    const activeId = await getActiveLogId(menu);
    if (activeId === logId || !allHistory[menu].length || activeId === "none") {
      await setActiveLogId(menu, "none");

      // Bersihkan antrean lokal agar tidak nyangkut di Laporan Status atau Antrean Bot
      if (menu === "pendaftaran") {
        await chrome.storage?.session?.remove(["pendaftaranPatients", "pendaftaranQueue", "pendaftaranRunning"]).catch(() => {});
        await chrome.storage?.local?.remove(["pendaftaranPatients", "pendaftaranQueue"]).catch(() => {});
      } else if (menu === "pasien") {
        await chrome.storage?.session?.remove(["pelayanan-instan-records", "pelayananRunning", "pelayananInstanPendingStatuses"]).catch(() => {});
        await chrome.storage?.local?.remove(["pelayanan-instan-records"]).catch(() => {});
      } else if (menu === "pelayanan") {
        await chrome.storage?.session?.remove(["pelayananExcelPatients", "otomasiRunning"]).catch(() => {});
        await chrome.storage?.local?.remove(["pelayananExcelPatients"]).catch(() => {});
      }
    }

    notifyChange(menu, allHistory[menu]);

    // Hapus juga dari Cloud R2 & Database D1
    await syncSessionDeleteToCloud(menu, logId);

    return true;
  } catch (err) {
    console.error("[historyService] Gagal menghapus log:", err);
    return false;
  }
}

/**
 * Mengosongkan seluruh riwayat untuk menu tertentu
 */
export async function clearHistory(menu) {
  try {
    const storageKey = await getAccountStorageKey();
    const res = await chrome.storage.local.get(storageKey);
    const allHistory = res[storageKey] || {};
    allHistory[menu] = [];
    await chrome.storage.local.set({ [storageKey]: allHistory });
    await setActiveLogId(menu, "none");

    // Bersihkan juga seluruh antrean lokal
    if (menu === "pendaftaran") {
      await chrome.storage?.session?.remove(["pendaftaranPatients", "pendaftaranQueue", "pendaftaranRunning"]).catch(() => {});
      await chrome.storage?.local?.remove(["pendaftaranPatients", "pendaftaranQueue"]).catch(() => {});
    } else if (menu === "pasien") {
      await chrome.storage?.session?.remove(["pelayanan-instan-records", "pelayananRunning", "pelayananInstanPendingStatuses"]).catch(() => {});
      await chrome.storage?.local?.remove(["pelayanan-instan-records"]).catch(() => {});
    } else if (menu === "pelayanan") {
      await chrome.storage?.session?.remove(["pelayananExcelPatients", "otomasiRunning"]).catch(() => {});
      await chrome.storage?.local?.remove(["pelayananExcelPatients"]).catch(() => {});
    }

    notifyChange(menu, []);
    return true;
  } catch (err) {
    console.error("[historyService] Gagal mengosongkan riwayat:", err);
    return false;
  }
}

/**
 * Menyimpan ID log aktif untuk menu (disimpan di local & session)
 */
export async function setActiveLogId(menu, logId) {
  try {
    const key = `${ACTIVE_LOG_PREFIX}${menu}`;
    const val = logId || "none";
    const sessionStore = chrome.storage?.session || chrome.storage?.local;
    await Promise.all([
      chrome.storage?.local?.set({ [key]: val }).catch(() => { }),
      sessionStore?.set({ [key]: val }).catch(() => { })
    ]);
  } catch (err) {
    console.error("[historyService] Gagal set active log ID:", err);
  }
}

/**
 * Mendapatkan ID log aktif untuk menu
 */
export async function getActiveLogId(menu) {
  try {
    const key = `${ACTIVE_LOG_PREFIX}${menu}`;
    const sessionStore = chrome.storage?.session || chrome.storage?.local;
    const [localRes, sessionRes] = await Promise.all([
      chrome.storage?.local?.get(key).catch(() => ({})),
      sessionStore?.get(key).catch(() => ({}))
    ]);
    const id = localRes?.[key] || sessionRes?.[key] || null;
    if (id === "none") return null;
    if (id) return id;

    // Fallback awal: jika key belum pernah diset di storage sama sekali
    if (localRes?.[key] === undefined && sessionRes?.[key] === undefined) {
      const list = await getHistory(menu);
      if (list && list.length > 0) {
        const fallbackId = list[0].id;
        await setActiveLogId(menu, fallbackId);
        return fallbackId;
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Listener untuk memantau perubahan riwayat
 */
export function onHistoryChange(callback) {
  listeners.add(callback);
  return () => listeners.delete(callback);
}

function notifyChange(menu, list) {
  listeners.forEach(cb => {
    try {
      cb(menu, list);
    } catch (err) {
      console.error("[historyService] Error in change listener:", err);
    }
  });
}

// Pantau perubahan storage agar background & popup selalu sinkron secara realtime
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local") {
    // Jika sesi login petugas berganti, muat riwayat akun baru dari storage lokal
    if (changes["enco_user_session"]) {
      for (const menu of ["pendaftaran", "pasien", "pelayanan"]) {
        getHistory(menu).then(list => notifyChange(menu, list)).catch(() => { });
      }
      return;
    }

    // Jika terjadi update pada history log akun aktif, langsung dispatch nilai barunya tanpa storage write
    for (const key of Object.keys(changes)) {
      if (key.startsWith("enco_log_history")) {
        const newVal = changes[key].newValue;
        if (newVal && typeof newVal === "object") {
          for (const menu of ["pendaftaran", "pasien", "pelayanan"]) {
            if (Array.isArray(newVal[menu])) {
              notifyChange(menu, newVal[menu]);
            }
          }
        }
        break;
      }
    }
  }
});

/**
 * Export seluruh log history ke file JSON yang dapat diunduh
 */
export async function exportHistoryData() {
  try {
    const res = await chrome.storage.local.get(STORAGE_KEY);
    const allHistory = res[STORAGE_KEY] || { pendaftaran: [], pasien: [], pelayanan: [] };

    const exportPayload = {
      app: "ENCO",
      type: "LOG_HISTORY",
      version: "1.0",
      exportedAt: new Date().toISOString(),
      history: allHistory
    };

    const blob = new Blob([JSON.stringify(exportPayload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const dateStr = new Date().toISOString().slice(0, 10);
    const link = document.createElement("a");
    link.href = url;
    link.download = `ENCO_Log_History_${dateStr}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return true;
  } catch (err) {
    console.error("[historyService] Gagal export riwayat:", err);
    throw err;
  }
}

/**
 * Import log history dari file JSON string
 * @param {string} jsonString
 * @param {boolean} merge If true, merges with existing entries without duplicating by ID
 */
export async function importHistoryData(jsonString, merge = true) {
  try {
    const parsed = JSON.parse(jsonString);
    const importedHistory = parsed.history || parsed;

    if (!importedHistory || typeof importedHistory !== "object") {
      throw new Error("Format file JSON tidak valid. Pastikan file adalah hasil export riwayat ENCO.");
    }

    const res = await chrome.storage.local.get(STORAGE_KEY);
    const current = res[STORAGE_KEY] || { pendaftaran: [], pasien: [], pelayanan: [] };
    const updated = { ...current };

    let totalImported = 0;
    const menus = ["pendaftaran", "pasien", "pelayanan"];

    for (const menu of menus) {
      const incoming = importedHistory[menu];
      if (!Array.isArray(incoming)) continue;

      if (!merge) {
        updated[menu] = incoming;
        totalImported += incoming.length;
      } else {
        const existingList = updated[menu] || [];
        const existingIds = new Set(existingList.map(item => item.id));
        const newItems = incoming.filter(item => !existingIds.has(item.id));
        const combined = [...newItems, ...existingList]
          .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
          .slice(0, 40);
        updated[menu] = combined;
        totalImported += newItems.length;
      }
    }

    await chrome.storage.local.set({ [STORAGE_KEY]: updated });

    menus.forEach(menu => {
      notifyChange(menu, updated[menu] || []);
    });

    return { success: true, count: totalImported };
  } catch (err) {
    console.error("[historyService] Gagal import riwayat:", err);
    throw err;
  }
}

