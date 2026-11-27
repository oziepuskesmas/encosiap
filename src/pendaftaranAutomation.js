import { sanitizeName } from "./services/aiService.js";

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function executeInTab(tabId, func, args = []) {
  const [res] = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func,
    args
  });
  return res?.result;
}

function typeNik(nik) {
  const el = document.getElementById("nik") || document.querySelector('input[placeholder*="NIK"]');
  if (!el) return false;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
  if (setter) {
    setter.call(el, nik);
  } else {
    el.value = nik;
  }
  el.dispatchEvent(new InputEvent("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return true;
}

function clickCekNik() {
  const btn = Array.from(document.querySelectorAll("button")).find(b => "Cek NIK" === b.textContent.trim());
  if (!btn) return false;
  btn.click();
  return true;
}

function installNikInterceptor() {
  if (window.__nikInterceptorInstalled) return true;
  window.__nikInterceptorInstalled = true;
  window.__nikCheckResult = null;

  const isCheckNikUrl = url => (url || "").includes("/api/pkg/ssi/check-nik");
  const saveResult = (status, body) => {
    // NIK ditemukan jika status 200 DAN data pasien ada di response
    const hasData = !!(body?.data && (body.data.fullname || body.data.nama || body.data.nik));
    window.__nikCheckResult = {
      status,
      bodyStatusCode: body?.statusCode ?? null,
      found: 200 === status && (null == body?.statusCode || 200 === body.statusCode) && hasData,
      body: body ?? null
    };
  };

  const origFetch = window.fetch;
  window.fetch = async function (...args) {
    const url = "string" == typeof args[0] ? args[0] : args[0]?.url ?? "";
    const res = await origFetch.apply(this, args);
    if (isCheckNikUrl(url)) {
      try {
        const cloned = res.clone();
        saveResult(res.status, await cloned.json());
      } catch (err) {
        saveResult(res.status, null);
      }
    }
    return res;
  };

  const origXhr = window.XMLHttpRequest;
  if (origXhr && !window.__nikXhrPatched) {
    window.__nikXhrPatched = true;
    const origOpen = origXhr.prototype.open;
    const origSend = origXhr.prototype.send;
    origXhr.prototype.open = function (method, url, ...rest) {
      this.__nikUrl = "string" == typeof url ? url : "";
      return origOpen.call(this, method, url, ...rest);
    };
    origXhr.prototype.send = function (...data) {
      this.addEventListener("load", () => {
        if (isCheckNikUrl(this.__nikUrl)) {
          try {
            saveResult(this.status, JSON.parse(this.responseText));
          } catch (err) {
            saveResult(this.status, null);
          }
        }
      });
      return origSend.apply(this, data);
    };
  }
  return true;
}

function dismissErrorDialog() {
  const isOk = btn => /^(ok|oke|tutup|batal)$/i.test(btn.textContent.trim());
  const errorContainers = Array.from(document.querySelectorAll("div"))
    .filter(d => /terjadi kesalahan|gagal memproses data/i.test(d.textContent || ""))
    .filter(d => Array.from(d.querySelectorAll("button")).some(isOk))
    .sort((a, b) => a.textContent.length - b.textContent.length);

  const target = errorContainers[0]
    ? Array.from(errorContainers[0].querySelectorAll("button")).find(isOk)
    : Array.from(document.querySelectorAll("button")).find(isOk);

  if (target && !target.disabled) {
    target.click();
    return true;
  }
  return false;
}

function checkModalStatus() {
  const bodyText = (document.body?.innerText || "").toLowerCase();
  const buttons = Array.from(document.querySelectorAll("button, a, div[role='button']"));
  const btnGunakan = buttons.find(b => /gunakan data/i.test((b.textContent || b.innerText || "").trim()));
  const btnManual = buttons.find(b => /isi manual/i.test((b.textContent || b.innerText || "").trim()));

  // Gambar 1: Data peserta ditemukan
  if (btnGunakan || bodyText.includes("data peserta ditemukan")) {
    return { found: true, fromModal: true };
  }

  // Gambar 2: Data tidak ditemukan
  if (
    bodyText.includes("data tidak ditemukan") ||
    bodyText.includes("belum pernah terdaftar") ||
    bodyText.includes("silakan isi data peserta secara manual")
  ) {
    if (btnManual && !btnManual.disabled) {
      try {
        btnManual.click();
      } catch (e) { }
    }
    return { found: false, fromModal: true };
  }

  if (btnManual) {
    try {
      btnManual.click();
    } catch (e) { }
    return { found: false, fromModal: true };
  }

  return null;
}

function getNikCheckResult() {
  return window.__nikCheckResult ?? null;
}

function resetNikCheckResult() {
  window.__nikCheckResult = null;
}

function clickGunakanData() {
  const isMatch = b => /gunakan data/i.test((b.textContent || b.innerText || "").trim());
  const elements = Array.from(document.querySelectorAll("button, a, div[role='button']"));
  const btn = elements.find(isMatch);
  if (!btn) return false;

  btn.focus();
  try {
    btn.click();
  } catch (e) { }

  try {
    ["pointerdown", "mousedown", "pointerup", "mouseup", "click"].forEach(evt =>
      btn.dispatchEvent(new MouseEvent(evt, { bubbles: true, cancelable: true, view: window }))
    );
  } catch (e) { }

  // Check if modal has closed
  const stillOpen = Array.from(document.querySelectorAll("button, a, div[role='button']")).some(isMatch);
  return !stillOpen;
}

function checkTanpaWaliCheckbox(attempt = 0, skipDomClick = false) {
  const isMatchText = t => {
    const s = (t || "").trim().toLowerCase().replace(/\s+/g, " ");
    return (s.includes("daftarkan tanpa data wali") || s.includes("tanpa data wali") || s.includes("tanpa wali")) &&
      !s.includes("nomor sama");
  };

  const bodyText = (document.body?.innerText || "").toLowerCase();
  const hasWaliSection = bodyText.includes("isi data wali") || bodyText.includes("data wali");

  // 1. Cek langsung apakah kolom NIK Wali sudah disabled / terkunci (bukti mutlak bahwa sudah dicentang!)
  const nikWali = document.querySelector('input[placeholder*="NIK Wali" i], input[placeholder*="nik wali" i], input[name*="wali" i]');
  if (nikWali && nikWali.disabled) {
    return { found: true, alreadyChecked: true, hasWaliSection: true };
  }

  // 2. Cari elemen teks spesifik "Daftarkan tanpa data wali"
  const allElements = Array.from(document.querySelectorAll("span, p, label, b, strong, div, h1, h2, h3, h4, h5, h6"));
  const textMatches = allElements.filter(el => {
    const txt = (el.textContent || "").trim();
    return isMatchText(txt) && txt.length < 150;
  });
  const textEl = textMatches.sort((a, b) => (a.textContent || "").length - (b.textContent || "").length)[0] || null;

  if (!textEl && !hasWaliSection) {
    return { found: false, hasWaliSection: false };
  }

  const textRect = textEl ? textEl.getBoundingClientRect() : null;

  // 3. Cari kotak centang visual (boxEl) berdasarkan GEOMETRI posisi di layar
  let boxEl = null;

  if (textEl && textRect) {
    // Cari elemen berukuran 10px-35px yang posisinya persis di sebelah kiri teks (jarak 0-30px) dan sejajar vertikal
    const boxCandidates = allElements.filter(el => {
      if (el === textEl || el.contains(textEl) || textEl.contains(el)) return false;
      if (el.children.length > 2) return false;
      const r = el.getBoundingClientRect();
      if (r.width < 10 || r.width > 35 || r.height < 10 || r.height > 35) return false;
      const distLeft = textRect.left - r.right;
      const isLeft = distLeft >= -5 && distLeft <= 30;
      const isVert = Math.abs((r.top + r.height / 2) - (textRect.top + textRect.height / 2)) <= 20;
      return isLeft && isVert;
    });

    if (boxCandidates.length > 0) {
      boxEl = boxCandidates[0];
    }
  }

  // Fallback 1: previousElementSibling dari textEl atau parent-nya
  if (!boxEl && textEl?.previousElementSibling) {
    const r = textEl.previousElementSibling.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) boxEl = textEl.previousElementSibling;
  }
  if (!boxEl && textEl?.parentElement?.previousElementSibling) {
    const r = textEl.parentElement.previousElementSibling.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) boxEl = textEl.parentElement.previousElementSibling;
  }

  // Fallback 2: elementFromPoint di sebelah kiri teks (~20px ke kiri)
  if (!boxEl && textRect) {
    const pX = Math.max(10, Math.round(textRect.left - 20));
    const pY = Math.round(textRect.top + textRect.height / 2);
    const elAtPoint = document.elementFromPoint(pX, pY);
    if (elAtPoint && elAtPoint !== document.body && !elAtPoint.contains(textEl)) {
      boxEl = elAtPoint;
    }
  }

  // Cari input[type="checkbox"] jika ada
  const allCheckboxes = Array.from(document.querySelectorAll('input[type="checkbox"], [role="checkbox"]'));
  const inputCb = allCheckboxes.find(cb => {
    const container = cb.closest("label, div, .flex") || cb.parentElement;
    const txt = (container?.innerText || container?.textContent || "").toLowerCase();
    return isMatchText(txt);
  }) || null;

  // 4. Verifikasi apakah sudah tercentang
  let isChecked = false;
  if (nikWali && nikWali.disabled) {
    isChecked = true;
  } else if (inputCb && (inputCb.checked === true || inputCb.getAttribute("aria-checked") === "true")) {
    isChecked = true;
  } else if (boxEl) {
    const bCls = (boxEl.className || "").toString().toLowerCase();
    const bHasSvg = !!boxEl.querySelector("svg, path");
    const styleBg = window.getComputedStyle(boxEl).backgroundColor || "";
    const isTealBg = bCls.includes("bg-teal") || bCls.includes("bg-emerald") || styleBg.includes("rgb(0, 167, 157)") || styleBg.includes("rgb(13, 148, 136)");
    if (isTealBg || bCls.includes("checked") || bHasSvg) {
      isChecked = true;
    }
  }

  if (isChecked) {
    return { found: true, alreadyChecked: true, hasWaliSection: true };
  }

  // 5. Scroll ke elemen target agar masuk viewport
  const scrollTarget = boxEl || textEl || inputCb;
  if (scrollTarget) {
    scrollTarget.scrollIntoView({ block: "center", behavior: "instant" });
  }

  // 6. Hitung koordinat klik untuk Hardware CDP Click (CUKUP 1 KALI KLIK)
  let x = 0;
  let y = 0;

  const bRect = boxEl ? boxEl.getBoundingClientRect() : null;
  const tRect = textEl ? textEl.getBoundingClientRect() : null;

  if (bRect && bRect.width > 0 && bRect.height > 0) {
    x = Math.round(bRect.x + bRect.width / 2);
    y = Math.round(bRect.y + bRect.height / 2);
  } else if (tRect) {
    x = Math.max(10, Math.round(tRect.left - 20));
    y = Math.round(tRect.top + tRect.height / 2);
  }

  // DOM click HANYA dilakukan jika CDP tidak digunakan (agar tidak double click)
  if (!skipDomClick) {
    try {
      const singleTarget = boxEl || inputCb || textEl;
      if (singleTarget) singleTarget.click();
    } catch (_) {}
  }

  const lockedNow = nikWali ? nikWali.disabled === true : false;

  return {
    found: true,
    alreadyChecked: false,
    checkedAfterClick: lockedNow,
    hasWaliSection: true,
    x,
    y
  };
}

function fillTextInput(fieldName, val) {
  const fn = fieldName.toLowerCase();

  // Helper untuk memastikan tidak salah mengisi input milik Data Wali
  const isWaliField = input => {
    if (!input) return false;
    const s = `${input.id || ''} ${input.name || ''} ${input.placeholder || ''} ${input.getAttribute('aria-label') || ''}`.toLowerCase();
    if (s.includes("wali")) return true;
    const container = input.closest("label, div.form-group, div.field, div.relative, div");
    const cText = (container?.innerText || "").toLowerCase();
    if (cText.includes("wali") && !cText.includes("tanpa data wali")) return true;
    return false;
  };

  const findValidInput = selector => {
    const inputs = Array.from(document.querySelectorAll(selector));
    return inputs.find(i => !isWaliField(i)) || null;
  };

  let el = findValidInput(`input[name="${fieldName}"]`) ||
    findValidInput(`input[name="${fieldName.toLowerCase()}"]`) ||
    findValidInput(`input[id="${fieldName.toLowerCase()}"]`);

  if (!el && fn.includes("nama")) {
    el = findValidInput('input[placeholder*="Nama" i]') ||
      findValidInput('input[name*="nama" i]') ||
      findValidInput('input[id*="nama" i]') ||
      findValidInput('input[name*="fullname" i]');
  }
  if (!el && (fn.includes("wa") || fn.includes("what") || fn.includes("nomor") || fn.includes("hp") || fn.includes("telp"))) {
    el = findValidInput('input[placeholder*="Whatsapp" i]') ||
      findValidInput('input[placeholder*="nomor" i]') ||
      findValidInput('input[placeholder*="telepon" i]') ||
      findValidInput('input[placeholder*="hp" i]') ||
      findValidInput('input[name*="wa" i]') ||
      findValidInput('input[name*="phone" i]') ||
      findValidInput('input[name*="telp" i]') ||
      findValidInput('input[type="tel"]');
  }

  if (!el) {
    const label = Array.from(document.querySelectorAll("label, div")).find(l => {
      const txt = l.textContent.trim().toLowerCase();
      return (fn.includes("nama") && txt.startsWith("nama") && !txt.includes("sekolah") && !txt.includes("ibu") && !txt.includes("wali")) ||
        (fn.includes("wa") && (txt.includes("whatsapp") || txt.includes("nomor hp") || txt.includes("no hp")) && !txt.includes("wali"));
    });
    if (label) {
      const candidates = Array.from(label.querySelectorAll("input") || []);
      el = candidates.find(i => !isWaliField(i)) || label.parentElement?.querySelector("input") || label.nextElementSibling?.querySelector("input") || label.nextElementSibling;
      if (el && el.tagName !== "INPUT") el = el.querySelector("input");
      if (el && isWaliField(el)) el = null;
    }
  }

  if (!el) return false;
  el.focus();
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
  if (setter) {
    setter.call(el, val);
  } else {
    el.value = val;
  }
  el.dispatchEvent(new InputEvent("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  el.dispatchEvent(new Event("blur", { bubbles: true }));
  return true;
}

async function fillBirthDate(parsedDate) {
  const delay = ms => new Promise(r => setTimeout(r, ms));
  const clickElement = el => {
    if (el) {
      ["pointerdown", "mousedown", "pointerup", "mouseup", "click"].forEach(evt =>
        el.dispatchEvent(new MouseEvent(evt, { bubbles: true, cancelable: true, view: window }))
      );
    }
  };

  const getPopup = () => document.querySelector(".mx-datepicker-popup, .mx-datepicker-main");
  const monthMap = {
    Jan: 0, Feb: 1, Mar: 2, Apr: 3, Mei: 4, Jun: 5,
    Jul: 6, Agt: 7, Sep: 8, Okt: 9, Nov: 10, Des: 11
  };
  const targetMonth = monthMap[parsedDate.bulan] ?? 0;
  const targetYear = parseInt(parsedDate.tahun, 10);
  const targetDay = String(parseInt(parsedDate.tanggal, 10));

  // Find the exact birth date wrapper (.mx-input-wrapper), excluding wali section
  const getBirthWrapper = () => {
    const inputs = Array.from(document.querySelectorAll('input[placeholder*="tanggal lahir" i]'));
    const validInputs = inputs.filter(inp => {
      const s = `${inp.id || ''} ${inp.name || ''} ${inp.placeholder || ''}`.toLowerCase();
      if (s.includes("wali")) return false;
      const cText = (inp.closest("div, label")?.innerText || "").toLowerCase();
      return !cText.includes("wali") || cText.includes("tanpa data wali");
    });
    const inputWithPh = validInputs[0] || inputs[0];
    if (inputWithPh) {
      return inputWithPh.closest(".mx-input-wrapper") || inputWithPh.parentElement || inputWithPh;
    }
    const wrappers = Array.from(document.querySelectorAll(".mx-input-wrapper")).filter(w => {
      const txt = (w.innerText || w.textContent || "").toLowerCase();
      return !txt.includes("wali") || txt.includes("tanpa data wali");
    });
    return wrappers.find(w => w.querySelector(".mx-icon-clear")) ?? wrappers[wrappers.length - 1] ?? wrappers[0];
  };

  const wrapper = getBirthWrapper();
  if (!wrapper) return "no-birth-wrapper";

  wrapper.scrollIntoView({ block: "center" });

  const inputEl = wrapper.querySelector("input") || document.querySelector('input[placeholder*="tanggal lahir" i]');
  const iconEl = wrapper.querySelector(".mx-icon-calendar, i, svg");

  // Click wrapper first - vue2-datepicker attaches open listener to wrapper
  clickElement(wrapper);
  if (inputEl) {
    inputEl.focus();
    clickElement(inputEl);
  }
  if (iconEl) {
    clickElement(iconEl);
  }

  // Wait for datepicker popup
  const opened = await (async (checkFn, timeout = 3000) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      if (checkFn()) return true;
      await delay(150);
    }
    return false;
  })(() => !!getPopup());

  if (!opened) {
    // Second attempt to open
    if (inputEl) {
      inputEl.click();
      inputEl.focus();
    }
    clickElement(wrapper);
    await delay(500);
  }

  const popup = getPopup();
  if (!popup) {
    // If popup still didn't open, set value directly on input as fallback
    if (inputEl) {
      const pad = n => String(n).padStart(2, "0");
      const dStr = `${pad(targetDay)} ${parsedDate.bulan} ${targetYear}`;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
      if (setter) setter.call(inputEl, dStr);
      else inputEl.value = dStr;
      inputEl.dispatchEvent(new InputEvent("input", { bubbles: true }));
      inputEl.dispatchEvent(new Event("change", { bubbles: true }));
    }
    return "datepicker-popup-not-opened";
  }

  await delay(200);

  // 1. Switch to Year view by clicking current year header
  const btnYear = popup.querySelector(".mx-btn-current-year");
  if (btnYear) {
    clickElement(btnYear);
    await delay(150);
    if (!popup.querySelector(".mx-table-year")) {
      clickElement(btnYear);
      await delay(150);
    }
  }

  // 2. Navigate decade and click Target Year
  let attempts = 0;
  const findYearCell = () =>
    Array.from(popup.querySelectorAll(".mx-table-year td.cell") ?? []).find(
      td => td.textContent.trim() === String(targetYear)
    );

  while (!findYearCell() && attempts++ < 20) {
    const firstCell = popup.querySelector(".mx-table-year td.cell");
    const firstYear = parseInt(firstCell?.textContent ?? "9999", 10);
    const navBtn = popup.querySelector(firstYear > targetYear ? ".mx-btn-icon-double-left" : ".mx-btn-icon-double-right");
    if (!navBtn) break;
    clickElement(navBtn);
    await delay(150);
  }

  const yCell = findYearCell();
  if (yCell) {
    clickElement(yCell);
    await delay(150);
  }

  // 3. Click Target Month
  const monthCells = Array.from(popup.querySelectorAll(".mx-table-month td.cell") ?? []);
  if (monthCells.length > targetMonth) {
    clickElement(monthCells[targetMonth]);
    await delay(150);
  }

  // 4. Click Target Day
  const dayCells = Array.from(popup.querySelectorAll(".mx-table-date td.cell") ?? [])
    .filter(td => !td.classList.contains("not-current-month"));
  const targetDayCell = dayCells.find(td => td.textContent.trim() === targetDay);
  if (targetDayCell) {
    clickElement(targetDayCell);
    await delay(300);
  }

  // 5. Verification & Fallback
  const finalVal = document.querySelector(".mx-input-wrapper .ml-4")?.textContent.trim() ||
    (inputEl ? inputEl.value : "") || "";

  if (!finalVal && inputEl) {
    const pad = n => String(n).padStart(2, "0");
    const dStr = `${pad(targetDay)} ${parsedDate.bulan} ${targetYear}`;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
    if (setter) setter.call(inputEl, dStr);
    else inputEl.value = dStr;
    inputEl.dispatchEvent(new InputEvent("input", { bubbles: true }));
    inputEl.dispatchEvent(new Event("change", { bubbles: true }));
  }

  return (finalVal || inputEl?.value) ? "ok" : "failed";
}

function openGenderDropdown() {
  const triggers = Array.from(document.querySelectorAll("*")).filter(
    el => el.children.length === 0 && /pilih jenis kelamin/i.test(el.textContent.trim())
  );
  const validTrigger = triggers.find(el => {
    const container = el.closest("div.form-group, div.field, div.relative, div");
    const txt = (container?.innerText || "").toLowerCase();
    return !txt.includes("wali") || txt.includes("tanpa data wali");
  }) || triggers[0];

  if (validTrigger) {
    validTrigger.scrollIntoView({ block: "center" });
    ["pointerdown", "mousedown", "pointerup", "mouseup", "click"].forEach(evt =>
      validTrigger.dispatchEvent(new MouseEvent(evt, { bubbles: true, cancelable: true, view: window }))
    );
    return true;
  }
  return false;
}

function selectGenderOption(gender) {
  // First look inside any active popup/dropdown/popover
  const popups = document.querySelectorAll('[class*="absolute"], [class*="fixed"], [class*="dropdown"], [class*="menu"], [class*="popover"], .modal-content');
  for (const pop of popups) {
    const item = Array.from(pop.querySelectorAll("div, span, button, li")).find(
      el => el.children.length === 0 && el.textContent.trim().toLowerCase() === gender.toLowerCase()
    );
    if (item) {
      item.scrollIntoView({ block: "center" });
      ["pointerdown", "mousedown", "pointerup", "mouseup", "click"].forEach(evt =>
        item.dispatchEvent(new MouseEvent(evt, { bubbles: true, cancelable: true, view: window }))
      );
      return true;
    }
  }

  // Global search for matching gender option
  const item = Array.from(document.querySelectorAll("div, span, button, li")).find(
    el => el.children.length === 0 && el.textContent.trim().toLowerCase() === gender.toLowerCase()
  );
  if (item) {
    item.scrollIntoView({ block: "center" });
    ["pointerdown", "mousedown", "pointerup", "mouseup", "click"].forEach(evt =>
      item.dispatchEvent(new MouseEvent(evt, { bubbles: true, cancelable: true, view: window }))
    );
    return true;
  }
  return false;
}

async function selectScheduleDate() {
  const delay = ms => new Promise(r => setTimeout(r, ms));
  const dispatchClick = el => {
    if (el) {
      ["pointerdown", "mousedown", "pointerup", "mouseup", "click"].forEach(evt =>
        el.dispatchEvent(new MouseEvent(evt, { bubbles: true, cancelable: true, view: window }))
      );
    }
  };

  const getCalendarCells = () => {
    let grids = Array.from(document.querySelectorAll("div")).filter(
      el => (el.className || "").toString().includes("grid-cols-7") && el.children.length >= 7
    );
    if (!grids.length) {
      grids = Array.from(document.querySelectorAll("div, section, table")).filter(el => {
        const cls = (el.className || "").toString();
        return (cls.includes("grid") || el.tagName === "TABLE" || cls.includes("calendar") || cls.includes("picker")) && el.children.length >= 7;
      });
    }

    const grid = grids.find(g => {
      const txt = (g.innerText || "").trim();
      return /\b([1-9]|[12][0-9]|3[01])\b/.test(txt);
    }) || grids[grids.length - 1] || null;

    if (!grid) return [];

    return Array.from(grid.children).map((cell, idx) => {
      const text = (cell.innerText || cell.textContent || "").trim();
      if (!text) return null;

      // Ambil angka tanggal (1-31)
      const dayMatch = text.match(/\b([1-9]|[12][0-9]|3[01])\b/);
      if (!dayMatch) return null;
      const day = parseInt(dayMatch[1], 10);

      // Cari angka kuota
      const numbers = text.match(/\b\d+\b/g) || [];
      let quota = 0;
      if (text.toLowerCase().includes("penuh") || text.toLowerCase().includes("habis")) {
        quota = 0;
      } else if (numbers.length >= 2) {
        quota = parseInt(numbers[1], 10);
      } else {
        quota = 999;
      }

      const isDisabled = cell.classList.contains("opacity-50") ||
        cell.classList.contains("cursor-not-allowed") ||
        cell.classList.contains("pointer-events-none") ||
        (cell.className || "").toString().includes("disabled") ||
        cell.querySelector("[disabled]") !== null;

      const isToday = (cell.className || "").toString().includes("bg-theme") ||
        (cell.className || "").toString().includes("today") ||
        (cell.className || "").toString().includes("border-primary") ||
        (cell.className || "").toString().includes("border-teal") ||
        (cell.className || "").toString().includes("border-emerald") ||
        cell.querySelector('[class*="theme" i], [class*="today" i]') !== null;

      const isAlreadySelected = (cell.className || "").toString().includes("bg-teal") ||
        (cell.className || "").toString().includes("bg-emerald") ||
        (cell.className || "").toString().includes("selected") ||
        cell.getAttribute("aria-selected") === "true";

      return {
        idx,
        cell,
        day,
        quota,
        isDisabled,
        isToday,
        isAlreadySelected
      };
    }).filter(Boolean);
  };

  const clickCalendarCell = cellObj => {
    if (!cellObj || !cellObj.cell) return false;
    const el = cellObj.cell;
    el.scrollIntoView({ block: "center", behavior: "instant" });

    try { el.focus(); } catch (_) {}
    try { el.click(); } catch (_) {}
    dispatchClick(el);

    const innerTarget = el.querySelector("button, div.cursor-pointer, [class*='cursor-pointer'], span, p") || el;
    if (innerTarget && innerTarget !== el) {
      try { innerTarget.focus(); } catch (_) {}
      try { innerTarget.click(); } catch (_) {}
      dispatchClick(innerTarget);
    }

    const r = el.getBoundingClientRect();
    return {
      clicked: true,
      day: cellObj.day,
      x: Math.round(r.x + (r.width > 0 ? r.width / 2 : 10)),
      y: Math.round(r.y + (r.height > 0 ? r.height / 2 : 10))
    };
  };

  const getNextMonthBtn = () => {
    const all = Array.from(document.querySelectorAll("button, a, div[role='button'], svg, span"));
    return all.find(el => {
      const txt = (el.textContent || "").trim();
      const aria = (el.getAttribute("aria-label") || "").toLowerCase();
      const cls = (el.className || "").toString().toLowerCase();
      return txt === "›" || txt === ">" || txt === "»" ||
        aria.includes("next") || aria.includes("berikutnya") ||
        cls.includes("next") || cls.includes("chevron-right");
    }) || null;
  };

  for (let m = 0; m < 3; m++) {
    const cells = getCalendarCells();
    if (cells.length) {
      const selected = cells.find(c => c.isAlreadySelected);
      if (selected) {
        return { clicked: true, alreadySelected: true, day: selected.day };
      }

      const todayCell = cells.find(c => c.isToday && c.quota > 0 && !c.isDisabled);
      if (todayCell) {
        return clickCalendarCell(todayCell);
      }

      const todayIdx = cells.findIndex(c => c.isToday);
      const startIdx = todayIdx >= 0 ? todayIdx : 0;
      const availableCell = cells.slice(startIdx).find(c => c.quota > 0 && !c.isDisabled) ||
        cells.find(c => c.quota > 0 && !c.isDisabled);

      if (availableCell) {
        return clickCalendarCell(availableCell);
      }
    }
    const nextBtn = getNextMonthBtn();
    if (!nextBtn) break;
    dispatchClick(nextBtn);
    await delay(600);
  }
  return false;
}

function installValidationInterceptor() {
  if (window.__validasiInterceptorInstalled) return true;
  window.__validasiInterceptorInstalled = true;
  window.__validasiResult = null;

  const validPaths = ["/api/pkg/ssi/register-pre", "/api/pkg/validasi/data-pasien"];
  const isMatch = url => validPaths.some(p => (url || "").includes(p));
  const saveResult = (status, body) => {
    window.__validasiResult = {
      status,
      data: body?.data ?? null,
      body: body ?? null
    };
  };

  const origFetch = window.fetch;
  window.fetch = async function (...args) {
    const url = "string" == typeof args[0] ? args[0] : args[0]?.url ?? "";
    const res = await origFetch.apply(this, args);
    if (isMatch(url)) {
      try {
        const cloned = res.clone();
        saveResult(res.status, await cloned.json());
      } catch (err) {
        saveResult(res.status, null);
      }
    }
    return res;
  };

  const origXhr = window.XMLHttpRequest;
  if (origXhr && !window.__validasiXhrPatched) {
    window.__validasiXhrPatched = true;
    const origOpen = origXhr.prototype.open;
    const origSend = origXhr.prototype.send;
    origXhr.prototype.open = function (method, url, ...rest) {
      this.__validasiUrl = "string" == typeof url ? url : "";
      return origOpen.call(this, method, url, ...rest);
    };
    origXhr.prototype.send = function (...data) {
      this.addEventListener("load", () => {
        if (isMatch(this.__validasiUrl)) {
          try {
            saveResult(this.status, JSON.parse(this.responseText));
          } catch (err) {
            saveResult(this.status, null);
          }
        }
      });
      return origSend.apply(this, data);
    };
  }
  return true;
}

function installRegisterInterceptor() {
  if (window.__registerInterceptorInstalled) return true;
  window.__registerInterceptorInstalled = true;
  window.__registerResult = null;

  const targetPath = "/api/pkg/ssi/register-ckg";
  const origFetch = window.fetch;
  window.fetch = async function (...args) {
    const url = "string" == typeof args[0] ? args[0] : args[0]?.url ?? "";
    const res = await origFetch.apply(this, args);
    if (url.includes(targetPath)) {
      try {
        const cloned = res.clone();
        const json = await cloned.json();
        window.__registerResult = { status: res.status, data: json.data ?? null, body: json };
      } catch (err) {
        window.__registerResult = { status: res.status, data: null, body: null };
      }
    }
    return res;
  };

  const origXhr = window.XMLHttpRequest;
  if (origXhr && !window.__registerXhrPatched) {
    window.__registerXhrPatched = true;
    const origOpen = origXhr.prototype.open;
    const origSend = origXhr.prototype.send;
    origXhr.prototype.open = function (method, url, ...rest) {
      this.__registerUrl = "string" == typeof url ? url : "";
      return origOpen.call(this, method, url, ...rest);
    };
    origXhr.prototype.send = function (...data) {
      this.addEventListener("load", () => {
        if ((this.__registerUrl || "").includes(targetPath)) {
          try {
            const json = JSON.parse(this.responseText);
            window.__registerResult = { status: this.status, data: json.data ?? null, body: json };
          } catch (err) {
            window.__registerResult = { status: this.status, data: null, body: null };
          }
        }
      });
      return origSend.apply(this, data);
    };
  }
  return true;
}

function getRegisterResult() {
  return window.__registerResult ?? null;
}

function resetRegisterResult() {
  window.__registerResult = null;
}

function getValidasiResult() {
  return window.__validasiResult ?? null;
}

function resetValidasiResult() {
  window.__validasiResult = null;
}

function checkAlreadyScreenedModal() {
  const fullBodyText = (document.body?.innerText || "").toLowerCase();
  const isMatch =
    fullBodyText.includes("individu sudah menerima layanan") ||
    fullBodyText.includes("sudah menerima layanan") ||
    fullBodyText.includes("telah selesai diperiksa") ||
    fullBodyText.includes("selesai diperiksa dengan detail") ||
    fullBodyText.includes("puskesmas pemeriksa") ||
    fullBodyText.includes("silakan arahkan peserta untuk melihat rapor") ||
    fullBodyText.includes("melihat rapor di ssm") ||
    fullBodyText.includes("melihat rapor di whatsapp") ||
    fullBodyText.includes("lihat rapor di ssm") ||
    fullBodyText.includes("already screened") ||
    fullBodyText.includes("individu sudah terdaftar") ||
    fullBodyText.includes("sudah pernah diperiksa");

  if (!isMatch) return false;

  // Temukan elemen modal dialog spesifik agar tidak membaca form background
  let modalText = "";
  try {
    const dialogSelectors = [
      '[role="dialog"]',
      '.ant-modal-content',
      '.modal-content',
      '.modal-dialog',
      '.swal2-popup',
      '[class*="modal" i]',
      '[class*="dialog" i]',
      '[class*="popup" i]'
    ];
    let modalEl = null;
    for (const sel of dialogSelectors) {
      const candidates = Array.from(document.querySelectorAll(sel));
      const found = candidates.find(el => {
        const t = (el.innerText || "").toLowerCase();
        return (t.includes("sudah menerima layanan") || t.includes("telah selesai diperiksa")) &&
               (t.includes("puskesmas pemeriksa") || t.includes("tanggal pemeriksaan") || t.includes("layanan"));
      });
      if (found) {
        modalEl = found;
        break;
      }
    }

    if (!modalEl) {
      const allMatching = Array.from(document.querySelectorAll("div, section, article")).filter(el => {
        const t = (el.innerText || "").toLowerCase();
        return (t.includes("sudah menerima layanan") || t.includes("telah selesai diperiksa")) &&
               (t.includes("puskesmas pemeriksa") || t.includes("tanggal pemeriksaan"));
      });
      if (allMatching.length) {
        allMatching.sort((a, b) => (a.innerText?.length || 0) - (b.innerText?.length || 0));
        modalEl = allMatching[0];
      }
    }

    if (modalEl) {
      modalText = modalEl.innerText || modalEl.textContent || "";
    }
  } catch (_) {}

  const rawText = modalText || document.body?.innerText || "";

  let tgl = "";
  let faskes = "";
  let layanan = "";
  let detail = "";

  // 1. Ekstraksi Puskesmas Pemeriksa
  // Format di modal ASIK: "Puskesmas pemeriksa: BANJARAN KOTA"
  const mFaskesPemeriksa =
    rawText.match(/puskesmas\s*pemeriksa\s*[:\-]\s*([^\r\n]+)/i) ||
    rawText.match(/(?:faskes|fasilitas\s*kesehatan|klinik)\s*pemeriksa\s*[:\-]\s*([^\r\n]+)/i) ||
    rawText.match(/puskesmas\s*[:\-]\s*([^\r\n]+)/i);

  if (mFaskesPemeriksa) {
    let candidate = mFaskesPemeriksa[1].trim();
    if (!/whatsapp|notifikasi|rapor|ssm|silakan/i.test(candidate) && candidate.length > 2 && candidate.length < 80) {
      faskes = candidate;
    }
  }

  // 2. Ekstraksi Tanggal Pemeriksaan
  // Format di modal ASIK: "Tanggal pemeriksaan: 16 Sep 2026"
  const mTglPemeriksa =
    rawText.match(/tanggal\s*pemeriksaan\s*[:\-]\s*([^\r\n]+)/i) ||
    rawText.match(/(?:tanggal(?:\s*skrining|\s*layanan)?|tgl|date)\s*[:\-]\s*([0-9]{1,2}\s+[A-Za-z]{3,15}\s+[0-9]{4}|[0-9]{1,4}[\/\-][0-9]{1,2}[\/\-][0-9]{1,4})/i);

  if (mTglPemeriksa) {
    let candidate = mTglPemeriksa[1].trim();
    const dateMatch = candidate.match(/([0-9]{1,2}\s+[A-Za-z]{3,15}\s+[0-9]{4}|[0-9]{1,4}[\/\-][0-9]{1,2}[\/\-][0-9]{1,4})/);
    if (dateMatch) {
      tgl = dateMatch[1].trim();
    } else if (candidate.length < 40 && !/whatsapp|notifikasi/i.test(candidate)) {
      tgl = candidate;
    }
  }

  // 3. Ekstraksi Layanan
  // Format di modal ASIK: "Layanan: CKG Umum"
  // Wajib diawali label 'Layanan:' dengan titik dua agar tidak tertukar dengan judul 'Individu sudah menerima layanan'
  const mLayananStrict = rawText.match(/(?:^|[\r\n])\s*layanan\s*[:\-]\s*([^\r\n]+)/i);
  if (mLayananStrict) {
    let candidate = mLayananStrict[1].trim();
    if (!/menerima\s*layanan|selesai\s*diperiksa|silakan\s*arahkan/i.test(candidate) && candidate.length < 50) {
      layanan = candidate;
    }
  }

  // 4. Ekstraksi Detail Nama & Kalimat Selesai Diperiksa
  // Format di modal ASIK: "Daif Khoerudin telah selesai diperiksa dengan detail"
  const mDetail = rawText.match(/([^\r\n]+(?:telah\s*selesai\s*diperiksa|selesai\s*diperiksa)[^\r\n]*)/i);
  if (mDetail) {
    detail = mDetail[1].trim();
  }

  // 5. DOM Deep Walk: Telusuri elemen di dalam modal secara terstruktur jika belum lengkap
  if (!tgl || !faskes || !layanan) {
    try {
      const modal = document.querySelector('[role="dialog"], .ant-modal-content, .modal, .modal-dialog, .swal2-popup, [class*="modal" i]') || document.body;
      const allEls = Array.from(modal.querySelectorAll("p, span, div, td, li, h4, h5, h6, strong, b"));
      for (const el of allEls) {
        const text = (el.innerText || el.textContent || "").trim();

        if (!faskes && /puskesmas\s*pemeriksa\s*[:\-]?/i.test(text)) {
          const m = text.match(/puskesmas\s*pemeriksa\s*[:\-]\s*([^\r\n]+)/i);
          if (m && m[1].trim() && !/whatsapp|notifikasi|rapor|ssm/i.test(m[1].trim())) {
            faskes = m[1].trim();
          } else {
            const nextText = (el.nextElementSibling?.innerText || el.nextElementSibling?.textContent || "").trim();
            if (nextText && nextText.length < 60 && !/whatsapp|notifikasi|rapor|ssm/i.test(nextText)) {
              faskes = nextText;
            }
          }
        }

        if (!tgl && /tanggal\s*pemeriksaan\s*[:\-]?/i.test(text)) {
          const m = text.match(/([0-9]{1,2}\s+[A-Za-z]{3,15}\s+[0-9]{4}|[0-9]{1,4}[\/\-][0-9]{1,2}[\/\-][0-9]{1,4})/);
          if (m) {
            tgl = m[1].trim();
          } else {
            const nextText = (el.nextElementSibling?.innerText || el.nextElementSibling?.textContent || "").trim();
            const mn = nextText.match(/([0-9]{1,2}\s+[A-Za-z]{3,15}\s+[0-9]{4}|[0-9]{1,4}[\/\-][0-9]{1,2}[\/\-][0-9]{1,4})/);
            if (mn) tgl = mn[1].trim();
          }
        }

        if (!layanan && /(?:^|[\r\n])\s*layanan\s*[:\-]/i.test(text)) {
          const m = text.match(/layanan\s*[:\-]\s*([^\r\n]+)/i);
          if (m && m[1].trim() && !/menerima|selesai|diperiksa/i.test(m[1].trim())) {
            layanan = m[1].trim();
          } else {
            const nextText = (el.nextElementSibling?.innerText || el.nextElementSibling?.textContent || "").trim();
            if (nextText && nextText.length < 50 && !/menerima|selesai|diperiksa/i.test(nextText)) {
              layanan = nextText;
            }
          }
        }
      }
    } catch (_) {}
  }

  // Sanitasi akhir jika nilai tertangkap salah
  if (/whatsapp|notifikasi/i.test(faskes)) faskes = "";
  if (/menerima\s*layanan|selesai\s*diperiksa/i.test(layanan)) layanan = "";

  let reason = "Peserta sudah menerima layanan skrining CKG pada periode ini";
  if (detail) {
    reason = detail;
  }
  if (faskes && !reason.includes(faskes)) {
    reason += ` (Puskesmas pemeriksa: ${faskes})`;
  }
  if (tgl && !reason.includes(tgl)) {
    reason += ` (Tanggal pemeriksaan: ${tgl})`;
  }
  if (layanan && !reason.includes(layanan)) {
    reason += ` (Layanan: ${layanan})`;
  }

  return {
    isMatch: true,
    tgl: tgl || "",
    faskes: faskes || "",
    layanan: layanan || "",
    detail: detail || "",
    reason
  };
}

function checkInvalidDataModal() {
  const bodyText = (document.body?.innerText || "").toLowerCase();
  const isMatch =
    bodyText.includes("data peserta tidak valid") ||
    bodyText.includes("peserta tidak valid") ||
    bodyText.includes("periksa kembali") ||
    bodyText.includes("silakan perbaiki data yang dimasukkan") ||
    bodyText.includes("sesuai ktp/kk") ||
    bodyText.includes("nik tidak valid") ||
    bodyText.includes("data tidak valid");

  if (!isMatch) return false;

  // Tutup / dismiss modal jika ada tombol Periksa Kembali atau Tutup / Batal
  const buttons = Array.from(document.querySelectorAll("button, a, div[role='button']"));
  const btnKembali =
    buttons.find(b => /periksa kembali/i.test((b.textContent || b.innerText || "").trim())) ||
    buttons.find(b => /^(kembali|tutup|batal|ok|oke)$/i.test((b.textContent || b.innerText || "").trim()));

  if (btnKembali && !btnKembali.disabled) {
    try {
      btnKembali.click();
    } catch (e) { }
    try {
      ["pointerdown", "mousedown", "pointerup", "mouseup", "click"].forEach(evt =>
        btnKembali.dispatchEvent(new MouseEvent(evt, { bubbles: true, cancelable: true, view: window }))
      );
    } catch (e) { }
  }
  return true;
}

function checkValidationModal() {
  const bodyText = (document.body?.innerText || "").toLowerCase();

  // 1. Cek langsung teks modal 'Individu sudah menerima layanan'
  if (
    bodyText.includes("individu sudah menerima layanan") ||
    bodyText.includes("sudah menerima layanan") ||
    bodyText.includes("telah selesai diperiksa") ||
    bodyText.includes("selesai diperiksa dengan detail") ||
    bodyText.includes("puskesmas pemeriksa") ||
    bodyText.includes("silakan arahkan peserta untuk melihat rapor") ||
    bodyText.includes("melihat rapor di ssm") ||
    bodyText.includes("melihat rapor di whatsapp") ||
    bodyText.includes("lihat rapor di ssm") ||
    bodyText.includes("already screened") ||
    bodyText.includes("sudah pernah diperiksa")
  ) {
    const screenedRes = checkAlreadyScreenedModal();
    return {
      status: 200,
      data: {
        validation_code: "ALREADY_SCREENED",
        reason: screenedRes?.reason || "modal: Individu sudah menerima layanan",
        screening_date: screenedRes?.tgl || "",
        screening_faskes: screenedRes?.faskes || "",
        screening_layanan: screenedRes?.layanan || "",
        screening_detail: screenedRes?.detail || ""
      },
      fromModal: true,
      screenedInfo: screenedRes
    };
  }

  // 2. Cek data peserta tidak valid (PERSIS SEPERTI DI GAMBAR SCREENSHOT)
  // Text: "Data peserta tidak valid", "Silakan perbaiki data yang dimasukkan", tombol: "Periksa Kembali"
  if (
    bodyText.includes("data peserta tidak valid") ||
    bodyText.includes("peserta tidak valid") ||
    bodyText.includes("periksa kembali") ||
    bodyText.includes("silakan perbaiki data yang dimasukkan") ||
    bodyText.includes("nik tidak valid") ||
    bodyText.includes("data tidak valid")
  ) {
    checkInvalidDataModal();
    return { status: 200, data: { validation_code: "INVALID_DATA", reason: "modal: Data peserta tidak valid" }, fromModal: true };
  }

  // 3. Cek data peserta valid
  const hasLanjutkanBtn = Array.from(document.querySelectorAll("button, a, div[role='button']")).some(b =>
    /lanjutkan/i.test((b.textContent || b.innerText || "").trim())
  );

  if (
    !bodyText.includes("tidak valid") &&
    !bodyText.includes("periksa kembali") &&
    (
      bodyText.includes("data peserta valid") ||
      bodyText.includes("data valid") ||
      bodyText.includes("silahkan melanjutkan pendaftaran") ||
      bodyText.includes("melanjutkan pendaftaran ckg") ||
      (hasLanjutkanBtn && !bodyText.includes("sudah menerima layanan") && !bodyText.includes("telah selesai diperiksa"))
    )
  ) {
    clickLanjutkan();
    return { status: 200, data: { validation_code: "VALID", reason: "modal: Data peserta valid" }, fromModal: true };
  }

  // Fallback selector elemen modal
  const modals = Array.from(document.querySelectorAll("div"))
    .filter(el => {
      const cls = "string" == typeof el.className ? el.className : "";
      if (!/z-1\d{3}|rounded-lg bg-white|fixed inset-0/.test(cls)) return false;
      if (null === el.offsetParent) return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && !!(el.innerText || "").trim();
    })
    .sort((a, b) => (a.innerText || "").length - (b.innerText || "").length);

  const modal = modals[0];
  if (!modal) return null;
  const text = (modal.innerText || "").toLowerCase();

  if (
    text.includes("data peserta tidak valid") ||
    text.includes("peserta tidak valid") ||
    text.includes("periksa kembali") ||
    text.includes("silakan perbaiki data") ||
    text.includes("nik tidak valid") ||
    text.includes("data tidak valid") ||
    text.includes("tidak ditemukan")
  ) {
    return { status: 200, data: { validation_code: "INVALID_DATA", reason: "modal" }, fromModal: true };
  }

  if (
    !text.includes("tidak valid") &&
    !text.includes("periksa kembali") &&
    (text.includes("data peserta valid") || hasLanjutkanBtn)
  ) {
    clickLanjutkan();
    return { status: 200, data: { validation_code: "VALID", reason: "modal: Data peserta valid" }, fromModal: true };
  }
  if (text.includes("sudah menerima layanan") || text.includes("sudah pernah") || text.includes("already screened")) {
    return { status: 200, data: { validation_code: "ALREADY_SCREENED", reason: "modal", alert_detail: null }, fromModal: true };
  }
  if (text.includes("nik tidak valid") || text.includes("data tidak valid") || text.includes("tidak ditemukan")) {
    return { status: 200, data: { validation_code: "INVALID_DATA", reason: "modal" }, fromModal: true };
  }

  return null;
}

function clickPilih() {
  const btn = Array.from(document.querySelectorAll("button")).find(b => "Pilih" === b.textContent.trim());
  if (!btn) return false;
  btn.click();
  return true;
}

function clickLanjutkan() {
  const isMatch = b => /lanjutkan/i.test((b.textContent || b.innerText || "").trim());
  const elements = Array.from(document.querySelectorAll("button, a, div[role='button']"));
  const btn = elements.find(isMatch);
  if (!btn) return false;

  btn.focus();
  try {
    btn.click();
  } catch (e) { }

  try {
    ["pointerdown", "mousedown", "pointerup", "mouseup", "click"].forEach(evt =>
      btn.dispatchEvent(new MouseEvent(evt, { bubbles: true, cancelable: true, view: window }))
    );
  } catch (e) { }

  const stillOpen = Array.from(document.querySelectorAll("button, a, div[role='button']")).some(isMatch);
  return !stillOpen;
}

function clickSelanjutnya() {
  const elements = Array.from(document.querySelectorAll("button, a, div[role='button']"));
  const btn = elements.find(b => {
    const txt = (b.textContent || b.innerText || "").trim().toLowerCase();
    return (txt === "selanjutnya" || txt.startsWith("selanjutnya") || txt.includes("selanjutnya")) &&
      !txt.includes("batal");
  });
  if (!btn) return { found: false };

  btn.scrollIntoView({ block: "center", behavior: "instant" });

  const isDisabled = btn.disabled === true ||
    btn.getAttribute("aria-disabled") === "true" ||
    btn.classList.contains("opacity-50") ||
    btn.classList.contains("cursor-not-allowed");

  try { btn.focus(); } catch (_) {}
  try { btn.click(); } catch (_) {}

  ["pointerdown", "mousedown", "pointerup", "mouseup", "click"].forEach(evt =>
    btn.dispatchEvent(new MouseEvent(evt, { bubbles: true, cancelable: true, view: window }))
  );

  const r = btn.getBoundingClientRect();
  return {
    found: true,
    disabled: isDisabled,
    x: Math.round(r.x + (r.width > 0 ? r.width / 2 : 10)),
    y: Math.round(r.y + (r.height > 0 ? r.height / 2 : 10))
  };
}

async function fillStep2AlamatUmum(detail) {
  const delay = ms => new Promise(r => setTimeout(r, ms));
  const dispatchClick = el => ["pointerdown", "mousedown", "pointerup", "mouseup", "click"].forEach(evt =>
    el.dispatchEvent(new MouseEvent(evt, { bubbles: true, cancelable: true, view: window }))
  );
  const openSelect = labelText => {
    const header = [...document.querySelectorAll("div")].find(el =>
      el.classList.contains("font-semibold") && el.textContent.trim() === labelText + " *"
    );
    if (!header || !header.nextElementSibling) return false;
    const trigger = header.nextElementSibling.querySelector(".cursor-pointer") || header.nextElementSibling;
    dispatchClick(trigger);
    return true;
  };
  const chooseOption = async (labelText, value) => {
    if (!value) return;
    if (!openSelect(labelText)) return;
    const opt = await (async (text, maxAttempts = 25, interval = 150) => {
      for (let a = 0; a < maxAttempts; a++) {
        const item = [...document.querySelectorAll("div")].find(el =>
          el.children.length === 0 && el.textContent.trim() === text
        );
        if (item) return item;
        await delay(interval);
      }
      return null;
    })(value);
    if (opt) {
      opt.scrollIntoView({ block: "center" });
      dispatchClick(opt);
    }
    await delay(300);
  };

  await chooseOption("Status Pernikahan", detail.statusPernikahan);
  await chooseOption("Penyandang disabilitas", detail.disabilitas);
  await chooseOption("Pekerjaan", detail.pekerjaan);

  if (detail.alamat?.length) {
    const setInputValue = (input, val) => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set.call(input, val);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    };
    const findModalButton = async (text, maxAttempts = 30, interval = 200) => {
      for (let a = 0; a < maxAttempts; a++) {
        const btn = [...document.querySelectorAll(".modal-content button.py-4")].find(el =>
          el.textContent.trim() === text
        );
        if (btn) return btn;
        await delay(interval);
      }
      return null;
    };
    openSelect("Alamat Domisili");
    await delay(600);
    for (const part of detail.alamat) {
      const searchInput = document.querySelector('.modal-content input[placeholder^="Cari"]');
      if (searchInput) {
        setInputValue(searchInput, part);
        await delay(400);
      }
      const itemBtn = await findModalButton(part);
      if (!itemBtn) break;
      itemBtn.scrollIntoView({ block: "center" });
      itemBtn.click();
      await delay(800);
    }
  }

  if (detail.detailAlamat) {
    const detailEl = document.querySelector("#detail-domisili");
    if (detailEl) {
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set.call(detailEl, detail.detailAlamat);
      detailEl.dispatchEvent(new Event("input", { bubbles: true }));
      detailEl.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }
  return true;
}

async function fillStep2AlamatSekolah(detail) {
  const delay = ms => new Promise(r => setTimeout(r, ms));
  const dispatchClick = el => ["pointerdown", "mousedown", "pointerup", "mouseup", "click"].forEach(evt =>
    el.dispatchEvent(new MouseEvent(evt, { bubbles: true, cancelable: true, view: window }))
  );
  const openSelect = labelText => {
    const header = [...document.querySelectorAll("div")].find(el =>
      el.classList.contains("font-semibold") && el.textContent.trim() === labelText + " *"
    );
    if (!header || !header.nextElementSibling) return false;
    const trigger = header.nextElementSibling.querySelector(".cursor-pointer") || header.nextElementSibling;
    dispatchClick(trigger);
    return true;
  };
  const chooseOption = async (labelText, value) => {
    if (!value) return;
    if (!openSelect(labelText)) return;
    const opt = await (async (text, maxAttempts = 25, interval = 150) => {
      for (let a = 0; a < maxAttempts; a++) {
        const item = [...document.querySelectorAll("div")].find(el =>
          el.children.length === 0 && el.textContent.trim() === text
        );
        if (item) return item;
        await delay(interval);
      }
      return null;
    })(value);
    if (opt) {
      opt.scrollIntoView({ block: "center" });
      dispatchClick(opt);
    }
    await delay(300);
  };

  await chooseOption("Status Pernikahan", detail.statusPernikahan);
  await chooseOption("Penyandang disabilitas", detail.disabilitas);
  await chooseOption("Nama Sekolah", detail.sekolah);
  await chooseOption("Jenjang Pendidikan", detail.kelas);

  if (detail.alamat?.length) {
    const setInputValue = (input, val) => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set.call(input, val);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    };
    const findModalButton = async (text, maxAttempts = 30, interval = 200) => {
      for (let a = 0; a < maxAttempts; a++) {
        const btn = [...document.querySelectorAll(".modal-content button.py-4")].find(el =>
          el.textContent.trim() === text
        );
        if (btn) return btn;
        await delay(interval);
      }
      return null;
    };
    openSelect("Alamat Domisili");
    await delay(600);
    for (const part of detail.alamat) {
      const searchInput = document.querySelector('.modal-content input[placeholder^="Cari"]');
      if (searchInput) {
        setInputValue(searchInput, part);
        await delay(400);
      }
      const itemBtn = await findModalButton(part);
      if (!itemBtn) break;
      itemBtn.scrollIntoView({ block: "center" });
      itemBtn.click();
      await delay(800);
    }
  }

  if (detail.detailAlamat) {
    const detailEl = document.querySelector("#detail-domisili");
    if (detailEl) {
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set.call(detailEl, detail.detailAlamat);
      detailEl.dispatchEvent(new Event("input", { bubbles: true }));
      detailEl.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }
  return true;
}

export class PendaftaranAutomation {
  constructor({ tabId, patient, patientIndex, onStatus, delayMultiplier = 1, category = "UMUM", skipKonfirmasiHadir = false }) {
    this.tabId = tabId;
    this.patient = patient;
    this._patientIndex = patientIndex;
    this.onStatus = onStatus;
    this._stopped = false;
    this._reported = false;
    this._outcome = null;
    this._dm = Math.max(0.5, delayMultiplier);
    this.category = category;
    this.skipKonfirmasiHadir = !!skipKonfirmasiHadir;
    const isSchool = "SEKOLAH" === category;
    this._timeoutNav = isSchool ? 10000 : 25000;
    this._timeoutApi = isSchool ? 8000 : 20000;
    this._timeoutTicket = isSchool ? 10000 : 20000;
  }

  _sleep(ms) {
    return sleep(Math.round(ms * this._dm));
  }

  stop() {
    this._stopped = true;
  }

  async _isStopped() {
    if (this._stopped) return true;
    const key = `pendaftaranStop_${this._patientIndex}`;
    const res = await chrome.storage.session.get(key);
    if (res[key]) {
      this._stopped = true;
      return true;
    }
    return false;
  }

  _applyScreenedOutcome(screenedRes) {
    const tgl = screenedRes?.tgl || screenedRes?.screeningDate || screenedRes?.screening_date || "";
    let faskes = screenedRes?.faskes || screenedRes?.screeningFaskes || screenedRes?.screening_faskes || "";
    let layanan = screenedRes?.layanan || screenedRes?.screeningLayanan || screenedRes?.screening_layanan || "";
    const detail = screenedRes?.detail || screenedRes?.screeningDetail || screenedRes?.screening_detail || "";

    if (/whatsapp|notifikasi/i.test(faskes)) faskes = "";
    if (/selesai\s*diperiksa|menerima\s*layanan/i.test(layanan)) layanan = "";

    let reason = screenedRes?.reason || "Peserta sudah menerima layanan skrining CKG pada periode ini";
    if (!reason || reason.startsWith("modal:") || /whatsapp|notifikasi/i.test(reason)) {
      reason = detail || "Peserta sudah menerima layanan skrining CKG pada periode ini";
      if (faskes && !reason.includes(faskes)) reason += ` (Puskesmas pemeriksa: ${faskes})`;
      if (tgl && !reason.includes(tgl)) reason += ` (Tanggal pemeriksaan: ${tgl})`;
      if (layanan && !reason.includes(layanan)) reason += ` (Layanan: ${layanan})`;
      reason += ". Silakan arahkan peserta untuk melihat rapor di SSM/WhatsApp.";
    }

    this._outcome = {
      status: "already-screened",
      ticketNumber: null,
      errorMsg: reason,
      screeningDate: tgl,
      screeningFaskes: faskes,
      screeningLayanan: layanan,
      screeningDetail: detail
    };

    if (this.patient) {
      if (tgl) this.patient._screeningDate = tgl;
      if (faskes) this.patient._screeningFaskes = faskes;
      if (layanan) this.patient._screeningLayanan = layanan;
      if (detail) this.patient._screeningDetail = detail;
    }
  }

  async _waitForScreenedModal(timeoutMs = 2500) {
    const end = Date.now() + timeoutMs;
    let best = null;
    while (Date.now() < end) {
      if (await this._isStopped()) return best;
      const res = await executeInTab(this.tabId, checkAlreadyScreenedModal).catch(() => null);
      if (res && (res.isMatch || res.tgl || res.faskes)) {
        best = res;
        if (res.tgl && res.faskes) return res;
        await sleep(250);
        continue;
      }
      await sleep(200);
    }
    return best;
  }

  async _ensureTanpaWaliChecked(tabId, sendCdp) {
    if (this._waliChecked) return "already";

    const res = await executeInTab(tabId, checkTanpaWaliCheckbox, [0, !!sendCdp]).catch(() => null);
    if (!res || !res.found) {
      return "absent";
    }

    // Jika sudah terkunci (disabled) sebelum kita klik
    if (res.alreadyChecked || res.checkedAfterClick) {
      this._waliChecked = true;
      return "already";
    }

    // Hardware CDP click TEPAT 1 KALI SAJA langsung ke kotak centang
    if (sendCdp && res.x && res.y) {
      await sendCdp("Input.dispatchMouseEvent", { type: "mousePressed", x: res.x, y: res.y, button: "left", clickCount: 1 }).catch(() => {});
      await this._sleep(80);
      await sendCdp("Input.dispatchMouseEvent", { type: "mouseReleased", x: res.x, y: res.y, button: "left", clickCount: 1 }).catch(() => {});
      this._waliChecked = true;
      await this._sleep(300);
      return "checked";
    } else {
      await executeInTab(tabId, () => {
        const cb = document.querySelector('input[type="checkbox"]');
        if (cb) cb.click();
      }).catch(() => {});
      this._waliChecked = true;
      await this._sleep(300);
      return "checked";
    }
  }

  async _ensureDebuggerAttached(tabId) {
    const attachPromise = () =>
      new Promise((resolve, reject) =>
        chrome.debugger.attach({ tabId }, "1.3", () =>
          chrome.runtime.lastError ? reject(new Error(chrome.runtime.lastError.message)) : resolve()
        )
      );
    try {
      await attachPromise();
    } catch (err) {
      if (!/already attached/i.test(err.message)) {
        await chrome.debugger.detach({ tabId }).catch(() => {});
        await this._sleep(200);
        try {
          await attachPromise();
        } catch (e) {
          if (!/already attached/i.test(e.message)) {
            console.warn("[Pendaftaran] Debugger attach error:", e.message);
          }
        }
      }
    }
  }

  async _waitForTabComplete(tabId, timeout = 20000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      if (await this._isStopped()) return false;
      try {
        const t = await chrome.tabs.get(tabId);
        if (t.status === "complete") return true;
      } catch (_) {}
      await this._sleep(400);
    }
    return false;
  }

  async _ensureRegistrationFormReady(tabId, timeout = 15000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      if (await this._isStopped()) return false;
      const ready = await executeInTab(tabId, () => {
        const btn = Array.from(document.querySelectorAll("button")).find(b => "Daftar Baru" === b.textContent.trim());
        const hasInput = !!document.getElementById("nik") || !!document.querySelector('input[placeholder*="NIK"]');
        if (btn && !hasInput) {
          btn.click();
          return false;
        }
        return hasInput;
      }).catch(() => false);
      if (ready) return true;
      await this._sleep(400);
    }
    return false;
  }

  async run() {
    const { tabId, patient, category } = this;
    this._waliChecked = false;
    await chrome.storage.session.remove(`pendaftaranStop_${this._patientIndex}`);

    const URL_MAP = {
      UMUM: "https://sehatindonesiaku.kemkes.go.id/ckg-pendaftaran-individu",
      SEKOLAH: "https://sehatindonesiaku.kemkes.go.id/ckg-pendaftaran-anak-sekolah"
    };
    const targetUrl = URL_MAP[category] ?? URL_MAP.UMUM;
    const pathIndicator = targetUrl.split("/").pop();

    let sendCdp = null;
    let debuggerAttached = false;

    try {
      // 1. Navigate to target URL
      await chrome.tabs.update(tabId, { url: targetUrl });
      await (async (tid, checkUrl, timeout = 20000, isStop = () => false) => {
        const end = Date.now() + timeout;
        while (Date.now() < end) {
          if (isStop()) return;
          try {
            const t = await chrome.tabs.get(tid);
            if (checkUrl(t.url) && "complete" === t.status) return;
          } catch (e) { }
          await sleep(400);
        }
        throw new Error("Navigation timeout");
      })(tabId, u => (u || "").includes(pathIndicator), this._timeoutNav, () => this._stopped);

      if (await this._isStopped()) return;

      // 2. Attach Debugger
      await this._ensureDebuggerAttached(tabId);
      debuggerAttached = true;
      sendCdp = (method, params = {}) =>
        new Promise((resolve, reject) =>
          chrome.debugger.sendCommand({ tabId }, method, params, result =>
            chrome.runtime.lastError ? reject(new Error(chrome.runtime.lastError.message)) : resolve(result)
          )
        );

      // 3. Ensure on registration page or click "Daftar Baru"
      await this._ensureRegistrationFormReady(tabId, this._timeoutNav);
      if (await this._isStopped()) return;

      // 4. Type NIK and click "Cek NIK" (dengan batas waktu loading 10s & auto-refresh)
      const cleanNik = String(patient.nik ?? patient.NIK ?? "").trim();
      if (cleanNik) {
        let isDukcapilFound = false;
        let checkRes = null;
        let detectionDone = false;
        const MAX_NIK_ATTEMPTS = 3;

        for (let nikAttempt = 0; nikAttempt < MAX_NIK_ATTEMPTS; nikAttempt++) {
          if (await this._isStopped()) return;

          if (nikAttempt > 0) {
            console.log(`[Pendaftaran] Percobaan ke-${nikAttempt + 1} Cek NIK setelah reload...`);
            await this._waitForTabComplete(tabId, 20000);
            await this._sleep(600);
            await this._ensureDebuggerAttached(tabId);
            this._waliChecked = false;
            await this._ensureRegistrationFormReady(tabId, 15000);
            await this._sleep(400);
          }

          await executeInTab(tabId, installNikInterceptor);
          await executeInTab(tabId, resetNikCheckResult);
          await executeInTab(tabId, typeNik, [cleanNik]);
          await sleep(300);
          await executeInTab(tabId, clickCekNik);

          // Batas waktu loading 10 detik sesuai permintaan user
          const nikDeadline = Date.now() + 10000;
          let needReload = false;

          while (Date.now() < nikDeadline) {
            if (await this._isStopped()) return;

            // 1. Cek langsung modal Gambar 1 / Gambar 2 di tab
            const modalInfo = await executeInTab(tabId, checkModalStatus).catch(() => null);
            if (modalInfo) {
              isDukcapilFound = !!modalInfo.found;
              detectionDone = true;
              break;
            }

            // 2. Cek intercepted API response
            checkRes = await executeInTab(tabId, getNikCheckResult);
            if (checkRes) {
              if (checkRes.status >= 500) {
                needReload = true;
                break;
              }
              isDukcapilFound = checkRes.found ?? (200 === checkRes.status && (null == checkRes.bodyStatusCode || 200 === checkRes.bodyStatusCode));
              detectionDone = true;
              break;
            }

            // 3. Cek jika modal "Individu sudah menerima layanan" langsung muncul setelah Cek NIK
            const isAlreadyScreened = await executeInTab(tabId, checkAlreadyScreenedModal).catch(() => false);
            if (isAlreadyScreened && (isAlreadyScreened.isMatch || isAlreadyScreened.tgl || isAlreadyScreened.faskes)) {
              this._applyScreenedOutcome(isAlreadyScreened);
              await chrome.tabs.reload(tabId);
              return;
            }

            // 4. Cek jika modal "Data peserta tidak valid" langsung muncul setelah Cek NIK
            const isInvalid = await executeInTab(tabId, checkInvalidDataModal).catch(() => false);
            if (isInvalid) {
              this._outcome = { status: "invalid-nik", ticketNumber: null };
              await chrome.tabs.reload(tabId);
              return;
            }

            // 5. Cek jika dialog warning/alert (tanda seru oranye dengan tombol Ok) muncul
            const alertDetected = await executeInTab(tabId, () => {
              const buttons = Array.from(document.querySelectorAll("button, a, div[role='button']"));
              const okBtn = buttons.find(b => {
                const t = (b.textContent || b.innerText || "").trim().toLowerCase();
                return t === "ok" || t === "oke";
              });
              if (okBtn) {
                try { okBtn.click(); } catch (_) {}
                return true;
              }
              return false;
            }).catch(() => false);

            if (alertDetected) {
              needReload = true;
              break;
            }

            await sleep(300);
          }

          if (detectionDone) {
            // Cek jika respon API atau teks mengindikasikan sudah menerima layanan
            const checkBodyStr = JSON.stringify(checkRes?.body || "").toLowerCase();
            if (
              checkBodyStr.includes("sudah menerima layanan") ||
              checkBodyStr.includes("selesai diperiksa") ||
              checkBodyStr.includes("already screened") ||
              checkBodyStr.includes("already_screened") ||
              checkBodyStr.includes("sudah terdaftar")
            ) {
              const screenedRes = (await this._waitForScreenedModal(2500)) || {};
              this._applyScreenedOutcome(screenedRes);
              await chrome.tabs.reload(tabId);
              return;
            }

            const isAlreadyScreened2 = await this._waitForScreenedModal(1500);
            if (isAlreadyScreened2 && (isAlreadyScreened2.isMatch || isAlreadyScreened2.tgl || isAlreadyScreened2.faskes)) {
              this._applyScreenedOutcome(isAlreadyScreened2);
              await chrome.tabs.reload(tabId);
              return;
            }

            if (await executeInTab(tabId, checkInvalidDataModal).catch(() => false)) {
              this._outcome = { status: "invalid-nik", ticketNumber: null };
              await chrome.tabs.reload(tabId);
              return;
            }

            // Hasil valid didapatkan
            break;
          }

          // Jika loading > 10 detik atau server error / alert muncul
          if (!detectionDone || needReload) {
            console.warn(`[Pendaftaran] Cek NIK loading > 10 detik atau server error (Percobaan ${nikAttempt + 1}/${MAX_NIK_ATTEMPTS}), me-refresh halaman...`);
            // Klik tombol Ok alert jika masih ada
            await executeInTab(tabId, () => {
              const okBtn = Array.from(document.querySelectorAll("button, a, div[role='button']")).find(b => {
                const t = (b.textContent || b.innerText || "").trim().toLowerCase();
                return t === "ok" || t === "oke" || t === "tutup";
              });
              if (okBtn) {
                try { okBtn.click(); } catch (_) {}
              }
            }).catch(() => {});
            await sleep(200);

            if (nikAttempt < MAX_NIK_ATTEMPTS - 1) {
              await chrome.tabs.reload(tabId).catch(() => {});
              await sleep(1500);
              continue;
            } else {
              throw new Error("Server ASIK/Dukcapil loading lama (> 10 detik) setelah 3 kali refresh.");
            }
          }
        }

        // If data was NOT found in Dukcapil, make sure "Isi Manual" modal is clicked if still open
        if (!isDukcapilFound) {
          await executeInTab(tabId, () => {
            const btnManual = Array.from(document.querySelectorAll("button, a, div[role='button']")).find(b =>
              /isi manual/i.test((b.textContent || b.innerText || "").trim())
            );
            if (btnManual && !btnManual.disabled) {
              try {
                btnManual.click();
              } catch (e) { }
              return true;
            }
            return false;
          });
          await this._sleep(400);
        }

        if (isDukcapilFound) {
          // GAMBAR 1: Data ditemukan di Dukcapil -> Klik "Gunakan Data" lalu langsung ke Jadwal
          await this._sleep(500);
          if (await this._isStopped()) return;
          let modalClosed = false;
          for (let attempt = 0; attempt < 12 && !modalClosed; attempt++) {
            if (await this._isStopped()) return;
            modalClosed = await executeInTab(tabId, clickGunakanData);
            if (!modalClosed && sendCdp) {
              await (async cdp => {
                const { result } = await cdp("Runtime.evaluate", {
                  expression: `(() => {
                    const btn = Array.from(document.querySelectorAll("button, a, div[role='button']")).find(b =>
                      /gunakan data/i.test((b.textContent || b.innerText || "").trim())
                    );
                    if (!btn) return JSON.stringify({ found: false });
                    btn.scrollIntoView({ block: 'center' });
                    const r = btn.getBoundingClientRect();
                    return JSON.stringify({
                      found: true,
                      x: Math.round(r.x + r.width / 2),
                      y: Math.round(r.y + r.height / 2)
                    });
                  })()`,
                  returnByValue: true
                });
                const parsed = JSON.parse(result.value);
                if (parsed.found) {
                  await cdp("Input.dispatchMouseEvent", { type: "mousePressed", x: parsed.x, y: parsed.y, button: "left", clickCount: 1 });
                  await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x: parsed.x, y: parsed.y, button: "left", clickCount: 1 });
                  return true;
                }
                return false;
              })(sendCdp).catch(() => false);

              await this._sleep(300);
              modalClosed = await executeInTab(tabId, () => {
                return !Array.from(document.querySelectorAll("button, a, div[role='button']")).some(b =>
                  /gunakan data/i.test((b.textContent || b.innerText || "").trim())
                );
              });
            }
            if (!modalClosed) await this._sleep(400);
          }
          await this._sleep(600);

          // PENTING: Untuk lansia/balita pada data Dukcapil, centang "Daftarkan tanpa data wali" jika muncul
          await this._ensureTanpaWaliChecked(tabId, sendCdp);
          await this._sleep(300);
        } else {
          // GAMBAR 2: DATA BARU -> Ketik identitas lengkap dari data Excel
          await this._sleep(400);
          if (await this._isStopped()) return;

          // PENTING: Untuk lansia/balita, SEBELUM ISI IDENTITAS centang dulu "Daftarkan tanpa data wali"
          await this._ensureTanpaWaliChecked(tabId, sendCdp);
          await this._sleep(400);

          // 1. Nama
          const namaVal = sanitizeName(patient.nama ?? patient.Nama ?? patient.NAMA ?? "");
          if (namaVal) {
            await executeInTab(tabId, fillTextInput, ["Nama", namaVal]);
            await this._sleep(300);
          }

          // 2. Nomor WhatsApp
          const rawWa = String(patient.wa ?? patient.nowhatsapp ?? patient.nohp ?? patient.hp ?? patient.telp ?? patient.no_wa ?? patient.no_hp ?? patient.telepon ?? patient.phone ?? "")
            .replace(/\D/g, "")
            .replace(/^62/, "")
            .replace(/^0+/, "");
          const waVal = (rawWa.length >= 6 ? rawWa : "") || "81225566666";
          await executeInTab(tabId, fillTextInput, ["Nomor Whatsapp", waVal]);
          await this._sleep(300);

          if (await this._isStopped()) return;

          // 3. Tanggal Lahir
          let lahirObj = this._parseLahir(patient);
          if (!lahirObj) {
            const cleanNik = String(patient.nik || patient.NIK || "").replace(/\D/g, "");
            if (cleanNik.length === 16) {
              let day = parseInt(cleanNik.substr(6, 2), 10);
              const month = parseInt(cleanNik.substr(8, 2), 10);
              const yearShort = parseInt(cleanNik.substr(10, 2), 10);
              if (day > 40) day -= 40;
              const currentYear = new Date().getFullYear();
              const fullYear = yearShort > (currentYear % 100) ? 1900 + yearShort : 2000 + yearShort;
              const monthMap = { 1: "Jan", 2: "Feb", 3: "Mar", 4: "Apr", 5: "Mei", 6: "Jun", 7: "Jul", 8: "Agt", 9: "Sep", 10: "Okt", 11: "Nov", 12: "Des" };
              lahirObj = { tahun: String(fullYear), bulan: monthMap[month] || "Jan", tanggal: String(day) };
            }
          }

          if (lahirObj) {
            let birthRes = await executeInTab(tabId, fillBirthDate, [lahirObj]);
            if (birthRes !== "ok" && sendCdp) {
              // CDP hardware click on datepicker wrapper
              await (async cdp => {
                const { result } = await cdp("Runtime.evaluate", {
                  expression: `(() => {
                    const input = document.querySelector('input[placeholder*="tanggal lahir" i]')
                      || document.querySelector('.mx-datepicker input')
                      || document.querySelector('.mx-input-wrapper');
                    const el = input ? (input.closest('.mx-input-wrapper') || input) : document.querySelector('.mx-input-wrapper');
                    if (!el) return JSON.stringify({ found: false });
                    el.scrollIntoView({ block: 'center' });
                    const r = el.getBoundingClientRect();
                    return JSON.stringify({
                      found: true,
                      x: Math.round(r.x + r.width / 2),
                      y: Math.round(r.y + r.height / 2)
                    });
                  })()`,
                  returnByValue: true
                });
                const parsed = JSON.parse(result.value);
                if (parsed.found) {
                  await cdp("Input.dispatchMouseEvent", { type: "mousePressed", x: parsed.x, y: parsed.y, button: "left", clickCount: 1 });
                  await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x: parsed.x, y: parsed.y, button: "left", clickCount: 1 });
                  return true;
                }
                return false;
              })(sendCdp).catch(() => false);

              await this._sleep(400);
              birthRes = await executeInTab(tabId, fillBirthDate, [lahirObj]);
            }
            await this._sleep(600);
          }

          if (await this._isStopped()) return;

          // 4. Jenis Kelamin
          const jkVal = this._parseJenisKelamin(patient);
          if (jkVal) {
            await executeInTab(tabId, openGenderDropdown);
            await this._sleep(500);
            await executeInTab(tabId, selectGenderOption, [jkVal]);
            await this._sleep(400);
          }

          // Re-check jikalau form wali baru terpicu muncul setelah pengisian tanggal lahir
          await this._ensureTanpaWaliChecked(tabId, sendCdp);
          await this._sleep(300);
        }
      }

      if (await this._isStopped()) return;

      // 5. Select Schedule Date
      let dateClickRes = await executeInTab(tabId, selectScheduleDate);
      if (dateClickRes && !dateClickRes.alreadySelected && dateClickRes.x && dateClickRes.y && sendCdp) {
        await sendCdp("Input.dispatchMouseEvent", { type: "mousePressed", x: dateClickRes.x, y: dateClickRes.y, button: "left", clickCount: 1 }).catch(() => {});
        await this._sleep(80);
        await sendCdp("Input.dispatchMouseEvent", { type: "mouseReleased", x: dateClickRes.x, y: dateClickRes.y, button: "left", clickCount: 1 }).catch(() => {});
        await this._sleep(400);
      }
      if (await this._isStopped()) return;

      // 6. Click Selanjutnya and validate
      await executeInTab(tabId, installValidationInterceptor);
      await executeInTab(tabId, resetValidasiResult);

      let selRes = await executeInTab(tabId, clickSelanjutnya);

      // Jika tombol Selanjutnya masih disabled, pastikan wali terkunci & jadwal terpilih (ulangi hingga 3x)
      for (let retry = 0; retry < 3 && selRes?.disabled; retry++) {
        if (await this._isStopped()) return;
        await this._sleep(300);
        await this._ensureTanpaWaliChecked(tabId, sendCdp);
        await this._sleep(250);
        dateClickRes = await executeInTab(tabId, selectScheduleDate);
        if (dateClickRes && dateClickRes.x && dateClickRes.y && sendCdp) {
          await sendCdp("Input.dispatchMouseEvent", { type: "mousePressed", x: dateClickRes.x, y: dateClickRes.y, button: "left", clickCount: 1 }).catch(() => {});
          await this._sleep(80);
          await sendCdp("Input.dispatchMouseEvent", { type: "mouseReleased", x: dateClickRes.x, y: dateClickRes.y, button: "left", clickCount: 1 }).catch(() => {});
          await this._sleep(400);
        }
        selRes = await executeInTab(tabId, clickSelanjutnya);
      }

      // Hardware CDP click ke tombol Selanjutnya
      if (selRes?.found && !selRes?.disabled && selRes.x && selRes.y && sendCdp) {
        await sendCdp("Input.dispatchMouseEvent", { type: "mousePressed", x: selRes.x, y: selRes.y, button: "left", clickCount: 1 }).catch(() => {});
        await this._sleep(80);
        await sendCdp("Input.dispatchMouseEvent", { type: "mouseReleased", x: selRes.x, y: selRes.y, button: "left", clickCount: 1 }).catch(() => {});
      }

      let validasiData = null;
      let lastSelClick = Date.now();
      const validasiEnd = Date.now() + Math.max(15000, this._timeoutApi);
      while (Date.now() < validasiEnd) {
        if (await this._isStopped()) return;

        // Jika setelah 3 detik belum ada respon validasi & modal belum muncul, coba trigger Selanjutnya lagi
        if (!validasiData && Date.now() - lastSelClick > 3000) {
          lastSelClick = Date.now();
          const retryBtn = await executeInTab(tabId, clickSelanjutnya).catch(() => null);
          if (retryBtn?.found && !retryBtn?.disabled && retryBtn.x && retryBtn.y && sendCdp) {
            await sendCdp("Input.dispatchMouseEvent", { type: "mousePressed", x: retryBtn.x, y: retryBtn.y, button: "left", clickCount: 1 }).catch(() => {});
            await this._sleep(60);
            await sendCdp("Input.dispatchMouseEvent", { type: "mouseReleased", x: retryBtn.x, y: retryBtn.y, button: "left", clickCount: 1 }).catch(() => {});
          }
        }
        if (await this._isStopped()) return;

        // 1. Cek langsung modal "Data peserta tidak valid" di tab (prioritas jika data salah)
        const isInvalidData = await executeInTab(tabId, checkInvalidDataModal).catch(() => false);
        if (isInvalidData) {
          this._outcome = { status: "invalid-nik", ticketNumber: null };
          await chrome.tabs.reload(tabId);
          return;
        }

        // 2. Cek modal "Data peserta valid" di tab (prioritas jika modal muncul di layar)
        validasiData = await executeInTab(tabId, checkValidationModal);
        if (validasiData) {
          if (validasiData?.data?.validation_code === "INVALID_DATA") {
            this._outcome = { status: "invalid-nik", ticketNumber: null };
            await chrome.tabs.reload(tabId);
            return;
          }
          break;
        }

        // 3. Cek intercepted API response
        validasiData = await executeInTab(tabId, getValidasiResult);
        if (validasiData) {
          const valBodyStr = JSON.stringify(validasiData || "").toLowerCase();
          if (
            valBodyStr.includes("sudah menerima layanan") ||
            valBodyStr.includes("selesai diperiksa") ||
            valBodyStr.includes("already screened") ||
            valBodyStr.includes("already_screened") ||
            validasiData?.data?.validation_code === "ALREADY_SCREENED"
          ) {
            const screenedRes = (await this._waitForScreenedModal(2500)) || {};
            this._applyScreenedOutcome(screenedRes);
            await chrome.tabs.reload(tabId);
            return;
          }
          if (
            valBodyStr.includes("tidak valid") ||
            valBodyStr.includes("invalid") ||
            validasiData?.data?.validation_code === "INVALID_DATA"
          ) {
            await executeInTab(tabId, checkInvalidDataModal).catch(() => { });
            this._outcome = { status: "invalid-nik", ticketNumber: null };
            await chrome.tabs.reload(tabId);
            return;
          }
          break;
        }

        // 4. Cek modal "Individu sudah menerima layanan"
        const isAlreadyScreened = await executeInTab(tabId, checkAlreadyScreenedModal).catch(() => false);
        if (isAlreadyScreened && (isAlreadyScreened.isMatch || isAlreadyScreened.tgl || isAlreadyScreened.faskes)) {
          this._applyScreenedOutcome(isAlreadyScreened);
          await chrome.tabs.reload(tabId);
          return;
        }

        await sleep(300);
      }

      // Cek modal tidak valid lagi setelah loop
      if (await executeInTab(tabId, checkInvalidDataModal).catch(() => false)) {
        this._outcome = { status: "invalid-nik", ticketNumber: null };
        await chrome.tabs.reload(tabId);
        return;
      }

      // Cek modal sudah menerima layanan lagi setelah loop
      const isAlreadyScreenedPost = await this._waitForScreenedModal(1500);
      if (isAlreadyScreenedPost && (isAlreadyScreenedPost.isMatch || isAlreadyScreenedPost.tgl || isAlreadyScreenedPost.faskes)) {
        this._applyScreenedOutcome(isAlreadyScreenedPost);
        await chrome.tabs.reload(tabId);
        return;
      }

      const valBodyStr = JSON.stringify(validasiData || "").toLowerCase();
      const valCode = validasiData?.data?.validation_code;
      if (
        "ALREADY_SCREENED" === valCode ||
        validasiData?.screenedInfo ||
        valBodyStr.includes("sudah menerima layanan") ||
        valBodyStr.includes("selesai diperiksa") ||
        valBodyStr.includes("already screened") ||
        valBodyStr.includes("already_screened")
      ) {
        const screenedRes = validasiData?.screenedInfo || (await this._waitForScreenedModal(2500)) || {};
        this._applyScreenedOutcome(screenedRes);
        await chrome.tabs.reload(tabId);
        return;
      }
      if ("INVALID_DATA" === valCode || valBodyStr.includes("tidak valid") || valBodyStr.includes("invalid")) {
        await executeInTab(tabId, checkInvalidDataModal).catch(() => { });
        this._outcome = { status: "invalid-nik", ticketNumber: null };
        await chrome.tabs.reload(tabId);
        return;
      }

      // Cek apakah data valid (dari modal "Data peserta valid" atau API)
      let isDataValid =
        "VALID" === valCode ||
        validasiData?.fromModal === true ||
        validasiData?.data?.is_valid === true ||
        (validasiData?.status >= 200 && validasiData?.status < 300 && !valBodyStr.includes("error") && !valBodyStr.includes("gagal"));

      if (!isDataValid) {
        // Cek lagi apakah modal "Data peserta valid" ada di layar
        const modalRetry = await executeInTab(tabId, checkValidationModal).catch(() => null);
        if (modalRetry?.data?.validation_code === "VALID") {
          isDataValid = true;
          validasiData = modalRetry;
        } else if (modalRetry?.data?.validation_code === "INVALID_DATA") {
          this._outcome = { status: "invalid-nik", ticketNumber: null };
          await chrome.tabs.reload(tabId);
          return;
        }
      }

      if (!isDataValid) {
        // Cek apakah modal tidak valid ada di layar
        if (await executeInTab(tabId, checkInvalidDataModal).catch(() => false)) {
          this._outcome = { status: "invalid-nik", ticketNumber: null };
          await chrome.tabs.reload(tabId);
          return;
        }
        // Terakhir kali sebelum dianggap error, cek lagi apakah modal sudah daftar ada
        const isAlreadyScreenedRetry = await executeInTab(tabId, checkAlreadyScreenedModal).catch(() => false);
        if (isAlreadyScreenedRetry && (isAlreadyScreenedRetry.isMatch || isAlreadyScreenedRetry.tgl || isAlreadyScreenedRetry.faskes)) {
          this._applyScreenedOutcome(isAlreadyScreenedRetry);
          await chrome.tabs.reload(tabId);
          return;
        }
        this._outcome = { status: "error", ticketNumber: null };
        await chrome.tabs.reload(tabId);
        return;
      }

      // 8. Klik tombol "Lanjutkan" untuk menutup modal dan masuk ke form selanjutnya (Step 2 Alamat/Sekolah)
      await this._sleep(400);
      if (await this._isStopped()) return;

      let clickedLanjutkan = false;
      for (let attempt = 0; attempt < 10 && !clickedLanjutkan; attempt++) {
        if (await this._isStopped()) return;
        clickedLanjutkan = await executeInTab(tabId, clickLanjutkan);
        if (!clickedLanjutkan && sendCdp) {
          // Fallback CDP mouse click ke tombol Lanjutkan
          clickedLanjutkan = await (async cdp => {
            const { result } = await cdp("Runtime.evaluate", {
              expression: `(() => {
                const btn = Array.from(document.querySelectorAll("button, a, div[role='button']")).find(b =>
                  /lanjutkan/i.test((b.textContent || b.innerText || "").trim())
                );
                if (!btn) return JSON.stringify({ found: false });
                btn.scrollIntoView({ block: 'center' });
                const r = btn.getBoundingClientRect();
                return JSON.stringify({
                  found: true,
                  x: Math.round(r.x + r.width / 2),
                  y: Math.round(r.y + r.height / 2)
                });
              })()`,
              returnByValue: true
            });
            const parsed = JSON.parse(result.value);
            if (parsed.found) {
              await cdp("Input.dispatchMouseEvent", { type: "mousePressed", x: parsed.x, y: parsed.y, button: "left", clickCount: 1 });
              await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x: parsed.x, y: parsed.y, button: "left", clickCount: 1 });
              return true;
            }
            return false;
          })(sendCdp).catch(() => false);
        }
        if (!clickedLanjutkan) await this._sleep(400);
      }

      await this._sleep(800);
      if (await this._isStopped()) return;

      // 9. Step 2 (Alamat / Sekolah)
      if ("SEKOLAH" === this.category) {
        const sekolahDetail = this._parseDetailFormSekolah(patient);
        await executeInTab(tabId, fillStep2AlamatSekolah, [sekolahDetail]);
      } else {
        const umumDetail = this._parseDetailForm(patient);
        await executeInTab(tabId, fillStep2AlamatUmum, [umumDetail]);
      }

      await this._sleep(500);
      if (await this._isStopped()) return;

      // 10. Click Selanjutnya -> Pilih
      const selRes2 = await executeInTab(tabId, clickSelanjutnya);
      if (selRes2?.found && !selRes2?.disabled && selRes2.x && selRes2.y && sendCdp) {
        await sendCdp("Input.dispatchMouseEvent", { type: "mousePressed", x: selRes2.x, y: selRes2.y, button: "left", clickCount: 1 }).catch(() => {});
        await this._sleep(60);
        await sendCdp("Input.dispatchMouseEvent", { type: "mouseReleased", x: selRes2.x, y: selRes2.y, button: "left", clickCount: 1 }).catch(() => {});
      }
      await this._sleep(800);
      if (await this._isStopped()) return;

      await executeInTab(tabId, clickPilih);
      await this._sleep(800);
      if (await this._isStopped()) return;

      // 11. Daftarkan (Klik Daftarkan seperti pada Gambar 3)
      await executeInTab(tabId, installRegisterInterceptor);
      await executeInTab(tabId, resetRegisterResult);

      let clickedDaftarkan = false;
      for (let attempt = 0; attempt < 10 && !clickedDaftarkan; attempt++) {
        if (await this._isStopped()) return;
        clickedDaftarkan = await executeInTab(tabId, () => {
          const isDaftar = b => /^(daftarkan|daftarkan dengan nik)$/i.test((b.textContent || b.innerText || "").trim()) ||
            /^daftarkan/i.test((b.textContent || b.innerText || "").trim()) ||
            ("submit" === b.type && /^daftarkan/i.test((b.textContent || b.innerText || "").trim()));
          const btn = Array.from(document.querySelectorAll("button, a, div[role='button']")).find(isDaftar);
          if (btn && !btn.disabled) {
            btn.focus();
            try {
              ["pointerdown", "mousedown", "pointerup", "mouseup", "click"].forEach(evt =>
                btn.dispatchEvent(new MouseEvent(evt, { bubbles: true, cancelable: true, view: window }))
              );
            } catch (e) {
              btn.click();
            }
            return true;
          }
          return false;
        });
        if (!clickedDaftarkan && sendCdp) {
          // Fallback CDP click ke tombol Daftarkan
          clickedDaftarkan = await (async cdp => {
            const { result } = await cdp("Runtime.evaluate", {
              expression: `(() => {
                const btn = Array.from(document.querySelectorAll("button, a, div[role='button']")).find(b =>
                  /^daftarkan/i.test((b.textContent || b.innerText || "").trim()) && !b.disabled
                );
                if (!btn) return JSON.stringify({ found: false });
                btn.scrollIntoView({ block: 'center' });
                const r = btn.getBoundingClientRect();
                return JSON.stringify({
                  found: true,
                  x: Math.round(r.x + r.width / 2),
                  y: Math.round(r.y + r.height / 2)
                });
              })()`,
              returnByValue: true
            });
            const parsed = JSON.parse(result.value);
            if (parsed.found) {
              await cdp("Input.dispatchMouseEvent", { type: "mousePressed", x: parsed.x, y: parsed.y, button: "left", clickCount: 1 });
              await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x: parsed.x, y: parsed.y, button: "left", clickCount: 1 });
              return true;
            }
            return false;
          })(sendCdp).catch(() => false);
        }
        if (!clickedDaftarkan) await this._sleep(400);
      }

      if (await this._isStopped()) return;

      // 12. Read Ticket Number (dari modal Berhasil Daftar seperti di Gambar 4)
      let ticketNum = null;
      const ticketEnd = Date.now() + this._timeoutTicket;
      while (Date.now() < ticketEnd) {
        if (await this._isStopped()) return;

        // Cek jika modal tidak valid atau sudah daftar muncul saat final submit
        if (await executeInTab(tabId, checkInvalidDataModal).catch(() => false)) {
          this._outcome = { status: "invalid-nik", ticketNumber: null };
          await chrome.tabs.reload(tabId);
          return;
        }
        const isScreenedSubmit = await executeInTab(tabId, checkAlreadyScreenedModal).catch(() => false);
        if (isScreenedSubmit && (isScreenedSubmit.isMatch || isScreenedSubmit.tgl || isScreenedSubmit.faskes)) {
          this._applyScreenedOutcome(isScreenedSubmit);
          await chrome.tabs.reload(tabId);
          return;
        }

        ticketNum = await executeInTab(tabId, () => {
          const bodyText = document.body?.innerText || "";
          const match = bodyText.match(/No\.?\s*Tiket\s*:\s*([A-Za-z0-9\-]+)/i);
          if (match) return match[1];
          const el = [...document.querySelectorAll("div, p, span, h2, h3")].find(
            d => /No\.?\s*Tiket:/i.test(d.textContent) && 0 === d.childElementCount
          );
          if (!el) return null;
          const match2 = el.textContent.match(/No\.?\s*Tiket:\s*(\S+)/i);
          return match2?.[1] ?? null;
        });
        if (ticketNum) break;
        await sleep(400);
      }
      this._ticketNumber = ticketNum;

      // 13. Verify Register API response (hanya jika nomor tiket belum terbaca dari modal)
      if (!ticketNum) {
        let regResult = null;
        const regEnd = Date.now() + 4000;
        while (Date.now() < regEnd) {
          if (await this._isStopped()) return;
          regResult = await executeInTab(tabId, getRegisterResult);
          if (regResult) break;
          await sleep(300);
        }

        if (regResult && !(regResult.status >= 200 && regResult.status < 300)) {
          const errMsg = (regResult.body?.data?.message || regResult.body?.message || JSON.stringify(regResult)).toLowerCase();
          if (
            errMsg.includes("sudah") ||
            errMsg.includes("terdaftar") ||
            errMsg.includes("already") ||
            errMsg.includes("pernah") ||
            errMsg.includes("layanan") ||
            errMsg.includes("diperiksa")
          ) {
            const screenedRes = (await this._waitForScreenedModal(2500)) || {};
            this._applyScreenedOutcome(screenedRes);
            await chrome.tabs.reload(tabId);
            return;
          }
          if (
            errMsg.includes("tidak valid") ||
            errMsg.includes("invalid") ||
            await executeInTab(tabId, checkInvalidDataModal).catch(() => false)
          ) {
            await executeInTab(tabId, checkInvalidDataModal).catch(() => { });
            this._outcome = { status: "invalid-nik", ticketNumber: null };
            await chrome.tabs.reload(tabId);
            return;
          }
          const isScreenedPostReg = await executeInTab(tabId, checkAlreadyScreenedModal).catch(() => false);
          if (isScreenedPostReg && (isScreenedPostReg.isMatch || isScreenedPostReg.tgl || isScreenedPostReg.faskes)) {
            this._applyScreenedOutcome(isScreenedPostReg);
            await chrome.tabs.reload(tabId);
            return;
          }
          this._outcome = { status: "error", ticketNumber: null };
          await chrome.tabs.reload(tabId);
          return;
        }
      }

      // 14. Click Tutup pada modal Gambar 4
      let closedModal = false;
      for (let attempt = 0; attempt < 8 && !closedModal; attempt++) {
        if (await this._isStopped()) return;
        closedModal = await executeInTab(tabId, () => {
          const btn = Array.from(document.querySelectorAll("button, a, div[role='button']")).find(b =>
            /^(tutup|selesai|ok)$/i.test((b.textContent || b.innerText || "").trim())
          );
          if (btn && !btn.disabled) {
            try {
              ["pointerdown", "mousedown", "pointerup", "mouseup", "click"].forEach(evt =>
                btn.dispatchEvent(new MouseEvent(evt, { bubbles: true, cancelable: true, view: window }))
              );
            } catch (e) {
              btn.click();
            }
            return true;
          }
          return false;
        });

        if (!closedModal && sendCdp) {
          closedModal = await (async cdp => {
            const { result } = await cdp("Runtime.evaluate", {
              expression: `(() => {
                const btn = Array.from(document.querySelectorAll("button, a, div[role='button']")).find(b =>
                  /^(tutup|selesai|ok)$/i.test((b.textContent || b.innerText || "").trim())
                );
                if (!btn) return JSON.stringify({ found: false });
                btn.scrollIntoView({ block: 'center' });
                const r = btn.getBoundingClientRect();
                return JSON.stringify({
                  found: true,
                  x: Math.round(r.x + r.width / 2),
                  y: Math.round(r.y + r.height / 2)
                });
              })()`,
              returnByValue: true
            });
            const parsed = JSON.parse(result.value);
            if (parsed.found) {
              await cdp("Input.dispatchMouseEvent", { type: "mousePressed", x: parsed.x, y: parsed.y, button: "left", clickCount: 1 });
              await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x: parsed.x, y: parsed.y, button: "left", clickCount: 1 });
              return true;
            }
            return false;
          })(sendCdp).catch(() => false);
        }
        if (!closedModal) await this._sleep(400);
      }

      await this._sleep(600);
      if (await this._isStopped()) return;

      // Jika user mengaktifkan "Lewati Konfirmasi Kehadiran", akhiri proses pendaftaran dengan status selesai
      if (this.skipKonfirmasiHadir) {
        this._outcome = { status: "done", ticketNumber: this._ticketNumber ?? null };
        return;
      }

      // 15. Konfirmasi Hadir (selalu dijalankan sampai proses kehadiran selesai)
      if ("SEKOLAH" === this.category) {
        const schoolParams = { sekolah: patient.sekolah, kelas: patient.kelas };
        await executeInTab(tabId, async (params, ticket) => {
          const delay = ms => new Promise(r => setTimeout(r, ms));
          const dispatchClick = el => ["pointerdown", "mousedown", "pointerup", "mouseup", "click"].forEach(evt =>
            el.dispatchEvent(new MouseEvent(evt, { bubbles: true, cancelable: true, view: window }))
          );
          const openDropdown = labelText => {
            const header = [...document.querySelectorAll("div")].find(el =>
              el.classList.contains("font-semibold") && (el.textContent.trim() === labelText + " *" || el.textContent.trim() === labelText)
            );
            if (!header || !header.nextElementSibling) return false;
            const trigger = header.nextElementSibling.querySelector(".cursor-pointer") || header.nextElementSibling;
            const actualTrigger = trigger.classList.contains("cursor-pointer") ? trigger : trigger.querySelector(".cursor-pointer") || trigger;
            dispatchClick(actualTrigger);
            return true;
          };
          const pickOption = async (labelText, value) => {
            if (!value) return;
            if (!openDropdown(labelText)) return;
            const opt = await (async (text, maxAttempts = 25, interval = 150) => {
              for (let a = 0; a < maxAttempts; a++) {
                const item = [...document.querySelectorAll("div")].find(el =>
                  el.children.length === 0 && el.textContent.trim() === text
                );
                if (item) return item;
                await delay(interval);
              }
              return null;
            })(value);
            if (opt) {
              opt.scrollIntoView({ block: "center" });
              dispatchClick(opt);
            }
            await delay(300);
          };

          if (params.sekolah) await pickOption("Sekolah", params.sekolah);
          if (params.kelas) await pickOption("Kelas", params.kelas);
          await delay(300);

          const searchInput = document.querySelector("#searchNik");
          if (searchInput) {
            searchInput.focus();
            searchInput.value = ticket;
            searchInput.dispatchEvent(new Event("input", { bubbles: true }));
            searchInput.dispatchEvent(new Event("change", { bubbles: true }));
            searchInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
            searchInput.dispatchEvent(new KeyboardEvent("keypress", { key: "Enter", bubbles: true, cancelable: true }));
            searchInput.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", bubbles: true, cancelable: true }));
          }
          return true;
        }, [schoolParams, ticketNum]);

        await this._sleep(500);

        await (async cdp => {
          let foundHadir = false;
          const end1 = Date.now() + 15000;
          while (Date.now() < end1) {
            const { result } = await cdp("Runtime.evaluate", {
              expression: `(() => {
                  const btn = Array.from(document.querySelectorAll('button')).find(
                    b => b.textContent.trim() === 'Konfirmasi Hadir'
                  );
                  if (!btn) return JSON.stringify({ found: false });
                  btn.scrollIntoView({ block: 'center' });
                  const r = btn.getBoundingClientRect();
                  return JSON.stringify({
                    found: true,
                    x: Math.round(r.x + r.width / 2),
                    y: Math.round(r.y + r.height / 2)
                  });
                })()`,
              returnByValue: true
            });
            const parsed = JSON.parse(result.value);
            if (parsed.found) {
              await cdp("Input.dispatchMouseEvent", { type: "mousePressed", x: parsed.x, y: parsed.y, button: "left", clickCount: 1 });
              await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x: parsed.x, y: parsed.y, button: "left", clickCount: 1 });
              foundHadir = true;
              break;
            }
            await sleep(500);
          }
          if (!foundHadir) throw new Error("Tombol Konfirmasi Hadir tidak ditemukan setelah 15 detik.");

          let verifyReady = false;
          const end2 = Date.now() + 12000;
          while (Date.now() < end2) {
            const { result } = await cdp("Runtime.evaluate", {
              expression: `(() => {
                  const cb = document.querySelector('input#verify');
                  if (!cb) return JSON.stringify({ ready: false });
                  cb.scrollIntoView({ block: 'center' });
                  const r = cb.getBoundingClientRect();
                  return JSON.stringify({
                    ready: true,
                    x: Math.round(r.x + r.width / 2),
                    y: Math.round(r.y + r.height / 2)
                  });
                })()`,
              returnByValue: true
            });
            const parsed = JSON.parse(result.value);
            if (parsed.ready) {
              await cdp("Input.dispatchMouseEvent", { type: "mousePressed", x: parsed.x, y: parsed.y, button: "left", clickCount: 1 });
              await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x: parsed.x, y: parsed.y, button: "left", clickCount: 1 });
              verifyReady = true;
              break;
            }
            await sleep(500);
          }
          if (!verifyReady) throw new Error("Checkbox #verify tidak ditemukan.");

          await sleep(300);
          const { result: hadirRes } = await cdp("Runtime.evaluate", {
            expression: `(() => {
                const btn = Array.from(document.querySelectorAll('button')).find(
                  b => b.textContent.trim() === 'Hadir' && !b.disabled
                );
                if (!btn) return JSON.stringify({ found: false });
                btn.scrollIntoView({ block: 'center' });
                const r = btn.getBoundingClientRect();
                return JSON.stringify({
                  found: true,
                  x: Math.round(r.x + r.width / 2),
                  y: Math.round(r.y + r.height / 2)
                });
              })()`,
            returnByValue: true
          });
          const hadirParsed = JSON.parse(hadirRes.value);
          if (!hadirParsed.found) throw new Error("Tombol Hadir tidak ditemukan.");

          await cdp("Input.dispatchMouseEvent", { type: "mousePressed", x: hadirParsed.x, y: hadirParsed.y, button: "left", clickCount: 1 });
          await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x: hadirParsed.x, y: hadirParsed.y, button: "left", clickCount: 1 });

          let tutupReady = false;
          const end3 = Date.now() + 15000;
          while (Date.now() < end3) {
            const { result } = await cdp("Runtime.evaluate", {
              expression: `(() => {
                  const btn = Array.from(document.querySelectorAll('button')).find(
                    b => b.textContent.trim() === 'Tutup'
                  );
                  if (!btn) return JSON.stringify({ found: false });
                  btn.scrollIntoView({ block: 'center' });
                  const r = btn.getBoundingClientRect();
                  return JSON.stringify({
                    found: true,
                    x: Math.round(r.x + r.width / 2),
                    y: Math.round(r.y + r.height / 2)
                  });
                })()`,
              returnByValue: true
            });
            const parsed = JSON.parse(result.value);
            if (parsed.found) {
              await cdp("Input.dispatchMouseEvent", { type: "mousePressed", x: parsed.x, y: parsed.y, button: "left", clickCount: 1 });
              await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x: parsed.x, y: parsed.y, button: "left", clickCount: 1 });
              tutupReady = true;
              break;
            }
            await sleep(300);
          }
          if (!tutupReady) throw new Error("Tombol Tutup tidak muncul setelah Hadir diklik.");
        })(sendCdp);
      } else {
        // UMUM (Cari berdasarkan Nomor Tiket atau NIK)
        const searchKey = ticketNum || cleanNik;
        if (searchKey) {
          await (async (cdp, ticket) => {
            await cdp("Runtime.evaluate", {
              expression: `(() => {
                  const el = document.querySelector('#searchNik');
                  if (!el) return false;
                  el.focus();
                  el.setSelectionRange(0, el.value.length);
                  return true;
                })()`
            });

            // Input ticket atau NIK
            await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: "Delete", code: "Delete", windowsVirtualKeyCode: 46, nativeVirtualKeyCode: 46 });
            await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "Delete", code: "Delete", windowsVirtualKeyCode: 46, nativeVirtualKeyCode: 46 });
            await cdp("Input.insertText", { text: ticket });
            await sleep(100);
            await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
            await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
          })(sendCdp, searchKey);

          await this._sleep(800);
        }

        if (await this._isStopped()) return;

        await (async cdp => {
          const evalExpr = async expr => {
            const { result } = await cdp("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
            return result.value;
          };
          const clickCoords = async (x, y) => {
            await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
            await cdp("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
            await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
          };
          const waitForExpr = async (expr, timeout = 10000) => {
            const end = Date.now() + timeout;
            while (Date.now() < end) {
              const res = await evalExpr(expr);
              if (res) return res;
              await sleep(200);
            }
            throw new Error("Timeout: " + expr);
          };
          const getCoords = elExpr =>
            evalExpr(`(() => {
                const el = ${elExpr};
                if (!el) return null;
                const r = el.getBoundingClientRect();
                return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
              })()`);

          await waitForExpr("!!Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === 'Konfirmasi Hadir')");
          await evalExpr("Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === 'Konfirmasi Hadir')?.click()");
          await waitForExpr("!!(document.querySelector('div.check') || document.querySelector('input#verify'))");

          const getStyledBox = () =>
            evalExpr(`(() => {
                const styled = document.querySelector('div#verify.check') || document.querySelector('div.check');
                if (!styled) return null;
                styled.scrollIntoView({ block: 'center', inline: 'center' });
                const r = styled.getBoundingClientRect();
                const x = r.x + r.width / 2, y = r.y + r.height / 2;
                const hit = document.elementFromPoint(x, y);
                const ok = hit && (hit === styled || styled.contains(hit) || hit.id === 'verify');
                const inView = y >= 0 && y <= window.innerHeight && x >= 0 && x <= window.innerWidth;
                return ok && inView ? { x, y } : null;
              })()`);

          const isVerifyChecked = () =>
            evalExpr(`(() => {
                const cb = document.querySelector('input#verify');
                const h = Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === 'Hadir');
                return !!(cb && cb.checked && cb.value === 'true' && h && !h.disabled);
              })()`);

          for (let attempt = 1; attempt <= 5 && !(await isVerifyChecked()); attempt++) {
            let box = null;
            for (let k = 0; k < 10 && !box; k++) {
              box = await getStyledBox();
              if (!box) await sleep(150);
            }
            if (!box) throw new Error("Consent checkbox not visible/hittable");
            await clickCoords(box.x, box.y);
            await sleep(200);
          }

          if (!(await isVerifyChecked())) throw new Error("Consent checkbox did not register after 5 attempts");

          let hadirCoords = await getCoords("Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === 'Hadir' && !b.disabled)");
          await clickCoords(hadirCoords.x, hadirCoords.y);

          await waitForExpr("!!Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === 'Tutup')", 15000);
          let tutupCoords = await getCoords("Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === 'Tutup')");
          await clickCoords(tutupCoords.x, tutupCoords.y);
        })(sendCdp);
      }

      this._outcome = { status: "done", ticketNumber: this._ticketNumber ?? null };
    } catch (err) {
      console.error("[PendaftaranAutomation] Error:", err);
      // SAFETY NET: Cek apakah error/timeout terjadi karena modal terbuka di layar
      try {
        const isInvalid = await executeInTab(tabId, checkInvalidDataModal);
        if (isInvalid) {
          this._outcome = { status: "invalid-nik", ticketNumber: null, errorMsg: "Data peserta / NIK tidak valid di sistem Kemenkes" };
          await chrome.tabs.reload(tabId).catch(() => { });
          return;
        }
        const isAlreadyScreened = await this._waitForScreenedModal(1500);
        if (isAlreadyScreened && (isAlreadyScreened.isMatch || isAlreadyScreened.tgl || isAlreadyScreened.faskes)) {
          this._applyScreenedOutcome(isAlreadyScreened);
          await chrome.tabs.reload(tabId).catch(() => { });
          return;
        }
      } catch (checkErr) { }
      this._outcome = { status: "error", ticketNumber: null, errorMsg: err.message || "Gagal memproses pendaftaran pasien" };
    } finally {
      if (debuggerAttached) {
        await chrome.debugger.detach({ tabId }).catch(() => { });
      }
      const outcome = this._outcome ?? { status: "stopped", ticketNumber: null, errorMsg: null };
      await this._report(outcome.status, outcome.ticketNumber, outcome.errorMsg, {
        screeningDate: outcome.screeningDate,
        screeningFaskes: outcome.screeningFaskes,
        screeningLayanan: outcome.screeningLayanan,
        screeningDetail: outcome.screeningDetail
      });
    }
  }

  async _report(status, ticketNumber, errorMsg = null, extraData = {}) {
    if (!this._reported) {
      this._reported = true;
      await this.onStatus(status, ticketNumber, errorMsg, extraData);
    }
  }

  _parseLahir(t) {
    const monthMap = {
      1: "Jan", "01": "Jan", januari: "Jan", jan: "Jan",
      2: "Feb", "02": "Feb", februari: "Feb", feb: "Feb",
      3: "Mar", "03": "Mar", maret: "Mar", mar: "Mar",
      4: "Apr", "04": "Apr", april: "Apr", apr: "Apr",
      5: "Mei", "05": "Mei", mei: "Mei", may: "Mei",
      6: "Jun", "06": "Jun", juni: "Jun", jun: "Jun",
      7: "Jul", "07": "Jul", juli: "Jul", jul: "Jul",
      8: "Agt", "08": "Agt", agustus: "Agt", agt: "Agt", aug: "Agt",
      9: "Sep", "09": "Sep", september: "Sep", sep: "Sep",
      10: "Okt", oktober: "Okt", okt: "Okt", oct: "Okt",
      11: "Nov", november: "Nov", nov: "Nov",
      12: "Des", desember: "Des", des: "Des", dec: "Des"
    };

    const formatDateObj = d => ({
      tahun: String(d.getFullYear()),
      bulan: monthMap[String(d.getMonth() + 1)] ?? String(d.getMonth() + 1),
      tanggal: String(d.getDate())
    });

    const raw = t.tanggallahir || t.tgllahir || t.tanggal_lahir || t.tgl_lahir || t.dob || t.lahir || t["tanggal lahir"];
    if (raw instanceof Date) return formatDateObj(raw);

    const s = String(raw || "").trim();
    if (s) {
      // Excel serial date (e.g. 16666)
      const num = parseFloat(s);
      if (!isNaN(num) && num > 1000 && !/[\/\-]/.test(s)) {
        const ms = 864e5 * ((num > 59 ? num - 1 : num) - 1);
        const d = new Date(Date.UTC(1900, 0, 1));
        return formatDateObj(new Date(d.getTime() + ms));
      }
      // YYYY-MM-DD or YYYY/MM/DD
      const iso = s.match(/^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})/);
      if (iso) {
        return {
          tahun: iso[1],
          bulan: monthMap[String(parseInt(iso[2], 10))] ?? iso[2],
          tanggal: String(parseInt(iso[3], 10))
        };
      }
      // DD-MM-YYYY or DD/MM/YYYY
      const dmy = s.match(/^(\d{1,2})[-\/](\d{1,2})[-\/](\d{4})/);
      if (dmy) {
        return {
          tahun: dmy[3],
          bulan: monthMap[String(parseInt(dmy[2], 10))] ?? dmy[2],
          tanggal: String(parseInt(dmy[1], 10))
        };
      }
    }

    // Separate columns
    const yr = String(t.tahunlahir || t.tahun || "").trim();
    const mo = String(t.bulanlahir || t.bulan || "").trim();
    const dy = String(t.tanggal || t.hari || "").trim();
    if (yr && mo && dy && /^\d+$/.test(dy) && parseInt(dy, 10) <= 31) {
      return {
        tahun: yr,
        bulan: monthMap[mo.toLowerCase()] ?? mo,
        tanggal: String(parseInt(dy, 10))
      };
    }

    // Fallback: extract from 16-digit Indonesian NIK
    const cleanNik = String(t.nik || t.NIK || "").replace(/\D/g, "");
    if (cleanNik.length === 16) {
      let day = parseInt(cleanNik.substr(6, 2), 10);
      const month = parseInt(cleanNik.substr(8, 2), 10);
      const yearShort = parseInt(cleanNik.substr(10, 2), 10);
      if (day > 40) day -= 40;
      if (day >= 1 && day <= 31 && month >= 1 && month <= 12 && !isNaN(yearShort)) {
        const currentYear = new Date().getFullYear();
        const currentShort = currentYear % 100;
        const fullYear = yearShort > currentShort ? 1900 + yearShort : 2000 + yearShort;
        return {
          tahun: String(fullYear),
          bulan: monthMap[String(month)] ?? String(month),
          tanggal: String(day)
        };
      }
    }

    return null;
  }

  _parseDetailForm(t) {
    const capitalize = str => str.toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
    const maritalMap = {
      menikah: "Menikah",
      kawin: "Menikah",
      married: "Menikah",
      "belum menikah": "Belum Menikah",
      "belum kawin": "Belum Menikah",
      belummenikah: "Belum Menikah",
      single: "Belum Menikah",
      lajang: "Belum Menikah",
      "cerai hidup": "Cerai Hidup",
      "cerai mati": "Cerai Mati"
    };

    const statusPernikahan = maritalMap[String(t.statuspernikahan ?? t.statusnikah ?? t.nikah ?? "").trim().toLowerCase()] ?? "Belum Menikah";
    const rawDis = String(t.disabilitas ?? t.disability ?? "").trim().toLowerCase();
    let disabilitas = "Tidak memiliki disabilitas";
    if (rawDis && "tidak" !== rawDis && "no" !== rawDis && "false" !== rawDis && "0" !== rawDis) {
      disabilitas = capitalize(rawDis);
    }

    const pekerjaan = String(t.pekerjaan ?? t.job ?? "").trim() || "Belum / Tidak Bekerja";
    const alamatParts = [
      String(t.provinsi ?? t.province ?? "").trim(),
      String(t.kabkota ?? t.kota ?? t.kabupaten ?? t.city ?? "").trim(),
      String(t.kecamatan ?? t.district ?? "").trim(),
      String(t.kelurahan ?? t.desa ?? t.subdistrict ?? t.desaataukelurahan ?? "").trim()
    ].filter(Boolean).map(val => val === val.toUpperCase() ? capitalize(val) : val);

    const detailAlamat = String(t.detailalamat ?? t.detaildomisili ?? t.alamat ?? t.address ?? "").trim() || (alamatParts.length ? alamatParts.join(", ") : "-");

    return {
      statusPernikahan,
      disabilitas,
      pekerjaan,
      alamat: alamatParts,
      detailAlamat
    };
  }

  _parseDetailFormSekolah(t) {
    const capitalize = str => str.toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
    const alamatParts = [
      String(t.provinsi ?? t.province ?? "").trim(),
      String(t.kabkota ?? t.kota ?? t.kabupaten ?? t.city ?? "").trim(),
      String(t.kecamatan ?? t.district ?? "").trim(),
      String(t.kelurahan ?? t.desa ?? t.subdistrict ?? t.desaataukelurahan ?? "").trim()
    ].filter(Boolean).map(val => val === val.toUpperCase() ? capitalize(val) : val);

    return {
      statusPernikahan: "Belum Menikah",
      disabilitas: "Tidak memiliki disabilitas",
      sekolah: String(t.sekolah ?? "").trim() || null,
      kelas: String(t.kelas ?? "").trim() || null,
      alamat: alamatParts,
      detailAlamat: String(t.detailalamat ?? t.detaildomisili ?? t.alamat ?? t.address ?? "").trim() || null
    };
  }

  _parseJenisKelamin(t) {
    const val = String(t.jeniskelamin ?? t.jk ?? t.gender ?? "").trim().toLowerCase();
    if (val) {
      if (val.startsWith("l") || val === "1" || val === "male" || val.includes("laki") || val.includes("pria")) {
        return "Laki-laki";
      }
      if (val.startsWith("p") || val === "2" || val === "female" || val.includes("perempuan") || val.includes("wanita")) {
        return "Perempuan";
      }
    }
    // Fallback: extract from NIK (day > 40 means female)
    const cleanNik = String(t.nik || t.NIK || "").replace(/\D/g, "");
    if (cleanNik.length === 16) {
      const day = parseInt(cleanNik.substr(6, 2), 10);
      if (day > 40) return "Perempuan";
      if (day >= 1) return "Laki-laki";
    }
    return null;
  }
}