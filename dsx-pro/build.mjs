/**
 * 构建脚本
 *
 * 为什么用 esbuild 的命令行而不是它的 Node API：
 * 本沙箱环境禁止 Node 以管道方式 spawn 子进程（EPERM），而 esbuild 的 JS API
 * 正是靠管道和平台二进制通信。命令行 + stdio: 'inherit' 不受此限制，
 * 在没有该限制的普通机器上同样工作。
 *
 * 产物：
 *   dist/                        可直接「加载已解压的扩展程序」的 MV3 扩展
 *   deliverables/md2docx/        独立版 markdown→docx（库 + 离线单文件网页）
 *   deliverables/*.zip           打包好的分发文件
 *
 * @file build.mjs
 */

import { spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, rmSync, cpSync, readFileSync, writeFileSync, statSync, readdirSync
} from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const SRC = join(ROOT, 'src');
const DIST = join(ROOT, 'dist');
const DELIV = join(ROOT, '..', 'deliverables');
const MD2DOCX_OUT = join(DELIV, 'md2docx');

const args = process.argv.slice(2);
const only = (args.find(a => a.startsWith('--only=')) || '').split('=')[1] || 'all';

const VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;

/* ------------------------------------------------------------------ */
/*                          工具函数                                    */
/* ------------------------------------------------------------------ */

function log(...a) {
  console.log('[build]', ...a);
}

/** 找到 esbuild 平台二进制 */
function findEsbuild() {
  const plat = process.platform;
  const arch = process.arch;
  const candidates = [
    join(ROOT, 'node_modules', '@esbuild', `${plat}-${arch}`, plat === 'win32' ? 'esbuild.exe' : 'bin/esbuild'),
    join(ROOT, 'node_modules', 'esbuild', 'bin', 'esbuild'),
    join(ROOT, 'node_modules', '.bin', plat === 'win32' ? 'esbuild.cmd' : 'esbuild')
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  throw new Error('找不到 esbuild，请先运行 npm install --ignore-scripts');
}

const ESBUILD = findEsbuild();

function esbuild(buildArgs) {
  log('esbuild', buildArgs.filter(a => !a.startsWith('--outfile')).join(' '), '→', buildArgs.find(a => a.startsWith('--outfile')) || '');
  const res = spawnSync(ESBUILD, buildArgs, {
    cwd: ROOT,
    stdio: 'inherit',
    shell: false
  });
  if (res.error) {
    throw new Error(`无法启动 esbuild：${res.error.message}`);
  }
  if (res.status !== 0) {
    throw new Error(`esbuild 退出码 ${res.status}`);
  }
}

/**
 * 构建公共参数
 *
 * --charset=ascii 是**必须的**，不是美化选项：
 * Chrome 对内容脚本的编码校验比标准 UTF-8 更严，除了拒绝代理对与过长编码，
 * 还额外拒绝 U+FFFE / U+FFFF 这两个「非字符」。而 marked 的词法表里就把
 * U+FFFF 当作字符类范围端点直接内嵌在字符串里（`[\uE000-\uFFFF]` 写成了字面量），
 * 原样输出会让 Chrome 报「content/index.js 不是 UTF-8 编码格式」并拒绝加载整个扩展。
 * 转义成 \uFFFF 后运行时行为完全一致，输出则退化成纯 ASCII。
 */
const COMMON = [
  '--bundle',
  '--platform=browser',
  '--target=chrome109',
  '--charset=ascii',
  '--log-level=warning',
  '--legal-comments=eof',
  '--define:process.env.NODE_ENV="production"',
  '--define:global=globalThis'
];

function cp(from, to) {
  mkdirSync(dirname(to), { recursive: true });
  cpSync(from, to, { recursive: true });
  log('复制', relative(ROOT, from), '→', relative(ROOT, to));
}

function ensureDir(d) {
  mkdirSync(d, { recursive: true });
}

function clean(d) {
  if (existsSync(d)) rmSync(d, { recursive: true, force: true });
  ensureDir(d);
}

function listFiles(dir, base = dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) listFiles(p, base, out);
    else out.push(relative(base, p).replace(/\\/g, '/'));
  }
  return out;
}

function human(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)}MB`;
}

/* ------------------------------------------------------------------ */
/*                     产物编码校验（Chrome 兼容）                      */
/* ------------------------------------------------------------------ */

/**
 * Chrome 的 UTF-8 校验（base::IsStringUTF8 / utf8_validator）比标准解码更严：
 * 除代理对与过长编码外，还拒绝 U+FFFE / U+FFFF 与超出 U+10FFFF 的码位。
 * 一旦命中，Chrome 会拒绝加载内容脚本并让整个扩展装不上，所以必须在构建期拦住。
 *
 * @param {string} dir
 * @returns {Array<{file:string, offset:number, cp:string}>}
 */
function findChromeUnsafeChars(dir) {
  const bad = [];
  for (const rel of listFiles(dir)) {
    if (!/\.(js|mjs|css|html|json)$/i.test(rel)) continue;
    const text = readFileSync(join(dir, rel), 'utf8');
    for (let i = 0; i < text.length; i++) {
      const cp = text.codePointAt(i);
      if (cp === 0xfffe || cp === 0xffff || cp > 0x10ffff) {
        bad.push({ file: rel, offset: i, cp: `U+${cp.toString(16).toUpperCase()}` });
        break; // 每个文件报一处就够定位了
      }
    }
  }
  return bad;
}

function assertChromeSafe(dir, label) {
  const bad = findChromeUnsafeChars(dir);
  if (bad.length === 0) {
    log(`${label} 编码校验通过（无 Chrome 拒绝的字符）`);
    return;
  }
  console.error(`\n[build] ✗ ${label} 含 Chrome 会拒绝的字符，扩展将无法加载：`);
  for (const b of bad) console.error(`   ${b.file} 偏移 ${b.offset}: ${b.cp}`);
  console.error('   提示：确认 esbuild 参数里有 --charset=ascii；若字符出现在注释里则需改源文件。\n');
  throw new Error(`${label} 编码校验失败`);
}

/**
 * 校验扩展目录里没有 Chrome 保留的文件名。
 *
 * Chrome 规定：以 "_" 开头的文件/目录名是系统保留的，出现就会直接拒绝加载整个扩展
 * （报 "Cannot load extension with file or directory name _xxx. Filenames starting
 * with '_' are reserved for use by the system."）。用户如果误把源码目录当扩展加载，
 * 光是 node_modules 里的 _stream_duplex.js 之类就会触发；构建产物里出现更要拦住。
 */
const RESERVED_OK = new Set(['_locales', '_metadata']);
function assertNoReservedNames(dir, label) {
  const bad = [];
  const walk = (d, base) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (name.startsWith('_') && !RESERVED_OK.has(name)) {
        bad.push(relative(base, p).replace(/\\/g, '/'));
      }
      if (statSync(p).isDirectory()) walk(p, base);
    }
  };
  walk(dir, dir);
  if (bad.length === 0) {
    log(`${label} 文件名校验通过（无 Chrome 保留名）`);
    return;
  }
  console.error(`\n[build] ✗ ${label} 含 Chrome 保留的文件名（下划线开头），扩展将无法加载：`);
  bad.slice(0, 10).forEach(f => console.error(`   ${f}`));
  console.error('   Chrome 保留所有以 "_" 开头的名字（_locales / _metadata 除外）。\n');
  throw new Error(`${label} 文件名校验失败`);
}

/** 在产物里放一份安装说明，避免用户去加载源码目录 */
function writeInstallNote(dir) {
  const text = [
    '这就是要加载的扩展目录（里面直接有 manifest.json）。',
    '',
    '安装步骤：',
    '1. 打开 chrome://extensions/ （Edge 是 edge://extensions/）',
    '2. 打开右上角「开发者模式」',
    '3. 点「加载已解压的扩展程序」，选择【本文件夹】',
    '',
    '注意：',
    '- 不要选择本文件夹的上级目录。上级目录是源码工程，里面有 node_modules，',
    '  其中存在 _stream_duplex.js 这类以下划线开头的文件；Chrome 把 "_" 开头的',
    '  名字视为系统保留，会直接拒绝加载整个扩展。',
    '- 每次重新构建后，请在扩展页点一下刷新按钮以重新加载。',
    '',
    'DeepSeek 对话导出 Pro · 详见同目录上级的 README.md'
  ].join('\n');
  writeFileSync(join(dir, '如何安装.txt'), text, 'utf8');
}

/* ------------------------------------------------------------------ */
/*                            图标                                      */
/* ------------------------------------------------------------------ */

function buildIcons() {
  const need = [16, 32, 48, 128].some(s => !existsSync(join(SRC, 'icons', `icon${s}.png`)));
  if (!need) {
    log('图标已存在，跳过生成');
    return;
  }
  const res = spawnSync(process.execPath, [join(ROOT, 'tools', 'make-icons.mjs')], {
    cwd: ROOT,
    stdio: 'inherit'
  });
  if (res.status !== 0) throw new Error('图标生成失败');
}

/* ------------------------------------------------------------------ */
/*                          扩展构建                                    */
/* ------------------------------------------------------------------ */

function buildExtension() {
  log('===== 构建扩展 =====');
  clean(DIST);

  // 内容脚本：必须是 IIFE（MV3 内容脚本不支持 ESM）
  esbuild([
    ...COMMON,
    join(SRC, 'content', 'index.js'),
    '--format=iife',
    `--outfile=${join(DIST, 'content', 'index.js')}`
  ]);

  // 后台 Service Worker：ESM
  esbuild([
    ...COMMON,
    join(SRC, 'background', 'index.js'),
    '--format=esm',
    `--outfile=${join(DIST, 'background', 'index.js')}`
  ]);

  // offscreen / options / popup 都是普通扩展页面，用 ESM
  for (const [entry, out] of [
    [['offscreen', 'offscreen.js'], ['offscreen', 'offscreen.js']],
    [['options', 'options.js'], ['options', 'options.js']],
    [['popup', 'popup.js'], ['popup', 'popup.js']]
  ]) {
    esbuild([
      ...COMMON,
      join(SRC, ...entry),
      '--format=esm',
      `--outfile=${join(DIST, ...out)}`
    ]);
  }

  // 静态资源
  cp(join(SRC, 'manifest.json'), join(DIST, 'manifest.json'));
  cp(join(SRC, 'icons'), join(DIST, 'icons'));
  for (const f of ['options/index.html', 'options/options.css', 'popup/index.html', 'popup/popup.css', 'offscreen/offscreen.html']) {
    cp(join(SRC, f), join(DIST, f));
  }

  // 装不上扩展是最难排查的故障，所以在这里就拦住
  writeInstallNote(DIST);
  assertNoReservedNames(DIST, '扩展 dist');
  assertChromeSafe(DIST, '扩展 dist');
  report(DIST, '扩展 dist');
}

/* ------------------------------------------------------------------ */
/*                    独立版 markdown → docx                            */
/* ------------------------------------------------------------------ */

function buildMd2Docx() {
  log('===== 构建独立 md→docx 转换器 =====');
  clean(MD2DOCX_OUT);

  const entry = join(ROOT, 'tools', 'md2docx', 'entry.js');

  // ESM 版（给打包工具 / module 脚本用）
  esbuild([
    ...COMMON,
    entry,
    '--format=esm',
    `--outfile=${join(MD2DOCX_OUT, 'md2docx.mjs')}`
  ]);

  // IIFE 版（给 <script> 直接引入，全局 MdToDocx）
  esbuild([
    ...COMMON,
    entry,
    '--format=iife',
    '--global-name=MdToDocx',
    `--outfile=${join(MD2DOCX_OUT, 'md2docx.js')}`
  ]);

  // 离线单文件网页：把 IIFE 内联进 HTML，双击即可用
  const html = readFileSync(join(ROOT, 'tools', 'md2docx', 'standalone.html'), 'utf8');
  const bundle = readFileSync(join(MD2DOCX_OUT, 'md2docx.js'), 'utf8');
  const inlined = html.replace('/*__DSX_BUNDLE__*/', () => bundle.replace(/<\/script>/gi, '<\\/script>'));
  writeFileSync(join(MD2DOCX_OUT, 'index.html'), inlined, 'utf8');
  writeFileSync(join(DELIV, 'Markdown转Word-离线单文件.html'), inlined, 'utf8');
  log('生成离线单文件网页 index.html');

  writeFileSync(join(MD2DOCX_OUT, '使用说明.md'), md2docxReadme(), 'utf8');
  assertChromeSafe(MD2DOCX_OUT, 'md2docx');
  report(MD2DOCX_OUT, 'md2docx');
}

function md2docxReadme() {
  return `# Markdown → Word (.docx) 转换器（独立版）

本目录是 **DeepSeek 对话导出 Pro** 里那套 markdown→docx 能力的单独打包，
不依赖浏览器扩展，可离线使用。数学公式会转成 **Word 原生公式（可编辑）**，
支持分数、根式、上下标、求和/积分（含上下限）、矩阵、对齐环境、希腊字母、重音等。

## 三种用法

### 1. 双击网页（最省事）
直接打开 \`index.html\`（或上一层的 \`Markdown转Word-离线单文件.html\`）：
粘贴 Markdown → 点「转换并下载 .docx」。完全离线，不联网、不上传。

### 2. 脚本里用 ESM
\`\`\`js
import { mdToDocx, mdToDocxBuffer, downloadDocx } from './md2docx.mjs';

// 得到 Blob
const blob = await mdToDocx('# 标题\\n\\n公式 $E=mc^2$');

// 或直接触发浏览器下载
await downloadDocx(markdownText, '我的文档.docx');

// 或拿二进制
const bytes = await mdToDocxBuffer(markdownText);
\`\`\`

### 3. 网页里用 <script>
\`\`\`html
<script src="md2docx.js"></script>
<script>
  MdToDocx.downloadDocx('# 标题\\n\\n$\\frac{a}{b}$', 'demo.docx');
</script>
\`\`\`

## 可用选项

\`\`\`js
mdToDocx(markdown, {
  title: '文档标题',        // 写入 docx 属性
  baseSize: 21,            // 正文字号（半点，21 = 10.5pt 五号）
  imageMaxWidth: 620,      // 图片最大宽度（px）
  resolveImage: (src) => ({ data: uint8array, type: 'png', width: 400, height: 300 })
});
\`\`\`

\`resolveImage\` 用于把 Markdown 里的图片地址换成真实字节；不给的话，
图片会降级成 \`[图片：alt]\` 文字，不会让转换失败。

## 文件说明

| 文件 | 说明 |
| --- | --- |
| \`index.html\` | 离线单文件网页（转换器已内联） |
| \`md2docx.js\` | 浏览器 IIFE 版（全局 \`MdToDocx\`） |
| \`md2docx.mjs\` | ESM 版，供打包器 / Node 使用 |
| \`使用说明.md\` | 本文件 |

## 依赖与许可

打包内已包含 [docx](https://github.com/dolanmiu/docx)（MIT）、
[KaTeX](https://katex.org/)（MIT）、[marked](https://github.com/markedjs/marked)（MIT）、
[fast-xml-parser](https://github.com/NaturalIntelligence/fast-xml-parser)（MIT）。
构建版本：v${VERSION}
`;
}

/* ------------------------------------------------------------------ */
/*                            打包 zip                                  */
/* ------------------------------------------------------------------ */

async function zip(srcDir, outZip, rootInZip = '') {
  let JSZip;
  try {
    JSZip = (await import('jszip')).default;
  } catch (e) {
    log(`跳过打包（未安装 jszip）：${outZip}`);
    return null;
  }
  const zipFile = new JSZip();
  for (const rel of listFiles(srcDir)) {
    const buf = readFileSync(join(srcDir, rel));
    zipFile.file(rootInZip ? `${rootInZip}/${rel}` : rel, buf);
  }
  const content = await zipFile.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 9 }
  });
  ensureDir(dirname(outZip));
  writeFileSync(outZip, content);
  log(`打包 ${relative(ROOT, outZip)} (${human(content.length)})`);
  return outZip;
}

/* ------------------------------------------------------------------ */
/*                            报告                                      */
/* ------------------------------------------------------------------ */

function report(dir, label) {
  const files = listFiles(dir);
  let total = 0;
  const rows = files.map(f => {
    const size = statSync(join(dir, f)).size;
    total += size;
    return { f, size };
  }).sort((a, b) => b.size - a.size);
  log(`${label}：${files.length} 个文件，共 ${human(total)}`);
  rows.slice(0, 8).forEach(r => log(`   ${String(human(r.size)).padStart(9)}  ${r.f}`));
  if (rows.length > 8) log(`   … 其余 ${rows.length - 8} 个文件`);
}

/* ------------------------------------------------------------------ */
/*                            主流程                                    */
/* ------------------------------------------------------------------ */

(async function main() {
  const t0 = Date.now();
  if (only === 'all' || only === 'ext') {
    buildIcons();
    buildExtension();
  }
  if (only === 'all' || only === 'md2docx') {
    buildMd2Docx();
  }
  if (only === 'all') {
    log('===== 打包分发文件 =====');
    ensureDir(DELIV);
    await zip(DIST, join(DELIV, `deepseek-exporter-pro-v${VERSION}.zip`));
    await zip(MD2DOCX_OUT, join(DELIV, `md2docx-standalone-v${VERSION}.zip`), 'md2docx');
  }
  log(`全部完成，用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
})().catch(err => {
  console.error('[build] 失败：', err.message);
  process.exit(1);
});
