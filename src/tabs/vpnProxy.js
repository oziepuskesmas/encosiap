/**
 * vpnProxy.js
 * Controller for VPN & Anti-429 Proxy Manager (Server Indonesia & WARP).
 * Allows users to route Kemkes requests through Indonesian proxies, Cloudflare WARP, or custom proxies
 * to bypass HTTP 429 Too Many Requests rate limiting.
 */

export const DEFAULT_INDONESIA_SERVERS = [
  {
    id: "id-jkt-01",
    name: "🇮🇩 Jakarta 01 - Telkomsel Edge (SOCKS5)",
    scheme: "socks5",
    host: "103.134.220.143",
    port: 1080,
    city: "Jakarta",
    isp: "Telkom Indonesia"
  },
  {
    id: "id-sby-02",
    name: "🇮🇩 Surabaya 02 - Biznet High Speed (SOCKS5)",
    scheme: "socks5",
    host: "103.82.246.21",
    port: 80,
    city: "Surabaya",
    isp: "Biznet Networks"
  },
  {
    id: "id-bdg-03",
    name: "🇮🇩 Bandung 03 - Moratel Fast HTTP (HTTP)",
    scheme: "http",
    host: "103.189.63.149",
    port: 8080,
    city: "Bandung",
    isp: "Mora Telematika"
  },
  {
    id: "id-jkt-04",
    name: "🇮🇩 Jakarta 04 - Matrix NAP Datacenter (SOCKS5)",
    scheme: "socks5",
    host: "8.215.25.3",
    port: 2080,
    city: "Jakarta",
    isp: "Matrix NAP Info"
  },
  {
    id: "id-jog-05",
    name: "🇮🇩 Yogyakarta 05 - Citraweb Server (SOCKS5)",
    scheme: "socks5",
    host: "103.26.209.206",
    port: 1080,
    city: "Yogyakarta",
    isp: "Citraweb Nusantara"
  }
];

export const WARP_CONFIG = {
  id: "cf-warp",
  name: "⚡ Cloudflare WARP 1.1.1.1 (Local SOCKS5)",
  scheme: "socks5",
  host: "127.0.0.1",
  port: 40000,
  city: "Jakarta (CGK Datacenter)",
  isp: "Cloudflare Warp Edge"
};

const DEFAULT_STATE = {
  enabled: false,
  mode: "preset-id", // 'preset-id' | 'warp' | 'custom'
  serverIndex: 0,
  routeScope: "kemkes", // 'kemkes' | 'all'
  safeThrottle: true,
  custom: {
    scheme: "socks5",
    host: "127.0.0.1",
    port: 10808
  }
};

/**
 * Apply proxy configuration via chrome.proxy API.
 */
export async function setChromeProxy(config) {
  if (!chrome?.proxy?.settings) {
    console.warn("[VPN] chrome.proxy.settings API not available.");
    return false;
  }

  if (!config.enabled) {
    return new Promise((resolve) => {
      chrome.proxy.settings.clear({ scope: "regular" }, () => {
        chrome.proxy.settings.set({ value: { mode: "direct" }, scope: "regular" }, () => {
          console.log("[VPN] Proxy dinonaktifkan (DIRECT mode aktif)");
          resolve(true);
        });
      });
    });
  }

  let targetScheme = "socks5";
  let targetHost = "127.0.0.1";
  let targetPort = 40000;

  if (config.mode === "warp") {
    targetScheme = "socks5";
    targetHost = "127.0.0.1";
    targetPort = 40000;
  } else if (config.mode === "custom") {
    targetScheme = (config.custom?.scheme || "socks5").toLowerCase();
    targetHost = (config.custom?.host || "127.0.0.1").trim();
    targetPort = parseInt(config.custom?.port || 10808, 10);
  } else {
    // preset-id
    const srv = DEFAULT_INDONESIA_SERVERS[config.serverIndex] || DEFAULT_INDONESIA_SERVERS[0];
    targetScheme = (srv.scheme || "socks5").toLowerCase();
    targetHost = srv.host;
    targetPort = parseInt(srv.port, 10);
  }

  const pacScheme = targetScheme.toUpperCase();

  if (config.routeScope === "kemkes") {
    // Only route Kemkes domains through the proxy, keep other traffic DIRECT
    const pacScript = `
function FindProxyForURL(url, host) {
  if (
    shExpMatch(host, "*.kemkes.go.id") ||
    shExpMatch(host, "kemkes.go.id") ||
    shExpMatch(host, "form.kemkes.go.id") ||
    shExpMatch(host, "sehatindonesiaku.kemkes.go.id")
  ) {
    return "${pacScheme} ${targetHost}:${targetPort}; DIRECT";
  }
  return "DIRECT";
}
`.trim();

    return new Promise((resolve) => {
      chrome.proxy.settings.set(
        {
          value: {
            mode: "pac_script",
            pacScript: { data: pacScript }
          },
          scope: "regular"
        },
        () => {
          if (chrome.runtime.lastError) {
            console.error("[VPN] Proxy PAC set error:", chrome.runtime.lastError);
            resolve(false);
          } else {
            console.log(`[VPN] Proxy PAC aktif: Kemkes -> ${pacScheme} ${targetHost}:${targetPort}`);
            resolve(true);
          }
        }
      );
    });
  } else {
    // Route all browser traffic through proxy
    return new Promise((resolve) => {
      chrome.proxy.settings.set(
        {
          value: {
            mode: "fixed_servers",
            rules: {
              singleProxy: {
                scheme: targetScheme,
                host: targetHost,
                port: targetPort
              },
              bypassList: ["<local>", "127.0.0.1", "localhost"]
            }
          },
          scope: "regular"
        },
        () => {
          if (chrome.runtime.lastError) {
            console.error("[VPN] Proxy fixed_servers error:", chrome.runtime.lastError);
            resolve(false);
          } else {
            console.log(`[VPN] Proxy All aktif: ${targetScheme}://${targetHost}:${targetPort}`);
            resolve(true);
          }
        }
      );
    });
  }
}

/**
 * Close all tabs that are currently displaying "429 Too Many Requests"
 */
export async function closeStuck429Tabs() {
  try {
    const tabs = await chrome.tabs.query({});
    let count = 0;
    for (const tab of tabs) {
      const title = (tab.title || "").trim().toLowerCase();
      const url = (tab.url || "").toLowerCase();
      if (
        title === "429" ||
        title.includes("429") ||
        title.includes("too many requests") ||
        (url.includes("form.kemkes.go.id") && (title === "429" || title.includes("429")))
      ) {
        if (tab.id) {
          await chrome.tabs.remove(tab.id).catch(() => {});
          count++;
        }
      }
    }
    return count;
  } catch (err) {
    console.error("[VPN] Error closing 429 tabs:", err);
    return 0;
  }
}

/**
 * Check public IP, country, and WARP status via Cloudflare trace & ipwho.is
 */
export async function checkNetworkStatus() {
  const result = {
    ip: "—",
    country: "Indonesia 🇮🇩",
    isIndonesia: true,
    warp: false,
    colo: "—",
    isp: "—",
    kemkesStatus: "Memeriksa..."
  };

  try {
    const cf = await fetch("https://1.1.1.1/cdn-cgi/trace", { cache: "no-store" });
    if (cf.ok) {
      const text = await cf.text();
      const lines = text.split("\n");
      for (const line of lines) {
        const [k, v] = line.split("=");
        if (k === "ip") result.ip = v.trim();
        if (k === "loc") {
          result.isIndonesia = (v.trim().toUpperCase() === "ID");
          result.country = result.isIndonesia ? "Indonesia 🇮🇩" : `${v.trim()} (Luar Negeri)`;
        }
        if (k === "warp") result.warp = (v.trim() === "on");
        if (k === "colo") result.colo = v.trim();
      }
    }
  } catch (err) {
    console.warn("[VPN] Cloudflare trace error:", err);
  }

  try {
    const who = await fetch("https://ipwho.is/", { cache: "no-store" });
    if (who.ok) {
      const data = await who.json();
      if (data.success) {
        result.ip = data.ip || result.ip;
        result.country = `${data.country} ${data.flag?.emoji || "🇮🇩"}`;
        result.isp = data.connection?.isp || data.connection?.org || "—";
        result.isIndonesia = (data.country_code === "ID");
      }
    }
  } catch (err) {}

  try {
    const start = performance.now();
    await fetch("https://sehatindonesiaku.kemkes.go.id/favicon.ico", {
      mode: "no-cors",
      cache: "no-store"
    });
    const ms = Math.round(performance.now() - start);
    result.kemkesStatus = `Online (${ms}ms)`;
  } catch (err) {
    result.kemkesStatus = "Offline / Lambat";
  }

  return result;
}

/**
 * Initialize VPN/Proxy tab in ENCO Mobile popup
 */
export async function init() {
  // Elements
  const masterToggle = document.getElementById("vpn-master-toggle");
  const bannerStatus = document.getElementById("vpn-banner-status");
  const bannerSub = document.getElementById("vpn-banner-sub");
  const currentIpEl = document.getElementById("vpn-current-ip");
  const currentLocationEl = document.getElementById("vpn-current-location");
  const currentWarpEl = document.getElementById("vpn-current-warp");
  const kemkesStatusEl = document.getElementById("vpn-kemkes-status");
  const btnCheckIp = document.getElementById("btn-vpn-check-ip");
  const modeSelect = document.getElementById("vpn-mode-select");
  const presetSection = document.getElementById("vpn-preset-section");
  const warpSection = document.getElementById("vpn-warp-section");
  const customSection = document.getElementById("vpn-custom-section");
  const serverSelect = document.getElementById("vpn-server-select");
  const btnRotateServer = document.getElementById("btn-vpn-rotate-server");
  const routeScopeSelect = document.getElementById("vpn-route-scope");
  const customScheme = document.getElementById("vpn-custom-scheme");
  const customHost = document.getElementById("vpn-custom-host");
  const customPort = document.getElementById("vpn-custom-port");
  const btnSaveCustom = document.getElementById("btn-vpn-save-custom");
  const btnClose429 = document.getElementById("btn-vpn-close-429");
  const statusMsg = document.getElementById("vpn-status-msg");
  const metroPill = document.getElementById("vpn-metro-pill");
  const safeThrottleCb = document.getElementById("vpn-safe-throttle");

  // Load state from storage
  const stored = await chrome.storage.local.get(["vpn_config"]);
  const state = { ...DEFAULT_STATE, ...(stored.vpn_config || {}) };

  // Populate server select options
  if (serverSelect) {
    serverSelect.innerHTML = "";
    DEFAULT_INDONESIA_SERVERS.forEach((srv, idx) => {
      const opt = document.createElement("option");
      opt.value = String(idx);
      opt.textContent = `${srv.name} (${srv.city})`;
      serverSelect.appendChild(opt);
    });
    serverSelect.value = String(state.serverIndex || 0);
  }

  // Update UI components according to state
  function updateUI() {
    const isEnabled = !!state.enabled;

    if (masterToggle) masterToggle.checked = isEnabled;
    if (safeThrottleCb) safeThrottleCb.checked = !!state.safeThrottle;
    if (modeSelect) modeSelect.value = state.mode;
    if (routeScopeSelect) routeScopeSelect.value = state.routeScope;

    if (customScheme) customScheme.value = state.custom?.scheme || "socks5";
    if (customHost) customHost.value = state.custom?.host || "127.0.0.1";
    if (customPort) customPort.value = state.custom?.port || 10808;

    // Visibility of sections
    if (presetSection) presetSection.hidden = state.mode !== "preset-id";
    if (warpSection) warpSection.hidden = state.mode !== "warp";
    if (customSection) customSection.hidden = state.mode !== "custom";

    // Update banner & pill
    const tileAmber = document.querySelector('.metro-tile[data-tab="vpn-proxy"]');
    if (tileAmber) {
      tileAmber.classList.toggle("metro-tile--active-vpn", isEnabled);
    }

    if (metroPill) {
      metroPill.textContent = isEnabled ? "ON" : "OFF";
      metroPill.classList.toggle("vpn-status-pill--on", isEnabled);
      metroPill.classList.toggle("vpn-status-pill--off", !isEnabled);
    }

    if (bannerStatus) {
      bannerStatus.textContent = isEnabled ? "PROXY AKTIF" : "KONEKSI DIRECT (OFF)";
      bannerStatus.className = isEnabled ? "vpn-banner-title vpn-banner-title--on" : "vpn-banner-title vpn-banner-title--off";
    }

    if (bannerSub) {
      if (!isEnabled) {
        bannerSub.textContent = "Koneksi normal tanpa proxy. Aktifkan jika mengalami error 429.";
      } else if (state.mode === "warp") {
        bannerSub.textContent = "Rute via Cloudflare WARP 1.1.1.1 (Jakarta CGK Edge)";
      } else if (state.mode === "custom") {
        bannerSub.textContent = `Rute via Custom ${state.custom?.scheme?.toUpperCase()} (${state.custom?.host}:${state.custom?.port})`;
      } else {
        const srv = DEFAULT_INDONESIA_SERVERS[state.serverIndex] || DEFAULT_INDONESIA_SERVERS[0];
        bannerSub.textContent = `Rute via Server ${srv.city}, Indonesia (${srv.isp})`;
      }
    }
  }

  async function saveAndApply() {
    await chrome.storage.local.set({ vpn_config: state });
    updateUI();
    const ok = await setChromeProxy(state);
    if (statusMsg) {
      statusMsg.hidden = false;
      statusMsg.textContent = ok
        ? (state.enabled ? "✅ Proxy berhasil diaktifkan!" : "ℹ️ Proxy dinonaktifkan (Direct).")
        : "⚠️ Gagal memperbarui proxy Chrome.";
      setTimeout(() => {
        if (statusMsg) statusMsg.hidden = true;
      }, 3500);
    }
    // Refresh IP display after a short pause
    setTimeout(refreshNetworkInfo, 800);
  }

  async function refreshNetworkInfo() {
    if (btnCheckIp) {
      btnCheckIp.disabled = true;
      btnCheckIp.textContent = "Memeriksa...";
    }
    if (currentIpEl) currentIpEl.textContent = "Mendeteksi...";
    if (currentLocationEl) currentLocationEl.textContent = "Mendeteksi...";
    if (kemkesStatusEl) kemkesStatusEl.textContent = "Ping...";

    const info = await checkNetworkStatus();

    if (currentIpEl) currentIpEl.textContent = info.ip;
    if (currentLocationEl) currentLocationEl.textContent = `${info.country} • ${info.isp}`;
    if (currentWarpEl) {
      currentWarpEl.textContent = info.warp ? "WARP ON ⚡" : "WARP OFF";
      currentWarpEl.className = info.warp ? "badge badge--success" : "badge badge--neutral";
    }
    if (kemkesStatusEl) {
      kemkesStatusEl.textContent = info.kemkesStatus;
      kemkesStatusEl.className = info.kemkesStatus.includes("Online") ? "badge badge--success" : "badge badge--warning";
    }

    if (btnCheckIp) {
      btnCheckIp.disabled = false;
      btnCheckIp.textContent = "🔍 Cek IP & Kemkes";
    }
  }

  // Event Listeners
  if (masterToggle) {
    masterToggle.addEventListener("change", () => {
      state.enabled = masterToggle.checked;
      saveAndApply();
    });
  }

  if (modeSelect) {
    modeSelect.addEventListener("change", () => {
      state.mode = modeSelect.value;
      saveAndApply();
    });
  }

  if (serverSelect) {
    serverSelect.addEventListener("change", () => {
      state.serverIndex = parseInt(serverSelect.value, 10);
      saveAndApply();
    });
  }

  if (btnRotateServer) {
    btnRotateServer.addEventListener("click", () => {
      state.serverIndex = (state.serverIndex + 1) % DEFAULT_INDONESIA_SERVERS.length;
      if (serverSelect) serverSelect.value = String(state.serverIndex);
      state.enabled = true; // Auto-enable when rotating server
      saveAndApply();
    });
  }

  if (routeScopeSelect) {
    routeScopeSelect.addEventListener("change", () => {
      state.routeScope = routeScopeSelect.value;
      saveAndApply();
    });
  }

  if (btnSaveCustom) {
    btnSaveCustom.addEventListener("click", () => {
      state.custom = {
        scheme: customScheme?.value || "socks5",
        host: (customHost?.value || "127.0.0.1").trim(),
        port: parseInt(customPort?.value || 10808, 10)
      };
      state.enabled = true;
      saveAndApply();
    });
  }

  if (safeThrottleCb) {
    safeThrottleCb.addEventListener("change", () => {
      state.safeThrottle = safeThrottleCb.checked;
      chrome.storage.local.set({ vpn_config: state });
    });
  }

  if (btnClose429) {
    btnClose429.addEventListener("click", async () => {
      btnClose429.disabled = true;
      btnClose429.textContent = "Membersihkan...";
      const closed = await closeStuck429Tabs();
      btnClose429.disabled = false;
      btnClose429.textContent = "🧹 Tutup Semua Tab 429 Macet";
      if (statusMsg) {
        statusMsg.hidden = false;
        statusMsg.textContent = closed > 0
          ? `✅ Berhasil menutup ${closed} tab yang terkena error 429!`
          : "ℹ️ Tidak ditemukan tab dengan error 429.";
        setTimeout(() => {
          if (statusMsg) statusMsg.hidden = true;
        }, 3500);
      }
    });
  }

  if (btnCheckIp) {
    btnCheckIp.addEventListener("click", refreshNetworkInfo);
  }

  // Initial render
  updateUI();
  refreshNetworkInfo();

  return {
    getState: () => state,
    isEnabled: () => !!state.enabled,
    isSafeThrottleActive: () => !!state.safeThrottle,
    refreshUI: updateUI,
    close429Tabs: closeStuck429Tabs
  };
}
