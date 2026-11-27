const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Agu", "Sep", "Okt", "Nov", "Des"];

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitForAbort(ms, signal) {
  if (signal?.aborted) throw new Error("Automation was stopped");
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new Error("Automation was stopped"));
    }, { once: true });
  });
}

function sendCmd(target, method, params = {}) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand(target, method, params, result => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(result);
      }
    });
  });
}

async function evaluate(target, exp) {
  const { result, exceptionDetails } = await sendCmd(target, "Runtime.evaluate", {
    expression: exp,
    returnByValue: true,
    awaitPromise: true
  });
  if (exceptionDetails) throw new Error(exceptionDetails.text || "evaluate error");
  return result.value;
}

async function getElementCoords(target, fnStr) {
  return await evaluate(target, `
    (() => {
      const el = (${fnStr})();
      if (!el) return null;
      el.scrollIntoView({ block: 'center', inline: 'center' });
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return null;
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()
  `);
}

async function waitForElement(target, fnStr, timeoutMs = 15000, pollInterval = 300) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const coords = await getElementCoords(target, fnStr);
    if (coords) return coords;
    await sleep(pollInterval);
  }
  throw new Error("Timeout menunggu elemen: " + fnStr.slice(0, 60));
}

async function clickCoords(target, { x, y }) {
  const opts = { x: Math.round(x), y: Math.round(y), button: "left", clickCount: 1 };
  await sendCmd(target, "Input.dispatchMouseEvent", { type: "mouseMoved", x: opts.x, y: opts.y });
  await sendCmd(target, "Input.dispatchMouseEvent", { type: "mousePressed", ...opts });
  await sendCmd(target, "Input.dispatchMouseEvent", { type: "mouseReleased", ...opts });
}

async function clickElement(target, fnStr, timeoutMs = 15000) {
  // 1. Eksekusi klik langsung di level DOM via PointerEvent, MouseEvent, dan el.click()
  try {
    await evaluate(target, `
      (() => {
        const el = (${fnStr})();
        if (!el) return false;
        el.scrollIntoView({ block: 'center', inline: 'center' });
        const r = el.getBoundingClientRect();
        const opts = {
          bubbles: true,
          cancelable: true,
          view: window,
          clientX: r.left + r.width / 2,
          clientY: r.top + r.height / 2
        };
        el.dispatchEvent(new PointerEvent('pointerdown', opts));
        el.dispatchEvent(new MouseEvent('mousedown', opts));
        el.dispatchEvent(new PointerEvent('pointerup', opts));
        el.dispatchEvent(new MouseEvent('mouseup', opts));
        el.dispatchEvent(new MouseEvent('click', opts));
        if (typeof el.click === 'function') {
          try { el.click(); } catch (e) {}
        }
        return true;
      })()
    `);
  } catch (domErr) {
    console.warn("[clickElement] DOM click warning:", domErr.message);
  }

  // 2. Dispatch CDP mouse click sebagai backup native browser event
  try {
    const coords = await waitForElement(target, fnStr, Math.min(timeoutMs, 4000));
    if (coords) {
      await clickCoords(target, coords);
    }
  } catch (cdpErr) {
    console.warn("[clickElement] CDP click coords warning:", cdpErr.message);
  }

  await sleep(300);
}

async function typeText(target, text) {
  for (const char of String(text)) {
    await sendCmd(target, "Input.dispatchKeyEvent", { type: "keyDown", text: char });
    await sendCmd(target, "Input.dispatchKeyEvent", { type: "keyUp", text: char });
    await sleep(30);
  }
}

async function pressEnter(target) {
  const enterPayload = { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
  await sendCmd(target, "Input.dispatchKeyEvent", { type: "rawKeyDown", ...enterPayload });
  await sendCmd(target, "Input.dispatchKeyEvent", { type: "keyUp", ...enterPayload });
}

// ============================================================================
// SELECTORS
// ============================================================================

const SELECTORS = {
  // --- NIK filter dropdown (used in CKG Umum, also CKG Sekolah after table loads) ---
  dropdownTrigger: `() => Array.from(document.querySelectorAll('span.line-clamp-2'))
    .find(s => ['Nama','Nomor Tiket','NIK','Mitra'].includes((s.textContent||'').trim()))`,

  opsiNIK: `() => Array.from(document.querySelectorAll('div.cursor-pointer'))
    .find(d => (d.textContent||'').trim() === 'NIK' && /py-2/.test(d.className))`,

  searchInput: `() => document.querySelector('input[placeholder*="Masukkan"], input[placeholder*="NIK"]')`,

  // --- Tombol Mulai di baris tabel (Mulai / Lanjutkan / Periksa) ---
  btnMulaiBaris: `() => {
    const tbody = document.querySelector('tbody') || document;
    const trs = Array.from(tbody.querySelectorAll('tr')).filter(tr => {
      const tds = tr.querySelectorAll('td');
      const rTxt = (tr.textContent || '').toLowerCase();
      return tds.length > 2 && !rTxt.includes('tidak ditemukan') && !rTxt.includes('tidak ada data');
    });
    for (const tr of trs) {
      const allBtns = Array.from(tr.querySelectorAll('button, a, [role="button"], div[class*="cursor-pointer"]')).filter(b => {
        if (b.disabled || b.getAttribute('aria-disabled') === 'true') return false;
        const r = b.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      });
      // 1. Cari yang secara spesifik bertuliskan "Mulai"
      const mulaiBtn = allBtns.find(b => {
        const t = (b.textContent || '').trim().toLowerCase();
        return (t === 'mulai' || t.includes('mulai')) && !t.includes('lihat') && !t.includes('rapor');
      });
      if (mulaiBtn) return mulaiBtn;

      // 2. Cari yang bertuliskan "Lanjutkan" / "Periksa" / "Input"
      const lanjutBtn = allBtns.find(b => {
        const t = (b.textContent || '').trim().toLowerCase();
        return (t.includes('lanjut') || t.includes('periksa') || t.includes('input')) && !t.includes('lihat') && !t.includes('rapor');
      });
      if (lanjutBtn) return lanjutBtn;

      // 3. Fallback: tombol apapun yang BUKAN "Lihat", "Rapor", "Batal"
      const anyActionBtn = allBtns.find(b => {
        const t = (b.textContent || '').trim().toLowerCase();
        return !t.includes('lihat') && !t.includes('rapor') && !t.includes('cetak') && !t.includes('batal');
      });
      if (anyActionBtn) return anyActionBtn;
    }
    return null;
  }`,

  btnMulaiPemeriksaan: `() => Array.from(document.querySelectorAll('button'))
    .find(b => (b.textContent||'').trim() === 'Mulai Pemeriksaan' && !b.disabled)`,

  modalKonfirmasi: `() => Array.from(document.querySelectorAll('div, [role="dialog"], .modal, .fixed'))
    .find(el => (el.textContent||'').includes('Konfirmasi Tanggal Pemeriksaan'))`,

  btnSimpan: `() => Array.from(document.querySelectorAll('button'))
    .find(b => {
      const t = (b.textContent||'').trim();
      return (t === 'Simpan' || t.toLowerCase().includes('simpan')) && !b.disabled;
    })`,

  calHeaderText: `() => {
    const all = Array.from(document.querySelectorAll('div, span, p, h2, h3, h4'));
    const el = all.find(e => {
      const txt = (e.textContent || '').trim().replace(/\\s+/g, ' ');
      return /^(Jan|Feb|Mar|Apr|Mei|Jun|Jul|Agu|Sep|Okt|Nov|Des)\\s+\\d{4}$/i.test(txt) &&
        e.children.length <= 2;
    });
    if (!el) {
      const flexEl = Array.from(document.querySelectorAll('div.flex.items-center'))
        .find(e => /^(Jan|Feb|Mar|Apr|Mei|Jun|Jul|Agu|Sep|Okt|Nov|Des)\\d{4}$/i.test((e.textContent||'').replace(/\\s+/g,'')));
      if (!flexEl) return '';
      const m2 = (flexEl.textContent||'').replace(/\\s+/g,'').match(/^([A-Za-z]{3})(\\d{4})$/i);
      return m2 ? (m2[1].charAt(0).toUpperCase() + m2[1].slice(1).toLowerCase() + ' ' + m2[2]) : '';
    }
    const m = (el.textContent || '').trim().replace(/\\s+/g, ' ').match(/^([A-Za-z]{3})\\s+(\\d{4})$/i);
    return m ? (m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase() + ' ' + m[2]) : '';
  }`,

  navContainer: `() => {
    const el = Array.from(document.querySelectorAll('div.flex.items-center'))
      .find(e => /^(Jan|Feb|Mar|Apr|Mei|Jun|Jul|Agu|Sep|Okt|Nov|Des)\\d{4}$/i.test((e.textContent||'').replace(/\\s+/g,'')));
    return el ? el.parentElement.querySelector('div.flex.items-center.justify-center') : null;
  }`,

  // --- CKG Sekolah specific: Dropdown "Pilih sekolah" & "Pilih kelas" ---
  // These are the v-shaped select triggers (same look as screenshot)
  sekolahDropdown: `() => {
    // Find the first dropdown with "Pilih sekolah" OR an already-selected school name
    // The structure is: container > select-like div with text + chevron
    const selects = Array.from(document.querySelectorAll('select'));
    for (const sel of selects) {
      const opts = Array.from(sel.querySelectorAll('option'));
      const hasSekolah = opts.some(o => (o.textContent||'').includes('Pilih sekolah') || (o.textContent||'').includes('sekolah'));
      if (hasSekolah) return sel;
    }
    // Fallback: custom dropdown trigger
    const allDivs = Array.from(document.querySelectorAll('div'));
    const trigger = allDivs.find(d => {
      const txt = (d.textContent||'').trim();
      const r = d.getBoundingClientRect();
      return r.width > 100 && r.height > 20 && r.height < 60 && r.top > 80 && r.top < 300
        && (txt.includes('Pilih sekolah') || txt === 'Pilih sekolah')
        && d.children.length <= 3;
    });
    return trigger || null;
  }`,

  kelasDropdown: `() => {
    const selects = Array.from(document.querySelectorAll('select'));
    for (const sel of selects) {
      const opts = Array.from(sel.querySelectorAll('option'));
      const hasKelas = opts.some(o => (o.textContent||'').includes('Pilih kelas') || (o.textContent||'').includes('kelas'));
      if (hasKelas) return sel;
    }
    const allDivs = Array.from(document.querySelectorAll('div'));
    const trigger = allDivs.find(d => {
      const txt = (d.textContent||'').trim();
      const r = d.getBoundingClientRect();
      return r.width > 100 && r.height > 20 && r.height < 60 && r.top > 80 && r.top < 300
        && (txt.includes('Pilih kelas') || txt === 'Pilih kelas')
        && d.children.length <= 3;
    });
    return trigger || null;
  }`,

  btnTampilkanPencarian: `() => Array.from(document.querySelectorAll('button'))
    .find(b => (b.textContent||'').trim().includes('Tampilkan Pencarian'))`
};

function getTabSelector(tabName) {
  return `() => {
    const clean = s => (s || '').replace(/\\s+/g, ' ').trim().toLowerCase();
    const target = clean('${tabName}');
    const allTabs = ['belum pemeriksaan', 'sedang pemeriksaan', 'selesai pemeriksaan'];
    const otherTabs = allTabs.filter(t => t !== target);

    // Filter elemen yang mengandung target tapi TIDAK mengandung nama tab lain (agar parent wrapper gugur)
    const candidates = Array.from(document.querySelectorAll('div, button, a, span, p, li'))
      .filter(el => {
        const txt = clean(el.textContent);
        if (!txt.includes(target)) return false;
        if (otherTabs.some(other => txt.includes(other))) return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && r.top >= 0 && r.top < 600;
      });

    if (!candidates.length) return null;

    // Urutkan elemen dengan text terpendek dahulu agar tab spesifik terpilih, bukan ancestor
    candidates.sort((a, b) => clean(a.textContent).length - clean(b.textContent).length);

    for (const cand of candidates) {
      const clickable = cand.closest('button, [role="tab"], .cursor-pointer, a') ||
        (cand.classList.contains('cursor-pointer') ? cand : null) ||
        (cand.tagName === 'BUTTON' ? cand : null);
      if (clickable) {
        const cr = clickable.getBoundingClientRect();
        const clickTxt = clean(clickable.textContent);
        if (!otherTabs.some(other => clickTxt.includes(other)) && cr.width > 0 && cr.height > 0) {
          return clickable;
        }
      }
    }

    return candidates[0] || null;
  }`;
}

async function clickTabElement(target, tabName, signal) {
  // 1. Eksekusi klik langsung via JS Event
  const jsClicked = await evaluate(target, `
    (() => {
      const el = (${getTabSelector(tabName)})();
      if (!el) return false;
      el.scrollIntoView({ block: 'center', inline: 'center' });
      el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
      el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      if (typeof el.click === 'function') el.click();
      return true;
    })()
  `);

  // 2. Dispatch CDP mouse click untuk native browser event
  try {
    const coords = await getElementCoords(target, getTabSelector(tabName));
    if (coords) {
      await clickCoords(target, coords);
    }
  } catch (e) {
    console.warn("[clickTabElement] CDP click fallback:", e.message);
  }

  await waitForAbort(150, signal);
  return jsClicked;
}

async function checkRowValid(target, tabName = "") {
  return await evaluate(target, `
    (() => {
      const tbody = document.querySelector('tbody');
      if (!tbody) return false;
      const txt = (tbody.textContent||'').toLowerCase();
      if (txt.includes('tidak ditemukan') || txt.includes('tidak ada data') || txt.includes('belum ada data')) return false;
      const trs = Array.from(tbody.querySelectorAll('tr'));
      if (!trs.length) return false;
      
      const validTrs = trs.filter(tr => {
        const tds = tr.querySelectorAll('td');
        const rTxt = (tr.textContent || '').toLowerCase();
        return tds.length > 2 && !rTxt.includes('tidak ditemukan') && !rTxt.includes('tidak ada data');
      });
      if (!validTrs.length) return false;
      
      // Jika tab adalah Selesai Pemeriksaan, baris pasien sudah berstatus selesai
      if ('${tabName}' === 'Selesai Pemeriksaan') {
        return true;
      }
      
      // Untuk Belum Pemeriksaan dan Sedang Pemeriksaan:
      // Valid jika ada tombol/link aksi (Mulai, Lanjutkan, Periksa, atau tombol apapun di baris pasien)
      return validTrs.some(tr => {
        const actionElements = Array.from(tr.querySelectorAll('button, a, [role="button"]'));
        if (!actionElements.length) return true;
        return actionElements.some(b => {
          const bTxt = (b.textContent||'').trim().toLowerCase();
          return bTxt.includes('mulai') || bTxt.includes('lanjut') || bTxt.includes('periksa') || !b.disabled;
        });
      });
    })()
  `);
}

async function checkInternalServerError(target) {
  return await evaluate(target, `
    (() => {
      const elements = Array.from(document.querySelectorAll('div, [role="dialog"], .modal, .ant-modal, .fixed'));
      for (const el of elements) {
        const text = (el.innerText || '').toLowerCase();
        const isError = text.includes('internal server error') ||
                        text.includes('terjadi kesalahan') ||
                        text.includes('gagal memproses data') ||
                        (text.includes('silakan coba lagi') && text.includes('gagal'));
        if (isError) {
          const rect = el.getBoundingClientRect();
          if (rect.width > 50 && rect.height > 50) {
            const okBtn = Array.from(el.querySelectorAll('button')).find(b => {
              const bText = (b.textContent || '').trim().toLowerCase();
              return bText === 'ok' || bText === 'tutup';
            });
            return { found: true, message: el.innerText.trim(), hasOkBtn: !!okBtn };
          }
        }
      }
      return { found: false };
    })()
  `);
}

// ============================================================================
// SEKOLAH & KELAS FILTER LOGIC
// ============================================================================

/**
 * Handles selecting a value from either a native <select> or a custom React-Select
 * style dropdown on the ASIK Kemkes ckg-pelayanan-sekolah page.
 *
 * Step 1: Click the trigger element
 * Step 2: If a search input appears inside the dropdown popover, type the search text
 * Step 3: Click the matching option
 */
async function selectFilterValue(target, triggerFnStr, searchText, labelName, updateStatus, signal) {
  if (!searchText) return;
  const safeText = String(searchText).replace(/'/g, "\\'").trim();
  const safeTextLower = safeText.toLowerCase();
  updateStatus(`Memilih ${labelName}: ${safeText}...`);

  // Check if this is a native <select> element
  const isNativeSelect = await evaluate(target, `
    (() => {
      const el = (${triggerFnStr})();
      return el ? el.tagName === 'SELECT' : false;
    })()
  `);

  if (isNativeSelect) {
    // For native <select>, set value directly via JS
    const success = await evaluate(target, `
      (() => {
        const sel = (${triggerFnStr})();
        if (!sel) return false;
        const targetText = '${safeTextLower}';
        const opts = Array.from(sel.options);
        const match = opts.find(o => (o.textContent||'').trim().toLowerCase().includes(targetText));
        if (match) {
          sel.value = match.value;
          sel.dispatchEvent(new Event('change', { bubbles: true }));
          sel.dispatchEvent(new Event('input', { bubbles: true }));
          return true;
        }
        return false;
      })()
    `);
    if (!success) {
      throw new Error(`Opsi "${safeText}" tidak ditemukan di dropdown ${labelName}`);
    }
    await waitForAbort(500, signal);
    return;
  }

  // For custom dropdown: click trigger first
  await clickElement(target, triggerFnStr);
  await waitForAbort(600, signal);

  // Try to find a search/filter input that appeared after clicking
  const hasSearchInput = await evaluate(target, `
    (() => {
      // Look for an input that is visible, not the NIK search input
      const inputs = Array.from(document.querySelectorAll('input[type="text"], input:not([type])'));
      for (const inp of inputs) {
        const r = inp.getBoundingClientRect();
        if (r.width > 50 && r.height > 0 && r.top > 80 && r.top < 500) {
          // Check that it's inside a dropdown-like container or popover
          const ph = (inp.placeholder || '').toLowerCase();
          if (ph.includes('masukkan nik') || ph.includes('nik')) continue; // Skip the NIK search
          return true;
        }
      }
      return false;
    })()
  `);

  if (hasSearchInput) {
    // Click the search input and type
    const searchInputFn = `() => {
      const inputs = Array.from(document.querySelectorAll('input[type="text"], input:not([type])'));
      for (const inp of inputs) {
        const r = inp.getBoundingClientRect();
        if (r.width > 50 && r.height > 0 && r.top > 80 && r.top < 500) {
          const ph = (inp.placeholder || '').toLowerCase();
          if (ph.includes('masukkan nik') || ph.includes('nik')) continue;
          return inp;
        }
      }
      return null;
    }`;
    await clickElement(target, searchInputFn);
    await waitForAbort(200, signal);
    await typeText(target, safeText);
    await waitForAbort(600, signal);
  }

  // Now click the matching option in the dropdown list
  const optionFn = `() => {
    const targetLower = '${safeTextLower}';
    // Find the most specific (smallest text) element matching the target
    const candidates = Array.from(document.querySelectorAll('div, li, span, p'))
      .filter(el => {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return false;
        if (r.top < 80 || r.top > 700) return false;
        const tag = el.tagName;
        if (['INPUT', 'BODY', 'HTML', 'SVG', 'BUTTON'].includes(tag)) return false;

        const txt = (el.textContent || '').trim().toLowerCase();
        if (!txt || txt.length > 200) return false;

        // Skip items that contain "Pilih" (placeholder text in trigger)
        if (txt.startsWith('pilih ')) return false;
        // Skip "Semua kelas" unless we specifically target it
        if (txt === 'semua kelas' && targetLower !== 'semua kelas') return false;

        return txt === targetLower || txt.includes(targetLower);
      })
      .sort((a, b) => (a.textContent||'').trim().length - (b.textContent||'').trim().length);

    return candidates[0] || null;
  }`;

  try {
    await clickElement(target, optionFn, 8000);
  } catch (e) {
    // Retry: Maybe the option needs a different matching approach (e.g. "Kelas 10" for "10")
    const numOnly = String(searchText).replace(/\D/g, '');
    if (numOnly) {
      const retryFn = `() => {
        const candidates = Array.from(document.querySelectorAll('div, li, span, p'))
          .filter(el => {
            const r = el.getBoundingClientRect();
            if (r.width === 0 || r.height === 0) return false;
            if (r.top < 80 || r.top > 700) return false;
            const txt = (el.textContent || '').trim().toLowerCase();
            if (!txt || txt.length > 100) return false;
            if (txt.startsWith('pilih ')) return false;
            return txt === 'kelas ${numOnly}' || txt === '${numOnly}';
          })
          .sort((a, b) => (a.textContent||'').trim().length - (b.textContent||'').trim().length);
        return candidates[0] || null;
      }`;
      await clickElement(target, retryFn, 5000);
    } else {
      throw e;
    }
  }
  await waitForAbort(500, signal);
}

async function handleSekolahFiltering(target, { sekolah, kelas }, updateStatus, signal) {
  if (!sekolah && !kelas) return;

  // Step 1: Select Sekolah
  if (sekolah) {
    await selectFilterValue(target, SELECTORS.sekolahDropdown, sekolah, "Sekolah", updateStatus, signal);
  }

  // Step 2: Select Kelas
  if (kelas) {
    await selectFilterValue(target, SELECTORS.kelasDropdown, kelas, "Kelas", updateStatus, signal);
  }

  // Step 3: Click "Tampilkan Pencarian"
  updateStatus("Klik Tampilkan Pencarian...");
  await waitForElement(target, SELECTORS.btnTampilkanPencarian, 10000, 300);
  await clickElement(target, SELECTORS.btnTampilkanPencarian);
  await waitForAbort(2000, signal);

  // Step 4: Wait for table to appear with rows
  updateStatus("Menunggu tabel pasien muncul...");
  const tableLoaded = await evaluate(target, `
    new Promise((resolve) => {
      let attempts = 0;
      const check = () => {
        attempts++;
        const tbody = document.querySelector('tbody');
        if (tbody && tbody.querySelectorAll('tr').length > 0) {
          resolve(true);
          return;
        }
        if (attempts > 20) { resolve(false); return; }
        setTimeout(check, 500);
      };
      check();
    })
  `);

  if (!tableLoaded) {
    updateStatus("Tabel pasien tidak muncul setelah filter sekolah/kelas.");
    throw new Error("Tabel pasien tidak ditemukan setelah Tampilkan Pencarian");
  }
  updateStatus("Tabel pasien berhasil dimuat.");
}

// ============================================================================
// MAIN FLOW
// ============================================================================

export async function runFlow(tabId, { nik, tahun, bulan, hari, category, sekolah, kelas }, updateStatus, signal, onComplete) {
  const target = { tabId };
  if (signal?.aborted) throw new Error("Automation was stopped");

  const onAbortHandler = () => {
    throw new Error("Automation was stopped");
  };
  signal?.addEventListener("abort", onAbortHandler);

  await chrome.debugger.attach(target, "1.3");

  try {
    await sendCmd(target, "Runtime.enable");
    await sendCmd(target, "DOM.enable");
    await sendCmd(target, "Page.bringToFront");

    let serverErrorRetries = 0;
    const MAX_SERVER_ERROR_RETRIES = 3;

    // Helper untuk mendeteksi Terjadi kesalahan / Gagal memproses data: tunggu 5 detik lalu refresh (max 3x)
    const handleServerErrorIfPresent = async () => {
      const errStatus = await checkInternalServerError(target);
      if (errStatus?.found) {
        serverErrorRetries++;
        if (serverErrorRetries > MAX_SERVER_ERROR_RETRIES) {
          updateStatus(`❌ Kesalahan server menetap setelah 3x refresh. Menghentikan bot...`);
          chrome.runtime.sendMessage({ type: "PELAYANAN_STOP_ALL" }).catch(() => {});
          throw new Error("Bot berhenti: Kesalahan server menetap setelah 3x refresh.");
        }
        for (let s = 5; s > 0; s--) {
          if (signal?.aborted) throw new Error("Automation was stopped");
          updateStatus(`⚠️ Terjadi kesalahan terdeteksi! Menunggu 5 detik lalu refresh (Percobaan ${serverErrorRetries}/${MAX_SERVER_ERROR_RETRIES})... [${s}s]`);
          await waitForAbort(1000, signal);
        }
        updateStatus(`Me-refresh halaman (Percobaan ${serverErrorRetries}/${MAX_SERVER_ERROR_RETRIES})...`);
        await evaluate(target, `
          (() => {
            const btns = Array.from(document.querySelectorAll('button'));
            const ok = btns.find(b => {
              const t = (b.textContent||'').trim().toLowerCase();
              return t === 'ok' || t === 'tutup';
            });
            if (ok) ok.click();
            location.reload();
          })()
        `).catch(() => {});
        await waitForAbort(3500, signal);
        return "RELOADED";
      }
      return "OK";
    };

    while (true) {
      if (signal?.aborted) throw new Error("Automation was stopped");

      const preCheck = await handleServerErrorIfPresent();
      if (preCheck === "SKIP") return { earlyStatus: "SERVER_ERROR_SKIP", error: "Internal Server Error 3x" };
      if (preCheck === "RELOADED") continue;

      try {
        // ======================================================================
        // STEP A: If CKG Sekolah, do school/class filtering first
        // ======================================================================
        if (category === "SEKOLAH") {
          await handleSekolahFiltering(target, { sekolah, kelas }, updateStatus, signal);
          const errA = await handleServerErrorIfPresent();
          if (errA === "SKIP") return { earlyStatus: "SERVER_ERROR_SKIP", error: "Internal Server Error 3x" };
          if (errA === "RELOADED") continue;
        }

        // ======================================================================
        // STEP B: Set search filter to NIK
        // ======================================================================
        const currentDropdownText = await evaluate(target, `
          (() => {
            const el = (${SELECTORS.dropdownTrigger})();
            return el ? (el.textContent||'').trim() : '';
          })()
        `);

        if (currentDropdownText && currentDropdownText !== "NIK") {
          updateStatus("Buka dropdown filter...");
          await clickElement(target, SELECTORS.dropdownTrigger);
          await waitForAbort(500, signal);

          updateStatus("Pilih NIK...");
          await clickElement(target, SELECTORS.opsiNIK);
          await waitForAbort(500, signal);
        }

        // ======================================================================
        // STEP C: Type NIK in the search input and press Enter
        // ======================================================================
        updateStatus("Ketik NIK: " + nik + "...");
        await clickElement(target, SELECTORS.searchInput);
        await typeText(target, String(nik));
        await pressEnter(target);
        await waitForAbort(400, signal);

        const errC = await handleServerErrorIfPresent();
        if (errC === "SKIP") return { earlyStatus: "SERVER_ERROR_SKIP", error: "Internal Server Error 3x" };
        if (errC === "RELOADED") continue;

        // ======================================================================
        // STEP D: Find patient in tabs (Belum -> Sedang -> Selesai Pemeriksaan)
        // ======================================================================
        updateStatus("Cari pasien di tab Belum/Sedang/Selesai Pemeriksaan...");
        const TABS = ["Belum Pemeriksaan", "Sedang Pemeriksaan", "Selesai Pemeriksaan"];
        let foundTab = null;

        for (let tIdx = 0; tIdx < TABS.length; tIdx++) {
          const tabName = TABS[tIdx];

          // Jika bukan tab pertama (Belum Pemeriksaan), klik tab untuk berpindah
          if (tIdx > 0) {
            updateStatus(`Pindah ke tab: ${tabName}...`);
            await clickTabElement(target, tabName, signal);
            await waitForAbort(250, signal);

            // Pastikan input search berisi NIK dan picu filter pencarian di tab baru
            await evaluate(target, `
              (() => {
                const inp = (${SELECTORS.searchInput})();
                if (inp) {
                  inp.focus();
                  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
                  if (setter) {
                    setter.call(inp, '${nik}');
                  } else {
                    inp.value = '${nik}';
                  }
                  inp.dispatchEvent(new Event('input', { bubbles: true }));
                  inp.dispatchEvent(new Event('change', { bubbles: true }));
                  inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
                  inp.dispatchEvent(new KeyboardEvent('keypress', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
                  inp.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
                }
              })()
            `);
            await pressEnter(target);
            await waitForAbort(300, signal);
          } else {
            updateStatus(`Memeriksa data di tab: ${tabName}...`);
          }

          const errTab = await handleServerErrorIfPresent();
          if (errTab === "SKIP") return { earlyStatus: "SERVER_ERROR_SKIP", error: "Internal Server Error 3x" };
          if (errTab === "RELOADED") break;

          // Polling tunggu konten tabel tab ter-load (maksimal 2 detik)
          let isTabRowFound = false;
          const startTabWait = Date.now();
          while (Date.now() - startTabWait < 2000) {
            const errPoll = await handleServerErrorIfPresent();
            if (errPoll === "SKIP") return { earlyStatus: "SERVER_ERROR_SKIP", error: "Internal Server Error 3x" };
            if (errPoll === "RELOADED") break;

            if (await checkRowValid(target, tabName)) {
              isTabRowFound = true;
              break;
            }

            await waitForAbort(150, signal);
          }

          if (isTabRowFound) {
            foundTab = tabName;
            updateStatus(`✓ Pasien ditemukan di tab: ${tabName}`);
            break;
          }
        }

        // Jika ter-reload saat iterasi tab, re-check
        const postTabCheck = await checkInternalServerError(target);
        if (postTabCheck?.found) {
          const errRes = await handleServerErrorIfPresent();
          if (errRes === "SKIP") return { earlyStatus: "SERVER_ERROR_SKIP", error: "Internal Server Error 3x" };
          if (errRes === "RELOADED") continue;
        }

        if (!foundTab) {
          const doubleCheckErr = await handleServerErrorIfPresent();
          if (doubleCheckErr === "SKIP") return { earlyStatus: "SERVER_ERROR_SKIP", error: "Internal Server Error 3x" };
          if (doubleCheckErr === "RELOADED") continue;

          updateStatus("Pasien NIK " + nik + " tidak ditemukan.");
          return { earlyStatus: "MISSING" };
        }

        if (foundTab === "Selesai Pemeriksaan") {
          updateStatus("Pasien sudah pernah diinput (Selesai Pemeriksaan).");
          return { earlyStatus: "ALREADY_SCREENED" };
        }

        // ======================================================================
        // STEP E: Click "Mulai" button on the patient row
        // ======================================================================
        updateStatus(`Pasien ditemukan di: ${foundTab}. Klik Mulai...`);
        await clickElement(target, SELECTORS.btnMulaiBaris);
        onComplete?.();
        await waitForAbort(2500, signal);

        const postMulaiErr = await handleServerErrorIfPresent();
        if (postMulaiErr === "SKIP") return { earlyStatus: "SERVER_ERROR_SKIP", error: "Internal Server Error 3x" };
        if (postMulaiErr === "RELOADED") continue;

        // ======================================================================
        // STEP F: Wait for detail page and check "Mulai Pemeriksaan" button
        // ======================================================================
        updateStatus("Menunggu halaman detail pemeriksaan...");
        let pageLoaded = false;
        for (let i = 0; i < 20; i++) {
          const errInF = await checkInternalServerError(target);
          if (errInF?.found) break;

          const exists = await evaluate(target, `
            location.href.includes('detail-pemeriksaan') ||
            !!Array.from(document.querySelectorAll('*'))
              .find(e => {
                const t = (e.textContent||'').trim();
                return t === 'Pemeriksaan Mandiri' || t === 'Pelayanan oleh Nakes' || t === 'Mulai Pemeriksaan' || t.includes('detail-pemeriksaan');
              })
          `);
          if (exists) { pageLoaded = true; break; }

          // Jika setelah 4 iterasi (~1.6 detik) halaman belum berpindah, klik ulang tombol Mulai baris
          if (i === 4 || i === 9) {
            console.log("[runFlow] Halaman detail belum berpindah, mencoba klik ulang tombol Mulai...");
            await clickElement(target, SELECTORS.btnMulaiBaris).catch(() => {});
          }

          await waitForAbort(400, signal);
        }

        const postDetailErr = await handleServerErrorIfPresent();
        if (postDetailErr === "SKIP") return { earlyStatus: "SERVER_ERROR_SKIP", error: "Internal Server Error 3x" };
        if (postDetailErr === "RELOADED") continue;

        if (!pageLoaded) throw new Error("Halaman detail pemeriksaan tidak termuat");

        const hasMulaiPemeriksaan = await evaluate(target, `
          (() => {
            const b = Array.from(document.querySelectorAll('button'))
              .find(x => (x.textContent||'').trim() === 'Mulai Pemeriksaan');
            if (!b) return false;
            const r = b.getBoundingClientRect();
            return !b.disabled && r.width > 0 && r.height > 0;
          })()
        `);

        if (!hasMulaiPemeriksaan) {
          updateStatus("Pasien dalam status Sedang Pemeriksaan. Langsung mulai mengisi form...");
          break;
        }

        // ======================================================================
        // STEP G: Click "Mulai Pemeriksaan" and set date
        // ======================================================================
        updateStatus("Klik Mulai Pemeriksaan...");
        await sendCmd(target, "Page.bringToFront");
        await clickElement(target, SELECTORS.btnMulaiPemeriksaan);
        await waitForAbort(1000, signal);

        updateStatus("Set tanggal pemeriksaan...");
        await waitForElement(target, SELECTORS.modalKonfirmasi);

        const targetMonthIndex = (bulan - 1) + 12 * tahun;
        let monthReached = false;

        for (let i = 0; i < 36; i++) {
          const headerText = await evaluate(target, `(${SELECTORS.calHeaderText})()`);
          if (!headerText) {
            await waitForAbort(300, signal);
            continue;
          }
          const [mName, yStr] = headerText.split(" ");
          const currentMonthIndex = MONTH_NAMES.indexOf(mName) + 12 * parseInt(yStr, 10);

          if (currentMonthIndex === targetMonthIndex) {
            monthReached = true;
            break;
          }

          const arrows = await evaluate(target, `
            (() => {
              const modal = Array.from(document.querySelectorAll('div, [role="dialog"], .modal, .fixed')).find(el =>
                (el.textContent || '').includes('Konfirmasi Tanggal Pemeriksaan')
              );
              const container = modal || document;
              const modalBtns = Array.from(container.querySelectorAll('button')).filter(b => {
                const txt = (b.textContent || '').trim();
                const hasSvg = b.querySelector('svg') !== null;
                const r = b.getBoundingClientRect();
                return r.width > 0 && r.height > 0 && (txt === '<' || txt === '>' || hasSvg) && !txt.includes('Simpan') && !txt.includes('Kembali');
              });
              if (modalBtns.length >= 2) {
                return modalBtns.slice(0, 2).map(b => {
                  const r = b.getBoundingClientRect();
                  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
                });
              }

              const c = (${SELECTORS.navContainer})();
              if (!c) return null;
              return Array.from(c.querySelectorAll('button')).map(b => {
                const r = b.getBoundingClientRect();
                return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
              });
            })()
          `);

          if (!arrows || arrows.length < 2) throw new Error("Tombol panah kalender tidak ditemukan");

          await clickCoords(target, currentMonthIndex > targetMonthIndex ? arrows[0] : arrows[1]);
          await waitForAbort(450, signal);
        }

        if (!monthReached) throw new Error("Gagal menavigasi ke bulan/tahun target");

        const dateDaySelector = `() => Array.from(document.querySelectorAll('span'))
          .find(el => (el.textContent||'').trim() === '${hari}'
            && !/text-gray-300/.test(el.className)
            && el.closest('.grid')
            && el.offsetParent !== null)`;

        await clickElement(target, dateDaySelector);
        await waitForAbort(400, signal);

        updateStatus("Klik Simpan...");
        await clickElement(target, SELECTORS.btnSimpan);
        await waitForAbort(1200, signal);

        const postSimpanErr = await handleServerErrorIfPresent();
        if (postSimpanErr === "SKIP") return { earlyStatus: "SERVER_ERROR_SKIP", error: "Internal Server Error 3x" };
        if (postSimpanErr === "RELOADED") continue;

        updateStatus("Tanggal pemeriksaan tersimpan. Melanjutkan ke pengisian form...");
        break;

      } catch (innerErr) {
        if (signal?.aborted || innerErr.message === "Automation was stopped") {
          throw innerErr;
        }
        console.warn("[runFlow] Inner error occurred:", innerErr.message);
        const errCatch = await handleServerErrorIfPresent();
        if (errCatch === "SKIP") {
          return { earlyStatus: "SERVER_ERROR_SKIP", error: "Internal Server Error 3x" };
        }
        if (errCatch === "RELOADED") {
          continue;
        }
        throw innerErr;
      }
    }
  } catch (err) {
    if (err.message !== "Automation was stopped") throw err;
    updateStatus("❌ Otomasi diberhentikan");
  } finally {
    signal?.removeEventListener("abort", onAbortHandler);
    await chrome.debugger.detach(target).catch(() => {});
  }
}