/**
 * 图片流水线：取字节 → 解码 → 转码（webp → png/jpeg）→ 输出
 *
 * 为什么需要它：DeepSeek / DSH 页面上「复制下来」的图大多是 webp 缩略图，
 * 直接落盘后很多 Windows 程序（Word 老版本、看图工具、微信）打不开。
 * 这里统一转成 png / jpeg。
 *
 * 取字节的优先级（逐级降级，任何一级成功即返回）：
 *   1) fetch(src)            —— 同源或带 CORS 的资源，最干净
 *   2) 把页面上已有的 <img> 画进 canvas —— 仅当图片未被跨域污染
 *   3) background 代理 fetch —— 扩展有 host 权限时不受 CORS 限制
 *   4) 放弃转换，直接把原 URL 交给浏览器下载 —— 保证「至少能拿到文件」
 *
 * @file src/core/imagePipeline.js
 */

const MIME_EXT = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/bmp': 'bmp',
  'image/avif': 'avif',
  'image/svg+xml': 'svg'
};

/** 目标格式 → MIME */
export function formatMime(format) {
  switch (String(format || '').toLowerCase()) {
    case 'jpeg':
    case 'jpg':
      return 'image/jpeg';
    case 'webp':
      return 'image/webp';
    case 'original':
      return '';
    default:
      return 'image/png';
  }
}

/** 目标格式 → 扩展名 */
export function formatExt(format) {
  const mime = formatMime(format);
  return mime ? MIME_EXT[mime] || 'png' : '';
}

/** data URL → blob */
export function dataUrlToBlob(dataUrl) {
  const [head, body] = String(dataUrl).split(',');
  const mime = (head.match(/data:([^;]+)/) || [, 'application/octet-stream'])[1];
  if (/;base64/.test(head)) {
    const bin = atob(body);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: mime });
  }
  return new Blob([decodeURIComponent(body)], { type: mime });
}

/** blob → data URL（FileReader 不可用时退回 arrayBuffer 手动编码，兼容 Worker 环境） */
export async function blobToDataUrl(blob) {
  if (typeof FileReader === 'function') {
    return await new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result));
      fr.onerror = () => reject(fr.error || new Error('读取图片失败'));
      fr.readAsDataURL(blob);
    });
  }
  const buf = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < buf.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, buf.subarray(i, i + CHUNK));
  }
  const b64 = typeof btoa === 'function'
    ? btoa(binary)
    : Buffer.from(binary, 'binary').toString('base64');
  return `data:${blob.type || 'application/octet-stream'};base64,${b64}`;
}

/** 嗅探 MIME（magic number），拿不到时返回空串 */
export function sniffMime(bytes) {
  const b = bytes;
  if (b.length < 12) return '';
  if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif';
  if (b[0] === 0x42 && b[1] === 0x4d) return 'image/bmp';
  // RIFF....WEBP
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46
    && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  const head = String.fromCharCode(...b.slice(0, 200));
  if (/<svg[\s>]/i.test(head)) return 'image/svg+xml';
  return '';
}

/**
 * 取图片字节。
 * @param {object} asset
 * @returns {Promise<{blob: Blob|null, mime: string, via: string, error?: string}>}
 */
export async function fetchImageBlob(asset) {
  const src = asset && asset.src;
  if (!src) return { blob: null, mime: '', via: 'none', error: '图片地址为空' };

  // data: 直接解出来
  if (src.startsWith('data:')) {
    try {
      const blob = dataUrlToBlob(src);
      return { blob, mime: blob.type, via: 'data-url' };
    } catch (e) {
      return { blob: null, mime: '', via: 'data-url', error: e.message };
    }
  }

  // 1) 直接 fetch（同源 / 带 CORS）
  try {
    const resp = await fetch(src, { credentials: 'include', cache: 'force-cache' });
    if (resp.ok) {
      const blob = await resp.blob();
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const mime = sniffMime(bytes) || blob.type || '';
      return { blob: new Blob([bytes], { type: mime || blob.type }), mime, via: 'fetch' };
    }
  } catch (e) {
    // 继续降级
  }

  // 2) 用页面上的 <img> 画进 canvas（未被污染时可行）
  if (asset.el && asset.el.isConnected) {
    try {
      const canvas = document.createElement('canvas');
      const img = asset.el;
      const w = img.naturalWidth || img.width;
      const h = img.naturalHeight || img.height;
      if (w && h) {
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, w, h);
        const dataUrl = canvas.toDataURL('image/png'); // 被污染会抛 SecurityError
        return { blob: dataUrlToBlob(dataUrl), mime: 'image/png', via: 'canvas' };
      }
    } catch (e) {
      // 跨域污染，继续降级
    }
  }

  // 3) 交给后台代理（扩展持有 host 权限时不受 CORS 限制）
  try {
    const resp = await sendToBackground({ type: 'DSX_FETCH_BINARY', url: src });
    if (resp && resp.ok && resp.dataUrl) {
      const blob = dataUrlToBlob(resp.dataUrl);
      return { blob, mime: resp.mime || blob.type, via: 'background' };
    }
  } catch (e) {
    // 继续降级
  }

  // 4) 放弃转换，让浏览器直接下载原文件
  return { blob: null, mime: '', via: 'raw-url', error: '无法读取图片字节（可能被跨域策略拦截）' };
}

/** 与 background 通信（失败不抛，返回 null） */
export function sendToBackground(message) {
  return new Promise(resolve => {
    try {
      chrome.runtime.sendMessage(message, resp => {
        if (chrome.runtime.lastError) {
          resolve(null);
          return;
        }
        resolve(resp || null);
      });
    } catch (e) {
      resolve(null);
    }
  });
}

/**
 * 转码。
 * @param {Blob} blob
 * @param {'png'|'jpeg'|'webp'|'original'} format
 * @param {number} quality
 * @param {number} [maxWidth] 超过则等比缩小
 */
export async function convertImage(blob, format, quality = 0.92, maxWidth = 0) {
  const fmt = String(format || 'png').toLowerCase();
  if (!blob) return { blob: null, ext: '', mime: '', note: '无字节' };
  if (fmt === 'original') {
    const m = MIME_EXT[blob.type] || 'png';
    return { blob, ext: m, mime: blob.type, note: '保持原格式' };
  }

  const targetMime = formatMime(fmt);
  if (!targetMime) {
    const m = MIME_EXT[blob.type] || 'png';
    return { blob, ext: m, mime: blob.type, note: '保持原格式' };
  }

  // 已经是目标格式且不需要缩放 → 不重复编码（避免有损二次压缩）
  if (blob.type === targetMime && !maxWidth) {
    return { blob, ext: MIME_EXT[targetMime], mime: targetMime, note: '已是目标格式' };
  }

  try {
    const bitmap = await createImageBitmap(blob);
    let { width, height } = bitmap;
    if (maxWidth && width > maxWidth) {
      height = Math.round(height * (maxWidth / width));
      width = maxWidth;
    }

    let outBlob = null;
    if (typeof OffscreenCanvas !== 'undefined') {
      const canvas = new OffscreenCanvas(width, height);
      const ctx = canvas.getContext('2d');
      if (targetMime === 'image/jpeg') {
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, width, height);
      }
      ctx.drawImage(bitmap, 0, 0, width, height);
      outBlob = await canvas.convertToBlob({ type: targetMime, quality });
    } else {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (targetMime === 'image/jpeg') {
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, width, height);
      }
      ctx.drawImage(bitmap, 0, 0, width, height);
      outBlob = await new Promise(res => canvas.toBlob(res, targetMime, quality));
    }
    if (bitmap.close) bitmap.close();
    if (!outBlob) throw new Error('转码得到空结果');
    return {
      blob: outBlob,
      ext: MIME_EXT[targetMime],
      mime: targetMime,
      note: `已转码 ${blob.type || '未知'} → ${targetMime}${width !== bitmap.width ? `（缩放至 ${width}px）` : ''}`
    };
  } catch (e) {
    const m = MIME_EXT[blob.type] || 'png';
    return { blob, ext: m, mime: blob.type, note: `转码失败，保留原格式：${e.message}` };
  }
}

/**
 * 批量把图片资源变成可落盘的数据。
 * @param {object[]} assets
 * @param {object} opts {format, quality, maxWidth, onProgress}
 * @returns {Promise<Map<string, {dataUrl:string, ext:string, note:string, asset:object, failed?:boolean}>>}
 */
export async function prepareImages(assets, opts = {}) {
  const { format = 'png', quality = 0.92, maxWidth = 0, onProgress } = opts;
  const out = new Map();
  const list = assets || [];
  for (let i = 0; i < list.length; i++) {
    const asset = list[i];
    if (onProgress) onProgress(i + 1, list.length);
    const got = await fetchImageBlob(asset);
    if (!got.blob) {
      out.set(asset.id, {
        dataUrl: '',
        ext: format === 'original' ? 'webp' : formatExt(format) || 'png',
        note: got.error || '读取失败',
        asset,
        failed: true,
        rawUrl: asset.src
      });
      continue;
    }
    const conv = await convertImage(got.blob, format, quality, maxWidth);
    let dataUrl = '';
    try {
      dataUrl = await blobToDataUrl(conv.blob);
    } catch (e) {
      out.set(asset.id, { dataUrl: '', ext: conv.ext, note: `转 data URL 失败：${e.message}`, asset, failed: true });
      continue;
    }
    out.set(asset.id, {
      dataUrl,
      ext: conv.ext,
      note: `${got.via}｜${conv.note}`,
      asset,
      failed: false
    });
  }
  return out;
}

/** 估算 data URL 的字节数（用于导出前提示体积） */
export function dataUrlBytes(dataUrl) {
  const i = String(dataUrl).indexOf(',');
  if (i < 0) return 0;
  const body = String(dataUrl).slice(i + 1);
  return Math.floor(body.length * 0.75);
}
