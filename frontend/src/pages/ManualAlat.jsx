import { Link } from 'react-router-dom';

// Indeks manual alat. Dulu tiap alat satu baris di sidebar; makin banyak alat,
// makin panjang menunya. Sekarang dikumpulkan di sini — sidebar cukup satu
// "Manual Alat", dan daftar alat bertambah tanpa mengubah menu.
const ALAT = [
  { doc: 'bc-3600', judul: 'Mindray BC-3600', icon: '🩸', ket: 'Hematologi 3-diff (ASTM, LIS jadi client :3600)' },
  { doc: 'bc-11', judul: 'Mindray BC-11', icon: '🔬', ket: 'Hematologi (ASTM, LIS jadi client :5100)' },
  { doc: 'afinion-2', judul: 'Abbott Afinion 2', icon: '🩺', ket: 'POC kartrid: HbA1c / ACR / CRP / Lipid (alat → LIS)' },
  { doc: 'edan-i15', judul: 'EDAN i15', icon: '🫁', ket: 'Blood Gas & Chemistry (HL7, alat → LIS)' },
];

export default function ManualAlat() {
  return (
    <div>
      <div className="page-head"><h2>🔬 Manual Alat</h2></div>
      <p style={{ color: '#667', maxWidth: '46rem' }}>
        Panduan integrasi tiap alat laboratorium ke GeuLIS: protokol, arah koneksi,
        setelan di panel alat, dan pemecahan masalah. Klik untuk membuka.
      </p>
      <div style={{
        display: 'grid', gap: '1rem', marginTop: '1rem',
        gridTemplateColumns: 'repeat(auto-fill, minmax(15rem, 1fr))',
      }}>
        {ALAT.map((a) => (
          <Link
            key={a.doc}
            to={`/manual/${a.doc}`}
            style={{
              display: 'block', textDecoration: 'none', color: 'inherit',
              border: '1px solid #e3e6ea', borderRadius: 10, padding: '1rem 1.1rem',
              background: '#fff', transition: 'box-shadow .15s, border-color .15s',
            }}
            onMouseEnter={(e) => { e.currentTarget.style.boxShadow = '0 4px 14px rgba(0,0,0,.08)'; e.currentTarget.style.borderColor = '#c7ccd3'; }}
            onMouseLeave={(e) => { e.currentTarget.style.boxShadow = 'none'; e.currentTarget.style.borderColor = '#e3e6ea'; }}
          >
            <div style={{ fontSize: '1.6rem', lineHeight: 1 }}>{a.icon}</div>
            <div style={{ fontWeight: 600, marginTop: '.5rem' }}>{a.judul}</div>
            <div style={{ color: '#778', fontSize: '.85rem', marginTop: '.25rem' }}>{a.ket}</div>
          </Link>
        ))}
      </div>
    </div>
  );
}
