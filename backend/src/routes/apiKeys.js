import { Router } from 'express';
import pool from '../config/db.js';
import { authenticate, requirePermission } from '../middleware/auth.js';
import crypto from 'crypto';
import { hashApiKey, enkripsiApiKey, dekripsiApiKey, samarkanApiKey } from '../services/rahasiaApiKey.js';
import { audit } from '../services/audit.js';

const router = Router();

/**
 * Daftar API key -- TIDAK menyertakan key aslinya sama sekali. Cukup untuk
 * mengenali key yang mana (nama, dibuat siapa, kapan) dan bentuk
 * tersamarkan (mis. "khanza_9960…8a4d") supaya admin bisa mencocokkan
 * dengan yang ditempel di konfigurasi SIMRS tanpa perlu membuka key
 * lengkapnya. Lihat POST /:id/reveal untuk melihat/menyalin key lengkap.
 */
router.get('/', authenticate, requirePermission('settings.manage'), async (req, res) => {
  const [rows] = await pool.query(`
    SELECT k.id, k.name, k.created_at, k.api_key_enc, u.full_name as creator_name
    FROM api_keys k
    LEFT JOIN users u ON u.id = k.created_by
    ORDER BY k.created_at DESC
  `);
  res.json(rows.map((k) => {
    let masked = null;
    try { masked = k.api_key_enc ? samarkanApiKey(dekripsiApiKey(k.api_key_enc)) : null; } catch { masked = null; }
    return { id: k.id, name: k.name, created_at: k.created_at, creator_name: k.creator_name, api_key_masked: masked };
  }));
});

router.post('/', authenticate, requirePermission('settings.manage'), async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'Nama API Key wajib diisi' });

  // Generate a random key (32 bytes -> 64 chars hex)
  const apiKey = 'khanza_' + crypto.randomBytes(24).toString('hex');

  try {
    await pool.query(
      'INSERT INTO api_keys (name, key_hash, api_key_enc, created_by) VALUES (?, ?, ?, ?)',
      [name, hashApiKey(apiKey), enkripsiApiKey(apiKey), req.user.id]
    );
    await audit(req, 'CREATE', 'api_key', null, { name });
    // Satu-satunya saat key lengkap keluar tanpa lewat /reveal -- pas dibuat.
    res.status(201).json({ api_key: apiKey });
  } catch (err) {
    res.status(500).json({ error: 'Gagal membuat API Key' });
  }
});

/**
 * Singkap key lengkap untuk disalin ulang -- dicatat ke audit log. Beda
 * dari sebelumnya (key mentah ikut di setiap GET /), sekarang cuma
 * terlihat kalau memang diminta secara eksplisit dan tercatat siapa yang
 * melihatnya kapan.
 */
router.post('/:id/reveal', authenticate, requirePermission('settings.manage'), async (req, res) => {
  const [[row]] = await pool.query('SELECT id, name, api_key_enc FROM api_keys WHERE id = ?', [req.params.id]);
  if (!row) return res.status(404).json({ error: 'API Key tidak ditemukan' });
  if (!row.api_key_enc) return res.status(410).json({ error: 'Key ini dibuat sebelum enkripsi diaktifkan dan tidak bisa dipulihkan -- buat key baru.' });
  try {
    const apiKey = dekripsiApiKey(row.api_key_enc);
    await audit(req, 'REVEAL', 'api_key', row.id, { name: row.name });
    res.json({ api_key: apiKey });
  } catch (err) {
    res.status(500).json({ error: 'Gagal membuka API Key' });
  }
});

router.delete('/:id', authenticate, requirePermission('settings.manage'), async (req, res) => {
  await pool.query('DELETE FROM api_keys WHERE id = ?', [req.params.id]);
  await audit(req, 'DELETE', 'api_key', req.params.id);
  res.json({ ok: true });
});

export default router;
