// Identitas versi GeuLIS.
//
// Ini bukan sekadar angka pajangan. GeuLIS dipasang di banyak lokasi (rumah
// sakit/klinik) yang dideploy lewat rsync pada waktu berbeda, sehingga tanpa
// penanda versi yang bisa dilihat, laporan masalah dari satu lokasi tidak bisa
// dipastikan berasal dari kode yang mana. Endpoint /api/version dan tampilan di
// UI menutup celah itu.
//
// VERSI mengikuti Semantic Versioning (MAYOR.MINOR.TAMBALAN). Naikkan angkanya
// di sini setiap rilis; ini satu-satunya tempat yang perlu diubah.
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const dir = dirname(fileURLToPath(import.meta.url));

export const VERSI = '1.4.0';

// Commit dan tanggal build dihitung sekali saat modul dimuat, bukan tiap
// permintaan (memanggil git per-request boros dan tak perlu).
function hitungBuild() {
  // 1) build-info.json — ditulis saat build (npm run build-info). Ini jalur
  //    untuk server yang dideploy rsync dan TIDAK punya git di direktorinya.
  try {
    const bi = JSON.parse(readFileSync(join(dir, '..', 'build-info.json'), 'utf8'));
    if (bi.commit) return { commit: bi.commit, dibangun: bi.dibangun ?? null };
  } catch {
    // build-info.json tidak ada — lanjut ke git langsung.
  }
  // 2) Baca git langsung — untuk pengembangan dan server yang punya repo.
  try {
    const opsi = { cwd: join(dir, '..', '..'), stdio: ['ignore', 'pipe', 'ignore'] };
    const commit = execSync('git rev-parse --short HEAD', opsi).toString().trim();
    const dibangun = execSync('git show -s --format=%cI HEAD', opsi).toString().trim();
    return { commit, dibangun };
  } catch {
    // Bukan repo git / git tak tersedia.
  }
  return { commit: null, dibangun: null };
}

const build = hitungBuild();

export function infoVersi() {
  return {
    nama: 'GeuLIS',
    versi: VERSI,
    commit: build.commit,
    dibangun: build.dibangun,
    runtime: `Node.js ${process.version}`,
  };
}
