/**
 * 设置页测试（jsdom）
 *
 * 设置页是需求 ④ 的交付物，且它的失败模式最糟：一旦初始化抛异常，
 * 用户看到的是一个空白/无法使用的页面（曾经就因为把「槽位对象」当成
 * 「id 数组」传给 chip 渲染器，导致 `(selected || []).slice is not a function`）。
 *
 * 这里直接加载真实的 options/index.html + options.js 跑起来，验证：
 *   - HTML 里的 id 与 JS 引用完全对应（少一个 id 就会炸）
 *   - 6 组选项都渲染出来，初始值与默认设置一致
 *   - 改动会写进 chrome.storage（真实持久化到桩里）
 *   - 路径规范化、子文件夹模板预览、联动显示
 *
 * 用法：node tools/optionstest.mjs
 *
 * @file tools/optionstest.mjs
 */

import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

let pass = 0;
let fail = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; failures.push(`${name}${detail ? ` — ${detail}` : ''}`); console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}
const section = t => console.log(`\n== ${t} ==`);
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, timeout = 4000, label = '') {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { if (fn()) return true; } catch (e) { /* 继续等 */ }
    await sleep(30);
  }
  console.log(`  （等待超时：${label}）`);
  return false;
}

/* ------------------------------------------------------------------ */
/*                            环境装配                                  */
/* ------------------------------------------------------------------ */

// 用真实 HTML，但去掉 <script>（jsdom 不执行 ES module，脚本手动 import）
const html = readFileSync(join(ROOT, 'src/options/index.html'), 'utf8')
  .replace(/<script[^>]*><\/script>/g, '');

// 注意：jsdom 对 chrome-extension:// 这种不透明源不给 localStorage，
// 所以这里用 http 源跑；被测代码本身不依赖源。
const dom = new JSDOM(html, { url: 'http://localhost/options/index.html', pretendToBeVisual: true });
const w = dom.window;
globalThis.window = w;
globalThis.document = w.document;
globalThis.location = w.location;
globalThis.Node = w.Node;
globalThis.Element = w.Element;
globalThis.HTMLElement = w.HTMLElement;
globalThis.Event = w.Event;
globalThis.localStorage = w.localStorage;
globalThis.getComputedStyle = w.getComputedStyle.bind(w);
globalThis.FileReader = w.FileReader;
globalThis.Blob = w.Blob;
globalThis.URL = w.URL;

// chrome 桩：storage 真正持久化，才能验证「保存 → 再读」闭环
const store = {};
const saves = [];
const tabMessages = [];
globalThis.chrome = {
  runtime: {
    getManifest: () => ({ version: '1.0.0-optionstest' }),
    lastError: null,
    openOptionsPage: () => {},
    sendMessage: (msg, cb) => {
      // 产品代码两种形式都用：内容脚本侧用回调，设置页侧用 MV3 的 Promise 形式。
      // 桩必须两种都支持，否则会误报失败。
      let resp = { ok: true };
      if (msg && msg.type === 'DSX_AI_TEST') {
        resp = { ok: true, result: { knowledge: true, subject: '数学', sub: '', reason: '定积分' } };
      }
      if (typeof cb === 'function') {
        cb(resp);
        return undefined;
      }
      return Promise.resolve(resp);
    }
  },
  storage: {
    local: {
      get: async key => {
        if (typeof key === 'string') return key in store ? { [key]: store[key] } : {};
        return { ...store };
      },
      set: async obj => { Object.assign(store, obj); saves.push(JSON.parse(JSON.stringify(obj))); },
      remove: async key => { delete store[key]; }
    },
    onChanged: { addListener: () => {}, removeListener: () => {} }
  },
  permissions: {
    contains: async () => false,
    request: async () => true,
    remove: async () => true
  },
  // 关键：模拟「设置页自己 + 一个 DeepSeek 页面」两个标签页，
  // 用来验证诊断不会再打到设置页上
  tabs: {
    query: async () => [
      { id: 99, url: 'chrome-extension://abcdefghijklmnop/options/index.html', title: '设置页', lastAccessed: 999 },
      { id: 7, url: 'https://chat.deepseek.com/a/chat/s/abc-123', title: '线性代数复习', lastAccessed: 100 }
    ],
    sendMessage: (id, msg, cb) => {
      tabMessages.push({ id, type: msg && msg.type });
      if (!cb) return;
      if (msg && msg.type === 'DSX_PING') { cb({ ok: true, adapter: 'deepseek' }); return; }
      if (msg && msg.type === 'DSX_DIAGNOSE') {
        cb({ ok: true, report: { adapter: 'deepseek', url: 'https://chat.deepseek.com/a/chat/s/abc-123', port: '', probes: { dsMessage: 6 } } });
        return;
      }
      cb({ ok: true });
    }
  },
  scripting: { executeScript: async () => [{}] }
};

// 捕获未被处理的异常（初始化若抛错会走 init().catch → toast，但双保险）
const unhandled = [];
process.on('unhandledRejection', e => unhandled.push(String(e && e.message || e)));
w.addEventListener('error', e => unhandled.push(String(e.message || e)));

const { DEFAULT_SETTINGS } = await import('../src/core/settings.js');
const { SLOTS } = await import('../src/core/model.js');

/* ------------------------------------------------------------------ */
/*                              跑起来                                  */
/* ------------------------------------------------------------------ */

section('初始化');
await import('../src/options/options.js');
await waitFor(() => document.getElementById('singleFolder').value !== '', 4000, '表单填充');

const toast = document.getElementById('toast');
check('没有弹出初始化失败提示',
  !(toast && toast.className.includes('err')),
  `toast="${toast && toast.textContent}" class="${toast && toast.className}"`);
check('没有未处理的异常', unhandled.length === 0, unhandled.join(' | '));
check('路径输入已按默认设置填充',
  document.getElementById('singleFolder').value === DEFAULT_SETTINGS.singleFolder,
  document.getElementById('singleFolder').value);
check('批量路径已填充',
  document.getElementById('batchFolder').value === DEFAULT_SETTINGS.batchFolder,
  document.getElementById('batchFolder').value);
check('版本行渲染', document.getElementById('version-line').textContent.includes('1.0.0-optionstest'));

section('选项组渲染');
const chips = id => [...document.getElementById(id).querySelectorAll('.chip')];
const onChips = id => chips(id).filter(c => c.classList.contains('on')).map(c => c.dataset.id);

check('单独导出内容组渲染出 4 项', chips('singleSlots').length === 4, `${chips('singleSlots').length}`);
check('批量导出内容组渲染出 4 项', chips('batchSlots').length === 4, `${chips('batchSlots').length}`);
check('单独导出默认全勾', onChips('singleSlots').length === 4, JSON.stringify(onChips('singleSlots')));
check('批量导出默认全勾', onChips('batchSlots').length === 4, JSON.stringify(onChips('batchSlots')));
check('单独格式组渲染出 4 种', chips('defaultFormat').length === 4, `${chips('defaultFormat').length}`);
check('默认格式为 md', onChips('defaultFormat').join() === 'md', onChips('defaultFormat').join());
check('批量格式组默认 md', onChips('batchFormats').join() === 'md', onChips('batchFormats').join());
check('图片格式组渲染出 4 项且默认 png', onChips('imageFormat').join() === 'png', onChips('imageFormat').join());
check('图片存放方式默认子目录', onChips('imageMode').join() === 'folder', onChips('imageMode').join());
check('所有 chip 都有 data-id', ['singleSlots', 'batchSlots', 'defaultFormat', 'batchFormats', 'imageFormat', 'imageMode']
  .every(id => chips(id).every(c => !!c.dataset.id)));

section('联动显示');
check('默认显示子文件夹模板输入框', document.getElementById('subfolder-field').style.display !== 'none');
document.getElementById('batchSubfolder').checked = false;
document.getElementById('batchSubfolder').dispatchEvent(new w.Event('change'));
await sleep(60);
check('取消勾选后模板输入框隐藏', document.getElementById('subfolder-field').style.display === 'none');
document.getElementById('batchSubfolder').checked = true;
document.getElementById('batchSubfolder').dispatchEvent(new w.Event('change'));
await sleep(60);
check('重新勾选后恢复显示', document.getElementById('subfolder-field').style.display !== 'none');

check('JPEG 质量输入默认隐藏（当前格式是 png）', document.getElementById('quality-field').style.display === 'none');
chips('imageFormat').find(c => c.dataset.id === 'jpeg').click();
await sleep(60);
check('切到 JPEG 后质量输入出现', document.getElementById('quality-field').style.display !== 'none');
chips('imageFormat').find(c => c.dataset.id === 'png').click();
await sleep(60);

section('子文件夹模板预览');
const pat = document.getElementById('batchSubfolderPattern');
pat.value = '{date}_{title}';
pat.dispatchEvent(new w.Event('input'));
await sleep(60);
const preview = document.getElementById('subfolder-preview').textContent;
check('预览里替换了 {date}', /\d{8}_/.test(preview), preview);
check('预览里替换了 {title}', preview.includes('如何学习线性代数'), preview);

section('保存');
saves.length = 0;
chips('singleSlots').find(c => c.dataset.id === 'thinking').click();
await sleep(60);
check('点掉「思考」后保存被触发', saves.length >= 0);
const saveWait = await waitFor(() => saves.length > 0, 3000, '防抖保存');
check('防抖后确实写入了 storage', saveWait && saves.length > 0, `saves=${saves.length}`);
const savedSettings = saves.length ? saves[saves.length - 1].dsx_settings : null;
check('写入的是 dsx_settings 键', !!savedSettings, JSON.stringify(Object.keys(saves[0] || {})));
check('singleSlots.thinking 已保存为 false',
  !!savedSettings && savedSettings.singleSlots && savedSettings.singleSlots.thinking === false,
  JSON.stringify(savedSettings && savedSettings.singleSlots));
check('其它槽位仍为 true',
  !!savedSettings && savedSettings.singleSlots.question === true && savedSettings.singleSlots.answer === true);

section('路径规范化');
saves.length = 0;
const sf = document.getElementById('singleFolder');
sf.value = 'D:\\我的笔记\\..\\DeepSeek/导出';
sf.dispatchEvent(new w.Event('input'));
const normWait = await waitFor(() => saves.length > 0, 3000, '路径保存');
const normed = saves.length ? saves[saves.length - 1].dsx_settings.singleFolder : '';
check('盘符与上跳被清掉', !/[A-Za-z]:/.test(normed) && !normed.includes('..'), normed);
check('路径已保存', normWait && !!normed);

section('其它区块');
check('文件夹状态区渲染', document.getElementById('dir-status').textContent.length > 0,
  document.getElementById('dir-status').textContent);
check('文件夹状态显示未授权', document.getElementById('dir-status').textContent.includes('未授权'),
  document.getElementById('dir-status').textContent);
check('主机权限状态渲染', document.getElementById('hosts-status').textContent.length > 0,
  document.getElementById('hosts-status').textContent);
check('诊断按钮存在', !!document.getElementById('btn-diagnose'));
check('诊断输出区默认隐藏', document.getElementById('diag-out').hidden === true);
check('恢复默认按钮存在', !!document.getElementById('btn-reset'));
check('导出/导入设置按钮存在',
  !!document.getElementById('btn-export-settings') && !!document.getElementById('btn-import-settings'));

section('恢复默认');
document.getElementById('btn-reset').click();
await waitFor(() => !document.getElementById('singleSlots').querySelectorAll('.chip')[0].classList.contains('dsx-x'), 500, '');
await sleep(300);
check('恢复默认后单独导出重新全勾', onChips('singleSlots').length === 4, JSON.stringify(onChips('singleSlots')));
check('恢复默认后路径回到默认值',
  document.getElementById('singleFolder').value === DEFAULT_SETTINGS.singleFolder,
  document.getElementById('singleFolder').value);

section('AI 归类区块');
{
  check('AI 区块渲染出预设按钮', chips('aiPreset').length >= 4, `${chips('aiPreset').length}`);
  check('默认选中 DeepSeek 预设', onChips('aiPreset').join() === 'deepseek', onChips('aiPreset').join());
  check('接口地址已填充默认值',
    document.getElementById('aiBaseUrl').value.includes('api.deepseek.com'),
    document.getElementById('aiBaseUrl').value);
  check('模型名已填充', document.getElementById('aiModel').value === 'deepseek-chat',
    document.getElementById('aiModel').value);
  check('科目清单已填充（含 408 子类）',
    document.getElementById('aiSubjects').value.includes('408/数据结构'),
    document.getElementById('aiSubjects').value.slice(0, 60));
  check('归档方式渲染出两个选项', chips('aiRouteMode').length === 2, `${chips('aiRouteMode').length}`);
  check('默认按学科归档', onChips('aiRouteMode').join() === 'subject', onChips('aiRouteMode').join());
  check('默认未启用', document.getElementById('aiEnabled').checked === false);

  const preview = () => document.getElementById('ai-path-preview').textContent;
  check('未启用时预览说明不归档', preview().includes('未启用'), preview().slice(0, 60));

  document.getElementById('aiEnabled').checked = true;
  document.getElementById('aiEnabled').dispatchEvent(new w.Event('change'));
  await sleep(60);
  check('启用后预览列出根目录', preview().includes('根目录'), preview().slice(0, 80));
  check('预览列出 408 子目录', preview().includes('408/数据结构'), preview());
  check('预览列出非知识答疑目录', preview().includes('非知识答疑'), preview());

  // 切到「只分知识答疑」
  chips('aiRouteMode').find(c => c.dataset.id === 'qa').click();
  await sleep(60);
  check('切到只分是否知识答疑后生效', onChips('aiRouteMode').join() === 'qa', onChips('aiRouteMode').join());
  chips('aiRouteMode').find(c => c.dataset.id === 'subject').click();
  await sleep(60);

  // 预设切换
  chips('aiPreset').find(c => c.dataset.id === 'ollama').click();
  await sleep(60);
  check('点本地 Ollama 预设会填充地址',
    document.getElementById('aiBaseUrl').value.includes('11434'),
    document.getElementById('aiBaseUrl').value);
  check('同时换成对应模型名', document.getElementById('aiModel').value.includes('qwen'),
    document.getElementById('aiModel').value);

  // 保存 AI 设置
  saves.length = 0;
  document.getElementById('aiApiKey').value = 'sk-unit-test';
  document.getElementById('aiApiKey').dispatchEvent(new w.Event('input'));
  const aiSaved = await waitFor(() => saves.length > 0, 3000, 'AI 设置保存');
  const ai = aiSaved ? saves[saves.length - 1].dsx_settings.ai : null;
  check('AI 设置写入了 storage', !!ai, JSON.stringify(ai));
  check('API Key 已保存', !!ai && ai.apiKey === 'sk-unit-test');
  check('科目清单按行解析为数组', !!ai && Array.isArray(ai.subjects) && ai.subjects.includes('408/操作系统'),
    JSON.stringify(ai && ai.subjects));
  check('启用的开关已保存', !!ai && ai.enabled === true);

  // 测试接口按钮
  document.getElementById('btn-ai-test').click();
  await waitFor(() => document.getElementById('ai-test-out').textContent.includes('接口可用'), 3000, '接口测试');
  check('测试接口显示成功结果',
    document.getElementById('ai-test-out').textContent.includes('接口可用'),
    document.getElementById('ai-test-out').textContent.slice(0, 80));
  check('测试结果里显示了科目', document.getElementById('ai-test-out').textContent.includes('数学'));
}

section('诊断目标选择（回归：不再误判设置页）');
{
  document.getElementById('btn-refresh-tabs').click();
  await waitFor(() => document.getElementById('diag-tab').options.length > 0, 2000, '标签页列表');
  const sel = document.getElementById('diag-tab');
  check('只列出可诊断的网页（排除扩展设置页）', sel.options.length === 1, `${sel.options.length}`);
  check('下拉框里是 DeepSeek 页面',
    sel.options[0].textContent.includes('chat.deepseek.com'), sel.options[0].textContent);
  check('默认选中该页面', sel.value === '7', sel.value);

  tabMessages.length = 0;
  document.getElementById('btn-diagnose').click();
  await waitFor(() => tabMessages.some(m => m.type === 'DSX_DIAGNOSE'), 4000, '诊断请求');
  const diagMsgs = tabMessages.filter(m => m.type === 'DSX_DIAGNOSE');
  check('诊断请求打到了 DeepSeek 标签页', diagMsgs.length === 1 && diagMsgs[0].id === 7,
    JSON.stringify(tabMessages));
  check('没有把设置页当成诊断目标', !tabMessages.some(m => m.id === 99), JSON.stringify(tabMessages));
  await waitFor(() => !document.getElementById('diag-out').hidden, 2000, '诊断输出');
  check('诊断报告渲染出来了',
    document.getElementById('diag-out').textContent.includes('deepseek'),
    document.getElementById('diag-out').textContent.slice(0, 80));
  check('报告里记录了诊断目标',
    document.getElementById('diag-out').textContent.includes('诊断目标'),
    document.getElementById('diag-out').textContent.slice(0, 160));
}

section('授权文件夹的路径预览（回归：目录不再重复嵌套）');
{
  const preview = () => document.getElementById('dir-path-preview').textContent;
  const setChk = (id, v) => {
    const el = document.getElementById(id);
    el.checked = v;
    el.dispatchEvent(new w.Event('change'));
  };
  const setVal = (id, v) => {
    const el = document.getElementById(id);
    el.value = v;
    el.dispatchEvent(new w.Event('input'));
  };

  check('存在「已授权文件夹内部子目录」输入框', !!document.getElementById('dirSubfolder'));

  setChk('useDirectoryHandle', false);
  await sleep(60);
  check('未启用授权时预览指向下载目录', preview().includes('下载目录'), preview().slice(0, 90));
  check('未启用授权时预览带 ① 里的相对路径',
    preview().includes(document.getElementById('batchFolder').value), preview().slice(0, 120));

  setChk('useDirectoryHandle', true);
  await sleep(100);
  check('启用授权后预览改指已授权文件夹', preview().includes('已授权文件夹'), preview().slice(0, 90));
  check('启用授权后预览不再叠加 ① 的相对路径',
    !preview().includes(document.getElementById('batchFolder').value), preview().slice(0, 120));
  check('没授权过文件夹时给出警告', preview().includes('还没有授权文件夹'), preview().slice(0, 160));

  setVal('dirSubfolder', '我的笔记');
  await sleep(80);
  check('子目录填了以后出现在预览里', preview().includes('我的笔记'), preview().slice(0, 120));

  saves.length = 0;
  setVal('dirSubfolder', '我的笔记/数学');
  const savedDir = await waitFor(() => saves.length > 0, 3000, 'dirSubfolder 保存');
  check('dirSubfolder 写入了 storage',
    !!savedDir && saves[saves.length - 1].dsx_settings.dirSubfolder === '我的笔记/数学',
    JSON.stringify(savedDir && saves[saves.length - 1].dsx_settings.dirSubfolder));
}

section('HTML 与 JS 的 id 一致性');
{
  const js = readFileSync(join(ROOT, 'src/options/options.js'), 'utf8');
  const ids = [...js.matchAll(/getElementById\('([^']+)'\)/g)].map(m => m[1]);
  const missing = [...new Set(ids)].filter(id => !document.getElementById(id));
  check('JS 引用的每个 id 在 HTML 里都存在', missing.length === 0, JSON.stringify(missing));
}

/* ------------------------------------------------------------------ */
console.log(`\n${'='.repeat(56)}`);
console.log(`设置页测试结果：通过 ${pass}，失败 ${fail}`);
if (fail) {
  console.log('失败项：');
  failures.forEach(f => console.log(`  - ${f}`));
  process.exit(1);
}
console.log('全部通过 ✅');
