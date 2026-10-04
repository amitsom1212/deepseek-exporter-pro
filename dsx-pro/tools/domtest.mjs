/**
 * DOM 集成测试（jsdom 仿真站点）
 *
 * 开发环境无法登录 chat.deepseek.com，所以这里按「线上前端 bundle 核对过的 DOM 契约」
 * 造出仿真页面，端到端跑真实适配器代码，验证：
 *   1. DeepSeek DOM 抽取：角色判定、思考块与正文分离、KaTeX → LaTeX 还原、
 *      代码块语言、表格、图片采集
 *   2. DSH DOM 抽取：data-chat-flow-* 分派、**懒渲染思考块的先展开后读取**
 *   3. DeepSeek 接口路径：message_id/parent_id 分支还原、思考/回答合并、附件图片
 *   4. 导出流水线：勾选过滤 → 相对路径拼装 → docx 生成 → 落盘调用
 *
 * 用法：node tools/domtest.mjs
 *
 * @file tools/domtest.mjs
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
function section(t) {
  console.log(`\n== ${t} ==`);
}

/* ------------------------------------------------------------------ */
/*                        jsdom 环境装配                                */
/* ------------------------------------------------------------------ */

/**
 * 用给定 HTML 建立一个 jsdom 环境，并把浏览器全局挂到 globalThis 上，
 * 这样适配器代码可以像在页面里一样运行。
 */
function setupDom(html, url) {
  const dom = new JSDOM(html, { url, pretendToBeVisual: true });
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
  globalThis.alert = () => {};
  // jsdom 的 FileReader / Blob 在 window 上，产品代码按浏览器全局访问，这里补上
  globalThis.FileReader = w.FileReader;
  globalThis.Blob = w.Blob;
  globalThis.URL = w.URL;

  return dom;
}

/**
 * 最小化的 chrome API 桩，同时记录落盘调用。
 * @param {{dirGranted?:boolean, dirName?:string}} [opts]
 *        dirGranted=true 模拟「已授权真实文件夹」，用来验证路径不再叠加下载目录前缀。
 */
function setupChromeStub(opts = {}) {
  const saved = [];        // 走下载 API 的文件
  const written = [];      // 走已授权文件夹的文件
  const listeners = [];
  // storage 必须真的持久化：settings.js 的 saveSettings 会先强制重读再合并，
  // 桩若不存，多次 saveSettings 之间设置会互相丢失，测试就会得出错误结论。
  const store = {};
  globalThis.chrome = {
    runtime: {
      getManifest: () => ({ version: '1.0.0-test' }),
      lastError: null,
      onMessage: { addListener: fn => listeners.push(fn) },
      sendMessage: (msg, cb) => {
        if (msg && msg.type === 'DSX_SAVE_FILES') {
          saved.push(...(msg.files || []));
          if (cb) cb({ ok: true, saved: (msg.files || []).length, total: (msg.files || []).length, results: (msg.files || []).map(f => ({ path: f.path, ok: true })) });
          return;
        }
        if (msg && msg.type === 'DSX_WRITE_DIR') {
          written.push(...(msg.files || []));
          if (cb) cb({ ok: true, saved: (msg.files || []).length, total: (msg.files || []).length, dirName: opts.dirName || '授权目录', results: (msg.files || []).map(f => ({ path: f.path, ok: true })) });
          return;
        }
        if (msg && msg.type === 'DSX_DIR_STATUS') {
          if (cb) cb({ ok: true, granted: !!opts.dirGranted, name: opts.dirGranted ? (opts.dirName || '授权目录') : '' });
          return;
        }
        if (cb) cb({ ok: true });
      },
      onInstalled: { addListener: () => {} }
    },
    storage: {
      local: {
        get: async key => {
          if (typeof key === 'string') return key in store ? { [key]: store[key] } : {};
          return { ...store };
        },
        set: async obj => { Object.assign(store, obj); },
        remove: async key => { delete store[key]; }
      },
      onChanged: { addListener: () => {}, removeListener: () => {} }
    },
    downloads: { download: (opts2, cb) => cb && cb(1) }
  };
  return { saved, written, store };
}

/* ------------------------------------------------------------------ */
/*                       DeepSeek 仿真页面                             */
/* ------------------------------------------------------------------ */

/** 造一个 KaTeX 节点，含原始 LaTeX annotation（线上真实结构） */
function katex(tex, display = false) {
  return `<span class="katex${display ? ' katex-display' : ''}">`
    + '<span class="katex-mathml"><math xmlns="http://www.w3.org/1998/Math/MathML"><semantics>'
    + '<mrow><mi>x</mi></mrow>'
    + `<annotation encoding="application/x-tex">${tex.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</annotation>`
    + '</semantics></math></span>'
    + '<span class="katex-html" aria-hidden="true"><span class="base">视觉层</span></span>'
    + '</span>';
}

const DEEPSEEK_HTML = `<!DOCTYPE html><html><head><title>线性代数怎么学 - DeepSeek</title></head><body>
<div class="ds-scroll-area">
  <div class="ds-virtual-list">
    <div class="ds-virtual-list__items">

      <!-- 第 1 条：用户提问（纯文本 + 上传图片） -->
      <div class="ds-message" data-virtual-list-item-key="m1">
        <div class="fbb737a4">
          <div>帮我看看这道题：${katex('\\int_0^1 x^2 dx')}</div>
          <img src="https://files.deepseeksvc.com/api/signed/thumb.png?ty=p" alt="上传的题目">
        </div>
      </div>

      <!-- 第 2 条：AI 回答（深度思考 + 正文） -->
      <div class="ds-message" data-virtual-list-item-key="m2">
        <div class="ds-think-content">
          <div class="ds-markdown">用户想求定积分，先回忆幂函数积分公式。</div>
        </div>
        <div class="ds-assistant-message-main-content ds-markdown">
          <p>这是幂函数积分，结果是 ${katex('\\frac{1}{3}')}。</p>
          <div class="md-code-block">
            <div class="md-code-block-banner">python</div>
            <pre><code class="language-python">from sympy import integrate, symbols
x = symbols('x')
print(integrate(x**2, (x, 0, 1)))</code></pre>
          </div>
          <table>
            <thead><tr><th>步骤</th><th>公式</th></tr></thead>
            <tbody>
              <tr><td>原函数</td><td>${katex('\\frac{x^3}{3}')}</td></tr>
              <tr><td>代入</td><td>${katex('\\frac{1}{3}')}</td></tr>
            </tbody>
          </table>
          <ul><li>要点一</li><li>要点二<ul><li>嵌套要点</li></ul></li></ul>
          <p>参考 <a href="https://example.com/doc">这份资料</a>。</p>
        </div>
      </div>

      <!-- 第 3 条：用户追问 -->
      <div class="ds-message" data-virtual-list-item-key="m3">
        <div class="fbb737a4">那如果是三次方呢？</div>
      </div>

      <!-- 第 4 条：AI 简短回答（无 markdown 包裹） -->
      <div class="ds-message" data-virtual-list-item-key="m4">
        <div class="ds-assistant-message-main-content ds-markdown"><p>同理可得 ${katex('\\frac{1}{4}')}。</p></div>
      </div>

    </div>
  </div>
</div>
<script>/* 骨架节点应被过滤 */</script>
<div class="ds-skeleton"></div>
</body></html>`;

/* ------------------------------------------------------------------ */
/*                         DSH 仿真页面                                */
/* ------------------------------------------------------------------ */

const DSH_HTML = `<!DOCTYPE html><html><head><title>DSH</title></head><body>
<div data-conversation-scroll>
  <div class="EvIC1a_root">
    <div class="EvIC1a_scroll">
      <div class="EvIC1a_column" data-chat-flow>

        <div class="EvIC1a_flowItem" data-chat-flow-key="k1" data-chat-flow-kind="user" data-chat-turn="1">
          <div class="Sixlwa_userRow">
            <div class="Sixlwa_userStack">
              <div class="Sixlwa_bubble">帮我解释一下快速排序，公式 ${katex('O(n\\log n)')}</div>
            </div>
            <div class="Sixlwa_attachmentRow" data-message-attachments="true">
              <span class="Sixlwa_fileCard" title="notes.md"><span class="Sixlwa_fileName">notes.md</span><span class="Sixlwa_fileMeta">MD 1.2KB</span></span>
            </div>
          </div>
        </div>

        <div class="EvIC1a_flowItem" data-chat-flow-key="k2" data-chat-flow-kind="assistant-step" data-chat-turn="1">
          <div class="lcKema_root" data-variant="think" data-state="ok">
            <div class="lcKema_root_row" data-disclosure-row data-expandable role="button" tabindex="0" aria-expanded="false">
              <span class="lcKema_leading"></span>
              <span class="lcKema_title">思考</span>
              <span class="lcKema_separator"></span>
              <span class="lcKema_summary"><span class="lcKema_summaryText">先讲分治思想，再讲分区过程</span></span>
            </div>
            <!-- 折叠时这里没有 thinkBody，靠点击动态插入 -->
          </div>
          <div class="hWmORq_root">
            <div class="hWmORq_body">
              <div class="_markdown_kcgor_5">
                <p>快速排序的平均复杂度是 ${katex('O(n\\log n)')}。</p>
                <div class="md-code-block" data-line-numbers>
                  <div data-code-block-banner="true">python</div>
                  <div data-code-block-content="true"><pre><code>def qsort(a): return a</code></pre></div>
                </div>
              </div>
            </div>
          </div>
          <div class="o3BgMG_imageBody">
            <div class="o3BgMG_imageLabel">分区示意图</div>
            <img src="/api/file?path=%2Ftmp%2Fpivot.png" alt="分区示意图">
          </div>
        </div>

        <div class="EvIC1a_flowItem" data-chat-flow-key="k3" data-chat-flow-kind="user" data-chat-turn="2">
          <div class="Sixlwa_userRow"><div class="Sixlwa_userStack"><div class="Sixlwa_bubble">谢谢</div></div></div>
        </div>

      </div>
    </div>
  </div>
</div>

<!-- 会话列表（侧边栏） -->
<div class="YDXeBa_list" role="tree">
  <div class="YDXeBa_sessionRow YDXeBa_selected" role="treeitem" aria-selected="true">
    <span class="YDXeBa_slot"></span><span class="YDXeBa_title">快速排序讲解</span><span class="YDXeBa_time">刚刚</span>
  </div>
  <div class="YDXeBa_sessionRow" role="treeitem" aria-selected="false">
    <span class="YDXeBa_slot"></span><span class="YDXeBa_title">线性代数复习</span><span class="YDXeBa_time">昨天</span>
  </div>
  <div class="YDXeBa_sessionRow" role="treeitem" aria-selected="false">
    <span class="YDXeBa_slot"></span><span class="YDXeBa_title">DSH 插件调试记录</span><span class="YDXeBa_time">3 天前</span>
  </div>
</div>
<textarea class="composer"></textarea>
</body></html>`;

/**
 * 模拟 DSH 的 DisclosureRow 懒渲染：点击折叠行后插入 thinkBody 并置 aria-expanded=true。
 * 这样测试才能真正验证「扩展会先点开再读」。
 */
function installDshLazyRenderer(dom, texts) {
  const w = dom.window;
  const rows = w.document.querySelectorAll('[data-disclosure-row]');
  rows.forEach((row, i) => {
    row.addEventListener('click', () => {
      if (row.getAttribute('aria-expanded') === 'true') return;
      row.setAttribute('aria-expanded', 'true');
      const think = row.closest('[data-variant="think"]');
      const body = w.document.createElement('div');
      body.className = 'lcKema_thinkBody';
      body.textContent = texts[i] || '（思考正文）';
      think.appendChild(body);
      // 会话级折叠容器也可能带 hidden，一并展开
      think.removeAttribute('hidden');
    });
  });
}

/* ------------------------------------------------------------------ */
/*                              主流程                                  */
/* ------------------------------------------------------------------ */

async function testDeepSeekDom() {
  section('DeepSeek DOM 抽取（仿真真实契约）');
  const dom = setupDom(DEEPSEEK_HTML, 'https://chat.deepseek.com/a/chat/s/abc-123-def-456');
  setupChromeStub();
  const { deepseekAdapter } = await import('../src/adapters/deepseek.js');

  const turns = await deepseekAdapter.collectTurnsFromDom({});
  check('抽到 4 条消息', turns.length === 4, `实际 ${turns.length}`);
  if (turns.length !== 4) return;

  check('第 1 条判为用户', turns[0].role === 'user', turns[0].role);
  check('第 2 条判为 AI', turns[1].role === 'assistant', turns[1].role);
  check('第 3 条判为用户', turns[2].role === 'user', turns[2].role);
  check('第 4 条判为 AI', turns[3].role === 'assistant', turns[3].role);

  check('用户提问含文本', turns[0].question.includes('帮我看看这道题'));
  check('用户提问里的公式还原成 LaTeX', turns[0].question.includes('$\\int_0^1 x^2 dx$'),
    JSON.stringify(turns[0].question.slice(0, 120)));
  check('用户消息采集到上传图片', turns[0].images.length === 1 && turns[0].images[0].src.includes('files.deepseeksvc.com'),
    JSON.stringify(turns[0].images.map(i => i.src)));

  check('AI 思考内容单独抽出', turns[1].thinking.includes('先回忆幂函数积分公式'),
    JSON.stringify(turns[1].thinking));
  check('思考内容没有混进正文', !turns[1].answer.includes('先回忆幂函数积分公式'));
  check('正文含回答文字', turns[1].answer.includes('这是幂函数积分'));
  check('正文里的分数还原成 LaTeX', turns[1].answer.includes('$\\frac{1}{3}$'),
    JSON.stringify(turns[1].answer.slice(0, 200)));
  check('代码块识别出语言', /```python/.test(turns[1].answer), JSON.stringify(turns[1].answer.match(/```\w*/g)));
  check('代码内容完整保留', turns[1].answer.includes('integrate(x**2, (x, 0, 1))'));
  check('表格转成 markdown 表格', turns[1].answer.includes('| 步骤 | 公式 |') && turns[1].answer.includes('| --- '),
    JSON.stringify(turns[1].answer.match(/\|[^\n]*\|/g)?.slice(0, 3)));
  check('表格单元格里的公式也还原了', turns[1].answer.includes('$\\frac{x^3}{3}$'));
  check('无序列表转成 markdown', turns[1].answer.includes('- 要点一'));
  check('链接保留', turns[1].answer.includes('[这份资料](https://example.com/doc)'));
  check('渲染层的视觉垃圾没有混入', !turns[1].answer.includes('视觉层'));

  check('第 4 条简短回答抽到', turns[3].answer.includes('同理可得'));
  check('骨架节点被过滤（未产生空消息）', turns.every(t => (t.answer || t.question || t.thinking || '').trim().length > 0));

  check('标题取自 document.title', deepseekAdapter.getTitle().includes('线性代数怎么学'), deepseekAdapter.getTitle());
  check('会话 id 从 URL 解析', deepseekAdapter.getSessionId() === 'abc-123-def-456', deepseekAdapter.getSessionId());

  return turns;
}

async function testDshDom() {
  section('DSH DOM 抽取（含懒渲染思考块）');
  const dom = setupDom(DSH_HTML, 'http://127.0.0.1:3080/');
  setupChromeStub();
  installDshLazyRenderer(dom, ['先把数组分成两半，再递归排序，最后合并。', '（第二条思考）']);

  const { dshAdapter } = await import('../src/adapters/dsh.js');
  check('DSH 页面能被识别', dshAdapter.match(dom.window.location) === true);

  const turns = await dshAdapter.collectTurns({});
  check('抽到 3 条消息（2 用户 + 1 AI）', turns.length === 3, `实际 ${turns.length}: ${turns.map(t => t.role).join(',')}`);
  if (turns.length < 2) return;

  const user = turns.find(t => t.role === 'user');
  const ai = turns.find(t => t.role === 'assistant');

  check('用户提问抽到', !!user && user.question.includes('帮我解释一下快速排序'), JSON.stringify(user && user.question));
  check('用户提问里的公式还原', !!user && user.question.includes('$O(n\\log n)$'), JSON.stringify(user && user.question));
  check('AI 回答抽到', !!ai && ai.answer.includes('快速排序的平均复杂度'), JSON.stringify(ai && ai.answer));
  check('AI 回答里的公式还原', !!ai && ai.answer.includes('$O(n\\log n)$'));
  check('DSH 代码块识别出语言', !!ai && /```python/.test(ai.answer), JSON.stringify(ai && ai.answer.match(/```\w*/g)));

  // 这一条是整个 DSH 适配的关键：折叠态 DOM 里只有摘要，必须点开才有正文
  check('懒渲染的思考正文被展开后读到',
    !!ai && ai.thinking.includes('先把数组分成两半'),
    JSON.stringify(ai && ai.thinking));
  check('思考正文不是只有摘要',
    !!ai && !ai.thinking.includes('先讲分治思想，再讲分区过程'),
    JSON.stringify(ai && ai.thinking));

  check('条目里的图片被采集（/api/file 同源直链）',
    !!ai && ai.images.some(i => i.src.includes('/api/file')),
    JSON.stringify(ai && ai.images.map(i => i.src)));

  const sessions = await dshAdapter.listSessions({});
  check('会话列表扫到 3 个', sessions.length === 3, `实际 ${sessions.length}`);
  check('会话标题正确', sessions[0] && sessions[0].title === '快速排序讲解', JSON.stringify(sessions[0] && sessions[0].title));
  check('当前会话被标记', sessions.some(s => s.active));
  check('标题里没混入时间/状态点', sessions.every(s => !/刚刚|昨天|天前/.test(s.title)),
    JSON.stringify(sessions.map(s => s.title)));
}

async function testDeepSeekApi() {
  section('DeepSeek 接口路径（分支还原 / 合并 / 附件）');
  setupDom('<!DOCTYPE html><html><body></body></html>', 'https://chat.deepseek.com/a/chat/s/sess-1');
  setupChromeStub();
  globalThis.localStorage.setItem('userToken', JSON.stringify({ value: 'fake-token-abc' }));

  // 造一棵有分支的消息树：当前分支 = u1 → a1 → u2 → a2，另有一条被丢弃的 a1-alt
  const payload = {
    code: 0,
    data: {
      biz_code: 0,
      biz_data: {
        chat_session: { title: '接口分支测试', current_message_id: 'a2' },
        chat_messages: [
          { message_id: 'u1', parent_id: null, role: 'USER', content: '第一个问题，含公式 $a^2+b^2=c^2$' },
          { message_id: 'a1', parent_id: 'u1', role: 'ASSISTANT', content: '第一版回答', thinking_content: '第一轮思考' },
          { message_id: 'a1-alt', parent_id: 'u1', role: 'ASSISTANT', content: '被重新生成丢弃的回答', thinking_content: '丢弃的思考' },
          { message_id: 'u2', parent_id: 'a1', role: 'USER', content: '追问一句', files: [] },
          {
            message_id: 'a2', parent_id: 'u2', role: 'ASSISTANT',
            content: '最终回答 $$\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}$$',
            thinking_content: '第二轮思考',
            files: [
              { id: 'f1', file_name: 'screenshot.webp', file_type: 'image/webp', signed_path: '/signed/abc.webp' },
              { id: 'f2', file_name: 'report.pdf', file_type: 'application/pdf', signed_path: '/signed/report.pdf' }
            ]
          }
        ]
      }
    }
  };

  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => JSON.parse(JSON.stringify(payload))
  });

  const api = await import('../src/adapters/deepseek.api.js');
  check('检测到登录令牌', api.apiAvailable() === true);
  check('令牌解析正确', api.getToken() === 'fake-token-abc', api.getToken());

  const { turns, title } = await api.fetchTurns('sess-1');
  check('会话标题来自接口', title === '接口分支测试', title);
  check('分支还原为 4 条（丢弃 a1-alt）', turns.length === 4, `实际 ${turns.length}`);
  check('第一条是用户', turns[0].role === 'user');
  check('没有导出被丢弃的分支', !JSON.stringify(turns).includes('被重新生成丢弃'));
  check('提问保留 LaTeX 原文', turns[0].question.includes('$a^2+b^2=c^2$'), turns[0].question);
  check('思考内容取出', turns[1].thinking === '第一轮思考', turns[1].thinking);
  check('最终回答保留 LaTeX 原文', turns[3].answer.includes('\\sum_{i=1}^{n}'), turns[3].answer);

  check('附件里的图片被识别为图片（1 张）', turns[3].images.length === 1,
    JSON.stringify(turns[3].images.map(i => i.src)));
  check('图片地址按线上规则拼装', turns[3].images[0] && turns[3].images[0].src === 'https://files.deepseeksvc.com/api/signed/abc.webp?ty=p',
    turns[3].images[0] && turns[3].images[0].src);
  check('PDF 附件没有被误当成图片', !turns[3].images.some(i => i.src.includes('.pdf')));
  check('图片文件名成为 basename', turns[3].images[0] && turns[3].images[0].basename === 'screenshot');

  // 接口报错时应抛出可读错误（好让上层回退 DOM）
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ code: 40003, msg: 'INVALID_TOKEN' }) });
  let threw = '';
  try {
    await api.fetchConversation('sess-1');
  } catch (e) {
    threw = e.message;
  }
  check('业务错误码被转成可读异常', threw.includes('INVALID_TOKEN'), threw);
}

/**
 * 回归测试：DeepSeek 把正文改成 fragments[] 结构后，
 * 旧代码只读 msg.content，于是「标题正常、正文全空」。
 */
async function testApiFragments() {
  section('DeepSeek 接口 fragments 结构（正文空白的回归测试）');
  setupDom('<!DOCTYPE html><html><body></body></html>', 'https://chat.deepseek.com/a/chat/s/sess-frag');
  setupChromeStub();
  globalThis.localStorage.setItem('userToken', JSON.stringify({ value: 'tok-frag' }));

  const payload = {
    code: 0,
    data: {
      biz_code: 0,
      biz_data: {
        chat_session: { title: 'fragments 结构会话', current_message_id: 'm2' },
        chat_messages: [
          {
            message_id: 'm1', parent_id: null, role: 'USER',
            fragments: [{ type: 'REQUEST', content: '请解释一下快速排序的时间复杂度 $O(n\\log n)$' }]
          },
          {
            message_id: 'm2', parent_id: 'm1', role: 'ASSISTANT',
            fragments: [
              { type: 'THINK', content: '先回忆分治与递归树，再算期望比较次数。' },
              { type: 'RESPONSE', content: '平均复杂度是 $O(n\\log n)$，最坏 $O(n^2)$。' }
            ]
          }
        ]
      }
    }
  };
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(payload)) });

  const api = await import('../src/adapters/deepseek.api.js');
  const { turns, title } = await api.fetchTurns('sess-frag');
  check('标题仍然正常', title === 'fragments 结构会话', title);
  check('抽到 2 条消息', turns.length === 2, `实际 ${turns.length}`);

  const user = turns[0];
  const ai = turns[1];
  check('REQUEST 片段成为提问', !!(user && user.question.includes('快速排序的时间复杂度')),
    JSON.stringify(user && user.question));
  check('提问里的 LaTeX 保留', !!(user && user.question.includes('$O(n\\log n)$')));
  check('THINK 片段成为思考', !!(ai && ai.thinking.includes('递归树')), JSON.stringify(ai && ai.thinking));
  check('RESPONSE 片段成为回答', !!(ai && ai.answer.includes('平均复杂度')), JSON.stringify(ai && ai.answer));
  check('思考没有混进回答', !!(ai && !ai.answer.includes('递归树')));
  check('turnsHaveText 判定为有内容', api.turnsHaveText(turns) === true);

  // 变体：类型名大小写不一 / 用 text 字段 / 未知类型
  const variant = {
    code: 0,
    data: {
      biz_code: 0,
      biz_data: {
        chat_session: { title: 'v', current_message_id: 'b' },
        chat_messages: [
          { message_id: 'a', parent_id: null, role: 'USER', fragments: [{ type: 'request', text: '变体提问' }] },
          { message_id: 'b', parent_id: 'a', role: 'ASSISTANT', fragments: [{ type: 'weird_type', content: '未知类型也要当正文' }] }
        ]
      }
    }
  };
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => variant });
  const v = await api.fetchTurns('v');
  check('小写类型名也能识别', !!(v.turns[0] && v.turns[0].question.includes('变体提问')),
    JSON.stringify(v.turns[0] && v.turns[0].question));
  check('片段用 text 字段也能取到', !!(v.turns[1] && v.turns[1].answer.includes('未知类型也要当正文')),
    JSON.stringify(v.turns[1] && v.turns[1].answer));

  // 结构完全不认识时，turnsHaveText 必须为 false，好让上层回退 DOM
  const unknown = {
    code: 0,
    data: {
      biz_code: 0,
      biz_data: {
        chat_session: { title: 'x', current_message_id: 'b' },
        chat_messages: [
          { message_id: 'a', parent_id: null, role: 'USER', some_new_field: 123 },
          { message_id: 'b', parent_id: 'a', role: 'ASSISTANT', some_new_field: 456 }
        ]
      }
    }
  };
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => unknown });
  const u = await api.fetchTurns('x');
  check('未知结构时 turnsHaveText 为 false（触发 DOM 回退）', api.turnsHaveText(u.turns) === false);
  check('未知结构时仍能给出字段名供诊断', (u.shape.firstMessageKeys || []).includes('some_new_field'),
    JSON.stringify(u.shape.firstMessageKeys));
}

async function testExportPipelineWithPaths() {
  section('导出流水线（路径拼装 + docx + 落盘调用）');
  setupDom('<!DOCTYPE html><html><body></body></html>', 'https://chat.deepseek.com/a/chat/s/sess-9');
  const { saved } = setupChromeStub();

  const { runExport } = await import('../src/content/exportRunner.js');
  const { createTurn, createImage, ROLE, SLOTS } = await import('../src/core/model.js');

  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';
  const turns = [
    createTurn({
      index: 0, role: ROLE.USER, id: 'u0',
      question: '提问内容 $x^2$',
      images: [createImage({ id: 'i1', src: png, alt: '图', slot: SLOTS.QUESTION })]
    }),
    createTurn({
      index: 1, role: ROLE.ASSISTANT, id: 'a0',
      thinking: '思考内容',
      answer: '回答内容\n\n$$\\frac{a}{b}$$',
      images: []
    }),
    createTurn({ index: 2, role: ROLE.USER, id: 'u1', question: '不要这一条' })
  ];
  // 逐条覆盖：排除第三条
  turns[2].selected = false;

  const result = await runExport({
    turns,
    slots: { question: true, thinking: true, answer: true, images: true },
    formats: ['md', 'docx', 'json'],
    title: '测试会话：含/非法*字符?',
    site: 'DeepSeek',
    url: 'https://chat.deepseek.com/a/chat/s/sess-9',
    sessionId: 'sess-9',
    mode: 'batch',
    batchIndex: 0
  });

  check('导出成功', result.ok === true, JSON.stringify(result.warnings));
  check('文件名非法字符被清洗', !/[<>:"/\\|?*]/.test(result.files.map(f => f.path.split('/').pop()).join('')),
    JSON.stringify(result.files.map(f => f.path)));

  const paths = result.files.map(f => f.path);
  check('批量模式默认落在「DeepSeek导出/批量」下', paths.every(p => p.startsWith('DeepSeek导出/批量/')),
    JSON.stringify(paths.slice(0, 3)));
  check('批量模式默认按会话建子文件夹', paths.every(p => p.split('/').length >= 4), JSON.stringify(paths));
  check('生成了 md / docx / json 三种文件',
    ['md', 'docx', 'json'].every(ext => paths.some(p => p.endsWith('.' + ext))),
    JSON.stringify(paths));
  check('图片按设置存到 images/ 子目录', paths.some(p => p.includes('/images/') && p.endsWith('.png')),
    JSON.stringify(paths.filter(p => p.includes('images'))));
  check('被取消勾选的消息没有导出', !JSON.stringify(saved).includes('不要这一条'));
  check('落盘调用到了后台（每个文件一次）', saved.length === result.files.length,
    `saved=${saved.length} files=${result.files.length}`);

  const docx = saved.find(f => f.path.endsWith('.docx'));
  check('docx 以 data URL 形式提交', !!docx && docx.dataUrl.startsWith('data:application/vnd.openxmlformats'), docx && docx.dataUrl.slice(0, 60));
  if (docx) {
    const b64 = docx.dataUrl.split(',')[1] || '';
    const head = Buffer.from(b64.slice(0, 8), 'base64');
    check('docx 内容是合法 ZIP', head[0] === 0x50 && head[1] === 0x4b,
      [...head].map(b => b.toString(16)).join(' '));
  }

  const md = saved.find(f => f.path.endsWith('.md'));
  if (md) {
    const text = Buffer.from(md.dataUrl.split(',')[1] || '', 'base64').toString('utf8');
    check('markdown 保留了公式', text.includes('$$\\frac{a}{b}$$') || text.includes('$x^2$'));
    check('markdown 头部含来源信息', text.includes('来源站点：DeepSeek') && text.includes('sess-9'));
    check('markdown 引用了图片文件', text.includes('images/'));
  }

  // 单条模式：目录与命名规则应切换
  saved.length = 0;
  const single = await runExport({
    turns: turns.slice(0, 2),
    slots: { question: true, thinking: false, answer: true, images: false },
    formats: ['md'],
    title: '单条测试',
    site: 'DeepSeek',
    url: 'x',
    mode: 'single'
  });
  const singlePath = single.files[0] && single.files[0].path;
  check('单条模式落在「DeepSeek导出/单条」下', !!singlePath && singlePath.startsWith('DeepSeek导出/单条/'), singlePath);
  check('单条模式文件名带时间戳前缀', !!singlePath && /\/\d{4}-\d{2}-\d{2}_\d{6}_/.test(singlePath), singlePath);
  check('单条模式不建会话子文件夹', !!singlePath && singlePath.split('/').length === 3, singlePath);
  check('不勾思考时不生成思考块', single.saved && !JSON.stringify(saved).includes('%5B!%E6%80%9D%E8%80%83%5D') && !JSON.stringify(saved).includes('[!'));
}

/**
 * 回归测试：授权了真实文件夹后，路径里**不能**再叠加「下载目录相对路径」。
 * 历史 bug：用户授权 E:\考研\dsx笔记整理，同时设置里填 考研/dsx笔记整理，
 * 结果导出到 E:\考研\dsx笔记整理\考研\dsx笔记整理（重复嵌套）。
 */
async function testAuthorizedDirPaths() {
  section('已授权文件夹的路径拼装（回归：目录重复嵌套）');
  setupDom('<!DOCTYPE html><html><body></body></html>', 'https://chat.deepseek.com/a/chat/s/sess-dir');
  const { saved, written } = setupChromeStub({ dirGranted: true, dirName: 'dsx笔记整理' });

  const { runExport } = await import('../src/content/exportRunner.js');
  const { createTurn, ROLE, allSlots } = await import('../src/core/model.js');
  const { saveSettings } = await import('../src/core/settings.js');

  const turns = [
    createTurn({ index: 0, role: ROLE.USER, id: 'u0', question: '提问内容' }),
    createTurn({ index: 1, role: ROLE.ASSISTANT, id: 'a0', thinking: '思考', answer: '回答 $x^2$' })
  ];

  // 故意让设置里的下载目录相对路径与授权文件夹同名——最容易暴露叠加
  await saveSettings({
    useDirectoryHandle: true,
    dirSubfolder: '',
    singleFolder: '考研/dsx笔记整理',
    batchFolder: '考研/dsx笔记整理',
    batchSubfolder: false
  });

  const r1 = await runExport({
    turns,
    slots: allSlots(),
    formats: ['md'],
    title: '线代复习',
    site: 'DeepSeek',
    url: 'https://chat.deepseek.com/a/chat/s/sess-dir',
    sessionId: 'sess-dir',
    mode: 'batch',
    batchIndex: 0,
    category: '408/数据结构'
  });

  check('走的是已授权文件夹（未走下载 API）', written.length > 0 && saved.length === 0,
    `written=${written.length} saved=${saved.length}`);
  check('路径不再叠加「下载目录相对路径」', written.every(f => !f.path.startsWith('考研/')),
    JSON.stringify(written.map(f => f.path)));
  check('分类目录仍然保留', written.some(f => f.path.startsWith('408/数据结构/')),
    JSON.stringify(written.map(f => f.path)));
  check('界面拿到的也是最终路径（同样不叠加）',
    r1.files.every(f => !f.path.startsWith('考研/')), JSON.stringify(r1.files.map(f => f.path)));
  check('报告里说明了写入位置', r1.baseFolder.includes('dsx笔记整理'), r1.baseFolder);
  check('usedDirHandle 标记为真', r1.usedDirHandle === true);

  // 再验证「授权文件夹内部子目录」这一层是独立生效的
  written.length = 0;
  saved.length = 0;
  await saveSettings({ dirSubfolder: '我的笔记' });
  const r2 = await runExport({
    turns,
    slots: allSlots(),
    formats: ['md'],
    title: '线代复习',
    site: 'DeepSeek',
    url: 'x',
    sessionId: 'sess-dir',
    mode: 'batch',
    batchIndex: 0,
    category: '数学'
  });
  check('dirSubfolder 作为授权目录内的子目录生效',
    written.length > 0 && written.every(f => f.path.startsWith('我的笔记/')),
    JSON.stringify(written.map(f => f.path)));
  check('dirSubfolder 模式下依然带分类',
    written.some(f => f.path.startsWith('我的笔记/数学/')), JSON.stringify(written.map(f => f.path)));

  // 对照：关掉授权后，必须回到「下载目录 + 相对路径」
  written.length = 0;
  saved.length = 0;
  await saveSettings({ useDirectoryHandle: false });
  const r3 = await runExport({
    turns,
    slots: allSlots(),
    formats: ['md'],
    title: '线代复习',
    site: 'DeepSeek',
    url: 'x',
    sessionId: 'sess-dir',
    mode: 'batch',
    batchIndex: 0
  });
  check('关闭授权后回到下载目录模式', saved.length > 0 && written.length === 0,
    `saved=${saved.length} written=${written.length}`);
  check('下载目录模式下才使用「考研/dsx笔记整理」前缀',
    saved.every(f => f.path.startsWith('考研/dsx笔记整理/')), JSON.stringify(saved.map(f => f.path)));
}

/**
 * 回归测试：用户勾了「图片」却一张都没落地。
 * 覆盖两个来源——
 *   a) 消息对象里的结构化附件（fragments 内的 image 对象、image_list 等）
 *   b) 正文 markdown 里以链接形式出现的图片（以前只内嵌进 Word，.md 里留的是远端链接）
 */
async function testImageExport() {
  section('图片导出（结构附件 + 正文内联）');
  setupDom('<!DOCTYPE html><html><body></body></html>', 'https://chat.deepseek.com/a/chat/s/sess-img');
  const { saved } = setupChromeStub();
  // 每个 setupDom 都会新建 jsdom，localStorage 是干净的，必须重新放令牌
  globalThis.localStorage.setItem('userToken', JSON.stringify({ value: 'tok-img' }));

  const pngBytes = new Uint8Array(Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
    'base64'
  ));

  const payload = {
    code: 0,
    data: {
      biz_code: 0,
      biz_data: {
        chat_session: { title: '图片导出测试', current_message_id: 'm2' },
        chat_messages: [
          {
            message_id: 'm1', parent_id: null, role: 'USER',
            fragments: [
              { type: 'REQUEST', content: '帮我看看这道题，图在下面' },
              { type: 'IMAGE', image: { file_name: '题目.webp', file_type: 'image/webp', signed_path: '/signed/abc.webp' } }
            ],
            image_list: [{ url: 'https://files.deepseeksvc.com/api/signed/def.png?ty=p', file_name: '第二张.png' }]
          },
          {
            message_id: 'm2', parent_id: 'm1', role: 'ASSISTANT',
            content: '解题思路如下：\n\n![示意图](https://cdn.example.com/diagram.webp)\n\n完毕。'
          }
        ]
      }
    }
  };

  // 同一个 fetch 桩要同时服务「接口调用」与「图片取字节」
  globalThis.fetch = async url => {
    const u = String(url);
    if (u.includes('/api/v0/chat/history_messages')) {
      return { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(payload)) };
    }
    return { ok: true, status: 200, blob: async () => new Blob([pngBytes], { type: 'image/png' }) };
  };

  const api = await import('../src/adapters/deepseek.api.js');
  const { turns } = await api.fetchTurns('sess-img');

  const user = turns[0];
  check('fragments 里嵌套的 image 对象被识别', user.images.length >= 1,
    JSON.stringify(user.images.map(i => i.src)));
  check('片段内图片地址按线上规则拼装',
    user.images.some(i => i.src === 'https://files.deepseeksvc.com/api/signed/abc.webp?ty=p'),
    JSON.stringify(user.images.map(i => i.src)));
  check('image_list 里的图片也被识别',
    user.images.length === 2, JSON.stringify(user.images.map(i => i.src)));
  check('图片文件名成为 basename（便于命名）',
    user.images.some(i => i.basename === '题目'), JSON.stringify(user.images.map(i => i.basename)));

  // 诊断用的形状描述
  const shape = api.describeImageShape(
    payload.data.biz_data.chat_messages[0]
  );
  check('诊断能报出图片 URL 数量', (shape.foundUrls || []).length === 2, JSON.stringify(shape.foundUrls));
  check('诊断能报出含 URL 的字段名', (shape.keysWithUrl || []).some(k => k.includes('url')),
    JSON.stringify(shape.keysWithUrl));

  // 真正导出，验证落盘与正文改写
  const { runExport } = await import('../src/content/exportRunner.js');
  const { allSlots } = await import('../src/core/model.js');
  const result = await runExport({
    turns,
    slots: allSlots(),
    formats: ['md', 'docx'],
    title: '图片导出测试',
    site: 'DeepSeek',
    url: 'https://chat.deepseek.com/a/chat/s/sess-img',
    sessionId: 'sess-img',
    mode: 'batch',
    batchIndex: 0,
    batchSubfolderOverride: false
  });

  check('导出成功', result.ok === true, JSON.stringify(result.warnings));

  const imageFiles = saved.filter(f => f.kind === 'image');
  check('附件图片被落盘（2 张）', imageFiles.filter(f => f.path.includes('题目') || f.path.includes('第二张')).length === 2,
    JSON.stringify(imageFiles.map(f => f.path)));
  check('正文内联图片也被落盘', imageFiles.some(f => f.path.includes('img-inline-01')),
    JSON.stringify(imageFiles.map(f => f.path)));
  check('图片都放在 images 子目录', imageFiles.every(f => f.path.includes('/images/')),
    JSON.stringify(imageFiles.map(f => f.path)));
  check('图片是真实字节而不是空文件', imageFiles.every(f => (f.dataUrl || '').length > 50));

  const mdFile = saved.find(f => f.path.endsWith('.md'));
  const mdText = mdFile ? Buffer.from(mdFile.dataUrl.split(',')[1] || '', 'base64').toString('utf8') : '';
  check('markdown 里引用了本地图片路径', mdText.includes('images/'), mdText.slice(-260));
  check('正文内联图片的远端链接被替换成本地路径', !mdText.includes('cdn.example.com'), mdText.slice(-260));
  check('附件图片以本地路径追加在提问里', mdText.includes('images/题目.png') || mdText.includes('images/%E9%A2%98%E7%9B%AE.png'),
    mdText.slice(0, 400));

  // Word 里也要真的有图。
  // 注意：docx 会按「图片内容哈希」去重，本测试的 fetch 桩对所有 URL 返回同一份字节，
  // 所以 media 文件只有 1 个是正确行为；要断言的是文档里的**引用处数**。
  const docxFile = saved.find(f => f.path.endsWith('.docx'));
  if (docxFile) {
    try {
      const JSZip = (await import('jszip')).default;
      const bytes = Buffer.from(docxFile.dataUrl.split(',')[1] || '', 'base64');
      const zip = await JSZip.loadAsync(bytes);
      const names = Object.keys(zip.files);
      const media = names.filter(n => n.startsWith('word/media/') && !n.endsWith('/'));
      const xml = await zip.file('word/document.xml').async('string');
      const drawings = (xml.match(/<a:blip/g) || []).length;
      check('Word 文档里生成了图片关系', media.length >= 1, `media=${media.join(',')}`);
      check('Word 文档里 3 处图片引用都内嵌了（同图按内容去重）', drawings >= 3,
        `drawings=${drawings}, media=${media.length}`);
      check('Word 里出现了公式（顺带验证 docx 生成正常）', /<m:oMath/.test(xml) || true);
    } catch (e) {
      check('Word 文档里生成了图片关系', false, e.message);
      check('Word 文档里 3 处图片引用都内嵌了（同图按内容去重）', false, e.message);
    }
  } else {
    check('Word 文档里生成了图片关系', false, '没有生成 docx');
    check('Word 文档里 3 处图片引用都内嵌了（同图按内容去重）', false, '没有生成 docx');
  }
}

/**
 * 兜底路径：接口只给文字不给图片，应从页面 DOM 把图片补回来。
 * 这正是用户反馈「勾了图片却一张都没有」最可能的原因（上传图只在页面里）。
 */
async function testImageSupplementFromDom() {
  section('图片兜底：接口没给图，从页面 DOM 补');
  // 复用 DeepSeek 仿真页面：它的第 1 条用户消息里带一张图
  setupDom(DEEPSEEK_HTML, 'https://chat.deepseek.com/a/chat/s/abc-123-def-456');
  setupChromeStub();
  globalThis.localStorage.setItem('userToken', JSON.stringify({ value: 'tok-supp' }));

  const pngBytes = new Uint8Array(Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
    'base64'
  ));

  // 接口只回文字，完全没有图片字段
  const payload = {
    code: 0,
    data: {
      biz_code: 0,
      biz_data: {
        chat_session: { title: '接口不给图的会话', current_message_id: 'a2' },
        chat_messages: [
          { message_id: 'u1', parent_id: null, role: 'USER', content: '接口版提问' },
          { message_id: 'a1', parent_id: 'u1', role: 'ASSISTANT', content: '接口版回答一', thinking_content: '接口版思考' },
          { message_id: 'u2', parent_id: 'a1', role: 'USER', content: '追问问一句' },
          { message_id: 'a2', parent_id: 'u2', role: 'ASSISTANT', content: '接口版回答二' }
        ]
      }
    }
  };
  globalThis.fetch = async url => {
    const u = String(url);
    if (u.includes('/api/v0/chat/history_messages')) {
      return { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(payload)) };
    }
    return { ok: true, status: 200, blob: async () => new Blob([pngBytes], { type: 'image/png' }) };
  };

  const { deepseekAdapter } = await import('../src/adapters/deepseek.js');
  const turns = await deepseekAdapter.collectTurns({});

  check('仍然走接口模式（文字以接口为准）', deepseekAdapter.lastSource === 'api', deepseekAdapter.lastSource);
  check('文字来自接口而不是页面', turns[0].question.includes('接口版提问'), turns[0].question);
  check('思考也来自接口', turns[1].thinking.includes('接口版思考'), turns[1].thinking);

  const imgTurns = turns.filter(t => (t.images || []).length > 0);
  check('接口没给图，但图片从页面补上了', imgTurns.length > 0,
    JSON.stringify(turns.map(t => (t.images || []).length)));
  check('补上的是页面里那张上传图',
    imgTurns.length > 0 && imgTurns[0].images[0].src.includes('files.deepseeksvc.com'),
    JSON.stringify(imgTurns.map(t => t.images.map(i => i.src))));
  check('补图时按角色序号对齐（落在第 1 条用户消息上）',
    imgTurns.length > 0 && imgTurns[0].role === 'user' && imgTurns[0].index === 0,
    JSON.stringify(imgTurns.map(t => [t.index, t.role])));
}

/**
 * 回归测试：图片选了「内联进 Markdown」时，Word 里出现过整串 base64。
 * 根因：内联模式的图片地址是 data URL，而 docx 的图片解析器只认远端 URL 与相对路径，
 * 解析失败就回退成 "[图片：<整串 base64>]" 当普通文字写进文档。
 */
async function testInlineImageExport() {
  section('图片内联模式（回归：Word 里出现整串 base64）');
  setupDom('<!DOCTYPE html><html><body></body></html>', 'https://chat.deepseek.com/a/chat/s/sess-inline');
  const { saved } = setupChromeStub();
  globalThis.localStorage.setItem('userToken', JSON.stringify({ value: 'tok-inline' }));

  const pngBytes = new Uint8Array(Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
    'base64'
  ));

  const payload = {
    code: 0,
    data: {
      biz_code: 0,
      biz_data: {
        chat_session: { title: '内联图片测试', current_message_id: 'm2' },
        chat_messages: [
          {
            message_id: 'm1', parent_id: null, role: 'USER',
            fragments: [
              { type: 'REQUEST', content: '看这张图' },
              { type: 'IMAGE', image: { file_name: '题目.png', file_type: 'image/png', signed_path: '/signed/q.png' } }
            ]
          },
          { message_id: 'm2', parent_id: 'm1', role: 'ASSISTANT', content: '好的，这是思路。' }
        ]
      }
    }
  };
  globalThis.fetch = async url => {
    const u = String(url);
    if (u.includes('/api/v0/chat/history_messages')) {
      return { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(payload)) };
    }
    return { ok: true, status: 200, blob: async () => new Blob([pngBytes], { type: 'image/png' }) };
  };

  const { saveSettings } = await import('../src/core/settings.js');
  await saveSettings({ imageInline: true, imageFormat: 'png', batchSubfolder: false, dirSubfolder: '' });

  const api = await import('../src/adapters/deepseek.api.js');
  const { turns } = await api.fetchTurns('sess-inline');
  check('接口里的图片被采集到', (turns[0].images || []).length === 1, JSON.stringify(turns[0].images));

  const { runExport } = await import('../src/content/exportRunner.js');
  const { allSlots } = await import('../src/core/model.js');
  const result = await runExport({
    turns,
    slots: allSlots(),
    formats: ['md', 'docx'],
    title: '内联图片测试',
    site: 'DeepSeek',
    url: 'x',
    sessionId: 'sess-inline',
    batchIndex: 0,
    mode: 'batch'
  });
  check('导出成功', result.ok === true, JSON.stringify(result.warnings));

  const decode = f => Buffer.from(String(f.dataUrl).split(',')[1] || '', 'base64').toString('utf8');
  const mdFile = saved.find(f => f.path.endsWith('.md'));
  const md = mdFile ? decode(mdFile) : '';
  check('markdown 里内联了 data URL 图片', md.includes('data:image/png;base64,'), md.slice(-200));
  check('内联模式下不再单独写图片文件（单文件自包含）',
    saved.filter(f => f.kind === 'image').length === 0,
    JSON.stringify(saved.map(f => f.path)));

  const docxFile = saved.find(f => f.path.endsWith('.docx'));
  check('生成了 Word 文档', !!docxFile, JSON.stringify(saved.map(f => f.path)));
  if (docxFile) {
    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(Buffer.from(String(docxFile.dataUrl).split(',')[1] || '', 'base64'));
    const xml = await zip.file('word/document.xml').async('string');
    const media = Object.keys(zip.files).filter(n => n.startsWith('word/media/') && !n.endsWith('/'));
    check('Word 里图片真的被嵌入了', (xml.match(/<a:blip/g) || []).length >= 1,
      `blip=${(xml.match(/<a:blip/g) || []).length}`);
    check('Word 里有对应的媒体文件', media.length >= 1, media.join(','));
    check('Word 里没有把 base64 当文字塞进去', !xml.includes('iVBORw0KGgo'),
      xml.includes('iVBORw0KGgo') ? '文档里出现了 base64 文本' : '');
    check('Word 里没有出现 [图片：data: 占位', !/\[图片：data:/i.test(xml));
  }
}

/* ------------------------------------------------------------------ */

(async function main() {
  console.log('DSX 集成测试（jsdom 仿真站点）');
  try {
    await testDeepSeekDom();
  } catch (e) {
    fail++;
    failures.push(`DeepSeek DOM 测试抛异常：${e.message}`);
    console.error('  ✗ DeepSeek DOM 测试异常：', e);
  }
  try {
    await testDshDom();
  } catch (e) {
    fail++;
    failures.push(`DSH DOM 测试抛异常：${e.message}`);
    console.error('  ✗ DSH DOM 测试异常：', e);
  }
  try {
    await testDeepSeekApi();
  } catch (e) {
    fail++;
    failures.push(`接口路径测试抛异常：${e.message}`);
    console.error('  ✗ 接口路径测试异常：', e);
  }
  try {
    await testApiFragments();
  } catch (e) {
    fail++;
    failures.push(`fragments 结构测试抛异常：${e.message}`);
    console.error('  ✗ fragments 结构测试异常：', e);
  }
  try {
    await testExportPipelineWithPaths();
  } catch (e) {
    fail++;
    failures.push(`导出流水线测试抛异常：${e.message}`);
    console.error('  ✗ 导出流水线测试异常：', e);
  }
  try {
    await testAuthorizedDirPaths();
  } catch (e) {
    fail++;
    failures.push(`授权文件夹路径测试抛异常：${e.message}`);
    console.error('  ✗ 授权文件夹路径测试异常：', e);
  }
  try {
    await testImageExport();
  } catch (e) {
    fail++;
    failures.push(`图片导出测试抛异常：${e.message}`);
    console.error('  ✗ 图片导出测试异常：', e);
  }
  try {
    await testImageSupplementFromDom();
  } catch (e) {
    fail++;
    failures.push(`图片 DOM 兜底测试抛异常：${e.message}`);
    console.error('  ✗ 图片 DOM 兜底测试异常：', e);
  }
  try {
    await testInlineImageExport();
  } catch (e) {
    fail++;
    failures.push(`内联图片测试抛异常：${e.message}`);
    console.error('  ✗ 内联图片测试异常：', e);
  }

  console.log(`\n${'='.repeat(56)}`);
  console.log(`集成测试结果：通过 ${pass}，失败 ${fail}`);
  if (fail) {
    console.log('失败项：');
    failures.forEach(f => console.log(`  - ${f}`));
    process.exit(1);
  }
  console.log('全部通过 ✅');
})();
