/**
 * 设置读写（内容脚本 / 设置页 / 后台共用）
 *
 * 存储位置：chrome.storage.local
 * - 内容脚本直接读缓存，设置页改动后通过 storage.onChanged 广播刷新，
 *   避免每次导出都 await 一次存储读取。
 *
 * @file src/core/settings.js
 */

import { normalizeSlots, allSlots } from './model.js';

/** 批量导出时子文件夹命名模板可用变量：{date} {time} {title} {id} {index} */
export const DEFAULT_SUBFOLDER_PATTERN = '{date}_{title}';

export const DEFAULT_SETTINGS = {
  /* ---------- 路径 ---------- */
  /** 单独导出：默认文件夹（浏览器下载目录下的相对路径） */
  singleFolder: 'DeepSeek导出/单条',
  /** 批量导出：默认文件夹（浏览器下载目录下的相对路径） */
  batchFolder: 'DeepSeek导出/批量',
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
  dirSubfolder: '',

  /* ---------- 默认输出内容 ---------- */
  /** 批量导出默认勾选的内容项 */
  batchSlots: allSlots(),
  /** 单独导出默认勾选的内容项 */
  singleSlots: allSlots(),
  /** 默认导出格式：md | docx | txt | json */
  defaultFormat: 'md',
  /** 导出格式多选（批量导出时可同时导出多种） */
  batchFormats: ['md'],

  /* ---------- 图片 ---------- */
  /** 图片输出格式：png | jpeg | webp | original */
  imageFormat: 'png',
  /** jpeg 质量 0.5~1 */
  imageQuality: 0.92,
  /** 图片存放目录（相对导出目录） */
  imageFolder: 'images',
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
  lastTab: 'current',
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
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: '',
    model: 'deepseek-chat',
    timeoutMs: 20000,
    /** 送给模型的正文字数上限（越大越准，也越贵） */
    maxChars: 900,
    /** 是否请求 JSON 输出模式（部分兼容服务不支持，会自动重试一次） */
    jsonMode: true,
    /** 按分类归档目录 */
    routeByCategory: true,
    /** 归档维度：'subject' = 按学科；'qa' = 只分是否知识答疑 */
    routeMode: 'subject',
    /** 非知识答疑的归档目录名 */
    nonQaFolder: '非知识答疑',
    /** 无法判定科目时的兜底目录名 */
    fallbackFolder: '未分类',
    /** 科目清单，用 / 表示层级，例如 408/数据结构 */
    subjects: [
      '数学',
      '英语',
      '政治',
      '408/数据结构',
      '408/计算机网络',
      '408/计算机组成原理',
      '408/操作系统'
    ],
    /** 归档时是否仍保留「每个会话一个子文件夹」 */
    keepSessionSubfolder: true,
    /** 分类结果缓存条数上限 */
    cacheLimit: 500
  }
};

const KEY = 'dsx_settings';

/** 内存缓存，避免高频读存储 */
let cache = null;

function merge(base, patch) {
  const out = { ...base };
  for (const [k, v] of Object.entries(patch || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) {
      out[k] = merge(base[k], v);
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out;
}

/** 读取全部设置（带缓存） */
export async function getSettings(force = false) {
  if (cache && !force) return cache;
  try {
    const raw = await chrome.storage.local.get(KEY);
    cache = merge(DEFAULT_SETTINGS, raw && raw[KEY]);
  } catch (e) {
    cache = { ...DEFAULT_SETTINGS };
  }
  cache.batchSlots = normalizeSlots(cache.batchSlots);
  cache.singleSlots = normalizeSlots(cache.singleSlots);
  if (!Array.isArray(cache.batchFormats) || cache.batchFormats.length === 0) cache.batchFormats = ['md'];
  return cache;
}

/** 同步取缓存（内容脚本 UI 首帧用；未加载时返回默认值） */
export function getSettingsSync() {
  return cache || { ...DEFAULT_SETTINGS };
}

/** 合并写入设置 */
export async function saveSettings(patch) {
  const current = await getSettings(true);
  const next = merge(current, patch);
  const plain = JSON.parse(JSON.stringify(next));
  await chrome.storage.local.set({ [KEY]: plain });
  cache = next;
  return next;
}

/** 监听设置变化（设置页保存后，页面里的面板即时生效） */
export function onSettingsChanged(handler) {
  if (!chrome.storage || !chrome.storage.onChanged) return () => {};
  const listener = (changes, area) => {
    if (area !== 'local' || !changes[KEY]) return;
    cache = merge(DEFAULT_SETTINGS, changes[KEY].newValue);
    cache.batchSlots = normalizeSlots(cache.batchSlots);
    cache.singleSlots = normalizeSlots(cache.singleSlots);
    handler(cache);
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}

/** 供设置页/后台重置 */
export async function resetSettings() {
  cache = null;
  await chrome.storage.local.remove(KEY);
  return getSettings(true);
}

/** 浏览器下载目录是唯一可无授权写入的位置，这里把用户输入规整成安全的相对路径 */
export function normalizeRelPath(input) {
  let p = String(input || '').replace(/\\/g, '/').trim();
  p = p.replace(/^[a-zA-Z]:/, '');            // 去掉盘符
  p = p.replace(/^\/+/, '');                  // 去掉开头斜杠
  p = p.replace(/\.\.(\/|$)/g, '');           // 去掉上跳
  p = p.replace(/\/{2,}/g, '/');
  p = p.replace(/[<>:"|?*\x00-\x1f]/g, '_');
  p = p.split('/').filter(Boolean).map(seg => seg.replace(/[. ]+$/, '')).filter(Boolean).join('/');
  return p;
}
