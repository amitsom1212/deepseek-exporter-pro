/**
 * DOM → Markdown 序列化器（站点无关）
 *
 * 设计要点：
 * - 以「渲染后的 HTML」为输入，而不是 innerText：只有走 DOM 才能拿到
 *   KaTeX 里保存的原始 LaTeX、代码块语言、表格结构、图片地址。
 * - 数学公式：优先读 KaTeX 的 <annotation encoding="application/x-tex">，
 *   拿不到时退回 MathJax 的 mjx-container / script[type="math/tex"]。
 * - 图片：交给调用方注入的 imagePlaceholder 决定占位符（因为导出模式不同——
 *   单文件内联 base64、还是外链到 images/ 子目录、还是纯文本 [图片]）。
 * - 所有 UI 控件（复制按钮、工具栏、图标）通过 isIgnored 主动剔除，
 *   这样即使适配器给的内容根里混进了按钮也不会污染导出。
 *
 * @file src/core/domToMarkdown.js
 */

/** 明显属于页面控件/装饰、不应进入导出的节点 */
const IGNORED_TAGS = new Set([
  'button', 'svg', 'path', 'style', 'script', 'noscript', 'canvas', 'iframe',
  'video', 'audio', 'input', 'textarea', 'select', 'option', 'template'
]);

/** class 里出现这些词根说明是控件/装饰 */
const IGNORED_CLASS_HINTS = [
  'copy', 'toolbar', 'action', 'actions', 'feedback', 'like', 'dislike',
  'avatar', 'icon-btn', 'icon-button', 'ds-icon', 'scroll-btn', 'to-top',
  'dsx-', 'ai-exporter'
];

/** aria-hidden 也要排除 */
function isIgnored(el) {
  if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
  const tag = el.tagName.toLowerCase();
  if (IGNORED_TAGS.has(tag)) return true;
  if (el.getAttribute('aria-hidden') === 'true') return true;
  const cls = typeof el.className === 'string' ? el.className : '';
  if (cls) {
    const lower = cls.toLowerCase();
    for (const hint of IGNORED_CLASS_HINTS) {
      if (lower.includes(hint)) return true;
    }
  }
  return false;
}

/** 文本节点归一化：HTML 里的换行/缩进在 markdown 里没有意义，压成单空格 */
function normalizeText(raw) {
  return String(raw || '').replace(/\s+/g, ' ');
}

/** 提取 KaTeX / MathJax 的原始 LaTeX */
export function extractLatex(el) {
  // 1) KaTeX：annotation 里就是原始输入
  const ann = el.querySelector?.('annotation[encoding*="tex" i], annotation');
  if (ann && ann.textContent && ann.textContent.trim()) {
    return { tex: ann.textContent.trim(), source: 'katex' };
  }
  // 2) MathJax v3：<mjx-container> 上可能带 data-latex / 内部 <script>
  const script = el.querySelector?.('script[type^="math/tex"]');
  if (script && script.textContent.trim()) {
    return { tex: script.textContent.trim(), source: 'mathjax-script' };
  }
  const latexAttr = el.getAttribute?.('data-latex') || el.getAttribute?.('data-tex');
  if (latexAttr && latexAttr.trim()) return { tex: latexAttr.trim(), source: 'attr' };
  // 3) 兜底：整体文本（会丢失结构，但总比丢公式好）
  const text = (el.textContent || '').trim();
  return text ? { tex: text, source: 'text' } : null;
}

function isDisplayMath(el) {
  if (el.classList?.contains('katex-display')) return true;
  if (el.classList?.contains('display')) return true;
  if (el.closest?.('.katex-display, mjx-container[display="true"]')) return true;
  const style = el.getAttribute?.('style') || '';
  return /display\s*:\s*block/.test(style);
}

/** 代码块语言探测 */
function detectCodeLanguage(el) {
  // 1) 语言标注在独立的「代码块顶栏」里（DeepSeek 的 .md-code-block-banner、
  //    DSH 的 [data-code-block-banner]），顶栏里还可能混着复制按钮，只取第一行纯词
  const banner = el.querySelector?.(
    '[data-code-block-banner], [class*="code-block-banner"], [class*="codeblock-banner"], [class*="code-banner"]'
  );
  if (banner) {
    const first = (banner.textContent || '').split('\n')[0].trim();
    if (first && first.length < 20 && /^[\w+#.-]+$/.test(first)) return first;
  }
  // 2) 语言写在 code/pre 的 class 或属性上
  const scope = [el, el.querySelector?.('code'), el.querySelector?.('pre')].filter(Boolean);
  for (const node of scope) {
    const cls = typeof node.className === 'string' ? node.className : '';
    const m = cls.match(/(?:language|lang|highlight)-([\w+#.-]+)/i);
    if (m) return m[1];
    const attr = node.getAttribute?.('data-language') || node.getAttribute?.('lang');
    if (attr && attr.trim() && attr.trim().length < 24) return attr.trim();
  }
  return '';
}

/** 表格 → markdown 表格 */
function renderTable(el, ctx) {
  const rows = Array.from(el.querySelectorAll('tr'));
  if (rows.length === 0) return '';
  const out = [];
  rows.forEach((row, rowIndex) => {
    const cells = Array.from(row.querySelectorAll('th, td'));
    if (cells.length === 0) return;
    const texts = cells.map(cell => serializeChildren(cell, { ...ctx, inTable: true })
      .replace(/\|/g, '\\|')
      .replace(/\s*\n+\s*/g, ' ')
      .trim());
    out.push(`| ${texts.join(' | ')} |`);
    if (rowIndex === 0) out.push(`|${texts.map(() => ' --- ').join('|')}|`);
  });
  return `\n${out.join('\n')}\n\n`;
}

/** 列表 → markdown 列表（支持嵌套缩进） */
function renderList(el, ctx) {
  const ordered = el.tagName.toLowerCase() === 'ol';
  const start = parseInt(el.getAttribute('start') || '1', 10) || 1;
  const items = Array.from(el.children).filter(c => c.tagName.toLowerCase() === 'li');
  const lines = items.map((li, i) => {
    const marker = ordered ? `${start + i}. ` : '- ';
    let body = serializeChildren(li, { ...ctx, listDepth: (ctx.listDepth || 0) + 1 }).trim();
    // 复选框列表（任务列表）
    const checkbox = li.querySelector?.(':scope > input[type="checkbox"]');
    if (checkbox) body = (checkbox.checked ? '[x] ' : '[ ] ') + body;
    const indent = ' '.repeat(marker.length);
    return marker + body.replace(/\n(?!\n)/g, `\n${indent}`);
  });
  return `\n${lines.join('\n')}\n\n`;
}

function renderBlockquote(el, ctx) {
  const body = serializeChildren(el, ctx).trim();
  if (!body) return '';
  return `\n${body.split('\n').map(l => (l ? `> ${l}` : '>')).join('\n')}\n\n`;
}

/** 遍历子节点 */
export function serializeChildren(el, ctx) {
  let out = '';
  for (const child of el.childNodes) out += serializeNode(child, ctx);
  return out;
}

/**
 * 序列化单个节点。
 * @param {Node} node
 * @param {object} ctx
 * @returns {string} markdown
 */
export function serializeNode(node, ctx) {
  if (node.nodeType === Node.TEXT_NODE) return normalizeText(node.nodeValue);
  if (node.nodeType !== Node.ELEMENT_NODE) return '';

  const el = /** @type {Element} */ (node);
  if (isIgnored(el)) return '';

  const tag = el.tagName.toLowerCase();
  const cls = typeof el.className === 'string' ? el.className : '';

  // ---------- 数学公式（必须在通用 span 处理之前） ----------
  if (cls.includes('katex') || el.tagName.toLowerCase() === 'mjx-container' || cls.includes('math')) {
    if (cls.includes('katex-html')) return ''; // 视觉层没有信息量
    const math = extractLatex(el);
    if (math) {
      const display = isDisplayMath(el);
      return display ? `\n\n$$\n${math.tex}\n$$\n\n` : ` $${math.tex}$ `;
    }
  }
  if (tag === 'script' && /math\/tex/.test(el.getAttribute('type') || '')) {
    return `\n\n$$\n${el.textContent.trim()}\n$$\n\n`;
  }
  if (tag === 'annotation') return ''; // 已被 katex 分支消费

  // ---------- 图片 ----------
  if (tag === 'img') {
    const handled = ctx.imagePlaceholder ? ctx.imagePlaceholder(el, ctx) : null;
    if (handled !== null && handled !== undefined) return handled;
    const src = el.getAttribute('src') || el.getAttribute('data-src') || '';
    const alt = el.getAttribute('alt') || '';
    return src ? `![${alt}](${src})` : '';
  }

  // ---------- 代码块 ----------
  if (/code-?block|hljs|highlight/.test(cls) && el.querySelector('pre, code')) {
    const codeEl = el.querySelector('pre code') || el.querySelector('pre') || el.querySelector('code');
    const lang = detectCodeLanguage(el);
    const code = codeEl ? codeEl.textContent.replace(/\n$/, '') : '';
    return `\n\n\`\`\`${lang}\n${code}\n\`\`\`\n\n`;
  }
  if (tag === 'pre') {
    const codeEl = el.querySelector('code') || el;
    const lang = detectCodeLanguage(el);
    const code = codeEl.textContent.replace(/\n$/, '');
    return `\n\n\`\`\`${lang}\n${code}\n\`\`\`\n\n`;
  }

  // ---------- 结构块 ----------
  switch (tag) {
    case 'br':
      return '  \n';
    case 'hr':
      return '\n\n---\n\n';
    case 'table':
      return renderTable(el, ctx);
    case 'ul':
    case 'ol':
      return renderList(el, ctx);
    case 'blockquote':
      return renderBlockquote(el, ctx);
    case 'details': {
      // 折叠块（部分站点用它渲染思考过程）
      const summary = el.querySelector(':scope > summary');
      const head = summary ? `**${serializeChildren(summary, ctx).trim()}**\n\n` : '';
      const body = Array.from(el.children)
        .filter(c => c.tagName.toLowerCase() !== 'summary')
        .map(c => serializeNode(c, ctx))
        .join('');
      const quote = body.trim().split('\n').map(l => (l ? `> ${l}` : '>')).join('\n');
      return `\n\n${head}${quote}\n\n`;
    }
    case 'p':
      return `\n\n${serializeChildren(el, ctx).trim()}\n\n`;
    case 'div':
    case 'section':
    case 'article':
      // 容器：不透传额外空行，避免嵌套 div 撑出一堆空行
      return serializeChildren(el, ctx);
    case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6': {
      const level = Math.min(6, Math.max(1, parseInt(tag[1], 10) + (ctx.headingOffset || 0)));
      return `\n\n${'#'.repeat(level)} ${serializeChildren(el, ctx).trim()}\n\n`;
    }
    case 'strong':
    case 'b': {
      const inner = serializeChildren(el, ctx).trim();
      return inner ? `**${inner}**` : '';
    }
    case 'em':
    case 'i': {
      const inner = serializeChildren(el, ctx).trim();
      return inner ? `*${inner}*` : '';
    }
    case 'del':
    case 's': {
      const inner = serializeChildren(el, ctx).trim();
      return inner ? `~~${inner}~~` : '';
    }
    case 'code': {
      const text = el.textContent;
      if (!text) return '';
      const fence = text.includes('`') ? '``' : '`';
      return `${fence}${text}${fence}`;
    }
    case 'a': {
      const inner = serializeChildren(el, ctx).trim();
      const href = el.getAttribute('href') || '';
      if (!href || href.startsWith('javascript:') || href === '#') return inner;
      if (!inner) return `<${href}>`;
      if (inner === href) return `<${href}>`;
      return `[${inner}](${href})`;
    }
    case 'li':
      return serializeChildren(el, ctx);
    case 'sup': {
      const inner = serializeChildren(el, ctx).trim();
      return inner ? `^${inner}^` : '';
    }
    case 'sub': {
      const inner = serializeChildren(el, ctx).trim();
      return inner ? `~${inner}~` : '';
    }
    case 'rp':
      return '';
    case 'rt': {
      const inner = serializeChildren(el, ctx).trim();
      return inner ? `(${inner})` : '';
    }
    default:
      return serializeChildren(el, ctx);
  }
}

/**
 * 把 DOM 子树整体转成 markdown 并做收尾清理。
 * @param {Element} root
 * @param {object} [options] { imagePlaceholder, headingOffset }
 * @returns {string}
 */
export function domToMarkdown(root, options = {}) {
  if (!root) return '';
  const ctx = {
    imagePlaceholder: options.imagePlaceholder || null,
    headingOffset: options.headingOffset || 0,
    listDepth: 0,
    inTable: false
  };
  let md = serializeChildren(root, ctx);
  md = cleanupMarkdown(md);
  return md;
}

/** 收尾：合并多余空行、清理行尾空格、修正围栏间距 */
export function cleanupMarkdown(md) {
  return String(md || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\n+/, '')
    .replace(/\n+$/, '')
    .trimEnd() + '\n';
}

/** 纯文本导出用：把 markdown 粗洗成可读文本（去掉标记符号） */
export function markdownToPlain(md) {
  return String(md || '')
    .replace(/^>\s?\[!思考\]\s*$/gm, '【思考过程】')
    .replace(/^>\s?/gm, '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '$1')
    .replace(/`{1,3}([^`]*?)`{1,3}/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '[$1]')
    .replace(/\[([^\]]*)\]\(([^)]*)\)/g, '$1 ($2)')
    .replace(/\$\$([\s\S]*?)\$\$/g, (_, t) => `\n${t.trim()}\n`)
    .replace(/\$([^$\n]+)\$/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
