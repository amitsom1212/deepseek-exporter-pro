/**
 * 内容脚本测试（jsdom）
 *
 * 覆盖这次真实踩到的问题：
 *   1. 页面在扩展加载前就打开了 → 内容脚本不存在 → 任何消息都得到
 *      "Could not establish connection. Receiving end does not exist"
 *      （靠 popup/设置页主动注入解决，这里验证注入后能正常应答）
 *   2. DSH 是 SPA，首屏还没渲染出 data-chat-flow 时不能判定失败
 *      （靠端口 3080 兜底 + 每秒重试识别解决）
 *   3. **未识别站点时消息监听也必须已注册**，否则连诊断都拿不到
 *
 * 一个进程只能跑一个场景（ES module 只执行一次），所以用参数选择场景：
 *   node tools/contenttest.mjs dsh | dsh-empty | none | deepseek
 *
 * @file tools/contenttest.mjs
 */

import { JSDOM } from 'jsdom';

const scenario = process.argv[2] || 'dsh';

let pass = 0;
let fail = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; failures.push(`${name}${detail ? ` — ${detail}` : ''}`); console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}
const section = t => console.log(`\n== ${t} ==`);
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ------------------------------------------------------------------ */
/*                          场景定义                                    */
/* ------------------------------------------------------------------ */

const DSH_SIDEBAR = `<div class="YDXeBa_list" role="tree">
  <div class="YDXeBa_sessionRow YDXeBa_selected" role="treeitem" aria-selected="true">
    <span class="YDXeBa_title">插件调试记录</span>
  </div>
</div><textarea class="composer"></textarea>`;

const DEEPSEEK_DOM = `<div class="ds-scroll-area"><div class="ds-virtual-list__items">
  <div class="ds-message" data-virtual-list-item-key="m1"><div>你好</div></div>
  <div class="ds-message" data-virtual-list-item-key="m2">
    <div class="ds-assistant-message-main-content ds-markdown"><p>你好，有什么可以帮你？</p></div>
  </div>
</div></div>`;

const SCENARIOS = {
  // DSH 已渲染侧边栏，但聊天区还没出来（SPA 首屏真实状态）
  dsh: { url: 'http://127.0.0.1:3080/', body: DSH_SIDEBAR, expectAdapter: 'dsh' },
  // DSH 完全空白（连侧边栏都没有）
  'dsh-empty': { url: 'http://127.0.0.1:3080/', body: '', expectAdapter: 'dsh' },
  // 本地其它端口的普通页面：不该被误判成 DSH
  'localhost-other': { url: 'http://127.0.0.1:5173/', body: '<h1>某个前端 dev server</h1>', expectAdapter: null },
  // 完全无关的站点：不该匹配任何适配器，但监听器必须在
  none: { url: 'https://example.com/', body: '<h1>hello</h1>', expectAdapter: null },
  // DeepSeek 对话页
  deepseek: { url: 'https://chat.deepseek.com/a/chat/s/abc-123', body: DEEPSEEK_DOM, expectAdapter: 'deepseek' },
  // DeepSeek 新会话页（无消息）：按域名就该认出来，好让用户看到按钮
  'deepseek-empty': { url: 'https://chat.deepseek.com/', body: '<div id="root"></div>', expectAdapter: 'deepseek' }
};

const S = SCENARIOS[scenario];
if (!S) {
  console.error(`未知场景：${scenario}`);
  process.exit(1);
}
console.log(`内容脚本测试 · 场景 ${scenario}（${S.url}）`);

/* ------------------------------------------------------------------ */
/*                            环境装配                                  */
/* ------------------------------------------------------------------ */

const dom = new JSDOM(`<!DOCTYPE html><html><head><title>${scenario}</title></head><body>${S.body}</body></html>`, {
  url: S.url,
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
globalThis.localStorage = w.localStorage;
globalThis.getComputedStyle = w.getComputedStyle.bind(w);
globalThis.requestAnimationFrame = cb => setTimeout(() => cb(Date.now()), 0);
globalThis.cancelAnimationFrame = id => clearTimeout(id);
globalThis.FileReader = w.FileReader;
globalThis.Blob = w.Blob;
globalThis.URL = w.URL;
globalThis.alert = () => {};
// 诊断接口会去探测站点接口，测试里禁网以保证结果确定、不依赖本机是否在跑 DSH
globalThis.fetch = async () => { throw new Error('测试环境禁用网络'); };

const listeners = [];
const saved = [];
globalThis.chrome = {
  runtime: {
    getManifest: () => ({ version: '1.0.1-contenttest' }),
    lastError: null,
    onMessage: { addListener: fn => listeners.push(fn) },
    sendMessage: (msg, cb) => {
      if (msg && msg.type === 'DSX_SAVE_FILES') { saved.push(...(msg.files || [])); if (cb) cb({ ok: true, results: [] }); return; }
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

/** 同步调用消息处理器（仅适用于同步应答的分支） */
function ask(message) {
  if (listeners.length === 0) return { __noListener: true };
  let response = null;
  listeners[0](message, { id: 'test' }, r => { response = r; });
  return response;
}

/**
 * 兼容同步/异步应答的调用。处理器返回 true 表示会异步 sendResponse
 * （诊断接口在识别出适配器时就是异步的）。
 */
function askAsync(message, timeout = 3000) {
  if (listeners.length === 0) return Promise.resolve({ __noListener: true });
  return new Promise(resolve => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) { settled = true; resolve({ __timeout: true }); }
    }, timeout);
    listeners[0](message, { id: 'test' }, r => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    });
  });
}

/* ------------------------------------------------------------------ */
/*                              断言                                    */
/* ------------------------------------------------------------------ */

section('适配器匹配');
{
  const { resolveAdapter, dshAdapter, deepseekAdapter } = await import('../src/adapters/index.js');
  const found = resolveAdapter(w.location);
  check(`识别结果符合预期（${S.expectAdapter || '无'}）`,
    (found && found.id) === S.expectAdapter, `实际 ${found && found.id}`);

  // 关键回归：DSH 的端口兜底
  if (scenario === 'dsh' || scenario === 'dsh-empty') {
    check('DSH 按端口 3080 就能识别（不依赖 data-chat-flow 是否渲染）',
      dshAdapter.match(w.location) === true);
  }
  if (scenario === 'localhost-other') {
    check('本地其它端口不会被误判成 DSH', dshAdapter.match(w.location) === false);
  }
  if (scenario.startsWith('deepseek')) {
    check('DeepSeek 按域名识别', deepseekAdapter.match(w.location) === true);
  }
  if (scenario === 'none') {
    check('无关站点不匹配任何适配器', found === null);
  }
}

section('消息接口（必须先于适配器识别可用）');
{
  // 导入内容脚本：它会在模块顶层注册监听器
  await import('../src/content/index.js');
  await sleep(50);

  check('内容脚本注册了消息监听器', listeners.length > 0, `listeners=${listeners.length}`);

  const pong = ask({ type: 'DSX_PING' });
  check('DSX_PING 有响应（说明接收端存在）', !!pong && pong.ok === true,
    pong && pong.__noListener ? '没有监听器' : JSON.stringify(pong));
  check('DSX_PING 回报了构建号', !!pong && !!pong.build, pong && pong.build);

  const status = ask({ type: 'DSX_GET_STATUS' });
  check('DSX_GET_STATUS 返回 ok（即使未识别站点）', !!status && status.ok === true,
    JSON.stringify(status));
  check('状态里带上了适配器 id',
    !!status && (status.adapter || null) === S.expectAdapter,
    `期望 ${S.expectAdapter}，实际 ${status && status.adapter}`);
  check('状态里标记了 injected', !!status && status.injected === true);
}

section('诊断接口');
{
  const diag = await askAsync({ type: 'DSX_DIAGNOSE' });
  check('DSX_DIAGNOSE 有响应', !!diag && diag.ok !== false && !diag.__timeout,
    JSON.stringify(diag).slice(0, 140));
  if (diag && diag.ok && diag.report) {
    check('报告里有 URL 与端口', !!diag.report.url && diag.report.port !== undefined,
      `${diag.report.url} / port=${diag.report.port}`);
    if (S.expectAdapter) {
      check('识别出站点时报告里带站点名',
        diag.report.adapter === S.expectAdapter, String(diag.report.adapter));
    } else {
      check('未识别站点时也能给出探测信息', !!diag.report.probes,
        Object.keys(diag.report).join(','));
    }
  }
}

section('面板开关');
{
  if (S.expectAdapter) {
    const r = ask({ type: 'DSX_TOGGLE_PANEL' });
    check('已识别站点时能打开面板', !!r && r.ok === true, JSON.stringify(r));

    // 启动按钮是在 boot() 之后延迟创建的，轮询等它出现
    let launcher = null;
    for (let i = 0; i < 40; i++) {
      await sleep(80);
      const host = document.getElementById('dsx-panel-host');
      launcher = document.getElementById('dsx-launcher-host')
        || (host && host.shadowRoot && host.shadowRoot.getElementById('dsx-launcher-host'));
      if (launcher) break;
    }
    check('面板宿主已创建', !!document.getElementById('dsx-panel-host'));
    check('启动按钮已创建（站点区域或插件 Shadow 中）', !!launcher);
    if (launcher) {
      check('启动按钮在独立 Shadow Root 内（样式隔离）', !!launcher.shadowRoot);
    }
  } else {
    const r = ask({ type: 'DSX_TOGGLE_PANEL' });
    check('未识别站点时返回明确错误而不是静默', !!r && r.ok === false && r.error === 'NOT_SUPPORTED',
      JSON.stringify(r));
    check('错误里带了页面探测数据，便于反馈', !!(r && r.probe && r.probe.probes),
      r && r.probe ? Object.keys(r.probe.probes).length + ' 项' : '无');
  }
}

/* ------------------------------------------------------------------ */
console.log(`\n${'='.repeat(56)}`);
console.log(`[${scenario}] 通过 ${pass}，失败 ${fail}`);
if (fail) {
  console.log('失败项：');
  failures.forEach(f => console.log(`  - ${f}`));
  process.exit(1);
}
console.log('全部通过 ✅');
process.exit(0);
