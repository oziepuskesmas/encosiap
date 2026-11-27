import { getFieldConfig as a } from "./remoteConfig.js";
import { buildFieldRules as e } from "./fieldConfig.js";

export function parseAgeFromPatient(patient) {
  if (!patient) return 35;
  const rawDate = patient.tanggal_lahir || patient.tanggalLahir || patient.tanggallahir || patient.tgllahir || patient.tglLahir || patient.bornDate || patient.dob;
  if (rawDate) {
    if (rawDate instanceof Date && !isNaN(rawDate.getTime())) {
      const now = new Date();
      let age = now.getFullYear() - rawDate.getFullYear();
      const m = now.getMonth() - rawDate.getMonth();
      if (m < 0 || (m === 0 && now.getDate() < rawDate.getDate())) age--;
      return age;
    }
    const str = String(rawDate).trim();
    const umurMatch = str.match(/(\d+)\s*(?:tahun|thn)/i);
    if (umurMatch) return parseInt(umurMatch[1], 10);

    const num = parseFloat(str);
    if (!isNaN(num) && num > 1000 && !/[\/\-]/.test(str)) {
      const ms = 86400000 * ((num > 59 ? num - 1 : num) - 1);
      const d = new Date(Date.UTC(1900, 0, 1) + ms);
      const now = new Date();
      let age = now.getFullYear() - d.getUTCFullYear();
      const m = now.getMonth() - d.getUTCMonth();
      if (m < 0 || (m === 0 && now.getDate() < d.getUTCDate())) age--;
      return age;
    }

    const isoMatch = str.match(/^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})/);
    if (isoMatch) {
      const y = parseInt(isoMatch[1], 10);
      const m = parseInt(isoMatch[2], 10) - 1;
      const d = parseInt(isoMatch[3], 10);
      const now = new Date();
      let age = now.getFullYear() - y;
      const diffM = now.getMonth() - m;
      if (diffM < 0 || (diffM === 0 && now.getDate() < d)) age--;
      return age;
    }

    const dmyMatch = str.match(/^(\d{1,2})[-\/](\d{1,2})[-\/](\d{4})/);
    if (dmyMatch) {
      const d = parseInt(dmyMatch[1], 10);
      const m = parseInt(dmyMatch[2], 10) - 1;
      const y = parseInt(dmyMatch[3], 10);
      const now = new Date();
      let age = now.getFullYear() - y;
      const diffM = now.getMonth() - m;
      if (diffM < 0 || (diffM === 0 && now.getDate() < d)) age--;
      return age;
    }

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
      return age;
    }
  }

  const rawUmur = patient.umur || patient.age;
  if (rawUmur) {
    const m = String(rawUmur).match(/(\d+)/);
    if (m) return parseInt(m[1], 10);
  }

  const kat = String(patient.kategori || patient.category || "").toLowerCase();
  if (kat.includes("lansia")) return 65;
  if (kat.includes("remaja")) return 15;
  return 35;
}

export function getDynamicDemographicRules(patient) {
  if (!patient) return [];
  const age = parseAgeFromPatient(patient);
  const genStr = String(patient.jenis_kelamin || patient.jenisKelamin || patient.gender || patient.jk || "").toLowerCase();
  const isFemale = genStr.includes("perempuan") || genStr.includes("wanita") || genStr === "p";
  const genderAPCS = isFemale ? "Perempuan" : "Laki-Laki";

  // Usia - skor APCS:
  // In Faktor Risiko Kanker Usus: "<50 tahun", "50 - 69 tahun", ">= 70 tahun"
  // In Skrining Kanker Paru: "<45 thn", "45-65 thn", ">65 tahun"
  const usiaAPCS_KankerUsus = age >= 70 ? ">= 70 tahun" : age >= 50 ? "50 - 69 tahun" : "<50 tahun";
  const usiaAPCS_KankerParu = age > 65 ? ">65 tahun" : age >= 45 ? "45-65 thn" : "<45 thn";

  // Usia - skor PUMA: "40-49", "50-59", "=>60"
  const usiaPUMA = age >= 60 ? "=>60" : age >= 50 ? "50-59" : "40-49";

  const patientAge = Math.max(40, age);
  const kreatininVal = patient.kreatinin || (Math.random() > 0.5 ? "0.8" : "0.7");
  const ureumVal = patient.ureum || String(Math.floor(Math.random() * 7) + 22);
  const elfgVal = patient.elfg || String(Math.floor(Math.random() * 10) + 92);
  const kolesterolVal = patient.kolesterol || String(Math.floor(Math.random() * 25) + 160);
  const hdlVal = patient.hdl || String(Math.floor(Math.random() * 15) + 50);
  const ldlVal = patient.ldl || String(Math.floor(Math.random() * 20) + 85);
  const trigliseridaVal = patient.trigliserida || String(Math.floor(Math.random() * 25) + 110);
  const albuminUrinVal = patient.albumin_urin || String(Math.floor(Math.random() * 7) + 12);
  const kreatininUrinVal = patient.kreatinin_urin || String(Math.floor(Math.random() * 30) + 85);

  return [
    {
      keyword: "Usia - skor APCS",
      type: "radio",
      label: usiaAPCS_KankerUsus,
      labels: [usiaAPCS_KankerUsus, usiaAPCS_KankerParu]
    },
    {
      keyword: "Jenis Kelamin - skor APCS",
      type: "radio",
      label: genderAPCS,
      labels: [genderAPCS]
    },
    {
      keyword: "Usia - skor PUMA",
      type: "radio",
      label: usiaPUMA,
      labels: [usiaPUMA]
    },
    // Skrining Fungsi Ginjal
    { keyword: "Hasil Pemeriksaan Kreatinin", type: "input", value: kreatininVal },
    { keyword: "Pemeriksaan Kreatinin", type: "input", value: kreatininVal },
    { keyword: "Hasil Pemeriksaan Ureum", type: "input", value: ureumVal },
    { keyword: "Pemeriksaan Ureum", type: "input", value: ureumVal },
    { keyword: "Nilai Hasil pemeriksaan (e-LFG (CKD-EPI))", type: "input", value: elfgVal },
    { keyword: "Hasil pemeriksaan (e-LFG", type: "input", value: elfgVal },
    { keyword: "e-LFG (CKD-EPI)", type: "input", value: elfgVal },
    { keyword: "e-LFG", type: "input", value: elfgVal },
    { keyword: "CKD-EPI", type: "input", value: elfgVal },
    { keyword: "Usia", type: "input", value: String(patientAge) },
    // POCT Lipid Panel
    { keyword: "Kolesterol Total", type: "input", value: kolesterolVal },
    { keyword: "HDL", type: "input", value: hdlVal },
    { keyword: "LDL", type: "input", value: ldlVal },
    { keyword: "Trigliserida", type: "input", value: trigliseridaVal },
    // Skrining Kerusakan Ginjal
    { keyword: "Konsentrasi Albumin Urin", type: "input", value: albuminUrinVal },
    { keyword: "Albumin Urin", type: "input", value: albuminUrinVal },
    { keyword: "Konsentrasi Kreatinin Urin", type: "input", value: kreatininUrinVal },
    { keyword: "Kreatinin Urin", type: "input", value: kreatininUrinVal },
    // Skrining Hati / Hepatitis (Semua Normal = Tidak)
    { keyword: "Apakah Anda pernah menjalani tes untuk Hepatitis B dan mendapatkan hasil positif", type: "radio", label: "Tidak" },
    { keyword: "Apakah Anda memiliki ibu kandung/saudara sekandung yang menderita Hepatitis B", type: "radio", label: "Tidak" },
    { keyword: "Apakah anda pernah berhubungan seksual berisiko/tanpa pengaman", type: "radio", label: "Tidak" },
    { keyword: "Apakah Anda pernah menerima transfusi darah sebelumnya", type: "radio", label: "Tidak" },
    { keyword: "Apakah Anda pernah menjalani cuci darah atau hemodialisis", type: "radio", label: "Tidak" },
    { keyword: "Apakah Anda pernah menggunakan narkoba, obat terlarang", type: "radio", label: "Tidak" },
    { keyword: "Apakah Anda adalah orang dengan HIV (ODHIV)", type: "radio", label: "Tidak" },
    { keyword: "Apakah Anda pernah mendapatkan pengobatan Hepatitis C dan tidak sembuh", type: "radio", label: "Tidak" },
    { keyword: "Apakah Anda pernah didiagnosa atau mendapatkan hasil pemeriksaan kolesterol (lemak darah) tinggi", type: "radio", label: "Tidak" }
  ];
}

export async function recordToFieldRules(t, n = {}) {
  const i = await a(),
    r = a => (a ?? "").toLowerCase().trim(),
    s = {
      "dewasa-laki-laki": { beratBadan: [55, 85], tinggiBadan: [158, 175], lingkarPerut: [75, 100], sistolik: [110, 130], diastolik: [70, 85], gulaDarah: [80, 150] },
      "dewasa-perempuan": { beratBadan: [45, 70], tinggiBadan: [148, 165], lingkarPerut: [65, 95], sistolik: [105, 125], diastolik: [65, 82], gulaDarah: [80, 150] },
      "remaja-laki-laki": { beratBadan: [40, 70], tinggiBadan: [150, 175], lingkarPerut: [60, 85], sistolik: [100, 120], diastolik: [65, 80], gulaDarah: [80, 150] },
      "remaja-perempuan": { beratBadan: [38, 60], tinggiBadan: [145, 163], lingkarPerut: [58, 80], sistolik: [100, 118], diastolik: [63, 78], gulaDarah: [80, 150] },
      "lansia-laki-laki": { beratBadan: [50, 80], tinggiBadan: [155, 170], lingkarPerut: [75, 100], sistolik: [120, 145], diastolik: [75, 90], gulaDarah: [80, 150] },
      "lansia-perempuan": { beratBadan: [45, 70], tinggiBadan: [145, 163], lingkarPerut: [68, 92], sistolik: [115, 140], diastolik: [72, 88], gulaDarah: [80, 150] }
    };
  const ageNum = parseAgeFromPatient(t);
  const l = ageNum < 18 ? "remaja" : ageNum >= 60 ? "lansia" : "dewasa";
  const o = r(t.jenis_kelamin || t.jenisKelamin).includes("perempuan") ? "perempuan" : "laki-laki";
  const u = `${l}-${o}`;
  const d = (void 0 !== n[u] ? n[u] : s[u]) ?? s["dewasa-laki-laki"];
  console.log("[recordToFieldRules] rangeData provided:", Object.keys(n).length > 0);
  console.log("[recordToFieldRules] comboKey:", u);
  console.log("[recordToFieldRules] rangeConfig:", d);
  const g = (a, e) => {
    const raw = String(a ?? "").trim();
    const num = Number(raw);
    if (!raw || raw === "-" || Number.isNaN(num) || num <= 0) {
      const [min, max] = d[e] ?? [80, 150];
      console.log(`[recordToFieldRules] getRandomInRange(${e}):`, { min, max });
      return String(Math.floor(Math.random() * (max - min + 1)) + min);
    }
    return raw;
  };
  const hbRaw = String(t.hb ?? "").trim();
  const hbNum = Number(hbRaw);
  const c = new Map;
  if (
    c.set("berat-badan", g(t.bb, "beratBadan")),
    c.set("tinggi-badan", g(t.tb, "tinggiBadan")),
    c.set("lingkar-perut", g(t.lp, "lingkarPerut")),
    c.set("tekanan-darah-sistolik", g(t.td_sistolik, "sistolik")),
    c.set("tekanan-darah-diastolik", g(t.td_diastolik, "diastolik")),
    c.set("gula-darah", g(t.gula_darah, "gulaDarah")),
    hbRaw && hbRaw !== "-" && !Number.isNaN(hbNum) && hbNum > 0 && c.set("hb", hbRaw),
    t.merokok
  ) {
    const a = r(t.merokok);
    c.set("merokok", a.includes("ya") ? "ya" : "tidak"), a.includes("tidak") && c.set("pernah-merokok", "tidak");
  }
  {
    const a = r(t.status_pernikahan);
    console.log("[recordToFieldRules] status_pernikahan raw:", t.status_pernikahan, "normalized:", a);
    a.includes("belum") ? c.set("status-menikah", "belum-menikah") : a.includes("cerai hidup") || a.includes("cerai_hidup") ? c.set("status-menikah", "cerai-hidup") : a.includes("cerai mati") || a.includes("cerai_mati") ? c.set("status-menikah", "cerai-mati") : (a.includes("menikah") || a.includes("kawin") || console.log("[recordToFieldRules] WARNING: status_pernikahan did not match any known value:", a), c.set("status-menikah", "menikah"));
  }
  const k = r(t.telinga || "Normal");
  c.set("telinga", k.includes("gangguan") ? "gangguan" : "normal");
  const m = r(t.mata || "Normal");
  m.includes("buta") ? c.set("mata", "buta") : m.includes("berat") ? c.set("mata", "gangguan-penglihatan-berat") : m.includes("sedang") ? c.set("mata", "gangguan-penglihatan-sedang") : m.includes("ringan") ? c.set("mata", "gangguan-penglihatan-ringan") : c.set("mata", "normal");
  const h = r(t.gigi || "Normal");
  h.includes("lubang") ? c.set("gigi", "lubang") : (h.includes("cabut") || h.includes("hilang")) ? c.set("gigi", "cabut") : c.set("gigi", "normal");
  const p = r(t.katarak || "Normal");
  c.set("katarak", p.includes("curiga") || p.includes("katarak") ? "curiga-katarak" : "normal");
  t.menstruasi && c.set("menstruasi", r(t.menstruasi));
  "SEKOLAH" === t.category ? t.kebugaran && c.set("kebugaran", r(t.kebugaran)) : c.set("kebugaran", "cukup");
  c.set("frambusia", "tidak-ada");
  c.set("kusta", "tidak-ada");
  c.set("skabies", "tidak-ada");
  const b = e(c, {}, i);
  if (h.includes("goyang")) {
    const goyangIdx = b.findIndex(rule => rule.keyword === "Gigi Goyang");
    if (goyangIdx !== -1) b[goyangIdx] = { ...b[goyangIdx], label: "Ya" };
    else b.push({ keyword: "Gigi Goyang", type: "radio", label: "Ya" });
  }
  const w = Math.floor(10 * Math.random()) + 8;
  b.push({ keyword: "Kadar CO Pernapasan", type: "input", value: String(w) });

  const dynamicRules = getDynamicDemographicRules(t);
  b.push(...dynamicRules);

  console.log("[recordToFieldRules]", { kategori: l, genderKey: o, comboKey: u, age: ageNum }, "Generated", b.length, "rules");
  return b;
}

export async function recordToFieldValues(a) {
  const e = a => (a ?? "").toLowerCase().trim(),
    t = a => null == a || 0 === a ? "" : String(a),
    n = {};
  if (
    n["berat-badan"] = t(a.bb),
    n["tinggi-badan"] = t(a.tb),
    n["lingkar-perut"] = t(a.lp),
    n["tekanan-darah-sistolik"] = t(a.td_sistolik),
    n["tekanan-darah-diastolik"] = t(a.td_diastolik),
    n["gula-darah"] = t(a.gula_darah),
    a.hb && (n.hb = t(a.hb)),
    a.merokok
  ) {
    const t = e(a.merokok);
    n.merokok = t.includes("ya") ? "ya" : "tidak", t.includes("tidak") && (n["pernah-merokok"] = "tidak");
  }
  if (a.status_pernikahan) {
    const t = e(a.status_pernikahan);
    t.includes("belum") ? n["status-menikah"] = "belum-menikah" : t.includes("cerai hidup") || t.includes("cerai_hidup") ? n["status-menikah"] = "cerai-hidup" : t.includes("cerai mati") || t.includes("cerai_mati") ? n["status-menikah"] = "cerai-mati" : (t.includes("menikah") || t.includes("kawin")) && (n["status-menikah"] = "menikah");
  }
  if (a.telinga) {
    const t = e(a.telinga);
    n.telinga = t.includes("gangguan") ? "gangguan" : "normal";
  }
  if (a.mata) {
    const t = e(a.mata);
    t.includes("buta") ? n.mata = "buta" : t.includes("berat") ? n.mata = "gangguan-penglihatan-berat" : t.includes("sedang") ? n.mata = "gangguan-penglihatan-sedang" : t.includes("ringan") ? n.mata = "gangguan-penglihatan-ringan" : n.mata = "normal";
  }
  if (a.gigi) {
    const t = e(a.gigi);
    t.includes("lubang") ? n.gigi = "lubang" : (t.includes("cabut") || t.includes("hilang")) ? n.gigi = "cabut" : n.gigi = "normal";
  }
  if (a.karies) {
    const t = e(a.karies);
    n.karies = ["1", "2", "3", ">3"].includes(t) ? t : "tidak-ada";
  }
  if (a.kacamata) {
    const t = e(a.kacamata);
    n.kacamata = t.includes("ya") ? "ya" : "tidak";
  }
  if (a.katarak) {
    const t = e(a.katarak);
    n.katarak = t.includes("curiga") || t.includes("katarak") ? "curiga-katarak" : "normal";
  }
  return a.menstruasi && (n.menstruasi = e(a.menstruasi)), a.kebugaran && (n.kebugaran = e(a.kebugaran)), console.log("[recordToFieldValues] mapped", Object.keys(n).filter(a => n[a]).length, "non-empty fields"), n;
}

export async function checkFormExists(a) {
  const [e] = await chrome.scripting.executeScript({
    target: { tabId: a },
    world: "MAIN",
    func: () => document.querySelectorAll(".sd-input").length > 0 || document.querySelectorAll(".sd-item__control-label").length > 0 || document.querySelectorAll(".sd-element--with-frame").length > 0
  });
  return e?.result ?? !1;
}

export async function waitForFormToAppear(a, e = 1e4) {
  const t = a => new Promise(e => setTimeout(e, a)),
    n = Date.now() + e;
  for (; Date.now() < n;) {
    if (await checkFormExists(a)) return void console.log("[waitForFormToAppear] Form detected");
    await t(500);
  }
  throw new Error("Form did not appear within timeout");
}

/**
 * Generate randomized clinical measurements & screening values that strictly evaluate to NORMAL.
 * Used for Mode 1: Sistem (Template Jawaban Normal Otomatis tanpa file Excel).
 */
export function generateNormalFieldValues(patient = {}) {
  const age = parseAgeFromPatient(patient);
  const genStr = String(patient.jenis_kelamin || patient.jenisKelamin || patient.gender || patient.jk || "").toLowerCase();
  const isFemale = genStr.includes("perempuan") || genStr.includes("wanita") || genStr === "p";
  const isRemaja = age < 18 || String(patient.kategori || "").toLowerCase().includes("remaja");
  const isLansia = age >= 60 || String(patient.kategori || "").toLowerCase().includes("lansia");

  const randInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
  const randFloat = (min, max) => (Math.random() * (max - min) + min).toFixed(1);

  let bb, tb, lp, sistolik, diastolik, hb;

  if (isRemaja) {
    if (isFemale) {
      tb = randInt(150, 160);
      bb = randInt(44, 52); // Normal IMT 19.5 - 20.3
      lp = randInt(62, 72);
      sistolik = randInt(102, 114);
      diastolik = randInt(65, 75);
      hb = randFloat(12.3, 14.0);
    } else {
      tb = randInt(160, 172);
      bb = randInt(50, 62); // Normal IMT 19.5 - 21.0
      lp = randInt(65, 76);
      sistolik = randInt(105, 116);
      diastolik = randInt(66, 76);
      hb = randFloat(13.5, 15.5);
    }
  } else if (isLansia) {
    if (isFemale) {
      tb = randInt(148, 158);
      bb = randInt(48, 58); // Normal IMT 21.8 - 23.2
      lp = randInt(70, 78);
      sistolik = randInt(115, 128);
      diastolik = randInt(72, 82);
      hb = randFloat(12.2, 13.8);
    } else {
      tb = randInt(158, 168);
      bb = randInt(56, 66); // Normal IMT 22.4 - 23.4
      lp = randInt(76, 86);
      sistolik = randInt(118, 130);
      diastolik = randInt(74, 84);
      hb = randFloat(13.2, 15.0);
    }
  } else {
    // Dewasa
    if (isFemale) {
      tb = randInt(152, 164);
      bb = randInt(50, 60); // Normal IMT 21.6 - 22.3
      lp = randInt(66, 76);
      sistolik = randInt(108, 118);
      diastolik = randInt(68, 78);
      hb = randFloat(12.4, 14.5);
    } else {
      tb = randInt(163, 175);
      bb = randInt(60, 72); // Normal IMT 22.5 - 23.5
      lp = randInt(74, 84);
      sistolik = randInt(112, 120);
      diastolik = randInt(70, 80);
      hb = randFloat(13.8, 15.8);
    }
  }

  const gds = randInt(92, 124); // GDS Normal

  return {
    "berat-badan": String(bb),
    "tinggi-badan": String(tb),
    "lingkar-perut": String(lp),
    "tekanan-darah-sistolik": String(sistolik),
    "tekanan-darah-diastolik": String(diastolik),
    "gula-darah": String(gds),
    hb: String(hb),
    merokok: "tidak",
    "pernah-merokok": "tidak",
    "status-menikah": isRemaja ? "belum-menikah" : "menikah",
    "rencana-menikah": "tidak",
    hamil: "tidak",
    "hubungan-intim": isRemaja ? "tidak" : "ya",
    telinga: "normal",
    mata: "normal",
    gigi: "normal",
    karies: "tidak-ada",
    kacamata: "tidak",
    katarak: "normal",
    frambusia: "tidak-ada",
    kusta: "tidak-ada",
    skabies: "tidak-ada",
    menstruasi: isFemale ? "ya" : "tidak",
    kebugaran: "baik"
  };
}