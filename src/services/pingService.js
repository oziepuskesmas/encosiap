/**
 * pingService.js
 * Real-time network latency monitor for ENCO Extension.
 *
 * Targets monitored:
 * 1. Google (8.8.8.8)
 * 2. Sehat Indonesiaku (35.219.38.230)
 * 3. Cloudflare (1.1.1.1)
 */

export const PING_TARGETS = [
  {
    id: "google",
    name: "Google",
    ip: "8.8.8.8",
    url: "https://www.google.com/generate_204",
    cardElId: "ping-target-google",
    latencyElId: "ping-latency-google"
  },
  {
    id: "kemkes",
    name: "Sehat Indonesiaku",
    ip: "35.219.38.230",
    url: "https://sehatindonesiaku.kemkes.go.id/favicon.ico",
    cardElId: "ping-target-kemkes",
    latencyElId: "ping-latency-kemkes"
  },
  {
    id: "cloudflare",
    name: "Cloudflare",
    ip: "1.1.1.1",
    url: "https://1.1.1.1/cdn-cgi/trace",
    cardElId: "ping-target-cloudflare",
    latencyElId: "ping-latency-cloudflare"
  }
];

let pingIntervalId = null;
let isPinging = false;

/**
 * Ultra-reliable round-trip latency measurement using an image request.
 * Completely immune to CORS and Cross-Origin-Resource-Policy (CORP) blocks.
 * @param {string} url - Image endpoint
 * @param {number} timeoutMs - Timeout in milliseconds
 * @returns {Promise<number|null>} Elapsed latency in ms, or null if timed out
 */
function pingViaImage(url, timeoutMs = 2500) {
  return new Promise((resolve) => {
    const start = performance.now();
    const img = new Image();
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        img.src = "";
        resolve(null);
      }
    }, timeoutMs);

    const onFinish = () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        const elapsed = Math.round(performance.now() - start);
        resolve(elapsed);
      }
    };

    img.onload = onFinish;
    img.onerror = onFinish;

    const cacheBuster = `_t=${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    const fullUrl = url.includes("?") ? `${url}&${cacheBuster}` : `${url}?${cacheBuster}`;
    img.src = fullUrl;
  });
}

/**
 * Measure latency to a specific target endpoint
 * @param {Object} target 
 * @returns {Promise<{ ok: boolean, latency: number|null, status: 'good'|'medium'|'bad', label?: string }>}
 */
export async function measureLatency(target) {
  // If target is kemkes, use the ultra-reliable image round-trip measurement directly
  // This bypasses Cross-Origin-Resource-Policy: same-origin returned by Sehat Indonesiaku servers
  if (target.id === "kemkes") {
    const latency = await pingViaImage("https://sehatindonesiaku.kemkes.go.id/favicon.ico", 2500);
    if (latency !== null) {
      let status = "good";
      if (latency > 300) status = "bad";
      else if (latency > 140) status = "medium";
      return { ok: true, latency, status };
    }
    return { ok: false, latency: null, status: "bad", label: "RTO" };
  }

  const start = performance.now();
  const controller = new AbortController();
  const timeoutMs = 2500;
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  const cacheBuster = `_t=${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
  const fullUrl = target.url.includes("?") 
    ? `${target.url}&${cacheBuster}` 
    : `${target.url}?${cacheBuster}`;

  try {
    await fetch(fullUrl, {
      method: "GET",
      mode: "no-cors",
      cache: "no-store",
      signal: controller.signal
    });

    const elapsed = Math.round(performance.now() - start);
    let status = "good";
    if (elapsed > 300) {
      status = "bad";
    } else if (elapsed > 140) {
      status = "medium";
    }

    return { ok: true, latency: elapsed, status };
  } catch (err) {
    // If fetch failed on non-abort (e.g. CORS/CORP block), try fallback via image ping
    if (err.name !== "AbortError") {
      try {
        const domain = target.url.split("/").slice(0, 3).join("/");
        const imgLatency = await pingViaImage(`${domain}/favicon.ico`, 1500);
        if (imgLatency !== null) {
          let status = "good";
          if (imgLatency > 300) status = "bad";
          else if (imgLatency > 140) status = "medium";
          return { ok: true, latency: imgLatency, status };
        }
      } catch (_) {}
    }
    return { ok: false, latency: null, status: "bad", label: "RTO" };
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Update UI for a single ping target
 * @param {Object} target 
 * @param {Object} result 
 */
function updateTargetUI(target, result) {
  const cardEl = document.getElementById(target.cardElId);
  const latencyEl = document.getElementById(target.latencyElId);
  if (!cardEl || !latencyEl) return;

  // Reset status classes
  cardEl.classList.remove("ping-card--good", "ping-card--medium", "ping-card--bad", "ping-card--checking");

  if (result.ok && result.latency !== null) {
    latencyEl.textContent = `${result.latency} ms`;
    cardEl.classList.add(`ping-card--${result.status}`);
  } else {
    latencyEl.textContent = result.label || "RTO";
    cardEl.classList.add("ping-card--bad");
  }
}

/**
 * Run a full ping cycle across all 3 targets in parallel
 */
export async function runPingCycle() {
  if (isPinging) return;
  isPinging = true;

  try {
    const promises = PING_TARGETS.map(async target => {
      const res = await measureLatency(target);
      updateTargetUI(target, res);
      return { target, res };
    });

    await Promise.allSettled(promises);
  } finally {
    isPinging = false;
  }
}

/**
 * Initialize real-time network ping monitor
 * @param {number} intervalMs - Poll interval in milliseconds (default: 3500ms)
 * @returns {Function} Stop function to clear interval
 */
export function initPingMonitor(intervalMs = 3500) {
  if (pingIntervalId) {
    clearInterval(pingIntervalId);
    pingIntervalId = null;
  }

  // Mark all cards as checking
  PING_TARGETS.forEach(target => {
    const cardEl = document.getElementById(target.cardElId);
    const latencyEl = document.getElementById(target.latencyElId);
    if (cardEl) {
      cardEl.classList.remove("ping-card--good", "ping-card--medium", "ping-card--bad");
      cardEl.classList.add("ping-card--checking");
    }
    if (latencyEl && latencyEl.textContent === "-- ms") {
      latencyEl.textContent = "…";
    }
  });

  // Run immediately
  runPingCycle();

  // Run on interval
  pingIntervalId = setInterval(() => {
    runPingCycle();
  }, intervalMs);

  // Setup manual refresh button (Icon-only)
  const btnRefresh = document.getElementById("btn-refresh-ping");
  if (btnRefresh && !btnRefresh.dataset.bound) {
    btnRefresh.dataset.bound = "true";
    btnRefresh.addEventListener("click", async () => {
      btnRefresh.classList.add("spinning");
      PING_TARGETS.forEach(target => {
        const cardEl = document.getElementById(target.cardElId);
        if (cardEl) {
          cardEl.classList.remove("ping-card--good", "ping-card--medium", "ping-card--bad");
          cardEl.classList.add("ping-card--checking");
        }
      });
      await runPingCycle();
      setTimeout(() => {
        btnRefresh.classList.remove("spinning");
      }, 500);
    });
  }

  // Return teardown function
  return () => {
    if (pingIntervalId) {
      clearInterval(pingIntervalId);
      pingIntervalId = null;
    }
  };
}
