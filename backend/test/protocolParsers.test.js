/**
 * Uji parser protokol alat.
 *
 * Pesan di bawah ini direkam dari alat produksi (Mindray BC-11 di lokasi pemasangan lain dan
 * BC-3600 di salah satu lokasi pemasangan), bukan karangan dari manual. Manual Mindray
 * berbeda antar generasi — Host Interface Manual v4.0 mendokumentasikan
 * QRY/QCK/DSR, sementara alat sungguhan memakai ORM/ORR — jadi yang dijadikan
 * patokan adalah rekaman aslinya.
 *
 * Jalankan: npm test (di folder backend)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseInstrumentMessage,
  parseHl7,
  buildHl7Ack,
  buildHl7OrderResponse,
  buildAstmNoOrder,
} from '../src/services/protocolParsers.js';

const VT = '\x0b';
const FS = '\x1c';

test('HL7: permintaan worklist BC-11 dikenali sebagai pertanyaan order', () => {
  const raw =
    'MSH|^~\\&|||||20260903080133||ORM^O01|1|P|2.3.1||||||UNICODE\r' +
    'ORC|RF||122||IP\r';
  const out = parseInstrumentMessage('hl7', raw);
  assert.equal(out.isOrderQuery, true, 'ORC-1=RF harus dibaca sebagai permintaan worklist');
  assert.equal(out.orderBarcode, '122');
  assert.equal(out.controlId, '1');
});

test('HL7: balasan worklist memuat identitas pasien di ORC-2 dan OBR-2', () => {
  const balasan = buildHl7OrderResponse('1', '122', { name: 'SITI AMINAH', birth_date: '1988-04-17', gender: 'P' });
  assert.match(balasan, /ORR\^O02/);
  assert.match(balasan, /MSA\|AA\|1/);
  assert.match(balasan, /SITI AMINAH/);
  assert.match(balasan, /ORC\|AF\|122/);
  assert.match(balasan, /OBR\|1\|122/);
});

/**
 * Nomor rekam medis harus mendarat di PID-2.
 *
 * Tabel PID Mindray menyebut PID-2 sebagai "Patient ID", sedangkan PID-3
 * ditandai void and reserved. Sebelumnya barcode ditaruh di PID-3 sehingga
 * kotak Patient ID di layar alat ikut terisi NOMOR PERMINTAAN, bukan nomor
 * rekam medis pasien.
 */
test('HL7: nomor rekam medis di PID-2 dan PID-3, bukan nomor permintaan', () => {
  const balasan = buildHl7OrderResponse('9', 'PK202609030026', {
    name: 'WASTIAH ABDULAH, NY',
    birth_date: '1970-04-02',
    gender: 'P',
    medical_record_no: '101946',
  });
  const kolom = balasan.split('\r').find((b) => b.startsWith('PID')).split('|');
  assert.equal(kolom[2], '101946', 'PID-2 nomor rekam medis');
  // Kotak "Patient ID" di layar BC-11 dibaca dari PID-3; alat itu sendiri
  // mengirim nomor pasiennya di sana dengan penanda ^^^^MR.
  assert.equal(kolom[3], '101946^^^^MR', 'PID-3 nomor rekam medis dengan penanda MR');
  assert.ok(!kolom[3].includes('PK202609030026'), 'nomor permintaan tidak boleh jadi Patient ID');
  // Nomor permintaan tetap dipakai sebagai identitas sampel di ORC dan OBR.
  assert.match(balasan, /ORC\|AF\|PK202609030026/);
});

/**
 * Nama harus di komponen PERTAMA PID-5.
 *
 * Pesan yang dikirim alat sendiri berbentuk `PID|1||^^^^MR||NAILA BUNGA
 * AZ-ZAHRO||...` — namanya di komponen pertama. Sebelumnya LIS mengirim
 * `^NAMA` (komponen kedua), sehingga kotak First Name kosong.
 */
test('HL7: nama pasien di komponen pertama PID-5', () => {
  const balasan = buildHl7OrderResponse('1', '122', {
    name: 'KONIAH TETEN SUPRIYADI, NY', gender: 'P', medical_record_no: '101946',
  });
  const kolom = balasan.split('\r').find((b) => b.startsWith('PID')).split('|');
  assert.equal(kolom[5], 'KONIAH TETEN SUPRIYADI, NY');
  assert.ok(!kolom[5].startsWith('^'), 'nama tidak boleh di komponen kedua');
});

test('HL7: ruangan pasien di PID-11', () => {
  const balasan = buildHl7OrderResponse('1', '122',
    { name: 'X', gender: 'L', medical_record_no: '1', clinician_unit: '[Ranap] Melati' },
    { clinician_unit: '[Ranap] Melati' });
  const kolom = balasan.split('\r').find((b) => b.startsWith('PID')).split('|');
  assert.equal(kolom[11], '[Ranap] Melati');
});

test('HL7: tanggal lahir dikirim lengkap sampai detik', () => {
  const balasan = buildHl7OrderResponse('1', '122', { name: 'X', birth_date: '1970-04-02', gender: 'L' });
  const kolom = balasan.split('\r').find((b) => b.startsWith('PID')).split('|');
  assert.equal(kolom[7], '19700402000000', 'format 8 digit membuat alat gagal menghitung umur');
});

test('HL7: tanpa nomor rekam medis, barcode dipakai sebagai cadangan', () => {
  const balasan = buildHl7OrderResponse('1', '122', { name: 'X', gender: 'L' });
  const kolom = balasan.split('\r').find((b) => b.startsWith('PID')).split('|');
  assert.equal(kolom[2], '122');
});

/**
 * Draw Time dan Delivery Time di layar alat.
 *
 * Peta rekaman OBR Mindray berbeda dari HL7 baku: waktu pengambilan sampel ada
 * di OBR-8 (Observation End Date/Time), bukan OBR-7, dan waktu pengiriman di
 * OBR-14 (Specimen Received Date/Time, "Send D/T").
 */
test('HL7: waktu pengambilan di OBR-8 dan pengiriman di OBR-14', () => {
  const balasan = buildHl7OrderResponse(
    '1', '122',
    { name: 'X', birth_date: '1970-04-02', gender: 'P', medical_record_no: '101946' },
    {
      requested_at: '2026-09-03 07:50:00',
      collected_at: '2026-09-03 08:15:00',
      received_at: '2026-09-03 08:40:00',
      specimen_type: 'Darah vena (EDTA)',
      clinician_name: 'dr. Andi Wijaya, Sp.PD',
    }
  );
  const kolom = balasan.split('\r').find((b) => b.startsWith('OBR')).split('|');
  // BC-11 membaca Draw Time dari OBR-6, jadi waktu pengambilan dikirim di sana
  // sekaligus di OBR-8 yang disebut manual.
  assert.equal(kolom[6], '20260903081500', 'OBR-6 waktu pengambilan');
  assert.equal(kolom[7], '', 'OBR-7 waktu pemeriksaan diisi alat, bukan LIS');
  assert.equal(kolom[8], '20260903081500', 'OBR-8 Draw Time');
  assert.equal(kolom[14], '20260903084000', 'OBR-14 Delivery Time');
  assert.equal(kolom[15], 'Darah vena (EDTA)');
  assert.equal(kolom[16], 'dr. Andi Wijaya, Sp.PD');
});

test('HL7: tanpa data waktu, kolom OBR tetap ada dan kosong', () => {
  const balasan = buildHl7OrderResponse('1', '122', { name: 'X', gender: 'L' }, null);
  const kolom = balasan.split('\r').find((b) => b.startsWith('OBR')).split('|');
  assert.equal(kolom[8], '');
  assert.equal(kolom[14], '');
  assert.ok(kolom.length > 16, 'jumlah kolom tidak boleh menyusut, nomornya akan meleset');
});

test('HL7: pasien tidak ditemukan dibalas AE tanpa identitas karangan', () => {
  const balasan = buildHl7OrderResponse('7', '999', null);
  assert.match(balasan, /MSA\|AE\|7/);
  assert.doesNotMatch(balasan, /PID\|/, 'tanpa pasien, PID tidak boleh dikirim');
  assert.doesNotMatch(balasan, /ORC\|AF/, 'tanpa pasien, order tidak boleh ditegaskan');
});

test('HL7: hasil pasien terurai dengan nama parameter yang terbaca orang', () => {
  const raw =
    VT +
    'MSH|^~\\&|BC-3600||||20260903090000||ORU^R01|9|P|2.3.1\r' +
    'PID|1||101946^^^^MR||KONIAH||19600101|P\r' +
    'OBR|1|123||00001^Automated Count^99MRC\r' +
    'OBX|1|NM|6690-2^WBC^LN||8.4|10*3/uL|||||F\r' +
    'OBX|2|NM|718-7^HGB^LN||12.1|g/dL|||||F\r' +
    FS +
    '\r';
  const out = parseInstrumentMessage('hl7', raw);
  assert.equal(out.isQc, false);
  assert.equal(out.results.length, 2);
  assert.equal(out.results[0].test_code, 'WBC', 'komponen kedua OBX-3 lebih terbaca daripada kode LOINC');
  assert.equal(out.results[0].value, '8.4');
  assert.equal(out.results[1].test_code, 'HGB');
});

test('HL7: data QC dipisahkan ke qcResults, tidak masuk hasil pasien', () => {
  const raw =
    'MSH|^~\\&|BC-3600||||20260903070000||ORU^R01|3|Q|2.3.1\r' +
    'OBR|1|QC1||00003^Quality Control^99MRC\r' +
    'OBX|1|NM|6690-2^WBC^LN||7.8|10*3/uL|||||F\r';
  const out = parseInstrumentMessage('hl7', raw);
  assert.equal(out.isQc, true, 'processing ID selain P berarti bahan kontrol');
  assert.equal(out.results.length, 0, 'QC tidak boleh tercatat sebagai hasil pasien');
  assert.equal(out.qcResults.length, 1, 'tapi datanya harus tetap tersedia untuk modul QC');
  assert.equal(out.qcResults[0].test_code, 'WBC');
});

test('HL7: EDAN i15 — nama parameter di OBX-4, OBX-3 hanya angka tipe', () => {
  // Direkam dari EDAN i15 sungguhan (blood gas analyzer) lewat Network Setup >
  // Protocol HL7v2.4, Server IP = LIS, port 8000. OBX-3 = 0/1/2 (terukur/
  // hitungan/info pasien), nama sebenarnya di OBX-4. Baris tipe 2 (Temperature,
  // FIO2) info pasien, bukan hasil.
  const raw =
    'MSH|^~\\&|EDAN|i15^M22311590014|LIS||20260910102610||ORU^R01||P|2.4||||0||UNICODE UTF-8||||\r' +
    'PID|||wagiman|||||U\r' +
    'OBR|||20260821002|EDAN^i15|||20260821213728||||||||Arterial|admin\r' +
    'OBX|0|ST|0|Na+|141|mmol/L|138^146||||||Pass|20260821213728||admin\r' +
    'OBX|1|ST|0|K+|5.0|mmol/L|3.5^4.9|↑|||||Pass|20260821213728||admin\r' +
    'OBX|5|ST|1|tHb(est)|15.5|g/dL|2.9^27.7|||||||20260821213728||admin\r' +
    'OBX|7|ST|2|Temperature|37.0|℃||||||||20260821213728||admin\r' +
    'OBX|8|ST|2|FIO2|21|%||||||||20260821213728||admin\r';
  const out = parseHl7(raw);
  assert.equal(out.isQc, false, 'MSH-16=0 berarti hasil pasien');
  assert.equal(out.sampleId, '20260821002', 'sampleId dari OBR-3, bukan nama di PID-3');
  const kode = out.results.map((r) => r.test_code);
  assert.deepEqual(kode, ['Na+', 'K+', 'tHb(est)'], 'terukur + hitungan ikut; info pasien (tipe 2) dilewati');
  assert.equal(out.results[0].value, '141');
  assert.equal(out.results[0].unit, 'mmol/L');
});

test('HL7: EDAN i15 — MSH-16=1 menandai kontrol, bukan hasil pasien', () => {
  const raw =
    'MSH|^~\\&|EDAN|i15^M22311590014|LIS||20260910102610||ORU^R01||P|2.4||||1||UNICODE UTF-8||||\r' +
    'OBR||1|Control|EDAN^i15|||20260910102610||||||BGQc||||||CommonQC\r' +
    'OBX|0|ST|0|pH|7.400||7.350^7.450|N|||||In Control|20260910102610||admin\r';
  const out = parseHl7(raw);
  assert.equal(out.isQc, true);
  assert.equal(out.results.length, 0);
  assert.equal(out.qcResults.length, 1);
  assert.equal(out.qcResults[0].test_code, 'pH');
});

test('HL7: ACK yang dibentuk memakai MLLP dan mengembalikan control ID', () => {
  const ack = buildHl7Ack('42', 'P', 'AA');
  assert.ok(ack.startsWith(VT), 'MLLP harus diawali 0x0B');
  assert.ok(ack.includes(FS), 'MLLP harus ditutup 0x1C');
  assert.match(ack, /MSA\|AA\|42/);
});

test('ASTM: balasan "tidak ada order" memakai terminator I', () => {
  const msg = buildAstmNoOrder();
  assert.match(msg, /^H\|/m);
  assert.match(msg, /L\|1\|I/, 'terminator I = tidak ada informasi untuk query terakhir');
});

test('ASTM: hasil terurai beserta nomor sampel', () => {
  const raw =
    'H|\\^&|||Mindray^BC-3600|||||||P|E1394-97|20260903\r' +
    'P|1|||101946||KONIAH||19600101|F\r' +
    'O|1|123||^^^WBC|R||||||N||||1\r' +
    'R|1|^^^WBC|8.4|10*3/uL||N||F\r' +
    'R|2|^^^HGB|12.1|g/dL||N||F\r' +
    'L|1|N\r';
  const out = parseInstrumentMessage('astm', raw);
  assert.equal(out.sampleId, '123');
  assert.equal(out.results.length, 2);
  assert.equal(out.results[0].test_code, 'WBC');
  assert.equal(out.results[0].value, '8.4');
});

test('pesan kosong tidak menjatuhkan parser', () => {
  const out = parseInstrumentMessage('hl7', '   ');
  assert.deepEqual(out.results, []);
});

test('OBX bertipe teks diabaikan, hanya angka yang jadi hasil', () => {
  const raw =
    'MSH|^~\\&|BC-3600||||20260903090000||ORU^R01|9|P|2.3.1\r' +
    'PID|1||101946^^^^MR||KONIAH||19600101|P\r' +
    'OBX|1|NM|6690-2^WBC^LN||8.4|10*3/uL|||||F\r' +
    'OBX|2|IS|08001^Take Mode^99MRC||Whole Blood|||||F\r' +
    'OBX|3|TX|08002^Remark^99MRC||sampel lipemik|||||F\r';
  const out = parseHl7(raw);
  const kode = out.results.map((r) => r.test_code);
  assert.deepEqual(kode, ['WBC'], 'IS/TX bukan hasil terukur');
});

test('HL7: OBX bertipe TX tetap dibaca kalau isinya angka (iChroma II)', () => {
  // Direkam dari alat iChroma II (Boditech) sungguhan lewat PC Connection >
  // NETWORK > LIS Server Setting, protokol HL7. Beda dengan BC-3600, alat ini
  // melabeli hasil numeriknya sendiri sebagai TX, bukan NM. Baris kedua dan
  // ketiga adalah nilai yang sama dalam satuan lain (OBX-3 kosong) dan sengaja
  // tidak ikut jadi hasil terpisah.
  const raw =
    'MSH|^~\\&|1|ichroma2|UH162||20260323144311||OUL^R24^OUL_R24|1|T|2.6\r' +
    'PID||seri||||||-\r' +
    'OBR||HbA1c|0|0|||20260323144311|||-\r' +
    'ORC|OK|||||||||||||||||UH162|1\r' +
    'SPM|1|AAVAS01EX|||||||||||||||||20260920\r' +
    'OBX|1|TX|HbA1c||9.60|%||0|||R\r' +
    'OBX|2|TX|||81.38|mmol/mol||0|||R\r' +
    'OBX|3|TX|||228.70|mg/dL||0|||R\r';
  const out = parseHl7(raw);
  assert.equal(out.isQc, false, 'hasil pasien sungguhan, bukan kontrol');
  assert.equal(out.results.length, 1, 'hanya OBX dengan OBX-3 terisi yang dihitung');
  assert.equal(out.results[0].test_code, 'HbA1c');
  assert.equal(out.results[0].value, '9.60');
  assert.equal(out.results[0].unit, '%');
});

test('HL7: OUL^R24 (iChroma II) tidak dianggap QC hanya karena MSH-11 bukan P', () => {
  // Insiden nyata: iChroma II SELALU mengirim MSH-11='T' untuk OUL^R24, baik
  // untuk hasil pasien maupun kontrol — aturan Mindray (MSH-11 != 'P' berarti
  // QC) salah kalau dipakai di sini dan sempat membuat hasil pasien asli
  // ("hamzah", "sulastri", dst di PID-2) tertelan ke qc_results tanpa pernah
  // dicocokkan ke pasien.
  const raw =
    'MSH|^~\\&|1|ichroma2|UH162||20260324071104||OUL^R24^OUL_R24|1|T|2.6\r' +
    'PID||hamzah||||||-\r' +
    'OBR||HbA1c|0|0|||20260324071104|||-\r' +
    'OBX|1|TX|HbA1c||5.10|%||0|||R\r';
  const out = parseHl7(raw);
  assert.equal(out.isQc, false);
  assert.equal(out.results.length, 1);
  assert.equal(out.qcResults.length, 0);
});

test('HL7: OBR-2 pada OUL^R24 (nama tes) tidak menimpa sampleId dari PID-2', () => {
  // OBR-2 di iChroma II berisi nama tes ("HbA1c"), bukan nomor sampel seperti
  // pada Mindray. Kalau sampleId ikut ditimpa OBR-2, ID pasien yang diketik
  // operator di PID-2 hilang diganti nama tes, dan pencocokan ke pasien pasti
  // gagal.
  const raw =
    'MSH|^~\\&|1|ichroma2|UH162||20260324071104||OUL^R24^OUL_R24|1|T|2.6\r' +
    'PID||hamzah||||||-\r' +
    'OBR||HbA1c|0|0|||20260324071104|||-\r' +
    'OBX|1|TX|HbA1c||5.10|%||0|||R\r';
  const out = parseHl7(raw);
  assert.equal(out.sampleId, 'hamzah');
});

test('ASTM: nomor spesimen dan nomor pasien dikembalikan terpisah', () => {
  const raw =
    'H|\\^&|||Mindray^BC-3600|||||||P|E1394-97|20260903\r' +
    'P|1|||101946||KONIAH||19600101|F\r' +
    'O|1|123||^^^WBC|R||||||N||||1\r' +
    'R|1|^^^WBC|8.4|10*3/uL||N||F\r' +
    'L|1|N\r';
  const out = parseInstrumentMessage('astm', raw);
  assert.equal(out.specimenId, '123', 'O-3 adalah nomor spesimen');
  assert.equal(out.patientRefId, '101946', 'P-4 adalah nomor pasien');
  assert.equal(out.sampleId, '123', 'yang dipakai untuk mencocokkan order adalah spesimen');
});

test('ASTM: tanpa rekaman O, nomor pasien dipakai sebagai cadangan', () => {
  const raw =
    'H|\\^&|||Sysmex|||||||P|E1394-97\r' +
    'P|1|||101946||KONIAH||19600101|F\r' +
    'R|1|^^^HGB|12.1|g/dL||N||F\r' +
    'L|1|N\r';
  const out = parseInstrumentMessage('astm', raw);
  assert.equal(out.specimenId, null);
  assert.equal(out.sampleId, '101946');
});

/**
 * Driver MySQL mengembalikan kolom DATE sebagai objek Date. Memotongnya seperti
 * teks menghasilkan "Wed Feb 04", yang tidak terbaca alat — dan tidak terlihat
 * di uji yang hanya memakai teks.
 */
test('HL7: tanggal lahir berupa objek Date tetap terformat benar', () => {
  const balasan = buildHl7OrderResponse('1', '122', {
    name: 'X', gender: 'P', medical_record_no: '103531',
    birth_date: new Date(1970, 3, 2), // 2 April 1970 waktu setempat
  });
  const kolom = balasan.split('\r').find((b) => b.startsWith('PID')).split('|');
  assert.equal(kolom[7], '19700402000000');
});

test('HL7: tanggal lahir kosong tidak menghasilkan sampah', () => {
  const balasan = buildHl7OrderResponse('1', '122', { name: 'X', gender: 'L', birth_date: null });
  const kolom = balasan.split('\r').find((b) => b.startsWith('PID')).split('|');
  assert.equal(kolom[7], '');
});

test('HL7: tanpa waktu pengambilan, OBR-6 jatuh ke waktu permintaan', () => {
  const balasan = buildHl7OrderResponse('1', '122',
    { name: 'X', gender: 'L', medical_record_no: '1' },
    { requested_at: '2026-09-03 09:28:22', collected_at: null });
  const kolom = balasan.split('\r').find((b) => b.startsWith('OBR')).split('|');
  assert.equal(kolom[6], '20260903092822');
  assert.equal(kolom[8], '', 'OBR-8 tetap kosong: waktu pengambilan memang belum ada');
});
