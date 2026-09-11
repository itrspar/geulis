import { Router } from 'express';
import pool from '../config/db.js';
import { requireApiKey, requirePermission } from '../middleware/auth.js';
import { audit } from '../services/audit.js';
import { genRequestNo } from '../services/requestNo.js';
import { pushRequestResultsToSimrs } from '../services/simrsPush.js';
import { rujukanBerlaku, labelRujukan, umurHari } from '../services/rujukanUmur.js';

const router = Router();

// Middleware auth untuk semua endpoint di router ini
router.use(requireApiKey);

/**
 * Menerjemahkan user SIMRS yang sedang login menjadi akun GeuLIS, lalu meniru
 * bentuk req.user dari authenticate() (lihat middleware/auth.js) supaya
 * requirePermission() bisa dipakai ulang tanpa modifikasi.
 *
 * Tanpa ini, aksi yang dipicu SIMRS hanya bisa tercatat atas nama API key
 * generik -- cukup untuk membuat order, tapi tidak untuk verifikasi hasil:
 * itu tindakan yang harus bisa ditelusuri ke satu petugas berwenang tertentu
 * (lihat simrs_user_map di ensureSchema.js).
 */
async function resolveSimrsUser(req, res, next) {
  const simrsUserId = req.body?.simrs_user_id;
  if (!simrsUserId) {
    return res.status(400).json({ error: 'simrs_user_id wajib disertakan (identitas petugas yang sedang login di SIMRS).' });
  }
  const [rows] = await pool.query(
    `SELECT u.id, u.username, u.is_active, u.role_id, r.code AS role_code
       FROM simrs_user_map m
       JOIN users u ON u.id = m.geulis_user_id
       JOIN roles r ON r.id = u.role_id
      WHERE m.simrs_user_id = ?`,
    [String(simrsUserId).trim()]
  );
  if (rows.length === 0) {
    return res.status(403).json({
      error: 'User SIMRS ini belum dipetakan ke akun GeuLIS. Minta admin LIS memetakan akun Anda di menu Mapping SIMRS.',
    });
  }
  const u = rows[0];
  if (!u.is_active) {
    return res.status(403).json({ error: 'Akun GeuLIS yang terpetakan untuk user ini nonaktif.' });
  }
  req.user = { id: u.id, username: u.username, roleId: u.role_id, roleCode: u.role_code };
  next();
}

// POST /bridging/order
router.post('/order', async (req, res) => {
  const { 
    simrs_order_id, 
    medical_record_no, 
    patient_name, 
    gender, 
    birth_date, 
    priority = 'normal',
    notes,
    // Komponen wajib laporan hasil (PMK 43/2013 Bab IX): pemohon (4), jenis
    // spesimen (7), waktu pengambilan dan penerimaan (5). SIMRS sudah punya
    // datanya — sebelumnya hanya dititipkan sebagai teks di dalam `notes`.
    clinician_name,
    clinician_unit,
    specimen_type,
    collected_at,
    tests // Array of test codes, e.g. ["HGB", "LEU"]
  } = req.body;

  if (!simrs_order_id || !medical_record_no || !patient_name || !tests || !Array.isArray(tests)) {
    return res.status(400).json({ error: 'Data tidak lengkap. simrs_order_id, medical_record_no, patient_name, dan tests wajib diisi.' });
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // 1. Cek atau buat Pasien
    let patientId;
    const [existingPatient] = await conn.query('SELECT id FROM patients WHERE medical_record_no = ?', [medical_record_no]);
    
    if (existingPatient.length > 0) {
      patientId = existingPatient[0].id;
      // Update data pasien jika ada perubahan
      await conn.query(
        'UPDATE patients SET name=?, gender=?, birth_date=? WHERE id=?',
        [patient_name, gender || 'L', birth_date || null, patientId]
      );
    } else {
      const [newPatient] = await conn.query(
        'INSERT INTO patients (medical_record_no, name, gender, birth_date) VALUES (?, ?, ?, ?)',
        [medical_record_no, patient_name, gender || 'L', birth_date || null]
      );
      patientId = newPatient.insertId;
    }

    // 2. Cek apakah nomor order SIMRS sudah pernah masuk
    const [existingOrder] = await conn.query('SELECT id FROM lab_requests WHERE simrs_order_id = ?', [simrs_order_id]);
    if (existingOrder.length > 0) {
      await conn.rollback();
      return res.status(409).json({ error: 'Order dengan simrs_order_id tersebut sudah ada.' });
    }

    // 3. Translasi kode tes SIMRS ke LIS dan cari ID tes
    const testIds = [];
    if (tests.length > 0) {
      const [mappings] = await conn.query("SELECT lis_field, simrs_field FROM simrs_mappings WHERE mapping_type = 'test' AND is_active = 1");
      const mappingDict = {};
      mappings.forEach(m => { if (m.simrs_field) mappingDict[m.simrs_field.trim()] = m.lis_field; });
      
      // Simpan pasangan (kode asli SIMRS -> kode LIS). Kode aslinya dibutuhkan
      // saat hasil ditarik kembali: satu kode LIS bisa punya puluhan id_template
      // di SIMRS, jadi menebaknya lewat tabel pemetaan akan sering meleset.
      const pasangan = tests.map((t) => {
        const asli = String(t).trim();
        return { asli, kode: mappingDict[asli] || asli };
      });

      const [testRows] = await conn.query(
        'SELECT id, code, name, instrument_id FROM lab_tests WHERE code IN (?)',
        [pasangan.map((x) => x.kode)]
      );
      if (testRows.length === 0) {
        await conn.rollback();
        return res.status(400).json({ error: 'Tidak ada kode tes yang valid ditemukan di LIS.' });
      }
      const rowPerKode = new Map(testRows.map((r) => [r.code, r]));
      for (const { asli, kode } of pasangan) {
        const row = rowPerKode.get(kode);
        if (row) testIds.push({ id: row.id, asli, kode, name: row.name || kode, instrument_id: row.instrument_id });
      }
    } else {
      await conn.rollback();
      return res.status(400).json({ error: 'Daftar tests tidak boleh kosong.' });
    }

    // 4. Buat Permintaan
    const request_no = genRequestNo();
    const [reqResult] = await conn.query(
      `INSERT INTO lab_requests (request_no, patient_id, simrs_order_id, priority, notes, requested_by, status,
                                 clinician_name, clinician_unit, specimen_type, collected_at, received_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, NOW())`,
      [request_no, patientId, simrs_order_id, priority, notes || null, req.apiKeyData.created_by,
       clinician_name || null, clinician_unit || null, specimen_type || null, collected_at || null]
    );
    const requestId = reqResult.insertId;

    // 5. Insert item permintaan
    for (const { id, asli } of testIds) {
      await conn.query(
        'INSERT INTO lab_request_items (request_id, test_id, simrs_code) VALUES (?, ?, ?)',
        [requestId, id, asli]
      );
    }

    await conn.commit();
    await audit(req, 'CREATE', 'request', requestId, { source: 'bridging', simrs_order_id, request_no, tests });

    // Petunjuk untuk petugas: apa yang harus diketik/di-scan di alat.
    // SIMRS menampilkannya sebagai notifikasi setelah "Kirim ke GeuLIS",
    // jadi tidak perlu tahu pemetaan sendiri — kalau pemetaan berubah,
    // petunjuknya ikut berubah. Alat lab TIDAK bisa menarik order dari LIS;
    // petugas harus mengetik Sample ID secara manual.
    const instIds = [...new Set(testIds.map((t) => t.instrument_id).filter(Boolean))];
    let instruments = [];
    if (instIds.length) {
      const [instRows] = await pool.query(
        'SELECT id, code, name FROM instruments WHERE id IN (?)',
        [instIds]
      );
      const namaAlat = new Map(instRows.map((r) => [r.id, r]));
      instruments = instIds.map((iid) => ({
        code: namaAlat.get(iid)?.code || null,
        name: namaAlat.get(iid)?.name || 'Alat tidak dikenal',
        tests: testIds.filter((t) => t.instrument_id === iid).map((t) => t.name),
      }));
    }
    const tanpaAlat = testIds.filter((t) => !t.instrument_id).map((t) => t.name);

    res.status(201).json({
      message: 'Order berhasil diterima',
      data: {
        request_no: request_no,
        simrs_order_id: simrs_order_id,
        patient_id: patientId,
        request_id: requestId
      },
      instructions: {
        // Nomor yang harus diketik/di-scan petugas sebagai Sample ID di alat.
        // Pakai nomor order (unik per order) supaya tidak keliru saat satu
        // pasien punya beberapa order tes yang sama di hari yang sama.
        sample_id: simrs_order_id,
        medical_record_no: medical_record_no,
        catatan: 'Ketik/scan Sample ID = nomor order ini di alat lab. '
          + 'Kotak Patient ID iChroma II maksimal 15 karakter — bila nomor order '
          + 'lebih panjang, pakai nomor rekam medis (hanya aman bila pasien tidak '
          + 'punya order tes yang sama lain di hari yang sama).',
        patient: { name: patient_name, medical_record_no },
        instruments,           // [{ code, name, tests: [...] }]
        tests_tanpa_alat: tanpaAlat,  // tes yang belum dipetakan ke alat mana pun
      },
    });

  } catch (err) {
    await conn.rollback();
    res.status(500).json({ error: 'Gagal memproses order', details: err.message });
  } finally {
    conn.release();
  }
});

// GET /bridging/result/:simrs_order_id
router.get('/result/:simrs_order_id', async (req, res) => {
  const simrsOrderId = req.params.simrs_order_id;

  try {
    // Cari Request ID dari simrs_order_id
    const [reqRows] = await pool.query(`
      SELECT lr.*, p.name as patient_name, p.medical_record_no, p.gender, p.birth_date
      FROM lab_requests lr
      JOIN patients p ON p.id = lr.patient_id
      WHERE lr.simrs_order_id = ?
    `, [simrsOrderId]);

    if (reqRows.length === 0) {
      return res.status(404).json({ error: 'Data order tidak ditemukan.' });
    }

    const requestData = reqRows[0];

    // Ambil hasil berdasarkan patient_id dan item permintaan
    // Asumsi: Hasil-hasil yang terkait dengan order ini adalah hasil tes yang ada di lab_request_items
    // dan result_at (waktu hasil) >= requested_at. Idealnya LIS punya relasi langsung lab_results -> request_id.
    // Karena saat ini lab_results terhubung ke patient_id dan test_id, kita lakukan mapping.
    
    // #3/#6: relasi presisi via request_id (bukan tebakan tanggal), dan
    // satu baris per pemeriksaan (hindari duplikat akibat >1 kode SIMRS per tes).
    const [resultRows] = await pool.query(`
      SELECT lri.test_id,
             lt.code as test_code, lt.name as test_name,
             lt.reference_min, lt.reference_max, lt.reference_min_l, lt.reference_max_l,
             lt.reference_min_p, lt.reference_max_p, lt.critical_min, lt.critical_max,
             COALESCE(lri.simrs_code,
               (SELECT sm.simrs_field FROM simrs_mappings sm
                  WHERE sm.lis_field = lt.code AND sm.mapping_type = 'test'
                  ORDER BY sm.is_active DESC, sm.id ASC LIMIT 1)) as code_simrs,
             res.id AS result_id, res.result_value, res.unit, res.flag, res.status,
             res.delta_flag, res.critical_ack, res.verified_at, res.result_at,
             res.ref_min_dipakai, res.ref_max_dipakai, res.rujukan_label
      FROM lab_request_items lri
      JOIN lab_tests lt ON lt.id = lri.test_id
      LEFT JOIN lab_results res ON res.id = (
        SELECT r2.id FROM lab_results r2
        WHERE r2.test_id = lri.test_id
          AND (r2.request_id = ? OR (r2.request_id IS NULL AND r2.patient_id = ? AND r2.result_at >= ?))
        ORDER BY (r2.request_id = ?) DESC, r2.result_at DESC LIMIT 1
      )
      WHERE lri.request_id = ?
      GROUP BY lri.test_id
      ORDER BY lt.sort_order ASC, lt.code ASC
    `, [requestData.id, requestData.patient_id, requestData.requested_at, requestData.id, requestData.id]);

    // Format output
    //
    // Rentang rujukan: bila hasil sudah pernah dinilai (ref_min_dipakai /
    // rujukan_label terisi -- lihat POST /results/batch), pakai persis nilai
    // itu, supaya SIMRS menampilkan rentang yang SAMA dengan yang menghasilkan
    // flag-nya. Kalau belum ada (mis. hasil otomatis dari alat, yang belum
    // menyimpan rentang terpakai), hitung langsung memakai umur/jenis kelamin
    // pasien saat ini (rujukanBerlaku) -- bukan jatuh ke rentang umum begitu
    // saja, karena rentang umum bisa keliru untuk anak/lansia/kehamilan.
    const konteksPasien = {
      gender: requestData.gender || null,
      umurHari: umurHari(requestData.birth_date),
      kondisi: null,
    };
    const formattedResults = await Promise.all(resultRows.map(async (r) => {
      const hasValue = r.result_value != null && r.result_value !== '';
      const verified = r.status === 'final' || r.status === 'corrected';
      // Kritis/abnormal/delta mencurigakan yang belum dilaporkan (critical_ack)
      // wajib disertai "siapa yang dihubungi" sebelum bisa diverifikasi lewat
      // POST /result/:id/verify -- SIMRS bisa pakai flag ini untuk menampilkan
      // input pelaporan itu di muka, bukan menunggu 400 dari server dulu.
      const perluLaporan = ['critical', 'abnormal'].includes(r.flag) || r.delta_flag === 'check';

      let reference = r.rujukan_label || null;
      if (!reference && (r.ref_min_dipakai != null || r.ref_max_dipakai != null)) {
        reference = `${r.ref_min_dipakai ?? ''} - ${r.ref_max_dipakai ?? ''}`;
      }
      if (!reference) {
        const rj = await rujukanBerlaku({ id: r.test_id, ...r }, konteksPasien);
        reference = labelRujukan(rj) || null;
      }

      return {
        result_id: r.result_id || null,
        test_code: r.test_code,
        code_simrs: r.code_simrs || null,
        test_name: r.test_name,
        result_value: hasValue ? r.result_value : null,
        unit: r.unit,
        reference,
        flag: r.flag,
        result_time: r.result_at,
        // completed hanya bila sudah diverifikasi; jika ada nilai tapi belum verifikasi => preliminary
        status: hasValue ? (verified ? 'completed' : 'preliminary') : 'pending',
        needs_report_before_verify: !verified && hasValue && perluLaporan && !r.critical_ack,
      };
    }));

    res.json({
      simrs_order_id: requestData.simrs_order_id,
      request_no: requestData.request_no,
      status: requestData.status,
      patient: {
        medical_record_no: requestData.medical_record_no,
        name: requestData.patient_name,
        gender: requestData.gender,
        birth_date: requestData.birth_date
      },
      results: formattedResults
    });

  } catch (err) {
    res.status(500).json({ error: 'Gagal mengambil hasil', details: err.message });
  }
});

/**
 * POST /bridging/result/:id/verify
 *
 * Verifikasi hasil langsung dari SIMRS -- LIS berjalan sebagai layanan latar
 * belakang, petugas tidak perlu pindah ke aplikasi LIS untuk kasus normal
 * maupun kritis. `:id` adalah result_id yang dikembalikan GET /result di atas.
 *
 * Body: { simrs_user_id (wajib, lihat resolveSimrsUser),
 *         reported_to, reported_via, readback, note (wajib HANYA bila hasil
 *         berpenanda kritis/abnormal/delta dan belum pernah dilaporkan) }
 *
 * Hasil kritis/abnormal TIDAK ditolak paksa ke LIS (sesuai keputusan: SIMRS
 * jadi antarmuka utama) -- tapi catatan pelaporan (siapa yang dihubungi, lewat
 * apa, dibacakan ulang atau tidak) tetap wajib diisi dalam panggilan yang
 * sama, supaya syarat akreditasi (PMK 43/2013) tidak ikut terlewati hanya
 * karena jalurnya lebih cepat.
 */
router.post('/result/:id/verify', resolveSimrsUser, requirePermission('results.manage'), async (req, res) => {
  const { reported_to, reported_via, readback, note } = req.body || {};
  try {
    const [rows] = await pool.query(
      'SELECT id, status, flag, delta_flag, critical_ack, request_id FROM lab_results WHERE id = ?',
      [req.params.id]
    );
    const hasil = rows[0];
    if (!hasil) return res.status(404).json({ error: 'Hasil tidak ditemukan.' });
    if (hasil.status !== 'preliminary') {
      return res.status(409).json({ error: `Hasil berstatus '${hasil.status}', tidak bisa diverifikasi lewat jalur ini.` });
    }

    const perluLaporan = ['critical', 'abnormal'].includes(hasil.flag) || hasil.delta_flag === 'check';
    if (perluLaporan && !hasil.critical_ack) {
      if (!reported_to || !String(reported_to).trim()) {
        return res.status(400).json({
          error: 'Hasil ini bertanda kritis/abnormal/delta mencurigakan. Sertakan reported_to (nama yang dihubungi) untuk melanjutkan.',
          requires_report: true,
          flag: hasil.flag,
          delta_flag: hasil.delta_flag,
        });
      }
      await pool.query(
        `UPDATE lab_results
            SET critical_ack = 1, critical_ack_by = ?, critical_ack_at = NOW(),
                critical_reported_to = ?, critical_reported_via = ?, critical_readback = ?, critical_note = ?
          WHERE id = ?`,
        [req.user.id, String(reported_to).trim(), reported_via || null, readback ? 1 : 0, note || null, req.params.id]
      );
      await audit(req, 'ACK', 'result', req.params.id, { reported_to, reported_via, readback: !!readback, source: 'bridging' });
    }

    await pool.query(
      "UPDATE lab_results SET status='final', verified_by=?, verified_at=NOW() WHERE id=?",
      [req.user.id, req.params.id]
    );
    await audit(req, 'VERIFY', 'result', req.params.id, { source: 'bridging' });

    // Order ditutup dan didorong balik ke SIMRS hanya setelah SELURUH item
    // permintaan itu final -- bukan per-hasil, supaya SIMRS tidak menerima
    // laporan sebagian dan mengira pemeriksaan sudah tuntas.
    const [[sisa]] = await pool.query(
      "SELECT COUNT(*) AS n FROM lab_results WHERE request_id = ? AND status = 'preliminary'",
      [hasil.request_id]
    );
    let push = null;
    if (sisa.n === 0) {
      await pool.query(
        "UPDATE lab_requests SET status='completed', completed_at=NOW() WHERE id=?",
        [hasil.request_id]
      ).catch(() => {});
      try {
        push = await pushRequestResultsToSimrs(hasil.request_id);
      } catch (e) {
        push = { error: e.message };
      }
    }

    res.json({ ok: true, verified_by: req.user.username, push });
  } catch (err) {
    res.status(500).json({ error: 'Gagal memverifikasi hasil', details: err.message });
  }
});

// ===========================================================================
// Katalog pemeriksaan dua arah
//
// SIMRS Khanza sudah punya katalog pemeriksaan lengkap (nama, satuan, nilai
// rujukan, id_template). Alih-alih entri ganda, Khanza mendorong katalog itu
// ke GeuLIS: GeuLIS membuat lab_tests bila belum ada, lalu memetakan
// id_template -> kode LIS. Kode LIS SELALU dibuat GeuLIS dan dikembalikan.
//
// Yang TETAP milik lab di GeuLIS (tidak pernah dari Khanza):
//   - tautan ke alat (instrument_test_map) — Khanza tak tahu alat mana
//   - nilai kritis — ditetapkan lab (prinsip alarm, lihat flags.js)
// Rentang rujukan: SIMRS sumber kebenaran (menimpa saat sync).
// ===========================================================================

/** Turunkan kode LIS dari nama pemeriksaan. Huruf besar, alfanumerik +
 *  beberapa tanda, maksimal 30 (batas kolom). Dedupe dengan sufiks angka. */
async function buatKodeLis(nama, conn) {
  const dasar = String(nama || 'TES')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 30) || 'TES';
  let kode = dasar;
  for (let i = 2; i < 100; i++) {
    const [[ada]] = await conn.query('SELECT id FROM lab_tests WHERE code = ?', [kode]);
    if (!ada) return kode;
    kode = `${dasar.slice(0, 30 - String(i).length - 1)}_${i}`;
  }
  return `${dasar.slice(0, 22)}_${Date.now().toString().slice(-6)}`;
}

// GET /bridging/test-catalog — Khanza menariknya untuk rekonsiliasi
router.get('/test-catalog', async (_req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT lt.code AS lis_code, lt.name, lt.unit, lt.is_active,
             lt.reference_min, lt.reference_max,
             lt.reference_min_l, lt.reference_max_l, lt.reference_min_p, lt.reference_max_p,
             lt.critical_min, lt.critical_max,
             i.name AS instrument,
             GROUP_CONCAT(DISTINCT IF(sm.is_active, sm.simrs_field, NULL) ORDER BY sm.simrs_field) AS id_templates_aktif,
             GROUP_CONCAT(DISTINCT IF(sm.is_active, NULL, sm.simrs_field) ORDER BY sm.simrs_field) AS id_templates_nonaktif,
             (SELECT COUNT(*) FROM instrument_test_map m WHERE m.test_id = lt.id) AS instrument_links
        FROM lab_tests lt
        LEFT JOIN instruments i ON i.id = lt.instrument_id
        LEFT JOIN simrs_mappings sm ON sm.lis_field = lt.code AND sm.mapping_type = 'test'
       GROUP BY lt.id
       ORDER BY lt.code`);
    res.json({
      tests: rows.map((r) => ({
        lis_code: r.lis_code,
        name: r.name,
        unit: r.unit,
        is_active: !!r.is_active,
        instrument: r.instrument || null,
        instrument_linked: r.instrument_links > 0,
        reference: {
          min: r.reference_min, max: r.reference_max,
          min_l: r.reference_min_l, max_l: r.reference_max_l,
          min_p: r.reference_min_p, max_p: r.reference_max_p,
        },
        critical: { min: r.critical_min, max: r.critical_max },
        mapped_id_templates: r.id_templates_aktif ? r.id_templates_aktif.split(',') : [],
        mapped_id_templates_nonaktif: r.id_templates_nonaktif ? r.id_templates_nonaktif.split(',') : [],
      })),
    });
  } catch (err) {
    res.status(500).json({ error: 'Gagal mengambil katalog', details: err.message });
  }
});

// POST /bridging/test-catalog — Khanza membuat/memperbarui pemeriksaan + mapping
router.post('/test-catalog', async (req, res) => {
  const { tests } = req.body;
  if (!Array.isArray(tests) || tests.length === 0) {
    return res.status(400).json({ error: 'Daftar tests tidak boleh kosong.' });
  }

  const REF_COLS = ['reference_min', 'reference_max',
    'reference_min_l', 'reference_max_l', 'reference_min_p', 'reference_max_p'];
  const conn = await pool.getConnection();
  const hasil = [];
  try {
    await conn.beginTransaction();
    for (const t of tests) {
      const idTemplate = String(t.id_template ?? '').trim();
      const nama = String(t.name ?? '').trim();
      if (!idTemplate || !nama) {
        hasil.push({ id_template: t.id_template ?? null, action: 'skipped', reason: 'id_template & name wajib' });
        continue;
      }
      const ref = {};
      for (const c of REF_COLS) ref[c] = (t[c] === '' || t[c] == null) ? null : Number(t[c]);
      const warnings = [];

      // Sudah pernah dipetakan? -> jalur update
      const [[mapAda]] = await conn.query(
        "SELECT id, lis_field FROM simrs_mappings WHERE mapping_type='test' AND simrs_field = ?",
        [idTemplate]
      );

      let lisCode;
      let action;
      if (mapAda) {
        lisCode = mapAda.lis_field;
        const [[lt]] = await conn.query('SELECT id, instrument_id FROM lab_tests WHERE code = ?', [lisCode]);
        if (lt) {
          if (lt.instrument_id) warnings.push('tes ini terhubung alat; rujukan dari SIMRS menimpa yang lama');
          await conn.query(
            `UPDATE lab_tests SET name=?, unit=?, ${REF_COLS.map((c) => `${c}=?`).join(', ')} WHERE id=?`,
            [nama, t.unit ?? null, ...REF_COLS.map((c) => ref[c]), lt.id]
          );
          action = 'updated';
        } else {
          // mapping menunjuk kode yang lab_tests-nya sudah hilang -> buat ulang
          await conn.query(
            `INSERT INTO lab_tests (code, name, unit, ${REF_COLS.join(', ')}, is_active, show_in_report, sort_order)
             VALUES (?, ?, ?, ${REF_COLS.map(() => '?').join(', ')}, 1, 1, 999)`,
            [lisCode, nama, t.unit ?? null, ...REF_COLS.map((c) => ref[c])]
          );
          action = 'recreated';
        }
        await conn.query('UPDATE simrs_mappings SET is_active=1 WHERE id=?', [mapAda.id]);
      } else {
        // Belum ada mapping. Kode diturunkan dari nama; kalau kodenya sudah
        // ada sebagai lab_tests, tautkan ke situ (jangan duplikat).
        const kandidat = String(nama).toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 30) || 'TES';
        const [[kodeAda]] = await conn.query('SELECT id, instrument_id FROM lab_tests WHERE code = ?', [kandidat]);
        if (kodeAda) {
          lisCode = kandidat;
          if (kodeAda.instrument_id) warnings.push('ditautkan ke tes yang sudah ada & terhubung alat; rujukan SIMRS menimpa');
          await conn.query(
            `UPDATE lab_tests SET name=?, unit=?, ${REF_COLS.map((c) => `${c}=?`).join(', ')} WHERE id=?`,
            [nama, t.unit ?? null, ...REF_COLS.map((c) => ref[c]), kodeAda.id]
          );
          action = 'linked';
        } else {
          lisCode = await buatKodeLis(nama, conn);
          await conn.query(
            `INSERT INTO lab_tests (code, name, unit, ${REF_COLS.join(', ')}, is_active, show_in_report, sort_order)
             VALUES (?, ?, ?, ${REF_COLS.map(() => '?').join(', ')}, 1, 1, 999)`,
            [lisCode, nama, t.unit ?? null, ...REF_COLS.map((c) => ref[c])]
          );
          action = 'created';
        }
        await conn.query(
          "INSERT INTO simrs_mappings (mapping_type, lis_field, simrs_field, is_active) VALUES ('test', ?, ?, 1)",
          [lisCode, idTemplate]
        );
      }
      hasil.push({ id_template: idTemplate, lis_code: lisCode, action, warnings });
    }
    await conn.commit();
    await audit(req, 'SYNC', 'test_catalog', null, { source: 'bridging', hasil });
    res.json({ tests: hasil });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ error: 'Gagal menyimpan katalog', details: err.message });
  } finally {
    conn.release();
  }
});

// DELETE /bridging/test-catalog/:id_template  (?mode=deactivate untuk nonaktif saja)
router.delete('/test-catalog/:id_template', async (req, res) => {
  const idTemplate = String(req.params.id_template).trim();
  const mode = req.query.mode === 'deactivate' ? 'deactivate' : 'delete';
  try {
    const [[map]] = await pool.query(
      "SELECT id, lis_field FROM simrs_mappings WHERE mapping_type='test' AND simrs_field=?",
      [idTemplate]
    );
    if (!map) return res.status(404).json({ error: 'Mapping id_template tersebut tidak ada.' });

    if (mode === 'deactivate') {
      await pool.query('UPDATE simrs_mappings SET is_active=0 WHERE id=?', [map.id]);
    } else {
      await pool.query('DELETE FROM simrs_mappings WHERE id=?', [map.id]);
      // Nonaktifkan lab_tests-nya HANYA bila tidak dipakai apa pun lagi:
      // tidak terhubung alat, tidak punya hasil, dan tidak ada mapping lain.
      const [[lt]] = await pool.query('SELECT id, instrument_id FROM lab_tests WHERE code=?', [map.lis_field]);
      if (lt && !lt.instrument_id) {
        const [[pakai]] = await pool.query(
          `SELECT
             (SELECT COUNT(*) FROM instrument_test_map m WHERE m.test_id=?) +
             (SELECT COUNT(*) FROM lab_results r WHERE r.test_id=?) +
             (SELECT COUNT(*) FROM simrs_mappings s WHERE s.lis_field=? AND s.mapping_type='test') AS n`,
          [lt.id, lt.id, map.lis_field]
        );
        if (pakai.n === 0) await pool.query('UPDATE lab_tests SET is_active=0 WHERE id=?', [lt.id]);
      }
    }
    await audit(req, mode === 'deactivate' ? 'DEACTIVATE' : 'DELETE', 'test_catalog', map.id,
      { source: 'bridging', id_template: idTemplate, lis_code: map.lis_field });
    res.json({ id_template: idTemplate, lis_code: map.lis_field, action: mode === 'deactivate' ? 'deactivated' : 'deleted' });
  } catch (err) {
    res.status(500).json({ error: 'Gagal menghapus mapping', details: err.message });
  }
});

export default router;
