#!/usr/bin/env bash
# Tarik update terbaru dari git dan terapkan di server PRODUKSI.
#
# Dijalankan DI SERVER PRODUKSI (bukan di mesin dev) lewat:
#
#   sudo ./scripts/update.sh
#
# Menolak berjalan kalau ada perubahan lokal yang belum dikomit, atau kalau
# riwayat lokal sudah menyimpang dari origin (tidak bisa fast-forward) --
# server produksi tidak semestinya pernah punya salah satu dari keduanya,
# dan memaksakan update lewat keduanya bisa diam-diam membuang perubahan.
set -euo pipefail

AKAR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$AKAR"

PENGGUNA=${PENGGUNA:-geulis}

merah()  { printf '\033[31m%s\033[0m\n' "$*"; }
kuning() { printf '\033[33m%s\033[0m\n' "$*"; }
hijau()  { printf '\033[32m%s\033[0m\n' "$*"; }
judul()  { printf '\n\033[1m%s\033[0m\n' "$*"; }

[ "$(id -u)" -eq 0 ] || { merah "Jalankan dengan sudo (perlu restart layanan systemd di langkah akhir)."; exit 1; }

sudo_pengguna() {
  # Jalankan sebagai $PENGGUNA (bukan root) supaya berkas tetap dimiliki
  # $PENGGUNA seperti yang dibuat scripts/pasang.sh -- git/npm sebagai root
  # akan diam-diam mengganti kepemilikan .git dan node_modules, dan update
  # berikutnya yang berjalan sebagai $PENGGUNA jadi gagal karena "Permission
  # denied" pada berkas yang kini milik root.
  if id "$PENGGUNA" >/dev/null 2>&1; then
    sudo -u "$PENGGUNA" bash -c "$1"
  else
    bash -c "$1"
  fi
}

judul "0. Periksa perubahan lokal"
if [ -n "$(git status --porcelain)" ]; then
  merah "Ada perubahan yang belum dikomit di $AKAR -- update dibatalkan."
  echo "  Server produksi tidak semestinya punya perubahan lokal. Periksa dengan:"
  echo "    git status"
  exit 1
fi
hijau "✓ tidak ada perubahan lokal"

CABANG=$(git rev-parse --abbrev-ref HEAD)
SEBELUM=$(git rev-parse --short HEAD)

judul "1. Tarik update (cabang $CABANG)"
sudo_pengguna "cd '$AKAR' && git fetch origin '$CABANG'"
if ! git merge-base --is-ancestor HEAD "origin/$CABANG"; then
  merah "Riwayat lokal menyimpang dari origin/$CABANG -- tidak bisa fast-forward."
  echo "  Ini TIDAK NORMAL di server produksi (semestinya cuma pernah ditarik,"
  echo "  tidak pernah dikomit langsung di sini). Periksa manual sebelum lanjut:"
  echo "    git log --oneline HEAD..origin/$CABANG     # yang belum masuk ke sini"
  echo "    git log --oneline origin/$CABANG..HEAD     # yang cuma ada di sini"
  exit 1
fi
sudo_pengguna "cd '$AKAR' && git merge --ff-only 'origin/$CABANG'"
SESUDAH=$(git rev-parse --short HEAD)

if [ "$SEBELUM" = "$SESUDAH" ]; then
  hijau "✓ Sudah versi terbaru ($SEBELUM) -- tidak ada yang berubah, berhenti di sini."
  exit 0
fi
echo "  $SEBELUM -> $SESUDAH"
git log --oneline "$SEBELUM..$SESUDAH"

judul "2. Pasang ulang dependensi (kalau package.json berubah)"
sudo_pengguna "cd '$AKAR' && npm run install:all"
hijau "✓ dependensi terpasang"

judul "3. Bangun ulang frontend"
sudo_pengguna "cd '$AKAR/frontend' && npm run build"
hijau "✓ frontend/dist diperbarui"

# Jaga-jaga: build/npm install kadang membuat berkas baru lewat proses lain
# (mis. dijalankan manual sebagai root sebelumnya). Disamakan lagi di sini.
chown -R "$PENGGUNA:$PENGGUNA" "$AKAR" 2>/dev/null || true

judul "4. Restart layanan"
# ensureSchema.js jalan otomatis tiap backend start -- kolom/tabel baru
# terpasang sendiri saat restart ini, tidak perlu langkah migrasi terpisah.
if systemctl list-unit-files geulis.service >/dev/null 2>&1; then
  systemctl restart geulis
  sleep 2
  if systemctl is-active --quiet geulis; then
    hijau "✓ layanan geulis aktif"
  else
    merah "Layanan geulis GAGAL start setelah update -- lihat: journalctl -u geulis -n 50"
    exit 1
  fi
elif command -v pm2 >/dev/null 2>&1 && pm2 describe geulis-backend >/dev/null 2>&1; then
  pm2 restart geulis-backend
  hijau "✓ pm2 geulis-backend direstart"
else
  merah "Tidak ketemu layanan geulis (systemd) atau geulis-backend (pm2)."
  echo "  Restart manual sesuai cara aplikasi ini dijalankan di server ini."
  exit 1
fi

judul "5. Periksa"
ambil() { sed -n "s/^$1=//p" "$AKAR/backend/.env" | tail -1 | tr -d '"'"'"'\r'; }
PORT_API=$(ambil PORT); PORT_API=${PORT_API:-3001}
sleep 1
if curl -sf "http://127.0.0.1:$PORT_API/api/health" >/dev/null; then
  hijau "✓ /api/health merespons"
else
  kuning "  /api/health belum merespons -- normal kalau backend masih start,"
  kuning "  periksa lagi sebentar: curl http://127.0.0.1:$PORT_API/api/health"
fi

judul "Selesai -- $SEBELUM -> $SESUDAH"
echo "  Uji login sungguhan dari browser sebelum menganggap update beres --"
echo "  /api/health tetap membalas 200 walau koneksi database bermasalah."
