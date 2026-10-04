/**
 * 文件名与路径工具
 *
 * Windows 文件名限制：不能含 < > : " / \ | ? * 与控制字符，
 * 结尾不能是点或空格，单段建议 ≤ 120 字符（中文 1 字符算 1）。
 *
 * @file src/core/filename.js
 */

const ILLEGAL = /[<>:"/\\|?*\x00-\x1f]/g;
/** Windows 保留设备名 */
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/**
 * 清洗单个路径段。
 * @param {string} name
 * @param {string} [fallback]
 * @param {number} [maxLen]
 * @returns {string}
 */
export function safeName(name, fallback = '未命名', maxLen = 80) {
  let s = String(name == null ? '' : name)
    .replace(ILLEGAL, '_')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  s = s.replace(/[. ]+$/, '');
  if (s.length > maxLen) s = s.slice(0, maxLen).trim();
  if (!s) s = fallback;
  if (RESERVED.test(s)) s = `_${s}`;
  return s;
}

/** 清洗整条相对路径（逐段清洗，保留 /） */
export function safePath(relPath, fallback = '未命名') {
  const parts = String(relPath || '').replace(/\\/g, '/').split('/').filter(Boolean);
  if (parts.length === 0) return fallback;
  return parts.map(p => safeName(p, fallback)).join('/');
}

function pad(n) {
  return String(n).padStart(2, '0');
}

/** 本地时间戳：用于文件名前缀 */
export function stamp(date = new Date()) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + `_${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

/** 只有日期：用于子文件夹 */
export function dateStamp(date = new Date()) {
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
}

/**
 * 把会话标题规整成可读文件名主干。
 * @param {string} title
 * @param {number} index 用于兜底命名
 */
export function conversationBasename(title, index = 0) {
  const cleaned = safeName(title || '', '', 60);
  if (cleaned) return cleaned;
  return `对话${String(index + 1).padStart(2, '0')}`;
}

/**
 * 子文件夹名生成：支持 {date} {time} {title} {id} {index}
 * @param {string} pattern
 * @param {{title?:string,id?:string,index?:number,date?:Date}} data
 */
export function buildSubfolder(pattern, data = {}) {
  const d = data.date || new Date();
  const title = conversationBasename(data.title, data.index || 0);
  const raw = String(pattern || '{date}_{title}')
    .replace(/\{date\}/g, dateStamp(d))
    .replace(/\{time\}/g, `${pad(d.getHours())}${pad(d.getMinutes())}`)
    .replace(/\{title\}/g, title)
    .replace(/\{id\}/g, safeName(data.id || '', 'unknown', 40))
    .replace(/\{index\}/g, String((data.index || 0) + 1).padStart(2, '0'));
  return safeName(raw, title, 80);
}

/**
 * 同一批导出里防止重名：已用过的名字追加 (2)(3)...
 * @param {string} base 不含扩展名
 * @param {string} ext 含点，如 '.md'
 * @param {Set<string>} used
 */
export function dedupe(base, ext, used) {
  let candidate = `${base}${ext}`;
  let i = 2;
  while (used.has(candidate.toLowerCase())) {
    candidate = `${base} (${i})${ext}`;
    i++;
    if (i > 999) break;
  }
  used.add(candidate.toLowerCase());
  return candidate;
}

/** 拼接相对路径（用 / ，下载 API 需要） */
export function joinPath(...parts) {
  return parts
    .filter(p => p !== undefined && p !== null && String(p).length > 0)
    .map(p => String(p).replace(/\\/g, '/').replace(/^\/+|\/+$/g, ''))
    .filter(Boolean)
    .join('/');
}

/** 扩展名（含点，小写） */
export function extname(name) {
  const m = String(name || '').match(/(\.[a-z0-9]{1,5})$/i);
  return m ? m[1].toLowerCase() : '';
}

/** 去掉扩展名 */
export function stem(name) {
  return String(name || '').replace(/\.[a-z0-9]{1,5}$/i, '');
}
