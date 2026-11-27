import { getSession as getAuthSession, getUserData } from "./auth.js";
import { init as initKonfigurasi } from "./tabs/konfigurasi.js";
import { init as initPelayanan } from "./tabs/pelayanan.js";
import { init as initTools } from "./tabs/tools.js";
import { init as initPendaftaran } from "./tabs/pendaftaran.js";
import { init as initPelayananInstan } from "./tabs/pelayanan-instan.js";
import { initApiTestTab } from "./tabs/api-test.js";
import { init as initVpnProxy } from "./tabs/vpnProxy.js";
import { initDaftarLayani } from "./tabs/daftar-layani.js";
import {
  getHistory,
  deleteLogEntry,
  clearHistory,
  onHistoryChange,
  getActiveLogId,
  exportHistoryData,
  importHistoryData,
  syncCloudR2History
} from "./services/historyService.js";
import { initPingMonitor } from "./services/pingService.js";
import {
  getReportData,
  exportReportToExcel,
  copyReportSummary
} from "./services/reportService.js";
import {
  fetchEncoUsers,
  loginEnco,
  getLoggedEncoUser,
  logoutEnco
} from "./services/encoSyncService.js";

async function initPopup() {
  document.getElementById("footer-version").textContent = "Version: 1.0.0";

  // Bersihkan log history lokal lama agar riwayat 100% bridged dengan ckgbankot Cloud R2
  chrome.storage.local.remove(["enco_log_history"]).catch(() => {});

  // Reset data pendaftaran & pasien yang nyangkut jika tidak ada otomasi berjalan aktif
  try {
    const { pendaftaranRunning, pelayananRunning } = await chrome.storage.local.get(["pendaftaranRunning", "pelayananRunning"]);
    if (!pendaftaranRunning) {
      await chrome.storage.session?.remove(["pendaftaranPatients", "pendaftaranQueue"]).catch(() => {});
      await chrome.storage.local?.remove(["pendaftaranPatients", "pendaftaranQueue"]).catch(() => {});
    }
    if (!pelayananRunning) {
      await chrome.storage.session?.remove(["pelayanan-instan-records"]).catch(() => {});
      await chrome.storage.local?.remove(["pelayanan-instan-records"]).catch(() => {});
    }
  } catch (err) {
    console.warn("[initPopup] reset cache nyangkut error:", err);
  }

  const mainScreen = document.getElementById("main-screen");
  const loginScreen = document.getElementById("enco-login-screen");
  const officerNameEl = document.getElementById("enco-active-officer-name");
  const logoutBtn = document.getElementById("btn-enco-logout-trigger");

  async function checkEncoAuth() {
    const user = await getLoggedEncoUser();
    if (!user || !user.nama_user) {
      if (mainScreen) {
        mainScreen.hidden = true;
        mainScreen.style.display = "none";
      }
      if (loginScreen) {
        loginScreen.style.display = "flex";
      }
      initEncoLoginForm();
      return false;
    } else {
      if (loginScreen) {
        loginScreen.style.display = "none";
      }
      if (mainScreen) {
        mainScreen.hidden = false;
        mainScreen.style.display = "block";
      }
      if (officerNameEl) {
        officerNameEl.textContent = user.nama_user;
      }
      return true;
    }
  }

  logoutBtn?.addEventListener("click", async () => {
    if (confirm("Apakah Anda yakin ingin keluar dari akun ENCO?")) {
      await logoutEnco();
      location.reload();
    }
  });

  async function initEncoLoginForm() {
    const userSelect = document.getElementById("enco-login-select-user");
    const passHint = document.getElementById("enco-pass-hint");
    const passInput = document.getElementById("enco-login-password");
    const loginForm = document.getElementById("enco-login-form");
    const alertBox = document.getElementById("enco-login-alert");
    const submitBtn = document.getElementById("btn-enco-login-submit");
    const spinner = document.getElementById("enco-login-spinner");

    if (!userSelect || !loginForm) return;

    try {
      const users = await fetchEncoUsers();
      if (users && users.length > 0) {
        userSelect.innerHTML = '<option value="">-- Pilih Nama Pegawai / Petugas --</option>';
        users.forEach(u => {
          const opt = document.createElement("option");
          opt.value = u.nama_user;
          opt.dataset.needPass = u.need_password ? "true" : "false";
          opt.textContent = `${u.nama_user}${u.role && u.role !== 'Petugas' ? ' (' + u.role + ')' : ''}`;
          userSelect.appendChild(opt);
        });
      } else {
        userSelect.innerHTML = '<option value="">Gagal memuat pegawai (periksa koneksi)</option>';
      }
    } catch (e) {
      userSelect.innerHTML = `<option value="">Error: ${e.message}</option>`;
    }

    userSelect.addEventListener("change", () => {
      const selected = userSelect.options[userSelect.selectedIndex];
      const needPass = selected?.dataset?.needPass === "true";
      if (passHint) {
        passHint.textContent = needPass ? "(Wajib sandi database)" : "(Tanpa sandi)";
        passHint.style.color = needPass ? "#f59e0b" : "#10b981";
      }
      if (passInput) {
        passInput.required = needPass;
      }
    });

    const btnToggleEye = document.getElementById("btn-toggle-login-pass");
    if (btnToggleEye && passInput) {
      btnToggleEye.addEventListener("click", () => {
        const isPass = passInput.type === "password";
        passInput.type = isPass ? "text" : "password";
        const iconShow = document.getElementById("icon-eye-show");
        const iconHide = document.getElementById("icon-eye-hide");
        if (iconShow) iconShow.style.display = isPass ? "none" : "block";
        if (iconHide) iconHide.style.display = isPass ? "block" : "none";
      });
    }

    loginForm.onsubmit = async (e) => {
      e.preventDefault();
      const namaUser = userSelect.value;
      const pass = passInput ? passInput.value : "";

      if (!namaUser) {
        showAlert("Silakan pilih Nama Pegawai!", "error");
        return;
      }

      submitBtn.disabled = true;
      if (spinner) spinner.style.display = "inline";
      hideAlert();

      const result = await loginEnco(namaUser, pass);
      submitBtn.disabled = false;
      if (spinner) spinner.style.display = "none";

      if (result.success) {
        showAlert(`Login berhasil sebagai ${result.user.nama_user}`, "success");
        setTimeout(() => {
          checkEncoAuth();
        }, 400);
      } else {
        showAlert(result.error || "Login gagal!", "error");
      }
    };

    function showAlert(msg, type) {
      if (!alertBox) return;
      alertBox.textContent = msg;
      alertBox.style.display = "block";
      alertBox.style.background = type === "error" ? "rgba(239, 68, 68, 0.2)" : "rgba(16, 185, 129, 0.2)";
      alertBox.style.border = type === "error" ? "1px solid rgba(239, 68, 68, 0.5)" : "1px solid rgba(16, 185, 129, 0.5)";
      alertBox.style.color = type === "error" ? "#fca5a5" : "#6ee7b7";
    }

    function hideAlert() {
      if (alertBox) alertBox.style.display = "none";
    }
  }

  // Cek otentikasi login gatekeeper
  await checkEncoAuth();


  // Reload Extension Button Handler
  const setupReloadBtn = (btnId) => {
    const btn = document.getElementById(btnId);
    if (!btn) return;
    btn.addEventListener("click", () => {
      btn.classList.add("spinning");
      setTimeout(() => {
        if (chrome.runtime?.reload) {
          chrome.runtime.reload();
        } else {
          location.reload();
        }
      }, 150);
    });
  };
  setupReloadBtn("btn-reload-extension");

  // Open Extension in Full Tab Mode (Recommended for Android / Titanium)
  const openFullTabMode = () => {
    const tabUrl = chrome.runtime.getURL("popup.html?tab=true");
    if (chrome.tabs?.create) {
      chrome.tabs.create({ url: tabUrl });
      window.close();
    } else {
      window.open(tabUrl, "_blank");
    }
  };

  document.getElementById("btn-open-tab-mode")?.addEventListener("click", openFullTabMode);
  document.getElementById("btn-banner-open-tab")?.addEventListener("click", openFullTabMode);
  document.getElementById("btn-banner-close")?.addEventListener("click", () => {
    const banner = document.getElementById("mobile-tab-banner");
    if (banner) banner.hidden = true;
    sessionStorage.setItem("enco_hide_tab_banner", "1");
  });

  // Open Extension in Native Chrome Side Panel
  const openSidePanelMode = async () => {
    if (chrome.sidePanel?.open) {
      try {
        const win = await chrome.windows.getCurrent();
        await chrome.sidePanel.open({ windowId: win.id });
        window.close();
      } catch (err) {
        console.warn("[ENCO] Gagal buka side panel:", err);
      }
    } else {
      openFullTabMode();
    }
  };

  document.getElementById("btn-open-sidepanel")?.addEventListener("click", openSidePanelMode);

  // Smart Mobile Detection for Banner
  const isTabActive = window.location.search.includes("tab=true") || window.innerWidth > 500;
  const isPanelActive = window.location.search.includes("panel=true");
  const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent) || (window.screen && window.screen.width <= 768);
  const bannerEl = document.getElementById("mobile-tab-banner");

  if (isPanelActive) {
    const sideBtn = document.getElementById("btn-open-sidepanel");
    if (sideBtn) {
      sideBtn.style.display = "none";
    }
    if (bannerEl) bannerEl.hidden = true;
  } else if (isTabActive) {
    const tabBtn = document.getElementById("btn-open-tab-mode");
    if (tabBtn) {
      tabBtn.classList.add("btn-open-tab-mode--active");
      tabBtn.title = "Mode Tab Penuh Aktif";
    }
    if (bannerEl) bannerEl.hidden = true;
  } else if (isMobile && !sessionStorage.getItem("enco_hide_tab_banner")) {
    if (bannerEl) bannerEl.hidden = false;
  }

  const userAvatar = document.getElementById("user-avatar");
  const userName = document.getElementById("user-name");
  const userAvatarBtn = document.getElementById("user-avatar-btn");
  const quotaPopover = document.getElementById("quota-popover");
  const quotaValue = document.getElementById("quota-value");
  const quotaPopoverName = document.getElementById("quota-popover-name");

  if (userName) userName.textContent = "ENCO";
  if (quotaPopoverName) quotaPopoverName.textContent = "Offline User";
  if (quotaValue) quotaValue.textContent = "Aktif (Permanen)";

  const popupBody = document.querySelector(".popup__body");

  // ── Tab & Navigation Elements & Maps ────────────────────────
  const TAB_TITLE_MAP = {
    pendaftaran: "PENDAFTARAN",
    "pelayanan-instan": "PASIEN",
    otomasi: "PELAYANAN",
    tools: "TOOLS",
    "api-test": "REG API",
    pengaturan: "PENGATURAN",
    "vpn-proxy": "VPN & ANTI-429",
    "daftar-layani": "DAFTAR & LAYANI"
  };

  const TAB_MENU_MAP = {
    pendaftaran: { menu: "pendaftaran", label: "PENDAFTARAN" },
    "pelayanan-instan": { menu: "pasien", label: "PASIEN" },
    otomasi: { menu: "pelayanan", label: "PELAYANAN" }
  };

  let currentTabKey = "home";
  let currentMenu = "pelayanan";
  let currentReportMenu = "pendaftaran";
  let activeReportFilter = "all";
  let reportSearchQuery = "";
  let currentReportData = null;

  const subpageBar = document.getElementById("subpage-bar");
  const btnBackToMenu = document.getElementById("btn-back-to-menu");
  const subpageTitle = document.getElementById("subpage-title");
  const tabHome = document.getElementById("tab-home");
  const pendaftaranFab = document.getElementById("pendaftaran-fab");
  const btnFooter = document.getElementById("btn-footer");

  let konfigurasi = null;
  let pelayananTab = null;
  let pendaftaranTab = null;
  let pelayananInstanTab = null;
  let vpnProxyTab = null;

  function showMainUI() {
    if (popupBody) popupBody.hidden = false;
    if (btnFooter) {
      btnFooter.hidden = currentTabKey === "home" || !["otomasi", "pelayanan-instan"].includes(currentTabKey);
    }
  }

  function showOfflineScreen(user) {
    if (loginScreen && loginScreen.style.display === "block") return;
    if (mainScreen) mainScreen.hidden = false;
    const name = user?.user_metadata?.full_name ?? user?.email ?? "Petugas";
    if (userName) userName.textContent = name.split(" ")[0];
    if (quotaPopoverName) quotaPopoverName.textContent = name;
  }

  async function setupOffline() {
    if (loginScreen && loginScreen.style.display === "block") return;
    if (quotaValue) quotaValue.textContent = "Aktif (Permanen)";
    showMainUI();
  }

  // Tampilkan antarmuka utama secara langsung dan permanen
  setupOffline();

  function getActiveTabId() {
    return new Promise(resolve => {
      chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => resolve(tab?.id));
    });
  }

  function sendToBackground(msg) {
    return new Promise(resolve => {
      try {
        chrome.runtime.sendMessage(msg, response => {
          if (chrome.runtime.lastError) {
            resolve({});
          } else {
            resolve(response || {});
          }
        });
      } catch (_) {
        resolve({});
      }
    });
  }

  async function checkDeviceOrSignOut() {
    return true;
  }

  userAvatarBtn?.addEventListener("click", e => {
    e.stopPropagation();
    if (!quotaPopover) return;
    const isHidden = quotaPopover.hidden;
    quotaPopover.hidden = !isHidden;
    userAvatarBtn.setAttribute("aria-expanded", String(isHidden));
  });

  document.addEventListener("click", () => {
    if (quotaPopover && !quotaPopover.hidden) {
      quotaPopover.hidden = true;
      userAvatarBtn?.setAttribute("aria-expanded", "false");
    }
  });

  function switchTab(tabId) {
    currentTabKey = tabId;
    const isHome = tabId === "home";

    if (tabHome) tabHome.hidden = !isHome;
    if (subpageBar) subpageBar.hidden = isHome;
    if (!isHome && subpageTitle) {
      subpageTitle.textContent = TAB_TITLE_MAP[tabId] || tabId.toUpperCase();
    }

    const tabPendaftaran = document.getElementById("tab-pendaftaran");
    const tabOtomasi = document.getElementById("tab-otomasi");
    const tabPengaturan = document.getElementById("tab-pengaturan");
    const tabTools = document.getElementById("tab-tools");
    const tabPelayananInstan = document.getElementById("tab-pelayanan-instan");
    const tabApiTest = document.getElementById("tab-api-test");
    const tabVpnProxy = document.getElementById("tab-vpn-proxy");
    const tabDaftarLayani = document.getElementById("tab-daftar-layani");

    if (tabPendaftaran) tabPendaftaran.hidden = isHome || tabId !== "pendaftaran";
    if (tabOtomasi) tabOtomasi.hidden = isHome || tabId !== "otomasi";
    if (tabPengaturan) tabPengaturan.hidden = isHome || tabId !== "pengaturan";
    if (tabTools) tabTools.hidden = isHome || tabId !== "tools";
    if (tabPelayananInstan) tabPelayananInstan.hidden = isHome || tabId !== "pelayanan-instan";
    if (tabApiTest) tabApiTest.hidden = isHome || tabId !== "api-test";
    if (tabVpnProxy) tabVpnProxy.hidden = isHome || tabId !== "vpn-proxy";
    if (tabDaftarLayani) tabDaftarLayani.hidden = isHome || tabId !== "daftar-layani";

    if (tabId === "vpn-proxy" && vpnProxyTab?.refreshUI) {
      try { vpnProxyTab.refreshUI(); } catch (_) { }
    }

    if (btnFooter) {
      btnFooter.hidden = isHome || (tabId !== "otomasi" && tabId !== "pelayanan-instan");
      // Hide footer when pelayanan mode not yet selected
      if (tabId === "otomasi" && pelayananTab?.getMode && !pelayananTab.getMode()) {
        btnFooter.hidden = true;
      }
      // Hide footer when pelayanan-instan mode not yet selected
      if (tabId === "pelayanan-instan" && pelayananInstanTab?.getMode && !pelayananInstanTab.getMode()) {
        btnFooter.hidden = true;
      }
    }
    if (pendaftaranFab) {
      pendaftaranFab.hidden = isHome || tabId !== "pendaftaran" || (tabId === "pendaftaran" && pendaftaranTab?.getMode && !pendaftaranTab.getMode());
    }

    try {
      chrome.storage.session.set({ activeTab: tabId });
    } catch (_) { }

    if (tabId === "pelayanan-instan" && pelayananInstanTab) {
      pelayananInstanTab.setFooterButtonsVisibility?.(true);
      if (pelayananInstanTab.initialize) {
        pelayananInstanTab.initialize().then(() => {
          pelayananInstanTab.setFooterButtonsVisibility?.(true);
          if (btnFooter && pelayananInstanTab.getMode?.()) {
            btnFooter.hidden = false;
          }
        }).catch(err => console.warn("pelayananInstan initialize err:", err));
      }
    } else if (pelayananInstanTab) {
      pelayananInstanTab.setFooterButtonsVisibility?.(false);
    }

    try {
      if (typeof renderHistorySidebar === "function") {
        renderHistorySidebar(tabId);
      }
    } catch (e) {
      console.warn("[switchTab] renderHistorySidebar error:", e);
    }

    try {
      if (tabId === "pendaftaran" || tabId === "pelayanan-instan" || tabId === "otomasi") {
        const mapping = TAB_MENU_MAP[tabId];
        if (mapping) currentReportMenu = mapping.menu;
        if (typeof updateReportBadge === "function") updateReportBadge(currentReportMenu);
        const reportSidebar = document.getElementById("report-sidebar");
        if (reportSidebar && reportSidebar.classList.contains("report-sidebar--open")) {
          if (typeof renderReportSidebar === "function") renderReportSidebar(currentReportMenu);
        }
      } else {
        if (typeof updateReportBadge === "function") updateReportBadge(currentReportMenu);
      }
    } catch (e) {
      console.warn("[switchTab] updateReportBadge error:", e);
    }
  }

  // ── Metro Tile & Back Button Click Listeners (Early Binding for Instant Response) ──
  document.querySelectorAll(".metro-tile").forEach(tile => {
    tile.addEventListener("click", () => {
      const targetTab = tile.dataset.tab;
      if (targetTab) switchTab(targetTab);
    });
  });

  if (btnBackToMenu) {
    btnBackToMenu.addEventListener("click", () => {
      // If inside otomasi with a mode selected, go back to mode picker first
      if (currentTabKey === "otomasi" && pelayananTab?.getMode && pelayananTab.getMode()) {
        pelayananTab.resetMode();
        if (btnFooter) btnFooter.hidden = true;
        return;
      }
      // If inside pendaftaran with a mode selected, go back to category picker first
      if (currentTabKey === "pendaftaran" && pendaftaranTab?.getMode && pendaftaranTab.getMode()) {
        pendaftaranTab.resetMode();
        if (pendaftaranFab) pendaftaranFab.hidden = true;
        return;
      }
      // If inside pelayanan-instan with a mode selected, go back to mode picker first
      if (currentTabKey === "pelayanan-instan" && pelayananInstanTab?.getMode && pelayananInstanTab.getMode()) {
        pelayananInstanTab.resetMode();
        if (btnFooter) btnFooter.hidden = true;
        return;
      }
      switchTab("home");
    });
  }

  // ── Safe Asynchronous Tab Module Initializations ────────────
  try {
    konfigurasi = await initKonfigurasi();
  } catch (err) {
    console.error("[initKonfigurasi] error:", err);
  }

  let fillBtn = null;
  try {
    const toolsRes = initTools({
      checkDeviceOrSignOut,
      getTabId: getActiveTabId,
      getFieldRules: () => (pelayananTab?.getFieldRules ? pelayananTab.getFieldRules() : []),
      getDelay: () => (konfigurasi?.getDelay ? konfigurasi.getDelay() : 1200),
      getStatusMenikah: () => (pelayananTab?.getStatusMenikah ? pelayananTab.getStatusMenikah() : ""),
      triggerFetchData: () => (pelayananTab?.triggerFetchData ? pelayananTab.triggerFetchData() : null)
    });
    fillBtn = toolsRes?.fillBtn;
  } catch (err) {
    console.error("[initTools] error:", err);
  }

  try {
    pelayananTab = await initPelayanan({
      checkDeviceOrSignOut,
      getTabId: getActiveTabId,
      sendToBackground,
      konfigurasi,
      fillBtn
    });
  } catch (err) {
    console.error("[initPelayanan] error:", err);
  }

  try {
    pendaftaranTab = initPendaftaran({ konfigurasi });
  } catch (err) {
    console.error("[initPendaftaran] error:", err);
  }

  try {
    pelayananInstanTab = initPelayananInstan({
      checkDeviceOrSignOut,
      getPendaftaranPatients: () => (pendaftaranTab?.getPatients ? pendaftaranTab.getPatients() : [])
    });
  } catch (err) {
    console.error("[initPelayananInstan] error:", err);
  }

  try {
    initApiTestTab();
  } catch (err) {
    console.error("[initApiTestTab] error:", err);
  }

  try {
    vpnProxyTab = await initVpnProxy();
  } catch (err) {
    console.error("[initVpnProxy] error:", err);
  }

  try {
    initDaftarLayani();
  } catch (err) {
    console.error("[initDaftarLayani] error:", err);
  }

  const btnToggleHistory = document.getElementById("btn-toggle-history");
  const btnCloseHistory = document.getElementById("btn-close-history");
  const historyBackdrop = document.getElementById("history-backdrop");
  const historyHeaderBadge = document.getElementById("history-header-badge");

  // ── Report Sidebar Manager (Laporan Status & Analisis Error) ───

  const btnToggleReport = document.getElementById("btn-toggle-report");
  const btnCloseReport = document.getElementById("btn-close-report");
  const reportHeaderBadge = document.getElementById("report-header-badge");
  const reportSidebar = document.getElementById("report-sidebar");
  const btnExportReportExcel = document.getElementById("btn-export-report-excel");
  const btnCopyReport = document.getElementById("btn-copy-report");
  const reportSearchInput = document.getElementById("report-search-input");
  const btnClearReportSearch = document.getElementById("btn-clear-report-search");
  const reportFilterYearEl = document.getElementById("report-filter-year");
  const reportFilterMonthEl = document.getElementById("report-filter-month");
  const reportFilterDateEl = document.getElementById("report-filter-date");
  const btnResetReportDate = document.getElementById("btn-reset-report-date");
  const reportHeaderTimeEl = document.getElementById("report-header-time");

  let reportFilterYear = "all";
  let reportFilterMonth = "all";
  let reportFilterDate = "";

  function openReportDrawer() {
    closeHistoryDrawer();
    if (!reportSidebar) return;
    reportSidebar.hidden = false;
    reportSidebar.classList.add("report-sidebar--open");
    if (historyBackdrop) {
      historyBackdrop.hidden = false;
      requestAnimationFrame(() => {
        historyBackdrop.classList.add("history-backdrop--open");
      });
    }
    renderReportSidebar(currentReportMenu);
  }

  function closeReportDrawer() {
    if (!reportSidebar) return;
    reportSidebar.classList.remove("report-sidebar--open");
    setTimeout(() => {
      if (!reportSidebar.classList.contains("report-sidebar--open")) {
        reportSidebar.hidden = true;
      }
    }, 280);
    if (historyBackdrop) {
      const historySidebar = document.getElementById("history-sidebar");
      if (!historySidebar?.classList.contains("history-sidebar--open")) {
        historyBackdrop.classList.remove("history-backdrop--open");
        setTimeout(() => {
          if (!reportSidebar.classList.contains("report-sidebar--open") && !historySidebar?.classList.contains("history-sidebar--open")) {
            historyBackdrop.hidden = true;
          }
        }, 260);
      }
    }
  }

  if (btnToggleReport) {
    btnToggleReport.addEventListener("click", () => {
      if (reportSidebar && reportSidebar.classList.contains("report-sidebar--open")) {
        closeReportDrawer();
      } else {
        openReportDrawer();
      }
    });
  }

  if (btnCloseReport) {
    btnCloseReport.addEventListener("click", closeReportDrawer);
  }

  // Nav tabs inside report
  document.querySelectorAll(".report-nav-tab").forEach(tab => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".report-nav-tab").forEach(t => t.classList.remove("report-nav-tab--active"));
      tab.classList.add("report-nav-tab--active");
      const target = tab.dataset.reportMenu;
      if (target) {
        currentReportMenu = target;
        renderReportSidebar(currentReportMenu);
      }
    });
  });

  // Filter chips inside report
  document.querySelectorAll(".report-chip").forEach(chip => {
    chip.addEventListener("click", () => {
      document.querySelectorAll(".report-chip").forEach(c => c.classList.remove("report-chip--active"));
      chip.classList.add("report-chip--active");
      activeReportFilter = chip.dataset.filter || "all";
      reportVisibleLimit = REPORT_PAGE_SIZE;
      renderReportItemsList();
    });
  });

  // Search input inside report dengan debounce agar tidak freeze saat mengetik
  let reportSearchDebounceTimer = null;
  if (reportSearchInput) {
    reportSearchInput.addEventListener("input", e => {
      if (reportSearchDebounceTimer) clearTimeout(reportSearchDebounceTimer);
      reportSearchDebounceTimer = setTimeout(() => {
        reportSearchQuery = (e.target.value || "").trim().toLowerCase();
        if (btnClearReportSearch) btnClearReportSearch.hidden = !reportSearchQuery;
        reportVisibleLimit = REPORT_PAGE_SIZE;
        renderReportItemsList();
      }, 200);
    });
  }

  if (btnClearReportSearch && reportSearchInput) {
    btnClearReportSearch.addEventListener("click", () => {
      reportSearchInput.value = "";
      reportSearchQuery = "";
      btnClearReportSearch.hidden = true;
      reportVisibleLimit = REPORT_PAGE_SIZE;
      renderReportItemsList();
    });
  }

  // Filter waktu: Tahun, Bulan, Tanggal
  if (reportFilterYearEl) {
    reportFilterYearEl.addEventListener("change", e => {
      reportFilterYear = e.target.value;
      reportVisibleLimit = REPORT_PAGE_SIZE;
      renderReportItemsList();
    });
  }
  if (reportFilterMonthEl) {
    reportFilterMonthEl.addEventListener("change", e => {
      reportFilterMonth = e.target.value;
      reportVisibleLimit = REPORT_PAGE_SIZE;
      renderReportItemsList();
    });
  }
  if (reportFilterDateEl) {
    reportFilterDateEl.addEventListener("change", e => {
      reportFilterDate = e.target.value;
      reportVisibleLimit = REPORT_PAGE_SIZE;
      renderReportItemsList();
    });
  }
  if (btnResetReportDate) {
    btnResetReportDate.addEventListener("click", () => {
      reportFilterYear = "all";
      reportFilterMonth = "all";
      reportFilterDate = "";
      if (reportFilterYearEl) reportFilterYearEl.value = "all";
      if (reportFilterMonthEl) reportFilterMonthEl.value = "all";
      if (reportFilterDateEl) reportFilterDateEl.value = "";
      reportVisibleLimit = REPORT_PAGE_SIZE;
      renderReportItemsList();
    });
  }

  // Export report to Excel (.xlsx)
  if (btnExportReportExcel) {
    btnExportReportExcel.addEventListener("click", () => {
      if (!currentReportData || !currentReportData.items?.length) {
        alert("Belum ada data laporan untuk diunduh.");
        return;
      }
      exportReportToExcel(currentReportData);
    });
  }

  // Copy report summary text
  if (btnCopyReport) {
    btnCopyReport.addEventListener("click", async () => {
      if (!currentReportData || !currentReportData.items?.length) {
        alert("Belum ada data laporan untuk disalin.");
        return;
      }
      const ok = await copyReportSummary(currentReportData);
      if (ok) {
        const origTitle = btnCopyReport.title;
        btnCopyReport.title = "Tersalin ke Clipboard!";
        btnCopyReport.style.borderColor = "#10b981";
        btnCopyReport.style.color = "#10b981";
        setTimeout(() => {
          btnCopyReport.title = origTitle;
          btnCopyReport.style.borderColor = "";
          btnCopyReport.style.color = "";
        }, 1800);
      }
    });
  }

  let cachedBadgeStats = null;
  let cachedBadgeMenu = null;
  let cachedBadgeTime = 0;

  async function updateReportBadge(menu = currentReportMenu) {
    try {
      if (!reportHeaderBadge) return;
      const now = Date.now();
      // Cache statistik badge selama 1.5 detik agar tidak membebani saat otomasi berlangsung
      if (cachedBadgeStats && cachedBadgeMenu === menu && (now - cachedBadgeTime < 1500)) {
        applyBadgeStats(cachedBadgeStats);
        return;
      }

      let stats = { total: 0, success: 0, error: 0, warning: 0 };
      const storageArea = chrome.storage?.session || chrome.storage?.local;

      if (menu === "pendaftaran") {
        const { pendaftaranPatients = [] } = await storageArea.get("pendaftaranPatients");
        stats.total = pendaftaranPatients.length;
        for (let i = 0; i < pendaftaranPatients.length; i++) {
          const st = pendaftaranPatients[i]._status;
          if (st === "done") stats.success++;
          else if (st === "error" || st === "invalid-nik") stats.error++;
          else if (st === "already-screened") stats.warning++;
        }
      } else if (menu === "pasien") {
        const { "pelayanan-instan-records": curRecs = [] } = await storageArea.get("pelayanan-instan-records");
        stats.total = curRecs.length;
        for (let i = 0; i < curRecs.length; i++) {
          const st = curRecs[i]._status || curRecs[i].status;
          if (st === "done" || st === "DONE_PELAYANAN") stats.success++;
          else if (st === "error" || st === "SERVER_ERROR" || st === "MISSING") stats.error++;
          else if (st === "already-screened" || st === "ALREADY_SCREENED") stats.warning++;
        }
      } else {
        const data = await getReportData(menu);
        stats = data.stats;
      }

      cachedBadgeStats = stats;
      cachedBadgeMenu = menu;
      cachedBadgeTime = now;
      applyBadgeStats(stats);
    } catch (err) {
      console.warn("[updateReportBadge] error:", err);
    }
  }

  function applyBadgeStats(stats) {
    if (!reportHeaderBadge) return;
    if (stats.error > 0) {
      reportHeaderBadge.textContent = stats.error;
      reportHeaderBadge.hidden = false;
      reportHeaderBadge.classList.add("report-header-badge--has-error");
      reportHeaderBadge.title = `${stats.error} data mengalami error/gagal`;
    } else if (stats.total > 0) {
      reportHeaderBadge.textContent = stats.success > 0 ? stats.success : stats.total;
      reportHeaderBadge.hidden = false;
      reportHeaderBadge.classList.remove("report-header-badge--has-error");
      reportHeaderBadge.title = `${stats.success}/${stats.total} data selesai`;
    } else {
      reportHeaderBadge.hidden = true;
    }
  }

  const REPORT_PAGE_SIZE = 60;
  let reportVisibleLimit = REPORT_PAGE_SIZE;

  function renderReportItemsList(append = false) {
    const listEl = document.getElementById("report-list");
    const emptyEl = document.getElementById("report-empty");
    if (!listEl || !emptyEl || !currentReportData) return;

    if (reportHeaderTimeEl) {
      reportHeaderTimeEl.textContent = currentReportData.reportTimestamp ? `🕒 ${currentReportData.reportTimestamp}` : "";
    }

    let items = currentReportData.items || [];

    // Filter by category
    if (activeReportFilter === "error") {
      items = items.filter(i => i.isError);
    } else if (activeReportFilter === "success") {
      items = items.filter(i => i.isSuccess);
    } else if (activeReportFilter === "warning") {
      items = items.filter(i => i.isWarning);
    }

    // Filter by search query
    if (reportSearchQuery) {
      items = items.filter(i =>
        (i.nama && i.nama.toLowerCase().includes(reportSearchQuery)) ||
        (i.nik && i.nik.includes(reportSearchQuery)) ||
        (i.sekolah && i.sekolah.toLowerCase().includes(reportSearchQuery)) ||
        (i.reason && i.reason.toLowerCase().includes(reportSearchQuery)) ||
        (i.tanggalInput && i.tanggalInput.toLowerCase().includes(reportSearchQuery)) ||
        (i.faskesPemeriksa && i.faskesPemeriksa.toLowerCase().includes(reportSearchQuery))
      );
    }

    // Filter by Tahun (ringan tanpa JSON.stringify)
    if (reportFilterYear !== "all") {
      items = items.filter(i => {
        const dStr = `${i.tanggalInput || ""} ${i.waktuEksekusi || ""}`;
        return dStr.includes(reportFilterYear);
      });
    }

    // Filter by Bulan (01 - 12)
    if (reportFilterMonth !== "all") {
      const mNames = ["", "jan", "feb", "mar", "apr", "mei", "jun", "jul", "agu", "sep", "okt", "nov", "des"];
      const mIdx = parseInt(reportFilterMonth, 10);
      const mStr = mNames[mIdx];
      items = items.filter(i => {
        const dStr = `${i.tanggalInput || ""} ${i.waktuEksekusi || ""}`.toLowerCase();
        return dStr.includes(`-${reportFilterMonth}-`) ||
               dStr.includes(`/${reportFilterMonth}/`) ||
               dStr.includes(`/${mIdx}/`) ||
               (mStr && dStr.includes(mStr));
      });
    }

    // Filter by Tanggal spesifik (YYYY-MM-DD)
    if (reportFilterDate) {
      const [y, m, d] = reportFilterDate.split("-");
      const ddmmyyyy = `${d}/${m}/${y}`;
      const ddmmyyyyDash = `${d}-${m}-${y}`;
      items = items.filter(i => {
        const dStr = `${i.tanggalInput || ""} ${i.waktuEksekusi || ""}`;
        return dStr.includes(reportFilterDate) || dStr.includes(ddmmyyyy) || dStr.includes(ddmmyyyyDash);
      });
    }

    if (!items.length) {
      listEl.innerHTML = "";
      listEl.hidden = true;
      emptyEl.hidden = false;
      const titleEl = emptyEl.querySelector(".report-empty-title");
      const descEl = emptyEl.querySelector(".report-empty-desc");
      if (currentReportData.items.length === 0) {
        if (titleEl) titleEl.textContent = "Belum Ada Data Laporan";
        if (descEl) descEl.textContent = "Upload file Excel atau mulai proses otomasi untuk melihat laporan keberhasilan dan rincian error.";
      } else {
        if (titleEl) titleEl.textContent = "Tidak Ada Hasil Filter";
        if (descEl) descEl.textContent = "Tidak ada data yang sesuai dengan pencarian atau filter yang dipilih.";
      }
      return;
    }

    emptyEl.hidden = true;
    listEl.hidden = false;

    // Jika bukan mode append (load more), bersihkan daftar
    if (!append) {
      listEl.innerHTML = "";
    } else {
      const oldLoadMore = document.getElementById("report-load-more-wrap");
      if (oldLoadMore) oldLoadMore.remove();
    }

    // Batasi render DOM agar Chrome tidak freeze saat data mencapai ribuan
    const startIndex = append ? Math.max(0, reportVisibleLimit - REPORT_PAGE_SIZE) : 0;
    const itemsToRender = items.slice(startIndex, reportVisibleLimit);

    // Gunakan DocumentFragment untuk 1x batch paint ke browser
    const fragment = document.createDocumentFragment();

    itemsToRender.forEach(item => {
      const card = document.createElement("div");
      let cardTypeClass = "report-card--idle";
      if (item.isSuccess) cardTypeClass = "report-card--success";
      else if (item.isError) cardTypeClass = "report-card--error";
      else if (item.isWarning) cardTypeClass = "report-card--warning";
      else if (item.isPending) cardTypeClass = "report-card--progress";

      card.className = `report-card ${cardTypeClass}`;

      let reasonBoxClass = "report-reason-box--neutral";
      let reasonIcon = "ℹ️";
      let reasonTitle = "Status:";
      if (item.isError) {
        reasonBoxClass = "report-reason-box--error";
        reasonIcon = "⚠️";
        reasonTitle = "Penyebab Error:";
      } else if (item.isWarning) {
        reasonBoxClass = "report-reason-box--warning";
        reasonIcon = "⚠️";
        reasonTitle = "Keterangan:";
      } else if (item.isSuccess) {
        reasonBoxClass = "report-reason-box--success";
        reasonIcon = "✅";
        reasonTitle = "Hasil Pemeriksaan:";
      }

      let warningExtra = "";
      if (item.isWarning) {
        const hasTgl = item.tanggalInput && item.tanggalInput !== "-";
        const hasFaskes = item.faskesPemeriksa && item.faskesPemeriksa !== "-";
        warningExtra = `
          <div class="report-info-pill-row">
            ${hasFaskes ? `<span class="report-info-pill">🏥 Puskesmas pemeriksa: <strong>${item.faskesPemeriksa}</strong></span>` : ''}
            <span class="report-info-pill">📅 Tanggal pemeriksaan: <strong>${hasTgl ? item.tanggalInput : 'Belum terekam (Diproses sebelum update)'}</strong></span>
            ${item.layanan ? `<span class="report-info-pill">🩺 Layanan: <strong>${item.layanan}</strong></span>` : ''}
          </div>
        `;
      }

      card.innerHTML = `
        <div class="report-card__header">
          <div class="report-card__title-row">
            <span class="report-card__num">#${item.index}</span>
            <span class="report-card__name" title="${item.nama}">${item.nama}</span>
          </div>
          <span class="badge ${item.badgeClass}">${item.statusLabel}</span>
        </div>
        <div class="report-card__meta-row">
          <div class="report-card__meta-item">
            <span>NIK:</span>
            <strong class="report-card__meta-nik">${item.nik}</strong>
          </div>
          ${item.category ? `<div class="report-card__meta-item"><span>Kat:</span> <strong>${item.category}</strong></div>` : ""}
          ${item.sekolah ? `<div class="report-card__meta-item"><span>Sekolah:</span> <strong>${item.sekolah}</strong></div>` : ""}
          ${item.ticketNumber ? `<div class="report-card__ticket"><span>Tiket:</span> #${item.ticketNumber}</div>` : ""}
          <div class="report-card__meta-item" style="color: #64748b; font-size: 10px;">
            <span>🕒</span> <span>${item.waktuEksekusi || ''}</span>
          </div>
        </div>
        <div class="report-reason-box ${reasonBoxClass}">
          <span class="report-reason-icon">${reasonIcon}</span>
          <div class="report-reason-text">
            <strong class="report-reason-title">${reasonTitle}</strong>
            <span>${item.reason}</span>
            ${warningExtra}
          </div>
        </div>
      `;

      fragment.appendChild(card);
    });

    listEl.appendChild(fragment);

    // Tombol Muat Lebih Banyak jika data melebihi batas tampilan saat ini
    if (items.length > reportVisibleLimit) {
      const remaining = items.length - reportVisibleLimit;
      const loadMoreWrap = document.createElement("div");
      loadMoreWrap.id = "report-load-more-wrap";
      loadMoreWrap.style.cssText = "padding: 12px 6px; text-align: center;";
      loadMoreWrap.innerHTML = `
        <button id="btnLoadMoreReportItems" type="button" class="btn btn--secondary" style="width: 100%; font-size: 11.5px; padding: 8px 12px; border: 1px dashed rgba(255,255,255,0.2); cursor: pointer;">
          ⬇️ Muat Lebih Banyak (Menampilkan ${Math.min(reportVisibleLimit, items.length)} dari ${items.length} pasien — tersisa ${remaining})
        </button>
      `;
      listEl.appendChild(loadMoreWrap);

      const btnMore = loadMoreWrap.querySelector("#btnLoadMoreReportItems");
      if (btnMore) {
        btnMore.addEventListener("click", () => {
          reportVisibleLimit += REPORT_PAGE_SIZE;
          renderReportItemsList(true);
        });
      }
    }
  }

  let isRenderingReportSidebar = false;

  async function renderReportSidebar(menu = currentReportMenu) {
    if (isRenderingReportSidebar) return;
    isRenderingReportSidebar = true;
    try {
      currentReportMenu = menu;

      // Sync active nav tab
      document.querySelectorAll(".report-nav-tab").forEach(tab => {
        tab.classList.toggle("report-nav-tab--active", tab.dataset.reportMenu === menu);
      });

      const subTitleEl = document.getElementById("report-header-subtitle");
      if (subTitleEl) {
        subTitleEl.textContent = `Analisis: ${menu.toUpperCase()}`;
      }

      currentReportData = await getReportData(menu);
      const { stats, sourceName } = currentReportData;

      // Update metric numbers
      const statSuccessEl = document.getElementById("report-stat-success");
      const statErrorEl = document.getElementById("report-stat-error");
      const statWarningEl = document.getElementById("report-stat-warning");
      const statTotalEl = document.getElementById("report-stat-total");
      const footerSummaryEl = document.getElementById("report-footer-summary");

      if (statSuccessEl) statSuccessEl.textContent = stats.success;
      if (statErrorEl) statErrorEl.textContent = stats.error;
      if (statWarningEl) statWarningEl.textContent = stats.warning;
      if (statTotalEl) statTotalEl.textContent = stats.total;
      if (footerSummaryEl) footerSummaryEl.textContent = `Sumber: ${sourceName} (${stats.total} Pasien)`;

      updateReportBadge(menu);
      reportVisibleLimit = REPORT_PAGE_SIZE;
      renderReportItemsList();
    } finally {
      isRenderingReportSidebar = false;
    }
  }

  function openHistoryDrawer() {
    closeReportDrawer();
    const sidebar = document.getElementById("history-sidebar");
    if (!sidebar) return;
    sidebar.hidden = false;
    sidebar.classList.add("history-sidebar--open");
    if (historyBackdrop) {
      historyBackdrop.hidden = false;
      requestAnimationFrame(() => {
        historyBackdrop.classList.add("history-backdrop--open");
      });
    }
    // Sinkronkan data sesi terbaru dari ckgbankot Cloud R2 langsung
    syncCloudR2History(currentMenu, true).then(() => {
      renderHistorySidebar(currentTabKey);
    }).catch(() => {});
  }

  function closeHistoryDrawer() {
    const sidebar = document.getElementById("history-sidebar");
    if (!sidebar) return;
    sidebar.classList.remove("history-sidebar--open");
    setTimeout(() => {
      if (!sidebar.classList.contains("history-sidebar--open")) {
        sidebar.hidden = true;
      }
    }, 280);
    if (historyBackdrop) {
      const reportSidebar = document.getElementById("report-sidebar");
      if (!reportSidebar?.classList.contains("report-sidebar--open")) {
        historyBackdrop.classList.remove("history-backdrop--open");
        setTimeout(() => {
          if (!sidebar.classList.contains("history-sidebar--open") && !reportSidebar?.classList.contains("report-sidebar--open")) {
            historyBackdrop.hidden = true;
          }
        }, 260);
      }
    }
  }

  if (btnToggleHistory) {
    btnToggleHistory.addEventListener("click", () => {
      const sidebar = document.getElementById("history-sidebar");
      if (sidebar && sidebar.classList.contains("history-sidebar--open")) {
        closeHistoryDrawer();
      } else {
        openHistoryDrawer();
      }
    });
  }

  if (btnCloseHistory) {
    btnCloseHistory.addEventListener("click", closeHistoryDrawer);
  }

  if (historyBackdrop) {
    historyBackdrop.addEventListener("click", () => {
      closeHistoryDrawer();
      closeReportDrawer();
    });
  }

  async function renderHistorySidebar(tabKey) {
    const mapping = TAB_MENU_MAP[tabKey];
    const sidebar = document.getElementById("history-sidebar");
    const historyList = document.getElementById("history-list");
    const historyEmpty = document.getElementById("history-empty");
    const activeBadge = document.getElementById("history-active-badge");
    const countBadge = document.getElementById("history-count-badge");

    if (!mapping) {
      document.body.classList.remove("has-history-sidebar");
      if (btnToggleHistory) btnToggleHistory.hidden = true;
      closeHistoryDrawer();
      return;
    }

    if (btnToggleHistory) btnToggleHistory.hidden = false;
    document.body.classList.add("has-history-sidebar");
    currentMenu = mapping.menu;
    if (activeBadge) activeBadge.textContent = mapping.label;

    const [list, activeId] = await Promise.all([
      getHistory(currentMenu),
      getActiveLogId(currentMenu)
    ]);

    const count = list?.length || 0;
    if (countBadge) countBadge.textContent = `${count} Sesi`;
    if (historyHeaderBadge) {
      historyHeaderBadge.textContent = count;
      historyHeaderBadge.hidden = count === 0;
    }

    if (!list || list.length === 0) {
      if (historyEmpty) historyEmpty.hidden = false;
      if (historyList) {
        historyList.innerHTML = "";
        historyList.hidden = true;
      }
      return;
    }

    if (historyEmpty) historyEmpty.hidden = true;
    if (historyList) historyList.hidden = false;
    if (!historyList) return;

    historyList.innerHTML = "";

    list.forEach(entry => {
      const card = document.createElement("div");
      const isActive = entry.id === activeId;
      card.className = `history-card${isActive ? " history-card--active" : ""}`;
      card.dataset.id = entry.id;

      // Top row: Date + Live badge + Delete
      const topRow = document.createElement("div");
      topRow.className = "history-card__top";

      const dateRow = document.createElement("div");
      dateRow.className = "history-card__date-row";
      dateRow.innerHTML = `
        <svg class="history-card__date-icon" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="10"/>
          <polyline points="12 6 12 12 16 14"/>
        </svg>
        <span class="history-card__date">${entry.dateStr || "—"}</span>
        ${isActive ? `<span class="history-card__badge-live"><span class="history-card__live-dot"></span>LIVE</span>` : ""}
      `;

      const btnDelete = document.createElement("button");
      btnDelete.type = "button";
      btnDelete.className = "history-card__btn-delete";
      btnDelete.title = "Hapus log ini";
      btnDelete.innerHTML = `
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <line x1="18" y1="6" x2="6" y2="18"></line>
          <line x1="6" y1="6" x2="18" y2="18"></line>
        </svg>
      `;
      btnDelete.addEventListener("click", async e => {
        e.stopPropagation();
        if (confirm("Hapus catatan log ini?")) {
          await deleteLogEntry(currentMenu, entry.id);
          renderHistorySidebar(currentTabKey);
          updateReportBadge(currentMenu);
        }
      });

      topRow.appendChild(dateRow);
      topRow.appendChild(btnDelete);

      // File name row
      const fileRow = document.createElement("div");
      fileRow.className = "history-card__file";
      fileRow.innerHTML = `
        <svg class="history-card__file-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
          <polyline points="14 2 14 8 20 8"></polyline>
        </svg>
        <span class="history-card__file-name" title="${entry.fileName || "File Excel"}">${entry.fileName || "File Excel"}</span>
      `;

      // Stats Grid
      const statsGrid = document.createElement("div");
      if (currentMenu === "pendaftaran") {
        statsGrid.className = "history-card__stats history-card__stats--pendaftaran";
        statsGrid.innerHTML = `
          <div class="history-stat-badge history-stat-badge--success" title="Selesai Daftar">
            <span class="history-stat-num">${entry.berhasil || 0}</span>
            <span class="history-stat-label">Selesai Daftar</span>
          </div>
          <div class="history-stat-badge history-stat-badge--pernah-input" title="Sudah Daftar / Pernah Input">
            <span class="history-stat-num">${entry.pernahInput || 0}</span>
            <span class="history-stat-label">Sudah Daftar</span>
          </div>
          <div class="history-stat-badge history-stat-badge--failed" title="Error / Tidak Valid">
            <span class="history-stat-num">${entry.gagal || 0}</span>
            <span class="history-stat-label">Error</span>
          </div>
        `;
      } else {
        statsGrid.className = "history-card__stats";
        statsGrid.innerHTML = `
          <div class="history-stat-badge history-stat-badge--success" title="Jumlah Berhasil / Selesai">
            <span class="history-stat-num">${entry.berhasil || 0}</span>
            <span class="history-stat-label">Selesai</span>
          </div>
          <div class="history-stat-badge history-stat-badge--failed" title="Jumlah Gagal">
            <span class="history-stat-num">${entry.gagal || 0}</span>
            <span class="history-stat-label">Gagal</span>
          </div>
          <div class="history-stat-badge history-stat-badge--partial" title="Selesai sebagian">
            <span class="history-stat-num">${entry.sebagian || 0}</span>
            <span class="history-stat-label">Sebagian</span>
          </div>
          <div class="history-stat-badge history-stat-badge--pernah-input" title="Pernah di input / Sudah terdaftar">
            <span class="history-stat-num">${entry.pernahInput || 0}</span>
            <span class="history-stat-label">Pernah Input</span>
          </div>
        `;
      }

      // Footer row: Total + Action wrap (Sedang Aktif + Akhiri Sesi or Lanjutkan)
      const footerRow = document.createElement("div");
      footerRow.className = "history-card__footer";
      footerRow.innerHTML = `
        <span class="history-card__total">Total: <strong>${entry.total || 0}</strong></span>
      `;

      const actionWrap = document.createElement("div");
      actionWrap.className = "history-card__action-wrap";

      const btnResume = document.createElement("button");
      btnResume.type = "button";
      btnResume.className = `btn-resume-log${isActive ? " btn-resume-log--active" : ""}`;
      btnResume.innerHTML = `
        <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor">
          <polygon points="5 3 19 12 5 21 5 3"></polygon>
        </svg>
        <span>${isActive ? "Sedang Aktif" : "Lanjutkan"}</span>
      `;

      btnResume.addEventListener("click", async () => {
        let resumed = false;
        if (currentMenu === "pendaftaran" && pendaftaranTab?.resumeFromLog) {
          resumed = await pendaftaranTab.resumeFromLog(entry);
        } else if (currentMenu === "pasien" && pelayananInstanTab?.resumeFromLog) {
          resumed = await pelayananInstanTab.resumeFromLog(entry);
        } else if (currentMenu === "pelayanan" && pelayananTab?.resumeFromLog) {
          resumed = await pelayananTab.resumeFromLog(entry);
        }
        if (resumed) {
          renderHistorySidebar(currentTabKey);
        }
      });

      actionWrap.appendChild(btnResume);

      if (isActive) {
        const btnEndSession = document.createElement("button");
        btnEndSession.type = "button";
        btnEndSession.className = "btn-end-session";
        btnEndSession.title = "Akhiri sesi aktif ini dan reset untuk memulai sesi baru";
        btnEndSession.innerHTML = `
          <svg width="9" height="9" viewBox="0 0 24 24" fill="currentColor">
            <rect x="4" y="4" width="16" height="16" rx="2" />
          </svg>
          <span>Akhiri Sesi</span>
        `;
        btnEndSession.addEventListener("click", async e => {
          e.stopPropagation();
          await handleEndSessionClick(currentMenu);
        });
        actionWrap.appendChild(btnEndSession);
      }

      footerRow.appendChild(actionWrap);

      card.appendChild(topRow);
      card.appendChild(fileRow);
      card.appendChild(statsGrid);
      card.appendChild(footerRow);

      historyList.appendChild(card);
    });
  }

  const btnNewSession = document.getElementById("btn-new-session");

  async function handleNewSessionClick() {
    if (currentMenu === "pasien") {
      const { pelayananRunning } = await chrome.storage.session.get("pelayananRunning");
      if (pelayananRunning) {
        alert("Otomasi sedang berjalan. Hentikan otomasi terlebih dahulu sebelum membuat sesi baru.");
        return;
      }
    } else if (currentMenu === "pendaftaran") {
      const { pendaftaranRunning } = await chrome.storage.session.get("pendaftaranRunning");
      if (pendaftaranRunning) {
        alert("Otomasi sedang berjalan. Hentikan otomasi terlebih dahulu sebelum membuat sesi baru.");
        return;
      }
    }

    const customName = prompt("Masukkan nama untuk sesi ini (opsional):", "");
    if (customName === null) return; // User batalkan

    let created = false;
    if (currentMenu === "pendaftaran" && pendaftaranTab?.createNewSession) {
      created = await pendaftaranTab.createNewSession(customName.trim());
    } else if (currentMenu === "pasien" && pelayananInstanTab?.createNewSession) {
      created = await pelayananInstanTab.createNewSession(customName.trim());
    } else if (currentMenu === "pelayanan" && pelayananTab?.createNewSession) {
      created = await pelayananTab.createNewSession(customName.trim());
    }

    if (created) {
      renderHistorySidebar(currentTabKey);
    }
  }

  async function handleEndSessionClick(menu) {
    if (menu === "pasien") {
      const { pelayananRunning } = await chrome.storage.session.get("pelayananRunning");
      if (pelayananRunning) {
        alert("Otomasi sedang berjalan. Hentikan otomasi terlebih dahulu sebelum mengakhiri sesi.");
        return;
      }
    } else if (menu === "pendaftaran") {
      const { pendaftaranRunning } = await chrome.storage.session.get("pendaftaranRunning");
      if (pendaftaranRunning) {
        alert("Otomasi sedang berjalan. Hentikan otomasi terlebih dahulu sebelum mengakhiri sesi.");
        return;
      }
    } else if (menu === "pelayanan") {
      const { otomasiRunning } = await chrome.storage.session.get("otomasiRunning");
      if (otomasiRunning) {
        alert("Otomasi sedang berjalan. Hentikan otomasi terlebih dahulu sebelum mengakhiri sesi.");
        return;
      }
    }

    const confirmEnd = confirm("Akhiri sesi aktif ini? Riwayat sesi akan tetap tersimpan dan bot siap memulai sesi baru.");
    if (!confirmEnd) return;

    let ended = false;
    if (menu === "pendaftaran" && pendaftaranTab?.endActiveSession) {
      ended = await pendaftaranTab.endActiveSession();
    } else if (menu === "pasien" && pelayananInstanTab?.endActiveSession) {
      ended = await pelayananInstanTab.endActiveSession();
    } else if (menu === "pelayanan" && pelayananTab?.endActiveSession) {
      ended = await pelayananTab.endActiveSession();
    }

    if (ended) {
      renderHistorySidebar(currentTabKey);
    }
  }

  if (btnNewSession) btnNewSession.addEventListener("click", handleNewSessionClick);

  const btnClearHistory = document.getElementById("btn-clear-history");
  if (btnClearHistory) {
    btnClearHistory.addEventListener("click", async () => {
      if (confirm(`Bersihkan semua log history untuk menu ${currentMenu.toUpperCase()}?`)) {
        await clearHistory(currentMenu);
        renderHistorySidebar(currentTabKey);
      }
    });
  }

  const btnExportHistory = document.getElementById("btn-export-history");
  if (btnExportHistory) {
    btnExportHistory.addEventListener("click", async () => {
      try {
        await exportHistoryData();
      } catch (err) {
        alert(`Gagal export riwayat log: ${err.message}`);
      }
    });
  }

  const btnImportHistory = document.getElementById("btn-import-history");
  const inputImportHistory = document.getElementById("input-import-history");
  if (btnImportHistory && inputImportHistory) {
    btnImportHistory.addEventListener("click", () => {
      inputImportHistory.click();
    });

    inputImportHistory.addEventListener("change", async e => {
      const file = e.target.files?.[0];
      if (!file) return;

      const reader = new FileReader();
      reader.onload = async event => {
        try {
          const content = event.target.result;
          const res = await importHistoryData(content, true);
          alert(`Berhasil mengimpor riwayat log! (${res.count} catatan baru ditambahkan/digabung)`);
          renderHistorySidebar(currentTabKey);
        } catch (err) {
          alert(`Gagal mengimpor log: ${err.message}`);
        } finally {
          inputImportHistory.value = "";
        }
      };
      reader.readAsText(file);
    });
  }

  onHistoryChange(changedMenu => {
    if (changedMenu === currentMenu) {
      renderHistorySidebar(currentTabKey);
    }
  });

  // ── Tab & Tile Activity Indicators ──────────────────────────
  async function updateTabActivityIndicators() {
    try {
      const {
        pendaftaranRunning = false,
        pelayananRunning = false,
        otomasiRunning = false,
        daftarLayaniRunning = false
      } = await chrome.storage.session.get([
        "pendaftaranRunning",
        "pelayananRunning",
        "otomasiRunning",
        "daftarLayaniRunning"
      ]);

      const tilePendaftaran = document.querySelector('.metro-tile[data-tab="pendaftaran"]');
      const tilePasien = document.querySelector('.metro-tile[data-tab="pelayanan-instan"]');
      const tilePelayanan = document.querySelector('.metro-tile[data-tab="otomasi"]');
      const tileDaftarLayani = document.querySelector('.metro-tile[data-tab="daftar-layani"]');

      if (tilePendaftaran) {
        tilePendaftaran.classList.toggle("metro-tile--running", !!pendaftaranRunning);
        const ind = tilePendaftaran.querySelector('[data-tab-indicator="pendaftaran"]');
        if (ind) ind.textContent = pendaftaranRunning ? "Berjalan" : "";
      }
      if (tilePasien) {
        tilePasien.classList.toggle("metro-tile--running", !!pelayananRunning);
        const ind = tilePasien.querySelector('[data-tab-indicator="pelayanan-instan"]');
        if (ind) ind.textContent = pelayananRunning ? "Berjalan" : "";
      }
      if (tilePelayanan) {
        tilePelayanan.classList.toggle("metro-tile--running", !!otomasiRunning);
        const ind = tilePelayanan.querySelector('[data-tab-indicator="otomasi"]');
        if (ind) ind.textContent = otomasiRunning ? "Berjalan" : "";
      }
      if (tileDaftarLayani) {
        tileDaftarLayani.classList.toggle("metro-tile--running", !!daftarLayaniRunning);
        const ind = tileDaftarLayani.querySelector('[data-tab-indicator="daftar-layani"]');
        if (ind) ind.textContent = daftarLayaniRunning ? "Berjalan" : "";
      }

      const { vpn_config } = await chrome.storage.local.get(["vpn_config"]);
      const tileVpn = document.querySelector('.metro-tile[data-tab="vpn-proxy"]');
      const pillVpn = document.getElementById("vpn-metro-pill");
      const isVpnOn = !!vpn_config?.enabled;
      if (tileVpn) {
        tileVpn.classList.toggle("metro-tile--active-vpn", isVpnOn);
      }
      if (pillVpn) {
        pillVpn.textContent = isVpnOn ? "ON" : "OFF";
        pillVpn.className = isVpnOn ? "vpn-status-pill vpn-status-pill--on" : "vpn-status-pill vpn-status-pill--off";
      }
    } catch (e) {
      console.error("[updateTabActivityIndicators] error:", e);
    }
  }

  let popupActivityDebounceTimer = null;
  function notifyPopupActivityChange() {
    if (popupActivityDebounceTimer) clearTimeout(popupActivityDebounceTimer);
    popupActivityDebounceTimer = setTimeout(() => {
      updateTabActivityIndicators();
      updateReportBadge(currentReportMenu);
      if (reportSidebar && reportSidebar.classList.contains("report-sidebar--open")) {
        renderReportSidebar(currentReportMenu);
      }
    }, 400);
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "session") {
      if ("pendaftaranRunning" in changes || "pelayananRunning" in changes || "otomasiRunning" in changes || "daftarLayaniRunning" in changes || "pendaftaranPatients" in changes || "pelayanan-instan-records" in changes || "pelayananExcelPatients" in changes) {
        notifyPopupActivityChange();
      }
    }
    if (area === "local" && "vpn_config" in changes) {
      updateTabActivityIndicators();
    }
  });

  chrome.runtime.onMessage.addListener(msg => {
    if (
      msg.type === "PENDAFTARAN_STATUS" ||
      msg.type === "PENDAFTARAN_QUEUE_DONE" ||
      msg.type === "PENDAFTARAN_ALL_STOPPED" ||
      msg.type === "PELAYANAN_INSTAN_STATUS" ||
      msg.type === "PELAYANAN_QUEUE_DONE" ||
      msg.type === "PELAYANAN_ALL_STOPPED" ||
      msg.type === "DONE" ||
      msg.type === "STOP" ||
      msg.type === "PROGRESS"
    ) {
      notifyPopupActivityChange();
    }
  });

  showOfflineScreen({ user_metadata: { full_name: "Offline User" } });
  setupOffline();

  let popupState = null;
  let savedTab = "home";
  let bgState = {};

  try {
    const sRes = await chrome.storage.session.get(["popupState", "activeTab"]);
    popupState = sRes?.popupState || null;
    savedTab = sRes?.activeTab || "home";
  } catch (_) { }

  try {
    bgState = await sendToBackground({ type: "GET_STATE" }) || {};
  } catch (_) { }

  const initialTab = savedTab || "home";
  try {
    switchTab(initialTab);
  } catch (err) {
    console.warn("[popup] switchTab error:", err);
  }

  try {
    if (pelayananTab?.restoreState) {
      await pelayananTab.restoreState(popupState, bgState);
    }
  } catch (_) { }

  try {
    await updateTabActivityIndicators();
  } catch (_) { }

  try {
    await updateReportBadge(currentReportMenu);
  } catch (_) { }

  // ── Session Keep-Alive HUD Controller ───────────────────────
  function initSessionHeartbeatHUD() {
    const hudEl = document.getElementById("session-heartbeat-hud");
    const dotEl = document.getElementById("session-heartbeat-dot");
    const textEl = document.getElementById("session-heartbeat-text");
    const timeEl = document.getElementById("session-heartbeat-time");
    const btnPing = document.getElementById("btn-ping-session-hud");
    const btnLoginAsik = document.getElementById("btn-login-asik-hud");
    if (!hudEl || !dotEl || !textEl || !timeEl) return;

    function formatTimeAgo(ts) {
      if (!ts) return "--";
      const diffSec = Math.floor((Date.now() - ts) / 1000);
      if (diffSec < 10) return "baru saja";
      if (diffSec < 60) return `${diffSec}d lalu`;
      const diffMin = Math.floor(diffSec / 60);
      return `${diffMin}m lalu`;
    }

    function renderStatus(statusObj) {
      if (!statusObj) {
        dotEl.className = "session-heartbeat__dot session-heartbeat__dot--unknown";
        textEl.textContent = "Belum diperiksa";
        textEl.className = "session-heartbeat__text";
        timeEl.textContent = "--";
        return;
      }

      const { state, user, faskes, message, lastPing } = statusObj;
      dotEl.className = `session-heartbeat__dot session-heartbeat__dot--${state || "unknown"}`;
      timeEl.textContent = formatTimeAgo(lastPing);
      if (btnLoginAsik) btnLoginAsik.hidden = state === "active";

      textEl.className = "session-heartbeat__text";
      if (state === "active") {
        textEl.classList.add("session-heartbeat__text--active");
        textEl.textContent = user ? `${user}${faskes ? ` (${faskes})` : ""}` : "Sesi Aktif";
        hudEl.title = `Sesi Aktif: ${user} - ${faskes} (Klik untuk buka/refresh tab ASIK)`;
      } else if (state === "expired") {
        textEl.classList.add("session-heartbeat__text--expired");
        textEl.textContent = "Sesi Kedaluwarsa (401) — Login Ulang!";
        hudEl.title = "Sesi telah kedaluwarsa. Klik untuk membuka tab ASIK dan login kembali.";
      } else if (state === "login_page") {
        textEl.classList.add("session-heartbeat__text--expired");
        textEl.textContent = "Halaman Login ASIK (Belum Login)";
        hudEl.title = "Tab ASIK berada di halaman login. Klik untuk buka tab.";
      } else if (state === "no_tab") {
        textEl.textContent = "Tab ASIK Belum Dibuka";
        hudEl.title = "Tab Sehat Indonesiaku belum terbuka. Klik untuk buka web ASIK.";
      } else {
        textEl.textContent = message || "Sesi Belum Terbaca";
        hudEl.title = message || "";
      }
    }

    // Load initial status
    chrome.storage.local.get("ckg_heartbeat_status").then(({ ckg_heartbeat_status }) => {
      renderStatus(ckg_heartbeat_status);
    });

    // Listen for live updates
    chrome.runtime.onMessage.addListener(msg => {
      if (msg.type === "CKG_HEARTBEAT_STATUS") {
        renderStatus(msg.payload);
      }
    });

    // Login ASIK button
    if (btnLoginAsik) {
      btnLoginAsik.addEventListener("click", async (e) => {
        e.stopPropagation();
        try {
          const LOGIN_URL = "https://sehatindonesiaku.kemkes.go.id/login";
          const tabs = await chrome.tabs.query({ url: "https://sehatindonesiaku.kemkes.go.id/*" });
          if (tabs && tabs.length > 0) {
            const targetTab = tabs.find(t => t.url?.includes("/login")) || tabs[0];
            if (!targetTab.url?.includes("/login")) {
              await chrome.tabs.update(targetTab.id, { url: LOGIN_URL, active: true });
            } else {
              await chrome.tabs.update(targetTab.id, { active: true });
            }
            if (targetTab.windowId) await chrome.windows.update(targetTab.windowId, { focused: true });
          } else {
            await chrome.tabs.create({ url: LOGIN_URL, active: true });
          }
        } catch (_) { }
      });
    }

    // Ping button
    if (btnPing) {
      btnPing.addEventListener("click", async (e) => {
        e.stopPropagation();
        btnPing.classList.add("spinning");
        try {
          const res = await chrome.runtime.sendMessage({ type: "CKG_HEARTBEAT_PING" });
          if (res?.status) renderStatus(res.status);
        } catch (err) {
          console.error("Ping error:", err);
        } finally {
          setTimeout(() => btnPing.classList.remove("spinning"), 600);
        }
      });
    }

    // Clicking HUD bar brings/opens ASIK tab
    hudEl.addEventListener("click", async () => {
      try {
        const CKG_URL = "https://sehatindonesiaku.kemkes.go.id";
        const tabs = await chrome.tabs.query({ url: `${CKG_URL}/*` });
        if (tabs && tabs.length > 0) {
          await chrome.tabs.update(tabs[0].id, { active: true });
          if (tabs[0].windowId) await chrome.windows.update(tabs[0].windowId, { focused: true });
        } else {
          await chrome.tabs.create({ url: `${CKG_URL}/`, active: true });
        }
      } catch (_) { }
    });

    // Auto ping if no ping in last 2 minutes or never pinged
    chrome.storage.local.get("ckg_heartbeat_status").then(({ ckg_heartbeat_status }) => {
      const last = ckg_heartbeat_status?.lastPing || 0;
      if (Date.now() - last > 120000) {
        chrome.runtime.sendMessage({ type: "CKG_HEARTBEAT_PING" }).then(res => {
          if (res?.status) renderStatus(res.status);
        }).catch(() => { });
      }
    });
  }

  // Initialize real-time network latency monitor & heartbeat
  try {
    initPingMonitor();
  } catch (err) {
    console.warn("[popup] initPingMonitor error:", err);
  }

  try {
    initSessionHeartbeatHUD();
  } catch (err) {
    console.warn("[popup] initSessionHeartbeatHUD error:", err);
  }
}

// Global modal picker untuk memilih kategori antrean CKG Bankot (CKG UMUM vs CKG SEKOLAH)
window.showCkgBankotCategoryPicker = function () {
  return new Promise((resolve) => {
    const modal = document.getElementById("modal-ckgbankot-picker");
    const btnUmum = document.getElementById("btn-pick-ckgbankot-umum");
    const btnSekolah = document.getElementById("btn-pick-ckgbankot-sekolah");
    const btnClose = document.getElementById("btn-close-ckgbankot-modal");
    const statusEl = document.getElementById("ckgbankot-modal-status");

    if (!modal) {
      resolve(null);
      return;
    }

    if (statusEl) {
      statusEl.style.display = "none";
      statusEl.textContent = "";
    }

    modal.style.display = "flex";

    const cleanUp = () => {
      modal.style.display = "none";
      btnUmum?.removeEventListener("click", onUmum);
      btnSekolah?.removeEventListener("click", onSekolah);
      btnClose?.removeEventListener("click", onClose);
      modal.removeEventListener("click", onBackdrop);
    };

    const onUmum = () => {
      cleanUp();
      resolve("UMUM");
    };

    const onSekolah = () => {
      cleanUp();
      resolve("SEKOLAH");
    };

    const onClose = () => {
      cleanUp();
      resolve(null);
    };

    const onBackdrop = (e) => {
      if (e.target === modal) {
        cleanUp();
        resolve(null);
      }
    };

    btnUmum?.addEventListener("click", onUmum);
    btnSekolah?.addEventListener("click", onSekolah);
    btnClose?.addEventListener("click", onClose);
    modal.addEventListener("click", onBackdrop);
  });
};

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initPopup);
} else {
  initPopup();
}