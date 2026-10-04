/**
 * DSH（DeepSeek Harness 本地 GUI）站点适配器
 *
 * 与聊天站的关键差异（来自 dsh-client-ui-* 真实源码分析）：
 * - 消息条目带语义化 data-* 属性（data-chat-flow / -key / -kind / -turn），
 *   这是最稳的锚点；CSS Module 类名（Sixlwa_userRow 之类）每次构建都会变，
 *   所以只用 `[class*="_userRow"]` 这种「保留 localName、忽略 hash」的子串匹配。
 * - 深度思考是**懒渲染**的：折叠状态下 DOM 里只有一行摘要，
 *   必须点击 [data-disclosure-row] 展开后才能拿到原文。
 * - 会话 id 不在 DOM 里，SPA 也没有按会话的路由，
 *   所以批量导出用「点侧边栏行 → 等内容变化 → 抽取」这一套 DOM 流程。
 *
 * 最近验证：dsh 0.1.5-rc.1（本地源码）
 *
 * @file src/adapters/dsh.js
 */

import {
  findAllFirstMatch, findFirst, sortByDocumentOrder, waitUntilOrNull, waitUntilStable, queryAllUnion
} from './shared/selectors.js';
import { domToMarkdown } from '../core/domToMarkdown.js';
import { createTurn, createImage, ROLE, SLOTS } from '../core/model.js';
// 静态导入：IIFE 打包的内容脚本里动态 import() 无法解析（会去页面上下文找模块）
import { listSessionsViaApi, exportSessionZip } from './dsh.api.js';

/** DSH 的流程条目类型 → 我们关心的角色 */
const KIND_USER = ['user', 'steering'];
const KIND_ASSISTANT = ['assistant-step'];
/** 其余类型（context / system-prompt / tool / compaction ...）默认不进正文 */

export const dshSelectors = {
  /** 消息流容器（含 data-chat-flow） */
  flow: [
    '[data-chat-flow]',
    '[data-conversation-scroll] div[class*="_column"]',
    '[data-conversation-scroll]'
  ],
  /** 单条流程条目 */
  item: [
    '[data-chat-flow] > [data-chat-flow-key]',
    '[data-chat-flow-key]',
    '[data-chat-flow-kind]'
  ],
  /** 滚动容器 */
  scroll: [
    '[data-conversation-scroll]',
    '[data-conversation-scroll] div[class*="_scroll"]'
  ],
  /** 用户气泡 */
  userBubble: [
    '[class*="_bubble"]',
    '[class*="_userStack"]'
  ],
  /** 助手正文 markdown */
  markdown: [
    'div[class*="_markdown_"]',
    '[class*="_markdown"]'
  ],
  /** 思考块 */
  think: [
    'div[data-variant="think"]',
    '[data-variant="think"]'
  ],
  thinkToggle: [
    '[data-disclosure-row][aria-expanded]',
    '[data-disclosure-row]'
  ],
  thinkBody: [
    'div[class*="_thinkBody"]',
    'div[class*="_think"]'
  ],
  /** 折叠容器（思考 / 工具调用等），需要展开才能拿到内容 */
  disclosure: [
    '[data-disclosure-row][aria-expanded="false"]',
    '[data-disclosure-row]'
  ],
  /** 会话列表 */
  sessionList: [
    'div[role="tree"]',
    'div[class*="_list"][role="tree"]'
  ],
  sessionRow: [
    'div[role="treeitem"]',
    'div[class*="_sessionRow"]',
    'div[class*="_searchResultRow"]'
  ],
  sessionTitle: [
    '[class*="_title"]',
    'span'
  ],
  /** markdown 里的本地图片（同源可直接 fetch） */
  mdImage: [
    'img[class*="_image"]',
    'img[src^="/api/file"]'
  ],
  galleryImage: [
    'div[class*="_gallery"] button[data-variant] img',
    'img[src^="blob:"]',
    'img[src^="data:"]'
  ],
  /** 输入框锚点（插入插件按钮） */
  composer: [
    '[data-composer]',
    'form textarea',
    'textarea',
    '[contenteditable="true"]'
  ]
};

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
function raf() {
  return new Promise(r => requestAnimationFrame(() => r()));
}

/**
 * 判断当前页面是不是 DSH 界面。
 *
 * 注意：**不能用 `window.__DSH_BOOT__` 判断**——内容脚本跑在隔离世界里，
 * 拿不到页面 JS 设置的全局变量（曾经因此漏判）。只能看 DOM。
 */
export function looksLikeDsh() {
  if (typeof document === 'undefined') return false;
  if (document.querySelector('[data-chat-flow],[data-conversation-scroll]')) return true;
  if (document.querySelector('[data-chat-flow-kind],div[data-variant="think"]')) return true;
  if (document.querySelector('div[role="tree"] [role="treeitem"]')) return true;
  if (document.querySelector('div[class*="_sessionRow"]')) return true;
  return false;
}

/** 会话标题：优先页面上有 heading 语义的地方，其次 document.title */
export function getTitle() {
  const t = (document.title || '').replace(/\s*[-|·]\s*DSH.*$/i, '').replace(/^DSH\s*[-|·]\s*/i, '').trim();
  if (t && !/^(dsh|deepseek harness)$/i.test(t)) return t;
  const firstUser = document.querySelector('[data-chat-flow-kind="user"]');
  if (firstUser) {
    const txt = (firstUser.textContent || '').replace(/\s+/g, ' ').trim();
    if (txt) return txt.slice(0, 40);
  }
  return 'DSH 会话';
}

/** 取一条条目的 kind */
function kindOf(el) {
  return el.getAttribute('data-chat-flow-kind') || 'unknown';
}

/** 展开页面上所有折叠块（思考 / 回合过程），否则拿不到正文 */
async function expandAllCollapsed(limit = 400) {
  const rows = Array.from(document.querySelectorAll('[data-disclosure-row]'))
    .filter(r => r.getAttribute('aria-expanded') === 'false');
  let clicked = 0;
  for (const row of rows.slice(0, limit)) {
    try {
      row.click();
      clicked++;
      if (clicked % 8 === 0) await sleep(60);
    } catch (e) { /* 忽略 */ }
  }
  if (clicked > 0) await sleep(220);
  return clicked;
}

/** 找到消息流容器 */
function findFlow() {
  return findFirst(dshSelectors.flow, document, 'dsh.flow');
}

function findScroller() {
  const direct = document.querySelector('[data-conversation-scroll]');
  if (direct && direct.scrollHeight > direct.clientHeight + 40) return direct;
  const flow = findFlow();
  let el = flow && flow.parentElement;
  for (let i = 0; el && i < 12; i++, el = el.parentElement) {
    if (el === document.body) break;
    const st = window.getComputedStyle(el);
    if (/(auto|scroll|overlay)/.test(st.overflowY) && el.scrollHeight > el.clientHeight + 40) return el;
  }
  return direct || null;
}

/**
 * 滚动加载全部历史（虚拟列表必须边滚边收）。
 * @returns {Promise<Element[]>} 按文档顺序排列的流程条目
 */
async function loadAllItems() {
  const scroller = findScroller();
  const seen = new Map();
  const harvest = () => {
    findAllFirstMatch(dshSelectors.item, document).forEach((el, i) => {
      const key = el.getAttribute('data-chat-anchor-key')
        || el.getAttribute('data-chat-flow-key')
        || `idx-${i}-${(el.textContent || '').replace(/\s+/g, ' ').slice(0, 40)}`;
      if (!seen.has(key)) seen.set(key, el);
    });
  };

  harvest();
  if (scroller) {
    const original = scroller.scrollTop;
    scroller.scrollTop = 0;
    await raf();
    let last = -1;
    let stable = 0;
    for (let guard = 0; guard < 300; guard++) {
      harvest();
      scroller.scrollTop = Math.max(0, scroller.scrollTop - Math.max(240, scroller.clientHeight * 0.9));
      await raf();
      await sleep(50);
      if (seen.size === last) {
        stable++;
        if (scroller.scrollTop <= 0 && stable >= 3) break;
      } else {
        stable = 0;
        last = seen.size;
      }
      if (scroller.scrollTop <= 0) {
        await waitUntilStable(() => String(findAllFirstMatch(dshSelectors.item, document).length),
          { timeout: 4000, interval: 250, stableFor: 600, label: '等待 DSH 历史挂载' }).catch(() => null);
        harvest();
        if (seen.size === last) break;
        last = seen.size;
      }
    }
    scroller.scrollTop = original;
  }
  harvest();
  return sortByDocumentOrder(Array.from(seen.values()));
}

/** 收集一条条目里的图片 */
function collectImages(root, slot, flowOrigin) {
  const out = [];
  const seenSrc = new Set();
  const add = (img, kind) => {
    const src = img.getAttribute('src') || '';
    if (!src || seenSrc.has(src)) return;
    if (/avatar|favicon|logo|icon/i.test(src)) return;
    const w = img.naturalWidth || img.width || 0;
    const h = img.naturalHeight || img.height || 0;
    if (w && h && w < 24 && h < 24) return;
    seenSrc.add(src);
    out.push(createImage({ src, alt: img.getAttribute('alt') || '', slot, el: img, basename: '' }));
  };
  (root.querySelectorAll(dshSelectors.galleryImage.join(',')) || []).forEach(img => add(img, 'gallery'));
  (root.querySelectorAll(dshSelectors.mdImage.join(',')) || []).forEach(img => add(img, 'md'));
  // 兜底：任何 http/blob/data 图片
  root.querySelectorAll('img').forEach(img => add(img, 'raw'));
  return out;
}

/** 从一条 assistant-step 里抽出正文与思考 */
function extractAssistant(item) {
  let answer = '';
  const answerRoots = findAllFirstMatch(dshSelectors.markdown, item);
  if (answerRoots.length) {
    answer = answerRoots
      .map(root => domToMarkdown(root, { imagePlaceholder: () => '' }))
      .filter(Boolean)
      .join('\n\n');
  } else {
    // 没有 markdown 容器（纯文本/工具输出）：取条目自身的文本
    const body = item.querySelector('[class*="_body"]') || item;
    answer = domToMarkdown(body, { imagePlaceholder: () => '' });
  }
  return answer;
}

function extractThinking(item) {
  const thinks = findAllFirstMatch(dshSelectors.think, item);
  if (!thinks.length) return '';
  const parts = [];
  for (const think of thinks) {
    const body = findFirst(dshSelectors.thinkBody, think);
    const text = body ? (body.textContent || '') : '';
    if (text.trim()) parts.push(text.trim());
    else {
      // 折叠态只剩摘要，标记出来提示用户
      const summary = think.querySelector('[class*="_summaryText"]');
      if (summary && (summary.textContent || '').trim()) {
        parts.push(`（思考内容未展开，仅摘要）${summary.textContent.trim()}`);
      }
    }
  }
  return parts.join('\n\n');
}

function extractUser(item) {
  const bubble = findFirst(dshSelectors.userBubble, item);
  const root = bubble || item;
  return domToMarkdown(root, { imagePlaceholder: () => '' });
}

/* ------------------------------------------------------------------ */
/*                            适配器对象                                */
/* ------------------------------------------------------------------ */

export const dshAdapter = {
  id: 'dsh',
  label: 'DSH',
  siteLabel: 'DSH 本地界面',

  match(loc = location) {
    const h = loc.hostname;
    const isLoopback = h === '127.0.0.1' || h === 'localhost' || h === '[::1]' || h === '::1';
    if (!isLoopback) return false;
    // DSH 默认就跑在 3080 端口：端口对上就直接认，不依赖 DOM 是否已经渲染出来
    // （SPA 首屏渲染慢，只靠 DOM 判定会漏）
    if (String(loc.port) === '3080') return true;
    return looksLikeDsh();
  },

  async ready() {
    await waitUntilOrNull(
      () => findFlow() || document.querySelector('[data-chat-flow-kind]'),
      { timeout: 15000, interval: 250, label: '等待 DSH 会话渲染' }
    );
  },

  isGenerating() {
    // 流式时根节点带 data-streaming
    if (document.querySelector('[data-streaming]')) return true;
    const stop = document.querySelector('button[aria-label*="停止"], button[aria-label*="Stop" i]');
    return !!stop;
  },

  getTitle,
  getSessionId() {
    // DSH 没有会话 URL；用标题 + 会话列表选中项当稳定标识
    const active = document.querySelector('div[role="treeitem"][aria-selected="true"]');
    const name = active ? (active.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40) : '';
    return name || '';
  },

  /**
   * 抽取当前会话。
   * 注意：思考块是懒渲染的，必须先展开再读。
   */
  async collectTurns({ onProgress, expand = true } = {}) {
    await this.ready();
    if (expand) {
      const clicked = await expandAllCollapsed();
      if (clicked) await sleep(150);
    }
    const items = await loadAllItems();
    if (items.length === 0) return [];

    const turns = [];
    let idx = 0;
    // 用户条目与后续 assistant 条目配对成本条消息
    let pendingUser = null;

    const flush = () => {
      if (pendingUser) {
        turns.push(pendingUser);
        pendingUser = null;
      }
    };

    for (const item of items) {
      const kind = kindOf(item);
      if (onProgress && idx % 5 === 0) onProgress(idx + 1, items.length);
      idx++;

      if (KIND_USER.includes(kind)) {
        flush();
        const turn = createTurn({ index: turns.length, role: ROLE.USER, id: `dsh-u-${turns.length}` });
        turn.question = extractUser(item);
        turn.images = collectImages(item, SLOTS.QUESTION);
        if (turn.question || turn.images.length) pendingUser = turn;
        continue;
      }

      if (KIND_ASSISTANT.includes(kind)) {
        const turn = createTurn({ index: turns.length, role: ROLE.ASSISTANT, id: `dsh-a-${turns.length}` });
        turn.answer = extractAssistant(item);
        turn.thinking = extractThinking(item);
        turn.images = collectImages(item, SLOTS.ANSWER);
        if (pendingUser) {
          // 把提问挂到同一个「问答对」上：先输出用户，再输出 AI
          turns.push(pendingUser);
          pendingUser = null;
        }
        if (turn.answer || turn.thinking || turn.images.length) turns.push(turn);
        continue;
      }

      // turn-process / tool / command 等：只取其中的图片，文本默认不导出
      const extraImages = collectImages(item, SLOTS.ANSWER);
      if (extraImages.length && turns.length) {
        const last = turns[turns.length - 1];
        if (last.role === ROLE.ASSISTANT) {
          last.images = last.images.concat(extraImages.filter(x => !last.images.some(y => y.src === x.src)));
        }
      }
    }
    flush();

    // 重新编号
    turns.forEach((t, i) => { t.index = i; t.id = t.id || `dsh-${i}`; });
    return turns;
  },

  /**
   * 会话列表：DSH 的 session id 不在 DOM，所以这里返回 DOM 行本身，
   * 批量导出用「点击行 + 等内容变化」的方式逐个导出。
   */
  async listSessions({ onProgress } = {}) {
    const out = [];
    const seen = new Set();
    const listRoot = findFirst(dshSelectors.sessionList, document);

    const harvest = () => {
      const rows = findAllFirstMatch(dshSelectors.sessionRow, document);
      rows.forEach(row => {
        const titleEl = findFirst(dshSelectors.sessionTitle, row);
        const title = ((titleEl ? titleEl.textContent : row.textContent) || '').replace(/\s+/g, ' ').trim();
        if (!title) return;
        const key = title;
        if (seen.has(key)) return;
        seen.add(key);
        out.push({
          id: key,
          title: title.slice(0, 80),
          href: '',
          active: row.getAttribute('aria-selected') === 'true',
          el: row
        });
      });
    };

    harvest();
    // 会话区可能是虚拟列表：滚动它把更多行加载出来
    let last = out.length;
    let stable = 0;
    const scroller = findScrollerIn(listRoot);
    for (let i = 0; i < 40; i++) {
      if (scroller && scroller.scrollHeight > scroller.clientHeight + 10) {
        scroller.scrollTop = Math.min(scroller.scrollHeight, scroller.scrollTop + scroller.clientHeight * 0.9);
      }
      await sleep(160);
      harvest();
      if (out.length === last) {
        stable++;
        if (stable >= 3) break;
      } else {
        stable = 0;
        last = out.length;
      }
      if (onProgress) onProgress(out.length);
    }
    return out;
  },

  /** 点击侧边栏行打开会话 */
  async openSession(ref) {
    let row = ref.el && ref.el.isConnected ? ref.el : null;
    if (!row) {
      const rows = findAllFirstMatch(dshSelectors.sessionRow, document);
      row = rows.find(r => ((r.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80) === ref.title)) || null;
    }
    if (!row) return false;

    const before = fingerprint();
    try {
      row.scrollIntoView({ block: 'center' });
      await sleep(100);
      row.click();
    } catch (e) {
      return false;
    }

    // 等正文变化并稳定
    await waitUntilOrNull(() => fingerprint() !== before, { timeout: 12000, interval: 200, label: '等待会话切换' });
    await waitUntilStable(() => fingerprint(), { timeout: 20000, interval: 300, stableFor: 700, label: '等待会话内容稳定' }).catch(() => null);
    if (this.isGenerating()) {
      await waitUntilOrNull(() => !this.isGenerating(), { timeout: 90000, interval: 500, label: '等待生成结束' });
    }
    return fingerprint() !== before || !!document.querySelector('[data-chat-flow-kind]');
  },

  /** 面板按钮插入位置：输入框所在容器 */
  resolveUiAnchor() {
    const ta = document.querySelector('textarea, [contenteditable="true"]');
    if (!ta) return null;
    let el = ta;
    for (let i = 0; el && i < 6; i++, el = el.parentElement) {
      if (el === document.body) break;
      const r = el.getBoundingClientRect();
      if (r.width > 320 && el.parentElement) {
        return { root: el.parentElement, before: el };
      }
    }
    return null;
  },

  homeUrl() {
    return location.origin + '/';
  },

  /**
   * 页面诊断：DSH 的结构与接口到底通不通，一次性汇报出来。
   * 由于扩展无法在开发机上登录真实站点，这个报告是排查的主要依据。
   */
  async diagnose() {
    const report = {
      adapter: 'dsh',
      url: location.href,
      host: location.host,
      port: location.port,
      title: document.title,
      selectors: {},
      kinds: {},
      api: {}
    };

    const probes = {
      flow: dshSelectors.flow,
      item: dshSelectors.item,
      scroll: dshSelectors.scroll,
      markdown: dshSelectors.markdown,
      think: dshSelectors.think,
      thinkBody: dshSelectors.thinkBody,
      sessionList: dshSelectors.sessionList,
      sessionRow: dshSelectors.sessionRow
    };
    for (const [label, chain] of Object.entries(probes)) {
      report.selectors[label] = chain.map((sel, i) => {
        let count = 0;
        try {
          count = document.querySelectorAll(sel).length;
        } catch (e) {
          count = -1;
        }
        return { selector: sel, count, primary: i === 0 };
      });
    }

    document.querySelectorAll('[data-chat-flow-kind]').forEach(el => {
      const k = el.getAttribute('data-chat-flow-kind');
      report.kinds[k] = (report.kinds[k] || 0) + 1;
    });

    report.katexAnnotations = document.querySelectorAll('annotation[encoding="application/x-tex"]').length;
    report.collapsedDisclosures = document.querySelectorAll('[data-disclosure-row][aria-expanded="false"]').length;
    report.images = {
      blob: document.querySelectorAll('img[src^="blob:"]').length,
      apiFile: document.querySelectorAll('img[src^="/api/file"], img[src*="/api/file?"]').length,
      other: document.querySelectorAll('img[src^="http"]').length
    };

    // 接口连通性
    try {
      const sessions = await listSessionsViaApi();
      report.api.sessionList = {
        ok: true,
        count: sessions.length,
        sampleKeys: sessions[0] ? Object.keys(sessions[0]) : []
      };
      if (sessions[0] && sessions[0].sessionId) {
        try {
          const blob = await exportSessionZip(sessions[0].sessionId);
          report.api.sessionExport = { ok: true, bytes: blob.size, type: blob.type };
        } catch (e) {
          report.api.sessionExport = { ok: false, error: String(e && e.message || e) };
        }
      }
    } catch (e) {
      report.api.sessionList = { ok: false, error: String(e && e.message || e) };
    }

    return report;
  }
};

/** 内容指纹：用于判断会话是否已切换 */
function fingerprint() {
  const flow = findFlow() || document;
  const items = flow.querySelectorAll('[data-chat-flow-key], [data-chat-flow-kind]');
  const first = items[0];
  const last = items[items.length - 1];
  return [
    items.length,
    first ? (first.textContent || '').replace(/\s+/g, '').slice(0, 40) : '',
    last ? (last.textContent || '').replace(/\s+/g, '').slice(0, 40) : ''
  ].join('|');
}

function findScrollerIn(listRoot) {
  if (!listRoot) return null;
  if (listRoot.scrollHeight > listRoot.clientHeight + 10) return listRoot;
  let el = listRoot.parentElement;
  for (let i = 0; el && i < 8; i++, el = el.parentElement) {
    const st = window.getComputedStyle(el);
    if (/(auto|scroll|overlay)/.test(st.overflowY) && el.scrollHeight > el.clientHeight + 10) return el;
  }
  return null;
}
