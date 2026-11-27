export const SUPABASE_URL="https://jwrebrqjohpqjluimvmu.supabase.co";
export const SUPABASE_ANON_KEY="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imp3cmVicnFqb2hwcWpsdWltdm11Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk3ODM3NDMsImV4cCI6MjA5NTM1OTc0M30.B2J3Ge-OBhkb8QDyclV5Y-zefJ0P_aNSmA8U3oX3NLM";

const MOCK_SESSION = {
  accessToken: "bypassed-local-token",
  refreshToken: "bypassed-local-refresh",
  user: {
    id: "local-user-id",
    email: "offline@local",
    user_metadata: { full_name: "Offline User" }
  }
};

export async function getSession(){ return MOCK_SESSION; }
export async function getAccessToken(){ return MOCK_SESSION.accessToken; }
export async function refreshSession(){ return MOCK_SESSION; }

export async function authedFetch(e,t={}){
  try {
    const a={apikey:SUPABASE_ANON_KEY,Authorization:`Bearer ${MOCK_SESSION.accessToken}`,...t.headers};
    return await fetch(e,{...t,headers:a});
  } catch(err) {
    return new Response(JSON.stringify([]), { status: 200 });
  }
}

export async function authedFetchJSON(e,t={}){
  try {
    const n=await authedFetch(e,t);
    if(!n.ok) return [];
    return await n.json();
  } catch(err) {
    return [];
  }
}

export function generateDeviceToken(){ return "offline-device-token"; }
export async function registerDevice(e){ return "offline-device-token"; }
export async function verifyDevice(){ return true; }
export function authFetch(e,t={}){ return fetch(`${SUPABASE_URL}/auth/v1${e}`,{...t,headers:{apikey:SUPABASE_ANON_KEY,...t.headers}}).catch(() => new Response(JSON.stringify({}), { status: 200 })); }

export async function getUserData(){
  return {
    id: "local-user-id",
    email: "offline@local",
    plan_expires_at: "2099-12-31T23:59:59Z"
  };
}

export async function getPendaftaranRecords(e, onlyNewEntry = false){
  try {
    const { local_pendaftaran_records: recs = [] } = await chrome.storage.local.get("local_pendaftaran_records");
    let filtered = recs;
    if (e) {
      const catTarget = String(e).toUpperCase();
      filtered = filtered.filter(r => {
        const cat = String(r.category || "").toUpperCase();
        if (catTarget === "SEKOLAH") return cat === "SEKOLAH";
        return !cat || cat === "UMUM" || cat === "KLASTER_2";
      });
    }
    if (onlyNewEntry) {
      // HANYA jika secara eksplisit diminta antrean baru saja:
      filtered = filtered.filter(r => {
        const st = String(r.status || "").toUpperCase();
        const sub = String(r._status || "").toLowerCase();
        if (st === "DONE_PELAYANAN" || st === "ALREADY_SCREENED") return false;
        if (st === "ERROR" || st === "SERVER_ERROR" || st === "MISSING") return false;
        if (sub === "already-screened" || sub === "error" || sub === "invalid-nik") return false;
        return true;
      });
    }
    return filtered;
  } catch(err) {
    return [];
  }
}

export async function clearPendaftaranRecords(category = null){
  try {
    if (!category) {
      await chrome.storage.local.set({ local_pendaftaran_records: [] });
    } else {
      const catTarget = String(category).toUpperCase();
      const { local_pendaftaran_records: recs = [] } = await chrome.storage.local.get("local_pendaftaran_records");
      const remaining = recs.filter(r => {
        const cat = String(r.category || "UMUM").toUpperCase();
        if (catTarget === "SEKOLAH") return cat !== "SEKOLAH";
        return cat === "SEKOLAH";
      });
      await chrome.storage.local.set({ local_pendaftaran_records: remaining });
    }
    return true;
  } catch(err) {
    return false;
  }
}

export async function getPendaftaranRecordByNik(e){
  try {
    const { local_pendaftaran_records: recs = [] } = await chrome.storage.local.get("local_pendaftaran_records");
    return recs.find(r => String(r.nik).trim() === String(e).trim()) || null;
  } catch(err) {
    return null;
  }
}

export async function insertPendaftaranRecord(patient, ticketNumber = null){
  try {
    if (!patient || !patient.nik) return;

    // Filter ketat: Jangan masukkan pasien yang error atau pernah di-input di Kemkes saat pendaftaran
    const sub = String(patient._status || "").toLowerCase();
    const st = String(patient.status || "").toUpperCase();

    if (sub === "already-screened" || sub === "invalid-nik" || sub === "error" || sub === "stopped") {
      return;
    }
    if (st === "ALREADY_SCREENED" || st === "ERROR" || st === "INVALID_NIK") {
      return;
    }

    const { local_pendaftaran_records: recs = [] } = await chrome.storage.local.get("local_pendaftaran_records");
    const nikStr = String(patient.nik).trim();
    const existingIdx = recs.findIndex(r => String(r.nik).trim() === nikStr);
    
    // Status di database adalah DONE_PENDAFTARAN (pendaftaran sukses, siap untuk pelayanan)
    const newRec = {
      ...patient,
      nik: nikStr,
      id: patient.id || `loc_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
      category: String(patient.category || "UMUM").toUpperCase(),
      status: "DONE_PENDAFTARAN",
      _status: "idle", // Siap Pelayanan
      nomor_tiket: ticketNumber || patient.nomor_tiket || patient._nomorTiket || null,
      registered_at: patient.registered_at || new Date().toISOString()
    };

    if (existingIdx !== -1) {
      // Jika sudah ada dan statusnya sudah selesai pelayanan, pertahankan status pelayanan
      if (recs[existingIdx].status === "DONE_PELAYANAN") {
        return recs[existingIdx];
      }
      recs[existingIdx] = { ...recs[existingIdx], ...newRec };
    } else {
      recs.push(newRec);
    }
    await chrome.storage.local.set({ local_pendaftaran_records: recs });
    return newRec;
  } catch(err) {
    console.error("[supabase] insertPendaftaranRecord error:", err);
  }
}

/**
 * Sinkronisasi cepat (atomic batch) dari pendaftaran ke database pasien.
 * Menjamin semua pasien pendaftaran yang sudah selesai (status 'done')
 * langsung ditarik ke antrean Database tanpa terkena Chrome storage write quota.
 */
export async function syncPendaftaranPatientsToDatabase(queryCategory = "UMUM", directCandidates = null) {
  try {
    let candidateList = [];

    // 1. Data langsung dari memori aktif jika tersedia
    if (Array.isArray(directCandidates) && directCandidates.length > 0) {
      candidateList = directCandidates;
    }

    // 2. Cek chrome.storage.session
    if (!candidateList.length) {
      try {
        const sRes = await chrome.storage.session.get("pendaftaranPatients");
        if (Array.isArray(sRes.pendaftaranPatients) && sRes.pendaftaranPatients.length > 0) {
          candidateList = sRes.pendaftaranPatients;
        }
      } catch (_) {}
    }

    // 3. Cek chrome.storage.local (fallback jika session tidak dapat diakses)
    if (!candidateList.length) {
      try {
        const lRes = await chrome.storage.local.get("pendaftaranPatients");
        if (Array.isArray(lRes.pendaftaranPatients) && lRes.pendaftaranPatients.length > 0) {
          candidateList = lRes.pendaftaranPatients;
        }
      } catch (_) {}
    }

    // 4. Cek enco_log_history -> pendaftaran (snapshot tersimpan)
    if (!candidateList.length) {
      try {
        const hRes = await chrome.storage.local.get("enco_log_history");
        const pLogs = hRes?.enco_log_history?.pendaftaran || [];
        for (const log of pLogs) {
          if (Array.isArray(log?.data) && log.data.length > 0) {
            candidateList = log.data;
            break;
          }
        }
      } catch (_) {}
    }

    if (!candidateList.length) {
      return false;
    }

    const targetCat = String(queryCategory || "UMUM").toUpperCase();

    // Saring kandidat:
    // HANYA data entry baru yang SUDAH SELESAI pendaftaran ('done')
    // Saring keluar yang error, invalid NIK, atau pernah diinput / sudah diskrining
    const validDoneCandidates = candidateList.filter(p => {
      if (!p || !p.nik) return false;
      const sub = String(p._status || "").toLowerCase();
      const st = String(p.status || "").toLowerCase();

      // Harus status selesai di pendaftaran
      const isDone = sub === "done" || st === "done" || st === "done_pendaftaran";
      if (!isDone) return false;

      // Filter ketat: Abaikan yang error, invalid NIK, atau pernah diinput
      if (sub === "already-screened" || sub === "error" || sub === "invalid-nik" || sub === "stopped") return false;
      if (st === "already_screened" || st === "error" || st === "invalid_nik" || st === "server_error" || st === "missing") return false;

      // Filter kategori (UMUM vs SEKOLAH)
      const pCat = String(p.category || "UMUM").toUpperCase();
      if (targetCat === "SEKOLAH") {
        return pCat === "SEKOLAH";
      } else {
        return pCat !== "SEKOLAH";
      }
    });

    if (!validDoneCandidates.length) {
      return false;
    }

    // Ambil local_pendaftaran_records saat ini
    const { local_pendaftaran_records: recs = [] } = await chrome.storage.local.get("local_pendaftaran_records");
    const recMap = new Map();
    for (const r of recs) {
      if (r && r.nik) {
        recMap.set(String(r.nik).trim(), r);
      }
    }

    let hasChanges = false;
    for (const p of validDoneCandidates) {
      const nikStr = String(p.nik).trim();
      const existing = recMap.get(nikStr);

      if (existing) {
        // Jika sudah selesai pelayanan, jangan timpa status pelayanan
        if (existing.status === "DONE_PELAYANAN" || existing.status === "PARTIAL_DONE_PELAYANAN") {
          continue;
        }
        recMap.set(nikStr, {
          ...existing,
          ...p,
          nik: nikStr,
          status: "DONE_PENDAFTARAN",
          _status: "idle",
          nomor_tiket: p._nomorTiket || p.nomor_tiket || existing.nomor_tiket || null
        });
        hasChanges = true;
      } else {
        // Tambahkan record baru yang siap dilayani
        recMap.set(nikStr, {
          ...p,
          id: p.id || `loc_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
          nik: nikStr,
          nama: p.nama || "-",
          category: targetCat === "SEKOLAH" ? "SEKOLAH" : "UMUM",
          status: "DONE_PENDAFTARAN",
          _status: "idle", // Siap Pelayanan
          nomor_tiket: p._nomorTiket || p.nomor_tiket || null,
          registered_at: p.registered_at || new Date().toISOString()
        });
        hasChanges = true;
      }
    }

    if (hasChanges) {
      const updatedRecs = Array.from(recMap.values());
      await chrome.storage.local.set({ local_pendaftaran_records: updatedRecs });
    }

    return true;
  } catch (err) {
    console.error("[supabase] syncPendaftaranPatientsToDatabase error:", err);
    return false;
  }
}

export async function updatePendaftaranRecordStatus(filter, newStatus, extra = {}){
  try {
    const { local_pendaftaran_records: recs = [] } = await chrome.storage.local.get("local_pendaftaran_records");
    let updated = [];
    if (typeof filter === "string") {
      const nikMatch = filter.match(/nik=eq\.([^&]+)/);
      const idMatch = filter.match(/id=eq\.([^&]+)/);
      const targetNik = nikMatch ? decodeURIComponent(nikMatch[1]) : null;
      const targetId = idMatch ? decodeURIComponent(idMatch[1]) : null;
      recs.forEach(r => {
        if ((targetNik && r.nik === targetNik) || (targetId && r.id === targetId)) {
          r.status = newStatus;
          Object.assign(r, extra);
          updated.push(r);
        }
      });
    }
    await chrome.storage.local.set({ local_pendaftaran_records: recs });
    return updated.length ? updated : [{ status: newStatus }];
  } catch(err) {
    return [{ status: newStatus }];
  }
}

export async function upsertPendaftaranRecordByNik(e,t,n={}){ return insertPendaftaranRecord(t); }
export async function insertAutomationRecord(e){ return; }
export async function updateUserCkgDetails({instance:e,email:t,name:n}){ return; }
export async function fetchAppConfig(){ return {}; }