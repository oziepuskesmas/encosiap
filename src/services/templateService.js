/**
 * templateService.js
 * Modul untuk mendownload file template Excel lokal (TEMPLATE BOT CKG.xlsx)
 * yang berada di dalam folder ekstensi untuk semua menu (Pendaftaran, Pasien, Pelayanan).
 */

export async function downloadTemplateFile(category = "UMUM") {
  const isSekolah = String(category || "").toUpperCase() === "SEKOLAH" || String(category || "").toUpperCase().includes("SEKOLAH");
  const fileName = isSekolah ? "TEMPLATE BOT CKG SEKOLAH.xlsx" : "TEMPLATE BOT CKG.xlsx";

  try {
    // URL file di dalam bundle Chrome Extension atau path lokal
    const fileUrl = typeof chrome !== "undefined" && chrome.runtime?.getURL
      ? chrome.runtime.getURL(fileName)
      : fileName;

    // Fetch file sebagai blob agar download terpicu otomatis dengan nama file yang tepat
    const response = await fetch(fileUrl);
    if (!response.ok) {
      throw new Error(`HTTP error ${response.status}`);
    }

    const blob = await response.blob();
    const blobUrl = URL.createObjectURL(blob);

    const link = document.createElement("a");
    link.href = blobUrl;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    link.remove();

    setTimeout(() => {
      URL.revokeObjectURL(blobUrl);
    }, 2000);
  } catch (err) {
    console.warn("[templateService] Gagal fetch blob, fallback ke anchor link langsung:", err);

    // Fallback direct download link
    const fallbackUrl = typeof chrome !== "undefined" && chrome.runtime?.getURL
      ? chrome.runtime.getURL(fileName)
      : fileName;

    const link = document.createElement("a");
    link.href = fallbackUrl;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    link.remove();
  }
}
