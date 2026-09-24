import { Router } from 'express';
import pool from '../config/db.js';
import { authenticate, requirePermission } from '../middleware/auth.js';
import { PROTOCOL_HELP } from '../services/protocolParsers.js';
import { reloadInstrumentListeners } from '../services/instrumentListener.js';
import { audit } from '../services/audit.js';
import { PROFIL_ALAT, cariProfil } from '../data/instrumentProfiles.js';

const router = Router();

router.get('/protocols', authenticate, requirePermission('instruments.view'), (_req, res) => {
  res.json(PROTOCOL_HELP);
});

// Katalog profil alat siap-pakai (protokol + koneksi + peta kode tes awal).
router.get('/profiles', authenticate, requirePermission('instruments.view'), (_req, res) => {
  res.json(PROFIL_ALAT);
});

// Terapkan profil: buat alat sekaligus peta kode tes awalnya dalam satu langkah.
// Tes LIS yang belum ada dibuat otomatis (perilaku sama seperti pemetaan manual),
// supaya peta tidak menggantung ke tes yang tidak ada.
router.post('/apply-profile', authenticate, requirePermission('instruments.manage'), async (req, res) => {
  const { profile_id, code, name, host, port, is_active } = req.body;
  const profil = cariProfil(profile_id);
  if (!profil) return res.status(400).json({ error: 'Profil tidak dikenal' });
  if (!code || !name) return res.status(400).json({ error: 'Kode dan nama alat wajib diisi' });

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [ins] = await conn.query(
      `INSERT INTO instruments (code, name, manufacturer, model, protocol, conn_mode, host, port, config_json, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [code, name, profil.pabrikan, profil.model, profil.protokol,
       profil.mode === 'client' ? 'client' : 'server',
       host || (profil.mode === 'client' ? '' : '0.0.0.0'), port || profil.port,
       JSON.stringify({ profil: profil.id }), is_active ?? 1]
    );
    const instrumentId = ins.insertId;

    let tesDibuat = 0, petaTerpasang = 0;
    for (const p of profil.peta) {
      // Cari tes LIS berdasarkan kode; buat bila belum ada.
      let [[tes]] = await conn.query('SELECT id FROM lab_tests WHERE code = ?', [p.lis]);
      if (!tes) {
        const [t] = await conn.query(
          'INSERT INTO lab_tests (code, name, is_active) VALUES (?, ?, 1)',
          [p.lis, p.nama || p.lis]
        );
        tes = { id: t.insertId };
        tesDibuat++;
      }
      // Lewati bila peta dengan kode alat yang sama sudah ada (idempoten).
      const [[ada]] = await conn.query(
        'SELECT id FROM instrument_test_map WHERE instrument_id = ? AND instrument_test_code = ?',
        [instrumentId, p.alat]
      );
      if (!ada) {
        await conn.query(
          'INSERT INTO instrument_test_map (instrument_id, instrument_test_code, test_id) VALUES (?, ?, ?)',
          [instrumentId, p.alat, tes.id]
        );
        petaTerpasang++;
      }
    }
    await conn.commit();
    await audit(req, 'APPLY_PROFILE', 'instrument', instrumentId, { profil: profil.id, tesDibuat, petaTerpasang });
    await reloadInstrumentListeners().catch(() => {});
    res.status(201).json({
      id: instrumentId, tes_dibuat: tesDibuat, peta_terpasang: petaTerpasang,
      terverifikasi: profil.terverifikasi,
    });
  } catch (e) {
    await conn.rollback().catch(() => {});
    res.status(500).json({ error: e.message });
  } finally {
    conn.release();
  }
});

// #7 Reload listener alat tanpa restart backend
router.post('/reload', authenticate, requirePermission('instruments.manage'), async (req, res) => {
  try {
    const out = await reloadInstrumentListeners();
    await audit(req, 'RELOAD', 'instrument', null, out);
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/', authenticate, requirePermission('instruments.view'), async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM instruments ORDER BY name');
  res.json(rows);
});

router.get('/:id/maps', authenticate, requirePermission('instruments.view'), async (req, res) => {
  const [rows] = await pool.query(
    `SELECT m.*, lt.code AS test_code, lt.name AS test_name
     FROM instrument_test_map m
     JOIN lab_tests lt ON lt.id = m.test_id
     WHERE m.instrument_id = ?`,
    [req.params.id]
  );
  res.json(rows);
});

router.post('/', authenticate, requirePermission('instruments.manage'), async (req, res) => {
  // conn_mode menentukan arah koneksi: 'server' = alat menghubungi LIS,
  // 'client' = LIS menghubungi alat (Mindray BC-3600/BC-11). Sebelumnya kolom
  // ini tidak pernah dibaca di sini maupun di PUT, sehingga alat mode client
  // hanya bisa didaftarkan lewat SQL dan penambahan dari aplikasi selalu salah
  // arah — backend malah mencoba mendengarkan di alamat milik alat.
  const { code, name, manufacturer, model, protocol, conn_mode, host, port, config_json, is_active } = req.body;
  const [r] = await pool.query(
    `INSERT INTO instruments (code, name, manufacturer, model, protocol, conn_mode, host, port, config_json, is_active)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [code, name, manufacturer, model, protocol || 'astm', conn_mode === 'client' ? 'client' : 'server',
     host || '0.0.0.0', port || 5000, JSON.stringify(config_json || {}), is_active ?? 1] // protocol: astm|hl7|json|xml
  );
  await audit(req, 'CREATE', 'instrument', r.insertId, { code, name, port });
  res.status(201).json({ id: r.insertId });
});

router.put('/:id', authenticate, requirePermission('instruments.manage'), async (req, res) => {
  const { code, name, manufacturer, model, protocol, conn_mode, host, port, config_json, is_active } = req.body;
  await pool.query(
    `UPDATE instruments SET code=?, name=?, manufacturer=?, model=?, protocol=?, conn_mode=?, host=?, port=?, config_json=?, is_active=?
     WHERE id=?`,
    [code, name, manufacturer, model, protocol, conn_mode === 'client' ? 'client' : 'server',
     host, port, JSON.stringify(config_json || {}), is_active ? 1 : 0, req.params.id]
  );
  await audit(req, 'UPDATE', 'instrument', req.params.id, { code, port, is_active });
  res.json({ ok: true });
});

router.post('/:id/maps', authenticate, requirePermission('instruments.manage'), async (req, res) => {
  const { instrument_test_code, test_id } = req.body;
  await pool.query(
    'INSERT INTO instrument_test_map (instrument_id, instrument_test_code, test_id) VALUES (?, ?, ?)',
    [req.params.id, instrument_test_code, test_id]
  );
  res.json({ ok: true });
});

router.delete('/maps/:mapId', authenticate, requirePermission('instruments.manage'), async (req, res) => {
  await pool.query('DELETE FROM instrument_test_map WHERE id = ?', [req.params.mapId]);
  res.json({ ok: true });
});

/**
 * Log mentah lalu lintas alat -- dulu cuma 50 baris terbaru tanpa filter,
 * dengan cuplikan 100 karakter yang tidak cukup untuk ditelusuri sungguhan.
 * Sekarang bisa disaring per alat/status/rentang tanggal/kata kunci, supaya
 * admin bisa mengevaluasi apa yang SEBENARNYA dikirim alat tanpa perlu ke
 * layar alatnya langsung -- mis. saat ada keluhan "hasil tidak masuk" atau
 * "salah pasien", raw_data di sini adalah rekaman apa adanya, bukan hasil
 * yang sudah diolah.
 */
router.get('/logs/recent', authenticate, requirePermission('instruments.view'), async (req, res) => {
  const { instrument_id, status, q, from, to } = req.query;
  const kondisi = [];
  const params = [];
  if (instrument_id) { kondisi.push('l.instrument_id = ?'); params.push(instrument_id); }
  if (status) { kondisi.push('l.parsed_status = ?'); params.push(status); }
  if (q) { kondisi.push('l.raw_data LIKE ?'); params.push(`%${q}%`); }
  if (from) { kondisi.push('l.created_at >= ?'); params.push(`${from} 00:00:00`); }
  if (to) { kondisi.push('l.created_at <= ?'); params.push(`${to} 23:59:59`); }

  // Batas dinaikkan dari 50 menjadi 200 untuk kebutuhan evaluasi (butuh
  // menelusuri beberapa hari ke belakang), tetap dibatasi supaya tidak
  // menarik seluruh tabel tanpa sengaja.
  const limit = Math.min(Number(req.query.limit) || 200, 500);
  let sql = `SELECT l.*, i.name AS instrument_name FROM instrument_logs l
             LEFT JOIN instruments i ON i.id = l.instrument_id`;
  if (kondisi.length) sql += ' WHERE ' + kondisi.join(' AND ');
  sql += ' ORDER BY l.created_at DESC LIMIT ' + limit;

  const [rows] = await pool.query(sql, params);
  res.json(rows);
});

router.delete('/:id', authenticate, requirePermission('instruments.manage'), async (req, res) => {
  await pool.query('DELETE FROM instruments WHERE id = ?', [req.params.id]);
  await audit(req, 'DELETE', 'instrument', req.params.id);
  res.json({ ok: true });
});

export default router;
