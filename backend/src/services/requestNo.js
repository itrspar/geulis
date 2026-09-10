/**
 * Nomor permintaan LIS (lab_requests.request_no).
 *
 * Format: "REQ" + tahun 4 digit + bulan + tanggal + 6 digit terakhir
 * Date.now(), mis. REQ20260910301185 (17 karakter).
 *
 * Sempat dipendekkan jadi 13 karakter demi kotak Patient ID iChroma II yang
 * maksimal 15 karakter, lalu dikembalikan karena penyesuaian dilakukan di
 * sisi SIMRS (nomor order). Untuk alat dengan kotak ID pendek, petugas
 * mengetik nomor rekam medis atau nomor order SIMRS, bukan request_no ini.
 *
 * Fungsi ini satu-satunya sumber format request_no — dipakai routes/requests.js
 * (input manual di GeuLIS) dan routes/bridging.js (order dari SIMRS).
 */
export function genRequestNo() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `REQ${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${Date.now().toString().slice(-6)}`;
}
