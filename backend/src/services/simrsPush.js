import pool from '../config/db.js';

/**
 * Kirim satu hasil lab ke SIMRS eksternal sesuai konfigurasi simrs_config
 * dan mapping simrs_mappings (mapping_type='result' & 'test').
 * Best-effort: mengembalikan {ok, skipped?, status?, error?} — tidak melempar.
 */
export async function pushResultToSimrs(resultId) {
  const [results] = await pool.query(
    `SELECT res.*, lt.code AS test_code, p.medical_record_no, p.order_no
     FROM lab_results res
     JOIN lab_tests lt ON lt.id = res.test_id
     JOIN patients p ON p.id = res.patient_id
     WHERE res.id = ?`,
    [resultId]
  );
  const result = results[0];
  if (!result) return { ok: false, error: 'Hasil tidak ditemukan' };

  const [cfgRows] = await pool.query('SELECT * FROM simrs_config WHERE is_active=1 LIMIT 1');
  const cfg = cfgRows[0];
  if (!cfg) return { ok: false, skipped: true, reason: 'Konfigurasi SIMRS tidak aktif' };

  const [mappings] = await pool.query("SELECT * FROM simrs_mappings WHERE mapping_type='result' AND is_active=1");
  const payload = {};
  for (const m of mappings) {
    const camel = m.lis_field.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
    payload[m.simrs_field] = result[m.lis_field] ?? result[camel];
  }
  payload.no_rm = result.medical_record_no;
  payload.no_order = result.order_no;

  const [testMappings] = await pool.query("SELECT lis_field, simrs_field FROM simrs_mappings WHERE mapping_type='test' AND is_active=1");
  const testMapDict = {};
  testMappings.forEach((m) => { testMapDict[m.lis_field] = m.simrs_field; });
  payload.kode_pemeriksaan = testMapDict[result.test_code] || result.test_code;
  payload.nilai_hasil = result.result_value;
  payload.flag = result.flag;

  try {
    const headers = { 'Content-Type': 'application/json' };
    if (cfg.auth_type === 'bearer' && cfg.api_key) headers.Authorization = `Bearer ${cfg.api_key}`;
    if (cfg.auth_type === 'api_key' && cfg.api_key) headers['x-api-key'] = cfg.api_key;
    const url = `${cfg.base_url.replace(/\/$/, '')}/hasil-lab`;
    const resp = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload) });
    const text = await resp.text().catch(() => '');
    return { ok: resp.ok, status: resp.status, response: text.slice(0, 500) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/** Push semua hasil pada satu request (dipakai saat verifikasi order selesai). */
export async function pushRequestResultsToSimrs(requestId) {
  const [rows] = await pool.query('SELECT id FROM lab_results WHERE request_id = ?', [requestId]);
  const out = [];
  for (const r of rows) out.push(await pushResultToSimrs(r.id));
  return { total: rows.length, pushed: out.filter((x) => x.ok).length, details: out };
}

/**
 * Notifikasi SEGERA ke SIMRS begitu ada nilai kritis baru dari alat --
 * sebelum diverifikasi siapa pun. Ini beda tujuan dari pushResultToSimrs
 * (yang mengirim hasil FINAL setelah diverifikasi): nilai kritis tidak boleh
 * menunggu seseorang kebetulan membuka layar LIS, atau menunggu SIMRS
 * kebetulan memoling GET /result duluan. Tanpa ini, hasil kritis yang muncul
 * di luar jam ada orang menatap layar bisa tidak diketahui berjam-jam.
 *
 * Endpoint tujuan: `${base_url}/notifikasi-kritis` (lihat docs/BRIDGING_SIMRS.md
 * §6a) -- perlu diimplementasikan di sisi SIMRS. Best-effort, tidak pernah
 * melempar: gagal kirim notifikasi TIDAK BOLEH menggagalkan penyimpanan hasil
 * dari alat.
 */
export async function notifikasiKritisKeSimrs(resultId) {
  try {
    const [rows] = await pool.query(
      `SELECT res.result_value, res.unit, res.flag, res.result_at,
              lt.code AS test_code, lt.name AS test_name,
              p.medical_record_no, p.name AS patient_name,
              lr.simrs_order_id
         FROM lab_results res
         JOIN lab_tests lt ON lt.id = res.test_id
         JOIN patients p ON p.id = res.patient_id
         LEFT JOIN lab_requests lr ON lr.id = res.request_id
        WHERE res.id = ?`,
      [resultId]
    );
    const r = rows[0];
    if (!r) return { ok: false, error: 'Hasil tidak ditemukan' };

    const [cfgRows] = await pool.query('SELECT * FROM simrs_config WHERE is_active=1 LIMIT 1');
    const cfg = cfgRows[0];
    if (!cfg) return { ok: false, skipped: true, reason: 'Konfigurasi SIMRS tidak aktif' };

    const [testMappings] = await pool.query(
      "SELECT lis_field, simrs_field FROM simrs_mappings WHERE mapping_type='test' AND is_active=1"
    );
    const testMapDict = {};
    testMappings.forEach((m) => { testMapDict[m.lis_field] = m.simrs_field; });

    const payload = {
      no_rm: r.medical_record_no,
      nama_pasien: r.patient_name,
      no_order: r.simrs_order_id,
      kode_pemeriksaan: testMapDict[r.test_code] || r.test_code,
      nama_pemeriksaan: r.test_name,
      nilai_hasil: r.result_value,
      satuan: r.unit,
      flag: r.flag,
      waktu_hasil: r.result_at,
    };

    const headers = { 'Content-Type': 'application/json' };
    if (cfg.auth_type === 'bearer' && cfg.api_key) headers.Authorization = `Bearer ${cfg.api_key}`;
    if (cfg.auth_type === 'api_key' && cfg.api_key) headers['x-api-key'] = cfg.api_key;
    const url = `${cfg.base_url.replace(/\/$/, '')}/notifikasi-kritis`;
    const resp = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload) });
    const text = await resp.text().catch(() => '');
    return { ok: resp.ok, status: resp.status, response: text.slice(0, 500) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * Notifikasi ke SIMRS begitu ada hasil yang PERLU DITINJAU petugas --
 * pasiennya tidak ketemu sama sekali ("unmatched"), atau pasiennya ketemu
 * tapi tidak bisa tertaut ke permintaan mana pun karena datanya ambigu
 * ("yatim" -- lihat findRequestLink di instrumentListener.js/results.js).
 *
 * Tujuannya sama seperti notifikasiKritisKeSimrs: petugas tidak perlu ingat
 * membuka menu Hasil Belum Cocok di LIS sendiri. TIDAK PERNAH menyarankan
 * pasien/permintaan mana yang cocok lewat jalur ini -- itu tetap keputusan
 * manusia di LIS (lihat GET /unmatched/:id/saran), supaya SIMRS tidak
 * menampilkan tebakan sebagai fakta.
 *
 * Endpoint tujuan: `${base_url}/notifikasi-tinjau` (lihat docs/BRIDGING_SIMRS.md
 * §6c) -- perlu diimplementasikan di sisi SIMRS. Best-effort, tidak pernah
 * melempar: gagal kirim notifikasi TIDAK BOLEH menggagalkan penyimpanan hasil
 * dari alat.
 */
export async function notifikasiPerluTinjauKeSimrs(jenis, id) {
  try {
    const [cfgRows] = await pool.query('SELECT * FROM simrs_config WHERE is_active=1 LIMIT 1');
    const cfg = cfgRows[0];
    if (!cfg) return { ok: false, skipped: true, reason: 'Konfigurasi SIMRS tidak aktif' };

    let payload;
    if (jenis === 'unmatched') {
      const [[u]] = await pool.query(
        `SELECT u.sample_id, u.payload, u.received_at, i.name AS instrument_name
           FROM unmatched_results u
           LEFT JOIN instruments i ON i.id = u.instrument_id
          WHERE u.id = ?`,
        [id]
      );
      if (!u) return { ok: false, error: 'Hasil tidak ditemukan' };
      const isi = typeof u.payload === 'string' ? JSON.parse(u.payload) : u.payload || [];
      payload = {
        jenis: 'unmatched',
        sample_id: u.sample_id,
        no_rm: null,
        nama_pasien: null,
        parameter: isi.map((p) => p.test_code).filter(Boolean),
        instrumen: u.instrument_name,
        waktu: u.received_at,
        pesan: `Hasil dari sampel "${u.sample_id}" tidak ditemukan pasiennya. Buka menu Hasil Belum Cocok di LIS untuk mencocokkan.`,
      };
    } else if (jenis === 'yatim') {
      const [[r]] = await pool.query(
        `SELECT res.result_at, p.medical_record_no, p.name AS patient_name,
                lt.code AS test_code, i.name AS instrument_name
           FROM lab_results res
           JOIN patients p ON p.id = res.patient_id
           JOIN lab_tests lt ON lt.id = res.test_id
           LEFT JOIN instruments i ON i.id = res.instrument_id
          WHERE res.id = ?`,
        [id]
      );
      if (!r) return { ok: false, error: 'Hasil tidak ditemukan' };
      payload = {
        jenis: 'yatim',
        sample_id: null,
        no_rm: r.medical_record_no,
        nama_pasien: r.patient_name,
        parameter: [r.test_code],
        instrumen: r.instrument_name,
        waktu: r.result_at,
        pesan: `Hasil ${r.test_code} pasien ${r.patient_name} (RM ${r.medical_record_no}) sudah masuk tapi belum tertaut ke permintaan mana pun. Buka menu Hasil Belum Cocok -> Hasil Tanpa Permintaan di LIS untuk menautkan.`,
      };
    } else {
      return { ok: false, error: `jenis tidak dikenal: ${jenis}` };
    }

    const headers = { 'Content-Type': 'application/json' };
    if (cfg.auth_type === 'bearer' && cfg.api_key) headers.Authorization = `Bearer ${cfg.api_key}`;
    if (cfg.auth_type === 'api_key' && cfg.api_key) headers['x-api-key'] = cfg.api_key;
    const url = `${cfg.base_url.replace(/\/$/, '')}/notifikasi-tinjau`;
    const resp = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload) });
    const text = await resp.text().catch(() => '');
    return { ok: resp.ok, status: resp.status, response: text.slice(0, 500) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
