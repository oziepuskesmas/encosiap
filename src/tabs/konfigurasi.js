import { invalidateRemoteConfigCache, warmRemoteConfigCache } from "../remoteConfig.js";
import { getAiConfig, saveAiConfig, testAiConnection } from "../services/aiService.js";

export async function init() {
  const panel = document.getElementById("settings-panel");
  if (!panel) return { getDelay: () => 1200, getPendaftaranDelay: () => 1, testMode: false, getRangeData: () => ({}) };

  panel.innerHTML = "";

  // ── Refresh Config Button ─────────────────────────────────
  const fieldBtn = document.createElement("div");
  fieldBtn.className = "field field--button";

  const hintBtn = document.createElement("p");
  hintBtn.className = "field__hint";
  hintBtn.textContent = "Muat ulang konfigurasi field dan uncheck dari server.";
  fieldBtn.appendChild(hintBtn);

  const btnRefresh = document.createElement("button");
  btnRefresh.type = "button";
  btnRefresh.className = "btn btn--secondary";
  btnRefresh.textContent = "Refresh Config";
  fieldBtn.appendChild(btnRefresh);

  const hintStatus = document.createElement("p");
  hintStatus.className = "field__hint";
  hintStatus.hidden = true;
  fieldBtn.appendChild(hintStatus);

  panel.appendChild(fieldBtn);

  const div1 = document.createElement("hr");
  div1.className = "form__divider";
  panel.appendChild(div1);

  btnRefresh.addEventListener("click", async () => {
    btnRefresh.disabled = true;
    btnRefresh.textContent = "Memuat…";
    hintStatus.hidden = true;
    try {
      await invalidateRemoteConfigCache();
      await warmRemoteConfigCache();
      hintStatus.textContent = "Config berhasil diperbarui.";
    } catch (err) {
      hintStatus.textContent = `Gagal memperbarui config: ${err.message}`;
    } finally {
      btnRefresh.disabled = false;
      btnRefresh.textContent = "Refresh Config";
      hintStatus.hidden = false;
    }
  });

  // ── Delay per form ────────────────────────────────────────
  const fieldDelay = document.createElement("div");
  fieldDelay.className = "field field--text";

  const lblDelay = document.createElement("label");
  lblDelay.className = "field__label";
  lblDelay.setAttribute("for", "delay-per-form");
  lblDelay.textContent = "Delay per form (detik)";

  const inputDelay = document.createElement("input");
  inputDelay.type = "number";
  inputDelay.id = "delay-per-form";
  inputDelay.className = "field__input";
  inputDelay.min = "0";
  inputDelay.step = "0.1";
  inputDelay.value = "1.2";

  fieldDelay.appendChild(lblDelay);
  fieldDelay.appendChild(inputDelay);
  panel.appendChild(fieldDelay);

  const { ckg_config: savedConfig, ckg_ranges: savedRanges } = await chrome.storage.local.get([
    "ckg_config",
    "ckg_ranges"
  ]);

  if (savedConfig?.delay != null) {
    inputDelay.value = savedConfig.delay;
  }

  // ── Testing mode toggle ───────────────────────────────────
  const fieldTest = document.createElement("div");
  fieldTest.className = "field field--toggle";

  const inputTest = document.createElement("input");
  inputTest.type = "checkbox";
  inputTest.id = "test-mode";
  inputTest.className = "field__toggle";

  const lblTest = document.createElement("label");
  lblTest.className = "field__toggle-label";
  lblTest.setAttribute("for", "test-mode");
  lblTest.textContent = "Testing mode";

  fieldTest.appendChild(inputTest);
  fieldTest.appendChild(lblTest);
  panel.appendChild(fieldTest);

  const hintTest = document.createElement("p");
  hintTest.className = "field__hint";
  hintTest.textContent = "Jalankan otomasi meskipun item sudah selesai.";
  panel.appendChild(hintTest);

  if (savedConfig?.testMode != null) {
    inputTest.checked = savedConfig.testMode;
  }

  // ── Delay otomasi pendaftaran ─────────────────────────────
  const fieldPendaftaran = document.createElement("div");
  fieldPendaftaran.className = "field field--text";

  const lblPendaftaran = document.createElement("label");
  lblPendaftaran.className = "field__label";
  lblPendaftaran.setAttribute("for", "pendaftaran-delay");
  lblPendaftaran.textContent = "Delay otomasi pendaftaran (detik)";

  const hintPendaftaran = document.createElement("p");
  hintPendaftaran.className = "field__hint";
  hintPendaftaran.textContent = "Tambah jeda antar langkah jika koneksi lambat. Default: 1";

  const inputPendaftaran = document.createElement("input");
  inputPendaftaran.type = "number";
  inputPendaftaran.id = "pendaftaran-delay";
  inputPendaftaran.className = "field__input";
  inputPendaftaran.min = "0.5";
  inputPendaftaran.max = "10";
  inputPendaftaran.step = "0.5";
  inputPendaftaran.value = "1";

  fieldPendaftaran.appendChild(lblPendaftaran);
  fieldPendaftaran.appendChild(hintPendaftaran);
  fieldPendaftaran.appendChild(inputPendaftaran);
  panel.appendChild(fieldPendaftaran);

  if (savedConfig?.pendaftaranDelay != null) {
    inputPendaftaran.value = savedConfig.pendaftaranDelay;
  }

  async function saveBaseConfig() {
    const { ckg_config: cur = {} } = await chrome.storage.local.get("ckg_config");
    await chrome.storage.local.set({
      ckg_config: {
        ...cur,
        delay: parseFloat(inputDelay.value) || 1.2,
        testMode: inputTest.checked,
        pendaftaranDelay: parseFloat(inputPendaftaran.value) || 1
      }
    });
  }

  inputDelay.addEventListener("change", saveBaseConfig);
  inputTest.addEventListener("change", saveBaseConfig);
  inputPendaftaran.addEventListener("change", saveBaseConfig);

  // ── Session Keep-Alive (Heartbeat Ping) Section ───────────
  const divHeartbeat = document.createElement("hr");
  divHeartbeat.className = "form__divider";
  panel.appendChild(divHeartbeat);

  const headingHeartbeat = document.createElement("p");
  headingHeartbeat.className = "range-section__heading";
  headingHeartbeat.textContent = "Session Keep-Alive (ASIK)";
  panel.appendChild(headingHeartbeat);

  const hintHeartbeat = document.createElement("p");
  hintHeartbeat.className = "field__hint";
  hintHeartbeat.style.marginTop = "0";
  hintHeartbeat.textContent = "Mencegah auto-logout saat entry lama dengan ping berkala ke sesi Sehat Indonesiaku di latar belakang.";
  panel.appendChild(hintHeartbeat);

  // Toggle Keep-Alive
  const fieldHeartbeatToggle = document.createElement("div");
  fieldHeartbeatToggle.className = "field field--toggle";

  const inputHeartbeat = document.createElement("input");
  inputHeartbeat.type = "checkbox";
  inputHeartbeat.id = "heartbeat-toggle";
  inputHeartbeat.className = "field__toggle";
  inputHeartbeat.checked = savedConfig?.heartbeatEnabled !== false; // Default: true

  const lblHeartbeat = document.createElement("label");
  lblHeartbeat.className = "field__toggle-label";
  lblHeartbeat.setAttribute("for", "heartbeat-toggle");
  lblHeartbeat.textContent = "Aktifkan Keep-Alive Sesi ASIK";

  fieldHeartbeatToggle.appendChild(inputHeartbeat);
  fieldHeartbeatToggle.appendChild(lblHeartbeat);
  panel.appendChild(fieldHeartbeatToggle);

  // Interval dropdown
  const fieldInterval = document.createElement("div");
  fieldInterval.className = "field";

  const lblInterval = document.createElement("label");
  lblInterval.className = "field__label";
  lblInterval.textContent = "Interval Ping Sesi";

  const wrapInterval = document.createElement("div");
  wrapInterval.className = "select__wrapper";

  const selectInterval = document.createElement("select");
  selectInterval.className = "field__select";
  const intervalOptions = [
    { value: "1", label: "1 Menit (Paling Agresif)" },
    { value: "2", label: "2 Menit (Direkomendasikan)" },
    { value: "3", label: "3 Menit" },
    { value: "5", label: "5 Menit" }
  ];
  const activeInterval = String(savedConfig?.heartbeatInterval || "2");
  for (const optData of intervalOptions) {
    const opt = document.createElement("option");
    opt.value = optData.value;
    opt.textContent = optData.label;
    if (optData.value === activeInterval) opt.selected = true;
    selectInterval.appendChild(opt);
  }

  const arrowInterval = document.createElement("span");
  arrowInterval.className = "select__arrow";
  arrowInterval.textContent = "▾";

  wrapInterval.appendChild(selectInterval);
  wrapInterval.appendChild(arrowInterval);
  fieldInterval.appendChild(lblInterval);
  fieldInterval.appendChild(wrapInterval);
  panel.appendChild(fieldInterval);

  // Live Test Button & Status Hint
  const fieldHeartbeatAction = document.createElement("div");
  fieldHeartbeatAction.className = "field field--button";
  fieldHeartbeatAction.style.marginTop = "6px";

  const btnHeartbeatTest = document.createElement("button");
  btnHeartbeatTest.type = "button";
  btnHeartbeatTest.className = "btn btn--secondary";
  btnHeartbeatTest.textContent = "Test Ping Sesi Sekarang";

  const hintHeartbeatFeedback = document.createElement("p");
  hintHeartbeatFeedback.className = "field__hint";
  hintHeartbeatFeedback.textContent = "Klik untuk memeriksa koneksi dan status sesi ASIK saat ini.";

  fieldHeartbeatAction.appendChild(btnHeartbeatTest);
  fieldHeartbeatAction.appendChild(hintHeartbeatFeedback);
  panel.appendChild(fieldHeartbeatAction);

  async function updateHeartbeatConfig() {
    const enabled = inputHeartbeat.checked;
    const interval = parseInt(selectInterval.value, 10) || 2;
    await chrome.runtime.sendMessage({
      type: "CKG_HEARTBEAT_CONFIG",
      enabled,
      interval
    }).catch(() => {});
  }

  inputHeartbeat.addEventListener("change", updateHeartbeatConfig);
  selectInterval.addEventListener("change", updateHeartbeatConfig);

  btnHeartbeatTest.addEventListener("click", async () => {
    btnHeartbeatTest.disabled = true;
    btnHeartbeatTest.textContent = "Memeriksa sesi...";
    try {
      const res = await chrome.runtime.sendMessage({ type: "CKG_HEARTBEAT_PING" });
      const st = res?.status;
      if (st?.ok) {
        hintHeartbeatFeedback.textContent = `✅ Sesi Aktif: ${st.user || "User"} (${st.faskes || ""})`;
        hintHeartbeatFeedback.style.color = "#34d399";
      } else if (st?.state === "expired") {
        hintHeartbeatFeedback.textContent = "❌ Sesi Kedaluwarsa (401)! Silakan login ulang di tab ASIK.";
        hintHeartbeatFeedback.style.color = "#f87171";
      } else if (st?.state === "no_tab") {
        hintHeartbeatFeedback.textContent = "⚠️ Tab Sehat Indonesiaku belum dibuka di browser.";
        hintHeartbeatFeedback.style.color = "#fbbf24";
      } else {
        hintHeartbeatFeedback.textContent = `Status: ${st?.message || "Tidak terhubung"}`;
        hintHeartbeatFeedback.style.color = "#cbd5e1";
      }
    } catch (err) {
      hintHeartbeatFeedback.textContent = `Error: ${err.message}`;
      hintHeartbeatFeedback.style.color = "#f87171";
    } finally {
      btnHeartbeatTest.disabled = false;
      btnHeartbeatTest.textContent = "Test Ping Sesi Sekarang";
    }
  });

  // ── AI Smart Assistant (Gemini) Section ───────────────────
  const divAi = document.createElement("hr");
  divAi.className = "form__divider";
  panel.appendChild(divAi);

  const headingAi = document.createElement("p");
  headingAi.className = "range-section__heading";
  headingAi.textContent = "🤖 AI Smart Assistant (Gemini)";
  panel.appendChild(headingAi);

  const hintAi = document.createElement("p");
  hintAi.className = "field__hint";
  hintAi.style.marginTop = "0";
  hintAi.textContent = "Membaca & memetakan file Excel secara cerdas tanpa harus mengikuti template baku (Zero-Template Ingestion).";
  panel.appendChild(hintAi);

  // Toggle AI
  const fieldAiToggle = document.createElement("div");
  fieldAiToggle.className = "field field--toggle";

  const inputAiToggle = document.createElement("input");
  inputAiToggle.type = "checkbox";
  inputAiToggle.id = "ai-toggle";
  inputAiToggle.className = "field__toggle";

  const lblAiToggle = document.createElement("label");
  lblAiToggle.className = "field__toggle-label";
  lblAiToggle.setAttribute("for", "ai-toggle");
  lblAiToggle.textContent = "Aktifkan AI Smart Excel Parser";

  fieldAiToggle.appendChild(inputAiToggle);
  fieldAiToggle.appendChild(lblAiToggle);
  panel.appendChild(fieldAiToggle);

  // Input API Key
  const fieldAiKey = document.createElement("div");
  fieldAiKey.className = "field field--text";
  fieldAiKey.style.marginTop = "6px";

  const lblAiKey = document.createElement("label");
  lblAiKey.className = "field__label";
  lblAiKey.setAttribute("for", "ai-api-key");
  lblAiKey.textContent = "AI API Key (RelayRouter / Gemini)";

  const inputAiKey = document.createElement("input");
  inputAiKey.type = "password";
  inputAiKey.id = "ai-api-key";
  inputAiKey.className = "field__input";
  inputAiKey.placeholder = "sk-...";

  fieldAiKey.appendChild(lblAiKey);
  fieldAiKey.appendChild(inputAiKey);
  panel.appendChild(fieldAiKey);

  // Test AI Button & Feedback Hint
  const fieldAiAction = document.createElement("div");
  fieldAiAction.className = "field field--button";
  fieldAiAction.style.marginTop = "6px";

  const btnAiTest = document.createElement("button");
  btnAiTest.type = "button";
  btnAiTest.className = "btn btn--secondary";
  btnAiTest.textContent = "⚡ Tes Koneksi AI";

  const hintAiFeedback = document.createElement("p");
  hintAiFeedback.className = "field__hint";
  hintAiFeedback.style.marginTop = "6px";
  hintAiFeedback.hidden = true;

  fieldAiAction.appendChild(btnAiTest);
  fieldAiAction.appendChild(hintAiFeedback);
  panel.appendChild(fieldAiAction);

  // Load saved AI config
  getAiConfig().then(cfg => {
    inputAiToggle.checked = cfg.enabled !== false;
    inputAiKey.value = cfg.apiKey || "";
  });

  const saveAiSettings = async () => {
    const cur = await getAiConfig();
    await saveAiConfig({
      ...cur,
      enabled: inputAiToggle.checked,
      apiKey: inputAiKey.value.trim() || cur.apiKey
    });
  };

  inputAiToggle.addEventListener("change", saveAiSettings);
  inputAiKey.addEventListener("change", saveAiSettings);

  btnAiTest.addEventListener("click", async () => {
    btnAiTest.disabled = true;
    btnAiTest.textContent = "Memeriksa AI…";
    hintAiFeedback.hidden = false;
    hintAiFeedback.textContent = "Menghubungkan ke Gemini API...";
    hintAiFeedback.style.color = "#38bdf8";

    const cur = await getAiConfig();
    const testRes = await testAiConnection({
      ...cur,
      apiKey: inputAiKey.value.trim() || cur.apiKey
    });

    if (testRes.success) {
      hintAiFeedback.textContent = `✅ AI Terhubung! Model: ${testRes.model} (${testRes.latency} ms)`;
      hintAiFeedback.style.color = "#34d399";
    } else {
      hintAiFeedback.textContent = `❌ Gagal koneksi AI: ${testRes.error}`;
      hintAiFeedback.style.color = "#f87171";
    }
    btnAiTest.disabled = false;
    btnAiTest.textContent = "⚡ Tes Koneksi AI";
  });

  // ── Rentang Nilai Otomatis ────────────────────────────────
  const divRanges = document.createElement("hr");
  divRanges.className = "form__divider";
  panel.appendChild(divRanges);

  const headingRanges = document.createElement("p");
  headingRanges.className = "range-section__heading";
  headingRanges.textContent = "Rentang Nilai Otomatis";
  panel.appendChild(headingRanges);

  const hintRanges = document.createElement("p");
  hintRanges.className = "field__hint";
  hintRanges.style.marginTop = "0";
  hintRanges.textContent = "Digunakan jika field dibiarkan kosong saat otomasi berjalan.";
  panel.appendChild(hintRanges);

  const fieldCategory = document.createElement("div");
  fieldCategory.className = "field";

  const lblCategory = document.createElement("label");
  lblCategory.className = "field__label";
  lblCategory.setAttribute("for", "range-combo");
  lblCategory.textContent = "Kategori & Jenis Kelamin";

  const wrapCategory = document.createElement("div");
  wrapCategory.className = "select__wrapper";

  const selectCategory = document.createElement("select");
  selectCategory.id = "range-combo";
  selectCategory.className = "field__select";

  const CATEGORIES = [
    { key: "dewasa-laki-laki", label: "Dewasa – Laki-laki", defaults: { beratBadan: [55, 85], tinggiBadan: [158, 175], lingkarPerut: [75, 100], sistolik: [110, 130], diastolik: [70, 85], gulaDarah: [80, 150] } },
    { key: "dewasa-perempuan", label: "Dewasa – Perempuan", defaults: { beratBadan: [45, 70], tinggiBadan: [148, 165], lingkarPerut: [65, 95], sistolik: [105, 125], diastolik: [65, 82], gulaDarah: [80, 150] } },
    { key: "remaja-laki-laki", label: "Remaja – Laki-laki", defaults: { beratBadan: [40, 70], tinggiBadan: [150, 175], lingkarPerut: [60, 85], sistolik: [100, 120], diastolik: [65, 80], gulaDarah: [80, 150] } },
    { key: "remaja-perempuan", label: "Remaja – Perempuan", defaults: { beratBadan: [38, 60], tinggiBadan: [145, 163], lingkarPerut: [58, 80], sistolik: [100, 118], diastolik: [63, 78], gulaDarah: [80, 150] } },
    { key: "lansia-laki-laki", label: "Lansia – Laki-laki", defaults: { beratBadan: [50, 80], tinggiBadan: [155, 170], lingkarPerut: [75, 100], sistolik: [120, 145], diastolik: [75, 90], gulaDarah: [80, 150] } },
    { key: "lansia-perempuan", label: "Lansia – Perempuan", defaults: { beratBadan: [45, 70], tinggiBadan: [145, 163], lingkarPerut: [68, 92], sistolik: [115, 140], diastolik: [72, 88], gulaDarah: [80, 150] } }
  ];

  for (const cat of CATEGORIES) {
    const opt = document.createElement("option");
    opt.value = cat.key;
    opt.textContent = cat.label;
    selectCategory.appendChild(opt);
  }

  const arrowCategory = document.createElement("span");
  arrowCategory.className = "select__arrow";
  arrowCategory.textContent = "▾";

  wrapCategory.appendChild(selectCategory);
  wrapCategory.appendChild(arrowCategory);
  fieldCategory.appendChild(lblCategory);
  fieldCategory.appendChild(wrapCategory);
  panel.appendChild(fieldCategory);

  const FIELDS = [
    { key: "beratBadan", label: "Berat Badan", unit: "kg" },
    { key: "tinggiBadan", label: "Tinggi Badan", unit: "cm" },
    { key: "lingkarPerut", label: "Lingkar Perut", unit: "cm" },
    { key: "sistolik", label: "TD Sistolik", unit: "mmHg" },
    { key: "diastolik", label: "TD Diastolik", unit: "mmHg" },
    { key: "gulaDarah", label: "Gula Darah", unit: "mg/dL" }
  ];

  const rangesState = {};
  for (const cat of CATEGORIES) {
    rangesState[cat.key] = Object.fromEntries(FIELDS.map(f => [f.key, [...cat.defaults[f.key]]]));
  }

  if (savedRanges) {
    for (const [catKey, fieldsObj] of Object.entries(savedRanges)) {
      if (rangesState[catKey]) {
        for (const f of FIELDS) {
          if (Array.isArray(fieldsObj[f.key]) && fieldsObj[f.key].length === 2) {
            rangesState[catKey][f.key] = fieldsObj[f.key];
          }
        }
      }
    }
  }

  function saveRanges() {
    chrome.storage.local.set({ ckg_ranges: rangesState });
  }

  const inputMap = {};
  for (const cat of CATEGORIES) {
    inputMap[cat.key] = {};
    for (const f of FIELDS) {
      const minInp = document.createElement("input");
      minInp.type = "number";
      minInp.className = "field__input range-input";
      minInp.value = rangesState[cat.key][f.key][0];
      minInp.min = "0";

      const maxInp = document.createElement("input");
      maxInp.type = "number";
      maxInp.className = "field__input range-input";
      maxInp.value = rangesState[cat.key][f.key][1];
      maxInp.min = "0";

      minInp.addEventListener("change", () => {
        rangesState[cat.key][f.key][0] = parseFloat(minInp.value) || 0;
        saveRanges();
      });

      maxInp.addEventListener("change", () => {
        rangesState[cat.key][f.key][1] = parseFloat(maxInp.value) || 0;
        saveRanges();
      });

      inputMap[cat.key][f.key] = { minEl: minInp, maxEl: maxInp };
    }
  }

  const containerRows = document.createElement("div");
  containerRows.className = "range-rows";
  panel.appendChild(containerRows);

  function renderCategoryRows(catKey) {
    containerRows.innerHTML = "";
    for (const f of FIELDS) {
      const row = document.createElement("div");
      row.className = "range-row";

      const lbl = document.createElement("span");
      lbl.className = "range-row__label";
      lbl.textContent = `${f.label} (${f.unit})`;

      const inputsWrap = document.createElement("div");
      inputsWrap.className = "range-row__inputs";

      const { minEl, maxEl } = inputMap[catKey][f.key];
      const dash = document.createElement("span");
      dash.className = "range-row__dash";
      dash.textContent = "–";

      inputsWrap.appendChild(minEl);
      inputsWrap.appendChild(dash);
      inputsWrap.appendChild(maxEl);

      row.appendChild(lbl);
      row.appendChild(inputsWrap);
      containerRows.appendChild(row);
    }
  }

  renderCategoryRows(CATEGORIES[0].key);
  selectCategory.addEventListener("change", () => renderCategoryRows(selectCategory.value));

  return {
    getDelay() {
      const val = parseFloat(inputDelay.value);
      return Number.isFinite(val) && val >= 0 ? Math.round(val * 1000) : 300;
    },
    getPendaftaranDelay() {
      const val = parseFloat(inputPendaftaran.value);
      return Number.isFinite(val) && val >= 0.5 ? val : 1;
    },
    get testMode() {
      return inputTest.checked;
    },
    getRangeData() {
      return rangesState;
    }
  };
}