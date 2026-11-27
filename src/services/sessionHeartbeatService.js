/**
 * sessionHeartbeatService.js
 * Fitur Session Keep-Alive (Heartbeat Ping) untuk Sehat Indonesiaku (ASIK / Kemenkes).
 * 
 * Menjaga sesi login tetap aktif dengan cara:
 * 1. Mengirim ping ringan berkala (fetch /api/user-management/me) dari dalam tab ASIK.
 * 2. Mengirim sinyal event aktivitas (mousemove/scroll) agar proteksi idle di web tidak auto-logout.
 * 3. Memantau status sesi (Aktif 200, Kedaluwarsa 401, atau Tab Belum Dibuka) secara realtime.
 */

const CKG_URL = "https://sehatindonesiaku.kemkes.go.id";
export const CKG_HEARTBEAT_ALARM = "ckgHeartbeatAlarm";

/**
 * Mencari tab Sehat Indonesiaku yang sedang terbuka di browser.
 * @returns {Promise<chrome.tabs.Tab|null>}
 */
export async function findCkgTab() {
  try {
    let tabs = await chrome.tabs.query({ url: `${CKG_URL}/*` }).catch(() => []);
    if (!tabs || tabs.length === 0) {
      tabs = (await chrome.tabs.query({}).catch(() => [])).filter(
        t => typeof t.url === "string" && t.url.startsWith(CKG_URL)
      );
    }
    const validTabs = (tabs || []).filter(t => typeof t.id === "number" && t.id >= 0);
    if (!validTabs.length) return null;

    // Utamakan tab yang statusnya complete dan bukan tab login
    const nonLogin = validTabs.find(t => !t.url.includes("/login") && t.status === "complete");
    if (nonLogin) return nonLogin;

    return validTabs.find(t => t.status === "complete") || validTabs[0];
  } catch (err) {
    console.error("[SessionHeartbeat] Error finding CKG tab:", err);
    return null;
  }
}

/**
 * Melakukan Keep-Alive Heartbeat Ping ke sesi Sehat Indonesiaku.
 * @returns {Promise<{ ok: boolean, state: string, message: string, user?: string, faskes?: string, status?: number, lastPing: number }>}
 */
export async function pingCkgSession() {
  const now = Date.now();
  const ckgTab = await findCkgTab();

  if (!ckgTab) {
    const statusObj = {
      ok: false,
      state: "no_tab",
      message: "Tab Sehat Indonesiaku belum dibuka",
      user: null,
      faskes: null,
      status: 0,
      lastPing: now
    };
    await chrome.storage.local.set({ ckg_heartbeat_status: statusObj });
    chrome.runtime.sendMessage({ type: "CKG_HEARTBEAT_STATUS", payload: statusObj }).catch(() => {});
    return statusObj;
  }

  // Jika URL tab saat ini mengarah ke halaman login
  if (ckgTab.url && ckgTab.url.includes("/login")) {
    const statusObj = {
      ok: false,
      state: "login_page",
      message: "Tab ASIK di halaman Login (Belum login)",
      user: null,
      faskes: null,
      status: 401,
      lastPing: now,
      tabId: ckgTab.id
    };
    await chrome.storage.local.set({ ckg_heartbeat_status: statusObj });
    chrome.runtime.sendMessage({ type: "CKG_HEARTBEAT_STATUS", payload: statusObj }).catch(() => {});
    return statusObj;
  }

  try {
    const [execResult] = await chrome.scripting.executeScript({
      target: { tabId: ckgTab.id },
      world: "MAIN",
      func: async () => {
        try {
          // 1. Simulasikan aktivitas halus untuk mereset timer idle di web frontend
          window.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: 20, clientY: 20 }));
          window.dispatchEvent(new Event("scroll"));

          // 2. Kirim fetch GET ringan dengan session cookie & credentials
          let response = await fetch("/api/user-management/me", {
            method: "GET",
            credentials: "include",
            headers: {
              "Accept": "application/json, text/plain, */*",
              "Cache-Control": "no-cache"
            }
          });

          // 3. Jika 401, coba auto-refresh token sebelum menyerah
          if (response.status === 401) {
            try {
              const refResp = await fetch("/api/user-management/refresh-token", {
                method: "POST",
                credentials: "include",
                headers: {
                  "Accept": "application/json, text/plain, */*",
                  "Content-Type": "application/json"
                },
                body: "{}"
              });
              if (refResp.ok) {
                response = await fetch("/api/user-management/me", {
                  method: "GET",
                  credentials: "include",
                  headers: {
                    "Accept": "application/json, text/plain, */*",
                    "Cache-Control": "no-cache"
                  }
                });
              }
            } catch (_) {}
          }

          const status = response.status;
          let data = null;
          try {
            data = await response.json();
          } catch (_) {}

          return {
            ok: response.ok,
            status,
            data: data?.data || null,
            message: data?.message || (response.ok ? "OK" : `HTTP ${status}`)
          };
        } catch (fetchErr) {
          return {
            ok: false,
            status: 0,
            error: fetchErr?.message || String(fetchErr)
          };
        }
      }
    });

    const result = execResult?.result;
    let statusObj;

    if (result && result.ok && result.status === 200) {
      const uData = result.data || {};
      const userName = uData.name || uData.fullname || "User ASIK";
      const faskesName = uData.health_centre_name || uData.faskes_name || uData.instance || "Faskes Terhubung";
      const faskesCode = uData.organitazion_ihs || uData.faskes_code || "";

      statusObj = {
        ok: true,
        state: "active",
        message: "Sesi Aktif",
        user: userName,
        faskes: faskesName,
        faskesCode,
        status: 200,
        lastPing: now,
        tabId: ckgTab.id
      };
      console.log(`[SessionHeartbeat] Ping OK - Sesi Aktif: ${userName} (${faskesName})`);
    } else if (result && result.status === 401) {
      statusObj = {
        ok: false,
        state: "expired",
        message: "Sesi Kedaluwarsa (401). Silakan login ulang di tab ASIK.",
        user: null,
        faskes: null,
        status: 401,
        lastPing: now,
        tabId: ckgTab.id
      };
      console.warn("[SessionHeartbeat] ⚠️ Sesi ASIK kedaluwarsa (401 Unauthorized)");
    } else {
      const errMsg = result?.error || result?.message || `HTTP ${result?.status || 0}`;
      statusObj = {
        ok: false,
        state: "warning",
        message: `Status Sesi: ${errMsg}`,
        user: null,
        faskes: null,
        status: result?.status || 0,
        lastPing: now,
        tabId: ckgTab.id
      };
    }

    await chrome.storage.local.set({ ckg_heartbeat_status: statusObj });
    chrome.runtime.sendMessage({ type: "CKG_HEARTBEAT_STATUS", payload: statusObj }).catch(() => {});
    return statusObj;
  } catch (err) {
    console.error("[SessionHeartbeat] Execution error:", err);
    const statusObj = {
      ok: false,
      state: "error",
      message: `Gagal ping tab: ${err.message || String(err)}`,
      user: null,
      faskes: null,
      status: 0,
      lastPing: now,
      tabId: ckgTab.id
    };
    await chrome.storage.local.set({ ckg_heartbeat_status: statusObj });
    chrome.runtime.sendMessage({ type: "CKG_HEARTBEAT_STATUS", payload: statusObj }).catch(() => {});
    return statusObj;
  }
}

/**
 * Mengatur jadwal alarm background untuk heartbeat ping.
 * @param {number} [overrideMinutes]
 */
export async function setupHeartbeatAlarm(overrideMinutes) {
  try {
    const { ckg_config = {} } = await chrome.storage.local.get("ckg_config");
    const isEnabled = ckg_config.heartbeatEnabled !== false; // Default: true
    const intervalMinutes = overrideMinutes || ckg_config.heartbeatInterval || 2; // Default: 2 menit

    if (!isEnabled) {
      await chrome.alarms.clear(CKG_HEARTBEAT_ALARM);
      console.log("[SessionHeartbeat] Heartbeat alarm dinonaktifkan.");
      return;
    }

    chrome.alarms.create(CKG_HEARTBEAT_ALARM, {
      periodInMinutes: Math.max(1, intervalMinutes)
    });
    console.log(`[SessionHeartbeat] Heartbeat alarm aktif setiap ${intervalMinutes} menit.`);
  } catch (err) {
    console.error("[SessionHeartbeat] Error setting up heartbeat alarm:", err);
  }
}

/**
 * Menghentikan alarm heartbeat.
 */
export async function stopHeartbeatAlarm() {
  await chrome.alarms.clear(CKG_HEARTBEAT_ALARM);
}
