/**
 * DeepSeek 内部接口客户端
 *
 * 为什么优先走接口而不是抓 DOM：
 * 1. 接口返回的是**原始 markdown**（含 LaTeX 源码），而 DeepSeek 有第二套
 *    WASM 公式渲染器输出内联 SVG，那条路径下 LaTeX 在 DOM 里根本不存在；
 * 2. 接口带 message_id / parent_id，可以精确重建「当前分支」——
 *    页面上重新生成、编辑过的历史消息都能正确还原；
 * 3. 批量导出不需要逐个点开会话、不需要滚动虚拟列表，快且稳。
 *
 * 契约来自公开开源实现（MIT，agoramachina/deepseek-exporter）与线上 bundle 双向印证：
 *   令牌：localStorage.userToken → JSON.parse(...).value
 *   请求头：Authorization: Bearer <token>
 *   响应：{ code, msg, data: { biz_code, biz_msg, biz_data } }
 *   会话列表：biz_data.chat_sessions[] = { id, title, updated_at, ... }，biz_data.has_more
 *   消息历史：biz_data.chat_messages[]  = { message_id, parent_id, role, content, thinking_content, ... }
 *             biz_data.chat_session     = { title, current_message_id, inserted_at, updated_at }
 *
 * @file src/adapters/deepseek.api.js
 */

import { createTurn, createImage, ROLE, SLOTS } from '../core/model.js';

const BASE = 'https://chat.deepseek.com';
const TOKEN_KEY = 'userToken';

/** 读取登录令牌 */
export function getToken() {
  try {
    const raw = localStorage.getItem(TOKEN_KEY);
    if (!raw) return '';
    const t = raw.trim();
    if (t.startsWith('{')) {
      const obj = JSON.parse(t);
      if (obj && obj.value) return String(obj.value);
      if (obj && obj.token) return String(obj.token);
      return '';
    }
    return t.replace(/^"|"$/g, '');
  } catch (e) {
    return '';
  }
}

/** 接口是否可用（只做本地判断，不发请求） */
export function apiAvailable() {
  return !!getToken();
}

/**
 * 统一请求：自动带令牌、校验业务码、解包到 biz_data。
 * @param {string} path 例如 /api/v0/chat/history_messages?chat_session_id=xxx
 * @param {number} [timeoutMs]
 */
export async function apiFetch(path, timeoutMs = 30000) {
  const token = getToken();
  if (!token) throw new Error('未找到登录令牌（userToken），无法使用接口模式');

  const url = path.startsWith('http') ? path : `${BASE}${path}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      credentials: 'include',
      signal: ctrl.signal
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const json = await resp.json();
    if (!json || json.code !== 0 || (json.data && json.data.biz_code !== 0)) {
      const msg = json && (json.msg || (json.data && json.data.biz_msg)) || '未知错误';
      throw new Error(`接口返回错误：${msg}`);
    }
    return (json.data && json.data.biz_data) || {};
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 拉取全部会话（自动翻页）。
 * @param {{onPage?: (count:number)=>void, maxPages?: number}} [opts]
 * @returns {Promise<Array<{id:string, title:string, updated_at:number}>>}
 */
export async function fetchSessionList(opts = {}) {
  const maxPages = opts.maxPages || 200;
  const out = [];
  const seen = new Set();
  let url = '/api/v0/chat_session/fetch_page?lte_cursor.pinned=false';

  for (let page = 0; page < maxPages; page++) {
    const biz = await apiFetch(url);
    const items = biz.chat_sessions || [];
    let added = 0;
    for (const item of items) {
      const id = item.id || item.session_id;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push({
        id,
        title: (item.title || '').trim() || '未命名会话',
        updated_at: item.updated_at || 0,
        pinned: !!item.pinned
      });
      added++;
    }
    if (opts.onPage) opts.onPage(out.length);
    if (!biz.has_more || items.length === 0 || added === 0) break;
    const last = items[items.length - 1];
    if (!last || !last.updated_at) break;
    url = `/api/v0/chat_session/fetch_page?lte_cursor.pinned=false&lte_cursor.updated_at=${last.updated_at}`;
  }
  return out;
}

/** 拉取单个会话的完整历史 */
export async function fetchConversation(sessionId) {
  return await apiFetch(`/api/v0/chat/history_messages?chat_session_id=${encodeURIComponent(sessionId)}&cache_version=0`);
}

/**
 * 从消息树里还原「当前分支」：从 current_message_id 沿 parent_id 回溯。
 * 这是处理「重新生成 / 编辑提问」产生的分支结构的正确方式。
 */
export function currentBranch(data) {
  const messages = (data && data.chat_messages) || [];
  const session = (data && data.chat_session) || {};
  if (!messages.length) return [];
  const map = new Map();
  messages.forEach(m => map.set(m.message_id, m));

  let id = session.current_message_id;
  const branch = [];
  const guard = new Set();
  while (id && map.has(id) && !guard.has(id)) {
    guard.add(id);
    const msg = map.get(id);
    branch.unshift(msg);
    id = msg.parent_id;
  }
  if (branch.length === 0) {
    // 没有 current_message_id（旧数据）：退化为数组顺序
    return messages.slice();
  }
  return branch;
}

/** 清掉模型输出里的控制标记 */
function cleanContent(text) {
  return String(text == null ? '' : text)
    .replace(/<[｜|]end▁of▁sentence[｜|]>/g, '')
    .replace(/<｜end_of_sentence｜>/g, '')
    .replace(/^\s*FINISHED\s*$/gm, '')
    .trim();
}

/**
 * 从任意「内容容器」里取出纯文本。
 * 接口的同一个字段在不同版本里可能是 string / {content} / {text} / [{...}]，
 * 所以统一递归拆一遍，避免因为结构微调就整段丢失。
 */
function contentToText(value, depth = 0) {
  if (value == null || depth > 5) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    return value.map(v => contentToText(v, depth + 1)).filter(Boolean).join('\n\n');
  }
  if (typeof value === 'object') {
    for (const k of ['content', 'text', 'value', 'markdown', 'answer', 'result', 'data']) {
      if (value[k] !== undefined) {
        const t = contentToText(value[k], depth + 1);
        if (t) return t;
      }
    }
    return '';
  }
  return '';
}

/**
 * 片段类型归一化。
 * 新版 DeepSeek 把正文放在 `fragments[]` 里，每段带一个 type，
 * 命名可能是 REQUEST / RESPONSE / THINK / SEARCH 等（大小写不固定）。
 */
function classifyFragmentType(type) {
  const t = String(type == null ? '' : type).toUpperCase();
  if (!t) return '';
  if (/THINK|REASON/.test(t)) return 'thinking';
  if (/REQUEST|QUESTION|PROMPT|USER|INPUT/.test(t)) return 'question';
  if (/RESPONSE|ANSWER|REPLY|CONTENT|TEXT|OUTPUT|MESSAGE/.test(t)) return 'answer';
  return '';
}

/**
 * 抽取一条消息的提问 / 思考 / 回答。
 *
 * 兼容三种历史形态（这是插件曾经"标题正常但正文全空"的根因）：
 *   A. 扁平字段：content + thinking_content            （旧版）
 *   B. fragments[]：每段 { type, content }             （新版，正文在这里）
 *   C. content 里内嵌 <think>…</think>                 （部分版本）
 *
 * @param {object} msg
 * @returns {{question:string, thinking:string, answer:string, source:string, fragmentTypes:string[]}}
 */
export function extractMessageParts(msg) {
  const parts = { question: '', thinking: '', answer: '', source: '', fragmentTypes: [] };
  if (!msg || typeof msg !== 'object') return parts;

  // A. 扁平字段（也兜住各家不同的命名）
  const flatContent = contentToText(msg.content)
    || contentToText(msg.text)
    || contentToText(msg.message)
    || '';
  const flatThink = contentToText(
    msg.thinking_content != null ? msg.thinking_content
      : msg.reasoning_content != null ? msg.reasoning_content
        : msg.think_content != null ? msg.think_content
          : msg.thinking != null ? msg.thinking
            : msg.reasoning
  );

  // B. fragments[]
  const frags = Array.isArray(msg.fragments) ? msg.fragments
    : Array.isArray(msg.content_fragments) ? msg.content_fragments
      : [];
  if (frags.length) {
    const buckets = { question: [], thinking: [], answer: [], other: [] };
    for (const f of frags) {
      if (f == null) continue;
      if (typeof f === 'string') {
        if (f.trim()) buckets.other.push(f);
        continue;
      }
      const type = f.type != null ? f.type : (f.fragment_type != null ? f.fragment_type : f.kind);
      const text = contentToText(f);
      parts.fragmentTypes.push(String(type == null ? '?' : type));
      if (!text) continue;
      const kind = classifyFragmentType(type);
      buckets[kind || 'other'].push(text);
    }
    parts.question = buckets.question.join('\n\n');
    parts.thinking = buckets.thinking.join('\n\n');
    parts.answer = buckets.answer.join('\n\n');
    // 认不出的类型也当正文，宁可多导出也别丢内容
    if (!parts.answer && buckets.other.length) parts.answer = buckets.other.join('\n\n');
    parts.source = 'fragments';
  }

  if (!parts.answer && flatContent) {
    parts.answer = flatContent;
    parts.source = parts.source || 'content';
  }
  if (!parts.thinking && flatThink) {
    parts.thinking = flatThink;
    parts.source = parts.source || 'thinking_content';
  }
  if (!parts.question && !parts.answer && !parts.thinking && flatContent) {
    parts.answer = flatContent;
  }

  // C. content 里的 <think> 标签
  if (parts.answer && /<think[\s>]/i.test(parts.answer)) {
    const m = parts.answer.match(/<think[^>]*>([\s\S]*?)<\/think>/i);
    if (m) {
      if (!parts.thinking) parts.thinking = m[1];
      parts.answer = parts.answer.replace(m[0], '');
    }
  }

  parts.question = cleanContent(parts.question);
  parts.thinking = cleanContent(parts.thinking);
  parts.answer = cleanContent(parts.answer);
  return parts;
}

/**
 * 记录最近一次接口响应的结构（供设置页诊断展示）。
 * 站点结构变化时，这是唯一能远程看清"字段到底叫什么"的手段。
 */
export const lastApiShape = {
  at: '',
  sessionId: '',
  messageCount: 0,
  branchLength: 0,
  firstMessageKeys: [],
  firstMessageFragmentTypes: [],
  firstMessageHasContent: false,
  sampleTurnLens: null,
  unknownShape: false
};

/** 头像/图标一类的装饰图，不要当作对话图片 */
const IMAGE_URL_EXCLUDE = /avatar|icon|favicon|logo|site-icon|emoji|sprite|badge/i;

/** 从 markdown 文本里抽出图片链接 */
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
 * 一个引用是否"像图片"。
 * 判据故意放宽：类名含 image、文件名/路径带图片扩展名、或带 DeepSeek 的 ty=p 图片参数。
 */
function looksLikeImageRef(name, type, path) {
  const t = String(type || '').toLowerCase();
  if (t.includes('image')) return true;
  const n = String(name || '');
  const p = String(path || '');
  if (/\.(png|jpe?g|webp|gif|bmp|avif|heic)(\?|#|$)/i.test(n)) return true;
  if (/\.(png|jpe?g|webp|gif|bmp|avif|heic)(\?|#|$)/i.test(p)) return true;
  return false;
}

/**
 * 深度扫描一条消息里所有图片引用。
 *
 * 为什么要深扫而不是只读 files[]：站点已经有过一次"字段静默搬家"（正文从 content
 * 挪进 fragments），图片同样可能被挪进 fragments、或再包一层 { image: {...} }、
 * 或改名成 image_list / images / file_infos。写死字段名一定会漏。
 *
 * @param {object} msg
 * @param {string} slot
 * @param {{maxDepth?:number}} [opts]
 * @returns {Array} ImageAsset[]
 */
export function collectImageAssetsFromMessage(msg, slot, opts = {}) {
  const found = [];
  const seenUrls = new Set();
  const seenObj = new Set();
  const maxDepth = opts.maxDepth || 6;

  const push = (url, name, type) => {
    if (!url || seenUrls.has(url)) return;
    if (IMAGE_URL_EXCLUDE.test(url)) return;
    seenUrls.add(url);
    const nm = String(name || '');
    const tp = String(type || '').toLowerCase();
    found.push(createImage({
      src: url,
      alt: nm || '图片',
      basename: nm ? nm.replace(/\.[^.]+$/, '') : '',
      mime: tp.startsWith('image/') ? tp : guessMime(nm || url),
      slot
    }));
  };

  const visit = (node, depth) => {
    if (!node || depth > maxDepth) return;
    if (Array.isArray(node)) {
      node.forEach(v => visit(v, depth + 1));
      return;
    }
    if (typeof node !== 'object') return;
    if (seenObj.has(node)) return;
    seenObj.add(node);

    const name = node.file_name || node.filename || node.name || node.original_name || node.alt || node.title || '';
    const type = node.file_type || node.mime_type || node.mime || node.media_type || node.content_type || node.fileType || '';
    const path = node.signed_path || node.signed_url || node.path || node.url || node.download_url
      || node.src || node.thumbnail_url || node.thumb_url || node.image_url || node.href || '';

    if (path && looksLikeImageRef(name, type, path)) {
      push(buildFileUrl(node) || String(path), name, type);
    }

    for (const [k, v] of Object.entries(node)) {
      if (v && typeof v === 'object') visit(v, depth + 1);
    }
  };

  visit(msg, 0);
  return found;
}

/**
 * 诊断用：把一条消息里"与图片有关的结构"描述出来（不含对话正文）。
 * 线上排查时靠它看清图片到底藏在哪个字段。
 */
export function describeImageShape(msg) {
  const info = { foundUrls: [], nestedArrays: [], keysWithUrl: [] };
  if (!msg || typeof msg !== 'object') return info;
  const seenObj = new Set();
  const visit = (node, path, depth) => {
    if (!node || depth > 5) return;
    if (Array.isArray(node)) {
      info.nestedArrays.push(`${path}[${node.length}]`);
      node.slice(0, 3).forEach((v, i) => visit(v, `${path}[${i}]`, depth + 1));
      return;
    }
    if (typeof node !== 'object' || seenObj.has(node)) return;
    seenObj.add(node);
    for (const [k, v] of Object.entries(node)) {
      if (typeof v === 'string' && /^https?:\/\//.test(v)) info.keysWithUrl.push(`${path}.${k}`);
      if (v && typeof v === 'object') visit(v, `${path}.${k}`, depth + 1);
    }
  };
  visit(msg, 'msg', 0);
  try {
    info.foundUrls = collectImageAssetsFromMessage(msg, 'question', { maxDepth: 6 })
      .map(a => a.src)
      .slice(0, 5);
  } catch (e) {
    info.error = String(e && e.message || e);
  }
  info.nestedArrays = info.nestedArrays.slice(0, 20);
  info.keysWithUrl = info.keysWithUrl.slice(0, 25);
  return info;
}

/** 按线上 bundle 的规则拼图片地址：https://files.deepseeksvc.com/api<signed_path>?ty=p */
function buildFileUrl(f) {
  if (f.url) return f.url;
  if (f.download_url) return f.download_url;
  const signed = f.signed_path || f.signed_url || f.path;
  if (!signed) return '';
  if (/^https?:\/\//.test(signed)) return signed;
  const base = f.base_url || 'https://files.deepseeksvc.com';
  const q = new URLSearchParams();
  q.set('ty', f.ty || 'p');
  if (f.fmt) q.set('fmt', f.fmt);
  return `${base}/api${signed}${signed.includes('?') ? '&' : '?'}${q.toString()}`;
}

function guessMime(name) {
  const m = String(name).match(/\.(png|jpe?g|webp|gif|bmp|avif)$/i);
  if (!m) return '';
  const ext = m[1].toLowerCase();
  return ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
}

/** 相邻同角色消息合并（思考与回答可能被拆成两条 ASSISTANT 记录） */
function mergeAdjacent(turns) {
  const out = [];
  for (const t of turns) {
    const last = out[out.length - 1];
    if (last && last.role === t.role) {
      if (t.role === ROLE.USER) {
        if (t.question) last.question = [last.question, t.question].filter(Boolean).join('\n\n');
      } else {
        if (t.thinking) last.thinking = [last.thinking, t.thinking].filter(Boolean).join('\n\n');
        if (t.answer) last.answer = [last.answer, t.answer].filter(Boolean).join('\n\n');
      }
      last.images = last.images.concat(t.images.filter(x => !last.images.some(y => y.src === x.src)));
      continue;
    }
    out.push(t);
  }
  return out;
}

/**
 * 接口数据 → 统一 Turn 模型。
 * @param {object} data fetchConversation 的返回值
 * @returns {Array} Turn[]
 */
export function apiToTurns(data) {
  const branch = currentBranch(data);
  const raw = [];

  // 记录结构特征：站点改版时靠这个远程定位字段
  try {
    const first = branch[0] || (data && data.chat_messages && data.chat_messages[0]) || null;
    lastApiShape.at = new Date().toISOString();
    lastApiShape.messageCount = ((data && data.chat_messages) || []).length;
    lastApiShape.branchLength = branch.length;
    lastApiShape.firstMessageKeys = first ? Object.keys(first).slice(0, 30) : [];
    const frags = first && (Array.isArray(first.fragments) ? first.fragments : []);
    lastApiShape.firstMessageFragmentTypes = frags.slice(0, 12).map(f => String((f && (f.type || f.fragment_type || f.kind)) || '?'));
    lastApiShape.firstMessageHasContent = !!(first && first.content);
  } catch (e) { /* 诊断信息不影响主流程 */ }

  for (const msg of branch) {
    const role = String(msg.role || '').toUpperCase() === 'USER' ? ROLE.USER : ROLE.ASSISTANT;
    const turn = createTurn({
      index: raw.length,
      role,
      id: `dsapi-${msg.message_id || raw.length}`,
      time: msg.inserted_at ? new Date(msg.inserted_at * 1000).toISOString() : ''
    });

    const parts = extractMessageParts(msg);
    if (role === ROLE.USER) {
      // 用户消息：正文可能是 REQUEST 片段，也可能落在 content 上
      turn.question = parts.question || parts.answer;
      turn.images = collectImageAssetsFromMessage(msg, SLOTS.QUESTION);
    } else {
      turn.thinking = parts.thinking;
      turn.answer = parts.answer || parts.question;
      turn.images = collectImageAssetsFromMessage(msg, SLOTS.ANSWER);
    }
    raw.push(turn);
  }

  const merged = mergeAdjacent(raw);
  merged.forEach((t, i) => { t.index = i; });

  // 结构完全不认识时标记出来：上层会因此回退到 DOM 抓取，而不是给用户一个空白面板
  const hasAnyText = merged.some(t => (t.question || t.thinking || t.answer || '').trim().length > 0);
  lastApiShape.unknownShape = merged.length > 0 && !hasAnyText;
  lastApiShape.sampleTurnLens = merged.slice(0, 3).map(t => ({
    role: t.role,
    q: (t.question || '').length,
    think: (t.thinking || '').length,
    a: (t.answer || '').length
  }));

  return merged;
}

/** 一步到位：拉取并转换 */
export async function fetchTurns(sessionId) {
  const data = await fetchConversation(sessionId);
  const turns = apiToTurns(data);
  return {
    turns,
    title: (data.chat_session && data.chat_session.title) || '',
    shape: { ...lastApiShape, sessionId }
  };
}

/** 这批 turn 里是否真的取到了文字（用于判断接口结构是否还能解析） */
export function turnsHaveText(turns) {
  return (turns || []).some(t => ((t.question || '') + (t.thinking || '') + (t.answer || '')).trim().length > 0);
}
