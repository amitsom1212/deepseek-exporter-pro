/**
 * DeepSeek 站点适配器
 *
 * 职责：把 chat.deepseek.com 的 DOM 翻译成统一的 Turn 模型，
 * 并提供批量导出所需的「会话列表枚举 / 打开指定会话」能力。
 *
 * @file src/adapters/deepseek.js
 */

import { ds, parseSessionId, currentSessionId } from './deepseek.selectors.js';
import {
  findFirst, findAllFirstMatch, queryAllUnion, sortByDocumentOrder,
  waitUntilOrNull, waitUntilStable, isVisible, isOwnUI, matchesAny
} from './shared/selectors.js';
import { domToMarkdown } from '../core/domToMarkdown.js';
import { createTurn, createImage, ROLE, SLOTS } from '../core/model.js';
import { getSettings } from '../core/settings.js';
import {
  apiAvailable, fetchTurns, fetchSessionList, fetchConversation, currentBranch, getToken,
  turnsHaveText, lastApiShape, extractMessageParts,
  collectImageAssetsFromMessage, describeImageShape
} from './deepseek.api.js';

/** 用户消息里要剔除的控件节点（保留带 tabindex 的文件卡片） */
const CONTROL_NODE_SELECTOR = 'button:not([tabindex]), svg, style, script, noscript, [aria-hidden="true"]';

/**
 * 判断一条消息是用户还是 AI。
 *
 * 策略（与 sati0121/DeepSeek-Exporter 一致，并补充显式角色信号）：
 * 1. 显式信号优先：data-role / class 里出现 user|assistant。
 * 2. 结构信号：含 .ds-markdown 或 .ds-think-content 的一定是 AI（用户消息是纯文本）。
 * 3. 交叉校验：结构信号与奇偶位置整体一致率 < 75% 时，整体回退奇偶判断。
 */
export function detectRoles(messages) {
  const explicit = messages.map(msg => {
    const attr = (msg.getAttribute && (msg.getAttribute('data-role') || msg.getAttribute('data-message-role'))) || '';
    const cls = typeof msg.className === 'string' ? msg.className.toLowerCase() : '';
    const probe = `${attr} ${cls}`;
    if (/user|人类|我/.test(probe) && !/assistant/.test(probe)) return ROLE.USER;
    if (/assistant|ai-|bot|reply/.test(probe)) return ROLE.ASSISTANT;
    return null;
  });

  const structural = messages.map(msg => {
    if (findFirst(ds.thinkContent, msg)) return ROLE.ASSISTANT;
    if (findFirst(ds.aiContent, msg)) return ROLE.ASSISTANT;
    return null;
  });

  const explicitHits = explicit.filter(Boolean).length;
  const structuralHits = structural.filter(Boolean).length;

  const score = cand => {
    let agree = 0;
    let total = 0;
    cand.forEach((s, i) => {
      if (!s) return;
      total++;
      const parity = i % 2 === 0 ? ROLE.USER : ROLE.ASSISTANT;
      if (s === parity) agree++;
    });
    return total === 0 ? 0 : agree / total;
  };

  const useExplicit = explicitHits > 0 && score(explicit) > 0.75;
  const useStructural = structuralHits > 0 && score(structural) > 0.75;
  if (!useExplicit && !useStructural && structuralHits > 0) {
    console.warn('[DSX] 角色结构信号与消息顺序不一致，回退奇偶判断');
  }

  return messages.map((msg, i) => {
    if (useExplicit && explicit[i]) return explicit[i];
    if (useStructural && structural[i]) return structural[i];
    return i % 2 === 0 ? ROLE.USER : ROLE.ASSISTANT;
  });
}

/** 克隆并剔除控件节点 */
function stripControls(container) {
  try {
    const clone = container.cloneNode(true);
    clone.querySelectorAll(CONTROL_NODE_SELECTOR).forEach(el => el.remove());
    return clone;
  } catch (e) {
    return container;
  }
}

/** 收集内容根里的图片（排除头像/装饰图） */
function collectImages(rootEl, slot, warnings) {
  if (!rootEl) return [];
  const out = [];
  const imgs = rootEl.querySelectorAll('img');
  imgs.forEach(img => {
    const src = img.getAttribute('src') || img.getAttribute('data-src') || '';
    if (!src) return;
    if (matchesAny(ds.imageUrlExcludePatterns, src)) return;
    const w = img.naturalWidth || img.width || 0;
    const h = img.naturalHeight || img.height || 0;
    // 小于 24px 的多半是图标
    if (w && h && w < 24 && h < 24) return;
    out.push(createImage({
      src,
      alt: img.getAttribute('alt') || '',
      basename: '',
      slot,
      el: img
    }));
  });
  return out;
}

/** AI 回答：优先用线上 bundle 确认过的正文锚点，再退回「不在思考块内的第一个 markdown」 */
function pickAnswerRoot(msgContainer) {
  // .ds-assistant-message-main-content 是 DeepSeek 源码里助手分支专用的正文容器，
  // 比通用 .ds-markdown 更精确（不会被思考块里的 markdown 抢先命中）
  const direct = findFirst(ds.assistantBody, msgContainer, 'assistantBody');
  if (direct) return direct;

  const think = findFirst(ds.thinkContent, msgContainer);
  const all = findAllFirstMatch(ds.aiContent, msgContainer);
  for (const md of all) {
    if (think && think.contains(md)) continue;
    return md;
  }
  // 没有 markdown（简短回复如 "1"）：取思考块之后的第一个非空兄弟节点
  if (think && think.parentElement) {
    const siblings = Array.from(think.parentElement.children);
    const idx = siblings.indexOf(think);
    for (let i = idx + 1; i < siblings.length; i++) {
      const sib = siblings[i];
      const text = (sib.textContent || '').trim();
      if (text && text.length < 2000) return sib;
    }
  }
  return msgContainer;
}

/** 思考块根：优先取其中的 markdown，思考内容为空时尝试展开 */
async function pickThinkingRoot(msgContainer) {
  const think = findFirst(ds.thinkContent, msgContainer);
  if (!think) return null;
  const inner = findFirst(ds.aiContent, think);
  const current = inner || think;
  if ((current.textContent || '').trim().length > 0) return current;

  // 折叠状态下内容可能未渲染：点开再试一次
  const toggle = findFirst(ds.thinkToggle, think) || think;
  try {
    toggle.click();
    await new Promise(r => setTimeout(r, 350));
  } catch (e) { /* 忽略 */ }
  const again = findFirst(ds.aiContent, think) || think;
  return (again.textContent || '').trim().length > 0 ? again : null;
}

/**
 * 滚动到顶把历史消息全部加载出来，返回按文档顺序排列的消息容器。
 * DeepSeek 的消息列表是虚拟列表：必须在滚动过程中实时收集节点。
 */
export async function loadAllMessages() {
  const scrollContainer = findScrollContainer();
  const collected = new Map();

  const harvest = () => {
    findAllFirstMatch(ds.messageContainer, document).forEach(el => {
      if (findFirst(ds.skeleton, el)) return;
      const text = (el.textContent || '').trim();
      if (!text && !el.querySelector('img, canvas, [tabindex="0"]')) return;
      const key = elementKey(el);
      if (!collected.has(key)) collected.set(key, el);
    });
  };

  if (!scrollContainer) {
    harvest();
  } else {
    const original = scrollContainer.scrollTop;
    // 先到底，确保最新消息挂载
    scrollContainer.scrollTop = scrollContainer.scrollHeight;
    await raf();
    harvest();

    // 逐步向上滚，每步都收割一次，直到滚到顶且数量稳定
    let lastCount = -1;
    let stableRounds = 0;
    for (let guard = 0; guard < 400; guard++) {
      harvest();
      scrollContainer.scrollTop = Math.max(0, scrollContainer.scrollTop - Math.max(200, scrollContainer.clientHeight * 0.85));
      await raf();
      await sleep(60);
      if (collected.size === lastCount) {
        stableRounds++;
        if (scrollContainer.scrollTop <= 0 && stableRounds >= 3) break;
      } else {
        stableRounds = 0;
        lastCount = collected.size;
      }
      if (scrollContainer.scrollTop <= 0) {
        // 到顶后再等异步挂载
        await waitUntilStable(
          () => String(findAllFirstMatch(ds.messageContainer, document).length),
          { timeout: 6000, interval: 250, stableFor: 700, label: '等待历史消息挂载' }
        ).catch(() => null);
        harvest();
        if (collected.size === lastCount) break;
        lastCount = collected.size;
      }
    }
    scrollContainer.scrollTop = original;
  }

  harvest();
  const list = sortByDocumentOrder(Array.from(collected.values()));
  return list;
}

function raf() {
  return new Promise(r => requestAnimationFrame(() => r()));
}
function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/** 虚拟列表会复用节点，用「文本首段 + 图片数 + 代码块数」当签名 */
function elementKey(el) {
  const text = (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  const imgs = el.querySelectorAll('img').length;
  return `${text}|${imgs}|${el.querySelectorAll('pre').length}`;
}

/** 找到消息列表所在的主滚动容器 */
export function findScrollContainer() {
  const candidates = queryAllUnion(ds.scrollArea, document);
  for (const c of candidates) {
    if (c.scrollHeight > c.clientHeight + 40 && c.clientHeight > 120) return c;
  }
  // 结构兜底：消息容器的最近可滚动祖先
  const msg = findFirst(ds.messageContainer, document);
  let el = msg && msg.parentElement;
  for (let i = 0; el && i < 12; i++, el = el.parentElement) {
    if (el === document.body) break;
    const st = window.getComputedStyle(el);
    if (/(auto|scroll|overlay)/.test(st.overflowY) && el.scrollHeight > el.clientHeight + 40) return el;
  }
  return null;
}

/**
 * 接口只给了文字、没给图片时，从页面 DOM 补一次图片。
 *
 * 为什么需要：DeepSeek 的上传图片有时只出现在页面里（blob:/图床直链），
 * 接口的 chat_messages 里并没有对应字段。按「同角色的第 n 条」对齐，
 * 比按绝对位置对齐更抗消息数量差异。
 *
 * @param {object[]} turns 接口抽好的消息（会被就地补上 images）
 * @returns {Promise<number>} 补上的图片数量
 */
async function supplementImagesFromDom(turns) {
  if (!turns || !turns.length) return 0;
  const msgs = await loadAllMessages();
  if (!msgs.length) return 0;
  const roles = detectRoles(msgs);

  // 按角色分别记录「第 n 条消息上的图片」
  const byRole = { user: [], assistant: [] };
  let uc = 0;
  let ac = 0;
  msgs.forEach((el, i) => {
    const isUser = roles[i] === ROLE.USER;
    const seq = isUser ? uc++ : ac++;
    const imgs = collectImages(el, isUser ? SLOTS.QUESTION : SLOTS.ANSWER);
    byRole[isUser ? 'user' : 'assistant'][seq] = imgs;
  });

  let u = 0;
  let a = 0;
  let added = 0;
  for (const turn of turns) {
    const isUser = turn.role === ROLE.USER;
    const seq = isUser ? u++ : a++;
    const imgs = byRole[isUser ? 'user' : 'assistant'][seq];
    if (imgs && imgs.length && (turn.images || []).length === 0) {
      turn.images = imgs;
      added += imgs.length;
    }
  }
  return added;
}

/** 会话标题 */
export function getTitle() {  let title = (document.title || '').replace(/\s*[-|·]\s*DeepSeek.*$/i, '').replace(/^DeepSeek\s*[-|·]\s*/i, '').trim();
  if (title && !/^DeepSeek$/i.test(title)) return title;
  // 退回首条用户消息
  const msgs = findAllFirstMatch(ds.messageContainer, document);
  if (msgs.length > 0) {
    const t = (msgs[0].textContent || '').replace(/\s+/g, ' ').trim();
    if (t) return t.slice(0, 40);
  }
  return 'DeepSeek 对话';
}

/* ------------------------------------------------------------------ */
/*                            适配器对象                                */
/* ------------------------------------------------------------------ */

export const deepseekAdapter = {
  id: 'deepseek',
  label: 'DeepSeek',
  siteLabel: 'chat.deepseek.com',

  match(loc = location) {
    return /(^|\.)deepseek\.com$/i.test(loc.hostname) || loc.hostname.includes('deepseek');
  },

  async ready() {
    await waitUntilOrNull(
      () => findFirst(ds.messageContainer, document),
      { timeout: 15000, interval: 200, label: '等待 DeepSeek 消息渲染' }
    );
  },

  /** 数据来源标记：'api' | 'dom' */
  lastSource: '',
  /** 接口取到的标题（比 document.title 准） */
  apiTitle: '',
  /** 批量导出时由 openSession 指定要抓哪个会话 */
  pendingSessionId: '',

  /** 是否走接口：设置开启 + 本地能拿到令牌 */
  async preferApi() {
    try {
      const s = await getSettings();
      if (s.useApi === false) return false;
    } catch (e) { /* 读不到设置就按默认开启 */ }
    return apiAvailable();
  },

  isGenerating() {
    if (findFirst(ds.stopButton, document)) return true;
    const cursor = findFirst(ds.streamingCursor, document);
    if (cursor) {
      const st = window.getComputedStyle(cursor);
      if (st.display !== 'none' && st.visibility !== 'hidden') return true;
    }
    return false;
  },

  getTitle() {
    if (this.apiTitle) return this.apiTitle;
    return getTitle();
  },
  getSessionId: currentSessionId,

  /** 把整段对话抽成 Turn[]：接口优先，失败自动回退 DOM */
  async collectTurns({ onProgress, forceDom = false } = {}) {
    if (!forceDom && await this.preferApi()) {
      const sid = this.pendingSessionId || currentSessionId();
      if (sid) {
        try {
          const { turns, title, shape } = await fetchTurns(sid);
          if (turns.length && turnsHaveText(turns)) {
            this.lastSource = 'api';
            if (title) this.apiTitle = title;
            this.lastShape = shape;
            this.lastError = '';
            // 接口常常只给文字、不给上传图片的地址（图片只在页面 DOM 里）。
            // 一旦接口一张图都没给，就从页面补一次——否则用户勾了「图片」却什么都拿不到。
            if (!turns.some(t => (t.images || []).length > 0)) {
              try {
                const added = await supplementImagesFromDom(turns);
                if (added > 0) {
                  console.debug(`[DSX] 接口未提供图片，已从页面补充 ${added} 张`);
                  this.imagesFromDom = added;
                }
              } catch (e) {
                console.warn('[DSX] 从页面补充图片失败：', e && e.message);
              }
            }
            console.debug(`[DSX] 接口模式读取成功：${turns.length} 条消息`);
            return turns;
          }
          // 关键兜底：接口返回了消息但一条文字都没解析出来，说明站点又改了返回结构。
          // 与其给用户一个空白面板，不如回退 DOM 抓取，并把结构特征留给诊断用。
          if (turns.length) {
            this.lastShape = shape;
            this.lastError = `接口返回了 ${turns.length} 条消息但没解析出文字（字段：${(shape.firstMessageKeys || []).join(',') || '未知'}），已回退页面抓取`;
            console.warn('[DSX] 接口结构无法解析，回退 DOM：', shape.firstMessageKeys);
          } else {
            console.warn('[DSX] 接口返回 0 条消息，回退 DOM');
          }
        } catch (e) {
          console.warn('[DSX] 接口读取失败，回退 DOM：', e && e.message);
          this.lastError = String(e && e.message || e);
        }
      }
    }
    this.lastSource = 'dom';
    return await this.collectTurnsFromDom({ onProgress });
  },

  /** 纯 DOM 抽取（接口不可用时的兜底） */
  async collectTurnsFromDom({ onProgress } = {}) {
    await this.ready();
    const messages = await loadAllMessages();
    if (messages.length === 0) return [];
    const roles = detectRoles(messages);
    const turns = [];

    for (let i = 0; i < messages.length; i++) {
      const el = messages[i];
      const role = roles[i];
      if (onProgress && i % 5 === 0) onProgress(i + 1, messages.length);

      const turn = createTurn({ index: i, role, id: `ds-${i}` });

      if (role === ROLE.USER) {
        const clone = stripControls(el);
        turn.question = domToMarkdown(clone, { imagePlaceholder: () => '' });
        turn.images = collectImages(el, SLOTS.QUESTION);
      } else {
        const thinkRoot = await pickThinkingRoot(el);
        if (thinkRoot) {
          turn.thinking = domToMarkdown(thinkRoot, { imagePlaceholder: () => '' });
        }
        const answerRoot = pickAnswerRoot(el);
        if (answerRoot) {
          const clone = answerRoot === el ? stripControls(el) : answerRoot;
          turn.answer = domToMarkdown(clone, { imagePlaceholder: () => '' });
        }
        turn.images = collectImages(answerRoot || el, SLOTS.ANSWER);
        if (thinkRoot) {
          turn.images = turn.images.concat(
            collectImages(thinkRoot, SLOTS.THINKING).filter(
              img => !turn.images.some(x => x.src === img.src)
            )
          );
        }
      }

      // 完全空的消息（例如只渲染了骨架）不入列
      if (!turn.question && !turn.thinking && !turn.answer && turn.images.length === 0) continue;
      turns.push(turn);
    }
    return turns;
  },

  /**
   * 枚举侧边栏会话。
   * 侧边栏可能是虚拟列表，因此边滚边收集，并对 id 去重。
   */
  async listSessions({ onProgress } = {}) {
    // 接口优先：翻页一次就能拿到全部会话（含 id 与标题），既不用点也不用滚
    if (await this.preferApi()) {
      try {
        const list = await fetchSessionList({ onPage: onProgress });
        if (list.length) {
          this.lastSource = 'api';
          console.debug(`[DSX] 接口模式获取会话列表：${list.length} 个`);
          const cur = currentSessionId();
          return list.map(s => ({
            id: s.id,
            title: s.title,
            href: `${location.origin}/a/chat/s/${s.id}`,
            active: !!cur && s.id === cur,
            viaApi: true,
            updatedAt: s.updated_at
          }));
        }
      } catch (e) {
        console.warn('[DSX] 接口获取会话列表失败，回退 DOM：', e && e.message);
        this.lastError = String(e && e.message || e);
      }
    }
    this.lastSource = 'dom';
    const found = new Map();

    const harvest = () => {
      findAllFirstMatch(ds.sessionRow, document).forEach(row => {
        const href = row.getAttribute('href') || row.querySelector('a[href]')?.getAttribute('href') || '';
        const id = parseSessionId(href);
        if (!id || found.has(id)) return;
        const title = (row.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80);
        found.set(id, {
          id,
          title: title || '未命名会话',
          href: href.startsWith('http') ? href : `${location.origin}${href.startsWith('/') ? '' : '/'}${href}`,
          active: row.getAttribute('aria-current') === 'page' || /active|selected/i.test(String(row.className || ''))
        });
      });
    };

    harvest();

    // 展开历史 / 滚动侧边栏以加载更多
    const listRoot = findFirst(ds.sessionList, document) || document.body;
    const scroller = findScrollableAncestor(listRoot) || listRoot;
    let last = found.size;
    let stable = 0;
    for (let i = 0; i < 60; i++) {
      const more = findFirst(ds.sessionMore, document);
      if (more && isVisible(more)) {
        try { more.click(); } catch (e) { /* 忽略 */ }
      }
      if (scroller && scroller.scrollHeight > scroller.clientHeight + 20) {
        scroller.scrollTop = scroller.scrollHeight;
      }
      await sleep(220);
      harvest();
      if (found.size === last) {
        stable++;
        if (stable >= 3) break;
      } else {
        stable = 0;
        last = found.size;
      }
      if (onProgress) onProgress(found.size);
    }

    // 当前会话可能没出现在列表里，补上
    const cur = currentSessionId();
    if (cur && !found.has(cur)) {
      found.set(cur, { id: cur, title: `${getTitle()}（当前）`, href: location.href, active: true });
    }

    return Array.from(found.values());
  },

  /** 打开指定会话；接口模式下只是记住 id，不需要真的切换页面 */
  async openSession(ref) {
    if (ref && ref.id && (ref.viaApi || await this.preferApi())) {
      this.pendingSessionId = ref.id;
      this.apiTitle = ref.title || '';
      this.lastSource = 'api';
      return true;
    }
    this.pendingSessionId = '';
    const target = ref.id;
    const row = findSessionRow(target);
    if (row) {
      try {
        row.scrollIntoView({ block: 'center' });
        await sleep(120);
        row.click();
      } catch (e) {
        location.href = ref.href || location.href;
      }
    } else if (ref.href) {
      location.href = ref.href;
    } else {
      location.href = `${location.origin}/a/chat/s/${target}`;
    }
    return await this.waitForSession(target);
  },

  /** 等待指定会话真正加载完成 */
  async waitForSession(id, timeout = 30000) {
    const started = Date.now();
    // 1) URL 先变
    await waitUntilOrNull(() => location.href.includes(id), { timeout: 8000, interval: 150, label: '等待会话 URL 切换' });
    // 2) 消息渲染并稳定
    await waitUntilOrNull(
      () => findAllFirstMatch(ds.messageContainer, document).length > 0,
      { timeout: Math.max(4000, timeout - (Date.now() - started)), interval: 200, label: '等待会话消息渲染' }
    );
    await waitUntilStable(
      () => String(findAllFirstMatch(ds.messageContainer, document).length),
      { timeout: 12000, interval: 250, stableFor: 700, label: '等待会话内容稳定' }
    ).catch(() => null);
    // 3) 生成中则等待（最多 90 秒）
    if (this.isGenerating()) {
      await waitUntilOrNull(() => !this.isGenerating(), { timeout: 90000, interval: 500, label: '等待生成结束' });
    }
    return location.href.includes(id) || findAllFirstMatch(ds.messageContainer, document).length > 0;
  },

  /** 插件 UI 插入位置（输入框上方）；找不到时返回 null，由 UI 降级为固定定位 */
  resolveUiAnchor() {
    for (let i = 0; i < ds.composerAnchor.length; i++) {
      const bar = document.querySelector(ds.composerAnchor[i]);
      if (!bar || isOwnUI(bar)) continue;
      const sendArea = bar.querySelector('.bf38813a');
      if (sendArea && sendArea.parentElement) {
        return { root: sendArea.parentElement, before: sendArea };
      }
      return { root: bar, before: bar.lastElementChild };
    }
    // 结构兜底：最大 textarea 的祖先容器
    const ta = pickComposerTextarea();
    if (ta) {
      const root = climbToComposerRoot(ta);
      if (root) return { root, before: null };
    }
    return null;
  },

  homeUrl() {
    return `${location.origin}/`;
  },

  /**
   * 页面诊断：把「哪些选择器命中了什么」汇报出来。
   * 真实站点的 DOM 随时可能改版，这个报告是远程排查的唯一抓手。
   */
  async diagnose() {
    const report = {
      adapter: 'deepseek',
      url: location.href,
      host: location.host,
      port: location.port,
      title: document.title,
      sessionId: currentSessionId(),
      selectors: {},
      api: await probeApi()
    };
    const probes = {
      messageContainer: ds.messageContainer,
      assistantBody: ds.assistantBody,
      aiContent: ds.aiContent,
      thinkContent: ds.thinkContent,
      scrollArea: ds.scrollArea,
      sessionRow: ds.sessionRow,
      composerAnchor: ds.composerAnchor,
      stopButton: ds.stopButton
    };
    for (const [label, chain] of Object.entries(probes)) {
      const hits = [];
      for (let i = 0; i < chain.length; i++) {
        let n = 0;
        try {
          n = document.querySelectorAll(chain[i]).length;
        } catch (e) {
          n = -1;
        }
        hits.push({ selector: chain[i], count: n, primary: i === 0 });
      }
      report.selectors[label] = hits;
    }
    // 抽样一条消息，看看能抽出什么
    try {
      const msgs = findAllFirstMatch(ds.messageContainer, document);
      report.messageCount = msgs.length;
      if (msgs.length) {
        const first = msgs[0];
        report.firstMessageSample = {
          kinds: detectRoles([first])[0],
          hasAssistantBody: !!findFirst(ds.assistantBody, first),
          hasMarkdown: !!findFirst(ds.aiContent, first),
          hasThink: !!findFirst(ds.thinkContent, first),
          textHead: (first.textContent || '').replace(/\s+/g, ' ').slice(0, 160)
        };
      }
    } catch (e) {
      report.sampleError = String(e && e.message || e);
    }
    return report;
  }
};

/** 探测内部接口是否可用（不求全，只求能一眼看出卡在哪一步） */
async function probeApi() {
  const out = { tokenFound: false, endpoints: {} };
  try {
    const tok = getToken();
    out.tokenFound = !!tok;
    out.tokenLength = tok ? tok.length : 0;
  } catch (e) {
    out.tokenError = String(e && e.message || e);
  }
  if (!out.tokenFound) {
    out.note = 'localStorage 里没找到 userToken —— 批量导出只能走页面 DOM 流程（需要保持侧边栏展开）';
    return out;
  }
  try {
    const list = await fetchSessionList({ maxPages: 2 });
    out.endpoints.sessionPage = { ok: true, count: list.length, sample: list[0] || null };
  } catch (e) {
    out.endpoints.sessionPage = { ok: false, error: String(e && e.message || e) };
  }
  const sid = currentSessionId();
  if (sid) {
    try {
      const data = await fetchConversation(sid);
      const branch = currentBranch(data);
      const first = branch[0] || {};
      // 关键词段结构：站点改版时这是定位"正文被搬到哪个字段"的关键证据
      const shape = extractMessageParts(first);
      out.endpoints.historyMessages = {
        ok: true,
        sessionTitle: (data.chat_session && data.chat_session.title) || '',
        totalMessages: (data.chat_messages || []).length,
        branchLength: branch.length,
        sampleKeys: Object.keys(first).slice(0, 24),
        roles: [...new Set(branch.map(m => m.role))],
        hasThinking: branch.some(m => !!m.thinking_content),
        hasFiles: branch.some(m => !!(m.files || m.file_list || m.attachments)),
        hasFragments: branch.some(m => Array.isArray(m.fragments) && m.fragments.length > 0),
        fragmentTypes: shape.fragmentTypes,
        parseSource: shape.source,
        firstMessageKeyPreview: previewKeys(first),
        // 图片排查：接口里到底有没有图片、藏在哪个字段（用户报「勾了图片却没导出」时看这里）
        imageInfo: (() => {
          const withImages = [];
          for (const m of branch) {
            let assets = [];
            try {
              assets = collectImageAssetsFromMessage(m, 'probe');
            } catch (e) { /* 忽略 */ }
            if (assets.length) {
              withImages.push({
                role: m.role,
                count: assets.length,
                sample: String(assets[0].src).slice(0, 110)
              });
            }
          }
          const userMsg = branch.find(m => String(m.role || '').toUpperCase() === 'USER') || branch[0] || null;
          return {
            messagesWithImages: withImages.length,
            samples: withImages.slice(0, 3),
            firstUserShape: userMsg ? describeImageShape(userMsg) : null
          };
        })()
      };
    } catch (e) {
      out.endpoints.historyMessages = { ok: false, error: String(e && e.message || e) };
    }
  } else {
    out.endpoints.historyMessages = { ok: false, error: '当前 URL 里没有会话 id（请打开一个具体对话）' };
  }
  out.lastShape = { ...lastApiShape };
  return out;
}

/** 只保留字段名与值的类型/长度，避免把对话内容带进诊断报告 */
function previewKeys(obj) {
  const out = {};
  if (!obj || typeof obj !== 'object') return out;
  for (const k of Object.keys(obj).slice(0, 24)) {
    const v = obj[k];
    if (typeof v === 'string') out[k] = `string(${v.length})`;
    else if (Array.isArray(v)) out[k] = `array(${v.length})`;
    else if (v === null) out[k] = 'null';
    else out[k] = typeof v;
  }
  return out;
}

/** 按 id 找到当前 DOM 里的侧边栏条目（每次现查，避免 React 复用节点导致点错） */
export function findSessionRow(id) {
  const rows = findAllFirstMatch(ds.sessionRow, document);
  for (const row of rows) {
    const href = row.getAttribute('href') || row.querySelector('a[href]')?.getAttribute('href') || '';
    if (parseSessionId(href) === id) return row;
  }
  return null;
}

function findScrollableAncestor(el) {
  let cur = el;
  for (let i = 0; cur && i < 12; i++, cur = cur.parentElement) {
    if (cur === document.body) break;
    const st = window.getComputedStyle(cur);
    if (/(auto|scroll|overlay)/.test(st.overflowY) && cur.scrollHeight > cur.clientHeight + 20) return cur;
  }
  return null;
}

function pickComposerTextarea() {
  let best = null;
  let bestArea = 0;
  document.querySelectorAll('textarea, [contenteditable="true"]').forEach(el => {
    if (isOwnUI(el) || !isVisible(el)) return;
    const r = el.getBoundingClientRect();
    const area = r.width * r.height;
    if (area > bestArea) {
      bestArea = area;
      best = el;
    }
  });
  return best;
}

function climbToComposerRoot(ta) {
  let el = ta.parentElement;
  for (let i = 0; el && i < 8; i++, el = el.parentElement) {
    if (el === document.body || el === document.documentElement) break;
    const r = el.getBoundingClientRect();
    if (el.querySelector('button, [role="button"], [class*="ds-icon-button"]') && r.width > 300 && r.bottom > window.innerHeight * 0.5) {
      return el;
    }
  }
  return null;
}
