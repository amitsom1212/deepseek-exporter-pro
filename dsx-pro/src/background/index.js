/**
 * 后台 Service Worker
 *
 * 职责（尽量薄）：
 * 1. 落盘：把内容脚本算好的 data: URL 交给 chrome.downloads，
 *    支持「相对下载目录的子路径」——这是无需任何授权就能写到子文件夹的唯一方式。
 * 2. 代理取字节：扩展持有 host 权限时，后台 fetch 不受页面 CORS 限制，
 *    用于下载那些页面里画不进 canvas 的跨域图片。
 * 3. 真实文件夹写入：File System Access 的目录句柄必须由用户手势授权，
 *    授权在设置页完成、句柄存 IndexedDB；真正写文件交给 offscreen 文档
 *    （Service Worker 里没有 DOM 与可写的文件句柄 API）。
 *
 * @file src/background/index.js
 */

import { DEFAULT_SETTINGS, getSettings } from '../core/settings.js';
import { loadDirHandle } from '../core/dirHandle.js';
import {
  requestClassification, classifyCacheKey, readCache, writeCache, clearCache, originPattern
} from '../core/aiClassify.js';

const OFFSCREEN_PATH = 'offscreen/offscreen.html';
let offscreenReady = false;
let creatingOffscreen = null;

/* ------------------------------------------------------------------ */
/*                        消息路由                                     */
/* ------------------------------------------------------------------ */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return false;
  // 标记了 __to:'offscreen' 的消息是发给 offscreen 文档的，
  // 后台必须放行（否则 relayToOffscreen 会被自己再收一遍，形成无限转发）
  if (msg.__to === 'offscreen') return false;

  switch (msg.type) {
    case 'DSX_PING':
      sendResponse({ ok: true, version: chrome.runtime.getManifest().version });
      return false;

    case 'DSX_SAVE_FILES':
      handleSaveFiles(msg).then(sendResponse).catch(err => sendResponse({ ok: false, error: String(err && err.message || err) }));
      return true;

    case 'DSX_FETCH_BINARY':
      handleFetchBinary(msg).then(sendResponse).catch(err => sendResponse({ ok: false, error: String(err && err.message || err) }));
      return true;

    case 'DSX_OPEN_OPTIONS':
      chrome.runtime.openOptionsPage();
      sendResponse({ ok: true });
      return false;

    case 'DSX_DIR_STATUS':
      dirStatus().then(sendResponse).catch(err => sendResponse({ ok: false, error: String(err && err.message || err) }));
      return true;

    case 'DSX_WRITE_DIR':
      writeToDirectory(msg)
        .then(sendResponse)
        .catch(err => sendResponse({ ok: false, error: String(err && err.message || err) }));
      return true;

    case 'DSX_DIR_PICK_RESULT':
      // 设置页选好目录后广播，让打开的面板刷新提示
      chrome.runtime.sendMessage({ type: 'DSX_DIR_CHANGED', name: msg.name }).catch(() => {});
      sendResponse({ ok: true });
      return false;

    /* ---------------- AI 归类 ---------------- */
    case 'DSX_AI_CLASSIFY':
      handleClassify(msg)
        .then(sendResponse)
        .catch(err => sendResponse({ ok: false, error: String(err && err.message || err) }));
      return true;

    case 'DSX_AI_TEST':
      handleAiTest(msg)
        .then(sendResponse)
        .catch(err => sendResponse({ ok: false, error: String(err && err.message || err) }));
      return true;

    case 'DSX_AI_CACHE_CLEAR':
      clearCache().then(() => sendResponse({ ok: true }));
      return true;

    case 'DSX_AI_PERMISSION_CHECK':
      checkAiPermission().then(sendResponse);
      return true;

    default:
      return false;
  }
});

/* ------------------------------------------------------------------ */
/*                          AI 归类                                     */
/* ------------------------------------------------------------------ */

/**
 * 分类请求。
 *
 * 为什么放在后台而不是内容脚本：
 * 1. 后台 fetch 用的是扩展权限，不受页面 CORS 限制；
 * 2. API Key 只存在设置里、只被后台读取，不必经过内容脚本。
 */
async function handleClassify(msg) {
  const settings = await getSettings();
  const ai = settings.ai || {};
  if (!ai.enabled) return { ok: false, error: 'AI 归类未开启', disabled: true };
  if (!ai.apiKey && !/127\.0\.0\.1|localhost/.test(String(ai.baseUrl || ''))) {
    return { ok: false, error: '未填写 API Key（本地接口可不填）', noKey: true };
  }

  const perm = await checkAiPermission(ai);
  if (!perm.ok) return { ok: false, error: 'NEED_PERMISSION', origin: perm.origin };

  const content = {
    title: String(msg.title || ''),
    text: String(msg.text || '').slice(0, Number(ai.maxChars) || 900)
  };
  const key = classifyCacheKey({ title: content.title, text: content.text, ai });

  if (msg.useCache !== false) {
    const hit = await readCache(key);
    if (hit && hit.result) {
      return { ok: true, result: { ...hit.result, source: 'cache' }, cached: true };
    }
  }

  const resp = await requestClassification({ content, ai });
  if (!resp.ok) return resp;

  await writeCache(key, { result: resp.result, at: Date.now() }, ai.cacheLimit || 500);
  return { ok: true, result: resp.result };
}

/**
 * 用一段固定内容测试接口连通性。
 * 允许携带 msg.config：设置页点「测试接口」时用表单里的当前值（无需先保存），
 * 这是扩展页面之间通信，Key 不会经过内容脚本。
 */
async function handleAiTest(msg) {
  const settings = await getSettings();
  const ai = { ...(settings.ai || {}), ...(msg && msg.config ? msg.config : {}) };
  const perm = await checkAiPermission(ai);
  if (!perm.ok) return { ok: false, error: 'NEED_PERMISSION', origin: perm.origin };

  const resp = await requestClassification({
    content: {
      title: '定积分计算',
      text: '请帮我求 ∫₀¹ x² dx 的值，并说明用到的公式。'
    },
    ai
  });
  if (!resp.ok) return resp;
  return { ok: true, result: resp.result, endpoint: ai.baseUrl, model: ai.model };
}

/** 检查（不申请）该接口地址的 host 权限 */
async function checkAiPermission(aiArg) {
  try {
    const ai = aiArg || (await getSettings()).ai || {};
    const origin = originPattern(ai.baseUrl);
    if (!origin) return { ok: false, origin: '', error: '接口地址无效' };
    // 本机地址已在 manifest 里声明，直接用
    if (/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])/i.test(origin)) return { ok: true, origin };
    const has = await chrome.permissions.contains({ origins: [origin] });
    return { ok: !!has, origin, error: has ? '' : `缺少 ${origin} 的访问权限` };
  } catch (e) {
    return { ok: false, origin: '', error: String(e && e.message || e) };
  }
}

chrome.runtime.onInstalled.addListener(details => {
  if (details.reason === 'install') {
    chrome.runtime.openOptionsPage();
  }
});

/* ------------------------------------------------------------------ */
/*                            落盘                                      */
/* ------------------------------------------------------------------ */

/**
 * 保存一批文件。
 * @param {{files: Array<{path:string, dataUrl:string}>, saveAs?:boolean, conflictAction?:string}} msg
 */
async function handleSaveFiles(msg) {
  const files = Array.isArray(msg.files) ? msg.files : [];
  const results = [];
  const conflictAction = msg.conflictAction || 'uniquify';

  for (const file of files) {
    try {
      const id = await downloadOne(file.dataUrl, file.path, !!msg.saveAs, conflictAction);
      results.push({ path: file.path, ok: true, downloadId: id });
    } catch (e) {
      results.push({ path: file.path, ok: false, error: String(e && e.message || e) });
    }
    // 连续调用下载 API 太快会被浏览器节流，给一点点间隔
    await sleep(60);
  }

  const okCount = results.filter(r => r.ok).length;
  return { ok: okCount > 0, saved: okCount, total: files.length, results };
}

function downloadOne(dataUrl, filename, saveAs, conflictAction) {
  return new Promise((resolve, reject) => {
    if (!dataUrl) {
      reject(new Error('文件内容为空'));
      return;
    }
    chrome.downloads.download(
      {
        url: dataUrl,
        filename: sanitizeDownloadPath(filename),
        saveAs: !!saveAs,
        conflictAction
      },
      downloadId => {
        const err = chrome.runtime.lastError;
        if (err) reject(new Error(err.message));
        else resolve(downloadId);
      }
    );
  });
}

/** 下载 API 的 filename 必须是相对路径，且不能有非法字符 */
export function sanitizeDownloadPath(path) {
  const parts = String(path || 'export')
    .replace(/\\/g, '/')
    .split('/')
    .filter(Boolean)
    .map(seg => seg
      .replace(/[<>:"|?*\x00-\x1f]/g, '_')
      .replace(/^\.+$/, '_')
      .replace(/[. ]+$/, '')
      .slice(0, 120) || '_')
    .filter(Boolean);
  const joined = parts.join('/');
  if (!joined) return 'export';
  // 单条路径总长限制（Windows 约 260，留足余量）
  return joined.length > 220 ? joined.slice(joined.length - 220).replace(/^[^/]*\//, '') : joined;
}

/* ------------------------------------------------------------------ */
/*                        跨域取字节代理                                */
/* ------------------------------------------------------------------ */

async function handleFetchBinary(msg) {
  const url = msg && msg.url;
  if (!url) return { ok: false, error: '缺少 url' };
  try {
    const resp = await fetch(url, { credentials: 'include' });
    if (!resp.ok) return { ok: false, error: `HTTP ${resp.status}` };
    const buf = await resp.arrayBuffer();
    const mime = resp.headers.get('content-type') || 'application/octet-stream';
    return { ok: true, mime, dataUrl: `data:${mime};base64,${arrayBufferToBase64(buf)}` };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
}

function arrayBufferToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/* ------------------------------------------------------------------ */
/*                   Offscreen（真实文件夹写入）                        */
/* ------------------------------------------------------------------ */

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
        reasons: ['BLOBS'],
        justification: '把导出文件写入用户授权的本地文件夹'
      });
      offscreenReady = true;
      return true;
    } catch (e) {
      // 已存在时 createDocument 会抛错，这属于正常情况
      if (String(e && e.message).includes('single offscreen')) {
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

/**
 * 目录状态查询。
 * 先自己读一次 IndexedDB：没有授权过句柄就直接回「未授权」，
 * 避免为了查一个状态白白创建一个 offscreen 文档。
 */
async function dirStatus() {
  let handle = null;
  try {
    handle = await loadDirHandle();
  } catch (e) {
    handle = null;
  }
  if (!handle) return { ok: true, granted: false, name: '', reason: '未授权文件夹' };
  await ensureOffscreen();
  return await relayToOffscreen({ type: 'DSX_DIR_STATUS' });
}

/**
 * 通过 offscreen 文档把文件写入用户授权的真实文件夹。
 * offscreen 里没有用户手势，只能沿用设置页已存的权限；若权限失效则明确报错，
 * 由内容脚本回退到「下载目录相对路径」。
 */
async function writeToDirectory(msg) {
  await ensureOffscreen();
  return relayToOffscreen({ type: 'DSX_WRITE_DIR', files: msg.files, subfolder: msg.subfolder });
}

/** 给 offscreen 发消息（offscreen 的监听器负责应答） */
function relayToOffscreen(payload, timeoutMs = 120000) {
  return new Promise(resolve => {
    let done = false;
    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        resolve({ ok: false, error: 'offscreen 响应超时' });
      }
    }, timeoutMs);

    try {
      chrome.runtime.sendMessage({ ...payload, __to: 'offscreen' }, resp => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: chrome.runtime.lastError.message });
        } else {
          resolve(resp || { ok: false, error: 'offscreen 无响应' });
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
  return new Promise(r => setTimeout(r, ms));
}

/* 首次安装时把默认设置写进去，保证设置页一打开就有值 */
chrome.runtime.onInstalled.addListener(async () => {
  try {
    const cur = await chrome.storage.local.get('dsx_settings');
    if (!cur || !cur.dsx_settings) {
      await chrome.storage.local.set({ dsx_settings: DEFAULT_SETTINGS });
    }
  } catch (e) { /* 忽略 */ }
});
