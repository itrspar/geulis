/**
 * Hitung ulang flag (dan rentang yang dipakai) hasil lab yang sudah tersimpan.
 *
 * Flag dihitung sekali saat hasil masuk. Kalau nilai rujukan atau nilai kritis
 * baru diisi belakangan, hasil lama tetap memakai flag lamanya — di RS Santa
 * Familia itu berarti HCT 22% dan PLT 53 tersimpan sebagai "normal".
 *
 * Jalankan dari folder backend:
 *   node scripts/hitung-ulang-flag.mjs            -> hanya melaporkan
 *   node scripts/hitung-ulang-flag.mjs --terapkan -> menyimpan perubahan
 */
import 'dotenv/config';
import mysql from 'mysql2/promise';
import { nilaiHasil } from '../src/services/flags.js';
import { umurHari } from '../src/services/rujukanUmur.js';

const terapkan = process.argv.includes('--terapkan');

const db = await mysql.createConnection({
  host: process.env.DB_HOST || '127.0.0.1',
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  dateStrings: true,
});

const [baris] = await db.query(`
  SELECT r.id AS result_id, r.result_value, r.flag AS flag_lama, r.result_at,
         p.gender, p.birth_date, p.name AS pasien,
         t.id AS test_id, t.code, t.reference_min, t.reference_max,
         t.reference_min_l, t.reference_max_l, t.reference_min_p, t.reference_max_p,
         t.critical_min, t.critical_max
    FROM lab_results r
    JOIN lab_tests t ON t.id = r.test_id
    LEFT JOIN patients p ON p.id = r.patient_id
   ORDER BY r.id`);

const berubah = [];
for (const b of baris) {
  // Hanya angka yang bisa dinilai; hasil teks dibiarkan apa adanya.
  if (isNaN(parseFloat(b.result_value))) continue;

  const test = {
    id: b.test_id,
    code: b.code,
    reference_min: b.reference_min,
    reference_max: b.reference_max,
    reference_min_l: b.reference_min_l,
    reference_max_l: b.reference_max_l,
    reference_min_p: b.reference_min_p,
    reference_max_p: b.reference_max_p,
    critical_min: b.critical_min,
    critical_max: b.critical_max,
  };
  const konteks = {
    gender: b.gender || null,
    // Umur PADA SAAT pemeriksaan, bukan sekarang -- supaya rentang anak/dewasa
    // tetap tepat untuk hasil lama walau pasiennya sudah bertambah umur.
    umurHari: umurHari(b.birth_date, new Date(String(b.result_at).replace(' ', 'T'))),
    kondisi: null,
  };

  const { flag: baru, min, max, label } = await nilaiHasil(b.result_value, test, konteks);
  if (baru !== b.flag_lama) berubah.push({ ...b, flag_baru: baru, ref_min: min, ref_max: max, ref_label: label });
}

console.log(`${baris.length} hasil diperiksa, ${berubah.length} berubah flag-nya`);
const penting = berubah.filter((b) => b.flag_baru === 'critical');
for (const b of berubah.slice(0, 40)) {
  console.log(`  #${b.result_id} ${b.pasien || '-'} ${b.code}=${b.result_value}  ${b.flag_lama} -> ${b.flag_baru}`);
}
if (berubah.length > 40) console.log(`  ... dan ${berubah.length - 40} lagi`);
if (penting.length) console.log(`\n⚠ ${penting.length} hasil menjadi KRITIS dan perlu ditindaklanjuti petugas`);

if (terapkan && berubah.length) {
  for (const b of berubah) {
    await db.query(
      'UPDATE lab_results SET flag = ?, ref_min_dipakai = ?, ref_max_dipakai = ?, rujukan_label = ? WHERE id = ?',
      [b.flag_baru, b.ref_min, b.ref_max, b.ref_label, b.result_id]
    );
  }
  console.log(`\n${berubah.length} baris disimpan.`);
} else if (berubah.length) {
  console.log('\nBelum disimpan. Tambahkan --terapkan untuk menyimpan.');
}

await db.end();
// nilaiHasil() memakai pool terpisah dari src/config/db.js (lewat rujukanUmur.js)
// yang tidak pernah ditutup -- tanpa exit eksplisit proses menggantung tanpa
// pesan apa pun walau pekerjaannya sudah selesai.
process.exit(0);
