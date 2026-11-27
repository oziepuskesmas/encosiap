// Service Sinkronisasi ENCO Chrome Extension ke Web Portal ckgbankot.web.id & D1 SQLite Database
import { sanitizeName } from "./aiService.js";

const CKG_API_BASE = "https://ckgbankot.web.id";

/**
 * Mengambil daftar pegawai dari database ckgbankot untuk dropdown login
 * Menggunakan endpoint /api/users yang sudah aktif di ckgbankot.web.id
 */
export async function fetchEncoUsers() {
  try {
    // Coba ambil dari /api/users (endpoint live database ckgbankot)
    let res = await fetch(`${CKG_API_BASE}/api/users`, {
      method: "GET",
      headers: { "Content-Type": "application/json" }
    });

    if (!res.ok) {
      // Fallback ke /api/enco/users jika ada
      res = await fetch(`${CKG_API_BASE}/api/enco/users`, {
        method: "GET",
        headers: { "Content-Type": "application/json" }
      });
    }

    const data = await res.json();
    if (data.success && Array.isArray(data.data)) {
      const formatted = data.data.map(u => ({
        nama_user: u.nama_user,
        role: u.role || "Petugas",
        need_password: !!(u.password && String(u.password).trim() !== "")
      }));

      // Cache list users & credentials secara lokal
      await chrome.storage.local.set({
        enco_cached_users: formatted,
        enco_users_raw: data.data
      });

      return formatted;
    }
    throw new Error(data.error || "Format data pegawai tidak sesuai");
  } catch (err) {
    console.warn("fetchEncoUsers online error, reading cache:", err);
    const cached = await chrome.storage.local.get(["enco_cached_users"]);
    return cached.enco_cached_users || [];
  }
}

/**
 * Melakukan verifikasi login ke API ckgbankot
 */
export async function loginEnco(namaUser, password) {
  const cleanUser = (namaUser || "").trim();
  const cleanPass = (password || "").trim();

  try {
    // 1. Coba verifikasi via endpoint /api/enco/login
    const res = await fetch(`${CKG_API_BASE}/api/enco/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        nama_user: cleanUser,
        password: cleanPass
      })
    });

    if (res.ok) {
      const data = await res.json();
      if (data.success && data.user) {
        const userSession = {
          nama_user: data.user.nama_user,
          role: data.user.role || "Petugas",
          logged_at: new Date().toISOString()
        };
        await chrome.storage.local.set({ enco_user_session: userSession });
        return { success: true, user: userSession };
      }
      return { success: false, error: data.error || "Kombinasi pegawai / password salah" };
    }
  } catch (err) {
    console.warn("[ENCO Login] Server endpoint error, fallback to verified local check:", err);
  }

  // 2. Fallback verifikasi langsung terhadap database pegawai ckgbankot
  try {
    const local = await chrome.storage.local.get(["enco_users_raw"]);
    let rawList = local.enco_users_raw;

    if (!Array.isArray(rawList) || rawList.length === 0) {
      const fetchRes = await fetch(`${CKG_API_BASE}/api/users`);
      const resJson = await fetchRes.json();
      if (resJson.success && Array.isArray(resJson.data)) {
        rawList = resJson.data;
        await chrome.storage.local.set({ enco_users_raw: rawList });
      }
    }

    if (Array.isArray(rawList) && rawList.length > 0) {
      const targetUser = rawList.find(u => (u.nama_user || "").trim().toLowerCase() === cleanUser.toLowerCase());
      if (!targetUser) {
        return { success: false, error: `Pegawai ${cleanUser} tidak terdaftar di database!` };
      }

      const expectedPass = (targetUser.password || "").trim();
      if (expectedPass !== "" && cleanPass !== expectedPass) {
        return { success: false, error: "Kata Sandi Yang Anda Masukkan Salah!" };
      }

      const userSession = {
        nama_user: targetUser.nama_user,
        role: targetUser.role || "Petugas",
        logged_at: new Date().toISOString()
      };
      await chrome.storage.local.set({ enco_user_session: userSession });
      return { success: true, user: userSession };
    }
  } catch (fallbackErr) {
    return { success: false, error: `Verifikasi gagal: ${fallbackErr.message}` };
  }

  return { success: false, error: "Gagal memverifikasi login. Periksa koneksi internet." };
}

/**
 * Mengambil data sesi petugas yang sedang aktif login di ENCO
 */
export async function getLoggedEncoUser() {
  const data = await chrome.storage.local.get(["enco_user_session"]);
  return data.enco_user_session || null;
}

/**
 * Menghapus sesi login (Logout)
 */
export async function logoutEnco() {
  await chrome.storage.local.remove(["enco_user_session"]);
}

// Antrean batch sinkronisasi pasien untuk menghindari saturasi koneksi HTTP
let pendingPatientQueue = [];
let patientSyncTimer = null;

/**
 * Flush antrean sinkronisasi pasien ke server
 */
export async function flushPendingPatientSync() {
  if (patientSyncTimer) {
    clearTimeout(patientSyncTimer);
    patientSyncTimer = null;
  }
  if (!pendingPatientQueue.length) return;

  const batch = pendingPatientQueue.splice(0, 30);
  try {
    const resp = await fetch(`${CKG_API_BASE}/api/enco/sync-pasien`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(batch)
    });
    if (!resp.ok) {
      const errTxt = await resp.text().catch(() => "");
      console.warn("[ENCO Sync] sync-pasien HTTP", resp.status, errTxt.slice(0, 200));
    }
  } catch (err) {
    console.warn("[ENCO Sync] Gagal flush batch sync-pasien:", err);
  }

  if (pendingPatientQueue.length > 0) {
    patientSyncTimer = setTimeout(flushPendingPatientSync, 500);
  }
}

/**
 * Sinkronisasi data pasien (baik Sudah Terdaftar maupun Berhasil Didaftarkan / Selesai Pelayanan)
 * ke database Cloudflare D1 ckg_database (tabel enco_pasien) secara batched
 */
export async function syncPatientToCkgbankot(patientObj) {
  if (!patientObj || !patientObj.nik) return false;

  try {
    const cleanNik = String(patientObj.nik).replace(/\D/g, '').trim() || String(patientObj.nik).trim();
    if (!cleanNik) return false;

    const session = await getLoggedEncoUser();
    const payload = {
      nik: cleanNik,
      nama: sanitizeName(patientObj.nama || patientObj.name || ""),
      tanggal_lahir: String(patientObj.tanggal_lahir || patientObj.tanggallahir || patientObj.dob || patientObj.tgllahir || patientObj.lahir || "").trim(),
      jenis_kelamin: String(patientObj.jenis_kelamin || patientObj.jeniskelamin || patientObj.jk || patientObj.gender || "").trim(),
      status_pernikahan: String(patientObj.status_pernikahan || patientObj.statuspernikahan || patientObj.statusnikah || patientObj.nikah || "").trim(),
      pekerjaan: String(patientObj.pekerjaan || patientObj.job || "").trim(),
      provinsi: String(patientObj.provinsi || patientObj.province || "Jawa Barat").trim(),
      kab_kota: String(patientObj.kab_kota || patientObj.kabkota || patientObj.kota || patientObj.kabupaten || "Kab. Bandung").trim(),
      kecamatan: String(patientObj.kecamatan || patientObj.district || "Banjaran").trim(),
      kelurahan: String(patientObj.kelurahan || patientObj.desa || patientObj.subdistrict || "").trim(),
      alamat: String(patientObj.alamat || patientObj.detailalamat || patientObj.detaildomisili || patientObj.address || "").trim(),
      no_tiket: String(patientObj.no_tiket || patientObj.nomor_tiket || patientObj.ticket || "").trim(),
      kategori: String(patientObj.kategori || patientObj.category || "Umum").trim(),
      status_pendaftaran: String(patientObj.status_pendaftaran || "Sudah Terdaftar").trim(),
      status_pelayanan: String(patientObj.status_pelayanan || "Belum Pelayanan").trim(),
      tanggal_daftar: String(patientObj.tanggal_daftar || new Date().toISOString().split("T")[0]).trim(),
      tanggal_pelayanan: patientObj.tanggal_pelayanan || (patientObj.status_pelayanan === "Selesai Pelayanan" ? new Date().toISOString().split("T")[0] : ""),
      petugas_enco: session?.nama_user || "Petugas",
      faskes: "Puskesmas Banjaran Kota",
      raw_details: patientObj.raw_details || patientObj.details || null
    };

    pendingPatientQueue.push(payload);

    if (pendingPatientQueue.length >= 20) {
      flushPendingPatientSync().catch(() => {});
    } else if (!patientSyncTimer) {
      patientSyncTimer = setTimeout(flushPendingPatientSync, 2000);
    }

    return true;
  } catch (err) {
    console.error("Gagal syncPatientToCkgbankot:", err);
    return false;
  }
}

/**
 * Sinkronisasi log eksekusi bot otomasi ke tabel enco_logs di ckgbankot
 */
export async function syncLogToCkgbankot(logObj) {
  try {
    const session = await getLoggedEncoUser();
    const payload = {
      petugas: session?.nama_user || logObj.petugas || "Petugas",
      jenis_kegiatan: logObj.jenis_kegiatan || "Pendaftaran",
      total_pasien: Number(logObj.total_pasien) || 0,
      jumlah_berhasil: Number(logObj.jumlah_berhasil) || 0,
      jumlah_terdaftar: Number(logObj.jumlah_terdaftar) || 0,
      jumlah_gagal: Number(logObj.jumlah_gagal) || 0,
      status: logObj.status || "Selesai",
      keterangan: logObj.keterangan || ""
    };

    const res = await fetch(`${CKG_API_BASE}/api/enco/sync-log`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    const result = await res.json();
    return result.success === true;
  } catch (err) {
    console.error("Gagal syncLogToCkgbankot:", err);
    return false;
  }
}

/**
 * Mengambil antrean pasien/siswa yang siap dikerjakan oleh Bot ENCO dari ckgbankot
 * Filter ketat per akun petugas: hanya akun yang memasukkan antrean yang dapat menarik data ini
 * @param {string} jenis - 'UMUM' atau 'SEKOLAH'
 * @param {string} status - 'antre', 'pendaftaran', 'pelayanan', 'all'
 */
export async function fetchBotQueueFromCkgbankot(jenis = 'UMUM', status = 'antre') {
  try {
    const session = await getLoggedEncoUser();
    const petugas = (session?.nama_user || '').trim();

    if (!petugas) {
      return {
        success: false,
        error: "Anda belum login di Bot ENCO! Silakan login akun petugas Anda terlebih dahulu.",
        data: [],
        count: 0
      };
    }

    const url = new URL(`${CKG_API_BASE}/api/enco/queue`);
    if (jenis) url.searchParams.set('jenis', jenis.toUpperCase());
    if (status) url.searchParams.set('status', status);
    url.searchParams.set('petugas', petugas);

    const res = await fetch(url.toString(), {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' }
    });

    if (!res.ok) {
      throw new Error(`Server response: ${res.status} ${res.statusText}`);
    }

    const data = await res.json();
    if (data.success && Array.isArray(data.data)) {
      // Map return items to extract pre-formatted bot data object with queue metadata attached
      const mapped = data.data.map(item => {
        const payload = item.data || {};
        return {
          ...payload,
          _queue_id: item.id,
          _queue_record_id: item.record_id,
          _queue_jenis: item.jenis,
          _queue_petugas: item.petugas_antrean || petugas,
          _queue_status_pendaftaran: item.status_pendaftaran,
          _queue_status_pelayanan: item.status_pelayanan,
          nik: item.nik || payload.nik || payload.NIK,
          nama: sanitizeName(item.nama || payload.nama || payload.NAMA || ""),
          _status: "idle"
        };
      });
      return { success: true, count: mapped.length, data: mapped, summary: data.summary || {}, petugas: petugas };
    }
    throw new Error(data.error || 'Format antrean tidak sesuai');
  } catch (err) {
    console.error('[fetchBotQueueFromCkgbankot] Error:', err);
    return { success: false, error: err.message, data: [], count: 0 };
  }
}

/**
 * Memperbarui status antrean pasien di ckgbankot secara realtime
 * Dipanggil saat pendaftaran berhasil mendapatkan tiket atau pelayanan selesai
 */
export async function updateQueueStatusToCkgbankot({ nik, jenis, status_pendaftaran, status_pelayanan, no_tiket, keterangan }) {
  try {
    const cleanNik = String(nik || '').replace(/\D/g, '').trim();
    if (!cleanNik) return false;

    const session = await getLoggedEncoUser();
    const payload = {
      nik: cleanNik,
      jenis: jenis || 'UMUM',
      status_pendaftaran: status_pendaftaran || null,
      status_pelayanan: status_pelayanan || null,
      no_tiket: no_tiket || '',
      keterangan: keterangan || '',
      petugas: session?.nama_user || 'Petugas ENCO'
    };

    const res = await fetch(`${CKG_API_BASE}/api/enco/queue/update-status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const data = await res.json();
    return data.success === true;
  } catch (err) {
    console.warn('[updateQueueStatusToCkgbankot] Error:', err);
    return false;
  }
}

/**
 * Menghapus antrean dari ckgbankot
 */
export async function removeQueueItemFromCkgbankot(id) {
  try {
    const res = await fetch(`${CKG_API_BASE}/api/enco/queue/remove`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: id })
    });
    const data = await res.json();
    return data.success === true;
  } catch (err) {
    console.warn('[removeQueueItemFromCkgbankot] Error:', err);
    return false;
  }
}
