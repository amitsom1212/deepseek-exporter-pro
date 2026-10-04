// src/core/model.js
var SLOTS = ["question", "thinking", "answer", "images"];
function allSlots() {
  return { question: true, thinking: true, answer: true, images: true };
}
function normalizeSlots(sel) {
  const out = {};
  for (const s of SLOTS) out[s] = !!(sel && sel[s]);
  return out;
}

// src/core/settings.js
var DEFAULT_SUBFOLDER_PATTERN = "{date}_{title}";
var DEFAULT_SETTINGS = {
  /* ---------- 路径 ---------- */
  /** 单独导出：默认文件夹（浏览器下载目录下的相对路径） */
  singleFolder: "DeepSeek\u5BFC\u51FA/\u5355\u6761",
  /** 批量导出：默认文件夹（浏览器下载目录下的相对路径） */
  batchFolder: "DeepSeek\u5BFC\u51FA/\u6279\u91CF",
  /** 批量导出时在目标目录下为每个会话新建子文件夹 */
  batchSubfolder: true,
  /** 子文件夹命名模板 */
  batchSubfolderPattern: DEFAULT_SUBFOLDER_PATTERN,
  /** 批量导出是否生成总索引文件 */
  batchIndex: true,
  /**
   * 已授权真实文件夹**内部**的子目录（相对授权目录，默认空 = 直接放在授权目录根下）。
   * 它与 singleFolder / batchFolder 是两套独立前缀：后者只用于「写进下载目录」，
   * 前者只用于「写进已授权文件夹」，二者不再互相叠加
   * （历史 bug：授权目录 + 下载目录相对路径 → 出现重复嵌套目录）。
   */
  dirSubfolder: "",
  /* ---------- 默认输出内容 ---------- */
  /** 批量导出默认勾选的内容项 */
  batchSlots: allSlots(),
  /** 单独导出默认勾选的内容项 */
  singleSlots: allSlots(),
  /** 默认导出格式：md | docx | txt | json */
  defaultFormat: "md",
  /** 导出格式多选（批量导出时可同时导出多种） */
  batchFormats: ["md"],
  /* ---------- 图片 ---------- */
  /** 图片输出格式：png | jpeg | webp | original */
  imageFormat: "png",
  /** jpeg 质量 0.5~1 */
  imageQuality: 0.92,
  /** 图片存放目录（相对导出目录） */
  imageFolder: "images",
  /** true = 图片以 base64 内联进 md（单文件自包含）；false = 写到 imageFolder 子目录 */
  imageInline: false,
  /** docx 内嵌图片最大宽度（px） */
  docxImageMaxWidth: 620,
  /* ---------- 其它 ---------- */
  /**
   * 优先走站点内部接口取数据（DeepSeek）。
   * 接口能拿到原始 markdown（公式保留 LaTeX 源码）与正确的分支结构，
   * 批量导出也不需要逐个点开会话；失败会自动回退到页面 DOM 抓取。
   */
  useApi: true,
  /** 用户已在设置页授权真实文件夹（File System Access），批量导出优先写入它 */
  useDirectoryHandle: true,
  /** 展开选择：按站点记住上次的勾选 */
  perSiteSlots: {},
  /** 面板默认展开的标签页 */
  lastTab: "current",
  /** 调试日志 */
  verbose: false,
  /* ---------- AI 归类归档 ---------- */
  /**
   * 开启后，导出前会把「会话标题 + 开头一段正文」发送到用户配置的
   * OpenAI 兼容接口，判断是否属于知识答疑、属于哪个科目，
   * 据此把文件归档到不同文件夹。默认关闭（涉及把内容发到外部接口）。
   */
  ai: {
    enabled: false,
    /** OpenAI 兼容接口基址（会自动补 /v1） */
    baseUrl: "https://api.deepseek.com/v1",
    apiKey: "",
    model: "deepseek-chat",
    timeoutMs: 2e4,
    /** 送给模型的正文字数上限（越大越准，也越贵） */
    maxChars: 900,
    /** 是否请求 JSON 输出模式（部分兼容服务不支持，会自动重试一次） */
    jsonMode: true,
    /** 按分类归档目录 */
    routeByCategory: true,
    /** 归档维度：'subject' = 按学科；'qa' = 只分是否知识答疑 */
    routeMode: "subject",
    /** 非知识答疑的归档目录名 */
    nonQaFolder: "\u975E\u77E5\u8BC6\u7B54\u7591",
    /** 无法判定科目时的兜底目录名 */
    fallbackFolder: "\u672A\u5206\u7C7B",
    /** 科目清单，用 / 表示层级，例如 408/数据结构 */
    subjects: [
      "\u6570\u5B66",
      "\u82F1\u8BED",
      "\u653F\u6CBB",
      "408/\u6570\u636E\u7ED3\u6784",
      "408/\u8BA1\u7B97\u673A\u7F51\u7EDC",
      "408/\u8BA1\u7B97\u673A\u7EC4\u6210\u539F\u7406",
      "408/\u64CD\u4F5C\u7CFB\u7EDF"
    ],
    /** 归档时是否仍保留「每个会话一个子文件夹」 */
    keepSessionSubfolder: true,
    /** 分类结果缓存条数上限 */
    cacheLimit: 500
  }
};
var KEY = "dsx_settings";
var cache = null;
function merge(base, patch) {
  const out = { ...base };
  for (const [k, v] of Object.entries(patch || {})) {
    if (v && typeof v === "object" && !Array.isArray(v) && base[k] && typeof base[k] === "object" && !Array.isArray(base[k])) {
      out[k] = merge(base[k], v);
    } else if (v !== void 0) {
      out[k] = v;
    }
  }
  return out;
}
async function getSettings(force = false) {
  if (cache && !force) return cache;
  try {
    const raw = await chrome.storage.local.get(KEY);
    cache = merge(DEFAULT_SETTINGS, raw && raw[KEY]);
  } catch (e) {
    cache = { ...DEFAULT_SETTINGS };
  }
  cache.batchSlots = normalizeSlots(cache.batchSlots);
  cache.singleSlots = normalizeSlots(cache.singleSlots);
  if (!Array.isArray(cache.batchFormats) || cache.batchFormats.length === 0) cache.batchFormats = ["md"];
  return cache;
}

// src/core/dirHandle.js
var DB_NAME = "dsx-pro";
var STORE = "handles";
var KEY2 = "exportDir";
function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error("\u65E0\u6CD5\u6253\u5F00 IndexedDB"));
  });
}
function tx(db, mode) {
  return db.transaction(STORE, mode).objectStore(STORE);
}
async function loadDirHandle() {
  try {
    const db = await openDb();
    const handle = await new Promise((resolve, reject) => {
      const req = tx(db, "readonly").get(KEY2);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
    db.close();
    return handle || null;
  } catch (e) {
    return null;
  }
}

// src/core/aiClassify.js
function normalizeBaseUrl(input) {
  let s = String(input || "").trim().replace(/\/+$/, "");
  if (!s) return "";
  if (/\/chat\/completions$/i.test(s)) return s.replace(/\/chat\/completions$/i, "");
  if (!/\/v\d+$/i.test(s)) s += "/v1";
  return s;
}
function completionsEndpoint(baseUrl) {
  const base = normalizeBaseUrl(baseUrl);
  return base ? `${base}/chat/completions` : "";
}
function originPattern(baseUrl) {
  try {
    const u = new URL(normalizeBaseUrl(baseUrl) || "https://api.deepseek.com/v1");
    return `${u.protocol}//${u.hostname}${u.port ? ":" + u.port : ""}/*`;
  } catch (e) {
    return "";
  }
}
function parseSubjects(list) {
  const out = [];
  const seen = /* @__PURE__ */ new Set();
  for (const raw of list || []) {
    const s = String(raw || "").trim().replace(/\\/g, "/");
    if (!s) continue;
    const parts = s.split("/").map((x) => x.trim()).filter(Boolean);
    if (!parts.length) continue;
    const key = parts.join("/");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      full: key,
      parent: parts.length > 1 ? parts[0] : "",
      leaf: parts[parts.length - 1]
    });
  }
  return out;
}
function buildClassifyMessages(input = {}) {
  const subjects = parseSubjects(input.subjects);
  const listText = subjects.length ? subjects.map((s) => s.parent ? `- ${s.parent} > ${s.leaf}` : `- ${s.full}`).join("\n") : "- \uFF08\u672A\u914D\u7F6E\u79D1\u76EE\uFF09";
  const system = [
    "\u4F60\u662F\u4E00\u4E2A\u5B66\u4E60\u8D44\u6599\u5F52\u6863\u52A9\u624B\u3002\u8BF7\u9605\u8BFB\u4F1A\u8BDD\u6807\u9898\u4E0E\u5F00\u5934\u5185\u5BB9\uFF0C\u5224\u65AD\u5B83\u5C5E\u4E8E\u4EC0\u4E48\u7C7B\u578B\u7684\u5BF9\u8BDD\uFF0C\u5E76\u53EA\u8F93\u51FA\u4E00\u4E2A JSON \u5BF9\u8C61\u3002",
    "",
    "\u8F93\u51FA\u683C\u5F0F\uFF08\u4E25\u683C JSON\uFF0C\u4E0D\u8981\u4EFB\u4F55\u989D\u5916\u6587\u5B57\u3001\u4E0D\u8981\u4EE3\u7801\u5757\u56F4\u680F\uFF09\uFF1A",
    '{"knowledge": true, "subject": "\u79D1\u76EE\u540D", "sub": "\u5B50\u79D1\u76EE\u540D\u6216\u7A7A\u5B57\u7B26\u4E32", "reason": "\u4E0D\u8D85\u8FC7 20 \u5B57\u7684\u7406\u7531"}',
    "",
    "\u5224\u65AD\u89C4\u5219\uFF1A",
    "1. knowledge=true\uFF1A\u77E5\u8BC6\u6027\u95EE\u7B54\u3001\u5B66\u4E60\u7B54\u7591\u3001\u89E3\u9898\u3001\u6982\u5FF5\u8BB2\u89E3\u3001\u77E5\u8BC6\u70B9\u6574\u7406\u3001\u590D\u4E60\u603B\u7ED3\u3002",
    "2. knowledge=false\uFF1A\u95F2\u804A\u3001\u60C5\u611F\u4EA4\u6D41\u3001\u5DE5\u5177/\u8F6F\u4EF6\u64CD\u4F5C\u3001\u5199\u4EE3\u7801\u5DE5\u7A0B\u3001\u65E5\u7A0B\u5B89\u6392\u3001\u65E0\u5173\u5185\u5BB9\u3002",
    "3. subject \u5FC5\u987B\u4ECE\u4E0B\u9762\u7684\u79D1\u76EE\u6E05\u5355\u4E2D\u9009\u62E9\uFF0C\u4E0D\u8981\u81EA\u521B\u540D\u79F0\uFF1A",
    listText,
    '4. \u82E5\u90FD\u4E0D\u5339\u914D\uFF0Csubject \u586B "\u672A\u5206\u7C7B"\uFF0Csub \u586B\u7A7A\u5B57\u7B26\u4E32\u3002',
    '5. \u5982\u679C\u547D\u4E2D\u7684\u79D1\u76EE\u5E26\u5B50\u79D1\u76EE\uFF08\u6E05\u5355\u91CC\u5199\u6210 "\u7236 > \u5B50"\uFF09\uFF0Csubject \u586B\u7236\uFF0Csub \u586B\u5B50\u3002',
    "6. reason \u7528\u4E00\u4E2A\u77ED\u53E5\u8BF4\u660E\u4F9D\u636E\u3002"
  ].join("\n");
  const head = String(input.title || "").trim() || "(\u65E0\u6807\u9898)";
  const body = String(input.text || "").trim().slice(0, 4e3);
  const user = `\u4F1A\u8BDD\u6807\u9898\uFF1A${head}

\u4F1A\u8BDD\u5F00\u5934\u5185\u5BB9\uFF1A
${body || "(\u7A7A)"}`;
  return [
    { role: "system", content: system },
    { role: "user", content: user }
  ];
}
function extractJsonText(raw) {
  let s = String(raw == null ? "" : raw).trim();
  if (!s) return "";
  const fence = s.match(/```(?:json|JSON)?\s*([\s\S]*?)```/);
  if (fence && fence[1]) s = fence[1].trim();
  const a = s.indexOf("{");
  const b = s.lastIndexOf("}");
  if (a >= 0 && b > a) return s.slice(a, b + 1);
  return s;
}
function looseJsonParse(text) {
  const s = extractJsonText(text);
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch (e) {
  }
  const repaired = s.replace(/[\u201c\u201d]/g, '"').replace(/[\u2018\u2019]/g, "'").replace(/,\s*([}\]])/g, "$1").replace(/([{,]\s*)'([^']*)'(\s*:)/g, '$1"$2"$3').replace(/:\s*'([^']*)'/g, ': "$1"');
  try {
    return JSON.parse(repaired);
  } catch (e) {
    return null;
  }
}
function toBool(v) {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  const s = String(v == null ? "" : v).trim().toLowerCase();
  if (["true", "yes", "y", "1", "\u662F", "\u5BF9", "\u77E5\u8BC6", "\u77E5\u8BC6\u7B54\u7591"].includes(s)) return true;
  if (["false", "no", "n", "0", "\u5426", "\u4E0D\u662F", "\u975E\u77E5\u8BC6", "\u95F2\u804A"].includes(s)) return false;
  return null;
}
function guessKnowledge(text) {
  const s = String(text || "");
  if (/["']?knowledge["']?\s*[:：]\s*["']?(true|是|yes)/i.test(s)) return true;
  if (/["']?knowledge["']?\s*[:：]\s*["']?(false|否|no)/i.test(s)) return false;
  if (/\btrue\b|知识答疑|属于知识/i.test(s)) return true;
  if (/\bfalse\b|非知识|不是知识|闲聊/i.test(s)) return false;
  return null;
}
function matchSubject(name, list) {
  const subjects = parseSubjects(list);
  const raw = String(name == null ? "" : name).trim();
  if (!raw || !subjects.length) return null;
  const lower = raw.toLowerCase();
  let hit = subjects.find((s) => s.full === raw || s.leaf === raw);
  if (hit) return hit;
  hit = subjects.find((s) => s.full.toLowerCase() === lower || s.leaf.toLowerCase() === lower);
  if (hit) return hit;
  hit = subjects.find((s) => raw.includes(s.leaf) || s.leaf.includes(raw));
  if (hit) return hit;
  hit = subjects.find((s) => raw.includes(s.parent) && raw.includes(s.leaf));
  if (hit) return hit;
  const parents = [...new Set(subjects.map((s) => s.parent).filter(Boolean))];
  const pHit = parents.find((p) => p === raw || p.toLowerCase() === lower) || parents.find((p) => raw.includes(p) || p.includes(raw));
  if (pHit) return { full: pHit, parent: pHit, leaf: "", parentOnly: true };
  let best = null;
  let bestScore = 0;
  for (const s of subjects) {
    let score = 0;
    for (const ch of new Set(s.leaf)) if (lower.includes(ch)) score++;
    if (score > bestScore) {
      bestScore = score;
      best = s;
    }
  }
  return bestScore >= 2 ? best : null;
}
function parseClassifyResponse(raw, ai = {}) {
  const subjects = ai.subjects || [];
  const subjectList = parseSubjects(subjects);
  const fallback = {
    knowledge: true,
    subject: "",
    sub: "",
    reason: "",
    ok: false,
    parsed: false
  };
  const obj = looseJsonParse(raw);
  if (obj && typeof obj === "object") {
    const k2 = toBool(obj.knowledge != null ? obj.knowledge : obj.is_knowledge != null ? obj.is_knowledge : obj.isKnowledge);
    const subjectRaw = obj.subject != null ? obj.subject : obj.category;
    const subRaw = obj.sub != null ? obj.sub : obj.subsubject != null ? obj.subsubject : obj.subSubject;
    const matched = matchSubject(subjectRaw, subjects);
    let subject = "";
    let sub = "";
    if (matched && matched.parentOnly) {
      subject = matched.full;
      const leafText = String(subRaw || "").trim();
      const leaf = leafText ? subjectList.find((s) => s.parent === matched.full && (s.leaf === leafText || s.leaf.includes(leafText) || leafText.includes(s.leaf))) : null;
      sub = leaf ? leaf.leaf : "";
    } else if (matched) {
      subject = matched.parent || matched.full;
      sub = String(subRaw || "").trim() || (matched.parent ? matched.leaf : "");
      if (matched.parent) {
        const leaf = subjectList.find((s) => s.parent === matched.parent && (s.leaf === sub || s.leaf.includes(sub) || sub.includes(s.leaf)));
        sub = leaf ? leaf.leaf : matched.leaf;
      }
    }
    return {
      knowledge: k2 === null ? true : k2,
      subject,
      sub,
      reason: String(obj.reason != null ? obj.reason : "").slice(0, 60),
      ok: true,
      parsed: true
    };
  }
  const k = guessKnowledge(raw);
  if (k !== null) {
    return { ...fallback, knowledge: k, reason: "\uFF08\u6A21\u578B\u672A\u8FD4\u56DE\u7ED3\u6784\u5316\u7ED3\u679C\uFF0C\u6309\u5173\u952E\u8BCD\u5224\u65AD\uFF09", ok: true };
  }
  return { ...fallback, reason: "\uFF08\u65E0\u6CD5\u89E3\u6790\u6A21\u578B\u8F93\u51FA\uFF09" };
}
var CACHE_KEY = "dsx_classify_cache";
function hashText(str) {
  let h = 2166136261;
  const s = String(str || "");
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24)) >>> 0;
  }
  return h.toString(16);
}
function classifyCacheKey({ title, text, ai }) {
  const sig = [
    String(title || "").slice(0, 120),
    String(text || "").slice(0, Number(ai && ai.maxChars) || 900),
    ai && ai.model || "",
    ai && (ai.subjects || []).join("|") || "",
    ai && ai.routeMode || ""
  ].join("");
  return hashText(sig);
}
async function loadCache() {
  try {
    const raw = await chrome.storage.local.get(CACHE_KEY);
    return raw && raw[CACHE_KEY] || {};
  } catch (e) {
    return {};
  }
}
async function readCache(key) {
  const all = await loadCache();
  return all[key] || null;
}
async function writeCache(key, value, limit = 500) {
  const all = await loadCache();
  all[key] = value;
  const keys = Object.keys(all);
  if (keys.length > limit) {
    keys.sort((a, b) => (all[a].at || 0) - (all[b].at || 0)).slice(0, keys.length - limit).forEach((k) => {
      delete all[k];
    });
  }
  try {
    await chrome.storage.local.set({ [CACHE_KEY]: all });
  } catch (e) {
  }
  return value;
}
async function clearCache() {
  try {
    await chrome.storage.local.remove(CACHE_KEY);
  } catch (e) {
  }
}
function extractChoiceText(json) {
  try {
    const c = json && json.choices && json.choices[0];
    if (!c) return "";
    if (c.message && typeof c.message.content === "string") return c.message.content;
    if (typeof c.text === "string") return c.text;
    if (c.delta && typeof c.delta.content === "string") return c.delta.content;
    return "";
  } catch (e) {
    return "";
  }
}
async function requestClassification({ content, ai, fetchImpl }) {
  const doFetch = fetchImpl || (typeof fetch !== "undefined" ? fetch : null);
  if (!doFetch) return { ok: false, error: "\u5F53\u524D\u73AF\u5883\u4E0D\u652F\u6301 fetch" };
  const endpoint = completionsEndpoint(ai.baseUrl);
  if (!endpoint) return { ok: false, error: "\u672A\u914D\u7F6E\u63A5\u53E3\u5730\u5740" };
  const messages = buildClassifyMessages({
    title: content && content.title,
    text: content && content.text,
    subjects: ai.subjects
  });
  const call = async (withJsonMode) => {
    const body = {
      model: ai.model || "deepseek-chat",
      messages,
      temperature: 0,
      max_tokens: 220,
      stream: false
    };
    if (withJsonMode) body.response_format = { type: "json_object" };
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ai.timeoutMs || 2e4);
    try {
      const resp2 = await doFetch(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...ai.apiKey ? { authorization: `Bearer ${ai.apiKey}` } : {}
        },
        body: JSON.stringify(body),
        signal: ctrl.signal
      });
      return resp2;
    } finally {
      clearTimeout(timer);
    }
  };
  let resp;
  try {
    resp = await call(!!ai.jsonMode);
    if (resp && resp.status === 400 && ai.jsonMode) {
      resp = await call(false);
    }
  } catch (e) {
    const aborted = String(e && e.name) === "AbortError";
    return { ok: false, error: aborted ? `\u63A5\u53E3\u8D85\u65F6\uFF08${ai.timeoutMs || 2e4}ms\uFF09` : `\u8BF7\u6C42\u5931\u8D25\uFF1A${e && e.message}` };
  }
  if (!resp || !resp.ok) {
    let detail = "";
    try {
      detail = (await resp.text()).slice(0, 200);
    } catch (e) {
    }
    const hint = resp && resp.status === 401 ? "API Key \u53EF\u80FD\u65E0\u6548" : resp && resp.status === 404 ? "\u63A5\u53E3\u5730\u5740\u53EF\u80FD\u4E0D\u5BF9\uFF08\u5E94\u6307\u5411 OpenAI \u517C\u5BB9\u7684 /v1\uFF09" : resp && resp.status === 403 ? "\u53EF\u80FD\u7F3A\u5C11\u8BE5\u57DF\u540D\u7684\u8BBF\u95EE\u6743\u9650\uFF08\u53EF\u5728\u8BBE\u7F6E\u9875\u6388\u4E88\uFF09" : resp && resp.status === 429 ? "\u89E6\u53D1\u9650\u6D41\uFF0C\u7A0D\u540E\u518D\u8BD5" : "";
    return { ok: false, error: `\u63A5\u53E3\u8FD4\u56DE HTTP ${resp && resp.status}${hint ? "\uFF08" + hint + "\uFF09" : ""}${detail ? "\uFF1A" + detail : ""}`, httpStatus: resp && resp.status };
  }
  let json = null;
  try {
    json = await resp.json();
  } catch (e) {
    return { ok: false, error: "\u63A5\u53E3\u8FD4\u56DE\u7684\u4E0D\u662F JSON" };
  }
  const text = extractChoiceText(json);
  const result = parseClassifyResponse(text, ai);
  if (!result.parsed && !result.ok) {
    return { ok: false, error: `\u65E0\u6CD5\u89E3\u6790\u6A21\u578B\u8F93\u51FA\uFF1A${String(text).slice(0, 120)}` };
  }
  result.source = "api";
  result.raw = String(text).slice(0, 200);
  return { ok: true, result };
}

// src/background/index.js
var OFFSCREEN_PATH = "offscreen/offscreen.html";
var offscreenReady = false;
var creatingOffscreen = null;
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return false;
  if (msg.__to === "offscreen") return false;
  switch (msg.type) {
    case "DSX_PING":
      sendResponse({ ok: true, version: chrome.runtime.getManifest().version });
      return false;
    case "DSX_SAVE_FILES":
      handleSaveFiles(msg).then(sendResponse).catch((err) => sendResponse({ ok: false, error: String(err && err.message || err) }));
      return true;
    case "DSX_FETCH_BINARY":
      handleFetchBinary(msg).then(sendResponse).catch((err) => sendResponse({ ok: false, error: String(err && err.message || err) }));
      return true;
    case "DSX_OPEN_OPTIONS":
      chrome.runtime.openOptionsPage();
      sendResponse({ ok: true });
      return false;
    case "DSX_DIR_STATUS":
      dirStatus().then(sendResponse).catch((err) => sendResponse({ ok: false, error: String(err && err.message || err) }));
      return true;
    case "DSX_WRITE_DIR":
      writeToDirectory(msg).then(sendResponse).catch((err) => sendResponse({ ok: false, error: String(err && err.message || err) }));
      return true;
    case "DSX_DIR_PICK_RESULT":
      chrome.runtime.sendMessage({ type: "DSX_DIR_CHANGED", name: msg.name }).catch(() => {
      });
      sendResponse({ ok: true });
      return false;
    /* ---------------- AI 归类 ---------------- */
    case "DSX_AI_CLASSIFY":
      handleClassify(msg).then(sendResponse).catch((err) => sendResponse({ ok: false, error: String(err && err.message || err) }));
      return true;
    case "DSX_AI_TEST":
      handleAiTest(msg).then(sendResponse).catch((err) => sendResponse({ ok: false, error: String(err && err.message || err) }));
      return true;
    case "DSX_AI_CACHE_CLEAR":
      clearCache().then(() => sendResponse({ ok: true }));
      return true;
    case "DSX_AI_PERMISSION_CHECK":
      checkAiPermission().then(sendResponse);
      return true;
    default:
      return false;
  }
});
async function handleClassify(msg) {
  const settings = await getSettings();
  const ai = settings.ai || {};
  if (!ai.enabled) return { ok: false, error: "AI \u5F52\u7C7B\u672A\u5F00\u542F", disabled: true };
  if (!ai.apiKey && !/127\.0\.0\.1|localhost/.test(String(ai.baseUrl || ""))) {
    return { ok: false, error: "\u672A\u586B\u5199 API Key\uFF08\u672C\u5730\u63A5\u53E3\u53EF\u4E0D\u586B\uFF09", noKey: true };
  }
  const perm = await checkAiPermission(ai);
  if (!perm.ok) return { ok: false, error: "NEED_PERMISSION", origin: perm.origin };
  const content = {
    title: String(msg.title || ""),
    text: String(msg.text || "").slice(0, Number(ai.maxChars) || 900)
  };
  const key = classifyCacheKey({ title: content.title, text: content.text, ai });
  if (msg.useCache !== false) {
    const hit = await readCache(key);
    if (hit && hit.result) {
      return { ok: true, result: { ...hit.result, source: "cache" }, cached: true };
    }
  }
  const resp = await requestClassification({ content, ai });
  if (!resp.ok) return resp;
  await writeCache(key, { result: resp.result, at: Date.now() }, ai.cacheLimit || 500);
  return { ok: true, result: resp.result };
}
async function handleAiTest(msg) {
  const settings = await getSettings();
  const ai = { ...settings.ai || {}, ...msg && msg.config ? msg.config : {} };
  const perm = await checkAiPermission(ai);
  if (!perm.ok) return { ok: false, error: "NEED_PERMISSION", origin: perm.origin };
  const resp = await requestClassification({
    content: {
      title: "\u5B9A\u79EF\u5206\u8BA1\u7B97",
      text: "\u8BF7\u5E2E\u6211\u6C42 \u222B\u2080\xB9 x\xB2 dx \u7684\u503C\uFF0C\u5E76\u8BF4\u660E\u7528\u5230\u7684\u516C\u5F0F\u3002"
    },
    ai
  });
  if (!resp.ok) return resp;
  return { ok: true, result: resp.result, endpoint: ai.baseUrl, model: ai.model };
}
async function checkAiPermission(aiArg) {
  try {
    const ai = aiArg || (await getSettings()).ai || {};
    const origin = originPattern(ai.baseUrl);
    if (!origin) return { ok: false, origin: "", error: "\u63A5\u53E3\u5730\u5740\u65E0\u6548" };
    if (/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])/i.test(origin)) return { ok: true, origin };
    const has = await chrome.permissions.contains({ origins: [origin] });
    return { ok: !!has, origin, error: has ? "" : `\u7F3A\u5C11 ${origin} \u7684\u8BBF\u95EE\u6743\u9650` };
  } catch (e) {
    return { ok: false, origin: "", error: String(e && e.message || e) };
  }
}
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === "install") {
    chrome.runtime.openOptionsPage();
  }
});
async function handleSaveFiles(msg) {
  const files = Array.isArray(msg.files) ? msg.files : [];
  const results = [];
  const conflictAction = msg.conflictAction || "uniquify";
  for (const file of files) {
    try {
      const id = await downloadOne(file.dataUrl, file.path, !!msg.saveAs, conflictAction);
      results.push({ path: file.path, ok: true, downloadId: id });
    } catch (e) {
      results.push({ path: file.path, ok: false, error: String(e && e.message || e) });
    }
    await sleep(60);
  }
  const okCount = results.filter((r) => r.ok).length;
  return { ok: okCount > 0, saved: okCount, total: files.length, results };
}
function downloadOne(dataUrl, filename, saveAs, conflictAction) {
  return new Promise((resolve, reject) => {
    if (!dataUrl) {
      reject(new Error("\u6587\u4EF6\u5185\u5BB9\u4E3A\u7A7A"));
      return;
    }
    chrome.downloads.download(
      {
        url: dataUrl,
        filename: sanitizeDownloadPath(filename),
        saveAs: !!saveAs,
        conflictAction
      },
      (downloadId) => {
        const err = chrome.runtime.lastError;
        if (err) reject(new Error(err.message));
        else resolve(downloadId);
      }
    );
  });
}
function sanitizeDownloadPath(path) {
  const parts = String(path || "export").replace(/\\/g, "/").split("/").filter(Boolean).map((seg) => seg.replace(/[<>:"|?*\x00-\x1f]/g, "_").replace(/^\.+$/, "_").replace(/[. ]+$/, "").slice(0, 120) || "_").filter(Boolean);
  const joined = parts.join("/");
  if (!joined) return "export";
  return joined.length > 220 ? joined.slice(joined.length - 220).replace(/^[^/]*\//, "") : joined;
}
async function handleFetchBinary(msg) {
  const url = msg && msg.url;
  if (!url) return { ok: false, error: "\u7F3A\u5C11 url" };
  try {
    const resp = await fetch(url, { credentials: "include" });
    if (!resp.ok) return { ok: false, error: `HTTP ${resp.status}` };
    const buf = await resp.arrayBuffer();
    const mime = resp.headers.get("content-type") || "application/octet-stream";
    return { ok: true, mime, dataUrl: `data:${mime};base64,${arrayBufferToBase64(buf)}` };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
}
function arrayBufferToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let binary = "";
  const CHUNK = 32768;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}
async function ensureOffscreen() {
  if (offscreenReady) return true;
  if (creatingOffscreen) return creatingOffscreen;
  creatingOffscreen = (async () => {
    try {
      if (chrome.offscreen && chrome.offscreen.hasDocument) {
        const has = await chrome.offscreen.hasDocument();
        if (has) {
          offscreenReady = true;
          return true;
        }
      }
      await chrome.offscreen.createDocument({
        url: OFFSCREEN_PATH,
        reasons: ["BLOBS"],
        justification: "\u628A\u5BFC\u51FA\u6587\u4EF6\u5199\u5165\u7528\u6237\u6388\u6743\u7684\u672C\u5730\u6587\u4EF6\u5939"
      });
      offscreenReady = true;
      return true;
    } catch (e) {
      if (String(e && e.message).includes("single offscreen")) {
        offscreenReady = true;
        return true;
      }
      throw e;
    } finally {
      creatingOffscreen = null;
    }
  })();
  return creatingOffscreen;
}
async function dirStatus() {
  let handle = null;
  try {
    handle = await loadDirHandle();
  } catch (e) {
    handle = null;
  }
  if (!handle) return { ok: true, granted: false, name: "", reason: "\u672A\u6388\u6743\u6587\u4EF6\u5939" };
  await ensureOffscreen();
  return await relayToOffscreen({ type: "DSX_DIR_STATUS" });
}
async function writeToDirectory(msg) {
  await ensureOffscreen();
  return relayToOffscreen({ type: "DSX_WRITE_DIR", files: msg.files, subfolder: msg.subfolder });
}
function relayToOffscreen(payload, timeoutMs = 12e4) {
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        resolve({ ok: false, error: "offscreen \u54CD\u5E94\u8D85\u65F6" });
      }
    }, timeoutMs);
    try {
      chrome.runtime.sendMessage({ ...payload, __to: "offscreen" }, (resp) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: chrome.runtime.lastError.message });
        } else {
          resolve(resp || { ok: false, error: "offscreen \u65E0\u54CD\u5E94" });
        }
      });
    } catch (e) {
      if (!done) {
        done = true;
        clearTimeout(timer);
        resolve({ ok: false, error: String(e && e.message || e) });
      }
    }
  });
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
chrome.runtime.onInstalled.addListener(async () => {
  try {
    const cur = await chrome.storage.local.get("dsx_settings");
    if (!cur || !cur.dsx_settings) {
      await chrome.storage.local.set({ dsx_settings: DEFAULT_SETTINGS });
    }
  } catch (e) {
  }
});
export {
  sanitizeDownloadPath
};
