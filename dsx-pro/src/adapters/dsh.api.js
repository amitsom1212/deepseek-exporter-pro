/**
 * DSH 本地接口客户端
 *
 * 协议（来自 dsh-client-connection 源码）：
 *   POST ${origin}/api/<endpoint>
 *   body: { type:'client-request', rpcId:<uuid>, method:<endpoint>, payload:{...} }
 *   resp: { type:'server-response', rpcId, result:{ ok:true, value } | { ok:false, error } }
 *
 * 认证：启动时 ?token=<launchToken> 会换成 HttpOnly Cookie，
 * 所以同源的 content script 直接 fetch 就会带上凭证，无需自己处理 token。
 *
 * 另有几个「精确 fetch 路由」（非 RPC 信封）：
 *   GET /api/file?path=<绝对路径>
 *   GET /api/session.export?sessionId=<id>&includeDescendants=true  → application/zip
 *
 * @file src/adapters/dsh.api.js
 */

/** 调用一个 RPC 端点 */
export async function dshRpc(endpoint, payload = {}, timeoutMs = 30000) {
  const body = {
    type: 'client-request',
    rpcId: makeUuid(),
    method: endpoint,
    payload
  };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(`${location.origin}/api/${endpoint}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(body),
      signal: ctrl.signal
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const json = await resp.json();
    if (!json || json.type !== 'server-response') throw new Error('响应不是 server-response');
    const result = json.result;
    if (!result) throw new Error('响应缺少 result');
    if (!result.ok) {
      const err = result.error || {};
      throw new Error(`${err.code || 'error'}: ${err.message || '未知错误'}`);
    }
    return result.value;
  } finally {
    clearTimeout(timer);
  }
}

/** 会话列表：{ items: [{ sessionId, updatedAt, running, blank, cwd, parentSessionId }] } */
export async function listSessionsViaApi({ cursor } = {}) {
  const value = await dshRpc('session/list', cursor ? { cursor } : {});
  return value && Array.isArray(value.items) ? value.items : [];
}

/** 会话消息分页（需要 throughSeq，通常配合 follow 使用） */
export async function pageSession(sessionId, { throughSeq, maxMessages } = {}) {
  const payload = { address: { kind: 'session', sessionId } };
  if (throughSeq !== undefined) payload.throughSeq = throughSeq;
  if (maxMessages !== undefined) payload.maxMessages = maxMessages;
  return await dshRpc('session/page', payload);
}

/** 会话搜索 */
export async function searchSessions(query) {
  const value = await dshRpc('session/search', { query });
  return value && Array.isArray(value.items) ? value.items : [];
}

/** 会话导出 ZIP（含 JSONL 与 media/files 原件），返回 Blob */
export async function exportSessionZip(sessionId, { includeDescendants = true } = {}) {
  const url = `${location.origin}/api/session.export?sessionId=${encodeURIComponent(sessionId)}`
    + `&includeDescendants=${includeDescendants ? 'true' : 'false'}`;
  const resp = await fetch(url, { credentials: 'same-origin' });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return await resp.blob();
}

/** 附件字节：{ attachment, data } */
export async function readAttachment(sessionId, attachmentId) {
  return await dshRpc('session/attachment', { sessionId, attachmentId });
}

function makeUuid() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}
