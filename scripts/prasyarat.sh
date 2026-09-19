#!/usr/bin/env bash
# Prasyarat sistem GeuLIS pada mesin BARU (Ubuntu/Debian/Linux Mint) --
# dijalankan SEKALI, sebelum scripts/pasang.sh. Memasang Node.js, MariaDB,
# Nginx, git. Tidak menyentuh aplikasi GeuLIS itu sendiri sama sekali.
#
#   sudo ./scripts/prasyarat.sh
#
# Aman dijalankan berkali-kali -- tiap langkah memeriksa dulu sebelum memasang.
set -euo pipefail

merah()  { printf '\033[31m%s\033[0m\n' "$*"; }
kuning() { printf '\033[33m%s\033[0m\n' "$*"; }
hijau()  { printf '\033[32m%s\033[0m\n' "$*"; }
judul()  { printf '\n\033[1m%s\033[0m\n' "$*"; }

[ "$(id -u)" -eq 0 ] || { merah "Jalankan dengan sudo."; exit 1; }

NODE_MAYOR_TARGET=${NODE_MAYOR_TARGET:-22}

# ---------------------------------------------------------------- 0. bentrokan
judul "0. Periksa bentrokan port & layanan lain"
echo "Port yang sudah dipakai di mesin ini:"
ss -ltnp 2>/dev/null | awk 'NR==1 || /LISTEN/' || true
if command -v docker >/dev/null 2>&1 && [ -n "$(docker ps -q 2>/dev/null)" ]; then
  kuning "Ada container Docker sedang berjalan -- periksa dulu apakah itu LIS lain"
  kuning "dengan data pasien sebelum lanjut (jangan langsung dihentikan/dihapus):"
  docker ps
  read -r -p "Tetap lanjut memasang prasyarat GeuLIS? (y/N) " jwb
  [ "${jwb:-}" = "y" ] || { merah "Dibatalkan."; exit 1; }
fi

# ---------------------------------------------------------------- 1. Node.js
judul "1. Node.js (butuh >= 18, disarankan ${NODE_MAYOR_TARGET}.x)"
if command -v node >/dev/null 2>&1 && \
   [ "$(node -v | sed 's/^v//;s/\..*//')" -ge 18 ] 2>/dev/null; then
  hijau "✓ node $(node -v) sudah cukup -- dilewati"
else
  kuning "Memasang Node.js ${NODE_MAYOR_TARGET}.x dari NodeSource..."
  # Sisa nodejs versi lama dari apt (libnode-dev dkk) membuat pemasangan
  # NodeSource gagal dengan pesan "trying to overwrite .../common.gypi" --
  # dibersihkan dulu supaya tidak berhenti di tengah jalan.
  apt-get purge -y libnode-dev libnode72 nodejs-doc >/dev/null 2>&1 || true
  apt-get autoremove -y >/dev/null 2>&1 || true
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAYOR_TARGET}.x" | bash -
  apt-get install -y nodejs
  hijau "✓ node $(node -v), npm $(npm -v)"
fi

# ---------------------------------------------------------------- 2. MariaDB
judul "2. MariaDB"
if command -v mysql >/dev/null 2>&1 && systemctl is-active --quiet mariadb 2>/dev/null; then
  hijau "✓ MariaDB sudah terpasang & aktif -- dilewati"
else
  apt-get update
  apt-get install -y mariadb-server
  systemctl enable --now mariadb
  hijau "✓ MariaDB terpasang & aktif"
  kuning "  Belum dijalankan: mysql_secure_installation (disarankan, interaktif --"
  kuning "  jalankan manual: sudo mysql_secure_installation)"
fi

# ---------------------------------------------------------------- 3. Nginx
judul "3. Nginx"
if command -v nginx >/dev/null 2>&1; then
  hijau "✓ nginx sudah terpasang -- dilewati"
else
  apt-get install -y nginx
  systemctl enable --now nginx
  hijau "✓ nginx terpasang & aktif"
fi

# ---------------------------------------------------------------- 4. Git & rsync
judul "4. Git & rsync"
PAKET_KURANG=""
command -v git   >/dev/null 2>&1 || PAKET_KURANG="$PAKET_KURANG git"
command -v rsync >/dev/null 2>&1 || PAKET_KURANG="$PAKET_KURANG rsync"
[ -z "$PAKET_KURANG" ] || apt-get install -y $PAKET_KURANG
hijau "✓ git $(git --version | awk '{print $3}'), rsync tersedia"

# ---------------------------------------------------------------- selesai
judul "Selesai -- prasyarat sistem siap"
echo "  node   : $(node -v)"
echo "  mysql  : $(mysql --version 2>/dev/null | awk '{print $3, $5}')"
echo "  nginx  : $(nginx -v 2>&1)"
echo
echo "  Langkah berikutnya:"
echo "    - Pemasangan BARU (kosong)  : clone repo lalu 'sudo ./scripts/pasang.sh'"
echo "    - Pindahan dari server lama : ikuti PANDUAN_MIGRASI.txt"
