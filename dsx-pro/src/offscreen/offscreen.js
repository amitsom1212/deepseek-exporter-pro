/**
 * Offscreen 文档脚本：把导出文件写进用户授权的真实文件夹
 *
 * @file src/offscreen/offscreen.js
 */

import { loadDirHandle, dirPermission, writeFilesToDirectory, clearDirHandle } from '../core/dirHandle.js';

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.__to !== 'offscreen') return false;

  switch (msg.type) {
    case 'DSX_DIR_STATUS':
      dirStatus().then(sendResponse).catch(e => sendResponse({ ok: false, error: String(e && e.message || e) }));
      return true;

    case 'DSX_WRITE_DIR':
      writeDir(msg).then(sendResponse).catch(e => sendResponse({ ok: false, error: String(e && e.message || e) }));
      return true;

    case 'DSX_DIR_CLEAR':
      clearDirHandle().then(() => sendResponse({ ok: true })).catch(e => sendResponse({ ok: false, error: String(e) }));
      return true;

    default:
      return false;
  }
});

async function dirStatus() {
  const handle = await loadDirHandle();
  if (!handle) return { ok: true, granted: false, name: '', reason: '未授权文件夹' };
  const perm = await dirPermission(handle, 'readwrite');
  return {
    ok: true,
    granted: perm === 'granted',
    name: handle.name || '',
    permission: perm,
    reason: perm === 'granted' ? '' : '权限需要重新确认（请在设置页点一次「重新授权」）'
  };
}

async function writeDir(msg) {
  const handle = await loadDirHandle();
  if (!handle) return { ok: false, error: '尚未授权文件夹', needGrant: true };

  const perm = await dirPermission(handle, 'readwrite');
  if (perm !== 'granted') {
    // offscreen 里没有用户手势，无法 requestPermission
    return { ok: false, error: '文件夹权限已失效，请在设置页重新授权', needGrant: true };
  }

  const files = Array.isArray(msg.files) ? msg.files : [];
  const results = await writeFilesToDirectory(handle, files, msg.subfolder || '');
  const saved = results.filter(r => r.ok).length;
  return { ok: saved > 0, saved, total: files.length, results, dirName: handle.name };
}
