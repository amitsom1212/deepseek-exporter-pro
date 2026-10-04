import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const content = readFileSync('dist/content/index.js', 'utf8');
const opts = readFileSync('dist/options/options.js', 'utf8');
const manifest = JSON.parse(readFileSync('dist/manifest.json', 'utf8'));

// 只用 includes，避免 shell 转义把正则里的反斜杠搞坏。
// 注意：产物里中文已被 --charset=ascii 转义成 \uXXXX，所以中文字面量只能在**源码**里找。
const probes = {
  '版本 1.1.3': manifest.version === '1.1.3',
  '产物里含 data URL 分支': content.includes('data:image'),
  '产物里含短标签函数': content.includes('shortSrcLabel'),
  '图片深度扫描仍在': content.includes('collectImageAssetsFromMessage'),
  'DOM 兜底仍在': content.includes('supplementImagesFromDom'),
  '正文内联改写仍在': content.includes('rewriteInlineImagePaths'),
  '设置页含授权目录子目录': opts.includes('dirSubfolder'),
  '设置页含 AI 归类': opts.includes('aiSubjects') || opts.includes('aiBaseUrl')
};

let bad = 0;
for (const [k, v] of Object.entries(probes)) {
  if (!v) bad++;
  console.log(`  ${v ? '✓' : '✗'} ${k}`);
}

// 逐个确认关键源码行确实存在（直接读源码，不经过 shell，也不受 ascii 转义影响）
const srcFiles = {
  'src/content/exportRunner.js': ['/^data:image', 'inlineUrlToPath', 'dirSubfolder'],
  'src/adapters/deepseek.js': ['supplementImagesFromDom', 'collectImageAssetsFromMessage', 'describeImageShape'],
  'src/core/md2docx.js': ['shortSrcLabel', '内联图片（data URL，未能嵌入）'],
  'src/core/exporter.js': ['rewriteInlineImagePaths', 'extractMarkdownImageUrls', 'inlineImagePathMap'],
  'src/adapters/deepseek.api.js': ['IMAGE_URL_EXCLUDE', 'describeImageShape']
};
for (const [file, needles] of Object.entries(srcFiles)) {
  const text = readFileSync(file, 'utf8');
  for (const n of needles) {
    const ok = text.includes(n);
    if (!ok) bad++;
    console.log(`  ${ok ? '✓' : '✗'} ${file} 含 ${n}`);
  }
}

console.log('\n交付物:');
for (const n of readdirSync('../deliverables')) {
  const p = join('../deliverables', n);
  if (statSync(p).isFile()) console.log(`  ${(statSync(p).size / 1024).toFixed(1).padStart(8)} KB  ${n}`);
}

console.log(bad === 0 ? '\n全部通过 ✓' : `\n有 ${bad} 项未通过 ✗`);
