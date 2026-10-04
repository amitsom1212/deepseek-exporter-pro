/**
 * Markdown → DOCX（含原生 Word 公式，100% 浏览器端 / Node 端可用）
 *
 * 为什么要自己写而不是用现成库：
 * - `html-docx-js` / `html-to-docx` 走 altchunk 或直接丢 HTML，Word 里公式变图片或直接丢，
 *   且 LibreOffice / Google Docs 不认。
 * - `docx` 官方库有 Math 类，但**不接收 MathML**，没有 MathMatrix / MathAccent / MathBar。
 * - `pandoc-wasm` 保真度最好，但 wasm 58MB + GPL-2.0 传染，不适合塞进扩展。
 *
 * 所以本模块 = `docx`（文档骨架 + 常用公式类）
 *                + KaTeX（LaTeX → MathML）
 *                + 自写 MathML → OMML 映射（补齐矩阵 / 重音 / 上下限等缺口）
 *
 * 设计参考（均为 MIT，仅借鉴结构，代码为本项目重写）：
 * - vace/markdown-docx 的 src/extensions/mathml-to-docx.ts（MathML→docx Math 映射思路）
 * - dolanmiu/docx 的 docs/usage/math.md（Math 类的官方用法）
 *
 * @file src/core/md2docx.js
 */

import {
  Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType,
  Table, TableRow, TableCell, WidthType, BorderStyle, ShadingType,
  ImageRun, ExternalHyperlink, XmlComponent, XmlAttributeComponent, PageBreak,
  Math as DocxMath, MathRun, MathFraction, MathRadical, MathSuperScript, MathSubScript,
  MathSubSuperScript, MathSum, MathIntegral, MathFunction,
  MathRoundBrackets, MathSquareBrackets, MathCurlyBrackets, MathAngledBrackets
} from 'docx';
import katex from 'katex';
import { marked } from 'marked';
import { XMLParser } from 'fast-xml-parser';

/* ================================================================== */
/*                     Part 1 · MathML → OMML 映射                     */
/* ================================================================== */

/** docx 没有提供的 OMML 结构，用自定义 XmlComponent 补齐 */
class OmmlMatrix extends XmlComponent {
  constructor(rows) {
    super('m:m');
    for (const row of rows) this.root.push(new OmmlMatrixRow(row));
  }
}
class OmmlMatrixRow extends XmlComponent {
  constructor(cells) {
    super('m:mr');
    for (const cell of cells) this.root.push(new OmmlMatrixCell(cell));
  }
}
class OmmlMatrixCell extends XmlComponent {
  constructor(children) {
    super('m:e');
    for (const c of children) if (c) this.root.push(c);
  }
}
/** m:acc —— 重音（\hat \bar \vec \dot \ddot \tilde \overline 用 m:bar） */
class OmmlAccent extends XmlComponent {
  constructor(accentChar, children) {
    super('m:acc');
    const pr = new XmlComponent('m:accPr');
    const chr = new XmlComponent('m:chr');
    chr.root.push(new XmlAttributeComponent({ 'm:val': accentChar }));
    pr.root.push(chr);
    this.root.push(pr);
    const e = new XmlComponent('m:e');
    for (const c of children) if (c) e.root.push(c);
    this.root.push(e);
  }
}
class OmmlBar extends XmlComponent {
  constructor(children, pos = 'top') {
    super('m:bar');
    const pr = new XmlComponent('m:barPr');
    const posEl = new XmlComponent('m:pos');
    posEl.root.push(new XmlAttributeComponent({ 'm:val': pos }));
    pr.root.push(posEl);
    this.root.push(pr);
    const e = new XmlComponent('m:e');
    for (const c of children) if (c) e.root.push(c);
    this.root.push(e);
  }
}

/** 大运算符：这些符号用 m:nary（上下限在正上下方），而不是 m:sSubSup */
const LARGE_OPS = ['∑', '∏', '∐', '∫', '∬', '∭', '∮', '∯', '⋃', '⋂', '⨁', '⨂', '⨀', '⋁', '⋀'];
/** 走极限式上下标（m:limLow / m:limUpp）的运算符 */
const LIMIT_OPS = ['lim', 'max', 'min', 'sup', 'inf', 'det', 'dim', 'ker', 'arg', 'gcd', 'log', 'ln', 'exp', 'sin', 'cos', 'tan', 'cot', 'sec', 'csc'];

/**
 * 归一化运算符文本：
 * 去掉 LaTeX 的不可见函数应用符 U+2061、零宽空格、以及所有空白。
 */
function normalizeOp(text) {
  return String(text || '')
    .replace(/[\u2061\u200B\u200C\u200D\uFEFF\s]/g, '')
    .toLowerCase();
}

/** m:limLow / m:limUpp —— docx 没提供，自定义（\lim_{x\to0} 的正确 OMML 形状） */
class OmmlLimLow extends XmlComponent {
  constructor(base, limit) {
    super('m:limLow');
    const e = new XmlComponent('m:e');
    for (const c of base) if (c) e.root.push(c);
    const lim = new XmlComponent('m:lim');
    for (const c of limit) if (c) lim.root.push(c);
    this.root.push(e);
    this.root.push(lim);
  }
}
class OmmlLimUpp extends XmlComponent {
  constructor(base, limit) {
    super('m:limUpp');
    const e = new XmlComponent('m:e');
    for (const c of base) if (c) e.root.push(c);
    const lim = new XmlComponent('m:lim');
    for (const c of limit) if (c) lim.root.push(c);
    this.root.push(e);
    this.root.push(lim);
  }
}

const MATH_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/math';

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  textNodeName: '#text',
  preserveOrder: true,
  trimValues: false,
  parseTagValue: false,
  parseAttributeValue: false
});

/** 取节点标签名 */
function tagName(node) {
  if (!node || typeof node !== 'object') return null;
  const keys = Object.keys(node).filter(k => k !== '#text' && k !== ':@');
  return keys[0] || null;
}
/** 取子节点数组 */
function childrenOf(node) {
  const tag = tagName(node);
  if (!tag) return [];
  const val = node[tag];
  return Array.isArray(val) ? val : (val ? [val] : []);
}
/** 取直接文本 */
function directText(nodes) {
  return (nodes || []).map(n => (n && n['#text'] != null ? String(n['#text']) : '')).join('');
}
/** 取节点文本内容（递归） */
function textOfNode(node) {
  if (!node) return '';
  if (node['#text'] != null) return String(node['#text']);
  return childrenOf(node).map(textOfNode).join('');
}
/** 深度优先查找标签 */
function findTag(nodes, name) {
  for (const n of nodes || []) {
    if (tagName(n) === name) return n;
    const inner = findTag(childrenOf(n), name);
    if (inner) return inner;
  }
  return null;
}

/**
 * LaTeX → docx Math 子节点数组。
 * @param {string} tex
 * @param {boolean} display
 * @returns {Array} MathComponent[]
 */
export function texToMathChildren(tex, display = false) {
  if (!tex || !String(tex).trim()) return [];
  let mathml = '';
  try {
    mathml = katex.renderToString(String(tex), {
      output: 'mathml',
      displayMode: !!display,
      throwOnError: false,
      strict: false,
      trust: false,
      macros: { '\\RR': '\\mathbb{R}', '\\NN': '\\mathbb{N}', '\\ZZ': '\\mathbb{Z}' }
    });
  } catch (e) {
    return [new MathRun(String(tex))];
  }
  return mathmlToMathChildren(mathml);
}

/**
 * MathML 字符串 → docx Math 子节点数组。
 * @param {string} mathml
 * @returns {Array}
 */
export function mathmlToMathChildren(mathml) {
  if (!mathml) return [];
  let ast = null;
  try {
    ast = xmlParser.parse(mathml);
  } catch (e) {
    return [];
  }
  const mathNode = findTag(ast, 'math');
  if (!mathNode) return [];
  // 优先 <semantics><mrow>，跳过 <annotation>（里面是原始 LaTeX，不该渲染）
  const semantics = findTag(childrenOf(mathNode), 'semantics');
  const scope = (semantics ? childrenOf(semantics) : childrenOf(mathNode))
    .filter(n => tagName(n) !== 'annotation' && tagName(n) !== 'annotation-xml');
  // 注意：必须是「直接子节点」里的 mrow。递归查找会钻进 mtable 的单元格里，
  // 把矩阵/对齐环境解析成单个单元格的内容（曾导致 aligned 公式整体丢失）。
  let root = scope;
  const direct = scope.find(n => tagName(n) === 'mrow');
  if (direct) root = childrenOf(direct);
  else {
    const wrap = scope.find(n => ['mstyle', 'mpadded', 'mphantom', 'menclose'].includes(tagName(n)));
    if (wrap) root = childrenOf(wrap);
  }
  return walkRow(root);
}

/**
 * 遍历一行 MathML 子节点。
 * 关键点：大运算符的「被求和内容」在 MathML 里是**同一 mrow 的后续兄弟**，
 * 所以必须在这里做 lookahead，把剩余节点吃进 MathSum.children。
 */
function walkRow(nodes) {
  const out = [];
  for (let i = 0; i < (nodes || []).length; i++) {
    const node = nodes[i];
    const tag = tagName(node);
    if (tag === 'annotation' || tag === 'annotation-xml') continue;

    if (tag === 'munderover' || tag === 'munder' || tag === 'mover') {
      const kids = childrenOf(node);
      const base = kids[0];
      const opText = textOfNode(base);
      const opNorm = normalizeOp(opText);
      const lower = tag !== 'mover' ? walkRow(childrenOf(kids[1] || {})) : [];
      const upper = tag !== 'munder' ? walkRow(childrenOf(kids[2] || {})) : [];
      const rest = walkRow(nodes.slice(i + 1)); // 剩余部分 = 运算对象

      if (LARGE_OPS.some(s => opText.includes(s))) {
        out.push(makeNary(opText, lower, upper, rest));
        break; // 剩余内容已被消费
      }
      if (LIMIT_OPS.includes(opNorm)) {
        out.push(...makeLimits(opText, lower, upper, rest));
        break;
      }
      // 普通重音（\hat \bar \vec ...）：mover 且 over 位置是重音符号
      if (tag === 'mover') {
        const accent = accentToChar(textOfNode(kids[1] || {}));
        if (accent) {
          out.push(new OmmlAccent(accent, walkRow(childrenOf(base))));
          out.push(...rest);
          break;
        }
      }
      out.push(...walkRow(childrenOf(base)), ...lower, ...upper, ...rest);
      break;
    }

    // KaTeX 把 ∑_{}^{} 输出成 msubsup(mo) 而不是 munderover；
    // 只有下标的 ∑_{i} 则是 msub(mo)，同样要升级成 nary，否则 Word 里
    // 上下限会挤在右下角而不是正下方。
    if (tag === 'msubsup' || tag === 'msub' || tag === 'msup') {
      const kids = childrenOf(node);
      const opText = textOfNode(kids[0]);
      const opNorm = normalizeOp(opText);
      const lower = tag !== 'msup' ? walkRow(childrenOf(kids[1] || {})) : [];
      const upper = tag !== 'msub' ? walkRow(childrenOf(kids[tag === 'msubsup' ? 2 : 1] || {})) : [];
      if (LARGE_OPS.some(s => opText.includes(s))) {
        const rest = walkRow(nodes.slice(i + 1));
        out.push(makeNary(opText, lower, upper, rest));
        break;
      }
      if (LIMIT_OPS.includes(opNorm) && tag !== 'msup') {
        const rest = walkRow(nodes.slice(i + 1));
        out.push(...makeLimits(opText, lower, upper, rest));
        break;
      }
    }

    out.push(...walkNode(node));
  }
  return out.filter(Boolean);
}

/** 大运算符 → OMML 结构 */
function makeNary(op, lower, upper, body) {
  const isIntegral = op.includes('∫') || op.includes('∮') || op.includes('∯');
  // docx 的 MathSum / MathIntegral 只支持上下标，不支持自定义运算符字符；
  // 非 ∑ / ∫ 的运算符退化为「字符 + 上下标 + 内容」，避免渲染错符号。
  if (op.includes('∑')) {
    return new MathSum({ children: body, subScript: lower, superScript: upper });
  }
  if (isIntegral) {
    return new MathIntegral({ children: body, subScript: lower, superScript: upper });
  }
  return new MathSubSuperScript({
    children: [new MathRun(op.trim())],
    subScript: lower,
    superScript: upper
  });
}

/** 极限式运算符（lim / max / min ...）→ m:limLow / m:limUpp，其余内容作为兄弟节点 */
function makeLimits(op, lower, upper, body) {
  const opRuns = [new MathRun(op.trim())];
  if (lower.length && upper.length) {
    return [new OmmlLimLow(opRuns, lower), ...body];
  }
  if (lower.length) return [new OmmlLimLow(opRuns, lower), ...body];
  if (upper.length) return [new OmmlLimUpp(opRuns, upper), ...body];
  return [...opRuns, ...body];
}

/**
 * 常见重音符号 → Word 认的「组合字符」。
 * KaTeX 的 <mo> 里既可能是组合字符本身，也可能是 ASCII 替代符号，两种都要认。
 */
function accentToChar(s) {
  const t = String(s || '').trim();
  if (!t) return '';
  // 键统一用转义写法，避免出现肉眼分不清的重复键（如 ¯ / \u00AF 是同一个字符）
  const map = {
    '\u005E': '\u0302',   // ^  \hat
    '\u007E': '\u0303',   // ~  \tilde
    '\u0060': '\u0300',   // `  \grave
    '\u00AF': '\u0304',   // ¯  \bar
    '\u02C9': '\u0304',   // ˉ  \bar（修饰符字母）
    '\u02D9': '\u0307',   // ˙  \dot
    '\u00A8': '\u0308',   // ¨  \ddot
    '\u2192': '\u20D7',   // →  \vec
    '\u02CA': '\u0301',   // ´
    '\u02CB': '\u0300',   // ｀
    '\u02C7': '\u030C',   // ˇ  \check
    '\u02D8': '\u0306',   // ˘  \breve
    // 组合字符本身：原样保留
    '\u0300': '\u0300', '\u0301': '\u0301', '\u0302': '\u0302', '\u0303': '\u0303',
    '\u0304': '\u0304', '\u0306': '\u0306', '\u0307': '\u0307', '\u0308': '\u0308',
    '\u030A': '\u030A', '\u030B': '\u030B', '\u030C': '\u030C', '\u20D7': '\u20D7'
  };
  return map[t] || map[t.normalize('NFC')] || '';
}

/** 单个 MathML 节点 → MathComponent[] */
function walkNode(node) {
  const tag = tagName(node);
  if (!tag) {
    const t = node && node['#text'] != null ? String(node['#text']) : '';
    return t ? [new MathRun(t)] : [];
  }
  const kids = childrenOf(node);

  switch (tag) {
    case 'math':
    case 'mrow':
    case 'mstyle':
    case 'mpadded':
    case 'mphantom':
    case 'semantics':
    case 'merror':
      return walkRow(kids.filter(k => tagName(k) !== 'annotation' && tagName(k) !== 'annotation-xml'));

    case 'mi':
    case 'mn':
    case 'mo':
    case 'mtext':
    case 'ms': {
      const text = directText(kids) || textOfNode(node);
      return text ? [new MathRun(text)] : [];
    }

    case 'msup': {
      const [base, sup] = kids;
      return [new MathSuperScript({ children: walkNode(base), superScript: walkNode(sup) })];
    }
    case 'msub': {
      const [base, sub] = kids;
      return [new MathSubScript({ children: walkNode(base), subScript: walkNode(sub) })];
    }
    case 'msubsup': {
      const [base, sub, sup] = kids;
      return [new MathSubSuperScript({
        children: walkNode(base), subScript: walkNode(sub), superScript: walkNode(sup)
      })];
    }
    case 'mfrac': {
      const [num, den] = kids;
      return [new MathFraction({ numerator: walkNode(num), denominator: walkNode(den) })];
    }
    case 'msqrt': {
      const [body] = kids;
      return [new MathRadical({ children: walkNode(body) })];
    }
    case 'mroot': {
      const [body, degree] = kids;
      return [new MathRadical({ children: walkNode(body), degree: walkNode(degree) })];
    }
    case 'mover': {
      const [base, over] = kids;
      const accentChar = accentToChar(textOfNode(over));
      if (accentChar) return [new OmmlAccent(accentChar, walkNode(base))];
      // \overline / \underline
      const overText = textOfNode(over);
      if (/[¯‾]/.test(overText)) return [new OmmlBar(walkNode(base), 'top')];
      return [...walkNode(base), ...walkNode(over)];
    }
    case 'munder': {
      const [base, under] = kids;
      const underText = textOfNode(under);
      if (/[̲_]/.test(underText)) return [new OmmlBar(walkNode(base), 'bottom')];
      return [...walkNode(base), ...walkNode(under)];
    }
    case 'munderover': {
      const [base, under, over] = kids;
      return [...walkNode(base), ...walkNode(under), ...walkNode(over)];
    }
    case 'mfenced': {
      const open = (node[':@'] && node[':@'].open) || '(';
      const close = (node[':@'] && node[':@'].close) || ')';
      const inner = walkRow(kids);
      if (open === '(' && close === ')') return [new MathRoundBrackets({ children: inner })];
      if (open === '[' && close === ']') return [new MathSquareBrackets({ children: inner })];
      if (open === '{' && close === '}') return [new MathCurlyBrackets({ children: inner })];
      if (open === '⟨' || open === '<') return [new MathAngledBrackets({ children: inner })];
      return [new MathRun(open), ...inner, new MathRun(close)];
    }
    case 'mtable': {
      const rows = kids.filter(k => tagName(k) === 'mtr' || tagName(k) === 'mlabeledtr');
      const rowCells = rows.map(row => {
        const cells = childrenOf(row).filter(c => tagName(c) === 'mtd');
        return cells.map(cell => walkRow(childrenOf(cell)));
      });
      const maxCols = rowCells.reduce((m, r) => Math.max(m, r.length), 0);
      // 补齐列数，保证矩阵形状正确
      rowCells.forEach(r => {
        while (r.length < maxCols) r.push([new MathRun('')]);
      });
      return [new OmmlMatrix(rowCells)];
    }
    case 'mtr':
    case 'mtd':
    case 'mlabeledtr':
      return walkRow(kids);

    case 'mspace':
      return [];
    case 'menclose':
      return walkRow(kids);
    case 'mmultiscripts':
      return walkRow(kids);

    default:
      return walkRow(kids);
  }
}

/** 判断一段 LaTeX 是否可能含公式 */
export function containsMath(text) {
  return /\$\$[\s\S]+?\$\$|\$[^$\n]+?\$|\\\(|\\\[/.test(String(text || ''));
}

/* ================================================================== */
/*                    Part 2 · Markdown → docx 块                      */
/* ================================================================== */

/** 公式占位符用的私有区字符（markdown 解析器不会碰） */
const PH_OPEN = '\uE000';
const PH_CLOSE = '\uE001';

/**
 * 把公式从 markdown 里「摘出来」再交给 marked。
 *
 * 为什么必须这么做：marked 会把 `\\`（矩阵/对齐环境的换行符，也是 markdown 的
 * 「字面反斜杠」转义）吃掉，也会改写 `\,` `\{` 之类的 LaTeX 控制序列，
 * 结果是 `\begin{pmatrix} a & b \\ c & d \end{pmatrix}` 在进入 KaTeX 前就已经损坏。
 * 代码块与行内代码里的 `$` 不当作公式。
 *
 * @param {string} md
 * @returns {{text:string, store:string[]}}
 */
export function protectMath(md) {
  const s = String(md || '');
  const store = [];
  let out = '';
  let i = 0;
  const finder = /`{3,}|~{3,}|`|\$\$|\$/g;
  while (i < s.length) {
    finder.lastIndex = i;
    const m = finder.exec(s);
    if (!m) {
      out += s.slice(i);
      break;
    }
    const at = m.index;
    const tok = m[0];
    out += s.slice(i, at);

    if (tok[0] === '`' || tok[0] === '~') {
      // 代码围栏 / 行内代码：整体原样保留，不解析其中的 $
      const close = s.indexOf(tok, at + tok.length);
      if (close === -1) {
        out += s.slice(at);
        break;
      }
      out += s.slice(at, close + tok.length);
      i = close + tok.length;
      continue;
    }

    if (tok === '$$') {
      const end = s.indexOf('$$', at + 2);
      if (end !== -1 && s.slice(at + 2, end).trim().length > 0) {
        store.push(s.slice(at, end + 2));
        out += `${PH_OPEN}${store.length - 1}${PH_CLOSE}`;
        i = end + 2;
        continue;
      }
      out += tok;
      i = at + tok.length;
      continue;
    }

    // 单个 $ ... $（不跨行）
    const end = s.indexOf('$', at + 1);
    if (end !== -1 && !s.slice(at + 1, end).includes('\n') && s.slice(at + 1, end).trim().length > 0) {
      store.push(s.slice(at, end + 1));
      out += `${PH_OPEN}${store.length - 1}${PH_CLOSE}`;
      i = end + 1;
      continue;
    }
    out += tok;
    i = at + tok.length;
  }
  return { text: out, store };
}

const DEFAULT_FONT = { ascii: 'Calibri', hAnsi: 'Calibri', eastAsia: '微软雅黑' };
const MONO_FONT = { ascii: 'Consolas', hAnsi: 'Consolas', eastAsia: '微软雅黑' };

/** 行内 token → docx 段落子节点（TextRun / Math / ImageRun / 链接） */
function renderInline(tokens, ctx, style = {}) {
  const out = [];
  /** 注意：必须支持展开传参（renderPlainText 会一次返回多个 TextRun/Math 节点） */
  const push = (...nodes) => {
    for (const node of nodes) if (node) out.push(node);
  };

  for (const token of tokens || []) {
    switch (token.type) {
      case 'strong':
        out.push(...renderInline(token.tokens, ctx, { ...style, bold: true }));
        break;
      case 'em':
        out.push(...renderInline(token.tokens, ctx, { ...style, italics: true }));
        break;
      case 'del':
        out.push(...renderInline(token.tokens, ctx, { ...style, strike: true }));
        break;
      case 'codespan':
        push(new TextRun({ text: token.text, font: MONO_FONT, shading: { type: ShadingType.CLEAR, fill: 'F2F2F2' }, size: ctx.baseSize }));
        break;
      case 'br':
        push(new TextRun({ break: 1 }));
        break;
      case 'escape':
        push(...renderPlainText(token.text || '', style, ctx));
        break;
      case 'link':
        out.push(...renderLink(token, ctx, style));
        break;
      case 'image':
        out.push(...renderInlineImage(token, ctx));
        break;
      case 'html':
        push(...renderPlainText(String(token.text || '').replace(/<[^>]+>/g, ''), style, ctx));
        break;
      case 'text':
        if (token.tokens && token.tokens.length) out.push(...renderInline(token.tokens, ctx, style));
        else push(...renderPlainText(token.text || '', style, ctx));
        break;
      default:
        if (token.tokens) out.push(...renderInline(token.tokens, ctx, style));
        else if (token.text) push(...renderPlainText(token.text, style, ctx));
    }
  }
  return out;
}

/** 文本里切出 $...$ / $$...$$ 公式（占位符由 protectMath 预先替换） */
function renderPlainText(text, style, ctx) {
  const src = String(text || '');
  const out = [];
  const re = /\uE000(\d+)\uE001|\\\(([\s\S]+?)\\\)|\\\[([\s\S]+?)\\\]/g;
  let last = 0;
  let m;
  while ((m = re.exec(src))) {
    if (m.index > last) out.push(makeTextRun(src.slice(last, m.index), style, ctx));
    let tex = '';
    let display = false;
    if (m[1] !== undefined) {
      const span = String((ctx.mathStore || [])[Number(m[1])] || '');
      display = span.startsWith('$$');
      tex = display ? span.slice(2, -2) : span.slice(1, -1);
    } else if (m[2] !== undefined) {
      tex = m[2];
    } else {
      tex = m[3];
      display = true;
    }
    const children = texToMathChildren(tex, display);
    if (children.length) out.push(new DocxMath({ children }));
    last = m.index + m[0].length;
  }
  if (last < src.length) out.push(makeTextRun(src.slice(last), style, ctx));
  return out.filter(Boolean);
}

function makeTextRun(text, style, ctx) {
  if (text === '') return null;
  return new TextRun({
    text,
    bold: !!style.bold,
    italics: !!style.italics,
    strike: !!style.strike,
    font: DEFAULT_FONT,
    size: ctx.baseSize,
    color: style.color
  });
}

function renderLink(token, ctx, style) {
  const href = token.href || '';
  const children = renderInline(token.tokens, ctx, { ...style, color: '1155CC' });
  if (!href || href.startsWith('#')) return children;
  try {
    return [new ExternalHyperlink({ children, link: href })];
  } catch (e) {
    return children;
  }
}

function renderInlineImage(token, ctx) {
  const src = token.href || '';
  const resolved = ctx.resolveImage ? ctx.resolveImage(src) : null;
  if (!resolved) {
    return [new TextRun({ text: `[图片：${shortSrcLabel(token.text || src)}]`, font: DEFAULT_FONT, size: ctx.baseSize, color: '888888' })];
  }
  try {
    return [new ImageRun({
      data: resolved.data,
      type: resolved.type || 'png',
      transformation: { width: resolved.width, height: resolved.height }
    })];
  } catch (e) {
    return [new TextRun({ text: `[图片无法嵌入：${shortSrcLabel(token.text || src)}]`, font: DEFAULT_FONT, size: ctx.baseSize, color: 'CC0000' })];
  }
}

/**
 * 占位提示里不要塞进整串地址。
 * data URL 动辄几十上百 KB，直接写进文档就是满页 base64（曾经真的发生过）。
 */
function shortSrcLabel(src) {
  const s = String(src || '');
  if (/^data:/i.test(s)) return '内联图片（data URL，未能嵌入）';
  if (/^blob:/i.test(s)) return '本地临时图片（blob，未能嵌入）';
  return s.length > 60 ? `${s.slice(0, 57)}…` : s;
}

/** 列表 → 段落数组（支持多级嵌套） */
function renderList(token, ctx, level = 0) {
  const out = [];
  const ordered = !!token.ordered;
  const start = Number.isInteger(token.start) && token.start !== '' ? Number(token.start) : 1;
  (token.items || []).forEach((item, idx) => {
    const prefix = ordered ? `${start + idx}. ` : '• ';
    // 取第一段作为与项目符号同行的内容，其余段落独立成段
    const first = [];
    const rest = [];
    let firstTaken = false;
    for (const t of item.tokens || []) {
      if (t.type === 'text' || t.type === 'paragraph') {
        const inline = t.tokens ? renderInline(t.tokens, ctx) : renderPlainText(t.text || '', {}, ctx);
        if (!firstTaken) {
          first.push(...inline);
          firstTaken = true;
        } else {
          rest.push(new Paragraph({ children: inline, indent: { left: 360 * (level + 1) } }));
        }
      } else if (t.type === 'list') {
        rest.push(...renderList(t, ctx, level + 1));
      } else if (t.type === 'code') {
        rest.push(...renderCodeBlock(t, ctx));
      } else if (t.type === 'blockquote') {
        rest.push(...renderBlockquote(t, ctx));
      } else if (t.type === 'space') {
        // 忽略
      } else {
        rest.push(...renderBlocks([t], ctx));
      }
    }
    if (!firstTaken) first.push(new TextRun({ text: '', font: DEFAULT_FONT }));
    out.push(new Paragraph({
      children: [
        new TextRun({ text: prefix, font: DEFAULT_FONT, size: ctx.baseSize }),
        ...first
      ],
      indent: { left: 360 * (level + 1), hanging: 360 },
      spacing: { after: 60 }
    }));
    out.push(...rest);
  });
  return out;
}

/** 代码块 */
function renderCodeBlock(token, ctx) {
  const lines = String(token.text || '').split('\n');
  const children = [];
  if (token.lang) {
    children.push(new TextRun({ text: `${token.lang}\n`, font: MONO_FONT, size: ctx.baseSize - 2, color: '888888' }));
  }
  lines.forEach((line, i) => {
    children.push(new TextRun({
      text: line,
      font: MONO_FONT,
      size: ctx.baseSize - 2,
      break: i === 0 ? 0 : 1
    }));
  });
  return [new Paragraph({
    children,
    shading: { type: ShadingType.CLEAR, fill: 'F6F8FA' },
    border: {
      top: { style: BorderStyle.SINGLE, size: 4, color: 'E1E4E8' },
      bottom: { style: BorderStyle.SINGLE, size: 4, color: 'E1E4E8' },
      left: { style: BorderStyle.SINGLE, size: 4, color: 'E1E4E8' },
      right: { style: BorderStyle.SINGLE, size: 4, color: 'E1E4E8' }
    },
    spacing: { before: 80, after: 120 }
  })];
}

/** 引用块 */
function renderBlockquote(token, ctx) {
  const blocks = renderBlocks(token.tokens || [], { ...ctx, quoteDepth: (ctx.quoteDepth || 0) + 1 });
  return blocks.map(p => p);
}

/** 表格 */
function renderTable(token, ctx) {
  const headerCells = (token.header || []).map(cell => makeCell(cell, ctx, true));
  const bodyRows = (token.rows || []).map(row => new TableRow({
    children: row.map(cell => makeCell(cell, ctx, false))
  }));
  const widths = null;
  return [new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [new TableRow({ tableHeader: true, children: headerCells }), ...bodyRows],
    borders: {
      top: { style: BorderStyle.SINGLE, size: 4, color: 'BFBFBF' },
      bottom: { style: BorderStyle.SINGLE, size: 4, color: 'BFBFBF' },
      left: { style: BorderStyle.SINGLE, size: 4, color: 'BFBFBF' },
      right: { style: BorderStyle.SINGLE, size: 4, color: 'BFBFBF' },
      insideHorizontal: { style: BorderStyle.SINGLE, size: 4, color: 'D9D9D9' },
      insideVertical: { style: BorderStyle.SINGLE, size: 4, color: 'D9D9D9' }
    }
  })];
}

function makeCell(cell, ctx, isHeader) {
  const children = cell && cell.tokens ? renderInline(cell.tokens, ctx, isHeader ? { bold: true } : {}) : [];
  return new TableCell({
    children: [new Paragraph({ children: children.length ? children : [new TextRun({ text: '' })], spacing: { after: 0 } })],
    shading: isHeader ? { type: ShadingType.CLEAR, fill: 'F2F4F7' } : undefined
  });
}

/** 块级 token → 段落数组 */
function renderBlocks(tokens, ctx) {
  const out = [];
  for (const token of tokens || []) {
    switch (token.type) {
      case 'heading': {
        const level = Math.min(6, Math.max(1, token.depth || 1));
        const map = {
          1: HeadingLevel.HEADING_1, 2: HeadingLevel.HEADING_2, 3: HeadingLevel.HEADING_3,
          4: HeadingLevel.HEADING_4, 5: HeadingLevel.HEADING_5, 6: HeadingLevel.HEADING_6
        };
        out.push(new Paragraph({
          children: renderInline(token.tokens, ctx),
          heading: map[level],
          spacing: { before: 200, after: 100 }
        }));
        break;
      }
      case 'paragraph': {
        const children = renderInline(token.tokens, ctx);
        if (children.length === 0) break;
        // 整段只有一张图片 → 居中的块级图片
        const onlyImage = (token.tokens || []).length === 1 && token.tokens[0].type === 'image';
        out.push(new Paragraph({
          children,
          alignment: onlyImage ? AlignmentType.CENTER : undefined,
          indent: ctx.quoteDepth ? { left: 360 * ctx.quoteDepth } : undefined,
          border: ctx.quoteDepth ? { left: { style: BorderStyle.SINGLE, size: 12, color: 'D0D5DD' } } : undefined,
          spacing: { after: 120 }
        }));
        break;
      }
      case 'text': {
        const children = token.tokens ? renderInline(token.tokens, ctx) : renderPlainText(token.text || '', {}, ctx);
        if (children.length) out.push(new Paragraph({ children, spacing: { after: 120 } }));
        break;
      }
      case 'code':
        out.push(...renderCodeBlock(token, ctx));
        break;
      case 'blockquote':
        out.push(...renderBlockquote(token, ctx));
        break;
      case 'list':
        out.push(...renderList(token, ctx, ctx.quoteDepth || 0));
        break;
      case 'table':
        out.push(...renderTable(token, ctx));
        break;
      case 'hr':
        out.push(new Paragraph({
          text: '',
          border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: 'CCCCCC' } },
          spacing: { before: 120, after: 120 }
        }));
        break;
      case 'space':
        break;
      case 'html': {
        const text = String(token.text || '').replace(/<[^>]+>/g, '').trim();
        if (text) out.push(new Paragraph({ children: renderPlainText(text, {}, ctx), spacing: { after: 120 } }));
        break;
      }
      default: {
        if (token.tokens) out.push(...renderBlocks(token.tokens, ctx));
        else if (token.text) out.push(new Paragraph({ children: renderPlainText(token.text, {}, ctx) }));
      }
    }
  }
  return out;
}

/* ================================================================== */
/*                      Part 3 · 对外 API                              */
/* ================================================================== */

/**
 * Markdown → docx Document 对象。
 * @param {string} md
 * @param {object} [opts]
 * @param {string} [opts.title] 文档标题（写入 docx 元数据，不额外排版）
 * @param {(src:string)=>({data:Uint8Array|ArrayBuffer|string, type?:string, width?:number, height?:number}|null)} [opts.resolveImage]
 * @param {number} [opts.baseSize] 正文字号（半点，默认 21 = 10.5pt 五号）
 * @param {number} [opts.imageMaxWidth] 单张图最大宽度 px
 */
export function markdownToDocument(md, opts = {}) {
  const { text, store } = protectMath(md);
  const ctx = {
    baseSize: opts.baseSize || 21,
    resolveImage: makeImageResolver(opts),
    quoteDepth: 0,
    mathStore: store
  };
  const tokens = marked.lexer(text);
  const children = renderBlocks(tokens, ctx);
  if (children.length === 0) children.push(new Paragraph({ children: [new TextRun({ text: '（空文档）' })] }));

  return new Document({
    creator: opts.creator || 'DeepSeek Exporter Pro',
    title: opts.title || '对话导出',
    description: '由 DeepSeek Exporter Pro 的 Markdown → DOCX 转换器生成',
    styles: {
      default: {
        document: { run: { font: DEFAULT_FONT, size: ctx.baseSize } }
      }
    },
    sections: [{
      properties: {
        page: { margin: { top: 1134, right: 1134, bottom: 1134, left: 1134 } } // 2cm
      },
      children
    }]
  });
}

/** 包装 resolveImage，统一补上默认宽高与单位换算 */
function makeImageResolver(opts) {
  const maxWidth = opts.imageMaxWidth || 620;
  const userResolve = opts.resolveImage;
  if (!userResolve) return null;
  return src => {
    const r = userResolve(src);
    if (!r || !r.data) return null;
    let { width, height } = r;
    if (!width || !height) {
      const size = imageSizeFromBytes(r.data);
      width = size.width || 480;
      height = size.height || 320;
    }
    if (width > maxWidth) {
      height = Math.round(height * (maxWidth / width));
      width = maxWidth;
    }
    return { data: r.data, type: r.type || 'png', width, height };
  };
}

/**
 * 从图片字节里读出宽高（PNG / JPEG / GIF / BMP / WEBP）。
 * 避免为了排版尺寸而在 Node 里依赖 DOM。
 */
export function imageSizeFromBytes(input) {
  const b = input instanceof Uint8Array ? input : new Uint8Array(input);
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  // PNG
  if (b.length > 24 && b[0] === 0x89 && b[1] === 0x50) {
    return { width: dv.getUint32(16), height: dv.getUint32(20) };
  }
  // GIF
  if (b.length > 10 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) {
    return { width: dv.getUint16(6, true), height: dv.getUint16(8, true) };
  }
  // BMP
  if (b.length > 26 && b[0] === 0x42 && b[1] === 0x4d) {
    return { width: dv.getInt32(18, true), height: Math.abs(dv.getInt32(22, true)) };
  }
  // WEBP (VP8X / VP8 / VP8L)
  if (b.length > 30 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) {
    const fourcc = String.fromCharCode(b[12], b[13], b[14], b[15]);
    if (fourcc === 'VP8X') {
      const w = 1 + (b[24] | (b[25] << 8) | (b[26] << 16));
      const h = 1 + (b[27] | (b[28] << 8) | (b[29] << 16));
      return { width: w, height: h };
    }
    if (fourcc === 'VP8 ') {
      return { width: dv.getUint16(26, true) & 0x3fff, height: dv.getUint16(28, true) & 0x3fff };
    }
    if (fourcc === 'VP8L') {
      const bits = dv.getUint32(21, true);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
  }
  // JPEG：扫描 SOF 段
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i++; continue; }
      const marker = b[i + 1];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
      const len = dv.getUint16(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: dv.getUint16(i + 5), width: dv.getUint16(i + 7) };
      }
      i += 2 + len;
    }
  }
  return { width: 0, height: 0 };
}

/**
 * Markdown → docx 二进制（Uint8Array），Node / 浏览器通用。
 *
 * 注意：必须用 toArrayBuffer 而不是 toBuffer —— 浏览器里 JSZip 不支持
 * "nodebuffer" 输出类型，会在导出 Word 时抛错。
 */
export async function mdToDocxBuffer(md, opts = {}) {
  const doc = markdownToDocument(md, opts);
  const buf = await Packer.toArrayBuffer(doc);
  return new Uint8Array(buf);
}

/** Markdown → base64（便于经 data: URL 交给下载 API） */
export async function mdToDocxBase64(md, opts = {}) {
  const doc = markdownToDocument(md, opts);
  // base64 在浏览器与 Node 的 JSZip 里都受支持，最省事
  return await Packer.toBase64String(doc);
}

/** Markdown → Blob（浏览器） */
export async function mdToDocxBlob(md, opts = {}) {
  const doc = markdownToDocument(md, opts);
  return await Packer.toBlob(doc);
}

/** Uint8Array → base64（分块避免超长参数爆栈） */
export function bytesToBase64(bytes) {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < arr.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, arr.subarray(i, i + CHUNK));
  }
  if (typeof btoa === 'function') return btoa(binary);
  // Node 环境
  return Buffer.from(binary, 'binary').toString('base64');
}

export const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
export { MATH_NS };
