/**
 * File System Access 目录句柄的持久化
 *
 * 句柄（FileSystemDirectoryHandle）可以被结构化克隆，所以能直接存进 IndexedDB，
 * 重启浏览器后依然可用（但权限可能需要一次用户手势重新授予）。
 * 设置页负责「选择目录 + 授权」，offscreen 文档负责「真正写文件」。
 *
 * @file src/core/dirHandle.js
 */

const DB_NAME = 'dsx-pro';
const STORE = 'handles';
const KEY = 'exportDir';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('无法打开 IndexedDB'));
  });
}

function tx(db, mode) {
  return db.transaction(STORE, mode).objectStore(STORE);
}

/** 保存目录句柄 */
export async function saveDirHandle(handle) {
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const req = tx(db, 'readwrite').put(handle, KEY);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
  db.close();
}

/** 读取目录句柄（可能为 null） */
export async function loadDirHandle() {
  try {
    const db = await openDb();
    const handle = await new Promise((resolve, reject) => {
      const req = tx(db, 'readonly').get(KEY);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
    db.close();
    return handle || null;
  } catch (e) {
    return null;
  }
}

/** 清除目录句柄 */
export async function clearDirHandle() {
  const db = await openDb();
  await new Promise(resolve => {
    const req = tx(db, 'readwrite').delete(KEY);
    req.onsuccess = () => resolve();
    req.onerror = () => resolve();
  });
  db.close();
}

/** 查询权限状态：'granted' | 'prompt' | 'denied' */
export async function dirPermission(handle, mode = 'readwrite') {
  if (!handle || !handle.queryPermission) return 'denied';
  try {
    return await handle.queryPermission({ mode });
  } catch (e) {
    return 'denied';
  }
}

/**
 * 申请权限。注意：requestPermission 需要用户手势，
 * 所以只能在设置页（用户点按钮）里调用，offscreen 里调用会直接抛错。
 */
export async function requestDirPermission(handle, mode = 'readwrite') {
  if (!handle || !handle.requestPermission) return 'denied';
  try {
    return await handle.requestPermission({ mode });
  } catch (e) {
    return 'denied';
  }
}

/** 在设置页弹出目录选择器 */
export async function pickDirectory() {
  if (typeof window === 'undefined' || !window.showDirectoryPicker) {
    throw new Error('当前浏览器不支持文件夹授权（需要 Chrome / Edge 86+）');
  }
  const handle = await window.showDirectoryPicker({ mode: 'readwrite', id: 'dsx-export' });
  await saveDirHandle(handle);
  return handle;
}

/**
 * 把一批文件写进目录句柄。
 * @param {FileSystemDirectoryHandle} root
 * @param {Array<{path:string, dataUrl:string}>} files
 * @param {string} [subfolder] 统一加一层子目录
 * @returns {Promise<Array<{path:string, ok:boolean, error?:string}>>}
 */
export async function writeFilesToDirectory(root, files, subfolder = '') {
  const results = [];
  for (const file of files) {
    const rel = joinRel(subfolder, file.path);
    try {
      const parts = rel.split('/').filter(Boolean);
      const filename = parts.pop();
      let dir = root;
      for (const part of parts) {
        dir = await dir.getDirectoryHandle(part, { create: true });
      }
      const fh = await dir.getFileHandle(filename, { create: true });
      const writable = await fh.createWritable();
      await writable.write(dataUrlToBlob(file.dataUrl));
      await writable.close();
      results.push({ path: rel, ok: true });
    } catch (e) {
      results.push({ path: rel, ok: false, error: String(e && e.message || e) });
    }
  }
  return results;
}

function joinRel(a, b) {
  return [a, b]
    .map(x => String(x || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, ''))
    .filter(Boolean)
    .join('/');
}

/** data: URL → Blob */
export function dataUrlToBlob(dataUrl) {
  const s = String(dataUrl || '');
  const comma = s.indexOf(',');
  if (comma < 0) return new Blob([]);
  const head = s.slice(0, comma);
  const body = s.slice(comma + 1);
  const mime = (head.match(/data:([^;]+)/) || [, 'application/octet-stream'])[1];
  if (/;base64/.test(head)) {
    const bin = atob(body);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: mime });
  }
  return new Blob([decodeURIComponent(body)], { type: mime });
}
