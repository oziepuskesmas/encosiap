import * as SurveyImport from "./lib/survey.core.min.js";
import { postWithAuthRetry } from "./pendaftaranApi.js";
import { recordToFieldRules } from "./pelayananFormHelper.js";

const DETAIL_SCREENING_URL = "/api/pkg/ssi/detail-screening-ssi";
const LIST_KUNJUNGAN_UMUM_URL = "/api/pkg/ssi/list-kunjungan-umum";
const LIST_KUNJUNGAN_SEKOLAH_URL = "/api/pkg/ssi/list-kunjungan-sekolah";
const SET_STATUS_URL = "/api/pkg/ssi/set-status";
const SKIP_FORM_URL = "/api/pkg/skip-form";
const SENT_REPORT_URL = "/api/pkg/ssi/sent-report";

const FORM_BASE_URL = "https://form.kemkes.go.id";
const FORM_GET_ONE_URL = `${FORM_BASE_URL}/api/proxy/kes-screening/asik/screening/asik/form-get-one`;
const FORM_SUBMIT_URL = `${FORM_BASE_URL}/api/proxy/kes-screening/asik/screening/asik/form-submit`;
const FORM_SUBMIT_TATALAKSANA_URL = `${FORM_BASE_URL}/api/proxy/kes-screening/asik/screening/asik/intervensi-form-submit`;

const FALLBACK_KEYSET_STRING =
  '{"primaryKeyId":1635202106,"key":[{"keyData":{"typeUrl":"type.googleapis.com/google.crypto.tink.AesGcmKey","value":"GiBjNRuROYnzGjXh2hwlixQYDjNPoylOXOjtfqIL//F3Fg==","keyMaterialType":"SYMMETRIC"},"status":"ENABLED","keyId":1635202106,"outputPrefixType":"TINK"}]}';
const FALLBACK_AAD = "crpto-service-web-963";
const FALLBACK_BASIC_AUTH = "Basic a2VzcHJpbTo5SHBRb082b3hiQm01a2NhMThiYQ==";

const RADIO_AUTO_FALLBACK = [
  "tidak",
  "tidak ada",
  "negatif",
  "non reaktif",
  "non-reaktif",
  "normal",
  "sesuai usia",
  "sesuai",
  "non disabilitas",
  "mandiri",
  "sudah",
  "baik"
];

let cachedCryptoConfig = null;
let cachedCryptoPromise = null;
let global429CooldownUntil = 0;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function base64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    bytes[i] = bin.charCodeAt(i);
  }
  return bytes;
}

function bytesToBase64(bytes) {
  let bin = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(bin);
}

/**
 * Ekstrak raw AES-256 key (32 byte) dari protobuf AesGcmKey Tink.
 * Format protobuf AesGcmKey: field 3 (key_value) tag = 0x1a, length = 0x20 (32), diikuti 32 byte key.
 */
function extractAesKeyFromProtobuf(protoB64) {
  const raw = base64ToBytes(protoB64);
  if (raw.length >= 34 && raw[0] === 0x1a && raw[1] === 0x20) {
    return raw.slice(2, 34);
  }
  if (raw.length === 32 || raw.length === 16) {
    return raw;
  }
  for (let i = 0; i < raw.length - 33; i++) {
    if (raw[i] === 0x1a && raw[i + 1] === 0x20) {
      return raw.slice(i + 2, i + 34);
    }
  }
  throw new Error("Format protobuf AesGcmKey Tink tidak dikenali");
}

function unescapeJsString(str) {
  return str.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
}

async function loadFormCryptoConfig() {
  if (cachedCryptoConfig) return cachedCryptoConfig;
  if (cachedCryptoPromise) return cachedCryptoPromise;

  cachedCryptoPromise = (async () => {
    let keysetStr = FALLBACK_KEYSET_STRING;
    let aadStr = FALLBACK_AAD;
    let basicAuth = FALLBACK_BASIC_AUTH;

    try {
      const htmlResp = await fetch(`${FORM_BASE_URL}/skrining-form/test`, { cache: "no-store" });
      if (htmlResp.ok) {
        const html = await htmlResp.text();
        const chunkMatches = [...new Set([...html.matchAll(/\/_next\/static\/chunks\/[^"']+\.js/g)].map(m => m[0]))];
        for (const chunkPath of chunkMatches) {
          if (chunkPath.includes("webpack") || chunkPath.includes("main-app") || chunkPath.includes("polyfills")) {
            continue;
          }
          try {
            const jsResp = await fetch(`${FORM_BASE_URL}${chunkPath}`);
            if (!jsResp.ok) continue;
            const jsText = await jsResp.text();
            if (!jsText.includes("crpto-service-web") && !jsText.includes("KEYSET_STRING")) continue;

            const aadMatch = jsText.match(/AAD\|\|"([^"]+)"/);
            const keysetMatch = jsText.match(/KEYSET_STRING\|\|"((?:\\.|[^"\\])+)"/);
            const authMatch = jsText.match(/SSI_BASIC_AUTH\|\|"([^"]+)"/);

            if (aadMatch?.[1]) aadStr = aadMatch[1];
            if (keysetMatch?.[1]) keysetStr = unescapeJsString(keysetMatch[1]);
            if (authMatch?.[1]) {
              const rawAuth = authMatch[1];
              basicAuth = rawAuth.startsWith("Basic ") ? rawAuth : `Basic ${rawAuth}`;
            }
            break;
          } catch (_) {}
        }
      }
    } catch (err) {
      console.warn("[pelayananApi] Gagal fetch chunk crypto form.kemkes.go.id, pakai fallback:", err.message);
    }

    const keyset = JSON.parse(keysetStr);
    const primaryKeyId = Number(keyset.primaryKeyId);
    const activeKey =
      (keyset.key || []).find(k => Number(k.keyId) === primaryKeyId && k.status === "ENABLED") ||
      (keyset.key || [])[0];

    if (!activeKey?.keyData?.value) {
      throw new Error("Keyset Tink tidak memiliki keyData aktif");
    }

    const rawKeyBytes = extractAesKeyFromProtobuf(activeKey.keyData.value);
    const cryptoKey = await crypto.subtle.importKey(
      "raw",
      rawKeyBytes,
      { name: "AES-GCM" },
      false,
      ["encrypt", "decrypt"]
    );

    const aadBytes = new TextEncoder().encode(aadStr);
    const prefix = new Uint8Array(5);
    prefix[0] = 0x01;
    new DataView(prefix.buffer).setUint32(1, primaryKeyId >>> 0, false);

    cachedCryptoConfig = {
      primaryKeyId,
      prefix,
      cryptoKey,
      aadBytes,
      basicAuth
    };
    return cachedCryptoConfig;
  })();

  try {
    return await cachedCryptoPromise;
  } finally {
    cachedCryptoPromise = null;
  }
}

async function tinkEncrypt(plainObj) {
  const cfg = await loadFormCryptoConfig();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plainText = typeof plainObj === "string" ? plainObj : JSON.stringify(plainObj);
  const plainBytes = new TextEncoder().encode(plainText);

  const cipherBuf = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: cfg.aadBytes },
    cfg.cryptoKey,
    plainBytes
  );
  const cipherBytes = new Uint8Array(cipherBuf);
  const out = new Uint8Array(5 + 12 + cipherBytes.length);
  out.set(cfg.prefix, 0);
  out.set(iv, 5);
  out.set(cipherBytes, 17);
  return bytesToBase64(out);
}

async function tinkDecrypt(cipherB64) {
  const cfg = await loadFormCryptoConfig();
  const raw = base64ToBytes(cipherB64);
  if (raw.length <= 5 + 12 + 16) {
    throw new Error("Ciphertext Tink terlalu pendek");
  }
  const iv = raw.subarray(5, 17);
  const cipherBytes = raw.subarray(17);

  const plainBuf = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv, additionalData: cfg.aadBytes },
    cfg.cryptoKey,
    cipherBytes
  );
  const decoded = new TextDecoder().decode(plainBuf);
  return JSON.parse(decoded);
}

async function unwrapFormResponse(json) {
  let current = json;
  for (let depth = 0; depth < 3 && current && typeof current === "object"; depth++) {
    const ct =
      current?.data?.ciphertext ||
      current?.ciphertext ||
      (typeof current?.data === "string" && current.data.length > 20 ? current.data : null);
    if (!ct) break;

    const decrypted = await tinkDecrypt(ct);
    if (decrypted && typeof decrypted === "object" && "success" in decrypted) {
      current = decrypted;
    } else if (current?.data?.ciphertext || typeof current?.data === "string") {
      current = { ...current, data: decrypted };
    } else {
      current = decrypted;
    }
  }
  return current;
}

/**
 * Kirim request POST terenkripsi Tink ke form.kemkes.go.id dengan proteksi backoff 429.
 */
export async function formApiPost(url, payloadObj, { maxRetries = 3 } = {}) {
  const cfg = await loadFormCryptoConfig();
  const ciphertext = await tinkEncrypt(payloadObj);

  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    const remainingCooldown = global429CooldownUntil - Date.now();
    if (remainingCooldown > 0) {
      await sleep(remainingCooldown);
    }

    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: cfg.basicAuth
      },
      body: JSON.stringify({ ciphertext })
    });

    if (resp.status === 429) {
      if (attempt > maxRetries) {
        throw new Error(`Rate limit 429 dari form.kemkes.go.id setelah ${maxRetries}x retry`);
      }
      const waitMs = 15000 * attempt;
      global429CooldownUntil = Math.max(global429CooldownUntil, Date.now() + waitMs);
      console.warn(`[pelayananApi] HTTP 429 pada ${url}, global cooldown ${waitMs}ms (attempt ${attempt}/${maxRetries})`);
      await sleep(waitMs);
      continue;
    }

    const rawJson = await resp.json().catch(() => null);
    if (!resp.ok && !rawJson) {
      throw new Error(`HTTP ${resp.status} dari ${url}`);
    }
    const unwrapped = rawJson ? await unwrapFormResponse(rawJson) : null;
    if (!resp.ok) {
      throw new Error(unwrapped?.message || `HTTP ${resp.status} dari ${url}`);
    }
    return unwrapped;
  }
}

export function parsePemeriksaanLink(link) {
  const url = new URL(link);
  const parts = url.pathname.split("/").filter(Boolean);
  const pageId = decodeURIComponent(parts[parts.length - 1] || "");
  return {
    pageId,
    program_code: decodeURIComponent(url.searchParams.get("program_code") || ""),
    sub_program_code: decodeURIComponent(url.searchParams.get("sub_program_code") || ""),
    ctx: url.searchParams.get("ctx") || "",
    mitra: decodeURIComponent(url.searchParams.get("mitra") || "")
  };
}

function normText(s) {
  return String(s ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}

function findChoiceByCandidates(choices, candidates) {
  if (!Array.isArray(choices) || !choices.length) return null;
  const cleanCands = candidates.map(normText).filter(Boolean);
  for (const cand of cleanCands) {
    const exact = choices.find(c => normText(c.text) === cand || normText(c.value) === cand);
    if (exact) return exact;
    const partial = choices.find(c => normText(c.text).includes(cand));
    if (partial) return partial;
  }
  return null;
}

/**
 * Evaluasi form_json secara headless via Survey.Model (termasuk kondisi visibleIf)
 * dan petakan fieldRules ENCO ke format form_result { questionName: answerCode }.
 */
export function mapFieldRulesToFormResult(formJson, existingResult = null, fieldRules = []) {
  const SurveyLib =
    (globalThis.Survey?.Model ? globalThis.Survey : null) ||
    (SurveyImport?.Model ? SurveyImport : null) ||
    (SurveyImport?.default?.Model ? SurveyImport.default : null);
  if (!SurveyLib?.Model) {
    throw new Error("SurveyJS core (Survey.Model) belum dimuat");
  }

  const survey = new SurveyLib.Model(formJson);
  if (existingResult && typeof existingResult === "object") {
    survey.data = { ...existingResult };
  }

  const sortedRules = [...(fieldRules || [])].sort(
    (a, b) => (b.keyword?.length || 0) - (a.keyword?.length || 0)
  );
  const processed = new Set();

  for (let pass = 0; pass < 15; pass++) {
    let changed = false;
    const visibleQuestions = survey.getAllQuestions(true);

    for (const q of visibleQuestions) {
      if (processed.has(q.name)) continue;
      processed.add(q.name);
      changed = true;

      // Pertahankan jawaban yang sudah terisi sebelumnya jika tidak kosong
      if (q.value !== undefined && q.value !== null && q.value !== "" && (!Array.isArray(q.value) || q.value.length > 0)) {
        continue;
      }

      const qType = typeof q.getType === "function" ? q.getType() : q.type;
      const normTitle = normText(q.title || q.name || "");

      let matchedRule = sortedRules.find(r => normTitle.includes(normText(r.keyword)));
      if (matchedRule) {
        if (matchedRule.type === "radio" && qType !== "radiogroup" && qType !== "checkbox") {
          matchedRule = null;
        } else if (matchedRule.type === "dropdown" && qType !== "dropdown") {
          matchedRule = null;
        } else if (matchedRule.type === "input" && qType !== "text" && qType !== "comment") {
          matchedRule = null;
        }
      }

      if (qType === "radiogroup") {
        const candidates = matchedRule
          ? (Array.isArray(matchedRule.labels) ? matchedRule.labels : [matchedRule.label]).filter(Boolean)
          : RADIO_AUTO_FALLBACK;

        let chosen = findChoiceByCandidates(q.choices, candidates);
        if (!chosen && !matchedRule && Array.isArray(q.choices) && q.choices.length > 0) {
          chosen = q.choices.length > 1 ? q.choices[1] : q.choices[0];
        }
        if (chosen) {
          q.value = chosen.value;
        }
      } else if (qType === "dropdown") {
        let chosen = null;
        if (matchedRule?.label) {
          chosen = findChoiceByCandidates(q.choices, [matchedRule.label]);
        }
        if (!chosen && q.isRequired && Array.isArray(q.choices) && q.choices.length > 0) {
          chosen = findChoiceByCandidates(q.choices, RADIO_AUTO_FALLBACK) || q.choices[0];
        }
        if (chosen) {
          q.value = chosen.value;
        }
      } else if (qType === "checkbox") {
        const candidates = matchedRule
          ? (Array.isArray(matchedRule.labels) ? matchedRule.labels : [matchedRule.label]).filter(Boolean)
          : RADIO_AUTO_FALLBACK;
        const chosen = findChoiceByCandidates(q.choices, candidates);
        if (chosen) {
          q.value = [chosen.value];
        }
      } else if (qType === "text" || qType === "comment") {
        if (matchedRule && matchedRule.value !== undefined && matchedRule.value !== "") {
          const rawStr = String(matchedRule.value).trim();
          if (q.inputType === "number") {
            const num = Number(rawStr);
            q.value = Number.isNaN(num) ? rawStr : num;
          } else {
            q.value = rawStr;
          }
        } else if (
          q.inputType === "number" &&
          (q.isRequired || q.validators?.some?.(v => typeof v.minValue === "number"))
        ) {
          // Fallback aman untuk input angka wajib / ber-validator yang belum ada rule spesifik (mis. Rapid Test Hb Balita / M-CHAT)
          if (normTitle.includes("hb") || normTitle.includes("hemoglobin")) {
            q.value = 12;
          } else {
            const numVal = q.validators?.find?.(v => typeof v.minValue === "number" || typeof v.maxValue === "number");
            if (numVal && typeof numVal.minValue === "number") {
              q.value = numVal.minValue;
            } else if (numVal && typeof numVal.maxValue === "number") {
              q.value = Math.min(1, numVal.maxValue);
            } else {
              q.value = 1;
            }
          }
        }
      }
    }

    if (!changed) break;
  }

  return {
    formResult: { ...(survey.data || {}) },
    visibleCount: survey.getAllQuestions(true).length
  };
}

export async function resolveRegId(tabId, { regId, ticketNumber, nik, faskesCode, userId = "", isSchool = false, screeningDate } = {}) {
  if (regId) return regId;
  const endpoint = isSchool ? LIST_KUNJUNGAN_SEKOLAH_URL : LIST_KUNJUNGAN_UMUM_URL;
  const today = screeningDate || new Date().toISOString().slice(0, 10);

  const buildPayload = (useNikFallback = false) => {
    if (isSchool) {
      return {
        user_id: userId || "",
        faskes_code: faskesCode,
        page: 1,
        limit: 20,
        school_code: "",
        class_code: "",
        status: "",
        ticket_number: useNikFallback ? "" : (ticketNumber || ""),
        patient_name: "",
        patient_nik: useNikFallback || !ticketNumber ? (nik || "") : ""
      };
    }
    return {
      page: 1,
      limit: 20,
      faskes_code: faskesCode,
      screening_start_date: today,
      screening_end_date: today,
      patient_name: "",
      patient_nik: useNikFallback || !ticketNumber ? (nik || "") : "",
      ticket_number: useNikFallback ? "" : (ticketNumber || ""),
      status: "",
      partner_code: ""
    };
  };

  const extractRows = res => {
    const rawData = res?.body?.data;
    if (Array.isArray(rawData?.list)) return rawData.list;
    if (Array.isArray(rawData?.data)) return rawData.data;
    if (Array.isArray(rawData)) return rawData;
    return [];
  };

  let res = await postWithAuthRetry(tabId, endpoint, buildPayload(false));
  if (!res.ok) {
    throw new Error(res.body?.message || res.error || `Gagal mencari pasien di daftar kunjungan (${res.status})`);
  }

  let rows = extractRows(res);
  if (!rows.length && ticketNumber && nik) {
    res = await postWithAuthRetry(tabId, endpoint, buildPayload(true));
    if (res.ok) rows = extractRows(res);
  }

  const match =
    rows.find(
      r =>
        (ticketNumber && r.ticket_number === ticketNumber) ||
        (nik && (r.patient?.nik === nik || r.nik === nik))
    ) || rows[0];

  if (!match?.reg_id) {
    throw new Error(`reg_id tidak ditemukan untuk tiket=${ticketNumber || "-"} nik=${nik || "-"}`);
  }
  return match.reg_id;
}

export function collectFormsFromDetail(detailData) {
  const seen = new Set();
  const items = [];

  const pushItem = (item, layananCode = "") => {
    const link = item?.pemeriksaan_link || item?.form_link || "";
    const code = item?.pemeriksaan_code || item?.form_code || "";
    const dedupKey = link || code;
    if (!dedupKey || seen.has(dedupKey)) return;
    seen.add(dedupKey);
    items.push({
      code,
      layananCode: item?.layanan_code || layananCode || "",
      name: item?.pemeriksaan_name || item?.form_name || code,
      link,
      isSubmitted: !!item?.is_submit_form,
      isSkipped: !!item?.is_skip
    });
  };

  for (const f of detailData?.screening_forms || []) {
    pushItem(f);
  }
  for (const layanan of detailData?.screening_layanan || []) {
    const lCode = layanan?.layanan_code || "";
    for (const p of layanan?.list_pemeriksaan || []) {
      pushItem(p, lCode);
    }
  }
  return items;
}

function formatBirthDateForReport(rawDate) {
  if (!rawDate) return "";
  const s = String(rawDate).trim();
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  return s;
}

/**
 * Jalankan alur Pelayanan Pemeriksaan 100% via API (tanpa DOM/klik browser).
 */
export async function runPelayananApi(tabId, patient = {}, options = {}) {
  const {
    ckgUser,
    regId: initialRegId = null,
    ticketNumber: initialTicket = null,
    isSchool = false,
    screeningDate = null,
    dryRun = false,
    fieldRules: providedRules = null,
    skipItems = [],
    interFormDelayMs = 400,
    onProgress = null
  } = options;

  const faskesCode = ckgUser?.faskesCode || ckgUser?.faskes_code || "";
  const userId = ckgUser?.user?.id || ckgUser?.userId || "";
  const regId = await resolveRegId(tabId, {
    regId: initialRegId || patient.reg_id || patient.regId,
    ticketNumber: initialTicket || patient.nomorTiket || patient.ticket_number,
    nik: patient.nik,
    faskesCode,
    userId,
    isSchool,
    screeningDate
  });

  // 1. Ambil detail skrining awal
  const detailRes = await postWithAuthRetry(tabId, DETAIL_SCREENING_URL, { reg_id: regId });
  if (!detailRes.ok || !detailRes.body?.data) {
    throw new Error(detailRes.body?.message || detailRes.error || `Gagal mengambil detail skrining (${detailRes.status})`);
  }

  const detailData = detailRes.body.data;
  const ticketNumber = detailData.ticket_number || initialTicket || patient.nomorTiket || "";
  const patientDetail = detailData.patient_detail || {};
  const serviceStatus = String(detailData.service_status || "").toLowerCase();

  // Jika layanan sudah selesai di server, langsung kembalikan sukses
  if (serviceStatus.includes("selesai") && Number(detailData.screening_count_done) >= Number(detailData.screening_count_all || 0)) {
    return {
      status: "done",
      alreadyDone: true,
      regId,
      ticketNumber,
      submittedCount: 0,
      failedForms: []
    };
  }

  // 2. Mulai layanan jika belum dimulai
  if (!dryRun && !serviceStatus.includes("sedang") && !serviceStatus.includes("selesai")) {
    const startPayload = {
      faskes_code: faskesCode,
      reg_id: regId,
      status_code: "layanan-mulai",
      backdate: screeningDate || ""
    };
    const startRes = await postWithAuthRetry(tabId, SET_STATUS_URL, startPayload);
    if (!startRes.ok) {
      console.warn("[pelayananApi] set-status layanan-mulai warning:", startRes.status, startRes.body);
    }
  }

  // 3. Siapkan fieldRules dari data pasien + ckg_ranges
  let fieldRules = providedRules;
  if (!fieldRules) {
    const { ckg_ranges: sRanges = {} } = await chrome.storage.local.get("ckg_ranges");
    const enrichedPatient = {
      ...patient,
      nama: patient.nama || patientDetail.fullname || "",
      nik: patient.nik || patientDetail.nik || "",
      tanggal_lahir: patient.tanggal_lahir || patientDetail.birth_date || "",
      jenis_kelamin: patient.jenis_kelamin || patientDetail.gender || "",
      jenisKelamin: patient.jenisKelamin || patientDetail.gender || ""
    };
    fieldRules = await recordToFieldRules(enrichedPatient, sRanges);
  }

  // 4. Kumpulkan daftar form yang belum selesai
  const allForms = collectFormsFromDetail(detailData);
  const pendingForms = allForms.filter(f => !f.isSubmitted && !f.isSkipped && f.link);
  const skipSet = new Set((skipItems || []).map(normText));

  const submittedForms = [];
  const failedForms = [];
  const dryRunForms = [];

  for (let i = 0; i < pendingForms.length; i++) {
    const item = pendingForms[i];
    if (typeof onProgress === "function") {
      try {
        onProgress(i, pendingForms.length, item.name);
      } catch (_) {}
    }

    // Jika item termasuk daftar skip
    if (skipSet.has(normText(item.name)) && item.layananCode && item.code) {
      if (!dryRun) {
        await postWithAuthRetry(tabId, SKIP_FORM_URL, {
          reg_id: regId,
          layanan_code: item.layananCode,
          pemeriksaan_code: item.code
        }).catch(err => console.warn(`[pelayananApi] skip-form gagal (${item.name}):`, err));
      }
      continue;
    }

    try {
      const { pageId, program_code, sub_program_code, ctx, mitra } = parsePemeriksaanLink(item.link);
      const startDate = new Date().toISOString();

      const getOnePayload = ctx ? { id: pageId, ctx } : { id: pageId };
      const formResp = await formApiPost(FORM_GET_ONE_URL, getOnePayload);
      const formData = formResp?.data;
      if (!formResp?.success || !formData?.form_json) {
        throw new Error(formResp?.message || `form_json kosong untuk ${item.name}`);
      }

      const { formResult, visibleCount } = mapFieldRulesToFormResult(
        formData.form_json,
        formData.form_result,
        fieldRules
      );

      if (dryRun) {
        dryRunForms.push({
          name: item.name,
          pageId,
          visibleCount,
          formResult
        });
        await sleep(150);
        continue;
      }

      const effectiveProgramCode = String(formData.program_code || program_code || "");
      const submitUrl =
        effectiveProgramCode.toLowerCase().trim() === "tatalaksana"
          ? FORM_SUBMIT_TATALAKSANA_URL
          : FORM_SUBMIT_URL;

      const submitPayload = {
        id: pageId,
        program_code: effectiveProgramCode,
        sub_program_code: formData.sub_program_code || sub_program_code || "",
        start_date: startDate,
        end_date: new Date().toISOString(),
        form_result: formResult
      };
      if (mitra) submitPayload.mitra = mitra;

      const submitResp = await formApiPost(submitUrl, submitPayload);
      if (!submitResp?.success) {
        throw new Error(submitResp?.message || `form-submit gagal untuk ${item.name}`);
      }

      submittedForms.push(item.name);
      // Jeda adaptif antar form untuk mencegah rate limit 429 Cloudflare
      await sleep(interFormDelayMs + Math.floor(Math.random() * 250));
    } catch (err) {
      console.error(`[pelayananApi] Gagal memproses form "${item.name}":`, err);
      failedForms.push({ name: item.name, error: err.message });
    }
  }

  if (dryRun) {
    return {
      status: "dry-run",
      regId,
      ticketNumber,
      totalForms: allForms.length,
      pendingCount: pendingForms.length,
      dryRunForms,
      failedForms
    };
  }

  if (failedForms.length > 0) {
    return {
      status: "partial",
      regId,
      ticketNumber,
      submittedCount: submittedForms.length,
      failedForms
    };
  }

  // 5. Selesaikan layanan
  const finishPayload = {
    faskes_code: faskesCode,
    reg_id: regId,
    status_code: "layanan-selesai",
    backdate: screeningDate || ""
  };
  const finishRes = await postWithAuthRetry(tabId, SET_STATUS_URL, finishPayload);
  if (!finishRes.ok) {
    throw new Error(finishRes.body?.message || finishRes.error || `Gagal menyelesaikan layanan (${finishRes.status})`);
  }

  // 6. Kirim laporan akhir (non-fatal jika sudah pernah terkirim)
  const birthDate = formatBirthDateForReport(patientDetail.birth_date || patient.tanggal_lahir);
  if (ticketNumber && birthDate) {
    await postWithAuthRetry(tabId, SENT_REPORT_URL, {
      ticket_number: ticketNumber,
      birth_date: birthDate,
      is_final: false
    }).catch(err => console.warn("[pelayananApi] sent-report warning:", err));
  }

  return {
    status: "done",
    regId,
    ticketNumber,
    submittedCount: submittedForms.length,
    failedForms: []
  };
}

/**
 * Ambil daftar pasien 'Belum Pemeriksaan' dan/atau 'Sedang Pemeriksaan' langsung via API ASIK.
 */
export async function fetchPendingPatientsApi(tabId, options = {}) {
  const {
    ckgUser,
    isSchool = false,
    includeBelum = true,
    includeSedang = true,
    screeningStartDate = null,
    screeningEndDate = null,
    maxPagesPerTab = 100
  } = options;

  const faskesCode = ckgUser?.faskesCode || ckgUser?.faskes_code || "";
  const userId = ckgUser?.user?.id || ckgUser?.userId || "";
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 86400000).toISOString().slice(0, 10);
  const startDate = screeningStartDate || (isSchool ? today : thirtyDaysAgo);
  const endDate = screeningEndDate || today;

  const statuses = [];
  if (includeBelum) {
    statuses.push({ code: isSchool ? "hadir" : "pendaftaran", label: "Belum Pemeriksaan" });
  }
  if (includeSedang) {
    statuses.push({ code: "layanan-mulai", label: "Sedang Pemeriksaan" });
  }

  const endpoint = isSchool ? LIST_KUNJUNGAN_SEKOLAH_URL : LIST_KUNJUNGAN_UMUM_URL;
  const seen = new Set();
  const patients = [];

  for (const st of statuses) {
    for (let page = 1; page <= maxPagesPerTab; page++) {
      const payload = isSchool
        ? {
            user_id: userId,
            faskes_code: faskesCode,
            page,
            limit: 100,
            school_code: "",
            class_code: "",
            status: st.code,
            ticket_number: "",
            patient_name: "",
            patient_nik: ""
          }
        : {
            page,
            limit: 100,
            faskes_code: faskesCode,
            screening_start_date: startDate,
            screening_end_date: endDate,
            patient_name: "",
            patient_nik: "",
            ticket_number: "",
            status: st.code,
            partner_code: ""
          };

      const res = await postWithAuthRetry(tabId, endpoint, payload);
      if (!res.ok) {
        throw new Error(res.body?.message || res.error || `Gagal membaca antrean ${st.label} (${res.status})`);
      }

      const rawData = res.body?.data;
      const list = Array.isArray(rawData?.list)
        ? rawData.list
        : Array.isArray(rawData?.data)
          ? rawData.data
          : [];
      const totalData = Number(rawData?.meta?.total_data ?? 0);
      const totalPage = Number(rawData?.meta?.total_page ?? 0);
      const effectiveLimit = Number(rawData?.meta?.limit ?? 0) || list.length || 10;

      if (!list.length) break;

      for (const item of list) {
        const regId = item?.reg_id || "";
        const dedup = regId || item?.ticket_number || item?.patient?.nik;
        if (!dedup || seen.has(dedup)) continue;
        seen.add(dedup);

        const pInfo = item?.patient || {};
        const sInfo = item?.school || item?.patient_school || {};
        patients.push({
          id: regId || `asik_${item?.ticket_number || Date.now()}`,
          reg_id: regId,
          nama: String(pInfo.fullname || "").trim(),
          nik: String(pInfo.nik || "").trim(),
          nomorTiket: String(item?.ticket_number || "").trim(),
          tanggalLahir: String(pInfo.birth_date || "").trim(),
          jenisKelamin: String(pInfo.gender || "").toLowerCase().includes("perempuan") ? "perempuan" : "laki-laki",
          sekolah: String(sInfo.school_name || sInfo.name || "").trim(),
          kelas: String(sInfo.class_name || "").trim(),
          unitPelayanan: String(sInfo.school_name || sInfo.name || item?.partner_name || "").trim(),
          sourceTab: st.label,
          isSchool: !!isSchool
        });
      }

      if (totalPage > 0) {
        if (page >= totalPage) break;
      } else if (totalData > 0) {
        if (page * effectiveLimit >= totalData) break;
      } else if (list.length < 10) {
        break;
      }
    }
  }

  return patients;
}
