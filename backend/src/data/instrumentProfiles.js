// Katalog profil alat siap-pakai.
//
// Tujuan: memangkas konfigurasi alat baru dari "isi semua dari nol" menjadi
// "pilih model → protokol, port, mode, dan peta kode tes awal terisi". Petugas
// tinggal menyesuaikan.
//
// PRINSIP KESELAMATAN (sama seperti breakpoint antibiogram): peta kode tes yang
// SALAH mengirim hasil ke kolom yang keliru tanpa gejala. Karena itu:
//   - `terverifikasi: true` HANYA untuk alat yang benar-benar pernah kita
//     sambungkan dan buktikan petanya di lapangan.
//   - Selain itu `terverifikasi: false`: preset koneksi tetap berguna, tapi
//     peta bertanda "perlu diverifikasi" — petugas mengonfirmasi terhadap mesin
//     aslinya (dibantu alur "Hasil Belum Cocok" yang mengisi peta dari run
//     pertama).
//
// Katalog ini tumbuh tiap alat baru terpasang dan terbukti — bukan dikarang
// untuk mengejar jumlah.

// Peta 1:1 (kode alat = kode LIS) — bentuk paling umum untuk hematologi.
const satuLawanSatu = (kode) => kode.map((k) => ({ alat: k, lis: k }));

export const PROFIL_ALAT = [
  {
    id: 'sysmex-xn-330',
    pabrikan: 'Sysmex',
    model: 'XN-330 / seri XN-L',
    protokol: 'hl7',
    mode: 'client', // LIS menghubungi alat; alat jadi TCP server
    port: 3600,
    terverifikasi: true,
    catatan:
      'Terverifikasi di lapangan (HL7, LIS jadi client, alat TCP server pada :3600). ' +
      'Ganti Host ke alamat IP alat. 42 parameter termasuk penanda morfologi.',
    peta: satuLawanSatu([
      'WBC', 'RBC', 'HGB', 'HCT', 'MCV', 'MCH', 'MCHC', 'RDW-CV', 'RDW-SD',
      'PLT', 'MPV', 'PDW', 'PCT', 'P-LCR',
      'NEUT#', 'NEUT%', 'LYMPH#', 'LYMPH%', 'MONO#', 'MONO%',
      'EO#', 'EO%', 'BASO#', 'BASO%', 'IG#', 'IG%',
      'DIST_RBC', 'DIST_PLT', 'MICROR', 'MACROR', 'SCAT_WDF', 'SCAT_WDF-CBC',
      'NRBC?', 'Atypical_Lympho?', 'Blasts/Abn_Lympho?', 'Left_Shift?',
      'Fragments?', 'PLT_Clumps?', 'RBC_Agglutination?', 'HGB_Defect?',
      'Iron_Deficiency?', 'Turbidity/HGB_Interference?',
    ]),
  },
  {
    id: 'mindray-bc-3600',
    pabrikan: 'Mindray',
    model: 'BC-3600 (hematologi 3-diff)',
    protokol: 'astm',
    mode: 'client', // alat TCP server pada :3600, LIS jadi client
    port: 3600,
    terverifikasi: false,
    catatan:
      'Preset koneksi (ASTM, LIS jadi client, alat TCP server :3600). Kode tes ' +
      'mengikuti standar Mindray 3-diff — WAJIB diverifikasi terhadap alat.',
    peta: satuLawanSatu([
      'WBC', 'Lym#', 'Lym%', 'Mid#', 'Mid%', 'Gran#', 'Gran%',
      'RBC', 'HGB', 'HCT', 'MCV', 'MCH', 'MCHC', 'RDW-CV', 'RDW-SD',
      'PLT', 'MPV', 'PDW', 'PCT',
    ]),
  },
  {
    id: 'abbott-afinion-2',
    pabrikan: 'Abbott',
    model: 'Afinion 2 (POC: HbA1c / ACR / CRP / Lipid)',
    protokol: 'astm',
    mode: 'server', // alat POC menghubungi LIS
    port: 5000,
    terverifikasi: false,
    catatan:
      'Preset koneksi POC (alat menghubungi LIS). Peta awal hanya HbA1c; ' +
      'tambahkan ACR/CRP/Lipid sesuai cartridge yang dipakai, verifikasi kodenya.',
    peta: [{ alat: 'HbA1c', lis: 'HBA1C', nama: 'HbA1c' }],
  },
  {
    id: 'edan-i15',
    pabrikan: 'EDAN',
    model: 'i15 (Blood Gas & Chemistry Analyzer)',
    protokol: 'hl7',
    mode: 'server', // alat menghubungi LIS (isi Server IP:Port LIS di tab Communication alat)
    port: 5001,
    terverifikasi: false,
    catatan:
      'Preset koneksi (HL7, alat menghubungi LIS). Di alat: Network Setup + tab ' +
      'Communication -> Server IP:Port = alamat LIS. Parameter tergantung kartu; ' +
      'kode di bawah starter, VERIFIKASI terhadap pesan alat.',
    peta: satuLawanSatu([
      'pH', 'PCO2', 'PO2', 'Na', 'K', 'Ca', 'Cl', 'Hct',
      'Glu', 'Lac', 'BUN', 'Crea', 'HCO3', 'TCO2', 'BE', 'sO2',
    ]),
  },
  {
    id: 'boditech-ichroma-2',
    pabrikan: 'Boditech',
    model: 'iChroma II (immunoassay fluoresensi)',
    protokol: 'hl7',
    mode: 'server', // alat menghubungi LIS (Configuration -> IP, lalu setelan LIS/host)
    port: 5002,
    terverifikasi: false,
    catatan:
      'Preset koneksi (alat menghubungi LIS). VERIFIKASI protokol (HL7/ASTM) di ' +
      'alat. iChroma II menjalankan satu tes per kartu (CRP, HbA1c, D-Dimer, PCT, ' +
      'TSH, Ferritin, Vit D, dll) — kode muncul per kartu; petakan dari pesan nyata.',
    peta: [
      { alat: 'CRP', lis: 'CRP', nama: 'CRP' },
      { alat: 'HbA1c', lis: 'HBA1C', nama: 'HbA1c' },
      { alat: 'D-Dimer', lis: 'DDIMER', nama: 'D-Dimer' },
    ],
  },
];

export function cariProfil(id) {
  return PROFIL_ALAT.find((p) => p.id === id) || null;
}
