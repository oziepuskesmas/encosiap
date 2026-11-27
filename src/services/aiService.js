/**
 * ENCO AI Service - Smart Excel & Clinical AI Assistant
 * Powered by Gemini via RelayRouter
 */

export const DEFAULT_AI_CONFIG = {
  apiUrl: "https://api.relayrouter.ai/v1beta/models/gemini-3.1-pro-preview:generateContent",
  apiKey: "sk-ykKco14Y5ONdJ37LsRIpTAixpX60b1SeAG8vz3y5TNzoMdtR",
  modelName: "gemini-3.1-pro-preview",
  enabled: true
};

/**
 * Get current AI configuration from storage with default fallback
 */
export async function getAiConfig() {
  try {
    if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
      const data = await chrome.storage.local.get(["enco_ai_config"]);
      if (data && data.enco_ai_config) {
        return {
          ...DEFAULT_AI_CONFIG,
          ...data.enco_ai_config
        };
      }
    }
  } catch (err) {
    console.warn("[ENCO AI] Gagal baca config AI dari storage:", err);
  }
  return { ...DEFAULT_AI_CONFIG };
}

/**
 * Save AI configuration
 */
export async function saveAiConfig(config) {
  try {
    if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
      await chrome.storage.local.set({ enco_ai_config: config });
      return true;
    }
  } catch (err) {
    console.error("[ENCO AI] Gagal simpan config AI:", err);
  }
  return false;
}

/**
 * Test AI API connection
 */
export async function testAiConnection(customConfig = null) {
  const config = customConfig || (await getAiConfig());
  const startTime = Date.now();

  try {
    const res = await fetch(config.apiUrl, {
      method: "POST",
      headers: {
        "x-goog-api-key": config.apiKey,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [{ text: "Jawab hanya dengan 1 kata: SIAP" }]
          }
        ]
      })
    });

    if (!res.ok) {
      const errJson = await res.json().catch(() => ({}));
      throw new Error(errJson?.error?.message || `HTTP ${res.status}: ${res.statusText}`);
    }

    const json = await res.json();
    const reply = json?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "OK";
    const latency = Date.now() - startTime;

    return {
      success: true,
      latency,
      reply,
      model: json?.modelVersion || config.modelName
    };
  } catch (err) {
    return {
      success: false,
      error: err.message || "Gagal menghubungkan ke server AI"
    };
  }
}

/**
 * Sanitize NIK value from Excel (scientific notation, float, string)
 */
export function sanitizeNik(val) {
  if (val == null) return "";
  let s = String(val).trim();
  if (s.toLowerCase().includes("e+")) {
    try {
      const num = Number(s);
      if (!Number.isNaN(num)) {
        s = BigInt(Math.floor(num)).toString();
      }
    } catch (_) {}
  }
  s = s.replace(/\.0+$/, "").replace(/[^0-9]/g, "");
  return s;
}

/**
 * Validate whether a NIK consists of 16 digits and is not a trivial repeated-digit placeholder.
 */
export function isValidNik(val) {
  const digits = sanitizeNik(val);
  if (digits.length !== 16) return false;
  if (/^(\d)\1{15}$/.test(digits)) return false;
  return true;
}

function isNonEmptyIdentityValue(val) {
  const s = String(val ?? "").trim();
  if (!s) return false;
  if (/^(?:-+|0+|n\/?a|null|undefined|tidak diketahui|\?+)$/i.test(s)) return false;
  return true;
}

/**
 * Filter parsed patient rows so records with missing/incomplete identity (e.g. empty or
 * non-16-digit NIK, missing name, or missing DOB/gender when the sheet provides those columns)
 * do not enter the processing queue.
 */
export function filterValidIdentityRows(rows, options = {}) {
  const {
    dedupeNik = false,
    allowSekolahWithoutNik = false,
    checkDobGender = true
  } = options;

  const list = Array.isArray(rows) ? rows : [];
  const reasons = {
    emptyNama: 0,
    invalidNik: 0,
    missingDob: 0,
    missingGender: 0,
    duplicateNik: 0
  };

  // First pass: check core NIK & Nama identity
  const stage1 = [];
  for (const row of list) {
    if (!row || typeof row !== "object") continue;

    const cleanNama = sanitizeName(row.nama || row.name || row.namalengkap || row.namapasien || "");
    const upperNama = cleanNama.toUpperCase();
    if (upperNama.includes("CONTOH NAMA")) continue;

    const rawNik = sanitizeNik(row.nik || row.nonik || row.noktp || row.nomoridentitas || "");
    const dobRaw = row.tanggal_lahir || row.tanggallahir || row.tahunlahir || "";
    const genderRaw = row.jenis_kelamin || row.jeniskelamin || row.jk || row.gender || row.sex || "";

    // Ignore completely blank trailing spreadsheet rows silently
    if (!cleanNama && !rawNik && !isNonEmptyIdentityValue(dobRaw) && !isNonEmptyIdentityValue(genderRaw)) {
      continue;
    }

    if (!cleanNama || cleanNama.length < 2 || !/[a-zA-Z]/.test(cleanNama)) {
      reasons.emptyNama++;
      continue;
    }

    const hasSekolah = allowSekolahWithoutNik && isNonEmptyIdentityValue(row.sekolah);
    const nikOk = rawNik ? isValidNik(rawNik) : hasSekolah;
    if (!nikOk) {
      reasons.invalidNik++;
      continue;
    }

    stage1.push(row.nama === cleanNama && row.nik === rawNik ? row : { ...row, nama: cleanNama, nik: rawNik });
  }

  // Enforce DOB / gender completeness if the uploaded file uses those identity columns (>= 50% populated)
  let enforceDob = false;
  let enforceGender = false;
  if (checkDobGender && stage1.length > 0) {
    const dobCount = stage1.filter(r => isNonEmptyIdentityValue(r.tanggal_lahir || r.tanggallahir || r.tahunlahir)).length;
    const genderCount = stage1.filter(r => {
      const g = sanitizeGender(r.jenis_kelamin || r.jeniskelamin || r.jk || r.gender || r.sex || "");
      return g === "L" || g === "P";
    }).length;
    enforceDob = dobCount / stage1.length >= 0.5;
    enforceGender = genderCount / stage1.length >= 0.5;
  }

  const seenNiks = new Set();
  const validRows = [];
  for (const row of stage1) {
    if (enforceDob && !isNonEmptyIdentityValue(row.tanggal_lahir || row.tanggallahir || row.tahunlahir)) {
      reasons.missingDob++;
      continue;
    }
    if (enforceGender) {
      const g = sanitizeGender(row.jenis_kelamin || row.jeniskelamin || row.jk || row.gender || row.sex || "");
      if (g !== "L" && g !== "P") {
        reasons.missingGender++;
        continue;
      }
    }
    if (dedupeNik && row.nik) {
      if (seenNiks.has(row.nik)) {
        reasons.duplicateNik++;
        continue;
      }
      seenNiks.add(row.nik);
    }
    validRows.push(row);
  }

  const skippedCount =
    reasons.emptyNama +
    reasons.invalidNik +
    reasons.missingDob +
    reasons.missingGender +
    reasons.duplicateNik;

  return { validRows, skippedCount, reasons };
}

/**
 * Format human-readable summary of skipped Excel rows.
 */
export function formatSkippedIdentitySummary(reasons = {}) {
  const parts = [];
  if (reasons.invalidNik) parts.push(`${reasons.invalidNik} NIK kosong/tidak 16 digit`);
  if (reasons.emptyNama) parts.push(`${reasons.emptyNama} Nama kosong`);
  if (reasons.missingDob) parts.push(`${reasons.missingDob} Tgl lahir kosong`);
  if (reasons.missingGender) parts.push(`${reasons.missingGender} Jenis kelamin kosong`);
  if (reasons.duplicateNik) parts.push(`${reasons.duplicateNik} duplikat NIK`);
  return parts.join(", ");
}

/**
 * Strip leading/trailing honorific titles ("Ny", "Ny.", "Nyonya", "Tn", "Tn.", "Tuan")
 * from patient full names without touching genuine substrings (e.g. Nyoman, Anny, Martin).
 */
export function sanitizeName(val) {
  if (val == null) return "";
  let name = String(val).replace(/\s+/g, " ").trim();
  if (!name) return "";

  const startTitleRe = /^(?:[\(\[]\s*)?\b(?:nyonya|ny|tuan|tn)\b\.?(?:\s*[\)\]])*(?:[\s,.\-\/:;]+|$)/i;
  const endTitleRe = /(?:^|[\s,.\-\/:;\(\[]+)\b(?:nyonya|ny|tuan|tn)\b\.?(?:\s*[\)\]])*$/i;

  let prev;
  do {
    prev = name;
    name = name.replace(startTitleRe, "").trim();
    name = name.replace(endTitleRe, "").trim();
  } while (name !== prev && name.length > 0);

  return name.replace(/\s+/g, " ").trim();
}

/**
 * Clean & normalize date to YYYY-MM-DD
 */
export function sanitizeDate(val) {
  if (val == null || val === "") return "";

  // 1. Excel serial number (e.g. 44560 -> 2022-01-01)
  if (typeof val === "number" || (!Number.isNaN(Number(val)) && Number(val) > 10000 && Number(val) < 60000)) {
    try {
      const serial = Number(val);
      const utcDays = Math.floor(serial - 25569);
      const utcValue = utcDays * 86400;
      const dateInfo = new Date(utcValue * 1000);
      const year = dateInfo.getUTCFullYear();
      const month = String(dateInfo.getUTCMonth() + 1).padStart(2, "0");
      const day = String(dateInfo.getUTCDate()).padStart(2, "0");
      if (year >= 1900 && year <= 2030) {
        return `${year}-${month}-${day}`;
      }
    } catch (_) {}
  }

  let str = String(val).trim();
  // Remove place prefix (e.g. "Bandung, 14-07-1990" -> "14-07-1990")
  if (str.includes(",")) {
    const parts = str.split(",");
    str = parts[parts.length - 1].trim();
  }

  // Indonesian month map
  const monthMap = {
    jan: "01", januari: "01",
    feb: "02", februari: "02",
    mar: "03", maret: "03",
    apr: "04", april: "04",
    mei: "05", may: "05",
    jun: "06", juni: "06",
    jul: "07", juli: "07",
    agu: "08", agustus: "08", aug: "08",
    sep: "09", september: "09",
    okt: "10", oktober: "10", oct: "10",
    nov: "11", november: "11",
    des: "12", desember: "12", dec: "12"
  };

  for (const [mName, mNum] of Object.entries(monthMap)) {
    const reg = new RegExp(`\\b${mName}\\w*\\b`, "i");
    if (reg.test(str)) {
      str = str.replace(reg, mNum);
      break;
    }
  }

  // Normalize delimiters to dash
  str = str.replace(/[/.]/g, "-");

  // Regex patterns:
  // DD-MM-YYYY
  const m1 = str.match(/\b(\d{1,2})-(\d{1,2})-(\d{4})\b/);
  if (m1) {
    const d = m1[1].padStart(2, "0");
    const m = m1[2].padStart(2, "0");
    const y = m1[3];
    return `${y}-${m}-${d}`;
  }

  // YYYY-MM-DD
  const m2 = str.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/);
  if (m2) {
    const y = m2[1];
    const m = m2[2].padStart(2, "0");
    const d = m2[3].padStart(2, "0");
    return `${y}-${m}-${d}`;
  }

  return str;
}

/**
 * Normalize gender
 */
export function sanitizeGender(val) {
  if (!val) return "";
  const s = String(val).trim().toUpperCase();
  if (s.startsWith("L") || s === "1" || s.includes("PRIA") || s.includes("LAKI")) {
    return "L";
  }
  if (s.startsWith("P") || s === "2" || s.includes("WANITA") || s.includes("PEREMPUAN")) {
    return "P";
  }
  return s;
}

/**
 * Use Gemini AI to detect header row and column mappings from messy Excel files
 * @param {Array<Array<any>>} raw2DRows - First 6 to 12 rows of the sheet
 * @param {"pendaftaran" | "pelayanan"} mode
 */
export async function detectExcelMappingWithAI({ raw2DRows, mode = "pendaftaran" }) {
  const config = await getAiConfig();
  if (!config.enabled) {
    return { success: false, error: "AI dinonaktifkan di pengaturan" };
  }

  if (!raw2DRows || raw2DRows.length === 0) {
    return { success: false, error: "Data Excel kosong" };
  }

  // Take sample preview (up to 8 rows, clean empty trailing columns)
  const previewSample = raw2DRows.slice(0, 8).map(row => {
    if (!Array.isArray(row)) return [];
    return row.slice(0, 20).map(c => (c == null ? "" : String(c).trim()));
  });

  const isPendaftaran = mode === "pendaftaran";
  const targetFieldsDoc = isPendaftaran
    ? `Target field pendaftaran:
- nik: Nomor KTP / NIK (16 digit angka)
- nama: Nama lengkap pasien / nama siswa
- sekolah: Nama sekolah / madrasah / satuan pendidikan
- kelas: Jenjang pendidikan / kelas / tingkat (misal: 7, 8, SD, SMP, SMA)
- tanggallahir: Tanggal lahir / TTL / tanggal lahir
- jeniskelamin: Jenis kelamin (L/P / Laki-laki / Perempuan)
- wa: Nomor WhatsApp / No HP / Telepon
- statuspernikahan: Status pernikahan / perkawinan
- pekerjaan: Pekerjaan / profesi
- provinsi: Provinsi
- kabkota: Kabupaten / Kota
- kecamatan: Kecamatan
- kelurahan: Kelurahan / Desa
- detailalamat: Alamat domisili / alamat lengkap / RT RW`
    : `Target field pelayanan skrining medis:
- nik: Nomor KTP / NIK (16 digit angka)
- nama: Nama pasien / siswa
- sekolah: Nama sekolah
- kelas: Kelas / tingkat
- bb: Berat Badan (kg)
- tb: Tinggi Badan (cm)
- lp: Lingkar Perut (cm)
- td_sistolik: Tekanan darah sistolik / tensi atas (mmHg)
- td_diastolik: Tekanan darah diastolik / tensi bawah (mmHg)
- gula_darah: Gula darah sewaktu / puasa (mg/dL)
- hb: Hemoglobin (g/dL)
- merokok: Status merokok
- kacamata: Pakai kacamata
- disabilitas: Disabilitas`;

  const promptText = `Anda adalah asisten AI medis untuk aplikasi otomatisasi Cek Kesehatan Gratis (CKG) SatuSehat Kemkes.
Tugas Anda: Menganalisis potongan baris file Excel yang diunggah pengguna untuk memetakan kolom secara otomatis (Zero-Template Ingestion).

Berikut adalah data contoh 2D array (baris demi baris):
${JSON.stringify(previewSample)}

${targetFieldsDoc}

Instruksi:
1. Tentukan "header_row_index": baris ke berapa (0-indexed integer) yang merupakan baris judul/header kolom sebenarnya. (Jika ada judul instansi/sekolah di baris 0, header mungkin ada di baris 1 atau 2).
2. Tentukan "mapping": objek yang memetakan nama field target ke INDEKS KOLOM (0-indexed integer) yang sesuai pada array.
   Pastikan minimal "nik" dan "nama" terpetakan jika ada data yang menyerupai nama dan NIK/angka.
3. Berikan ringkasan singkat dalam "summary" (Bahasa Indonesia).

Kembalikan HANYA format JSON murni tanpa awalan markdown seperti \`\`\`json:
{
  "header_row_index": 1,
  "mapping": {
    "nik": 1,
    "nama": 2,
    "tanggallahir": 3,
    "jeniskelamin": 4
  },
  "summary": "Berhasil mendeteksi kolom NIK, Nama, Tanggal Lahir, Jenis Kelamin pada baris ke-2"
}`;

  try {
    const res = await fetch(config.apiUrl, {
      method: "POST",
      headers: {
        "x-goog-api-key": config.apiKey,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [{ text: promptText }]
          }
        ]
      })
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`AI API error (${res.status}): ${errText.slice(0, 100)}`);
    }

    const data = await res.json();
    let text = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";

    // Clean markdown code blocks if AI included them
    text = text.replace(/```json/gi, "").replace(/```/g, "").trim();

    const jsonStart = text.indexOf("{");
    const jsonEnd = text.lastIndexOf("}");
    if (jsonStart !== -1 && jsonEnd !== -1) {
      text = text.slice(jsonStart, jsonEnd + 1);
    }

    const parsed = JSON.parse(text);
    return {
      success: true,
      headerRowIndex: Number.isInteger(parsed.header_row_index) ? parsed.header_row_index : 0,
      mapping: parsed.mapping || {},
      summary: parsed.summary || "Pemetaan kolom selesai",
      rawResult: parsed
    };
  } catch (err) {
    console.error("[ENCO AI] detectExcelMappingWithAI error:", err);
    return {
      success: false,
      error: err.message || "Gagal memproses AI"
    };
  }
}
