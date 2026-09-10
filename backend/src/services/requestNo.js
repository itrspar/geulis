/**
 * Nomor permintaan LIS (lab_requests.request_no).
 *
 * Dulu berformat "REQ" + tahun 4 digit + bulan + tanggal + 6 digit terakhir
 * Date.now() (mis. REQ20260907301185, 17 karakter). Alat seperti iChroma II
 * (Boditech) hanya menerima maksimal 15 karakter di kotak Patient ID —
 * dengan format lama, petugas terpaksa mengetik nomor rekam medis pasien saja
 * karena request_no tidak muat sama sekali.
 *
 * Dipendekkan jadi 13 karakter: 'R' + tanggal 6 digit (YYMMDD) + 6 digit
 * terakhir Date.now(), supaya bisa diketik utuh di alat semacam itu.
 * Perubahan format ini TIDAK memperpendek request_no yang sudah terlanjur
 * dibuat sebelumnya — permintaan lama tetap memakai nomor panjangnya.
 */
export function genRequestNo() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const yy = String(d.getFullYear()).slice(-2);
  return `R${yy}${pad(d.getMonth() + 1)}${pad(d.getDate())}${Date.now().toString().slice(-6)}`;
}
