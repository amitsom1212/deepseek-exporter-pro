/**
 * 内容脚本入口
 *
 * 职责：识别站点 → 挂启动按钮 → 处理 SPA 切换与按钮被重渲染吞掉的情况。
 *
 * 两个曾经踩过的坑（已修，别再改回去）：
 * 1. **消息监听必须在模块顶层注册**。它原先写在 boot() 里，于是「没识别出站点」
 *    时 popup / 设置页发来的消息得到的是 "Could not establish connection.
 *    Receiving end does not exist"，连用于排查的诊断请求都拿不到，只能瞎猜。
 * 2. **适配器识别必须可重试**。原先只在 document_idle 判定一次；
 *    DSH 这类 SPA 首屏还没渲染出特征 DOM 时就永久失配了。现在每秒重试一次。
 *
 * 关于「为什么用轮询而不是 MutationObserver」：聊天页在流式输出时 DOM 每秒
 * 变化数百次，观察器回调会参与每一次变更批处理；1 秒一次的轻量轮询开销可忽略。
 *
 * @file src/content/index.js
 */

import { resolveAdapter } from '../adapters/index.js';
import { createPanelController } from './panel.js';
import { getSettings } from '../core/settings.js';
import { toast } from './ui.js';

const BUILD_TAG = '1.0.1+2026-09';
const LOG = (...args) => console.debug('[DSX]', ...args);

LOG(`内容脚本已加载，构建 ${BUILD_TAG}，页面 ${location.host}`);

let adapter = null;
let controller = null;

/* ------------------------------------------------------------------ */
/*                          适配器识别                                   */
/* ------------------------------------------------------------------ */

/**
 * 尝试（重新）识别当前页面。
 * 成功则只初始化一次；失败返回 null，由轮询稍后重试。
 */
function tryResolveAdapter() {
  if (adapter) return adapter;
  let found = null;
  try {
    found = resolveAdapter(location);
  } catch (e) {
    LOG('适配器识别异常：', e && e.message);
  }
  if (found) {
    adapter = found;
    LOG(`命中站点适配器：${adapter.id}`);
    boot();
  }
  return adapter;
}

/* ------------------------------------------------------------------ */
/*                     消息接口（顶层注册，始终可用）                    */
/* ------------------------------------------------------------------ */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return false;

  switch (msg.type) {
    case 'DSX_PING':
      sendResponse({
        ok: true,
        build: BUILD_TAG,
        adapter: adapter ? adapter.id : null,
        url: location.href
      });
      return false;

    case 'DSX_GET_STATUS': {
      // 每次查询都重试一次识别：SPA 可能刚刚才渲染出特征 DOM
      tryResolveAdapter();
      sendResponse({
        ok: true,
        injected: true,
        adapter: adapter ? adapter.id : null,
        site: adapter ? (adapter.siteLabel || adapter.label) : '',
        title: safeTitle(),
        open: controller ? controller.isOpen() : false
      });
      return false;
    }

    case 'DSX_TOGGLE_PANEL':
    case 'DSX_OPEN_PANEL': {
      if (!tryResolveAdapter()) {
        sendResponse({ ok: false, error: 'NOT_SUPPORTED', probe: pageProbe() });
        return false;
      }
      try {
        if (msg.type === 'DSX_TOGGLE_PANEL') controller.toggle();
        else controller.show();
        sendResponse({ ok: true, open: controller.isOpen() });
      } catch (e) {
        sendResponse({ ok: false, error: String(e && e.message || e) });
      }
      return false;
    }

    case 'DSX_DIAGNOSE': {
      tryResolveAdapter();
      if (adapter && adapter.diagnose) {
        adapter.diagnose()
          .then(report => sendResponse({ ok: true, report }))
          .catch(err => sendResponse({ ok: true, report: { ...pageProbe(), diagnoseError: String(err && err.message || err) } }));
      } else {
        // 没识别出站点时也要给得出信息，否则用户没法反馈问题
        sendResponse({
          ok: true,
          report: {
            ...pageProbe(),
            note: '内容脚本已注入，但没有匹配到站点适配器。请把本报告发给开发者。'
          }
        });
      }
      return true;
    }

    case 'DSX_TOAST':
      toast(msg.message || '', msg.kind || 'info');
      sendResponse({ ok: true });
      return false;

    default:
      return false;
  }
});

/* ------------------------------------------------------------------ */
/*                        未支持页面的探测信息                          */
/* ------------------------------------------------------------------ */

function pageProbe() {
  const q = sel => {
    try {
      return document.querySelectorAll(sel).length;
    } catch (e) {
      return -1;
    }
  };
  const has = sel => q(sel) > 0;
  return {
    adapter: null,
    build: BUILD_TAG,
    url: location.href,
    host: location.host,
    hostname: location.hostname,
    port: location.port,
    title: document.title,
    readyState: document.readyState,
    probes: {
      // DeepSeek
      dsMessage: q('.ds-message'),
      dsVirtualItem: q('[data-virtual-list-item-key]'),
      dsMarkdown: q('.ds-markdown'),
      dsAssistantBody: q('.ds-assistant-message-main-content'),
      dsThink: q('.ds-think-content'),
      dsScrollArea: q('.ds-scroll-area'),
      dsComposerHash: q('.ec4f5d61, .bf38813a, ._77cefa5'),
      // DSH
      dshChatFlow: q('[data-chat-flow]'),
      dshFlowKind: q('[data-chat-flow-kind]'),
      dshConvScroll: q('[data-conversation-scroll]'),
      dshTree: q('div[role="tree"]'),
      dshTreeItem: q('div[role="treeitem"]'),
      dshMarkdown: q('div[class*="_markdown"]'),
      dshThink: q('div[data-variant="think"]'),
      // 通用
      textarea: q('textarea'),
      bodyTextHead: (document.body && document.body.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80)
    }
  };
}

function safeTitle() {
  try {
    return adapter && adapter.getTitle ? adapter.getTitle() : document.title;
  } catch (e) {
    return document.title;
  }
}

/* ------------------------------------------------------------------ */
/*                          启动与轮询                                  */
/* ------------------------------------------------------------------ */

let retries = 0;
const MAX_RETRIES = 6;

function boot() {
  if (controller) return; // 只初始化一次
  controller = createPanelController({
    adapter,
    onOpenOptions: () => chrome.runtime.sendMessage({ type: 'DSX_OPEN_OPTIONS' })
  });

  // 预热设置缓存，避免面板首帧空白
  getSettings(true).catch(() => {});

  const ensureButton = () => {
    if (!document.body || !controller) return;
    try {
      controller.createLauncher();
      retries = 0;
    } catch (e) {
      LOG('创建按钮失败：', e && e.message);
    }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(ensureButton, 400), { once: true });
  } else {
    setTimeout(ensureButton, 400);
  }

  // 方便在控制台里手动触发（同一个隔离世界内可见）
  try {
    window.__DSX_DEBUG__ = {
      get adapter() { return adapter; },
      controller: () => controller,
      toggle: () => controller.toggle(),
      probe: () => pageProbe(),
      collect: () => adapter.collectTurns({ onProgress: (a, b) => LOG(`读取 ${a}/${b}`) }),
      sessions: () => adapter.listSessions({ onProgress: n => LOG(`会话 ${n}`) })
    };
  } catch (e) { /* 忽略 */ }
}

// 首帧先试一次
tryResolveAdapter();

// 轮询：既负责「未识别 → 重新识别」，也负责 URL 变化与按钮被重渲染吞掉
let lastUrl = location.href;
setInterval(() => {
  if (!document.body) return;

  // 1) 还没识别出站点：继续重试（DSH 首屏渲染较慢）
  if (!adapter) {
    tryResolveAdapter();
    if (!adapter) return;
  }

  // 2) SPA 切页：重建按钮
  if (location.href !== lastUrl) {
    lastUrl = location.href;
    retries = 0;
    setTimeout(() => {
      if (!document.body || !controller) return;
      try { controller.createLauncher(); } catch (e) { /* 忽略 */ }
    }, 300);
    return;
  }

  // 3) 按钮被页面的重渲染吞掉时补回来
  //    （按钮可能挂在站点 DOM 上，也可能在插件的 Shadow DOM 里，交给 controller 判断）
  if (controller && !controller.hasLauncher() && !controller.isOpen()) {
    if (retries < MAX_RETRIES) {
      retries++;
      setTimeout(() => {
        if (!document.body || !controller) return;
        try { controller.createLauncher(); } catch (e) { /* 忽略 */ }
      }, 500 * retries);
    }
  }
}, 1200);
