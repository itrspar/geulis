# Bridging SIMRS Khanza ↔ GeuLIS

Menghubungkan SIMRS Khanza dengan GeuLIS: permintaan lab dikirim dari SIMRS ke LIS,
hasilnya ditarik kembali ke SIMRS.

Sisi LIS: [`backend/src/routes/bridging.js`](../backend/src/routes/bridging.js).
Sisi SIMRS: `src/bridging/ApiGEULIS.java` pada source SIMRS-Khanza (branch
`feat/bridging-geulis`).

---

## 1. Alur

```
SIMRS  ──POST /api/bridging/order────────▶  GeuLIS   (kirim permintaan)
SIMRS  ──GET  /api/bridging/result/{no}─▶  GeuLIS   (tarik hasil)
```

Menu di **Permintaan Lab → klik kanan**: "Kirim Permintaan ke GeuLIS" dan
"Ambil Hasil dari GeuLIS", sejajar dengan LICA/MEDQLAB yang sudah ada.

Hasil yang ditarik **tidak langsung masuk rekam medis**. Ia mendarat di tabel
singgahan `temporary_permintaan_lab`, lalu form *Periksa Laboratorium* terbuka
dengan nilai yang sudah terisi. Petugas memeriksa dan menyimpan seperti biasa.

## 2. Alamat endpoint — perhatikan baik-baik

```
HOSTWSGEULIS = http://192.168.1.14:5173/api/bridging
```

> **Jangan pakai `/bridging` tanpa awalan `/api` di port web.** Rute itu jatuh ke
> fallback SPA dan membalas **HTML dengan status 200** — pemanggil mengira
> berhasil padahal permintaan tidak pernah sampai ke API. `ApiGEULIS` mendeteksi
> balasan yang diawali `<` dan menolaknya, tetapi lebih baik alamatnya benar sejak
> awal.

Alternatif langsung ke backend (melewati nginx): `http://192.168.1.14:3001/bridging`.
Keduanya berfungsi; yang lewat nginx lebih disarankan agar port 3001 tidak perlu
dibuka ke jaringan.

## 3. Konfigurasi di SIMRS

Tambahkan dua baris ke `setting/database.xml` pada folder SIMRS:

```xml
<entry key="HOSTWSGEULIS">http://192.168.1.14:5173/api/bridging</entry>
<entry key="KEYWSGEULIS">&lt;API key GeuLIS, terenkripsi AES&gt;</entry>
```

`KEYWSGEULIS` **wajib terenkripsi AES**, sama seperti `KEYWSLICA` dan key bridging
lainnya — `koneksiDB.KEYWSGEULIS()` memanggil `EnkripsiAES.decrypt()`. Nilai mentah
tidak akan bekerja.

Cara membangkitkan nilai terenkripsi dari API key GeuLIS:

```bash
# dari folder SIMRS-Khanza
cat > /tmp/GenKey.java <<'EOF'
import AESsecurity.EnkripsiAES;
public class GenKey {
    public static void main(String[] a) throws Exception {
        System.out.println(EnkripsiAES.encrypt(a[0]));
    }
}
EOF
CP="KhanzaSecurity16bit/build/classes:$(find . -name '*.jar' ! -name '*-src.jar' | tr '\n' ':')"
javac -cp "$CP" -d /tmp /tmp/GenKey.java
java -cp "/tmp:$CP" GenKey <API_KEY_GEULIS>
```

API key GeuLIS dibuat dan dilihat di menu **Pengaturan → API Key** pada web LIS.

## 4. Pemetaan kode pemeriksaan

Yang dikirim SIMRS sebagai kode tes adalah **`id_template`** dari
`permintaan_detail_permintaan_lab`, bukan nama pemeriksaan — supaya pemetaan tidak
rusak ketika nama pemeriksaan diedit di SIMRS.

Pemetaan bisa diisi **dua cara**:

1. **Di GeuLIS** lewat menu **Mapping SIMRS** (`simrs_mappings`, `mapping_type = 'test'`):
   `simrs_field` = `id_template` SIMRS, `lis_field` = kode tes GeuLIS.

2. **Didorong dari SIMRS** lewat endpoint `POST /api/bridging/test-catalog`
   (lihat §6). Khanza mengirim `id_template` + nama + satuan + rentang rujukan;
   GeuLIS **membuat `lab_tests` bila belum ada**, lalu memetakannya. Kode LIS
   selalu **dibuat GeuLIS** (diturunkan dari nama) dan dikembalikan ke Khanza.
   SIMRS jadi sumber kebenaran untuk **nama, satuan, rentang rujukan** — sync
   berikutnya menimpa. Yang **tetap milik lab di GeuLIS**: tautan ke alat
   (`instrument_test_map`) dan **nilai kritis**.

Pemetaan dipakai dua arah: saat order masuk (menerjemahkan `id_template` ke kode
tes LIS) dan saat hasil ditarik (dikembalikan sebagai `code_simrs`). Mapping yang
`is_active = 0` (dinonaktifkan dari Khanza) diabaikan di kedua arah.

**Tanpa pemetaan, hasil tidak bisa ditarik** — `ApiGEULIS` melewati baris yang
`code_simrs`-nya kosong dan melaporkan jumlah yang dilewati.

## 5. Aturan penarikan hasil

Hanya hasil berstatus **`completed`** yang ditarik, yaitu yang sudah diverifikasi
petugas di GeuLIS. Hasil `preliminary` (sudah ada angka tetapi belum diverifikasi)
sengaja dilewati, agar nilai yang belum disahkan tidak masuk rekam medis pasien.

Kalau petugas menarik hasil terlalu cepat, muncul pesan bahwa belum ada hasil yang
diverifikasi — bukan tabel kosong tanpa penjelasan.

## 6. Kontrak API

### POST `/api/bridging/order`

Header: `x-api-key: <API key>`

```json
{
  "simrs_order_id": "PL202609030001",
  "medical_record_no": "000123",
  "patient_name": "BUDI SANTOSO",
  "gender": "L",
  "birth_date": "1990-01-01",
  "priority": "normal",
  "notes": "[ralan] Poli Umum - dr. Andi - Anemia",
  "tests": ["12", "15", "18"]
}
```

Balasan `201`:

```json
{
  "message": "Order berhasil diterima",
  "data": { "request_no": "REQ20260903123456", "simrs_order_id": "...", "patient_id": 30, "request_id": 29 },
  "instructions": {
    "sample_id": "PL202609030001",
    "medical_record_no": "000123",
    "catatan": "Ketik/scan Sample ID = nomor order ini di alat lab. Kotak Patient ID iChroma II maksimal 15 karakter ...",
    "patient": { "name": "BUDI SANTOSO", "medical_record_no": "000123" },
    "instruments": [
      { "code": "EDAN-I15-01", "name": "EDAN i15 Blood Gas", "tests": ["pH", "Natrium (Na+)", "Kalium (K+)"] }
    ],
    "tests_tanpa_alat": []
  }
}
```

Balasan `409` berarti `simrs_order_id` sudah pernah dikirim.

**`instructions`** dipakai SIMRS untuk menampilkan notifikasi setelah petugas
menekan "Kirim ke GeuLIS": alat lab **tidak bisa** menarik order dari LIS,
jadi petugas harus mengetik/scan **`sample_id`** (nomor order) secara manual
di alat. `instruments` memberi tahu alat mana dan tes apa; `tests_tanpa_alat`
adalah tes yang `id_template`-nya termapping ke kode LIS tetapi kode itu
belum dikaitkan ke alat mana pun di menu Alat Laboratorium. SIMRS tidak perlu
tahu pemetaan alat sendiri — kalau pemetaan di GeuLIS berubah, isi
`instructions` ikut berubah.

### GET `/api/bridging/result/{simrs_order_id}`

```json
{
  "simrs_order_id": "PL202609030001",
  "request_no": "REQ20260903123456",
  "status": "completed",
  "patient": { "medical_record_no": "000123", "name": "BUDI SANTOSO" },
  "results": [
    {
      "test_code": "WBC", "code_simrs": "12", "test_name": "Leukosit",
      "result_value": "7.25", "unit": "10*9/L", "reference": "4.0 - 10.0",
      "flag": "normal", "status": "completed"
    }
  ]
}
```

`status` per pemeriksaan: `pending` (belum ada hasil), `preliminary` (ada hasil,
belum diverifikasi), `completed` (sudah diverifikasi).

Field tambahan per hasil, dipakai untuk verifikasi (§6a): `result_id` (dipakai
sebagai `:id` pada `POST /result/{id}/verify`), `needs_report_before_verify`
(`true` bila hasil berpenanda kritis/abnormal/delta mencurigakan dan belum ada
catatan pelaporan — SIMRS sebaiknya menampilkan input "dilaporkan ke siapa"
sebelum memanggil endpoint verifikasi, bukan menunggu error 400).

### POST `/api/bridging/result/{result_id}/verify`

Verifikasi hasil langsung dari SIMRS — LIS berjalan sebagai layanan latar
belakang, petugas tidak perlu membuka aplikasi LIS untuk kasus normal maupun
kritis.

**Prasyarat**: petugas yang memverifikasi harus sudah dipetakan ke akun
GeuLIS di menu *Mapping SIMRS → Pemetaan User SIMRS ↔ GeuLIS* (butuh
permission `mapping.manage`, dilakukan sekali oleh admin LIS per petugas).
Tanpa pemetaan ini, panggilan ditolak `403` — verifikasi hasil lab harus bisa
ditelusuri ke satu petugas berwenang, bukan ke akun API generik.

Body:

```json
{
  "simrs_user_id": "198501012010011001",
  "reported_to": "dr. Andi (opsional, WAJIB untuk hasil kritis/abnormal)",
  "reported_via": "Telepon",
  "readback": true,
  "note": "Pasien sudah rawat inap ruang ICU"
}
```

- `simrs_user_id` — ID user SIMRS yang sedang login, dipetakan ke akun GeuLIS
  lewat menu di atas. Wajib di setiap panggilan.
- `reported_to`, `reported_via`, `readback`, `note` — catatan pelaporan nilai
  kritis (PMK 43/2013): siapa yang dihubungi, lewat apa, apakah dibacakan
  ulang. **Wajib diisi** (minimal `reported_to`) hanya jika hasil berpenanda
  `critical`/`abnormal` atau `delta_flag='check'` DAN belum pernah dilaporkan
  sebelumnya (`needs_report_before_verify: true` pada respons GET /result).
  Untuk hasil normal, field ini boleh dikosongkan — verifikasi langsung
  diproses.

Sukses (`200`):

```json
{ "ok": true, "verified_by": "andi.analis", "push": { "total": 1, "pushed": 1, "details": [...] } }
```

Order otomatis ditutup (`status='completed'`) dan hasilnya didorong balik ke
SIMRS (lihat §5) begitu SELURUH item order tersebut sudah final — bukan per
hasil, supaya SIMRS tidak menerima laporan sebagian.

Error yang mungkin muncul:

| Status | Kapan | Tindakan SIMRS |
|---|---|---|
| `400` `requires_report: true` | Hasil kritis/abnormal, `reported_to` belum diisi | Tampilkan form pelaporan, kirim ulang dengan `reported_to` terisi |
| `403` | `simrs_user_id` belum dipetakan / akun GeuLIS nonaktif | Minta admin LIS memetakan akun via menu Mapping SIMRS |
| `404` | `result_id` tidak ditemukan | — |
| `409` | Hasil sudah `final`/`corrected`, tidak bisa diverifikasi ulang lewat jalur ini | Sembunyikan tombol verifikasi untuk hasil yang statusnya sudah `completed` |

### GET `/api/bridging/test-catalog`

SIMRS menariknya untuk rekonsiliasi — tahu tes apa yang sudah ada di LIS, mana
yang termapping, mana yang terhubung alat.

```json
{
  "tests": [
    {
      "lis_code": "pH", "name": "pH", "unit": "",
      "is_active": true, "instrument": "EDAN i15 Blood Gas", "instrument_linked": true,
      "reference": { "min": 7.35, "max": 7.45, "min_l": null, "max_l": null, "min_p": null, "max_p": null },
      "critical": { "min": null, "max": null },
      "mapped_id_templates": ["9001"],
      "mapped_id_templates_nonaktif": []
    }
  ]
}
```

### POST `/api/bridging/test-catalog`

SIMRS membuat/memperbarui pemeriksaan + mapping. Dipanggil dari layar template
pemeriksaan Khanza saat simpan (create/edit). Kirim satu batch:

```json
{
  "tests": [
    {
      "id_template": "3765",
      "name": "TSH",
      "unit": "uIU/mL",
      "reference_min": 0.4, "reference_max": 4.0,
      "reference_min_l": null, "reference_max_l": null,
      "reference_min_p": null, "reference_max_p": null
    }
  ]
}
```

Balasan — satu baris per tes:

```json
{ "tests": [ { "id_template": "3765", "lis_code": "TSH", "action": "linked", "warnings": ["..."] } ] }
```

`action`: `created` (lab_tests + mapping baru), `linked` (id_template ditautkan ke
kode LIS yang sudah ada — kodenya diturunkan dari nama dan kebetulan cocok),
`updated` (mapping sudah ada, metadata diperbarui), `recreated` (mapping ada tapi
lab_tests-nya hilang), `skipped` (`id_template`/`name` kosong).

`lis_code` **selalu ditentukan GeuLIS** — SIMRS simpan nilai balasannya. Nilai
kritis dan tautan alat tidak pernah diterima dari sini.

### DELETE `/api/bridging/test-catalog/{id_template}`

- default: **hapus** baris `simrs_mappings`. `lab_tests`-nya ikut dinonaktifkan
  hanya bila tidak terhubung alat, tidak punya hasil, dan tidak ada mapping lain.
- `?mode=deactivate`: **nonaktifkan** mapping saja (`is_active = 0`) — bisa
  diaktifkan lagi dengan `POST /test-catalog` id_template yang sama.

## 7. Kalau bermasalah

| Gejala | Sebab |
|---|---|
| "server membalas halaman web, bukan API" | `HOSTWSGEULIS` salah — harus berakhiran `/api/bridging` |
| "API Key GeuLIS ditolak" | `KEYWSGEULIS` salah, atau lupa dienkripsi AES |
| "sudah pernah dikirim ke GeuLIS" | `simrs_order_id` sama dikirim dua kali (HTTP 409) |
| Hasil ditarik tapi kosong semua | Belum diverifikasi di GeuLIS, atau `id_template` belum dipetakan |
| "Koneksi ke server GeuLIS terputus" | Jaringan, atau backend LIS mati — cek `pm2 status` di server |

Semua permintaan yang masuk tercatat di log audit GeuLIS (menu **Log Audit**,
sumber `bridging`).
