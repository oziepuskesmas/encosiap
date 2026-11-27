/**
 * Helper modul untuk filtering data berdasarkan Umur dan Status
 * Digunakan di tab Pendaftaran dan tab Pasien (Pelayanan Instan).
 */

/**
 * Menghitung umur pasien (angka integer) dari berbagai representasi data.
 * @param {Object} patient
 * @returns {number|null} Umur dalam tahun, atau null jika tidak dapat dihitung
 */
export function calculateAge(patient) {
  if (!patient) return null;

  // 1. Cek field umur/usia/age eksplisit
  const rawUmur = patient.umur ?? patient.usia ?? patient.age;
  if (rawUmur !== undefined && rawUmur !== null && rawUmur !== "") {
    const m = String(rawUmur).match(/(\d+)/);
    if (m) {
      const parsed = parseInt(m[1], 10);
      if (!isNaN(parsed) && parsed >= 0 && parsed <= 130) return parsed;
    }
  }

  // 2. Cek field tanggal lahir
  const rawDate =
    patient.tanggal_lahir ||
    patient.tanggalLahir ||
    patient.tgllahir ||
    patient.tglLahir ||
    patient.bornDate ||
    patient.dob ||
    patient.tgl_lahir ||
    patient.tanggallahir;

  if (rawDate) {
    if (rawDate instanceof Date && !isNaN(rawDate.getTime())) {
      const now = new Date();
      let age = now.getFullYear() - rawDate.getFullYear();
      const m = now.getMonth() - rawDate.getMonth();
      if (m < 0 || (m === 0 && now.getDate() < rawDate.getDate())) age--;
      if (age >= 0 && age <= 130) return age;
    }

    const str = String(rawDate).trim();
    const umurMatch = str.match(/(\d+)\s*(?:tahun|thn)/i);
    if (umurMatch) {
      const parsed = parseInt(umurMatch[1], 10);
      if (!isNaN(parsed)) return parsed;
    }

    // Format Excel serial date (angka > 1000 tanpa pemisah / atau -)
    const num = parseFloat(str);
    if (!isNaN(num) && num > 1000 && !/[\/\-]/.test(str)) {
      const ms = 86400000 * ((num > 59 ? num - 1 : num) - 1);
      const d = new Date(Date.UTC(1900, 0, 1) + ms);
      const now = new Date();
      let age = now.getFullYear() - d.getUTCFullYear();
      const m = now.getMonth() - d.getUTCMonth();
      if (m < 0 || (m === 0 && now.getDate() < d.getUTCDate())) age--;
      if (age >= 0 && age <= 130) return age;
    }

    // Format ISO: YYYY-MM-DD atau YYYY/MM/DD
    const isoMatch = str.match(/^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})/);
    if (isoMatch) {
      const y = parseInt(isoMatch[1], 10);
      const m = parseInt(isoMatch[2], 10) - 1;
      const d = parseInt(isoMatch[3], 10);
      const now = new Date();
      let age = now.getFullYear() - y;
      const diffM = now.getMonth() - m;
      if (diffM < 0 || (diffM === 0 && now.getDate() < d)) age--;
      if (age >= 0 && age <= 130) return age;
    }

    // Format DMY: DD-MM-YYYY atau DD/MM/YYYY
    const dmyMatch = str.match(/^(\d{1,2})[-\/](\d{1,2})[-\/](\d{4})/);
    if (dmyMatch) {
      const d = parseInt(dmyMatch[1], 10);
      const m = parseInt(dmyMatch[2], 10) - 1;
      const y = parseInt(dmyMatch[3], 10);
      const now = new Date();
      let age = now.getFullYear() - y;
      const diffM = now.getMonth() - m;
      if (diffM < 0 || (diffM === 0 && now.getDate() < d)) age--;
      if (age >= 0 && age <= 130) return age;
    }

    // Format teks bahasa Indonesia: DD [Nama Bulan] YYYY
    const textMatch = str.match(/^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/);
    if (textMatch) {
      const monthMap = {
        jan: 0, januari: 0, january: 0,
        feb: 1, februari: 1, february: 1,
        mar: 2, maret: 2, march: 2,
        apr: 3, april: 3,
        mei: 4, may: 4,
        jun: 5, juni: 5, june: 5,
        jul: 6, juli: 6, july: 6,
        agt: 7, agu: 7, agustus: 7, august: 7,
        sep: 8, september: 8,
        okt: 9, oktober: 9, october: 9,
        nov: 10, november: 10,
        des: 11, desember: 11, december: 11
      };
      const d = parseInt(textMatch[1], 10);
      const m = monthMap[textMatch[2].toLowerCase()] ?? 0;
      const y = parseInt(textMatch[3], 10);
      const now = new Date();
      let age = now.getFullYear() - y;
      const diffM = now.getMonth() - m;
      if (diffM < 0 || (diffM === 0 && now.getDate() < d)) age--;
      if (age >= 0 && age <= 130) return age;
    }
  }

  // 3. Cek tahun lahir terpisah (tahun / tahunlahir)
  const thn = patient.tahunlahir ?? patient.tahun;
  if (thn) {
    const y = parseInt(String(thn).trim(), 10);
    const currentYear = new Date().getFullYear();
    if (!isNaN(y) && y > 1900 && y <= currentYear) {
      return currentYear - y;
    }
  }

  // 4. Dekode dari 16-digit NIK Indonesia (digit 7-12: DDMMYY)
  const nik = String(patient.nik || patient.NIK || "").replace(/\D/g, "");
  if (nik.length === 16) {
    let day = parseInt(nik.substr(6, 2), 10);
    const month = parseInt(nik.substr(8, 2), 10);
    const yearShort = parseInt(nik.substr(10, 2), 10);

    // Tanggal perempuan ditambah 40 di NIK (41 - 71)
    if (day > 40) day -= 40;

    if (day >= 1 && day <= 31 && month >= 1 && month <= 12 && !isNaN(yearShort)) {
      const currentYear = new Date().getFullYear();
      const currentShort = currentYear % 100;
      const fullYear = yearShort > currentShort ? 1900 + yearShort : 2000 + yearShort;

      const now = new Date();
      let age = now.getFullYear() - fullYear;
      const diffM = (now.getMonth() + 1) - month;
      if (diffM < 0 || (diffM === 0 && now.getDate() < day)) age--;
      if (age >= 0 && age <= 130) return age;
    }
  }

  return null;
}

/**
 * Menentukan kategori umur standar CKG / Kemenkes RI:
 * - 'anak'   : < 10 tahun
 * - 'remaja' : 10 - 17 tahun
 * - 'dewasa' : 18 - 59 tahun
 * - 'lansia' : >= 60 tahun
 *
 * @param {Object} patient
 * @returns {'anak'|'remaja'|'dewasa'|'lansia'}
 */
export function getAgeCategory(patient) {
  const age = calculateAge(patient);
  if (age !== null && !isNaN(age)) {
    if (age < 10) return "anak";
    if (age < 18) return "remaja";
    if (age < 60) return "dewasa";
    return "lansia";
  }

  // Fallback berdasarkan indikator teks jika umur numerik tidak ditemukan
  const kat = String(patient?.kategori || patient?.category || "").toLowerCase();
  if (kat.includes("lansia")) return "lansia";
  if (kat.includes("remaja")) return "remaja";
  if (kat.includes("anak") || kat.includes("balita")) return "anak";
  if (kat.includes("dewasa") || kat.includes("umum")) return "dewasa";
  if (kat.includes("sekolah")) return "remaja";

  return "dewasa"; // default fallback
}

/**
 * Memeriksa apakah pasien di menu Pendaftaran cocok dengan filter status terpilih.
 * @param {Object} patient
 * @param {string} filterStatus 'ALL' | 'ready' | 'selesai' | 'sebagian' | 'pernah-input' | 'error'
 * @returns {boolean}
 */
export function matchesPendaftaranStatus(patient, filterStatus) {
  if (!filterStatus || filterStatus === "ALL") return true;
  const s = patient?._status;

  if (filterStatus === "ready" || filterStatus === "menunggu") {
    return !s || s === "idle" || s === "in-progress";
  }
  if (filterStatus === "selesai") return s === "done";
  if (filterStatus === "sebagian") return s === "partial";
  if (filterStatus === "pernah-input") return s === "already-screened";
  if (filterStatus === "error") return s === "error" || s === "invalid-nik";

  return true;
}

/**
 * Memeriksa apakah record di menu Pasien (Pelayanan Instan) cocok dengan filter status terpilih.
 * @param {Object} record
 * @param {string} filterStatus 'ALL' | 'ready' | 'selesai' | 'sebagian' | 'pernah-input' | 'error'
 * @returns {boolean}
 */
export function matchesPelayananStatus(record, filterStatus) {
  if (!filterStatus || filterStatus === "ALL") return true;
  const autoStatus = record?._status;
  const rawStatus = record?.status;

  // Cek apakah item selesai penuh vs sebagian vs error vs sudah diskrining
  const isError = rawStatus === "MISSING" || rawStatus === "SERVER_ERROR" || rawStatus === "error" || autoStatus === "error";
  const isScreened = rawStatus === "ALREADY_SCREENED" || autoStatus === "already-screened";
  const isFinished = !isError && (rawStatus === "DONE_PELAYANAN" || (autoStatus === "done" && rawStatus !== "PARTIAL_DONE_PELAYANAN"));
  const isPartial = !isError && (rawStatus === "PARTIAL_DONE_PELAYANAN" || autoStatus === "partial");

  if (filterStatus === "ready" || filterStatus === "menunggu") {
    return !isFinished && !isPartial && !isError && !isScreened;
  }
  if (filterStatus === "selesai") {
    return isFinished;
  }
  if (filterStatus === "sebagian") {
    return isPartial;
  }
  if (filterStatus === "pernah-input") {
    return isScreened;
  }
  if (filterStatus === "error") {
    return isError;
  }

  return true;
}

