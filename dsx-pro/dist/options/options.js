// src/core/model.js
var SLOTS = ["question", "thinking", "answer", "images"];
var SLOT_LABELS = {
  question: "\u63D0\u95EE",
  thinking: "\u601D\u8003",
  answer: "\u56DE\u7B54",
  images: "\u56FE\u7247"
};
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
async function saveSettings(patch) {
  const current = await getSettings(true);
  const next = merge(current, patch);
  const plain = JSON.parse(JSON.stringify(next));
  await chrome.storage.local.set({ [KEY]: plain });
  cache = next;
  return next;
}
async function resetSettings() {
  cache = null;
  await chrome.storage.local.remove(KEY);
  return getSettings(true);
}
function normalizeRelPath(input) {
  let p = String(input || "").replace(/\\/g, "/").trim();
  p = p.replace(/^[a-zA-Z]:/, "");
  p = p.replace(/^\/+/, "");
  p = p.replace(/\.\.(\/|$)/g, "");
  p = p.replace(/\/{2,}/g, "/");
  p = p.replace(/[<>:"|?*\x00-\x1f]/g, "_");
  p = p.split("/").filter(Boolean).map((seg) => seg.replace(/[. ]+$/, "")).filter(Boolean).join("/");
  return p;
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
async function saveDirHandle(handle) {
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const req = tx(db, "readwrite").put(handle, KEY2);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
  db.close();
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
async function clearDirHandle() {
  const db = await openDb();
  await new Promise((resolve) => {
    const req = tx(db, "readwrite").delete(KEY2);
    req.onsuccess = () => resolve();
    req.onerror = () => resolve();
  });
  db.close();
}
async function dirPermission(handle, mode = "readwrite") {
  if (!handle || !handle.queryPermission) return "denied";
  try {
    return await handle.queryPermission({ mode });
  } catch (e) {
    return "denied";
  }
}
async function requestDirPermission(handle, mode = "readwrite") {
  if (!handle || !handle.requestPermission) return "denied";
  try {
    return await handle.requestPermission({ mode });
  } catch (e) {
    return "denied";
  }
}
async function pickDirectory() {
  if (typeof window === "undefined" || !window.showDirectoryPicker) {
    throw new Error("\u5F53\u524D\u6D4F\u89C8\u5668\u4E0D\u652F\u6301\u6587\u4EF6\u5939\u6388\u6743\uFF08\u9700\u8981 Chrome / Edge 86+\uFF09");
  }
  const handle = await window.showDirectoryPicker({ mode: "readwrite", id: "dsx-export" });
  await saveDirHandle(handle);
  return handle;
}

// src/core/filename.js
var ILLEGAL = /[<>:"/\\|?*\x00-\x1f]/g;
var RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
function safeName(name, fallback = "\u672A\u547D\u540D", maxLen = 80) {
  let s = String(name == null ? "" : name).replace(ILLEGAL, "_").replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim();
  s = s.replace(/[. ]+$/, "");
  if (s.length > maxLen) s = s.slice(0, maxLen).trim();
  if (!s) s = fallback;
  if (RESERVED.test(s)) s = `_${s}`;
  return s;
}

// src/core/aiClassify.js
var AI_PRESETS = [
  { id: "deepseek", label: "DeepSeek \u5B98\u65B9", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat" },
  { id: "openai", label: "OpenAI", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini" },
  { id: "ollama", label: "\u672C\u5730 Ollama\uFF08\u9690\u79C1\u6700\u597D\uFF09", baseUrl: "http://127.0.0.1:11434/v1", model: "qwen2.5:7b" },
  { id: "lmstudio", label: "\u672C\u5730 LM Studio", baseUrl: "http://127.0.0.1:1234/v1", model: "local-model" }
];
function normalizeBaseUrl(input) {
  let s = String(input || "").trim().replace(/\/+$/, "");
  if (!s) return "";
  if (/\/chat\/completions$/i.test(s)) return s.replace(/\/chat\/completions$/i, "");
  if (!/\/v\d+$/i.test(s)) s += "/v1";
  return s;
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
function categoryFolder(result, ai = {}) {
  if (!ai || ai.routeByCategory === false) return "";
  const r = result || {};
  if (r.knowledge === false) return safeName(ai.nonQaFolder || "\u975E\u77E5\u8BC6\u7B54\u7591", "\u975E\u77E5\u8BC6\u7B54\u7591", 40);
  if (ai.routeMode === "qa") return safeName("\u77E5\u8BC6\u7B54\u7591", "\u77E5\u8BC6\u7B54\u7591", 40);
  const subject = safeName(r.subject || "", "", 40);
  const sub = safeName(r.sub || "", "", 40);
  const parts = [subject, sub].filter(Boolean);
  if (parts.length === 0) return safeName(ai.fallbackFolder || "\u672A\u5206\u7C7B", "\u672A\u5206\u7C7B", 40);
  return parts.join("/");
}

// src/options/options.js
var TICK_SVG = '<svg class="tick" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>';
var FORMAT_LABELS = {
  md: "Markdown (.md)",
  docx: "Word (.docx\uFF0C\u516C\u5F0F\u53EF\u7F16\u8F91)",
  txt: "\u7EAF\u6587\u672C (.txt)",
  json: "JSON (.json)"
};
var IMAGE_FORMATS = [
  { id: "png", label: "PNG\uFF08\u63A8\u8350\uFF0C\u65E0\u635F\uFF09" },
  { id: "jpeg", label: "JPEG\uFF08\u4F53\u79EF\u5C0F\uFF09" },
  { id: "webp", label: "WEBP\uFF08\u4FDD\u6301\u7F51\u9875\u683C\u5F0F\uFF09" },
  { id: "original", label: "\u4FDD\u6301\u539F\u683C\u5F0F\uFF08\u4E0D\u8F6C\u7801\uFF09" }
];
var state = null;
var saveTimer = null;
init().catch((err) => toast(`\u8BBE\u7F6E\u9875\u521D\u59CB\u5316\u5931\u8D25\uFF1A${err.message}`, true));
async function init() {
  state = await getSettings(true);
  fillForm();
  bind();
  refreshDirStatus();
  refreshHostsStatus();
  document.getElementById("version-line").textContent = `\u6269\u5C55\u7248\u672C ${chrome.runtime.getManifest().version} \xB7 \u8BBE\u7F6E\u4FDD\u5B58\u5728\u6D4F\u89C8\u5668\u672C\u5730\uFF08chrome.storage.local\uFF09`;
}
function fillForm() {
  setVal("singleFolder", state.singleFolder);
  setVal("batchFolder", state.batchFolder);
  setChk("batchSubfolder", state.batchSubfolder);
  setVal("batchSubfolderPattern", state.batchSubfolderPattern);
  setChk("batchIndex", state.batchIndex);
  setChk("useDirectoryHandle", state.useDirectoryHandle);
  setVal("dirSubfolder", state.dirSubfolder || "");
  setVal("imageFolder", state.imageFolder);
  setVal("docxImageMaxWidth", state.docxImageMaxWidth);
  setVal("imageQuality", state.imageQuality);
  document.getElementById("quality-value").textContent = Number(state.imageQuality).toFixed(2);
  setChk("verbose", state.verbose);
  setChk("useApi", state.useApi !== false);
  renderChips("singleSlots", SLOTS.map((s) => ({ id: s, label: SLOT_LABELS[s] })), slotsToIds(state.singleSlots), (ids) => {
    state.singleSlots = normalizeSlotsFrom(ids);
  });
  renderChips("batchSlots", SLOTS.map((s) => ({ id: s, label: SLOT_LABELS[s] })), slotsToIds(state.batchSlots), (ids) => {
    state.batchSlots = normalizeSlotsFrom(ids);
    updateDocxHint();
  });
  renderChips(
    "defaultFormat",
    Object.keys(FORMAT_LABELS).map((id) => ({ id, label: FORMAT_LABELS[id] })),
    [state.defaultFormat],
    (ids) => {
      state.defaultFormat = ids[ids.length - 1] || "md";
    },
    true
  );
  renderChips(
    "batchFormats",
    Object.keys(FORMAT_LABELS).map((id) => ({ id, label: FORMAT_LABELS[id] })),
    state.batchFormats || ["md"],
    (ids) => {
      state.batchFormats = ids.length ? ids : ["md"];
      updateDocxHint();
    }
  );
  renderChips("imageFormat", IMAGE_FORMATS, [state.imageFormat], (ids) => {
    state.imageFormat = ids[ids.length - 1] || "png";
    toggleQualityField();
  }, true);
  renderChips("imageMode", [
    { id: "folder", label: "\u5B58\u5230\u5B50\u76EE\u5F55\uFF08\u63A8\u8350\uFF09" },
    { id: "inline", label: "\u5185\u8054\u8FDB Markdown\uFF08\u5355\u6587\u4EF6\u81EA\u5305\u542B\uFF09" }
  ], [state.imageInline ? "inline" : "folder"], (ids) => {
    state.imageInline = (ids[ids.length - 1] || "folder") === "inline";
    toggleImageFolderField();
  }, true);
  toggleSubfolderField();
  toggleQualityField();
  toggleImageFolderField();
  updateDocxHint();
  updateSubfolderPreview();
  updateDirPreview();
  fillAiForm();
}
async function updateDirPreview() {
  const el = document.getElementById("dir-path-preview");
  if (!el) return;
  const useDir = document.getElementById("useDirectoryHandle").checked;
  const dirSub = normalizeRelPath(document.getElementById("dirSubfolder").value);
  const batchFolder = normalizeRelPath(document.getElementById("batchFolder").value) || "(\u4E0B\u8F7D\u76EE\u5F55\u6839)";
  const singleFolder = normalizeRelPath(document.getElementById("singleFolder").value) || "(\u4E0B\u8F7D\u76EE\u5F55\u6839)";
  const rows = [];
  rows.push("<div><b>\u6279\u91CF\u5BFC\u51FA</b> \u2192 " + (useDir ? `\u5DF2\u6388\u6743\u6587\u4EF6\u5939${dirSub ? " / " + escapeHtml(dirSub) : ""} / [\u5206\u7C7B] / [\u4F1A\u8BDD] / \u6587\u4EF6` : `\u4E0B\u8F7D\u76EE\u5F55 / ${escapeHtml(batchFolder)} / [\u5206\u7C7B] / [\u4F1A\u8BDD] / \u6587\u4EF6`) + "</div>");
  rows.push('<div style="margin-top:4px"><b>\u5355\u72EC\u5BFC\u51FA</b> \u2192 ' + (useDir ? `\u5DF2\u6388\u6743\u6587\u4EF6\u5939${dirSub ? " / " + escapeHtml(dirSub) : ""} / \u6587\u4EF6` : `\u4E0B\u8F7D\u76EE\u5F55 / ${escapeHtml(singleFolder)} / \u6587\u4EF6`) + "</div>");
  if (useDir) {
    let handle = null;
    try {
      handle = await loadDirHandle();
    } catch (e) {
    }
    if (!handle) {
      rows.push('<div style="margin-top:6px;color:var(--warn)">\u26A0 \u8FD8\u6CA1\u6709\u6388\u6743\u6587\u4EF6\u5939\uFF1A\u8BF7\u70B9\u300C\u9009\u62E9\u6587\u4EF6\u5939\u5E76\u6388\u6743\u300D\uFF0C\u5426\u5219\u5BFC\u51FA\u4F1A\u56DE\u9000\u5230\u4E0B\u8F7D\u76EE\u5F55\u3002</div>');
    } else {
      const perm = await dirPermission(handle, "readwrite").catch(() => "denied");
      if (perm !== "granted") {
        rows.push(`<div style="margin-top:6px;color:var(--warn)">\u26A0 \u6388\u6743\u6587\u4EF6\u5939\u300C${escapeHtml(handle.name)}\u300D\u6743\u9650\u5DF2\u5931\u6548\uFF0C\u5BFC\u51FA\u4F1A\u56DE\u9000\u5230\u4E0B\u8F7D\u76EE\u5F55\uFF0C\u8BF7\u70B9\u300C\u91CD\u65B0\u6388\u6743\u300D\u3002</div>`);
      } else {
        rows.push(`<div style="margin-top:6px">\u5DF2\u6388\u6743\uFF1A<b>${escapeHtml(handle.name)}</b></div>`);
      }
    }
  }
  el.innerHTML = rows.join("");
}
function fillAiForm() {
  state.ai = { ...DEFAULT_SETTINGS.ai, ...state.ai || {} };
  const ai = state.ai;
  setChk("aiEnabled", ai.enabled);
  setVal("aiBaseUrl", ai.baseUrl);
  setVal("aiApiKey", ai.apiKey);
  setVal("aiModel", ai.model);
  setVal("aiNonQaFolder", ai.nonQaFolder);
  setVal("aiFallbackFolder", ai.fallbackFolder);
  setVal("aiMaxChars", ai.maxChars);
  setChk("aiRouteByCategory", ai.routeByCategory !== false);
  setChk("aiKeepSessionSubfolder", ai.keepSessionSubfolder !== false);
  document.getElementById("aiSubjects").value = (ai.subjects || []).join("\n");
  const cur = normalizeBaseUrl(ai.baseUrl);
  renderChips(
    "aiPreset",
    AI_PRESETS.map((p) => ({ id: p.id, label: p.label })),
    AI_PRESETS.filter((p) => normalizeBaseUrl(p.baseUrl) === cur).map((p) => p.id),
    (ids) => {
      const hit = AI_PRESETS.find((p) => p.id === ids[ids.length - 1]);
      if (!hit) return;
      state.ai.baseUrl = hit.baseUrl;
      state.ai.model = hit.model;
      setVal("aiBaseUrl", hit.baseUrl);
      setVal("aiModel", hit.model);
      updateAiPreview();
    },
    true
  );
  renderChips("aiRouteMode", [
    { id: "subject", label: "\u6309\u5B66\u79D1\u5F52\u6863\uFF08\u5982 408/\u6570\u636E\u7ED3\u6784\uFF09" },
    { id: "qa", label: "\u53EA\u5206\u300C\u77E5\u8BC6\u7B54\u7591 / \u975E\u77E5\u8BC6\u7B54\u7591\u300D" }
  ], [ai.routeMode || "subject"], (ids) => {
    state.ai.routeMode = ids[ids.length - 1] || "subject";
    updateAiPreview();
  }, true);
  updateAiPreview();
}
function collectAi() {
  return {
    enabled: document.getElementById("aiEnabled").checked,
    baseUrl: document.getElementById("aiBaseUrl").value.trim() || DEFAULT_SETTINGS.ai.baseUrl,
    apiKey: document.getElementById("aiApiKey").value.trim(),
    model: document.getElementById("aiModel").value.trim() || DEFAULT_SETTINGS.ai.model,
    nonQaFolder: document.getElementById("aiNonQaFolder").value.trim() || "\u975E\u77E5\u8BC6\u7B54\u7591",
    fallbackFolder: document.getElementById("aiFallbackFolder").value.trim() || "\u672A\u5206\u7C7B",
    maxChars: Math.max(200, Math.min(4e3, Number(document.getElementById("aiMaxChars").value) || 900)),
    routeByCategory: document.getElementById("aiRouteByCategory").checked,
    keepSessionSubfolder: document.getElementById("aiKeepSessionSubfolder").checked,
    subjects: document.getElementById("aiSubjects").value.split("\n").map((s) => s.trim()).filter(Boolean),
    routeMode: state.ai && state.ai.routeMode || "subject",
    jsonMode: (state.ai && state.ai.jsonMode) !== false,
    timeoutMs: state.ai && state.ai.timeoutMs || 2e4,
    cacheLimit: state.ai && state.ai.cacheLimit || 500
  };
}
function updateAiPreview() {
  const el = document.getElementById("ai-path-preview");
  if (!el) return;
  const ai = { ...state.ai || {}, ...collectAi() };
  const useDir = document.getElementById("useDirectoryHandle").checked;
  const dirSub = normalizeRelPath(document.getElementById("dirSubfolder").value);
  const root = useDir ? `\u5DF2\u6388\u6743\u6587\u4EF6\u5939${dirSub ? " / " + dirSub : ""}` : `\u4E0B\u8F7D\u76EE\u5F55 / ${normalizeRelPath(document.getElementById("batchFolder").value) || DEFAULT_SETTINGS.batchFolder}`;
  const sessionPart = document.getElementById("batchSubfolder").checked ? " / <\u4F1A\u8BDD\u540D>" : "";
  const rows = [];
  if (!ai.enabled) {
    el.innerHTML = "\u672A\u542F\u7528 AI \u5F52\u7C7B \u2014\u2014 \u6587\u4EF6\u76F4\u63A5\u653E\u5728\uFF1A<b>" + escapeHtml(root) + sessionPart + "</b>";
    return;
  }
  if (ai.routeByCategory === false) {
    el.innerHTML = "\u5DF2\u542F\u7528\u5224\u65AD\u4F46\u4E0D\u6539\u8DEF\u5F84\uFF08\u300C\u6309\u5206\u7C7B\u5F52\u6863\u76EE\u5F55\u300D\u5DF2\u5173\u95ED\uFF09\u3002";
    return;
  }
  const subjects = parseSubjects(ai.subjects);
  const sample = subjects.length ? subjects : [{ full: "\u6570\u5B66" }];
  rows.push(`<div>\u6839\u76EE\u5F55\uFF1A<b>${escapeHtml(root)}</b>${escapeHtml(sessionPart)} / \u6587\u4EF6</div>`);
  rows.push('<div style="margin-top:6px">\u4F1A\u6309\u4E0B\u9762\u8FD9\u4E9B\u5206\u7C7B\u5EFA\u5B50\u76EE\u5F55\uFF1A</div>');
  const seen = /* @__PURE__ */ new Set();
  for (const s of sample) {
    const folder = categoryFolder(
      { knowledge: true, subject: s.parent || s.full, sub: s.parent ? s.leaf : "" },
      ai
    );
    if (!folder || seen.has(folder)) continue;
    seen.add(folder);
    rows.push(`<div>\u3000<b>${escapeHtml(folder)}</b>/\u2026</div>`);
  }
  const nonQa = categoryFolder({ knowledge: false }, ai);
  if (nonQa && !seen.has(nonQa)) rows.push(`<div>\u3000<b>${escapeHtml(nonQa)}</b>/\u2026\uFF08\u5224\u65AD\u4E3A\u975E\u77E5\u8BC6\u7B54\u7591\u65F6\uFF09</div>`);
  const fallback = categoryFolder({ knowledge: true, subject: "", sub: "" }, ai);
  if (fallback && !seen.has(fallback)) rows.push(`<div>\u3000<b>${escapeHtml(fallback)}</b>/\u2026\uFF08\u79D1\u76EE\u5BF9\u4E0D\u4E0A\u65F6\uFF09</div>`);
  el.innerHTML = rows.join("");
}
async function onAiTest() {
  const status = document.getElementById("ai-status");
  const out = document.getElementById("ai-test-out");
  status.textContent = "\u6D4B\u8BD5\u4E2D\u2026";
  status.className = "tag";
  out.hidden = false;
  out.textContent = "\u6B63\u5728\u8C03\u7528\u63A5\u53E3\u2026";
  try {
    const config = collectAi();
    const resp = await chrome.runtime.sendMessage({ type: "DSX_AI_TEST", config });
    if (resp && resp.ok) {
      status.textContent = "\u63A5\u53E3\u6B63\u5E38";
      status.className = "tag ok";
      const r = resp.result || {};
      out.textContent = `\u2705 \u63A5\u53E3\u53EF\u7528
\u63A5\u53E3\uFF1A${config.baseUrl}
\u6A21\u578B\uFF1A${config.model}
\u5224\u65AD\u7ED3\u679C\uFF1A${r.knowledge === false ? "\u975E\u77E5\u8BC6\u7B54\u7591" : "\u77E5\u8BC6\u7B54\u7591"}
\u79D1\u76EE\uFF1A${[r.subject, r.sub].filter(Boolean).join(" / ") || "\uFF08\u672A\u5206\u7C7B\uFF09"}
\u7406\u7531\uFF1A${r.reason || "\uFF08\u65E0\uFF09"}`;
    } else if (resp && resp.error === "NEED_PERMISSION") {
      status.textContent = "\u7F3A\u5C11\u57DF\u540D\u6743\u9650";
      status.className = "tag warn";
      out.textContent = `\u63A5\u53E3\u53EF\u4EE5\u8BBF\u95EE\uFF0C\u4F46\u6269\u5C55\u8FD8\u6CA1\u6709 ${resp.origin} \u7684\u6743\u9650\u3002
\u8BF7\u70B9\u300C\u6388\u4E88\u8BE5\u63A5\u53E3\u57DF\u540D\u7684\u8BBF\u95EE\u6743\u9650\u300D\uFF0C\u7136\u540E\u91CD\u8BD5\u3002`;
    } else {
      status.textContent = "\u63A5\u53E3\u5F02\u5E38";
      status.className = "tag warn";
      out.textContent = `\u274C ${resp && resp.error || "\u6D4B\u8BD5\u5931\u8D25"}`;
    }
  } catch (e) {
    status.textContent = "\u6D4B\u8BD5\u5931\u8D25";
    status.className = "tag warn";
    out.textContent = `\u274C ${e.message}`;
  }
}
async function onAiGrant() {
  const ai = collectAi();
  const origin = originPattern(ai.baseUrl);
  if (!origin) {
    toast("\u63A5\u53E3\u5730\u5740\u65E0\u6548", true);
    return;
  }
  try {
    const ok = await chrome.permissions.request({ origins: [origin] });
    toast(ok ? `\u5DF2\u6388\u4E88 ${origin}` : "\u7528\u6237\u53D6\u6D88\u4E86\u6388\u6743", !ok);
    if (ok) await onAiTest();
  } catch (e) {
    toast(`\u6388\u6743\u5931\u8D25\uFF1A${e.message}`, true);
  }
}
async function onAiClearCache() {
  try {
    await chrome.runtime.sendMessage({ type: "DSX_AI_CACHE_CLEAR" });
    toast("\u5F52\u7C7B\u7F13\u5B58\u5DF2\u6E05\u7A7A");
  } catch (e) {
    toast(`\u6E05\u7A7A\u5931\u8D25\uFF1A${e.message}`, true);
  }
}
function slotsToIds(slots) {
  return SLOTS.filter((s) => slots && slots[s]);
}
function normalizeSlotsFrom(ids) {
  const out = {};
  for (const s of SLOTS) out[s] = ids.includes(s);
  return out;
}
function setVal(id, v) {
  const el = document.getElementById(id);
  if (el) el.value = v == null ? "" : v;
}
function setChk(id, v) {
  const el = document.getElementById(id);
  if (el) el.checked = !!v;
}
function renderChips(containerId, items, selected, onChange, single = false) {
  const box = document.getElementById(containerId);
  if (!box) return;
  const initial = Array.isArray(selected) ? selected.slice() : selected && typeof selected === "object" ? items.filter((it) => selected[it.id]).map((it) => it.id) : [];
  let current = initial;
  box.innerHTML = "";
  const paint = () => {
    box.querySelectorAll(".chip").forEach((chip) => {
      chip.classList.toggle("on", current.includes(chip.dataset.id));
    });
  };
  items.forEach((it) => {
    const chip = document.createElement("label");
    chip.className = "chip";
    chip.dataset.id = it.id;
    chip.innerHTML = TICK_SVG + `<span>${escapeHtml(it.label)}</span>`;
    chip.addEventListener("click", (e) => {
      e.preventDefault();
      if (single) {
        current = [it.id];
      } else if (current.includes(it.id)) {
        if (current.length === 1) {
          toast("\u81F3\u5C11\u4FDD\u7559\u4E00\u9879");
          return;
        }
        current = current.filter((x) => x !== it.id);
      } else {
        current = current.concat(it.id);
      }
      paint();
      onChange(current.slice());
      scheduleSave();
    });
    box.appendChild(chip);
  });
  paint();
}
function toggleSubfolderField() {
  const on = document.getElementById("batchSubfolder").checked;
  document.getElementById("subfolder-field").style.display = on ? "" : "none";
}
function toggleQualityField() {
  const on = state.imageFormat === "jpeg";
  document.getElementById("quality-field").style.display = on ? "" : "none";
}
function toggleImageFolderField() {
  const on = !state.imageInline;
  document.getElementById("image-folder-field").style.display = on ? "" : "none";
}
function updateDocxHint() {
  const el = document.getElementById("slots-hint-docx");
  const usesDocx = (state.batchFormats || []).includes("docx") || state.defaultFormat === "docx";
  el.textContent = usesDocx ? "\u63D0\u793A\uFF1AWord \u6587\u6863\u91CC\u7684\u6570\u5B66\u516C\u5F0F\u4F1A\u88AB\u8F6C\u6362\u6210 Word \u539F\u751F\u516C\u5F0F\uFF08\u53EF\u7F16\u8F91\uFF09\uFF1B\u56FE\u7247\u4F1A\u5185\u5D4C\u8FDB\u6587\u6863\uFF0C\u5BBD\u5EA6\u53D7\u4E0B\u9762\u300CWord \u56FE\u7247\u6700\u5927\u5BBD\u5EA6\u300D\u63A7\u5236\u3002" : "";
}
function updateSubfolderPreview() {
  const pattern = document.getElementById("batchSubfolderPattern").value || "{date}_{title}";
  const d = /* @__PURE__ */ new Date();
  const p = (n) => String(n).padStart(2, "0");
  const sample = pattern.replace(/\{date\}/g, `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`).replace(/\{time\}/g, `${p(d.getHours())}${p(d.getMinutes())}`).replace(/\{title\}/g, "\u5982\u4F55\u5B66\u4E60\u7EBF\u6027\u4EE3\u6570").replace(/\{index\}/g, "01").replace(/\{id\}/g, "abc123");
  const el = document.getElementById("subfolder-preview");
  el.innerHTML = `\u793A\u4F8B\uFF1A<b>${escapeHtml(sample)}</b>`;
}
function bind() {
  const textIds = ["singleFolder", "batchFolder", "batchSubfolderPattern", "imageFolder", "docxImageMaxWidth", "dirSubfolder"];
  textIds.forEach((id) => {
    document.getElementById(id).addEventListener("input", () => {
      if (id === "batchSubfolderPattern") updateSubfolderPreview();
      if (id === "dirSubfolder" || id === "singleFolder" || id === "batchFolder") updateDirPreview();
      scheduleSave();
    });
  });
  const chkIds = ["batchSubfolder", "batchIndex", "useDirectoryHandle", "verbose", "useApi"];
  chkIds.forEach((id) => {
    document.getElementById(id).addEventListener("change", () => {
      if (id === "batchSubfolder") toggleSubfolderField();
      if (id === "useDirectoryHandle") updateDirPreview();
      scheduleSave();
    });
  });
  document.getElementById("imageQuality").addEventListener("input", (e) => {
    document.getElementById("quality-value").textContent = Number(e.target.value).toFixed(2);
    state.imageQuality = Number(e.target.value);
    scheduleSave();
  });
  document.getElementById("btn-save").addEventListener("click", () => saveNow(true));
  document.getElementById("btn-pick-dir").addEventListener("click", onPickDir);
  document.getElementById("btn-regrant").addEventListener("click", onRegrant);
  document.getElementById("btn-clear-dir").addEventListener("click", onClearDir);
  document.getElementById("btn-grant-hosts").addEventListener("click", () => requestHosts(true));
  document.getElementById("btn-revoke-hosts").addEventListener("click", () => requestHosts(false));
  document.getElementById("btn-diagnose").addEventListener("click", runDiagnose);
  document.getElementById("btn-copy-diag").addEventListener("click", copyDiagnose);
  document.getElementById("btn-refresh-tabs").addEventListener("click", () => {
    refreshDiagTabs().then((tabs) => toast(tabs.length ? `\u627E\u5230 ${tabs.length} \u4E2A\u53EF\u8BCA\u65AD\u9875\u9762` : "\u6CA1\u627E\u5230 DeepSeek / DSH \u9875\u9762"));
  });
  ["aiBaseUrl", "aiApiKey", "aiModel", "aiNonQaFolder", "aiFallbackFolder", "aiMaxChars", "aiSubjects"].forEach((id) => {
    document.getElementById(id).addEventListener("input", () => {
      updateAiPreview();
      scheduleSave();
    });
  });
  ["aiEnabled", "aiRouteByCategory", "aiKeepSessionSubfolder"].forEach((id) => {
    document.getElementById(id).addEventListener("change", () => {
      updateAiPreview();
      scheduleSave();
    });
  });
  document.getElementById("btn-ai-test").addEventListener("click", onAiTest);
  document.getElementById("btn-ai-grant").addEventListener("click", onAiGrant);
  document.getElementById("btn-ai-clear-cache").addEventListener("click", onAiClearCache);
  document.getElementById("btn-export-settings").addEventListener("click", exportSettings);
  document.getElementById("btn-import-settings").addEventListener("click", () => {
    document.getElementById("import-file").click();
  });
  document.getElementById("import-file").addEventListener("change", importSettings);
  document.getElementById("btn-reset").addEventListener("click", onReset);
}
function collect() {
  return {
    singleFolder: normalizeRelPath(document.getElementById("singleFolder").value),
    batchFolder: normalizeRelPath(document.getElementById("batchFolder").value),
    // 已授权文件夹内部的子目录：与上面两个是两套独立前缀，不叠加
    dirSubfolder: normalizeRelPath(document.getElementById("dirSubfolder").value),
    batchSubfolder: document.getElementById("batchSubfolder").checked,
    batchSubfolderPattern: document.getElementById("batchSubfolderPattern").value.trim() || DEFAULT_SETTINGS.batchSubfolderPattern,
    batchIndex: document.getElementById("batchIndex").checked,
    useDirectoryHandle: document.getElementById("useDirectoryHandle").checked,
    imageFolder: normalizeRelPath(document.getElementById("imageFolder").value) || "images",
    docxImageMaxWidth: Math.max(120, Math.min(1400, Number(document.getElementById("docxImageMaxWidth").value) || 620)),
    imageQuality: Number(document.getElementById("imageQuality").value) || 0.92,
    verbose: document.getElementById("verbose").checked,
    useApi: document.getElementById("useApi").checked,
    singleSlots: state.singleSlots,
    batchSlots: state.batchSlots,
    defaultFormat: state.defaultFormat,
    batchFormats: state.batchFormats,
    imageFormat: state.imageFormat,
    imageInline: state.imageInline,
    // AI 归类的分类方式存在 state 里（chips 直接改它），字段值以表单为准
    ai: { ...collectAi(), routeMode: state.ai && state.ai.routeMode || "subject" }
  };
}
function scheduleSave() {
  clearTimeout(saveTimer);
  setSaveState("\u672A\u4FDD\u5B58\u2026", "");
  saveTimer = setTimeout(() => saveNow(false), 600);
}
async function saveNow(explicit) {
  clearTimeout(saveTimer);
  try {
    state = await saveSettings(collect());
    fillForm();
    setSaveState("\u5DF2\u4FDD\u5B58", "ok");
    if (explicit) toast("\u8BBE\u7F6E\u5DF2\u4FDD\u5B58");
    setTimeout(() => setSaveState("", ""), 2200);
  } catch (e) {
    setSaveState("\u4FDD\u5B58\u5931\u8D25", "err");
    toast(`\u4FDD\u5B58\u5931\u8D25\uFF1A${e.message}`, true);
  }
}
function setSaveState(text) {
  const el = document.getElementById("save-state");
  el.textContent = text;
  el.style.color = text.includes("\u5931\u8D25") ? "var(--danger)" : "var(--ok)";
}
async function onPickDir() {
  try {
    const handle = await pickDirectory();
    const perm = await dirPermission(handle, "readwrite");
    if (perm !== "granted") {
      const granted = await requestDirPermission(handle, "readwrite");
      if (granted !== "granted") {
        toast("\u672A\u83B7\u5F97\u5199\u5165\u6743\u9650\uFF0C\u8BF7\u91CD\u8BD5", true);
      }
    }
    state.useDirectoryHandle = true;
    setChk("useDirectoryHandle", true);
    await saveNow(false);
    await refreshDirStatus();
    toast(`\u5DF2\u6388\u6743\u6587\u4EF6\u5939\uFF1A${handle.name}`);
  } catch (e) {
    if (String(e && e.name) === "AbortError") return;
    toast(`\u9009\u62E9\u6587\u4EF6\u5939\u5931\u8D25\uFF1A${e.message}`, true);
  }
}
async function onRegrant() {
  const handle = await loadDirHandle();
  if (!handle) {
    toast("\u8FD8\u6CA1\u6709\u6388\u6743\u8FC7\u6587\u4EF6\u5939\uFF0C\u8BF7\u5148\u70B9\u300C\u9009\u62E9\u6587\u4EF6\u5939\u5E76\u6388\u6743\u300D", true);
    return;
  }
  try {
    const res = await handle.requestPermission({ mode: "readwrite" });
    await refreshDirStatus();
    toast(res === "granted" ? "\u6743\u9650\u5DF2\u6062\u590D" : "\u6743\u9650\u672A\u6388\u4E88", res !== "granted");
  } catch (e) {
    toast(`\u91CD\u65B0\u6388\u6743\u5931\u8D25\uFF1A${e.message}`, true);
  }
}
async function onClearDir() {
  await clearDirHandle();
  await refreshDirStatus();
  toast("\u5DF2\u89E3\u9664\u6587\u4EF6\u5939\u6388\u6743");
}
async function refreshDirStatus() {
  const el = document.getElementById("dir-status");
  const handle = await loadDirHandle();
  if (!handle) {
    el.textContent = "\u672A\u6388\u6743\u3002\u5F53\u524D\u5BFC\u51FA\u76EE\u6807\uFF1A\u6D4F\u89C8\u5668\u4E0B\u8F7D\u76EE\u5F55";
    updateDirPreview();
    return;
  }
  const perm = await dirPermission(handle, "readwrite");
  el.textContent = `\u5DF2\u6388\u6743\uFF1A${handle.name}\uFF08\u6743\u9650\uFF1A${perm === "granted" ? "\u53EF\u7528" : perm === "prompt" ? "\u5F85\u786E\u8BA4" : "\u5DF2\u62D2\u7EDD"}\uFF09`;
  if (perm !== "granted") {
    el.textContent += "\u3000\u2192 \u70B9\u300C\u91CD\u65B0\u6388\u6743\u300D\u6062\u590D\uFF0C\u5426\u5219\u5BFC\u51FA\u4F1A\u56DE\u9000\u5230\u4E0B\u8F7D\u76EE\u5F55";
  }
  updateDirPreview();
}
async function refreshHostsStatus() {
  const el = document.getElementById("hosts-status");
  try {
    const has = await chrome.permissions.contains({ origins: ["*://*/*"] });
    el.textContent = has ? "\u5DF2\u6388\u4E88\uFF1A\u4EFB\u610F\u7F51\u7AD9" : "\u672A\u6388\u4E88\uFF08\u8DE8\u57DF\u56FE\u7247\u53EF\u80FD\u65E0\u6CD5\u8F6C\u7801\uFF09";
    el.className = `tag ${has ? "ok" : "warn"}`;
  } catch (e) {
    el.textContent = "\u65E0\u6CD5\u67E5\u8BE2\u6743\u9650";
    el.className = "tag warn";
  }
}
async function requestHosts(grant) {
  try {
    if (grant) {
      const ok = await chrome.permissions.request({ origins: ["*://*/*"] });
      toast(ok ? "\u5DF2\u6388\u4E88\u6743\u9650\uFF0C\u8DE8\u57DF\u56FE\u7247\u53EF\u4EE5\u6B63\u5E38\u4E0B\u8F7D\u8F6C\u7801\u4E86" : "\u7528\u6237\u53D6\u6D88\u4E86\u6388\u6743", !ok);
    } else {
      const ok = await chrome.permissions.remove({ origins: ["*://*/*"] });
      toast(ok ? "\u5DF2\u64A4\u9500\u8BE5\u6743\u9650" : "\u64A4\u9500\u5931\u8D25");
    }
    await refreshHostsStatus();
  } catch (e) {
    toast(`\u6743\u9650\u64CD\u4F5C\u5931\u8D25\uFF1A${e.message}`, true);
  }
}
var lastDiag = "";
var SUPPORTED_TAB_PATTERNS = [
  /^https?:\/\/chat\.deepseek\.com\//i,
  /^https?:\/\/[^/]*\.deepseek\.com\//i,
  /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?\//i
];
function isSupportedUrl(url) {
  return !!url && SUPPORTED_TAB_PATTERNS.some((re) => re.test(url));
}
async function listSupportedTabs() {
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({});
  } catch (e) {
    return [];
  }
  return tabs.filter((t) => isSupportedUrl(t.url)).sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
}
async function refreshDiagTabs() {
  const sel = document.getElementById("diag-tab");
  if (!sel) return [];
  const tabs = await listSupportedTabs();
  const prev = sel.value;
  sel.innerHTML = "";
  if (tabs.length === 0) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "\uFF08\u6CA1\u627E\u5230 DeepSeek / DSH \u9875\u9762\uFF0C\u8BF7\u5148\u6253\u5F00\u4E00\u4E2A\uFF09";
    sel.appendChild(opt);
    return tabs;
  }
  for (const t of tabs) {
    const opt = document.createElement("option");
    opt.value = String(t.id);
    const title = (t.title || "").slice(0, 36);
    opt.textContent = `${title || "(\u65E0\u6807\u9898)"} \u2014 ${(t.url || "").replace(/^https?:\/\//, "").slice(0, 44)}`;
    sel.appendChild(opt);
  }
  if (prev && tabs.some((t) => String(t.id) === prev)) sel.value = prev;
  return tabs;
}
function sendToTab(tabId, message) {
  return new Promise((resolve) => {
    try {
      chrome.tabs.sendMessage(tabId, message, (r) => {
        if (chrome.runtime.lastError) {
          resolve(null);
          return;
        }
        resolve(r || null);
      });
    } catch (e) {
      resolve(null);
    }
  });
}
var sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function ensureContentScriptInTab(tabId) {
  let resp = await sendToTab(tabId, { type: "DSX_PING" });
  if (resp && resp.ok) return { injected: false };
  await chrome.scripting.executeScript({ target: { tabId }, files: ["content/index.js"] });
  await sleep(300);
  resp = await sendToTab(tabId, { type: "DSX_PING" });
  if (!resp || !resp.ok) throw new Error("\u6CE8\u5165\u5185\u5BB9\u811A\u672C\u540E\u4ECD\u65E0\u6CD5\u4E0E\u9875\u9762\u901A\u4FE1");
  return { injected: true };
}
async function runDiagnose() {
  const status = document.getElementById("diag-status");
  const out = document.getElementById("diag-out");
  status.textContent = "\u6B63\u5728\u8BCA\u65AD\u2026";
  status.className = "tag";
  try {
    const tabs = await refreshDiagTabs();
    const sel = document.getElementById("diag-tab");
    let tabId = sel && sel.value ? Number(sel.value) : null;
    let tab = tabs.find((t) => t.id === tabId) || null;
    if (!tab && tabs.length > 0) {
      tab = tabs[0];
      tabId = tab.id;
      if (sel) sel.value = String(tabId);
    }
    if (!tab || !tabId) {
      throw new Error("\u6CA1\u6709\u627E\u5230 DeepSeek / DSH \u9875\u9762\u3002\u8BF7\u5148\u6253\u5F00 chat.deepseek.com \u7684\u5BF9\u8BDD\u9875\u6216 DSH \u754C\u9762\uFF08127.0.0.1:3080\uFF09\uFF0C\u56DE\u5230\u672C\u9875\u70B9\u300C\u5237\u65B0\u5217\u8868\u300D\u540E\u91CD\u8BD5\u3002");
    }
    const { injected } = await ensureContentScriptInTab(tabId);
    const resp = await sendToTab(tabId, { type: "DSX_DIAGNOSE" });
    if (!resp || !resp.ok) throw new Error(resp && resp.error || "\u8BCA\u65AD\u8BF7\u6C42\u65E0\u54CD\u5E94");
    const report = {
      ...resp.report,
      \u8BCA\u65AD\u76EE\u6807: { id: tabId, title: tab.title || "", url: tab.url || "" },
      \u672C\u6B21\u4E3A\u4E3B\u52A8\u6CE8\u5165: injected
    };
    lastDiag = JSON.stringify(report, null, 2);
    out.hidden = false;
    out.textContent = lastDiag;
    status.textContent = report.adapter ? `\u8BCA\u65AD\u5B8C\u6210\uFF08${report.adapter}\uFF09` : "\u5DF2\u8FDE\u63A5\uFF0C\u4F46\u672A\u8BC6\u522B\u7AD9\u70B9";
    status.className = `tag ${report.adapter ? "ok" : "warn"}`;
  } catch (e) {
    status.textContent = `\u5931\u8D25\uFF1A${e.message}`;
    status.className = "tag warn";
    out.hidden = false;
    out.textContent = `\u8BCA\u65AD\u5931\u8D25\uFF1A${e.message}

\u6392\u67E5\u987A\u5E8F\uFF1A
1) \u5148\u5728\u6D4F\u89C8\u5668\u91CC\u6253\u5F00 chat.deepseek.com \u7684\u5BF9\u8BDD\u9875\uFF0C\u6216 DSH \u754C\u9762\uFF08127.0.0.1:3080\uFF09
2) \u56DE\u5230\u672C\u8BBE\u7F6E\u9875 \u2192 \u70B9\u300C\u5237\u65B0\u5217\u8868\u300D\u2192 \u5728\u300C\u8BCA\u65AD\u76EE\u6807\u300D\u91CC\u9009\u4E2D\u90A3\u4E2A\u9875\u9762
3) \u6D4F\u89C8\u5668\u5185\u7F6E\u9875\u9762\uFF08chrome:// \u7B49\uFF09\u4E0D\u80FD\u4F5C\u4E3A\u8BCA\u65AD\u76EE\u6807
4) \u786E\u8BA4\u6269\u5C55\u5DF2\u542F\u7528\uFF08chrome://extensions/\uFF09

\u8BF4\u660E\uFF1A\u672C\u8BBE\u7F6E\u9875\u81EA\u5DF1\u662F\u6269\u5C55\u9875\u9762\uFF0C\u8DD1\u4E0D\u4E86\u5185\u5BB9\u811A\u672C\uFF0C\u6240\u4EE5\u65E7\u7248\u672C\u7684\u300C\u8BCA\u65AD\u5F53\u524D\u6807\u7B7E\u9875\u300D
\u4F1A\u628A\u76EE\u6807\u9519\u8BA4\u6210\u8BBE\u7F6E\u9875\u5E76\u62FF\u4E0D\u5230\u62A5\u544A\u2014\u2014\u73B0\u5728\u6539\u4E3A\u663E\u5F0F\u9009\u62E9\u76EE\u6807\u9875\u9762\u3002`;
  }
}
async function copyDiagnose() {
  if (!lastDiag) {
    toast("\u8FD8\u6CA1\u6709\u8BCA\u65AD\u7ED3\u679C", true);
    return;
  }
  try {
    await navigator.clipboard.writeText(lastDiag);
    toast("\u8BCA\u65AD\u62A5\u544A\u5DF2\u590D\u5236\u5230\u526A\u8D34\u677F");
  } catch (e) {
    toast("\u590D\u5236\u5931\u8D25\uFF0C\u8BF7\u624B\u52A8\u9009\u4E2D\u4E0B\u65B9\u6587\u672C", true);
  }
}
function exportSettings() {
  const data = JSON.stringify(state, null, 2);
  const blob = new Blob([data], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "dsx-settings.json";
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(a.href);
    a.remove();
  }, 200);
}
async function importSettings(e) {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    const json = JSON.parse(text);
    state = await saveSettings(json);
    fillForm();
    toast("\u8BBE\u7F6E\u5DF2\u5BFC\u5165");
  } catch (err) {
    toast(`\u5BFC\u5165\u5931\u8D25\uFF1A${err.message}`, true);
  } finally {
    e.target.value = "";
  }
}
async function onReset() {
  state = await resetSettings();
  fillForm();
  await refreshDirStatus();
  toast("\u5DF2\u6062\u590D\u9ED8\u8BA4\u8BBE\u7F6E");
}
function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
var toastTimer = null;
function toast(message, isError = false) {
  const el = document.getElementById("toast");
  el.textContent = message;
  el.className = `toast show${isError ? " err" : ""}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.className = "toast";
  }, 2800);
}
