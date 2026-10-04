// src/popup/popup.js
var statusEl = document.getElementById("status");
var btnPanel = document.getElementById("btn-panel");
var btnBatch = document.getElementById("btn-batch");
var btnOptions = document.getElementById("btn-options");
var tipEl = document.getElementById("tip");
var CONTENT_SCRIPT = "content/index.js";
var tabId = null;
var ready = false;
init();
async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab && tab.id;
  if (!tabId) {
    setStatus("\u627E\u4E0D\u5230\u5F53\u524D\u6807\u7B7E\u9875", "warn");
    disableActions(true);
    return;
  }
  const st = await ensureContentScript();
  applyStatus(st);
}
async function ensureContentScript() {
  let st = await sendToTab({ type: "DSX_GET_STATUS" });
  if (st && st.ok) return st;
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: [CONTENT_SCRIPT] });
  } catch (e) {
    return { ok: false, injectFailed: true, error: String(e && e.message || e) };
  }
  await sleep(250);
  st = await sendToTab({ type: "DSX_GET_STATUS" });
  if (st && st.ok) {
    st.justInjected = true;
    return st;
  }
  return { ok: false, injectFailed: true, error: "\u6CE8\u5165\u540E\u4ECD\u65E0\u6CD5\u901A\u4FE1" };
}
function applyStatus(st) {
  if (st && st.ok) {
    ready = true;
    enableActions(true);
    if (st.adapter) {
      setStatus(`\u5DF2\u5C31\u7EEA \xB7 ${st.site || st.adapter}${st.justInjected ? "\uFF08\u521A\u521A\u63A5\u5165\u672C\u9875\uFF09" : ""}
${st.title || ""}`, "ok");
      tipEl.textContent = "\u5728 DeepSeek \u5BF9\u8BDD\u9875\u6216 DSH \u672C\u5730\u754C\u9762\u4E0A\uFF0C\u8F93\u5165\u6846\u65C1\u8FB9\u4E5F\u4F1A\u51FA\u73B0\u300C\u5BFC\u51FA\u5BF9\u8BDD\u300D\u6309\u94AE\u3002";
    } else {
      setStatus("\u9875\u9762\u5DF2\u8FDE\u63A5\uFF0C\u4F46\u6CA1\u8BC6\u522B\u51FA\u652F\u6301\u7684\u754C\u9762\u3002\n\u8BF7\u6253\u5F00\u4E00\u4E2A\u5177\u4F53\u7684\u5BF9\u8BDD\uFF0C\u6216\u5728\u8BBE\u7F6E\u9875\u70B9\u300C\u8BCA\u65AD\u5F53\u524D\u6807\u7B7E\u9875\u300D\u628A\u62A5\u544A\u53D1\u6211\u3002", "warn");
      tipEl.textContent = "\u63D0\u793A\uFF1ADeepSeek \u7684\u65B0\u4F1A\u8BDD\u9875\u4E5F\u80FD\u8BC6\u522B\uFF0C\u4F46\u9700\u8981\u5148\u6253\u5F00\u4E00\u4E2A\u5DF2\u6709\u5185\u5BB9\u7684\u5BF9\u8BDD\u624D\u80FD\u5BFC\u51FA\u3002";
    }
    return;
  }
  ready = false;
  enableActions(false);
  if (st && st.injectFailed) {
    setStatus(
      "\u65E0\u6CD5\u5728\u8BE5\u9875\u9762\u8FD0\u884C\u3002\n\u53EF\u80FD\u539F\u56E0\uFF1A\u8FD9\u662F\u6D4F\u89C8\u5668\u5185\u7F6E\u9875\u9762\uFF08chrome:// \u7B49\uFF09\u3001\u6269\u5C55\u521A\u5B89\u88C5\u800C\u9875\u9762\u672A\u5237\u65B0\u3001\u6216\u7F3A\u5C11\u8BE5\u7AD9\u70B9\u7684\u8BBF\u95EE\u6743\u9650\u3002\n\u8BF7\u5237\u65B0\u9875\u9762\u540E\u91CD\u8BD5\u3002",
      "warn"
    );
  } else {
    setStatus("\u65E0\u6CD5\u4E0E\u9875\u9762\u901A\u4FE1\uFF0C\u8BF7\u5237\u65B0\u9875\u9762\u540E\u91CD\u8BD5\u3002", "warn");
  }
  tipEl.textContent = `\u5F53\u524D\u5730\u5740\uFF1A${st && st.error ? st.error : "\uFF08\u672A\u53D6\u5F97\uFF09"}`;
}
btnPanel.addEventListener("click", async () => {
  const r = await sendToTab({ type: "DSX_TOGGLE_PANEL" });
  if (!r || !r.ok) {
    setStatus(
      r && r.error === "NOT_SUPPORTED" ? "\u8FD9\u4E2A\u9875\u9762\u6CA1\u8BC6\u522B\u51FA\u652F\u6301\u7684\u754C\u9762\u3002\u8BF7\u6253\u5F00 DeepSeek \u7684\u5BF9\u8BDD\u9875\uFF0C\u6216 DSH \u754C\u9762\u3002" : "\u65E0\u6CD5\u4E0E\u9875\u9762\u901A\u4FE1\uFF0C\u8BF7\u5148\u5237\u65B0\u9875\u9762\u518D\u8BD5\u3002",
      "warn"
    );
    if (r && r.probe) {
      tipEl.textContent = `\u9875\u9762\u63A2\u6D4B\uFF1A${JSON.stringify(r.probe.probes).slice(0, 160)}`;
    }
    return;
  }
  window.close();
});
btnBatch.addEventListener("click", async () => {
  const r = await sendToTab({ type: "DSX_OPEN_PANEL" });
  if (!r || !r.ok) {
    setStatus("\u65E0\u6CD5\u6253\u5F00\u9762\u677F\uFF0C\u8BF7\u5237\u65B0\u9875\u9762\u540E\u91CD\u8BD5\u3002", "warn");
    return;
  }
  window.close();
});
btnOptions.addEventListener("click", () => {
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
  statusEl.className = `status${kind ? " " + kind : ""}`;
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function sendToTab(message) {
  return new Promise((resolve) => {
    try {
      chrome.tabs.sendMessage(tabId, message, (resp) => {
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
