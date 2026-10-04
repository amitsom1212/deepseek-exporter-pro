/**
 * 面板 UI 交互测试（jsdom）
 *
 * 面板是用户的主界面，逻辑量最大（勾选、逐条覆盖、批量列表、导出触发）。
 * 这里用假的适配器 + chrome 桩把面板真正跑起来，验证交互链路：
 *   打开面板 → 渲染消息列表 → 全局勾选 → 逐条覆盖 → 触发导出 → 落盘调用
 *
 * 用法：node tools/uitest.mjs
 *
 * @file tools/uitest.mjs
 */

import { JSDOM } from 'jsdom';

let pass = 0;
let fail = 0;
const failures = [];

function check(name, cond, detail = '') {
  if (cond) {
    pass++;
    console.log(`  ✅ ${name}`);
  } else {
    fail++;
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}
const section = t => console.log(`\n== ${t} ==`);
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ------------------------------------------------------------------ */
/*                            环境装配                                  */
/* ------------------------------------------------------------------ */

const dom = new JSDOM('<!DOCTYPE html><html><head><title>UI 测试会话</title></head><body><div id="composer"></div></body></html>', {
  url: 'https://chat.deepseek.com/a/chat/s/ui-test-1',
  pretendToBeVisual: true
});
const w = dom.window;
globalThis.window = w;
globalThis.document = w.document;
globalThis.location = w.location;
globalThis.Node = w.Node;
globalThis.Element = w.Element;
globalThis.HTMLElement = w.HTMLElement;
globalThis.Event = w.Event;
globalThis.MouseEvent = w.MouseEvent;
globalThis.localStorage = w.localStorage;
globalThis.getComputedStyle = w.getComputedStyle.bind(w);
globalThis.requestAnimationFrame = cb => setTimeout(() => cb(Date.now()), 0);
globalThis.cancelAnimationFrame = id => clearTimeout(id);
globalThis.FileReader = w.FileReader;
globalThis.Blob = w.Blob;
globalThis.URL = w.URL;
globalThis.alert = () => {};
// 有些断言会做剪贴板操作，补一个最小实现
w.navigator.clipboard = { writeText: async () => {} };

const saved = [];
globalThis.chrome = {
  runtime: {
    getManifest: () => ({ version: '1.0.0-uitest' }),
    lastError: null,
    onMessage: { addListener: () => {} },
    sendMessage: (msg, cb) => {
      if (msg && msg.type === 'DSX_SAVE_FILES') {
        saved.push(...(msg.files || []));
        if (cb) cb({ ok: true, saved: (msg.files || []).length, total: (msg.files || []).length, results: [] });
        return;
      }
      if (msg && msg.type === 'DSX_DIR_STATUS') { if (cb) cb({ ok: true, granted: false, name: '' }); return; }
      if (cb) cb({ ok: true });
    },
    onInstalled: { addListener: () => {} }
  },
  storage: {
    local: { get: async () => ({}), set: async () => {}, remove: async () => {} },
    onChanged: { addListener: () => {}, removeListener: () => {} }
  }
};

const { createTurn, createImage, ROLE, SLOTS } = await import('../src/core/model.js');

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';

const fakeTurns = [
  createTurn({
    index: 0, role: ROLE.USER, id: 'u1',
    question: '这是用户的第一个问题',
    images: [createImage({ id: 'img1', src: PNG, alt: '上传图', slot: SLOTS.QUESTION })]
  }),
  createTurn({
    index: 1, role: ROLE.ASSISTANT, id: 'a1',
    thinking: '这是深度思考的过程',
    answer: '这是最终回答，含公式 $\\frac{a}{b}$'
  }),
  createTurn({ index: 2, role: ROLE.USER, id: 'u2', question: '第二个问题' }),
  createTurn({ index: 3, role: ROLE.ASSISTANT, id: 'a2', answer: '第二个回答' })
];

let collectCalls = 0;
const fakeAdapter = {
  id: 'fake',
  label: '测试站点',
  siteLabel: 'chat.deepseek.com',
  lastSource: 'api',
  lastError: '',
  pendingSessionId: '',
  match: () => true,
  isGenerating: () => false,
  getTitle: () => 'UI 测试会话',
  getSessionId: () => 'ui-test-1',
  resolveUiAnchor: () => {
    const root = document.getElementById('composer');
    return { root, before: null };
  },
  async collectTurns() {
    collectCalls++;
    return fakeTurns.map(t => ({ ...t, images: (t.images || []).map(i => ({ ...i })) }));
  },
  async listSessions() {
    return [
      { id: 's1', title: '会话一', active: true },
      { id: 's2', title: '会话二', active: false },
      { id: 's3', title: '会话三', active: false }
    ];
  },
  async openSession() { return true; }
};

/* ------------------------------------------------------------------ */
/*                              测试                                    */
/* ------------------------------------------------------------------ */

/** 等待条件成立 */
async function waitFor(fn, timeout = 5000, label = '') {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try {
      if (fn()) return true;
    } catch (e) { /* 继续等 */ }
    await sleep(40);
  }
  console.log(`  （等待超时：${label}）`);
  return false;
}

const { createPanelController } = await import('../src/content/panel.js');

section('启动按钮');
const controller = createPanelController({ adapter: fakeAdapter });
controller.createLauncher();
await waitFor(() => controller.hasLauncher(), 2000, '按钮宿主');

// 启动按钮优先插入站点输入框；jsdom 里 getBoundingClientRect 全是 0，
// 会走「悬浮降级」分支落进插件自己的 Shadow Root —— 两条路都算成功
const launcherHost = document.getElementById('dsx-launcher-host')
  || (document.getElementById('dsx-panel-host') || {}).shadowRoot?.getElementById('dsx-launcher-host');
check('创建了启动按钮宿主', !!launcherHost);
check('宿主已插入页面（站点区域或插件 Shadow 中）', !!(launcherHost && launcherHost.isConnected));
check('按钮使用独立 Shadow Root（样式不被站点影响）', !!(launcherHost && launcherHost.shadowRoot));
check('Shadow 里渲染出按钮', !!(launcherHost && launcherHost.shadowRoot.querySelector('.dsx-launcher')));
check('controller 能正确报告按钮存在（轮询不会误判）', controller.hasLauncher() === true);

section('打开面板');
await controller.show();
const panelHost = document.getElementById('dsx-panel-host');
check('创建了面板宿主', !!panelHost);
const root = panelHost && panelHost.shadowRoot;
check('面板渲染出来了', !!root && !!root.querySelector('.dsx-panel'));
await waitFor(() => root && root.querySelector('.dsx-panel').classList.contains('dsx-open'), 2000, '面板滑入');
check('面板处于打开状态', root.querySelector('.dsx-panel').classList.contains('dsx-open'));
check('面板标题正确', root.querySelector('.dsx-head-title').textContent.includes('导出'));
check('调用了适配器抽取对话', collectCalls >= 1, `collectCalls=${collectCalls}`);

await waitFor(() => root.querySelectorAll('.dsx-msg').length > 0, 3000, '消息列表渲染');
const msgRows = () => root.querySelectorAll('.dsx-msg');
check('消息列表渲染出 4 条', msgRows().length === 4, `实际 ${msgRows().length}`);
check('显示了数据来源提示', !![...root.querySelectorAll('.dsx-hint')].find(e => e.textContent.includes('站点接口')));

section('全局勾选');
const chipByText = (scope, text) => [...scope.querySelectorAll('.dsx-chip')].find(c => c.textContent.includes(text));
const slotChips = () => [...root.querySelectorAll('.dsx-chip')].filter(c => /提问|思考|回答|图片/.test(c.textContent));
check('渲染出 4 个内容勾选项', slotChips().length >= 4, `实际 ${slotChips().length}`);
check('默认全部勾选（默认设置 allSlots）', slotChips().slice(0, 4).every(c => c.classList.contains('dsx-on')),
  JSON.stringify(slotChips().slice(0, 4).map(c => [c.textContent, c.classList.contains('dsx-on')])));
check('勾选项上显示了内容条数', slotChips()[0].textContent.match(/\d/), slotChips()[0].textContent);

// 点掉「思考」
chipByText(root, '思考').click();
await sleep(60);
check('点掉思考后该项变为未勾选', !slotChips().slice(0, 4).find(c => c.textContent.includes('思考')).classList.contains('dsx-on'));

// 点回来
chipByText(root, '思考').click();
await sleep(60);
check('再点一下恢复勾选', slotChips().slice(0, 4).find(c => c.textContent.includes('思考')).classList.contains('dsx-on'));

section('逐条覆盖');
// 展开第一条 AI 回答（用户消息没有「思考」，所以用 assistant 那条验证）
const assistantRow = msgRows()[1];
assistantRow.querySelector('.dsx-msg-head').click();
await sleep(80);
check('点击消息行后展开', root.querySelectorAll('.dsx-msg-body').length === 1,
  `展开数 ${root.querySelectorAll('.dsx-msg-body').length}`);
const miniChips = [...root.querySelectorAll('.dsx-msg-body .dsx-chip')];
check('AI 消息展开后出现「思考 / 回答」两项', miniChips.length === 2,
  miniChips.map(c => c.textContent).join(' | '));
check('逐条勾选项反映全局状态（思考=已勾）',
  !!miniChips.find(c => c.textContent.includes('思考'))?.classList.contains('dsx-on'),
  miniChips.map(c => [c.textContent, c.classList.contains('dsx-on')]).flat().join(' '));

// 单独把这条的「思考」关掉
miniChips.find(c => c.textContent.includes('思考')).click();
await sleep(80);
check('逐条覆盖后出现「已单独设置」提示',
  [...root.querySelectorAll('.dsx-count, .dsx-hint')].some(e => e.textContent.includes('单独设置')),
  [...root.querySelectorAll('.dsx-count, .dsx-hint')].map(e => e.textContent).join(' | '));
check('覆盖后该项变为未勾选',
  ![...root.querySelectorAll('.dsx-msg-body .dsx-chip')].find(c => c.textContent.includes('思考')).classList.contains('dsx-on'));

// 用户消息行不应出现「思考/回答」
msgRows()[0].querySelector('.dsx-msg-head').click();
await sleep(80);
const userRowBody = msgRows()[0].querySelector('.dsx-msg-body');
const userMini = userRowBody ? userRowBody.querySelectorAll('.dsx-chip') : [];
check('用户消息只显示「提问 / 图片」，不显示思考回答',
  userMini.length === 2 && [...userMini].every(c => /提问|图片/.test(c.textContent)),
  [...userMini].map(c => c.textContent).join(' | '));
msgRows()[0].querySelector('.dsx-msg-head').click();
await sleep(80);

// 恢复跟随全局
[...root.querySelectorAll('.dsx-btn')].find(b => b.textContent.includes('恢复跟随全局')).click();
await sleep(80);
check('可以恢复跟随全局',
  ![...root.querySelectorAll('.dsx-count, .dsx-hint')].some(e => e.textContent.includes('单独设置')));

section('工具按钮');
const btn = text => [...root.querySelectorAll('.dsx-btn')].find(b => b.textContent.trim() === text);
btn('全不选').click();
await sleep(80);
check('全不选后所有行都是取消状态',
  [...msgRows()].every(r => r.classList.contains('dsx-off')),
  JSON.stringify([...msgRows()].map(r => r.classList.contains('dsx-off'))));
check('全不选后导出按钮被禁用', !!btn('导出') && btn('导出').disabled);
btn('全选').click();
await sleep(80);
check('全选后恢复', [...msgRows()].every(r => !r.classList.contains('dsx-off')));

section('导出（单条模式）');
saved.length = 0;
btn('导出').click();
const exported = await waitFor(() => saved.length > 0, 15000, '落盘调用');
check('点击导出触发了落盘', exported && saved.length > 0, `saved=${saved.length}`);
const paths = saved.map(f => f.path);
check('落在「DeepSeek导出/单条」下', paths.every(p => p.startsWith('DeepSeek导出/单条/')), JSON.stringify(paths));
check('默认格式为 Markdown', paths.some(p => p.endsWith('.md')), JSON.stringify(paths));
check('默认图片被导出为 png', paths.some(p => p.includes('/images/') && p.endsWith('.png')), JSON.stringify(paths));
const md = saved.find(f => f.path.endsWith('.md'));
if (md) {
  const text = Buffer.from(md.dataUrl.split(',')[1] || '', 'base64').toString('utf8');
  check('markdown 含提问', text.includes('这是用户的第一个问题'));
  check('markdown 含思考块', text.includes('[!思考]'));
  check('markdown 含回答与公式', text.includes('这是最终回答') && text.includes('$\\frac{a}{b}$'));
}
check('导出后界面给出结果反馈', !!root.querySelector('.dsx-pathbox'));

section('切换格式后导出 Word');
saved.length = 0;
// 打开 Word 格式
const fmtChip = [...root.querySelectorAll('.dsx-chip')].find(c => c.textContent.includes('Word'));
check('存在 Word 格式选项', !!fmtChip);
if (fmtChip) {
  fmtChip.click();
  await sleep(80);
  btn('导出').click();
  await waitFor(() => saved.some(f => f.path.endsWith('.docx')), 20000, 'docx 落盘');
  const docx = saved.find(f => f.path.endsWith('.docx'));
  check('导出了 docx', !!docx, JSON.stringify(saved.map(f => f.path)));
  if (docx) {
    const head = Buffer.from((docx.dataUrl.split(',')[1] || '').slice(0, 8), 'base64');
    check('docx 是合法 ZIP', head[0] === 0x50 && head[1] === 0x4b);
  }
}

section('批量导出标签页');
[...root.querySelectorAll('.dsx-tab')].find(t => t.textContent.includes('批量')).click();
await waitFor(() => root.querySelectorAll('.dsx-sess').length > 0, 8000, '批量列表');
check('批量页渲染出 3 个会话', root.querySelectorAll('.dsx-sess').length === 3,
  `实际 ${root.querySelectorAll('.dsx-sess').length}`);
check('批量页显示目标文件夹', !!root.querySelector('.dsx-pathbox'));
check('批量页默认全选', [...root.querySelectorAll('.dsx-sess .dsx-check')].every(c => c.checked));
const sessChecks = () => [...root.querySelectorAll('.dsx-sess .dsx-check')];
sessChecks()[1].click();
await sleep(80);
check('可以取消勾选某个会话', !sessChecks()[1].checked);
check('底部显示将导出的数量', [...root.querySelectorAll('.dsx-foot *')].some(e => e.textContent.includes('2 个')),
  [...root.querySelectorAll('.dsx-foot *')].map(e => e.textContent).join(' | '));

section('关闭与清理');
controller.close();
await sleep(260);
check('关闭后面板收起', !document.getElementById('dsx-panel-host').shadowRoot.querySelector('.dsx-panel').classList.contains('dsx-open'));
controller.destroy();
await sleep(320);
check('销毁后宿主被移除', !document.getElementById('dsx-panel-host') && !document.getElementById('dsx-launcher-host'));

/* ------------------------------------------------------------------ */
console.log(`\n${'='.repeat(56)}`);
console.log(`UI 测试结果：通过 ${pass}，失败 ${fail}`);
if (fail) {
  console.log('失败项：');
  failures.forEach(f => console.log(`  - ${f}`));
  process.exit(1);
}
console.log('全部通过 ✅');
