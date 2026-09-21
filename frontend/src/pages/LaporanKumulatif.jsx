import { useState } from 'react';
import { api } from '../api';

// Laporan kumulatif: satu pasien, satu pemeriksaan ditampilkan berdampingan
// melintasi waktu. Dokter membacanya untuk memantau tren terapi (mis. kreatinin
// harian pasien rawat inap), bukan sekadar satu hasil terakhir.

const hariIni = () => new Date().toISOString().slice(0, 10);
const geser = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);

const fFlag = (f) => {
  const v = String(f || '').toLowerCase();
  if (v === 'critical') return { color: '#fff', background: '#b93a25', fontWeight: 700 };
  if (v === 'high' || v === 'h') return { color: '#b93a25', fontWeight: 600 };
  if (v === 'low' || v === 'l') return { color: '#1d4ed8', fontWeight: 600 };
  if (v === 'abnormal') return { color: '#8a5a10', fontWeight: 600 };
  return undefined;
};
const tanda = (f) => {
  const v = String(f || '').toLowerCase();
  if (v === 'high' || v === 'h') return ' ↑';
  if (v === 'low' || v === 'l') return ' ↓';
  if (v === 'critical') return ' ‼';
  return '';
};
const fTgl = (iso) => {
  const d = new Date(iso);
  return { tgl: d.toLocaleDateString('id-ID', { day: '2-digit', month: 'short' }), jam: d.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' }) };
};

export default function LaporanKumulatif() {
  const [q, setQ] = useState('');
  const [hasilCari, setHasilCari] = useState([]);
  const [pasien, setPasien] = useState(null);
  const [dari, setDari] = useState(geser(-30));
  const [sampai, setSampai] = useState(hariIni());
  const [data, setData] = useState(null);
  const [galat, setGalat] = useState(null);
  const [memuat, setMemuat] = useState(false);

  const cari = async () => {
    setGalat(null);
    try { setHasilCari(await api.patients.list(q)); }
    catch (e) { setGalat(e.message); }
  };

  const muat = async (p) => {
    setGalat(null); setMemuat(true);
    try {
      const d = await api.laporanKumulatif(p.id, dari, sampai);
      setData(d);
    } catch (e) { setGalat(e.message); setData(null); }
    finally { setMemuat(false); }
  };

  const pilih = (p) => { setPasien(p); setHasilCari([]); setQ(`${p.name} (${p.medical_record_no})`); muat(p); };

  const unduh = () => {
    if (!data?.baris?.length) return;
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const kepala = ['Pemeriksaan', 'Satuan', 'Rujukan', ...data.kolom.map((s) => new Date(s).toLocaleString('id-ID'))];
    const isi = [
      kepala.map(esc).join(','),
      ...data.baris.map((b) => [b.nama, b.unit, b.rujukan, ...data.kolom.map((s) => b.sel[s]?.nilai ?? '')].map(esc).join(',')),
    ].join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([isi], { type: 'text/csv' }));
    a.download = `kumulatif_${data.pasien.no_rm || data.pasien.id}_${dari}_${sampai}.csv`; a.click();
  };

  return (
    <div>
      <div className="page-head"><h2>Laporan Kumulatif Pasien</h2></div>
      <p style={{ color: '#667', maxWidth: '48rem' }}>
        Tren hasil satu pasien: tiap pemeriksaan ditampilkan berdampingan melintasi waktu, agar perubahan dari hari ke hari terbaca sekali pandang.
      </p>

      <div style={{ display: 'flex', gap: '.5rem', alignItems: 'flex-end', flexWrap: 'wrap', margin: '1rem 0' }}>
        <div style={{ flex: '1 1 22rem' }}>
          <label style={{ display: 'block', fontSize: '.8rem' }}>Pasien (nama / No. RM)</label>
          <input value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && cari()}
            placeholder="Ketik nama atau No. RM lalu Enter" style={{ width: '100%' }} />
        </div>
        <button onClick={cari}>Cari Pasien</button>
        <div><label style={{ display: 'block', fontSize: '.8rem' }}>Dari</label><input type="date" value={dari} onChange={(e) => setDari(e.target.value)} /></div>
        <div><label style={{ display: 'block', fontSize: '.8rem' }}>Sampai</label><input type="date" value={sampai} onChange={(e) => setSampai(e.target.value)} /></div>
        {pasien && <button onClick={() => muat(pasien)} style={{ background: '#889' }}>Terapkan Rentang</button>}
        {data?.baris?.length > 0 && <button onClick={unduh} style={{ background: '#889' }}>Unduh CSV</button>}
      </div>

      {galat && <p style={{ color: '#b93a25' }}>{galat}</p>}

      {hasilCari.length > 0 && (
        <div style={{ border: '1px solid #e3e6ea', borderRadius: 8, maxWidth: '40rem', marginBottom: '1rem' }}>
          {hasilCari.map((p) => (
            <div key={p.id} onClick={() => pilih(p)}
              style={{ padding: '.55rem .8rem', cursor: 'pointer', borderBottom: '1px solid #f0f2f4' }}>
              <b>{p.name}</b> <span style={{ color: '#889' }}>· RM {p.medical_record_no}{p.gender ? ` · ${p.gender}` : ''}</span>
            </div>
          ))}
        </div>
      )}

      {memuat && <p style={{ color: '#889' }}>Memuat…</p>}

      {data && !memuat && (
        <>
          <div style={{ marginBottom: '.5rem' }}>
            <b>{data.pasien.nama}</b> <span style={{ color: '#889' }}>· RM {data.pasien.no_rm} · {data.dari} s/d {data.sampai}</span>
          </div>
          {data.baris.length === 0 ? (
            <p style={{ color: '#889' }}>Tidak ada hasil pada rentang ini.</p>
          ) : (
            <div style={{ overflowX: 'auto', border: '1px solid #e3e6ea', borderRadius: 8 }}>
              <table className="tabel" style={{ borderCollapse: 'collapse', minWidth: '100%' }}>
                <thead>
                  <tr>
                    <th style={{ position: 'sticky', left: 0, background: '#f7f8fa', textAlign: 'left', minWidth: '11rem', zIndex: 2 }}>Pemeriksaan</th>
                    <th style={{ textAlign: 'left', whiteSpace: 'nowrap' }}>Rujukan</th>
                    {data.kolom.map((s) => {
                      const { tgl, jam } = fTgl(s);
                      return <th key={s} style={{ textAlign: 'center', whiteSpace: 'nowrap' }}><div>{tgl}</div><small style={{ color: '#889', fontWeight: 400 }}>{jam}</small></th>;
                    })}
                  </tr>
                </thead>
                <tbody>
                  {data.baris.map((b) => (
                    <tr key={b.test_id}>
                      <td style={{ position: 'sticky', left: 0, background: '#fff', fontWeight: 600, zIndex: 1 }}>
                        {b.nama}{b.unit ? <span style={{ color: '#889', fontWeight: 400 }}> ({b.unit})</span> : null}
                      </td>
                      <td style={{ color: '#889', whiteSpace: 'nowrap' }}>{b.rujukan || '—'}</td>
                      {data.kolom.map((s) => {
                        const c = b.sel[s];
                        return (
                          <td key={s} style={{ textAlign: 'center', whiteSpace: 'nowrap', ...(c ? fFlag(c.flag) : { color: '#ccc' }) }}>
                            {c ? `${c.nilai}${tanda(c.flag)}` : '·'}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}
