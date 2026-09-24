import { NavLink, Outlet, useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useState, useEffect } from 'react';
import Swal from 'sweetalert2';
import { usePemindai } from '../hooks/usePemindai';
import { api } from '../api';

// Versi dan tautan kode sumber yang ditampilkan di sidebar.
//
// BILA ANDA MEM-FORK GEULIS: ganti SOURCE_URL ke repositori Anda sendiri.
// AGPL-3.0 Pasal 13 mewajibkan pengguna versi Anda bisa memperoleh kode versi
// Anda -- bukan kode proyek asal. Membiarkannya menunjuk ke sini berarti
// menawarkan kode yang bukan kode yang sedang mereka pakai.
const APP_VERSION = __APP_VERSION__;
// Fork RS Pariaman. AGPL-3.0 Pasal 13: tautan ini WAJIB menunjuk ke kode yang
// benar-benar dijalankan di sini (cabang deployment rumah sakit), bukan hulu.
const SOURCE_URL = 'https://github.com/itrspar/geulis';

// Menu dikelompokkan per kategori (bisa dilipat) supaya sidebar tidak menjadi
// satu daftar panjang yang menjalar ke bawah. Tiap item tetap membawa `key`
// hak akses; kategori tanpa item yang boileh diakses disembunyikan.
const KATEGORI = [
  { judul: 'Utama', items: [
    { key: 'dashboard', path: '/', label: 'Dashboard', icon: '📊' },
    { key: 'patients', path: '/patients', label: 'Data Pasien', icon: '👤' },
    { key: 'requests', path: '/requests', label: 'Permintaan Lab', icon: '🧪' },
    { key: 'results', path: '/results', label: 'Hasil Lab', icon: '📋' },
    { key: 'results', path: '/unmatched', label: 'Hasil Belum Cocok', icon: '📥' },
  ] },
  { judul: 'Pra-analitik & Mutu', items: [
    { key: 'results', path: '/verif-spesimen', label: 'Verifikasi Spesimen', icon: '🧫' },
    { key: 'results', path: '/duplo', label: 'Pemeriksaan Duplo', icon: '👯' },
    { key: 'instruments', path: '/qc', label: 'Kontrol Mutu', icon: '🎯' },
    { key: 'instruments', path: '/pme', label: 'Mutu Eksternal', icon: '🏅' },
  ] },
  { judul: 'Layanan Khusus', items: [
    { key: 'instruments', path: '/bank-darah', label: 'Bank Darah (BDRS)', icon: '🩸' },
    { key: 'instruments', path: '/mikrobiologi', label: 'Mikrobiologi Kultur', icon: '🦠' },
    { key: 'results', path: '/naratif', label: 'Hasil Naratif', icon: '📝' },
  ] },
  { judul: 'Laporan', items: [
    { key: 'results', path: '/laporan-kumulatif', label: 'Laporan Kumulatif', icon: '📉' },
    { key: 'instruments', path: '/laporan-rekap', label: 'Laporan Rekap', icon: '📈' },
  ] },
  { judul: 'Master & Alat', items: [
    { key: 'instruments', path: '/instruments', label: 'Alat Laboratorium', icon: '⚙️' },
    { key: 'instruments', path: '/nilai-rujukan', label: 'Nilai Rujukan', icon: '📐' },
    // Bridging Khanza: hilang di restrukturisasi upstream (tidak dipakai di
    // sana), tapi aktif dipakai di pemasangan ini -- dipertahankan.
    { key: 'mapping', path: '/mapping', label: 'Mapping SIMRS', icon: '🔗' },
    { key: 'users', path: '/users', label: 'User & Hak Akses', icon: '🔐' },
  ] },
];

// Manual dibuka di dalam aplikasi (halaman /manual/...), bukan tab baru,
// supaya sidebar tetap terlihat dan petugas tidak kehilangan konteks.
// Manual alat dikelompokkan di satu halaman /manual-alat, bukan satu baris
// sidebar per alat — daftarnya bertambah tiap alat baru dan mengubur menu.
const MANUAL = [
  { path: '/manual/alur-kerja', label: 'Alur Kerja Petugas', icon: '🧭' },
  { path: '/manual/penggunaan', label: 'Manual Penggunaan', icon: '📖' },
  { path: '/manual-alat', label: 'Manual Alat', icon: '🔬' },
];

export default function Layout() {
  const { user, logout, hasMenu } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  // Versi server yang benar-benar berjalan (otoritatif). APP_VERSION di atas
  // hanyalah versi build antarmuka; keduanya bisa berbeda bila hanya salah satu
  // yang dideploy, dan justru itulah yang perlu terlihat saat menelusuri masalah.
  const [versiServer, setVersiServer] = useState(null);
  useEffect(() => {
    fetch('/api/version')
      .then((r) => (r.ok ? r.json() : null))
      .then(setVersiServer)
      .catch(() => {});
  }, []);

  // Susun kategori sesuai hak akses; tambah Administrasi (admin) & Bantuan.
  const kategori = KATEGORI
    .map((k) => ({ judul: k.judul, items: k.items.filter((it) => hasMenu(it.key)) }))
    .filter((k) => k.items.length > 0);
  if (user?.role?.code === 'admin') {
    kategori.push({ judul: 'Administrasi', items: [
      { path: '/audit', label: 'Log Audit', icon: '📜' },
      { path: '/settings', label: 'Pengaturan Aplikasi', icon: '⚙️' },
    ] });
  }
  kategori.push({ judul: 'Bantuan', items: MANUAL });

  // Kategori yang memuat halaman aktif selalu terbuka; selebihnya mengikuti
  // pilihan pengguna (disimpan). Bawaan: hanya "Utama" + kategori aktif terbuka.
  const [lipat, setLipat] = useState(() => {
    try { return JSON.parse(localStorage.getItem('sidebar_lipat') || '{}'); } catch { return {}; }
  });
  const kategoriAktif = kategori.find((k) => k.items.some((it) => it.path === location.pathname))?.judul;
  const sedangTerbuka = (judul) => {
    // Pilihan pengguna yang EKSPLISIT selalu menang -- termasuk saat sedang
    // berada di halaman kategori itu sendiri. Sebelumnya kategori aktif
    // dipaksa selalu terbuka di urutan pertama, jadi tombol lipat pada
    // kategori halaman yang sedang dibuka terlihat tidak berfungsi sama
    // sekali (klik tersimpan ke localStorage, tapi kembali dibuka paksa di
    // render berikutnya) -- termasuk setelah refresh, karena halaman aktifnya
    // tetap sama.
    if (lipat[judul] !== undefined) return !lipat[judul]; // true = terlipat
    if (judul === kategoriAktif) return true;              // belum pernah disentuh -> buka kategori aktif
    return judul === 'Utama';                              // bawaan: hanya Utama terbuka
  };
  const toggleLipat = (judul) => {
    const target = !sedangTerbuka(judul); // status terbuka yang diinginkan
    setLipat((s) => {
      const n = { ...s, [judul]: !target }; // simpan true = terlipat
      try { localStorage.setItem('sidebar_lipat', JSON.stringify(n)); } catch { /* abaikan */ }
      return n;
    });
  };

  // Pindaian barcode berlaku di seluruh aplikasi, bukan hanya di satu halaman.
  // Petugas memindai sambil memegang tabung; menuntutnya membuka halaman yang
  // benar lebih dulu menghapus keuntungan memindai sama sekali.
  usePemindai(async (kode) => {
    try {
      const h = await api.pindai(kode);
      if (h.jenis === 'order') {
        navigate(`/results?request_id=${h.id}&patient_id=${h.patient_id}`);
        return;
      }
      // Pasien dengan lebih dari satu order terbuka: JANGAN ditebak. Memilihkan
      // salah satu berarti menebak tabung mana yang dipegang petugas, dan
      // tebakan yang salah memasukkan hasil ke order yang keliru tanpa gejala.
      const pilih = await Swal.fire({
        title: h.pasien.name,
        text: `Ada ${h.orders.length} order terbuka. Pilih yang sesuai tabung di tangan Anda.`,
        input: 'select',
        inputOptions: Object.fromEntries(
          h.orders.map((o) => [o.id, `${o.request_no} · ${new Date(o.requested_at).toLocaleString('id-ID')}`])
        ),
        showCancelButton: true,
        confirmButtonText: 'Buka',
        cancelButtonText: 'Batal',
      });
      if (pilih.isConfirmed && pilih.value) {
        navigate(`/results?request_id=${pilih.value}&patient_id=${h.pasien.id}`);
      }
    } catch (err) {
      Swal.fire({ icon: 'warning', title: 'Barcode tidak dikenal', text: err.message });
    }
  });
  const [sidebarOpen, setSidebarOpen] = useState(() => {
    if (window.innerWidth < 768) return false;
    const saved = localStorage.getItem('sidebar_open');
    return saved !== null ? saved === 'true' : true;
  });

  useEffect(() => {
    const handleResize = () => {
      if (window.innerWidth < 768) {
        setSidebarOpen(false);
      }
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  const toggleSidebar = (val) => {
    setSidebarOpen(val);
    localStorage.setItem('sidebar_open', val);
  };

  const handleLogout = async () => {
    const res = await Swal.fire({
      title: 'Keluar Aplikasi?',
      text: "Anda harus login kembali untuk mengakses sistem.",
      icon: 'question',
      showCancelButton: true,
      confirmButtonColor: '#4f46e5',
      cancelButtonColor: '#ef4444',
      confirmButtonText: 'Ya, Keluar',
      cancelButtonText: 'Batal'
    });
    
    if (res.isConfirmed) {
      logout();
      navigate('/login');
    }
  };

  return (
    <div className="app-shell">
      {sidebarOpen && (
        <aside className="sidebar">
          <div className="brand" style={{ display: 'flex', justifyContent: 'space-between', width: '100%' }}>
            <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
              <span className="brand-icon">🧬</span>
              <div>
                <strong>GeuLIS</strong>
                <small>Laboratory IS</small>
              </div>
            </div>
            <button 
              className="btn-sm" 
              style={{ background: 'transparent', color: 'var(--muted)', padding: '0.25rem', border: 'none' }}
              onClick={() => toggleSidebar(false)}
              title="Sembunyikan Sidebar"
            >
              ◀
            </button>
          </div>
        <div className="user-chip">
          <strong>{user?.fullName}</strong>
          <small>{user?.role?.name}</small>
        </div>
        <nav>
          {kategori.map((k) => (
            <div key={k.judul} className="nav-kat">
              <button type="button" className="nav-kat-head" onClick={() => toggleLipat(k.judul)}>
                <span>{k.judul}</span>
                <span className="nav-kat-chev">{sedangTerbuka(k.judul) ? '▾' : '▸'}</span>
              </button>
              {sedangTerbuka(k.judul) && k.items.map((m) => (
                <NavLink key={m.path} to={m.path} end={m.path === '/'} className={({ isActive }) => (isActive ? 'active' : '')}>
                  <span>{m.icon}</span> {m.label}
                </NavLink>
              ))}
            </div>
          ))}
          <button
            type="button" 
            className="secondary" 
            onClick={handleLogout}
            style={{ marginTop: '0.5rem', justifyContent: 'flex-start' }}
          >
            🚪 Keluar
          </button>

          {/*
            Keterangan lisensi dan tautan kode sumber.

            Ini bukan hiasan, melainkan pemenuhan GNU AGPL-3.0 Pasal 13: siapa
            pun yang memodifikasi GeuLIS lalu menyajikannya lewat jaringan wajib
            menawarkan kode sumber versinya kepada pengguna. Cara paling lazim
            memenuhinya adalah mengganti tautan di bawah ini ke sumber mereka
            sendiri.

            Efek sampingnya disengaja: fork jadi terlihat. Siapa pun yang
            membuka GeuLIS di rumah sakit mana pun bisa menelusuri kode versi
            yang sedang berjalan di depannya.
          */}
          <div className="sidebar-lisensi">
            <div title={`Antarmuka build v${APP_VERSION}`}>
              GeuLIS v{versiServer?.versi || APP_VERSION}
              {versiServer?.commit && <span className="sidebar-build"> · {versiServer.commit}</span>}
            </div>
            {versiServer?.dibangun && (
              <div className="sidebar-build">
                Build {new Date(versiServer.dibangun).toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric' })}
              </div>
            )}
            <div>
              <a href={SOURCE_URL} target="_blank" rel="noreferrer">Kode sumber</a>
              {' · '}
              <a href="https://www.gnu.org/licenses/agpl-3.0.html" target="_blank" rel="noreferrer">
                AGPL-3.0
              </a>
            </div>
            <div className="sidebar-lisensi-penafian">
              Bukan alat kesehatan. Hasil wajib diverifikasi tenaga berwenang.
            </div>
          </div>
        </nav>
      </aside>
      )}
      
      <main className="main-content">
        {!sidebarOpen && (
          <button 
            className="secondary btn-sm" 
            style={{ marginBottom: '1rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }} 
            onClick={() => toggleSidebar(true)}
          >
            ☰ Tampilkan Menu
          </button>
        )}
        <Outlet />
      </main>
      <style>{`
        .app-shell { display: flex; min-height: 100vh; }
        .sidebar {
          width: 260px; background: var(--surface); border-right: 1px solid var(--border);
          display: flex; flex-direction: column; padding: 1.25rem; flex-shrink: 0;
        }
        .brand { display: flex; align-items: center; margin-bottom: 2rem; }
        .brand-icon { font-size: 2rem; }
        .brand strong { display: block; font-size: 1.1rem; }
        .brand small { color: var(--muted); font-size: 0.75rem; }
        nav { flex: 1; display: flex; flex-direction: column; gap: 0.15rem; }
        .nav-kat { display: flex; flex-direction: column; gap: 0.15rem; }
        .nav-kat + .nav-kat { margin-top: 0.35rem; }
        .nav-kat-head {
          display: flex; align-items: center; justify-content: space-between; width: 100%;
          background: transparent; border: none; cursor: pointer; color: var(--muted);
          font-size: 0.68rem; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase;
          padding: 0.4rem 0.85rem 0.2rem;
        }
        .nav-kat-head:hover { color: var(--text); }
        .nav-kat-chev { font-size: 0.65rem; opacity: 0.8; }
        .sidebar-build { opacity: 0.65; font-size: 0.7rem; }
        nav a {
          display: flex; align-items: center; gap: 0.6rem; padding: 0.65rem 0.85rem;
          border-radius: 8px; color: var(--muted); transition: 0.15s;
        }
        nav a:hover { background: var(--surface2); color: var(--text); }
        nav a.active { background: var(--primary); color: #fff; }
        
        .user-chip { margin-bottom: 2rem; border-bottom: 1px solid var(--border); padding-bottom: 1rem; }
        .user-chip small { color: var(--muted); display: block; }
        
        .main-content { flex: 1; padding: 1.5rem 2rem; overflow: auto; }
      `}</style>
    </div>
  );
}
