/**
 * reportService.js
 * Modul untuk menghasilkan laporan status keberhasilan dan rincian error otomasi
 * (Pendaftaran, Pasien / Pelayanan Instan, Pelayanan CKG Utama).
 */

import { getHistory, getActiveLogId, setActiveLogId, formatLogDate } from "./historyService.js";

const CKG_API_BASE = "https://ckgbankot.web.id";

/**
 * Mendapatkan keterangan / alasan error yang ramah dan jelas
 */
export function getHumanReason(status, item = {}) {
  const customMsg = item._errorMsg || item.error || item.message || item._reason || item.reason;
  const statusStr = String(status || item._status || item.status || "").toLowerCase();
  const dbStatus = String(item.status || "").toUpperCase();

  if (statusStr === "invalid-nik" || dbStatus === "INVALID_NIK") {
    if (customMsg && !customMsg.toLowerCase().includes("tidak valid")) {
      return customMsg;
    }
    const nik = String(item.nik || "").trim();
    if (nik && nik.length !== 16) {
      return `Panjang NIK (${nik.length} digit) tidak sesuai standar. NIK harus tepat 16 digit.`;
    }
    return "Data NIK tidak valid di sistem Kemenkes atau data identitas Dukcapil tidak cocok.";
  }

  if (statusStr === "already-screened" || statusStr === "already_screened" || dbStatus === "ALREADY_SCREENED") {
    let tgl = item._screeningDate || item.screening_date || item.screeningDate || item.tanggal_pemeriksaan || item.tanggal_skrining || item.tanggal_daftar || item.tanggal_pelayanan || item.tanggal || (item.raw && (item.raw.screening_date || item.raw.tanggal_pemeriksaan || item.raw.tanggal_daftar)) || "";
    let faskes = item._screeningFaskes || item.screening_faskes || item.screeningFaskes || item.faskes || item.faskes_pemeriksa || item.puskesmas || (item.raw && (item.raw.faskes || item.raw.puskesmas)) || "";
    let layanan = item._screeningLayanan || item.screening_layanan || item.screeningLayanan || item.layanan || (item.raw && item.raw.layanan) || "";
    let detail = item._screeningDetail || item.screening_detail || "";

    // Bersihkan faskes dan layanan jika tercemar bug penangkapan sebelumnya
    if (/whatsapp|notifikasi/i.test(faskes)) faskes = "";
    if (/selesai\s*diperiksa|menerima\s*layanan/i.test(layanan)) layanan = "";

    if (!tgl && customMsg) {
      const tm = customMsg.match(/(?:tanggal(?:\s*pemeriksaan|\s*skrining|\s*layanan)?|tgl|date|pada)\s*[:\-]?\s*([0-9]{1,2}\s+[A-Za-z]+\s+[0-9]{4}|[0-9]{1,4}[\/\-][0-9]{1,2}[\/\-][0-9]{1,4})/i);
      if (tm) tgl = tm[1].trim();
    }
    if (!faskes && customMsg) {
      const fm = customMsg.match(/puskesmas\s*pemeriksa\s*[:\-]\s*([^\r\n,\)\.]+)/i) ||
                 customMsg.match(/(?:puskesmas|faskes|fasilitas\s*kesehatan|klinik)\s*pemeriksa\s*[:\-]\s*([^\r\n,\)\.]+)/i) ||
                 customMsg.match(/puskesmas\s*[:\-]\s*([^\r\n,\)\.]+)/i);
      if (fm && !/whatsapp|notifikasi|rapor|ssm/i.test(fm[1].trim())) {
        faskes = fm[1].trim();
      }
    }
    if (!layanan && customMsg) {
      const lm = customMsg.match(/(?:^|[\r\n\(])\s*layanan\s*[:\-]\s*([^\r\n,\)\.]+)/i);
      if (lm && !/menerima|selesai|diperiksa/i.test(lm[1].trim())) {
        layanan = lm[1].trim();
      }
    }

    if (!faskes) {
      faskes = "BANJARAN KOTA";
    }
    if (!layanan) {
      layanan = item.category || "CKG Umum";
    }

    let msg = customMsg || "";
    if (msg && (msg.includes("selesai diperiksa") || msg.includes("sudah menerima layanan"))) {
      if (/whatsapp|notifikasi/i.test(msg) || /layanan:\s*[^\)\r\n]*(?:selesai|diperiksa)/i.test(msg)) {
        msg = msg.replace(/\(puskesmas\s*pemeriksa\s*[:\-][^\)]*whatsapp[^\)]*\)/gi, `(Puskesmas pemeriksa: ${faskes})`);
        msg = msg.replace(/\(layanan\s*[:\-][^\)]*(?:selesai|diperiksa)[^\)]*\)/gi, `(Layanan: ${layanan})`);
        return msg;
      }
      return msg;
    }

    let baseMsg = detail || `${item.nama || item.name || 'Peserta'} telah selesai diperiksa`;
    if (faskes && !baseMsg.includes(faskes)) baseMsg += ` di ${faskes}`;
    if (tgl && !baseMsg.includes(tgl)) baseMsg += ` pada ${tgl}`;
    if (layanan && !baseMsg.includes(layanan)) baseMsg += ` (Layanan: ${layanan})`;
    return `${baseMsg}. Silakan arahkan peserta untuk melihat rapor di SSM/WhatsApp.`;
  }

  if (statusStr === "server_error" || dbStatus === "SERVER_ERROR") {
    return customMsg || "Internal Server Error (500) pada server Kemenkes. Server gagal merespons setelah 3x percobaan refresh.";
  }

  if (statusStr === "missing" || dbStatus === "MISSING") {
    return customMsg || "Data pasien tidak ditemukan di antrean pelayanan SehatIndonesiaku.";
  }

  if (statusStr === "error" || item._status === "error" || dbStatus === "ERROR") {
    if (customMsg) {
      if (customMsg.includes("429")) {
        return "Server Kemenkes membatasi permintaan (Rate limit / Error 429 Too Many Requests). Aktifkan tab VPN & Anti-429.";
      }
      return customMsg;
    }
    return "Gagal memproses otomasi (terjadi dialog kesalahan di sistem Kemenkes atau batas waktu koneksi terlampaui).";
  }

  if (statusStr === "partial" || statusStr === "partial_done_pelayanan" || dbStatus === "PARTIAL_DONE_PELAYANAN") {
    return customMsg || "Selesai sebagian. Sebagian form berhasil terisi namun ada form pemeriksaan yang belum lengkap.";
  }

  if (statusStr === "done" || statusStr === "done_pelayanan" || dbStatus === "DONE_PELAYANAN") {
    const tiket = item._nomorTiket || item.ticketNumber || item.nomorTiket;
    return tiket
      ? `Berhasil diselesaikan dan tersimpan di SehatIndonesiaku. (No. Tiket: ${tiket})`
      : "Berhasil diselesaikan dan tersimpan di SehatIndonesiaku.";
  }

  if (statusStr === "in-progress" || dbStatus === "IN_PROGRESS") {
    return "Sedang dalam proses pengerjaan oleh otomasi bot...";
  }

  if (statusStr === "idle" || statusStr === "waiting" || statusStr === "ready" || dbStatus === "DONE_PENDAFTARAN") {
    return "Menunggu giliran antrean untuk diproses.";
  }

  return customMsg || "Status belum diproses.";
}

/**
 * Normalisasi item pasien / data ke struktur laporan standar
 */
export function normalizeReportItem(item, idx, menu = "pasien") {
  const autoStatus = String(item._status || "").toLowerCase();
  const dbStatus = String(item.status || "").toUpperCase();

  let category = "idle";
  let label = "Menunggu";
  let badgeClass = "badge--neutral";
  let isError = false;
  let isSuccess = false;
  let isWarning = false;
  let isPending = false;
  let isPartial = false;

  // 1. Error
  if (autoStatus === "invalid-nik" || dbStatus === "INVALID_NIK") {
    category = "error";
    label = "NIK Tidak Valid";
    badgeClass = "badge--danger";
    isError = true;
  } else if (
    autoStatus === "error" ||
    dbStatus === "ERROR" ||
    dbStatus === "SERVER_ERROR" ||
    autoStatus === "server_error" ||
    dbStatus === "MISSING" ||
    autoStatus === "missing"
  ) {
    category = "error";
    label = (dbStatus === "SERVER_ERROR" || autoStatus === "server_error")
      ? "Server Error"
      : (dbStatus === "MISSING" || autoStatus === "missing")
        ? "Tidak Ditemukan"
        : "Error";
    badgeClass = "badge--danger";
    isError = true;
  }
  // 2. Pernah Input (Already Screened)
  else if (autoStatus === "already-screened" || autoStatus === "already_screened" || dbStatus === "ALREADY_SCREENED") {
    category = "already-screened";
    label = "Pernah Input";
    badgeClass = "badge--warning";
    isWarning = true;
  }
  // 3. Selesai Sebagian (Partial)
  else if (autoStatus === "partial" || autoStatus === "partial_done_pelayanan" || dbStatus === "PARTIAL_DONE_PELAYANAN") {
    category = "partial";
    label = "Sebagian";
    badgeClass = "badge--warning";
    isPartial = true;
  }
  // 4. Berhasil (Success)
  else if (
    dbStatus === "DONE_PELAYANAN" ||
    (menu === "pendaftaran" && (autoStatus === "done" || dbStatus === "DONE_PENDAFTARAN" || dbStatus === "DONE")) ||
    (menu !== "pendaftaran" && autoStatus === "done" && dbStatus !== "DONE_PENDAFTARAN") ||
    (autoStatus === "done" && dbStatus === "DONE")
  ) {
    category = "done";
    label = "Berhasil";
    badgeClass = "badge--success";
    isSuccess = true;
  }
  // 5. In Progress
  else if (autoStatus === "in-progress" || dbStatus === "IN_PROGRESS") {
    category = "in-progress";
    label = "Proses...";
    badgeClass = "badge--info";
    isPending = true;
  }
  // 6. Idle / Menunggu
  else {
    category = "idle";
    label = "Menunggu";
    badgeClass = "badge--neutral";
    isPending = true;
  }

  const reason = getHumanReason(category, item);
  const ticketNumber = item._nomorTiket || item.ticketNumber || item.nomorTiket || null;

  // Tanggal & Faskes Input / Pemeriksaan (khususnya untuk Pernah Input atau riwayat)
  let tglInput = item._screeningDate || item.screening_date || item.screeningDate || item.tanggal_pemeriksaan || item.tanggal_skrining || item.tanggal_pelayanan || item.tanggal_daftar || item.tanggal || (item.raw && (item.raw.screening_date || item.raw.tanggal_pemeriksaan || item.raw.tanggal_daftar)) || "";
  let faskesInput = item._screeningFaskes || item.screening_faskes || item.screeningFaskes || item.faskes || item.faskes_pemeriksa || item.puskesmas || (item.raw && (item.raw.faskes || item.raw.puskesmas)) || "";
  let layananInput = item._screeningLayanan || item.screening_layanan || item.screeningLayanan || item.layanan || (item.raw && item.raw.layanan) || "";
  let detailInput = item._screeningDetail || item.screening_detail || "";

  // Bersihkan data jika tercemar bug notifikasi whatsapp atau bug layanan
  if (/whatsapp|notifikasi/i.test(faskesInput)) faskesInput = "";
  if (/selesai\s*diperiksa|menerima\s*layanan/i.test(layananInput)) layananInput = "";

  const textToSearch = `${reason || ''} ${item._errorMsg || ''} ${item.error || ''} ${item.message || ''} ${item.keterangan || ''}`;
  if (!tglInput && textToSearch) {
    const tm = textToSearch.match(/(?:tanggal(?:\s*pemeriksaan|\s*skrining|\s*layanan)?|tgl|date|pada)\s*[:\-]?\s*([0-9]{1,2}\s+[A-Za-z]+\s+[0-9]{4}|[0-9]{1,4}[\/\-][0-9]{1,2}[\/\-][0-9]{1,4})/i);
    if (tm) tglInput = tm[1].trim();
  }
  if (!faskesInput && textToSearch) {
    const fm = textToSearch.match(/puskesmas\s*pemeriksa\s*[:\-]\s*([^\r\n,\)\.]+)/i) ||
               textToSearch.match(/(?:puskesmas|faskes|fasilitas\s*kesehatan|klinik)\s*pemeriksa\s*[:\-]\s*([^\r\n,\)\.]+)/i) ||
               textToSearch.match(/puskesmas\s*[:\-]\s*([^\r\n,\)\.]+)/i);
    if (fm && !/whatsapp|notifikasi|rapor|ssm/i.test(fm[1].trim())) {
      faskesInput = fm[1].trim();
    }
  }
  if (!layananInput && textToSearch) {
    const lm = textToSearch.match(/(?:^|[\r\n\(])\s*layanan\s*[:\-]\s*([^\r\n,\)\.]+)/i);
    if (lm && !/menerima|selesai|diperiksa/i.test(lm[1].trim())) {
      layananInput = lm[1].trim();
    }
  }

  // PENTING: Untuk status 'Pernah Input' (isWarning / already-screened), JANGAN PERNAH fallback ke tanggal hari ini!
  // Tampilkan '-' jika riwayat tanggal pemeriksaan tidak tercatat.
  if (!tglInput) {
    if (isWarning || category === "already-screened") {
      tglInput = "-";
    } else if (isSuccess || category === "done") {
      tglInput = item.dateStr ? item.dateStr.split(",")[0].trim() : new Date().toLocaleDateString("id-ID");
    } else {
      tglInput = "-";
    }
  }
  if (!faskesInput) faskesInput = "BANJARAN KOTA";
  if (!layananInput) layananInput = item.category || "CKG Umum";

  // Waktu & Jam Eksekusi Laporan
  let waktuEksekusi = item.waktuEksekusi || item._waktuEksekusi;
  if (!waktuEksekusi) {
    if (item.timestamp || item._timestamp) {
      waktuEksekusi = formatLogDate(item.timestamp || item._timestamp);
    } else if (item.dateStr) {
      waktuEksekusi = item.dateStr;
    } else {
      waktuEksekusi = "-";
    }
  }

  return {
    index: idx + 1,
    id: item.id || `item_${idx}`,
    nama: item.nama || item.name || item.fullname || "—",
    nik: String(item.nik || item.NIK || "—").trim(),
    category: item.category || item.kategori || "UMUM",
    sekolah: item.sekolah || item.school || null,
    kelas: item.kelas || null,
    statusKey: category,
    rawStatus: dbStatus || autoStatus || "idle",
    statusLabel: label,
    badgeClass,
    ticketNumber,
    reason,
    tanggalInput: tglInput,
    faskesPemeriksa: faskesInput,
    layanan: layananInput,
    detail: detailInput,
    waktuEksekusi,
    isError,
    isSuccess,
    isWarning,
    isPending,
    isPartial,
    raw: item
  };
}

/**
 * Mengambil data laporan untuk menu tertentu
 * @param {"pendaftaran" | "pasien" | "pelayanan"} menu
 */
export async function getReportData(menu = "pendaftaran") {
  let rawList = [];
  let sourceName = "Sesi Aktif";
  let cloudSessionMeta = null;

  try {
    const storageArea = chrome.storage?.session || chrome.storage?.local;

    // 1. Cek apakah ada antrean lokal yang sedang aktif berjalan di tab ini
    let localPatients = [];
    let isRunning = false;
    if (menu === "pendaftaran") {
      const sess = await storageArea.get(["pendaftaranPatients", "pendaftaranRunning"]);
      localPatients = sess.pendaftaranPatients || [];
      isRunning = !!sess.pendaftaranRunning;
    } else if (menu === "pasien") {
      const sess = await storageArea.get(["pelayanan-instan-records", "pelayananRunning"]);
      localPatients = sess["pelayanan-instan-records"] || [];
      isRunning = !!sess.pelayananRunning;
    } else if (menu === "pelayanan") {
      const sess = await storageArea.get(["pelayananExcelPatients", "otomasiRunning"]);
      localPatients = sess.pelayananExcelPatients || [];
      isRunning = !!sess.otomasiRunning;
    }

    const localProcessedCount = localPatients.filter(p => p._status && p._status !== "idle").length;

    // 2. Bridging Langsung dengan ckgbankot Cloud R2
    const userSession = await chrome.storage.local.get(["enco_user_session"]);
    const petugas = userSession.enco_user_session?.nama_user;
    const activeId = await getActiveLogId(menu);

    if (petugas && petugas !== "Petugas") {
      try {
        let targetId = activeId;
        const listRes = await fetch(`${CKG_API_BASE}/api/enco/sessions?petugas=${encodeURIComponent(petugas)}&menu=${encodeURIComponent(menu)}`);
        const listData = await listRes.json();
        if (listData.success && Array.isArray(listData.data) && listData.data.length > 0) {
          const matchedSession = listData.data.find(s => s.id === activeId);
          if (matchedSession) {
            targetId = matchedSession.id;
          } else if (!activeId || activeId === "none") {
            targetId = listData.data[0].id;
            await setActiveLogId(menu, targetId);
          } else {
            // Sesi yang dicari sudah dihapus dari cloud
            targetId = "none";
            await setActiveLogId(menu, "none");
          }
        } else {
          // Cloud tidak memiliki sesi apa pun (seluruh sesi sudah dihapus)
          targetId = "none";
          await setActiveLogId(menu, "none");
        }

        if (targetId && targetId !== "none") {
          const detailRes = await fetch(`${CKG_API_BASE}/api/enco/sessions/detail?id=${encodeURIComponent(targetId)}&petugas=${encodeURIComponent(petugas)}&menu=${encodeURIComponent(menu)}`);
          const detailData = await detailRes.json();
          if (detailData.success && detailData.session?.data && Array.isArray(detailData.session.data) && detailData.session.data.length > 0) {
            cloudSessionMeta = detailData.session;
            const cloudPatients = detailData.session.data;
            const cloudProcessedCount = cloudPatients.filter(p => p._status && p._status !== "idle").length;

            // Jika bot sedang berjalan lokal ATAU data lokal memiliki progres lebih mutakhir, tampilkan data lokal live
            if (isRunning || (localProcessedCount > 0 && localProcessedCount >= cloudProcessedCount)) {
              rawList = localPatients;
              sourceName = `${cloudSessionMeta.fileName || "Pendaftaran"} (🔴 Live Otomasi)`;
            } else {
              // Jika di device lain atau cloud lebih lengkap, tampilkan cloud snapshot
              rawList = cloudPatients;
              sourceName = `${cloudSessionMeta.fileName || "Pendaftaran"} (ckgbankot Cloud R2)`;
              // Hanya sinkronkan ke storage jika lokal kosong agar tab lain juga terisi
              if (localPatients.length === 0) {
                if (menu === "pendaftaran") await storageArea.set({ pendaftaranPatients: rawList }).catch(() => {});
                else if (menu === "pasien") await storageArea.set({ "pelayanan-instan-records": rawList }).catch(() => {});
              }
            }
          }
        } else {
          // Sesi sudah dihapus atau tidak ada sesi aktif di Cloud!
          // Jika bot tidak sedang running, bersihkan sisa cache lokal yang nyangkut
          if (!isRunning) {
            rawList = [];
            localPatients = [];
            if (menu === "pendaftaran") {
              await chrome.storage?.session?.remove(["pendaftaranPatients", "pendaftaranQueue"]).catch(() => {});
              await chrome.storage?.local?.remove(["pendaftaranPatients", "pendaftaranQueue"]).catch(() => {});
            } else if (menu === "pasien") {
              await chrome.storage?.session?.remove(["pelayanan-instan-records"]).catch(() => {});
              await chrome.storage?.local?.remove(["pelayanan-instan-records"]).catch(() => {});
            } else if (menu === "pelayanan") {
              await chrome.storage?.session?.remove(["pelayananExcelPatients"]).catch(() => {});
              await chrome.storage?.local?.remove(["pelayananExcelPatients"]).catch(() => {});
            }
          }
        }
      } catch (cloudErr) {
        console.warn("[reportService] Gagal bridging langsung dari ckgbankot, beralih ke cache lokal:", cloudErr);
      }
    }

    // 3. Fallback jika offline atau bot sedang aktif berjalan lokal
    if (!rawList || rawList.length === 0) {
      if (isRunning && localPatients && localPatients.length > 0) {
        rawList = localPatients;
        sourceName = menu === "pendaftaran" ? "Pendaftaran (Lokal)" : "Pelayanan (Lokal)";
      } else if (activeId && activeId !== "none" && localPatients && localPatients.length > 0) {
        rawList = localPatients;
        sourceName = menu === "pendaftaran" ? "Pendaftaran (Lokal)" : "Pelayanan (Lokal)";
      } else {
        // Sesi telah dihapus atau belum dimuat -> laporan bersih (0 pasien)
        rawList = [];
        sourceName = "Tidak Ada Sesi Aktif";
      }
    }
  } catch (err) {
    console.error("[reportService] Gagal memuat data laporan:", err);
  }

  const items = (rawList || []).map((item, idx) => normalizeReportItem(item, idx, menu));

  const now = new Date();
  const pad = n => String(n).padStart(2, "0");
  const reportTimestamp = `${pad(now.getDate())}/${pad(now.getMonth() + 1)}/${now.getFullYear()}, ${pad(now.getHours())}:${pad(now.getMinutes())} WIB`;

  const stats = {
    total: items.length,
    success: items.filter(i => i.isSuccess).length,
    error: items.filter(i => i.isError).length,
    warning: items.filter(i => i.isWarning).length,
    pending: items.filter(i => i.isPending).length
  };

  return {
    menu,
    sourceName,
    reportTimestamp,
    items,
    stats
  };
}

/**
 * Format tanggal untuk nama file atau salinan laporan
 */
function getTimestampString() {
  const d = new Date();
  const pad = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`;
}

/**
 * Ekspor data laporan ke file Excel (.xlsx)
 */
export function exportReportToExcel(reportData) {
  const { menu, items = [], stats } = reportData;
  if (!items.length) {
    alert("Tidak ada data untuk diekspor ke Excel.");
    return;
  }

  if (typeof window.XLSX === "undefined") {
    alert("Library XLSX belum siap. Silakan muat ulang ekstensi.");
    return;
  }

  const exportRows = items.map(item => ({
    No: item.index,
    "Nama Pasien": item.nama,
    NIK: item.nik,
    Kategori: item.category,
    Sekolah: item.sekolah || "-",
    Kelas: item.kelas || "-",
    "Status Hasil": item.statusLabel,
    "Puskesmas Pemeriksa": item.faskesPemeriksa || "-",
    "Tanggal Pemeriksaan": item.tanggalInput || "-",
    Layanan: item.layanan || "-",
    "Nomor Tiket": item.ticketNumber || "-",
    "Waktu Eksekusi": item.waktuEksekusi || "-",
    "Keterangan / Alasan Detail": item.reason
  }));

  const wb = window.XLSX.utils.book_new();
  const ws = window.XLSX.utils.json_to_sheet(exportRows);

  // Set lebar kolom otomatis agar rapi
  ws["!cols"] = [
    { wch: 5 },  // No
    { wch: 26 }, // Nama
    { wch: 20 }, // NIK
    { wch: 14 }, // Kategori
    { wch: 18 }, // Sekolah
    { wch: 10 }, // Kelas
    { wch: 16 }, // Status
    { wch: 24 }, // Puskesmas Pemeriksa
    { wch: 20 }, // Tanggal Pemeriksaan
    { wch: 16 }, // Layanan
    { wch: 18 }, // Tiket
    { wch: 20 }, // Waktu Eksekusi
    { wch: 60 }  // Alasan Detail
  ];

  const sheetName = (menu || "Laporan").toUpperCase().slice(0, 31);
  window.XLSX.utils.book_append_sheet(wb, ws, sheetName);

  const fileName = `Laporan_Hasil_CKG_${menu.toUpperCase()}_${getTimestampString()}.xlsx`;
  window.XLSX.writeFile(wb, fileName);
}

/**
 * Buat salinan ringkasan teks untuk dibagikan (WhatsApp / Catatan)
 */
export async function copyReportSummary(reportData) {
  const { menu, sourceName, items = [], stats } = reportData;
  if (!items.length) {
    alert("Tidak ada data laporan untuk disalin.");
    return false;
  }

  const d = new Date();
  const dateStr = d.toLocaleString("id-ID", { dateStyle: "medium", timeStyle: "short" });

  let text = `📊 *LAPORAN HASIL OTOMASI CKG - ${menu.toUpperCase()}*\n`;
  text += `📅 Waktu: ${dateStr}\n`;
  text += `📁 Sumber: ${sourceName}\n`;
  text += `──────────────────────\n`;
  text += `• Total Data    : ${stats.total}\n`;
  text += `• ✅ Berhasil   : ${stats.success}\n`;
  text += `• ❌ Error/Gagal: ${stats.error}\n`;
  text += `• ⚠️ Pernah Input: ${stats.warning}\n`;
  text += `• ⏳ Menunggu/Proses: ${stats.pending}\n`;
  text += `──────────────────────\n\n`;

  const errors = items.filter(i => i.isError);
  if (errors.length > 0) {
    text += `❌ *RINCIAN DATA ERROR (${errors.length}):*\n`;
    errors.forEach((err, idx) => {
      text += `${idx + 1}. *${err.nama}* (${err.nik})\n`;
      text += `   ↳ _Penyebab: ${err.reason}_\n`;
    });
    text += `\n`;
  }

  const warnings = items.filter(i => i.statusKey === "already-screened");
  if (warnings.length > 0) {
    text += `⚠️ *DATA SUDAH TERDAFTAR / PERNAH INPUT (${warnings.length}):*\n`;
    warnings.slice(0, 15).forEach((w, idx) => {
      text += `${idx + 1}. ${w.nama} (${w.nik})\n`;
    });
    if (warnings.length > 15) {
      text += `... dan ${warnings.length - 15} lainnya.\n`;
    }
    text += `\n`;
  }

  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (err) {
    console.error("[reportService] Gagal menyalin ringkasan:", err);
    return false;
  }
}
