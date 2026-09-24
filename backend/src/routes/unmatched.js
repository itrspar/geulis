import { Router } from 'express';
import pool from '../config/db.js';
import { authenticate, requirePermission } from '../middleware/auth.js';
import { audit } from '../services/audit.js';
import { nilaiHasil } from '../services/flags.js';
import { konteksPasien } from '../services/konteksPasien.js';
import { hitungDelta } from '../services/deltaCheck.js';
import { pastikanTes } from '../services/pemetaanTes.js';

const router = Router();

/**
 * Kotak masuk hasil yang tidak cocok dengan pasien mana pun.
 *
 * Hasil masuk ke sini kalau nomor sampelnya tidak ketemu di data pasien maupun
 * permintaan. Petugas mencocokkannya ke pasien yang benar, dan baru pada saat
 * itu hasilnya tercatat sebagai hasil lab.
 */

router.get('/', authenticate, requirePermission('results.view'), async (req, res) => {
  const status = req.query.status || 'pending';
  const [rows] = await pool.query(
    `SELECT u.id, u.sample_id, u.patient_info, u.payload, u.status, u.received_at,
            u.matched_patient_id, u.matched_request_id, u.note,
            i.code AS instrument_code, i.name AS instrument_name,
            p.name AS matched_patient_name, lr.request_no AS matched_request_no
       FROM unmatched_results u
       LEFT JOIN instruments i ON i.id = u.instrument_id
       LEFT JOIN patients p ON p.id = u.matched_patient_id
       LEFT JOIN lab_requests lr ON lr.id = u.matched_request_id
      WHERE u.status = ?
      ORDER BY u.received_at DESC LIMIT 200`,
    [status]
  );
  // MySQL mengembalikan kolom JSON sebagai objek; jumlah parameter cukup untuk daftar.
  res.json(
    rows.map((r) => ({
      ...r,
      jumlah_parameter: Array.isArray(r.payload) ? r.payload.length : 0,
    }))
  );
});

router.get('/count', authenticate, requirePermission('results.view'), async (_req, res) => {
  const [[r]] = await pool.query("SELECT COUNT(*) AS n FROM unmatched_results WHERE status = 'pending'");
  res.json({ pending: r.n });
});

/**
 * Hasil "yatim" -- beda dari unmatched_results di atas: pasiennya SUDAH
 * ketemu (tersimpan di lab_results), cuma request_id-nya kosong karena tidak
 * ada item permintaan terbuka yang test_id-nya cocok persis saat hasil
 * masuk. Penyebab paling umum: kode tes SIMRS dipetakan ulang (menu
 * Sinkronisasi Katalog) SETELAH permintaan dibuat -- item permintaan lama
 * masih menunjuk test_id lama, sedangkan hasil dari alat sekarang bawa
 * test_id baru. Tanpa halaman ini satu-satunya jalan petugas adalah hapus
 * permintaan dan minta SIMRS kirim ulang.
 *
 * Didaftarkan SEBELUM GET /:id di bawah -- itu catch-all satu segmen path,
 * dan akan menangkap /yatim (menganggap "yatim" sebagai :id) kalau tidak
 * didahulukan.
 */
router.get('/yatim', authenticate, requirePermission('results.view'), async (_req, res) => {
  const [rows] = await pool.query(`
    SELECT r.id, r.patient_id, r.test_id, r.result_value, r.unit, r.flag, r.result_at,
           p.name AS patient_name, p.medical_record_no,
           lt.code AS test_code, lt.name AS test_name,
           i.name AS instrument_name
      FROM lab_results r
      JOIN patients p ON p.id = r.patient_id
      JOIN lab_tests lt ON lt.id = r.test_id
      LEFT JOIN instruments i ON i.id = r.instrument_id
     WHERE r.request_id IS NULL AND r.status = 'preliminary'
     ORDER BY r.result_at DESC LIMIT 200
  `);
  res.json(rows);
});

router.get('/yatim/count', authenticate, requirePermission('results.view'), async (_req, res) => {
  const [[r]] = await pool.query(
    "SELECT COUNT(*) AS n FROM lab_results WHERE request_id IS NULL AND status = 'preliminary'"
  );
  res.json({ pending: r.n });
});

/** Permintaan terbuka milik pasien yang sama, untuk dropdown pemilihan. */
router.get('/yatim/:id/permintaan', authenticate, requirePermission('results.view'), async (req, res) => {
  const [[hasil]] = await pool.query('SELECT patient_id FROM lab_results WHERE id = ?', [req.params.id]);
  if (!hasil) return res.status(404).json({ error: 'Hasil tidak ditemukan' });
  const [rows] = await pool.query(
    `SELECT id, request_no, simrs_order_id, status, requested_at
       FROM lab_requests
      WHERE patient_id = ? AND status NOT IN ('cancelled', 'completed')
      ORDER BY requested_at DESC LIMIT 20`,
    [hasil.patient_id]
  );
  res.json(rows);
});

/**
 * Tautkan hasil yatim ke permintaan yang benar. Item permintaan untuk tes ini
 * dicari dulu; kalau belum ada (permintaan dibuat sebelum tes ini termapping)
 * dibuatkan baru -- prinsipnya sama seperti pemetaan otomatis di jalur alat.
 */
router.post('/yatim/:id/link', authenticate, requirePermission('results.manage'), async (req, res) => {
  const { request_id } = req.body || {};
  if (!request_id) return res.status(400).json({ error: 'request_id wajib diisi' });

  const [[hasil]] = await pool.query(
    "SELECT id, patient_id, test_id FROM lab_results WHERE id = ? AND request_id IS NULL AND status = 'preliminary'",
    [req.params.id]
  );
  if (!hasil) return res.status(404).json({ error: 'Hasil tidak ditemukan atau sudah tertaut' });

  const [[reqRow]] = await pool.query('SELECT id, patient_id FROM lab_requests WHERE id = ?', [request_id]);
  if (!reqRow || reqRow.patient_id !== hasil.patient_id) {
    return res.status(400).json({ error: 'Permintaan yang dipilih bukan milik pasien ini' });
  }

  let [[item]] = await pool.query(
    `SELECT id FROM lab_request_items WHERE request_id = ? AND test_id = ?
      ORDER BY (status <> 'done') DESC, id LIMIT 1`,
    [reqRow.id, hasil.test_id]
  );
  let itemId = item?.id;
  if (!itemId) {
    const [ins] = await pool.query(
      'INSERT INTO lab_request_items (request_id, test_id) VALUES (?, ?)',
      [reqRow.id, hasil.test_id]
    );
    itemId = ins.insertId;
  }

  await pool.query('UPDATE lab_results SET request_id = ?, request_item_id = ? WHERE id = ?', [reqRow.id, itemId, hasil.id]);
  await pool.query("UPDATE lab_request_items SET status = 'done' WHERE id = ?", [itemId]);
  await audit(req, 'LINK', 'result', hasil.id, { request_id: reqRow.id, request_item_id: itemId });
  res.json({ ok: true });
});

router.get('/:id', authenticate, requirePermission('results.view'), async (req, res) => {
  const [[row]] = await pool.query('SELECT * FROM unmatched_results WHERE id = ?', [req.params.id]);
  if (!row) return res.status(404).json({ error: 'Tidak ditemukan' });
  res.json(row);
});

/**
 * Cocokkan ke satu pasien -- dan, kalau ada, ke satu PERMINTAAN spesifik
 * milik pasien itu. Baru di sinilah hasilnya benar-benar masuk lab_results,
 * lengkap dengan flag dan delta check yang dihitung ulang memakai identitas
 * pasien yang benar (gender mempengaruhi nilai rujukan).
 *
 * request_id opsional, tapi penting: tanpa itu, hasil tersimpan dengan
 * request_id KOSONG (yatim) -- dan jalur bridging SIMRS (GET /result)
 * punya penjagaan yang mencari hasil yatim milik pasien+tes yang sama untuk
 * order APA PUN pasien itu berikutnya. Itu penjagaan yang wajar untuk hasil
 * yang memang tidak dari permintaan formal (mis. pasien titipan), tapi kalau
 * permintaannya sebenarnya ADA dan cuma tidak ditautkan di sini, hasil bisa
 * "muncul" di order lain milik pasien yang sama walau tidak pernah benar-
 * benar diperiksa untuk order itu. Karena itu, kalau id_template/kode tes
 * cocok dengan salah satu item permintaan yang dipilih, tautkan langsung.
 */
router.post('/:id/match', authenticate, requirePermission('results.manage'), async (req, res) => {
  const { patient_id, request_id } = req.body || {};
  if (!patient_id) return res.status(400).json({ error: 'patient_id wajib diisi' });

  const [[row]] = await pool.query("SELECT * FROM unmatched_results WHERE id = ? AND status = 'pending'", [req.params.id]);
  if (!row) return res.status(404).json({ error: 'Tidak ditemukan atau sudah ditangani' });

  const [[pasien]] = await pool.query('SELECT id, gender FROM patients WHERE id = ?', [patient_id]);
  if (!pasien) return res.status(400).json({ error: 'Pasien tidak ditemukan' });

  let requestRow = null;
  if (request_id) {
    const [[r]] = await pool.query('SELECT id, patient_id FROM lab_requests WHERE id = ?', [request_id]);
    if (!r || r.patient_id !== pasien.id) {
      return res.status(400).json({ error: 'Permintaan yang dipilih bukan milik pasien ini' });
    }
    requestRow = r;
  }

  const payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload || [];
  let tersimpan = 0;
  let tertaut = 0;

  for (const item of payload) {
    if (!item?.test_code) continue;

    // Kode yang belum ada di katalog didaftarkan, sama seperti jalur hasil
    // langsung dari alat. Tanpa ini parameter seperti GRAN% dan PLCR hilang
    // diam-diam saat hasil dicocokkan.
    const testId = await pastikanTes(row.instrument_id, item);
    if (!testId) continue;

    const [[test]] = await pool.query('SELECT * FROM lab_tests WHERE id = ?', [testId]);
    const { flag } = await nilaiHasil(item.value, test, await konteksPasien(pasien.id));
    const delta = await hitungDelta(pasien.id, testId, item.value, test?.code, test?.delta_limit_percent);
    const numeric = parseFloat(item.value);

    // Kalau permintaan dipilih dan punya item untuk tes ini, tautkan --
    // utamakan yang belum 'done' supaya tidak menimpa item yang sudah
    // punya hasil dari alat lain.
    let requestItemId = null;
    if (requestRow) {
      const [[ri]] = await pool.query(
        `SELECT id FROM lab_request_items WHERE request_id = ? AND test_id = ?
          ORDER BY (status <> 'done') DESC, id LIMIT 1`,
        [requestRow.id, testId]
      );
      if (ri) requestItemId = ri.id;
    }

    await pool.query(
      `INSERT INTO lab_results (patient_id, test_id, request_id, request_item_id, result_value, result_numeric, unit, flag,
                                instrument_id, raw_message, status, delta_percent, delta_flag)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'preliminary', ?, ?)`,
      [pasien.id, testId, requestItemId ? requestRow.id : null, requestItemId,
       item.value, isNaN(numeric) ? null : numeric, item.unit || test?.unit || '',
       flag, row.instrument_id, String(row.raw_message || '').slice(0, 5000),
       delta?.percent ?? null, delta?.flag ?? 'none']
    );
    if (requestItemId) {
      await pool.query("UPDATE lab_request_items SET status='done' WHERE id=?", [requestItemId]);
      tertaut += 1;
    }
    tersimpan += 1;
  }

  await pool.query(
    `UPDATE unmatched_results
        SET status = 'matched', matched_patient_id = ?, matched_request_id = ?, handled_by = ?, handled_at = NOW()
      WHERE id = ?`,
    [pasien.id, requestRow?.id ?? null, req.user.id, row.id]
  );
  await audit(req, 'MATCH', 'unmatched_result', row.id, {
    patient_id: pasien.id, request_id: requestRow?.id ?? null, sample_id: row.sample_id, tersimpan, tertaut,
  });
  res.json({ ok: true, tersimpan, tertaut });
});

/** Buang, misalnya hasil uji coba atau bahan kontrol yang salah kirim. */
router.post('/:id/discard', authenticate, requirePermission('results.manage'), async (req, res) => {
  const { note } = req.body || {};
  const [r] = await pool.query(
    `UPDATE unmatched_results
        SET status = 'discarded', handled_by = ?, handled_at = NOW(), note = ?
      WHERE id = ? AND status = 'pending'`,
    [req.user.id, note || null, req.params.id]
  );
  if (!r.affectedRows) return res.status(404).json({ error: 'Tidak ditemukan atau sudah ditangani' });
  await audit(req, 'DISCARD', 'unmatched_result', req.params.id, { note });
  res.json({ ok: true });
});

export default router;
