import pool from '../config/db.js';

/**
 * Riwayat perbaikan hasil.
 *
 * PMK 43/2013 Bab IX menuntut laporan memuat "hasil asli dan hasil yang
 * diperbaiki"; PMK 24/2022 Pasal 29 menuntut integritas data. Sebelum ini
 * perbaikan menimpa nilai lama begitu saja, dan ikut menimpa `result_at`
 * dengan NOW() sehingga waktu pemeriksaan aslinya pun hilang.
 *
 * Dipanggil SEBELUM baris diperbarui, karena yang disimpan adalah keadaan
 * sebelum perubahan.
 */
export async function simpanRevisi(resultId, userId, alasan = null) {
  const [[lama]] = await pool.query(
    'SELECT result_value, result_numeric, unit, flag, result_at FROM lab_results WHERE id = ?',
    [resultId]
  ).catch(() => [[]]);
  if (!lama) return false;

  await pool.query(
    `INSERT INTO lab_result_revisions
       (result_id, result_value, result_numeric, unit, flag, result_at, changed_by, reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [resultId, lama.result_value, lama.result_numeric, lama.unit, lama.flag, lama.result_at, userId ?? null, alasan]
  ).catch((e) => console.error('Gagal menyimpan revisi hasil:', e.message));

  await pool.query(
    'UPDATE lab_results SET revision_count = COALESCE(revision_count, 0) + 1, corrected_at = NOW(), corrected_by = ? WHERE id = ?',
    [userId ?? null, resultId]
  ).catch(() => {});

  return true;
}

/**
 * Riwayat koreksi catatan PELAPORAN NILAI KRITIS (siapa dihubungi, lewat
 * apa, dibacakan ulang atau tidak) -- berbeda dari simpanRevisi() di atas,
 * yang mencatat koreksi NILAI hasilnya.
 *
 * Dibutuhkan karena pelaporan kritis kadang salah ketik di sisi pelapor
 * (nama penerima, cara lapor) sesudah tercatat -- lihat diskusi "lapor
 * kritis menyusul" (POST /bridging/result/:id/report sengaja menolak
 * menimpa lewat jalur bridging, koreksi harus lewat LIS). Alasan koreksi
 * wajib diisi di endpoint pemanggil.
 */
export async function simpanRevisiKritis(resultId, userId, alasan) {
  const [[lama]] = await pool.query(
    `SELECT critical_reported_to, critical_reported_via, critical_readback, critical_note,
            critical_ack_by, critical_ack_at
       FROM lab_results WHERE id = ?`,
    [resultId]
  ).catch(() => [[]]);
  if (!lama) return false;

  await pool.query(
    `INSERT INTO lab_result_critical_revisions
       (result_id, reported_to, reported_via, readback, note, ack_by, ack_at, changed_by, reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      resultId,
      lama.critical_reported_to,
      lama.critical_reported_via,
      lama.critical_readback,
      lama.critical_note,
      lama.critical_ack_by,
      lama.critical_ack_at,
      userId ?? null,
      alasan,
    ]
  ).catch((e) => console.error('Gagal menyimpan revisi pelaporan kritis:', e.message));

  return true;
}
