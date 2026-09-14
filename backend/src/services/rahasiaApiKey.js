import crypto from 'crypto';

/**
 * Penyimpanan API key bridging (dipakai SIMRS) yang tidak lagi plaintext.
 *
 * Dua kebutuhan yang tampak bertentangan: autentikasi butuh pencarian cepat
 * ("apiKey ini punya siapa?"), sedangkan halaman Pengaturan punya fitur
 * "salin lagi" -- admin yang kehilangan key perlu bisa memulihkannya tanpa
 * generate ulang (yang berarti Khanza juga harus dikonfigurasi ulang).
 *
 * Solusinya dua kolom dengan tujuan berbeda:
 * - key_hash: SHA-256 satu-arah, diindeks, dipakai requireApiKey() setiap
 *   permintaan masuk. Cepat, dan DB yang bocor tidak memberi key yang bisa
 *   dipakai ulang.
 * - api_key_enc: AES-256-GCM dua-arah, HANYA didekripsi saat admin secara
 *   eksplisit menekan "Salin" di UI (dicatat ke audit log) -- bukan
 *   dikembalikan begitu saja di daftar API key.
 *
 * Kunci AES diturunkan dari JWT_SECRET (bukan secret terpisah) supaya tidak
 * ada langkah setup .env tambahan -- JWT_SECRET sudah wajib ada, ≥32
 * karakter, dan menjadi akar kepercayaan yang sama seperti bagian lain
 * aplikasi ini (lihat index.js: tanpa JWT_SECRET aplikasi menolak start).
 */

let kunciCache = null;
function kunciDerivasi() {
  if (kunciCache) return kunciCache;
  if (!process.env.JWT_SECRET) {
    throw new Error('JWT_SECRET tidak ada -- tidak bisa menurunkan kunci enkripsi API key.');
  }
  kunciCache = crypto.scryptSync(process.env.JWT_SECRET, 'geulis-api-key-v1', 32);
  return kunciCache;
}

/** Sidik jari satu-arah untuk pencarian saat autentikasi. */
export function hashApiKey(teks) {
  return crypto.createHash('sha256').update(String(teks), 'utf8').digest('hex');
}

/** Enkripsi dua-arah untuk pemulihan ("salin lagi") -- bukan untuk autentikasi. */
export function enkripsiApiKey(teks) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', kunciDerivasi(), iv);
  const enc = Buffer.concat([cipher.update(String(teks), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString('hex'), tag.toString('hex'), enc.toString('hex')].join(':');
}

/** Kebalikan enkripsiApiKey(). Melempar kalau paket rusak/kunci berubah. */
export function dekripsiApiKey(paket) {
  const [ivHex, tagHex, encHex] = String(paket).split(':');
  if (!ivHex || !tagHex || !encHex) throw new Error('Paket API key terenkripsi tidak valid.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', kunciDerivasi(), Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  const dec = Buffer.concat([decipher.update(Buffer.from(encHex, 'hex')), decipher.final()]);
  return dec.toString('utf8');
}

/** "khanza_ab12...ef90" -> "khanza_ab12...ef90" disamarkan jadi "khanza_ab12…f90" utk daftar. */
export function samarkanApiKey(teks) {
  const s = String(teks);
  if (s.length <= 12) return s;
  return `${s.slice(0, 10)}…${s.slice(-4)}`;
}
