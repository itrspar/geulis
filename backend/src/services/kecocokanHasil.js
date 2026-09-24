import pool from '../config/db.js';

/**
 * Tiga sinyal kecocokan yang sama dipakai di dua tempat:
 *   - GET /unmatched/:id/saran (LIS, pencarian luas ke semua kandidat)
 *   - GET /bridging/result & POST /bridging/result/:id/match (SIMRS,
 *     diperiksa untuk SATU order yang sedang dibuka/diklaim)
 *
 * Kriterianya SENGAJA identik supaya "kandidat yang ditampilkan" dan
 * "kandidat yang diterima server saat ditautkan" tidak pernah berbeda --
 * kalau beda, SIMRS bisa menampilkan tombol yang begitu diklik malah
 * ditolak 400, atau lebih buruk, server menerima klaim yang tidak pernah
 * ditampilkan sebagai pilihan sah.
 *
 * TIDAK memutuskan apa pun sendiri -- cuma menghitung sinyal. Keputusan
 * "boleh ditautkan atau tidak" tetap di pemanggil (manusia di LIS, atau
 * pengecekan ulang di POST /bridging/result/:id/match).
 */
export async function kecocokanRequest({ medicalRecordNo, sampleIdAsal, testId }, request) {
  const rm = String(medicalRecordNo || '');
  const sampleId = String(sampleIdAsal || '');
  const requestNo = String(request.request_no || '');
  const simrsOrderId = String(request.simrs_order_id || '');

  const rm_persis = !!(sampleId && rm && sampleId === rm);
  const id_mirip = !!(
    sampleId &&
    ((rm && (rm.includes(sampleId) || sampleId.includes(rm))) ||
      (requestNo && (requestNo.includes(sampleId) || sampleId.includes(requestNo))) ||
      (simrsOrderId && (simrsOrderId.includes(sampleId) || sampleId.includes(simrsOrderId))))
  );

  const [[cnt]] = await pool.query(
    'SELECT COUNT(*) AS n FROM lab_request_items WHERE request_id = ? AND test_id = ?',
    [request.id, testId]
  );
  const tes_cocok = cnt.n > 0;

  return { rm_persis, id_mirip, tes_cocok, cocok: rm_persis || id_mirip || tes_cocok };
}

/** Alasan tunggal untuk ditampilkan, urutan prioritas sama seperti pengurutan saran. */
export function skorKecocokan({ rm_persis, id_mirip, tes_cocok }) {
  if (rm_persis) return 'rm_persis';
  if (id_mirip) return 'mirip';
  if (tes_cocok) return 'tes_cocok';
  return null;
}
