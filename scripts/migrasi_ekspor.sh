#!/usr/bin/env bash
# Bungkus semua yang dibutuhkan untuk memindahkan GeuLIS ke server produksi
# baru: dump database (lewat scripts/backup.sh), salinan backend/.env, dan
# daftar alat lab yang perlu diarahkan ulang secara fisik ke IP server baru.
#
# Dijalankan DI SERVER LAMA (yang datanya mau dipindah), BUKAN di server baru.
#
#   ./scripts/migrasi_ekspor.sh [DIREKTORI_PAKET]
#
# Lihat PANDUAN_MIGRASI.txt untuk urutan lengkap memakai paket ini di server
# baru.
set -euo pipefail

AKAR="$(cd "$(dirname "$0")/.." && pwd)"
PAKET=${1:-$AKAR/migrasi_keluar}

merah()  { printf '\033[31m%s\033[0m\n' "$*"; }
kuning() { printf '\033[33m%s\033[0m\n' "$*"; }
hijau()  { printf '\033[32m%s\033[0m\n' "$*"; }
judul()  { printf '\n\033[1m%s\033[0m\n' "$*"; }

[ -f "$AKAR/backend/.env" ] || { merah "backend/.env tidak ada di $AKAR."; exit 1; }

mkdir -p "$PAKET"
chmod 700 "$PAKET"

judul "1. Dump database (lewat scripts/backup.sh)"
# Exit 2 dari backup.sh berarti "dump berhasil, tapi belum ada salinan luar
# mesin" -- tidak relevan di sini karena paket ini MEMANG mau disalin keluar
# secara manual sebentar lagi. Hanya exit selain 0/2 (mis. 1 = mysqldump
# gagal) yang menghentikan skrip ini.
set +e
TUJUAN="$PAKET" SIMPAN_HARI=9999 "$AKAR/scripts/backup.sh"
STATUS=$?
set -e
if [ "$STATUS" != 0 ] && [ "$STATUS" != 2 ]; then
  merah "Dump gagal (exit $STATUS) -- lihat $PAKET/backup.log"
  exit 1
fi
DUMP=$(ls -t "$PAKET"/geulis_*.sql.gz | head -1)
hijau "✓ $DUMP"

judul "2. Salin backend/.env"
# JWT_SECRET dan kredensial DB ikut disalin APA ADANYA, tidak dibangkitkan
# ulang -- wajib, supaya API key SIMRS yang sudah terenkripsi di database
# (lihat backend/src/services/rahasiaApiKey.js) tetap bisa dibuka lewat
# "Salin" di menu API Key, dan supaya Khanza tidak perlu dikonfigurasi ulang.
cp "$AKAR/backend/.env" "$PAKET/backend.env"
chmod 600 "$PAKET/backend.env"
hijau "✓ $PAKET/backend.env"

judul "3. Daftar alat lab (perlu diarahkan ulang secara fisik ke server baru)"
ambil() { sed -n "s/^$1=//p" "$AKAR/backend/.env" | tail -1 | tr -d '"'"'"'\r'; }
DB_HOST=$(ambil DB_HOST); DB_HOST=${DB_HOST:-127.0.0.1}
DB_USER=$(ambil DB_USER)
DB_PASS=$(ambil DB_PASSWORD)
DB_NAME=$(ambil DB_NAME)
{
  echo "Alat lab aktif di server ini -- kabel/konfigurasi jaringannya perlu"
  echo "diarahkan ke IP server BARU setelah migrasi (server tidak bisa menarik"
  echo "koneksi dari alat, alat yang menghubungi server)."
  echo
  MYSQL_PWD="$DB_PASS" mysql -h "$DB_HOST" -u "$DB_USER" "$DB_NAME" \
    -e "SELECT name AS alat, code, port, conn_mode FROM instruments WHERE is_active=1"
} | tee "$PAKET/daftar_alat.txt"

judul "Selesai -- paket siap dipindah"
echo "  $PAKET/"
echo "    ├── $(basename "$DUMP")"
echo "    ├── backend.env"
echo "    └── daftar_alat.txt"
echo
echo "  Salin ke server baru (jalankan dari mesin manapun yang bisa SSH ke"
echo "  keduanya, atau dari mesin ini langsung):"
echo
echo "    scp -r '$PAKET' user@IP_SERVER_BARU:/tmp/migrasi_geulis"
echo
kuning "  Paket ini berisi DATA PASIEN dan KREDENSIAL (password DB, JWT_SECRET)."
kuning "  Setelah migrasi selesai dan sudah diverifikasi (PANDUAN_MIGRASI.txt"
kuning "  langkah verifikasi), hapus paket ini dari KEDUA mesin:"
echo "    rm -rf '$PAKET' /tmp/migrasi_geulis"
