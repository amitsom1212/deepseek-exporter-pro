/**
 * 导出执行器（内容脚本侧编排）
 *
 * 一次导出的完整流程：
 *   勾选 → 图片取字节并转码 → 生成 markdown / docx / txt / json
 *        → 组装相对路径 → 交给后台落盘（优先写用户授权目录，其次下载目录）
 *
 * 只在这里做「有副作用」的事；纯计算都在 core/ 里，便于单测。
 *
 * @file src/content/exportRunner.js
 */

import { getSettings, normalizeRelPath } from '../core/settings.js';
import { buildMarkdown, buildPlainText, buildJson, planImageFiles, buildBatchIndex, extractMarkdownImageUrls } from '../core/exporter.js';
import { prepareImages, sendToBackground } from '../core/imagePipeline.js';
import { mdToDocxBase64, imageSizeFromBytes, DOCX_MIME } from '../core/md2docx.js';
import { normalizeSlots, SLOTS, ROLE } from '../core/model.js';
import {
  safeName, safePath, conversationBasename, stamp, buildSubfolder, dedupe, joinPath
} from '../core/filename.js';

/** 导出格式元信息 */
export const FORMATS = {
  md: { label: 'Markdown', ext: '.md', mime: 'text/markdown' },
  docx: { label: 'Word', ext: '.docx', mime: DOCX_MIME },
  txt: { label: '纯文本', ext: '.txt', mime: 'text/plain' },
  json: { label: 'JSON', ext: '.json', mime: 'application/json' }
};

/** data: URL 的字节数 */
function dataUrlBytes(dataUrl) {
  const s = String(dataUrl || '');
  const i = s.indexOf(',');
  if (i < 0) return 0;
  return Math.floor((s.length - i - 1) * 0.75);
}

function b64DataUrl(mime, base64) {
  return `data:${mime};base64,${base64}`;
}

/** 文本 → data URL（用 UTF-8 安全的方式，避免中文乱码） */
export function textToDataUrl(text, mime = 'text/plain') {
  const bytes = new TextEncoder().encode(String(text ?? ''));
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return `data:${mime};charset=utf-8;base64,${btoa(binary)}`;
}

/**
 * 执行一次导出。
 *
 * @param {object} req
 * @param {object[]} req.turns 归一化后的消息
 * @param {object} req.slots 内容勾选
 * @param {string[]} req.formats 目标格式
 * @param {string} req.title 会话标题
 * @param {string} req.site 站点名
 * @param {string} req.url 会话链接
 * @param {string} [req.sessionId]
 * @param {'single'|'batch'} [req.mode]
 * @param {number} [req.batchIndex] 批量时的序号（从 0 开始）
 * @param {(msg:string, kind?:string)=>void} [req.onLog]
 * @param {(done:number,total:number,label:string)=>void} [req.onProgress]
 * @returns {Promise<{ok:boolean, files:object[], warnings:string[], baseFolder:string, usedDirHandle:boolean}>}
 */
export async function runExport(req) {
  const settings = await getSettings();
  const slots = normalizeSlots(req.slots || settings.singleSlots);
  const formats = (req.formats && req.formats.length ? req.formats : [settings.defaultFormat])
    .filter(f => FORMATS[f]);
  const mode = req.mode || 'single';
  const warnings = [];
  const log = (msg, kind) => { if (req.onLog) req.onLog(msg, kind); };
  const progress = (done, total, label) => { if (req.onProgress) req.onProgress(done, total, label); };

  const turns = req.turns || [];
  if (turns.length === 0) {
    return { ok: false, files: [], warnings: ['没有可导出的内容'], baseFolder: '', usedDirHandle: false };
  }

  /* ---------- 0. 每条消息的独立勾选 ---------- */
  // turn.__slots 优先（面板里逐条改过的），否则跟随全局
  const activeTurns = turns
    .filter(t => t.selected !== false)
    .map(t => {
      const s = t.__slots || slots;
      return {
        ...t,
        __slots: s,
        images: s.images ? (t.images || []) : []
      };
    });
  if (activeTurns.length === 0) {
    return { ok: false, files: [], warnings: ['没有勾选任何消息'], baseFolder: '', usedDirHandle: false };
  }

  /* ---------- 1. 图片 ----------
   * 两个来源统一处理：
   *   a) 消息对象里的结构化附件（接口的 files[] / fragments 等）——适配器已收进 turn.images
   *   b) 正文 markdown 里以链接形式出现的图片（![](...)）——这里补收，
   *      否则 .md 里留的是会过期的远端链接，日后复习图就没了
   */
  const structuredImages = activeTurns.flatMap(t => t.images || []);
  const inlineAssets = [];
  const seenInlineUrl = new Set();
  for (const turn of activeTurns) {
    const s = turn.__slots || slots;
    if (!s.images) continue; // 没勾图片就不收，也不改写正文
    const urls = [
      ...extractMarkdownImageUrls(turn.question),
      ...extractMarkdownImageUrls(turn.thinking),
      ...extractMarkdownImageUrls(turn.answer)
    ];
    for (const u of urls) {
      if (seenInlineUrl.has(u)) continue;
      if (structuredImages.some(img => img.src === u)) continue; // 附件里已经有了
      seenInlineUrl.add(u);
      inlineAssets.push({
        id: `inline-${inlineAssets.length + 1}`,
        src: u,
        alt: '',
        basename: '',
        mime: '',
        slot: 'inline'
      });
    }
  }

  const allImages = structuredImages.concat(inlineAssets);
  let imagePlan = new Map();
  let imagePrepared = new Map();
  let inlineMap = null;
  /** 正文内联图片：原始 URL → 本地相对路径（供改写 markdown） */
  let inlineUrlToPath = new Map();
  /** 原始 URL → dataUrl（供 docx 内嵌） */
  const urlToDataUrl = new Map();

  if (allImages.length > 0) {
    imagePlan = planImageFiles(activeTurns, {
      folder: settings.imageFolder || 'images',
      format: settings.imageFormat || 'png',
      extraAssets: inlineAssets
    });
    progress(0, allImages.length + 3, `处理 ${allImages.length} 张图片`);
    imagePrepared = await prepareImages(allImages, {
      format: settings.imageFormat || 'png',
      quality: settings.imageQuality ?? 0.92,
      maxWidth: 0,
      onProgress: (done, total) => progress(done, total + 3, `图片 ${done}/${total}`)
    });
    // 把计划里的相对路径挂到已处理结果上（docx 内嵌时要用它反查图片）
    imagePlan.forEach((plan, id) => {
      const v = imagePrepared.get(id);
      if (v) v.path = plan.path;
    });
    for (const a of inlineAssets) {
      const v = imagePrepared.get(a.id);
      if (v && !v.failed && v.path) inlineUrlToPath.set(a.src, v.path);
    }
    imagePrepared.forEach(v => {
      if (v && !v.failed && v.dataUrl && v.asset && v.asset.src) urlToDataUrl.set(v.asset.src, v.dataUrl);
    });
    const failed = Array.from(imagePrepared.values()).filter(v => v.failed);
    if (failed.length) {
      warnings.push(`${failed.length} 张图片无法读取字节（多为跨域限制），已在导出中保留原始链接。可在设置页开启「授予任意网站访问权限」提升成功率。`);
      failed.slice(0, 3).forEach(f => log(`图片失败：${f.note}｜${String(f.rawUrl || (f.asset && f.asset.src) || '').slice(0, 80)}`, 'err'));
    }
    if (inlineAssets.length) {
      log(`正文中另发现 ${inlineAssets.length} 张内联图片，成功保存 ${inlineUrlToPath.size} 张`);
    }
    // 图片内联模式：把 dataUrl 直接塞进 markdown
    if (settings.imageInline) {
      inlineMap = new Map();
      imagePrepared.forEach((v, id) => {
        if (!v.failed && v.dataUrl) inlineMap.set(id, v.dataUrl);
      });
    }
  }

  /* ---------- 2. 生成各格式内容 ---------- */
  const meta = {
    site: req.site || '',
    url: req.url || '',
    time: formatNow(),
    timeIso: new Date().toISOString()
  };
  const useInlineImages = !!(settings.imageInline && inlineMap && inlineMap.size > 0);

  const common = {
    title: req.title || '对话记录',
    turns: activeTurns,
    slots,
    imagePlan,
    imageDataUrls: inlineMap,
    inlineImagePathMap: inlineUrlToPath,
    meta
  };

  const mdResult = buildMarkdown(common);
  const warningsOut = [...warnings];
  if (mdResult.kept === 0) {
    return { ok: false, files: [], warnings: ['勾选的内容在本次对话里没有对应数据'], baseFolder: '', usedDirHandle: false };
  }
  if (mdResult.skipped > 0) log(`跳过了 ${mdResult.skipped} 条不含所选内容的消息`);
  if (inlineUrlToPath.size) log(`正文中的 ${inlineUrlToPath.size} 张图片已替换为本地路径`);

  /* ---------- 3. 组装「导出根目录内」的相对路径 ----------
   * 关键：这里**不包含**设置里的那个根目录。
   * 因为落盘目标有两种，前缀不一样：
   *   - 浏览器下载：前缀 = 下载目录下的相对路径（singleFolder / batchFolder）
   *   - 已授权真实文件夹：前缀 = dirSubfolder（默认空 = 直接放在授权目录根下）
   * 之前把 singleFolder 拼进来导致「授权目录 + 相对路径」重复嵌套，这里修的就是它。
   */
  const categoryDir = req.category ? safePath(String(req.category)) : '';
  const wantSub = req.keepSubfolder === undefined ? settings.batchSubfolder : !!req.keepSubfolder;
  let sub = '';
  if (mode === 'batch' && wantSub) {
    sub = buildSubfolder(settings.batchSubfolderPattern, {
      title: req.title,
      id: req.sessionId || '',
      index: req.batchIndex || 0,
      date: new Date()
    });
  }

  const fileBase = mode === 'batch'
    ? conversationBasename(req.title, req.batchIndex || 0)
    : `${stamp()}_${conversationBasename(req.title, 0)}`;

  const used = new Set();
  /** @type {Array<{path:string, dataUrl:string, kind:string, bytes:number}>} 路径为导出根目录内的相对路径 */
  const files = [];

  // 图片文件
  if (!useInlineImages) {
    for (const [id, plan] of imagePlan) {
      const prepared = imagePrepared.get(id);
      if (!prepared) continue;
      if (prepared.failed || !prepared.dataUrl) continue;
      files.push({
        path: joinPath(categoryDir, sub, plan.path),
        dataUrl: prepared.dataUrl,
        kind: 'image',
        bytes: dataUrlBytes(prepared.dataUrl),
        note: prepared.note
      });
    }
  }

  // 正文文件
  for (const fmt of formats) {
    if (fmt === 'md') {
      files.push({
        path: joinPath(categoryDir, sub, dedupe(fileBase, '.md', used)),
        dataUrl: textToDataUrl(mdResult.markdown, 'text/markdown'),
        kind: 'md',
        bytes: new TextEncoder().encode(mdResult.markdown).length
      });
    } else if (fmt === 'txt') {
      const { text } = buildPlainText(common);
      files.push({
        path: joinPath(categoryDir, sub, dedupe(fileBase, '.txt', used)),
        dataUrl: textToDataUrl(text, 'text/plain'),
        kind: 'txt',
        bytes: new TextEncoder().encode(text).length
      });
    } else if (fmt === 'json') {
      const { json } = buildJson(common);
      files.push({
        path: joinPath(categoryDir, sub, dedupe(fileBase, '.json', used)),
        dataUrl: textToDataUrl(json, 'application/json'),
        kind: 'json',
        bytes: new TextEncoder().encode(json).length
      });
    } else if (fmt === 'docx') {
      progress(allImages.length + 1, allImages.length + 3, '生成 Word 文档');
      const base64 = await mdToDocxBase64(mdResult.markdown, {
        title: req.title || '对话记录',
        creator: req.site || 'DeepSeek Exporter Pro',
        imageMaxWidth: settings.docxImageMaxWidth || 620,
        resolveImage: makeImageResolver(imagePrepared, urlToDataUrl)
      });
      files.push({
        path: joinPath(categoryDir, sub, dedupe(fileBase, '.docx', used)),
        dataUrl: b64DataUrl(DOCX_MIME, base64),
        kind: 'docx',
        bytes: Math.floor(base64.length * 0.75)
      });
    }
  }

  if (files.length === 0) {
    return { ok: false, files: [], warnings: ['没有生成任何文件'], baseFolder: '', usedDirHandle: false };
  }

  /* ---------- 4. 落盘 ---------- */
  progress(allImages.length + 3, allImages.length + 3, '写入文件');
  const saved = await persistFiles(files, settings, mode, log, warningsOut);

  return {
    ok: saved.ok,
    // 这里给出的是**最终落盘路径**（persistFiles 已按目标补上前缀），便于界面展示真实位置
    files: (saved.files || files).map(f => ({ path: f.path, kind: f.kind, bytes: f.bytes, note: f.note })),
    warnings: warningsOut,
    baseFolder: saved.baseFolder || '',
    usedDirHandle: saved.usedDirHandle,
    saved: saved.result
  };
}

/**
 * 落盘策略：
 * 1) 用户在设置页授权了真实文件夹 → 写进那个文件夹（真正任意路径）
 * 2) 否则 → chrome.downloads，写进「下载目录/相对路径」（无需授权）
 *
 * @param {Array<{path:string}>} files path 是「导出根目录内」的相对路径，
 *        本函数负责按落盘目标补上根前缀：
 *        - 授权文件夹：`dirSubfolder`（默认空 = 直接放在授权目录根下）
 *        - 下载目录：`singleFolder` / `batchFolder`
 */
async function persistFiles(files, settings, mode, log, warnings) {
  const wantDir = !!settings.useDirectoryHandle;

  if (wantDir) {
    const status = await sendToBackground({ type: 'DSX_DIR_STATUS' });
    if (status && status.ok && status.granted) {
      // 已授权目录就是"根"，绝不再叠加下载目录那串相对路径，
      // 否则会出现 授权目录/考研/dsx笔记整理/... 这种重复嵌套
      const dirBase = normalizeRelPath(settings.dirSubfolder || '');
      const rooted = files.map(f => ({ ...f, path: joinPath(dirBase, f.path) }));
      log(`写入已授权文件夹：${status.name}${dirBase ? ' / ' + dirBase : ''}`);
      const resp = await sendToBackground({ type: 'DSX_WRITE_DIR', files: rooted });
      if (resp && resp.ok) {
        return {
          ok: true,
          usedDirHandle: true,
          result: resp,
          files: rooted,
          baseFolder: `${status.name}${dirBase ? ' / ' + dirBase : ''}`
        };
      }
      warnings.push(`写入授权文件夹失败（${resp && resp.error || '未知原因'}），已回退到浏览器下载目录。`);
    } else if (status && status.ok && status.name) {
      warnings.push(`授权文件夹「${status.name}」权限已失效，本次导出到浏览器下载目录。请在设置页重新授权。`);
    }
  }

  const dlBase = normalizeRelPath(mode === 'batch' ? settings.batchFolder : settings.singleFolder);
  const rooted = files.map(f => ({ ...f, path: joinPath(dlBase, f.path) }));
  const resp = await sendToBackground({ type: 'DSX_SAVE_FILES', files: rooted });
  if (!resp || !resp.ok) {
    warnings.push(`下载失败：${(resp && resp.error) || '后台无响应'}`);
    return { ok: false, usedDirHandle: false, result: resp, files: rooted, baseFolder: dlBase };
  }
  const bad = (resp.results || []).filter(r => !r.ok);
  if (bad.length) warnings.push(`${bad.length} 个文件下载失败：${bad[0].error || ''}`);
  return { ok: true, usedDirHandle: false, result: resp, files: rooted, baseFolder: dlBase };
}

/** markdown 里的图片引用 → docx 内嵌图片 */
function makeImageResolver(prepared, urlToDataUrl) {
  const byUrl = urlToDataUrl || new Map();
  return src => {
    const key = String(src || '');
    if (!key) return null;

    // 0) inline 模式：markdown 里的图片地址本身就是 data URL，直接就能用。
    //    必须在最前面判断——否则会一路找不到而回退成"[图片：<整串 base64>]"塞进 Word。
    if (/^data:image\//i.test(key)) {
      try {
        return dataUrlToImageInput(key, 'inline');
      } catch (e) {
        return null;
      }
    }

    // 1) 正文里内联的 URL 图片（已预先取字节并转码）
    let direct = byUrl.get(key);
    if (!direct) {
      try {
        direct = byUrl.get(decodeURIComponent(key));
      } catch (e) { /* 忽略非法转义 */ }
    }
    if (direct) return dataUrlToImageInput(direct, key);

    // 2) 附件图片（按导出计划里的相对路径反查）
    for (const v of prepared.values()) {
      if (!v || v.failed || !v.dataUrl) continue;
      if (v.path && (key === v.path || key === encodeURI(v.path) || decodeURIComponent(key) === v.path)) {
        return toImageInput(v);
      }
    }
    const tail = key.split('/').pop();
    for (const v of prepared.values()) {
      if (!v || v.failed || !v.dataUrl || !v.path) continue;
      if (v.path.split('/').pop() === tail) return toImageInput(v);
    }
    return null;
  };
}

/** data URL → docx 图片输入 */
function dataUrlToImageInput(dataUrl, hint) {
  const base64 = String(dataUrl).split(',')[1] || '';
  const mime = (String(dataUrl).match(/^data:([^;,]+)/) || [, 'image/png'])[1];
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const size = imageSizeFromBytes(bytes);
  const type = mime.includes('jpeg') ? 'jpg'
    : mime.includes('gif') ? 'gif'
      : mime.includes('bmp') ? 'bmp' : 'png';
  return {
    data: bytes,
    type,
    width: size.width || 480,
    height: size.height || 320
  };
}

function toImageInput(v) {
  const base64 = String(v.dataUrl).split(',')[1] || '';
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const size = imageSizeFromBytes(bytes);
  const type = (v.ext === 'jpg' || v.ext === 'jpeg') ? 'jpg' : (v.ext || 'png');
  return {
    data: bytes,
    type,
    width: size.width || 480,
    height: size.height || 320
  };
}

/** 本地时间字符串 */
export function formatNow(d = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * 供批量导出复用的索引生成。
 * 注意：路径只给「导出根目录内」的相对路径，根前缀由 persistFiles 按落盘目标补，
 * 否则授权文件夹模式下会重复嵌套（历史 bug）。
 */
export async function writeBatchIndex(entries, settings, log) {
  if (!settings.batchIndex) return null;
  const md = buildBatchIndex(entries, {
    title: '批量导出索引',
    time: formatNow(),
    formats: (settings.batchFormats || ['md']).join(' / ')
  });
  const name = `00-索引_${stamp()}.md`;
  const file = { path: name, dataUrl: textToDataUrl(md, 'text/markdown'), kind: 'md', bytes: md.length };
  const saved = await persistFiles([file], settings, 'batch', log || (() => {}), []);
  if (!saved.ok) return null;
  // 返回真实落盘路径，便于日志与界面显示
  const final = (saved.files && saved.files[0] && saved.files[0].path) || name;
  return final;
}
