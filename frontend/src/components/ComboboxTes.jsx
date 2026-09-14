import { useState, useRef, useEffect, useMemo } from 'react';

/**
 * Dropdown pemeriksaan yang bisa dicari sambil mengetik.
 *
 * <select> polos jadi sulit dipakai begitu daftar tesnya panjang (ratusan
 * baris) -- pengguna harus menggulir manual sambil membaca satu-satu. Ini
 * mengetik kode atau nama, daftar tersaring seketika, bisa navigasi dengan
 * panah atas/bawah + Enter seperti dropdown pencarian pada umumnya.
 */
export default function ComboboxTes({ tests, value, onChange, placeholder = '— pilih pemeriksaan —' }) {
  const [buka, setBuka] = useState(false);
  const [kata, setKata] = useState('');
  const [sorot, setSorot] = useState(0);
  const ref = useRef(null);

  const terpilih = tests.find((t) => String(t.id) === String(value));

  const hasil = useMemo(() => {
    const q = kata.trim().toLowerCase();
    if (!q) return tests;
    return tests.filter(
      (t) => (t.code || '').toLowerCase().includes(q) || (t.name || '').toLowerCase().includes(q)
    );
  }, [tests, kata]);

  useEffect(() => {
    function tutupLuar(e) {
      if (ref.current && !ref.current.contains(e.target)) {
        setBuka(false);
        setKata('');
      }
    }
    document.addEventListener('mousedown', tutupLuar);
    return () => document.removeEventListener('mousedown', tutupLuar);
  }, []);

  useEffect(() => {
    setSorot(0);
  }, [kata, buka]);

  const pilih = (t) => {
    onChange(t ? String(t.id) : '');
    setBuka(false);
    setKata('');
  };

  const onKeyDown = (e) => {
    if (!buka) {
      if (e.key === 'ArrowDown' || e.key === 'Enter') {
        e.preventDefault();
        setBuka(true);
      }
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSorot((s) => Math.min(s + 1, hasil.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSorot((s) => Math.max(s - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (hasil[sorot]) pilih(hasil[sorot]);
    } else if (e.key === 'Escape') {
      setBuka(false);
      setKata('');
    }
  };

  return (
    <div className="combobox-tes" ref={ref}>
      <input
        type="text"
        value={buka ? kata : terpilih ? `${terpilih.code} — ${terpilih.name}` : ''}
        placeholder={placeholder}
        onFocus={() => {
          setBuka(true);
          setKata('');
        }}
        onChange={(e) => {
          setKata(e.target.value);
          setBuka(true);
        }}
        onKeyDown={onKeyDown}
        autoComplete="off"
      />
      {buka && (
        <div className="combobox-daftar">
          {value && (
            <div className="combobox-opsi combobox-kosongkan" onMouseDown={() => pilih(null)}>
              — kosongkan —
            </div>
          )}
          {hasil.length === 0 ? (
            <div className="combobox-kosong">Tidak ada pemeriksaan yang cocok.</div>
          ) : (
            hasil.map((t, i) => (
              <div
                key={t.id}
                className={`combobox-opsi ${i === sorot ? 'sorot' : ''}`}
                onMouseDown={() => pilih(t)}
                onMouseEnter={() => setSorot(i)}
              >
                {t.code} — {t.name}
              </div>
            ))
          )}
        </div>
      )}
      <style>{`
        .combobox-tes { position: relative; flex: 1; min-width: 16rem; }
        .combobox-tes input { width: 100%; }
        .combobox-daftar {
          position: absolute; top: calc(100% + 0.25rem); left: 0; right: 0; z-index: 20;
          background: var(--surface); border: 1px solid var(--border); border-radius: 8px;
          max-height: 16rem; overflow-y: auto; box-shadow: 0 10px 25px rgba(0,0,0,0.4);
        }
        .combobox-opsi { padding: 0.5rem 0.75rem; cursor: pointer; font-size: 0.9rem; }
        .combobox-opsi:hover, .combobox-opsi.sorot { background: var(--surface2); }
        .combobox-kosongkan { color: var(--muted); font-style: italic; border-bottom: 1px solid var(--border); }
        .combobox-kosong { padding: 0.5rem 0.75rem; color: var(--muted); font-style: italic; }
      `}</style>
    </div>
  );
}
