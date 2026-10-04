/**
 * 选择器工具（站点无关）
 *
 * 核心约定：每个选择器都是一条「候选链」数组，按优先级从高到低排列。
 * 语义/结构候选在前，易变的哈希类名兜底。命中回退项时打印日志，
 * 便于在真实站点上确认哪条候选在生效（设置页打开「详细日志」即可看到）。
 *
 * @file src/adapters/shared/selectors.js
 */

/** 插件自身 UI 根节点 —— 任何查询都要排除 */
export const OWN_UI_SELECTOR = '.dsx-root, .dsx-toast, #dsx-panel-host';

/** 元素是否属于插件自身 UI */
export function isOwnUI(el) {
  if (!el || !el.closest) return false;
  try {
    return !!el.closest(OWN_UI_SELECTOR);
  } catch (e) {
    return false;
  }
}

/** 元素是否有可见尺寸（display:none / 零尺寸都算不可见） */
export function isVisible(el) {
  if (!el || !el.isConnected) return false;
  const r = el.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return false;
  const st = window.getComputedStyle(el);
  return st.visibility !== 'hidden' && st.display !== 'none';
}

const loggedPrimary = new Set();

function logHit(label, index, selector, verbose) {
  if (!label) return;
  if (index > 0) {
    console.debug(`[DSX][selector] ${label} → fallback #${index}: ${selector}`);
    return;
  }
  if (verbose && !loggedPrimary.has(label)) {
    loggedPrimary.add(label);
    console.debug(`[DSX][selector] ${label} → primary: ${selector}`);
  }
}

/** 按候选链找第一个匹配元素（跳过插件自身 UI） */
export function findFirst(candidates, root = document, label = '') {
  if (!candidates) return null;
  for (let i = 0; i < candidates.length; i++) {
    let el = null;
    try {
      el = root.querySelector(candidates[i]);
    } catch (e) {
      continue;
    }
    if (el && !isOwnUI(el)) {
      logHit(label, i, candidates[i]);
      return el;
    }
  }
  return null;
}

/** 找到第一个能匹配到节点的候选，返回其全部匹配（不跨候选合并） */
export function findAllFirstMatch(candidates, root = document, label = '') {
  if (!candidates) return [];
  for (let i = 0; i < candidates.length; i++) {
    let nodes = [];
    try {
      nodes = Array.from(root.querySelectorAll(candidates[i])).filter(n => !isOwnUI(n));
    } catch (e) {
      continue;
    }
    if (nodes.length > 0) {
      logHit(label, i, candidates[i]);
      return nodes;
    }
  }
  return [];
}

/** 多候选取并集，按文档顺序排序 */
export function queryAllUnion(candidates, root = document) {
  const seen = new Set();
  for (const sel of candidates || []) {
    try {
      root.querySelectorAll(sel).forEach(n => {
        if (!isOwnUI(n)) seen.add(n);
      });
    } catch (e) {
      continue;
    }
  }
  const arr = Array.from(seen);
  arr.sort((a, b) => {
    if (a === b) return 0;
    if (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
    if (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_PRECEDING) return 1;
    return 0;
  });
  return arr;
}

/** 按文档顺序排序节点数组 */
export function sortByDocumentOrder(nodes) {
  return [...nodes].sort((a, b) => {
    if (a === b) return 0;
    if (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
    if (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_PRECEDING) return 1;
    return 0;
  });
}

/** 文本是否命中任一模式（子串或正则），会重置 /g 正则的 lastIndex */
export function matchesAny(patterns, text) {
  if (!text) return false;
  return (patterns || []).some(p => {
    if (p instanceof RegExp) {
      p.lastIndex = 0;
      return p.test(text);
    }
    return String(text).includes(p);
  });
}

/** 深度优先查找第一个满足条件的后代（含自身） */
export function findDescendant(root, predicate, maxDepth = 12) {
  if (!root) return null;
  const stack = [[root, 0]];
  while (stack.length) {
    const [el, d] = stack.shift();
    if (!el || el.nodeType !== Node.ELEMENT_NODE) continue;
    if (isOwnUI(el)) continue;
    if (predicate(el)) return el;
    if (d >= maxDepth) continue;
    for (const child of el.children) stack.push([child, d + 1]);
  }
  return null;
}

/**
 * 通用等待：轮询谓词直到为真或超时。
 * @param {() => any} predicate 返回真值即结束，该值作为 resolve 结果
 */
export function waitUntil(predicate, { timeout = 5000, interval = 120, label = 'waitUntil' } = {}) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = async () => {
      let value = null;
      try {
        value = await predicate();
      } catch (e) {
        value = null;
      }
      if (value) {
        resolve(value);
        return;
      }
      if (Date.now() - start >= timeout) {
        reject(new Error(`${label} 超时 (${timeout}ms)`));
        return;
      }
      setTimeout(tick, interval);
    };
    tick();
  });
}

/** 同 waitUntil，超时返回 null 而不抛错 */
export async function waitUntilOrNull(predicate, opts = {}) {
  try {
    return await waitUntil(predicate, opts);
  } catch (e) {
    return null;
  }
}

/**
 * 等待快照稳定：连续 stableFor 毫秒采样结果不变即认为渲染完成。
 * 用于「滚动到底 → 历史消息异步挂载」这类场景。
 */
export function waitUntilStable(sample, { timeout = 12000, interval = 300, stableFor = 700, label = 'waitUntilStable' } = {}) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    let last = null;
    let lastChangeAt = Date.now();
    const tick = () => {
      let snap = null;
      try {
        snap = sample();
      } catch (e) {
        snap = null;
      }
      const now = Date.now();
      if (snap !== last) {
        last = snap;
        lastChangeAt = now;
      }
      if (last !== null && now - lastChangeAt >= stableFor) {
        resolve(last);
        return;
      }
      if (now - start >= timeout) {
        reject(new Error(`${label} 超时 (${timeout}ms)`));
        return;
      }
      setTimeout(tick, interval);
    };
    tick();
  });
}

/** 简易防抖 */
export function debounce(fn, wait = 200) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

/** 生成一个能唯一标识某元素在文档中位置的短签名（用于去重/虚拟列表合并） */
export function elementSignature(el, textLen = 60) {
  if (!el) return '';
  const text = (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, textLen);
  const imgs = el.querySelectorAll('img').length;
  const codes = el.querySelectorAll('pre').length;
  return `${el.tagName}:${text.length}:${text.slice(0, 24)}:${imgs}:${codes}`;
}
