import { useEffect, useState } from 'react';
import { api } from '../api';
import { useAuth } from '../context/AuthContext';
import Swal from 'sweetalert2';

const TYPES = ['patient', 'order', 'result', 'test'];

export default function Mapping() {
  const { can } = useAuth();
  const [mappings, setMappings] = useState([]);
  const [tests, setTests] = useState([]);
  const [editId, setEditId] = useState(null);
  const [form, setForm] = useState({ mapping_type: 'test', lis_field: '', simrs_field: '', transform_rule: '', notes: '', is_active: true });

  const [userMaps, setUserMaps] = useState([]);
  const [users, setUsers] = useState([]);
  const [userForm, setUserForm] = useState({ simrs_user_id: '', geulis_user_id: '', notes: '' });

  const load = () => {
    api.mapping.get().then((d) => {
      setMappings(d.mappings.filter(m => m.mapping_type === 'test'));
    });
    api.tests.list().then(setTests);
    api.mapping.users.get().then(setUserMaps);
    api.users.list().then(setUsers);
  };

  useEffect(() => { load(); }, []);

  const submitUserMap = async (e) => {
    e.preventDefault();
    try {
      await api.mapping.users.create(userForm);
      setUserForm({ simrs_user_id: '', geulis_user_id: '', notes: '' });
      load();
    } catch (err) {
      Swal.fire({ icon: 'error', title: 'Gagal menyimpan', text: err.message });
    }
  };

  const submitMapping = async (e) => {
    e.preventDefault();
    if (editId) {
      await api.mapping.update(editId, form);
    } else {
      await api.mapping.create(form);
    }
    setForm({ mapping_type: 'test', lis_field: '', simrs_field: '', transform_rule: '', notes: '', is_active: true });
    setEditId(null);
    load();
  };


  if (!can('mapping.view')) return <p className="error-msg">Akses ditolak</p>;

  return (
    <div>
      <h1 className="page-title">Mapping Data SIMRS</h1>
      <p style={{ color: 'var(--muted)', marginBottom: '1.25rem' }}>
        Mapping kode pemeriksaan laboratorium antara LIS dan SIMRS.
      </p>

      {can('mapping.manage') && (
        <form className="card" onSubmit={submitMapping} style={{ marginBottom: '1.25rem' }}>
          <h2 style={{ marginBottom: '1rem' }}>{editId ? 'Edit Mapping' : 'Tambah Mapping'}</h2>
          <div className="form-grid">
            <div className="form-group">
              <label>Pemeriksaan LIS</label>
              <select required value={form.lis_field} onChange={(e) => setForm({ ...form, lis_field: e.target.value })}>
                <option value="">-- Pilih Pemeriksaan LIS --</option>
                {tests.filter(t => t.show_in_report).map(t => (
                  <option key={t.id} value={t.code}>{t.code} — {t.name}</option>
                ))}
              </select>
            </div>
            <div className="form-group"><label>Kode SIMRS</label><input required value={form.simrs_field} onChange={(e) => setForm({ ...form, simrs_field: e.target.value })} placeholder="Contoh: 12345" /></div>
            {editId && (
              <div className="form-group" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginTop: '1.5rem' }}>
                <input type="checkbox" id="is_active" checked={form.is_active} onChange={(e) => setForm({ ...form, is_active: e.target.checked })} />
                <label htmlFor="is_active" style={{ margin: 0 }}>Aktif</label>
              </div>
            )}
          </div>
          <div style={{ display: 'flex', gap: '0.5rem', marginTop: '1rem' }}>
            <button type="submit">{editId ? 'Simpan Perubahan' : 'Tambah'}</button>
            {editId && (
              <button type="button" className="secondary" onClick={() => {
                setEditId(null);
                setForm({ mapping_type: 'test', lis_field: '', simrs_field: '', transform_rule: '', notes: '', is_active: true });
              }}>Batal</button>
            )}
          </div>
        </form>
      )}

      <div className="card">
        <table>
          <thead><tr><th>Pemeriksaan LIS</th><th>Kode SIMRS</th><th>Aktif</th><th>Aksi</th></tr></thead>
          <tbody>
            {mappings.map((m) => {
              const test = tests.find(t => t.code === m.lis_field);
              return (
                <tr key={m.id}>
                  <td><strong>{m.lis_field}</strong> {test ? `— ${test.name}` : ''}</td>
                  <td><code>{m.simrs_field}</code></td>
                  <td>{m.is_active ? 'Ya' : 'Tidak'}</td>
                  <td>
                    <div style={{ display: 'flex', gap: '0.5rem' }}>
                      <button className="secondary btn-sm" type="button" onClick={() => {
                        setEditId(m.id);
                        setForm({
                          mapping_type: m.mapping_type,
                          lis_field: m.lis_field,
                          simrs_field: m.simrs_field,
                          transform_rule: m.transform_rule || '',
                          notes: m.notes || '',
                          is_active: m.is_active === 1
                        });
                        window.scrollTo({ top: 0, behavior: 'smooth' });
                      }}>Edit</button>
                      <button className="danger btn-sm" type="button" onClick={async () => {
                        const res = await Swal.fire({ title: 'Hapus mapping ini?', icon: 'warning', showCancelButton: true, confirmButtonText: 'Ya', cancelButtonText: 'Batal' });
                        if (res.isConfirmed) {
                          await api.mapping.remove(m.id);
                          load();
                        }
                      }}>Hapus</button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <h2 style={{ margin: '2rem 0 0.5rem' }}>Pemetaan User SIMRS ↔ GeuLIS</h2>
      <p style={{ color: 'var(--muted)', marginBottom: '1.25rem' }}>
        Supaya verifikasi hasil yang dipicu dari SIMRS (fitur "verifikasi tanpa buka LIS")
        tercatat atas nama petugas yang sebenarnya — bukan akun API generik. Petugas lab
        yang perlu verifikasi dari SIMRS harus dipetakan di sini terlebih dahulu.
      </p>

      {can('mapping.manage') && (
        <form className="card" onSubmit={submitUserMap} style={{ marginBottom: '1.25rem' }}>
          <div className="form-grid">
            <div className="form-group">
              <label>ID User di SIMRS</label>
              <input required value={userForm.simrs_user_id} onChange={(e) => setUserForm({ ...userForm, simrs_user_id: e.target.value })} placeholder="Contoh: NIP atau user_id Khanza" />
            </div>
            <div className="form-group">
              <label>Akun GeuLIS</label>
              <select required value={userForm.geulis_user_id} onChange={(e) => setUserForm({ ...userForm, geulis_user_id: e.target.value })}>
                <option value="">-- Pilih Akun GeuLIS --</option>
                {users.map(u => (
                  <option key={u.id} value={u.id}>{u.username} — {u.full_name}</option>
                ))}
              </select>
            </div>
            <div className="form-group"><label>Catatan (opsional)</label><input value={userForm.notes} onChange={(e) => setUserForm({ ...userForm, notes: e.target.value })} /></div>
          </div>
          <button type="submit" style={{ marginTop: '1rem' }}>Tambah Pemetaan</button>
        </form>
      )}

      <div className="card">
        <table>
          <thead><tr><th>ID User SIMRS</th><th>Akun GeuLIS</th><th>Aktif</th><th>Catatan</th><th>Aksi</th></tr></thead>
          <tbody>
            {userMaps.map((m) => (
              <tr key={m.id}>
                <td><code>{m.simrs_user_id}</code></td>
                <td>{m.username} — {m.full_name}</td>
                <td>{m.is_active ? 'Ya' : 'Tidak'}</td>
                <td>{m.notes || '—'}</td>
                <td>
                  <button className="danger btn-sm" type="button" onClick={async () => {
                    const res = await Swal.fire({ title: 'Hapus pemetaan ini?', icon: 'warning', showCancelButton: true, confirmButtonText: 'Ya', cancelButtonText: 'Batal' });
                    if (res.isConfirmed) {
                      await api.mapping.users.remove(m.id);
                      load();
                    }
                  }}>Hapus</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
