// 빌드 시 Chart.js 를 public/vendor 로 복사 (Vercel 정적 파일로 제공)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(root, 'node_modules/chart.js/dist/chart.umd.min.js');
const dest = path.join(root, 'public/vendor/chart.umd.min.js');
fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.copyFileSync(src, dest);
console.log(`복사 완료: ${path.relative(root, dest)}`);
