import { Router } from 'express';
import pool from '../config/db.js';
import { authenticate, requirePermission } from '../middleware/auth.js';

const router = Router();

router.get('/', authenticate, requirePermission('mapping.view'), async (req, res) => {
  const [mappings] = await pool.query('SELECT * FROM simrs_mappings ORDER BY mapping_type, lis_field');
  const [config] = await pool.query('SELECT id, base_url, auth_type, is_active, updated_at FROM simrs_config LIMIT 1');
  res.json({ mappings, config: config[0] || null });
});

router.post('/', authenticate, requirePermission('mapping.manage'), async (req, res) => {
  const { mapping_type, lis_field, simrs_field, transform_rule, notes } = req.body;
  const [r] = await pool.query(
    'INSERT INTO simrs_mappings (mapping_type, lis_field, simrs_field, transform_rule, notes) VALUES (?, ?, ?, ?, ?)',
    [mapping_type, lis_field, simrs_field, transform_rule, notes]
  );
  res.status(201).json({ id: r.insertId });
});

router.put('/:id', authenticate, requirePermission('mapping.manage'), async (req, res) => {
  const { mapping_type, lis_field, simrs_field, transform_rule, is_active, notes } = req.body;
  await pool.query(
    'UPDATE simrs_mappings SET mapping_type=?, lis_field=?, simrs_field=?, transform_rule=?, is_active=?, notes=? WHERE id=?',
    [mapping_type, lis_field, simrs_field, transform_rule, is_active ? 1 : 0, notes, req.params.id]
  );
  res.json({ ok: true });
});

router.delete('/:id', authenticate, requirePermission('mapping.manage'), async (req, res) => {
  await pool.query('DELETE FROM simrs_mappings WHERE id = ?', [req.params.id]);
  res.json({ ok: true });
});

// Pemetaan user SIMRS -> user GeuLIS.
//
// Dipakai bridging.js (resolveSimrsUser) supaya verifikasi hasil yang dipicu
// dari SIMRS tercatat atas nama petugas GeuLIS yang sebenarnya, bukan API key
// generik -- lihat catatan di ensureSchema.js pada tabel simrs_user_map.
router.get('/users', authenticate, requirePermission('mapping.view'), async (req, res) => {
  const [rows] = await pool.query(
    `SELECT m.id, m.simrs_user_id, m.notes, m.created_at,
            u.id AS geulis_user_id, u.username, u.full_name, u.is_active
       FROM simrs_user_map m
       JOIN users u ON u.id = m.geulis_user_id
      ORDER BY u.full_name`
  );
  res.json(rows);
});

router.post('/users', authenticate, requirePermission('mapping.manage'), async (req, res) => {
  const { simrs_user_id, geulis_user_id, notes } = req.body;
  if (!simrs_user_id || !geulis_user_id) {
    return res.status(400).json({ error: 'simrs_user_id dan geulis_user_id wajib diisi' });
  }
  try {
    const [r] = await pool.query(
      'INSERT INTO simrs_user_map (simrs_user_id, geulis_user_id, notes) VALUES (?, ?, ?)',
      [String(simrs_user_id).trim(), geulis_user_id, notes || null]
    );
    res.status(201).json({ id: r.insertId });
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'ID user SIMRS ini sudah dipetakan ke akun lain.' });
    res.status(500).json({ error: e.message });
  }
});

router.delete('/users/:id', authenticate, requirePermission('mapping.manage'), async (req, res) => {
  await pool.query('DELETE FROM simrs_user_map WHERE id = ?', [req.params.id]);
  res.json({ ok: true });
});

router.put('/config/simrs', authenticate, requirePermission('mapping.manage'), async (req, res) => {
  const { base_url, api_key, auth_type, username, is_active } = req.body;
  const [existing] = await pool.query('SELECT id FROM simrs_config LIMIT 1');
  if (existing[0]) {
    await pool.query(
      'UPDATE simrs_config SET base_url=?, api_key=?, auth_type=?, username=?, is_active=? WHERE id=?',
      [base_url, api_key, auth_type, username, is_active ? 1 : 0, existing[0].id]
    );
  } else {
    await pool.query(
      'INSERT INTO simrs_config (base_url, api_key, auth_type, username, is_active) VALUES (?, ?, ?, ?, ?)',
      [base_url, api_key, auth_type, username, is_active ? 1 : 0]
    );
  }
  res.json({ ok: true });
});

router.post('/bridge/push-result/:resultId', authenticate, requirePermission('mapping.manage'), async (req, res) => {
  const [results] = await pool.query(
    `SELECT res.*, lt.code AS test_code, p.medical_record_no, p.order_no
     FROM lab_results res
     JOIN lab_tests lt ON lt.id = res.test_id
     JOIN patients p ON p.id = res.patient_id
     WHERE res.id = ?`,
    [req.params.resultId]
  );
  const result = results[0];
  if (!result) return res.status(404).json({ error: 'Hasil tidak ditemukan' });

  const [mappings] = await pool.query("SELECT * FROM simrs_mappings WHERE mapping_type='result' AND is_active=1");
  const [cfgRows] = await pool.query('SELECT * FROM simrs_config WHERE is_active=1 LIMIT 1');
  const cfg = cfgRows[0];
  if (!cfg) return res.status(400).json({ error: 'Konfigurasi SIMRS belum aktif' });

  const payload = {};
  for (const m of mappings) {
    const val = result[m.lis_field] ?? result[m.lis_field.replace(/_([a-z])/g, (_, c) => c.toUpperCase())];
    payload[m.simrs_field] = val;
  }
  payload.no_rm = result.medical_record_no;

  const [testMappings] = await pool.query("SELECT lis_field, simrs_field FROM simrs_mappings WHERE mapping_type='test' AND is_active=1");
  const testMapDict = {};
  testMappings.forEach(m => { testMapDict[m.lis_field] = m.simrs_field; });
  
  payload.kode_pemeriksaan = testMapDict[result.test_code] || result.test_code;

  try {
    const headers = { 'Content-Type': 'application/json' };
    if (cfg.auth_type === 'bearer' && cfg.api_key) headers.Authorization = `Bearer ${cfg.api_key}`;
    const url = `${cfg.base_url.replace(/\/$/, '')}/hasil-lab`;
    const resp = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload) });
    const text = await resp.text();
    res.json({ ok: resp.ok, status: resp.status, payload, response: text });
  } catch (e) {
    res.status(502).json({ error: 'Gagal menghubungi SIMRS', detail: e.message, payload });
  }
});

router.post('/bridge/pull-orders', authenticate, requirePermission('mapping.manage'), async (req, res) => {
  const [cfgRows] = await pool.query('SELECT * FROM simrs_config WHERE is_active=1 LIMIT 1');
  const cfg = cfgRows[0];
  if (!cfg) return res.status(400).json({ error: 'Konfigurasi SIMRS belum aktif' });
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (cfg.auth_type === 'bearer' && cfg.api_key) headers.Authorization = `Bearer ${cfg.api_key}`;
    const url = `${cfg.base_url.replace(/\/$/, '')}/order-lab/pending`;
    const resp = await fetch(url, { headers });
    const data = await resp.json().catch(() => ({}));
    res.json({ ok: resp.ok, orders: data });
  } catch (e) {
    res.status(502).json({ error: 'Gagal pull order dari SIMRS', detail: e.message });
  }
});

export default router;
