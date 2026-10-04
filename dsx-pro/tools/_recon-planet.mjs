import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = 'F:\\dsh\\绝地潜兵mod制作';
const REL = join(ROOT, '发布', 'planet-forge');
const TOKEN_FILE = 'F:\\dsh\\.gh-token.txt';
const token = readFileSync(TOKEN_FILE, 'utf8').trim();

const fmt = p => {
  try { return statSync(p).mtime.toISOString().slice(0, 16).replace('T', ' '); } catch { return '(不存在)'; }
};
const size = p => {
  try { return (statSync(p).size / 1024).toFixed(1) + ' KB'; } catch { return '-'; }
};

console.log('=== planet-forge 发布目录 ===');
console.log('  有 .git ?', existsSync(join(REL, '.git')));
for (const f of ['README.md', 'LICENSE', 'NOTICE.md', '.gitignore']) {
  console.log(`  ${f.padEnd(14)} ${fmt(join(REL, f))}  ${size(join(REL, f))}`);
}
console.log('\n=== 发布说明 ===');
for (const f of readdirSync(join(ROOT, '发布'))) {
  if (f.startsWith('RELEASE')) console.log(`  ${f.padEnd(22)} ${fmt(join(ROOT, '发布', f))}`);
}
console.log('\n=== 构建产物 ===');
for (const p of [
  join(ROOT, '发布', 'release-assets', 'PlanetForge.zip'),
  join(ROOT, '发布', 'release-assets', 'planet-forge-toolkit.zip'),
  join(REL, 'dist', 'PlanetForge.zip'),
  join(REL, 'dist', '星球工坊_配置工具包.zip'),
  join(REL, 'src', 'planet_forge.lua')
]) {
  console.log(`  ${fmt(p)}  ${size(p).padStart(10)}  ${p.replace(ROOT + '\\', '')}`);
}

console.log('\n=== GitHub 现状 ===');
const h = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'recon' };
const repo = await fetch('https://api.github.com/repos/amitsom1212/planet-forge', { headers: h });
if (repo.ok) {
  const j = await repo.json();
  console.log(`  仓库存在：${j.full_name}（${j.private ? '私有' : '公开'}）默认分支=${j.default_branch}`);
  const rels = await fetch('https://api.github.com/repos/amitsom1212/planet-forge/releases', { headers: h });
  const list = await rels.json();
  if (Array.isArray(list) && list.length) {
    for (const r of list) {
      console.log(`  Release ${r.tag_name}  ${r.name}  ${r.published_at}`);
      for (const a of r.assets || []) console.log(`      - ${a.name} (${(a.size / 1024).toFixed(1)} KB)`);
    }
  } else {
    console.log('  (还没有任何 Release)');
  }
} else {
  console.log(`  仓库不存在或不可见（HTTP ${repo.status}）`);
  const me = await (await fetch('https://api.github.com/user/repos?per_page=100&sort=updated', { headers: h })).json();
  if (Array.isArray(me)) {
    console.log('  你名下现有的仓库：');
    for (const r of me) console.log(`      ${r.full_name}  (${r.private ? '私有' : '公开'})  ${r.updated_at}`);
  }
}

console.log('\n=== RELEASE_v1.0.1.md 内容 ===');
console.log(readFileSync(join(ROOT, '发布', 'RELEASE_v1.0.1.md'), 'utf8').slice(0, 2500));
