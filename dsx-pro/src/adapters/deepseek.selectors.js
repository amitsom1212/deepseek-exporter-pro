/**
 * DeepSeek（chat.deepseek.com）选择器注册表 —— 单一事实来源
 *
 * ⚠️ 本文件的候选链已用真实线上 bundle 逐条核对（2026-09，commit-id 12196914，
 *    appVersion 2.5.0，main.7c490b0c22.js / main.3208e09460.css）。
 *
 * 核对结论（务必遵守）：
 * - 高效锚点是「设计系统类名 ds-*」与「data-* 属性」，它们是手写的；
 *   哈希类名（CSS Modules）每次构建都会重新生成，已确认 4 个失效。
 * - 已确认失效、禁止再用的类名：_5cadb25 / _76cd190 / _608a995 / abbe3c45
 * - `.ds-message` 存在但**没有任何 CSS 规则**，它是 JS 上打的 marker class，
 *   可用但不要依赖它的样式语义。
 * - `[data-virtual-list-item-key]` 是本页面最稳的消息锚点：
 *   属性名来自源码常量，且应用自身的滚动定位逻辑就依赖它。
 * - 会话 id 不在 DOM 里（侧边栏没有 data-*session*、没有 /a/chat 字面量），
 *   只能从 location.pathname 的 /a/chat/s/<id> 解析，或走接口。
 * - 数学公式：存在第二套 WASM 渲染器（输出内联 SVG），该路径下 LaTeX
 *   在 DOM 中不可恢复 —— 所以公式质量以接口数据为准，DOM 仅作兜底。
 *
 * @file src/adapters/deepseek.selectors.js
 */

export const ds = {
  /* ---------------- 消息 ---------------- */
  messageContainer: [
    '[data-virtual-list-item-key]',
    '.ds-virtual-list__items > *',
    '.ds-message',
    '[class*="ds-message"]'
  ],
  skeleton: [
    '.ds-skeleton',
    '[class*="skeleton"]'
  ],

  /* ---------------- 消息内容 ---------------- */
  /** AI 回答正文（bundle 里两处独立引用，可信度最高） */
  assistantBody: [
    '.ds-assistant-message-main-content',
    '[class*="ds-assistant-message-main-content"]'
  ],
  /** markdown 渲染容器（211 处 CSS 引用） */
  aiContent: [
    '.ds-markdown',
    '[class*="ds-markdown"]'
  ],
  /** 深度思考容器（50 处 CSS 引用 + 源码里 i.querySelector(".ds-think-content")） */
  thinkContent: [
    '.ds-think-content',
    '[class*="ds-think-content"]',
    '[class*="ds-think"]'
  ],
  /** 思考块折叠开关 */
  thinkToggle: [
    '.ds-think-content [role="button"]',
    '[class*="ds-think"] [role="button"]',
    '[class*="think"] button'
  ],
  /** 数学公式：DeepSeek 也是 KaTeX（运行时独立 chunk） */
  katex: [
    '.ds-markdown-math',
    '.katex',
    '.katex-display'
  ],
  /** 公式渲染失败态：title 与文本里带原始 LaTeX，可作兜底 */
  katexError: [
    'span.katex-error',
    '.ds-markdown-math-error'
  ],

  /* ---------------- 滚动容器 ---------------- */
  scrollArea: [
    '.ds-scroll-area',
    '[class*="scroll-area"]:not([class*="gutter"])'
  ],
  virtualList: [
    '.ds-virtual-list',
    '.ds-virtual-list__items'
  ],

  /* ---------------- 输入区（插入插件 UI 的锚点） ---------------- */
  composerAnchor: [
    '.ec4f5d61',
    '.bf38813a',
    '._77cefa5',
    '._24fad49'
  ],

  /* ---------------- 生成状态 ---------------- */
  stopButton: [
    'button[aria-label="停止生成"], button[aria-label="Stop generating"]',
    'button[aria-label*="停止"]',
    'button[aria-label*="Stop" i]'
  ],
  streamingCursor: [
    '.ds-markdown + .cursor',
    '[class*="cursor"].streaming'
  ],

  /* ---------------- 会话（批量导出）----------------
   * 线上 bundle 里侧边栏条目没有 <a href>，是带 onClick 的 div，
   * 已知唯一类名锚点 ._25c7358（240px 宽、标题+时间、cursor:pointer）。
   * 由于哈希类名随构建变化，这里给出结构候选链：
   * 1) 侧边栏面板内 role=treeitem / 可点击卡片
   * 2) 已知哈希类名
   * 3) 兜底：任何 href 带 /chat/s/ 的链接（旧版结构）
   */
  sessionPanel: [
    '._519be07',
    '[class*="sidebar"]',
    'aside'
  ],
  sessionRow: [
    '[role="treeitem"]',
    '._25c7358',
    '[class*="sidebar"] [tabindex="0"]',
    'a[href*="/chat/s/"]',
    'a[href*="/a/chat"]'
  ],
  sessionList: [
    '[class*="history-list"]',
    '[class*="history"] [class*="list"]',
    '[role="tree"]',
    'nav[class*="sidebar"] [class*="scroll"]'
  ],
  sessionMore: [
    'button[class*="load-more"]',
    '[class*="history"] button[class*="more"]',
    '[aria-label*="更多历史"]',
    '[aria-label*="展开"]'
  ],

  /* ---------------- 图片排除（头像/站标等装饰） ---------------- */
  imageUrlExcludePatterns: [
    'avatar',
    'user-avatar',
    'site-icon',
    'site_logo',
    'favicon',
    '/logo',
    'cdn.deepseek.com/site-icons'
  ]
};

/** DeepSeek 内部接口（从线上 bundle 提取，均为 POST/GET JSON） */
export const dsApi = {
  /** 侧边栏会话分页列表 */
  sessionPage: '/api/v0/chat_session/fetch_page',
  /** 单个会话的完整消息历史 */
  historyMessages: '/api/v0/chat/history_messages',
  /** 公开分享内容（无需登录，可用于自检） */
  shareContent: '/api/v0/share/content',
  /** localStorage 里的登录令牌键名（bundle 证据） */
  tokenKeys: ['userToken'],
  /** 图片 CDN 基址 */
  fileBase: 'files.deepseeksvc.com'
};

/** 从 href / pathname 里抠出会话 id */
export function parseSessionId(href) {
  const m = String(href || '').match(/\/(?:a\/[^/]+\/)?s\/([0-9a-zA-Z_-]{8,})/);
  if (m) return m[1];
  const m2 = String(href || '').match(/\/(?:a\/)?chat\/s\/([0-9a-zA-Z_-]{8,})/);
  return m2 ? m2[1] : '';
}

/** 当前页面正在浏览的会话 id */
export function currentSessionId() {
  return parseSessionId(location.pathname);
}
