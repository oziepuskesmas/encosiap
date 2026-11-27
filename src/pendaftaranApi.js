import { sanitizeName } from "./services/aiService.js";

const ME_URL = "/api/user-management/me";
const CHECK_NIK_URL = "/api/pkg/ssi/check-nik";
const REGISTER_PRE_URL = "/api/pkg/ssi/register-pre";
const REGISTER_CKG_URL = "/api/pkg/ssi/register-ckg";
const PROVINCE_URL = "/api/teritorial-service/province";
const CITY_URL = "/api/teritorial-service/city";
const DISTRICT_URL = "/api/teritorial-service/district";
const SUBDISTRICT_URL = "/api/teritorial-service/subdistrict";
const DEFAULT_FALLBACK_WA = "6281225566666";
const territoryCache = new Map();
const LIST_JOB_URL = "/api/pkg/ssi/list-job";
const LIST_SEKOLAH_URL = "/api/pkg/ssi/list-sekolah";
const LIST_KELAS_URL = "/api/pkg/ssi/list-kelas";
let cachedJobList = null;
const schoolCache = new Map();
const classCache = new Map();

function assertTabId(tabId) {
  if (typeof tabId !== "number" || tabId < 0) {
    throw new Error(`tabId tidak valid (${tabId}). Tab CKG belum siap.`);
  }
}

/**
 * POST ke API Sehat Indonesiaku dari MAIN world.
 * Endpoint `/api/pkg/ssi/*` saat ini mewajibkan payload & respons terenkripsi HPKE (`_d`),
 * jadi kita memakai `useFetchSsi().postFetch` milik frontend Nuxt yang dicari secara dinamis
 * dari resource `/_nuxt/*.js`, agar selalu sinkron jika hash build web Kemkes berubah.
 */
async function postJson(tabId, endpoint, payload) {
  assertTabId(tabId);
  const isSsiEncrypted = endpoint.startsWith("/api/pkg/ssi/");
  const [res] = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    args: [endpoint, payload, isSsiEncrypted],
    func: async (url, bodyObj, useEncryptedSsi) => {
      try {
        if (useEncryptedSsi) {
          if (!window.__encoGetPostFetch) {
            window.__encoGetPostFetch = async () => {
              if (typeof window.__encoCachedPostFetch === "function") {
                return window.__encoCachedPostFetch;
              }
              const chunks = [...new Set(
                performance
                  .getEntriesByType("resource")
                  .map(r => r.name)
                  .filter(u => u.includes("/_nuxt/") && u.endsWith(".js"))
              )];
              for (const chunkUrl of chunks) {
                try {
                  const txt = await (await fetch(chunkUrl)).text();
                  if (txt.includes("ENCRYPTED_PAYLOAD_REQUIRED")) {
                    const mod = await import(chunkUrl);
                    const factory = Object.values(mod).find(fn => typeof fn === "function");
                    if (factory) {
                      const api = factory();
                      if (typeof api?.postFetch === "function") {
                        window.__encoCachedPostFetch = api.postFetch;
                        return api.postFetch;
                      }
                    }
                  }
                } catch (_) {}
              }
              return null;
            };
          }

          const postFetch = await window.__encoGetPostFetch();
          if (typeof postFetch === "function") {
            try {
              const data = await postFetch(url, bodyObj, { timeout: 60000 });
              const sc = Number(data?.statusCode ?? 200);
              return { ok: sc >= 200 && sc < 300, status: sc, body: data };
            } catch (err) {
              const errData = err?.data ?? err?.response?._data ?? null;
              const status = Number(
                errData?.statusCode ?? err?.statusCode ?? err?.status ?? err?.response?.status ?? 0
              );
              return {
                ok: false,
                status,
                body: errData,
                error: errData?.message || String(err?.message ?? err)
              };
            }
          }
        }

        const resp = await fetch(url, {
          method: "POST",
          credentials: "include",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/plain, */*"
          },
          body: JSON.stringify(bodyObj)
        });
        let parsed = null;
        try {
          parsed = await resp.json();
        } catch (_) {}
        return { ok: resp.ok, status: resp.status, body: parsed };
      } catch (err) {
        return { ok: false, status: 0, body: null, error: String(err?.message ?? err) };
      }
    }
  });
  return res?.result ?? { ok: false, status: 0, body: null, error: "script tidak menghasilkan apa pun" };
}

async function postWithAuthRetry(tabId, endpoint, payload, { allowRetry = true } = {}) {
  const res = await postJson(tabId, endpoint, payload);
  if (res.status !== 401 || !allowRetry) return res;
  await reloadCkgTab(tabId);
  return await postJson(tabId, endpoint, payload);
}

async function getJson(tabId, endpoint) {
  assertTabId(tabId);
  const [res] = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    args: [endpoint],
    func: async (url) => {
      try {
        const resp = await fetch(url, {
          credentials: "include",
          headers: { accept: "application/json" }
        });
        let parsed = null;
        try {
          parsed = await resp.json();
        } catch (_) {}
        return { ok: resp.ok, status: resp.status, body: parsed };
      } catch (err) {
        return { ok: false, status: 0, body: null, error: String(err?.message ?? err) };
      }
    }
  });
  return res?.result ?? { ok: false, status: 0, body: null, error: "script tidak menghasilkan apa pun" };
}

export async function reloadCkgTab(tabId, timeoutMs = 20000) {
  await chrome.tabs.reload(tabId);
  await new Promise(resolve => {
    const onUpdated = (tid, info) => {
      if (tid === tabId && info.status === "complete") {
        chrome.tabs.onUpdated.removeListener(onUpdated);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
    setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve();
    }, timeoutMs);
  });
  await new Promise(r => setTimeout(r, 1200));
}

async function getLocalStorageUser(tabId) {
  const [res] = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: () => {
      try {
        const raw = localStorage.getItem("user_eksternal");
        return raw ? JSON.parse(raw) : null;
      } catch (_) {
        return null;
      }
    }
  });
  return res?.result ?? null;
}

export async function getCkgUser(tabId) {
  let lsData = await getLocalStorageUser(tabId);
  if (lsData && (lsData.organitazion_ihs || lsData.faskes_code) && lsData.id) {
    const rawFaskes = lsData.organitazion_ihs ?? lsData.faskes_code ?? "";
    const faskesCode = String(rawFaskes).split(" ")[0].trim();
    if (faskesCode) {
      const faskesName = lsData.health_centre_name ?? lsData.faskes_name ?? lsData.instance ?? "";
      const area = lsData.user_area ?? {};
      const userType = String(lsData.user_type ?? "").toUpperCase();
      const partnerCat = lsData.partner_category_code ?? (userType === "MITRA" ? "mitra" : userType === "FKTP" ? "klinik" : "");
      return {
        user: {
          user_id: String(lsData.id ?? lsData.user_id ?? ""),
          nik: String(lsData.nik ?? ""),
          fullname: lsData.name ?? lsData.fullname ?? "",
          faskes_code: faskesCode,
          partner_code: lsData.partner_code ?? "",
          partner_category_code: partnerCat
        },
        faskesCode,
        faskesName: String(faskesName),
        faskesLocation: {
          province_code: String(area.province?.code ?? ""),
          province_name: String(area.province?.name ?? ""),
          city_code: String(area.city?.code ?? ""),
          city_name: String(area.city?.name ?? ""),
          district_code: String(area.district?.code ?? ""),
          district_name: String(area.district?.name ?? "")
        }
      };
    }
  }

  let res = await getJson(tabId, ME_URL);
  if (res.status === 401) {
    await reloadCkgTab(tabId);
    res = await getJson(tabId, ME_URL);
  }
  const rawApiData = res.ok ? res.body?.data : null;
  const apiData =
    rawApiData && (rawApiData.organitazion_ihs || rawApiData.faskes_code) ? rawApiData : null;
  lsData = await getLocalStorageUser(tabId);
  const data = apiData || lsData;
  if (res.status === 401 && !data) {
    throw new Error("Sesi CKG kedaluwarsa (401) meski sudah dimuat ulang. Silakan login ulang di tab CKG.");
  }
  if (!data) {
    throw new Error(`Gagal membaca profil user (HTTP ${res.status}). Pastikan tab CKG sudah login.`);
  }
  const rawFaskes = data.organitazion_ihs ?? data.faskes_code ?? "";
  const faskesCode = String(rawFaskes).split(" ")[0].trim();
  const faskesName = data.health_centre_name ?? data.faskes_name ?? data.instance ?? "";
  if (!faskesCode) {
    throw new Error("faskes_code (organitazion_ihs) kosong di profil — akun ini mungkin tidak terikat faskes.");
  }
  const area = data.user_area ?? {};
  const userType = String(data.user_type ?? "").toUpperCase();
  const partnerCat = data.partner_category_code ?? (userType === "MITRA" ? "mitra" : userType === "FKTP" ? "klinik" : "");
  return {
    user: {
      user_id: String(data.id ?? data.user_id ?? ""),
      nik: String(data.nik ?? ""),
      fullname: data.name ?? data.fullname ?? "",
      faskes_code: faskesCode,
      partner_code: data.partner_code ?? "",
      partner_category_code: partnerCat
    },
    faskesCode,
    faskesName: String(faskesName),
    faskesLocation: {
      province_code: String(area.province?.code ?? ""),
      province_name: String(area.province?.name ?? ""),
      city_code: String(area.city?.code ?? ""),
      city_name: String(area.city?.name ?? ""),
      district_code: String(area.district?.code ?? ""),
      district_name: String(area.district?.name ?? "")
    }
  };
}

function parseBool(v) {
  return typeof v === "boolean" ? v : String(v ?? "").trim().toUpperCase() === "TRUE";
}

export async function checkNik(tabId, ckgUser, nik, isSchool = false) {
  return postWithAuthRetry(tabId, CHECK_NIK_URL, {
    user: ckgUser.user,
    nik: String(nik),
    faskes_code: ckgUser.faskesCode,
    is_school: parseBool(isSchool)
  });
}

export async function registerPre(tabId, ckgUser, patient, screeningDate, wali) {
  return postWithAuthRetry(tabId, REGISTER_PRE_URL, {
    user: ckgUser.user,
    nik: patient.nik,
    fullname: patient.fullname,
    birth_date: patient.birth_date,
    gender: patient.gender,
    phone_number: patient.phone_number,
    screening_date: screeningDate,
    wali: wali && wali.nik ? wali : null
  });
}

async function fetchTerritoryList(tabId, url, parentCode = null) {
  const key = `${url}|${parentCode ?? ""}`;
  if (territoryCache.has(key)) return territoryCache.get(key);
  const body = parentCode ? { parent_codes: parentCode, page: 1, limit: 999 } : { page: 1, limit: 999 };
  const res = await postWithAuthRetry(tabId, url, body);
  const list = Array.isArray(res.body?.data) ? res.body.data : [];
  if (list.length) territoryCache.set(key, list);
  return list;
}

function normAreaName(s) {
  return String(s ?? "")
    .toUpperCase()
    .replace(/\./g, " ")
    .replace(/\bKABUPATEN\b/g, "KAB")
    .replace(/\s+/g, " ")
    .trim();
}

function findTerritoryMatch(list, targetName) {
  if (!targetName || !list?.length) return null;
  const target = normAreaName(targetName);
  return (
    list.find(i => normAreaName(i.name) === target) ||
    list.find(i => normAreaName(i.name).includes(target) || target.includes(normAreaName(i.name))) ||
    null
  );
}

async function resolveSubdistrictName(tabId, districtCode, subDistrictCode) {
  if (!districtCode || !subDistrictCode) return "";
  const list = await fetchTerritoryList(tabId, SUBDISTRICT_URL, districtCode);
  const match = list.find(item => item.code === subDistrictCode);
  return match?.name ?? "";
}

async function resolveDomicileCodes(tabId, dom = {}) {
  const out = { ...dom };
  if (out.province_code && out.city_code && out.district_code && out.sub_district_code) {
    return out;
  }
  try {
    if (!out.province_code && out.province_name) {
      const provs = await fetchTerritoryList(tabId, PROVINCE_URL);
      const p = findTerritoryMatch(provs, out.province_name);
      if (p) {
        out.province_code = p.code;
        out.province_name = p.name;
      }
    }
    if (out.province_code && !out.city_code && out.city_name) {
      const cities = await fetchTerritoryList(tabId, CITY_URL, out.province_code);
      const c = findTerritoryMatch(cities, out.city_name);
      if (c) {
        out.city_code = c.code;
        out.city_name = c.name;
      }
    }
    if (out.city_code && !out.district_code && out.district_name) {
      const dists = await fetchTerritoryList(tabId, DISTRICT_URL, out.city_code);
      const d = findTerritoryMatch(dists, out.district_name);
      if (d) {
        out.district_code = d.code;
        out.district_name = d.name;
      }
    }
    if (out.district_code && !out.sub_district_code && out.sub_district_name) {
      const subs = await fetchTerritoryList(tabId, SUBDISTRICT_URL, out.district_code);
      const s = findTerritoryMatch(subs, out.sub_district_name);
      if (s) {
        out.sub_district_code = s.code;
        out.sub_district_name = s.name;
      }
    }
  } catch (err) {
    console.warn("[pendaftaranApi] resolveDomicileCodes warning:", err?.message || err);
  }
  return out;
}

async function resolveJobCode(tabId, rawJob, isSchool = false) {
  const clean = String(rawJob ?? "").trim().toLowerCase();
  if (isSchool && (!clean || clean.includes("pelajar") || clean.includes("siswa") || clean.includes("murid") || clean.includes("sekolah"))) {
    return "pelajar";
  }
  if (!clean) {
    return "belum-tidak-bekerja";
  }
  if (clean.includes("belum") || clean.includes("tidak bekerja")) {
    return "belum-tidak-bekerja";
  }
  if (clean === "mahasiswa") return "mahasiswa";
  if (clean.includes("rumah tangga") || clean === "irt") return "ibu-rumah-tangga";

  if (!cachedJobList) {
    try {
      const res = await postWithAuthRetry(tabId, LIST_JOB_URL, {});
      if (res.ok && Array.isArray(res.body?.data)) {
        cachedJobList = res.body.data;
      }
    } catch (_) {}
  }

  if (Array.isArray(cachedJobList) && cachedJobList.length) {
    const slug = clean.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const exact = cachedJobList.find(
      j => j.job_code === clean || j.job_code === slug || String(j.job_name || "").toLowerCase() === clean
    );
    if (exact) return exact.job_code;
    const partial = cachedJobList.find(
      j => String(j.job_name || "").toLowerCase().includes(clean) || clean.includes(String(j.job_name || "").toLowerCase())
    );
    if (partial) return partial.job_code;
  }

  return isSchool ? "pelajar" : "belum-tidak-bekerja";
}

function extractClassLevel(rawClass) {
  const s = String(rawClass ?? "").trim();
  if (!s) return null;

  // 1. Cek angka eksplisit di awal atau setelah kata "kelas" (mis. "Kelas 11", "11 IPA 1", "7A")
  const explicitNum = s.match(/^\s*(?:kelas\s*)?(1[0-2]|[1-9])(?:\b|[a-zA-Z\-])/i) ||
    s.match(/\bkelas\s*(1[0-2]|[1-9])\b/i);
  if (explicitNum) {
    return parseInt(explicitNum[1], 10);
  }

  // 2. Cek angka Romawi di awal atau sebagai token terpisah (mis. "X LISTRIK 1", "XI TKJ 2", "XII", "VIII A")
  const romanMap = [
    ["XII", 12],
    ["XI", 11],
    ["X", 10],
    ["IX", 9],
    ["VIII", 8],
    ["VII", 7],
    ["VI", 6],
    ["IV", 4],
    ["V", 5],
    ["III", 3],
    ["II", 2],
    ["I", 1]
  ];
  const upper = s.toUpperCase();
  const leadRoman = upper.match(/^(?:KELAS\s*)?(XII|XI|IX|VIII|VII|VI|IV|III|II|X|V|I)(?:\b|[\s\-_])/);
  if (leadRoman) {
    const found = romanMap.find(([r]) => r === leadRoman[1]);
    if (found) return found[1];
  }
  // Cek token Romawi di mana saja jika belum ketemu
  const tokens = upper.split(/[\s\-_\/]+/);
  for (const [roman, num] of romanMap) {
    if (tokens.includes(roman)) return num;
  }

  // 3. Fallback angka di mana saja (mis. "Rombel 5")
  const anyNum = s.match(/\b(1[0-2]|[1-9])\b/);
  return anyNum ? parseInt(anyNum[1], 10) : null;
}

async function resolveSchoolPayload(tabId, ckgUser, row) {
  if (!parseBool(row?.is_school)) return null;
  const schoolQuery = String(row.sekolah ?? row.nama_sekolah ?? row.school_name ?? "").trim();
  const classQuery = String(row.kelas ?? row.class_name ?? row.tingkat ?? row.rombel ?? row.jenjang ?? "").trim();
  if (!schoolQuery) return null;

  const faskesCode = ckgUser?.faskesCode || "";
  if (!schoolCache.has(faskesCode)) {
    const res = await postWithAuthRetry(tabId, LIST_SEKOLAH_URL, {
      search: "",
      faskes_code: faskesCode,
      page: 1,
      limit: 500
    }).catch(() => null);
    const list = res?.body?.data?.list || [];
    if (list.length) schoolCache.set(faskesCode, list);
  }

  let schools = schoolCache.get(faskesCode) || [];
  const norm = s => String(s ?? "").toLowerCase().replace(/\s+/g, " ").trim();
  const qNorm = norm(schoolQuery);
  let matchedSchool =
    schools.find(s => norm(s.school_name) === qNorm) ||
    schools.find(s => norm(s.school_name).includes(qNorm) || qNorm.includes(norm(s.school_name)));

  if (!matchedSchool) {
    const searchRes = await postWithAuthRetry(tabId, LIST_SEKOLAH_URL, {
      search: schoolQuery,
      faskes_code: faskesCode,
      page: 1,
      limit: 50
    }).catch(() => null);
    const list = searchRes?.body?.data?.list || [];
    matchedSchool = list.find(s => norm(s.school_name) === qNorm) || list[0] || null;
  }

  if (!matchedSchool) return null;

  const jenjangCode = matchedSchool.subjenis_01 || "";
  let classes = classCache.get(jenjangCode);
  if (!classes && jenjangCode) {
    const clsRes = await postWithAuthRetry(tabId, LIST_KELAS_URL, {
      search: "",
      jenjang_code: jenjangCode,
      page: 1,
      limit: 100
    }).catch(() => null);
    classes = clsRes?.body?.data?.list || [];
    if (classes.length) classCache.set(jenjangCode, classes);
  }
  classes = classes || [];
  const targetLevel = extractClassLevel(classQuery);
  const cNorm = norm(classQuery);
  let matchedClass = null;
  if (targetLevel !== null) {
    matchedClass = classes.find(c => extractClassLevel(c.kelas_name) === targetLevel) || null;
  }
  if (!matchedClass && cNorm) {
    matchedClass = classes.find(c => norm(c.kelas_name) === cNorm) || null;
  }
  if (!matchedClass) {
    matchedClass = classes[0];
  }

  return {
    code: matchedSchool.school_code,
    name: matchedSchool.school_name,
    class_code: matchedClass?.kelas_code || "",
    class_name: matchedClass?.kelas_name || "",
    category: jenjangCode,
    nisn: String(row.nisn ?? "").trim()
  };
}

export async function registerCkg(tabId, ckgUser, patient, opts) {
  const { screeningDate, hasDisability = false, wali, isFktp = false, patientSchool = null } = opts;
  const dom = await resolveDomicileCodes(tabId, patient.domicile ?? {});
  const subDistrictName =
    dom.sub_district_name || (await resolveSubdistrictName(tabId, dom.district_code, dom.sub_district_code));

  return postWithAuthRetry(
    tabId,
    REGISTER_CKG_URL,
    {
      user: ckgUser.user,
      channel: "WEB",
      faskes_code: ckgUser.faskesCode,
      faskes_name: ckgUser.faskesName,
      partner_code: ckgUser.user.partner_code ?? "",
      partner_name: "",
      partner_category_code: ckgUser.user.partner_category_code ?? "",
      is_fktp: isFktp,
      patient: {
        nik: patient.nik,
        fullname: patient.fullname,
        birth_date: patient.birth_date,
        gender: patient.gender,
        mobile_number: patient.phone_number,
        is_disability: !!hasDisability
      },
      patient_domicile: {
        address: dom.address ?? "",
        province_code: dom.province_code ?? "",
        province_name: dom.province_name ?? "",
        city_code: dom.city_code ?? "",
        city_name: dom.city_name ?? "",
        district_code: dom.district_code ?? "",
        district_name: dom.district_name ?? "",
        sub_district_code: dom.sub_district_code ?? "",
        sub_district_name: subDistrictName,
        postal_code: ""
      },
      patient_school: patientSchool ?? null,
      patient_job: patient.job?.code ?? "",
      marital_status: patient.marital_status?.code ?? patient.marital_status ?? "",
      screening_date: screeningDate,
      screening_location: ckgUser.faskesLocation ?? {
        province_code: "",
        province_name: "",
        city_code: "",
        city_name: "",
        district_code: "",
        district_name: ""
      },
      wali: wali && wali.nik ? wali : null,
      submitter: {
        nik: ckgUser.user.nik ?? "",
        name: ckgUser.user.fullname ?? ""
      }
    },
    { allowRetry: false }
  );
}

const MONTH_MAP = {
  1: "01", "01": "01", januari: "01", jan: "01",
  2: "02", "02": "02", februari: "02", feb: "02",
  3: "03", "03": "03", maret: "03", mar: "03",
  4: "04", "04": "04", april: "04", apr: "04",
  5: "05", "05": "05", mei: "05",
  6: "06", "06": "06", juni: "06", jun: "06",
  7: "07", "07": "07", juli: "07", jul: "07",
  8: "08", "08": "08", agustus: "08", agt: "08", aug: "08",
  9: "09", "09": "09", september: "09", sep: "09",
  10: "10", oktober: "10", okt: "10", oct: "10",
  11: "11", november: "11", nov: "11",
  12: "12", desember: "12", des: "12", dec: "12"
};

function parseBirthDateIso(row) {
  const pad = v => String(v).padStart(2, "0");
  const yr = String(row.tahunlahir ?? row.tahun ?? "").trim();
  const mo = String(row.bulanlahir ?? row.bulan ?? "").trim();
  const dy = String(row.tanggallahir ?? row.tanggal ?? "").trim();
  if (yr && mo && dy && !/[\/-]/.test(dy)) {
    return `${yr}-${MONTH_MAP[mo.toLowerCase()] ?? pad(mo)}-${pad(dy)}`;
  }

  const raw = row.tanggal_lahir ?? row.tgllahir ?? row.tanggallahir ?? row.tgl ?? row.birthdate ?? "";
  if (raw instanceof Date && !isNaN(raw.getTime())) {
    return `${raw.getFullYear()}-${pad(raw.getMonth() + 1)}-${pad(raw.getDate())}`;
  }
  const str = String(raw).trim();
  if (!str) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;

  const dmy = str.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})$/);
  if (dmy) return `${dmy[3]}-${pad(dmy[2])}-${pad(dmy[1])}`;

  const mdy = str.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{2})$/);
  if (mdy) {
    const yy = parseInt(mdy[3], 10);
    const fullY = yy > 30 ? 1900 + yy : 2000 + yy;
    return `${fullY}-${pad(mdy[1])}-${pad(mdy[2])}`;
  }

  const serial = parseFloat(str);
  if (!isNaN(serial) && serial > 1000 && !/[\/-]/.test(str)) {
    const adj = serial > 59 ? serial - 1 : serial;
    const d = new Date(Date.UTC(1900, 0, 1).valueOf() + 864e5 * (adj - 1));
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  }
  return "";
}

function normalizeGender(row) {
  const raw = String(row.jenis_kelamin ?? row.jeniskelamin ?? row.jk ?? row.gender ?? row.sex ?? "").trim().toLowerCase();
  if (!raw) return "";
  if (raw.startsWith("l") || raw === "1" || raw === "male") return "LAKI-LAKI";
  if (raw.startsWith("p") || raw === "2" || raw === "female") return "PEREMPUAN";
  return "";
}

function normalizePhone(row) {
  const raw = String(row.wa ?? row.nowhatsapp ?? row.no_wa ?? row.nowa ?? row.nohp ?? row.hp ?? row.telp ?? "").trim();
  if (!raw || raw === "-") return DEFAULT_FALLBACK_WA;
  const digits = raw.replace(/\D/g, "").replace(/^0+/, "");
  if (!digits || digits.length < 6) return DEFAULT_FALLBACK_WA;
  return digits.startsWith("62") ? digits : "62" + digits;
}

function getGenderFromNik(nik) {
  const clean = String(nik ?? "").replace(/\D/g, "");
  if (clean.length !== 16) return "";
  const dd = parseInt(clean.slice(6, 8), 10);
  if (Number.isNaN(dd)) return "";
  return dd >= 41 && dd <= 71 ? "PEREMPUAN" : dd >= 1 && dd <= 31 ? "LAKI-LAKI" : "";
}

function normalizeMaritalCode(raw) {
  const s = String(raw ?? "").trim().toLowerCase();
  if (!s) return "";
  if (s === "m" || s.includes("menikah") && !s.includes("belum")) return "M";
  if (s === "s" || s.includes("belum")) return "S";
  if (s === "d" || s.includes("cerai hidup")) return "D";
  if (s === "w" || s.includes("cerai mati")) return "W";
  return String(raw).trim();
}

export async function runPendaftaranApi(tabId, ckgUser, row, { dryRun = true } = {}) {
  const nik = String(row.nik ?? "").trim();
  const screeningDate = String(row.screening_date ?? "").trim();
  const hasWali = row.wali_nik && String(row.wali_nik).trim().length > 0;
  const wali = hasWali
    ? {
        nik: String(row.wali_nik).trim(),
        fullname: String(row.wali_fullname ?? ""),
        birth_date: String(row.wali_birth_date ?? ""),
        gender: String(row.wali_gender ?? ""),
        phone_number: String(row.wali_phone_number ?? "")
      }
    : null;

  const outcome = {
    nik,
    status: "error",
    stage: "",
    message: "",
    ticketNumber: null,
    regId: null
  };

  const checkRes = await checkNik(tabId, ckgUser, nik, row.is_school);
  let patientPayload = checkRes.body?.data;
  let usedExcelFallback = false;

  const checkCode = Number(checkRes.body?.statusCode ?? 0) || Number(checkRes.status ?? 0);
  const notFound = checkCode === 404;
  const serverErr = [500, 422, 502, 503, 504].includes(checkCode);

  if (notFound || serverErr) {
    patientPayload = {
      nik,
      fullname: sanitizeName(row.nama ?? row.name ?? row.namalengkap ?? row.namapasien ?? ""),
      birth_date: parseBirthDateIso(row),
      gender: normalizeGender(row),
      phone_number: normalizePhone(row),
      domicile: {
        address: String(row.alamat ?? row.detailalamat ?? row.address ?? "").trim(),
        province_name: String(row.provinsi ?? row.province ?? "").trim(),
        city_name: String(row.kab_kota ?? row.kabkota ?? row.kabupaten ?? row.kota ?? "").trim(),
        district_name: String(row.kecamatan ?? row.district ?? "").trim(),
        sub_district_name: String(row.kelurahan ?? row.desa ?? row.subdistrict ?? "").trim()
      },
      job: { code: String(row.pekerjaan ?? row.job ?? "").toLowerCase().includes("belum") ? "belum-tidak-bekerja" : String(row.pekerjaan ?? row.job ?? "") },
      marital_status: { code: normalizeMaritalCode(row.status_pernikahan ?? row.statusnikah ?? row.statusperkawinan ?? row.statusmenikah ?? row.maritalstatus ?? "") },
      _fromExcel: true
    };
    usedExcelFallback = true;

    const missing = ["fullname", "birth_date", "gender"].filter(k => !patientPayload[k]);
    if (missing.length) {
      const prefix = notFound ? "NIK belum terdaftar" : `check-nik error ${checkCode}`;
      outcome.stage = "check-nik";
      outcome.status = "error";
      outcome.message = `${prefix} dan data Excel tidak lengkap: ${missing.join(", ")}`;
      return outcome;
    }
  } else if (!patientPayload) {
    outcome.stage = "check-nik";
    outcome.status = "error";
    outcome.message = checkRes.body?.message || checkRes.error || `HTTP ${checkRes.status}`;
    return outcome;
  } else if (!patientPayload.phone_number) {
    patientPayload = { ...patientPayload, phone_number: normalizePhone(row) };
  }

  const RETRY_CODES = [500, 422, 502, 503, 504];
  let preRes;
  for (let attempt = 1; attempt <= 3; attempt++) {
    preRes = await registerPre(tabId, ckgUser, patientPayload, screeningDate, wali);
    const code = Number(preRes.body?.statusCode ?? preRes.status ?? 0);
    if (!RETRY_CODES.includes(code)) break;
    if (attempt < 3) {
      await new Promise(r => setTimeout(r, 1000 * attempt));
    }
  }

  let preData = preRes.body?.data;
  let validationCode = preData?.validation_code;

  // Jika fallback Excel mendapat INVALID_DATA padahal digit tanggal lahir NIK menunjukkan gender berbeda, coba koreksi 1x
  if (usedExcelFallback && validationCode === "INVALID_DATA") {
    const nikGender = getGenderFromNik(nik);
    if (nikGender && nikGender !== patientPayload.gender) {
      patientPayload = { ...patientPayload, gender: nikGender };
      preRes = await registerPre(tabId, ckgUser, patientPayload, screeningDate, wali);
      preData = preRes.body?.data;
      validationCode = preData?.validation_code;
    }
  }

  if (validationCode === "ALREADY_SCREENED") {
    outcome.stage = "register-pre";
    outcome.status = "already-screened";
    outcome.message = preData.reason ?? "Individu sudah menerima layanan";
    return outcome;
  }
  if (validationCode === "INVALID_DATA") {
    outcome.stage = "register-pre";
    outcome.status = "invalid-nik";
    outcome.message = preData.reason ?? "Data tidak valid";
    return outcome;
  }
  if (!preData?.is_valid || validationCode !== "VALID") {
    const code = Number(preRes.body?.statusCode ?? preRes.status ?? 0);
    const msg = preData?.reason || preRes.body?.data?.message || preRes.body?.message || preRes.error || `HTTP ${code}`;
    outcome.stage = "register-pre";
    outcome.status = "error";
    outcome.message = RETRY_CODES.includes(code)
      ? `Server bermasalah (${code}) setelah 3x percobaan: ${msg}`
      : `${msg}${validationCode ? ` | code: ${validationCode}` : ""}`;
    return outcome;
  }

  if (dryRun) {
    outcome.stage = "register-pre";
    outcome.status = "valid-dry-run";
    outcome.message = usedExcelFallback
      ? serverErr
        ? `Valid (data Excel; check-nik ${checkCode}) — belum disubmit (dry run)`
        : "Valid (data dari Excel) — belum disubmit (dry run)"
      : "Valid — belum disubmit (dry run)";
    return outcome;
  }

  const dDom = preData.detail?.domicile;
  const hasDetailDom = !!(dDom && (dDom.province_code || dDom.city_code || dDom.district_code || dDom.sub_district_code || dDom.address));
  const dJob = preData.detail?.job?.code ? preData.detail.job : patientPayload.job;
  const dMarital = preData.detail?.marital_status?.code ? preData.detail.marital_status : patientPayload.marital_status;

  const finalPatient = preData.detail
    ? {
        ...patientPayload,
        ...preData.detail,
        domicile: hasDetailDom ? dDom : patientPayload.domicile,
        job: dJob,
        marital_status: dMarital,
        phone_number: preData.detail.phone_number || patientPayload.phone_number || DEFAULT_FALLBACK_WA
      }
    : patientPayload;

  const resolvedJobCode = await resolveJobCode(
    tabId,
    finalPatient.job?.code || row.pekerjaan || row.job || "",
    parseBool(row.is_school)
  );
  finalPatient.job = { ...(finalPatient.job || {}), code: resolvedJobCode };

  const patientSchool = parseBool(row.is_school)
    ? await resolveSchoolPayload(tabId, ckgUser, row)
    : null;

  const SUBMIT_RETRY_CODES = [422, 500];
  let regRes;
  let verifiedAfter500 = false;

  for (let attempt = 0; attempt <= 2; attempt++) {
    regRes = await registerCkg(tabId, ckgUser, finalPatient, {
      screeningDate,
      hasDisability: parseBool(row.has_disability),
      wali,
      patientSchool
    });
    const code = Number(regRes.body?.statusCode ?? regRes.status ?? 0);
    if (!SUBMIT_RETRY_CODES.includes(code)) break;
    if (attempt >= 2) break;

    await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
    if (code === 500) {
      const verifyPre = await registerPre(tabId, ckgUser, finalPatient, screeningDate, wali);
      const vCode = verifyPre.body?.data?.validation_code;
      if (vCode === "ALREADY_SCREENED") {
        verifiedAfter500 = true;
        break;
      }
      if (vCode !== "VALID") break;
    }
  }

  const finalCode = Number(regRes.body?.statusCode ?? regRes.status ?? 0);
  const ok = regRes.ok && finalCode >= 200 && finalCode < 300;

  if (!ok && verifiedAfter500) {
    outcome.stage = "register-ckg";
    outcome.status = "done";
    outcome.message = "Terdaftar (server sempat error 500, terverifikasi sudah masuk — nomor tiket tidak diketahui)";
    return outcome;
  }

  if (!ok) {
    outcome.stage = "register-ckg";
    outcome.status = "error";
    if (finalCode === 401) {
      outcome.message = "Sesi kedaluwarsa saat submit — CEK MANUAL apakah pasien ini sudah terdaftar sebelum mengulang.";
    } else if (SUBMIT_RETRY_CODES.includes(finalCode)) {
      outcome.message =
        `Ditolak server (${finalCode}) setelah 2x percobaan ulang: ` +
        (regRes.body?.data?.message || regRes.body?.message || "Gagal memproses permintaan ke server");
    } else {
      outcome.message = regRes.body?.data?.message || regRes.body?.message || regRes.error || `HTTP ${finalCode}`;
    }
    return outcome;
  }

  const regData = regRes.body?.data ?? {};
  outcome.stage = "register-ckg";
  outcome.status = "done";
  outcome.ticketNumber = regData.ticket_number ?? null;
  outcome.regId = regData.reg_id ?? null;
  outcome.message = "Registrasi berhasil";
  return outcome;
}

export { postJson, postWithAuthRetry };
