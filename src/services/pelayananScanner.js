/**
 * pelayananScanner.js
 * Modul untuk melakukan scanning daftar pasien di halaman ASIK CKG Pelayanan
 * (https://sehatindonesiaku.kemkes.go.id/ckg-pelayanan) dan orkestrasi otomasi.
 */

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Memeriksa apakah tab sedang berada di halaman CKG Pelayanan
 */
export async function isCkgPelayananPage(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    return !!(tab?.url && tab.url.includes("sehatindonesiaku.kemkes.go.id/ckg-pelayanan"));
  } catch {
    return false;
  }
}

/**
 * Memindai seluruh pasien dari tab Belum Pemeriksaan & Sedang Pemeriksaan di halaman web ASIK
 * @param {number} tabId
 * @param {object} options { scanBelum: true, scanSedang: true, scanAllPages: true }
 * @param {function} onProgress
 */
export async function scanPelayananTable(tabId, options = {}, onProgress = () => {}) {
  const { scanBelum = true, scanSedang = true, scanAllPages = true } = options;

  if (!tabId) throw new Error("Tab CKG tidak ditemukan. Pastikan tab Kemkes terbuka.");

  let tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab?.url || !tab.url.includes("sehatindonesiaku.kemkes.go.id")) {
    throw new Error("Tab aktif bukan situs SehatIndonesiaKu Kemkes.");
  }

  // Jika tab ASIK berada di halaman lain (misal pendaftaran atau home), arahkan otomatis ke ckg-pelayanan
  if (!tab.url.includes("ckg-pelayanan")) {
    onProgress({ step: "navigating", message: "Membuka halaman CKG Pelayanan di web ASIK..." });
    await chrome.tabs.update(tabId, { url: "https://sehatindonesiaku.kemkes.go.id/ckg-pelayanan" });
    await new Promise(resolve => {
      const listener = (tid, changeInfo) => {
        if (tid === tabId && changeInfo.status === "complete") {
          chrome.tabs.onUpdated.removeListener(listener);
          resolve();
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
      setTimeout(() => { chrome.tabs.onUpdated.removeListener(listener); resolve(); }, 12000);
    });
    await sleep(1500);
  }

  const collectedPatients = [];
  const seenTickets = new Set();

  // Helper untuk switch tab & scan halaman
  const scanTabCategory = async (tabName) => {
    onProgress({ step: "switch_tab", message: `Membuka tab "${tabName}"...` });

    // 1. Cek atau Klik tab di web ASIK (pastikan TIDAK mengklik badge status di dalam table)
    const [tabSelectRes] = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      args: [tabName],
      func: (targetTabName) => {
        const clean = s => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
        const target = clean(targetTabName); // e.g. "belum pemeriksaan"

        // Helper untuk cek apakah sebuah elemen adalah elemen tab navigation
        const isTabNavElement = (el) => {
          if (!el) return false;
          // PASTIKAN BUKAN DI DALAM TABLE (karena setiap row tabel ada status "Belum Pemeriksaan")
          if (el.closest('table') || el.closest('tbody') || el.closest('thead')) return false;
          // Abaikan modal / popup
          if (el.closest('.modal, [role="dialog"], .swal2-container')) return false;

          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0 || r.top > 500) return false;

          const txt = clean(el.innerText || el.textContent || '');
          if (!txt.includes(target)) return false;

          // Jangan sampai mencakup tab tetangga (misal container induk)
          const otherTabs = ['belum pemeriksaan', 'sedang pemeriksaan', 'selesai pemeriksaan'].filter(t => t !== target);
          if (otherTabs.some(other => txt.includes(other))) return false;

          return true;
        };

        const allCandidates = Array.from(document.querySelectorAll('button, a, [role="tab"], div, li, span'))
          .filter(isTabNavElement);

        if (allCandidates.length === 0) {
          return { ok: false, error: "Tab navigation element tidak ditemukan" };
        }

        // Cari yang clickable
        const clickableCandidates = allCandidates.filter(el => {
          const isButtonOrTab = el.tagName === 'BUTTON' || el.tagName === 'A' || el.getAttribute('role') === 'tab';
          const hasPointer = el.classList.contains('cursor-pointer') || window.getComputedStyle(el).cursor === 'pointer';
          return isButtonOrTab || hasPointer;
        });

        const list = clickableCandidates.length > 0 ? clickableCandidates : allCandidates;
        list.sort((a, b) => (a.innerText || a.textContent || '').trim().length - (b.innerText || b.textContent || '').trim().length);
        const bestTab = list[0];

        // Ambil jumlah data dari teks tab (misal "Belum Pemeriksaan 460" -> 460)
        const tabRawText = bestTab.innerText || bestTab.textContent || '';
        const countMatch = tabRawText.match(/(\d+[\d.,]*)/);
        const tabCount = countMatch ? parseInt(countMatch[1].replace(/[.,]/g, ''), 10) : null;

        // Cek apakah tab ini SUDAH AKTIF
        // Tab aktif biasanya memiliki warna teal / cyan, border bottom teal, aria-selected=true, atau class active
        const classNames = (bestTab.className || '').toLowerCase();
        const parentClassNames = (bestTab.parentElement?.className || '').toLowerCase();
        const isAriaSelected = bestTab.getAttribute('aria-selected') === 'true';
        const hasActiveIndicator = classNames.includes('teal') ||
                                   classNames.includes('primary') ||
                                   classNames.includes('active') ||
                                   classNames.includes('border-b') ||
                                   parentClassNames.includes('border-b') ||
                                   isAriaSelected;

        if (hasActiveIndicator) {
          return { ok: true, alreadyActive: true, tabText: tabRawText.trim(), tabCount };
        }

        // Jika belum aktif, klik tab tersebut
        const toClick = bestTab.closest('button, a, [role="tab"]') || bestTab;
        toClick.scrollIntoView({ block: 'nearest' });
        const opts = { bubbles: true, cancelable: true, view: window };
        toClick.dispatchEvent(new MouseEvent('mousedown', opts));
        toClick.dispatchEvent(new MouseEvent('mouseup', opts));
        toClick.dispatchEvent(new MouseEvent('click', opts));
        if (typeof toClick.click === 'function') toClick.click();

        return { ok: true, clicked: true, tabText: tabRawText.trim(), tabCount };
      }
    });

    console.log(`[pelayananScanner] Tab selection:`, tabSelectRes?.result);

    onProgress({
      step: "waiting_table",
      message: `Memuat data ${tabName} dari web ASIK...`
    });

    // 2. Tunggu secara dinamis sampai baris data tabel termuat dari Kemkes API (maksimal 12 detik)
    let tableHasData = false;
    let tableIsEmpty = false;

    for (let attempt = 0; attempt < 35; attempt++) {
      await sleep(350);
      const [checkRows] = await chrome.scripting.executeScript({
        target: { tabId },
        world: "MAIN",
        func: () => {
          const tbody = document.querySelector('tbody');
          if (!tbody) return { ready: false, count: 0 };

          const rawText = (tbody.textContent || '').toLowerCase();
          const emptyState = rawText.includes('tidak ditemukan') ||
                             rawText.includes('tidak ada data') ||
                             rawText.includes('belum ada data');

          const trs = Array.from(tbody.querySelectorAll('tr')).filter(tr => {
            const tds = tr.querySelectorAll('td');
            const txt = (tr.textContent || '').toLowerCase();
            return tds.length >= 4 && !txt.includes('tidak ditemukan') && !txt.includes('tidak ada data') && !txt.includes('memuat');
          });

          return {
            ready: trs.length > 0 || emptyState,
            count: trs.length,
            isEmpty: emptyState
          };
        }
      });

      if (checkRows?.result?.ready) {
        tableHasData = (checkRows.result.count > 0);
        tableIsEmpty = !!checkRows.result.isEmpty;
        break;
      }
    }

    if (!tableHasData && tableIsEmpty) {
      console.log(`[pelayananScanner] Tab ${tabName} terkonfirmasi kosong (tidak ada data).`);
      return;
    }

    // 3. Baca informasi total pagination & jumlah data
    const tabExtractedCount = tabSelectRes?.result?.tabCount || 0;

    const [pageInfoRes] = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      args: [tabExtractedCount],
      func: (fallbackCount) => {
        let totalData = fallbackCount || 0;

        // Cari info text "Menampilkan 1-10 dari 460 data"
        const allElements = Array.from(document.querySelectorAll('div, span, p'));
        const infoEl = allElements.find(el => {
          const t = (el.innerText || '').trim();
          return /menampilkan\s+\d+\s*[-–]\s*\d+\s+dari\s+[\d.,]+\s+data/i.test(t);
        });

        if (infoEl) {
          const match = (infoEl.innerText || '').match(/dari\s+([\d.,]+)\s+data/i);
          if (match) {
            totalData = parseInt(match[1].replace(/[.,]/g, ''), 10);
          }
        }

        // Cari nomor halaman maksimal dari tombol pagination
        const pageButtons = Array.from(document.querySelectorAll('button, li, a'))
          .filter(el => {
            const t = (el.innerText || '').trim();
            const r = el.getBoundingClientRect();
            return /^\d+$/.test(t) && r.width > 0 && r.height > 0 && r.top > 200;
          })
          .map(el => parseInt(el.innerText.trim(), 10))
          .filter(n => !isNaN(n));

        const maxPage = pageButtons.length > 0
          ? Math.max(...pageButtons)
          : (totalData > 0 ? Math.ceil(totalData / 10) : 1);

        return { totalData, maxPage: Math.max(maxPage, 1) };
      }
    });

    const maxPage = scanAllPages ? (pageInfoRes?.result?.maxPage || 1) : 1;
    const totalDataExpected = pageInfoRes?.result?.totalData || tabExtractedCount || 0;

    console.log(`[pelayananScanner] Tab ${tabName} memiliki ${totalDataExpected} data (~${maxPage} halaman)`);

    // 3. Loop setiap halaman (page 1 s/d maxPage)
    for (let page = 1; page <= maxPage; page++) {
      onProgress({
        step: "scanning_page",
        message: `Memindai ${tabName} - Halaman ${page}/${maxPage} (${collectedPatients.length} pasien)...`,
        current: collectedPatients.length,
        total: totalDataExpected
      });

      // Ambil data baris tabel halaman saat ini
      const [rowsRes] = await chrome.scripting.executeScript({
        target: { tabId },
        world: "MAIN",
        args: [tabName],
        func: (currentTab) => {
          const tbody = document.querySelector('tbody');
          if (!tbody) return [];
          const trs = Array.from(tbody.querySelectorAll('tr')).filter(tr => {
            const tds = tr.querySelectorAll('td');
            const rTxt = (tr.textContent || '').toLowerCase();
            return tds.length >= 4 && !rTxt.includes('tidak ditemukan') && !rTxt.includes('tidak ada data');
          });

          const thead = document.querySelector('thead');
          // Nilai default kolom standar web ASIK Kemkes
          let colIdxNama = 1;
          let colIdxLahir = 2;
          let colIdxTiket = 3;
          let colIdxWali = 4;
          let colIdxUnit = 5;

          if (thead) {
            const ths = Array.from(thead.querySelectorAll('th'));
            ths.forEach((th, idx) => {
              const txt = (th.innerText || th.textContent || '').trim().toLowerCase();
              if (txt === 'nama' || (txt.includes('nama') && !txt.includes('wali') && !txt.includes('ibu') && !txt.includes('orang'))) {
                colIdxNama = idx;
              } else if (txt.includes('wali')) {
                colIdxWali = idx;
              } else if (txt.includes('tiket')) {
                colIdxTiket = idx;
              } else if (txt.includes('lahir') || txt.includes('tgl') || txt.includes('tanggal')) {
                colIdxLahir = idx;
              } else if (txt.includes('unit') || txt.includes('faskes') || txt.includes('puskesmas')) {
                colIdxUnit = idx;
              }
            });
          }

          return trs.map((tr, idx) => {
            const tds = Array.from(tr.querySelectorAll('td'));
            const no = (tds[0]?.innerText || '').trim();

            // Ekstraksi nama: prioritaskan colIdxNama, jika '-' atau kosong fallback ke tds[1]
            let rawNama = (tds[colIdxNama]?.innerText || '').replace(/\s+/g, ' ').trim();
            if (!rawNama || rawNama === '-' || rawNama.length <= 1) {
              rawNama = (tds[1]?.innerText || '').replace(/\s+/g, ' ').trim();
            }
            const nama = rawNama;

            const tanggalLahir = (tds[colIdxLahir]?.innerText || tds[2]?.innerText || '').replace(/\s+/g, ' ').trim();
            const nomorTiket = (tds[colIdxTiket]?.innerText || tds[3]?.innerText || '').replace(/\s+/g, ' ').trim();
            const namaWali = (tds[colIdxWali]?.innerText || tds[4]?.innerText || '').replace(/\s+/g, ' ').trim();
            const unitPelayanan = (tds[colIdxUnit]?.innerText || tds[5]?.innerText || '').replace(/\s+/g, ' ').trim();

            const actionBtn = tr.querySelector('button, a, [role="button"]');
            const hasAction = !!actionBtn;

            return {
              no,
              nama,
              tanggalLahir,
              nomorTiket,
              namaWali,
              unitPelayanan,
              hasAction,
              rowIndex: idx,
              sourceTab: currentTab
            };
          }).filter(p => p.nama && p.nama !== '-' && p.nama.length > 1);
        }
      });

      const pageRows = rowsRes?.result || [];
      let newOnThisPage = 0;
      for (const row of pageRows) {
        const uniqueKey = row.nomorTiket || `${row.nama}_${row.tanggalLahir}`;
        if (!seenTickets.has(uniqueKey)) {
          seenTickets.add(uniqueKey);
          collectedPatients.push({
            ...row,
            status: "ready",
            _status: "idle",
            id: `scan_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`
          });
          newOnThisPage++;
        }
      }

      console.log(`[pelayananScanner] Halaman ${page}/${maxPage}: Ditemukan ${pageRows.length} baris (${newOnThisPage} pasien baru). Total: ${collectedPatients.length}`);

      // Jika sudah di halaman terakhir atau hanya scan halaman pertama, keluar dari loop
      if (page >= maxPage || !scanAllPages) {
        break;
      }

      // Berpindah ke halaman berikutnya
      const nextPage = page + 1;
      onProgress({
        step: "navigating_page",
        message: `Berpindah ke halaman ${nextPage}/${maxPage}...`,
        current: collectedPatients.length,
        total: totalDataExpected
      });

      // Ambil penanda halaman sebelum klik (first ticket & info range)
      const [beforeState] = await chrome.scripting.executeScript({
        target: { tabId },
        world: "MAIN",
        func: () => {
          const firstTd = document.querySelector('tbody tr td:nth-child(4)') || document.querySelector('tbody tr td:nth-child(2)');
          const infoEl = Array.from(document.querySelectorAll('div, span, p')).find(el => {
            const t = (el.innerText || '').trim();
            return /menampilkan\s+\d+-\d+\s+dari\s+\d+\s+data/i.test(t);
          });
          return {
            firstTicket: (firstTd?.innerText || '').trim(),
            rangeText: (infoEl?.innerText || '').trim()
          };
        }
      });

      // Eksekusi klik ke halaman berikutnya
      const [clickRes] = await chrome.scripting.executeScript({
        target: { tabId },
        world: "MAIN",
        args: [nextPage],
        func: (targetNextPage) => {
          const allElements = Array.from(document.querySelectorAll('button, a, [role="button"], li')).filter(el => {
            const r = el.getBoundingClientRect();
            return r.width > 0 && r.height > 0 && r.top > 200;
          });

          const triggerClick = (el) => {
            if (!el) return false;
            el.scrollIntoView({ block: 'nearest' });
            const opts = { bubbles: true, cancelable: true, view: window };
            el.dispatchEvent(new MouseEvent('mousedown', opts));
            el.dispatchEvent(new MouseEvent('mouseup', opts));
            el.dispatchEvent(new MouseEvent('click', opts));
            if (typeof el.click === 'function') el.click();
            return true;
          };

          // 1. Coba klik langsung tombol dengan angka halaman target (misal "2")
          const targetNumBtn = allElements.find(el => {
            const t = (el.innerText || el.textContent || '').trim();
            return t === String(targetNextPage);
          });

          if (targetNumBtn) {
            const clickable = targetNumBtn.tagName === 'BUTTON' || targetNumBtn.tagName === 'A' ? targetNumBtn : (targetNumBtn.querySelector('button, a') || targetNumBtn);
            triggerClick(clickable);
            return { clicked: true, method: "number", target: targetNextPage };
          }

          // 2. Jika tidak ada angka target (misal angka 4 atau 5 dalam ellipsis), klik tombol Next (>)
          let nextBtn = allElements.find(el => {
            const t = (el.innerText || el.textContent || '').trim();
            const aria = (el.getAttribute('aria-label') || '').toLowerCase();
            const title = (el.getAttribute('title') || '').toLowerCase();
            return t === '>' || t === '›' || t === '»' || aria.includes('next') || aria.includes('berikut') || title.includes('next') || title.includes('berikut');
          });

          // Fallback: cari dari tombol di sebelah kanan angka-angka pagination
          if (!nextBtn) {
            const numBtns = allElements.filter(el => /^\d+$/.test((el.innerText || el.textContent || '').trim()));
            if (numBtns.length > 0) {
              const lastNum = numBtns[numBtns.length - 1];
              const lr = lastNum.getBoundingClientRect();
              const rightCandidates = allElements.filter(el => {
                const r = el.getBoundingClientRect();
                return r.left >= lr.right - 2 && Math.abs(r.top - lr.top) < 20;
              });
              if (rightCandidates.length > 0) {
                nextBtn = rightCandidates[rightCandidates.length - 1];
              }
            }
          }

          // Fallback kedua: cari button yang punya svg di kanan
          if (!nextBtn) {
            const svgBtns = allElements.filter(el => el.querySelector('svg') && (el.innerText || '').trim() === '');
            if (svgBtns.length >= 2) {
              nextBtn = svgBtns[svgBtns.length - 1];
            } else if (svgBtns.length === 1) {
              nextBtn = svgBtns[0];
            }
          }

          if (nextBtn) {
            const clickable = nextBtn.tagName === 'BUTTON' || nextBtn.tagName === 'A' ? nextBtn : (nextBtn.querySelector('button, a') || nextBtn);
            if (clickable.disabled || clickable.classList.contains('disabled') || clickable.getAttribute('aria-disabled') === 'true') {
              return { clicked: false, isEnd: true, method: "next_disabled" };
            }
            triggerClick(clickable);
            return { clicked: true, method: "next_arrow" };
          }

          return { clicked: false, error: "Tombol navigasi halaman tidak ditemukan" };
        }
      });

      console.log(`[pelayananScanner] Klik halaman ${nextPage}:`, clickRes?.result);

      if (clickRes?.result?.isEnd) {
        console.log(`[pelayananScanner] Sudah mencapai halaman terakhir (tombol next disabled).`);
        break;
      }

      // Tunggu hingga data tabel benar-benar berubah (maksimal 4 detik)
      let pageChanged = false;
      const initialTicket = beforeState?.result?.firstTicket || "";
      const initialRange = beforeState?.result?.rangeText || "";

      for (let w = 0; w < 16; w++) {
        await sleep(250);
        const [checkState] = await chrome.scripting.executeScript({
          target: { tabId },
          world: "MAIN",
          func: () => {
            const firstTd = document.querySelector('tbody tr td:nth-child(4)') || document.querySelector('tbody tr td:nth-child(2)');
            const infoEl = Array.from(document.querySelectorAll('div, span, p')).find(el => {
              const t = (el.innerText || '').trim();
              return /menampilkan\s+\d+-\d+\s+dari\s+\d+\s+data/i.test(t);
            });
            return {
              firstTicket: (firstTd?.innerText || '').trim(),
              rangeText: (infoEl?.innerText || '').trim()
            };
          }
        });

        const curTicket = checkState?.result?.firstTicket || "";
        const curRange = checkState?.result?.rangeText || "";

        if ((curRange && curRange !== initialRange) || (curTicket && curTicket !== initialTicket)) {
          pageChanged = true;
          console.log(`[pelayananScanner] Berhasil berpindah ke halaman ${nextPage} (${curRange || curTicket})`);
          break;
        }
      }

      if (!pageChanged) {
        console.warn(`[pelayananScanner] Halaman ${nextPage} tidak berubah dalam 4 detik, mencoba klik ulang tombol next...`);
        await chrome.scripting.executeScript({
          target: { tabId },
          world: "MAIN",
          func: () => {
            const allElements = Array.from(document.querySelectorAll('button, a, [role="button"], li')).filter(el => {
              const r = el.getBoundingClientRect();
              return r.width > 0 && r.height > 0 && r.top > 200;
            });
            const nextBtn = allElements.find(el => {
              const t = (el.innerText || el.textContent || '').trim();
              const aria = (el.getAttribute('aria-label') || '').toLowerCase();
              return t === '>' || t === '›' || t === '»' || aria.includes('next') || aria.includes('berikut');
            });
            if (nextBtn) {
              const clickable = nextBtn.tagName === 'BUTTON' || nextBtn.tagName === 'A' ? nextBtn : (nextBtn.querySelector('button, a') || nextBtn);
              clickable.click();
            }
          }
        }).catch(() => {});
        await sleep(1000);
      }
    }
  };

  // Jalankan scan tab Belum Pemeriksaan
  if (scanBelum) {
    await scanTabCategory("Belum Pemeriksaan");
  }

  // Jalankan scan tab Sedang Pemeriksaan
  if (scanSedang) {
    await scanTabCategory("Sedang Pemeriksaan");
  }

  // Kembalikan ke halaman awal 1 Belum Pemeriksaan
  await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: () => {
      const allElements = Array.from(document.querySelectorAll('button, a, [role="button"], li')).filter(el => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && r.top > 200;
      });
      const page1Btn = allElements.find(el => (el.innerText || el.textContent || '').trim() === '1');
      if (page1Btn) {
        const clickable = page1Btn.tagName === 'BUTTON' || page1Btn.tagName === 'A' ? page1Btn : (page1Btn.querySelector('button, a') || page1Btn);
        clickable.click();
      }
      const firstTab = Array.from(document.querySelectorAll('button, a, [role="tab"], div, li, span'))
        .find(el => {
          if (el.closest('table') || el.closest('tbody') || el.closest('thead')) return false;
          return (el.innerText || '').toLowerCase().includes('belum pemeriksaan');
        });
      if (firstTab) firstTab.click();
    }
  }).catch(() => {});

  onProgress({
    step: "done",
    message: `Scan selesai! Ditemukan ${collectedPatients.length} pasien.`,
    total: collectedPatients.length
  });

  return collectedPatients;
}

/**
 * Mencari dan membuka baris pasien di tabel web ASIK
 * @param {number} tabId
 * @param {object} patient
 */
export async function openPatientInTable(tabId, patient) {
  // 0. Cek jika tab saat ini sudah berada di halaman detail pemeriksaan untuk pasien ini
  const [alreadyOnDetail] = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    args: [patient.nomorTiket, patient.nama],
    func: (tiket, nama) => {
      if (!location.href.includes("detail-pemeriksaan")) return false;
      const clean = s => (s || '').replace(/\s+/g, ' ').trim().toUpperCase();
      const bodyText = clean(document.body?.innerText || '');
      const cleanTiket = clean(tiket);
      const cleanNama = (nama || '').split(',')[0].replace(/\s+/g, ' ').trim().toUpperCase();

      if (cleanTiket && bodyText.includes(cleanTiket)) return true;
      if (cleanNama && bodyText.includes(cleanNama)) return true;
      return false;
    }
  });

  if (alreadyOnDetail?.result) {
    console.log(`[openPatientInTable] Tab sudah berada di halaman detail pemeriksaan untuk ${patient.nama}`);
    return true;
  }

  // 1. Pastikan tab berada di halaman ckg-pelayanan (bukan di detail)
  const [navCheck] = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: () => {
      if (!location.href.includes("ckg-pelayanan") || location.href.includes("detail-pemeriksaan")) {
        const btnBack = Array.from(document.querySelectorAll('button, a'))
          .find(b => {
            const t = (b.innerText || '').trim().toLowerCase();
            return t === 'kembali' || t.includes('kembali ke daftar') || t.includes('daftar pasien');
          });
        if (btnBack) {
          btnBack.click();
        } else {
          location.href = "https://sehatindonesiaku.kemkes.go.id/ckg-pelayanan?back=true";
        }
        return true;
      }
      return false;
    }
  });

  if (navCheck?.result) {
    // Tunggu sampai tbody termuat
    for (let i = 0; i < 20; i++) {
      await sleep(500);
      const [checkTbody] = await chrome.scripting.executeScript({
        target: { tabId },
        world: "MAIN",
        func: () => !!document.querySelector("tbody tr")
      });
      if (checkTbody?.result) break;
    }
    await sleep(800);
  }

  // 2. Klik tab sumber pasien (Belum Pemeriksaan atau Sedang Pemeriksaan)
  const targetTab = patient.sourceTab || "Belum Pemeriksaan";
  await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    args: [targetTab],
    func: (tTab) => {
      const clean = s => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
      const target = clean(tTab);
      const candidates = Array.from(document.querySelectorAll('button, a, [role="tab"], div, li, span'))
        .filter(el => {
          if (el.closest('table') || el.closest('tbody') || el.closest('thead')) return false;
          if (el.closest('.modal, [role="dialog"]')) return false;
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0 || r.top > 500) return false;
          return clean(el.textContent).includes(target);
        });
      candidates.sort((a, b) => clean(a.textContent).length - clean(b.textContent).length);
      if (candidates[0]) {
        const toClick = candidates[0].closest('button, a, [role="tab"]') || candidates[0];
        toClick.click();
      }
    }
  });

  await sleep(1000);

  // 3. Cari baris pasien berdasarkan Nomor Tiket, NIK, atau Nama
  const [clickRowRes] = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    args: [patient.nomorTiket || "", patient.nama || "", patient.nik || ""],
    func: async (tiket, nama, nik) => {
      const wait = ms => new Promise(r => setTimeout(r, ms));
      const clean = s => (s || '').replace(/\s+/g, ' ').trim().toUpperCase();
      const cleanNama = (nama || '').split(',')[0].replace(/\s+/g, ' ').trim().toUpperCase();
      const cleanTiket = clean(tiket);
      const cleanNik = String(nik || '').replace(/\D/g, '');

      const getActionBtn = (tr) => {
        const allBtns = Array.from(tr.querySelectorAll("button, a, [role='button']"));

        // 1. FILTER KELUAR SEMUA TOMBOL RAPOR / RAPORT
        const nonRaporBtns = allBtns.filter(b => {
          const txt = (b.innerText || b.textContent || "").trim().toLowerCase();
          if (txt.includes("rapor") || txt.includes("raport")) return false;

          const td = b.closest("td");
          if (td) {
            const table = td.closest("table");
            if (table) {
              const ths = Array.from(table.querySelectorAll("th"));
              const th = ths[td.cellIndex];
              const thText = (th?.innerText || th?.textContent || "").trim().toLowerCase();
              if (thText.includes("rapor") || thText.includes("raport")) return false;
            }
          }
          return true;
        });

        // 2. Prioritas 1: Tombol "Mulai" (Belum Pemeriksaan)
        const btnMulai = nonRaporBtns.find(b => {
          const txt = (b.innerText || b.textContent || "").trim().toLowerCase();
          return txt === "mulai" || txt.includes("mulai");
        });
        if (btnMulai) return btnMulai;

        // 3. Prioritas 2: Tombol "Periksa" (Sedang Pemeriksaan)
        const btnPeriksa = nonRaporBtns.find(b => {
          const txt = (b.innerText || b.textContent || "").trim().toLowerCase();
          return txt === "periksa" || txt.includes("periksa");
        });
        if (btnPeriksa) return btnPeriksa;

        // 4. Prioritas 3: Tombol di kolom Aksi (bukan Rapor)
        const btnInAksi = nonRaporBtns.find(b => {
          const td = b.closest("td");
          if (td) {
            const table = td.closest("table");
            if (table) {
              const ths = Array.from(table.querySelectorAll("th"));
              const th = ths[td.cellIndex];
              const thText = (th?.innerText || th?.textContent || "").trim().toLowerCase();
              return thText.includes("aksi") || thText.includes("tindakan");
            }
          }
          return false;
        });
        if (btnInAksi) return btnInAksi;

        // 5. Fallback ke tombol non-rapor
        if (nonRaporBtns.length > 0) return nonRaporBtns[0];

        return allBtns[0] || tr;
      };

      const findRow = () => {
        const tbody = document.querySelector('tbody');
        if (!tbody) return null;
        const trs = Array.from(tbody.querySelectorAll('tr'));
        return trs.find(tr => {
          const txt = clean(tr.textContent);
          if (cleanTiket && txt.includes(cleanTiket)) return true;
          if (cleanNama && txt.includes(cleanNama)) return true;
          return false;
        });
      };

      const matchedTr = findRow();
      if (matchedTr) {
        const btn = getActionBtn(matchedTr);
        btn.click();
        return { ok: true, method: "direct_row_click" };
      }

      // Jika belum ketemu di halaman 1, pilih filter Nomor Tiket / NIK agar bebas dari batas rentang 7 hari
      let desiredFilter = null;
      let searchTerm = cleanNama || cleanTiket;
      if (cleanTiket) {
        desiredFilter = "Nomor Tiket";
        searchTerm = cleanTiket;
      } else if (cleanNik.length >= 16) {
        desiredFilter = "NIK";
        searchTerm = cleanNik;
      }

      if (desiredFilter) {
        const trigger = Array.from(document.querySelectorAll('span.line-clamp-2'))
          .find(s => ['Nama', 'Nomor Tiket', 'NIK', 'Mitra'].includes((s.textContent || '').trim()));
        if (trigger && (trigger.textContent || '').trim() !== desiredFilter) {
          const triggerBox = trigger.closest('div.cursor-pointer, button') || trigger;
          triggerBox.click();
          await wait(300);
          const opt = Array.from(document.querySelectorAll('div.cursor-pointer, li, span'))
            .find(d => (d.textContent || '').trim() === desiredFilter && !d.closest('table') && d !== trigger && !triggerBox.contains(d) && d.offsetParent !== null);
          if (opt) {
            opt.click();
            await wait(350);
          }
        }
      }

      const allInputs = Array.from(document.querySelectorAll('input'));
      const searchInput = allInputs.find(inp => {
        const ph = (inp.placeholder || '').toLowerCase();
        const type = (inp.type || 'text').toLowerCase();
        const id = (inp.id || '').toLowerCase();
        return (type === 'text' || type === 'search') &&
               (id === 'nik' || ph.includes('tiket') || ph.includes('nik') || ph.includes('nama') || ph.includes('masukkan') || ph.includes('cari'));
      }) || document.querySelector('input[placeholder*="Masukkan"]') || document.querySelector('input[type="text"]');

      if (searchInput && searchTerm) {
        searchInput.focus();
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
        if (setter) {
          setter.call(searchInput, searchTerm);
        } else {
          searchInput.value = searchTerm;
        }
        searchInput.dispatchEvent(new Event('input', { bubbles: true }));
        searchInput.dispatchEvent(new Event('change', { bubbles: true }));
        searchInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
        searchInput.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));

        const parentForm = searchInput.closest('form, div.flex, div.grid') || searchInput.parentElement;
        const searchBtn = parentForm?.querySelector('button') || null;
        if (searchBtn) searchBtn.click();

        return { ok: true, method: "searched" };
      }

      return { ok: false, error: "Baris pasien tidak ditemukan di tabel" };
    }
  });

  if (clickRowRes?.result?.method === "searched") {
    // Tunggu hasil filter pencarian muncul di tabel secara dinamis (maksimal 5 detik)
    let searchRowFound = false;
    for (let sAttempt = 0; sAttempt < 16; sAttempt++) {
      await sleep(300);
      const [checkSearchRes] = await chrome.scripting.executeScript({
        target: { tabId },
        world: "MAIN",
        args: [patient.nomorTiket, patient.nama],
        func: (tiket, nama) => {
          const clean = s => (s || '').replace(/\s+/g, ' ').trim().toUpperCase();
          const cleanNama = (nama || '').split(',')[0].replace(/\s+/g, ' ').trim().toUpperCase();
          const cleanTiket = clean(tiket);

          const getActionBtn = (tr) => {
            const allBtns = Array.from(tr.querySelectorAll("button, a, [role='button']"));
            const nonRaporBtns = allBtns.filter(b => {
              const txt = (b.innerText || b.textContent || "").trim().toLowerCase();
              if (txt.includes("rapor") || txt.includes("raport")) return false;
              const td = b.closest("td");
              if (td) {
                const table = td.closest("table");
                if (table) {
                  const ths = Array.from(table.querySelectorAll("th"));
                  const th = ths[td.cellIndex];
                  const thText = (th?.innerText || th?.textContent || "").trim().toLowerCase();
                  if (thText.includes("rapor") || thText.includes("raport")) return false;
                }
              }
              return true;
            });

            const btnMulai = nonRaporBtns.find(b => {
              const txt = (b.innerText || b.textContent || "").trim().toLowerCase();
              return txt === "mulai" || txt.includes("mulai");
            });
            if (btnMulai) return btnMulai;

            const btnPeriksa = nonRaporBtns.find(b => {
              const txt = (b.innerText || b.textContent || "").trim().toLowerCase();
              return txt === "periksa" || txt.includes("periksa");
            });
            if (btnPeriksa) return btnPeriksa;

            const btnInAksi = nonRaporBtns.find(b => {
              const td = b.closest("td");
              if (td) {
                const table = td.closest("table");
                if (table) {
                  const ths = Array.from(table.querySelectorAll("th"));
                  const th = ths[td.cellIndex];
                  const thText = (th?.innerText || th?.textContent || "").trim().toLowerCase();
                  return thText.includes("aksi") || thText.includes("tindakan");
                }
              }
              return false;
            });
            if (btnInAksi) return btnInAksi;
            return nonRaporBtns[0] || allBtns[0] || tr;
          };

          const tbody = document.querySelector('tbody');
          if (!tbody) return { found: false };
          const trs = Array.from(tbody.querySelectorAll('tr')).filter(tr => {
            const txt = (tr.textContent || '').toLowerCase();
            return !txt.includes('tidak ditemukan') && !txt.includes('tidak ada data') && !txt.includes('memuat');
          });

          // Cocokkan pasien dengan nomor tiket atau nama (PASTIKAN TIDAK KLIK PASIEN LAIN)
          const matched = trs.find(tr => {
            const txt = clean(tr.textContent);
            return (cleanTiket && txt.includes(cleanTiket)) || (cleanNama && txt.includes(cleanNama));
          });

          if (matched) {
            const btn = getActionBtn(matched);
            btn.click();
            return { found: true };
          }
          return { found: false };
        }
      });

      if (checkSearchRes?.result?.found) {
        searchRowFound = true;
        break;
      }
    }

    if (!searchRowFound) {
      throw new Error(`Pasien ${patient.nama} (${patient.nomorTiket}) tidak ditemukan di tabel web ASIK setelah pencarian`);
    }
  }

  // 4. Tunggu halaman detail pemeriksaan termuat
  let detailLoaded = false;
  for (let i = 0; i < 20; i++) {
    await sleep(500);
    const [checkDetail] = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: () => {
        const isDetailUrl = location.href.includes("detail-pemeriksaan");
        const hasScreeningElements = !!document.querySelector("#tableLayanan") ||
                                     !!document.querySelector(".table-pemeriksaan-mandiri") ||
                                     Array.from(document.querySelectorAll("button")).some(b => (b.innerText || '').includes("Mulai Pemeriksaan"));
        return isDetailUrl || hasScreeningElements;
      }
    });
    if (checkDetail?.result) {
      detailLoaded = true;
      break;
    }
  }

  if (!detailLoaded) {
    throw new Error(`Gagal membuka halaman detail pemeriksaan untuk ${patient.nama}`);
  }

  return true;
}

/**
 * Konfirmasi tanggal pemeriksaan jika pasien baru (Belum Pemeriksaan)
 * Memilih tanggal pada kalender modal dan mengklik Simpan
 */
export async function confirmMulaiPemeriksaanIfPresent(tabId, targetAttendDate = null) {
  let d = targetAttendDate ? new Date(targetAttendDate) : new Date();
  if (isNaN(d.getTime())) d = new Date();
  const tahun = d.getFullYear();
  const bulan = d.getMonth() + 1;
  const hari = d.getDate();

  const [res] = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    args: [tahun, bulan, hari],
    func: async (thn, bln, tgl) => {
      const sleep = ms => new Promise(res => setTimeout(res, ms));
      const clean = s => (s || "").replace(/\s+/g, " ").trim().toLowerCase();

      const btnMulai = Array.from(document.querySelectorAll("button, a, [role='button']")).find(
        b => clean(b.textContent || b.innerText) === "mulai pemeriksaan" && !b.disabled && b.getBoundingClientRect().width > 0
      );

      if (!btnMulai) return { needed: false, ok: true };

      btnMulai.scrollIntoView({ block: "center" });
      btnMulai.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
      btnMulai.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
      btnMulai.click();
      console.log("[pelayananScanner] Tombol Mulai Pemeriksaan diklik");

      // Tunggu modal kalender konfirmasi tanggal muncul (maksimal 4 detik)
      const modalStart = Date.now();
      let modalFound = false;
      while (Date.now() - modalStart < 4000) {
        modalFound = Array.from(document.querySelectorAll("div, [role='dialog'], .fixed, .modal")).some(el => {
          const txt = clean(el.textContent || el.innerText);
          const hasDateWord = txt.includes("tanggal") || txt.includes("konfirmasi") || txt.includes("pemeriksaan");
          const hasBtn = Array.from(el.querySelectorAll("button")).some(b => clean(b.textContent || b.innerText).includes("simpan"));
          return hasDateWord && hasBtn && el.offsetParent !== null;
        });
        if (modalFound) break;
        await sleep(250);
      }

      await sleep(300);

      // Klik tanggal hari yang sesuai di kalender
      const daySpan = Array.from(document.querySelectorAll("span, button, div")).find(
        e => e.textContent.trim() === String(tgl) && !/text-gray-300/.test(e.className) && (e.closest(".grid") || e.closest("table") || e.closest("[role='grid']")) && e.offsetParent !== null
      );
      if (daySpan) {
        daySpan.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
        daySpan.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
        daySpan.click();
        await sleep(300);
      }

      // Klik tombol Simpan pada modal
      const btnSimpan = Array.from(document.querySelectorAll("button")).find(b => {
        const txt = clean(b.textContent || b.innerText);
        return (txt === "simpan" || txt.includes("simpan")) && !b.disabled && b.offsetParent !== null;
      });

      if (btnSimpan) {
        btnSimpan.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
        btnSimpan.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
        btnSimpan.click();
        console.log("[pelayananScanner] Tombol Simpan konfirmasi tanggal diklik");
        await sleep(1000);
        return { needed: true, ok: true };
      }

      return { needed: true, ok: false, error: "Tombol Simpan tanggal tidak dapat diklik" };
    }
  });

  // Tunggu sampai kuesioner skrining siap (ada tombol input data atau status sedang pemeriksaan)
  for (let i = 0; i < 10; i++) {
    await sleep(400);
    const [checkItems] = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: () => {
        const clean = s => (s || "").replace(/\s+/g, " ").trim().toLowerCase();
        const hasInputBtns = Array.from(document.querySelectorAll("button")).some(b => {
          const txt = clean(b.textContent || b.innerText);
          return (txt === "input data" || txt === "input" || txt.includes("selesaikan layanan")) && b.offsetParent !== null;
        });
        const hasStatusSedang = (document.body?.innerText || "").toLowerCase().includes("sedang pemeriksaan");
        return hasInputBtns || hasStatusSedang;
      }
    });
    if (checkItems?.result) {
      console.log("[pelayananScanner] Kuesioner skrining sudah aktif dan ter-render di halaman.");
      break;
    }
  }

  await sleep(600);
  return res?.result ?? { needed: false, ok: true };
}

/**
 * Mengambil detail pasien dari halaman detail pemeriksaan
 */
export async function extractDetailPatientState(tabId) {
  const [res] = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: async () => {
      const clean = s => (s || '').replace(/\s+/g, ' ').trim();
      const getLabelValue = (labelKeyword) => {
        const kw = labelKeyword.toLowerCase();
        const all = Array.from(document.querySelectorAll('span, div, p, dt, td, label'));
        for (const el of all) {
          const txt = clean(el.innerText || el.textContent || '').toLowerCase();
          if (txt === kw || txt === kw + ":" || (txt.startsWith(kw) && txt.length < kw.length + 3)) {
            // Cek nextElementSibling
            if (el.nextElementSibling) {
              const val = clean(el.nextElementSibling.innerText || el.nextElementSibling.textContent || '');
              if (val) return val;
            }
            // Cek dari parent container
            const parent = el.parentElement;
            if (parent) {
              const children = Array.from(parent.children);
              const idx = children.indexOf(el);
              if (idx !== -1 && children[idx + 1]) {
                const val = clean(children[idx + 1].innerText || children[idx + 1].textContent || '');
                if (val) return val;
              }
            }
          }
        }
        return null;
      };

      // Kategori badge (Dewasa, Lansia, Remaja, Anak Sekolah, dll)
      let kategoriText = null;
      const catBadge = Array.from(document.querySelectorAll("*")).find(e => {
        const txt = clean(e.innerText || e.textContent || '').toLowerCase();
        const isCat = ['dewasa', 'lansia', 'remaja', 'anak sekolah', 'bayi', 'balita'].some(c => txt === c || txt.startsWith(c));
        const r = e.getBoundingClientRect();
        return isCat && r.width > 0 && r.height > 0 && r.top < 400;
      });
      if (catBadge) kategoriText = clean(catBadge.innerText || catBadge.textContent || '');

      const nikVal = getLabelValue("nik");
      const genderVal = getLabelValue("jenis kelamin");
      const dobVal = getLabelValue("tanggal lahir");
      const ticketVal = getLabelValue("nomor tiket");

      let rawCache = window.__ckgCache?.detailScreening;
      if (rawCache && typeof rawCache._d === "string") {
        try {
          const chunks = [...new Set(
            performance.getEntriesByType("resource")
              .map(r => r.name)
              .filter(u => u.includes("/_nuxt/") && u.endsWith(".js"))
          )];
          for (const chunkUrl of chunks) {
            const txt = await (await fetch(chunkUrl)).text().catch(() => "");
            if (txt.includes("isCryptoReady") && txt.includes("encryptQuery")) {
              const mod = await import(chunkUrl);
              const factory = Object.values(mod).find(fn => typeof fn === "function");
              const cryptoApi = factory ? factory() : null;
              if (typeof cryptoApi?.decrypt === "function") {
                const decrypted = await cryptoApi.decrypt(rawCache._d);
                if (decrypted && typeof decrypted === "object") {
                  rawCache = decrypted;
                  window.__ckgCache.detailScreening = decrypted;
                }
              }
              break;
            }
          }
        } catch (_) {}
      }
      const cache = rawCache?.data;
      const nameEl = document.querySelector("div[class*='font-bold'], h1, h2, h3");

      return {
        name: clean(nameEl?.innerText || nameEl?.textContent || '') || (cache?.patient_detail?.patient_name ?? null),
        kategori: kategoriText || (cache?.treatment?.category_name ?? cache?.category ?? null),
        jenisKelamin: genderVal || (cache?.patient_detail?.gender ?? null),
        nik: nikVal || (cache?.patient_detail?.nik ?? null),
        tanggalLahir: dobVal || (cache?.patient_detail?.patient_born_date ?? null),
        nomorTiket: ticketVal || (cache?.treatment?.ticket_number ?? null),
        attendDate: cache?.treatment?.attend_date ?? null,
        domicile: cache?.domicile ?? null,
        job: cache?.job?.text ?? null
      };
    }
  });

  return res?.result ?? null;
}

/**
 * Kembali ke halaman daftar pasien /ckg-pelayanan
 */
export async function returnToPelayananTable(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: () => {
      const isSekolah = location.href.includes("sekolah");
      const targetTableUrl = isSekolah
        ? "https://sehatindonesiaku.kemkes.go.id/ckg-pelayanan-sekolah?back=true"
        : "https://sehatindonesiaku.kemkes.go.id/ckg-pelayanan?back=true";

      const btnBack = Array.from(document.querySelectorAll('button, a, div[role="button"], span'))
        .find(b => {
          const t = (b.innerText || '').trim().toLowerCase();
          return (
            t === 'kembali' ||
            t.includes('kembali ke daftar') ||
            t.includes('daftar pasien') ||
            b.getAttribute('aria-label')?.toLowerCase().includes('kembali') ||
            (b.querySelector('svg') && (b.closest('h1, h2, h3, div.flex') || t.includes('cek kesehatan')))
          );
        });
      if (btnBack) {
        btnBack.click();
      } else {
        location.href = targetTableUrl;
      }
    }
  });

  // Tunggu tabel termuat kembali
  for (let i = 0; i < 20; i++) {
    await sleep(500);
    const [checkTbody] = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: () => !!document.querySelector("tbody tr")
    });
    if (checkTbody?.result) break;
  }
  await sleep(600);

  // Pastikan filter pencarian bersih & tab Belum Pemeriksaan aktif
  await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: () => {
      const allInputs = Array.from(document.querySelectorAll('input'));
      const searchInput = allInputs.find(inp => {
        const ph = (inp.placeholder || '').toLowerCase();
        const type = (inp.type || 'text').toLowerCase();
        return (type === 'text' || type === 'search') &&
               (ph.includes('nama') || ph.includes('masukkan') || ph.includes('cari') || ph.includes('tiket'));
      });
      if (searchInput && searchInput.value) {
        searchInput.focus();
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
        if (setter) setter.call(searchInput, '');
        else searchInput.value = '';
        searchInput.dispatchEvent(new Event('input', { bubbles: true }));
        searchInput.dispatchEvent(new Event('change', { bubbles: true }));
        searchInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
        searchInput.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
      }

      const clean = s => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
      const firstTab = Array.from(document.querySelectorAll('button, a, [role="tab"], div, li, span'))
        .find(el => {
          if (el.closest('table') || el.closest('tbody') || el.closest('thead')) return false;
          return clean(el.textContent).includes('belum pemeriksaan');
        });
      if (firstTab) firstTab.click();
    }
  }).catch(() => {});

  await sleep(800);
}
