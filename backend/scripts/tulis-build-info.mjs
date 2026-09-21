// Menulis backend/build-info.json berisi commit git + tanggal build saat ini.
//
// Jalankan di mesin yang punya repo git SEBELUM mengemas/rsync ke server yang
// tidak ber-git (mis. lokasi klinik). Dengan begitu /api/version di server tetap
// bisa melaporkan commit yang benar-benar dideploy.
//
//   npm run build-info   (dari folder backend/)
import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const dir = dirname(fileURLToPath(import.meta.url));
const g = (c) => execSync(c, { cwd: join(dir, '..', '..'), stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();

let info;
try {
  info = { commit: g('git rev-parse --short HEAD'), dibangun: new Date().toISOString() };
} catch {
  info = { commit: null, dibangun: new Date().toISOString() };
}

const tujuan = join(dir, '..', 'build-info.json');
writeFileSync(tujuan, JSON.stringify(info, null, 2) + '\n');
console.log('build-info.json ditulis:', info.commit, info.dibangun);
