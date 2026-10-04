/**
 * 导出编排：Turn[] + 勾选 → 最终文件内容
 *
 * 这一层是纯函数（不碰 DOM、不碰网络），方便单测与复用：
 * 输入是已经抽好的结构化消息，输出是 markdown / 纯文本 / JSON
 * 以及「需要落盘的图片清单」。
 *
 * @file src/core/exporter.js
 */

import { SLOTS, SLOT_LABELS, ROLE, ROLE_LABELS, turnToMarkdown, turnContentInfo } from './model.js';
import { markdownToPlain } from './domToMarkdown.js';
import { safeName } from './filename.js';

/**
 * 为一组图片分配文件名。
 * @param {object[]} turns
 * @param {{folder?:string, format?:string}} opts
 * @returns {Map<string, {path:string, format:string}>} key = image.id
 */
export function planImageFiles(turns, opts = {}) {
  const folder = (opts.folder || 'images').replace(/^\/+|\/+$/g, '');
  const format = opts.format || 'png';
  const ext0 = format === 'jpeg' ? 'jpg' : format;
  const plan = new Map();
  let n = 0;

  const extOf = img => (format === 'original' ? (guessExt(img) || 'png') : ext0);

  turns.forEach((turn, ti) => {
    (turn.images || []).forEach(img => {
      n++;
      const base = img.basename
        ? safeName(img.basename, `img-${n}`, 40)
        : `img-${String(ti + 1).padStart(2, '0')}-${String(n).padStart(2, '0')}`;
      plan.set(img.id, { path: `${folder}/${base}.${extOf(img)}`, format, base, ext: extOf(img) });
    });
  });

  // 正文里以 markdown 链接形式出现的图片：不属于任何一条消息的附件，
  // 但要和附件一样落盘（否则 .md 里留的是会过期的远端链接，复习时图就没了）
  (opts.extraAssets || []).forEach((img, i) => {
    if (!img || !img.id) return;
    const base = img.basename
      ? safeName(img.basename, `img-inline-${i + 1}`, 40)
      : `img-inline-${String(i + 1).padStart(2, '0')}`;
    plan.set(img.id, { path: `${folder}/${base}.${extOf(img)}`, format, base, ext: extOf(img) });
  });

  return plan;
}

/** 从 markdown 文本里抽出图片链接（供导出前统一收集正文内联图片） */
export function extractMarkdownImageUrls(text) {
  const out = [];
  const re = /!\[[^\]]*\]\(\s*<?([^)\s>]+)>?[^)]*\)/g;
  let m;
  while ((m = re.exec(String(text || '')))) {
    const u = m[1];
    if (/^(https?:|data:|blob:)/i.test(u)) out.push(u);
  }
  return out;
}

/**
 * 把 markdown 里仍在指向远端的图片引用改写成本地文件路径。
 * 只改我们确实已经把字节存下来的那些（urlToPath 里有的）。
 */
export function rewriteInlineImagePaths(md, urlToPath) {
  if (!urlToPath || urlToPath.size === 0) return md;
  return String(md).replace(/(!\[[^\]]*\]\()\s*<?([^)\s>]+)>?([^)]*\))/g, (full, pre, url, post) => {
    let hit = urlToPath.get(url);
    if (!hit) {
      try {
        hit = urlToPath.get(decodeURIComponent(url));
      } catch (e) { /* 原样保留 */ }
    }
    return hit ? `${pre}${encodeURI(hit)}${post}` : full;
  });
}

function guessExt(img) {
  const m = String(img.mime || '').match(/^image\/(\w+)/);
  if (m) return m[1] === 'jpeg' ? 'jpg' : m[1];
  const m2 = String(img.src || '').match(/\.(png|jpe?g|gif|webp|bmp|avif|svg)(\?|$)/i);
  return m2 ? m2[1].toLowerCase().replace('jpeg', 'jpg') : '';
}

/**
 * 生成 markdown。图片以「相对路径引用」或「base64 内联」输出。
 *
 * @param {object} input
 * @param {string} input.title
 * @param {object[]} input.turns
 * @param {object} input.slots
 * @param {Map} [input.imagePlan]
 * @param {Map<string,string>} [input.imageDataUrls] 内联模式下的 base64
 * @param {object} [input.meta] { site, url, time }
 * @param {boolean} [input.roleHeading]
 * @param {boolean} [input.index] 是否输出会话信息头部
 */
export function buildMarkdown(input) {
  const {
    title, turns, slots, imagePlan, imageDataUrls, meta = {},
    roleHeading = true, index = true, turnSeparator = '\n\n---\n\n',
    inlineImagePathMap = null
  } = input;

  const imageInline = !!(imageDataUrls && imageDataUrls.size > 0);
  const imageRef = img => {
    const alt = img.alt || '图片';
    if (imageInline) {
      const data = imageDataUrls.get(img.id);
      if (data) return `![${alt}](${data})`;
    }
    const plan = imagePlan && imagePlan.get(img.id);
    return plan ? `![${alt}](${encodeURI(plan.path)})` : `![${alt}](${img.src})`;
  };

  let head = '';
  if (index) {
    const lines = [`# ${title}`, ''];
    if (meta.site) lines.push(`> 来源站点：${meta.site}`);
    if (meta.url) lines.push(`> 会话链接：${meta.url}`);
    if (meta.time) lines.push(`> 导出时间：${meta.time}`);
    lines.push(`> 导出内容：${describeSlots(slots)}`);
    head = lines.join('\n');
  }

  const bodies = [];
  let kept = 0;
  let skipped = 0;
  for (const turn of turns) {
    // 每条消息可以用自己的勾选（turn.__slots）覆盖全局勾选
    const s = turn.__slots || slots;
    const info = turnContentInfo(turn, s);
    if (info.empty) {
      skipped++;
      continue;
    }
    const md = turnToMarkdown(turn, s, { imageRef, roleHeading });
    if (!md.trim()) {
      skipped++;
      continue;
    }
    bodies.push(md.trim());
    kept++;
  }

  const body = bodies.join(turnSeparator);
  let merged = head ? `${head}\n\n---\n\n${body}\n` : `${body}\n`;
  // 正文里仍在指向远端的图片 → 换成我们确实存下来的本地路径
  if (inlineImagePathMap && inlineImagePathMap.size > 0) {
    merged = rewriteInlineImagePaths(merged, inlineImagePathMap);
  }
  return { markdown: cleanup(merged), kept, skipped };
}

function cleanup(md) {
  return String(md)
    .replace(/\r\n?/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/^\n+/, '')
    .replace(/\n{1,}$/, '\n');
}

/** 「提问+思考+回答+图片」这样的中文描述，写进导出文件的头部 */
export function describeSlots(slots) {
  const names = SLOTS.filter(s => slots[s]).map(s => SLOT_LABELS[s]);
  return names.length ? names.join(' + ') : '（无）';
}

/** 纯文本导出 */
export function buildPlainText(input) {
  const { markdown, kept, skipped } = buildMarkdown({ ...input, roleHeading: true });
  return { text: markdownToPlain(markdown) + '\n', kept, skipped };
}

/** JSON 导出：保留完整结构，便于二次加工 */
export function buildJson(input) {
  const { title, turns, slots, meta = {} } = input;
  const data = {
    schema: 'dsx-export-v1',
    title,
    site: meta.site || '',
    url: meta.url || '',
    exportedAt: meta.timeIso || new Date().toISOString(),
    selection: SLOTS.filter(s => slots[s]),
    messages: turns.map(t => {
      const s = t.__slots || slots;
      const info = turnContentInfo(t, s);
      return {
        index: t.index,
        role: t.role,
        roleLabel: ROLE_LABELS[t.role] || t.role,
        parts: info.parts,
        question: s.question ? t.question : undefined,
        thinking: s.thinking ? t.thinking : undefined,
        answer: s.answer ? t.answer : undefined,
        images: s.images
          ? (t.images || []).map(i => ({ src: i.src, alt: i.alt, slot: i.slot }))
          : undefined
      };
    }).filter(m => m.parts.length > 0)
  };
  return { json: JSON.stringify(data, null, 2), kept: data.messages.length, skipped: turns.length - data.messages.length };
}

/** 批量导出的索引文件 */
export function buildBatchIndex(entries, meta = {}) {
  const lines = [`# ${meta.title || 'DeepSeek 对话批量导出'}`, ''];
  if (meta.time) lines.push(`> 导出时间：${meta.time}`);
  lines.push(`> 会话数量：${entries.length}`);
  lines.push(`> 导出格式：${meta.formats || 'md'}`);
  lines.push('');

  const hasCategory = (entries || []).some(e => e && e.category);
  lines.push(hasCategory
    ? '| # | 会话 | 分类 | 消息数 | 文件 |'
    : '| # | 会话 | 消息数 | 文件 |');
  lines.push(hasCategory
    ? '| --- | --- | --- | --- | --- |'
    : '| --- | --- | --- | --- |');
  entries.forEach((e, i) => {
    const files = (e.files || []).map(f => `\`${f}\``).join('、');
    const cells = hasCategory
      ? [i + 1, escapeCell(e.title), escapeCell(e.category || ''), e.messageCount ?? '-', files || '-']
      : [i + 1, escapeCell(e.title), e.messageCount ?? '-', files || '-'];
    lines.push(`| ${cells.join(' | ')} |`);
  });
  lines.push('');

  // 按分类汇总，一眼看出各科目收录了多少
  if (hasCategory) {
    const byCat = new Map();
    entries.forEach(e => {
      const k = e.category || '未分类';
      byCat.set(k, (byCat.get(k) || 0) + 1);
    });
    lines.push('## 分类统计');
    lines.push('');
    for (const [k, v] of [...byCat.entries()].sort((a, b) => b[1] - a[1])) {
      lines.push(`- ${k}：${v} 个会话`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

function escapeCell(s) {
  return String(s == null ? '' : s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

export { SLOTS, SLOT_LABELS, ROLE };
