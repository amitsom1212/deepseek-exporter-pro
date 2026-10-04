/**
 * 页面内 UI 宿主：Shadow DOM 容器 + 启动按钮 + 面板外壳 + Toast
 *
 * 为什么用 Shadow DOM：站点（尤其 DeepSeek）用了大量全局 CSS 与 CSS 变量，
 * 普通注入的 UI 很容易被站点样式污染或反过来污染站点。Shadow DOM 双向隔离。
 *
 * @file src/content/ui.js
 */

import { PANEL_CSS } from './styles.js';

export const HOST_ID = 'dsx-panel-host';

/* ------------------------------------------------------------------ */
/*                          DOM 小工具                                 */
/* ------------------------------------------------------------------ */

/**
 * 极简元素构造器。
 * @param {string} tag
 * @param {object} [props] class / text / html / dataset / on* / 其余走属性
 * @param {...(Node|string|null|false|Array)} children
 */
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = String(v);
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k in el) el[k] = v;
    else el.setAttribute(k, String(v));
  }
  append(el, children);
  return el;
}

export function append(parent, children) {
  for (const c of children.flat(4)) {
    if (c === null || c === undefined || c === false) continue;
    parent.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  }
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
}

/* ------------------------------------------------------------------ */
/*                             图标                                    */
/* ------------------------------------------------------------------ */

const ICONS = {
  logo: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="M7 10l5 5 5-5"/><path d="M4 20h16"/></svg>',
  close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>',
  copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
  download: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/></svg>',
  gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9c.14.35.4.65.72.85"/></svg>',
  refresh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 3v6h-6"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>',
  folder: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
  warn: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/></svg>'
};

/** 返回一个内置 SVG 图标元素（字符串是常量，非用户内容） */
export function icon(name, size = 15) {
  const span = document.createElement('span');
  span.style.display = 'inline-flex';
  span.style.width = `${size}px`;
  span.style.height = `${size}px`;
  span.innerHTML = ICONS[name] || '';
  const svg = span.firstElementChild;
  if (svg) {
    svg.setAttribute('width', String(size));
    svg.setAttribute('height', String(size));
  }
  return span;
}

/* ------------------------------------------------------------------ */
/*                              宿主                                    */
/* ------------------------------------------------------------------ */

let hostEl = null;
let shadow = null;
let toastWrap = null;

/** 创建（或复用）Shadow DOM 宿主 */
export function ensureHost() {
  if (hostEl && hostEl.isConnected) return { host: hostEl, root: shadow };
  const existing = document.getElementById(HOST_ID);
  if (existing) existing.remove();

  hostEl = document.createElement('div');
  hostEl.id = HOST_ID;
  hostEl.className = 'dsx-root';
  // 宿主本身不占据布局，内部元素各自 fixed/relative 定位
  hostEl.style.cssText = 'all:initial;position:static;';
  shadow = hostEl.attachShadow({ mode: 'open' });

  const style = document.createElement('style');
  style.textContent = PANEL_CSS;
  shadow.appendChild(style);

  toastWrap = h('div', { class: 'dsx-toast-wrap' });
  shadow.appendChild(toastWrap);

  document.documentElement.appendChild(hostEl);
  return { host: hostEl, root: shadow };
}

export function getRoot() {
  return ensureHost().root;
}

/** 彻底移除插件宿主（销毁 UI 时调用，避免在页面里留下空壳节点） */
export function removeHost() {
  if (hostEl) {
    hostEl.remove();
    hostEl = null;
    shadow = null;
    toastWrap = null;
  }
}

/**
 * 创建一个「自带 Shadow Root 的宿主元素」。
 *
 * 为什么需要它：启动按钮要插到站点的输入框区域里（light DOM），
 * 如果直接插入一个普通 <button>，它拿不到 Shadow Root 里的样式；
 * 而把样式注入站点的 <head> 又会污染页面。所以给它套一层独立的 Shadow 宿主。
 *
 * @param {object} [style] 宿主自身的行内样式
 * @returns {{host:HTMLElement, root:ShadowRoot}}
 */
export function createIsolatedHost(style = { position: 'static', display: 'inline-block' }, id = '') {
  const host = document.createElement('div');
  host.className = 'dsx-root';
  if (id) host.id = id;
  host.style.cssText = 'all:initial;';
  Object.assign(host.style, style);
  const root = host.attachShadow({ mode: 'open' });
  const styleEl = document.createElement('style');
  styleEl.textContent = PANEL_CSS;
  root.appendChild(styleEl);
  return { host, root };
}

/* ------------------------------------------------------------------ */
/*                              Toast                                   */
/* ------------------------------------------------------------------ */

/**
 * 页内提示。
 * @param {string} message
 * @param {'info'|'ok'|'err'} [kind]
 * @param {number} [duration]
 */
export function toast(message, kind = 'info', duration = 2600) {
  ensureHost();
  const el = h('div', { class: `dsx-toast${kind === 'err' ? ' dsx-err' : kind === 'ok' ? ' dsx-ok' : ''}`, text: message });
  toastWrap.appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .2s';
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 220);
  }, duration);
  return el;
}

/* ------------------------------------------------------------------ */
/*                            面板外壳                                  */
/* ------------------------------------------------------------------ */

/**
 * 创建面板骨架。
 * @param {object} opts { title, subtitle, onClose }
 * @returns {{panel:HTMLElement, head:HTMLElement, tabsEl:HTMLElement, body:HTMLElement, foot:HTMLElement}}
 */
export function createPanel(opts = {}) {
  const root = getRoot();

  const head = h('div', { class: 'dsx-head' },
    icon('logo', 16),
    h('div', {},
      h('div', { class: 'dsx-head-title', text: opts.title || '对话导出' }),
      h('div', { class: 'dsx-head-sub', text: opts.subtitle || '' })
    ),
    h('div', { class: 'dsx-spacer' }),
    h('button', { class: 'dsx-iconbtn', title: '设置', onClick: () => opts.onOptions && opts.onOptions() }, icon('gear', 15)),
    h('button', { class: 'dsx-iconbtn', title: '关闭', onClick: () => opts.onClose && opts.onClose() }, icon('close', 15))
  );

  const tabsEl = h('div', { class: 'dsx-tabs' });
  const body = h('div', { class: 'dsx-body' });
  const foot = h('div', { class: 'dsx-foot' });

  const panel = h('div', { class: 'dsx-panel' }, head, tabsEl, body, foot);
  root.appendChild(panel);

  return { panel, head, tabsEl, body, foot };
}

/** 简易确认气泡（替代原生 confirm，避免弹窗打断） */
export function confirmInline(anchor, question) {
  return new Promise(resolve => {
    const wrap = h('div', {
      style: {
        position: 'absolute', zIndex: 2147483003, background: 'var(--dsx-bg-elev)',
        border: '1px solid var(--dsx-border)', borderRadius: '10px', padding: '10px 12px',
        boxShadow: 'var(--dsx-shadow)', maxWidth: '260px', fontSize: '12.5px'
      }
    },
      h('div', { text: question, style: { marginBottom: '8px', color: 'var(--dsx-text)' } }),
      h('div', { class: 'dsx-row', style: { justifyContent: 'flex-end' } },
        h('button', { class: 'dsx-btn dsx-sm dsx-ghost', text: '取消', onClick: () => done(false) }),
        h('button', { class: 'dsx-btn dsx-sm dsx-primary', text: '确定', onClick: () => done(true) })
      )
    );
    const rect = anchor.getBoundingClientRect();
    wrap.style.left = `${Math.max(8, Math.min(window.innerWidth - 280, rect.left))}px`;
    wrap.style.top = `${rect.bottom + 6}px`;
    getRoot().appendChild(wrap);
    const done = v => {
      wrap.remove();
      document.removeEventListener('mousedown', outside, true);
      resolve(v);
    };
    const outside = e => {
      if (!wrap.contains(e.target)) done(false);
    };
    setTimeout(() => document.addEventListener('mousedown', outside, true), 0);
  });
}
