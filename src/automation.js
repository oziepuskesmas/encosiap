import { FIELD_CONFIG as e } from "./fieldConfig.js";

const t = ms => new Promise(resolve => setTimeout(resolve, ms));

async function n(tabId, func, args = []) {
  const [res] = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func,
    args
  });
  return res?.result;
}

async function o(tabId, predicate, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (predicate(tab.url) && tab.status === "complete") return;
    } catch (err) {}
    await t(400);
  }
  throw new Error("Navigation timeout");
}

async function a(tabId, conditionFunc, timeout = 12000, interval = 400) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await n(tabId, conditionFunc)) return;
    await t(interval);
  }
  throw new Error("Timeout: condition not met");
}

export class Automation {
  constructor({ tabId, statusMenikah, delay = 300, testMode = false, fieldRules = [], items = null, attendDate = null, patientData = null, onProgress, onDone }) {
    this.tabId = tabId;
    this.statusMenikah = statusMenikah;
    this.delay = delay ?? 300;
    this.testMode = testMode ?? false;
    this.fieldRules = fieldRules ?? [];
    this.items = items ?? null;
    this.attendDate = attendDate ?? patientData?.attendDate ?? null;
    this.patientData = patientData ?? null;
    this.onProgress = onProgress;
    this.onDone = onDone;
    this._paused = false;
    this._stopped = false;
    this._itemsCache = null;
    this.failedItems = [];
    this.processedCount = 0;
    this.lastMainUrl = null;
    this.pelayananFinished = false;
    this.rateLimited = false;
  }

  pause() {
    this._paused = true;
  }

  resume() {
    this._paused = false;
  }

  stop() {
    this._stopped = true;
    this._paused = false;
  }

  async _waitResume() {
    while (this._paused && !this._stopped) {
      await t(200);
    }
  }

  /**
   * Memastikan halaman Sehat Indonesiaku selesai memuat data.
   * Jika web sedang memuat (muncul spinner / "Memuat data..." / skeleton gray bars / belum ada tombol input data):
   * Bot menunggu hingga maksimal 5 detik.
   * Jika lewat 5 detik masih memuat / belum muncul, refresh halaman tab (maksimal 3x percobaan).
   * Jika setelah 3x refresh masih tetap memuat/gagal, bot berhenti.
   */
  async ensureMainPageLoaded(maxRetries = 3, timeoutMs = 5000) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      if (this._stopped) return false;
      console.log(`[Automation] Memeriksa status kesiapan halaman Sehat Indonesiaku (percobaan ${attempt}/${maxRetries})...`);

      const startWait = Date.now();
      let isLoaded = false;
      let detectedServerError = false;

      while (Date.now() - startWait < timeoutMs) {
        if (this._stopped) return false;

        const checkStatus = await n(this.tabId, () => {
          const bodyText = (document.body?.innerText || "").toLowerCase();

          // 0. Cek apakah ada modal Internal Server Error
          const isInternalError = Array.from(
            document.querySelectorAll(".fixed, .modal, [role='dialog'], .overlay, div")
          ).some(m => {
            const txt = (m.innerText || "").toLowerCase();
            return txt.includes("internal server error") && m.getBoundingClientRect().width > 50;
          });
          if (isInternalError) {
            return { ok: false, isServerError: true };
          }

          // 1. Cek apakah ada modal blocking loading yang aktif terlihat di layar
          const activeLoadingModal = Array.from(
            document.querySelectorAll(".fixed, .modal, [role='dialog'], .overlay, div[class*='backdrop']")
          ).some(m => {
            return m.offsetParent !== null && (m.innerText || "").includes("Memuat data");
          });

          if (activeLoadingModal) return { ok: false };

          // 2. Cek apakah data metadata masih (0/0) belum diketahui
          const isStuckZero = bodyText.includes("jumlah pemeriksaan (0/0)") && bodyText.includes("(belum diketahui)");
          if (isStuckZero) return { ok: false };

          // 3. Cek apakah elemen data riil sudah selesai di-render di halaman
          const hasInputButtons = Array.from(document.querySelectorAll("button")).some(b => {
            const txt = b.innerText.trim().toLowerCase();
            return (
              (txt.includes("input data") || txt === "input" || txt.includes("selesaikan layanan")) &&
              b.offsetParent !== null
            );
          });

          const tableRows = Array.from(document.querySelectorAll(".table-pemeriksaan-mandiri tr")).filter(r =>
            r.querySelector("button") || r.querySelector("img[src*='icon-success']")
          );

          const gridBadges = Array.from(
            document.getElementsByClassName("text-[14px] px-2 font-500 border-1 border-solid border-rd-full w-[70%] h-auto")
          ).filter(el => {
            const txt = el.innerText.trim().toLowerCase();
            return txt.length > 0 && !txt.includes("memuat") && (txt.includes("selesai") || txt.includes("pemeriksaan"));
          });

          // Jika ada tombol input, atau ada baris tabel mandiri, atau ada badge pemeriksaan riil: halaman sudah siap!
          return { ok: hasInputButtons || tableRows.length > 0 || gridBadges.length > 0 };
        });

        if (checkStatus?.isServerError) {
          detectedServerError = true;
          break;
        }

        if (checkStatus?.ok) {
          isLoaded = true;
          break;
        }
        await t(250);
      }

      if (isLoaded) {
        console.log(`[Automation] Halaman Sehat Indonesiaku siap dalam ${Date.now() - startWait}ms (percobaan ke-${attempt})`);
        return true;
      }

      if (detectedServerError) {
        console.warn(`[Automation] Terdeteksi 'Internal Server Error' pada halaman detail! Menunggu 10 detik sebelum refresh (percobaan ${attempt}/${maxRetries})...`);
        await t(10000);
      } else {
        console.warn(`[Automation] Halaman belum memuat data setelah ${timeoutMs / 1000} detik pada percobaan ke-${attempt}/${maxRetries}`);
      }

      if (attempt < maxRetries && !this._stopped) {
        console.log(`[Automation] Me-refresh halaman tab Sehat Indonesiaku (percobaan ke-${attempt + 1}/${maxRetries})...`);
        try {
          await n(this.tabId, () => {
            const okBtn = Array.from(document.querySelectorAll("button")).find(
              b => (b.textContent || "").trim().toLowerCase() === "ok"
            );
            if (okBtn) okBtn.click();
          }).catch(() => {});
          await chrome.tabs.reload(this.tabId);
        } catch (err) {
          console.error("[Automation] Reload error:", err);
        }
        await t(800);
        try {
          await o(this.tabId, url => url.includes("sehatindonesiaku.kemkes.go.id"), 20000);
        } catch (err) {}
        await t(1500);
      }
    }

    if (detectedServerError) {
      console.error(`[Automation] Internal Server Error menetap setelah ${maxRetries}x refresh. Melewatkan data pasien ini.`);
      this.stop();
      throw new Error("INTERNAL_SERVER_ERROR_SKIP");
    }

    console.error(`[Automation] Halaman tetap belum memuat data setelah ${maxRetries}x refresh. Bot dihentikan.`);
    this.stop();
    return false;
  }

  /**
   * Memastikan halaman form skrining (form.kemkes.go.id) berhasil dimuat.
   * Jika saat membuka form muncul error seperti 403 Forbidden / server error / halaman blank:
   * Menunggu dan memantau selama 5 detik per percobaan.
   * Jika selama 5 detik error menetap / form belum termuat:
   * Melakukan refresh tab halaman (maksimal 3x percobaan).
   * Jika setelah 3x percobaan masih tetap error seperti itu, bot akan otomatis berhenti.
   */
  async ensureFormPageLoaded(formTitle = "Pemeriksaan", maxRetries = 3, timeoutMs = 5000) {
    let lastErrorType = "Halaman blank / belum termuat";

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      if (this._stopped) return false;
      console.log(`[Automation] Menunggu form "${formTitle}" termuat (percobaan ${attempt}/${maxRetries})...`);

      const startWait = Date.now();
      let detectedError = null;

      while (Date.now() - startWait < timeoutMs) {
        if (this._stopped) return false;

        try {
          const status = await n(this.tabId, () => {
            const title = (document.title || "").trim();
            const bodyText = (document.body ? document.body.innerText || "" : "").trim();
            const lowerTitle = title.toLowerCase();
            const lowerBody = bodyText.toLowerCase();

            // Cek apakah halaman menampilkan 429 Too Many Requests
            const is429 =
              title === "429" ||
              lowerTitle.includes("429") ||
              lowerTitle.includes("too many requests") ||
              lowerBody.includes("429 too many requests") ||
              lowerBody.includes("too many requests") ||
              lowerBody.startsWith("429");

            // Cek apakah halaman menampilkan error (seperti 403 Forbidden pada screenshot)
            const is403 =
              title === "403" ||
              lowerTitle.includes("403") ||
              lowerTitle.includes("forbidden") ||
              lowerBody.includes("403 forbidden") ||
              lowerBody === "403 forbidden" ||
              lowerBody.startsWith("403") ||
              lowerBody.includes("access denied") ||
              lowerBody === "forbidden";

            const isServerError =
              lowerTitle.includes("502") ||
              lowerTitle.includes("504") ||
              lowerTitle.includes("500") ||
              lowerBody.includes("502 bad gateway") ||
              lowerBody.includes("504 gateway") ||
              lowerBody.includes("500 internal server error") ||
              lowerBody.includes("service unavailable");

            // Cek apakah form SurveyJS sudah termuat elemennya
            const hasForm =
              document.querySelectorAll(".sd-item__control-label").length > 0 ||
              document.querySelectorAll('input[type="radio"]').length > 0 ||
              document.querySelectorAll('input[type="checkbox"]').length > 0 ||
              document.querySelectorAll(".sd-dropdown__filter-string-input").length > 0 ||
              document.querySelectorAll("input.sd-input").length > 0 ||
              document.querySelectorAll(".sd-question").length > 0 ||
              null !== document.querySelector(".sd-body") ||
              null !== document.querySelector(".sd-element--with-frame") ||
              null !== document.querySelector(".sd-root-modern");

            return {
              ok: hasForm && !is403 && !is429 && !isServerError,
              is429,
              is403,
              isServerError,
              title,
              bodySnippet: bodyText.slice(0, 80)
            };
          });

          if (status?.ok) {
            console.log(`[Automation] Form "${formTitle}" berhasil termuat pada percobaan ke-${attempt} (${Date.now() - startWait}ms)`);
            return true;
          }

          if (status?.is429) {
            detectedError = "429 Too Many Requests";
            this.rateLimited = true;
          } else if (status?.is403) {
            detectedError = "403 Forbidden";
            console.warn(`[Automation] ⚠️ Form "${formTitle}" terdeteksi 403 Forbidden (token tidak valid/kedaluwarsa).`);
            break;
          } else if (status?.isServerError) {
            detectedError = "Server Error";
          }
        } catch (scriptErr) {
          // Tab mungkin sedang proses reload / rendering awal
        }

        await t(300);
      }

      lastErrorType = detectedError || "Form belum muncul / stuck blank";
      console.warn(
        `[Automation] Form "${formTitle}" terdeteksi ${lastErrorType} (percobaan ${attempt}/${maxRetries}).`
      );

      // Jika error 403 Forbidden, token form ini sudah tidak valid di server Kemkes.
      // Me-reload URL yang sama akan tetap menghasilkan 403 Forbidden.
      // Langsung hentikan percobaan pada URL mati ini dan kembali ke halaman utama untuk request token baru.
      if (detectedError === "403 Forbidden") {
        break;
      }

      // Jika belum mencapai batas percobaan, refresh tab halaman form dengan jeda sesuai jenis error
      if (attempt < maxRetries && !this._stopped) {
        if (detectedError === "429 Too Many Requests") {
          const coolDownMs = 12000 + (attempt * 4000); // 16s, 20s, 24s cooldown agar rate limit Cloudflare/Kemkes pulih
          console.warn(`[Automation] ⚠️ Terkena rate limit (429 Too Many Requests)! Menunggu pendinginan server selama ${coolDownMs / 1000} detik sebelum reload...`);
          try {
            await this.onProgress?.(this.processedCount, "rate-limit", `⚠️ 429 Too Many Requests: Menunggu ${coolDownMs / 1000}s`);
          } catch (e) {}
          await t(coolDownMs);
        } else {
          await t(1000);
        }

        console.log(`[Automation] Me-refresh tab halaman form (percobaan ke-${attempt + 1}/${maxRetries})...`);
        try {
          await chrome.tabs.reload(this.tabId);
        } catch (reloadErr) {
          console.error("[Automation] Error saat reload form tab:", reloadErr);
        }
        await t(1200);
        try {
          await o(this.tabId, url => url.includes("form.kemkes.go.id"), 15000);
        } catch (navErr) {}
        await t(1000);
      }
    }

    // Jika setelah maxRetries refresh form masih belum termuat:
    console.error(
      `[Automation] Form "${formTitle}" tetap ${lastErrorType} setelah ${maxRetries}x refresh. Mengembalikan tab ke halaman utama...`
    );

    // Kembalikan tab ke halaman utama agar alur tidak macet dan item lain tetap dapat diproses
    try {
      const backUrl = this.lastMainUrl || "https://sehatindonesiaku.kemkes.go.id/ckg-pelayanan/detail-pemeriksaan";
      await chrome.tabs.update(this.tabId, { url: backUrl }).catch(() => {});
      await o(this.tabId, url => url.includes("sehatindonesiaku.kemkes.go.id"), 20000).catch(() => {});
      await this.ensureMainPageLoaded(3, 5000);
      await t(1500);
    } catch (backErr) {}

    return false;
  }

  async getItems() {
    await this.ensureMainPageLoaded(3, 5000);
    return n(this.tabId, () => {
      const isStatusTextDone = text => {
        const lower = (text || "").toLowerCase();
        if (lower.includes("belum") || lower.includes("sedang") || lower.includes("tidak")) return false;
        return (
          lower.includes("selesai diperiksa") ||
          lower.includes("sudah diperiksa") ||
          lower.includes("selesai") ||
          lower.includes("sudah") ||
          lower.includes("diperiksa")
        );
      };

      const tableItems = Array.from(document.querySelectorAll(".table-pemeriksaan-mandiri tr"))
        .filter(tr => tr.querySelector("button") || tr.querySelector("img"))
        .map((tr, idx) => {
          const tds = Array.from(tr.querySelectorAll("td"));
          const titleTd = tds.find(td => {
            const txt = td.innerText.trim();
            return !td.querySelector("button") && !td.querySelector("img") && txt.length > 0 && !/^\d+$/.test(txt);
          }) || tds.find(td => !td.querySelector("button") && td.innerText.trim().length > 0);

          const img = tr.querySelector("img");
          const hasSuccessIcon = !!img && (img.src || "").includes("icon-success.svg");
          const rowText = (tr.innerText || "").toLowerCase();
          const isDone = hasSuccessIcon || isStatusTextDone(rowText);

          return {
            title: titleTd?.innerText.replace(/\s+/g, " ").trim() ?? `Pemeriksaan Mandiri ${idx + 1}`,
            index: idx,
            done: isDone,
            source: "table"
          };
        });

      const candidateRows = Array.from(document.querySelectorAll(
        "#tableLayanan .grid.grid-cols-5, #tableLayanan .grid-cols-5, .grid.grid-cols-5, #tableLayanan [class*='grid-cols-5']"
      )).filter(r => !r.closest(".table-pemeriksaan-mandiri") && (r.querySelector(".col-span-2") || r.querySelector("button")));

      const colRows = Array.from(document.querySelectorAll("#tableLayanan .col-span-2, [class*='col-span-2']"))
        .filter(c => !c.closest(".table-pemeriksaan-mandiri"))
        .map(c => c.closest(".grid-cols-5") || c.closest(".grid") || c.parentElement)
        .filter(Boolean);

      const seenRows = new Set();
      const uniqueGridRows = [];
      for (const item of [...candidateRows, ...colRows]) {
        if (!item || seenRows.has(item) || item.closest(".table-pemeriksaan-mandiri")) continue;
        if (item.id === "tableLayanan" || item.classList.contains("space-y-2")) continue;
        seenRows.add(item);
        uniqueGridRows.push(item);
      }

      const gridItems = uniqueGridRows.map((row, idx) => {
        const titleEl =
          row?.querySelector(".col-span-2.pl-12.flex.items-center") ||
          row?.querySelector(".col-span-2") ||
          row?.firstElementChild;

        const badge = row?.querySelector("span, div[class*='border'], div[class*='rounded'], [class*='badge']");
        const badgeText = (badge?.innerText || "").toLowerCase();
        const rowText = (row?.innerText || "").toLowerCase();
        const combinedText = `${badgeText} ${rowText}`;
        const isDone = isStatusTextDone(combinedText);

        return {
          title: titleEl?.innerText.replace(/\s+/g, " ").trim() ?? `Pelayanan Nakes ${idx + 1}`,
          index: tableItems.length + idx,
          done: isDone,
          source: "grid"
        };
      });

      return [...tableItems, ...gridItems];
    });
  }

  /**
   * Tahap 1: Memeriksa dan memastikan tombol 'Mulai Pemeriksaan' diklik jika ada.
   * Jika pasien berstatus 'Belum Pemeriksaan' atau tombol 'Mulai Pemeriksaan' aktif di halaman:
   * 1. Klik tombol 'Mulai Pemeriksaan'
   * 2. Tunggu modal dialog 'Konfirmasi Tanggal Pemeriksaan' / kalender muncul
   * 3. Atur tanggal pemeriksaan (menggunakan attendDate atau fallback ke tanggal hari ini)
   * 4. Klik tombol 'Simpan' pada modal
   * 5. Tunggu hingga status berganti ke 'Sedang Pemeriksaan' dan halaman siap.
   */
  async ensureMulaiPemeriksaan(rawTargetDate = null) {
    if (this._stopped) return;

    const checkBtn = await n(this.tabId, () => {
      const btn = Array.from(document.querySelectorAll("button")).find(
        b => b.textContent.trim() === "Mulai Pemeriksaan" && !b.disabled && b.getBoundingClientRect().width > 0
      );
      return { hasBtn: !!btn };
    });

    if (!checkBtn.hasBtn) {
      console.log("[Automation] Pasien dalam status 'Sedang Pemeriksaan' (tidak ada tombol Mulai Pemeriksaan). Langsung lanjut ke pengisian form.");
      return;
    }

    console.log("[Automation] Menemukan tombol 'Mulai Pemeriksaan' / status 'Belum Pemeriksaan'. Menjalankan Tahap 1: Mulai Pemeriksaan...");

    const targetDate = rawTargetDate || this.attendDate;
    let d = targetDate ? new Date(targetDate) : new Date();
    if (isNaN(d.getTime())) d = new Date();
    const tahun = d.getFullYear();
    const bulan = d.getMonth() + 1;
    const hari = d.getDate();

    console.log(`[Automation] Mengatur tanggal pemeriksaan ke: ${tahun}-${bulan}-${hari}`);

    await n(
      this.tabId,
      async (thn, bln, tgl) => {
        const sleep = ms => new Promise(res => setTimeout(res, ms));
        const MONTHS = ["Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Agu", "Sep", "Okt", "Nov", "Des"];

        const btnMulai = Array.from(document.querySelectorAll("button")).find(
          b => b.textContent.trim() === "Mulai Pemeriksaan" && !b.disabled && b.getBoundingClientRect().width > 0
        );

        if (btnMulai) {
          btnMulai.scrollIntoView({ block: "center" });
          btnMulai.click();
          await sleep(1000);
        }

        // Tunggu modal kalender konfirmasi tanggal muncul (maksimal 5 detik)
        const modalStart = Date.now();
        while (Date.now() - modalStart < 5000) {
          const hasModal = Array.from(document.querySelectorAll("div, [role='dialog'], .fixed, .modal")).some(
            el => (el.textContent || "").includes("Konfirmasi Tanggal Pemeriksaan") || (el.textContent || "").includes("Tanggal Pemeriksaan")
          );
          if (hasModal) break;
          await sleep(300);
        }

        // Navigasi bulan/tahun kalender jika diperlukan
        const targetMonthIndex = bln - 1 + 12 * thn;
        for (let i = 0; i < 36; i++) {
          const headerEl = Array.from(document.querySelectorAll("div.flex.items-center")).find(
            e => e.children.length === 2 && /^(Jan|Feb|Mar|Apr|Mei|Jun|Jul|Agu|Sep|Okt|Nov|Des)\d{4}$/.test((e.textContent || "").replace(/\s+/g, ""))
          );
          if (!headerEl) {
            await sleep(300);
            continue;
          }

          const match = (headerEl.textContent || "").replace(/\s+/g, "").match(/^([A-Za-z]{3})(\d{4})$/);
          if (!match) {
            await sleep(300);
            continue;
          }

          const currentMonthIdx = MONTHS.indexOf(match[1]) + 12 * parseInt(match[2], 10);
          if (currentMonthIdx === targetMonthIndex) break;

          const isFuture = currentMonthIdx > targetMonthIndex;
          const navDiv = headerEl.parentElement?.querySelector("div.flex.items-center.justify-center");
          const arrows = navDiv ? Array.from(navDiv.querySelectorAll("button")) : [];
          if (arrows.length >= 2) {
            arrows[isFuture ? 0 : 1]?.click();
            await sleep(400);
          } else {
            break;
          }
        }

        // Klik tanggal hari
        const daySpan = Array.from(document.querySelectorAll("span")).find(
          e => e.textContent.trim() === String(tgl) && !/text-gray-300/.test(e.className) && e.closest(".grid") && e.offsetParent !== null
        );
        if (daySpan) {
          daySpan.click();
          await sleep(400);
        }

        // Klik tombol Simpan pada modal
        const btnSimpan = Array.from(document.querySelectorAll("button")).find(
          b => (b.textContent.trim() === "Simpan" || b.textContent.trim().toLowerCase().includes("simpan")) && !b.disabled && b.offsetParent !== null
        );
        if (btnSimpan) {
          btnSimpan.click();
          await sleep(1200);
        }
      },
      [tahun, bulan, hari]
    );

    await t(1500);
    await this.ensureMainPageLoaded(3, 5000);
    console.log("[Automation] Tahap 1: Mulai Pemeriksaan selesai.");
  }

  async run() {
    if (this._stopped) return;
    try {
      // ─────────────────────────────────────────────────────────────
      // TAHAP 1: MULAI PEMERIKSAAN
      // ─────────────────────────────────────────────────────────────
      const pageReady = await this.ensureMainPageLoaded(3, 5000);
      if (!pageReady) {
        this.stop();
        throw new Error("Web memuat lebih dari 5 detik setelah 3x refresh. Bot dihentikan.");
      }

      console.log("[Automation] Menjalankan Tahap 1: Memeriksa dan memastikan 'Mulai Pemeriksaan'...");
      await this.ensureMulaiPemeriksaan(this.attendDate);
      if (this._stopped) return;

      // Ambil daftar item terbaru setelah status pemeriksaan aktif
      const allItems = await this.getItems();
      this._itemsCache = allItems;

      // Pisahkan item menjadi Pemeriksaan Mandiri (tabel) dan Pelayanan oleh Nakes (grid)
      const mandiriItems = allItems.filter(item => item.source === "table");
      const nakesItems = allItems.filter(item => item.source === "grid");

      console.log(`[Automation] Total: ${allItems.length} item (${mandiriItems.length} Pemeriksaan Mandiri, ${nakesItems.length} Pelayanan Nakes).`);

      // ─────────────────────────────────────────────────────────────
      // TAHAP 2: ISI PEMERIKSAAN MANDIRI (TERISI SEMUA)
      // ─────────────────────────────────────────────────────────────
      console.log("[Automation] === MEMULAI TAHAP 2: ISI PEMERIKSAAN MANDIRI ===");
      for (const item of mandiriItems) {
        if (this._stopped) break;
        await this._waitResume();

        if (this.testMode || !item.done) {
          this.processedCount++;
          await this._processItem(item, item.index);
        } else {
          await this.onProgress(item.index, "done", item.title);
        }
      }

      // Verifikasi bahwa semua item Pemeriksaan Mandiri telah terisi (centang hijau)
      if (!this._stopped) {
        const mandiriVerification = await n(this.tabId, () => {
          const isStatusTextDone = text => {
            const lower = (text || "").toLowerCase();
            if (lower.includes("belum") || lower.includes("sedang") || lower.includes("tidak")) return false;
            return (
              lower.includes("selesai diperiksa") ||
              lower.includes("sudah diperiksa") ||
              lower.includes("selesai") ||
              lower.includes("sudah") ||
              lower.includes("diperiksa")
            );
          };
          const rows = Array.from(document.querySelectorAll(".table-pemeriksaan-mandiri tr"))
            .filter(r => r.querySelector("button") || r.querySelector("img"));
          const total = rows.length;
          const done = rows.filter(r => {
            const img = r.querySelector("img");
            const hasSuccessIcon = !!img && (img.src || "").includes("icon-success.svg");
            const text = (r.innerText || "").toLowerCase();
            return hasSuccessIcon || isStatusTextDone(text);
          }).length;
          return { total, done, allDone: total === 0 || done === total };
        });

        console.log(`[Automation] Verifikasi Mandiri: ${mandiriVerification.done}/${mandiriVerification.total} selesai.`);

        // Jika ada item mandiri yang tertinggal, coba ulangi sekali lagi
        if (!mandiriVerification.allDone && !this._stopped) {
          console.warn("[Automation] Masih ada item Mandiri yang belum selesai. Mengulangi item mandiri yang tersisa...");
          const updatedMandiri = (await this.getItems()).filter(i => i.source === "table" && !i.done);
          for (const item of updatedMandiri) {
            if (this._stopped) break;
            await this._waitResume();
            await this._processItem(item, item.index);
          }
        }
        console.log("[Automation] === TAHAP 2 SELESAI: PEMERIKSAAN MANDIRI TERISI SEMUA ===");
      }

      // ─────────────────────────────────────────────────────────────
      // TAHAP 3: ISI PELAYANAN OLEH NAKES (TERISI SEMUA)
      // ─────────────────────────────────────────────────────────────
      if (!this._stopped) {
        console.log("[Automation] === MEMULAI TAHAP 3: ISI PELAYANAN OLEH NAKES ===");
        for (const item of nakesItems) {
          if (this._stopped) break;
          await this._waitResume();

          if (this.testMode || !item.done) {
            this.processedCount++;
            await this._processItem(item, item.index);
          } else {
            console.log(`[Automation] Nakes "${item.title}" sudah berstatus Selesai / Sudah diperiksa sejak awal — lewati.`);
            await this.onProgress(item.index, "done", item.title);
          }
        }

        // Verifikasi bahwa layanan nakes selesai
        const nakesVerification = await n(this.tabId, () => {
          const isStatusTextDone = text => {
            const lower = (text || "").toLowerCase();
            if (lower.includes("belum") || lower.includes("sedang") || lower.includes("tidak")) return false;
            return (
              lower.includes("selesai diperiksa") ||
              lower.includes("sudah diperiksa") ||
              lower.includes("selesai") ||
              lower.includes("sudah")
            );
          };

          const candidateRows = Array.from(document.querySelectorAll(
            "#tableLayanan .grid.grid-cols-5, #tableLayanan .grid-cols-5, .grid.grid-cols-5, #tableLayanan [class*='grid-cols-5']"
          )).filter(r => !r.closest(".table-pemeriksaan-mandiri") && (r.querySelector(".col-span-2") || r.querySelector("button")));

          const colRows = Array.from(document.querySelectorAll("#tableLayanan .col-span-2, [class*='col-span-2']"))
            .filter(c => !c.closest(".table-pemeriksaan-mandiri"))
            .map(c => c.closest(".grid-cols-5") || c.closest(".grid") || c.parentElement)
            .filter(Boolean);

          const seenGrid = new Set();
          let total = 0;
          let done = 0;
          for (const row of [...candidateRows, ...colRows]) {
            if (!row || seenGrid.has(row) || row.closest(".table-pemeriksaan-mandiri")) continue;
            if (row.id === "tableLayanan" || row.classList.contains("space-y-2")) continue;
            seenGrid.add(row);
            total++;

            const badge = row.querySelector("span, div[class*='border'], div[class*='rounded'], [class*='badge']");
            const badgeText = (badge?.innerText || "").toLowerCase();
            const rowText = (row.innerText || "").toLowerCase();
            const combinedText = `${badgeText} ${rowText}`;
            if (isStatusTextDone(combinedText)) done++;
          }

          return { total, done, allDone: total === 0 || done === total };
        });

        console.log(`[Automation] Verifikasi Nakes: ${nakesVerification.done}/${nakesVerification.total} selesai.`);

        // Jika masih ada baris nakes dengan tombol input aktif yang belum selesai, coba ulangi
        if (!nakesVerification.allDone && !this._stopped) {
          console.warn("[Automation] Masih ada item Nakes yang belum selesai. Menjalankan pass kedua untuk Nakes tersisa...");
          const updatedNakes = (await this.getItems()).filter(i => i.source === "grid" && !i.done);
          for (const item of updatedNakes) {
            if (this._stopped) break;
            await this._waitResume();
            await this._processItem(item, item.index);
          }
        }
        console.log("[Automation] === TAHAP 3 SELESAI: PELAYANAN OLEH NAKES TERISI SEMUA ===");
      }

      // ─────────────────────────────────────────────────────────────
      // TAHAP 4: SELESAIKAN LAYANAN
      // ─────────────────────────────────────────────────────────────
      if (!this._stopped) {
        console.log("[Automation] === MEMULAI TAHAP 4: SELESAIKAN LAYANAN ===");
        await this.ensureMainPageLoaded(3, 5000).catch(() => {});
        console.log("[Automation] Menjalankan penyelesaian layanan secara langsung (Selesaikan Layanan & Konfirmasi instan)...");
        const res = await this.finishPelayanan();
        if (res?.success) {
          this.pelayananFinished = true;
          console.log("[Automation] Layanan berhasil diselesaikan dan langsung dikonfirmasi.");
        } else {
          console.warn("[Automation] Hasil finishPelayanan:", res);
        }
      }
    } finally {
      await this.onDone();
    }
  }

  async finishPelayanan() {
    await this.ensureMainPageLoaded(3, 5000).catch(() => {});
    return n(this.tabId, async () => {
      const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
      const clean = s => (s || "").replace(/\s+/g, " ").trim().toLowerCase();

      const isVisible = el => {
        if (!el) return false;
        try {
          const style = window.getComputedStyle(el);
          if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
          const rect = el.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        } catch (e) {
          return false;
        }
      };

      const triggerClick = el => {
        if (!el) return;
        el.scrollIntoView({ block: "center", inline: "center" });
        const rect = el.getBoundingClientRect();
        const opts = {
          bubbles: true,
          cancelable: true,
          view: window,
          clientX: rect.left + rect.width / 2,
          clientY: rect.top + rect.height / 2
        };
        el.dispatchEvent(new PointerEvent("pointerdown", opts));
        el.dispatchEvent(new MouseEvent("mousedown", opts));
        el.dispatchEvent(new PointerEvent("pointerup", opts));
        el.dispatchEvent(new MouseEvent("mouseup", opts));
        el.dispatchEvent(new MouseEvent("click", opts));
        if (typeof el.click === "function") {
          try { el.click(); } catch (err) {}
        }
      };

      const findSelesaikanBtn = () => {
        const candidates = Array.from(
          document.querySelectorAll("button, a, [role='button'], div[class*='btn'], span[class*='btn'], div[class*='cursor-pointer'], span[class*='cursor-pointer']")
        );
        return candidates.find(e => {
          if (!isVisible(e)) return false;
          const txt = clean(e.innerText || e.textContent);
          if (!txt || txt.includes("batal") || txt.includes("kembali") || txt.includes("tutup") || txt.includes("tatalaksana") || txt.includes("tanggal")) return false;
          return (
            txt === "selesaikan layanan" ||
            txt === "selesaikan pelayanan" ||
            txt === "selesaikan pemeriksaan" ||
            txt === "selesaikan" ||
            txt.includes("selesaikan layanan") ||
            txt.includes("selesaikan pelayanan") ||
            txt.includes("selesaikan pemeriksaan") ||
            (txt.startsWith("selesaikan") && !txt.includes("batal"))
          );
        });
      };

      // Cek apakah halaman sudah berstatus 'Selesai Pemeriksaan'
      const checkAlreadyFinished = () => {
        // Jika sudah tidak di halaman detail-pemeriksaan (misal redirect ke daftar pelayanan)
        if (!location.href.includes("detail-pemeriksaan")) return true;
        // Jika tombol Selesaikan Layanan masih ada dan terlihat, jelas BELUM selesai!
        if (findSelesaikanBtn()) return false;
        // Cek badge status di header
        const badges = Array.from(document.querySelectorAll("span, div, p, [class*='badge']")).filter(isVisible);
        return badges.some(b => {
          const txt = clean(b.innerText || b.textContent);
          return txt === "selesai pemeriksaan" || txt === "selesai pelayanan";
        });
      };

      if (checkAlreadyFinished()) {
        console.log("[finishPelayanan] Pasien sudah berstatus Selesai Pemeriksaan.");
        return { success: true };
      }

      // 1. Cari tombol 'Selesaikan Layanan' dan tunggu hingga tidak disabled (hingga 15 detik)
      let btnFinish = null;
      for (let i = 0; i < 75; i++) {
        if (checkAlreadyFinished()) {
          console.log("[finishPelayanan] Pasien sudah berstatus Selesai Pemeriksaan.");
          return { success: true };
        }

        btnFinish = findSelesaikanBtn();
        if (btnFinish) {
          const isDisabled = btnFinish.disabled ||
            btnFinish.getAttribute("aria-disabled") === "true" ||
            btnFinish.classList.contains("disabled") ||
            btnFinish.classList.contains("opacity-50") ||
            btnFinish.classList.contains("pointer-events-none");
          if (!isDisabled) {
            console.log(`[finishPelayanan] Tombol Selesaikan aktif ditemukan pada percobaan ke-${i + 1}`);
            break;
          }
        }
        await delay(200);
      }

      if (!btnFinish) {
        if (checkAlreadyFinished()) return { success: true };
        console.warn("[finishPelayanan] Tombol 'Selesaikan Layanan' tidak ditemukan di halaman.");
        return { success: false, reason: "btn_not_found" };
      }

      const isDisabled = btnFinish.disabled ||
        btnFinish.getAttribute("aria-disabled") === "true" ||
        btnFinish.classList.contains("disabled") ||
        btnFinish.classList.contains("pointer-events-none");
      if (isDisabled) {
        console.warn("[finishPelayanan] Tombol 'Selesaikan Layanan' masih berstatus disabled setelah 15 detik.");
        return { success: false, reason: "btn_disabled" };
      }

      console.log("[finishPelayanan] Menemukan tombol 'Selesaikan Layanan', melakukan klik...");
      triggerClick(btnFinish);

      // 2. Deteksi modal konfirmasi dan klik tombol konfirmasi / selesaikan
      console.log("[finishPelayanan] Memantau modal konfirmasi secara instan...");
      let confirmed = false;

      const findConfirmBtn = () => {
        // A. Cek container modal dialog aktif
        const modals = Array.from(
          document.querySelectorAll("[role='dialog'], [aria-modal='true'], .modal, .fixed, .overlay, div[class*='modal'], div[class*='dialog'], div[class*='popup']")
        ).filter(isVisible);

        for (const modal of modals) {
          if (modal === document.body || modal.tagName === "BODY" || modal.tagName === "HTML") continue;
          const mText = clean(modal.innerText || modal.textContent);
          if (!mText || mText.length < 3) continue;

          const modalBtns = Array.from(modal.querySelectorAll("button, a, [role='button'], div[class*='cursor-pointer'], span[class*='cursor-pointer']")).filter(isVisible);
          const confirmBtn = modalBtns.find(b => {
            if (b.disabled || b.getAttribute("aria-disabled") === "true") return false;
            const txt = clean(b.innerText || b.textContent);
            if (!txt || txt.includes("batal") || txt.includes("kembali") || txt.includes("tidak") || txt.includes("tutup") || txt === "x") {
              return false;
            }
            return (
              txt === "ya, selesaikan" ||
              txt === "ya, selesaikan layanan" ||
              txt === "ya, selesaikan pelayanan" ||
              txt === "selesaikan layanan" ||
              txt === "selesaikan pelayanan" ||
              txt === "selesaikan" ||
              txt === "ya, konfirmasi" ||
              txt === "konfirmasi" ||
              txt === "ya" ||
              txt === "simpan" ||
              txt === "lanjut" ||
              txt === "ya, lanjutkan" ||
              txt.includes("selesaikan") ||
              txt.includes("konfirmasi") ||
              txt.startsWith("ya,")
            );
          });
          if (confirmBtn) return confirmBtn;
        }

        // B. Fallback search tombol konfirmasi di seluruh halaman
        const allBtns = Array.from(document.querySelectorAll("button, a, [role='button']")).filter(isVisible);
        return allBtns.find(b => {
          if (b === btnFinish || b.disabled || b.getAttribute("aria-disabled") === "true") return false;
          const txt = clean(b.innerText || b.textContent);
          if (!txt || txt.includes("batal") || txt.includes("kembali") || txt.includes("tidak") || txt.includes("tutup") || txt === "x") return false;
          return (
            txt === "ya, selesaikan" ||
            txt === "ya, selesaikan layanan" ||
            txt === "ya, selesaikan pelayanan" ||
            txt === "selesaikan" ||
            txt === "ya, konfirmasi" ||
            txt === "konfirmasi" ||
            txt === "ya" ||
            txt === "ya, lanjutkan" ||
            (txt.includes("selesaikan") && b !== btnFinish)
          );
        });
      };

      for (let i = 0; i < 80; i++) {
        if (!location.href.includes("detail-pemeriksaan")) {
          console.log("[finishPelayanan] Halaman berpindah dari detail-pemeriksaan.");
          return { success: true };
        }

        const confirmBtn = findConfirmBtn();
        if (confirmBtn) {
          console.log("[finishPelayanan] Tombol konfirmasi modal ditemukan:", confirmBtn.innerText.trim());
          triggerClick(confirmBtn);
          confirmed = true;
          break;
        }

        // Jika setelah 2 detik modal belum muncul, klik ulang tombol Selesaikan Layanan
        if (i === 20) {
          const retryBtn = findSelesaikanBtn();
          if (retryBtn) {
            console.log("[finishPelayanan] Retry klik tombol Selesaikan Layanan...");
            triggerClick(retryBtn);
          }
        }

        await delay(100);
      }

      if (!confirmed) {
        if (checkAlreadyFinished()) return { success: true };
        console.warn("[finishPelayanan] Tombol konfirmasi modal tidak ditemukan dalam batas waktu.");
        return { success: false, reason: "confirm_btn_not_found" };
      }

      // 3. Verifikasi respon server Kemkes (tunggu hingga 12 detik)
      console.log("[finishPelayanan] Menunggu verifikasi penyelesaian dari server Kemkes...");
      for (let waitIdx = 0; waitIdx < 40; waitIdx++) {
        await delay(300);
        if (!location.href.includes("detail-pemeriksaan")) {
          console.log("[finishPelayanan] Terverifikasi: Berhasil keluar dari detail-pemeriksaan.");
          return { success: true };
        }

        const currentBtn = findSelesaikanBtn();
        const badges = Array.from(document.querySelectorAll("span, div, p, [class*='badge']")).filter(isVisible);
        const hasSelesaiBadge = badges.some(b => {
          const txt = clean(b.innerText || b.textContent);
          return txt === "selesai pemeriksaan" || txt === "selesai pelayanan";
        });

        if (!currentBtn || hasSelesaiBadge) {
          console.log("[finishPelayanan] Terverifikasi: Tombol Selesaikan Layanan hilang atau badge Selesai aktif!");
          return { success: true };
        }

        // Jika modal konfirmasi masih ada setelah 3 detik dan 6 detik, coba klik lagi
        if (waitIdx === 10 || waitIdx === 20) {
          const retryConfirm = findConfirmBtn();
          if (retryConfirm) {
            console.log("[finishPelayanan] Retry klik konfirmasi modal (kemkes belum selesai memproses)...");
            triggerClick(retryConfirm);
          }
        }
      }

      const finalBtn = findSelesaikanBtn();
      if (finalBtn) {
        console.warn("[finishPelayanan] Tombol Selesaikan Layanan masih ada setelah 12 detik.");
        return { success: false, reason: "server_not_acknowledged" };
      }

      return { success: true };
    });
  }

  async verifyAllDone() {
    if (this.pelayananFinished) {
      return {
        total: this.processedCount || 1,
        done: this.processedCount || 1,
        mandiriTotal: 0,
        mandiriDone: 0,
        nakesTotal: 0,
        nakesDone: 0,
        anyActiveInputBtn: false,
        formsAllDone: true,
        hasSelesaikanBtn: false,
        allDone: true
      };
    }

    return n(this.tabId, () => {
      const isStatusTextDone = text => {
        const lower = (text || "").toLowerCase();
        if (lower.includes("belum") || lower.includes("sedang") || lower.includes("tidak")) return false;
        return (
          lower.includes("selesai diperiksa") ||
          lower.includes("sudah diperiksa") ||
          lower.includes("selesai") ||
          lower.includes("sudah") ||
          lower.includes("diperiksa")
        );
      };

      const isVisible = el => {
        if (!el) return false;
        try {
          const style = window.getComputedStyle(el);
          if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
          const rect = el.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        } catch (e) { return false; }
      };

      if (!location.href.includes("detail-pemeriksaan")) {
        return {
          total: 1,
          done: 1,
          mandiriTotal: 0,
          mandiriDone: 0,
          nakesTotal: 0,
          nakesDone: 0,
          anyActiveInputBtn: false,
          formsAllDone: true,
          hasSelesaikanBtn: false,
          allDone: true
        };
      }

      const isRowDone = row => {
        if (!row) return true;
        const rowText = (row.innerText || "").toLowerCase();
        if (isStatusTextDone(rowText)) return true;

        const img = row.querySelector("img");
        if (img && (img.src || "").match(/success|check|done/i)) return true;

        const svg = row.querySelector("svg");
        if (svg) {
          const svgHtml = svg.outerHTML.toLowerCase();
          if (svgHtml.includes("green") || svgHtml.includes("emerald") || svgHtml.includes("check") || svgHtml.includes("success")) {
            return true;
          }
        }

        // Cek tombol input aktif
        const allBtns = Array.from(row.querySelectorAll("button, a[role='button']"));
        const hasActiveInput = allBtns.some(b => {
          const txt = (b.innerText || b.textContent || "").trim().toLowerCase();
          return (txt.includes("input") || txt === "isi" || txt === "mulai") && !b.disabled && isVisible(b);
        });

        return !hasActiveInput;
      };

      // 1. Mandiri items
      const mandiriRows = Array.from(document.querySelectorAll(".table-pemeriksaan-mandiri tr"))
        .filter(r => r.querySelector("button") || r.querySelector("img") || r.querySelector("svg"));
      const mandiriResults = mandiriRows.map(isRowDone);

      // 2. Nakes items
      const candidateRows = Array.from(document.querySelectorAll(
        "#tableLayanan .grid.grid-cols-5, #tableLayanan .grid-cols-5, .grid.grid-cols-5, #tableLayanan [class*='grid-cols-5']"
      )).filter(r => !r.closest(".table-pemeriksaan-mandiri") && (r.querySelector(".col-span-2") || r.querySelector("button")));

      const colRows = Array.from(document.querySelectorAll("#tableLayanan .col-span-2, [class*='col-span-2']"))
        .filter(c => !c.closest(".table-pemeriksaan-mandiri"))
        .map(c => c.closest(".grid-cols-5") || c.closest(".grid") || c.parentElement)
        .filter(Boolean);

      const seenGrid = new Set();
      const nakesResults = [];
      for (const row of [...candidateRows, ...colRows]) {
        if (!row || seenGrid.has(row) || row.closest(".table-pemeriksaan-mandiri")) continue;
        if (row.id === "tableLayanan" || row.classList.contains("space-y-2")) continue;
        seenGrid.add(row);
        nakesResults.push(isRowDone(row));
      }

      // 3. Pastikan tidak ada tombol input aktif yang tertinggal pada tabel layanan
      const anyActiveInputBtn = Array.from(
        document.querySelectorAll("#tableLayanan button, .table-pemeriksaan-mandiri button")
      ).some(b => {
        const txt = (b.innerText || b.textContent || "").trim().toLowerCase();
        if ((!txt.includes("input") && txt !== "isi" && txt !== "mulai") || b.disabled || !isVisible(b)) {
          return false;
        }
        const row = b.closest("tr, .grid, .grid-cols-5, div.w-full");
        if (row && isRowDone(row)) return false;
        return true;
      });

      // 4. Cek apakah tombol Selesaikan Layanan masih ada di halaman
      const hasSelesaikanBtn = Array.from(
        document.querySelectorAll("button, a, [role='button'], div[class*='btn'], span[class*='btn']")
      ).some(e => {
        if (!isVisible(e)) return false;
        const txt = (e.innerText || e.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
        if (txt.includes("batal") || txt.includes("kembali") || txt.includes("tutup") || txt.includes("tanggal")) return false;
        return (
          txt === "selesaikan layanan" ||
          txt === "selesaikan pelayanan" ||
          txt === "selesaikan pemeriksaan" ||
          txt === "selesaikan" ||
          txt.includes("selesaikan layanan") ||
          txt.includes("selesaikan pelayanan") ||
          txt.includes("selesaikan pemeriksaan")
        );
      });

      const all = [...mandiriResults, ...nakesResults];
      const total = all.length;
      const done = all.filter(Boolean).length;
      const formsAllDone = (total > 0 ? done === total : true) && !anyActiveInputBtn;
      const allDone = formsAllDone && !hasSelesaikanBtn;

      return {
        total,
        done,
        mandiriTotal: mandiriResults.length,
        mandiriDone: mandiriResults.filter(Boolean).length,
        nakesTotal: nakesResults.length,
        nakesDone: nakesResults.filter(Boolean).length,
        anyActiveInputBtn,
        formsAllDone,
        hasSelesaikanBtn,
        allDone
      };
    });
  }

  async runSingle(e, t) {
    if (this._stopped) return;
    try {
      const pageReady = await this.ensureMainPageLoaded(3, 5000);
      if (!pageReady) {
        this.stop();
        throw new Error("Web memuat lebih dari 5 detik setelah 3x refresh. Bot dihentikan.");
      }
      await this._processItem(e, t);
    } finally {
      await this.onDone();
    }
  }

  async detectFormTitle() {
    return n(this.tabId, () =>
      `${[
        document.querySelector(".sd-title.sd-container-modern__title"),
        document.querySelector(".sd-page__title"),
        document.querySelector(".sd-header__text .sd-title"),
        document.querySelector(".sd-title"),
        document.querySelector("h1"),
        document.querySelector("h2")
      ]
        .map(e => e?.innerText?.trim() ?? "")
        .join(" ")} ${document.querySelector(".sd-body")?.innerText ?? ""}`.trim()
    );
  }

  async fillForm(title) {
    const detected = title ?? (await this.detectFormTitle()) ?? "";
    if (detected.includes("Tingkat Aktivitas Fisik")) {
      await this._fillTingkatAktivitasFisik();
    } else {
      await this._fillByLabels(this.fieldRules);
    }
  }

  async _processItem(item, index) {
    const { title: l, source: i } = item;
    let r = false;
    await this.onProgress(index, "in-progress", l);

    try {
      try {
        const curTab = await chrome.tabs.get(this.tabId);
        if (curTab?.url?.includes("sehatindonesiaku.kemkes.go.id")) {
          this.lastMainUrl = curTab.url;
        }
      } catch (e) {}

      // 1. Pastikan halaman utama Sehat Indonesiaku sudah memuat datanya (bukan 0/0 atau memuat data)
      const pageReady = await this.ensureMainPageLoaded(3, 5000);
      if (!pageReady) {
        this.stop();
        throw new Error("Web memuat lebih dari 5 detik setelah 3x refresh. Bot dihentikan.");
      }

      // 2. Fungsi pencarian & klik baris item
      const findAndClickBtn = () => {
        return n(
          this.tabId,
          targetTitle => {
            const clean = s => (s || "").replace(/\s+/g, " ").trim().toLowerCase();
            const targetClean = clean(targetTitle);

            const isStatusTextDone = text => {
              const lower = (text || "").toLowerCase();
              if (lower.includes("belum") || lower.includes("sedang") || lower.includes("tidak")) return false;
              return (
                lower.includes("selesai diperiksa") ||
                lower.includes("sudah diperiksa") ||
                lower.includes("selesai") ||
                lower.includes("sudah") ||
                lower.includes("diperiksa")
              );
            };

            // 1. Kumpulkan semua baris dari Grid Nakes
            const candidateRows = Array.from(document.querySelectorAll(
              "#tableLayanan .grid.grid-cols-5, #tableLayanan .grid-cols-5, .grid.grid-cols-5, #tableLayanan [class*='grid-cols-5']"
            )).filter(r => !r.closest(".table-pemeriksaan-mandiri") && (r.querySelector(".col-span-2") || r.querySelector("button")));

            const colRows = Array.from(document.querySelectorAll("#tableLayanan .col-span-2, [class*='col-span-2']"))
              .filter(c => !c.closest(".table-pemeriksaan-mandiri"))
              .map(c => c.closest(".grid-cols-5") || c.closest(".grid") || c.parentElement)
              .filter(Boolean);

            const seenGrid = new Set();
            const gridRows = [];
            for (const row of [...candidateRows, ...colRows]) {
              if (!row || seenGrid.has(row) || row.closest(".table-pemeriksaan-mandiri")) continue;
              if (row.id === "tableLayanan" || row.classList.contains("space-y-2")) continue;
              seenGrid.add(row);

              const titleEl =
                row?.querySelector(".col-span-2.pl-12.flex.items-center") ||
                row?.querySelector(".col-span-2") ||
                row?.firstElementChild;
              const title = titleEl?.innerText?.trim() || "";
              const titleClean = clean(title);

              const badge = row?.querySelector("span, div[class*='border'], div[class*='rounded'], [class*='badge']");
              const badgeText = (badge?.innerText || "").toLowerCase();
              const rowText = (row?.innerText || "").toLowerCase();
              const combinedText = `${badgeText} ${rowText}`;
              const isDone = isStatusTextDone(combinedText);

              // Jika status sudah selesai diperiksa / sudah diperiksa, JANGAN cari atau klik tombol input
              const allBtns = Array.from(row?.querySelectorAll("button") || []);
              const btn = !isDone ? (
                allBtns.find(b => {
                  const txt = b.innerText.trim().toLowerCase();
                  return (txt.includes("input") || txt === "isi") && !b.disabled && b.offsetParent !== null;
                }) || null
              ) : null;
              const hasInputBtn = !isDone && !!btn;

              gridRows.push({
                source: "grid",
                title,
                titleClean,
                isDone,
                btn: hasInputBtn ? btn : null,
                row
              });
            }

            // 2. Kumpulkan semua baris dari Tabel Mandiri
            const tableRows = Array.from(document.querySelectorAll(".table-pemeriksaan-mandiri tr")).map(tr => {
              const tds = Array.from(tr.querySelectorAll("td"));
              const titleTd = tds.find(td => {
                const txt = td.innerText.trim();
                return !td.querySelector("button") && !td.querySelector("img") && txt.length > 0 && !/^\d+$/.test(txt);
              }) || tds.find(td => !td.querySelector("button") && td.innerText.trim().length > 0);

              const title = titleTd?.innerText?.trim() || "";
              const titleClean = clean(title);

              const img = tr.querySelector("img");
              const hasSuccessIcon = !!img && (img.src || "").includes("icon-success.svg");
              const rowText = (tr.innerText || "").toLowerCase();
              const isDone = hasSuccessIcon || isStatusTextDone(rowText);

              // Jika sudah selesai atau centang hijau, JANGAN cari atau klik tombol input
              const allBtns = Array.from(tr.querySelectorAll("button"));
              const btn = !isDone ? (
                allBtns.find(b => {
                  const txt = b.innerText.trim().toLowerCase();
                  return (txt.includes("input") || txt === "isi") && !b.disabled && b.offsetParent !== null;
                }) ||
                tr.querySelector("button.w-full") ||
                tr.querySelector("button.w-fill") ||
                tr.querySelector("td:last-child button") ||
                tr.querySelector("button")
              ) : null;
              const hasInputBtn = !isDone && !!btn;

              return {
                source: "table",
                title,
                titleClean,
                isDone,
                btn: hasInputBtn ? btn : null,
                tr
              };
            }).filter(r => r.titleClean.length > 0);

            const allRows = [...gridRows, ...tableRows];
            console.log(`[Automation._processItem] Mencari baris: "${targetTitle}"`);
            console.log("[Automation._processItem] Baris tersedia:", allRows.map(r => `${r.title} (done: ${r.isDone}, hasBtn: ${!!r.btn})`));

            // 3. Pencocokan Judul yang SANGAT PRESISI:
            // Langkah A: Exact match
            let matchedRow = allRows.find(r => r.titleClean.length > 0 && r.titleClean === targetClean);

            // Langkah B: Prefix match jika > 3 karakter
            if (!matchedRow && targetClean.length > 3) {
              matchedRow = allRows.find(r => r.titleClean.length > 3 && (r.titleClean.startsWith(targetClean) || targetClean.startsWith(r.titleClean)));
            }

            // Langkah C: Includes match jika > 5 karakter
            if (!matchedRow && targetClean.length > 5) {
              matchedRow = allRows.find(r => r.titleClean.length > 5 && (r.titleClean.includes(targetClean) || targetClean.includes(r.titleClean)));
            }

            // Langkah D: Word token match jika targetClean memiliki kata kunci
            if (!matchedRow) {
              const targetTokens = targetClean.split(/\s+/).filter(t => t.length > 3);
              if (targetTokens.length > 0) {
                matchedRow = allRows.find(r => r.titleClean.length > 3 && targetTokens.every(tok => r.titleClean.includes(tok)));
              }
            }

            if (!matchedRow) {
              console.warn(`[Automation] Baris "${targetTitle}" tidak ditemukan di halaman.`);
              return "no-row";
            }

            console.log(`[Automation] Baris terpilih untuk "${targetTitle}": "${matchedRow.title}" | Status selesai: ${matchedRow.isDone}`);

            // 4. JIKA BARIS INI SUDAH BENAR-BENAR SELESAI, JANGAN PERNAH DIKLIK ATAU DIPERIKSA LAGI!
            if (matchedRow.isDone) {
              console.log(`[Automation] "${matchedRow.title}" sudah berstatus SELESAI / SUDAH DIPERIKSA di web — lewati.`);
              return "already-done";
            }

            // Double check langsung teks di baris DOM
            const directRowText = (matchedRow.row?.innerText || matchedRow.tr?.innerText || "").toLowerCase();
            if (isStatusTextDone(directRowText)) {
              console.log(`[Automation] "${matchedRow.title}" terdeteksi teks status selesai di baris DOM — lewati.`);
              return "already-done";
            }

            // 5. Jika belum selesai, klik tombol input data
            if (matchedRow.btn) {
              matchedRow.btn.scrollIntoView({ block: "center", behavior: "smooth" });
              matchedRow.btn.click();
              return "clicked";
            }

            // Jika baris ini tidak memiliki tombol input aktif, berarti sudah selesai terisi / tidak memerlukan input
            console.log(`[Automation] "${matchedRow.title}" tidak memiliki tombol input aktif — dianggap sudah selesai.`);
            return "already-done";
          },
          [l]
        );
      };

      let clickRes = await findAndClickBtn();
      console.log(`[Automation] "${l}" click: ${clickRes}`);

      // Jika baris ini sudah selesai di web, jangan periksa lagi!
      if ("already-done" === clickRes) {
        console.log(`[Automation] "${l}" sudah selesai di web — lewati.`);
        return void (await this.onProgress(index, "done", l));
      }

      // 3. Jika tidak menemukan baris atau tombol, periksa apakah halaman benar-benar belum memuat baris data
      if ("no-button" === clickRes || "no-row" === clickRes) {
        const pageStatus = await n(this.tabId, () => {
          const bodyText = document.body?.innerText || "";
          const activeLoadingModal = Array.from(
            document.querySelectorAll(".fixed, .modal, [role='dialog'], .overlay, div[class*='backdrop']")
          ).some(m => m.offsetParent !== null && (m.innerText || "").includes("Memuat data"));

          const isStuckZero = bodyText.includes("Jumlah Pemeriksaan (0/0)") && bodyText.includes("(Belum Diketahui)");

          const hasInputButtons = Array.from(document.querySelectorAll("button")).some(b => {
            const txt = b.innerText.trim().toLowerCase();
            return (
              (txt.includes("input data") || txt === "input" || txt.includes("selesaikan layanan")) &&
              b.offsetParent !== null
            );
          });

          const tableRows = Array.from(document.querySelectorAll(".table-pemeriksaan-mandiri tr")).filter(
            r => r.querySelector("button") || r.querySelector("img[src*='icon-success']")
          );

          const gridBadges = Array.from(
            document.getElementsByClassName("text-[14px] px-2 font-500 border-1 border-solid border-rd-full w-[70%] h-auto")
          ).filter(el => {
            const txt = el.innerText.trim().toLowerCase();
            return txt.length > 0 && !txt.includes("memuat") && (txt.includes("selesai") || txt.includes("pemeriksaan"));
          });

          const hasReadyRows = hasInputButtons || tableRows.length > 0 || gridBadges.length > 0;
          return { activeLoadingModal, isStuckZero, hasReadyRows };
        });

        // Halaman HANYA direload jika benar-benar macet/kosong (tidak ada baris data atau ada modal loading)
        if (pageStatus.activeLoadingModal || pageStatus.isStuckZero || !pageStatus.hasReadyRows) {
          console.warn(`[Automation] "${l}" belum dapat diklik karena web belum siap. Menunggu kesiapan halaman...`);
          const recovered = await this.ensureMainPageLoaded(3, 5000);
          if (!recovered) {
            this.stop();
            throw new Error(`Web memuat lebih dari 5 detik setelah 3x refresh saat mencari "${l}". Bot dihentikan.`);
          }
          clickRes = await findAndClickBtn();
          console.log(`[Automation] "${l}" click setelah reload recover: ${clickRes}`);
        }
      }

      if ("no-button" === clickRes || "no-row" === clickRes) {
        console.warn(`[Automation] Baris "${l}" tidak ditemukan atau tidak memiliki tombol input (${clickRes}), lewati.`);
        return void (await this.onProgress(index, "done", l));
      }

      if ("clicked" !== clickRes) {
        throw new Error(`Button not found (${clickRes})`);
      }

      // 4. Konfirmasi modal tanggal pemeriksaan jika muncul
      for (let w = 0; w < 20; w++) {
        const modalRes = await n(this.tabId, () => {
          const b = Array.from(document.querySelectorAll("button")).find(b => {
            const txt = b.innerText.trim();
            return (
              txt === "Simpan" ||
              txt === "Konfirmasi" ||
              txt === "Lanjut" ||
              txt === "Simpan & Lanjutkan" ||
              txt === "Ya"
            );
          });
          if (b) {
            const m =
              b.closest(".modal,.fixed,[role='dialog'],.overlay,div[class*='modal'],div[class*='dialog'],div[class*='popup']") ||
              b.closest("div");
            if (
              m &&
              (m.innerText.includes("Tanggal") ||
                m.innerText.includes("tanggal") ||
                m.innerText.includes("pemeriksaan") ||
                m.innerText.includes("Konfirmasi") ||
                b.innerText.trim() === "Simpan")
            ) {
              b.click();
              return "clicked";
            }
          }
          return window.location.href.includes("form.kemkes.go.id") ||
            document.querySelector(".sd-body") ||
            document.querySelector(".sd-element--with-frame")
            ? "already-navigated"
            : null;
        });

        if ("clicked" === modalRes) {
          console.log("[Automation] Clicked Simpan on date confirmation modal");
          break;
        }
        if ("already-navigated" === modalRes) break;
        await t(400);
      }

      await o(this.tabId, url => url.includes("form.kemkes.go.id"), 20000);

      // 5. Menunggu form SurveyJS termuat dengan fitur retry reload max 3x (tunggu 5 detik per percobaan).
      // Jika error 429 Too Many Requests / 403 / server error, ditangani dengan jeda pendinginan server.
      const formReady = await this.ensureFormPageLoaded(l, 3, 5000);
      if (!formReady || this._stopped) {
        throw new Error(`Form "${l}" tidak termuat setelah retry refresh (kemungkinan 429 Too Many Requests / jaringan).`);
      }

      await t(300);

      // 6. Isi form
      if (l.includes("Tingkat Aktivitas Fisik")) {
        await this._clickAktivitasDropdowns();
        await t(600);
        await this._clickAktivitasDropdowns();
        await t(600);
        await this._fillTingkatAktivitasFisik();
      } else {
        await this._fillByLabels(this.fieldRules);
      }

      await t(300);

      await n(this.tabId, () => {
        const inputs = Array.from(document.querySelectorAll("input.sd-input"));
        console.log(
          "[post-fill] input states:",
          inputs.map(e => ({ type: e.type, value: e.value, valueAsNumber: e.valueAsNumber, id: e.id }))
        );
      });

      // 7. Submit form
      await n(this.tabId, () => {
        window.__ckgSubmitResult = void 0;
        const origFetch = window.fetch;
        window.__ckgRestoreFetch = () => {
          window.fetch = origFetch;
        };
        window.fetch = async function (...args) {
          const url = typeof args[0] === "string" ? args[0] : args[0]?.url ?? "";
          try {
            const resp = await origFetch.apply(this, args);
            if (/submit/i.test(url) && /skrining|form/i.test(url)) {
              window.__ckgSubmitResult = resp.status;
            }
            return resp;
          } catch (err) {
            if (/submit/i.test(url) && /skrining|form/i.test(url)) {
              window.__ckgSubmitResult = 0;
            }
            throw err;
          }
        };

        const expandable = document.querySelector(".sv-components-column.sv-components-column--expandable");
        expandable?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
        expandable?.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
        expandable?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

        const completeBtn =
          document.querySelector(".sd-navigation__complete-btn") ||
          Array.from(document.querySelectorAll("button")).find(e => "Kirim" === e.innerText.trim());
        completeBtn?.click();
      });

      const maxWaitSubmit = 20000;
      const endSubmitWait = Date.now() + maxWaitSubmit;
      let submitSuccess = false;

      while (Date.now() < endSubmitWait) {
        const check = await n(this.tabId, () => ({
          back: Array.from(document.querySelectorAll("button")).some(e => "Kembali ke Halaman Utama" === e.innerText.trim()),
          submitStatus: window.__ckgSubmitResult
        }));

        if (check.back) {
          submitSuccess = true;
          break;
        }

        if (void 0 !== check.submitStatus && check.submitStatus !== 200 && check.submitStatus !== 201) {
          throw new Error(`Submit gagal — server merespons ${check.submitStatus || "network error"}`);
        }
        await t(300);
      }

      await n(this.tabId, () => {
        window.__ckgRestoreFetch?.();
      }).catch(() => {});

      if (!submitSuccess) {
        throw new Error('Submit tidak terkonfirmasi (tombol "Kembali ke Halaman Utama" tidak muncul) — server tidak merespons');
      }

      r = true;

      // 8. Klik Kembali ke Halaman Utama
      await n(this.tabId, () => {
        const backBtn = Array.from(document.querySelectorAll("button")).find(e => "Kembali ke Halaman Utama" === e.innerText.trim());
        backBtn?.click();
      });

      await o(this.tabId, e => e.includes("sehatindonesiaku.kemkes.go.id"));

      // 9. Pastikan halaman Sehat Indonesiaku memuat kembali data dengan retry 3x reload jika stuck / memuat lama
      const mainReadyAfterReturn = await this.ensureMainPageLoaded(3, 5000);
      if (!mainReadyAfterReturn) {
        this.stop();
        throw new Error("Web memuat lebih dari 5 detik setelah 3x refresh saat kembali dari form. Bot dihentikan.");
      }

      // Jeda dinamis agar tidak memicu 429 Too Many Requests pada server Kemkes
      const safeDelay = this.rateLimited ? Math.max(this.delay, 3000) : Math.max(this.delay, 1800);
      console.log(`[Automation] Menunggu jeda ${safeDelay}ms sebelum item berikutnya...`);
      await t(safeDelay);
      this._itemsCache = null;
      await this.onProgress(index, "done", l);
    } catch (err) {
      console.error(`[Automation] Error "${l}":`, err);

      if (
        err.message?.includes("No tab with id") ||
        err.message?.includes("lebih dari 5 detik setelah 3x refresh saat kembali") ||
        err.message?.includes("Web memuat lebih dari 5 detik setelah 3x refresh. Bot dihentikan.")
      ) {
        console.warn("[Automation] Stopping automation loop due to fatal error:", err.message);
        this.stop();
        this._stopped = true;
      }

      await n(this.tabId, () => {
        window.__ckgRestoreFetch?.();
      }).catch(() => {});

      try {
        const curTab = await chrome.tabs.get(this.tabId).catch(() => null);
        if (curTab?.url?.includes("form.kemkes.go.id")) {
          const backUrl = this.lastMainUrl || "https://sehatindonesiaku.kemkes.go.id/ckg-pelayanan/detail-pemeriksaan";
          console.log("[Automation] Tab masih di form.kemkes.go.id setelah error. Navigasi kembali ke halaman utama...");
          await chrome.tabs.update(this.tabId, { url: backUrl }).catch(() => {});
          await o(this.tabId, url => url.includes("sehatindonesiaku.kemkes.go.id"), 20000).catch(() => {});
          await this.ensureMainPageLoaded(3, 5000);
          await t(1000);
        }

        // Auto-cleanup any duplicate / stray 429 tabs that opened during automation
        const allOpenTabs = await chrome.tabs.query({}).catch(() => []);
        for (const t of allOpenTabs) {
          if (t.id !== this.tabId) {
            const tTitle = (t.title || "").toLowerCase();
            const tUrl = (t.url || "").toLowerCase();
            if (tTitle === "429" || tTitle.includes("429") || (tUrl.includes("form.kemkes.go.id") && tTitle.includes("429"))) {
              await chrome.tabs.remove(t.id).catch(() => {});
            }
          }
        }
      } catch (navErr) {}

      this._itemsCache = null;
      await this.onProgress(index, r ? "done" : "error", l, r ? void 0 : err.message);
      if (!r) this.failedItems.push({ title: l, error: err.message });
    }
  }

  async _clickAktivitasDropdowns() {
    await n(this.tabId, () => {
      Array.from(document.querySelectorAll(".sd-dropdown__filter-string-input")).forEach(e => {
        e.click();
        const wrapper = e.closest(".sv-dropdown_select-wrapper");
        const option = wrapper?.querySelector("[role='option']");
        option?.click();
      });
    });
  }

  async _fillTingkatAktivitasFisik() {
    await n(this.tabId, async () => {
      const delay = ms =>
        new Promise(resolve => {
          const start = performance.now();
          const channel = new MessageChannel();
          channel.port1.onmessage = () => {
            if (performance.now() - start >= ms) resolve();
            else channel.port2.postMessage(null);
          };
          channel.port2.postMessage(null);
        });

      console.log("[aktivitas] Starting — handling radio buttons first");
      const frames = Array.from(document.querySelectorAll(".sd-element--with-frame"));
      let radioCount = 0;
      for (const q of frames) {
        const radio = q.querySelector('input[type="radio"].sd-radio__control, .sd-radio__control');
        if (!radio) continue;
        const spans = Array.from(q.querySelectorAll(".sd-item__control-label > span"));
        const tidakOpt = spans.find(x => x.innerText.trim() === "Tidak");
        if (tidakOpt) {
          tidakOpt.closest(".sd-item__control-label")?.click();
          radioCount++;
          console.log("[aktivitas] clicked Tidak for radio question #" + radioCount);
        } else {
          console.log("[aktivitas] no 'Tidak' option found, available:", spans.map(x => x.innerText.trim()));
        }
        await delay(150);
      }
      console.log("[aktivitas] Radio buttons handled:", radioCount, "questions answered");
      await delay(300);

      const valSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;

      const setViaModel = (inputEl, val) => {
        const survey =
          (el => {
            let cur = el;
            for (let i = 0; i < 25 && cur; i++) {
              const comp = cur.__vueParentComponent ?? cur.__vue__;
              if (comp) {
                const state = comp.setupState ?? comp.ctx ?? comp;
                if (state?.survey?.getQuestionByName) return state.survey;
                if (state?.question?.survey?.getQuestionByName) return state.question.survey;
                if (state?.question?.getType && state?.question?.survey?.getQuestionByName) return state.question.survey;
                let parent = comp.parent ?? comp.$parent;
                for (let j = 0; j < 20 && parent; j++) {
                  const pState = parent.setupState ?? parent.ctx ?? parent;
                  if (pState?.survey?.getQuestionByName) return pState.survey;
                  parent = parent.parent ?? parent.$parent;
                }
              }
              cur = cur.parentElement;
            }
            return null;
          })(inputEl) ??
          (() => {
            for (const k of Object.keys(window)) {
              try {
                if (window[k]?.getQuestionByName && window[k]?.getAllQuestions) return window[k];
              } catch (e) {}
            }
            return null;
          })();

        if (!survey) return console.log("[aktivitas] survey model NOT found from input"), false;

        const dataName = inputEl.closest("[data-name]")?.dataset?.name;
        const candidates = [];
        if (dataName) {
          candidates.push(dataName.replace(/\|[^|]+$/, ""));
          candidates.push(dataName);
          candidates.push(dataName.split("|").pop());
        }

        let q = null;
        for (const c of candidates) {
          q = survey.getQuestionByName(c);
          if (q) break;
        }

        if (!q && survey.getAllQuestions) {
          q =
            survey.getAllQuestions().find(t => {
              try {
                return inputEl.closest(`[data-name^="${t.name}"]`) || inputEl.closest(`[data-name="${t.name}"]`);
              } catch (e) {
                return false;
              }
            }) ?? null;
        }

        console.log("[aktivitas] dataName:", dataName, "| question found:", !!q, "| qName:", q?.name);
        if (q) {
          q.value = val;
          if (valSetter) valSetter.call(inputEl, String(val));
          return true;
        }
        return false;
      };

      const blurInput = el => {
        el.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", code: "Tab", keyCode: 9, which: 9, bubbles: true, cancelable: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        el.dispatchEvent(new FocusEvent("focusout", { bubbles: true, cancelable: true }));
        el.dispatchEvent(new FocusEvent("blur", { bubbles: false }));
        el.dispatchEvent(new KeyboardEvent("keyup", { key: "Tab", code: "Tab", keyCode: 9, which: 9, bubbles: true, cancelable: true }));
      };

      const setNumericInput = async (inputEl, val) => {
        const numVal = parseFloat(String(val));
        const strVal = String(val);
        if (setViaModel(inputEl, numVal)) {
          await delay(50);
          blurInput(inputEl);
          return void (await delay(80));
        }

        console.log("[aktivitas] falling back to DOM typing for input");
        inputEl.focus();
        await delay(50);
        if (valSetter) valSetter.call(inputEl, strVal);
        else inputEl.value = strVal;

        inputEl.dispatchEvent(new InputEvent("input", { bubbles: true, cancelable: true, inputType: "insertText", data: strVal }));
        await delay(50);
        blurInput(inputEl);
        await delay(150);
        console.log("[aktivitas] after DOM fallback — input.value:", inputEl.value);
      };

      const fillByText = async (keyword, val) => {
        const normKey = keyword.toLowerCase().replace(/\s+/g, " ");
        const targets = Array.from(document.querySelectorAll(".sd-element--with-frame"))
          .map(frame => {
            const title =
              frame.querySelector(".sv-title-actions span.sv-string-viewer.sv-string-viewer--multiline") ||
              frame.querySelector(".sd-question__title span.sv-string-viewer") ||
              frame.querySelector("h5 span.sv-string-viewer");
            if (!title) return null;
            return title.innerText.trim().toLowerCase().replace(/\s+/g, " ").includes(normKey)
              ? frame.querySelector("input.sd-input")
              : null;
          })
          .filter(Boolean);

        console.log("[aktivitas] keyword:", keyword, "| inputs found:", targets.length);
        for (const el of targets) {
          await setNumericInput(el, val);
        }
      };

      const numericInputs = Array.from(document.querySelectorAll("input.sd-input")).filter(
        e => "number" === e.type || "text" === e.type || "numeric" === e.inputMode
      );

      if (numericInputs.length > 0) {
        console.log("[aktivitas] Found", numericInputs.length, "numeric inputs — filling them");
        const randDays = Math.floor(5 * Math.random()) + 1;
        const randMinutes = Math.floor(21 * Math.random()) + 10;
        await fillByText("Berapa hari dalam satu minggu Anda melakukan aktivitas tersebut?", randDays);
        await fillByText("Dalam satu hari berapa menit waktu yang digunakan untuk melakukan aktivitas tersebut", randMinutes);
        await fillByText("berapa hari Anda aktif  secara  fisik  dalam  waktu  total selama  minimal  60  menit  sehari", Math.floor(5 * Math.random()) + 3);
        await fillByText("berapa hari Anda aktif secara fisik dalam waktu total selama minimal 60 menit sehari", Math.floor(5 * Math.random()) + 3);
      }

      const allInputs = Array.from(document.querySelectorAll("input.sd-input")).filter(
        e => "number" === e.type || "text" === e.type || "numeric" === e.inputMode
      );
      console.log("[aktivitas] commit sweep over", allInputs.length, "inputs");
      for (let i = 0; i < allInputs.length; i++) {
        const cur = allInputs[i];
        const next = allInputs[i + 1] ?? null;
        cur.focus();
        await delay(40);
        cur.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", code: "Tab", keyCode: 9, which: 9, bubbles: true, cancelable: true }));
        cur.dispatchEvent(new Event("change", { bubbles: true }));
        cur.dispatchEvent(new FocusEvent("focusout", { bubbles: true, cancelable: true, relatedTarget: next }));
        cur.dispatchEvent(new FocusEvent("blur", { bubbles: false, relatedTarget: next }));
        if (next) next.focus();
        else cur.blur();
        await delay(60);
      }

      const expandable = document.querySelector(".sv-components-column.sv-components-column--expandable");
      if (expandable) {
        expandable.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
        expandable.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
        expandable.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      }
      await delay(150);
    });
  }

  async _fillByLabels(rules) {
    await n(
      this.tabId,
      async rulesList => {
        console.log("[fillByLabels] rules received (" + rulesList.length + "):", rulesList.map(e => `${e.keyword} (${e.type})`));

        const delay = ms =>
          new Promise(resolve => {
            const start = performance.now();
            const channel = new MessageChannel();
            channel.port1.onmessage = () => {
              if (performance.now() - start >= ms) resolve();
              else channel.port2.postMessage(null);
            };
            channel.port2.postMessage(null);
          });

        const surveyModel = (() => {
          let el = document.querySelector("[data-name]") || document.querySelector('[data-rendered="r"]');
          for (let i = 0; i < 25 && el; i++) {
            const comp = el.__vueParentComponent ?? el.__vue__;
            if (comp) {
              const state = comp.setupState ?? comp.ctx ?? comp;
              if (state?.survey?.getQuestionByName) return state.survey;
              if (state?.question?.survey?.getQuestionByName) return state.question.survey;
              let parent = comp.parent ?? comp.$parent;
              for (let j = 0; j < 20 && parent; j++) {
                const pState = parent.setupState ?? parent.ctx ?? parent;
                if (pState?.survey?.getQuestionByName) return pState.survey;
                parent = parent.parent ?? parent.$parent;
              }
            }
            el = el.parentElement;
          }
          for (const k of Object.keys(window)) {
            try {
              if (window[k]?.getQuestionByName) return window[k];
            } catch (e) {}
          }
          return null;
        })();

        console.log("[fillByLabels] survey model found:", !!surveyModel);

        const setViaSurveyModel = (inputEl, val) => {
          const dataName = inputEl.closest("[data-name]")?.dataset?.name;
          if (!dataName || !surveyModel) return false;
          const cleanName = dataName.replace(/\|[^|]+$/, "");
          const q = surveyModel.getQuestionByName(cleanName) || surveyModel.getQuestionByName(dataName);
          if (q) {
            q.value = val;
            console.log("[input] set via SurveyJS model | qName:", cleanName, "| value:", q.value);
            return true;
          }
          console.log("[input] model question not found for:", cleanName);
          return false;
        };

        const blurInput = (el, next = null) => {
          el.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", code: "Tab", keyCode: 9, which: 9, bubbles: true, cancelable: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
          el.dispatchEvent(new FocusEvent("focusout", { bubbles: true, cancelable: true, relatedTarget: next }));
          el.dispatchEvent(new FocusEvent("blur", { bubbles: false, relatedTarget: next }));
          el.dispatchEvent(new KeyboardEvent("keyup", { key: "Tab", code: "Tab", keyCode: 9, which: 9, bubbles: true, cancelable: true }));
        };

        const getPanels = () => {
          let panels = Array.from(
            document.querySelectorAll(
              ".sd-element--with-frame, .sd-question, [data-name], .sd-row__question, .sv-question, .sd-element"
            )
          );

          if (!panels.length) {
            panels = Array.from(document.querySelectorAll("h5, .sd-title, .sd-question__title"))
              .map(t => t.closest(".sd-element, .sd-question, div[class*='question'], div[class*='element']") || t.parentElement)
              .filter(Boolean);
          }

          // Filter agar hanya panel terluar dan memiliki judul / input
          return panels.filter((p, idx, arr) => {
            const hasTitle = !!p.querySelector(".sd-title, .sd-question__title, h5, .sv-title-actions, .sd-item");
            const hasControls = !!p.querySelector("input, select, textarea, .sd-selectbase, .sd-dropdown, .sd-radio");
            const isNested = arr.some(
              other =>
                other !== p &&
                other.contains(p) &&
                (other.classList.contains("sd-question") || other.hasAttribute("data-name"))
            );
            return (hasTitle || hasControls) && !isNested;
          });
        };

        const findAndSelectRadio = async (panel, candidates = null) => {
          const clean = s => (s || "").trim().toLowerCase().replace(/\s+/g, " ");
          const candList = candidates
            ? (Array.isArray(candidates) ? candidates : [candidates]).map(clean)
            : ["tidak", "tidak ada", "negatif", "non reaktif", "non-reaktif", "normal", "non disabilitas", "mandiri", "sudah"];

          const inputs = Array.from(panel.querySelectorAll("input[type='radio']"));
          const items = Array.from(
            panel.querySelectorAll(
              ".sd-selectbase__item, .sd-item, .sd-radio, label.sd-selectbase__label, .sd-item__control-label"
            )
          );

          let targetInput = null;
          let targetItem = null;

          for (const cand of candList) {
            for (const inp of inputs) {
              const lbl = inp.closest("label") || inp.parentElement;
              const lblText = clean(lbl?.innerText || lbl?.textContent || "");
              const valText = clean(inp.value || "");
              if (lblText === cand || lblText.includes(cand) || valText === cand) {
                targetInput = inp;
                targetItem = lbl;
                break;
              }
            }
            if (targetInput) break;

            for (const it of items) {
              const txt = clean(it.innerText || it.textContent || "");
              if (txt === cand || txt.includes(cand)) {
                targetItem = it;
                targetInput = it.querySelector("input[type='radio']") || it.closest("label")?.querySelector("input[type='radio']");
                break;
              }
            }
            if (targetItem) break;
          }

          if (!targetInput && !targetItem && inputs.length > 0) {
            targetInput = inputs.length > 1 ? inputs[1] : inputs[0];
            targetItem = targetInput.closest("label") || targetInput.parentElement;
          }

          if (targetItem || targetInput) {
            if (targetItem) {
              targetItem.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
              targetItem.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
              targetItem.click();
            }

            if (targetInput) {
              targetInput.checked = true;
              targetInput.click();
              targetInput.dispatchEvent(new Event("input", { bubbles: true }));
              targetInput.dispatchEvent(new Event("change", { bubbles: true }));
            }

            const dataName = panel.closest("[data-name]")?.dataset?.name || panel.dataset?.name;
            if (dataName && surveyModel) {
              const cleanName = dataName.replace(/\|[^|]+$/, "");
              const q = surveyModel.getQuestionByName(cleanName) || surveyModel.getQuestionByName(dataName);
              if (q) {
                const finalVal = targetInput?.value || (candidates ? candidates[0] : "tidak");
                q.value = finalVal;
                console.log("[fillByLabels] radio synced to SurveyJS model:", cleanName, "=", q.value);
              }
            }
            return true;
          }
          return false;
        };

        const sortedRules = [...rulesList].sort((a, b) => b.keyword.length - a.keyword.length);
        const processedPanels = new WeakSet();
        let changed = false;

        do {
          changed = false;
          const frames = getPanels();

          for (const panel of frames) {
            if (processedPanels.has(panel)) continue;
            processedPanels.add(panel);
            changed = true;

            const titleEl =
              panel.querySelector(".sv-title-actions span.sv-string-viewer.sv-string-viewer--multiline") ||
              panel.querySelector(".sd-question__title span.sv-string-viewer") ||
              panel.querySelector("h5 span.sv-string-viewer") ||
              panel.querySelector(".sd-question__title") ||
              panel.querySelector(".sd-title") ||
              panel.querySelector("h5");

            const rawTitle = (titleEl?.innerText || panel.innerText.split("\n")[0] || "").trim();
            const hasRadio = !!panel.querySelector('input[type="radio"], .sd-radio, .sd-selectbase__item, [role="radiogroup"], [role="radio"]');
            const hasDropdown = !!panel.querySelector(".sd-dropdown, select");
            const normTitle = rawTitle.toLowerCase().replace(/\s+/g, " ");

            let matchedRule = sortedRules.find(r => normTitle.includes(r.keyword.toLowerCase().replace(/\s+/g, " ")));

            if (matchedRule && matchedRule.type === "radio" && !hasRadio) {
              console.log("[fillByLabels] type mismatch — rule is radio but panel has no radio, discarding rule:", rawTitle);
              matchedRule = null;
            }
            if (matchedRule && matchedRule.type === "dropdown" && !hasDropdown) {
              console.log("[fillByLabels] type mismatch — rule is dropdown but panel has no dropdown, discarding rule:", rawTitle);
              matchedRule = null;
            }

            console.log(
              "[fillByLabels] scanning panel:",
              rawTitle,
              "| matched rule:",
              matchedRule ? `${matchedRule.keyword} (${matchedRule.type})` : (hasRadio ? "none (→ Auto Normal/Tidak)" : "none")
            );

            if (matchedRule) {
              if (matchedRule.type === "radio") {
                const candidates = (Array.isArray(matchedRule.labels) ? matchedRule.labels : [matchedRule.label]).filter(Boolean);
                await findAndSelectRadio(panel, candidates);
              } else if (matchedRule.type === "dropdown") {
                const dropEl = panel.querySelector(".sd-dropdown");
                if (dropEl) {
                  dropEl.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
                  dropEl.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
                  dropEl.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
                  dropEl.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
                  await delay(600);

                  const norm = s => s.trim().toLowerCase();
                  let options = Array.from(panel.querySelectorAll("[role='option']"));
                  if (!options.length) {
                    options = Array.from(document.querySelectorAll("[role='option']"));
                  }

                  const matchedOpt = options.find(el => norm(el.textContent) === norm(matchedRule.label));
                  if (matchedOpt) {
                    const clickTarget = matchedOpt.querySelector(".sv-list__item-body") ?? matchedOpt;
                    clickTarget.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
                    clickTarget.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
                    clickTarget.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
                    clickTarget.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
                  } else {
                    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
                  }
                  await delay(500);
                }
              } else if (matchedRule.type === "input") {
                const inputEl = panel.querySelector("input.sd-input") || panel.querySelector("input:not([type='radio']):not([type='checkbox'])");
                if (inputEl) {
                  const numVal = parseFloat(String(matchedRule.value));
                  const strVal = String(matchedRule.value);
                  const valSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;

                  if (setViaSurveyModel(inputEl, numVal)) {
                    if (valSetter) valSetter.call(inputEl, strVal);
                    await delay(50);
                    blurInput(inputEl);
                    await delay(80);
                  } else {
                    inputEl.focus();
                    await delay(50);
                    if (valSetter) valSetter.call(inputEl, strVal);
                    else inputEl.value = strVal;
                    inputEl.dispatchEvent(new Event("input", { bubbles: true, cancelable: true }));
                    await delay(80);
                    if (valSetter) valSetter.call(inputEl, strVal);
                    else inputEl.value = strVal;
                    blurInput(inputEl);
                    await delay(150);
                  }
                }
              }
            } else {
              // Unmatched panel
              if (hasDropdown) {
                console.warn("[fillByLabels] UNMATCHED DROPDOWN — no rule found, left empty:", rawTitle);
              } else if (hasRadio) {
                console.log("[fillByLabels] Unmatched radio -> Auto fill Normal/Tidak for:", rawTitle);
                await findAndSelectRadio(panel, null);
              }
              await delay(100);
            }
            await delay(150);
          }

          if (changed) await delay(150);
        } while (changed);

        const allNumeric = Array.from(document.querySelectorAll("input.sd-input")).filter(
          e => "number" === e.type || "text" === e.type || "numeric" === e.inputMode
        );
        console.log("[fillByLabels] commit sweep over", allNumeric.length, "inputs");
        for (let i = 0; i < allNumeric.length; i++) {
          const cur = allNumeric[i];
          const next = allNumeric[i + 1] ?? null;
          if (cur.value) {
            cur.focus();
            await delay(40);
            blurInput(cur, next);
            if (next) next.focus();
            else cur.blur();
            await delay(60);
          }
        }

        const expandable = document.querySelector(".sv-components-column.sv-components-column--expandable");
        if (expandable) {
          expandable.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
          expandable.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
          expandable.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
        }
        await delay(150);
      },
      [rules]
    );
  }
}