// src/core/dirHandle.js
var DB_NAME = "dsx-pro";
var STORE = "handles";
var KEY = "exportDir";
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
      const req = tx(db, "readonly").get(KEY);
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
    const req = tx(db, "readwrite").delete(KEY);
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
async function writeFilesToDirectory(root, files, subfolder = "") {
  const results = [];
  for (const file of files) {
    const rel = joinRel(subfolder, file.path);
    try {
      const parts = rel.split("/").filter(Boolean);
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
  return [a, b].map((x) => String(x || "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "")).filter(Boolean).join("/");
}
function dataUrlToBlob(dataUrl) {
  const s = String(dataUrl || "");
  const comma = s.indexOf(",");
  if (comma < 0) return new Blob([]);
  const head = s.slice(0, comma);
  const body = s.slice(comma + 1);
  const mime = (head.match(/data:([^;]+)/) || [, "application/octet-stream"])[1];
  if (/;base64/.test(head)) {
    const bin = atob(body);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: mime });
  }
  return new Blob([decodeURIComponent(body)], { type: mime });
}

// src/offscreen/offscreen.js
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.__to !== "offscreen") return false;
  switch (msg.type) {
    case "DSX_DIR_STATUS":
      dirStatus().then(sendResponse).catch((e) => sendResponse({ ok: false, error: String(e && e.message || e) }));
      return true;
    case "DSX_WRITE_DIR":
      writeDir(msg).then(sendResponse).catch((e) => sendResponse({ ok: false, error: String(e && e.message || e) }));
      return true;
    case "DSX_DIR_CLEAR":
      clearDirHandle().then(() => sendResponse({ ok: true })).catch((e) => sendResponse({ ok: false, error: String(e) }));
      return true;
    default:
      return false;
  }
});
async function dirStatus() {
  const handle = await loadDirHandle();
  if (!handle) return { ok: true, granted: false, name: "", reason: "\u672A\u6388\u6743\u6587\u4EF6\u5939" };
  const perm = await dirPermission(handle, "readwrite");
  return {
    ok: true,
    granted: perm === "granted",
    name: handle.name || "",
    permission: perm,
    reason: perm === "granted" ? "" : "\u6743\u9650\u9700\u8981\u91CD\u65B0\u786E\u8BA4\uFF08\u8BF7\u5728\u8BBE\u7F6E\u9875\u70B9\u4E00\u6B21\u300C\u91CD\u65B0\u6388\u6743\u300D\uFF09"
  };
}
async function writeDir(msg) {
  const handle = await loadDirHandle();
  if (!handle) return { ok: false, error: "\u5C1A\u672A\u6388\u6743\u6587\u4EF6\u5939", needGrant: true };
  const perm = await dirPermission(handle, "readwrite");
  if (perm !== "granted") {
    return { ok: false, error: "\u6587\u4EF6\u5939\u6743\u9650\u5DF2\u5931\u6548\uFF0C\u8BF7\u5728\u8BBE\u7F6E\u9875\u91CD\u65B0\u6388\u6743", needGrant: true };
  }
  const files = Array.isArray(msg.files) ? msg.files : [];
  const results = await writeFilesToDirectory(handle, files, msg.subfolder || "");
  const saved = results.filter((r) => r.ok).length;
  return { ok: saved > 0, saved, total: files.length, results, dirName: handle.name };
}
