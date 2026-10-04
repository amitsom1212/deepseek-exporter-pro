/**
 * AI 内容归类
 *
 * 用途：导出时把会话判断为「是否知识答疑」并归入某个科目（如 数学 / 408/数据结构），
 * 从而按分类归档到不同文件夹。
 *
 * 设计约束：
 * - 走 **OpenAI 兼容** 的 /chat/completions，不绑定某一家：
 *   DeepSeek 官方、OpenAI、以及本地 Ollama / LM Studio 都能用。
 * - 本文件是**纯逻辑**（解析、提示词、路径计算、缓存键），
 *   真正的网络请求由后台 Service Worker 发起（扩展有 host 权限，不受页面 CORS 限制），
 *   这样 API Key 也不必经过内容脚本。
 * - 解析必须极度宽容：模型可能返回 ```json 包裹、带解释文字、true/"true"/"是" 混用，
 *   任何一种都不该让导出失败。
 *
 * @file src/core/aiClassify.js
 */

import { safeName } from './filename.js';

/* ------------------------------------------------------------------ */
/*                          预设与规范化                                */
/* ------------------------------------------------------------------ */

export const AI_PRESETS = [
  { id: 'deepseek', label: 'DeepSeek 官方', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  { id: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  { id: 'ollama', label: '本地 Ollama（隐私最好）', baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen2.5:7b' },
  { id: 'lmstudio', label: '本地 LM Studio', baseUrl: 'http://127.0.0.1:1234/v1', model: 'local-model' }
];

/** 补全 baseUrl：允许用户只填域名，也允许直接填完整 endpoint */
export function normalizeBaseUrl(input) {
  let s = String(input || '').trim().replace(/\/+$/, '');
  if (!s) return '';
  if (/\/chat\/completions$/i.test(s)) return s.replace(/\/chat\/completions$/i, '');
  if (!/\/v\d+$/i.test(s)) s += '/v1';
  return s;
}

export function completionsEndpoint(baseUrl) {
  const base = normalizeBaseUrl(baseUrl);
  return base ? `${base}/chat/completions` : '';
}

/** 取该接口的 origin 匹配模式，用于向用户申请 host 权限 */
export function originPattern(baseUrl) {
  try {
    const u = new URL(normalizeBaseUrl(baseUrl) || 'https://api.deepseek.com/v1');
    return `${u.protocol}//${u.hostname}${u.port ? ':' + u.port : ''}/*`;
  } catch (e) {
    return '';
  }
}

/** 科目清单：'408/数据结构' → {parent:'408', leaf:'数据结构', full:'408/数据结构'} */
export function parseSubjects(list) {
  const out = [];
  const seen = new Set();
  for (const raw of list || []) {
    const s = String(raw || '').trim().replace(/\\/g, '/');
    if (!s) continue;
    const parts = s.split('/').map(x => x.trim()).filter(Boolean);
    if (!parts.length) continue;
    const key = parts.join('/');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      full: key,
      parent: parts.length > 1 ? parts[0] : '',
      leaf: parts[parts.length - 1]
    });
  }
  return out;
}

/** 科目树（父 → 子），用于提示词与设置页预览 */
export function subjectTree(list) {
  const tree = new Map();
  for (const s of parseSubjects(list)) {
    if (!tree.has(s.parent || s.full)) tree.set(s.parent || s.full, new Set());
    if (s.parent) tree.get(s.parent).add(s.leaf);
  }
  const out = [];
  for (const [parent, leaves] of tree) {
    out.push({ parent, leaves: [...leaves] });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/*                            提示词                                    */
/* ------------------------------------------------------------------ */

/**
 * 构造分类提示词。
 * @param {{title?:string, text?:string, subjects?:string[]}} input
 */
export function buildClassifyMessages(input = {}) {
  const subjects = parseSubjects(input.subjects);
  const listText = subjects.length
    ? subjects.map(s => (s.parent ? `- ${s.parent} > ${s.leaf}` : `- ${s.full}`)).join('\n')
    : '- （未配置科目）';

  const system = [
    '你是一个学习资料归档助手。请阅读会话标题与开头内容，判断它属于什么类型的对话，并只输出一个 JSON 对象。',
    '',
    '输出格式（严格 JSON，不要任何额外文字、不要代码块围栏）：',
    '{"knowledge": true, "subject": "科目名", "sub": "子科目名或空字符串", "reason": "不超过 20 字的理由"}',
    '',
    '判断规则：',
    '1. knowledge=true：知识性问答、学习答疑、解题、概念讲解、知识点整理、复习总结。',
    '2. knowledge=false：闲聊、情感交流、工具/软件操作、写代码工程、日程安排、无关内容。',
    '3. subject 必须从下面的科目清单中选择，不要自创名称：',
    listText,
    '4. 若都不匹配，subject 填 "未分类"，sub 填空字符串。',
    '5. 如果命中的科目带子科目（清单里写成 "父 > 子"），subject 填父，sub 填子。',
    '6. reason 用一个短句说明依据。'
  ].join('\n');

  const head = String(input.title || '').trim() || '(无标题)';
  const body = String(input.text || '').trim().slice(0, 4000);
  const user = `会话标题：${head}\n\n会话开头内容：\n${body || '(空)'}`;

  return [
    { role: 'system', content: system },
    { role: 'user', content: user }
  ];
}

/* ------------------------------------------------------------------ */
/*                          响应解析                                    */
/* ------------------------------------------------------------------ */

/** 去掉代码块围栏与前后噪声，取出第一个完整的 JSON 对象文本 */
export function extractJsonText(raw) {
  let s = String(raw == null ? '' : raw).trim();
  if (!s) return '';
  // ```json ... ``` / ``` ... ```
  const fence = s.match(/```(?:json|JSON)?\s*([\s\S]*?)```/);
  if (fence && fence[1]) s = fence[1].trim();
  // 第一个 { 到最后一个 }
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a >= 0 && b > a) return s.slice(a, b + 1);
  return s;
}

/** 宽松 JSON.parse：兼容单引号、尾逗号、中文引号 */
export function looseJsonParse(text) {
  const s = extractJsonText(text);
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch (e) { /* 继续尝试修复 */ }
  const repaired = s
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/,\s*([}\]])/g, '$1')
    .replace(/([{,]\s*)'([^']*)'(\s*:)/g, '$1"$2"$3')
    .replace(/:\s*'([^']*)'/g, ': "$1"');
  try {
    return JSON.parse(repaired);
  } catch (e) {
    return null;
  }
}

/** 布尔归一：true / "true" / "是" / "yes" / 1 都算真 */
export function toBool(v) {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  const s = String(v == null ? '' : v).trim().toLowerCase();
  if (['true', 'yes', 'y', '1', '是', '对', '知识', '知识答疑'].includes(s)) return true;
  if (['false', 'no', 'n', '0', '否', '不是', '非知识', '闲聊'].includes(s)) return false;
  return null;
}

/** 从文本里猜是否知识答疑（模型没给结构化结果时的兜底） */
function guessKnowledge(text) {
  const s = String(text || '');
  if (/["']?knowledge["']?\s*[:：]\s*["']?(true|是|yes)/i.test(s)) return true;
  if (/["']?knowledge["']?\s*[:：]\s*["']?(false|否|no)/i.test(s)) return false;
  if (/\btrue\b|知识答疑|属于知识/i.test(s)) return true;
  if (/\bfalse\b|非知识|不是知识|闲聊/i.test(s)) return false;
  return null;
}

/** 科目模糊匹配：全等 → 忽略大小写 → 子串 → 公共字符最多者 */
export function matchSubject(name, list) {
  const subjects = parseSubjects(list);
  const raw = String(name == null ? '' : name).trim();
  if (!raw || !subjects.length) return null;
  const lower = raw.toLowerCase();

  let hit = subjects.find(s => s.full === raw || s.leaf === raw);
  if (hit) return hit;
  hit = subjects.find(s => s.full.toLowerCase() === lower || s.leaf.toLowerCase() === lower);
  if (hit) return hit;
  hit = subjects.find(s => raw.includes(s.leaf) || s.leaf.includes(raw));
  if (hit) return hit;
  hit = subjects.find(s => raw.includes(s.parent) && raw.includes(s.leaf));
  if (hit) return hit;

  // 父科目名：清单里通常只写 "408/数据结构" 这种完整形式，
  // 但模型很可能只回 subject:"408"。必须能匹配上，
  // 否则明明是 408 的题会被丢进「未分类」。
  const parents = [...new Set(subjects.map(s => s.parent).filter(Boolean))];
  const pHit = parents.find(p => p === raw || p.toLowerCase() === lower)
    || parents.find(p => raw.includes(p) || p.includes(raw));
  if (pHit) return { full: pHit, parent: pHit, leaf: '', parentOnly: true };

  // 公共字符数最多者（处理"计算机网路"这类小笔误）
  let best = null;
  let bestScore = 0;
  for (const s of subjects) {
    let score = 0;
    for (const ch of new Set(s.leaf)) if (lower.includes(ch)) score++;
    if (score > bestScore) { bestScore = score; best = s; }
  }
  return bestScore >= 2 ? best : null;
}

/**
 * 解析模型返回的分类结果。
 * @param {string} raw 模型返回的原始文本
 * @param {object} ai 设置里的 ai 配置
 * @returns {{knowledge:boolean, subject:string, sub:string, reason:string, ok:boolean, parsed:boolean}}
 */
export function parseClassifyResponse(raw, ai = {}) {
  const subjects = ai.subjects || [];
  // 注意：subjects 是原始字符串数组，需要 parseSubjects 才能拿到 parent/leaf
  const subjectList = parseSubjects(subjects);
  const fallback = {
    knowledge: true,
    subject: '',
    sub: '',
    reason: '',
    ok: false,
    parsed: false
  };

  const obj = looseJsonParse(raw);
  if (obj && typeof obj === 'object') {
    const k = toBool(obj.knowledge != null ? obj.knowledge
      : obj.is_knowledge != null ? obj.is_knowledge : obj.isKnowledge);
    const subjectRaw = obj.subject != null ? obj.subject : obj.category;
    const subRaw = obj.sub != null ? obj.sub : (obj.subsubject != null ? obj.subsubject : obj.subSubject);
    const matched = matchSubject(subjectRaw, subjects);

    let subject = '';
    let sub = '';
    if (matched && matched.parentOnly) {
      // 模型只给了父科目名（如 408）：用子科目去清单里核对，对不上就只保留父目录
      subject = matched.full;
      const leafText = String(subRaw || '').trim();
      const leaf = leafText
        ? subjectList.find(s => s.parent === matched.full && (s.leaf === leafText || s.leaf.includes(leafText) || leafText.includes(s.leaf)))
        : null;
      sub = leaf ? leaf.leaf : '';
    } else if (matched) {
      subject = matched.parent || matched.full;
      sub = String(subRaw || '').trim() || (matched.parent ? matched.leaf : '');
      if (matched.parent) {
        // 子科目也限定在清单内，避免目录失控
        const leaf = subjectList.find(s => s.parent === matched.parent && (s.leaf === sub || s.leaf.includes(sub) || sub.includes(s.leaf)));
        sub = leaf ? leaf.leaf : matched.leaf;
      }
    }

    return {
      knowledge: k === null ? true : k,
      subject,
      sub,
      reason: String(obj.reason != null ? obj.reason : '').slice(0, 60),
      ok: true,
      parsed: true
    };
  }

  // 完全没有 JSON：退化为关键词判断，至少把"是否知识答疑"定下来
  const k = guessKnowledge(raw);
  if (k !== null) {
    return { ...fallback, knowledge: k, reason: '（模型未返回结构化结果，按关键词判断）', ok: true };
  }
  return { ...fallback, reason: '（无法解析模型输出）' };
}

/* ------------------------------------------------------------------ */
/*                          归档目录计算                                */
/* ------------------------------------------------------------------ */

/**
 * 分类结果 → 归档子目录（相对导出根目录）。
 * @param {{knowledge:boolean, subject:string, sub:string}} result
 * @param {object} ai 设置里的 ai 配置
 * @returns {string} 例如 '408/数据结构' 或 '非知识答疑'，不需要归档时返回 ''
 */
export function categoryFolder(result, ai = {}) {
  if (!ai || ai.routeByCategory === false) return '';
  const r = result || {};
  if (r.knowledge === false) return safeName(ai.nonQaFolder || '非知识答疑', '非知识答疑', 40);
  if (ai.routeMode === 'qa') return safeName('知识答疑', '知识答疑', 40);

  const subject = safeName(r.subject || '', '', 40);
  const sub = safeName(r.sub || '', '', 40);
  const parts = [subject, sub].filter(Boolean);
  if (parts.length === 0) return safeName(ai.fallbackFolder || '未分类', '未分类', 40);
  return parts.join('/');
}

/* ------------------------------------------------------------------ */
/*                            缓存                                      */
/* ------------------------------------------------------------------ */

const CACHE_KEY = 'dsx_classify_cache';

/** 便宜的 32 位字符串哈希（FNV-1a），够做缓存键，不必引 crypto */
export function hashText(str) {
  let h = 0x811c9dc5;
  const s = String(str || '');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16);
}

/**
 * 缓存键：标题 + 正文前缀 + 模型 + 科目清单。
 * 任何一项变化都应该重新判定（换了模型或改了科目，旧结果不该复用）。
 */
export function classifyCacheKey({ title, text, ai }) {
  const sig = [
    String(title || '').slice(0, 120),
    String(text || '').slice(0, Number(ai && ai.maxChars) || 900),
    (ai && ai.model) || '',
    (ai && (ai.subjects || []).join('|')) || '',
    (ai && ai.routeMode) || ''
  ].join('\u0001');
  return hashText(sig);
}

/** 读缓存（返回整张表） */
export async function loadCache() {
  try {
    const raw = await chrome.storage.local.get(CACHE_KEY);
    return (raw && raw[CACHE_KEY]) || {};
  } catch (e) {
    return {};
  }
}

export async function readCache(key) {
  const all = await loadCache();
  return all[key] || null;
}

/** 写缓存并裁剪超量条目（按时间保留最新的 limit 条） */
export async function writeCache(key, value, limit = 500) {
  const all = await loadCache();
  all[key] = value;
  const keys = Object.keys(all);
  if (keys.length > limit) {
    keys
      .sort((a, b) => (all[a].at || 0) - (all[b].at || 0))
      .slice(0, keys.length - limit)
      .forEach(k => { delete all[k]; });
  }
  try {
    await chrome.storage.local.set({ [CACHE_KEY]: all });
  } catch (e) { /* 缓存失败不影响导出 */ }
  return value;
}

export async function clearCache() {
  try {
    await chrome.storage.local.remove(CACHE_KEY);
  } catch (e) { /* 忽略 */ }
}

/* ------------------------------------------------------------------ */
/*                          网络调用                                    */
/* ------------------------------------------------------------------ */

/** 从模型响应里取出正文（兼容 OpenAI / 部分自定义结构） */
export function extractChoiceText(json) {
  try {
    const c = json && json.choices && json.choices[0];
    if (!c) return '';
    if (c.message && typeof c.message.content === 'string') return c.message.content;
    if (typeof c.text === 'string') return c.text;
    if (c.delta && typeof c.delta.content === 'string') return c.delta.content;
    return '';
  } catch (e) {
    return '';
  }
}

/**
 * 调用一次分类接口。
 * @param {object} p
 * @param {{title:string, text:string}} p.content
 * @param {object} p.ai 设置里的 ai 配置
 * @param {Function} [p.fetchImpl] 便于测试注入
 * @returns {Promise<{ok:boolean, result?:object, error?:string, httpStatus?:number, needJsonFallback?:boolean}>}
 */
export async function requestClassification({ content, ai, fetchImpl }) {
  const doFetch = fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
  if (!doFetch) return { ok: false, error: '当前环境不支持 fetch' };

  const endpoint = completionsEndpoint(ai.baseUrl);
  if (!endpoint) return { ok: false, error: '未配置接口地址' };

  const messages = buildClassifyMessages({
    title: content && content.title,
    text: content && content.text,
    subjects: ai.subjects
  });

  const call = async (withJsonMode) => {
    const body = {
      model: ai.model || 'deepseek-chat',
      messages,
      temperature: 0,
      max_tokens: 220,
      stream: false
    };
    if (withJsonMode) body.response_format = { type: 'json_object' };
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ai.timeoutMs || 20000);
    try {
      const resp = await doFetch(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(ai.apiKey ? { authorization: `Bearer ${ai.apiKey}` } : {})
        },
        body: JSON.stringify(body),
        signal: ctrl.signal
      });
      return resp;
    } finally {
      clearTimeout(timer);
    }
  };

  let resp;
  try {
    resp = await call(!!ai.jsonMode);
    // 有些兼容服务不认 response_format，报 400 时退回普通模式再试一次
    if (resp && resp.status === 400 && ai.jsonMode) {
      resp = await call(false);
    }
  } catch (e) {
    const aborted = String(e && e.name) === 'AbortError';
    return { ok: false, error: aborted ? `接口超时（${ai.timeoutMs || 20000}ms）` : `请求失败：${e && e.message}` };
  }

  if (!resp || !resp.ok) {
    let detail = '';
    try {
      detail = (await resp.text()).slice(0, 200);
    } catch (e) { /* 忽略 */ }
    const hint = resp && resp.status === 401 ? 'API Key 可能无效'
      : resp && resp.status === 404 ? '接口地址可能不对（应指向 OpenAI 兼容的 /v1）'
        : resp && resp.status === 403 ? '可能缺少该域名的访问权限（可在设置页授予）'
          : resp && resp.status === 429 ? '触发限流，稍后再试'
            : '';
    return { ok: false, error: `接口返回 HTTP ${resp && resp.status}${hint ? '（' + hint + '）' : ''}${detail ? '：' + detail : ''}`, httpStatus: resp && resp.status };
  }

  let json = null;
  try {
    json = await resp.json();
  } catch (e) {
    return { ok: false, error: '接口返回的不是 JSON' };
  }
  const text = extractChoiceText(json);
  const result = parseClassifyResponse(text, ai);
  if (!result.parsed && !result.ok) {
    return { ok: false, error: `无法解析模型输出：${String(text).slice(0, 120)}` };
  }
  result.source = 'api';
  result.raw = String(text).slice(0, 200);
  return { ok: true, result };
}
