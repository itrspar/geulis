import { Router } from 'express';
import pool from '../config/db.js';
import { authenticate, requirePermission } from '../middleware/auth.js';

const router = Router();

// Laporan kumulatif satu pasien: satu pemeriksaan yang sama ditampilkan
// berdampingan melintasi beberapa waktu hasil, supaya tren terapi terbaca
// sekali pandang. Beda dari delta check (yang hanya membandingkan dua nilai
// berurutan untuk mendeteksi sampel tertukar); ini pandangan klinis, bukan mutu.
//
// Pivot dilakukan di sini, bukan di SQL: jumlah kolom (momen hasil) tidak tetap,
// dan menyusunnya di JS lebih jujur daripada SQL dinamis yang rapuh.

const HARI = 864e5;

router.get('/kumulatif', authenticate, requirePermission('results.view'), async (req, res) => {
  const patientId = Number(req.query.patient_id);
  if (!patientId) return res.status(400).json({ error: 'patient_id diperlukan' });

  // Rentang wajib & berbawaan 30 hari terakhir: tanpa batas, tabel hasil yang
  // terus tumbuh membuat kueri makin lambat sampai time out.
  const sampai = req.query.sampai || new Date().toISOString().slice(0, 10);
  const dari = req.query.dari || new Date(Date.now() - 30 * HARI).toISOString().slice(0, 10);

  const [[pasien]] = await pool.query(
    'SELECT id, name, medical_record_no, gender, birth_date FROM patients WHERE id = ?',
    [patientId]
  );
  if (!pasien) return res.status(404).json({ error: 'Pasien tidak ditemukan' });

  const [rows] = await pool.query(
    `SELECT res.result_at, res.test_id, lt.code AS test_code, lt.name AS test_name,
            lt.sort_order, res.unit,
            lt.reference_min, lt.reference_max,
            lt.reference_min_l, lt.reference_max_l, lt.reference_min_p, lt.reference_max_p,
            res.result_value, res.result_numeric, res.flag, res.status
       FROM lab_results res
       JOIN lab_tests lt ON lt.id = res.test_id
      WHERE res.patient_id = ? AND res.result_at IS NOT NULL
        AND DATE(res.result_at) BETWEEN ? AND ?
      ORDER BY lt.sort_order, lt.name, res.result_at`,
    [patientId, dari, sampai]
  );

  // Kolom = momen hasil (result_at) yang berbeda, urut naik. Dibatasi 20 momen
  // terbaru agar tabel tidak melebar tak terkendali untuk pasien rawat inap lama;
  // yang paling relevan secara klinis adalah yang terkini.
  const semuaSlot = [...new Set(rows.map((r) => new Date(r.result_at).toISOString()))].sort();
  const slot = semuaSlot.slice(-20);
  const adaSlot = new Set(slot);

  const perempuan = String(pasien.gender || '').toUpperCase() === 'P';
  const rmin = (r) => (perempuan ? (r.reference_min_p ?? r.reference_min) : (r.reference_min_l ?? r.reference_min));
  const rmax = (r) => (perempuan ? (r.reference_max_p ?? r.reference_max) : (r.reference_max_l ?? r.reference_max));

  const peta = new Map(); // test_id -> baris pivot
  for (const r of rows) {
    const s = new Date(r.result_at).toISOString();
    if (!adaSlot.has(s)) continue; // di luar 20 momen terbaru
    let b = peta.get(r.test_id);
    if (!b) {
      const lo = rmin(r), hi = rmax(r);
      b = {
        test_id: r.test_id,
        kode: r.test_code,
        nama: r.test_name,
        unit: r.unit || '',
        sort_order: r.sort_order ?? 999,
        rujukan: lo != null || hi != null ? `${lo ?? ''} - ${hi ?? ''}`.trim() : '',
        sel: {},
      };
      peta.set(r.test_id, b);
    }
    if (!b.unit && r.unit) b.unit = r.unit;
    // Hasil terakhir menang bila satu tes punya dua entri pada momen yang sama.
    b.sel[s] = {
      nilai: r.result_value,
      num: r.result_numeric,
      flag: r.flag,
      status: r.status,
    };
  }

  const baris = [...peta.values()].sort(
    (a, b) => (a.sort_order - b.sort_order) || a.nama.localeCompare(b.nama)
  );

  res.json({
    pasien: { id: pasien.id, nama: pasien.name, no_rm: pasien.medical_record_no, gender: pasien.gender },
    dari,
    sampai,
    kolom: slot,
    baris,
  });
});

export default router;
