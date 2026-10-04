/**
 * 工具栏弹窗逻辑
 *
 * 关键点：**已打开的标签页不会自动获得内容脚本**。
 * 用户安装/重载扩展时，之前就开着的页面（正是最常见的场景）里没有内容脚本，
 * 于是任何消息都会得到 "Could not establish connection. Receiving end does not exist"。
 * 所以这里先尝试通信，失败就用 chrome.scripting 主动注入一次再重试。
 *
 * @file src/popup/popup.js
 */

const statusEl = document.getElementById('status');
const btnPanel = document.getElementById('btn-panel');
const btnBatch = document.getElementById('btn-batch');
const btnOptions = document.getElementById('btn-options');
const tipEl = document.getElementById('tip');

const CONTENT_SCRIPT = 'content/index.js';

let tabId = null;
let ready = false;

init();

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab && tab.id;

  if (!tabId) {
    setStatus('找不到当前标签页', 'warn');
    disableActions(true);
    return;
  }

  const st = await ensureContentScript();
  applyStatus(st);
}

/** 通信失败时主动注入内容脚本并重试 */
async function ensureContentScript() {
  let st = await sendToTab({ type: 'DSX_GET_STATUS' });
  if (st && st.ok) return st;

  // 收到 null 说明「接收端不存在」——大多数情况是页面在扩展加载前就打开了
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: [CONTENT_SCRIPT] });
  } catch (e) {
    return { ok: false, injectFailed: true, error: String(e && e.message || e) };
  }

  await sleep(250);
  st = await sendToTab({ type: 'DSX_GET_STATUS' });
  if (st && st.ok) {
    st.justInjected = true;
    return st;
  }
  return { ok: false, injectFailed: true, error: '注入后仍无法通信' };
}

function applyStatus(st) {
  if (st && st.ok) {
    ready = true;
    enableActions(true);
    if (st.adapter) {
      setStatus(`已就绪 · ${st.site || st.adapter}${st.justInjected ? '（刚刚接入本页）' : ''}\n${st.title || ''}`, 'ok');
      tipEl.textContent = '在 DeepSeek 对话页或 DSH 本地界面上，输入框旁边也会出现「导出对话」按钮。';
    } else {
      setStatus('页面已连接，但没识别出支持的界面。\n请打开一个具体的对话，或在设置页点「诊断当前标签页」把报告发我。', 'warn');
      tipEl.textContent = '提示：DeepSeek 的新会话页也能识别，但需要先打开一个已有内容的对话才能导出。';
    }
    return;
  }

  ready = false;
  enableActions(false);
  if (st && st.injectFailed) {
    setStatus(
      '无法在该页面运行。\n可能原因：这是浏览器内置页面（chrome:// 等）、扩展刚安装而页面未刷新、或缺少该站点的访问权限。\n'
      + '请刷新页面后重试。',
      'warn'
    );
  } else {
    setStatus('无法与页面通信，请刷新页面后重试。', 'warn');
  }
  tipEl.textContent = `当前地址：${st && st.error ? st.error : '（未取得）'}`;
}

btnPanel.addEventListener('click', async () => {
  const r = await sendToTab({ type: 'DSX_TOGGLE_PANEL' });
  if (!r || !r.ok) {
    setStatus(
      r && r.error === 'NOT_SUPPORTED'
        ? '这个页面没识别出支持的界面。请打开 DeepSeek 的对话页，或 DSH 界面。'
        : '无法与页面通信，请先刷新页面再试。',
      'warn'
    );
    if (r && r.probe) {
      tipEl.textContent = `页面探测：${JSON.stringify(r.probe.probes).slice(0, 160)}`;
    }
    return;
  }
  window.close();
});

btnBatch.addEventListener('click', async () => {
  const r = await sendToTab({ type: 'DSX_OPEN_PANEL' });
  if (!r || !r.ok) {
    setStatus('无法打开面板，请刷新页面后重试。', 'warn');
    return;
  }
  window.close();
});

btnOptions.addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
  window.close();
});

function disableActions(v) {
  btnPanel.disabled = v;
  btnBatch.disabled = v;
}
function enableActions(v) {
  btnPanel.disabled = !v;
  btnBatch.disabled = !v;
}

function setStatus(text, kind) {
  statusEl.textContent = text;
  statusEl.className = `status${kind ? ' ' + kind : ''}`;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/** 给内容脚本发消息，失败返回 null（不抛） */
function sendToTab(message) {
  return new Promise(resolve => {
    try {
      chrome.tabs.sendMessage(tabId, message, resp => {
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
