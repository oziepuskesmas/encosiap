!function(){
  const origFetch = window.fetch;
  window.fetch = async function(...args) {
    const res = await origFetch.apply(this, args);
    try {
      const url = typeof args[0] === "string" ? args[0] : (args[0]?.url ?? "");
      if (url.includes("detail-screening")) {
        res.clone().json().then(data => {
          window.__ckgCache = window.__ckgCache ?? {};
          window.__ckgCache.detailScreening = data;
        }).catch(() => {});
      }
      if (url.includes("get-screening")) {
        res.clone().json().then(data => {
          window.__ckgCache = window.__ckgCache ?? {};
          window.__ckgCache.getScreening = data;
        }).catch(() => {});
      }
      if (url.includes("user-management/me")) {
        res.clone().json().then(data => {
          if (data?.statusCode === 200 && data?.data) {
            console.log(data.data);
            window.postMessage({ type: "CKG_USER_ME", data: data.data, __ckg: true }, "*");
          }
        }).catch(() => {});
      }
    } catch (_) {}
    return res;
  };
}();
